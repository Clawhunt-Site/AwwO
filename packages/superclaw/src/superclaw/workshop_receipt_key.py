"""Provision the local workshop-receipt HMAC key shared between the Python download bridge
(the signer) and the co-launched Node import (the verifier).

The receipt HMAC is the trust handoff of the workshop install: a valid HMAC + a matching
``app_env`` is what lets the Node S4 importer treat the staged bytes AND the official
verdict as vouched-for by the Python verification gate. The key is therefore a HIGH-VALUE
local secret — anyone who can read it can forge an ``official:true`` receipt and install an
arbitrary "official" capability. It is:

  - generated/owned by the co-launch supervisor (``node_runtime``), stored 0600 under
    ``SUPERCLAW_HOME/.secrets/`` (never ``PAPERCLIP_HOME`` — it is not upstream Node config);
  - read-only for consumers (the FastAPI install route);
  - fail-closed on ANY owner / permission / symlink / format anomaly (refused, never used),
    and hardened against same-directory races (final-path ``O_EXCL`` on create; ``O_NOFOLLOW``
    + ``fstat`` of the open fd on read — never an lstat-then-reopen TOCTOU);
  - NEVER inherited by a plugin/agent subprocess — the supervisor injects it ONLY into the
    Node server child, which scrubs it at boot, and subprocess env builders strip it.

Both advisors (Codex + agy) converged on this file-anchored, fail-closed design; Codex's
adversarial pass tightened it to fd-validated reads + O_EXCL creation + a strict key format.
"""

from __future__ import annotations

import errno
import os
import re
import secrets
import stat
from pathlib import Path

from superclaw.environment import superclaw_data_path

WORKSHOP_RECEIPT_HMAC_KEY_ENV = "SUPERCLAW_WORKSHOP_RECEIPT_HMAC_KEY"
# Node receives the FILE PATH of the key (not the value) under this env var and reads the key
# from the 0600 file, so the secret never enters Node's process.env (and thus no Node-spawned
# child can inherit it). See node_runtime._inject_workshop_receipt_config + workshop-receipt.ts.
WORKSHOP_RECEIPT_KEY_FILE_ENV = "SUPERCLAW_WORKSHOP_RECEIPT_KEY_FILE"
# The key is exactly ``secrets.token_hex(32)`` — 64 lowercase hex chars (256 bits). Loading
# requires this exact shape so a weak-but-long string can never sit at the trust boundary.
_KEY_RE = re.compile(r"\A[0-9a-f]{64}\Z")

# Windows portability. NTFS has no POSIX mode bits: a writable file always reports
# 0o666 and a dir 0o777, so the exact-mode gates (& 0o177 / & 0o077) can never hold and
# are skipped on Windows. There, ``.secrets`` lives under ``%USERPROFILE%\.superclaw``,
# whose inherited ACL already excludes other standard users (only the user + SYSTEM +
# Administrators) — the same practical owner-only isolation 0600 gives on POSIX. We do
# NOT run ``icacls`` to tighten it further here because provisioning sits on the Node-spawn
# hot path (node_runtime._inject_workshop_receipt_config), where a subprocess is expressly
# disallowed (see the relay-key note in NodeServerSupervisor.build_env). The load-bearing
# fail-closed gates (regular-file, symlink/hard-link, strict 64-hex format) run everywhere.
# ``O_NOFOLLOW`` / ``os.getuid`` / ``os.fchmod`` are POSIX-only; ``getattr``/``hasattr``
# degrade them to no-ops on Windows, where a symlink at the key path is rejected explicitly.
_IS_WINDOWS = os.name == "nt"
_O_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
_O_BINARY = getattr(os, "O_BINARY", 0)  # avoid CRLF translation of the key bytes on Windows


class WorkshopReceiptKeyError(RuntimeError):
    """The workshop receipt key could not be provisioned/read safely (fail-closed)."""


def workshop_receipt_key_path() -> Path:
    """``SUPERCLAW_HOME/.secrets/workshop_hmac.key`` (respects SUPERCLAW_HOME)."""
    return superclaw_data_path(".secrets", "workshop_hmac.key")


def _validate_file_stat(st: os.stat_result, path: Path) -> None:
    """Fail closed unless ``st`` (from ``fstat`` of an already-open fd) is a regular,
    current-user-owned, single-link, 0400/0600 file (no exec / group / other bits)."""
    if not stat.S_ISREG(st.st_mode):
        raise WorkshopReceiptKeyError(f"workshop key is not a regular file: {path}")
    if hasattr(os, "getuid") and st.st_uid != os.getuid():
        raise WorkshopReceiptKeyError(f"workshop key is not owned by the current user: {path}")
    # No owner-exec (0o100) and no group/other bits (0o077): only r/w for the owner.
    # NTFS has no POSIX mode bits (a writable file reports 0o666), so owner-only is
    # enforced by the ACL applied when the key is written and this bit check is skipped.
    if not _IS_WINDOWS and stat.S_IMODE(st.st_mode) & 0o177:
        raise WorkshopReceiptKeyError(f"workshop key must be 0600 (owner r/w only): {path}")
    if st.st_nlink != 1:
        raise WorkshopReceiptKeyError(f"workshop key must not be hard-linked (nlink={st.st_nlink}): {path}")


def _read_key_fd(path: Path) -> str:
    """Open the key ONCE with ``O_NOFOLLOW`` (reject a symlink at the final component),
    validate the fstat of that fd, then read from the SAME fd — no lstat-then-reopen gap."""
    # Windows has no O_NOFOLLOW; reject a symlink at the final component explicitly. The
    # owner-only .secrets dir (inherited %USERPROFILE% ACL) narrows the swap window that
    # O_NOFOLLOW closes atomically on POSIX — only the current user can replace an entry in it.
    if _IS_WINDOWS and os.path.islink(path):
        raise WorkshopReceiptKeyError(f"workshop key must not be a symlink: {path}")
    try:
        fd = os.open(path, os.O_RDONLY | _O_NOFOLLOW | _O_BINARY)
    except OSError as exc:
        if exc.errno in (errno.ELOOP, errno.EMLINK):
            raise WorkshopReceiptKeyError(f"workshop key must not be a symlink: {path}") from exc
        if exc.errno == errno.ENOENT:
            raise WorkshopReceiptKeyError(f"workshop key disappeared: {path}") from exc
        raise WorkshopReceiptKeyError(f"workshop key is unreadable: {exc}") from exc
    try:
        _validate_file_stat(os.fstat(fd), path)
        data = os.read(fd, 8192)
    finally:
        os.close(fd)
    key = data.decode("utf-8", errors="replace").strip()
    if not _KEY_RE.match(key):
        raise WorkshopReceiptKeyError("workshop key is not the expected 64-hex format (corrupt?)")
    return key


def _ensure_safe_secrets_dir() -> Path:
    """Return a current-user-owned, 0700, non-symlink ``.secrets`` dir, creating it if
    absent. Fail closed on a symlinked / non-dir / wrong-owner / group-or-other-accessible
    parent (a writable parent could replace/unlink a 0600 key)."""
    parent = workshop_receipt_key_path().parent
    if not os.path.lexists(parent):
        parent.mkdir(parents=True, exist_ok=True)
        os.chmod(parent, stat.S_IRWXU)  # 0700 (POSIX); no-op on NTFS (see inherited-ACL note above)
    st = parent.lstat()
    if stat.S_ISLNK(st.st_mode):
        raise WorkshopReceiptKeyError(f".secrets must not be a symlink: {parent}")
    if not stat.S_ISDIR(st.st_mode):
        raise WorkshopReceiptKeyError(f".secrets is not a directory: {parent}")
    if hasattr(os, "getuid") and st.st_uid != os.getuid():
        raise WorkshopReceiptKeyError(f".secrets is not owned by the current user: {parent}")
    # POSIX group/other-accessible gate. NTFS reports 0o777 for every dir, so this bit check
    # cannot hold; on Windows owner-only comes from the inherited %USERPROFILE% ACL instead.
    if not _IS_WINDOWS and stat.S_IMODE(st.st_mode) & 0o077:
        raise WorkshopReceiptKeyError(f".secrets is group/other-accessible (must be 0700): {parent}")
    return parent


def read_workshop_receipt_key() -> str | None:
    """Read-only consumer (FastAPI install route): the provisioned key, or ``None`` if it
    has not been provisioned. A symlink/broken-symlink at the path is an ANOMALY (raises),
    never silently treated as absent."""
    path = workshop_receipt_key_path()
    if not os.path.lexists(path):
        return None
    return _read_key_fd(path)


def ensure_workshop_receipt_key() -> str:
    """Supervisor (node_runtime): load the existing key (fail-closed) or atomically create a
    fresh 0600 key. Race-safe: the final path is created with ``O_CREAT|O_EXCL|O_NOFOLLOW``,
    so two concurrent supervisors converge on a single key (the loser reads the winner)."""
    path = workshop_receipt_key_path()
    if os.path.lexists(path):
        return _read_key_fd(path)
    _ensure_safe_secrets_dir()
    try:
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY | _O_NOFOLLOW | _O_BINARY, 0o600)
    except FileExistsError:
        return _read_key_fd(path)  # lost the create race — read the winner
    except OSError as exc:
        if exc.errno in (errno.ELOOP, errno.EMLINK):
            raise WorkshopReceiptKeyError(f"workshop key path is a symlink: {path}") from exc
        raise WorkshopReceiptKeyError(f"could not create workshop key: {exc}") from exc
    try:
        if hasattr(os, "fchmod"):
            os.fchmod(fd, stat.S_IRUSR | stat.S_IWUSR)  # enforce 0600 (O_CREAT mode is umask-masked)
        # fchmod is POSIX-only; on NTFS the file inherits the owner-only %USERPROFILE% ACL.
        os.write(fd, (secrets.token_hex(32) + "\n").encode("ascii"))
        os.fsync(fd)
    finally:
        os.close(fd)
    return _read_key_fd(path)
