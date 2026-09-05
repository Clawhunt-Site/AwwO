/**
 * Trust primitives — directory plugin-package loading + file enumeration (slice 9).
 *
 * Node port of the SuperClaw kernel directory-package path: `_load_plugin_package`
 * (the dir branch) + `PackageTrustVerifier.iter_package_files` / `digest_relative_name`
 * / `mode_signal` (trust.py / plugins.py). Turns a directory on disk into the
 * `{ manifest, files }` model `verifyPluginPackage` consumes, so a real package can be
 * verified end-to-end. The .scplug archive path (zip-bomb-guarded extraction) is a
 * later sub-slice; the cache write + __pycache__-shipping guard belong to the install
 * endpoint (the kernel calls _reject_shipped_pycache in cache_plugin_package, not here).
 */

import { lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { PackageVerificationError } from "./package-signature.js";
import { parsePluginManifest, type PackageDigestFile } from "./package-digest.js";
import type { LoadedPackage } from "./verify-package.js";

export const MANIFEST_NAME = "superclaw-plugin.json";

// Security-relevant POSIX mode bits the digest binds (cross-platform-stable 4-bit code,
// matching PackageTrustVerifier.mode_signal). Literal octals so it does not depend on a
// platform's fs.constants exposing every bit.
const S_IXUSR = 0o100;
const S_ISUID = 0o4000;
const S_ISGID = 0o2000;
const S_ISVTX = 0o1000;

function modeSignal(filePath: string): number {
  const mode = statSync(filePath).mode;
  let signal = 0;
  if (mode & S_IXUSR) signal |= 0b0001;
  if (mode & S_ISUID) signal |= 0b0010;
  if (mode & S_ISGID) signal |= 0b0100;
  if (mode & S_ISVTX) signal |= 0b1000;
  return signal;
}

/** Lexicographic comparison by Unicode code point (mirrors Python sorted() on strings). */
function codePointCompare(a: string, b: string): number {
  const aa = Array.from(a);
  const bb = Array.from(b);
  const n = Math.min(aa.length, bb.length);
  for (let i = 0; i < n; i += 1) {
    const d = aa[i].codePointAt(0)! - bb[i].codePointAt(0)!;
    if (d !== 0) return d;
  }
  return aa.length - bb.length;
}

function relativePosix(root: string, filePath: string): string {
  const relative = path.relative(root, filePath);
  const parts = relative.split(path.sep);
  for (const part of parts) {
    // digest_relative_name: each component must already be NFC-normalized; a non-NFC
    // name is rejected (not silently folded) so on-disk bytes, the digest key, and any
    // later path comparison cannot disagree.
    if (part.normalize("NFC") !== part) {
      throw new PackageVerificationError(
        `plugin package file name is not Unicode-NFC-normalized: ${parts.join("/")}`,
      );
    }
  }
  return parts.join("/");
}

/**
 * Enumerate a directory package's files into the digest model — mirrors
 * iter_package_files: recurse, REJECT any symlink (anywhere in the tree), skip
 * directories, skip interpreter-generated `__pycache__` content (never part of package
 * identity), require NFC names, and return entries sorted by code-point path order.
 */
export function enumeratePackageFiles(root: string): PackageDigestFile[] {
  const files: PackageDigestFile[] = [];

  const walk = (dir: string): void => {
    for (const dirent of readdirSync(dir)) {
      const full = path.join(dir, dirent);
      // lstat first: a symlink (to a file OR a directory) is rejected before it is
      // followed (mirrors path.is_symlink() raising in iter_package_files).
      if (lstatSync(full).isSymbolicLink()) {
        throw new PackageVerificationError(
          `plugin package may not contain symlink: ${relativePosix(root, full)}`,
        );
      }
      const stats = statSync(full);
      if (stats.isDirectory()) {
        walk(full);
        continue;
      }
      if (!stats.isFile()) continue;
      const relative = relativePosix(root, full);
      if (relative.split("/").includes("__pycache__")) continue;
      files.push({ relative, modeSignal: modeSignal(full), content: readFileSync(full) });
    }
  };
  walk(root);

  // Deterministic output ordering by relative posix code point. NOTE: this is the SAME
  // key computePackageDigest re-sorts by, so the enumeration order is not digest-
  // significant; it is NOT the kernel's intermediate `sorted(Path)` (which compares Path
  // parts and can differ on separators), but the digest is identical either way.
  files.sort((a, b) => codePointCompare(a.relative, b.relative));
  return files;
}

/**
 * Load a directory plugin package into the `{ manifest, files }` model. The manifest is
 * parsed via parsePluginManifest (float-literal-rejecting) at the trust boundary — never
 * plain JSON.parse — so a manifest float token cannot diverge the Node digest from the
 * kernel. Fail-closed: missing manifest, a symlink, or a non-NFC name throws.
 */
export function loadPluginPackageDir(root: string): LoadedPackage {
  const manifestPath = path.join(root, MANIFEST_NAME);
  let manifestBytes: Buffer;
  try {
    manifestBytes = readFileSync(manifestPath);
  } catch {
    throw new PackageVerificationError(`missing ${MANIFEST_NAME}`);
  }
  // STRICT UTF-8 (fatal): the kernel reads the manifest with `read_text(encoding="utf-8")`,
  // which raises UnicodeDecodeError on invalid bytes. `readFileSync(..., "utf-8")` would
  // instead replace them with U+FFFD and could parse a manifest the kernel rejects
  // (Node-accepts / Python-rejects). Fail closed on non-UTF-8.
  let manifestText: string;
  try {
    // ignoreBOM: true KEEPS a leading BOM as U+FEFF (the decoder would otherwise strip
    // it). The kernel's read_text keeps the BOM too, and json.loads then rejects it —
    // matched here because parsePluginManifest's JSON.parse also rejects a leading
    // U+FEFF. Without this, Node would silently strip the BOM and accept a manifest the
    // kernel rejects.
    manifestText = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(manifestBytes);
  } catch {
    throw new PackageVerificationError(`${MANIFEST_NAME} is not valid UTF-8`);
  }
  // Normalize the manifest-parse failure (parsePluginManifest raises TrustContractError
  // on a float literal / non-object) to PackageVerificationError, so the loader presents
  // a single error contract like the kernel's load_plugin_package ("never raises a raw
  // exception").
  let manifest: Record<string, unknown>;
  try {
    manifest = parsePluginManifest(manifestText);
  } catch (err) {
    throw new PackageVerificationError(
      err instanceof Error ? `invalid plugin manifest: ${err.message}` : "invalid plugin manifest",
    );
  }
  const files = enumeratePackageFiles(root);
  return { manifest, files };
}
