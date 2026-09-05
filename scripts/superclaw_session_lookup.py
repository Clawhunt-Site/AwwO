#!/usr/bin/env python3
"""Locate and dump a SuperClaw conversation/run by id from the correct local store.

Why this exists
---------------
SuperClaw writes its state to ``<cwd>/.superclaw/state.db``. Because the desktop
app, dev servers, and every git worktree each run from a different cwd, there are
many ``state.db`` files on one machine -- and stale ``desktop-service.json`` markers
that point at dead services / empty databases. Trusting the wrong marker leads to
"the id doesn't exist" when the conversation is alive in a *different* db.

This tool removes the guesswork:

1. It finds the **live** backend by scanning every ``.superclaw/run/desktop-service.json``
   and keeping only the one whose ``pid`` is actually running. That service's
   ``<cwd>/<state_path>`` is the authoritative database.
2. Failing that (no service running), it scans every data-bearing ``state.db`` it
   can find and searches each for the id.
3. Given an id (``session_*`` / ``run_*`` / ``workspace_*`` / ``msg_*`` / a bare hex
   fragment) it dumps the matching chat session (messages, usage, errors) and -- for
   chat sessions -- correlates the API access log to explain a UI "failed" badge.

Stdlib only. Read-only: it never writes to any database.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import re
import sqlite3
import sys
from dataclasses import dataclass
from pathlib import Path

# Roots scanned when discovering databases. Kept broad but bounded so a laptop
# with dozens of worktrees still resolves in well under a second.
_DEFAULT_SCAN_ROOTS = (
    Path.home() / "Documents",
    Path.home() / "dev",
    Path.home() / "superclaw-wt",
    Path.home() / "Desktop",
    Path.home() / "Library" / "Application Support" / "SuperClaw",
)
_SKIP_DIR_NAMES = {"node_modules", ".git", "__pycache__", ".venv", "venv", "dist", "build"}
_ID_PREFIXES = ("session_", "run_", "workspace_", "msg_")


@dataclass(frozen=True)
class ServiceMarker:
    """A parsed ``desktop-service.json`` plus whether its process is alive."""

    marker_path: Path
    pid: int | None
    state_db: Path
    alive: bool


def _pid_alive(pid: int | None) -> bool:
    if not pid:
        return False
    try:
        # Signal 0 only checks existence/permission; it never touches the process.
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        # The process exists but is owned by another user -- still "alive".
        return True
    except OSError:
        return False
    return True


def _iter_under(root: Path, target_name: str, max_depth: int = 8) -> list[Path]:
    """Depth-bounded walk that prunes heavy/irrelevant directories."""

    found: list[Path] = []
    if not root.exists():
        return found
    root_depth = len(root.parts)
    for dirpath, dirnames, filenames in os.walk(root):
        depth = len(Path(dirpath).parts) - root_depth
        if depth >= max_depth:
            dirnames[:] = []
            continue
        dirnames[:] = [d for d in dirnames if d not in _SKIP_DIR_NAMES]
        if target_name in filenames:
            found.append(Path(dirpath) / target_name)
    return found


def discover_service_markers(roots: tuple[Path, ...]) -> list[ServiceMarker]:
    markers: list[ServiceMarker] = []
    seen: set[Path] = set()
    for root in roots:
        for marker_path in _iter_under(root, "desktop-service.json"):
            resolved = marker_path.resolve()
            if resolved in seen:
                continue
            seen.add(resolved)
            try:
                data = json.loads(marker_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            pid = data.get("pid")
            pid_int = int(pid) if isinstance(pid, int) or (isinstance(pid, str) and pid.isdigit()) else None
            # state_path is relative to the service cwd; the marker lives at
            # <cwd>/.superclaw/run/desktop-service.json, so cwd is two parents up.
            cwd = marker_path.parent.parent.parent
            state_path = str(data.get("state_path") or ".superclaw/state.db")
            state_db = (cwd / state_path).resolve()
            markers.append(
                ServiceMarker(
                    marker_path=marker_path,
                    pid=pid_int,
                    state_db=state_db,
                    alive=_pid_alive(pid_int),
                )
            )
    return markers


def discover_databases(roots: tuple[Path, ...]) -> list[Path]:
    dbs: list[Path] = []
    seen: set[Path] = set()
    for root in roots:
        for db in _iter_under(root, "state.db"):
            resolved = db.resolve()
            if resolved in seen:
                continue
            seen.add(resolved)
            try:
                if resolved.stat().st_size > 0:
                    dbs.append(resolved)
            except OSError:
                continue
    return dbs


def _connect(db: Path) -> sqlite3.Connection:
    # Read-only open that STILL sees a live service's WAL. ``mode=ro`` respects the
    # -wal/-shm sidecars, so rows a running backend has only written to the WAL are
    # visible; ``immutable=1`` would skip the WAL and silently under-report (the
    # exact "id not found" trap this tool exists to prevent). Plain connect is the
    # last resort if the read-only URI cannot be opened.
    try:
        conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    except sqlite3.OperationalError:
        conn = sqlite3.connect(db)
    conn.row_factory = sqlite3.Row
    return conn


def _has_table(conn: sqlite3.Connection, name: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
    ).fetchone()
    return row is not None


def _count_session_match(db: Path, needle: str) -> int:
    try:
        with _connect(db) as conn:
            if not _has_table(conn, "chat_sessions"):
                return 0
            row = conn.execute(
                "SELECT count(*) FROM chat_sessions WHERE session_id = ? OR payload LIKE ?",
                (needle, f"%{needle}%"),
            ).fetchone()
            return int(row[0]) if row else 0
    except sqlite3.DatabaseError:
        return 0


def resolve_database(explicit: str | None, needle: str, roots: tuple[Path, ...]) -> tuple[Path | None, list[str]]:
    """Pick the database to query and return (db, human-readable notes)."""

    notes: list[str] = []
    if explicit:
        return Path(explicit).expanduser().resolve(), [f"using --db {explicit}"]

    markers = discover_service_markers(roots)
    live = [m for m in markers if m.alive]
    dead = [m for m in markers if not m.alive]
    for m in dead:
        notes.append(f"stale service marker (pid {m.pid} dead): {m.marker_path}")

    # Prefer a LIVE service whose db actually contains the id. If exactly one
    # service is live, that is authoritative regardless of the id match (the id may
    # be archived/older but it is still that service's store).
    live_with_match = [m for m in live if _count_session_match(m.state_db, needle) > 0]
    if live_with_match:
        chosen = live_with_match[0]
        notes.insert(0, f"LIVE service pid {chosen.pid} -> {chosen.state_db}")
        return chosen.state_db, notes
    if len(live) == 1:
        notes.insert(0, f"LIVE service pid {live[0].pid} -> {live[0].state_db} (id not matched here; see scan below)")
        # Still fall through to scan so we can find where the id actually lives.

    # No live match: scan every data-bearing db for the id.
    matches = [db for db in discover_databases(roots) if _count_session_match(db, needle) > 0]
    if matches:
        notes.insert(0, f"id found by full scan in {len(matches)} db(s); using {matches[0]}")
        for extra in matches[1:]:
            notes.append(f"also present in: {extra}")
        return matches[0], notes

    if live:
        notes.insert(0, f"no db contains {needle!r}; defaulting to live service db {live[0].state_db}")
        return live[0].state_db, notes
    notes.insert(0, f"no live service and no db contains {needle!r}")
    return None, notes


def _fmt_ts(value: object) -> str:
    if isinstance(value, (int, float)):
        try:
            return _dt.datetime.fromtimestamp(value).isoformat(timespec="seconds")
        except (OverflowError, OSError, ValueError):
            return str(value)
    return str(value)


def _find_session_id(conn: sqlite3.Connection, needle: str) -> str | None:
    row = conn.execute(
        "SELECT session_id FROM chat_sessions WHERE session_id = ?", (needle,)
    ).fetchone()
    if row:
        return row["session_id"]
    # A run_* id copied from a failed run card is usually the SYNTHETIC chat-turn id
    # that only lives in cost_events. Map it back to its chat session so the user can
    # paste the very id the UI polled (and 404'd on).
    if needle.startswith("run_") and _has_table(conn, "cost_events"):
        row = conn.execute(
            "SELECT chat_session_id FROM cost_events WHERE run_id = ? AND chat_session_id IS NOT NULL LIMIT 1",
            (needle,),
        ).fetchone()
        if row and row["chat_session_id"]:
            return row["chat_session_id"]
    row = conn.execute(
        "SELECT session_id FROM chat_sessions WHERE session_id LIKE ? OR payload LIKE ? LIMIT 1",
        (f"%{needle}%", f"%{needle}%"),
    ).fetchone()
    return row["session_id"] if row else None


def dump_session(db: Path, needle: str, *, full: bool, want_logs: bool) -> int:
    with _connect(db) as conn:
        if not _has_table(conn, "chat_sessions"):
            print(f"  (no chat_sessions table in {db})")
            return 1
        session_id = _find_session_id(conn, needle)
        if not session_id:
            print(f"  no chat session matches {needle!r} in {db}")
            # Surface run/event hits so a run_* id is not reported as "missing".
            _report_run_hits(conn, needle)
            return 1
        row = conn.execute(
            "SELECT session_id, workspace_id, archived, payload FROM chat_sessions WHERE session_id = ?",
            (session_id,),
        ).fetchone()
        payload = json.loads(row["payload"])
        _print_session(row, payload, full=full)
        run_ids = _print_messages(payload, full=full)
        # Chat turns keep their (synthetic) run_id only in cost_events, not on the
        # message rows, so fold those in for the most precise log correlation.
        run_ids = list(dict.fromkeys(run_ids + _print_cost_events(conn, session_id)))
    if want_logs:
        _correlate_logs(db, session_id, run_ids)
    return 0


def _print_session(row: sqlite3.Row, payload: dict, *, full: bool) -> None:
    meta = payload.get("metadata", {}) or {}
    runtime = (meta.get("runtime") or {}).get("backend") or (meta.get("capability_surface") or {}).get("backend")
    native = meta.get("native_sessions") or {}
    print("=" * 72)
    print(f"session_id : {row['session_id']}")
    print(f"title      : {payload.get('title')}")
    print(f"workspace  : {row['workspace_id']}    archived: {bool(row['archived'])}")
    print(f"backend    : {runtime}")
    print(f"created    : {_fmt_ts(payload.get('created_at'))}    updated: {_fmt_ts(payload.get('updated_at'))}")
    if native:
        for backend, info in native.items():
            print(f"native[{backend}]: id={info.get('id')} last_msg={info.get('last_seen_message_id')} repo={info.get('repo_path')}")
    if full and meta:
        print("metadata   :")
        print("  " + json.dumps(meta, ensure_ascii=False, indent=2).replace("\n", "\n  "))


def _print_messages(payload: dict, *, full: bool) -> list[str]:
    messages = payload.get("messages", []) or []
    print("-" * 72)
    print(f"messages   : {len(messages)}")
    run_ids: list[str] = []
    for i, m in enumerate(messages):
        role = m.get("role")
        status = m.get("status")
        run_id = m.get("run_id")
        if run_id:
            run_ids.append(run_id)
        usage = m.get("usage") or {}
        out_tok = usage.get("output_tokens")
        elapsed = m.get("elapsed_ms")
        content = m.get("content", "")
        if isinstance(content, (list, dict)):
            content = json.dumps(content, ensure_ascii=False)
        content = str(content)
        flags = []
        if status:
            flags.append(f"status={status}")
        if run_id:
            flags.append(f"run_id={run_id}")
        if out_tok is not None:
            flags.append(f"out_tok={out_tok}")
        if elapsed is not None:
            flags.append(f"{elapsed}ms")
        header = f"[{i}] {role:9s} " + " ".join(flags)
        print("\n" + header)
        body = content if full else (content[:500] + ("…" if len(content) > 500 else ""))
        print("    " + body.replace("\n", "\n    "))
    return run_ids


def _print_cost_events(conn: sqlite3.Connection, session_id: str) -> list[str]:
    """Print this session's turn cost events and return their run ids."""

    if not _has_table(conn, "cost_events") or not _column_exists(conn, "cost_events", "chat_session_id"):
        return []
    rows = conn.execute(
        "SELECT run_id, payload FROM cost_events WHERE chat_session_id = ? ORDER BY occurred_at",
        (session_id,),
    ).fetchall()
    if not rows:
        return []
    print("-" * 72)
    print(f"cost_events: {len(rows)} (turn-level bookkeeping; run_id here is synthetic for chat turns)")
    run_ids: list[str] = []
    for r in rows:
        # status/model/backend live inside the JSON payload, not as columns.
        info: dict = {}
        try:
            info = json.loads(r["payload"]) if r["payload"] else {}
        except json.JSONDecodeError:
            info = {}
        if r["run_id"]:
            run_ids.append(r["run_id"])
        print(f"    run_id={r['run_id']} status={info.get('status')} backend={info.get('backend')} model={info.get('model')}")
    return run_ids


def _column_exists(conn: sqlite3.Connection, table: str, column: str) -> bool:
    return any(c["name"] == column for c in conn.execute(f"PRAGMA table_info({table})"))


def _report_run_hits(conn: sqlite3.Connection, needle: str) -> None:
    if _has_table(conn, "runs"):
        rows = conn.execute(
            "SELECT run_id FROM runs WHERE run_id LIKE ? LIMIT 5", (f"%{needle}%",)
        ).fetchall()
        if rows:
            print("  matching runs:")
            for r in rows:
                print(f"    {r['run_id']}")
            return
    print("  (no run rows match either)")


def _correlate_logs(db: Path, session_id: str, run_ids: list[str]) -> None:
    """Explain a UI 'failed' badge by surfacing run-handle polls that 404'd."""

    log = db.parent / "run" / "uvicorn.log"
    print("-" * 72)
    if not log.exists():
        print(f"log        : (no uvicorn.log next to db at {log})")
        return
    print(f"log        : {log}")
    try:
        text = log.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        print(f"  (could not read log: {exc})")
        return
    # Chat turns emit a synthetic run_id that is never persisted as a run; the client
    # polls /api/runs/<id> and gets 404. Surface those so a "failed" badge on a
    # successful chat is explained rather than mysterious.
    poll_404 = re.findall(r"path=(/api/runs/(run_[0-9a-f]+)\S*)\s+status=404", text)
    if not poll_404:
        print("  no /api/runs 404 polls found in log")
        return
    poll_404_ids = {rid for _, rid in poll_404}

    # First and most precise: did THIS session's own turn run ids 404?
    own_404 = [rid for rid in run_ids if rid in poll_404_ids]
    if own_404:
        print(f"  THIS session's turn run id(s) polled and 404'd: {', '.join(own_404)}")
        print("  -> these chat turns returned a run_id, but no run resource was ever")
        print("     created for them; the client polls /api/runs/<id> + /evidence +")
        print("     /events/snapshot, gets 404, and renders a FAILED run card even")
        print("     though the assistant answer above succeeded.")
    else:
        print(f"  (this session's run ids not in the log's current 404 window: {run_ids or '—'})")

    runless = sorted(poll_404_ids)
    print(f"  total run-handle 404 polls in log: {len(poll_404)} request(s) over {len(runless)} run id(s)")
    for path, rid in poll_404[:9]:
        tag = " (THIS session)" if rid in run_ids else ""
        print(f"    404  {path}{tag}")


def cmd_list(roots: tuple[Path, ...], db_arg: str | None, limit: int) -> int:
    db, notes = resolve_database(db_arg, "", roots)
    for note in notes:
        print(f"# {note}")
    if not db or not db.exists():
        print("no database resolved")
        return 1
    with _connect(db) as conn:
        if not _has_table(conn, "chat_sessions"):
            print("no chat_sessions table")
            return 1
        rows = conn.execute(
            "SELECT session_id, workspace_id, archived, payload FROM chat_sessions"
        ).fetchall()
    parsed = []
    for r in rows:
        try:
            p = json.loads(r["payload"])
        except json.JSONDecodeError:
            continue
        parsed.append((p.get("updated_at") or 0, r["session_id"], p.get("title"), len(p.get("messages", []) or []), bool(r["archived"])))
    parsed.sort(reverse=True)
    print(f"# {len(parsed)} sessions in {db}")
    for updated, sid, title, n, archived in parsed[:limit]:
        tag = " [archived]" if archived else ""
        print(f"{_fmt_ts(updated)}  {sid}  msgs={n}{tag}  {title}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Find and dump a SuperClaw conversation/run by id from the correct local store.",
    )
    parser.add_argument("id", nargs="?", help="session_* / run_* / workspace_* / msg_* / hex fragment")
    parser.add_argument("--db", help="query this state.db explicitly (skip discovery)")
    parser.add_argument("--full", action="store_true", help="print full message bodies and metadata")
    parser.add_argument("--no-logs", action="store_true", help="skip uvicorn.log correlation")
    parser.add_argument("--list", action="store_true", help="list recent sessions in the resolved db")
    parser.add_argument("--limit", type=int, default=30, help="how many sessions to list (default 30)")
    args = parser.parse_args(argv)

    roots = _DEFAULT_SCAN_ROOTS

    if args.list:
        return cmd_list(roots, args.db, args.limit)
    if not args.id:
        parser.error("an id is required (or use --list)")

    needle = args.id.strip()
    db, notes = resolve_database(args.db, needle, roots)
    for note in notes:
        print(f"# {note}")
    if not db or not db.exists():
        print(f"\nno database found for {needle!r}")
        return 1
    print()
    return dump_session(db, needle, full=args.full, want_logs=not args.no_logs)


if __name__ == "__main__":
    sys.exit(main())
