import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";

import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { superWorkshopRoutes, isLoopbackRequest } from "../routes/super-workshop.js";
import type { Request } from "express";
import { errorHandler } from "../middleware/index.js";
import {
  insertSuperPluginRuntime,
  superPluginRuntimes,
  type SuperPluginRuntimeRecord,
} from "../services/super-plugin-runtime-store.js";
import {
  getWorkshopProvenance,
  recordVerifiedWorkshopProvenance,
  workshopProvenance,
} from "../services/workshop-provenance.js";
import { computeReceiptMac, verifyReceipt, type WorkshopReceipt } from "../services/workshop-receipt.js";
import { computeStoredSkillDigest, resolveSkillStoreDir, writeSkillProvenance } from "../services/super-skill-fs.js";
import { listGlobalRuntimeSkillEntries } from "../services/global-runtime-skills.js";
import { companyService } from "../services/companies.js";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import nodePath from "node:path";

/** Minimal STORED-method ZIP (UTF-8 names) — for a real `.scplug` posted to the import route. */
function buildZip(entries: Array<{ name: string; content: string }>): Buffer {
  const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n >>> 0, 0); return b; };
  const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; };
  const crc32 = (buf: Buffer) => { let c = ~0; for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return (~c) >>> 0; };
  const locals: Buffer[] = []; const centrals: Buffer[] = []; let off = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8"); const data = Buffer.from(e.content, "utf8"); const crc = crc32(data); const F = 0x0800;
    const local = Buffer.concat([u32(0x04034b50), u16(20), u16(F), u16(0), u16(0), u16(0), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), name, data]);
    const central = Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(F), u16(0), u16(0), u16(0), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32((0o100644 << 16) >>> 0), u32(off), name]);
    locals.push(local); centrals.push(central); off += local.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(cd.length), u32(off), u16(0)]);
  return Buffer.concat([...locals, cd, eocd]);
}

const support = await getEmbeddedPostgresTestSupport();
const describeEmbedded = support.supported ? describe : describe.skip;

// 64-hex: the route reads the key from a 0600 file whose content must match KEY_RE.
const HMAC_KEY = "a1b2c3d4".repeat(8);
const DIGEST = "sha256:" + "ab".repeat(32);

function superRow(over: Partial<SuperPluginRuntimeRecord> = {}): SuperPluginRuntimeRecord {
  return {
    pluginKey: "dev.acme.tool",
    version: "1.0.0",
    runtimeType: "mcp_sidecar",
    transport: "stdio",
    entrypoint: "bin/run",
    command: null,
    url: null,
    args: [],
    tools: [{ name: "do_x", description: "d", inputSchema: {}, outputSchema: {} }],
    installDir: "/installed/dev.acme.tool",
    packageDigest: DIGEST,
    status: "installed",
    ...over,
  };
}

function verifiedReceipt(pluginKey: string, kind: "plugin" | "skill" | "company" = "plugin") {
  const receipt: WorkshopReceipt = {
    receipt_version: "1",
    receipt_id: "rcpt_1",
    kind,
    capability_id: pluginKey,
    version: "1.0.0",
    package_digest: DIGEST,
    transport_sha256: "sha256:" + "cd".repeat(32),
    staged_artifact: "/s/x.scplug",
    artifact_ref: "superclaw-object://capabilities/" + kind + "/" + pluginKey,
    app_env: "staging",
    official: true,
    issued_at: 1000,
    expires_at: 1120,
  };
  const wire = { ...receipt, mac: computeReceiptMac(receipt, HMAC_KEY) };
  return verifyReceipt(wire, { key: HMAC_KEY, now: 1050, expectedAppEnv: "staging" });
}

describeEmbedded("super-workshop routes", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: Db;
  let skillWork: string;
  const savedEnv: Record<string, string | undefined> = {};

  /** Plant a kernel-admissible skill in the store; returns its recomputed store digest. */
  async function plantSkill(slug: string): Promise<string> {
    const dir = resolveSkillStoreDir(slug);
    await mkdir(dir, { recursive: true });
    await writeFile(nodePath.join(dir, "SKILL.md"), `---\nname: ${slug}\n---\nbody\n`);
    const storeDigest = await computeStoredSkillDigest(dir);
    await writeSkillProvenance(dir, { store_digest: storeDigest });
    return storeDigest;
  }

  function app(actor: Record<string, unknown> = { type: "board", isInstanceAdmin: true }) {
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = { userId: "u", companyIds: [], source: "local_implicit", ...actor };
      next();
    });
    a.use("/api", superWorkshopRoutes(db));
    a.use(errorHandler);
    return a;
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("super-workshop-routes-");
    db = createDb(tempDb.connectionString);
    await insertSuperPluginRuntime(db, superRow({ pluginKey: "warmup" }));
    await recordVerifiedWorkshopProvenance(db, verifiedReceipt("warmup"), "warmup");
    await db.delete(superPluginRuntimes);
    await db.delete(workshopProvenance);
    savedEnv.KEY_FILE = process.env.SUPERCLAW_WORKSHOP_RECEIPT_KEY_FILE;
    savedEnv.APP_ENV = process.env.SUPERCLAW_APP_ENV;
    savedEnv.SKILL_STORE = process.env.SUPERCLAW_SKILL_STORE_DIR;
    savedEnv.PLUGIN_ROOT = process.env.SUPERCLAW_SUPER_PLUGIN_ROOT;
    skillWork = await mkdtemp(nodePath.join(os.tmpdir(), "super-workshop-routes-skill-"));
    process.env.SUPERCLAW_SKILL_STORE_DIR = nodePath.join(skillWork, "skills");
    process.env.SUPERCLAW_SUPER_PLUGIN_ROOT = nodePath.join(skillWork, "plugins");
    // The route reads the receipt key from a 0600 file (never process.env); write it + set the path.
    const keyFile = nodePath.join(skillWork, "workshop_hmac.key");
    await writeFile(keyFile, HMAC_KEY);
    await chmod(keyFile, 0o600);
    process.env.SUPERCLAW_WORKSHOP_RECEIPT_KEY_FILE = keyFile;
  }, 30_000);

  afterEach(async () => {
    await db.delete(superPluginRuntimes);
    await db.delete(workshopProvenance);
    process.env.SUPERCLAW_APP_ENV = "staging";
    await rm(process.env.SUPERCLAW_SKILL_STORE_DIR!, { recursive: true, force: true });
    await rm(process.env.SUPERCLAW_SUPER_PLUGIN_ROOT!, { recursive: true, force: true });
  });

  afterAll(async () => {
    if (savedEnv.KEY_FILE === undefined) delete process.env.SUPERCLAW_WORKSHOP_RECEIPT_KEY_FILE;
    else process.env.SUPERCLAW_WORKSHOP_RECEIPT_KEY_FILE = savedEnv.KEY_FILE;
    process.env.SUPERCLAW_APP_ENV = savedEnv.APP_ENV;
    process.env.SUPERCLAW_SKILL_STORE_DIR = savedEnv.SKILL_STORE;
    process.env.SUPERCLAW_SUPER_PLUGIN_ROOT = savedEnv.PLUGIN_ROOT;
    await rm(skillWork, { recursive: true, force: true });
    await tempDb?.cleanup();
  });

  /** A canonical super-plugin manifest (passes the AJV schema) for a real plugin .scplug. */
  function pluginManifest(id: string): string {
    return JSON.stringify({
      schema_version: "1.0.0",
      id,
      name: "S6 Tool",
      version: "1.0.0",
      summary: "S6 combined-import fixture.",
      source: { type: "developer_upload", clawhunt_problem_id: null, developer_id: "leon" },
      runtime: {
        type: "mcp_sidecar",
        entrypoint: "bin/run",
        args: ["mcp"],
        transport: "stdio",
        mcp_protocol_versions: ["2025-06-18"],
        platforms: ["darwin-arm64", "linux-x64"],
      },
      tools: [{ name: "do_x", description: "Do x.", input_schema: { type: "object" }, output_schema: { type: "object" } }],
      permissions: { filesystem: [], network: [], environment: [] },
      acceptance: { level: "L1", tests: ["tests/smoke.sh"], evidence_fixtures: ["evidence-fixtures/smoke.json"], latency_budget_ms: 1000 },
      commerce: { pricing_model: "free", metering: "none" },
      provenance: { build_type: "developer_upload", source_digest: null, package_digest: "sha256:" + "00".repeat(32), signature: "ed25519:fixture" },
    });
  }

  /** Stage a real `.scplug`, sign a current-timestamp receipt, POST it through the route. */
  async function importViaRoute(kind: "plugin" | "skill" | "company", id: string, bytes: Buffer): Promise<number> {
    const staged = nodePath.join(skillWork, `${kind}-${id}.scplug`);
    await writeFile(staged, bytes);
    const receipt: WorkshopReceipt = {
      receipt_version: "1",
      receipt_id: `rcpt_${kind}_${id}`,
      kind,
      capability_id: id,
      version: "1.0.0",
      package_digest: DIGEST,
      transport_sha256: "sha256:" + createHash("sha256").update(bytes).digest("hex"),
      staged_artifact: staged,
      artifact_ref: `superclaw-object://capabilities/${kind}/${id}`,
      app_env: "staging",
      official: true,
      issued_at: Math.floor(Date.now() / 1000),
      expires_at: Math.floor(Date.now() / 1000) + 60,
    };
    const wire = { ...receipt, mac: computeReceiptMac(receipt, HMAC_KEY) };
    const res = await request(app()).post("/api/internal/workshop-import").send(wire);
    return res.status;
  }

  describe("POST /api/internal/workshop-import", () => {
    it("503 when SUPERCLAW_APP_ENV is not configured (fail-closed, no env name leaked)", async () => {
      delete process.env.SUPERCLAW_APP_ENV;
      const res = await request(app()).post("/api/internal/workshop-import").send({ anything: true });
      expect(res.status).toBe(503);
      expect(res.body.error).not.toMatch(/SUPERCLAW|APP_ENV/);
    });

    it("503 when the receipt key file is not configured (no env name leaked)", async () => {
      const saved = process.env.SUPERCLAW_WORKSHOP_RECEIPT_KEY_FILE;
      delete process.env.SUPERCLAW_WORKSHOP_RECEIPT_KEY_FILE;
      try {
        const res = await request(app()).post("/api/internal/workshop-import").send({ any: true });
        expect(res.status).toBe(503);
        expect(res.body.error).not.toMatch(/HMAC|SUPERCLAW/);
      } finally {
        if (saved === undefined) delete process.env.SUPERCLAW_WORKSHOP_RECEIPT_KEY_FILE;
        else process.env.SUPERCLAW_WORKSHOP_RECEIPT_KEY_FILE = saved;
      }
    });

    it("400 on an invalid/forged receipt, with a generic reason (no internal leak)", async () => {
      const res = await request(app()).post("/api/internal/workshop-import").send({ not: "a valid receipt" });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("workshop import rejected");
    });

    it("400 (not 500) on a malformed receipt field (bad package_digest) — client-correctable", async () => {
      const receipt = {
        receipt_version: "1",
        receipt_id: "rcpt_baddigest",
        kind: "plugin",
        capability_id: "dev.bad",
        version: "1.0.0",
        package_digest: "not-a-sha256", // malformed → WorkshopReceiptError
        transport_sha256: "sha256:" + "cd".repeat(32),
        staged_artifact: "/s/x.scplug",
        artifact_ref: "superclaw-object://capabilities/plugin/dev.bad",
        app_env: "staging",
        official: true,
        issued_at: Math.floor(Date.now() / 1000),
        expires_at: Math.floor(Date.now() / 1000) + 60,
      };
      const wire = { ...receipt, mac: computeReceiptMac(receipt as never, HMAC_KEY) };
      const res = await request(app()).post("/api/internal/workshop-import").send(wire);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("workshop import rejected");
    });

    it("imports a real skill .scplug end-to-end THROUGH the Express route (buildImportDeps wiring)", async () => {
      const slug = "route-skill";
      const bytes = buildZip([{ name: "SKILL.md", content: "---\nname: RouteSkill\n---\nuse me\n" }]);
      const staged = nodePath.join(skillWork, `${slug}.scplug`);
      await writeFile(staged, bytes);
      const receipt: WorkshopReceipt = {
        receipt_version: "1",
        receipt_id: "rcpt_route_skill",
        kind: "skill",
        capability_id: slug,
        version: "1.0.0",
        package_digest: DIGEST,
        transport_sha256: "sha256:" + createHash("sha256").update(bytes).digest("hex"),
        staged_artifact: staged,
        artifact_ref: "superclaw-object://capabilities/skill/" + slug,
        app_env: "staging",
        official: true,
        issued_at: Math.floor(Date.now() / 1000),
        expires_at: Math.floor(Date.now() / 1000) + 60,
      };
      const wire = { ...receipt, mac: computeReceiptMac(receipt, HMAC_KEY) };
      const res = await request(app()).post("/api/internal/workshop-import").send(wire);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ kind: "skill", nativeId: slug, official: true });
      // It really landed + the kernel admits it + the official badge shows (digest-bound).
      expect((await listGlobalRuntimeSkillEntries()).map((e) => e.runtimeName)).toContain(slug);
      const dir = resolveSkillStoreDir(slug);
      expect((await getWorkshopProvenance(db, "skill", slug))?.storeDigest).toBe(await computeStoredSkillDigest(dir));
      const catalog = await request(app()).get("/api/super-skills");
      expect(catalog.body.find((e: { slug: string }) => e.slug === slug)?.official).toBe(true);
    }, 30_000);

    // A real `.scplug` posted to the route, classified as a 400 PACKAGE rejection.
    async function postPluginArchive(slug: string, bytes: Buffer): Promise<{ status: number; error: string }> {
      const staged = nodePath.join(skillWork, `${slug}.scplug`);
      await writeFile(staged, bytes);
      const receipt: WorkshopReceipt = {
        receipt_version: "1",
        receipt_id: "rcpt_" + slug,
        kind: "plugin",
        capability_id: slug,
        version: "1.0.0",
        package_digest: DIGEST,
        transport_sha256: "sha256:" + createHash("sha256").update(bytes).digest("hex"),
        staged_artifact: staged,
        artifact_ref: "superclaw-object://capabilities/plugin/" + slug,
        app_env: "staging",
        official: true,
        issued_at: Math.floor(Date.now() / 1000),
        expires_at: Math.floor(Date.now() / 1000) + 60,
      };
      const wire = { ...receipt, mac: computeReceiptMac(receipt, HMAC_KEY) };
      const res = await request(app()).post("/api/internal/workshop-import").send(wire);
      return { status: res.status, error: res.body.error };
    }

    it("400 on a schema-INVALID superclaw-plugin.json (SuperPluginInstallError, not 500)", async () => {
      const bytes = buildZip([{ name: "superclaw-plugin.json", content: '{"id":"dev.bad"}' }]); // missing required fields
      const res = await postPluginArchive("dev.badmanifest", bytes);
      expect(res.status).toBe(400);
      expect(res.error).toBe("workshop import rejected");
    });

    it("400 on a CORRUPT (non-JSON) superclaw-plugin.json (ScplugExtractionError, not 500)", async () => {
      const bytes = buildZip([{ name: "superclaw-plugin.json", content: "{ not json" }]);
      const res = await postPluginArchive("dev.corruptmanifest", bytes);
      expect(res.status).toBe(400);
    });

    it("400 on a MALFORMED archive (not a zip) — ScplugExtractionError, not 500", async () => {
      const res = await postPluginArchive("dev.notazip", Buffer.from("this is not a zip file at all"));
      expect(res.status).toBe(400);
    });

    it("500 (not a misleading 400) for a generic failure — a valid receipt whose staged archive is missing", async () => {
      // Structurally valid + correct HMAC, so verifyReceipt passes; the unpack then hits
      // a generic fs ENOENT (no rejection-class/phrase match) → server error, not a 400.
      const receipt: WorkshopReceipt = {
        receipt_version: "1",
        receipt_id: "rcpt_missing",
        kind: "plugin",
        capability_id: "dev.missing",
        version: "1.0.0",
        package_digest: DIGEST,
        transport_sha256: "sha256:" + "cd".repeat(32),
        staged_artifact: "/nonexistent/never-staged.scplug",
        artifact_ref: "superclaw-object://capabilities/plugin/dev.missing",
        app_env: "staging",
        official: true,
        // Current wall-clock (the route verifies with wall-clock now) so it does not 400 on "expired".
        issued_at: Math.floor(Date.now() / 1000),
        expires_at: Math.floor(Date.now() / 1000) + 60,
      };
      const wire = { ...receipt, mac: computeReceiptMac(receipt, HMAC_KEY) };
      const res = await request(app()).post("/api/internal/workshop-import").send(wire);
      expect(res.status).toBe(500);
      expect(res.body.error).toBe("workshop import failed");
    });
  });

  describe("isLoopbackRequest", () => {
    const fake = (remoteAddress: string | undefined) => ({ socket: { remoteAddress } }) as unknown as Request;
    it("treats only 127.0.0.1 / ::1 as loopback; empty/unknown is fail-closed", () => {
      expect(isLoopbackRequest(fake("127.0.0.1"))).toBe(true);
      expect(isLoopbackRequest(fake("::1"))).toBe(true);
      expect(isLoopbackRequest(fake("::ffff:127.0.0.1"))).toBe(true);
      expect(isLoopbackRequest(fake(""))).toBe(false); // fail-closed, never loopback
      expect(isLoopbackRequest(fake(undefined))).toBe(false);
      expect(isLoopbackRequest(fake("10.0.0.5"))).toBe(false);
    });
  });

  describe("GET /api/super-plugins", () => {
    it("403 for an unauthenticated actor", async () => {
      const res = await request(app({ type: "none" })).get("/api/super-plugins");
      expect(res.status).toBe(403);
    });

    it("403 for an agent key (board-operator only)", async () => {
      const res = await request(app({ type: "agent" })).get("/api/super-plugins");
      expect(res.status).toBe(403);
    });

    it("returns the unified catalog with the official badge from provenance", async () => {
      await insertSuperPluginRuntime(db, superRow({ pluginKey: "dev.acme.tool" }));
      await recordVerifiedWorkshopProvenance(db, verifiedReceipt("dev.acme.tool"), "dev.acme.tool");
      const res = await request(app()).get("/api/super-plugins");
      expect(res.status).toBe(200);
      const entry = (
        res.body as Array<{ pluginKey: string; kind: string; official: boolean; status: string; effectiveStatus: string }>
      ).find((e) => e.pluginKey === "dev.acme.tool");
      expect(entry?.kind).toBe("super");
      expect(entry?.official).toBe(true);
      // Real fs.stat over the (non-existent) "/installed/dev.acme.tool" → absent → "missing",
      // WITHOUT mutating status/official (additive drift signal).
      expect(entry?.status).toBe("installed");
      expect(entry?.effectiveStatus).toBe("missing");
    });

    it("derives effectiveStatus from a REAL fs.stat: present dir → installed, vanished dir → missing", async () => {
      // present: installDir points at a directory that genuinely exists (cwd is always there)
      await insertSuperPluginRuntime(db, superRow({ pluginKey: "dev.here.tool", installDir: process.cwd() }));
      // absent: default superRow installDir "/installed/dev.acme.tool" does not exist
      await insertSuperPluginRuntime(db, superRow({ pluginKey: "dev.gone.tool" }));
      const res = await request(app()).get("/api/super-plugins");
      expect(res.status).toBe(200);
      const byKey = new Map(
        (res.body as Array<{ pluginKey: string; effectiveStatus: string }>).map((e) => [e.pluginKey, e]),
      );
      expect(byKey.get("dev.here.tool")?.effectiveStatus).toBe("installed");
      expect(byKey.get("dev.gone.tool")?.effectiveStatus).toBe("missing");
    });
  });

  describe("POST /api/super-plugins/:key/tools/:tool", () => {
    it("400 (fail-closed) for a super plugin with no provenance — never spawns, generic reason", async () => {
      await insertSuperPluginRuntime(db, superRow({ pluginKey: "dev.orphan" }));
      const res = await request(app()).post("/api/super-plugins/dev.orphan/tools/do_x").send({});
      expect(res.status).toBe(400);
      // Generic — never reveals "no provenance" / install internals to a prober.
      expect(res.body.error).toBe("tool cannot be executed");
    });

    it("400 for an unknown plugin key (generic)", async () => {
      const res = await request(app()).post("/api/super-plugins/nope/tools/do_x").send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("tool cannot be executed");
    });

    it("403 for an agent key (instance-admin only)", async () => {
      await insertSuperPluginRuntime(db, superRow({ pluginKey: "dev.orphan" }));
      const res = await request(app({ type: "agent" })).post("/api/super-plugins/dev.orphan/tools/do_x").send({});
      expect(res.status).toBe(403);
    });

    it("403 for a non-admin board user (execution is instance-admin only)", async () => {
      await insertSuperPluginRuntime(db, superRow({ pluginKey: "dev.orphan" }));
      const res = await request(app({ type: "board", isInstanceAdmin: false, source: "authenticated" }))
        .post("/api/super-plugins/dev.orphan/tools/do_x")
        .send({});
      expect(res.status).toBe(403);
    });
  });

  describe("DELETE /api/super-plugins/:key", () => {
    it("uninstalls a super plugin and clears its provenance (admin)", async () => {
      await insertSuperPluginRuntime(db, superRow({ pluginKey: "dev.acme.tool" }));
      await recordVerifiedWorkshopProvenance(db, verifiedReceipt("dev.acme.tool"), "dev.acme.tool");
      const res = await request(app()).delete("/api/super-plugins/dev.acme.tool");
      expect(res.status).toBe(200);
      expect(res.body.uninstalled).toBe("dev.acme.tool");
      expect(await getWorkshopProvenance(db, "plugin", "dev.acme.tool")).toBeNull();
    });

    it("404 for an unknown key but still clears any stale provenance", async () => {
      await recordVerifiedWorkshopProvenance(db, verifiedReceipt("ghost"), "ghost");
      const res = await request(app()).delete("/api/super-plugins/ghost");
      expect(res.status).toBe(404);
      expect(await getWorkshopProvenance(db, "plugin", "ghost")).toBeNull();
    });

    it("403 for a non-admin actor", async () => {
      // A non-loopback authenticated actor that is NOT an instance admin (the
      // local_implicit source is auto-admin, so override it).
      const res = await request(
        app({ type: "board", isInstanceAdmin: false, source: "authenticated" }),
      ).delete("/api/super-plugins/dev.acme.tool");
      expect(res.status).toBe(403);
    });
  });

  describe("GET /api/super-skills", () => {
    it("403 for an agent key (board-operator only)", async () => {
      expect((await request(app({ type: "agent" })).get("/api/super-skills")).status).toBe(403);
    });

    it("official=true only when the LIVE store digest matches the provenance row's stored digest", async () => {
      const storeDigest = await plantSkill("good-skill");
      await recordVerifiedWorkshopProvenance(db, verifiedReceipt("good-skill", "skill"), "good-skill", storeDigest);
      const res = await request(app()).get("/api/super-skills");
      expect(res.status).toBe(200);
      expect(res.body.find((e: { slug: string }) => e.slug === "good-skill")?.official).toBe(true);
    });

    it("official=false on digest DRIFT — a forged .provenance.json cannot inherit the badge", async () => {
      await plantSkill("drift-skill"); // the live store digest is X...
      // ...but the provenance row was recorded against a DIFFERENT (stale/forged) digest.
      await recordVerifiedWorkshopProvenance(
        db,
        verifiedReceipt("drift-skill", "skill"),
        "drift-skill",
        "sha256:" + "11".repeat(32),
      );
      const res = await request(app()).get("/api/super-skills");
      const entry = res.body.find((e: { slug: string }) => e.slug === "drift-skill");
      expect(entry).toBeTruthy();
      expect(entry.official).toBe(false); // live recompute ≠ recorded digest → no badge
    });
  });

  describe("DELETE /api/super-skills/:slug", () => {
    it("uninstalls an installed skill (atomic quarantine) + clears provenance", async () => {
      await plantSkill("kill-me");
      await recordVerifiedWorkshopProvenance(db, verifiedReceipt("kill-me", "skill"), "kill-me");
      const res = await request(app()).delete("/api/super-skills/kill-me");
      expect(res.status).toBe(200);
      await expect(stat(resolveSkillStoreDir("kill-me"))).rejects.toThrow();
      expect(await getWorkshopProvenance(db, "skill", "kill-me")).toBeNull();
    });

    it("404 for a not-installed slug (still clears any stale provenance)", async () => {
      await recordVerifiedWorkshopProvenance(db, verifiedReceipt("phantom", "skill"), "phantom");
      const res = await request(app()).delete("/api/super-skills/phantom");
      expect(res.status).toBe(404);
      expect(await getWorkshopProvenance(db, "skill", "phantom")).toBeNull();
    });

    it("403 for a non-admin board actor (instance-admin only)", async () => {
      const res = await request(app({ type: "board", isInstanceAdmin: false, source: "authenticated" })).delete(
        "/api/super-skills/kill-me",
      );
      expect(res.status).toBe(403);
    });
  });

  describe("GET /api/super-companies + company import", () => {
    it("403 for an agent key (board-operator only)", async () => {
      expect((await request(app({ type: "agent" })).get("/api/super-companies")).status).toBe(403);
    });

    it("lists companies with the official badge from provenance (by companyId)", async () => {
      // A real company (created via the company service) + an official provenance row.
      const company = await companyService(db).create({ name: "Workshop Co" });
      await recordVerifiedWorkshopProvenance(db, verifiedReceipt(company.id, "company"), company.id);
      const res = await request(app()).get("/api/super-companies");
      expect(res.status).toBe(200);
      const entry = res.body.find((e: { companyId: string }) => e.companyId === company.id);
      expect(entry?.official).toBe(true);
      // A company WITHOUT provenance is non-official.
      const local = await companyService(db).create({ name: "Local Co" });
      const res2 = await request(app()).get("/api/super-companies");
      expect(res2.body.find((e: { companyId: string }) => e.companyId === local.id)?.official).toBe(false);
    });

    it("imports a real company .scplug end-to-end THROUGH the route → 200 + a real company", async () => {
      const slug = "route-company";
      const companyMd = ['---', 'schema: "agentcompanies/v1"', 'name: "Route Imported Co"', "---", ""].join("\n");
      const bytes = buildZip([{ name: "COMPANY.md", content: companyMd }]);
      const staged = nodePath.join(skillWork, `${slug}.scplug`);
      await writeFile(staged, bytes);
      const receipt: WorkshopReceipt = {
        receipt_version: "1",
        receipt_id: "rcpt_co_ok",
        kind: "company",
        capability_id: slug,
        version: "1.0.0",
        package_digest: DIGEST,
        transport_sha256: "sha256:" + createHash("sha256").update(bytes).digest("hex"),
        staged_artifact: staged,
        artifact_ref: "superclaw-object://capabilities/company/" + slug,
        app_env: "staging",
        official: true,
        issued_at: Math.floor(Date.now() / 1000),
        expires_at: Math.floor(Date.now() / 1000) + 60,
      };
      const wire = { ...receipt, mac: computeReceiptMac(receipt, HMAC_KEY) };
      const res = await request(app()).post("/api/internal/workshop-import").send(wire);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ kind: "company", official: true });
      const companyId = res.body.nativeId as string;
      expect(companyId).toBeTruthy();
      // A REAL company was materialized + shows official in the catalog.
      expect((await companyService(db).list()).some((c: { id: string }) => c.id === companyId)).toBe(true);
      const catalog = await request(app()).get("/api/super-companies");
      expect(catalog.body.find((e: { companyId: string }) => e.companyId === companyId)?.official).toBe(true);
    }, 30_000);

    it("400 (not 500) when a company .scplug has no valid bundle (import rejected)", async () => {
      // A valid receipt + a real archive that unpacks, but it is NOT a company bundle
      // (no portability manifest) → importBundle throws → SuperCompanyInstallError → 400.
      const slug = "bad-company";
      const bytes = buildZip([{ name: "readme.txt", content: "not a company bundle" }]);
      const staged = nodePath.join(skillWork, `${slug}.scplug`);
      await writeFile(staged, bytes);
      const receipt: WorkshopReceipt = {
        receipt_version: "1",
        receipt_id: "rcpt_badco",
        kind: "company",
        capability_id: slug,
        version: "1.0.0",
        package_digest: DIGEST,
        transport_sha256: "sha256:" + createHash("sha256").update(bytes).digest("hex"),
        staged_artifact: staged,
        artifact_ref: "superclaw-object://capabilities/company/" + slug,
        app_env: "staging",
        official: true,
        issued_at: Math.floor(Date.now() / 1000),
        expires_at: Math.floor(Date.now() / 1000) + 60,
      };
      const wire = { ...receipt, mac: computeReceiptMac(receipt, HMAC_KEY) };
      const res = await request(app()).post("/api/internal/workshop-import").send(wire);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("workshop import rejected");
    }, 30_000);
  });

  describe("S6 — all three kinds end-to-end through the real route, coexisting", () => {
    it("imports a plugin, a skill, AND a company in one session; each lands in its own catalog as official", async () => {
      const pluginId = "dev.s6.tool";
      const skillSlug = "s6-skill";
      const companySlug = "s6-company";

      // Real .scplug per kind, imported through the SAME Express route + buildImportDeps.
      const pluginStatus = await importViaRoute(
        "plugin",
        pluginId,
        buildZip([
          { name: "superclaw-plugin.json", content: pluginManifest(pluginId) },
          { name: "bin/run", content: "#!/bin/sh\necho mcp\n" },
        ]),
      );
      const skillStatus = await importViaRoute(
        "skill",
        skillSlug,
        buildZip([{ name: "SKILL.md", content: "---\nname: S6 Skill\n---\nuse me\n" }]),
      );
      const companyStatus = await importViaRoute(
        "company",
        companySlug,
        buildZip([
          { name: "COMPANY.md", content: ['---', 'schema: "agentcompanies/v1"', 'name: "S6 Co"', "---", ""].join("\n") },
        ]),
      );
      expect([pluginStatus, skillStatus, companyStatus]).toEqual([200, 200, 200]);

      // Each kind is in ITS OWN catalog, official, with NO cross-interference.
      const plugins = (await request(app()).get("/api/super-plugins")).body as Array<{ pluginKey: string; official: boolean }>;
      const skills = (await request(app()).get("/api/super-skills")).body as Array<{ slug: string; official: boolean }>;
      const companies = (await request(app()).get("/api/super-companies")).body as Array<{ official: boolean }>;

      expect(plugins.find((p) => p.pluginKey === pluginId)?.official).toBe(true);
      expect(skills.find((s) => s.slug === skillSlug)?.official).toBe(true);
      expect(companies.some((c) => c.official)).toBe(true);
      // The plugin catalog has no skill/company entries (separate stores, no bleed).
      expect(plugins.some((p) => p.pluginKey === skillSlug || p.pluginKey === companySlug)).toBe(false);
      expect(skills.some((s) => s.slug === pluginId)).toBe(false);
    }, 60_000);
  });
});
