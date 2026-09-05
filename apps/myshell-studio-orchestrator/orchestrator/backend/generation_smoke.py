from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin
from urllib.request import Request, urlopen


class GenerationSmokeFailure(RuntimeError):
    pass


def _request_headers() -> dict[str, str]:
    headers = {"Accept": "application/json"}
    token = os.environ.get("STUDIO_AUTH_TOKEN", "").strip()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def _request_json(base_url: str, *, execute: bool, prompt: str, timeout: float) -> dict[str, Any]:
    url = urljoin(base_url.rstrip("/") + "/", "/api/studio/generation-smoke".lstrip("/"))
    headers = _request_headers()
    if execute:
        payload = json.dumps({"execute": True, "prompt": prompt}, ensure_ascii=False).encode("utf-8")
        request = Request(url, data=payload, headers={**headers, "Content-Type": "application/json"}, method="POST")
    else:
        request = Request(url, headers=headers)
    try:
        with urlopen(request, timeout=timeout) as response:
            text = response.read().decode("utf-8")
    except (HTTPError, URLError, TimeoutError) as error:
        raise GenerationSmokeFailure(f"generation smoke request failed: {error}") from error
    try:
        payload = json.loads(text)
    except json.JSONDecodeError as error:
        raise GenerationSmokeFailure("generation smoke did not return JSON") from error
    if not isinstance(payload, dict):
        raise GenerationSmokeFailure("generation smoke returned a non-object payload")
    return payload


def run_generation_smoke(
    base_url: str,
    *,
    execute: bool = False,
    require_live: bool = False,
    prompt: str = "",
    timeout: float = 120.0,
) -> dict[str, Any]:
    result = _request_json(base_url, execute=execute, prompt=prompt, timeout=timeout)
    latest = result.get("latest") if isinstance(result.get("latest"), dict) else {}
    accepted = bool(latest.get("accepted")) and bool(latest.get("mediaUrl"))
    if require_live and not accepted:
        status = result.get("status") or "unknown"
        message = result.get("message") or "live generation media was not accepted"
        raise GenerationSmokeFailure(f"live generation smoke failed: {status}: {message}")
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Verify MyShell Studio live generation readiness or run a real Dreamy smoke.")
    parser.add_argument("--base-url", default="http://127.0.0.1:8090", help="Studio backend URL")
    parser.add_argument("--execute", action="store_true", help="Run a real Dreamy generation smoke through backend credentials")
    parser.add_argument("--require-live", action="store_true", help="Exit non-zero unless accepted media is present")
    parser.add_argument(
        "--prompt",
        default=os.environ.get("DREAMY_LIVE_SMOKE_PROMPT")
        or "Create a short cinematic neon city source image for live generation smoke.",
    )
    parser.add_argument("--timeout", type=float, default=120.0, help="Request timeout in seconds")
    args = parser.parse_args(argv)

    try:
        result = run_generation_smoke(
            args.base_url,
            execute=args.execute,
            require_live=args.require_live,
            prompt=args.prompt,
            timeout=args.timeout,
        )
    except GenerationSmokeFailure as error:
        print(json.dumps({"status": "failed", "message": str(error)}, indent=2, ensure_ascii=False))
        return 1
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
