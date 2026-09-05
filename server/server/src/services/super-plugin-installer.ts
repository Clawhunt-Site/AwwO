import type { Db } from "@paperclipai/db";

import {
  isSkillOriginManifest,
  parseSuperPluginManifest,
  SUPER_PLUGIN_MANIFEST_NAME,
} from "./super-plugin-manifest.js";
import {
  deleteSuperPluginRuntime,
  insertSuperPluginRuntime,
  isSuperPluginKeyConflict,
  runtimeRecordFromManifest,
  setSuperPluginRuntimeStatus,
} from "./super-plugin-runtime-store.js";
import { deleteWorkshopProvenance } from "./workshop-provenance.js";
import type { WorkshopInstaller, WorkshopInstallResult } from "./workshop-import.js";

/**
 * Super-plugin installer (capability workshop P6) — the `installers.plugin` the
 * S2c importer ({@link importWorkshopCapability}) calls once a workshop artifact
 * has passed receipt + transport-digest verification and been unpacked.
 *
 * A workshop `plugin` artifact can be EITHER a super-format plugin (carries a
 * `superclaw-plugin.json` manifest → language-agnostic sidecar / external_mcp,
 * landed in the SuperClaw runtime store for the P5 router/P4 runner) OR a
 * Paperclip-native JS plugin (no super manifest → Paperclip's own loader owns it).
 * This installer DETECTS which and dispatches; it never shoves a super plugin into
 * Paperclip's JS-worker table (it would impersonate a worker that does not exist)
 * nor vice-versa.
 *
 * Governance enforced HERE, at the install boundary (defence in depth — P3 re-runs
 * exec gating at every spawn, but a bad artifact must not even land) — for BOTH
 * the super and the delegated JS path:
 *   - kind ASSERTION: only a `kind=plugin` receipt may reach this installer.
 *   - skill RED LINE: a `skill.`-prefixed capability (or a `skill_origin` super
 *     manifest) must NEVER install as a plugin runtime — fail closed.
 *   - id BINDING: the LANDED native id must equal the verified receipt's
 *     capability_id, so nothing can land under a different key (and thus inherit
 *     another capability's provenance/official badge). The super path binds the
 *     manifest id; the JS path is checked AFTER it returns (and rolled back on a
 *     mismatch) because the importer records provenance against the landed id.
 *   - digest BINDING (super): the runtime row records the receipt's package_digest,
 *     the same value provenance binds to — so the P5 catalog's digest-match holds.
 *   - no in-place reinstall: an already-installed id is refused (a workshop install
 *     is not an in-place upgrade), which removes the non-atomic rm-then-replace
 *     corruption window entirely (uninstall first).
 *
 * Every fs/db effect is injected so the security-relevant control flow is unit
 * tested in-process with fakes; the Express wiring lands in P6b.
 */

export class SuperPluginInstallError extends Error {}

export interface SuperPluginInstallerDeps {
  readonly db: Db;
  /**
   * Read + JSON-parse the `superclaw-plugin.json` from the unpacked dir, or return
   * `null` when the artifact is NOT a super-format plugin (so we delegate to the
   * Paperclip JS installer). Only file-absence yields null; a present-but-unreadable
   * manifest must throw (a corrupt super plugin must not be silently treated as JS).
   */
  readonly readSuperManifestJson: (unpackedDir: string) => Promise<unknown | null>;
  /** Resolve the persistent, store-owned install dir for a plugin key (absolute). */
  readonly resolveInstallDir: (pluginKey: string) => string;
  /**
   * Materialize the verified unpacked dir into the (fresh) install dir. Only ever
   * called for a NOT-yet-installed id (reinstall is refused), so it never has to
   * rm-then-replace a live install.
   */
  readonly materializeInstall: (unpackedDir: string, installDir: string) => Promise<void>;
  /** Remove an install dir (rollback / uninstall). Must be idempotent (no-op if absent). */
  readonly removeInstallDir: (installDir: string) => Promise<void>;
  /** Land a Paperclip-native JS plugin when no super manifest is present. */
  readonly installPaperclipJsPlugin: WorkshopInstaller;
}

/** A `skill.`-prefixed capability id must never be installed/run as a plugin. */
function assertNotSkillCapability(capabilityId: string): void {
  if (capabilityId.startsWith("skill.")) {
    throw new SuperPluginInstallError(
      `refusing to install a skill capability (${JSON.stringify(capabilityId)}) as a plugin`,
    );
  }
}

/**
 * Enforce that the LANDED native id matches the verified receipt capability. On a
 * mismatch, roll the install back (so a wrong-id artifact never lingers) and throw;
 * if the rollback itself fails, surface BOTH via AggregateError (never silent).
 */
async function enforceLandedIdBinding(
  result: WorkshopInstallResult,
  capabilityId: string,
): Promise<WorkshopInstallResult> {
  if (result.nativeId === capabilityId) return result;
  const bindingErr = new SuperPluginInstallError(
    `installed native id ${JSON.stringify(result.nativeId)} does not match the verified ` +
      `receipt capability ${JSON.stringify(capabilityId)}`,
  );
  try {
    await result.rollback();
  } catch (rollbackErr) {
    throw new AggregateError(
      [bindingErr, rollbackErr],
      `id-binding violation AND rollback failed for ${capabilityId} — capability may be ` +
        "installed under the wrong id (manual cleanup required)",
    );
  }
  throw bindingErr;
}

/**
 * Undo a claimed-but-not-completed install (placed bytes + the claim row). Order is
 * DIR-BEFORE-ROW: the claim row holds the unique `plugin_key`, so deleting it
 * releases the id — if we released it BEFORE the dir was gone, a racing same-id
 * install could re-claim and start materializing, and this stale `removeInstallDir`
 * would then delete the NEW install's bytes. So we remove the dir first and only
 * delete the row once the bytes are gone. If the dir removal fails, the row is KEPT
 * (an "installing" sentinel that fail-closes a reinstall) and BOTH errors surface
 * via AggregateError — never a silent leak, never a key released over live bytes.
 */
async function rollbackClaim(
  deps: SuperPluginInstallerDeps,
  pluginKey: string,
  installDir: string,
  landErr: unknown,
): Promise<void> {
  try {
    await deps.removeInstallDir(installDir);
    await deleteSuperPluginRuntime(deps.db, pluginKey);
  } catch (cleanupErr) {
    throw new AggregateError(
      [landErr, cleanupErr],
      `super plugin ${pluginKey}: landing failed AND rollback failed — the claim row is kept as ` +
        `a blocking sentinel; manual cleanup of ${installDir} required`,
    );
  }
}

/**
 * Build the `installers.plugin` for the S2c importer. The returned installer:
 * detects super vs JS, enforces the install-boundary governance for BOTH paths,
 * materializes + records the runtime, and returns an installer-owned rollback.
 */
export function createSuperPluginInstaller(deps: SuperPluginInstallerDeps): WorkshopInstaller {
  return async (ctx): Promise<WorkshopInstallResult> => {
    // Defence in depth: the importer dispatches by kind, but assert it anyway.
    if (ctx.receipt.kind !== "plugin") {
      throw new SuperPluginInstallError(`super plugin installer received a non-plugin receipt: ${ctx.receipt.kind}`);
    }
    // RED LINE (all paths, before any landing): a skill capability never lands as a plugin.
    assertNotSkillCapability(ctx.receipt.capability_id);

    const raw = await deps.readSuperManifestJson(ctx.unpackedDir);
    if (raw === null) {
      // Not a super-format plugin → Paperclip's own JS-plugin loader owns it, but
      // the LANDED id is still bound to the receipt (the importer records provenance
      // against whatever id comes back).
      return enforceLandedIdBinding(await deps.installPaperclipJsPlugin(ctx), ctx.receipt.capability_id);
    }

    // A schema-invalid manifest is a CLIENT-CORRECTABLE package error — normalize the
    // SuperPluginManifestError to our install error class so the route returns 400.
    let manifest;
    try {
      manifest = parseSuperPluginManifest(raw);
    } catch (err) {
      throw new SuperPluginInstallError(`invalid ${SUPER_PLUGIN_MANIFEST_NAME}: ${(err as Error).message}`);
    }

    // RED LINE: a skill-origin super manifest (flag OR `skill.` id) never lands as a plugin.
    if (isSkillOriginManifest(manifest)) {
      throw new SuperPluginInstallError(
        `refusing to install a skill-origin manifest as a plugin: ${manifest.id}`,
      );
    }
    // BINDING: the manifest must land under the id the verified receipt committed to.
    if (manifest.id !== ctx.receipt.capability_id) {
      throw new SuperPluginInstallError(
        `${SUPER_PLUGIN_MANIFEST_NAME} id ${JSON.stringify(manifest.id)} does not match the ` +
          `verified receipt capability ${JSON.stringify(ctx.receipt.capability_id)}`,
      );
    }

    const installDir = deps.resolveInstallDir(manifest.id);

    // ATOMIC CLAIM (no in-place reinstall): INSERT the row FIRST, insert-only, as
    // status "installing". The unique plugin_key constraint is the per-key boundary —
    // a concurrent same-id import loses here with a 23505 and never reaches the
    // filesystem, so there is no rm-then-replace window and no fs race on the dir.
    const record = runtimeRecordFromManifest(manifest, {
      installDir,
      packageDigest: ctx.receipt.package_digest,
    });
    try {
      await insertSuperPluginRuntime(deps.db, { ...record, status: "installing" });
    } catch (claimErr) {
      if (isSuperPluginKeyConflict(claimErr)) {
        throw new SuperPluginInstallError(
          `super plugin ${manifest.id} is already installed — uninstall it before reinstalling ` +
            "(a workshop install is not an in-place upgrade)",
        );
      }
      throw claimErr;
    }

    // We are the sole claimant of this id now. Materialize the bytes, then flip the
    // row to "installed". On ANY failure, undo BOTH (delete the row we own + remove
    // the dir) — safe precisely because the claim made us the only writer.
    try {
      await deps.materializeInstall(ctx.unpackedDir, installDir);
      await setSuperPluginRuntimeStatus(deps.db, manifest.id, "installed");
    } catch (landErr) {
      await rollbackClaim(deps, manifest.id, installDir, landErr);
      throw landErr;
    }

    return {
      nativeId: manifest.id,
      // Installer-owned rollback (the importer calls this on a post-install failure).
      // DIR-BEFORE-ROW (same reasoning as rollbackClaim): never release the unique id
      // before the bytes are gone, or a racing reinstall could be stomped. A failed
      // dir removal keeps the row as a blocking sentinel and propagates (the importer
      // wraps it in its own AggregateError).
      rollback: async () => {
        await deps.removeInstallDir(installDir);
        await deleteSuperPluginRuntime(deps.db, manifest.id);
      },
    };
  };
}

export interface SuperPluginUninstallDeps {
  readonly db: Db;
  readonly removeInstallDir: (installDir: string) => Promise<void>;
}

/**
 * Uninstall a super plugin. Order: CLEAR provenance → remove dir → delete row. Two
 * invariants drive it:
 *   1. provenance FIRST closes the stale-official hazard (a future capability REUSING
 *      this native id inheriting an OFFICIAL badge it was never granted — P5 joins
 *      the badge by native id).
 *   2. dir BEFORE row: the row holds the unique `plugin_key`; releasing it before the
 *      bytes are gone would let a racing reinstall re-claim the id and then be stomped
 *      by this `removeInstallDir`. So the row is deleted LAST.
 * Every partial-failure prefix is safe:
 *   - provenance clear fails → nothing else ran → still fully installed (retryable);
 *   - provenance cleared, dir removal fails → row KEPT (key held → reinstall
 *     fail-closes) and the plugin is non-official + (no provenance) non-executable —
 *     degraded, not an orphan-official; the dir-removal error propagates;
 *   - provenance + dir gone, row delete fails → row points at a missing dir but
 *     executeTool already fail-closes on the absent provenance; key still held,
 *     retryable.
 */
export async function uninstallSuperPlugin(
  deps: SuperPluginUninstallDeps,
  record: { pluginKey: string; installDir: string },
): Promise<void> {
  await deleteWorkshopProvenance(deps.db, "plugin", record.pluginKey);
  await deps.removeInstallDir(record.installDir);
  await deleteSuperPluginRuntime(deps.db, record.pluginKey);
}

/**
 * Clear the workshop provenance for a Paperclip-native (JS) plugin on uninstall.
 * The super path clears provenance inside {@link uninstallSuperPlugin}; the JS
 * delete path (Paperclip's own `DELETE /plugins/:id`) must call THIS so the same
 * stale-official hazard is closed for both runtimes (P6b wires it into the route).
 */
export async function clearPluginProvenanceOnUninstall(db: Db, pluginKey: string): Promise<void> {
  await deleteWorkshopProvenance(db, "plugin", pluginKey);
}

/** Re-export the manifest constant so callers building `readSuperManifestJson` agree on the filename. */
export { SUPER_PLUGIN_MANIFEST_NAME };
