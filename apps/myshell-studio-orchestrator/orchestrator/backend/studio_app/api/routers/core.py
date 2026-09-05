from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from fastapi import APIRouter, Query


@dataclass(frozen=True)
class StudioCoreRouterDeps:
    list_pages: Callable[[], list[dict[str, Any]]]
    page_with_runtime_status: Callable[[dict[str, Any]], dict[str, Any]]
    list_agents: Callable[[], list[dict[str, Any]]]
    dreamy_catalog_bots: Callable[[], Awaitable[tuple[list[dict[str, Any]], str]]]
    list_bot_previews: Callable[..., dict[str, Any]]
    verified_dreamy_workshop_project: Callable[[], dict[str, Any]]
    sync_project_jobs: Callable[[dict[str, Any]], None]
    studio_overview: Callable[..., dict[str, Any]]


def build_studio_core_router(deps: StudioCoreRouterDeps) -> APIRouter:
    router = APIRouter()

    @router.get("/api/pages")
    async def get_studio_pages():
        return {"pages": [deps.page_with_runtime_status(page) for page in deps.list_pages()]}

    @router.get("/api/agents")
    async def get_studio_agents():
        return {"agents": deps.list_agents()}

    @router.get("/api/studio/bot-previews")
    async def get_studio_bot_previews():
        dreamy_bots, catalog_source = await deps.dreamy_catalog_bots()
        response = deps.list_bot_previews(dreamy_bots=dreamy_bots)
        response["dreamyCatalogSource"] = catalog_source
        response["dreamyCatalogReady"] = catalog_source in {"live-dreamy-explore", "live-dreamyporn-web-explore"}
        return response

    @router.post("/api/studio/dreamy-workshop-project")
    async def post_studio_dreamy_workshop_project():
        project = deps.verified_dreamy_workshop_project()
        deps.sync_project_jobs(project)
        return project

    @router.get("/api/studio/overview")
    async def get_studio_overview(limit: int = Query(50, ge=1, le=100)):
        return deps.studio_overview(limit=limit)

    return router
