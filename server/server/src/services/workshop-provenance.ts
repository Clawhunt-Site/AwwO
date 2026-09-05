import { and, eq, sql } from "drizzle-orm";
import { boolean, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";

import type { VerifiedWorkshopReceipt } from "./workshop-receipt.js";

/**
 * Workshop provenance side-table (capability workshop S2b).
 *
 * When a capability is installed FROM the workshop, the bytes land in Paperclip's
 * own authority store (plugin `plugins` table / company `companies` table / the
 * global skill store). None of those carry the SuperClaw trust verdict, so a
 * sideloaded local item and a workshop-verified official one are indistinguishable
 * there. This side-table records the verdict — `official` (derived ONLY from the
 * Python cosign gate, carried in the trust receipt), the digest and the opaque
 * artifact ref — keyed by the native authority id, so the surface can JOIN it to
 * stamp the official badge correctly.
 *
 * Following the chat-pins precedent: rather than ALTER a vendored table or inject
 * a migration into the upstream drizzle sequence (which would collide with
 * upstream numbering on re-vendor), this is a SuperClaw-owned table created
 * idempotently on first use and never part of the vendored schema/migrations.
 *
 * Identity binding (Codex S2-v2): the row is keyed by `(kind, native_id)` AND
 * carries `package_digest` + `artifact_ref`, so a rename / uninstall / reinstall
 * cannot drift the official badge onto a different artifact.
 */
export const workshopProvenance = pgTable(
  "workshop_provenance",
  {
    kind: text("kind").notNull(),
    nativeId: text("native_id").notNull(),
    capabilityId: text("capability_id").notNull(),
    version: text("version").notNull(),
    packageDigest: text("package_digest").notNull(),
    artifactRef: text("artifact_ref").notNull(),
    receiptId: text("receipt_id").notNull(),
    official: boolean("official").notNull(),
    // The kernel-recomputable store digest (skills only) — a SERVER-controlled,
    // tamper-proof binding for the official badge. NULL for kinds (plugin/company)
    // whose badge rides their own gate (the plugin path gates on package_digest).
    storeDigest: text("store_digest"),
    installedAt: timestamp("installed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({ pk: primaryKey({ columns: [table.kind, table.nativeId] }) }),
);

export type WorkshopProvenanceKind = "plugin" | "skill" | "company";

export interface WorkshopProvenanceRecord {
  kind: WorkshopProvenanceKind;
  nativeId: string;
  capabilityId: string;
  version: string;
  packageDigest: string;
  artifactRef: string;
  receiptId: string;
  official: boolean;
  storeDigest?: string | null;
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

// Memoized per Db instance (tests spin up fresh databases). The value is the
// in-flight creation promise registered SYNCHRONOUSLY so concurrent first calls
// coalesce onto a single CREATE rather than racing two `CREATE TABLE IF NOT
// EXISTS` (Postgres can throw 42P07 on a concurrent catalog insert even with IF
// NOT EXISTS). A failed creation drops the cached promise so a later call retries.
const ensuring = new WeakMap<object, Promise<void>>();

function ensureWorkshopProvenanceTable(db: Db): Promise<void> {
  let pending = ensuring.get(db);
  if (!pending) {
    pending = (async () => {
      try {
        await db.execute(sql`
          CREATE TABLE IF NOT EXISTS workshop_provenance (
            kind text NOT NULL,
            native_id text NOT NULL,
            capability_id text NOT NULL,
            version text NOT NULL,
            package_digest text NOT NULL,
            artifact_ref text NOT NULL,
            receipt_id text NOT NULL,
            official boolean NOT NULL,
            store_digest text,
            installed_at timestamptz NOT NULL DEFAULT now(),
            PRIMARY KEY (kind, native_id)
          )
        `);
        // Migration for a pre-existing table created before store_digest existed.
        await db.execute(sql`ALTER TABLE workshop_provenance ADD COLUMN IF NOT EXISTS store_digest text`);
      } catch (err) {
        // Cross-connection cold-start: two workers racing the catalog insert can
        // throw duplicate_table (42P07) / unique_violation (23505) even with IF
        // NOT EXISTS. The table exists now — treat the race as success. (drizzle
        // wraps the driver error, so the SQLSTATE may sit on `err.cause`.)
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
 * Internal upsert on `(kind, native_id)`. Not exported: the only public write is
 * `recordVerifiedWorkshopProvenance`, so `official` can never originate from a
 * caller-supplied flag — it must come from a cosign-verified receipt.
 */
async function upsertProvenance(db: Db, record: WorkshopProvenanceRecord): Promise<void> {
  await ensureWorkshopProvenanceTable(db);
  await db
    .insert(workshopProvenance)
    .values({
      kind: record.kind,
      nativeId: record.nativeId,
      capabilityId: record.capabilityId,
      version: record.version,
      packageDigest: record.packageDigest,
      artifactRef: record.artifactRef,
      receiptId: record.receiptId,
      official: record.official,
      storeDigest: record.storeDigest ?? null,
    })
    .onConflictDoUpdate({
      target: [workshopProvenance.kind, workshopProvenance.nativeId],
      set: {
        capabilityId: record.capabilityId,
        version: record.version,
        packageDigest: record.packageDigest,
        artifactRef: record.artifactRef,
        receiptId: record.receiptId,
        official: record.official,
        storeDigest: record.storeDigest ?? null,
        installedAt: sql`now()`,
      },
    });
}

/**
 * Record (or refresh, on reinstall) workshop provenance from a VERIFIED receipt.
 *
 * This is the only public write path: `official`, the digest, version and
 * artifact ref are taken from the HMAC-verified receipt (the `official` verdict
 * is set ONLY by the Python cosign gate), so a sideloaded/local install can
 * never stamp itself official. `nativeId` is the Paperclip authority id the
 * capability landed under (pluginKey / skill slug / companyId).
 */
export async function recordVerifiedWorkshopProvenance(
  db: Db,
  receipt: VerifiedWorkshopReceipt,
  nativeId: string,
  storeDigest?: string | null,
): Promise<void> {
  await upsertProvenance(db, {
    kind: receipt.kind as WorkshopProvenanceKind,
    nativeId,
    capabilityId: receipt.capability_id,
    version: receipt.version,
    packageDigest: receipt.package_digest,
    artifactRef: receipt.artifact_ref,
    receiptId: receipt.receipt_id,
    official: receipt.official,
    storeDigest: storeDigest ?? null,
  });
}

/** Read the provenance for one installed capability, or null if not workshop-sourced. */
export async function getWorkshopProvenance(
  db: Db,
  kind: WorkshopProvenanceKind,
  nativeId: string,
): Promise<WorkshopProvenanceRecord | null> {
  await ensureWorkshopProvenanceTable(db);
  const rows = await db
    .select()
    .from(workshopProvenance)
    .where(and(eq(workshopProvenance.kind, kind), eq(workshopProvenance.nativeId, nativeId)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    kind: row.kind as WorkshopProvenanceKind,
    nativeId: row.nativeId,
    capabilityId: row.capabilityId,
    version: row.version,
    packageDigest: row.packageDigest,
    artifactRef: row.artifactRef,
    receiptId: row.receiptId,
    official: row.official,
    storeDigest: row.storeDigest ?? null,
  };
}

/** Provenance for every workshop-installed capability of a kind, keyed by native id (for list JOINs). */
export async function listWorkshopProvenance(
  db: Db,
  kind: WorkshopProvenanceKind,
): Promise<Map<string, WorkshopProvenanceRecord>> {
  await ensureWorkshopProvenanceTable(db);
  const rows = await db.select().from(workshopProvenance).where(eq(workshopProvenance.kind, kind));
  const map = new Map<string, WorkshopProvenanceRecord>();
  for (const row of rows) {
    map.set(row.nativeId, {
      kind: row.kind as WorkshopProvenanceKind,
      nativeId: row.nativeId,
      capabilityId: row.capabilityId,
      version: row.version,
      packageDigest: row.packageDigest,
      artifactRef: row.artifactRef,
      receiptId: row.receiptId,
      official: row.official,
      storeDigest: row.storeDigest ?? null,
    });
  }
  return map;
}

/** Drop provenance for an uninstalled capability (called by the GC reconciler). */
export async function deleteWorkshopProvenance(
  db: Db,
  kind: WorkshopProvenanceKind,
  nativeId: string,
): Promise<void> {
  await ensureWorkshopProvenanceTable(db);
  await db
    .delete(workshopProvenance)
    .where(and(eq(workshopProvenance.kind, kind), eq(workshopProvenance.nativeId, nativeId)));
}
