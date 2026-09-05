import hashlib
import hmac
import json
import os
import socket
import sys
import urllib.error
from pathlib import Path

import pytest

from superclaw.backends import (
    AnthropicAgentBackend,
    AnthropicApiBackend,
    BoboCliBackend,
    ClaudeCliBackend,
    CodexCliBackend,
    CursorCliBackend,
    GeminiAgentBackend,
    GrokCliBackend,
    HermesCliBackend,
    HttpBackend,
    LocalShellBackend,
    OpenClawCliBackend,
    OpenClawGatewayBackend,
    OpenCodeCliBackend,
    WorkerLimits,
    default_backends,
)
from superclaw.cross_runtime_delegation import DelegationRequested
from superclaw.models import (
    ArtifactRef,
    EvidenceBundle,
    GoalSpec,
    PRIMARY_EVIDENCE_TEXT_LIMIT,
    PRIMARY_EVIDENCE_TRUNCATED_FINDING,
    RunSession,
    TaskNode,
    WorkerResult,
    WorkerRole,
)
from superclaw.openclaw_gateway import AgentRunResult, OpenClawGatewayError
from superclaw.agent_prompt import build_agent_prompt_envelope
from superclaw.prompt_contracts import PROMPT_PROJECTION_UNSUPPORTED, PromptProjectionUnsupportedError
from superclaw.runtime import PermissionPolicy
from superclaw.runtime_config import set_runtime_config


# ---------------------------------------------------------------------------
# In-process fake-CLI execution (no fork)
#
# Why: every CLI-backend test below spawns a *real* throwaway subprocess (a
# trivial ``/bin/sh`` script that echoes its argv) purely to read the built
# command line back out of ``result.output``. Those tests assert on the
# constructed argv/flags — NOT on real process behaviour — yet each one forks.
# Under any parallelism (pytest-xdist) or a loaded host the trivial child can be
# CPU-starved past the run's wall-clock ``budget_seconds`` and gets killed with
# exit 124, producing flaky failures (empty stdout, "timed out"). It is also
# slow: hundreds of forks dominate this file's runtime.
#
# Fix: the three ``_fake_*executable`` helpers below register the behaviour of
# the script they write into ``_FAKE_CLI_REGISTRY`` (keyed by the executable
# path). An autouse fixture swaps ``superclaw.backends.subprocess`` for a thin
# shim whose ``Popen`` fast-paths a *registered* fake in-process — returning the
# exact bytes the shell ``echo`` would have produced — and delegates everything
# else (real timeout/cancel/liveness children, the ``--version`` probes that go
# through ``subprocess.run``) to the real module untouched. The backend still
# builds the full command and runs the entire ``run_command`` control flow; only
# the fork of the trivial echo is replaced.
#
# Fidelity note: the fake reflects the *constructed argv* (``" ".join`` of the
# command tail), which is exactly what these argv-assertion tests check (flag and
# model substrings like ``--model X`` / ``fake-agent exec``). It is deliberately
# NOT a general ``/bin/sh echo`` re-implementation — POSIX ``echo`` backslash
# handling (``\c`` truncation etc.) is implementation-defined, and no assertion
# here depends on it; for argv content the join is a faithful (indeed stronger)
# reflection of what was built. The real spawn boundary stays covered by the
# tests that keep a real subprocess (see ``_ExecShim``).
# ---------------------------------------------------------------------------

# path(str) -> callable(command: list[str]) -> tuple[stdout: str, returncode: int]
_FAKE_CLI_REGISTRY: dict = {}


def _task(role: WorkerRole = WorkerRole.EXPLORE) -> TaskNode:
    return TaskNode(task_id="task_1", role=role, title=f"{role.value} task")


def _fake_executable(tmp_path: Path, name: str) -> Path:
    if os.name == "nt":
        path = tmp_path / f"{name}.cmd"
        path.write_text("@echo off\necho fake-agent %*\n", encoding="utf-8")
    else:
        path = tmp_path / name
        path.write_text("#!/bin/sh\necho fake-agent \"$@\"\n", encoding="utf-8")
        path.chmod(0o755)
    # Reflect the constructed argv (not a general shell echo): the literal
    # ``fake-agent`` prefix + space-joined argv tail, which is what the
    # argv-assertion tests grep for (flag/model substrings).
    _FAKE_CLI_REGISTRY[str(path)] = lambda command: ("fake-agent " + " ".join(command[1:]) + "\n", 0)
    return path


def _fake_auth_prompt_executable(tmp_path: Path, name: str) -> Path:
    if os.name == "nt":
        path = tmp_path / f"{name}.cmd"
        path.write_text("@echo off\necho Sign in with ChatGPT to generate an API key\nexit /b 0\n", encoding="utf-8")
    else:
        path = tmp_path / name
        path.write_text("#!/bin/sh\necho 'Sign in with ChatGPT to generate an API key'\nexit 0\n", encoding="utf-8")
        path.chmod(0o755)
    _FAKE_CLI_REGISTRY[str(path)] = lambda command: ("Sign in with ChatGPT to generate an API key\n", 0)
    return path


def test_local_shell_backend_executes_real_command(tmp_path):
    backend = LocalShellBackend()
    limits = WorkerLimits(repo_path=tmp_path, artifact_dir=tmp_path / "artifacts", budget_seconds=10)

    result = backend.run_command(
        [sys.executable, "-c", "print('worker-ok')"],
        task=_task(),
        goal=GoalSpec(title="Run", description="Execute"),
        session=RunSession(goal_id="goal_1", run_id="run_1"),
        limits=limits,
    )

    assert result.backend == "local"
    assert result.exit_code == 0
    assert "worker-ok" in result.output
    assert result.attempt_index == 1
    assert result.started_at is not None
    assert result.finished_at is not None
    assert result.finished_at >= result.started_at
    assert result.artifact_id == "run_1_task_1_local_attempt_01"
    assert result.artifact_path and Path(result.artifact_path).exists()
    assert result.transcript_path and Path(result.transcript_path).exists()
    transcript = json.loads(Path(result.transcript_path).read_text(encoding="utf-8"))
    assert transcript["backend"] == "local"
    assert transcript["attempt_index"] == 1
    assert transcript["exit_code"] == 0
    assert transcript["permission_policy"]["mode"] == "default"


def test_local_shell_backend_transcript_redacts_secret_like_output(tmp_path):
    backend = LocalShellBackend()
    fake_secret = "cph_" + "testsecret123456789"
    limits = WorkerLimits(
        repo_path=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        budget_seconds=10,
        permission_policy=PermissionPolicy(mode="plan", allowed_tools=["Read"]),
    )

    result = backend.run_command(
        [sys.executable, "-c", f"print({fake_secret!r})"],
        task=_task(),
        goal=GoalSpec(title="Run", description="Execute"),
        session=RunSession(goal_id="goal_1", run_id="run_1"),
        limits=limits,
    )

    assert fake_secret not in result.output
    transcript = json.loads(Path(result.transcript_path or "").read_text(encoding="utf-8"))
    assert transcript["permission_policy"]["mode"] == "plan"
    assert transcript["permission_policy"]["allowed_tools"] == ["Read"]
    assert fake_secret not in json.dumps(transcript)


def test_local_shell_backend_moves_large_output_to_artifacts_and_caps_primary_evidence(tmp_path):
    backend = LocalShellBackend()
    limits = WorkerLimits(repo_path=tmp_path, artifact_dir=tmp_path / "artifacts", budget_seconds=10)
    session = RunSession(goal_id="goal_1", run_id="run_big_output")
    command = [
        sys.executable,
        "-c",
        (
            "import sys; "
            "sys.stdout.write('STDOUT_START' + ('A' * 9000) + 'STDOUT_END'); "
            "sys.stderr.write('STDERR_START' + ('B' * 9000) + 'STDERR_END')"
        ),
    ]

    result = backend.run_command(
        command,
        task=_task(),
        goal=GoalSpec(title="Run", description="Large output"),
        session=session,
        limits=limits,
    )
    evidence = EvidenceBundle(run_id=session.run_id)
    evidence.add_worker_result(result)
    evidence.add_command(result.command, result.exit_code, result.output)
    evidence.add_artifact(
        ArtifactRef(kind="worker-log", path=result.artifact_path or "", artifact_id=result.artifact_id or "")
    )
    evidence.add_artifact(
        ArtifactRef(kind="worker-transcript", path=result.transcript_path or "", artifact_id=result.transcript_artifact_id or "")
    )
    payload = evidence.to_dict()

    assert len(payload["commands"][0]["output"]) <= PRIMARY_EVIDENCE_TEXT_LIMIT
    assert len(payload["worker_results"][0]["output"]) <= PRIMARY_EVIDENCE_TEXT_LIMIT
    assert payload["worker_results"][0]["output_truncated"] is True
    assert payload["worker_results"][0]["output_original_length"] > PRIMARY_EVIDENCE_TEXT_LIMIT
    assert any(
        finding["name"] == PRIMARY_EVIDENCE_TRUNCATED_FINDING
        and finding["input_fields"] == ["worker_results[].output"]
        for finding in payload["findings"]
    )
    assert payload["artifacts"][0]["kind"] == "worker-log"
    assert payload["artifacts"][1]["kind"] == "worker-transcript"
    log_text = Path(result.artifact_path or "").read_text(encoding="utf-8")
    assert "STDOUT_START" in log_text
    assert "STDOUT_END" in log_text
    assert "STDERR_START" in log_text
    assert "STDERR_END" in log_text
    transcript = json.loads(Path(result.transcript_path or "").read_text(encoding="utf-8"))
    assert transcript["stdout"].startswith("STDOUT_START")
    assert transcript["stdout"].endswith("STDOUT_END")
    assert transcript["stderr"].startswith("STDERR_START")
    assert transcript["stderr"].endswith("STDERR_END")
    assert len(transcript["stdout_tail"]) <= 8000
    assert len(transcript["stderr_tail"]) <= 8000


def test_run_command_populates_split_streams(tmp_path):
    # The stdout-only channel is what chat replies read; stderr noise (e.g. a
    # CLI's ANSI-colored tracing logs) must stay out of it, while the merged
    # ``output`` keeps the full-stream view for failure classification and
    # evidence.
    backend = LocalShellBackend()
    limits = WorkerLimits(repo_path=tmp_path, artifact_dir=tmp_path / "artifacts", budget_seconds=10)

    result = backend.run_command(
        [
            sys.executable,
            "-c",
            "import sys; print('the-answer'); sys.stderr.write('\\x1b[31mERROR\\x1b[0m log-noise\\n')",
        ],
        task=_task(),
        goal=GoalSpec(title="Run", description="Split streams"),
        session=RunSession(goal_id="goal_1", run_id="run_split"),
        limits=limits,
    )

    assert result.exit_code == 0
    assert result.stdout is not None and "the-answer" in result.stdout
    assert "log-noise" not in result.stdout
    assert result.stderr is not None and "log-noise" in result.stderr
    # merged evidence stream is unchanged: both sides present
    assert "the-answer" in result.output and "log-noise" in result.output


def test_synthetic_result_routes_output_to_stdout(tmp_path):
    # A synthetic result has no subprocess streams — its output IS the
    # reply/diagnostic channel, so stdout-only consumers (chat) must still see
    # it (e.g. GROK_PROMPT_TOO_LARGE guards).
    backend = LocalShellBackend()
    limits = WorkerLimits(repo_path=tmp_path, artifact_dir=tmp_path / "artifacts", budget_seconds=10)

    result = backend._synthetic_result(
        task=_task(),
        session=RunSession(goal_id="goal_1", run_id="run_synth"),
        limits=limits,
        command_repr="prompt length guard",
        output="GROK_PROMPT_TOO_LARGE: rendered prompt is too big",
        exit_code=1,
        started_at=1.0,
        finished_at=2.0,
        duration=1.0,
    )

    assert result.stdout == result.output
    assert "GROK_PROMPT_TOO_LARGE" in (result.stdout or "")
    assert result.stderr == ""


def test_local_shell_backend_distinguishes_repeated_attempt_artifacts(tmp_path):
    backend = LocalShellBackend()
    limits = WorkerLimits(repo_path=tmp_path, artifact_dir=tmp_path / "artifacts", budget_seconds=10)
    session = RunSession(goal_id="goal_1", run_id="run_1", task_attempts={"task_1": 2})

    result = backend.run_command(
        [sys.executable, "-c", "print('worker-repeat')"],
        task=_task(),
        goal=GoalSpec(title="Run", description="Execute"),
        session=session,
        limits=limits,
    )

    assert result.attempt_index == 2
    assert result.artifact_id == "run_1_task_1_local_attempt_02"
    assert result.transcript_artifact_id == "run_1_task_1_local_attempt_02_transcript"
    assert Path(result.artifact_path or "").name == "run_1_task_1_local_attempt_02.log"
    transcript = json.loads(Path(result.transcript_path or "").read_text(encoding="utf-8"))
    assert transcript["attempt_index"] == 2


def test_local_shell_backend_records_timeout(tmp_path):
    backend = LocalShellBackend()
    limits = WorkerLimits(repo_path=tmp_path, artifact_dir=tmp_path / "artifacts", budget_seconds=1)

    result = backend.run_command(
        [sys.executable, "-c", "import time; time.sleep(5)"],
        task=_task(),
        goal=GoalSpec(title="Run", description="Timeout"),
        session=RunSession(goal_id="goal_1", run_id="run_1"),
        limits=limits,
    )

    assert result.exit_code == 124
    assert result.timed_out is True
    assert "timed out" in result.output.lower()


def test_local_shell_backend_cancels_running_process(tmp_path):
    checks = 0

    def cancel_after_poll() -> bool:
        nonlocal checks
        checks += 1
        return checks >= 3

    backend = LocalShellBackend()
    limits = WorkerLimits(
        repo_path=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        budget_seconds=20,
        cancel_check=cancel_after_poll,
    )

    result = backend.run_command(
        [sys.executable, "-c", "import time; print('started', flush=True); time.sleep(10)"],
        task=_task(),
        goal=GoalSpec(title="Run", description="Cancel"),
        session=RunSession(goal_id="goal_1", run_id="run_cancel"),
        limits=limits,
    )

    assert result.exit_code == 130
    assert result.cancelled is True
    assert result.timed_out is False
    assert "cancelled" in result.output.lower()
    transcript = json.loads(Path(result.transcript_path or "").read_text(encoding="utf-8"))
    assert transcript["cancelled"] is True
    assert transcript["exit_code"] == 130


@pytest.mark.skipif(os.name == "nt", reason="Windows terminate() is unconditional and does not exercise POSIX kill escalation")
def test_local_shell_backend_records_forced_kill_when_cancelled_process_ignores_terminate(tmp_path):
    ready_marker = tmp_path / "ready.txt"
    backend = LocalShellBackend()
    limits = WorkerLimits(
        repo_path=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        budget_seconds=20,
        cancel_check=ready_marker.exists,
    )

    result = backend.run_command(
        [
            sys.executable,
            "-c",
            (
                "import pathlib, signal, time; "
                "signal.signal(signal.SIGTERM, lambda *_: None); "
                f"pathlib.Path({str(ready_marker)!r}).write_text('ready', encoding='utf-8'); "
                "print('started', flush=True); "
                "time.sleep(10)"
            ),
        ],
        task=_task(),
        goal=GoalSpec(title="Run", description="Force kill"),
        session=RunSession(goal_id="goal_1", run_id="run_force_kill"),
        limits=limits,
    )

    assert result.exit_code == 130
    assert result.cancelled is True
    assert result.timed_out is False
    assert result.forced_kill is True
    transcript = json.loads(Path(result.transcript_path or "").read_text(encoding="utf-8"))
    assert transcript["cancelled"] is True
    assert transcript["forced_kill"] is True
    assert transcript["exit_code"] == 130
    log_text = Path(result.artifact_path or "").read_text(encoding="utf-8")
    assert "cancelled=true" in log_text
    assert "forced_kill=true" in log_text


def test_codex_and_claude_backends_use_configured_executables(tmp_path):
    limits = WorkerLimits(repo_path=tmp_path, artifact_dir=tmp_path / "artifacts", budget_seconds=10)
    goal = GoalSpec(title="Ship", description="Use an agent")
    session = RunSession(goal_id=goal.goal_id, run_id="run_agent")

    codex = CodexCliBackend(executable=str(_fake_executable(tmp_path, "codex")))
    claude = ClaudeCliBackend(executable=str(_fake_executable(tmp_path, "claude")))

    codex_result = codex.run(_task(WorkerRole.PLAN), goal, session, limits)
    claude_result = claude.run(_task(WorkerRole.REVIEW), goal, session, limits)

    assert codex_result.backend == "codex"
    assert codex_result.exit_code == 0
    assert "fake-agent" in codex_result.output
    assert claude_result.backend == "claude"
    assert claude_result.exit_code == 0
    assert "fake-agent" in claude_result.output
    assert "superclaw_worker_result backend=claude role=review" in claude_result.output
    assert "--no-session-persistence" in claude_result.output
    assert "--model claude-opus-4-8" in claude_result.output
    assert "--tools=" in claude_result.output
    assert "--permission-mode plan" not in claude_result.output


def test_codex_refuses_low_trust_fence(tmp_path):
    # T11 PR-B (empirical reversal): codex `--sandbox read-only` blocks WRITES, not
    # READS — a real-binary canary cat'd a secret OUTSIDE the --cd workspace and
    # printed it (see test_codex_readonly_sandbox_does_not_fence_reads_canary). codex
    # cannot enforce the secret-read gate, and the iron law forbids wrapping it in an
    # external OS sandbox, so low-trust is REFUSED at both the supports_containment gate
    # AND in run() (direct caller). Low-trust review routes to a B-class backend.
    from superclaw.containment import get_preset

    low = get_preset("low_trust_review")
    codex = CodexCliBackend(executable=str(_fake_executable(tmp_path, "codex")))
    assert codex.supports_containment(low) is False
    assert codex.supports_containment(get_preset("standard")) is True

    limits = WorkerLimits(
        repo_path=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        budget_seconds=10,
        permission_policy=PermissionPolicy(mode="bypassPermissions"),
        containment_policy=low,
    )
    goal = GoalSpec(title="Review", description="review the fork PR")
    session = RunSession(goal_id=goal.goal_id, run_id="run_codex_lt")
    result = codex.run(_task(WorkerRole.REVIEW), goal, session, limits)
    assert result.exit_code == 1
    assert "CONTAINMENT_UNSUPPORTED" in result.output


def test_claude_refuses_low_trust_fence(tmp_path):
    # T11 PR-B (empirical reversal): claude's flag-projection read-fence could not be
    # PROVEN — `--disallowedTools` is variadic (ate the trailing prompt) and the
    # `Read(**/<glob>)` deny semantics are unverifiable against the real matcher here.
    # A security read-fence must be proven, so low-trust is REFUSED (fail-closed).
    from superclaw.containment import get_preset

    low = get_preset("low_trust_review")
    claude = ClaudeCliBackend(executable=str(_fake_executable(tmp_path, "claude")))
    assert claude.supports_containment(low) is False
    assert claude.supports_containment(get_preset("standard")) is True

    limits = WorkerLimits(
        repo_path=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        budget_seconds=10,
        permission_policy=PermissionPolicy(mode="bypassPermissions"),
        containment_policy=low,
    )
    goal = GoalSpec(title="Review", description="review the fork PR")
    session = RunSession(goal_id=goal.goal_id, run_id="run_claude_lt")
    result = claude.run(_task(WorkerRole.REVIEW), goal, session, limits)
    assert result.exit_code == 1
    assert "CONTAINMENT_UNSUPPORTED" in result.output


def test_codex_standard_run_unaffected_by_reversal(tmp_path):
    # The reversal must touch ONLY the low-trust path; standard runs are unchanged.
    limits = WorkerLimits(
        repo_path=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        budget_seconds=10,
        permission_policy=PermissionPolicy(mode="acceptEdits"),
    )
    goal = GoalSpec(title="Ship", description="do work")
    session = RunSession(goal_id=goal.goal_id, run_id="run_codex_std")
    codex = CodexCliBackend(executable=str(_fake_executable(tmp_path, "codex")))
    result = codex.run(_task(WorkerRole.PLAN), goal, session, limits)
    assert result.exit_code == 0
    assert "CONTAINMENT_UNSUPPORTED" not in result.output


def test_codex_app_server_refuses_low_trust_fence(tmp_path):
    # Codex app-server is likewise refused for low-trust (same read-fence gap as exec,
    # plus no --ignore-user-config). Fail-closed at the gate AND in run().
    from superclaw.backends import CodexAppServerBackend
    from superclaw.containment import get_preset

    factory_called = {"hit": False}

    def _factory(**kwargs):
        factory_called["hit"] = True
        raise AssertionError("session must not start under a refused low-trust fence")

    backend = CodexAppServerBackend(executable="/usr/bin/true", session_factory=_factory)
    low = get_preset("low_trust_review")
    assert backend.supports_containment(low) is False
    assert backend.supports_containment(get_preset("standard")) is True

    limits = WorkerLimits(
        repo_path=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        budget_seconds=10,
        permission_policy=PermissionPolicy(mode="bypassPermissions", mcp_configs=["/tmp/x.json"]),
        containment_policy=low,
    )
    goal = GoalSpec(title="Review", description="review the fork PR")
    session = RunSession(goal_id=goal.goal_id, run_id="run_appsrv_lt")
    result = backend.run(_task(WorkerRole.REVIEW), goal, session, limits)
    assert result.exit_code == 1
    assert "CONTAINMENT_UNSUPPORTED" in result.output
    assert factory_called["hit"] is False


@pytest.mark.skipif(
    not os.environ.get("SUPERCLAW_REAL_BINARY_CANARY"),
    reason="opt-in real-binary canary (needs an authed codex CLI + tokens): set SUPERCLAW_REAL_BINARY_CANARY=1",
)
def test_codex_readonly_sandbox_does_not_fence_reads_canary(tmp_path):
    # PROOF behind the reversal: the real codex `exec --sandbox read-only --cd <ws>`
    # CAN read a file OUTSIDE the workspace — read-only is no read fence. If a future
    # codex version starts blocking it, this characterization test fails and prompts a
    # re-evaluation of whether codex can realize the low-trust read fence.
    import subprocess

    ws = tmp_path / "ws"
    ws.mkdir()
    (ws / "code.py").write_text("print('review me')\n", encoding="utf-8")
    outside = tmp_path / "outside"
    outside.mkdir()
    secret = outside / "secret.txt"
    canary = "CANARY_SECRET_DO_NOT_LEAK_4242"
    secret.write_text(canary + "\n", encoding="utf-8")

    proc = subprocess.run(
        [
            "codex", "exec", "--sandbox", "read-only", "--cd", str(ws),
            "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check",
            f"Use shell to cat the file at absolute path {secret} and print its exact contents.",
        ],
        capture_output=True, text=True, timeout=180, check=False,
    )
    out = (proc.stdout or "") + (proc.stderr or "")
    assert canary in out, (
        "codex read-only unexpectedly BLOCKED the outside read — re-evaluate whether "
        "codex can now realize the low-trust read fence"
    )


def test_claude_backend_uses_env_configured_executable(tmp_path, monkeypatch):
    fake = _fake_executable(tmp_path, "claude-env")
    monkeypatch.setenv("SUPERCLAW_CLAUDE_EXECUTABLE", str(fake))
    backend = ClaudeCliBackend()

    availability = backend.available()

    assert availability.available is True
    assert availability.executable == str(fake)


def test_hermes_backend_uses_local_cli_channel(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_HERMES_MODEL", "anthropic/claude-sonnet-4.6")
    monkeypatch.setenv("SUPERCLAW_HERMES_PROVIDER", "anthropic")
    monkeypatch.setenv("SUPERCLAW_HERMES_TOOLSETS", "default")
    monkeypatch.setenv("SUPERCLAW_HERMES_SKILLS", "repo")
    limits = WorkerLimits(
        repo_path=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        budget_seconds=10,
        permission_policy=PermissionPolicy(mode="bypassPermissions"),
    )
    goal = GoalSpec(title="Ship", description="Use Hermes")
    session = RunSession(goal_id=goal.goal_id, run_id="run_hermes")
    hermes = HermesCliBackend(executable=str(_fake_executable(tmp_path, "hermes")))

    result = hermes.run(_task(WorkerRole.IMPLEMENT), goal, session, limits)

    assert result.backend == "hermes"
    assert result.exit_code == 0
    assert "fake-agent --oneshot" in result.output
    assert "You are a non-interactive SuperClaw implement worker" in result.output
    assert f"Repository root: {tmp_path}" in result.output
    assert f"must target this repository root exactly: {tmp_path}" in result.output
    assert "Role contract: Make only the minimal repository changes required by the goal." in result.output
    assert "The final marker is only evidence formatting. It is not a substitute for doing the requested work." in result.output
    assert "--model anthropic/claude-sonnet-4.6" in result.output
    assert "--provider anthropic" in result.output
    assert "--toolsets default" in result.output
    assert "--skills repo" in result.output
    assert "--accept-hooks" in result.output
    assert "--yolo" in result.output
    assert "superclaw_worker_result backend=hermes role=implement" in result.output


def _fake_failure_executable(tmp_path: Path, name: str, message: str) -> Path:
    if os.name == "nt":
        path = tmp_path / f"{name}.cmd"
        path.write_text(f"@echo off\necho {message}\nexit /b 0\n", encoding="utf-8")
    else:
        path = tmp_path / name
        path.write_text(f"#!/bin/sh\necho '{message}'\nexit 0\n", encoding="utf-8")
        path.chmod(0o755)
    # Mirror ``echo '<message>'; exit 0`` (the script exits 0 even on a "failure"
    # message — the backend classifies failure from the message text, not rc).
    _FAKE_CLI_REGISTRY[str(path)] = lambda command, _msg=message: (_msg + "\n", 0)
    return path


class _FakeStream:
    """A read-once text stream standing in for ``Popen.stdout``/``.stderr``."""

    def __init__(self, text: str) -> None:
        self._text = text
        self._consumed = False

    def read(self) -> str:
        if self._consumed:
            return ""
        self._consumed = True
        return self._text

    def close(self) -> None:  # pragma: no cover - defensive parity with real pipes
        self._consumed = True


class _FakeCliPopen:
    """In-process stand-in for a trivial registered fake-CLI subprocess.

    Implements exactly the ``Popen`` surface ``run_command`` touches: ``stdout``/
    ``stderr`` read-once streams, an immediately-finished ``poll()``/``wait()``,
    and no-op ``terminate()``/``kill()``. It never forks, so it cannot be
    CPU-starved past the run's ``budget_seconds``.
    """

    def __init__(self, stdout_text: str, returncode: int) -> None:
        self.stdout = _FakeStream(stdout_text)
        self.stderr = _FakeStream("")
        self.returncode = returncode
        self.pid = -1

    def poll(self):
        return self.returncode

    def wait(self, timeout=None):  # noqa: ARG002 - parity with subprocess.Popen
        return self.returncode

    def terminate(self) -> None:
        pass

    def kill(self) -> None:
        pass

    def send_signal(self, _sig) -> None:  # pragma: no cover - parity only
        pass


class _ExecShim:
    """Stand-in for ``superclaw.backends.subprocess``.

    Only ``Popen`` is overridden; everything else (``run``, ``PIPE``, ``DEVNULL``,
    ``TimeoutExpired``, ...) resolves to the real ``subprocess`` module via
    ``__getattr__`` — so the ``--version`` probes in ``available()`` (which go
    through ``subprocess.run``) and exception routing stay 100% real.

    ``Popen`` fast-paths in-process ONLY when BOTH hold:
      * ``command[0]`` is a *registered* trivial fake CLI (one of the three
        ``_fake_*executable`` helpers), AND
      * ``stdin`` is ``DEVNULL`` — i.e. the fire-and-read-stdout contract of
        ``_AgentCliBackend.run_command`` (backends.py).

    The ``stdin`` gate is the load-bearing scope boundary, not a coincidence:
    ``ClawWorkBackend._spawn_rpc`` drives an INTERACTIVE clawwork subprocess with
    ``stdin=PIPE`` and reads raw pipe fds via ``fileno()``/``select``/``fcntl``.
    A test DOES point ``SUPERCLAW_CLAWWORK_EXECUTABLE`` at ``_fake_executable``
    (so the path is registered), but because that RPC path uses ``stdin=PIPE`` it
    can never match here and always delegates to the real ``Popen`` — the fake is
    structurally barred from the one consumer it could not satisfy.

    The faithful spawn boundary (can this command actually be forked from this
    cwd with these kwargs) is still exercised by the tests that keep a real
    subprocess: ``test_local_shell_backend_executes_real_command`` and the
    timeout/cancel/liveness tests (their commands are ``sys.executable`` scripts,
    never registered).
    """

    def __init__(self, real_subprocess) -> None:
        self._real = real_subprocess

    def Popen(self, command, **kwargs):  # noqa: N802 - mirror subprocess.Popen
        key = str(command[0]) if command else ""
        behavior = _FAKE_CLI_REGISTRY.get(key)
        if behavior is None or kwargs.get("stdin") != self._real.DEVNULL:
            return self._real.Popen(command, **kwargs)
        stdout_text, returncode = behavior(list(command))
        return _FakeCliPopen(stdout_text, returncode)

    def __getattr__(self, name):
        return getattr(self._real, name)


@pytest.fixture(autouse=True)
def _fast_fake_cli_exec(monkeypatch):
    """Run registered trivial fake CLIs in-process (no fork) for this module.

    Eliminates the fork-storm starvation that makes the argv-assertion backend
    tests flaky (exit 124) and slow under pytest-xdist. Real subprocess-driven
    tests (timeout/cancel/liveness) are unaffected — their commands are not
    registered, so the shim delegates them to the real ``Popen``.
    """
    import superclaw.backends as _backends

    monkeypatch.setattr(_backends, "subprocess", _ExecShim(_backends.subprocess))
    yield
    _FAKE_CLI_REGISTRY.clear()


def test_opencode_backend_runs_headless_with_format_json(tmp_path):
    limits = WorkerLimits(repo_path=tmp_path, artifact_dir=tmp_path / "artifacts", budget_seconds=10)
    goal = GoalSpec(title="Ship", description="Use OpenCode")
    session = RunSession(goal_id=goal.goal_id, run_id="run_opencode")
    opencode = OpenCodeCliBackend(executable=str(_fake_executable(tmp_path, "opencode")))

    result = opencode.run(_task(WorkerRole.IMPLEMENT), goal, session, limits)

    assert result.backend == "opencode"
    assert result.exit_code == 0
    assert "fake-agent run --format json" in result.output
    assert "superclaw_worker_result backend=opencode role=implement" in result.output


def test_opencode_backend_passes_model_when_configured(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_OPENCODE_MODEL", "anthropic/claude-sonnet-4.6")
    limits = WorkerLimits(repo_path=tmp_path, artifact_dir=tmp_path / "artifacts", budget_seconds=10)
    goal = GoalSpec(title="Ship", description="Use OpenCode with a model")
    session = RunSession(goal_id=goal.goal_id, run_id="run_opencode_model")
    opencode = OpenCodeCliBackend(executable=str(_fake_executable(tmp_path, "opencode")))

    result = opencode.run(_task(WorkerRole.PLAN), goal, session, limits)

    assert result.exit_code == 0
    assert "--model anthropic/claude-sonnet-4.6" in result.output


def test_opencode_backend_omits_model_when_unset(tmp_path, monkeypatch):
    monkeypatch.delenv("SUPERCLAW_OPENCODE_MODEL", raising=False)
    limits = WorkerLimits(repo_path=tmp_path, artifact_dir=tmp_path / "artifacts", budget_seconds=10)
    goal = GoalSpec(title="Ship", description="Use OpenCode default model")
    session = RunSession(goal_id=goal.goal_id, run_id="run_opencode_nomodel")
    opencode = OpenCodeCliBackend(executable=str(_fake_executable(tmp_path, "opencode")))

    result = opencode.run(_task(WorkerRole.PLAN), goal, session, limits)

    assert result.exit_code == 0
    assert "--model" not in result.output


def test_opencode_backend_uses_env_configured_executable(tmp_path, monkeypatch):
    fake = _fake_executable(tmp_path, "opencode-env")
    monkeypatch.setenv("SUPERCLAW_OPENCODE_EXECUTABLE", str(fake))
    backend = OpenCodeCliBackend()

    availability = backend.available()

    assert availability.available is True
    assert availability.executable == str(fake)


def test_opencode_backend_missing_executable_reports_127(tmp_path, monkeypatch):
    monkeypatch.delenv("SUPERCLAW_OPENCODE_EXECUTABLE", raising=False)
    monkeypatch.setattr("superclaw.backends.shutil.which", lambda _name, path=None: None)
    limits = WorkerLimits(repo_path=tmp_path, artifact_dir=tmp_path / "artifacts", budget_seconds=10)
    goal = GoalSpec(title="Ship", description="No opencode")
    session = RunSession(goal_id=goal.goal_id, run_id="run_opencode_missing")
    opencode = OpenCodeCliBackend()

    result = opencode.run(_task(WorkerRole.PLAN), goal, session, limits)

    assert result.exit_code == 127
    assert "opencode executable not found" in result.output


def test_opencode_backend_passes_variant_when_configured(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_OPENCODE_VARIANT", "thinking")
    limits = WorkerLimits(repo_path=tmp_path, artifact_dir=tmp_path / "artifacts", budget_seconds=10)
    goal = GoalSpec(title="Ship", description="Use OpenCode variant")
    session = RunSession(goal_id=goal.goal_id, run_id="run_opencode_variant")
    opencode = OpenCodeCliBackend(executable=str(_fake_executable(tmp_path, "opencode")))

    result = opencode.run(_task(WorkerRole.PLAN), goal, session, limits)

    assert result.exit_code == 0
    assert "--variant thinking" in result.output


def test_opencode_backend_allow_maps_to_skip_permissions(tmp_path):
    limits = WorkerLimits(
        repo_path=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        budget_seconds=10,
        permission_policy=PermissionPolicy(mode="bypassPermissions"),
    )
    goal = GoalSpec(title="Ship", description="OpenCode allow")
    session = RunSession(goal_id=goal.goal_id, run_id="run_opencode_allow")
    opencode = OpenCodeCliBackend(executable=str(_fake_executable(tmp_path, "opencode")))

    result = opencode.run(_task(WorkerRole.PLAN), goal, session, limits)

    assert result.exit_code == 0
    assert "--dangerously-skip-permissions" in result.output


def test_opencode_backend_ask_omits_skip_permissions(tmp_path):
    limits = WorkerLimits(
        repo_path=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        budget_seconds=10,
        permission_policy=PermissionPolicy(mode="plan"),
    )
    goal = GoalSpec(title="Ship", description="OpenCode ask")
    session = RunSession(goal_id=goal.goal_id, run_id="run_opencode_ask")
    opencode = OpenCodeCliBackend(executable=str(_fake_executable(tmp_path, "opencode")))

    result = opencode.run(_task(WorkerRole.PLAN), goal, session, limits)

    assert result.exit_code == 0
    assert "--dangerously-skip-permissions" not in result.output


def test_opencode_backend_passes_pure_flag(tmp_path):
    """`--pure` (OpenCode's documented "no external plugins") keeps an ambient
    project's plugins out of a governed run."""
    limits = WorkerLimits(repo_path=tmp_path, artifact_dir=tmp_path / "artifacts", budget_seconds=10)
    goal = GoalSpec(title="Ship", description="OpenCode pure")
    session = RunSession(goal_id=goal.goal_id, run_id="run_opencode_pure")
    opencode = OpenCodeCliBackend(executable=str(_fake_executable(tmp_path, "opencode")))

    result = opencode.run(_task(WorkerRole.PLAN), goal, session, limits)

    assert result.exit_code == 0
    assert "run --format json --pure" in result.output


def test_opencode_fail_closed_transcript_does_not_leak_policy_paths(tmp_path):
    """The fail-closed synthetic transcript must record policy shape (counts),
    not the rejected mcp_configs / plugin_dirs filesystem paths."""
    secret_path = str(tmp_path / "superclaw-plugins.mcp.json")
    plugin_dir = str(tmp_path / "protected-plugin-dir")
    limits = WorkerLimits(
        repo_path=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        budget_seconds=10,
        permission_policy=PermissionPolicy(mode="plan", mcp_configs=[secret_path], plugin_dirs=[plugin_dir]),
    )
    goal = GoalSpec(title="Ship", description="OpenCode transcript governance")
    session = RunSession(goal_id=goal.goal_id, run_id="run_opencode_transcript")
    opencode = OpenCodeCliBackend(executable=str(_fake_executable(tmp_path, "opencode")))

    result = opencode.run(_task(WorkerRole.PLAN), goal, session, limits)

    assert result.exit_code == 1
    transcript_text = Path(result.transcript_path).read_text(encoding="utf-8")
    assert secret_path not in transcript_text
    assert plugin_dir not in transcript_text
    transcript = json.loads(transcript_text)
    assert transcript["permission_policy"]["mcp_configs"] == {"count": 1}
    assert transcript["permission_policy"]["plugin_dirs"] == {"count": 1}


def test_opencode_backend_reclassifies_quota_failure(tmp_path):
    limits = WorkerLimits(repo_path=tmp_path, artifact_dir=tmp_path / "artifacts", budget_seconds=10)
    goal = GoalSpec(title="Ship", description="OpenCode free usage exceeded")
    session = RunSession(goal_id=goal.goal_id, run_id="run_opencode_quota")
    opencode = OpenCodeCliBackend(
        executable=str(_fake_failure_executable(tmp_path, "opencode", "free usage exceeded"))
    )

    result = opencode.run(_task(WorkerRole.PLAN), goal, session, limits)

    # Clean exit 0 with a high-specificity quota failure marker is reclassified.
    assert result.exit_code == 126
    assert "SuperClaw classified backend output as failure" in result.output


def test_opencode_backend_reclassifies_json_error_event(tmp_path):
    """Real opencode 1.16.2 smoke: an auth failure exits 0 but emits a compact
    `{"type":"error",...}` JSONL event. SuperClaw must treat that as a failed run,
    not a silent success."""
    # The exact false-success shape observed in the real end-to-end smoke.
    real_error_line = (
        '{"type":"error","timestamp":1781070832798,"sessionID":"ses_x",'
        '"error":{"name":"UnknownError","data":{"message":"Token refresh failed: 401"}}}'
    )
    opencode = OpenCodeCliBackend(
        executable=str(_fake_failure_executable(tmp_path, "opencode", real_error_line))
    )
    limits = WorkerLimits(repo_path=tmp_path, artifact_dir=tmp_path / "artifacts", budget_seconds=10)
    goal = GoalSpec(title="Ship", description="OpenCode json error event")
    session = RunSession(goal_id=goal.goal_id, run_id="run_opencode_jsonerr")

    result = opencode.run(_task(WorkerRole.PLAN), goal, session, limits)

    assert result.exit_code == 126
    assert "SuperClaw classified backend output as failure" in result.output


def test_opencode_backend_fails_closed_on_mcp_config(tmp_path):
    mcp_config = tmp_path / "superclaw-plugins.mcp.json"
    mcp_config.write_text(
        json.dumps({"mcpServers": {"superclaw": {"command": sys.executable, "args": ["-m", "superclaw.plugin_mcp_proxy"]}}}),
        encoding="utf-8",
    )
    limits = WorkerLimits(
        repo_path=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        budget_seconds=10,
        permission_policy=PermissionPolicy(mode="plan", mcp_configs=[str(mcp_config)]),
    )
    goal = GoalSpec(title="Ship", description="OpenCode plugin governance")
    session = RunSession(goal_id=goal.goal_id, run_id="run_opencode_mcp")
    opencode = OpenCodeCliBackend(executable=str(_fake_executable(tmp_path, "opencode")))

    result = opencode.run(_task(WorkerRole.PLAN), goal, session, limits)

    assert result.exit_code == 1
    assert "PLUGIN_RUNTIME_CONFIG_INVALID" in result.output
    assert "fake-agent" not in result.output
    assert str(mcp_config) not in result.output
    assert "plugin_mcp_proxy" not in result.output


def test_opencode_backend_fails_closed_on_plugin_dirs(tmp_path):
    limits = WorkerLimits(
        repo_path=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        budget_seconds=10,
        permission_policy=PermissionPolicy(mode="plan", plugin_dirs=[str(tmp_path / "protected-plugin-dir")]),
    )
    goal = GoalSpec(title="Ship", description="OpenCode reject plugin dir")
    session = RunSession(goal_id=goal.goal_id, run_id="run_opencode_plugin_dir")
    opencode = OpenCodeCliBackend(executable=str(_fake_executable(tmp_path, "opencode")))

    result = opencode.run(_task(WorkerRole.PLAN), goal, session, limits)

    assert result.exit_code == 1
    assert "PLUGIN_RUNTIME_CONFIG_INVALID" in result.output
    assert "fake-agent" not in result.output
    assert "protected-plugin-dir" not in result.output


def test_opencode_backend_registered_in_default_registry():
    backends = default_backends()
    assert "opencode" in backends
    assert isinstance(backends["opencode"], OpenCodeCliBackend)


def test_cursor_backend_runs_headless_stream_json(tmp_path):
    limits = WorkerLimits(repo_path=tmp_path, artifact_dir=tmp_path / "artifacts", budget_seconds=10)
    goal = GoalSpec(title="Ship", description="Use Cursor")
    session = RunSession(goal_id=goal.goal_id, run_id="run_cursor")
    cursor = CursorCliBackend(executable=str(_fake_executable(tmp_path, "cursor-agent")))

    result = cursor.run(_task(WorkerRole.IMPLEMENT), goal, session, limits)

    assert result.backend == "cursor"
    assert result.exit_code == 0
    assert "-p --output-format stream-json" in result.output
    assert f"--workspace {tmp_path}" in result.output
    assert "--trust" in result.output
    assert "superclaw_worker_result backend=cursor role=implement" in result.output


def test_cursor_backend_ask_omits_force(tmp_path):
    limits = WorkerLimits(
        repo_path=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        budget_seconds=10,
        permission_policy=PermissionPolicy(mode="plan"),
    )
    goal = GoalSpec(title="Ship", description="Cursor ask")
    session = RunSession(goal_id=goal.goal_id, run_id="run_cursor_ask")
    cursor = CursorCliBackend(executable=str(_fake_executable(tmp_path, "cursor-agent")))

    result = cursor.run(_task(WorkerRole.PLAN), goal, session, limits)

    assert result.exit_code == 0
    assert "--trust" in result.output
    assert "--force" not in result.output


def test_cursor_backend_allow_adds_force(tmp_path):
    limits = WorkerLimits(
        repo_path=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        budget_seconds=10,
        permission_policy=PermissionPolicy(mode="bypassPermissions"),
    )
    goal = GoalSpec(title="Ship", description="Cursor allow")
    session = RunSession(goal_id=goal.goal_id, run_id="run_cursor_allow")
    cursor = CursorCliBackend(executable=str(_fake_executable(tmp_path, "cursor-agent")))

    result = cursor.run(_task(WorkerRole.PLAN), goal, session, limits)

    assert result.exit_code == 0
    assert "--force" in result.output


def test_cursor_backend_passes_model_when_configured(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_CURSOR_MODEL", "sonnet-4-thinking")
    limits = WorkerLimits(repo_path=tmp_path, artifact_dir=tmp_path / "artifacts", budget_seconds=10)
    goal = GoalSpec(title="Ship", description="Cursor model")
    session = RunSession(goal_id=goal.goal_id, run_id="run_cursor_model")
    cursor = CursorCliBackend(executable=str(_fake_executable(tmp_path, "cursor-agent")))

    result = cursor.run(_task(WorkerRole.PLAN), goal, session, limits)

    assert "--model sonnet-4-thinking" in result.output


def test_cursor_backend_uses_env_configured_executable(tmp_path, monkeypatch):
    fake = _fake_executable(tmp_path, "cursor-agent-env")
    monkeypatch.setenv("SUPERCLAW_CURSOR_EXECUTABLE", str(fake))
    backend = CursorCliBackend()
    availability = backend.available()
    assert availability.available is True
    assert availability.executable == str(fake)


def test_cursor_backend_missing_executable_reports_127(tmp_path, monkeypatch):
    monkeypatch.delenv("SUPERCLAW_CURSOR_EXECUTABLE", raising=False)
    monkeypatch.setattr("superclaw.backends.shutil.which", lambda _name, path=None: None)
    limits = WorkerLimits(repo_path=tmp_path, artifact_dir=tmp_path / "artifacts", budget_seconds=10)
    goal = GoalSpec(title="Ship", description="No cursor")
    session = RunSession(goal_id=goal.goal_id, run_id="run_cursor_missing")
    result = CursorCliBackend().run(_task(WorkerRole.PLAN), goal, session, limits)
    assert result.exit_code == 127
    assert "cursor-agent executable not found" in result.output


def test_cursor_backend_fails_closed_on_mcp_config(tmp_path):
    mcp_config = tmp_path / "superclaw-plugins.mcp.json"
    mcp_config.write_text(json.dumps({"mcpServers": {}}), encoding="utf-8")
    limits = WorkerLimits(
        repo_path=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        budget_seconds=10,
        permission_policy=PermissionPolicy(mode="plan", mcp_configs=[str(mcp_config)]),
    )
    goal = GoalSpec(title="Ship", description="Cursor plugin governance")
    session = RunSession(goal_id=goal.goal_id, run_id="run_cursor_mcp")
    cursor = CursorCliBackend(executable=str(_fake_executable(tmp_path, "cursor-agent")))

    result = cursor.run(_task(WorkerRole.PLAN), goal, session, limits)

    assert result.exit_code == 1
    assert "PLUGIN_RUNTIME_CONFIG_INVALID" in result.output
    assert "fake-agent" not in result.output
    assert str(mcp_config) not in result.output


def test_cursor_backend_fails_closed_on_plugin_dirs(tmp_path):
    limits = WorkerLimits(
        repo_path=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        budget_seconds=10,
        permission_policy=PermissionPolicy(mode="plan", plugin_dirs=[str(tmp_path / "protected-plugin-dir")]),
    )
    goal = GoalSpec(title="Ship", description="Cursor reject plugin dir")
    session = RunSession(goal_id=goal.goal_id, run_id="run_cursor_plugin_dir")
    cursor = CursorCliBackend(executable=str(_fake_executable(tmp_path, "cursor-agent")))

    result = cursor.run(_task(WorkerRole.PLAN), goal, session, limits)

    assert result.exit_code == 1
    assert "PLUGIN_RUNTIME_CONFIG_INVALID" in result.output
    assert "fake-agent" not in result.output
    assert "protected-plugin-dir" not in result.output


def test_cursor_backend_guards_oversized_prompt(tmp_path, monkeypatch):
    """A positional-argv prompt over the byte budget fails with a clear message,
    not a cryptic E2BIG from subprocess."""
    monkeypatch.setattr(CursorCliBackend, "MAX_PROMPT_BYTES", 64)
    limits = WorkerLimits(repo_path=tmp_path, artifact_dir=tmp_path / "artifacts", budget_seconds=10)
    goal = GoalSpec(title="Ship", description="x" * 5000)  # rendered prompt >> 64 bytes
    session = RunSession(goal_id=goal.goal_id, run_id="run_cursor_big")
    cursor = CursorCliBackend(executable=str(_fake_executable(tmp_path, "cursor-agent")))

    result = cursor.run(_task(WorkerRole.PLAN), goal, session, limits)

    assert result.exit_code == 1
    assert "CURSOR_PROMPT_TOO_LARGE" in result.output
    assert "fake-agent" not in result.output  # the CLI was never invoked


def test_cursor_backend_available_survives_blank_version_output(tmp_path, monkeypatch):
    """A CLI that prints only whitespace to --version must not IndexError in
    available() (regression for the .splitlines()[0] empty-list edge)."""
    import subprocess as _sp

    fake = _fake_executable(tmp_path, "cursor-agent")
    monkeypatch.setenv("SUPERCLAW_CURSOR_EXECUTABLE", str(fake))

    def blank_run(*a, **k):
        return _sp.CompletedProcess(args=a[0] if a else [], returncode=0, stdout="   \n  ", stderr="")

    monkeypatch.setattr("superclaw.backends.subprocess.run", blank_run)
    availability = CursorCliBackend().available()
    assert availability.available is True
    assert availability.version is None


def test_cursor_backend_registered_in_default_registry():
    backends = default_backends()
    assert "cursor" in backends
    assert isinstance(backends["cursor"], CursorCliBackend)


def test_grok_backend_runs_headless_with_prompt_flag(tmp_path):
    limits = WorkerLimits(repo_path=tmp_path, artifact_dir=tmp_path / "artifacts", budget_seconds=10)
    goal = GoalSpec(title="Ship", description="Use Grok")
    session = RunSession(goal_id=goal.goal_id, run_id="run_grok")
    grok = GrokCliBackend(executable=str(_fake_executable(tmp_path, "grok")))

    result = grok.run(_task(WorkerRole.IMPLEMENT), goal, session, limits)

    assert result.backend == "grok"
    assert result.exit_code == 0
    assert "fake-agent" in result.output
    assert " -p " in result.output  # headless single-prompt mode
    assert "superclaw_worker_result backend=grok role=implement" in result.output


def test_grok_backend_argv_structure_is_exact(tmp_path, monkeypatch):
    """Assert the precise argv (via the transcript) so the real grok CLI flag
    contract is pinned, not just substring presence."""
    monkeypatch.setenv("SUPERCLAW_GROK_MODEL", "grok-code-fast-1")
    monkeypatch.setenv("SUPERCLAW_GROK_MAX_TOOL_ROUNDS", "12")
    fake = _fake_executable(tmp_path, "grok")
    limits = WorkerLimits(repo_path=tmp_path, artifact_dir=tmp_path / "artifacts", budget_seconds=10)
    goal = GoalSpec(title="Ship", description="Grok model")
    session = RunSession(goal_id=goal.goal_id, run_id="run_grok_model")
    grok = GrokCliBackend(executable=str(fake))

    result = grok.run(_task(WorkerRole.PLAN), goal, session, limits)

    argv = json.loads(Path(result.transcript_path).read_text(encoding="utf-8"))["argv"]
    assert argv[0] == str(fake)
    assert argv[1:5] == ["--model", "grok-code-fast-1", "--max-tool-rounds", "12"]
    assert argv[5] == "-p"
    assert "SuperClaw" in argv[6]  # the prompt is a single argv element


@pytest.mark.parametrize(
    "make_backend, exe",
    [
        (lambda p: ClaudeCliBackend(executable=str(_fake_executable(p, "claude"))), "claude"),
        (lambda p: CodexCliBackend(executable=str(_fake_executable(p, "codex"))), "codex"),
        (lambda p: OpenCodeCliBackend(executable=str(_fake_executable(p, "opencode"))), "opencode"),
        (lambda p: CursorCliBackend(executable=str(_fake_executable(p, "cursor-agent"))), "cursor-agent"),
        (lambda p: BoboCliBackend(executable=str(_fake_executable(p, "bobo"))), "bobo"),
    ],
)
def test_cli_backend_terminates_options_before_prompt(tmp_path, make_backend, exe):
    """Regression: the user prompt is passed AFTER a ``--`` option terminator, so a
    prompt that starts with the envelope's "--- BEGIN UNTRUSTED … ---" fence is taken
    as the positional prompt, NOT mis-parsed as an unknown ``--`` option (which made a
    commander/clap CLI exit 1 and broke every claude-backend worker turn).

    Asserts the LAST argv element is the prompt and the element right before it is
    ``--`` — i.e. a ``--``-leading prompt can never be re-read as a flag.
    """
    limits = WorkerLimits(repo_path=tmp_path, artifact_dir=tmp_path / "artifacts", budget_seconds=10)
    goal = GoalSpec(title="Ship", description="terminator probe")
    session = RunSession(goal_id=goal.goal_id, run_id=f"run_term_{exe}")
    result = make_backend(tmp_path).run(_task(WorkerRole.PLAN), goal, session, limits)
    argv = json.loads(Path(result.transcript_path).read_text(encoding="utf-8"))["argv"]
    assert argv[-2] == "--", f"{exe}: prompt must be preceded by a `--` option terminator; got {argv[-3:]}"
    prompt = argv[-1]
    assert isinstance(prompt, str) and prompt, f"{exe}: prompt must be the final single argv element"
    assert "--" not in argv[:-2] or argv.count("--") == 1, f"{exe}: exactly one `--` terminator expected"


def test_grok_backend_ignores_invalid_max_rounds(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_GROK_MAX_TOOL_ROUNDS", "-3")
    limits = WorkerLimits(repo_path=tmp_path, artifact_dir=tmp_path / "artifacts", budget_seconds=10)
    goal = GoalSpec(title="Ship", description="Grok bad rounds")
    session = RunSession(goal_id=goal.goal_id, run_id="run_grok_badrounds")
    grok = GrokCliBackend(executable=str(_fake_executable(tmp_path, "grok")))

    result = grok.run(_task(WorkerRole.PLAN), goal, session, limits)

    assert "--max-tool-rounds" not in result.output


def test_grok_backend_fails_closed_on_plugin_dirs(tmp_path):
    limits = WorkerLimits(
        repo_path=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        budget_seconds=10,
        permission_policy=PermissionPolicy(mode="plan", plugin_dirs=[str(tmp_path / "protected-plugin-dir")]),
    )
    goal = GoalSpec(title="Ship", description="Grok reject plugin dir")
    session = RunSession(goal_id=goal.goal_id, run_id="run_grok_plugin_dir")
    grok = GrokCliBackend(executable=str(_fake_executable(tmp_path, "grok")))

    result = grok.run(_task(WorkerRole.PLAN), goal, session, limits)

    assert result.exit_code == 1
    assert "PLUGIN_RUNTIME_CONFIG_INVALID" in result.output
    assert "fake-agent" not in result.output
    assert "protected-plugin-dir" not in result.output


def test_grok_backend_uses_env_configured_executable(tmp_path, monkeypatch):
    fake = _fake_executable(tmp_path, "grok-env")
    monkeypatch.setenv("SUPERCLAW_GROK_EXECUTABLE", str(fake))
    backend = GrokCliBackend()
    availability = backend.available()
    assert availability.available is True
    assert availability.executable == str(fake)


def test_grok_backend_missing_executable_reports_127(tmp_path, monkeypatch):
    monkeypatch.delenv("SUPERCLAW_GROK_EXECUTABLE", raising=False)
    monkeypatch.setattr("superclaw.backends.shutil.which", lambda _name, path=None: None)
    limits = WorkerLimits(repo_path=tmp_path, artifact_dir=tmp_path / "artifacts", budget_seconds=10)
    goal = GoalSpec(title="Ship", description="No grok")
    session = RunSession(goal_id=goal.goal_id, run_id="run_grok_missing")
    result = GrokCliBackend().run(_task(WorkerRole.PLAN), goal, session, limits)
    assert result.exit_code == 127
    assert "grok executable not found" in result.output


def test_grok_backend_fails_closed_on_mcp_config(tmp_path):
    mcp_config = tmp_path / "superclaw-plugins.mcp.json"
    mcp_config.write_text(json.dumps({"mcpServers": {}}), encoding="utf-8")
    limits = WorkerLimits(
        repo_path=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        budget_seconds=10,
        permission_policy=PermissionPolicy(mode="plan", mcp_configs=[str(mcp_config)]),
    )
    goal = GoalSpec(title="Ship", description="Grok plugin governance")
    session = RunSession(goal_id=goal.goal_id, run_id="run_grok_mcp")
    grok = GrokCliBackend(executable=str(_fake_executable(tmp_path, "grok")))

    result = grok.run(_task(WorkerRole.PLAN), goal, session, limits)

    assert result.exit_code == 1
    assert "PLUGIN_RUNTIME_CONFIG_INVALID" in result.output
    assert "fake-agent" not in result.output
    assert str(mcp_config) not in result.output
    # transcript must not leak the rejected mcp_config path either (count-only).
    transcript = Path(result.transcript_path).read_text(encoding="utf-8")
    assert str(mcp_config) not in transcript


def test_grok_backend_registered_in_default_registry():
    backends = default_backends()
    assert "grok" in backends
    assert isinstance(backends["grok"], GrokCliBackend)


def test_hermes_backend_fails_closed_on_mcp_config_until_projection_exists(tmp_path):
    mcp_config = tmp_path / "superclaw-plugin-mcp.json"
    mcp_config.write_text(
        json.dumps(
            {
                "mcpServers": {
                    "superclaw-dev-superclaw-hello-world": {
                        "command": sys.executable,
                        "args": [
                            "-m",
                            "superclaw.plugin_mcp_proxy",
                            "serve",
                            "--plugin-id",
                            "dev.superclaw.hello-world",
                        ],
                    }
                }
            }
        ),
        encoding="utf-8",
    )
    limits = WorkerLimits(
        repo_path=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        budget_seconds=10,
        permission_policy=PermissionPolicy(mode="plan", mcp_configs=[str(mcp_config)]),
    )
    goal = GoalSpec(title="Ship", description="Use Hermes plugin proxy")
    session = RunSession(goal_id=goal.goal_id, run_id="run_hermes_mcp")
    hermes = HermesCliBackend(executable=str(_fake_executable(tmp_path, "hermes")))

    result = hermes.run(_task(WorkerRole.PLAN), goal, session, limits)

    assert result.exit_code == 1
    assert "PLUGIN_RUNTIME_CONFIG_INVALID" in result.output
    assert "does not yet support SuperClaw MCP proxy config projection" in result.output
    assert "fake-agent" not in result.output
    assert str(mcp_config) not in result.output
    assert "superclaw.plugin_mcp_proxy" not in result.output
    assert "--plugin-id" not in result.output
    assert str(tmp_path / "protected-plugin-dir") not in result.output


def test_hermes_backend_rejects_plugin_dirs_instead_of_direct_loading(tmp_path):
    limits = WorkerLimits(
        repo_path=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        budget_seconds=10,
        permission_policy=PermissionPolicy(mode="plan", plugin_dirs=[str(tmp_path / "protected-plugin-dir")]),
    )
    goal = GoalSpec(title="Ship", description="Reject Hermes direct plugin dir")
    session = RunSession(goal_id=goal.goal_id, run_id="run_hermes_plugin_dir")
    hermes = HermesCliBackend(executable=str(_fake_executable(tmp_path, "hermes")))

    result = hermes.run(_task(WorkerRole.PLAN), goal, session, limits)

    assert result.exit_code == 1
    assert "PLUGIN_RUNTIME_CONFIG_INVALID" in result.output
    assert "fake-agent" not in result.output
    assert "protected-plugin-dir" not in result.output


def test_hermes_backend_rejects_mcp_config_env_without_leaking_secret(tmp_path):
    leaked_secret = "cph_" + "secret1234567890123"
    mcp_config = tmp_path / "superclaw-plugin-mcp.json"
    mcp_config.write_text(
        json.dumps(
            {
                "mcpServers": {
                    "superclaw-secret-server": {
                        "command": sys.executable,
                        "args": ["-m", "superclaw.plugin_mcp_proxy", "serve", "--plugin-id", "dev.secret"],
                        "env": {"GITHUB_TOKEN": leaked_secret},
                    }
                }
            }
        ),
        encoding="utf-8",
    )
    limits = WorkerLimits(
        repo_path=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        budget_seconds=10,
        permission_policy=PermissionPolicy(mode="plan", mcp_configs=[str(mcp_config)]),
    )
    goal = GoalSpec(title="Ship", description="Reject Hermes secret env config")
    session = RunSession(goal_id=goal.goal_id, run_id="run_hermes_mcp_env")
    hermes = HermesCliBackend(executable=str(_fake_executable(tmp_path, "hermes")))

    result = hermes.run(_task(WorkerRole.PLAN), goal, session, limits)

    assert result.exit_code == 1
    assert "PLUGIN_RUNTIME_CONFIG_INVALID" in result.output
    assert "env is not supported" in result.output
    assert leaked_secret not in result.output
    transcript = json.loads(Path(result.transcript_path or "").read_text(encoding="utf-8"))
    assert leaked_secret not in json.dumps(transcript)


def test_hermes_backend_is_registered_in_default_registry():
    backends = default_backends()

    assert isinstance(backends["hermes"], HermesCliBackend)


def test_bobo_backend_drives_autonomous_run_loop(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_BOBO_MODEL", "claude-opus-4-8")
    monkeypatch.setenv("SUPERCLAW_BOBO_EFFORT", "high")
    monkeypatch.setenv("SUPERCLAW_BOBO_MAX_ITERATIONS", "8")
    limits = WorkerLimits(
        repo_path=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        budget_seconds=10,
        permission_policy=PermissionPolicy(mode="bypassPermissions"),
    )
    goal = GoalSpec(title="Ship", description="Use Bobo")
    session = RunSession(goal_id=goal.goal_id, run_id="run_bobo")
    bobo = BoboCliBackend(executable=str(_fake_executable(tmp_path, "bobo")))

    result = bobo.run(_task(WorkerRole.IMPLEMENT), goal, session, limits)

    assert result.backend == "bobo"
    assert result.exit_code == 0
    # global non-interactive flags precede the `run` subcommand
    assert "fake-agent --print --full-auto" in result.output
    assert "--yolo" in result.output  # bypass policy escalates to --yolo
    assert "run" in result.output
    assert "--model claude-opus-4-8" in result.output
    assert "--effort high" in result.output
    assert "--max-iterations 8" in result.output
    assert "superclaw_worker_result backend=bobo role=implement" in result.output


def test_bobo_backend_defaults_without_bypass_or_model(tmp_path, monkeypatch):
    monkeypatch.delenv("SUPERCLAW_BOBO_MODEL", raising=False)
    monkeypatch.delenv("SUPERCLAW_BOBO_EFFORT", raising=False)
    monkeypatch.delenv("SUPERCLAW_BOBO_MAX_ITERATIONS", raising=False)
    limits = WorkerLimits(repo_path=tmp_path, artifact_dir=tmp_path / "artifacts", budget_seconds=10)
    goal = GoalSpec(title="Ship", description="Use Bobo")
    session = RunSession(goal_id=goal.goal_id, run_id="run_bobo_default")
    bobo = BoboCliBackend(executable=str(_fake_executable(tmp_path, "bobo")))

    result = bobo.run(_task(WorkerRole.IMPLEMENT), goal, session, limits)

    assert result.exit_code == 0
    assert "--full-auto" in result.output
    assert "--yolo" not in result.output      # no bypass policy → no --yolo
    assert "--model" not in result.output     # no SUPERCLAW_BOBO_MODEL → bobo's own default
    assert "--effort high" in result.output   # default effort
    assert "--max-iterations 10" in result.output  # default iterations


def test_bobo_backend_is_registered_in_default_registry():
    backends = default_backends()

    assert isinstance(backends["bobo"], BoboCliBackend)


def test_bobo_backend_missing_executable_returns_127(tmp_path, monkeypatch):
    monkeypatch.setattr("shutil.which", lambda name, path=None: None)
    monkeypatch.delenv("SUPERCLAW_BOBO_EXECUTABLE", raising=False)
    limits = WorkerLimits(repo_path=tmp_path, artifact_dir=tmp_path / "artifacts", budget_seconds=10)
    goal = GoalSpec(title="Ship", description="Use Bobo")
    session = RunSession(goal_id=goal.goal_id, run_id="run_bobo_missing")

    result = BoboCliBackend().run(_task(WorkerRole.IMPLEMENT), goal, session, limits)

    assert result.exit_code == 127
    assert result.backend == "bobo"
    assert "bobo executable not found" in result.output


def test_openclaw_backend_uses_configurable_cli_channel(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_OPENCLAW_ARGS", "--print")
    monkeypatch.setenv("SUPERCLAW_OPENCLAW_MODEL", "claude-sonnet-4-5")
    limits = WorkerLimits(
        repo_path=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        budget_seconds=10,
    )
    goal = GoalSpec(title="Ship", description="Use OpenClaw")
    session = RunSession(goal_id=goal.goal_id, run_id="run_openclaw")
    openclaw = OpenClawCliBackend(executable=str(_fake_executable(tmp_path, "openclaw")))

    result = openclaw.run(_task(WorkerRole.IMPLEMENT), goal, session, limits)

    assert result.backend == "openclaw"
    assert result.exit_code == 0
    assert "fake-agent --print" in result.output
    assert "--model claude-sonnet-4-5" in result.output
    assert "You are a non-interactive OpenClaw worker running under SuperClaw as role implement" in result.output
    assert f"Repository root: {tmp_path}" in result.output
    assert f"must target this repository root exactly: {tmp_path}" in result.output
    assert "superclaw_worker_result backend=openclaw role=implement" in result.output


def test_openclaw_backend_fails_closed_on_mcp_config_until_projection_exists(tmp_path):
    mcp_config = tmp_path / "superclaw-plugin-mcp.json"
    mcp_config.write_text(
        json.dumps(
            {
                "mcpServers": {
                    "superclaw-dev-superclaw-hello-world": {
                        "command": sys.executable,
                        "args": [
                            "-m",
                            "superclaw.plugin_mcp_proxy",
                            "serve",
                            "--plugin-id",
                            "dev.superclaw.hello-world",
                        ],
                    }
                }
            }
        ),
        encoding="utf-8",
    )
    limits = WorkerLimits(
        repo_path=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        budget_seconds=10,
        permission_policy=PermissionPolicy(mode="plan", mcp_configs=[str(mcp_config)]),
    )
    goal = GoalSpec(title="Ship", description="Use OpenClaw plugin proxy")
    session = RunSession(goal_id=goal.goal_id, run_id="run_openclaw_mcp")
    openclaw = OpenClawCliBackend(executable=str(_fake_executable(tmp_path, "openclaw")))

    result = openclaw.run(_task(WorkerRole.PLAN), goal, session, limits)

    assert result.exit_code == 1
    assert "PLUGIN_RUNTIME_CONFIG_INVALID" in result.output
    assert "does not yet support SuperClaw MCP proxy config projection" in result.output
    assert "fake-agent" not in result.output
    assert str(mcp_config) not in result.output
    assert "superclaw.plugin_mcp_proxy" not in result.output
    assert "--plugin-id" not in result.output
    assert str(tmp_path / "protected-plugin-dir") not in result.output


def test_openclaw_backend_rejects_plugin_dirs_instead_of_direct_loading(tmp_path):
    limits = WorkerLimits(
        repo_path=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        budget_seconds=10,
        permission_policy=PermissionPolicy(mode="plan", plugin_dirs=[str(tmp_path / "protected-plugin-dir")]),
    )
    goal = GoalSpec(title="Ship", description="Reject OpenClaw direct plugin dir")
    session = RunSession(goal_id=goal.goal_id, run_id="run_openclaw_plugin_dir")
    openclaw = OpenClawCliBackend(executable=str(_fake_executable(tmp_path, "openclaw")))

    result = openclaw.run(_task(WorkerRole.PLAN), goal, session, limits)

    assert result.exit_code == 1
    assert "PLUGIN_RUNTIME_CONFIG_INVALID" in result.output
    assert "fake-agent" not in result.output
    assert "protected-plugin-dir" not in result.output


def test_openclaw_backend_rejects_mcp_config_env_without_leaking_secret(tmp_path):
    leaked_secret = "cph_" + "secret1234567890123"
    mcp_config = tmp_path / "superclaw-plugin-mcp.json"
    mcp_config.write_text(
        json.dumps(
            {
                "mcpServers": {
                    "superclaw-secret-server": {
                        "command": sys.executable,
                        "args": ["-m", "superclaw.plugin_mcp_proxy", "serve", "--plugin-id", "dev.secret"],
                        "env": {"GITHUB_TOKEN": leaked_secret},
                    }
                }
            }
        ),
        encoding="utf-8",
    )
    limits = WorkerLimits(
        repo_path=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        budget_seconds=10,
        permission_policy=PermissionPolicy(mode="plan", mcp_configs=[str(mcp_config)]),
    )
    goal = GoalSpec(title="Ship", description="Reject OpenClaw secret env config")
    session = RunSession(goal_id=goal.goal_id, run_id="run_openclaw_mcp_env")
    openclaw = OpenClawCliBackend(executable=str(_fake_executable(tmp_path, "openclaw")))

    result = openclaw.run(_task(WorkerRole.PLAN), goal, session, limits)

    assert result.exit_code == 1
    assert "PLUGIN_RUNTIME_CONFIG_INVALID" in result.output
    assert "env is not supported" in result.output
    assert leaked_secret not in result.output
    transcript = json.loads(Path(result.transcript_path or "").read_text(encoding="utf-8"))
    assert leaked_secret not in json.dumps(transcript)


def test_openclaw_backend_is_registered_in_default_registry():
    backends = default_backends()

    assert isinstance(backends["openclaw"], OpenClawCliBackend)


def test_codex_backend_exec_mode_uses_modern_cli_flags(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_CODEX_MODE", "exec")
    limits = WorkerLimits(repo_path=tmp_path, artifact_dir=tmp_path / "artifacts", budget_seconds=10)
    goal = GoalSpec(title="Ship", description="Use an agent")
    session = RunSession(goal_id=goal.goal_id, run_id="run_agent_exec")
    codex = CodexCliBackend(executable=str(_fake_executable(tmp_path, "codex")))

    result = codex.run(_task(WorkerRole.PLAN), goal, session, limits)

    assert result.exit_code == 0
    assert "fake-agent exec" in result.output
    assert "--skip-git-repo-check" in result.output
    assert "--sandbox workspace-write" in result.output
    assert "--cd" in result.output


def test_codex_backend_projects_superclaw_mcp_config_into_exec_overrides(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_CODEX_MODE", "exec")
    mcp_config = tmp_path / "superclaw-plugin-mcp.json"
    mcp_config.write_text(
        json.dumps(
            {
                "mcpServers": {
                    "superclaw-dev-superclaw-hello-world": {
                        "command": sys.executable,
                        "args": [
                            "-m",
                            "superclaw.plugin_mcp_proxy",
                            "serve",
                            "--plugin-id",
                            "dev.superclaw.hello-world",
                        ],
                    }
                }
            }
        ),
        encoding="utf-8",
    )
    limits = WorkerLimits(
        repo_path=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        budget_seconds=10,
        permission_policy=PermissionPolicy(mode="plan", mcp_configs=[str(mcp_config)]),
    )
    goal = GoalSpec(title="Ship", description="Use Codex plugin proxy")
    session = RunSession(goal_id=goal.goal_id, run_id="run_codex_mcp")
    codex = CodexCliBackend(executable=str(_fake_executable(tmp_path, "codex")))

    result = codex.run(_task(WorkerRole.PLAN), goal, session, limits)

    assert result.exit_code == 0
    assert "fake-agent exec -c" in result.output
    assert "mcp_servers.superclaw_dev_superclaw_hello_world.command" in result.output
    assert "mcp_servers.superclaw_dev_superclaw_hello_world.args" in result.output
    assert "superclaw.plugin_mcp_proxy" in result.output
    assert "--plugin-id" in result.output
    assert str(tmp_path / "protected-plugin-dir") not in result.output


def test_codex_backend_rejects_plugin_dirs_instead_of_direct_loading(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_CODEX_MODE", "exec")
    limits = WorkerLimits(
        repo_path=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        budget_seconds=10,
        permission_policy=PermissionPolicy(mode="plan", plugin_dirs=[str(tmp_path / "protected-plugin-dir")]),
    )
    goal = GoalSpec(title="Ship", description="Reject direct plugin dir")
    session = RunSession(goal_id=goal.goal_id, run_id="run_codex_plugin_dir")
    codex = CodexCliBackend(executable=str(_fake_executable(tmp_path, "codex")))

    result = codex.run(_task(WorkerRole.PLAN), goal, session, limits)

    assert result.exit_code == 1
    assert "PLUGIN_RUNTIME_CONFIG_INVALID" in result.output
    assert "fake-agent" not in result.output
    assert "protected-plugin-dir" not in result.output


def test_codex_backend_rejects_mcp_config_env_without_leaking_secret(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_CODEX_MODE", "exec")
    leaked_secret = "cph_" + "secret1234567890123"
    mcp_config = tmp_path / "superclaw-plugin-mcp.json"
    mcp_config.write_text(
        json.dumps(
            {
                "mcpServers": {
                    "superclaw-secret-server": {
                        "command": sys.executable,
                        "args": ["-m", "superclaw.plugin_mcp_proxy", "serve", "--plugin-id", "dev.secret"],
                        "env": {"GITHUB_TOKEN": leaked_secret},
                    }
                }
            }
        ),
        encoding="utf-8",
    )
    limits = WorkerLimits(
        repo_path=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        budget_seconds=10,
        permission_policy=PermissionPolicy(mode="plan", mcp_configs=[str(mcp_config)]),
    )
    goal = GoalSpec(title="Ship", description="Reject secret env config")
    session = RunSession(goal_id=goal.goal_id, run_id="run_codex_mcp_env")
    codex = CodexCliBackend(executable=str(_fake_executable(tmp_path, "codex")))

    result = codex.run(_task(WorkerRole.PLAN), goal, session, limits)

    assert result.exit_code == 1
    assert "PLUGIN_RUNTIME_CONFIG_INVALID" in result.output
    assert "env is not supported" in result.output
    assert leaked_secret not in result.output
    transcript = json.loads(Path(result.transcript_path or "").read_text(encoding="utf-8"))
    assert leaked_secret not in json.dumps(transcript)


def test_claude_backend_passes_secret_free_superclaw_mcp_config(tmp_path):
    mcp_config = tmp_path / "superclaw-plugin-mcp.json"
    mcp_config.write_text(
        json.dumps(
            {
                "mcpServers": {
                    "superclaw-dev-superclaw-hello-world": {
                        "command": sys.executable,
                        "args": [
                            "-m",
                            "superclaw.plugin_mcp_proxy",
                            "serve",
                            "--plugin-id",
                            "dev.superclaw.hello-world",
                        ],
                    }
                }
            }
        ),
        encoding="utf-8",
    )
    limits = WorkerLimits(
        repo_path=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        budget_seconds=10,
        permission_policy=PermissionPolicy(mode="plan", mcp_configs=[str(mcp_config)]),
    )
    goal = GoalSpec(title="Ship", description="Use Claude plugin proxy")
    session = RunSession(goal_id=goal.goal_id, run_id="run_claude_mcp")
    claude = ClaudeCliBackend(executable=str(_fake_executable(tmp_path, "claude")))

    result = claude.run(_task(WorkerRole.PLAN), goal, session, limits)

    assert result.exit_code == 0
    assert "fake-agent --print" in result.output
    assert "--mcp-config" in result.output
    assert str(mcp_config) in result.output
    assert "superclaw.plugin_mcp_proxy" not in result.output
    assert str(tmp_path / "protected-plugin-dir") not in result.output


def test_claude_backend_rejects_plugin_dirs_instead_of_direct_loading(tmp_path):
    limits = WorkerLimits(
        repo_path=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        budget_seconds=10,
        permission_policy=PermissionPolicy(mode="plan", plugin_dirs=[str(tmp_path / "protected-plugin-dir")]),
    )
    goal = GoalSpec(title="Ship", description="Reject Claude direct plugin dir")
    session = RunSession(goal_id=goal.goal_id, run_id="run_claude_plugin_dir")
    claude = ClaudeCliBackend(executable=str(_fake_executable(tmp_path, "claude")))

    result = claude.run(_task(WorkerRole.PLAN), goal, session, limits)

    assert result.exit_code == 1
    assert "PLUGIN_RUNTIME_CONFIG_INVALID" in result.output
    assert "fake-agent" not in result.output
    assert "protected-plugin-dir" not in result.output


def test_claude_backend_rejects_mcp_config_env_without_leaking_secret(tmp_path):
    leaked_secret = "cph_" + "secret1234567890123"
    mcp_config = tmp_path / "superclaw-plugin-mcp.json"
    mcp_config.write_text(
        json.dumps(
            {
                "mcpServers": {
                    "superclaw-secret-server": {
                        "command": sys.executable,
                        "args": ["-m", "superclaw.plugin_mcp_proxy", "serve", "--plugin-id", "dev.secret"],
                        "env": {"GITHUB_TOKEN": leaked_secret},
                    }
                }
            }
        ),
        encoding="utf-8",
    )
    limits = WorkerLimits(
        repo_path=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        budget_seconds=10,
        permission_policy=PermissionPolicy(mode="plan", mcp_configs=[str(mcp_config)]),
    )
    goal = GoalSpec(title="Ship", description="Reject Claude secret env config")
    session = RunSession(goal_id=goal.goal_id, run_id="run_claude_mcp_env")
    claude = ClaudeCliBackend(executable=str(_fake_executable(tmp_path, "claude")))

    result = claude.run(_task(WorkerRole.PLAN), goal, session, limits)

    assert result.exit_code == 1
    assert "PLUGIN_RUNTIME_CONFIG_INVALID" in result.output
    assert "env is not supported" in result.output
    assert leaked_secret not in result.output
    transcript = json.loads(Path(result.transcript_path or "").read_text(encoding="utf-8"))
    assert leaked_secret not in json.dumps(transcript)


def test_agent_backend_fail_closed_on_auth_prompt_even_with_zero_exit(tmp_path):
    limits = WorkerLimits(repo_path=tmp_path, artifact_dir=tmp_path / "artifacts", budget_seconds=10)
    goal = GoalSpec(title="Ship", description="Use an agent")
    session = RunSession(goal_id=goal.goal_id, run_id="run_auth_prompt")
    codex = CodexCliBackend(executable=str(_fake_auth_prompt_executable(tmp_path, "codex")))

    result = codex.run(_task(WorkerRole.PLAN), goal, session, limits)

    assert result.exit_code == 126
    assert "classified backend output as failure" in result.output


def test_codex_prompt_uses_flattened_envelope_projection_metadata(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_EVAL_CODEX_MODE", "exec")
    captured: dict = {}

    class _RecordingCodex(CodexCliBackend):
        def run_command(self, command, *, task, goal, session, limits, **kwargs):
            captured["prompt"] = command[-1]
            captured["transcript_extra"] = kwargs.get("transcript_extra")
            return WorkerResult(task.task_id, task.role.value, self.name, "codex", 0, "ok", 0.0)

    executable = _fake_executable(tmp_path, "codex")
    backend = _RecordingCodex(executable=str(executable))
    limits = WorkerLimits(
        repo_path=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        budget_seconds=10,
        plugin_capabilities_note="Plugin note: superclaw__list_tools available.",
        prompt_envelope=build_agent_prompt_envelope(
            {"agent_name": "Roadmap Bot", "agent_role": "implementer"},
            user_turn="Ship the hot path",
        ),
    )
    goal = GoalSpec(title="Ship", description="Ship the hot path")
    session = RunSession(goal_id=goal.goal_id, run_id="run_codex_projection")

    result = backend.run(_task(WorkerRole.IMPLEMENT), goal, session, limits)

    assert result.exit_code == 0
    prompt = captured["prompt"]
    assert "# SuperClaw Prompt Projection" in prompt
    assert "system_channel=flatten_only" in prompt
    assert "projection_loss=system_flattened:governance_core" in prompt
    assert "# SuperClaw Prompt Envelope (flattened)" in prompt
    assert "--- BEGIN UNTRUSTED USER TURN ---" in prompt
    assert "Roadmap Bot" in prompt
    assert captured["transcript_extra"]["local_agent_runtime"]["backend"] == "codex"
    projection = captured["transcript_extra"]["prompt_projection"]
    assert projection["system_channel"] == "flatten_only"
    assert projection["stable_fingerprint"]
    assert projection["provider_cache_control"]["supported"] is False
    assert projection["provider_cache_control"]["unsupported_reason"] == "runtime_does_not_support_cache_control"
    assert projection["projection_loss"][0]["kind"] == "system_flattened"
    assert "Roadmap Bot" not in json.dumps(projection)
    assert "Ship the hot path" not in json.dumps(projection)


def test_flatten_backend_fails_closed_for_required_native_system(tmp_path):
    backend = CodexCliBackend(executable=str(_fake_executable(tmp_path, "codex")))
    limits = WorkerLimits(
        repo_path=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        budget_seconds=10,
        prompt_envelope=build_agent_prompt_envelope(
            {"agent_name": "Native Only", "agent_role": "reviewer"},
            user_turn="Do not flatten me",
            requires_native_system=True,
        ),
    )

    with pytest.raises(PromptProjectionUnsupportedError) as exc:
        backend._prompt(
            _task(WorkerRole.REVIEW),
            GoalSpec(title="Review", description="Do not flatten me"),
            repo_path=tmp_path,
            limits=limits,
            session=RunSession(goal_id="g", run_id="r"),
        )

    assert exc.value.code == PROMPT_PROJECTION_UNSUPPORTED


def test_claude_backend_uses_native_cli_append_projection_metadata(tmp_path):
    captured: dict = {}

    class _RecordingClaude(ClaudeCliBackend):
        def run_command(self, command, *, task, goal, session, limits, **kwargs):
            captured["command"] = command
            captured["transcript_extra"] = kwargs.get("transcript_extra")
            return WorkerResult(task.task_id, task.role.value, self.name, "claude", 0, "ok", 0.0)

    backend = _RecordingClaude(executable=str(_fake_executable(tmp_path, "claude")))
    limits = WorkerLimits(
        repo_path=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        budget_seconds=10,
        prompt_envelope=build_agent_prompt_envelope(
            {"agent_name": "Native Claude", "agent_role": "reviewer"},
            user_turn="Review without leaking system text",
        ),
    )
    goal = GoalSpec(title="Review", description="Review without leaking system text")
    session = RunSession(goal_id=goal.goal_id, run_id="run_claude_projection")

    result = backend.run(_task(WorkerRole.REVIEW), goal, session, limits)

    assert result.exit_code == 0
    command = captured["command"]
    append_index = command.index("--append-system-prompt")
    append_system = command[append_index + 1]
    user_prompt = command[-1]
    assert "Native Claude" in append_system
    assert "Native Claude" not in user_prompt
    assert "--- BEGIN UNTRUSTED USER TURN ---" in user_prompt
    projection = captured["transcript_extra"]["prompt_projection"]
    assert projection["system_channel"] == "native_cli_append"
    assert projection["projection_kind"] == "native_cli_append"
    assert projection["stable_fingerprint"]
    assert projection["provider_cache_control"]["supported"] is False
    assert "Native Claude" not in json.dumps(projection)


@pytest.mark.parametrize(
    ("backend", "binary"),
    [
        (HermesCliBackend, "hermes"),
        (OpenClawCliBackend, "openclaw"),
    ],
)
def test_custom_cli_prompt_overrides_fail_closed_for_required_native_system(
    tmp_path,
    backend,
    binary,
):
    limits = WorkerLimits(
        repo_path=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        budget_seconds=10,
        prompt_envelope=build_agent_prompt_envelope(
            {"agent_name": "Native Only", "agent_role": "reviewer"},
            user_turn="Do not flatten me",
            requires_native_system=True,
        ),
    )

    with pytest.raises(PromptProjectionUnsupportedError) as exc:
        backend(executable=str(_fake_executable(tmp_path, binary))).run(
            _task(WorkerRole.REVIEW),
            GoalSpec(title="Review", description="Do not flatten me"),
            RunSession(goal_id="g", run_id=f"r_{binary}"),
            limits,
        )

    assert exc.value.code == PROMPT_PROJECTION_UNSUPPORTED


def test_anthropic_backend_availability_gates_on_key_or_injection(tmp_path, monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    assert AnthropicApiBackend().available().available is False  # no key, no injection
    injected = AnthropicApiBackend(message_fn=lambda model, prompt: "ok")
    avail = injected.available()
    assert avail.available is True
    assert "claude-opus-4-8" in (avail.version or "")  # defaults to Opus 4.8


def test_anthropic_backend_runs_via_injected_model_and_records_evidence(tmp_path):
    captured = {}

    def fake_message(model, prompt):
        captured["model"] = model
        captured["prompt"] = prompt
        return (
            "I implemented the change.\n"
            "superclaw_worker_result backend=anthropic role=implement goal=goal_x status=completed"
        )

    backend = AnthropicApiBackend(message_fn=fake_message)
    limits = WorkerLimits(repo_path=tmp_path, artifact_dir=tmp_path / "artifacts", budget_seconds=10)
    goal = GoalSpec(title="Ship", description="Use Opus 4.8")
    session = RunSession(goal_id="goal_x", run_id="run_anthropic")

    result = backend.run(_task(WorkerRole.IMPLEMENT), goal, session, limits)

    assert captured["model"] == "claude-opus-4-8"  # Opus 4.8 invoked
    assert "Goal: Use Opus 4.8" in captured["prompt"]  # real solving prompt, not a smoke line
    assert result.backend == "anthropic"
    assert result.exit_code == 0
    assert "superclaw_worker_result backend=anthropic" in result.output
    assert result.artifact_path and Path(result.artifact_path).exists()  # artifact persisted


def test_anthropic_backend_failure_surfaces_as_failed_worker(tmp_path):
    def boom(model, prompt):
        raise RuntimeError("rate limit exceeded")

    backend = AnthropicApiBackend(message_fn=boom)
    limits = WorkerLimits(repo_path=tmp_path, artifact_dir=tmp_path / "artifacts", budget_seconds=10)
    result = backend.run(_task(WorkerRole.IMPLEMENT), GoalSpec(title="x", description="y"), RunSession(goal_id="g", run_id="r"), limits)

    assert result.exit_code == 1
    assert "anthropic call failed" in result.output
    assert "rate limit exceeded" in result.output


def _gemini_tool_response(name: str, args: dict, call_id: str = "call_1") -> dict:
    """Build an OpenAI/Gemini-shaped chat completion that requests one tool call."""
    return {
        "choices": [
            {
                "finish_reason": "tool_calls",
                "message": {
                    "content": None,
                    "tool_calls": [
                        {
                            "id": call_id,
                            "type": "function",
                            "function": {"name": name, "arguments": json.dumps(args)},
                        }
                    ],
                },
            }
        ]
    }


def test_gemini_backend_availability_gates_on_key_or_injection(monkeypatch):
    monkeypatch.delenv("SUPERCLAW_GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    assert GeminiAgentBackend().available().available is False  # no key, no injection

    injected = GeminiAgentBackend(completion_fn=lambda messages, tools: {})
    avail = injected.available()
    assert avail.available is True
    assert "gemini-2.5-flash" in (avail.version or "")  # default model surfaced

    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    assert GeminiAgentBackend().available().available is True


def test_gemini_backend_is_registered_in_default_registry():
    assert isinstance(default_backends()["gemini"], GeminiAgentBackend)


def test_gemini_delegate_tool_injected_only_when_enabled_at_top_level(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_SHELL_CONFIG_PATH", str(tmp_path / "shell.json"))
    captured: dict = {}

    def fake_complete(messages, tools):
        captured["off"] = [t["function"]["name"] for t in tools]
        return {"choices": [{"finish_reason": "stop", "message": {"content": "plan only"}}]}

    backend = GeminiAgentBackend(completion_fn=fake_complete)
    limits = WorkerLimits(repo_path=tmp_path, artifact_dir=tmp_path / "artifacts", budget_seconds=10)
    backend.run(_task(WorkerRole.IMPLEMENT), GoalSpec(title="x", description="y"), RunSession(goal_id="g"), limits)
    assert "delegate" not in captured["off"]

    set_runtime_config("delegation", "true")

    def enabled_complete(messages, tools):
        captured["on"] = [t["function"]["name"] for t in tools]
        return {"choices": [{"finish_reason": "stop", "message": {"content": "plan only"}}]}

    GeminiAgentBackend(completion_fn=enabled_complete).run(
        _task(WorkerRole.IMPLEMENT),
        GoalSpec(title="x", description="y"),
        RunSession(goal_id="g2", execution_context={"principal": "alice"}),
        limits,
    )
    assert "delegate" in captured["on"]

    def child_complete(messages, tools):
        captured["child"] = [t["function"]["name"] for t in tools]
        return {"choices": [{"finish_reason": "stop", "message": {"content": "plan only"}}]}

    GeminiAgentBackend(completion_fn=child_complete).run(
        _task(WorkerRole.IMPLEMENT),
        GoalSpec(title="x", description="y"),
        RunSession(goal_id="g3", execution_context={"principal": "alice", "delegation_depth": 1}),
        limits,
    )
    assert "delegate" not in captured["child"]


def test_anthropic_agent_delegate_tool_uses_real_tool_loop_name(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_SHELL_CONFIG_PATH", str(tmp_path / "shell.json"))
    set_runtime_config("delegation", "true")
    captured: dict = {}

    def fake_complete(system, messages, tools):
        captured["tool_names"] = [t["name"] for t in tools]
        return {"stop_reason": "end_turn", "content": [{"type": "text", "text": "plan only"}]}

    AnthropicAgentBackend(completion_fn=fake_complete).run(
        _task(WorkerRole.IMPLEMENT),
        GoalSpec(title="x", description="y"),
        RunSession(goal_id="g", execution_context={"principal": "alice"}),
        WorkerLimits(repo_path=tmp_path, artifact_dir=tmp_path / "artifacts", budget_seconds=10),
    )
    assert "delegate" in captured["tool_names"]


def test_delegate_tool_raises_structured_request_without_spawning(tmp_path):
    limits = WorkerLimits(repo_path=tmp_path, artifact_dir=tmp_path / "artifacts", budget_seconds=10)
    backend = GeminiAgentBackend(completion_fn=lambda messages, tools: {})

    assert backend._exec_tool("delegate", {"runtime": "gemini"}, limits, 999999.0) == "error: invalid delegate request"
    with pytest.raises(DelegationRequested) as exc:
        backend._exec_tool(
            "delegate",
            {"subtask": "summarize the failing tests", "runtime": "gemini", "budget_seconds": 30},
            limits,
            999999.0,
            parent_tool_call_id="call_delegate_1",
        )
    assert exc.value.request.subtask == "summarize the failing tests"
    assert exc.value.request.runtime == "gemini"
    assert exc.value.request.budget_seconds == 30
    assert exc.value.parent_tool_call_id == "call_delegate_1"


def test_gemini_backend_missing_key_returns_127(tmp_path, monkeypatch):
    monkeypatch.delenv("SUPERCLAW_GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    limits = WorkerLimits(repo_path=tmp_path, artifact_dir=tmp_path / "artifacts", budget_seconds=10)
    goal = GoalSpec(title="Ship", description="Use Gemini")
    session = RunSession(goal_id=goal.goal_id, run_id="run_gemini_missing")

    result = GeminiAgentBackend().run(_task(WorkerRole.IMPLEMENT), goal, session, limits)

    assert result.exit_code == 127
    assert result.backend == "gemini"
    assert "GEMINI_API_KEY" in result.output


def test_gemini_backend_drives_real_tool_loop_until_finish(tmp_path):
    """The agent loop must EXECUTE the model's tool calls for real (write a file,
    run a shell command) and only report completion once `finish` is called."""
    captured: dict = {}
    state = {"n": 0}

    def fake_complete(messages, tools):
        state["n"] += 1
        captured["tool_names"] = [t["function"]["name"] for t in tools]
        captured["last_messages"] = messages
        if state["n"] == 1:
            return _gemini_tool_response("write_file", {"path": "out.txt", "content": "hello-gemini"}, "c1")
        if state["n"] == 2:
            return _gemini_tool_response("run_shell", {"command": "cat out.txt"}, "c2")
        return _gemini_tool_response("finish", {"summary": "wrote and verified out.txt", "success": True}, "c3")

    backend = GeminiAgentBackend(completion_fn=fake_complete)
    # bypassPermissions = full posture: the agent-loop tests exercise REAL shell
    # execution + output capture, so they must run shell freely (the B-class
    # escalation gate is exercised separately in tests/test_permission_posture.py).
    limits = WorkerLimits(
        repo_path=tmp_path, artifact_dir=tmp_path / "artifacts", budget_seconds=30,
        permission_policy=PermissionPolicy(mode="bypassPermissions"),
    )
    goal = GoalSpec(title="Create out.txt", description="Write hello-gemini and verify")
    session = RunSession(goal_id=goal.goal_id, run_id="run_gemini_loop")

    result = backend.run(_task(WorkerRole.IMPLEMENT), goal, session, limits)

    # the write_file tool actually wrote a real file in the sandbox repo
    assert (tmp_path / "out.txt").read_text(encoding="utf-8") == "hello-gemini"
    assert state["n"] == 3  # loop continued through both tool calls then finish
    assert {"run_shell", "write_file", "read_file", "list_files", "finish"} == set(captured["tool_names"])
    assert "Goal: Write hello-gemini and verify" in captured["last_messages"][1]["content"]  # real solving prompt
    assert result.backend == "gemini"
    assert result.exit_code == 0
    assert "superclaw_worker_result backend=gemini" in result.output
    assert "status=completed" in result.output
    assert "hello-gemini" in result.output  # shell output (cat) captured in transcript
    assert result.artifact_path and Path(result.artifact_path).exists()
    transcript = json.loads(Path(result.transcript_path or "").read_text(encoding="utf-8"))
    event_types = [event["type"] for event in transcript["stream_events"]]
    assert "model_response" in event_types
    assert "tool_call" in event_types
    assert "tool_result" in event_types
    assert "finish" in event_types
    assert event_types[-1] == "terminal"
    assert any(event.get("tool_name") == "run_shell" for event in transcript["stream_events"])


def test_gemini_agent_uses_native_structured_prompt_projection(tmp_path):
    captured: dict = {}

    def fake_complete(messages, tools):
        captured["messages"] = messages
        captured["tools"] = tools
        return _gemini_tool_response("finish", {"summary": "projected", "success": True}, "c1")

    backend = GeminiAgentBackend(completion_fn=fake_complete)
    limits = WorkerLimits(
        repo_path=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        budget_seconds=10,
        permission_policy=PermissionPolicy(mode="bypassPermissions"),
        prompt_envelope=build_agent_prompt_envelope(
            {
                "agent_name": "Native Gemini",
                "agent_role": "implementer",
                "agent_charter": "Keep charter stable.",
            },
            user_turn="Write through native projection",
        ),
    )
    goal = GoalSpec(title="Native", description="Write through native projection")
    session = RunSession(goal_id=goal.goal_id, run_id="run_gemini_native_projection")

    result = backend.run(_task(WorkerRole.IMPLEMENT), goal, session, limits)

    assert result.exit_code == 0
    assert captured["messages"][0]["role"] == "system"
    assert "Native Gemini" in captured["messages"][0]["content"]
    assert "Keep charter stable." in captured["messages"][0]["content"]
    assert captured["messages"][1]["role"] == "user"
    assert "Native Gemini" not in captured["messages"][1]["content"]
    assert "--- BEGIN UNTRUSTED USER TURN ---" in captured["messages"][1]["content"]
    assert [tool["function"]["name"] for tool in captured["tools"]]
    transcript = json.loads(Path(result.transcript_path or "").read_text(encoding="utf-8"))
    projection = transcript["extra"]["prompt_projection"]
    assert projection["system_channel"] == "native_structured"
    assert projection["metadata"]["supports_tool_schema"] is True
    assert projection["provider_cache_control"] == {
        "supported": False,
        "section_count": 4,
        "eligible_section_count": 0,
        "applied_section_kinds": [],
        "unsupported_reason": "runtime_does_not_support_cache_control",
    }
    assert projection["projection_loss"] == []


def test_gemini_backend_text_only_without_action_is_not_delivered(tmp_path):
    """A model that only talks (no tool calls, no real work) must NOT be scored as
    a successful delivery — guards against the 'brain, not hands' regression."""

    def planning_only(messages, tools):
        return {"choices": [{"finish_reason": "stop", "message": {"content": "Here is my plan: do X then Y."}}]}

    backend = GeminiAgentBackend(completion_fn=planning_only)
    limits = WorkerLimits(repo_path=tmp_path, artifact_dir=tmp_path / "artifacts", budget_seconds=10)
    result = backend.run(
        _task(WorkerRole.IMPLEMENT),
        GoalSpec(title="x", description="y"),
        RunSession(goal_id="g", run_id="r_plan"),
        limits,
    )

    assert result.exit_code == 1  # planned, not delivered
    assert "superclaw_worker_result backend=gemini" not in result.output


def test_gemini_backend_rejects_path_escaping_sandbox(tmp_path):
    """write_file/read_file paths must stay inside the repo checkout."""

    def escape_then_finish(messages, tools):
        if not getattr(escape_then_finish, "done", False):
            escape_then_finish.done = True
            return _gemini_tool_response("write_file", {"path": "../escaped.txt", "content": "nope"}, "c1")
        return _gemini_tool_response("finish", {"summary": "attempted", "success": False}, "c2")

    backend = GeminiAgentBackend(completion_fn=escape_then_finish)
    limits = WorkerLimits(repo_path=tmp_path, artifact_dir=tmp_path / "artifacts", budget_seconds=10)
    result = backend.run(
        _task(WorkerRole.IMPLEMENT),
        GoalSpec(title="x", description="y"),
        RunSession(goal_id="g", run_id="r_escape"),
        limits,
    )

    assert not (tmp_path.parent / "escaped.txt").exists()  # never written outside the sandbox
    assert "escapes repository sandbox" in result.output


def test_gemini_backend_creates_missing_workspace(tmp_path):
    """The deployed engine may point at a fresh per-run workspace dir that does not
    exist yet; the backend must create it so shell/file tools work."""
    workspace = tmp_path / "fresh" / "run_ws"  # does not exist

    def write_then_finish(messages, tools):
        if not getattr(write_then_finish, "done", False):
            write_then_finish.done = True
            return _gemini_tool_response("write_file", {"path": "made.txt", "content": "ok"}, "c1")
        return _gemini_tool_response("finish", {"summary": "created file in fresh workspace", "success": True}, "c2")

    backend = GeminiAgentBackend(completion_fn=write_then_finish)
    limits = WorkerLimits(repo_path=workspace, artifact_dir=workspace / "artifacts", budget_seconds=10)
    result = backend.run(
        _task(WorkerRole.IMPLEMENT),
        GoalSpec(title="x", description="y"),
        RunSession(goal_id="g", run_id="r_fresh"),
        limits,
    )

    assert workspace.is_dir()  # workspace auto-created
    assert (workspace / "made.txt").read_text(encoding="utf-8") == "ok"
    assert result.exit_code == 0


def _anthropic_tool_response(name: str, tool_input: dict, call_id: str = "tu_1") -> dict:
    """Anthropic Messages-API shaped response requesting one tool_use."""
    return {
        "stop_reason": "tool_use",
        "content": [{"type": "tool_use", "id": call_id, "name": name, "input": tool_input}],
    }


def test_anthropic_agent_availability_gates_on_key_or_injection(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    assert AnthropicAgentBackend().available().available is False  # no key, no injection

    injected = AnthropicAgentBackend(completion_fn=lambda system, messages, tools: {})
    avail = injected.available()
    assert avail.available is True
    assert "claude-opus-4-8" in (avail.version or "")  # defaults to Opus 4.8

    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    assert AnthropicAgentBackend().available().available is True


def test_anthropic_agent_is_registered_in_default_registry():
    assert isinstance(default_backends()["anthropic-agent"], AnthropicAgentBackend)


def test_anthropic_agent_missing_key_returns_127(tmp_path, monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    limits = WorkerLimits(repo_path=tmp_path, artifact_dir=tmp_path / "artifacts", budget_seconds=10)
    goal = GoalSpec(title="Ship", description="Use Opus")
    session = RunSession(goal_id=goal.goal_id, run_id="run_anthropic_agent_missing")

    result = AnthropicAgentBackend().run(_task(WorkerRole.IMPLEMENT), goal, session, limits)

    assert result.exit_code == 127
    assert result.backend == "anthropic-agent"
    assert "ANTHROPIC_API_KEY" in result.output


def test_anthropic_agent_drives_real_tool_loop_until_end_turn(tmp_path):
    """The Messages-API agent loop must EXECUTE tool_use blocks for real and only
    report completion when the model stops requesting tools (end_turn)."""
    captured: dict = {}
    state = {"n": 0}

    def fake_complete(system, messages, tools):
        state["n"] += 1
        captured["system"] = system
        captured["tool_names"] = [t["name"] for t in tools]
        captured["last_user"] = messages[0]["content"]
        if state["n"] == 1:
            return _anthropic_tool_response("write_file", {"path": "out.txt", "content": "hello-opus"}, "tu1")
        if state["n"] == 2:
            return _anthropic_tool_response("run_shell", {"command": "cat out.txt"}, "tu2")
        return {"stop_reason": "end_turn", "content": [{"type": "text", "text": "Created and verified out.txt."}]}

    backend = AnthropicAgentBackend(completion_fn=fake_complete)
    # bypassPermissions = full posture: the agent-loop tests exercise REAL shell
    # execution + output capture, so they must run shell freely (the B-class
    # escalation gate is exercised separately in tests/test_permission_posture.py).
    limits = WorkerLimits(
        repo_path=tmp_path, artifact_dir=tmp_path / "artifacts", budget_seconds=30,
        permission_policy=PermissionPolicy(mode="bypassPermissions"),
    )
    goal = GoalSpec(title="Create out.txt", description="Write hello-opus and verify")
    session = RunSession(goal_id=goal.goal_id, run_id="run_anthropic_agent_loop")

    result = backend.run(_task(WorkerRole.IMPLEMENT), goal, session, limits)

    assert (tmp_path / "out.txt").read_text(encoding="utf-8") == "hello-opus"  # real file written
    assert state["n"] == 3  # two tool turns then end_turn
    assert {"run_shell", "write_file", "read_file", "list_files"} == set(captured["tool_names"])
    assert "Goal: Write hello-opus and verify" in captured["last_user"]  # real solving prompt
    system_text = json.dumps(captured["system"])
    assert "sandboxed repository" in system_text  # system carries the contract
    assert isinstance(captured["system"], list)
    assert any(block.get("cache_control") == {"type": "ephemeral"} for block in captured["system"])
    assert result.backend == "anthropic-agent"
    assert result.exit_code == 0
    assert "superclaw_worker_result backend=anthropic-agent" in result.output
    assert "hello-opus" in result.output  # shell (cat) output captured
    assert result.artifact_path and Path(result.artifact_path).exists()
    transcript = json.loads(Path(result.transcript_path or "").read_text(encoding="utf-8"))
    projection = transcript["extra"]["prompt_projection"]
    assert projection["system_channel"] == "native_structured"
    assert projection["provider_cache_control"]["supported"] is True
    assert projection["provider_cache_control"]["eligible_section_count"] > 0
    event_types = [event["type"] for event in transcript["stream_events"]]
    assert "model_response" in event_types
    assert "tool_call" in event_types
    assert "tool_result" in event_types
    assert event_types[-1] == "terminal"
    assert any(event.get("tool_name") == "run_shell" for event in transcript["stream_events"])


def test_anthropic_agent_text_only_without_action_is_not_delivered(tmp_path):
    """Pure-talk turn (no tool_use) must NOT be scored as delivered."""

    def planning_only(system, messages, tools):
        return {"stop_reason": "end_turn", "content": [{"type": "text", "text": "Here is my plan: do X then Y."}]}

    backend = AnthropicAgentBackend(completion_fn=planning_only)
    limits = WorkerLimits(repo_path=tmp_path, artifact_dir=tmp_path / "artifacts", budget_seconds=10)
    result = backend.run(
        _task(WorkerRole.IMPLEMENT),
        GoalSpec(title="x", description="y"),
        RunSession(goal_id="g", run_id="r_plan_anthropic"),
        limits,
    )

    assert result.exit_code == 1  # planned, not delivered
    assert "superclaw_worker_result backend=anthropic-agent" not in result.output


# --------------------------------------------------------------------------- #
# HttpBackend — generic bring-your-own HTTP runtime                            #
# --------------------------------------------------------------------------- #


def _http_limits(tmp_path, **kw):
    return WorkerLimits(repo_path=tmp_path, artifact_dir=tmp_path / "artifacts", budget_seconds=10, **kw)


def _http_run(backend, tmp_path, role=WorkerRole.IMPLEMENT, run_id="run_http", **limit_kw):
    goal = GoalSpec(title="Ship", description="Do the work", acceptance_criteria=["builds"])
    session = RunSession(goal_id=goal.goal_id, run_id=run_id)
    return backend.run(_task(role), goal, session, _http_limits(tmp_path, **limit_kw))


def test_http_backend_posts_and_reads_output(tmp_path):
    captured = {}

    def transport(url, method, headers, body, timeout):
        captured.update(url=url, method=method, headers=headers, body=body, timeout=timeout)
        return 200, {"output": "did the work", "exit_code": 0}

    backend = HttpBackend(url="https://runtime.test/run", transport=transport)
    result = _http_run(backend, tmp_path)

    assert result.exit_code == 0
    assert "did the work" in result.output
    assert captured["url"] == "https://runtime.test/run"
    assert captured["method"] == "POST"


def test_http_backend_forwards_task_framing_and_permission_mode(tmp_path):
    captured = {}

    def transport(url, method, headers, body, timeout):
        captured.update(body)
        return 200, {"output": "ok"}

    backend = HttpBackend(url="https://runtime.test/run", transport=transport)
    _http_run(backend, tmp_path, role=WorkerRole.REVIEW)

    assert captured["task"]["role"] == "review"
    assert captured["goal"]["title"] == "Ship"
    assert captured["goal"]["acceptance_criteria"] == ["builds"]
    assert captured["repo_path"] == str(tmp_path)
    assert captured["permission_mode"] == "ask"  # default policy
    assert "prompt" in captured and captured["prompt"]


def test_http_backend_allow_policy_sets_permission_mode_allow(tmp_path):
    captured = {}

    def transport(url, method, headers, body, timeout):
        captured.update(body)
        return 200, {"output": "ok"}

    backend = HttpBackend(url="https://runtime.test/run", transport=transport)
    _http_run(backend, tmp_path, permission_policy=PermissionPolicy(mode="bypassPermissions"))

    assert captured["permission_mode"] == "allow"


def test_http_backend_non_2xx_fails(tmp_path):
    backend = HttpBackend(url="https://runtime.test/run", transport=lambda *a: (500, {"error": "boom"}))
    result = _http_run(backend, tmp_path)

    assert result.exit_code == 1
    assert "status 500" in result.output


def test_http_backend_missing_output_fails(tmp_path):
    backend = HttpBackend(url="https://runtime.test/run", transport=lambda *a: (200, {"exit_code": 0}))
    result = _http_run(backend, tmp_path)

    assert result.exit_code == 1
    assert "missing required 'output'" in result.output


def test_http_backend_passes_through_exit_code(tmp_path):
    backend = HttpBackend(url="https://runtime.test/run", transport=lambda *a: (200, {"output": "partial", "exit_code": 3}))
    result = _http_run(backend, tmp_path)

    assert result.exit_code == 3


def test_http_backend_timeout(tmp_path):
    def transport(*a):
        raise socket.timeout("slow")

    backend = HttpBackend(url="https://runtime.test/run", transport=transport)
    result = _http_run(backend, tmp_path)

    assert result.exit_code == 124
    assert result.timed_out is True


def test_http_backend_connection_error(tmp_path):
    def transport(*a):
        raise urllib.error.URLError("refused")

    backend = HttpBackend(url="https://runtime.test/run", transport=transport)
    result = _http_run(backend, tmp_path)

    assert result.exit_code == 1
    assert "connection failed" in result.output


def test_http_backend_fail_closed_on_plugin_dirs(tmp_path):
    backend = HttpBackend(url="https://runtime.test/run", transport=lambda *a: (200, {"output": "x"}))
    result = _http_run(backend, tmp_path, permission_policy=PermissionPolicy(mode="plan", plugin_dirs=[str(tmp_path / "p")]))

    assert result.exit_code == 1
    assert "PLUGIN_RUNTIME_CONFIG_INVALID" in result.output


def test_http_backend_fail_closed_on_mcp_configs(tmp_path):
    backend = HttpBackend(url="https://runtime.test/run", transport=lambda *a: (200, {"output": "x"}))
    result = _http_run(backend, tmp_path, permission_policy=PermissionPolicy(mode="plan", mcp_configs=[str(tmp_path / "m.json")]))

    assert result.exit_code == 1
    assert "PLUGIN_RUNTIME_CONFIG_INVALID" in result.output


def test_http_backend_unconfigured_url_reports_127(tmp_path, monkeypatch):
    monkeypatch.delenv("SUPERCLAW_HTTP_URL", raising=False)
    backend = HttpBackend()
    assert backend.available().available is False
    result = _http_run(backend, tmp_path)
    assert result.exit_code == 127


def test_http_backend_does_not_leak_auth_header_in_output(tmp_path):
    secret = "cph_" + "httptoken1234567890"
    captured = {}

    def transport(url, method, headers, body, timeout):
        captured.update(headers)
        return 500, {"error": "denied"}

    backend = HttpBackend(url="https://runtime.test/run", headers={"Authorization": f"Bearer {secret}"}, transport=transport)
    result = _http_run(backend, tmp_path)

    # The auth header reaches the endpoint but never the failure output / transcript.
    assert captured["Authorization"] == f"Bearer {secret}"
    assert secret not in result.output
    transcript = Path(result.transcript_path).read_text(encoding="utf-8")
    assert secret not in transcript


def test_http_backend_real_urllib_smoke(tmp_path):
    """End-to-end through the real urllib transport against a live local server."""
    import http.server
    import threading

    received = {}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            length = int(self.headers.get("content-length", 0))
            received["body"] = json.loads(self.rfile.read(length).decode("utf-8"))
            payload = json.dumps({"output": "remote runtime completed: pong", "exit_code": 0}).encode("utf-8")
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *args):
            pass

    server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        # allow_private: loopback is legitimate for local dev/testing; production
        # endpoints are public and the SSRF guard blocks private space by default.
        backend = HttpBackend(url=f"http://127.0.0.1:{port}/run", timeout_sec=10, allow_private=True)
        result = _http_run(backend, tmp_path, run_id="run_http_smoke")
    finally:
        server.shutdown()
        thread.join(timeout=2)

    assert result.exit_code == 0
    assert "remote runtime completed: pong" in result.output
    assert received["body"]["task"]["role"] == "implement"
    assert received["body"]["repo_path"] == str(tmp_path)


def test_http_backend_blocks_private_address_by_default(tmp_path):
    """SSRF guard: a loopback/metadata endpoint is blocked unless allow_private."""
    backend = HttpBackend(url="http://127.0.0.1:9/run")  # no transport → real-network guard path
    result = _http_run(backend, tmp_path)

    assert result.exit_code == 1
    assert "blocked" in result.output
    assert "SUPERCLAW_HTTP_ALLOW_PRIVATE" in result.output


def test_http_backend_blocks_link_local_metadata_address(tmp_path):
    backend = HttpBackend(url="http://169.254.169.254/latest/meta-data/")
    result = _http_run(backend, tmp_path)

    assert result.exit_code == 1
    assert "blocked" in result.output


def test_http_backend_allow_private_bypasses_ssrf_guard(tmp_path):
    """With allow_private the guard is off; an unreachable loopback port then
    surfaces as a normal connection failure, not an SSRF block."""
    backend = HttpBackend(url="http://127.0.0.1:9/run", allow_private=True, timeout_sec=2)
    result = _http_run(backend, tmp_path)

    assert result.exit_code in (1, 124)
    assert "blocked" not in result.output


def test_http_backend_refuses_redirect(tmp_path):
    import http.server
    import threading

    class Redirector(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            self.send_response(302)
            self.send_header("location", "http://169.254.169.254/")
            self.end_headers()

        def log_message(self, *args):
            pass

    server = http.server.HTTPServer(("127.0.0.1", 0), Redirector)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        backend = HttpBackend(url=f"http://127.0.0.1:{port}/run", allow_private=True, timeout_sec=5)
        result = _http_run(backend, tmp_path, run_id="run_http_redirect")
    finally:
        server.shutdown()
        thread.join(timeout=2)

    # A redirect must not be followed (it would bypass the SSRF host check).
    assert result.exit_code == 1
    assert "169.254.169.254" not in result.output or "refused" in result.output


def test_http_backend_oom_guard_rejects_oversized_body(tmp_path, monkeypatch):
    monkeypatch.setattr(HttpBackend, "MAX_RESPONSE_BYTES", 64)

    import http.server
    import threading

    big = json.dumps({"output": "x" * 100_000}).encode("utf-8")

    class Big(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(big)))
            self.end_headers()
            self.wfile.write(big)

        def log_message(self, *args):
            pass

    server = http.server.HTTPServer(("127.0.0.1", 0), Big)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        backend = HttpBackend(url=f"http://127.0.0.1:{port}/run", allow_private=True, timeout_sec=5)
        result = _http_run(backend, tmp_path, run_id="run_http_oom")
    finally:
        server.shutdown()
        thread.join(timeout=2)

    assert result.exit_code == 1
    assert "exceeded" in result.output


def test_http_backend_non_json_2xx_body_fails(tmp_path):
    backend = HttpBackend(url="https://runtime.test/run", transport=lambda *a: (_ for _ in ()).throw(RuntimeError("non-JSON body")))
    result = _http_run(backend, tmp_path)
    assert result.exit_code == 1
    assert "invocation failed" in result.output


def test_http_backend_invalid_timeout_env_fails_closed(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_HTTP_TIMEOUT_SEC", "abc")
    backend = HttpBackend(url="https://runtime.test/run", transport=lambda *a: (200, {"output": "x"}))
    result = _http_run(backend, tmp_path)
    assert result.exit_code == 127
    assert "SUPERCLAW_HTTP_TIMEOUT_SEC" in result.output


def test_http_backend_malformed_headers_env_fails_closed(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_HTTP_URL", "https://runtime.test/run")
    monkeypatch.setenv("SUPERCLAW_HTTP_HEADERS", "{not json,}")
    backend = HttpBackend(transport=lambda *a: (200, {"output": "x"}))
    assert backend.available().available is False
    result = _http_run(backend, tmp_path)
    assert result.exit_code == 127
    assert "SUPERCLAW_HTTP_HEADERS" in result.output


def test_http_backend_reflected_token_is_redacted(tmp_path):
    """A hostile endpoint echoing the auth token back in output must not leak it."""
    token = "opaque-Basic-Zm9vOmJhcg=="  # not a cph_/Bearer pattern → exact-redact path

    def transport(url, method, headers, body, timeout):
        return 200, {"output": f"received your credential {token} thanks"}

    backend = HttpBackend(url="https://runtime.test/run", headers={"Authorization": token}, transport=transport)
    result = _http_run(backend, tmp_path)

    assert result.exit_code == 0
    assert token not in result.output
    transcript = Path(result.transcript_path).read_text(encoding="utf-8")
    assert token not in transcript


def test_http_backend_safe_url_strips_credentials(tmp_path):
    """A token in the URL userinfo/query must not land in command_repr / transcript."""
    def transport(url, method, headers, body, timeout):
        return 200, {"output": "ok"}

    backend = HttpBackend(url="https://user:supersecrettoken@runtime.test/run?key=abcd1234secret", transport=transport)
    result = _http_run(backend, tmp_path)

    assert result.exit_code == 0
    assert "supersecrettoken" not in result.command
    transcript = Path(result.transcript_path).read_text(encoding="utf-8")
    assert "supersecrettoken" not in transcript
    assert "abcd1234secret" not in transcript


def test_http_backend_blocks_cgnat_address(tmp_path):
    """`not is_global` catches ranges an explicit enum misses, e.g. CGNAT 100.64/10."""
    backend = HttpBackend(url="http://100.64.0.1/run")
    result = _http_run(backend, tmp_path)
    assert result.exit_code == 1
    assert "blocked" in result.output


def test_http_backend_available_redacts_url_credentials():
    backend = HttpBackend(url="https://user:supersecrettoken@runtime.test/run?key=abcd1234secret")
    a = backend.available()
    assert a.available is True
    assert "supersecrettoken" not in (a.executable or "")
    assert "supersecrettoken" not in (a.version or "")
    assert "abcd1234secret" not in (a.version or "")


def test_http_backend_redacts_reflected_token_in_usage(tmp_path):
    """A token echoed back inside the `usage` object must not reach the transcript."""
    token = "opaque-Basic-Zm9vOmJhcg=="

    def transport(url, method, headers, body, timeout):
        return 200, {"output": "ok", "usage": {"note": f"billed under {token}", "tokens": 5}}

    backend = HttpBackend(url="https://runtime.test/run", headers={"Authorization": token}, transport=transport)
    result = _http_run(backend, tmp_path)

    assert result.exit_code == 0
    transcript = Path(result.transcript_path).read_text(encoding="utf-8")
    assert token not in transcript


def test_http_backend_registered_in_default_registry():
    backends = default_backends()
    assert "http" in backends
    assert isinstance(backends["http"], HttpBackend)


# --------------------------------------------------------------------------- #
# OpenClawGatewayBackend — WebSocket gateway protocol                          #
# --------------------------------------------------------------------------- #


class _FakeGatewayClient:
    def __init__(self, *, result=None, connect_exc=None, run_id="run-1", hello=None):
        self._result = result
        self._connect_exc = connect_exc
        self._run_id = run_id
        self._hello = {"protocol": 4} if hello is None else hello
        self.closed = False
        self.seen_message = None
        self.seen_session_key = None

    def connect(self, timeout):
        if self._connect_exc is not None:
            raise self._connect_exc
        return self._hello

    def run_agent(self, message, *, session_key, timeout):
        self.seen_message = message
        self.seen_session_key = session_key
        return self._run_id

    def wait_agent(self, run_id, timeout):
        return self._result

    def close(self):
        self.closed = True


def _gw_run(backend, tmp_path, **limit_kw):
    goal = GoalSpec(title="Ship", description="Use the gateway")
    session = RunSession(goal_id=goal.goal_id, run_id="run_gw")
    limits = WorkerLimits(repo_path=tmp_path, artifact_dir=tmp_path / "artifacts", budget_seconds=10, **limit_kw)
    return backend.run(_task(WorkerRole.IMPLEMENT), goal, session, limits)


def test_openclaw_gateway_completed_run_succeeds(tmp_path):
    fake = _FakeGatewayClient(result=AgentRunResult(status="completed", output="pong", error="", run_id="r1", raw={}))
    backend = OpenClawGatewayBackend(url="ws://127.0.0.1:18789", token="t", client_factory=lambda u, k: fake)
    result = _gw_run(backend, tmp_path)
    assert result.backend == "openclaw-gateway"
    assert result.exit_code == 0
    assert "pong" in result.output
    assert fake.closed is True
    assert "superclaw-run_gw-task_1" == fake.seen_session_key


def test_openclaw_gateway_error_status_fails(tmp_path):
    fake = _FakeGatewayClient(result=AgentRunResult(status="error", output="", error="boom", run_id="r1", raw={}))
    backend = OpenClawGatewayBackend(url="ws://127.0.0.1:18789", token="t", client_factory=lambda u, k: fake)
    result = _gw_run(backend, tmp_path)
    assert result.exit_code == 1
    assert "boom" in result.output


def test_openclaw_gateway_not_paired_is_clear(tmp_path):
    exc = OpenClawGatewayError("device not approved", code="NOT_PAIRED")
    backend = OpenClawGatewayBackend(url="ws://127.0.0.1:18789", token="t", client_factory=lambda u, k: _FakeGatewayClient(connect_exc=exc))
    result = _gw_run(backend, tmp_path)
    assert result.exit_code == 1
    assert "OPENCLAW_GATEWAY_NOT_PAIRED" in result.output
    assert "openclaw devices approve" in result.output


def test_openclaw_gateway_connection_error_fails(tmp_path):
    backend = OpenClawGatewayBackend(url="ws://127.0.0.1:18789", token="t", client_factory=lambda u, k: _FakeGatewayClient(connect_exc=OSError("refused")))
    result = _gw_run(backend, tmp_path)
    assert result.exit_code == 1
    assert "connection failed" in result.output


def test_openclaw_gateway_fail_closed_on_mcp_configs(tmp_path):
    fake = _FakeGatewayClient(result=AgentRunResult(status="completed", output="x", error="", run_id="r1", raw={}))
    backend = OpenClawGatewayBackend(url="ws://127.0.0.1:18789", token="t", client_factory=lambda u, k: fake)
    result = _gw_run(backend, tmp_path, permission_policy=PermissionPolicy(mode="plan", mcp_configs=[str(tmp_path / "m.json")]))
    assert result.exit_code == 1
    assert "PLUGIN_RUNTIME_CONFIG_INVALID" in result.output
    assert fake.seen_message is None  # never invoked the gateway


def test_openclaw_gateway_unconfigured_url_reports_127(tmp_path, monkeypatch):
    monkeypatch.delenv("SUPERCLAW_OPENCLAW_GATEWAY_URL", raising=False)
    backend = OpenClawGatewayBackend()
    assert backend.available().available is False
    result = _gw_run(backend, tmp_path)
    assert result.exit_code == 127


def test_openclaw_gateway_available_validates_ws_scheme():
    assert OpenClawGatewayBackend(url="ws://127.0.0.1:18789").available().available is True   # loopback ws ok
    assert OpenClawGatewayBackend(url="wss://gw.test/x").available().available is True        # remote wss ok
    assert OpenClawGatewayBackend(url="http://gw.test").available().available is False        # wrong scheme


def test_openclaw_gateway_refuses_plaintext_ws_to_remote_host(monkeypatch):
    monkeypatch.delenv("SUPERCLAW_OPENCLAW_GATEWAY_ALLOW_INSECURE", raising=False)
    a = OpenClawGatewayBackend(url="ws://gw.remote.test/path").available()
    assert a.available is False
    assert "plaintext ws://" in a.reason
    monkeypatch.setenv("SUPERCLAW_OPENCLAW_GATEWAY_ALLOW_INSECURE", "true")
    assert OpenClawGatewayBackend(url="ws://gw.remote.test/path").available().available is True


def test_openclaw_gateway_available_redacts_url_credentials():
    a = OpenClawGatewayBackend(url="wss://user:supersecrettoken@gw.test/run?token=abcd1234secret").available()
    assert a.available is True
    assert "supersecrettoken" not in (a.version or "")
    assert "abcd1234secret" not in (a.version or "")


def test_openclaw_gateway_available_detects_missing_websocket_dep(monkeypatch):
    import builtins
    real_import = builtins.__import__

    def fake_import(name, *a, **k):
        if name == "websocket":
            raise ImportError("no websocket")
        return real_import(name, *a, **k)

    monkeypatch.setattr(builtins, "__import__", fake_import)
    a = OpenClawGatewayBackend(url="ws://127.0.0.1:18789").available()
    assert a.available is False
    assert "websocket-client" in a.reason


def test_openclaw_gateway_timeout_maps_to_124(tmp_path):
    backend = OpenClawGatewayBackend(
        url="ws://127.0.0.1:18789", token="t",
        client_factory=lambda u, k: _FakeGatewayClient(connect_exc=OpenClawGatewayError("connect timeout waiting for response")),
    )
    result = _gw_run(backend, tmp_path)
    assert result.exit_code == 124
    assert result.timed_out is True


def test_openclaw_gateway_client_rejects_delimiter_token(tmp_path):
    from superclaw.openclaw_gateway import OpenClawGatewayClient, DeviceIdentity

    client = OpenClawGatewayClient(
        "ws://gw.test", token="bad|token", device=DeviceIdentity.resolve(str(tmp_path / "k.pem")),
        connect_fn=lambda url, timeout: _ScriptedSocket({}),
    )
    with pytest.raises(OpenClawGatewayError):
        client.connect(5.0)


def test_openclaw_gateway_device_key_is_0600(tmp_path):
    from superclaw.openclaw_gateway import DeviceIdentity
    import stat

    key_path = tmp_path / "dev.pem"
    DeviceIdentity.resolve(str(key_path))
    assert stat.S_IMODE(key_path.stat().st_mode) == 0o600


def test_openclaw_gateway_rejects_loose_permission_key(tmp_path):
    import os
    from superclaw.openclaw_gateway import DeviceIdentity
    if os.name != "posix":
        pytest.skip("permission bits are POSIX-only")
    key_path = tmp_path / "dev.pem"
    DeviceIdentity.resolve(str(key_path))  # creates 0600
    os.chmod(key_path, 0o644)  # loosen it
    with pytest.raises(OpenClawGatewayError):
        DeviceIdentity.resolve(str(key_path))


def test_openclaw_gateway_cancelled_before_start_does_not_connect(tmp_path):
    fake = _FakeGatewayClient(result=AgentRunResult(status="completed", output="x", error="", run_id="r1", raw={}))
    backend = OpenClawGatewayBackend(url="ws://127.0.0.1:18789", token="t", client_factory=lambda u, k: fake)
    goal = GoalSpec(title="Ship", description="x")
    session = RunSession(goal_id=goal.goal_id, run_id="run_gw")
    limits = WorkerLimits(
        repo_path=tmp_path, artifact_dir=tmp_path / "artifacts", budget_seconds=10,
        cancel_check=lambda: True,
    )
    result = backend.run(_task(WorkerRole.IMPLEMENT), goal, session, limits)
    assert result.exit_code == 130
    assert result.cancelled is True
    assert "cancelled before start" in result.output
    assert fake.seen_message is None  # never reached the gateway


def test_openclaw_gateway_cancelled_after_connect_does_not_run_agent(tmp_path):
    # cancel flips True only after connect() runs, so the agent must not start.
    state = {"connected": False}

    class _CancelAfterConnect(_FakeGatewayClient):
        def connect(self, timeout):
            state["connected"] = True
            return {"protocol": 4}

    fake = _CancelAfterConnect(result=AgentRunResult(status="completed", output="x", error="", run_id="r1", raw={}))
    backend = OpenClawGatewayBackend(url="ws://127.0.0.1:18789", token="t", client_factory=lambda u, k: fake)
    goal = GoalSpec(title="Ship", description="x")
    session = RunSession(goal_id=goal.goal_id, run_id="run_gw")
    limits = WorkerLimits(
        repo_path=tmp_path, artifact_dir=tmp_path / "artifacts", budget_seconds=10,
        cancel_check=lambda: state["connected"],
    )
    result = backend.run(_task(WorkerRole.IMPLEMENT), goal, session, limits)
    assert result.exit_code == 130
    assert result.cancelled is True
    assert "cancelled after connect" in result.output
    assert fake.seen_message is None


def test_openclaw_gateway_unsupported_protocol_fails(tmp_path):
    fake = _FakeGatewayClient(hello={"protocol": 99}, result=AgentRunResult(status="completed", output="x", error="", run_id="r1", raw={}))
    backend = OpenClawGatewayBackend(url="ws://127.0.0.1:18789", token="t", client_factory=lambda u, k: fake)
    result = _gw_run(backend, tmp_path)
    assert result.exit_code == 1
    assert "unusable protocol" in result.output
    assert fake.seen_message is None  # never sent the agent request


def test_openclaw_gateway_missing_protocol_fails(tmp_path):
    fake = _FakeGatewayClient(hello={}, result=AgentRunResult(status="completed", output="x", error="", run_id="r1", raw={}))
    backend = OpenClawGatewayBackend(url="ws://127.0.0.1:18789", token="t", client_factory=lambda u, k: fake)
    result = _gw_run(backend, tmp_path)
    assert result.exit_code == 1
    assert "unusable protocol" in result.output
    assert fake.seen_message is None


def test_openclaw_gateway_socket_timeout_maps_to_124(tmp_path):
    import socket as _socket

    class _TimeoutClient(_FakeGatewayClient):
        def wait_agent(self, run_id, timeout):
            raise _socket.timeout("read timed out")

    fake = _TimeoutClient()
    backend = OpenClawGatewayBackend(url="ws://127.0.0.1:18789", token="t", client_factory=lambda u, k: fake)
    result = _gw_run(backend, tmp_path)
    assert result.exit_code == 124
    assert result.timed_out is True


def test_openclaw_gateway_success_transcript_redacts_url_credentials(tmp_path):
    fake = _FakeGatewayClient(result=AgentRunResult(status="completed", output="pong", error="", run_id="r1", raw={}))
    backend = OpenClawGatewayBackend(
        url="wss://user:supersecrettoken@gw.test/run?token=abcd1234secret", token="t",
        client_factory=lambda u, k: fake,
    )
    result = _gw_run(backend, tmp_path)
    assert result.exit_code == 0
    assert "supersecrettoken" not in result.command
    transcript = Path(result.transcript_path).read_text(encoding="utf-8")
    assert "supersecrettoken" not in transcript
    assert "abcd1234secret" not in transcript


def test_openclaw_gateway_registered_in_default_registry():
    backends = default_backends()
    assert "openclaw-gateway" in backends
    assert isinstance(backends["openclaw-gateway"], OpenClawGatewayBackend)


# --- Protocol-level test: drive the real client over a scripted fake socket --- #


class _FakeWebSocket:
    """A scripted fake WS: yields queued server frames on recv, records sends."""

    def __init__(self, server_frames):
        self._frames = list(server_frames)
        self.sent = []

    def recv(self):
        if not self._frames:
            raise AssertionError("no more scripted frames")
        return json.dumps(self._frames.pop(0))

    def send(self, payload):
        self.sent.append(json.loads(payload))

    def close(self):
        pass


def test_openclaw_gateway_client_handshake_and_agent_protocol(tmp_path):
    """Exercises the real connect→agent→agent.wait protocol (signing, challenge,
    request/response id matching) against a scripted socket — no real gateway."""
    from superclaw.openclaw_gateway import OpenClawGatewayClient, DeviceIdentity

    captured = {}

    def connect_fn(url, timeout):
        # The client sends 3 requests (connect, agent, agent.wait). Respond to each
        # by echoing its id. We pre-script a socket whose recv() returns the
        # challenge first, then we dynamically answer based on what was sent.
        return _ScriptedSocket(captured)

    dev = DeviceIdentity.resolve(str(tmp_path / "k.pem"))
    client = OpenClawGatewayClient("ws://gw.test", token="tok", device=dev, connect_fn=connect_fn)
    hello = client.connect(5.0)
    assert hello.get("protocol") == 4
    rid = client.run_agent("do the thing", session_key="sk", timeout=5.0)
    assert rid == "run-xyz"
    res = client.wait_agent(rid, 5.0)
    assert res.ok is True and res.output == "done"
    # The connect frame carried a signed device identity.
    connect_req = next(f for f in captured["sent"] if f.get("method") == "connect")
    assert connect_req["params"]["device"]["id"] == dev.device_id
    assert connect_req["params"]["device"]["signature"]
    assert connect_req["params"]["auth"]["token"] == "tok"


class _ScriptedSocket:
    """A fake socket that answers each request frame by id, like a real gateway."""

    def __init__(self, captured):
        self._pending = [{"type": "event", "event": "connect.challenge", "payload": {"nonce": "n-1", "ts": 1}}]
        self._sent = captured.setdefault("sent", [])

    def recv(self):
        if not self._pending:
            raise AssertionError("recv with nothing pending")
        return json.dumps(self._pending.pop(0))

    def send(self, payload):
        frame = json.loads(payload)
        self._sent.append(frame)
        method = frame.get("method")
        rid = frame.get("id")
        if method == "connect":
            self._pending.append({"type": "res", "id": rid, "ok": True, "payload": {"protocol": 4}})
        elif method == "agent":
            self._pending.append({"type": "res", "id": rid, "ok": True, "payload": {"runId": "run-xyz", "status": "accepted"}})
        elif method == "agent.wait":
            self._pending.append({"type": "res", "id": rid, "ok": True, "payload": {"runId": "run-xyz", "status": "completed", "output": "done"}})

    def close(self):
        pass


# ---------------------------------------------------------------------------
# Per-run model override (WorkerLimits.model_override)
# ---------------------------------------------------------------------------


def _override_limits(tmp_path: Path, model: str = "override-model-x") -> WorkerLimits:
    return WorkerLimits(
        repo_path=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        budget_seconds=10,
        model_override=model,
    )


@pytest.mark.parametrize(
    ("backend_cls", "executable_name", "env_var"),
    [
        (ClaudeCliBackend, "claude", "SUPERCLAW_CLAUDE_MODEL"),
        (OpenCodeCliBackend, "opencode", "SUPERCLAW_OPENCODE_MODEL"),
        (GrokCliBackend, "grok", "SUPERCLAW_GROK_MODEL"),
        (CursorCliBackend, "cursor-agent", "SUPERCLAW_CURSOR_MODEL"),
        (BoboCliBackend, "bobo", "SUPERCLAW_BOBO_MODEL"),
        (HermesCliBackend, "hermes", "SUPERCLAW_HERMES_MODEL"),
        (OpenClawCliBackend, "openclaw", "SUPERCLAW_OPENCLAW_MODEL"),
    ],
)
def test_cli_backend_model_override_beats_env_default(tmp_path, monkeypatch, backend_cls, executable_name, env_var):
    monkeypatch.setenv(env_var, "env-default-model")
    backend = backend_cls(executable=str(_fake_executable(tmp_path, executable_name)))
    goal = GoalSpec(title="Ship", description="Use per-run model")
    session = RunSession(goal_id=goal.goal_id, run_id=f"run_override_{backend.name}")

    result = backend.run(_task(WorkerRole.PLAN), goal, session, _override_limits(tmp_path))

    assert result.exit_code == 0
    assert "--model override-model-x" in result.output
    assert "env-default-model" not in result.output


def test_codex_backend_exec_mode_honors_model_override(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_CODEX_MODE", "exec")
    monkeypatch.setenv("SUPERCLAW_CODEX_MODEL", "env-default-model")
    codex = CodexCliBackend(executable=str(_fake_executable(tmp_path, "codex")))
    goal = GoalSpec(title="Ship", description="Use per-run model")
    session = RunSession(goal_id=goal.goal_id, run_id="run_codex_model_override")

    result = codex.run(_task(WorkerRole.PLAN), goal, session, _override_limits(tmp_path))

    assert result.exit_code == 0
    assert "fake-agent exec" in result.output
    assert "--model override-model-x" in result.output
    assert "env-default-model" not in result.output


def test_codex_backend_legacy_mode_fails_closed_on_model_selection(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_CODEX_MODE", "legacy")
    monkeypatch.delenv("SUPERCLAW_CODEX_MODEL", raising=False)
    codex = CodexCliBackend(executable=str(_fake_executable(tmp_path, "codex")))
    goal = GoalSpec(title="Ship", description="Use per-run model")
    session = RunSession(goal_id=goal.goal_id, run_id="run_codex_legacy_model")

    result = codex.run(_task(WorkerRole.PLAN), goal, session, _override_limits(tmp_path))

    assert result.exit_code == 1
    assert "MODEL_OVERRIDE_UNSUPPORTED" in result.output
    # the worker must NOT have executed on a silently different model
    assert "fake-agent" not in result.output


def test_local_backend_fails_closed_on_model_override(tmp_path):
    backend = LocalShellBackend()
    goal = GoalSpec(title="Ship", description="local has no model")
    session = RunSession(goal_id=goal.goal_id, run_id="run_local_model")

    result = backend.run(_task(), goal, session, _override_limits(tmp_path))

    assert result.exit_code == 1
    assert "MODEL_OVERRIDE_UNSUPPORTED" in result.output


def test_openclaw_gateway_fails_closed_on_model_override_without_network(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_OPENCLAW_GATEWAY_URL", "ws://127.0.0.1:18789")
    connected = {"count": 0}

    def factory(url, token):
        connected["count"] += 1
        raise AssertionError("gateway must not be contacted when the override cannot be honored")

    backend = OpenClawGatewayBackend(client_factory=factory)
    goal = GoalSpec(title="Ship", description="gateway owns its model")
    session = RunSession(goal_id=goal.goal_id, run_id="run_gateway_model")

    result = backend.run(_task(), goal, session, _override_limits(tmp_path))

    assert result.exit_code == 1
    assert "MODEL_OVERRIDE_UNSUPPORTED" in result.output
    assert connected["count"] == 0


def test_http_backend_forwards_model_override_in_body(tmp_path, monkeypatch):
    captured: dict = {}

    def transport(url, method, headers, body, timeout):
        captured["body"] = body
        return 200, {"output": "remote done"}

    backend = HttpBackend(url="https://agent.example.com/run", transport=transport)
    goal = GoalSpec(title="Ship", description="forward model to endpoint")
    session = RunSession(goal_id=goal.goal_id, run_id="run_http_model")

    result = backend.run(_task(WorkerRole.PLAN), goal, session, _override_limits(tmp_path))

    assert result.exit_code == 0
    assert captured["body"]["model"] == "override-model-x"


def test_http_backend_omits_model_field_when_unset(tmp_path, monkeypatch):
    monkeypatch.delenv("SUPERCLAW_HTTP_MODEL", raising=False)
    captured: dict = {}

    def transport(url, method, headers, body, timeout):
        captured["body"] = body
        return 200, {"output": "remote done"}

    backend = HttpBackend(url="https://agent.example.com/run", transport=transport)
    goal = GoalSpec(title="Ship", description="no model selected")
    session = RunSession(goal_id=goal.goal_id, run_id="run_http_nomodel")
    limits = WorkerLimits(repo_path=tmp_path, artifact_dir=tmp_path / "artifacts", budget_seconds=10)

    result = backend.run(_task(WorkerRole.PLAN), goal, session, limits)

    assert result.exit_code == 0
    assert "model" not in captured["body"]


def test_anthropic_backend_model_override_reaches_message_call(tmp_path):
    seen: dict = {}

    def message_fn(model, prompt):
        seen["model"] = model
        return "anthropic done"

    backend = AnthropicApiBackend(message_fn=message_fn)
    goal = GoalSpec(title="Ship", description="API model override")
    session = RunSession(goal_id=goal.goal_id, run_id="run_anthropic_model")

    result = backend.run(_task(), goal, session, _override_limits(tmp_path))

    assert result.exit_code == 0
    assert seen["model"] == "override-model-x"
    assert "model=override-model-x" in (result.command or "")


def test_gemini_agent_model_override_recorded_in_command_repr(tmp_path):
    def completion_fn(messages, tools):
        return {"choices": [{"message": {"content": "", "tool_calls": [
            {"id": "1", "function": {"name": "finish", "arguments": json.dumps({"summary": "done", "success": True})}}
        ]}}]}

    backend = GeminiAgentBackend(completion_fn=completion_fn)
    goal = GoalSpec(title="Ship", description="gemini model override")
    session = RunSession(goal_id=goal.goal_id, run_id="run_gemini_model")

    result = backend.run(_task(), goal, session, _override_limits(tmp_path))

    assert "model=override-model-x" in (result.command or "")


def test_anthropic_agent_model_override_recorded_in_command_repr(tmp_path):
    def completion_fn(system, messages, tools):
        return {"stop_reason": "end_turn", "content": [{"type": "text", "text": "done"}]}

    backend = AnthropicAgentBackend(completion_fn=completion_fn)
    goal = GoalSpec(title="Ship", description="anthropic agent model override")
    session = RunSession(goal_id=goal.goal_id, run_id="run_anth_agent_model")

    result = backend.run(_task(), goal, session, _override_limits(tmp_path))

    assert "model=override-model-x" in (result.command or "")


def test_gemini_agent_complete_payload_carries_model_override(monkeypatch):
    captured: dict = {}

    class _Resp:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def read(self):
            return json.dumps({"choices": [{"message": {"content": "ok"}}]}).encode("utf-8")

    def fake_urlopen(request, timeout=None):
        captured["payload"] = json.loads(request.data.decode("utf-8"))
        return _Resp()

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    backend = GeminiAgentBackend(api_key="test-key")

    backend._complete([{"role": "user", "content": "hi"}], [], timeout=5.0, model="override-model-x")

    assert captured["payload"]["model"] == "override-model-x"


def test_anthropic_agent_complete_payload_carries_model_override(monkeypatch):
    captured: dict = {}

    class _Resp:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def read(self):
            return json.dumps({"stop_reason": "end_turn", "content": []}).encode("utf-8")

    def fake_urlopen(request, timeout=None):
        captured["payload"] = json.loads(request.data.decode("utf-8"))
        return _Resp()

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    backend = AnthropicAgentBackend(api_key="test-key")

    backend._complete("system", [{"role": "user", "content": "hi"}], [], timeout=5.0, model="override-model-x")

    assert captured["payload"]["model"] == "override-model-x"


def test_grok_backend_refuses_explicit_effort_and_ignores_legacy_env(tmp_path, monkeypatch):
    # No Grok model honors a reasoning-effort selection, so grok is
    # supports_effort=False: an explicit per-run effort is refused fail-closed,
    # the legacy SUPERCLAW_GROK_EFFORT env no longer leaks an --effort flag, and a
    # plain run never carries --effort.
    goal = GoalSpec(title="Ship", description="grok + effort")
    grok = GrokCliBackend(executable=str(_fake_executable(tmp_path, "grok")))

    # Explicit per-run effort → fail-closed, CLI never spawned.
    refused = grok.run(
        _task(WorkerRole.PLAN), goal, RunSession(goal_id=goal.goal_id, run_id="run_grok_eff"),
        WorkerLimits(repo_path=tmp_path, artifact_dir=tmp_path / "a", budget_seconds=10, effort_override="high"),
    )
    assert refused.exit_code == 1
    assert "EFFORT_OVERRIDE_UNSUPPORTED" in refused.output
    assert "fake-agent" not in refused.output  # guard returns before spawning the CLI

    # Legacy env is now inert — no effort means a normal run with no --effort flag.
    monkeypatch.setenv("SUPERCLAW_GROK_EFFORT", "xhigh")
    limits = WorkerLimits(repo_path=tmp_path, artifact_dir=tmp_path / "a", budget_seconds=10)
    env_run = grok.run(_task(WorkerRole.PLAN), goal, RunSession(goal_id=goal.goal_id, run_id="run_grok_env"), limits)
    assert env_run.exit_code == 0
    assert "--effort" not in env_run.output  # the env no longer injects an unsupported flag

    monkeypatch.delenv("SUPERCLAW_GROK_EFFORT", raising=False)
    none = grok.run(_task(WorkerRole.PLAN), goal, RunSession(goal_id=goal.goal_id, run_id="run_grok_noeffort"), limits)
    assert none.exit_code == 0
    assert "--effort" not in none.output


def test_grok_backend_guards_oversized_argv_prompt(tmp_path, monkeypatch):
    monkeypatch.delenv("SUPERCLAW_GROK_EFFORT", raising=False)
    goal = GoalSpec(title="Ship", description="x" * (97 * 1024))  # rendered prompt > 96 KiB budget
    grok = GrokCliBackend(executable=str(_fake_executable(tmp_path, "grok")))
    limits = WorkerLimits(repo_path=tmp_path, artifact_dir=tmp_path / "artifacts", budget_seconds=10)

    result = grok.run(_task(WorkerRole.PLAN), goal, RunSession(goal_id=goal.goal_id, run_id="run_grok_big"), limits)

    assert result.exit_code == 1
    assert "GROK_PROMPT_TOO_LARGE" in result.output
    assert "fake-agent" not in result.output  # never reached spawn (no E2BIG)


# ---------------------------------------------------------------------------
# ClawWork backend (experimental model-relay harness) + policy snapshot
# ---------------------------------------------------------------------------


def test_clawwork_policy_snapshot_roundtrip_and_signature(tmp_path):
    import hashlib
    import hmac
    import json as _json
    from superclaw.clawwork_policy import write_policy_snapshot

    handle = write_policy_snapshot(
        directory=str(tmp_path / "art"),
        mode="plan",
        allowed_tools=["read"],
        disallowed_tools=["bash"],
        pay_switch_enabled=False,
        run_id="run_xyz",
        issued_at=123.0,
        key="test-key",
    )
    envelope = _json.loads(Path(handle.path).read_text(encoding="utf-8"))
    # the signature must verify over the EXACT stored payload string (the TS
    # extension re-signs envelope.payload verbatim, so both sides must match)
    expected = hmac.new(b"test-key", envelope["payload"].encode("utf-8"), hashlib.sha256).hexdigest()
    assert envelope["signature"] == expected
    payload = _json.loads(envelope["payload"])
    assert payload["mode"] == "plan" and payload["disallowed_tools"] == ["bash"]
    assert payload["version"] == 1 and payload["run_id"] == "run_xyz"
    # file is 0600 (carries governance authority + its own signature)
    if os.name == "posix":
        assert (Path(handle.path).stat().st_mode & 0o777) == 0o600
    assert handle.env()["SUPERCLAW_POLICY_SNAPSHOT"] == handle.path
    assert handle.env()["SUPERCLAW_POLICY_SNAPSHOT_KEY"] == "test-key"


def test_clawwork_policy_canonicalizes_tool_names(tmp_path):
    """Claude-convention names ("Bash") must reach the snapshot lower-cased —
    a case-sensitive denylist comparison would otherwise fail open."""
    import json as _json

    from superclaw.clawwork_policy import canonicalize_tool_names, write_policy_snapshot

    assert canonicalize_tool_names(["Bash", " Edit ", "bash", "", "WRITE"]) == ["bash", "edit", "write"]

    handle = write_policy_snapshot(
        directory=str(tmp_path / "art"),
        mode="bypassPermissions",
        allowed_tools=["Read", "GREP"],
        disallowed_tools=["Bash"],
        pay_switch_enabled=False,
        run_id="run_case",
        issued_at=123.0,
        key="test-key",
    )
    payload = _json.loads(_json.loads(Path(handle.path).read_text(encoding="utf-8"))["payload"])
    assert payload["allowed_tools"] == ["read", "grep"]
    assert payload["disallowed_tools"] == ["bash"]


def test_clawwork_backend_explicit_allowlist_is_canonicalized(tmp_path):
    from superclaw.backends import ClawWorkBackend
    from superclaw.runtime import PermissionPolicy

    policy = PermissionPolicy(mode="acceptEdits", allowed_tools=["Bash", "Read"])
    assert ClawWorkBackend._clawwork_tool_allowlist(policy) == ["bash", "read"]


def test_resolve_clawwork_runtime_paths_honors_env_override(tmp_path, monkeypatch):
    # The kernel helper that hands ClawWork's governance ext + executable to the Node
    # adapter must honor an explicit operator override (same precedence as the Python
    # backend's own resolution) and return the existing absolute paths.
    from superclaw.backends import resolve_clawwork_runtime_paths

    ext = tmp_path / "superclaw-governance.ts"
    ext.write_text("// gov", encoding="utf-8")
    exe = tmp_path / "clawwork"
    exe.write_text("#!/bin/sh\n", encoding="utf-8")
    monkeypatch.setenv("SUPERCLAW_CLAWWORK_GOVERNANCE_EXT", str(ext))
    monkeypatch.setenv("SUPERCLAW_CLAWWORK_EXECUTABLE", str(exe))

    gov_ext, executable = resolve_clawwork_runtime_paths()
    assert gov_ext == str(ext)
    assert executable == str(exe)


def test_resolve_clawwork_runtime_paths_drops_missing_paths(tmp_path, monkeypatch):
    # A non-existent override must NOT be propagated — the helper fails it to None so
    # node_runtime never injects a bogus path that would mask the adapter's own
    # fail-closed walk-up.
    from superclaw.backends import resolve_clawwork_runtime_paths

    monkeypatch.setenv("SUPERCLAW_CLAWWORK_GOVERNANCE_EXT", str(tmp_path / "nope.ts"))
    monkeypatch.setenv("SUPERCLAW_CLAWWORK_EXECUTABLE", str(tmp_path / "nope-bin"))

    gov_ext, executable = resolve_clawwork_runtime_paths()
    assert gov_ext is None
    assert executable is None


def _clawwork_limits(tmp_path, mode="default", model_override=None):
    from superclaw.runtime import PermissionPolicy
    return WorkerLimits(
        repo_path=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        budget_seconds=10,
        permission_policy=PermissionPolicy(mode=mode),
        model_override=model_override,
    )


def test_clawwork_run_records_model_and_usage_in_cost_snapshot(tmp_path, monkeypatch):
    """Regression: clawwork resolved a model and the relay returned token usage, but
    run()'s synth() never threaded either into the cost snapshot — so every clawwork
    turn reported model/provider=unknown and 0 tokens. The concrete model from
    agent_end must upgrade the relay alias, and the usage must reach the snapshot."""
    from superclaw.backends import ClawWorkBackend
    import superclaw.relay_packages as rp

    monkeypatch.setattr(
        rp, "relay_packages",
        lambda: {"packages": rp.default_relay_packages(), "source": "default", "available": True},
    )
    monkeypatch.setenv("SUPERCLAW_CLAWWORK_MODEL", "plus")  # → relay alias superclaw-plus

    def fake_rpc(command_obj, *, executable, command, env, cwd, budget_seconds, cancel_check):
        return {
            "exit_code": 0,
            "output": "done",
            "usage": {"input": 1500, "output": 400, "cacheRead": 200, "totalTokens": 2100},
            "model": "claude-opus-4-8",
        }

    backend = ClawWorkBackend(rpc_fn=fake_rpc)
    goal = GoalSpec(title="Ship", description="Use ClawWork")
    session = RunSession(goal_id=goal.goal_id, run_id="run_cw_cost")

    result = backend.run(_task(WorkerRole.IMPLEMENT), goal, session, _clawwork_limits(tmp_path, "plan"))

    assert result.exit_code == 0
    cost = result.cost
    assert cost is not None
    assert cost["provider"] == "clawrelay"          # nested runtime provider, no longer "unknown"
    assert cost["model"] == "claude-opus-4-8"        # concrete model upgraded the relay alias
    assert cost["input_tokens"] == 1500
    assert cost["output_tokens"] == 400
    assert cost["cached_input_tokens"] == 200
    assert cost["usage_status"] == "actual"
    assert cost["meter_kind"] == "model_tokens"


def test_clawwork_run_without_usage_falls_back_to_relay_alias(tmp_path, monkeypatch):
    """When the relay returns no usage/model (older harness, error mid-stream), the
    snapshot still carries the relay alias model + clawrelay provider and records an
    honest unavailable/wall_clock entry — never a confident 0-token 'actual'."""
    from superclaw.backends import ClawWorkBackend
    import superclaw.relay_packages as rp

    monkeypatch.setattr(
        rp, "relay_packages",
        lambda: {"packages": rp.default_relay_packages(), "source": "default", "available": True},
    )
    monkeypatch.setenv("SUPERCLAW_CLAWWORK_MODEL", "plus")

    def fake_rpc(command_obj, *, executable, command, env, cwd, budget_seconds, cancel_check):
        return {"exit_code": 0, "output": "done"}  # no usage, no model

    backend = ClawWorkBackend(rpc_fn=fake_rpc)
    goal = GoalSpec(title="Ship", description="Use ClawWork")
    session = RunSession(goal_id=goal.goal_id, run_id="run_cw_nousage")
    result = backend.run(_task(WorkerRole.IMPLEMENT), goal, session, _clawwork_limits(tmp_path, "plan"))

    assert result.exit_code == 0
    cost = result.cost
    assert cost["provider"] == "clawrelay"
    assert cost["model"] == "superclaw-plus"  # relay alias fallback (still not unknown)
    assert cost["input_tokens"] is None
    assert cost["usage_status"] == "unavailable"
    assert cost["meter_kind"] == "wall_clock"


def test_clawwork_run_records_actual_usage_on_governance_blocked(tmp_path, monkeypatch):
    """A governance-blocked turn still ran the model and consumed tokens (only a tool
    call was denied), so the cost snapshot must record the ACTUAL usage/model — while
    the non-zero exit marks the run failed. Blocked ≠ free."""
    from superclaw.backends import ClawWorkBackend
    import superclaw.relay_packages as rp

    monkeypatch.setattr(
        rp, "relay_packages",
        lambda: {"packages": rp.default_relay_packages(), "source": "default", "available": True},
    )
    monkeypatch.setenv("SUPERCLAW_CLAWWORK_MODEL", "plus")

    def fake_rpc(command_obj, *, executable, command, env, cwd, budget_seconds, cancel_check):
        return {
            "exit_code": 0,
            "output": "partial work before block",
            "governance_blocked": True,
            "usage": {"input": 50, "output": 10},
            "model": "claude-opus-4-8",
        }

    backend = ClawWorkBackend(rpc_fn=fake_rpc)
    goal = GoalSpec(title="Ship", description="Use ClawWork")
    session = RunSession(goal_id=goal.goal_id, run_id="run_cw_blocked")
    result = backend.run(_task(WorkerRole.IMPLEMENT), goal, session, _clawwork_limits(tmp_path, "plan"))

    assert result.exit_code != 0  # blocked → failed, never a completed run
    assert "CLAWWORK_GOVERNANCE_BLOCKED" in result.output
    cost = result.cost
    assert cost["model"] == "claude-opus-4-8"
    assert cost["input_tokens"] == 50
    assert cost["output_tokens"] == 10
    assert cost["usage_status"] == "actual"  # tokens really spent, recorded honestly


def test_clawwork_run_defaults_to_base_relay_tier_when_no_model(tmp_path, monkeypatch):
    """ClawWork's only provider is the relay, which REQUIRES a package model — it has no
    usable "no model" fallback (it rejects the prompt with "No API key found for the
    selected model"). When neither a per-run override nor SUPERCLAW_CLAWWORK_MODEL is
    set (the composer's relay-package selector sends '' for "use the relay default"),
    run() must default to the base tier so the documented default actually runs. The
    standard tier → slug map is contract-constant and network-free."""
    from superclaw.backends import ClawWorkBackend
    from superclaw.relay_packages import SUPERCLAW_BRIDGE_TIERS

    monkeypatch.delenv("SUPERCLAW_CLAWWORK_MODEL", raising=False)
    captured: dict[str, list[str]] = {}

    def fake_rpc(command_obj, *, executable, command, env, cwd, budget_seconds, cancel_check):
        captured["command"] = command
        return {"exit_code": 0, "output": "ok"}

    backend = ClawWorkBackend(rpc_fn=fake_rpc)
    goal = GoalSpec(title="Ship", description="Use ClawWork")
    session = RunSession(goal_id=goal.goal_id, run_id="run_cw_default_model")
    # No model_override on the limits, no env → must fall back to the base tier.
    result = backend.run(_task(WorkerRole.IMPLEMENT), goal, session, _clawwork_limits(tmp_path, "plan"))

    assert result.exit_code == 0
    command = captured["command"]
    assert "--model" in command, command
    base_slug = f"superclaw-{SUPERCLAW_BRIDGE_TIERS[0]}"  # contract: 'core' → 'superclaw-core'
    assert command[command.index("--model") + 1] == base_slug, command


def test_clawwork_run_composite_routes_concrete_model(tmp_path, monkeypatch):
    """Two-level menu (chat composer, clawwork-only): a composite model_override
    "<tier>::<model_id>" must (a) still bind the relay key to the TIER (so the
    ceiling check and group binding use 'plus', not the model id) and (b) send the
    CONCRETE model id to --model (the key is already group-scoped, LLMgate routes to
    that model inside the group) — NOT the group slug. This is the core contract that
    lets a user pick a specific model within a package tier."""
    from superclaw.backends import ClawWorkBackend
    import superclaw.relay_key as _relay_key
    import superclaw.relay_packages as rp

    monkeypatch.setattr(
        rp, "relay_packages",
        lambda: {"packages": rp.default_relay_packages(), "source": "default", "available": True},
    )
    monkeypatch.delenv("SUPERCLAW_CLAWWORK_MODEL", raising=False)
    # The tier ceiling check is network-bound; pin it open and capture the tier it saw,
    # proving the binding uses the TIER token (plus), never the model id.
    seen_tier: dict[str, str] = {}

    def fake_ceiling(tier):
        seen_tier["tier"] = tier
        return True, "max", tier

    monkeypatch.setattr(_relay_key, "check_tier_within_ceiling", fake_ceiling)

    captured: dict[str, list[str]] = {}

    def fake_rpc(command_obj, *, executable, command, env, cwd, budget_seconds, cancel_check):
        captured["command"] = command
        return {"exit_code": 0, "output": "ok"}

    backend = ClawWorkBackend(rpc_fn=fake_rpc)
    goal = GoalSpec(title="Ship", description="Use ClawWork")
    session = RunSession(goal_id=goal.goal_id, run_id="run_cw_composite")
    limits = _clawwork_limits(tmp_path, "plan", model_override="plus::claude-opus-4-7")
    result = backend.run(_task(WorkerRole.IMPLEMENT), goal, session, limits)

    assert result.exit_code == 0
    assert seen_tier["tier"] == "plus", seen_tier  # binding uses the tier, not the model id
    command = captured["command"]
    assert "--model" in command, command
    # The concrete model id is sent, NOT the group slug 'superclaw-plus'.
    assert command[command.index("--model") + 1] == "claude-opus-4-7", command


def test_clawwork_run_composite_without_tier_is_refused(tmp_path, monkeypatch):
    """Fail-closed (Codex finding #1): a malformed composite '::<model>' — a level-2
    model with an EMPTY level-1 tier — must be REFUSED, not silently routed to the core
    fail-safe tier carrying an arbitrary model. The relay is never invoked."""
    from superclaw.backends import ClawWorkBackend
    import superclaw.relay_packages as rp

    monkeypatch.setattr(
        rp, "relay_packages",
        lambda: {"packages": rp.default_relay_packages(), "source": "default", "available": True},
    )
    monkeypatch.delenv("SUPERCLAW_CLAWWORK_MODEL", raising=False)

    called = {"rpc": False}

    def fake_rpc(command_obj, *, executable, command, env, cwd, budget_seconds, cancel_check):
        called["rpc"] = True
        return {"exit_code": 0, "output": "ok"}

    backend = ClawWorkBackend(rpc_fn=fake_rpc)
    goal = GoalSpec(title="Ship", description="Use ClawWork")
    session = RunSession(goal_id=goal.goal_id, run_id="run_cw_no_tier")
    limits = _clawwork_limits(tmp_path, "plan", model_override="::claude-opus-4-7")
    result = backend.run(_task(WorkerRole.IMPLEMENT), goal, session, limits)

    assert result.exit_code == 125, result
    assert "CLAWWORK_MODEL_WITHOUT_TIER" in result.output
    assert called["rpc"] is False  # refused before ever reaching the relay


def test_clawwork_run_composite_extra_separators_refused(tmp_path, monkeypatch):
    """Fail-closed (Codex re-review): the grammar is EXACTLY '<tier>::<model>' with one
    '::'. A model id never contains '::', so 'plus::foo::bar' is malformed and must be
    refused, never forwarded as a bogus --model token into the relay group."""
    from superclaw.backends import ClawWorkBackend
    import superclaw.relay_packages as rp

    monkeypatch.setattr(
        rp, "relay_packages",
        lambda: {"packages": rp.default_relay_packages(), "source": "default", "available": True},
    )
    monkeypatch.delenv("SUPERCLAW_CLAWWORK_MODEL", raising=False)

    called = {"rpc": False}

    def fake_rpc(command_obj, *, executable, command, env, cwd, budget_seconds, cancel_check):
        called["rpc"] = True
        return {"exit_code": 0, "output": "ok"}

    backend = ClawWorkBackend(rpc_fn=fake_rpc)
    goal = GoalSpec(title="Ship", description="Use ClawWork")
    session = RunSession(goal_id=goal.goal_id, run_id="run_cw_extra_sep")
    limits = _clawwork_limits(tmp_path, "plan", model_override="plus::foo::bar")
    result = backend.run(_task(WorkerRole.IMPLEMENT), goal, session, limits)

    assert result.exit_code == 125, result
    assert "CLAWWORK_MODEL_MALFORMED" in result.output
    assert called["rpc"] is False


def test_clawwork_run_bare_tier_still_translates_to_slug(tmp_path, monkeypatch):
    """Back-compat: a bare tier (no '::') keeps the pre-two-level behavior — it
    translates to the group slug 'superclaw-<tier>' so LLMgate picks the group default.
    The composite parsing must never regress the plain-tier path the existing UI sends."""
    from superclaw.backends import ClawWorkBackend
    import superclaw.relay_key as _relay_key
    import superclaw.relay_packages as rp

    monkeypatch.setattr(
        rp, "relay_packages",
        lambda: {"packages": rp.default_relay_packages(), "source": "default", "available": True},
    )
    monkeypatch.delenv("SUPERCLAW_CLAWWORK_MODEL", raising=False)
    monkeypatch.setattr(_relay_key, "check_tier_within_ceiling", lambda tier: (True, "max", tier))

    captured: dict[str, list[str]] = {}

    def fake_rpc(command_obj, *, executable, command, env, cwd, budget_seconds, cancel_check):
        captured["command"] = command
        return {"exit_code": 0, "output": "ok"}

    backend = ClawWorkBackend(rpc_fn=fake_rpc)
    goal = GoalSpec(title="Ship", description="Use ClawWork")
    session = RunSession(goal_id=goal.goal_id, run_id="run_cw_bare_tier")
    limits = _clawwork_limits(tmp_path, "plan", model_override="plus")
    result = backend.run(_task(WorkerRole.IMPLEMENT), goal, session, limits)

    assert result.exit_code == 0
    command = captured["command"]
    assert command[command.index("--model") + 1] == "superclaw-plus", command


def test_clawwork_contract_default_model_matches_executed_default():
    """Zero-drift guard (铁律 2): the shared contract's display default_model MUST equal
    the base relay tier run() actually executes when nothing is selected. Without this,
    CLI/API/Web would advertise one default while the backend runs another (the exact
    drift adversarial review flagged when default_model was still 'configured-default')."""
    from superclaw.relay_packages import SUPERCLAW_BRIDGE_TIERS
    from superclaw.ui_contracts import AGENT_CONTROL_SPECS

    assert AGENT_CONTROL_SPECS["clawwork"]["default_model"] == SUPERCLAW_BRIDGE_TIERS[0]


def test_clawwork_run_maps_prompt_rejected_to_failed(tmp_path, monkeypatch):
    """A prompt ClawWork refused outright (surfaced by _spawn_rpc as prompt_rejected)
    must fail closed — non-zero exit, no completion marker, the real reason in output —
    so a rejected turn is never billed/marked completed."""
    from superclaw.backends import ClawWorkBackend

    monkeypatch.setenv("SUPERCLAW_CLAWWORK_MODEL", "plus")

    def fake_rpc(command_obj, *, executable, command, env, cwd, budget_seconds, cancel_check):
        return {
            "exit_code": 1,
            "prompt_rejected": True,
            "output": "CLAWWORK_PROMPT_REJECTED: No API key found for the selected model.",
        }

    backend = ClawWorkBackend(rpc_fn=fake_rpc)
    goal = GoalSpec(title="Ship", description="Use ClawWork")
    session = RunSession(goal_id=goal.goal_id, run_id="run_cw_rejected")
    result = backend.run(_task(WorkerRole.IMPLEMENT), goal, session, _clawwork_limits(tmp_path, "plan"))

    assert result.exit_code == 125  # fail-closed, like model_error / ungoverned
    assert "CLAWWORK_PROMPT_REJECTED" in result.output
    assert "No API key found" in result.output


def test_clawwork_spawn_rpc_returns_usage_and_model_from_agent_end(tmp_path):
    """_spawn_rpc must surface the terminal assistant turn's token usage and the
    CONCRETE model (responseModel over the requested alias) so run() can record real
    cost. Previously it parsed only text + stopReason and discarded usage/model."""
    import sys as _sys
    import textwrap

    from superclaw.backends import ClawWorkBackend

    script = tmp_path / "fake_clawwork.py"
    script.write_text(
        textwrap.dedent(
            """
            import json, os, sys, time
            with open(os.environ["SUPERCLAW_GOVERNANCE_READY_FILE"], "w") as f:
                json.dump({"handler_registered": True,
                           "nonce": os.environ.get("SUPERCLAW_GOVERNANCE_NONCE")}, f)
            sys.stdin.readline()
            print(json.dumps({"type": "agent_end", "messages": [
                {"role": "assistant", "content": [{"type": "text", "text": "PONG"}],
                 "stopReason": "end_turn", "model": "superclaw-plus",
                 "responseModel": "claude-opus-4-8",
                 "usage": {"input": 10, "output": 5, "cacheRead": 2, "totalTokens": 17}},
            ]}), flush=True)
            time.sleep(10)
            """
        ),
        encoding="utf-8",
    )

    env = dict(os.environ)
    env["SUPERCLAW_GOVERNANCE_READY_FILE"] = str(tmp_path / "ready.json")
    env["SUPERCLAW_GOVERNANCE_NONCE"] = "fresh-nonce"
    result = ClawWorkBackend()._spawn_rpc(
        {"type": "prompt", "message": "hi"},
        executable=_sys.executable,
        command=[_sys.executable, str(script)],
        env=env,
        cwd=str(tmp_path),
        budget_seconds=10.0,
        cancel_check=None,
    )

    assert result.get("exit_code") == 0
    assert result.get("model") == "claude-opus-4-8"  # responseModel preferred over requested alias
    assert result.get("usage") == {"input": 10, "output": 5, "cacheRead": 2, "totalTokens": 17}


def test_clawwork_spawn_rpc_rejected_prompt_is_terminal_not_hang(tmp_path):
    """Regression (packaged-app phantom hang): ClawWork's RPC loop ACKs a prompt with
    {"type":"response","command":"prompt","success":bool}. success=false means the
    prompt was refused (no API key / no model selected) — and ClawWork then stays ALIVE
    in RPC mode, emitting neither agent_end nor EOF. _spawn_rpc must treat the rejection
    as terminal and return prompt_rejected, NOT spin until the budget expires.

    The proof is BEHAVIOURAL (no wall-clock assertion, per the repo's test discipline):
    the fake stays alive past the budget, so a regression that ignored the rejection
    would surface as ``timed_out`` (never ``prompt_rejected``). The INJECTED budget is
    kept small (3s) purely to bound a regression's cost — the fix returns the instant
    the rejection line lands, long before it, so a green run never waits."""
    import sys as _sys
    import textwrap

    from superclaw.backends import ClawWorkBackend

    script = tmp_path / "fake_clawwork.py"
    script.write_text(
        textwrap.dedent(
            """
            import json, os, sys, time
            with open(os.environ["SUPERCLAW_GOVERNANCE_READY_FILE"], "w") as f:
                json.dump({"handler_registered": True,
                           "nonce": os.environ.get("SUPERCLAW_GOVERNANCE_NONCE")}, f)
            sys.stdin.readline()
            # Reject the prompt, then idle: NO agent_end, NO exit (ClawWork's real RPC
            # loop awaits the next command). A broken _spawn_rpc would hang here until
            # the (small, injected) budget; the fix returns immediately instead.
            print(json.dumps({"type": "response", "command": "prompt", "success": False,
                              "error": "No API key found for the selected model."}), flush=True)
            time.sleep(6)
            """
        ),
        encoding="utf-8",
    )

    env = dict(os.environ)
    env["SUPERCLAW_GOVERNANCE_READY_FILE"] = str(tmp_path / "ready.json")
    env["SUPERCLAW_GOVERNANCE_NONCE"] = "fresh-nonce"
    result = ClawWorkBackend()._spawn_rpc(
        {"type": "prompt", "message": "hi"},
        executable=_sys.executable,
        command=[_sys.executable, str(script)],
        env=env,
        cwd=str(tmp_path),
        budget_seconds=3.0,  # injected short deadline: bounds a regression, never waited on green
        cancel_check=None,
    )

    # Behavioural proof: prompt_rejected can ONLY be set by the terminal branch; a
    # regression (rejection ignored) would instead come back timed_out.
    assert result.get("prompt_rejected") is True, result
    assert not result.get("timed_out"), result
    assert "CLAWWORK_PROMPT_REJECTED" in result.get("output", "")
    assert "No API key found for the selected model." in result.get("output", "")


def test_clawwork_spawn_rpc_accepts_prompt_then_streams_agent_end(tmp_path):
    """Symmetry guard for the rejection branch: a success=TRUE prompt response is a mere
    ACK (the turn's agent_start/…/agent_end follow it), so _spawn_rpc must NOT treat it
    as terminal — it must keep reading until agent_end and return the assistant text."""
    import sys as _sys
    import textwrap

    from superclaw.backends import ClawWorkBackend

    script = tmp_path / "fake_clawwork.py"
    script.write_text(
        textwrap.dedent(
            """
            import json, os, sys, time
            with open(os.environ["SUPERCLAW_GOVERNANCE_READY_FILE"], "w") as f:
                json.dump({"handler_registered": True,
                           "nonce": os.environ.get("SUPERCLAW_GOVERNANCE_NONCE")}, f)
            sys.stdin.readline()
            # ACK then the real turn — success=true must NOT short-circuit the read loop.
            print(json.dumps({"type": "response", "command": "prompt", "success": True}), flush=True)
            print(json.dumps({"type": "agent_end", "messages": [
                {"role": "assistant", "content": [{"type": "text", "text": "ANSWERED"}],
                 "stopReason": "end_turn", "model": "superclaw-core"},
            ]}), flush=True)
            time.sleep(10)
            """
        ),
        encoding="utf-8",
    )

    env = dict(os.environ)
    env["SUPERCLAW_GOVERNANCE_READY_FILE"] = str(tmp_path / "ready.json")
    env["SUPERCLAW_GOVERNANCE_NONCE"] = "fresh-nonce"
    result = ClawWorkBackend()._spawn_rpc(
        {"type": "prompt", "message": "hi"},
        executable=_sys.executable,
        command=[_sys.executable, str(script)],
        env=env,
        cwd=str(tmp_path),
        budget_seconds=10.0,
        cancel_check=None,
    )

    assert result.get("exit_code") == 0, result
    assert not result.get("prompt_rejected"), result
    assert "ANSWERED" in result.get("output", "")


def test_clawwork_spawn_rpc_emits_canonical_tool_events_to_sink(tmp_path):
    """With an event_sink wired, _spawn_rpc must project the RPC stream's
    tool_execution_{start,update,end} events into canonical tool.started /
    tool.completed display events in real time (Tier 1 live tools). The
    cumulative partialResult update emits NO tool.delta."""
    import sys as _sys
    import textwrap

    from superclaw.backends import ClawWorkBackend

    script = tmp_path / "fake_clawwork.py"
    script.write_text(
        textwrap.dedent(
            """
            import json, os, sys, time
            with open(os.environ["SUPERCLAW_GOVERNANCE_READY_FILE"], "w") as f:
                json.dump({"handler_registered": True,
                           "nonce": os.environ.get("SUPERCLAW_GOVERNANCE_NONCE")}, f)
            sys.stdin.readline()
            def emit(obj):
                print(json.dumps(obj), flush=True)
            # Documented wire result shape: {"content": [...], "details": {...}}
            res = {"content": [{"type": "text", "text": "hi\\n"}], "details": {}}
            emit({"type": "tool_execution_start", "toolCallId": "t1",
                  "toolName": "bash", "args": {"command": "echo hi"}})
            emit({"type": "tool_execution_update", "toolCallId": "t1",
                  "toolName": "bash", "args": {}, "partialResult": res})
            emit({"type": "tool_execution_end", "toolCallId": "t1",
                  "toolName": "bash", "result": res, "isError": False})
            emit({"type": "agent_end", "messages": [
                {"role": "assistant", "content": [{"type": "text", "text": "done"}],
                 "stopReason": "end_turn", "model": "superclaw-plus"},
            ]})
            time.sleep(10)
            """
        ),
        encoding="utf-8",
    )

    events: list[tuple[str, dict]] = []

    env = dict(os.environ)
    env["SUPERCLAW_GOVERNANCE_READY_FILE"] = str(tmp_path / "ready.json")
    env["SUPERCLAW_GOVERNANCE_NONCE"] = "fresh-nonce"
    result = ClawWorkBackend()._spawn_rpc(
        {"type": "prompt", "message": "hi"},
        executable=_sys.executable,
        command=[_sys.executable, str(script)],
        env=env,
        cwd=str(tmp_path),
        budget_seconds=10.0,
        cancel_check=None,
        event_sink=lambda etype, payload: events.append((etype, payload)),
    )

    assert result.get("exit_code") == 0
    types = [etype for etype, _ in events]
    # exactly one started + one completed; the cumulative update emitted no delta
    assert types == ["tool.started", "tool.completed"]
    # event_sink receives the full DisplayEvent.to_dict() (same shape as claude /
    # codex: de.type, de.to_dict()); the ToolCall lives under ["payload"].
    started = events[0][1]["payload"]
    completed = events[1][1]["payload"]
    assert events[0][1]["runtime_id"] == "clawwork"
    assert started["call_id"] == "t1" and started["name"] == "bash" and started["kind"] == "command"
    assert completed["call_id"] == "t1" and completed["status"] == "ok"
    # output is the content array (NOT the {content,details} dict repr)
    assert completed["output"] == [{"type": "text", "text": "hi\n"}]
    assert completed["exit_code"] == 0


def test_clawwork_spawn_rpc_timeout_repairs_open_tool_card(tmp_path):
    """If the RPC stream opens a tool then never finalizes it (timeout / crash),
    the finally-block terminal repair must close the card with status=error and
    fold the last cumulative partialResult snapshot into output -- as real text,
    never a Python dict repr of the {content,details} envelope -- so a live
    surface never spins forever."""
    import sys as _sys
    import textwrap

    from superclaw.backends import ClawWorkBackend

    script = tmp_path / "fake_clawwork.py"
    script.write_text(
        textwrap.dedent(
            """
            import json, os, sys, time
            with open(os.environ["SUPERCLAW_GOVERNANCE_READY_FILE"], "w") as f:
                json.dump({"handler_registered": True,
                           "nonce": os.environ.get("SUPERCLAW_GOVERNANCE_NONCE")}, f)
            sys.stdin.readline()
            res = {"content": [{"type": "text", "text": "partial out"}], "details": {}}
            print(json.dumps({"type": "tool_execution_start", "toolCallId": "t1",
                              "toolName": "bash", "args": {"command": "hang"}}), flush=True)
            print(json.dumps({"type": "tool_execution_update", "toolCallId": "t1",
                              "toolName": "bash", "args": {}, "partialResult": res}), flush=True)
            time.sleep(30)  # never finalize -> force a budget timeout
            """
        ),
        encoding="utf-8",
    )

    events: list[tuple[str, dict]] = []
    env = dict(os.environ)
    env["SUPERCLAW_GOVERNANCE_READY_FILE"] = str(tmp_path / "ready.json")
    env["SUPERCLAW_GOVERNANCE_NONCE"] = "fresh-nonce"
    result = ClawWorkBackend()._spawn_rpc(
        {"type": "prompt", "message": "hi"},
        executable=_sys.executable,
        command=[_sys.executable, str(script)],
        env=env,
        cwd=str(tmp_path),
        budget_seconds=1.0,  # tight budget -> times out while the tool is open
        cancel_check=None,
        event_sink=lambda etype, payload: events.append((etype, payload)),
    )

    assert result.get("timed_out") is True
    types = [etype for etype, _ in events]
    assert types == ["tool.started", "tool.completed"]  # repair closed the open card
    repaired = events[1][1]["payload"]
    assert repaired["call_id"] == "t1"
    assert repaired["status"] == "error"  # not cancelled (a timeout, not a cancel)
    assert repaired["output"] == "partial out"  # folded snapshot, real text


def test_clawwork_spawn_rpc_no_sink_emits_nothing_and_still_runs(tmp_path):
    """Without an event_sink (e.g. a non-streaming worker run), _spawn_rpc must
    behave exactly as before — parse the stream, return the result, emit no
    display events (the projector is wired only when a sink is present)."""
    import sys as _sys
    import textwrap

    from superclaw.backends import ClawWorkBackend

    script = tmp_path / "fake_clawwork.py"
    script.write_text(
        textwrap.dedent(
            """
            import json, os, sys, time
            with open(os.environ["SUPERCLAW_GOVERNANCE_READY_FILE"], "w") as f:
                json.dump({"handler_registered": True,
                           "nonce": os.environ.get("SUPERCLAW_GOVERNANCE_NONCE")}, f)
            sys.stdin.readline()
            print(json.dumps({"type": "tool_execution_start", "toolCallId": "t1",
                              "toolName": "bash", "args": {"command": "ls"}}), flush=True)
            print(json.dumps({"type": "tool_execution_end", "toolCallId": "t1",
                              "toolName": "bash", "result": "ok", "isError": False}), flush=True)
            print(json.dumps({"type": "agent_end", "messages": [
                {"role": "assistant", "content": [{"type": "text", "text": "ok"}],
                 "stopReason": "end_turn", "model": "superclaw-plus"}]}), flush=True)
            time.sleep(10)
            """
        ),
        encoding="utf-8",
    )

    env = dict(os.environ)
    env["SUPERCLAW_GOVERNANCE_READY_FILE"] = str(tmp_path / "ready.json")
    env["SUPERCLAW_GOVERNANCE_NONCE"] = "fresh-nonce"
    result = ClawWorkBackend()._spawn_rpc(
        {"type": "prompt", "message": "hi"},
        executable=_sys.executable,
        command=[_sys.executable, str(script)],
        env=env,
        cwd=str(tmp_path),
        budget_seconds=10.0,
        cancel_check=None,
    )
    assert result.get("exit_code") == 0
    assert "ok" in str(result.get("output"))


def test_clawwork_run_propagates_trace_env_to_child(tmp_path):
    # agy follow-up: ClawWorkBackend has its own subprocess spawn path; the trace
    # correlation must reach the clawwork rpc child via env (ContextVar values are
    # never in os.environ).
    from superclaw import trace_context
    from superclaw.backends import ClawWorkBackend

    captured = {}

    def fake_rpc(command_obj, *, executable, command, env, cwd, budget_seconds, cancel_check):
        captured["trace_id"] = env.get("SUPERCLAW_TRACE_TRACE_ID")
        captured["run_id"] = env.get("SUPERCLAW_TRACE_RUN_ID")
        return {"exit_code": 0, "output": "clawwork ok"}

    backend = ClawWorkBackend(rpc_fn=fake_rpc)
    goal = GoalSpec(title="Ship", description="Use ClawWork")
    session = RunSession(goal_id=goal.goal_id, run_id="run_cw_trace")

    with trace_context.bind(trace_id="trace_cw", run_id="run_cw_trace"):
        result = backend.run(_task(WorkerRole.IMPLEMENT), goal, session, _clawwork_limits(tmp_path, "plan"))

    assert result.exit_code == 0
    assert captured["trace_id"] == "trace_cw"
    assert captured["run_id"] == "run_cw_trace"


def test_clawwork_backend_writes_signed_snapshot_and_maps_agent_end(tmp_path, monkeypatch):
    from superclaw.backends import ClawWorkBackend

    captured = {}

    def fake_rpc(command_obj, *, executable, command, env, cwd, budget_seconds, cancel_check):
        captured["command"] = command
        captured["snapshot"] = env.get("SUPERCLAW_POLICY_SNAPSHOT")
        captured["key"] = env.get("SUPERCLAW_POLICY_SNAPSHOT_KEY")
        captured["model_flag"] = "--model" in command and command[command.index("--model") + 1]
        return {"exit_code": 0, "output": "clawwork did the work"}

    # A raw model override hits the package-translation else-branch, which consults
    # relay_packages(); pin it to defaults so the test never reads real ~/.superclaw
    # state or touches the network (raw id matches no package → passes through).
    import superclaw.relay_packages as rp
    monkeypatch.setattr(
        rp, "relay_packages",
        lambda: {"packages": rp.default_relay_packages(), "source": "default", "available": True},
    )
    monkeypatch.setenv("SUPERCLAW_CLAWWORK_MODEL", "relay/some-model")
    backend = ClawWorkBackend(rpc_fn=fake_rpc)
    goal = GoalSpec(title="Ship", description="Use ClawWork")
    session = RunSession(goal_id=goal.goal_id, run_id="run_cw")

    result = backend.run(_task(WorkerRole.IMPLEMENT), goal, session, _clawwork_limits(tmp_path, "plan"))

    assert result.exit_code == 0
    assert "clawwork did the work" in result.output
    assert "superclaw_worker_result backend=clawwork" in result.output
    # snapshot was written, signed, and pointed at via env
    assert captured["snapshot"] and Path(captured["snapshot"]).exists()
    assert captured["key"]
    envelope = json.loads(Path(captured["snapshot"]).read_text(encoding="utf-8"))
    assert envelope["signature"] == hmac.new(
        captured["key"].encode("utf-8"), envelope["payload"].encode("utf-8"), hashlib.sha256
    ).hexdigest()
    assert json.loads(envelope["payload"])["mode"] == "plan"
    # provider is clawrelay; model override forwarded
    assert "clawrelay" in captured["command"]
    assert captured["model_flag"] == "relay/some-model"


def test_clawwork_native_session_projects_session_flags(tmp_path):
    """Tier 2: when WorkerLimits carries a native session, run() must drive ClawWork's
    durable session via --session-id + --session-dir + the session-dir env, NOT the
    default --no-session one-shot. The 0700 session dir is the SuperClaw-owned durable
    parent that shields ClawWork's world-readable session file."""
    import dataclasses

    from superclaw.backends import ClawWorkBackend
    from superclaw.clawwork_session import CLAWWORK_SESSION_DIR_ENV, native_session_dir

    captured = {}

    def fake_rpc(command_obj, *, executable, command, env, cwd, budget_seconds, cancel_check):
        captured["command"] = command
        captured["session_dir_env"] = env.get(CLAWWORK_SESSION_DIR_ENV)
        return {"exit_code": 0, "output": "ok"}

    sdir = native_session_dir("chat_xyz", backend="clawwork")  # real 0700 dir (lock needs it)
    limits = dataclasses.replace(
        _clawwork_limits(tmp_path, "plan"),
        native_session_id="chatxyz-001",
        native_session_dir=sdir,
    )
    backend = ClawWorkBackend(rpc_fn=fake_rpc)
    goal = GoalSpec(title="Ship", description="Use ClawWork")
    session = RunSession(goal_id=goal.goal_id, run_id="run_cw_sess")

    result = backend.run(_task(WorkerRole.IMPLEMENT), goal, session, limits)

    assert result.exit_code == 0
    cmd = captured["command"]
    assert "--no-session" not in cmd  # native session replaces the one-shot flag
    assert "--session-id" in cmd and cmd[cmd.index("--session-id") + 1] == "chatxyz-001"
    assert "--session-dir" in cmd and cmd[cmd.index("--session-dir") + 1] == str(sdir)
    assert captured["session_dir_env"] == str(sdir)


def test_clawwork_native_session_expect_resume_lost_fails_closed(tmp_path):
    """TOCTOU close: if the caller expected a RESUME but the durable session file is
    missing/ambiguous when run() re-verifies UNDER the lock, it must fail closed with
    CLAWWORK_NATIVE_SESSION_LOST and NEVER spawn (which would silently start empty)."""
    import dataclasses

    from superclaw.backends import ClawWorkBackend

    ran = {"called": False}

    def fake_rpc(command_obj, *, executable, command, env, cwd, budget_seconds, cancel_check):
        ran["called"] = True
        return {"exit_code": 0, "output": "should not run"}

    empty_dir = tmp_path / "sessions"  # no session file for the id -> not resumable
    empty_dir.mkdir()
    limits = dataclasses.replace(
        _clawwork_limits(tmp_path, "plan"),
        native_session_id="sess-gone",
        native_session_dir=empty_dir,
        native_session_expect_resume=True,
    )
    backend = ClawWorkBackend(rpc_fn=fake_rpc)
    goal = GoalSpec(title="Ship", description="Use ClawWork")
    session = RunSession(goal_id=goal.goal_id, run_id="run_cw_lost")

    result = backend.run(_task(WorkerRole.IMPLEMENT), goal, session, limits)
    assert "CLAWWORK_NATIVE_SESSION_LOST" in result.output
    assert ran["called"] is False  # fail-closed BEFORE the spawn


def test_clawwork_pending_reuse_no_expect_resume_does_not_fail_closed(tmp_path):
    """A reused PENDING binding (native_session_expect_resume=False) whose file does not
    exist yet (its in-flight creator hasn't persisted) must NOT hard-fail: --session-id
    is create-if-missing, so the turn proceeds and attaches under the lock. Only a TRUE
    resume (expect_resume=True) enforces file presence."""
    import dataclasses

    from superclaw.backends import ClawWorkBackend

    ran = {"called": False}

    def fake_rpc(command_obj, *, executable, command, env, cwd, budget_seconds, cancel_check):
        ran["called"] = True
        return {"exit_code": 0, "output": "ok"}

    empty_dir = tmp_path / "sessions"
    empty_dir.mkdir()
    limits = dataclasses.replace(
        _clawwork_limits(tmp_path, "plan"),
        native_session_id="sess-pending",
        native_session_dir=empty_dir,
        native_session_expect_resume=False,  # pending reuse, not a true resume
    )
    backend = ClawWorkBackend(rpc_fn=fake_rpc)
    goal = GoalSpec(title="Ship", description="Use ClawWork")
    session = RunSession(goal_id=goal.goal_id, run_id="run_cw_pending")

    result = backend.run(_task(WorkerRole.IMPLEMENT), goal, session, limits)
    assert ran["called"] is True  # proceeded (create-if-missing), no spurious LOST
    assert "CLAWWORK_NATIVE_SESSION_LOST" not in result.output


def test_clawwork_invalid_native_session_id_falls_back_to_no_session(tmp_path):
    """Fail-safe: an id ClawWork would reject (assertValidSessionId) must NOT be handed
    to the binary; run() falls back to the safe --no-session one-shot rather than
    spawning a guaranteed-failing turn."""
    import dataclasses

    from superclaw.backends import ClawWorkBackend

    captured = {}

    def fake_rpc(command_obj, *, executable, command, env, cwd, budget_seconds, cancel_check):
        captured["command"] = command
        return {"exit_code": 0, "output": "ok"}

    limits = dataclasses.replace(
        _clawwork_limits(tmp_path, "plan"),
        native_session_id="has spaces/and-slash",  # invalid per the grammar
        native_session_dir=tmp_path / "sessions",
    )
    backend = ClawWorkBackend(rpc_fn=fake_rpc)
    goal = GoalSpec(title="Ship", description="Use ClawWork")
    session = RunSession(goal_id=goal.goal_id, run_id="run_cw_bad")

    backend.run(_task(WorkerRole.IMPLEMENT), goal, session, limits)
    assert "--no-session" in captured["command"]
    assert "--session-id" not in captured["command"]


@pytest.mark.parametrize("selected,expect_model", [
    ("plus", "superclaw-plus"),       # super 套餐短名 → 隐藏 group slug（静态映射，无网络）
    ("MAX", "superclaw-max"),          # 大小写无关
    ("superclaw-core", "superclaw-core"),  # 已是 slug → 原样
    ("relay/raw-model", "relay/raw-model"),  # 裸模型 id → 不翻译，透传
])
def test_clawwork_backend_translates_package_to_group_slug(tmp_path, monkeypatch, selected, expect_model):
    """选中的 super 套餐发往 relay 前翻成隐藏 group slug（与 ClawHunt 主站一致）；
    裸模型 id 原样透传。覆盖 --model 实参这一执行入口。"""
    from superclaw.backends import ClawWorkBackend
    import superclaw.relay_packages as rp

    # 确定性：把动态套餐查询钉成默认 floor（避免读真实 ~/.superclaw 或触网）。静态档位走
    # 静态映射本就不调它；裸模型走 else 分支调它，钉成默认后判定为非套餐 → 透传。
    monkeypatch.setattr(
        rp, "relay_packages",
        lambda: {"packages": rp.default_relay_packages(), "source": "default", "available": True},
    )
    captured = {}

    def fake_rpc(command_obj, *, executable, command, env, cwd, budget_seconds, cancel_check):
        captured["model_flag"] = "--model" in command and command[command.index("--model") + 1]
        return {"exit_code": 0, "output": "ok"}

    monkeypatch.setenv("SUPERCLAW_CLAWWORK_MODEL", selected)
    backend = ClawWorkBackend(rpc_fn=fake_rpc)
    goal = GoalSpec(title="Ship", description="Use ClawWork")
    session = RunSession(goal_id=goal.goal_id, run_id="run_cw_pkg")

    result = backend.run(_task(WorkerRole.IMPLEMENT), goal, session, _clawwork_limits(tmp_path, "plan"))

    assert result.exit_code == 0
    assert captured["model_flag"] == expect_model


def test_clawwork_backend_translates_dynamic_package_via_live_catalog(tmp_path, monkeypatch):
    """动态套餐（不在静态 core/plus/max 里）也能正确翻成它的 catalog group slug：
    选 `pro` → 执行发 `superclaw-pro`（顾问对抗项 #3：动态 group_slug 须进执行链）。"""
    from superclaw.backends import ClawWorkBackend
    import superclaw.relay_packages as rp

    monkeypatch.setattr(
        rp, "relay_packages",
        lambda: {
            "packages": [{"id": "pro", "name": "Pro", "tier": "pro", "group_slug": "superclaw-pro"}],
            "source": "catalog",
            "available": True,
        },
    )
    captured = {}

    def fake_rpc(command_obj, *, executable, command, env, cwd, budget_seconds, cancel_check):
        captured["model_flag"] = "--model" in command and command[command.index("--model") + 1]
        return {"exit_code": 0, "output": "ok"}

    monkeypatch.setenv("SUPERCLAW_CLAWWORK_MODEL", "pro")
    backend = ClawWorkBackend(rpc_fn=fake_rpc)
    goal = GoalSpec(title="Ship", description="Use ClawWork")
    session = RunSession(goal_id=goal.goal_id, run_id="run_cw_dyn")

    result = backend.run(_task(WorkerRole.IMPLEMENT), goal, session, _clawwork_limits(tmp_path, "plan"))

    assert result.exit_code == 0
    assert captured["model_flag"] == "superclaw-pro"


def test_clawwork_backend_refuses_ungoverned_run(tmp_path, monkeypatch):
    from superclaw.backends import ClawWorkBackend

    # real path (no rpc_fn injected) with NO governance ext available -> fail-closed.
    # Unset the env override AND neutralize the bundled-harness default, so the
    # resolver finds nothing — the genuine ungoverned condition the gate guards
    # (the vendored third_party/clawwork ext would otherwise satisfy it).
    monkeypatch.setenv("SUPERCLAW_CLAWWORK_EXECUTABLE", str(_fake_executable(tmp_path, "clawwork")))
    monkeypatch.delenv("SUPERCLAW_CLAWWORK_GOVERNANCE_EXT", raising=False)
    monkeypatch.setattr("superclaw.backends._bundled_clawwork_home", lambda: None)
    backend = ClawWorkBackend()
    goal = GoalSpec(title="Ship", description="ungoverned guard")
    session = RunSession(goal_id=goal.goal_id, run_id="run_cw_ungov")

    result = backend.run(_task(), goal, session, _clawwork_limits(tmp_path))

    assert result.exit_code == 126
    assert "CLAWWORK_UNGOVERNED" in result.output


def test_clawwork_backend_defaults_to_bundled_harness(tmp_path, monkeypatch):
    # With no env wiring, the backend resolves BOTH the executable and the
    # mandatory governance ext from the vendored third_party/clawwork harness.
    from superclaw import backends as _backends
    from superclaw.backends import ClawWorkBackend

    home = tmp_path / "third_party" / "clawwork"
    cli = home / "packages" / "coding-agent" / "dist" / "cli.js"
    cli.parent.mkdir(parents=True)
    cli.write_text("#!/usr/bin/env node\n")
    cli.chmod(0o755)
    ext = home / "extensions" / "superclaw-governance.ts"
    ext.parent.mkdir(parents=True)
    ext.write_text("export default function () {}\n")

    monkeypatch.delenv("SUPERCLAW_CLAWWORK_EXECUTABLE", raising=False)
    monkeypatch.delenv("SUPERCLAW_CLAWWORK_GOVERNANCE_EXT", raising=False)
    monkeypatch.setattr(_backends, "_bundled_clawwork_home", lambda: home)
    monkeypatch.setattr(_backends.shutil, "which", lambda _name, path=None: None)

    backend = ClawWorkBackend()
    # build output dist/cli.js is the reliable executable (not the bin symlink)
    assert backend._resolve_executable() == str(cli)
    assert backend._resolve_governance_ext() == str(ext)


def test_clawwork_resolve_executable_rejects_unrunnable_bundled_bin(tmp_path, monkeypatch):
    # exists() alone lies: a non-executable file or a broken symlink must NOT
    # resolve as the bundled executable (else availability says runnable and
    # run() blows up at spawn).
    from superclaw import backends as _backends
    from superclaw.backends import ClawWorkBackend

    home = tmp_path / "third_party" / "clawwork"
    distdir = home / "packages" / "coding-agent" / "dist"
    distdir.mkdir(parents=True)
    monkeypatch.delenv("SUPERCLAW_CLAWWORK_EXECUTABLE", raising=False)
    monkeypatch.setattr(_backends, "_bundled_clawwork_home", lambda: home)
    monkeypatch.setattr(_backends.shutil, "which", lambda _n, path=None: None)

    cli = distdir / "cli.js"
    cli.write_text("#!/usr/bin/env node\n")
    cli.chmod(0o644)  # present but not executable
    assert ClawWorkBackend()._resolve_executable() is None

    cli.unlink()
    cli.symlink_to(home / "does-not-exist")  # dangling symlink
    assert ClawWorkBackend()._resolve_executable() is None


def _make_frozen_bundle(tmp_path, monkeypatch, *, binary=True, ext=True, runnable=True):
    """Build a fake frozen desktop bundle and point sys.frozen/sys.executable at it.

    Layout mirrors prepare-macos-bundle.mjs: the self-contained ClawWork
    (binary + governance extension) ships in a ``clawwork/`` dir next to the
    frozen backend executable. Returns (clawwork_dir, binary_path, ext_path)."""
    from superclaw import backends as _backends

    bundle = tmp_path / "Resources" / "backend" / "superclaw-backend"
    bundle.mkdir(parents=True)
    backend_exe = bundle / "superclaw-backend"
    backend_exe.write_text("")  # the frozen backend; sys.executable points here
    clawwork_dir = bundle / "clawwork"
    clawwork_dir.mkdir()
    binary_path = clawwork_dir / "clawwork"
    if binary:
        binary_path.write_text("#!/bin/sh\necho 0.79.1\n")
        binary_path.chmod(0o755 if runnable else 0o644)
    ext_path = clawwork_dir / "extensions" / "superclaw-governance.ts"
    if ext:
        ext_path.parent.mkdir(parents=True)
        ext_path.write_text("export default function () {}\n")
    monkeypatch.setattr(_backends.sys, "frozen", True, raising=False)
    monkeypatch.setattr(_backends.sys, "executable", str(backend_exe))
    monkeypatch.delenv("SUPERCLAW_CLAWWORK_EXECUTABLE", raising=False)
    monkeypatch.delenv("SUPERCLAW_CLAWWORK_GOVERNANCE_EXT", raising=False)
    monkeypatch.setattr(_backends.shutil, "which", lambda _n, path=None: None)
    # Isolate from any real source checkout the test host may sit in.
    monkeypatch.setattr(_backends, "_bundled_clawwork_home", lambda: None)
    return clawwork_dir, binary_path, ext_path


def test_clawwork_frozen_bundle_resolves_binary_and_governance(tmp_path, monkeypatch):
    # In a packaged desktop app (sys.frozen) the backend resolves the bundled
    # ClawWork binary + the mandatory governance extension shipped next to it —
    # no source tree, no env wiring. This is what makes clawwork work out of the
    # box when the user just opens the app.
    from superclaw.backends import ClawWorkBackend

    clawwork_dir, binary_path, ext_path = _make_frozen_bundle(tmp_path, monkeypatch)
    backend = ClawWorkBackend()
    assert backend._resolve_executable() == str(binary_path)
    assert backend._resolve_governance_ext() == str(ext_path)


def test_clawwork_frozen_dir_ignored_when_not_frozen(tmp_path, monkeypatch):
    # The same on-disk layout must NOT resolve from a source checkout: the frozen
    # branch is gated on sys.frozen (the bundle's tamper-proof marker), so a
    # stray clawwork/ dir near a dev tree never shadows the source resolution.
    from superclaw import backends as _backends

    clawwork_dir, binary_path, _ext = _make_frozen_bundle(tmp_path, monkeypatch)
    monkeypatch.setattr(_backends.sys, "frozen", False, raising=False)
    assert _backends._frozen_clawwork_dir() is None
    # _bundled_clawwork_home is stubbed to None, so with no source tree + no env
    # the executable is unresolved (never the frozen binary).
    assert _backends.ClawWorkBackend()._resolve_executable() is None


def test_clawwork_frozen_fail_closed_on_missing_governance_ext(tmp_path, monkeypatch):
    # A half-shipped bundle (binary present, governance extension absent) must
    # NEVER resolve — running ClawWork without the mandatory governance extension
    # would be UNGOVERNED. _frozen_clawwork_dir returns None, so the binary is not
    # offered either and the whole backend fails closed.
    from superclaw import backends as _backends

    _make_frozen_bundle(tmp_path, monkeypatch, ext=False)
    assert _backends._frozen_clawwork_dir() is None
    assert _backends.ClawWorkBackend()._resolve_executable() is None


def test_clawwork_frozen_invalid_bundle_never_falls_back_to_path(tmp_path, monkeypatch):
    # CRITICAL (round-2): a half-shipped bundle inside a FROZEN app must not fall
    # back to an ambient PATH `clawwork`. Even with a stray PATH binary present,
    # an invalid bundle (missing governance ext) leaves the backend UNAVAILABLE —
    # a packaged app uses its own bundled binary+extension pair or nothing.
    from superclaw import backends as _backends
    from superclaw.backends import ClawWorkBackend

    _make_frozen_bundle(tmp_path, monkeypatch, ext=False)
    stray = _fake_executable(tmp_path, "stray-clawwork-on-path")
    monkeypatch.setattr(_backends.shutil, "which", lambda _n, path=None: str(stray))
    # Neither the binary nor the governance ext resolves — fail closed, no PATH.
    assert ClawWorkBackend()._resolve_executable() is None
    assert ClawWorkBackend()._resolve_governance_ext() == ""


def test_clawwork_frozen_rejects_unrunnable_binary(tmp_path, monkeypatch):
    # A present-but-non-executable binary is not a runnable bundle (exists() lies);
    # fail closed rather than report available then blow up at spawn.
    from superclaw import backends as _backends

    _make_frozen_bundle(tmp_path, monkeypatch, runnable=False)
    assert _backends._frozen_clawwork_dir() is None


def test_clawwork_frozen_bundle_wins_over_path_lookup(tmp_path, monkeypatch):
    # CRITICAL: in a frozen app the bundled binary MUST win over a stray
    # `clawwork` on the user's PATH. Otherwise a PATH binary of a different
    # version paired with the bundled governance extension is a mixed/forged pair
    # (or a wholly unrelated program of the same name). shutil.which must be
    # consulted only AFTER the frozen bundle.
    from superclaw import backends as _backends
    from superclaw.backends import ClawWorkBackend

    _clawwork_dir, binary_path, _ext = _make_frozen_bundle(tmp_path, monkeypatch)
    stray = _fake_executable(tmp_path, "stray-clawwork-on-path")
    monkeypatch.setattr(_backends.shutil, "which", lambda _n, path=None: str(stray))
    # The bundled binary wins — never the PATH hit.
    assert ClawWorkBackend()._resolve_executable() == str(binary_path)


def test_clawwork_env_override_wins_over_frozen_bundle(tmp_path, monkeypatch):
    # An explicit SUPERCLAW_CLAWWORK_EXECUTABLE still wins inside a frozen app
    # (operator/test override), exactly as for the source-tree resolution.
    from superclaw.backends import ClawWorkBackend

    _make_frozen_bundle(tmp_path, monkeypatch)
    override = _fake_executable(tmp_path, "clawwork-override")
    monkeypatch.setenv("SUPERCLAW_CLAWWORK_EXECUTABLE", str(override))
    assert ClawWorkBackend()._resolve_executable() == str(override)


def test_clawwork_available_fails_closed_when_executable_not_runnable(tmp_path, monkeypatch):
    # A path that exists()+X_OK can still front a broken build / wrong shebang.
    # available() must probe --version and fail-closed on a non-zero exit.
    from superclaw.backends import ClawWorkBackend

    exe = tmp_path / "clawwork"
    exe.write_text("#!/bin/sh\nexit 3\n")  # runs, but --version exits non-zero
    exe.chmod(0o755)
    gov = tmp_path / "gov.ts"
    gov.write_text("export default function () {}\n")
    monkeypatch.setenv("SUPERCLAW_CLAWWORK_EXECUTABLE", str(exe))
    monkeypatch.setenv("SUPERCLAW_CLAWWORK_GOVERNANCE_EXT", str(gov))
    monkeypatch.setenv("SUPERCLAW_RELAY_BASE_URL", "http://127.0.0.1:9")
    monkeypatch.setattr("superclaw.relay_key.resolve_relay_api_key", lambda: ("k", "env"))

    avail = ClawWorkBackend().available()
    assert avail.available is False
    assert "not runnable" in (avail.reason or "")


def test_clawwork_available_refuses_ungoverned(tmp_path, monkeypatch):
    # Parity with run(): availability ALSO fail-closes when no governance ext is
    # resolvable (env unset AND no bundled), before the relay/version gates.
    from superclaw import backends as _backends
    from superclaw.backends import ClawWorkBackend

    exe = tmp_path / "clawwork"
    exe.write_text("#!/bin/sh\necho 0.79.1\n")
    exe.chmod(0o755)
    monkeypatch.setenv("SUPERCLAW_CLAWWORK_EXECUTABLE", str(exe))
    monkeypatch.delenv("SUPERCLAW_CLAWWORK_GOVERNANCE_EXT", raising=False)
    monkeypatch.setattr(_backends, "_bundled_clawwork_home", lambda: None)

    avail = ClawWorkBackend().available()
    assert avail.available is False
    assert "ungoverned" in (avail.reason or "").lower()


def test_clawwork_backend_fails_closed_on_plugin_policy(tmp_path):
    from superclaw.backends import ClawWorkBackend
    from superclaw.runtime import PermissionPolicy

    backend = ClawWorkBackend(rpc_fn=lambda *a, **k: (_ for _ in ()).throw(AssertionError("must not spawn")))
    goal = GoalSpec(title="Ship", description="plugin policy guard")
    session = RunSession(goal_id=goal.goal_id, run_id="run_cw_plugin")
    limits = WorkerLimits(
        repo_path=tmp_path, artifact_dir=tmp_path / "artifacts", budget_seconds=10,
        permission_policy=PermissionPolicy(mode="plan", plugin_dirs=[str(tmp_path / "p")]),
    )

    result = backend.run(_task(), goal, session, limits)
    assert result.exit_code == 1
    assert "PLUGIN_RUNTIME_CONFIG_INVALID" in result.output


def test_clawwork_backend_cancel_before_start(tmp_path):
    from superclaw.backends import ClawWorkBackend

    backend = ClawWorkBackend(rpc_fn=lambda *a, **k: (_ for _ in ()).throw(AssertionError("must not spawn")))
    goal = GoalSpec(title="Ship", description="cancel guard")
    session = RunSession(goal_id=goal.goal_id, run_id="run_cw_cancel")
    limits = WorkerLimits(
        repo_path=tmp_path, artifact_dir=tmp_path / "artifacts", budget_seconds=10,
        cancel_check=lambda: True,
    )
    result = backend.run(_task(), goal, session, limits)
    assert result.exit_code == 130
    assert result.cancelled is True


def test_clawwork_backend_surfaces_governance_block(tmp_path):
    from superclaw.backends import ClawWorkBackend

    def fake_rpc(command_obj, *, executable, command, env, cwd, budget_seconds, cancel_check):
        return {"exit_code": 0, "output": "a tool call was blocked by SuperClaw governance"}

    backend = ClawWorkBackend(rpc_fn=fake_rpc)
    goal = GoalSpec(title="Ship", description="governance surface")
    session = RunSession(goal_id=goal.goal_id, run_id="run_cw_block")
    result = backend.run(_task(), goal, session, _clawwork_limits(tmp_path, "plan"))
    assert result.exit_code == 0
    assert "blocked by SuperClaw governance" in result.output


def test_clawwork_backend_is_registered_and_experimental():
    from superclaw.backends import ClawWorkBackend, default_backends
    from superclaw.ui_contracts import build_agent_inventory, AGENT_CONTROL_SPECS

    assert isinstance(default_backends()["clawwork"], ClawWorkBackend)
    assert AGENT_CONTROL_SPECS["clawwork"]["maturity"] == "experimental"
    inventory = {a["name"]: a for a in build_agent_inventory()}
    assert inventory["clawwork"]["maturity"] == "experimental"
    # a configured-but-mature backend stays stable
    assert inventory["claude"]["maturity"] == "stable"


def test_clawwork_backend_drives_readonly_tool_allowlist_in_plan_mode(tmp_path):
    from superclaw.backends import ClawWorkBackend

    captured = {}

    def fake_rpc(command_obj, *, executable, command, env, cwd, budget_seconds, cancel_check):
        captured["command"] = command
        return {"exit_code": 0, "output": "ok"}

    backend = ClawWorkBackend(rpc_fn=fake_rpc)
    goal = GoalSpec(title="Ship", description="plan tools")
    session = RunSession(goal_id=goal.goal_id, run_id="run_cw_tools")
    backend.run(_task(), goal, session, _clawwork_limits(tmp_path, "plan"))

    cmd = captured["command"]
    assert "--tools" in cmd
    assert cmd[cmd.index("--tools") + 1] == "read,grep,find,ls"


def test_clawwork_backend_posture_drives_tool_allowlist(tmp_path):
    """Headless RPC can never ASK, so every would-ask posture projects onto a
    hard --tools bound (fail-closed): default/unknown -> read-only,
    acceptEdits/auto -> no bash, only bypassPermissions/dontAsk -> unrestricted."""
    from superclaw.backends import ClawWorkBackend

    captured = {}

    def fake_rpc(command_obj, *, executable, command, env, cwd, budget_seconds, cancel_check):
        captured["command"] = command
        return {"exit_code": 0, "output": "ok"}

    def tools_for(mode):
        backend = ClawWorkBackend(rpc_fn=fake_rpc)
        goal = GoalSpec(title="Ship", description="posture tools")
        session = RunSession(goal_id=goal.goal_id, run_id=f"run_cw_{mode}tools")
        backend.run(_task(), goal, session, _clawwork_limits(tmp_path, mode))
        cmd = captured["command"]
        return cmd[cmd.index("--tools") + 1] if "--tools" in cmd else None

    # default would ask for everything -> read-only hard bound
    assert tools_for("default") == "read,grep,find,ls"
    # acceptEdits/auto pre-accept edits but commands would still ask -> no bash
    assert tools_for("acceptEdits") == "read,grep,find,ls,write,edit"
    assert tools_for("auto") == "read,grep,find,ls,write,edit"
    # only the never-ask postures lift the CLI-layer restriction
    assert tools_for("bypassPermissions") is None
    assert tools_for("dontAsk") is None


def test_clawwork_backend_readonly_tools_when_policy_is_none(tmp_path):
    """The CLI folds an all-default PermissionPolicy() to None and the
    orchestrator passes it through — that IS the default posture, so the
    --tools hard gate must still be the read-only bound (fail-closed)."""
    from superclaw.backends import ClawWorkBackend

    captured = {}

    def fake_rpc(command_obj, *, executable, command, env, cwd, budget_seconds, cancel_check):
        captured["command"] = command
        return {"exit_code": 0, "output": "ok"}

    backend = ClawWorkBackend(rpc_fn=fake_rpc)
    goal = GoalSpec(title="Ship", description="no policy")
    session = RunSession(goal_id=goal.goal_id, run_id="run_cw_nopolicy")
    limits = WorkerLimits(
        repo_path=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        budget_seconds=10,
    )
    assert limits.permission_policy is None
    backend.run(_task(), goal, session, limits)

    cmd = captured["command"]
    assert "--tools" in cmd
    assert cmd[cmd.index("--tools") + 1] == "read,grep,find,ls"


def test_clawwork_backend_explicit_allowlist_is_exhaustive(tmp_path):
    from superclaw.backends import ClawWorkBackend
    from superclaw.runtime import PermissionPolicy

    captured = {}

    def fake_rpc(command_obj, *, executable, command, env, cwd, budget_seconds, cancel_check):
        captured["command"] = command
        return {"exit_code": 0, "output": "ok"}

    backend = ClawWorkBackend(rpc_fn=fake_rpc)
    goal = GoalSpec(title="Ship", description="explicit tools")
    session = RunSession(goal_id=goal.goal_id, run_id="run_cw_explicit")
    limits = WorkerLimits(
        repo_path=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        budget_seconds=10,
        permission_policy=PermissionPolicy(mode="acceptEdits", allowed_tools=["bash", "read"]),
    )
    backend.run(_task(), goal, session, limits)

    cmd = captured["command"]
    # an explicit allowlist is the pre-approved exhaustive set, as-is
    assert cmd[cmd.index("--tools") + 1] == "bash,read"


def test_clawwork_backend_passes_ready_file_env(tmp_path):
    from superclaw.backends import ClawWorkBackend

    captured = {}

    def fake_rpc(command_obj, *, executable, command, env, cwd, budget_seconds, cancel_check):
        captured["ready"] = env.get("SUPERCLAW_GOVERNANCE_READY_FILE")
        captured["nonce"] = env.get("SUPERCLAW_GOVERNANCE_NONCE")
        captured["agent_dir"] = env.get("CLAWWORK_CODING_AGENT_DIR")
        captured["stale_still_there"] = os.path.exists(env.get("SUPERCLAW_GOVERNANCE_READY_FILE", ""))
        return {"exit_code": 0, "output": "ok"}

    backend = ClawWorkBackend(rpc_fn=fake_rpc)
    goal = GoalSpec(title="Ship", description="ready env")
    session = RunSession(goal_id=goal.goal_id, run_id="run_cw_ready")
    backend.run(_task(), goal, session, _clawwork_limits(tmp_path))

    ready = captured["ready"]
    nonce = captured["nonce"]
    assert ready and "clawwork-governance-ready-run_cw_ready" in ready
    assert nonce  # per-spawn nonce issued to the extension
    # the nonce is ALSO in the path so concurrent attempts can never collide on
    # one ready file (path uniqueness, not just content validation)
    assert ready.endswith(nonce), (ready, nonce)
    # the fresh per-spawn path does not pre-exist (it is unlinked before spawn)
    assert captured["stale_still_there"] is False
    assert captured["agent_dir"] and captured["agent_dir"].endswith("clawwork-agent")


def test_clawwork_spawn_rpc_rejects_stale_ready_file(tmp_path):
    """A pre-existing ready file with a foreign nonce must NOT satisfy the
    handshake — _spawn_rpc validates content, not existence (fail-closed)."""
    import json as _json
    import sys as _sys

    from superclaw.backends import ClawWorkBackend

    ready = tmp_path / "ready.json"
    ready.write_text(
        _json.dumps({"active": True, "handler_registered": True, "nonce": "stale-nonce"}),
        encoding="utf-8",
    )
    script = tmp_path / "fake_clawwork.py"
    script.write_text("import time\ntime.sleep(30)\n", encoding="utf-8")

    env = dict(os.environ)
    env["SUPERCLAW_GOVERNANCE_READY_FILE"] = str(ready)
    env["SUPERCLAW_GOVERNANCE_NONCE"] = "fresh-nonce"
    result = ClawWorkBackend()._spawn_rpc(
        {"type": "prompt", "message": "hi"},
        executable=_sys.executable,
        command=[_sys.executable, str(script)],
        env=env,
        cwd=str(tmp_path),
        budget_seconds=2.0,
        cancel_check=None,
    )

    assert result.get("ungoverned") is True
    assert "CLAWWORK_UNGOVERNED" in result.get("output", "")


def test_clawwork_spawn_rpc_accepts_matching_nonce_and_maps_agent_end(tmp_path):
    """The full real-subprocess path: extension-equivalent ready file with THIS
    spawn's nonce satisfies the handshake, the prompt goes out, and agent_end
    text is mapped back."""
    import sys as _sys
    import textwrap

    from superclaw.backends import ClawWorkBackend

    script = tmp_path / "fake_clawwork.py"
    script.write_text(
        textwrap.dedent(
            """
            import json, os, sys, time
            with open(os.environ["SUPERCLAW_GOVERNANCE_READY_FILE"], "w") as f:
                json.dump({"handler_registered": True,
                           "nonce": os.environ.get("SUPERCLAW_GOVERNANCE_NONCE")}, f)
            sys.stdin.readline()
            print(json.dumps({"type": "agent_end", "messages": [
                {"content": [{"type": "text", "text": "hello from fake clawwork"}]}
            ]}), flush=True)
            time.sleep(10)
            """
        ),
        encoding="utf-8",
    )

    env = dict(os.environ)
    env["SUPERCLAW_GOVERNANCE_READY_FILE"] = str(tmp_path / "ready.json")
    env["SUPERCLAW_GOVERNANCE_NONCE"] = "fresh-nonce"
    result = ClawWorkBackend()._spawn_rpc(
        {"type": "prompt", "message": "hi"},
        executable=_sys.executable,
        command=[_sys.executable, str(script)],
        env=env,
        cwd=str(tmp_path),
        budget_seconds=10.0,
        cancel_check=None,
    )

    assert result.get("exit_code") == 0
    assert "hello from fake clawwork" in result.get("output", "")
    assert not result.get("governance_blocked")


def test_clawwork_spawn_rpc_model_error_stop_reason_fails_closed(tmp_path):
    """A failed relay/model call (provider 401/403/5xx) surfaces as the terminal
    assistant message ending with stopReason == "error" and empty content, even
    though ClawWork exits 0. _spawn_rpc must NOT report success — it returns
    model_error so run() fails closed (the fake-success this guards against:
    a turn the model never answered being marked completed)."""
    import sys as _sys
    import textwrap

    from superclaw.backends import ClawWorkBackend

    script = tmp_path / "fake_clawwork.py"
    script.write_text(
        textwrap.dedent(
            """
            import json, os, sys, time
            with open(os.environ["SUPERCLAW_GOVERNANCE_READY_FILE"], "w") as f:
                json.dump({"handler_registered": True,
                           "nonce": os.environ.get("SUPERCLAW_GOVERNANCE_NONCE")}, f)
            sys.stdin.readline()
            # Mirror ClawWork's real shape on a relay 403: the terminal assistant
            # message has empty content + stopReason "error" + zero tokens.
            print(json.dumps({"type": "agent_end", "messages": [
                {"role": "user", "content": [{"type": "text", "text": "hi"}]},
                {"role": "assistant", "content": [], "stopReason": "error",
                 "usage": {"totalTokens": 0}},
            ]}), flush=True)
            time.sleep(10)
            """
        ),
        encoding="utf-8",
    )

    env = dict(os.environ)
    env["SUPERCLAW_GOVERNANCE_READY_FILE"] = str(tmp_path / "ready.json")
    env["SUPERCLAW_GOVERNANCE_NONCE"] = "fresh-nonce"
    result = ClawWorkBackend()._spawn_rpc(
        {"type": "prompt", "message": "hi"},
        executable=_sys.executable,
        command=[_sys.executable, str(script)],
        env=env,
        cwd=str(tmp_path),
        budget_seconds=10.0,
        cancel_check=None,
    )

    assert result.get("model_error") is True
    assert result.get("exit_code") != 0
    assert "CLAWWORK_MODEL_ERROR" in result.get("output", "")


def test_clawwork_spawn_rpc_succeeds_when_stop_reason_is_not_error(tmp_path):
    """Guard against over-triggering: a normal terminal stop (end_turn) with real
    text is still a successful turn — the model_error path keys ONLY on
    stopReason == "error", never on empty text or other stop reasons."""
    import sys as _sys
    import textwrap

    from superclaw.backends import ClawWorkBackend

    script = tmp_path / "fake_clawwork.py"
    script.write_text(
        textwrap.dedent(
            """
            import json, os, sys, time
            with open(os.environ["SUPERCLAW_GOVERNANCE_READY_FILE"], "w") as f:
                json.dump({"handler_registered": True,
                           "nonce": os.environ.get("SUPERCLAW_GOVERNANCE_NONCE")}, f)
            sys.stdin.readline()
            print(json.dumps({"type": "agent_end", "messages": [
                {"role": "user", "content": [{"type": "text", "text": "hi"}]},
                {"role": "assistant", "content": [{"type": "text", "text": "PONG"}],
                 "stopReason": "end_turn", "usage": {"totalTokens": 42}},
            ]}), flush=True)
            time.sleep(10)
            """
        ),
        encoding="utf-8",
    )

    env = dict(os.environ)
    env["SUPERCLAW_GOVERNANCE_READY_FILE"] = str(tmp_path / "ready.json")
    env["SUPERCLAW_GOVERNANCE_NONCE"] = "fresh-nonce"
    result = ClawWorkBackend()._spawn_rpc(
        {"type": "prompt", "message": "hi"},
        executable=_sys.executable,
        command=[_sys.executable, str(script)],
        env=env,
        cwd=str(tmp_path),
        budget_seconds=10.0,
        cancel_check=None,
    )

    assert not result.get("model_error")
    assert result.get("exit_code") == 0
    assert "PONG" in result.get("output", "")


def test_clawwork_spawn_rpc_handshake_timeout_surfaces_stderr(tmp_path):
    """When the `-e` governance load fails, ClawWork keeps running but never
    writes the ready file; the handshake times out. The child's stderr (where
    the load stack trace lands) must ride into the ungoverned message — it is
    the only breadcrumb for WHY governance never came up."""
    import sys as _sys
    import textwrap

    from superclaw.backends import ClawWorkBackend

    script = tmp_path / "fake_clawwork.py"
    script.write_text(
        textwrap.dedent(
            """
            import sys, time
            sys.stderr.write("SyntaxError: governance extension failed to load\\n")
            sys.stderr.flush()
            time.sleep(30)  # stays alive, never writes the ready file
            """
        ),
        encoding="utf-8",
    )

    env = dict(os.environ)
    env["SUPERCLAW_GOVERNANCE_READY_FILE"] = str(tmp_path / "ready.json")
    env["SUPERCLAW_GOVERNANCE_NONCE"] = "nonce"
    result = ClawWorkBackend()._spawn_rpc(
        {"type": "prompt", "message": "hi"},
        executable=_sys.executable,
        command=[_sys.executable, str(script)],
        env=env,
        cwd=str(tmp_path),
        budget_seconds=2.0,
        cancel_check=None,
    )

    assert result.get("ungoverned") is True
    assert "CLAWWORK_UNGOVERNED" in result.get("output", "")
    assert "governance extension failed to load" in result.get("output", "")


def test_clawwork_backend_ungoverned_handshake_failure_is_126(tmp_path):
    from superclaw.backends import ClawWorkBackend

    def fake_rpc(command_obj, *, executable, command, env, cwd, budget_seconds, cancel_check):
        return {"ungoverned": True, "output": "CLAWWORK_UNGOVERNED: governance extension did not signal ready"}

    backend = ClawWorkBackend(rpc_fn=fake_rpc)
    goal = GoalSpec(title="Ship", description="handshake fail")
    session = RunSession(goal_id=goal.goal_id, run_id="run_cw_hsfail")
    result = backend.run(_task(), goal, session, _clawwork_limits(tmp_path))

    assert result.exit_code == 126
    assert "CLAWWORK_UNGOVERNED" in result.output
    assert "status=completed" not in result.output


def test_clawwork_spawn_rpc_survives_stderr_flood(tmp_path):
    """A child that floods stderr past the OS pipe buffer (~64KB) must not
    dead-lock the run — _spawn_rpc drains stderr continuously."""
    import sys as _sys
    import textwrap

    from superclaw.backends import ClawWorkBackend

    script = tmp_path / "fake_clawwork.py"
    script.write_text(
        textwrap.dedent(
            """
            import json, os, sys, time
            with open(os.environ["SUPERCLAW_GOVERNANCE_READY_FILE"], "w") as f:
                json.dump({"handler_registered": True,
                           "nonce": os.environ.get("SUPERCLAW_GOVERNANCE_NONCE")}, f)
            sys.stdin.readline()
            for _ in range(200):  # ~200KB >> pipe buffer
                sys.stderr.write("noise " * 170 + "\\n")
            sys.stderr.flush()
            print(json.dumps({"type": "agent_end", "messages": [
                {"content": [{"type": "text", "text": "survived stderr flood"}]}
            ]}), flush=True)
            time.sleep(10)
            """
        ),
        encoding="utf-8",
    )

    import time as _time

    env = dict(os.environ)
    env["SUPERCLAW_GOVERNANCE_READY_FILE"] = str(tmp_path / "ready.json")
    env["SUPERCLAW_GOVERNANCE_NONCE"] = "flood-nonce"
    started = _time.monotonic()
    result = ClawWorkBackend()._spawn_rpc(
        {"type": "prompt", "message": "hi"},
        executable=_sys.executable,
        command=[_sys.executable, str(script)],
        env=env,
        cwd=str(tmp_path),
        budget_seconds=20.0,
        cancel_check=None,
    )

    assert result.get("exit_code") == 0
    assert "survived stderr flood" in result.get("output", "")
    # well under the budget: the old code dead-locked here until timeout
    assert _time.monotonic() - started < 15


def test_clawwork_spawn_rpc_fails_closed_without_nonce(tmp_path):
    """Fail-closed regression (Fix: nonce handshake): when NO nonce is issued
    (empty env), the handshake must never pass even with an otherwise-valid
    ready file — the run must end ungoverned, not proceed."""
    import sys as _sys

    from superclaw.backends import ClawWorkBackend

    # child writes a valid-looking ready file immediately, then stays alive
    script = tmp_path / "fake.py"
    script.write_text(
        "import json, os, time\n"
        "open(os.environ['SUPERCLAW_GOVERNANCE_READY_FILE'],'w').write("
        "json.dumps({'handler_registered': True, 'nonce': 'anything'}))\n"
        "time.sleep(30)\n",
        encoding="utf-8",
    )
    env = dict(os.environ)
    env["SUPERCLAW_GOVERNANCE_READY_FILE"] = str(tmp_path / "ready.json")
    env.pop("SUPERCLAW_GOVERNANCE_NONCE", None)  # NO nonce issued
    result = ClawWorkBackend()._spawn_rpc(
        {"type": "prompt", "message": "hi"},
        executable=_sys.executable, command=[_sys.executable, str(script)],
        env=env, cwd=str(tmp_path), budget_seconds=2.0, cancel_check=None,
    )
    assert result.get("ungoverned") is True, result
    assert "did not signal ready" in result.get("output", ""), result.get("output", "")[:200]


def test_clawwork_spawn_rpc_bounds_captured_stderr_tail(tmp_path):
    """The drain keeps only a bounded tail of stderr, not the whole stream.

    A blocking child (Python blocks on a full pipe) streams ~300KB to stderr and
    then exits WITHOUT agent_end, so _spawn_rpc surfaces the drained stderr on
    the process-end path. The drain collapses the retained buffer to a fixed
    ~32KB cap (``stderr_parts[:] = ["".join(stderr_parts)[-32768:]]``). This is
    the test that fails if the bounding is removed:
      * cap removed  -> output carries the full ~300KB (fails the upper bound);
      * drain removed -> output carries no stderr (fails the lower bound)."""
    import sys as _sys
    import textwrap

    from superclaw.backends import ClawWorkBackend

    script = tmp_path / "fake_clawwork.py"
    script.write_text(
        textwrap.dedent(
            """
            import json, os, sys
            with open(os.environ["SUPERCLAW_GOVERNANCE_READY_FILE"], "w") as f:
                json.dump({"handler_registered": True,
                           "nonce": os.environ.get("SUPERCLAW_GOVERNANCE_NONCE")}, f)
            sys.stdin.readline()
            chunk = "Y" * 1023 + "\\n"
            for _ in range(300):  # ~300KB, blocking writes past the ~64KB pipe
                sys.stderr.write(chunk)
            sys.stderr.flush()
            # exit WITHOUT agent_end -> _spawn_rpc takes the process-end path
            """
        ),
        encoding="utf-8",
    )

    env = dict(os.environ)
    env["SUPERCLAW_GOVERNANCE_READY_FILE"] = str(tmp_path / "ready.json")
    env["SUPERCLAW_GOVERNANCE_NONCE"] = "tail-nonce"
    result = ClawWorkBackend()._spawn_rpc(
        {"type": "prompt", "message": "hi"},
        executable=_sys.executable,
        command=[_sys.executable, str(script)],
        env=env,
        cwd=str(tmp_path),
        budget_seconds=20.0,
        cancel_check=None,
    )

    out = result.get("output", "")
    # drain ran (kept a tail) and bounded it to the fixed ~32KB cap, far below
    # the ~300KB written. The cap collapses to exactly the last 32768 chars
    # regardless of chunk size, so the tail sits just at the cap. Mutation guard:
    # remove the cap -> output carries the full ~300KB and the upper bound fails.
    assert "Y" in out, out[:200]
    assert 25_000 < len(out) < 45_000, f"stderr tail not bounded near 32KB: {len(out)} bytes"


def _fake_clawwork_script(tmp_path, body: str):
    """A stand-in clawwork child: writes the ready file with this spawn's nonce,
    waits for the prompt, then runs `body`."""
    import textwrap

    script = tmp_path / "fake_clawwork.py"
    script.write_text(
        textwrap.dedent(
            """
            import json, os, sys, time
            with open(os.environ["SUPERCLAW_GOVERNANCE_READY_FILE"], "w") as f:
                json.dump({"handler_registered": True,
                           "nonce": os.environ.get("SUPERCLAW_GOVERNANCE_NONCE")}, f)
            sys.stdin.readline()
            """
        ) + textwrap.dedent(body),
        encoding="utf-8",
    )
    return script


def test_clawwork_spawn_rpc_half_line_does_not_block(tmp_path):
    """Half-line regression (Fix: non-blocking stdout): a child that writes a
    partial JSON line (no newline) then hangs must NOT block the read loop past
    the budget — it must time out. With the old readline() this hung forever."""
    import sys as _sys
    import time as _time

    from superclaw.backends import ClawWorkBackend

    # emit an unterminated line (no "\n") then sleep — never completes a frame
    script = _fake_clawwork_script(
        tmp_path,
        '''
        sys.stdout.write('{"type":"agent_'); sys.stdout.flush()
        time.sleep(30)
        ''',
    )
    env = dict(os.environ)
    env["SUPERCLAW_GOVERNANCE_READY_FILE"] = str(tmp_path / "ready.json")
    env["SUPERCLAW_GOVERNANCE_NONCE"] = "half-nonce"
    started = _time.monotonic()
    result = ClawWorkBackend()._spawn_rpc(
        {"type": "prompt", "message": "hi"},
        executable=_sys.executable, command=[_sys.executable, str(script)],
        env=env, cwd=str(tmp_path), budget_seconds=2.0, cancel_check=None,
    )
    assert result.get("timed_out") is True, result
    assert _time.monotonic() - started < 6, "half-line blocked the read loop past budget"


def test_clawwork_spawn_rpc_ignores_governance_marker_in_nonerror_result(tmp_path):
    """False-positive regression (Fix: scoped governance marker): the marker in
    a NON-error tool result (a tool whose normal output mentions the string)
    must NOT be read as a governance block."""
    import sys as _sys

    from superclaw.backends import ClawWorkBackend

    script = _fake_clawwork_script(
        tmp_path,
        r'''
        print(json.dumps({"type": "tool_execution_end", "toolName": "bash",
            "isError": False, "result": "echo: SuperClaw governance: not a block"}), flush=True)
        print(json.dumps({"type": "agent_end", "messages": [
            {"content": [{"type": "text", "text": "done"}]}]}), flush=True)
        time.sleep(5)
        ''',
    )
    env = dict(os.environ)
    env["SUPERCLAW_GOVERNANCE_READY_FILE"] = str(tmp_path / "ready.json")
    env["SUPERCLAW_GOVERNANCE_NONCE"] = "marker-nonce"
    result = ClawWorkBackend()._spawn_rpc(
        {"type": "prompt", "message": "hi"},
        executable=_sys.executable, command=[_sys.executable, str(script)],
        env=env, cwd=str(tmp_path), budget_seconds=10.0, cancel_check=None,
    )
    assert result.get("exit_code") == 0, result
    assert not result.get("governance_blocked"), result  # marker in a non-error result is not a block


def test_clawwork_backend_governance_block_is_not_a_false_completed(tmp_path):
    from superclaw.backends import ClawWorkBackend

    def fake_rpc(command_obj, *, executable, command, env, cwd, budget_seconds, cancel_check):
        # agent_end mapped to exit 0 by the runner, but a tool was blocked
        return {"exit_code": 0, "output": "I could not run that tool", "governance_blocked": True}

    backend = ClawWorkBackend(rpc_fn=fake_rpc)
    goal = GoalSpec(title="Ship", description="block not completed")
    session = RunSession(goal_id=goal.goal_id, run_id="run_cw_blockexit")
    result = backend.run(_task(), goal, session, _clawwork_limits(tmp_path, "plan"))

    assert result.exit_code != 0  # never a false-positive success
    assert "CLAWWORK_GOVERNANCE_BLOCKED" in result.output
    assert "status=completed" not in result.output


def test_clawwork_backend_model_error_is_not_a_false_completed(tmp_path):
    # A failed relay/model call (provider 401/403/5xx) is reported by the RPC
    # layer as model_error. run() must surface a hard failure — never a completed
    # run — so the orchestrator can't treat a turn the model never answered as
    # done (the fake-success this guards against).
    from superclaw.backends import ClawWorkBackend

    def fake_rpc(command_obj, *, executable, command, env, cwd, budget_seconds, cancel_check):
        return {
            "exit_code": 1,
            "model_error": True,
            "output": "CLAWWORK_MODEL_ERROR: the relay/model call failed (stopReason=error); no completed assistant response",
        }

    backend = ClawWorkBackend(rpc_fn=fake_rpc)
    goal = GoalSpec(title="Ship", description="model error not completed")
    session = RunSession(goal_id=goal.goal_id, run_id="run_cw_modelerr")
    result = backend.run(_task(), goal, session, _clawwork_limits(tmp_path, "plan"))

    assert result.exit_code != 0  # never a false-positive success
    assert "CLAWWORK_MODEL_ERROR" in result.output
    assert "status=completed" not in result.output


def test_run_command_emits_batch_diagnostic_for_streaming_backend_fallback(tmp_path):
    # Display Protocol DL4: a STREAMING backend (claude, surfaces_live_tools=True)
    # whose stream yielded nothing parseable falls back to a subprocess via
    # run_command. That fallback IS batch, so run_command discloses it ONCE up
    # front (the orchestrator skips streaming backends, so there is no double).
    class _StreamingFallback(LocalShellBackend):
        name = "claude"
        surfaces_live_tools = True

    events: list[tuple[str, dict]] = []
    backend = _StreamingFallback()
    limits = WorkerLimits(
        repo_path=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        budget_seconds=10,
        event_sink=lambda etype, payload: events.append((etype, payload)),
    )
    backend.run_command(
        [sys.executable, "-c", "print('ok')"],
        task=_task(),
        goal=GoalSpec(title="Run", description="Execute"),
        session=RunSession(goal_id="goal_1", run_id="run_1"),
        limits=limits,
    )
    assert events, "expected the batch diagnostic to be emitted first"
    etype, envelope = events[0]
    assert etype == "adapter.diagnostic"
    assert envelope["capability_tier"] == "batch"
    assert envelope["payload"] == {
        "streaming": False,
        "tool_lifecycle": False,
        "reason": envelope["payload"]["reason"],
    }
    assert "claude" in envelope["payload"]["reason"]


def test_run_command_no_batch_diagnostic_for_non_streaming_backend(tmp_path):
    # A non-streaming backend (surfaces_live_tools=False) gets its diagnostic UP
    # FRONT from the delivery chokepoint (orchestrator) / chat path — run_command
    # must NOT re-emit, or the surface would show two diagnostics for one run.
    events: list[tuple[str, dict]] = []
    backend = LocalShellBackend()  # surfaces_live_tools = False
    limits = WorkerLimits(
        repo_path=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        budget_seconds=10,
        event_sink=lambda etype, payload: events.append((etype, payload)),
    )
    backend.run_command(
        [sys.executable, "-c", "print('ok')"],
        task=_task(),
        goal=GoalSpec(title="Run", description="Execute"),
        session=RunSession(goal_id="goal_1", run_id="run_1"),
        limits=limits,
    )
    assert all(etype != "adapter.diagnostic" for etype, _ in events)


def test_synthetic_result_is_display_silent(tmp_path):
    # DL4 timing: _synthetic_result runs AFTER the backend's (possibly long) work,
    # so it must NOT emit the batch diagnostic — that would land too late to
    # disclose "batch" during execution. The diagnostic is emitted UP FRONT by the
    # orchestrator / chat path instead. Guard that _synthetic_result stays silent
    # for a non-streaming backend (it used to emit here).
    events: list[tuple[str, dict]] = []
    backend = LocalShellBackend()  # surfaces_live_tools = False
    limits = WorkerLimits(
        repo_path=tmp_path,
        artifact_dir=tmp_path / "artifacts",
        budget_seconds=10,
        event_sink=lambda etype, payload: events.append((etype, payload)),
    )
    backend._synthetic_result(
        task=_task(),
        session=RunSession(goal_id="g", run_id="r"),
        limits=limits,
        command_repr="api call",
        output="hi",
        exit_code=0,
        started_at=1.0,
        finished_at=2.0,
        duration=1.0,
    )
    assert all(etype != "adapter.diagnostic" for etype, _ in events)


# --- Reasoning-effort / thinking-level selection (per-runtime adaptation) -------

def test_codex_exec_forwards_reasoning_effort_and_rejects_invalid(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_CODEX_MODE", "exec")
    monkeypatch.delenv("SUPERCLAW_CODEX_EFFORT", raising=False)
    goal = GoalSpec(title="Ship", description="Use codex effort")
    codex = CodexCliBackend(executable=str(_fake_executable(tmp_path, "codex")))

    ok = codex.run(
        _task(WorkerRole.PLAN), goal, RunSession(goal_id=goal.goal_id, run_id="run_cx_eff"),
        WorkerLimits(repo_path=tmp_path, artifact_dir=tmp_path / "a", budget_seconds=10, effort_override="xhigh"),
    )
    assert ok.exit_code == 0
    assert "-c model_reasoning_effort=xhigh" in ok.output

    bad = codex.run(
        _task(WorkerRole.PLAN), goal, RunSession(goal_id=goal.goal_id, run_id="run_cx_badeff"),
        WorkerLimits(repo_path=tmp_path, artifact_dir=tmp_path / "a", budget_seconds=10, effort_override="turbo"),
    )
    assert bad.exit_code == 1
    assert "EFFORT_INVALID" in bad.output
    assert "fake-agent" not in bad.output  # never spawned with a malformed -c


def test_codex_legacy_mode_fails_closed_on_explicit_effort(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_CODEX_MODE", "legacy")
    goal = GoalSpec(title="Ship", description="legacy + effort")
    codex = CodexCliBackend(executable=str(_fake_executable(tmp_path, "codex")))
    res = codex.run(
        _task(WorkerRole.PLAN), goal, RunSession(goal_id=goal.goal_id, run_id="run_cx_legacy_eff"),
        WorkerLimits(repo_path=tmp_path, artifact_dir=tmp_path / "a", budget_seconds=10, effort_override="high"),
    )
    assert res.exit_code == 1
    assert "EFFORT_OVERRIDE_UNSUPPORTED" in res.output


def test_claude_forwards_effort_and_rejects_invalid(tmp_path, monkeypatch):
    monkeypatch.delenv("SUPERCLAW_CLAUDE_EFFORT", raising=False)
    goal = GoalSpec(title="Ship", description="claude effort")
    claude = ClaudeCliBackend(executable=str(_fake_executable(tmp_path, "claude")))

    ok = claude.run(
        _task(WorkerRole.REVIEW), goal, RunSession(goal_id=goal.goal_id, run_id="run_cl_eff"),
        WorkerLimits(repo_path=tmp_path, artifact_dir=tmp_path / "a", budget_seconds=10, effort_override="max"),
    )
    assert ok.exit_code == 0
    assert "--effort max" in ok.output

    bad = claude.run(
        _task(WorkerRole.REVIEW), goal, RunSession(goal_id=goal.goal_id, run_id="run_cl_badeff"),
        WorkerLimits(repo_path=tmp_path, artifact_dir=tmp_path / "a", budget_seconds=10, effort_override="minimal"),
    )
    # claude has no "minimal" level (codex does) — per-runtime levels, not unified.
    assert bad.exit_code == 1
    assert "EFFORT_INVALID" in bad.output


def test_opencode_forwards_variant_from_effort_override(tmp_path, monkeypatch):
    monkeypatch.delenv("SUPERCLAW_OPENCODE_VARIANT", raising=False)
    goal = GoalSpec(title="Ship", description="opencode variant")
    oc = OpenCodeCliBackend(executable=str(_fake_executable(tmp_path, "opencode")))
    res = oc.run(
        _task(WorkerRole.PLAN), goal, RunSession(goal_id=goal.goal_id, run_id="run_oc_var"),
        WorkerLimits(repo_path=tmp_path, artifact_dir=tmp_path / "a", budget_seconds=10, effort_override="max"),
    )
    assert res.exit_code == 0
    assert "--variant max" in res.output
    # text mode: a value with inner whitespace is rejected (would split argv)
    bad = oc.run(
        _task(WorkerRole.PLAN), goal, RunSession(goal_id=goal.goal_id, run_id="run_oc_badvar"),
        WorkerLimits(repo_path=tmp_path, artifact_dir=tmp_path / "a", budget_seconds=10, effort_override="high effort"),
    )
    assert bad.exit_code == 1
    assert "EFFORT_INVALID" in bad.output


def test_unsupported_backends_hard_reject_explicit_effort(tmp_path):
    goal = GoalSpec(title="Ship", description="effort on a non-effort backend")
    limits = WorkerLimits(repo_path=tmp_path, artifact_dir=tmp_path / "a", budget_seconds=10, effort_override="high")
    for backend in (LocalShellBackend(), AnthropicApiBackend(), CursorCliBackend(executable=str(_fake_executable(tmp_path, "cursor-agent"))), HermesCliBackend(executable=str(_fake_executable(tmp_path, "hermes"))), GrokCliBackend(executable=str(_fake_executable(tmp_path, "grok")))):
        res = backend.run(_task(WorkerRole.PLAN), goal, RunSession(goal_id=goal.goal_id, run_id=f"run_{backend.name}_eff"), limits)
        assert res.exit_code == 1, backend.name
        assert "EFFORT_OVERRIDE_UNSUPPORTED" in res.output, backend.name


def test_resolve_effort_precedence(tmp_path, monkeypatch):
    from superclaw.backends import _resolve_effort

    base = WorkerLimits(repo_path=tmp_path, artifact_dir=tmp_path / "a", budget_seconds=10)
    monkeypatch.setenv("SUPERCLAW_X_EFFORT", "medium")
    assert _resolve_effort(base, "SUPERCLAW_X_EFFORT") == "medium"  # env fallback
    override = WorkerLimits(repo_path=tmp_path, artifact_dir=tmp_path / "a", budget_seconds=10, effort_override="high")
    assert _resolve_effort(override, "SUPERCLAW_X_EFFORT") == "high"  # override wins
    monkeypatch.delenv("SUPERCLAW_X_EFFORT", raising=False)
    assert _resolve_effort(base, "SUPERCLAW_X_EFFORT", default=None) is None  # nothing set


def test_backend_effort_support_matches_contract():
    """Drift guard: a backend's runtime-side supports_effort must agree with the
    AGENT_CONTROL_SPECS supports_effort_selection contract surfaces render from,
    and every select-mode runtime's EFFORT_LEVELS must equal its contract levels."""
    from superclaw.ui_contracts import AGENT_CONTROL_SPECS

    reg = default_backends()
    for name, backend in reg.items():
        spec = AGENT_CONTROL_SPECS.get(name, {})
        assert bool(getattr(backend, "supports_effort", False)) == bool(spec.get("supports_effort_selection", False)), name
    # select-mode runtimes expose their native levels verbatim
    # grok is intentionally absent: its CLI has an --effort flag but no Grok model
    # honors a reasoning-effort selection, so it is supports_effort=False (refused
    # fail-closed) and has no EFFORT_LEVELS — see GrokCliBackend.
    expected = {
        "codex": ("low", "medium", "high", "xhigh"),
        "codex-app-server": ("low", "medium", "high", "xhigh"),
        "claude": ("low", "medium", "high", "xhigh", "max"),
    }
    for name, levels in expected.items():
        assert tuple(AGENT_CONTROL_SPECS[name]["effort_levels"]) == levels, name
        assert tuple(reg[name].EFFORT_LEVELS) == levels, name
