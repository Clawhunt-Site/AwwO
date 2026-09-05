import type { WorkshopInstaller, WorkshopInstallResult } from "./workshop-import.js";

/**
 * Super-skill installer (capability workshop S4) — the `installers.skill` the S2c
 * importer ({@link importWorkshopCapability}) calls once a workshop skill artifact
 * has passed receipt + transport-digest verification and been unpacked.
 *
 * Skills land in the SAME global store the Python kernel imports into
 * (`~/.superclaw/skills/<slug>/`, read by `listGlobalRuntimeSkillEntries`). The
 * kernel admits a stored skill only when its dir carries BOTH `SKILL.md` AND a
 * `.provenance.json` whose declared `store_digest` matches the recomputed
 * `computeStoredSkillDigest` (trust rides ONLY the recomputed digest; the digest set
 * EXCLUDES `.provenance.json`).
 *
 * STAGE-THEN-ATOMIC-COMMIT: the skill is built in a same-filesystem STAGING dir
 * (OUTSIDE the store, so the kernel never enumerates a half-built skill), then
 * ATOMICALLY RENAMED into `<store>/<slug>`. The rename is BOTH the per-slug claim
 * (fail-closed on an already-installed slug) and the commit — the live store only
 * ever sees the final dir, with OUR `.provenance.json`, never a packaged one. Any
 * `.provenance.json` shipped in the package is SCRUBBED in staging first (the
 * installer's own boundary, not a materializer contract).
 *
 * H-architecture: verification stayed in Python; this landing does NOT re-slugify /
 * re-normalize (publish owns slug == capability_id and the layout). Governance here
 * (defence in depth): kind assertion; reverse red-line (a plugin package — carrying
 * `superclaw-plugin.json` — must NEVER land as a skill); slug safety (single store
 * segment); skill-shape (`SKILL.md` present); NO executable assets (an exec-bit asset
 * is code execution — refused, mirroring the kernel's allow_executable=False default).
 */

export class SuperSkillInstallError extends Error {}

export const SKILL_MARKDOWN_NAME = "SKILL.md";
export const SKILL_PROVENANCE_NAME = ".provenance.json";
export const SUPER_PLUGIN_MANIFEST_NAME_FOR_SKILL_GUARD = "superclaw-plugin.json";

export interface SuperSkillInstallerDeps {
  /** Final store path `<store>/<slug>`. */
  readonly resolveSkillDir: (slug: string) => string;
  /** Create a fresh staging dir on the SAME filesystem as the store (for atomic rename). */
  readonly createStageDir: () => Promise<string>;
  /** Copy the unpacked skill into the staging dir. */
  readonly materializeSkill: (unpackedDir: string, stageDir: string) => Promise<void>;
  /** Delete any `.provenance.json` in the staging dir (installer-owned scrub). */
  readonly scrubPackagedProvenance: (stageDir: string) => Promise<void>;
  /** Whether the dir is a skill package (top-level `SKILL.md`). */
  readonly hasSkillMarkdown: (dir: string) => Promise<boolean>;
  /** Whether the dir carries a super-plugin manifest (reverse red-line). */
  readonly hasPluginManifest: (dir: string) => Promise<boolean>;
  /** Whether the dir contains any executable-bit asset (defence in depth). */
  readonly hasExecutableAsset: (dir: string) => Promise<boolean>;
  /** Recompute the store digest over the placed files (byte-identical to the kernel). */
  readonly computeStoredSkillDigest: (dir: string) => Promise<string>;
  /** Write `.provenance.json` into the staging dir. */
  readonly writeSkillProvenance: (dir: string, provenance: Record<string, unknown>) => Promise<void>;
  /**
   * ATOMICALLY rename the staging dir onto `<store>/<slug>` (the claim + commit). MUST
   * throw {@link SuperSkillInstallError} (already-installed) when the slug already
   * exists — that rename failure is the per-slug fail-closed boundary.
   */
  readonly commitSkill: (stageDir: string, finalDir: string) => Promise<void>;
  /**
   * ATOMICALLY move the committed store dir into a quarantine; returns the quarantine
   * path, or null if not installed. Used by rollback so an already-committed skill is
   * UN-ADMITTED atomically (never a non-atomic `rm -rf` over the live store dir).
   */
  readonly quarantineSkillDir: (slug: string) => Promise<string | null>;
  /** Remove a dir (staging cleanup / rollback / uninstall). Idempotent. */
  readonly removeDir: (dir: string) => Promise<void>;
  /** Clock for `imported_at` (injectable for deterministic tests). */
  readonly now: () => Date;
}

/** A safe slug == a single store segment, no traversal, no separator, no leading dot. */
function isSafeSlug(slug: string): boolean {
  if (!slug || slug === "." || slug === "..") return false;
  if (slug.startsWith(".")) return false; // never collide with `.provenance.json` / hidden / staging
  return !/[/\\]/.test(slug) && !slug.includes("..");
}

function buildSkillProvenance(
  receipt: {
    capability_id: string;
    version: string;
    package_digest: string;
    artifact_ref: string;
    official: boolean;
    receipt_id: string;
  },
  storeDigest: string,
  now: Date,
): Record<string, unknown> {
  return {
    schema_version: "0.1.0",
    label: "workshop",
    store_digest: storeDigest,
    source_digest: receipt.package_digest,
    signature: null, // the workshop signature lives in the cosign receipt, not re-stored here
    executable: false, // an exec asset would have been refused before this point
    executable_assets: [],
    imported_at: now.toISOString(),
    importer: "superclaw-workshop",
    workshop: {
      capability_id: receipt.capability_id,
      version: receipt.version,
      artifact_ref: receipt.artifact_ref,
      official: receipt.official,
      receipt_id: receipt.receipt_id,
    },
  };
}

export function createSuperSkillInstaller(deps: SuperSkillInstallerDeps): WorkshopInstaller {
  return async (ctx): Promise<WorkshopInstallResult> => {
    if (ctx.receipt.kind !== "skill") {
      throw new SuperSkillInstallError(`super skill installer received a non-skill receipt: ${ctx.receipt.kind}`);
    }
    const slug = ctx.receipt.capability_id;
    if (!isSafeSlug(slug)) {
      throw new SuperSkillInstallError(`refusing an unsafe skill slug as a store dir: ${JSON.stringify(slug)}`);
    }
    // RED LINE (reverse): a plugin package must NEVER land as a skill.
    if (await deps.hasPluginManifest(ctx.unpackedDir)) {
      throw new SuperSkillInstallError(`refusing to install a plugin package as a skill: ${slug}`);
    }
    if (!(await deps.hasSkillMarkdown(ctx.unpackedDir))) {
      throw new SuperSkillInstallError(`skill package ${slug} has no ${SKILL_MARKDOWN_NAME}`);
    }

    const stageDir = await deps.createStageDir();
    let storeDigest = "";
    try {
      await deps.materializeSkill(ctx.unpackedDir, stageDir);
      // Installer-owned boundary: no packaged `.provenance.json` may survive into the
      // committed skill (else it could be admitted with a forged digest/official).
      await deps.scrubPackagedProvenance(stageDir);
      if (!(await deps.hasSkillMarkdown(stageDir))) {
        throw new SuperSkillInstallError(`staged skill ${slug} lost its ${SKILL_MARKDOWN_NAME}`);
      }
      // Defence in depth (mirror allow_executable=False): an exec-bit asset is code
      // execution — refuse it before the skill can ever be committed/admitted.
      if (await deps.hasExecutableAsset(stageDir)) {
        throw new SuperSkillInstallError(`skill ${slug} contains an executable asset — refused`);
      }
      storeDigest = await deps.computeStoredSkillDigest(stageDir);
      await deps.writeSkillProvenance(stageDir, buildSkillProvenance(ctx.receipt, storeDigest, deps.now()));
      // ATOMIC commit + claim: the live store sees the full skill (with OUR provenance)
      // in one rename, or fails closed on an already-installed slug.
      await deps.commitSkill(stageDir, deps.resolveSkillDir(slug));
    } catch (err) {
      // Staging never made it into the store — clean it up. Surface a cleanup failure
      // (a leaked staging dir) via AggregateError rather than swallowing it.
      try {
        await deps.removeDir(stageDir);
      } catch (cleanupErr) {
        throw new AggregateError(
          [err, cleanupErr],
          `skill ${slug}: install failed AND staging cleanup failed (manual cleanup of ${stageDir} required)`,
        );
      }
      throw err;
    }

    return {
      nativeId: slug,
      // The kernel-recomputable store digest — recorded into provenance so the official
      // badge binds to a digest a store-writer cannot forge.
      verificationDigest: storeDigest,
      // Undo the COMMITTED install (the importer calls this on a post-install failure,
      // e.g. the provenance-row write failed). ATOMIC quarantine (rename out of the
      // store = instant un-admit) THEN best-effort delete — never a non-atomic `rm -rf`
      // over the live store dir.
      rollback: async () => {
        const quarantine = await deps.quarantineSkillDir(slug);
        if (quarantine !== null) await deps.removeDir(quarantine);
      },
    };
  };
}

export interface SuperSkillUninstallDeps {
  /**
   * ATOMICALLY move the live store dir into a quarantine (rename); returns the
   * quarantine path, or `null` if the skill is not installed. This is the kernel
   * un-admit — the moment it returns the skill is gone from the store enumeration.
   */
  readonly quarantineSkillDir: (slug: string) => Promise<string | null>;
  /** Best-effort delete of the quarantined dir (a leftover is outside the store → harmless). */
  readonly removeDir: (dir: string) => Promise<void>;
  /** Clear the workshop provenance side-table row for this skill slug. */
  readonly clearProvenance: (slug: string) => Promise<void>;
}

/**
 * Uninstall a skill. The kernel admits a SKILL purely on its store dir (`SKILL.md` +
 * `.provenance.json` + matching digest), so the store dir is the runnable/admission
 * residue — and a non-atomic `rm -rf` over the live dir could leave a half-deleted,
 * still-present dir. So we ATOMICALLY QUARANTINE first (rename out of the store —
 * instant un-admit), THEN clear the side-table provenance, THEN best-effort delete the
 * quarantine. Returns true if a skill was uninstalled, false if none was installed.
 * Provenance is cleared either way (idempotent — sweeps a stale row for a vanished slug).
 * Partial-failure prefixes are safe:
 *   - quarantine ENOENT (not installed) → nothing to un-admit;
 *   - quarantined, provenance-clear fails → skill already un-admitted (gone from the
 *     enumeration), so the orphan DB row joins nothing — invisible, not orphan-official;
 *   - quarantine + clear done, quarantine delete fails → a leftover dir OUTSIDE the
 *     store, never enumerated → a harmless disk nuisance.
 */
export async function uninstallSuperSkill(deps: SuperSkillUninstallDeps, slug: string): Promise<boolean> {
  const quarantine = await deps.quarantineSkillDir(slug);
  await deps.clearProvenance(slug);
  if (quarantine === null) return false;
  await deps.removeDir(quarantine);
  return true;
}
