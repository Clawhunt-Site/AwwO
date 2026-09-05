import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";

import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  clearPluginProvenanceOnUninstall,
  createSuperPluginInstaller,
  SuperPluginInstallError,
  uninstallSuperPlugin,
  type SuperPluginInstallerDeps,
} from "../services/super-plugin-installer.js";
import { getSuperPluginRuntime, recordSuperPluginRuntime } from "../services/super-plugin-runtime-store.js";
import {
  getWorkshopProvenance,
  recordVerifiedWorkshopProvenance,
  workshopProvenance,
} from "../services/workshop-provenance.js";
import { superPluginRuntimes } from "../services/super-plugin-runtime-store.js";
import { computeReceiptMac, verifyReceipt, type WorkshopReceipt } from "../services/workshop-receipt.js";
import type { WorkshopInstallContext, WorkshopInstaller } from "../services/workshop-import.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const KEY = "installer-test-key";
const DIGEST = "sha256:" + "ab".repeat(32);

function verifiedReceipt(over: Partial<WorkshopReceipt> = {}) {
  const receipt: WorkshopReceipt = {
    receipt_version: "1",
    receipt_id: "rcpt_1",
    kind: "plugin",
    capability_id: "dev.acme.tool",
    version: "1.0.0",
    package_digest: DIGEST,
    transport_sha256: "sha256:" + "cd".repeat(32),
    staged_artifact: "/s/x.zip",
    artifact_ref: "superclaw-object://capabilities/plugin/dev.acme.tool",
    app_env: "staging",
    official: true,
    issued_at: 1000,
    expires_at: 1120,
    ...over,
  };
  const wire = { ...receipt, mac: computeReceiptMac(receipt, KEY) };
  return verifyReceipt(wire, { key: KEY, now: 1050, expectedAppEnv: "staging" });
}

function superManifest(over: Record<string, unknown> = {}) {
  return structuredClone({
    schema_version: "1.0.0",
    id: "dev.acme.tool",
    name: "Acme Tool",
    version: "1.0.0",
    summary: "Acme test tool.",
    source: { type: "developer_upload", clawhunt_problem_id: null, developer_id: "leon" },
    runtime: {
      type: "mcp_sidecar",
      entrypoint: "bin/run",
      args: ["mcp"],
      transport: "stdio",
      mcp_protocol_versions: ["2025-06-18"],
      platforms: ["darwin-arm64", "linux-x64"],
    },
    tools: [
      {
        name: "do_x",
        description: "Do the x thing.",
        input_schema: { type: "object", properties: {}, additionalProperties: false },
        output_schema: { type: "object", properties: {}, additionalProperties: false },
      },
    ],
    permissions: { filesystem: [], network: [], environment: [] },
    acceptance: { level: "L1", tests: ["tests/smoke.sh"], evidence_fixtures: ["evidence-fixtures/smoke.json"], latency_budget_ms: 1000 },
    commerce: { pricing_model: "free", metering: "none" },
    provenance: {
      build_type: "developer_upload",
      source_digest: null,
      package_digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      signature: "ed25519:fixture-signature",
    },
    ...over,
  });
}

function ctx(receipt = verifiedReceipt()): WorkshopInstallContext {
  return { receipt, unpackedDir: "/unpack/x" };
}


describeEmbeddedPostgres("super-plugin-installer", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: Db;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("super-installer-");
    db = createDb(tempDb.connectionString);
    await recordSuperPluginRuntime(db, {
      pluginKey: "warmup",
      version: "1",
      runtimeType: "mcp_sidecar",
      transport: "stdio",
      entrypoint: "x",
      command: null,
      url: null,
      args: [],
      tools: [],
      installDir: "/x",
      packageDigest: DIGEST,
      status: "installed",
    });
    await db.delete(superPluginRuntimes);
    // Warm up the lazily-created provenance table so afterEach can truncate it.
    await recordVerifiedWorkshopProvenance(db, verifiedReceipt({ capability_id: "warmup" }), "warmup");
    await db.delete(workshopProvenance);
  }, 30_000);

  afterEach(async () => {
    await db.delete(superPluginRuntimes);
    await db.delete(workshopProvenance);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function deps(over: Partial<SuperPluginInstallerDeps> = {}): SuperPluginInstallerDeps {
    return {
      db,
      readSuperManifestJson: vi.fn(async () => superManifest()),
      resolveInstallDir: (key) => `/installed/${key}`,
      materializeInstall: vi.fn(async () => {}),
      removeInstallDir: vi.fn(async () => {}),
      installPaperclipJsPlugin: vi.fn(async () => ({ nativeId: "js.plugin", rollback: async () => {} })),
      ...over,
    };
  }

  it("installs a super plugin: materializes, records the runtime under the receipt id", async () => {
    const d = deps();
    const installer = createSuperPluginInstaller(d);
    const out = await installer(ctx());
    expect(out.nativeId).toBe("dev.acme.tool");
    expect(d.materializeInstall).toHaveBeenCalledWith("/unpack/x", "/installed/dev.acme.tool");
    const row = await getSuperPluginRuntime(db, "dev.acme.tool");
    expect(row?.runtimeType).toBe("mcp_sidecar");
    expect(row?.packageDigest).toBe(DIGEST);
    expect(row?.installDir).toBe("/installed/dev.acme.tool");
    expect(row?.status).toBe("installed"); // flipped from "installing" after materialize
  });

  it("delegates to the Paperclip JS installer when there is no super manifest (id matches receipt)", async () => {
    const installPaperclipJsPlugin: WorkshopInstaller = vi.fn(async () => ({
      nativeId: "dev.acme.tool",
      rollback: async () => {},
    }));
    const installer = createSuperPluginInstaller(deps({ readSuperManifestJson: async () => null, installPaperclipJsPlugin }));
    const out = await installer(ctx());
    expect(out.nativeId).toBe("dev.acme.tool");
    expect(installPaperclipJsPlugin).toHaveBeenCalledTimes(1);
    expect(await getSuperPluginRuntime(db, "dev.acme.tool")).toBeNull();
  });

  it("RED LINE: refuses a skill. capability even on the JS path (no super manifest)", async () => {
    const installPaperclipJsPlugin = vi.fn(async () => ({ nativeId: "skill.foo", rollback: async () => {} }));
    const installer = createSuperPluginInstaller(
      deps({ readSuperManifestJson: async () => null, installPaperclipJsPlugin }),
    );
    await expect(installer(ctx(verifiedReceipt({ capability_id: "skill.foo" })))).rejects.toThrow(/skill capability/);
    // The red line trips BEFORE delegation — the JS installer is never even invoked.
    expect(installPaperclipJsPlugin).not.toHaveBeenCalled();
  });

  it("BINDING: rolls back + rejects when the JS installer lands under a different id", async () => {
    const rollback = vi.fn(async () => {});
    const installPaperclipJsPlugin = vi.fn(async () => ({ nativeId: "dev.evil.swap", rollback }));
    const installer = createSuperPluginInstaller(
      deps({ readSuperManifestJson: async () => null, installPaperclipJsPlugin }),
    );
    await expect(installer(ctx())).rejects.toThrow(/does not match the verified/);
    expect(rollback).toHaveBeenCalledTimes(1);
  });

  it("RED LINE: refuses to install a skill-origin manifest as a plugin", async () => {
    const installer = createSuperPluginInstaller(deps({ readSuperManifestJson: async () => superManifest({ skill_origin: true }) }));
    await expect(installer(ctx())).rejects.toThrow(/skill-origin/);
    expect(await getSuperPluginRuntime(db, "dev.acme.tool")).toBeNull();
  });

  it("RED LINE: refuses a reserved skill. capability id (caught before delegation)", async () => {
    const installer = createSuperPluginInstaller(
      deps({ readSuperManifestJson: async () => superManifest({ id: "skill.thing", skill_origin: false }) }),
    );
    await expect(installer(ctx(verifiedReceipt({ capability_id: "skill.thing" })))).rejects.toThrow(/skill capability/);
  });

  it("BINDING: refuses a manifest whose id differs from the verified receipt capability", async () => {
    const installer = createSuperPluginInstaller(
      deps({ readSuperManifestJson: async () => superManifest({ id: "dev.evil.swap" }) }),
    );
    await expect(installer(ctx())).rejects.toThrow(SuperPluginInstallError);
    expect(await getSuperPluginRuntime(db, "dev.acme.tool")).toBeNull();
    expect(await getSuperPluginRuntime(db, "dev.evil.swap")).toBeNull();
  });

  it("rolls back the claim row + dir when materialize fails after claiming the id", async () => {
    // The atomic claim (insert "installing") succeeds, then materialize throws — the
    // installer must delete the claim row AND remove any dir so nothing lingers.
    const removeInstallDir = vi.fn(async () => {});
    const materializeInstall = vi.fn(async () => {
      throw new Error("materialize boom");
    });
    const installer = createSuperPluginInstaller(deps({ removeInstallDir, materializeInstall }));
    await expect(installer(ctx())).rejects.toThrow(/materialize boom/);
    expect(removeInstallDir).toHaveBeenCalledWith("/installed/dev.acme.tool");
    expect(await getSuperPluginRuntime(db, "dev.acme.tool")).toBeNull(); // claim row rolled back
  });

  it("on cleanup failure RETAINS the claim row (key held) so a racing reinstall fails closed", async () => {
    const removeInstallDir = vi.fn(async () => {
      throw new Error("rm boom");
    });
    const materializeInstall = vi.fn(async () => {
      throw new Error("materialize boom");
    });
    const installer = createSuperPluginInstaller(deps({ removeInstallDir, materializeInstall }));
    await expect(installer(ctx())).rejects.toThrow(AggregateError);
    expect(removeInstallDir).toHaveBeenCalledTimes(1);
    // DIR-BEFORE-ROW: the dir removal failed, so the claim row is NOT deleted — it is
    // kept as an "installing" sentinel holding the unique id (never release the key
    // over un-cleaned bytes).
    expect((await getSuperPluginRuntime(db, "dev.acme.tool"))?.status).toBe("installing");
    // A racing/subsequent same-id install therefore fails closed (cannot stomp the dir).
    const racing = createSuperPluginInstaller(deps());
    await expect(racing(ctx())).rejects.toThrow(/already installed/);
  });

  it("NO REINSTALL: fail-closed when the id is already claimed (unique constraint), no fs touch", async () => {
    await recordSuperPluginRuntime(db, {
      pluginKey: "dev.acme.tool",
      version: "0.9.0",
      runtimeType: "mcp_sidecar",
      transport: "stdio",
      entrypoint: "bin/old",
      command: null,
      url: null,
      args: [],
      tools: [],
      installDir: "/installed/dev.acme.tool",
      packageDigest: DIGEST,
      status: "installed",
    });
    const materializeInstall = vi.fn(async () => {});
    const installer = createSuperPluginInstaller(deps({ materializeInstall }));
    await expect(installer(ctx())).rejects.toThrow(/already installed/);
    // The pre-existing install must be untouched: never rm-then-replaced.
    expect(materializeInstall).not.toHaveBeenCalled();
    expect((await getSuperPluginRuntime(db, "dev.acme.tool"))?.version).toBe("0.9.0");
  });

  it("concurrent same-id installs: exactly one wins, the other fails closed (atomic claim)", async () => {
    const installer = createSuperPluginInstaller(deps());
    const results = await Promise.allSettled([installer(ctx()), installer(ctx())]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason.message).toMatch(/already installed/);
    // The winner completed: a single installed row, never silently replaced.
    expect((await getSuperPluginRuntime(db, "dev.acme.tool"))?.status).toBe("installed");
  });

  it("installer rollback removes the runtime row and the install dir", async () => {
    const removeInstallDir = vi.fn(async () => {});
    const installer = createSuperPluginInstaller(deps({ removeInstallDir }));
    const out = await installer(ctx());
    expect(await getSuperPluginRuntime(db, "dev.acme.tool")).not.toBeNull();
    await out.rollback();
    expect(await getSuperPluginRuntime(db, "dev.acme.tool")).toBeNull();
    expect(removeInstallDir).toHaveBeenCalledWith("/installed/dev.acme.tool");
  });

  it("importer-returned rollback keeps the row when dir removal fails (dir-before-row)", async () => {
    const removeInstallDir = vi.fn(async () => {
      throw new Error("rm boom");
    });
    const installer = createSuperPluginInstaller(deps({ removeInstallDir }));
    const out = await installer(ctx()); // happy install (success path never calls removeInstallDir)
    expect((await getSuperPluginRuntime(db, "dev.acme.tool"))?.status).toBe("installed");
    await expect(out.rollback()).rejects.toThrow(/rm boom/);
    // dir removal failed → the row (key) is retained, never released over un-cleaned bytes.
    expect(await getSuperPluginRuntime(db, "dev.acme.tool")).not.toBeNull();
  });

  describe("uninstall clears provenance", () => {
    it("uninstallSuperPlugin drops the row, removes the dir, and clears provenance", async () => {
      await recordSuperPluginRuntime(db, {
        pluginKey: "dev.acme.tool",
        version: "1.0.0",
        runtimeType: "mcp_sidecar",
        transport: "stdio",
        entrypoint: "bin/run",
        command: null,
        url: null,
        args: [],
        tools: [],
        installDir: "/installed/dev.acme.tool",
        packageDigest: DIGEST,
        status: "installed",
      });
      await recordVerifiedWorkshopProvenance(db, verifiedReceipt(), "dev.acme.tool");
      expect(await getWorkshopProvenance(db, "plugin", "dev.acme.tool")).not.toBeNull();

      const removeInstallDir = vi.fn(async () => {});
      await uninstallSuperPlugin({ db, removeInstallDir }, { pluginKey: "dev.acme.tool", installDir: "/installed/dev.acme.tool" });

      expect(await getSuperPluginRuntime(db, "dev.acme.tool")).toBeNull();
      expect(removeInstallDir).toHaveBeenCalledWith("/installed/dev.acme.tool");
      expect(await getWorkshopProvenance(db, "plugin", "dev.acme.tool")).toBeNull();
    });

    it("on dir-removal failure clears provenance but RETAINS the row (key held → reinstall fails closed)", async () => {
      await recordSuperPluginRuntime(db, {
        pluginKey: "dev.acme.tool",
        version: "1.0.0",
        runtimeType: "mcp_sidecar",
        transport: "stdio",
        entrypoint: "bin/run",
        command: null,
        url: null,
        args: [],
        tools: [],
        installDir: "/installed/dev.acme.tool",
        packageDigest: DIGEST,
        status: "installed",
      });
      await recordVerifiedWorkshopProvenance(db, verifiedReceipt(), "dev.acme.tool");
      const removeInstallDir = vi.fn(async () => {
        throw new Error("rm boom");
      });
      await expect(
        uninstallSuperPlugin({ db, removeInstallDir }, { pluginKey: "dev.acme.tool", installDir: "/installed/dev.acme.tool" }),
      ).rejects.toThrow(/rm boom/);
      // Provenance (the trust-critical residue) is cleared FIRST → no stale official.
      expect(await getWorkshopProvenance(db, "plugin", "dev.acme.tool")).toBeNull();
      // But the row is RETAINED (dir not gone → key still held), so a reinstall cannot
      // re-claim the id and be stomped by a later cleanup.
      expect(await getSuperPluginRuntime(db, "dev.acme.tool")).not.toBeNull();
      const racing = createSuperPluginInstaller(deps());
      await expect(racing(ctx())).rejects.toThrow(/already installed/);
    });

    it("on row-delete failure (after provenance+dir gone) leaves no orphan-official", async () => {
      await recordSuperPluginRuntime(db, {
        pluginKey: "dev.acme.tool",
        version: "1.0.0",
        runtimeType: "mcp_sidecar",
        transport: "stdio",
        entrypoint: "bin/run",
        command: null,
        url: null,
        args: [],
        tools: [],
        installDir: "/installed/dev.acme.tool",
        packageDigest: DIGEST,
        status: "installed",
      });
      await recordVerifiedWorkshopProvenance(db, verifiedReceipt(), "dev.acme.tool");
      // A db whose runtime-row delete fails, but provenance delete + ensure all work.
      const dbRowDeleteFails = new Proxy(db, {
        get(target, prop, receiver) {
          if (prop === "delete") {
            return (table: unknown) => {
              if (table === superPluginRuntimes) {
                return {
                  where: () => {
                    throw new Error("row delete boom");
                  },
                };
              }
              return (target as Db).delete(table as never);
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as Db;
      const removeInstallDir = vi.fn(async () => {});
      await expect(
        uninstallSuperPlugin(
          { db: dbRowDeleteFails, removeInstallDir },
          { pluginKey: "dev.acme.tool", installDir: "/installed/dev.acme.tool" },
        ),
      ).rejects.toThrow(/row delete boom/);
      // Provenance is already gone (no orphan-official). The runtime row lingers but is
      // non-executable: executeTool fail-closes on the absent provenance.
      expect(await getWorkshopProvenance(db, "plugin", "dev.acme.tool")).toBeNull();
      expect(removeInstallDir).toHaveBeenCalledTimes(1);
      expect(await getSuperPluginRuntime(db, "dev.acme.tool")).not.toBeNull();
    });

    it("clearPluginProvenanceOnUninstall removes a JS plugin's stale official provenance", async () => {
      await recordVerifiedWorkshopProvenance(db, verifiedReceipt({ capability_id: "acme.js" }), "acme.js");
      expect(await getWorkshopProvenance(db, "plugin", "acme.js")).not.toBeNull();
      await clearPluginProvenanceOnUninstall(db, "acme.js");
      expect(await getWorkshopProvenance(db, "plugin", "acme.js")).toBeNull();
    });
  });
});
