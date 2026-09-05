from __future__ import annotations

from fastapi import APIRouter, Request

from studio_app.infrastructure.adapters.canvaspro.proxy import proxy_ai_canvaspro_api


router = APIRouter()


@router.api_route("/ai-canvaspro-api/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
async def proxy_canvaspro_api(path: str, request: Request):
    return await proxy_ai_canvaspro_api(path, request)


@router.api_route("/api/v2/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
async def proxy_canvaspro_v2_api(path: str, request: Request):
    return await proxy_ai_canvaspro_api(f"api/v2/{path}", request)


@router.api_route("/api/config", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
async def proxy_canvaspro_config_api(request: Request):
    return await proxy_ai_canvaspro_api("api/config", request)
