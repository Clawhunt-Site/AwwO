import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Native-dylib dedup: collapse byte-identical .dylib copies in the staged server
// tree into relative symlinks.
//
// embedded-postgres ships its PostgreSQL runtime libs as FULL COPIES of each
// version alias instead of symlinks — e.g. libicudata.dylib, libicudata.77.dylib,
// libicudata.77.1.dylib are three identical 61MB files (the ICU data blob). The
// standard macOS layout keeps one real file and points the alias names at it via
// symlinks. Restoring that here saves ~174MB with zero behavior change: dyld
// follows symlinks when resolving an `@loader_path/../lib/<name>` install_name, so
// `postgres`/`initdb` (verified: `--version` loads) and every PG-backed feature
// keep working.
//
// Safety rules:
// * Dedup ONLY within the SAME directory, so the replacement is a relative
//   same-dir symlink and `@loader_path/../lib/...` resolution is unchanged.
// * Group strictly by md5 (byte-identical) — never collapse libs that merely share
//   a basename prefix. Identical content makes the symlink semantically free.
// * The canonical (kept real) file is the lexicographically-first member, which for
//   the `name` / `name.MAJOR` / `name.MAJOR.MINOR` alias family is the fully-
//   versioned file (e.g. libicudata.77.1.dylib) — the most specific install_name
//   target. Every alias name still exists (as a symlink), so any install_name
//   variant (bare / major / full) resolves.
//
// codesign note: symlinks are not Mach-O, so signing only covers the real files;
// fewer real Mach-O objects to sign, and `codesign --verify --strict` is unaffected
// (system frameworks ship exactly this symlinked shape).

function md5(file) {
  return execFileSync("md5", ["-q", file], { encoding: "utf8" }).trim();
}

/**
 * Replace byte-identical sibling .dylib copies under `root` with relative
 * symlinks. Returns `{ linked: string[], freedBytes: number }` (paths relative to
 * root). A tree with no duplicates is a legitimate no-op.
 */
export function dedupNativeDylibs(root, { log = console.log } = {}) {
  let files;
  try {
    files = execFileSync("find", [root, "-type", "f", "-name", "*.dylib"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    })
      .split("\n")
      .filter(Boolean);
  } catch {
    files = [];
  }
  // Key by [directory, md5] so dedup is scoped to a single directory: the
  // replacement symlink is relative + same-dir, keeping @loader_path/../lib
  // resolution intact. JSON.stringify gives an unambiguous textual key (no control
  // characters in the source).
  const canonicalByKey = new Map();
  let freedBytes = 0;
  const linked = [];
  for (const full of files.sort()) {
    let st;
    try {
      st = fs.lstatSync(full);
    } catch {
      continue;
    }
    if (st.isSymbolicLink() || !st.isFile()) continue; // skip existing symlinks
    const dir = path.dirname(full);
    const key = JSON.stringify([dir, md5(full)]);
    const canonical = canonicalByKey.get(key);
    if (canonical) {
      freedBytes += st.size;
      fs.rmSync(full);
      fs.symlinkSync(canonical, full); // relative, same directory
      linked.push(path.relative(root, full));
    } else {
      canonicalByKey.set(key, path.basename(full));
    }
  }
  linked.sort();
  const freedMb = Number((freedBytes / (1024 * 1024)).toFixed(0));
  if (linked.length === 0) {
    log("dylib dedup: no byte-identical sibling dylibs found (nothing to dedup)");
  } else {
    log(`dylib dedup: linked ${linked.length} duplicate dylib(s) to canonical siblings, freed ~${freedMb}MB`);
    for (const rel of linked) log(`  - ${rel}`);
  }
  return { linked, freedBytes };
}
