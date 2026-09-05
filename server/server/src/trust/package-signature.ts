/**
 * Trust primitives — plugin package signature trust + revocation (slice 6).
 *
 * Node port of the SuperClaw kernel signature/revocation half of
 * `PackageTrustVerifier` (trust.py), parameterised for the plugin asset
 * (root key env SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY, local-dev env
 * SUPERCLAW_PLUGIN_LOCAL_DEV_TRUST, revocation id field plugin_id). The package
 * Ed25519 signature is over the DIGEST STRING (`sha256:<hex>` as UTF-8), not over a
 * JCS envelope — so this is distinct from the cosign/envelope path (slices 2-3).
 *
 * Verified against golden vectors generated from the kernel.
 */

import { createPublicKey, verify as cryptoVerify } from "node:crypto";

import { officialRootPublicKey } from "../superclaw-environment.js";

export class PackageVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PackageVerificationError";
  }
}

const ROOT_KEY_ENV = "SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY";
const LOCAL_DEV_ENV = "SUPERCLAW_PLUGIN_LOCAL_DEV_TRUST";

// DER SubjectPublicKeyInfo prefix for a raw Ed25519 public key (RFC 8410).
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export type SignerClass = "root" | "local_dev" | "none";
export type SignatureTrust = "official" | "local_dev";

export interface SignatureTrustOptions {
  /** Override the root verification key (else: env > baked official key). */
  rootKey?: string | null;
  /** Per-call local-dev opt-in (e.g. a `--trust local` flag), in addition to the env. */
  allowLocalDev?: boolean;
}

/** Read an environment variable as an OWN property only — `process.env[name]` walks
 * the prototype chain, so a polluted `Object.prototype[name]` would otherwise be read
 * as a real env value (Python `os.environ.get` never sees inherited values). All
 * security-sensitive env reads in this module go through here. */
function ownEnv(name: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(process.env, name) ? process.env[name] : undefined;
}

/** Read an OWN property of an options object (guards the default `{}` against a
 * polluted Object.prototype.<key> being read as a caller-supplied option). */
function ownOption<T>(options: object, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(options, key) ? (options as Record<string, unknown>)[key] as T : undefined;
}

/** base64 decode mirroring Python `base64.b64decode(validate=True)`: reject any
 * out-of-alphabet character and a non-multiple-of-4 length, then decode. */
function decodeStrictBase64(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new PackageVerificationError("invalid base64");
  }
  return Buffer.from(value, "base64");
}

/**
 * Verify an Ed25519 package signature over the digest string. The signature MUST be
 * `ed25519:<base64>`; the public key may be bare base64 or `ed25519:`-prefixed.
 * Throws PackageVerificationError on any failure (mirrors verify_signature).
 */
export function verifyPackageSignature(digest: string, signature: string, publicKey: string): void {
  if (typeof signature !== "string" || !signature.startsWith("ed25519:")) {
    throw new PackageVerificationError("unsupported signature format");
  }
  try {
    const signatureBytes = decodeStrictBase64(signature.slice("ed25519:".length));
    const publicKeyBytes = decodeStrictBase64((publicKey ?? "").replace(/^ed25519:/, ""));
    if (publicKeyBytes.length !== 32) throw new Error("bad public key length");
    const der = Buffer.concat([ED25519_SPKI_PREFIX, publicKeyBytes]);
    const pub = createPublicKey({ key: der, format: "der", type: "spki" });
    if (!cryptoVerify(null, Buffer.from(digest, "utf-8"), pub, signatureBytes)) {
      throw new Error("signature does not verify");
    }
  } catch (err) {
    if (err instanceof PackageVerificationError && err.message !== "invalid base64") throw err;
    throw new PackageVerificationError("plugin signature invalid");
  }
}

/** Whether local-dev trust is explicitly enabled (opt-in, fail-closed default). */
export function localDevTrustEnabled(env: string = LOCAL_DEV_ENV): boolean {
  return ["1", "true", "yes", "on"].includes((ownEnv(env) ?? "").trim().toLowerCase());
}

/**
 * The root verification key. Mirrors hydrate_official_root_public_keys: the
 * per-environment baked official key defaults the root key ONLY when the env var is
 * ABSENT. An explicitly-set value is authoritative even when EMPTY — clearing the env
 * must NOT silently re-arm the baked key (that would be a trust-root bypass: the
 * operator disabled root trust but Node kept verifying against the baked key). No
 * trim: a whitespace-padded key is passed through and fails verification exactly as
 * the kernel's os.environ.get + base64 validate=True would. "" ⇒ no root key.
 */
export function pluginRootKey(): string {
  // OWN-property check (not the `in` operator, which walks the prototype chain): a
  // polluted Object.prototype must not be read as a configured root key — that would
  // let an attacker-controlled key verify a signature as official/root.
  const fromEnv = ownEnv(ROOT_KEY_ENV);
  return fromEnv !== undefined ? fromEnv : officialRootPublicKey();
}

/**
 * Verify a signature, returning the trust class that admitted it: "official" when a
 * configured/root key verifies, or "local_dev" when verification is unavailable/failed
 * but local-dev trust is explicitly enabled. Raises otherwise. Callers MUST have
 * already verified integrity (the digest). Mirrors resolve_signature_trust.
 */
export function resolveSignatureTrust(
  digest: string,
  signature: string,
  publicKey: string | null | undefined,
  options: SignatureTrustOptions = {},
): SignatureTrust {
  // OWN-property reads of options so a polluted Object.prototype.rootKey /
  // Object.prototype.allowLocalDev cannot be read off the default `{}` as a
  // caller-supplied option (that would admit an attacker key as official).
  const allowLocalDev = ownOption<boolean>(options, "allowLocalDev") ?? false;
  const rootKeyOption = ownOption<string | null>(options, "rootKey");
  const localDev = localDevTrustEnabled() || allowLocalDev;
  const key = publicKey || rootKeyOption || pluginRootKey();
  if (key) {
    try {
      verifyPackageSignature(digest, signature, key);
      return "official";
    } catch (err) {
      if (!localDev) throw err;
      return "local_dev";
    }
  }
  if (localDev) return "local_dev";
  // No verifiable key available and no local-dev: preserve the missing-key failure.
  throw new PackageVerificationError(`missing ${ROOT_KEY_ENV}`);
}

/**
 * Non-raising signer classification for the discovery / trust-state layer. Returns
 * "root" ONLY when the ROOT key (env > baked) verifies — never an arbitrary key, so a
 * third-party signature can't masquerade as root. "local_dev" when local-dev trust is
 * enabled and the root key does not verify, else "none". Mirrors classify_signer.
 */
export function classifySigner(digest: string, signature: string): SignerClass {
  const rootKey = pluginRootKey();
  if (rootKey) {
    try {
      verifyPackageSignature(digest, signature, rootKey);
      return "root";
    } catch {
      // fall through
    }
  }
  if (localDevTrustEnabled()) return "local_dev";
  return "none";
}

/** Read an OWN property only (mirrors Python dict.get — never the prototype chain). */
function own(obj: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

export interface RevocationTarget {
  artifactId: string;
  version: string;
  /** The manifest-declared package digest. */
  declaredDigest: string;
  /** The independently-recomputed digest. REQUIRED — the kernel always adds it to the
   * match set when a revocation entry pins a package_digest, so a tampered declared
   * digest cannot dodge a digest-pinned revoke. Callers (which have already computed
   * the digest for signature verification) must pass it. */
  computedDigest: string;
}

/**
 * Throw PackageVerificationError if `target` matches any entry in the revocation list.
 * An entry matches when the id equals AND (version is absent OR equals) AND
 * (package_digest is absent OR equals the declared or recomputed digest). Mirrors
 * check_revocation.
 *
 * `revocationData` is the parsed revocation JSON, or null/undefined when no revocation
 * file is present (→ no-op, like the kernel's file-not-exists early return). A PRESENT
 * but MALFORMED structure (not an object, `revoked` not an array, or a non-object
 * entry) FAILS CLOSED with a throw — mirroring the kernel, where `payload.get` /
 * `item.get` raise on such shapes rather than silently allowing the install.
 */
export function checkRevocation(
  target: RevocationTarget,
  revocationData: unknown,
  idField = "plugin_id",
): void {
  if (revocationData === null || revocationData === undefined) return; // no revocation file
  if (typeof revocationData !== "object" || Array.isArray(revocationData)) {
    throw new PackageVerificationError("malformed revocation data: expected a JSON object");
  }
  // OWN-read `revoked` so a polluted Object.prototype.revoked cannot inject entries.
  const revoked = own(revocationData as Record<string, unknown>, "revoked");
  if (revoked === undefined) return; // object without a "revoked" list → nothing revoked
  if (!Array.isArray(revoked)) {
    throw new PackageVerificationError("malformed revocation data: 'revoked' must be an array");
  }
  for (const item of revoked) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new PackageVerificationError("malformed revocation entry: expected an object");
    }
    const entry = item as Record<string, unknown>;
    const artifactId = own(entry, idField);
    const version = own(entry, "version");
    const revokedDigest = own(entry, "package_digest");

    // The kernel tests `version in {None, ...}` / `revoked_digest in {None, ...}`; an
    // array/object value is UNHASHABLE in Python → TypeError → fail closed. Mirror that:
    // a non-scalar version/package_digest in a revocation entry rejects the install
    // rather than silently failing the `===` comparison and allowing it through.
    for (const [field, value] of [
      ["version", version],
      ["package_digest", revokedDigest],
    ] as const) {
      if (Array.isArray(value) || (value !== null && typeof value === "object")) {
        throw new PackageVerificationError(`malformed revocation entry: ${field} must be a scalar`);
      }
    }

    const packageDigests = new Set<unknown>([target.declaredDigest]);
    if (revokedDigest !== null && revokedDigest !== undefined) {
      packageDigests.add(target.computedDigest);
    }
    const versionMatches = version === null || version === undefined || version === target.version;
    const digestMatches =
      revokedDigest === null || revokedDigest === undefined || packageDigests.has(revokedDigest);
    if (artifactId === target.artifactId && versionMatches && digestMatches) {
      throw new PackageVerificationError(`plugin revoked: ${target.artifactId}@${target.version}`);
    }
  }
}
