import { mkdir, mkdtemp, cp, lstat, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { computeStoredSkillDigest, globalSkillStoreDir } from "./global-runtime-skills.js";
import {
  SKILL_MARKDOWN_NAME,
  SKILL_PROVENANCE_NAME,
  SUPER_PLUGIN_MANIFEST_NAME_FOR_SKILL_GUARD,
  SuperSkillInstallError,
} from "./super-skill-installer.js";

/**
 * Real filesystem primitives for the workshop SKILL landing (S4): same-filesystem
 * staging, packaged-provenance scrub, a REAL executable-bit + symlink scan, and an
 * ATOMIC rename commit into the global skill store. These are the concrete, security-
 * relevant ops the {@link createSuperSkillInstaller} deps abstract.
 */

const S_IXUSR = 0o100;
const S_IXGRP = 0o010;
const S_IXOTH = 0o001;
const ANY_EXEC_BIT = S_IXUSR | S_IXGRP | S_IXOTH;

/** `<store>/<slug>` (slug safety is enforced by the installer; re-asserted here). */
export function resolveSkillStoreDir(slug: string): string {
  if (slug.includes("/") || slug.includes("\\") || slug.includes("..") || slug.startsWith(".")) {
    throw new SuperSkillInstallError(`refusing an unsafe skill slug as a directory name: ${JSON.stringify(slug)}`);
  }
  return path.join(globalSkillStoreDir(), slug);
}

/**
 * A fresh staging dir that is a SIBLING of the store (same filesystem → the commit
 * rename is atomic) and OUTSIDE the store dir (so `listGlobalRuntimeSkillEntries`,
 * which enumerates `<store>/*`, never sees a half-built skill).
 */
export async function createSkillStageDir(): Promise<string> {
  const storeParent = path.dirname(globalSkillStoreDir());
  await mkdir(storeParent, { recursive: true });
  return mkdtemp(path.join(storeParent, ".skill-staging-"));
}

/** Copy the unpacked skill into staging, EXCLUDING any packaged `.provenance.json` anywhere. */
export async function materializeSkill(unpackedDir: string, stageDir: string): Promise<void> {
  await cp(unpackedDir, stageDir, {
    recursive: true,
    filter: (src) => path.basename(src) !== SKILL_PROVENANCE_NAME,
  });
}

/** Belt-and-suspenders: delete any top-level `.provenance.json` the read path would use. */
export async function scrubPackagedProvenance(stageDir: string): Promise<void> {
  await rm(path.join(stageDir, SKILL_PROVENANCE_NAME), { force: true });
}

export async function hasSkillMarkdown(dir: string): Promise<boolean> {
  try {
    return (await stat(path.join(dir, SKILL_MARKDOWN_NAME))).isFile();
  } catch {
    return false;
  }
}

export async function hasPluginManifest(dir: string): Promise<boolean> {
  try {
    await stat(path.join(dir, SUPER_PLUGIN_MANIFEST_NAME_FOR_SKILL_GUARD));
    return true;
  } catch {
    return false;
  }
}

/**
 * Walk the dir and return true if ANY entry is a symlink OR a regular file with an
 * exec bit. Mirrors the kernel's allow_executable=False intent — an executable asset
 * (or a symlink that could point at one / smuggle bytes past the store's hash) is
 * refused. A symlink is treated as executable-suspect (the store rejects symlinks at
 * read time anyway; refusing here fails closed earlier).
 */
export async function hasExecutableAsset(dir: string): Promise<boolean> {
  async function walk(current: string): Promise<boolean> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      const info = await lstat(abs);
      if (info.isSymbolicLink()) return true;
      if (info.isDirectory()) {
        if (await walk(abs)) return true;
        continue;
      }
      if (info.isFile() && (info.mode & ANY_EXEC_BIT) !== 0) return true;
    }
    return false;
  }
  return walk(dir);
}

export async function writeSkillProvenance(dir: string, provenance: Record<string, unknown>): Promise<void> {
  // Match the kernel's style (sorted keys, 2-space indent, trailing newline). The exact
  // bytes are not admission-critical (the digest excludes `.provenance.json`), but a
  // consistent layout keeps a round-trip stable.
  const sorted = sortKeysDeep(provenance);
  await writeFile(path.join(dir, SKILL_PROVENANCE_NAME), JSON.stringify(sorted, null, 2) + "\n", "utf8");
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * ATOMICALLY rename the staging dir onto `<store>/<slug>` (the per-slug claim + the
 * commit). Fail-closed on ANY pre-existing node at the target — dir (empty OR not),
 * file, or symlink — so POSIX rename can never SILENTLY REPLACE a pre-existing empty
 * dir / symlink (a half-state/overwrite window). An occupied target → uninstall first.
 */
export async function commitSkill(stageDir: string, finalDir: string): Promise<void> {
  await mkdir(path.dirname(finalDir), { recursive: true });
  // Pre-check: a present node of ANY type is "occupied" (lstat, so a symlink is not
  // followed). ENOENT → free to rename.
  try {
    await lstat(finalDir);
    throw alreadyInstalled(finalDir);
  } catch (err) {
    if (err instanceof SuperSkillInstallError) throw err;
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  try {
    await rename(stageDir, finalDir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // A concurrent install that won the race between our lstat and rename.
    if (code === "EEXIST" || code === "ENOTEMPTY" || code === "EISDIR" || code === "ENOTDIR") {
      throw alreadyInstalled(finalDir);
    }
    throw err;
  }
}

function alreadyInstalled(finalDir: string): SuperSkillInstallError {
  return new SuperSkillInstallError(
    `skill ${path.basename(finalDir)} is already installed — uninstall it before reinstalling`,
  );
}

/**
 * Atomic UN-INSTALL primitive: rename the live store dir OUT of the store into a
 * same-filesystem quarantine, so the kernel can no longer enumerate the skill the
 * INSTANT this returns — never a slow, non-atomic `rm -rf` over the live store dir
 * (which could leave a half-deleted, still-present dir). Returns the quarantine path,
 * or `null` if the skill was not installed (ENOENT).
 */
export async function quarantineSkillDir(slug: string): Promise<string | null> {
  const skillDir = resolveSkillStoreDir(slug);
  const quarantine = path.join(path.dirname(globalSkillStoreDir()), `.skill-quarantine-${randomUUID()}`);
  try {
    await rename(skillDir, quarantine);
    return quarantine;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Read a stored skill's declared `source_digest` (binds the official badge to bytes). */
export async function readSkillSourceDigest(skillDir: string): Promise<string | null> {
  try {
    const raw = await readFile(path.join(skillDir, SKILL_PROVENANCE_NAME), "utf8");
    const prov = JSON.parse(raw) as { source_digest?: unknown };
    return typeof prov.source_digest === "string" ? prov.source_digest : null;
  } catch {
    return null;
  }
}

export async function removeSkillDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export { computeStoredSkillDigest };
