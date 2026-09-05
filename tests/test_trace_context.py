"""Kernel trace/correlation context + its injection into structured logs."""
from __future__ import annotations

import json
import logging
from pathlib import Path

from superclaw import logging_config as lc
from superclaw import trace_context as tc


def test_new_id_shape() -> None:
    value = tc.new_id("trace")
    assert value.startswith("trace_")
    assert len(value) == len("trace_") + 12


def test_bind_sets_and_restores() -> None:
    assert tc.get("trace_id") is None
    with tc.bind(trace_id="trace_1"):
        assert tc.get("trace_id") == "trace_1"
        assert tc.current() == {"trace_id": "trace_1"}
    assert tc.get("trace_id") is None  # restored


def test_bind_ignores_none_and_unknown() -> None:
    with tc.bind(trace_id="t", run_id=None, bogus="x"):
        assert tc.current() == {"trace_id": "t"}


def test_bind_nesting_restores_outer() -> None:
    with tc.bind(trace_id="outer", run_id="r1"):
        with tc.bind(trace_id="inner"):
            assert tc.get("trace_id") == "inner"
            assert tc.get("run_id") == "r1"
        assert tc.get("trace_id") == "outer"  # inner restored, outer intact
    assert tc.current() == {}


def test_start_trace_generates_trace_id() -> None:
    with tc.start_trace(run_id="run_x") as ctx:
        assert ctx["trace_id"].startswith("trace_")
        assert ctx["run_id"] == "run_x"


def test_env_roundtrip() -> None:
    with tc.bind(trace_id="trace_env", run_id="run_env"):
        env = tc.export_env()
    assert env == {"SUPERCLAW_TRACE_TRACE_ID": "trace_env", "SUPERCLAW_TRACE_RUN_ID": "run_env"}
    # A child process re-binds from inherited env.
    with tc.import_env(env):
        assert tc.get("trace_id") == "trace_env"
        assert tc.get("run_id") == "run_env"
    assert tc.get("trace_id") is None  # restored after the block


def test_import_env_defaults_to_os_environ(monkeypatch) -> None:
    monkeypatch.setenv("SUPERCLAW_TRACE_TRACE_ID", "trace_from_os")
    with tc.import_env():
        assert tc.get("trace_id") == "trace_from_os"


def test_child_env_stamps_current_context() -> None:
    with tc.bind(trace_id="t1", run_id="r1"):
        env = tc.child_env({"PATH": "/x"})
    assert env["SUPERCLAW_TRACE_TRACE_ID"] == "t1"
    assert env["SUPERCLAW_TRACE_RUN_ID"] == "r1"
    assert env["PATH"] == "/x"  # non-trace base preserved


def test_child_env_scrubs_stale_trace_when_current_empty() -> None:
    # No bind: current context empty. Stale trace in base must NOT leak through.
    base = {"PATH": "/x", "SUPERCLAW_TRACE_TRACE_ID": "stale", "SUPERCLAW_TRACE_RUN_ID": "stale_run"}
    env = tc.child_env(base)
    assert "SUPERCLAW_TRACE_TRACE_ID" not in env
    assert "SUPERCLAW_TRACE_RUN_ID" not in env
    assert env["PATH"] == "/x"


def test_child_env_partial_current_does_not_mix_stale() -> None:
    base = {"SUPERCLAW_TRACE_TRACE_ID": "stale_t", "SUPERCLAW_TRACE_RUN_ID": "stale_r"}
    with tc.bind(trace_id="fresh_t"):
        env = tc.child_env(base)
    assert env["SUPERCLAW_TRACE_TRACE_ID"] == "fresh_t"  # current wins
    assert "SUPERCLAW_TRACE_RUN_ID" not in env  # stale run_id NOT carried over


def test_export_remaps_current_span_to_child_parent() -> None:
    # P0b-1b: a child must not reuse the parent's span_id — the current span becomes
    # the child's parent_span_id, and the current parent_span_id is dropped.
    with tc.bind(trace_id="t", span_id="span_current", parent_span_id="span_old_parent"):
        env = tc.export_env()
    assert env["SUPERCLAW_TRACE_PARENT_SPAN_ID"] == "span_current"
    assert "SUPERCLAW_TRACE_SPAN_ID" not in env  # child opens its own fresh root span
    # Round-trip: the child binds parent_span_id (not span_id) from inherited env.
    with tc.import_env(env):
        assert tc.get("parent_span_id") == "span_current"
        assert tc.get("span_id") is None


def test_child_env_remaps_span_boundary() -> None:
    with tc.bind(trace_id="t", run_id="r", span_id="span_a"):
        env = tc.child_env({"PATH": "/x"})
    assert env["SUPERCLAW_TRACE_PARENT_SPAN_ID"] == "span_a"
    assert "SUPERCLAW_TRACE_SPAN_ID" not in env
    assert env["SUPERCLAW_TRACE_TRACE_ID"] == "t"


def test_export_passes_inherited_parent_through_when_no_active_span() -> None:
    # Grandchild case: a child imported parent_span_id but has NOT opened its own span
    # yet, then spawns a grandchild. The inherited parent must pass through unchanged
    # (NOT be dropped) — else the grandchild's root span is orphaned (trace break).
    with tc.bind(trace_id="t", parent_span_id="span_inherited"):
        env = tc.export_env()
    assert env["SUPERCLAW_TRACE_PARENT_SPAN_ID"] == "span_inherited"


def test_import_never_binds_span_id_from_env() -> None:
    # A legacy/stale SPAN_ID env must NOT make the child reuse the parent's span:
    # it is remapped to parent_span_id, and span_id stays unset (own root span).
    env = {"SUPERCLAW_TRACE_TRACE_ID": "t", "SUPERCLAW_TRACE_SPAN_ID": "legacy_span"}
    with tc.import_env(env):
        assert tc.get("span_id") is None
        assert tc.get("parent_span_id") == "legacy_span"


def test_import_explicit_parent_wins_over_legacy_span() -> None:
    env = {
        "SUPERCLAW_TRACE_SPAN_ID": "legacy_span",
        "SUPERCLAW_TRACE_PARENT_SPAN_ID": "real_parent",
    }
    with tc.import_env(env):
        assert tc.get("parent_span_id") == "real_parent"  # explicit parent wins
        assert tc.get("span_id") is None


def test_logging_carries_trace_fields(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv(lc.LOG_FORMAT_ENV, "json")
    monkeypatch.setenv(lc.LOG_FILE_ENV, str(tmp_path / "trace.log"))
    lc.configure_logging(force=True)

    with tc.bind(trace_id="trace_log", run_id="run_log"):
        lc.get_logger("test.tracelog").info("inside trace")
    lc.get_logger("test.tracelog").info("outside trace")
    for handler in logging.getLogger("superclaw").handlers:
        handler.flush()

    lines = (tmp_path / "trace.log").read_text(encoding="utf-8").strip().splitlines()
    inside = json.loads(lines[0])
    outside = json.loads(lines[1])
    assert inside["trace_id"] == "trace_log"
    assert inside["run_id"] == "run_log"
    assert "trace_id" not in outside  # no leakage outside the bound block


def test_explicit_extra_wins_over_context(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv(lc.LOG_FORMAT_ENV, "json")
    monkeypatch.setenv(lc.LOG_FILE_ENV, str(tmp_path / "win.log"))
    lc.configure_logging(force=True)

    with tc.bind(trace_id="ctx_trace"):
        lc.get_logger("test.win").info("override", extra={"trace_id": "explicit_trace"})
    for handler in logging.getLogger("superclaw").handlers:
        handler.flush()

    record = json.loads((tmp_path / "win.log").read_text(encoding="utf-8").strip().splitlines()[-1])
    assert record["trace_id"] == "explicit_trace"
