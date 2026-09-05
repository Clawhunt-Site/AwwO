// PGlite driver arm — desktop dark launch (SUPERCLAW_DESKTOP_PGLITE).
//
// In-process WASM Postgres: no child postmaster, no TCP port, no postmaster.pid —
// the entire orphaned-cluster failure class behind the desktop's recurring 503s
// cannot occur. Keeps the exact same drizzle schema and migration folder as the
// embedded/external arms (feasibility proven empirically: all migrations apply and
// fuzzystrmatch + pg_trgm contrib extensions work — see docs/pglite-feasibility.md).
//
// MIGRATIONS ARE REPLAYED VIA exec() (simple query protocol), NOT drizzle's pglite
// migrator: drizzle's migrator sends each statement-breakpoint chunk as a PREPARED
// statement, and PGlite's extended protocol rejects chunks that contain multiple
// commands ("cannot insert multiple commands into a prepared statement") — several
// real migrations (e.g. 0015_project_color_archived.sql) bundle two ALTERs in one
// chunk. exec() accepts multi-command strings; the full 125-migration replay is
// proven against PGlite this way. Idempotency comes from our own journal table,
// applied per-file inside a transaction (DDL is transactional in Postgres).
import { mkdirSync, writeFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { pruneOldBackups, timestamp, type BackupRetentionPolicy } from "./backup-lib.js";
import * as schema from "./schema/index.js";

const MIGRATIONS_FOLDER = fileURLToPath(new URL("./migrations", import.meta.url));
const PGLITE_JOURNAL_TABLE = "superclaw_pglite_migrations";

export type PgliteDb = ReturnType<typeof drizzlePglite<typeof schema>>;

export type PgliteHandle = {
  db: PgliteDb;
  /** True when this datadir had already applied migrations before this boot
   * (i.e. not a first run). Used only for the startup banner's summary label. */
  hadMigrationHistory: boolean;
  /** Number of migration files applied during THIS boot. */
  appliedMigrations: number;
  /** PGlite's own consistent datadir snapshot (tarball) — the pglite-mode backup
   * primitive (pg_dump needs a real server; this is the supported equivalent). */
  dumpDataDir: (compression?: "auto" | "gzip" | "none") => Promise<Blob | File>;
  close: () => Promise<void>;
};

function splitStatements(content: string): string[] {
  return content
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/** Open (creating if needed) the PGlite database at dataDir, replay any pending
 * migrations, and return the drizzle-wrapped handle. */
export async function openPgliteDb(dataDir: string): Promise<PgliteHandle> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { fuzzystrmatch } = await import("@electric-sql/pglite/contrib/fuzzystrmatch");
  const { pg_trgm } = await import("@electric-sql/pglite/contrib/pg_trgm");
  // The two extensions are the only CREATE EXTENSIONs in the migration set; they
  // must be registered at construction for those statements to succeed.
  const client = new PGlite(dataDir, { extensions: { fuzzystrmatch, pg_trgm } });
  await client.waitReady;

  await client.exec(
    `CREATE TABLE IF NOT EXISTS "${PGLITE_JOURNAL_TABLE}" (
       name text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
  const journal = await client.query<{ name: string }>(`SELECT name FROM "${PGLITE_JOURNAL_TABLE}"`);
  const alreadyApplied = new Set(journal.rows.map((row) => row.name));
  const hadMigrationHistory = alreadyApplied.size > 0;

  // Drizzle migration files are zero-padded (0000_…0124_…), so sorted filename
  // order IS journal order.
  const entries = await readdir(MIGRATIONS_FOLDER);
  const files = entries.filter((name) => name.endsWith(".sql")).sort();
  let appliedMigrations = 0;
  for (const file of files) {
    if (alreadyApplied.has(file)) continue;
    const content = await readFile(join(MIGRATIONS_FOLDER, file), "utf8");
    // Per-file transaction: a failing migration rolls back atomically instead of
    // leaving a half-applied schema.
    await client.transaction(async (tx) => {
      for (const statement of splitStatements(content)) {
        await tx.exec(statement);
      }
      await tx.query(`INSERT INTO "${PGLITE_JOURNAL_TABLE}" (name) VALUES ($1)`, [file]);
    });
    appliedMigrations += 1;
  }

  const db = drizzlePglite(client, { schema });
  return {
    db,
    hadMigrationHistory,
    appliedMigrations,
    dumpDataDir: (compression = "gzip") => client.dumpDataDir(compression),
    close: () => client.close(),
  };
}

export type PgliteBackupResult = {
  backupFile: string;
  sizeBytes: number;
  prunedCount: number;
};

/** pglite-mode database backup: write PGlite's consistent datadir tarball into the
 * backup dir and prune with the SAME tiered GFS retention as the postgres engines.
 * A distinct filename prefix + .tar.gz extension keep the artifact self-describing
 * (restore = extract into a fresh datadir; no psql needed). */
export async function runPgliteDatabaseBackup(opts: {
  handle: Pick<PgliteHandle, "dumpDataDir">;
  backupDir: string;
  retention: BackupRetentionPolicy;
  filenamePrefix?: string;
}): Promise<PgliteBackupResult> {
  const prefix = opts.filenamePrefix ?? "paperclip-pglite";
  mkdirSync(opts.backupDir, { recursive: true });
  const dump = await opts.handle.dumpDataDir("gzip");
  const bytes = Buffer.from(await dump.arrayBuffer());
  const backupFile = resolve(opts.backupDir, `${prefix}-${timestamp()}.tar.gz`);
  writeFileSync(backupFile, bytes);
  const prunedCount = pruneOldBackups(opts.backupDir, opts.retention, prefix);
  return { backupFile, sizeBytes: bytes.length, prunedCount };
}
