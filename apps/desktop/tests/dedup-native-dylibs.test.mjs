import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { dedupNativeDylibs } from "../scripts/dedup-native-dylibs.mjs";

// Mirror embedded-postgres's native/lib: a version-alias family shipped as 3
// byte-identical copies, plus a distinct lib, plus a same-named copy in ANOTHER
// directory (which must NOT be collapsed across dirs).
function makeTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dylib-dedup-"));
  const lib = path.join(root, "native", "lib");
  const other = path.join(root, "other", "lib");
  fs.mkdirSync(lib, { recursive: true });
  fs.mkdirSync(other, { recursive: true });

  const family = Buffer.alloc(8192, 7); // identical content → identical md5
  for (const n of ["libfoo.dylib", "libfoo.1.dylib", "libfoo.1.2.dylib"]) {
    fs.writeFileSync(path.join(lib, n), family);
  }
  fs.writeFileSync(path.join(lib, "libbaz.dylib"), Buffer.alloc(8192, 9)); // distinct
  fs.writeFileSync(path.join(other, "libfoo.dylib"), family); // same bytes, other dir
  return { root, lib, other };
}

test("collapses same-dir byte-identical dylibs to relative symlinks, keeps the fully-versioned real file", () => {
  const { root, lib } = makeTree();
  try {
    const logs = [];
    const { linked, freedBytes } = dedupNativeDylibs(root, { log: (m) => logs.push(m) });

    assert.equal(linked.length, 2, `expected 2 links, got ${linked.join(", ")}`);
    assert.ok(freedBytes >= 2 * 8192, "should free the two duplicate bodies");

    // Canonical = lexicographically first = the fully-versioned file.
    const canonical = path.join(lib, "libfoo.1.2.dylib");
    assert.ok(fs.lstatSync(canonical).isFile() && !fs.lstatSync(canonical).isSymbolicLink(),
      "libfoo.1.2.dylib must stay a real file");

    for (const alias of ["libfoo.dylib", "libfoo.1.dylib"]) {
      const p = path.join(lib, alias);
      assert.ok(fs.lstatSync(p).isSymbolicLink(), `${alias} must become a symlink`);
      // relative, same-dir (basename only) — preserves @loader_path/../lib resolution
      assert.equal(fs.readlinkSync(p), "libfoo.1.2.dylib", `${alias} must point at the canonical sibling`);
      // resolves to identical content
      assert.deepEqual(fs.readFileSync(p), fs.readFileSync(canonical), `${alias} must resolve to canonical bytes`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("does NOT collapse identical files across different directories", () => {
  const { root, other } = makeTree();
  try {
    dedupNativeDylibs(root, { log: () => {} });
    // other/lib has only one libfoo.dylib — no same-dir duplicate, so untouched.
    const p = path.join(other, "libfoo.dylib");
    assert.ok(fs.lstatSync(p).isFile() && !fs.lstatSync(p).isSymbolicLink(),
      "cross-directory file must remain a real file (no cross-dir symlink)");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("leaves distinct-content dylibs alone", () => {
  const { root, lib } = makeTree();
  try {
    dedupNativeDylibs(root, { log: () => {} });
    const p = path.join(lib, "libbaz.dylib");
    assert.ok(fs.lstatSync(p).isFile() && !fs.lstatSync(p).isSymbolicLink(),
      "a unique-content dylib must never be symlinked");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("is an auditable no-op when there are no duplicates", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dylib-dedup-empty-"));
  try {
    const lib = path.join(root, "native", "lib");
    fs.mkdirSync(lib, { recursive: true });
    fs.writeFileSync(path.join(lib, "libonly.dylib"), Buffer.alloc(1024, 3));
    const logs = [];
    const { linked, freedBytes } = dedupNativeDylibs(root, { log: (m) => logs.push(m) });
    assert.equal(linked.length, 0);
    assert.equal(freedBytes, 0);
    assert.match(logs.join("\n"), /nothing to dedup/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("skips files that are already symlinks (idempotent)", () => {
  const { root, lib } = makeTree();
  try {
    const first = dedupNativeDylibs(root, { log: () => {} });
    assert.equal(first.linked.length, 2);
    // Second run: the aliases are already symlinks → nothing left to do.
    const second = dedupNativeDylibs(root, { log: () => {} });
    assert.equal(second.linked.length, 0, "re-running must be a no-op (idempotent)");
    assert.equal(second.freedBytes, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
