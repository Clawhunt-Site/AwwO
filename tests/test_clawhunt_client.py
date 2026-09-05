import json

import httpx
import pytest

from superclaw.clawhunt import (
    ClawHuntClient,
    ClawHuntSettings,
    browse_has_more,
    extract_problem_items,
    extract_problem_payload,
)
from superclaw.clawhunt_auth import ClawHuntAccountClient, ClawHuntAccountSettings
from superclaw.protocol_adapter import build_clawhunt_submission_payload


def test_client_masks_authorization_and_calls_v1_surfaces():
    requests = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        assert request.headers["Authorization"] == "Bearer " + "redacted-agent-key"
        if request.url.path == "/api/v1/problems":
            if request.method == "POST":
                return httpx.Response(201, json={"id": 2})
            return httpx.Response(200, json={"problems": [{"id": 1, "title": "Task"}]})
        if request.url.path == "/api/v1/problems/1":
            return httpx.Response(200, json={"id": 1})
        if request.url.path == "/api/v1/problems/1/claim":
            return httpx.Response(200, json={"claimed": True})
        if request.url.path == "/api/v1/problems/1/bid":
            return httpx.Response(200, json={"bid": True})
        if request.url.path == "/api/v1/problems/1/solution":
            assert json.loads(request.content)["solution_text"] == "done"
            return httpx.Response(200, json={"success": True})
        if request.url.path == "/api/v1/problems/1/accept":
            return httpx.Response(200, json={"accepted": True})
        if request.url.path == "/api/v1/problems/1/accept-bid":
            assert json.loads(request.content)["bid_id"] == 3
            return httpx.Response(200, json={"accepted_bid": True})
        if request.url.path == "/api/v1/problems/1/bids":
            return httpx.Response(200, json={"bids": []})
        if request.url.path == "/api/v1/wallet":
            return httpx.Response(200, json={"balance": 10})
        if request.url.path == "/api/v1/capability-probe/status":
            return httpx.Response(200, json={"ready": True})
        if request.url.path == "/api/v1/me":
            return httpx.Response(200, json={"id": "agent"})
        if request.url.path == "/api/v1/skills":
            return httpx.Response(200, json=[])
        if request.url.path == "/api/v1/memories":
            return httpx.Response(200, json=[])
        if request.url.path == "/api/v1/problems/1/subtasks":
            return httpx.Response(200, json=[])
        return httpx.Response(404, json={"detail": "missing"})

    client = ClawHuntClient(
        ClawHuntSettings(base_url="https://clawhunt.test", agent_api_key="redacted-agent-key"),
        transport=httpx.MockTransport(handler),
    )

    assert client.browse()["body"]["problems"][0]["id"] == 1
    assert client.get_problem(1)["body"]["id"] == 1
    assert client.post_problem({"title": "New"})["status_code"] == 201
    assert client.bid(1, amount=10, message="Ready")["body"]["bid"] is True
    assert client.claim(1)["body"]["claimed"] is True
    assert client.submit_solution(1, "done")["body"]["success"] is True
    assert client.accept(1)["body"]["accepted"] is True
    assert client.accept_bid(1, 3)["body"]["accepted_bid"] is True
    assert client.get_problem_bids(1)["body"]["bids"] == []
    assert client.wallet()["body"]["balance"] == 10
    assert client.capability_probe_status()["body"]["ready"] is True
    assert client.me()["body"]["id"] == "agent"
    assert client.skills()["status_code"] == 200
    assert client.memories()["status_code"] == 200
    assert client.subtasks(1)["status_code"] == 200
    assert "redacted-agent-key" not in repr(client)
    assert [request.url.path for request in requests] == [
        "/api/v1/problems",
        "/api/v1/problems/1",
        "/api/v1/problems",
        "/api/v1/problems/1/bid",
        "/api/v1/problems/1/claim",
        "/api/v1/problems/1/solution",
        "/api/v1/problems/1/accept",
        "/api/v1/problems/1/accept-bid",
        "/api/v1/problems/1/bids",
        "/api/v1/wallet",
        "/api/v1/capability-probe/status",
        "/api/v1/me",
        "/api/v1/skills",
        "/api/v1/memories",
        "/api/v1/problems/1/subtasks",
    ]


def test_browse_maps_pagination_and_status_to_clawhunt_wire_params():
    # ClawHunt's GET /api/v1/problems reads `offset` and `status_filter`; SuperClaw's
    # CLI/API speak `skip`/`status`. browse() must translate at the boundary, or
    # FastAPI silently drops the unknown params (pagination stuck at page 1, status
    # filter ignored). Regression guard for that mismatch.
    captured: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured.update(dict(request.url.params))
        return httpx.Response(200, json={"success": True, "data": {"problems": []}})

    client = ClawHuntClient(
        ClawHuntSettings(base_url="https://clawhunt.test", agent_api_key="k"),
        transport=httpx.MockTransport(handler),
    )

    # Second page with an explicit status filter.
    client.browse(skip=24, limit=12, status="open")
    assert captured == {"offset": "24", "limit": "12", "status_filter": "open"}
    # The pre-translation names must never reach the wire.
    assert "skip" not in captured
    assert "status" not in captured

    # No status -> no status_filter, so ClawHunt applies its open,bidding default.
    captured.clear()
    client.browse(skip=0, limit=50)
    assert captured == {"offset": "0", "limit": "50"}
    assert "status_filter" not in captured


def test_browse_public_hits_anonymous_web_endpoint_without_agent_key():
    # The dock browses ClawHunt's public web list (GET /api/problems/, trailing
    # slash) anonymously: skip/status pass through verbatim (no offset/status_filter
    # rename) and, crucially, the agent Bearer is NOT sent — the market must show
    # without a linked key. A short page there is the genuine end (no post-filter).
    seen: list[dict[str, object]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(
            {
                "path": request.url.path,
                "params": dict(request.url.params),
                "has_auth": "authorization" in {k.lower() for k in request.headers},
            }
        )
        if request.url.path == "/api/problems/":
            return httpx.Response(200, json=[{"id": 1, "title": "Public task", "status": "open"}])
        # Public detail returns the problem object directly.
        return httpx.Response(200, json={"id": 1, "title": "Public task", "status": "open"})

    # An agent key IS configured — yet browse_public must not attach it.
    client = ClawHuntClient(
        ClawHuntSettings(base_url="https://clawhunt.test", agent_api_key="cph_should_not_be_sent"),
        transport=httpx.MockTransport(handler),
    )

    body = client.browse_public(skip=12, limit=12, status="open")["body"]
    assert isinstance(body, list) and body[0]["id"] == 1
    detail = client.get_problem_public(1)
    assert detail["body"]["id"] == 1

    assert seen[0]["path"] == "/api/problems/"
    assert seen[0]["params"] == {"skip": "12", "limit": "12", "status": "open"}
    assert seen[1]["path"] == "/api/problems/1"
    # Anonymous: no Authorization header on either public call, despite the key.
    assert all(entry["has_auth"] is False for entry in seen)


def _record_handler(seen: list[dict[str, object]]):
    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(
            {"path": request.url.path, "has_auth": "authorization" in {k.lower() for k in request.headers}}
        )
        if request.url.path.endswith("/problems/") or request.url.path == "/api/v1/problems":
            return httpx.Response(200, json=[{"id": 1}] if request.url.path == "/api/problems/" else {"problems": []})
        return httpx.Response(200, json={"id": 1})

    return handler


def test_browse_marketplace_auto_routes_on_linked_key():
    # Context-aware: no agent key -> anonymous public board (market shows without a
    # login); a linked key -> the agent-gated personalized listing (with Bearer).
    # The `public` override forces either side. This is the dock's + CLI's shared
    # selection logic, so a solver never loses its privileged view to a hard route.
    anon_seen: list[dict[str, object]] = []
    anon = ClawHuntClient(
        ClawHuntSettings(base_url="https://clawhunt.test", agent_api_key=None),
        transport=httpx.MockTransport(_record_handler(anon_seen)),
    )
    anon.browse_marketplace(skip=0, limit=5)
    anon.get_problem_marketplace(1)
    assert [e["path"] for e in anon_seen] == ["/api/problems/", "/api/problems/1"]
    assert all(e["has_auth"] is False for e in anon_seen)  # anonymous

    keyed_seen: list[dict[str, object]] = []
    keyed = ClawHuntClient(
        ClawHuntSettings(base_url="https://clawhunt.test", agent_api_key="cph_live"),
        transport=httpx.MockTransport(_record_handler(keyed_seen)),
    )
    keyed.browse_marketplace(skip=0, limit=5)
    keyed.get_problem_marketplace(1)
    assert [e["path"] for e in keyed_seen] == ["/api/v1/problems", "/api/v1/problems/1"]
    assert all(e["has_auth"] is True for e in keyed_seen)  # agent-gated, key sent

    # Explicit override beats the auto choice: a keyed client forced public stays anon.
    forced_seen: list[dict[str, object]] = []
    forced = ClawHuntClient(
        ClawHuntSettings(base_url="https://clawhunt.test", agent_api_key="cph_live"),
        transport=httpx.MockTransport(_record_handler(forced_seen)),
    )
    forced.browse_marketplace(skip=0, limit=5, public=True)
    assert forced_seen[0]["path"] == "/api/problems/"
    assert forced_seen[0]["has_auth"] is False


def test_live_probe_shape_uses_read_only_endpoints():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.path)
        if request.url.path == "/health":
            return httpx.Response(200, json={"status": "ok"})
        if request.url.path == "/api/pay-switch/config":
            return httpx.Response(200, json={"base_url": "https://payswitch.example"})
        if request.url.path == "/api/pay-switch/health":
            return httpx.Response(502, json={"reachable": False})
        if str(request.url).startswith("https://payswitch.example/api/health"):
            return httpx.Response(200, json={"ok": True})
        if request.url.path == "/api/v1/problems":
            return httpx.Response(401, json={"detail": "Missing or invalid Authorization header"})
        return httpx.Response(404)

    client = ClawHuntClient(
        ClawHuntSettings(base_url="https://clawhunt.test", agent_api_key=None),
        transport=httpx.MockTransport(handler),
    )

    probe = client.live_read_only_probe()

    assert probe["clawhunt_health"]["status_code"] == 200
    assert probe["pay_switch_proxy_health"]["status_code"] == 502
    assert probe["pay_switch_direct_health"]["status_code"] == 200
    assert probe["protected_api_shape"]["status_code"] == 401
    assert seen[:5] == [
        "/health",
        "/api/pay-switch/config",
        "/api/pay-switch/health",
        "/api/pay-switch/health",
        "/api/v1/problems",
    ]
    assert seen[-1] == "/api/health"


def test_account_client_uses_clawhunt_account_auth_surfaces():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.method, request.url.path, request.headers.get("Authorization"), dict(request.url.params)))
        if request.url.path == "/api/auth/login":
            credentials = json.loads(request.content)
            if credentials["username"] == "__superclaw_login_probe__":
                return httpx.Response(401, json={"detail": "用户名或密码错误"})
            assert credentials == {"username": "leon", "password": "secret"}
            return httpx.Response(200, json={"access_token": "account-token", "user": {"username": "leon"}})
        assert request.headers["Authorization"] == "Bearer account-token"
        if request.url.path == "/api/auth/me":
            return httpx.Response(200, json={"username": "leon"})
        if request.url.path == "/api/agents/my/agents":
            return httpx.Response(200, json={"agents": [{"id": 12, "name": "desktop-agent"}]})
        if request.url.path == "/api/auth/agent-keys":
            if request.method == "GET":
                assert request.url.params["active_only"] == "true"
                return httpx.Response(200, json={"keys": [{"id": 1, "key_prefix": "cph_"}]})
            assert json.loads(request.content) == {"name": "SuperClaw Desktop", "agent_id": 12, "permissions": ["browse"]}
            return httpx.Response(201, json={"key": "cph_generated_123"})
        return httpx.Response(404)

    client = ClawHuntAccountClient(
        ClawHuntAccountSettings(base_url="https://clawhunt.test"),
        transport=httpx.MockTransport(handler),
    )

    assert client.login("leon", "secret")["body"]["access_token"] == "account-token"
    assert client.login_probe()["status_code"] == 401
    assert client.me("account-token")["body"]["username"] == "leon"
    assert client.agents("account-token")["body"]["agents"][0]["id"] == 12
    assert client.agent_keys("account-token")["body"]["keys"][0]["key_prefix"] == "cph_"
    assert client.create_agent_key("account-token", name="SuperClaw Desktop", agent_id=12, permissions=["browse"])["body"]["key"] == "cph_generated_123"
    assert [item[1] for item in seen] == [
        "/api/auth/login",
        "/api/auth/login",
        "/api/auth/me",
        "/api/agents/my/agents",
        "/api/auth/agent-keys",
        "/api/auth/agent-keys",
    ]


def test_live_readiness_report_classifies_read_only_gate_without_mutations():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.method, request.url.path))
        if request.url.path == "/health":
            return httpx.Response(200, json={"status": "ok"})
        if request.url.path == "/api/pay-switch/config":
            return httpx.Response(200, json={"base_url": "https://payswitch.example"})
        if request.url.path == "/api/pay-switch/health":
            return httpx.Response(502, json={"reachable": False})
        if str(request.url).startswith("https://payswitch.example/api/health"):
            return httpx.Response(200, json={"ok": True})
        if request.url.path == "/api/v1/problems":
            assert "authorization" not in request.headers
            return httpx.Response(401, json={"detail": "Missing or invalid Authorization header"})
        return httpx.Response(404)

    client = ClawHuntClient(
        ClawHuntSettings(base_url="https://clawhunt.test", agent_api_key=None),
        transport=httpx.MockTransport(handler),
    )

    report = client.live_readiness_report()

    assert report["status"] == "partial"
    assert report["readiness"]["read_only_gate"] is True
    assert report["readiness"]["payment_path"] is False
    assert report["requirements"]["mutating_operations_attempted"] is False
    assert "submit_solution" in report["requirements"]["mutating_operations_blocked_by_design"]
    assert {check["id"] for check in report["checks"]} >= {
        "clawhunt_public_health",
        "protected_api_fails_closed",
        "submission_protocol_sample",
        "pay_switch_proxy_health",
    }
    assert all(method == "GET" for method, _ in seen)


def test_live_readiness_report_can_summarize_authenticated_read_only_surfaces():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.method, request.url.path, request.headers.get("authorization")))
        if request.url.path == "/health":
            return httpx.Response(200, json={"status": "ok"})
        if request.url.path == "/api/pay-switch/config":
            return httpx.Response(200, json={"base_url": "https://payswitch.example"})
        if request.url.path == "/api/pay-switch/health":
            return httpx.Response(200, json={"reachable": True})
        if str(request.url).startswith("https://payswitch.example/api/health"):
            return httpx.Response(200, json={"ok": True})
        if request.url.path == "/api/v1/problems" and "authorization" not in request.headers:
            return httpx.Response(401, json={"detail": "Missing or invalid Authorization header"})
        if request.url.path == "/api/v1/me":
            return httpx.Response(200, json={"id": "agent", "name": "SuperClaw"})
        if request.url.path == "/api/v1/capability-probe/status":
            return httpx.Response(200, json={"ready": True})
        if request.url.path == "/api/v1/problems":
            assert request.headers["authorization"] == "Bearer redacted-agent-key"
            return httpx.Response(200, json={"problems": [{"id": 1, "title": "Task"}]})
        return httpx.Response(404)

    client = ClawHuntClient(
        ClawHuntSettings(base_url="https://clawhunt.test", agent_api_key="redacted-agent-key"),
        transport=httpx.MockTransport(handler),
    )

    report = client.live_readiness_report(authenticated_read=True)

    assert report["status"] == "ready"
    assert report["credentials"]["agent_api_key"] == "set"
    assert report["readiness"]["authenticated_read"] is True
    assert report["authenticated_probe"]["responses"]["me"] == {
        "status_code": 200,
        "ok": True,
        "body_type": "object",
        "body_keys": ["id", "name"],
    }
    assert all(method == "GET" for method, _, _ in seen)
    assert ("POST", "/api/v1/problems", "Bearer redacted-agent-key") not in seen


def test_live_readiness_report_blocks_requested_authenticated_probe_without_key():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/health":
            return httpx.Response(200, json={"status": "ok"})
        if request.url.path == "/api/pay-switch/config":
            return httpx.Response(200, json={"base_url": "https://payswitch.example"})
        if request.url.path == "/api/pay-switch/health":
            return httpx.Response(200, json={"reachable": True})
        if str(request.url).startswith("https://payswitch.example/api/health"):
            return httpx.Response(200, json={"ok": True})
        if request.url.path == "/api/v1/problems":
            return httpx.Response(401, json={"detail": "Missing or invalid Authorization header"})
        return httpx.Response(404)

    client = ClawHuntClient(
        ClawHuntSettings(base_url="https://clawhunt.test", agent_api_key=None),
        transport=httpx.MockTransport(handler),
    )

    report = client.live_readiness_report(authenticated_read=True)

    assert report["status"] == "blocked"
    assert report["readiness"]["authenticated_read"] is False
    auth_check = next(check for check in report["checks"] if check["id"] == "authenticated_read_probe")
    assert auth_check["passed"] is False


def test_client_submit_solution_accepts_protocol_adapter_payload():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["json"] = json.loads(request.content)
        return httpx.Response(200, json={"success": True})

    client = ClawHuntClient(
        ClawHuntSettings(base_url="https://clawhunt.test", agent_api_key="redacted-agent-key"),
        transport=httpx.MockTransport(handler),
    )
    submission = build_clawhunt_submission_payload(
        solution_text="done",
        evidence={"run_id": "run_1", "commands": [], "probes": [], "artifacts": [], "findings": [], "worker_results": [], "chain_verdict": "CHAIN_PARTIAL"},
        attachments=["superclaw-run:run_1"],
        package_manifest={"version": 1},
    )

    response = client.submit_solution(1, submission)

    assert response["body"]["success"] is True
    assert seen["json"] == {
        "solution_text": "done",
        "attachments": ["superclaw-run:run_1"],
        "evidence": {
            "run_id": "run_1",
            "commands": [],
            "probes": [],
            "artifacts": [],
            "findings": [],
            "worker_results": [],
            "chain_verdict": "CHAIN_PARTIAL",
        },
    }


# --- single-source browse parsers (dock + governed marketplace handler share these) ---


@pytest.mark.parametrize(
    "body,expected",
    [
        # bare list
        ([{"id": 1, "title": "a"}, {"id": 2, "title": "b"}], 2),
        # bare list with non-dict noise filtered out
        ([{"id": 1, "title": "a"}, "junk", None], 1),
        # flat `problems` key
        ({"problems": [{"id": 1, "title": "a"}]}, 1),
        # nested `data` envelope (the shape a list-only walk under-counted to 0)
        ({"success": True, "data": {"problems": [{"id": 1, "title": "a"}, {"id": 2, "title": "b"}]}}, 2),
        # nested `result` envelope under `items`
        ({"result": {"items": [{"id": 9, "name": "x"}]}}, 1),
        # single problem payload (id + title) → list of one
        ({"id": 7, "title": "solo"}, 1),
        # single payload nested under `data`
        ({"data": {"problem": {"id": 7, "title": "solo"}}}, 1),
        # empty / unrecognised shapes → 0
        ({}, 0),
        ({"success": True, "data": {}}, 0),
        (None, 0),
        ("nonsense", 0),
    ],
)
def test_extract_problem_items_handles_every_browse_shape(body, expected):
    assert len(extract_problem_items(body)) == expected


def test_extract_problem_payload_recurses_envelope():
    assert extract_problem_payload({"data": {"id": 3, "summary": "s"}}) == {"id": 3, "summary": "s"}
    # id alone is not enough — needs a descriptive field too
    assert extract_problem_payload({"id": 3}) is None
    assert extract_problem_payload([{"id": 1, "title": "a"}]) is None  # list is not a single payload


@pytest.mark.parametrize(
    "body,count,limit,expected",
    [
        # explicit upstream has_more wins over the heuristic, both ways
        ({"data": {"has_more": True}}, 1, 50, True),
        ({"data": {"has_more": False}}, 50, 50, False),  # full page but upstream says no more
        ({"has_more": True}, 0, 50, True),
        ({"result": {"has_more": False}}, 50, 50, False),
        # upstream omitted → full-page heuristic
        ({"problems": []}, 50, 50, True),   # page is full → maybe more
        ({"problems": []}, 3, 50, False),   # short page → that's all
        ([], 0, 50, False),
    ],
)
def test_browse_has_more_prefers_upstream_then_falls_back(body, count, limit, expected):
    assert browse_has_more(body, count, limit) is expected
