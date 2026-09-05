from __future__ import annotations

from typing import Any, Protocol


class StudioStore(Protocol):
    path: str

    def save_project(self, project: dict[str, Any]) -> None:
        ...

    def get_project(self, project_id: str) -> dict[str, Any] | None:
        ...

    def list_projects(self, limit: int = 50) -> list[dict[str, Any]]:
        ...

    def delete_project(self, project_id: str) -> None:
        ...

    def save_job(self, job: dict[str, Any]) -> None:
        ...

    def get_job(self, job_id: str) -> dict[str, Any] | None:
        ...

    def find_job_by_segment(self, project_id: str, segment_id: str) -> dict[str, Any] | None:
        ...

    def list_jobs(
        self,
        project_id: str | None = None,
        status: str | None = None,
        page_id: str | None = None,
        agent_id: str | None = None,
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        ...

    def save_evidence(self, job: dict[str, Any], evidence: dict[str, Any]) -> None:
        ...

    def list_evidence(self, job_id: str | None = None, project_id: str | None = None) -> list[dict[str, Any]]:
        ...

    def save_dispatch_session(self, session: dict[str, Any]) -> None:
        ...

    def get_dispatch_session(self, session_id: str) -> dict[str, Any] | None:
        ...

    def list_dispatch_sessions(self, project_id: str | None = None, limit: int = 50) -> list[dict[str, Any]]:
        ...
