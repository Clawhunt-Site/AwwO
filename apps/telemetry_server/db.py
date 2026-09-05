"""Dialect-aware persistence for the collection server (SQLite ⇄ PostgreSQL).

One SQL surface, two backends, selected purely by ``TELEMETRY_DATABASE_URL``:

* ``sqlite:///path``   → Python stdlib ``sqlite3`` (zero-install local mock).
* ``postgresql://...`` → ``psycopg`` (production; imported lazily so local dev
  needs nothing installed).

The only dialect differences are isolated in ``_Dialect``: parameter
placeholder (``?`` vs ``%s``), auto-increment PK, and binary column type. Time
is stored as an epoch float everywhere to dodge TZ-type divergence. Batch-level
idempotency is enforced by a UNIQUE ``uploads.upload_id`` — a re-sent batch
raises ``IntegrityError`` and is reported as a duplicate (effectively-once).
"""
from __future__ import annotations

import base64
import re
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

# PostgreSQL dollar-quote opening tag: $$ or $tag$ (tag = identifier chars).
_DOLLAR_TAG = re.compile(r"\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$")

# Tier B carries the media descriptor cards too (see upload spooler); Tier C is
# always encrypted envelope bytes — the server is zero-knowledge.
TIERS = ("A", "B", "C")


class DatabaseError(RuntimeError):
    """Persistence layer failure (connection / schema / write)."""


@dataclass(frozen=True)
class _Dialect:
    name: str  # "sqlite" | "postgres"
    autoincrement_pk: str
    binary_type: str

    def sql(self, statement: str) -> str:
        """Translate the canonical ``?`` placeholders to the backend's style.

        Lexer-aware: only ``?`` OUTSIDE string literals becomes ``%s``. Both
        single-quoted literals (with ``''`` escapes) and PostgreSQL
        dollar-quoted literals (``$tag$...$tag$``) are skipped, so a legitimate
        literal ``?`` (e.g. ``LIKE '%?%'`` or ``$$?$$``) is never corrupted.
        """
        if self.name != "postgres":
            return statement
        out: list[str] = []
        i, n = 0, len(statement)
        while i < n:
            ch = statement[i]
            if ch == "'":
                out.append(ch)
                i += 1
                while i < n:
                    out.append(statement[i])
                    if statement[i] == "'":
                        if i + 1 < n and statement[i + 1] == "'":  # '' escape
                            out.append(statement[i + 1])
                            i += 2
                            continue
                        i += 1
                        break
                    i += 1
                continue
            if ch == "$":
                m = _DOLLAR_TAG.match(statement, i)
                if m:
                    tag = m.group(0)
                    end = statement.find(tag, m.end())
                    if end != -1:
                        stop = end + len(tag)
                        out.append(statement[i:stop])
                        i = stop
                        continue
                    # Unterminated dollar-quote (malformed SQL): do NOT swallow
                    # the rest as a literal — fall through and keep scanning so
                    # real placeholders after it still translate.
            if ch == "?":
                out.append("%s")
                i += 1
                continue
            out.append(ch)
            i += 1
        return "".join(out)


def _sqlite_path(database_url: str) -> Path:
    # sqlite:///relative.db  or  sqlite:////abs/path.db
    rest = database_url[len("sqlite://"):]
    if rest.startswith("/"):
        rest = rest[1:]
    return Path(rest).expanduser()


class Database:
    """Thin connection factory + schema + typed write/read helpers."""

    def __init__(self, database_url: str) -> None:
        self.database_url = database_url
        self._integrity_cache: tuple[type[Exception], ...] | None = None
        if database_url.startswith("sqlite://"):
            self._kind = "sqlite"
            self._sqlite_path = _sqlite_path(database_url)
            self.dialect = _Dialect(
                name="sqlite",
                autoincrement_pk="INTEGER PRIMARY KEY AUTOINCREMENT",
                binary_type="BLOB",
            )
        elif database_url.startswith(("postgresql://", "postgres://")):
            self._kind = "postgres"
            self.dialect = _Dialect(
                name="postgres",
                autoincrement_pk="BIGSERIAL PRIMARY KEY",
                binary_type="BYTEA",
            )
        else:
            raise DatabaseError(
                f"unsupported TELEMETRY_DATABASE_URL scheme: {database_url!r} "
                "(use sqlite:/// or postgresql://)"
            )

    def _integrity_errors(self) -> tuple[type[Exception], ...]:
        # Lazy: constructing a postgres Database must NOT require psycopg (the
        # dialect/SQL translation is usable without it); the driver is only
        # needed once we actually connect / write.
        if self._integrity_cache is not None:
            return self._integrity_cache
        if self._kind == "sqlite":
            self._integrity_cache = (sqlite3.IntegrityError,)
            return self._integrity_cache
        try:
            import psycopg  # noqa: PLC0415 (lazy: prod-only dependency)
        except ImportError as exc:  # pragma: no cover - exercised only in prod
            raise DatabaseError(
                "postgresql:// URL requires the 'psycopg' package "
                "(pip install psycopg[binary]); not needed for local sqlite."
            ) from exc
        self._integrity_cache = (psycopg.errors.IntegrityError,)
        return self._integrity_cache

    def connect(self) -> Any:
        if self._kind == "sqlite":
            self._sqlite_path.parent.mkdir(parents=True, exist_ok=True)
            conn = sqlite3.connect(self._sqlite_path, timeout=10.0)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA journal_mode = WAL")
            conn.execute("PRAGMA busy_timeout = 10000")
            return conn
        import psycopg  # noqa: PLC0415
        from psycopg.rows import dict_row  # noqa: PLC0415

        return psycopg.connect(self.database_url, row_factory=dict_row)

    # -- schema ---------------------------------------------------------------
    def init_schema(self) -> None:
        pk = self.dialect.autoincrement_pk
        binary = self.dialect.binary_type
        ddl = [
            """CREATE TABLE IF NOT EXISTS uploads (
                upload_id TEXT PRIMARY KEY,
                device_id TEXT NOT NULL,
                tier TEXT NOT NULL,
                agreement_version TEXT,
                row_count INTEGER NOT NULL,
                received_at DOUBLE PRECISION NOT NULL
            )""",
            f"""CREATE TABLE IF NOT EXISTS tier_a (
                id {pk},
                upload_id TEXT NOT NULL,
                device_id TEXT NOT NULL,
                event_id TEXT,
                trace_id TEXT, run_id TEXT,
                meter_kind TEXT, backend TEXT, provider TEXT, model TEXT,
                input_tokens BIGINT, output_tokens BIGINT,
                cost_cents DOUBLE PRECISION, duration_seconds DOUBLE PRECISION,
                status TEXT, billing_lane TEXT,
                occurred_at DOUBLE PRECISION, received_at DOUBLE PRECISION NOT NULL
            )""",
            f"""CREATE TABLE IF NOT EXISTS tier_b (
                id {pk},
                upload_id TEXT NOT NULL,
                device_id TEXT NOT NULL,
                receipt_uid TEXT,
                trace_id TEXT, run_id TEXT, span_id TEXT, parent_span_id TEXT,
                receipt_class TEXT, kind TEXT, decision_code TEXT,
                summary TEXT,
                duration_ms BIGINT, exit_code INTEGER, retry_count INTEGER,
                exception_type TEXT, stack_redacted TEXT,
                media_kind TEXT, media_size_bytes BIGINT,
                occurred_at DOUBLE PRECISION, received_at DOUBLE PRECISION NOT NULL
            )""",
            f"""CREATE TABLE IF NOT EXISTS tier_c (
                id {pk},
                upload_id TEXT NOT NULL,
                device_id TEXT NOT NULL,
                trace_id TEXT, run_id TEXT,
                payload_kind TEXT, key_id TEXT,
                ciphertext {binary}, nonce {binary}, wrapped_cek {binary},
                ttl_expires_at DOUBLE PRECISION,
                received_at DOUBLE PRECISION NOT NULL
            )""",
            "CREATE INDEX IF NOT EXISTS ix_tier_a_trace ON tier_a(trace_id)",
            "CREATE INDEX IF NOT EXISTS ix_tier_a_device ON tier_a(device_id)",
            "CREATE INDEX IF NOT EXISTS ix_tier_b_trace ON tier_b(trace_id)",
            "CREATE INDEX IF NOT EXISTS ix_tier_c_ttl ON tier_c(ttl_expires_at)",
        ]
        conn = self.connect()
        try:
            with conn:
                cur = conn.cursor()
                for statement in ddl:
                    cur.execute(statement)
            # Migration: a tier_b created before row-level idempotency lacks
            # receipt_uid; CREATE TABLE IF NOT EXISTS won't add it. Add it in an
            # isolated transaction, THEN build the unique index that backs
            # ON CONFLICT (device_id, receipt_uid). NULL receipt_uid (legacy clients)
            # never conflicts, so old rows and old clients keep working.
            self._add_column_if_missing(conn, "tier_a", "event_id TEXT")
            self._add_column_if_missing(conn, "tier_b", "receipt_uid TEXT")
            with conn:
                cur = conn.cursor()
                cur.execute(
                    "CREATE UNIQUE INDEX IF NOT EXISTS ux_tier_a_device_event "
                    "ON tier_a(device_id, event_id)"
                )
                cur.execute(
                    "CREATE UNIQUE INDEX IF NOT EXISTS ux_tier_b_device_receipt "
                    "ON tier_b(device_id, receipt_uid)"
                )
        finally:
            conn.close()

    def _add_column_if_missing(self, conn: Any, table: str, column_def: str) -> None:
        """``ALTER TABLE ADD COLUMN`` in an ISOLATED transaction. If the column
        already exists (a freshly CREATEd table, or a prior run) the statement
        raises 'duplicate column' — the expected no-op — and we roll back just that
        one statement so it never poisons the surrounding schema work. Both SQLite
        and PostgreSQL support ALTER TABLE ADD COLUMN."""
        try:
            with conn:
                conn.cursor().execute(f"ALTER TABLE {table} ADD COLUMN {column_def}")
        except Exception as exc:  # noqa: BLE001 - inspected below; only dup-column is a no-op
            try:
                conn.rollback()
            except Exception:  # noqa: BLE001 - best effort
                pass
            # ONLY "column already exists" is the expected idempotent no-op. Any other
            # failure (missing table, permission, lock, driver error) MUST surface —
            # fail-closed, never silently skip a schema migration.
            msg = str(exc).lower()
            if "duplicate column" not in msg and "already exists" not in msg:
                raise

    # -- writes ---------------------------------------------------------------
    def record_batch(
        self,
        *,
        upload_id: str,
        device_id: str,
        tier: str,
        agreement_version: str | None,
        rows: list[dict[str, Any]],
        now: float | None = None,
    ) -> tuple[str, int]:
        """Persist one batch. Returns ``(status, accepted_rows)`` where status is
        ``"accepted"`` or ``"duplicate"``. Idempotent on ``upload_id``."""
        if tier not in TIERS:
            raise DatabaseError(f"unknown tier {tier!r}")
        received_at = time.time() if now is None else now
        conn = self.connect()
        # Explicit transaction control (not `with conn:`). On a duplicate
        # upload_id, PostgreSQL puts the transaction into an aborted state — we
        # MUST rollback before returning, otherwise the implicit commit on a
        # `with conn:` exit raises InFailedSqlTransaction and the clean
        # "duplicate" turns into a 503. SQLite tolerates the same rollback path.
        try:
            cur = conn.cursor()
            try:
                cur.execute(
                    self.dialect.sql(
                        "INSERT INTO uploads "
                        "(upload_id, device_id, tier, agreement_version, row_count, received_at) "
                        "VALUES (?, ?, ?, ?, ?, ?)"
                    ),
                    (upload_id, device_id, tier, agreement_version, len(rows), received_at),
                )
            except self._integrity_errors():
                conn.rollback()
                return ("duplicate", 0)
            inserted = self._insert_rows(cur, tier, upload_id, device_id, rows, received_at)
            conn.commit()
            # Report the REAL number of rows that landed — row-level ON CONFLICT may
            # have deduped some, so len(rows) would over-report accepted_rows.
            return ("accepted", inserted)
        except Exception as exc:  # noqa: BLE001 - re-raised as typed DatabaseError
            try:
                conn.rollback()
            except Exception:  # noqa: BLE001 - best-effort cleanup
                pass
            raise DatabaseError(f"failed to persist batch {upload_id}: {exc}") from exc
        finally:
            conn.close()

    def _insert_rows(
        self,
        cur: Any,
        tier: str,
        upload_id: str,
        device_id: str,
        rows: list[dict[str, Any]],
        received_at: float,
    ) -> int:
        if tier == "A":
            cols = (
                "event_id",
                "trace_id", "run_id", "meter_kind", "backend", "provider", "model",
                "input_tokens", "output_tokens", "cost_cents", "duration_seconds",
                "status", "billing_lane", "occurred_at",
            )
            table = "tier_a"
        elif tier == "B":
            cols = (
                "receipt_uid",
                "trace_id", "run_id", "span_id", "parent_span_id",
                "receipt_class", "kind", "decision_code", "summary",
                "duration_ms", "exit_code", "retry_count",
                "exception_type", "stack_redacted",
                "media_kind", "media_size_bytes", "occurred_at",
            )
            table = "tier_b"
        else:  # Tier C — encrypted envelope bytes
            cols = (
                "trace_id", "run_id", "payload_kind", "key_id",
                "ciphertext", "nonce", "wrapped_cek", "ttl_expires_at",
            )
            table = "tier_c"
        placeholders = ", ".join(["?"] * (2 + len(cols) + 1))
        col_list = "upload_id, device_id, " + ", ".join(cols) + ", received_at"
        insert = f"INSERT INTO {table} ({col_list}) VALUES ({placeholders})"
        # Row-level idempotency: a re-sent row (crash retry, retention-thinned resend,
        # or a post-reincarnation full re-scan) dedupes on its stable per-row id rather
        # than double-inserting. A NULL id (legacy client) never conflicts, falling
        # back to upload_id batch dedupe.
        if tier == "A":
            insert += " ON CONFLICT (device_id, event_id) DO NOTHING"
        elif tier == "B":
            insert += " ON CONFLICT (device_id, receipt_uid) DO NOTHING"
        statement = self.dialect.sql(insert)
        inserted = 0
        for row in rows:
            values = [upload_id, device_id]
            values.extend(row.get(c) for c in cols)
            values.append(received_at)
            cur.execute(statement, values)
            # ON CONFLICT DO NOTHING reports rowcount 0 on a row-level dedupe skip,
            # 1 on a real insert; count only real inserts so accepted_rows is honest.
            rc = cur.rowcount
            if rc and rc > 0:
                inserted += rc
        return inserted

    # -- reads / ops ----------------------------------------------------------
    def stats(self) -> dict[str, Any]:
        conn = self.connect()
        try:
            cur = conn.cursor()
            out: dict[str, Any] = {}
            for tier, table in (("A", "tier_a"), ("B", "tier_b"), ("C", "tier_c")):
                cur.execute(f"SELECT COUNT(*) AS n FROM {table}")
                out[f"tier_{tier.lower()}_rows"] = int(_one(cur.fetchone(), "n"))
            cur.execute("SELECT COUNT(*) AS n FROM uploads")
            out["uploads"] = int(_one(cur.fetchone(), "n"))
            cur.execute("SELECT COUNT(DISTINCT device_id) AS n FROM uploads")
            out["devices"] = int(_one(cur.fetchone(), "n"))
            cur.execute("SELECT COALESCE(SUM(cost_cents), 0) AS c FROM tier_a")
            out["total_cost_cents"] = float(_one(cur.fetchone(), "c") or 0.0)
            return out
        finally:
            conn.close()

    def query_tier(
        self,
        tier: str,
        *,
        trace_id: str | None = None,
        device_id: str | None = None,
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        table = {"A": "tier_a", "B": "tier_b", "C": "tier_c"}.get(tier)
        if table is None:
            raise DatabaseError(f"unknown tier {tier!r}")
        limit = max(1, min(int(limit), 1000))
        clauses: list[str] = []
        params: list[Any] = []
        if trace_id:
            clauses.append("trace_id = ?")
            params.append(trace_id)
        if device_id:
            clauses.append("device_id = ?")
            params.append(device_id)
        where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
        # Tier C never returns ciphertext bytes over the query API — only metadata.
        if tier == "C":
            select = (
                "id, upload_id, device_id, trace_id, run_id, payload_kind, "
                "key_id, ttl_expires_at, received_at"
            )
        else:
            select = "*"
        statement = self.dialect.sql(
            f"SELECT {select} FROM {table}{where} ORDER BY id DESC LIMIT {limit}"
        )
        conn = self.connect()
        try:
            cur = conn.cursor()
            cur.execute(statement, params)
            return [dict(r) for r in cur.fetchall()]
        finally:
            conn.close()

    def fetch_tier_c_sealed(
        self,
        *,
        trace_id: str | None = None,
        device_id: str | None = None,
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        """Return Tier C rows WITH the encrypted envelope (ciphertext/nonce/wrapped
        CEK, base64-encoded for JSON). This is the PRIVILEGED unseal path — distinct
        from ``query_tier`` which never exposes ciphertext over the day-to-day query
        API. The caller still cannot read anything without the offline private key;
        this only hands over ciphertext to an operator who holds it."""
        limit = max(1, min(int(limit), 1000))
        clauses: list[str] = []
        params: list[Any] = []
        if trace_id:
            clauses.append("trace_id = ?")
            params.append(trace_id)
        if device_id:
            clauses.append("device_id = ?")
            params.append(device_id)
        where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
        select = (
            "id, trace_id, run_id, payload_kind, key_id, ttl_expires_at, "
            "ciphertext, nonce, wrapped_cek"
        )
        statement = self.dialect.sql(
            f"SELECT {select} FROM tier_c{where} ORDER BY id DESC LIMIT {limit}"
        )
        conn = self.connect()
        try:
            cur = conn.cursor()
            cur.execute(statement, params)
            rows: list[dict[str, Any]] = []
            for r in cur.fetchall():
                row = dict(r)
                for col in ("ciphertext", "nonce", "wrapped_cek"):
                    row[f"{col}_b64"] = base64.b64encode(bytes(row.pop(col))).decode("ascii")
                rows.append(row)
            return rows
        finally:
            conn.close()

    def apply_retention(self, *, retention_days: int, now: float | None = None) -> int:
        """Delete expired Tier C rows. Returns the number deleted. A/B untouched."""
        if retention_days <= 0:
            return 0
        cutoff = (time.time() if now is None else now)
        conn = self.connect()
        try:
            with conn:
                cur = conn.cursor()
                cur.execute(
                    self.dialect.sql(
                        "DELETE FROM tier_c WHERE ttl_expires_at IS NOT NULL "
                        "AND ttl_expires_at < ?"
                    ),
                    (cutoff,),
                )
                return cur.rowcount if cur.rowcount is not None else 0
        finally:
            conn.close()


def _one(row: Any, key: str) -> Any:
    if row is None:
        return 0
    try:
        return row[key]
    except (KeyError, IndexError, TypeError):
        return row[0]


def init_from_url(database_url: str) -> Database:
    db = Database(database_url)
    db.init_schema()
    return db


def coerce_rows(rows: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    return [dict(r) for r in rows]
