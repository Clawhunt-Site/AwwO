from __future__ import annotations

from typing import Any


def delivery_gate(
    gate_id: str,
    label: str,
    status: str,
    *,
    required: bool = True,
    message: str = "",
    evidence: dict[str, Any] | None = None,
    ready_statuses: set[str] | None = None,
) -> dict[str, Any]:
    ready_statuses = ready_statuses or {"ok", "ready", "client_delegated"}
    normalized_status = "ready" if status in ready_statuses else status
    return {
        "id": gate_id,
        "label": label,
        "status": normalized_status,
        "required": required,
        "message": message,
        "evidence": evidence or {},
    }

def component_gate_status(
    component: dict[str, Any] | None,
    *,
    required: bool = True,
    ready_statuses: set[str] | None = None,
) -> str:
    ready_statuses = ready_statuses or {"ok", "ready", "client_delegated"}
    status = str((component or {}).get("status") or "unknown")
    if status in ready_statuses:
        return "ready"
    if status == "auth_missing":
        return "auth_missing"
    if status in {"unavailable", "degraded"}:
        return status
    return "blocked" if required else "degraded"

def readiness_summary(gates: list[dict[str, Any]], *, blocked_statuses: set[str] | None = None) -> dict[str, int]:
    blocked_statuses = blocked_statuses or {"blocked", "error"}
    summary = {"ready": 0, "degraded": 0, "blocked": 0, "total": len(gates)}
    for gate in gates:
        status = str(gate.get("status") or "unknown")
        if status == "ready":
            summary["ready"] += 1
        elif status in blocked_statuses:
            summary["blocked"] += 1
        else:
            summary["degraded"] += 1
    return summary

def readiness_status(gates: list[dict[str, Any]], *, blocked_statuses: set[str] | None = None) -> str:
    blocked_statuses = blocked_statuses or {"blocked", "error"}
    if any(gate.get("required") and gate.get("status") in blocked_statuses for gate in gates):
        return "blocked"
    if any(gate.get("status") != "ready" for gate in gates):
        return "degraded"
    return "ready"

def base_readiness_gates(
    *,
    components: dict[str, Any],
    pages: list[dict[str, Any]],
    agents: list[dict[str, Any]],
    route_coverage: dict[str, Any],
    core_page_ids: set[str],
    core_agent_ids: set[str],
    storage_path: str,
) -> list[dict[str, Any]]:
    page_ids = {page["id"] for page in pages}
    agent_ids = {agent["id"] for agent in agents}
    missing_page_ids = sorted(core_page_ids - page_ids)
    missing_agent_ids = sorted(core_agent_ids - agent_ids)
    route_coverage_ready = route_coverage.get("status") in {"covered", "source_unavailable"}
    page_registry_ready = not missing_page_ids and route_coverage_ready
    return [
        delivery_gate(
            "backend",
            "Backend",
            component_gate_status(components.get("backend")),
            message=str((components.get("backend") or {}).get("message") or "FastAPI runtime is serving requests"),
            evidence=components.get("backend") or {},
        ),
        delivery_gate(
            "storage",
            "Storage",
            component_gate_status(components.get("storage")),
            message=str((components.get("storage") or {}).get("path") or storage_path),
            evidence=components.get("storage") or {"path": storage_path},
        ),
        delivery_gate(
            "chrome-cdp",
            "Chrome CDP",
            component_gate_status(components.get("chromeCdp"), required=False),
            required=False,
            message=str((components.get("chromeCdp") or {}).get("url") or ""),
            evidence=components.get("chromeCdp") or {},
        ),
        delivery_gate(
            "cookie-injection",
            "Cookie Injection",
            component_gate_status(components.get("cookieInjection"), required=False),
            required=False,
            message=str((components.get("cookieInjection") or {}).get("message") or ""),
            evidence=components.get("cookieInjection") or {},
        ),
        delivery_gate(
            "page-registry",
            "Page Registry",
            "ready" if page_registry_ready else "blocked",
            message=f"{len(pages)} registered MyShell pages; {route_coverage.get('message')}",
            evidence={
                "pageCount": len(pages),
                "missingPageIds": missing_page_ids,
                "routeCoverage": route_coverage,
            },
        ),
        delivery_gate(
            "agent-registry",
            "Agent Registry",
            "ready" if not missing_agent_ids else "blocked",
            message=f"{len(agents)} registered Studio agents",
            evidence={"agentCount": len(agents), "missingAgentIds": missing_agent_ids},
        ),
    ]

def dispatch_preview_gate(preview: dict[str, Any] | None = None, error: Exception | None = None) -> dict[str, Any]:
    if error is not None:
        return delivery_gate("dispatch-preview", "Dispatch Preview", "blocked", message=str(error))
    preview = preview or {}
    preview_ready = (
        preview.get("executor") == "navigation"
        and preview.get("clientAction") == "navigate"
        and preview.get("navigationPath") == "/library"
        and not preview.get("missingRouteParams")
    )
    return delivery_gate(
        "dispatch-preview",
        "Dispatch Preview",
        "ready" if preview_ready else "blocked",
        message=str(preview.get("navigationPath") or ""),
        evidence={
            "pageId": (preview.get("page") or {}).get("id"),
            "agentId": preview.get("agentId"),
            "executor": preview.get("executor"),
            "navigationPath": preview.get("navigationPath"),
            "missingRouteParams": preview.get("missingRouteParams") or [],
        },
    )

def overview_gate(
    overview: dict[str, Any] | None = None,
    *,
    core_page_count: int,
    error: Exception | None = None,
) -> dict[str, Any]:
    if error is not None:
        return delivery_gate("overview", "Studio Overview", "blocked", message=str(error))
    overview = overview or {}
    totals = overview.get("totals") or {}
    overview_ready = totals.get("pages", 0) >= core_page_count
    return delivery_gate(
        "overview",
        "Studio Overview",
        "ready" if overview_ready else "blocked",
        message=f"{totals.get('jobs', 0)} jobs indexed",
        evidence={
            "pageCount": totals.get("pages", 0),
            "agentCount": totals.get("agents", 0),
            "jobCount": totals.get("jobs", 0),
            "issues": totals.get("issues", 0),
        },
    )

def adapter_auth_gate(auth_status: dict[str, Any]) -> dict[str, Any]:
    return delivery_gate(
        "myshell-art-auth",
        "MyShell Art Auth",
        str(auth_status.get("status") or "unknown"),
        required=False,
        message=str(auth_status.get("message") or ""),
        evidence=auth_status,
    )

def job_store_gate(
    *,
    sample_size: int = 0,
    storage_path: str,
    error: Exception | None = None,
) -> dict[str, Any]:
    if error is not None:
        return delivery_gate("job-store", "Job Store", "blocked", message=str(error), evidence={"path": storage_path})
    return delivery_gate(
        "job-store",
        "Job Store",
        "ready",
        message="SQLite job store can be queried",
        evidence={"sampleSize": sample_size, "path": storage_path},
    )

def readiness_response(
    *,
    gates: list[dict[str, Any]],
    health: dict[str, Any],
    checked_at: str,
) -> dict[str, Any]:
    summary = readiness_summary(gates)
    return {
        "status": readiness_status(gates),
        "checkedAt": checked_at,
        "summary": summary,
        "gates": gates,
        "health": health,
    }
