from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from fastapi import APIRouter, Body, File, Form, HTTPException, UploadFile

from studio_app.application.policies import dispatch as dispatch_rules


@dataclass(frozen=True)
class StudioGenerationRouterDeps:
    store_path: Callable[[], str]
    runtime_health: Callable[[str], Awaitable[dict[str, Any]]]
    latest_generation_smoke_job: Callable[[], dict[str, Any] | None]
    generation_smoke_summary: Callable[..., dict[str, Any]]
    execute_generation_smoke: Callable[[str], Awaitable[dict[str, Any]]]
    cookie_source_status: Callable[[], dict[str, Any]]
    probe_art_api_auth: Callable[[], Awaitable[dict[str, Any]]]
    canvaspro_node_capabilities: Callable[[], dict[str, Any]]
    canvaspro_cli_auth: Callable[[], Awaitable[dict[str, Any]]]
    canvaspro_cli_auth_doctor: Callable[[], Awaitable[dict[str, Any]]]
    canvaspro_login_with_token: Callable[[str], Awaitable[dict[str, Any]]]
    canvaspro_login_with_cookie: Callable[[str], Awaitable[dict[str, Any]]]
    canvaspro_stage_source_asset: Callable[..., Awaitable[dict[str, Any]]]
    canvaspro_generation_task: Callable[[dict[str, Any]], Awaitable[dict[str, Any]]]
    canvaspro_generation_task_sync: Callable[[dict[str, Any]], Awaitable[dict[str, Any]]]
    dreamy_bots: Callable[[], list[dict[str, Any]]]
    execute_dreamy_workshop_smoke: Callable[..., Awaitable[dict[str, Any]]]


async def _live_generation_prerequisites(deps: StudioGenerationRouterDeps) -> dict[str, Any]:
    health = await deps.runtime_health(deps.store_path())
    return (health.get("components") or {}).get("liveGeneration") or {}


def _dreamy_check_status(prerequisites: dict[str, Any]) -> str | None:
    return ((prerequisites.get("checks") or {}).get("dreamyServer") or {}).get("status")


def build_studio_generation_router(deps: StudioGenerationRouterDeps) -> APIRouter:
    router = APIRouter()

    @router.get("/api/studio/generation-smoke")
    async def get_studio_generation_smoke():
        prerequisites = await _live_generation_prerequisites(deps)
        latest_job = deps.latest_generation_smoke_job()
        return deps.generation_smoke_summary(prerequisites=prerequisites, latest_job=latest_job)

    @router.post("/api/studio/generation-smoke")
    async def post_studio_generation_smoke(payload: dict[str, Any] | None = Body(None)):
        body = payload or {}
        execute = dispatch_rules.payload_bool(body.get("execute", False))
        prompt = str(body.get("prompt") or "").strip()
        prerequisites = await _live_generation_prerequisites(deps)
        latest_job = deps.latest_generation_smoke_job()
        if not execute:
            return deps.generation_smoke_summary(
                prerequisites=prerequisites,
                latest_job=latest_job,
                message="Pass execute=true to run a live Dreamy generation smoke.",
            )
        if _dreamy_check_status(prerequisites) != "ready":
            return deps.generation_smoke_summary(
                prerequisites=prerequisites,
                latest_job=latest_job,
                message="Dreamy server credentials are missing; no live generation request was sent.",
            )
        executed = await deps.execute_generation_smoke(prompt)
        return deps.generation_smoke_summary(
            prerequisites=prerequisites,
            latest_job=latest_job,
            executed_job=executed["job"],
            project=executed["project"],
        )

    @router.get("/api/studio/art-api-auth-smoke")
    async def get_studio_art_api_auth_smoke():
        cookie_source = deps.cookie_source_status()
        if cookie_source.get("status") != "ready":
            return {
                "status": "auth_missing",
                "ready": False,
                "message": str(cookie_source.get("message") or "MyShell cookies are not configured."),
                "cookieSource": {
                    "status": cookie_source.get("status"),
                    "mode": cookie_source.get("mode"),
                    "cookieCount": cookie_source.get("cookieCount", 0),
                    "missingCookieNames": cookie_source.get("missingCookieNames", []),
                    "artApiAuthCookieStatus": cookie_source.get("artApiAuthCookieStatus", ""),
                },
            }
        probe = await deps.probe_art_api_auth()
        return {
            **probe,
            "cookieSource": {
                "status": cookie_source.get("status"),
                "mode": cookie_source.get("mode"),
                "cookieCount": cookie_source.get("cookieCount", 0),
                "missingCookieNames": cookie_source.get("missingCookieNames", []),
                "artApiAuthCookieStatus": cookie_source.get("artApiAuthCookieStatus", ""),
            },
        }

    @router.get("/api/studio/canvaspro/node-capabilities")
    async def get_studio_canvaspro_node_capabilities():
        return deps.canvaspro_node_capabilities()

    @router.get("/api/studio/canvaspro/cli-auth")
    async def get_studio_canvaspro_cli_auth():
        return await deps.canvaspro_cli_auth()

    @router.get("/api/studio/canvaspro/cli-auth/doctor")
    async def get_studio_canvaspro_cli_auth_doctor():
        return await deps.canvaspro_cli_auth_doctor()

    @router.post("/api/studio/canvaspro/cli-auth/login")
    async def post_studio_canvaspro_cli_auth_login(payload: dict[str, Any] | None = Body(None)):
        body = payload or {}
        method = str(body.get("method") or "").strip().lower()
        if method == "token":
            token = str(body.get("token") or "").strip()
            if not token:
                raise HTTPException(status_code=400, detail="token is required")
            return await deps.canvaspro_login_with_token(token)
        if method == "cookie":
            cookie = str(body.get("cookie") or "").strip()
            if not cookie:
                raise HTTPException(status_code=400, detail="cookie is required")
            return await deps.canvaspro_login_with_cookie(cookie)
        raise HTTPException(status_code=400, detail="method must be token or cookie")

    @router.post("/api/studio/canvaspro/source-assets")
    async def post_studio_canvaspro_source_asset(
        file: UploadFile = File(...),
        upload_remote: bool = Form(False),
    ):
        return await deps.canvaspro_stage_source_asset(file, upload_remote=upload_remote)

    @router.post("/api/studio/canvaspro/generation-tasks")
    async def post_studio_canvaspro_generation_task(payload: dict[str, Any] | None = Body(None)):
        return await deps.canvaspro_generation_task(payload or {})

    @router.post("/api/studio/canvaspro/generation-tasks/sync")
    async def post_studio_canvaspro_generation_task_sync(payload: dict[str, Any] | None = Body(None)):
        return await deps.canvaspro_generation_task_sync(payload or {})

    @router.get("/api/studio/dreamy-workshop-smoke")
    async def get_studio_dreamy_workshop_smoke():
        prerequisites = await _live_generation_prerequisites(deps)
        dreamy_check = _dreamy_check_status(prerequisites)
        bots = deps.dreamy_bots()
        return {
            "status": "ready" if dreamy_check == "ready" else "needs_configuration",
            "ready": dreamy_check == "ready",
            "endpoint": "/api/studio/dreamy-workshop-smoke",
            "message": (
                "Pass execute=true to run every Dreamy workshop bot from backend credentials."
                if dreamy_check == "ready"
                else "Dreamy server credentials are missing; no live generation request will be sent."
            ),
            "bots": [
                {
                    "slug": bot.get("slug"),
                    "name": bot.get("name"),
                    "type": bot.get("type"),
                    "pageId": bot.get("pageId"),
                }
                for bot in bots
            ],
            "count": len(bots),
            "prerequisites": prerequisites,
        }

    @router.post("/api/studio/dreamy-workshop-smoke")
    async def post_studio_dreamy_workshop_smoke(payload: dict[str, Any] | None = Body(None)):
        body = payload or {}
        execute = dispatch_rules.payload_bool(body.get("execute", False))
        prompt = str(body.get("prompt") or "").strip()
        bots = deps.dreamy_bots()
        limit_value = body.get("limit")
        try:
            limit = int(limit_value) if limit_value is not None else len(bots)
        except (TypeError, ValueError):
            limit = len(bots)
        limit = max(1, min(limit, len(bots)))
        prerequisites = await _live_generation_prerequisites(deps)
        dreamy_check = _dreamy_check_status(prerequisites)
        if not execute:
            return {
                "status": "ready" if dreamy_check == "ready" else "needs_configuration",
                "ready": dreamy_check == "ready",
                "message": "Pass execute=true to run every Dreamy workshop bot.",
                "count": limit,
                "prerequisites": prerequisites,
            }
        if dreamy_check != "ready":
            return {
                "status": "needs_configuration",
                "ready": False,
                "message": "Dreamy server credentials are missing; no live generation request was sent.",
                "count": 0,
                "acceptedCount": 0,
                "bots": [],
                "prerequisites": prerequisites,
            }
        executed = await deps.execute_dreamy_workshop_smoke(prompt, limit=limit)
        return {
            **executed,
            "ready": executed["status"] == "done",
            "prerequisites": prerequisites,
        }

    return router
