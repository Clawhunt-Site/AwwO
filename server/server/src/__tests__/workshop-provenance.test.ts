import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";

import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  deleteWorkshopProvenance,
  getWorkshopProvenance,
  listWorkshopProvenance,
  recordVerifiedWorkshopProvenance,
  workshopProvenance,
} from "../services/workshop-provenance.js";
import {
  computeReceiptMac,
  verifyReceipt,
  type VerifiedWorkshopReceipt,
  type WorkshopReceipt,
} from "../services/workshop-receipt.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const TEST_KEY = "provenance-test-key";

// The store only accepts a branded VerifiedWorkshopReceipt, which can ONLY come
// out of verifyReceipt — so tests must sign a wire and verify it (proving the
// official verdict cannot be fabricated at the store boundary).
function verified(overrides: Partial<WorkshopReceipt> = {}): VerifiedWorkshopReceipt {
  const receipt: WorkshopReceipt = {
    receipt_version: "1",
    receipt_id: "rcpt_one",
    kind: "plugin",
    capability_id: "acme.tool",
    version: "1.2.3",
    package_digest: "sha256:" + "ab".repeat(32),
    transport_sha256: "sha256:" + "cd".repeat(32),
    staged_artifact: "/s/x",
    artifact_ref: "superclaw-object://capabilities/plugin/acme.tool",
    app_env: "staging",
    official: true,
    issued_at: 1000,
    expires_at: 1120,
    ...overrides,
  };
  const wire = { ...receipt, mac: computeReceiptMac(receipt, TEST_KEY) };
  return verifyReceipt(wire, { key: TEST_KEY, now: 1050, expectedAppEnv: "staging" });
}

describeEmbeddedPostgres("workshop provenance store", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: Db;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("workshop-provenance-");
    db = createDb(tempDb.connectionString);
    await recordVerifiedWorkshopProvenance(db, verified(), "warmup"); // creates the table idempotently
  }, 30_000);

  afterEach(async () => {
    await db.delete(workshopProvenance);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("records provenance from a verified receipt and reads it back", async () => {
    await recordVerifiedWorkshopProvenance(db, verified(), "acme.tool");
    const got = await getWorkshopProvenance(db, "plugin", "acme.tool");
    expect(got).not.toBeNull();
    expect(got?.official).toBe(true);
    expect(got?.packageDigest).toBe("sha256:" + "ab".repeat(32));
    expect(got?.receiptId).toBe("rcpt_one");
  });

  it("returns null for a non-workshop (sideloaded) native id", async () => {
    expect(await getWorkshopProvenance(db, "plugin", "not-installed")).toBeNull();
  });

  it("derives official ONLY from the receipt (not a caller flag)", async () => {
    await recordVerifiedWorkshopProvenance(db, verified({ official: false }), "acme.tool");
    expect((await getWorkshopProvenance(db, "plugin", "acme.tool"))?.official).toBe(false);
  });

  it("upserts on reinstall — rebinds digest/version/official to the new artifact", async () => {
    await recordVerifiedWorkshopProvenance(db, verified({ official: true, version: "1.0.0" }), "acme.tool");
    await recordVerifiedWorkshopProvenance(
      db,
      verified({ official: false, version: "2.0.0", package_digest: "sha256:" + "ff".repeat(32), receipt_id: "rcpt_two" }),
      "acme.tool",
    );
    const got = await getWorkshopProvenance(db, "plugin", "acme.tool");
    expect(got?.version).toBe("2.0.0");
    expect(got?.official).toBe(false);
    expect(got?.packageDigest).toBe("sha256:" + "ff".repeat(32));
    expect(got?.receiptId).toBe("rcpt_two");
    expect((await listWorkshopProvenance(db, "plugin")).size).toBe(1); // upsert, not insert
  });

  it("isolates provenance by kind", async () => {
    await recordVerifiedWorkshopProvenance(db, verified({ kind: "plugin" }), "shared-id");
    await recordVerifiedWorkshopProvenance(db, verified({ kind: "skill", official: false }), "shared-id");
    expect((await getWorkshopProvenance(db, "plugin", "shared-id"))?.official).toBe(true);
    expect((await getWorkshopProvenance(db, "skill", "shared-id"))?.official).toBe(false);
  });

  it("lists provenance keyed by native id for list JOINs", async () => {
    await recordVerifiedWorkshopProvenance(db, verified({ official: true }), "a");
    await recordVerifiedWorkshopProvenance(db, verified({ official: false }), "b");
    const map = await listWorkshopProvenance(db, "plugin");
    expect(map.get("a")?.official).toBe(true);
    expect(map.get("b")?.official).toBe(false);
    expect(map.has("nonexistent")).toBe(false);
  });

  it("deletes provenance on uninstall (GC)", async () => {
    await recordVerifiedWorkshopProvenance(db, verified(), "gone");
    await deleteWorkshopProvenance(db, "plugin", "gone");
    expect(await getWorkshopProvenance(db, "plugin", "gone")).toBeNull();
  });

  it("coalesces concurrent first-use table ensure on a fresh Db wrapper", async () => {
    const freshDb = createDb(tempDb!.connectionString); // fresh WeakMap → concurrent first-calls
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        recordVerifiedWorkshopProvenance(freshDb, verified({ receipt_id: `rcpt_${i}` }), `concurrent-${i}`),
      ),
    );
    const map = await listWorkshopProvenance(db, "plugin");
    for (let i = 0; i < 8; i++) expect(map.has(`concurrent-${i}`)).toBe(true);
  });

  it("survives a real cold-create race on an empty catalog (two fresh wrappers)", async () => {
    // Drop the table so the next two writers genuinely race the CREATE — this
    // exercises the 42P07/23505 swallow, not just the same-wrapper coalescing.
    await db.execute(sql`DROP TABLE IF EXISTS workshop_provenance`);
    const a = createDb(tempDb!.connectionString);
    const b = createDb(tempDb!.connectionString);
    await Promise.all([
      recordVerifiedWorkshopProvenance(a, verified({ receipt_id: "race_a" }), "race-a"),
      recordVerifiedWorkshopProvenance(b, verified({ receipt_id: "race_b" }), "race-b"),
    ]);
    expect(await getWorkshopProvenance(db, "plugin", "race-a")).not.toBeNull();
    expect(await getWorkshopProvenance(db, "plugin", "race-b")).not.toBeNull();
  });
});
