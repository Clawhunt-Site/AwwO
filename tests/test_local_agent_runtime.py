import json
import os
from pathlib import Path

from superclaw.backends import GeminiAgentBackend, HermesCliBackend, WorkerLimits
from superclaw.local_agent_runtime import (
    app_server_runtime_spec,
    api_agent_runtime_spec,
    cli_agent_runtime_spec,
)
from superclaw.models import GoalSpec, RunSession, TaskNode, WorkerRole
from superclaw.runtime import PermissionPolicy


def _task(role: WorkerRole = WorkerRole.IMPLEMENT) -> TaskNode:
    return TaskNode(task_id="task_1", role=role, title=f"{role.value} task")


def _fake_executable(tmp_path: Path, name: str) -> Path:
    if os.name == "nt":
        path = tmp_path / f"{name}.cmd"
        path.write_text("@echo off\necho fake-agent %*\n", encoding="utf-8")
    else:
        path = tmp_path / name
        path.write_text("#!/bin/sh\necho fake-agent \"$@\"\n", encoding="utf-8")
        path.chmod(0o755)
    return path


def test_local_agent_runtime_specs_describe_transport_and_session_boundaries():
    cli = cli_agent_runtime_spec(backend="claude", executable="/bin/claude", model="opus", provider="claude-code")
    app_server = app_server_runtime_spec(backend="codex-app-server", executable="/bin/codex", api_mode="codex_app_server")
    api_agent = api_agent_runtime_spec(
        backend="anthropic-agent",
        model="claude-opus-4-8",
        provider="anthropic",
        api_mode="anthropic_messages",
        transport="anthropic_messages",
    )

    assert cli.to_dict()["transport"] == "cli_subprocess"
    assert cli.to_dict()["session_strategy"] == "per_invocation"
    assert app_server.to_dict()["transport"] == "json_rpc_stdio"
    assert app_server.to_dict()["session_strategy"] == "persistent_thread"
    assert api_agent.to_dict()["kind"] == "api-agent"
    assert api_agent.to_dict()["session_strategy"] == "provider_client"


def test_prompt_envelope_capability_defaults_are_conservative():
    # Prompt Envelope P1: new capability fields default to the most conservative posture
    # (flatten everything, no native system/cache/tool-schema channel) so adding them
    # changes no existing behavior until a backend opts in.
    spec = cli_agent_runtime_spec(backend="claude", executable="/bin/claude")
    d = spec.to_dict()
    assert d["system_channel"] == "flatten_only"
    assert d["per_call_system"] is False
    assert d["append_preserves_default"] is False
    assert d["override_replaces_default"] is False
    assert d["supports_cache_control"] is False
    assert d["supports_tool_schema"] is False


def test_prompt_envelope_capability_threads_through_factories():
    # A backend can declare its real channel via any factory (pure pass-through).
    cli = cli_agent_runtime_spec(
        backend="claude",
        executable="/bin/claude",
        system_channel="native_cli_append",
        append_preserves_default=True,
    )
    assert cli.system_channel == "native_cli_append"
    assert cli.append_preserves_default is True

    api_agent = api_agent_runtime_spec(
        backend="anthropic-agent",
        model="claude-opus-4-8",
        provider="anthropic",
        api_mode="anthropic_messages",
        transport="anthropic_messages",
        system_channel="native_structured",
        per_call_system=True,
        supports_cache_control=True,
        supports_tool_schema=True,
    )
    d = api_agent.to_dict()
    assert d["system_channel"] == "native_structured"
    assert d["per_call_system"] is True
    assert d["supports_cache_control"] is True
    assert d["supports_tool_schema"] is True

    app_server = app_server_runtime_spec(
        backend="codex-app-server",
        executable="/bin/codex",
        api_mode="codex_app_server",
        system_channel="flatten_only",
    )
    assert app_server.system_channel == "flatten_only"


def test_hermes_cli_backend_records_local_agent_runtime_contract(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_HERMES_MODEL", "gpt-5.4")
    monkeypatch.setenv("SUPERCLAW_HERMES_PROVIDER", "openai-codex")
    backend = HermesCliBackend(executable=str(_fake_executable(tmp_path, "hermes")))
    goal = GoalSpec(title="Ship", description="Use Hermes")
    limits = WorkerLimits(
        repo_path=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        budget_seconds=10,
        permission_policy=PermissionPolicy(mode="bypassPermissions"),
    )

    result = backend.run(_task(), goal, RunSession(goal_id=goal.goal_id, run_id="run_hermes_runtime"), limits)

    assert result.exit_code == 0
    transcript = json.loads(Path(result.transcript_path or "").read_text(encoding="utf-8"))
    runtime = transcript["extra"]["local_agent_runtime"]
    assert runtime["backend"] == "hermes"
    assert runtime["kind"] == "cli"
    assert runtime["transport"] == "cli_subprocess"
    assert runtime["session_strategy"] == "per_invocation"
    assert runtime["api_mode"] == "hermes_oneshot"
    assert runtime["model"] == "gpt-5.4"
    assert runtime["provider"] == "openai-codex"


def test_api_agent_backend_records_runtime_contract_on_configuration_failure(tmp_path, monkeypatch):
    monkeypatch.delenv("SUPERCLAW_GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    backend = GeminiAgentBackend(model="gemini-test")
    goal = GoalSpec(title="Ship", description="Use Gemini")
    limits = WorkerLimits(repo_path=tmp_path, artifact_dir=tmp_path / "artifacts", budget_seconds=10)

    result = backend.run(_task(), goal, RunSession(goal_id=goal.goal_id, run_id="run_gemini_runtime"), limits)

    assert result.exit_code == 127
    transcript = json.loads(Path(result.transcript_path or "").read_text(encoding="utf-8"))
    runtime = transcript["extra"]["local_agent_runtime"]
    assert runtime["backend"] == "gemini"
    assert runtime["kind"] == "api-agent"
    assert runtime["transport"] == "chat_completions"
    assert runtime["api_mode"] == "chat_completions"
    assert runtime["model"] == "gemini-test"
