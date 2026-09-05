"""Run condition manifest (P1): allowlist projection, env fingerprint four-state,
HMAC comparability, read-only telemetry degrade, and the cleartext sentinel guard
(no goal/prompt/token/env value/tool args/abs path ever reaches the JSON)."""
from __future__ import annotations

import json

import pytest

from superclaw import condition_manifest as cm
from superclaw import diagnostics_store as ds
from superclaw import trace_context as tc
from superclaw.operator_export import ExportError
from superclaw.state import StateStore


def _store(tmp_path):
    return StateStore(tmp_path / "state.db")


def _make_run(store, *, run_id_holder=None, execution_context=None, principal="alice"):
    session = store.create_run("goal_1")
    ec = {
        "backend_policy": "claude",
        "model": "claude-opus-4-8",
        "concurrency": 2,
        "budget_seconds": 60,
        "task_topology": "linear",
        "verification_policy": "adversarial",
        "harness_policy": "codex",
        "principal": principal,
        "repo_path": "/Users/secret/SENTINEL_PATH/repo",
        "artifact_dir": "/Users/secret/SENTINEL_ARTIFACT",
        "company_profile_id": "company_42",
        "containment_policy": {
            "preset": "standard",
            "permission_mode_floor": "plan",
            "network_egress": "deny",
            "max_delegation_depth": 2,
            "filesystem": "workspace",
            "strictness": "high",
        },
        "permission_policy": {
            "mode": "plan",
            "allowed_tools": ["Read", "Edit"],
            "disallowed_tools": ["Bash"],
            "mcp_configs": ["/Users/x/SENTINEL_MCP_PATH"],
            "plugin_dirs": ["/Users/x/SENTINEL_PLUGIN_DIR"],
            "session_id": "SENTINEL_SESSION_ID",
        },
        # Black-hole keys that must NEVER be projected:
        "agent_run_context": {"charter": "SENTINEL_CHARTER_PROMPT"},
        "delegate_tool_results": [{"args": {"token": "SENTINEL_TOOL_ARG_TOKEN"}}],
    }
    if execution_context is not None:
        ec.update(execution_context)
    session.execution_context = ec
    session.chat_session_id = "SENTINEL_CHAT_SESSION"
    store.save_run(session)
    store.add_event(session.run_id, "run.queued", {"goal_id": "goal_1", "execution_context": ec, "status": "queued"})
    store.add_event(session.run_id, "message.completed", {"text": "SENTINEL_MODEL_OUTPUT", "status": "completed"})
    if run_id_holder is not None:
        run_id_holder.append(session.run_id)
    return session.run_id


def test_build_basic_structure(tmp_path):
    store = _store(tmp_path)
    run_id = _make_run(store)
    manifest = cm.build_condition_manifest(store, run_id=run_id, now=123.0, probe_external_tools=False)

    assert manifest["_meta"]["kind"] == "run_condition"
    assert manifest["_meta"]["reconstructable"] is False
    assert manifest["_meta"]["contains_cleartext_environment"] is False
    assert manifest["_meta"]["built_at"] == 123.0
    assert manifest["run"]["run_id"] == run_id
    params = manifest["execution_parameters"]
    assert params["backend_policy"] == "claude"
    assert params["model"] == "claude-opus-4-8"
    assert params["concurrency"] == 2
    assert params["containment_policy"]["network_egress"] == "deny"
    # version contract + deps present
    assert manifest["version_contract"]["available"] is True
    assert isinstance(manifest["dependencies"]["installed"], dict)


def test_permission_policy_paths_not_leaked_only_counts(tmp_path):
    store = _store(tmp_path)
    run_id = _make_run(store)
    manifest = cm.build_condition_manifest(store, run_id=run_id, probe_external_tools=False)
    perm = manifest["execution_parameters"]["permission_policy"]
    assert perm["mode"] == "plan"
    assert perm["allowed_tool_count"] == 2
    assert perm["disallowed_tool_count"] == 1
    assert perm["mcp_config_count"] == 1
    assert perm["plugin_dir_count"] == 1
    assert perm["has_session_id"] is True
    # Cardinality only — no path / pattern / session id value survives anywhere.
    blob = json.dumps(manifest)
    for leaked in ("SENTINEL_MCP_PATH", "SENTINEL_PLUGIN_DIR", "SENTINEL_SESSION_ID"):
        assert leaked not in blob


def test_cleartext_sentinel_guard(tmp_path, monkeypatch):
    """The whole privacy contract: no goal/prompt, tool args, output text, env
    value, or absolute home path may appear in the serialized manifest."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "SENTINEL_ENV_SECRET_VALUE")
    monkeypatch.setenv("SUPERCLAW_LOG_LEVEL", "SENTINEL_CONFIG_VALUE")
    store = _store(tmp_path)
    run_id = _make_run(store)
    manifest = cm.build_condition_manifest(store, run_id=run_id, probe_external_tools=False)
    blob = json.dumps(manifest)
    sentinels = [
        "SENTINEL_PATH",
        "SENTINEL_ARTIFACT",
        "SENTINEL_CHARTER_PROMPT",
        "SENTINEL_TOOL_ARG_TOKEN",
        "SENTINEL_MODEL_OUTPUT",
        "SENTINEL_ENV_SECRET_VALUE",
        "SENTINEL_CONFIG_VALUE",
        "SENTINEL_CHAT_SESSION",
        "ANTHROPIC_API_KEY",  # secret-bearing env NAME is fingerprinted, never cleartext
        "alice",  # principal value
    ]
    for s in sentinels:
        assert s not in blob, f"cleartext leak: {s}"
    # But the identifiers ARE present as fingerprints.
    assert manifest["identifiers"]["principal_fp"] is not None
    assert manifest["identifiers"]["repo_path_fp"] is not None
    assert manifest["run"]["chat_session_id_fp"] is not None
    # The non-secret config key NAME is shown in cleartext (only its value hidden).
    assert "SUPERCLAW_LOG_LEVEL" in manifest["environment_fingerprint"]["config"]


def test_env_four_states(tmp_path, monkeypatch):
    # absent: a no-default config key removed from environ
    monkeypatch.delenv("SUPERCLAW_GIT_SHA", raising=False)
    # defaulted: a has-default config key removed from environ
    monkeypatch.delenv("SUPERCLAW_LOG_LEVEL", raising=False)
    # empty / set
    monkeypatch.setenv("SUPERCLAW_LOG_FORMAT", "")
    monkeypatch.setenv("SUPERCLAW_BACKEND", "anthropic-agent")
    store = _store(tmp_path)
    run_id = _make_run(store)
    config = cm.build_condition_manifest(store, run_id=run_id, probe_external_tools=False)[
        "environment_fingerprint"
    ]["config"]
    assert config["SUPERCLAW_GIT_SHA"]["state"] == "absent"
    assert config["SUPERCLAW_LOG_LEVEL"]["state"] == "defaulted"
    assert config["SUPERCLAW_LOG_FORMAT"]["state"] == "empty"
    assert config["SUPERCLAW_BACKEND"]["state"] == "set"
    assert "value_fp" not in config["SUPERCLAW_GIT_SHA"]
    assert "value_fp" not in config["SUPERCLAW_LOG_LEVEL"]
    assert "value_fp" in config["SUPERCLAW_BACKEND"]


def test_hmac_comparability_and_weak_hash(tmp_path, monkeypatch):
    monkeypatch.delenv(cm.OPERATOR_SECRET_ENV, raising=False)
    store = _store(tmp_path)
    holder: list[str] = []
    run_a = _make_run(store, run_id_holder=holder, principal="bob")
    run_b = _make_run(store, principal="bob")
    run_c = _make_run(store, principal="carol")

    fp_a = cm.build_condition_manifest(store, run_id=run_a, operator_secret="s1", probe_external_tools=False)[
        "identifiers"
    ]["principal_fp"]
    fp_b = cm.build_condition_manifest(store, run_id=run_b, operator_secret="s1", probe_external_tools=False)[
        "identifiers"
    ]["principal_fp"]
    fp_b2 = cm.build_condition_manifest(store, run_id=run_b, operator_secret="s2", probe_external_tools=False)[
        "identifiers"
    ]["principal_fp"]
    fp_c = cm.build_condition_manifest(store, run_id=run_c, operator_secret="s1", probe_external_tools=False)[
        "identifiers"
    ]["principal_fp"]

    assert fp_a == fp_b  # same principal + same secret → comparable across runs
    assert fp_a != fp_b2  # different secret → different fingerprint
    assert fp_a != fp_c  # different principal → different fingerprint

    weak = cm.build_condition_manifest(store, run_id=run_a, probe_external_tools=False)["environment_fingerprint"]
    assert weak["weak_hash"] is True
    assert weak["fingerprint_key_id"] is None
    strong = cm.build_condition_manifest(store, run_id=run_a, operator_secret="s1", probe_external_tools=False)[
        "environment_fingerprint"
    ]
    assert strong["weak_hash"] is False
    assert strong["fingerprint_key_id"] is not None


def test_telemetry_absent_is_incomplete_not_failure(tmp_path):
    store = _store(tmp_path)
    run_id = _make_run(store)
    manifest = cm.build_condition_manifest(
        store, run_id=run_id, telemetry_path=tmp_path / "nope.db", probe_external_tools=False
    )
    assert manifest["telemetry_spans"] is None
    assert manifest["completeness"]["status"] == "incomplete"
    assert manifest["completeness"]["missing"][0]["source"] == "telemetry_db"
    assert manifest["sources"]["telemetry_db"]["usable"] is False
    assert manifest["sources"]["telemetry_db"]["exists"] is False


def test_require_complete_raises_on_missing_telemetry(tmp_path):
    store = _store(tmp_path)
    run_id = _make_run(store)
    with pytest.raises(ExportError):
        cm.build_condition_manifest(
            store,
            run_id=run_id,
            telemetry_path=tmp_path / "nope.db",
            probe_external_tools=False,
            require_complete=True,
        )


def test_telemetry_present_is_read_only_and_complete(tmp_path):
    store = _store(tmp_path)
    run_id = _make_run(store)
    tele_path = tmp_path / "telemetry.db"
    tstore = ds.DiagnosticsStore(tele_path, install_signal_handlers=False)
    try:
        with tc.bind(trace_id="trace_1", run_id=run_id):
            tstore.record(
                "span.start",
                {"name": "worker.tool", "span_kind": "tool", "duration_ms": 5},
                critical=True,
            )
    finally:
        tstore.close()

    manifest = cm.build_condition_manifest(
        store, run_id=run_id, telemetry_path=tele_path, probe_external_tools=False
    )
    assert manifest["completeness"]["status"] == "complete"
    spans = manifest["telemetry_spans"]
    assert spans is not None and len(spans) == 1
    assert spans[0]["kind"] == "span.start"
    assert spans[0]["span"]["name"] == "worker.tool"
    assert spans[0]["span"]["span_kind"] == "tool"
    assert manifest["sources"]["telemetry_db"]["usable"] is True
    assert manifest["sources"]["telemetry_db"]["exists"] is True
    assert manifest["sources"]["telemetry_db"]["span_row_count"] == 1


def test_run_not_found_fails_closed(tmp_path):
    store = _store(tmp_path)
    with pytest.raises(ExportError):
        cm.build_condition_manifest(store, run_id="run_nonexistent", probe_external_tools=False)


def test_lifecycle_events_drop_payload_free_text(tmp_path):
    store = _store(tmp_path)
    run_id = _make_run(store)
    events = cm.build_condition_manifest(store, run_id=run_id, probe_external_tools=False)["lifecycle_events"]
    types = [e["type"] for e in events]
    assert "run.queued" in types
    assert "message.completed" in types
    completed = next(e for e in events if e["type"] == "message.completed")
    assert completed["fields"] == {"status": "completed"}  # text dropped, status kept


def test_telemetry_span_attributes_and_error_text_not_leaked(tmp_path):
    """P1 is stricter than the live redactor: span attributes (arbitrary keys) and
    the error message must NOT reach the manifest — only fixed fields + counts."""
    store = _store(tmp_path)
    run_id = _make_run(store)
    tele_path = tmp_path / "telemetry.db"
    tstore = ds.DiagnosticsStore(tele_path, install_signal_handlers=False)
    try:
        with tc.bind(trace_id="trace_1", run_id=run_id):
            tstore.record(
                "span.error",
                {
                    "name": "worker.tool",
                    "span_kind": "tool",
                    "error_type": "ValueError",
                    "error": "SENTINEL_ERROR_FREE_TEXT",
                    "attributes": {"prompt": "SENTINEL_ATTR_PROMPT", "path": "/Users/x/SENTINEL_ATTR_PATH"},
                },
                critical=True,
            )
    finally:
        tstore.close()
    manifest = cm.build_condition_manifest(
        store, run_id=run_id, telemetry_path=tele_path, probe_external_tools=False
    )
    blob = json.dumps(manifest)
    for leaked in ("SENTINEL_ERROR_FREE_TEXT", "SENTINEL_ATTR_PROMPT", "SENTINEL_ATTR_PATH"):
        assert leaked not in blob
    span = manifest["telemetry_spans"][0]["span"]
    assert span["error_type"] == "ValueError"
    assert span["attribute_key_count"] == 2
    assert span["has_attributes"] is True
    assert span["has_error"] is True
    assert "error" not in span and "attributes" not in span


def test_cost_bucket_label_injection_is_scrubbed(tmp_path):
    """A corrupt cost-event field used as a roll-up KEY (model/provider) must not
    inject a cleartext secret/path into the manifest."""
    from superclaw.models import CostEvent

    store = _store(tmp_path)
    run_id = _make_run(store)
    store.record_cost_event(
        CostEvent(
            idempotency_key="idem_x",
            run_id=run_id,
            model="/Users/secret/SENTINEL_MODEL_PATH",
            provider="prov-with-SENTINEL_PROVIDER",
            input_tokens=5,
            output_tokens=7,
            cost_cents=3,
            billing_lane="byo",
            occurred_at=1000.0,
        )
    )
    manifest = cm.build_condition_manifest(store, run_id=run_id, probe_external_tools=False)
    blob = json.dumps(manifest["cost_summary"])
    assert "SENTINEL_MODEL_PATH" not in blob  # absolute path label → <path-redacted>
    by_model = manifest["cost_summary"]["by_model"]
    assert isinstance(by_model, list)
    assert by_model[0]["label"] == "<path-redacted>"
    assert by_model[0]["metrics"]["input_tokens"] == 5


def test_non_dict_execution_context_degrades(tmp_path):
    store = _store(tmp_path)
    session = store.create_run("goal_x")
    session.execution_context = ["not", "a", "dict"]  # corrupt/legacy payload
    store.save_run(session)
    manifest = cm.build_condition_manifest(store, run_id=session.run_id, probe_external_tools=False)
    # Degrades to empty params, never crashes.
    assert manifest["execution_parameters"]["backend_policy"] is None
    assert all(v is None for v in manifest["identifiers"].values())


def test_malicious_external_tool_output_is_sanitized(tmp_path, monkeypatch):
    # Patch the raw subprocess probe so _probe_tool_version still runs its own
    # path/secret sanitization on the hostile "--version" output.
    from superclaw import runtime

    monkeypatch.setattr(runtime, "_version", lambda tool: "/Users/secret/SENTINEL_TOOL_PATH")
    store = _store(tmp_path)
    run_id = _make_run(store)
    deps = cm.build_condition_manifest(store, run_id=run_id, probe_external_tools=True)["dependencies"]
    assert deps["external_tools_probed"] is True
    assert deps["external_tools"]["git"] == "<path-redacted>"
    assert "SENTINEL_TOOL_PATH" not in json.dumps(deps)


def test_event_type_is_scrubbed(tmp_path):
    store = _store(tmp_path)
    session = store.create_run("goal_e")
    store.save_run(session)
    store.add_event(session.run_id, "/Users/secret/SENTINEL_EVENT_TYPE", {"status": "ok"})
    events = cm.build_condition_manifest(store, run_id=session.run_id, probe_external_tools=False)[
        "lifecycle_events"
    ]
    blob = json.dumps(events)
    assert "SENTINEL_EVENT_TYPE" not in blob


@pytest.mark.parametrize(
    "value",
    [
        "/Users/a/SENTINEL",
        "~/SENTINEL",
        "../secret/SENTINEL",
        "C:/Users/a/SENTINEL",
        "C:\\Users\\a\\SENTINEL",
        "\\\\server\\SENTINEL",
        "http://host/SENTINEL",
        "error at /Users/a/SENTINEL",  # embedded abs path (whitespace)
        "a long free text with SENTINEL inside it",  # free text (whitespace)
        "/var/log/SENTINEL",
        "failed_in=/usr/local/SENTINEL",  # embedded abs path, no whitespace
        "path=~/.ssh/SENTINEL",  # embedded home, no whitespace
    ],
)
def test_scrub_scalar_blocks_path_and_freetext(value):
    out = cm._scrub_scalar(value)
    assert "SENTINEL" not in out
    assert out in ("<redacted>", "<path-redacted>")


@pytest.mark.parametrize(
    "value", ["claude-opus-4-8", "anthropic/claude-opus", "linear", "plan", "adversarial", "byo"]
)
def test_scrub_scalar_preserves_enum_id_tokens(value):
    assert cm._scrub_scalar(value) == value


def test_version_contract_env_values_are_format_validated(tmp_path, monkeypatch):
    """git_sha / bundled_core / desktop_shell are env-sourced. A slug-preserving
    scrub is NOT enough — an OPAQUE env token (no path/secret/whitespace) must also
    be redacted, else contains_cleartext_environment=false is a false statement."""
    monkeypatch.setenv("SUPERCLAW_GIT_SHA", "SENTINEL_GITSHA")  # opaque, not a sha
    monkeypatch.setenv("SUPERCLAW_BUNDLED_CORE_VERSION", "build_SENTINEL_opaque")
    monkeypatch.setenv("SUPERCLAW_DESKTOP_SHELL_VERSION", "desktop_SENTINEL")
    store = _store(tmp_path)
    run_id = _make_run(store)
    vc = cm.build_condition_manifest(store, run_id=run_id, probe_external_tools=False)["version_contract"]
    assert "SENTINEL" not in json.dumps(vc)
    assert vc["git_sha"] == "<redacted>"
    assert vc["bundled_core"] == "<redacted>"
    assert vc["desktop_shell"] == "<redacted>"
    # A semver-SHAPED value with a trailing token (no '-'/'+' separator) must NOT
    # parse as core+suffix and leak the tail.
    monkeypatch.setenv("SUPERCLAW_BUNDLED_CORE_VERSION", "0.1.0SENTINEL")
    vc_tail = cm.build_condition_manifest(store, run_id=run_id, probe_external_tools=False)["version_contract"]
    assert vc_tail["bundled_core"] == "<redacted>"
    # A secret smuggled into legitimate semver build metadata is caught by the
    # secret-scan-first guard, even though the shape is valid.
    monkeypatch.setenv("SUPERCLAW_BUNDLED_CORE_VERSION", "1.2.3+sk-proj-ABCDEFGHIJKLMNOPQRSTUV")
    vc_sec = cm.build_condition_manifest(store, run_id=run_id, probe_external_tools=False)["version_contract"]
    assert vc_sec["bundled_core"] == "<redacted>"
    # Real sha / semver pass through untouched.
    monkeypatch.setenv("SUPERCLAW_GIT_SHA", "a1b2c3d4e5f6")
    monkeypatch.setenv("SUPERCLAW_BUNDLED_CORE_VERSION", "1.2.3-beta.1")
    vc2 = cm.build_condition_manifest(store, run_id=run_id, probe_external_tools=False)["version_contract"]
    assert vc2["git_sha"] == "a1b2c3d4e5f6"
    assert vc2["bundled_core"] == "1.2.3-beta.1"
    # product_version (from VERSION/package metadata) is a real semver and survives.
    assert vc2["product_version"] != "<redacted>"


def test_telemetry_outer_columns_are_scrubbed(tmp_path):
    """request_id / span_id can originate at an HTTP boundary (X-Request-Id) and
    are externally controllable — they must be scrubbed, not dumped raw."""
    import sqlite3

    store = _store(tmp_path)
    run_id = _make_run(store)
    tele_path = tmp_path / "telemetry.db"
    # Build a real telemetry DB, then inject a hostile request_id directly.
    tstore = ds.DiagnosticsStore(tele_path, install_signal_handlers=False)
    try:
        with tc.bind(trace_id="t1", run_id=run_id):
            tstore.record("span.start", {"name": "worker.tool", "span_kind": "tool"}, critical=True)
    finally:
        tstore.close()
    conn = sqlite3.connect(tele_path)
    try:
        conn.execute(
            "UPDATE receipts SET request_id = ? WHERE run_id = ?",
            ("C:/windows/system32/SENTINEL_REQID", run_id),
        )
        conn.commit()
    finally:
        conn.close()

    manifest = cm.build_condition_manifest(
        store, run_id=run_id, telemetry_path=tele_path, probe_external_tools=False
    )
    blob = json.dumps(manifest["telemetry_spans"])
    assert "SENTINEL_REQID" not in blob
    assert manifest["telemetry_spans"][0]["request_id"] == "<path-redacted>"


def test_dependencies_lock_and_installed_both_recorded(tmp_path):
    store = _store(tmp_path)
    run_id = _make_run(store)
    (tmp_path / "requirements.txt").write_text("superclaw==0.1.0\n", encoding="utf-8")
    deps = cm.build_condition_manifest(
        store, run_id=run_id, repo_root=tmp_path, probe_external_tools=False
    )["dependencies"]
    assert deps["lock"]["requirements.txt"]["present"] is True
    assert len(deps["lock"]["requirements.txt"]["sha256"]) == 64
    assert deps["lock"]["uv.lock"]["present"] is False
    assert isinstance(deps["installed"], dict)
    assert deps["external_tools_probed"] is False
