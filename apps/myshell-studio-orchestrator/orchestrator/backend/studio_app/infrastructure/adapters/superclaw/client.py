from __future__ import annotations

import json
import os
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote, urljoin, urlparse

import httpx


DEFAULT_SUPERCLAW_API_BASE = "http://127.0.0.1:8788"
DEFAULT_SUPERCLAW_GATEWAY_BASE = "http://127.0.0.1:8796"
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}
MAX_UPSTREAM_ERROR_CHARS = 600


class SuperClawClientError(Exception):
    def __init__(self, status_code: int, detail: str, *, upstream_status: int | None = None) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail
        self.upstream_status = upstream_status


@dataclass(frozen=True)
class SuperClawEndpointConfig:
    api_base_url: str
    api_base_configured: bool
    control_token_configured: bool
    gateway_base_url: str
    gateway_base_configured: bool
    gateway_token_configured: bool
    remote_allowed: bool


def _truthy(value: str | None) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def _strip_trailing_slash(value: str) -> str:
    return value.rstrip("/")


def _normalize_host(host: str) -> str:
    host = host.strip().lower()
    if host.startswith("[") and host.endswith("]"):
        host = host[1:-1]
    return host


def _safe_base_url(value: str, *, field: str, remote_allowed: bool) -> str:
    raw = _strip_trailing_slash(value.strip())
    try:
        parsed = urlparse(raw)
    except Exception as exc:
        raise SuperClawClientError(500, f"{field} is not a valid URL") from exc
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise SuperClawClientError(500, f"{field} must be an http(s) URL")
    if not remote_allowed and _normalize_host(parsed.hostname or "") not in LOOPBACK_HOSTS:
        raise SuperClawClientError(500, f"{field} must be loopback unless STUDIO_SUPERCLAW_ALLOW_REMOTE=1")
    return raw


def endpoint_config() -> SuperClawEndpointConfig:
    remote_allowed = _truthy(os.environ.get("STUDIO_SUPERCLAW_ALLOW_REMOTE"))
    api_override = (
        os.environ.get("STUDIO_SUPERCLAW_API_BASE")
        or os.environ.get("SUPERCLAW_API_BASE_URL")
        or os.environ.get("SUPERCLAW_API_BASE")
        or ""
    ).strip()
    gateway_override = (
        os.environ.get("STUDIO_SUPERCLAW_GATEWAY_BASE")
        or os.environ.get("SUPERCLAW_GATEWAY_API_BASE_URL")
        or os.environ.get("SUPERCLAW_GATEWAY_BASE_URL")
        or os.environ.get("SUPERCLAW_GATEWAY_BASE")
        or ""
    ).strip()
    if not gateway_override and os.environ.get("SUPERCLAW_GATEWAY_PORT"):
        gateway_override = f"http://127.0.0.1:{os.environ['SUPERCLAW_GATEWAY_PORT'].strip()}"

    api_base = _safe_base_url(api_override or DEFAULT_SUPERCLAW_API_BASE, field="SUPERCLAW_API_BASE", remote_allowed=remote_allowed)
    gateway_base = _safe_base_url(
        gateway_override or DEFAULT_SUPERCLAW_GATEWAY_BASE,
        field="SUPERCLAW_GATEWAY_BASE",
        remote_allowed=remote_allowed,
    )
    return SuperClawEndpointConfig(
        api_base_url=api_base,
        api_base_configured=bool(api_override),
        control_token_configured=bool(_control_token()),
        gateway_base_url=gateway_base,
        gateway_base_configured=bool(gateway_override),
        gateway_token_configured=bool(_gateway_token()),
        remote_allowed=remote_allowed,
    )


def _control_token() -> str:
    return (os.environ.get("STUDIO_SUPERCLAW_CONTROL_TOKEN") or os.environ.get("SUPERCLAW_CONTROL_TOKEN") or "").strip()


def _gateway_token() -> str:
    return (
        os.environ.get("STUDIO_SUPERCLAW_GATEWAY_TOKEN")
        or os.environ.get("SUPERCLAW_GATEWAY_CONTROL_TOKEN")
        or os.environ.get("SUPERCLAW_GATEWAY_TOKEN")
        or ""
    ).strip()


def _api_headers(*, accept: str = "application/json") -> dict[str, str]:
    headers = {"Accept": accept}
    token = _control_token()
    if token:
        headers["X-SuperClaw-Token"] = token
    return headers


def _gateway_headers() -> dict[str, str]:
    token = _gateway_token()
    if not token:
        raise SuperClawClientError(503, "SUPERCLAW_GATEWAY_CONTROL_TOKEN is not configured")
    return {"Accept": "application/json", "Content-Type": "application/json", "x-superclaw-gateway-token": token}


def _join(base_url: str, path: str) -> str:
    safe_path = path.lstrip("/")
    return urljoin(base_url + "/", safe_path)


def _json_or_text(response: httpx.Response) -> Any:
    if not response.content:
        return {}
    content_type = response.headers.get("content-type", "")
    if "application/json" in content_type:
        return response.json()
    text = response.text
    try:
        return json.loads(text)
    except Exception:
        return {"message": text}


def _compact_error_detail(value: Any, *, fallback: str) -> str:
    text = str(value or fallback).strip()
    lowered = text.lower()
    if "<html" in lowered or "<!doctype" in lowered:
        return fallback
    if len(text) > MAX_UPSTREAM_ERROR_CHARS:
        return f"{text[:MAX_UPSTREAM_ERROR_CHARS].rstrip()}..."
    return text


def _raise_upstream(response: httpx.Response) -> None:
    if response.status_code < 400:
        return
    payload = _json_or_text(response)
    detail: Any = None
    if isinstance(payload, dict):
        detail = payload.get("detail") or payload.get("error") or payload.get("message")
    fallback = f"SuperClaw upstream returned HTTP {response.status_code}"
    raise SuperClawClientError(
        502 if response.status_code >= 500 else response.status_code,
        _compact_error_detail(detail, fallback=fallback),
        upstream_status=response.status_code,
    )


async def request_api_json(method: str, path: str, *, json_payload: Any | None = None, timeout: float = 30.0) -> Any:
    config = endpoint_config()
    try:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
            response = await client.request(
                method.upper(),
                _join(config.api_base_url, path),
                headers={**_api_headers(), "Content-Type": "application/json"},
                json=json_payload,
            )
    except httpx.HTTPError as exc:
        raise SuperClawClientError(503, f"SuperClaw API unavailable: {exc}") from exc
    _raise_upstream(response)
    return _json_or_text(response)


async def stream_api_sse(path: str) -> AsyncIterator[str]:
    config = endpoint_config()
    try:
        async with httpx.AsyncClient(timeout=None, follow_redirects=False) as client:
            async with client.stream("GET", _join(config.api_base_url, path), headers=_api_headers(accept="text/event-stream")) as response:
                if response.status_code >= 400:
                    payload = await response.aread()
                    fallback = f"SuperClaw upstream returned HTTP {response.status_code}"
                    message = _compact_error_detail(payload.decode("utf-8", errors="replace"), fallback=fallback)
                    raise SuperClawClientError(
                        502 if response.status_code >= 500 else response.status_code,
                        message,
                        upstream_status=response.status_code,
                    )
                async for chunk in response.aiter_text():
                    if chunk:
                        yield chunk
    except SuperClawClientError as exc:
        error = {"type": "superclaw.error", "message": exc.detail, "upstreamStatus": exc.upstream_status}
        yield f"event: superclaw.error\ndata: {json.dumps(error, ensure_ascii=False)}\n\n"
    except httpx.HTTPError as exc:
        error = {"type": "superclaw.error", "message": f"SuperClaw event stream unavailable: {exc}"}
        yield f"event: superclaw.error\ndata: {json.dumps(error, ensure_ascii=False)}\n\n"


async def request_gateway_json(method: str, path: str, *, json_payload: Any | None = None, timeout: float = 30.0) -> Any:
    config = endpoint_config()
    try:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
            response = await client.request(
                method.upper(),
                _join(config.gateway_base_url, path),
                headers=_gateway_headers(),
                json=json_payload,
            )
    except httpx.HTTPError as exc:
        raise SuperClawClientError(503, f"SuperClaw Gateway unavailable: {exc}") from exc
    _raise_upstream(response)
    return _json_or_text(response)


async def superclaw_status() -> dict[str, Any]:
    config = endpoint_config()
    api_health: dict[str, Any] = {"reachable": False}
    gateway_health: dict[str, Any] = {"reachable": False}
    try:
        health = await request_api_json("GET", "/health", timeout=5.0)
        api_health = {"reachable": True, "payload": health}
    except SuperClawClientError as exc:
        api_health = {"reachable": False, "message": exc.detail, "status": exc.upstream_status}
    try:
        gateway = await request_gateway_json("GET", "/gateway-id", timeout=5.0)
        gateway_health = {"reachable": True, "payload": gateway}
    except SuperClawClientError as exc:
        gateway_health = {"reachable": False, "message": exc.detail, "status": exc.upstream_status}
    return {
        "configured": {
            "apiBase": config.api_base_configured,
            "controlToken": config.control_token_configured,
            "gatewayBase": config.gateway_base_configured,
            "gatewayToken": config.gateway_token_configured,
            "remoteAllowed": config.remote_allowed,
        },
        "api": {"baseUrl": config.api_base_url, **api_health},
        "gateway": {"baseUrl": config.gateway_base_url, **gateway_health},
    }


async def create_goal(payload: dict[str, Any]) -> dict[str, Any]:
    result = await request_api_json("POST", "/api/goals", json_payload=payload)
    return result if isinstance(result, dict) else {"result": result}


async def create_run(payload: dict[str, Any]) -> dict[str, Any]:
    result = await request_api_json("POST", "/api/runs", json_payload=payload, timeout=60.0)
    return result if isinstance(result, dict) else {"result": result}


async def list_runs() -> dict[str, Any]:
    result = await request_api_json("GET", "/api/runs")
    return result if isinstance(result, dict) else {"runs": result}


async def get_run(run_id: str) -> dict[str, Any]:
    result = await request_api_json("GET", f"/api/runs/{quote(run_id, safe='')}")
    return result if isinstance(result, dict) else {"result": result}


def stream_run_events(run_id: str) -> AsyncIterator[str]:
    return stream_api_sse(f"/api/runs/{quote(run_id, safe='')}/events")


async def cancel_run(run_id: str) -> dict[str, Any]:
    result = await request_api_json("POST", f"/api/runs/{quote(run_id, safe='')}/cancel")
    return result if isinstance(result, dict) else {"result": result}


async def resume_run(run_id: str) -> dict[str, Any]:
    result = await request_api_json("POST", f"/api/runs/{quote(run_id, safe='')}/resume")
    return result if isinstance(result, dict) else {"result": result}


async def create_automation(payload: dict[str, Any]) -> dict[str, Any]:
    result = await request_gateway_json("POST", "/api/automations", json_payload=payload)
    return result if isinstance(result, dict) else {"result": result}


async def list_automations(session_issue_id: str | None = None) -> list[dict[str, Any]]:
    path = "/api/automations"
    if session_issue_id:
        path = f"{path}?sessionIssueId={quote(session_issue_id, safe='')}"
    result = await request_gateway_json("GET", path)
    return result if isinstance(result, list) else list(result.get("automations", [])) if isinstance(result, dict) else []


async def approve_automation(automation_id: str) -> dict[str, Any]:
    result = await request_gateway_json("POST", f"/api/automations/{quote(automation_id, safe='')}/approve")
    return result if isinstance(result, dict) else {"result": result}


async def delete_automation(automation_id: str) -> dict[str, Any]:
    await request_gateway_json("DELETE", f"/api/automations/{quote(automation_id, safe='')}")
    return {"id": automation_id, "deleted": True}
