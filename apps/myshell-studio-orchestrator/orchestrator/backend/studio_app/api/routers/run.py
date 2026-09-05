from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from fastapi import APIRouter, File, Form, UploadFile


@dataclass(frozen=True)
class StudioRunRouterDeps:
    run_studio_response: Callable[..., Awaitable[Any]]


def build_studio_run_router(deps: StudioRunRouterDeps) -> APIRouter:
    router = APIRouter()

    @router.post("/api/studio/run")
    async def run_studio(
        message: str = Form(""),
        project_id: str | None = Form(None),
        mode: str = Form("player"),
        action: str = Form("generate"),
        source_segment_id: str | None = Form(None),
        page_id: str = Form("dreamy-miniapp"),
        agent_id: str | None = Form(None),
        bot_id: str | None = Form(None),
        bot_slug: str | None = Form(None),
        bot_name: str | None = Form(None),
        bot_type: str | None = Form(None),
        article_id: str | None = Form(None),
        bot_sequence: str | None = Form(None),
        agent_graph: str | None = Form(None),
        image: UploadFile | None = File(None),
    ):
        return await deps.run_studio_response(
            message=message,
            project_id=project_id,
            mode=mode,
            action=action,
            source_segment_id=source_segment_id,
            page_id=page_id,
            agent_id=agent_id,
            bot_id=bot_id,
            bot_slug=bot_slug,
            bot_name=bot_name,
            bot_type=bot_type,
            article_id=article_id,
            bot_sequence=bot_sequence,
            agent_graph=agent_graph,
            image=image,
        )

    return router
