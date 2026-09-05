"""Unit tests for the ClawWork Tier 2 durable native-session plumbing.

Binary-independent: these lock the SuperClaw-side guards (id grammar, HOME-only 0700
dir, HEADER-verified resume pre-flight, duplicate/mismatch detection, traversal-safety,
lock) that the real-binary canary + the Tier-2 design review motivated.
"""
from __future__ import annotations

import json
import stat

import pytest

from superclaw.clawwork_session import (
    CLAWWORK_SESSION_DIR_ENV,
    NativeSessionVerdict,
    is_resumable_native_session,
    is_valid_native_session_id,
    native_session_dir,
    native_session_lock,
    native_sessions_root,
    verify_native_session,
)


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_HOME", str(tmp_path))
    return tmp_path


def _write_session(session_dir, native_id, *, cwd, header_id=None, ts="2026-06-25T17-00-13-246Z", valid=True):
    """Drop a ClawWork-shaped session file (first line = session header)."""
    path = session_dir / f"{ts}_{native_id}.jsonl"
    if valid:
        header = {"type": "session", "id": header_id or native_id, "timestamp": ts, "cwd": cwd}
    else:
        header = {"type": "not_session", "id": header_id or native_id, "cwd": cwd}
    path.write_text(json.dumps(header) + "\n", encoding="utf-8")
    return path


def test_session_id_grammar_matches_clawwork():
    assert is_valid_native_session_id("canary1")
    assert is_valid_native_session_id("a1b2c3d4-e5f6-7890-ab12-cd34ef56ab78")
    assert is_valid_native_session_id("chat.session_1-2")
    assert not is_valid_native_session_id("")
    assert not is_valid_native_session_id("-leading")
    assert not is_valid_native_session_id("trailing-")
    assert not is_valid_native_session_id("has/slash")
    assert not is_valid_native_session_id("..")
    assert not is_valid_native_session_id("a b")
    assert not is_valid_native_session_id(None)  # type: ignore[arg-type]


def test_native_session_dir_is_home_only_and_0700(home):
    d = native_session_dir("chat_abc", backend="clawwork")
    assert d.is_dir()
    # Anchored under HOME root, in clawwork/sessions — NOT a cwd-relative .superclaw.
    assert native_sessions_root() in d.parents
    assert str(d).startswith(str(home))
    assert ".superclaw" not in d.parts  # cwd-relative legacy fallback must never be used
    assert stat.S_IMODE(d.stat().st_mode) == 0o700


def test_native_session_dir_does_not_follow_cwd_fallback(home, tmp_path, monkeypatch):
    # Even if a legacy cwd-relative .superclaw/clawwork/sessions exists, the resolver
    # must anchor on HOME (plaintext session never follows cwd off-machine).
    legacy = tmp_path / "cwd" / ".superclaw" / "clawwork" / "sessions"
    legacy.mkdir(parents=True)
    monkeypatch.chdir(tmp_path / "cwd")
    d = native_session_dir("chat_abc")
    assert legacy not in d.parents


def test_native_session_dir_is_traversal_safe(home):
    d = native_session_dir("../../etc/evil", backend="clawwork")
    root = native_sessions_root()
    assert root in d.parents
    assert ".." not in d.relative_to(root).parts


def test_preflight_ok_only_with_matching_header(home):
    d = native_session_dir("chat_abc")
    repo = "/tmp/repo"
    assert verify_native_session(d, "sess1", expected_repo=repo)[0] is NativeSessionVerdict.MISSING
    _write_session(d, "sess1", cwd=repo)
    verdict, path = verify_native_session(d, "sess1", expected_repo=repo)
    assert verdict is NativeSessionVerdict.OK and path is not None
    assert is_resumable_native_session(d, "sess1", expected_repo=repo) is True


def test_preflight_mismatch_on_wrong_cwd(home):
    d = native_session_dir("chat_abc")
    _write_session(d, "sess1", cwd="/tmp/OTHER-repo")
    # File named for the id exists, but its header cwd is a different repo -> not resumable.
    verdict, _ = verify_native_session(d, "sess1", expected_repo="/tmp/repo")
    assert verdict is NativeSessionVerdict.MISMATCH
    assert is_resumable_native_session(d, "sess1", expected_repo="/tmp/repo") is False


def test_preflight_mismatch_on_wrong_header_id(home):
    d = native_session_dir("chat_abc")
    # Filename says sess1 but the header id is someone else's — forged/collision.
    _write_session(d, "sess1", cwd="/tmp/repo", header_id="evil")
    verdict, _ = verify_native_session(d, "sess1", expected_repo="/tmp/repo")
    assert verdict is NativeSessionVerdict.MISMATCH


def test_preflight_mismatch_on_non_session_header(home):
    d = native_session_dir("chat_abc")
    _write_session(d, "sess1", cwd="/tmp/repo", valid=False)
    verdict, _ = verify_native_session(d, "sess1", expected_repo="/tmp/repo")
    assert verdict is NativeSessionVerdict.MISMATCH


def test_preflight_duplicate_never_picks_one(home):
    d = native_session_dir("chat_abc")
    _write_session(d, "sess1", cwd="/tmp/repo", ts="2026-06-25T17-00-00-000Z")
    _write_session(d, "sess1", cwd="/tmp/repo", ts="2026-06-25T18-00-00-000Z")
    verdict, path = verify_native_session(d, "sess1", expected_repo="/tmp/repo")
    assert verdict is NativeSessionVerdict.DUPLICATE and path is None  # never resume an ambiguous id
    assert is_resumable_native_session(d, "sess1", expected_repo="/tmp/repo") is False


def test_preflight_cwd_optional_matches_on_id_only(home):
    d = native_session_dir("chat_abc")
    _write_session(d, "sess1", cwd="/tmp/anything")
    # When expected_repo is not supplied, identity is id-only (still header-verified).
    assert verify_native_session(d, "sess1")[0] is NativeSessionVerdict.OK


def test_preflight_invalid_id_is_mismatch(home):
    d = native_session_dir("chat_abc")
    assert verify_native_session(d, "has slash")[0] is NativeSessionVerdict.MISMATCH


def test_corrupt_binary_session_file_is_mismatch_not_crash(home):
    # A binary-truncated session file makes readline() raise UnicodeDecodeError (a
    # ValueError, NOT OSError). It must degrade to MISMATCH (retire+reseed), never crash.
    d = native_session_dir("chat_abc")
    (d / "2026-06-25T17-00-13-246Z_sess1.jsonl").write_bytes(b"\xff\xfe\x00 not utf-8 \x80\n")
    verdict, _ = verify_native_session(d, "sess1", expected_repo="/tmp/repo")
    assert verdict is NativeSessionVerdict.MISMATCH
    assert is_resumable_native_session(d, "sess1", expected_repo="/tmp/repo") is False


def test_session_dir_is_account_owner_scoped(home, monkeypatch):
    # One account's plaintext session must never resolve to another account's dir
    # (governance boundary): the same chat id under two owners gets two distinct dirs.
    import superclaw.clawwork_session as cs

    monkeypatch.setattr(cs, "_current_owner_tag", lambda: "acct-AAA")
    dir_a = native_session_dir("chat_abc")
    monkeypatch.setattr(cs, "_current_owner_tag", lambda: "acct-BBB")
    dir_b = native_session_dir("chat_abc")
    assert dir_a != dir_b
    # account B cannot see account A's session file (different dir -> MISSING -> reseed)
    _write_session(dir_a, "sess1", cwd="/tmp/repo")
    monkeypatch.setattr(cs, "_current_owner_tag", lambda: "acct-BBB")
    assert is_resumable_native_session(native_session_dir("chat_abc"), "sess1", expected_repo="/tmp/repo") is False
    # same account A resumes its own session
    monkeypatch.setattr(cs, "_current_owner_tag", lambda: "acct-AAA")
    assert is_resumable_native_session(native_session_dir("chat_abc"), "sess1", expected_repo="/tmp/repo") is True


def test_native_session_lock_is_acquirable_and_reusable(home):
    d = native_session_dir("chat_abc")
    with native_session_lock(d, "sess1"):
        pass
    with native_session_lock(d, "sess1"):
        pass


def test_session_dir_env_var_name():
    assert CLAWWORK_SESSION_DIR_ENV == "CLAWWORK_CODING_AGENT_SESSION_DIR"
