"""Surface tests for the live capability-workshop catalog proxy.

Proves the SuperClaw API faithfully projects ClawHunt's public
``/v1/capabilities/published`` feed into the marketplace surface shape the web
client already consumes — a thin presentation proxy that adds NO governance
semantics (the kernel/ClawHunt review decides what is published).
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from apps.api.main import create_app


class _FakeResponse:
    def __init__(self, payload: dict[str, Any], status_code: int = 200):
        self._payload = payload
        self.status_code = status_code

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            import httpx

            raise httpx.HTTPStatusError("upstream error", request=None, response=None)

    def json(self) -> dict[str, Any]:
        return self._payload


_CLAWHUNT_PUBLISHED = {
    "schema": "clawhunt.capability_workshop_published.v1",
    "counts": {"plugin": 1, "skill": 1, "company": 0},
    "capabilities": {},
    "entries": [
        {
            "kind": "plugin",
            "capability_id": "leon.demo.plugin",
            "version": "1.2.0",
            "name": "Leon Demo Plugin",
            "summary": "A reviewed plugin.",
            "status": "published",
            "verified": True,
            "signature_verified": True,
            "signer_keyid": "sha256:abc",
            "official_signature": "ed25519:Zm9vYmFyc2ln",
            "official_signer_keyid": "sha256:cd61575d",
            "signature_verified_official": True,
            "package_digest": "sha256:" + "a" * 64,
            "blob_digest": "sha256:" + "b" * 64,
        },
        {
            "kind": "skill",
            "capability_id": "leon.demo.skill",
            "version": "0.1.0",
            "name": "Leon Demo Skill",
            "summary": "A reviewed skill.",
            "status": "approved",
            "verified": False,
            "signature_verified": False,
            "signer_keyid": None,
        },
        {
            "kind": "company",
            "capability_id": "leon.demo.company",
            "version": "2.0.0",
            "name": "Leon Demo Company",
            "summary": "A reviewed company template.",
            "status": "published",
            "verified": False,
            "signature_verified": False,
            "signer_keyid": None,
        },
    ],
}


def _client(monkeypatch, tmp_path, *, fake_payload=_CLAWHUNT_PUBLISHED, status_code=200, captured=None):
    def fake_get(url, params=None, follow_redirects=True, timeout=8.0):
        if captured is not None:
            captured["url"] = url
            captured["params"] = params
        return _FakeResponse(fake_payload, status_code=status_code)

    monkeypatch.setattr("apps.api.main.httpx.get", fake_get)
    return TestClient(create_app(state_path=tmp_path / "state.db"))


def test_workshop_catalog_projects_published_entries(monkeypatch, tmp_path):
    captured: dict[str, Any] = {}
    client = _client(monkeypatch, tmp_path, captured=captured)
    r = client.get("/api/plugins/workshop-catalog")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["source"] == "clawhunt_workshop"
    assert body["total"] == 3
    # Upstream targeted ClawHunt's public, allowlisted endpoint.
    assert captured["url"].endswith("/v1/capabilities/published")

    plugin = next(p for p in body["plugins"] if p["plugin_id"] == "leon.demo.plugin")
    # Single-language ClawHunt text wrapped into the surface's {en, zh} shape.
    assert plugin["name"] == {"en": "Leon Demo Plugin", "zh": "Leon Demo Plugin"}
    assert plugin["summary"] == {"en": "A reviewed plugin.", "zh": "A reviewed plugin."}
    assert plugin["kind"] == "plugin"
    assert plugin["icon"] == "runtime"
    # Bilingual kind label, not an English string mirrored into both locales.
    assert plugin["category_label"] == {"en": "Plugin", "zh": "插件"}
    # ``verified`` is the kernel's developer-signature signal, passed through
    # unchanged; review state lives in capability_status.
    assert plugin["verified"] is True
    assert plugin["signature_verified"] is True
    # The official co-signature MATERIAL (signature + signer keyid) is projected as
    # opaque, UNVERIFIED evidence for a downstream verifier — not dropped (the prior
    # bug). The API only exposes evidence; it asserts NO trust. A surface must NOT
    # render "official" from this projection (that comes from the kernel's
    # verification-derived trust state, never from this feed).
    assert plugin["official_signature"] == "ed25519:Zm9vYmFyc2ln"
    assert plugin["official_signer_keyid"] == "sha256:cd61575d"
    # ClawHunt's self-reported official verdict is NEVER projected (see below).
    assert "signature_verified_official" not in plugin
    assert plugin["capability_status"] == "published"
    assert plugin["instantiable"] is True
    assert plugin["source"] == "clawhunt_workshop"

    skill = next(p for p in body["plugins"] if p["plugin_id"] == "leon.demo.skill")
    assert skill["kind"] == "skill"
    assert skill["skill_origin"] is True
    assert skill["icon"] == "developer"
    # An approved-but-unsigned capability is NEVER shown as verified: the surface
    # passes the kernel's verified=false through, instead of overloading it with
    # review-approval. capability_status still reflects the approved lifecycle.
    assert skill["verified"] is False
    assert skill["signature_verified"] is False
    # An entry WITHOUT official co-signature material projects None evidence (never a
    # spoofed signal), and still carries no self-reported official verdict.
    assert skill["official_signature"] is None
    assert skill["official_signer_keyid"] is None
    assert "signature_verified_official" not in skill
    assert skill["capability_status"] == "approved"

    # Company templates keep their kind (not downgraded to plugin) and are marked
    # non-instantiable so the surface never offers them as installable packages.
    company = next(p for p in body["plugins"] if p["plugin_id"] == "leon.demo.company")
    assert company["kind"] == "company"
    assert company["instantiable"] is False
    assert company["skill_origin"] is False
    assert company["verified"] is False
    assert company["category_label"] == {"en": "Company", "zh": "公司"}


def test_workshop_catalog_forwards_kind_filter(monkeypatch, tmp_path):
    captured: dict[str, Any] = {}
    client = _client(monkeypatch, tmp_path, captured=captured)
    r = client.get("/api/plugins/workshop-catalog?kind=skill")
    assert r.status_code == 200, r.text
    assert captured["params"] == {"kind": "skill"}


def test_self_reported_official_verdict_is_never_projected(monkeypatch, tmp_path):
    """ClawHunt's self-reported ``signature_verified_official`` MUST NOT appear in the
    projection — even when the upstream feed sets it to a genuine ``True``. Echoing a
    verified-shaped official boolean from a feed a MITM could poison would let a
    surface treat unverified data as endorsement. Only the opaque signature/keyid
    material (which a verifier must check against the baked key) is carried.
    """
    payload = {
        "entries": [
            {"kind": "plugin", "capability_id": "p.claims.true", "version": "1.0.0",
             "status": "published", "signature_verified_official": True,
             "official_signature": "ed25519:AAA", "official_signer_keyid": "sha256:11"},
            {"kind": "plugin", "capability_id": "p.claims.string", "version": "1.0.0",
             "status": "published", "signature_verified_official": "true"},
        ],
    }
    client = _client(monkeypatch, tmp_path, fake_payload=payload)
    plugins = {p["plugin_id"]: p for p in client.get("/api/plugins/workshop-catalog").json()["plugins"]}
    # The self-reported verdict is dropped regardless of upstream value/type.
    assert "signature_verified_official" not in plugins["p.claims.true"]
    assert "signature_verified_official" not in plugins["p.claims.string"]
    # Opaque evidence is still carried verbatim for an independent verifier.
    assert plugins["p.claims.true"]["official_signature"] == "ed25519:AAA"
    assert plugins["p.claims.true"]["official_signer_keyid"] == "sha256:11"


def test_official_evidence_non_string_is_dropped(monkeypatch, tmp_path):
    """Untrusted-feed type poisoning: if a poisoned entry swaps the opaque string
    signature/keyid for a structured value (dict/list/number), it must NOT pass
    through structurally to the strongly-typed surface — it fails closed to None.
    """
    payload = {
        "entries": [
            {"kind": "plugin", "capability_id": "p.poison", "version": "1.0.0",
             "status": "published",
             "official_signature": {"$inject": "x"}, "official_signer_keyid": ["a", "b"],
             "signer_keyid": {"$inject": "dev"}},
        ],
    }
    client = _client(monkeypatch, tmp_path, fake_payload=payload)
    plugin = client.get("/api/plugins/workshop-catalog").json()["plugins"][0]
    assert plugin["official_signature"] is None
    assert plugin["official_signer_keyid"] is None
    # The developer signer_keyid passes through the same fail-closed coercion.
    assert plugin["signer_keyid"] is None


def test_workshop_catalog_fails_closed_on_upstream_error(monkeypatch, tmp_path):
    client = _client(monkeypatch, tmp_path, status_code=503)
    r = client.get("/api/plugins/workshop-catalog")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["source"] == "unavailable"
    assert body["plugins"] == []
    assert body["total"] == 0
    assert body["error"]


# Real ClawHunt-signed official co-signature (product official key) — same golden
# vector as tests/test_capability_cosign.py, exercised through the HTTP endpoint.
_GOLDEN_PUB = "za6+eU91Bswm6PGqAxjeSYQu6UG6NIiNG6grhtcfwcY="
_GOLDEN_KEYID = "sha256:74126f70d0f5bb6a73bc66b0a23718c3fb0ea84a01494c7f3a55a0812e058675"
_GOLDEN_SIG = "ed25519:4qhW2MU090A1hqQ43ZATm6ob9zakvrZBiIH0R5nugAEaOCODik9yzY2pi3Q5ZTKGXogxSJTVZzWU6VbkrJOWAw=="
_GOLDEN_FEED = {
    "entries": [
        {  # genuinely officially co-signed -> verified -> trust 'official'
            "kind": "plugin", "capability_id": "dev.demo.net", "version": "1.0.0",
            "status": "published",
            "package_digest": "sha256:" + ("ab" * 32),
            "artifact_ref": "superclaw-object://capabilities/plugin/dev.demo.net/versions/1.0.0/package.scplug",
            "official_signature": _GOLDEN_SIG, "official_signer_keyid": _GOLDEN_KEYID,
        },
        {  # claims an official verdict but has NO real signature -> never 'official'
            "kind": "plugin", "capability_id": "dev.demo.fake", "version": "1.0.0",
            "status": "published",
            "package_digest": "sha256:" + ("cd" * 32),
            "artifact_ref": "superclaw-object://capabilities/plugin/dev.demo.fake/versions/1.0.0/package.scplug",
            "signature_verified_official": True,  # self-reported lie — must be ignored
        },
    ],
}


def test_official_trust_only_when_cosignature_verifies_locally(monkeypatch, tmp_path):
    """The marketplace ``trust: 'official'`` is set ONLY for an entry whose official
    co-signature re-verifies against the LOCALLY-baked official key — never from a
    self-reported feed flag. The baked key is supplied via the per-env resolver."""
    monkeypatch.setattr("apps.api.main.official_root_public_key", lambda: _GOLDEN_PUB)
    client = _client(monkeypatch, tmp_path, fake_payload=_GOLDEN_FEED)
    plugins = {p["plugin_id"]: p for p in client.get("/api/plugins/workshop-catalog").json()["plugins"]}
    # Real co-signature verified locally -> official trust (lights the badge).
    assert plugins["dev.demo.net"]["trust"] == "official"
    # Self-reported "official" with no verifiable signature -> NO official trust.
    assert plugins["dev.demo.fake"]["trust"] is None


def test_no_official_trust_when_no_key_baked(monkeypatch, tmp_path):
    """Production pre-bake (empty baked key) -> even a real signature can't be
    verified locally, so nothing is marked official (fail-closed)."""
    monkeypatch.setattr("apps.api.main.official_root_public_key", lambda: "")
    client = _client(monkeypatch, tmp_path, fake_payload=_GOLDEN_FEED)
    plugins = {p["plugin_id"]: p for p in client.get("/api/plugins/workshop-catalog").json()["plugins"]}
    assert plugins["dev.demo.net"]["trust"] is None
    assert plugins["dev.demo.fake"]["trust"] is None
