"""B-class (in-process) posture + escalation-gate enforcement in
``_RealToolExecution._exec_tool``.

Postures (derived from the permission mode):
* read-only (mode=plan): refuse mutating tools outright.
* full (allow / bypassPermissions): execute freely.
* workspace (ask / default / acceptEdits / auto / unknown): shell and
  reserved-path writes require an approved single-use grant via the escalation
  gate (roadmap §8.2 hard gate #2). With no gate wired they fail closed; the old
  behavior of running shell freely under acceptEdits was fail-open and is gone.
"""

from __future__ import annotations

import time

import pytest

from superclaw.backends import WorkerLimits, _RealToolExecution
from superclaw.escalation import EscalationDenied, EscalationEnvelope, EscalationPending, make_permission_escalation
from superclaw.runtime import PermissionPolicy


def _limits(tmp_path, mode, *, gate=None):
    return WorkerLimits(
        repo_path=tmp_path,
        artifact_dir=tmp_path,
        permission_policy=PermissionPolicy.from_values(mode=mode),
        escalation_gate=gate,
    )


def _exec(tmp_path, mode, tool, args, *, gate=None):
    return _RealToolExecution()._exec_tool(tool, args, _limits(tmp_path, mode, gate=gate), time.monotonic() + 30)


# --- plan (read-only) posture: unchanged ----------------------------------


def test_plan_mode_denies_write_and_shell(tmp_path):
    assert _exec(tmp_path, "plan", "write_file", {"path": "a.txt", "content": "x"}).startswith("error: permission denied")
    assert _exec(tmp_path, "plan", "run_shell", {"command": "echo hi"}).startswith("error: permission denied")
    assert not (tmp_path / "a.txt").exists()


def test_plan_mode_allows_reads(tmp_path):
    (tmp_path / "f.txt").write_text("hello", encoding="utf-8")
    assert _exec(tmp_path, "plan", "read_file", {"path": "f.txt"}) == "hello"
    assert "f.txt" in _exec(tmp_path, "plan", "list_files", {"path": "."})


# --- workspace posture: ordinary writes unchanged, shell now gated ---------


def test_workspace_posture_ordinary_write_unchanged(tmp_path):
    # Writing a normal workspace file still works under every non-plan mode.
    for mode in ("default", "acceptEdits", "auto", "bypassPermissions"):
        out = _exec(tmp_path, mode, "write_file", {"path": f"{mode}.txt", "content": "y"})
        assert out.startswith("wrote ")
        assert (tmp_path / f"{mode}.txt").read_text(encoding="utf-8") == "y"


def test_workspace_posture_shell_fails_closed_without_channel(tmp_path):
    # No gate wired (no approval channel) ⇒ shell is denied fail-closed, NOT run.
    out = _exec(tmp_path, "acceptEdits", "run_shell", {"command": "echo ok"})
    assert out.startswith("error: permission denied")
    assert "no approval channel" in out


def test_full_posture_runs_shell_freely(tmp_path):
    # allow / bypassPermissions = full posture: shell executes with no gate.
    assert "exit_code=0" in _exec(tmp_path, "bypassPermissions", "run_shell", {"command": "echo ok"})


def test_workspace_posture_shell_runs_when_gate_grants(tmp_path):
    # A gate that returns (a grant was consumed) lets the shell run.
    calls = []

    def gate(tool_name, args, reserved_path):
        calls.append((tool_name, args.get("command"), reserved_path))
        return None  # grant consumed → proceed

    out = _exec(tmp_path, "acceptEdits", "run_shell", {"command": "echo ok"}, gate=gate)
    assert "exit_code=0" in out
    assert calls == [("run_shell", "echo ok", None)]


def test_workspace_posture_shell_denied_returns_denial_not_suspend(tmp_path):
    # A sticky human deny surfaces as EscalationDenied from the gate; _exec_tool turns
    # it into a fail-closed denial string (the action is refused) WITHOUT propagating
    # (no re-suspend). This is distinct from EscalationPending.
    env = make_permission_escalation(
        tool_name="run_shell", args={"command": "echo ok"}, prompt_text="x", principal="local_user", run_id="r"
    )

    def gate(tool_name, args, reserved_path):
        raise EscalationDenied(env)

    out = _exec(tmp_path, "acceptEdits", "run_shell", {"command": "echo ok"}, gate=gate)
    assert out.startswith("error: permission denied")
    assert "denied by a human" in out


def test_workspace_posture_shell_escalation_propagates(tmp_path):
    # A gate that raises EscalationPending must propagate out of _exec_tool (so the
    # orchestrator can suspend) — it must NOT be swallowed into an error string.
    env = make_permission_escalation(
        tool_name="run_shell", args={"command": "echo ok"}, prompt_text="x", principal="local_user", run_id="r"
    )

    def gate(tool_name, args, reserved_path):
        raise EscalationPending(env)

    with pytest.raises(EscalationPending):
        _exec(tmp_path, "acceptEdits", "run_shell", {"command": "echo ok"}, gate=gate)


# --- reserved-path writes escalate even under workspace posture ------------


def test_reserved_path_write_fails_closed_without_channel(tmp_path):
    (tmp_path / ".git").mkdir()
    out = _exec(tmp_path, "acceptEdits", "write_file", {"path": ".git/hooks/pre-commit", "content": "#!/bin/sh"})
    assert out.startswith("error: permission denied")
    assert not (tmp_path / ".git" / "hooks" / "pre-commit").exists()


def test_reserved_path_write_escalates_through_gate(tmp_path):
    seen = []

    def gate(tool_name, args, reserved_path):
        seen.append(reserved_path)
        raise EscalationPending(
            make_permission_escalation(
                tool_name=tool_name, args=args, prompt_text="x", principal="local_user", run_id="r",
                reserved_path=reserved_path,
            )
        )

    with pytest.raises(EscalationPending):
        _exec(tmp_path, "acceptEdits", "write_file", {"path": "package.json", "content": "{}"}, gate=gate)
    assert seen == ["package.json"]


def test_reserved_path_write_runs_when_gate_grants(tmp_path):
    def gate(tool_name, args, reserved_path):
        return None  # grant consumed

    out = _exec(tmp_path, "acceptEdits", "write_file", {"path": "Makefile", "content": "all:\n\techo hi\n"}, gate=gate)
    assert out.startswith("wrote ")
    assert (tmp_path / "Makefile").exists()


def test_reserved_write_target_detection(tmp_path):
    rt = _RealToolExecution()
    assert rt._reserved_write_target(tmp_path, {"path": ".git/config"}) == ".git/config"
    assert rt._reserved_write_target(tmp_path, {"path": ".github/workflows/ci.yml"}) is not None
    assert rt._reserved_write_target(tmp_path, {"path": "deploy.pem"}) == "deploy.pem"
    assert rt._reserved_write_target(tmp_path, {"path": "package.json"}) == "package.json"
    assert rt._reserved_write_target(tmp_path, {"path": "src/app.py"}) is None
    assert rt._reserved_write_target(tmp_path, {"path": "notes.txt"}) is None


def test_escalation_envelope_importable():
    # guard: the gate signature passes EscalationEnvelope-bearing exceptions
    assert EscalationEnvelope is not None
