# SuperClaw Plugin Submission, Approval, And Signing Protocol

Status: production design requirement for developer-submitted plugins

This document defines the trust boundary for developer plugin intake. It
clarifies when SuperClaw may sign a plugin package, what that signature means,
and how signing connects to registry publication, entitlement, revocation, and
runtime execution.

The current local implementation in `superclaw plugin submit` proves the
machine-checkable subset of this protocol. Production SuperClaw Cloud must add
server-side artifact storage, approval records, an isolated signing service,
registry publication, entitlement policy, and revocation sync before accepting
third-party plugins as platform-trusted packages.

## Core Rule

SuperClaw must not sign a developer package until every required automated gate
and every required manual or server-side approval for that exact package digest
has passed.

A SuperClaw signature is an endorsement of exact package bytes, not a broad
approval of a developer, plugin name, future version, or mutable URL. Any byte
change, manifest change, tool schema change, pricing change, permission change,
or version update requires a new review decision and a new signature.

## What Signing Means

Signing means:

- SuperClaw reviewed the exact package digest that was signed.
- The package passed all required gates for its requested acceptance level.
- The package may be considered for registry publication or local installation
  under the policies attached to the review decision.
- Runtime can verify that cached bytes have not been repacked or modified after
  review.

Signing does not mean:

- every future version of the plugin is approved;
- the developer can upload arbitrary replacement bytes under the same version;
- entitlement, payment, revocation, sandbox, or runtime policy checks can be
  skipped;
- the package is Certified, public, paid, or promoted unless the review record
  explicitly grants those states;
- the plugin is permanently trusted after later vulnerability, abuse, license,
  or policy findings.

## Actors

- Developer: builds and submits a package.
- Submission API: accepts uploads, creates immutable submission records, and
  stores package bytes.
- Review workers: run automated checks without access to signing private keys.
- Manual reviewers: approve risk, security, commerce, license, privacy, or
  Certified/L3 requirements when policy requires human approval.
- Approval service: records the final decision against an immutable package
  digest.
- Signing service: holds the SuperClaw signing private key in an isolated secret
  store, KMS, or HSM-equivalent boundary.
- Registry service: publishes signed package metadata and download references.
- Runtime verifier: checks signature, digest, entitlement, revocation, policy,
  sandbox, configuration, and user consent before execution.

## Submission States

Recommended production states:

- `uploaded`: bytes received and stored immutably.
- `intake_validating`: basic format, manifest, digest, and developer identity
  checks are running.
- `rejected`: one or more required gates failed.
- `ready_for_manual_review`: automated checks passed, but policy requires manual
  approval before signing.
- `ready_for_signing`: all automated and required manual approvals passed for
  the exact package digest.
- `signed`: SuperClaw signature issued for the exact package digest.
- `verified`: signed artifact was re-verified by the package verifier.
- `published`: registry entry and governance metadata make the signed package
  installable for an allowed audience.
- `revoked`: registry or runtime governance blocks install or execution.
- `superseded`: a newer reviewed version replaced this version.

Local Phase 4A currently collapses parts of this lifecycle. It can return
`ready_for_signing` after automated gates pass, then fail with
`missing SuperClaw signing private key` if the local fake-cloud signer has no
private key. That failure is operational: the package reached the signing
boundary, but the environment could not issue an official signed artifact.

## End-To-End Flow

1. Upload and intake

   The server receives the package, stores immutable bytes, computes
   `package_digest`, records developer identity, and parses the manifest. The
   upload path must not have signing-key access.

2. Automated review

   Review workers run deterministic gates: manifest schema, configuration
   contract, entrypoint safety, source type, package digest stability, static
   secret scan, dependency/SBOM policy, vulnerability fixtures or scanners,
   runtime code-download denial, MCP tool schema match, acceptance-test
   permission hygiene, smoke tests, required submission docs, pricing intent,
   and secret descriptor consistency.

3. Risk classification

   The platform maps package behavior to required review levels. Higher-risk
   changes include new network/file/environment permissions, secret handling,
   L2/L3 or Certified requests, commerce or metering behavior, runtime code
   generation, binary-only payloads, SaaS callbacks, license uncertainty, and
   updates to previously published plugins.

4. Manual and server-side approval

   Required reviewers approve or reject the package digest. The approval record
   must bind:

   - `submission_id`;
   - `plugin_id`;
   - `version`;
   - `developer_id`;
   - `package_digest`;
   - requested and granted acceptance level;
   - automated gate summary;
   - manual approver identities or service principals;
   - commerce, privacy, license, and security decisions when applicable;
   - allowed audiences or listing state;
   - decision timestamp and expiry or re-review trigger when applicable.

   Approval must not be recorded only as "plugin name approved". It must bind to
   immutable package bytes.

5. Signing

   The signing service loads the immutable package from the server-side artifact
   store, recomputes the digest, checks that the approval record is
   `ready_for_signing` for that exact digest, signs the package, and records the
   signing key id and signature metadata. Review workers, upload handlers, web
   processes, and local CLIs must not hold production signing private keys.

6. Signed-artifact verification

   Before publication, the platform re-runs package verification against the
   signed artifact using the corresponding public key or trust root. A package
   that was signed but cannot verify must not be published.

7. Registry publication and allow decision

   "Receiving" or "accepting" a plugin in production means two linked decisions:
   the exact package is signed, and registry/governance state allows an audience
   to install or run it. Registry metadata should include plugin id, version,
   digest, signature, key id, review id, granted acceptance level, entitlement
   requirements, runtime policy, deprecation state, and revocation state.

8. Install and runtime checks

   Local runtime downloads only through registry metadata or opaque download
   references, verifies digest and SuperClaw signature before cache write, checks
   revocation and entitlement, validates configuration and secrets, enforces
   runtime policy and sandbox rules, and records EvidenceBundle-compatible
   invocation evidence.

9. Updates and revocation

   Every update repeats review and signing. Revocation can target a digest,
   plugin id/version, developer, key id, or policy class. Runtime must fail
   closed when revocation or entitlement sync says a package is blocked.

## Digest And Hash Plan

The package digest is the primary join key between upload, review, approval,
signing, registry metadata, install, cache, and runtime execution. The minimum
format is `sha256:<64 lowercase hex characters>`.

Current local code already computes a package digest through
`compute_package_digest()` and records the `package_digest_stable` gate. Future
server work should preserve that contract unless a migration plan introduces a
new digest version.

Required digest points:

- Upload: compute `uploaded_package_digest` from immutable uploaded bytes before
  any review worker runs.
- Unpack/normalize: compute the canonical package digest used by the verifier.
  The manifest field `provenance.package_digest` is treated as blank while the
  digest is computed, so the digest can be embedded back into the manifest
  without changing itself.
- Review: every automated gate result references the canonical digest it
  inspected.
- Approval: approval records must bind to the canonical digest, not only
  `plugin_id` and `version`.
- Signing: the signing service recomputes the canonical digest from stored
  package bytes and signs only when it exactly matches the approved digest.
- Registry: registry version metadata publishes the approved digest, signature,
  signing key id, review id, and artifact reference.
- Install/cache: runtime verifies downloaded bytes against registry digest and
  signature before writing or trusting the local cache.
- Invocation: runtime records the package digest in invocation evidence and uses
  it for entitlement, revocation, and policy matching.
- Revocation: revocation entries may target an exact digest for emergency block,
  and may also target plugin id/version or developer for broader policy action.

The server should store at least two digest facts when upload storage and
canonical verification differ:

- `artifact_blob_digest`: digest of the exact uploaded blob as stored.
- `package_digest`: canonical digest of the verified package contents and
  manifest contract.

If those are different, both should be audit-visible. The approval and signing
decision must use `package_digest`; the artifact store may use
`artifact_blob_digest` for object integrity.

## Implementation Roadmap

Phase 1: local protocol hardening

- Keep `superclaw plugin submit` as a local proof of review gates.
- Keep failing with `missing SuperClaw signing private key` when no local test
  signer is available.
- Add or preserve tests that prove digest mismatch blocks signing, a missing
  key fails after gates, and signed artifacts verify with the public key.
- Keep local signing keys clearly labeled as fake-cloud or test-only.

Phase 2: server submission records

- Implement production submission records with immutable upload ids, developer
  identity, plugin id, version, `artifact_blob_digest`, and `package_digest`.
- Ensure upload handlers cannot call signing code and cannot access signing
  private keys.
- Store sanitized review status that never exposes absolute local paths,
  entitlement tokens, signing internals, or secret values.

Phase 3: automated review workers

- Move deterministic gates into worker jobs that read immutable artifacts and
  write gate results against the exact digest.
- Include manifest, configuration, dependency, vulnerability, secret,
  permission, runtime-code-download, MCP schema, acceptance-test, smoke-test,
  pricing, license, and support-contact gates.
- Make all blocking gates fail closed when evidence is missing or malformed.

Phase 4: approval workflow

- Add approval queues for manual security, commerce, license, privacy, and
  Certified/L3 review when policy requires them.
- Store approval records as immutable decisions bound to `submission_id`,
  `plugin_id`, `version`, `developer_id`, `package_digest`, gate summary,
  granted acceptance level, allowed audience, approver identity, and timestamp.
- Require re-review when bytes, permissions, tool schema, pricing, metering,
  secrets, or runtime behavior change.

Phase 5: isolated signing service

- Move the SuperClaw signing private key behind a dedicated signing service,
  KMS, or HSM-equivalent boundary.
- Require the signing service to recompute `package_digest` from stored bytes
  before signing.
- Sign only when the approval record is `ready_for_signing` for that exact
  digest.
- Record signature, signing key id, signing timestamp, and review id.
- Re-run signed-artifact verification before publication.

Phase 6: registry allow state

- Publish signed package metadata only after signed-artifact verification.
- Keep signing separate from listing state: a signed package can be private,
  unlisted, limited-audience, public, deprecated, or revoked.
- Attach entitlement requirements, runtime policy, compatibility, acceptance
  level, deprecation state, and revocation state to registry metadata.

Phase 7: runtime enforcement

- Verify registry digest and SuperClaw signature before cache write and before
  execution.
- Check entitlement, revocation, configuration, secret descriptors, permission
  policy, sandbox policy, and user consent after signature verification.
- Record `package_digest`, review id, entitlement id, policy id, sandbox
  verdict, and invocation status into evidence.

Phase 8: updates, revocation, and key rotation

- Treat every package update as a new submission and new digest.
- Support digest-level emergency revocation.
- Support plugin id/version, developer, and signing-key revocation for broader
  incidents.
- Publish trust-root/key-rotation metadata so older packages can remain
  verifiable or be intentionally sunset.
- Keep audit logs for upload, review, approval, signing, publication,
  entitlement sync, revocation, install, and runtime denial decisions.

## Local CLI Mapping

`superclaw plugin submit <package>` currently models the local/fake-cloud review
path:

- it runs automated developer-upload gates;
- it requires `--signing-private-key` or
  `SUPERCLAW_PLUGIN_SIGNING_PRIVATE_KEY` before it can issue a signed package;
- it signs only after review reaches `ready_for_signing`;
- it returns failure when the key is missing, even if the package passed all
  protocol gates up to the signing boundary;
- it writes a local signed artifact and public key metadata for test
  verification when signing succeeds.

That local key is a test or fake-cloud input. It must not be treated as a
production SuperClaw root key. Production signing must be isolated behind a
server-side approval check and auditable signing service.

Developer or local `--dev-sign` package signatures, when available, are useful
for development integrity checks. They do not replace SuperClaw platform
signing and must not grant registry trust by themselves.

## Server Implementation Checklist

Minimum production requirements before accepting third-party plugins:

- Upload API stores immutable package bytes and computes stable
  `artifact_blob_digest` and `package_digest` values.
- Review workers run without signing private key access.
- Automated gates fail closed and redact paths, secrets, signing internals,
  entitlement tokens, and raw workspace content.
- Approval records bind the exact package digest to plugin id, version,
  developer id, gates, acceptance level, manual approvals, and allowed audience.
- Signing service recomputes digest before signing and rejects mismatched bytes.
- Signing private keys live only in an isolated service or KMS/HSM-equivalent
  store; they are never committed, logged, exposed to CI artifacts, or passed to
  normal review workers.
- Signed artifacts are verified before registry publication.
- Registry publication is separate from signing and carries entitlement,
  runtime policy, revocation, compatibility, and listing metadata.
- Runtime verifies signature and digest before cache write and before execution.
- Entitlement, revocation, configuration, secret, permission, and sandbox checks
  remain mandatory after signature verification.
- Updates, permission expansions, pricing/metering changes, and package byte
  changes create new review and signing decisions.
- Every signing and publication action is idempotent and audit logged.

## Practical Answer

Yes: in the production flow, server approval should be the gate that authorizes
SuperClaw to sign the package. Accepting a plugin should mean the platform has
both signed the exact reviewed artifact and written governance state that allows
the intended audience to install or execute it. Signing alone proves byte-level
platform approval; registry, entitlement, and policy state decide whether that
signed plugin is actually allowed to run.
