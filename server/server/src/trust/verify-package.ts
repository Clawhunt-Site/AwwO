/**
 * Trust primitives — plugin package verification orchestration (slice 8).
 *
 * Node port of the SuperClaw kernel `verify_plugin_package` (plugins.py), composing
 * the already-ported primitives into the install-time security decision:
 *   digest match (package-digest) → signature admission + revocation (package-signature)
 *   → external_mcp curated-only gate → skill-origin red line → trust verdict.
 *
 * Per the owner's parity-altitude decision (docs §3.6), the NON-trust-critical manifest
 * configuration-contract validation is NOT performed here — it rides Paperclip's native
 * plugin loading. This orchestration enforces only the TRUST-CRITICAL gates, which stay
 * golden-parity with the kernel. The cache write + provenance record (I/O) are the
 * install-endpoint's job; this is the pure verification decision.
 */

import { computePackageDigest, type PackageDigestFile } from "./package-digest.js";
import {
  PackageVerificationError,
  checkRevocation,
  classifySigner,
  resolveSignatureTrust,
  type SignerClass,
} from "./package-signature.js";

function own(obj: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
/**
 * A required STRING manifest identity field. The kernel reads `str(manifest[key])`, but
 * JS `String(x)` ≠ Python `str(x)` for non-strings (`String([])` is `""` vs Python's
 * `"[]"`), which would diverge against the identity/revocation comparisons. A legit
 * SIGNED manifest always carries string identity, so a non-string value here is
 * malformed and fails closed (stricter than the kernel's coercion, the safe direction).
 */
function requireString(obj: Record<string, unknown>, key: string, label: string): string {
  const value = own(obj, key);
  if (value === undefined) throw new PackageVerificationError(`plugin manifest missing ${label}`);
  if (typeof value !== "string") throw new PackageVerificationError(`plugin manifest ${label} must be a string`);
  return value;
}

/** Single source of truth for skill-origin classification (mirrors is_skill_origin_plugin):
 * the signed `skill_origin: true` field OR a reserved `skill.` id prefix. */
export function isSkillOriginPlugin(pluginId: string, skillOrigin: unknown): boolean {
  return skillOrigin === true || String(pluginId).startsWith("skill.");
}

export interface LoadedPackage {
  /** The parsed manifest (MUST be obtained via parsePluginManifest at the trust boundary). */
  manifest: Record<string, unknown>;
  /** The package file set (NFC posix path + mode signal + bytes) for the digest. */
  files: PackageDigestFile[];
}

export interface VerifyPackageOptions {
  /** Explicit verification key; else the configured/baked root key. */
  publicKey?: string | null;
  /** Parsed revocation data (or null when no revocation file). */
  revocationData?: unknown;
  /** Where the package came from. "local" + a skill_origin manifest admits sign-free. */
  provenance?: "local" | "remote" | null;
  /** REMOTE install sinks pass true: a skill-origin package fails closed (red line). */
  rejectSkillOrigin?: boolean;
  manifestName?: string;
}

export interface VerifyPackageResult {
  pluginId: string;
  version: string;
  digest: string;
  verdict: { signerClass: SignerClass; integrityOk: true };
}

/**
 * Verify (the security decision only) a loaded plugin package. Throws
 * PackageVerificationError on any gate failure; returns the identity + trust verdict
 * on success.
 */
export function verifyPluginPackage(pkg: LoadedPackage, options: VerifyPackageOptions = {}): VerifyPackageResult {
  const manifest = pkg.manifest;
  if (!isObject(manifest)) throw new PackageVerificationError("plugin manifest must be an object");

  const pluginId = requireString(manifest, "id", "id");
  const version = requireString(manifest, "version", "version");
  const provenanceObj = own(manifest, "provenance");
  if (!isObject(provenanceObj)) throw new PackageVerificationError("plugin manifest missing provenance");
  const declaredDigest = requireString(provenanceObj, "package_digest", "provenance.package_digest");
  const signature = requireString(provenanceObj, "signature", "provenance.signature");
  const skillOrigin = own(manifest, "skill_origin");
  const runtime = own(manifest, "runtime");
  const runtimeType = isObject(runtime) ? own(runtime, "type") : undefined;

  // Integrity: the recomputed digest must equal the declared one.
  const digest = computePackageDigest(pkg.files, manifest, options.manifestName);
  if (declaredDigest !== digest) {
    throw new PackageVerificationError(`package digest mismatch: declared ${declaredDigest}, computed ${digest}`);
  }

  // NOTE: validate_manifest_configuration_contract is intentionally NOT called here —
  // non-trust-critical manifest config hygiene rides Paperclip's native plugin loading
  // (owner parity-altitude decision, docs §3.6).

  // Sign-free LOCAL skill admission: a skill-origin package installed through a LOCAL
  // entry is the user's own responsibility and is admitted on integrity alone (no
  // signature). A remote package never carries provenance="local", so it cannot reach
  // this branch; the runtime gate still grades it `local` by its provenance stamp.
  const signFreeLocalSkill = options.provenance === "local" && skillOrigin === true;
  if (!signFreeLocalSkill) {
    // Admission gate: throws if the signature is not verifiable under the key/local-dev policy.
    resolveSignatureTrust(digest, signature, options.publicKey ?? null);
  }

  checkRevocation(
    { artifactId: pluginId, version, declaredDigest, computedDigest: digest },
    options.revocationData ?? null,
  );

  // The kernel reads `manifest.get("runtime", {}).get("type")`: a PRESENT but non-dict
  // `runtime` (e.g. a string / null / list) has no `.get` → AttributeError → fail closed.
  // Mirror that — otherwise a malformed `runtime` would silently skip the external_mcp
  // gate (Node-accepts / Python-rejects). An ABSENT runtime is fine (kernel default {}).
  if (runtime !== undefined && !isObject(runtime)) {
    throw new PackageVerificationError("plugin manifest runtime must be an object");
  }

  // external_mcp is a CURATED-ONLY runtime: enforce a ROOT signer at verify/install
  // (the same rule the runtime gate applies), so a non-root external_mcp can never be
  // minted as "installed". Fail closed on any non-root signer regardless of an explicit key.
  if (runtimeType === "external_mcp" && classifySigner(digest, signature) !== "root") {
    throw new PackageVerificationError("external_mcp plugins must be product root-signed (curated-only)");
  }

  // Capability-workshop red line: a skill is equipped through the Skills surface, NEVER
  // side-loaded through the plugin-install pipeline. REMOTE sinks pass rejectSkillOrigin.
  if (options.rejectSkillOrigin && isSkillOriginPlugin(pluginId, skillOrigin)) {
    throw new PackageVerificationError(
      `${pluginId}@${version} is a skill capability (skill_origin manifest field or reserved skill. id); ` +
        "skills are equipped through the Skills surface, never installed via the plugin pipeline",
    );
  }

  // The verdict's signer_class is ROOT-ONLY via classifySigner — admission via an
  // explicit caller key means "signature verifiable", NOT root trust.
  return {
    pluginId,
    version,
    digest,
    verdict: { signerClass: classifySigner(digest, signature), integrityOk: true },
  };
}
