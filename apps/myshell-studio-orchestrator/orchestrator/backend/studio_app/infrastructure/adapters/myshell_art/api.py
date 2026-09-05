from __future__ import annotations

import asyncio
import json
import time
from typing import Any, Awaitable, Callable

import httpx

from studio_app.infrastructure.runtime.health import _cookie_payload_status, cookie_source_payload


API_BASE = "https://api.myshell.ai"
Requester = Callable[[str, dict[str, Any], list[dict[str, Any]], float], Awaitable[dict[str, Any]]]
Sleeper = Callable[[float], Any]


def art_timestamp(now_ms: int | None = None) -> int:
    value = int(now_ms if now_ms is not None else time.time() * 1000)
    base = (value - value % 10) // 10
    flip = False
    checksum = 0
    cursor = base
    while cursor:
        digit = cursor % 10
        checksum += (5 if flip else 2) * digit
        cursor = (cursor - digit) // 10
        flip = not flip
    return 10 * base + checksum % 10


def _header_safe(value: str) -> bool:
    try:
        value.encode("latin-1")
    except UnicodeEncodeError:
        return False
    return True


def cookie_header(cookies: list[dict[str, Any]]) -> str:
    pairs: list[str] = []
    for cookie in cookies:
        pair = f"{cookie['name']}={cookie['value']}"
        if _header_safe(pair):
            pairs.append(pair)
    return "; ".join(pairs)


def ms_token(cookies: list[dict[str, Any]]) -> str:
    for cookie in cookies:
        if cookie.get("name") == "ms_token" and cookie.get("value"):
            token = str(cookie["value"])
            if _header_safe(token):
                return token
    return ""


def build_headers(cookies: list[dict[str, Any]], now_ms: int | None = None) -> dict[str, str]:
    token = ms_token(cookies)
    headers = {
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en",
        "Content-Type": "application/json",
        "Cookie": cookie_header(cookies),
        "myshell-service-name": "organics-api",
        "platform": "web",
        "version": "1.0.0",
        "myshell-client-version": "v1.6.4",
        "timestamp": str(art_timestamp(now_ms)),
        "User-Agent": "Mozilla/5.0 (compatible; myshell-studio-orchestrator/1.0)",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
        headers["x-call-from"] = "myshell-ssr"
    return headers


def load_configured_cookies() -> list[dict[str, Any]]:
    payload = cookie_source_payload()
    status = _cookie_payload_status(payload, mode="runtime", source="configured cookies")
    if status.get("status") != "ready":
        raise RuntimeError(str(status.get("message") or "MyShell cookies are not configured"))
    return [cookie for cookie in payload if isinstance(cookie, dict)]


async def post_json(path: str, body: dict[str, Any], cookies: list[dict[str, Any]], timeout: float = 30.0) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=timeout) as client:
        try:
            response = await client.post(
                f"{API_BASE}{path}",
                json=body,
                headers=build_headers(cookies),
            )
            try:
                payload: Any = response.json()
            except ValueError:
                payload = {"raw": response.text[:500]}
            return {"httpStatus": response.status_code, "payload": payload}
        except httpx.HTTPError as exc:
            return {"httpStatus": 0, "payload": {"success": False, "reason": str(exc)}}


def generate_body(bot_id: str, input_values: list[str], article_id: str = "") -> dict[str, Any]:
    body: dict[str, Any] = {"botId": bot_id, "inputImg": input_values}
    if article_id:
        body["articleId"] = article_id
    return body


def _payload_data(response: dict[str, Any]) -> dict[str, Any]:
    payload = response.get("payload") if isinstance(response.get("payload"), dict) else {}
    data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
    return data if isinstance(data, dict) else {}


def _payload_reason(response: dict[str, Any]) -> str:
    payload = response.get("payload") if isinstance(response.get("payload"), dict) else {}
    return str(payload.get("reason") or payload.get("msg") or payload.get("message") or "")


def _safe_probe_summary(response: dict[str, Any]) -> dict[str, Any]:
    payload = response.get("payload") if isinstance(response.get("payload"), dict) else {}
    reason = payload.get("reason") or payload.get("msg") or payload.get("message") or ""
    data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
    explicit_success = payload.get("success")
    return {
        "httpStatus": response.get("httpStatus"),
        "success": bool(explicit_success) if explicit_success is not None else bool(payload) and not reason,
        "reason": reason,
        "dataKeys": sorted(str(key) for key in data.keys()),
    }


async def probe_art_api_auth(
    *,
    cookies: list[dict[str, Any]] | None = None,
    requester: Requester = post_json,
) -> dict[str, Any]:
    active_cookies = cookies or load_configured_cookies()
    auth = await requester("/v1/user/get_info", {}, active_cookies, 30.0)
    running = await requester("/v1/homepage/art/task/running", {}, active_cookies, 30.0)
    ready = auth.get("httpStatus") == 200 and running.get("httpStatus") != 401
    return {
        "status": "ready" if ready else "auth_missing",
        "ready": ready,
        "message": "MyShell Art API auth is ready." if ready else "MyShell Art API auth probe failed.",
        "authProbe": _safe_probe_summary(auth),
        "runningTasksProbe": _safe_probe_summary(running),
    }


def _output_job_id(response: dict[str, Any]) -> str:
    data = _payload_data(response)
    return str(data.get("outputJobId") or data.get("output_job_id") or data.get("jobId") or "")


def _accepted_media_from_result(response: dict[str, Any]) -> str:
    data = _payload_data(response)
    tasks = data.get("tasks") if isinstance(data.get("tasks"), list) else data.get("list") if isinstance(data.get("list"), list) else []
    for task in tasks:
        if not isinstance(task, dict):
            continue
        result = task.get("result")
        if isinstance(result, str):
            try:
                result = json.loads(result)
            except json.JSONDecodeError:
                result = {}
        if isinstance(result, dict):
            for key in ("outputImg", "outputVideo", "outputPreview", "mediaUrl", "url"):
                if result.get(key):
                    return str(result[key])
    return ""


async def generate_via_art_api(
    *,
    bot_id: str,
    input_values: list[str],
    cookies: list[dict[str, Any]] | None = None,
    article_id: str = "",
    poll_attempts: int = 3,
    poll_interval: float = 1.0,
    requester: Requester = post_json,
    sleep: Sleeper = asyncio.sleep,
) -> dict[str, Any]:
    active_cookies = cookies or load_configured_cookies()
    auth = await requester("/v1/user/get_info", {}, active_cookies, 30.0)
    running = await requester("/v1/homepage/art/task/running", {}, active_cookies, 30.0)
    if auth.get("httpStatus") != 200 or running.get("httpStatus") == 401:
        return {
            "status": "auth_missing",
            "message": "MyShell Art API auth probe failed; generation was not submitted.",
            "reason": _payload_reason(auth) or _payload_reason(running),
            "executor": "myshell-art-api",
        }
    generation = await requester(
        "/v1/homepage/art/generate",
        generate_body(bot_id, input_values, article_id),
        active_cookies,
        60.0,
    )
    output_job_id = _output_job_id(generation)
    if not output_job_id:
        return {
            "status": "error",
            "message": _payload_reason(generation) or "MyShell Art API did not return an outputJobId.",
            "executor": "myshell-art-api",
        }
    latest_result: dict[str, Any] = {}
    accepted_media = ""
    for _attempt in range(max(1, poll_attempts)):
        latest_result = await requester(
            "/v1/homepage/art/generate_result",
            {"outputJobId": output_job_id},
            active_cookies,
            60.0,
        )
        accepted_media = _accepted_media_from_result(latest_result)
        if accepted_media:
            break
        maybe_sleep = sleep(poll_interval)
        if hasattr(maybe_sleep, "__await__"):
            await maybe_sleep
    if not accepted_media:
        return {
            "status": "running",
            "message": _payload_reason(latest_result) or "MyShell Art API result is still pending.",
            "task_id": output_job_id,
            "executor": "myshell-art-api",
        }
    return {
        "status": "done",
        "output_url": accepted_media,
        "task_id": output_job_id,
        "executor": "myshell-art-api",
    }


async def fetch_art_api_result(
    *,
    task_id: str,
    cookies: list[dict[str, Any]] | None = None,
    requester: Requester = post_json,
) -> dict[str, Any]:
    active_cookies = cookies or load_configured_cookies()
    output_job_id = str(task_id or "").strip()
    if not output_job_id:
        return {
            "status": "ready",
            "message": "MyShell Art API result sync needs an outputJobId.",
            "executor": "myshell-art-api",
        }

    result = await requester(
        "/v1/homepage/art/generate_result",
        {"outputJobId": output_job_id},
        active_cookies,
        60.0,
    )
    if result.get("httpStatus") == 401:
        return {
            "status": "auth_missing",
            "message": "MyShell Art API auth is not ready for result sync.",
            "task_id": output_job_id,
            "executor": "myshell-art-api",
            "raw": result,
        }
    if result.get("httpStatus") and result.get("httpStatus") >= 500:
        return {
            "status": "error",
            "message": _payload_reason(result) or f"MyShell Art API result sync returned HTTP {result.get('httpStatus')}.",
            "task_id": output_job_id,
            "executor": "myshell-art-api",
            "raw": result,
        }

    accepted_media = _accepted_media_from_result(result)
    if accepted_media:
        return {
            "status": "done",
            "message": "MyShell Art API returned media.",
            "output_url": accepted_media,
            "task_id": output_job_id,
            "executor": "myshell-art-api",
            "raw": result,
        }
    return {
        "status": "running",
        "message": _payload_reason(result) or "MyShell Art API result is still pending.",
        "task_id": output_job_id,
        "executor": "myshell-art-api",
        "raw": result,
    }
