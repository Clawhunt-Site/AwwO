"""Onboarding-tour completion state: kernel config + API + CLI parity.

The web onboarding tour is a presentation-layer feature, but "has this user
finished it" is persisted in the kernel shell config so completion is durable
and the CLI / API / web surfaces all agree on a single source of truth.
"""

import json
import threading

import pytest
from fastapi.testclient import TestClient
from typer.testing import CliRunner

from apps.api.main import create_app
from superclaw.cli import app as cli_app
from superclaw.runtime_config import (
    ONBOARDING_CONFIG_KEY,
    load_onboarding_state,
    load_shell_config,
    persisted_runtime_environment,
    reset_onboarding_state,
    save_shell_config_value,
    set_onboarding_completed,
)


@pytest.fixture
def shell_config(tmp_path, monkeypatch):
    """Isolate the shell config to a per-test file (never the developer's real one)."""
    path = tmp_path / "config.json"
    monkeypatch.setenv("SUPERCLAW_SHELL_CONFIG_PATH", str(path))
    return path


# --- kernel -----------------------------------------------------------------


def test_unset_is_not_completed(shell_config):
    assert load_onboarding_state() == {"completed": False, "version": 0}


def test_set_completed_round_trips_under_reserved_key(shell_config):
    assert set_onboarding_completed(2) == {"completed": True, "version": 2}
    assert load_onboarding_state() == {"completed": True, "version": 2}
    raw = json.loads(shell_config.read_text(encoding="utf-8"))
    assert raw[ONBOARDING_CONFIG_KEY] == {"completed": True, "version": 2}


def test_reset_clears_state(shell_config):
    set_onboarding_completed(1)
    assert reset_onboarding_state() == {"completed": False, "version": 0}
    assert load_onboarding_state()["completed"] is False
    assert ONBOARDING_CONFIG_KEY not in load_shell_config()


def test_completion_preserves_sibling_config_keys(shell_config):
    save_shell_config_value("backend", "claude")
    set_onboarding_completed(1)
    config = load_shell_config()
    assert config["backend"] == "claude"
    assert config[ONBOARDING_CONFIG_KEY]["completed"] is True
    reset_onboarding_state()
    # resetting onboarding must not drop unrelated config
    assert load_shell_config()["backend"] == "claude"


@pytest.mark.parametrize("bad", [-1, True, "1", 1.0, None])
def test_complete_rejects_bad_version(shell_config, bad):
    with pytest.raises(ValueError):
        set_onboarding_completed(bad)  # type: ignore[arg-type]


@pytest.mark.parametrize(
    "stored",
    [
        {"completed": "yes", "version": 1},  # non-bool completed -> not completed
        {"completed": True},  # missing version -> 0
        {"version": 5},  # missing completed -> not completed
        "garbage",  # not a dict
        {"completed": True, "version": -3},  # bad version -> 0 (completed flag still honored)
    ],
)
def test_load_is_fail_closed_on_malformed(shell_config, stored):
    shell_config.write_text(json.dumps({ONBOARDING_CONFIG_KEY: stored}), encoding="utf-8")
    state = load_onboarding_state()
    # Only an explicit boolean ``True`` counts as completed; everything else is
    # treated as unseen so a corrupt value can only re-show the tour, never
    # wrongly suppress it. The version always normalizes to a non-negative int.
    expect_completed = isinstance(stored, dict) and stored.get("completed") is True
    assert state["completed"] is expect_completed
    assert state["version"] >= 0


def test_bool_version_normalizes_to_zero(shell_config):
    # bool is an int subclass: a hand-edited ``version: true`` must NOT survive as
    # 1, or a surface's ``version >= TOUR_VERSION`` gate would wrongly suppress the
    # tour. It is fail-closed to 0 (the completed flag is still honored).
    shell_config.write_text(
        json.dumps({ONBOARDING_CONFIG_KEY: {"completed": True, "version": True}}), encoding="utf-8"
    )
    assert load_onboarding_state() == {"completed": True, "version": 0}


def test_concurrent_writes_preserve_all_sibling_keys(shell_config):
    # The locked read-modify-write must not lose keys when onboarding and config
    # writes race. Without the file lock, interleaved writers clobber each other.
    barrier = threading.Barrier(9)

    def write_value(name: str) -> None:
        barrier.wait()
        save_shell_config_value(name, name)

    def mark_done() -> None:
        barrier.wait()
        set_onboarding_completed(1)

    threads = [threading.Thread(target=write_value, args=(f"k{i}",)) for i in range(8)]
    threads.append(threading.Thread(target=mark_done))
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    config = load_shell_config()
    for i in range(8):
        assert config[f"k{i}"] == f"k{i}"
    assert config[ONBOARDING_CONFIG_KEY] == {"completed": True, "version": 1}


def test_state_is_not_hydrated_into_process_env(shell_config):
    set_onboarding_completed(1)
    # The reserved key is NOT a runtime config spec, so it can never be exported
    # into the process environment alongside real runtime settings.
    assert ONBOARDING_CONFIG_KEY not in persisted_runtime_environment()


# --- API --------------------------------------------------------------------


@pytest.fixture
def client(tmp_path, shell_config):
    return TestClient(create_app(state_path=tmp_path / "state.db"))


def test_api_get_default(client):
    resp = client.get("/api/onboarding")
    assert resp.status_code == 200
    assert resp.json() == {"completed": False, "version": 0}


def test_api_complete_then_reset(client):
    done = client.post("/api/onboarding/complete", json={"version": 1})
    assert done.status_code == 200
    assert done.json() == {"completed": True, "version": 1}
    assert client.get("/api/onboarding").json()["completed"] is True
    # the endpoint writes the SAME kernel state the CLI reads
    assert load_onboarding_state() == {"completed": True, "version": 1}

    reset = client.post("/api/onboarding/reset")
    assert reset.status_code == 200
    assert reset.json() == {"completed": False, "version": 0}
    assert client.get("/api/onboarding").json()["completed"] is False


def test_api_complete_defaults_version_zero(client):
    resp = client.post("/api/onboarding/complete", json={})
    assert resp.status_code == 200
    assert resp.json() == {"completed": True, "version": 0}


def test_api_complete_rejects_negative_version(client):
    resp = client.post("/api/onboarding/complete", json={"version": -1})
    assert resp.status_code == 422


# --- CLI parity -------------------------------------------------------------


def test_cli_status_complete_reset_share_kernel_state(shell_config):
    runner = CliRunner()

    status = runner.invoke(cli_app, ["onboarding"])
    assert status.exit_code == 0, status.output
    assert json.loads(status.output) == {"completed": False, "version": 0}

    done = runner.invoke(cli_app, ["onboarding", "--complete", "1"])
    assert done.exit_code == 0, done.output
    assert json.loads(done.output) == {"completed": True, "version": 1}
    # the CLI and the API mutate the very same kernel config
    assert load_onboarding_state() == {"completed": True, "version": 1}

    reset = runner.invoke(cli_app, ["onboarding", "--reset"])
    assert reset.exit_code == 0, reset.output
    assert json.loads(reset.output) == {"completed": False, "version": 0}


def test_cli_reset_and_complete_are_mutually_exclusive(shell_config):
    result = CliRunner().invoke(cli_app, ["onboarding", "--reset", "--complete", "1"])
    assert result.exit_code != 0
