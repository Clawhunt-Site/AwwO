"""Workshop trust receipt + immutable archive staging (capability workshop S1).

A *workshop receipt* is the trust token handed from SuperClaw's Python
verification gate to the Paperclip-native importer over a loopback channel.
It binds the verified identity (kind / id / version / super domain digest), the
staged artifact location, the *transport* digest, the deployment environment
and the official verdict under an HMAC, so the importer can trust the bytes
WITHOUT re-running SuperClaw's custom domain-hash verification (which a Node
importer cannot reproduce). See ``docs/capability-workshop-paperclip-fullchain-design.md``.

Trust model (important — read before changing):
- The AUTHORITATIVE integrity boundary is the importer recomputing
  ``transport_sha256`` over the staged archive and comparing it to the
  HMAC-signed receipt value. Filesystem read-only freezing here is
  *defense-in-depth only*: a chmod cannot stop a same-UID attacker, so we never
  rely on it as the security boundary.
- S1 stages the single verified ``.scplug`` ARCHIVE (one file), not an unpacked
  tree. The importer (S2) recomputes the archive digest, then unpacks it into a
  private directory it owns. This avoids cross-implementation directory-tree
  hashing and removes the copy-tree symlink TOCTOU surface.

S1 scope (this module): receipt issue / sign / strict verify (HMAC + TTL +
app-env binding + format validation) and content-addressed immutable staging of
an already-verified archive file. Pure in-process logic — no network, no
subprocess — so the unit tests are instant and load-insensitive.
"""

from __future__ import annotations

import dataclasses
import hashlib
import hmac
import json
import os
import secrets
import shutil
import time
from pathlib import Path
from typing import Any

WORKSHOP_RECEIPT_HMAC_KEY_ENV = "SUPERCLAW_WORKSHOP_RECEIPT_HMAC_KEY"
DEFAULT_RECEIPT_TTL_SECONDS = 120
MAX_RECEIPT_TTL_SECONDS = 3600
CLOCK_SKEW_SECONDS = 300
VALID_KINDS = frozenset({"plugin", "skill", "company"})

_RECEIPT_VERSION = "1"
_SHA256_PREFIX = "sha256:"
_SHA256_HEX_LEN = 64
_READ_CHUNK = 1024 * 1024
_HEX_ALPHABET = frozenset("0123456789abcdef")
_CORE_KEYS = frozenset(
    {
        "receipt_version",
        "receipt_id",
        "kind",
        "capability_id",
        "version",
        "package_digest",
        "transport_sha256",
        "staged_artifact",
        "artifact_ref",
        "app_env",
        "official",
        "issued_at",
        "expires_at",
    }
)


class WorkshopReceiptError(Exception):
    """Raised on receipt signing/verification or staging failures (fail-closed)."""


def _is_sha256(value: str) -> bool:
    if not value.startswith(_SHA256_PREFIX):
        return False
    hex_part = value[len(_SHA256_PREFIX):]
    return len(hex_part) == _SHA256_HEX_LEN and all(c in _HEX_ALPHABET for c in hex_part)


def _require_sha256(value: str, field: str) -> str:
    if not isinstance(value, str) or not _is_sha256(value):
        raise WorkshopReceiptError(f"{field} must be a sha256:<64-hex> digest")
    return value


@dataclasses.dataclass(frozen=True)
class WorkshopReceipt:
    """The signed core a workshop receipt binds.

    ``package_digest`` is SuperClaw's custom length-prefixed *domain* digest (the
    real verification verdict, computed by the Python gate). ``transport_sha256``
    is a plain ``sha256`` over the staged *archive bytes* — the importer
    recomputes it to confirm the bytes were not swapped in transit.
    """

    receipt_id: str
    kind: str
    capability_id: str
    version: str
    package_digest: str
    transport_sha256: str
    staged_artifact: str
    artifact_ref: str
    app_env: str
    official: bool
    issued_at: int
    expires_at: int

    def signed_core(self) -> dict[str, Any]:
        """The exact field set the HMAC is computed over (order-independent)."""
        return {
            "receipt_version": _RECEIPT_VERSION,
            "receipt_id": self.receipt_id,
            "kind": self.kind,
            "capability_id": self.capability_id,
            "version": self.version,
            "package_digest": self.package_digest,
            "transport_sha256": self.transport_sha256,
            "staged_artifact": self.staged_artifact,
            "artifact_ref": self.artifact_ref,
            "app_env": self.app_env,
            "official": self.official,
            "issued_at": self.issued_at,
            "expires_at": self.expires_at,
        }


def _resolve_hmac_key(key: bytes | None) -> bytes:
    if key is not None:
        if not key:
            raise WorkshopReceiptError("workshop receipt HMAC key must not be empty")
        return key
    raw = os.environ.get(WORKSHOP_RECEIPT_HMAC_KEY_ENV, "")
    if not raw:
        raise WorkshopReceiptError(
            f"{WORKSHOP_RECEIPT_HMAC_KEY_ENV} is required to sign/verify workshop receipts"
        )
    return raw.encode("utf-8")


def _canonical_bytes(core: dict[str, Any]) -> bytes:
    # Deterministic, ASCII, compact, sorted — both signer and verifier must agree.
    return json.dumps(core, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")


def compute_receipt_mac(receipt: WorkshopReceipt, *, key: bytes | None = None) -> str:
    """Return ``sha256:<hex>`` HMAC over the receipt's signed core (fail-closed key)."""
    resolved = _resolve_hmac_key(key)
    mac = hmac.new(resolved, _canonical_bytes(receipt.signed_core()), hashlib.sha256).hexdigest()
    return _SHA256_PREFIX + mac


def issue_receipt(
    *,
    kind: str,
    capability_id: str,
    version: str,
    package_digest: str,
    transport_sha256: str,
    staged_artifact: str,
    artifact_ref: str,
    app_env: str,
    official: bool,
    issued_at: int | None = None,
    ttl_seconds: int = DEFAULT_RECEIPT_TTL_SECONDS,
) -> WorkshopReceipt:
    """Build a receipt with a fresh id and ``issued_at``/``expires_at`` window."""
    if kind not in VALID_KINDS:
        raise WorkshopReceiptError(f"unsupported capability kind: {kind!r}")
    if not isinstance(official, bool):
        # Strict: never coerce a string/int into an official verdict (bool("false") is True).
        raise WorkshopReceiptError("receipt official must be a bool")
    if not (0 < ttl_seconds <= MAX_RECEIPT_TTL_SECONDS):
        raise WorkshopReceiptError(f"receipt ttl_seconds must be in (0, {MAX_RECEIPT_TTL_SECONDS}]")
    if not capability_id or not version:
        raise WorkshopReceiptError("receipt requires non-empty capability_id and version")
    if not app_env:
        raise WorkshopReceiptError("receipt requires a non-empty app_env")
    if not staged_artifact:
        raise WorkshopReceiptError("receipt requires a non-empty staged_artifact")
    _require_sha256(package_digest, "package_digest")
    _require_sha256(transport_sha256, "transport_sha256")
    issued = int(issued_at) if issued_at is not None else int(time.time())
    return WorkshopReceipt(
        receipt_id="rcpt_" + secrets.token_hex(16),
        kind=kind,
        capability_id=capability_id,
        version=version,
        package_digest=package_digest,
        transport_sha256=transport_sha256,
        staged_artifact=staged_artifact,
        artifact_ref=artifact_ref,
        app_env=app_env,
        official=bool(official),
        issued_at=issued,
        expires_at=issued + int(ttl_seconds),
    )


def receipt_to_wire(receipt: WorkshopReceipt, *, key: bytes | None = None) -> dict[str, Any]:
    """Serialize a receipt to its wire form (signed core + ``mac``)."""
    wire = receipt.signed_core()
    wire["mac"] = compute_receipt_mac(receipt, key=key)
    return wire


def _require(wire: dict[str, Any], field: str, expected_type: type) -> Any:
    if field not in wire:
        raise WorkshopReceiptError(f"receipt is missing {field}")
    value = wire[field]
    # bool is a subclass of int — reject the cross-type so coercion can't sneak in.
    if expected_type is int and isinstance(value, bool):
        raise WorkshopReceiptError(f"receipt {field} must be an int")
    if not isinstance(value, expected_type):
        raise WorkshopReceiptError(f"receipt {field} has the wrong type")
    return value


def verify_wire(
    wire: dict[str, Any],
    *,
    expected_app_env: str,
    key: bytes | None = None,
    now: int | None = None,
) -> WorkshopReceipt:
    """Verify a wire receipt and return it, else raise ``WorkshopReceiptError``.

    Fail-closed checks: no unknown keys, strict field types (no coercion),
    receipt_version, HMAC (constant-time), digest formats, kind, TTL window
    (``issued_at < now < expires_at`` within the max-TTL + clock-skew bounds) and
    the mandatory ``expected_app_env`` binding.
    """
    if not isinstance(wire, dict):
        raise WorkshopReceiptError("receipt must be an object")
    if not expected_app_env:
        raise WorkshopReceiptError("expected_app_env is required to verify a receipt")
    extra = set(wire.keys()) - _CORE_KEYS - {"mac"}
    if extra:
        raise WorkshopReceiptError(f"receipt has unexpected fields: {sorted(extra)}")
    if _require(wire, "receipt_version", str) != _RECEIPT_VERSION:
        raise WorkshopReceiptError("unsupported receipt_version")
    presented_mac = _require(wire, "mac", str)
    # Strict sha256:<64-hex> shape BEFORE compare_digest, which raises TypeError on
    # non-ASCII input — keep every verification failure inside WorkshopReceiptError.
    if not _is_sha256(presented_mac):
        raise WorkshopReceiptError("receipt mac is malformed")

    receipt = WorkshopReceipt(
        receipt_id=_require(wire, "receipt_id", str),
        kind=_require(wire, "kind", str),
        capability_id=_require(wire, "capability_id", str),
        version=_require(wire, "version", str),
        package_digest=_require_sha256(_require(wire, "package_digest", str), "package_digest"),
        transport_sha256=_require_sha256(_require(wire, "transport_sha256", str), "transport_sha256"),
        staged_artifact=_require(wire, "staged_artifact", str),
        artifact_ref=_require(wire, "artifact_ref", str),
        app_env=_require(wire, "app_env", str),
        official=_require(wire, "official", bool),
        issued_at=_require(wire, "issued_at", int),
        expires_at=_require(wire, "expires_at", int),
    )

    expected_mac = compute_receipt_mac(receipt, key=key)
    if not hmac.compare_digest(expected_mac, presented_mac):
        raise WorkshopReceiptError("receipt mac verification failed")

    if receipt.kind not in VALID_KINDS:
        raise WorkshopReceiptError("receipt has an unsupported kind")
    if receipt.expires_at <= receipt.issued_at:
        raise WorkshopReceiptError("receipt expires_at must be after issued_at")
    if receipt.expires_at - receipt.issued_at > MAX_RECEIPT_TTL_SECONDS:
        raise WorkshopReceiptError("receipt ttl exceeds the maximum")
    current = int(now) if now is not None else int(time.time())
    if receipt.issued_at > current + CLOCK_SKEW_SECONDS:
        raise WorkshopReceiptError("receipt is not yet valid (issued in the future)")
    if current >= receipt.expires_at:
        raise WorkshopReceiptError("receipt has expired")
    if receipt.app_env != expected_app_env:
        raise WorkshopReceiptError(
            f"receipt app_env {receipt.app_env!r} does not match {expected_app_env!r}"
        )
    return receipt


def compute_file_sha256(path: Path) -> str:
    """Return ``sha256:<hex>`` over a file's bytes (the transport digest)."""
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(_READ_CHUNK), b""):
            digest.update(chunk)
    return _SHA256_PREFIX + digest.hexdigest()


def _digest_hex(digest: str) -> str:
    _require_sha256(digest, "digest")
    return digest[len(_SHA256_PREFIX):].lower()


def _safe_segment(value: str) -> str:
    sanitized = "".join(c if (c.isalnum() or c in "._-") else "_" for c in value)
    if sanitized in ("", ".", ".."):
        raise WorkshopReceiptError(f"unsafe path segment: {value!r}")
    return sanitized


def _secure_child_dir(parent: Path, segment: str) -> Path:
    """Create/resolve a single child directory, refusing a symlinked component."""
    child = parent / _safe_segment(segment)
    if child.is_symlink():  # lstat, does not follow — catches a pre-planted symlink
        raise WorkshopReceiptError(f"refusing symlinked staging path component: {child}")
    if child.exists() and not child.is_dir():
        raise WorkshopReceiptError(f"staging path component is not a directory: {child}")
    child.mkdir(mode=0o700, exist_ok=True)
    if child.is_symlink():  # re-check after create (TOCTOU defense-in-depth)
        raise WorkshopReceiptError(f"refusing symlinked staging path component: {child}")
    return child


def _secure_target_dir(staging_root: Path, kind: str, capability_id: str) -> Path:
    """Build ``<root>/<kind>/<id>`` rejecting symlinked components and any escape."""
    if staging_root.is_symlink():
        raise WorkshopReceiptError("staging_root must not be a symlink")
    staging_root.mkdir(parents=True, mode=0o700, exist_ok=True)
    target_dir = _secure_child_dir(_secure_child_dir(staging_root, kind), capability_id)
    root_real = staging_root.resolve()
    target_real = target_dir.resolve()
    # resolve() follows every symlink — a parent escaping the root is caught here.
    if root_real != target_real and root_real not in target_real.parents:
        raise WorkshopReceiptError("staging target escaped staging_root")
    return target_dir


def stage_immutable_archive(
    archive_path: Path,
    *,
    staging_root: Path,
    kind: str,
    capability_id: str,
    transport_sha256: str,
) -> Path:
    """Stage a verified archive *file* at a content-addressed, read-only path.

    Target = ``<staging_root>/<kind>/<sanitized id>/<transport hex>.scplug``.
    Content-addressed by the transport digest and idempotent: an already-staged
    archive whose bytes still hash to ``transport_sha256`` is returned as-is; a
    pre-planted file with a different hash (or a symlink/non-file) is refused.

    NOTE: read-only freezing is defense-in-depth only. The authoritative
    integrity check is the importer recomputing ``transport_sha256`` over the
    returned file before use.
    """
    if kind not in VALID_KINDS:
        raise WorkshopReceiptError(f"unsupported capability kind: {kind!r}")
    if archive_path.is_symlink() or not archive_path.is_file():
        raise WorkshopReceiptError(f"archive source must be a regular file: {archive_path}")
    _require_sha256(transport_sha256, "transport_sha256")
    if compute_file_sha256(archive_path) != transport_sha256:
        raise WorkshopReceiptError("archive bytes do not match transport_sha256")

    target_dir = _secure_target_dir(staging_root, kind, capability_id)
    target = target_dir / f"{_digest_hex(transport_sha256)}.scplug"

    if target.exists():
        if target.is_symlink() or not target.is_file():
            raise WorkshopReceiptError(f"staged path is not a regular file: {target}")
        if compute_file_sha256(target) != transport_sha256:
            raise WorkshopReceiptError(f"pre-existing staged archive hash mismatch: {target}")
        target.chmod(0o444)  # normalize perms (parents already symlink-checked + in-root)
        return target

    tmp = target_dir / f".{_digest_hex(transport_sha256)}.tmp-{secrets.token_hex(8)}"
    try:
        shutil.copyfile(archive_path, tmp)  # copies bytes only; never follows into a tree
        if compute_file_sha256(tmp) != transport_sha256:
            raise WorkshopReceiptError("staged copy hash mismatch")
        tmp.chmod(0o444)  # freeze BEFORE publishing — no writable window after rename
        try:
            os.rename(tmp, target)
        except OSError:
            if target.is_file() and not target.is_symlink() and compute_file_sha256(target) == transport_sha256:
                _unlink(tmp)
                return target
            raise
    except WorkshopReceiptError:
        _unlink(tmp)
        raise
    except OSError as exc:
        _unlink(tmp)
        raise WorkshopReceiptError(f"failed to stage archive: {exc}") from exc
    return target


def _unlink(path: Path) -> None:
    try:
        if path.is_file() or path.is_symlink():
            path.chmod(0o600)
            path.unlink()
    except OSError:
        pass


def remove_staged_artifact(staged_artifact: Path, *, staging_root: Path) -> None:
    """Remove a staged archive file, refusing anything outside ``staging_root``."""
    root = staging_root.resolve()
    try:
        target = staged_artifact.resolve()
    except OSError as exc:
        raise WorkshopReceiptError(f"cannot resolve staged artifact: {exc}") from exc
    if root != target and root not in target.parents:
        raise WorkshopReceiptError(f"refusing to remove path outside staging root: {staged_artifact}")
    _unlink(target)
