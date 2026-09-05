"""Tests for the issue run ledger projection.

The normalized-status parser is the one place the fragile wakeup ``detail``
strings are decoded, so it gets exhaustive coverage; the store-backed test
proves the read projection joins wakeups with live runs without inventing state.
"""

from __future__ import annotations

import pytest

from superclaw.models import AgentWakeupRequest, RunSession, RunStatus
from superclaw.run_ledger import (
    ACTIVE_LEDGER_STATUSES,
    LEDGER_STATUSES,
    build_issue_run_ledger,
    _normalize,
    _wakeup_targets_issue,
)
from superclaw.state import StateStore
from superclaw.ui_contracts import build_run_ledger_contract


def _wakeup(reason: str, status: str, detail: str = "", **kw) -> AgentWakeupRequest:
    return AgentWakeupRequest(
        agent_profile_id=kw.pop("agent", "agent_ceo"),
        reason=reason,
        status=status,
        detail=detail,
        **kw,
    )


@pytest.mark.parametrize(
    "status, detail, expected_status, expected_run",
    [
        ("queued", "", "queued", None),
        ("claimed", "", "running", None),
        ("finished", "ran:run_1:completed", "succeeded", "run_1"),
        ("finished", "ran:run_1:completed:issue_moved_to_done", "succeeded", "run_1"),
        ("finished", "ran:run_2:responded", "succeeded", "run_2"),
        ("finished", "ran:run_s:submitted_for_review", "succeeded", "run_s"),
        ("finished", "ran:run_3:no_response", "no_response", "run_3"),
        ("finished", "ran:run_g:waiting_human_gate", "waiting", "run_g"),
        ("finished", "ran:run_c:claim_changed_before_submit", "skipped", "run_c"),
        ("finished", "ran:run_h:held_before_submit", "skipped", "run_h"),
        ("finished", "ran:run_4:failed", "failed", "run_4"),
        ("finished", "ran:run_5:failed:issue_moved_to_done", "failed", "run_5"),
        ("skipped", "agent_busy:deferred", "deferred", None),
        ("skipped", "workspace_locked:deferred", "deferred", None),
        ("skipped", "workspace_guard_busy:deferred", "deferred", None),
        ("skipped", "reclaimed:stale_claim_no_live_run", "reclaimed", None),
        ("skipped", "error:boom", "failed", None),
        ("skipped", "run_error:kaboom", "failed", None),
        ("skipped", "respond_error:nope", "failed", None),
        ("finished", "idle", "idle", None),
        ("skipped", "workspace_guard_busy", "skipped", None),
    ],
)
def test_normalize_covers_every_daemon_detail_shape(status, detail, expected_status, expected_run):
    wk = _wakeup("issue_assigned:issue_x", status, detail)
    got_status, got_run = _normalize(wk)
    assert got_status == expected_status
    assert got_run == expected_run
    assert got_status in LEDGER_STATUSES


def test_normalize_never_invents_success_from_unknown_detail():
    # An unrecognised finished detail must NOT read as succeeded (fail-soft).
    status, run_id = _normalize(_wakeup("issue_assigned:issue_x", "finished", "mystery"))
    assert status == "skipped"
    assert run_id is None


def test_wakeup_targets_issue_by_reason_and_snapshot():
    assert _wakeup_targets_issue(_wakeup("mention:issue_x", "finished"), "issue_x")
    assert _wakeup_targets_issue(_wakeup("issue_assigned:issue_x", "queued"), "issue_x")
    # snapshot fallback (e.g. mention carries it in context_snapshot)
    snap_wk = _wakeup("mention:issue_x", "finished")
    snap_wk.context_snapshot = {"issue_id": "issue_y"}
    assert _wakeup_targets_issue(snap_wk, "issue_y")
    # unrelated reason (timer/retry) does not target an issue
    assert not _wakeup_targets_issue(_wakeup("retry:agent_busy", "skipped"), "issue_x")
    assert not _wakeup_targets_issue(_wakeup("issue_assigned:issue_z", "queued"), "issue_x")


def test_build_issue_run_ledger_joins_wakeups_and_runs(tmp_path):
    store = StateStore(tmp_path / "state.db")

    # A failed work run, a no_response mention, an unrelated wakeup, and a queued one.
    w_fail = store.enqueue_wakeup(_wakeup("issue_assigned:issue_x", "queued"))[0]
    store.finish_wakeup(w_fail.wakeup_id, status="finished", detail="ran:run_fail:failed")
    w_resp = store.enqueue_wakeup(_wakeup("mention:issue_x", "queued", agent="agent_ceo2"))[0]
    store.finish_wakeup(w_resp.wakeup_id, status="finished", detail="ran:run_resp:no_response")
    store.enqueue_wakeup(_wakeup("issue_assigned:issue_other", "queued", agent="agent_z"))
    store.enqueue_wakeup(_wakeup("issue_assigned:issue_x", "queued", agent="agent_q"))  # still queued

    ledger = build_issue_run_ledger(store, "issue_x")
    by_status = {e.status for e in ledger.entries}
    # unrelated issue is excluded; our three issue_x entries are present
    assert len(ledger.entries) == 3
    assert by_status == {"failed", "no_response", "queued"}
    # a queued entry means the issue still has pending work → active
    assert ledger.active is True

    kinds = {e.reason.split(":", 1)[0]: e.kind for e in ledger.entries}
    assert kinds["issue_assigned"] == "work"
    assert kinds["mention"] == "respond"


def test_ledger_entry_carries_agent_profile_id(tmp_path):
    # Each entry must carry the wakeup's owning agent so the surface can render a
    # per-agent "<agent> thinking" indicator (liveness-backed, never message-shape).
    store = StateStore(tmp_path / "state.db")
    w_fail = store.enqueue_wakeup(_wakeup("issue_assigned:issue_x", "queued", agent="agent_ceo"))[0]
    store.finish_wakeup(w_fail.wakeup_id, status="finished", detail="ran:run_fail:failed")
    store.enqueue_wakeup(_wakeup("mention:issue_x", "queued", agent="agent_eng"))  # still queued/active

    ledger = build_issue_run_ledger(store, "issue_x")
    by_reason = {e.reason.split(":", 1)[0]: e.agent_profile_id for e in ledger.entries}
    assert by_reason["issue_assigned"] == "agent_ceo"
    assert by_reason["mention"] == "agent_eng"
    # active semantics unchanged: only the still-queued mention entry is active
    active_agents = {e.agent_profile_id for e in ledger.entries if e.active}
    assert active_agents == {"agent_eng"}
    # round-trips through to_dict for the surface
    assert all("agent_profile_id" in e.to_dict() for e in ledger.entries)


def test_live_run_overrides_to_running(tmp_path):
    store = StateStore(tmp_path / "state.db")
    run = RunSession(
        goal_id="goal_x",
        run_id="run_live",
        status=RunStatus.RUNNING.value,
        execution_context={"issue_id": "issue_x"},
    )
    store.save_run(run)
    wk = store.enqueue_wakeup(_wakeup("issue_assigned:issue_x", "queued"))[0]
    # wakeup row already finished, but the run is still live → ledger says running
    store.finish_wakeup(wk.wakeup_id, status="finished", detail=f"ran:{run.run_id}:completed")

    ledger = build_issue_run_ledger(store, "issue_x")
    assert len(ledger.entries) == 1
    entry = ledger.entries[0]
    assert entry.status == "running"
    assert entry.active is True
    assert entry.run_id == run.run_id
    assert entry.run_status == RunStatus.RUNNING.value


def test_issue_runs_endpoint_projects_ledger(tmp_path):
    from fastapi.testclient import TestClient

    from apps.api.main import create_app
    from superclaw.models import AgentProfile, CompanyProfile, Issue

    db = tmp_path / "state.db"
    store = StateStore(db)
    company = store.save_company_profile(CompanyProfile(name="Acme")).company_profile_id
    ceo = store.save_agent_profile(
        AgentProfile(name="CEO", role="ceo", backend_policy="codex", company_profile_id=company)
    )
    issue = store.save_issue(
        Issue(title="Hire", description="hire an engineer", company_profile_id=company,
              workspace_id="local", status="in_progress", assignee_agent_profile_id=ceo.profile_id)
    )
    wk = store.enqueue_wakeup(
        AgentWakeupRequest(agent_profile_id=ceo.profile_id, reason=f"issue_assigned:{issue.issue_id}")
    )[0]
    store.finish_wakeup(wk.wakeup_id, status="finished", detail="ran:run_x:failed")

    client = TestClient(create_app(state_path=db))
    resp = client.get(f"/api/team/issues/{issue.issue_id}/runs")
    assert resp.status_code == 200
    body = resp.json()
    assert body["issue_id"] == issue.issue_id
    assert [e["status"] for e in body["entries"]] == ["failed"]
    assert body["entries"][0]["kind"] == "work"

    # missing issue → 404 (not silent empty)
    assert client.get("/api/team/issues/issue_missing/runs").status_code == 404

    # contract endpoint matches the kernel
    contract = client.get("/api/contracts/run-ledger")
    assert contract.status_code == 200
    assert contract.json() == build_run_ledger_contract()


def test_failed_run_is_enriched_with_timeout_and_exit_code_from_evidence(tmp_path):
    # The "why it failed" must be visible: a timed-out worker (exit 124) in the
    # run's evidence upgrades a bare 'failed' to 'timed_out' + exit_code (Codex P1#5).
    from superclaw.models import EvidenceBundle, WorkerResult

    store = StateStore(tmp_path / "state.db")
    run = RunSession(goal_id="g", run_id="run_to", status=RunStatus.FAILED.value,
                     execution_context={"issue_id": "issue_x"})
    store.save_run(run)
    evidence = EvidenceBundle(run_id="run_to")
    evidence.worker_results = [
        WorkerResult(task_id="t1", role="ceo", backend="codex", command="codex",
                     exit_code=124, output="", duration_seconds=1.0, timed_out=True),
    ]
    store.save_evidence(evidence)
    wk = store.enqueue_wakeup(_wakeup("issue_assigned:issue_x", "queued"))[0]
    store.finish_wakeup(wk.wakeup_id, status="finished", detail="ran:run_to:failed")

    ledger = build_issue_run_ledger(store, "issue_x")
    entry = ledger.entries[0]
    assert entry.status == "timed_out"
    assert entry.timed_out is True
    assert entry.exit_code == 124


def test_failed_run_with_nonzero_exit_stays_failed_with_exit_code(tmp_path):
    # A non-timeout failure (exit 1) stays 'failed' but still surfaces the exit code.
    from superclaw.models import EvidenceBundle, WorkerResult

    store = StateStore(tmp_path / "state.db")
    run = RunSession(goal_id="g", run_id="run_e1", status=RunStatus.FAILED.value,
                     execution_context={"issue_id": "issue_x"})
    store.save_run(run)
    evidence = EvidenceBundle(run_id="run_e1")
    evidence.worker_results = [
        WorkerResult(task_id="t1", role="ceo", backend="codex", command="codex",
                     exit_code=1, output="", duration_seconds=1.0, timed_out=False),
    ]
    store.save_evidence(evidence)
    wk = store.enqueue_wakeup(_wakeup("issue_assigned:issue_x", "queued"))[0]
    store.finish_wakeup(wk.wakeup_id, status="finished", detail="ran:run_e1:failed")

    entry = build_issue_run_ledger(store, "issue_x").entries[0]
    assert entry.status == "failed"
    assert entry.timed_out is False
    assert entry.exit_code == 1


def test_corrupt_evidence_does_not_break_ledger(tmp_path, monkeypatch):
    # Display-only enrichment must fail soft on corrupt evidence, never 500.
    store = StateStore(tmp_path / "state.db")
    run = RunSession(goal_id="g", run_id="run_c1", status=RunStatus.FAILED.value,
                     execution_context={"issue_id": "issue_x"})
    store.save_run(run)
    wk = store.enqueue_wakeup(_wakeup("issue_assigned:issue_x", "queued"))[0]
    store.finish_wakeup(wk.wakeup_id, status="finished", detail="ran:run_c1:failed")

    def _boom(_run_id):
        raise ValueError("corrupt evidence payload")

    monkeypatch.setattr(store, "get_evidence", _boom)
    entry = build_issue_run_ledger(store, "issue_x").entries[0]
    assert entry.status == "failed"  # stays failed, no crash
    assert entry.exit_code is None


def test_failed_run_without_evidence_stays_failed(tmp_path):
    # No evidence → fail-soft: stays 'failed', no invented timeout.
    store = StateStore(tmp_path / "state.db")
    run = RunSession(goal_id="g", run_id="run_nf", status=RunStatus.FAILED.value,
                     execution_context={"issue_id": "issue_x"})
    store.save_run(run)
    wk = store.enqueue_wakeup(_wakeup("issue_assigned:issue_x", "queued"))[0]
    store.finish_wakeup(wk.wakeup_id, status="finished", detail="ran:run_nf:failed")

    ledger = build_issue_run_ledger(store, "issue_x")
    entry = ledger.entries[0]
    assert entry.status == "failed"
    assert entry.timed_out is False
    assert entry.exit_code is None


def test_waiting_run_is_not_reported_as_running(tmp_path):
    # A run paused on a human gate must read 'waiting' (NOT running) so the surface
    # never blinks "working" on a gated run (Codex P1 #4).
    store = StateStore(tmp_path / "state.db")
    run = RunSession(
        goal_id="goal_g",
        run_id="run_gate",
        status=RunStatus.WAITING_FOR_HUMAN_GATE.value,
        execution_context={"issue_id": "issue_x"},
    )
    store.save_run(run)
    wk = store.enqueue_wakeup(_wakeup("issue_assigned:issue_x", "queued"))[0]
    store.finish_wakeup(wk.wakeup_id, status="finished", detail=f"ran:{run.run_id}:waiting_human_gate")

    ledger = build_issue_run_ledger(store, "issue_x")
    entry = ledger.entries[0]
    assert entry.status == "waiting"
    assert entry.active is False
    assert ledger.active is False


def test_run_ledger_contract_covers_all_statuses():
    contract = build_run_ledger_contract()
    assert contract["capability"] == "issue-run-ledger"
    values = {s["value"] for s in contract["statuses"]}
    assert values == set(LEDGER_STATUSES)
    # active tone/flag matches the kernel active set
    active = {s["value"] for s in contract["statuses"] if s["active"]}
    assert active == set(ACTIVE_LEDGER_STATUSES)
    # every status carries a tone (no silent neutral fallthrough surprises)
    assert all(s["tone"] for s in contract["statuses"])
