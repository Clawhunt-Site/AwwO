from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

from studio_app.registry.bot_catalog import MYSHELL_BOTS


def _backend_dir() -> Path:
    return Path(__file__).resolve().parents[2]


DEFAULT_PAGE_ID = "dreamy-miniapp"
DEFAULT_MANIFEST_PATH = _backend_dir() / "studio_pages_manifest.json"
MINIAPP_BASE_URL = "https://api.myshell.fun/v1/telegram/miniapp/dreamy"


def _navigation_page(
    page_id: str,
    name: str,
    app_route: str,
    capabilities: list[str],
    *,
    kind: str = "miniapp-page",
    route_params: list[str] | None = None,
    base_url: str = MINIAPP_BASE_URL,
    intent_keywords: list[str] | None = None,
    route_defaults: dict[str, str] | None = None,
    manifest_version: str = "",
    registry_source: str = "code",
) -> dict[str, Any]:
    page = {
        "id": page_id,
        "name": name,
        "kind": kind,
        "baseUrl": base_url,
        "appRoute": app_route,
        "executor": "navigation",
        "authMode": "telegram-init-data",
        "status": "available",
        "dispatchMode": "open-page",
        "routeParams": route_params or [],
        "capabilities": capabilities,
        "registrySource": registry_source,
    }
    if manifest_version:
        page["manifestVersion"] = manifest_version
    if intent_keywords:
        page["intentKeywords"] = intent_keywords
    if route_defaults:
        page["routeDefaults"] = route_defaults
    return page


def _core_pages() -> list[dict[str, Any]]:
    return [
        {
            "id": "dreamy-miniapp",
            "name": "Dreamy Miniapp",
            "kind": "miniapp",
            "baseUrl": MINIAPP_BASE_URL,
            "executor": "client",
            "authMode": "telegram-init-data",
            "status": "available",
            "dispatchMode": "execute-client",
            "appRoute": "/dreamy",
            "registrySource": "code",
            "capabilities": [
                "generate",
                "generate-result",
                "task-running",
                "task-cancel",
                "task-retry",
                "library",
            ],
        },
        {
            "id": "myshell-art",
            "name": "MyShell Art",
            "kind": "web-cdp",
            "baseUrl": "https://art.myshell.ai",
            "executor": "server",
            "authMode": "browser-cookies",
            "status": "available",
            "dispatchMode": "execute-server",
            "appRoute": "",
            "botCount": len(MYSHELL_BOTS),
            "registrySource": "code",
            "capabilities": [
                "page-open",
                "image-upload",
                "generate",
                "progress-detect",
                "new-media-evidence",
            ],
        },
    ]


def _manifest_path() -> Path:
    configured = os.environ.get("STUDIO_PAGES_MANIFEST")
    return Path(configured) if configured else DEFAULT_MANIFEST_PATH


def _load_pages_manifest() -> dict[str, Any]:
    manifest_path = _manifest_path()
    if not manifest_path.exists():
        return {"version": "missing", "pages": []}
    with manifest_path.open(encoding="utf-8") as manifest_file:
        manifest = json.load(manifest_file)
    if not isinstance(manifest, dict):
        raise ValueError(f"Studio pages manifest must be an object: {manifest_path}")
    pages = manifest.get("pages", [])
    if not isinstance(pages, list):
        raise ValueError(f"Studio pages manifest pages must be a list: {manifest_path}")
    return manifest


def _as_str_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, str) and item.strip()]


def _as_str_dict(value: Any) -> dict[str, str]:
    if not isinstance(value, dict):
        return {}
    normalized: dict[str, str] = {}
    for key, item in value.items():
        key_text = str(key).strip()
        if key_text and item is not None:
            normalized[key_text] = str(item)
    return normalized


def _page_from_manifest(raw_page: dict[str, Any], manifest_version: str) -> dict[str, Any]:
    page_id = str(raw_page.get("id") or "").strip()
    if not page_id:
        raise ValueError("Studio manifest page is missing id")
    name = str(raw_page.get("name") or page_id)
    app_route = str(raw_page.get("appRoute") or "")
    return _navigation_page(
        page_id,
        name,
        app_route,
        _as_str_list(raw_page.get("capabilities")),
        kind=str(raw_page.get("kind") or "miniapp-page"),
        route_params=_as_str_list(raw_page.get("routeParams")),
        base_url=str(raw_page.get("baseUrl") or MINIAPP_BASE_URL),
        intent_keywords=_as_str_list(raw_page.get("intentKeywords")),
        route_defaults=_as_str_dict(raw_page.get("routeDefaults")),
        manifest_version=manifest_version,
        registry_source="manifest",
    )


def _manifest_pages() -> list[dict[str, Any]]:
    manifest = _load_pages_manifest()
    manifest_version = str(manifest.get("version") or "")
    return [_page_from_manifest(page, manifest_version) for page in manifest.get("pages", []) if isinstance(page, dict)]


def list_studio_pages() -> list[dict[str, Any]]:
    pages_by_id: dict[str, dict[str, Any]] = {}
    ordered_ids: list[str] = []

    for page in [*_core_pages(), *_manifest_pages()]:
        page_id = page["id"]
        if page_id not in pages_by_id:
            ordered_ids.append(page_id)
        pages_by_id[page_id] = page

    return [pages_by_id[page_id] for page_id in ordered_ids]


def list_studio_agents() -> list[dict[str, Any]]:
    return [
        {
            "id": "intent-router",
            "label": "Intent Router",
            "pageId": "studio",
            "role": "Turns natural language into a route and bot target.",
            "capabilities": ["prompt-analysis", "bot-selection"],
        },
        {
            "id": "asset-planner",
            "label": "Asset Planner",
            "pageId": "studio",
            "role": "Chooses source media and output shape.",
            "capabilities": ["source-selection", "segment-planning"],
        },
        {
            "id": "dreamy-miniapp-executor",
            "label": "Dreamy Miniapp Executor",
            "pageId": "dreamy-miniapp",
            "role": "Delegates Dreamy miniapp jobs to the authenticated browser client.",
            "capabilities": ["generate", "poll-result", "cancel", "retry"],
        },
        {
            "id": "myshell-art-cdp-executor",
            "label": "MyShell Art CDP Executor",
            "pageId": "myshell-art",
            "role": "Runs MyShell Art pages through the Chrome DevTools bridge.",
            "capabilities": ["open-page", "upload-image", "click-generate", "extract-new-media"],
        },
        {
            "id": "miniapp-page-navigator",
            "label": "Miniapp Page Navigator",
            "pageId": "miniapp",
            "role": "Dispatches operators into registered MyShell miniapp pages.",
            "capabilities": ["open-page", "restore-route", "surface-intent"],
        },
        {
            "id": "evidence-verifier",
            "label": "Evidence Verifier",
            "pageId": "studio",
            "role": "Accepts only fresh media, task ids, or explicit failure states.",
            "capabilities": ["freshness-check", "auth-state", "timeout-state"],
        },
        {
            "id": "timeline",
            "label": "Timeline",
            "pageId": "studio",
            "role": "Stores accepted segment state in the project timeline.",
            "capabilities": ["append-segment", "select-segment", "persist-project"],
        },
    ]


def get_page(page_id: str | None) -> dict[str, Any]:
    pages = list_studio_pages()
    for page in pages:
        if page["id"] == page_id:
            return page
    return pages[0]


def _keyword_matches(normalized_message: str, keyword: str) -> bool:
    normalized_keyword = keyword.lower().strip()
    if not normalized_keyword:
        return False
    if re.fullmatch(r"[a-z0-9-]+", normalized_keyword):
        return re.search(rf"(?<![a-z0-9]){re.escape(normalized_keyword)}(?![a-z0-9])", normalized_message) is not None
    return normalized_keyword in normalized_message


def infer_navigation_page_from_prompt(message: str) -> dict[str, Any] | None:
    normalized = (message or "").lower()
    if not normalized:
        return None

    best_page: dict[str, Any] | None = None
    best_score = 0
    for page in list_studio_pages():
        if page.get("executor") != "navigation":
            continue
        keywords = _as_str_list(page.get("intentKeywords"))
        score = sum(1 for keyword in keywords if _keyword_matches(normalized, keyword))
        if score > best_score:
            best_page = page
            best_score = score

    return best_page


def page_for_bot(bot: dict[str, Any], preferred_page_id: str | None = None) -> dict[str, Any]:
    preferred = get_page(preferred_page_id)
    if preferred["id"] == "myshell-art" or preferred.get("executor") == "navigation":
        return preferred
    return get_page(DEFAULT_PAGE_ID)


def page_for_dispatch(
    bot: dict[str, Any],
    preferred_page_id: str | None = None,
    message: str = "",
) -> dict[str, Any]:
    preferred = get_page(preferred_page_id)
    if preferred["id"] != DEFAULT_PAGE_ID:
        return page_for_bot(bot, preferred_page_id)

    inferred = infer_navigation_page_from_prompt(message)
    if inferred:
        return inferred
    return page_for_bot(bot, preferred_page_id)
