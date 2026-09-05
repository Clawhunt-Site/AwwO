"""Per-kind redaction allowlist projection (P0b-1c)."""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from superclaw import diagnostics_store as ds
from superclaw import trace_context as tc
from superclaw.diagnostics_redaction import (
    _ATTR_MAX_NODES,
    _ATTR_STR_MAX,
    is_allowlisted_kind,
    redact,
)
from superclaw.diagnostics_span import SpanKind, span

_SECRET = "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB"  # matches a GitHub-token pattern


# -- allowlist projection --------------------------------------------------


def test_unlisted_keys_are_dropped() -> None:
    out = redact("governance.decision", {"decision": "denied", "evil_extra": "leak-me"})
    assert out == {"decision": "denied"}  # only allowlisted keys survive


def test_unknown_kind_fails_closed() -> None:
    out = redact("totally.unknown.kind", {"anything": "secret-data", "x": 1})
    assert out == {"_unredacted_kind": True}  # whole payload dropped
    assert not is_allowlisted_kind("totally.unknown.kind")
    assert is_allowlisted_kind("governance.decision")


def test_number_field_drops_non_numbers() -> None:
    assert redact("diagnostic_loss", {"count": 5}) == {"count": 5}
    # A string smuggled into a number field is dropped, not coerced.
    assert redact("diagnostic_loss", {"count": "99; DROP TABLE"}) == {}


# -- value scrubbing -------------------------------------------------------


def test_secret_in_text_field_is_scrubbed() -> None:
    out = redact("span.error", {"error": f"boom token={_SECRET}"})
    assert _SECRET not in out["error"]
    assert "[REDACTED]" in out["error"]


def test_url_userinfo_and_query_stripped() -> None:
    out = redact("span.error", {"error": "fetch https://user:pass@host.example/p?token=abc123 done"})
    assert "user:pass@" not in out["error"]
    assert "?token=" not in out["error"]
    assert "host.example/p" in out["error"]


def test_text_field_length_capped() -> None:
    out = redact("span.error", {"error": "x" * 5000})
    assert len(out["error"]) <= 1024


# -- attributes: keys kept, values redacted, bounded -----------------------


def test_attributes_keep_keys_redact_values() -> None:
    out = redact(
        "span.end",
        {"attributes": {"cmd": f"deploy --key {_SECRET}", "exit_code": 0, "nested": {"k": "v"}}},
    )
    attrs = out["attributes"]
    assert set(attrs.keys()) == {"cmd", "exit_code", "nested"}  # structure preserved
    assert _SECRET not in attrs["cmd"] and "[REDACTED]" in attrs["cmd"]
    assert attrs["exit_code"] == 0  # numbers pass
    assert attrs["nested"] == {"k": "v"}  # recursion preserves nested structure


def test_attributes_string_value_capped() -> None:
    out = redact("span.end", {"attributes": {"blob": "x" * 100000}})
    assert len(out["attributes"]["blob"]) <= _ATTR_STR_MAX


def test_attributes_total_node_budget_bounds_blowup() -> None:
    # A wide+deep tree must NOT expand to items**depth nodes — the total node budget caps
    # the whole tree. Branching 6 × depth 4 ≈ 1554 nodes (cheap to build) already exceeds
    # the 512 budget, so the output must be bounded WELL below the input.
    def _wide(depth: int):
        if depth == 0:
            return {f"k{i}": i for i in range(6)}
        return {f"k{i}": _wide(depth - 1) for i in range(6)}

    out = redact("span.end", {"attributes": _wide(4)})

    def _count(v) -> int:
        if isinstance(v, dict):
            return 1 + sum(_count(x) for x in v.values())
        if isinstance(v, list):
            return 1 + sum(_count(x) for x in v)
        return 1

    assert _count(out["attributes"]) <= _ATTR_MAX_NODES + 64  # bounded, not 64**4


def test_attributes_cyclic_does_not_recurse_forever() -> None:
    cyclic: dict = {}
    cyclic["self"] = cyclic
    out = redact("span.start", {"attributes": cyclic})  # must return (depth/budget bound)
    assert isinstance(out["attributes"], dict)


def test_redact_never_raises_on_weird_value() -> None:
    class _Weird:
        def __repr__(self) -> str:
            raise RuntimeError("nope")

    # An exotic object in an attrs tree must not blow up redaction.
    out = redact("span.end", {"attributes": {"o": _Weird()}})
    assert "attributes" in out


def test_attribute_KEY_secret_is_scrubbed() -> None:
    # The KEY is caller-controlled (SpanHandle.set(key, ...)); a secret in a key must be
    # scrubbed, not just length-capped.
    out = redact("span.end", {"attributes": {f"hdr-{_SECRET}": "v"}})
    keys = list(out["attributes"].keys())
    assert all(_SECRET not in k for k in keys)
    assert any("[REDACTED]" in k for k in keys)


def test_redact_is_total_on_non_dict_payload() -> None:
    # redact() runs on the persist path: a None / scalar / list payload must NOT raise.
    assert redact("span.end", None) == {}  # type: ignore[arg-type]
    assert redact("span.end", "not-a-dict") == {}  # type: ignore[arg-type]
    assert redact("span.end", 42) == {}  # type: ignore[arg-type]
    assert redact("unknown.kind", None) == {"_unredacted_kind": True}  # type: ignore[arg-type]


def test_redact_total_on_hostile_dict_subclass() -> None:
    # A dict SUBCLASS that overrides EVERY access path (__contains__/__getitem__/keys/
    # __iter__/items) to raise must NOT make redact() raise, hang, or skip real data:
    # redaction reads only allowlisted keys via the unbound base-dict methods.
    class _Hostile(dict):
        def __contains__(self, k):  # type: ignore[override]
            raise RuntimeError("contains boom")

        def __getitem__(self, k):  # type: ignore[override]
            raise RuntimeError("getitem boom")

        def keys(self):  # type: ignore[override]
            raise RuntimeError("keys boom")

        def __iter__(self):  # type: ignore[override]
            raise RuntimeError("iter boom")

        def items(self):  # type: ignore[override]
            raise RuntimeError("items boom")

    payload = _Hostile()
    dict.__setitem__(payload, "decision", "denied")
    out = redact("governance.decision", payload)  # must not raise and must SEE the value
    assert out == {"decision": "denied"}  # base-dict access bypasses the overrides


def test_redact_is_bounded_to_allowlist_not_payload_size() -> None:
    # A giant bag of unknown top-level fields (deny-by-omission) must cost nothing — only
    # the allowlist keys are ever read. A subclass whose iteration raises proves we never
    # iterate the whole payload (we'd raise/return {} if we did).
    class _NoIter(dict):
        def keys(self):  # type: ignore[override]
            raise RuntimeError("must not iterate")

        def __iter__(self):  # type: ignore[override]
            raise RuntimeError("must not iterate")

    payload = _NoIter()
    dict.__setitem__(payload, "decision", "denied")
    for i in range(100000):  # huge unknown payload — never copied/iterated by redact
        dict.__setitem__(payload, f"junk_{i}", "x")
    out = redact("governance.decision", payload)
    assert out == {"decision": "denied"}  # only the allowlisted key survives, no iteration


def test_every_producer_kind_is_allowlisted() -> None:
    # Test-as-Policy drift guard: every receipt kind a producer emits MUST have a declared
    # allowlist — else its payload silently fails closed. Adding a new producer kind
    # constant without an allowlist trips this.
    from superclaw.diagnostics_owners import GOVERNANCE_DECISION
    from superclaw.diagnostics_span import _SPAN_END, _SPAN_ERROR, _SPAN_START

    producer_kinds = {_SPAN_START, _SPAN_END, _SPAN_ERROR, GOVERNANCE_DECISION, "diagnostic_loss"}
    for kind in producer_kinds:
        assert is_allowlisted_kind(kind), f"producer kind {kind!r} has no redaction allowlist"


# -- end-to-end: the owner choke point redacts before the sink persists -----


def _read(path: Path) -> list[dict]:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    try:
        return [dict(r) for r in conn.execute("SELECT * FROM receipts ORDER BY id")]
    finally:
        conn.close()


def test_span_attribute_secret_is_redacted_in_persisted_receipt(tmp_path: Path) -> None:
    path = tmp_path / "telemetry.db"
    store = ds.DiagnosticsStore(path, install_signal_handlers=False)
    try:
        with tc.bind(trace_id="t"):
            with span("backend.run", kind=SpanKind.BACKEND, critical=True, store=store) as h:
                h.set("cmd", f"curl -H 'Authorization: Bearer {_SECRET}'")
        rows = _read(path)
        blob = json.dumps([json.loads(r["payload"]) for r in rows])
        assert _SECRET not in blob  # the secret never reaches telemetry.db
        assert "[REDACTED]" in blob
    finally:
        store.close()
