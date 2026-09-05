from __future__ import annotations

import pytest

from superclaw.chat_turn import classify_intent, extract_plugin_id


@pytest.mark.parametrize(
    "message,expected",
    [
        # Heavy verifiable delivery is opt-in: only an explicit @delivery / /delivery.
        ("@delivery 修复登录 bug 并提交", "delivery"),
        ("/delivery run the full e2e and settle the bounty", "delivery"),
        ("把这个任务 @delivery 走完整校验", "delivery"),
        # A plugin invocation runs as a light agentic task.
        ("@plugin:dev.clawhunt.pay-switch-agent 查询授权状态", "task"),
        ("@plugin:dev.clawhunt.pay-switch-agent 你用这个插件给买一个最便宜的月费kimi会员", "task"),
        # A skill invocation is an overlay turn too (unified entry): same "task"
        # routing on every surface (CLI shell aliases this same function).
        ("@skill:formatter 整理这段代码", "task"),
        ("skill:notes.summary do it", "task"),
        # Everyday Q&A / research / "do X" without @delivery stays in read-only chat.
        ("kimi会员多少钱？", "chat"),
        ("你是什么模型", "chat"),
        ("帮我调研一下最新的向量数据库对比", "chat"),
        ("购买最便宜的kimi月费会员", "chat"),  # no @delivery/@plugin -> not auto-escalated
        ("修复登录 bug", "chat"),
    ],
)
def test_classify_intent_explicit_routing(message, expected):
    assert classify_intent(message, mode="auto") == expected


def test_explicit_mode_overrides_classification():
    # The composer's forced mode still wins over auto-routing.
    assert classify_intent("kimi会员多少钱？", mode="delivery") == "delivery"
    assert classify_intent("@delivery do it", mode="chat") == "chat"


@pytest.mark.parametrize(
    "message,expected",
    [
        ("@plugin:dev.clawhunt.pay-switch-agent 查询授权状态", "dev.clawhunt.pay-switch-agent"),
        ("plugin:demo.agent do it", "demo.agent"),
        ("before @plugin:abc_123.pay-switch more", "abc_123.pay-switch"),
        ("plugin: 查询授权状态", None),
        ("plain chat", None),
    ],
)
def test_extract_plugin_id(message, expected):
    assert extract_plugin_id(message) == expected
