"""Reference Viewer — kernel file-view capability (single source of truth).

Reads a single file's contents from a run's *own* physical checkout so the CLI,
API, and Web/Desktop surfaces all share one governed implementation (CLI is the
kernel baseline; surfaces only render). Design brief + adversarial review trail:
``docs/reference-viewer-panel.md``.

Security posture (fail-closed; every blocker below was forced by the R1/R2
Codex+Gemini design review):

- Trusted root = the run's ``execution_context["repo_path"]`` — the actual
  checkout the run executed against — NOT ``WorkspaceProfile.repo_path`` (which
  is the first-trusted path and goes stale for worktrees; R2-B2).
- The covering workspace must be ACTIVE (``is_trusted``) and, for a real-folder
  managed project, pass the same inode-pin recheck execution uses
  (``assert_execution_repo_safe``); otherwise fail closed (R2-B5/B6).
- Sensitivity is decided BEFORE returning content, in a fixed order — filename
  deny → binary → bounded content secret-scan — and oversize files fail closed
  rather than letting a secret past the scan window slip through (R2-B3). No
  redaction: a sensitive file is denied, never mutated (zero-divergence law).
- Path safety resolves symlinks before containment check and rejects absolute /
  escaping paths early (R1 + advisor gotchas).
- Binary files return metadata only (no content, no download) so nothing
  bypasses ``max_bytes`` or the secret scan (R1-B7).
"""
from __future__ import annotations

import fnmatch
import mimetypes
import os
import stat as stat_mod
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from superclaw.secrets_scan import contains_secret
from superclaw.state import StateStore
from superclaw.workspace_resolver import (
    REAL_FOLDER_CREATION_MODE,
    find_workspace_for_path,
)

__all__ = [
    "FILE_VIEW_MAX_BYTES",
    "FILE_VIEW_SCAN_CAP",
    "FileViewError",
    "FileViewResult",
    "is_sensitive_view_path",
    "read_run_file",
]

#: Default number of bytes returned for display; larger files are truncated and
#: flagged (never rejected for size alone — only the scan cap rejects).
FILE_VIEW_MAX_BYTES = 256 * 1024
#: Upper bound the content secret-scan can cover. A text file larger than this
#: is denied (``sensitive_scan_unbounded``) because we cannot prove the bytes
#: past the window are secret-free — fail closed instead of scanning a prefix.
FILE_VIEW_SCAN_CAP = 4 * 1024 * 1024

#: Stable error codes shared verbatim by CLI / API / Web (contract: surfaces map
#: code -> presentation, never reinvent the set).
FILE_VIEW_ERROR_CODES = (
    "not_found",
    "path_not_allowed",
    "untrusted_workspace",
    "workspace_compromised",
    "sensitive_denied",
    "sensitive_scan_unbounded",
)

#: Filename/glob patterns that are denied before a single byte is read. Matched
#: case-insensitively against every component of the relative path AND the
#: basename, so ``config/.env`` and ``deploy/id_rsa`` are both caught.
_SENSITIVE_NAME_GLOBS = (
    ".env",
    ".env.*",
    "*.pem",
    "*.key",
    "id_rsa",
    "id_rsa.*",
    "id_ed25519",
    "id_ed25519.*",
    "id_ecdsa",
    "id_ecdsa.*",
    "id_dsa",
    "id_dsa.*",
    "*.p12",
    "*.pfx",
    "*.keystore",
    "*.jks",
    "*.gpg",
    "*.asc",
    "*.kdbx",
    "credentials",
    "credentials.*",
    ".netrc",
    ".npmrc",
    ".pypirc",
    ".dockercfg",
    ".htpasswd",
    ".envrc",
    ".git-credentials",
    ".gitconfig",
    ".boto",
    ".s3cfg",
    "secrets",
    "secrets.*",
    "*.sqlite",
    "*.sqlite3",
    "*.db",
)

#: Path *components* that deny the whole subtree — these dirs hold credentials
#: or VCS internals that frequently embed plaintext tokens (.git/config remote
#: URLs, .git-credentials, ssh keys, gnupg/aws material).
_SENSITIVE_DIR_COMPONENTS = frozenset(
    {".ssh", ".git", ".gnupg", ".aws", ".gcloud", ".kube", ".docker"}
)


class FileViewError(Exception):
    """A fail-closed refusal with a stable ``code`` from ``FILE_VIEW_ERROR_CODES``.

    The message is safe to surface (it never echoes the absolute trusted root).
    """

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass
class FileViewResult:
    """Outcome of a successful (allowed) file view.

    ``content`` is ``None`` for binary files — surfaces show metadata and offer
    no download for repo-workspace binaries.
    """

    path: str  # the requested relative path, echoed back (never the abs root)
    mime: str
    is_text: bool
    size_bytes: int
    truncated: bool
    encoding: str  # "utf-8" | "binary"
    content: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def is_sensitive_view_path(rel_path: str) -> bool:
    """True when any component of ``rel_path`` matches the sensitive denylist.

    Checks both glob patterns (per component + basename) and the sensitive-dir
    component set (whole-subtree deny).
    """
    parts = [p for p in Path(rel_path).parts if p not in ("", ".", "..")]
    for part in parts:
        if part.lower() in _SENSITIVE_DIR_COMPONENTS:
            return True
    candidates = parts + [Path(rel_path).name]
    for candidate in candidates:
        lowered = candidate.lower()
        for pattern in _SENSITIVE_NAME_GLOBS:
            if fnmatch.fnmatch(lowered, pattern):
                return True
    return False


def _looks_binary_complete(raw: bytes) -> bool:
    """Binary test for a COMPLETE buffer: NUL byte, else require clean UTF-8."""
    if b"\x00" in raw:
        return True
    try:
        raw.decode("utf-8")
    except UnicodeDecodeError:
        return True
    return False


def _looks_binary_head(raw_head: bytes) -> bool:
    """Binary test for a TRUNCATED head chunk. Only the NUL signal is reliable —
    a strict UTF-8 decode would falsely flag a multi-byte char split at the cut
    boundary (R2 acceptance: oversize text must fail closed, not pose as binary)."""
    return b"\x00" in raw_head


def _read_fd_capped(fd: int, cap: int) -> bytes:
    """Read at most ``cap`` bytes from ``fd`` (bounds memory + scan window)."""
    chunks: list[bytes] = []
    remaining = cap
    while remaining > 0:
        chunk = os.read(fd, min(remaining, 1 << 20))
        if not chunk:
            break
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


_DIR_OPEN_FLAGS = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_DIRECTORY", 0)
# O_NONBLOCK so opening a FIFO returns immediately instead of blocking on a
# writer (the fstat S_ISREG check then refuses it); harmless for regular files.
_FILE_OPEN_FLAGS = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)


def _open_file_within(root_fd: int, rel: str) -> int:
    """Open ``rel`` under the anchor ``root_fd`` as a fd, fail-closed, refusing
    every symlink.

    Walks components with ``openat(dir_fd=..., O_NOFOLLOW)`` starting from the
    *already-validated* root fd, so neither an intermediate symlinked directory
    nor a symlinked final file can redirect the read outside the checkout, and
    the anchor itself cannot be swapped (it is a fd, not a re-resolved path).
    Binding the later fstat/read to the returned fd closes the TOCTOU window.
    Raises ``FileViewError`` on any refusal; caller owns closing both fds.
    """
    parts = [p for p in Path(rel).parts if p not in ("", ".")]
    if any(p == ".." for p in parts) or not parts:
        raise FileViewError("path_not_allowed", "path escapes the run checkout")

    dir_fd = os.dup(root_fd)  # own copy so we can close freely while descending
    try:
        for comp in parts[:-1]:
            try:
                nfd = os.open(comp, _DIR_OPEN_FLAGS, dir_fd=dir_fd)
            except (FileNotFoundError, NotADirectoryError) as exc:
                raise FileViewError("not_found", "file not found in checkout") from exc
            except OSError as exc:
                # ELOOP (symlinked dir under O_NOFOLLOW), EACCES, etc.
                raise FileViewError("path_not_allowed", "path is not a plain file in the checkout") from exc
            os.close(dir_fd)
            dir_fd = nfd
        last = parts[-1]
        try:
            return os.open(last, _FILE_OPEN_FLAGS, dir_fd=dir_fd)
        except FileNotFoundError as exc:
            raise FileViewError("not_found", "file not found in checkout") from exc
        except OSError as exc:
            # ELOOP on a symlinked final component, EACCES, ENXIO, etc.
            raise FileViewError("path_not_allowed", "path is not a plain file in the checkout") from exc
    finally:
        os.close(dir_fd)


def _resolve_trusted_root(store: StateStore, run_id: str) -> int:
    """Open and return the run's validated checkout root as an anchor **fd**.

    The fd is the security anchor: it is opened ``O_NOFOLLOW`` (a root leaf
    swapped to a symlink fails closed) and, for a managed real-folder workspace,
    its live ``(st_dev, st_ino)`` is verified against the pin recorded at
    creation — on the SAME fd that the file walk then descends from, so there is
    no path re-resolution an attacker could swap between check and use. No
    covering ACTIVE workspace -> untrusted. Caller owns closing the fd.
    """
    try:
        session = store.get_run(run_id)
    except KeyError as exc:
        raise FileViewError("not_found", "run not found") from exc

    repo_path = (session.execution_context or {}).get("repo_path")
    if not repo_path:
        raise FileViewError("not_found", "run has no resolved checkout")

    workspace = find_workspace_for_path(store, repo_path)
    if workspace is None or not workspace.is_trusted:
        # run_id is not an authorization boundary on its own: the covering
        # workspace must be a durably-trusted (ACTIVE) container.
        raise FileViewError(
            "untrusted_workspace",
            "run checkout is not covered by a trusted workspace",
        )

    try:
        root_fd = os.open(os.fspath(repo_path), _DIR_OPEN_FLAGS)
    except OSError as exc:
        # Missing, or replaced by a symlink (O_NOFOLLOW -> ELOOP), or no longer a
        # directory: the anchor is gone -> fail closed.
        raise FileViewError(
            "workspace_compromised", "run checkout is missing or was replaced"
        ) from exc

    # Managed real-folder workspaces carry a durable inode pin (recorded at
    # creation); verify the live anchor fd against it — the same fd the walk then
    # descends from, so there is no path re-resolution to swap. This is the
    # kernel's existing execution-time guarantee (assert_managed_dir_unchanged),
    # applied here on the anchor fd. NOTE (parity bound): a REPO workspace has no
    # such durable inode pin anywhere in the kernel — execution itself
    # (assert_execution_repo_safe) only pins managed real-folders — so a REPO
    # checkout root swapped for a *different real directory* is detected no more
    # here than at execution. Symlink swaps are closed (O_NOFOLLOW). Pinning REPO
    # roots is a kernel-wide hardening tracked as follow-up in
    # docs/reference-viewer-panel.md, not bolted onto this read path where the
    # per-run execution_context (rebuilt across the run lifecycle) cannot hold it
    # reliably.
    try:
        meta = workspace.metadata or {}
        if meta.get("creation_mode") == REAL_FOLDER_CREATION_MODE:
            dir_pin = meta.get("dir_pin") or {}
            st = os.fstat(root_fd)
            if (
                dir_pin.get("dev") is None
                or dir_pin.get("ino") is None
                or st.st_dev != dir_pin.get("dev")
                or st.st_ino != dir_pin.get("ino")
            ):
                raise FileViewError(
                    "workspace_compromised",
                    "run checkout no longer matches its pinned identity",
                )
    except BaseException:
        os.close(root_fd)
        raise

    return root_fd


def _read_within_posix(store: StateStore, run_id: str, rel: str) -> tuple[bytes, int]:
    """POSIX read: fd-anchored, symlink-refusing, TOCTOU-closed. Returns (raw, size)."""
    root_fd = _resolve_trusted_root(store, run_id)
    try:
        # fd-bound, symlink-refusing open anchored at the validated root fd.
        fd = _open_file_within(root_fd, rel)
        try:
            st = os.fstat(fd)
            # regular files only — refuse dirs, FIFOs, devices, sockets.
            if not stat_mod.S_ISREG(st.st_mode):
                raise FileViewError("not_found", "path is not a regular file")
            # hard-link alias guard: a benign name hard-linked to a sensitive inode
            # (``ln .env harmless.txt``) bypasses the name denylist; refuse >1 link.
            if st.st_nlink > 1:
                raise FileViewError("path_not_allowed", "file has multiple hard links")
            size = st.st_size
            # Read at most SCAN_CAP+1 from the SAME fd (bounds memory + scan).
            try:
                raw = _read_fd_capped(fd, FILE_VIEW_SCAN_CAP + 1)
            except OSError as exc:
                raise FileViewError("not_found", "file could not be read") from exc
        finally:
            os.close(fd)
    finally:
        os.close(root_fd)
    return raw, size


def _resolve_trusted_root_path_windows(store: StateStore, run_id: str) -> str:
    """Windows counterpart of :func:`_resolve_trusted_root`, returning a validated
    *real path* instead of an fd.

    Windows ``os.open`` cannot open a directory as a file descriptor and has no
    ``O_NOFOLLOW`` / ``openat`` (``dir_fd=``), so the POSIX fd anchor is
    unavailable. Same trust gate (covering workspace must be ACTIVE) and same
    durable inode pin (``st_dev``/``st_ino``, populated on Windows) recheck for a
    managed real-folder; the leaf-symlink refusal is done with ``os.path.islink``
    instead of ``O_NOFOLLOW``.
    """
    try:
        session = store.get_run(run_id)
    except KeyError as exc:
        raise FileViewError("not_found", "run not found") from exc
    repo_path = (session.execution_context or {}).get("repo_path")
    if not repo_path:
        raise FileViewError("not_found", "run has no resolved checkout")
    workspace = find_workspace_for_path(store, repo_path)
    if workspace is None or not workspace.is_trusted:
        raise FileViewError(
            "untrusted_workspace",
            "run checkout is not covered by a trusted workspace",
        )
    raw_root = os.fspath(repo_path)
    if os.path.islink(raw_root) or not os.path.isdir(raw_root):
        # Missing, replaced by a symlink, or no longer a directory -> fail closed.
        raise FileViewError("workspace_compromised", "run checkout is missing or was replaced")
    root_real = os.path.realpath(raw_root)
    meta = workspace.metadata or {}
    if meta.get("creation_mode") == REAL_FOLDER_CREATION_MODE:
        dir_pin = meta.get("dir_pin") or {}
        st = os.stat(root_real)
        if (
            dir_pin.get("dev") is None
            or dir_pin.get("ino") is None
            or st.st_dev != dir_pin.get("dev")
            or st.st_ino != dir_pin.get("ino")
        ):
            raise FileViewError(
                "workspace_compromised",
                "run checkout no longer matches its pinned identity",
            )
    return root_real


def _read_within_windows(store: StateStore, run_id: str, rel: str) -> tuple[bytes, int]:
    """Windows read: realpath-containment + no-reparse-point + inode pin.

    Re-establishes the POSIX guarantees without ``dir_fd``/``O_NOFOLLOW`` (absent
    on Windows): the resolved target must stay inside the trusted root
    (containment, which also rejects ``..`` escapes) and ``realpath`` must equal
    the lexical path (any symlink/junction traversed -> refuse, the NTFS stand-in
    for ``O_NOFOLLOW`` — this also blocks an in-checkout alias to a sensitive file
    slipping past the name denylist). Accepts the documented slightly-wider TOCTOU
    window vs. the fd anchor; the owner-only NTFS ACL on the user-profile workspace
    root is the mitigation (see docs/windows-support-assessment.md). Returns (raw, size).
    """
    root_real = _resolve_trusted_root_path_windows(store, run_id)
    parts = [p for p in Path(rel).parts if p not in ("", ".")]
    if not parts or any(p == ".." for p in parts):
        raise FileViewError("path_not_allowed", "path escapes the run checkout")
    candidate = os.path.normpath(os.path.join(root_real, *parts))
    root_nc = os.path.normcase(root_real)
    cand_nc = os.path.normcase(candidate)
    if cand_nc != root_nc and not cand_nc.startswith(root_nc + os.sep):
        raise FileViewError("path_not_allowed", "path escapes the run checkout")
    # No symlink/junction may have been traversed: realpath (resolves every reparse
    # point) must equal the lexical candidate (case-normalized).
    if os.path.normcase(os.path.realpath(candidate)) != cand_nc:
        raise FileViewError("path_not_allowed", "path is not a plain file in the checkout")
    try:
        st = os.lstat(candidate)
    except (FileNotFoundError, NotADirectoryError) as exc:
        raise FileViewError("not_found", "file not found in checkout") from exc
    except OSError as exc:
        raise FileViewError("path_not_allowed", "path is not a plain file in the checkout") from exc
    if stat_mod.S_ISLNK(st.st_mode):
        raise FileViewError("path_not_allowed", "path is not a plain file in the checkout")
    if not stat_mod.S_ISREG(st.st_mode):
        raise FileViewError("not_found", "path is not a regular file")
    if st.st_nlink > 1:
        raise FileViewError("path_not_allowed", "file has multiple hard links")
    try:
        with open(candidate, "rb") as fh:
            raw = fh.read(FILE_VIEW_SCAN_CAP + 1)
    except OSError as exc:
        raise FileViewError("not_found", "file could not be read") from exc
    return raw, st.st_size


def _finalize_file_view(rel: str, name: str, raw: bytes, size: int, max_bytes: int) -> FileViewResult:
    """Shared post-read sensitivity ladder: oversize -> binary -> secret-scan."""
    mime, _ = mimetypes.guess_type(name)
    octet = mime or "application/octet-stream"

    # oversize: cannot fully scan -> binary returns metadata, text fails closed.
    if len(raw) > FILE_VIEW_SCAN_CAP:
        if _looks_binary_head(raw):
            return FileViewResult(
                path=rel, mime=octet, is_text=False, size_bytes=size,
                truncated=False, encoding="binary", content=None,
            )
        raise FileViewError(
            "sensitive_scan_unbounded",
            "text file exceeds the secret-scan bound and cannot be served",
        )

    # binary (complete buffer) -> metadata only, no content, no download.
    if _looks_binary_complete(raw):
        return FileViewResult(
            path=rel, mime=octet, is_text=False, size_bytes=size,
            truncated=False, encoding="binary", content=None,
        )

    # bounded content secret-scan over the full (<= scan cap) text.
    text = raw.decode("utf-8", errors="replace")
    if contains_secret(text):
        raise FileViewError("sensitive_denied", "file content matched a secret pattern")

    truncated = len(raw) > max_bytes
    # errors='replace' absorbs a multi-byte char split by the byte truncation.
    content = raw[:max_bytes].decode("utf-8", errors="replace") if truncated else text
    text_mime = mime or "text/plain"
    if name.lower().endswith((".md", ".markdown")):
        text_mime = "text/markdown"
    return FileViewResult(
        path=rel,
        mime=text_mime,
        is_text=True,
        size_bytes=size,
        truncated=truncated,
        encoding="utf-8",
        content=content,
    )


def read_run_file(
    store: StateStore,
    run_id: str,
    rel_path: str,
    *,
    max_bytes: int = FILE_VIEW_MAX_BYTES,
) -> FileViewResult:
    """Read ``rel_path`` from run ``run_id``'s trusted checkout, fail-closed.

    Raises ``FileViewError`` (with a stable ``code``) on any refusal.
    """
    rel = str(rel_path)
    # Reject absolute / NUL / empty / home-relative early and explicitly (a stray
    # absolute path would make ``root / rel`` discard the root entirely).
    if not rel or "\x00" in rel or os.path.isabs(rel) or rel.startswith("~"):
        raise FileViewError("path_not_allowed", "path is not a relative file in the checkout")

    # 1) filename/path sensitivity deny — before opening. Checked on the literal
    #    request; the no-symlink fd walk below guarantees the request maps to a
    #    real file at that very path (no symlink indirection to a sensitive one).
    if is_sensitive_view_path(rel):
        raise FileViewError("sensitive_denied", "file is on the sensitive denylist")

    name = Path(rel).name
    # 2/3) regular-file + hard-link + symlink refusal happen inside the per-OS
    #      reader; POSIX anchors on a fd (openat/O_NOFOLLOW), Windows on realpath
    #      containment (no dir_fd on Windows). Both return the capped raw bytes.
    if os.name == "nt":
        raw, size = _read_within_windows(store, run_id, rel)
    else:
        raw, size = _read_within_posix(store, run_id, rel)
    # 4/5/6) shared sensitivity ladder: oversize -> binary -> bounded secret scan.
    return _finalize_file_view(rel, name, raw, size, max_bytes)
