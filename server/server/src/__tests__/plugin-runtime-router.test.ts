import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";

import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  deriveEffectiveStatus,
  executeTool,
  listUnifiedPlugins,
  PluginRuntimeRouterError,
  type InstallDirProbe,
  type PaperclipPluginSummary,
} from "../services/plugin-runtime-router.js";
import {
  recordSuperPluginRuntime,
  superPluginRuntimes,
  type SuperPluginRuntimeRecord,
} from "../services/super-plugin-runtime-store.js";
import { recordVerifiedWorkshopProvenance, workshopProvenance } from "../services/workshop-provenance.js";
import { computeReceiptMac, verifyReceipt, type WorkshopReceipt } from "../services/workshop-receipt.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const KEY = "router-test-key";
const DIGEST = "sha256:" + "ab".repeat(32);

function superRecord(over: Partial<SuperPluginRuntimeRecord> = {}): SuperPluginRuntimeRecord {
  return {
    pluginKey: "dev.x.tool",
    version: "1.0.0",
    runtimeType: "mcp_sidecar",
    transport: "stdio",
    entrypoint: "bin/run",
    command: null,
    url: null,
    args: ["mcp"],
    tools: [{ name: "do_x", description: "d", inputSchema: {}, outputSchema: {} }],
    installDir: "/s/x",
    packageDigest: DIGEST,
    status: "installed",
    ...over,
  };
}

function verifiedReceipt(pluginKey: string, packageDigest: string, official: boolean) {
  const receipt: WorkshopReceipt = {
    receipt_version: "1",
    receipt_id: "rcpt_1",
    kind: "plugin",
    capability_id: pluginKey,
    version: "1.0.0",
    package_digest: packageDigest,
    transport_sha256: "sha256:" + "cd".repeat(32),
    staged_artifact: "/s/x",
    artifact_ref: "superclaw-object://capabilities/plugin/" + pluginKey,
    app_env: "staging",
    official,
    issued_at: 1000,
    expires_at: 1120,
  };
  const wire = { ...receipt, mac: computeReceiptMac(receipt, KEY) };
  return verifyReceipt(wire, { key: KEY, now: 1050, expectedAppEnv: "staging" });
}

function paperclip(plugins: PaperclipPluginSummary[]) {
  return { listPaperclipPlugins: async () => plugins };
}

function paperclipWithProbe(
  plugins: PaperclipPluginSummary[],
  probeInstallDir: (installDir: string) => Promise<InstallDirProbe>,
) {
  return { listPaperclipPlugins: async () => plugins, probeInstallDir };
}

// Pure status-reconciliation logic — no DB, runs even without embedded postgres.
describe("deriveEffectiveStatus (pure)", () => {
  it("passes the stored status through unchanged when not probed (legacy behaviour)", () => {
    expect(deriveEffectiveStatus("installed", null, false)).toBe("installed");
    expect(deriveEffectiveStatus("installing", null, false)).toBe("installing");
  });

  it("always resolves a cross-store collision to 'conflict' regardless of probe", () => {
    expect(deriveEffectiveStatus("installed", "present", true)).toBe("conflict");
    expect(deriveEffectiveStatus("installing", "absent", true)).toBe("conflict");
    expect(deriveEffectiveStatus("installed", null, true)).toBe("conflict");
  });

  it("surfaces a vanished install dir as 'missing' for installed/ready", () => {
    expect(deriveEffectiveStatus("installed", "absent", false)).toBe("missing");
    expect(deriveEffectiveStatus("ready", "absent", false)).toBe("missing");
  });

  it("keeps installed/ready as-is when the dir is present", () => {
    expect(deriveEffectiveStatus("installed", "present", false)).toBe("installed");
    expect(deriveEffectiveStatus("ready", "present", false)).toBe("ready");
  });

  it("distinguishes a mid-install (present) from an orphaned sentinel (absent)", () => {
    expect(deriveEffectiveStatus("installing", "present", false)).toBe("installing");
    expect(deriveEffectiveStatus("installing", "absent", false)).toBe("install_failed");
  });

  it("reports an unreadable dir as 'inaccessible', never as 'missing'", () => {
    expect(deriveEffectiveStatus("installed", "inaccessible", false)).toBe("inaccessible");
    expect(deriveEffectiveStatus("installing", "inaccessible", false)).toBe("inaccessible");
  });

  it("never masks an unknown / non-asserting stored status with a probe outcome", () => {
    // `status` is an open text column — only installed/ready/installing assert on-disk bytes.
    // error/disabled/paused/future statuses must survive any probe verbatim, never become
    // "missing"/"inaccessible" (that would hide the DB's own signal).
    for (const probe of ["absent", "present", "inaccessible"] as const) {
      expect(deriveEffectiveStatus("error", probe, false)).toBe("error");
      expect(deriveEffectiveStatus("disabled", probe, false)).toBe("disabled");
      expect(deriveEffectiveStatus("paused", probe, false)).toBe("paused");
    }
  });
});

describeEmbeddedPostgres("plugin runtime router + unified catalog", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: Db;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("plugin-router-");
    db = createDb(tempDb.connectionString);
    await recordSuperPluginRuntime(db, superRecord({ pluginKey: "warmup" }));
    await db.delete(superPluginRuntimes);
  }, 30_000);

  afterEach(async () => {
    await db.delete(superPluginRuntimes);
    await db.delete(workshopProvenance);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  describe("listUnifiedPlugins", () => {
    it("merges Paperclip JS + super plugins with the official badge from provenance", async () => {
      await recordSuperPluginRuntime(db, superRecord({ pluginKey: "dev.super.tool" }));
      await recordVerifiedWorkshopProvenance(db, verifiedReceipt("dev.super.tool", DIGEST, true), "dev.super.tool");

      const entries = await listUnifiedPlugins(
        db,
        paperclip([{ pluginKey: "acme.js", name: "Acme", version: "2.0.0", tools: [{ name: "t" }], status: "ready" }]),
      );
      const byKey = new Map(entries.map((e) => [e.pluginKey, e]));
      expect(byKey.get("acme.js")?.kind).toBe("paperclip_js");
      expect(byKey.get("acme.js")?.official).toBe(false); // no provenance → not official
      expect(byKey.get("dev.super.tool")?.kind).toBe("super");
      expect(byKey.get("dev.super.tool")?.runtimeType).toBe("mcp_sidecar");
      expect(byKey.get("dev.super.tool")?.official).toBe(true);
    });

    it("does NOT mark a super plugin official when the digest drifted vs provenance", async () => {
      await recordSuperPluginRuntime(db, superRecord({ pluginKey: "dev.drift", packageDigest: "sha256:" + "ff".repeat(32) }));
      await recordVerifiedWorkshopProvenance(db, verifiedReceipt("dev.drift", DIGEST, true), "dev.drift");
      const entries = await listUnifiedPlugins(db, paperclip([]));
      expect(entries.find((e) => e.pluginKey === "dev.drift")?.official).toBe(false);
    });

    it("marks official=false when provenance says non-official", async () => {
      await recordSuperPluginRuntime(db, superRecord({ pluginKey: "dev.unofficial" }));
      await recordVerifiedWorkshopProvenance(db, verifiedReceipt("dev.unofficial", DIGEST, false), "dev.unofficial");
      const entries = await listUnifiedPlugins(db, paperclip([]));
      expect(entries.find((e) => e.pluginKey === "dev.unofficial")?.official).toBe(false);
    });

    it("flags a key colliding across both stores as conflict + non-official", async () => {
      await recordSuperPluginRuntime(db, superRecord({ pluginKey: "dup.key" }));
      await recordVerifiedWorkshopProvenance(db, verifiedReceipt("dup.key", DIGEST, true), "dup.key");
      const entries = await listUnifiedPlugins(
        db,
        paperclip([{ pluginKey: "dup.key", name: "Dup", version: "1.0.0", tools: [], status: "ready" }]),
      );
      const colliding = entries.filter((e) => e.pluginKey === "dup.key");
      expect(colliding).toHaveLength(2);
      for (const e of colliding) {
        expect(e.official).toBe(false);
        expect(e.status).toBe("conflict");
        expect(e.effectiveStatus).toBe("conflict");
      }
    });

    // ---- effectiveStatus (drift honesty) — ADD-ONLY: status/official must be untouched ----

    it("REGRESSION: with no probe, effectiveStatus mirrors stored status and official is unchanged", async () => {
      await recordSuperPluginRuntime(db, superRecord({ pluginKey: "dev.legacy" }));
      await recordVerifiedWorkshopProvenance(db, verifiedReceipt("dev.legacy", DIGEST, true), "dev.legacy");
      const entries = await listUnifiedPlugins(
        db,
        paperclip([{ pluginKey: "acme.js", name: "Acme", version: "2.0.0", tools: [{ name: "t" }], status: "ready" }]),
      );
      const sup = entries.find((e) => e.pluginKey === "dev.legacy");
      const js = entries.find((e) => e.pluginKey === "acme.js");
      expect(sup?.status).toBe("installed");
      expect(sup?.effectiveStatus).toBe("installed"); // no probe → passthrough
      expect(sup?.official).toBe(true); // official MUST NOT be touched by the drift work
      expect(js?.status).toBe("ready");
      expect(js?.effectiveStatus).toBe("ready");
    });

    it("reports a vanished install dir as effectiveStatus 'missing' while status + official stay intact", async () => {
      await recordSuperPluginRuntime(db, superRecord({ pluginKey: "dev.gone", installDir: "/s/gone" }));
      await recordVerifiedWorkshopProvenance(db, verifiedReceipt("dev.gone", DIGEST, true), "dev.gone");
      const entries = await listUnifiedPlugins(
        db,
        paperclipWithProbe([], async () => "absent"),
      );
      const e = entries.find((x) => x.pluginKey === "dev.gone");
      expect(e?.status).toBe("installed"); // stored status UNCHANGED — the CLI uninstall path still sees it
      expect(e?.official).toBe(true); // official UNCHANGED — drift is reported via effectiveStatus only
      expect(e?.effectiveStatus).toBe("missing");
    });

    it("reports an installing-sentinel with a vanished dir as effectiveStatus 'install_failed'", async () => {
      await recordSuperPluginRuntime(db, superRecord({ pluginKey: "dev.sentinel", status: "installing" }));
      const entries = await listUnifiedPlugins(
        db,
        paperclipWithProbe([], async () => "absent"),
      );
      const e = entries.find((x) => x.pluginKey === "dev.sentinel");
      expect(e?.status).toBe("installing");
      expect(e?.effectiveStatus).toBe("install_failed");
    });

    it("keeps effectiveStatus 'installed' when the probe confirms the dir is present", async () => {
      await recordSuperPluginRuntime(db, superRecord({ pluginKey: "dev.here" }));
      const entries = await listUnifiedPlugins(
        db,
        paperclipWithProbe([], async () => "present"),
      );
      expect(entries.find((x) => x.pluginKey === "dev.here")?.effectiveStatus).toBe("installed");
    });

    it("does NOT 500 the whole catalog when a single probe rejects — it degrades to 'inaccessible'", async () => {
      await recordSuperPluginRuntime(db, superRecord({ pluginKey: "dev.boom" }));
      const entries = await listUnifiedPlugins(
        db,
        paperclipWithProbe([], async () => {
          throw new Error("stat exploded");
        }),
      );
      expect(entries.find((x) => x.pluginKey === "dev.boom")?.effectiveStatus).toBe("inaccessible");
    });
  });

  describe("executeTool", () => {
    const deps = (over = {}) => ({
      callSuperTool: vi.fn(async () => ({ text: "super-ok", structured: null, blockTypes: [], isError: false })),
      dispatchPaperclipTool: vi.fn(async () => ({ paperclip: "ok" })),
      isPaperclipPlugin: vi.fn(async () => false),
      ...over,
    });

    it("routes a super plugin (with matching provenance) to the super runner", async () => {
      await recordSuperPluginRuntime(db, superRecord({ pluginKey: "dev.super.tool" }));
      await recordVerifiedWorkshopProvenance(db, verifiedReceipt("dev.super.tool", DIGEST, true), "dev.super.tool");
      const d = deps();
      const out = await executeTool(db, "dev.super.tool", "do_x", { a: 1 }, d);
      expect(out.kind).toBe("super");
      expect(d.callSuperTool).toHaveBeenCalledTimes(1);
    });

    it("fails closed for a super runtime with NO provenance", async () => {
      await recordSuperPluginRuntime(db, superRecord({ pluginKey: "dev.orphan" }));
      await expect(executeTool(db, "dev.orphan", "do_x", {}, deps())).rejects.toThrow(/no provenance/);
    });

    it("fails closed for a super runtime whose digest drifted vs provenance", async () => {
      await recordSuperPluginRuntime(db, superRecord({ pluginKey: "dev.drift", packageDigest: "sha256:" + "ff".repeat(32) }));
      await recordVerifiedWorkshopProvenance(db, verifiedReceipt("dev.drift", DIGEST, true), "dev.drift");
      await expect(executeTool(db, "dev.drift", "do_x", {}, deps())).rejects.toThrow(/digest drift/);
    });

    it("routes a Paperclip JS plugin to the native dispatcher", async () => {
      const d = deps({ isPaperclipPlugin: vi.fn(async () => true) });
      const out = await executeTool(db, "acme.js", "t", {}, d);
      expect(out.kind).toBe("paperclip_js");
      expect(d.dispatchPaperclipTool).toHaveBeenCalledWith("acme.js", "t", {});
    });

    it("fails closed for an unknown plugin key", async () => {
      await expect(executeTool(db, "nope", "t", {}, deps())).rejects.toThrow(PluginRuntimeRouterError);
    });

    it("fails closed when a key exists in BOTH stores (ambiguous)", async () => {
      await recordSuperPluginRuntime(db, superRecord({ pluginKey: "dup.exec" }));
      await recordVerifiedWorkshopProvenance(db, verifiedReceipt("dup.exec", DIGEST, true), "dup.exec");
      const d = deps({ isPaperclipPlugin: vi.fn(async () => true) });
      await expect(executeTool(db, "dup.exec", "do_x", {}, d)).rejects.toThrow(/both stores/);
      expect(d.callSuperTool).not.toHaveBeenCalled();
    });

    it("fails closed for a tool the super manifest does not declare", async () => {
      await recordSuperPluginRuntime(db, superRecord({ pluginKey: "dev.super.tool" }));
      await recordVerifiedWorkshopProvenance(db, verifiedReceipt("dev.super.tool", DIGEST, true), "dev.super.tool");
      await expect(executeTool(db, "dev.super.tool", "not_a_tool", {}, deps())).rejects.toThrow(/does not declare tool/);
    });

    it("fails closed for a super plugin in a non-executable status", async () => {
      await recordSuperPluginRuntime(db, superRecord({ pluginKey: "dev.broken", status: "error" }));
      await recordVerifiedWorkshopProvenance(db, verifiedReceipt("dev.broken", DIGEST, true), "dev.broken");
      await expect(executeTool(db, "dev.broken", "do_x", {}, deps())).rejects.toThrow(/not executable/);
    });
  });
});
