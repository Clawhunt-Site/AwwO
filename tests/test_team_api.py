"""API surface tests for the Agent Team Kernel REST projection.

These prove the API is a faithful transport over the same kernel the CLI drives:
the happy path completes an issue through the approval gate, and the fail-closed
invariants (lock conflict, unknown entity) surface as the kernel's error codes
(409 / 404) rather than being silently absorbed by the surface.
"""

from fastapi.testclient import TestClient

from apps.api.main import create_app
from superclaw.models import ContinuationPolicy, IssueInteractionKind, IssueThreadInteraction
from superclaw.state import StateStore


def _client(tmp_path):
    return TestClient(create_app(state_path=tmp_path / "state.db"))


def test_team_issue_lifecycle_through_api(tmp_path):
    client = _client(tmp_path)

    profile = client.post("/api/team/agents", json={"name": "Eng", "role": "engineer"}).json()
    pid = profile["profile"]["profile_id"]

    issue = client.post("/api/team/issues", json={"title": "Ship login"}).json()
    iid = issue["issue"]["issue_id"]

    assert client.post(f"/api/team/issues/{iid}/assign", json={"profile_id": pid}).status_code == 200
    checkout = client.post(f"/api/team/issues/{iid}/checkout", json={})
    assert checkout.status_code == 200
    assert checkout.json()["issue"]["status"] == "in_progress"

    submit = client.post(f"/api/team/issues/{iid}/submit", json={"summary": "ready"})
    assert submit.status_code == 200
    approval_id = submit.json()["approval"]["approval_id"]

    grant = client.post(f"/api/team/approvals/{approval_id}/grant", json={"by": "leon"})
    assert grant.status_code == 200
    assert grant.json()["issue"]["status"] == "done"

    # The lock released on completion.
    assert client.get("/api/team/locks").json()["count"] == 0


def test_team_double_checkout_conflicts_with_409(tmp_path):
    client = _client(tmp_path)
    pid = client.post("/api/team/agents", json={"name": "Eng", "role": "engineer"}).json()["profile"]["profile_id"]
    repo_a = client.post(
        "/api/team/workspaces", json={"name": "repoA", "repo_path": "."}
    ).json()["workspace"]["workspace_id"]

    def _assigned(title):
        iid = client.post("/api/team/issues", json={"title": title, "workspace": repo_a}).json()["issue"]["issue_id"]
        client.post(f"/api/team/issues/{iid}/assign", json={"profile_id": pid})
        return iid

    first = _assigned("first")
    assert client.post(f"/api/team/issues/{first}/checkout", json={}).status_code == 200
    second = _assigned("second")
    conflict = client.post(f"/api/team/issues/{second}/checkout", json={})
    assert conflict.status_code == 409
    assert "workspace already locked" in conflict.json()["detail"]


def test_team_agent_effort_create_update_and_hire(tmp_path):
    """effort is a first-class per-agent field across all three REST entries
    (create / update / hire), parallel to model — a surface can really select it."""
    client = _client(tmp_path)
    # create
    created = client.post(
        "/api/team/agents",
        json={"name": "Eng", "role": "engineer", "backend": "codex", "effort": "high"},
    ).json()
    assert created["profile"]["effort"] == "high"
    pid = created["profile"]["profile_id"]

    # update (PATCH) — '' resets to backend default, parallel to model
    updated = client.patch(f"/api/team/agents/{pid}", json={"effort": ""}).json()
    assert updated["profile"]["effort"] == ""

    # hire (human-gated request) carries effort into the pending spec the grant
    # later materializes (extra="forbid" → a 200 also proves the field is accepted).
    company = client.post("/api/team/companies", json={"name": "Acme", "goal": "ship"}).json()["company"]
    hire = client.post(
        "/api/team/agents/request-hire",
        json={
            "by": "local_user", "name": "Dev", "role": "engineer",
            "company": company["company_profile_id"], "backend": "codex", "effort": "low",
        },
    )
    assert hire.status_code == 200, hire.text
    assert hire.json()["approval"]["affects"]["spec"]["effort"] == "low"


def test_team_agent_create_update_reject_unknown_fields(tmp_path):
    """The agent create/update entries are self-defending (extra='forbid'): an
    unknown field is a loud 422, never silently dropped. Regression guard for the
    backend_policy/backend wire-name drift that previously no-op'd a runtime switch."""
    client = _client(tmp_path)
    # create: the kernel field name backend_policy is NOT the wire field → 422.
    bad_create = client.post(
        "/api/team/agents",
        json={"name": "Eng", "role": "engineer", "backend_policy": "codex"},
    )
    assert bad_create.status_code == 422, bad_create.text
    assert "backend_policy" in bad_create.text

    # update: same fail-loud on an unknown field.
    pid = client.post("/api/team/agents", json={"name": "Eng", "role": "engineer"}).json()["profile"]["profile_id"]
    bad_update = client.patch(f"/api/team/agents/{pid}", json={"backend_policy": "codex"})
    assert bad_update.status_code == 422, bad_update.text


def test_team_equipment_narrowing_via_api(tmp_path):
    client = _client(tmp_path)
    created = client.post(
        "/api/team/agents",
        json={"name": "Eng", "role": "engineer", "plugin_allowlist": ["not-installed-tool"]},
    ).json()
    # A requested-but-ungoverned plugin is dropped, never granted.
    assert created["equipment"]["granted"] == []
    assert created["equipment"]["dropped"] == ["not-installed-tool"]


def test_team_unknown_issue_is_404(tmp_path):
    client = _client(tmp_path)
    resp = client.post("/api/team/issues/issue_missing/checkout", json={})
    assert resp.status_code == 404


def test_team_company_workspace_and_delegate_endpoints(tmp_path):
    client = _client(tmp_path)
    company = client.post("/api/team/companies", json={"name": "Acme", "goal": "ship"}).json()["company"]
    assert company["name"] == "Acme"
    ws = client.post("/api/team/workspaces", json={"name": "local", "company": company["company_profile_id"], "network_policy": "none"}).json()["workspace"]
    assert ws["network_policy"] == "none"
    assert len(client.get("/api/team/companies").json()["companies"]) == 1
    assert len(client.get("/api/team/workspaces").json()["workspaces"]) == 1

    # profile carries charter
    eng = client.post("/api/team/agents", json={"name": "Eng", "role": "engineer", "charter": "ship now"}).json()
    assert eng["profile"]["charter"] == "ship now"
    eng_id = eng["profile"]["profile_id"]

    parent = client.post("/api/team/issues", json={"title": "feature"}).json()["issue"]["issue_id"]
    child = client.post(f"/api/team/issues/{parent}/delegate", json={"profile_id": eng_id, "title": "subtask"})
    assert child.status_code == 200
    assert child.json()["issue"]["parent_id"] == parent


def test_team_company_scope_filters_agents_and_issues(tmp_path):
    """GET /api/team/agents|issues?company=... mirrors the CLI --company flag."""
    client = _client(tmp_path)
    acme = client.post("/api/team/companies", json={"name": "Acme"}).json()["company"]["company_profile_id"]
    client.post("/api/team/agents", json={"name": "CEO", "role": "ceo", "company": acme})
    client.post("/api/team/agents", json={"name": "Eng", "role": "engineer"})  # default "local"
    client.post("/api/team/issues", json={"title": "acme task", "company": acme})
    client.post("/api/team/issues", json={"title": "local task"})

    scoped_agents = client.get(f"/api/team/agents?company={acme}").json()["agents"]
    assert [a["name"] for a in scoped_agents] == ["CEO"]
    scoped_issues = client.get(f"/api/team/issues?company={acme}").json()["issues"]
    assert [i["title"] for i in scoped_issues] == ["acme task"]
    # Unscoped reads still return everything.
    assert len(client.get("/api/team/agents").json()["agents"]) == 2
    assert len(client.get("/api/team/issues").json()["issues"]) == 2


def test_team_cross_company_assign_and_delegate_are_409(tmp_path):
    """Work must never silently cross a company boundary (fail-closed)."""
    client = _client(tmp_path)
    acme = client.post("/api/team/companies", json={"name": "Acme"}).json()["company"]["company_profile_id"]
    globex = client.post("/api/team/companies", json={"name": "Globex"}).json()["company"]["company_profile_id"]
    acme_eng = client.post(
        "/api/team/agents", json={"name": "AcmeEng", "role": "engineer", "company": acme}
    ).json()["profile"]["profile_id"]
    globex_issue = client.post(
        "/api/team/issues", json={"title": "globex work", "company": globex}
    ).json()["issue"]["issue_id"]

    assign = client.post(f"/api/team/issues/{globex_issue}/assign", json={"profile_id": acme_eng})
    assert assign.status_code == 409
    assert "cross-company" in assign.json()["detail"]

    delegate = client.post(
        f"/api/team/issues/{globex_issue}/delegate", json={"profile_id": acme_eng, "title": "sub"}
    )
    assert delegate.status_code == 409
    assert "cross-company" in delegate.json()["detail"]


def test_team_unknown_company_reference_is_409(tmp_path):
    """Creating team entities under a nonexistent company fails closed."""
    client = _client(tmp_path)
    for path, body in (
        ("/api/team/agents", {"name": "Eng", "role": "engineer", "company": "company_missing"}),
        ("/api/team/issues", {"title": "x", "company": "company_missing"}),
        ("/api/team/workspaces", {"name": "ws", "company": "company_missing"}),
    ):
        resp = client.post(path, json=body)
        assert resp.status_code == 409, path
        assert "unknown company" in resp.json()["detail"]


def test_team_workspace_company_mismatch_is_409(tmp_path):
    """A registered workspace cannot be borrowed by another company's entities."""
    client = _client(tmp_path)
    acme = client.post("/api/team/companies", json={"name": "Acme"}).json()["company"]["company_profile_id"]
    globex = client.post("/api/team/companies", json={"name": "Globex"}).json()["company"]["company_profile_id"]
    acme_ws = client.post(
        "/api/team/workspaces", json={"name": "Acme HQ", "company": acme}
    ).json()["workspace"]["workspace_id"]

    issue = client.post(
        "/api/team/issues", json={"title": "x", "company": globex, "workspace": acme_ws}
    )
    assert issue.status_code == 409
    assert "belongs to company" in issue.json()["detail"]
    agent = client.post(
        "/api/team/agents", json={"name": "Eng", "role": "engineer", "company": globex, "workspace": acme_ws}
    )
    assert agent.status_code == 409
    # The free-form workspace bypass is closed (ADR: workspace-trust-container):
    # unknown workspace ids fail closed with registration guidance.
    rejected = client.post("/api/team/issues", json={"title": "y", "company": globex, "workspace": "repoZ"})
    assert rejected.status_code == 409
    assert "unknown workspace" in rejected.json()["detail"]
    rejected_agent = client.post(
        "/api/team/agents", json={"name": "Ghost", "role": "engineer", "workspace": "repoZ"}
    )
    assert rejected_agent.status_code == 409
    assert "unknown workspace" in rejected_agent.json()["detail"]


def test_team_approvals_company_scope(tmp_path):
    """The company approval inbox only contains that company's issue approvals."""
    client = _client(tmp_path)

    def _company_with_pending_approval(name):
        cid = client.post("/api/team/companies", json={"name": name}).json()["company"]["company_profile_id"]
        ws = client.post(
            "/api/team/workspaces", json={"name": f"{name} HQ", "company": cid}
        ).json()["workspace"]["workspace_id"]
        pid = client.post(
            "/api/team/agents", json={"name": f"{name}Eng", "role": "engineer", "company": cid, "workspace": ws}
        ).json()["profile"]["profile_id"]
        iid = client.post(
            "/api/team/issues", json={"title": f"{name} task", "company": cid, "workspace": ws}
        ).json()["issue"]["issue_id"]
        client.post(f"/api/team/issues/{iid}/assign", json={"profile_id": pid})
        client.post(f"/api/team/issues/{iid}/checkout", json={})
        submit = client.post(f"/api/team/issues/{iid}/submit", json={"summary": "ready"})
        return cid, submit.json()["approval"]["approval_id"]

    acme, acme_approval = _company_with_pending_approval("Acme")
    _globex, globex_approval = _company_with_pending_approval("Globex")

    scoped = client.get(f"/api/team/approvals?company={acme}").json()
    assert [a["approval_id"] for a in scoped["approvals"]] == [acme_approval]
    unscoped = client.get("/api/team/approvals").json()
    assert {a["approval_id"] for a in unscoped["approvals"]} == {acme_approval, globex_approval}


def test_team_board_inbox_projects_escalate_to_board_interactions(tmp_path):
    """Board inbox is a thin read model over durable ESCALATE_TO_BOARD facts."""
    state_path = tmp_path / "state.db"
    client = TestClient(create_app(state_path=state_path))
    acme = client.post("/api/team/companies", json={"name": "Acme"}).json()["company"]["company_profile_id"]
    issue = client.post("/api/team/issues", json={"title": "Root", "company": acme}).json()["issue"]
    other = client.post("/api/team/issues", json={"title": "Local"}).json()["issue"]

    store = StateStore(state_path)
    store.save_issue_interaction(
        IssueThreadInteraction(
            issue_id=issue["issue_id"],
            company_profile_id=acme,
            kind=IssueInteractionKind.COMPLETION.value,
            continuation_policy=ContinuationPolicy.ESCALATE_TO_BOARD.value,
            status="pending",
            created_by_type="system",
            created_by_id="local_user",
            payload={"child_issue_id": "child_1", "child_title": "Child ready"},
        )
    )
    store.save_issue_interaction(
        IssueThreadInteraction(
            issue_id=other["issue_id"],
            kind=IssueInteractionKind.COMPLETION.value,
            continuation_policy=ContinuationPolicy.NOTIFY_PARENT.value,
            status="pending",
            payload={"child_issue_id": "child_2"},
        )
    )

    scoped = client.get(f"/api/team/board-inbox?company={acme}").json()
    assert scoped["count"] == 1
    assert scoped["items"][0]["continuation_policy"] == "escalate_to_board"
    assert scoped["items"][0]["payload"]["child_title"] == "Child ready"
    assert scoped["items"][0]["issue"]["title"] == "Root"


def test_team_delegate_unknown_profile_is_404(tmp_path):
    client = _client(tmp_path)
    parent = client.post("/api/team/issues", json={"title": "x"}).json()["issue"]["issue_id"]
    resp = client.post(f"/api/team/issues/{parent}/delegate", json={"profile_id": "nope", "title": "t"})
    assert resp.status_code == 404


def test_team_cost_endpoints(tmp_path):
    client = _client(tmp_path)
    summary = client.get("/api/cost/summary")
    assert summary.status_code == 200
    assert summary.json()["event_count"] == 0
    assert client.get("/api/cost/events").json()["events"] == []


def test_cost_endpoints_window_parity_with_cli(tmp_path):
    """The API cost views accept the same since/until window the CLI does and
    resolve it through the same kernel helper — zero CLI/API divergence."""
    from superclaw.models import CostEvent
    from superclaw.state import resolve_cost_window

    state_path = tmp_path / "state.db"
    store = StateStore(state_path)
    # Place events RELATIVE to the resolver's own local midnights so the test is
    # timezone-independent (CI runs UTC; local dev does not) — no hardcoded epoch.
    m20, m21 = resolve_cost_window(since="2026-06-20", until="2026-06-21")
    store.record_cost_event(CostEvent(idempotency_key="d20", run_id="r", occurred_at=m20 + 3600, input_tokens=10, usage_status="actual"))
    store.record_cost_event(CostEvent(idempotency_key="d21", run_id="r", occurred_at=m21 + 3600, input_tokens=20, usage_status="actual"))
    client = TestClient(create_app(state_path=state_path))

    # half-open [since, until): only the 2026-06-20 event
    events = client.get("/api/cost/events?since=2026-06-20&until=2026-06-21").json()["events"]
    assert [e["idempotency_key"] for e in events] == ["d20"]
    assert client.get("/api/cost/summary?since=2026-06-20&until=2026-06-21").json()["input_tokens"] == 10
    # malformed / contradictory window fails closed with a 400, not a silent empty result
    assert client.get("/api/cost/events?since=2026/06/20").status_code == 400
    assert client.get("/api/cost/summary?today=true&since=2026-06-20").status_code == 400


def test_team_inventory_company_scope(tmp_path):
    """/api/team/inventory?company= rolls up only that company's entities."""
    client = _client(tmp_path)
    acme = client.post("/api/team/companies", json={"name": "Acme"}).json()["company"]["company_profile_id"]
    client.post("/api/team/agents", json={"name": "CEO", "role": "ceo", "company": acme})
    client.post("/api/team/agents", json={"name": "Eng", "role": "engineer"})  # default "local"
    client.post("/api/team/issues", json={"title": "acme task", "company": acme})
    client.post("/api/team/issues", json={"title": "local task"})

    scoped = client.get(f"/api/team/inventory?company={acme}").json()
    assert scoped["company_profile_id"] == acme
    assert [a["name"] for a in scoped["agents"]] == ["CEO"]
    assert scoped["issue_total"] == 1
    assert scoped["issue_status_counts"] == {"backlog": 1}
    unscoped = client.get("/api/team/inventory").json()
    assert unscoped["issue_total"] == 2
    assert len(unscoped["agents"]) == 2


def test_team_inventory_workspace_scope_includes_approval_count(tmp_path):
    """Every figure in an inventory payload obeys the same workspace scope —
    the approval count must not be broader than the agent/issue lists."""
    client = _client(tmp_path)
    acme = client.post("/api/team/companies", json={"name": "Acme"}).json()["company"]["company_profile_id"]

    def _pending_approval_in(workspace_name):
        ws = client.post(
            "/api/team/workspaces", json={"name": workspace_name, "company": acme}
        ).json()["workspace"]["workspace_id"]
        pid = client.post(
            "/api/team/agents",
            json={"name": f"Eng-{workspace_name}", "role": "engineer", "company": acme, "workspace": ws},
        ).json()["profile"]["profile_id"]
        iid = client.post(
            "/api/team/issues", json={"title": f"task {workspace_name}", "company": acme, "workspace": ws}
        ).json()["issue"]["issue_id"]
        client.post(f"/api/team/issues/{iid}/assign", json={"profile_id": pid})
        client.post(f"/api/team/issues/{iid}/checkout", json={})
        client.post(f"/api/team/issues/{iid}/submit", json={})
        return ws

    ws_a = _pending_approval_in("A")
    _ws_b = _pending_approval_in("B")

    scoped = client.get(f"/api/team/inventory?workspace={ws_a}").json()
    assert scoped["issue_total"] == 1
    assert len(scoped["agents"]) == 1
    assert scoped["open_approval_count"] == 1  # NOT 2 — same scope as the lists
    assert client.get("/api/team/inventory").json()["open_approval_count"] == 2
    # The approvals endpoint takes the same workspace filter.
    assert client.get(f"/api/team/approvals?workspace={ws_a}").json()["count"] == 1


def test_team_inventory_read_model(tmp_path):
    client = _client(tmp_path)
    pid = client.post("/api/team/agents", json={"name": "Eng", "role": "engineer"}).json()["profile"]["profile_id"]
    iid = client.post("/api/team/issues", json={"title": "x"}).json()["issue"]["issue_id"]
    client.post(f"/api/team/issues/{iid}/assign", json={"profile_id": pid})
    client.post(f"/api/team/issues/{iid}/checkout", json={})
    client.post(f"/api/team/issues/{iid}/submit", json={})

    inv = client.get("/api/team/inventory").json()
    assert inv["issue_total"] == 1
    assert inv["issue_status_counts"].get("in_review") == 1
    assert inv["open_approval_count"] == 1
    assert len(inv["agents"]) == 1


def test_team_issue_thread_and_block_endpoints(tmp_path):
    """Phase 4a: the thread + block/unblock/requeue + daemon observation
    surface mirrors the kernel (CLI parity, zero new semantics)."""
    client = _client(tmp_path)
    profile = client.post("/api/team/agents", json={"name": "Eng", "role": "engineer"}).json()["profile"]
    issue = client.post("/api/team/issues", json={"title": "Ship"}).json()["issue"]
    client.post(f"/api/team/issues/{issue['issue_id']}/assign", json={"profile_id": profile["profile_id"]})

    # comment + mention surface
    posted = client.post(
        f"/api/team/issues/{issue['issue_id']}/comments",
        json={"body": f"@{profile['profile_id']} please look"},
    )
    assert posted.status_code == 200
    assert posted.json()["interactions"][0]["target_agent_profile_id"] == profile["profile_id"]
    thread = client.get(f"/api/team/issues/{issue['issue_id']}/comments").json()
    assert len(thread["comments"]) == 1
    assert client.post(f"/api/team/issues/{issue['issue_id']}/comments", json={"body": "  "}).status_code == 409

    # block requires a reason (fail-closed), unblock returns to queue
    assert client.post(f"/api/team/issues/{issue['issue_id']}/block", json={"reason": ""}).status_code == 422
    blocked = client.post(f"/api/team/issues/{issue['issue_id']}/block", json={"reason": "waiting"})
    assert blocked.json()["issue"]["status"] == "blocked"
    unblocked = client.post(f"/api/team/issues/{issue['issue_id']}/unblock", json={})
    assert unblocked.json()["issue"]["status"] == "todo"

    # requeue recovers a stranded claim
    client.post(f"/api/team/issues/{issue['issue_id']}/checkout", json={})
    requeued = client.post(f"/api/team/issues/{issue['issue_id']}/requeue", json={})
    assert requeued.json()["issue"]["status"] == "todo"

    # wakeups + daemon observation
    wakeups = client.get("/api/team/wakeups").json()["wakeups"]
    assert any(w["source"] == "assignment" for w in wakeups)
    status = client.get("/api/team/daemon/status").json()
    # Fail-closed master switch: a fresh instance reports heartbeats OFF until
    # an operator explicitly enables them.
    assert status["heartbeat_enabled"] is False
    assert set(status["wakeups"]) == {"queued", "claimed", "finished", "skipped"}


def test_team_daemon_engine_off_without_launcher_optin(tmp_path):
    # A bare create_app() (as in tests, or any embedding that does not opt in)
    # must NOT spawn the in-process drain loop — autostart is launcher-gated so
    # the test suite never runs agents unattended.
    client = _client(tmp_path)
    status = client.get("/api/team/daemon/status").json()
    assert status["engine_running"] is False
    # The instance setting defaults to true (the operator-facing second gate),
    # but with no launcher env the engine still stays down.
    assert status["autostart_enabled"] is True


def test_team_daemon_engine_autostarts_with_launcher_optin(tmp_path, monkeypatch):
    # The desktop/web shell opts the in-process drain loop in via env. With no
    # agents and no queued work the loop idles harmlessly (services nothing), so
    # this exercises the gate, not an actual run.
    import time

    monkeypatch.setenv("SUPERCLAW_DAEMON_AUTOSTART", "1")
    app = create_app(state_path=tmp_path / "state.db")
    try:
        deadline = time.time() + 2.0
        while time.time() < deadline and not getattr(app.state, "heartbeat_daemon_running", False):
            time.sleep(0.05)
        assert app.state.heartbeat_daemon_running is True
    finally:
        app.state.heartbeat_daemon_stop.set()


def test_team_profile_create_carries_heartbeat_policy(tmp_path):
    client = _client(tmp_path)
    created = client.post(
        "/api/team/agents",
        json={"name": "Eng", "role": "engineer", "heartbeat_enabled": True, "heartbeat_interval_sec": 60},
    ).json()["profile"]
    assert created["runtime_config"]["heartbeat"] == {"enabled": True, "interval_sec": 60}
    plain = client.post("/api/team/agents", json={"name": "Plain", "role": "qa"}).json()["profile"]
    assert plain["runtime_config"] == {}


def test_team_profile_permission_grants(tmp_path):
    """CLI/API parity for the --permission grant: none->plan, ask/allow->
    bypassPermissions (max-permission doctrine: runtime is a pure execution
    engine), omitted->{} (inherit), invalid->422."""
    client = _client(tmp_path)
    cases = {
        None: {},
        "none": {"mode": "plan"},
        "ask": {"mode": "bypassPermissions"},
        "allow": {"mode": "bypassPermissions"},
    }
    for preset, expected in cases.items():
        body = {"name": f"A-{preset}", "role": "engineer"}
        if preset is not None:
            body["permission"] = preset
        prof = client.post("/api/team/agents", json=body).json()["profile"]
        assert prof["permission_policy"] == expected, preset
    assert client.post("/api/team/agents", json={"name": "X", "role": "r", "permission": "wide-open"}).status_code == 422


# --- PATCH /api/team/agents/{id} (edit after creation) -------------------------


def _make_agent(client, **body):
    body.setdefault("name", "Eng")
    body.setdefault("role", "engineer")
    return client.post("/api/team/agents", json=body).json()["profile"]


def test_patch_profile_partial_keeps_other_fields(tmp_path):
    client = _client(tmp_path)
    prof = _make_agent(client, model="claude-opus-4-8", title="Boss")
    pid = prof["profile_id"]
    resp = client.patch(f"/api/team/agents/{pid}", json={"model": "claude-sonnet-4-6"})
    assert resp.status_code == 200, resp.text
    updated = resp.json()["profile"]
    assert updated["model"] == "claude-sonnet-4-6"
    assert updated["title"] == "Boss"  # untouched
    assert updated["revision_id"] != prof["revision_id"]


def test_patch_permission_inherit_resets(tmp_path):
    client = _client(tmp_path)
    pid = _make_agent(client, permission="allow")["profile_id"]
    resp = client.patch(f"/api/team/agents/{pid}", json={"permission": "inherit"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["profile"]["permission_policy"] == {}


def test_patch_heartbeat_toggle(tmp_path):
    client = _client(tmp_path)
    pid = _make_agent(client)["profile_id"]
    on = client.patch(f"/api/team/agents/{pid}", json={"heartbeat_enabled": True, "heartbeat_interval_sec": 45})
    assert on.json()["profile"]["runtime_config"]["heartbeat"] == {"enabled": True, "interval_sec": 45}
    off = client.patch(f"/api/team/agents/{pid}", json={"heartbeat_enabled": False})
    assert "heartbeat" not in off.json()["profile"]["runtime_config"]


def test_patch_reports_to_clear_with_null(tmp_path):
    client = _client(tmp_path)
    ceo = _make_agent(client, name="CEO", role="ceo")["profile_id"]
    eng = _make_agent(client, reports_to=ceo)["profile_id"]
    resp = client.patch(f"/api/team/agents/{eng}", json={"reports_to": None})
    assert resp.status_code == 200, resp.text
    assert resp.json()["profile"]["reports_to"] is None


def test_patch_unknown_profile_404(tmp_path):
    client = _client(tmp_path)
    assert client.patch("/api/team/agents/nope", json={"model": "x"}).status_code == 404


def test_patch_empty_body_400(tmp_path):
    client = _client(tmp_path)
    pid = _make_agent(client)["profile_id"]
    assert client.patch(f"/api/team/agents/{pid}", json={}).status_code == 400


def test_patch_cycle_rejected_409(tmp_path):
    client = _client(tmp_path)
    pid = _make_agent(client)["profile_id"]
    # self-report is a cycle; the kernel raises ValueError -> 409
    assert client.patch(f"/api/team/agents/{pid}", json={"reports_to": pid}).status_code == 409


def test_patch_stale_revision_rejected_409(tmp_path):
    client = _client(tmp_path)
    prof = _make_agent(client)
    pid, stale = prof["profile_id"], prof["revision_id"]
    # First edit moves the revision.
    client.patch(f"/api/team/agents/{pid}", json={"title": "A", "expected_revision_id": stale})
    # A second edit holding the stale revision is rejected (CAS).
    resp = client.patch(f"/api/team/agents/{pid}", json={"title": "B", "expected_revision_id": stale})
    assert resp.status_code == 409


def test_team_work_products_roundtrip(tmp_path):
    client = _client(tmp_path)
    issue = client.post("/api/team/issues", json={"title": "Ship login"}).json()["issue"]
    iid = issue["issue_id"]
    # Attach a delivery fact (the scope is taken from the issue, not the caller).
    attached = client.post(f"/api/team/issues/{iid}/work-products", json={"type": "pull_request", "title": "PR #1", "url": "http://x/pr/1", "provider": "github", "is_primary": True})
    assert attached.status_code == 200
    wp = attached.json()["work_product"]
    assert wp["type"] == "pull_request" and wp["is_primary"] is True
    # List shows it.
    listed = client.get(f"/api/team/issues/{iid}/work-products").json()["work_products"]
    assert len(listed) == 1
    # Patch status; delete.
    upd = client.patch(f"/api/team/work-products/{wp['work_product_id']}", json={"status": "merged"})
    assert upd.json()["work_product"]["status"] == "merged"
    assert client.delete(f"/api/team/work-products/{wp['work_product_id']}").json()["removed"] is True
    assert client.get(f"/api/team/issues/{iid}/work-products").json()["work_products"] == []


def test_team_work_product_unknown_type_fails_closed(tmp_path):
    client = _client(tmp_path)
    issue = client.post("/api/team/issues", json={"title": "x"}).json()["issue"]
    bad = client.post(f"/api/team/issues/{issue['issue_id']}/work-products", json={"type": "bogus"})
    assert bad.status_code == 409


def test_team_work_product_empty_update_is_rejected(tmp_path):
    # The kernel rejects a no-field update, so the API rejects it identically to
    # the CLI (zero divergence) — never a silent 200 no-op.
    client = _client(tmp_path)
    issue = client.post("/api/team/issues", json={"title": "x"}).json()["issue"]
    wp = client.post(
        f"/api/team/issues/{issue['issue_id']}/work-products", json={"type": "pull_request"}
    ).json()["work_product"]
    empty = client.patch(f"/api/team/work-products/{wp['work_product_id']}", json={})
    assert empty.status_code == 409


def test_team_work_products_unknown_issue_is_404(tmp_path):
    client = _client(tmp_path)
    assert client.get("/api/team/issues/issue_missing/work-products").status_code == 404


def test_backup_endpoint_writes_a_snapshot(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    client = _client(tmp_path)
    resp = client.post("/api/backup")
    assert resp.status_code == 200
    import pathlib

    assert pathlib.Path(resp.json()["backup"]).exists()
    assert resp.json()["schema_version"] >= 1


def test_team_issue_hold_and_unhold_through_api(tmp_path):
    client = _client(tmp_path)
    pid = client.post("/api/team/agents", json={"name": "Eng", "role": "engineer"}).json()["profile"]["profile_id"]
    iid = client.post("/api/team/issues", json={"title": "Ship login"}).json()["issue"]["issue_id"]
    client.post(f"/api/team/issues/{iid}/assign", json={"profile_id": pid})

    hold = client.post(f"/api/team/issues/{iid}/hold", json={"reason": "freeze"})
    assert hold.status_code == 200 and hold.json()["hold"]["status"] == "active"
    # A held issue is refused at checkout (kernel governance → the team API's 409).
    assert client.post(f"/api/team/issues/{iid}/checkout", json={}).status_code == 409
    # Double-hold fails closed.
    assert client.post(f"/api/team/issues/{iid}/hold", json={}).status_code == 409

    assert client.post(f"/api/team/issues/{iid}/unhold", json={}).status_code == 200
    # Released → checkout works again.
    assert client.post(f"/api/team/issues/{iid}/checkout", json={}).status_code == 200


def test_team_issue_tree_pause_resume_cancel_through_api(tmp_path):
    client = _client(tmp_path)
    pid = client.post("/api/team/agents", json={"name": "Eng", "role": "engineer"}).json()["profile"]["profile_id"]
    root = client.post("/api/team/issues", json={"title": "root"}).json()["issue"]["issue_id"]
    client.post(f"/api/team/issues/{root}/assign", json={"profile_id": pid})
    c1 = client.post(f"/api/team/issues/{root}/delegate", json={"profile_id": pid, "title": "c1"}).json()["issue"]["issue_id"]

    preview = client.get(f"/api/team/issues/{root}/tree")
    assert preview.status_code == 200 and preview.json()["count"] == 2

    paused = client.post(f"/api/team/issues/{root}/tree/pause", json={"reason": "freeze"})
    assert paused.status_code == 200 and set(paused.json()["paused"]) == {root, c1}

    resumed = client.post(f"/api/team/issues/{root}/tree/resume", json={})
    assert resumed.status_code == 200 and set(resumed.json()["released"]) == {root, c1}

    cancelled = client.post(f"/api/team/issues/{root}/tree/cancel", json={})
    assert cancelled.status_code == 200 and set(cancelled.json()["cancelled"]) == {root, c1}
    # An unknown root fails closed with 404.
    assert client.get("/api/team/issues/issue_missing/tree").status_code == 404
    assert client.post("/api/team/issues/issue_missing/tree/pause", json={}).status_code == 404


def test_team_parity_gap_endpoints(tmp_path):
    client = _client(tmp_path)
    pid = client.post("/api/team/agents", json={"name": "Eng", "role": "engineer"}).json()["profile"]["profile_id"]

    before = client.get(f"/api/team/agents/{pid}").json()["profile"]["charter_revision_id"]
    charter = client.post(
        f"/api/team/agents/{pid}/charter",
        json={"charter": "Ship safely", "persona": "calm"},
    )
    assert charter.status_code == 200
    assert charter.json()["profile"]["charter"] == "Ship safely"
    assert charter.json()["profile"]["persona"] == "calm"
    assert charter.json()["profile"]["charter_revision_id"] != before
    assert client.post("/api/team/agents/nope/charter", json={"charter": "x"}).status_code == 404

    config = client.post(
        f"/api/team/agents/{pid}/request-config-change",
        json={"by": pid, "model": "gpt-5.5"},
    )
    assert config.status_code == 200
    assert config.json()["approval"]["type"] == "agent_config_change"
    assert client.post(f"/api/team/agents/{pid}/request-config-change", json={"by": pid}).status_code == 409
    assert client.post(
        "/api/team/agents/nope/request-config-change",
        json={"by": pid, "model": "x"},
    ).status_code == 404

    hire = client.post(
        "/api/team/agents/request-hire",
        json={"by": pid, "name": "Jr", "role": "engineer"},
    )
    assert hire.status_code == 200
    assert hire.json()["approval"]["type"] == "agent_hire"
    assert client.post("/api/team/agents/request-hire", json={"by": pid, "role": "x"}).status_code == 422

    approval_id = config.json()["approval"]["approval_id"]
    assert client.get(f"/api/team/approvals/{approval_id}").json()["approval"]["approval_id"] == approval_id
    assert client.get("/api/team/approvals/nope").status_code == 404

    company_id = client.post("/api/team/companies", json={"name": "Acme"}).json()["company"]["company_profile_id"]
    assert client.get(f"/api/team/companies/{company_id}").json()["company"]["company_profile_id"] == company_id
    assert client.get("/api/team/companies/nope").status_code == 404

    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / ".git").mkdir()
    trusted = client.post("/api/team/workspaces/trust", json={"path": str(repo), "name": "r"})
    assert trusted.status_code == 200
    assert trusted.json()["created"] is True
    assert client.post("/api/team/workspaces/trust", json={"path": str(repo)}).json()["created"] is False

    client.post(f"/api/team/agents/{pid}/charter", json={"charter": "keep me"})
    client.post(f"/api/team/agents/{pid}/charter", json={"persona": "stoic"})
    assert client.get(f"/api/team/agents/{pid}").json()["profile"]["charter"] == "keep me"
    assert client.post(
        f"/api/team/agents/{pid}/request-config-change",
        json={"by": pid, "budget_seconds": 9},
    ).status_code == 422
    assert client.post(
        "/api/team/agents/request-hire",
        json={"by": pid, "name": "X", "role": "engineer", "budget_seconds": 9},
    ).status_code == 422
    for field in ("backend", "model", "title", "permission", "persona", "reports_to", "skill_allowlist"):
        response = client.post(
            f"/api/team/agents/{pid}/request-config-change",
            json={"by": pid, field: None},
        )
        assert response.status_code == 422, field

    inherit = client.post(
        f"/api/team/agents/{pid}/request-config-change",
        json={"by": pid, "permission": "inherit"},
    )
    assert inherit.status_code == 200
    assert inherit.json()["approval"]["affects"]["patch"]["permission_policy"] == {}
    none_ref = client.post(
        f"/api/team/agents/{pid}/request-config-change",
        json={"by": pid, "reports_to": "none"},
    )
    assert none_ref.status_code == 200
    assert none_ref.json()["approval"]["affects"]["patch"]["reports_to"] is None
    assert client.post(
        f"/api/team/agents/{pid}/request-config-change",
        json={"by": pid, "heartbeat": None},
    ).status_code == 409
    assert client.post(
        "/api/team/agents/request-hire",
        json={"by": pid, "name": "Jr2", "role": "engineer", "title": None},
    ).status_code == 200
    other_company = client.post("/api/team/companies", json={"name": "Globex"}).json()["company"]["company_profile_id"]
    assert client.post(
        "/api/team/workspaces/trust",
        json={"path": str(repo), "company": other_company},
    ).status_code == 409


def test_team_typed_issue_kind_and_review_policy(tmp_path):
    # Paperclip typed-issue: kind + review_policy are settable, validated at the
    # single kernel gate, and default fail-safe (delivery / human_final).
    client = _client(tmp_path)

    # Typed create round-trips both fields.
    created = client.post("/api/team/issues", json={"title": "Bug X", "kind": "bug", "review_policy": "qa_accept"})
    assert created.status_code == 200
    issue = created.json()["issue"]
    assert issue["kind"] == "bug" and issue["review_policy"] == "qa_accept"

    # Default create keeps today's behaviour (backward-compat).
    default = client.post("/api/team/issues", json={"title": "Plain"})
    assert default.status_code == 200
    assert default.json()["issue"]["kind"] == "delivery"
    assert default.json()["issue"]["review_policy"] == "human_final"

    # Invalid values are rejected at the kernel gate (same 409 convention the team
    # API uses for kernel ValueErrors) — no surface can persist a malformed type.
    assert client.post("/api/team/issues", json={"title": "x", "kind": "nonsense"}).status_code == 409
    assert client.post("/api/team/issues", json={"title": "y", "review_policy": "whatever"}).status_code == 409


def test_typed_issue_validated_at_construction_single_source(tmp_path):
    # The validity gate is Issue.__post_init__ (construction), so EVERY write path —
    # save_issue, commit_checkout, delegated child, bootstrap seed, from_dict load —
    # is covered, not just save_issue. An invalid kind/review_policy can't even
    # construct an Issue object.
    import pytest

    from superclaw.models import Issue

    with pytest.raises(ValueError, match="invalid issue kind"):
        Issue(title="x", kind="nonsense")
    with pytest.raises(ValueError, match="invalid review_policy"):
        Issue(title="x", review_policy="whatever")
    # from_dict loading a malformed stored row is rejected too (fail-closed).
    with pytest.raises(ValueError, match="invalid issue kind"):
        Issue.from_dict({"title": "x", "kind": "bad"})
    # A real legacy row (no typed fields) loads with valid fail-safe defaults.
    legacy = Issue.from_dict({"title": "old", "issue_id": "issue_legacy", "status": "done"})
    assert legacy.kind == "delivery" and legacy.review_policy == "human_final"


def test_typed_issue_persistence_gate_rejects_post_construction_mutation(tmp_path):
    # Construction validation alone can't catch a field MUTATED after construction
    # (``issue.kind = ...`` bypasses __post_init__). The persistence layer re-runs the
    # same gate before serializing the payload, so every direct write path —
    # save_issue, commit_checkout, etc. — is fail-closed against a mutated value.
    import pytest

    from superclaw.models import Issue

    store = StateStore(tmp_path / "state.db")
    issue = store.save_issue(Issue(title="valid", workspace_id="local"))

    # Bypass __post_init__ by mutating the live object, then re-persist.
    issue.kind = "nonsense"
    with pytest.raises(ValueError, match="invalid issue kind"):
        store.save_issue(issue)

    issue.kind = "delivery"
    issue.review_policy = "whatever"
    with pytest.raises(ValueError, match="invalid review_policy"):
        store.save_issue(issue)


# --- company bootstrap trust gate parity (PR-1 / design §3.5) ---------------


def _company_manifest(**overrides):
    import base64

    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

    from superclaw.company_template import _COMPANY_VERIFIER, CompanyTemplate

    priv = Ed25519PrivateKey.generate()
    raw = priv.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    pub = "ed25519:" + base64.b64encode(raw).decode()
    m = {
        "schema_version": 1,
        "id": "acme.delivery",
        "name": "Acme Delivery Co",
        "version": "1.0.0",
        "summary": "blueprint",
        "kind": "company",
        "source": {"type": "developer", "developer_id": "dev_acme"},
        "commerce": {"pricing_model": "free"},
        "roles": [{"name": "lead", "charter": "Lead the team"}],
        "equipment_requirements": {},
        "policies": {"high_risk_policies": {}},
        "budgets": {"default_budget_seconds": 60, "default_token_budget": 1000},
        "provenance": {"build_type": "developer", "package_digest": "", "signature": ""},
    }
    m.update(overrides)
    return m, pub, priv, _COMPANY_VERIFIER, CompanyTemplate


def test_inline_company_template_rejected_with_422(tmp_path):
    """An inline company dict has no file/digest/signature and can never be
    verified, so the API rejects it at the edge with 422 (no bypass)."""
    client = _client(tmp_path)
    manifest, *_ = _company_manifest()
    resp = client.post("/api/team/bootstrap", json={"template": manifest, "mode": "proposal"})
    assert resp.status_code == 422
    assert "inline company" in resp.json()["detail"]


def test_company_catalog_id_resolves_and_gates(tmp_path, monkeypatch):
    """POST /api/team/bootstrap with company_catalog_id resolves the cataloged company
    to its local source (via the SAME kernel resolver the CLI --from-catalog uses) and
    routes it through the verify-before-instantiate gate. Mirrors CLI parity. The API
    resolves against the canonical companies root (~/.superclaw/companies, pinned here
    via SUPERCLAW_HOME to the test tmp)."""
    import base64
    import json as _json

    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("SUPERCLAW_HOME", str(tmp_path / ".superclaw"))
    manifest, pub, priv, verifier, template_cls = _company_manifest(
        source={"type": "official", "developer_id": "fp"},
        provenance={"build_type": "local", "package_digest": "", "signature": ""},
    )
    monkeypatch.setenv("SUPERCLAW_COMPANY_ROOT_PUBLIC_KEY", pub)
    base = tmp_path / ".superclaw" / "companies" / "co"
    base.mkdir(parents=True)
    (base / "superclaw-company.json").write_text(_json.dumps(manifest), encoding="utf-8")
    digest = verifier.compute_digest(template_cls(source=base, root=base, manifest=manifest))
    manifest["provenance"]["package_digest"] = digest
    manifest["provenance"]["signature"] = "ed25519:" + base64.b64encode(priv.sign(digest.encode())).decode()
    (base / "superclaw-company.json").write_text(_json.dumps(manifest), encoding="utf-8")

    client = _client(tmp_path)
    resp = client.post(
        "/api/team/bootstrap",
        json={"company_catalog_id": "acme.delivery", "mode": "proposal"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["company_verification"]["trust_state"] == "official"
    assert body["company_verification"]["artifact_id"] == "acme.delivery"


def test_company_catalog_id_unknown_is_404(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    client = _client(tmp_path)
    resp = client.post("/api/team/bootstrap", json={"company_catalog_id": "no.such", "mode": "proposal"})
    assert resp.status_code == 404


def test_company_catalog_id_ambiguous_duplicate_is_422(tmp_path, monkeypatch):
    """Two local dirs declaring the same id@version => the API surfaces the resolver's
    ambiguous fail-closed as 422, not an unhandled 500 (CLI/API parity, Codex PR-5 R2)."""
    import base64
    import json as _json

    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("SUPERCLAW_HOME", str(tmp_path / ".superclaw"))
    manifest, pub, priv, verifier, template_cls = _company_manifest(
        source={"type": "local", "developer_id": "self"},
        provenance={"build_type": "local", "package_digest": "", "signature": ""},
    )
    monkeypatch.setenv("SUPERCLAW_COMPANY_ROOT_PUBLIC_KEY", pub)
    for slug in ("dir-a", "dir-b"):
        base = tmp_path / ".superclaw" / "companies" / slug
        base.mkdir(parents=True)
        m = dict(manifest)
        m["provenance"] = {"build_type": "local", "package_digest": "", "signature": ""}
        (base / "superclaw-company.json").write_text(_json.dumps(m), encoding="utf-8")
        digest = verifier.compute_digest(template_cls(source=base, root=base, manifest=m))
        m["provenance"]["package_digest"] = digest
        m["provenance"]["signature"] = "ed25519:" + base64.b64encode(priv.sign(digest.encode())).decode()
        (base / "superclaw-company.json").write_text(_json.dumps(m), encoding="utf-8")

    client = _client(tmp_path)
    resp = client.post(
        "/api/team/bootstrap",
        json={"company_catalog_id": "acme.delivery", "company_version": "1.0.0", "mode": "proposal"},
    )
    assert resp.status_code == 422
    assert "ambiguous" in resp.json()["detail"]


def test_bootstrap_requires_exactly_one_source(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    client = _client(tmp_path)
    assert client.post("/api/team/bootstrap", json={"mode": "proposal"}).status_code == 422
    assert client.post(
        "/api/team/bootstrap",
        json={"from_template": "x", "company_catalog_id": "y", "mode": "proposal"},
    ).status_code == 422


def test_unsigned_company_from_template_fails_closed(tmp_path, monkeypatch):
    """A signed-but-untrusted (wrong root key, no local opt-in) company directory
    submitted via from_template fails closed with 422 — never instantiated."""
    import json

    monkeypatch.delenv("SUPERCLAW_COMPANY_ROOT_PUBLIC_KEY", raising=False)
    monkeypatch.delenv("SUPERCLAW_COMPANY_LOCAL_DEV_TRUST", raising=False)
    manifest, _pub, priv, verifier, template_cls = _company_manifest()
    base = tmp_path / "co"
    base.mkdir(mode=0o700)
    (base / "superclaw-company.json").write_text(json.dumps(manifest), encoding="utf-8")
    import base64

    digest = verifier.compute_digest(template_cls(source=base, root=base, manifest=manifest))
    manifest["provenance"]["package_digest"] = digest
    manifest["provenance"]["signature"] = "ed25519:" + base64.b64encode(priv.sign(digest.encode())).decode()
    (base / "superclaw-company.json").write_text(json.dumps(manifest), encoding="utf-8")

    client = _client(tmp_path)
    resp = client.post("/api/team/bootstrap", json={"from_template": str(base), "mode": "proposal"})
    assert resp.status_code == 422


def test_legacy_inline_team_template_still_works(tmp_path):
    """The inline closure is company-scoped: legacy agentcompanies/v1 dicts still
    produce a proposal (no regression for the non-company path)."""
    client = _client(tmp_path)
    spec = {
        "metadata": {"source": "local", "revision": "1", "digest": "d"},
        "company": {"company_profile_id": "c", "name": "C"},
        "workspace": {"workspace_id": "local", "name": "ws"},
        "roles": [{"id": "r1", "name": "r1", "charter": "do work"}],
    }
    resp = client.post("/api/team/bootstrap", json={"template": spec, "mode": "proposal"})
    assert resp.status_code == 200
    assert resp.json()["company_verification"] is None


def test_team_messages_rollup_and_mark_read(tmp_path):
    """GET /api/team/messages projects the kernel roll-up; mark-read clears unread."""
    client = _client(tmp_path)
    acme = client.post("/api/team/companies", json={"name": "Acme"}).json()["company"]["company_profile_id"]
    ws = client.post("/api/team/workspaces", json={"name": "Acme HQ", "company": acme}).json()["workspace"]["workspace_id"]
    pid = client.post(
        "/api/team/agents", json={"name": "Eng", "role": "engineer", "company": acme, "workspace": ws}
    ).json()["profile"]["profile_id"]
    iid = client.post("/api/team/issues", json={"title": "ship", "company": acme, "workspace": ws}).json()["issue"]["issue_id"]
    client.post(f"/api/team/issues/{iid}/assign", json={"profile_id": pid})
    client.post(f"/api/team/issues/{iid}/checkout", json={})
    client.post(f"/api/team/issues/{iid}/submit", json={"summary": "ready"})  # opens a completion approval

    msgs = client.get("/api/team/messages").json()
    assert "snapshot_as_of" in msgs  # server-issued snapshot the client echoes back
    co = next(c for c in msgs["companies"] if c["company_profile_id"] == acme)
    assert co["completed_unreviewed"] == 1
    assert co["pending_approvals"] == 0
    assert msgs["total_unread"] == 1

    # company-scoped fetch narrows the view.
    scoped = client.get(f"/api/team/messages?company={acme}").json()
    assert {c["company_profile_id"] for c in scoped["companies"]} == {acme}

    # mark-read with the server-issued snapshot clears unread.
    res = client.post(
        "/api/team/messages/mark-read",
        json={"company_profile_id": acme, "seen_as_of": msgs["snapshot_as_of"]},
    )
    assert res.status_code == 200
    assert res.json()["marked"] == 1
    after = client.get("/api/team/messages").json()
    assert after["total_unread"] == 0


def test_team_messages_mark_read_xor_violation_is_400(tmp_path):
    """Passing BOTH item_keys and company_profile_id is a fail-closed 400."""
    client = _client(tmp_path)
    res = client.post(
        "/api/team/messages/mark-read",
        json={"item_keys": ["approval:x"], "company_profile_id": "co_a", "seen_as_of": 1.0},
    )
    assert res.status_code == 400


def test_team_messages_mark_read_empty_selection_is_400(tmp_path):
    """item_keys=[] or company="" alone is a fail-closed 400 (no silent prune)."""
    client = _client(tmp_path)
    r1 = client.post("/api/team/messages/mark-read", json={"item_keys": [], "seen_as_of": 1.0})
    assert r1.status_code == 400
    r2 = client.post("/api/team/messages/mark-read", json={"company_profile_id": "", "seen_as_of": 1.0})
    assert r2.status_code == 400


def test_team_messages_mark_read_missing_seen_as_of_is_422(tmp_path):
    """seen_as_of is a required field — omitting it is a 422 (pydantic), not a guess."""
    client = _client(tmp_path)
    r = client.post("/api/team/messages/mark-read", json={"company_profile_id": "co_a"})
    assert r.status_code == 422
