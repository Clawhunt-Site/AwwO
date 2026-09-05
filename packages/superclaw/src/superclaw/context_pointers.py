"""Context-pointers capture: which files a delegated child run changed.

Paperclip §2.7 break ② ("结果回流断裂"): when a child agent finishes delegated
work, the parent's next/resume turn must see WHICH FILES changed so it can
integrate incrementally instead of re-reading the whole tree (the "CEO 智商衰减"
risk). status/summary/cost already flow back; this module supplies the missing
``affected_files`` pointers.

Design (dual-advisor "A+" verdict):
- Baseline is captured at run START (HEAD sha + the already-dirty path set) and
  the terminal diff is taken against that sha, MINUS the pre-existing dirty set —
  per-issue worktrees are reused, so a plain ``diff start_sha`` would over-report
  files that were already dirty before this run.
- ``diff <start_sha>`` covers BOTH committed and uncommitted changes (children
  often commit), which ``diff HEAD`` / ``status`` alone would miss.
- The result is a STRUCTURED status, never a bare ``[]``: ``failed``/``unavailable``
  must not be confused with ``no_changes`` or the parent would wrongly skip a
  re-scan. Capture is fail-open (never aborts run finalize) but never fakes success.
- The full path list is stored; the render cap is applied only at display time so
  the audit trail keeps every path.

All git calls use argv lists (no shell), a hard timeout, DEVNULL stdin, and ``-z``
parsing; the baseline sha is regex-validated before it is ever passed to git.
"""

from __future__ import annotations

import re
import subprocess
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

_SHA_RE = re.compile(r"^[0-9a-f]{7,40}$")
_GIT_TIMEOUT_SECONDS = 15
PATHS_RENDER_CAP = 50

# status values
CAPTURED = "captured"
NO_CHANGES = "no_changes"
FAILED = "failed"
SKIPPED = "skipped"
UNAVAILABLE = "unavailable"


@dataclass
class ContextPointersCapture:
    """A child run's file-change pointers, with an explicit capture status."""

    status: str = UNAVAILABLE
    paths: list[str] = field(default_factory=list)  # FULL list; cap only at render
    total_count: int = 0
    base_sha: str | None = None
    head_sha: str | None = None
    preexisting_dirty_count: int = 0
    reason: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Any) -> "ContextPointersCapture":
        # Defensive: a corrupt/legacy record may be a non-dict (list/str/None).
        # Filter to known fields (NOT cls(**data)) so neither a wrong type nor a
        # future schema addition can break deserialization of a stored record.
        if not isinstance(data, dict):
            return cls()
        known = set(cls.__dataclass_fields__)
        return cls(**{k: v for k, v in data.items() if k in known})

    def render_brief(
        self, *, cap: int = PATHS_RENDER_CAP, prefix: str = "Files changed by this child"
    ) -> str | None:
        """One line for a continuation prompt, or None to omit.

        ``prefix`` labels the line for its context (a delegated child's files, or
        an issue's OWN prior-pass files). ``failed``/``unavailable`` render an
        explicit UNKNOWN so the reader re-scans the workspace instead of trusting
        a silent empty set. Type-defensive: a structurally-corrupt ``captured``
        record (e.g. a non-list ``paths`` or a non-int ``total_count`` that slipped
        past ``from_dict``'s field filter) renders UNKNOWN rather than raising — a
        brief is an aid, never a gate, so it must never crash the run that reads it,
        and a malformed capture must surface as UNKNOWN, never as a misleading empty.
        """
        if self.status == CAPTURED:
            shown = (
                [p for p in self.paths[:cap] if isinstance(p, str)]
                if isinstance(self.paths, list)
                else []
            )
            # A genuine CAPTURED record always has ≥1 path (no paths → NO_CHANGES).
            # So a non-list, all-non-str, or empty `paths` here is a corrupt/legacy
            # record — render an explicit UNKNOWN, NEVER an empty "..: " line that
            # would masquerade as "changed nothing".
            if not shown:
                return (
                    f"{prefix}: UNKNOWN (malformed capture) — "
                    "re-scan the workspace before integrating."
                )
            try:
                more = int(self.total_count) - len(shown)
            except (TypeError, ValueError):
                more = 0
            tail = f" (+{more} more)" if more > 0 else ""
            return f"{prefix}: " + ", ".join(shown) + tail
        if self.status == NO_CHANGES:
            return f"{prefix}: (none reported)"
        if self.status in (FAILED, UNAVAILABLE):
            return (
                f"{prefix}: UNKNOWN ({self.reason or self.status}) — "
                "re-scan the workspace before integrating."
            )
        return None  # SKIPPED (dry-run) → nothing meaningful to say


def _run_git(repo: Path, args: list[str]) -> tuple[int, bytes]:
    """Run a git subcommand with argv list (no shell), DEVNULL stdin, timeout.

    NEVER raises: a missing git binary, a timeout, or any OS error returns a
    non-zero code so every caller treats it as "git unavailable". Pointers are an
    aid, not a gate — a git hiccup must never abort the run that owns this repo.
    """
    try:
        proc = subprocess.run(  # noqa: S603 - argv list, shell=False, no user string interpolation
            ["git", "-C", str(repo), *args],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            timeout=_GIT_TIMEOUT_SECONDS,
            check=False,
        )
    except (subprocess.TimeoutExpired, OSError):
        return 1, b""
    return proc.returncode, proc.stdout


def _is_git_worktree(repo: Path) -> bool:
    try:
        rc, out = _run_git(repo, ["rev-parse", "--is-inside-work-tree"])
    except (subprocess.TimeoutExpired, OSError):
        return False
    return rc == 0 and out.decode("utf-8", "replace").strip() == "true"


def _nul_paths(blob: bytes) -> set[str]:
    return {p.decode("utf-8", "replace") for p in blob.split(b"\x00") if p}


def _tracked_changes_since(repo: Path, base_ref: str) -> set[str] | None:
    """Tracked paths changed since ``base_ref`` (committed + uncommitted), or None
    on git error. Uses ``diff --name-only -z`` so every field is a clean NUL-
    terminated path — NOT ``status --porcelain``, whose rename entries carry a
    two-field ``R  new\\0old`` shape that a naive prefix-strip would corrupt."""
    rc, out = _run_git(repo, ["diff", "--name-only", "-z", base_ref])
    return _nul_paths(out) if rc == 0 else None


def _untracked_names(repo: Path) -> set[str]:
    """New, not-yet-added files the diff above does not list."""
    rc, out = _run_git(repo, ["ls-files", "--others", "--exclude-standard", "-z"])
    return _nul_paths(out) if rc == 0 else set()


def capture_baseline(repo_path: str | Path) -> dict[str, Any]:
    """Run-START snapshot for later diffing: HEAD sha + already-dirty path set.

    Returns a JSON-safe dict for ``execution_context``. Callers must write it
    idempotently (only when absent) so a resume never resets the baseline.
    """
    repo = Path(repo_path).resolve()
    if not _is_git_worktree(repo):
        return {"is_git": False, "sha": None, "dirty": []}
    try:
        rc, out = _run_git(repo, ["rev-parse", "HEAD"])
    except (subprocess.TimeoutExpired, OSError):
        return {"is_git": True, "sha": None, "dirty": []}
    sha = out.decode("utf-8", "replace").strip() if rc == 0 else ""
    valid_sha = sha if _SHA_RE.match(sha) else None
    # Already-dirty paths at run start, extracted the SAME way the terminal capture
    # extracts changes — so the set subtraction matches exactly. With no HEAD yet
    # (a commit-less repo) there is nothing to diff against, so only untracked files.
    if valid_sha is None:
        dirty = _untracked_names(repo)
    else:
        dirty = (_tracked_changes_since(repo, valid_sha) or set()) | _untracked_names(repo)
    return {"is_git": True, "sha": valid_sha, "dirty": sorted(dirty)}


def capture_context_pointers(
    repo_path: str | Path,
    baseline: dict[str, Any] | None,
    *,
    dry_run: bool = False,
) -> ContextPointersCapture:
    """Terminal capture: paths this run changed relative to its start baseline.

    Fail-open: any git/OS failure returns a ``failed``/``unavailable`` status
    (never raises), but is never silently reported as ``no_changes``.
    """
    if dry_run:
        return ContextPointersCapture(status=SKIPPED, reason="dry_run")
    if not baseline or not baseline.get("is_git"):
        return ContextPointersCapture(status=UNAVAILABLE, reason="not a git worktree at run start")
    base_sha = baseline.get("sha")
    if not isinstance(base_sha, str) or not _SHA_RE.match(base_sha):
        return ContextPointersCapture(status=UNAVAILABLE, reason="missing or invalid baseline sha")

    repo = Path(repo_path).resolve()
    try:
        if not _is_git_worktree(repo):
            return ContextPointersCapture(status=UNAVAILABLE, reason="repo is no longer a git worktree", base_sha=base_sha)
        rc_h, head_out = _run_git(repo, ["rev-parse", "HEAD"])
        head_sha = head_out.decode("utf-8", "replace").strip() if rc_h == 0 else None
        # Tracked changes (committed + uncommitted) since the baseline sha, plus
        # untracked new files — same extraction as the baseline so the subtraction
        # of pre-existing dirty paths matches path-for-path.
        tracked = _tracked_changes_since(repo, base_sha)
        if tracked is None:
            return ContextPointersCapture(status=FAILED, reason="git diff failed", base_sha=base_sha, head_sha=head_sha)
        changed = tracked | _untracked_names(repo)
    except subprocess.TimeoutExpired:
        return ContextPointersCapture(status=FAILED, reason="git timed out", base_sha=base_sha)
    except OSError as exc:
        return ContextPointersCapture(status=FAILED, reason=f"git unavailable: {type(exc).__name__}", base_sha=base_sha)

    preexisting = set(baseline.get("dirty") or [])
    run_changed = sorted(changed - preexisting)
    preexisting_overlap = len(preexisting & changed)
    if not run_changed:
        return ContextPointersCapture(
            status=NO_CHANGES, base_sha=base_sha, head_sha=head_sha, preexisting_dirty_count=preexisting_overlap
        )
    return ContextPointersCapture(
        status=CAPTURED,
        paths=run_changed,
        total_count=len(run_changed),
        base_sha=base_sha,
        head_sha=head_sha,
        preexisting_dirty_count=preexisting_overlap,
    )
