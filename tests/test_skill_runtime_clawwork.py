"""ClawWork backend honors @skill overlays per its relay capability.

ClawWork resolves tools through its relay (no MCP), so its capability is
prose-projection only. These tests exercise the backend's run-scoped projection
hook directly (no subprocess): a prose skill is projected into
``<agent_dir>/skills``; a tool-skill is fail-closed (the run is refused, never
degraded). conftest pins a fresh SUPERCLAW_HOME per test, so the default skill
store and plugin cache are isolated.
"""

from __future__ import annotations

from pathlib import Path

from superclaw.backends import ClawWorkBackend, WorkerLimits
from superclaw.models import GoalSpec, RunSession, TaskNode, WorkerRole
from superclaw.skill_build import build_and_install_skill_plugin
from superclaw.skill_store import import_skill

PROSE_SKILL = """---
name: changelog-summarizer
description: Summarize a git diff into a reviewer-ready changelog.
---

# Changelog Summarizer

Group changes by intent.
"""

TOOL_SKILL = """---
name: greeter
description: Greet a user by name.
---

# Greeter

Return a friendly greeting.
"""


def _import_prose(tmp_path: Path) -> None:
    src = tmp_path / "src" / "prose"
    src.mkdir(parents=True)
    (src / "SKILL.md").write_text(PROSE_SKILL, encoding="utf-8")
    # Default store (isolated SUPERCLAW_HOME) — the backend reads the default store.
    import_skill(src)


def _build_tool(tmp_path: Path) -> None:
    src = tmp_path / "tool" / "greeter"
    src.mkdir(parents=True)
    (src / "SKILL.md").write_text(TOOL_SKILL, encoding="utf-8")
    build_and_install_skill_plugin(src / "SKILL.md")


def _limits(tmp_path: Path, skill_ids: tuple[str, ...]) -> WorkerLimits:
    return WorkerLimits(repo_path=tmp_path, artifact_dir=tmp_path / "artifacts", skill_ids=skill_ids)


def test_clawwork_projects_prose_skill(tmp_path: Path) -> None:
    _import_prose(tmp_path)
    backend = ClawWorkBackend()
    agent_dir = tmp_path / "artifacts" / "clawwork-agent"
    error = backend._project_run_skills(_limits(tmp_path, ("changelog-summarizer",)), agent_dir)
    assert error is None
    assert (agent_dir / "skills" / "changelog-summarizer" / "SKILL.md").exists()


def test_clawwork_fail_closed_on_tool_skill(tmp_path: Path) -> None:
    _build_tool(tmp_path)
    backend = ClawWorkBackend()
    agent_dir = tmp_path / "artifacts" / "clawwork-agent"
    error = backend._project_run_skills(_limits(tmp_path, ("greeter",)), agent_dir)
    assert error is not None
    assert error.startswith("SKILL_UNAVAILABLE")
    # Nothing projected.
    assert not (agent_dir / "skills").exists() or not any((agent_dir / "skills").iterdir())


def test_clawwork_fail_closed_on_unknown_skill(tmp_path: Path) -> None:
    backend = ClawWorkBackend()
    agent_dir = tmp_path / "artifacts" / "clawwork-agent"
    error = backend._project_run_skills(_limits(tmp_path, ("ghost",)), agent_dir)
    assert error is not None and error.startswith("SKILL_UNAVAILABLE")


def test_clawwork_no_skill_ids_is_noop(tmp_path: Path) -> None:
    backend = ClawWorkBackend()
    agent_dir = tmp_path / "artifacts" / "clawwork-agent"
    assert backend._project_run_skills(_limits(tmp_path, ()), agent_dir) is None
    assert not (agent_dir / "skills").exists()


def test_clawwork_reconciles_stale_projection(tmp_path: Path) -> None:
    """A reused agent_dir must reflect EXACTLY the current turn's overlays: a skill
    projected last turn is dropped when this turn no longer requests it."""
    _import_prose(tmp_path)
    backend = ClawWorkBackend()
    agent_dir = tmp_path / "artifacts" / "clawwork-agent"
    backend._project_run_skills(_limits(tmp_path, ("changelog-summarizer",)), agent_dir)
    assert (agent_dir / "skills" / "changelog-summarizer").exists()
    # Next turn requests no skills → prior projection is reconciled away.
    assert backend._project_run_skills(_limits(tmp_path, ()), agent_dir) is None
    assert not (agent_dir / "skills" / "changelog-summarizer").exists()


def test_clawwork_run_refuses_tool_skill_before_runner(tmp_path: Path) -> None:
    """Full run() path: a tool-skill on ClawWork fail-closes BEFORE the rpc runner
    is ever invoked (the skill check sits ahead of policy snapshot / provisioning /
    spawn), so an unsupported skill wastes no relay auth and runs no agent."""
    _build_tool(tmp_path)
    called = {"n": 0}

    def _recording_rpc(*args: object, **kwargs: object) -> object:
        called["n"] += 1
        raise AssertionError("rpc runner must not be called when a skill is unavailable")

    backend = ClawWorkBackend(rpc_fn=_recording_rpc)
    task = TaskNode(task_id="task_1", role=WorkerRole.IMPLEMENT, title="skill turn")
    result = backend.run(
        task,
        GoalSpec(title="Run", description="skill turn"),
        RunSession(goal_id="goal_1", run_id="run_skill"),
        _limits(tmp_path, ("greeter",)),
    )
    assert called["n"] == 0
    assert result.exit_code != 0
    assert "SKILL_UNAVAILABLE" in (result.output or "")
    # The run aborted before writing the clawwork agent dir / policy snapshot.
    assert not (tmp_path / "artifacts" / "clawwork-agent" / "skills").exists()
