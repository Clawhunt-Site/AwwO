"""Workspace resolution: repo identity, dangerous roots, trust-gated lookup.

Single definition point for how a chat/run finds its workspace (ADR:
docs/workspace-trust-container.md). Every surface (CLI, API, Web) must call
through these functions — surfaces never infer workspace membership on their
own.

Resolution order:

1. Explicit ``--workspace <id>`` always wins (must exist and be trusted).
2. A repo/cwd is matched against registered workspaces by repo-identity
   fingerprint (git common dir + remote URL), so multiple worktrees of one
   project resolve to the same workspace.
3. An unknown repo never creates a workspace silently: interactive surfaces
   may prompt (trust-as-creation), non-interactive surfaces fail closed with
   ``WORKSPACE_TRUST_REQUIRED``.
4. No repo at all falls back to the built-in managed Chat workspace.
"""

from __future__ import annotations

import os
import re
import stat
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from time import time
from typing import TYPE_CHECKING, Any, Literal

from .models import WorkspaceKind, WorkspaceProfile, WorkspaceTrustStatus

if TYPE_CHECKING:  # pragma: no cover - import cycle guard
    from .state import StateStore

#: Error code surfaces must propagate when a resolution returns
#: ``trust_required`` on a non-interactive path (API/Web/background). The
#: resolver itself never raises — ``WorkspaceResolution.status`` is the only
#: signaling mechanism; surfaces translate it.
WORKSPACE_TRUST_REQUIRED = "WORKSPACE_TRUST_REQUIRED"

# Built-in managed Chat workspace (Codex-desktop-style scratch home for pure
# chats). Identified by metadata marker, not by name, so renames are safe.
CHAT_WORKSPACE_MARKER = "chat"

#: Directory names that mark a directory as "project shaped". Trusting an
#: arbitrary directory without any of these is rejected — use the managed
#: Chat workspace for non-project chats instead.
PROJECT_MARKERS = (
    ".git",
    ".hg",
    ".svn",
    "package.json",
    "pyproject.toml",
    "Cargo.toml",
    "go.mod",
    "pom.xml",
    "build.gradle",
    "CMakeLists.txt",
    "Makefile",
)


class WorkspaceRootRejected(ValueError):
    """Raised when a path may not become a workspace root (fail-closed)."""


def _dangerous_roots() -> set[str]:
    home = Path.home()
    roots = {
        os.path.realpath(os.sep),
        os.path.realpath(str(home)),
        os.path.realpath(str(home / "Desktop")),
        os.path.realpath(str(home / "Documents")),
        os.path.realpath(str(home / "Downloads")),
    }
    return roots


def _run_git(repo: Path, *args: str) -> str | None:
    try:
        result = subprocess.run(
            ["git", "-C", str(repo), *args],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0:
        return None
    output = result.stdout.strip()
    return output or None


def resolve_repo_identity(path: str | os.PathLike[str]) -> dict[str, Any]:
    """Compute the identity fingerprint inputs for a directory.

    Returns ``{"canonical_path", "git_common_dir", "remote_url", "is_git"}``.
    ``git_common_dir`` is the realpath of the shared .git directory, which is
    identical across worktrees of the same repository.
    """
    canonical = os.path.realpath(os.path.abspath(os.path.expanduser(str(path))))
    repo = Path(canonical)
    common_dir = _run_git(repo, "rev-parse", "--git-common-dir")
    if common_dir is not None and not os.path.isabs(common_dir):
        common_dir = os.path.join(canonical, common_dir)
    if common_dir is not None:
        common_dir = os.path.realpath(common_dir)
    remote_url = _run_git(repo, "remote", "get-url", "origin") if common_dir else None
    return {
        "canonical_path": canonical,
        "git_common_dir": common_dir,
        "remote_url": remote_url,
        "is_git": common_dir is not None,
    }


def repo_fingerprint(identity: dict[str, Any]) -> str:
    """Stable identity key: worktrees/symlinks of one project share it.

    The key combines remote URL and git common dir (per ADR): worktrees share
    the common dir so they normalize together, while independent clones of
    the same remote (e.g. template repos that kept ``origin``) stay separate
    workspaces, matching the Claude Code / Codex per-checkout precedent.
    """
    remote = identity.get("remote_url")
    common = identity.get("git_common_dir")
    if remote and common:
        return f"remote:{remote}|gitdir:{common}"
    if common:
        return f"gitdir:{common}"
    return f"path:{identity.get('canonical_path', '')}"


def assert_safe_workspace_root(path: str | os.PathLike[str]) -> dict[str, Any]:
    """Fail-closed gate for trust-as-creation. Returns the repo identity.

    Rejects dangerous roots (filesystem root, HOME, Desktop/Documents/
    Downloads) and directories without any project marker, so a stray "y" on
    a trust prompt can never hand an agent the user's home directory.
    """
    identity = resolve_repo_identity(path)
    canonical = identity["canonical_path"]
    if not os.path.isdir(canonical):
        raise WorkspaceRootRejected(f"not a directory: {canonical}")
    # Path.anchor catches every drive/volume root cross-platform (D:\ on
    # Windows is not covered by the os.sep entry in _dangerous_roots()).
    if canonical in _dangerous_roots() or str(Path(canonical)) == Path(canonical).anchor:
        raise WorkspaceRootRejected(
            f"refusing to trust top-level directory {canonical}; "
            "pick the project directory itself"
        )
    if not identity["is_git"] and not any(
        os.path.exists(os.path.join(canonical, marker)) for marker in PROJECT_MARKERS
    ):
        raise WorkspaceRootRejected(
            f"{canonical} has no project markers ({', '.join(PROJECT_MARKERS[:4])}, ...); "
            "non-project chats belong in the managed Chat workspace"
        )
    return identity


def find_workspace_for_path(
    store: "StateStore", path: str | os.PathLike[str]
) -> WorkspaceProfile | None:
    """Match a directory to a registered workspace by identity fingerprint.

    Precedence: repo fingerprint (worktree-safe) over canonical repo_path.
    Managed workspaces only match by their own path, never by fingerprint
    accident, because their identity is recorded at creation like any other.
    """
    identity = resolve_repo_identity(path)
    fingerprint = repo_fingerprint(identity)
    path_match: WorkspaceProfile | None = None
    for workspace in store.list_workspace_profiles():
        stored_identity = workspace.repo_identity or {}
        if stored_identity and repo_fingerprint(stored_identity) == fingerprint:
            return workspace
        stored_path = os.path.realpath(
            os.path.abspath(os.path.expanduser(workspace.repo_path))
        )
        if path_match is None and stored_path == identity["canonical_path"]:
            path_match = workspace
    return path_match


def default_chat_workspace_root() -> Path:
    return Path(
        os.environ.get("SUPERCLAW_CHAT_WORKSPACE_ROOT", str(Path.home() / ".superclaw" / "chats"))
    )


def default_personal_workspace_root() -> Path:
    return Path(
        os.environ.get(
            "SUPERCLAW_PERSONAL_WORKSPACE_ROOT", str(Path.home() / ".superclaw" / "workspaces")
        )
    )


def default_project_workspace_root() -> Path:
    """Visible home for personal project folders (Codex-like, Finder-visible).

    A managed personal project is materialized here as ``<root>/<slug>`` instead
    of the old hidden ``~/.superclaw/workspaces/<id>`` scratch, so the user owns
    a real folder they can see and use. Overridable for tests/deployment via
    ``SUPERCLAW_PROJECT_ROOT``.
    """
    return Path(os.environ.get("SUPERCLAW_PROJECT_ROOT", str(Path.home() / "SuperClaw")))


# Marker stamped on workspaces created with the visible real-folder model, so the
# execution-time integrity recheck (assert_managed_dir_unchanged) applies ONLY to
# them — legacy hidden-scratch managed workspaces and repo workspaces are untouched.
REAL_FOLDER_CREATION_MODE = "real_folder_v1"


class WorkspaceDirCompromised(RuntimeError):
    """A real-folder workspace's directory no longer matches its pinned inode.

    Raised fail-closed at every execution entry: the directory was deleted,
    replaced (e.g. swapped for a symlink to a sensitive path), or its identity
    otherwise changed since creation. The run is refused, never re-materialized.
    """


def _project_slug(name: str) -> str:
    """Folder leaf name for a project display name. Unicode is preserved (你好 →
    你好); path separators, control chars and dangerous tokens are neutralized so
    the slug is always a single, traversal-safe path component."""
    slug = name.strip()
    # Replace path separators / control chars / shell-hostile punctuation with '-'.
    slug = re.sub(r"[\\/\x00-\x1f:*?\"<>|]", "-", slug)
    slug = re.sub(r"\s+", " ", slug).strip()
    slug = re.sub(r"-{2,}", "-", slug).strip("-. ")
    if not slug or slug in {".", ".."} or "/" in slug or os.sep in slug or len(slug) > 80:
        raise WorkspaceRootRejected(f"cannot derive a safe folder name from {name!r}")
    return slug


def _assert_dir_fd_safe(fd: int, label: str, *, require_owner: bool) -> os.stat_result:
    """Fail-closed checks on an O_NOFOLLOW-opened dir fd: it is a real directory,
    not group/other-writable *without* the sticky bit (a sticky world-writable dir
    like /tmp=1777 can't be used to swap our child, a non-sticky one can), and —
    for app-owned roots/leaves — owned by the current user."""
    st = os.fstat(fd)
    if not stat.S_ISDIR(st.st_mode):
        raise WorkspaceRootRejected(f"{label} is not a directory")
    if os.name == "nt":
        # The POSIX uid/mode-bit ownership model has no NTFS equivalent here:
        # os.getuid does not exist on Windows (it would raise AttributeError),
        # and os.stat synthesizes mode bits so the group/other-writable test
        # below would misfire on every ordinary directory. Workspace trust on
        # Windows is governed by NTFS ACLs on the user profile, not these bits;
        # existing-and-a-directory is the gate. (See windows-support-assessment.)
        return st
    # group/other-writable is a swap surface — UNLESS the sticky bit is set, which
    # means only a file's own owner (us) may rename/delete it (e.g. /tmp = 1777).
    # A sticky world-writable ancestor can't be used to swap our child; a
    # NON-sticky one can, so it stays fail-closed.
    if (st.st_mode & 0o022) and not (st.st_mode & stat.S_ISVTX):
        raise WorkspaceRootRejected(f"{label} is group/other-writable without the sticky bit")
    if require_owner:
        # The app-owned root/leaf must be ours.
        if st.st_uid != os.getuid():
            raise WorkspaceRootRejected(f"{label} is not owned by the current user")
    elif st.st_uid not in (os.getuid(), 0):
        # An ancestor owned by ANOTHER non-root user could rename/swap a child
        # mid-walk (the parent perms gate group/other, not the owner). Require
        # every ancestor be ours or root's (trusted) — fail-closed otherwise.
        raise WorkspaceRootRejected(f"{label} is owned by an untrusted user (uid {st.st_uid})")
    return st


_O_NOFOLLOW_DIR = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)


def _secure_open_project_root(resolved_root: Path) -> int:
    """Open (creating if absent) the project root by walking its already
    symlink-resolved path component-by-component with O_NOFOLLOW + dir_fd, so no
    ancestor symlink/rename can redirect us (TOCTOU-safe). Each ancestor must be
    non-symlink and not swappable by an untrusted party (group/other-writable
    without the sticky bit is rejected); the leaf root must also be ours.
    Caller owns the returned fd."""
    parts = resolved_root.parts
    if not parts or parts[0] != os.sep:
        raise WorkspaceRootRejected(f"project root must be an absolute path: {resolved_root}")
    fd = os.open(parts[0], _O_NOFOLLOW_DIR)
    try:
        last = len(parts) - 1
        for i, comp in enumerate(parts[1:], start=1):
            try:
                child = os.open(comp, _O_NOFOLLOW_DIR, dir_fd=fd)
            except FileNotFoundError:
                os.mkdir(comp, mode=0o700, dir_fd=fd)
                child = os.open(comp, _O_NOFOLLOW_DIR, dir_fd=fd)
            os.close(fd)
            fd = child
            # Ancestors: reject non-sticky group/other-writable (swap surface);
            # the final root must additionally be owned by us (it is our app home).
            _assert_dir_fd_safe(fd, str(Path(*parts[: i + 1])), require_owner=(i == last))
        return fd
    except Exception:
        os.close(fd)
        raise


def _create_managed_project_dir_windows(resolved_root: Path, slug: str) -> tuple[Path, int, int]:
    """Windows counterpart to the POSIX dir_fd walk in create_managed_project_dir.

    The TOCTOU-safe O_NOFOLLOW + dir_fd component walk is POSIX-only — os.open /
    os.mkdir do not accept ``dir_fd`` on Windows and there is no O_NOFOLLOW. We
    create the directory normally and restrict the workspace root AND the new
    project dir to the current user via an NTFS ACL (the fail-closed posture the
    owner chose). Symlink/junction swap resistance is not replicated at the
    syscall level here; the owner-only ACL on the user-profile workspace root is
    the mitigation (see docs/windows-support-assessment.md). The inode pin
    (st_dev/st_ino) remains the durable identity, re-checked before every run.
    """
    from superclaw.secure_fs import harden_path

    resolved_root.mkdir(parents=True, exist_ok=True)
    harden_path(resolved_root, is_dir=True)
    target = resolved_root / slug
    try:
        target.mkdir(mode=0o700)  # mode is ignored by NTFS; ACL hardened below
    except FileExistsError as exc:
        raise WorkspaceRootRejected(
            f"a directory named {slug!r} already exists under {resolved_root}; "
            "rename the project, or use 'attach existing directory' (requires trust)"
        ) from exc
    harden_path(target, is_dir=True)
    st = target.stat()
    return (target, st.st_dev, st.st_ino)


def create_managed_project_dir(name: str, *, root: Path | None = None) -> tuple[Path, int, int]:
    """Atomically create a VISIBLE real folder ``<root>/<slug>`` for a managed
    personal project, race-free. Returns ``(path, st_dev, st_ino)`` — the inode
    pin is the durable identity (re-checked before every run); the path is only
    for display/execution. Raises WorkspaceRootRejected on an unsafe location or
    a name collision (an existing path is never silently adopted — that is the
    'attach existing directory' flow, which requires explicit human trust)."""
    base = (root or default_project_workspace_root()).expanduser()
    # Resolve a legitimate symlinked PREFIX of the root once (e.g. macOS
    # /tmp -> /private/tmp), then walk the resolved path with O_NOFOLLOW so no
    # *new* symlink can be slipped in mid-walk.
    resolved_root = Path(os.path.realpath(base))
    slug = _project_slug(name)
    if os.name == "nt":
        return _create_managed_project_dir_windows(resolved_root, slug)
    root_fd = _secure_open_project_root(resolved_root)
    try:
        try:
            os.mkdir(slug, mode=0o700, dir_fd=root_fd)
        except FileExistsError as exc:
            raise WorkspaceRootRejected(
                f"a directory named {slug!r} already exists under {resolved_root}; "
                "rename the project, or use 'attach existing directory' (requires trust)"
            ) from exc
        target_fd = os.open(slug, _O_NOFOLLOW_DIR, dir_fd=root_fd)
        try:
            st = _assert_dir_fd_safe(target_fd, str(resolved_root / slug), require_owner=True)
            return (resolved_root / slug, st.st_dev, st.st_ino)
        finally:
            os.close(target_fd)
    finally:
        os.close(root_fd)


def assert_managed_dir_unchanged(workspace: WorkspaceProfile) -> Path:
    """Execution-time fail-closed integrity gate — the single kernel choke point
    every execution entry (chat turn, orchestrator dispatch, CLI run) must call
    before using a workspace's directory as a cwd. For a real-folder workspace it
    re-opens the directory O_NOFOLLOW and verifies (st_dev, st_ino) still match
    the pin recorded at creation; a mismatch/missing dir is WorkspaceDirCompromised
    (refuse, never re-create). For any other workspace it is a no-op pass-through."""
    meta = workspace.metadata or {}
    if meta.get("creation_mode") != REAL_FOLDER_CREATION_MODE:
        return Path(workspace.repo_path)
    pin = meta.get("dir_pin") or {}
    pinned_dev, pinned_ino = pin.get("dev"), pin.get("ino")
    path = Path(workspace.repo_path)
    try:
        fd = os.open(os.fspath(path), _O_NOFOLLOW_DIR)
    except (FileNotFoundError, NotADirectoryError, OSError) as exc:
        raise WorkspaceDirCompromised(
            f"project directory {path} is missing or no longer a real directory"
        ) from exc
    try:
        st = os.fstat(fd)
    finally:
        os.close(fd)
    if pinned_dev is None or pinned_ino is None or st.st_dev != pinned_dev or st.st_ino != pinned_ino:
        raise WorkspaceDirCompromised(
            f"project directory {path} no longer matches its pinned identity "
            "(deleted/recreated or replaced); refusing to execute"
        )
    return path


def assert_execution_repo_safe(store: "StateStore", repo_path: str | os.PathLike[str]) -> Path:
    """Execution choke point keyed by a repo PATH (not a workspace handle), for
    call sites that only have the cwd (orchestrator dispatch, the store-less
    direct-chat path's API caller). Looks up the workspace covering ``repo_path``
    and, if it is a real-folder managed project, re-checks its pinned inode
    fail-closed (WorkspaceDirCompromised). No match → no-op. A failure to even
    resolve the workspace (store/profile error) is NOT swallowed — this is a
    security gate, so the error propagates rather than fail-open into execution."""
    workspace = find_workspace_for_path(store, repo_path)  # None when unmatched
    if workspace is not None:
        assert_managed_dir_unchanged(workspace)
    return Path(repo_path)


def is_protected_project_repo(store: "StateStore", repo_path: str | os.PathLike[str]) -> bool:
    """True when ``repo_path`` is a real-folder managed project whose directory is
    inode-pinned — backends must NOT auto-(re)create such a cwd (a missing dir is
    a tamper/deletion signal, fail-closed), only execute in the validated one.
    Called right after assert_execution_repo_safe (same lookup), so a store error
    has already failed closed there; the lookup is not swallowed here either."""
    workspace = find_workspace_for_path(store, repo_path)
    return bool(
        workspace is not None
        and (workspace.metadata or {}).get("creation_mode") == REAL_FOLDER_CREATION_MODE
    )


def ensure_chat_workspace(store: "StateStore", *, root: Path | None = None) -> WorkspaceProfile:
    """Return the built-in managed Chat workspace, creating it on first use.

    The scratch root is app-owned and contains no pre-existing user data, so
    trust is granted by construction (no prompt) and writes are confined to
    the directory itself.
    """
    for workspace in store.list_workspace_profiles():
        if (
            workspace.kind == WorkspaceKind.MANAGED.value
            and workspace.metadata.get("builtin") == CHAT_WORKSPACE_MARKER
        ):
            return workspace
    chat_root = (root or default_chat_workspace_root()).expanduser()
    chat_root.mkdir(parents=True, exist_ok=True)
    workspace = WorkspaceProfile(
        name="Chat",
        repo_path=str(chat_root),
        writable_paths=["."],
        kind=WorkspaceKind.MANAGED.value,
        trust_status=WorkspaceTrustStatus.ACTIVE.value,
        trusted_at=time(),
        trust_source="managed",
        repo_identity=resolve_repo_identity(chat_root),
        metadata={"builtin": CHAT_WORKSPACE_MARKER},
    )
    return store.save_workspace_profile(workspace)


def create_trusted_workspace(
    store: "StateStore",
    path: str | os.PathLike[str],
    *,
    name: str | None = None,
    trust_source: str = "cli_prompt",
    company_profile_id: str = "local",
) -> WorkspaceProfile:
    """Trust-as-creation: materialize an ACTIVE repo workspace for a path.

    Callers must have obtained an explicit human confirmation first (CLI
    prompt or an equivalent approval surface) — this function only enforces
    the safety gates that no confirmation may override.
    """
    identity = assert_safe_workspace_root(path)
    canonical = identity["canonical_path"]
    workspace = WorkspaceProfile(
        name=name or os.path.basename(canonical) or canonical,
        company_profile_id=company_profile_id,
        repo_path=canonical,
        writable_paths=["."],
        kind=WorkspaceKind.REPO.value,
        trust_status=WorkspaceTrustStatus.ACTIVE.value,
        trusted_at=time(),
        trust_source=trust_source,
        repo_identity=identity,
    )
    return store.save_workspace_profile(workspace)


def create_personal_workspace(
    store: "StateStore",
    name: str,
    *,
    attach_repo: str | os.PathLike[str] | None = None,
    trust_confirmed: bool = False,
    trust_source: str = "cli_prompt",
    root: Path | None = None,
) -> WorkspaceProfile:
    """Create a personal (``company="local"``) workspace from the sidebar.

    Two modes (roadmap docs/workspace-sidebar-rework-roadmap.md §3/§5 PR-A):

    - ``attach_repo=None`` → a **MANAGED scratch folder**: an app-owned
      directory under ``~/.superclaw/workspaces/<id>``, trusted BY CONSTRUCTION
      (no prompt — no pre-existing user data), with writes LOCKED to the scratch
      dir itself (``writable_paths=["."]``, network restricted). A pure grouping
      folder the agent cannot use to touch real files ("no armed black box",
      §4.3).
    - ``attach_repo=<path>`` → a **REPO workspace** via
      ``create_trusted_workspace``. Trusting a real user directory is
      fail-closed: the caller MUST pass ``trust_confirmed=True`` to attest it
      obtained explicit human trust confirmation first (§4.4). This is a
      code-enforced gate, not a docstring convention — a surface (API/Web) that
      forgets the prompt gets a hard error, never a silent trust.

    A blank name (empty or whitespace-only) is rejected here, in the one shared
    kernel entry, so EVERY surface (CLI/API/Web) gets the identical contract
    instead of each coining its own placeholder or validator (CLI↔API zero
    divergence; supersedes the old ``name or "Workspace"`` fallback).
    """
    if not name or not name.strip():
        raise ValueError("workspace name must not be empty")
    if attach_repo is not None:
        if not trust_confirmed:
            raise ValueError(
                "attach_repo requires trust_confirmed=True — a personal workspace may "
                "only adopt a real directory after explicit human trust confirmation "
                "(workspace-sidebar-rework §4.4; fail-closed governance)"
            )
        return create_trusted_workspace(
            store, attach_repo, name=name, trust_source=trust_source, company_profile_id="local"
        )
    # Default "new project": a VISIBLE real folder ~/SuperClaw/<slug> (Codex-like),
    # created race-free and trusted by construction (app-created, no pre-existing
    # user data — ADR workspace-trust-container §L51). A filesystem collision is
    # rejected, never silently adopted: adopting an existing directory is the
    # attach-repo flow above, which requires explicit human trust.
    project_path, dev, ino = create_managed_project_dir(name, root=root)
    # Defensive uniqueness: the mkdir(exist_ok=False) above is the atomic guard;
    # this only catches a stale DB record whose folder had been deleted then
    # re-created. Clean up the just-made empty folder before failing.
    for existing in store.list_workspace_profiles():
        try:
            same = os.path.realpath(existing.repo_path) == os.path.realpath(os.fspath(project_path))
        except OSError:
            same = False
        if same:
            try:
                os.rmdir(project_path)
            except OSError:
                pass
            raise WorkspaceRootRejected(
                f"a project already exists at {project_path}; rename the new project"
            )
    workspace = WorkspaceProfile(
        name=name,
        company_profile_id="local",
        repo_path=str(project_path),
        writable_paths=["."],
        kind=WorkspaceKind.MANAGED.value,
        trust_status=WorkspaceTrustStatus.ACTIVE.value,
        trusted_at=time(),
        trust_source="managed",
        metadata={
            "personal": True,
            "creation_mode": REAL_FOLDER_CREATION_MODE,
            "dir_pin": {"dev": dev, "ino": ino},
        },
    )
    try:
        workspace.repo_identity = resolve_repo_identity(project_path)
        return store.save_workspace_profile(workspace)
    except Exception:
        # The folder was created atomically; if registering it fails (DB lock,
        # disk full, ...) reclaim the empty dir so the same name stays creatable
        # — otherwise the orphan would FileExistsError-reject every future retry.
        try:
            os.rmdir(project_path)
        except OSError:
            pass
        raise


@dataclass
class WorkspaceResolution:
    """Outcome of resolving where a chat/run belongs.

    Consumers needing the *current* physical checkout path must read
    ``identity["canonical_path"]`` — ``workspace.repo_path`` records the
    checkout the workspace was first trusted from, which is stale when the
    match came through another worktree of the same project.
    """

    status: Literal["matched", "trust_required", "chat_fallback"]
    workspace: WorkspaceProfile | None = None
    identity: dict[str, Any] = field(default_factory=dict)
    reason: str = ""


def resolve_workspace_for_chat(
    store: "StateStore",
    *,
    workspace_id: str | None = None,
    repo: str | os.PathLike[str] | None = None,
) -> WorkspaceResolution:
    """The one resolution path every surface shares.

    - explicit id: must exist; non-ACTIVE workspaces are surfaced as
      ``trust_required`` (fail-closed), never silently downgraded.
    - repo given: fingerprint match, else ``trust_required`` — the caller
      decides whether it may prompt (interactive) or must propagate the
      failure (non-interactive).
    - no repo: managed Chat workspace.
    """
    if workspace_id is not None:
        workspace = store.get_workspace_profile(workspace_id)  # KeyError if unknown
        if not workspace.is_trusted:
            return WorkspaceResolution(
                status="trust_required",
                workspace=workspace,
                identity=dict(workspace.repo_identity),
                reason=f"workspace {workspace_id} is {workspace.trust_status}",
            )
        if repo is not None:
            # An explicit workspace picks the *grouping*; it never exempts the
            # *execution directory* from the trust gate. The repo must itself
            # be covered by a trusted workspace (usually the explicit one).
            identity = resolve_repo_identity(repo)
            repo_workspace = find_workspace_for_path(store, repo)
            if repo_workspace is None or not repo_workspace.is_trusted:
                return WorkspaceResolution(
                    status="trust_required",
                    workspace=repo_workspace,
                    identity=identity,
                    reason=(
                        f"execution repo {identity['canonical_path']} is not covered "
                        "by a trusted workspace"
                    ),
                )
            return WorkspaceResolution(status="matched", workspace=workspace, identity=identity)
        return WorkspaceResolution(
            status="matched", workspace=workspace, identity=dict(workspace.repo_identity)
        )
    if repo is not None:
        identity = resolve_repo_identity(repo)
        workspace = find_workspace_for_path(store, repo)
        if workspace is not None:
            if not workspace.is_trusted:
                return WorkspaceResolution(
                    status="trust_required",
                    workspace=workspace,
                    identity=identity,
                    reason=f"workspace {workspace.workspace_id} is {workspace.trust_status}",
                )
            return WorkspaceResolution(status="matched", workspace=workspace, identity=identity)
        return WorkspaceResolution(
            status="trust_required",
            identity=identity,
            reason=f"no trusted workspace for {identity['canonical_path']}",
        )
    chat_workspace = ensure_chat_workspace(store)
    if not chat_workspace.is_trusted:
        # A quarantined/pending Chat workspace must not host new sessions —
        # trust_status gates managed workspaces exactly like repo ones.
        return WorkspaceResolution(
            status="trust_required",
            workspace=chat_workspace,
            identity=dict(chat_workspace.repo_identity),
            reason=f"chat workspace is {chat_workspace.trust_status}",
        )
    return WorkspaceResolution(
        status="chat_fallback",
        workspace=chat_workspace,
        identity=dict(chat_workspace.repo_identity),
    )


def default_company_workspace_root() -> Path:
    return Path(
        os.environ.get(
            "SUPERCLAW_COMPANY_WORKSPACE_ROOT", str(Path.home() / ".superclaw" / "companies")
        )
    )


def _sanitize_dir_name(value: str) -> str:
    cleaned = "".join(ch if ch.isalnum() or ch in "-_." else "-" for ch in value.strip())
    return cleaned.strip("-.") or "workspace"


def materialize_company_workspace(
    store: "StateStore",
    company_profile_id: str,
    company_name: str,
    *,
    repo: str | os.PathLike[str] | None = None,
    repo_url: str | None = None,
    name: str | None = None,
    trust_source: str = "api",
) -> WorkspaceProfile:
    """Bind or materialize a company's workspace (Paperclip pattern).

    Exactly one of ``repo`` (existing local checkout) or ``repo_url`` (cloned
    into an app-owned managed directory, trusted by construction). A local
    repo that already matches a workspace is reused — unless it belongs to a
    different company, which fails closed instead of silently re-homing it.
    """
    if (repo is None) == (repo_url is None):
        raise ValueError("exactly one of repo or repo_url is required")
    if repo is not None:
        existing = find_workspace_for_path(store, repo)
        if existing is not None:
            if not existing.is_trusted:
                # trust_status gates whether a workspace may host work at all
                # — a pending/quarantined workspace cannot join a company.
                raise ValueError(
                    f"workspace {existing.workspace_id} is {existing.trust_status}; "
                    "resolve its trust state before binding it to a company"
                )
            if existing.company_profile_id not in ("local", company_profile_id):
                raise ValueError(
                    f"workspace {existing.workspace_id} already belongs to company "
                    f"{existing.company_profile_id}"
                )
            if existing.company_profile_id != company_profile_id:
                existing.company_profile_id = company_profile_id
                store.save_workspace_profile(existing)
            return existing
        return create_trusted_workspace(
            store,
            repo,
            name=name,
            trust_source=trust_source,
            company_profile_id=company_profile_id,
        )
    repo_name = _sanitize_dir_name(
        (repo_url or "").rstrip("/").rsplit("/", 1)[-1].removesuffix(".git") or "repo"
    )
    # Suffix the sanitized company name with its id tail: two names that
    # sanitize identically ("Acme!" vs "Acme?") must not share a checkout dir.
    company_dir = f"{_sanitize_dir_name(company_name)}-{company_profile_id[-8:]}"
    target = default_company_workspace_root() / company_dir / repo_name
    if target.exists() and any(target.iterdir()):
        raise ValueError(f"managed checkout target already exists: {target}")
    target.parent.mkdir(parents=True, exist_ok=True)
    clone = subprocess.run(
        # "--" stops git from parsing a hostile URL ("-u...") as an option.
        ["git", "clone", "--quiet", "--", repo_url, str(target)],
        capture_output=True,
        text=True,
        timeout=600,
        check=False,
    )
    if clone.returncode != 0:
        raise ValueError(f"git clone failed: {(clone.stderr or clone.stdout).strip()[-400:]}")
    workspace = WorkspaceProfile(
        name=name or repo_name,
        company_profile_id=company_profile_id,
        repo_path=str(target),
        writable_paths=["."],
        kind=WorkspaceKind.MANAGED.value,
        trust_status=WorkspaceTrustStatus.ACTIVE.value,
        trusted_at=time(),
        trust_source="managed",
        repo_identity=resolve_repo_identity(target),
        metadata={"managed_origin": repo_url},
    )
    return store.save_workspace_profile(workspace)
