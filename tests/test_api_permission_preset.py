"""API surface for the two-state permission shell (Ask/Allow).

Covers: the permission_preset request field projecting onto permission_mode via
the kernel contract, the legacy default staying acceptEdits when no preset is
sent (zero behavior change), and the runtime status payload exposing the
two-preset contract to surfaces.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

REPO_ROOT = Path(__file__).resolve().parents[1]


def _load_api_module():
    spec = importlib.util.spec_from_file_location("superclaw_api_main", REPO_ROOT / "apps" / "api" / "main.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules.setdefault("superclaw_api_main", module)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def api_main():
    return _load_api_module()


def test_effective_permission_mode_projection(api_main):
    f = api_main._effective_permission_mode
    # Max-permission doctrine: both presets project onto bypassPermissions and
    # override any passed mode (preset wins). Runtime is a pure execution engine.
    assert f("ask", "plan") == "bypassPermissions"
    assert f("allow", "plan") == "bypassPermissions"
    # no preset -> legacy mode passes through untouched (advanced escape hatch)
    assert f(None, "acceptEdits") == "acceptEdits"
    assert f(None, "plan") == "plan"


def test_request_models_accept_preset_and_default_none(api_main):
    run_req = api_main.RunRequest(goal_id="g1")
    chat_req = api_main.ChatTurnRequest(message="hi")
    assert run_req.permission_preset is None
    assert chat_req.permission_preset is None
    assert run_req.permission_mode == "acceptEdits"
    assert chat_req.permission_mode == "acceptEdits"
    assert api_main.RunRequest(goal_id="g1", permission_preset="ask").permission_preset == "ask"
    assert api_main.ChatTurnRequest(message="hi", permission_preset="allow").permission_preset == "allow"
    with pytest.raises(Exception):
        api_main.RunRequest(goal_id="g1", permission_preset="yolo")


def test_runtime_status_exposes_permission_contract(api_main, tmp_path, monkeypatch):
    monkeypatch.delenv("SUPERCLAW_CONTROL_TOKEN", raising=False)
    monkeypatch.chdir(tmp_path)
    app = api_main.create_app(state_path=tmp_path / "state.db")
    client = TestClient(app)
    payload = client.get("/api/runtime/status").json()
    contract = payload["permission_modes"]
    assert sorted(contract["presets"]) == ["allow", "ask"]
    assert contract["preset_to_mode"] == {"ask": "bypassPermissions", "allow": "bypassPermissions"}
    # Honest title under the max-permission doctrine: "ask" runs at max today,
    # so the label must not claim to prompt/restrict (surface-fraud avoidance).
    assert contract["labels"]["ask"]["title"] == "Standard (max today)"
