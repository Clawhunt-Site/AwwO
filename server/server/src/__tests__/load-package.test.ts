import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { enumeratePackageFiles, loadPluginPackageDir, MANIFEST_NAME } from "../trust/load-package.js";
import { PackageVerificationError } from "../trust/package-signature.js";
import { verifyPluginPackage } from "../trust/verify-package.js";

const ROOT_ENV = "SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY";
const SAVED = { ...process.env };
let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(path.join(os.tmpdir(), "loadpkg-"));
  process.env.APP_ENV = "production";
  delete process.env[ROOT_ENV];
  delete process.env.SUPERCLAW_PLUGIN_LOCAL_DEV_TRUST;
});
afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
  process.env = { ...SAVED };
});

const manifestJson = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: "dev.x.tool",
    version: "1.0.0",
    runtime: { type: "mcp" },
    provenance: { package_digest: "", signature: "", signer: "root" },
    ...extra,
  });

describe("enumeratePackageFiles", () => {
  it("recurses, sorts by path, skips __pycache__, and reads the executable mode bit", () => {
    writeFileSync(path.join(workdir, MANIFEST_NAME), manifestJson());
    writeFileSync(path.join(workdir, "data.txt"), "data\n");
    writeFileSync(path.join(workdir, "entry.py"), "print(1)\n");
    chmodSync(path.join(workdir, "entry.py"), 0o755);
    mkdirSync(path.join(workdir, "lib"));
    writeFileSync(path.join(workdir, "lib", "util.py"), "x=1\n");
    mkdirSync(path.join(workdir, "__pycache__"));
    writeFileSync(path.join(workdir, "__pycache__", "util.cpython-311.pyc"), "bytecode");
    mkdirSync(path.join(workdir, "lib", "__pycache__"));
    writeFileSync(path.join(workdir, "lib", "__pycache__", "util.pyc"), "bytecode");

    const files = enumeratePackageFiles(workdir);
    expect(files.map((f) => f.relative)).toEqual(["data.txt", "entry.py", "lib/util.py", MANIFEST_NAME]);
    expect(files.find((f) => f.relative === "entry.py")!.modeSignal & 0b0001).toBe(0b0001);
    expect(files.find((f) => f.relative === "data.txt")!.modeSignal).toBe(0);
  });

  it("rejects a symlink anywhere in the tree (fail-closed)", () => {
    writeFileSync(path.join(workdir, MANIFEST_NAME), manifestJson());
    writeFileSync(path.join(workdir, "real.txt"), "x");
    symlinkSync(path.join(workdir, "real.txt"), path.join(workdir, "link.txt"));
    expect(() => enumeratePackageFiles(workdir)).toThrow(PackageVerificationError);
  });

  it("rejects a symlinked directory before following it", () => {
    writeFileSync(path.join(workdir, MANIFEST_NAME), manifestJson());
    mkdirSync(path.join(workdir, "realdir"));
    symlinkSync(path.join(workdir, "realdir"), path.join(workdir, "linkdir"));
    expect(() => enumeratePackageFiles(workdir)).toThrow(/symlink/);
  });

  it("binds the setuid / setgid / sticky mode bits (not just owner-exec)", () => {
    writeFileSync(path.join(workdir, MANIFEST_NAME), manifestJson());
    writeFileSync(path.join(workdir, "suid"), "x");
    chmodSync(path.join(workdir, "suid"), 0o4644); // setuid → bit 0b0010
    writeFileSync(path.join(workdir, "sgid"), "x");
    chmodSync(path.join(workdir, "sgid"), 0o2644); // setgid → bit 0b0100
    writeFileSync(path.join(workdir, "sticky"), "x");
    chmodSync(path.join(workdir, "sticky"), 0o1644); // sticky → bit 0b1000
    const byName = Object.fromEntries(enumeratePackageFiles(workdir).map((f) => [f.relative, f.modeSignal]));
    // Independent per bit: some filesystems silently drop setuid/setgid/sticky on a plain
    // file. For each, only assert the signal bit when the on-disk mode actually kept it.
    const onDisk = (name: string) => statSync(path.join(workdir, name)).mode;
    if (onDisk("suid") & 0o4000) expect(byName.suid & 0b0010).toBe(0b0010);
    if (onDisk("sgid") & 0o2000) expect(byName.sgid & 0b0100).toBe(0b0100);
    if (onDisk("sticky") & 0o1000) expect(byName.sticky & 0b1000).toBe(0b1000);
  });

  it("rejects an on-disk non-NFC filename (when the filesystem preserves it)", () => {
    writeFileSync(path.join(workdir, MANIFEST_NAME), manifestJson());
    const decomposed = "é.txt"; // "é" as e + combining acute
    writeFileSync(path.join(workdir, decomposed), "x");
    const onDisk = readdirSync(workdir);
    if (onDisk.includes(decomposed)) {
      // FS preserved the decomposed name → enumeration must reject it.
      expect(() => enumeratePackageFiles(workdir)).toThrow(/NFC/);
    } else {
      // FS normalized the name to NFC → nothing non-NFC on disk, so no throw.
      expect(() => enumeratePackageFiles(workdir)).not.toThrow();
    }
  });
});

describe("loadPluginPackageDir", () => {
  it("throws when the manifest is missing", () => {
    writeFileSync(path.join(workdir, "data.txt"), "x");
    expect(() => loadPluginPackageDir(workdir)).toThrow(/missing superclaw-plugin\.json/);
  });

  it("rejects a manifest with a float literal (parsePluginManifest at the trust boundary)", () => {
    writeFileSync(path.join(workdir, MANIFEST_NAME), '{"id":"x","provenance":{},"n":4096.0}');
    expect(() => loadPluginPackageDir(workdir)).toThrow(PackageVerificationError);
  });

  it("rejects a manifest that is not valid UTF-8 (strict decode, parity with read_text)", () => {
    // Valid JSON shape but an invalid UTF-8 byte (0xFF) inside a string value.
    const bad = Buffer.concat([Buffer.from('{"id":"x","provenance":{},"s":"'), Buffer.from([0xff]), Buffer.from('"}')]);
    writeFileSync(path.join(workdir, MANIFEST_NAME), bad);
    expect(() => loadPluginPackageDir(workdir)).toThrow(/not valid UTF-8/);
  });

  it("rejects a manifest with a leading UTF-8 BOM (kept, then JSON.parse rejects — parity)", () => {
    // EF BB BF (BOM) + valid JSON. The kernel keeps the BOM and json.loads rejects it;
    // Node must not silently strip it and accept.
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(manifestJson())]);
    writeFileSync(path.join(workdir, MANIFEST_NAME), withBom);
    expect(() => loadPluginPackageDir(workdir)).toThrow(PackageVerificationError);
  });

  it("returns the parsed manifest plus the enumerated files", () => {
    writeFileSync(path.join(workdir, MANIFEST_NAME), manifestJson());
    writeFileSync(path.join(workdir, "entry.py"), "print(1)\n");
    const loaded = loadPluginPackageDir(workdir);
    expect((loaded.manifest as Record<string, unknown>).id).toBe("dev.x.tool");
    expect(loaded.files.map((f) => f.relative).sort()).toEqual(["entry.py", MANIFEST_NAME]);
  });
});

describe("load + verify end-to-end (kernel-asserted fixture written to disk)", () => {
  interface VerifyVector {
    name: string;
    manifest: Record<string, unknown>;
    files: Array<{ relative: string; mode_signal: number; content_b64: string }>;
    root_env: string | null;
    result?: { plugin_id: string; digest: string; signer_class: string };
  }
  const golden = JSON.parse(
    readFileSync(new URL("./fixtures/trust-golden-vectors.json", import.meta.url), "utf-8"),
  ) as { verify_package: VerifyVector[] };

  it("loads a real directory package off disk and verifies it like the kernel", () => {
    const vec = golden.verify_package.find((v) => v.name === "valid_root_signed")!;
    for (const f of vec.files) {
      const dest = path.join(workdir, f.relative);
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, Buffer.from(f.content_b64, "base64"));
      if (f.mode_signal & 0b0001) chmodSync(dest, 0o755);
    }
    if (vec.root_env) process.env[ROOT_ENV] = vec.root_env;

    const loaded = loadPluginPackageDir(workdir);
    const out = verifyPluginPackage(loaded, { provenance: "remote", rejectSkillOrigin: true });
    expect(out.pluginId).toBe(vec.result!.plugin_id);
    expect(out.digest).toBe(vec.result!.digest);
    expect(out.verdict.signerClass).toBe(vec.result!.signer_class);
  });
});
