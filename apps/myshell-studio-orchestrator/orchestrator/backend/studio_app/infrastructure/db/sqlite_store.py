from __future__ import annotations

import json
import os
import sqlite3
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

from studio_app.infrastructure.paths import backend_dir


DEFAULT_STORE_PATH = str(backend_dir() / ".studio" / "studio.sqlite3")


class StudioStore:
    def __init__(self, path: str | None = None) -> None:
        self.path = path or os.environ.get("STUDIO_STORE_PATH") or DEFAULT_STORE_PATH
        self._lock = threading.RLock()
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        self._ensure_schema()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path)
        conn.row_factory = sqlite3.Row
        return conn

    @contextmanager
    def _connection(self) -> Iterator[sqlite3.Connection]:
        conn = self._connect()
        try:
            with conn:
                yield conn
        finally:
            conn.close()

    def _ensure_schema(self) -> None:
        with self._lock, self._connection() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS projects (
                    id TEXT PRIMARY KEY,
                    payload TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS jobs (
                    id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL,
                    segment_id TEXT NOT NULL,
                    payload TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
                """
            )
            conn.execute("CREATE INDEX IF NOT EXISTS idx_jobs_project_id ON jobs(project_id)")
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS evidence (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    job_id TEXT NOT NULL,
                    project_id TEXT NOT NULL,
                    segment_id TEXT NOT NULL,
                    payload TEXT NOT NULL,
                    created_at TEXT NOT NULL
                )
                """
            )
            conn.execute("CREATE INDEX IF NOT EXISTS idx_evidence_job_id ON evidence(job_id)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_evidence_project_id ON evidence(project_id)")
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS dispatch_sessions (
                    id TEXT PRIMARY KEY,
                    project_id TEXT,
                    payload TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
                """
            )
            conn.execute("CREATE INDEX IF NOT EXISTS idx_dispatch_sessions_project_id ON dispatch_sessions(project_id)")

    def save_project(self, project: dict[str, Any]) -> None:
        with self._lock, self._connection() as conn:
            conn.execute(
                """
                INSERT INTO projects(id, payload, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at
                """,
                (project["projectId"], json.dumps(project, ensure_ascii=False), project.get("updatedAt", "")),
            )

    def get_project(self, project_id: str) -> dict[str, Any] | None:
        with self._lock, self._connection() as conn:
            row = conn.execute("SELECT payload FROM projects WHERE id = ?", (project_id,)).fetchone()
        return json.loads(row["payload"]) if row else None

    def list_projects(self, limit: int = 50) -> list[dict[str, Any]]:
        with self._lock, self._connection() as conn:
            rows = conn.execute(
                "SELECT payload FROM projects ORDER BY updated_at DESC LIMIT ?",
                (max(1, min(limit, 200)),),
            ).fetchall()
        return [json.loads(row["payload"]) for row in rows]

    def delete_project(self, project_id: str) -> None:
        with self._lock, self._connection() as conn:
            conn.execute("DELETE FROM projects WHERE id = ?", (project_id,))
            conn.execute("DELETE FROM jobs WHERE project_id = ?", (project_id,))
            conn.execute("DELETE FROM evidence WHERE project_id = ?", (project_id,))
            conn.execute("DELETE FROM dispatch_sessions WHERE project_id = ?", (project_id,))

    def save_job(self, job: dict[str, Any]) -> None:
        with self._lock, self._connection() as conn:
            conn.execute(
                """
                INSERT INTO jobs(id, project_id, segment_id, payload, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    project_id=excluded.project_id,
                    segment_id=excluded.segment_id,
                    payload=excluded.payload,
                    updated_at=excluded.updated_at
                """,
                (
                    job["jobId"],
                    job["projectId"],
                    job["segmentId"],
                    json.dumps(job, ensure_ascii=False),
                    job.get("updatedAt", ""),
                ),
            )

    def get_job(self, job_id: str) -> dict[str, Any] | None:
        with self._lock, self._connection() as conn:
            row = conn.execute("SELECT payload FROM jobs WHERE id = ?", (job_id,)).fetchone()
        return json.loads(row["payload"]) if row else None

    def find_job_by_segment(self, project_id: str, segment_id: str) -> dict[str, Any] | None:
        with self._lock, self._connection() as conn:
            row = conn.execute(
                """
                SELECT payload FROM jobs
                WHERE project_id = ? AND segment_id = ?
                ORDER BY updated_at DESC
                LIMIT 1
                """,
                (project_id, segment_id),
            ).fetchone()
        return json.loads(row["payload"]) if row else None

    def list_jobs(
        self,
        project_id: str | None = None,
        status: str | None = None,
        page_id: str | None = None,
        agent_id: str | None = None,
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        query = "SELECT payload FROM jobs"
        params: tuple[Any, ...] = ()
        if project_id:
            query += " WHERE project_id = ?"
            params = (project_id,)
        query += " ORDER BY updated_at DESC"
        with self._lock, self._connection() as conn:
            rows = conn.execute(query, params).fetchall()
        jobs = [json.loads(row["payload"]) for row in rows]
        if status:
            jobs = [job for job in jobs if job.get("status") == status]
        if page_id:
            jobs = [job for job in jobs if job.get("pageId") == page_id or job.get("api") == page_id]
        if agent_id:
            jobs = [job for job in jobs if job.get("agentId") == agent_id]
        return jobs[: max(1, min(limit, 500))]

    def save_evidence(self, job: dict[str, Any], evidence: dict[str, Any]) -> None:
        if not evidence:
            return
        with self._lock, self._connection() as conn:
            conn.execute(
                """
                INSERT INTO evidence(job_id, project_id, segment_id, payload, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    job["jobId"],
                    job["projectId"],
                    job["segmentId"],
                    json.dumps(evidence, ensure_ascii=False),
                    evidence.get("checkedAt") or job.get("updatedAt", ""),
                ),
            )

    def list_evidence(self, job_id: str | None = None, project_id: str | None = None) -> list[dict[str, Any]]:
        query = "SELECT payload FROM evidence"
        params: list[Any] = []
        clauses: list[str] = []
        if job_id:
            clauses.append("job_id = ?")
            params.append(job_id)
        if project_id:
            clauses.append("project_id = ?")
            params.append(project_id)
        if clauses:
            query += " WHERE " + " AND ".join(clauses)
        query += " ORDER BY created_at DESC, id DESC"
        with self._lock, self._connection() as conn:
            rows = conn.execute(query, tuple(params)).fetchall()
        return [json.loads(row["payload"]) for row in rows]

    def save_dispatch_session(self, session: dict[str, Any]) -> None:
        with self._lock, self._connection() as conn:
            conn.execute(
                """
                INSERT INTO dispatch_sessions(id, project_id, payload, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    project_id=excluded.project_id,
                    payload=excluded.payload,
                    updated_at=excluded.updated_at
                """,
                (
                    session["sessionId"],
                    session.get("projectId"),
                    json.dumps(session, ensure_ascii=False),
                    session.get("updatedAt", ""),
                ),
            )

    def get_dispatch_session(self, session_id: str) -> dict[str, Any] | None:
        with self._lock, self._connection() as conn:
            row = conn.execute("SELECT payload FROM dispatch_sessions WHERE id = ?", (session_id,)).fetchone()
        return json.loads(row["payload"]) if row else None

    def list_dispatch_sessions(self, project_id: str | None = None, limit: int = 50) -> list[dict[str, Any]]:
        query = "SELECT payload FROM dispatch_sessions"
        params: tuple[Any, ...] = ()
        if project_id:
            query += " WHERE project_id = ?"
            params = (project_id,)
        query += " ORDER BY updated_at DESC LIMIT ?"
        params = (*params, max(1, min(limit, 200)))
        with self._lock, self._connection() as conn:
            rows = conn.execute(query, params).fetchall()
        return [json.loads(row["payload"]) for row in rows]

    def reset_all(self) -> None:
        with self._lock, self._connection() as conn:
            conn.execute("DELETE FROM projects")
            conn.execute("DELETE FROM jobs")
            conn.execute("DELETE FROM evidence")
            conn.execute("DELETE FROM dispatch_sessions")


STUDIO_STORE = StudioStore()
