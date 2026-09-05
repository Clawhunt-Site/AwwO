from __future__ import annotations

import json
import re
from typing import Any
from urllib.parse import parse_qsl, quote, urlsplit


def normalize_dreamy_bot_type(bot_type: str | None) -> str:
    normalized = (bot_type or "").strip().lower()
    if normalized in {"video", "image-to-video", "text-to-video"}:
        return "image-to-video"
    if normalized in {"image", "text-to-image", "image-to-image"}:
        return "text-to-image"
    return "text-to-image"


def dreamy_catalog_type_from_media(item: dict[str, Any]) -> str:
    title = str(item.get("title") or item.get("botName") or "").lower()
    media_values = [
        str(item.get("templateUrl") or ""),
        str(item.get("templatePosterUrl") or ""),
        str(item.get("imageUrl") or ""),
        str(item.get("imagePosterUrl") or ""),
    ]
    if any(value.lower().endswith(".mp4") for value in media_values):
        return "image-to-video"
    if any(word in title for word in ("video", "dance", "motion", "animate")):
        return "image-to-video"
    return "text-to-image"


def slug_from_dreamy_goto_link(goto_link: str) -> str:
    if not goto_link:
        return ""
    parsed = urlsplit(goto_link)
    query_slug = dict(parse_qsl(parsed.query)).get("slug_id")
    if query_slug:
        return query_slug
    path = parsed.path or goto_link
    return path.rstrip("/").split("/")[-1]


def dreamy_bot_route(
    *,
    bot_id: str | None = None,
    bot_slug: str | None,
    bot_name: str | None = None,
    bot_type: str | None = None,
    article_id: str | None = None,
    message: str = "",
    seed: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    explicit_bot_id = (bot_id or "").strip()
    slug = (bot_slug or explicit_bot_id).strip()
    if not slug:
        return None
    seed = seed or {}
    resolved_type = normalize_dreamy_bot_type(bot_type or seed.get("type"))
    name = (bot_name or seed.get("name") or explicit_bot_id or slug).strip()
    resolved_article_id = (article_id or slug).strip()
    description = str(seed.get("desc") or "Selected from the Dreamy miniapp bot catalog.")
    return {
        "intent": "image-to-video" if resolved_type == "image-to-video" else "text-to-image",
        "analysis": "Selected explicitly from the Dreamy Studio bot list.",
        "optimizedPrompt": message or "Create a polished Dreamy media segment.",
        "reason": "Pinned by the left-side Dreamy bot selection.",
        "bot": {
            "id": explicit_bot_id,
            "slug": slug,
            "name": name,
            "type": resolved_type,
            "articleId": resolved_article_id,
            "rating": seed.get("rating", 4.6),
            "description": description,
            "pageUrl": f"/bot?slug_id={quote(slug)}",
        },
        "executor": "client",
    }


def manual_bot_sequence_items(
    bot_sequence: str | None,
    default_action: str,
    *,
    valid_actions: set[str],
) -> list[dict[str, str]]:
    raw = (bot_sequence or "").strip()
    if not raw:
        return []
    parsed: Any
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        parsed = [item for item in re.split(r"[\s,]+", raw) if item]
    if isinstance(parsed, dict):
        parsed = parsed.get("bots") or parsed.get("sequence") or parsed.get("items") or []
    if not isinstance(parsed, list):
        return []

    items: list[dict[str, str]] = []
    for index, item in enumerate(parsed[:12]):
        if isinstance(item, str):
            item_data: dict[str, Any] = {"botId": item, "botSlug": item}
        elif isinstance(item, dict):
            item_data = item
        else:
            continue
        bot_id = str(item_data.get("botId") or item_data.get("bot_id") or item_data.get("id") or "").strip()
        bot_slug = str(item_data.get("botSlug") or item_data.get("bot_slug") or item_data.get("slug") or bot_id).strip()
        if not bot_id and not bot_slug:
            continue
        bot_name = str(
            item_data.get("botName")
            or item_data.get("bot_name")
            or item_data.get("name")
            or bot_slug
            or bot_id
        ).strip()
        bot_type = str(item_data.get("botType") or item_data.get("bot_type") or item_data.get("type") or "").strip()
        article_id = str(
            item_data.get("articleId")
            or item_data.get("article_id")
            or item_data.get("article")
            or bot_slug
            or bot_id
        ).strip()
        requested_action = str(item_data.get("action") or ("extend" if index else default_action))
        action = requested_action if requested_action in valid_actions else "generate"
        prompt = str(item_data.get("prompt") or item_data.get("message") or "").strip()
        items.append(
            {
                "botId": bot_id,
                "botSlug": bot_slug,
                "botName": bot_name,
                "botType": bot_type,
                "articleId": article_id,
                "action": action,
                "prompt": prompt,
            }
        )
    return items


def keyword_route(
    message: str,
    has_image: bool,
    action: str,
    *,
    bots: list[dict[str, Any]],
    default_bot: dict[str, Any],
) -> dict[str, Any]:
    normalized = (message or "").lower()
    wants_video = action == "extend" or any(
        word in normalized for word in ("video", "animate", "motion", "movie", "clip", "extend")
    )
    wants_style = action == "restyle" or any(
        word in normalized for word in ("style", "restyle", "anime", "pixel", "sketch", "neon", "cyber")
    )

    best = None
    best_score = -1.0
    for bot in bots:
        score = float(bot.get("rating", 4.0))
        if wants_video and bot.get("type") == "image-to-video":
            score += 8
        if wants_style and bot.get("type") == "image-to-image":
            score += 4
        if not has_image and bot.get("type") == "text-to-image":
            score += 3
        if has_image and bot.get("type") in {"image-to-image", "image-to-video"}:
            score += 3
        for keyword in bot.get("keywords", []):
            if str(keyword).lower() in normalized:
                score += 2
        if score > best_score:
            best = bot
            best_score = score

    best = best or default_bot
    return {
        "intent": "image-to-video" if best.get("type") == "image-to-video" else best.get("type", "image-to-image"),
        "analysis": "Matched locally from prompt, source media, and action.",
        "optimizedPrompt": message or "Create a polished Dreamy media segment.",
        "reason": "Best local catalog match for the requested next step.",
        "bot": {
            "slug": best["slug"],
            "name": best["name"],
            "type": best["type"],
            "rating": best.get("rating", 4.5),
            "description": best.get("desc", ""),
            "pageUrl": f"https://art.myshell.ai/creative/{best['slug']}",
        },
        "executor": "client",
    }


def llm_route_from_intent(intent: dict[str, Any], message: str, bot: dict[str, Any]) -> dict[str, Any]:
    return {
        "intent": intent.get("intent", bot.get("type", "image-to-image")),
        "analysis": intent.get("analysis", "Intent understood."),
        "optimizedPrompt": intent.get("optimized_prompt") or message,
        "reason": intent.get("reason", "Selected by Studio router."),
        "bot": {
            "slug": bot["slug"],
            "name": bot["name"],
            "type": bot["type"],
            "rating": bot.get("rating", 4.5),
            "description": bot.get("desc", ""),
            "pageUrl": f"https://art.myshell.ai/creative/{bot['slug']}",
        },
        "executor": "client",
    }
