"""@skill inline overlay wiring for the prompt-driven backends.

Verifies the kernel-choke wiring added so @skill works beyond ClawWork: each
prompt-driven backend declares a prose-only capability, and the shared
``_inline_skill_overlay_text`` resolves the overlay fail-closed and yields prose to
inline into the TOOL_CONTRACT prompt layer. In-process: a real prose skill goes
through the native store (conftest pins a fresh SUPERCLAW_HOME per test); no
subprocess, no real CLI.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from superclaw.backends import (
    AnthropicAgentBackend,
    ClaudeCliBackend,
    CodexCliBackend,
    GeminiAgentBackend,
)
from superclaw.skill_runtime import SkillRuntimeError
from superclaw.skill_store import import_skill

PROSE_SKILL = """---
name: changelog-summarizer
description: Summarize a git diff into a reviewer-ready changelog.
---

# Changelog Summarizer

Group changes by intent and lead with the user-visible effect.
"""


class _Limits:
    """Minimal stand-in carrying just what _inline_skill_overlay_text reads."""

    def __init__(self, skill_ids: tuple[str, ...]) -> None:
        self.skill_ids = skill_ids


def _import_prose(tmp_path: Path) -> None:
    src = tmp_path / "src" / "prose"
    src.mkdir(parents=True, exist_ok=True)
    (src / "SKILL.md").write_text(PROSE_SKILL, encoding="utf-8")
    import_skill(src)  # default home store (conftest pins SUPERCLAW_HOME)


PROMPT_BACKENDS = [CodexCliBackend, ClaudeCliBackend, GeminiAgentBackend, AnthropicAgentBackend]


@pytest.mark.parametrize("cls", PROMPT_BACKENDS)
def test_backend_declares_prose_only_capability(cls) -> None:
    cap = cls().skill_capability()
    assert cap.supports_prose_projection is True
    assert cap.supports_mcp_tools is False  # tool-skills fail-closed on inline path


@pytest.mark.parametrize("cls", PROMPT_BACKENDS)
def test_inline_overlay_text_injects_prose(cls, tmp_path: Path) -> None:
    _import_prose(tmp_path)
    text = cls()._inline_skill_overlay_text(_Limits(("changelog-summarizer",)))
    assert "changelog-summarizer" in text
    assert "Group changes by intent" in text


def test_inline_overlay_text_noop_without_skill_ids() -> None:
    assert CodexCliBackend()._inline_skill_overlay_text(_Limits(())) == ""
    assert CodexCliBackend()._inline_skill_overlay_text(None) == ""


def test_inline_overlay_text_fail_closed_on_unknown(tmp_path: Path) -> None:
    with pytest.raises(SkillRuntimeError, match="unavailable skill"):
        CodexCliBackend()._inline_skill_overlay_text(_Limits(("ghost",)))


def test_inline_overlay_text_fail_closed_on_tool_skill(tmp_path: Path) -> None:
    """A tool-skill on a prose-only backend is fail-closed, never silently inlined
    as a prose note."""
    from superclaw.skill_build import build_and_install_skill_plugin

    tool_src = tmp_path / "tool-src" / "greeter"
    tool_src.mkdir(parents=True)
    (tool_src / "SKILL.md").write_text(
        "---\nname: greeter\ndescription: Greet a user.\n---\n\n# Greeter\n\nSay hi.\n",
        encoding="utf-8",
    )
    build_and_install_skill_plugin(tool_src / "SKILL.md")
    with pytest.raises(SkillRuntimeError, match="unavailable skill"):
        CodexCliBackend()._inline_skill_overlay_text(_Limits(("skill.greeter",)))


# --------------------------------------------------------------------------- #
# run()-level fail-closed guard + single-resolution session cache
# --------------------------------------------------------------------------- #


def _task():
    from superclaw.models import TaskNode, WorkerRole

    return TaskNode(task_id="task_1", role=WorkerRole.IMPLEMENT, title="t")


def _goal():
    from superclaw.models import GoalSpec

    return GoalSpec(title="Run", description="do it", acceptance_criteria=[])


def test_run_fail_closed_on_unknown_skill_anthropic_agent(tmp_path: Path) -> None:
    """End-to-end: a target backend's run() refuses with a synthetic
    SKILL_UNAVAILABLE result (no API call) when an @skill is unavailable — the
    early guard fires before any network work."""
    from superclaw.backends import WorkerLimits
    from superclaw.models import RunSession

    limits = WorkerLimits(
        repo_path=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        budget_seconds=10,
        skill_ids=("ghost",),
    )
    result = AnthropicAgentBackend().run(
        _task(), _goal(), RunSession(goal_id="g", run_id="r"), limits
    )
    assert result.exit_code == 1
    assert "SKILL_UNAVAILABLE" in (result.output or "")


def test_guard_caches_overlay_on_session(tmp_path: Path) -> None:
    """The guard resolves once and caches the prose on the session; the prompt
    builder reuses the cache instead of re-reading the store."""
    from superclaw.backends import WorkerLimits
    from superclaw.models import RunSession

    _import_prose(tmp_path)
    limits = WorkerLimits(
        repo_path=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        budget_seconds=10,
        skill_ids=("changelog-summarizer",),
    )
    session = RunSession(goal_id="g", run_id="r")
    backend = CodexCliBackend()
    guard_result = backend._skill_overlay_guard(task=_task(), session=session, limits=limits)
    assert guard_result is None  # available → no refusal
    cached = getattr(session, "_skill_overlay_text", None)
    assert cached is not None and "changelog-summarizer" in cached
    # The prompt-build path reuses the cached text (same object, no re-resolution).
    assert backend._cached_or_resolved_skill_overlay(limits, session) == cached
