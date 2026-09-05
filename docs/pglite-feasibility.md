# PGlite Swap Feasibility — ClawHunt Desktop Profile

> Goal: replace the desktop's **embedded PostgreSQL** (a real `postgres.exe` child
> cluster — the root of the orphaned-postmaster → datadir-collision → recurring-503
> bug class, mitigated by the v0.1.6 reaper) with **PGlite** (in-process WASM
> Postgres: no child process, no port, nothing to orphan), keeping the existing
> drizzle schema and all migrations.
>
> Assessed 2026-07-02 on `feat/compact-and-pglite`. Verdict below is backed by an
> **empirical smoke run**, not reading tea leaves.

## 1. Verdict

**FEASIBLE — IMPLEMENTED and now PROMOTED to the default for fresh desktop installs.**
- `SUPERCLAW_DESKTOP_PGLITE=1` switches the server's DB seam to in-process PGlite.
- **Auto-default (v0.1.9):** `node_runtime.py build_env` sets the flag to `1` when the
  operator hasn't chosen AND the instance has no legacy `db/PG_VERSION` cluster — so a
  **fresh install runs on PGlite out of the box**, an existing embedded-PG install keeps
  its data (reaper still guards it), and an explicit `0`/`1` always wins. Fail-open.
- **Backups work in pglite mode:** the scheduled/manual backup runner dumps PGlite's
  consistent datadir tarball (`runPgliteDatabaseBackup` → `client.dumpDataDir("gzip")`)
  into the backup dir as `paperclip-pglite-<ts>.tar.gz`, pruned by the SAME tiered GFS
  retention as the postgres engines. Restore = extract into a fresh datadir (no psql).

### End-to-end proof of the PROMOTION (deployed bundle, 2026-07-03)

Booted the deployed backend `.exe` against a fresh instance home with **NO env var set**
and a 1-minute backup interval:
- Banner shows `Mode pglite` / `(in-process)` — i.e. `build_env` auto-selected it; **zero
  `postgres.exe` spawned**.
- At the 1-minute mark the scheduled backup wrote `paperclip-pglite-…​.tar.gz` (4.2 MB,
  `prunedCount:0`, retention `{daily:7, weekly:4, monthly:1}`) in ~0.9s.
This is on top of the earlier dark-launch E2E (boot ~3s, hard-kill zero residue, reboot
idempotent + data persisted).

### End-to-end proof (deployed node-runtime bundle, 2026-07-02)

Booted the REAL deployed artifact (`node-runtime/server/dist/index.js` via the
bundled node.exe) with the flag set, against a fresh instance home:

- **Boot 1**: `/api/health` 200 in **~3s** (embedded PG: 40-150s cold); banner shows
  `Mode pglite` / `(in-process)`; all migrations applied; a real DB-backed API
  (`/api/workspaces`) returns the seeded workspace. **Zero `postgres.exe` spawned.**
- **HARD KILL** (`taskkill /F`, no `/T` — the exact scenario that used to orphan a
  postmaster): listener gone, **nothing left behind** — no orphan process of any kind,
  nothing holding the datadir.
- **Boot 2**: 200 in ~4s, `Migrations: already applied` (idempotent journal), and the
  boot-1 workspace **persisted**.

The recurring-503 failure class (orphaned postmaster → datadir collision →
ECONNRESET) **cannot occur** in this mode.

### Implementation-found incompatibility (important)

drizzle's official `drizzle-orm/pglite` **migrator** fails on this schema: it sends
each statement-breakpoint chunk as a PREPARED statement, and PGlite's extended
protocol rejects multi-command chunks (`cannot insert multiple commands into a
prepared statement` — e.g. `0015_project_color_archived.sql` bundles two ALTERs in
one chunk). The driver arm therefore replays migrations via **`exec()`** (simple
query protocol, multi-command safe — the same method the 125/125 smoke used), with a
per-file transaction + its own idempotency journal table
(`superclaw_pglite_migrations`). See `server/packages/db/src/pglite.ts`.

## 2. Empirical proof (run 2026-07-02, PGlite 0.5.4)

All **125 real migrations** from `server/packages/db/dist/migrations/` were applied
to a fresh PGlite instance (script: [pglite-migration-smoke.mjs](pglite-migration-smoke.mjs)):

```
migrations found: 125
applied cleanly: 125/125
probe OK: fuzzystrmatch levenshtein -> {"v":1}
probe OK: pg_trgm similarity        -> {"v":true}
probe OK: gen_random_uuid           -> {"v":true}
probe OK: table count               -> {"v":111}
probe OK: LISTEN/NOTIFY             -> "ping"
```

The only two `CREATE EXTENSION`s in the schema (`fuzzystrmatch`, `pg_trgm`) ship as
PGlite contrib modules and **work**. `gen_random_uuid`, triggers, indexes, and
LISTEN/NOTIFY all pass. 111 tables materialize.

## 3. Why the dependency cost is near zero

- The server's only SQL driver is **postgres.js wrapped by drizzle-orm/postgres-js**
  (`server/packages/db/src/client.ts:48-51`, `Db = ReturnType<typeof createDb>`).
- The installed **`drizzle-orm@0.45.2` already ships `drizzle-orm/pglite`**, and
  **`@electric-sql/pglite@0.3.15` is already resolved in `server/pnpm-lock.yaml`** —
  no new top-level dependency class.
- The embedded-vs-external decision is a single seam: `server/src/index.ts:326`
  (`if (config.databaseUrl)` → external; else the embedded block at 335-499). A
  PGlite driver is a third arm of that seam.

## 4. Caveats (the honest list) + workarounds

| # | Caveat | Impact | Workaround |
|---|---|---|---|
| 1 | **Cross-process TCP clients**: CLI commands (`cli/src/commands/db-backup.ts`, `auth-bootstrap-ceo.ts`) and the JS backup engine open their own postgres.js TCP connections to `127.0.0.1:54329`. PGlite is **in-process, single-connection** — there is no port to connect to. | CLI db tools break in PGlite mode | Desktop profile: route these through the server's HTTP admin routes (backup already has `POST /instance/database-backups`), or keep them embedded-PG-only. |
| 2 | **Backup engines**: preferred `pg_dump`/`psql` child processes (`packages/db/src/backup-lib.ts:319,350`) need a real server; the pure-JS fallback engine exists but streams `COPY ... TO STDOUT` via postgres.js `.readable()` (`backup-lib.ts:900-916`). | scheduled 60m backups | Force `backupEngine='javascript'` under PGlite and port its COPY streaming to PGlite's query API (PGlite supports COPY TO/FROM via memory blobs), or snapshot the datadir directory (single-dir file copy — PGlite data is just files, no live postmaster to fight). |
| 3 | **Existing installs' data**: current datadirs are real-PG-18 clusters; PGlite cannot open them. | migration path | One-time import at first PGlite boot: run the existing JS dump against the old cluster (started once via embedded-postgres), replay into PGlite, rename old datadir `db.pg-legacy`. Or dark-launch PGlite for FRESH installs only (env-gated), migrate existing users later. |
| 4 | **Single connection / no concurrent pool**: postgres.js pooling assumptions disappear; heavy parallel query paths serialize. | perf under fan-out | Desktop is single-user; drizzle-orm/pglite serializes safely. Benchmark board load before flipping the default. |
| 5 | **detect-port / worktree sibling-port logic** (`index.ts:430`, `worktree-config.ts:406`) becomes moot but harmless. | none | leave in place; PGlite arm skips it. |

## 5. Minimal incremental plan (recommended)

1. **Env-gated driver arm** (dark launch): `SUPERCLAW_DESKTOP_PGLITE=1` → in
   `server/src/index.ts`'s embedded branch, construct
   `drizzle(new PGlite(dataDirPglite, {extensions:{fuzzystrmatch, pg_trgm}}))` via
   `drizzle-orm/pglite` behind the same `Db` type; datadir
   `<instance>/db-pglite` (never touches the legacy cluster). Migrations run through
   drizzle's standard migrator — proven above.
2. Force `backupEngine='javascript'` in that arm; port the COPY streaming (caveat 2).
3. Desktop (Python `node_runtime.py`) sets the env var for the frozen bundle only —
   web/cloud deployments are untouched (`DATABASE_URL` arm unchanged).
4. Soak on fresh installs → add the one-time legacy import (caveat 3) → flip the
   desktop default; the v0.1.6 orphan reaper then becomes dead code to retire.

## 6. What this buys

The entire orphaned-postmaster failure class — stale locks, port 54329 collisions,
`ECONNRESET` 503s, the reaper itself — **ceases to exist** on the desktop: PGlite has
no child process, no port, no lockfile to go stale. Storage becomes "a directory of
files owned by the app", the same robustness class as CodePilot's single-file SQLite,
while keeping the Postgres SQL surface and all 125 migrations byte-identical.
