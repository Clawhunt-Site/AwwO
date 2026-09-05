"""Durable native-session plumbing for the ClawWork chat runtime (Tier 2).

ClawWork's ``--mode rpc`` persists a chat session to disk and resumes it by
``--session-id`` — create-if-missing, open-if-exists (verified end-to-end by the
Tier 2 canary against the real relay). This module owns the SuperClaw side of that
lifecycle so it lives in ONE core place rather than scattered across the API
dispatch points (design review, blocker #6).

Guards, each backed by a real-binary canary observation and the Tier-2 design review:

* **HOME-only, 0700 session dir** (blocker #3/#6). The plaintext session lives in a
  per-conversation directory under :func:`~superclaw.environment.superclaw_home`
  DIRECTLY — never via ``superclaw_data_path`` (whose legacy cwd ``.superclaw``
  fallback would let the conversation follow the working directory off-machine, a
  governance iron-law violation). ClawWork writes the session file world-readable
  (``0644``, canary-confirmed) and never chmods it, so the parent dir's ``0700`` is the
  only thing shielding the plaintext.

* **Header-verified resume pre-flight** (blocker #1/#3). ``--session-id`` SILENTLY
  starts a fresh empty session when the file is missing (canary: ``success:true``, no
  error, prior context gone). Worse, a same-id race or a stale/forged file could carry
  the right NAME but the wrong conversation. So a resume is admitted ONLY when EXACTLY
  ONE file exists whose parsed session HEADER has ``type=="session"``, ``id==native_id``
  AND ``cwd==expected_repo``. Missing / mismatched / duplicate all fail the pre-flight
  so the caller retires the binding and full-seeds a fresh session.

* **Per-session file lock** (blocker #2). ClawWork names session files
  ``<timestamp>_<id>.jsonl`` and creates via list-then-create, so two concurrent turns
  for one id can mint two divergent files. The backend holds this cross-process lock
  around the spawn AND a re-verify of the resume target inside it
  (``native_session_expect_resume``), so a resume whose file vanished between the API
  pre-flight and the spawn fails closed rather than silently starting empty. Same-process
  turn ordering for one chat is additionally serialised by the API's in-process
  ``_chat_native_lock``. (A single held lock spanning the WHOLE API turn across
  *separate* processes is out of scope; the spawn-scoped lock + under-lock re-verify +
  the in-process lock cover the single-API-process deployment.)
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import os
import re
from collections.abc import Iterator
from enum import Enum
from pathlib import Path

from superclaw.environment import superclaw_home

# Mirror of ClawWork's ``assertValidSessionId`` (session-manager.ts): non-empty,
# only ``[A-Za-z0-9._-]``, and an alphanumeric first/last char. SuperClaw must never
# hand ClawWork an id it would reject at startup.
_NATIVE_SESSION_ID_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$")

# Filesystem-safe component for the per-conversation dir name. The chat session id is
# SuperClaw-issued (already tame) but a defensive sanitiser keeps a hostile/odd id from
# escaping the sessions root via separators / traversal.
_UNSAFE_DIR_CHARS = re.compile(r"[^A-Za-z0-9._-]")

# ClawWork reads the durable session dir from this env var (config.ts ENV_SESSION_DIR
# = ``<APP_NAME>_CODING_AGENT_SESSION_DIR``, APP_NAME=clawwork). Single definition point
# so the backend and tests never drift on the exact var name.
CLAWWORK_SESSION_DIR_ENV = "CLAWWORK_CODING_AGENT_SESSION_DIR"


class NativeSessionVerdict(str, Enum):
    """Result of a header-verified resume pre-flight."""

    OK = "ok"  # exactly one file whose header matches id + cwd — safe to resume
    MISSING = "missing"  # no file for this id — first turn (create) or lost session
    MISMATCH = "mismatch"  # file(s) named for this id exist but header id/cwd disagree
    DUPLICATE = "duplicate"  # >1 header-valid file (prior same-id race) — never "pick one"


def is_valid_native_session_id(session_id: str) -> bool:
    """True when ``session_id`` satisfies ClawWork's own id grammar.

    The caller MUST validate before invoking ClawWork: an invalid id makes ClawWork
    exit non-zero at startup (``assertValidSessionId``), which would surface as an
    opaque failed turn rather than a clear contract error here."""
    return bool(isinstance(session_id, str) and _NATIVE_SESSION_ID_RE.fullmatch(session_id))


def _safe_dir_component(value: str) -> str:
    """Map an arbitrary conversation key to a single safe path component.

    Replaces every unsafe char and collapses ``.``-only / empty results so the name can
    never be ``.``/``..`` or contain a separator (no traversal out of the sessions root).
    A short hash suffix keeps two keys that sanitise to the same string distinct."""
    cleaned = _UNSAFE_DIR_CHARS.sub("-", value or "")
    cleaned = cleaned.strip("-.") or "session"
    digest = hashlib.sha256((value or "").encode("utf-8")).hexdigest()[:8]
    return f"{cleaned[:48]}-{digest}"


def native_sessions_root() -> Path:
    """``<home>/clawwork/sessions`` — HOME-only (never cwd-relative), the shared parent
    of every conversation's session dir (the async GC sweep walks this)."""
    return superclaw_home() / "clawwork" / "sessions"


def _current_owner_tag() -> str:
    """Stable per-account fingerprint that scopes a durable native session to the relay
    account it was created under, so account A's ClawWork session FILE is not silently
    resumed under account B's relay key (relay-account-correct resume + defense-in-depth;
    a resumed session otherwise continues on the wrong account's relay quota/routing).

    SCOPE (honest): this scopes the on-disk SESSION FILE, not the chat transcript. On an
    account switch the binding is dropped and the turn full-seeds from the chat
    transcript — the SAME behaviour as the claude native path. Under SuperClaw's
    single-user threat model (account switch = the same human switching their own
    accounts) that transcript reseed is by design, not a cross-principal data leak; this
    tag is therefore session/relay scoping, NOT a claim of cross-account data isolation.

    Prefers the ClawHunt account id (survives relay-key rotation), then a relay-key hash,
    then ``anon`` (genuinely unauthenticated OR a transient resolution error). The tag
    must be DETERMINISTIC within a request (the API pre-flight and the executor each
    resolve it independently and must agree), so an error cannot fall back to a random
    per-call value; ``anon`` collapsing to a shared bucket is acceptable only because, in
    the single-user model, that bucket is still the same human."""
    try:
        from superclaw.clawhunt_auth import load_clawhunt_auth

        user = (load_clawhunt_auth() or {}).get("account_user")
        if isinstance(user, dict):
            acct = user.get("id") or user.get("username") or user.get("email")
            if acct:
                return "acct-" + hashlib.sha256(str(acct).encode("utf-8")).hexdigest()[:12]
    except Exception:
        pass
    try:
        from superclaw import relay_key as _relay_key

        key, _ = _relay_key.resolve_relay_api_key()
        if key:
            return "key-" + hashlib.sha256(key.encode("utf-8")).hexdigest()[:12]
    except Exception:
        pass
    return "anon"


def native_session_dir(chat_session_id: str, *, backend: str = "clawwork", create: bool = True) -> Path:
    """Durable per-conversation session directory, owned 0700 by SuperClaw.

    Layout: ``<home>/clawwork/sessions/<safe-chat>/<backend>/<owner>`` where ``owner`` is
    a stable per-ClawHunt-account fingerprint (:func:`_current_owner_tag`) — so a
    plaintext session FILE created under one account is not silently resumed under another
    account's relay key (relay-account-correct resume; NOT a claim of cross-account chat
    data isolation — see :func:`_current_owner_tag`). Durable (survives across runs so the next
    turn resumes) and distinct from the per-run agent dir. Anchored on
    :func:`superclaw_home` DIRECTLY (no ``superclaw_data_path`` legacy cwd fallback) so a
    plaintext conversation never follows the working directory off-machine. When
    ``create`` is set the tree is made and the leaf locked to ``0700`` so the
    world-readable session file ClawWork drops in is unreadable to other users.

    The owner tag is resolved internally so every caller (API pre-flight + chat executor)
    agrees on the same directory for the current account without threading it through."""
    path = (
        native_sessions_root()
        / _safe_dir_component(chat_session_id)
        / _safe_dir_component(backend)
        / _safe_dir_component(_current_owner_tag())
    )
    if create:
        path.mkdir(parents=True, exist_ok=True)
        with contextlib.suppress(OSError):
            path.chmod(0o700)
    return path


def _same_path(a: str, b: str) -> bool:
    try:
        return os.path.realpath(a) == os.path.realpath(b)
    except (OSError, ValueError):
        return a == b


def _candidate_files(session_dir: Path, native_session_id: str) -> list[Path]:
    """Files NAMED for this id (``<timestamp>_<id>.jsonl`` or ``<id>.jsonl``)."""
    try:
        return [
            p
            for p in session_dir.iterdir()
            if p.is_file()
            and p.suffix == ".jsonl"
            and (p.name.endswith(f"_{native_session_id}.jsonl") or p.name == f"{native_session_id}.jsonl")
        ]
    except OSError:
        return []


def _header_matches(path: Path, native_session_id: str, expected_repo: str | None) -> bool:
    """Parse the session file's first-line header and verify it is genuinely this
    conversation's session: ``type=="session"``, ``id==native_id`` and (when given)
    ``cwd==expected_repo``. A filename can be forged / collide; the header is the
    authoritative identity (session-manager.ts SessionHeader)."""
    try:
        with path.open("r", encoding="utf-8") as fh:
            first_line = fh.readline()
    except (OSError, ValueError):
        # ValueError covers UnicodeDecodeError (a ValueError subclass, NOT an OSError):
        # a binary-truncated / corrupt session file must degrade to "not a match" so the
        # turn retires + reseeds, never crash the request with a 500.
        return False
    if not first_line.strip():
        return False
    try:
        header = json.loads(first_line)
    except (ValueError, TypeError):
        return False
    if not isinstance(header, dict) or header.get("type") != "session":
        return False
    if header.get("id") != native_session_id:
        return False
    if expected_repo is not None:
        cwd = header.get("cwd")
        if not isinstance(cwd, str) or not _same_path(cwd, expected_repo):
            return False
    return True


def verify_native_session(
    session_dir: Path, native_session_id: str, *, expected_repo: str | None = None
) -> tuple[NativeSessionVerdict, Path | None]:
    """Header-verified resume pre-flight. Returns ``(verdict, file)`` where ``file`` is
    the single resumable session ONLY for :attr:`NativeSessionVerdict.OK`.

    A resume is safe ONLY when exactly one named file exists AND its parsed header
    matches the id (and cwd, when supplied). Anything else — no file, a named file whose
    header disagrees, or two header-valid files from a prior race — fails closed so the
    caller retires + full-seeds rather than resuming silently-wrong context."""
    if not is_valid_native_session_id(native_session_id):
        return NativeSessionVerdict.MISMATCH, None
    named = _candidate_files(session_dir, native_session_id)
    if not named:
        return NativeSessionVerdict.MISSING, None
    valid = [p for p in named if _header_matches(p, native_session_id, expected_repo)]
    if len(valid) == 1:
        return NativeSessionVerdict.OK, valid[0]
    if len(valid) > 1:
        # A prior same-id race left divergent files; never "pick newest" — the caller
        # must retire/quarantine and reseed so the conversation is unambiguous.
        return NativeSessionVerdict.DUPLICATE, None
    # Named file(s) present but no header matched id/cwd — stale / forged / wrong repo.
    return NativeSessionVerdict.MISMATCH, None


def is_resumable_native_session(
    session_dir: Path, native_session_id: str, *, expected_repo: str | None = None
) -> bool:
    """True only when the durable session is safe to resume (header-verified, unique).

    The chat-turn pre-flight uses this to keep a believed-resume honest: a ``False``
    means a ``--session-id`` resume would lose / cross conversations, so the caller must
    drop the binding and full-seed a fresh session."""
    verdict, _ = verify_native_session(session_dir, native_session_id, expected_repo=expected_repo)
    return verdict is NativeSessionVerdict.OK


@contextlib.contextmanager
def native_session_lock(session_dir: Path, native_session_id: str) -> Iterator[None]:
    """Cross-process advisory lock serialising turns of one conversation (blocker #2).

    The backend holds this around the spawn AND the under-lock resume re-verify
    (``native_session_expect_resume``), so a resume whose file vanished between the API
    pre-flight and the spawn fails closed instead of silently starting empty — that is
    the span that MUST be atomic. Broader same-process turn ordering for one chat is
    serialised by the API's in-process ``_chat_native_lock``; a single held lock spanning
    the WHOLE API turn across *separate* processes is intentionally out of scope (the
    single-API-process deployment is covered by spawn-lock + under-lock re-verify +
    in-process lock). ``fcntl.flock`` releases automatically if the holder dies, so a
    crashed/SIGKILLed turn never wedges the conversation; a non-POSIX platform (no
    ``fcntl``) degrades to a no-op."""
    session_dir.mkdir(parents=True, exist_ok=True)
    with contextlib.suppress(OSError):
        session_dir.chmod(0o700)
    try:
        import fcntl
    except ImportError:  # pragma: no cover - non-POSIX fallback
        yield
        return
    lock_path = session_dir / f".{_safe_dir_component(native_session_id)}.lock"
    fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        with contextlib.suppress(OSError):
            fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)


__all__ = [
    "CLAWWORK_SESSION_DIR_ENV",
    "NativeSessionVerdict",
    "is_valid_native_session_id",
    "is_resumable_native_session",
    "native_session_dir",
    "native_session_lock",
    "native_sessions_root",
    "verify_native_session",
]
