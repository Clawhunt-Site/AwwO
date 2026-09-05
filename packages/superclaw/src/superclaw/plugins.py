from __future__ import annotations

import hashlib
import json
import os
import shutil
import stat
import tempfile
import unicodedata
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from superclaw.environment import superclaw_home
from superclaw.plugin_config import PluginConfigurationError, validate_manifest_configuration_contract
from superclaw.trust import (
    PackageTrustVerdict,
    PackageTrustVerifier,
    SignedArtifactEnvelope,
    SignedArtifactError,
    canonical_manifest_for_digest,
)
from superclaw.trust_state import FIRST_PARTY_NAMESPACES, TrustState, derive_trust_state


MANIFEST_NAME = "superclaw-plugin.json"

# Plugin governance state is user-global, mirroring ``skill_store`` (~/.superclaw
# /skills) and the projection ledger (~/.superclaw/projections.lock). It MUST be
# global because the skill projection it feeds is global: a cwd-relative cache
# let a full ``superclaw plugin sync-skills`` run from a *different* working
# directory read an empty "installed" set and falsely reclaim (delete) the global
# skill projections of plugins installed elsewhere. The admission-gate inputs
# (cache + revocations + entitlements + policy) therefore all resolve under this
# single root so an installed plugin is gated identically regardless of cwd.
DEFAULT_PLUGIN_STATE_ROOT = superclaw_home() / "plugins"


def plugin_state_root() -> Path:
    """User-global root for plugin governance state (cache, revocations, …).

    Anchored on the single SuperClaw data root (:func:`superclaw_home`, env
    ``SUPERCLAW_HOME``) so it moves together with state/telemetry/artifacts — and
    additionally honors the plugin-specific ``SUPERCLAW_PLUGIN_STATE_ROOT`` override
    (the #351 contract). Resolved at call time so an override set after import (tests,
    API surfaces) is honored. Deliberately does NOT use the cwd-legacy fallback of
    :func:`superclaw_data_path`: a cwd-relative plugin cache is the sync-skills
    cross-cwd deletion bug #351 fixed — plugin state must always be user-global.
    """
    override = os.environ.get("SUPERCLAW_PLUGIN_STATE_ROOT")
    return Path(override).expanduser() if override else superclaw_home() / "plugins"


# Back-compat module constants (an import-time snapshot of the default root).
# Prefer the call-time resolvers (``plugin_cache_root`` / ``default_revocation_file``),
# which honor ``SUPERCLAW_PLUGIN_STATE_ROOT`` set after import.
DEFAULT_PLUGIN_CACHE = DEFAULT_PLUGIN_STATE_ROOT / "cache"
DEFAULT_REVOCATION_FILE = DEFAULT_PLUGIN_STATE_ROOT / "revocations.json"


def default_revocation_file() -> Path:
    """Call-time revocation-file default under the global plugin state root."""
    return plugin_state_root() / "revocations.json"

# Domain-separation tag baked into the package-digest byte stream. It versions
# the *algorithm* (the set of dimensions the digest covers and how they are
# framed) without changing the emitted digest *format*, which stays
# `sha256:<64 hex>` so every existing format validator (SHA256_RE in
# plugin_cloud.py, the startswith("sha256:") gate in plugin_submission.py, the
# revocation/entitlement readers, …) keeps working unchanged.
#
# v2 is the post-hardening algorithm: it folds in the executable bit and rejects
# path-normalization ambiguity (duplicate / case-colliding / non-NFC names) on
# top of the v1 "relative path + content" stream. Because the tag is hashed in,
# a digest produced by the pre-hardening (v1) algorithm can never collide with a
# v2 digest of the same bytes: an old persisted digest simply fails the
# "package digest mismatch" check (fail-closed) and the package must be
# re-signed. No real signed package is persisted across this boundary today, so
# the practical blast radius is zero.
_PACKAGE_DIGEST_DOMAIN_V2 = b"superclaw-pkg-digest-v2\0"

# Zip-bomb guards for .scplug extraction (trust-chain design §2): a plugin is
# small, so cap both the entry count and the total uncompressed bytes. The size
# cap is enforced BY STREAMING (not by trusting the declared file_size header,
# which a malicious archive can understate), so a member that lies about its size
# is aborted mid-copy.
_MAX_ARCHIVE_ENTRIES = 100_000
_MAX_ARCHIVE_UNCOMPRESSED_BYTES = 512 * 1024 * 1024  # 512 MiB
_MAX_ARCHIVE_COMPRESSED_BYTES = 256 * 1024 * 1024  # 256 MiB on-disk (pre-open guard)
# Central-directory byte cap: bounds ZipFile's fp.read(size_cd) + per-record
# ZipInfo build at open. 16 MiB comfortably holds the _MAX_ARCHIVE_ENTRIES cap
# (~46+ bytes/record) while keeping the open-time allocation bounded.
_MAX_CENTRAL_DIRECTORY_BYTES = 16 * 1024 * 1024
_ARCHIVE_COPY_CHUNK = 1024 * 1024


class PluginVerificationError(SignedArtifactError):
    """Raised when a plugin package fails the local verification contract."""


@dataclass(frozen=True)
class PluginPackage(SignedArtifactEnvelope):
    """Plugin domain model over the shared signed-artifact envelope.

    The trust/verification primitive lives in ``superclaw.trust``; this stays the
    plugin-domain type (``plugin_id`` alias + plugin install/runtime semantics).
    Envelope fields (source/root/manifest/temporary_root) and the
    version/package_digest/signature/cleanup accessors are inherited unchanged.
    """

    @property
    def plugin_id(self) -> str:
        return self.artifact_id


# Plugin-configured trust verifier: reproduces the exact pre-extraction behaviour
# (error type, message label "plugin", env vars, revocation id field).
_PLUGIN_VERIFIER = PackageTrustVerifier(
    manifest_name=MANIFEST_NAME,
    label="plugin",
    root_key_env="SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY",
    local_dev_env="SUPERCLAW_PLUGIN_LOCAL_DEV_TRUST",
    revocation_id_field="plugin_id",
    error_cls=PluginVerificationError,
    digest_domain=_PACKAGE_DIGEST_DOMAIN_V2,
)


@dataclass(frozen=True)
class PluginVerificationResult:
    plugin_id: str
    version: str
    digest: str
    cached_path: Path | None = None
    # Authoritative verification verdict (signer class + integrity), propagated so
    # the catalog / loader derive TrustState from the SAME result rather than
    # re-classifying via a second path (方向二 B2). None only for legacy callers.
    verdict: PackageTrustVerdict | None = None


def plugin_cache_root(path: Path | None = None) -> Path:
    configured = os.environ.get("SUPERCLAW_PLUGIN_CACHE_PATH")
    if configured:
        return Path(configured)
    if path is not None:
        return path
    # Call-time so ``SUPERCLAW_PLUGIN_STATE_ROOT`` set after import is honored.
    return plugin_state_root() / "cache"


def _central_directory_byte_size(handle: Any) -> int:
    """The central-directory byte size that ``ZipFile`` will ``fp.read()`` and then
    walk (``while total < size_cd``) building one ``ZipInfo`` per record.

    This — NOT the EOCD-declared entry count — is the real open-time OOM driver:
    CPython ignores the declared count for the parse loop, so a carrier with a tiny
    declared count but a huge central directory still allocates a huge buffer + many
    ZipInfo at ``ZipFile.__init__`` (adversarial review). We reuse CPython's own
    ``_EndRecData`` (the exact function ``ZipFile`` uses) so ZIP64 / EOCD-comment
    location matches what ``ZipFile`` will do, and it parses only the end record
    (no ZipInfo construction). Fail-closed on a missing / unparseable EOCD.
    """
    # Operates on an already-open binary handle (caller owns it) so the size check
    # and the later ZipFile use the SAME fd — no stat→open TOCTOU window.
    try:
        endrec = zipfile._EndRecData(handle)
        if not endrec:
            raise PluginVerificationError("plugin archive is missing a valid end-of-central-directory record")
        size_cd = endrec[zipfile._ECD_SIZE]
    except PluginVerificationError:
        raise
    except Exception as exc:  # malformed archive / private-API drift → fail closed, normalized
        raise PluginVerificationError("plugin archive end record could not be parsed") from exc
    if not isinstance(size_cd, int) or size_cd < 0:
        raise PluginVerificationError("plugin archive has an invalid central-directory size")
    return size_cd


def load_plugin_package(path: Path) -> PluginPackage:
    """Load a plugin package, fail-closed. NEVER raises a raw exception: any failure
    (malformed archive, OS/FS error, corrupt manifest JSON, …) is normalized to
    PluginVerificationError so callers have a single error contract (adversarial
    review)."""
    try:
        return _load_plugin_package(path)
    except PluginVerificationError:
        raise
    except Exception as exc:
        raise PluginVerificationError(
            f"plugin package could not be loaded ({type(exc).__name__})"
        ) from exc


def _load_plugin_package(path: Path) -> PluginPackage:
    source = path.resolve()
    if source.is_dir():
        manifest_path = source / MANIFEST_NAME
        if not manifest_path.exists():
            raise PluginVerificationError(f"missing {MANIFEST_NAME}")
        return PluginPackage(source=source, root=source, manifest=_read_json(manifest_path))
    if source.is_file() and source.suffix == ".scplug":
        # Open the archive ONCE and run every pre-open guard + the open on the SAME
        # fd, so a concurrent on-path replacement can't TOCTOU-bypass the size caps
        # (the bytes we measured are the bytes we extract). zip-bomb guards, in
        # order of cost: physical file size → central-directory byte size (the real
        # ZipFile.__init__ allocation driver) → (post-open) entry count + streaming
        # uncompressed budget in _safe_extract_plugin_archive.
        with source.open("rb") as handle:
            compressed_size = os.fstat(handle.fileno()).st_size
            if compressed_size > _MAX_ARCHIVE_COMPRESSED_BYTES:
                raise PluginVerificationError(
                    f"plugin archive file is too large ({compressed_size} > "
                    f"{_MAX_ARCHIVE_COMPRESSED_BYTES} bytes)"
                )
            cd_size = _central_directory_byte_size(handle)
            if cd_size > _MAX_CENTRAL_DIRECTORY_BYTES:
                raise PluginVerificationError(
                    f"plugin archive central directory is too large ({cd_size} > "
                    f"{_MAX_CENTRAL_DIRECTORY_BYTES} bytes)"
                )
            handle.seek(0)
            temporary_root = Path(tempfile.mkdtemp(prefix="superclaw-plugin-"))
            try:
                with zipfile.ZipFile(handle) as archive:
                    _safe_extract_plugin_archive(archive, temporary_root)
                manifest_path = temporary_root / MANIFEST_NAME
                if not manifest_path.exists():
                    raise PluginVerificationError(f"missing {MANIFEST_NAME}")
                manifest = _read_json(manifest_path)
                return PluginPackage(source=source, root=temporary_root, manifest=manifest, temporary_root=temporary_root)
            except PluginVerificationError:
                shutil.rmtree(temporary_root, ignore_errors=True)
                raise
            except Exception as exc:
                # Normalize EVERY other failure (corrupt zip / decompression error /
                # malformed manifest JSON / encoding / OSError) to a fail-closed
                # PluginVerificationError — no raw exception escapes the loader
                # (adversarial review). Cleanup uses ignore_errors so a rmtree
                # failure can't mask the original cause.
                shutil.rmtree(temporary_root, ignore_errors=True)
                raise PluginVerificationError(
                    f"plugin archive could not be processed ({type(exc).__name__})"
                ) from exc
    raise PluginVerificationError(f"unsupported plugin package path: {path}")


def _digest_relative_name(file_path: Path, root: Path) -> str:
    """Return the digest key for a package file, rejecting ambiguous names.

    Each filename component must already be NFC-normalized; non-NFC names are
    rejected rather than silently folded so the on-disk bytes, the digest key and
    any later path comparison cannot disagree. (Silent normalization would let a
    decomposed and a composed spelling of the same name both be admitted while
    one of them no longer matches the file the digest claims to cover.)
    """
    relative = file_path.relative_to(root)
    for part in relative.parts:
        if unicodedata.normalize("NFC", part) != part:
            raise PluginVerificationError(
                f"plugin package file name is not Unicode-NFC-normalized: {relative.as_posix()}"
            )
    return relative.as_posix()


def compute_package_digest(package: PluginPackage) -> str:
    return _PLUGIN_VERIFIER.compute_digest(package)


def _length_prefixed(payload: bytes) -> bytes:
    """Frame a field with an explicit 8-byte big-endian length.

    Explicit length framing removes any concatenation ambiguity: no choice of
    file names or contents can produce the same byte stream as a different set of
    fields, which a bare separator byte alone cannot guarantee.
    """
    return len(payload).to_bytes(8, "big") + payload


def _mode_signal(file_path: Path) -> int:
    """Normalized, cross-platform-stable mode signal for a package file (0-15).

    Only the security-relevant, semantically-meaningful mode bits are folded in,
    NOT the raw st_mode — so the digest does not pick up umask / group-read /
    other-read noise that varies per checkout (which would make verification
    flap), while still binding every bit that changes *what the file is allowed
    to do*:

      * owner-execute (S_IXUSR): passive data file vs runnable entry point.
      * setuid (S_ISUID) / setgid (S_ISGID): a post-sign ``chmod u+s`` on a
        cached binary would otherwise be an unsigned privilege escalation.
      * sticky (S_ISVTX): completeness; cheap to bind, removes the last
        ambiguous permission bit.

    Packed into a stable 4-bit code so the result is independent of platform and
    umask. For .scplug archives the bits are those restored from the zip
    ``external_attr`` during extraction, so a tampered archive that flips any of
    them is detected here. (Note: .scplug extraction masks special bits via
    0o777 and so cannot itself carry setuid/setgid in — but directory packages
    and already-cached packages can be chmod-ed on disk, which is exactly the
    post-sign tamper this covers.)
    """
    mode = file_path.stat().st_mode
    signal = 0
    if mode & stat.S_IXUSR:
        signal |= 0b0001
    if mode & stat.S_ISUID:
        signal |= 0b0010
    if mode & stat.S_ISGID:
        signal |= 0b0100
    if mode & stat.S_ISVTX:
        signal |= 0b1000
    return signal


def verify_plugin_package(
    path: Path,
    *,
    public_key: str | None = None,
    cache_root: Path | None = None,
    revocation_file: Path | None = None,
    cache: bool = True,
    provenance: str | None = None,
    install_entry: str = "unknown",
    reject_skill_origin: bool = False,
) -> PluginVerificationResult:
    """Verify (and optionally cache) a plugin package.

    ``provenance`` records WHERE the package came from at the install entry
    (``"local"`` or ``"remote"``, design §3.7); it is written as a digest-bound
    sibling record beside the cache entry ONLY when ``cache=True``. The default
    ``None`` writes NO record — and a missing record is read as ``remote``
    (fail-closed), so an install entry that forgets to declare provenance can
    never accidentally mint a sign-free ``local`` grade. The record is consumed by
    the skill-origin provenance gate in
    ``plugin_proxy._verify_cached_package_before_execution`` (PR-1); generic
    plugins are unaffected.

    ``reject_skill_origin`` is the authoritative MANIFEST-level backstop for the
    capability-workshop red line "a skill is never side-loaded through the
    plugin-install pipeline". The REMOTE install sinks (registry/cloud install,
    install-github, install-workshop) pass ``True``: a package the kernel single
    source ``is_skill_origin_plugin`` grades a skill — by its SIGNED
    ``skill_origin: true`` field OR a reserved ``skill.`` id — fails closed here,
    EVEN IF a drifted/hostile feed advertised it as a plain ``kind="plugin"``. The
    feed-level guards screen untrusted metadata before download on that SAME
    predicate; this screens the signed bytes in hand, mirroring the external_mcp
    curated-only gate below (one source of truth, no install-vs-runtime split).
    LOCAL / verify / build / execute callers (install-local, ``plugin verify``,
    skill-build, the runtime gate) keep the default ``False`` so a genuine local
    skill stays sign-free installable and equippable (design §3.6).
    """
    package = load_plugin_package(path)
    try:
        digest = compute_package_digest(package)
        declared_digest = package.package_digest
        if declared_digest != digest:
            raise PluginVerificationError(f"package digest mismatch: declared {declared_digest}, computed {digest}")
        try:
            validate_manifest_configuration_contract(package.manifest)
        except PluginConfigurationError as exc:
            raise PluginVerificationError(f"plugin configuration contract invalid: {exc}") from exc
        # Sign-free LOCAL skill admission (design §3.6, owner-ratified): a
        # skill-origin package installed through a LOCAL entry is the user's own
        # responsibility and is equippable WITHOUT a signature. For those we admit
        # on integrity (digest matched above) + manifest contract + revocation,
        # and SKIP the signature-admission gate. The provenance is still recorded
        # (digest-bound) and the runtime gate grades it `local` by that stamp, so
        # this does NOT widen trust — a remote package can never reach this branch
        # (it never carries provenance="local"), and a reserved-namespace local
        # skill is still dropped at the runtime gate (no spoofing).
        # Predicate MUST match the runtime gate's
        # (plugin_proxy._verify_cached_package_before_execution), which keys on the
        # authoritative manifest field ``skill_origin: true`` — NOT the bare
        # ``skill.`` id-prefix fallback. Otherwise a non-skill_origin package could
        # set id="skill.spoof" to grab the sign-free install waiver while the
        # runtime treats it as a generic/hijack package: a predicate split. Keying
        # both on the manifest field keeps install-time and runtime identical, so a
        # generic/non-skill local package still fails closed here (signature
        # required) and a skill.-prefix-without-field package is a namespace hijack.
        sign_free_local_skill = provenance == "local" and package.manifest.get("skill_origin") is True
        if not sign_free_local_skill:
            # Execution admission gate (raises if the signature is unverifiable
            # under the provided/configured key or local-dev policy).
            _PLUGIN_VERIFIER.resolve_signature_trust(digest, package.signature, public_key)
        _PLUGIN_VERIFIER.check_revocation(package, revocation_file or default_revocation_file())
        # external_mcp is a CURATED-ONLY runtime (it executes an external program on
        # the host). The runtime/projection gate already requires a ROOT signer;
        # enforce the SAME rule here at install/verify so the CLI `plugin verify` /
        # registry-install face can NEVER mint a "verified/installed" external_mcp
        # that the runtime would then refuse to run. One source of truth — no
        # install-vs-runtime split — fail closed on any non-root signer regardless
        # of a caller-supplied public_key.
        if str(package.manifest.get("runtime", {}).get("type")) == "external_mcp":
            if _PLUGIN_VERIFIER.classify_signer(digest, package.signature) != "root":
                raise PluginVerificationError(
                    "external_mcp plugins must be product root-signed (curated-only)"
                )
        # Skills are equipped through the Skills surface / projection, NEVER
        # side-loaded as a plugin (capability-workshop red line). At the REMOTE
        # plugin-install sinks this is the authoritative MANIFEST backstop behind
        # the feed-level metadata guards, and it keys on the SAME kernel single
        # source the feed guards use — ``is_skill_origin_plugin`` (the signed
        # ``skill_origin: true`` field OR a reserved ``skill.`` id). So a
        # drifted/hostile feed can dodge it neither by mis-grading kind/skill_origin
        # NOR by shipping a ``skill.``-id package it advertised as a plain plugin.
        # Fails closed BEFORE the cache write, mirroring the external_mcp gate
        # above; local / verify / build / execute callers opt out (default False).
        if reject_skill_origin and is_skill_origin_plugin(
            package.plugin_id, package.manifest.get("skill_origin")
        ):
            raise PluginVerificationError(
                f"{package.plugin_id}@{package.version} is a skill capability "
                "(skill_origin manifest field or reserved skill. id); skills are "
                "equipped through the Skills surface, never installed via the "
                "plugin pipeline"
            )
        cached_path = (
            cache_plugin_package(package, cache_root=cache_root, public_key=public_key)
            if cache
            else None
        )
        if cached_path is not None and provenance is not None:
            # Deferred import: plugin_provenance imports from this module, so the
            # write helper is loaded lazily to avoid a module-level import cycle.
            from superclaw.plugin_provenance import write_install_provenance

            write_install_provenance(
                cache_version_dir=cached_path,
                provenance=provenance,  # type: ignore[arg-type]
                entry=install_entry,
                package_digest=digest,
            )
        # The propagated trust verdict's signer_class is ROOT-ONLY (via
        # classify_signer): admission via an explicit caller-supplied public_key
        # (CLI --public-key / fake-cloud / proxy preflight) means "signature
        # verifiable", NOT root trust — it must never derive to OFFICIAL. Integrity
        # is already proven (digest matched above).
        verdict = PackageTrustVerdict(
            signer_class=_PLUGIN_VERIFIER.classify_signer(digest, package.signature),
            integrity_ok=True,
        )
        return PluginVerificationResult(
            plugin_id=package.plugin_id,
            version=package.version,
            digest=digest,
            cached_path=cached_path,
            verdict=verdict,
        )
    finally:
        package.cleanup()


def verify_plugin_integrity(
    package: PluginPackage, *, public_key: str | None = None, require_signature: bool = True
) -> None:
    """Verify the immutable integrity of a package: digest, manifest contract, signature.

    This is the expensive half of verification (it re-hashes every file). It is
    deterministic for a given on-disk package, so a per-run cache can memoize it.
    Revocation is intentionally NOT checked here — call check_plugin_revocation()
    separately on every use so a mid-run revocation still takes effect.

    ``require_signature`` (default True) keeps the existing behavior: a signature
    must be admissible (root / explicit key / local-dev). The skill provenance
    gate sets it False for a digest-matched LOCAL skill-origin package — the
    owner's model makes `local` provenance equippable SIGN-FREE (design §3.6), so
    integrity for those is digest + manifest-contract only; trust is then graded
    by the digest-bound provenance stamp, NOT by a signature.
    """
    digest = compute_package_digest(package)
    if package.package_digest != digest:
        raise PluginVerificationError(f"package digest mismatch: declared {package.package_digest}, computed {digest}")
    try:
        validate_manifest_configuration_contract(package.manifest)
    except PluginConfigurationError as exc:
        raise PluginVerificationError(f"plugin configuration contract invalid: {exc}") from exc
    if require_signature:
        _PLUGIN_VERIFIER.resolve_signature_trust(digest, package.signature, public_key)


def check_plugin_revocation(package: PluginPackage, *, revocation_file: Path | None = None) -> None:
    """Raise PluginVerificationError if the package version is revoked (cheap, never cached)."""
    _PLUGIN_VERIFIER.check_revocation(package, revocation_file or default_revocation_file())


def plugin_namespace_violation(package: PluginPackage) -> bool:
    """True if an already-integrity-verified package occupies a reserved
    first-party namespace without a root signature (namespace hijack, 方向二 §3.2).

    Uses the declared digest (valid once integrity is verified upstream, so no
    re-hash) + root-only signer classification, routed through the single
    authoritative TrustState derivation. ``developer_keyids=None`` because the TUF
    delegated registry is not wired yet (方向二 §2); the namespace check itself is
    registry-independent.
    """
    signer_class = _PLUGIN_VERIFIER.classify_signer(
        package.package_digest, package.signature
    )
    if package.plugin_id.startswith("skill.") and package.manifest.get("skill_origin") is not True:
        return signer_class != "root"
    verdict = PackageTrustVerdict(
        signer_class=signer_class,
        integrity_ok=True,
    )
    trust = derive_trust_state(
        plugin_id=package.plugin_id,
        verdict=verdict,
        revoked=False,
        source_is_local=False,
        rollback_ok=True,
        freshness_ok=True,
        high_risk=False,
        developer_keyids=None,
    )
    return trust.state is TrustState.UNTRUSTED and "namespace_hijack" in trust.reasons


def plugin_signer_class(package: PluginPackage) -> str:
    """Root-only signer classification for an integrity-verified package.

    Returns ``"root"`` only when the configured ROOT key verifies the signature
    (never a caller-supplied key), else ``"local_dev"``/``"none"``. Used to gate
    privileged, curated-only runtime types (e.g. ``external_mcp``) to product
    root-signed packages. Uses the declared digest, valid once integrity has been
    verified upstream.
    """
    return _PLUGIN_VERIFIER.classify_signer(package.package_digest, package.signature)


def plugin_signer_identity(package: PluginPackage, *, public_key: str | None = None) -> str:
    """Stable signer bucket for same-id conflict detection.

    ``TrustState`` owns whether a package is trusted; this helper only answers
    whether two already-discovered candidates appear to come from the same signer
    class. The root key is classified via the verifier's root-only classifier.
    An explicit caller-supplied public key is a weaker, local admission identity
    (it proves "this key verifies" but never "official").
    """
    digest = compute_package_digest(package)
    if package.package_digest != digest:
        return "invalid"
    signer = _PLUGIN_VERIFIER.classify_signer(digest, package.signature)
    if signer != "none":
        return signer
    if public_key:
        try:
            _PLUGIN_VERIFIER.verify_signature(digest, package.signature, public_key)
        except PluginVerificationError:
            return "none"
        key_hash = hashlib.sha256(public_key.encode("utf-8")).hexdigest()[:16]
        return f"explicit:{key_hash}"
    return "none"


def cache_plugin_package(
    package: PluginPackage,
    *,
    cache_root: Path | None = None,
    public_key: str | None = None,
) -> Path:
    # The cache path is built from manifest-declared identity (id + version).
    # The manifest configuration contract does NOT constrain these top-level
    # fields, so a malicious package could declare id="../../etc" / version=
    # "cron.d" and have shutil.copytree write outside the cache root (arbitrary
    # file write). Validate each segment is a single safe path component before
    # touching the filesystem — the same fail-closed guard uninstall already
    # applies on the read/delete path.
    _validate_cache_segment(package.plugin_id, label="plugin id")
    _validate_cache_segment(package.version, label="plugin version")
    # SECURITY: the digest intentionally skips __pycache__ (interpreter-generated
    # bytecode, see _iter_package_files), so a directory package that *ships*
    # __pycache__/*.pyc would carry signed-but-unhashed bytecode that the runtime
    # could load. .scplug extraction rejects such members, but a directory
    # package never goes through extraction — install (caching) is the
    # chokepoint where a shipped __pycache__ must be refused. (After install,
    # the trusted runtime may legitimately write __pycache__ from already-
    # verified source; re-verification does not call this function, so cache
    # stability is preserved.)
    _reject_shipped_pycache(package.root)
    target = plugin_cache_root(cache_root) / package.plugin_id / package.version
    if target.exists():
        existing = load_plugin_package(target)
        try:
            existing_digest = compute_package_digest(existing)
            if existing.package_digest != existing_digest:
                raise PluginVerificationError(
                    f"existing cached plugin integrity mismatch: {package.plugin_id}@{package.version}; uninstall before replacing"
                )
            existing_identity = plugin_signer_identity(existing, public_key=public_key)
            incoming_identity = plugin_signer_identity(package, public_key=public_key)
            if existing_identity != incoming_identity:
                raise PluginVerificationError(
                    f"same plugin id/version already cached with different signer: {package.plugin_id}@{package.version}"
                )
        finally:
            existing.cleanup()
        shutil.rmtree(target)
        # Drop any stale digest-bound provenance record (a sibling of the version
        # dir, written by verify_plugin_package). On a rewrite the caller restamps
        # provenance for the NEW bytes; clearing the old one first means a
        # re-install can never silently inherit a prior `local` stamp (defense in
        # depth — read_install_provenance already fails closed on a digest
        # mismatch, but a byte-identical re-install must not keep a stale stamp
        # whose provenance the new install entry did not assert).
        from superclaw.plugin_provenance import PROVENANCE_SUFFIX

        _stale_provenance = target.parent / f"{target.name}{PROVENANCE_SUFFIX}"
        if _stale_provenance.exists():
            _stale_provenance.unlink()
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(package.root, target)
    return target


def is_skill_origin_plugin(plugin_id: str, skill_origin: Any = None) -> bool:
    """Whether a plugin is a skill-origin package (imported from a SKILL.md).

    Single source of truth for the marketplace's skill classification, shared by
    the kernel and mirrored by every surface. The authoritative signal is the
    signed manifest's ``skill_origin: true`` (so a surface can neither fake nor
    miss it). The ``skill.`` id prefix is honored as a backward-compatible
    fallback for skill packages produced before the manifest field existed.
    """
    return skill_origin is True or str(plugin_id).startswith("skill.")


def derive_skill_trust(
    package: PluginPackage,
    *,
    public_key: str | None = None,
    revocation_file: Path | None = None,
) -> TrustState:
    """Derive a cached skill-origin package's trust grade BY PROVENANCE (§3.6).

    This is a SEPARATE function from :func:`derive_trust_state` — it does NOT
    change that function's contract. The hard rule it pins is that the env-flag
    ``classify_signer == "local_dev"`` path can NEVER produce a ``LOCAL`` verdict
    for a skill: a ``local`` grade comes ONLY from a digest-bound install stamp.

    - **local stamp** (a digest-matched install record marked ``local``, §3.7) ⇒
      ``LOCAL`` (sign-free), UNLESS the id is in a reserved first-party namespace
      (``superclaw.`` / ``first_party.``), which is root-only ⇒ ``UNTRUSTED`` (no
      grade spoofing, even for a local package).
    - **remote** (stamp missing, marked ``remote``, or digest-mismatched ⇒
      treated remote, §3.7) ⇒ perform REAL verification and feed
      :func:`derive_trust_state` with ``source_is_local=False`` so the
      ``signer_class == "local_dev"`` row (``trust_state.py``) is unreachable:
      ``OFFICIAL`` / ``DEVELOPER`` only if a real signature verifies under the
      root / registered-developer key, else ``UNTRUSTED``.

    The env flag ``SUPERCLAW_PLUGIN_LOCAL_DEV_TRUST`` plays NO role in the skill
    verdict. Integrity + revocation are checked by the caller
    (``_verify_cached_package_before_execution``) BEFORE this runs; here we only
    grade provenance.
    """
    # Deferred import: plugin_provenance imports from this module.
    from superclaw.plugin_provenance import read_install_provenance

    provenance = read_install_provenance(package)
    if provenance == "local":
        # No grade spoofing: a reserved first-party namespace is root-only, even
        # for a local package. (derive_trust_state enforces the same rule for the
        # remote branch; we mirror it here so the local branch cannot bypass it.)
        if any(package.plugin_id.startswith(prefix) for prefix in FIRST_PARTY_NAMESPACES):
            return TrustState.UNTRUSTED
        # LOCAL is produced DIRECTLY from the digest-bound stamp — never by
        # feeding classify_signer's env-flag "local_dev" into derive_trust_state.
        return TrustState.LOCAL

    # remote branch: real verification verdict (signer class is root-only via
    # classify_signer; an explicit public_key admits "verifiable" but never root).
    signer_class = _PLUGIN_VERIFIER.classify_signer(package.package_digest, package.signature)
    verdict = PackageTrustVerdict(signer_class=signer_class, integrity_ok=True)
    derivation = derive_trust_state(
        plugin_id=package.plugin_id,
        verdict=verdict,
        revoked=False,
        source_is_local=False,
        rollback_ok=True,
        freshness_ok=True,
        high_risk=False,
        developer_keyids=None,
    )
    return derivation.state


def list_cached_plugins(*, cache_root: Path | None = None) -> list[dict[str, Any]]:
    root = plugin_cache_root(cache_root)
    if not root.exists():
        return []
    rows: list[dict[str, Any]] = []
    for manifest_path in sorted(root.glob(f"*/*/{MANIFEST_NAME}")):
        manifest = _read_json(manifest_path)
        plugin_id = str(manifest["id"])
        version = str(manifest["version"])
        row: dict[str, Any] = {
            "id": plugin_id,
            "version": version,
            "name": str(manifest.get("name") or manifest["id"]),
            "path": str(manifest_path.parent),
            "skill_origin": is_skill_origin_plugin(plugin_id, manifest.get("skill_origin")),
        }
        logo = manifest.get("logo")
        if isinstance(logo, str) and logo.strip():
            row["logo"] = logo.strip()
            row["logo_url"] = f"/api/plugins/{plugin_id}/logo?version={version}"
        rows.append(
            row
        )
    return rows


def uninstall_cached_plugin(
    plugin_id: str,
    *,
    version: str | None = None,
    cache_root: Path | None = None,
) -> dict[str, Any]:
    _validate_cache_segment(plugin_id, label="plugin id")
    if version:
        _validate_cache_segment(version, label="plugin version")
    root = plugin_cache_root(cache_root).resolve()
    plugin_root = (root / plugin_id).resolve()
    if plugin_root == root or root not in plugin_root.parents:
        raise PluginVerificationError(f"unsafe plugin id path: {plugin_id}")
    if not plugin_root.exists():
        return {"plugin_id": plugin_id, "removed": False, "versions": []}

    if version:
        target = (plugin_root / version).resolve()
        if target == plugin_root or plugin_root not in target.parents:
            raise PluginVerificationError(f"unsafe plugin version path: {plugin_id}@{version}")
        if not target.exists():
            return {"plugin_id": plugin_id, "removed": False, "versions": []}
        shutil.rmtree(target)
        removed_versions = [version]
        if plugin_root.exists() and not any(plugin_root.iterdir()):
            plugin_root.rmdir()
        return {"plugin_id": plugin_id, "removed": True, "versions": removed_versions}

    removed_versions = sorted(path.name for path in plugin_root.iterdir() if path.is_dir())
    shutil.rmtree(plugin_root)
    return {"plugin_id": plugin_id, "removed": bool(removed_versions), "versions": removed_versions}


def _validate_cache_segment(value: str, *, label: str) -> None:
    if not value or value in {".", ".."}:
        raise PluginVerificationError(f"unsafe {label} path: {value}")
    path = Path(value)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts) or len(path.parts) != 1:
        raise PluginVerificationError(f"unsafe {label} path: {value}")


def _canonical_manifest_for_digest(manifest: dict[str, Any]) -> bytes:
    return canonical_manifest_for_digest(manifest)


def _iter_package_files(root: Path) -> list[Path]:
    return _PLUGIN_VERIFIER.iter_package_files(root)


def _reject_shipped_pycache(root: Path) -> None:
    """Fail closed if a package source tree ships __pycache__ content.

    __pycache__ is excluded from the digest (it is interpreter-generated), so a
    package that ships it would carry signed-but-unhashed bytecode. This guards
    the directory-package install path (the .scplug path already rejects such
    members at extraction time).
    """
    for path in root.rglob("*"):
        if "__pycache__" in path.relative_to(root).parts:
            raise PluginVerificationError(
                f"plugin package may not ship __pycache__ content: {path.relative_to(root).as_posix()}"
            )


def _archive_collision_key(member_path: Path) -> str:
    """Identity key for archive-member collision detection.

    Two member names collide if, after Unicode NFC normalization and case
    folding, they map to the same path. NFC must come first: a bare ``casefold``
    does not normalize, so a composed (NFC) and a decomposed (NFD) spelling of
    the same name fold to *different* strings yet land on the *same* file on a
    normalization-insensitive filesystem (APFS/HFS+). Normalizing before folding
    closes that "two spellings, one file" shadowing channel.
    """
    parts = [unicodedata.normalize("NFC", part).casefold() for part in member_path.parts]
    return "/".join(parts)

def _safe_extract_plugin_archive(archive: zipfile.ZipFile, destination: Path) -> None:
    root = destination.resolve()
    # Zip-bomb guard #1: cap the entry count up front (cheap, before any I/O).
    if len(archive.infolist()) > _MAX_ARCHIVE_ENTRIES:
        raise PluginVerificationError(
            f"plugin archive has too many entries ({len(archive.infolist())} > {_MAX_ARCHIVE_ENTRIES})"
        )
    # Reject duplicate / case-/Unicode-colliding member names *before* extraction.
    # The post-extraction directory walk in compute_package_digest cannot see
    # them (last-write-wins has already collapsed two entries into one file on
    # disk), so a verifier that only re-hashes the extracted tree would be blind
    # to a "two entries, same name" smuggle. Reject here so the digest covers
    # exactly the bytes the archive declared, with no shadowed entry. Directory
    # members participate too: a ``foo/`` directory and a ``foo`` file collide on
    # disk and must fail closed with PluginVerificationError rather than crashing
    # extraction with a raw IsADirectoryError.
    seen_paths: dict[str, str] = {}
    file_keys: dict[str, str] = {}
    dir_keys: dict[str, str] = {}
    for member in archive.infolist():
        member_path = Path(member.filename)
        if member_path.is_absolute() or ".." in member_path.parts:
            raise PluginVerificationError(f"unsafe archive member path: {member.filename}")
        # Reject a member that normalizes to the archive root itself. A literal
        # "." (or "" / "./") has ``Path(...).parts == ()``, so it slips past the
        # absolute/".." and ancestor-collision checks, and ``(root / ".")``
        # resolves to ``root`` — extracting it would ``open("wb")`` the root
        # directory and crash with a bare IsADirectoryError instead of a
        # fail-closed PluginVerificationError. A real package never names the
        # root as a member, so refuse it at the door (same fail-closed contract
        # as the duplicate/collision rejections).
        if not member_path.parts:
            raise PluginVerificationError(
                f"plugin archive may not contain a root-alias member: {member.filename!r}"
            )
        mode = (member.external_attr >> 16) & 0o170000
        if stat.S_ISLNK(mode):
            raise PluginVerificationError(f"plugin archive may not contain symlink: {member.filename}")
        # __pycache__ is interpreter-generated bytecode that the digest
        # intentionally skips. An archive must never *ship* it, or it would be a
        # signed-but-unhashed smuggle channel (a malicious __pycache__/*.pyc that
        # the runtime could load). Reject it at the door, fail-closed.
        if "__pycache__" in member_path.parts:
            raise PluginVerificationError(
                f"plugin archive may not contain __pycache__ member: {member.filename}"
            )
        target = (root / member.filename).resolve()
        if target != root and root not in target.parents:
            raise PluginVerificationError(f"unsafe archive member path: {member.filename}")
        for part in member_path.parts:
            if unicodedata.normalize("NFC", part) != part:
                raise PluginVerificationError(
                    f"plugin archive member name is not Unicode-NFC-normalized: {member.filename}"
                )
        normalized = member_path.as_posix()
        key = _archive_collision_key(member_path)
        if key in seen_paths and seen_paths[key] != normalized:
            raise PluginVerificationError(
                "plugin archive contains duplicate or case/Unicode-colliding member: "
                f"{seen_paths[key]!r} vs {normalized!r}"
            )
        if key in seen_paths:
            # Exact-duplicate member name (e.g. two identical "data.txt" entries).
            raise PluginVerificationError(
                f"plugin archive contains duplicate member: {normalized!r}"
            )
        seen_paths[key] = normalized

        # Track file vs directory keys to catch ancestor/descendant conflicts: a
        # member that is a *file* at path "foo" cannot coexist with members that
        # require "foo" to be a *directory* (e.g. "foo/bar"). Without this, the
        # raw filesystem raises FileExistsError / NotADirectoryError mid-
        # extraction instead of a fail-closed PluginVerificationError. Every
        # ancestor of a member is, by construction, a directory.
        parts = member_path.parts
        ancestor_count = len(parts) - (0 if member.is_dir() else 1)
        if member.is_dir():
            dir_keys.setdefault(key, normalized)
        else:
            file_keys.setdefault(key, normalized)
        ancestor = Path()
        for depth in range(ancestor_count):
            ancestor = ancestor / parts[depth]
            dir_keys.setdefault(_archive_collision_key(ancestor), ancestor.as_posix())

    conflicting = file_keys.keys() & dir_keys.keys()
    if conflicting:
        conflict_key = next(iter(conflicting))
        raise PluginVerificationError(
            "plugin archive uses a path as both a file and a directory: "
            f"{file_keys[conflict_key]!r} vs {dir_keys[conflict_key]!r}"
        )

    remaining = _MAX_ARCHIVE_UNCOMPRESSED_BYTES
    for member in archive.infolist():
        target = (root / member.filename).resolve()
        if member.is_dir():
            target.mkdir(parents=True, exist_ok=True)
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        # Zip-bomb guard #2: stream with a hard cumulative byte budget. We do NOT
        # trust member.file_size (a malicious header can understate it); abort the
        # moment the actual decompressed bytes exceed the cap.
        with archive.open(member) as source, target.open("wb") as output:
            while True:
                chunk = source.read(_ARCHIVE_COPY_CHUNK)
                if not chunk:
                    break
                remaining -= len(chunk)
                if remaining < 0:
                    raise PluginVerificationError(
                        "plugin archive exceeds the maximum uncompressed size "
                        f"({_MAX_ARCHIVE_UNCOMPRESSED_BYTES} bytes)"
                    )
                output.write(chunk)
        permissions = (member.external_attr >> 16) & 0o777
        if permissions:
            target.chmod(permissions)


def _read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def local_dev_trust_enabled() -> bool:
    """Whether locally-installed plugins may be trusted without an official
    signature (delegates to the plugin trust verifier; see
    ``superclaw.trust.PackageTrustVerifier.local_dev_trust_enabled``)."""
    return _PLUGIN_VERIFIER.local_dev_trust_enabled()
