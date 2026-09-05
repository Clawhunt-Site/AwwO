"""CLI surface for the two-state permission shell (Ask/Allow)."""

from __future__ import annotations

import pytest

from superclaw.cli import _permission_policy


def test_policy_projects_preset_onto_mode():
    # Max-permission doctrine: both presets project onto bypassPermissions and
    # override any passed --permission-mode (preset wins).
    assert _permission_policy(permission_mode="plan", permission_preset="ask").mode == "bypassPermissions"
    assert _permission_policy(permission_mode="plan", permission_preset="allow").mode == "bypassPermissions"


def test_policy_without_preset_keeps_mode():
    assert _permission_policy(permission_mode="acceptEdits").mode == "acceptEdits"
    assert _permission_policy(permission_mode="plan").mode == "plan"


def test_run_command_rejects_bogus_preset():
    pytest.importorskip("typer")
    from typer.testing import CliRunner

    from superclaw.cli import app

    result = CliRunner().invoke(
        app,
        ["run", "--title", "t", "--description", "d", "--dry", "--permission-preset", "yolo"],
    )
    assert result.exit_code != 0
    assert "must be 'ask' or 'allow'" in (result.output or str(result.exception))
