from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from studio_app.application.policies import routing as routing_policy


@dataclass(frozen=True)
class RouteSelectionDeps:
    env_get: Callable[[str], str | None]
    understand_intent: Callable[..., Awaitable[dict[str, Any]]] | None
    get_bot_by_slug: Callable[[str], dict[str, Any] | None]
    bots: Callable[[], list[dict[str, Any]]]
    default_bot_slug: str = "seedream-multi-chart"


def _default_bot(deps: RouteSelectionDeps) -> dict[str, Any]:
    bots = deps.bots()
    return deps.get_bot_by_slug(deps.default_bot_slug) or bots[0]


def keyword_route(
    message: str,
    has_image: bool,
    action: str,
    *,
    deps: RouteSelectionDeps,
) -> dict[str, Any]:
    return routing_policy.keyword_route(
        message,
        has_image,
        action,
        bots=deps.bots(),
        default_bot=_default_bot(deps),
    )


async def choose_route(
    message: str,
    has_image: bool,
    action: str,
    source_segment: dict[str, Any] | None,
    *,
    deps: RouteSelectionDeps,
) -> dict[str, Any]:
    has_source = has_image or bool(source_segment)
    use_llm = deps.env_get("STUDIO_ROUTER_MODE") == "gemini" and bool(deps.env_get("GEMINI_API_KEY"))
    if use_llm and deps.understand_intent:
        try:
            intent = await deps.understand_intent(message, has_source)
            bot_slug = intent.get("selected_bot_slug") or deps.default_bot_slug
            bot = deps.get_bot_by_slug(bot_slug) or _default_bot(deps)
            return routing_policy.llm_route_from_intent(intent, message, bot)
        except Exception:
            pass
    return keyword_route(message, has_source, action, deps=deps)
