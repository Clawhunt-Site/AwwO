/**
 * Trust primitives — capability OFFICIAL co-signature verification.
 *
 * Byte-for-byte Node port of the SuperClaw kernel
 * `packages/superclaw/src/superclaw/capability_cosign.py` (+ `capability_signed_core`
 * from `trust_contracts.py`). ClawHunt re-signs a reviewed capability at publish time
 * with the PRODUCT official key over `capabilitySignedCore(...)`; super bakes that
 * key's PUBLIC half per environment and independently re-verifies here.
 *
 * `verifyOfficialCosignature` is the SINGLE place that decides whether a published
 * feed entry is genuinely endorsed by THE baked official key — by rebuilding the
 * signed core and verifying the Ed25519 signature, never by trusting a self-reported
 * "verified" flag in the (untrusted, possibly MITM'd) public feed. Fail-closed
 * everywhere: missing trust root, bad signature shape, wrong signer keyid, malformed
 * core, or a non-verifying signature all return false. A surface may light an
 * "officially endorsed" badge ONLY when this returns true. Verified against golden
 * vectors generated from the kernel (see __tests__/fixtures/trust-golden-vectors.json).
 */

import { computeKeyid, verifyEnvelope } from "./envelope.js";
import { TrustContractError, jcsCanonicalize } from "./jcs.js";

const KEYTYPE_ED25519 = "ed25519";
const SCHEME_ED25519 = "ed25519";

// sha256:<64 lowercase hex> — the digest shape bound by the signed core.
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;

export interface CapabilitySignedCoreInput {
  kind: string;
  capabilityId: string;
  version: string;
  packageDigest: string;
  artifactRef: string;
  blobDigest?: string | null;
  length?: number | null;
}

/**
 * The canonical trust-relevant identity a capability submission is signed over.
 * Required identity fields are always present; optional fields (blob_digest/length)
 * are OMITTED, not null, when absent so the core stays minimal and deterministic on
 * both repos. Fail-closed on malformed input.
 */
export function capabilitySignedCore(input: CapabilitySignedCoreInput): Record<string, unknown> {
  const { kind } = input;
  if (typeof kind !== "string" || !kind) {
    throw new TrustContractError("signed core requires a non-empty kind");
  }
  const capabilityId = String(input.capabilityId).trim();
  const version = String(input.version).trim();
  const artifactRef = String(input.artifactRef).trim();
  if (!capabilityId || !version || !artifactRef) {
    throw new TrustContractError("signed core requires capability_id, version and artifact_ref");
  }
  const packageDigest = input.packageDigest;
  if (!SHA256_RE.test(String(packageDigest || ""))) {
    throw new TrustContractError("package_digest must be sha256:<hex>");
  }
  const core: Record<string, unknown> = {
    kind,
    capability_id: capabilityId,
    version,
    package_digest: packageDigest,
    artifact_ref: artifactRef,
  };
  const blobDigest = input.blobDigest;
  if (blobDigest !== undefined && blobDigest !== null) {
    if (!SHA256_RE.test(String(blobDigest))) {
      throw new TrustContractError("blob_digest must be sha256:<hex>");
    }
    core.blob_digest = blobDigest;
  }
  const length = input.length;
  if (length !== undefined && length !== null) {
    if (typeof length !== "number" || !Number.isInteger(length) || length < 0) {
      throw new TrustContractError("length must be a non-negative integer");
    }
    core.length = length;
  }
  return core;
}

/**
 * Normalize a baked public key to the `ed25519:<base64>` material form the trust
 * primitives require. Baked official keys are bare base64; prefix when needed.
 */
function ed25519Material(publicKey: string | null | undefined): string {
  const pk = (publicKey ?? "").trim();
  if (!pk) return "";
  return pk.startsWith("ed25519:") ? pk : `ed25519:${pk}`;
}

/** Strict signature shape: `ed25519:<canonical base64 of exactly 64 bytes>`. */
function isCanonicalEd25519Signature(sig: unknown): boolean {
  if (typeof sig !== "string" || !sig.startsWith("ed25519:")) return false;
  const rawB64 = sig.slice("ed25519:".length);
  const raw = Buffer.from(rawB64, "base64");
  if (raw.length !== 64) return false;
  // Canonical base64 only (Buffer.from is lenient) — matches the kernel's
  // base64.b64decode(validate=True) + b64encode roundtrip check.
  return raw.toString("base64") === rawB64;
}

/** Return `value` only if it is a non-empty (post-strip) string, else null. */
function nonemptyStr(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * Read an OWN property only — never the prototype chain. Mirrors Python `dict.get`,
 * which sees only own keys: a feed entry with zero own fields but a poisoned
 * prototype (`Object.create(validEntry)`) must NOT inherit a valid signature/core
 * (Node-accepts/Python-rejects parity gap), and the "no plugin_id fallback" boundary
 * must not be relaxed by an inherited `capability_id`.
 */
function own(obj: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

/**
 * Return true iff `entry` carries an official co-signature that verifies against
 * `officialPublicKey` AND was produced by that exact key's keyid. `entry` is a
 * published-capability dict (`/v1/capabilities/published` shape) exposing the
 * trust-relevant identity plus `official_signature` and `official_signer_keyid`.
 */
export function verifyOfficialCosignature(
  entry: Record<string, unknown>,
  officialPublicKey: string | null | undefined,
): boolean {
  // Fail-closed on a non-object entry (Python's caller filters to dicts; we guard so a
  // null/array/primitive can never reach the own-property reads below).
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false;
  const material = ed25519Material(officialPublicKey);
  if (!material) return false; // no trust root baked (e.g. production pre-bake) → fail closed

  const signature = own(entry, "official_signature");
  const claimedKeyid = own(entry, "official_signer_keyid");
  if (!isCanonicalEd25519Signature(signature) || typeof claimedKeyid !== "string") {
    return false;
  }

  let expectedKeyid: string;
  try {
    expectedKeyid = computeKeyid(material);
  } catch {
    return false;
  }
  // The co-signer MUST be our baked official key — not merely "some" valid signer.
  if (claimedKeyid !== expectedKeyid) return false;

  // Type-check every signed-core field BEFORE building the core, so a malformed
  // untrusted-feed entry can never alias a real signed core (no str(None) coercion).
  const kind = nonemptyStr(own(entry, "kind"));
  // No plugin_id fallback at the verification boundary: the kernel signs over
  // capability_id specifically.
  const capabilityId = nonemptyStr(own(entry, "capability_id"));
  const version = nonemptyStr(own(entry, "version"));
  const packageDigest = nonemptyStr(own(entry, "package_digest"));
  const artifactRef = nonemptyStr(own(entry, "artifact_ref"));
  if (!kind || !capabilityId || !version || !packageDigest || !artifactRef) return false;

  const blobDigest = own(entry, "blob_digest");
  if (blobDigest !== undefined && blobDigest !== null && typeof blobDigest !== "string") return false;
  const length = own(entry, "length");
  if (length !== undefined && length !== null && (typeof length !== "number" || !Number.isInteger(length))) {
    return false;
  }

  let core: Record<string, unknown>;
  try {
    core = capabilitySignedCore({
      kind,
      capabilityId,
      version,
      packageDigest,
      artifactRef,
      blobDigest: blobDigest as string | null | undefined,
      length: length as number | null | undefined,
    });
  } catch {
    return false;
  }

  const envelope = { signed: core, signatures: [{ keyid: expectedKeyid, sig: signature }] };
  const keys = {
    [expectedKeyid]: { public_key: material, keytype: KEYTYPE_ED25519, scheme: SCHEME_ED25519 },
  };
  try {
    const verified = verifyEnvelope(envelope, keys, { threshold: 1 });
    return verified.has(expectedKeyid);
  } catch {
    return false;
  }
}

// Re-export so callers needing the canonical-bytes helper (e.g. tests, future
// install-time digest binding) do not reach past the trust module boundary.
export { jcsCanonicalize };
