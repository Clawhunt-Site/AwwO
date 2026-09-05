from __future__ import annotations

from superclaw.chat_turn import direct_chat_prompt
from superclaw.models import ChatMessage


def test_direct_chat_prompt_includes_history():
    prompt = direct_chat_prompt(
        "我刚才说我叫什么名字？",
        history="User: 我叫 Leon\nAssistant: 记住了，Leon。",
    )
    assert "Conversation so far" in prompt
    assert "我叫 Leon" in prompt
    assert "记住了，Leon。" in prompt
    assert "Current user message:" in prompt
    assert "我刚才说我叫什么名字？" in prompt


def test_direct_chat_prompt_without_history_passes_message_verbatim():
    # Native runtime turn: with no history and no context refs there is no
    # wrapper at all — the user's message reaches the runtime verbatim.
    assert direct_chat_prompt("hello") == "hello"


def test_format_chat_history_renders_and_caps():
    from apps.api.main import _format_chat_history

    messages = [
        ChatMessage(role="user", content="q1"),
        ChatMessage(role="assistant", content="a1"),
        ChatMessage(role="user", content="q2"),
    ]
    text = _format_chat_history(messages)
    assert text == "User: q1\nAssistant: a1\nUser: q2"

    many = [ChatMessage(role="user", content=f"m{i}") for i in range(50)]
    capped = _format_chat_history(many, max_messages=10)
    assert capped.count("\n") == 9  # only the last 10 messages
    assert "m49" in capped and "m0" not in capped
