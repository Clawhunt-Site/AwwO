"""A3a: conversational skill creation through the generic direct-chat path.

A backend that (guided by the injected directive) emits a proposal block has its
skill harvested + registered through the governed kernel; the raw block is
stripped from the reply and a confirmation is appended. Runtime-agnostic: this is
the path ClawWork chat uses, so "say 'create a skill' in chat → governed,
cross-runtime skill" works end to end. conftest pins SUPERCLAW_HOME.
"""

from __future__ import annotations

import superclaw.backends as backends_module
from superclaw.backends import BackendAvailability
from superclaw.chat_turn import execute_direct_chat_turn
from superclaw.models import WorkerResult
from superclaw.skill_author import PROPOSAL_CLOSE, PROPOSAL_OPEN, SKILL_CREATION_DIRECTIVE
from superclaw.skill_store import list_skills


class _ReplyWorker:
    """Generic backend that echoes a fixed reply and records the prompt it saw."""

    def __init__(self, reply: str, captured: dict) -> None:
        self.name = "fake"
        self._reply = reply
        self._captured = captured

    def available(self) -> BackendAvailability:
        return BackendAvailability(name=self.name, available=True)

    def skill_capability(self):
        # Declare skill support so an explicit @skill USE turn isn't refused by the
        # seam gate — lets the create-exclusion-on-USE-turn test exercise run().
        from superclaw.skill_runtime import BackendSkillCapability

        return BackendSkillCapability.relay_backend()

    def run(self, task, goal, session, limits) -> WorkerResult:
        self._captured["prompt"] = goal.description
        return WorkerResult(task.task_id, task.role.value, self.name, self._reply, 0, self._reply, 0.1, stdout=self._reply)

    def permission_presets(self) -> dict:
        return {}


def _proposal(name: str, description: str, body: str) -> str:
    return f"{PROPOSAL_OPEN}\nname: {name}\ndescription: {description}\n---\n{body}\n{PROPOSAL_CLOSE}"


def test_directive_injected_only_on_create_intent(tmp_path, monkeypatch) -> None:
    captured: dict = {}
    monkeypatch.setattr(backends_module, "default_backends", lambda: {"fake": _ReplyWorker("hi", captured)})
    # Directive is injected on every chat turn (intent is the LLM's call, not a
    # keyword gate) — even an ordinary-sounding message carries it.
    execute_direct_chat_turn(content="what is the weather?", backend="fake", repo=tmp_path, budget_seconds=5)
    assert SKILL_CREATION_DIRECTIVE in captured["prompt"]


def test_model_emission_registers_regardless_of_phrasing(tmp_path, monkeypatch) -> None:
    # Intent is the runtime LLM's understanding, NOT keywords: when the model
    # (guided by the directive) emits a proposal, SuperClaw registers it — even if
    # the user's wording doesn't keyword-match "create skill". This is the whole
    # point of dropping the keyword gate.
    reply = "Got it:\n\n" + _proposal("Tidy Helper", "tidy things up", "Keep it tidy.")
    captured: dict = {}
    monkeypatch.setattr(backends_module, "default_backends", lambda: {"fake": _ReplyWorker(reply, captured)})
    result = execute_direct_chat_turn(content="I want something to tidy my repo", backend="fake", repo=tmp_path, budget_seconds=5)
    assert result.get("created_skills") == ["tidy-helper"]
    assert "tidy-helper" in [s.slug for s in list_skills()]
    assert PROPOSAL_OPEN not in result["response"]


def test_skill_use_turn_does_not_create(tmp_path, monkeypatch) -> None:
    # An explicit @skill USE turn (skill_ids present) is NOT a create turn: the
    # creation directive must not be injected and an emitted block must not be
    # harvested, even if the model emits one. Overlay-derived, not keyword-based.
    reply = _proposal("Sneaked", "during a use turn", "do stuff")
    captured: dict = {}
    monkeypatch.setattr(backends_module, "default_backends", lambda: {"fake": _ReplyWorker(reply, captured)})
    result = execute_direct_chat_turn(
        content="use it", backend="fake", repo=tmp_path, budget_seconds=5, skill_ids=("formatter",)
    )
    assert SKILL_CREATION_DIRECTIVE not in captured.get("prompt", "")
    assert list_skills() == []
    assert "created_skills" not in result


def test_conversational_create_registers_and_cleans_reply(tmp_path, monkeypatch) -> None:
    reply = "Sure, here's a skill:\n\n" + _proposal(
        "Changelog Summarizer", "Summarize a git diff into a changelog.", "Group by intent."
    )
    captured: dict = {}
    monkeypatch.setattr(backends_module, "default_backends", lambda: {"fake": _ReplyWorker(reply, captured)})
    result = execute_direct_chat_turn(content="make a changelog skill", backend="fake", repo=tmp_path, budget_seconds=5)
    # Skill landed in the governed store, cross-runtime.
    assert "changelog-summarizer" in [s.slug for s in list_skills()]
    assert result.get("created_skills") == ["changelog-summarizer"]
    # Raw block stripped from the displayed reply; confirmation appended.
    assert PROPOSAL_OPEN not in result["response"]
    assert "Registered SuperClaw skill" in result["response"]
    # Honest lifecycle: registered != active; never the overstated old wording.
    assert "Not active in any runtime yet" in result["response"]
    assert "usable across runtimes" not in result["response"]
    assert "Sure, here's a skill:" in result["response"]


def test_conversational_create_reports_rejection(tmp_path, monkeypatch) -> None:
    # Executable body → A1 refuses; reply reports it, nothing registered.
    reply = _proposal("Sneaky", "tries scripts", "Run:\n\n```sh\n#!/bin/sh\nx\n```")
    captured: dict = {}
    monkeypatch.setattr(backends_module, "default_backends", lambda: {"fake": _ReplyWorker(reply, captured)})
    result = execute_direct_chat_turn(content="make a skill", backend="fake", repo=tmp_path, budget_seconds=5)
    assert list_skills() == []
    assert "created_skills" not in result
    assert "Skill not created" in result["response"]


def test_plain_reply_unaffected(tmp_path, monkeypatch) -> None:
    captured: dict = {}
    monkeypatch.setattr(backends_module, "default_backends", lambda: {"fake": _ReplyWorker("just chatting", captured)})
    result = execute_direct_chat_turn(content="hi", backend="fake", repo=tmp_path, budget_seconds=5)
    assert result["response"] == "just chatting"
    assert "created_skills" not in result


def test_disabled_gate_skips_directive_and_harvest(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("SUPERCLAW_SKILL_CREATE", "0")
    reply = _proposal("Nope", "should not register", "body")
    captured: dict = {}
    monkeypatch.setattr(backends_module, "default_backends", lambda: {"fake": _ReplyWorker(reply, captured)})
    result = execute_direct_chat_turn(content="make a skill", backend="fake", repo=tmp_path, budget_seconds=5)
    assert SKILL_CREATION_DIRECTIVE not in captured["prompt"]
    assert list_skills() == []
    # Block left as-is (no harvest, no strip) when disabled.
    assert PROPOSAL_OPEN in result["response"]
