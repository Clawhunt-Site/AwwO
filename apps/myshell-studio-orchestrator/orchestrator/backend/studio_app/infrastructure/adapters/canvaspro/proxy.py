from __future__ import annotations

import asyncio
import json
import os
import re
import threading
import uuid
from datetime import UTC, datetime
from typing import Any, Optional
from urllib.parse import urlparse

import httpx
from fastapi import HTTPException, Request, Response
from fastapi.responses import JSONResponse
from sse_starlette.sse import EventSourceResponse


def _canvaspro_api_base() -> str:
    return os.environ.get("AI_CANVASPRO_API_BASE", "http://127.0.0.1:8777").rstrip("/")


def _proxy_headers(request: Request) -> dict[str, str]:
    blocked = {"host", "content-length", "transfer-encoding", "connection"}
    return {key: value for key, value in request.headers.items() if key.lower() not in blocked}


def _response_headers(headers: httpx.Headers) -> dict[str, str]:
    blocked = {"content-encoding", "content-length", "content-type", "transfer-encoding", "connection"}
    return {key: value for key, value in headers.items() if key.lower() not in blocked}


def _canvaspro_compat_dir() -> str:
    configured = os.environ.get("AI_CANVASPRO_COMPAT_DIR")
    if configured:
        return configured
    backend_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))))
    return os.path.join(backend_dir, ".studio", "canvaspro")


def _canvaspro_compat_file(name: str) -> str:
    return os.path.join(_canvaspro_compat_dir(), name)


_CANVASPRO_JSON_LOCKS: dict[str, threading.Lock] = {}
_CANVASPRO_JSON_LOCKS_GUARD = threading.Lock()
_CANVASPRO_SECRET_KEY_PARTS = {
    "apikey",
    "modelapikey",
    "authorization",
    "accesstoken",
    "refreshtoken",
    "secret",
    "token",
}
_CANVASPRO_404_FALLBACK_ENDPOINTS = {
    ("GET", "api/v2/runtime/info"),
    ("GET", "api/config"),
    ("POST", "api/config"),
    ("PUT", "api/config"),
    ("PATCH", "api/config"),
    ("GET", "api/v2/user/settings.json"),
    ("POST", "api/v2/user/settings.json"),
    ("PUT", "api/v2/user/settings.json"),
    ("PATCH", "api/v2/user/settings.json"),
    ("GET", "api/v2/user/shortcuts.json"),
    ("POST", "api/v2/user/shortcuts.json"),
    ("PUT", "api/v2/user/shortcuts.json"),
    ("PATCH", "api/v2/user/shortcuts.json"),
    ("GET", "api/v2/user/asset-categories.json"),
    ("POST", "api/v2/user/asset-categories.json"),
    ("PUT", "api/v2/user/asset-categories.json"),
    ("PATCH", "api/v2/user/asset-categories.json"),
    ("GET", "api/v2/user/presets"),
    ("POST", "api/v2/user/presets/save"),
    ("POST", "api/v2/user/presets/delete"),
    ("GET", "api/v2/dreamina/status"),
    ("GET", "api/v2/subscription/status"),
    ("GET", "api/v2/update/check"),
    ("GET", "api/v2/heartbeat_stream"),
    ("GET", "api/v2/assets"),
    ("GET", "api/v2/workflows"),
    ("GET", "api/v2/projects"),
    ("POST", "api/v2/projects/save"),
}
_CANVASPRO_LOCAL_UNAVAILABLE_MARKERS = (
    "connection refused",
    "econnrefused",
    "nsposixerrordomain - 61",
    "unable to connect",
)


def _canvaspro_json_lock(name: str) -> threading.Lock:
    with _CANVASPRO_JSON_LOCKS_GUARD:
        if name not in _CANVASPRO_JSON_LOCKS:
            _CANVASPRO_JSON_LOCKS[name] = threading.Lock()
        return _CANVASPRO_JSON_LOCKS[name]


def _canvaspro_safe_name(value: Any, fallback: str = "default") -> str:
    text = str(value or "").strip() or fallback
    text = re.sub(r"[^A-Za-z0-9._-]+", "_", text).strip("._")
    return text[:120] or fallback


def _canvaspro_project_filename(value: Any) -> str:
    name = _canvaspro_safe_name(value, "default_v2_project")
    return name if name.endswith(".json") else f"{name}.json"


def _canvaspro_project_store_file(filename: str) -> str:
    return f"project_{_canvaspro_project_filename(filename)}"


def _canvaspro_is_secret_key(key: str) -> bool:
    normalized = re.sub(r"[^a-z0-9]+", "", str(key or "").lower())
    return normalized in _CANVASPRO_SECRET_KEY_PARTS or normalized.endswith("apikey")


def _redact_canvaspro_secrets(value: Any) -> Any:
    if isinstance(value, list):
        return [_redact_canvaspro_secrets(item) for item in value]
    if isinstance(value, dict):
        redacted: dict[str, Any] = {}
        for key, item in value.items():
            if _canvaspro_is_secret_key(str(key)):
                continue
            redacted[str(key)] = _redact_canvaspro_secrets(item)
        return redacted
    return value


def _truthy_env(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes", "on"}


def _read_canvaspro_json(name: str, fallback: Any) -> Any:
    try:
        with open(_canvaspro_compat_file(name), encoding="utf-8") as canvaspro_file:
            return json.load(canvaspro_file)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return fallback


def _write_canvaspro_json(name: str, payload: Any) -> Any:
    lock = _canvaspro_json_lock(name)
    with lock:
        directory = _canvaspro_compat_dir()
        os.makedirs(directory, exist_ok=True)
        path = _canvaspro_compat_file(name)
        tmp_path = f"{path}.{uuid.uuid4().hex}.tmp"
        try:
            with open(tmp_path, "w", encoding="utf-8") as canvaspro_file:
                json.dump(payload, canvaspro_file, ensure_ascii=False, indent=2)
            os.replace(tmp_path, path)
        finally:
            try:
                if os.path.exists(tmp_path):
                    os.remove(tmp_path)
            except OSError:
                pass
    return payload


def _request_json_body(body: bytes) -> dict[str, Any]:
    if not body:
        return {}
    try:
        value = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def _canvaspro_compat_json(payload: Any, status_code: int = 200) -> JSONResponse:
    return JSONResponse(
        payload,
        status_code=status_code,
        headers={"X-AI-CanvasPro-Compat": "1"},
    )


def _canvaspro_compat_heartbeat_stream() -> EventSourceResponse:
    async def event_generator():
        yield {
            "event": "runtime",
            "data": json.dumps(
                {
                    "available": False,
                    "mode": "studio-compat",
                    "message": "AI CanvasPro native server is not running; Studio compatibility mode is active.",
                }
            ),
        }
        while True:
            await asyncio.sleep(15)
            yield {
                "event": "heartbeat",
                "data": json.dumps({"ok": True, "mode": "studio-compat"}),
            }

    return EventSourceResponse(
        event_generator(),
        ping=15,
        headers={"X-AI-CanvasPro-Compat": "1"},
    )


def _save_canvaspro_preset(payload: dict[str, Any]) -> dict[str, Any]:
    presets = _read_canvaspro_json("presets.json", {})
    if not isinstance(presets, dict):
        presets = {}

    node_type = str(payload.get("nodeType") or "ai-image").strip() or "ai-image"
    title = str(payload.get("title") or payload.get("originalTitle") or "Custom preset").strip() or "Custom preset"
    original_title = str(payload.get("originalTitle") or title).strip()
    preset = {**payload, "nodeType": node_type, "title": title}
    existing = presets.get(node_type)
    items = existing if isinstance(existing, list) else []

    next_items: list[dict[str, Any]] = []
    replaced = False
    for item in items:
        if not isinstance(item, dict):
            continue
        item_title = str(item.get("title") or "").strip()
        if item_title and item_title in {title, original_title}:
            if not replaced:
                next_items.append(preset)
                replaced = True
            continue
        next_items.append(item)

    if not replaced:
        next_items.append(preset)
    presets[node_type] = next_items
    return _write_canvaspro_json("presets.json", presets)


def _delete_canvaspro_preset(payload: dict[str, Any]) -> dict[str, Any]:
    presets = _read_canvaspro_json("presets.json", {})
    if not isinstance(presets, dict):
        presets = {}

    node_type = str(payload.get("nodeType") or "ai-image").strip() or "ai-image"
    title = str(payload.get("title") or "").strip()
    existing = presets.get(node_type)
    if isinstance(existing, list) and title:
        presets[node_type] = [
            item
            for item in existing
            if not isinstance(item, dict) or str(item.get("title") or "").strip() != title
        ]
        _write_canvaspro_json("presets.json", presets)
    return presets


def _list_canvaspro_projects() -> list[dict[str, Any]]:
    directory = _canvaspro_compat_dir()
    try:
        filenames = os.listdir(directory)
    except OSError:
        return []

    projects: list[dict[str, Any]] = []
    for filename in filenames:
        if not filename.startswith("project_") or not filename.endswith(".json"):
            continue
        project = _read_canvaspro_json(filename, {})
        if not isinstance(project, dict):
            continue
        stored_filename = filename[len("project_") :]
        projects.append(
            {
                "filename": project.get("filename") or stored_filename,
                "projectName": project.get("projectName") or project.get("name") or stored_filename.removesuffix(".json"),
                "updatedAt": project.get("updatedAt") or project.get("savedAt") or "",
                "data": project,
            }
        )
    return sorted(projects, key=lambda item: str(item.get("updatedAt") or ""), reverse=True)


def _save_canvaspro_project(payload: dict[str, Any]) -> dict[str, Any]:
    project_name = payload.get("projectName") or payload.get("name") or payload.get("filename") or "default_v2_project"
    filename = _canvaspro_project_filename(project_name)
    project = {
        **payload,
        "filename": filename,
        "projectName": payload.get("projectName") or str(project_name),
        "updatedAt": datetime.now(UTC).isoformat(),
    }
    _write_canvaspro_json(_canvaspro_project_store_file(filename), project)
    return {"success": True, "filename": filename, "data": project}


def _should_canvaspro_status_fallback(path: str, method: str, status_code: int) -> bool:
    normalized = path.strip("/")
    method = method.upper()
    if status_code == 404:
        if method in {"GET", "POST", "PUT", "PATCH"} and normalized.startswith("api/v2/projects/"):
            return True
        return (method, normalized) in _CANVASPRO_404_FALLBACK_ENDPOINTS
    if status_code in {502, 503, 504}:
        return _truthy_env("AI_CANVASPRO_COMPAT_ON_UPSTREAM_STATUS")
    return False


def _canvaspro_api_base_is_loopback() -> bool:
    try:
        hostname = urlparse(_canvaspro_api_base()).hostname
    except ValueError:
        return False
    return hostname in {"127.0.0.1", "localhost", "::1"}


def _should_canvaspro_local_unavailable_fallback(status_code: int, content: bytes) -> bool:
    if status_code not in {502, 503, 504}:
        return False
    if not _canvaspro_api_base_is_loopback():
        return False
    try:
        text = content[:8192].decode("utf-8", errors="ignore").lower()
    except Exception:
        return False
    return any(marker in text for marker in _CANVASPRO_LOCAL_UNAVAILABLE_MARKERS)


def _canvaspro_compat_response(path: str, method: str, body: bytes) -> Optional[Response]:
    normalized = path.strip("/")
    method = method.upper()

    if normalized == "api/v2/runtime/info" and method == "GET":
        return _canvaspro_compat_json(
            {
                "provider": "studio",
                "available": False,
                "mode": "studio-compat",
                "isDevBuild": False,
                "isAdvancedMode": False,
                "features": {
                    "nativeApi": False,
                    "settingsStore": True,
                    "promptPresetsStore": True,
                },
                "message": "AI CanvasPro native server is not running; Studio compatibility mode is active.",
            }
        )

    if normalized == "api/config":
        if method == "GET":
            config = _read_canvaspro_json("config.json", {"providers": {}})
            return _canvaspro_compat_json(
                {
                    "success": True,
                    "data": _redact_canvaspro_secrets(config),
                    "secretPersistence": "disabled",
                }
            )
        if method in {"POST", "PUT", "PATCH"}:
            config = _write_canvaspro_json("config.json", _redact_canvaspro_secrets(_request_json_body(body)))
            return _canvaspro_compat_json(
                {
                    "success": True,
                    "data": config,
                    "secretPersistence": "disabled",
                }
            )

    if normalized == "api/v2/user/settings.json":
        if method == "GET":
            return _canvaspro_compat_json(_read_canvaspro_json("settings.json", {}))
        if method in {"POST", "PUT", "PATCH"}:
            settings = _write_canvaspro_json("settings.json", _request_json_body(body))
            return _canvaspro_compat_json(settings)

    if normalized == "api/v2/user/shortcuts.json":
        if method == "GET":
            return _canvaspro_compat_json(_read_canvaspro_json("shortcuts.json", {}))
        if method in {"POST", "PUT", "PATCH"}:
            shortcuts = _write_canvaspro_json("shortcuts.json", _request_json_body(body))
            return _canvaspro_compat_json(shortcuts)

    if normalized == "api/v2/user/asset-categories.json":
        if method == "GET":
            return _canvaspro_compat_json(_read_canvaspro_json("asset-categories.json", {}))
        if method in {"POST", "PUT", "PATCH"}:
            categories = _write_canvaspro_json("asset-categories.json", _request_json_body(body))
            return _canvaspro_compat_json(categories)

    if normalized == "api/v2/user/presets" and method == "GET":
        return _canvaspro_compat_json(_read_canvaspro_json("presets.json", {}))

    if normalized == "api/v2/user/presets/save" and method == "POST":
        presets = _save_canvaspro_preset(_request_json_body(body))
        return _canvaspro_compat_json({"success": True, "data": presets})

    if normalized == "api/v2/user/presets/delete" and method == "POST":
        presets = _delete_canvaspro_preset(_request_json_body(body))
        return _canvaspro_compat_json({"success": True, "data": presets})

    if normalized == "api/v2/dreamina/status" and method == "GET":
        return _canvaspro_compat_json(
            {
                "available": False,
                "status": "unavailable",
                "message": "Dreamina status requires the native AI CanvasPro server.",
            }
        )

    if normalized == "api/v2/subscription/status" and method == "GET":
        return _canvaspro_compat_json(
            {
                "status": "inactive",
                "active": False,
                "entitledModelKeys": [],
                "entitledModelIds": [],
            }
        )

    if normalized == "api/v2/update/check" and method == "GET":
        return _canvaspro_compat_json({"available": False, "hasUpdate": False})

    if normalized == "api/v2/heartbeat_stream" and method == "GET":
        return _canvaspro_compat_heartbeat_stream()

    if normalized == "api/v2/assets" and method == "GET":
        return _canvaspro_compat_json({"items": [], "assets": []})

    if normalized == "api/v2/workflows" and method == "GET":
        return _canvaspro_compat_json([])

    if normalized == "api/v2/projects" and method == "GET":
        return _canvaspro_compat_json(_list_canvaspro_projects())

    if normalized == "api/v2/projects/save" and method == "POST":
        return _canvaspro_compat_json(_save_canvaspro_project(_request_json_body(body)))

    if normalized.startswith("api/v2/projects/"):
        project_name = normalized[len("api/v2/projects/") :]
        project_file = _canvaspro_project_store_file(project_name or "default_v2_project.json")
        missing = object()
        if method == "GET":
            project = _read_canvaspro_json(project_file, missing)
            if project is missing:
                if _canvaspro_project_filename(project_name) == "default_v2_project.json":
                    return _canvaspro_compat_json(
                        {
                            "filename": "default_v2_project.json",
                            "projectName": "Default CanvasPro Project",
                            "activeCanvasId": "canvas_1",
                            "canvases": [
                                {
                                    "id": "canvas_1",
                                    "name": "Default canvas",
                                    "nodes": [],
                                    "edges": [],
                                    "viewport": {"x": 0, "y": 0, "zoom": 1},
                                    "assets": [],
                                }
                            ],
                            "updatedAt": "",
                        }
                    )
                return _canvaspro_compat_json({"error": "Project not found"}, status_code=404)
            return _canvaspro_compat_json(project)
        if method in {"POST", "PUT", "PATCH"}:
            project = _write_canvaspro_json(project_file, _request_json_body(body))
            return _canvaspro_compat_json({"success": True, "data": project})

    if normalized.startswith("api/v2/user/file-save-paths/migration/"):
        return _canvaspro_compat_json(
            {"error": "File migration requires the native AI CanvasPro server."},
            status_code=404,
        )

    return None


async def proxy_ai_canvaspro_api(path: str, request: Request):
    target = f"{_canvaspro_api_base()}/{path}"
    if request.url.query:
        target = f"{target}?{request.url.query}"
    body = await request.body()
    try:
        async with httpx.AsyncClient(timeout=60.0, follow_redirects=False, trust_env=False) as client:
            upstream = await client.request(
                request.method,
                target,
                headers=_proxy_headers(request),
                content=body,
            )
    except httpx.HTTPError as exc:
        fallback = _canvaspro_compat_response(path, request.method, body)
        if fallback is not None:
            return fallback
        raise HTTPException(
            status_code=502,
            detail=f"AI CanvasPro local server unavailable: {exc}",
        ) from exc

    if (
        _should_canvaspro_status_fallback(path, request.method, upstream.status_code)
        or _should_canvaspro_local_unavailable_fallback(upstream.status_code, upstream.content)
    ):
        fallback = _canvaspro_compat_response(path, request.method, body)
        if fallback is not None:
            return fallback

    return Response(
        content=upstream.content,
        status_code=upstream.status_code,
        headers=_response_headers(upstream.headers),
        media_type=upstream.headers.get("content-type"),
    )
