/**
 * Workshop import orchestration (capability workshop S2c).
 *
 * This is the receipt-gated control flow that turns a verified, staged workshop
 * artifact into a Paperclip-native install. It is the importer the Python gate
 * calls over loopback (`POST /api/internal/workshop-import`), and it ties the
 * trust pieces together:
 *
 *   1. verify the trust receipt (HMAC + TTL + app-env)            — S2a
 *   2. RECOMPUTE the transport digest over the staged archive and compare it to
 *      the receipt — this is the AUTHORITATIVE integrity boundary (a chmod on the
 *      staging dir is not; see S1). A mismatch means the bytes were swapped after
 *      Python verified them — fail closed.
 *   3. unpack the verified archive into a private dir the importer owns
 *   4. hand it to the per-kind native installer (plugin loader / skill store /
 *      company import) — these reuse Paperclip's own machinery
 *   5. record provenance from the VERIFIED receipt so the official badge binds to
 *      cosign, not a caller flag                                   — S2b
 *   6. on ANY failure after the native install, roll the install back so a
 *      half-installed/unverified artifact never lingers
 *
 * Every dependency is injected so the security-relevant control flow is unit
 * tested in-process with fakes (no real loader/db/fs); the concrete installers +
 * Express wiring land in the per-kind slices (S3–S5) and are covered by E2E (S6).
 */

import {
  verifyReceipt,
  type VerifiedWorkshopReceipt,
} from "./workshop-receipt.js";
import type { WorkshopProvenanceKind } from "./workshop-provenance.js";

export class WorkshopImportError extends Error {}

export interface WorkshopInstallContext {
  readonly receipt: VerifiedWorkshopReceipt;
  /** Directory the verified archive was unpacked into (importer-owned, writable). */
  readonly unpackedDir: string;
}

export interface WorkshopInstallResult {
  /** The Paperclip authority id the capability landed under (pluginKey / slug / companyId). */
  readonly nativeId: string;
  /**
   * An OPTIONAL server-recomputable digest of the LANDED bytes (e.g. a skill's store
   * digest). Recorded into provenance so the official badge can be bound to a digest a
   * store-writer cannot forge (the writable `.provenance.json` value is NOT this).
   */
  readonly verificationDigest?: string;
  /**
   * Undo THIS install. The installer owns its own rollback (it knows what it
   * landed), so the importer can roll back on any post-install failure WITHOUT
   * needing the native id — including the defensive empty-id case. Must leave no
   * residue when it resolves.
   */
  readonly rollback: () => Promise<void>;
}

/** Lands an unpacked, verified capability via Paperclip's native machinery for one kind. */
export type WorkshopInstaller = (ctx: WorkshopInstallContext) => Promise<WorkshopInstallResult>;

export interface UnpackedArchive {
  readonly dir: string;
  readonly cleanup: () => Promise<void>;
}

export interface WorkshopImportDeps {
  /** Required deployment env the receipt must be bound to. */
  readonly expectedAppEnv: string;
  /** Receipt HMAC key (defaults to the env key inside verifyReceipt when omitted). */
  readonly receiptKey?: Buffer | string;
  /** Clock for TTL checks (seconds); defaults to wall clock. */
  readonly now?: () => number;
  /**
   * AUTHORITATIVE integrity boundary, bound to ONE immutable byte snapshot: recompute
   * the transport digest over the archive bytes AND unpack THOSE SAME bytes, so the
   * extracted bytes ARE the digest-covered bytes — a same-UID rewrite of the path or
   * the inode after the snapshot cannot make extraction diverge from what was hashed
   * (a chmod/path is explicitly not the boundary; S1). Must throw if the digest does
   * not match `expectedTransportSha`.
   */
  readonly verifyAndUnpackArchive: (
    stagedArtifact: string,
    expectedTransportSha: string,
  ) => Promise<UnpackedArchive>;
  /** Per-kind native installers. */
  readonly installers: Readonly<Record<WorkshopProvenanceKind, WorkshopInstaller>>;
  /** Persist provenance from the verified receipt (binds the official badge to cosign). */
  readonly recordProvenance: (
    receipt: VerifiedWorkshopReceipt,
    nativeId: string,
    verificationDigest?: string,
  ) => Promise<void>;
  /** Optional sink for non-fatal cleanup failures (a leaked unpack temp dir) so they are observable, not lost. */
  readonly onWarning?: (message: string, err: unknown) => void;
}

/**
 * Roll back a just-completed install after a post-install failure. Resolves
 * (so the caller throws `primaryErr`) when rollback succeeds; if rollback ITSELF
 * fails, throws an `AggregateError` carrying both so the dangling, unattributed
 * install is never silent.
 */
async function rollbackAfterFailure(
  rollback: () => Promise<void>,
  primaryErr: unknown,
  kind: WorkshopProvenanceKind,
  nativeId: string,
): Promise<void> {
  try {
    await rollback();
  } catch (rollbackErr) {
    throw new AggregateError(
      [primaryErr, rollbackErr],
      `workshop import: rollback failed for ${kind}/${nativeId} after a post-install failure ` +
        "— capability may be installed but unattributed (manual cleanup required)",
    );
  }
}

export interface WorkshopImportOutcome {
  readonly kind: WorkshopProvenanceKind;
  readonly nativeId: string;
  readonly capabilityId: string;
  readonly version: string;
  readonly official: boolean;
}

/**
 * Run the receipt-gated workshop import. Throws `WorkshopImportError` (or a
 * verify/installer error) on any failure; on success returns the install outcome.
 */
export async function importWorkshopCapability(
  deps: WorkshopImportDeps,
  wire: unknown,
): Promise<WorkshopImportOutcome> {
  const receipt = verifyReceipt(wire, {
    expectedAppEnv: deps.expectedAppEnv,
    key: deps.receiptKey,
    now: deps.now?.(),
  });
  // verifyReceipt already constrained kind to plugin|skill|company.
  const kind = receipt.kind as WorkshopProvenanceKind;

  const installer = deps.installers[kind];
  if (!installer) {
    throw new WorkshopImportError(`no installer registered for kind ${JSON.stringify(kind)}`);
  }

  // AUTHORITATIVE integrity boundary (buffer-bound): recompute the transport digest
  // over the archive bytes AND unpack THOSE SAME bytes. A mismatch throws here, so the
  // installer only ever sees bytes that hashed to the receipt's committed value.
  const unpacked = await deps.verifyAndUnpackArchive(receipt.staged_artifact, receipt.transport_sha256);
  try {
    const { nativeId, rollback, verificationDigest } = await installer({ receipt, unpackedDir: unpacked.dir });
    if (!nativeId) {
      // The installer returned without a usable id. Use ITS OWN rollback (which
      // does not depend on the id) to undo any partial install — leaving no
      // residue — then fail loudly.
      const emptyIdErr = new WorkshopImportError(
        `installer for kind ${JSON.stringify(kind)} returned an empty native id`,
      );
      await rollbackAfterFailure(rollback, emptyIdErr, kind, "(no native id)");
      throw emptyIdErr;
    }

    try {
      await deps.recordProvenance(receipt, nativeId, verificationDigest);
    } catch (provenanceErr) {
      // Provenance is what makes the badge trustworthy — if it cannot be written,
      // the native install must be rolled back so nothing lingers unattributed.
      await rollbackAfterFailure(rollback, provenanceErr, kind, nativeId);
      throw provenanceErr;
    }

    return {
      kind,
      nativeId,
      capabilityId: receipt.capability_id,
      version: receipt.version,
      official: receipt.official,
    };
  } finally {
    // A leaked unpack temp dir must not mask the real outcome — surface it as a
    // warning, and never let the warning sink itself become a control-flow error.
    try {
      await unpacked.cleanup();
    } catch (err: unknown) {
      try {
        deps.onWarning?.(`failed to clean up unpack dir ${unpacked.dir}`, err);
      } catch {
        /* a failing warning sink must not change the import result */
      }
    }
  }
}
