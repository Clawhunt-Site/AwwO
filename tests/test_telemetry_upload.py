"""Install-side upload spooler unit tests (fake store + fake poster)."""
from __future__ import annotations

from pathlib import Path

from superclaw.models import CostEvent
from superclaw.telemetry_upload import (
    TelemetryConfig,
    UploadSpooler,
    _deterministic_upload_id,
    _scrub,
)


class FakeStore:
    """Models the ledger's monotonic rowid by list position (1-based). Appending
    an event gives it a higher seq, exactly like a real INSERT's rowid."""
    def __init__(self, events: list[CostEvent]) -> None:
        self._events = events

    def max_cost_event_seq(self) -> int:
        return len(self._events)

    def list_cost_events_after_seq(
        self, after_seq: int = 0, *, limit: int | None = None, until_seq: int | None = None
    ) -> list[tuple[int, CostEvent]]:
        out = [
            (i + 1, e) for i, e in enumerate(self._events)
            if i + 1 > after_seq and (until_seq is None or i + 1 <= until_seq)
        ]
        return out if limit is None else out[:limit]


class FakePoster:
    def __init__(self, status: str = "accepted") -> None:
        self.calls: list[dict] = []
        self.status = status

    def __call__(self, url: str, payload: dict, token: str) -> dict:
        self.calls.append({"url": url, "payload": payload, "token": token})
        return {"upload_id": payload["upload_id"], "status": self.status,
                "accepted_rows": len(payload["rows"])}


def _cfg(tmp_path: Path, **over) -> TelemetryConfig:
    base = dict(endpoint="http://collector.test", token="tok", enabled_env=False,
                kill=False, max_batch_rows=1000, timeout_seconds=5.0, base_dir=tmp_path,
                max_batches_per_tick=1000, max_tick_seconds=1e9)
    base.update(over)
    return TelemetryConfig(**base)


def _events() -> list[CostEvent]:
    return [
        CostEvent(idempotency_key="k1", run_id="r1", model="m", cost_cents=10,
                  input_tokens=3, output_tokens=1, occurred_at=100.0),
        CostEvent(idempotency_key="k2", run_id="r2", model="m", cost_cents=20,
                  occurred_at=200.0),
    ]


def test_disabled_by_default_no_network(tmp_path):
    poster = FakePoster()
    spooler = UploadSpooler(FakeStore(_events()), _cfg(tmp_path), poster=poster)
    result = spooler.tick()
    assert result.skipped and "not enabled" in result.reason
    assert poster.calls == []  # zero network when not consented


def test_kill_switch_overrides_consent(tmp_path):
    poster = FakePoster()
    spooler = UploadSpooler(FakeStore(_events()), _cfg(tmp_path, kill=True), poster=poster)
    spooler.set_consent(enabled=True, agreement_version="v1")
    result = spooler.tick()
    assert result.skipped and "kill switch" in result.reason
    assert poster.calls == []


def test_no_endpoint_no_network(tmp_path):
    poster = FakePoster()
    spooler = UploadSpooler(FakeStore(_events()), _cfg(tmp_path, endpoint=""), poster=poster)
    spooler.set_consent(enabled=True, agreement_version="v1")
    assert spooler.tick().skipped
    assert poster.calls == []


def test_enabled_uploads_and_advances_cursor(tmp_path):
    poster = FakePoster()
    spooler = UploadSpooler(FakeStore(_events()), _cfg(tmp_path), poster=poster)
    spooler.set_consent(enabled=True, agreement_version="v1")

    result = spooler.tick()
    assert not result.skipped and result.rows == 2 and result.batches == 1
    assert len(poster.calls) == 1
    sent = poster.calls[0]["payload"]
    assert sent["tier"] == "A" and sent["agreement_version"] == "v1"
    assert poster.calls[0]["token"] == "tok"

    # Second tick: cursor advanced, nothing new → no upload.
    result2 = spooler.tick()
    assert result2.rows == 0 and len(poster.calls) == 1


def test_new_event_after_cursor_uploads_only_the_new_one(tmp_path):
    events = _events()
    store = FakeStore(events)
    poster = FakePoster()
    spooler = UploadSpooler(store, _cfg(tmp_path), poster=poster)
    spooler.set_consent(enabled=True, agreement_version="v1")
    spooler.tick()
    assert poster.calls[-1]["payload"]["rows"][-1]["run_id"] == "r2"

    events.append(CostEvent(idempotency_key="k3", run_id="r3", cost_cents=5, occurred_at=300.0))
    result = spooler.tick()
    assert result.rows == 1
    assert poster.calls[-1]["payload"]["rows"][0]["run_id"] == "r3"  # only the new one


def test_disable_clears_cursor(tmp_path):
    spooler = UploadSpooler(FakeStore(_events()), _cfg(tmp_path), poster=FakePoster())
    spooler.set_consent(enabled=True, agreement_version="v1")
    spooler.tick()
    assert (tmp_path / "telemetry-upload-state.json").exists()
    spooler.set_consent(enabled=False)
    assert not (tmp_path / "telemetry-upload-state.json").exists()


def test_enabled_env_works_without_consent_file(tmp_path):
    poster = FakePoster()
    spooler = UploadSpooler(FakeStore(_events()), _cfg(tmp_path, enabled_env=True), poster=poster)
    result = spooler.tick()  # no set_consent call, enabled purely via env
    assert not result.skipped and result.rows == 2


class FlakyPoster:
    """Accepts the first N batches, then raises — to test partial-batch failure."""
    def __init__(self, accept_n: int) -> None:
        self.calls: list[dict] = []
        self.accept_n = accept_n

    def __call__(self, url: str, payload: dict, token: str) -> dict:
        self.calls.append(payload)
        if len(self.calls) > self.accept_n:
            raise RuntimeError("simulated network failure")
        return {"upload_id": payload["upload_id"], "status": "accepted",
                "accepted_rows": len(payload["rows"])}


def test_same_timestamp_split_batches_partial_failure_no_data_loss(tmp_path):
    # Two events at the SAME occurred_at, max_batch_rows=1 → two batches. First
    # accepted, second fails. The un-sent event must NOT be lost: next tick (with
    # a healthy poster) uploads it. This is the regression for the cursor bug.
    events = [
        CostEvent(idempotency_key="a", run_id="rA", occurred_at=100.0, cost_cents=1),
        CostEvent(idempotency_key="b", run_id="rB", occurred_at=100.0, cost_cents=1),
    ]
    flaky = FlakyPoster(accept_n=1)
    spooler = UploadSpooler(FakeStore(events), _cfg(tmp_path, max_batch_rows=1), poster=flaky)
    spooler.set_consent(enabled=True, agreement_version="v1")

    r1 = spooler.tick()
    assert r1.rows == 1 and r1.errors  # one sent, one failed
    sent_run_ids = {p["rows"][0]["run_id"] for p in flaky.calls[:1]}

    # Second tick with a healthy poster must deliver the previously-failed event.
    good = FakePoster()
    spooler2 = UploadSpooler(FakeStore(events), _cfg(tmp_path, max_batch_rows=1), poster=good)
    r2 = spooler2.tick()
    delivered = {c["payload"]["rows"][0]["run_id"] for c in good.calls}
    assert r2.rows == 1  # exactly the one not yet sent
    assert sent_run_ids | delivered == {"rA", "rB"}  # both eventually delivered, none lost


def test_backfilled_earlier_timestamp_event_is_uploaded(tmp_path):
    # An event appended later but with an EARLIER occurred_at gets a higher
    # insertion seq, so the rowid cursor picks it up regardless of timestamp —
    # the window-outside permanent-loss residual of the old model is gone.
    events = [
        CostEvent(idempotency_key="a", run_id="rA", occurred_at=200.0, cost_cents=1),
        CostEvent(idempotency_key="b", run_id="rB", occurred_at=300.0, cost_cents=1),
    ]
    poster = FakePoster()
    spooler = UploadSpooler(FakeStore(events), _cfg(tmp_path), poster=poster)
    spooler.set_consent(enabled=True, agreement_version="v1")
    assert spooler.tick().rows == 2

    # Backfill an event with a much EARLIER occurred_at (e.g. days old).
    events.append(CostEvent(idempotency_key="c", run_id="rC", occurred_at=1.0, cost_cents=1))
    result = spooler.tick()
    assert result.rows == 1  # picked up by seq despite the ancient timestamp
    assert poster.calls[-1]["payload"]["rows"][0]["run_id"] == "rC"


def test_future_timestamp_does_not_strand_later_events(tmp_path):
    # A single clock-skewed FUTURE event must not strand later real events: the
    # cursor is the insertion seq, not occurred_at, so the future event sits at
    # its seq and later rows keep their own higher seqs.
    events = [CostEvent(idempotency_key="future", run_id="rF",
                        occurred_at=5_000_000_000.0, cost_cents=1)]
    poster = FakePoster()
    spooler = UploadSpooler(FakeStore(events), _cfg(tmp_path), poster=poster)
    spooler.set_consent(enabled=True, agreement_version="v1")
    assert spooler.tick().rows == 1  # the future event itself uploads

    events.append(CostEvent(idempotency_key="normal", run_id="rN",
                            occurred_at=1000.0, cost_cents=1))
    result = spooler.tick()
    assert result.rows == 1  # NOT stranded by the future-dated event
    assert poster.calls[-1]["payload"]["rows"][0]["run_id"] == "rN"


def test_converges_no_infinite_resend(tmp_path):
    # After everything is delivered, repeated ticks must send NOTHING (the old
    # boundary-overwrite bug caused permanent alternating re-sends).
    events = [
        CostEvent(idempotency_key="a", run_id="rA", occurred_at=100.0, cost_cents=1),
        CostEvent(idempotency_key="b", run_id="rB", occurred_at=100.0, cost_cents=1),
    ]
    poster = FakePoster()
    spooler = UploadSpooler(FakeStore(events), _cfg(tmp_path, max_batch_rows=1), poster=poster)
    spooler.set_consent(enabled=True, agreement_version="v1")
    spooler.tick()
    calls_after_first = len(poster.calls)
    for _ in range(3):
        assert spooler.tick().rows == 0
    assert len(poster.calls) == calls_after_first  # no further uploads


def test_disable_overrides_env_enable(tmp_path):
    # CLI is the single source of truth: an explicit `disable` must beat
    # SUPERCLAW_TELEMETRY_ENABLED=1, or "disable" would be a no-op privacy hole.
    poster = FakePoster()
    spooler = UploadSpooler(FakeStore(_events()), _cfg(tmp_path, enabled_env=True), poster=poster)
    spooler.set_consent(enabled=False)  # user explicitly opts out
    result = spooler.tick()
    assert result.skipped and "disabled via CLI" in result.reason
    assert poster.calls == []


def test_deterministic_upload_id_stable_and_scoped():
    a = _deterministic_upload_id("devX", "A", ["e1", "e2"])
    b = _deterministic_upload_id("devX", "A", ["e2", "e1"])  # order-independent
    c = _deterministic_upload_id("devY", "A", ["e1", "e2"])  # device-scoped
    assert a == b and a != c and len(a) == 64


def test_scrub_blocks_non_scalar_and_keeps_numbers():
    assert _scrub({"raw": "payload"}) == "<non-scalar>"
    assert _scrub(None) is None
    assert _scrub(42) == 42 and _scrub(True) is True


def test_scrub_redacts_secret_in_string():
    leaked = "authorization: Bearer sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF1234567890"
    out = _scrub(leaked)
    assert "sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF1234567890" not in out


# --- streaming / bounded-memory spool -------------------------------------

def _many(n: int) -> list:
    return [CostEvent(idempotency_key=f"e{i}", run_id=f"r{i}", cost_cents=1,
                      occurred_at=float(i)) for i in range(n)]


def test_streaming_pages_bound_memory(tmp_path):
    # The whole backlog must NOT be loaded at once: each fetch is limited to
    # max_batch_rows. We record the largest single fetch and assert it's bounded.
    events = _many(50)
    fetch_sizes = []

    class CountingStore(FakeStore):
        def list_cost_events_after_seq(self, after_seq=0, *, limit=None, until_seq=None):
            out = super().list_cost_events_after_seq(after_seq, limit=limit, until_seq=until_seq)
            fetch_sizes.append(len(out))
            return out

    poster = FakePoster()
    spooler = UploadSpooler(CountingStore(events), _cfg(tmp_path, max_batch_rows=10),
                            poster=poster)
    spooler.set_consent(enabled=True, agreement_version="v1")
    result = spooler.tick(drain=True)
    assert result.rows == 50 and result.batches == 5
    assert max(fetch_sizes) <= 10  # never loaded more than one page


def test_bounded_tick_caps_batches_then_resumes(tmp_path):
    # A normal (non-drain) tick stops after max_batches_per_tick; the rest is
    # uploaded on subsequent ticks — no loss.
    events = _many(10)
    poster = FakePoster()
    spooler = UploadSpooler(events_store := FakeStore(events),
                            _cfg(tmp_path, max_batch_rows=2, max_batches_per_tick=2),
                            poster=poster)
    spooler.set_consent(enabled=True, agreement_version="v1")
    r1 = spooler.tick()
    assert r1.batches == 2 and r1.rows == 4  # capped: 2 batches x 2 rows
    r2 = spooler.tick()
    assert r2.batches == 2 and r2.rows == 4
    # drain the rest
    r3 = spooler.tick(drain=True)
    assert r1.rows + r2.rows + r3.rows == 10  # all delivered, none lost
    assert events_store  # silence unused-name lint


def test_max_tick_seconds_bounds_the_tick(tmp_path):
    # An injected clock that advances 5s per read makes the 10s budget elapse
    # after ~2 batches.
    events = _many(10)
    ticks = iter([0.0, 0.0, 6.0, 12.0, 100.0, 100.0, 100.0, 100.0])
    poster = FakePoster()
    spooler = UploadSpooler(FakeStore(events),
                            _cfg(tmp_path, max_batch_rows=1, max_batches_per_tick=1000,
                                 max_tick_seconds=10.0),
                            poster=poster, clock=lambda: next(ticks))
    spooler.set_consent(enabled=True, agreement_version="v1")
    r = spooler.tick()
    assert 0 < r.rows < 10  # stopped early on the time budget, not all 10


def test_pending_range_resend_is_batch_shape_stable(tmp_path):
    # Reproduction C fix: simulate a crash AFTER a batch was sent but BEFORE the
    # cursor advanced — state has pending_end_seq=2, acked_seq=0. Even if
    # max_batch_rows is now 1, the resend must cover the SAME rowid range (both
    # events in one batch) so the deterministic upload_id matches the original
    # and the server dedups instead of double-inserting.
    import json
    events = _many(3)
    (tmp_path / "telemetry-upload-state.json").write_text(
        json.dumps({"A": {"acked_seq": 0, "pending_end_seq": 2}}), encoding="utf-8")
    poster = FakePoster()
    spooler = UploadSpooler(FakeStore(events), _cfg(tmp_path, max_batch_rows=1), poster=poster)
    spooler.set_consent(enabled=True, agreement_version="v1")
    spooler.tick()
    first = poster.calls[0]["payload"]
    assert len(first["rows"]) == 2  # resent the whole (0,2] range, NOT one row
    # its upload_id equals a fresh deterministic id over the same two event ids
    ids = [_event_id_of(e) for e in events[:2]]
    assert first["upload_id"] == _deterministic_upload_id(
        spooler.consent().device_id, "A", ids)


def test_pending_range_incomplete_fails_closed(tmp_path):
    # Recovery fail-closed: state says a batch (0, 100] is in flight, but the
    # ledger only has 3 rows (e.g. state.db was restored out of sync). The
    # pending range can't reconstruct exactly → MUST NOT advance the cursor or
    # fake-success; it surfaces an error and leaves pending intact for repair.
    import json
    events = _many(3)
    state_path = tmp_path / "telemetry-upload-state.json"
    state_path.write_text(json.dumps({"A": {"acked_seq": 0, "pending_end_seq": 100}}),
                          encoding="utf-8")
    poster = FakePoster()
    spooler = UploadSpooler(FakeStore(events), _cfg(tmp_path), poster=poster)
    spooler.set_consent(enabled=True, agreement_version="v1")
    result = spooler.tick()
    assert result.errors and "out of sync" in result.errors[0]
    assert poster.calls == []  # never posted a mismatched range
    after = json.loads(state_path.read_text())["A"]
    assert after["acked_seq"] == 0 and after["pending_end_seq"] == 100  # unchanged


def test_pending_range_empty_fails_closed(tmp_path):
    # Same fail-closed when the pending range is entirely absent (empty fetch).
    import json
    events = _many(3)
    state_path = tmp_path / "telemetry-upload-state.json"
    state_path.write_text(json.dumps({"A": {"acked_seq": 50, "pending_end_seq": 100}}),
                          encoding="utf-8")
    poster = FakePoster()
    spooler = UploadSpooler(FakeStore(events), _cfg(tmp_path), poster=poster)
    spooler.set_consent(enabled=True, agreement_version="v1")
    result = spooler.tick()
    assert result.errors and "out of sync" in result.errors[0]
    assert poster.calls == []
    after = json.loads(state_path.read_text())["A"]
    assert after["acked_seq"] == 50 and after["pending_end_seq"] == 100  # not advanced


def test_concurrent_spooler_is_skipped_by_lock(tmp_path):
    import fcntl
    import os
    poster = FakePoster()
    spooler = UploadSpooler(FakeStore(_events()), _cfg(tmp_path), poster=poster)
    spooler.set_consent(enabled=True, agreement_version="v1")
    # Hold the spool lock as if another process were running.
    lock_path = tmp_path / "telemetry-spool.lock"
    fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    try:
        result = spooler.tick()
        assert result.skipped and "already running" in result.reason
        assert poster.calls == []  # zero network while another holds the lock
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)


def test_legacy_seq_state_is_migrated(tmp_path):
    # An old-format {"A": {"seq": N}} cursor is read as acked_seq=N (no re-upload
    # of already-sent rows).
    import json
    events = _many(3)
    (tmp_path / "telemetry-upload-state.json").write_text(
        json.dumps({"A": {"seq": 3}}), encoding="utf-8")
    poster = FakePoster()
    spooler = UploadSpooler(FakeStore(events), _cfg(tmp_path), poster=poster)
    spooler.set_consent(enabled=True, agreement_version="v1")
    r = spooler.tick()
    assert r.rows == 0 and poster.calls == []  # all 3 already acked via legacy seq


def _event_id_of(e):
    from superclaw.telemetry_upload import _event_id
    return _event_id(e)


# --- staging-baked endpoint + auto-enable ---------------------------------

def _bundle(monkeypatch, baked_env="staging"):
    """Simulate a frozen distributed bundle whose BUILD-PROFILE bakes ``baked_env``
    (not a source checkout, and not the env-var-overridable app_environment)."""
    import superclaw.environment as environment
    monkeypatch.setattr(environment, "_running_from_source", lambda: False)
    monkeypatch.setattr(environment, "_baked_environment", lambda: baked_env)


def test_staging_bundle_bakes_endpoint_token_and_auto_enables(tmp_path, monkeypatch):
    _bundle(monkeypatch, "staging")
    cfg = TelemetryConfig.from_env({}, base_dir=tmp_path)
    assert cfg.endpoint == "http://8.134.141.94:8900"
    assert cfg.token and cfg.auto_enabled is True
    spooler = UploadSpooler(FakeStore(_events()), cfg, poster=FakePoster())
    enabled, _ = spooler.is_enabled()
    assert enabled  # auto-enabled without any explicit consent / enable


def test_env_var_overrides_baked_endpoint_and_token(tmp_path, monkeypatch):
    _bundle(monkeypatch, "staging")
    cfg = TelemetryConfig.from_env(
        {"SUPERCLAW_TELEMETRY_ENDPOINT": "http://override.test:9",
         "SUPERCLAW_TELEMETRY_TOKEN": "env-token"}, base_dir=tmp_path)
    assert cfg.endpoint == "http://override.test:9" and cfg.token == "env-token"


def test_production_bundle_does_not_bake_or_auto_enable(tmp_path, monkeypatch):
    _bundle(monkeypatch, "production")
    cfg = TelemetryConfig.from_env({}, base_dir=tmp_path)
    assert cfg.endpoint == "" and cfg.token == "" and cfg.auto_enabled is False
    spooler = UploadSpooler(FakeStore(_events()), cfg, poster=FakePoster())
    assert not spooler.is_enabled()[0]  # production stays OFF


def test_source_run_bakes_nothing_and_stays_inert(tmp_path, monkeypatch):
    # A source checkout (dev / CI / test suite) MUST resolve NO baked endpoint or
    # token and never auto-enable — even with APP_ENV=staging set.
    import superclaw.environment as environment
    monkeypatch.setenv("APP_ENV", "staging")
    monkeypatch.setattr(environment, "_running_from_source", lambda: True)
    cfg = TelemetryConfig.from_env({}, base_dir=tmp_path)
    assert cfg.endpoint == "" and cfg.token == "" and cfg.auto_enabled is False
    enabled, reason = UploadSpooler(FakeStore(_events()), cfg, poster=FakePoster()).is_enabled()
    assert not enabled and "no endpoint" in reason


def test_source_run_with_consent_still_inert_no_baked_endpoint(tmp_path, monkeypatch):
    # Even if a dev previously ran `telemetry enable` (consent on), a SOURCE run
    # must not phone home to the baked staging endpoint — source bakes nothing,
    # so there is no endpoint and it stays inert (closes the baked-fallback hole).
    import superclaw.environment as environment
    monkeypatch.setattr(environment, "_running_from_source", lambda: True)
    monkeypatch.setattr(environment, "_baked_environment", lambda: "staging")
    cfg = TelemetryConfig.from_env({}, base_dir=tmp_path)
    spooler = UploadSpooler(FakeStore(_events()), cfg, poster=(p := FakePoster()))
    spooler.set_consent(enabled=True, agreement_version="v1")
    enabled, reason = spooler.is_enabled()
    assert not enabled and "no endpoint" in reason
    assert spooler.tick().skipped and p.calls == []


def test_frozen_bundle_with_corrupt_profile_does_not_auto_enable(tmp_path, monkeypatch):
    # A frozen bundle whose build-profile is missing/corrupt resolves
    # _baked_environment() == "" (NOT defaulted to staging), so a damaged
    # production-like bundle can never be misread as staging and phone home.
    import superclaw.environment as environment
    monkeypatch.setattr(environment, "_running_from_source", lambda: False)
    monkeypatch.setattr(environment, "_baked_environment", lambda: "")  # corrupt/missing
    cfg = TelemetryConfig.from_env({}, base_dir=tmp_path)
    assert cfg.endpoint == "" and cfg.auto_enabled is False
    assert not UploadSpooler(FakeStore(_events()), cfg, poster=FakePoster()).is_enabled()[0]


def test_empty_env_var_neutralizes_baked_endpoint(tmp_path, monkeypatch):
    # An operator can clear the baked endpoint by SETTING it empty (presence wins
    # over truthiness): "" ⇒ telemetry inert, even on a staging bundle.
    _bundle(monkeypatch, "staging")
    cfg = TelemetryConfig.from_env({"SUPERCLAW_TELEMETRY_ENDPOINT": ""}, base_dir=tmp_path)
    assert cfg.endpoint == ""
    enabled, reason = UploadSpooler(FakeStore(_events()), cfg, poster=FakePoster()).is_enabled()
    assert not enabled and "no endpoint" in reason


def test_explicit_disable_overrides_staging_auto_enable(tmp_path, monkeypatch):
    _bundle(monkeypatch, "staging")
    cfg = TelemetryConfig.from_env({}, base_dir=tmp_path)
    poster = FakePoster()
    spooler = UploadSpooler(FakeStore(_events()), cfg, poster=poster)
    spooler.set_consent(enabled=False)  # operator opts THIS device out
    enabled, reason = spooler.is_enabled()
    assert not enabled and "disabled via CLI" in reason
    assert spooler.tick().skipped and poster.calls == []


def test_kill_switch_overrides_staging_auto_enable(tmp_path, monkeypatch):
    _bundle(monkeypatch, "staging")
    cfg = TelemetryConfig.from_env({"SUPERCLAW_TELEMETRY_KILL": "1"}, base_dir=tmp_path)
    enabled, reason = UploadSpooler(FakeStore(_events()), cfg, poster=FakePoster()).is_enabled()
    assert not enabled and "kill" in reason


# --- daemon wiring (periodic auto-spool) ----------------------------------

def _daemon(tmp_path):
    from superclaw.daemon import HeartbeatDaemon
    from superclaw.state import StateStore
    store = StateStore(str(tmp_path / "state.db"))
    return HeartbeatDaemon(store, repo_path=tmp_path, artifact_dir=tmp_path / "a")


class _DoneFuture:
    def done(self):
        return True


class _RunningFuture:
    def done(self):
        return False


class _FakePool:
    def __init__(self, future=None):
        self.submitted = []
        self._future = future or _DoneFuture()

    def submit(self, fn):
        self.submitted.append(fn)
        return self._future


def test_daemon_spools_telemetry_off_thread_and_throttled(tmp_path):
    # The spool is SUBMITTED to the worker pool (never run on the scheduler
    # thread), and throttled to ~300s — not every 15s tick.
    daemon = _daemon(tmp_path)
    pool = _FakePool()
    daemon._maybe_spool_telemetry(1000.0, pool)   # first → submit
    daemon._maybe_spool_telemetry(1010.0, pool)   # +10s within throttle → skip
    daemon._maybe_spool_telemetry(1400.0, pool)   # +400s past throttle → submit
    assert len(pool.submitted) == 2  # only the actual tick() runs off-thread


def test_daemon_skips_when_prior_spool_still_in_flight(tmp_path):
    # A slow collector must not let spools pile up: while the prior future is
    # unfinished, no new spool is submitted (even past the throttle window).
    daemon = _daemon(tmp_path)
    pool = _FakePool(future=_RunningFuture())
    daemon._maybe_spool_telemetry(1000.0, pool)   # submit (future stays running)
    daemon._maybe_spool_telemetry(9000.0, pool)   # far past throttle, but in-flight → skip
    assert len(pool.submitted) == 1


def test_daemon_telemetry_spool_is_fail_soft(tmp_path):
    # A telemetry failure must NEVER propagate out of the worker task.
    daemon = _daemon(tmp_path)
    daemon._telemetry_spooler = type(
        "Boom", (), {"tick": lambda self: (_ for _ in ()).throw(RuntimeError("boom"))})()
    daemon._spool_telemetry_once()  # must not raise


def test_run_forever_spools_telemetry_on_dedicated_thread(tmp_path, monkeypatch):
    # Integration: even with worker_threads=1, telemetry runs on its OWN
    # dedicated executor thread, never an agent-servicing worker — so a slow
    # collector can't serialize wakeup dispatch (Codex contention concern).
    import threading
    monkeypatch.setenv("SUPERCLAW_TELEMETRY_SPOOL_INTERVAL_SECONDS", "1")
    daemon = _daemon(tmp_path)
    seen = {}
    daemon._telemetry_spooler = type(
        "Spy", (), {"tick": lambda self: seen.__setitem__("thread", threading.current_thread().name)})()
    iters = {"n": 0}

    def stop():
        iters["n"] += 1
        return iters["n"] > 1  # run exactly one loop iteration

    daemon.run_forever(interval_seconds=1.0, stop_check=stop, worker_threads=1)
    # tele_pool's __exit__ joined the worker, so the tick has completed.
    assert seen.get("thread", "").startswith("telemetry-spool")
