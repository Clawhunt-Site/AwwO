"""Unit tests for the gateway co-launch infrastructure (gateway_runtime).

Pure unit tests — no real subprocess: run-command resolution, env construction, mode
gating, and fail-open are exercised against tmp dirs and fakes. The gateway's own
business logic lives in Node (apps/gateway) and is tested there.
"""

from __future__ import annotations

from pathlib import Path

import superclaw.gateway_runtime as gr


# --- config knobs -----------------------------------------------------------


def test_gateway_mode_default_frozen_gated(monkeypatch) -> None:
    monkeypatch.delenv("SUPERCLAW_GATEWAY", raising=False)
    # Source/dev run (not frozen): default OFF — Vite owns the gateway, no double-launch.
    monkeypatch.setattr(gr.sys, "frozen", False, raising=False)
    assert gr.gateway_mode() == "off"
    # Packaged app (frozen): default AUTO — the service owns the co-launch (no Vite).
    monkeypatch.setattr(gr.sys, "frozen", True, raising=False)
    assert gr.gateway_mode() == "auto"


def test_gateway_mode_explicit_overrides_win(monkeypatch) -> None:
    monkeypatch.setattr(gr.sys, "frozen", False, raising=False)
    for raw, expected in [("on", "on"), ("off", "off"), ("auto", "auto"), ("1", "on"), ("false", "off")]:
        monkeypatch.setenv("SUPERCLAW_GATEWAY", raw)
        assert gr.gateway_mode() == expected


def test_resolve_gateway_port_default_and_env(monkeypatch) -> None:
    monkeypatch.delenv("SUPERCLAW_GATEWAY_PORT", raising=False)
    assert gr.resolve_gateway_port() == gr.DEFAULT_GATEWAY_PORT == 8796
    monkeypatch.setenv("SUPERCLAW_GATEWAY_PORT", "9100")
    assert gr.resolve_gateway_port() == 9100
    monkeypatch.setenv("SUPERCLAW_GATEWAY_PORT", "not-a-port")
    assert gr.resolve_gateway_port() == 8796  # invalid -> default


def test_resolve_gateway_dir_env_override(monkeypatch, tmp_path: Path) -> None:
    (tmp_path / "package.json").write_text("{}", encoding="utf-8")
    monkeypatch.setenv("SUPERCLAW_GATEWAY_DIR", str(tmp_path))
    assert gr.resolve_gateway_dir() == tmp_path
    # override pointing at a dir without package.json -> None
    empty = tmp_path / "empty"
    empty.mkdir()
    monkeypatch.setenv("SUPERCLAW_GATEWAY_DIR", str(empty))
    assert gr.resolve_gateway_dir() is None


# --- run command resolution -------------------------------------------------


def _supervisor(tmp_path: Path, gateway_dir: Path, node_bin: str | None = "/usr/bin/node") -> gr.GatewaySupervisor:
    state_path = tmp_path / "state.db"
    return gr.GatewaySupervisor(state_path=state_path, gateway_dir=gateway_dir, node_bin=node_bin)


def test_resolve_run_command_prefers_built_dist(tmp_path: Path) -> None:
    gw = tmp_path / "gateway"
    (gw / "dist").mkdir(parents=True)
    entry = gw / "dist" / "index.js"
    entry.write_text("// built", encoding="utf-8")
    sup = _supervisor(tmp_path, gw, node_bin="/usr/bin/node")
    assert sup.resolve_run_command() == ["/usr/bin/node", str(entry)]
    assert sup.is_runnable() is True


def test_resolve_run_command_dist_without_node_is_none(tmp_path: Path) -> None:
    gw = tmp_path / "gateway"
    (gw / "dist").mkdir(parents=True)
    (gw / "dist" / "index.js").write_text("// built", encoding="utf-8")
    sup = _supervisor(tmp_path, gw)
    sup.node_bin = None  # simulate "no node executable resolved"
    assert sup.resolve_run_command() is None  # built dist but no node -> not runnable


def test_resolve_run_command_none_when_no_entry(tmp_path: Path) -> None:
    gw = tmp_path / "gateway"
    gw.mkdir()
    sup = _supervisor(tmp_path, gw)
    assert sup.resolve_run_command() is None
    assert sup.is_runnable() is False


# --- env construction -------------------------------------------------------


def test_build_env_pins_home_and_port(tmp_path: Path) -> None:
    state_path = tmp_path / "data" / "state.db"
    state_path.parent.mkdir(parents=True)
    sup = gr.GatewaySupervisor(state_path=state_path, gateway_dir=tmp_path, node_bin="/usr/bin/node", port=8800)
    env = sup.build_env()
    # SUPERCLAW_HOME = the data root holding run/ (state_path's parent)
    assert env["SUPERCLAW_HOME"] == str(state_path.parent)
    assert env["SUPERCLAW_GATEWAY_PORT"] == "8800"


# --- start / stop fail-open -------------------------------------------------


def test_start_returns_none_when_not_runnable(tmp_path: Path) -> None:
    gw = tmp_path / "gateway"
    gw.mkdir()
    sup = _supervisor(tmp_path, gw)
    assert sup.start() is None  # nothing to run -> fail-open, no spawn


def test_stop_without_process_is_noop_true(tmp_path: Path) -> None:
    sup = _supervisor(tmp_path, tmp_path)
    assert sup.stop() is True


def test_start_sidecar_off_returns_none(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("SUPERCLAW_GATEWAY", "off")
    assert gr.start_gateway_sidecar_if_enabled(tmp_path / "state.db") is None


def test_start_sidecar_auto_not_runnable_returns_none(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("SUPERCLAW_GATEWAY", "auto")
    # point at an empty gateway dir so nothing is runnable -> None (no spawn)
    empty = tmp_path / "gw"
    empty.mkdir()
    (empty / "package.json").write_text("{}", encoding="utf-8")
    monkeypatch.setenv("SUPERCLAW_GATEWAY_DIR", str(empty))
    assert gr.start_gateway_sidecar_if_enabled(tmp_path / "state.db") is None
