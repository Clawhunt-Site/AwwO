#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


API_BASE = "https://api.myshell.ai"


class MyShellArtApiProbeError(RuntimeError):
    pass


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


def load_cookies(path: Path) -> list[dict[str, Any]]:
    with path.open(encoding="utf-8") as handle:
        payload = json.load(handle)
    if not isinstance(payload, list):
        raise MyShellArtApiProbeError(f"{path} must contain a JSON cookie array")
    cookies = [cookie for cookie in payload if isinstance(cookie, dict) and cookie.get("name") and cookie.get("value")]
    if not cookies:
        raise MyShellArtApiProbeError(f"{path} contains no usable cookies")
    return cookies


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
        if not _header_safe(pair):
            continue
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


def post_json(path: str, body: dict[str, Any], cookies: list[dict[str, Any]], timeout: float = 30.0) -> dict[str, Any]:
    request = Request(
        f"{API_BASE}{path}",
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers=build_headers(cookies),
        method="POST",
    )
    try:
        with urlopen(request, timeout=timeout) as response:
            text = response.read().decode("utf-8", errors="replace")
            http_status = response.status
    except HTTPError as exc:
        text = exc.read().decode("utf-8", errors="replace")
        http_status = exc.code
    except (TimeoutError, URLError) as exc:
        raise MyShellArtApiProbeError(f"request failed for {path}: {exc}") from exc
    try:
        payload: Any = json.loads(text) if text else {}
    except json.JSONDecodeError:
        payload = {"raw": text[:500]}
    return {"httpStatus": http_status, "payload": payload}


def safe_probe_summary(payload: dict[str, Any]) -> dict[str, Any]:
    reason = payload.get("reason") or payload.get("msg") or payload.get("message") or ""
    data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
    explicit_success = payload.get("success")
    return {
        "success": bool(explicit_success) if explicit_success is not None else bool(payload) and not reason,
        "reason": reason,
        "dataKeys": sorted(str(key) for key in data.keys()),
    }


def safe_http_summary(response: dict[str, Any]) -> dict[str, Any]:
    payload = response.get("payload") if isinstance(response.get("payload"), dict) else {}
    return {
        "httpStatus": response.get("httpStatus"),
        **safe_probe_summary(payload),
    }


def generate_body(bot_id: str, input_img: list[str], article_id: str = "") -> dict[str, Any]:
    body: dict[str, Any] = {"botId": bot_id, "inputImg": input_img}
    if article_id:
        body["articleId"] = article_id
    return body


def _output_job_id(response: dict[str, Any]) -> str:
    payload = response.get("payload") if isinstance(response.get("payload"), dict) else {}
    data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
    return str(data.get("outputJobId") or data.get("output_job_id") or data.get("jobId") or "")


def _accepted_media_from_result(response: dict[str, Any]) -> str:
    payload = response.get("payload") if isinstance(response.get("payload"), dict) else {}
    data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
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


Poster = Callable[[str, dict[str, Any], list[dict[str, Any]], float], dict[str, Any]]
Sleeper = Callable[[float], None]


def run_probe(
    cookies: list[dict[str, Any]],
    *,
    bot_id: str = "",
    execute: bool = False,
    input_values: list[str] | None = None,
    poll_attempts: int = 3,
    poster: Poster = post_json,
    sleep: Sleeper = time.sleep,
) -> dict[str, Any]:
    auth = poster("/v1/user/get_info", {}, cookies, 30.0)
    running = poster("/v1/homepage/art/task/running", {}, cookies, 30.0)
    report: dict[str, Any] = {
        "status": "ready" if auth.get("httpStatus") == 200 else "blocked",
        "authProbe": safe_http_summary(auth),
        "runningTasksProbe": safe_http_summary(running),
        "execute": execute,
    }
    if not execute:
        return report
    if report["status"] != "ready" or running.get("httpStatus") == 401:
        report["message"] = "MyShell Art API auth probe failed; generation was not submitted."
        return report
    if not bot_id:
        raise MyShellArtApiProbeError("--bot-id is required with --execute")
    generation = poster("/v1/homepage/art/generate", generate_body(bot_id, input_values or []), cookies, 60.0)
    output_job_id = _output_job_id(generation)
    report["generation"] = {
        **safe_http_summary(generation),
        "outputJobIdPresent": bool(output_job_id),
    }
    if not output_job_id:
        report["status"] = "blocked"
        return report
    latest_result: dict[str, Any] = {}
    accepted_media = ""
    for _attempt in range(max(1, poll_attempts)):
        latest_result = poster("/v1/homepage/art/generate_result", {"outputJobId": output_job_id}, cookies, 60.0)
        accepted_media = _accepted_media_from_result(latest_result)
        if accepted_media:
            break
        sleep(1.0)
    report["generationResult"] = {
        **safe_http_summary(latest_result),
        "acceptedMedia": bool(accepted_media),
        "mediaUrl": accepted_media,
    }
    report["status"] = "ready" if accepted_media else "running"
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Probe MyShell Art homepage API with a local cookie file without printing secrets.")
    parser.add_argument("--cookies-file", type=Path, required=True)
    parser.add_argument("--bot-id", default="")
    parser.add_argument("--input-value", action="append", default=[], help="Value to send in the Art API inputImg array. Repeat in form order.")
    parser.add_argument("--execute", action="store_true", help="Submit a real generation request. Default only probes auth and running tasks.")
    parser.add_argument("--poll-attempts", type=int, default=3)
    args = parser.parse_args(argv)
    try:
        report = run_probe(
            load_cookies(args.cookies_file.expanduser()),
            bot_id=args.bot_id,
            execute=args.execute,
            input_values=args.input_value,
            poll_attempts=args.poll_attempts,
        )
    except MyShellArtApiProbeError as exc:
        print(json.dumps({"status": "error", "message": str(exc)}, indent=2, ensure_ascii=False), file=sys.stderr)
        return 1
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0 if report["status"] in {"ready", "running"} else 1


if __name__ == "__main__":
    raise SystemExit(main())
