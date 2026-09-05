"""DB incarnation id — a stable per-database-instance fingerprint.

The telemetry upload cursor stores a monotonic seq watermark per ledger. If a DB
is deleted/recreated/restored to a different instance ("reincarnation"), its
rowids reset to 1 while the cursor still holds the old high watermark — so new
rows (seq < watermark) are never uploaded: silent under-collection.

The guard: stamp each DB with a random uuid in a tiny meta table at creation, and
have the cursor remember which incarnation it was tracking. When they differ (or
the watermark sits above the DB's current max seq — a rollback/restore signal),
the cursor is reset and the ledger re-scanned from 0; server-side idempotency
(upload_id / row-level keys) keeps the re-scan from double-inserting.

This module is the single source of that uuid for BOTH ledgers (state.db cost
events, telemetry.db receipts). Stdlib-only, no superclaw imports — safe to use
from the low-level store __init__ paths.
"""
from __future__ import annotations

import sqlite3
import uuid

_META_TABLE = "superclaw_db_meta"
_INCARNATION_KEY = "incarnation_uuid"


def ensure_incarnation(conn: sqlite3.Connection) -> str:
    """Create the meta table if absent and return this DB's incarnation uuid,
    minting one only when none exists. IDEMPOTENT and NON-overwriting: an existing
    uuid is never replaced — that is the whole point, it must change ONLY when the
    database file is genuinely recreated, not on every open or migration."""
    conn.execute(
        f"CREATE TABLE IF NOT EXISTS {_META_TABLE} (k TEXT PRIMARY KEY, v TEXT NOT NULL)"
    )
    row = conn.execute(
        f"SELECT v FROM {_META_TABLE} WHERE k = ?", (_INCARNATION_KEY,)
    ).fetchone()
    if row is not None:
        return row[0]
    value = uuid.uuid4().hex
    # INSERT OR IGNORE: a concurrent creator may have won the race; re-read to
    # return whatever value actually landed, so all callers agree.
    conn.execute(
        f"INSERT OR IGNORE INTO {_META_TABLE} (k, v) VALUES (?, ?)",
        (_INCARNATION_KEY, value),
    )
    row = conn.execute(
        f"SELECT v FROM {_META_TABLE} WHERE k = ?", (_INCARNATION_KEY,)
    ).fetchone()
    return row[0] if row is not None else value


def read_incarnation(conn: sqlite3.Connection) -> str | None:
    """Return the DB's incarnation uuid, or None if the meta table / row is absent
    or unreadable. Read-only; never creates anything; never raises."""
    try:
        row = conn.execute(
            f"SELECT v FROM {_META_TABLE} WHERE k = ?", (_INCARNATION_KEY,)
        ).fetchone()
    except sqlite3.Error:
        return None
    return row[0] if row is not None else None
