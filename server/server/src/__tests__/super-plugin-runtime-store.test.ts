import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";

import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  deleteSuperPluginRuntime,
  getSuperPluginRuntime,
  listSuperPluginRuntimes,
  recordSuperPluginRuntime,
  runtimeRecordFromManifest,
  superPluginRuntimes,
  type SuperPluginRuntimeRecord,
} from "../services/super-plugin-runtime-store.js";
import type { SuperPluginManifest } from "../services/super-plugin-manifest.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function record(overrides: Partial<SuperPluginRuntimeRecord> = {}): SuperPluginRuntimeRecord {
  return {
    pluginKey: "dev.leon.text-stats",
    version: "1.0.0",
    runtimeType: "mcp_sidecar",
    transport: "stdio",
    entrypoint: "bin/text-stats",
    command: null,
    url: null,
    args: ["mcp"],
    tools: [{ name: "text_stats", description: "counts", inputSchema: {}, outputSchema: {} }],
    installDir: "/var/super/dev.leon.text-stats/abc",
    packageDigest: "sha256:" + "ab".repeat(32),
    status: "installed",
    ...overrides,
  };
}

describe("runtimeRecordFromManifest", () => {
  it("projects a manifest + landing facts into a runtime record", () => {
    const manifest: SuperPluginManifest = {
      schemaVersion: "0.1.0",
      id: "dev.x.tool",
      name: "Tool",
      version: "2.0.0",
      runtime: { type: "external_mcp", transport: "stdio", args: ["serve"], command: "npx" },
      tools: [{ name: "t", description: "d", inputSchema: {}, outputSchema: {} }],
      skillOrigin: false,
    };
    const r = runtimeRecordFromManifest(manifest, { installDir: "/s/x", packageDigest: "sha256:" + "cd".repeat(32) });
    expect(r.pluginKey).toBe("dev.x.tool");
    expect(r.runtimeType).toBe("external_mcp");
    expect(r.command).toBe("npx");
    expect(r.entrypoint).toBeNull();
    expect(r.installDir).toBe("/s/x");
    expect(r.tools[0].name).toBe("t");
  });

  it("canonicalizes to ONE launch target — nulls a stray command/url on a mcp_sidecar", () => {
    const manifest: SuperPluginManifest = {
      schemaVersion: "0.1.0",
      id: "dev.x.side",
      name: "Side",
      version: "1.0.0",
      // schema-valid (entrypoint present) but carries irrelevant command + url
      runtime: { type: "mcp_sidecar", transport: "stdio", args: [], entrypoint: "bin/x", command: "npx", url: "http://x" },
      tools: [{ name: "t", description: "d", inputSchema: {}, outputSchema: {} }],
      skillOrigin: false,
    };
    const r = runtimeRecordFromManifest(manifest, { installDir: "/s/x", packageDigest: "sha256:" + "ab".repeat(32) });
    expect(r.entrypoint).toBe("bin/x");
    expect(r.command).toBeNull();
    expect(r.url).toBeNull();
  });

  it("canonicalizes external_mcp+stdio to command only — nulls a stray entrypoint/url", () => {
    const manifest: SuperPluginManifest = {
      schemaVersion: "0.1.0",
      id: "dev.x.mcp",
      name: "Mcp",
      version: "1.0.0",
      runtime: { type: "external_mcp", transport: "stdio", args: [], command: "uvx", entrypoint: "bin/x", url: "http://x" },
      tools: [{ name: "t", description: "d", inputSchema: {}, outputSchema: {} }],
      skillOrigin: false,
    };
    const r = runtimeRecordFromManifest(manifest, { installDir: "/s/x", packageDigest: "sha256:" + "ab".repeat(32) });
    expect(r.command).toBe("uvx");
    expect(r.entrypoint).toBeNull();
    expect(r.url).toBeNull();
  });

  it("canonicalizes external_mcp+sse to url only — nulls a stray entrypoint/command", () => {
    const manifest: SuperPluginManifest = {
      schemaVersion: "0.1.0",
      id: "dev.x.sse",
      name: "Sse",
      version: "1.0.0",
      runtime: { type: "external_mcp", transport: "sse", args: [], url: "https://mcp/sse", entrypoint: "bin/x", command: "npx" },
      tools: [{ name: "t", description: "d", inputSchema: {}, outputSchema: {} }],
      skillOrigin: false,
    };
    const r = runtimeRecordFromManifest(manifest, { installDir: "/s/x", packageDigest: "sha256:" + "ab".repeat(32) });
    expect(r.url).toBe("https://mcp/sse");
    expect(r.entrypoint).toBeNull();
    expect(r.command).toBeNull();
  });
});

describeEmbeddedPostgres("super plugin runtime store", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: Db;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("super-plugin-runtime-");
    db = createDb(tempDb.connectionString);
    await recordSuperPluginRuntime(db, record({ pluginKey: "warmup" })); // creates the table idempotently
  }, 30_000);

  afterEach(async () => {
    await db.delete(superPluginRuntimes);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("records and reads back a mcp_sidecar runtime", async () => {
    await recordSuperPluginRuntime(db, record());
    const got = await getSuperPluginRuntime(db, "dev.leon.text-stats");
    expect(got?.runtimeType).toBe("mcp_sidecar");
    expect(got?.entrypoint).toBe("bin/text-stats");
    expect(got?.args).toEqual(["mcp"]);
    expect(got?.tools[0]?.name).toBe("text_stats");
    expect(got?.installDir).toBe("/var/super/dev.leon.text-stats/abc");
  });

  it("records an external_mcp runtime (command, no entrypoint)", async () => {
    await recordSuperPluginRuntime(
      db,
      record({ pluginKey: "dev.x.mcp", runtimeType: "external_mcp", entrypoint: null, command: "uvx" }),
    );
    const got = await getSuperPluginRuntime(db, "dev.x.mcp");
    expect(got?.command).toBe("uvx");
    expect(got?.entrypoint).toBeNull();
  });

  it("returns null for an unknown plugin key", async () => {
    expect(await getSuperPluginRuntime(db, "nope")).toBeNull();
  });

  it("upserts on reinstall — rebinds version/digest/installDir", async () => {
    await recordSuperPluginRuntime(db, record({ version: "1.0.0" }));
    await recordSuperPluginRuntime(
      db,
      record({ version: "2.0.0", packageDigest: "sha256:" + "ff".repeat(32), installDir: "/var/super/new" }),
    );
    const got = await getSuperPluginRuntime(db, "dev.leon.text-stats");
    expect(got?.version).toBe("2.0.0");
    expect(got?.packageDigest).toBe("sha256:" + "ff".repeat(32));
    expect(got?.installDir).toBe("/var/super/new");
    expect((await listSuperPluginRuntimes(db)).length).toBe(1); // upsert, not insert
  });

  it("lists and deletes (uninstall/GC)", async () => {
    await recordSuperPluginRuntime(db, record({ pluginKey: "a" }));
    await recordSuperPluginRuntime(db, record({ pluginKey: "b" }));
    expect((await listSuperPluginRuntimes(db)).map((r) => r.pluginKey).sort()).toEqual(["a", "b"]);
    await deleteSuperPluginRuntime(db, "a");
    expect(await getSuperPluginRuntime(db, "a")).toBeNull();
    expect(await getSuperPluginRuntime(db, "b")).not.toBeNull();
  });

  it("survives a real cold-create race on an empty catalog (two fresh wrappers)", async () => {
    await db.execute(sql`DROP TABLE IF EXISTS super_plugin_runtimes`);
    const a = createDb(tempDb!.connectionString);
    const b = createDb(tempDb!.connectionString);
    await Promise.all([
      recordSuperPluginRuntime(a, record({ pluginKey: "race-a" })),
      recordSuperPluginRuntime(b, record({ pluginKey: "race-b" })),
    ]);
    expect(await getSuperPluginRuntime(db, "race-a")).not.toBeNull();
    expect(await getSuperPluginRuntime(db, "race-b")).not.toBeNull();
  });
});
