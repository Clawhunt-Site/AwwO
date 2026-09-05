from __future__ import annotations

from typing import Any
from urllib.parse import quote, urlencode


def gate_status_from_report(status: str) -> str:
    if status in {"ok", "ready"}:
        return "ready"
    if status in {"blocked", "auth_missing", "error"}:
        return "blocked"
    return "needs_attention"

def artifact_url(
    endpoint: str,
    *,
    project_id: str | None = None,
    session_id: str | None = None,
    query: dict[str, Any] | None = None,
) -> str:
    url = endpoint
    if project_id is not None:
        url = url.replace("{project_id}", quote(str(project_id), safe=""))
    if session_id is not None:
        url = url.replace("{session_id}", quote(str(session_id), safe=""))
    clean_query = {
        key: value
        for key, value in (query or {}).items()
        if value is not None and value != ""
    }
    if clean_query:
        delimiter = "&" if "?" in url else "?"
        url = f"{url}{delimiter}{urlencode(clean_query)}"
    return url

def artifact(
    artifact_id: str,
    label: str,
    endpoint: str,
    *,
    project_id: str | None = None,
    session_id: str | None = None,
    target_id: str | None = None,
    ui_url: str | None = None,
    query: dict[str, Any] | None = None,
    filename: str | None = None,
) -> dict[str, Any]:
    result = {
        "id": artifact_id,
        "label": label,
        "endpoint": endpoint,
        "url": artifact_url(endpoint, project_id=project_id, session_id=session_id, query=query),
    }
    if project_id is not None:
        result["projectId"] = project_id
    if session_id is not None:
        result["sessionId"] = session_id
    if target_id is not None:
        result["targetId"] = target_id
    if ui_url:
        result["uiUrl"] = ui_url
    clean_query = {
        key: value
        for key, value in (query or {}).items()
        if value is not None and value != ""
    }
    if clean_query:
        result["query"] = clean_query
    if filename:
        result["filename"] = filename
    return result

def context_query(project_id: str | None = None, source_segment_id: str | None = None) -> dict[str, Any]:
    query: dict[str, Any] = {}
    if project_id:
        query["project_id"] = project_id
    if source_segment_id:
        query["source_segment_id"] = source_segment_id
    return query

def dispatch_session_ui_url(session_id: str, target_id: str | None = None) -> str:
    query = {"dispatch_session_id": session_id}
    if target_id:
        query["target_id"] = target_id
    return f"/dreamy?{urlencode(query)}"

def handoff_artifacts(project_id: str | None, source_segment_id: str | None = None) -> list[dict[str, Any]]:
    query = context_query(project_id, source_segment_id)
    artifacts = [
        artifact("health", "Health", "/api/health"),
        artifact("readiness", "Readiness", "/api/studio/readiness"),
        artifact("overview", "Overview", "/api/studio/overview"),
        artifact("dispatch-matrix", "Dispatch Matrix", "/api/studio/dispatch-matrix", query=query),
        artifact("coverage", "Coverage", "/api/studio/coverage", query=query),
        artifact("handoff-snapshot", "Handoff Snapshot", "/api/studio/handoff-snapshot", query=query),
    ]
    if project_id:
        artifacts.append(
            artifact(
                "delivery-report",
                "Project Delivery Report",
                "/api/studio/projects/{project_id}/delivery-report",
                project_id=project_id,
            )
        )
    return artifacts

def delivery_bundle_artifacts(
    project_id: str,
    sessions: list[dict[str, Any]],
    source_segment_id: str | None = None,
) -> list[dict[str, Any]]:
    bundle_query = context_query(source_segment_id=source_segment_id)
    artifacts = [
        *handoff_artifacts(project_id, source_segment_id),
        artifact("project", "Project", "/api/studio/projects/{project_id}", project_id=project_id),
        artifact(
            "delivery-bundle",
            "Delivery Bundle",
            "/api/studio/projects/{project_id}/delivery-bundle",
            project_id=project_id,
            query=bundle_query,
        ),
        artifact("jobs", "Jobs", "/api/studio/jobs", project_id=project_id, query={"project_id": project_id}),
    ]
    for session in sessions:
        session_id = str(session.get("sessionId") or "")
        artifacts.append(
            artifact(
                f"dispatch-session:{session_id}",
                f"Dispatch Session {session_id}",
                "/api/studio/dispatch-sessions/{session_id}",
                project_id=project_id,
                session_id=session_id,
                ui_url=dispatch_session_ui_url(session_id),
            )
        )
        for target in session.get("targets") or []:
            target_id = str(target.get("id") or "")
            if not target_id:
                continue
            artifacts.append(
                artifact(
                    f"dispatch-target:{session_id}:{target_id}",
                    f"Dispatch Target {target.get('pageName') or target.get('pageId') or target_id}",
                    "/api/studio/dispatch-sessions/{session_id}",
                    project_id=project_id,
                    session_id=session_id,
                    target_id=target_id,
                    ui_url=dispatch_session_ui_url(session_id, target_id),
                    query={"target_id": target_id},
                )
            )
    return artifacts

def delivery_audit_artifacts(project_id: str | None, source_segment_id: str | None = None) -> list[dict[str, Any]]:
    query = context_query(project_id, source_segment_id)
    artifacts = [
        artifact("delivery-audit", "Delivery Audit", "/api/studio/delivery-audit", query=query),
        artifact("generation-smoke", "Live Generation Smoke", "/api/studio/generation-smoke"),
        *handoff_artifacts(project_id, source_segment_id),
    ]
    if project_id:
        artifacts.extend(
            [
                artifact("project", "Project", "/api/studio/projects/{project_id}", project_id=project_id),
                artifact(
                    "delivery-bundle-download",
                    "Downloadable Delivery Bundle",
                    "/api/studio/projects/{project_id}/delivery-bundle",
                    project_id=project_id,
                    query={**context_query(source_segment_id=source_segment_id), "download": 1},
                    filename=f"myshell-studio-delivery-{project_id}.json",
                ),
            ]
        )
    return artifacts
