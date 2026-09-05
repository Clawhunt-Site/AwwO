from __future__ import annotations

import pytest

from superclaw.chat_turn import (
    ChatRoutePlan,
    OverlayRef,
    classify_intent,
    extract_skill_id,
    parse_chat_route,
)


# --- @skill resolver --------------------------------------------------------


def test_extract_skill_id():
    assert extract_skill_id("@skill:my-skill do a thing") == "my-skill"
    assert extract_skill_id("use skill:pay_helper now") == "pay_helper"
    assert extract_skill_id("no skill here") is None


# --- parse_chat_route: one runtime turn + optional overlays -----------------


def test_pure_chat_has_no_overlay():
    plan = parse_chat_route("what is 2+2?", mode="auto")
    assert isinstance(plan, ChatRoutePlan)
    assert plan.has_overlay is False
    assert plan.overlays == ()
    assert plan.delivery_legacy is False
    assert plan.forced_mode is None


def test_plugin_marker_is_an_overlay_not_a_path():
    plan = parse_chat_route("@plugin:pay-switch submit", mode="auto")
    assert plan.has_overlay is True
    assert plan.plugin_ids == ("pay-switch",)
    assert OverlayRef(kind="plugin", id="pay-switch") in plan.overlays


def test_skill_marker_is_an_overlay():
    plan = parse_chat_route("@skill:formatter clean this up", mode="auto")
    assert plan.skill_ids == ("formatter",)


def test_plugin_and_skill_overlays_compose():
    plan = parse_chat_route("@plugin:p1 and @skill:s1", mode="auto")
    assert plan.plugin_ids == ("p1",)
    assert plan.skill_ids == ("s1",)


def test_delivery_is_a_deprecated_legacy_marker():
    assert parse_chat_route("@delivery ship it", mode="auto").delivery_legacy is True
    assert parse_chat_route("/delivery ship it", mode="auto").delivery_legacy is True
    assert parse_chat_route("ship it", mode="delivery").delivery_legacy is True
    assert parse_chat_route("ship it", mode="auto").delivery_legacy is False


def test_invalid_mode_rejected():
    with pytest.raises(ValueError):
        parse_chat_route("hi", mode="bogus")


# --- classify_intent is now a legacy projection of parse_chat_route ---------


def test_classify_intent_projects_the_route_plan():
    # Existing contract preserved...
    assert classify_intent("hello", mode="auto") == "chat"
    assert classify_intent("@plugin:x go", mode="auto") == "task"
    assert classify_intent("@delivery go", mode="auto") == "delivery"
    assert classify_intent("anything", mode="delivery") == "delivery"
    assert classify_intent("@delivery go", mode="chat") == "chat"  # forced mode wins
    # ...plus the unified-entry fix: @skill is an overlay turn on EVERY surface
    # (the CLI shell aliases this same kernel function), no longer plain chat.
    assert classify_intent("@skill:formatter tidy", mode="auto") == "task"
    # Precedence: the deprecated delivery marker still wins over overlays.
    assert classify_intent("@delivery with @plugin:x", mode="auto") == "delivery"


def test_classify_intent_agrees_with_parse_chat_route():
    # Property: the projection never disagrees with the plan it projects.
    for message in ["hi", "@plugin:p go", "@skill:s go", "@delivery ship", "", "do x"]:
        for mode in ["auto", "chat", "delivery"]:
            plan = parse_chat_route(message, mode=mode)
            intent = classify_intent(message, mode=mode)
            if plan.forced_mode is not None:
                assert intent == plan.forced_mode
            elif plan.delivery_legacy:
                assert intent == "delivery"
            elif plan.has_overlay:
                assert intent == "task"
            else:
                assert intent == "chat"
