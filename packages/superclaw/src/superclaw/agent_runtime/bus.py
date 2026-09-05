"""In-process event bus (doorbell) for run events.

Why this exists
---------------
The legacy SSE path polled SQLite every 50ms and re-read the whole ``events``
table on each tick (``apps/api/main.py`` ``get_events``). That sets a hard
latency floor and makes read cost grow with event count.

This bus removes the poll floor without making SQLite stop being the source of
truth. It is intentionally a *doorbell*: a publisher rings ``notify(run_id)``
after an event is durably committed, and a subscriber blocked in ``wait(...)``
wakes immediately and reads the new rows from SQLite by id (cheap, indexed).

Design notes
------------
- Per-subscriber queue with ``maxsize=1`` coalesces bursts: many notifications
  during one processing pass collapse to a single pending wake, which is correct
  because the subscriber re-reads *all* new rows by id after waking.
- The bus carries no payload. SQLite stays the single source of truth, so there
  is no dedup or phantom-event risk if a transaction rolls back.
- Best-effort: a missed notify is bounded by the subscriber's safety timeout, so
  correctness never depends on delivery.
- Thread-safe: publishers run on orchestrator worker threads; subscribers run on
  API request threads; both share one process.
"""

from __future__ import annotations

import queue
import threading


class EventBus:
    """Fan-out doorbell keyed by ``run_id``."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._subscribers: dict[str, set[queue.Queue]] = {}

    def subscribe(self, run_id: str) -> "Subscription":
        """Register interest in a run and return a Subscription to wait on."""
        signal: queue.Queue = queue.Queue(maxsize=1)
        with self._lock:
            self._subscribers.setdefault(run_id, set()).add(signal)
        return Subscription(self, run_id, signal)

    def notify(self, run_id: str) -> None:
        """Wake every subscriber for ``run_id`` (coalesced, non-blocking)."""
        with self._lock:
            signals = list(self._subscribers.get(run_id, ()))
        for signal in signals:
            try:
                signal.put_nowait(None)
            except queue.Full:
                # A wake is already pending; coalesce. The subscriber re-reads
                # all new rows by id when it wakes, so one token is enough.
                pass

    def _unsubscribe(self, run_id: str, signal: "queue.Queue") -> None:
        with self._lock:
            signals = self._subscribers.get(run_id)
            if signals is None:
                return
            signals.discard(signal)
            if not signals:
                self._subscribers.pop(run_id, None)

    def subscriber_count(self, run_id: str) -> int:
        """Number of active subscribers for a run (test/observability helper)."""
        with self._lock:
            return len(self._subscribers.get(run_id, ()))


class Subscription:
    """A single subscriber's handle. Use as a context manager or call close()."""

    def __init__(self, bus: EventBus, run_id: str, signal: "queue.Queue") -> None:
        self._bus = bus
        self._run_id = run_id
        self._signal = signal
        self._closed = False

    def wait(self, timeout: float | None = None) -> bool:
        """Block until notified or until ``timeout`` seconds elapse.

        Returns True if woken by a notify, False on timeout. Either way the
        caller should re-read new rows from the source of truth by id.
        """
        try:
            self._signal.get(timeout=timeout)
            return True
        except queue.Empty:
            return False

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._bus._unsubscribe(self._run_id, self._signal)

    def __enter__(self) -> "Subscription":
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()
