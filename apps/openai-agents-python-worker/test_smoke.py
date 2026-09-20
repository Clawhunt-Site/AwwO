"""End-to-end smoke test: mock OpenAI-compatible endpoint + worker + SSE assertion.

Run: .venv/Scripts/python test_smoke.py
"""

import asyncio
import json
import os
import sys

import aiohttp
from aiohttp import web


async def mock_openai_handler(request: web.Request) -> web.StreamResponse:
    body = await request.json()
    if body.get("stream"):
        resp = web.StreamResponse(status=200, headers={"Content-Type": "text/event-stream"})
        await resp.prepare(request)
        for token in ["Hello", " ", "world"]:
            chunk = {
                "id": "chatcmpl-1",
                "object": "chat.completion.chunk",
                "choices": [{"index": 0, "delta": {"content": token}, "finish_reason": None}],
            }
            await resp.write(f"data: {json.dumps(chunk)}\n\n".encode())
        final = {"id": "chatcmpl-1", "object": "chat.completion.chunk",
                 "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}
        await resp.write(f"data: {json.dumps(final)}\n\n".encode())
        await resp.write(b"data: [DONE]\n\n")
        await resp.write_eof()
        return resp
    return web.json_response({
        "id": "chatcmpl-1",
        "object": "chat.completion",
        "choices": [{"index": 0, "message": {"role": "assistant", "content": "Hello world"}, "finish_reason": "stop"}],
    })


async def main() -> None:
    # 1. mock OpenAI on 18080
    mock_app = web.Application()
    mock_app.router.add_post("/v1/chat/completions", mock_openai_handler)
    mock_runner = web.AppRunner(mock_app)
    await mock_runner.setup()
    mock_site = web.TCPSite(mock_runner, "127.0.0.1", 18080)
    await mock_site.start()

    # 2. worker on 18099
    os.environ.update({
        "APP_ENV": "staging",
        "AWWO_OPENAI_AGENTS_HOST": "127.0.0.1",
        "AWWO_OPENAI_AGENTS_PORT": "18099",
        "AWWO_OPENAI_AGENTS_TOKEN": "smoketest-token-0123456789abcdef0123",
        "AWWO_OPENAI_AGENTS_PROVIDER": "openai",
        "AWWO_OPENAI_AGENTS_MODEL": "mock-model",
        "AWWO_OPENAI_AGENTS_API_KEY": "sk-mock",
        "AWWO_OPENAI_AGENTS_BASE_URL": "http://127.0.0.1:18080/v1",
    })
    from server import create_app
    app = create_app()
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 18099)
    await site.start()

    failures = []

    async with aiohttp.ClientSession() as session:
        # health
        async with session.get("http://127.0.0.1:18099/health") as resp:
            health = await resp.json()
            if resp.status != 200 or not health["ready"] or health["runtime"] != "openai-agents":
                failures.append(f"health: {resp.status} {health}")

        # unauthorized
        async with session.post("http://127.0.0.1:18099/v1/runs", json={}) as resp:
            if resp.status != 401:
                failures.append(f"auth: expected 401 got {resp.status}")

        # invalid request
        async with session.post("http://127.0.0.1:18099/v1/runs",
                                headers={"Authorization": "Bearer smoketest-token-0123456789abcdef0123"},
                                json={"runId": "r1"}) as resp:
            if resp.status != 400:
                failures.append(f"validation: expected 400 got {resp.status}")

        # real run
        async with session.post("http://127.0.0.1:18099/v1/runs",
                                headers={"Authorization": "Bearer smoketest-token-0123456789abcdef0123"},
                                json={"runId": "r1", "tenantId": "t1", "sessionId": "s1",
                                      "prompt": "say hello", "messages": []}) as resp:
            if resp.status != 200:
                failures.append(f"run: expected 200 got {resp.status}")
            deltas = []
            terminal = None
            async for line in resp.content:
                text = line.decode().strip()
                if not text.startswith("data: "):
                    continue
                event = json.loads(text[6:])
                if event["type"] == "text_delta":
                    deltas.append(event["delta"])
                elif event["type"] in ("completed", "failed", "cancelled"):
                    terminal = event
                    break
            if "".join(deltas) != "Hello world":
                failures.append(f"deltas: {deltas!r}")
            if terminal is None or terminal["type"] != "completed" or terminal.get("text") != "Hello world":
                failures.append(f"terminal: {terminal!r}")

        # cancel endpoint for unknown run
        async with session.delete("http://127.0.0.1:18099/internal/runs/nope",
                                  headers={"Authorization": "Bearer smoketest-token-0123456789abcdef0123"}) as resp:
            if resp.status != 404:
                failures.append(f"cancel: expected 404 got {resp.status}")

    await runner.cleanup()
    await mock_runner.cleanup()

    if failures:
        print("FAILURES:")
        for f in failures:
            print(" -", f)
        sys.exit(1)
    print("SMOKE OK: health, auth, validation, SSE stream, cancel all passed")


if __name__ == "__main__":
    asyncio.run(main())
