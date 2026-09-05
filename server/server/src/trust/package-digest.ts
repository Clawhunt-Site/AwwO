/**
 * Trust primitives — canonical plugin-package digest (slice 5).
 *
 * Node port of the SuperClaw kernel package digest
 * (packages/superclaw/src/superclaw/trust.py `PackageTrustVerifier.compute_digest` +
 * `canonical_manifest_for_digest`, parameterised in plugins.py with the plugin
 * domain). The Ed25519 package signature binds to THIS digest, so it must be
 * byte-identical across repos. This module ports the ALGORITHM as a pure function
 * over a described file set; on-disk enumeration / .scplug extraction (which file
 * paths/modes feed in) is a later slice.
 *
 * Verified against golden vectors generated from the kernel
 * (scripts/gen-trust-golden-vectors.py → fixtures/trust-golden-vectors.json).
 */

import { createHash } from "node:crypto";

import { TrustContractError, parseTrustJson } from "./jcs.js";

// plugins.py:81 — _PACKAGE_DIGEST_DOMAIN_V2 (domain separation prefix, incl. the NUL).
const PACKAGE_DIGEST_DOMAIN_V2 = Buffer.from("superclaw-pkg-digest-v2\0", "latin1");

const MANIFEST_NAME = "superclaw-plugin.json";

/**
 * Python `json.encoder.py_encode_basestring_ascii` — escape a string the way
 * `json.dumps(ensure_ascii=True)` does: ", \\, the short control escapes, \\u00xx
 * for other C0 controls, and \\uXXXX (surrogate pairs for non-BMP) for every
 * codepoint >= 0x7f. This is DISTINCT from JCS (slice 2): JCS leaves non-ASCII raw,
 * the kernel's manifest digest escapes it — so they must not be conflated.
 */
function encodeBasestringAscii(value: string): string {
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (code === 0x08) out += "\\b";
    else if (code === 0x09) out += "\\t";
    else if (code === 0x0a) out += "\\n";
    else if (code === 0x0c) out += "\\f";
    else if (code === 0x0d) out += "\\r";
    else if (code < 0x20) out += "\\u" + code.toString(16).padStart(4, "0");
    else if (code <= 0x7e) out += ch;
    else if (code <= 0xffff) out += "\\u" + code.toString(16).padStart(4, "0");
    else {
      // Non-BMP: emit the UTF-16 surrogate pair as two \uXXXX escapes (Python does too).
      const c = code - 0x10000;
      const hi = 0xd800 + (c >> 10);
      const lo = 0xdc00 + (c & 0x3ff);
      out += "\\u" + hi.toString(16).padStart(4, "0") + "\\u" + lo.toString(16).padStart(4, "0");
    }
  }
  return out + '"';
}

/** Lexicographic comparison by Unicode code point (mirrors Python string `<`),
 * unlike JS default string sort which compares by UTF-16 code unit. */
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

/**
 * Serialize a JSON value exactly like Python `json.dumps(sort_keys=True,
 * ensure_ascii=True, separators=(",", ":"))`. Object keys sort by code point (ASCII
 * manifest keys → identical to JS default sort); strings use ensure_ascii escaping;
 * output is compact. Floats are rejected (a trust manifest carries no floats; their
 * Python repr is not reproducible here — fail closed rather than diverge).
 */
export function pythonCompactJson(value: unknown): string {
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "string") return encodeBasestringAscii(value);
  if (typeof value === "number") {
    // Only safe integers: a float (1.5) or an out-of-safe-range int has no
    // reproducible Python repr here, and a JSON float TOKEN (7.0) / unsafe int would
    // already have been silently coerced by JSON.parse — manifests MUST be parsed via
    // parsePluginManifest so such tokens are rejected before reaching the digest.
    if (!Number.isSafeInteger(value)) {
      throw new TrustContractError(
        "manifest digest: only safe integers are supported (parse manifests with parsePluginManifest)",
      );
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v) => pythonCompactJson(v)).join(",") + "]";
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    // Python sort_keys orders by code point; sort the same way (JS default sort is
    // UTF-16 code-unit order, which diverges on non-BMP keys).
    const keys = Object.keys(obj).sort(codePointCompare);
    return "{" + keys.map((k) => encodeBasestringAscii(k) + ":" + pythonCompactJson(obj[k])).join(",") + "}";
  }
  throw new TrustContractError(`manifest digest: unsupported type ${typeof value}`);
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Parse a plugin manifest from untrusted JSON text at the trust boundary. Uses
 * `parseTrustJson` so a JSON FLOAT LITERAL (e.g. `"length":4096.0` or `7.0`) is
 * rejected up front rather than silently collapsed to an int by JSON.parse — which
 * would otherwise let the Node digest diverge from the kernel (whose json.loads keeps
 * the float and rejects it). Callers reading a manifest off a package MUST use this,
 * never plain JSON.parse.
 */
export function parsePluginManifest(text: string): Record<string, unknown> {
  const parsed = parseTrustJson(text);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TrustContractError("plugin manifest must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/**
 * Canonical manifest bytes for the digest: a deep clone with
 * `provenance.package_digest` and `provenance.signature` zeroed (so the digest is
 * over content, not over its own hash/signature), serialized with `pythonCompactJson`.
 */
export function canonicalManifestForDigest(manifest: Record<string, unknown>): Buffer {
  const cloned = deepClone(manifest);
  const provenance = cloned.provenance;
  if (provenance === null || typeof provenance !== "object" || Array.isArray(provenance)) {
    throw new TrustContractError("manifest digest: manifest.provenance must be an object");
  }
  (provenance as Record<string, unknown>).package_digest = "";
  (provenance as Record<string, unknown>).signature = "";
  return Buffer.from(pythonCompactJson(cloned), "utf-8");
}

function lengthPrefixed(payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeBigUInt64BE(BigInt(payload.length));
  return Buffer.concat([header, payload]);
}

/** A package file for the digest: its NFC posix path, 4-bit mode signal, and raw
 * bytes (ignored for the manifest file, whose payload is the canonical manifest). */
export interface PackageDigestFile {
  relative: string;
  modeSignal: number;
  content: Uint8Array;
}

/**
 * Compute the canonical `sha256:<hex>` package digest over a described file set +
 * manifest. Mirrors `PackageTrustVerifier.compute_digest`: domain prefix, then a
 * length-prefixed entry count, then per-entry (sorted by path) the length-prefixed
 * posix path, the 1-byte mode signal, and the length-prefixed content — with the
 * manifest file's content replaced by the canonical manifest bytes. Fail-closed on a
 * non-NFC path or a case-insensitive path collision.
 */
export function computePackageDigest(
  files: PackageDigestFile[],
  manifest: Record<string, unknown>,
  manifestName: string = MANIFEST_NAME,
): string {
  const seenCasefold = new Map<string, string>();
  const entries: PackageDigestFile[] = [];
  for (const file of files) {
    const relative = file.relative;
    for (const part of relative.split("/")) {
      if (part.normalize("NFC") !== part) {
        throw new TrustContractError(`plugin package file name is not Unicode-NFC-normalized: ${relative}`);
      }
      // ASCII-only path components: this makes the case-insensitive collision fold
      // EXACT (ASCII toLowerCase == Python str.casefold), closing the ß↔ss class of
      // Node-misses-a-collision gaps without porting the full Unicode CaseFolding
      // table. The kernel permits non-ASCII NFC paths; requiring ASCII here is a
      // deliberate, fail-closed narrowing (plugin package file names are ASCII by
      // convention) pending a full-casefold port (backlog).
      for (const ch of part) {
        if (ch.codePointAt(0)! > 0x7f) {
          throw new TrustContractError(
            `plugin package file name must be ASCII (non-ASCII filenames are not yet supported): ${relative}`,
          );
        }
      }
    }
    const folded = relative.toLowerCase(); // exact for ASCII (== Python casefold)
    const prior = seenCasefold.get(folded);
    if (prior !== undefined) {
      throw new TrustContractError(
        `plugin package contains colliding file paths (case-insensitive): ${prior} vs ${relative}`,
      );
    }
    seenCasefold.set(folded, relative);
    entries.push(file);
  }

  entries.sort((a, b) => codePointCompare(a.relative, b.relative));

  const hash = createHash("sha256");
  hash.update(PACKAGE_DIGEST_DOMAIN_V2);
  hash.update(lengthPrefixed(Buffer.from(String(entries.length), "utf-8")));
  for (const entry of entries) {
    if (!Number.isInteger(entry.modeSignal) || entry.modeSignal < 0 || entry.modeSignal > 15) {
      throw new TrustContractError(`plugin package file mode signal must be an integer in 0..15: ${entry.modeSignal}`);
    }
    hash.update(lengthPrefixed(Buffer.from(entry.relative, "utf-8")));
    hash.update(Buffer.from([entry.modeSignal]));
    const payload =
      entry.relative === manifestName
        ? canonicalManifestForDigest(manifest)
        : Buffer.from(entry.content);
    hash.update(lengthPrefixed(payload));
  }
  return `sha256:${hash.digest("hex")}`;
}
