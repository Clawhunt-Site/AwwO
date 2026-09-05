"""PR3 — Goal Mode REST API parity (docs/goal-mode-design.md).

The /api/goals/* endpoints are a thin projection of the SAME goal_mode kernel the
CLI drives (铁律1/2). These tests assert the lifecycle round-trips over HTTP, the
error codes match the design (404 missing / 409 revision|conflict / 422 roster),
and a dry-run confirm+start works end to end.
"""

from fastapi.testclient import TestClient

from apps.api.main import create_app

HEADERS = {"X-SuperClaw-Token": "secret-control"}


def _client(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_CONTROL_TOKEN", "secret-control")
    return TestClient(create_app(state_path=tmp_path / "state.db"))


def test_goals_require_control_token(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)
    assert client.get("/api/goals").status_code == 401


def test_plan_confirm_no_start_round_trip(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)
    planned = client.post(
        "/api/goals/plan",
        headers=HEADERS,
        json={"title": "Add /health", "description": "ok"},
    )
    assert planned.status_code == 200, planned.text
    body = planned.json()
    assert body["confirmation_required"] is True
    goal = body["goal"]
    assert goal["status"] == "awaiting_confirmation"
    gid, ph = goal["spec"]["goal_id"], goal["plan_hash"]

    got = client.get(f"/api/goals/{gid}/record", headers=HEADERS)
    assert got.status_code == 200
    assert got.json()["spec"]["goal_id"] == gid

    confirmed = client.post(
        f"/api/goals/{gid}/confirm",
        headers=HEADERS,
        json={
            "revision": 1,
            "plan_hash": ph,
            "roster": [{"source": "backend", "backend": "claude"}],
            "start": False,
        },
    )
    assert confirmed.status_code == 200, confirmed.text
    assert confirmed.json()["goal"]["status"] == "active"


def test_confirm_stale_plan_hash_is_409(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)
    gid = client.post("/api/goals/plan", headers=HEADERS, json={"title": "t"}).json()["goal"]["spec"]["goal_id"]
    res = client.post(
        f"/api/goals/{gid}/confirm",
        headers=HEADERS,
        json={"revision": 1, "plan_hash": "sha256:wrong", "start": False},
    )
    assert res.status_code == 409, res.text


def test_confirm_stale_revision_is_409(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)
    body = client.post("/api/goals/plan", headers=HEADERS, json={"title": "t"}).json()["goal"]
    gid, ph = body["spec"]["goal_id"], body["plan_hash"]
    res = client.post(
        f"/api/goals/{gid}/confirm",
        headers=HEADERS,
        json={"revision": 0, "plan_hash": ph, "start": False},  # wrong revision
    )
    assert res.status_code == 409, res.text


def test_confirm_multi_entry_roster_is_422(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)
    body = client.post("/api/goals/plan", headers=HEADERS, json={"title": "t"}).json()["goal"]
    gid, ph = body["spec"]["goal_id"], body["plan_hash"]
    res = client.post(
        f"/api/goals/{gid}/confirm",
        headers=HEADERS,
        json={
            "revision": 1,
            "plan_hash": ph,
            "roster": [{"source": "backend", "backend": "a"}, {"source": "backend", "backend": "b"}],
            "start": False,
        },
    )
    assert res.status_code == 422, res.text


def test_missing_goal_is_404(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)
    assert client.get("/api/goals/goal_nope/record", headers=HEADERS).status_code == 404


def test_revise_replan_loop_over_http(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)
    gid = client.post("/api/goals/plan", headers=HEADERS, json={"title": "t"}).json()["goal"]["spec"]["goal_id"]
    revised = client.post(f"/api/goals/{gid}/revise", headers=HEADERS, json={"revision": 1})
    assert revised.status_code == 200 and revised.json()["status"] == "draft"
    replanned = client.post(
        f"/api/goals/{gid}/replan", headers=HEADERS, json={"revision": 2, "description": "v2"}
    )
    assert replanned.status_code == 200 and replanned.json()["status"] == "awaiting_confirmation"


def test_confirm_with_dry_run_start(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)
    body = client.post("/api/goals/plan", headers=HEADERS, json={"title": "t"}).json()["goal"]
    gid, ph = body["spec"]["goal_id"], body["plan_hash"]
    res = client.post(
        f"/api/goals/{gid}/confirm",
        headers=HEADERS,
        json={
            "revision": 1,
            "plan_hash": ph,
            "roster": [{"source": "backend", "backend": "claude"}],
            "start": True,
            "dry_run": True,
        },
    )
    assert res.status_code == 200, res.text
    out = res.json()
    # PR5: a successful (dry) run flips the goal to complete via the derived gate.
    assert out["goal"]["status"] == "complete"
    assert out["run"]["goal_id"] == gid


def test_confirm_multi_agent_role_roster(tmp_path, monkeypatch):
    # PR4: a multi-entry roster (lead + a role binding) is accepted over HTTP and the
    # confirmed roster carries the per-slot agent binding.
    client = _client(tmp_path, monkeypatch)
    body = client.post("/api/goals/plan", headers=HEADERS, json={"title": "t"}).json()["goal"]
    gid, ph = body["spec"]["goal_id"], body["plan_hash"]
    res = client.post(
        f"/api/goals/{gid}/confirm",
        headers=HEADERS,
        json={
            "revision": 1,
            "plan_hash": ph,
            "roster": [
                {"source": "backend", "backend": "claude"},
                {"source": "backend", "role": "implement", "backend": "codex", "model": "gpt-5.5"},
            ],
            "start": False,
        },
    )
    assert res.status_code == 200, res.text
    entries = res.json()["goal"]["roster"]["entries"]
    impl = [e for e in entries if e.get("role") == "implement"]
    assert impl and impl[0]["backend"] == "codex"


def test_confirm_uncovered_role_roster_is_422(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)
    body = client.post("/api/goals/plan", headers=HEADERS, json={"title": "t"}).json()["goal"]
    gid, ph = body["spec"]["goal_id"], body["plan_hash"]
    res = client.post(
        f"/api/goals/{gid}/confirm",
        headers=HEADERS,
        json={
            "revision": 1,
            "plan_hash": ph,
            # only a role binding, no lead -> other slots uncovered
            "roster": [{"source": "backend", "role": "implement", "backend": "codex"}],
            "start": False,
        },
    )
    assert res.status_code == 422, res.text


def test_confirm_unknown_backend_is_422(tmp_path, monkeypatch):
    # The API passes the live backend registry as known_backends, so a roster naming
    # a backend the server doesn't have is rejected fail-closed (铁律2).
    client = _client(tmp_path, monkeypatch)
    body = client.post("/api/goals/plan", headers=HEADERS, json={"title": "t"}).json()["goal"]
    gid, ph = body["spec"]["goal_id"], body["plan_hash"]
    res = client.post(
        f"/api/goals/{gid}/confirm",
        headers=HEADERS,
        json={"revision": 1, "plan_hash": ph, "roster": [{"source": "backend", "backend": "ghost-runtime"}], "start": False},
    )
    assert res.status_code == 422, res.text


def test_goals_contract_lists_statuses(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)
    contract = client.get("/api/goal-status-contract", headers=HEADERS).json()
    ids = {s["id"] for s in contract["statuses"]}
    assert {"draft", "awaiting_confirmation", "active", "complete"} <= ids
    assert "complete" in contract["terminal"]


def test_confirm_fanout_requires_budget_over_http(tmp_path, monkeypatch):
    # PR7: a concurrent IMPLEMENT_FANOUT plan needs a token budget; without one,
    # confirm is rejected (422); with one it confirms.
    client = _client(tmp_path, monkeypatch)
    planned = client.post(
        "/api/goals/plan", headers=HEADERS, json={"title": "t", "topology": "implement_fanout"}
    ).json()["goal"]
    gid, ph = planned["spec"]["goal_id"], planned["plan_hash"]
    no_budget = client.post(
        f"/api/goals/{gid}/confirm",
        headers=HEADERS,
        json={"revision": 1, "plan_hash": ph, "roster": [{"source": "backend", "backend": "claude"}], "start": False},
    )
    assert no_budget.status_code == 422, no_budget.text
    with_budget = client.post(
        f"/api/goals/{gid}/confirm",
        headers=HEADERS,
        json={
            "revision": 1, "plan_hash": ph,
            "roster": [{"source": "backend", "backend": "claude"}],
            "token_budget": 2000, "start": False,
        },
    )
    assert with_budget.status_code == 200, with_budget.text
    assert with_budget.json()["goal"]["budget_policy"]["token_budget"] == 2000


def test_autonomy_flag_and_continue_over_http(tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERCLAW_SHELL_CONFIG_PATH", str(tmp_path / "config.json"))
    client = _client(tmp_path, monkeypatch)
    # default OFF
    assert client.get("/api/goal-autonomy", headers=HEADERS).json()["goal_autonomous_continuation"] is False
    # enable
    on = client.post("/api/goal-autonomy", headers=HEADERS, json={"enabled": True})
    assert on.status_code == 200 and on.json()["goal_autonomous_continuation"] is True
    # continue tick with no confirmed goals -> empty, no error
    cont = client.post("/api/goals/continue", headers=HEADERS, json={})
    assert cont.status_code == 200 and cont.json()["continued"] == []
