from __future__ import annotations

import contextlib
import json
import math
import os
import sqlite3
import socket
import sys
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable

if TYPE_CHECKING:
    from superclaw.agent_runtime.bus import EventBus

from superclaw.escalation import (
    EscalationDenied,
    EscalationEnvelope,
    EscalationError,
    EscalationKind,
    EscalationStatus,
    grant_authorizes,
    grant_authorizes_runtime_tool,
    is_valid_escalation_status_transition,
    sign_grant,
    validate_new_envelope,
    verify_envelope,
)
from superclaw.write_gate import assert_writes_allowed
from superclaw.models import (
    AgentProfile,
    AgentRuntimeState,
    AgentTaskSession,
    AgentWakeupRequest,
    Approval,
    ApprovalStatus,
    ChatMessage,
    ChatSession,
    CompanyMembership,
    CompanyProfile,
    CompanySecret,
    CompanySecretBinding,
    CompanySecretVersion,
    ChainVerdict,
    ContinuationPolicy,
    InstanceUserRole,
    assert_valid_issue_typed_fields,
    IssueComment,
    IssueHold,
    IssueThreadInteraction,
    CostEvent,
    EvidenceBundle,
    GoalRecord,
    GoalSpec,
    GoalStatus,
    is_valid_goal_status_transition,
    InstanceSettings,
    Issue,
    IssueStatus,
    MarketplaceOrder,
    MarketplaceOrderStatus,
    ReviewPolicy,
    RunMutationLease,
    RunMutationMode,
    _PARENT_SCOPED_REVIEW_POLICIES,
    RunSession,
    RunStatus,
    RunTicket,
    SecretAccessEvent,
    TeamRoutineSchedule,
    WorkProduct,
    WorkspaceLock,
    WorkspaceProfile,
    is_valid_approval_status_transition,
    is_valid_issue_status_transition,
    is_valid_marketplace_order_transition,
    is_valid_run_status_transition,
)

# Sentinel distinguishing "caller did not supply expected_workspace_id" from a
# real value of None (None means UNASSIGNED/Inbox — a valid boundary, not absence).
_MOVE_GUARD_UNSET: Any = object()

# Sentinel for release_workspace_lock's expected_run_id: lets a caller pass
# expected_run_id=None to mean "delete only if the lock's run_id is EXACTLY None"
# (a real compare), distinct from "no run_id check at all" (the sentinel default).
_RUN_ID_UNSET: Any = object()


def _serialize_issue(issue: Issue) -> str:
    """Single fail-closed serialization gate for every ``issues.payload`` write.

    Re-validates the typed business fields (kind/review_policy) immediately before
    persistence, so NO write path — ``save_issue``, ``commit_checkout``,
    ``save_delegated_child``, ``submit_issue_for_review``,
    ``apply_approval_decision`` — can store an issue whose field was mutated to an
    invalid value after construction. Every site that writes the payload column
    must serialize through this function rather than calling ``json.dumps`` directly.
    """
    assert_valid_issue_typed_fields(issue)
    return json.dumps(issue.to_dict(), ensure_ascii=False)


def _stamp_status_changed_at(conn: sqlite3.Connection, issue: Issue) -> None:
    """Stamp ``issue.status_changed_at`` to now IFF this write transitions status.

    Single choke point for the message-center "blocked since" event_time
    (docs/agent-company-message-center-design.md §2.5). Every issue write path
    (save_issue, commit_checkout, save_delegated_child, anchor_run_on_issue,
    submit_issue_for_review, auto_complete_issue, apply_approval_decision) routes
    through here right before serialization, so a comment/metadata-only resave —
    where ``status`` is unchanged — leaves status_changed_at alone, while EVERY
    status transition advances it exactly once. Reads the prior row on the SAME
    connection/transaction the write uses, so the comparison is consistent with
    what is about to be persisted (no read-then-write race against a concurrent
    transition). A brand-new row keeps the constructor's seed (status_changed_at
    == created_at). NOT a status change → no-op.
    """
    row = conn.execute(
        "SELECT status FROM issues WHERE issue_id = ?", (issue.issue_id,)
    ).fetchone()
    if row is None:
        return  # first persist of this issue → keep the constructor's seed
    if row["status"] != issue.status:
        issue.status_changed_at = time.time()


def resolve_cost_window(
    *,
    today: bool = False,
    since: str | None = None,
    until: str | None = None,
    now: float | None = None,
) -> tuple[float | None, float | None]:
    """Resolve ``--today``/``--since``/``--until`` into a half-open [since, until)
    epoch window. SINGLE SOURCE OF TRUTH shared by the CLI and the API so the two
    cost views can never diverge (CLI-as-source-of-truth iron rule).

    Dates are local-calendar ``YYYY-MM-DD``. ``today`` is the FULL local calendar
    day ``[midnight today, midnight tomorrow)`` — future-dated rows are excluded.
    Raises ``ValueError`` on contradictory or malformed input (fail-closed); each
    surface translates the error into its own shape (CLI exit / API 400).
    """

    def _midnight(date_str: str) -> float:
        s = (date_str or "").strip()
        if not s:
            raise ValueError("date must not be empty")
        try:
            parsed = time.strptime(s, "%Y-%m-%d")
        except ValueError as exc:
            raise ValueError(f"invalid date (expected YYYY-MM-DD): {date_str}") from exc
        return time.mktime((parsed.tm_year, parsed.tm_mon, parsed.tm_mday, 0, 0, 0, 0, 0, -1))

    if today:
        if since is not None or until is not None:
            raise ValueError("--today cannot be combined with --since/--until")
        ref = time.localtime(now) if now is not None else time.localtime()
        start = time.mktime((ref.tm_year, ref.tm_mon, ref.tm_mday, 0, 0, 0, 0, 0, -1))
        # Next local midnight via day+1 normalization (mktime folds month/DST
        # rollover) so the window is the whole calendar day, not "midnight onward".
        end = time.mktime((ref.tm_year, ref.tm_mon, ref.tm_mday + 1, 0, 0, 0, 0, 0, -1))
        return start, end
    since_epoch = _midnight(since) if since is not None else None
    until_epoch = _midnight(until) if until is not None else None
    if since_epoch is not None and until_epoch is not None and until_epoch <= since_epoch:
        raise ValueError("--until must be after --since")
    return since_epoch, until_epoch


class GoalRevisionConflict(ValueError):
    """Raised by ``update_goal_record`` when a goal's stored ``revision`` no longer
    matches the caller's ``expected_revision`` — the optimistic-concurrency guard
    that stops two surfaces (e.g. two browser tabs) from racing a goal's lifecycle
    or replaying a stale confirmation. Subclasses ``ValueError`` to match the
    existing kernel conflict convention (``team_kernel.IssueHeldError``)."""


class StateStore:
    # Bumped only on a destructive/altering migration (additive CREATE TABLE IF
    # NOT EXISTS does not need a bump). Stamped into PRAGMA user_version at init.
    SCHEMA_VERSION = 1

    def __init__(self, path: str | Path, *, event_bus: "EventBus | None" = None) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # Optional in-process doorbell. When set, durable event writes ring it so
        # live readers (SSE) wake immediately instead of polling. Defaults to None
        # so existing callers and tests are unaffected.
        self._event_bus = event_bus
        # Count of display/audit event writes that failed and were swallowed
        # (DL8 safe-write): a run must never crash because the events table is
        # unwritable. Surfaced for diagnostics, never raised into the run flow.
        self._event_write_failures = 0
        self._init()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path, timeout=10.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout = 10000")
        # WAL lets readers and the writer proceed concurrently; NORMAL trades a
        # tiny durability window for far fewer fsyncs. Both are safe for this
        # local run-state store.
        conn.execute("PRAGMA synchronous = NORMAL")
        return conn

    def _init(self) -> None:
        # B4 fail-closed: a maintenance window freezes the ENTIRE construction
        # write face — journal_mode, CREATE TABLE/INDEX schema, and the
        # instance_user_roles governance seed below — not just the seed. A real
        # cutover opens the new StateStore under the migrator's
        # allow_writes_during_maintenance() hatch, so this is a no-op there;
        # outside a window it is a no-op too. Without the hatch a store cannot be
        # built mid-freeze (correct: nothing constructs DB state under a cutover
        # except the migrator).
        assert_writes_allowed("_init")
        with self._connect() as conn:
            # Older builds must not recreate v1 tables or change journal settings
            # in a future DB.
            current_version = int(conn.execute("PRAGMA user_version").fetchone()[0])
            if current_version > self.SCHEMA_VERSION:
                raise RuntimeError(
                    f"state DB schema version {current_version} is newer than this "
                    f"build understands ({self.SCHEMA_VERSION}); refusing to open "
                    "(downgrading the version stamp could corrupt it)"
                )
            # journal_mode is persistent on the database file; setting it once at
            # init is enough. It must run outside an open transaction.
            try:
                conn.execute("PRAGMA journal_mode = WAL")
            except sqlite3.OperationalError:  # pragma: no cover - e.g. :memory:
                pass
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS goals (
                    goal_id TEXT PRIMARY KEY,
                    payload TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS goal_budgets (
                    goal_id TEXT PRIMARY KEY,
                    total_tokens INTEGER NOT NULL,
                    spent_tokens INTEGER NOT NULL DEFAULT 0,
                    reserved_tokens INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS goal_start_leases (
                    goal_id TEXT PRIMARY KEY,
                    claimed_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS runs (
                    run_id TEXT PRIMARY KEY,
                    goal_id TEXT NOT NULL,
                    payload TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    run_id TEXT NOT NULL,
                    type TEXT NOT NULL,
                    payload TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id, id);
                CREATE TABLE IF NOT EXISTS evidence (
                    run_id TEXT PRIMARY KEY,
                    payload TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS chat_sessions (
                    session_id TEXT PRIMARY KEY,
                    payload TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS agent_profiles (
                    profile_id TEXT PRIMARY KEY,
                    workspace_id TEXT NOT NULL,
                    payload TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS issues (
                    issue_id TEXT PRIMARY KEY,
                    workspace_id TEXT NOT NULL,
                    status TEXT NOT NULL,
                    assignee_agent_profile_id TEXT,
                    payload TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS workspace_locks (
                    lock_key TEXT PRIMARY KEY,
                    workspace_id TEXT NOT NULL,
                    payload TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS approvals (
                    approval_id TEXT PRIMARY KEY,
                    status TEXT NOT NULL,
                    issue_id TEXT,
                    payload TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS work_products (
                    work_product_id TEXT PRIMARY KEY,
                    issue_id TEXT NOT NULL,
                    company_profile_id TEXT NOT NULL,
                    type TEXT NOT NULL,
                    is_primary INTEGER NOT NULL DEFAULT 0,
                    created_at REAL NOT NULL,
                    payload TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS company_profiles (
                    company_profile_id TEXT PRIMARY KEY,
                    payload TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS workspace_profiles (
                    workspace_id TEXT PRIMARY KEY,
                    company_profile_id TEXT NOT NULL,
                    payload TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS marketplace_orders (
                    order_id TEXT PRIMARY KEY,
                    base_url TEXT NOT NULL,
                    problem_id TEXT NOT NULL,
                    company_profile_id TEXT NOT NULL,
                    status TEXT NOT NULL,
                    issue_id TEXT,
                    run_id TEXT,
                    payload TEXT NOT NULL
                );
                -- One LIVE order per remote slot: two concurrent chats can never
                -- both claim the same (base_url, problem_id) (advisor阻断项 2).
                -- A terminal ``abandoned`` (remote released) / ``claim_failed``
                -- (nothing committed) frees the slot so a fresh claim may re-take
                -- it — hence a PARTIAL unique index excluding those two states,
                -- not a blanket UNIQUE. (Additive CREATE ... IF NOT EXISTS; no
                -- schema-version bump.)
                CREATE UNIQUE INDEX IF NOT EXISTS idx_marketplace_orders_live_slot
                    ON marketplace_orders(base_url, problem_id)
                    WHERE status NOT IN ('abandoned', 'claim_failed');
                CREATE INDEX IF NOT EXISTS idx_marketplace_orders_company
                    ON marketplace_orders(company_profile_id);
                CREATE INDEX IF NOT EXISTS idx_marketplace_orders_status
                    ON marketplace_orders(status);
                CREATE TABLE IF NOT EXISTS cost_events (
                    event_id TEXT PRIMARY KEY,
                    idempotency_key TEXT NOT NULL UNIQUE,
                    run_id TEXT,
                    chat_session_id TEXT,
                    agent_profile_id TEXT,
                    issue_id TEXT,
                    company_profile_id TEXT,
                    occurred_at REAL NOT NULL,
                    payload TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_issues_workspace_status
                    ON issues(workspace_id, status);
                CREATE INDEX IF NOT EXISTS idx_approvals_status
                    ON approvals(status);
                CREATE INDEX IF NOT EXISTS idx_cost_run ON cost_events(run_id);
                CREATE INDEX IF NOT EXISTS idx_cost_chat ON cost_events(chat_session_id);
                CREATE INDEX IF NOT EXISTS idx_cost_agent ON cost_events(agent_profile_id);
                CREATE INDEX IF NOT EXISTS idx_cost_company ON cost_events(company_profile_id);
                CREATE INDEX IF NOT EXISTS idx_cost_occurred ON cost_events(occurred_at);
                -- cost_events is append-only: the telemetry upload cursor
                -- (list_cost_events_after_seq) relies on the SQLite rowid being
                -- strictly monotonic, which a DELETE would break by letting a
                -- later INSERT reuse a freed rowid below a persisted cursor (no
                -- AUTOINCREMENT here). This DB-level guard makes the invariant
                -- unbypassable — any DELETE (direct SQL, ORM, string-built, or a
                -- WHERE-less truncate) aborts. Removing this trigger to allow a
                -- delete REQUIRES redesigning that cursor. (Additive CREATE ...
                -- IF NOT EXISTS; no schema-version bump needed.)
                CREATE TRIGGER IF NOT EXISTS cost_events_append_only
                BEFORE DELETE ON cost_events
                BEGIN
                    SELECT RAISE(ABORT,
                        'cost_events is append-only (telemetry rowid cursor depends on it)');
                END;
                CREATE TABLE IF NOT EXISTS company_secrets (
                    secret_id TEXT PRIMARY KEY,
                    company_profile_id TEXT NOT NULL,
                    name TEXT NOT NULL,
                    archived INTEGER NOT NULL DEFAULT 0,
                    payload TEXT NOT NULL,
                    UNIQUE(company_profile_id, name)
                );
                CREATE TABLE IF NOT EXISTS company_secret_versions (
                    secret_id TEXT NOT NULL,
                    version INTEGER NOT NULL,
                    payload TEXT NOT NULL,
                    PRIMARY KEY(secret_id, version)
                );
                CREATE TABLE IF NOT EXISTS company_secret_bindings (
                    binding_id TEXT PRIMARY KEY,
                    secret_id TEXT NOT NULL,
                    company_profile_id TEXT NOT NULL,
                    target_type TEXT NOT NULL,
                    target_id TEXT NOT NULL,
                    config_path TEXT NOT NULL,
                    payload TEXT NOT NULL,
                    UNIQUE(secret_id, target_type, target_id, config_path)
                );
                CREATE TABLE IF NOT EXISTS secret_access_events (
                    event_id TEXT PRIMARY KEY,
                    secret_id TEXT NOT NULL,
                    action TEXT NOT NULL,
                    occurred_at REAL NOT NULL,
                    payload TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS instance_settings (
                    singleton_key TEXT PRIMARY KEY,
                    payload TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_secret_bindings_target
                    ON company_secret_bindings(target_type, target_id);
                CREATE INDEX IF NOT EXISTS idx_secret_access_secret
                    ON secret_access_events(secret_id, occurred_at);
                CREATE TABLE IF NOT EXISTS company_memberships (
                    membership_id TEXT PRIMARY KEY,
                    company_profile_id TEXT NOT NULL,
                    principal_type TEXT NOT NULL,
                    principal_id TEXT NOT NULL,
                    payload TEXT NOT NULL,
                    UNIQUE(company_profile_id, principal_type, principal_id)
                );
                CREATE INDEX IF NOT EXISTS idx_memberships_company
                    ON company_memberships(company_profile_id);
                CREATE TABLE IF NOT EXISTS instance_user_roles (
                    role_id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    role TEXT NOT NULL,
                    payload TEXT NOT NULL,
                    UNIQUE(user_id, role)
                );
                CREATE TABLE IF NOT EXISTS issue_comments (
                    comment_id TEXT PRIMARY KEY,
                    issue_id TEXT NOT NULL,
                    company_profile_id TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    payload TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_comments_issue
                    ON issue_comments(issue_id, created_at);
                CREATE TABLE IF NOT EXISTS issue_thread_interactions (
                    interaction_id TEXT PRIMARY KEY,
                    issue_id TEXT NOT NULL,
                    company_profile_id TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    status TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    payload TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_interactions_issue_status
                    ON issue_thread_interactions(issue_id, status);
                CREATE INDEX IF NOT EXISTS idx_interactions_company_status
                    ON issue_thread_interactions(company_profile_id, status);
                CREATE TABLE IF NOT EXISTS issue_holds (
                    hold_id TEXT PRIMARY KEY,
                    issue_id TEXT NOT NULL,
                    company_profile_id TEXT NOT NULL,
                    scope TEXT NOT NULL,
                    operation_id TEXT,
                    status TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    payload TEXT NOT NULL
                );
                -- At most ONE active hold per issue: the DB-level guard behind
                -- hold_issue's pre-check, so a concurrent double-hold cannot slip
                -- through. Released rows drop out of the index, freeing re-holds.
                CREATE UNIQUE INDEX IF NOT EXISTS idx_issue_hold_active
                    ON issue_holds(issue_id) WHERE status = 'active';
                CREATE INDEX IF NOT EXISTS idx_issue_holds_issue
                    ON issue_holds(issue_id, created_at);
                CREATE INDEX IF NOT EXISTS idx_issue_holds_operation
                    ON issue_holds(operation_id) WHERE operation_id IS NOT NULL;
                CREATE TABLE IF NOT EXISTS agent_wakeup_requests (
                    wakeup_id TEXT PRIMARY KEY,
                    agent_profile_id TEXT NOT NULL,
                    company_profile_id TEXT NOT NULL,
                    source TEXT NOT NULL,
                    status TEXT NOT NULL,
                    idempotency_key TEXT,
                    requested_at REAL NOT NULL,
                    payload TEXT NOT NULL
                );
                CREATE UNIQUE INDEX IF NOT EXISTS idx_wakeups_idem_queued
                    ON agent_wakeup_requests(idempotency_key)
                    WHERE idempotency_key IS NOT NULL AND status = 'queued';
                CREATE INDEX IF NOT EXISTS idx_wakeups_status
                    ON agent_wakeup_requests(status, requested_at);
                CREATE INDEX IF NOT EXISTS idx_wakeups_agent_status
                    ON agent_wakeup_requests(agent_profile_id, status);
                -- Retry-once ledger for the orphaned-checkout reaper: keyed on the
                -- (issue, dead-wakeup) pair so the SAME orphaned claim is re-driven
                -- AT MOST ONCE no matter how many sweeps observe it. Pure hygiene
                -- metadata (no business semantics, no schema bump) — created
                -- IF NOT EXISTS like the rest, so an existing DB grows it on open.
                CREATE TABLE IF NOT EXISTS reclaimed_checkout_ledger (
                    issue_id TEXT NOT NULL,
                    wakeup_id TEXT NOT NULL,
                    reclaimed_at REAL NOT NULL,
                    PRIMARY KEY(issue_id, wakeup_id)
                );
                CREATE TABLE IF NOT EXISTS agent_runtime_state (
                    agent_profile_id TEXT PRIMARY KEY,
                    payload TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS agent_task_sessions (
                    agent_profile_id TEXT NOT NULL,
                    task_key TEXT NOT NULL,
                    payload TEXT NOT NULL,
                    PRIMARY KEY(agent_profile_id, task_key)
                );
                CREATE TABLE IF NOT EXISTS team_routine_schedules (
                    routine_id TEXT PRIMARY KEY,
                    agent_profile_id TEXT NOT NULL,
                    company_profile_id TEXT NOT NULL,
                    enabled INTEGER NOT NULL,
                    next_run_at REAL NOT NULL,
                    idempotency_key TEXT,
                    payload TEXT NOT NULL
                );
                CREATE UNIQUE INDEX IF NOT EXISTS idx_team_routines_idem
                    ON team_routine_schedules(idempotency_key)
                    WHERE idempotency_key IS NOT NULL;
                CREATE INDEX IF NOT EXISTS idx_team_routines_due
                    ON team_routine_schedules(enabled, next_run_at);
                CREATE TABLE IF NOT EXISTS escalations (
                    request_id TEXT PRIMARY KEY,
                    run_id TEXT,
                    kind TEXT NOT NULL,
                    status TEXT NOT NULL,
                    payload TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_escalations_status ON escalations(status);
                CREATE INDEX IF NOT EXISTS idx_escalations_run ON escalations(run_id);
                -- Append-only spent-grant ledger. Consumption inserts the grant's
                -- request_id here under the IMMEDIATE write lock; the PRIMARY KEY is
                -- the atomic single-use guard. This is the authority for "already
                -- spent": restoring a consumed escalation row to its exact prior
                -- approved state (status=approved, consumed_at=None, old signature)
                -- does NOT remove this ledger row, so the grant stays spent. A
                -- separate structure an attacker must also delete to forge a replay.
                CREATE TABLE IF NOT EXISTS consumed_grants (
                    request_id TEXT PRIMARY KEY,
                    nonce TEXT NOT NULL,
                    consumed_at TEXT NOT NULL
                );
                -- Per-itemKey read state for the Agent-company message center
                -- (docs/agent-company-message-center-design.md §未读). One row per
                -- (user, message itemKey): read_at is when the user last marked it
                -- read. unread = read_at is None OR read_at < event_time. The set is
                -- naturally bounded (actionable messages are a small transient set);
                -- prune (removing rows no longer in the live message set) runs ONLY on
                -- mark-read / explicit maintenance, never on the read path.
                CREATE TABLE IF NOT EXISTS message_read_state (
                    user_id TEXT NOT NULL,
                    item_key TEXT NOT NULL,
                    read_at REAL NOT NULL,
                    PRIMARY KEY (user_id, item_key)
                );
                -- Run-bound authentication tickets for the Agent-company
                -- autonomy MCP channel (docs/agent-company-autonomy-design.md
                -- 柱子 2). The durable store is the SOLE authority for whether a
                -- ticket is valid; the token presented over MCP is verified
                -- against ``token_hash`` here (we NEVER store the plaintext
                -- token). One row per ticket; lookups during verification are by
                -- the unique ``token_hash`` (presented secret is re-hashed).
                -- run_id is indexed so a run's tickets can be revoked when it
                -- ends. expires_at (epoch seconds) lets stale rows be pruned.
                CREATE TABLE IF NOT EXISTS run_tickets (
                    ticket_id TEXT PRIMARY KEY,
                    token_hash TEXT NOT NULL UNIQUE,
                    run_id TEXT NOT NULL,
                    agent_profile_id TEXT NOT NULL,
                    company_id TEXT NOT NULL,
                    expires_at REAL NOT NULL,
                    revoked_at REAL,
                    payload TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_run_tickets_run ON run_tickets(run_id);
                CREATE INDEX IF NOT EXISTS idx_run_tickets_expiry ON run_tickets(expires_at);
                -- Single-use ledger for the run-scoped respond grant
                -- (docs/agent-company-autonomy-design.md 柱子 1b, #2). A respond
                -- run holds a grant to post ONE non-owned comment on a specific
                -- issue. The autonomy gate consumes it here under the IMMEDIATE
                -- write lock the FIRST time that (run_id, issue_id) comments; the
                -- PRIMARY KEY is the atomic single-use guard, so a second comment
                -- in the same run on the same issue cannot consume again and falls
                -- back to the ownership check (refused). One row per spent grant.
                CREATE TABLE IF NOT EXISTS respond_grant_consumed (
                    run_id TEXT NOT NULL,
                    issue_id TEXT NOT NULL,
                    consumed_at REAL NOT NULL,
                    PRIMARY KEY (run_id, issue_id)
                );
                """
            )
            self._migrate_chat_sessions_workspace_column(conn)
            self._migrate_chat_sessions_archived_column(conn)
            self._migrate_goals_lifecycle_columns(conn)
            # Local v1 bootstrap: the local root user is the instance admin.
            # INSERT OR IGNORE keeps this idempotent across re-opens; B 端模式
            # 接认证后由真实用户体系接管。This governance seed is covered by the
            # single assert_writes_allowed("_init") at the top of the method.
            root_role = InstanceUserRole(user_id="local_user")
            conn.execute(
                "INSERT OR IGNORE INTO instance_user_roles(role_id, user_id, role, payload) VALUES(?, ?, ?, ?)",
                (root_role.role_id, root_role.user_id, root_role.role, json.dumps(root_role.to_dict(), ensure_ascii=False)),
            )
            if current_version < self.SCHEMA_VERSION:
                conn.execute(f"PRAGMA user_version = {self.SCHEMA_VERSION}")
            # DB-incarnation stamp for the telemetry upload cursor's reincarnation
            # guard: a uuid that changes only when this DB file is recreated.
            from .db_incarnation import ensure_incarnation

            ensure_incarnation(conn)

    def db_incarnation(self) -> str | None:
        """This state DB's incarnation uuid — changes only when the file is recreated.
        The telemetry cursor compares it to detect a reincarnated/restored DB."""
        from .db_incarnation import read_incarnation

        with self._connect() as conn:
            return read_incarnation(conn)

    def schema_version(self) -> int:
        """The schema version stamped in the database file."""
        with self._connect() as conn:
            return int(conn.execute("PRAGMA user_version").fetchone()[0])

    def default_backup_path(self) -> Path:
        """Return a collision-safe snapshot path anchored next to the state DB."""
        from superclaw.models import _id

        return self.path.parent / "backups" / f"state-{int(time.time())}-{_id('bk')}.db"

    def backup(self, dest: str | Path | None = None) -> Path:
        """Write a consistent SQLite online backup of the state DB."""
        dest_path = Path(dest) if dest is not None else self.default_backup_path()
        dest_path.parent.mkdir(parents=True, exist_ok=True)
        with contextlib.closing(self._connect()) as src, contextlib.closing(
            sqlite3.connect(dest_path)
        ) as dst:
            src.backup(dst)
        return dest_path

    @staticmethod
    def _migrate_chat_sessions_workspace_column(conn: sqlite3.Connection) -> None:
        """Add the indexable ``workspace_id`` column to ``chat_sessions``.

        Workspace membership must be filterable without scanning JSON payloads
        (ADR: docs/workspace-trust-container.md). Existing rows backfill from
        their payload so column and payload never disagree.
        """
        # B4 fail-closed: guard the WHOLE migration (ALTER + backfill UPDATE +
        # CREATE INDEX) at the top, not just the DML, so no construction-time
        # schema write escapes a maintenance freeze. No-op outside a window;
        # allowed under the migrator hatch.
        assert_writes_allowed("_migrate_chat_sessions_workspace_column")
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(chat_sessions)")}
        if "workspace_id" not in columns:
            conn.execute("ALTER TABLE chat_sessions ADD COLUMN workspace_id TEXT")
            for row in conn.execute("SELECT session_id, payload FROM chat_sessions").fetchall():
                try:
                    workspace_id = json.loads(row["payload"]).get("workspace_id")
                except (json.JSONDecodeError, AttributeError):
                    workspace_id = None
                if workspace_id:
                    conn.execute(
                        "UPDATE chat_sessions SET workspace_id = ? WHERE session_id = ?",
                        (workspace_id, row["session_id"]),
                    )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_chat_sessions_workspace ON chat_sessions(workspace_id)"
        )

    @staticmethod
    def _migrate_chat_sessions_archived_column(conn: sqlite3.Connection) -> None:
        """Add the indexable ``archived`` column to ``chat_sessions``.

        The sidebar must list non-archived sessions without scanning JSON
        payloads (roadmap: workspace-sidebar-rework §5 PR-A). Existing rows
        backfill from their payload so column and payload never disagree;
        legacy rows without the flag default to 0 (not archived).
        """
        # B4 fail-closed: guard the WHOLE migration at the top (see the
        # workspace-column migration above for the rationale).
        assert_writes_allowed("_migrate_chat_sessions_archived_column")
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(chat_sessions)")}
        if "archived" not in columns:
            conn.execute("ALTER TABLE chat_sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0")
            for row in conn.execute("SELECT session_id, payload FROM chat_sessions").fetchall():
                try:
                    archived = bool(json.loads(row["payload"]).get("archived", False))
                except (json.JSONDecodeError, AttributeError):
                    archived = False
                if archived:
                    conn.execute(
                        "UPDATE chat_sessions SET archived = 1 WHERE session_id = ?",
                        (row["session_id"],),
                    )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_chat_sessions_archived ON chat_sessions(archived)"
        )

    @staticmethod
    def _migrate_goals_lifecycle_columns(conn: sqlite3.Connection) -> None:
        """Extend the ``goals`` table from an inert GoalSpec blob into a lifecycle
        ledger (Goal Mode / 计划模式, docs/goal-mode-design.md §5).

        Adds an indexable ``status`` column, a ``revision`` optimistic-concurrency
        token, and a ``record_payload`` JSON column holding the full
        :class:`GoalRecord`. The original ``payload`` column is left untouched so
        the historical ``create_goal`` / ``get_goal`` / ``list_goals`` GoalSpec API
        keeps working. Pre-existing rows backfill to ``status='legacy'`` so old
        delivery goals are never mistaken for fresh Goal-Mode drafts and never
        enter the new state machine.
        """
        # B4 fail-closed: guard the WHOLE migration at the top (see the
        # chat-session migrations above for the rationale).
        assert_writes_allowed("_migrate_goals_lifecycle_columns")
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(goals)")}
        if "record_payload" not in columns:
            if "status" not in columns:
                conn.execute("ALTER TABLE goals ADD COLUMN status TEXT")
            if "revision" not in columns:
                conn.execute("ALTER TABLE goals ADD COLUMN revision INTEGER NOT NULL DEFAULT 0")
            conn.execute("ALTER TABLE goals ADD COLUMN record_payload TEXT")
            for row in conn.execute("SELECT goal_id, payload FROM goals").fetchall():
                try:
                    spec = GoalSpec.from_dict(json.loads(row["payload"]))
                except (json.JSONDecodeError, TypeError, KeyError):
                    # A row we cannot parse as a GoalSpec is left with NULL
                    # record_payload; get_goal_record() treats that as legacy too.
                    continue
                record = GoalRecord.new(spec, status=GoalStatus.LEGACY.value)
                conn.execute(
                    "UPDATE goals SET status = ?, revision = ?, record_payload = ? WHERE goal_id = ?",
                    (
                        record.status,
                        record.revision,
                        json.dumps(record.to_dict(), ensure_ascii=False),
                        row["goal_id"],
                    ),
                )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_goals_status ON goals(status)")

    def create_goal(self, goal: GoalSpec) -> GoalSpec:
        # The legacy GoalSpec write path. ``INSERT OR REPLACE`` would DELETE +
        # re-INSERT the row on a goal_id conflict, wiping the lifecycle columns
        # (status / revision / record_payload) back to defaults — physically
        # destroying a goal that was upgraded to a Goal-Mode lifecycle record
        # (docs/goal-mode-design.md §3.1, 铁律). ``ON CONFLICT DO UPDATE`` rewrites
        # ONLY ``payload``, leaving the lifecycle columns intact; a brand-new row
        # still gets the column defaults (NULL status, NULL record_payload) and
        # therefore reads back as ``legacy``.
        assert_writes_allowed("create_goal")
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO goals(goal_id, payload) VALUES(?, ?) "
                "ON CONFLICT(goal_id) DO UPDATE SET payload = excluded.payload",
                (goal.goal_id, json.dumps(goal.to_dict(), ensure_ascii=False)),
            )
        return goal

    def get_goal(self, goal_id: str) -> GoalSpec:
        with self._connect() as conn:
            row = conn.execute("SELECT payload FROM goals WHERE goal_id = ?", (goal_id,)).fetchone()
        if not row:
            raise KeyError(goal_id)
        return GoalSpec.from_dict(json.loads(row["payload"]))

    def list_goals(self) -> list[GoalSpec]:
        with self._connect() as conn:
            rows = conn.execute("SELECT payload FROM goals ORDER BY rowid DESC").fetchall()
        return [GoalSpec.from_dict(json.loads(row["payload"])) for row in rows]

    # ----- Goal Mode lifecycle ledger (docs/goal-mode-design.md §5) -------------
    # These sit ON TOP of the same ``goals`` rows the legacy GoalSpec API uses:
    # ``payload`` stays the GoalSpec blob (so create_goal/get_goal/list_goals keep
    # working), while ``status`` / ``revision`` / ``record_payload`` carry the
    # lifecycle. A GoalRecord is 1:N over RunSession.

    def create_goal_record(self, record: GoalRecord) -> GoalRecord:
        """Persist a NEW goal as a lifecycle ledger row. Fails closed if a goal with
        the same id already exists — unlike the legacy ``create_goal``, a record
        create must never clobber an existing lifecycle row. The status machine is
        also enforced at CREATE, not only at update: a goal may ONLY be created in
        ``draft`` (the single legitimate Goal-Mode entry). ``legacy`` rows are made
        exclusively by the schema migration's raw backfill, never by this method, so
        no public write口 can mint an ``active`` / ``complete`` / arbitrary-status
        goal and bypass the transition guard."""
        if record.status != GoalStatus.DRAFT.value:
            raise ValueError(
                f"a goal must be created in '{GoalStatus.DRAFT.value}' "
                f"(got {record.status!r})"
            )
        if record.revision != 0:
            raise ValueError(f"a new goal must start at revision 0 (got {record.revision})")
        assert_writes_allowed("create_goal_record")
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            exists = conn.execute(
                "SELECT 1 FROM goals WHERE goal_id = ?", (record.goal_id,)
            ).fetchone()
            if exists:
                conn.commit()
                raise ValueError(f"goal {record.goal_id} already exists")
            conn.execute(
                "INSERT INTO goals(goal_id, payload, status, revision, record_payload) "
                "VALUES(?, ?, ?, ?, ?)",
                (
                    record.goal_id,
                    json.dumps(record.spec.to_dict(), ensure_ascii=False),
                    record.status,
                    record.revision,
                    json.dumps(record.to_dict(), ensure_ascii=False),
                ),
            )
            conn.commit()
        return record

    def get_goal_record(self, goal_id: str) -> GoalRecord:
        """Read a goal's lifecycle ledger. A row written before the lifecycle
        migration (NULL ``record_payload``) is returned as a ``legacy`` record
        reconstructed from its GoalSpec blob, so callers always get a GoalRecord."""
        with self._connect() as conn:
            row = conn.execute(
                "SELECT payload, record_payload FROM goals WHERE goal_id = ?", (goal_id,)
            ).fetchone()
        if not row:
            raise KeyError(goal_id)
        if row["record_payload"]:
            return GoalRecord.from_dict(json.loads(row["record_payload"]))
        return self._legacy_goal_record(json.loads(row["payload"]))

    @staticmethod
    def _legacy_goal_record(spec_payload: dict) -> GoalRecord:
        """Reconstruct an inert ``legacy`` GoalRecord from a bare GoalSpec blob
        (a row with NULL ``record_payload``). Timestamps are pinned to 0.0 — NOT
        ``time()`` — so reading the same legacy goal twice yields an identical
        object (a read must be idempotent; the GoalSpec carries no created_at)."""
        return GoalRecord(
            spec=GoalSpec.from_dict(spec_payload),
            status=GoalStatus.LEGACY.value,
            created_at=0.0,
            updated_at=0.0,
        )

    def list_goal_records(
        self, *, statuses: frozenset[str] | set[str] | None = None
    ) -> list[GoalRecord]:
        """List goal lifecycle records, newest first, optionally filtered to a set
        of statuses. Legacy rows (NULL ``record_payload``) surface as ``legacy``."""
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT goal_id, payload, record_payload FROM goals ORDER BY rowid DESC"
            ).fetchall()
        records: list[GoalRecord] = []
        for row in rows:
            try:
                if row["record_payload"]:
                    record = GoalRecord.from_dict(json.loads(row["record_payload"]))
                else:
                    record = self._legacy_goal_record(json.loads(row["payload"]))
            except (json.JSONDecodeError, TypeError, KeyError):
                # A single corrupted row must not 500 the whole listing — skip it.
                continue
            if statuses is None or record.status in statuses:
                records.append(record)
        return records

    def update_goal_record(
        self,
        record: GoalRecord,
        *,
        expected_revision: int,
        expected_plan_hash: str | None = None,
        _completion_gate: bool = False,
        _completion_run_id: str | None = None,
        _designation_gate: bool = False,
    ) -> GoalRecord:
        """Atomic compare-and-set update of a goal's lifecycle ledger (``BEGIN
        IMMEDIATE``).

        EVERY update is a whole-record replacement, so EVERY update MUST bump the
        revision by exactly one: ``record.revision`` must equal
        ``expected_revision + 1``. This is what makes the CAS sound — if a
        same-revision write were allowed, two readers at revision N could both
        write back at N and the second would silently clobber the first
        (lost-update). Requiring a bump means the loser's ``expected_revision`` is
        already stale and it fails closed. Callers therefore re-read + retry on
        ``GoalRevisionConflict`` rather than coalescing writes.

        The write lands only if the stored ``revision`` still equals
        ``expected_revision`` AND ``stored_status -> record.status`` is a legal
        transition. ``complete`` is intentionally NOT writable here: a goal reaches
        ``complete`` only through the completion-gate projection (PR5), never the
        generic ledger update — exposing a no-gate ``complete`` write口 would let a
        caller self-close a goal (铁律: agent cannot self-report completion).

        Raises ``KeyError`` (goal gone), ``GoalRevisionConflict`` (stale revision —
        two-tab / replay race), or ``ValueError`` (bad revision bump, illegal
        transition, or a ``complete`` write). ``record.updated_at`` is stamped here;
        ``payload`` is rewritten from the spec so the legacy GoalSpec API stays in
        sync."""
        if record.status == GoalStatus.COMPLETE.value and not _completion_gate:
            raise ValueError(
                "goal completion must go through the completion gate, not the "
                "generic ledger update (docs/goal-mode-design.md §4.6)"
            )
        if record.revision != expected_revision + 1:
            raise ValueError(
                f"a goal update must bump revision to {expected_revision + 1} "
                f"(got {record.revision}); every whole-record write increments by one"
            )
        assert_writes_allowed("update_goal_record")
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT status, revision, record_payload FROM goals WHERE goal_id = ?",
                (record.goal_id,),
            ).fetchone()
            if not row:
                conn.commit()
                raise KeyError(record.goal_id)
            stored_revision = int(row["revision"] or 0)
            if stored_revision != expected_revision:
                conn.commit()
                raise GoalRevisionConflict(
                    f"goal {record.goal_id} revision is {stored_revision}, "
                    f"expected {expected_revision}"
                )
            stored_record = (
                GoalRecord.from_dict(json.loads(row["record_payload"]))
                if row["record_payload"]
                else None
            )
            if expected_plan_hash is not None:
                # TOCTOU guard checked INSIDE the write lock (not in a caller's
                # earlier read): a confirmation must be bound to the exact plan it
                # was shown. A stale tab / replay carrying an old plan_hash after a
                # replan fails closed here, atomically with the revision CAS.
                stored_plan_hash = stored_record.plan_hash if stored_record else None
                if stored_plan_hash != expected_plan_hash:
                    conn.commit()
                    raise ValueError(
                        f"plan hash mismatch for goal {record.goal_id}: the plan "
                        "changed since it was shown; re-inspect and confirm again"
                    )
            # ``last_run_id`` is the completion gate's trust root, so it is itself a
            # GATED field: a generic update may not change it (else a caller could
            # persist a fake designated run via a plain active->active write and then
            # pass the completion gate). Only the designation gate (which validates the
            # run belongs to the goal) may set it; the completion gate keeps it
            # unchanged. A no-op (value equal) is always fine.
            stored_run_id = stored_record.last_run_id if stored_record else None
            if record.last_run_id != stored_run_id and not _designation_gate:
                # Only the designation gate may change the trust root — NOT a generic
                # update and NOT the completion write (which keeps it unchanged). So a
                # single write cannot set a fake designation and complete together.
                conn.rollback()
                raise ValueError(
                    "last_run_id is gate-controlled; use designate_goal_run, not a generic update"
                )
            if row["status"]:
                stored_status = row["status"]
            elif row["record_payload"]:
                stored_status = GoalStatus.DRAFT.value
            else:
                stored_status = GoalStatus.LEGACY.value
            if not is_valid_goal_status_transition(stored_status, record.status):
                conn.commit()
                raise ValueError(
                    f"illegal goal status transition {stored_status} -> "
                    f"{record.status} for {record.goal_id}"
                )
            if _designation_gate:
                # Designation must point at a real run of THIS goal (validated in-lock
                # against the runs table); it may not change status. A bad designation
                # rolls back so the trust root can never be set to a foreign run.
                if record.status != stored_status:
                    conn.rollback()
                    raise ValueError("designation gate: must not change status")
                err = self._designation_failure(conn, record.goal_id, record.last_run_id)
                if err is not None:
                    conn.rollback()
                    raise ValueError(f"designation gate: {err}")
            if _completion_gate and record.status == GoalStatus.COMPLETE.value:
                # Authoritative completion gate — validated INSIDE this write lock
                # against DURABLE state (the goal's STORED last_run_id, the run row, and
                # the evidence row), NOT values the caller supplies in ``record``. So a
                # caller cannot forge "designated + complete" in one write, and there is
                # no TOCTOU between the checks and the CAS write. All failures roll back.
                err = self._completion_gate_failure(conn, record.goal_id, stored_run_id, _completion_run_id)
                if err is not None:
                    conn.rollback()
                    raise ValueError(f"completion gate: {err}")
            record.updated_at = time.time()
            cursor = conn.execute(
                "UPDATE goals SET payload = ?, status = ?, revision = ?, record_payload = ? "
                "WHERE goal_id = ? AND revision = ?",
                (
                    json.dumps(record.spec.to_dict(), ensure_ascii=False),
                    record.status,
                    record.revision,
                    json.dumps(record.to_dict(), ensure_ascii=False),
                    record.goal_id,
                    expected_revision,
                ),
            )
            if cursor.rowcount != 1:
                # Defensive: under BEGIN IMMEDIATE the guarded read above already
                # holds the write lock, so this should be unreachable — but a CAS
                # write口 must fail closed rather than silently no-op.
                conn.rollback()
                raise GoalRevisionConflict(
                    f"goal {record.goal_id} CAS write matched no row at "
                    f"revision {expected_revision}"
                )
            conn.commit()
        return record

    @staticmethod
    def _designation_failure(conn: sqlite3.Connection, goal_id: str, run_id: str | None) -> str | None:
        """Validate (in-lock) that ``run_id`` is a real run belonging to ``goal_id`` —
        so the completion gate's trust root can only ever be set to one of the goal's
        own runs. Returns a failure reason, or None if the designation is allowed."""
        if not run_id:
            return "requires a run_id"
        run_row = conn.execute("SELECT payload FROM runs WHERE run_id = ?", (run_id,)).fetchone()
        if not run_row:
            return f"run {run_id} not found"
        if RunSession.from_dict(json.loads(run_row["payload"])).goal_id != goal_id:
            return "run does not belong to this goal"
        return None

    def designate_goal_run(self, record: GoalRecord, *, expected_revision: int, run_id: str) -> GoalRecord:
        """Set a goal's designated run (``last_run_id``) — the GATED write口 for the
        completion gate's trust root. Validates in-lock that ``run_id`` is a real run of
        this goal and forbids a status change, so no generic update can forge the
        designation. Called by ``goal_mode.reconcile_goal_status`` with the run that
        ``start_confirmed_goal_run`` created."""
        assert_writes_allowed("designate_goal_run")
        record.last_run_id = run_id
        return self.update_goal_record(
            record, expected_revision=expected_revision, _designation_gate=True
        )

    @staticmethod
    def _completion_gate_failure(
        conn: sqlite3.Connection, goal_id: str, stored_run_id: str | None, run_id: str | None
    ) -> str | None:
        """Validate a completion against DURABLE state on the SAME connection/transaction
        as the goal CAS (no TOCTOU). Returns a failure reason, or None if the
        completion is authorised. ``run_id`` must equal the goal's STORED designated run
        (``stored_run_id``), and that run must be a ``COMPLETED`` run for this goal whose
        evidence verdict is not ``FAIL`` (fail-closed on missing run/evidence)."""
        if not run_id:
            return "requires the run_id of the completed run"
        if run_id != stored_run_id:
            return "run is not the goal's designated run"
        run_row = conn.execute("SELECT payload FROM runs WHERE run_id = ?", (run_id,)).fetchone()
        if not run_row:
            return f"run {run_id} not found"
        run = RunSession.from_dict(json.loads(run_row["payload"]))
        if run.goal_id != goal_id:
            return "run does not belong to this goal"
        if run.status != RunStatus.COMPLETED.value:
            return "run is not in a completed status"
        ev_row = conn.execute("SELECT payload FROM evidence WHERE run_id = ?", (run_id,)).fetchone()
        if not ev_row:
            return "completing run has no evidence"
        verdict = EvidenceBundle.from_dict(json.loads(ev_row["payload"])).chain_verdict
        if verdict == ChainVerdict.FAIL:
            return "completing run's verification verdict is FAIL"
        return None

    def complete_goal_record(
        self, record: GoalRecord, *, expected_revision: int, run_id: str | None
    ) -> GoalRecord:
        """The completion GATE: the ONLY path that writes ``status = complete``. Thin
        forwarder to ``update_goal_record`` with ``_completion_gate=True``; the actual
        authorisation (``run_id`` is the goal's DURABLE designated run, that run is a
        ``COMPLETED`` run for this goal, and its evidence verdict is not ``FAIL``) is
        enforced INSIDE the same ``BEGIN IMMEDIATE`` write lock as the CAS, against
        stored state rather than caller-supplied fields — so no caller holding the
        ``StateStore`` can forge a completion, and there is no check→write TOCTOU."""
        if record.status != GoalStatus.COMPLETE.value:
            raise ValueError("complete_goal_record only writes the 'complete' status")
        return self.update_goal_record(
            record,
            expected_revision=expected_revision,
            _completion_gate=True,
            _completion_run_id=run_id,
        )

    # --- Goal Mode (PR7) concurrent-fan-out budget reservation ----------------
    # A goal that runs a concurrent fan-out topology can otherwise overspend: N
    # workers run at once with no per-worker checkout to serialize them, so a
    # read-only budget preflight (the company/issue model) would let every worker
    # pass against the same accumulated spend. These primitives are an ATOMIC
    # reservation ledger: a worker is admitted only if the goal still has headroom,
    # and the reserve is a single atomic UPDATE so two concurrent admissions cannot
    # both pass. ``remaining = total - spent - reserved``.

    def set_goal_budget(self, goal_id: str, total_tokens: int) -> None:
        """Initialise (idempotent) a goal's token budget. Re-setting updates the total
        but never lowers it below what is already spent+reserved (fail-closed: a budget
        cannot be shrunk under committed usage)."""
        assert_writes_allowed("set_goal_budget")
        total = max(0, int(total_tokens))
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT spent_tokens, reserved_tokens FROM goal_budgets WHERE goal_id = ?",
                (goal_id,),
            ).fetchone()
            floor = (int(row["spent_tokens"]) + int(row["reserved_tokens"])) if row else 0
            conn.execute(
                "INSERT INTO goal_budgets(goal_id, total_tokens, spent_tokens, reserved_tokens) "
                "VALUES(?, ?, 0, 0) ON CONFLICT(goal_id) DO UPDATE SET total_tokens = ?",
                (goal_id, max(total, floor), max(total, floor)),
            )
            conn.commit()

    def reserve_goal_budget(self, goal_id: str, amount: int) -> bool:
        """ATOMICALLY reserve ``amount`` tokens for an in-flight worker iff the goal has
        the headroom (``spent + reserved + amount <= total``). Returns True if reserved
        (admit the worker), False if not (deny — the fan-out must not dispatch it). A
        non-positive amount, or a goal with no budget configured, is always admitted
        (budget reservation is opt-in; an unbudgeted goal is not gated here)."""
        assert_writes_allowed("reserve_goal_budget")
        amount = int(amount)
        if amount <= 0:
            return True
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("SELECT 1 FROM goal_budgets WHERE goal_id = ?", (goal_id,)).fetchone()
            if not row:
                conn.commit()
                return True  # no budget configured → not gated
            cur = conn.execute(
                "UPDATE goal_budgets SET reserved_tokens = reserved_tokens + ? "
                "WHERE goal_id = ? AND spent_tokens + reserved_tokens + ? <= total_tokens",
                (amount, goal_id, amount),
            )
            ok = cur.rowcount == 1
            conn.commit()
            return ok

    def settle_goal_reservation(self, goal_id: str, reserved_amount: int, actual_spent: int) -> None:
        """Release a worker's reservation and book its ACTUAL spend (atomic):
        ``reserved -= reserved_amount`` (clamped >= 0), ``spent += actual_spent``. Call
        exactly once per successful ``reserve_goal_budget``. If actual < reserved the
        freed headroom returns to the pool; if a worker overspent its slice the honest
        higher spend simply admits fewer future workers (bounded overshoot)."""
        assert_writes_allowed("settle_goal_reservation")
        reserved_amount = max(0, int(reserved_amount))
        actual_spent = max(0, int(actual_spent))
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute(
                "UPDATE goal_budgets SET reserved_tokens = MAX(0, reserved_tokens - ?), "
                "spent_tokens = spent_tokens + ? WHERE goal_id = ?",
                (reserved_amount, actual_spent, goal_id),
            )
            conn.commit()

    def claim_goal_start_lease(self, goal_id: str, *, stale_after_seconds: float = 120.0) -> bool:
        """Atomic daemon-safe single-flight for STARTING a goal run. Returns True if this
        caller claimed the right to start, False if a fresh lease is held by another
        starter. This closes the short ``claim -> run-row-creation`` window two
        concurrent starts (e.g. overlapping autonomous-continuation ticks) could both
        pass before a live run exists. A lease older than ``stale_after`` is reclaimed
        (crash recovery), and the caller's own no-live-run check covers the run's full
        duration — so a long run is never double-started even if its lease goes stale."""
        assert_writes_allowed("claim_goal_start_lease")
        now = time.time()
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT claimed_at FROM goal_start_leases WHERE goal_id = ?", (goal_id,)
            ).fetchone()
            if row is not None and (now - float(row["claimed_at"])) < stale_after_seconds:
                conn.commit()
                return False  # a fresh lease is held by another starter
            conn.execute(
                "INSERT OR REPLACE INTO goal_start_leases(goal_id, claimed_at) VALUES(?, ?)",
                (goal_id, now),
            )
            conn.commit()
            return True

    def release_goal_start_lease(self, goal_id: str) -> None:
        """Release a goal-start lease (idempotent)."""
        assert_writes_allowed("release_goal_start_lease")
        with self._connect() as conn:
            conn.execute("DELETE FROM goal_start_leases WHERE goal_id = ?", (goal_id,))

    def goal_budget_snapshot(self, goal_id: str) -> dict[str, int] | None:
        """The goal's budget ledger, or None if it has no budget configured."""
        with self._connect() as conn:
            row = conn.execute(
                "SELECT total_tokens, spent_tokens, reserved_tokens FROM goal_budgets WHERE goal_id = ?",
                (goal_id,),
            ).fetchone()
        if not row:
            return None
        total, spent, reserved = int(row["total_tokens"]), int(row["spent_tokens"]), int(row["reserved_tokens"])
        return {
            "total_tokens": total,
            "spent_tokens": spent,
            "reserved_tokens": reserved,
            "remaining_tokens": max(0, total - spent - reserved),
        }

    def create_run(
        self, goal_id: str, *, dry_run: bool = False, execution_context: dict | None = None
    ) -> RunSession:
        # Gate the public run-creation entry directly (not only the save_run it
        # delegates to): create_run persists a brand-new run, so under the
        # maintenance freeze (contract B4) it must fail closed at the entry, and
        # the write-gate coverage test treats every mutation entry as a sink.
        assert_writes_allowed("create_run")
        session = RunSession(goal_id=goal_id, dry_run=dry_run)
        # Stamp attribution keys (wakeup_id / issue_id …) on the VERY FIRST persisted
        # row, not a later save. The orphaned-checkout reaper proves a run exists for a
        # checkout by scanning run execution_context for that wakeup/issue; if the first
        # insert were unstamped, a worker that stalled between this insert and a later
        # stamp save could be mis-reaped as an orphan (a live-setup-stall race).
        if execution_context:
            session.execution_context = dict(execution_context)
        self.save_run(session)
        return session

    def save_run(self, session: RunSession) -> RunSession:
        assert_writes_allowed("save_run")
        with self._connect() as conn:
            existing = conn.execute("SELECT payload FROM runs WHERE run_id = ?", (session.run_id,)).fetchone()
            if existing:
                previous = RunSession.from_dict(json.loads(existing["payload"]))
                if not is_valid_run_status_transition(previous.status, session.status):
                    raise ValueError(f"invalid run status transition: {previous.status} -> {session.status}")
            conn.execute(
                "INSERT OR REPLACE INTO runs(run_id, goal_id, payload) VALUES(?, ?, ?)",
                (session.run_id, session.goal_id, json.dumps(session.to_dict(), ensure_ascii=False)),
            )
        return session

    def mutate_run(self, run_id: str, mutator: Callable[[RunSession], RunSession | None]) -> RunSession:
        """Atomically load, mutate, and save one run row."""
        assert_writes_allowed("mutate_run")
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            session = self._get_run_in_transaction(conn, run_id)
            mutated = mutator(session) or session
            if mutated.run_id != run_id:
                raise ValueError(f"mutated run id mismatch: {mutated.run_id} != {run_id}")
            self._save_run_in_transaction(conn, mutated)
        return mutated

    def acquire_run_mutation_lease(
        self,
        run_id: str,
        *,
        owner: str,
        mode: RunMutationMode | str,
    ) -> RunMutationLease:
        """Acquire the single active mutation lease for a run.

        Phase 1 keeps this as a local SQLite compare-and-set guard: if another
        executor, resumer, or reconciler already owns the run, mutation fails
        before the caller can change state or evidence.
        """
        assert_writes_allowed("acquire_run_mutation_lease")
        owner = _required_single_line(owner, field="owner")
        mutation_mode = mode if isinstance(mode, RunMutationMode) else RunMutationMode(str(mode))
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            session = self._get_run_in_transaction(conn, run_id)
            if session.active_mutation_lease is not None:
                lease = session.active_mutation_lease
                raise ValueError(
                    "run mutation lease already held: "
                    f"run_id={run_id} lease_id={lease.lease_id} owner={lease.owner} mode={lease.mode.value}"
                )
            lease = RunMutationLease(
                resource=f"run:{run_id}",
                owner=owner,
                mode=mutation_mode,
                worker_pid=os.getpid(),
                worker_host=socket.gethostname(),
            )
            session.active_mutation_lease = lease
            self._save_run_in_transaction(conn, session)
        # Lease STATE is committed; record the audit event best-effort OUTSIDE the
        # transaction so an events-table failure can never roll back the lease
        # acquisition (U1-deep / DL8: status commits first, events are best-effort).
        self.add_event(
            run_id,
            "run.lease.acquired",
            {
                "lease_id": lease.lease_id,
                "owner": lease.owner,
                "mode": lease.mode.value,
                "resource": lease.resource,
                "worker_pid": lease.worker_pid,
                "worker_host": lease.worker_host,
            },
        )
        return lease

    def require_run_mutation_lease(
        self,
        run_id: str,
        *,
        lease_id: str,
        owner: str | None = None,
        mode: RunMutationMode | str | None = None,
    ) -> RunMutationLease:
        """Return the active lease or fail closed and record the mismatch."""
        assert_writes_allowed("require_run_mutation_lease")
        expected_owner = _required_single_line(owner, field="owner") if owner is not None else None
        expected_mode = mode if isinstance(mode, RunMutationMode) or mode is None else RunMutationMode(str(mode))
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            session = self._get_run_in_transaction(conn, run_id)
            lease = session.active_mutation_lease
            mismatch_reason = _lease_mismatch_reason(
                lease,
                expected_lease_id=lease_id,
                expected_owner=expected_owner,
                expected_mode=expected_mode,
            )
            current = lease  # snapshot for the audit event written outside the txn
        # The mismatch check is read-only (no state change): record the audit event
        # best-effort OUTSIDE the transaction, then fail closed (U1-deep / DL8).
        if mismatch_reason:
            self.add_event(
                run_id,
                "run.lease.lost",
                {
                    "expected_lease_id": lease_id,
                    "expected_owner": expected_owner,
                    "expected_mode": expected_mode.value if isinstance(expected_mode, RunMutationMode) else None,
                    "current_lease_id": current.lease_id if current else None,
                    "current_owner": current.owner if current else None,
                    "current_mode": current.mode.value if current else None,
                    "reason": mismatch_reason,
                },
            )
            raise ValueError(f"run mutation lease mismatch: {mismatch_reason}")
        if lease is None:  # pragma: no cover - guarded by mismatch_reason
            raise ValueError("run mutation lease mismatch: missing active lease")
        return lease

    def renew_run_mutation_lease(
        self,
        run_id: str,
        *,
        lease_id: str,
        owner: str | None = None,
    ) -> RunMutationLease:
        """Heartbeat the active lease so liveness checks keep trusting it.

        Fails closed (ValueError) when the lease was lost to another writer.
        Intentionally records no event: renewals happen every few dozen seconds
        for the whole life of a run and would drown the audit trail.
        """
        assert_writes_allowed("renew_run_mutation_lease")
        expected_owner = _required_single_line(owner, field="owner") if owner is not None else None
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            session = self._get_run_in_transaction(conn, run_id)
            lease = session.active_mutation_lease
            mismatch_reason = _lease_mismatch_reason(
                lease,
                expected_lease_id=lease_id,
                expected_owner=expected_owner,
                expected_mode=None,
            )
            if mismatch_reason:
                conn.commit()
                raise ValueError(f"run mutation lease mismatch: {mismatch_reason}")
            if lease is None:  # pragma: no cover - guarded by mismatch_reason
                raise ValueError("run mutation lease mismatch: missing active lease")
            lease.last_renewed_at = time.time()
            self._save_run_in_transaction(conn, session)
            return lease

    def release_run_mutation_lease(
        self,
        run_id: str,
        *,
        lease_id: str,
        owner: str | None = None,
    ) -> RunSession:
        assert_writes_allowed("release_run_mutation_lease")
        expected_owner = _required_single_line(owner, field="owner") if owner is not None else None
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            session = self._get_run_in_transaction(conn, run_id)
            lease = session.active_mutation_lease
            mismatch_reason = _lease_mismatch_reason(
                lease,
                expected_lease_id=lease_id,
                expected_owner=expected_owner,
                expected_mode=None,
            )
            current = lease  # snapshot for the audit event written outside the txn
            released = lease if (mismatch_reason is None and lease is not None) else None
            if released is not None:
                session.active_mutation_lease = None
                self._save_run_in_transaction(conn, session)
        # The state change (lease cleared) is committed; audit events are written
        # best-effort OUTSIDE the transaction so an events-table failure cannot
        # roll back the release (U1-deep / DL8).
        if mismatch_reason:
            self.add_event(
                run_id,
                "run.lease.release_rejected",
                {
                    "expected_lease_id": lease_id,
                    "expected_owner": expected_owner,
                    "current_lease_id": current.lease_id if current else None,
                    "current_owner": current.owner if current else None,
                    "reason": mismatch_reason,
                },
            )
            raise ValueError(f"run mutation lease mismatch: {mismatch_reason}")
        if released is None:  # pragma: no cover - guarded by mismatch_reason
            raise ValueError("run mutation lease mismatch: missing active lease")
        self.add_event(
            run_id,
            "run.lease.released",
            {
                "lease_id": released.lease_id,
                "owner": released.owner,
                "mode": released.mode.value,
                "resource": released.resource,
            },
        )
        return session

    def get_run(self, run_id: str) -> RunSession:
        with self._connect() as conn:
            row = conn.execute("SELECT payload FROM runs WHERE run_id = ?", (run_id,)).fetchone()
        if not row:
            raise KeyError(run_id)
        return RunSession.from_dict(json.loads(row["payload"]))

    def list_runs(self) -> list[RunSession]:
        with self._connect() as conn:
            rows = conn.execute("SELECT payload FROM runs ORDER BY rowid DESC").fetchall()
        return [RunSession.from_dict(json.loads(row["payload"])) for row in rows]

    def add_event(self, run_id: str, event_type: str, payload: dict[str, Any]) -> None:
        """Persist a run event, best-effort (DL8 safe-write).

        An events-table write failure is counted and logged but NEVER raised: a
        run / lease / chat / inline path must not crash because events is
        unwritable (run health is carried by the runs table, decoupled from
        events). The doorbell only rings after a successful commit, so live
        readers never wake for an event a rolled-back transaction did not persist.
        """
        assert_writes_allowed("add_event")
        try:
            with self._connect() as conn:
                self._add_event_in_transaction(conn, run_id, event_type, payload)
        except Exception as exc:  # best-effort: events failure must not break runs
            self._event_write_failures += 1
            print(
                f"[state] event write failed (swallowed): run={run_id} "
                f"type={event_type}: {exc}",
                file=sys.stderr,
            )
            return
        self._notify_event_bus(run_id)

    def list_events(self, run_id: str) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT type, payload FROM events WHERE run_id = ? ORDER BY id ASC",
                (run_id,),
            ).fetchall()
        return [
            {
                "type": row["type"],
                "payload": json.loads(row["payload"]),
            }
            for row in rows
        ]

    def list_events_after(self, run_id: str, after_id: int = 0) -> list[dict[str, Any]]:
        """Return events with ``id > after_id`` in order, including their ids.

        This is the incremental read used by the live SSE path: a subscriber
        tracks the highest id it has emitted and asks only for newer rows, so the
        read cost is an indexed range scan instead of a full-table re-read.
        """
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT id, type, payload FROM events WHERE run_id = ? AND id > ? ORDER BY id ASC",
                (run_id, after_id),
            ).fetchall()
        return [
            {
                "id": row["id"],
                "type": row["type"],
                "payload": json.loads(row["payload"]),
            }
            for row in rows
        ]

    def list_events_snapshot(self, run_id: str) -> list[dict[str, Any]]:
        """Terminal / replay snapshot: structured events only (excludes the
        high-volume ``*.delta`` stream) and ALWAYS carrying the SQLite ``id``
        (DL5/A2/T4).

        A terminal or reconnecting reader rebuilds tool cards from the structured
        terminal events (tool.started/completed, message.completed, reasoning.*,
        approval.*, adapter.diagnostic, run.*), not the raw delta stream, so a long
        run's deltas never flood the response / TUI. The live streaming SSE is the
        only consumer that still reads the full delta stream.
        """
        excluded = ("tool.delta", "reasoning.delta", "message.delta")
        placeholders = ",".join("?" for _ in excluded)
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT id, type, payload FROM events WHERE run_id = ? "
                f"AND type NOT IN ({placeholders}) ORDER BY id ASC",
                (run_id, *excluded),
            ).fetchall()
        return [
            {
                "id": row["id"],
                "type": row["type"],
                "payload": json.loads(row["payload"]),
            }
            for row in rows
        ]

    def _notify_event_bus(self, run_id: str) -> None:
        if self._event_bus is None:
            return
        try:
            self._event_bus.notify(run_id)
        except Exception:  # pragma: no cover - bus is best-effort; SQLite is truth
            pass

    def create_evidence(self, run_id: str) -> EvidenceBundle:
        bundle = EvidenceBundle(run_id=run_id)
        self.save_evidence(bundle)
        return bundle

    def save_evidence(self, bundle: EvidenceBundle) -> EvidenceBundle:
        assert_writes_allowed("save_evidence")
        bundle = bundle.normalize()
        with self._connect() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO evidence(run_id, payload) VALUES(?, ?)",
                (bundle.run_id, json.dumps(bundle.to_dict(), ensure_ascii=False)),
            )
        return bundle

    def get_evidence(self, run_id: str) -> EvidenceBundle:
        with self._connect() as conn:
            row = conn.execute("SELECT payload FROM evidence WHERE run_id = ?", (run_id,)).fetchone()
        if not row:
            raise KeyError(run_id)
        return EvidenceBundle.from_dict(json.loads(row["payload"]))

    def save_chat_session(self, session: ChatSession) -> ChatSession:
        assert_writes_allowed("save_chat_session")
        with self._connect() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO chat_sessions(session_id, payload, workspace_id, archived) VALUES(?, ?, ?, ?)",
                (
                    session.session_id,
                    json.dumps(session.to_dict(), ensure_ascii=False),
                    session.workspace_id,
                    1 if session.archived else 0,
                ),
            )
        return session

    def create_chat_session(
        self,
        title: str,
        *,
        metadata: dict[str, Any] | None = None,
        workspace_id: str | None = None,
    ) -> ChatSession:
        session = ChatSession(title=title, metadata=metadata or {}, workspace_id=workspace_id)
        return self.save_chat_session(session)

    @staticmethod
    def _workspace_execution_dir(workspace: "WorkspaceProfile | None") -> str | None:
        """The directory a workspace executes in (canonical fingerprint first,
        falling back to the trusted checkout path). None for the chat fallback."""
        if workspace is None:
            return None
        canonical = (workspace.repo_identity or {}).get("canonical_path")
        return canonical or workspace.repo_path

    def _safe_get_workspace(self, workspace_id: str | None) -> "WorkspaceProfile | None":
        if not workspace_id:
            return None
        try:
            return self.get_workspace_profile(workspace_id)
        except KeyError:
            return None

    @staticmethod
    def _native_binding_repo_dirs(session: ChatSession) -> set[str]:
        """Distinct execution dirs recorded on the session's native bindings.

        Native bindings stamp the ``repo_path`` they were established under;
        legacy plain-string bindings carry none (excluded — unknown)."""
        sessions = session.metadata.get("native_sessions")
        dirs: set[str] = set()
        if isinstance(sessions, dict):
            for binding in sessions.values():
                if isinstance(binding, dict) and binding.get("repo_path"):
                    dirs.add(str(binding["repo_path"]))
        return dirs

    def _session_moved_off_repo(
        self, session: ChatSession, repo: str | None, expected_workspace_id: Any
    ) -> bool:
        """True iff the session's execution boundary changed since the turn started.

        The turn captured ``(expected_workspace_id, repo)`` at its start. ANY change
        of ``workspace_id`` mid-turn is a boundary change — INCLUDING grouped→
        unassigned (a move to the Inbox) and unassigned→grouped — and fail-closes the
        resume pin, so a deliberate move's handle-prune is never undone by a late
        write-back (workspace-sidebar-rework §4.5). Keying on ``workspace_id`` change
        (not merely "is it unassigned now") is what distinguishes a session that was
        ALREADY unassigned at turn start (legacy/first-turn → pin stands) from one
        MOVED to unassigned mid-turn (→ skip). When ``workspace_id`` is UNCHANGED: an
        unassigned session keeps the turn's repo (legacy/first-turn pin NOT mis-killed);
        a grouped session re-verifies its workspace dir still resolves to ``repo``
        (in-place repo re-identity)."""
        if session.workspace_id != expected_workspace_id:
            return True
        if session.workspace_id is None:
            return False
        return self._workspace_execution_dir(self._safe_get_workspace(session.workspace_id)) != repo

    def _session_prior_execution_dir(self, session: ChatSession) -> str | None:
        """Best-known dir the session currently executes in: its workspace dir if
        grouped, else the single consistent dir its native bindings were
        established under (legacy/unadopted). None when ambiguous/unknown."""
        if session.workspace_id:
            ws = self._safe_get_workspace(session.workspace_id)
            if ws is not None:
                return self._workspace_execution_dir(ws)
        dirs = self._native_binding_repo_dirs(session)
        return next(iter(dirs)) if len(dirs) == 1 else None

    @staticmethod
    def _has_resume_handles(session: ChatSession) -> bool:
        return bool(session.metadata.get("native_sessions") or session.metadata.get("codex_thread_id"))

    def _prune_stale_resume_handles(self, session: ChatSession, new_dir: str | None) -> bool:
        """Drop every runtime resume handle not PROVABLY valid at ``new_dir``
        (fail-closed: a handle whose dir can't be confirmed equal is dropped).

        - native_sessions: per-binding — keep only bindings whose recorded
          ``repo_path == new_dir`` (handles mixed-backend bindings precisely;
          a binding with no recorded repo is unverifiable → dropped).
        - codex_thread_id: carries no repo, so keep it only when the session's
          prior execution dir is known AND equals new_dir; otherwise drop (a
          codex app-server thread would otherwise resume the old repo — §4.5).
        Returns True if anything was pruned.
        """
        pruned = False
        sessions = session.metadata.get("native_sessions")
        if isinstance(sessions, dict) and sessions:
            kept = {
                backend: binding
                for backend, binding in sessions.items()
                if isinstance(binding, dict) and binding.get("repo_path") == new_dir
            }
            if len(kept) != len(sessions):
                pruned = True
                if kept:
                    session.metadata["native_sessions"] = kept
                else:
                    session.metadata.pop("native_sessions", None)
        if session.metadata.get("codex_thread_id"):
            prior = self._session_prior_execution_dir(session)
            if prior is None or prior != new_dir:
                session.metadata.pop("codex_thread_id", None)
                pruned = True
        return pruned

    def chat_move_changes_execution_boundary(self, session_id: str, target_workspace_id: str | None) -> bool:
        """Whether moving ``session_id`` to ``target_workspace_id`` would reset
        runtime state (a pure query, so a surface can warn BEFORE moving —
        roadmap workspace-sidebar-rework §4.5/§5 UI warning)."""
        session = self.get_chat_session(session_id)
        if session.workspace_id == target_workspace_id:
            return False
        new_dir = self._workspace_execution_dir(self._safe_get_workspace(target_workspace_id))
        prior = self._session_prior_execution_dir(session)
        if prior is not None:
            return prior != new_dir
        # Unknown prior boundary: a change iff there are resume handles to reset.
        return self._has_resume_handles(session)

    def set_chat_session_workspace(self, session_id: str, workspace_id: str | None) -> ChatSession:
        """Move a session between workspaces.

        Historical runs/cost events keep the governance ids stamped at
        execution time — moving a session never rewrites them (ADR:
        docs/workspace-trust-container.md).

        Safety (workspace-sidebar-rework §4.5): the move PRUNES every runtime
        resume handle not provably valid at the target's execution dir — both the
        per-backend ``native_sessions`` bindings AND the codex app-server
        ``codex_thread_id`` — so the next turn re-resolves against the new
        boundary instead of resuming an old runtime against the old repo. A pure
        regroup to the same dir, or an adoption to the workspace already matching
        a binding's repo, keeps the matching handles.
        """
        assert_writes_allowed("set_chat_session_workspace")
        # Resolve the target dir BEFORE the write transaction (workspace rows are
        # stable during a move; this read needn't be inside the lock).
        new_dir = self._workspace_execution_dir(self._safe_get_workspace(workspace_id))
        with self._connect() as conn:
            # BEGIN IMMEDIATE so the read→prune→write is atomic vs a concurrent
            # turn write-back (append_assistant_message_and_pin_codex, also atomic)
            # — neither can clobber the other's whole-row save (§4.5 race).
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT payload FROM chat_sessions WHERE session_id = ?", (session_id,)
            ).fetchone()
            if not row:
                conn.commit()
                raise KeyError(session_id)
            session = ChatSession.from_dict(json.loads(row["payload"]))
            if session.workspace_id == workspace_id:
                conn.commit()
                return session  # no-op move
            self._prune_stale_resume_handles(session, new_dir)
            session.workspace_id = workspace_id
            conn.execute(
                "INSERT OR REPLACE INTO chat_sessions(session_id, payload, workspace_id, archived) VALUES(?, ?, ?, ?)",
                (
                    session_id,
                    json.dumps(session.to_dict(), ensure_ascii=False),
                    session.workspace_id,
                    1 if session.archived else 0,
                ),
            )
            conn.commit()
            return session

    def set_chat_session_archived(self, session_id: str, archived: bool) -> ChatSession:
        """Archive/unarchive a session (workspace-sidebar-rework §5 PR-A).

        Archiving hides a session from the default sidebar list; it never
        deletes the session and is fully reversible. Atomic (BEGIN IMMEDIATE) so a
        whole-row save can't clobber / be clobbered by a concurrent move (§4.5).
        """
        assert_writes_allowed("set_chat_session_archived")
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT payload FROM chat_sessions WHERE session_id = ?", (session_id,)
            ).fetchone()
            if not row:
                conn.commit()
                raise KeyError(session_id)
            session = ChatSession.from_dict(json.loads(row["payload"]))
            if session.archived == archived:
                conn.commit()
                return session  # idempotent
            session.archived = archived
            conn.execute(
                "INSERT OR REPLACE INTO chat_sessions(session_id, payload, workspace_id, archived) VALUES(?, ?, ?, ?)",
                (
                    session_id,
                    json.dumps(session.to_dict(), ensure_ascii=False),
                    session.workspace_id,
                    1 if session.archived else 0,
                ),
            )
            conn.commit()
            return session

    def set_chat_session_pinned(self, session_id: str, pinned: bool, *, now: float | None = None) -> ChatSession:
        """Pin/unpin a chat session to the sidebar's top zone (cross-surface).

        Pinning is a NAVIGATION preference only — it never touches the session's
        workspace membership, archived flag, history, or execution boundary, so
        unpinning returns it to its original group untouched. Atomic via the
        shared ``_mutate_chat_session`` helper so it can't clobber / be clobbered
        by a concurrent move or archive. Idempotent: pinning an already-pinned
        session keeps its original ``pinned_at`` (stable order), and unpinning an
        unpinned one is a no-op.
        """
        stamp = time.time() if now is None else float(now)

        def _m(session: ChatSession) -> Any:
            if pinned:
                if session.pinned_at is not None:
                    return False  # already pinned — keep the original order stamp
                session.pinned_at = stamp
            else:
                if session.pinned_at is None:
                    return False  # already unpinned
                session.pinned_at = None

        return self._mutate_chat_session(session_id, _m)

    def get_chat_session(self, session_id: str) -> ChatSession:
        with self._connect() as conn:
            row = conn.execute("SELECT payload FROM chat_sessions WHERE session_id = ?", (session_id,)).fetchone()
        if not row:
            raise KeyError(session_id)
        return ChatSession.from_dict(json.loads(row["payload"]))

    def list_chat_sessions(
        self,
        *,
        workspace_id: str | None = None,
        unassigned_only: bool = False,
        include_archived: bool = False,
    ) -> list[ChatSession]:
        """List sessions, optionally scoped to one workspace.

        ``workspace_id`` filters on the indexed column; ``unassigned_only``
        selects legacy sessions that predate workspace adoption.
        ``include_archived`` defaults to False so the sidebar hides archived
        sessions (workspace-sidebar-rework §4.6/§5 PR-A); pass True to show them.
        """
        if workspace_id is not None and unassigned_only:
            raise ValueError("workspace_id and unassigned_only are mutually exclusive")
        conditions: list[str] = []
        params: list[Any] = []
        if workspace_id is not None:
            conditions.append("workspace_id = ?")
            params.append(workspace_id)
        elif unassigned_only:
            conditions.append("workspace_id IS NULL")
        if not include_archived:
            conditions.append("archived = 0")
        query = "SELECT payload FROM chat_sessions"
        if conditions:
            query += " WHERE " + " AND ".join(conditions)
        query += " ORDER BY rowid DESC"
        with self._connect() as conn:
            rows = conn.execute(query, tuple(params)).fetchall()
        return [ChatSession.from_dict(json.loads(row["payload"])) for row in rows]

    def list_personal_chat_sessions(self, *, include_archived: bool = False) -> list[ChatSession]:
        """Sessions for the PERSONAL chat sidebar: unassigned (legacy) sessions +
        sessions grouped under ``company="local"`` workspaces.

        Sessions in a company workspace are agent executions that belong to the
        Team surface, not the personal chat sidebar — without this scoping they
        would leak into chat grouping via a fallback group on the unknown
        workspace_id (workspace-sidebar-rework §4.2). This is the single kernel
        source for "what the chat sidebar may show"; surfaces never re-derive it.
        """
        local_ids = {
            workspace.workspace_id
            for workspace in self.list_workspace_profiles(company_profile_id="local")
        }
        return [
            session
            for session in self.list_chat_sessions(include_archived=include_archived)
            if session.workspace_id is None or session.workspace_id in local_ids
        ]

    def get_chat_codex_thread_id(self, session_id: str) -> str | None:
        """Return the persisted codex app-server thread id for a chat session, if any."""
        try:
            session = self.get_chat_session(session_id)
        except KeyError:
            return None
        thread_id = session.metadata.get("codex_thread_id")
        return thread_id if isinstance(thread_id, str) and thread_id else None

    def _mutate_chat_session(self, session_id: str, mutate: "Callable[[ChatSession], Any]") -> ChatSession:
        """Atomic read-modify-write of a chat-session row (``BEGIN IMMEDIATE``) so a
        whole-row save can never clobber — or be clobbered by — a concurrent
        ``set_chat_session_workspace`` (move) or another session write
        (workspace-sidebar-rework §4.5). ``mutate(session)`` edits the session in
        place; return ``False`` to skip the write (idempotent no-op). Returns the
        (possibly unchanged) session; raises ``KeyError`` if the session is gone."""
        assert_writes_allowed("_mutate_chat_session")
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT payload FROM chat_sessions WHERE session_id = ?", (session_id,)
            ).fetchone()
            if not row:
                conn.commit()
                raise KeyError(session_id)
            session = ChatSession.from_dict(json.loads(row["payload"]))
            if mutate(session) is False:
                conn.commit()
                return session
            conn.execute(
                "INSERT OR REPLACE INTO chat_sessions(session_id, payload, workspace_id, archived) VALUES(?, ?, ?, ?)",
                (
                    session_id,
                    json.dumps(session.to_dict(), ensure_ascii=False),
                    session.workspace_id,
                    1 if session.archived else 0,
                ),
            )
            conn.commit()
            return session

    def set_chat_codex_thread_id(self, session_id: str, thread_id: str) -> ChatSession:
        """Bind a chat session to its codex thread so it can be resumed across restarts."""
        def _m(session: ChatSession) -> Any:
            if session.metadata.get("codex_thread_id") == thread_id:
                return False  # idempotent: avoid rewriting the row every turn
            session.metadata["codex_thread_id"] = thread_id
        return self._mutate_chat_session(session_id, _m)

    def append_assistant_message_and_pin_codex(
        self,
        session_id: str,
        content: str,
        *,
        run_id: str | None,
        thread_id: str | None,
        repo_path: str | None,
        expected_repo: str | None,
        expected_workspace_id: Any,
        usage: dict[str, int] | None = None,
        elapsed_ms: float | None = None,
    ) -> tuple[ChatSession, bool]:
        """ATOMICALLY append the assistant reply AND — only if the session did NOT
        move off the turn's boundary ``(expected_workspace_id, expected_repo)`` — pin
        the codex resume thread + native binding. Returns ``(session, pinned)``. Uses
        ``_session_moved_off_repo`` (keyed on the turn-start workspace_id + repo, not a
        late read) so an unassigned/first-turn session still pins, a move to a different
        workspace skips, AND a move to the Inbox (grouped→unassigned) also skips.

        Both steps run under ONE ``BEGIN IMMEDIATE`` (write lock held for the whole
        read→modify→write), so the move/turn-write-back race (workspace-sidebar-
        rework §4.5) is fully closed: a concurrent ``set_chat_session_workspace``
        (also atomic) is serialized by SQLite, so it can NEITHER be clobbered by
        this append (the move's row write is never lost) NOR let this turn pin a
        thread for a boundary it already left (the workspace re-read here is fresh,
        post-move). The reply is ALWAYS persisted; only the resume handle is
        conditional."""
        assert_writes_allowed("append_assistant_message_and_pin_codex")
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT payload FROM chat_sessions WHERE session_id = ?", (session_id,)
            ).fetchone()
            if not row:
                conn.commit()
                raise KeyError(session_id)
            session = ChatSession.from_dict(json.loads(row["payload"]))
            session.append(ChatMessage(role="assistant", content=content, run_id=run_id, usage=usage, elapsed_ms=elapsed_ms))
            pinned = bool(thread_id) and not self._session_moved_off_repo(
                session, expected_repo, expected_workspace_id
            )
            if pinned:
                session.metadata["codex_thread_id"] = thread_id
                native = session.metadata.get("native_sessions")
                native = dict(native) if isinstance(native, dict) else {}
                native["codex-app-server"] = {
                    "id": thread_id,
                    "last_seen_message_id": session.messages[-1].message_id,
                    "repo_path": repo_path,
                }
                session.metadata["native_sessions"] = native
            conn.execute(
                "INSERT OR REPLACE INTO chat_sessions(session_id, payload, workspace_id, archived) VALUES(?, ?, ?, ?)",
                (
                    session_id,
                    json.dumps(session.to_dict(), ensure_ascii=False),
                    session.workspace_id,
                    1 if session.archived else 0,
                ),
            )
            conn.commit()
            return session, pinned

    @staticmethod
    def _native_binding_dict(raw: Any) -> dict[str, Any] | None:
        """Normalize a native-session binding; legacy plain-string rows upgrade
        to the dict shape with unknown last-seen/repo (consumers treat that as
        "nothing seen" and run a full context sync)."""
        if isinstance(raw, str) and raw:
            return {"id": raw, "last_seen_message_id": None, "repo_path": None}
        if isinstance(raw, dict) and isinstance(raw.get("id"), str) and raw["id"]:
            return {
                "id": raw["id"],
                "last_seen_message_id": raw.get("last_seen_message_id"),
                "repo_path": raw.get("repo_path"),
            }
        return None

    def get_chat_native_session(self, session_id: str, backend: str) -> dict[str, Any] | None:
        """Return the runtime-NATIVE session binding for a backend.

        Unified chat entry: one SuperClaw chat session maps to one persistent
        native session per runtime (codex thread, claude --session-id, ...) so
        the conversation continues inside the runtime's own memory. The binding
        carries ``id`` plus the cross-runtime sync state: the
        ``last_seen_message_id`` this runtime has seen (catch-up injection on
        resume after a runtime switch) and the ``repo_path`` it was created in
        (a repo change retires the binding — native sessions are per-workspace).
        """
        try:
            session = self.get_chat_session(session_id)
        except KeyError:
            return None
        sessions = session.metadata.get("native_sessions")
        if not isinstance(sessions, dict):
            return None
        return self._native_binding_dict(sessions.get(backend))

    def get_chat_native_session_id(self, session_id: str, backend: str) -> str | None:
        binding = self.get_chat_native_session(session_id, backend)
        return binding["id"] if binding else None

    def set_chat_native_session(
        self,
        session_id: str,
        backend: str,
        native_id: str,
        *,
        last_seen_message_id: str | None = None,
        repo_path: str | None = None,
        expected_repo: str | None = None,
        expected_workspace_id: Any = _MOVE_GUARD_UNSET,
    ) -> ChatSession:
        """Bind (or update) a runtime-native session for this chat (idempotent).

        Written BEFORE the turn executes (a pending bind) so a concurrent turn
        on the same chat reuses the same native session instead of forking a
        second one; ``last_seen_message_id`` advances after each completed turn.

        ``expected_repo`` + ``expected_workspace_id``: fail-closed move guard for the
        turn write-back (§4.5). When ``expected_repo`` is set, the binding is written
        ONLY if the session's boundary is UNCHANGED since the turn started — using
        ``_session_moved_off_repo`` (keyed on the turn-start workspace_id + repo). This
        skips a binding pin when a concurrent move switched workspaces, moved the
        session to the Inbox (grouped→unassigned), or changed the grouped dir, while
        NOT mis-killing a session that was already unassigned/legacy at turn start. A
        caller passing ``expected_repo`` MUST pass ``expected_workspace_id``; omitting
        it fail-closes (skips the pin) rather than guessing the boundary."""
        assert_writes_allowed("set_chat_native_session")
        def _m(session: ChatSession) -> Any:
            if expected_repo is not None:
                if expected_workspace_id is _MOVE_GUARD_UNSET:
                    return False  # repo given without boundary → fail-closed skip
                if self._session_moved_off_repo(session, expected_repo, expected_workspace_id):
                    return False  # boundary changed mid-turn → skip
            sessions = session.metadata.get("native_sessions")
            if not isinstance(sessions, dict):
                sessions = {}
            current = self._native_binding_dict(sessions.get(backend)) or {}
            binding = {
                "id": native_id,
                "last_seen_message_id": last_seen_message_id if last_seen_message_id is not None else (
                    current.get("last_seen_message_id") if current.get("id") == native_id else None
                ),
                "repo_path": repo_path if repo_path is not None else (
                    current.get("repo_path") if current.get("id") == native_id else None
                ),
            }
            if current == binding:
                return False
            sessions[backend] = binding
            session.metadata["native_sessions"] = sessions
        return self._mutate_chat_session(session_id, _m)

    def set_chat_native_session_id(self, session_id: str, backend: str, native_id: str) -> ChatSession:
        """Compatibility shim over set_chat_native_session."""
        return self.set_chat_native_session(session_id, backend, native_id)

    def drop_chat_native_session_id(self, session_id: str, backend: str) -> None:
        """Forget the native session binding (e.g. resume guard HARD_BLOCK)."""
        def _m(session: ChatSession) -> Any:
            sessions = session.metadata.get("native_sessions")
            if not (isinstance(sessions, dict) and backend in sessions):
                return False
            sessions.pop(backend, None)
            session.metadata["native_sessions"] = sessions
        try:
            self._mutate_chat_session(session_id, _m)
        except KeyError:
            return  # absent session → nothing to drop (unchanged behavior)

    def get_chat_capability_surface(self, session_id: str) -> dict[str, Any] | None:
        """Return the capability-surface fingerprint captured for this chat session.

        Used by the resume guard to detect whether the skills / plugin tools /
        permission mode the model was started under have changed since.
        """
        try:
            session = self.get_chat_session(session_id)
        except KeyError:
            return None
        surface = session.metadata.get("capability_surface")
        return surface if isinstance(surface, dict) and surface else None

    def set_chat_capability_surface(
        self, session_id: str, surface: dict[str, Any]
    ) -> ChatSession:
        """Persist the capability surface so a future resume can be graded against it."""
        def _m(session: ChatSession) -> Any:
            combined = surface.get("combined")
            if isinstance(combined, str) and combined:
                existing = session.metadata.get("capability_surface")
                if isinstance(existing, dict) and existing.get("combined") == combined:
                    return False  # idempotent: unchanged surface, skip the row rewrite
            session.metadata["capability_surface"] = dict(surface)
        return self._mutate_chat_session(session_id, _m)

    def get_chat_runtime(self, session_id: str) -> dict[str, Any] | None:
        """Return the sticky runtime ({backend, model?}) a chat session runs on."""
        try:
            session = self.get_chat_session(session_id)
        except KeyError:
            return None
        runtime = session.metadata.get("runtime")
        return runtime if isinstance(runtime, dict) and runtime.get("backend") else None

    def set_chat_runtime(
        self,
        session_id: str,
        *,
        backend: str,
        model: str | None = None,
        effort: str | None = None,
    ) -> ChatSession:
        """Persist the chat's runtime selection so follow-up turns default to it."""
        backend = _required_single_line(backend, field="backend")
        desired: dict[str, Any] = {"backend": backend}
        if isinstance(model, str) and model.strip():
            desired["model"] = model.strip()
        if isinstance(effort, str) and effort.strip():
            desired["effort"] = effort.strip()
        def _m(session: ChatSession) -> Any:
            if session.metadata.get("runtime") == desired:
                return False  # idempotent: avoid rewriting the row every turn
            session.metadata["runtime"] = desired
        return self._mutate_chat_session(session_id, _m)

    def get_chat_active_plugin_id(self, session_id: str) -> str | None:
        """Return the sticky plugin context for a chat session, if one is active."""
        try:
            session = self.get_chat_session(session_id)
        except KeyError:
            return None
        plugin_id = session.metadata.get("active_plugin_id")
        return plugin_id if isinstance(plugin_id, str) and plugin_id else None

    def set_chat_active_plugin_id(self, session_id: str, plugin_id: str) -> ChatSession:
        """Mark a plugin as active so follow-up turns stay in plugin task mode."""
        plugin_id = _required_single_line(plugin_id, field="plugin_id")
        def _m(session: ChatSession) -> Any:
            if session.metadata.get("active_plugin_id") == plugin_id:
                return False
            session.metadata["active_plugin_id"] = plugin_id
        return self._mutate_chat_session(session_id, _m)

    def clear_chat_active_plugin_id(self, session_id: str) -> ChatSession:
        """Clear sticky plugin context after an explicit non-plugin mode switch."""
        def _m(session: ChatSession) -> Any:
            if "active_plugin_id" not in session.metadata:
                return False
            session.metadata.pop("active_plugin_id", None)
        return self._mutate_chat_session(session_id, _m)

    def append_chat_message(
        self,
        session_id: str,
        role: str,
        content: str,
        *,
        run_id: str | None = None,
        context_refs: list[dict[str, Any]] | None = None,
        status: str | None = None,
        usage: dict[str, int] | None = None,
        elapsed_ms: float | None = None,
    ) -> ChatSession:
        assert_writes_allowed("append_chat_message")
        if role not in {"user", "assistant", "system"}:
            raise ValueError(f"invalid chat role: {role}")
        # Atomic read-modify-write (BEGIN IMMEDIATE): a whole-row append must not
        # clobber a concurrent set_chat_session_workspace (move), nor be clobbered
        # by it — both serialize on the SQLite write lock (workspace-sidebar §4.5).
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT payload FROM chat_sessions WHERE session_id = ?", (session_id,)
            ).fetchone()
            if not row:
                conn.commit()
                raise KeyError(session_id)
            session = ChatSession.from_dict(json.loads(row["payload"]))
            session.append(ChatMessage(role=role, content=content, run_id=run_id, context_refs=list(context_refs or []), status=status, usage=usage, elapsed_ms=elapsed_ms))  # type: ignore[arg-type]
            conn.execute(
                "INSERT OR REPLACE INTO chat_sessions(session_id, payload, workspace_id, archived) VALUES(?, ?, ?, ?)",
                (
                    session_id,
                    json.dumps(session.to_dict(), ensure_ascii=False),
                    session.workspace_id,
                    1 if session.archived else 0,
                ),
            )
            conn.commit()
            return session

    def context_usage(self) -> dict[str, Any]:
        with self._connect() as conn:
            counts = {
                "goals": conn.execute("SELECT COUNT(*) AS n FROM goals").fetchone()["n"],
                "runs": conn.execute("SELECT COUNT(*) AS n FROM runs").fetchone()["n"],
                "events": conn.execute("SELECT COUNT(*) AS n FROM events").fetchone()["n"],
                "evidence_bundles": conn.execute("SELECT COUNT(*) AS n FROM evidence").fetchone()["n"],
                "chat_sessions": conn.execute("SELECT COUNT(*) AS n FROM chat_sessions").fetchone()["n"],
            }
            run_rows = conn.execute("SELECT payload FROM runs").fetchall()
            evidence_rows = conn.execute("SELECT payload FROM evidence").fetchall()
            chat_rows = conn.execute("SELECT payload FROM chat_sessions").fetchall()

        run_statuses: dict[str, int] = {}
        for row in run_rows:
            payload = json.loads(row["payload"])
            status = str(payload.get("status") or "unknown")
            run_statuses[status] = run_statuses.get(status, 0) + 1

        artifacts = 0
        transcripts = 0
        worker_results = 0
        findings = 0
        evidence_chars = 0
        for row in evidence_rows:
            raw = row["payload"]
            evidence_chars += len(raw)
            payload = json.loads(raw)
            artifact_items = payload.get("artifacts", [])
            artifacts += len(artifact_items)
            transcripts += len([item for item in artifact_items if item.get("kind") == "worker-transcript"])
            worker_results += len(payload.get("worker_results", []))
            findings += len(payload.get("findings", []))

        chat_messages = 0
        chat_chars = 0
        for row in chat_rows:
            payload = json.loads(row["payload"])
            for message in payload.get("messages", []):
                chat_messages += 1
                chat_chars += len(str(message.get("content") or ""))

        return {
            "counts": counts,
            "run_statuses": run_statuses,
            "evidence": {
                "artifacts": artifacts,
                "worker_transcripts": transcripts,
                "worker_results": worker_results,
                "findings": findings,
                "stored_chars": evidence_chars,
            },
            "chat": {
                "messages": chat_messages,
                "stored_chars": chat_chars,
            },
            "approx_total_stored_chars": evidence_chars + chat_chars,
        }

    # --- Agent Team Kernel: agent profiles --------------------------------

    def _assert_governance_scope(self, *, company_profile_id: str, workspace_id: str | None) -> None:
        """Fail-closed namespace integrity for team entities.

        A non-default company id must reference an existing CompanyProfile,
        and every non-``"local"`` workspace id must reference a registered
        WorkspaceProfile that belongs to the same company. Workspaces are the
        trust container (ADR: docs/workspace-trust-container.md) — the former
        free-form-key allowance would let work attach to a boundary that was
        never trusted, so it is closed. Only the implicit ``"local"``
        namespace remains valid without registration.
        """
        if company_profile_id and company_profile_id != "local":
            try:
                self.get_company_profile(company_profile_id)
            except KeyError:
                raise ValueError(f"unknown company profile: {company_profile_id}") from None
        if workspace_id is not None and workspace_id != "local":
            # "" is not a valid escape hatch — only the implicit "local"
            # namespace may skip registration.
            try:
                workspace = self.get_workspace_profile(workspace_id)
            except KeyError:
                raise ValueError(
                    f"unknown workspace: {workspace_id!r}; register it first "
                    "(`superclaw workspace create` or `superclaw workspace trust <path>`)"
                ) from None
            if workspace.company_profile_id != (company_profile_id or "local"):
                raise ValueError(
                    f"workspace {workspace_id} belongs to company "
                    f"{workspace.company_profile_id}, not {company_profile_id}"
                )

    def save_agent_profile(self, profile: AgentProfile) -> AgentProfile:
        assert_writes_allowed("save_agent_profile")
        self._assert_governance_scope(
            company_profile_id=profile.company_profile_id, workspace_id=profile.workspace_id
        )
        # reports_to governance — enforced at the single save choke point so it
        # holds for EVERY path (CLI + API, create + update), not only the PATCH
        # path. An agent can never report to itself, and IF the manager exists it
        # must be in the SAME company (work never crosses a company boundary). A
        # dangling reference (manager not yet created) stays allowed, matching the
        # existing creation semantics; cycle detection beyond a self-loop lives in
        # team_kernel.update_agent_profile (a fresh agent has no reports, so it
        # cannot close a cycle on create).
        if profile.reports_to:
            if profile.reports_to == profile.profile_id:
                raise ValueError("an agent cannot report to itself")
            try:
                manager = self.get_agent_profile(profile.reports_to)
            except KeyError:
                manager = None  # dangling manager ref is allowed (matches creation)
            if manager is not None and manager.company_profile_id != profile.company_profile_id:
                raise ValueError(
                    f"reports_to {profile.reports_to} belongs to company "
                    f"{manager.company_profile_id}, not {profile.company_profile_id} "
                    "(an agent cannot report across a company boundary)"
                )
        with self._connect() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO agent_profiles(profile_id, workspace_id, payload) VALUES(?, ?, ?)",
                (profile.profile_id, profile.workspace_id, json.dumps(profile.to_dict(), ensure_ascii=False)),
            )
        # An agent employee is a company member like any human principal —
        # one org table for both is the Paperclip principal model.
        self.ensure_company_membership(profile.company_profile_id, "agent", profile.profile_id)
        return profile

    def get_agent_profile(self, profile_id: str) -> AgentProfile:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT payload FROM agent_profiles WHERE profile_id = ?", (profile_id,)
            ).fetchone()
        if not row:
            raise KeyError(profile_id)
        return AgentProfile.from_dict(json.loads(row["payload"]))

    def list_agent_profiles(
        self, *, workspace_id: str | None = None, company_profile_id: str | None = None
    ) -> list[AgentProfile]:
        with self._connect() as conn:
            if workspace_id is None:
                rows = conn.execute("SELECT payload FROM agent_profiles ORDER BY rowid DESC").fetchall()
            else:
                rows = conn.execute(
                    "SELECT payload FROM agent_profiles WHERE workspace_id = ? ORDER BY rowid DESC",
                    (workspace_id,),
                ).fetchall()
        profiles = [AgentProfile.from_dict(json.loads(row["payload"])) for row in rows]
        if company_profile_id is not None:
            # company is carried in the payload, not a column — filter after decode
            profiles = [p for p in profiles if p.company_profile_id == company_profile_id]
        return profiles

    # --- Agent Team Kernel: issues ----------------------------------------

    def save_issue(self, issue: Issue) -> Issue:
        """Persist an issue, fail-closed on illegal status transitions.

        Mirrors ``save_run``: an existing row's status may only move along an
        allowed edge, so the approval gate (``in_review`` -> ``done``) cannot be
        bypassed by a direct write.
        """
        assert_writes_allowed("save_issue")
        self._assert_governance_scope(
            company_profile_id=issue.company_profile_id, workspace_id=issue.workspace_id
        )
        with self._connect() as conn:
            existing = conn.execute(
                "SELECT payload FROM issues WHERE issue_id = ?", (issue.issue_id,)
            ).fetchone()
            if existing:
                previous = Issue.from_dict(json.loads(existing["payload"]))
                if not is_valid_issue_status_transition(previous.status, issue.status):
                    raise ValueError(f"invalid issue status transition: {previous.status} -> {issue.status}")
            # A human-less completion policy (parent_accept / no_completion_gate) is
            # only valid for a real, in-scope delegated child. The typed-field guard
            # only proves parent_id is non-empty, which a caller could satisfy with a
            # bogus id to forge a root that skips the human gate. Re-check on EVERY
            # save (not just creation) so a mutate-then-resave — start as a root
            # human_final issue, then flip review_policy + pin a bogus parent — is
            # caught here too, closing the root-masquerade bypass at this write口.
            if issue.review_policy in _PARENT_SCOPED_REVIEW_POLICIES:
                self._assert_real_parent_in_scope(conn, issue)
            _stamp_status_changed_at(conn, issue)
            conn.execute(
                "INSERT OR REPLACE INTO issues(issue_id, workspace_id, status, assignee_agent_profile_id, payload) "
                "VALUES(?, ?, ?, ?, ?)",
                (
                    issue.issue_id,
                    issue.workspace_id,
                    issue.status,
                    issue.assignee_agent_profile_id,
                    _serialize_issue(issue),
                ),
            )
        return issue

    @staticmethod
    def _assert_real_parent_in_scope(conn: Any, issue: Issue) -> None:
        """Fail-closed: a parent-scoped issue's parent must exist and live in the
        same workspace + company, so a human-less completion policy cannot be
        pinned to a bogus or cross-scope parent to escape the human gate."""
        if not issue.parent_id:
            raise ValueError(
                f"review_policy {issue.review_policy!r} requires a parent issue"
            )
        prow = conn.execute(
            "SELECT payload FROM issues WHERE issue_id = ?", (issue.parent_id,)
        ).fetchone()
        if not prow:
            raise ValueError(
                f"parent issue {issue.parent_id} does not exist; "
                f"a {issue.review_policy!r} issue cannot be pinned to a non-existent parent"
            )
        parent = Issue.from_dict(json.loads(prow["payload"]))
        if parent.workspace_id != issue.workspace_id or parent.company_profile_id != issue.company_profile_id:
            raise ValueError(
                f"parent issue {issue.parent_id} is in a different governance scope; "
                f"a {issue.review_policy!r} child must share its parent's workspace + company"
            )

    def commit_checkout(self, issue: Issue) -> Issue:
        """Write a checkout's in_progress flip ONLY if the issue is not held, in
        ONE transaction. This serializes against a concurrent tree pause's hold
        placement (both are BEGIN IMMEDIATE, so SQLite orders them): a hold can
        never slip in BETWEEN the kernel's pre-check and this commit. Either the
        hold commits first and this refuses (IssueHeldError → caller releases the
        lock), or this commits first and the pause's PASS-2 re-read sees the live
        run and freezes/cancels it. Closes the checkout↔pause TOCTOU."""
        assert_writes_allowed("commit_checkout")
        self._assert_governance_scope(
            company_profile_id=issue.company_profile_id, workspace_id=issue.workspace_id
        )
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            held = conn.execute(
                "SELECT 1 FROM issue_holds WHERE issue_id = ? AND status = 'active' LIMIT 1",
                (issue.issue_id,),
            ).fetchone()
            if held is not None:
                from superclaw.team_kernel import IssueHeldError

                raise IssueHeldError(
                    f"issue {issue.issue_id} is on hold; release the hold before checkout"
                )
            existing = conn.execute(
                "SELECT payload FROM issues WHERE issue_id = ?", (issue.issue_id,)
            ).fetchone()
            if existing:
                previous = Issue.from_dict(json.loads(existing["payload"]))
                if not is_valid_issue_status_transition(previous.status, issue.status):
                    raise ValueError(
                        f"invalid issue status transition: {previous.status} -> {issue.status}"
                    )
            _stamp_status_changed_at(conn, issue)
            conn.execute(
                "INSERT OR REPLACE INTO issues(issue_id, workspace_id, status, assignee_agent_profile_id, payload) "
                "VALUES(?, ?, ?, ?, ?)",
                (
                    issue.issue_id,
                    issue.workspace_id,
                    issue.status,
                    issue.assignee_agent_profile_id,
                    _serialize_issue(issue),
                ),
            )
        return issue

    def save_delegated_child(self, child: Issue, *, parent_id: str) -> Issue:
        """Insert a delegated child ONLY if its parent has no active hold, checked
        in the SAME transaction as the insert. A hold that lands on the parent
        between the caller's pre-check and this write can therefore never leak an
        un-held child past a tree pause (the child would otherwise be daemon-
        claimable). Raises IssueHeldError when the parent is held."""
        assert_writes_allowed("save_delegated_child")
        self._assert_governance_scope(
            company_profile_id=child.company_profile_id, workspace_id=child.workspace_id
        )
        # The child must actually be parented to the named parent (no laundering a
        # foreign / forged parent_id through this primitive), and a parent-scoped
        # child must point at a real, in-scope parent — the same gate save_issue runs.
        if child.parent_id != parent_id:
            raise ValueError(
                f"delegated child parent_id {child.parent_id!r} != {parent_id!r}"
            )
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            if child.review_policy in _PARENT_SCOPED_REVIEW_POLICIES:
                self._assert_real_parent_in_scope(conn, child)
            held = conn.execute(
                "SELECT 1 FROM issue_holds WHERE issue_id = ? AND status = 'active' LIMIT 1",
                (parent_id,),
            ).fetchone()
            if held is not None:
                from superclaw.team_kernel import IssueHeldError

                raise IssueHeldError(
                    f"parent issue {parent_id} is on hold; resume it before delegating new work"
                )
            _stamp_status_changed_at(conn, child)
            conn.execute(
                "INSERT OR REPLACE INTO issues(issue_id, workspace_id, status, assignee_agent_profile_id, payload) "
                "VALUES(?, ?, ?, ?, ?)",
                (
                    child.issue_id,
                    child.workspace_id,
                    child.status,
                    child.assignee_agent_profile_id,
                    _serialize_issue(child),
                ),
            )
        return child

    def get_issue(self, issue_id: str) -> Issue:
        with self._connect() as conn:
            row = conn.execute("SELECT payload FROM issues WHERE issue_id = ?", (issue_id,)).fetchone()
        if not row:
            raise KeyError(issue_id)
        return Issue.from_dict(json.loads(row["payload"]))

    def list_issues(
        self,
        *,
        workspace_id: str | None = None,
        status: str | None = None,
        company_profile_id: str | None = None,
    ) -> list[Issue]:
        clauses: list[str] = []
        params: list[Any] = []
        if workspace_id is not None:
            clauses.append("workspace_id = ?")
            params.append(workspace_id)
        if status is not None:
            clauses.append("status = ?")
            params.append(status)
        where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
        with self._connect() as conn:
            rows = conn.execute(
                f"SELECT payload FROM issues{where} ORDER BY rowid DESC", tuple(params)
            ).fetchall()
        issues = [Issue.from_dict(json.loads(row["payload"])) for row in rows]
        if company_profile_id is not None:
            # company is carried in the payload, not a column — filter after decode
            issues = [i for i in issues if i.company_profile_id == company_profile_id]
        return issues

    # --- Bounded company-snapshot aggregates (roadmap P0) -----------------
    # These compute the dashboard counts in SQLite (GROUP BY / COUNT / LIMIT) so a
    # snapshot never materializes every Issue/AgentProfile object of every company
    # into Python just to count one company (the OOM vector a whole-table fetch +
    # Python filter has). ``company_profile_id`` lives in the JSON payload, not an
    # indexed column, so the scan is unavoidable — but ``json_extract`` keeps it at
    # the SQLite layer and returns only the aggregate rows, never the full payloads.

    def count_company_issues_by_status(self, company_profile_id: str) -> dict[str, int]:
        """``{status: count}`` for one company's issues, aggregated in SQLite."""
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT json_extract(payload, '$.status') AS st, COUNT(*) AS n "
                "FROM issues WHERE json_extract(payload, '$.company_profile_id') = ? "
                "GROUP BY st",
                (company_profile_id,),
            ).fetchall()
        return {row["st"]: int(row["n"]) for row in rows if row["st"] is not None}

    def count_company_stale_open_issues(
        self, company_profile_id: str, *, terminal_statuses: "tuple[str, ...]", stale_before: float
    ) -> int:
        """Count a company's OPEN (non-terminal) issues last updated before
        ``stale_before`` (epoch seconds). Pure SQLite COUNT — no materialization."""
        terminals = list(terminal_statuses)
        placeholders = ",".join("?" for _ in terminals) or "NULL"
        with self._connect() as conn:
            row = conn.execute(
                f"SELECT COUNT(*) AS n FROM issues WHERE "
                f"json_extract(payload, '$.company_profile_id') = ? AND "
                f"json_extract(payload, '$.status') NOT IN ({placeholders}) AND "
                f"CAST(json_extract(payload, '$.updated_at') AS REAL) > 0 AND "
                f"CAST(json_extract(payload, '$.updated_at') AS REAL) < ?",
                (company_profile_id, *terminals, stale_before),
            ).fetchone()
        return int(row["n"])

    def list_company_issues(
        self,
        company_profile_id: str,
        *,
        status: str | None = None,
        assignee_agent_profile_id: str | None = None,
        limit: int,
    ) -> list[Issue]:
        """A company's issues, optionally filtered by status / assignee, SQL-bounded.

        ``status`` and ``assignee_agent_profile_id`` are real indexed COLUMNS; the
        company is a JSON field (``json_extract``). ``LIMIT`` caps the fetch so a
        large company never materializes its whole issue history."""
        clauses = ["json_extract(payload, '$.company_profile_id') = ?"]
        params: list[Any] = [company_profile_id]
        if status is not None:
            clauses.append("status = ?")
            params.append(status)
        if assignee_agent_profile_id is not None:
            clauses.append("assignee_agent_profile_id = ?")
            params.append(assignee_agent_profile_id)
        params.append(int(limit))
        with self._connect() as conn:
            rows = conn.execute(
                f"SELECT payload FROM issues WHERE {' AND '.join(clauses)} "
                f"ORDER BY rowid DESC LIMIT ?",
                tuple(params),
            ).fetchall()
        return [Issue.from_dict(json.loads(row["payload"])) for row in rows]

    def recent_company_issues(self, company_profile_id: str, *, limit: int) -> list[Issue]:
        """The newest ``limit`` issues of one company (SQL LIMIT — bounded fetch)."""
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT payload FROM issues "
                "WHERE json_extract(payload, '$.company_profile_id') = ? "
                "ORDER BY rowid DESC LIMIT ?",
                (company_profile_id, int(limit)),
            ).fetchall()
        return [Issue.from_dict(json.loads(row["payload"])) for row in rows]

    def count_company_agents(self, company_profile_id: str) -> int:
        """Total agent roster size for one company (SQLite COUNT)."""
        with self._connect() as conn:
            row = conn.execute(
                "SELECT COUNT(*) AS n FROM agent_profiles "
                "WHERE json_extract(payload, '$.company_profile_id') = ?",
                (company_profile_id,),
            ).fetchone()
        return int(row["n"])

    def list_company_agents(self, company_profile_id: str, *, limit: int) -> list[AgentProfile]:
        """Up to ``limit`` agents of one company (SQL LIMIT — bounded fetch)."""
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT payload FROM agent_profiles "
                "WHERE json_extract(payload, '$.company_profile_id') = ? "
                "ORDER BY rowid DESC LIMIT ?",
                (company_profile_id, int(limit)),
            ).fetchall()
        return [AgentProfile.from_dict(json.loads(row["payload"])) for row in rows]

    def count_company_pending_approvals(self, company_profile_id: str) -> int:
        """Count PENDING approvals attributed to one company — bounded, in SQLite.

        Replicates ``list_approvals``'s TWO-path company attribution EXACTLY, but as
        a COUNT that never materializes (or per-issue ``get_issue``-N+1's) the
        approval payloads:

          * issue-LINKED (payload ``issue_id`` set): the AUTHORITATIVE scope is the
            issue's own company — counted iff an issue with that id exists AND its
            ``company_profile_id`` matches. An unresolvable issue is NOT counted
            (global inbox only), and a stray ``affects`` is never an override (no
            fallback for issue-linked). Mirrors the ``EXISTS`` of the matching issue.
          * issue-LESS (no ``issue_id``): fall back to the kernel-set
            ``affects.company_profile_id``.

        Uses ``json_extract`` on the payload (not the denormalized ``issue_id``
        column) so it cannot drift from the Python rule, and the issue lookup rides
        the issues PRIMARY KEY index. The ``status='pending'`` filter bounds the scan
        to the (small) open-approval set."""
        with self._connect() as conn:
            row = conn.execute(
                "SELECT COUNT(*) AS n FROM approvals a WHERE a.status = 'pending' AND ("
                "  (json_extract(a.payload, '$.issue_id') IS NOT NULL"
                "   AND json_extract(a.payload, '$.issue_id') != ''"
                "   AND EXISTS (SELECT 1 FROM issues i"
                "       WHERE i.issue_id = json_extract(a.payload, '$.issue_id')"
                "       AND json_extract(i.payload, '$.company_profile_id') = ?))"
                "  OR"
                "  ((json_extract(a.payload, '$.issue_id') IS NULL"
                "    OR json_extract(a.payload, '$.issue_id') = '')"
                "   AND json_extract(a.payload, '$.affects.company_profile_id') = ?)"
                ")",
                (company_profile_id, company_profile_id),
            ).fetchone()
        return int(row["n"])

    # --- Agent Team Kernel: workspace checkout locks ----------------------

    def acquire_workspace_lock(
        self,
        lock_key: str,
        *,
        workspace_id: str,
        holder: str,
        issue_id: str | None = None,
        run_id: str | None = None,
    ) -> WorkspaceLock:
        """Atomically claim a durable workspace lock or fail closed.

        Uses ``BEGIN IMMEDIATE`` so two concurrent checkouts cannot both observe
        the key as free. The losing caller raises rather than silently sharing
        the resource — the same compare-and-set discipline as run leases.
        """
        assert_writes_allowed("acquire_workspace_lock")
        holder = _required_single_line(holder, field="holder")
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            existing = conn.execute(
                "SELECT payload FROM workspace_locks WHERE lock_key = ?", (lock_key,)
            ).fetchone()
            if existing:
                current = WorkspaceLock.from_dict(json.loads(existing["payload"]))
                conn.commit()
                raise ValueError(
                    "workspace already locked: "
                    f"lock_key={lock_key} holder={current.holder} issue_id={current.issue_id}"
                )
            lock = WorkspaceLock(
                lock_key=lock_key,
                workspace_id=workspace_id,
                holder=holder,
                issue_id=issue_id,
                run_id=run_id,
            )
            conn.execute(
                "INSERT INTO workspace_locks(lock_key, workspace_id, payload) VALUES(?, ?, ?)",
                (lock.lock_key, lock.workspace_id, json.dumps(lock.to_dict(), ensure_ascii=False)),
            )
        return lock

    def release_workspace_lock(
        self,
        lock_key: str,
        *,
        holder: str | None = None,
        expected_issue_id: str | None = None,
        expected_run_id: Any = _RUN_ID_UNSET,
    ) -> WorkspaceLock | None:
        """Release a workspace lock. Fail closed if a different holder owns it.

        ``expected_issue_id`` / ``expected_run_id`` make the release conditional
        *inside the same BEGIN IMMEDIATE transaction*: the lock is only deleted if
        it is still held for that issue / by that run. A mismatch returns None
        without touching the lock (it belongs to someone else now) — the atomic
        compare-and-delete form, immune to a read-then-delete race (e.g. a reaper
        freeing a stale claim must never delete a lock a NEWER run just re-acquired).

        ``expected_run_id`` uses a sentinel default, so passing ``expected_run_id=None``
        means "delete only if the held run_id is EXACTLY None" (a real compare for a
        corrupt/empty run_id), NOT "skip the run_id check" — that distinction is what
        keeps a concurrent re-acquire (which writes a real run_id) from being blindly
        deleted when the reaper observed a None run_id.
        """
        assert_writes_allowed("release_workspace_lock")
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            existing = conn.execute(
                "SELECT payload FROM workspace_locks WHERE lock_key = ?", (lock_key,)
            ).fetchone()
            if not existing:
                conn.commit()
                return None
            current = WorkspaceLock.from_dict(json.loads(existing["payload"]))
            if expected_issue_id is not None and current.issue_id != expected_issue_id:
                conn.commit()
                return None
            if expected_run_id is not _RUN_ID_UNSET and current.run_id != expected_run_id:
                conn.commit()
                return None
            if holder is not None and current.holder != holder:
                conn.commit()
                raise ValueError(
                    f"workspace lock holder mismatch: expected {holder}, held by {current.holder}"
                )
            conn.execute("DELETE FROM workspace_locks WHERE lock_key = ?", (lock_key,))
        return current

    def get_workspace_lock(self, lock_key: str) -> WorkspaceLock | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT payload FROM workspace_locks WHERE lock_key = ?", (lock_key,)
            ).fetchone()
        if not row:
            return None
        return WorkspaceLock.from_dict(json.loads(row["payload"]))

    def list_workspace_locks(self, *, workspace_id: str | None = None) -> list[WorkspaceLock]:
        with self._connect() as conn:
            if workspace_id is None:
                rows = conn.execute("SELECT payload FROM workspace_locks ORDER BY rowid DESC").fetchall()
            else:
                rows = conn.execute(
                    "SELECT payload FROM workspace_locks WHERE workspace_id = ? ORDER BY rowid DESC",
                    (workspace_id,),
                ).fetchall()
        return [WorkspaceLock.from_dict(json.loads(row["payload"])) for row in rows]

    # --- Agent Team Kernel: approvals -------------------------------------

    def save_approval(self, approval: Approval) -> Approval:
        """Persist an approval, fail-closed on illegal status transitions."""
        assert_writes_allowed("save_approval")
        with self._connect() as conn:
            existing = conn.execute(
                "SELECT payload FROM approvals WHERE approval_id = ?", (approval.approval_id,)
            ).fetchone()
            if existing:
                previous = Approval.from_dict(json.loads(existing["payload"]))
                if not is_valid_approval_status_transition(previous.status, approval.status):
                    raise ValueError(
                        f"invalid approval status transition: {previous.status} -> {approval.status}"
                    )
            conn.execute(
                "INSERT OR REPLACE INTO approvals(approval_id, status, issue_id, payload) VALUES(?, ?, ?, ?)",
                (
                    approval.approval_id,
                    approval.status,
                    approval.issue_id,
                    json.dumps(approval.to_dict(), ensure_ascii=False),
                ),
            )
        return approval

    def get_approval(self, approval_id: str) -> Approval:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT payload FROM approvals WHERE approval_id = ?", (approval_id,)
            ).fetchone()
        if not row:
            raise KeyError(approval_id)
        return Approval.from_dict(json.loads(row["payload"]))

    def list_approvals(
        self,
        *,
        status: str | None = None,
        company_profile_id: str | None = None,
        workspace_id: str | None = None,
    ) -> list[Approval]:
        with self._connect() as conn:
            if status is None:
                rows = conn.execute("SELECT payload FROM approvals ORDER BY rowid DESC").fetchall()
            else:
                rows = conn.execute(
                    "SELECT payload FROM approvals WHERE status = ? ORDER BY rowid DESC", (status,)
                ).fetchall()
        approvals = [Approval.from_dict(json.loads(row["payload"])) for row in rows]
        if workspace_id is not None:
            approvals = [a for a in approvals if a.workspace_id == workspace_id]
        if company_profile_id is not None:
            # An approval belongs to a company either through its issue OR, for
            # issue-less approvals (e.g. a pending bootstrap that has not created
            # any issue yet), through the kernel-set affects.company_profile_id.
            # Fail-closed: an approval with NEITHER attribution stays in the
            # unscoped (global) inbox only — it never leaks into a company scope.
            scoped: list[Approval] = []
            for approval in approvals:
                if approval.issue_id:
                    # The issue is the AUTHORITATIVE scope when one exists — a stray
                    # or wrong affects.company_profile_id must never re-route an
                    # issue-linked approval into another company. affects is only a
                    # fallback for issue-less approvals (below), never an override.
                    try:
                        issue = self.get_issue(approval.issue_id)
                    except KeyError:
                        continue  # unresolvable issue → global inbox only (fail-closed)
                    if issue.company_profile_id == company_profile_id:
                        scoped.append(approval)
                    continue
                # Issue-less (e.g. a pending bootstrap that has created no issue
                # yet): fall back to the kernel-set affects.company_profile_id.
                if (approval.affects or {}).get("company_profile_id") == company_profile_id:
                    scoped.append(approval)
            approvals = scoped
        return approvals

    # --- Marketplace order ledger (docs/company-marketplace-chat-design.md) ------

    def create_marketplace_order(self, order: MarketplaceOrder) -> MarketplaceOrder:
        """Insert a fresh marketplace order, fail-closed on a double-claim.

        Enforces the one-live-order-per-remote-slot invariant (advisor阻断项 2):
        the partial unique index ``idx_marketplace_orders_live_slot`` rejects a
        second LIVE order for the same ``(base_url, problem_id)``. We translate the
        resulting ``IntegrityError`` into a clear ``ValueError`` naming the slot so
        two concurrent claims can never both create an order — the loser is
        refused, not silently merged. Uses INSERT (never INSERT OR REPLACE) so the
        unique index actually fires.
        """
        assert_writes_allowed("create_marketplace_order")
        with self._connect() as conn:
            try:
                conn.execute(
                    "INSERT INTO marketplace_orders("
                    "order_id, base_url, problem_id, company_profile_id, status, "
                    "issue_id, run_id, payload) VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        order.order_id,
                        order.base_url,
                        order.problem_id,
                        order.company_profile_id,
                        order.status,
                        order.issue_id,
                        order.run_id,
                        json.dumps(order.to_dict(), ensure_ascii=False),
                    ),
                )
            except sqlite3.IntegrityError as exc:
                # Either the order_id PK collided (idempotent retry handled by the
                # caller via get) or — the case we care about — the live-slot
                # partial unique index rejected a concurrent double-claim.
                raise ValueError(
                    f"marketplace order slot already claimed: "
                    f"({order.base_url!r}, problem {order.problem_id!r}) has a live "
                    f"order; refuse to double-claim"
                ) from exc
        return order

    def create_marketplace_claim(
        self, order: MarketplaceOrder, approval: Approval
    ) -> tuple[MarketplaceOrder, Approval, bool]:
        """Atomically reserve a claim order AND its approval in ONE transaction.

        Closes the orphan-order hole (advisor阻断项): the previous two-call sequence
        (create order, then save approval) could crash between the writes and leave
        a ``claim_approval_pending`` order with no approval — permanently holding
        the live slot with nothing to reject. Here both rows commit together or
        neither does.

        Idempotency (advisor阻断项): when ``order.idempotency_key`` is non-empty and a
        LIVE order already holds the same ``(base_url, problem_id)`` with that SAME
        key, this is a safe retry of a request whose response was lost — return the
        EXISTING order + its approval (``created=False``) instead of raising on the
        unique index. A live order with a DIFFERENT key (or no key) is a genuine
        double-claim and is refused (``ValueError``).

        Returns ``(order, approval, created)`` — ``created=False`` on an idempotent
        hit (the returned order/approval are the pre-existing ones).
        """
        assert_writes_allowed("create_marketplace_claim")
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            # Idempotency / double-claim pre-check inside the write lock.
            existing = conn.execute(
                "SELECT payload FROM marketplace_orders "
                "WHERE base_url = ? AND problem_id = ? "
                "AND status NOT IN ('abandoned', 'claim_failed') "
                "ORDER BY rowid DESC LIMIT 1",
                (order.base_url, order.problem_id),
            ).fetchone()
            if existing is not None:
                live = MarketplaceOrder.from_dict(json.loads(existing["payload"]))
                if order.idempotency_key and live.idempotency_key == order.idempotency_key:
                    # Safe retry: hand back the original order + its DURABLE approval.
                    approval_row = (
                        conn.execute(
                            "SELECT payload FROM approvals WHERE approval_id = ?",
                            (live.claim_approval_id,),
                        ).fetchone()
                        if live.claim_approval_id
                        else None
                    )
                    if approval_row is None:
                        # The live order's linked approval row is missing — a
                        # corrupt/inconsistent ledger. Fail-closed: never hand back
                        # the caller's UNSAVED in-memory approval (that would return
                        # an approval_id with no durable row, 404-ing on grant). The
                        # atomic create path makes this unreachable in normal flow.
                        raise RuntimeError(
                            f"marketplace order {live.order_id} references a missing "
                            f"approval {live.claim_approval_id!r} (corrupt ledger)"
                        )
                    recovered_approval = Approval.from_dict(json.loads(approval_row["payload"]))
                    return live, recovered_approval, False
                raise ValueError(
                    f"marketplace order slot already claimed: "
                    f"({order.base_url!r}, problem {order.problem_id!r}) has a live "
                    f"order; refuse to double-claim"
                )
            # Insert approval + order together. The order carries claim_approval_id
            # already (the handler set it before calling), so the two rows are
            # mutually linked the moment they land.
            conn.execute(
                "INSERT OR REPLACE INTO approvals(approval_id, status, issue_id, payload) "
                "VALUES(?, ?, ?, ?)",
                (
                    approval.approval_id,
                    approval.status,
                    approval.issue_id,
                    json.dumps(approval.to_dict(), ensure_ascii=False),
                ),
            )
            try:
                conn.execute(
                    "INSERT INTO marketplace_orders("
                    "order_id, base_url, problem_id, company_profile_id, status, "
                    "issue_id, run_id, payload) VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        order.order_id,
                        order.base_url,
                        order.problem_id,
                        order.company_profile_id,
                        order.status,
                        order.issue_id,
                        order.run_id,
                        json.dumps(order.to_dict(), ensure_ascii=False),
                    ),
                )
            except sqlite3.IntegrityError as exc:
                # A concurrent writer slipped a live order in between our SELECT and
                # INSERT — the partial unique index fires. Abort the whole txn (the
                # approval insert rolls back too), refusing the double-claim.
                raise ValueError(
                    f"marketplace order slot already claimed: "
                    f"({order.base_url!r}, problem {order.problem_id!r}); "
                    f"refuse to double-claim"
                ) from exc
        return order, approval, True

    def get_marketplace_order(self, order_id: str) -> MarketplaceOrder:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT payload FROM marketplace_orders WHERE order_id = ?", (order_id,)
            ).fetchone()
        if not row:
            raise KeyError(order_id)
        return MarketplaceOrder.from_dict(json.loads(row["payload"]))

    def bind_marketplace_delivery_issue(
        self, order_id: str, issue: Issue
    ) -> tuple[MarketplaceOrder, bool]:
        """Atomically create the delivery Issue AND bind it to the order (one txn).

        Closes the advance-race orphan hole (advisor阻断项 1, Codex+AGY): two
        concurrent ``advance`` calls could each create a delivery Issue and bind the
        order to the second, orphaning the first. Here the order CAS (status must
        still be ``claimed_remote``) and the issue INSERT commit together under one
        ``BEGIN IMMEDIATE`` — only the FIRST caller creates an issue; a loser
        observes the order already moved and returns ``(order, False)`` with NO
        issue created (no orphan). Idempotent: a re-drive after binding is a no-op.

        The issue is a NEW row (no status transition to validate). human_final is
        not a parent-scoped policy, so the parent-scope guard does not apply; the
        governance-scope assertion runs before the txn (same as ``save_issue``).
        """
        assert_writes_allowed("bind_marketplace_delivery_issue")
        self._assert_governance_scope(
            company_profile_id=issue.company_profile_id, workspace_id=issue.workspace_id
        )
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT payload FROM marketplace_orders WHERE order_id = ?", (order_id,)
            ).fetchone()
            if not row:
                raise KeyError(order_id)
            order = MarketplaceOrder.from_dict(json.loads(row["payload"]))
            if order.status != MarketplaceOrderStatus.CLAIMED_REMOTE.value:
                # Lost the race / already bound / moved on — no issue created.
                return order, False
            conn.execute(
                "INSERT INTO issues(issue_id, workspace_id, status, "
                "assignee_agent_profile_id, payload) VALUES(?, ?, ?, ?, ?)",
                (
                    issue.issue_id,
                    issue.workspace_id,
                    issue.status,
                    issue.assignee_agent_profile_id,
                    _serialize_issue(issue),
                ),
            )
            now = time.time()
            order.issue_id = issue.issue_id
            order.status = MarketplaceOrderStatus.ISSUE_BOUND.value
            order.updated_at = now
            order.status_changed_at = now
            conn.execute(
                "UPDATE marketplace_orders SET status = ?, issue_id = ?, payload = ? "
                "WHERE order_id = ?",
                (
                    order.status,
                    order.issue_id,
                    json.dumps(order.to_dict(), ensure_ascii=False),
                    order_id,
                ),
            )
        return order, True

    def open_marketplace_order_approval(
        self, order_id: str, approval: Approval, *, arm_submit: bool
    ) -> tuple[MarketplaceOrder, Approval]:
        """Open a marketplace approval on an order under a TRANSACTIONAL one-live-
        approval-per-order constraint (advisor阻断项, Codex).

        A request-time pre-check is not enough: two concurrent ``abandon`` (or a
        ``submit`` + ``abandon``) could both observe "no pending approval" and both
        persist one. Here the scan-for-existing + the approval INSERT (+ the submit
        arm) all run inside ONE ``BEGIN IMMEDIATE`` transaction. SQLite's RESERVED
        write lock serialises writers, so the second caller's scan observes the
        first's committed approval and is refused — making "at most one live
        marketplace approval per order" an atomic invariant, not a racy check.

        ``arm_submit`` additionally advances the order ``ready_to_submit`` (or a
        retriable ``submit_failed`` → ``ready_to_submit``) → ``submit_approval_pending``
        in the SAME transaction (so a submit approval can never orphan an un-armed
        order). Each hop is validated against the saga transition map so the model
        stays the complete fact source (no out-of-band status writes).

        Raises ``KeyError`` (unknown order), ``ValueError`` (an existing pending
        marketplace approval on this order, or — for ``arm_submit`` — the order not
        being submit-armable).
        """
        from superclaw.models import (
            MarketplaceOrderStatus,
            is_valid_marketplace_order_transition,
        )

        assert_writes_allowed("open_marketplace_order_approval")
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            # Atomic one-live-approval-per-order: refuse if any PENDING approval
            # already references this order. order_id lives only on marketplace
            # approvals' resume_action, so this never matches a company approval.
            pending_rows = conn.execute(
                "SELECT payload FROM approvals WHERE status = ?",
                (ApprovalStatus.PENDING.value,),
            ).fetchall()
            for prow in pending_rows:
                existing = Approval.from_dict(json.loads(prow["payload"]))
                if (existing.resume_action or {}).get("order_id") == order_id:
                    raise ValueError(
                        f"order {order_id} already has a pending marketplace approval "
                        f"({existing.approval_id}); resolve it before opening another"
                    )
            row = conn.execute(
                "SELECT payload FROM marketplace_orders WHERE order_id = ?", (order_id,)
            ).fetchone()
            if not row:
                raise KeyError(order_id)
            order = MarketplaceOrder.from_dict(json.loads(row["payload"]))

            if arm_submit:
                armable = {
                    MarketplaceOrderStatus.READY_TO_SUBMIT.value,
                    MarketplaceOrderStatus.SUBMIT_FAILED.value,
                }
                if order.status not in armable:
                    raise ValueError(
                        f"order {order_id} is not submit-armable (status {order.status})"
                    )
                now = time.time()
                # Walk the DECLARED saga edges (submit_failed → ready_to_submit →
                # submit_approval_pending) so the transition map stays authoritative.
                hops = (
                    [
                        MarketplaceOrderStatus.READY_TO_SUBMIT.value,
                        MarketplaceOrderStatus.SUBMIT_APPROVAL_PENDING.value,
                    ]
                    if order.status == MarketplaceOrderStatus.SUBMIT_FAILED.value
                    else [MarketplaceOrderStatus.SUBMIT_APPROVAL_PENDING.value]
                )
                for nxt in hops:
                    if not is_valid_marketplace_order_transition(order.status, nxt):
                        raise ValueError(
                            f"invalid marketplace order transition: {order.status} -> {nxt}"
                        )
                    order.status = nxt
                order.submit_approval_id = approval.approval_id
                order.updated_at = now
                order.status_changed_at = now
                conn.execute(
                    "UPDATE marketplace_orders SET status = ?, payload = ? WHERE order_id = ?",
                    (order.status, json.dumps(order.to_dict(), ensure_ascii=False), order_id),
                )

            conn.execute(
                "INSERT OR REPLACE INTO approvals(approval_id, status, issue_id, payload) "
                "VALUES(?, ?, ?, ?)",
                (
                    approval.approval_id,
                    approval.status,
                    approval.issue_id,
                    json.dumps(approval.to_dict(), ensure_ascii=False),
                ),
            )
        return order, approval

    def get_live_marketplace_order_for_problem(
        self, *, base_url: str, problem_id: str
    ) -> MarketplaceOrder | None:
        """Return the LIVE order holding ``(base_url, problem_id)``, or None.

        "Live" = occupying the remote slot (every status except the slot-freeing
        terminals ``abandoned`` / ``claim_failed``). Used by the claim path to
        detect an existing claim BEFORE attempting the remote commitment, and by
        surfaces to find the order for a problem the user is looking at.
        """
        with self._connect() as conn:
            row = conn.execute(
                "SELECT payload FROM marketplace_orders "
                "WHERE base_url = ? AND problem_id = ? "
                "AND status NOT IN ('abandoned', 'claim_failed') "
                "ORDER BY rowid DESC LIMIT 1",
                (base_url, str(problem_id)),
            ).fetchone()
        if not row:
            return None
        return MarketplaceOrder.from_dict(json.loads(row["payload"]))

    def cas_marketplace_order_status(
        self, order_id: str, *, expected: str, new: str, **field_updates: Any
    ) -> MarketplaceOrder | None:
        """Atomic compare-and-set on an order's status (BEGIN IMMEDIATE).

        Transitions ``expected → new`` IFF the order is currently ``expected``,
        returning the updated order; returns ``None`` if the current status is not
        ``expected`` (a concurrent caller already advanced it). Serialises a saga
        phase so only ONE concurrent ``advance`` performs a side effect that must
        not double-fire (e.g. opening the issue completion approval — advisor阻断项,
        Codex). The (expected → new) edge is still validated against the saga map.
        ``field_updates`` set extra MarketplaceOrder fields atomically.
        """
        assert_writes_allowed("cas_marketplace_order_status")
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT payload FROM marketplace_orders WHERE order_id = ?", (order_id,)
            ).fetchone()
            if not row:
                raise KeyError(order_id)
            order = MarketplaceOrder.from_dict(json.loads(row["payload"]))
            if order.status != expected:
                return None  # lost the race / already advanced
            if not is_valid_marketplace_order_transition(expected, new):
                raise ValueError(
                    f"invalid marketplace order transition: {expected} -> {new}"
                )
            for key, value in field_updates.items():
                setattr(order, key, value)
            now = time.time()
            order.status = new
            order.updated_at = now
            order.status_changed_at = now
            conn.execute(
                "UPDATE marketplace_orders SET base_url = ?, problem_id = ?, "
                "company_profile_id = ?, status = ?, issue_id = ?, run_id = ?, "
                "payload = ? WHERE order_id = ?",
                (
                    order.base_url,
                    order.problem_id,
                    order.company_profile_id,
                    order.status,
                    order.issue_id,
                    order.run_id,
                    json.dumps(order.to_dict(), ensure_ascii=False),
                    order_id,
                ),
            )
        return order

    def list_marketplace_orders(
        self,
        *,
        status: str | None = None,
        company_profile_id: str | None = None,
    ) -> list[MarketplaceOrder]:
        clauses: list[str] = []
        params: list[Any] = []
        if status is not None:
            clauses.append("status = ?")
            params.append(status)
        if company_profile_id is not None:
            clauses.append("company_profile_id = ?")
            params.append(company_profile_id)
        where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
        with self._connect() as conn:
            rows = conn.execute(
                f"SELECT payload FROM marketplace_orders{where} ORDER BY rowid DESC",
                tuple(params),
            ).fetchall()
        return [MarketplaceOrder.from_dict(json.loads(row["payload"])) for row in rows]

    def save_marketplace_order(self, order: MarketplaceOrder) -> MarketplaceOrder:
        """Persist a marketplace order update, fail-closed on an illegal saga edge.

        Mirrors ``save_approval``: an UPDATE to an existing order is rejected unless
        the (previous → new) status transition is in the allowed saga map
        (``is_valid_marketplace_order_transition``), so no caller can teleport an
        order past a phase (e.g. mark it ``submitted`` without ever ``claiming``).
        Atomic (``BEGIN IMMEDIATE``): the read-validate-write runs under a write
        lock so two concurrent advances cannot both pass the transition check.
        Stamps ``updated_at`` and, on a real status change, ``status_changed_at``.

        Raises ``KeyError`` if the order does not exist (a save is an UPDATE of a
        row ``create_marketplace_order`` already inserted — it never creates).
        """
        assert_writes_allowed("save_marketplace_order")
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            existing = conn.execute(
                "SELECT payload FROM marketplace_orders WHERE order_id = ?",
                (order.order_id,),
            ).fetchone()
            if not existing:
                raise KeyError(order.order_id)
            previous = MarketplaceOrder.from_dict(json.loads(existing["payload"]))
            if not is_valid_marketplace_order_transition(previous.status, order.status):
                raise ValueError(
                    f"invalid marketplace order transition: "
                    f"{previous.status} -> {order.status} (order {order.order_id})"
                )
            order.updated_at = time.time()
            if order.status != previous.status:
                order.status_changed_at = order.updated_at
            conn.execute(
                "UPDATE marketplace_orders SET base_url = ?, problem_id = ?, "
                "company_profile_id = ?, status = ?, issue_id = ?, run_id = ?, "
                "payload = ? WHERE order_id = ?",
                (
                    order.base_url,
                    order.problem_id,
                    order.company_profile_id,
                    order.status,
                    order.issue_id,
                    order.run_id,
                    json.dumps(order.to_dict(), ensure_ascii=False),
                    order.order_id,
                ),
            )
        return order

    # --- Message-center read state (docs/agent-company-message-center-design.md) ---

    def get_message_read_state(self, *, user_id: str = "local_user") -> dict[str, float]:
        """Return {itemKey: read_at} for one user. Pure read; never prunes.

        The message center derives ``unread = read_at is None or read_at <
        event_time`` from this map. A read-path call must stay side-effect-free
        (the design forbids prune on the GET path), so this only SELECTs.
        """
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT item_key, read_at FROM message_read_state WHERE user_id = ?",
                (user_id,),
            ).fetchall()
        return {row["item_key"]: float(row["read_at"]) for row in rows}

    def set_message_read_state(
        self,
        item_keys: dict[str, float],
        *,
        user_id: str = "local_user",
    ) -> None:
        """Upsert read_at for the given itemKeys (monotonic: never regress).

        A later mark-read must not move an itemKey's read_at BACKWARDS (an older
        snapshot replayed after a newer one would otherwise un-read freshly-read
        items). The MAX guard keeps read_at monotonically non-decreasing per key,
        all in ONE transaction.
        """
        if not item_keys:
            return
        assert_writes_allowed("set_message_read_state")
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            for item_key, read_at in item_keys.items():
                existing = conn.execute(
                    "SELECT read_at FROM message_read_state WHERE user_id = ? AND item_key = ?",
                    (user_id, item_key),
                ).fetchone()
                if existing is not None and float(existing["read_at"]) >= float(read_at):
                    continue  # never regress a read mark
                conn.execute(
                    "INSERT OR REPLACE INTO message_read_state(user_id, item_key, read_at) "
                    "VALUES(?, ?, ?)",
                    (user_id, item_key, float(read_at)),
                )

    def prune_message_read_state(
        self,
        live_item_keys: set[str],
        *,
        prune_floor: float,
        user_id: str = "local_user",
    ) -> int:
        """Delete read_at rows that are dead as of ``prune_floor``.

        Bounds the table over time (a blocked issue that unblocks, an approval
        that is granted, … drop out of the live set and their read marks are dead
        weight). Runs ONLY from mark-read / explicit maintenance — NEVER the read
        path — so a prune failure can never break message reads. Returns the count
        removed.

        A row is removed only when it is BOTH (a) absent from ``live_item_keys``
        AND (b) its ``read_at < prune_floor`` — where ``prune_floor`` is a
        PRE-READ LOWER BOUND (the caller captures it BEFORE building the live set,
        not the post-read snapshot). Clause (b) closes the cross-call stale-prune
        race (Codex M-1) and its deep variant: any event that occurs at or after
        the caller started looking (e.g. issue unblock→re-block reuses
        ``issue:<id>:blocked``, and a CONCURRENT mark-read writes ``read_at`` ==
        that newer event_time) has ``read_at >= prune_floor``, so this stale prune
        must not delete it. The comparison is STRICT ``<`` (not ``<=``) because
        ``time.time()`` is not monotonic: a same-tick equal value or a clock
        rollback could otherwise let a fresh mark satisfy ``<= floor`` and be
        wrongly reaped. An equal/just-after row simply waits for a later prune
        whose floor has advanced — the table stays bounded, the race stays closed.
        """
        assert_writes_allowed("prune_message_read_state")
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            rows = conn.execute(
                "SELECT item_key, read_at FROM message_read_state WHERE user_id = ?",
                (user_id,),
            ).fetchall()
            stale = [
                row["item_key"]
                for row in rows
                if row["item_key"] not in live_item_keys
                and float(row["read_at"]) < prune_floor
            ]
            for item_key in stale:
                conn.execute(
                    "DELETE FROM message_read_state WHERE user_id = ? AND item_key = ?",
                    (user_id, item_key),
                )
        return len(stale)

    # --- Work products: structured delivery facts attached to an issue -----

    def save_work_product(self, wp: WorkProduct) -> WorkProduct:
        """Persist a delivery fact. At most ONE primary per issue: promoting one
        demotes any other for the same issue in the SAME transaction."""
        assert_writes_allowed("save_work_product")
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            if wp.is_primary:
                conn.execute(
                    "UPDATE work_products SET is_primary = 0 WHERE issue_id = ? AND work_product_id != ?",
                    (wp.issue_id, wp.work_product_id),
                )
                for row in conn.execute(
                    "SELECT work_product_id, payload FROM work_products WHERE issue_id = ? AND is_primary = 0 AND work_product_id != ?",
                    (wp.issue_id, wp.work_product_id),
                ).fetchall():
                    other = WorkProduct.from_dict(json.loads(row["payload"]))
                    if other.is_primary:
                        other.is_primary = False
                        conn.execute(
                            "UPDATE work_products SET payload = ? WHERE work_product_id = ?",
                            (json.dumps(other.to_dict(), ensure_ascii=False), other.work_product_id),
                        )
            conn.execute(
                "INSERT OR REPLACE INTO work_products(work_product_id, issue_id, company_profile_id, type, is_primary, created_at, payload)"
                " VALUES(?, ?, ?, ?, ?, ?, ?)",
                (
                    wp.work_product_id,
                    wp.issue_id,
                    wp.company_profile_id,
                    wp.type,
                    1 if wp.is_primary else 0,
                    wp.created_at,
                    json.dumps(wp.to_dict(), ensure_ascii=False),
                ),
            )
        return wp

    def get_work_product(self, work_product_id: str) -> WorkProduct:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT payload FROM work_products WHERE work_product_id = ?", (work_product_id,)
            ).fetchone()
        if not row:
            raise KeyError(work_product_id)
        return WorkProduct.from_dict(json.loads(row["payload"]))

    def list_work_products(
        self,
        *,
        issue_id: str | None = None,
        company_profile_id: str | None = None,
        limit: int | None = None,
    ) -> list[WorkProduct]:
        clauses: list[str] = []
        params: list[Any] = []
        for col, val in (("issue_id", issue_id), ("company_profile_id", company_profile_id)):
            if val is not None:
                clauses.append(f"{col} = ?")
                params.append(val)
        where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
        # Optional SQL LIMIT so a caller (e.g. the chat read tool) can bound the fetch
        # at the store layer rather than materializing then slicing in Python.
        limit_sql = ""
        if limit is not None:
            limit_sql = " LIMIT ?"
            params.append(int(limit))
        with self._connect() as conn:
            rows = conn.execute(
                f"SELECT payload FROM work_products{where} "
                f"ORDER BY is_primary DESC, created_at ASC{limit_sql}",
                tuple(params),
            ).fetchall()
        return [WorkProduct.from_dict(json.loads(row["payload"])) for row in rows]

    def delete_work_product(self, work_product_id: str) -> bool:
        assert_writes_allowed("delete_work_product")
        with self._connect() as conn:
            cur = conn.execute("DELETE FROM work_products WHERE work_product_id = ?", (work_product_id,))
            return cur.rowcount > 0

    # --- Respond grant: single-use consumption ----------------------------
    # docs/agent-company-autonomy-design.md 柱子 1b, #2. A respond run carries a
    # run-scoped grant to post ONE non-owned comment on a specific issue. The
    # autonomy gate calls this to atomically spend that grant; the PRIMARY KEY on
    # (run_id, issue_id) is the single-use guard.

    def consume_respond_grant(self, run_id: str, issue_id: str) -> bool:
        """Atomically spend the respond grant for ``(run_id, issue_id)`` ONCE.

        Returns ``True`` the FIRST time this exact ``(run_id, issue_id)`` pair is
        consumed (the grant is spent now), ``False`` on every subsequent call
        (already spent) — so a respond run that loops the comment tool can post at
        most ONE non-owned comment; the second call's ``False`` makes the autonomy
        gate fall back to the ownership check (refused).

        The whole check-and-spend runs under ``BEGIN IMMEDIATE`` (write lock held
        for the transaction) with an ``INSERT OR IGNORE``: SQLite serializes two
        concurrent consumers, so exactly one INSERT lands a row (``rowcount == 1``,
        True) and the other is ignored (``rowcount == 0``, False) — no race can
        let both succeed.

        A blank/missing ``run_id`` or ``issue_id`` returns ``False`` WITHOUT
        inserting a row: an unkeyable grant cannot be consumed (and must not
        leave a ``("", "")`` ledger row that would poison a future real consume),
        and the caller falls back to the ownership check (fail-closed).
        """
        assert_writes_allowed("consume_respond_grant")
        if not (isinstance(run_id, str) and run_id) or not (
            isinstance(issue_id, str) and issue_id
        ):
            return False
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            cur = conn.execute(
                "INSERT OR IGNORE INTO respond_grant_consumed(run_id, issue_id, consumed_at)"
                " VALUES(?, ?, ?)",
                (run_id, issue_id, time.time()),
            )
            return cur.rowcount == 1

    # --- Run-bound tickets: durable authority for the autonomy MCP channel --
    # docs/agent-company-autonomy-design.md 柱子 2. The store is the SOLE
    # authority for ticket validity; only the token HASH is persisted (the
    # plaintext token never touches the DB), mirroring broker-token / registry
    # key hashing. company_ticket.py is the verification gate built on top.

    def save_run_ticket(self, ticket: RunTicket) -> RunTicket:
        """Persist a freshly minted run ticket (hash-only; never the plaintext).

        The unique ``token_hash`` column makes a hash collision/duplicate a hard
        DB error rather than a silent overwrite, so two distinct tokens can never
        share a row.
        """
        assert_writes_allowed("save_run_ticket")
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO run_tickets("
                "ticket_id, token_hash, run_id, agent_profile_id, company_id, "
                "expires_at, revoked_at, payload) VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    ticket.ticket_id,
                    ticket.token_hash,
                    ticket.run_id,
                    ticket.agent_profile_id,
                    ticket.company_id,
                    float(ticket.expires_at),
                    ticket.revoked_at,
                    # allow_nan=False: a NaN/inf expiry (lifecycle authority) must
                    # never reach the durable store — it would mint a ticket whose
                    # ``now >= expires_at`` is always False (never expires). Raises
                    # ValueError on a non-finite value rather than persisting it.
                    json.dumps(ticket.to_dict(), ensure_ascii=False, allow_nan=False),
                ),
            )
        return ticket

    def get_run_ticket_by_hash(self, token_hash: str) -> RunTicket | None:
        """Look up a ticket by its stored token hash. Pure read; None if absent."""
        with self._connect() as conn:
            row = conn.execute(
                "SELECT payload FROM run_tickets WHERE token_hash = ?", (token_hash,)
            ).fetchone()
        if not row:
            return None
        return RunTicket.from_dict(json.loads(row["payload"]))

    def revoke_run_ticket(self, ticket_id: str, *, now: datetime | None = None) -> bool:
        """Mark a single ticket revoked (idempotent). Returns True if a row matched.

        Revocation stamps ``revoked_at`` in BOTH the indexed column and the JSON
        payload in one transaction so the two never disagree. A row already
        revoked keeps its original timestamp (we never move it forward)."""
        assert_writes_allowed("revoke_run_ticket")
        revoked_at = (now or datetime.now(UTC)).timestamp()
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT payload, revoked_at FROM run_tickets WHERE ticket_id = ?",
                (ticket_id,),
            ).fetchone()
            if not row:
                return False
            if row["revoked_at"] is not None:
                return True  # already revoked; idempotent no-op
            ticket = RunTicket.from_dict(json.loads(row["payload"]))
            ticket.revoked_at = revoked_at
            conn.execute(
                "UPDATE run_tickets SET revoked_at = ?, payload = ? WHERE ticket_id = ?",
                (revoked_at, json.dumps(ticket.to_dict(), ensure_ascii=False), ticket_id),
            )
        return True

    def revoke_run_tickets_for_run(self, run_id: str, *, now: datetime | None = None) -> int:
        """Revoke every live ticket for a run (called when the run ends).

        Walks the run's not-yet-revoked tickets and stamps each in one
        transaction so a ticket cannot outlive its run. Returns the count revoked.
        """
        assert_writes_allowed("revoke_run_tickets_for_run")
        revoked_at = (now or datetime.now(UTC)).timestamp()
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            rows = conn.execute(
                "SELECT ticket_id, payload FROM run_tickets "
                "WHERE run_id = ? AND revoked_at IS NULL",
                (run_id,),
            ).fetchall()
            for row in rows:
                ticket = RunTicket.from_dict(json.loads(row["payload"]))
                ticket.revoked_at = revoked_at
                conn.execute(
                    "UPDATE run_tickets SET revoked_at = ?, payload = ? WHERE ticket_id = ?",
                    (revoked_at, json.dumps(ticket.to_dict(), ensure_ascii=False), row["ticket_id"]),
                )
        return len(rows)

    def prune_expired_run_tickets(self, *, now: datetime | None = None) -> int:
        """Delete tickets that expired at or before ``now``. Returns the count.

        Bounds the table over time. A ticket is removed only once it is past its
        absolute ``expires_at`` — an expired ticket is already refused by
        verification (fail-closed), so deleting it changes no authorization
        outcome; this is pure garbage collection off the verification path.
        """
        assert_writes_allowed("prune_expired_run_tickets")
        cutoff = (now or datetime.now(UTC)).timestamp()
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            cur = conn.execute(
                "DELETE FROM run_tickets WHERE expires_at <= ?", (cutoff,)
            )
            return cur.rowcount

    # --- Escalations: durable, fail-closed governance escalations ----------
    # Direction 4 (capability-workshop) P0/D1. The durable store is the SOLE
    # authority for whether an action is authorized; a grant is a single-use,
    # signature-bound ticket. See superclaw.escalation and
    # docs/capability-workshop-impl-roadmap.md §8.2.

    def create_escalation(self, envelope: EscalationEnvelope) -> EscalationEnvelope:
        """Persist a freshly minted PENDING escalation, fail-closed.

        ``validate_new_envelope`` refuses anything that is not a well-formed PENDING
        record with a valid binding signature — in particular a hand-forged
        pre-approved ticket (status/decision flipped before insert), which the
        signature alone would not catch since it does not cover mutable fields."""
        assert_writes_allowed("create_escalation")
        validate_new_envelope(envelope)
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO escalations(request_id, run_id, kind, status, payload) VALUES(?, ?, ?, ?, ?)",
                (
                    envelope.request_id,
                    envelope.run_id,
                    envelope.kind,
                    envelope.status,
                    json.dumps(envelope.to_dict(), ensure_ascii=False),
                ),
            )
        return envelope

    def get_escalation(self, request_id: str) -> EscalationEnvelope:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT payload FROM escalations WHERE request_id = ?", (request_id,)
            ).fetchone()
        if not row:
            raise KeyError(request_id)
        return EscalationEnvelope.from_dict(json.loads(row["payload"]))

    def list_escalations(
        self,
        *,
        status: str | None = None,
        run_id: str | None = None,
    ) -> list[EscalationEnvelope]:
        clauses: list[str] = []
        params: list[Any] = []
        if status is not None:
            clauses.append("status = ?")
            params.append(status)
        if run_id is not None:
            clauses.append("run_id = ?")
            params.append(run_id)
        where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
        with self._connect() as conn:
            rows = conn.execute(
                f"SELECT payload FROM escalations{where} ORDER BY rowid DESC", params
            ).fetchall()
        return [EscalationEnvelope.from_dict(json.loads(row["payload"])) for row in rows]

    def find_denied_escalation(
        self,
        *,
        run_id: str | None,
        principal: str | None,
        tool_name: str,
        args_digest: str,
        session_id: str | None = None,
    ) -> EscalationEnvelope | None:
        """Return a human DENIAL for THIS exact action, if one exists. A denial is
        sticky: the gate consults this so a resume does not re-prompt an action the
        human already refused (roadmap fail-closed deny). No expiry check — a deny
        is a decision, not a grant."""
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT payload FROM escalations WHERE status = ? ORDER BY rowid DESC",
                (EscalationStatus.DENIED.value,),
            ).fetchall()
        for row in rows:
            env = EscalationEnvelope.from_dict(json.loads(row["payload"]))
            if (
                env.kind == EscalationKind.PERMISSION.value
                and env.run_id == run_id
                and env.session_id == session_id
                and env.principal == principal
                and env.tool_name == tool_name
                and env.args_digest == args_digest
                and verify_envelope(env)
            ):
                return env
        return None

    def _binding_matches(self, candidate: EscalationEnvelope, envelope: EscalationEnvelope) -> bool:
        return (
            candidate.kind == envelope.kind
            and candidate.run_id == envelope.run_id
            and candidate.session_id == envelope.session_id
            and candidate.principal == envelope.principal
            and candidate.tool_name == envelope.tool_name
            and candidate.args_digest == envelope.args_digest
            and verify_envelope(candidate)
        )

    def create_or_get_pending_escalation(
        self, envelope: EscalationEnvelope, *, now: datetime | None = None
    ) -> EscalationEnvelope:
        """Atomically resolve the escalation decision for an exact action: raise
        EscalationDenied if a human already DENIED it, return an existing open PENDING
        if one is in flight, else insert THIS one. The DENIED check + pending
        find-or-insert run under ONE IMMEDIATE write lock, so a deny that lands
        between "is it denied?" and "open a pending" cannot slip through and
        re-prompt (sticky deny holds even under concurrency)."""
        assert_writes_allowed("create_or_get_pending_escalation")
        validate_new_envelope(envelope)
        now = now or datetime.now(UTC)
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            # Sticky deny first: a prior human DENIAL refuses the action atomically.
            denied_rows = conn.execute(
                "SELECT payload FROM escalations WHERE status = ? ORDER BY rowid DESC",
                (EscalationStatus.DENIED.value,),
            ).fetchall()
            for row in denied_rows:
                denied = EscalationEnvelope.from_dict(json.loads(row["payload"]))
                if self._binding_matches(denied, envelope):
                    raise EscalationDenied(denied)
            rows = conn.execute(
                "SELECT payload FROM escalations WHERE status = ? ORDER BY rowid DESC",
                (EscalationStatus.PENDING.value,),
            ).fetchall()
            for row in rows:
                existing = EscalationEnvelope.from_dict(json.loads(row["payload"]))
                if existing.is_expired(now=now):
                    continue
                if self._binding_matches(existing, envelope):
                    return existing
            conn.execute(
                "INSERT INTO escalations(request_id, run_id, kind, status, payload) VALUES(?, ?, ?, ?, ?)",
                (
                    envelope.request_id,
                    envelope.run_id,
                    envelope.kind,
                    envelope.status,
                    json.dumps(envelope.to_dict(), ensure_ascii=False),
                ),
            )
        return envelope

    def resolve_gate_decision(
        self, envelope: EscalationEnvelope, *, now: datetime | None = None
    ) -> tuple[str, EscalationEnvelope]:
        """Decide a B-class permission gate for an exact action under ONE IMMEDIATE
        write lock, returning ("allow", consumed_grant) or ("pending", envelope), or
        raising EscalationDenied.

        Folding consume(APPROVED) + deny(DENIED) + find-or-open(PENDING) into a single
        transaction removes the races between separate calls — in particular, an
        approval landing between a standalone ``consume_grant`` (which read empty) and
        opening a pending can no longer orphan the grant and re-suspend the run."""
        assert_writes_allowed("resolve_gate_decision")
        validate_new_envelope(envelope)
        now = now or datetime.now(UTC)
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            # 1) An approved grant for THIS exact action wins: consume it (single-use
            # via the ledger) and allow.
            spent = {r["request_id"] for r in conn.execute("SELECT request_id FROM consumed_grants").fetchall()}
            approved_rows = conn.execute(
                "SELECT payload FROM escalations WHERE status = ? ORDER BY rowid DESC",
                (EscalationStatus.APPROVED.value,),
            ).fetchall()
            for row in approved_rows:
                grant = EscalationEnvelope.from_dict(json.loads(row["payload"]))
                if grant.request_id in spent:
                    continue
                if not grant_authorizes(
                    grant, run_id=envelope.run_id, principal=envelope.principal,
                    tool_name=envelope.tool_name, args_digest=envelope.args_digest,
                    session_id=envelope.session_id, now=now,
                ):
                    continue
                try:
                    conn.execute(
                        "INSERT INTO consumed_grants(request_id, nonce, consumed_at) VALUES(?, ?, ?)",
                        (grant.request_id, grant.nonce, now.isoformat()),
                    )
                except sqlite3.IntegrityError:
                    continue
                grant.status = EscalationStatus.CONSUMED.value
                grant.consumed_at = now.isoformat()
                conn.execute(
                    "UPDATE escalations SET status = ?, payload = ? WHERE request_id = ?",
                    (grant.status, json.dumps(grant.to_dict(), ensure_ascii=False), grant.request_id),
                )
                return ("allow", grant)
            # 2) Sticky deny refuses the action.
            denied_rows = conn.execute(
                "SELECT payload FROM escalations WHERE status = ? ORDER BY rowid DESC",
                (EscalationStatus.DENIED.value,),
            ).fetchall()
            for row in denied_rows:
                denied = EscalationEnvelope.from_dict(json.loads(row["payload"]))
                if self._binding_matches(denied, envelope):
                    raise EscalationDenied(denied)
            # 3) Reuse an open pending, else open a new one.
            pending_rows = conn.execute(
                "SELECT payload FROM escalations WHERE status = ? ORDER BY rowid DESC",
                (EscalationStatus.PENDING.value,),
            ).fetchall()
            for row in pending_rows:
                existing = EscalationEnvelope.from_dict(json.loads(row["payload"]))
                if existing.is_expired(now=now):
                    continue
                if self._binding_matches(existing, envelope):
                    return ("pending", existing)
            conn.execute(
                "INSERT INTO escalations(request_id, run_id, kind, status, payload) VALUES(?, ?, ?, ?, ?)",
                (
                    envelope.request_id,
                    envelope.run_id,
                    envelope.kind,
                    envelope.status,
                    json.dumps(envelope.to_dict(), ensure_ascii=False),
                ),
            )
        return ("pending", envelope)

    def resolve_escalation(
        self,
        request_id: str,
        *,
        decision_option_id: str,
        approver: str,
        principal: str | None = None,
        expected_args_digest: str | None = None,
        last_action_id: str | None = None,
        now: datetime | None = None,
    ) -> EscalationEnvelope:
        """Apply a human decision to a PENDING escalation, fail-closed.

        Refuses (raises EscalationError) on: tampered signature, expired record,
        non-pending status, principal mismatch (the responder is not the bound
        principal — "same machine = authorized" is privilege escalation on a
        multi-user host, roadmap Q4.3), unknown option, or args-digest mismatch.
        A ``grants`` option moves the record to APPROVED; any other option DENIES."""
        assert_writes_allowed("resolve_escalation")
        now = now or datetime.now(UTC)
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT payload FROM escalations WHERE request_id = ?", (request_id,)
            ).fetchone()
            if not row:
                raise KeyError(request_id)
            env = EscalationEnvelope.from_dict(json.loads(row["payload"]))
            if not verify_envelope(env):
                raise EscalationError("escalation signature invalid (tampered record)")
            if env.is_expired(now=now):
                if env.status in {EscalationStatus.PENDING.value, EscalationStatus.APPROVED.value}:
                    env.status = EscalationStatus.EXPIRED.value
                    conn.execute(
                        "UPDATE escalations SET status = ?, payload = ? WHERE request_id = ?",
                        (env.status, json.dumps(env.to_dict(), ensure_ascii=False), request_id),
                    )
                    # Commit the EXPIRED transition before raising: the `with conn`
                    # context rolls back on exception, which would otherwise drop it.
                    conn.commit()
                raise EscalationError("escalation has expired")
            if env.status != EscalationStatus.PENDING.value:
                raise EscalationError(f"escalation is not pending (status={env.status})")
            # Identity binding (Q4.3): the responder MUST be the bound principal.
            # A record without a bound principal is treated as unresolvable rather
            # than world-resolvable.
            if not env.principal or principal != env.principal:
                raise EscalationError("principal mismatch: not authorized to respond to this escalation")
            option = env.option(decision_option_id)
            if option is None:
                raise EscalationError(f"unknown option {decision_option_id!r}")
            if expected_args_digest is not None and expected_args_digest != env.args_digest:
                raise EscalationError("args digest mismatch")
            new_status = (
                EscalationStatus.APPROVED.value if option.grants else EscalationStatus.DENIED.value
            )
            if not is_valid_escalation_status_transition(env.status, new_status):
                raise EscalationError(f"illegal transition {env.status} -> {new_status}")
            env.status = new_status
            env.decision = decision_option_id
            env.approver = approver
            env.resolved_at = now.isoformat()
            env.last_action_id = last_action_id
            if new_status == EscalationStatus.APPROVED.value:
                # Mint the approval attestation over the decision facts. A later
                # tamper that flips a stored row to approved cannot forge this
                # without the ticket key (binding signature does not cover status).
                env.grant_signature = sign_grant(env)
            conn.execute(
                "UPDATE escalations SET status = ?, payload = ? WHERE request_id = ?",
                (env.status, json.dumps(env.to_dict(), ensure_ascii=False), request_id),
            )
        # Single emit point for the resolution lifecycle event, so EVERY surface that
        # resolves through the kernel (CLI `escalation respond`, REST respond) behaves
        # identically — no surface-level side-effect drift. This is a DURABLE event
        # (run-cockpit snapshot / timeline / audit), NOT a live-delivery guarantee:
        # the run-events SSE closes once a run is WAITING_FOR_HUMAN_GATE, so a live
        # watcher reads it on reconnect/snapshot while the responding surface closes
        # its prompt from the respond RESULT, not from this event. Emitted only after
        # a committed approve/deny (the expired/refused paths raise above and never
        # reach here); add_event is best-effort safe-write and never raises.
        if env.run_id:
            self.add_event(
                env.run_id,
                "escalation.resolved",
                {
                    "request_id": env.request_id,
                    "status": env.status,
                    "decision": env.decision,
                    "run_id": env.run_id,
                },
            )
        return env

    def find_consumable_grant(
        self,
        *,
        run_id: str | None,
        principal: str | None,
        tool_name: str,
        args_digest: str,
        session_id: str | None = None,
        now: datetime | None = None,
    ) -> EscalationEnvelope | None:
        """Read-only check for a still-valid, UNSPENT grant authorizing THIS exact
        action for THIS principal in THIS run/session. Does not consume — use
        ``consume_grant`` to spend it."""
        now = now or datetime.now(UTC)
        with self._connect() as conn:
            spent = {r["request_id"] for r in conn.execute("SELECT request_id FROM consumed_grants").fetchall()}
            rows = conn.execute(
                "SELECT payload FROM escalations WHERE status = ? ORDER BY rowid DESC",
                (EscalationStatus.APPROVED.value,),
            ).fetchall()
        for row in rows:
            env = EscalationEnvelope.from_dict(json.loads(row["payload"]))
            if env.request_id in spent:
                continue
            if grant_authorizes(
                env, run_id=run_id, principal=principal, tool_name=tool_name,
                args_digest=args_digest, session_id=session_id, now=now,
            ):
                return env
        return None

    def consume_grant(
        self,
        *,
        run_id: str | None,
        principal: str | None,
        tool_name: str,
        args_digest: str,
        session_id: str | None = None,
        now: datetime | None = None,
    ) -> EscalationEnvelope | None:
        """Atomically find AND spend a valid grant for THIS exact action by THIS
        principal in THIS run/session. Returns the consumed envelope, or None when
        no valid grant exists.

        Single-consumption is enforced by the ``consumed_grants`` ledger: under an
        IMMEDIATE write lock we INSERT the grant's request_id (PRIMARY KEY) — a
        second attempt hits the PK and is refused. The ledger is the authority for
        "already spent" and survives a full restore of the escalations row to its
        prior approved state (roadmap §8.2: "重复消费全拒")."""
        assert_writes_allowed("consume_grant")
        now = now or datetime.now(UTC)
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            spent = {r["request_id"] for r in conn.execute("SELECT request_id FROM consumed_grants").fetchall()}
            rows = conn.execute(
                "SELECT payload FROM escalations WHERE status = ? ORDER BY rowid DESC",
                (EscalationStatus.APPROVED.value,),
            ).fetchall()
            for row in rows:
                env = EscalationEnvelope.from_dict(json.loads(row["payload"]))
                if env.request_id in spent:
                    continue
                if not grant_authorizes(
                    env, run_id=run_id, principal=principal, tool_name=tool_name,
                    args_digest=args_digest, session_id=session_id, now=now,
                ):
                    continue
                consumed_at = now.isoformat()
                try:
                    conn.execute(
                        "INSERT INTO consumed_grants(request_id, nonce, consumed_at) VALUES(?, ?, ?)",
                        (env.request_id, env.nonce, consumed_at),
                    )
                except sqlite3.IntegrityError:
                    # Already spent (lost the race): keep looking, never double-spend.
                    continue
                env.status = EscalationStatus.CONSUMED.value
                env.consumed_at = consumed_at
                conn.execute(
                    "UPDATE escalations SET status = ?, payload = ? WHERE request_id = ?",
                    (env.status, json.dumps(env.to_dict(), ensure_ascii=False), env.request_id),
                )
                return env
            return None

    def expire_stale_escalations(self, *, now: datetime | None = None) -> int:
        """Housekeeping: flip overdue PENDING/APPROVED records to EXPIRED. Lazy
        reads already treat them as expired; this persists the transition (the
        background half of the "懒检查 + 后台定时双保险" in roadmap Q4)."""
        assert_writes_allowed("expire_stale_escalations")
        now = now or datetime.now(UTC)
        expired = 0
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            rows = conn.execute(
                "SELECT payload FROM escalations WHERE status IN (?, ?)",
                (EscalationStatus.PENDING.value, EscalationStatus.APPROVED.value),
            ).fetchall()
            for row in rows:
                env = EscalationEnvelope.from_dict(json.loads(row["payload"]))
                if not env.is_expired(now=now):
                    continue
                env.status = EscalationStatus.EXPIRED.value
                conn.execute(
                    "UPDATE escalations SET status = ?, payload = ? WHERE request_id = ?",
                    (env.status, json.dumps(env.to_dict(), ensure_ascii=False), env.request_id),
                )
                expired += 1
        return expired

    def consume_runtime_tool_grant(
        self,
        request_id: str,
        *,
        run_id: str | None,
        principal: str | None,
        method: str,
        action_digest: str,
        session_id: str | None = None,
        now: datetime | None = None,
    ) -> str:
        """Atomically resolve ONE runtime_tool escalation's decision for the native
        approval broker poll (P2/D5). Returns one of:

        * ``"allow"`` — APPROVED + a valid runtime_tool grant for THIS exact action:
          the single-use grant is CONSUMED (ledger + status→CONSUMED) in the same
          IMMEDIATE transaction, so a duplicate poll can never double-consume.
        * ``"deny"`` — a sticky human DENY, an already-consumed grant, or an
          APPROVED-but-non-authorizing record (tamper / binding mismatch → fail-closed).
        * ``"expired"`` — past its deadline.
        * ``"pending"`` — not yet decided, or the record is not visible yet.

        Fail-closed: anything that is not an authorizing, unspent, APPROVED grant for
        the exact (run/session/principal/method/action_digest) is never ``"allow"``."""
        assert_writes_allowed("consume_runtime_tool_grant")
        now = now or datetime.now(UTC)
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT payload FROM escalations WHERE request_id = ?", (request_id,)
            ).fetchone()
            if not row:
                # Not visible yet (or unknown id): the broker keeps waiting; the
                # per-approval timeout / run deadline ultimately fail-closes it.
                return "pending"
            env = EscalationEnvelope.from_dict(json.loads(row["payload"]))
            if env.status == EscalationStatus.DENIED.value:
                return "deny"
            if env.effective_status(now=now) == EscalationStatus.EXPIRED.value:
                return "expired"
            # Point query (NOT a full-table scan): this runs on every broker poll, so a
            # SELECT-all would be O(N) per tick. The INSERT below + its IntegrityError
            # guard is the authoritative single-consumption check; this is a fast pre-check.
            already = conn.execute(
                "SELECT 1 FROM consumed_grants WHERE request_id = ? LIMIT 1", (env.request_id,)
            ).fetchone()
            if already is not None:
                return "deny"  # already consumed — never authorize twice
            if grant_authorizes_runtime_tool(
                env, run_id=run_id, principal=principal, method=method,
                action_digest=action_digest, session_id=session_id, now=now,
            ):
                try:
                    conn.execute(
                        "INSERT INTO consumed_grants(request_id, nonce, consumed_at) VALUES(?, ?, ?)",
                        (env.request_id, env.nonce, now.isoformat()),
                    )
                except sqlite3.IntegrityError:
                    return "deny"
                env.status = EscalationStatus.CONSUMED.value
                env.consumed_at = now.isoformat()
                conn.execute(
                    "UPDATE escalations SET status = ?, payload = ? WHERE request_id = ?",
                    (env.status, json.dumps(env.to_dict(), ensure_ascii=False), env.request_id),
                )
                return "allow"
            if env.status == EscalationStatus.APPROVED.value:
                # APPROVED but the grant does not authorize this exact action (binding
                # mismatch / invalid signature) → fail-closed deny, never loop forever.
                return "deny"
            return "pending"
    # --- Governance namespace: company / workspace profiles ---------------

    def save_company_profile(self, company: CompanyProfile) -> CompanyProfile:
        assert_writes_allowed("save_company_profile")
        with self._connect() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO company_profiles(company_profile_id, payload) VALUES(?, ?)",
                (company.company_profile_id, json.dumps(company.to_dict(), ensure_ascii=False)),
            )
        # Persistence invariant: every company has its owner on the membership
        # roll (idempotent — re-saving a company never duplicates or demotes).
        self.ensure_company_membership(
            company.company_profile_id, "user", company.owner_id, membership_role="owner"
        )
        return company

    # --- org memberships (B 端 schema: humans + agents in one table) ---------

    def ensure_company_membership(
        self,
        company_profile_id: str,
        principal_type: str,
        principal_id: str,
        *,
        membership_role: str = "member",
    ) -> CompanyMembership:
        """Idempotently register a principal on a company's membership roll.

        INSERT OR IGNORE: an existing membership (any role/status) is never
        overwritten by a seed — explicit role changes are a future, audited
        operation, not a side effect of re-saving a profile.
        """
        assert_writes_allowed("ensure_company_membership")
        membership = CompanyMembership(
            company_profile_id=company_profile_id,
            principal_type=principal_type,
            principal_id=principal_id,
            membership_role=membership_role,
        )
        with self._connect() as conn:
            conn.execute(
                "INSERT OR IGNORE INTO company_memberships"
                "(membership_id, company_profile_id, principal_type, principal_id, payload)"
                " VALUES(?, ?, ?, ?, ?)",
                (
                    membership.membership_id,
                    membership.company_profile_id,
                    membership.principal_type,
                    membership.principal_id,
                    json.dumps(membership.to_dict(), ensure_ascii=False),
                ),
            )
            row = conn.execute(
                "SELECT payload FROM company_memberships WHERE company_profile_id = ?"
                " AND principal_type = ? AND principal_id = ?",
                (company_profile_id, principal_type, principal_id),
            ).fetchone()
        return CompanyMembership.from_dict(json.loads(row["payload"]))

    def list_company_memberships(
        self,
        *,
        company_profile_id: str | None = None,
        principal_id: str | None = None,
    ) -> list[CompanyMembership]:
        query = "SELECT payload FROM company_memberships"
        clauses: list[str] = []
        params: list[str] = []
        if company_profile_id:
            clauses.append("company_profile_id = ?")
            params.append(company_profile_id)
        if principal_id:
            clauses.append("principal_id = ?")
            params.append(principal_id)
        if clauses:
            query += " WHERE " + " AND ".join(clauses)
        query += " ORDER BY rowid"
        with self._connect() as conn:
            rows = conn.execute(query, params).fetchall()
        return [CompanyMembership.from_dict(json.loads(row["payload"])) for row in rows]

    def anchor_run_on_issue(
        self, issue_id: str, run_id: str, *,
        expected_checkout_run_id: str, expected_status: str = "in_progress",
    ) -> "Issue | None":
        """Compare-and-set: record ``execution_run_id`` ONLY IF the issue is
        still ``expected_status`` AND still on the SAME claim
        (``checkout_run_id == expected_checkout_run_id``), atomically.

        Checking the claim token — not just the status — closes the ABA race:
        a human ``requeue`` (todo) followed by a reassignment and a fresh
        checkout returns the issue to ``in_progress`` under a NEW claim; a
        stale run from the old claim must NOT anchor over it. Returns ``None``
        whenever the status moved or the claim changed; the daemon respects
        that and never clobbers the current claim's work.
        """
        assert_writes_allowed("anchor_run_on_issue")
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT payload FROM issues WHERE issue_id = ?", (issue_id,)
            ).fetchone()
            if row is None:
                return None
            issue = Issue.from_dict(json.loads(row["payload"]))
            if issue.status != expected_status or issue.checkout_run_id != expected_checkout_run_id:
                return None  # moved, or a different claim now owns it — do not clobber
            issue.execution_run_id = run_id
            issue.updated_at = time.time()
            _stamp_status_changed_at(conn, issue)
            conn.execute(
                "INSERT OR REPLACE INTO issues(issue_id, workspace_id, status, assignee_agent_profile_id, payload)"
                " VALUES(?, ?, ?, ?, ?)",
                (issue.issue_id, issue.workspace_id, issue.status,
                 issue.assignee_agent_profile_id,
                 _serialize_issue(issue)),
            )
            return issue

    def submit_issue_for_review(
        self, issue: Issue, approval: Approval, *, expected_checkout_run_id: str | None = None
    ) -> None:
        """Flip an issue to in_review AND open its completion approval atomically.

        One BEGIN IMMEDIATE transaction so the bridge from agent work to the
        human gate is all-or-nothing: a crash can no longer strand an issue in
        ``in_review`` with no approval to grant (the two-phase gap). The issue
        transition is validated; both rows commit together or neither does. When
        ``expected_checkout_run_id`` is given, the flip is also bound to the
        claim token (closes the anchor→submit ABA window — a stale run cannot
        submit a new claim's work).
        """
        assert_writes_allowed("submit_issue_for_review")
        # Same governance-scope guard save_issue enforces, asserted BEFORE the
        # write transaction (it reads on its own connection).
        self._assert_governance_scope(
            company_profile_id=issue.company_profile_id, workspace_id=issue.workspace_id
        )
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            existing = conn.execute(
                "SELECT payload FROM issues WHERE issue_id = ?", (issue.issue_id,)
            ).fetchone()
            if existing:
                previous = Issue.from_dict(json.loads(existing["payload"]))
                # Claim-identity check inside the SAME transaction: a requeue +
                # re-checkout that landed after the run's anchor must not let a
                # stale run submit the new claim's work.
                if (
                    expected_checkout_run_id is not None
                    and previous.checkout_run_id != expected_checkout_run_id
                ):
                    from superclaw.team_kernel import ClaimChangedError

                    raise ClaimChangedError(
                        f"issue {issue.issue_id} claim changed "
                        f"({previous.checkout_run_id} != {expected_checkout_run_id}); not submitting stale work"
                    )
                if not is_valid_issue_status_transition(previous.status, issue.status):
                    raise ValueError(
                        f"invalid issue status transition: {previous.status} -> {issue.status}"
                    )
            # Hold CAS inside the SAME transaction: a hold that lands AFTER the
            # team_kernel pre-check but before this commit must still block the
            # flip to in_review. This is the authoritative gate — the kernel-level
            # check is just a fast fail. A held issue never advances to review.
            held = conn.execute(
                "SELECT 1 FROM issue_holds WHERE issue_id = ? AND status = 'active' LIMIT 1",
                (issue.issue_id,),
            ).fetchone()
            if held is not None:
                from superclaw.team_kernel import IssueHeldError

                raise IssueHeldError(
                    f"issue {issue.issue_id} is on hold; refusing to advance to review"
                )
            # Resubmit CAS, fail-closed: reusing an existing approval id is only
            # legal when that approval is STILL revision_requested at write time. A
            # stale resubmit that raced a reject/cancel finds it terminal here and
            # is refused — a terminal approval can never be revived to pending.
            prior_approval = conn.execute(
                "SELECT status FROM approvals WHERE approval_id = ?", (approval.approval_id,)
            ).fetchone()
            if prior_approval is not None and prior_approval["status"] != ApprovalStatus.REVISION_REQUESTED.value:
                raise ValueError(
                    f"approval {approval.approval_id} is {prior_approval['status']}, not revision_requested; "
                    "refusing to reopen it (a terminal approval can never be revived)"
                )
            _stamp_status_changed_at(conn, issue)
            conn.execute(
                "INSERT OR REPLACE INTO issues(issue_id, workspace_id, status, assignee_agent_profile_id, payload)"
                " VALUES(?, ?, ?, ?, ?)",
                (issue.issue_id, issue.workspace_id, issue.status,
                 issue.assignee_agent_profile_id,
                 _serialize_issue(issue)),
            )
            conn.execute(
                "INSERT OR REPLACE INTO approvals(approval_id, status, issue_id, payload) VALUES(?, ?, ?, ?)",
                (approval.approval_id, approval.status, approval.issue_id,
                 json.dumps(approval.to_dict(), ensure_ascii=False)),
            )

    def auto_complete_issue(
        self,
        issue: Issue,
        *,
        release_lock_key: str | None = None,
        expected_checkout_run_id: str | None = None,
    ) -> None:
        """Atomically complete a ``no_completion_gate`` issue WITHOUT an approval.

        The machine-flow close the execution plan reserves for sub-work whose
        ``review_policy`` is ``no_completion_gate``. In ONE transaction it: CAS-checks
        the claim + hold exactly like :meth:`submit_issue_for_review`, validates BOTH
        logical hops ``in_progress -> in_review -> done`` (so the state machine's
        "done only from in_review" invariant is preserved — no ``in_progress -> done``
        shortcut is introduced), writes the done issue, and releases the workspace
        lock conditioned on it still belonging to this issue. No ``Approval`` row is
        created (an auto-grant would be approval theater); the kernel caller writes a
        system-authored completion interaction for the audit trail.
        """
        assert_writes_allowed("auto_complete_issue")
        self._assert_governance_scope(
            company_profile_id=issue.company_profile_id, workspace_id=issue.workspace_id
        )
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            existing = conn.execute(
                "SELECT payload FROM issues WHERE issue_id = ?", (issue.issue_id,)
            ).fetchone()
            # Fail-closed against misuse as a generic completion shortcut: this path
            # ONLY closes a no_completion_gate issue, and ONLY to done. A caller that
            # hands in a human_final/qa_accept issue, or any non-done target, is
            # refused here (so the method can never bypass the human approval gate).
            if issue.status != IssueStatus.DONE.value:
                raise ValueError(
                    f"auto_complete_issue only completes to done, not {issue.status!r}"
                )
            if issue.review_policy != ReviewPolicy.NO_COMPLETION_GATE.value:
                raise ValueError(
                    f"auto_complete_issue only closes a no_completion_gate issue, "
                    f"not {issue.review_policy!r}"
                )
            # Fail-CLOSED on a missing row: completion is only ever a transition of an
            # EXISTING in_progress issue. Without this, a caller could hand in a fresh
            # status=done object and have it inserted, bypassing the "done reachable
            # only from a committed in_progress" invariant entirely.
            if existing is None:
                raise ValueError(
                    f"auto_complete_issue: issue {issue.issue_id} does not exist; "
                    "only an existing in_progress issue can be auto-completed"
                )
            previous = Issue.from_dict(json.loads(existing["payload"]))
            # The committed row must ALSO be no_completion_gate — a caller cannot
            # flip an in-memory copy's policy to sneak a different issue through.
            if previous.review_policy != ReviewPolicy.NO_COMPLETION_GATE.value:
                raise ValueError(
                    f"stored issue {issue.issue_id} is {previous.review_policy!r}, "
                    "not no_completion_gate; refusing to auto-complete"
                )
            # Defense at the point of effect: the committed row must have a real,
            # in-scope parent. Even if a bogus-parent no-gate issue slipped past
            # creation, it can never be auto-closed here.
            self._assert_real_parent_in_scope(conn, previous)
            if (
                expected_checkout_run_id is not None
                and previous.checkout_run_id != expected_checkout_run_id
            ):
                from superclaw.team_kernel import ClaimChangedError

                raise ClaimChangedError(
                    f"issue {issue.issue_id} claim changed "
                    f"({previous.checkout_run_id} != {expected_checkout_run_id}); not auto-completing stale work"
                )
            # Validate the full logical path, never a bare in_progress -> done:
            # the "done reachable only from in_review" rule stays intact.
            if not is_valid_issue_status_transition(
                previous.status, IssueStatus.IN_REVIEW.value
            ) or not is_valid_issue_status_transition(
                IssueStatus.IN_REVIEW.value, issue.status
            ):
                raise ValueError(
                    f"invalid auto-completion path: {previous.status} -> in_review -> {issue.status}"
                )
            # Hold CAS in the SAME transaction: a hold that lands after the kernel
            # pre-check must still block the close. A held issue never auto-completes.
            held = conn.execute(
                "SELECT 1 FROM issue_holds WHERE issue_id = ? AND status = 'active' LIMIT 1",
                (issue.issue_id,),
            ).fetchone()
            if held is not None:
                from superclaw.team_kernel import IssueHeldError

                raise IssueHeldError(
                    f"issue {issue.issue_id} is on hold; refusing to auto-complete"
                )
            _stamp_status_changed_at(conn, issue)
            conn.execute(
                "INSERT OR REPLACE INTO issues(issue_id, workspace_id, status, assignee_agent_profile_id, payload)"
                " VALUES(?, ?, ?, ?, ?)",
                (issue.issue_id, issue.workspace_id, issue.status,
                 issue.assignee_agent_profile_id,
                 _serialize_issue(issue)),
            )
            if release_lock_key:
                row = conn.execute(
                    "SELECT payload FROM workspace_locks WHERE lock_key = ?", (release_lock_key,)
                ).fetchone()
                if row:
                    current = WorkspaceLock.from_dict(json.loads(row["payload"]))
                    if current.issue_id == issue.issue_id:
                        conn.execute(
                            "DELETE FROM workspace_locks WHERE lock_key = ?", (release_lock_key,)
                        )

    @staticmethod
    def _assert_agent_completion_authz_in_txn(
        conn: Any, child: Issue, agent_authz: tuple[str, str]
    ) -> None:
        """Re-validate a parent_accept agent close against committed rows, inside the
        caller's write transaction. Fail-closed: anything that changed since the
        kernel pre-check (a hold landing, the parent finishing/being re-assigned, a
        stale run) rolls the decision back."""
        deciding_agent, deciding_run = agent_authz
        # The committed child must STILL be parent_accept — only that policy is
        # agent-closeable. A policy mutated to human_final/qa_accept after the kernel
        # pre-check cannot be agent-closed through this raced window.
        if child.review_policy != ReviewPolicy.PARENT_ACCEPT.value:
            raise ValueError(
                f"issue {child.issue_id} is {child.review_policy!r}, not parent_accept; "
                "an agent may not close it"
            )
        if conn.execute(
            "SELECT 1 FROM issue_holds WHERE issue_id = ? AND status = 'active' LIMIT 1",
            (child.issue_id,),
        ).fetchone():
            raise ValueError(f"issue {child.issue_id} is on hold; agent may not close it")
        if not child.parent_id:
            raise ValueError("parent_accept issue has no parent to authorize its completion")
        prow = conn.execute(
            "SELECT payload FROM issues WHERE issue_id = ?", (child.parent_id,)
        ).fetchone()
        if not prow:
            raise ValueError(f"parent issue {child.parent_id} not found")
        parent = Issue.from_dict(json.loads(prow["payload"]))
        if parent.status != IssueStatus.IN_PROGRESS.value:
            raise ValueError(
                f"parent issue {parent.issue_id} is {parent.status}, not in_progress; "
                "an agent may only accept a child while actively working the parent"
            )
        if conn.execute(
            "SELECT 1 FROM issue_holds WHERE issue_id = ? AND status = 'active' LIMIT 1",
            (parent.issue_id,),
        ).fetchone():
            raise ValueError(f"parent issue {parent.issue_id} is on hold; cannot accept a child")
        if deciding_agent != parent.assignee_agent_profile_id:
            raise ValueError("only the parent issue's current assignee may accept this child")
        if not parent.checkout_run_id or deciding_run != parent.checkout_run_id:
            raise ValueError(
                "agent completion decision must come from the run that currently holds "
                "the parent's checkout (stale run rejected)"
            )

    def apply_approval_decision(
        self,
        issue: Issue,
        approval: Approval,
        *,
        release_lock_key: str | None = None,
        require_agent_authz: tuple[str, str] | None = None,
    ) -> None:
        """Atomically flip an approval decision's core state in ONE transaction.

        Issue status, approval status and (optionally) the workspace lock
        release commit together or not at all — a crash can no longer leave a
        rejected approval with an untouched issue, or a done issue with a held
        lock. The lock delete is conditional on still belonging to this issue.
        Thread artifacts (comments / interactions / wakeups) deliberately live
        OUTSIDE this transaction: they are recoverable, the flip is not.

        ``require_agent_authz`` = ``(deciding_agent_profile_id, deciding_run_id)``
        re-validates the parent_accept agent authorization INSIDE this transaction
        (the authoritative gate, mirroring submit_issue_for_review's hold CAS): a
        held child/parent, a parent that is no longer in_progress, a re-assigned
        parent, or a stale run that all passed the kernel pre-check but raced this
        commit are caught here and roll the decision back. Human decisions pass
        ``None`` — a person is the override authority and is not run-bound.
        """
        assert_writes_allowed("apply_approval_decision")
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            existing = conn.execute(
                "SELECT payload FROM issues WHERE issue_id = ?", (issue.issue_id,)
            ).fetchone()
            # Fail-CLOSED on a missing row: a decision flips an EXISTING issue. A
            # direct call with a fabricated issue (no row) must not be able to insert
            # a done issue — and, with require_agent_authz, skip the authz re-check.
            if existing is None:
                raise ValueError(
                    f"apply_approval_decision: issue {issue.issue_id} does not exist"
                )
            previous = Issue.from_dict(json.loads(existing["payload"]))
            if not is_valid_issue_status_transition(previous.status, issue.status):
                raise ValueError(
                    f"invalid issue status transition: {previous.status} -> {issue.status}"
                )
            if require_agent_authz is not None:
                self._assert_agent_completion_authz_in_txn(
                    conn, previous, require_agent_authz
                )
            _stamp_status_changed_at(conn, issue)
            conn.execute(
                "INSERT OR REPLACE INTO issues(issue_id, workspace_id, status, assignee_agent_profile_id, payload)"
                " VALUES(?, ?, ?, ?, ?)",
                (issue.issue_id, issue.workspace_id, issue.status,
                 issue.assignee_agent_profile_id,
                 _serialize_issue(issue)),
            )
            conn.execute(
                "INSERT OR REPLACE INTO approvals(approval_id, status, issue_id, payload) VALUES(?, ?, ?, ?)",
                (approval.approval_id, approval.status, approval.issue_id,
                 json.dumps(approval.to_dict(), ensure_ascii=False)),
            )
            if release_lock_key:
                row = conn.execute(
                    "SELECT payload FROM workspace_locks WHERE lock_key = ?", (release_lock_key,)
                ).fetchone()
                if row:
                    current = WorkspaceLock.from_dict(json.loads(row["payload"]))
                    if current.issue_id == issue.issue_id:
                        conn.execute(
                            "DELETE FROM workspace_locks WHERE lock_key = ?", (release_lock_key,)
                        )

    # --- issue thread (comments + interactions) -------------------------------

    def add_issue_comment(self, comment: IssueComment) -> IssueComment:
        assert_writes_allowed("add_issue_comment")
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO issue_comments(comment_id, issue_id, company_profile_id, created_at, payload)"
                " VALUES(?, ?, ?, ?, ?)",
                (
                    comment.comment_id,
                    comment.issue_id,
                    comment.company_profile_id,
                    comment.created_at,
                    json.dumps(comment.to_dict(), ensure_ascii=False),
                ),
            )
        return comment

    def list_issue_comments(self, issue_id: str, *, limit: int = 200) -> list[IssueComment]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT payload FROM issue_comments WHERE issue_id = ?"
                " ORDER BY created_at LIMIT ?",
                (issue_id, int(limit)),
            ).fetchall()
        return [IssueComment.from_dict(json.loads(row["payload"])) for row in rows]

    def save_issue_interaction(self, interaction: IssueThreadInteraction) -> IssueThreadInteraction:
        assert_writes_allowed("save_issue_interaction")
        with self._connect() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO issue_thread_interactions"
                "(interaction_id, issue_id, company_profile_id, kind, status, created_at, payload)"
                " VALUES(?, ?, ?, ?, ?, ?, ?)",
                (
                    interaction.interaction_id,
                    interaction.issue_id,
                    interaction.company_profile_id,
                    interaction.kind,
                    interaction.status,
                    interaction.created_at,
                    json.dumps(interaction.to_dict(), ensure_ascii=False),
                ),
            )
        return interaction

    def list_issue_interactions(
        self,
        *,
        issue_id: str | None = None,
        status: str | None = None,
        kind: str | None = None,
        limit: int = 200,
    ) -> list[IssueThreadInteraction]:
        query = "SELECT payload FROM issue_thread_interactions"
        clauses: list[str] = []
        params: list[Any] = []
        if issue_id:
            clauses.append("issue_id = ?")
            params.append(issue_id)
        if status:
            clauses.append("status = ?")
            params.append(status)
        if kind:
            clauses.append("kind = ?")
            params.append(kind)
        if clauses:
            query += " WHERE " + " AND ".join(clauses)
        query += " ORDER BY created_at LIMIT ?"
        params.append(int(limit))
        with self._connect() as conn:
            rows = conn.execute(query, params).fetchall()
        return [IssueThreadInteraction.from_dict(json.loads(row["payload"])) for row in rows]

    def resolve_issue_interaction(self, interaction_id: str) -> IssueThreadInteraction:
        assert_writes_allowed("resolve_issue_interaction")
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT payload FROM issue_thread_interactions WHERE interaction_id = ?",
                (interaction_id,),
            ).fetchone()
            if row is None:
                raise KeyError(interaction_id)
            interaction = IssueThreadInteraction.from_dict(json.loads(row["payload"]))
            interaction.status = "resolved"
            interaction.resolved_at = time.time()
            conn.execute(
                "UPDATE issue_thread_interactions SET status = 'resolved', payload = ?"
                " WHERE interaction_id = ?",
                (json.dumps(interaction.to_dict(), ensure_ascii=False), interaction_id),
            )
            return interaction

    def get_issue_interaction(self, interaction_id: str) -> IssueThreadInteraction:
        """Load ONE interaction by id (bounded PK lookup; KeyError if absent).

        A single-row replacement for the O(n) ``list_issue_interactions`` scans the
        board-inbox surfaces used to do, so scope resolution / kernel dispatch can
        resolve an interaction without materialising the whole queue."""
        with self._connect() as conn:
            row = conn.execute(
                "SELECT payload FROM issue_thread_interactions WHERE interaction_id = ?",
                (interaction_id,),
            ).fetchone()
        if row is None:
            raise KeyError(interaction_id)
        return IssueThreadInteraction.from_dict(json.loads(row["payload"]))

    def list_board_inbox_items(
        self,
        company_profile_id: str,
        *,
        status: str | None = "pending",
        limit: int = 100,
    ) -> list[IssueThreadInteraction]:
        """A company's durable ESCALATE_TO_BOARD interactions — index- + cap-bounded.

        The ``(company_profile_id, status)`` index (idx_interactions_company_status)
        bounds the scan to THIS company's rows; the ESCALATE_TO_BOARD continuation
        policy is an unindexed ``json_extract`` residual filtered WITHIN that bounded
        set, and ``limit`` caps the materialised rows — so the read tool never
        returns non-board interactions or other companies' rows. A ``status`` of
        ``None`` / ``"all"`` / ``"*"`` returns every status."""
        query = (
            "SELECT payload FROM issue_thread_interactions"
            " WHERE company_profile_id = ?"
            " AND json_extract(payload, '$.continuation_policy') = ?"
        )
        params: list[Any] = [
            company_profile_id,
            ContinuationPolicy.ESCALATE_TO_BOARD.value,
        ]
        if status not in (None, "all", "*"):
            query += " AND status = ?"
            params.append(status)
        query += " ORDER BY created_at DESC LIMIT ?"
        params.append(int(limit))
        with self._connect() as conn:
            rows = conn.execute(query, params).fetchall()
        return [IssueThreadInteraction.from_dict(json.loads(row["payload"])) for row in rows]

    # --- issue hold ledger (administrative pause; NOT an issue status) --------

    def save_issue_hold(self, hold: IssueHold) -> IssueHold:
        """Append a new hold row. A plain INSERT (not OR REPLACE) so the partial
        unique index on (issue_id WHERE status='active') is the DB-level guard:
        a second active hold for the same issue raises sqlite3.IntegrityError
        instead of silently replacing the first."""
        assert_writes_allowed("save_issue_hold")
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute(
                "INSERT INTO issue_holds(hold_id, issue_id, company_profile_id, scope, "
                "operation_id, status, created_at, payload) VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    hold.hold_id,
                    hold.issue_id,
                    hold.company_profile_id,
                    hold.scope,
                    hold.operation_id,
                    hold.status,
                    hold.created_at,
                    json.dumps(hold.to_dict(), ensure_ascii=False),
                ),
            )
        return hold

    def update_issue_hold(self, hold: IssueHold) -> IssueHold:
        """Rewrite a hold row by id (used to flip active -> released). The status
        column and payload are kept in sync so the partial active-index frees up."""
        assert_writes_allowed("update_issue_hold")
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            cur = conn.execute(
                "UPDATE issue_holds SET status = ?, payload = ? WHERE hold_id = ?",
                (hold.status, json.dumps(hold.to_dict(), ensure_ascii=False), hold.hold_id),
            )
            if cur.rowcount == 0:
                raise KeyError(hold.hold_id)
        return hold

    def get_active_issue_hold(self, issue_id: str) -> IssueHold | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT payload FROM issue_holds WHERE issue_id = ? AND status = 'active' LIMIT 1",
                (issue_id,),
            ).fetchone()
        return IssueHold.from_dict(json.loads(row["payload"])) if row else None

    def issue_is_held(self, issue_id: str) -> bool:
        """Fast guard used by checkout and the daemon's work-pickup."""
        with self._connect() as conn:
            row = conn.execute(
                "SELECT 1 FROM issue_holds WHERE issue_id = ? AND status = 'active' LIMIT 1",
                (issue_id,),
            ).fetchone()
        return row is not None

    def list_issue_holds(
        self,
        *,
        issue_id: str | None = None,
        operation_id: str | None = None,
        status: str | None = None,
        limit: int = 200,
    ) -> list[IssueHold]:
        query = "SELECT payload FROM issue_holds"
        clauses: list[str] = []
        params: list[Any] = []
        if issue_id:
            clauses.append("issue_id = ?")
            params.append(issue_id)
        if operation_id:
            clauses.append("operation_id = ?")
            params.append(operation_id)
        if status:
            clauses.append("status = ?")
            params.append(status)
        if clauses:
            query += " WHERE " + " AND ".join(clauses)
        query += " ORDER BY created_at LIMIT ?"
        params.append(int(limit))
        with self._connect() as conn:
            rows = conn.execute(query, params).fetchall()
        return [IssueHold.from_dict(json.loads(row["payload"])) for row in rows]

    # --- heartbeat engine state (wakeups / runtime state / task sessions) ----

    def enqueue_wakeup(self, request: AgentWakeupRequest) -> tuple[AgentWakeupRequest, bool]:
        """Durably queue a wakeup; coalesce duplicates. Returns (row, coalesced).

        Two coalescing rules, both inside one IMMEDIATE transaction so the
        scheduler and event-driven enqueuers can race safely:
        - same ``idempotency_key`` → absorbed into the existing row;
        - an agent already holding ANY queued wakeup absorbs new ones (a wake
          is a wake — the service pass re-reads the world anyway).
        """
        assert_writes_allowed("enqueue_wakeup")
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            return self._enqueue_wakeup_in_conn(conn, request)

    def _enqueue_wakeup_in_conn(
        self, conn: sqlite3.Connection, request: AgentWakeupRequest
    ) -> tuple[AgentWakeupRequest, bool]:
        """Coalesce-or-insert a wakeup on an ALREADY-OPEN write transaction.

        The shared body of :meth:`enqueue_wakeup`, factored out so a caller that
        already holds an IMMEDIATE transaction (e.g. the bootstrap-commit write,
        which materializes seed issues and their assignment wakeups in ONE atomic
        unit) can enqueue the wakeup WITHIN that same transaction. A nested
        ``enqueue_wakeup`` would dead-lock on its own ``BEGIN IMMEDIATE`` against
        the open writer — only this conn-sharing path makes the seed-issue wakeup
        crash-atomic with the issue write (no commit-then-lose window). The caller
        owns the transaction lifecycle (commit/rollback); this method only issues
        statements on the given connection.
        """
        # Gate this conn-sharing write sink too (write_gate coverage contract):
        # it INSERTs/UPDATEs wakeups, so the maintenance freeze must reach it even
        # when reached directly from the bootstrap-commit path (not just via
        # enqueue_wakeup). assert_writes_allowed is a pure in-memory check (no SQL),
        # so it is safe inside the caller's already-open transaction.
        assert_writes_allowed("_enqueue_wakeup_in_conn")
        existing = None
        if request.idempotency_key:
            # Only an OPEN row absorbs by key: a finished/skipped wakeup is
            # history, and the same trigger firing again must re-queue.
            existing = conn.execute(
                "SELECT payload FROM agent_wakeup_requests"
                " WHERE idempotency_key = ? AND status = 'queued'",
                (request.idempotency_key,),
            ).fetchone()
        if existing is None:
            # Same-source absorption only: a timer wake and an assignment
            # wake gate differently, so they never collapse into one row.
            existing = conn.execute(
                "SELECT payload FROM agent_wakeup_requests"
                " WHERE agent_profile_id = ? AND status = 'queued' AND source = ?"
                " ORDER BY requested_at LIMIT 1",
                (request.agent_profile_id, request.source),
            ).fetchone()
        if existing is not None:
            row = AgentWakeupRequest.from_dict(json.loads(existing["payload"]))
            row.coalesced_count += 1
            if request.context_snapshot:
                # Absorbed triggers stay auditable: who else asked, and why.
                absorbed = row.context_snapshot.setdefault("absorbed", [])
                absorbed.append(
                    {"reason": request.reason, "snapshot": request.context_snapshot}
                )
            conn.execute(
                "UPDATE agent_wakeup_requests SET payload = ? WHERE wakeup_id = ?",
                (json.dumps(row.to_dict(), ensure_ascii=False), row.wakeup_id),
            )
            return row, True
        conn.execute(
            "INSERT INTO agent_wakeup_requests"
            "(wakeup_id, agent_profile_id, company_profile_id, source, status,"
            " idempotency_key, requested_at, payload) VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
            (
                request.wakeup_id,
                request.agent_profile_id,
                request.company_profile_id,
                request.source,
                request.status,
                request.idempotency_key,
                request.requested_at,
                json.dumps(request.to_dict(), ensure_ascii=False),
            ),
        )
        return request, False

    def claim_next_wakeup(self, *, now: float | None = None) -> AgentWakeupRequest | None:
        """Atomically move the oldest VISIBLE queued wakeup to ``claimed``.

        ``requested_at`` doubles as a not-before time: a deferred retry is
        enqueued with a future timestamp and stays invisible until then.
        """
        assert_writes_allowed("claim_next_wakeup")
        now = time.time() if now is None else float(now)
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT payload FROM agent_wakeup_requests"
                " WHERE status = 'queued' AND requested_at <= ?"
                " ORDER BY requested_at LIMIT 1",
                (now,),
            ).fetchone()
            if row is None:
                return None
            request = AgentWakeupRequest.from_dict(json.loads(row["payload"]))
            request.status = "claimed"
            request.claimed_at = time.time()
            conn.execute(
                "UPDATE agent_wakeup_requests SET status = 'claimed', payload = ?"
                " WHERE wakeup_id = ? AND status = 'queued'",
                (json.dumps(request.to_dict(), ensure_ascii=False), request.wakeup_id),
            )
            return request

    def finish_wakeup(
        self,
        wakeup_id: str,
        *,
        status: str = "finished",
        detail: str = "",
        expected_status: str | None = None,
    ) -> AgentWakeupRequest:
        assert_writes_allowed("finish_wakeup")
        if status not in {"finished", "skipped"}:
            raise ValueError(f"invalid terminal wakeup status: {status}")
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT payload FROM agent_wakeup_requests WHERE wakeup_id = ?",
                (wakeup_id,),
            ).fetchone()
            if row is None:
                raise KeyError(wakeup_id)
            request = AgentWakeupRequest.from_dict(json.loads(row["payload"]))
            # Conditional transition INSIDE the txn: a caller (e.g. the stale-lock
            # reaper) can require the wakeup to still be in ``expected_status`` so it
            # never clobbers a status another path just committed (a run completing
            # `claimed`→`finished` concurrently must not be overwritten with `skipped`).
            if expected_status is not None and request.status != expected_status:
                conn.commit()
                return request
            request.status = status
            request.detail = detail
            request.finished_at = time.time()
            conn.execute(
                "UPDATE agent_wakeup_requests SET status = ?, payload = ? WHERE wakeup_id = ?",
                (status, json.dumps(request.to_dict(), ensure_ascii=False), wakeup_id),
            )
            return request

    def list_wakeups(
        self,
        *,
        agent_profile_id: str | None = None,
        status: str | None = None,
        limit: int = 100,
        newest_first: bool = False,
    ) -> list[AgentWakeupRequest]:
        query = "SELECT payload FROM agent_wakeup_requests"
        clauses: list[str] = []
        params: list[Any] = []
        if agent_profile_id:
            clauses.append("agent_profile_id = ?")
            params.append(agent_profile_id)
        if status:
            clauses.append("status = ?")
            params.append(status)
        if clauses:
            query += " WHERE " + " AND ".join(clauses)
        # ``newest_first`` matters for bounded reads (e.g. an issue run ledger):
        # the default oldest-first + LIMIT would silently drop the most recent
        # wakeups once the table grows past ``limit``.
        query += " ORDER BY requested_at " + ("DESC" if newest_first else "ASC") + " LIMIT ?"
        params.append(int(limit))
        with self._connect() as conn:
            rows = conn.execute(query, params).fetchall()
        return [AgentWakeupRequest.from_dict(json.loads(row["payload"])) for row in rows]

    def get_wakeup(self, wakeup_id: str) -> AgentWakeupRequest | None:
        """Read one wakeup by id, or None. Read-only.

        The orphaned-checkout reaper uses this to tell a daemon-spawned run's
        lock (``run_id == wakeup_id``, present here) from an operator/CLI run's
        lock (``run_id == run_*``, NEVER present here): an operator lock is out
        of this reaper's scope, so a None result means "leave it alone".
        """
        with self._connect() as conn:
            row = conn.execute(
                "SELECT payload FROM agent_wakeup_requests WHERE wakeup_id = ?",
                (wakeup_id,),
            ).fetchone()
        if row is None:
            return None
        return AgentWakeupRequest.from_dict(json.loads(row["payload"]))

    def reclaim_orphaned_checkout(
        self,
        issue_id: str,
        *,
        expected_wakeup_id: str,
        expected_lock_key: str,
        retry_agent_profile_id: str,
        retry_wakeup_id: str,
        retry_company_profile_id: str,
    ) -> bool:
        """Atomically free a TRUE-orphan checkout lock and re-drive its issue.

        A crash/restart between checkout and run-anchor can leave a ``workspace:``
        / ``issue:`` lock held by a wakeup whose spawned run no longer exists: the
        issue stays ``in_progress`` forever and every later checkout of that
        workspace defers ``workspace already locked``. The daemon reaper proves
        orphanhood by liveness (no run carries this wakeup/issue); THIS method is
        the durable commit, fail-closed under an atomic ABA guard so a concurrent
        re-checkout (a NEW run grabbed the issue/lock between the reaper's read and
        this write) is detected and NOTHING is touched.

        Single ``BEGIN IMMEDIATE`` for the whole unit:
          1. Re-read issue + lock on this connection.
          2. ABA guard — the issue must still be ``in_progress`` checked out by the
             EXACT dead wakeup on the EXACT lock key, and the lock must still be
             held by that wakeup for that issue. Any drift → commit (release the
             write lock) and return False without mutating anything.
          3. Delete the lock; reset the issue to ``todo`` (clears
             checkout/execution run ids + lock_key), syncing the ``status`` column
             AND the payload exactly as :meth:`save_issue` does.
          4. Record the (issue, dead-wakeup) pair in the retry-once ledger; only on
             the FIRST observation (INSERT actually landed) raw-INSERT a single
             on-demand retry wakeup — NOT via :meth:`enqueue_wakeup` (which opens
             its own IMMEDIATE txn / coalesces), but a direct row INSERT mirroring
             ``_enqueue_wakeup_in_conn`` so it is crash-atomic with this unit.
        Returns True iff the orphan was reclaimed in this call.
        """
        assert_writes_allowed("reclaim_orphaned_checkout")
        now = time.time()
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            irow = conn.execute(
                "SELECT payload FROM issues WHERE issue_id = ?", (issue_id,)
            ).fetchone()
            lrow = conn.execute(
                "SELECT payload FROM workspace_locks WHERE lock_key = ?",
                (expected_lock_key,),
            ).fetchone()
            # --- ABA guard (fail-closed): any drift since the reaper's read aborts ---
            if irow is None or lrow is None:
                conn.commit()
                return False
            issue = Issue.from_dict(json.loads(irow["payload"]))
            lock = WorkspaceLock.from_dict(json.loads(lrow["payload"]))
            if not (
                issue.status == IssueStatus.IN_PROGRESS.value
                and issue.checkout_run_id == expected_wakeup_id
                and issue.lock_key == expected_lock_key
                and lock.run_id == expected_wakeup_id
                and lock.issue_id == issue_id
            ):
                conn.commit()
                return False
            # --- in-transaction orphan recheck (closes the TOCTOU) ---
            # The reaper's "no run for this wakeup/issue" decision is made on an
            # out-of-txn list_runs SNAPSHOT. A run created + stamped for THIS
            # wakeup/issue AFTER that snapshot but before this txn would still pass
            # the ABA guard above (checkout_run_id / lock.run_id never change when
            # the run is created), so without this recheck we could delete a LIVE
            # run's checkout lock. Re-scan runs under the held write lock; if ANY
            # run now references this wakeup or issue, it is live work — abort. A
            # run row we cannot parse is treated as a possible match → fail closed.
            for rrow in conn.execute("SELECT payload FROM runs").fetchall():
                try:
                    ec = json.loads(rrow["payload"]).get("execution_context") or {}
                except (ValueError, TypeError, AttributeError):
                    conn.commit()
                    return False
                if isinstance(ec, dict) and (
                    ec.get("wakeup_id") == expected_wakeup_id
                    or ec.get("issue_id") == issue_id
                ):
                    conn.commit()
                    return False
            # --- commit the reclaim ---
            conn.execute(
                "DELETE FROM workspace_locks WHERE lock_key = ?", (expected_lock_key,)
            )
            issue.status = IssueStatus.TODO.value
            issue.execution_run_id = None
            issue.checkout_run_id = None
            issue.lock_key = None
            issue.updated_at = now
            # Mirror save_issue's column+payload sync (status_changed_at stamped on
            # the same conn before serialize, _serialize_issue re-validates fields).
            _stamp_status_changed_at(conn, issue)
            conn.execute(
                "INSERT OR REPLACE INTO issues(issue_id, workspace_id, status, "
                "assignee_agent_profile_id, payload) VALUES(?, ?, ?, ?, ?)",
                (
                    issue.issue_id,
                    issue.workspace_id,
                    issue.status,
                    issue.assignee_agent_profile_id,
                    _serialize_issue(issue),
                ),
            )
            # Retry-once: the PK collapses a re-observed orphan to a no-op INSERT,
            # so only the FIRST reclaim of this (issue, dead-wakeup) re-drives work.
            cur = conn.execute(
                "INSERT OR IGNORE INTO reclaimed_checkout_ledger"
                "(issue_id, wakeup_id, reclaimed_at) VALUES(?, ?, ?)",
                (issue_id, expected_wakeup_id, now),
            )
            first = cur.rowcount == 1
            if first:
                retry = AgentWakeupRequest(
                    agent_profile_id=retry_agent_profile_id,
                    wakeup_id=retry_wakeup_id,
                    company_profile_id=retry_company_profile_id,
                    source="on_demand",
                    reason=f"reclaimed_orphan_checkout:{issue_id}",
                    status="queued",
                )
                # Raw INSERT (NOT enqueue_wakeup): same columns as
                # _enqueue_wakeup_in_conn, on THIS open txn, so the retry is
                # crash-atomic with the reclaim and never coalesces/nests a txn.
                conn.execute(
                    "INSERT INTO agent_wakeup_requests"
                    "(wakeup_id, agent_profile_id, company_profile_id, source, status,"
                    " idempotency_key, requested_at, payload) VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        retry.wakeup_id,
                        retry.agent_profile_id,
                        retry.company_profile_id,
                        retry.source,
                        retry.status,
                        retry.idempotency_key,
                        retry.requested_at,
                        json.dumps(retry.to_dict(), ensure_ascii=False),
                    ),
                )
        return True

    def get_agent_runtime_state(self, agent_profile_id: str) -> AgentRuntimeState | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT payload FROM agent_runtime_state WHERE agent_profile_id = ?",
                (agent_profile_id,),
            ).fetchone()
        return AgentRuntimeState.from_dict(json.loads(row["payload"])) if row else None

    def save_agent_runtime_state(self, state: AgentRuntimeState) -> AgentRuntimeState:
        assert_writes_allowed("save_agent_runtime_state")
        state.updated_at = time.time()
        with self._connect() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO agent_runtime_state(agent_profile_id, payload) VALUES(?, ?)",
                (state.agent_profile_id, json.dumps(state.to_dict(), ensure_ascii=False)),
            )
        return state

    def get_agent_task_session(self, agent_profile_id: str, task_key: str) -> AgentTaskSession | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT payload FROM agent_task_sessions WHERE agent_profile_id = ? AND task_key = ?",
                (agent_profile_id, task_key),
            ).fetchone()
        return AgentTaskSession.from_dict(json.loads(row["payload"])) if row else None

    def save_agent_task_session(self, session: AgentTaskSession) -> AgentTaskSession:
        assert_writes_allowed("save_agent_task_session")
        session.updated_at = time.time()
        with self._connect() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO agent_task_sessions(agent_profile_id, task_key, payload)"
                " VALUES(?, ?, ?)",
                (
                    session.agent_profile_id,
                    session.task_key,
                    json.dumps(session.to_dict(), ensure_ascii=False),
                ),
            )
        return session

    def save_team_routine_schedule(
        self, schedule: TeamRoutineSchedule
    ) -> tuple[TeamRoutineSchedule, bool]:
        """Persist a routine definition with idempotent duplicate protection.

        ``idempotency_key`` is a durable definition key, not a wakeup key. If a
        caller tries to register the same routine twice, the existing row is
        returned and no second schedule is created.
        """
        assert_writes_allowed("save_team_routine_schedule")
        if not str(schedule.agent_profile_id or "").strip():
            raise ValueError("routine agent_profile_id is required")
        if not str(schedule.company_profile_id or "").strip():
            raise ValueError("routine company_profile_id is required")
        if not str(schedule.title or "").strip():
            raise ValueError("routine title is required")
        if schedule.interval_sec < 60:
            raise ValueError("routine interval_sec must be at least 60 seconds")
        if not math.isfinite(float(schedule.next_run_at)):
            raise ValueError("routine next_run_at must be finite")
        profile = self.get_agent_profile(schedule.agent_profile_id)
        if schedule.company_profile_id != profile.company_profile_id:
            raise ValueError(
                f"routine company {schedule.company_profile_id} does not match "
                f"profile company {profile.company_profile_id}"
            )
        schedule.updated_at = time.time()
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            if schedule.idempotency_key:
                existing = conn.execute(
                    "SELECT payload FROM team_routine_schedules WHERE idempotency_key = ?",
                    (schedule.idempotency_key,),
                ).fetchone()
                if existing is not None:
                    return TeamRoutineSchedule.from_dict(json.loads(existing["payload"])), True
            conn.execute(
                "INSERT OR REPLACE INTO team_routine_schedules"
                "(routine_id, agent_profile_id, company_profile_id, enabled, next_run_at,"
                " idempotency_key, payload) VALUES(?, ?, ?, ?, ?, ?, ?)",
                (
                    schedule.routine_id,
                    schedule.agent_profile_id,
                    schedule.company_profile_id,
                    1 if schedule.enabled else 0,
                    schedule.next_run_at,
                    schedule.idempotency_key,
                    json.dumps(schedule.to_dict(), ensure_ascii=False),
                ),
            )
            return schedule, False

    def get_team_routine_schedule(self, routine_id: str) -> TeamRoutineSchedule:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT payload FROM team_routine_schedules WHERE routine_id = ?",
                (routine_id,),
            ).fetchone()
        if row is None:
            raise KeyError(routine_id)
        return TeamRoutineSchedule.from_dict(json.loads(row["payload"]))

    def list_team_routine_schedules(
        self,
        *,
        agent_profile_id: str | None = None,
        enabled: bool | None = None,
        limit: int = 100,
    ) -> list[TeamRoutineSchedule]:
        query = "SELECT payload FROM team_routine_schedules"
        clauses: list[str] = []
        params: list[Any] = []
        if agent_profile_id:
            clauses.append("agent_profile_id = ?")
            params.append(agent_profile_id)
        if enabled is not None:
            clauses.append("enabled = ?")
            params.append(1 if enabled else 0)
        if clauses:
            query += " WHERE " + " AND ".join(clauses)
        query += " ORDER BY next_run_at LIMIT ?"
        params.append(int(limit))
        with self._connect() as conn:
            rows = conn.execute(query, params).fetchall()
        return [TeamRoutineSchedule.from_dict(json.loads(row["payload"])) for row in rows]

    def list_routine_runs(self, routine_id: str, *, limit: int = 100) -> list[dict[str, Any]]:
        """The fire history of one routine — each issue it materialized + that
        fire's run status (Paperclip ``routine_run`` parity).

        A routine fire (``create_each_run``) materializes a fresh issue stamped
        with ``metadata.routine_id``; the issue's ``execution_run_id`` points at the
        run that executed it. This PROJECTS that linkage into a per-fire ledger
        rather than introducing a second source of truth — the issues table and the
        runs table stay authoritative, so the ledger can never drift from them. A
        read-only accessor (no write guard); newest fire first.

        Each record: ``issue_id`` / ``title`` / ``status`` (the issue's lifecycle
        state) / ``run_id`` + ``run_status`` (the executing run, or ``None`` when a
        fire has not run yet) / ``due_at`` + ``routine_slot`` (the cadence slot it
        fired for) / ``created_at``.
        """
        if not routine_id:
            return []
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT payload FROM issues"
                " WHERE json_extract(payload, '$.metadata.routine_id') = ?"
                # Order by the issue's OWN created_at (the fire's materialization
                # instant), NOT rowid — every status advance re-persists the row
                # (an upsert), which refreshes its rowid, so a rowid sort would
                # float an OLD fire to the top the moment it moves to
                # in_review/done. created_at is stamped once at construction and
                # never changes, so it is the stable fire-order key. routine_due_at
                # (the cadence slot) breaks any tie deterministically.
                " ORDER BY json_extract(payload, '$.created_at') DESC,"
                "          json_extract(payload, '$.metadata.routine_due_at') DESC"
                " LIMIT ?",
                (routine_id, int(limit)),
            ).fetchall()
        records: list[dict[str, Any]] = []
        for row in rows:
            issue = Issue.from_dict(json.loads(row["payload"]))
            run_id = issue.execution_run_id
            run_status: str | None = None
            if run_id:
                try:
                    run_status = self.get_run(run_id).status
                except KeyError:
                    run_status = None  # run row gone / never persisted → unknown
            records.append(
                {
                    "issue_id": issue.issue_id,
                    "routine_id": routine_id,
                    "title": issue.title,
                    "status": issue.status,
                    "run_id": run_id,
                    "run_status": run_status,
                    "due_at": issue.metadata.get("routine_due_at"),
                    "routine_slot": issue.metadata.get("routine_slot"),
                    "created_at": issue.created_at,
                }
            )
        return records

    def _materialize_routine_issue_in_conn(
        self,
        conn: sqlite3.Connection,
        schedule: TeamRoutineSchedule,
        due_at: float,
    ) -> Issue | None:
        """Materialize a fresh ``todo`` issue from a routine's seed, conn-local.

        Paperclip parity (routines.ts ``target.create_each_run``): every routine
        fire produces a fresh unit of runnable work, not a reopened terminal one
        (``done`` is a sink — models.IssueStatus). The SuperClaw equivalent of
        Paperclip's per-fire run is a fresh ``todo`` issue seeded from the
        routine's ``issue_seed`` and assigned to the routine's agent; the daemon's
        existing checkout→run→review flow then executes it.

        Runs INSIDE the caller's ``BEGIN IMMEDIATE`` transaction so issue creation
        is atomic with the due-slot advance — exactly one issue per due slot, no
        dedupe table (the slot claim IS the dedupe). It does NOT call
        :meth:`save_issue` (which opens its own connection / transaction and would
        cross the caller's transaction boundary); instead it re-runs the same
        invariants on the caller's ``conn``:

        * **Drift re-validation** (authoring → fire can be weeks apart): the
          routine's company / workspace must still exist and be same-origin, and
          the assignee agent must still exist AND still belong to that company.
          ``save_issue``'s ``_assert_governance_scope`` covers company/workspace
          but NOT the assignee — a routine whose agent was deleted or moved to
          another company must not strand an orphan issue. Any drift → return
          ``None`` (skip this fire, audited by the caller; the slot still
          advanced so the gear keeps turning) rather than write an illegal issue.
        * **Single-flight guard** (anti-backlog): if the routine already has an
          unfinished issue (``todo``/``in_progress``) for its agent, skip this
          fire. The per-agent claim lock only serializes *execution*; without
          this guard a budget-starved or busy agent would accrue an unbounded
          backlog of identical todos (one every cadence). One bullet in flight.
        * **Typed-field fail-closed**: the insert serializes through
          :func:`_serialize_issue`, which re-runs ``assert_valid_issue_typed_fields``.

        Returns the materialized :class:`Issue`, or ``None`` when this fire is
        skipped (drift or single-flight).
        """
        # Double-gate the maintenance freeze (contract B4): the sole caller
        # (claim_due_routine_wakeup) already asserts, but this conn-local helper
        # runs a write statement, so it carries its own guard too — same idempotent
        # in-memory check the other in-conn write helper uses (_enqueue_wakeup_in_conn).
        assert_writes_allowed("_materialize_routine_issue_in_conn")
        routine = schedule.context_snapshot.get("routine")
        if not isinstance(routine, dict):
            return None  # malformed schedule (no authored routine block) → skip
        seed = routine.get("issue_seed")
        references = routine.get("references")
        if not isinstance(seed, dict) or not isinstance(references, dict):
            return None
        title = str(seed.get("title") or "").strip()
        if not title:
            return None  # authoring requires a seed title; a blank one is drift/corruption

        company = schedule.company_profile_id or "local"
        agent_id = schedule.agent_profile_id
        workspace_id = str(references.get("workspace_id") or "local") or "local"
        if not agent_id:
            return None

        # --- Drift re-validation (conn-local reads; no nested _connect) ---------
        if company != "local":
            crow = conn.execute(
                "SELECT 1 FROM company_profiles WHERE company_profile_id = ?",
                (company,),
            ).fetchone()
            if crow is None:
                return None  # company deleted since authoring
        if workspace_id != "local":
            wrow = conn.execute(
                "SELECT company_profile_id FROM workspace_profiles WHERE workspace_id = ?",
                (workspace_id,),
            ).fetchone()
            if wrow is None or wrow["company_profile_id"] != company:
                return None  # workspace deleted or no longer same-origin
        arow = conn.execute(
            "SELECT payload FROM agent_profiles WHERE profile_id = ?",
            (agent_id,),
        ).fetchone()
        if arow is None:
            return None  # assignee agent deleted since authoring
        agent_profile = AgentProfile.from_dict(json.loads(arow["payload"]))
        if agent_profile.company_profile_id != company:
            return None  # assignee agent moved to another company → would orphan

        # --- Single-flight guard: at most one unfinished issue per routine ------
        # "Unfinished" = todo / in_progress only — DELIBERATELY not in_review. An
        # in_review issue means the agent's work is done and the issue is parked on
        # a HUMAN reviewer; blocking the next fire on it would let a slow reviewer
        # freeze the whole cadence. So a routine may queue its next fire's work
        # while the prior fire awaits human review, but never while the agent is
        # still actively holding todo/in_progress work (that is what caps backlog).
        inflight = conn.execute(
            "SELECT 1 FROM issues"
            " WHERE assignee_agent_profile_id = ?"
            "   AND status IN (?, ?)"
            "   AND json_extract(payload, '$.metadata.routine_id') = ?"
            " LIMIT 1",
            (
                agent_id,
                IssueStatus.TODO.value,
                IssueStatus.IN_PROGRESS.value,
                schedule.routine_id,
            ),
        ).fetchone()
        if inflight is not None:
            return None  # last fire's work is still in flight → do not pile on

        seed_metadata = seed.get("metadata")
        metadata: dict[str, Any] = dict(seed_metadata) if isinstance(seed_metadata, dict) else {}
        metadata.update(
            {
                "routine_id": schedule.routine_id,
                "routine_slot": f"{schedule.routine_id}:{int(due_at)}",
                "routine_due_at": due_at,
            }
        )
        # Per-fire equipment selection (Paperclip routine.context): snapshot the
        # routine's plugin/skill narrowing onto THIS issue so the run that
        # executes it narrows equipment to the routine's subset (run_goal reads it
        # as an intrinsic issue property — bypass-immune). Snapshot, not a live
        # ref: a later edit to the schedule's context must not retroactively
        # re-scope an already-materialized todo. Only stamp when at least one axis
        # actually narrows (a non-None plugin_ids/skill_ids); absent on both axes
        # means "no narrowing", so we omit the key entirely and the run inherits
        # the agent's full grants (legacy/no-context routines unchanged).
        routine_context = routine.get("context")
        if isinstance(routine_context, dict):
            plugin_axis = routine_context.get("plugin_ids")
            skill_axis = routine_context.get("skill_ids")
            snapshot: dict[str, Any] = {}
            if isinstance(plugin_axis, list):
                snapshot["plugin_ids"] = [str(p) for p in plugin_axis]
            if isinstance(skill_axis, list):
                snapshot["skill_ids"] = [str(s) for s in skill_axis]
            if snapshot:
                metadata["routine_context"] = snapshot
        issue = Issue(
            title=title,
            description=str(seed.get("description") or ""),
            workspace_id=workspace_id,
            company_profile_id=company,
            owner_id=str(references.get("owner_id") or "local_user") or "local_user",
            status=IssueStatus.TODO.value,
            priority=str(seed.get("priority") or "medium") or "medium",
            assignee_agent_profile_id=agent_id,
            origin_kind="automation",
            created_by=f"routine:{schedule.routine_id}",
            metadata=metadata,
        )
        _stamp_status_changed_at(conn, issue)  # fresh row → keeps seed (no-op)
        conn.execute(
            "INSERT INTO issues(issue_id, workspace_id, status, assignee_agent_profile_id, payload) "
            "VALUES(?, ?, ?, ?, ?)",
            (
                issue.issue_id,
                issue.workspace_id,
                issue.status,
                issue.assignee_agent_profile_id,
                _serialize_issue(issue),
            ),
        )
        return issue

    def claim_due_routine_wakeup(
        self, *, now: float | None = None
    ) -> tuple[TeamRoutineSchedule, AgentWakeupRequest | None] | None:
        """Atomically advance one due routine, materialize its issue, queue a wakeup.

        The routine slot, the seeded issue, and the wakeup row all commit together
        under ``BEGIN IMMEDIATE``. A concurrent daemon tick therefore observes
        either the old due slot or the advanced slot, never two claims for the same
        due time — so the issue is materialized exactly once per due slot.

        Returns:
            * ``None`` — no routine is due (the tick loop stops).
            * ``(schedule, None)`` — a routine was due and its slot advanced, but
              this fire materialized NO work (drift or single-flight skip; see
              :meth:`_materialize_routine_issue_in_conn`). No wakeup is queued; the
              tick loop should CONTINUE to other due routines.
            * ``(schedule, wakeup)`` — a fresh issue was materialized and a
              ``source="routine"`` wakeup queued, carrying the new ``issue_id`` so
              the daemon can run THIS fire's work directly (directed wake).
        """
        assert_writes_allowed("claim_due_routine_wakeup")
        now = time.time() if now is None else float(now)
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT payload FROM team_routine_schedules"
                " WHERE enabled = 1 AND next_run_at <= ?"
                " ORDER BY next_run_at LIMIT 1",
                (now,),
            ).fetchone()
            if row is None:
                return None
            schedule = TeamRoutineSchedule.from_dict(json.loads(row["payload"]))
            due_at = float(schedule.next_run_at)
            next_run_at = due_at + float(schedule.interval_sec)
            while next_run_at <= now:
                next_run_at += float(schedule.interval_sec)
            # Advance the slot FIRST — the cadence gear must turn on every claim,
            # even when this fire materializes no work (drift / single-flight),
            # otherwise a perpetually-skipped routine would re-select forever.
            schedule.next_run_at = next_run_at
            schedule.last_claimed_at = now
            schedule.claim_count += 1
            schedule.updated_at = now

            issue = self._materialize_routine_issue_in_conn(conn, schedule, due_at)
            wakeup: AgentWakeupRequest | None = None
            if issue is not None:
                wakeup = AgentWakeupRequest(
                    agent_profile_id=schedule.agent_profile_id,
                    company_profile_id=schedule.company_profile_id,
                    source="routine",
                    reason=f"routine:{schedule.title}",
                    idempotency_key=f"routine:{schedule.routine_id}:{int(due_at)}",
                    context_snapshot={
                        **dict(schedule.context_snapshot),
                        "routine_id": schedule.routine_id,
                        "routine_title": schedule.title,
                        "due_at": due_at,
                        # Directed wake: bind THIS fire's wakeup to THIS fire's
                        # fresh issue so the daemon runs the work it just created
                        # instead of letting an older/higher-priority todo starve it.
                        "issue_id": issue.issue_id,
                    },
                    requested_at=now,
                )
                schedule.last_wakeup_id = wakeup.wakeup_id
            conn.execute(
                "UPDATE team_routine_schedules"
                " SET next_run_at = ?, payload = ? WHERE routine_id = ?",
                (
                    schedule.next_run_at,
                    json.dumps(schedule.to_dict(), ensure_ascii=False),
                    schedule.routine_id,
                ),
            )
            if wakeup is not None:
                conn.execute(
                    "INSERT INTO agent_wakeup_requests"
                    "(wakeup_id, agent_profile_id, company_profile_id, source, status,"
                    " idempotency_key, requested_at, payload) VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        wakeup.wakeup_id,
                        wakeup.agent_profile_id,
                        wakeup.company_profile_id,
                        wakeup.source,
                        wakeup.status,
                        wakeup.idempotency_key,
                        wakeup.requested_at,
                        json.dumps(wakeup.to_dict(), ensure_ascii=False),
                    ),
                )
            return schedule, wakeup

    def list_instance_user_roles(self, *, user_id: str | None = None) -> list[InstanceUserRole]:
        query = "SELECT payload FROM instance_user_roles"
        params: list[str] = []
        if user_id:
            query += " WHERE user_id = ?"
            params.append(user_id)
        query += " ORDER BY rowid"
        with self._connect() as conn:
            rows = conn.execute(query, params).fetchall()
        return [InstanceUserRole.from_dict(json.loads(row["payload"])) for row in rows]

    def get_company_profile(self, company_profile_id: str) -> CompanyProfile:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT payload FROM company_profiles WHERE company_profile_id = ?",
                (company_profile_id,),
            ).fetchone()
        if not row:
            raise KeyError(company_profile_id)
        return CompanyProfile.from_dict(json.loads(row["payload"]))

    def list_company_profiles(self) -> list[CompanyProfile]:
        with self._connect() as conn:
            rows = conn.execute("SELECT payload FROM company_profiles ORDER BY rowid DESC").fetchall()
        return [CompanyProfile.from_dict(json.loads(row["payload"])) for row in rows]

    def save_workspace_profile(self, workspace: WorkspaceProfile) -> WorkspaceProfile:
        """Persist a workspace profile (the single write entry, so it guards).

        Fail-closed invariants enforced here — not only at the CLI/API door:
        unknown modes are refused; per_issue requires an ABSOLUTE git repo_path
        (a relative path would prove isolation against whichever cwd validated
        it); and concurrency cannot flip while any issue of this workspace is
        mid-claim. The mid-claim check and the upsert ride ONE IMMEDIATE
        transaction and the check covers both issue states AND live workspace
        locks, so a concurrent checkout cannot slip between check and write.
        """
        assert_writes_allowed("save_workspace_profile")
        self._assert_governance_scope(company_profile_id=workspace.company_profile_id, workspace_id=None)
        if workspace.concurrency not in {"serial", "per_issue"}:
            raise ValueError(
                f"unknown workspace concurrency: {workspace.concurrency!r} (serial | per_issue)"
            )
        if workspace.concurrency == "per_issue":
            repo = Path(workspace.repo_path or ".")
            if not repo.is_absolute():
                raise ValueError(
                    "per_issue concurrency requires an absolute repo_path"
                )
            if not (repo / ".git").exists():
                raise ValueError(
                    f"per_issue concurrency requires a git repo at {workspace.repo_path!r}"
                )
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT payload FROM workspace_profiles WHERE workspace_id = ?",
                (workspace.workspace_id,),
            ).fetchone()
            existing = WorkspaceProfile.from_dict(json.loads(row["payload"])) if row else None
            if existing is not None and existing.concurrency != workspace.concurrency:
                busy = conn.execute(
                    "SELECT COUNT(*) AS n FROM issues WHERE workspace_id = ?"
                    " AND status IN ('in_progress', 'in_review')",
                    (workspace.workspace_id,),
                ).fetchone()["n"]
                held = conn.execute(
                    "SELECT COUNT(*) AS n FROM workspace_locks WHERE workspace_id = ?",
                    (workspace.workspace_id,),
                ).fetchone()["n"]
                if busy or held:
                    raise ValueError(
                        f"cannot change workspace {workspace.workspace_id} concurrency while "
                        f"{busy} issue(s) are mid-claim and {held} lock(s) are held; "
                        "finish or requeue them first"
                    )
            conn.execute(
                "INSERT OR REPLACE INTO workspace_profiles(workspace_id, company_profile_id, payload) VALUES(?, ?, ?)",
                (
                    workspace.workspace_id,
                    workspace.company_profile_id,
                    json.dumps(workspace.to_dict(), ensure_ascii=False),
                ),
            )
        return workspace

    def get_workspace_profile(self, workspace_id: str) -> WorkspaceProfile:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT payload FROM workspace_profiles WHERE workspace_id = ?", (workspace_id,)
            ).fetchone()
        if not row:
            raise KeyError(workspace_id)
        return WorkspaceProfile.from_dict(json.loads(row["payload"]))

    def list_workspace_profiles(self, *, company_profile_id: str | None = None) -> list[WorkspaceProfile]:
        with self._connect() as conn:
            if company_profile_id is None:
                rows = conn.execute("SELECT payload FROM workspace_profiles ORDER BY rowid DESC").fetchall()
            else:
                rows = conn.execute(
                    "SELECT payload FROM workspace_profiles WHERE company_profile_id = ? ORDER BY rowid DESC",
                    (company_profile_id,),
                ).fetchall()
        return [WorkspaceProfile.from_dict(json.loads(row["payload"])) for row in rows]

    def _mutate_workspace_profile(
        self, workspace_id: str, mutate: "Callable[[WorkspaceProfile], Any]"
    ) -> WorkspaceProfile:
        """Atomic read-modify-write of one workspace_profiles row (``BEGIN
        IMMEDIATE``) so a whole-row save can't clobber / be clobbered by a
        concurrent workspace write. ``mutate(profile)`` edits in place; return
        ``False`` to skip the write (idempotent no-op). Raises ``KeyError`` if the
        workspace is gone. The ``company_profile_id`` index column is rewritten
        from the (possibly mutated) profile so it never drifts from the payload.
        """
        assert_writes_allowed("_mutate_workspace_profile")
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT payload FROM workspace_profiles WHERE workspace_id = ?",
                (workspace_id,),
            ).fetchone()
            if not row:
                conn.commit()
                raise KeyError(workspace_id)
            profile = WorkspaceProfile.from_dict(json.loads(row["payload"]))
            if mutate(profile) is False:
                conn.commit()
                return profile
            conn.execute(
                "INSERT OR REPLACE INTO workspace_profiles(workspace_id, company_profile_id, payload) VALUES(?, ?, ?)",
                (
                    profile.workspace_id,
                    profile.company_profile_id,
                    json.dumps(profile.to_dict(), ensure_ascii=False),
                ),
            )
            conn.commit()
            return profile

    def set_workspace_pinned(self, workspace_id: str, pinned: bool, *, now: float | None = None) -> WorkspaceProfile:
        """Pin/unpin a workspace project group to the sidebar's top zone.

        Pinning is a presentation/navigation preference — it never changes trust,
        grouping membership, or the execution boundary. Idempotent: re-pinning
        keeps the original ``pinned_at`` order stamp; unpinning an unpinned
        workspace is a no-op. Raises ``KeyError`` for an unknown workspace.
        """
        stamp = time.time() if now is None else float(now)

        def _m(profile: WorkspaceProfile) -> Any:
            if pinned:
                if profile.pinned_at is not None:
                    return False
                profile.pinned_at = stamp
            else:
                if profile.pinned_at is None:
                    return False
                profile.pinned_at = None

        return self._mutate_workspace_profile(workspace_id, _m)

    def rename_workspace(self, workspace_id: str, new_name: str) -> WorkspaceProfile:
        """Rename a workspace (display name only — never touches the repo path,
        trust, grouping, or execution boundary).

        Validates the name with the SAME rule the create path uses (non-empty
        after trimming) so CLI/API/Web share one rule and can't drift. Raises
        ``ValueError`` for a blank name and ``KeyError`` for an unknown workspace.
        """
        name = new_name.strip()
        if not name:
            raise ValueError("workspace name must not be empty")

        def _m(profile: WorkspaceProfile) -> Any:
            if profile.name == name:
                return False  # idempotent
            profile.name = name

        return self._mutate_workspace_profile(workspace_id, _m)

    def remove_workspace(self, workspace_id: str) -> int:
        """Remove a workspace from the registry (it disappears from every
        surface's project list). The on-disk folder is NEVER touched — this only
        unregisters the project. Returns the number of chat sessions affected.

        The workspace's chat sessions are archived AND unassigned
        (``workspace_id`` cleared) in the SAME atomic transaction as the profile
        delete: archived so they stop cluttering the default list (the chosen
        "remove → archive its conversations" semantics), unassigned so they never
        dangle on a now-deleted workspace id (which would drop them out of the
        personal-sidebar query entirely, including the archived view). They stay
        fully recoverable via the archived view. The built-in Chat workspace is
        the permanent home for pure chats and can never be removed (fail-closed).
        """
        assert_writes_allowed("remove_workspace")
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT payload FROM workspace_profiles WHERE workspace_id = ?",
                (workspace_id,),
            ).fetchone()
            if not row:
                conn.commit()
                raise KeyError(workspace_id)
            profile = WorkspaceProfile.from_dict(json.loads(row["payload"]))
            if profile.metadata.get("builtin") == "chat":
                conn.commit()
                raise ValueError("the built-in Chat workspace cannot be removed")
            # fail-closed governance: this is the personal-sidebar "remove project"
            # twin. A company workspace is an agent execution boundary owned by the
            # Team surface — removing it here would archive Team-run sessions and
            # drop a trust container out from under a company. Refuse it; company
            # workspaces are managed through the company/team surface, not here.
            if profile.company_profile_id != "local":
                conn.commit()
                raise ValueError(
                    f"workspace {workspace_id} belongs to company "
                    f"{profile.company_profile_id}, not the personal namespace; "
                    "remove it via the company/team surface"
                )
            session_rows = conn.execute(
                "SELECT session_id, payload FROM chat_sessions WHERE workspace_id = ?",
                (workspace_id,),
            ).fetchall()
            for session_row in session_rows:
                session = ChatSession.from_dict(json.loads(session_row["payload"]))
                session.archived = True
                session.workspace_id = None
                session.pinned_at = None
                conn.execute(
                    "INSERT OR REPLACE INTO chat_sessions(session_id, payload, workspace_id, archived) VALUES(?, ?, ?, ?)",
                    (
                        session.session_id,
                        json.dumps(session.to_dict(), ensure_ascii=False),
                        None,
                        1,
                    ),
                )
            conn.execute(
                "DELETE FROM workspace_profiles WHERE workspace_id = ?", (workspace_id,)
            )
            conn.commit()
            return len(session_rows)

    # --- Cost tracing: the durable, idempotent ledger ---------------------

    def record_cost_event(self, event: CostEvent) -> bool:
        """Append a cost event idempotently. Returns True if newly inserted.

        Idempotency is keyed on ``idempotency_key`` (UNIQUE): a retried or
        double-counted emit silently no-ops instead of inflating the ledger.

        byo lane only: fill a reference USD estimate from the configured price
        table when the caller did not price the event. relay receipts are
        authoritative (never re-estimated), and an explicit non-zero cost_cents
        is never overwritten. With no price table / an unpriced model the
        estimate is None and cost_cents stays 0 — token counts remain the honest
        source of truth, never a confident zero.
        """
        assert_writes_allowed("record_cost_event")
        if (event.billing_lane or "byo") == "byo" and not event.cost_cents and event.model:
            from superclaw import pricing

            estimate = pricing.estimate_cost_cents(
                event.model,
                input_tokens=event.input_tokens,
                output_tokens=event.output_tokens,
                cached_input_tokens=event.cached_input_tokens,
            )
            if estimate is not None:
                event.cost_cents = int(estimate)
        with self._connect() as conn:
            cur = conn.execute(
                "INSERT OR IGNORE INTO cost_events("
                "event_id, idempotency_key, run_id, chat_session_id, agent_profile_id, "
                "issue_id, company_profile_id, occurred_at, payload) "
                "VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    event.event_id,
                    event.idempotency_key,
                    event.run_id,
                    event.chat_session_id,
                    event.agent_profile_id,
                    event.issue_id,
                    event.company_profile_id,
                    event.occurred_at,
                    json.dumps(event.to_dict(), ensure_ascii=False),
                ),
            )
            return cur.rowcount > 0

    def list_cost_events(
        self,
        *,
        run_id: str | None = None,
        chat_session_id: str | None = None,
        agent_profile_id: str | None = None,
        issue_id: str | None = None,
        company_profile_id: str | None = None,
        since: float | None = None,
        until: float | None = None,
    ) -> list[CostEvent]:
        clauses: list[str] = []
        params: list[Any] = []
        for col, val in (
            ("run_id", run_id),
            ("chat_session_id", chat_session_id),
            ("agent_profile_id", agent_profile_id),
            ("issue_id", issue_id),
            ("company_profile_id", company_profile_id),
        ):
            if val is not None:
                clauses.append(f"{col} = ?")
                params.append(val)
        # Half-open [since, until) window over the indexed occurred_at column so
        # "today"/date-range roll-ups never double-count a boundary instant.
        # A non-finite bound (NaN/Inf) must fail-closed: `occurred_at < NaN`
        # silently matches zero rows in SQLite, which would forge a "zero cost"
        # answer instead of surfacing the bad input.
        for label, bound in (("since", since), ("until", until)):
            if bound is not None and not math.isfinite(float(bound)):
                raise ValueError(f"cost window {label} must be a finite epoch timestamp")
        # An inverted finite window (`until <= since`) would yield an empty set
        # silently — a forged "zero cost" answer. This core method is the ledger's
        # source of truth, so it fails closed on its own, never trusting callers
        # (CLI/API) to have pre-validated the bounds.
        if since is not None and until is not None and float(until) <= float(since):
            raise ValueError("cost window `until` must be strictly after `since`")
        if since is not None:
            clauses.append("occurred_at >= ?")
            params.append(float(since))
        if until is not None:
            clauses.append("occurred_at < ?")
            params.append(float(until))
        where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
        with self._connect() as conn:
            rows = conn.execute(
                f"SELECT payload FROM cost_events{where} ORDER BY occurred_at ASC", tuple(params)
            ).fetchall()
        return [CostEvent.from_dict(json.loads(row["payload"])) for row in rows]

    def max_cost_event_seq(self) -> int:
        """Return the current max insertion sequence (SQLite rowid) in
        cost_events, or 0 if empty. The telemetry spooler snapshots this as a
        per-tick upper bound so a ledger under continuous append can't make a
        single drain loop run forever."""
        with self._connect() as conn:
            row = conn.execute("SELECT COALESCE(MAX(rowid), 0) AS m FROM cost_events").fetchone()
        return int(row["m"])

    def list_cost_events_after_seq(
        self, after_seq: int = 0, *, limit: int | None = None, until_seq: int | None = None
    ) -> list[tuple[int, CostEvent]]:
        """List cost events by monotonic insertion sequence (the SQLite rowid),
        returning ``(seq, event)`` for ``rowid > after_seq`` (and ``rowid <=
        until_seq`` when given) in ascending rowid order. Unlike
        :meth:`list_cost_events` (keyed on the wall-clock
        ``occurred_at``), this is a stable append-only cursor: a row inserted
        later always has a higher seq regardless of its ``occurred_at``, so a
        late/backfilled event is never missed and a future-dated one never
        strands later rows. Used by the telemetry upload spooler. ``INSERT OR
        IGNORE`` (idempotent appends) never reuses a seq, so the cursor is
        monotonic.

        INVARIANT: cost_events is append-only. A ``DELETE`` of the max row would
        let SQLite reuse that rowid on the next insert (no ``AUTOINCREMENT``
        here), and a reused seq below a persisted cursor would be silently
        skipped. This is enforced at the DB layer by the
        ``cost_events_append_only`` BEFORE-DELETE trigger (any delete aborts —
        unbypassable by ORM/string-built SQL), with a source-scan policy test
        (``test_cost_events_is_append_only``) as defence-in-depth for structural
        ops like ``DROP TABLE``. Removing the trigger to allow a delete requires
        redesigning this cursor."""
        sql = "SELECT rowid AS seq, payload FROM cost_events WHERE rowid > ?"
        params: list[Any] = [int(after_seq)]
        if until_seq is not None:
            sql += " AND rowid <= ?"
            params.append(int(until_seq))
        sql += " ORDER BY rowid ASC"
        if limit is not None:
            sql += " LIMIT ?"
            params.append(int(limit))
        with self._connect() as conn:
            rows = conn.execute(sql, tuple(params)).fetchall()
        return [(int(row["seq"]), CostEvent.from_dict(json.loads(row["payload"]))) for row in rows]

    def summarize_cost(
        self,
        *,
        run_id: str | None = None,
        chat_session_id: str | None = None,
        agent_profile_id: str | None = None,
        issue_id: str | None = None,
        company_profile_id: str | None = None,
        since: float | None = None,
        until: float | None = None,
    ) -> dict[str, Any]:
        """Roll up cost events for a scope. Pure aggregation over the ledger."""
        events = self.list_cost_events(
            run_id=run_id,
            chat_session_id=chat_session_id,
            agent_profile_id=agent_profile_id,
            issue_id=issue_id,
            company_profile_id=company_profile_id,
            since=since,
            until=until,
        )
        input_tokens = sum(int(e.input_tokens or 0) for e in events)
        output_tokens = sum(int(e.output_tokens or 0) for e in events)
        cached_tokens = sum(int(e.cached_input_tokens or 0) for e in events)
        duration = sum(float(e.duration_seconds or 0.0) for e in events)
        by_status: dict[str, int] = {}
        by_provider: dict[str, dict[str, Any]] = {}
        by_lane: dict[str, dict[str, Any]] = {}
        # Paperclip-parity money dimensions: spend attributed per agent and per
        # model. cost_cents mixes lanes only inside a row's own total — callers
        # that need the authoritative/estimate split read by_billing_lane.
        by_agent: dict[str, dict[str, Any]] = {}
        by_model: dict[str, dict[str, Any]] = {}

        def _accrue(bucket: dict[str, dict[str, Any]], key: str, e: CostEvent) -> None:
            row = bucket.setdefault(
                key, {"events": 0, "cost_cents": 0, "input_tokens": 0, "output_tokens": 0}
            )
            row["events"] += 1
            row["cost_cents"] += int(e.cost_cents or 0)
            row["input_tokens"] += int(e.input_tokens or 0)
            row["output_tokens"] += int(e.output_tokens or 0)

        for e in events:
            by_status[e.usage_status] = by_status.get(e.usage_status, 0) + 1
            prov = by_provider.setdefault(
                e.provider,
                {"events": 0, "input_tokens": 0, "output_tokens": 0, "duration_seconds": 0.0, "cost_cents": 0},
            )
            prov["events"] += 1
            prov["input_tokens"] += int(e.input_tokens or 0)
            prov["output_tokens"] += int(e.output_tokens or 0)
            prov["duration_seconds"] += float(e.duration_seconds or 0.0)
            prov["cost_cents"] += int(e.cost_cents or 0)
            _accrue(by_agent, e.agent_profile_id or "unassigned", e)
            _accrue(by_model, e.model or "unknown", e)
            # Money lane roll-up: relay cents are authoritative receipts, byo
            # cents are local reference estimates — never blend them silently.
            lane = by_lane.setdefault(
                e.billing_lane or "byo", {"events": 0, "cost_cents": 0, "total_tokens": 0}
            )
            lane["events"] += 1
            lane["cost_cents"] += int(e.cost_cents or 0)
            lane["total_tokens"] += int(e.input_tokens or 0) + int(e.output_tokens or 0)
        return {
            "event_count": len(events),
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "total_tokens": input_tokens + output_tokens,
            "cached_input_tokens": cached_tokens,
            "duration_seconds": duration,
            "usage_status_counts": by_status,
            "by_provider": by_provider,
            "by_agent": by_agent,
            "by_model": by_model,
            "total_cost_cents": sum(int(e.cost_cents or 0) for e in events),
            "by_billing_lane": by_lane,
        }

    def _get_run_in_transaction(self, conn: sqlite3.Connection, run_id: str) -> RunSession:
        row = conn.execute("SELECT payload FROM runs WHERE run_id = ?", (run_id,)).fetchone()
        if not row:
            raise KeyError(run_id)
        return RunSession.from_dict(json.loads(row["payload"]))

    def _save_run_in_transaction(self, conn: sqlite3.Connection, session: RunSession) -> None:
        assert_writes_allowed("_save_run_in_transaction")
        existing = conn.execute("SELECT payload FROM runs WHERE run_id = ?", (session.run_id,)).fetchone()
        if existing:
            previous = RunSession.from_dict(json.loads(existing["payload"]))
            if not is_valid_run_status_transition(previous.status, session.status):
                raise ValueError(f"invalid run status transition: {previous.status} -> {session.status}")
        conn.execute(
            "INSERT OR REPLACE INTO runs(run_id, goal_id, payload) VALUES(?, ?, ?)",
            (session.run_id, session.goal_id, json.dumps(session.to_dict(), ensure_ascii=False)),
        )

    def _add_event_in_transaction(
        self,
        conn: sqlite3.Connection,
        run_id: str,
        event_type: str,
        payload: dict[str, Any],
    ) -> None:
        assert_writes_allowed("_add_event_in_transaction")
        conn.execute(
            "INSERT INTO events(run_id, type, payload) VALUES(?, ?, ?)",
            (run_id, event_type, json.dumps(payload, ensure_ascii=False)),
        )

    # --- Secrets / InstanceSettings（Paperclip 拿取清单 §6，本地 v1） ---------

    def save_secret(self, secret: CompanySecret) -> CompanySecret:
        assert_writes_allowed("save_secret")
        with self._connect() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO company_secrets(secret_id, company_profile_id, name, archived, payload)"
                " VALUES(?, ?, ?, ?, ?)",
                (
                    secret.secret_id,
                    secret.company_profile_id,
                    secret.name,
                    1 if secret.archived else 0,
                    json.dumps(secret.to_dict(), ensure_ascii=False),
                ),
            )
        return secret

    def get_secret(self, secret_id: str) -> CompanySecret:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT payload FROM company_secrets WHERE secret_id = ?", (secret_id,)
            ).fetchone()
        if not row:
            raise KeyError(secret_id)
        return CompanySecret.from_dict(json.loads(row["payload"]))

    def find_secret_by_name(self, name: str, *, company_profile_id: str = "local") -> CompanySecret | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT payload FROM company_secrets WHERE company_profile_id = ? AND name = ?",
                (company_profile_id, name),
            ).fetchone()
        return CompanySecret.from_dict(json.loads(row["payload"])) if row else None

    def list_secrets(self, *, company_profile_id: str | None = None, include_archived: bool = True) -> list[CompanySecret]:
        query = "SELECT payload FROM company_secrets"
        clauses, params = [], []
        if company_profile_id is not None:
            clauses.append("company_profile_id = ?")
            params.append(company_profile_id)
        if not include_archived:
            clauses.append("archived = 0")
        if clauses:
            query += " WHERE " + " AND ".join(clauses)
        query += " ORDER BY name"
        with self._connect() as conn:
            rows = conn.execute(query, params).fetchall()
        return [CompanySecret.from_dict(json.loads(row["payload"])) for row in rows]

    def delete_secret(self, secret_id: str) -> None:
        """Hard delete: ledger row, every version, and every binding. Access
        events are append-only audit and intentionally survive deletion."""
        assert_writes_allowed("delete_secret")
        with self._connect() as conn:
            conn.execute("DELETE FROM company_secrets WHERE secret_id = ?", (secret_id,))
            conn.execute("DELETE FROM company_secret_versions WHERE secret_id = ?", (secret_id,))
            conn.execute("DELETE FROM company_secret_bindings WHERE secret_id = ?", (secret_id,))

    def save_secret_version(self, version: CompanySecretVersion) -> CompanySecretVersion:
        assert_writes_allowed("save_secret_version")
        with self._connect() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO company_secret_versions(secret_id, version, payload) VALUES(?, ?, ?)",
                (version.secret_id, version.version, json.dumps(version.to_dict(), ensure_ascii=False)),
            )
        return version

    def get_secret_version(self, secret_id: str, version: int) -> CompanySecretVersion:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT payload FROM company_secret_versions WHERE secret_id = ? AND version = ?",
                (secret_id, version),
            ).fetchone()
        if not row:
            raise KeyError(f"{secret_id}@v{version}")
        return CompanySecretVersion.from_dict(json.loads(row["payload"]))

    def save_secret_binding(self, binding: CompanySecretBinding) -> CompanySecretBinding:
        assert_writes_allowed("save_secret_binding")
        with self._connect() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO company_secret_bindings("
                "binding_id, secret_id, company_profile_id, target_type, target_id, config_path, payload)"
                " VALUES(?, ?, ?, ?, ?, ?, ?)",
                (
                    binding.binding_id,
                    binding.secret_id,
                    binding.company_profile_id,
                    binding.target_type,
                    binding.target_id,
                    binding.config_path,
                    json.dumps(binding.to_dict(), ensure_ascii=False),
                ),
            )
        return binding

    def delete_secret_binding(self, binding_id: str) -> bool:
        assert_writes_allowed("delete_secret_binding")
        with self._connect() as conn:
            cursor = conn.execute(
                "DELETE FROM company_secret_bindings WHERE binding_id = ?", (binding_id,)
            )
        return cursor.rowcount > 0

    def list_secret_bindings(
        self,
        *,
        secret_id: str | None = None,
        target_type: str | None = None,
        target_id: str | None = None,
        company_profile_id: str | None = None,
    ) -> list[CompanySecretBinding]:
        query = "SELECT payload FROM company_secret_bindings"
        clauses, params = [], []
        if secret_id is not None:
            clauses.append("secret_id = ?")
            params.append(secret_id)
        if target_type is not None:
            clauses.append("target_type = ?")
            params.append(target_type)
        if target_id is not None:
            clauses.append("target_id = ?")
            params.append(target_id)
        if company_profile_id is not None:
            clauses.append("company_profile_id = ?")
            params.append(company_profile_id)
        if clauses:
            query += " WHERE " + " AND ".join(clauses)
        query += " ORDER BY rowid"
        with self._connect() as conn:
            rows = conn.execute(query, params).fetchall()
        return [CompanySecretBinding.from_dict(json.loads(row["payload"])) for row in rows]

    def record_secret_access_event(self, event: SecretAccessEvent) -> SecretAccessEvent:
        assert_writes_allowed("record_secret_access_event")
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO secret_access_events(event_id, secret_id, action, occurred_at, payload)"
                " VALUES(?, ?, ?, ?, ?)",
                (
                    event.event_id,
                    event.secret_id,
                    event.action,
                    event.occurred_at,
                    json.dumps(event.to_dict(), ensure_ascii=False),
                ),
            )
        return event

    def list_secret_access_events(
        self, *, secret_id: str | None = None, limit: int = 100
    ) -> list[SecretAccessEvent]:
        with self._connect() as conn:
            if secret_id is None:
                rows = conn.execute(
                    "SELECT payload FROM secret_access_events ORDER BY occurred_at DESC, rowid DESC LIMIT ?",
                    (max(1, int(limit)),),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT payload FROM secret_access_events WHERE secret_id = ?"
                    " ORDER BY occurred_at DESC, rowid DESC LIMIT ?",
                    (secret_id, max(1, int(limit))),
                ).fetchall()
        return [SecretAccessEvent.from_dict(json.loads(row["payload"])) for row in rows]

    def get_instance_settings(self) -> InstanceSettings:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT payload FROM instance_settings WHERE singleton_key = 'default'"
            ).fetchone()
        return InstanceSettings.from_dict(json.loads(row["payload"])) if row else InstanceSettings()

    def save_instance_settings(self, settings: InstanceSettings) -> InstanceSettings:
        assert_writes_allowed("save_instance_settings")
        with self._connect() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO instance_settings(singleton_key, payload) VALUES('default', ?)",
                (json.dumps(settings.to_dict(), ensure_ascii=False),),
            )
        return settings


def _required_single_line(value: str, *, field: str) -> str:
    if not isinstance(value, str) or not value.strip() or value.strip() != value:
        raise ValueError(f"run mutation lease {field} must be a non-empty trimmed string")
    if "\n" in value or "\r" in value:
        raise ValueError(f"run mutation lease {field} must be a single line")
    return value


def _lease_mismatch_reason(
    lease: RunMutationLease | None,
    *,
    expected_lease_id: str,
    expected_owner: str | None,
    expected_mode: RunMutationMode | None,
) -> str | None:
    if lease is None:
        return "missing active lease"
    if lease.lease_id != expected_lease_id:
        return "lease_id mismatch"
    if expected_owner is not None and lease.owner != expected_owner:
        return "owner mismatch"
    if expected_mode is not None and lease.mode != expected_mode:
        return "mode mismatch"
    return None
