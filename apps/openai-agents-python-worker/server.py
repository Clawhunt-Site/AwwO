"""AwwO agent execution worker — openai-agents Python SDK.

Implements the same private protocol as the Node openai-agents worker:
  GET    /health              -> worker health + model catalogue
  POST   /internal/runs       -> SSE stream of run events (Go API contract)
  POST   /v1/runs             -> same handler, retained for existing clients
  DELETE /internal/runs/{id}  -> cancel an active run
"""

import asyncio
import json
import re
import secrets

from aiohttp import web

from config import bind_user_model, load_config, public_health
from runner import RunRequest, stream_run, validate_request

RUN_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")


def create_app() -> web.Application:
    config = load_config()
    state = {"active": 0, "runs": {}}
    app = web.Application()
    app["config"] = config
    app["state"] = state
    app.router.add_get("/health", handle_health)
    app.router.add_post("/internal/runs", handle_run)
    app.router.add_post("/v1/runs", handle_run)
    app.router.add_delete(r"/internal/runs/{runId}", handle_cancel)
    return app


async def handle_health(request: web.Request) -> web.Response:
    config: "object" = request.app["config"]
    return web.json_response(public_health(config, request.app["state"]["active"]))


def _authorized(request: web.Request) -> bool:
    token = request.app["config"].token
    header = request.headers.get("Authorization", "")
    if not header.startswith("Bearer ") or not token:
        return False
    return secrets.compare_digest(header[7:], token)


async def handle_run(request: web.Request) -> web.StreamResponse:
    config = request.app["config"]
    state = request.app["state"]
    if not _authorized(request):
        return web.json_response({"error": "unauthorized"}, status=401)
    if not config.ready:
        return web.json_response({"error": "unconfigured"}, status=503)
    if state["active"] >= config.max_concurrency:
        return web.json_response({"error": "busy"}, status=503)
    try:
        body = await request.json()
    except (json.JSONDecodeError, UnicodeDecodeError):
        return web.json_response({"error": "invalid_json"}, status=400)
    try:
        run_config, body = bind_user_model(config, body)
        run_request: RunRequest = validate_request(body, config)
    except ValueError as e:
        return web.json_response({"error": "invalid_request", "message": str(e)}, status=400)
    if not RUN_ID.fullmatch(run_request.run_id):
        return web.json_response({"error": "invalid_request"}, status=400)

    cancel_event = asyncio.Event()
    state["runs"][run_request.run_id] = cancel_event
    state["active"] += 1

    response = web.StreamResponse(status=200, headers={
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
    })
    await response.prepare(request)

    async def _stream():
        try:
            async for event in stream_run(run_request, run_config, cancel_event):
                await response.write(f"data: {json.dumps(event)}\n\n".encode("utf-8"))
                if event.get("type") in ("completed", "failed", "cancelled"):
                    break
        finally:
            state["runs"].pop(run_request.run_id, None)
            state["active"] = max(0, state["active"] - 1)

    try:
        await _stream()
        await response.write_eof()
    except (ConnectionResetError, asyncio.CancelledError):
        cancel_event.set()
    return response


async def handle_cancel(request: web.Request) -> web.Response:
    run_id = request.match_info.get("runId", "")
    if not _authorized(request):
        return web.json_response({"error": "unauthorized"}, status=401)
    if not RUN_ID.fullmatch(run_id):
        return web.json_response({"error": "invalid_request"}, status=404)
    cancel_event = request.app["state"]["runs"].get(run_id)
    if cancel_event is None:
        return web.json_response({"error": "not_found"}, status=404)
    cancel_event.set()
    return web.json_response({"ok": True})


def main() -> None:
    app = create_app()
    config = app["config"]
    web.run_app(app, host=config.host, port=config.port, print=None)


if __name__ == "__main__":
    main()
