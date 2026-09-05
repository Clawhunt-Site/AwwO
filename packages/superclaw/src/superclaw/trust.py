"""Shared signed-artifact trust primitive for the Capability Workshop.

THE asset-agnostic trust / distribution layer (see capability-workshop-roadmap.md
方向一/二 and 北极星护栏 1): a single ``SignedArtifactEnvelope`` +
``PackageTrustVerifier`` that the plugin / skill / company domain models all
share, instead of each re-implementing digest + signature + revocation.

Guardrail (护栏 1 — trust layer vs domain model separation): this module holds
ONLY the signing-envelope and verification primitives. Install / run / authorize
/ instantiate semantics live in the parallel domain models (``PluginPackage``,
future ``CompanyTemplate``, …), never here — there is no
``if kind == 'company': skip_check()``. Trust state is DERIVED from verification
results, never trusted from a package's self-declared ``manifest.source``
(护栏 2). fail-closed is the default (护栏 4).

The ``PackageTrustVerifier`` is parameterized (manifest filename, root-key env,
local-dev-trust env, revocation id field, error class, message label) so each
asset kind gets identical, byte-stable behaviour. The plugin verifier configured
in ``plugins.py`` reproduces the pre-extraction behaviour exactly.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import shutil
import stat
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey


class SignedArtifactError(ValueError):
    """Raised when a signed artifact fails the local verification contract."""


@dataclass(frozen=True)
class PackageTrustVerdict:
    """The single authoritative verification result for a signed artifact.

    Produced by :class:`PackageTrustVerifier` (Direction 1) and consumed by the
    TrustState derivation (Direction 2). TrustState is derived from THIS verdict
    (integrity + signer class), never from a package's self-declared
    ``manifest.source`` (路线图护栏 2).
    """

    signer_class: str   # "root" | "developer:<keyid>" | "local_dev" | "none"
    integrity_ok: bool  # declared package_digest == recomputed content digest


@dataclass(frozen=True)
class SignedArtifactEnvelope:
    """Asset-agnostic wrapper over a signed artifact's manifest + on-disk root.

    The shared public envelope fields (``id`` / ``version`` /
    ``provenance.package_digest`` / ``provenance.signature``, plus optional
    ``kind``) are the ONLY thing the three asset kinds agree on. Domain models
    (``PluginPackage``, future ``CompanyTemplate``, …) subclass this and add
    their own typed accessors + landing logic.
    """

    source: Path
    root: Path
    manifest: dict[str, Any]
    temporary_root: Path | None = None

    @property
    def artifact_id(self) -> str:
        return str(self.manifest["id"])

    @property
    def version(self) -> str:
        return str(self.manifest["version"])

    @property
    def kind(self) -> str | None:
        value = self.manifest.get("kind")
        return str(value) if value is not None else None

    @property
    def package_digest(self) -> str:
        return str(self.manifest["provenance"]["package_digest"])

    @property
    def signature(self) -> str:
        return str(self.manifest["provenance"]["signature"])

    def cleanup(self) -> None:
        if self.temporary_root and self.temporary_root.exists():
            shutil.rmtree(self.temporary_root)


def canonical_manifest_for_digest(manifest: dict[str, Any]) -> bytes:
    """Canonical manifest bytes for the digest.

    ``provenance.package_digest`` and ``provenance.signature`` are zeroed so the
    digest is over the artifact's content (and the rest of the manifest), not
    over its own hash/signature.
    """
    cloned = json.loads(json.dumps(manifest, sort_keys=True))
    cloned["provenance"]["package_digest"] = ""
    cloned["provenance"]["signature"] = ""
    return json.dumps(cloned, sort_keys=True, separators=(",", ":")).encode("utf-8")


@dataclass(frozen=True)
class PackageTrustVerifier:
    """Reusable digest + Ed25519 signature + revocation primitive.

    Parameterized so each asset kind gets identical, byte-stable behaviour with
    its own manifest filename, root-key env var, local-dev-trust env var,
    revocation id field, error class and message label.
    """

    manifest_name: str
    label: str = "artifact"
    root_key_env: str = "SUPERCLAW_ARTIFACT_ROOT_PUBLIC_KEY"
    local_dev_env: str = "SUPERCLAW_ARTIFACT_LOCAL_DEV_TRUST"
    revocation_id_field: str = "id"
    error_cls: type[Exception] = SignedArtifactError
    digest_domain: bytes = b"superclaw-artifact-pkg-digest-v2\0"

    # --- digest ---------------------------------------------------------

    def iter_package_files(self, root: Path) -> list[Path]:
        files: list[Path] = []
        for path in root.rglob("*"):
            if path.is_symlink():
                raise self.error_cls(
                    f"{self.label} package may not contain symlink: "
                    f"{path.relative_to(root).as_posix()}"
                )
            if not path.is_file():
                continue
            # Generated Python bytecode is never part of package identity. A
            # package is signed without it, but importing modules at runtime
            # writes __pycache__/*.pyc into the (cached) dir; including those
            # would make the digest drift and fail verification on every call
            # after the first. Skip them so the digest stays stable.
            parts = path.relative_to(root).parts
            if "__pycache__" in parts:
                continue
            files.append(path)
        return sorted(files)

    def digest_relative_name(self, file_path: Path, root: Path) -> str:
        """Return the digest key for a package file, rejecting ambiguous names."""
        relative = file_path.relative_to(root)
        for part in relative.parts:
            if unicodedata.normalize("NFC", part) != part:
                raise self.error_cls(
                    f"{self.label} package file name is not Unicode-NFC-normalized: "
                    f"{relative.as_posix()}"
                )
        return relative.as_posix()

    @staticmethod
    def length_prefixed(payload: bytes) -> bytes:
        return len(payload).to_bytes(8, "big") + payload

    @staticmethod
    def mode_signal(file_path: Path) -> int:
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

    def compute_digest(self, envelope: SignedArtifactEnvelope) -> str:
        digest = hashlib.sha256()
        digest.update(self.digest_domain)

        seen_casefold: dict[str, str] = {}
        entries: list[tuple[str, Path]] = []
        for file_path in self.iter_package_files(envelope.root):
            relative = self.digest_relative_name(file_path, envelope.root)
            folded = relative.casefold()
            if folded in seen_casefold:
                raise self.error_cls(
                    f"{self.label} package contains colliding file paths "
                    f"(case-insensitive): {seen_casefold[folded]!r} vs {relative!r}"
                )
            seen_casefold[folded] = relative
            entries.append((relative, file_path))

        entries.sort(key=lambda item: item[0])
        digest.update(self.length_prefixed(str(len(entries)).encode("utf-8")))
        for relative, file_path in entries:
            digest.update(self.length_prefixed(relative.encode("utf-8")))
            digest.update(bytes([self.mode_signal(file_path)]))
            if relative == self.manifest_name:
                payload = canonical_manifest_for_digest(envelope.manifest)
            else:
                payload = file_path.read_bytes()
            digest.update(self.length_prefixed(payload))
        return f"sha256:{digest.hexdigest()}"

    # --- signature ------------------------------------------------------

    def root_public_key_from_env(self) -> str:
        value = os.environ.get(self.root_key_env)
        if not value:
            raise self.error_cls(f"missing {self.root_key_env}")
        return value

    def local_dev_trust_enabled(self) -> bool:
        """Whether locally-installed artifacts may be trusted without an official
        signature. Explicit, opt-in *development* trust — it NEVER relaxes
        integrity (digest re-hash), the manifest contract, revocation,
        entitlement or runtime policy; it only lets a locally cached artifact
        whose signature cannot be verified by a configured root key still load.
        Off by default (fail-closed)."""
        return os.environ.get(self.local_dev_env, "").strip().lower() in {
            "1",
            "true",
            "yes",
            "on",
        }

    def verify_signature(self, digest: str, signature: str, public_key: str) -> None:
        if not signature.startswith("ed25519:"):
            raise self.error_cls("unsupported signature format")
        try:
            signature_bytes = base64.b64decode(
                signature.removeprefix("ed25519:"), validate=True
            )
            public_key_bytes = base64.b64decode(
                public_key.removeprefix("ed25519:"), validate=True
            )
            Ed25519PublicKey.from_public_bytes(public_key_bytes).verify(
                signature_bytes, digest.encode("utf-8")
            )
        except (InvalidSignature, ValueError) as exc:
            raise self.error_cls(f"{self.label} signature invalid") from exc

    def resolve_signature_trust(
        self, digest: str, signature: str, public_key: str | None, *, allow_local_dev: bool = False
    ) -> str:
        """Verify a signature, returning the trust class that admitted it.

        Returns ``"official"`` when a configured/root public key verifies the
        signature, or ``"local_dev"`` when official verification is
        unavailable/failed but local dev trust is explicitly enabled. Raises
        otherwise. Callers MUST have already verified integrity (digest).

        ``allow_local_dev`` is an explicit per-call opt-in (e.g. a ``--trust local``
        CLI flag) that admits local-dev trust for THIS call even when the
        ``local_dev_env`` env var is not set. It NEVER relaxes integrity, contract,
        revocation, or the namespace gate — it only lets a locally-sourced artifact
        whose signature no root key verifies read as ``local_dev`` (fail-closed
        default: ``False``, so existing callers are unchanged).
        """
        local_dev = self.local_dev_trust_enabled() or allow_local_dev
        key = public_key or os.environ.get(self.root_key_env)
        if key:
            try:
                self.verify_signature(digest, signature, key)
                return "official"
            except self.error_cls:
                if not local_dev:
                    raise
                return "local_dev"
        # No verifiable key available.
        if local_dev:
            return "local_dev"
        # Preserve the original fail-closed behavior (missing-key error).
        self.verify_signature(digest, signature, self.root_public_key_from_env())
        return "official"

    def classify_signer(self, digest: str, signature: str) -> str:
        """Non-raising signer classification for the discovery / trust-state layer.

        Returns ``"root"`` ONLY when the configured ROOT key (``root_key_env``)
        verifies the signature — NEVER an arbitrary caller-supplied key, which
        would let a third-party signature masquerade as root and bypass the
        namespace-hijack defense. Returns ``"local_dev"`` when local dev trust is
        explicitly enabled and the root key does not verify, else ``"none"``.

        This is the read-only classifier for catalog entries that may be
        untrusted and must be SHOWN (catalog declares discoverability, never
        authorizes a run); the EXECUTION/install path still fail-closes via
        :meth:`resolve_signature_trust`, which raises. The delegated
        ``"developer:<keyid>"`` class arrives with TUF registry metadata
        (方向二 §2); until then a developer signature does not verify under the
        root key and reads as ``"none"`` (fail-closed).
        """
        root_key = os.environ.get(self.root_key_env)
        if root_key:
            try:
                self.verify_signature(digest, signature, root_key)
                return "root"
            except self.error_cls:
                pass
        if self.local_dev_trust_enabled():
            return "local_dev"
        return "none"

    def assess(self, envelope: SignedArtifactEnvelope) -> PackageTrustVerdict:
        """Non-raising verification verdict for the discovery layer.

        Recomputes the content digest (integrity = declared == computed) and
        classifies the signer, without raising. A tampered package (declared !=
        computed) yields ``integrity_ok=False`` and ``signer_class="none"`` — a
        broken content hash makes its signature meaningless, so the signer
        identity is not retained. The execution/install path uses ``verify_*``
        (which raise); this produces the verdict the catalog / TrustState layer
        consumes.

        Truly non-raising: a malformed or malicious artifact (symlink in the
        tree, manifest missing ``provenance``/digest/signature, unreadable file,
        …) yields an untrusted verdict rather than crashing discovery — a bad
        package is simply not trusted, never catalog-breaking (fail-closed).
        """
        try:
            computed = self.compute_digest(envelope)
            integrity_ok = computed == envelope.package_digest
            signer_class = (
                self.classify_signer(computed, envelope.signature)
                if integrity_ok
                else "none"
            )
            return PackageTrustVerdict(
                signer_class=signer_class, integrity_ok=integrity_ok
            )
        except Exception:
            return PackageTrustVerdict(signer_class="none", integrity_ok=False)

    # --- revocation -----------------------------------------------------

    def check_revocation(
        self, envelope: SignedArtifactEnvelope, revocation_file: Path
    ) -> None:
        if not revocation_file.exists():
            return
        payload = json.loads(revocation_file.read_text(encoding="utf-8"))
        for item in payload.get("revoked", []):
            artifact_id = item.get(self.revocation_id_field)
            version = item.get("version")
            revoked_digest = item.get("package_digest")
            package_digests = {envelope.package_digest}
            if revoked_digest is not None:
                package_digests.add(self.compute_digest(envelope))
            if (
                artifact_id == envelope.artifact_id
                and version in {None, envelope.version}
                and revoked_digest in {None, *package_digests}
            ):
                raise self.error_cls(
                    f"{self.label} revoked: {envelope.artifact_id}@{envelope.version}"
                )


__all__ = [
    "SignedArtifactError",
    "PackageTrustVerdict",
    "SignedArtifactEnvelope",
    "PackageTrustVerifier",
    "canonical_manifest_for_digest",
]
