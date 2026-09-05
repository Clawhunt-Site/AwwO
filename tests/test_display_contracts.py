from __future__ import annotations

import os
import subprocess
import sys
from types import SimpleNamespace

from superclaw.display_contracts import (
    SCHEMA_VERSION,
    TRUNCATE_BUDGET_BYTES,
    DisplayEvent,
    ToolCall,
    ToolKind,
    ToolStatus,
    build_display_contract_payload,
    capability_tier,
    redact_payload,
    truncate_field,
    utc_now_iso,
    validate_display_event,
    validate_tool_call,
)


def _valid_event(**overrides):
    base = dict(
        type="tool.started",
        runtime_id="codex-app-server",
        seq=1,
        ts=utc_now_iso(),
        capability_tier="full",
        payload={},
    )
    base.update(overrides)
    return DisplayEvent(**base)


# --- truncate_field ---------------------------------------------------------


def test_truncate_field_str_under_budget():
    assert truncate_field("hi") == ("hi", False)


def test_truncate_field_str_over_budget():
    big = "x" * (TRUNCATE_BUDGET_BYTES + 100)
    out, was = truncate_field(big)
    assert was is True
    assert len(out.encode("utf-8")) <= TRUNCATE_BUDGET_BYTES


def test_truncate_field_none_passthrough():
    assert truncate_field(None) == (None, False)


def test_truncate_field_non_str_small_passthrough():
    val = {"a": 1}
    assert truncate_field(val) == (val, False)


def test_truncate_field_non_str_over_budget_returns_preview_string():
    val = {"k": "x" * (TRUNCATE_BUDGET_BYTES + 50)}
    out, was = truncate_field(val)
    assert was is True
    assert isinstance(out, str)


# --- redact_payload ---------------------------------------------------------


def test_redact_payload_scrubs_and_records_path():
    token = "ghp_" + "a" * 36
    redacted, fields = redact_payload({"cmd": f"export TOKEN={token}", "safe": "ok"})
    assert token not in redacted["cmd"]
    assert "cmd" in fields
    assert "safe" not in fields


def test_redact_payload_nested_list_path():
    secret = "sk-ant-" + "a" * 40
    redacted, fields = redact_payload({"args": [secret, "plain"]})
    assert secret not in redacted["args"][0]
    assert any(f.startswith("args[0]") for f in fields)


def test_redact_payload_top_level_string_uses_dollar_path():
    secret = "ghp_" + "b" * 36
    redacted, fields = redact_payload(secret)
    assert redacted != secret
    assert fields == ["$"]


def test_redact_payload_no_secret_returns_empty_fields():
    _, fields = redact_payload({"x": "nothing secret here"})
    assert fields == []


def test_redact_payload_does_not_mutate_original():
    secret = "ghp_" + "c" * 36
    original = {"cmd": secret}
    redact_payload(original)
    assert original["cmd"] == secret


def test_redact_payload_scrubs_dict_key_without_leaking():
    secret = "ghp_" + "d" * 36
    redacted, fields = redact_payload({secret: "value"})
    # the raw secret key must not survive anywhere (not in keys, not in fields).
    assert secret not in redacted
    assert all(secret not in f for f in fields)
    assert any("(key)" in f for f in fields)


# --- capability_tier (duck-typed) -------------------------------------------


def test_capability_tier_batch_when_not_streaming():
    assert capability_tier(SimpleNamespace(streaming=False)) == "batch"


def test_capability_tier_partial_when_streaming_only():
    caps = SimpleNamespace(
        streaming=True, tool_lifecycle=True, tool_input=False, tool_output=False
    )
    assert capability_tier(caps) == "partial"


def test_capability_tier_full_when_all_fields():
    caps = SimpleNamespace(
        streaming=True, tool_lifecycle=True, tool_input=True, tool_output=True
    )
    assert capability_tier(caps) == "full"


# --- validators -------------------------------------------------------------


def test_validate_display_event_ok():
    assert validate_display_event(_valid_event()) == []


def test_validate_display_event_reports_missing_and_bad_fields():
    errs = validate_display_event(
        {"type": "", "seq": "x", "payload": None, "schema_version": 99}
    )
    assert any("type" in e for e in errs)
    assert any("seq" in e for e in errs)
    assert any("capability_tier" in e for e in errs)
    assert any("schema_version" in e for e in errs)
    assert any("payload" in e for e in errs)


def test_validate_display_event_rejects_bool_seq():
    # bool is an int subclass; seq must be a real int for ordering.
    errs = validate_display_event(_valid_event(seq=True))
    assert any("seq" in e for e in errs)


def test_validate_display_event_rejects_non_canonical_type():
    # fail-closed: non-canonical types must not pass the contract gate.
    for bad in ("command.started", "tool.failed", "totally.fake"):
        errs = validate_display_event(_valid_event(type=bad))
        assert any("canonical display event type" in e for e in errs), bad


def test_validate_display_event_rejects_bad_id_source():
    errs = validate_display_event(_valid_event(id=1, id_source="bogus"))
    assert any("id_source" in e for e in errs)


def test_validate_display_event_accepts_valid_id_source():
    assert validate_display_event(_valid_event(id=7, id_source="sqlite")) == []
    # id_source omitted (None) is allowed.
    assert validate_display_event(_valid_event()) == []


def test_validate_tool_call_rejects_bad_call_id_source():
    tc = ToolCall(call_id="c1", call_id_source="made_up")
    assert any("call_id_source" in e for e in validate_tool_call(tc))


def test_validate_tool_call_rejects_bad_truncated_shape():
    bad = {
        "call_id": "c1",
        "call_id_source": "runtime",
        "kind": "command",
        "status": "ok",
        "truncated": {"input": True},  # missing 'output'
    }
    assert any("truncated" in e for e in validate_tool_call(bad))


def test_validate_tool_call_ok():
    tc = ToolCall(call_id="c1", kind=ToolKind.COMMAND.value, status=ToolStatus.OK.value)
    assert validate_tool_call(tc) == []


def test_validate_tool_call_reports_bad_fields():
    tc = ToolCall(call_id="", kind="bogus", status="weird")
    errs = validate_tool_call(tc)
    assert any("call_id" in e for e in errs)
    assert any("kind" in e for e in errs)
    assert any("status" in e for e in errs)


# --- DisplayEvent envelope --------------------------------------------------


def test_display_event_to_dict_omits_none_optionals():
    data = _valid_event().to_dict()
    assert "run_id" not in data
    assert "id" not in data
    assert data["schema_version"] == SCHEMA_VERSION


def test_display_event_to_dict_includes_set_optionals():
    data = _valid_event(run_id="r1", id=5, id_source="sqlite").to_dict()
    assert data["run_id"] == "r1"
    assert data["id"] == 5
    assert data["id_source"] == "sqlite"


# --- contract payload -------------------------------------------------------


def test_build_display_contract_payload_shape():
    payload = build_display_contract_payload()
    assert payload["schema_version"] == SCHEMA_VERSION
    assert "tool.started" in payload["must_event_types"]
    assert "usage" in payload["gated_event_types"]
    assert set(payload["capability_tiers"]) == {"full", "partial", "batch"}
    assert payload["truncate_budget_bytes"] == TRUNCATE_BUDGET_BYTES
    assert "WAITING_FOR_HUMAN_GATE" in payload["snapshot_states"]
    # field schema so the front end never hand-writes the core structure (DL2)
    assert "type" in payload["envelope_fields"]["required"]
    assert "id_source" in payload["envelope_fields"]["optional"]
    assert "call_id" in payload["tool_call_fields"]["required"]
    assert "redacted_fields" in payload["tool_call_fields"]["optional"]
    assert "truncated" in payload["tool_call_fields"]["required"]


def test_contract_payload_field_types_are_complete():
    payload = build_display_contract_payload()
    # every declared envelope/tool_call field has a machine-readable type entry,
    # so the front end can generate TS types from this payload alone (DL2).
    env = payload["envelope_fields"]
    env_types = payload["envelope_field_types"]
    for name in env["required"] + env["optional"]:
        assert name in env_types, f"missing envelope type: {name}"
        assert "type" in env_types[name]
    tc = payload["tool_call_fields"]
    tc_types = payload["tool_call_field_types"]
    for name in tc["required"] + tc["optional"]:
        assert name in tc_types, f"missing tool_call type: {name}"
        assert "type" in tc_types[name]
    # EVERY enum_ref must resolve to a real vocab list in the same payload — no
    # made-up mini-DSL the front end has to parse (e.g. "a+b").
    for fmap in (env_types, tc_types):
        for fname, spec in fmap.items():
            ref = spec.get("enum_ref")
            if ref is not None:
                assert ref in payload, f"enum_ref {ref!r} ({fname}) not a payload key"
                assert isinstance(payload[ref], list)
    assert env_types["type"]["enum_ref"] == "event_types"
    assert set(payload["event_types"]) == set(payload["must_event_types"]) | set(
        payload["gated_event_types"]
    )
    assert set(payload[tc_types["kind"]["enum_ref"]]) == set(payload["tool_kinds"])
    # truncated sub-structure is described.
    assert tc_types["truncated"]["shape"] == {"input": "bool", "output": "bool"}


# --- RuntimeCapabilities alias + tier (the only adapter touch in PR-1) ------


def test_runtime_capabilities_tool_events_alias():
    from superclaw.agent_runtime import RuntimeCapabilities

    legacy = RuntimeCapabilities(streaming=True, tool_events=True)
    assert legacy.tool_lifecycle is True
    assert legacy.tool_events is True

    granular = RuntimeCapabilities(streaming=True, tool_lifecycle=True)
    assert granular.tool_events is True

    neither = RuntimeCapabilities(streaming=True)
    assert neither.tool_events is False
    assert neither.tool_lifecycle is False


def test_runtime_capabilities_tier_method():
    from superclaw.agent_runtime import RuntimeCapabilities

    full = RuntimeCapabilities(
        streaming=True, tool_lifecycle=True, tool_input=True, tool_output=True
    )
    assert full.capability_tier() == "full"
    assert RuntimeCapabilities(streaming=False).capability_tier() == "batch"
    assert RuntimeCapabilities(streaming=True).capability_tier() == "partial"


# --- DL2 import-cycle guard -------------------------------------------------


def test_display_contracts_does_not_pull_heavy_modules():
    """display_contracts must stay dependency-light (stdlib + secrets_scan only).

    Measures the marginal sys.modules delta from importing it (isolating the
    superclaw package __init__ contamination) and asserts no runtime/backends/
    orchestrator/ui_contracts/state get dragged in.
    """
    code = (
        "import sys, superclaw; "
        "before = set(sys.modules); "
        "import superclaw.display_contracts; "
        "delta = set(sys.modules) - before; "
        "heavy = {'superclaw.runtime', 'superclaw.backends', 'superclaw.orchestrator', "
        "'superclaw.ui_contracts', 'superclaw.state', 'superclaw.plugins'}; "
        "hit = sorted(delta & heavy); "
        "assert not hit, hit; "
        "print('ok')"
    )
    # Propagate the parent's import path so the child resolves ``superclaw`` the
    # same way the test process does (editable install / path injection); this
    # test is about module hygiene, not install location.
    env = {**os.environ, "PYTHONPATH": os.pathsep.join(p for p in sys.path if p)}
    result = subprocess.run(
        [sys.executable, "-c", code], capture_output=True, text=True, env=env
    )
    assert result.returncode == 0, result.stderr
    assert "ok" in result.stdout
