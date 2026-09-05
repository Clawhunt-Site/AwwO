"""A failed chat turn must be PERSISTED (status=failed) so a reload still shows
why it failed — and must NEVER be replayed into a runtime as conversation."""

import dataclasses

from superclaw.chat_turn import (
    format_chat_history,
    friendly_chat_failure,
    unseen_messages_since,
)
from superclaw.models import ChatMessage


def test_auth_failure_yields_login_hint():
    claude = friendly_chat_failure("claude native chat failed (exit 1): Failed to authenticate. API Error: 401", "claude")
    assert "claude" in claude.lower()
    assert "登录" in claude  # actionable re-login guidance, raw error kept appended
    assert "401" in claude

    grok = friendly_chat_failure("not logged in", "grok")
    assert "grok" in grok and "认证" in grok


def test_non_auth_failure_passes_through_unchanged():
    reason = "timeout: claude native chat exceeded 30s"
    assert friendly_chat_failure(reason, "claude") == reason
    assert friendly_chat_failure(None, "grok") == "chat turn failed"


def test_failed_message_excluded_from_history_and_sync():
    msgs = [
        ChatMessage(role="user", content="hi"),
        ChatMessage(role="assistant", content="AUTH-FAILED-TEXT", status="failed"),
        ChatMessage(role="assistant", content="a real reply"),
    ]
    history = format_chat_history(msgs)
    assert "AUTH-FAILED-TEXT" not in history  # never replayed into a runtime
    assert "a real reply" in history

    unseen = unseen_messages_since(msgs, None)
    assert all(m.content != "AUTH-FAILED-TEXT" for m in unseen)  # not synced to native session


def test_chat_message_status_round_trips():
    msg = ChatMessage(role="assistant", content="boom", status="failed")
    restored = ChatMessage(**dataclasses.asdict(msg))
    assert restored.status == "failed"
    # legacy rows (no status key) deserialize safely to None
    legacy = {k: v for k, v in dataclasses.asdict(msg).items() if k != "status"}
    assert ChatMessage(**legacy).status is None


def test_chat_message_metering_round_trips():
    # The per-turn metering (token usage + elapsed) persisted for the chat surface
    # survives a to_dict/from_dict round-trip so the meta row renders after reload.
    msg = ChatMessage(
        role="assistant",
        content="hi",
        usage={"input_tokens": 4391, "output_tokens": 439, "cache_read_input_tokens": 35710},
        elapsed_ms=12345.0,
    )
    restored = ChatMessage(**dataclasses.asdict(msg))
    assert restored.usage == {"input_tokens": 4391, "output_tokens": 439, "cache_read_input_tokens": 35710}
    assert restored.elapsed_ms == 12345.0
    # User/system rows and ordinary assistant rows leave the metering None.
    assert ChatMessage(role="user", content="hi").usage is None
    assert ChatMessage(role="user", content="hi").elapsed_ms is None
    # Legacy rows (persisted before the fields existed) deserialize safely to None.
    legacy = {k: v for k, v in dataclasses.asdict(msg).items() if k not in {"usage", "elapsed_ms"}}
    restored_legacy = ChatMessage(**legacy)
    assert restored_legacy.usage is None
    assert restored_legacy.elapsed_ms is None


def test_run_session_from_dict_ignores_unknown_keys():
    # A run payload written by an older schema or a past bug (a stray
    # ``failure_reason``) must DESERIALIZE, not raise TypeError — otherwise a
    # chat turn that links such a run 500s and the whole conversation breaks.
    from superclaw.models import RunSession

    rs = RunSession.from_dict(
        {"goal_id": "g", "run_id": "r", "status": "failed", "failure_reason": "stale bug field", "bogus": 1}
    )
    assert rs.run_id == "r"
    assert rs.status == "failed"
    assert not hasattr(rs, "failure_reason")
