import json

from fastapi.testclient import TestClient

from apps.api.main import create_app


def _client(monkeypatch, tmp_path):
    monkeypatch.setenv("SUPERCLAW_CONTROL_TOKEN", "tkn")
    monkeypatch.setenv("SUPERCLAW_CLAWHUNT_AUTH_PATH", str(tmp_path / "auth.json"))
    return TestClient(create_app(state_path=tmp_path / "state.db"))


def _h():
    return {"X-SuperClaw-Token": "tkn"}


def _mock_packages(monkeypatch, packages):
    # The handler does a function-local ``from superclaw.relay_packages import relay_packages``,
    # so the correct mock target is the kernel module attribute (apps.api.main has no
    # module-level relay_packages).
    import superclaw.relay_packages as rp
    monkeypatch.setattr(rp, "relay_packages", lambda: packages)


def test_relay_packages_marks_locked_above_ceiling(monkeypatch, tmp_path):
    """issue #452: packages above the account ceiling get locked=True + a tier_ceiling
    field so the Web surface greys them out with zero client-side tier math; the verdict
    is the kernel is_tier_locked (same source as the run clamp)."""
    _mock_packages(monkeypatch, {
        "packages": [
            {"id": "core", "name": "core", "tier": "core", "group_slug": "superclaw-core"},
            {"id": "plus", "name": "Plus", "tier": "plus", "group_slug": "superclaw-plus"},
            {"id": "max", "name": "Max", "tier": "max", "group_slug": "superclaw-max"},
        ],
        "source": "catalog", "available": True,
    })
    (tmp_path / "auth.json").write_text(
        json.dumps({"access_token": "tok", "superclaw_tier_ceiling": "plus"}), encoding="utf-8"
    )
    body = _client(monkeypatch, tmp_path).get("/api/relay/packages", headers=_h()).json()
    assert body["tier_ceiling"] == "plus"
    assert {p["id"]: p["locked"] for p in body["packages"]} == {"core": False, "plus": False, "max": True}


def test_relay_packages_unlogged_locks_nothing(monkeypatch, tmp_path):
    """Unlogged (no unlock ceiling): tier_ceiling=None and nothing is locked — the surface
    never clamps without an account ceiling (LLMgate / balance is the gate)."""
    _mock_packages(monkeypatch, {
        "packages": [
            {"id": "core", "name": "core", "tier": "core", "group_slug": "superclaw-core"},
            {"id": "max", "name": "Max", "tier": "max", "group_slug": "superclaw-max"},
        ],
        "source": "default", "available": False,
    })
    body = _client(monkeypatch, tmp_path).get("/api/relay/packages", headers=_h()).json()
    assert body["tier_ceiling"] is None
    assert all(p["locked"] is False for p in body["packages"])
