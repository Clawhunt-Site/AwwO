from __future__ import annotations

import os
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Awaitable, Callable

import httpx

from studio_app.infrastructure.runtime.health import (
    cookie_source_payload,
    dreamy_api_base_url,
    dreamyporn_web_api_base_url,
)
from studio_app.application.services.dreamy_protocol import (
    DREAMYPORN_UPLOAD_PREFIX,
    env_float,
)


StudioSegment = dict[str, Any]
DreamypornRequester = Callable[[str, dict[str, Any]], Awaitable[dict[str, Any]]]
DreamypornUploader = Callable[..., Awaitable[str]]

DREAMYPORN_COOKIE_DOMAIN_FRAGMENT = "dreamyporn.ai"
DREAMYPORN_UPLOAD_CONTENT_TYPES = {
    "image/png": 3,
    "image/jpeg": 4,
    "image/jpg": 4,
    "image/webp": 12,
}


def _repo_root() -> Path | None:
    for parent in Path(__file__).resolve().parents:
        if (parent / "frontend").exists() and (parent / "orchestrator").exists():
            return parent
    return None


async def dreamy_api_request(endpoint: str, body: dict[str, Any], init_data: str) -> dict[str, Any]:
    timeout = env_float("DREAMY_API_TIMEOUT_SECONDS", 30.0, minimum=1.0, maximum=120.0)
    url = f"{dreamy_api_base_url()}{endpoint}"
    headers = {
        "Content-Type": "application/json",
        "myshell-service-name": "organics-api",
        "X-Telegram-Init-Data": init_data,
        "Accept-Language": os.environ.get("DREAMY_ACCEPT_LANGUAGE") or "en",
    }
    async with httpx.AsyncClient(timeout=timeout) as client:
        response = await client.post(url, headers=headers, json=body)
    text = response.text
    if response.status_code >= 400:
        message = text[:500] if text else response.reason_phrase
        raise RuntimeError(f"Dreamy API {response.status_code} {endpoint}: {message}")
    if not text.strip():
        return {}
    try:
        payload = response.json()
    except Exception as exc:
        raise RuntimeError(f"Dreamy API returned invalid JSON for {endpoint}: {exc}") from exc
    return payload if isinstance(payload, dict) else {"data": payload}


def dreamyporn_timestamp(now_ms: int) -> int:
    base = (now_ms - now_ms % 10) // 10
    alternate = False
    checksum = 0
    value = base
    while value:
        digit = value % 10
        checksum += (5 if alternate else 2) * digit
        value = (value - digit) // 10
        alternate = not alternate
    return 10 * base + checksum % 10


def dreamyporn_cookie_header() -> str:
    cookies = cookie_source_payload()
    return "; ".join(
        f"{cookie.get('name')}={cookie.get('value')}"
        for cookie in cookies
        if isinstance(cookie, dict)
        and cookie.get("name")
        and cookie.get("value") is not None
        and DREAMYPORN_COOKIE_DOMAIN_FRAGMENT in str(cookie.get("domain") or "")
    )


async def dreamyporn_web_request(endpoint: str, body: dict[str, Any]) -> dict[str, Any]:
    cookie_header = dreamyporn_cookie_header()
    if not cookie_header:
        raise RuntimeError("DreamyPorn web cookies are missing; no external generation request was sent.")
    timeout = env_float("DREAMYPORN_API_TIMEOUT_SECONDS", 30.0, minimum=1.0, maximum=120.0)
    url = f"{dreamyporn_web_api_base_url()}{endpoint}"
    now_ms = int(datetime.now(UTC).timestamp() * 1000)
    headers = {
        "Content-Type": "application/json",
        "myshell-service-name": "organics-api",
        "platform": "web",
        "version": "1.0.0",
        "Accept-Language": os.environ.get("DREAMY_ACCEPT_LANGUAGE") or "en",
        "myshell-client-version": os.environ.get("DREAMYPORN_CLIENT_VERSION") or "v1.6.4",
        "timestamp": str(dreamyporn_timestamp(now_ms)),
        "Cookie": cookie_header,
    }
    async with httpx.AsyncClient(timeout=timeout) as client:
        response = await client.post(url, headers=headers, json=body)
    text = response.text
    if response.status_code >= 400:
        message = text[:500] if text else response.reason_phrase
        raise RuntimeError(f"DreamyPorn web API {response.status_code} {endpoint}: {message}")
    if not text.strip():
        return {}
    try:
        payload = response.json()
    except Exception as exc:
        raise RuntimeError(f"DreamyPorn web API returned invalid JSON for {endpoint}: {exc}") from exc
    return payload if isinstance(payload, dict) else {"data": payload}


def dreamyporn_default_input_image_file() -> Path | None:
    configured = os.environ.get("DREAMYPORN_DEFAULT_INPUT_IMAGE_FILE")
    candidates = [Path(configured)] if configured else []
    repo_root = _repo_root()
    if repo_root:
        candidates.extend(
            [
                repo_root / "frontend" / "public" / "generated" / "bot-previews" / "seedance-free.jpg",
                repo_root / "frontend" / "dist" / "generated" / "bot-previews" / "seedance-free.jpg",
            ]
        )
    candidates.append(Path("/app/frontend/dist/generated/bot-previews/seedance-free.jpg"))
    return next((path for path in candidates if path and path.exists()), None)


def guess_image_content_type(filename: str, fallback: str = "image/jpeg") -> str:
    suffix = Path(filename).suffix.lower()
    if suffix == ".png":
        return "image/png"
    if suffix == ".webp":
        return "image/webp"
    if suffix in {".jpg", ".jpeg"}:
        return "image/jpeg"
    return fallback


async def dreamyporn_upload_image(
    image_bytes: bytes,
    *,
    filename: str,
    content_type: str,
    request: DreamypornRequester = dreamyporn_web_request,
) -> str:
    content_type = content_type or guess_image_content_type(filename)
    content_type_id = DREAMYPORN_UPLOAD_CONTENT_TYPES.get(content_type, DREAMYPORN_UPLOAD_CONTENT_TYPES["image/jpeg"])
    presign = await request(
        f"{DREAMYPORN_UPLOAD_PREFIX}/get_put_object_pre_sign_url",
        {
            "file_info": {
                "scenario": 19,
                "content_type": content_type_id,
                "file_name": filename or "studio-source.jpg",
                "content_length": str(len(image_bytes)),
            }
        },
    )
    upload_url = str(presign.get("uploadUrl") or presign.get("upload_url") or "")
    object_access_url = str(presign.get("objectAccessUrl") or presign.get("object_access_url") or "")
    expires_at = str(presign.get("expiresAt") or presign.get("expires_at") or "")
    presign_content_type = str(presign.get("contentType") or presign.get("content_type") or content_type)
    if not upload_url or not object_access_url:
        raise RuntimeError("DreamyPorn upload presign response did not include uploadUrl/objectAccessUrl")
    headers = {"Content-Type": presign_content_type}
    if expires_at:
        headers["Expires"] = expires_at
    async with httpx.AsyncClient(timeout=env_float("DREAMYPORN_UPLOAD_TIMEOUT_SECONDS", 60.0, minimum=1.0, maximum=180.0)) as client:
        response = await client.put(upload_url, headers=headers, content=image_bytes)
    if response.status_code >= 400:
        raise RuntimeError(f"DreamyPorn upload failed: HTTP {response.status_code}")
    return object_access_url


def dreamyporn_source_media_url(source_segment: StudioSegment | None) -> str:
    if not source_segment:
        return ""
    candidate = str(source_segment.get("url") or "")
    if candidate.startswith("http") and ".mp4" not in candidate.lower():
        return candidate
    poster = str(source_segment.get("posterUrl") or "")
    return poster if poster.startswith("http") else ""


async def dreamyporn_web_input_images(
    *,
    source_segment: StudioSegment | None,
    input_image_bytes: bytes | None,
    input_image_filename: str,
    input_image_content_type: str,
    upload_image: DreamypornUploader = dreamyporn_upload_image,
) -> list[str]:
    source_url = dreamyporn_source_media_url(source_segment)
    if source_url:
        return [source_url]
    configured_url = os.environ.get("DREAMYPORN_DEFAULT_INPUT_IMAGE_URL", "").strip()
    if configured_url:
        return [configured_url]
    if input_image_bytes:
        return [
            await upload_image(
                input_image_bytes,
                filename=input_image_filename or "studio-source.jpg",
                content_type=input_image_content_type or guess_image_content_type(input_image_filename),
            )
        ]
    default_file = dreamyporn_default_input_image_file()
    if default_file:
        return [
            await upload_image(
                default_file.read_bytes(),
                filename=default_file.name,
                content_type=guess_image_content_type(default_file.name),
            )
        ]
    raise RuntimeError("DreamyPorn web generation requires a source image, source segment, or DREAMYPORN_DEFAULT_INPUT_IMAGE_URL.")
