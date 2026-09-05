"""Neutral all-kinds distribution endpoint ``GET /api/capabilities/distribution`` — the mirror
of ``/api/plugins/workshop-distribution`` that lists installable plugin/skill/company capabilities
for the Node S4 install path. Asserts kind routing, the kind<->artifact-prefix binding, the
cosign + artifact-presence gates, and the R2-unconfigured degradation.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from apps.api.main import create_app
from superclaw.capability_r2 import CapabilityR2Config, CapabilityR2Error


def _ref(kind: str, cid: str, ext: str) -> str:
    return f"superclaw-object://capabilities/{kind}/{cid}/versions/1.0.0/package.{ext}"


def _entry(kind: str, cid: str, ext: str, **over: Any) -> dict[str, Any]:
    e = {
        "kind": kind,
        "capability_id": cid,
        "version": "1.0.0",
        "status": "published",
        "package_digest": "sha256:" + "a" * 64,
        "artifact_ref": _ref(kind, cid, ext),
    }
    e.update(over)
    return e


PLUGIN = _entry("plugin", "acme.tool", "scplug")
SKILL = _entry("skill", "skill.demo", "scskill")
COMPANY = _entry("company", "co.acme", "sccompany")
GHOST = _entry("plugin", "ghost.tool", "scplug")  # cosigned but bytes never uploaded
UNCOSIGNED = _entry("plugin", "evil.tool", "scplug")
# Drifted: declared plugin but a skill-origin "skill." id -> not installable under either kind,
# so it must be DROPPED from the list (never re-labeled); its artifact lives under capabilities/skill/.
DRIFT = _entry("plugin", "skill.sneaky", "scskill")
DRIFT["artifact_ref"] = _ref("skill", "skill.sneaky", "scskill")


def _present(*entries: dict[str, Any]) -> set[str]:
    return {e["artifact_ref"].replace("superclaw-object://", "") for e in entries}


class _FakeResponse:
    def __init__(self, payload: dict[str, Any]):
        self._payload = payload
        self.status_code = 200

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict[str, Any]:
        return self._payload


def _client(monkeypatch, tmp_path, *, entries, present, r2_unconfigured=False, cosign_ok=lambda e: True):
    monkeypatch.setenv("SUPERCLAW_HOME", str(tmp_path / "home"))
    monkeypatch.setenv("APP_ENV", "staging")
    monkeypatch.delenv("SUPERCLAW_PLUGIN_ROOT_PUBLIC_KEY", raising=False)

    def fake_load_r2_config(*a, **k):
        if r2_unconfigured:
            raise CapabilityR2Error("missing required R2 setting: R2_ENDPOINT")
        return CapabilityR2Config(endpoint_url="https://r2.test", access_key_id="ak", secret_access_key="sk")

    # `_fetch_workshop_entries` is a closure that calls `httpx.get`; drive it via the feed payload.
    monkeypatch.setattr(
        "apps.api.main.httpx.get",
        lambda url, params=None, follow_redirects=True, timeout=8.0: _FakeResponse({"entries": list(entries)}),
    )
    monkeypatch.setattr("apps.api.main.load_r2_config", fake_load_r2_config)
    monkeypatch.setattr("apps.api.main.list_r2_object_keys", lambda bucket, prefix, *, config=None, runner=None: set(present))
    monkeypatch.setattr("apps.api.main.verify_official_cosignature", lambda entry, official_public_key: cosign_ok(entry))
    return TestClient(create_app(state_path=tmp_path / "state.db"))


def _caps(body: dict) -> set[tuple[str, str, str]]:
    return {(c["kind"], c["capability_id"], c["version"]) for c in body["capabilities"]}


def test_lists_all_three_kinds_when_present_and_cosigned(monkeypatch, tmp_path):
    client = _client(
        monkeypatch, tmp_path, entries=[PLUGIN, SKILL, COMPANY], present=_present(PLUGIN, SKILL, COMPANY)
    )
    body = client.get("/api/capabilities/distribution").json()
    assert body["r2_configured"] is True
    assert _caps(body) == {
        ("plugin", "acme.tool", "1.0.0"),
        ("skill", "skill.demo", "1.0.0"),
        ("company", "co.acme", "1.0.0"),
    }


def test_excludes_ghost_without_uploaded_bytes(monkeypatch, tmp_path):
    # GHOST is cosigned but its key is absent from the bucket listing.
    client = _client(monkeypatch, tmp_path, entries=[PLUGIN, GHOST], present=_present(PLUGIN))
    assert _caps(client.get("/api/capabilities/distribution").json()) == {("plugin", "acme.tool", "1.0.0")}


def test_excludes_uncosigned_entry(monkeypatch, tmp_path):
    client = _client(
        monkeypatch,
        tmp_path,
        entries=[PLUGIN, UNCOSIGNED],
        present=_present(PLUGIN, UNCOSIGNED),
        cosign_ok=lambda e: e["capability_id"] != "evil.tool",
    )
    assert _caps(client.get("/api/capabilities/distribution").json()) == {("plugin", "acme.tool", "1.0.0")}


def test_drops_skill_origin_drift_entirely(monkeypatch, tmp_path):
    # Declared kind:'plugin' but a skill-origin id -> NOT installable under either kind (the
    # signed identity says plugin; advertising as skill would fail the bridge's exact-kind match
    # and isn't a signed skill identity). It must be dropped, not re-labeled.
    client = _client(monkeypatch, tmp_path, entries=[DRIFT], present=_present(DRIFT))
    assert client.get("/api/capabilities/distribution").json()["capabilities"] == []


def test_genuine_skill_is_listed_as_skill(monkeypatch, tmp_path):
    # A real skill keeps kind=='skill' (its id is skill.* / skill_origin) and IS listed — the
    # signed kind is honored, not dropped.
    client = _client(monkeypatch, tmp_path, entries=[SKILL], present=_present(SKILL))
    assert _caps(client.get("/api/capabilities/distribution").json()) == {("skill", "skill.demo", "1.0.0")}


def test_binds_kind_to_artifact_prefix(monkeypatch, tmp_path):
    # Declared plugin, NOT skill-origin, but artifact_ref points under capabilities/skill/ -> the
    # kind<->prefix binding rejects it (never advertise a mismatched location).
    mismatch = _entry("plugin", "acme.tool", "scplug")
    mismatch["artifact_ref"] = _ref("skill", "acme.tool", "scplug")
    client = _client(monkeypatch, tmp_path, entries=[mismatch], present=_present(mismatch))
    assert client.get("/api/capabilities/distribution").json()["capabilities"] == []


def test_empty_and_discovery_only_when_r2_unconfigured(monkeypatch, tmp_path):
    client = _client(monkeypatch, tmp_path, entries=[PLUGIN], present=_present(PLUGIN), r2_unconfigured=True)
    body = client.get("/api/capabilities/distribution").json()
    assert body["r2_configured"] is False
    assert body["capabilities"] == []


def test_r2_list_failure_is_generic_no_internal_leak(monkeypatch, tmp_path):
    # An R2 list failure can carry internal context (endpoint/bucket/AWS stderr/env path); the
    # response error must be a fixed generic code, NOT the raw exception text.
    secret_ish = "endpoint https://acct.r2.cloudflarestorage.com bucket=secret-prod stderr=/home/u/.r2.env"
    monkeypatch.setenv("SUPERCLAW_HOME", str(tmp_path / "home"))
    monkeypatch.setenv("APP_ENV", "staging")

    def fake_load_r2_config(*a, **k):
        return CapabilityR2Config(endpoint_url="https://r2.test", access_key_id="ak", secret_access_key="sk")

    def boom_list(*a, **k):
        raise CapabilityR2Error(secret_ish)

    monkeypatch.setattr("apps.api.main.load_r2_config", fake_load_r2_config)
    monkeypatch.setattr(
        "apps.api.main.httpx.get",
        lambda url, params=None, follow_redirects=True, timeout=8.0: _FakeResponse({"entries": [PLUGIN]}),
    )
    monkeypatch.setattr("apps.api.main.list_r2_object_keys", boom_list)
    monkeypatch.setattr("apps.api.main.verify_official_cosignature", lambda entry, official_public_key: True)
    client = TestClient(create_app(state_path=tmp_path / "state.db"))

    body = client.get("/api/capabilities/distribution").json()
    assert body["capabilities"] == []
    assert body["error"] == "distribution_unavailable"
    # No internal context leaked anywhere in the response.
    assert "secret-prod" not in repr(body) and "r2.cloudflarestorage" not in repr(body) and ".r2.env" not in repr(body)
