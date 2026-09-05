"""Tests for the heartbeat daemon engine (phase 2 of the daemon pivot).

Positive + fail-closed negative coverage for every gate in the claim sequence,
the coalescing wakeup queue, and one end-to-end acceptance: an enabled agent is
woken by its own timer, claims its assigned todo issue under the workspace
lock, runs as its bound profile, and lands in_review — no human click anywhere.
"""

import json
import os
import socket
import tempfile
from contextlib import contextmanager
from pathlib import Path

import pytest

from superclaw import team_kernel
from superclaw.daemon import (
    DEFAULT_HEARTBEAT_POLICY,
    DaemonBroker,
    HeartbeatDaemon,
    LocalDaemonBrokerIPCClient,
    LocalDaemonBrokerIPCServer,
    LocalDaemonBrokerIPCUnsupportedError,
    LocalDaemonBrokerControl,
    UnixDaemonBrokerIPCPath,
    WindowsNamedPipeDaemonBrokerIPCServer,
    heartbeat_policy,
)
from superclaw.models import (
    AgentProfile,
    AgentWakeupRequest,
    CompanyProfile,
    CostEvent,
    GoalSpec,
    Issue,
    IssueThreadInteraction,
    IssueStatus,
    TeamRoutineSchedule,
    WorkspaceProfile,
)
from superclaw.orchestrator import SuperClawOrchestrator
from superclaw.state import StateStore


@pytest.fixture
def store(tmp_path):
    return StateStore(tmp_path / "state.db")


def make_daemon(store, tmp_path):
    return HeartbeatDaemon(
        store,
        SuperClawOrchestrator(store),
        repo_path=tmp_path,
        artifact_dir=tmp_path / "artifacts",
    )


def enable_master(store):
    """Turn ON the instance heartbeat master switch (fail-closed by default)."""
    settings = store.get_instance_settings()
    settings.general["heartbeat_enabled"] = True
    store.save_instance_settings(settings)


def heartbeat_profile(store, *, enabled=True, interval=300, name="Eng", **kwargs):
    profile = AgentProfile(
        name=name,
        role="engineer",
        backend_policy="local",
        runtime_config={"heartbeat": {"enabled": enabled, "interval_sec": interval}},
        **kwargs,
    )
    store.save_agent_profile(profile)
    return profile


def assigned_issue(store, profile, *, title="Ship login", priority="medium", drain=True):
    issue = Issue(title=title, description="do the work", priority=priority,
                  company_profile_id=profile.company_profile_id,
                  workspace_id=profile.workspace_id)
    store.save_issue(issue)
    assigned = team_kernel.assign_issue(store, issue.issue_id, profile.profile_id)
    if drain:
        # assign_issue emits an assignment wakeup (3b); most daemon tests
        # drive their own wakeups explicitly, so drain it for a clean queue.
        while True:
            wakeup = store.claim_next_wakeup()
            if wakeup is None:
                break
            store.finish_wakeup(wakeup.wakeup_id, status="finished", detail="test-drain")
    return assigned


def seeded_routine(
    store,
    profile,
    *,
    title="Backlog sweep",
    seed_title="Sweep the backlog",
    interval=60,
    next_run_at=100.0,
    context=None,
    **kwargs,
):
    """A routine schedule carrying a proper authored ``issue_seed`` block.

    Mirrors the ``context_snapshot`` shape ``team_routines.author_routine`` →
    ``to_schedule_payload`` produces, so the daemon's claim path materializes a
    real issue from it (the bare ``TeamRoutineSchedule(...)`` shorthand some older
    tests used has no seed and now materializes nothing — correct under the
    Paperclip create_each_run design). ``context`` (per-fire equipment selection)
    is included only when provided, mirroring an authored ``routine.context``."""
    routine_block = {
        "title": title,
        "issue_seed": {
            "title": seed_title,
            "description": "do the scheduled work",
            "priority": "medium",
            "metadata": {},
        },
        "references": {
            "owner_id": "local_user",
            "company_profile_id": profile.company_profile_id,
            "workspace_id": profile.workspace_id,
            "agent_profile_id": profile.profile_id,
        },
    }
    if context is not None:
        routine_block["context"] = context
    schedule = TeamRoutineSchedule(
        agent_profile_id=profile.profile_id,
        company_profile_id=profile.company_profile_id,
        title=title,
        interval_sec=interval,
        next_run_at=next_run_at,
        context_snapshot={"routine": routine_block},
        **kwargs,
    )
    return store.save_team_routine_schedule(schedule)


@contextmanager
def running_broker_ipc(tmp_path, clock):
    if os.name != "posix":
        pytest.skip("Unix-domain socket IPC is POSIX-only")
    with tempfile.TemporaryDirectory(prefix="sclw-ipc-", dir="/tmp") as socket_dir:
        socket_path = Path(socket_dir).resolve() / "broker.sock"
        control = LocalDaemonBrokerControl(
            state_file=tmp_path / "daemon-broker.json",
            temp_root=tmp_path / "broker-sessions",
            clock=lambda: clock["now"],
        )
        server = LocalDaemonBrokerIPCServer(control=control, socket_path=socket_path)
        server.start_in_thread()
        try:
            yield LocalDaemonBrokerIPCClient(socket_path=socket_path), socket_path
        finally:
            server.shutdown()


# --- policy -----------------------------------------------------------------


def test_heartbeat_policy_fail_closed_default():
    profile = AgentProfile(name="Eng", role="engineer")
    policy = heartbeat_policy(profile)
    assert policy == DEFAULT_HEARTBEAT_POLICY
    assert policy["enabled"] is False  # a role is not heartbeat-driven until it opts in


def test_heartbeat_policy_merges_overrides():
    profile = AgentProfile(
        name="Eng", role="engineer",
        runtime_config={"heartbeat": {"enabled": True, "interval_sec": 60, "junk": "ignored"}},
    )
    policy = heartbeat_policy(profile)
    assert policy["enabled"] is True
    assert policy["interval_sec"] == 60
    assert "junk" not in policy
    assert policy["max_concurrent_runs"] == 1


# --- daemon broker primitive -------------------------------------------------


def test_broker_token_metadata_is_audit_safe(tmp_path):
    broker = DaemonBroker(temp_root=tmp_path, clock=lambda: 1000.0)
    session = broker.open_session(subject="agent-a", ttl_seconds=120)
    token, metadata = broker.issue_token(
        session.session_id,
        ["plugin:materialize"],
        ttl_seconds=30,
        subject="agent-a",
    )
    secret = token.rsplit(".", 1)[-1]

    assert broker.validate_token(token, required_scope="plugin:materialize") == metadata
    assert secret not in repr(metadata)
    assert secret not in repr(broker._tokens[metadata.token_id])
    assert secret not in json.dumps(metadata.to_status_payload(), sort_keys=True)
    status = json.dumps(broker.status_payload(), sort_keys=True)
    assert token not in status
    assert secret not in status
    assert "secret_digest" not in status


def test_broker_validation_fails_closed_for_scope_expiry_and_stale_session(tmp_path):
    clock = {"now": 2000.0}
    broker = DaemonBroker(temp_root=tmp_path, clock=lambda: clock["now"])
    session = broker.open_session(ttl_seconds=60)
    token, _metadata = broker.issue_token(
        session.session_id,
        ["plugin:materialize"],
        ttl_seconds=10,
    )

    assert broker.validate_token(token, required_scope="daemon:admin") is None
    clock["now"] = 2011.0
    assert broker.validate_token(token, required_scope="plugin:materialize") is None

    clock["now"] = 2020.0
    stale_token, _metadata = broker.issue_token(
        session.session_id,
        ["plugin:materialize"],
        ttl_seconds=10,
    )
    assert broker.validate_token(stale_token, required_scope="plugin:materialize") is not None
    broker.close_session(session.session_id)
    assert broker.validate_token(stale_token, required_scope="plugin:materialize") is None


def test_broker_materializes_private_governed_plugin_view_and_cleans_up(tmp_path):
    broker = DaemonBroker(temp_root=tmp_path, clock=lambda: 3000.0)
    session = broker.open_session()
    token, _metadata = broker.issue_token(session.session_id, ["plugin:materialize"])

    materialized = broker.materialize_plugin_view(
        token,
        plugin_id="dev.superclaw.sample",
        manifest={
            "version": "1.2.3",
            "runtime": {"type": "mcp_sidecar", "secret": "must-not-leak"},
            "tools": [{"name": "scan", "api_key": "must-not-leak"}],
        },
        files={"skills/scan.md": "# Scan\n"},
    )

    assert materialized.path.exists()
    assert materialized.file_count == 2
    assert materialized.path.stat().st_mode & 0o777 == 0o700
    manifest = json.loads((materialized.path / "superclaw-plugin.json").read_text())
    assert manifest["governance"] == {"source": "daemon_broker", "materialized": True}
    assert manifest["runtime"] == {"type": "mcp_sidecar"}
    assert manifest["tools"] == [{"name": "scan"}]
    assert "must-not-leak" not in json.dumps(materialized.to_status_payload())

    broker.close_session(session.session_id)
    assert not materialized.path.exists()
    assert broker.validate_token(token, required_scope="plugin:materialize") is None


def test_broker_reaps_expired_session_materializations(tmp_path):
    clock = {"now": 3500.0}
    broker = DaemonBroker(temp_root=tmp_path, clock=lambda: clock["now"])
    session = broker.open_session(ttl_seconds=5)
    token, metadata = broker.issue_token(session.session_id, ["plugin:materialize"])
    materialized = broker.materialize_plugin_view(
        token,
        plugin_id="dev.superclaw.expiring",
        manifest={"version": "1.0.0"},
    )
    assert materialized.path.exists()

    clock["now"] = 3506.0
    assert broker.validate_token(token, required_scope="plugin:materialize") is None
    assert not materialized.path.exists()
    assert metadata.token_id not in broker._tokens
    assert session.session_id not in broker._sessions
    assert broker.status_payload() == {"sessions": [], "tokens": [], "materializations": []}


def test_broker_materialization_rejects_unsafe_paths(tmp_path):
    broker = DaemonBroker(temp_root=tmp_path, clock=lambda: 4000.0)
    session = broker.open_session()
    token, _metadata = broker.issue_token(session.session_id, ["plugin:materialize"])

    for path in ("../escape.md", "/tmp/escape.md", "skills/../escape.md", ""):
        with pytest.raises(ValueError):
            broker.materialize_plugin_view(
                token,
                plugin_id="dev.superclaw.safe",
                manifest={"version": "1.0.0"},
                files={path: "blocked"},
            )

    with pytest.raises(ValueError):
        broker.materialize_plugin_view(
            token,
            plugin_id="../unsafe",
            manifest={"version": "1.0.0"},
        )
    assert broker.status_payload()["materializations"] == []


def test_local_broker_control_persists_without_secret_leakage_and_cleans_up(tmp_path):
    clock = {"now": 5000.0}
    state_file = tmp_path / "daemon-broker.json"
    temp_root = tmp_path / "broker-sessions"
    control = LocalDaemonBrokerControl(
        state_file=state_file,
        temp_root=temp_root,
        clock=lambda: clock["now"],
    )
    session = control.open_session(subject="cli", ttl_seconds=120)
    token, metadata = control.issue_token(
        session.session_id,
        ["plugin:materialize"],
        ttl_seconds=60,
        subject="cli",
    )
    secret = token.rsplit(".", 1)[-1]

    reloaded = LocalDaemonBrokerControl(
        state_file=state_file,
        temp_root=temp_root,
        clock=lambda: clock["now"],
    )
    assert reloaded.validate_token(token, required_scope="plugin:materialize") == metadata
    assert state_file.stat().st_mode & 0o777 == 0o600
    assert temp_root.stat().st_mode & 0o777 == 0o700
    state_text = state_file.read_text(encoding="utf-8")
    assert token not in state_text
    assert secret not in state_text

    materialized = reloaded.materialize_plugin_view(
        token,
        plugin_id="dev.superclaw.local-control",
        manifest={
            "version": "1.0.0",
            "runtime": {"type": "mcp_sidecar", "secret": "must-not-leak"},
        },
        files={"skills/run.md": "# Run\n"},
    )
    manifest_path = materialized.path / "superclaw-plugin.json"
    assert materialized.path.stat().st_mode & 0o777 == 0o700
    assert manifest_path.stat().st_mode & 0o777 == 0o600
    assert (materialized.path / "skills" / "run.md").stat().st_mode & 0o777 == 0o600

    status = json.dumps(reloaded.status_payload(), sort_keys=True)
    assert token not in status
    assert secret not in status
    assert "secret_digest" not in status
    assert "must-not-leak" not in (materialized.path / "superclaw-plugin.json").read_text(encoding="utf-8")

    reloaded.close_session(session.session_id)
    assert not materialized.path.exists()
    assert reloaded.validate_token(token, required_scope="plugin:materialize") is None


def test_local_broker_control_rejects_unsafe_persisted_materialization_path(tmp_path):
    state_file = tmp_path / "daemon-broker.json"
    temp_root = tmp_path / "broker-sessions"
    control = LocalDaemonBrokerControl(state_file=state_file, temp_root=temp_root, clock=lambda: 6000.0)
    session = control.open_session()
    payload = json.loads(state_file.read_text(encoding="utf-8"))
    payload["sessions"][0]["materializations"] = [
        {
            "materialization_id": "broker_mat_tampered",
            "session_id": session.session_id,
            "plugin_id": "dev.superclaw.tampered",
            "path": str(tmp_path / "outside"),
            "created_at": 6000.0,
            "file_count": 1,
        }
    ]
    state_file.write_text(json.dumps(payload), encoding="utf-8")

    with pytest.raises(ValueError, match="unsafe materialization path"):
        control.status_payload()


# --- daemon broker IPC -------------------------------------------------------


def test_local_broker_ipc_unix_socket_lifecycle_is_audit_safe(tmp_path):
    clock = {"now": 7000.0}
    with running_broker_ipc(tmp_path, clock) as (client, socket_path):
        created = client.request(
            {
                "id": "create-1",
                "action": "create",
                "payload": {"subject": "ipc", "ttl_seconds": 120},
            }
        )
        assert created["ok"] is True and created["id"] == "create-1"
        session = created["session"]

        issued = client.request(
            {
                "action": "issue_token",
                "session_id": session["session_id"],
                "scopes": ["plugin:materialize"],
                "ttl_seconds": 60,
                "subject": "ipc",
            }
        )
        token = issued["token"]
        secret = token.rsplit(".", 1)[-1]
        assert issued["metadata"]["session_id"] == session["session_id"]

        validated = client.request(
            {"action": "validate", "token": token, "required_scope": "plugin:materialize"}
        )
        assert validated["metadata"]["session_id"] == session["session_id"]

        listed = client.request({"action": "list"})
        assert listed["sessions"] == [session]

        materialized = client.request(
            {
                "action": "materialize",
                "token": token,
                "plugin_id": "dev.superclaw.ipc",
                "manifest": {
                    "version": "1.0.0",
                    "runtime": {"type": "mcp_sidecar", "secret": "must-not-leak"},
                    "tools": [{"name": "scan", "api_key": "must-not-leak"}],
                },
                "files": {"skills/scan.md": "# Scan\n"},
            }
        )
        assert materialized["ok"] is True
        materialized_payload = json.dumps(materialized, sort_keys=True)
        assert token not in materialized_payload
        assert secret not in materialized_payload
        assert "secret_digest" not in materialized_payload
        materialized_path = Path(materialized["materialization"]["path"])
        assert materialized_path.exists()

        status = client.request({"action": "status"})["status"]
        status_payload = json.dumps(status, sort_keys=True)
        assert len(status["sessions"]) == 1
        assert len(status["tokens"]) == 1
        assert len(status["materializations"]) == 1
        assert token not in status_payload
        assert secret not in status_payload
        assert "secret_digest" not in status_payload
        assert "must-not-leak" not in (
            materialized_path / "superclaw-plugin.json"
        ).read_text(encoding="utf-8")

        closed = client.request(
            {"action": "close_session", "session_id": session["session_id"]}
        )
        assert closed == {"ok": True, "closed": True, "session_id": session["session_id"]}
        assert not materialized_path.exists()
    assert not socket_path.exists()


def test_local_broker_ipc_fail_closed_for_bad_requests_and_tokens(tmp_path):
    clock = {"now": 8000.0}
    with running_broker_ipc(tmp_path, clock) as (client, socket_path):
        assert client.request_raw(b"{not json}\n")["error"]["code"] == "invalid_json"
        assert client.request({"action": "unknown"})["error"]["code"] == "unsupported_action"

        raw = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        raw.connect(str(socket_path))
        raw.close()
        assert client.request({"action": "status"})["ok"] is True

        session = client.request(
            {"action": "open_session", "subject": "ipc", "ttl_seconds": 30}
        )["session"]
        wrong_scope = client.request(
            {
                "action": "issue_token",
                "session_id": session["session_id"],
                "scopes": ["daemon:admin"],
                "ttl_seconds": 20,
            }
        )["token"]
        denied = client.request(
            {
                "action": "materialize_plugin_view",
                "token": wrong_scope,
                "plugin_id": "dev.superclaw.denied",
                "manifest": {"version": "1.0.0"},
            }
        )
        assert denied["ok"] is False
        assert denied["error"]["code"] == "permission_denied"
        assert wrong_scope not in json.dumps(denied, sort_keys=True)

        token = client.request(
            {
                "action": "issue_token",
                "session_id": session["session_id"],
                "scopes": ["plugin:materialize"],
                "ttl_seconds": 5,
            }
        )["token"]
        clock["now"] = 8006.0
        expired = client.request(
            {
                "action": "materialize",
                "token": token,
                "plugin_id": "dev.superclaw.expired",
                "manifest": {"version": "1.0.0"},
            }
        )
        assert expired["ok"] is False
        assert expired["error"]["code"] == "permission_denied"
        expired_validate = client.request(
            {"action": "validate_token", "token": token, "required_scope": "plugin:materialize"}
        )
        assert expired_validate == {"ok": True, "metadata": None}

        clock["now"] = 8010.0
        stale_session = client.request({"action": "open_session", "ttl_seconds": 30})[
            "session"
        ]
        stale_token = client.request(
            {
                "action": "issue_token",
                "session_id": stale_session["session_id"],
                "scopes": ["plugin:materialize"],
                "ttl_seconds": 10,
            }
        )["token"]
        client.request({"action": "close_session", "session_id": stale_session["session_id"]})
        stale = client.request(
            {
                "action": "materialize",
                "token": stale_token,
                "plugin_id": "dev.superclaw.stale",
                "manifest": {"version": "1.0.0"},
            }
        )
        assert stale["ok"] is False
        assert stale["error"]["code"] == "permission_denied"

        valid_session = client.request({"action": "open_session", "ttl_seconds": 30})[
            "session"
        ]
        valid_token = client.request(
            {
                "action": "issue_token",
                "session_id": valid_session["session_id"],
                "scopes": ["plugin:materialize"],
                "ttl_seconds": 10,
            }
        )["token"]
        unsafe_file = client.request(
            {
                "action": "materialize",
                "token": valid_token,
                "plugin_id": "dev.superclaw.safe",
                "manifest": {"version": "1.0.0"},
                "files": {"../escape.md": "blocked"},
            }
        )
        assert unsafe_file["ok"] is False
        assert unsafe_file["error"]["code"] == "invalid_request"
        assert client.request({"action": "status"})["status"]["materializations"] == []


def test_local_broker_ipc_socket_path_safety_and_platform_boundary(tmp_path):
    clock = {"now": 9000.0}
    control = LocalDaemonBrokerControl(
        state_file=tmp_path / "daemon-broker.json",
        temp_root=tmp_path / "broker-sessions",
        clock=lambda: clock["now"],
    )

    with pytest.raises(ValueError, match="absolute"):
        LocalDaemonBrokerIPCServer(
            control=control, socket_path=Path("relative.sock")
        ).start_in_thread()

    unsafe_parent = tmp_path / "unsafe"
    unsafe_parent.mkdir()
    os.chmod(unsafe_parent, 0o777)
    try:
        with pytest.raises(ValueError, match="group/world writable"):
            UnixDaemonBrokerIPCPath(unsafe_parent / "broker.sock").prepare_for_bind()
    finally:
        os.chmod(unsafe_parent, 0o700)

    symlink_parent = tmp_path / "symlink-parent"
    symlink_parent.symlink_to(tmp_path, target_is_directory=True)
    with pytest.raises(ValueError, match="unsafe"):
        UnixDaemonBrokerIPCPath(symlink_parent / "broker.sock").prepare_for_bind()

    with pytest.raises(LocalDaemonBrokerIPCUnsupportedError, match="not implemented"):
        WindowsNamedPipeDaemonBrokerIPCServer().serve_forever()


# --- timer scheduling ---------------------------------------------------------


def test_tick_enqueues_due_agents_only(store, tmp_path):
    daemon = make_daemon(store, tmp_path)
    enable_master(store)
    due = heartbeat_profile(store, name="Due", interval=100)
    heartbeat_profile(store, name="Disabled", enabled=False)
    not_due = heartbeat_profile(store, name="NotDue", interval=10_000)

    enqueued = daemon.tick_timers(now=due.created_at + 200)
    agents = {w.agent_profile_id for w in enqueued}
    assert due.profile_id in agents
    assert not_due.profile_id not in agents
    assert len(enqueued) == 1


def test_tick_moves_watermark_no_thundering_herd(store, tmp_path):
    daemon = make_daemon(store, tmp_path)
    enable_master(store)
    profile = heartbeat_profile(store, interval=100)
    first = daemon.tick_timers(now=profile.created_at + 150)
    assert len(first) == 1
    # Immediately re-ticking must not enqueue again — the watermark moved.
    second = daemon.tick_timers(now=profile.created_at + 151)
    assert second == []


def test_tick_master_switch_off_explicit(store, tmp_path):
    daemon = make_daemon(store, tmp_path)
    profile = heartbeat_profile(store, interval=10)
    settings = store.get_instance_settings()
    settings.general["heartbeat_enabled"] = False
    store.save_instance_settings(settings)
    assert daemon.tick_timers(now=profile.created_at + 100) == []


def test_tick_master_switch_fail_closed_by_default(store, tmp_path):
    """A fresh instance (no instance_settings) must NOT run the timer scheduler."""
    daemon = make_daemon(store, tmp_path)
    profile = heartbeat_profile(store, interval=10)
    assert daemon.heartbeats_enabled() is False
    assert daemon.tick_timers(now=profile.created_at + 100) == []  # fail-closed
    # Explicit opt-in flips it on.
    enable_master(store)
    assert daemon.heartbeats_enabled() is True
    assert len(daemon.tick_timers(now=profile.created_at + 100)) == 1


def test_heartbeats_enabled_fails_closed_on_store_error(store, tmp_path):
    daemon = make_daemon(store, tmp_path)

    def _boom():
        raise RuntimeError("settings store unreadable")

    daemon.store.get_instance_settings = _boom  # type: ignore[assignment]
    assert daemon.heartbeats_enabled() is False  # never enable on a broken store


# --- queue semantics ----------------------------------------------------------


def test_enqueue_coalesces_same_idempotency_key(store):
    a, coalesced_a = store.enqueue_wakeup(
        AgentWakeupRequest(agent_profile_id="agent_x", idempotency_key="k")
    )
    b, coalesced_b = store.enqueue_wakeup(
        AgentWakeupRequest(agent_profile_id="agent_x", idempotency_key="k")
    )
    assert coalesced_a is False and coalesced_b is True
    assert b.wakeup_id == a.wakeup_id
    assert b.coalesced_count == 1


def test_enqueue_coalesces_onto_existing_queued_wakeup(store):
    a, _ = store.enqueue_wakeup(AgentWakeupRequest(agent_profile_id="agent_x"))
    b, coalesced = store.enqueue_wakeup(AgentWakeupRequest(agent_profile_id="agent_x"))
    assert coalesced is True and b.wakeup_id == a.wakeup_id
    # A different agent still gets its own row.
    c, coalesced_c = store.enqueue_wakeup(AgentWakeupRequest(agent_profile_id="agent_y"))
    assert coalesced_c is False and c.wakeup_id != a.wakeup_id


def test_claim_and_finish_lifecycle(store):
    store.enqueue_wakeup(AgentWakeupRequest(agent_profile_id="agent_x"))
    claimed = store.claim_next_wakeup()
    assert claimed is not None and claimed.status == "claimed"
    assert store.claim_next_wakeup() is None  # queue drained
    done = store.finish_wakeup(claimed.wakeup_id, status="finished", detail="idle")
    assert done.status == "finished" and done.detail == "idle"
    with pytest.raises(ValueError):
        store.finish_wakeup(claimed.wakeup_id, status="queued")


# --- claim gates (each one fail-closed and durable) -----------------------------


def _service_skipped(daemon, detail_prefix):
    outcome = daemon.service_once()
    assert outcome is not None and outcome.status == "skipped"
    assert outcome.detail.startswith(detail_prefix)
    return outcome


def test_gate_profile_missing(store, tmp_path):
    daemon = make_daemon(store, tmp_path)
    store.enqueue_wakeup(AgentWakeupRequest(agent_profile_id="agent_ghost"))
    _service_skipped(daemon, "profile_missing")


def test_gate_timer_wake_for_disabled_heartbeat(store, tmp_path):
    daemon = make_daemon(store, tmp_path)
    profile = heartbeat_profile(store, enabled=False)
    store.enqueue_wakeup(
        AgentWakeupRequest(agent_profile_id=profile.profile_id, source="timer")
    )
    _service_skipped(daemon, "heartbeat_disabled")


def test_gate_event_wake_respects_wake_on_demand(store, tmp_path):
    daemon = make_daemon(store, tmp_path)
    profile = AgentProfile(
        name="Eng", role="engineer",
        runtime_config={"heartbeat": {"enabled": True, "wake_on_demand": False}},
    )
    store.save_agent_profile(profile)
    store.enqueue_wakeup(
        AgentWakeupRequest(agent_profile_id=profile.profile_id, source="assignment")
    )
    _service_skipped(daemon, "wake_on_demand_disabled")


def test_gate_budget_hard_stop_blocks_before_spend(store, tmp_path):
    daemon = make_daemon(store, tmp_path)
    profile = heartbeat_profile(store, token_budget=100)
    store.record_cost_event(
        CostEvent(idempotency_key="k", agent_profile_id=profile.profile_id,
                  input_tokens=80, output_tokens=40)
    )
    assigned_issue(store, profile)
    store.enqueue_wakeup(AgentWakeupRequest(agent_profile_id=profile.profile_id))
    outcome = _service_skipped(daemon, "budget_exceeded:tokens")
    # The issue was never touched: still todo, no run started.
    issues = store.list_issues()
    assert issues[0].status == IssueStatus.TODO.value
    assert outcome.run_id is None


def test_gate_idle_wake_finishes_cleanly(store, tmp_path):
    daemon = make_daemon(store, tmp_path)
    profile = heartbeat_profile(store)
    store.enqueue_wakeup(AgentWakeupRequest(agent_profile_id=profile.profile_id))
    outcome = daemon.service_once()
    assert outcome.status == "finished" and outcome.detail == "idle"


def test_gate_workspace_lock_skips_and_leaves_issue_todo(store, tmp_path):
    daemon = make_daemon(store, tmp_path)
    profile = heartbeat_profile(store)
    issue = assigned_issue(store, profile)
    # Another holder owns the workspace.
    store.acquire_workspace_lock(
        team_kernel.workspace_lock_key(issue), workspace_id=issue.workspace_id,
        holder="someone-else", issue_id="other", run_id="other-run",
    )
    store.enqueue_wakeup(AgentWakeupRequest(agent_profile_id=profile.profile_id))
    _service_skipped(daemon, "workspace_locked")
    assert store.get_issue(issue.issue_id).status == IssueStatus.TODO.value


def test_service_empty_queue_returns_none(store, tmp_path):
    assert make_daemon(store, tmp_path).service_once() is None


# --- end-to-end acceptance: the company works while no one clicks ----------------


def test_heartbeat_drives_issue_to_review_unattended(store, tmp_path):
    daemon = make_daemon(store, tmp_path)
    enable_master(store)
    profile = heartbeat_profile(store, interval=100)
    issue = assigned_issue(store, profile)

    # Timer fires (no human enqueues anything)...
    enqueued = daemon.tick_timers(now=profile.created_at + 200)
    assert len(enqueued) == 1
    # ...the daemon services the wakeup end to end.
    outcome = daemon.service_once()
    assert outcome.status == "finished"
    assert outcome.detail.endswith("submitted_for_review")
    assert outcome.run_id

    refreshed = store.get_issue(issue.issue_id)
    assert refreshed.status == IssueStatus.IN_REVIEW.value
    assert refreshed.execution_run_id == outcome.run_id
    # The human gate is open — completion still cannot be self-served.
    approvals = store.list_approvals(status="pending")
    assert any(a.issue_id == issue.issue_id for a in approvals)
    # The run was bound to the profile and anchored to the issue.
    run = store.get_run(outcome.run_id)
    assert run.execution_context["agent_profile_id"] == profile.profile_id
    assert run.execution_context["issue_id"] == issue.issue_id
    # Session continuity layers persisted.
    runtime = store.get_agent_runtime_state(profile.profile_id)
    assert runtime.last_run_id == outcome.run_id
    task_session = store.get_agent_task_session(profile.profile_id, issue.issue_id)
    assert task_session.last_run_id == outcome.run_id
    # Cost ledger has rows for the run (local backend → wall-clock meter).
    assert store.summarize_cost(run_id=outcome.run_id)["event_count"] >= 1
    # The wakeup row is terminal with a durable trace.
    wakeups = store.list_wakeups(agent_profile_id=profile.profile_id)
    assert wakeups and wakeups[0].status == "finished"


# --- CLI surface (same kernel, observation only) -------------------------------


def test_cli_daemon_tick_and_status(tmp_path, monkeypatch):
    from typer.testing import CliRunner

    from superclaw.cli import app

    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    runner = CliRunner()

    store = StateStore(tmp_path / "state.db")
    enable_master(store)
    profile = heartbeat_profile(store, interval=1)
    assigned_issue(store, profile)

    import json as _json
    import time as _time

    _time.sleep(1.1)  # let the interval elapse against created_at
    result = runner.invoke(
        app, ["daemon", "tick", "--repo", str(tmp_path), "--artifact-dir", str(tmp_path / "a")]
    )
    assert result.exit_code == 0, result.output
    payload = _json.loads(result.output)
    assert payload["enqueued"] == 1
    assert payload["serviced"][0]["status"] == "finished"
    assert payload["serviced"][0]["detail"].endswith("submitted_for_review")

    status = runner.invoke(app, ["daemon", "status"])
    assert status.exit_code == 0
    status_payload = _json.loads(status.output)
    assert status_payload["running"] is False
    # 2 finished rows: the drained assignment wakeup (helper) + the serviced tick.
    assert status_payload["wakeups"]["finished"] == 2


# --- advisor-driven hardening (round 2) ----------------------------------------


class _StubResult:
    def __init__(self, run_id, status):
        import types

        self.session = types.SimpleNamespace(run_id=run_id, status=status)


class _StubOrchestrator:
    """Minimal orchestrator double: scripted run outcomes, no real execution."""

    def __init__(self, status="completed", error=None):
        self.status = status
        self.error = error
        self.calls = 0

    def run_goal(self, **kwargs):
        self.calls += 1
        if self.error is not None:
            raise self.error
        return _StubResult("run_stub_1", self.status)

    def reconcile_stale_runs(self, **kwargs):
        return []


def test_waiting_human_gate_is_not_submitted_for_review(store, tmp_path):
    daemon = HeartbeatDaemon(store, _StubOrchestrator(status="WAITING_FOR_HUMAN_GATE"),
                             repo_path=tmp_path, artifact_dir=tmp_path / "a")
    profile = heartbeat_profile(store)
    issue = assigned_issue(store, profile)
    store.enqueue_wakeup(AgentWakeupRequest(agent_profile_id=profile.profile_id))
    outcome = daemon.service_once()
    assert outcome.status == "finished"
    assert outcome.detail.endswith("waiting_human_gate")
    # The run's own pending gate is NOT delivered work: no completion approval,
    # the issue stays in_progress under its lock.
    assert store.get_issue(issue.issue_id).status == IssueStatus.IN_PROGRESS.value
    assert not [a for a in store.list_approvals(status="pending") if a.issue_id == issue.issue_id]


def test_human_gated_run_counts_as_a_live_run(store, tmp_path):
    # A run parked at the human gate still OCCUPIES its issue. The rework loop
    # must NOT treat it as crashed and spawn a second executor (which would race
    # the operator and bypass the gate). Boundary: a terminal run frees the issue.
    from superclaw.models import GoalSpec

    daemon = make_daemon(store, tmp_path)
    profile = heartbeat_profile(store)
    issue = assigned_issue(store, profile)

    goal = store.create_goal(GoalSpec(title="x", description="y"))
    run = store.create_run(goal.goal_id)
    # Walk a valid transition path into the gate (created -> queued -> waiting).
    for status in ("queued", "WAITING_FOR_HUMAN_GATE"):
        run.status = status
        store.save_run(run)
    issue.execution_run_id = run.run_id

    assert daemon._issue_has_live_run(issue) is True, "human-gated run must read as live"

    run.status = "completed"  # gate -> completed is a valid terminal transition
    store.save_run(run)
    assert daemon._issue_has_live_run(issue) is False, "terminal run must free the issue"


def test_run_error_without_run_unwinds_the_claim(store, tmp_path):
    daemon = HeartbeatDaemon(store, _StubOrchestrator(error=RuntimeError("backend exploded")),
                             repo_path=tmp_path, artifact_dir=tmp_path / "a")
    profile = heartbeat_profile(store)
    issue = assigned_issue(store, profile)
    store.enqueue_wakeup(AgentWakeupRequest(agent_profile_id=profile.profile_id))
    outcome = daemon.service_once()
    assert outcome.status == "skipped" and outcome.detail.startswith("run_error")
    # No run anchor exists, so the claim must unwind: issue back to todo and
    # the workspace immediately claimable again (no orphan lock deadlock).
    assert store.get_issue(issue.issue_id).status == IssueStatus.TODO.value
    team_kernel.checkout_issue(store, issue.issue_id, run_id="reclaim-ok")


def test_agent_claim_lock_defers_concurrent_wake(store, tmp_path):
    daemon = make_daemon(store, tmp_path)
    profile = heartbeat_profile(store)
    assigned_issue(store, profile)
    # Another process (simulated) holds this agent's claim lock.
    store.acquire_workspace_lock(
        f"agent:{profile.profile_id}", workspace_id=profile.workspace_id,
        holder="other-daemon", run_id="other",
    )
    store.enqueue_wakeup(AgentWakeupRequest(agent_profile_id=profile.profile_id))
    outcome = daemon.service_once()
    assert outcome.status == "skipped"
    assert outcome.detail == "agent_busy:deferred"
    # The wake did not evaporate: a retry row exists, invisible until backoff.
    import time as _time

    now = _time.time()
    retries = [w for w in store.list_wakeups(agent_profile_id=profile.profile_id, status="queued")]
    assert len(retries) == 1 and retries[0].reason == "retry:agent_busy"
    assert store.claim_next_wakeup(now=now) is None  # not visible yet
    visible = store.claim_next_wakeup(now=now + daemon.retry_backoff_seconds + 1)
    assert visible is not None and visible.wakeup_id == retries[0].wakeup_id


def test_workspace_locked_defers_with_retry_row(store, tmp_path):
    daemon = make_daemon(store, tmp_path)
    profile = heartbeat_profile(store)
    issue = assigned_issue(store, profile)
    store.acquire_workspace_lock(
        team_kernel.workspace_lock_key(issue), workspace_id=issue.workspace_id,
        holder="someone-else", issue_id="other", run_id="other-run",
    )
    store.enqueue_wakeup(AgentWakeupRequest(agent_profile_id=profile.profile_id))
    outcome = daemon.service_once()
    assert outcome.detail == "workspace_locked:deferred"
    assert len(store.list_wakeups(agent_profile_id=profile.profile_id, status="queued")) == 1


def test_idempotency_key_reusable_after_terminal_state(store):
    store.enqueue_wakeup(AgentWakeupRequest(agent_profile_id="agent_x", idempotency_key="k"))
    claimed = store.claim_next_wakeup()
    store.finish_wakeup(claimed.wakeup_id, status="finished")
    # The same trigger firing again must re-queue, not vanish into history.
    again, coalesced = store.enqueue_wakeup(
        AgentWakeupRequest(agent_profile_id="agent_x", idempotency_key="k")
    )
    assert coalesced is False and again.wakeup_id != claimed.wakeup_id


def test_different_sources_never_coalesce(store):
    timer, _ = store.enqueue_wakeup(
        AgentWakeupRequest(agent_profile_id="agent_x", source="timer")
    )
    assignment, coalesced = store.enqueue_wakeup(
        AgentWakeupRequest(agent_profile_id="agent_x", source="assignment",
                           context_snapshot={"issue_id": "issue_9"})
    )
    assert coalesced is False and assignment.wakeup_id != timer.wakeup_id


def test_coalesced_context_stays_auditable(store):
    store.enqueue_wakeup(
        AgentWakeupRequest(agent_profile_id="agent_x", source="assignment",
                           context_snapshot={"issue_id": "issue_1"})
    )
    merged, coalesced = store.enqueue_wakeup(
        AgentWakeupRequest(agent_profile_id="agent_x", source="assignment",
                           reason="issue_assigned:issue_2",
                           context_snapshot={"issue_id": "issue_2"})
    )
    assert coalesced is True
    absorbed = merged.context_snapshot["absorbed"]
    assert absorbed[0]["snapshot"]["issue_id"] == "issue_2"


# --- routine schedules --------------------------------------------------------


def test_routine_schedule_save_is_idempotent_by_definition_key(store):
    profile = heartbeat_profile(store)
    first, coalesced_first = store.save_team_routine_schedule(
        TeamRoutineSchedule(
            agent_profile_id=profile.profile_id,
            company_profile_id=profile.company_profile_id,
            title="Daily triage",
            interval_sec=3600,
            next_run_at=100.0,
            idempotency_key=f"routine:{profile.profile_id}:daily-triage",
        )
    )
    second, coalesced_second = store.save_team_routine_schedule(
        TeamRoutineSchedule(
            agent_profile_id=profile.profile_id,
            company_profile_id=profile.company_profile_id,
            title="Daily triage duplicate",
            interval_sec=3600,
            next_run_at=100.0,
            idempotency_key=f"routine:{profile.profile_id}:daily-triage",
        )
    )

    assert coalesced_first is False
    assert coalesced_second is True
    assert second.routine_id == first.routine_id
    assert len(store.list_team_routine_schedules(agent_profile_id=profile.profile_id)) == 1


def test_routine_schedule_save_rejects_invalid_definition(store):
    profile = heartbeat_profile(store)

    with pytest.raises(ValueError, match="at least 60 seconds"):
        store.save_team_routine_schedule(
            TeamRoutineSchedule(
                agent_profile_id=profile.profile_id,
                company_profile_id=profile.company_profile_id,
                title="Too fast",
                interval_sec=1,
                next_run_at=100.0,
            )
        )


def test_due_routine_claim_materializes_issue_and_queues_one_wakeup(store, tmp_path):
    daemon = make_daemon(store, tmp_path)
    enable_master(store)
    profile = heartbeat_profile(store)
    routine, _ = seeded_routine(
        store,
        profile,
        seed_title="Sweep the backlog",
        idempotency_key=f"routine:{profile.profile_id}:backlog-sweep",
    )

    claimed = daemon.tick_scheduled_triggers(now=100.0)
    duplicate = daemon.tick_scheduled_triggers(now=100.0)

    assert len(claimed) == 1
    assert duplicate == []  # slot already advanced — exactly once per due slot
    wakeup = claimed[0]
    assert wakeup.source == "routine"
    assert wakeup.context_snapshot["routine_id"] == routine.routine_id
    # Directed wake binds THIS fire's wakeup to the fresh issue it materialized.
    issue_id = wakeup.context_snapshot["issue_id"]
    materialized = store.get_issue(issue_id)
    assert materialized.title == "Sweep the backlog"
    assert materialized.status == IssueStatus.TODO.value
    assert materialized.assignee_agent_profile_id == profile.profile_id
    assert materialized.origin_kind == "automation"
    assert materialized.metadata["routine_id"] == routine.routine_id
    refreshed = store.get_team_routine_schedule(routine.routine_id)
    assert refreshed.claim_count == 1
    assert refreshed.next_run_at == 160.0
    assert len(store.list_wakeups(agent_profile_id=profile.profile_id, status="queued")) == 1
    # The fresh issue is the ONLY one materialized for this routine (exactly once).
    routine_issues = [
        i
        for i in store.list_issues(company_profile_id=profile.company_profile_id)
        if i.metadata.get("routine_id") == routine.routine_id
    ]
    assert len(routine_issues) == 1


def test_routine_tick_master_switch_fail_closed_by_default(store, tmp_path):
    daemon = make_daemon(store, tmp_path)
    profile = heartbeat_profile(store)
    store.save_team_routine_schedule(
        TeamRoutineSchedule(
            agent_profile_id=profile.profile_id,
            company_profile_id=profile.company_profile_id,
            title="Backlog sweep",
            interval_sec=60,
            next_run_at=100.0,
        )
    )

    assert daemon.tick_scheduled_triggers(now=100.0) == []
    assert store.list_wakeups(agent_profile_id=profile.profile_id, status="queued") == []


def test_disabled_routine_schedule_is_not_claimed(store, tmp_path):
    daemon = make_daemon(store, tmp_path)
    enable_master(store)
    profile = heartbeat_profile(store)
    store.save_team_routine_schedule(
        TeamRoutineSchedule(
            agent_profile_id=profile.profile_id,
            company_profile_id=profile.company_profile_id,
            title="Disabled sweep",
            interval_sec=60,
            next_run_at=100.0,
            enabled=False,
        )
    )

    assert daemon.tick_scheduled_triggers(now=100.0) == []
    assert store.list_wakeups(agent_profile_id=profile.profile_id, status="queued") == []


def test_routine_fire_materializes_and_runs_its_own_issue(store, tmp_path):
    enable_master(store)
    profile = heartbeat_profile(store)
    seeded_routine(store, profile, seed_title="Nightly report")
    daemon = HeartbeatDaemon(
        store, _StubOrchestrator(), repo_path=tmp_path, artifact_dir=tmp_path / "a"
    )

    claimed = daemon.tick_scheduled_triggers(now=100.0)
    assert len(claimed) == 1
    routine_issue_id = claimed[0].context_snapshot["issue_id"]

    outcome = daemon.service_once()

    # The routine fire ran the work it just materialized (directed wake), through
    # the SAME checkout→run→submit_for_review path as any other issue.
    assert outcome is not None
    assert outcome.status == "finished"
    assert outcome.detail.endswith("submitted_for_review")
    assert outcome.issue_id == routine_issue_id
    assert store.get_issue(routine_issue_id).status == IssueStatus.IN_REVIEW.value


def test_list_routine_runs_projects_fire_history(store, tmp_path):
    """The routine_run ledger lists each fire (its materialized issue) + run status,
    newest first, derived from issues + runs (no second source of truth)."""
    enable_master(store)
    profile = heartbeat_profile(store)
    routine, _ = seeded_routine(store, profile, interval=60, next_run_at=100.0)
    daemon = HeartbeatDaemon(
        store, _StubOrchestrator(), repo_path=tmp_path, artifact_dir=tmp_path / "a"
    )
    # Fire 1: materialize + run it (→ in_review, with an execution_run_id).
    daemon.tick_scheduled_triggers(now=100.0)
    outcome = daemon.service_once()
    first_issue = outcome.issue_id
    run_id = store.get_issue(first_issue).execution_run_id
    # Persist the executing run so the ledger can resolve its status (the real
    # orchestrator persists this; the test stub does not, so seed it here).
    from superclaw.models import GoalSpec, RunSession

    goal = store.create_goal(GoalSpec(title="r", description="r"))
    store.save_run(RunSession(goal_id=goal.goal_id, run_id=run_id, status="completed"))

    runs = store.list_routine_runs(routine.routine_id)
    assert len(runs) == 1
    rec = runs[0]
    assert rec["issue_id"] == first_issue
    assert rec["routine_id"] == routine.routine_id
    assert rec["status"] == IssueStatus.IN_REVIEW.value
    assert rec["run_id"] == run_id
    assert rec["run_status"] == "completed"  # the executing run is linked + resolved
    assert rec["routine_slot"] == f"{routine.routine_id}:100"

    # Fire 2 (next slot): prior fire is in_review (not unfinished) → a new fire
    # materializes; the ledger now shows BOTH, newest first.
    daemon.tick_scheduled_triggers(now=160.0)
    runs2 = store.list_routine_runs(routine.routine_id)
    assert len(runs2) == 2
    assert runs2[0]["issue_id"] != first_issue  # newest fire first
    assert runs2[1]["issue_id"] == first_issue


def test_list_routine_runs_empty_for_unknown_routine(store):
    assert store.list_routine_runs("routine_nope") == []
    assert store.list_routine_runs("") == []


def test_list_routine_runs_ordering_survives_old_fire_resave(store, tmp_path):
    """Fire order must be STABLE: re-saving an OLD fire's issue (a status advance,
    which rewrites the row via INSERT OR REPLACE and refreshes its rowid) must NOT
    float it above a newer fire. The ledger orders by created_at, not rowid."""
    enable_master(store)
    profile = heartbeat_profile(store)
    routine, _ = seeded_routine(store, profile, interval=60, next_run_at=100.0)
    daemon = HeartbeatDaemon(
        store, _StubOrchestrator(), repo_path=tmp_path, artifact_dir=tmp_path / "a"
    )
    # Fire 1 (older), left as a plain todo (do NOT run it so it stays unfinished
    # would block single-flight; instead cancel it so fire 2 can materialize).
    daemon.tick_scheduled_triggers(now=100.0)
    fires1 = store.list_routine_runs(routine.routine_id)
    issue1 = fires1[0]["issue_id"]
    # Move issue1 out of the single-flight set (todo/in_progress) so fire 2 fires.
    i1 = store.get_issue(issue1)
    i1.status = IssueStatus.CANCELLED.value
    store.save_issue(i1)
    # Fire 2 (newer): materializes a fresh issue with a later created_at.
    daemon.tick_scheduled_triggers(now=160.0)
    issue2 = next(
        r["issue_id"] for r in store.list_routine_runs(routine.routine_id) if r["issue_id"] != issue1
    )

    # Now RE-SAVE the OLD fire (issue1) — this rewrites its row, bumping its rowid
    # above issue2's. A rowid-ordered ledger would wrongly float issue1 to the top.
    i1b = store.get_issue(issue1)
    store.save_issue(i1b)  # no status change, but INSERT OR REPLACE refreshes rowid

    runs = store.list_routine_runs(routine.routine_id)
    assert [r["issue_id"] for r in runs] == [issue2, issue1]  # newest-by-creation first, stable


def test_routine_single_flight_skips_while_prior_issue_unfinished(store, tmp_path):
    """A routine must not pile up a new issue while its last fire is still
    unfinished (anti-backlog single-flight). The slot still advances (the cadence
    gear turns) but no second issue / wakeup is produced."""
    daemon = make_daemon(store, tmp_path)
    enable_master(store)
    profile = heartbeat_profile(store)
    routine, _ = seeded_routine(store, profile, interval=60, next_run_at=100.0)

    assert len(daemon.tick_scheduled_triggers(now=100.0)) == 1  # fire 1 → issue1 (left todo)
    second = daemon.tick_scheduled_triggers(now=160.0)          # fire 2 → prior still in flight

    assert second == []  # slot advanced, but no wakeup (no new work)
    routine_issues = [
        i
        for i in store.list_issues(company_profile_id=profile.company_profile_id)
        if i.metadata.get("routine_id") == routine.routine_id
    ]
    assert len(routine_issues) == 1  # exactly one — no pile-up
    refreshed = store.get_team_routine_schedule(routine.routine_id)
    assert refreshed.claim_count == 2  # the gear turned on the skipped fire too
    assert refreshed.next_run_at == 220.0


def test_routine_drift_skips_materialization_but_advances_slot(store, tmp_path):
    """Authoring → fire can be weeks apart. If the assignee agent vanished, fire no
    orphan issue — skip (no wakeup) while the slot still advances. ``save_issue``'s
    governance scope does NOT cover the assignee, so this guard is load-bearing."""
    daemon = make_daemon(store, tmp_path)
    enable_master(store)
    profile = heartbeat_profile(store)
    routine, _ = seeded_routine(store, profile, next_run_at=100.0)
    # Simulate post-authoring drift: the assignee agent is deleted.
    with store._connect() as conn:
        conn.execute("DELETE FROM agent_profiles WHERE profile_id = ?", (profile.profile_id,))

    fired = daemon.tick_scheduled_triggers(now=100.0)

    assert fired == []  # nothing materialized → no wakeup
    routine_issues = [
        i
        for i in store.list_issues(company_profile_id=profile.company_profile_id)
        if i.metadata.get("routine_id") == routine.routine_id
    ]
    assert routine_issues == []  # no orphan issue written
    refreshed = store.get_team_routine_schedule(routine.routine_id)
    assert refreshed.claim_count == 1  # gear still turned
    assert refreshed.next_run_at == 160.0


def test_two_routines_materialize_independently_no_wakeup_coalesce_loss(store, tmp_path):
    """Method-A robustness: each fire materializes its issue at CLAIM time, so two
    routines on the same agent each get a durable todo even though their
    ``source="routine"`` wakeups are coalesce/defer candidates. No work is lost to
    wakeup collapse — the failure mode service-time materialization would have."""
    daemon = make_daemon(store, tmp_path)
    enable_master(store)
    profile = heartbeat_profile(store)
    routine_a, _ = seeded_routine(
        store, profile, title="A", seed_title="Work A",
        idempotency_key="routine:A", next_run_at=100.0,
    )
    routine_b, _ = seeded_routine(
        store, profile, title="B", seed_title="Work B",
        idempotency_key="routine:B", next_run_at=100.0,
    )

    fired = daemon.tick_scheduled_triggers(now=100.0)

    assert len(fired) == 2
    by_routine = {
        i.metadata.get("routine_id"): i
        for i in store.list_issues(company_profile_id=profile.company_profile_id)
        if i.metadata.get("routine_id")
    }
    assert set(by_routine) == {routine_a.routine_id, routine_b.routine_id}
    assert by_routine[routine_a.routine_id].title == "Work A"
    assert by_routine[routine_b.routine_id].title == "Work B"


def _materialized_routine_issue(store, profile):
    issues = [
        i
        for i in store.list_issues(company_profile_id=profile.company_profile_id)
        if i.metadata.get("routine_id")
    ]
    assert len(issues) == 1
    return issues[0]


def test_routine_without_context_stamps_no_routine_context(store, tmp_path):
    """A routine with no context block → the materialized issue carries NO
    routine_context key (the run inherits the agent's full grants)."""
    daemon = make_daemon(store, tmp_path)
    enable_master(store)
    profile = heartbeat_profile(store)
    seeded_routine(store, profile)  # no context
    daemon.tick_scheduled_triggers(now=100.0)
    issue = _materialized_routine_issue(store, profile)
    assert "routine_context" not in issue.metadata


def test_routine_context_subset_is_snapshotted_onto_issue(store, tmp_path):
    """A routine.context subset is snapshotted onto the materialized issue so the
    run narrows equipment to it (intrinsic, not caller-passed)."""
    daemon = make_daemon(store, tmp_path)
    enable_master(store)
    profile = heartbeat_profile(store)
    seeded_routine(store, profile, context={"plugin_ids": ["p1", "p2"], "skill_ids": ["s1"]})
    daemon.tick_scheduled_triggers(now=100.0)
    issue = _materialized_routine_issue(store, profile)
    assert issue.metadata["routine_context"] == {"plugin_ids": ["p1", "p2"], "skill_ids": ["s1"]}


def test_routine_context_distinguishes_empty_from_absent_on_issue(store, tmp_path):
    """Explicit ``plugin_ids: []`` (use zero plugins) is snapshotted as []; an
    unspecified skill axis is omitted (None) — never collapsed together."""
    daemon = make_daemon(store, tmp_path)
    enable_master(store)
    profile = heartbeat_profile(store)
    seeded_routine(store, profile, context={"plugin_ids": []})
    daemon.tick_scheduled_triggers(now=100.0)
    issue = _materialized_routine_issue(store, profile)
    # plugin axis present-empty → []; skill axis absent → not stamped
    assert issue.metadata["routine_context"] == {"plugin_ids": []}


def test_routine_directed_wake_never_preempts_rework(store, tmp_path):
    """A routine fire must NOT jump its fresh todo ahead of continuation debt.
    The scheduler contract (``_next_work``) services rework — an in_progress
    bounce-back / child-done integration — before any new claim; directed routine
    wake is consulted ONLY when the ordinary pick is not debt, so a frequent
    cadence can never periodically starve rework."""
    enable_master(store)
    profile = heartbeat_profile(store)
    # A rework issue: checked out (in_progress, this agent holds the lock) with a
    # pending qa_rejection — exactly the debt _next_work must service first.
    rework = assigned_issue(store, profile, title="Bounced back")
    team_kernel.checkout_issue(
        store, rework.issue_id, run_id="rw-run",
        holder=profile.profile_id, expected_assignee=profile.profile_id,
    )
    store.save_issue_interaction(
        IssueThreadInteraction(
            issue_id=rework.issue_id,
            company_profile_id=rework.company_profile_id,
            kind="qa_rejection",
            status="pending",
            payload={"reason": "tests failed"},
        )
    )
    seeded_routine(store, profile, seed_title="Routine work")
    daemon = HeartbeatDaemon(
        store, _StubOrchestrator(), repo_path=tmp_path, artifact_dir=tmp_path / "a"
    )

    claimed = daemon.tick_scheduled_triggers(now=100.0)
    routine_issue_id = claimed[0].context_snapshot["issue_id"]
    outcome = daemon.service_once()

    # The routine wake serviced the REWORK debt, not its own fresh issue.
    assert outcome is not None
    assert outcome.issue_id == rework.issue_id
    assert outcome.issue_id != routine_issue_id
    # The routine's fresh issue is untouched, still a todo waiting its turn.
    assert store.get_issue(routine_issue_id).status == IssueStatus.TODO.value


def test_routine_directed_wake_never_preempts_debt_bearing_todo(store, tmp_path):
    """Debt is not only in_progress rework: a TODO carrying a pending continuation
    (a child-done the parent must integrate) is debt-first in _next_work and must
    also outrank a routine fire's fresh issue. Guards the ``_pending_continuations``
    leg of ``selected_is_debt``."""
    enable_master(store)
    profile = heartbeat_profile(store)
    debt = assigned_issue(store, profile, title="Parent awaiting child")  # a todo
    store.save_issue_interaction(
        IssueThreadInteraction(
            issue_id=debt.issue_id,
            company_profile_id=debt.company_profile_id,
            kind="completion",
            status="pending",
            continuation_policy="notify_parent",
            payload={"child": "finished"},
        )
    )
    seeded_routine(store, profile, seed_title="Routine work")
    daemon = HeartbeatDaemon(
        store, _StubOrchestrator(), repo_path=tmp_path, artifact_dir=tmp_path / "a"
    )

    claimed = daemon.tick_scheduled_triggers(now=100.0)
    routine_issue_id = claimed[0].context_snapshot["issue_id"]
    outcome = daemon.service_once()

    # The debt-bearing todo (child-done integration) wins over the routine issue.
    assert outcome is not None
    assert outcome.issue_id == debt.issue_id
    assert store.get_issue(routine_issue_id).status == IssueStatus.TODO.value


def test_routine_directed_wake_beats_older_higher_priority_plain_todo(store, tmp_path):
    """Anti-starvation: when the ordinary pick is a PLAIN todo (no debt), a routine
    fire runs the work it just materialized even though an older, higher-priority
    plain todo exists — Paperclip per-fire parity. (Only the routine's OWN wake
    does this; a plain timer wake would still take the older todo.)"""
    enable_master(store)
    profile = heartbeat_profile(store)
    older = assigned_issue(store, profile, title="Old high-pri", priority="high")
    seeded_routine(store, profile, seed_title="Routine work")  # fresh, medium prio
    daemon = HeartbeatDaemon(
        store, _StubOrchestrator(), repo_path=tmp_path, artifact_dir=tmp_path / "a"
    )

    claimed = daemon.tick_scheduled_triggers(now=100.0)
    routine_issue_id = claimed[0].context_snapshot["issue_id"]
    outcome = daemon.service_once()

    assert outcome is not None
    assert outcome.issue_id == routine_issue_id  # the routine's own work ran this fire
    assert store.get_issue(older.issue_id).status == IssueStatus.TODO.value  # older waits


def test_routine_workspace_drift_skips_materialization(store, tmp_path):
    """Workspace drift (deleted after authoring) skips the fire — no orphan issue.
    Exercises the workspace branch of the conn-local drift guard (agent drift is
    covered separately); ``save_issue``'s scope check is bypassed here, so the
    materializer must re-prove the workspace itself."""
    enable_master(store)
    company = store.save_company_profile(CompanyProfile(name="Acme"))
    workspace = store.save_workspace_profile(
        WorkspaceProfile(
            name="repo",
            company_profile_id=company.company_profile_id,
            repo_path=str(tmp_path),
        )
    )
    profile = AgentProfile(
        name="Eng", role="engineer", backend_policy="local",
        company_profile_id=company.company_profile_id,
        workspace_id=workspace.workspace_id,
        runtime_config={"heartbeat": {"enabled": True, "interval_sec": 300}},
    )
    store.save_agent_profile(profile)
    routine, _ = seeded_routine(store, profile, next_run_at=100.0)
    # Drift: the workspace is deleted between authoring and the fire.
    with store._connect() as conn:
        conn.execute(
            "DELETE FROM workspace_profiles WHERE workspace_id = ?",
            (workspace.workspace_id,),
        )
    daemon = make_daemon(store, tmp_path)

    fired = daemon.tick_scheduled_triggers(now=100.0)

    assert fired == []  # nothing materialized → no wakeup
    issues = [
        i
        for i in store.list_issues(company_profile_id=company.company_profile_id)
        if i.metadata.get("routine_id") == routine.routine_id
    ]
    assert issues == []  # no orphan issue in a vanished workspace
    refreshed = store.get_team_routine_schedule(routine.routine_id)
    assert refreshed.claim_count == 1  # gear still advanced


def test_run_error_after_persisted_run_keeps_wreckage_locked(store, tmp_path):
    class _CrashAfterPersist:
        """run_goal persists a real run (as the orchestrator does) then dies."""

        def __init__(self, store):
            self.store = store
            self.run_id = None

        def run_goal(self, **kwargs):
            from superclaw.models import GoalSpec

            goal = self.store.create_goal(GoalSpec(title="x", description="y"))
            session = self.store.create_run(goal.goal_id)
            session.execution_context = {
                **session.execution_context,
                **(kwargs.get("execution_context_extra") or {}),
            }
            self.store.save_run(session)
            self.run_id = session.run_id
            raise RuntimeError("died mid-execution")

        def reconcile_stale_runs(self, **kwargs):
            return []

    orchestrator = _CrashAfterPersist(store)
    daemon = HeartbeatDaemon(store, orchestrator, repo_path=tmp_path, artifact_dir=tmp_path / "a")
    profile = heartbeat_profile(store)
    issue = assigned_issue(store, profile)
    store.enqueue_wakeup(AgentWakeupRequest(agent_profile_id=profile.profile_id))

    outcome = daemon.service_once()
    assert outcome.status == "skipped" and outcome.detail.startswith("run_error")
    # The run existed — this is wreckage, not a phantom claim: the anchor is
    # recovered, the issue stays in_progress, and the workspace stays locked.
    assert outcome.run_id == orchestrator.run_id
    refreshed = store.get_issue(issue.issue_id)
    assert refreshed.status == IssueStatus.IN_PROGRESS.value
    assert refreshed.execution_run_id == orchestrator.run_id
    with pytest.raises(Exception):
        team_kernel.checkout_issue(store, issue.issue_id, run_id="must-not-reclaim")


def test_task_session_persists_resume_pointer_and_backlog_summary(store, tmp_path):
    daemon = make_daemon(store, tmp_path)
    profile = AgentProfile(
        name="Codex", role="engineer", backend_policy="codex",
        runtime_config={"heartbeat": {"enabled": True, "interval_sec": 300}},
    )
    store.save_agent_profile(profile)
    issue = assigned_issue(store, profile)
    goal = store.create_goal(GoalSpec(title="daemon", description="resume"))
    session = store.create_run(goal.goal_id)
    session.execution_context["native_session_id"] = "native-abc"
    store.save_run(session)
    store.save_issue_interaction(
        IssueThreadInteraction(
            issue_id=issue.issue_id,
            company_profile_id=issue.company_profile_id,
            kind="qa_rejection",
            status="pending",
            payload={"reason": "tests failed"},
        )
    )

    daemon._persist_session_state(profile, issue, session.run_id, "failed")

    persisted = store.get_agent_task_session(profile.profile_id, issue.issue_id)
    assert persisted is not None
    assert persisted.session_ref == "codex:native-abc"
    assert persisted.last_run_id == session.run_id
    assert persisted.last_run_status == "failed"
    assert persisted.backlog_summary["pending_continuations"] == 1
    assert persisted.backlog_summary["pending_kinds"] == ["qa_rejection"]
    brief = daemon._rework_brief(issue, profile)
    assert "Resume pointer: codex:native-abc" in brief
    assert "Backlog: 1 pending continuation(s)" in brief
    assert "Pending kinds: qa_rejection" in brief


def test_cli_create_profile_heartbeat_flags(tmp_path, monkeypatch):
    import json as _json

    from typer.testing import CliRunner

    from superclaw.cli import app

    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    runner = CliRunner()
    result = runner.invoke(
        app, ["agent", "create-profile", "Eng", "engineer", "--heartbeat", "--heartbeat-interval", "60"]
    )
    assert result.exit_code == 0, result.output
    profile = _json.loads(result.output)["profile"]
    assert profile["runtime_config"]["heartbeat"] == {"enabled": True, "interval_sec": 60}
    plain = runner.invoke(app, ["agent", "create-profile", "QA", "qa"])
    assert _json.loads(plain.output)["profile"]["runtime_config"] == {}


def test_module_entry_sees_every_command():
    """`python -m superclaw.cli` must expose the SAME command surface as the
    imported app object — app() running before the last @command definition
    silently drops trailing commands (the bug that hid `daemon tick`)."""
    import subprocess
    import sys

    result = subprocess.run(
        [sys.executable, "-m", "superclaw.cli", "daemon", "--help"],
        capture_output=True, text=True, timeout=60,
    )
    assert result.returncode == 0, result.stderr
    for command in ("start", "stop", "status", "tick"):
        assert command in result.stdout


def test_cli_create_profile_permission_grants(tmp_path, monkeypatch):
    import json as _json

    from typer.testing import CliRunner

    from superclaw.cli import app

    monkeypatch.setenv("SUPERCLAW_STATE_PATH", str(tmp_path / "state.db"))
    runner = CliRunner()
    # Max-permission doctrine: both ask and allow project onto bypassPermissions
    # (the runtime is a pure execution engine); only the explicit read-only
    # 'none' floor differs. See permissions.py PRESET_TO_MODE.
    for preset, mode in (("none", "plan"), ("ask", "bypassPermissions"), ("allow", "bypassPermissions")):
        r = runner.invoke(app, ["agent", "create-profile", f"A-{preset}", "engineer", "--permission", preset])
        assert r.exit_code == 0, r.output
        assert _json.loads(r.output)["profile"]["permission_policy"] == {"mode": mode}
    # omitted → {} (inherit); invalid → non-zero exit
    plain = runner.invoke(app, ["agent", "create-profile", "Plain", "engineer"])
    assert _json.loads(plain.output)["profile"]["permission_policy"] == {}
    bad = runner.invoke(app, ["agent", "create-profile", "Bad", "engineer", "--permission", "yolo"])
    assert bad.exit_code != 0


def test_held_issue_is_not_picked_up(store, tmp_path):
    # An administrative hold parks an assigned todo issue: the daemon must skip
    # it entirely (no run), even though it is otherwise claimable.
    daemon = make_daemon(store, tmp_path)
    profile = heartbeat_profile(store)
    issue = assigned_issue(store, profile)
    team_kernel.hold_issue(store, issue.issue_id, reason="operator paused")
    store.enqueue_wakeup(AgentWakeupRequest(agent_profile_id=profile.profile_id))
    outcome = daemon.service_once()
    assert outcome.status == "finished" and outcome.detail.endswith("idle")
    assert store.get_issue(issue.issue_id).status == IssueStatus.TODO.value
    # Releasing the hold makes it claimable again.
    team_kernel.release_issue_hold(store, issue.issue_id)
    assert not store.issue_is_held(issue.issue_id)


def test_daemon_finishes_cleanly_when_issue_held_mid_run(store, tmp_path):
    # A hold landing WHILE a run is in flight must not let the completed work
    # advance to review: the daemon finishes cleanly, leaving it in_progress+held.
    profile = heartbeat_profile(store)
    issue = assigned_issue(store, profile)

    class _HoldsDuringRun:
        def __init__(self, store, issue_id):
            self.store = store
            self.issue_id = issue_id
            self.status = "completed"

        def run_goal(self, **kwargs):
            team_kernel.hold_issue(self.store, self.issue_id, reason="freeze mid-run")
            return _StubResult("run_held_1", self.status)

        def reconcile_stale_runs(self, **kwargs):
            return []

    daemon = HeartbeatDaemon(store, _HoldsDuringRun(store, issue.issue_id),
                             repo_path=tmp_path, artifact_dir=tmp_path / "a")
    store.enqueue_wakeup(AgentWakeupRequest(agent_profile_id=profile.profile_id))
    outcome = daemon.service_once()
    assert outcome.status == "finished" and outcome.detail.endswith("held_before_submit")
    # Frozen in_progress, NOT advanced to in_review; no completion approval opened.
    assert store.get_issue(issue.issue_id).status == IssueStatus.IN_PROGRESS.value
    assert not [a for a in store.list_approvals(status="pending") if a.issue_id == issue.issue_id]
