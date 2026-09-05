"""Install-side telemetry upload spooler (client of the collection server).

This is the *only* outbound point for remote telemetry. It reads local ledgers
(currently the Tier A cost-event ledger — the only wired data source; Tier B
diagnostic spans and Tier C raw payloads land here once P0b instrumentation is
in place), projects each row through redaction, and pushes batches to the
collection server described in ``docs/remote-telemetry-upload-architecture.md``.

Hard guarantees:

* **fail-closed gate** — uploads only when enabled (explicit consent, the
  SUPERCLAW_TELEMETRY_ENABLED flag, OR a staging build's baked auto-enable) AND
  the kill switch is off AND an endpoint is configured, with an explicit
  ``telemetry disable`` always overriding. Otherwise: zero network.
* **never blocks the run** — runs out-of-band: the heartbeat daemon spools it
  periodically (throttled, fail-soft), and ``superclaw telemetry spool`` runs it
  on demand (or on a cron). Failures simply retry next run.
* **single network choke point** — ``_post`` is the one place that touches the
  network (``httpx`` with ``trust_env=False``/no redirects). Nothing else here
  imports an HTTP client.
* **effectively-once** — a monotonic insertion-sequence (rowid) cursor plus a
  deterministic ``upload_id`` (server dedup): rows upload in order, a late or
  backfilled event is never missed, a future-dated one never strands later rows,
  and a retry never double-inserts. The state persists the in-flight batch's
  rowid range (``pending_end_seq``) so a crash mid-upload re-sends the exact same
  range — keeping ``upload_id`` stable even if ``max_batch_rows`` changed.
* **bounded memory + bounded tick** — events stream in pages of
  ``max_batch_rows`` (keyset pagination, never the whole backlog at once) up to a
  start-of-tick snapshot; a tick stops after ``max_batches_per_tick`` /
  ``max_tick_seconds``. A POSIX advisory lock keeps one spooler per home dir.
"""
from __future__ import annotations

import base64
import contextlib
import hashlib
import hmac
import json
import logging
import os
import secrets
import time
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Protocol

try:  # POSIX advisory lock; degrade gracefully where unavailable (e.g. Windows)
    import fcntl
except ImportError:  # pragma: no cover - non-POSIX
    fcntl = None  # type: ignore[assignment]

from .secrets_scan import redact_secrets

logger = logging.getLogger("superclaw.telemetry_upload")

CONSENT_FILE = "telemetry-consent.json"
CURSOR_FILE = "telemetry-upload-state.json"
DEVICE_FILE = "telemetry-device-id"
LOCK_FILE = "telemetry-spool.lock"
SCHEMA_VERSION = 1


class UploadError(RuntimeError):
    """An upload attempt failed (network / server). Non-fatal — retried later."""


class _Poster(Protocol):
    def __call__(self, url: str, payload: dict[str, Any], token: str) -> dict[str, Any]: ...


@dataclass(frozen=True)
class TelemetryConfig:
    endpoint: str
    token: str
    enabled_env: bool
    kill: bool
    max_batch_rows: int
    timeout_seconds: float
    base_dir: Path
    # Per-tick bounds: a daemon-driven tick uploads at most this many batches and
    # runs at most this many seconds, so a large backlog or a continuously-
    # appended ledger never starves the daemon. The remainder is picked up on the
    # next tick; ``spool --drain`` loops ticks for an explicit operator catch-up.
    max_batches_per_tick: int
    max_tick_seconds: float
    # Staging builds bake an endpoint + write-only token and default to ON (the
    # operator's own acceptance fleet). Production stays default-OFF. kill / an
    # explicit CLI disable still override auto_enabled (see is_enabled).
    auto_enabled: bool = False
    # Tier C envelope-encryption PUBLIC key (PEM). Empty ⇒ Tier C upload stays inert
    # (fail-closed: no key, nothing sealed). The matching private key is never here.
    tier_c_public_key: str = ""

    @classmethod
    def from_env(
        cls, environ: dict[str, str] | None = None, *, base_dir: Path | None = None
    ) -> "TelemetryConfig":
        from . import environment

        env = os.environ if environ is None else environ
        home = base_dir or Path(env.get("SUPERCLAW_HOME", str(Path.home() / ".superclaw")))
        # Precedence by PRESENCE (not truthiness): if the env var is SET it wins —
        # even when set to "" so an operator can neutralize the baked endpoint
        # (Empty ⇒ telemetry stays inert). Only an ABSENT var falls back to the
        # per-environment baked default (staging ships the operator's collector +
        # a write-only token; production bakes neither).
        if "SUPERCLAW_TELEMETRY_ENDPOINT" in env:
            endpoint = env["SUPERCLAW_TELEMETRY_ENDPOINT"].strip().rstrip("/")
        else:
            endpoint = environment.baked_telemetry_endpoint()
        if "SUPERCLAW_TELEMETRY_TOKEN" in env:
            token = env["SUPERCLAW_TELEMETRY_TOKEN"].strip()
        else:
            token = environment.baked_telemetry_ingest_token()
        # Same presence-based precedence as endpoint: an explicit (even empty) env
        # override wins, else fall back to the baked per-environment public key.
        if "SUPERCLAW_TELEMETRY_TIER_C_PUBLIC_KEY" in env:
            tier_c_public_key = env["SUPERCLAW_TELEMETRY_TIER_C_PUBLIC_KEY"].strip()
        else:
            tier_c_public_key = environment.baked_tier_c_public_key()
        return cls(
            endpoint=endpoint,
            token=token,
            enabled_env=_truthy(env.get("SUPERCLAW_TELEMETRY_ENABLED")),
            kill=_truthy(env.get("SUPERCLAW_TELEMETRY_KILL")),
            max_batch_rows=_int(env.get("SUPERCLAW_TELEMETRY_MAX_BATCH_ROWS"), 1000),
            timeout_seconds=_float(env.get("SUPERCLAW_TELEMETRY_TIMEOUT"), 10.0),
            base_dir=Path(home),
            max_batches_per_tick=_int(env.get("SUPERCLAW_TELEMETRY_MAX_BATCHES_PER_TICK"), 5),
            max_tick_seconds=_float(env.get("SUPERCLAW_TELEMETRY_MAX_TICK_SECONDS"), 10.0),
            auto_enabled=environment.telemetry_auto_enabled(),
            tier_c_public_key=tier_c_public_key,
        )


@dataclass
class ConsentState:
    state: str = "disabled"  # "enabled" | "disabled"
    device_id: str = ""
    agreement_version: str | None = None
    enabled_at: float | None = None

    @property
    def enabled(self) -> bool:
        return self.state == "enabled"


@dataclass
class UploadResult:
    skipped: bool = False
    reason: str = ""
    batches: int = 0
    rows: int = 0
    duplicates: int = 0
    errors: list[str] = field(default_factory=list)


class UploadSpooler:
    """Reads local ledgers and pushes redacted batches to the collector."""

    def __init__(
        self,
        store: Any,
        config: TelemetryConfig,
        *,
        poster: _Poster | None = None,
        clock: Callable[[], float] = time.time,
        diagnostics_path: Path | None = None,
    ) -> None:
        self._store = store
        self._cfg = config
        self._poster = poster or _httpx_poster(config.timeout_seconds)
        self._clock = clock
        # telemetry.db (Tier B receipts) location. None => resolve at read time via
        # diagnostics_store.resolve_telemetry_path() (env/HOME). Injected in tests.
        self._diagnostics_path = diagnostics_path
        config.base_dir.mkdir(parents=True, exist_ok=True)

    # -- consent / gate -------------------------------------------------------
    def consent(self) -> ConsentState:
        path = self._cfg.base_dir / CONSENT_FILE
        if not path.exists():
            return ConsentState(device_id=self._ensure_device_id())
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return ConsentState(device_id=self._ensure_device_id())
        return ConsentState(
            state=str(raw.get("state", "disabled")),
            device_id=str(raw.get("device_id") or self._ensure_device_id()),
            agreement_version=raw.get("agreement_version"),
            enabled_at=raw.get("enabled_at"),
        )

    def set_consent(self, *, enabled: bool, agreement_version: str | None = None) -> ConsentState:
        current = self.consent()
        state = ConsentState(
            state="enabled" if enabled else "disabled",
            device_id=current.device_id or self._ensure_device_id(),
            agreement_version=agreement_version if enabled else None,
            enabled_at=self._clock() if enabled else None,
        )
        path = self._cfg.base_dir / CONSENT_FILE
        _write_private(path, {
            "state": state.state, "device_id": state.device_id,
            "agreement_version": state.agreement_version, "enabled_at": state.enabled_at,
        })
        if not enabled:
            self._clear_cursor()  # disable wipes pending cursor state
        return state

    def is_enabled(self) -> tuple[bool, str]:
        if self._cfg.kill:
            return (False, "kill switch active (SUPERCLAW_TELEMETRY_KILL)")
        if not self._cfg.endpoint:
            return (False, "no endpoint configured (SUPERCLAW_TELEMETRY_ENDPOINT)")
        consent = self.consent()
        # CLI is the single source of truth: an explicit `telemetry disable`
        # (a persisted consent file in the disabled state) overrides BOTH the
        # SUPERCLAW_TELEMETRY_ENABLED env flag AND a staging build's auto_enabled
        # default, so disabling always wins (kill switch above wins over all).
        if (self._cfg.base_dir / CONSENT_FILE).exists() and not consent.enabled:
            return (False, "telemetry disabled via CLI (run: superclaw telemetry enable)")
        # Enabled if: explicit consent, the env flag, OR a staging build that
        # bakes an endpoint (auto_enabled — operator's own acceptance fleet).
        if not (consent.enabled or self._cfg.enabled_env or self._cfg.auto_enabled):
            return (False, "telemetry not enabled (run: superclaw telemetry enable)")
        return (True, "")

    # -- main entry -----------------------------------------------------------
    def tick(self, *, drain: bool = False) -> UploadResult:
        """Upload pending telemetry. A normal tick is BOUNDED (at most
        ``max_batches_per_tick`` batches / ``max_tick_seconds`` seconds) so a
        backlog or a continuously-appended ledger never starves a daemon driver;
        the rest is picked up next tick. ``drain=True`` (operator
        ``spool --drain``) uploads everything up to a single start-of-call
        snapshot, unbounded, in bounded-memory pages."""
        enabled, reason = self.is_enabled()
        if not enabled:
            return UploadResult(skipped=True, reason=reason)
        result = UploadResult()
        with self._spool_lock() as acquired:
            if not acquired:
                return UploadResult(
                    skipped=True, reason="another telemetry spool is already running"
                )
            try:
                tick_end = self._store.max_cost_event_seq()
            except Exception as exc:  # noqa: BLE001 - ledger read failure is non-fatal
                result.errors.append(f"read cost ledger failed: {exc}")
                return result
            # Reincarnation guard BEFORE the pending-resend/drain: reset the cursor if
            # state.db was recreated/restored. getattr keeps test doubles without a
            # db_incarnation() method working (they just get the seq-only check).
            a_incarnation = getattr(self._store, "db_incarnation", lambda: None)()
            self._reconcile_cursor("A", a_incarnation, tick_end)
            self._upload_tier_a(
                result,
                tick_end=tick_end,
                max_batches=None if drain else self._cfg.max_batches_per_tick,
                max_seconds=None if drain else self._cfg.max_tick_seconds,
            )
            # Tier B (diagnostic receipts) — read from telemetry.db through a
            # strictly read-only cursor (never the single-writer engine), with its
            # own per-tier budget. A receipt-read failure is non-fatal: the Tier A
            # batch already uploaded; record the error and let the next tick retry.
            from . import diagnostics_store as _ds

            try:
                b_end = _ds.max_receipt_seq(self._diagnostics_path)
            except Exception as exc:  # noqa: BLE001 - read failure is non-fatal
                result.errors.append(f"read receipts ledger failed: {exc}")
                b_end = 0
            if b_end:
                self._reconcile_cursor(
                    "B", _ds.read_db_incarnation(self._diagnostics_path), b_end
                )
                self._upload_tier_b(
                    result,
                    tick_end=b_end,
                    max_batches=None if drain else self._cfg.max_batches_per_tick,
                    max_seconds=None if drain else self._cfg.max_tick_seconds,
                )
            # Tier C (envelope-encrypted raw payloads) — inert unless a public key
            # is configured AND the owner-gated recording layer has spooled files.
            self._upload_tier_c(
                result,
                max_batches=None if drain else self._cfg.max_batches_per_tick,
                max_seconds=None if drain else self._cfg.max_tick_seconds,
            )
        return result

    # -- Tier A (cost ledger) -------------------------------------------------
    def _upload_tier_a(
        self,
        result: UploadResult,
        *,
        tick_end: int,
        max_batches: int | None,
        max_seconds: float | None,
    ) -> None:
        # Cursor = the ledger's monotonic insertion sequence (rowid), NOT the
        # wall-clock occurred_at, streamed in bounded-memory pages up to a
        # start-of-tick ``tick_end`` snapshot (so continuous appends can't loop
        # forever). State = (acked_seq, pending_end_seq).
        acked, pending = self._load_spool_state("A")
        consent = self.consent()
        t0 = self._clock()

        # 1. Re-send an in-flight batch by its EXACT rowid range FIRST. The range
        #    (not the current max_batch_rows) fixes the batch shape, so the
        #    deterministic upload_id is identical to the original send even if the
        #    batch size config changed — server dedup then reliably returns
        #    duplicate. Without this, a crash between ack and cursor-save plus a
        #    config change would bypass dedup and double-insert.
        if pending is not None and pending > acked:
            if not self._send_range(acked, pending, consent, result):
                return  # still failing — leave pending for the next attempt
            acked = pending
            self._save_spool_state("A", acked, None)

        # 2. Drain (acked, tick_end] in pages of max_batch_rows.
        batches = 0
        while acked < tick_end:
            if max_batches is not None and batches >= max_batches:
                break
            if max_seconds is not None and (self._clock() - t0) >= max_seconds:
                break
            try:
                page = self._store.list_cost_events_after_seq(
                    acked, limit=self._cfg.max_batch_rows, until_seq=tick_end
                )
            except Exception as exc:  # noqa: BLE001 - ledger read failure is non-fatal
                result.errors.append(f"read cost ledger failed: {exc}")
                return
            if not page:
                break
            end = page[-1][0]
            # Persist the in-flight boundary BEFORE posting, so a crash re-sends
            # the SAME rowid range next run (stable upload_id → reliable dedup).
            self._save_spool_state("A", acked, end)
            if not self._post_page(page, consent, result):
                return  # leave pending=end recorded for retry
            acked = end
            self._save_spool_state("A", acked, None)
            batches += 1

    def _send_range(self, lo: int, hi: int, consent: ConsentState, result: UploadResult) -> bool:
        try:
            page = self._store.list_cost_events_after_seq(lo, until_seq=hi)
        except Exception as exc:  # noqa: BLE001
            result.errors.append(f"read cost ledger failed: {exc}")
            return False
        # Recovery fail-closed: the in-flight range MUST reconstruct EXACTLY, else
        # the deterministic upload_id would differ (dedup bypassed → double insert)
        # or interior rows would be silently skipped. If the ledger no longer has
        # the full (lo, hi] range (e.g. state.db was restored/replaced out of sync
        # with the cursor file), refuse to advance and surface an error — never
        # fake-success the pending batch forward.
        if not page or page[-1][0] != hi:
            got = page[-1][0] if page else None
            result.errors.append(
                f"pending range ({lo}, {hi}] is not fully present in the ledger "
                f"(got {len(page)} rows up to seq {got}); refusing to advance the "
                "telemetry cursor — local state may be out of sync with the cost ledger"
            )
            return False
        return self._post_page(page, consent, result)

    def _post_page(
        self, page: list[Any], consent: ConsentState, result: UploadResult
    ) -> bool:
        events = [event for _s, event in page]
        rows = [self._project_cost(e) for e in events]
        event_ids = [_event_id(e) for e in events]
        envelope = {
            "schema_version": SCHEMA_VERSION,
            "upload_id": _deterministic_upload_id(consent.device_id, "A", event_ids),
            "device_id": consent.device_id,
            "tier": "A",
            "agreement_version": consent.agreement_version,
            "rows": rows,
        }
        try:
            ack = self._post(envelope)
        except UploadError as exc:
            result.errors.append(str(exc))
            return False
        status = ack.get("status")
        if status == "duplicate":
            result.duplicates += 1
        elif status != "accepted":
            result.errors.append(f"server rejected batch: {ack.get('reason')}")
            return False
        result.batches += 1
        result.rows += len(rows)
        return True

    # -- Tier B (diagnostic receipts) -----------------------------------------
    #
    # Mirrors the Tier A cursor/paging shape but with one critical difference:
    # receipts are subject to RETENTION (lossy diagnostics), so interior ids can
    # vanish between cursor saves. Tier A's ``_send_range`` fails closed when a
    # pending range can't be reconstructed EXACTLY (cost_events is append-only, so
    # a gap there means corruption). Tier B must NOT do that — a gap is expected.
    # Dedupe is ROW-LEVEL (server (device_id, receipt_uid) ON CONFLICT) plus a
    # CONTENT-keyed batch upload_id, so a retention-thinned / restored re-send neither
    # double-inserts survivors nor drops new rows that happen to reuse old ids. (The
    # id range here is only the cursor envelope, not the dedupe key.)
    def _upload_tier_b(
        self,
        result: UploadResult,
        *,
        tick_end: int,
        max_batches: int | None,
        max_seconds: float | None,
    ) -> None:
        from . import diagnostics_store as _ds

        acked, pending = self._load_spool_state("B")
        consent = self.consent()
        t0 = self._clock()

        # 1. Re-send the in-flight (acked, pending] window FIRST. Retention-tolerant:
        #    the surviving rows may be fewer (or none), and each one dedupes server-
        #    side on its receipt_uid.
        #    A READ FAILURE here must NOT advance the cursor (the rows may still
        #    exist and be readable next tick) — only an empty result on a SUCCESSFUL
        #    read means the range was genuinely pruned.
        if pending is not None and pending > acked:
            try:
                page = _ds.list_receipts_after_seq(
                    acked, until_seq=pending, path=self._diagnostics_path
                )
            except Exception as exc:  # noqa: BLE001 - read failure is non-fatal, non-advancing
                result.errors.append(f"read receipts ledger failed: {exc}")
                return
            # Only post when there is something to send. An empty (successful) read
            # means the pending rows were pruned (or already landed and deduped on
            # their receipt_uid) — just advance; never emit a 0-row batch.
            if page and not self._post_tier_b_page(page, consent, result):
                return  # still failing — leave pending for the next attempt
            acked = pending
            self._save_spool_state("B", acked, None)

        # 2. Drain (acked, tick_end] in pages of max_batch_rows.
        batches = 0
        while acked < tick_end:
            if max_batches is not None and batches >= max_batches:
                break
            if max_seconds is not None and (self._clock() - t0) >= max_seconds:
                break
            try:
                page = _ds.list_receipts_after_seq(
                    acked,
                    limit=self._cfg.max_batch_rows,
                    until_seq=tick_end,
                    path=self._diagnostics_path,
                )
            except Exception as exc:  # noqa: BLE001 - read failure must NOT advance cursor
                result.errors.append(f"read receipts ledger failed: {exc}")
                return
            if not page:
                # A SUCCESSFUL read of an empty window: the whole (acked, tick_end]
                # range was pruned by retention. Don't spin on a permanently-empty
                # gap — advance the cursor to tick_end. (A read FAILURE returned
                # above without advancing, so this branch never masks one.)
                self._save_spool_state("B", tick_end, None)
                acked = tick_end
                break
            end = page[-1][0]
            # Persist the in-flight boundary BEFORE posting, so a crash re-sends the
            # SAME (acked, end] range next run (stable upload_id → reliable dedup).
            self._save_spool_state("B", acked, end)
            if not self._post_tier_b_page(page, consent, result):
                return  # leave pending=end recorded for retry
            acked = end
            self._save_spool_state("B", acked, None)
            batches += 1

    def _post_tier_b_page(
        self,
        page: list[tuple[int, dict[str, Any]]],
        consent: ConsentState,
        result: UploadResult,
    ) -> bool:
        rows = [_project_receipt(row) for _seq, row in page]
        # upload_id is keyed off the page's receipt_uids (content), NOT a (lo,hi) id
        # range. Range-only would make a post-reincarnation re-send of NEW receipts
        # that happen to reuse old ids collide with the old batch's upload_id and be
        # dropped as a duplicate. receipt_uid is stable per receipt: a crash retry of
        # the same page dedupes at batch level; a retention-thinned or restored send
        # differs and falls through to the server's row-level (device_id, receipt_uid)
        # dedupe — so neither double-inserts nor silently drops.
        receipt_uids = [str(r.get("receipt_uid") or "") for r in rows]
        envelope = {
            "schema_version": SCHEMA_VERSION,
            "upload_id": _deterministic_upload_id(consent.device_id, "B", receipt_uids),
            "device_id": consent.device_id,
            "tier": "B",
            "agreement_version": consent.agreement_version,
            "rows": rows,
        }
        try:
            ack = self._post(envelope)
        except UploadError as exc:
            result.errors.append(str(exc))
            return False
        status = ack.get("status")
        if status == "duplicate":
            result.duplicates += 1
        elif status != "accepted":
            result.errors.append(f"server rejected tier-B batch: {ack.get('reason')}")
            return False
        result.batches += 1
        result.rows += len(rows)
        return True

    # -- Tier C (raw payloads, envelope-encrypted) ----------------------------
    #
    # Source = a private spool DIRECTORY (base_dir/tier-c-spool/*.json), one file
    # per raw payload, written by the (owner-gated, separately-approved) recording
    # layer — NOT created here. Each file is sealed client-side (zero-knowledge) and
    # uploaded; the server only ever sees ciphertext. FAIL-CLOSED: with no baked
    # public key there is nothing to seal under, so Tier C stays entirely inert.
    #
    # Idempotency is FILE-scoped: upload_id = H(device, "C", file_id), keyed off the
    # stable spool filename, NOT the (randomized) ciphertext. So a crash between a
    # successful POST and the file unlink re-sends under the same upload_id and the
    # server dedupes — a fresh CEK/nonce on re-seal never causes a double-insert.
    _TIER_C_SPOOL_DIRNAME = "tier-c-spool"

    def _upload_tier_c(
        self,
        result: UploadResult,
        *,
        max_batches: int | None,
        max_seconds: float | None,
    ) -> None:
        from . import telemetry_envelope

        public_key = self._cfg.tier_c_public_key
        # fail-closed: no key, OR a misconfigured/swapped key (private/non-RSA/weak/
        # junk) => Tier C stays entirely inert. Validating here (not just at seal
        # time) keeps a bad config from churning the spool dir every tick.
        if not public_key or not telemetry_envelope.is_public_key_pem(public_key):
            return
        spool_dir = self._cfg.base_dir / self._TIER_C_SPOOL_DIRNAME
        if not spool_dir.is_dir():
            return
        consent = self.consent()
        t0 = self._clock()
        batches = 0
        for path in sorted(spool_dir.glob("*.json")):
            if max_batches is not None and batches >= max_batches:
                break
            if max_seconds is not None and (self._clock() - t0) >= max_seconds:
                break
            try:
                record = json.loads(path.read_text(encoding="utf-8"))
                plaintext = base64.b64decode(record["plaintext_b64"], validate=True)
            except (OSError, ValueError, KeyError, TypeError) as exc:
                # A malformed/poison spool file must not wedge the queue forever.
                # Tier C is lossy (7-day TTL); drop it with a recorded error rather
                # than retry it every tick.
                result.errors.append(f"tier-C spool {path.name} unreadable, dropped: {exc}")
                self._unlink_quietly(path)
                continue
            if not self._post_tier_c_file(path.stem, record, plaintext, public_key, consent, result):
                return  # network failing — leave the file for the next attempt
            self._unlink_quietly(path)
            batches += 1

    def _post_tier_c_file(
        self,
        file_id: str,
        record: dict[str, Any],
        plaintext: bytes,
        public_key: str,
        consent: ConsentState,
        result: UploadResult,
    ) -> bool:
        from . import telemetry_envelope
        from .condition_manifest import _scrub_scalar

        try:
            sealed = telemetry_envelope.seal(plaintext, public_key)
        except telemetry_envelope.EnvelopeError as exc:
            # A seal failure (e.g. a misconfigured/!RSA baked key) is non-fatal but
            # must NOT drop the payload — leave the file for a fixed-config retry.
            result.errors.append(f"tier-C seal {file_id} failed: {exc}")
            return False
        row = {
            **sealed,  # ciphertext_b64, nonce_b64, wrapped_cek_b64, key_id
            # Correlation/routing columns ride ALONGSIDE the ciphertext in cleartext,
            # so guard them like any other leaving-the-machine scalar. ttl is a
            # NUMERIC epoch — coerce it so a spool file can't smuggle free text / a
            # path through an unscrubbed column.
            "trace_id": _scrub_scalar(record.get("trace_id")),
            "run_id": _scrub_scalar(record.get("run_id")),
            "payload_kind": _scrub_scalar(record.get("payload_kind")),
            "ttl_expires_at": _coerce_epoch(record.get("ttl_expires_at")),
        }
        # Idempotency key binds the file id AND a hash of its plaintext. file id
        # alone is unsafe: a recording layer that REUSES a filename for different
        # content would otherwise collide on upload_id, the server would dedupe the
        # second payload, and the client would unlink it — a silent drop. Binding
        # the content hash makes same-name/same-content re-sends dedupe (crash
        # recovery) while same-name/different-content uploads stay distinct.
        content_key = f"{file_id}:{hashlib.sha256(plaintext).hexdigest()}"
        envelope = {
            "schema_version": SCHEMA_VERSION,
            "upload_id": _deterministic_upload_id(consent.device_id, "C", [content_key]),
            "device_id": consent.device_id,
            "tier": "C",
            "agreement_version": consent.agreement_version,
            "rows": [row],
        }
        try:
            ack = self._post(envelope)
        except UploadError as exc:
            result.errors.append(str(exc))
            return False
        status = ack.get("status")
        if status == "duplicate":
            result.duplicates += 1
        elif status != "accepted":
            result.errors.append(f"server rejected tier-C batch: {ack.get('reason')}")
            return False
        result.batches += 1
        result.rows += 1
        return True

    @staticmethod
    def _unlink_quietly(path: Path) -> None:
        try:
            path.unlink()
        except FileNotFoundError:
            pass
        except OSError as exc:  # pragma: no cover - rare fs error
            logger.warning("could not remove tier-C spool file %s: %s", path, exc)

    # -- local exclusion (one spooler per base_dir at a time) -----------------
    @contextlib.contextmanager
    def _spool_lock(self) -> Iterator[bool]:
        """Best-effort advisory lock so two concurrent spoolers can't double-send
        (server dedup also protects, but the lock avoids the wasted work and any
        cursor race). Yields True if held, False if another holds it. Where
        ``fcntl`` is unavailable, proceeds without a lock."""
        if fcntl is None:  # pragma: no cover - non-POSIX
            yield True
            return
        path = self._cfg.base_dir / LOCK_FILE
        fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
        try:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                yield False
                return
            yield True
        finally:
            with contextlib.suppress(OSError):
                fcntl.flock(fd, fcntl.LOCK_UN)
            os.close(fd)

    def _project_cost(self, event: Any) -> dict[str, Any]:
        data = event.to_dict() if hasattr(event, "to_dict") else dict(event)
        run_id = data.get("run_id")
        wire = {
            "trace_id": data.get("trace_id") or run_id,
            "run_id": run_id,
            "meter_kind": data.get("meter_kind"),
            "backend": data.get("backend"),
            "provider": data.get("provider"),
            "model": data.get("model"),
            "input_tokens": data.get("input_tokens"),
            "output_tokens": data.get("output_tokens"),
            "cost_cents": data.get("cost_cents"),
            "duration_seconds": data.get("duration_seconds"),
            "status": data.get("status"),
            "billing_lane": data.get("billing_lane"),
            "occurred_at": data.get("occurred_at"),
        }
        out = {k: _scrub(v) for k, v in wire.items()}
        # event_id is the row-level idempotency key — a kernel-generated id kept
        # verbatim (not scrubbed) so the server's (device_id, event_id) dedupe stays
        # stable across a post-reincarnation re-scan.
        out["event_id"] = str(data.get("event_id")) if data.get("event_id") else None
        return out

    # -- network choke point --------------------------------------------------
    def _post(self, envelope: dict[str, Any]) -> dict[str, Any]:
        url = f"{self._cfg.endpoint}/v1/telemetry/ingest"
        try:
            return self._poster(url, envelope, self._cfg.token)
        except Exception as exc:  # noqa: BLE001 - normalize to non-fatal UploadError
            raise UploadError(f"upload to {url} failed: {exc}") from exc

    # -- cursor state ---------------------------------------------------------
    def _load_spool_state(self, tier: str) -> tuple[int, int | None]:
        """Return ``(acked_seq, pending_end_seq)`` for ``tier``. Migrates the
        legacy ``{"seq": N}`` shape to ``acked_seq`` transparently."""
        entry = self._read_state().get(tier, {})
        acked_raw = entry.get("acked_seq", entry.get("seq", 0))
        try:
            acked = int(acked_raw)
        except (TypeError, ValueError):
            acked = 0
        pending_raw = entry.get("pending_end_seq")
        pending: int | None
        try:
            pending = int(pending_raw) if pending_raw is not None else None
        except (TypeError, ValueError):
            pending = None
        return (acked, pending)

    def _save_spool_state(self, tier: str, acked_seq: int, pending_end_seq: int | None) -> None:
        raw = self._read_state()
        prev = raw.get(tier, {})
        try:
            prev_acked = int(prev.get("acked_seq", prev.get("seq", 0)) or 0)
        except (TypeError, ValueError):
            prev_acked = 0
        # acked_seq is monotonic — never let a stale value regress it (the lock
        # serializes single-host spoolers; this is belt-and-suspenders).
        acked = max(int(acked_seq), prev_acked)
        raw[tier] = {
            "acked_seq": acked,
            "pending_end_seq": (int(pending_end_seq) if pending_end_seq is not None else None),
            # Preserve the DB-incarnation binding set by _reconcile_cursor — a normal
            # save must not drop it, or every tick would look like a reincarnation.
            "db_incarnation": prev.get("db_incarnation"),
        }
        _write_private(self._cfg.base_dir / CURSOR_FILE, raw)

    def _load_incarnation(self, tier: str) -> str | None:
        value = self._read_state().get(tier, {}).get("db_incarnation")
        return value if isinstance(value, str) else None

    def _reset_spool_state(self, tier: str, db_incarnation: str | None) -> None:
        """Reset a tier's cursor to (0, None) and re-bind it to ``db_incarnation``.
        Deliberately BYPASSES _save_spool_state's monotonic max() guard: a
        reincarnation REQUIRES regressing acked to 0 so the new DB is re-scanned from
        the start (the guard exists to stop stale regressions, which is the opposite
        case)."""
        raw = self._read_state()
        raw[tier] = {"acked_seq": 0, "pending_end_seq": None, "db_incarnation": db_incarnation}
        _write_private(self._cfg.base_dir / CURSOR_FILE, raw)

    def _bind_incarnation(self, tier: str, db_incarnation: str) -> None:
        """Record the DB incarnation on an EXISTING cursor without touching its
        acked/pending — the upgrade case (cursor predates the guard). Unlike
        _reset_spool_state (which zeroes the cursor for a genuine reincarnation), this
        preserves valid upload progress so no legacy row is re-scanned/duplicated."""
        raw = self._read_state()
        entry = dict(raw.get(tier, {}))
        try:
            acked = int(entry.get("acked_seq", entry.get("seq", 0)) or 0)
        except (TypeError, ValueError):
            acked = 0
        pending_raw = entry.get("pending_end_seq")
        try:
            pending = int(pending_raw) if pending_raw is not None else None
        except (TypeError, ValueError):
            pending = None
        raw[tier] = {"acked_seq": acked, "pending_end_seq": pending, "db_incarnation": db_incarnation}
        _write_private(self._cfg.base_dir / CURSOR_FILE, raw)

    def _reconcile_cursor(self, tier: str, db_incarnation: str | None, max_seq: int) -> None:
        """Before uploading a tier, detect a reincarnated / rolled-back DB and reset
        the cursor so the new DB is re-scanned from 0 (server idempotency — upload_id
        + row-level keys — stops double-insert). Two independent signals:
          * the DB's incarnation uuid differs from the one the cursor tracked
            (delete+recreate, or restore to a different instance), OR
          * the cursor sits ABOVE the DB's current max seq (rollback / restore to an
            older snapshot whose ids regressed).
        Red line: a None incarnation (legacy DB, or an unreadable one) means we can't
        confirm the DB's identity, so we NEVER reset — neither on incarnation nor on
        the seq check. Resetting on a transient read failure would wipe a healthy
        cursor. Only a CONFIRMED incarnation read enables the seq-regression check."""
        if db_incarnation is None:
            return
        acked, pending = self._load_spool_state(tier)
        stored = self._load_incarnation(tier)
        if stored is None:
            # The cursor predates the incarnation guard (an UPGRADE) or is brand new.
            # Its acked is valid progress against THIS db — BIND the incarnation
            # without resetting. Resetting here would re-scan and double-insert legacy
            # rows that the pre-upgrade (range-keyed) upload_id can't dedupe and whose
            # server-side row-level id is NULL. A genuine reincarnation is only ever a
            # cursor that ALREADY tracked a *different* incarnation (handled below).
            self._bind_incarnation(tier, db_incarnation)
            return
        reason: str | None = None
        if stored != db_incarnation:
            reason = "db reincarnated (incarnation changed)"
        elif acked > max_seq or (pending is not None and pending > max_seq):
            reason = "cursor above DB max seq (rollback/restore)"
        if reason is not None:
            self._reset_spool_state(tier, db_incarnation)
            logger.info("telemetry tier-%s cursor reset: %s; re-scanning from 0", tier, reason)

    def _read_state(self) -> dict[str, Any]:
        path = self._cfg.base_dir / CURSOR_FILE
        if not path.exists():
            return {}
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        return raw if isinstance(raw, dict) else {}

    def _clear_cursor(self) -> None:
        path = self._cfg.base_dir / CURSOR_FILE
        try:
            path.unlink()
        except FileNotFoundError:
            pass
        except OSError as exc:
            logger.warning("could not clear telemetry cursor: %s", exc)

    def _ensure_device_id(self) -> str:
        # Stable, persisted identity — required for deterministic upload_id dedup
        # even when telemetry is enabled purely via env (no consent file written).
        consent_path = self._cfg.base_dir / CONSENT_FILE
        if consent_path.exists():
            try:
                raw = json.loads(consent_path.read_text(encoding="utf-8"))
                existing = raw.get("device_id")
                if existing:
                    return str(existing)
            except (OSError, ValueError):
                pass
        device_path = self._cfg.base_dir / DEVICE_FILE
        if device_path.exists():
            try:
                stored = device_path.read_text(encoding="utf-8").strip()
                if stored:
                    return stored
            except OSError:
                pass
        device_id = secrets.token_hex(16)
        try:
            device_path.parent.mkdir(parents=True, exist_ok=True)
            # Write a private temp file FULLY, then os.link it onto the final
            # path. link(2) is atomic and fails if the target exists, so the
            # final path only ever appears already-complete: a racing reader can
            # never observe an empty file (the O_EXCL-on-final approach had that
            # read-before-write window). Loser links-fails, reads the winner's
            # complete id ⇒ a single stable identity.
            tmp = device_path.with_name(
                f"{device_path.name}.{os.getpid()}.{secrets.token_hex(4)}.tmp"
            )
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as fh:
                    fh.write(device_id)
                try:
                    os.link(tmp, device_path)
                except FileExistsError:
                    pass
            finally:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
        except OSError as exc:
            logger.warning("could not persist device id: %s", exc)
            return device_id
        try:
            return device_path.read_text(encoding="utf-8").strip() or device_id
        except OSError:
            return device_id


# -- module helpers -----------------------------------------------------------
def _httpx_poster(timeout: float) -> _Poster:
    def _post(url: str, payload: dict[str, Any], token: str) -> dict[str, Any]:
        import httpx  # noqa: PLC0415 - the single allowed network import

        headers = {"content-type": "application/json"}
        if token:
            headers["authorization"] = f"Bearer {token}"
        # trust_env=False + no redirects: don't leak via ambient proxy / redirect.
        with httpx.Client(timeout=timeout, trust_env=False, follow_redirects=False) as client:
            resp = client.post(url, json=payload, headers=headers)
            resp.raise_for_status()
            return resp.json()

    return _post


def _scrub(value: Any) -> Any:
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return redact_secrets(value)
    return "<non-scalar>"


def _coerce_epoch(value: Any) -> float | None:
    """Force a spool-provided ttl/timestamp to a number; drop anything else to None.
    A Tier C ttl column is cleartext on the wire, so a str/path/container here would
    bypass scrubbing — coerce it to a float or nothing (bool is not a timestamp)."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def _deterministic_upload_id(device_id: str, tier: str, event_ids: list[str]) -> str:
    material = "|".join([device_id, tier, *sorted(event_ids)]).encode("utf-8")
    return hmac.new(device_id.encode("utf-8"), material, hashlib.sha256).hexdigest()


# Receipt kind -> how its redacted payload maps onto the server's tier_b WIDE-TABLE
# columns. The tier_b schema is a superset designed for many receipt shapes; the
# kinds a build actually emits fill a subset, and the payload keys are NOT the same
# names as the columns (e.g. payload "error_type" -> column "exception_type"). Keep
# this mapping explicit and conservative: an unmapped column stays None, and an
# unknown kind contributes only the common correlation columns (never guesses).
def _project_receipt(row: dict[str, Any]) -> dict[str, Any]:
    """Project one redacted receipt row onto the tier_b wire columns. Values are
    already allowlist-redacted at record time, but this batch leaves the machine, so
    every payload-derived FREE-TEXT column gets the FULL P1 scalar guard
    (``_scrub_scalar``): whitespace → ``<redacted>``, path/URL/drive/UNC →
    ``<path-redacted>``. ``_scrub`` (secret-only) is NOT enough — a span ``error`` or
    governance ``reason`` can carry a cleartext path / command / user sentence. The
    remote sink must never be protected more weakly than the local diagnose bundle
    (which already re-scrubs these via ``_scrub_scalar``). Never raises — a malformed
    payload degrades to the common columns."""
    from .condition_manifest import _scrub_scalar

    raw_payload = row.get("payload")
    payload: dict[str, Any]
    if isinstance(raw_payload, str):
        try:
            decoded = json.loads(raw_payload)
        except ValueError:
            decoded = {}
        payload = decoded if isinstance(decoded, dict) else {}
    elif isinstance(raw_payload, dict):
        payload = raw_payload
    else:
        payload = {}

    kind = row.get("kind")
    wire: dict[str, Any] = {
        # Stable per-receipt id — the server's row-level idempotency key. Carried so a
        # retention-thinned / post-reincarnation re-send dedupes per row, not per range.
        "receipt_uid": row.get("receipt_uid"),
        "trace_id": row.get("trace_id"),
        "run_id": row.get("run_id"),
        "span_id": row.get("span_id"),
        "parent_span_id": row.get("parent_span_id"),
        "receipt_class": row.get("receipt_class"),
        "kind": kind,
        "occurred_at": row.get("occurred_at"),
        # payload-derived (kind-specific); None unless the mapping below fills them.
        "decision_code": None,
        "summary": None,
        "duration_ms": None,
        "exit_code": None,
        "retry_count": None,
        "exception_type": None,
        "stack_redacted": None,
        "media_kind": None,
        "media_size_bytes": None,
    }
    if kind in ("span.start", "span.end", "span.error"):
        wire["summary"] = _scrub_scalar(payload.get("name"))
        wire["duration_ms"] = payload.get("duration_ms")
        wire["exception_type"] = _scrub_scalar(payload.get("error_type"))
        wire["stack_redacted"] = _scrub_scalar(payload.get("error"))
    elif kind == "governance.decision":
        wire["decision_code"] = _scrub_scalar(payload.get("decision"))
        wire["summary"] = _scrub_scalar(payload.get("reason"))
    # diagnostic_loss and any unknown/undeclared kind: common columns only.
    return wire


def _event_id(event: Any) -> str:
    if hasattr(event, "event_id"):
        return str(event.event_id)
    if isinstance(event, dict):
        return str(event.get("event_id", ""))
    return ""


def _occurred_at(event: Any) -> float:
    value = getattr(event, "occurred_at", None)
    if value is None and isinstance(event, dict):
        value = event.get("occurred_at")
    try:
        return float(value) if value is not None else 0.0
    except (TypeError, ValueError):
        return 0.0


def _write_private(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # Unique temp name (pid + random) so a concurrent CLI/daemon writer can't
    # clobber a shared ".tmp"; O_EXCL|0600 closes the umask race (no 0644 window
    # between create and chmod). os.replace is the atomic publish.
    tmp = path.with_name(f"{path.name}.{os.getpid()}.{secrets.token_hex(4)}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=2)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    os.replace(tmp, path)


def _truthy(value: str | None) -> bool:
    return bool(value) and value.strip().lower() in ("1", "true", "yes", "on")


def _int(value: str | None, default: int) -> int:
    try:
        return int(value) if value not in (None, "") else default
    except (TypeError, ValueError):
        return default


def _float(value: str | None, default: float) -> float:
    try:
        return float(value) if value not in (None, "") else default
    except (TypeError, ValueError):
        return default
