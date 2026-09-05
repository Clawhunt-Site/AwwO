"""Agent-company message center — tiered roll-up of approvals + blocked issues.

The single kernel read model behind the "Agent 组" notification center
(docs/agent-company-message-center-design.md). It aggregates ALREADY-EXISTING
governance facts — pending approvals and blocked issues — into a per-company
roll-up plus a flat item list, and layers a per-itemKey read state on top to
derive "unread". It introduces NO new business semantics: every item is a
projection of an approval or an issue the kernel already owns; mutations
(decisions, blocks) still flow through their existing gates.

Why this lives in the kernel (CLAUDE.md 铁律): CLI / API / Web must all read the
SAME aggregation. A surface must never re-derive "unread per company" from raw
agents/issues — that is exactly the drift this module exists to prevent.

Design invariants enforced here:

- ONE pass over approvals + issues, with issue company scope BULK-resolved
  (no per-approval ``get_issue`` N+1). Approval scope reuses the kernel rule:
  an issue-linked approval takes its company from the issue (authoritative);
  an issue-less approval falls back to ``affects.company_profile_id``; an
  approval with neither is UNCLASSIFIED and never leaks into a company bucket.
- Three mutually-exclusive buckets keyed by disjoint itemKeys:
  ``completed_unreviewed`` = pending ``issue_completion`` approvals;
  ``pending_approvals``   = every OTHER pending approval (hire / config / …);
  ``blocked``             = blocked issues. ``total_unread`` de-dupes by
  itemKey, so a completion approval is counted once, never double.
- The read path is PURE: it never writes, never prunes. read state is consulted
  read-only to stamp each item's ``read_at`` / unread flag.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from superclaw.models import (
    Approval,
    ApprovalStatus,
    ApprovalType,
    Issue,
    IssueStatus,
)
from superclaw.state import StateStore

# itemKey == read-state key == the message item's stable identity.
#   approval:<id>        — a pending approval (completion OR other)
#   issue:<id>:blocked   — a blocked issue
# (frozen schema, design §2.5; PR-2 adds comment/deliverable source_types.)

SOURCE_APPROVAL = "approval"
SOURCE_ISSUE_BLOCKED = "issue_blocked"

# Item with no resolvable company. Surfaced in the flat list under this sentinel
# so an unscoped/legacy approval is never silently dropped, but it is NEVER
# folded into a real company's counts.
UNCLASSIFIED_COMPANY = "__unclassified__"


def _approval_item_key(approval_id: str) -> str:
    return f"approval:{approval_id}"


def _blocked_item_key(issue_id: str) -> str:
    return f"issue:{issue_id}:blocked"


def _resolve_approval_company(
    approval: Approval, issues_by_id: dict[str, Issue]
) -> str | None:
    """The authoritative company for an approval, or None if unclassifiable.

    Mirrors ``StateStore.list_approvals`` scope rules but with the issue lookup
    served from a prebuilt map (bulk-resolved → no N+1):

    - issue-linked: the issue's company is AUTHORITATIVE. A stray
      ``affects.company_profile_id`` can never re-route it. An issue id with no
      live row is unclassifiable (fail-closed), not guessed.
    - issue-less: fall back to ``affects.company_profile_id``. Absent that, the
      approval is unclassifiable (legacy rows that predate the top-level
      attribution are NOT guessed into a company — design §2.5, option "归未分类").
    """
    if approval.issue_id:
        issue = issues_by_id.get(approval.issue_id)
        if issue is None:
            return None  # unresolvable issue → unclassified (fail-closed)
        return issue.company_profile_id
    company = (approval.affects or {}).get("company_profile_id")
    return company if isinstance(company, str) and company else None


def _is_unread(read_at: float | None, event_time: float) -> bool:
    """Design §2.5: unread iff never read, or read before the event happened."""
    return read_at is None or read_at < event_time


def build_company_messages_payload(
    store: StateStore,
    *,
    company_profile_id: str | None = None,
    user_id: str = "local_user",
) -> dict[str, Any]:
    """Tiered message roll-up across companies (or one company).

    PURE READ — never writes, never prunes (design §未读: a prune failure must
    not be able to break message reads). ``company_profile_id`` narrows the
    result to a single company's items; ``None`` returns the all-companies view.

    Returns::

        {
          "company_profile_id": <filter or None>,
          "snapshot_as_of": <server clock>,   # mark-read must echo THIS value
          "total_unread": <int, itemKey-deduped>,
          "companies": [
            {company_profile_id, name, pending_approvals, completed_unreviewed,
             blocked, unread_total},
            ...
          ],
          "items": [
            {source_type, source_id, company_profile_id, event_time,
             actionable, read_at, unread},
            ...
          ],
        }
    """
    from time import time as _now

    read_state = store.get_message_read_state(user_id=user_id)

    # --- ONE bulk fetch each; build the issue map once (no per-approval N+1). --
    pending_approvals = store.list_approvals(status=ApprovalStatus.PENDING.value)
    blocked_issues = store.list_issues(status=IssueStatus.BLOCKED.value)
    # Stamp the snapshot AFTER reading the data, not before: every item the
    # snapshot returns then has event_time <= snapshot_as_of (an item created
    # during the read window cannot have a future event_time relative to the
    # snapshot the caller echoes back to mark-read). This is the upper bound a
    # mark-read seen_as_of is clamped to (see mark_messages_read).
    snapshot_as_of = _now()
    # Approval scope needs the company of any issue an approval links to. Fetch
    # those issues in one sweep keyed by id (issue-linked approvals only).
    linked_ids = {a.issue_id for a in pending_approvals if a.issue_id}
    issues_by_id: dict[str, Issue] = {}
    if linked_ids:
        for issue in store.list_issues():
            if issue.issue_id in linked_ids:
                issues_by_id[issue.issue_id] = issue

    # company_profile_id -> {name, pending_approvals, completed_unreviewed,
    #                        blocked, unread_keys:set}
    company_names = {c.company_profile_id: c.name for c in store.list_company_profiles()}

    items: list[dict[str, Any]] = []
    # Per-company aggregate accumulators.
    agg: dict[str, dict[str, Any]] = {}

    def _bucket(cid: str) -> dict[str, Any]:
        slot = agg.get(cid)
        if slot is None:
            slot = {
                "pending_approvals": 0,
                "completed_unreviewed": 0,
                "blocked": 0,
                "unread_keys": set(),
            }
            agg[cid] = slot
        return slot

    # Track itemKeys already counted toward total_unread so a key is NEVER
    # double-counted across buckets (buckets are disjoint by construction, but
    # de-dupe on itemKey is the authoritative guard the design mandates).
    unread_keys_global: set[str] = set()

    def _emit(
        *,
        source_type: str,
        item_key: str,
        cid: str,
        event_time: float,
        bucket_field: str,
    ) -> None:
        if company_profile_id is not None and cid != company_profile_id:
            return
        read_at = read_state.get(item_key)
        unread = _is_unread(read_at, event_time)
        items.append(
            {
                "source_type": source_type,
                "source_id": item_key,
                "company_profile_id": cid,
                "event_time": event_time,
                "actionable": True,  # M-1 items (pending approval / blocked) are all actionable
                "read_at": read_at,
                "unread": unread,
            }
        )
        # Unclassified items surface in the flat list but never inflate a real
        # company's counts or the headline total.
        if cid == UNCLASSIFIED_COMPANY:
            return
        slot = _bucket(cid)
        slot[bucket_field] += 1
        if unread:
            slot["unread_keys"].add(item_key)
            unread_keys_global.add(item_key)

    # --- pending approvals: completion → completed_unreviewed; rest → pending --
    for approval in pending_approvals:
        cid = _resolve_approval_company(approval, issues_by_id) or UNCLASSIFIED_COMPANY
        item_key = _approval_item_key(approval.approval_id)
        if approval.type == ApprovalType.ISSUE_COMPLETION.value:
            _emit(
                source_type=SOURCE_APPROVAL,
                item_key=item_key,
                cid=cid,
                event_time=approval.created_at,
                bucket_field="completed_unreviewed",
            )
        else:
            _emit(
                source_type=SOURCE_APPROVAL,
                item_key=item_key,
                cid=cid,
                event_time=approval.created_at,
                bucket_field="pending_approvals",
            )

    # --- blocked issues: event_time = status_changed_at (NOT updated_at) -------
    for issue in blocked_issues:
        _emit(
            source_type=SOURCE_ISSUE_BLOCKED,
            item_key=_blocked_item_key(issue.issue_id),
            cid=issue.company_profile_id,
            event_time=issue.status_changed_at,
            bucket_field="blocked",
        )

    companies = []
    for cid, slot in agg.items():
        companies.append(
            {
                "company_profile_id": cid,
                "name": company_names.get(cid, cid),
                "pending_approvals": slot["pending_approvals"],
                "completed_unreviewed": slot["completed_unreviewed"],
                "blocked": slot["blocked"],
                "unread_total": len(slot["unread_keys"]),
            }
        )
    companies.sort(key=lambda c: c["company_profile_id"])

    return {
        "company_profile_id": company_profile_id,
        "snapshot_as_of": snapshot_as_of,
        "total_unread": len(unread_keys_global),
        "companies": companies,
        "items": items,
    }


def _live_item_keys(payload: dict[str, Any]) -> set[str]:
    """Every itemKey currently in the live message set (for prune)."""
    return {item["source_id"] for item in payload["items"]}


def mark_messages_read(
    store: StateStore,
    *,
    item_keys: list[str] | None = None,
    company_profile_id: str | None = None,
    seen_as_of: float | None = None,
    user_id: str = "local_user",
    now: "Callable[[], float] | None" = None,
) -> dict[str, Any]:
    """Mark messages read, then prune dead read-state rows.

    BOTH modes require ``seen_as_of`` — the SERVER-issued snapshot the caller
    echoes back (``snapshot_as_of`` from ``build_company_messages_payload``; the
    M-2 API layer issues it). A mark-read may only ever acknowledge an event the
    caller actually OBSERVED, which is exactly "event_time <= the snapshot I read
    at". This is the single defence against the reused-itemKey race: itemKeys are
    reused across re-occurrences (``issue:<id>:blocked`` is the same key after an
    unblock→re-block), so a stale mark-read carrying an old key must NOT silently
    acknowledge a NEWER event that arrived after the snapshot.

    Two mutually-exclusive selection modes:

    1. ``item_keys`` + ``seen_as_of`` — mark exactly these itemKeys read, but
       ONLY each one whose CURRENT ``event_time <= seen_as_of`` (the event has
       not advanced past what the caller saw). A key whose event_time moved
       beyond the snapshot is SKIPPED — it is a new occurrence the caller never
       observed. ``read_at`` is the item's own (snapshot-bounded) event_time.
    2. ``company_profile_id`` + ``seen_as_of`` — mark every CURRENTLY-live item
       of that company whose ``event_time <= seen_as_of`` read. Newer items are
       untouched.

    In both modes ``seen_as_of`` is server-clamped to ``min(seen_as_of, now)`` so
    a future/forged value can never push a read mark ahead of a future event.

    Prune (removing read-state rows no longer in the live message set) runs HERE,
    after the write — never on the read path. Returns a small result summary.
    """
    # Normalize "empty" selections to None FIRST: an empty item_keys list or a
    # blank company_profile_id is NOT a real selection. Without this an
    # ``item_keys=[]`` (which is `not None`) would slip past the both-None guard
    # below, silently selecting nothing yet still running prune as an undeclared
    # side effect (Codex M-2). Fail-closed: a bare empty selection raises below.
    if item_keys is not None and len(item_keys) == 0:
        item_keys = None
    if company_profile_id is not None and not company_profile_id.strip():
        company_profile_id = None

    if item_keys is not None and company_profile_id is not None:
        raise ValueError(
            "mark_messages_read: pass item_keys OR company_profile_id, not both"
        )
    if item_keys is None and company_profile_id is None:
        raise ValueError(
            "mark_messages_read: pass a non-empty item_keys, or a company_profile_id "
            "(both with seen_as_of)"
        )
    if seen_as_of is None:
        raise ValueError(
            "mark_messages_read: seen_as_of is required (echo the snapshot_as_of from "
            "build_company_messages_payload); a mark-read may only acknowledge observed events"
        )
    # Fail-closed on a malformed snapshot BEFORE any read/mutation/prune. A NaN
    # would poison every `event_time <= effective_seen` comparison (all false via
    # min(nan, now)=nan), silently marking nothing while prune still ran; a
    # negative/inf value is not a real server clock. Reject rather than guess.
    import math

    if not math.isfinite(seen_as_of) or seen_as_of < 0:
        raise ValueError(
            f"mark_messages_read: seen_as_of must be a finite non-negative epoch, got {seen_as_of!r}"
        )

    from time import time as _wallclock

    _clock = now or _wallclock
    # prune_floor = a LOWER bound on the live snapshot: captured BEFORE any read,
    # so every read below — and any concurrent write that races us — happens at or
    # after it. prune deletes a non-live row only if its read_at is STRICTLY <
    # this floor (state.prune_message_read_state), i.e. it was already read/dead
    # before we even started looking. This closes BOTH the cross-call stale-prune
    # race AND its deeper variant (Codex M-1): an itemKey that re-occurs (e.g.
    # issue unblock→re-block) at or during our read window gets event_time >=
    # prune_floor, so a concurrent mark-read's fresh read_at (== that event_time)
    # is NOT < floor and survives this stale prune. NB: we deliberately do NOT use
    # the payload's snapshot_as_of — that is stamped AFTER the reads (an UPPER
    # bound, correct for mark-read's seen_as_of but unsafe as a prune floor). The
    # injectable ``now`` clock is a test seam that pins this pre-read lower bound.
    prune_floor = _clock()

    # Build the GLOBAL (unfiltered) payload: this drives selection AND supplies the
    # live itemKey set for prune. Prune MUST see every company's live keys — a
    # company-scoped live set would treat all OTHER companies' read rows as stale
    # and delete them, re-surfacing their read messages as unread (cross-company
    # data loss). Selection below then narrows to the requested company.
    payload = build_company_messages_payload(store, company_profile_id=None, user_id=user_id)
    live = _live_item_keys(payload)

    # Server-clamp: a snapshot echoed back can never legitimately exceed the
    # current server clock. Clamping makes a future/forged value no stronger than
    # "now", so it can never push read_at ahead of a FUTURE event on a reused key.
    effective_seen = min(seen_as_of, _clock())
    # Current event_time per live itemKey: an event that advanced PAST the caller's
    # snapshot must not be acknowledged by a stale mark-read carrying the old key.
    live_event_time = {item["source_id"]: item["event_time"] for item in payload["items"]}

    to_set: dict[str, float] = {}
    if item_keys is not None:
        for key in item_keys:
            if key not in live:
                continue  # not a live message → un-markable (no arbitrary key seeding)
            event_time = live_event_time[key]
            if event_time > effective_seen:
                continue  # newer occurrence than the caller saw → leave unread
            # read_at = the (observed) event_time, so a strictly-later
            # re-occurrence (newer event_time) always reads unread again.
            to_set[key] = event_time
    else:
        for item in payload["items"]:
            if item["company_profile_id"] != company_profile_id:
                continue
            if item["event_time"] <= effective_seen:
                to_set[item["source_id"]] = item["event_time"]

    store.set_message_read_state(to_set, user_id=user_id)
    pruned = store.prune_message_read_state(live, prune_floor=prune_floor, user_id=user_id)
    return {
        "marked": len(to_set),
        "pruned": pruned,
        "company_profile_id": company_profile_id,
        "seen_as_of": seen_as_of,
    }
