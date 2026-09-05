"""The direct-chat kernel entry carries @skill to a capable backend, fail-closed.

These lock the seam contract independently of any API routing:
- a backend that declares a skill_capability receives skill_ids in WorkerLimits;
- a backend without one refuses the turn (no run());
- the codex fast path resolves @skill fail-closed (unknown → refused) and routes
  resolved prose through the TOOL_CONTRACT prompt layer;
- a message that addresses @skill but arrives without threaded skill_ids is
  refused at the kernel boundary (closes the legacy /api/chat/direct no-op hole).
"""

from __future__ import annotations

from typing import Any

import superclaw.backends as backends_module
from superclaw.backends import BackendAvailability
from superclaw.chat_turn import execute_direct_chat_turn
from superclaw.models import WorkerResult
from superclaw.skill_runtime import BackendSkillCapability


class _SkillWorker:
    """Generic backend that declares prose-skill capability and records limits."""

    def __init__(self, captured: dict, *, capable: bool = True) -> None:
        self.name = "fake"
        self._captured = captured
        self._capable = capable

    def available(self) -> BackendAvailability:
        return BackendAvailability(name=self.name, available=True)

    def skill_capability(self) -> Any:
        return BackendSkillCapability.relay_backend() if self._capable else None

    def run(self, task, goal, session, limits) -> WorkerResult:
        self._captured["limits"] = limits
        return WorkerResult(task.task_id, task.role.value, self.name, "ok", 0, "ok", 0.1, stdout="ok")

    def permission_presets(self) -> dict:
        return {}


class _NoSkillWorker:
    """Generic backend with NO skill_capability attribute at all."""

    def __init__(self, captured: dict) -> None:
        self.name = "plain"
        self._captured = captured

    def available(self) -> BackendAvailability:
        return BackendAvailability(name=self.name, available=True)

    def run(self, task, goal, session, limits) -> WorkerResult:  # pragma: no cover - must not run
        self._captured["ran"] = True
        return WorkerResult(task.task_id, task.role.value, self.name, "ran", 0, "ran", 0.1, stdout="ran")

    def permission_presets(self) -> dict:
        return {}


def test_skill_ids_threaded_into_limits_for_capable_backend(tmp_path, monkeypatch) -> None:
    captured: dict = {}
    monkeypatch.setattr(backends_module, "default_backends", lambda: {"fake": _SkillWorker(captured)})
    result = execute_direct_chat_turn(
        content="do the thing", backend="fake", repo=tmp_path, budget_seconds=5, skill_ids=("changelog-summarizer",)
    )
    assert result.get("status") != "failed"
    assert captured["limits"].skill_ids == ("changelog-summarizer",)


def test_capable_backend_without_skill_ids_threads_empty(tmp_path, monkeypatch) -> None:
    captured: dict = {}
    monkeypatch.setattr(backends_module, "default_backends", lambda: {"fake": _SkillWorker(captured)})
    execute_direct_chat_turn(content="hi", backend="fake", repo=tmp_path, budget_seconds=5)
    assert captured["limits"].skill_ids == ()


def test_backend_without_capability_refuses_skill_and_does_not_run(tmp_path, monkeypatch) -> None:
    captured: dict = {}
    monkeypatch.setattr(backends_module, "default_backends", lambda: {"plain": _NoSkillWorker(captured)})
    result = execute_direct_chat_turn(
        content="do x", backend="plain", repo=tmp_path, budget_seconds=5, skill_ids=("foo",)
    )
    assert result.get("status") == "failed"
    assert "skill_overlay_unsupported" in (result.get("failure_reason") or "")
    assert "ran" not in captured  # run() never invoked


class _AttrCapWorker(_SkillWorker):
    """Declares skill_capability as a plain attribute (not a method)."""

    def __init__(self, captured: dict) -> None:
        super().__init__(captured)
        self.skill_capability = BackendSkillCapability.relay_backend()  # type: ignore[assignment]


def test_skill_capability_as_attribute_is_accepted(tmp_path, monkeypatch) -> None:
    # The gate must accept a value-form skill_capability, not only a method.
    captured: dict = {}
    monkeypatch.setattr(backends_module, "default_backends", lambda: {"fake": _AttrCapWorker(captured)})
    result = execute_direct_chat_turn(
        content="do x", backend="fake", repo=tmp_path, budget_seconds=5, skill_ids=("foo",)
    )
    assert result.get("status") != "failed"
    assert captured["limits"].skill_ids == ("foo",)


def test_codex_fast_path_unknown_skill_fail_closed(tmp_path) -> None:
    # The codex direct-chat fast-path now RESOLVES @skill overlays (fail-closed):
    # an UNKNOWN skill refuses the turn before any executable lookup / subprocess,
    # with the kernel's unavailable reason (no longer "not yet wired").
    result = execute_direct_chat_turn(
        content="do x", backend="codex", repo=tmp_path, budget_seconds=5, skill_ids=("foo",)
    )
    assert result.get("status") == "failed"
    reason = result.get("failure_reason") or ""
    assert "skill_overlay_unavailable" in reason
    assert "unknown_skill" in reason


def test_unthreaded_skill_marker_in_content_is_refused(tmp_path, monkeypatch) -> None:
    # The legacy no-op hole: content addresses @skill but the caller passed no
    # skill_ids → refuse at the kernel boundary rather than run as plain chat.
    captured: dict = {}
    monkeypatch.setattr(backends_module, "default_backends", lambda: {"fake": _SkillWorker(captured)})
    result = execute_direct_chat_turn(
        content="@skill:changelog-summarizer summarize this", backend="fake", repo=tmp_path, budget_seconds=5
    )
    assert result.get("status") == "failed"
    assert "skill_overlay_unthreaded" in (result.get("failure_reason") or "")
    assert "limits" not in captured  # run() never invoked


def test_direct_chat_prompt_routes_tool_contract_into_layer() -> None:
    # B3: codex fast-path passes the @skill prose via tool_contract so it lands in
    # the TOOL_CONTRACT prompt layer (audited, governance-ordered), not appended raw
    # to the end of the flattened prompt.
    from superclaw.chat_turn import direct_chat_prompt

    prompt = direct_chat_prompt(
        "do the thing", tool_contract="Apply this SuperClaw skill now — «X» (x):\nBODY-MARKER"
    )
    assert "BODY-MARKER" in prompt
    # The skill prose precedes the user's current message (TOOL_CONTRACT is above
    # USER_TURN in the layer order), never trailing after it.
    assert prompt.index("BODY-MARKER") < prompt.index("do the thing")


# --------------------------------------------------------------------------- #
# Semantic auto-trigger: available-skill catalog injected on a no-@skill chat turn
# --------------------------------------------------------------------------- #


def _import_catalog_skill() -> None:
    import tempfile
    from pathlib import Path

    from superclaw.skill_store import import_skill

    d = Path(tempfile.mkdtemp()) / "changelog-summarizer"
    d.mkdir(parents=True)
    (d / "SKILL.md").write_text(
        "---\nname: changelog-summarizer\ndescription: Summarize a git diff.\n---\n\n"
        "# Changelog Summarizer\n\nGroup changes by intent.\n",
        encoding="utf-8",
    )
    import_skill(d)  # default home store (conftest pins SUPERCLAW_HOME)


def test_semantic_catalog_injected_when_no_at_skill(tmp_path, monkeypatch) -> None:
    captured: dict = {}
    monkeypatch.setattr(backends_module, "default_backends", lambda: {"fake": _SkillWorker(captured)})
    _import_catalog_skill()
    execute_direct_chat_turn(
        content="help me write release notes", backend="fake", repo=tmp_path, budget_seconds=5
    )
    catalog = captured["limits"].available_skill_catalog
    assert "changelog-summarizer" in catalog
    assert "UNTRUSTED catalog DATA" in catalog


def test_semantic_catalog_absent_with_explicit_at_skill(tmp_path, monkeypatch) -> None:
    # An explicit @skill turn uses the overlay path; no semantic catalog is offered.
    captured: dict = {}
    monkeypatch.setattr(backends_module, "default_backends", lambda: {"fake": _SkillWorker(captured)})
    _import_catalog_skill()
    execute_direct_chat_turn(
        content="do x", backend="fake", repo=tmp_path, budget_seconds=5,
        skill_ids=("changelog-summarizer",),
    )
    assert captured["limits"].available_skill_catalog == ""


def test_semantic_catalog_off_when_toggle_disabled(tmp_path, monkeypatch) -> None:
    from superclaw.runtime_config import save_shell_config_value

    # Isolate the config write to a per-test file so it cannot pollute the shared
    # session shell config (the toggle is read from SUPERCLAW_SHELL_CONFIG_PATH).
    monkeypatch.setenv("SUPERCLAW_SHELL_CONFIG_PATH", str(tmp_path / "config.json"))
    save_shell_config_value("semantic_skill_autotrigger", "false")
    captured: dict = {}
    monkeypatch.setattr(backends_module, "default_backends", lambda: {"fake": _SkillWorker(captured)})
    _import_catalog_skill()
    execute_direct_chat_turn(
        content="help me write release notes", backend="fake", repo=tmp_path, budget_seconds=5
    )
    assert captured["limits"].available_skill_catalog == ""


def test_semantic_catalog_corrupt_store_degrades_not_crash(tmp_path, monkeypatch) -> None:
    """A corrupt skill store must NOT turn an ordinary chat into an uncaught error
    (semantic discovery is a convenience layer): degrade to no catalog, chat runs."""
    import superclaw.chat_turn as ct

    def _boom(*a, **k):
        from superclaw.skill_store import SkillStoreError

        raise SkillStoreError("corrupt revocation file")

    monkeypatch.setattr(ct, "build_available_skill_catalog", _boom, raising=False)
    # build_available_skill_catalog is imported lazily inside the function, so patch
    # the source module too.
    import superclaw.skill_runtime as sr

    monkeypatch.setattr(sr, "build_available_skill_catalog", _boom)
    captured: dict = {}
    monkeypatch.setattr(backends_module, "default_backends", lambda: {"fake": _SkillWorker(captured)})
    result = execute_direct_chat_turn(
        content="hello", backend="fake", repo=tmp_path, budget_seconds=5
    )
    assert result.get("status") != "failed"  # chat still works
    assert captured["limits"].available_skill_catalog == ""  # degraded to empty
