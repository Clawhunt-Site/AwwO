/**
 * Trust primitives — keyid derivation + Ed25519 signature-envelope verification.
 *
 * Byte-for-byte Node port of the verify side of the SuperClaw kernel cross-repo
 * contract `packages/superclaw/src/superclaw/trust_contracts.py`. SuperClaw is the
 * VERIFIER (ClawHunt signs); only verification + keyid are ported here. Uses Node's
 * built-in `crypto` Ed25519 (no third-party dependency). Verified against golden
 * vectors (see __tests__/fixtures/trust-golden-vectors.json).
 */

import { createHash, createPublicKey, verify as cryptoVerify, type KeyObject } from "node:crypto";

import { TrustContractError, jcsCanonicalize, nfcNormalize, parseTrustJson } from "./jcs.js";

const KEYTYPE_ED25519 = "ed25519";
const SCHEME_ED25519 = "ed25519";

// DER SubjectPublicKeyInfo prefix for an Ed25519 raw public key (RFC 8410): the
// 12-byte header that precedes the 32 raw key bytes.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

interface KeyEntry {
  public_key?: unknown;
  keytype?: unknown;
  scheme?: unknown;
}

/** Python dict.get(key, default) semantics: default only when the key is ABSENT. */
function getOr<T>(obj: Record<string, unknown>, key: string, fallback: T): unknown | T {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : fallback;
}

/**
 * Normalize+validate Ed25519 public material to the single canonical form
 * `ed25519:<standard base64 of 32 raw bytes>`. Rejects a missing prefix, wrong byte
 * length, and non-canonical base64 — so one physical key maps to exactly one keyid.
 */
function canonicalEd25519PublicKey(material: unknown): string {
  if (typeof material !== "string" || !material.startsWith("ed25519:")) {
    throw new TrustContractError("ed25519 public key must use the 'ed25519:' prefix");
  }
  const rawB64 = material.slice("ed25519:".length);
  const raw = Buffer.from(rawB64, "base64");
  if (raw.length !== 32) {
    throw new TrustContractError("ed25519 public key must be 32 bytes");
  }
  // Buffer.from base64 is lenient (ignores invalid chars, accepts non-canonical
  // padding); re-encode and compare to enforce canonical base64 like the kernel's
  // validate=True + b64encode roundtrip check.
  if (raw.toString("base64") !== rawB64) {
    throw new TrustContractError("ed25519 public key base64 is not canonical");
  }
  return material;
}

function ed25519PublicKey(material: string): KeyObject {
  const raw = Buffer.from(material.slice("ed25519:".length), "base64");
  const der = Buffer.concat([ED25519_SPKI_PREFIX, raw]);
  return createPublicKey({ key: der, format: "der", type: "spki" });
}

/**
 * keyid = "sha256:" + sha256( JCS({keytype, scheme, public_key}) ) — a canonical
 * JSON object hash. `public_key` is canonicalized first so aliased encodings of the
 * same physical key cannot produce different keyids.
 */
export function computeKeyid(
  publicKey: unknown,
  keytype: string = KEYTYPE_ED25519,
  scheme: string = SCHEME_ED25519,
): string {
  const canonical = canonicalEd25519PublicKey(publicKey);
  const payload = { keytype, scheme, public_key: canonical };
  return "sha256:" + createHash("sha256").update(jcsCanonicalize(payload)).digest("hex");
}

/**
 * Verify a `{signed, signatures}` envelope and return the set of keyids whose
 * Ed25519 signature over `JCS(NFC(signed))` checks out.
 *
 * Fail-closed: throws `TrustContractError` if fewer than `threshold` DISTINCT trusted
 * keyids verify. `keys` maps keyid -> {public_key, keytype?, scheme?}. Signatures
 * from unknown keyids, that do not verify, that spoof a keyid, or that declare a
 * non-Ed25519 algorithm are ignored (never counted). A keyid is counted at most once.
 */
export function verifyEnvelope(
  envelope: unknown,
  keys: Record<string, unknown>,
  options: { threshold?: number } = {},
): Set<string> {
  // Default ONLY when the option is absent (undefined). An explicit null/other value
  // is NOT defaulted — it falls into the guard below and is rejected, mirroring the
  // kernel's None rejection (no fail-open on malformed config).
  const rawThreshold = (options as { threshold?: unknown }).threshold;
  const threshold = rawThreshold === undefined ? 1 : rawThreshold;
  // Reject non-positive / non-int threshold: threshold<=0 would let an empty
  // signatures list "verify". (booleans/null are excluded — typeof catches them.)
  if (typeof threshold !== "number" || !Number.isInteger(threshold) || threshold < 1) {
    throw new TrustContractError("threshold must be a positive integer");
  }
  if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new TrustContractError("envelope must be an object");
  }
  const signed = (envelope as Record<string, unknown>).signed;
  const signatures = (envelope as Record<string, unknown>).signatures;
  if (signed === null || typeof signed !== "object" || Array.isArray(signed) || !Array.isArray(signatures)) {
    throw new TrustContractError("envelope must have object 'signed' and array 'signatures'");
  }
  // Enforce "NFC pre-normalize, then JCS" at the envelope layer so a raw-signed
  // non-normalized payload cannot bypass the NFC collision guard.
  const message = jcsCanonicalize(nfcNormalize(signed));
  const verified = new Set<string>();
  for (const sig of signatures) {
    if (sig === null || typeof sig !== "object" || Array.isArray(sig)) continue;
    const keyid = (sig as Record<string, unknown>).keyid;
    const rawSig = (sig as Record<string, unknown>).sig;
    if (typeof keyid !== "string" || typeof rawSig !== "string" || verified.has(keyid)) continue;
    if (!Object.prototype.hasOwnProperty.call(keys, keyid)) continue;
    const key = keys[keyid];
    if (key === null || typeof key !== "object" || Array.isArray(key)) continue;
    const entry = key as Record<string, unknown>;
    const publicKey = entry.public_key;
    if (typeof publicKey !== "string") continue;
    // Only Ed25519 is trusted; a key explicitly declaring another keytype/scheme is
    // never fed to the verifier under a mislabel (fail-closed).
    const keytype = getOr(entry, "keytype", KEYTYPE_ED25519);
    const scheme = getOr(entry, "scheme", SCHEME_ED25519);
    if (keytype !== KEYTYPE_ED25519 || scheme !== SCHEME_ED25519) continue;
    // keyid must actually bind to the public key it claims (no keyid spoofing).
    let expected: string;
    try {
      expected = computeKeyid(publicKey, keytype, scheme);
    } catch {
      continue; // non-canonical public key in the keyset — fail-closed, skip it
    }
    if (keyid !== expected) continue;
    try {
      const sigB64 = rawSig.replace(/^ed25519:/, "");
      const signatureBytes = Buffer.from(sigB64, "base64");
      // Canonical-base64 only: Buffer.from is lenient (ignores whitespace/newlines,
      // tolerates bad padding and base64url), so re-encode and require an exact match.
      // This is intentionally as-strict-or-stricter than the kernel's
      // base64.b64decode(validate=True): a legitimate signer always emits canonical
      // base64, so this only rejects forms a real signature never takes — fail-closed,
      // never dropping a genuine ClawHunt signature.
      if (signatureBytes.toString("base64") !== sigB64) continue;
      if (!cryptoVerify(null, message, ed25519PublicKey(publicKey), signatureBytes)) continue;
    } catch {
      continue;
    }
    verified.add(keyid);
  }
  if (verified.size < threshold) {
    throw new TrustContractError(`envelope signature threshold not met: ${verified.size}/${threshold}`);
  }
  return verified;
}

/**
 * Verify a signature envelope supplied as raw JSON TEXT. This is the blessed
 * entrypoint for envelopes ingested off the wire (a fetched ClawHunt feed entry,
 * a downloaded package's co-signature, etc.): it parses with `parseTrustJson` so a
 * float number literal (`"n":7.0`) is rejected up front, closing the
 * `JSON.parse(7.0) → 7` parity gap where Node would otherwise verify a payload the
 * kernel rejects. Callers MUST use this — never `JSON.parse`/`response.json()` then
 * `verifyEnvelope` — for untrusted envelope text.
 */
export function verifyEnvelopeJson(
  text: string,
  keys: Record<string, unknown>,
  options: { threshold?: number } = {},
): Set<string> {
  return verifyEnvelope(parseTrustJson(text), keys, options);
}
