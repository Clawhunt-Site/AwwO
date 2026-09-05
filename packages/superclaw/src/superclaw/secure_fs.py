"""Cross-platform owner-only filesystem hardening (fail-closed, not fail-open).

POSIX expresses "owner-only" with mode bits (``chmod 0o700`` for a dir, ``0o600``
for a file). NTFS has no POSIX mode bits, so ``os.chmod(path, 0o700)`` on Windows
is a near no-op (only the read-only bit is honored) — a secret directory keeps
its *inherited* ACL and the fail-closed promise ("only the owner can read the
relay key / access token") is silently broken. SuperClaw's governance is
fail-closed by design (see ``CLAUDE.md``), so we MUST NOT degrade to fail-open
on Windows.

This module gives one primitive — :func:`harden_path` — that restricts a path to
the CURRENT USER ONLY on both platforms:

* POSIX → ``os.chmod`` with the requested mode.
* Windows → ``icacls`` (built in, no dependency): disable inheritance and grant
  the current user Full control with NO other ACEs.

It returns ``True`` when a real restriction was applied and ``False`` (with a
WARNING log — never silent) when it could only partially harden, so callers that
need a hard guarantee can react instead of assuming "skipped == safe".
"""

from __future__ import annotations

import logging
import os
import subprocess
from pathlib import Path

logger = logging.getLogger(__name__)

__all__ = ["harden_path", "DIR_MODE", "FILE_MODE"]

DIR_MODE = 0o700
FILE_MODE = 0o600


def harden_path(path: str | os.PathLike[str], *, is_dir: bool | None = None) -> bool:
    """Restrict ``path`` to the current user only. Returns True if a real
    restriction was applied; False (logged WARNING) if it degraded.

    ``is_dir`` selects the POSIX mode (0o700 vs 0o600); when ``None`` it is
    inferred from the path. On Windows the directory/file distinction only
    affects inheritance flags.
    """
    p = Path(path)
    if is_dir is None:
        is_dir = p.is_dir()
    if os.name == "nt":
        return _harden_windows(p, is_dir=is_dir)
    return _harden_posix(p, is_dir=is_dir)


def _harden_posix(p: Path, *, is_dir: bool) -> bool:
    try:
        os.chmod(p, DIR_MODE if is_dir else FILE_MODE)
        return True
    except OSError as exc:  # pragma: no cover - environment dependent
        logger.warning("could not chmod %s to owner-only: %s", p, exc)
        return False


def _current_windows_principal() -> str | None:
    """The icacls principal for the current user (``DOMAIN\\user``).

    Prefers the authoritative token name from ``whoami`` (handles domain,
    Microsoft, and renamed local accounts); falls back to the environment.
    """
    try:
        out = subprocess.run(
            ["whoami"], capture_output=True, text=True, check=True
        ).stdout.strip()
        if out:
            return out
    except (OSError, subprocess.SubprocessError):  # pragma: no cover
        pass
    user = os.environ.get("USERNAME")
    if not user:
        return None
    domain = os.environ.get("USERDOMAIN")
    return f"{domain}\\{user}" if domain else user


def _harden_windows(p: Path, *, is_dir: bool) -> bool:  # pragma: no cover - Windows only
    principal = _current_windows_principal()
    if not principal:
        logger.warning(
            "could not resolve current Windows user to harden %s; "
            "directory keeps its inherited ACL (fail-open avoided: surfaced here)",
            p,
        )
        return False
    target = str(p)
    # (OI)(CI)F = object- and container-inherit, Full control — for a directory so
    # children created later inherit the owner-only ACL; a bare F for a file.
    grant = f"{principal}:(OI)(CI)F" if is_dir else f"{principal}:F"
    try:
        # /inheritance:r removes ALL inherited ACEs (the broad default), then we
        # grant the current user only — the NTFS equivalent of chmod 0o700/0o600.
        subprocess.run(
            ["icacls", target, "/inheritance:r", "/grant:r", grant],
            capture_output=True,
            text=True,
            check=True,
        )
        return True
    except (OSError, subprocess.CalledProcessError) as exc:
        detail = getattr(exc, "stderr", "") or str(exc)
        logger.warning(
            "icacls hardening of %s failed (%s); the path may retain a broader "
            "ACL — treat as a weakened posture, not a silent success",
            p,
            detail.strip(),
        )
        return False
