import { eq, sql } from "drizzle-orm";
import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";

import type { SuperPluginManifest, SuperPluginTool } from "./super-plugin-manifest.js";

/**
 * Super-plugin runtime store (P2 of the dual plugin runtime).
 *
 * Paperclip's native `plugins` table assumes a JS-worker (`fork`) lifecycle and a
 * Host-Worker call protocol that super plugins (language-agnostic sidecar /
 * external_mcp) do not satisfy — so super plugins must NOT be shoved into it
 * (they would impersonate a worker that does not exist). This SuperClaw-owned
 * table records the runtime facts the dual router/runner needs (kind, transport,
 * entrypoint/command/url, the immutable install dir, the package digest, and the
 * tool surface), keyed by the native plugin id.
 *
 * Following the chat-pins / workshop_provenance precedent: created idempotently on
 * first use (no vendored migration). The unified read catalog (P5) JOINs this with
 * the Paperclip plugins table; execution routes through it (P5 router).
 */
export const superPluginRuntimes = pgTable("super_plugin_runtimes", {
  id: uuid("id").primaryKey().defaultRandom(),
  pluginKey: text("plugin_key").notNull().unique(),
  version: text("version").notNull(),
  runtimeType: text("runtime_type").notNull(),
  transport: text("transport").notNull(),
  entrypoint: text("entrypoint"),
  command: text("command"),
  url: text("url"),
  args: jsonb("args").$type<string[]>().notNull().default([]),
  tools: jsonb("tools").$type<SuperPluginTool[]>().notNull().default([]),
  installDir: text("install_dir").notNull(),
  packageDigest: text("package_digest").notNull(),
  status: text("status").notNull().default("installed"),
  installedAt: timestamp("installed_at", { withTimezone: true }).notNull().defaultNow(),
});

export interface SuperPluginRuntimeRecord {
  pluginKey: string;
  version: string;
  runtimeType: string;
  transport: string;
  entrypoint: string | null;
  command: string | null;
  url: string | null;
  args: string[];
  tools: SuperPluginTool[];
  installDir: string;
  packageDigest: string;
  status: string;
}

/** Postgres SQLSTATE, unwrapping the driver/ORM error envelope (`code` may sit on `cause`). */
function pgErrorCode(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** True when `err` is a `plugin_key` unique-violation (23505) — i.e. the id is already claimed. */
export function isSuperPluginKeyConflict(err: unknown): boolean {
  return pgErrorCode(err) === "23505";
}

const ensuring = new WeakMap<object, Promise<void>>();

function ensureSuperPluginRuntimesTable(db: Db): Promise<void> {
  let pending = ensuring.get(db);
  if (!pending) {
    pending = (async () => {
      try {
        await db.execute(sql`
          CREATE TABLE IF NOT EXISTS super_plugin_runtimes (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            plugin_key text NOT NULL UNIQUE,
            version text NOT NULL,
            runtime_type text NOT NULL,
            transport text NOT NULL,
            entrypoint text,
            command text,
            url text,
            args jsonb NOT NULL DEFAULT '[]'::jsonb,
            tools jsonb NOT NULL DEFAULT '[]'::jsonb,
            install_dir text NOT NULL,
            package_digest text NOT NULL,
            status text NOT NULL DEFAULT 'installed',
            installed_at timestamptz NOT NULL DEFAULT now()
          )
        `);
      } catch (err) {
        // Cross-connection cold-start race: the table exists now — treat as success.
        const code = pgErrorCode(err);
        if (code !== "42P07" && code !== "23505") throw err;
      }
    })().catch((err) => {
      ensuring.delete(db);
      throw err;
    });
    ensuring.set(db, pending);
  }
  return pending;
}

/**
 * Build a runtime record from a (schema-validated) manifest + the landing facts.
 * The native id is the manifest id; digest/installDir come from the verified import.
 */
export function runtimeRecordFromManifest(
  manifest: SuperPluginManifest,
  landing: { installDir: string; packageDigest: string },
): SuperPluginRuntimeRecord {
  const rt = manifest.runtime;
  // Canonicalize to EXACTLY one launch target for the kind. The schema REQUIRES
  // the relevant field per type but does not FORBID the others (additionalProperties
  // allows a defined-but-irrelevant property), so a schema-valid manifest could
  // carry e.g. a stray `command` on a mcp_sidecar. Null the irrelevant targets here
  // so the router/runner can never be handed an ambiguous, multi-target row.
  let entrypoint: string | null = null;
  let command: string | null = null;
  let url: string | null = null;
  if (rt.type === "mcp_sidecar") {
    entrypoint = rt.entrypoint ?? null;
  } else if (rt.type === "external_mcp") {
    if (rt.transport === "stdio") command = rt.command ?? null;
    else url = rt.url ?? null;
  }
  return {
    pluginKey: manifest.id,
    version: manifest.version,
    runtimeType: rt.type,
    transport: rt.transport,
    entrypoint,
    command,
    url,
    args: [...rt.args],
    tools: manifest.tools.map((tool) => ({ ...tool })),
    installDir: landing.installDir,
    packageDigest: landing.packageDigest,
    status: "installed",
  };
}

/** Record (or refresh, on reinstall) a super plugin's runtime row. Upserts on plugin_key. */
export async function recordSuperPluginRuntime(db: Db, record: SuperPluginRuntimeRecord): Promise<void> {
  await ensureSuperPluginRuntimesTable(db);
  await db
    .insert(superPluginRuntimes)
    .values({
      pluginKey: record.pluginKey,
      version: record.version,
      runtimeType: record.runtimeType,
      transport: record.transport,
      entrypoint: record.entrypoint,
      command: record.command,
      url: record.url,
      args: record.args,
      tools: record.tools,
      installDir: record.installDir,
      packageDigest: record.packageDigest,
      status: record.status,
    })
    .onConflictDoUpdate({
      target: superPluginRuntimes.pluginKey,
      set: {
        version: record.version,
        runtimeType: record.runtimeType,
        transport: record.transport,
        entrypoint: record.entrypoint,
        command: record.command,
        url: record.url,
        args: record.args,
        tools: record.tools,
        installDir: record.installDir,
        packageDigest: record.packageDigest,
        status: record.status,
        installedAt: sql`now()`,
      },
    });
}

/**
 * Insert-ONLY claim of a plugin id — NO upsert. On a concurrent same-id install the
 * unique `plugin_key` constraint makes exactly one writer win; the loser's insert
 * throws a 23505 ({@link isSuperPluginKeyConflict}) BEFORE it touches the filesystem.
 * This is the atomic per-key boundary the workshop install relies on (fail-closed,
 * no silent in-place replace). Pass `status: "installing"` and flip with
 * {@link setSuperPluginRuntimeStatus} after the bytes are materialized.
 */
export async function insertSuperPluginRuntime(db: Db, record: SuperPluginRuntimeRecord): Promise<void> {
  await ensureSuperPluginRuntimesTable(db);
  await db.insert(superPluginRuntimes).values({
    pluginKey: record.pluginKey,
    version: record.version,
    runtimeType: record.runtimeType,
    transport: record.transport,
    entrypoint: record.entrypoint,
    command: record.command,
    url: record.url,
    args: record.args,
    tools: record.tools,
    installDir: record.installDir,
    packageDigest: record.packageDigest,
    status: record.status,
  });
}

/** Update a runtime row's status (e.g. flip "installing" → "installed" once bytes land). */
export async function setSuperPluginRuntimeStatus(db: Db, pluginKey: string, status: string): Promise<void> {
  await ensureSuperPluginRuntimesTable(db);
  await db.update(superPluginRuntimes).set({ status }).where(eq(superPluginRuntimes.pluginKey, pluginKey));
}

export async function getSuperPluginRuntime(db: Db, pluginKey: string): Promise<SuperPluginRuntimeRecord | null> {
  await ensureSuperPluginRuntimesTable(db);
  const rows = await db.select().from(superPluginRuntimes).where(eq(superPluginRuntimes.pluginKey, pluginKey)).limit(1);
  const row = rows[0];
  return row ? rowToRecord(row) : null;
}

export async function listSuperPluginRuntimes(db: Db): Promise<SuperPluginRuntimeRecord[]> {
  await ensureSuperPluginRuntimesTable(db);
  const rows = await db.select().from(superPluginRuntimes);
  return rows.map(rowToRecord);
}

export async function deleteSuperPluginRuntime(db: Db, pluginKey: string): Promise<void> {
  await ensureSuperPluginRuntimesTable(db);
  await db.delete(superPluginRuntimes).where(eq(superPluginRuntimes.pluginKey, pluginKey));
}

function rowToRecord(row: typeof superPluginRuntimes.$inferSelect): SuperPluginRuntimeRecord {
  return {
    pluginKey: row.pluginKey,
    version: row.version,
    runtimeType: row.runtimeType,
    transport: row.transport,
    entrypoint: row.entrypoint,
    command: row.command,
    url: row.url,
    args: row.args,
    tools: row.tools,
    installDir: row.installDir,
    packageDigest: row.packageDigest,
    status: row.status,
  };
}
