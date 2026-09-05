import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { TrustContractError } from "../trust/jcs.js";
import {
  canonicalManifestForDigest,
  computePackageDigest,
  parsePluginManifest,
  pythonCompactJson,
  type PackageDigestFile,
} from "../trust/package-digest.js";

interface PackageDigestVector {
  manifest_name: string;
  manifest: Record<string, unknown>;
  files: Array<{ relative: string; mode_signal: number; content_b64: string }>;
  expected_digest: string;
}

const golden = JSON.parse(
  readFileSync(new URL("./fixtures/trust-golden-vectors.json", import.meta.url), "utf-8"),
) as { package_digest: PackageDigestVector };

const vec = golden.package_digest;

const toFiles = (v: PackageDigestVector): PackageDigestFile[] =>
  v.files.map((f) => ({
    relative: f.relative,
    modeSignal: f.mode_signal,
    content: Buffer.from(f.content_b64, "base64"),
  }));

describe("computePackageDigest — byte-exact parity with PackageTrustVerifier.compute_digest", () => {
  it("matches the kernel digest over a real directory package", () => {
    expect(computePackageDigest(toFiles(vec), vec.manifest, vec.manifest_name)).toBe(vec.expected_digest);
  });

  it("is order-independent in the input (entries are sorted by path)", () => {
    const reversed = [...toFiles(vec)].reverse();
    expect(computePackageDigest(reversed, vec.manifest, vec.manifest_name)).toBe(vec.expected_digest);
  });

  it("changes if a non-manifest file's bytes change (content is bound)", () => {
    const files = toFiles(vec);
    const nonManifest = files.find((f) => f.relative !== vec.manifest_name)!;
    nonManifest.content = Buffer.from([...nonManifest.content, 0x21]);
    expect(computePackageDigest(files, vec.manifest, vec.manifest_name)).not.toBe(vec.expected_digest);
  });

  it("changes if a file's mode signal changes (exec/setuid bits are bound)", () => {
    const files = toFiles(vec);
    files[0] = { ...files[0], modeSignal: files[0].modeSignal ^ 0b0001 };
    expect(computePackageDigest(files, vec.manifest, vec.manifest_name)).not.toBe(vec.expected_digest);
  });

  it("ignores provenance.package_digest / signature in the manifest (zeroed before hashing)", () => {
    const manifest = JSON.parse(JSON.stringify(vec.manifest)) as Record<string, unknown>;
    (manifest.provenance as Record<string, unknown>).package_digest = "sha256:" + "ff".repeat(32);
    (manifest.provenance as Record<string, unknown>).signature = "ed25519:different";
    expect(computePackageDigest(toFiles(vec), manifest, vec.manifest_name)).toBe(vec.expected_digest);
  });

  it("rejects a non-NFC file path (fail-closed)", () => {
    const files = toFiles(vec);
    files.push({ relative: "é.txt", modeSignal: 0, content: Buffer.from("x") }); // decomposed é
    expect(() => computePackageDigest(files, vec.manifest, vec.manifest_name)).toThrow(TrustContractError);
  });

  it("rejects a case-insensitive path collision (fail-closed)", () => {
    const files = toFiles(vec);
    files.push({ relative: "DATA.TXT", modeSignal: 0, content: Buffer.from("x") }); // collides with data.txt
    expect(() => computePackageDigest(files, vec.manifest, vec.manifest_name)).toThrow(TrustContractError);
  });

  it("rejects non-ASCII file names (closes the ß↔ss casefold gap by narrowing the domain)", () => {
    for (const name of ["ß.txt", "世界.txt"]) {
      const files = toFiles(vec);
      files.push({ relative: name, modeSignal: 0, content: Buffer.from("x") });
      expect(() => computePackageDigest(files, vec.manifest, vec.manifest_name), name).toThrow(TrustContractError);
    }
  });

  it("rejects an out-of-range / non-integer mode signal (fail-closed, not masked)", () => {
    const files = toFiles(vec);
    files[0] = { ...files[0], modeSignal: 16 };
    expect(() => computePackageDigest(files, vec.manifest, vec.manifest_name)).toThrow(TrustContractError);
    files[0] = { ...files[0], modeSignal: 1.5 };
    expect(() => computePackageDigest(files, vec.manifest, vec.manifest_name)).toThrow(TrustContractError);
  });
});

describe("pythonCompactJson — parity with json.dumps(sort_keys, ensure_ascii, compact)", () => {
  it("sorts keys and uses compact separators", () => {
    expect(pythonCompactJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(pythonCompactJson([1, 2, 3])).toBe("[1,2,3]");
  });

  it("escapes non-ASCII (ensure_ascii) — distinct from JCS which leaves it raw", () => {
    expect(pythonCompactJson("é")).toBe('"\\u00e9"');
    expect(pythonCompactJson("世")).toBe('"\\u4e16"');
    expect(pythonCompactJson("😀")).toBe('"\\ud83d\\ude00"'); // non-BMP → surrogate pair
  });

  it("uses the short control escapes", () => {
    expect(pythonCompactJson("a\tb\n")).toBe('"a\\tb\\n"');
  });

  it("rejects non-integer and unsafe-integer numbers (fail-closed)", () => {
    expect(() => pythonCompactJson(1.5)).toThrow(TrustContractError);
    expect(() => pythonCompactJson(2 ** 53)).toThrow(TrustContractError); // beyond safe integer
  });

  it("orders keys by code point, not UTF-16 code unit (non-BMP key)", () => {
    // "a" (0x61) < "\u{1f600}" (0x1F600 code point) < "￿" (0xFFFF). In UTF-16
    // code-unit order the emoji (lead unit 0xD83D) would sort before "￿" but the
    // CODE POINT order puts "￿" first — Python sort_keys uses code point.
    const out = pythonCompactJson({ "\u{1f600}": 1, "￿": 2, a: 3 });
    expect(out.indexOf('"a"')).toBeLessThan(out.indexOf("\\uffff"));
    expect(out.indexOf("\\uffff")).toBeLessThan(out.indexOf("\\ud83d"));
  });
});

describe("parsePluginManifest — float literals rejected at the trust parse boundary", () => {
  it("parses a valid object manifest", () => {
    expect(parsePluginManifest('{"id":"x","provenance":{}}')).toEqual({ id: "x", provenance: {} });
  });

  it("rejects a float literal that JSON.parse would collapse (length:4096.0)", () => {
    expect(() => parsePluginManifest('{"provenance":{},"length":4096.0}')).toThrow(TrustContractError);
  });

  it("rejects a non-object manifest", () => {
    expect(() => parsePluginManifest("[]")).toThrow(TrustContractError);
  });
});

describe("canonicalManifestForDigest", () => {
  it("zeroes provenance.package_digest and signature, ensure_ascii-encodes the rest", () => {
    const bytes = canonicalManifestForDigest(vec.manifest);
    const text = bytes.toString("utf-8");
    expect(text).toContain('"package_digest":""');
    expect(text).toContain('"signature":""');
    expect(text).not.toContain("世界"); // raw non-ASCII must be escaped
  });

  it("throws when manifest.provenance is missing", () => {
    expect(() => canonicalManifestForDigest({ id: "x" })).toThrow(TrustContractError);
  });
});
