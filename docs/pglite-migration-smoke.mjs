// PGlite feasibility smoke: apply ALL real ClawHunt server migrations to PGlite.
// Proves (or refutes) schema-level compatibility: 125 drizzle pg migrations incl.
// CREATE EXTENSION fuzzystrmatch + pg_trgm, gen_random_uuid, triggers, indexes.
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { fuzzystrmatch } from '@electric-sql/pglite/contrib/fuzzystrmatch';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

const MIG_DIR = String.raw`E:\Bobo's Coding cache\bo-work\superclaw\server\packages\db\dist\migrations`;
const DATA_DIR = './pgdata-smoke';

rmSync(DATA_DIR, { recursive: true, force: true });
const db = new PGlite(DATA_DIR, { extensions: { fuzzystrmatch, pg_trgm } });

const files = readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort();
console.log(`migrations found: ${files.length}`);

let applied = 0;
const failures = [];
for (const file of files) {
  const raw = readFileSync(join(MIG_DIR, file), 'utf8');
  // drizzle separates statements with '--> statement-breakpoint'
  const statements = raw.split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean);
  try {
    for (const stmt of statements) {
      await db.exec(stmt);
    }
    applied += 1;
  } catch (err) {
    failures.push({ file, error: String(err && err.message ? err.message : err).slice(0, 300) });
    if (failures.length >= 5) break; // enough signal
  }
}
console.log(`applied cleanly: ${applied}/${files.length}`);
if (failures.length) {
  console.log('FAILURES:');
  for (const f of failures) console.log(`  ${f.file}: ${f.error}`);
}

// Functional probes: the pg features the server actually leans on.
const probes = [
  ["fuzzystrmatch levenshtein", `SELECT levenshtein('clawhunt','clawhut') AS v`],
  ["pg_trgm similarity", `SELECT similarity('superclaw','superclaws') > 0 AS v`],
  ["gen_random_uuid", `SELECT gen_random_uuid()::text <> '' AS v`],
  ["table count", `SELECT count(*)::int AS v FROM information_schema.tables WHERE table_schema='public'`],
  ["basic insert/select (companies?)", `SELECT 1 AS v`],
];
for (const [name, sql] of probes) {
  try {
    const r = await db.query(sql);
    console.log(`probe OK: ${name} ->`, JSON.stringify(r.rows[0]));
  } catch (err) {
    console.log(`probe FAIL: ${name} -> ${String(err.message).slice(0, 160)}`);
  }
}

// LISTEN/NOTIFY (in-process) — used by anything realtime.
try {
  let got = null;
  await db.listen('smoke_chan', (payload) => { got = payload; });
  await db.query(`NOTIFY smoke_chan, 'ping'`);
  await new Promise((r) => setTimeout(r, 200));
  console.log('probe', got === 'ping' ? 'OK: LISTEN/NOTIFY -> "ping"' : `FAIL: LISTEN/NOTIFY (got ${got})`);
} catch (err) {
  console.log(`probe FAIL: LISTEN/NOTIFY -> ${String(err.message).slice(0, 160)}`);
}

await db.close();
console.log('DONE');
