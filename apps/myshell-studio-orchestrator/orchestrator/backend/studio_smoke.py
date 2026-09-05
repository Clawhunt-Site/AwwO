from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin
from urllib.request import Request, urlopen


DEFAULT_REQUIRED_PAGES = {
    "dreamy-miniapp",
    "myshell-art",
    "explore",
    "ai-picks",
    "bot-detail",
    "upload",
    "tag-generator",
    "library",
    "library-detail",
    "energy-store",
    "energy-history",
    "earn",
    "share-invite",
    "settings",
    "profile",
    "checkin",
}

DEFAULT_REQUIRED_AGENTS = {
    "intent-router",
    "asset-planner",
    "dreamy-miniapp-executor",
    "myshell-art-cdp-executor",
    "miniapp-page-navigator",
    "evidence-verifier",
    "timeline",
}

SMOKE_ENDPOINTS = (
    "/api/health",
    "/api/pages",
    "/api/agents",
    "/api/studio/readiness",
    "/api/studio/dispatch-matrix",
    "/api/studio/coverage",
    "/api/studio/generation-smoke",
    "/api/studio/delivery-audit",
)


class SmokeFailure(RuntimeError):
    pass


def _fetch_json(base_url: str, path: str, timeout: float) -> Any:
    url = urljoin(base_url.rstrip("/") + "/", path.lstrip("/"))
    headers = {"Accept": "application/json"}
    token = os.environ.get("STUDIO_AUTH_TOKEN", "").strip()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = Request(url, headers=headers)
    try:
        with urlopen(request, timeout=timeout) as response:
            body = response.read().decode("utf-8")
    except (HTTPError, URLError, TimeoutError) as error:
        raise SmokeFailure(f"GET {path} failed: {error}") from error
    try:
        return json.loads(body)
    except json.JSONDecodeError as error:
        raise SmokeFailure(f"GET {path} did not return JSON") from error


def _ids(items: list[dict[str, Any]], key: str = "id") -> set[str]:
    return {str(item.get(key) or "") for item in items if item.get(key)}


def _require(condition: bool, message: str, failures: list[str]) -> None:
    if not condition:
        failures.append(message)


def run_smoke(
    base_url: str,
    *,
    min_pages: int = 16,
    min_agents: int = 7,
    required_pages: set[str] | None = None,
    required_agents: set[str] | None = None,
    timeout: float = 10.0,
    fetch_json: Callable[[str], Any] | None = None,
) -> dict[str, Any]:
    fetch = fetch_json or (lambda path: _fetch_json(base_url, path, timeout))
    responses = {path: fetch(path) for path in SMOKE_ENDPOINTS}

    pages = responses["/api/pages"].get("pages") or []
    agents = responses["/api/agents"].get("agents") or []
    readiness = responses["/api/studio/readiness"]
    matrix = responses["/api/studio/dispatch-matrix"]
    coverage = responses["/api/studio/coverage"]
    generation_smoke = responses["/api/studio/generation-smoke"]
    audit = responses["/api/studio/delivery-audit"]

    page_ids = _ids(pages)
    agent_ids = _ids(agents)
    required_page_ids = required_pages or DEFAULT_REQUIRED_PAGES
    required_agent_ids = required_agents or DEFAULT_REQUIRED_AGENTS
    matrix_page_ids = _ids(matrix.get("entries") or [], "pageId")
    gates = readiness.get("gates") or []
    required_gates = [gate for gate in gates if gate.get("required")]
    blocked_required_gates = [
        str(gate.get("id") or "unknown")
        for gate in required_gates
        if gate.get("status") not in {"ready", "ok", "covered"}
    ]
    optional_gate_warnings = [
        f"Optional gate {gate.get('id')} is {gate.get('status')}"
        for gate in gates
        if not gate.get("required") and gate.get("status") not in {"ready", "ok", "covered"}
    ]

    failures: list[str] = []
    missing_pages = sorted(required_page_ids - page_ids)
    missing_agents = sorted(required_agent_ids - agent_ids)
    matrix_missing_pages = sorted(required_page_ids - matrix_page_ids)

    _require(len(pages) >= min_pages, f"Expected at least {min_pages} pages, got {len(pages)}", failures)
    _require(not missing_pages, f"Missing required pages: {', '.join(missing_pages)}", failures)
    _require(len(agents) >= min_agents, f"Expected at least {min_agents} agents, got {len(agents)}", failures)
    _require(not missing_agents, f"Missing required agents: {', '.join(missing_agents)}", failures)
    _require(not blocked_required_gates, f"Required gates not ready: {', '.join(blocked_required_gates)}", failures)
    _require(not matrix_missing_pages, f"Dispatch matrix missing pages: {', '.join(matrix_missing_pages)}", failures)
    _require(isinstance(coverage.get("summary"), dict), "Coverage summary is missing", failures)
    _require(bool(generation_smoke.get("status")), "Generation smoke status is missing", failures)
    _require(isinstance(generation_smoke.get("prerequisites"), dict), "Generation smoke prerequisites are missing", failures)
    _require(bool(audit.get("requirements")), "Delivery audit requirements are missing", failures)
    _require(bool(audit.get("artifacts")), "Delivery audit artifacts are missing", failures)
    _require(isinstance(audit.get("reports"), dict), "Delivery audit reports are missing", failures)

    result = {
        "status": "ok" if not failures else "failed",
        "baseUrl": base_url,
        "summary": {
            "pages": len(pages),
            "agents": len(agents),
            "requiredGates": len(required_gates),
            "requiredGatesReady": len(required_gates) - len(blocked_required_gates),
            "matrixEntries": len(matrix.get("entries") or []),
            "coveragePages": (coverage.get("summary") or {}).get("total", 0),
            "generationSmoke": generation_smoke.get("status", ""),
            "auditRequirements": len(audit.get("requirements") or []),
            "auditArtifacts": len(audit.get("artifacts") or []),
        },
        "warnings": optional_gate_warnings,
        "failures": failures,
    }
    if failures:
        raise SmokeFailure("; ".join(failures))
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Smoke test MyShell Studio Orchestrator delivery endpoints.")
    parser.add_argument("--base-url", default="http://127.0.0.1:8090", help="Studio backend URL")
    parser.add_argument("--timeout", type=float, default=10.0, help="Per-request timeout in seconds")
    parser.add_argument("--min-pages", type=int, default=16, help="Minimum registered page count")
    parser.add_argument("--min-agents", type=int, default=7, help="Minimum registered agent count")
    args = parser.parse_args(argv)

    try:
        result = run_smoke(
            args.base_url,
            min_pages=args.min_pages,
            min_agents=args.min_agents,
            timeout=args.timeout,
        )
    except SmokeFailure as error:
        print(json.dumps({"status": "failed", "message": str(error)}, indent=2, ensure_ascii=False))
        return 1

    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
