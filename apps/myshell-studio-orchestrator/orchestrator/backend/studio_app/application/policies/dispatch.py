from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, quote, urlencode, urlsplit, urlunsplit


StudioSegment = dict[str, Any]


def default_frontend_app_routes_file_for_backend(backend_file: Path) -> Path:
    backend_path = backend_file.resolve()
    ancestors = list(backend_path.parents)
    candidates: list[Path] = []
    if len(ancestors) >= 3:
        candidates.append(ancestors[2] / "frontend" / "src" / "App.tsx")
    if ancestors:
        candidates.append(ancestors[0] / "frontend" / "src" / "App.tsx")
    candidates.append(Path("/app/frontend/src/App.tsx"))
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return candidates[0]


def frontend_route_source_path(default_path: Path) -> Path:
    configured = os.environ.get("STUDIO_FRONTEND_APP_ROUTES_FILE")
    return Path(configured) if configured else default_path


def normalize_app_route(route: str) -> str:
    route = (route or "").strip()
    if not route:
        return ""
    parsed = urlsplit(route)
    return parsed.path or route


def extract_frontend_app_routes(source: str) -> list[str]:
    routes = re.findall(r"<Route\b[^>]*\bpath=[\"']([^\"']+)[\"']", source)
    normalized_routes = [normalize_app_route(route) for route in routes]
    return sorted({route for route in normalized_routes if route})


def frontend_route_coverage(
    pages: list[dict[str, Any]],
    *,
    source_path: Path,
    ignored_exact: set[str],
    ignored_prefixes: tuple[str, ...],
) -> dict[str, Any]:
    if not source_path.exists():
        return {
            "status": "source_unavailable",
            "sourcePath": str(source_path),
            "message": "Frontend App route source is not available in this runtime.",
            "appRoutes": [],
            "registeredRoutes": sorted(
                {
                    normalize_app_route(str(page.get("appRoute") or ""))
                    for page in pages
                    if normalize_app_route(str(page.get("appRoute") or ""))
                }
            ),
            "coveredRoutes": [],
            "missingAppRoutes": [],
            "extraRegistryRoutes": [],
            "ignoredAppRoutes": [],
        }

    try:
        source = source_path.read_text(encoding="utf-8")
    except OSError as exc:
        registered_routes = sorted(
            {
                normalize_app_route(str(page.get("appRoute") or ""))
                for page in pages
                if normalize_app_route(str(page.get("appRoute") or ""))
            }
        )
        return {
            "status": "error",
            "sourcePath": str(source_path),
            "message": f"Frontend App route source could not be read: {exc}",
            "appRoutes": [],
            "registeredRoutes": registered_routes,
            "coveredRoutes": [],
            "missingAppRoutes": [],
            "extraRegistryRoutes": registered_routes,
            "ignoredAppRoutes": [],
        }

    app_routes = extract_frontend_app_routes(source)
    ignored_routes = sorted(
        route
        for route in app_routes
        if route in ignored_exact or any(route.startswith(prefix) for prefix in ignored_prefixes)
    )
    routable_app_routes = sorted(route for route in app_routes if route not in set(ignored_routes))
    registered_routes = sorted(
        {
            normalize_app_route(str(page.get("appRoute") or ""))
            for page in pages
            if normalize_app_route(str(page.get("appRoute") or ""))
        }
    )
    app_route_set = set(routable_app_routes)
    registered_route_set = set(registered_routes)
    missing_routes = sorted(app_route_set - registered_route_set)
    extra_routes = sorted(registered_route_set - app_route_set)
    covered_routes = sorted(app_route_set & registered_route_set)
    status = "covered" if not missing_routes and not extra_routes else "mismatch"
    return {
        "status": status,
        "sourcePath": str(source_path),
        "appRoutes": routable_app_routes,
        "registeredRoutes": registered_routes,
        "coveredRoutes": covered_routes,
        "missingAppRoutes": missing_routes,
        "extraRegistryRoutes": extra_routes,
        "ignoredAppRoutes": ignored_routes,
        "message": (
            f"{len(covered_routes)} frontend routes covered"
            if status == "covered"
            else f"{len(missing_routes)} missing app routes, {len(extra_routes)} extra registry routes"
        ),
    }


def accepted_source_media_url(source_segment: StudioSegment | None) -> str:
    if not source_segment:
        return ""
    evidence = source_segment.get("evidence") or {}
    media_url = evidence.get("mediaUrl") or source_segment.get("url") or ""
    if evidence.get("accepted") and media_url:
        return str(media_url)
    if source_segment.get("status") == "done" and source_segment.get("url"):
        return str(source_segment["url"])
    return ""


def navigation_path_for_page(
    page: dict[str, Any],
    route: dict[str, Any] | None = None,
    source_segment: StudioSegment | None = None,
) -> str:
    path = page.get("appRoute") or ""
    if not path:
        return ""

    route_params = set(page.get("routeParams") or [])
    parsed_path = urlsplit(path)
    route_defaults = {key: str(value) for key, value in (page.get("routeDefaults") or {}).items() if value is not None}
    route_values = dict(route_defaults)
    bot_slug = (route or {}).get("bot", {}).get("slug") or ""
    if "slug_id" in route_params and bot_slug:
        route_values["slug_id"] = bot_slug
    if "img" in route_params and source_segment:
        source_url = accepted_source_media_url(source_segment)
        if source_url:
            route_values["img"] = source_url

    path_part = parsed_path.path
    path_bound_params: set[str] = set()
    for param in route_params:
        placeholder = f":{param}"
        value = route_values.get(param)
        if placeholder in path_part and value:
            path_part = path_part.replace(placeholder, quote(value, safe=""))
            path_bound_params.add(param)

    query: dict[str, str] = {key: value for key, value in parse_qsl(parsed_path.query, keep_blank_values=True)}
    for key, value in route_defaults.items():
        if key not in path_bound_params:
            query[key] = value
    for key, value in route_values.items():
        if key in route_params and key not in path_bound_params:
            query[key] = value

    if not query:
        return urlunsplit((parsed_path.scheme, parsed_path.netloc, path_part, "", parsed_path.fragment))
    return urlunsplit((parsed_path.scheme, parsed_path.netloc, path_part, urlencode(query), parsed_path.fragment))


def navigation_contract(
    page: dict[str, Any],
    route: dict[str, Any] | None = None,
    source_segment: StudioSegment | None = None,
) -> dict[str, Any]:
    if page.get("executor") != "navigation":
        return {}
    return {
        "clientAction": "navigate",
        "navigationPath": navigation_path_for_page(page, route, source_segment),
        "studioReturnPath": "/dreamy",
    }


def missing_route_params(page: dict[str, Any], navigation_path: str) -> list[str]:
    route_params = page.get("routeParams") or []
    if not route_params:
        return []
    app_path = urlsplit(page.get("appRoute") or "").path
    parsed_path = urlsplit(navigation_path or "")
    query_params = {key for key, _value in parse_qsl(parsed_path.query, keep_blank_values=True)}
    missing: list[str] = []
    for param in route_params:
        placeholder = f":{param}"
        if placeholder in app_path:
            if placeholder in parsed_path.path:
                missing.append(param)
            continue
        if param not in query_params:
            missing.append(param)
    return missing


def empty_status_counts(status_keys: tuple[str, ...]) -> dict[str, int]:
    return {status: 0 for status in status_keys}


def status_counts(jobs: list[dict[str, Any]], *, status_keys: tuple[str, ...]) -> dict[str, int]:
    counts = empty_status_counts(status_keys)
    for job in jobs:
        status = str(job.get("status") or "running")
        counts[status] = counts.get(status, 0) + 1
    return counts


def page_agent_ids(page: dict[str, Any], page_jobs: list[dict[str, Any]], agents: list[dict[str, Any]]) -> list[str]:
    agent_ids = {
        agent["id"]
        for agent in agents
        if agent.get("pageId") == page["id"] or (page.get("executor") == "navigation" and agent["id"] == "miniapp-page-navigator")
    }
    agent_ids.update(str(job.get("agentId")) for job in page_jobs if job.get("agentId"))
    return sorted(agent_ids)


def overview_totals(
    *,
    pages: list[dict[str, Any]],
    agents: list[dict[str, Any]],
    jobs: list[dict[str, Any]],
    total_counts: dict[str, int],
) -> dict[str, int]:
    return {
        "pages": len(pages),
        "agents": len(agents),
        "jobs": len(jobs),
        **total_counts,
        "issues": total_counts.get("timeout", 0) + total_counts.get("auth_missing", 0) + total_counts.get("error", 0),
    }


def payload_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return bool(value)


def payload_page_ids(value: Any) -> list[str]:
    page_ids = value or []
    if isinstance(page_ids, str):
        page_ids = [page_ids]
    if not isinstance(page_ids, list):
        raise ValueError("page_ids must be a list")
    return [str(page_id) for page_id in page_ids]


def payload_limited_int(value: Any, *, default: int, minimum: int, maximum: int) -> int:
    return max(minimum, min(int(value or default), maximum))


def recommended_action_for_page(page: dict[str, Any]) -> str:
    if page.get("executor") == "navigation":
        return "navigate"
    if page.get("executor") == "server":
        return "execute-server"
    return "execute-client"


def default_dispatch_route(
    default_bot: dict[str, Any],
    *,
    action: str,
    source_segment_id: str | None,
    source_media_url: str,
) -> dict[str, Any]:
    return {
        "bot": {
            "slug": default_bot["slug"],
            "name": default_bot["name"],
            "type": default_bot["type"],
            "rating": default_bot.get("rating", 4.5),
            "description": default_bot.get("desc", ""),
            "pageUrl": f"https://art.myshell.ai/creative/{default_bot['slug']}",
        },
        "action": action,
        "sourceSegmentId": source_segment_id,
        "sourceSummary": f"Using segment {source_segment_id}" if source_segment_id else "Starting from prompt",
        "analysis": "Coverage verification queued by Studio.",
        "reason": "Batch verification for a ready dispatch target.",
        "optimizedPrompt": "Verify Studio dispatch coverage.",
        "executor": "navigation",
        "sourceMediaUrl": source_media_url,
    }


def dispatch_preview_prompt(message: str, action: str, preferred_page: dict[str, Any]) -> str:
    stripped = (message or "").strip()
    if stripped:
        return stripped
    if preferred_page.get("executor") == "navigation":
        return f"Open {preferred_page['name']}"
    return {
        "generate": "Create a new Dreamy media segment.",
        "extend": "Extend the selected video with a natural next shot.",
        "restyle": "Restyle the selected segment while keeping the subject consistent.",
        "retry-agent": "Try another agent for the selected segment.",
    }[action]


def source_summary(source_segment_id: str | None) -> str:
    return f"Using segment {source_segment_id}" if source_segment_id else "Starting from prompt"


def enrich_dispatch_route(
    route: dict[str, Any],
    page: dict[str, Any],
    *,
    action: str,
    source_segment_id: str | None,
    agent_id: str,
    contract: dict[str, Any],
    missing_route_params: list[str],
) -> dict[str, Any]:
    route["action"] = action
    route["sourceSegmentId"] = source_segment_id
    route["sourceSummary"] = source_summary(source_segment_id)
    route["page"] = page
    route["api"] = page["id"]
    route["executor"] = page["executor"]
    route["agentId"] = agent_id
    route.update(contract)
    route["routeParams"] = page.get("routeParams") or []
    route["missingRouteParams"] = missing_route_params
    return route


def dispatch_preview_response(
    *,
    runtime_page: dict[str, Any],
    route: dict[str, Any],
    page: dict[str, Any],
    contract: dict[str, Any],
    navigation_path: str,
    missing_route_params: list[str],
    prompt: str,
) -> dict[str, Any]:
    return {
        "page": runtime_page,
        "route": route,
        "executor": page["executor"],
        "agentId": route["agentId"],
        "authStatus": runtime_page["authStatus"],
        "dispatchReady": runtime_page["dispatchReady"],
        "dispatchStatus": runtime_page["dispatchStatus"],
        "dispatchMessage": runtime_page["dispatchMessage"],
        "clientAction": contract.get("clientAction"),
        "navigationPath": navigation_path,
        "studioReturnPath": contract.get("studioReturnPath"),
        "routeParams": page.get("routeParams") or [],
        "missingRouteParams": missing_route_params,
        "prompt": route.get("optimizedPrompt") or prompt,
    }


def navigation_evidence_payload(
    base_evidence: dict[str, Any],
    *,
    page: dict[str, Any],
    agent_id: str,
    navigation_path: str,
    missing_route_params: list[str],
    coverage_verification: bool = False,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    evidence = {
        **base_evidence,
        "pageId": page["id"],
        "agentId": agent_id,
        "navigationPath": navigation_path,
        "missingRouteParams": missing_route_params,
    }
    if coverage_verification:
        evidence["coverageVerification"] = True
    if extra:
        evidence.update(extra)
    return evidence


def coverage_status(
    entry: dict[str, Any],
    page_jobs: list[dict[str, Any]],
    accepted_count: int,
    *,
    pending_statuses: set[str],
    issue_statuses: set[str],
) -> str:
    if not entry.get("dispatchReady"):
        return "blocked"
    latest_status = str((page_jobs[0] if page_jobs else {}).get("status") or "")
    if accepted_count:
        return "covered"
    if latest_status in pending_statuses or latest_status in issue_statuses:
        return "pending"
    return "ready_unverified"


def coverage_status_summary(statuses: list[str]) -> str:
    if "blocked" in statuses:
        return "blocked"
    if statuses and all(status == "covered" for status in statuses):
        return "ready"
    return "ready_with_gaps"


def coverage_skip(page: dict[str, Any], reason: str, message: str = "") -> dict[str, Any]:
    return {
        "pageId": page["pageId"],
        "pageName": page["pageName"],
        "executor": page.get("executor", ""),
        "dispatchStatus": page.get("dispatchStatus", ""),
        "coverageStatus": page.get("coverageStatus", ""),
        "reason": reason,
        "message": message or page.get("dispatchMessage", ""),
        "missingRouteParams": page.get("missingRouteParams") or [],
    }


def dispatch_target(entry: dict[str, Any], matrix: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": f"dispatch:{entry.get('pageId')}",
        "pageId": entry.get("pageId"),
        "pageName": entry.get("pageName"),
        "kind": entry.get("kind", ""),
        "executor": entry.get("executor", ""),
        "agentId": entry.get("agentId"),
        "recommendedAction": entry.get("recommendedAction"),
        "dispatchStatus": entry.get("dispatchStatus"),
        "dispatchMessage": entry.get("dispatchMessage", ""),
        "clientAction": entry.get("clientAction"),
        "navigationPath": entry.get("navigationPath", ""),
        "studioReturnPath": entry.get("studioReturnPath") or "/dreamy",
        "routeParams": entry.get("routeParams") or [],
        "missingRouteParams": [],
        "authStatus": entry.get("authStatus") or {},
        "capabilities": entry.get("capabilities") or [],
        "projectId": matrix.get("projectId"),
        "sourceSegmentId": matrix.get("sourceSegmentId"),
        "sourceMediaUrl": matrix.get("sourceMediaUrl", ""),
    }


def dispatch_skip(entry: dict[str, Any], reason: str, message: str = "") -> dict[str, Any]:
    return {
        "id": f"skip:{entry.get('pageId')}",
        "pageId": entry.get("pageId"),
        "pageName": entry.get("pageName"),
        "kind": entry.get("kind", ""),
        "executor": entry.get("executor", ""),
        "agentId": entry.get("agentId"),
        "recommendedAction": entry.get("recommendedAction"),
        "dispatchStatus": entry.get("dispatchStatus"),
        "reason": reason,
        "message": message or entry.get("dispatchMessage", ""),
        "navigationPath": entry.get("navigationPath", ""),
        "missingRouteParams": entry.get("missingRouteParams") or [],
        "authStatus": entry.get("authStatus") or {},
    }


def dispatch_batch_summary(
    selected_entries: list[dict[str, Any]],
    targets: list[dict[str, Any]],
    skipped_targets: list[dict[str, Any]],
) -> dict[str, int]:
    return {
        "total": len(selected_entries),
        "planned": len(targets),
        "skipped": len(skipped_targets),
        "navigation": sum(1 for target in targets if target.get("executor") == "navigation"),
        "client": sum(1 for target in targets if target.get("executor") == "client"),
        "server": sum(1 for target in targets if target.get("executor") == "server"),
        "missingParams": sum(1 for target in skipped_targets if target.get("reason") == "missing_params"),
        "blocked": sum(1 for target in skipped_targets if target.get("reason") in {"auth_missing", "error", "not_ready"}),
        "coveredSkipped": sum(1 for target in skipped_targets if target.get("reason") == "already_covered"),
    }
