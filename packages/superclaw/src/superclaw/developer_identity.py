"""Developer signing identity (super side).

A logged-in user gets ONE Ed25519 keypair per ACCOUNT (not per device). Per the
owner's escrow decision the keypair is server-held and recoverable: on login the
client calls ``POST /v1/capabilities/developers/key/ensure``, which mints the pair
on first use and returns the SAME pair on every device thereafter, so a lost local
key is recovered rather than silently replaced. The private key therefore DOES leave
the machine (it is escrowed, encrypted at rest server-side) — a deliberate trade for
recoverability. The locally-cached copy under ~/.superclaw (0600) is just a cache of
the authoritative server pair, used for offline signing.

A capability the developer signs (digest-then-sign at upload) is traceable to that
account and verifiable by ClawHunt against the registered public key.

This is NOT a runtime trust anchor: end-user trust still rests on the product ROOT
key (ClawHunt re-signs reviewed capabilities). The developer key only proves
authorship + integrity of what was submitted (company-as-gatekeeper model).

Timing: established on successful ClawHunt login (identity established); the ensure
call is best-effort and non-fatal so login never breaks on a transient network error
— it can be retried (an explicit CLI command and a lazy ensure before upload both
call back into the same primitive). When the server is unreachable, an existing local
cache still lets the user sign this session (offline fallback).
"""
from __future__ import annotations

import base64
import os
import re
import stat
import uuid
from pathlib import Path
from typing import Any

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    NoEncryption,
    PrivateFormat,
    PublicFormat,
)

from superclaw.clawhunt_auth import clawhunt_auth_path

# ClawHunt developer_id grammar: first char alphanumeric, then [A-Za-z0-9_.:@-],
# total length 2..161 (mirror of the server-side validation).
_DEVELOPER_ID_BODY = re.compile(r"[^A-Za-z0-9_.:@-]")
_DEVELOPER_ID_MAX = 161


def developer_key_path() -> Path:
    """Local path of the developer's Ed25519 private key (raw-base64, 0600)."""
    return clawhunt_auth_path().parent / "developer-signing-key.ed25519"


def _encode_public_key(private_key: Ed25519PrivateKey) -> str:
    raw = private_key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    return base64.b64encode(raw).decode("ascii")


def _read_existing_key(path: Path) -> tuple[Ed25519PrivateKey, str] | None:
    """Load an existing developer key, self-healing over-broad file permissions.

    A pre-existing key file that is group/other-accessible (e.g. a legacy 0644) is
    a private-key exposure, so tighten it back to 0600 on read. Returns None when no
    file is present.
    """
    if not path.is_file():
        return None
    try:
        if stat.S_IMODE(path.stat().st_mode) & 0o077:
            path.chmod(stat.S_IRUSR | stat.S_IWUSR)  # 0600 — strip group/other bits
    except OSError:
        pass
    text = path.read_text(encoding="utf-8").strip()
    raw = base64.b64decode(text.removeprefix("ed25519:"), validate=True)
    private_key = Ed25519PrivateKey.from_private_bytes(raw)
    return private_key, _encode_public_key(private_key)


def load_or_create_developer_key() -> tuple[Ed25519PrivateKey, str]:
    """Return the developer's (private_key, public_key_b64), creating it if absent.

    Idempotent: a second call returns the SAME key. The private key is stored as
    ``ed25519:<base64 raw 32 bytes>`` under ~/.superclaw, created ATOMICALLY with
    0600 (``os.open`` O_CREAT|O_EXCL) so it is never briefly world-readable and a
    concurrent login can never overwrite a freshly-minted key (TOCTOU): the loser of
    the race adopts the winner's key. The directory is created 0700 if missing.
    """
    path = developer_key_path()
    # Self-heal the private-key STORAGE DIRECTORY to 0700 on EVERY call (before the
    # early-return for an existing key), so a legacy/over-broad ~/.superclaw (e.g.
    # 0755, world-enumerable) is tightened even when we adopt an existing key.
    parent = path.parent
    parent.mkdir(parents=True, exist_ok=True)
    try:
        parent.chmod(stat.S_IRWXU)  # 0700 — owner only
    except OSError:
        pass

    existing = _read_existing_key(path)
    if existing is not None:
        return existing

    private_key = Ed25519PrivateKey.generate()
    raw_priv = private_key.private_bytes(Encoding.Raw, PrivateFormat.Raw, NoEncryption())
    content = "ed25519:" + base64.b64encode(raw_priv).decode("ascii") + "\n"
    try:
        fd = os.open(path, os.O_CREAT | os.O_WRONLY | os.O_EXCL, 0o600)
    except FileExistsError:
        # A concurrent login won the race and created the key first — adopt theirs
        # and discard our just-generated candidate (so the registered public key and
        # the on-disk private key never diverge).
        adopted = _read_existing_key(path)
        if adopted is not None:
            return adopted
        raise
    with os.fdopen(fd, "w") as handle:
        handle.write(content)
    try:
        path.chmod(stat.S_IRUSR | stat.S_IWUSR)  # enforce exactly 0600 (O_CREAT mode is umask-masked)
    except OSError:
        pass
    return private_key, _encode_public_key(private_key)


def _read_local_key_material(path: Path) -> tuple[str, str] | None:
    """Return the locally-cached key as ``(private_material, public_material)`` —
    both ``ed25519:<base64>`` strings — or None when absent.

    Sent to the escrow endpoint so the server can ADOPT a key the client already
    minted (no server row yet) or BACKFILL a legacy public-only registration on proof
    of the matching private key. Reuses ``_read_existing_key`` (which self-heals
    over-broad permissions). Returns None on a malformed/unreadable file rather than
    raising, so a corrupt cache degrades to "let the server mint" instead of breaking.
    """
    try:
        parsed = _read_existing_key(path)
    except (OSError, ValueError):
        return None
    if parsed is None:
        return None
    private_key, public_b64 = parsed
    raw_priv = private_key.private_bytes(Encoding.Raw, PrivateFormat.Raw, NoEncryption())
    private_material = "ed25519:" + base64.b64encode(raw_priv).decode("ascii")
    return private_material, "ed25519:" + public_b64


def _atomic_write_0600(path: Path, content: str) -> None:
    """Write ``content`` to ``path`` atomically at 0600.

    Uses a PER-CALL-UNIQUE temp file (pid + uuid) created with O_EXCL, then a single
    ``os.replace`` — so concurrent writers never share/truncate each other's temp and
    a reader never sees a half-written file (mirrors ``save_clawhunt_auth``). The temp
    is cleaned up on any failure, and the error propagates (callers fail closed).
    """
    tmp = path.with_name(f".{path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
    try:
        fd = os.open(tmp, os.O_CREAT | os.O_WRONLY | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as handle:
            handle.write(content)
        try:
            tmp.chmod(stat.S_IRUSR | stat.S_IWUSR)  # enforce 0600 (O_CREAT mode is umask-masked)
        except OSError:
            pass
        os.replace(tmp, path)  # atomic swap into place
    except OSError:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise


def _store_developer_key(private_material: str) -> None:
    """Cache the escrowed private key locally (0600), ATOMICALLY.

    The server pair is authoritative, so this overwrites the local cache — but never
    silently destroys a DIFFERENT existing key: a non-matching prior key is first
    backed up to ``<path>.legacy`` and the main key is overwritten ONLY if that backup
    SUCCEEDS, so a locally-minted key the server did not adopt is never lost (if the
    backup fails the prior key stays in place and the OSError propagates). Both writes
    are atomic (unique temp + ``os.replace``). Identical content is a no-op.
    """
    path = developer_key_path()
    parent = path.parent
    parent.mkdir(parents=True, exist_ok=True)
    try:
        parent.chmod(stat.S_IRWXU)  # 0700 — owner only
    except OSError:
        pass

    content = private_material.strip() + "\n"
    if path.is_file():
        try:
            current = path.read_text(encoding="utf-8").strip()
        except (OSError, ValueError):
            # ValueError covers UnicodeDecodeError: a corrupt/binary key file is not a
            # usable key, so treat it as "nothing to back up" and let the authoritative
            # key overwrite it — never let a decode error escape and break login.
            current = None
        if current is not None and current == content.strip():
            return  # already the authoritative key — nothing to do
        if current:
            # Preserve the divergent prior key BEFORE overwriting it. If this backup
            # cannot be made durable, refuse to overwrite (propagate) rather than risk
            # losing the only copy of a not-yet-escrowed local key.
            _atomic_write_0600(path.with_name(path.name + ".legacy"), current + "\n")

    _atomic_write_0600(path, content)


def _server_pair_is_consistent(private_material: Any, public_material: Any) -> bool:
    """True iff ``private_material``/``public_material`` are well-formed ed25519
    ``ed25519:<base64>`` strings AND the private key derives EXACTLY the stated public
    key. Guards against caching a corrupt/mismatched server pair (which would silently
    break future signing). Compares raw 32-byte public keys, so base64 encoding
    variants of the same key still match.
    """
    if not (isinstance(private_material, str) and isinstance(public_material, str)):
        return False
    if not private_material.startswith("ed25519:") or not public_material.startswith("ed25519:"):
        return False
    try:
        raw_priv = base64.b64decode(private_material[len("ed25519:"):], validate=True)
        raw_pub = base64.b64decode(public_material[len("ed25519:"):], validate=True)
        if len(raw_priv) != 32 or len(raw_pub) != 32:
            return False
        private_key = Ed25519PrivateKey.from_private_bytes(raw_priv)
        derived = private_key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    except (ValueError, TypeError):
        return False
    return derived == raw_pub


def developer_id_for_account(account_user: dict[str, Any] | None) -> str | None:
    """Derive a stable, server-valid developer_id from the logged-in account.

    Prefers the immutable account id (stable across username changes), falling back
    to username/email/handle. Returns None when no usable identity is present (the
    caller then skips registration rather than minting an anonymous id).
    """
    if not isinstance(account_user, dict):
        return None
    raw = (
        account_user.get("id")
        or account_user.get("username")
        or account_user.get("handle")
        or account_user.get("email")
    )
    if raw is None:
        return None
    # Stable prefix so an id that is purely numeric still starts alphanumeric and is
    # obviously SuperClaw-minted; then sanitize to the server grammar.
    candidate = f"clawhunt-{raw}"
    candidate = _DEVELOPER_ID_BODY.sub("-", candidate)
    candidate = candidate[:_DEVELOPER_ID_MAX]
    if len(candidate) < 2 or not candidate[0].isalnum():
        return None
    return candidate


def ensure_developer_key_registered(
    access_token: str | None,
    account_user: dict[str, Any] | None,
    *,
    client: Any | None = None,
) -> dict[str, Any]:
    """Ensure the account's single ESCROWED developer keypair, caching it locally.

    Server-authoritative recovery (owner's escrow decision): calls the escrow endpoint
    which mints on first use and returns the SAME pair on every device. Any local key
    we already hold is sent so the server can ADOPT it (no row yet) or BACKFILL a
    legacy public-only registration; otherwise the server mints/recovers the canonical
    pair. The returned private key is cached locally (atomically, 0600, prior different
    key backed up to ``.legacy``) for offline signing.

    Best-effort and NON-FATAL: a missing prerequisite, network error, or server
    rejection is returned as ``{"ok": False, ...}`` rather than raised, so login (or a
    pre-upload ensure) never breaks. When the server is unreachable/erroring but a
    local cache exists, signing still works this session (``source: local_cache``).
    """
    if not access_token:
        return {"ok": False, "reason": "not_logged_in"}
    developer_id = developer_id_for_account(account_user)
    if not developer_id:
        return {"ok": False, "reason": "no_account_identity"}

    # Whatever we already hold locally — sent so the server adopts/backfills it. We do
    # NOT mint here; the server is authoritative for the escrowed pair.
    local = _read_local_key_material(developer_key_path())

    try:
        if client is None:
            from superclaw.clawhunt_auth import ClawHuntAccountClient

            client = ClawHuntAccountClient()
        result = client.ensure_hosted_developer_key(
            access_token,
            developer_id,
            private_key=local[0] if local else None,
            public_key=local[1] if local else None,
        )
    except Exception as exc:  # noqa: BLE001 — best-effort; never break login
        # Offline/transient (incl. client construction): a local cache still signs.
        return _ensure_escrow_fallback(developer_id, local, str(exc))

    # FAIL CLOSED unless we see the recognized wrapper ({status_code, ok, body}) with a
    # 2xx ``ok``. Any other shape, or ok=False (e.g. 409 reset_required / 503 escrow
    # off), is NOT success and must never be reported as one (no fake-success).
    if not (isinstance(result, dict) and {"ok", "status_code", "body"} <= set(result)):
        return _ensure_escrow_fallback(developer_id, local, "unexpected ensure response shape")
    if not result.get("ok"):
        return _ensure_escrow_fallback(
            developer_id, local, f"ensure rejected: HTTP {result.get('status_code')}"
        )

    body = result.get("body") if isinstance(result.get("body"), dict) else {}
    server_private = body.get("private_key")
    server_public = body.get("public_key")
    if not (isinstance(server_private, str) and server_private and isinstance(server_public, str) and server_public):
        return _ensure_escrow_fallback(developer_id, local, "ensure response missing key material")
    # Validate the pair before trusting/caching it: a malformed or mismatched private
    # key must NOT be cached (it would silently break future signing / not match the
    # registered public key). Fail closed to the local cache instead.
    if not _server_pair_is_consistent(server_private, server_public):
        return _ensure_escrow_fallback(developer_id, local, "ensure returned inconsistent key material")

    try:
        _store_developer_key(server_private)
    except OSError as exc:
        # The pair exists server-side, but we could NOT persist it to the local cache,
        # so the on-disk key still does not reflect the authoritative pair. Reporting
        # success here would be a fake-success: signing would keep using the stale
        # local key and diverge from the account's registered key. Fail closed (a later
        # ensure retries the write); if a local cache exists it can still sign offline.
        return _ensure_escrow_fallback(developer_id, local, f"cache write failed: {exc}")
    return {
        "ok": True,
        "developer_id": developer_id,
        "keyid": body.get("keyid"),
        "created": body.get("created"),
    }


def _ensure_escrow_fallback(
    developer_id: str, local: tuple[str, str] | None, error: str
) -> dict[str, Any]:
    """Shape the failure result, noting whether a local cache can still sign offline.

    Never reports ``ok: True`` (the server did not confirm), but surfaces
    ``source: local_cache`` so callers can tell a transient/offline failure (signing
    still works) from a hard one (no key at all).
    """
    result: dict[str, Any] = {"ok": False, "developer_id": developer_id, "error": error}
    if local is not None:
        result["source"] = "local_cache"
    return result
