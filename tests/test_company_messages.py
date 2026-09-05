"""Tests for the Agent-company message center read model + read state (M-1).

Covers the design invariants (docs/agent-company-message-center-design.md):
- cross-company isolation (an item never leaks into another company's counts);
- three disjoint buckets (completed_unreviewed vs pending_approvals vs blocked);
- completion approval counted ONCE (no double-count in total_unread);
- blocked event_time = status_changed_at (not updated_at);
- unread read-state semantics + monotonic mark-read + server-snapshot clamp;
- prune runs only on mark-read, read path is pure;
- no per-approval get_issue N+1.
"""

import time

import pytest

from superclaw import team_kernel
from superclaw.company_messages import (
    UNCLASSIFIED_COMPANY,
    build_company_messages_payload,
    mark_messages_read,
)
from superclaw.models import (
    AgentProfile,
    CompanyProfile,
    Issue,
    IssueStatus,
)
from superclaw.state import StateStore


@pytest.fixture
def store(tmp_path):
    return StateStore(tmp_path / "state.db")


def _company(store, cid, name):
    company = CompanyProfile(company_profile_id=cid, name=name)
    store.save_company_profile(company)
    return company


def _blocked_issue(store, *, cid, title="work"):
    issue = store.save_issue(
        Issue(title=title, company_profile_id=cid, status=IssueStatus.TODO.value)
    )
    return team_kernel.block_issue(store, issue.issue_id, reason="waiting")


def _snap(store, *, company_profile_id=None):
    """The server snapshot a caller would echo back to mark-read."""
    return build_company_messages_payload(
        store, company_profile_id=company_profile_id
    )["snapshot_as_of"]


# --- roll-up shape + cross-company isolation --------------------------------


def test_blocked_issues_bucket_per_company_and_no_cross_leak(store):
    _company(store, "co_a", "Alpha")
    _company(store, "co_b", "Beta")
    _blocked_issue(store, cid="co_a")
    _blocked_issue(store, cid="co_a")
    _blocked_issue(store, cid="co_b")

    payload = build_company_messages_payload(store)
    by_id = {c["company_profile_id"]: c for c in payload["companies"]}
    assert by_id["co_a"]["blocked"] == 2
    assert by_id["co_b"]["blocked"] == 1
    # A co_a item never inflates co_b and vice versa.
    assert by_id["co_a"]["pending_approvals"] == 0
    assert by_id["co_b"]["pending_approvals"] == 0


def test_company_filter_narrows_items_and_companies(store):
    _company(store, "co_a", "Alpha")
    _company(store, "co_b", "Beta")
    _blocked_issue(store, cid="co_a")
    _blocked_issue(store, cid="co_b")

    payload = build_company_messages_payload(store, company_profile_id="co_a")
    assert {c["company_profile_id"] for c in payload["companies"]} == {"co_a"}
    assert all(i["company_profile_id"] == "co_a" for i in payload["items"])


# --- three disjoint buckets + no double count -------------------------------


def test_completion_approval_in_completed_not_pending_and_counted_once(store):
    _company(store, "co_a", "Alpha")
    profile = AgentProfile(name="Eng", role="engineer", company_profile_id="co_a")
    store.save_agent_profile(profile)
    issue = store.save_issue(
        Issue(
            title="ship",
            company_profile_id="co_a",
            status=IssueStatus.IN_PROGRESS.value,
            assignee_agent_profile_id=profile.profile_id,
            checkout_run_id="run_1",
            execution_run_id="run_1",
        )
    )
    # submit_for_review opens a pending issue_completion approval.
    _, approval = team_kernel.submit_for_review(
        store, issue.issue_id, summary="done", requested_by=profile.profile_id
    )

    payload = build_company_messages_payload(store)
    co_a = next(c for c in payload["companies"] if c["company_profile_id"] == "co_a")
    assert co_a["completed_unreviewed"] == 1
    assert co_a["pending_approvals"] == 0  # NOT double-counted into pending
    # total_unread counts the completion item exactly once.
    assert payload["total_unread"] == 1
    item_keys = [i["source_id"] for i in payload["items"]]
    assert item_keys.count(f"approval:{approval.approval_id}") == 1


def test_hire_approval_in_pending_not_completed(store):
    _company(store, "co_a", "Alpha")
    approval = team_kernel.request_hire(
        store,
        spec={"name": "New", "role": "engineer", "company_profile_id": "co_a"},
        requested_by="local_user",
    )
    payload = build_company_messages_payload(store)
    co_a = next(c for c in payload["companies"] if c["company_profile_id"] == "co_a")
    assert co_a["pending_approvals"] == 1
    assert co_a["completed_unreviewed"] == 0
    assert payload["total_unread"] == 1
    assert any(i["source_id"] == f"approval:{approval.approval_id}" for i in payload["items"])


# --- issue-less approval scope (commit 2 contract) --------------------------


def test_config_change_approval_scoped_to_target_company(store):
    _company(store, "co_a", "Alpha")
    profile = AgentProfile(name="Eng", role="engineer", company_profile_id="co_a")
    store.save_agent_profile(profile)
    team_kernel.request_agent_config_change(
        store,
        target_profile_id=profile.profile_id,
        patch={"model": "claude-sonnet-4-6"},
        requested_by=profile.profile_id,
    )
    payload = build_company_messages_payload(store)
    co_a = next(c for c in payload["companies"] if c["company_profile_id"] == "co_a")
    assert co_a["pending_approvals"] == 1


def test_legacy_issueless_approval_without_company_is_unclassified(store):
    # An approval persisted before top-level affects.company_profile_id existed:
    # it must NOT be guessed into a company. It surfaces as unclassified only.
    from superclaw.models import Approval, ApprovalType

    legacy = Approval(
        type=ApprovalType.AGENT_HIRE.value,
        affects={"spec": {"name": "x", "role": "engineer"}},  # no company_profile_id
    )
    store.save_approval(legacy)
    _company(store, "co_a", "Alpha")

    payload = build_company_messages_payload(store)
    # UNCLASSIFIED is never materialized as a company aggregate bucket.
    assert all(c["company_profile_id"] != UNCLASSIFIED_COMPANY for c in payload["companies"])
    real = [c for c in payload["companies"] if c["company_profile_id"] == "co_a"]
    assert real == [] or real[0]["pending_approvals"] == 0
    # But surfaced in the flat list under the unclassified sentinel.
    unclassified = [i for i in payload["items"] if i["company_profile_id"] == UNCLASSIFIED_COMPANY]
    assert len(unclassified) == 1
    # Unclassified never inflates total_unread.
    assert payload["total_unread"] == 0


# --- blocked event_time = status_changed_at (not updated_at) ----------------


def test_blocked_event_time_is_status_changed_at(store):
    _company(store, "co_a", "Alpha")
    blocked = _blocked_issue(store, cid="co_a")
    payload = build_company_messages_payload(store)
    item = next(i for i in payload["items"] if i["source_type"] == "issue_blocked")
    assert item["event_time"] == blocked.status_changed_at
    # A later comment-style updated_at bump must NOT move event_time.
    later = store.get_issue(blocked.issue_id)
    later.updated_at = time.time() + 1000
    later.metadata = {"note": "x"}
    store.save_issue(later)
    payload2 = build_company_messages_payload(store)
    item2 = next(i for i in payload2["items"] if i["source_type"] == "issue_blocked")
    assert item2["event_time"] == blocked.status_changed_at


# --- unread / read-state semantics ------------------------------------------


def test_unread_then_marked_read_by_item_key(store):
    _company(store, "co_a", "Alpha")
    blocked = _blocked_issue(store, cid="co_a")
    key = f"issue:{blocked.issue_id}:blocked"

    payload = build_company_messages_payload(store)
    assert payload["total_unread"] == 1
    assert next(i for i in payload["items"] if i["source_id"] == key)["unread"] is True

    result = mark_messages_read(store, item_keys=[key], seen_as_of=payload["snapshot_as_of"])
    assert result["marked"] == 1
    payload2 = build_company_messages_payload(store)
    assert payload2["total_unread"] == 0
    assert next(i for i in payload2["items"] if i["source_id"] == key)["unread"] is False


def test_mark_read_by_company_seen_as_of_clamps_to_snapshot(store):
    _company(store, "co_a", "Alpha")
    old = _blocked_issue(store, cid="co_a")
    snapshot = build_company_messages_payload(store, company_profile_id="co_a")["snapshot_as_of"]
    time.sleep(0.01)
    new = _blocked_issue(store, cid="co_a")  # event_time > snapshot

    # Mark read up to the server snapshot: the old item is read, the new one stays unread.
    mark_messages_read(store, company_profile_id="co_a", seen_as_of=snapshot)
    payload = build_company_messages_payload(store, company_profile_id="co_a")
    items = {i["source_id"]: i for i in payload["items"]}
    assert items[f"issue:{old.issue_id}:blocked"]["unread"] is False
    assert items[f"issue:{new.issue_id}:blocked"]["unread"] is True
    assert payload["total_unread"] == 1


def test_mark_read_future_seen_as_of_cannot_mark_nonexistent(store):
    _company(store, "co_a", "Alpha")
    _blocked_issue(store, cid="co_a")
    # A wildly-future seen_as_of only affects items that ALREADY exist & are live.
    mark_messages_read(store, company_profile_id="co_a", seen_as_of=time.time() + 10_000)
    payload = build_company_messages_payload(store, company_profile_id="co_a")
    assert payload["total_unread"] == 0
    # A brand-new blocked issue after the mark is still unread (was not live then).
    new = _blocked_issue(store, cid="co_a")
    payload2 = build_company_messages_payload(store, company_profile_id="co_a")
    assert next(
        i for i in payload2["items"] if i["source_id"] == f"issue:{new.issue_id}:blocked"
    )["unread"] is True


def test_stale_prune_does_not_delete_concurrent_newer_read_mark(store):
    # Codex M-1 race (incl. the deep "live-read done, snapshot not yet stamped"
    # window): a stale prune whose floor is a PRE-READ LOWER BOUND must never
    # delete a read mark written for an event that occurred at/after that floor —
    # even a reused itemKey (issue unblock→re-block reuses issue:<id>:blocked).
    # The floor is captured as a real lower bound (BEFORE X exists), exactly as
    # mark_messages_read captures prune_floor before building the live set. A test
    # that used the POST-read snapshot here would NOT catch a regression to the
    # old upper-bound floor — so we pin the lower-bound contract explicitly.
    _company(store, "co_a", "Alpha")
    floor_a = time.time()  # pre-read LOWER bound; X does not exist yet
    live_a: set[str] = set()  # X (and everything) not live at A
    time.sleep(0.01)

    # X gets blocked AFTER floor_a → its event_time (status_changed_at) > floor_a.
    x = _blocked_issue(store, cid="co_a")
    key = f"issue:{x.issue_id}:blocked"
    assert x.status_changed_at > floor_a  # the event is strictly newer than the floor

    # Concurrent fresh mark-read B observes X and writes read_at = X.event_time (> floor_a).
    snap_b = build_company_messages_payload(store)["snapshot_as_of"]
    mark_messages_read(store, item_keys=[key], seen_as_of=snap_b)
    assert key in store.get_message_read_state(), "B's read mark should be persisted"

    # A's STALE prune now runs with its old live set (no X) and old LOWER-bound floor.
    store.prune_message_read_state(live_a, prune_floor=floor_a)

    # B's newer read mark MUST survive (read_at > floor_a) — message stays read.
    assert key in store.get_message_read_state(), "stale prune must not delete the newer mark"
    payload = build_company_messages_payload(store)
    assert next(i for i in payload["items"] if i["source_id"] == key)["unread"] is False
    assert payload["total_unread"] == 0


def test_prune_strict_boundary_read_at_equal_floor_survives(store):
    # time.time() is not monotonic: a same-tick equal value must NOT be reaped
    # (strict ``read_at < prune_floor``). A row whose read_at == floor survives;
    # it is reaped only once a later floor strictly exceeds it.
    _company(store, "co_a", "Alpha")
    x = _blocked_issue(store, cid="co_a")
    key = f"issue:{x.issue_id}:blocked"
    snap = build_company_messages_payload(store)["snapshot_as_of"]
    mark_messages_read(store, item_keys=[key], seen_as_of=snap)
    read_at = store.get_message_read_state()[key]

    team_kernel.unblock_issue(store, x.issue_id)  # X no longer live
    # Floor EXACTLY equal to the row's read_at → strict ``<`` must keep it.
    store.prune_message_read_state(set(), prune_floor=read_at)
    assert key in store.get_message_read_state(), "read_at == floor must survive (strict <)"
    # A strictly-greater floor finally reaps the (genuinely dead) row.
    store.prune_message_read_state(set(), prune_floor=read_at + 1.0)
    assert key not in store.get_message_read_state()


def test_mark_read_uses_pre_read_lower_bound_floor_not_payload_snapshot(store):
    # Integration guard (Codex M-1): mark_messages_read must capture prune_floor
    # as a PRE-READ lower bound, NOT the payload's post-read snapshot_as_of. With
    # an injected clock pinning the floor BELOW a seeded non-live read mark, that
    # mark must SURVIVE. If the impl regressed to using the (real-now) payload
    # snapshot as the floor, the seeded read_at would be < that floor and reaped —
    # so this test fails on regression.
    _company(store, "co_a", "Alpha")
    # A non-live read-state row with read_at = 1000.0 (not in any live message set).
    store.set_message_read_state({"approval:ghost": 1000.0})

    # Injected clock → prune_floor = 500.0 (BELOW the seeded read_at 1000.0).
    mark_messages_read(
        store, company_profile_id="co_a", seen_as_of=500.0, now=lambda: 500.0
    )

    # Survives: read_at 1000.0 is NOT < pre-read floor 500.0. (Were the floor the
    # real-now payload snapshot ≫ 1000.0, the row would have been wrongly reaped.)
    assert "approval:ghost" in store.get_message_read_state()


def test_prune_still_reaps_genuinely_dead_read_rows(store):
    # The floor guard must not break normal pruning: a row that is dead AS OF the
    # floor (read_at < floor, itemKey not live) is still removed (table bounded).
    _company(store, "co_a", "Alpha")
    x = _blocked_issue(store, cid="co_a")
    key = f"issue:{x.issue_id}:blocked"
    snap = build_company_messages_payload(store)["snapshot_as_of"]
    mark_messages_read(store, item_keys=[key], seen_as_of=snap)
    assert key in store.get_message_read_state()

    # X resolves (unblock) → no longer live; prune with a floor past its read_at reaps it.
    team_kernel.unblock_issue(store, x.issue_id)
    time.sleep(0.01)
    later_floor = build_company_messages_payload(store)["snapshot_as_of"]
    removed = store.prune_message_read_state(set(), prune_floor=later_floor)
    assert removed >= 1
    assert key not in store.get_message_read_state(), "a genuinely dead row must be reaped"


def test_mark_read_is_monotonic_does_not_regress(store):
    _company(store, "co_a", "Alpha")
    blocked = _blocked_issue(store, cid="co_a")
    key = f"issue:{blocked.issue_id}:blocked"
    store.set_message_read_state({key: 5000.0})
    # An older mark must not move read_at backwards.
    store.set_message_read_state({key: 1000.0})
    assert store.get_message_read_state()[key] == 5000.0


def test_read_path_does_not_prune_or_write(store):
    # A stale read-state row (itemKey no longer live) must survive a pure read.
    store.set_message_read_state({"approval:gone": 123.0})
    build_company_messages_payload(store)
    assert "approval:gone" in store.get_message_read_state()


def test_prune_on_mark_read_removes_dead_rows(store):
    _company(store, "co_a", "Alpha")
    blocked = _blocked_issue(store, cid="co_a")
    key = f"issue:{blocked.issue_id}:blocked"
    store.set_message_read_state({"approval:gone": 123.0})  # dead row
    mark_messages_read(store, item_keys=[key], seen_as_of=_snap(store))
    state = store.get_message_read_state()
    assert "approval:gone" not in state  # pruned on mark-read
    assert key in state


def test_mark_read_rejects_both_modes(store):
    with pytest.raises(ValueError):
        mark_messages_read(store, item_keys=["x"], company_profile_id="co_a", seen_as_of=1.0)
    with pytest.raises(ValueError):
        mark_messages_read(store, seen_as_of=1.0)


def test_mark_read_requires_seen_as_of_in_both_modes(store):
    # seen_as_of is mandatory: a mark-read may only acknowledge OBSERVED events.
    with pytest.raises(ValueError):
        mark_messages_read(store, item_keys=["x"])
    with pytest.raises(ValueError):
        mark_messages_read(store, company_profile_id="co_a")


def test_no_n_plus_one_issue_fetch(store, monkeypatch):
    # The read model must bulk-resolve issue scope: list_issues called a bounded
    # number of times (status=blocked, plus one full sweep for linked approvals),
    # never once-per-approval.
    _company(store, "co_a", "Alpha")
    profile = AgentProfile(name="Eng", role="engineer", company_profile_id="co_a")
    store.save_agent_profile(profile)
    for _ in range(5):
        issue = store.save_issue(
            Issue(
                title="ship",
                company_profile_id="co_a",
                status=IssueStatus.IN_PROGRESS.value,
                assignee_agent_profile_id=profile.profile_id,
                checkout_run_id="run_x",
                execution_run_id="run_x",
            )
        )
        team_kernel.submit_for_review(
            store, issue.issue_id, summary="done", requested_by=profile.profile_id
        )

    calls = {"get_issue": 0}
    real_get_issue = store.get_issue

    def _counting_get_issue(issue_id):
        calls["get_issue"] += 1
        return real_get_issue(issue_id)

    monkeypatch.setattr(store, "get_issue", _counting_get_issue)
    build_company_messages_payload(store)
    # No per-approval get_issue: scope resolution uses the bulk issue map.
    assert calls["get_issue"] == 0


# --- regression: blockers found in adversarial review -----------------------


def test_company_mark_read_does_not_prune_other_company_read_state(store):
    # A single-company mark-read must NOT delete OTHER companies' read rows
    # (cross-company data loss): prune runs against the GLOBAL live set.
    _company(store, "co_a", "Alpha")
    _company(store, "co_b", "Beta")
    a = _blocked_issue(store, cid="co_a")
    b = _blocked_issue(store, cid="co_b")
    key_a = f"issue:{a.issue_id}:blocked"
    key_b = f"issue:{b.issue_id}:blocked"

    # Mark co_b read first.
    mark_messages_read(store, item_keys=[key_b], seen_as_of=_snap(store))
    assert key_b in store.get_message_read_state()

    # Now mark co_a read; co_b's still-live read row must survive.
    mark_messages_read(store, item_keys=[key_a], seen_as_of=_snap(store))
    state = store.get_message_read_state()
    assert key_a in state and key_b in state
    # And co_b stays read across the board.
    payload = build_company_messages_payload(store)
    items = {i["source_id"]: i for i in payload["items"]}
    assert items[key_b]["unread"] is False
    assert items[key_a]["unread"] is False
    assert payload["total_unread"] == 0


def test_future_seen_as_of_does_not_suppress_reblock_on_same_item_key(store):
    # itemKey issue:<id>:blocked is REUSED across unblock→re-block. A future
    # seen_as_of must be clamped to server-now so it cannot push read_at past a
    # LATER re-block's status_changed_at (which would wrongly suppress unread).
    _company(store, "co_a", "Alpha")
    blocked = _blocked_issue(store, cid="co_a")
    key = f"issue:{blocked.issue_id}:blocked"

    # Attempt to mark read with a wildly-future snapshot.
    mark_messages_read(store, company_profile_id="co_a", seen_as_of=time.time() + 1_000_000)
    # read_at must be clamped to <= server-now, NOT the future value.
    assert store.get_message_read_state()[key] <= time.time() + 1.0

    # Unblock then re-block: same itemKey, NEW (later) status_changed_at.
    team_kernel.unblock_issue(store, blocked.issue_id)
    time.sleep(0.01)
    reblocked = team_kernel.block_issue(store, blocked.issue_id, reason="again")
    payload = build_company_messages_payload(store, company_profile_id="co_a")
    item = next(i for i in payload["items"] if i["source_id"] == key)
    assert item["event_time"] == reblocked.status_changed_at
    # The re-block is a NEW event → unread again (read_at did not jump to the future).
    assert item["unread"] is True


def test_item_key_mark_read_does_not_suppress_reblock_on_same_key(store):
    # item-key mode anchors read_at to the item's OWN event_time, so a later
    # re-block of the SAME reused itemKey (newer status_changed_at) reads unread
    # again — even if the two events are near-instant on the wall clock.
    _company(store, "co_a", "Alpha")
    blocked = _blocked_issue(store, cid="co_a")
    key = f"issue:{blocked.issue_id}:blocked"
    mark_messages_read(store, item_keys=[key], seen_as_of=_snap(store))
    # read_at == the event_time the caller saw (the original block), not "now".
    assert store.get_message_read_state()[key] == blocked.status_changed_at

    team_kernel.unblock_issue(store, blocked.issue_id)
    time.sleep(0.01)
    reblocked = team_kernel.block_issue(store, blocked.issue_id, reason="again")
    payload = build_company_messages_payload(store, company_profile_id="co_a")
    item = next(i for i in payload["items"] if i["source_id"] == key)
    assert item["event_time"] == reblocked.status_changed_at
    assert item["unread"] is True  # newer event > prior read_at


def test_stale_item_key_mark_read_does_not_ack_unseen_reblock(store):
    # Codex R3 race: caller observes the block at snapshot S, then the issue
    # unblocks→re-blocks (newer event) BEFORE the stale mark-read arrives. The
    # stale mark-read (carrying snapshot S + the reused itemKey) must NOT
    # acknowledge the new occurrence the caller never saw.
    _company(store, "co_a", "Alpha")
    blocked = _blocked_issue(store, cid="co_a")
    key = f"issue:{blocked.issue_id}:blocked"
    seen = _snap(store)  # caller's snapshot, taken while event_time == original block

    # The world moves on: unblock → re-block produces a NEWER event_time.
    team_kernel.unblock_issue(store, blocked.issue_id)
    time.sleep(0.01)
    reblocked = team_kernel.block_issue(store, blocked.issue_id, reason="again")
    assert reblocked.status_changed_at > seen

    # Stale mark-read with the OLD snapshot: must skip — event advanced past it.
    result = mark_messages_read(store, item_keys=[key], seen_as_of=seen)
    assert result["marked"] == 0
    payload = build_company_messages_payload(store, company_profile_id="co_a")
    item = next(i for i in payload["items"] if i["source_id"] == key)
    assert item["unread"] is True  # unseen re-block stays unread


def test_mark_read_rejects_non_finite_or_negative_seen_as_of(store):
    # Fail-closed: a NaN/inf/negative snapshot must be rejected BEFORE any
    # mutation or prune (NaN would poison every comparison and silently mark
    # nothing while still pruning). A stale read row must survive the rejection.
    import math

    _company(store, "co_a", "Alpha")
    store.set_message_read_state({"approval:gone": 1.0})  # would-be prune victim
    for bad in (math.nan, math.inf, -1.0):
        with pytest.raises(ValueError):
            mark_messages_read(store, company_profile_id="co_a", seen_as_of=bad)
        with pytest.raises(ValueError):
            mark_messages_read(store, item_keys=["k"], seen_as_of=bad)
    # No prune happened on the rejected calls.
    assert "approval:gone" in store.get_message_read_state()


def test_mark_read_empty_selection_is_rejected(store):
    # Empty item_keys (or blank company) is NOT a real selection — it must raise
    # (fail-closed), never silently no-op-then-prune (Codex M-2).
    with pytest.raises(ValueError):
        mark_messages_read(store, item_keys=[], seen_as_of=1.0)
    with pytest.raises(ValueError):
        mark_messages_read(store, company_profile_id="   ", seen_as_of=1.0)
    # An empty item_keys WITH a real company falls back to company mode (no raise).
    _company(store, "co_a", "Alpha")
    res = mark_messages_read(store, item_keys=[], company_profile_id="co_a", seen_as_of=1.0)
    assert res["company_profile_id"] == "co_a"
