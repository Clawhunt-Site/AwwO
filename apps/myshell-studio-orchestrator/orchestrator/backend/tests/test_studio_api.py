import asyncio
import concurrent.futures
import json
import os
import shutil
import sys
import tempfile
import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient

BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))

from main import app  # noqa: E402
from studio_app.application.state.project_cache import PROJECTS  # noqa: E402
from studio_app.infrastructure.adapters.canvaspro.proxy import (  # noqa: E402
    _canvaspro_compat_response,
    _read_canvaspro_json,
    _write_canvaspro_json,
)
from studio_app.infrastructure.adapters.myshell_art import api as myshell_art_api  # noqa: E402
from studio_app.infrastructure.adapters.myshell_art import cli as myshell_art_cli  # noqa: E402
from studio_app.registry import page_for_dispatch  # noqa: E402
from studio_app.infrastructure.db.sqlite_store import STUDIO_STORE  # noqa: E402


def _sse_events(text: str) -> list[tuple[str, dict]]:
    events: list[tuple[str, dict]] = []
    event_name = "message"
    data_lines: list[str] = []
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            if data_lines:
                events.append((event_name, json.loads("\n".join(data_lines))))
                event_name = "message"
                data_lines = []
            continue
        if line.startswith("event:"):
            event_name = line.split(":", 1)[1].strip()
        elif line.startswith("data:"):
            data_lines.append(line.split(":", 1)[1].strip())
    if data_lines:
        events.append((event_name, json.loads("\n".join(data_lines))))
    return events


class StudioApiTest(unittest.TestCase):
    def setUp(self) -> None:
        PROJECTS.clear()
        STUDIO_STORE.reset_all()
        self.client = TestClient(app)

    def test_ai_canvaspro_proxy_forwards_local_api_requests(self) -> None:
        captured: dict[str, object] = {}

        class FakeResponse:
            status_code = 202
            content = b'{"ok": true}'
            headers = {"content-type": "application/json", "content-length": "999", "x-proxy-test": "ok"}

        class FakeAsyncClient:
            def __init__(self, *args, **kwargs) -> None:
                captured["client_kwargs"] = kwargs

            async def __aenter__(self) -> "FakeAsyncClient":
                return self

            async def __aexit__(self, *args) -> None:
                return None

            async def request(self, method: str, url: str, headers: dict[str, str], content: bytes) -> FakeResponse:
                captured["method"] = method
                captured["url"] = url
                captured["headers"] = headers
                captured["content"] = content
                return FakeResponse()

        with (
            patch.dict(os.environ, {"AI_CANVASPRO_API_BASE": "http://127.0.0.1:18877"}),
            patch("studio_app.infrastructure.adapters.canvaspro.proxy.httpx.AsyncClient", FakeAsyncClient),
        ):
            response = self.client.post(
                "/ai-canvaspro-api/api/v2/projects?active=1",
                json={"name": "demo"},
                headers={"X-Canvas-Test": "yes"},
            )

        self.assertEqual(response.status_code, 202)
        self.assertEqual(response.json(), {"ok": True})
        self.assertEqual(response.headers["x-proxy-test"], "ok")
        self.assertEqual(captured["method"], "POST")
        self.assertEqual(captured["url"], "http://127.0.0.1:18877/api/v2/projects?active=1")
        self.assertEqual(json.loads(captured["content"].decode()), {"name": "demo"})
        self.assertEqual(captured["headers"]["x-canvas-test"], "yes")

    def test_ai_canvaspro_compat_config_redacts_secret_keys(self) -> None:
        class FakeAsyncClient:
            def __init__(self, *args, **kwargs) -> None:
                pass

            async def __aenter__(self) -> "FakeAsyncClient":
                return self

            async def __aexit__(self, *args) -> None:
                return None

            async def request(self, *args, **kwargs):
                raise httpx.ConnectError("native canvaspro unavailable")

        payload = {
            "providers": {
                "openai": {
                    "apiKey": "sk-should-not-persist",
                    "modelApiKey": "mk-should-not-persist",
                    "apiUrl": "https://api.example.test",
                },
            },
            "safe": True,
        }
        with tempfile.TemporaryDirectory() as temp_dir:
            with (
                patch.dict(
                    os.environ,
                    {
                        "AI_CANVASPRO_API_BASE": "http://127.0.0.1:18877",
                        "AI_CANVASPRO_COMPAT_DIR": temp_dir,
                    },
                ),
                patch("studio_app.infrastructure.adapters.canvaspro.proxy.httpx.AsyncClient", FakeAsyncClient),
            ):
                response = self.client.post("/ai-canvaspro-api/api/config", json=payload)

            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.headers["x-ai-canvaspro-compat"], "1")
            body = response.json()
            self.assertEqual(body["secretPersistence"], "disabled")
            self.assertEqual(body["data"]["providers"]["openai"], {"apiUrl": "https://api.example.test"})

            stored = json.loads(Path(temp_dir, "config.json").read_text(encoding="utf-8"))
            stored_text = json.dumps(stored)
            self.assertNotIn("sk-should-not-persist", stored_text)
            self.assertNotIn("mk-should-not-persist", stored_text)
            self.assertEqual(stored["providers"]["openai"], {"apiUrl": "https://api.example.test"})

    def test_ai_canvaspro_v2_alias_uses_compat_settings_store(self) -> None:
        class FakeAsyncClient:
            def __init__(self, *args, **kwargs) -> None:
                pass

            async def __aenter__(self) -> "FakeAsyncClient":
                return self

            async def __aexit__(self, *args) -> None:
                return None

            async def request(self, *args, **kwargs):
                raise httpx.ConnectError("native canvaspro unavailable")

        with tempfile.TemporaryDirectory() as temp_dir:
            with (
                patch.dict(
                    os.environ,
                    {
                        "AI_CANVASPRO_API_BASE": "http://127.0.0.1:18877",
                        "AI_CANVASPRO_COMPAT_DIR": temp_dir,
                    },
                ),
                patch("studio_app.infrastructure.adapters.canvaspro.proxy.httpx.AsyncClient", FakeAsyncClient),
            ):
                save_response = self.client.post("/api/v2/user/settings.json", json={"snap": True})
                read_response = self.client.get("/api/v2/user/settings.json")

        self.assertEqual(save_response.status_code, 200)
        self.assertEqual(save_response.headers["x-ai-canvaspro-compat"], "1")
        self.assertEqual(read_response.status_code, 200)
        self.assertEqual(read_response.headers["x-ai-canvaspro-compat"], "1")
        self.assertEqual(read_response.json(), {"snap": True})

    def test_ai_canvaspro_v2_alias_heartbeat_is_sse(self) -> None:
        response = _canvaspro_compat_response("api/v2/heartbeat_stream", "GET", b"")
        self.assertIsNotNone(response)
        self.assertEqual(response.headers["x-ai-canvaspro-compat"], "1")
        self.assertEqual(response.media_type, "text/event-stream")

    def test_ai_canvaspro_upstream_5xx_is_not_hidden_by_default(self) -> None:
        class FakeResponse:
            status_code = 503
            content = b"upstream down"
            headers = {"content-type": "text/plain"}

        class FakeAsyncClient:
            def __init__(self, *args, **kwargs) -> None:
                pass

            async def __aenter__(self) -> "FakeAsyncClient":
                return self

            async def __aexit__(self, *args) -> None:
                return None

            async def request(self, *args, **kwargs) -> FakeResponse:
                return FakeResponse()

        with (
            patch.dict(
                os.environ,
                {
                    "AI_CANVASPRO_API_BASE": "http://127.0.0.1:18877",
                    "AI_CANVASPRO_COMPAT_ON_UPSTREAM_STATUS": "",
                },
            ),
            patch("studio_app.infrastructure.adapters.canvaspro.proxy.httpx.AsyncClient", FakeAsyncClient),
        ):
            response = self.client.get("/ai-canvaspro-api/api/v2/runtime/info")

        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.text, "upstream down")
        self.assertNotIn("x-ai-canvaspro-compat", response.headers)

    def test_ai_canvaspro_loopback_proxy_refused_503_uses_compat_fallback(self) -> None:
        class FakeResponse:
            status_code = 503
            content = b"<html><h1>Unable to connect</h1><li>Connection refused</li></html>"
            headers = {"content-type": "text/html"}

        class FakeAsyncClient:
            def __init__(self, *args, **kwargs) -> None:
                pass

            async def __aenter__(self) -> "FakeAsyncClient":
                return self

            async def __aexit__(self, *args) -> None:
                return None

            async def request(self, *args, **kwargs) -> FakeResponse:
                return FakeResponse()

        with (
            patch.dict(
                os.environ,
                {
                    "AI_CANVASPRO_API_BASE": "http://127.0.0.1:18877",
                    "AI_CANVASPRO_COMPAT_ON_UPSTREAM_STATUS": "",
                },
            ),
            patch("studio_app.infrastructure.adapters.canvaspro.proxy.httpx.AsyncClient", FakeAsyncClient),
        ):
            response = self.client.get("/ai-canvaspro-api/api/v2/runtime/info")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["x-ai-canvaspro-compat"], "1")
        self.assertEqual(response.json()["mode"], "studio-compat")

    def test_ai_canvaspro_known_404_endpoint_uses_compat_fallback(self) -> None:
        class FakeResponse:
            status_code = 404
            content = b"not found"
            headers = {"content-type": "text/plain"}

        class FakeAsyncClient:
            def __init__(self, *args, **kwargs) -> None:
                pass

            async def __aenter__(self) -> "FakeAsyncClient":
                return self

            async def __aexit__(self, *args) -> None:
                return None

            async def request(self, *args, **kwargs) -> FakeResponse:
                return FakeResponse()

        with (
            patch.dict(os.environ, {"AI_CANVASPRO_API_BASE": "http://127.0.0.1:18877"}),
            patch("studio_app.infrastructure.adapters.canvaspro.proxy.httpx.AsyncClient", FakeAsyncClient),
        ):
            response = self.client.get("/ai-canvaspro-api/api/v2/runtime/info")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["x-ai-canvaspro-compat"], "1")
        self.assertEqual(response.json()["mode"], "studio-compat")

    def test_ai_canvaspro_compat_project_save_and_list(self) -> None:
        class FakeAsyncClient:
            def __init__(self, *args, **kwargs) -> None:
                pass

            async def __aenter__(self) -> "FakeAsyncClient":
                return self

            async def __aexit__(self, *args) -> None:
                return None

            async def request(self, *args, **kwargs):
                raise httpx.ConnectError("native canvaspro unavailable")

        with tempfile.TemporaryDirectory() as temp_dir:
            with (
                patch.dict(
                    os.environ,
                    {
                        "AI_CANVASPRO_API_BASE": "http://127.0.0.1:18877",
                        "AI_CANVASPRO_COMPAT_DIR": temp_dir,
                    },
                ),
                patch("studio_app.infrastructure.adapters.canvaspro.proxy.httpx.AsyncClient", FakeAsyncClient),
            ):
                save_response = self.client.post(
                    "/ai-canvaspro-api/api/v2/projects/save",
                    json={"projectName": "Demo/Key", "canvases": []},
                )
                list_response = self.client.get("/ai-canvaspro-api/api/v2/projects")

            self.assertEqual(save_response.status_code, 200)
            self.assertEqual(save_response.headers["x-ai-canvaspro-compat"], "1")
            self.assertEqual(save_response.json()["filename"], "Demo_Key.json")
            self.assertTrue(Path(temp_dir, "project_Demo_Key.json").exists())

            projects = list_response.json()
            self.assertEqual(len(projects), 1)
            self.assertEqual(projects[0]["filename"], "Demo_Key.json")
            self.assertEqual(projects[0]["projectName"], "Demo/Key")

    def test_ai_canvaspro_default_project_missing_returns_empty_project(self) -> None:
        class FakeAsyncClient:
            def __init__(self, *args, **kwargs) -> None:
                pass

            async def __aenter__(self) -> "FakeAsyncClient":
                return self

            async def __aexit__(self, *args) -> None:
                return None

            async def request(self, *args, **kwargs):
                raise httpx.ConnectError("native canvaspro unavailable")

        with tempfile.TemporaryDirectory() as temp_dir:
            with (
                patch.dict(
                    os.environ,
                    {
                        "AI_CANVASPRO_API_BASE": "http://127.0.0.1:18877",
                        "AI_CANVASPRO_COMPAT_DIR": temp_dir,
                    },
                ),
                patch("studio_app.infrastructure.adapters.canvaspro.proxy.httpx.AsyncClient", FakeAsyncClient),
            ):
                response = self.client.get("/ai-canvaspro-api/api/v2/projects/default_v2_project.json")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["x-ai-canvaspro-compat"], "1")
        body = response.json()
        self.assertEqual(body["filename"], "default_v2_project.json")
        self.assertEqual(body["activeCanvasId"], "canvas_1")
        self.assertEqual(body["canvases"][0]["nodes"], [])

    def test_ai_canvaspro_json_store_concurrent_writes_remain_valid(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            with patch.dict(os.environ, {"AI_CANVASPRO_COMPAT_DIR": temp_dir}):
                def write_index(index: int) -> None:
                    _write_canvaspro_json("settings.json", {"index": index, "values": list(range(16))})

                with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
                    list(executor.map(write_index, range(40)))

                stored = _read_canvaspro_json("settings.json", {})

        self.assertIsInstance(stored, dict)
        self.assertIsInstance(stored.get("index"), int)
        self.assertEqual(stored.get("values"), list(range(16)))

    def test_run_stream_creates_project_and_execution_request(self) -> None:
        with self.client.stream(
            "POST",
            "/api/studio/run",
            data={
                "message": "make a cinematic clip from this portrait",
                "mode": "player",
                "action": "generate",
            },
        ) as response:
            self.assertEqual(response.status_code, 200)
            text = "".join(response.iter_text())

        events = _sse_events(text)
        names = [name for name, _payload in events]
        self.assertIn("meta", names)
        self.assertIn("route", names)
        self.assertIn("execution_request", names)
        self.assertIn("project", names)
        self.assertIn("done", names)

        execution = next(payload for name, payload in events if name == "execution_request")
        self.assertEqual(execution["executor"], "client")
        self.assertEqual(execution["api"], "dreamy-miniapp")
        self.assertTrue(execution["segmentId"].startswith("segment_"))
        self.assertTrue(execution["jobId"].startswith("job_"))
        self.assertEqual(execution["evidence"]["accepted"], False)

        project = next(payload["project"] for name, payload in events if name == "project")
        self.assertEqual(len(project["segments"]), 1)
        self.assertEqual(project["segments"][0]["status"], "queued")
        self.assertEqual(project["selectedSegmentId"], execution["segmentId"])
        self.assertEqual(project["jobs"][0]["jobId"], execution["jobId"])

    def test_run_stream_preserves_manual_dreamy_bot_id_for_client_execution(self) -> None:
        with self.client.stream(
            "POST",
            "/api/studio/run",
            data={
                "message": "manual bot id should drive generation",
                "mode": "player",
                "action": "generate",
                "page_id": "dreamy-miniapp",
                "bot_id": "manual_bot_123",
                "bot_slug": "manual-slug",
                "bot_name": "Manual Bot",
                "bot_type": "text-to-image",
            },
        ) as response:
            self.assertEqual(response.status_code, 200)
            events = _sse_events("".join(response.iter_text()))

        execution = next(payload for name, payload in events if name == "execution_request")
        self.assertEqual(execution["executor"], "client")
        self.assertEqual(execution["botId"], "manual_bot_123")
        self.assertEqual(execution["botSlug"], "manual-slug")
        self.assertEqual(execution["botName"], "Manual Bot")
        self.assertEqual(execution["segment"]["botId"], "manual_bot_123")

        project = next(payload["project"] for name, payload in events if name == "project")
        self.assertEqual(project["segments"][0]["botId"], "manual_bot_123")
        self.assertEqual(project["jobs"][0]["botId"], "manual_bot_123")

    def test_run_stream_manual_bot_id_server_adapter_skips_slug_lookup(self) -> None:

        calls: list[tuple[str, dict]] = []

        async def fake_dreamy_request(endpoint: str, body: dict, init_data: str) -> dict:
            calls.append((endpoint, body))
            self.assertEqual(init_data, "query_id=server-auth")
            if endpoint.endswith("/get-by-slug"):
                raise AssertionError("manual bot_id should not require get-by-slug")
            if endpoint.endswith("/generate"):
                return {"outputJobId": "manual_dreamy_job", "queuePosition": 0}
            if endpoint.endswith("/generate/result"):
                return {
                    "tasks": [
                        {
                            "status": "done",
                            "jobId": "manual_dreamy_job",
                            "result": json.dumps(
                                {
                                    "outputImg": "https://cdn.example.test/manual.mp4",
                                    "outputPreview": "https://cdn.example.test/manual-poster.jpg",
                                }
                            ),
                        }
                    ]
                }
            raise AssertionError(endpoint)

        with (
            patch.dict(os.environ, {"DREAMY_TELEGRAM_INIT_DATA": "query_id=server-auth"}, clear=False),
            patch("studio_app.infrastructure.adapters.dreamy.client.dreamy_api_request", side_effect=fake_dreamy_request),
            self.client.stream(
                "POST",
                "/api/studio/run",
                data={
                    "message": "run exact manual bot",
                    "action": "extend",
                    "page_id": "dreamy-miniapp",
                    "bot_id": "manual_bot_server",
                    "bot_slug": "manual-server-slug",
                    "bot_name": "Manual Server Bot",
                    "bot_type": "image-to-video",
                },
            ) as response,
        ):
            self.assertEqual(response.status_code, 200)
            events = _sse_events("".join(response.iter_text()))

        endpoints = [endpoint for endpoint, _body in calls]
        self.assertNotIn("/v1/telegram/miniapp/dreamy/get-by-slug", endpoints)
        generate_call = next(body for endpoint, body in calls if endpoint.endswith("/generate"))
        self.assertEqual(generate_call["bot_id"], "manual_bot_server")
        self.assertEqual(generate_call["article_id"], "manual-server-slug")

        execution = next(payload for name, payload in events if name == "execution_request")
        self.assertEqual(execution["executor"], "server")
        self.assertEqual(execution["botId"], "manual_bot_server")

        final_job = [payload["job"] for name, payload in events if name == "job"][-1]
        self.assertEqual(final_job["status"], "done")
        self.assertEqual(final_job["botId"], "manual_bot_server")
        self.assertEqual(final_job["mediaUrl"], "https://cdn.example.test/manual.mp4")

    def test_dreamyporn_web_cookies_make_dreamy_server_ready(self) -> None:
        from studio_app.infrastructure.runtime import health as studio_runtime

        cookies = [
            {
                "name": "ms_token",
                "value": "web-cookie-token",
                "domain": ".dreamyporn.ai",
                "path": "/",
            }
        ]
        with patch.dict(os.environ, {"MYSHELL_COOKIES": json.dumps(cookies)}, clear=True):
            status = studio_runtime.dreamy_api_auth_status()
            live = studio_runtime.live_generation_status(
                credential_setup={"status": "needs_configuration", "missingEnv": ["DREAMY_TELEGRAM_INIT_DATA"]},
                cookie_source=studio_runtime.cookie_source_status(),
            )

        self.assertEqual(status["status"], "ready")
        self.assertEqual(status["mode"], "dreamyporn-web-cookies")
        self.assertEqual(live["status"], "ready")
        self.assertEqual(live["checks"]["dreamyServer"]["status"], "ready")

    def test_run_stream_manual_bot_id_uses_dreamyporn_web_when_cookie_ready(self) -> None:

        calls: list[tuple[str, dict]] = []

        async def fake_input_images(**_kwargs) -> list[str]:
            return ["https://cdn.example.test/source.png"]

        async def fake_web_request(endpoint: str, body: dict) -> dict:
            calls.append((endpoint, body))
            if endpoint.endswith("/generate"):
                self.assertEqual(body["botId"], "1779936515")
                self.assertEqual(body["articleId"], "ai-oil-massage")
                self.assertEqual(body["inputImg"], ["https://cdn.example.test/source.png"])
                return {"outputJobId": "web_dreamy_job"}
            if endpoint.endswith("/generate_result"):
                return {
                    "tasks": [
                        {
                            "status": "done",
                            "jobId": "web_dreamy_job",
                            "queuePosition": "0",
                            "result": {
                                "outputImg": "https://cdn.example.test/web-dreamy.mp4",
                                "outputPreview": "https://cdn.example.test/web-dreamy-preview.mp4",
                                "outputPoster": "https://cdn.example.test/web-dreamy-poster.jpg",
                            },
                        }
                    ]
                }
            raise AssertionError(endpoint)

        ready_auth = {
            "status": "ready",
            "mode": "dreamyporn-web-cookies",
            "message": "ready",
        }
        with (
            patch("studio_app.infrastructure.runtime.health.dreamy_init_data", return_value=""),
            patch("studio_app.infrastructure.runtime.health.dreamyporn_web_cookie_status", return_value=ready_auth),
            patch("studio_app.infrastructure.runtime.health.adapter_auth_status", return_value=ready_auth),
            patch("studio_app.infrastructure.adapters.dreamy.client.dreamyporn_web_input_images", side_effect=fake_input_images),
            patch("studio_app.infrastructure.adapters.dreamy.client.dreamyporn_web_request", side_effect=fake_web_request),
            self.client.stream(
                "POST",
                "/api/studio/run",
                data={
                    "message": "run DreamyPorn web bot",
                    "action": "generate",
                    "page_id": "dreamy-miniapp",
                    "bot_id": "1779936515",
                    "bot_slug": "ai-oil-massage",
                    "bot_name": "AI Oil Massage",
                    "bot_type": "image-to-video",
                    "article_id": "ai-oil-massage",
                },
            ) as response,
        ):
            self.assertEqual(response.status_code, 200)
            events = _sse_events("".join(response.iter_text()))

        endpoints = [endpoint for endpoint, _body in calls]
        self.assertIn("/v1/homepage/porn/generate", endpoints)
        self.assertIn("/v1/homepage/porn/generate_result", endpoints)
        execution = next(payload for name, payload in events if name == "execution_request")
        self.assertEqual(execution["executor"], "server")
        self.assertEqual(execution["botId"], "1779936515")

        final_job = [payload["job"] for name, payload in events if name == "job"][-1]
        self.assertEqual(final_job["status"], "done")
        self.assertEqual(final_job["taskId"], "web_dreamy_job")
        self.assertEqual(final_job["mediaUrl"], "https://cdn.example.test/web-dreamy.mp4")
        self.assertEqual(final_job["evidence"]["executor"], "dreamyporn-web")

    def test_run_stream_accepts_manual_bot_sequence_as_continuous_segments(self) -> None:
        sequence = [
            {
                "botId": "manual_image_bot",
                "botSlug": "manual-image",
                "botName": "Manual Image Bot",
                "botType": "text-to-image",
                "action": "generate",
            },
            {
                "botId": "manual_video_bot",
                "botSlug": "manual-video",
                "botName": "Manual Video Bot",
                "botType": "image-to-video",
                "action": "extend",
            },
        ]
        with self.client.stream(
            "POST",
            "/api/studio/run",
            data={
                "message": "make a two step manual chain",
                "mode": "player",
                "action": "generate",
                "page_id": "dreamy-miniapp",
                "bot_sequence": json.dumps(sequence),
            },
        ) as response:
            self.assertEqual(response.status_code, 200)
            events = _sse_events("".join(response.iter_text()))

        executions = [payload for name, payload in events if name == "execution_request"]
        self.assertEqual(len(executions), 2)
        self.assertEqual([item["botId"] for item in executions], ["manual_image_bot", "manual_video_bot"])
        self.assertEqual([item["action"] for item in executions], ["generate", "extend"])
        self.assertIsNone(executions[0]["segment"].get("parentSegmentId"))
        self.assertEqual(executions[1]["segment"].get("parentSegmentId"), executions[0]["segmentId"])

        project = next(payload["project"] for name, payload in events if name == "project")
        self.assertEqual(len(project["segments"]), 2)
        self.assertEqual(project["selectedSegmentId"], executions[1]["segmentId"])
        self.assertEqual(project["segments"][1]["parentSegmentId"], executions[0]["segmentId"])
        self.assertEqual([job["botId"] for job in project["jobs"]], ["manual_image_bot", "manual_video_bot"])

    def test_run_stream_executes_manual_bot_sequence_when_dreamy_server_is_ready(self) -> None:

        sequence = [
            {
                "botId": "manual_image_bot",
                "botSlug": "manual-image",
                "botName": "Manual Image Bot",
                "botType": "text-to-image",
                "action": "generate",
            },
            {
                "botId": "manual_video_bot",
                "botSlug": "manual-video",
                "botName": "Manual Video Bot",
                "botType": "image-to-video",
                "action": "extend",
            },
        ]
        generate_calls: list[dict] = []

        async def fake_dreamy_request(endpoint: str, body: dict, init_data: str) -> dict:
            self.assertEqual(init_data, "query_id=server-auth")
            if endpoint.endswith("/get-by-slug"):
                raise AssertionError("manual sequence bot ids should not require slug lookup")
            if endpoint.endswith("/generate"):
                generate_calls.append(body)
                return {"outputJobId": f"{body['bot_id']}_job"}
            if endpoint.endswith("/generate/result"):
                output_job_id = body["output_job_id"]
                return {
                    "tasks": [
                        {
                            "status": "done",
                            "jobId": output_job_id,
                            "result": json.dumps(
                                {
                                    "outputImg": f"https://cdn.example.test/{output_job_id}.mp4",
                                    "outputPreview": f"https://cdn.example.test/{output_job_id}-poster.jpg",
                                }
                            ),
                        }
                    ]
                }
            raise AssertionError(endpoint)

        with (
            patch.dict(os.environ, {"DREAMY_TELEGRAM_INIT_DATA": "query_id=server-auth"}, clear=False),
            patch("studio_app.infrastructure.adapters.dreamy.client.dreamy_api_request", side_effect=fake_dreamy_request),
            self.client.stream(
                "POST",
                "/api/studio/run",
                data={
                    "message": "run two real manual steps",
                    "mode": "player",
                    "action": "generate",
                    "page_id": "dreamy-miniapp",
                    "bot_sequence": json.dumps(sequence),
                },
            ) as response,
        ):
            self.assertEqual(response.status_code, 200)
            events = _sse_events("".join(response.iter_text()))

        final_jobs = [payload["job"] for name, payload in events if name == "job" and payload["job"]["status"] == "done"]
        self.assertEqual(len(final_jobs), 2)
        self.assertEqual([job["botId"] for job in final_jobs], ["manual_image_bot", "manual_video_bot"])
        self.assertEqual(len(generate_calls), 2)
        self.assertEqual(generate_calls[0]["bot_id"], "manual_image_bot")
        self.assertEqual(generate_calls[1]["bot_id"], "manual_video_bot")
        self.assertEqual(generate_calls[1]["input_img"][0], "https://cdn.example.test/manual_image_bot_job.mp4")

    def test_client_result_updates_existing_segment(self) -> None:
        with self.client.stream(
            "POST",
            "/api/studio/run",
            data={"message": "extend this", "action": "extend"},
        ) as response:
            events = _sse_events("".join(response.iter_text()))

        meta = next(payload for name, payload in events if name == "meta")
        execution = next(payload for name, payload in events if name == "execution_request")

        update = self.client.post(
            f"/api/studio/projects/{meta['projectId']}/client-result",
            json={
                "segmentId": execution["segmentId"],
                "status": "running",
                "taskId": "job_123",
                "url": "https://example.com/result.mp4",
                "type": "video",
            },
        )

        self.assertEqual(update.status_code, 200)
        body = update.json()
        self.assertEqual(body["segment"]["taskId"], "job_123")
        self.assertEqual(body["segment"]["url"], "https://example.com/result.mp4")
        self.assertEqual(body["project"]["selectedSegmentId"], execution["segmentId"])
        self.assertEqual(body["job"]["taskId"], "job_123")

    def test_timeline_export_persists_manifest_for_project_segments(self) -> None:
        with self.client.stream(
            "POST",
            "/api/studio/run",
            data={"message": "create a source image", "action": "generate"},
        ) as response:
            image_events = _sse_events("".join(response.iter_text()))
        meta = next(payload for name, payload in image_events if name == "meta")
        image_execution = next(payload for name, payload in image_events if name == "execution_request")

        self.client.post(
            f"/api/studio/projects/{meta['projectId']}/client-result",
            json={
                "segmentId": image_execution["segmentId"],
                "status": "done",
                "taskId": "task_source_image",
                "url": "https://example.com/source.png",
                "posterUrl": "https://example.com/source.png",
                "type": "image",
            },
        )

        with self.client.stream(
            "POST",
            "/api/studio/run",
            data={
                "message": "animate the source image",
                "project_id": meta["projectId"],
                "source_segment_id": image_execution["segmentId"],
                "action": "extend",
            },
        ) as response:
            video_events = _sse_events("".join(response.iter_text()))
        video_execution = next(payload for name, payload in video_events if name == "execution_request")
        self.client.post(
            f"/api/studio/projects/{meta['projectId']}/client-result",
            json={
                "segmentId": video_execution["segmentId"],
                "status": "done",
                "taskId": "task_video_segment",
                "url": "https://example.com/video.mp4",
                "posterUrl": "https://example.com/video.jpg",
                "type": "video",
            },
        )

        export = self.client.post(f"/api/studio/projects/{meta['projectId']}/timeline-export")

        self.assertEqual(export.status_code, 200)
        body = export.json()
        self.assertTrue(body["exportId"].startswith("timeline_export_"))
        self.assertEqual(body["projectId"], meta["projectId"])
        self.assertEqual(body["summary"]["totalSegments"], 2)
        self.assertEqual(body["summary"]["videoSegments"], 1)
        self.assertEqual(body["summary"]["estimatedDurationSeconds"], 10)
        self.assertEqual(body["videoSegments"], 1)
        self.assertEqual(body["estimatedDurationSeconds"], 10)
        self.assertEqual(body["manifest"]["segments"][0]["segmentId"], image_execution["segmentId"])
        self.assertEqual(body["manifest"]["segments"][1]["segmentId"], video_execution["segmentId"])
        self.assertIn(body["status"], {"manifest_ready", "ready", "needs_media"})

        restored = self.client.get(f"/api/studio/projects/{meta['projectId']}/timeline-exports")
        self.assertEqual(restored.status_code, 200)
        restored_body = restored.json()
        self.assertEqual(restored_body["count"], 1)
        self.assertEqual(restored_body["exports"][0]["exportId"], body["exportId"])

    def test_timeline_export_returns_composed_media_when_video_builder_succeeds(self) -> None:
        with self.client.stream(
            "POST",
            "/api/studio/run",
            data={"message": "create a video segment", "action": "extend"},
        ) as response:
            events = _sse_events("".join(response.iter_text()))
        meta = next(payload for name, payload in events if name == "meta")
        execution = next(payload for name, payload in events if name == "execution_request")
        self.client.post(
            f"/api/studio/projects/{meta['projectId']}/client-result",
            json={
                "segmentId": execution["segmentId"],
                "status": "done",
                "taskId": "task_video_for_export",
                "url": "https://example.com/video.mp4",
                "posterUrl": "https://example.com/video.jpg",
                "type": "video",
            },
        )

        with patch(
            "studio_app.infrastructure.storage.timeline_video.compose_timeline_video",
            return_value={"status": "ready", "mediaUrl": "/generated/studio-exports/export.mp4", "message": "Composed 1 video segment."},
        ) as compose:
            export = self.client.post(f"/api/studio/projects/{meta['projectId']}/timeline-export")

        self.assertEqual(export.status_code, 200)
        compose.assert_called_once()
        body = export.json()
        self.assertEqual(body["status"], "ready")
        self.assertEqual(body["mediaUrl"], "/generated/studio-exports/export.mp4")
        self.assertTrue(body["evidence"]["accepted"])

    def test_timeline_export_composes_generated_video_segments_with_ffmpeg(self) -> None:
        ffmpeg = shutil.which("ffmpeg")
        if not ffmpeg:
            self.skipTest("ffmpeg is not available locally")

        with tempfile.TemporaryDirectory() as tmp_dir:
            generated_dir = Path(tmp_dir)
            clip_paths = [generated_dir / "clip-one.mp4", generated_dir / "clip-two.mp4"]
            colors = ["red", "blue"]
            sizes = ["160x90", "90x160"]
            for clip_path, color, size in zip(clip_paths, colors, sizes):
                subprocess.run(
                    [
                        ffmpeg,
                        "-y",
                        "-f",
                        "lavfi",
                        "-i",
                        f"color=c={color}:s={size}:d=0.25",
                        "-an",
                        "-c:v",
                        "libx264",
                        "-pix_fmt",
                        "yuv420p",
                        str(clip_path),
                    ],
                    check=True,
                    capture_output=True,
                    text=True,
                )

            with patch.dict(os.environ, {"STUDIO_GENERATED_DIR": str(generated_dir)}):
                with self.client.stream(
                    "POST",
                    "/api/studio/run",
                    data={"message": "create first clip", "action": "extend"},
                ) as response:
                    first_events = _sse_events("".join(response.iter_text()))
                meta = next(payload for name, payload in first_events if name == "meta")
                first_execution = next(payload for name, payload in first_events if name == "execution_request")
                self.client.post(
                    f"/api/studio/projects/{meta['projectId']}/client-result",
                    json={
                        "segmentId": first_execution["segmentId"],
                        "status": "done",
                        "taskId": "task_clip_one",
                        "url": "/generated/clip-one.mp4",
                        "posterUrl": "/generated/clip-one.mp4",
                        "type": "video",
                    },
                )

                with self.client.stream(
                    "POST",
                    "/api/studio/run",
                    data={
                        "message": "create second clip",
                        "project_id": meta["projectId"],
                        "source_segment_id": first_execution["segmentId"],
                        "action": "extend",
                    },
                ) as response:
                    second_events = _sse_events("".join(response.iter_text()))
                second_execution = next(payload for name, payload in second_events if name == "execution_request")
                self.client.post(
                    f"/api/studio/projects/{meta['projectId']}/client-result",
                    json={
                        "segmentId": second_execution["segmentId"],
                        "status": "done",
                        "taskId": "task_clip_two",
                        "url": "/generated/clip-two.mp4",
                        "posterUrl": "/generated/clip-two.mp4",
                        "type": "video",
                    },
                )

                export = self.client.post(f"/api/studio/projects/{meta['projectId']}/timeline-export")

            self.assertEqual(export.status_code, 200)
            body = export.json()
            self.assertEqual(body["status"], "ready")
            self.assertEqual(body["summary"]["videoSegments"], 2)
            self.assertEqual(body["videoSegments"], 2)
            self.assertEqual(body["estimatedDurationSeconds"], 10)
            self.assertTrue(body["mediaUrl"].startswith("/generated/studio-exports/"))
            exported_file = generated_dir / body["mediaUrl"].removeprefix("/generated/")
            self.assertTrue(exported_file.exists(), body["mediaUrl"])
            self.assertGreater(exported_file.stat().st_size, 0)
            ffprobe = shutil.which("ffprobe")
            if ffprobe:
                probe = subprocess.run(
                    [
                        ffprobe,
                        "-v",
                        "error",
                        "-select_streams",
                        "v:0",
                        "-show_entries",
                        "stream=width,height",
                        "-of",
                        "json",
                        str(exported_file),
                    ],
                    check=True,
                    capture_output=True,
                    text=True,
                )
                stream = json.loads(probe.stdout)["streams"][0]
                self.assertEqual(stream["width"], 160)
                self.assertEqual(stream["height"], 90)

    def test_pages_agents_and_job_lifecycle_endpoints(self) -> None:
        pages = self.client.get("/api/pages")
        self.assertEqual(pages.status_code, 200)
        page_ids = {page["id"] for page in pages.json()["pages"]}
        self.assertIn("dreamy-miniapp", page_ids)
        self.assertIn("myshell-art", page_ids)

        agents = self.client.get("/api/agents")
        self.assertEqual(agents.status_code, 200)
        agent_ids = {agent["id"] for agent in agents.json()["agents"]}
        self.assertIn("evidence-verifier", agent_ids)

        previews = self.client.get("/api/studio/bot-previews")
        self.assertEqual(previews.status_code, 200)
        preview_body = previews.json()
        preview_by_slug = {preview["botSlug"]: preview for preview in preview_body["previews"]}
        dreamy_previews = {
            slug: preview
            for slug, preview in preview_by_slug.items()
            if preview.get("pageId") == "dreamy-miniapp"
        }
        self.assertIn("luna-star", dreamy_previews)
        self.assertIn("aurora-dusk", dreamy_previews)
        self.assertNotIn("ai-porn-generator", dreamy_previews)
        self.assertNotIn("image-to-video-generator", dreamy_previews)
        self.assertIn("seedream-multi-chart", preview_by_slug)
        self.assertEqual(preview_body["summary"]["dreamyBots"], len(dreamy_previews))
        self.assertGreaterEqual(preview_body["summary"]["dreamyBots"], 8)
        self.assertGreaterEqual(preview_body["summary"]["artBots"], 38)
        self.assertEqual(preview_body["summary"]["total"], preview_body["summary"]["dreamyBots"] + preview_body["summary"]["artBots"])
        self.assertIn("botSpecific", preview_body["summary"])
        self.assertIn("representative", preview_body["summary"])
        self.assertEqual(dreamy_previews["aurora-dusk"]["source"], "dreamy-catalog")
        self.assertEqual(dreamy_previews["aurora-dusk"]["botType"], "image-to-video")
        self.assertIn("botSpecific", preview_by_slug["seedream-multi-chart"])

        bots = self.client.get("/api/bots")
        self.assertEqual(bots.status_code, 200)
        first_bot = bots.json()["bots"][0]
        self.assertIn("preview", first_bot)
        self.assertTrue(first_bot["preview"]["mediaUrl"].startswith("/generated/bot-previews/"))

        with self.client.stream(
            "POST",
            "/api/studio/run",
            data={"message": "new segment"},
        ) as response:
            events = _sse_events("".join(response.iter_text()))

        execution = next(payload for name, payload in events if name == "execution_request")
        job_id = execution["jobId"]

        job = self.client.get(f"/api/studio/jobs/{job_id}")
        self.assertEqual(job.status_code, 200)
        self.assertEqual(job.json()["status"], "queued")

        cancelled = self.client.post(f"/api/studio/jobs/{job_id}/cancel")
        self.assertEqual(cancelled.status_code, 200)
        self.assertEqual(cancelled.json()["job"]["status"], "cancelled")

        retried = self.client.post(f"/api/studio/jobs/{job_id}/retry")
        self.assertEqual(retried.status_code, 200)
        self.assertEqual(retried.json()["job"]["status"], "queued")
        self.assertEqual(retried.json()["job"]["attempt"], 2)

    def test_pages_report_dispatch_readiness_and_auth_status(self) -> None:
        def fake_auth_status(page_id: str) -> dict:
            if page_id == "myshell-art":
                return {
                    "status": "auth_missing",
                    "mode": "browser-cookies",
                    "message": "Set MyShell cookies before server execution",
                }
            return {
                "status": "client_delegated",
                "mode": "telegram-init-data",
                "message": "Uses the authenticated miniapp session",
            }

        with patch("studio_app.infrastructure.runtime.health.adapter_auth_status", side_effect=fake_auth_status):
            pages = self.client.get("/api/pages")

        self.assertEqual(pages.status_code, 200)
        page_by_id = {page["id"]: page for page in pages.json()["pages"]}

        dreamy = page_by_id["dreamy-miniapp"]
        self.assertEqual(dreamy["authStatus"]["status"], "client_delegated")
        self.assertEqual(dreamy["dispatchStatus"], "ready")
        self.assertTrue(dreamy["dispatchReady"])

        library = page_by_id["library"]
        self.assertEqual(library["authStatus"]["status"], "client_delegated")
        self.assertEqual(library["dispatchStatus"], "ready")
        self.assertTrue(library["dispatchReady"])

        art = page_by_id["myshell-art"]
        self.assertEqual(art["authStatus"]["status"], "auth_missing")
        self.assertEqual(art["dispatchStatus"], "auth_missing")
        self.assertFalse(art["dispatchReady"])
        self.assertIn("cookies", art["dispatchMessage"].lower())

    def test_dispatch_preview_reports_target_path_agent_and_missing_params(self) -> None:
        library = self.client.get(
            "/api/studio/dispatch-preview",
            params={"page_id": "library", "message": "open my generated library"},
        )
        self.assertEqual(library.status_code, 200)
        library_body = library.json()
        self.assertEqual(library_body["page"]["id"], "library")
        self.assertEqual(library_body["executor"], "navigation")
        self.assertEqual(library_body["agentId"], "miniapp-page-navigator")
        self.assertEqual(library_body["clientAction"], "navigate")
        self.assertEqual(library_body["navigationPath"], "/library")
        self.assertEqual(library_body["missingRouteParams"], [])
        self.assertTrue(library_body["dispatchReady"])
        self.assertEqual(library_body["authStatus"]["status"], "client_delegated")

        tag_generator = self.client.get(
            "/api/studio/dispatch-preview",
            params={"page_id": "tag-generator", "message": "open this tattoo tag generator"},
        )
        self.assertEqual(tag_generator.status_code, 200)
        tag_body = tag_generator.json()
        self.assertEqual(tag_body["page"]["id"], "tag-generator")
        self.assertTrue(tag_body["navigationPath"].startswith("/tag-generator?slug_id="), tag_body["navigationPath"])
        self.assertIn("img", tag_body["missingRouteParams"])
        self.assertEqual(tag_body["routeParams"], ["slug_id", "img"])

    def test_studio_overview_groups_pages_agents_and_job_counts(self) -> None:
        with self.client.stream(
            "POST",
            "/api/studio/run",
            data={"message": "queue dreamy segment", "agent_id": "dreamy-miniapp-executor"},
        ) as response:
            dreamy_events = _sse_events("".join(response.iter_text()))
        with self.client.stream(
            "POST",
            "/api/studio/run",
            data={"message": "open my generated library", "page_id": "library"},
        ) as response:
            library_events = _sse_events("".join(response.iter_text()))

        dreamy_job_id = next(payload for name, payload in dreamy_events if name == "execution_request")["jobId"]
        library_job_id = next(payload for name, payload in library_events if name == "execution_request")["jobId"]

        overview = self.client.get("/api/studio/overview")
        self.assertEqual(overview.status_code, 200)
        body = overview.json()
        self.assertEqual(body["totals"]["jobs"], 2)
        self.assertEqual(body["totals"]["queued"], 1)
        self.assertEqual(body["totals"]["done"], 1)

        pages = {page["id"]: page for page in body["pages"]}
        self.assertEqual(pages["dreamy-miniapp"]["jobCounts"]["queued"], 1)
        self.assertEqual(pages["dreamy-miniapp"]["latestJob"]["jobId"], dreamy_job_id)
        self.assertIn("dreamy-miniapp-executor", pages["dreamy-miniapp"]["agentIds"])
        self.assertEqual(pages["library"]["jobCounts"]["done"], 1)
        self.assertEqual(pages["library"]["latestJob"]["jobId"], library_job_id)
        self.assertIn("miniapp-page-navigator", pages["library"]["agentIds"])

        agents = {agent["id"]: agent for agent in body["agents"]}
        self.assertEqual(agents["dreamy-miniapp-executor"]["jobCounts"]["queued"], 1)
        self.assertEqual(agents["miniapp-page-navigator"]["jobCounts"]["done"], 1)
        self.assertEqual([job["jobId"] for job in body["latestJobs"]], [library_job_id, dreamy_job_id])

    def test_bulk_job_actions_apply_to_filtered_queue(self) -> None:
        with self.client.stream(
            "POST",
            "/api/studio/run",
            data={"message": "queue dreamy segment", "agent_id": "dreamy-miniapp-executor"},
        ) as response:
            dreamy_events = _sse_events("".join(response.iter_text()))
        with self.client.stream(
            "POST",
            "/api/studio/run",
            data={"message": "open my generated library", "page_id": "library"},
        ) as response:
            library_events = _sse_events("".join(response.iter_text()))

        dreamy_job_id = next(payload for name, payload in dreamy_events if name == "execution_request")["jobId"]
        library_job_id = next(payload for name, payload in library_events if name == "execution_request")["jobId"]

        cancelled = self.client.post("/api/studio/jobs/bulk", json={"action": "cancel", "status": "queued"})
        self.assertEqual(cancelled.status_code, 200)
        cancel_body = cancelled.json()
        self.assertEqual(cancel_body["action"], "cancel")
        self.assertEqual(cancel_body["matchedCount"], 1)
        self.assertEqual([job["jobId"] for job in cancel_body["jobs"]], [dreamy_job_id])
        self.assertEqual(cancel_body["jobs"][0]["status"], "cancelled")
        self.assertEqual(self.client.get(f"/api/studio/jobs/{dreamy_job_id}").json()["status"], "cancelled")
        self.assertEqual(self.client.get(f"/api/studio/jobs/{library_job_id}").json()["status"], "done")

        retried = self.client.post("/api/studio/jobs/bulk", json={"action": "retry", "page_id": "library"})
        self.assertEqual(retried.status_code, 200)
        retry_body = retried.json()
        self.assertEqual(retry_body["action"], "retry")
        self.assertEqual(retry_body["matchedCount"], 1)
        self.assertEqual([job["jobId"] for job in retry_body["jobs"]], [library_job_id])
        self.assertEqual(retry_body["jobs"][0]["status"], "queued")
        self.assertEqual(retry_body["jobs"][0]["attempt"], 2)
        self.assertEqual(retry_body["executionRequests"][0]["jobId"], library_job_id)

    def test_bulk_cancel_skips_terminal_jobs_by_default(self) -> None:
        with self.client.stream(
            "POST",
            "/api/studio/run",
            data={"message": "queue dreamy segment"},
        ) as response:
            dreamy_events = _sse_events("".join(response.iter_text()))
        with self.client.stream(
            "POST",
            "/api/studio/run",
            data={"message": "open my generated library", "page_id": "library"},
        ) as response:
            library_events = _sse_events("".join(response.iter_text()))

        dreamy_job_id = next(payload for name, payload in dreamy_events if name == "execution_request")["jobId"]
        library_job_id = next(payload for name, payload in library_events if name == "execution_request")["jobId"]

        cancelled = self.client.post("/api/studio/jobs/bulk", json={"action": "cancel"})
        self.assertEqual(cancelled.status_code, 200)
        body = cancelled.json()
        self.assertEqual(body["matchedCount"], 1)
        self.assertEqual(body["skippedCount"], 1)
        self.assertEqual([job["jobId"] for job in body["jobs"]], [dreamy_job_id])
        self.assertEqual(body["jobs"][0]["status"], "cancelled")
        self.assertEqual([job["jobId"] for job in body["skippedJobs"]], [library_job_id])
        self.assertEqual(body["skippedJobs"][0]["status"], "done")
        self.assertEqual(self.client.get(f"/api/studio/jobs/{library_job_id}").json()["status"], "done")

        forced = self.client.post("/api/studio/jobs/bulk", json={"action": "cancel", "include_terminal": True})
        self.assertEqual(forced.status_code, 200)
        self.assertEqual(forced.json()["matchedCount"], 2)
        self.assertEqual(self.client.get(f"/api/studio/jobs/{library_job_id}").json()["status"], "cancelled")

    def test_health_reports_delivery_components(self) -> None:
        health = self.client.get("/api/health")
        self.assertEqual(health.status_code, 200)
        body = health.json()
        self.assertIn(body["status"], {"ok", "degraded"})
        self.assertIn("checkedAt", body)

        components = body["components"]
        for component_id in (
            "backend",
            "storage",
            "chromeCdp",
            "myshellCookies",
            "cookieInjection",
            "dreamyApiAuth",
            "ffmpeg",
            "credentialSetup",
            "liveGeneration",
        ):
            self.assertIn(component_id, components)
            self.assertIn("status", components[component_id])
        credentials = components["credentialSetup"]
        self.assertEqual(credentials["status"], "needs_configuration")
        binding_by_env = {binding["env"]: binding for binding in credentials["bindings"]}
        self.assertEqual(binding_by_env["DREAMY_TELEGRAM_INIT_DATA"]["secret"], "myshell-dreamy-init-data")
        self.assertEqual(binding_by_env["MYSHELL_COOKIES"]["secret"], "myshell-cookies")
        self.assertFalse(binding_by_env["DREAMY_TELEGRAM_INIT_DATA"]["configured"])
        self.assertEqual(components["liveGeneration"]["status"], "needs_configuration")
        self.assertEqual(components["liveGeneration"]["endpoint"], "/api/studio/generation-smoke")

    def test_generation_smoke_reports_missing_credentials_without_running(self) -> None:

        async def forbidden_dreamy_request(endpoint: str, body: dict, init_data: str) -> dict:
            raise AssertionError(f"unexpected Dreamy request: {endpoint}")

        with (
            patch.dict(os.environ, {"DREAMY_TELEGRAM_INIT_DATA": "", "MYSHELL_COOKIES": ""}, clear=False),
            patch("studio_app.infrastructure.adapters.dreamy.client.dreamy_api_request", side_effect=forbidden_dreamy_request),
        ):
            readiness = self.client.get("/api/studio/generation-smoke")
            executed = self.client.post("/api/studio/generation-smoke", json={"execute": True})

        self.assertEqual(readiness.status_code, 200)
        self.assertEqual(readiness.json()["status"], "needs_configuration")
        self.assertIn("DREAMY_TELEGRAM_INIT_DATA", readiness.json()["prerequisites"]["missingEnv"])
        self.assertEqual(executed.status_code, 200)
        self.assertEqual(executed.json()["status"], "needs_configuration")
        self.assertEqual(self.client.get("/api/studio/jobs").json()["count"], 0)

    def test_art_api_auth_smoke_reports_missing_cookies_without_api_call(self) -> None:

        async def forbidden_probe(**_kwargs):
            raise AssertionError("unexpected MyShell Art API probe")

        with (
            patch.dict(os.environ, {"MYSHELL_COOKIES": ""}, clear=False),
            patch.object(myshell_art_api, "probe_art_api_auth", side_effect=forbidden_probe),
        ):
            response = self.client.get("/api/studio/art-api-auth-smoke")

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["status"], "auth_missing")
        self.assertFalse(body["ready"])
        self.assertIn("cookies", body["message"].lower())

    def test_art_api_auth_smoke_reports_ready_probe(self) -> None:

        async def fake_probe(**_kwargs):
            return {
                "status": "ready",
                "ready": True,
                "message": "MyShell Art API auth is ready.",
                "authProbe": {"httpStatus": 200, "success": True, "dataKeys": ["userId"]},
                "runningTasksProbe": {"httpStatus": 200, "success": True, "dataKeys": []},
            }

        with (
            patch.dict(
                os.environ,
                {"MYSHELL_COOKIES": json.dumps([{"name": "ms_token", "value": "redacted", "domain": ".myshell.ai"}])},
                clear=False,
            ),
            patch.object(myshell_art_api, "probe_art_api_auth", side_effect=fake_probe),
        ):
            response = self.client.get("/api/studio/art-api-auth-smoke")

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["status"], "ready")
        self.assertTrue(body["ready"])
        self.assertEqual(body["authProbe"]["httpStatus"], 200)

    def test_canvaspro_generation_task_prepares_outputs_without_execute(self) -> None:

        async def forbidden_generate(**_kwargs):
            raise AssertionError("unexpected live CanvasPro generation")

        with (
            patch.dict(os.environ, {"MYSHELL_COOKIES": ""}, clear=False),
            patch.object(myshell_art_api, "generate_via_art_api", side_effect=forbidden_generate),
        ):
            response = self.client.post(
                "/api/studio/canvaspro/generation-tasks",
                json={
                    "kind": "image",
                    "nodeId": "node-image-1",
                    "prompt": "cinematic neon portrait",
                    "settings": {
                        "aspectRatio": "21:9",
                        "mode": "reference-to-image",
                        "model": "image-pro",
                        "outputCount": 3,
                        "quality": "high",
                        "resolution": "3K",
                    },
                },
            )

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["status"], "ready")
        task = body["task"]
        self.assertEqual(task["nodeId"], "node-image-1")
        self.assertEqual(task["settings"]["aspectRatio"], "21:9")
        self.assertEqual(task["settings"]["outputCount"], 3)
        self.assertEqual(task["settings"]["model"], "image-pro")
        self.assertEqual(task["settings"]["resolution"], "3K")
        self.assertEqual(task["costEstimate"]["credits"], 24)
        self.assertEqual(len(task["outputs"]), 3)
        self.assertTrue(all(output["status"] == "waiting_service" for output in task["outputs"]))
        self.assertEqual(task["executor"]["mode"], "dry-run")

    def test_canvaspro_source_asset_stages_uploaded_media(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            with patch.dict(os.environ, {"STUDIO_GENERATED_DIR": tmp_dir}):
                response = self.client.post(
                    "/api/studio/canvaspro/source-assets",
                    files={"file": ("reference.png", b"\x89PNG\r\n\x1a\nsource", "image/png")},
                )

            self.assertEqual(response.status_code, 200)
            body = response.json()
            self.assertEqual(body["status"], "ready")
            self.assertEqual(body["fileName"], "reference.png")
            self.assertEqual(body["mimeType"], "image/png")
            self.assertEqual(body["preferredUrl"], body["mediaUrl"])
            self.assertEqual(body["remoteUpload"]["status"], "skipped")
            self.assertTrue(body["mediaUrl"].startswith("/generated/canvaspro-inputs/"))
            staged_path = Path(tmp_dir) / body["mediaUrl"].removeprefix("/generated/")
            self.assertEqual(staged_path.read_bytes(), b"\x89PNG\r\n\x1a\nsource")

    def test_canvaspro_source_asset_can_upload_remote_with_myshell_art_cli(self) -> None:

        calls: list[dict] = []

        async def fake_execute(**kwargs):
            calls.append(kwargs)
            return {
                "status": "done",
                "message": "uploaded",
                "output_url": "https://cdn.example.test/remote-reference.png",
                "executor": {
                    "provider": "myshell-art-cli",
                    "atom": "upload-image",
                    "mode": "execute",
                },
            }

        with tempfile.TemporaryDirectory() as tmp_dir:
            with (
                patch.dict(os.environ, {"STUDIO_GENERATED_DIR": tmp_dir}),
                patch.object(myshell_art_cli, "execute_canvaspro_task", side_effect=fake_execute),
            ):
                response = self.client.post(
                    "/api/studio/canvaspro/source-assets",
                    data={"upload_remote": "true"},
                    files={"file": ("reference.png", b"\x89PNG\r\n\x1a\nsource", "image/png")},
                )

            self.assertEqual(response.status_code, 200)
            body = response.json()
            self.assertEqual(body["mediaUrl"], body["localUrl"])
            self.assertEqual(body["remoteMediaUrl"], "https://cdn.example.test/remote-reference.png")
            self.assertEqual(body["preferredUrl"], "https://cdn.example.test/remote-reference.png")
            self.assertEqual(body["remoteUpload"]["status"], "ready")
            self.assertEqual(calls[0]["executor"]["atom"], "upload-image")
            self.assertEqual(calls[0]["input_values"][0], str(Path(tmp_dir) / body["mediaUrl"].removeprefix("/generated/")))

    def test_canvaspro_generation_task_execute_requires_credentials_before_submit(self) -> None:

        async def forbidden_generate(**_kwargs):
            raise AssertionError("unexpected live CanvasPro generation")

        with (
            patch.dict(os.environ, {"MYSHELL_COOKIES": ""}, clear=False),
            patch.object(myshell_art_api, "generate_via_art_api", side_effect=forbidden_generate),
        ):
            response = self.client.post(
                "/api/studio/canvaspro/generation-tasks",
                json={
                    "execute": True,
                    "kind": "image",
                    "prompt": "cinematic neon portrait",
                    "executor": {"botId": "1751532766"},
                },
            )

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["status"], "auth_missing")
        self.assertEqual(body["task"]["status"], "auth_missing")
        self.assertEqual(body["task"]["settings"]["aspectRatio"], "9:16")
        self.assertEqual(body["task"]["settings"]["model"], "doubao-seedream-5.0-lite")
        self.assertEqual(body["task"]["settings"]["resolution"], "2K")
        self.assertEqual(body["task"]["costEstimate"]["credits"], 5)
        self.assertFalse(body["readyForExecution"])

    def test_canvaspro_generation_task_executes_art_api_with_explicit_bot_id(self) -> None:

        calls: list[dict] = []

        async def fake_generate(**kwargs):
            calls.append(kwargs)
            return {
                "status": "done",
                "output_url": "https://cdn.example.test/canvaspro-output.png",
                "task_id": "canvaspro-external-task-1",
                "executor": "myshell-art-api",
            }

        with (
            patch(
                "studio_app.infrastructure.runtime.health.cookie_source_status",
                return_value={"status": "ready", "message": "cookies ready", "cookieCount": 2},
            ),
            patch.object(myshell_art_api, "generate_via_art_api", side_effect=fake_generate),
        ):
            response = self.client.post(
                "/api/studio/canvaspro/generation-tasks",
                json={
                    "execute": True,
                    "kind": "image",
                    "taskId": "studio-task-1",
                    "nodeId": "node-image-1",
                    "prompt": "cinematic neon portrait",
                    "settings": {"outputCount": 1, "mode": "text-to-image"},
                    "executor": {"botId": "1751532766", "articleId": "brat-generator"},
                },
            )

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["status"], "done")
        self.assertTrue(body["readyForExecution"])
        self.assertEqual(body["task"]["id"], "studio-task-1")
        self.assertEqual(body["task"]["externalTaskId"], "canvaspro-external-task-1")
        self.assertEqual(body["task"]["outputs"][0]["status"], "done")
        self.assertEqual(body["task"]["outputs"][0]["mediaUrl"], "https://cdn.example.test/canvaspro-output.png")
        self.assertEqual(calls[0]["bot_id"], "1751532766")
        self.assertEqual(calls[0]["article_id"], "brat-generator")
        self.assertEqual(calls[0]["input_values"], ["cinematic neon portrait"])

    def test_canvaspro_node_capabilities_list_myshell_art_cli_atoms(self) -> None:

        fake_status = {
            "status": "ready",
            "ready": True,
            "provider": "myshell-art-cli",
            "auth": {
                "dreamy": {"status": "ready", "ready": True},
                "art": {"status": "auth_missing", "ready": False},
            },
        }

        with patch.object(myshell_art_cli, "cli_status", return_value=fake_status):
            response = self.client.get("/api/studio/canvaspro/node-capabilities")

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["provider"]["id"], "myshell-art-cli")
        capability_ids = {capability["id"] for capability in body["capabilities"]}
        self.assertIn("myshell-art-cli.dreamy-generate", capability_ids)
        self.assertIn("myshell-art-cli.generate-create", capability_ids)
        self.assertIn("myshell-art-cli.upload-image", capability_ids)
        self.assertIn("myshell-art-cli.energy-balance", capability_ids)

    def test_canvaspro_cli_auth_status_uses_myshell_art_cli(self) -> None:

        async def fake_auth_status():
            return {
                "status": "auth_missing",
                "ready": False,
                "provider": "myshell-art-cli",
                "message": "MyShell Art CLI is installed, but not logged in.",
                "raw": {"authenticated": False, "cookie_count": 0},
            }

        with patch.object(myshell_art_cli, "auth_status", side_effect=fake_auth_status):
            response = self.client.get("/api/studio/canvaspro/cli-auth")

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["provider"], "myshell-art-cli")
        self.assertEqual(body["status"], "auth_missing")
        self.assertFalse(body["ready"])

    def test_canvaspro_cli_login_with_token_delegates_without_echoing_secret(self) -> None:

        calls: list[str] = []

        async def fake_login_with_token(token: str):
            calls.append(token)
            return {
                "status": "ready",
                "ready": True,
                "provider": "myshell-art-cli",
                "message": "MyShell Art CLI credentials are ready.",
                "raw": {"authenticated": True, "has_token": True, "token": "<redacted>"},
            }

        with patch.object(myshell_art_cli, "login_with_token", side_effect=fake_login_with_token):
            response = self.client.post(
                "/api/studio/canvaspro/cli-auth/login",
                json={"method": "token", "token": "super-secret-token"},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(calls, ["super-secret-token"])
        self.assertTrue(response.json()["ready"])
        self.assertNotIn("super-secret-token", response.text)

    def test_canvaspro_generation_task_prepares_myshell_art_cli_atom(self) -> None:

        fake_status = {
            "status": "ready",
            "ready": True,
            "provider": "myshell-art-cli",
            "auth": {
                "dreamy": {"status": "ready", "ready": True},
                "art": {"status": "auth_missing", "ready": False},
            },
        }

        with patch.object(myshell_art_cli, "cli_status", return_value=fake_status):
            response = self.client.post(
                "/api/studio/canvaspro/generation-tasks",
                json={
                    "kind": "video",
                    "nodeId": "node-video-1",
                    "prompt": "cinematic neon opener",
                    "settings": {
                        "aspectRatio": "16:9",
                        "durationSeconds": 5,
                        "mode": "image-to-video",
                        "resolution": "1080P",
                    },
                    "inputValues": ["https://cdn.example.test/ref.png"],
                    "executor": {
                        "provider": "myshell-art-cli",
                        "atom": "dreamy-generate",
                        "slugId": "self-director-demo",
                    },
                },
            )

        self.assertEqual(response.status_code, 200)
        body = response.json()
        task = body["task"]
        self.assertEqual(body["status"], "ready")
        self.assertTrue(body["readyForExecution"])
        self.assertEqual(task["label"], "待原子能力")
        self.assertEqual(task["executor"]["provider"], "myshell-art-cli")
        self.assertEqual(task["executor"]["capabilityId"], "myshell-art-cli.dreamy-generate")
        self.assertEqual(task["executor"]["atom"], "dreamy-generate")
        self.assertEqual(task["settings"]["model"], "wan-2.2")
        self.assertEqual(task["costEstimate"]["credits"], 50)
        self.assertIn("myshell-art --json dreamy generate", task["executor"]["commandPreview"])
        self.assertIn("--slug-id", task["executor"]["arguments"])

    def test_canvaspro_cli_plan_uses_default_slug_from_environment(self) -> None:

        fake_status = {
            "status": "ready",
            "ready": True,
            "provider": "myshell-art-cli",
            "auth": {
                "dreamy": {"status": "ready", "ready": True},
                "art": {"status": "auth_missing", "ready": False},
            },
        }

        with (
            patch.dict(os.environ, {"CANVASPRO_MYSHELL_ART_SLUG_ID": "default-canvaspro-director"}, clear=False),
            patch.object(myshell_art_cli, "cli_status", return_value=fake_status),
        ):
            plan = myshell_art_cli.build_canvaspro_plan(
                kind="video",
                prompt="cinematic neon opener",
                settings={"durationSeconds": 5, "mode": "text-to-video"},
                executor={"provider": "myshell-art-cli", "atom": "dreamy-generate"},
                input_values=[],
            )

        self.assertEqual(plan["missingInputs"], [])
        self.assertTrue(plan["readyForExecution"])
        self.assertIn("--slug-id", plan["arguments"])
        self.assertIn("default-canvaspro-director", plan["arguments"])
        self.assertIn("--slug-id default-canvaspro-director", plan["commandPreview"])

    def test_canvaspro_generation_task_executes_myshell_art_cli_atom(self) -> None:

        calls: list[dict] = []

        async def fake_execute(**kwargs):
            calls.append(kwargs)
            return {
                "status": "done",
                "message": "MyShell Art CLI returned media.",
                "output_url": "https://cdn.example.test/canvaspro-cli-output.mp4",
                "task_id": "dreamy-output-job-1",
                "executor": {
                    "provider": "myshell-art-cli",
                    "capabilityId": "myshell-art-cli.dreamy-generate",
                    "atom": "dreamy-generate",
                    "mode": "execute",
                    "readyForExecution": True,
                },
            }

        with patch.object(myshell_art_cli, "execute_canvaspro_task", side_effect=fake_execute):
            response = self.client.post(
                "/api/studio/canvaspro/generation-tasks",
                json={
                    "execute": True,
                    "kind": "video",
                    "taskId": "studio-task-cli-1",
                    "nodeId": "node-video-1",
                    "prompt": "cinematic neon opener",
                    "settings": {"durationSeconds": 5, "mode": "image-to-video"},
                    "inputValues": ["https://cdn.example.test/ref.png"],
                    "executor": {
                        "provider": "myshell-art-cli",
                        "atom": "dreamy-generate",
                        "slugId": "self-director-demo",
                    },
                },
            )

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["status"], "done")
        self.assertEqual(body["task"]["id"], "studio-task-cli-1")
        self.assertEqual(body["task"]["externalTaskId"], "dreamy-output-job-1")
        self.assertEqual(body["task"]["outputs"][0]["mediaUrl"], "https://cdn.example.test/canvaspro-cli-output.mp4")
        self.assertEqual(body["task"]["executor"]["provider"], "myshell-art-cli")
        self.assertEqual(calls[0]["prompt"], "cinematic neon opener")
        self.assertEqual(calls[0]["input_values"], ["https://cdn.example.test/ref.png"])
        self.assertEqual(calls[0]["executor"]["slugId"], "self-director-demo")

    def test_canvaspro_generation_task_sync_fetches_cli_result(self) -> None:

        calls: list[dict] = []

        async def fake_fetch(**kwargs):
            calls.append(kwargs)
            return {
                "status": "done",
                "message": "synced",
                "output_url": "https://cdn.example.test/synced-output.mp4",
                "task_id": "dreamy-output-job-1",
                "executor": {
                    "provider": "myshell-art-cli",
                    "capabilityId": "myshell-art-cli.dreamy-generate",
                    "atom": "dreamy-generate",
                    "mode": "result",
                },
            }

        with patch.object(myshell_art_cli, "fetch_canvaspro_task_result", side_effect=fake_fetch):
            response = self.client.post(
                "/api/studio/canvaspro/generation-tasks/sync",
                json={
                    "kind": "video",
                    "nodeId": "node-video-1",
                    "task": {
                        "id": "studio-task-cli-1",
                        "kind": "video",
                        "status": "running",
                        "externalTaskId": "dreamy-output-job-1",
                        "prompt": "cinematic neon opener",
                        "settings": {"durationSeconds": 5, "mode": "image-to-video", "outputCount": 1},
                        "outputs": [
                            {
                                "id": "output-slot-1",
                                "index": 1,
                                "kind": "video",
                                "nodeId": "existing-output-node",
                                "status": "pending",
                            }
                        ],
                        "executor": {
                            "provider": "myshell-art-cli",
                            "atom": "dreamy-generate",
                        },
                    },
                },
            )

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["status"], "done")
        task = body["task"]
        self.assertEqual(task["id"], "studio-task-cli-1")
        self.assertEqual(task["externalTaskId"], "dreamy-output-job-1")
        self.assertEqual(task["outputs"][0]["id"], "output-slot-1")
        self.assertEqual(task["outputs"][0]["nodeId"], "existing-output-node")
        self.assertEqual(task["outputs"][0]["status"], "done")
        self.assertEqual(task["outputs"][0]["mediaUrl"], "https://cdn.example.test/synced-output.mp4")
        self.assertEqual(task["progress"], 100)
        self.assertEqual(calls[0]["task_id"], "dreamy-output-job-1")
        self.assertEqual(calls[0]["executor"]["atom"], "dreamy-generate")

    def test_canvaspro_generation_task_sync_without_external_task_id_does_not_fetch(self) -> None:

        async def forbidden_fetch(**_kwargs):
            raise AssertionError("unexpected CanvasPro result sync fetch")

        with patch.object(myshell_art_cli, "fetch_canvaspro_task_result", side_effect=forbidden_fetch):
            response = self.client.post(
                "/api/studio/canvaspro/generation-tasks/sync",
                json={
                    "kind": "image",
                    "nodeId": "node-image-1",
                    "task": {
                        "id": "studio-task-draft-1",
                        "kind": "image",
                        "status": "ready",
                        "prompt": "cinematic neon portrait",
                        "settings": {"outputCount": 2, "model": "image-pro"},
                        "outputs": [
                            {"id": "output-slot-1", "index": 1, "kind": "image", "status": "waiting_service"},
                            {"id": "output-slot-2", "index": 2, "kind": "image", "status": "waiting_service"},
                        ],
                        "executor": {
                            "provider": "myshell-art-cli",
                            "atom": "dreamy-generate",
                        },
                    },
                },
            )

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["status"], "ready")
        self.assertIn("not been submitted", body["message"])
        self.assertEqual(body["task"]["outputs"][0]["id"], "output-slot-1")
        self.assertEqual(body["task"]["outputs"][1]["id"], "output-slot-2")
        self.assertTrue(all(output["status"] == "waiting_service" for output in body["task"]["outputs"]))

    def test_canvaspro_generation_task_sync_preserves_existing_output_slots(self) -> None:

        async def forbidden_fetch(**_kwargs):
            raise AssertionError("unexpected CanvasPro result sync fetch")

        with patch.object(myshell_art_cli, "fetch_canvaspro_task_result", side_effect=forbidden_fetch):
            response = self.client.post(
                "/api/studio/canvaspro/generation-tasks/sync",
                json={
                    "kind": "image",
                    "nodeId": "node-image-1",
                    "task": {
                        "id": "studio-task-partial-1",
                        "kind": "image",
                        "status": "running",
                        "externalTaskId": "dreamy-output-job-2",
                        "prompt": "cinematic neon portrait",
                        "settings": {"outputCount": 3, "model": "image-pro"},
                        "outputs": [
                            {"id": "output-slot-1", "index": 1, "kind": "image", "status": "pending"},
                            {
                                "id": "output-slot-2",
                                "index": 2,
                                "kind": "image",
                                "status": "done",
                                "mediaUrl": "https://cdn.example.test/output-2.png",
                            },
                            {"id": "output-slot-3", "index": 3, "kind": "image", "status": "pending"},
                        ],
                        "executor": {
                            "provider": "myshell-art-cli",
                            "atom": "dreamy-generate",
                        },
                    },
                },
            )

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["status"], "running")
        outputs = body["task"]["outputs"]
        self.assertEqual(outputs[0]["id"], "output-slot-1")
        self.assertEqual(outputs[0]["status"], "pending")
        self.assertEqual(outputs[0]["mediaUrl"], "")
        self.assertEqual(outputs[1]["id"], "output-slot-2")
        self.assertEqual(outputs[1]["status"], "done")
        self.assertEqual(outputs[1]["mediaUrl"], "https://cdn.example.test/output-2.png")
        self.assertEqual(outputs[2]["id"], "output-slot-3")
        self.assertEqual(outputs[2]["status"], "pending")
        self.assertEqual(outputs[2]["mediaUrl"], "")

    def test_generation_smoke_executes_dreamy_and_persists_accepted_evidence(self) -> None:

        calls: list[tuple[str, dict]] = []

        async def fake_dreamy_request(endpoint: str, body: dict, init_data: str) -> dict:
            calls.append((endpoint, body))
            self.assertEqual(init_data, "query_id=server-auth")
            if endpoint.endswith("/get-by-slug"):
                return {"info": {"botId": "bot_live_smoke", "slugId": "live-smoke"}}
            if endpoint.endswith("/generate"):
                return {"outputJobId": "dreamy_live_smoke_123"}
            if endpoint.endswith("/generate/result"):
                return {
                    "tasks": [
                        {
                            "status": "done",
                            "jobId": "dreamy_live_smoke_123",
                            "result": json.dumps(
                                {
                                    "outputImg": "https://cdn.example.test/live-smoke.mp4",
                                    "outputPreview": "https://cdn.example.test/live-smoke-poster.jpg",
                                }
                            ),
                        }
                    ]
                }
            raise AssertionError(endpoint)

        async def fake_runtime_health(store_path: str) -> dict:
            return {
                "status": "ok",
                "components": {
                    "liveGeneration": {
                        "status": "ready",
                        "checks": {"dreamyServer": {"status": "ready"}},
                    }
                },
            }

        with (
            patch.dict(os.environ, {"DREAMY_TELEGRAM_INIT_DATA": "query_id=server-auth"}, clear=False),
            patch("studio_app.infrastructure.adapters.dreamy.client.dreamy_api_request", side_effect=fake_dreamy_request),
            patch("studio_app.infrastructure.runtime.health.runtime_health", side_effect=fake_runtime_health),
        ):
            response = self.client.post(
                "/api/studio/generation-smoke",
                json={"execute": True, "prompt": "live smoke prompt"},
            )
            audit = self.client.get("/api/studio/delivery-audit")

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["status"], "done")
        self.assertTrue(body["latest"]["accepted"])
        self.assertEqual(body["latest"]["mediaUrl"], "https://cdn.example.test/live-smoke.mp4")
        self.assertEqual(calls[0][0], "/v1/telegram/miniapp/dreamy/get-by-slug")
        self.assertEqual(calls[1][0], "/v1/telegram/miniapp/dreamy/generate")
        self.assertEqual(calls[2][0], "/v1/telegram/miniapp/dreamy/generate/result")

        requirements = {item["id"]: item for item in audit.json()["requirements"]}
        self.assertEqual(requirements["live-generation-smoke"]["status"], "ready")
        self.assertTrue(requirements["live-generation-smoke"]["evidence"]["latest"]["accepted"])

    def test_dreamy_workshop_smoke_reports_missing_credentials_without_running(self) -> None:

        called = False

        async def fake_dreamy_request(endpoint: str, body: dict, init_data: str) -> dict:
            nonlocal called
            called = True
            raise AssertionError(endpoint)

        async def fake_runtime_health(store_path: str) -> dict:
            return {
                "status": "needs_configuration",
                "components": {
                    "liveGeneration": {
                        "status": "needs_configuration",
                        "checks": {"dreamyServer": {"status": "auth_missing"}},
                    }
                },
            }

        with (
            patch("studio_app.infrastructure.adapters.dreamy.client.dreamy_api_request", side_effect=fake_dreamy_request),
            patch("studio_app.infrastructure.runtime.health.runtime_health", side_effect=fake_runtime_health),
        ):
            response = self.client.post("/api/studio/dreamy-workshop-smoke", json={"execute": True})

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["status"], "needs_configuration")
        self.assertEqual(body["count"], 0)
        self.assertFalse(called)

    def test_dreamy_workshop_smoke_executes_all_seed_bots_and_chains_video_source(self) -> None:
        from studio_app.registry.bot_previews import DREAMY_BOTS

        calls: list[tuple[str, dict]] = []

        async def fake_dreamy_request(endpoint: str, body: dict, init_data: str) -> dict:
            calls.append((endpoint, body))
            self.assertEqual(init_data, "query_id=server-auth")
            if endpoint.endswith("/get-by-slug"):
                slug = body["slug_id"]
                return {"info": {"botId": f"bot_{slug}", "slugId": slug}}
            if endpoint.endswith("/generate"):
                slug = str(body["bot_id"]).replace("bot_", "", 1)
                return {"outputJobId": f"job_{slug}"}
            if endpoint.endswith("/generate/result"):
                output_job_id = body["output_job_id"]
                return {
                    "tasks": [
                        {
                            "status": "done",
                            "jobId": output_job_id,
                            "result": json.dumps(
                                {
                                    "outputImg": f"https://cdn.example.test/{output_job_id}.mp4",
                                    "outputPreview": f"https://cdn.example.test/{output_job_id}-poster.jpg",
                                }
                            ),
                        }
                    ]
                }
            raise AssertionError(endpoint)

        async def fake_runtime_health(store_path: str) -> dict:
            return {
                "status": "ok",
                "components": {
                    "liveGeneration": {
                        "status": "ready",
                        "checks": {"dreamyServer": {"status": "ready"}},
                    }
                },
            }

        with (
            patch.dict(os.environ, {"DREAMY_TELEGRAM_INIT_DATA": "query_id=server-auth"}, clear=False),
            patch("studio_app.infrastructure.adapters.dreamy.client.dreamy_api_request", side_effect=fake_dreamy_request),
            patch("studio_app.infrastructure.runtime.health.runtime_health", side_effect=fake_runtime_health),
        ):
            response = self.client.post(
                "/api/studio/dreamy-workshop-smoke",
                json={"execute": True, "prompt": "workshop smoke prompt"},
            )

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["status"], "done")
        self.assertEqual(body["count"], len(DREAMY_BOTS))
        self.assertEqual(body["acceptedCount"], len(DREAMY_BOTS))
        self.assertEqual(body["botSlugs"], [bot["slug"] for bot in DREAMY_BOTS])
        self.assertEqual(len(body["project"]["segments"]), len(DREAMY_BOTS))

        get_slug_calls = [call_body["slug_id"] for endpoint, call_body in calls if endpoint.endswith("/get-by-slug")]
        self.assertEqual(get_slug_calls, [bot["slug"] for bot in DREAMY_BOTS])
        generate_calls = [call_body for endpoint, call_body in calls if endpoint.endswith("/generate")]
        aurora_generate = next(call for call in generate_calls if call["bot_id"] == "bot_aurora-dusk")
        self.assertEqual(aurora_generate["input_img"][0], "https://cdn.example.test/job_scarlet-bloom.mp4")

    def test_dreamy_server_auth_status_uses_configured_init_data(self) -> None:
        with patch.dict(os.environ, {"DREAMY_TELEGRAM_INIT_DATA": "query_id=server-auth"}, clear=False):
            health = self.client.get("/api/health")
            pages = self.client.get("/api/pages")

        self.assertEqual(health.status_code, 200)
        dreamy_auth = health.json()["components"]["dreamyApiAuth"]
        self.assertEqual(dreamy_auth["status"], "ready")
        self.assertEqual(dreamy_auth["mode"], "server-telegram-init-data")
        self.assertIn("server", dreamy_auth["message"].lower())

        page_by_id = {page["id"]: page for page in pages.json()["pages"]}
        dreamy_page = page_by_id["dreamy-miniapp"]
        self.assertEqual(dreamy_page["authStatus"]["status"], "ready")
        self.assertEqual(dreamy_page["authStatus"]["mode"], "server-telegram-init-data")
        self.assertEqual(dreamy_page["executor"], "server")
        self.assertEqual(dreamy_page["dispatchMode"], "execute-server")
        self.assertTrue(dreamy_page["dispatchReady"])

    def test_run_stream_executes_dreamy_server_adapter_when_init_data_is_configured(self) -> None:

        calls: list[tuple[str, dict]] = []

        async def fake_dreamy_request(endpoint: str, body: dict, init_data: str) -> dict:
            calls.append((endpoint, body))
            self.assertEqual(init_data, "query_id=server-auth")
            if endpoint.endswith("/get-by-slug"):
                return {"info": {"botId": "bot_neon_art", "slugId": "neon-art-generator"}}
            if endpoint.endswith("/generate"):
                return {"outputJobId": "dreamy_job_123", "queuePosition": 0}
            if endpoint.endswith("/generate/result"):
                return {
                    "tasks": [
                        {
                            "status": "done",
                            "jobId": "dreamy_job_123",
                            "result": json.dumps(
                                {
                                    "outputImg": "https://cdn.example.test/generated.mp4",
                                    "outputPreview": "https://cdn.example.test/generated-poster.jpg",
                                }
                            ),
                        }
                    ]
                }
            raise AssertionError(endpoint)

        with (
            patch.dict(os.environ, {"DREAMY_TELEGRAM_INIT_DATA": "query_id=server-auth"}, clear=False),
            patch("studio_app.infrastructure.adapters.dreamy.client.dreamy_api_request", side_effect=fake_dreamy_request),
            self.client.stream(
                "POST",
                "/api/studio/run",
                data={
                    "message": "generate a neon cyberpunk video clip",
                    "action": "extend",
                    "page_id": "dreamy-miniapp",
                },
            ) as response,
        ):
            self.assertEqual(response.status_code, 200)
            events = _sse_events("".join(response.iter_text()))

        execution = next(payload for name, payload in events if name == "execution_request")
        self.assertEqual(execution["executor"], "server")
        self.assertEqual(execution["authStatus"]["status"], "ready")

        final_job = [payload["job"] for name, payload in events if name == "job"][-1]
        self.assertEqual(final_job["status"], "done")
        self.assertEqual(final_job["taskId"], "dreamy_job_123")
        self.assertEqual(final_job["mediaUrl"], "https://cdn.example.test/generated.mp4")
        self.assertTrue(final_job["evidence"]["accepted"])
        self.assertEqual(final_job["evidence"]["source"], "dreamy-miniapp")

        project = next(payload["project"] for name, payload in events if name == "project")
        self.assertEqual(project["segments"][0]["status"], "done")
        self.assertEqual(project["segments"][0]["url"], "https://cdn.example.test/generated.mp4")
        self.assertEqual(project["segments"][0]["posterUrl"], "https://cdn.example.test/generated-poster.jpg")
        self.assertEqual(calls[0][0], "/v1/telegram/miniapp/dreamy/get-by-slug")
        self.assertEqual(calls[1][0], "/v1/telegram/miniapp/dreamy/generate")
        self.assertEqual(calls[2][0], "/v1/telegram/miniapp/dreamy/generate/result")
        self.assertEqual(calls[1][1]["input_img"], ["generate a neon cyberpunk video clip"])

    def test_poll_dreamy_server_job_accepts_later_media_result(self) -> None:

        result_payloads = [
            {
                "tasks": [
                    {
                        "status": "running",
                        "jobId": "dreamy_job_later",
                        "result": json.dumps({}),
                    }
                ]
            },
            {
                "tasks": [
                    {
                        "status": "done",
                        "jobId": "dreamy_job_later",
                        "result": json.dumps(
                            {
                                "outputImg": "https://cdn.example.test/later.mp4",
                                "outputPreview": "https://cdn.example.test/later-poster.jpg",
                            }
                        ),
                    }
                ]
            },
        ]
        result_calls: list[dict] = []

        async def fake_dreamy_request(endpoint: str, body: dict, init_data: str) -> dict:
            self.assertEqual(init_data, "query_id=server-auth")
            if endpoint.endswith("/get-by-slug"):
                return {"info": {"botId": "bot_neon_art", "slugId": "neon-art-generator"}}
            if endpoint.endswith("/generate"):
                return {"outputJobId": "dreamy_job_later", "queuePosition": 0}
            if endpoint.endswith("/generate/result"):
                result_calls.append(body)
                return result_payloads.pop(0)
            raise AssertionError(endpoint)

        with (
            patch.dict(
                os.environ,
                {
                    "DREAMY_TELEGRAM_INIT_DATA": "query_id=server-auth",
                    "DREAMY_SERVER_POLL_ATTEMPTS": "1",
                    "DREAMY_SERVER_POLL_INTERVAL_SECONDS": "0",
                },
                clear=False,
            ),
            patch("studio_app.infrastructure.adapters.dreamy.client.dreamy_api_request", side_effect=fake_dreamy_request),
            self.client.stream(
                "POST",
                "/api/studio/run",
                data={
                    "message": "generate a slow neon clip",
                    "action": "extend",
                    "page_id": "dreamy-miniapp",
                },
            ) as response,
        ):
            self.assertEqual(response.status_code, 200)
            events = _sse_events("".join(response.iter_text()))

            initial_job = [payload["job"] for name, payload in events if name == "job"][-1]
            self.assertEqual(initial_job["status"], "running")
            self.assertEqual(initial_job["taskId"], "dreamy_job_later")

            polled = self.client.post(f"/api/studio/jobs/{initial_job['jobId']}/poll")

        self.assertEqual(polled.status_code, 200)
        body = polled.json()
        self.assertEqual(body["job"]["status"], "done")
        self.assertEqual(body["job"]["mediaUrl"], "https://cdn.example.test/later.mp4")
        self.assertTrue(body["job"]["evidence"]["accepted"])
        self.assertEqual(body["project"]["segments"][0]["status"], "done")
        self.assertEqual(body["project"]["segments"][0]["url"], "https://cdn.example.test/later.mp4")
        self.assertEqual(result_calls, [{"output_job_id": "dreamy_job_later"}, {"output_job_id": "dreamy_job_later"}])

    def test_poll_dreamy_server_job_reports_auth_missing_without_init_data(self) -> None:
        with self.client.stream(
            "POST",
            "/api/studio/run",
            data={"message": "queue client dreamy segment", "action": "generate"},
        ) as response:
            events = _sse_events("".join(response.iter_text()))

        meta = next(payload for name, payload in events if name == "meta")
        execution = next(payload for name, payload in events if name == "execution_request")
        updated = self.client.post(
            f"/api/studio/projects/{meta['projectId']}/client-result",
            json={
                "segmentId": execution["segmentId"],
                "jobId": execution["jobId"],
                "status": "running",
                "taskId": "dreamy_client_task",
                "type": "image",
                "source": "dreamy-miniapp",
            },
        )
        self.assertEqual(updated.status_code, 200)

        with patch.dict(os.environ, {"DREAMY_TELEGRAM_INIT_DATA": ""}, clear=False):
            polled = self.client.post(f"/api/studio/jobs/{execution['jobId']}/poll")

        self.assertEqual(polled.status_code, 200)
        body = polled.json()
        self.assertEqual(body["job"]["status"], "auth_missing")
        self.assertEqual(body["job"]["evidence"]["source"], "dreamy-miniapp")
        self.assertIn("DREAMY_TELEGRAM_INIT_DATA", body["job"]["evidence"]["message"])
        self.assertEqual(body["project"]["segments"][0]["status"], "auth_missing")

    def test_health_reports_cookie_injection_result_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            status_path = Path(tmp_dir) / "cookie-injection-status.json"
            status_path.write_text(
                json.dumps(
                    {
                        "status": "failed",
                        "checkedAt": "2026-06-02T00:00:00Z",
                        "cookieCount": 2,
                        "message": "CDP Network.setCookie failed",
                    }
                ),
                encoding="utf-8",
            )
            with patch.dict(
                os.environ,
                {
                    "MYSHELL_COOKIES": json.dumps(
                        [
                            {"name": "token", "value": "redacted", "domain": ".myshell.ai"},
                            {"name": "session", "value": "redacted", "domain": ".myshell.ai"},
                        ]
                    ),
                    "MYSHELL_COOKIE_INJECTION_STATUS_PATH": str(status_path),
                },
            ):
                health = self.client.get("/api/health")

        self.assertEqual(health.status_code, 200)
        body = health.json()
        self.assertEqual(body["status"], "degraded")
        cookie_injection = body["components"]["cookieInjection"]
        self.assertEqual(cookie_injection["status"], "error")
        self.assertEqual(cookie_injection["cookieCount"], 2)
        self.assertEqual(cookie_injection["statusPath"], str(status_path))
        self.assertIn("Network.setCookie", cookie_injection["message"])

    def test_health_reports_invalid_cookie_source_as_error(self) -> None:
        with patch.dict(os.environ, {"MYSHELL_COOKIES": "{not-json"}):
            health = self.client.get("/api/health")
            pages = self.client.get("/api/pages")

        self.assertEqual(health.status_code, 200)
        components = health.json()["components"]
        self.assertEqual(components["myshellCookies"]["status"], "error")
        self.assertIn("valid JSON", components["myshellCookies"]["message"])
        self.assertEqual(components["cookieInjection"]["status"], "error")
        self.assertIn("valid JSON", components["cookieInjection"]["message"])

        page_by_id = {page["id"]: page for page in pages.json()["pages"]}
        art_auth = page_by_id["myshell-art"]["authStatus"]
        self.assertEqual(art_auth["status"], "auth_missing")
        self.assertEqual(art_auth["injectionStatus"], "error")

    def test_health_reports_invalid_cookie_shape_as_error(self) -> None:
        with patch.dict(os.environ, {"MYSHELL_COOKIES": json.dumps([{"value": "redacted"}])}):
            health = self.client.get("/api/health")
            pages = self.client.get("/api/pages")

        self.assertEqual(health.status_code, 200)
        components = health.json()["components"]
        self.assertEqual(components["myshellCookies"]["status"], "error")
        self.assertIn("name and value", components["myshellCookies"]["message"])
        self.assertEqual(components["cookieInjection"]["status"], "error")
        self.assertIn("name and value", components["cookieInjection"]["message"])

        page_by_id = {page["id"]: page for page in pages.json()["pages"]}
        art_auth = page_by_id["myshell-art"]["authStatus"]
        self.assertEqual(art_auth["status"], "auth_missing")
        self.assertEqual(art_auth["injectionStatus"], "error")

    def test_health_accepts_myshell_cookies_file_without_exposing_path(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            cookies_path = Path(tmp_dir) / "myshell-cookies.json"
            cookies_path.write_text(
                json.dumps([{"name": "ms_token", "value": "redacted", "domain": ".myshell.ai"}]),
                encoding="utf-8",
            )

            with patch.dict(
                os.environ,
                {"MYSHELL_COOKIES": "", "MYSHELL_COOKIES_FILE": str(cookies_path)},
                clear=False,
            ):
                health = self.client.get("/api/health")

        self.assertEqual(health.status_code, 200)
        myshell_cookies = health.json()["components"]["myshellCookies"]
        self.assertEqual(myshell_cookies["status"], "ready")
        self.assertEqual(myshell_cookies["mode"], "file-env")
        self.assertEqual(myshell_cookies["source"], "MYSHELL_COOKIES_FILE")
        self.assertNotIn(str(cookies_path), json.dumps(myshell_cookies))

    def test_health_reports_missing_myshell_art_ms_token_cookie(self) -> None:
        with patch.dict(
            os.environ,
            {
                "MYSHELL_COOKIES": json.dumps(
                    [
                        {"name": "privy-token", "value": "redacted", "domain": ".myshell.ai"},
                        {"name": "privy-session", "value": "redacted", "domain": ".myshell.ai"},
                    ]
                )
            },
        ):
            health = self.client.get("/api/health")

        self.assertEqual(health.status_code, 200)
        myshell_cookies = health.json()["components"]["myshellCookies"]
        self.assertEqual(myshell_cookies["status"], "ready")
        self.assertEqual(myshell_cookies["artApiAuthCookieStatus"], "missing")
        self.assertIn("ms_token", myshell_cookies["missingCookieNames"])
        self.assertIn("ms_token", myshell_cookies["message"])

    def test_health_degrades_when_myshell_cookie_auth_is_missing(self) -> None:
        from studio_app.infrastructure.runtime import health as studio_runtime

        async def fake_chrome_cdp_ready() -> bool:
            return True

        with (
            tempfile.TemporaryDirectory() as tmp_dir,
            patch.object(studio_runtime, "chrome_cdp_ready", side_effect=fake_chrome_cdp_ready),
            patch.object(
                studio_runtime,
                "cookie_source_status",
                return_value={
                    "status": "auth_missing",
                    "mode": "env-or-file",
                    "message": "No MyShell cookies configured",
                },
            ),
        ):
            health = asyncio.run(studio_runtime.runtime_health(str(Path(tmp_dir) / "store.sqlite3")))

        self.assertEqual(health["status"], "degraded")
        self.assertEqual(health["components"]["chromeCdp"]["status"], "ok")
        self.assertEqual(health["components"]["myshellCookies"]["status"], "auth_missing")
        self.assertEqual(health["components"]["cookieInjection"]["status"], "auth_missing")

    def test_runtime_health_reads_configured_cdp_url_at_call_time(self) -> None:
        from studio_app.infrastructure.runtime import health as studio_runtime

        captured_urls: list[str] = []

        class FakeResponse:
            status_code = 200

        class FakeAsyncClient:
            def __init__(self, timeout: float) -> None:
                self.timeout = timeout

            async def __aenter__(self) -> "FakeAsyncClient":
                return self

            async def __aexit__(self, exc_type, exc, tb) -> None:
                return None

            async def get(self, url: str) -> FakeResponse:
                captured_urls.append(url)
                return FakeResponse()

        with (
            patch.object(studio_runtime.httpx, "AsyncClient", FakeAsyncClient),
            patch.dict(os.environ, {"MYSHELL_CDP_URL": "http://127.0.0.1:9333/"}),
        ):
            health = asyncio.run(studio_runtime.runtime_health("/tmp/myshell-studio-runtime/store.sqlite3"))

        self.assertEqual(captured_urls, ["http://127.0.0.1:9333/json"])
        self.assertEqual(health["components"]["chromeCdp"]["url"], "http://127.0.0.1:9333")

    def test_cdp_url_helpers_fallback_and_strip_trailing_slash(self) -> None:
        import bridge_worker
        import inject_cookies
        from studio_app.infrastructure.runtime import health as studio_runtime

        with patch.dict(os.environ, {"MYSHELL_CDP_URL": ""}):
            self.assertEqual(studio_runtime.cdp_url(), "http://127.0.0.1:9222")
            self.assertEqual(inject_cookies._cdp_url(), "http://127.0.0.1:9222")
            self.assertEqual(bridge_worker._cdp_url(), "http://127.0.0.1:9222")

        with patch.dict(os.environ, {"MYSHELL_CDP_URL": "http://cdp.internal:9333/"}):
            self.assertEqual(studio_runtime.cdp_url(), "http://cdp.internal:9333")
            self.assertEqual(inject_cookies._cdp_url(), "http://cdp.internal:9333")
            self.assertEqual(bridge_worker._cdp_url(), "http://cdp.internal:9333")

    def test_bridge_worker_classifies_cloudflare_captcha(self) -> None:
        import bridge_worker

        blocker = bridge_worker._page_blocker_state(
            current_url="https://art.myshell.ai/cf-captcha?originHref=https://art.myshell.ai/creative/brat-generator",
            body_text="Checking if the site connection is secure",
        )

        self.assertEqual(blocker["status"], "captcha_required")
        self.assertIn("Cloudflare", blocker["message"])

    def test_myshell_art_auth_requires_successful_cookie_injection(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            status_path = Path(tmp_dir) / "cookie-injection-status.json"
            status_path.write_text(
                json.dumps(
                    {
                        "status": "failed",
                        "checkedAt": "2026-06-02T00:00:00Z",
                        "cookieCount": 1,
                        "message": "Cookie injection did not reveal a logged-in energy display",
                    }
                ),
                encoding="utf-8",
            )
            with patch.dict(
                os.environ,
                {
                    "MYSHELL_COOKIES": json.dumps(
                        [{"name": "token", "value": "redacted", "domain": ".myshell.ai"}]
                    ),
                    "MYSHELL_COOKIE_INJECTION_STATUS_PATH": str(status_path),
                },
            ):
                pages = self.client.get("/api/pages")

        self.assertEqual(pages.status_code, 200)
        page_by_id = {page["id"]: page for page in pages.json()["pages"]}
        art = page_by_id["myshell-art"]
        self.assertEqual(art["authStatus"]["status"], "auth_missing")
        self.assertEqual(art["authStatus"]["injectionStatus"], "error")
        self.assertFalse(art["dispatchReady"])
        self.assertEqual(art["dispatchStatus"], "auth_missing")

    def test_myshell_art_auth_reports_captcha_required_after_cookie_injection(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            status_path = Path(tmp_dir) / "cookie-injection-status.json"
            status_path.write_text(
                json.dumps(
                    {
                        "status": "captcha_required",
                        "checkedAt": "2026-06-02T00:00:00Z",
                        "cookieCount": 1,
                        "message": "Cloudflare captcha challenge blocked the headless browser",
                        "currentUrl": "https://art.myshell.ai/cf-captcha?originHref=https://art.myshell.ai/",
                    }
                ),
                encoding="utf-8",
            )
            with patch.dict(
                os.environ,
                {
                    "MYSHELL_COOKIES": json.dumps(
                        [{"name": "token", "value": "redacted", "domain": ".myshell.ai"}]
                    ),
                    "MYSHELL_COOKIE_INJECTION_STATUS_PATH": str(status_path),
                },
            ):
                health = self.client.get("/api/health")
                pages = self.client.get("/api/pages")

        self.assertEqual(health.status_code, 200)
        cookie_injection = health.json()["components"]["cookieInjection"]
        self.assertEqual(cookie_injection["status"], "captcha_required")
        self.assertIn("Cloudflare", cookie_injection["message"])
        self.assertIn("cf-captcha", cookie_injection["currentUrl"])

        page_by_id = {page["id"]: page for page in pages.json()["pages"]}
        art = page_by_id["myshell-art"]
        self.assertEqual(art["authStatus"]["status"], "auth_missing")
        self.assertEqual(art["authStatus"]["injectionStatus"], "captcha_required")
        self.assertFalse(art["dispatchReady"])

    def test_myshell_art_auth_requires_live_chrome_cdp_after_cookie_injection_success(self) -> None:
        from studio_app.infrastructure.runtime import health as studio_runtime

        requested_urls: list[str] = []

        class FakeResponse:
            status_code = 503

        class FakeClient:
            def __init__(self, timeout: float) -> None:
                self.timeout = timeout

            def __enter__(self) -> "FakeClient":
                return self

            def __exit__(self, exc_type, exc, tb) -> None:
                return None

            def get(self, url: str) -> FakeResponse:
                requested_urls.append(url)
                return FakeResponse()

        with tempfile.TemporaryDirectory() as tmp_dir:
            status_path = Path(tmp_dir) / "cookie-injection-status.json"
            status_path.write_text(
                json.dumps(
                    {
                        "status": "success",
                        "checkedAt": "2026-06-02T00:00:00Z",
                        "cookieCount": 1,
                        "message": "Cookie injection succeeded",
                    }
                ),
                encoding="utf-8",
            )
            with (
                patch.dict(
                    os.environ,
                    {
                        "MYSHELL_COOKIES": json.dumps(
                            [{"name": "token", "value": "redacted", "domain": ".myshell.ai"}]
                        ),
                        "MYSHELL_COOKIE_INJECTION_STATUS_PATH": str(status_path),
                        "MYSHELL_CDP_URL": "http://cdp.internal:9333/",
                    },
                ),
                patch.object(studio_runtime.httpx, "Client", FakeClient),
            ):
                pages = self.client.get("/api/pages")

        self.assertEqual(requested_urls, ["http://cdp.internal:9333/json"])
        self.assertEqual(pages.status_code, 200)
        page_by_id = {page["id"]: page for page in pages.json()["pages"]}
        art = page_by_id["myshell-art"]
        self.assertEqual(art["authStatus"]["status"], "auth_missing")
        self.assertEqual(art["authStatus"]["injectionStatus"], "ready")
        self.assertEqual(art["authStatus"]["cdpStatus"], "unavailable")
        self.assertIn("Chrome CDP", art["authStatus"]["message"])
        self.assertFalse(art["dispatchReady"])
        self.assertEqual(art["dispatchStatus"], "auth_missing")

    def test_myshell_art_run_evidence_reports_cookie_injection_failure(self) -> None:
        failure_message = "Cookie injection did not reveal a logged-in energy display"
        with tempfile.TemporaryDirectory() as tmp_dir:
            status_path = Path(tmp_dir) / "cookie-injection-status.json"
            status_path.write_text(
                json.dumps(
                    {
                        "status": "failed",
                        "checkedAt": "2026-06-02T00:00:00Z",
                        "cookieCount": 1,
                        "message": failure_message,
                    }
                ),
                encoding="utf-8",
            )
            with patch.dict(
                os.environ,
                {
                    "MYSHELL_COOKIES": json.dumps(
                        [{"name": "token", "value": "redacted", "domain": ".myshell.ai"}]
                    ),
                    "MYSHELL_COOKIE_INJECTION_STATUS_PATH": str(status_path),
                },
            ):
                with self.client.stream(
                    "POST",
                    "/api/studio/run",
                    data={
                        "message": "draw a cinematic neon city",
                        "page_id": "myshell-art",
                        "action": "generate",
                    },
                ) as response:
                    self.assertEqual(response.status_code, 200)
                    events = _sse_events("".join(response.iter_text()))

        final_job = [payload["job"] for name, payload in events if name == "job"][-1]
        self.assertEqual(final_job["status"], "auth_missing")
        self.assertEqual(final_job["authStatus"]["injectionStatus"], "error")
        self.assertIn(failure_message, final_job["evidence"]["message"])
        self.assertNotIn("cookies are missing", final_job["evidence"]["message"].lower())

    def test_cookie_injection_uses_configured_cdp_url(self) -> None:
        import inject_cookies

        requested_urls: list[str] = []

        class FakeClient:
            def get(self, url: str, timeout: int) -> object:
                requested_urls.append(url)
                raise RuntimeError("CDP unavailable")

        with (
            patch.dict(os.environ, {"MYSHELL_CDP_URL": "http://cdp.internal:9333"}),
            patch.object(
                inject_cookies,
                "_load_cookies",
                return_value=[{"name": "token", "value": "redacted", "domain": ".myshell.ai"}],
            ),
            patch.object(inject_cookies.httpx, "Client", return_value=FakeClient()),
            patch.object(inject_cookies.time, "sleep"),
            patch.object(inject_cookies, "_write_status"),
        ):
            result = asyncio.run(inject_cookies.inject_cookies())

        self.assertFalse(result)
        self.assertTrue(requested_urls)
        self.assertEqual(requested_urls[0], "http://cdp.internal:9333/json")

    def test_cookie_injection_loads_cookies_from_file_env(self) -> None:
        import inject_cookies

        with tempfile.TemporaryDirectory() as tmp_dir:
            cookies_path = Path(tmp_dir) / "myshell-cookies.json"
            cookies_path.write_text(
                json.dumps([{"name": "ms_token", "value": "redacted", "domain": ".myshell.ai"}]),
                encoding="utf-8",
            )

            with patch.dict(os.environ, {"MYSHELL_COOKIES": "", "MYSHELL_COOKIES_FILE": str(cookies_path)}, clear=False):
                cookies = inject_cookies._load_cookies()

        self.assertEqual(cookies, [{"name": "ms_token", "value": "redacted", "domain": ".myshell.ai"}])

    def test_cookie_injection_classifies_cloudflare_captcha(self) -> None:
        import inject_cookies

        state = inject_cookies._classify_post_injection_state(
            current_url="https://art.myshell.ai/cf-captcha?originHref=https://art.myshell.ai/",
            body_text="Checking if the site connection is secure",
            energy_display="not found",
            is_login=False,
        )

        self.assertEqual(state["status"], "captcha_required")
        self.assertIn("headless browser", state["message"])

    def test_cookie_injection_accepts_global_login_flag(self) -> None:
        import inject_cookies

        state = inject_cookies._classify_post_injection_state(
            current_url="https://art.myshell.ai/",
            body_text="MyShell Art",
            energy_display="not found",
            is_login=True,
        )

        self.assertEqual(state["status"], "success")
        self.assertEqual(state["loginDetected"], True)

    def test_cookie_injection_prefers_art_page_over_extension_target(self) -> None:
        import inject_cookies

        selected = inject_cookies._select_cdp_page(
            [
                {"type": "background_page", "url": "chrome-extension://abc/background.html", "webSocketDebuggerUrl": "ws://extension"},
                {"type": "page", "url": "https://art.myshell.ai/", "webSocketDebuggerUrl": "ws://art"},
                {"type": "page", "url": "https://example.com/", "webSocketDebuggerUrl": "ws://example"},
            ]
        )

        self.assertEqual(selected["webSocketDebuggerUrl"], "ws://art")

    def test_cookie_injection_reports_invalid_cookie_source_without_throwing(self) -> None:
        import inject_cookies

        with tempfile.TemporaryDirectory() as tmp_dir:
            status_path = Path(tmp_dir) / "cookie-injection-status.json"
            with (
                patch.dict(os.environ, {"MYSHELL_COOKIES": "{not-json"}),
                patch.object(inject_cookies, "STATUS_PATH", str(status_path)),
            ):
                result = asyncio.run(inject_cookies.inject_cookies())

            self.assertFalse(result)
            payload = json.loads(status_path.read_text(encoding="utf-8"))

        self.assertEqual(payload["status"], "failed")
        self.assertEqual(payload["cookieCount"], 0)
        self.assertIn("valid JSON", payload["message"])
        self.assertIn("MYSHELL_COOKIES", payload["message"])

    def test_cookie_injection_status_writer_accepts_bare_filename(self) -> None:
        import inject_cookies

        with tempfile.TemporaryDirectory() as tmp_dir:
            previous_cwd = os.getcwd()
            os.chdir(tmp_dir)
            try:
                with patch.object(inject_cookies, "STATUS_PATH", "cookie-injection-status.json"):
                    inject_cookies._write_status("failed", "CDP unavailable", 0)
                payload = json.loads(Path("cookie-injection-status.json").read_text(encoding="utf-8"))
            finally:
                os.chdir(previous_cwd)

        self.assertEqual(payload["status"], "failed")
        self.assertEqual(payload["message"], "CDP unavailable")

    def test_cookie_injection_cli_returns_nonzero_on_failure(self) -> None:
        import inject_cookies

        async def fake_inject_cookies() -> bool:
            return False

        with patch.object(inject_cookies, "inject_cookies", side_effect=fake_inject_cookies):
            exit_code = inject_cookies.main()

        self.assertEqual(exit_code, 1)

    def test_cookie_injection_cli_returns_zero_on_success(self) -> None:
        import inject_cookies

        async def fake_inject_cookies() -> bool:
            return True

        with patch.object(inject_cookies, "inject_cookies", side_effect=fake_inject_cookies):
            exit_code = inject_cookies.main()

        self.assertEqual(exit_code, 0)

    def test_bridge_worker_uses_configured_cdp_url(self) -> None:
        import bridge_worker

        requested_urls: list[str] = []

        class FakeResponse:
            def json(self) -> list[dict]:
                return []

        class FakeAsyncClient:
            async def get(self, url: str) -> FakeResponse:
                requested_urls.append(url)
                return FakeResponse()

        with (
            patch.dict(os.environ, {"MYSHELL_CDP_URL": "http://cdp.internal:9333"}),
            patch.object(bridge_worker.httpx, "AsyncClient", return_value=FakeAsyncClient()),
        ):
            result = asyncio.run(bridge_worker.generate("seedream-multi-chart", "Generate", ""))

        self.assertTrue(requested_urls)
        self.assertEqual(requested_urls[0], "http://cdp.internal:9333/json")
        self.assertEqual(result["status"], "error")
        self.assertIn("no inspectable pages", result["message"])
        self.assertIn("http://cdp.internal:9333", result["message"])

    def test_myshell_bridge_passes_prompt_to_worker_args(self) -> None:
        import myshell_bridge

        captured_payload: dict = {}
        captured_command: list[str] = []

        class FakeStdout:
            def __init__(self) -> None:
                self.lines = [
                    b'{"status":"done","output_url":"https://example.com/fresh.png"}\n',
                    b"",
                ]

            async def readline(self) -> bytes:
                return self.lines.pop(0)

        class FakeStderr:
            async def read(self) -> bytes:
                return b""

        class FakeProcess:
            def __init__(self) -> None:
                self.stdout = FakeStdout()
                self.stderr = FakeStderr()

            def kill(self) -> None:
                return None

            async def wait(self) -> int:
                return 0

        async def fake_create_subprocess_exec(*args, **kwargs) -> FakeProcess:
            captured_command.extend(str(arg) for arg in args)
            captured_payload.update(json.loads(Path(args[2]).read_text(encoding="utf-8")))
            return FakeProcess()

        with patch.object(myshell_bridge.asyncio, "create_subprocess_exec", fake_create_subprocess_exec):
            result = asyncio.run(
                myshell_bridge.generate_via_bot(
                    "seedream-multi-chart",
                    prompt="cinematic red lantern city",
                    gen_button="Generate",
                    image_data="",
                )
            )

        self.assertEqual(result["status"], "done")
        self.assertEqual(captured_command[0], sys.executable)
        self.assertEqual(captured_payload["prompt"], "cinematic red lantern city")

    def test_bridge_worker_fills_prompt_textarea_before_generate(self) -> None:
        import bridge_worker

        eval_expressions: list[str] = []

        class FakeResponse:
            def json(self) -> list[dict]:
                return [{"url": "https://art.myshell.ai", "webSocketDebuggerUrl": "ws://fake"}]

        class FakeAsyncClient:
            async def get(self, url: str) -> FakeResponse:
                return FakeResponse()

        class FakeWebSocket:
            def __init__(self) -> None:
                self.last_message: dict = {}

            async def send(self, message: str) -> None:
                self.last_message = json.loads(message)

            async def recv(self) -> str:
                message_id = self.last_message["id"]
                method = self.last_message["method"]
                if method == "Runtime.evaluate":
                    expression = self.last_message.get("params", {}).get("expression", "")
                    eval_expressions.append(expression)
                    if "btns.find" in expression:
                        value = "no"
                    elif "querySelectorAll('img')" in expression:
                        value = "[]"
                    elif "textarea" in expression and "cinematic red lantern city" in expression:
                        value = "filled"
                    else:
                        value = ""
                    return json.dumps({"id": message_id, "result": {"result": {"value": value}}})
                return json.dumps({"id": message_id, "result": {}})

        class FakeConnect:
            async def __aenter__(self) -> FakeWebSocket:
                return FakeWebSocket()

            async def __aexit__(self, exc_type, exc, tb) -> None:
                return None

        async def fake_sleep(_seconds: float) -> None:
            return None

        with (
            patch.object(bridge_worker.httpx, "AsyncClient", return_value=FakeAsyncClient()),
            patch.object(bridge_worker.websockets, "connect", lambda *args, **kwargs: FakeConnect()),
            patch.object(bridge_worker.asyncio, "sleep", fake_sleep),
        ):
            result = asyncio.run(
                bridge_worker.generate(
                    "seedream-multi-chart",
                    "Generate",
                    "",
                    "cinematic red lantern city",
                )
            )

        self.assertEqual(result["status"], "error")
        self.assertTrue(
            any("cinematic red lantern city" in expression and "textarea" in expression for expression in eval_expressions)
        )

    def test_bridge_worker_clicks_fallback_generate_when_button_label_missing(self) -> None:
        import bridge_worker

        eval_expressions: list[str] = []

        class FakeResponse:
            def json(self) -> list[dict]:
                return [{"url": "https://art.myshell.ai", "webSocketDebuggerUrl": "ws://fake"}]

        class FakeAsyncClient:
            async def get(self, url: str) -> FakeResponse:
                return FakeResponse()

        class FakeWebSocket:
            def __init__(self) -> None:
                self.last_message: dict = {}

            async def send(self, message: str) -> None:
                self.last_message = json.loads(message)

            async def recv(self) -> str:
                message_id = self.last_message["id"]
                method = self.last_message["method"]
                if method == "Runtime.evaluate":
                    expression = self.last_message.get("params", {}).get("expression", "")
                    eval_expressions.append(expression)
                    if "generate|create|start" in expression:
                        value = "fb"
                    elif "Your image is ready" in expression:
                        value = json.dumps({"pct": None, "cancel": False, "ready": True})
                    elif "querySelectorAll('img')" in expression:
                        value = "[]"
                    else:
                        value = ""
                    return json.dumps({"id": message_id, "result": {"result": {"value": value}}})
                return json.dumps({"id": message_id, "result": {}})

        class FakeConnect:
            async def __aenter__(self) -> FakeWebSocket:
                return FakeWebSocket()

            async def __aexit__(self, exc_type, exc, tb) -> None:
                return None

        async def fake_sleep(_seconds: float) -> None:
            return None

        with (
            patch.object(bridge_worker.httpx, "AsyncClient", return_value=FakeAsyncClient()),
            patch.object(bridge_worker.websockets, "connect", lambda *args, **kwargs: FakeConnect()),
            patch.object(bridge_worker.asyncio, "sleep", fake_sleep),
        ):
            result = asyncio.run(bridge_worker.generate("seedream-multi-chart", "", "", "cinematic skyline"))

        self.assertEqual(result["status"], "error")
        self.assertTrue(any("generate|create|start" in expression for expression in eval_expressions))

    def test_bridge_worker_rejects_stale_art_media_after_generation(self) -> None:
        import bridge_worker

        old_url = "https://www.myshellstatic.com/image/chat/embed_obj_old.png"
        image_reads = 0

        class FakeResponse:
            def json(self) -> list[dict]:
                return [{"url": "https://art.myshell.ai", "webSocketDebuggerUrl": "ws://fake"}]

        class FakeAsyncClient:
            async def get(self, url: str) -> FakeResponse:
                return FakeResponse()

        class FakeWebSocket:
            def __init__(self) -> None:
                self.last_message: dict = {}

            async def send(self, message: str) -> None:
                self.last_message = json.loads(message)

            async def recv(self) -> str:
                nonlocal image_reads
                message_id = self.last_message["id"]
                method = self.last_message["method"]
                if method == "Runtime.evaluate":
                    expression = self.last_message.get("params", {}).get("expression", "")
                    if "generate|create|start" in expression:
                        value = "fb"
                    elif "Your image is ready" in expression:
                        value = json.dumps({"pct": None, "cancel": False, "ready": True})
                    elif "querySelectorAll('img')" in expression:
                        image_reads += 1
                        value = json.dumps([old_url])
                    else:
                        value = ""
                    return json.dumps({"id": message_id, "result": {"result": {"value": value}}})
                return json.dumps({"id": message_id, "result": {}})

        class FakeConnect:
            async def __aenter__(self) -> FakeWebSocket:
                return FakeWebSocket()

            async def __aexit__(self, exc_type, exc, tb) -> None:
                return None

        async def fake_sleep(_seconds: float) -> None:
            return None

        with (
            patch.object(bridge_worker.httpx, "AsyncClient", return_value=FakeAsyncClient()),
            patch.object(bridge_worker.websockets, "connect", lambda *args, **kwargs: FakeConnect()),
            patch.object(bridge_worker.asyncio, "sleep", fake_sleep),
        ):
            result = asyncio.run(bridge_worker.generate("seedream-multi-chart", "", "", "cinematic skyline"))

        self.assertGreaterEqual(image_reads, 2)
        self.assertEqual(result["status"], "error")
        self.assertNotEqual(result.get("output_url"), old_url)
        self.assertIn("fresh", result["message"].lower())

    def test_studio_readiness_reports_delivery_gates(self) -> None:
        readiness = self.client.get("/api/studio/readiness")

        self.assertEqual(readiness.status_code, 200)
        self.assertEqual(readiness.headers.get("content-type", "").split(";")[0], "application/json")
        body = readiness.json()
        self.assertIn(body["status"], {"ready", "degraded"})
        self.assertIn("checkedAt", body)
        self.assertEqual(body["summary"]["total"], len(body["gates"]))

        gates = {gate["id"]: gate for gate in body["gates"]}
        expected_gate_ids = {
            "backend",
            "storage",
            "page-registry",
            "agent-registry",
            "dispatch-preview",
            "overview",
            "myshell-art-auth",
            "job-store",
        }
        self.assertTrue(expected_gate_ids.issubset(gates.keys()))

        self.assertEqual(gates["backend"]["status"], "ready")
        self.assertTrue(gates["backend"]["required"])
        self.assertEqual(gates["storage"]["status"], "ready")
        self.assertGreaterEqual(gates["page-registry"]["evidence"]["pageCount"], 13)
        self.assertEqual(gates["page-registry"]["evidence"]["missingPageIds"], [])
        route_coverage = gates["page-registry"]["evidence"]["routeCoverage"]
        self.assertEqual(route_coverage["status"], "covered")
        self.assertEqual(route_coverage["missingAppRoutes"], [])
        self.assertEqual(route_coverage["extraRegistryRoutes"], [])
        self.assertIn("/dreamy", route_coverage["coveredRoutes"])
        self.assertIn("/library/:id", route_coverage["coveredRoutes"])
        self.assertIn("/", route_coverage["ignoredAppRoutes"])
        self.assertIn("/__test-customize-scene", route_coverage["ignoredAppRoutes"])
        self.assertGreaterEqual(gates["agent-registry"]["evidence"]["agentCount"], 7)
        self.assertEqual(gates["agent-registry"]["evidence"]["missingAgentIds"], [])
        self.assertEqual(gates["dispatch-preview"]["status"], "ready")
        self.assertEqual(gates["dispatch-preview"]["evidence"]["navigationPath"], "/library")
        self.assertEqual(gates["overview"]["status"], "ready")
        self.assertIn(gates["myshell-art-auth"]["status"], {"ready", "auth_missing"})
        self.assertFalse(gates["myshell-art-auth"]["required"])
        self.assertEqual(gates["job-store"]["status"], "ready")

    def test_studio_readiness_keeps_page_registry_ready_without_frontend_source(self) -> None:
        with patch.dict(os.environ, {"STUDIO_FRONTEND_APP_ROUTES_FILE": "/tmp/missing-myshell-app-routes.tsx"}):
            readiness = self.client.get("/api/studio/readiness")

        self.assertEqual(readiness.status_code, 200)
        gates = {gate["id"]: gate for gate in readiness.json()["gates"]}
        self.assertEqual(gates["page-registry"]["status"], "ready")
        route_coverage = gates["page-registry"]["evidence"]["routeCoverage"]
        self.assertEqual(route_coverage["status"], "source_unavailable")
        self.assertEqual(route_coverage["missingAppRoutes"], [])
        self.assertEqual(route_coverage["extraRegistryRoutes"], [])

    def test_frontend_route_source_path_handles_cloud_run_backend_layout(self) -> None:
        from studio_app.application.policies import dispatch

        source_path = dispatch.default_frontend_app_routes_file_for_backend(Path("/app/main.py"))

        self.assertEqual(source_path, Path("/app/frontend/src/App.tsx"))

    def test_cloud_run_image_keeps_frontend_route_source_for_readiness(self) -> None:
        dockerfile = BACKEND_DIR.parent / "Dockerfile"
        content = dockerfile.read_text(encoding="utf-8")

        self.assertIn("/app/frontend/src/App.tsx", content)
        self.assertIn("COPY --from=frontend-build /repo/apps/myshell-studio-orchestrator/frontend/src/App.tsx", content)

    def test_cloud_run_image_builds_coupled_frontend_from_workspace_root(self) -> None:
        dockerfile = BACKEND_DIR.parent / "Dockerfile"
        content = dockerfile.read_text(encoding="utf-8")

        self.assertIn("COPY apps/creative-canvas/src/", content)
        self.assertIn("COPY apps/myshell-studio-orchestrator/scripts/prepare-canvaspro-static.sh", content)
        self.assertIn("npm run build --prefix apps/myshell-studio-orchestrator/frontend", content)
        self.assertIn("COPY apps/myshell-studio-orchestrator/orchestrator/backend/requirements.lock", content)
        self.assertIn("pip install --no-cache-dir --require-hashes -r requirements.lock", content)
        self.assertNotIn("pip install --no-cache-dir -r requirements.txt", content)
        self.assertNotIn("COPY orchestrator/", content)

    def test_backend_runtime_package_survives_repository_ignore_rules(self) -> None:
        repo_root = BACKEND_DIR.parents[3]
        runtime_path = "apps/myshell-studio-orchestrator/orchestrator/backend/studio_app/infrastructure/runtime"
        gitignore = (repo_root / ".gitignore").read_text(encoding="utf-8")
        dockerignore = (repo_root / ".dockerignore").read_text(encoding="utf-8")

        self.assertIn(f"!{runtime_path}/", gitignore)
        self.assertIn(f"!{runtime_path}/**", dockerignore)
        for filename in ("__init__.py", "health.py", "task_runner.py"):
            self.assertTrue((repo_root / runtime_path / filename).is_file())

    def test_cloud_build_limits_cloud_run_to_single_instance_for_sqlite_store(self) -> None:
        cloudbuild = BACKEND_DIR.parent / "cloudbuild.yaml"
        deploy_script = BACKEND_DIR.parent / "deploy-cloud-run.sh"
        content = cloudbuild.read_text(encoding="utf-8") + "\n" + deploy_script.read_text(encoding="utf-8")

        self.assertIn("--max-instances", content)
        self.assertIn("  --max-instances 1", content)

    def test_cloud_build_binds_generation_secrets_when_available(self) -> None:
        cloudbuild = BACKEND_DIR.parent / "cloudbuild.yaml"
        deploy_script = BACKEND_DIR.parent / "deploy-cloud-run.sh"
        cloudbuild_content = cloudbuild.read_text(encoding="utf-8")
        script_content = deploy_script.read_text(encoding="utf-8")

        self.assertIn("apps/myshell-studio-orchestrator/orchestrator/deploy-cloud-run.sh", cloudbuild_content)
        self.assertIn("gcloud secrets describe", script_content)
        self.assertIn("DREAMY_TELEGRAM_INIT_DATA=myshell-dreamy-init-data", script_content)
        self.assertIn("MYSHELL_COOKIES=myshell-cookies", script_content)
        self.assertIn("--set-secrets=", script_content)
        self.assertIn("--no-allow-unauthenticated", script_content)
        self.assertNotIn(" --allow-unauthenticated", script_content)
        self.assertNotIn("query_id=", script_content)

        configure_script = BACKEND_DIR.parent.parent / "scripts" / "configure_generation_secrets.sh"
        self.assertIn("gcloud auth print-identity-token", configure_script.read_text(encoding="utf-8"))

    def test_cloud_start_script_uses_configured_cdp_url_consistently(self) -> None:
        start_script = BACKEND_DIR.parent / "start-cloud.sh"
        content = start_script.read_text(encoding="utf-8")

        self.assertIn("MYSHELL_CDP_URL", content)
        self.assertIn("--remote-debugging-port=${MYSHELL_CDP_PORT}", content)
        self.assertIn("--remote-debugging-address=${MYSHELL_CDP_HOST}", content)

    def test_cloud_start_script_records_cdp_startup_timeout(self) -> None:
        start_script = BACKEND_DIR.parent / "start-cloud.sh"
        content = start_script.read_text(encoding="utf-8")

        self.assertIn("MYSHELL_COOKIE_INJECTION_STATUS_PATH", content)
        self.assertIn("cookie-injection-status.json", content)
        self.assertIn("Chrome CDP was not ready after 30s", content)
        self.assertIn("checkedAt", content)
        self.assertIn('os.path.dirname(path) or "."', content)
        self.assertIn('curl -s "$MYSHELL_CDP_URL/json"', content)
        self.assertNotIn("curl -s http://127.0.0.1:9222/json", content)

    def test_delivery_audit_packages_machine_readable_acceptance_evidence(self) -> None:
        with self.client.stream(
            "POST",
            "/api/studio/run",
            data={"message": "create delivery audit evidence"},
        ) as response:
            self.assertEqual(response.status_code, 200)
            events = _sse_events("".join(response.iter_text()))

        meta = next(payload for name, payload in events if name == "meta")
        execution = next(payload for name, payload in events if name == "execution_request")
        update = self.client.post(
            f"/api/studio/projects/{meta['projectId']}/client-result",
            json={
                "segmentId": execution["segmentId"],
                "jobId": execution["jobId"],
                "status": "done",
                "taskId": "task_delivery_audit",
                "url": "https://example.com/delivery-audit.png",
                "posterUrl": "https://example.com/delivery-audit.png",
            },
        )
        self.assertEqual(update.status_code, 200)

        audit = self.client.get(
            "/api/studio/delivery-audit",
            params={"project_id": meta["projectId"], "source_segment_id": execution["segmentId"]},
        )

        self.assertEqual(audit.status_code, 200)
        self.assertEqual(audit.headers.get("content-type", "").split(";")[0], "application/json")
        body = audit.json()
        self.assertEqual(body["projectId"], meta["projectId"])
        self.assertEqual(body["sourceSegmentId"], execution["segmentId"])
        self.assertIn(body["status"], {"ready", "degraded", "blocked"})
        self.assertGreaterEqual(body["summary"]["pages"], 16)
        self.assertGreaterEqual(body["summary"]["agents"], 7)
        self.assertEqual(body["summary"]["missingCorePages"], 0)
        self.assertEqual(body["summary"]["missingCoreAgents"], 0)
        self.assertGreaterEqual(body["summary"]["artifacts"], 7)

        requirements = {item["id"]: item for item in body["requirements"]}
        expected_requirements = {
            "backend",
            "storage",
            "page-registry",
            "agent-registry",
            "dispatch-matrix",
            "handoff-snapshot",
            "downloadable-delivery-bundle",
        }
        self.assertTrue(expected_requirements.issubset(requirements.keys()))
        self.assertEqual(requirements["page-registry"]["status"], "ready")
        self.assertEqual(requirements["agent-registry"]["status"], "ready")
        self.assertEqual(requirements["downloadable-delivery-bundle"]["status"], "ready")
        self.assertEqual(requirements["downloadable-delivery-bundle"]["evidence"]["filename"], f"myshell-studio-delivery-{meta['projectId']}.json")

        artifact_endpoints = {artifact["endpoint"] for artifact in body["artifacts"]}
        self.assertIn("/api/studio/delivery-audit", artifact_endpoints)
        self.assertIn("/api/studio/projects/{project_id}/delivery-bundle", artifact_endpoints)
        self.assertIn("download=1", str(body["artifacts"]))
        artifact_urls = {artifact["id"]: artifact.get("url") for artifact in body["artifacts"]}
        self.assertTrue(all(artifact_urls.values()), artifact_urls)
        self.assertEqual(
            artifact_urls["delivery-audit"],
            f"/api/studio/delivery-audit?project_id={meta['projectId']}&source_segment_id={execution['segmentId']}",
        )
        self.assertEqual(artifact_urls["project"], f"/api/studio/projects/{meta['projectId']}")
        self.assertEqual(
            artifact_urls["delivery-bundle-download"],
            f"/api/studio/projects/{meta['projectId']}/delivery-bundle?source_segment_id={execution['segmentId']}&download=1",
        )
        self.assertNotIn("{project_id}", str(artifact_urls))
        self.assertEqual(body["reports"]["dispatchMatrix"]["summary"]["total"], body["summary"]["pages"])
        self.assertEqual(body["reports"]["handoffSnapshot"]["projectId"], meta["projectId"])
        self.assertEqual(body["summary"]["actions"], len(body["actions"]))
        self.assertGreater(body["summary"]["actions"], 0)
        action_by_target = {action.get("targetId"): action for action in body["actions"] if action.get("targetId")}
        self.assertIn("myshell-art", action_by_target)
        self.assertEqual(action_by_target["myshell-art"]["action"], "restore-auth")
        self.assertEqual(action_by_target["myshell-art"]["next"]["env"], "MYSHELL_COOKIES")
        self.assertIn("Restore MyShell auth", action_by_target["myshell-art"]["next"]["label"])
        handoff_action_ids = {action["id"] for action in body["reports"]["handoffSnapshot"]["actions"]}
        audit_action_ids = {action["id"] for action in body["actions"]}
        self.assertTrue(handoff_action_ids.issubset(audit_action_ids))

        download = self.client.get(
            "/api/studio/delivery-audit",
            params={"project_id": meta["projectId"], "source_segment_id": execution["segmentId"], "download": "1"},
        )
        self.assertEqual(download.status_code, 200)
        self.assertEqual(download.headers.get("content-type", "").split(";")[0], "application/json")
        disposition = download.headers.get("content-disposition", "")
        self.assertIn("attachment", disposition)
        self.assertIn(f"myshell-studio-audit-{meta['projectId']}.json", disposition)
        download_body = download.json()
        self.assertEqual(download_body["projectId"], meta["projectId"])
        self.assertEqual(download_body["requirements"][0]["id"], body["requirements"][0]["id"])

    def test_delivery_audit_merges_requirement_and_handoff_actions(self) -> None:
        async def fake_runtime_health(store_path: str) -> dict:
            return {
                "status": "ok",
                "version": "test",
                "checkedAt": "2026-06-02T00:00:00Z",
                "components": {
                    "backend": {"status": "ok", "message": "FastAPI runtime is serving requests"},
                    "storage": {"status": "ok", "path": store_path},
                    "chromeCdp": {"status": "unavailable", "url": "http://127.0.0.1:9222"},
                    "myshellCookies": {"status": "auth_missing", "message": "No MyShell cookies configured"},
                    "cookieInjection": {"status": "auth_missing", "message": "Set MYSHELL_COOKIES"},
                    "dreamyApiAuth": {"status": "client_delegated", "mode": "telegram-init-data"},
                },
            }

        def fake_auth_status(page_id: str) -> dict:
            if page_id == "myshell-art":
                return {"status": "auth_missing", "mode": "browser-cookies", "message": "Missing MyShell cookies"}
            return {"status": "client_delegated", "mode": "telegram-init-data", "message": "Client delegated"}

        with (
            patch("studio_app.infrastructure.runtime.health.runtime_health", side_effect=fake_runtime_health),
            patch("studio_app.infrastructure.runtime.health.adapter_auth_status", side_effect=fake_auth_status),
        ):
            with self.client.stream(
                "POST",
                "/api/studio/run",
                data={"message": "create audit action merge evidence"},
            ) as response:
                self.assertEqual(response.status_code, 200)
                events = _sse_events("".join(response.iter_text()))

            meta = next(payload for name, payload in events if name == "meta")
            execution = next(payload for name, payload in events if name == "execution_request")
            update = self.client.post(
                f"/api/studio/projects/{meta['projectId']}/client-result",
                json={
                    "segmentId": execution["segmentId"],
                    "jobId": execution["jobId"],
                    "status": "done",
                    "taskId": "task_audit_action_merge",
                    "url": "https://example.com/audit-action-merge.png",
                    "posterUrl": "https://example.com/audit-action-merge.png",
                },
            )
            self.assertEqual(update.status_code, 200)

            audit = self.client.get(
                "/api/studio/delivery-audit",
                params={"project_id": meta["projectId"], "source_segment_id": execution["segmentId"]},
            )

        self.assertEqual(audit.status_code, 200)
        body = audit.json()
        actions = {(action["action"], action.get("targetId")) for action in body["actions"]}
        self.assertIn(("start-chrome-cdp", "chrome-cdp"), actions)
        self.assertIn(("restore-auth", "myshell-art"), actions)
        self.assertEqual(len(body["actions"]), len({action["id"] for action in body["actions"]}))
        self.assertEqual(body["summary"]["actions"], len(body["actions"]))

    def test_delivery_audit_without_project_keeps_handoff_context_non_blocking(self) -> None:
        audit = self.client.get("/api/studio/delivery-audit")

        self.assertEqual(audit.status_code, 200)
        body = audit.json()
        requirements = {item["id"]: item for item in body["requirements"]}
        self.assertEqual(requirements["handoff-snapshot"]["status"], "ready")
        self.assertFalse(requirements["handoff-snapshot"]["required"])
        action_ids = {action["id"] for action in body["actions"]}
        self.assertNotIn("audit:provide-project-id:handoff-snapshot", action_ids)

    def test_studio_action_resolve_executes_verification_and_explains_manual_auth(self) -> None:
        def fake_auth_status(page_id: str) -> dict:
            if page_id == "myshell-art":
                return {"status": "auth_missing", "mode": "browser-cookies", "message": "Missing MyShell cookies"}
            return {"status": "client_delegated", "mode": "telegram-init-data", "message": "Client delegated"}

        with patch("studio_app.infrastructure.runtime.health.adapter_auth_status", side_effect=fake_auth_status):
            with self.client.stream(
                "POST",
                "/api/studio/run",
                data={"message": "create action resolve source image"},
            ) as response:
                self.assertEqual(response.status_code, 200)
                events = _sse_events("".join(response.iter_text()))

            meta = next(payload for name, payload in events if name == "meta")
            execution = next(payload for name, payload in events if name == "execution_request")
            source_url = "https://example.com/action-resolve-source.png"
            update = self.client.post(
                f"/api/studio/projects/{meta['projectId']}/client-result",
                json={
                    "segmentId": execution["segmentId"],
                    "jobId": execution["jobId"],
                    "status": "done",
                    "taskId": "task_action_resolve_source",
                    "url": source_url,
                    "posterUrl": source_url,
                },
            )
            self.assertEqual(update.status_code, 200)

            verify_action = self.client.post(
                "/api/studio/actions/resolve",
                json={
                    "action": "verify-ready",
                    "target_id": "explore",
                    "project_id": meta["projectId"],
                    "source_segment_id": execution["segmentId"],
                },
            )

            auth_action = self.client.post(
                "/api/studio/actions/resolve",
                json={
                    "action": "restore-auth",
                    "target_id": "myshell-art",
                    "project_id": meta["projectId"],
                    "source_segment_id": execution["segmentId"],
                },
            )

        self.assertEqual(verify_action.status_code, 200)
        verify_body = verify_action.json()
        self.assertEqual(verify_body["status"], "executed")
        self.assertEqual(verify_body["action"], "verify-ready")
        self.assertEqual(verify_body["targetId"], "explore")
        self.assertEqual(verify_body["resultType"], "coverage-verify")
        self.assertEqual(verify_body["result"]["createdCount"], 1)
        self.assertEqual(verify_body["result"]["jobs"][0]["pageId"], "explore")
        self.assertEqual(verify_body["result"]["coverage"]["projectId"], meta["projectId"])
        self.assertEqual(verify_body["audit"]["projectId"], meta["projectId"])
        self.assertEqual(verify_body["audit"]["summary"]["actions"], len(verify_body["audit"]["actions"]))
        self.assertNotIn("explore", {action.get("targetId") for action in verify_body["audit"]["actions"]})

        self.assertEqual(auth_action.status_code, 200)
        auth_body = auth_action.json()
        self.assertEqual(auth_body["status"], "manual_required")
        self.assertEqual(auth_body["action"], "restore-auth")
        self.assertEqual(auth_body["targetId"], "myshell-art")
        self.assertEqual(auth_body["resultType"], "operator-instruction")
        self.assertIn("MYSHELL_COOKIES", auth_body["next"]["message"])
        self.assertEqual(auth_body["audit"]["projectId"], meta["projectId"])

    def test_studio_action_resolve_batch_executes_safe_actions_and_preserves_manual_actions(self) -> None:
        def fake_auth_status(page_id: str) -> dict:
            if page_id == "myshell-art":
                return {"status": "auth_missing", "mode": "browser-cookies", "message": "Missing MyShell cookies"}
            return {"status": "client_delegated", "mode": "telegram-init-data", "message": "Client delegated"}

        with patch("studio_app.infrastructure.runtime.health.adapter_auth_status", side_effect=fake_auth_status):
            with self.client.stream(
                "POST",
                "/api/studio/run",
                data={"message": "create batch action resolve source image"},
            ) as response:
                self.assertEqual(response.status_code, 200)
                events = _sse_events("".join(response.iter_text()))

            meta = next(payload for name, payload in events if name == "meta")
            execution = next(payload for name, payload in events if name == "execution_request")
            update = self.client.post(
                f"/api/studio/projects/{meta['projectId']}/client-result",
                json={
                    "segmentId": execution["segmentId"],
                    "jobId": execution["jobId"],
                    "status": "done",
                    "taskId": "task_action_resolve_batch_source",
                    "url": "https://example.com/action-resolve-batch-source.png",
                    "posterUrl": "https://example.com/action-resolve-batch-source.png",
                },
            )
            self.assertEqual(update.status_code, 200)

            batch = self.client.post(
                "/api/studio/actions/resolve-batch",
                json={
                    "project_id": meta["projectId"],
                    "source_segment_id": execution["segmentId"],
                    "actions": [
                        {"action": "verify-ready", "target_id": "explore"},
                        {"action": "verify-ready", "target_id": "ai-picks"},
                        {"action": "restore-auth", "target_id": "myshell-art"},
                    ],
                },
            )

        self.assertEqual(batch.status_code, 200)
        body = batch.json()
        self.assertEqual(body["status"], "executed_with_manual")
        self.assertEqual(body["projectId"], meta["projectId"])
        self.assertEqual(body["sourceSegmentId"], execution["segmentId"])
        self.assertEqual(body["summary"]["requested"], 3)
        self.assertEqual(body["summary"]["executed"], 2)
        self.assertEqual(body["summary"]["manualRequired"], 1)
        self.assertEqual(body["summary"]["createdJobs"], 2)

        executed_by_target = {item["targetId"]: item for item in body["executedActions"]}
        self.assertEqual(set(executed_by_target.keys()), {"explore", "ai-picks"})
        self.assertTrue(all(item["status"] == "executed" for item in executed_by_target.values()))

        manual_by_target = {item["targetId"]: item for item in body["manualActions"]}
        self.assertEqual(manual_by_target["myshell-art"]["action"], "restore-auth")
        self.assertEqual(manual_by_target["myshell-art"]["status"], "manual_required")
        self.assertIn("MYSHELL_COOKIES", manual_by_target["myshell-art"]["next"]["message"])

        covered_page_ids = {page["pageId"] for page in body["audit"]["reports"]["coverage"]["pages"] if page["coverageStatus"] == "covered"}
        self.assertIn("explore", covered_page_ids)
        self.assertIn("ai-picks", covered_page_ids)
        self.assertNotIn("explore", {action.get("targetId") for action in body["audit"]["actions"]})
        self.assertNotIn("ai-picks", {action.get("targetId") for action in body["audit"]["actions"]})

    def test_studio_action_resolve_runs_pending_dispatch_target(self) -> None:
        with self.client.stream(
            "POST",
            "/api/studio/run",
            data={"message": "create dispatch action source image"},
        ) as response:
            self.assertEqual(response.status_code, 200)
            events = _sse_events("".join(response.iter_text()))

        meta = next(payload for name, payload in events if name == "meta")
        execution = next(payload for name, payload in events if name == "execution_request")
        session_response = self.client.post(
            "/api/studio/dispatch-sessions",
            json={
                "project_id": meta["projectId"],
                "source_segment_id": execution["segmentId"],
                "page_ids": ["dreamy-miniapp"],
                "limit": 1,
            },
        )
        self.assertEqual(session_response.status_code, 200)
        session = session_response.json()
        target = session["nextTarget"]
        self.assertEqual(target["status"], "pending")

        audit = self.client.get(
            "/api/studio/delivery-audit",
            params={"project_id": meta["projectId"], "source_segment_id": execution["segmentId"]},
        )
        self.assertEqual(audit.status_code, 200)
        audit_body = audit.json()
        action_id = f"dispatch-target:run-target:{session['sessionId']}:{target['id']}"
        action_by_id = {action["id"]: action for action in audit_body["actions"]}
        self.assertIn(action_id, action_by_id)
        self.assertEqual(action_by_id[action_id]["action"], "run-target")
        self.assertEqual(action_by_id[action_id]["kind"], "dispatch_target")
        self.assertEqual(action_by_id[action_id]["sessionId"], session["sessionId"])
        self.assertEqual(action_by_id[action_id]["targetId"], target["id"])
        self.assertEqual(
            action_by_id[action_id]["uiUrl"],
            f"/dreamy?dispatch_session_id={session['sessionId']}&target_id=dispatch%3Adreamy-miniapp",
        )

        resolved_action = self.client.post(
            "/api/studio/actions/resolve",
            json={
                "action": "run-target",
                "target_id": target["id"],
                "session_id": session["sessionId"],
                "project_id": meta["projectId"],
                "source_segment_id": execution["segmentId"],
            },
        )

        self.assertEqual(resolved_action.status_code, 200)
        resolved_body = resolved_action.json()
        self.assertEqual(resolved_body["status"], "executed")
        self.assertEqual(resolved_body["action"], "run-target")
        self.assertEqual(resolved_body["targetId"], target["id"])
        self.assertEqual(resolved_body["sessionId"], session["sessionId"])
        self.assertEqual(resolved_body["resultType"], "dispatch-target-run")
        self.assertEqual(resolved_body["result"]["status"], "execution_required")
        self.assertEqual(resolved_body["result"]["executionRequest"]["executor"], "client")
        self.assertEqual(resolved_body["result"]["executionRequest"]["dispatchSessionId"], session["sessionId"])
        self.assertEqual(resolved_body["result"]["executionRequest"]["dispatchTargetId"], target["id"])
        restored_target = next(
            item
            for item in resolved_body["result"]["session"]["targets"]
            if item["id"] == target["id"]
        )
        self.assertEqual(restored_target["status"], "visited")
        self.assertNotIn(action_id, {action["id"] for action in resolved_body["audit"]["actions"]})

    def test_studio_action_resolve_batch_runs_dispatch_target_actions(self) -> None:
        with self.client.stream(
            "POST",
            "/api/studio/run",
            data={"message": "create batch dispatch action source image"},
        ) as response:
            self.assertEqual(response.status_code, 200)
            events = _sse_events("".join(response.iter_text()))

        meta = next(payload for name, payload in events if name == "meta")
        execution = next(payload for name, payload in events if name == "execution_request")
        session_response = self.client.post(
            "/api/studio/dispatch-sessions",
            json={
                "project_id": meta["projectId"],
                "source_segment_id": execution["segmentId"],
                "page_ids": ["dreamy-miniapp"],
                "limit": 1,
            },
        )
        self.assertEqual(session_response.status_code, 200)
        session = session_response.json()
        target = session["nextTarget"]

        batch = self.client.post(
            "/api/studio/actions/resolve-batch",
            json={
                "project_id": meta["projectId"],
                "source_segment_id": execution["segmentId"],
                "actions": [
                    {
                        "action": "run-target",
                        "target_id": target["id"],
                        "session_id": session["sessionId"],
                    },
                    {"action": "verify-ready", "target_id": "explore"},
                ],
            },
        )

        self.assertEqual(batch.status_code, 200)
        body = batch.json()
        self.assertEqual(body["status"], "executed")
        self.assertEqual(body["summary"]["requested"], 2)
        self.assertEqual(body["summary"]["executed"], 2)
        self.assertEqual(body["summary"]["manualRequired"], 0)
        self.assertEqual(body["summary"]["skipped"], 0)
        self.assertEqual(body["summary"]["createdJobs"], 2)

        run_action = next(item for item in body["executedActions"] if item["action"] == "run-target")
        self.assertEqual(run_action["targetId"], target["id"])
        self.assertEqual(run_action["sessionId"], session["sessionId"])
        self.assertEqual(run_action["resultType"], "dispatch-target-run")
        self.assertEqual(run_action["result"]["status"], "execution_required")
        self.assertEqual(run_action["result"]["executionRequest"]["executor"], "client")
        self.assertEqual(run_action["result"]["executionRequest"]["dispatchSessionId"], session["sessionId"])
        self.assertEqual(run_action["result"]["executionRequest"]["dispatchTargetId"], target["id"])
        restored_target = next(
            item
            for item in run_action["result"]["session"]["targets"]
            if item["id"] == target["id"]
        )
        self.assertEqual(restored_target["status"], "visited")

        verify_action = next(item for item in body["executedActions"] if item["action"] == "verify-ready")
        self.assertEqual(verify_action["targetId"], "explore")
        self.assertEqual(verify_action["resultType"], "coverage-verify")
        self.assertEqual(body["result"]["createdCount"], 1)
        action_ids = {action["id"] for action in body["audit"]["actions"]}
        self.assertNotIn(f"dispatch-target:run-target:{session['sessionId']}:{target['id']}", action_ids)
        self.assertNotIn("verify-ready:explore", action_ids)

    def test_studio_action_resolve_explains_all_operator_action_types(self) -> None:
        action_targets = [
            ("provide-route-params", "tag-generator"),
            ("wait-or-refresh", "library"),
            ("retry-or-inspect", "job_timeout"),
            ("restore-readiness", "myshell-art"),
            ("inspect-gap", "dispatch-matrix"),
            ("wait-for-adapter", "job_queued"),
            ("poll-result", "job_running"),
            ("retry-or-cancel", "job_timeout"),
            ("inspect-error", "job_error"),
            ("verify-evidence", "job_done_without_evidence"),
        ]

        for action, target_id in action_targets:
            with self.subTest(action=action):
                response = self.client.post(
                    "/api/studio/actions/resolve",
                    json={"action": action, "target_id": target_id},
                )
                self.assertEqual(response.status_code, 200)
                body = response.json()
                self.assertEqual(body["status"], "manual_required")
                self.assertEqual(body["action"], action)
                self.assertEqual(body["targetId"], target_id)
                self.assertEqual(body["resultType"], "operator-instruction")
                self.assertIn(target_id, body["next"]["targetId"])
                self.assertTrue(body["next"]["message"])
                self.assertIn("audit", body)

        batch = self.client.post(
            "/api/studio/actions/resolve-batch",
            json={"actions": [{"action": action, "target_id": target_id} for action, target_id in action_targets]},
        )
        self.assertEqual(batch.status_code, 200)
        batch_body = batch.json()
        self.assertEqual(batch_body["status"], "manual_required")
        self.assertEqual(batch_body["summary"]["requested"], len(action_targets))
        self.assertEqual(batch_body["summary"]["manualRequired"], len(action_targets))
        self.assertEqual(batch_body["summary"]["skipped"], 0)
        self.assertEqual(batch_body["skippedActions"], [])
        self.assertEqual({item["action"] for item in batch_body["manualActions"]}, {action for action, _target_id in action_targets})

    def test_studio_action_resolve_returns_concrete_operator_urls(self) -> None:
        retry = self.client.post(
            "/api/studio/actions/resolve",
            json={"action": "retry-or-cancel", "target_id": "job_timeout"},
        )
        self.assertEqual(retry.status_code, 200)
        retry_next = retry.json()["next"]
        self.assertEqual(retry_next["retryUrl"], "/api/studio/jobs/job_timeout/retry")
        self.assertEqual(retry_next["cancelUrl"], "/api/studio/jobs/job_timeout/cancel")
        self.assertNotIn("{job_id}", json.dumps(retry_next))

        inspect_error = self.client.post(
            "/api/studio/actions/resolve",
            json={"action": "inspect-error", "target_id": "job_error"},
        )
        self.assertEqual(inspect_error.status_code, 200)
        inspect_next = inspect_error.json()["next"]
        self.assertEqual(inspect_next["url"], "/api/studio/jobs/job_error/evidence")
        self.assertNotIn("{job_id}", json.dumps(inspect_next))

        route_params = self.client.post(
            "/api/studio/actions/resolve",
            json={"action": "provide-route-params", "target_id": "tag-generator"},
        )
        self.assertEqual(route_params.status_code, 200)
        route_next = route_params.json()["next"]
        self.assertEqual(route_next["url"], "/api/studio/dispatch-preview?page_id=tag-generator")
        self.assertEqual(route_next["query"]["page_id"], "tag-generator")

    def test_dispatch_matrix_covers_all_pages_agents_and_paths(self) -> None:
        matrix = self.client.get("/api/studio/dispatch-matrix")

        self.assertEqual(matrix.status_code, 200)
        self.assertEqual(matrix.headers.get("content-type", "").split(";")[0], "application/json")
        body = matrix.json()
        self.assertIn("checkedAt", body)
        self.assertGreaterEqual(body["summary"]["total"], 13)
        self.assertGreaterEqual(body["summary"]["ready"], 11)
        self.assertGreaterEqual(body["summary"]["missingParams"], 1)

        entries = {entry["pageId"]: entry for entry in body["entries"]}
        self.assertIn("dreamy-miniapp", entries)
        self.assertIn("myshell-art", entries)
        self.assertIn("library", entries)
        self.assertIn("tag-generator", entries)

        dreamy = entries["dreamy-miniapp"]
        self.assertEqual(dreamy["executor"], "client")
        self.assertEqual(dreamy["agentId"], "dreamy-miniapp-executor")
        self.assertEqual(dreamy["recommendedAction"], "execute-client")
        self.assertTrue(dreamy["dispatchReady"])

        library = entries["library"]
        self.assertEqual(library["executor"], "navigation")
        self.assertEqual(library["agentId"], "miniapp-page-navigator")
        self.assertEqual(library["recommendedAction"], "navigate")
        self.assertEqual(library["navigationPath"], "/library")
        self.assertEqual(library["missingRouteParams"], [])

        tag_generator = entries["tag-generator"]
        self.assertTrue(tag_generator["navigationPath"].startswith("/tag-generator?slug_id="), tag_generator["navigationPath"])
        self.assertEqual(tag_generator["routeParams"], ["slug_id", "img"])
        self.assertEqual(tag_generator["missingRouteParams"], ["img"])

        art = entries["myshell-art"]
        self.assertEqual(art["executor"], "server")
        self.assertEqual(art["agentId"], "myshell-art-cdp-executor")
        self.assertEqual(art["recommendedAction"], "execute-server")
        self.assertIn(art["authStatus"]["status"], {"ready", "auth_missing"})
        self.assertEqual(art["dispatchReady"], art["authStatus"]["status"] == "ready")

    def test_dispatch_matrix_uses_source_segment_for_contextual_pages(self) -> None:
        with self.client.stream(
            "POST",
            "/api/studio/run",
            data={"message": "create source image"},
        ) as response:
            self.assertEqual(response.status_code, 200)
            events = _sse_events("".join(response.iter_text()))

        meta = next(payload for name, payload in events if name == "meta")
        execution = next(payload for name, payload in events if name == "execution_request")
        image_url = "https://example.com/source-image.png"

        queued_matrix = self.client.get(
            "/api/studio/dispatch-matrix",
            params={"project_id": meta["projectId"], "source_segment_id": execution["segmentId"]},
        )
        self.assertEqual(queued_matrix.status_code, 200)
        queued_entries = {entry["pageId"]: entry for entry in queued_matrix.json()["entries"]}
        self.assertFalse(queued_entries["tag-generator"]["dispatchReady"])
        self.assertEqual(queued_entries["tag-generator"]["missingRouteParams"], ["img"])

        updated = self.client.post(
            f"/api/studio/projects/{meta['projectId']}/client-result",
            json={
                "segmentId": execution["segmentId"],
                "jobId": execution["jobId"],
                "status": "done",
                "taskId": "task_source_image",
                "url": image_url,
                "posterUrl": image_url,
            },
        )
        self.assertEqual(updated.status_code, 200)

        matrix = self.client.get(
            "/api/studio/dispatch-matrix",
            params={"project_id": meta["projectId"], "source_segment_id": execution["segmentId"]},
        )
        self.assertEqual(matrix.status_code, 200)
        body = matrix.json()
        entries = {entry["pageId"]: entry for entry in body["entries"]}

        tag_generator = entries["tag-generator"]
        self.assertTrue(tag_generator["dispatchReady"])
        self.assertEqual(tag_generator["missingRouteParams"], [])
        self.assertIn("img=https%3A%2F%2Fexample.com%2Fsource-image.png", tag_generator["navigationPath"])
        self.assertGreaterEqual(body["summary"]["ready"], 12)
        self.assertEqual(body["summary"]["missingParams"], 0)

    def test_pages_cover_existing_myshell_miniapp_routes(self) -> None:
        pages = self.client.get("/api/pages")
        self.assertEqual(pages.status_code, 200)

        page_by_id = {page["id"]: page for page in pages.json()["pages"]}
        expected_routes = {
            "explore": "/explore",
            "ai-picks": "/ai-picks",
            "canvaspro": "/dreamy?workspace=canvaspro",
            "bot-detail": "/bot",
            "upload": "/upload",
            "tag-generator": "/tag-generator",
            "library": "/library",
            "library-detail": "/library/:id",
            "energy-store": "/energy",
            "energy-history": "/energy-history",
            "earn": "/earn",
            "share-invite": "/share-invite",
            "settings": "/settings",
            "profile": "/profile",
            "checkin": "/checkin-demo",
        }

        for page_id, route in expected_routes.items():
            self.assertIn(page_id, page_by_id)
            self.assertEqual(page_by_id[page_id]["appRoute"], route)
            self.assertEqual(page_by_id[page_id]["executor"], "navigation")
            self.assertEqual(page_by_id[page_id]["registrySource"], "manifest")

    def test_dynamic_manifest_routes_replace_path_parameters(self) -> None:
        preview = self.client.get(
            "/api/studio/dispatch-preview",
            params={"page_id": "library-detail", "message": "open a generated work detail"},
        )

        self.assertEqual(preview.status_code, 200)
        body = preview.json()
        self.assertEqual(body["page"]["id"], "library-detail")
        self.assertEqual(body["navigationPath"], "/library/studio-preview")
        self.assertEqual(body["routeParams"], ["id"])
        self.assertEqual(body["missingRouteParams"], [])
        self.assertTrue(body["dispatchReady"])

        matrix = self.client.get("/api/studio/dispatch-matrix")
        self.assertEqual(matrix.status_code, 200)
        entries = {entry["pageId"]: entry for entry in matrix.json()["entries"]}
        self.assertEqual(entries["library-detail"]["navigationPath"], "/library/studio-preview")
        self.assertEqual(entries["library-detail"]["missingRouteParams"], [])
        self.assertTrue(entries["library-detail"]["dispatchReady"])

    def test_manifest_pages_extend_registry_and_prompt_routing(self) -> None:
        manifest = {
            "version": "test",
            "pages": [
                {
                    "id": "daily-boost",
                    "name": "Daily Boost",
                    "appRoute": "/daily-boost",
                    "capabilities": ["boost-status", "boost-claim"],
                    "intentKeywords": ["daily boost", "boost reward"],
                }
            ],
        }

        with tempfile.TemporaryDirectory() as tmp_dir:
            manifest_path = Path(tmp_dir) / "pages.json"
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            with patch.dict(os.environ, {"STUDIO_PAGES_MANIFEST": str(manifest_path)}):
                pages = self.client.get("/api/pages")
                self.assertEqual(pages.status_code, 200)
                page_by_id = {page["id"]: page for page in pages.json()["pages"]}

                self.assertIn("daily-boost", page_by_id)
                self.assertEqual(page_by_id["daily-boost"]["appRoute"], "/daily-boost")
                self.assertEqual(page_by_id["daily-boost"]["registrySource"], "manifest")

                inferred = page_for_dispatch({}, "dreamy-miniapp", "open daily boost rewards")
                self.assertEqual(inferred["id"], "daily-boost")

    def test_manifest_route_defaults_are_added_to_navigation_path(self) -> None:
        manifest = {
            "version": "test",
            "pages": [
                {
                    "id": "daily-boost",
                    "name": "Daily Boost",
                    "appRoute": "/daily-boost?tab=home",
                    "capabilities": ["boost-status", "boost-claim"],
                    "intentKeywords": ["daily boost"],
                    "routeDefaults": {
                        "source": "studio",
                        "surface": "boost center",
                    },
                }
            ],
        }

        with tempfile.TemporaryDirectory() as tmp_dir:
            manifest_path = Path(tmp_dir) / "pages.json"
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            with patch.dict(os.environ, {"STUDIO_PAGES_MANIFEST": str(manifest_path)}):
                with self.client.stream(
                    "POST",
                    "/api/studio/run",
                    data={"message": "open daily boost"},
                ) as response:
                    self.assertEqual(response.status_code, 200)
                    events = _sse_events("".join(response.iter_text()))

        execution = next(payload for name, payload in events if name == "execution_request")
        self.assertEqual(execution["api"], "daily-boost")
        self.assertEqual(
            execution["navigationPath"],
            "/daily-boost?tab=home&source=studio&surface=boost+center",
        )

    def test_navigation_page_dispatch_returns_navigation_execution(self) -> None:
        with self.client.stream(
            "POST",
            "/api/studio/run",
            data={"message": "open my generated library", "page_id": "library"},
        ) as response:
            self.assertEqual(response.status_code, 200)
            events = _sse_events("".join(response.iter_text()))

        route = next(payload for name, payload in events if name == "route")
        execution = next(payload for name, payload in events if name == "execution_request")
        job_payloads = [payload["job"] for name, payload in events if name == "job"]

        self.assertEqual(route["page"]["id"], "library")
        self.assertEqual(execution["executor"], "navigation")
        self.assertEqual(execution["clientAction"], "navigate")
        self.assertEqual(execution["navigationPath"], "/library")
        self.assertEqual(execution["studioReturnPath"], "/dreamy")
        self.assertEqual(execution["page"]["appRoute"], "/library")
        self.assertEqual(job_payloads[-1]["status"], "done")
        self.assertEqual(job_payloads[-1]["evidence"]["accepted"], True)

    def test_navigation_dispatch_evidence_records_contextual_path(self) -> None:
        with self.client.stream(
            "POST",
            "/api/studio/run",
            data={"message": "create source image"},
        ) as response:
            self.assertEqual(response.status_code, 200)
            source_events = _sse_events("".join(response.iter_text()))

        source_meta = next(payload for name, payload in source_events if name == "meta")
        source_execution = next(payload for name, payload in source_events if name == "execution_request")
        source_url = "https://example.com/contextual-source.png"
        self.client.post(
            f"/api/studio/projects/{source_meta['projectId']}/client-result",
            json={
                "segmentId": source_execution["segmentId"],
                "jobId": source_execution["jobId"],
                "status": "done",
                "taskId": "task_contextual_source",
                "url": source_url,
                "posterUrl": source_url,
            },
        )

        with self.client.stream(
            "POST",
            "/api/studio/run",
            data={
                "message": "dispatch tag generator from matrix",
                "project_id": source_meta["projectId"],
                "source_segment_id": source_execution["segmentId"],
                "page_id": "tag-generator",
                "agent_id": "miniapp-page-navigator",
            },
        ) as response:
            self.assertEqual(response.status_code, 200)
            events = _sse_events("".join(response.iter_text()))

        execution = next(payload for name, payload in events if name == "execution_request")
        jobs = [payload["job"] for name, payload in events if name == "job"]
        final_job = jobs[-1]

        self.assertEqual(execution["api"], "tag-generator")
        self.assertEqual(execution["agentId"], "miniapp-page-navigator")
        self.assertEqual(execution["missingRouteParams"], [])
        self.assertIn("img=https%3A%2F%2Fexample.com%2Fcontextual-source.png", execution["navigationPath"])
        self.assertEqual(final_job["status"], "done")
        self.assertEqual(final_job["evidence"]["accepted"], True)
        self.assertEqual(final_job["evidence"]["navigationPath"], execution["navigationPath"])
        self.assertEqual(final_job["evidence"]["pageId"], "tag-generator")
        self.assertEqual(final_job["evidence"]["agentId"], "miniapp-page-navigator")

    def test_navigation_segment_placeholder_is_not_source_media(self) -> None:
        with self.client.stream(
            "POST",
            "/api/studio/run",
            data={"message": "open my generated library", "page_id": "library"},
        ) as response:
            self.assertEqual(response.status_code, 200)
            events = _sse_events("".join(response.iter_text()))

        meta = next(payload for name, payload in events if name == "meta")
        execution = next(payload for name, payload in events if name == "execution_request")

        matrix = self.client.get(
            "/api/studio/dispatch-matrix",
            params={"project_id": meta["projectId"], "source_segment_id": execution["segmentId"]},
        )
        self.assertEqual(matrix.status_code, 200)
        entries = {entry["pageId"]: entry for entry in matrix.json()["entries"]}

        tag_generator = entries["tag-generator"]
        self.assertFalse(tag_generator["dispatchReady"])
        self.assertEqual(tag_generator["missingRouteParams"], ["img"])
        self.assertNotIn("img=%2Fgallery", tag_generator["navigationPath"])

    def test_studio_coverage_report_summarizes_page_dispatch_evidence(self) -> None:
        with self.client.stream(
            "POST",
            "/api/studio/run",
            data={"message": "create coverage source image"},
        ) as response:
            self.assertEqual(response.status_code, 200)
            source_events = _sse_events("".join(response.iter_text()))

        source_meta = next(payload for name, payload in source_events if name == "meta")
        source_execution = next(payload for name, payload in source_events if name == "execution_request")
        source_url = "https://example.com/coverage-source.png"
        update = self.client.post(
            f"/api/studio/projects/{source_meta['projectId']}/client-result",
            json={
                "segmentId": source_execution["segmentId"],
                "jobId": source_execution["jobId"],
                "status": "done",
                "taskId": "task_coverage_source",
                "url": source_url,
                "posterUrl": source_url,
            },
        )
        self.assertEqual(update.status_code, 200)

        with self.client.stream(
            "POST",
            "/api/studio/run",
            data={
                "message": "dispatch tag generator for coverage",
                "project_id": source_meta["projectId"],
                "source_segment_id": source_execution["segmentId"],
                "page_id": "tag-generator",
                "agent_id": "miniapp-page-navigator",
            },
        ) as response:
            self.assertEqual(response.status_code, 200)
            _sse_events("".join(response.iter_text()))

        coverage = self.client.get(
            "/api/studio/coverage",
            params={"project_id": source_meta["projectId"], "source_segment_id": source_execution["segmentId"]},
        )
        self.assertEqual(coverage.status_code, 200)
        body = coverage.json()
        pages = {page["pageId"]: page for page in body["pages"]}

        self.assertEqual(body["projectId"], source_meta["projectId"])
        self.assertEqual(body["sourceSegmentId"], source_execution["segmentId"])
        self.assertEqual(body["summary"]["total"], 17)
        self.assertGreaterEqual(body["summary"]["ready"], 16)
        self.assertGreaterEqual(body["summary"]["covered"], 2)
        self.assertGreaterEqual(body["summary"]["blocked"], 1)
        self.assertIn(body["status"], {"ready_with_gaps", "blocked"})

        tag_generator = pages["tag-generator"]
        self.assertEqual(tag_generator["coverageStatus"], "covered")
        self.assertEqual(tag_generator["latestJob"]["status"], "done")
        self.assertEqual(tag_generator["latestEvidence"]["pageId"], "tag-generator")
        self.assertIn("img=https%3A%2F%2Fexample.com%2Fcoverage-source.png", tag_generator["navigationPath"])
        self.assertEqual(tag_generator["missingRouteParams"], [])

        art = pages["myshell-art"]
        self.assertEqual(art["coverageStatus"], "blocked")
        self.assertEqual(art["dispatchStatus"], "auth_missing")
        self.assertEqual(art["authStatus"]["status"], "auth_missing")

    def test_coverage_falls_back_to_latest_accepted_media_segment(self) -> None:
        with self.client.stream(
            "POST",
            "/api/studio/run",
            data={"message": "create fallback coverage source image"},
        ) as response:
            self.assertEqual(response.status_code, 200)
            source_events = _sse_events("".join(response.iter_text()))

        source_meta = next(payload for name, payload in source_events if name == "meta")
        source_execution = next(payload for name, payload in source_events if name == "execution_request")
        source_url = "https://example.com/fallback-coverage-source.png"
        update = self.client.post(
            f"/api/studio/projects/{source_meta['projectId']}/client-result",
            json={
                "segmentId": source_execution["segmentId"],
                "jobId": source_execution["jobId"],
                "status": "done",
                "taskId": "task_fallback_coverage_source",
                "url": source_url,
                "posterUrl": source_url,
            },
        )
        self.assertEqual(update.status_code, 200)

        with self.client.stream(
            "POST",
            "/api/studio/run",
            data={
                "message": "dispatch tag generator then keep context",
                "project_id": source_meta["projectId"],
                "source_segment_id": source_execution["segmentId"],
                "page_id": "tag-generator",
            },
        ) as response:
            self.assertEqual(response.status_code, 200)
            _sse_events("".join(response.iter_text()))

        restored_project = self.client.get(f"/api/studio/projects/{source_meta['projectId']}").json()
        self.assertNotEqual(restored_project["selectedSegmentId"], source_execution["segmentId"])

        coverage = self.client.get(
            "/api/studio/coverage",
            params={"project_id": source_meta["projectId"]},
        )
        self.assertEqual(coverage.status_code, 200)
        body = coverage.json()
        pages = {page["pageId"]: page for page in body["pages"]}

        self.assertEqual(body["sourceSegmentId"], source_execution["segmentId"])
        self.assertEqual(body["sourceMediaUrl"], source_url)
        self.assertEqual(pages["tag-generator"]["coverageStatus"], "covered")
        self.assertEqual(pages["tag-generator"]["missingRouteParams"], [])
        self.assertIn("img=https%3A%2F%2Fexample.com%2Ffallback-coverage-source.png", pages["tag-generator"]["navigationPath"])

        with self.client.stream(
            "POST",
            "/api/studio/run",
            data={
                "message": "dispatch from selected navigation segment",
                "project_id": source_meta["projectId"],
                "source_segment_id": restored_project["selectedSegmentId"],
                "page_id": "tag-generator",
            },
        ) as response:
            self.assertEqual(response.status_code, 200)
            rerun_events = _sse_events("".join(response.iter_text()))

        rerun_execution = next(payload for name, payload in rerun_events if name == "execution_request")
        self.assertEqual(rerun_execution["missingRouteParams"], [])
        self.assertIn("img=https%3A%2F%2Fexample.com%2Ffallback-coverage-source.png", rerun_execution["navigationPath"])

    def test_coverage_verify_creates_accepted_navigation_jobs_for_ready_pages(self) -> None:
        def fake_auth_status(page_id: str) -> dict:
            if page_id == "myshell-art":
                return {"status": "auth_missing", "mode": "browser-cookies", "message": "Missing MyShell cookies"}
            return {"status": "client_delegated", "mode": "telegram-init-data", "message": "Client delegated"}

        with patch("studio_app.infrastructure.runtime.health.adapter_auth_status", side_effect=fake_auth_status):
            with self.client.stream(
                "POST",
                "/api/studio/run",
                data={"message": "create verification source image"},
            ) as response:
                self.assertEqual(response.status_code, 200)
                source_events = _sse_events("".join(response.iter_text()))

            source_meta = next(payload for name, payload in source_events if name == "meta")
            source_execution = next(payload for name, payload in source_events if name == "execution_request")
            source_url = "https://example.com/verify-source.png"
            update = self.client.post(
                f"/api/studio/projects/{source_meta['projectId']}/client-result",
                json={
                    "segmentId": source_execution["segmentId"],
                    "jobId": source_execution["jobId"],
                    "status": "done",
                    "taskId": "task_verify_source",
                    "url": source_url,
                    "posterUrl": source_url,
                },
            )
            self.assertEqual(update.status_code, 200)

            verified = self.client.post(
                "/api/studio/coverage/verify",
                json={
                    "project_id": source_meta["projectId"],
                    "source_segment_id": source_execution["segmentId"],
                },
            )

        self.assertEqual(verified.status_code, 200)
        body = verified.json()
        created_page_ids = {job["pageId"] for job in body["jobs"]}
        skipped_by_id = {page["pageId"]: page for page in body["skippedPages"]}

        self.assertEqual(body["project"]["projectId"], source_meta["projectId"])
        self.assertEqual(body["coverage"]["sourceSegmentId"], source_execution["segmentId"])
        self.assertEqual(body["coverage"]["sourceMediaUrl"], source_url)
        self.assertGreaterEqual(body["createdCount"], 10)
        self.assertEqual(body["createdCount"], len(body["jobs"]))
        self.assertIn("library", created_page_ids)
        self.assertIn("tag-generator", created_page_ids)
        self.assertIn("bot-detail", created_page_ids)
        self.assertNotIn("myshell-art", created_page_ids)
        self.assertIn("myshell-art", skipped_by_id)
        self.assertEqual(skipped_by_id["myshell-art"]["reason"], "not_ready")

        tag_job = next(job for job in body["jobs"] if job["pageId"] == "tag-generator")
        self.assertEqual(tag_job["status"], "done")
        self.assertEqual(tag_job["evidence"]["accepted"], True)
        self.assertEqual(tag_job["evidence"]["pageId"], "tag-generator")
        self.assertEqual(tag_job["evidence"]["missingRouteParams"], [])
        self.assertIn("img=https%3A%2F%2Fexample.com%2Fverify-source.png", tag_job["navigationPath"])
        self.assertFalse(tag_job["evidence"].get("mediaUrl", "").startswith("/gallery"))
        self.assertGreaterEqual(body["coverage"]["summary"]["covered"], body["createdCount"] + 1)

    def test_coverage_verify_skips_contextual_pages_without_source_media(self) -> None:
        def fake_auth_status(page_id: str) -> dict:
            if page_id == "myshell-art":
                return {"status": "auth_missing", "mode": "browser-cookies", "message": "Missing MyShell cookies"}
            return {"status": "client_delegated", "mode": "telegram-init-data", "message": "Client delegated"}

        with patch("studio_app.infrastructure.runtime.health.adapter_auth_status", side_effect=fake_auth_status):
            verified = self.client.post("/api/studio/coverage/verify", json={})

        self.assertEqual(verified.status_code, 200)
        body = verified.json()
        created_page_ids = {job["pageId"] for job in body["jobs"]}
        skipped_by_id = {page["pageId"]: page for page in body["skippedPages"]}

        self.assertTrue(body["project"]["projectId"].startswith("project_"))
        self.assertGreaterEqual(body["createdCount"], 9)
        self.assertIn("library", created_page_ids)
        self.assertNotIn("tag-generator", created_page_ids)
        self.assertIn("tag-generator", skipped_by_id)
        self.assertEqual(skipped_by_id["tag-generator"]["reason"], "missing_params")
        self.assertEqual(skipped_by_id["tag-generator"]["missingRouteParams"], ["img"])
        self.assertIn("myshell-art", skipped_by_id)
        self.assertEqual(skipped_by_id["myshell-art"]["reason"], "not_ready")

    def test_handoff_snapshot_packages_delivery_evidence_and_actions(self) -> None:
        def fake_auth_status(page_id: str) -> dict:
            if page_id == "myshell-art":
                return {"status": "auth_missing", "mode": "browser-cookies", "message": "Missing MyShell cookies"}
            return {"status": "client_delegated", "mode": "telegram-init-data", "message": "Client delegated"}

        with patch("studio_app.infrastructure.runtime.health.adapter_auth_status", side_effect=fake_auth_status):
            with self.client.stream(
                "POST",
                "/api/studio/run",
                data={"message": "create handoff source image"},
            ) as response:
                self.assertEqual(response.status_code, 200)
                source_events = _sse_events("".join(response.iter_text()))

            source_meta = next(payload for name, payload in source_events if name == "meta")
            source_execution = next(payload for name, payload in source_events if name == "execution_request")
            source_url = "https://example.com/handoff-source.png"
            update = self.client.post(
                f"/api/studio/projects/{source_meta['projectId']}/client-result",
                json={
                    "segmentId": source_execution["segmentId"],
                    "jobId": source_execution["jobId"],
                    "status": "done",
                    "taskId": "task_handoff_source",
                    "url": source_url,
                    "posterUrl": source_url,
                },
            )
            self.assertEqual(update.status_code, 200)
            verified = self.client.post(
                "/api/studio/coverage/verify",
                json={
                    "project_id": source_meta["projectId"],
                    "source_segment_id": source_execution["segmentId"],
                },
            )
            self.assertEqual(verified.status_code, 200)

            snapshot = self.client.get(
                "/api/studio/handoff-snapshot",
                params={"project_id": source_meta["projectId"], "source_segment_id": source_execution["segmentId"]},
            )

        self.assertEqual(snapshot.status_code, 200)
        self.assertEqual(snapshot.headers.get("content-type", "").split(";")[0], "application/json")
        body = snapshot.json()
        self.assertEqual(body["projectId"], source_meta["projectId"])
        self.assertEqual(body["sourceSegmentId"], source_execution["segmentId"])
        self.assertEqual(body["status"], "blocked")
        self.assertFalse(body["readyForDelivery"])

        summary = body["summary"]
        self.assertEqual(summary["pages"], 17)
        self.assertGreaterEqual(summary["covered"], 16)
        self.assertEqual(summary["readyUnverified"], 0)
        self.assertEqual(summary["blocked"], 1)
        self.assertGreaterEqual(summary["acceptedEvidence"], 16)
        self.assertGreaterEqual(summary["jobs"], 16)

        report_keys = set(body["reports"].keys())
        self.assertTrue(
            {
                "health",
                "readiness",
                "overview",
                "dispatchMatrix",
                "coverage",
                "deliveryReport",
            }.issubset(report_keys)
        )
        artifact_endpoints = {artifact["endpoint"] for artifact in body["artifacts"]}
        self.assertIn("/api/studio/coverage", artifact_endpoints)
        self.assertIn("/api/studio/projects/{project_id}/delivery-report", artifact_endpoints)
        artifact_urls = {artifact["id"]: artifact.get("url") for artifact in body["artifacts"]}
        self.assertTrue(all(artifact_urls.values()), artifact_urls)
        self.assertEqual(
            artifact_urls["handoff-snapshot"],
            f"/api/studio/handoff-snapshot?project_id={source_meta['projectId']}&source_segment_id={source_execution['segmentId']}",
        )
        self.assertEqual(
            artifact_urls["delivery-report"],
            f"/api/studio/projects/{source_meta['projectId']}/delivery-report",
        )
        self.assertNotIn("{project_id}", str(artifact_urls))

        gap_by_page = {gap.get("pageId"): gap for gap in body["gaps"] if gap.get("pageId")}
        self.assertIn("myshell-art", gap_by_page)
        self.assertEqual(gap_by_page["myshell-art"]["status"], "blocked")
        self.assertEqual(gap_by_page["myshell-art"]["reason"], "auth_missing")

        action_by_target = {action.get("targetId"): action for action in body["actions"] if action.get("targetId")}
        self.assertIn("myshell-art", action_by_target)
        self.assertEqual(action_by_target["myshell-art"]["action"], "restore-auth")
        self.assertEqual(action_by_target["myshell-art"]["next"]["env"], "MYSHELL_COOKIES")
        self.assertIn("Restore MyShell auth", action_by_target["myshell-art"]["next"]["label"])

    def test_dispatch_batch_plans_ready_targets_and_skips_blocked_pages(self) -> None:
        def fake_auth_status(page_id: str) -> dict:
            if page_id == "myshell-art":
                return {"status": "auth_missing", "mode": "browser-cookies", "message": "Missing MyShell cookies"}
            return {"status": "client_delegated", "mode": "telegram-init-data", "message": "Client delegated"}

        with patch("studio_app.infrastructure.runtime.health.adapter_auth_status", side_effect=fake_auth_status):
            with self.client.stream(
                "POST",
                "/api/studio/run",
                data={"message": "create batch dispatch source image"},
            ) as response:
                self.assertEqual(response.status_code, 200)
                source_events = _sse_events("".join(response.iter_text()))

            source_meta = next(payload for name, payload in source_events if name == "meta")
            source_execution = next(payload for name, payload in source_events if name == "execution_request")
            source_url = "https://example.com/dispatch-batch-source.png"
            update = self.client.post(
                f"/api/studio/projects/{source_meta['projectId']}/client-result",
                json={
                    "segmentId": source_execution["segmentId"],
                    "jobId": source_execution["jobId"],
                    "status": "done",
                    "taskId": "task_dispatch_batch_source",
                    "url": source_url,
                    "posterUrl": source_url,
                },
            )
            self.assertEqual(update.status_code, 200)

            planned = self.client.post(
                "/api/studio/dispatch-batch",
                json={
                    "project_id": source_meta["projectId"],
                    "source_segment_id": source_execution["segmentId"],
                    "limit": 50,
                },
            )

        self.assertEqual(planned.status_code, 200)
        self.assertEqual(planned.headers.get("content-type", "").split(";")[0], "application/json")
        body = planned.json()
        self.assertEqual(body["projectId"], source_meta["projectId"])
        self.assertEqual(body["sourceSegmentId"], source_execution["segmentId"])
        self.assertEqual(body["sourceMediaUrl"], source_url)
        self.assertEqual(body["status"], "planned")
        self.assertTrue(body["readyForDispatch"])
        self.assertEqual(body["summary"]["total"], 17)
        self.assertGreaterEqual(body["summary"]["planned"], 16)
        self.assertEqual(body["summary"]["skipped"], 1)
        self.assertEqual(body["summary"]["server"], 0)
        self.assertGreaterEqual(body["summary"]["navigation"], 15)
        self.assertGreaterEqual(body["summary"]["client"], 1)

        target_by_page = {target["pageId"]: target for target in body["targets"]}
        self.assertIn("dreamy-miniapp", target_by_page)
        self.assertEqual(target_by_page["dreamy-miniapp"]["recommendedAction"], "execute-client")
        self.assertIn("library", target_by_page)
        self.assertEqual(target_by_page["library"]["recommendedAction"], "navigate")
        self.assertEqual(target_by_page["library"]["navigationPath"], "/library")
        self.assertIn("canvaspro", target_by_page)
        self.assertEqual(target_by_page["canvaspro"]["recommendedAction"], "navigate")
        self.assertEqual(target_by_page["canvaspro"]["navigationPath"], "/dreamy?workspace=canvaspro")
        self.assertIn("tag-generator", target_by_page)
        self.assertIn("img=https%3A%2F%2Fexample.com%2Fdispatch-batch-source.png", target_by_page["tag-generator"]["navigationPath"])
        self.assertEqual(target_by_page["tag-generator"]["clientAction"], "navigate")

        skipped_by_page = {target["pageId"]: target for target in body["skippedTargets"]}
        self.assertIn("myshell-art", skipped_by_page)
        self.assertEqual(skipped_by_page["myshell-art"]["reason"], "auth_missing")
        self.assertEqual(skipped_by_page["myshell-art"]["recommendedAction"], "execute-server")

        self.assertEqual(body["handoffSnapshot"]["status"], "blocked")
        self.assertEqual(body["handoffSnapshot"]["summary"]["readyUnverified"], 15)

    def test_dispatch_batch_can_exclude_already_covered_pages_for_resume(self) -> None:
        def fake_auth_status(page_id: str) -> dict:
            if page_id == "myshell-art":
                return {"status": "auth_missing", "mode": "browser-cookies", "message": "Missing MyShell cookies"}
            return {"status": "client_delegated", "mode": "telegram-init-data", "message": "Client delegated"}

        with patch("studio_app.infrastructure.runtime.health.adapter_auth_status", side_effect=fake_auth_status):
            with self.client.stream(
                "POST",
                "/api/studio/run",
                data={"message": "create remaining dispatch source image"},
            ) as response:
                self.assertEqual(response.status_code, 200)
                source_events = _sse_events("".join(response.iter_text()))

            source_meta = next(payload for name, payload in source_events if name == "meta")
            source_execution = next(payload for name, payload in source_events if name == "execution_request")
            update = self.client.post(
                f"/api/studio/projects/{source_meta['projectId']}/client-result",
                json={
                    "segmentId": source_execution["segmentId"],
                    "jobId": source_execution["jobId"],
                    "status": "done",
                    "taskId": "task_remaining_dispatch_source",
                    "url": "https://example.com/remaining-dispatch-source.png",
                    "posterUrl": "https://example.com/remaining-dispatch-source.png",
                },
            )
            self.assertEqual(update.status_code, 200)

            verified = self.client.post(
                "/api/studio/coverage/verify",
                json={
                    "project_id": source_meta["projectId"],
                    "source_segment_id": source_execution["segmentId"],
                    "page_ids": ["explore", "ai-picks"],
                },
            )
            self.assertEqual(verified.status_code, 200)

            planned = self.client.post(
                "/api/studio/dispatch-batch",
                json={
                    "project_id": source_meta["projectId"],
                    "source_segment_id": source_execution["segmentId"],
                    "exclude_covered": True,
                    "limit": 50,
                },
            )

        self.assertEqual(planned.status_code, 200)
        body = planned.json()
        target_by_page = {target["pageId"]: target for target in body["targets"]}
        self.assertNotIn("explore", target_by_page)
        self.assertNotIn("ai-picks", target_by_page)

        skipped_by_page = {target["pageId"]: target for target in body["skippedTargets"]}
        self.assertEqual(skipped_by_page["explore"]["reason"], "already_covered")
        self.assertEqual(skipped_by_page["ai-picks"]["reason"], "already_covered")
        self.assertEqual(skipped_by_page["explore"]["coverageStatus"], "covered")
        self.assertGreaterEqual(body["summary"]["coveredSkipped"], 2)
        self.assertEqual(body["excludeCovered"], True)

    def test_dispatch_session_persists_next_target_and_completion(self) -> None:
        def fake_auth_status(page_id: str) -> dict:
            if page_id == "myshell-art":
                return {"status": "auth_missing", "mode": "browser-cookies", "message": "Missing MyShell cookies"}
            return {"status": "client_delegated", "mode": "telegram-init-data", "message": "Client delegated"}

        with patch("studio_app.infrastructure.runtime.health.adapter_auth_status", side_effect=fake_auth_status):
            with self.client.stream(
                "POST",
                "/api/studio/run",
                data={"message": "create dispatch session source image"},
            ) as response:
                self.assertEqual(response.status_code, 200)
                source_events = _sse_events("".join(response.iter_text()))

            source_meta = next(payload for name, payload in source_events if name == "meta")
            source_execution = next(payload for name, payload in source_events if name == "execution_request")
            source_url = "https://example.com/dispatch-session-source.png"
            update = self.client.post(
                f"/api/studio/projects/{source_meta['projectId']}/client-result",
                json={
                    "segmentId": source_execution["segmentId"],
                    "jobId": source_execution["jobId"],
                    "status": "done",
                    "taskId": "task_dispatch_session_source",
                    "url": source_url,
                    "posterUrl": source_url,
                },
            )
            self.assertEqual(update.status_code, 200)

            created = self.client.post(
                "/api/studio/dispatch-sessions",
                json={
                    "project_id": source_meta["projectId"],
                    "source_segment_id": source_execution["segmentId"],
                    "limit": 50,
                },
            )

        self.assertEqual(created.status_code, 200)
        session = created.json()
        self.assertTrue(session["sessionId"].startswith("dispatch_session_"))
        self.assertEqual(session["status"], "active")
        self.assertEqual(session["projectId"], source_meta["projectId"])
        self.assertEqual(session["sourceSegmentId"], source_execution["segmentId"])
        self.assertEqual(session["sourceMediaUrl"], source_url)
        self.assertEqual(session["summary"]["pending"], session["summary"]["planned"])
        self.assertEqual(session["summary"]["visited"], 0)
        self.assertEqual(session["summary"]["completed"], 0)
        self.assertGreaterEqual(session["summary"]["planned"], 16)
        self.assertEqual(session["summary"]["blocked"], 1)
        self.assertIsNotNone(session["nextTarget"])

        first_target = session["nextTarget"]
        self.assertEqual(first_target["status"], "pending")
        first_target_id = first_target["id"]

        visited = self.client.post(
            f"/api/studio/dispatch-sessions/{session['sessionId']}/targets/{first_target_id}",
            json={"status": "visited", "evidence": {"openedFrom": "studio-test", "browserUrl": "/library"}},
        )
        self.assertEqual(visited.status_code, 200)
        visited_body = visited.json()
        self.assertEqual(visited_body["summary"]["visited"], 1)
        self.assertEqual(visited_body["summary"]["pending"], session["summary"]["planned"] - 1)
        self.assertNotEqual(visited_body["nextTarget"]["id"], first_target_id)

        completed = self.client.post(
            f"/api/studio/dispatch-sessions/{session['sessionId']}/targets/{first_target_id}",
            json={"status": "completed", "evidence": {"accepted": True}},
        )
        self.assertEqual(completed.status_code, 200)
        completed_body = completed.json()
        self.assertEqual(completed_body["summary"]["visited"], 0)
        self.assertEqual(completed_body["summary"]["completed"], 1)
        completed_target = next(target for target in completed_body["targets"] if target["id"] == first_target_id)
        self.assertEqual(completed_target["evidence"]["accepted"], True)
        self.assertEqual(completed_target["evidence"]["openedFrom"], "studio-test")
        self.assertEqual(completed_target["evidence"]["browserUrl"], "/library")
        self.assertTrue(completed_target["evidenceJobId"].startswith("job_"))

        covered_jobs = self.client.get(
            "/api/studio/jobs",
            params={"project_id": source_meta["projectId"], "page_id": first_target["pageId"]},
        )
        self.assertEqual(covered_jobs.status_code, 200)
        completed_page_jobs = [
            job for job in covered_jobs.json()["jobs"] if job.get("evidence", {}).get("accepted")
        ]
        self.assertTrue(completed_page_jobs)
        self.assertEqual(completed_page_jobs[0]["status"], "done")
        self.assertEqual(completed_page_jobs[0]["evidence"]["dispatchSessionId"], session["sessionId"])
        self.assertEqual(completed_page_jobs[0]["evidence"]["dispatchTargetId"], first_target_id)
        self.assertEqual(completed_page_jobs[0]["evidence"]["operatorEvidence"]["openedFrom"], "studio-test")
        self.assertEqual(completed_page_jobs[0]["evidence"]["operatorEvidence"]["browserUrl"], "/library")

        coverage = self.client.get(
            "/api/studio/coverage",
            params={"project_id": source_meta["projectId"], "source_segment_id": source_execution["segmentId"]},
        )
        self.assertEqual(coverage.status_code, 200)
        covered_page = next(page for page in coverage.json()["pages"] if page["pageId"] == first_target["pageId"])
        self.assertEqual(covered_page["coverageStatus"], "covered")

        PROJECTS.clear()
        restored = self.client.get(f"/api/studio/dispatch-sessions/{session['sessionId']}")
        self.assertEqual(restored.status_code, 200)
        restored_body = restored.json()
        self.assertEqual(restored_body["summary"]["completed"], 1)
        restored_target = next(target for target in restored_body["targets"] if target["id"] == first_target_id)
        self.assertEqual(restored_target["status"], "completed")
        skipped_by_page = {target["pageId"]: target for target in restored_body["skippedTargets"]}
        self.assertEqual(skipped_by_page["myshell-art"]["reason"], "auth_missing")

        focused = self.client.get(
            f"/api/studio/dispatch-sessions/{session['sessionId']}",
            params={"target_id": first_target_id},
        )
        self.assertEqual(focused.status_code, 200)
        focused_body = focused.json()
        expected_focus_index = next(
            index for index, target in enumerate(restored_body["targets"]) if target["id"] == first_target_id
        )
        self.assertEqual(focused_body["focusedTargetId"], first_target_id)
        self.assertEqual(focused_body["focusedTarget"]["id"], first_target_id)
        self.assertEqual(focused_body["focusedTarget"]["status"], "completed")
        self.assertEqual(focused_body["focusedTargetIndex"], expected_focus_index)

    def test_dispatch_session_cancel_marks_unfinished_targets_and_persists(self) -> None:
        def fake_auth_status(page_id: str) -> dict:
            if page_id == "myshell-art":
                return {"status": "auth_missing", "mode": "browser-cookies", "message": "Missing MyShell cookies"}
            return {"status": "client_delegated", "mode": "telegram-init-data", "message": "Client delegated"}

        with patch("studio_app.infrastructure.runtime.health.adapter_auth_status", side_effect=fake_auth_status):
            with self.client.stream(
                "POST",
                "/api/studio/run",
                data={"message": "create cancellable dispatch source image"},
            ) as response:
                self.assertEqual(response.status_code, 200)
                source_events = _sse_events("".join(response.iter_text()))

            source_meta = next(payload for name, payload in source_events if name == "meta")
            source_execution = next(payload for name, payload in source_events if name == "execution_request")
            source_url = "https://example.com/cancellable-dispatch-source.png"
            update = self.client.post(
                f"/api/studio/projects/{source_meta['projectId']}/client-result",
                json={
                    "segmentId": source_execution["segmentId"],
                    "jobId": source_execution["jobId"],
                    "status": "done",
                    "taskId": "task_cancellable_dispatch_source",
                    "url": source_url,
                    "posterUrl": source_url,
                },
            )
            self.assertEqual(update.status_code, 200)

            created = self.client.post(
                "/api/studio/dispatch-sessions",
                json={
                    "project_id": source_meta["projectId"],
                    "source_segment_id": source_execution["segmentId"],
                    "limit": 50,
                },
            )
            self.assertEqual(created.status_code, 200)
            session = created.json()
            first_target = session["nextTarget"]
            second_target = next(target for target in session["targets"] if target["id"] != first_target["id"])

            self.client.post(
                f"/api/studio/dispatch-sessions/{session['sessionId']}/targets/{first_target['id']}",
                json={"status": "visited", "evidence": {"openedFrom": "cancel-test"}},
            )
            completed = self.client.post(
                f"/api/studio/dispatch-sessions/{session['sessionId']}/targets/{second_target['id']}",
                json={"status": "completed", "evidence": {"accepted": True, "completedFrom": "cancel-test"}},
            )
            self.assertEqual(completed.status_code, 200)

            cancelled = self.client.post(f"/api/studio/dispatch-sessions/{session['sessionId']}/cancel")

        self.assertEqual(cancelled.status_code, 200)
        body = cancelled.json()
        self.assertEqual(body["status"], "cancelled")
        self.assertFalse(body["readyForDispatch"])
        self.assertIsNone(body["nextTarget"])
        self.assertEqual(body["summary"]["pending"], 0)
        self.assertEqual(body["summary"]["visited"], 0)
        self.assertEqual(body["summary"]["completed"], 1)
        self.assertEqual(body["summary"]["targetCancelled"], body["summary"]["planned"] - 1)

        targets = {target["id"]: target for target in body["targets"]}
        self.assertEqual(targets[first_target["id"]]["status"], "cancelled")
        self.assertEqual(targets[first_target["id"]]["evidence"]["openedFrom"], "cancel-test")
        self.assertEqual(targets[first_target["id"]]["evidence"]["cancelledFrom"], "studio")
        self.assertEqual(targets[second_target["id"]]["status"], "completed")

        PROJECTS.clear()
        restored = self.client.get(f"/api/studio/dispatch-sessions/{session['sessionId']}")
        self.assertEqual(restored.status_code, 200)
        restored_body = restored.json()
        self.assertEqual(restored_body["status"], "cancelled")
        self.assertEqual(restored_body["summary"]["targetCancelled"], body["summary"]["targetCancelled"])
        self.assertIsNone(restored_body["nextTarget"])

        bundle = self.client.get(
            f"/api/studio/projects/{source_meta['projectId']}/delivery-bundle",
            params={"source_segment_id": source_execution["segmentId"]},
        )
        self.assertEqual(bundle.status_code, 200)
        bundle_body = bundle.json()
        self.assertEqual(bundle_body["summary"]["cancelledTargets"], body["summary"]["targetCancelled"])
        self.assertEqual(bundle_body["targetStatusCounts"]["cancelled"], body["summary"]["targetCancelled"])
        self.assertEqual(len(bundle_body["cancelledTargets"]), body["summary"]["targetCancelled"])
        self.assertTrue(all(target["status"] == "cancelled" for target in bundle_body["cancelledTargets"]))

    def test_audit_actions_can_retry_cancelled_dispatch_targets(self) -> None:
        def fake_auth_status(page_id: str) -> dict:
            if page_id == "myshell-art":
                return {"status": "auth_missing", "mode": "browser-cookies", "message": "Missing MyShell cookies"}
            return {"status": "client_delegated", "mode": "telegram-init-data", "message": "Client delegated"}

        with patch("studio_app.infrastructure.runtime.health.adapter_auth_status", side_effect=fake_auth_status):
            with self.client.stream(
                "POST",
                "/api/studio/run",
                data={"message": "create cancelled dispatch retry source image"},
            ) as response:
                self.assertEqual(response.status_code, 200)
                events = _sse_events("".join(response.iter_text()))

            meta = next(payload for name, payload in events if name == "meta")
            execution = next(payload for name, payload in events if name == "execution_request")
            source_url = "https://example.com/cancelled-dispatch-retry-source.png"
            update = self.client.post(
                f"/api/studio/projects/{meta['projectId']}/client-result",
                json={
                    "segmentId": execution["segmentId"],
                    "jobId": execution["jobId"],
                    "status": "done",
                    "taskId": "task_cancelled_dispatch_retry_source",
                    "url": source_url,
                    "posterUrl": source_url,
                },
            )
            self.assertEqual(update.status_code, 200)

            session_response = self.client.post(
                "/api/studio/dispatch-sessions",
                json={
                    "project_id": meta["projectId"],
                    "source_segment_id": execution["segmentId"],
                    "page_ids": ["explore"],
                    "limit": 1,
                },
            )
            self.assertEqual(session_response.status_code, 200)
            session = session_response.json()
            target = session["nextTarget"]
            cancelled = self.client.post(f"/api/studio/dispatch-sessions/{session['sessionId']}/cancel")
            self.assertEqual(cancelled.status_code, 200)

            handoff = self.client.get(
                "/api/studio/handoff-snapshot",
                params={"project_id": meta["projectId"], "source_segment_id": execution["segmentId"]},
            )
            audit = self.client.get(
                "/api/studio/delivery-audit",
                params={"project_id": meta["projectId"], "source_segment_id": execution["segmentId"]},
            )
            batch_retry = self.client.post(
                "/api/studio/actions/resolve-batch",
                json={
                    "project_id": meta["projectId"],
                    "source_segment_id": execution["segmentId"],
                    "actions": [
                        {
                            "action": "retry-queue",
                            "target_id": target["id"],
                            "session_id": session["sessionId"],
                        }
                    ],
                },
            )
            self.assertEqual(batch_retry.status_code, 200)

            second_session_response = self.client.post(
                "/api/studio/dispatch-sessions",
                json={
                    "project_id": meta["projectId"],
                    "source_segment_id": execution["segmentId"],
                    "page_ids": ["library"],
                    "limit": 1,
                },
            )
            self.assertEqual(second_session_response.status_code, 200)
            second_session = second_session_response.json()
            second_target = second_session["nextTarget"]
            second_cancelled = self.client.post(f"/api/studio/dispatch-sessions/{second_session['sessionId']}/cancel")
            self.assertEqual(second_cancelled.status_code, 200)
            single_retry = self.client.post(
                "/api/studio/actions/resolve",
                json={
                    "action": "retry-queue",
                    "target_id": second_target["id"],
                    "session_id": second_session["sessionId"],
                    "project_id": meta["projectId"],
                    "source_segment_id": execution["segmentId"],
                },
            )

        expected_gap_id = f"dispatch-session:{session['sessionId']}:{target['id']}"
        expected_retry_action_id = f"dispatch-target:retry-queue:{session['sessionId']}:{target['id']}"
        expected_run_action_id = f"dispatch-target:run-target:{session['sessionId']}:{target['id']}"
        expected_ui_url = f"/dreamy?dispatch_session_id={session['sessionId']}&target_id=dispatch%3Aexplore"

        self.assertEqual(handoff.status_code, 200)
        handoff_body = handoff.json()
        handoff_gap_by_id = {gap["id"]: gap for gap in handoff_body["gaps"]}
        self.assertIn(expected_gap_id, handoff_gap_by_id)
        self.assertEqual(handoff_gap_by_id[expected_gap_id]["status"], "cancelled")
        self.assertEqual(handoff_gap_by_id[expected_gap_id]["reason"], "cancelled")
        self.assertIn("retry", handoff_gap_by_id[expected_gap_id]["message"].lower())
        handoff_action_by_id = {action["id"]: action for action in handoff_body["actions"]}
        self.assertIn(expected_retry_action_id, handoff_action_by_id)
        self.assertEqual(handoff_action_by_id[expected_retry_action_id]["action"], "retry-queue")
        self.assertEqual(handoff_action_by_id[expected_retry_action_id]["uiUrl"], expected_ui_url)

        self.assertEqual(audit.status_code, 200)
        audit_action_by_id = {action["id"]: action for action in audit.json()["actions"]}
        self.assertIn(expected_retry_action_id, audit_action_by_id)
        self.assertEqual(audit_action_by_id[expected_retry_action_id]["action"], "retry-queue")

        batch_body = batch_retry.json()
        self.assertEqual(batch_body["status"], "executed")
        self.assertEqual(batch_body["summary"]["executed"], 1)
        self.assertEqual(batch_body["executedActions"][0]["action"], "retry-queue")
        self.assertEqual(batch_body["executedActions"][0]["resultType"], "dispatch-session-retry")
        retried_session = batch_body["executedActions"][0]["result"]["session"]
        self.assertEqual(retried_session["summary"]["pending"], 1)
        self.assertEqual(retried_session["nextTarget"]["id"], target["id"])
        post_retry_action_by_id = {action["id"]: action for action in batch_body["audit"]["actions"]}
        self.assertIn(expected_run_action_id, post_retry_action_by_id)

        self.assertEqual(single_retry.status_code, 200)
        single_body = single_retry.json()
        self.assertEqual(single_body["status"], "executed")
        self.assertEqual(single_body["resultType"], "dispatch-session-retry")
        self.assertEqual(single_body["result"]["session"]["summary"]["pending"], 1)
        self.assertEqual(single_body["result"]["session"]["nextTarget"]["id"], second_target["id"])

    def test_dispatch_session_retry_reopens_cancelled_and_error_targets(self) -> None:
        def fake_auth_status(page_id: str) -> dict:
            if page_id == "myshell-art":
                return {"status": "auth_missing", "mode": "browser-cookies", "message": "Missing MyShell cookies"}
            return {"status": "client_delegated", "mode": "telegram-init-data", "message": "Client delegated"}

        with patch("studio_app.infrastructure.runtime.health.adapter_auth_status", side_effect=fake_auth_status):
            with self.client.stream(
                "POST",
                "/api/studio/run",
                data={"message": "create retryable dispatch source image"},
            ) as response:
                self.assertEqual(response.status_code, 200)
                source_events = _sse_events("".join(response.iter_text()))

            source_meta = next(payload for name, payload in source_events if name == "meta")
            source_execution = next(payload for name, payload in source_events if name == "execution_request")
            source_url = "https://example.com/retryable-dispatch-source.png"
            update = self.client.post(
                f"/api/studio/projects/{source_meta['projectId']}/client-result",
                json={
                    "segmentId": source_execution["segmentId"],
                    "jobId": source_execution["jobId"],
                    "status": "done",
                    "taskId": "task_retryable_dispatch_source",
                    "url": source_url,
                    "posterUrl": source_url,
                },
            )
            self.assertEqual(update.status_code, 200)

            created = self.client.post(
                "/api/studio/dispatch-sessions",
                json={
                    "project_id": source_meta["projectId"],
                    "source_segment_id": source_execution["segmentId"],
                    "limit": 50,
                },
            )
            self.assertEqual(created.status_code, 200)
            session = created.json()
            first_target = session["nextTarget"]
            second_target = next(target for target in session["targets"] if target["id"] != first_target["id"])
            third_target = next(
                target
                for target in session["targets"]
                if target["id"] not in {first_target["id"], second_target["id"]}
            )

            completed = self.client.post(
                f"/api/studio/dispatch-sessions/{session['sessionId']}/targets/{first_target['id']}",
                json={"status": "completed", "evidence": {"accepted": True, "completedFrom": "retry-test"}},
            )
            self.assertEqual(completed.status_code, 200)
            errored = self.client.post(
                f"/api/studio/dispatch-sessions/{session['sessionId']}/targets/{second_target['id']}",
                json={"status": "error", "evidence": {"message": "temporary page issue"}},
            )
            self.assertEqual(errored.status_code, 200)
            opened = self.client.post(
                f"/api/studio/dispatch-sessions/{session['sessionId']}/targets/{third_target['id']}",
                json={"status": "visited", "evidence": {"openedFrom": "retry-test"}},
            )
            self.assertEqual(opened.status_code, 200)
            cancelled = self.client.post(f"/api/studio/dispatch-sessions/{session['sessionId']}/cancel")
            self.assertEqual(cancelled.status_code, 200)

            retried = self.client.post(f"/api/studio/dispatch-sessions/{session['sessionId']}/retry")

        self.assertEqual(retried.status_code, 200)
        body = retried.json()
        self.assertEqual(body["status"], "active")
        self.assertTrue(body["readyForDispatch"])
        self.assertEqual(body["summary"]["completed"], 1)
        self.assertEqual(body["summary"]["targetErrors"], 0)
        self.assertEqual(body["summary"]["targetCancelled"], 0)
        self.assertEqual(body["summary"]["pending"], body["summary"]["planned"] - 1)
        self.assertEqual(body["retryCount"], 1)
        self.assertIsNotNone(body["nextTarget"])

        targets = {target["id"]: target for target in body["targets"]}
        self.assertEqual(targets[first_target["id"]]["status"], "completed")
        self.assertEqual(targets[first_target["id"]]["evidence"]["completedFrom"], "retry-test")
        self.assertEqual(targets[second_target["id"]]["status"], "pending")
        self.assertEqual(targets[second_target["id"]]["evidence"]["message"], "temporary page issue")
        self.assertEqual(targets[second_target["id"]]["evidence"]["retriedFrom"], "error")
        self.assertEqual(targets[third_target["id"]]["status"], "pending")
        self.assertEqual(targets[third_target["id"]]["evidence"]["openedFrom"], "retry-test")
        self.assertEqual(targets[third_target["id"]]["evidence"]["cancelledFrom"], "studio")
        self.assertEqual(targets[third_target["id"]]["evidence"]["retriedFrom"], "cancelled")

        PROJECTS.clear()
        restored = self.client.get(f"/api/studio/dispatch-sessions/{session['sessionId']}")
        self.assertEqual(restored.status_code, 200)
        restored_body = restored.json()
        self.assertEqual(restored_body["status"], "active")
        self.assertEqual(restored_body["retryCount"], 1)
        self.assertEqual(restored_body["summary"]["pending"], body["summary"]["pending"])

    def test_dispatch_session_run_client_target_returns_execution_request_and_completes(self) -> None:
        with self.client.stream(
            "POST",
            "/api/studio/run",
            data={"message": "create client dispatch queue project"},
        ) as response:
            self.assertEqual(response.status_code, 200)
            source_events = _sse_events("".join(response.iter_text()))

        source_meta = next(payload for name, payload in source_events if name == "meta")
        source_execution = next(payload for name, payload in source_events if name == "execution_request")
        created = self.client.post(
            "/api/studio/dispatch-sessions",
            json={
                "project_id": source_meta["projectId"],
                "source_segment_id": source_execution["segmentId"],
                "page_ids": ["dreamy-miniapp"],
                "limit": 1,
            },
        )
        self.assertEqual(created.status_code, 200)
        session = created.json()
        target = session["nextTarget"]
        self.assertEqual(target["pageId"], "dreamy-miniapp")
        self.assertEqual(target["executor"], "client")

        run = self.client.post(f"/api/studio/dispatch-sessions/{session['sessionId']}/targets/{target['id']}/run")

        self.assertEqual(run.status_code, 200)
        body = run.json()
        self.assertEqual(body["status"], "execution_required")
        self.assertEqual(body["target"]["status"], "visited")
        self.assertEqual(body["session"]["summary"]["visited"], 1)
        self.assertEqual(body["executionRequest"]["executor"], "client")
        self.assertEqual(body["executionRequest"]["api"], "dreamy-miniapp")
        self.assertEqual(body["executionRequest"]["dispatchSessionId"], session["sessionId"])
        self.assertEqual(body["executionRequest"]["dispatchTargetId"], target["id"])
        self.assertEqual(body["job"]["evidence"]["dispatchSessionId"], session["sessionId"])
        self.assertEqual(body["job"]["evidence"]["dispatchTargetId"], target["id"])

        client_result = self.client.post(
            f"/api/studio/projects/{source_meta['projectId']}/client-result",
            json={
                "segmentId": body["executionRequest"]["segmentId"],
                "jobId": body["executionRequest"]["jobId"],
                "dispatchSessionId": session["sessionId"],
                "dispatchTargetId": target["id"],
                "status": "done",
                "taskId": "task_dispatch_client_target",
                "url": "https://example.com/dispatch-client-target.png",
                "posterUrl": "https://example.com/dispatch-client-target.png",
            },
        )
        self.assertEqual(client_result.status_code, 200)

        restored = self.client.get(f"/api/studio/dispatch-sessions/{session['sessionId']}")
        self.assertEqual(restored.status_code, 200)
        restored_body = restored.json()
        completed_target = next(item for item in restored_body["targets"] if item["id"] == target["id"])
        self.assertEqual(completed_target["status"], "completed")
        self.assertEqual(completed_target["jobId"], body["executionRequest"]["jobId"])
        self.assertEqual(completed_target["segmentId"], body["executionRequest"]["segmentId"])
        self.assertEqual(completed_target["evidence"]["accepted"], True)
        self.assertEqual(completed_target["evidence"]["mediaUrl"], "https://example.com/dispatch-client-target.png")
        self.assertEqual(restored_body["summary"]["completed"], 1)

    def test_dispatch_session_run_client_target_creates_project_when_missing(self) -> None:
        created = self.client.post(
            "/api/studio/dispatch-sessions",
            json={
                "page_ids": ["dreamy-miniapp"],
                "limit": 1,
            },
        )
        self.assertEqual(created.status_code, 200)
        session = created.json()
        self.assertIsNone(session["projectId"])
        target = session["nextTarget"]
        self.assertEqual(target["pageId"], "dreamy-miniapp")

        run = self.client.post(f"/api/studio/dispatch-sessions/{session['sessionId']}/targets/{target['id']}/run")

        self.assertEqual(run.status_code, 200)
        body = run.json()
        self.assertEqual(body["status"], "execution_required")
        self.assertTrue(body["project"]["projectId"].startswith("project_"))
        self.assertEqual(body["session"]["projectId"], body["project"]["projectId"])
        self.assertEqual(body["target"]["projectId"], body["project"]["projectId"])
        self.assertEqual(body["executionRequest"]["dispatchSessionId"], session["sessionId"])
        self.assertEqual(body["executionRequest"]["dispatchTargetId"], target["id"])
        self.assertEqual(body["executionRequest"]["executor"], "client")

    def test_run_stream_preserves_selected_agent_id_through_retry(self) -> None:
        with self.client.stream(
            "POST",
            "/api/studio/run",
            data={"message": "plan this segment", "agent_id": "asset-planner"},
        ) as response:
            self.assertEqual(response.status_code, 200)
            events = _sse_events("".join(response.iter_text()))

        route = next(payload for name, payload in events if name == "route")
        execution = next(payload for name, payload in events if name == "execution_request")
        job = next(payload["job"] for name, payload in events if name == "job")

        self.assertEqual(route["agentId"], "asset-planner")
        self.assertEqual(execution["agentId"], "asset-planner")
        self.assertEqual(job["agentId"], "asset-planner")

        retry = self.client.post(f"/api/studio/jobs/{execution['jobId']}/retry")
        self.assertEqual(retry.status_code, 200)
        body = retry.json()
        self.assertEqual(body["job"]["agentId"], "asset-planner")
        self.assertEqual(body["executionRequest"]["agentId"], "asset-planner")

    def test_default_run_infers_navigation_page_from_prompt(self) -> None:
        with self.client.stream(
            "POST",
            "/api/studio/run",
            data={"message": "open my generated library"},
        ) as response:
            self.assertEqual(response.status_code, 200)
            events = _sse_events("".join(response.iter_text()))

        route = next(payload for name, payload in events if name == "route")
        execution = next(payload for name, payload in events if name == "execution_request")
        job_payloads = [payload["job"] for name, payload in events if name == "job"]

        self.assertEqual(route["page"]["id"], "library")
        self.assertEqual(execution["executor"], "navigation")
        self.assertEqual(execution["navigationPath"], "/library")
        self.assertEqual(job_payloads[-1]["status"], "done")

    def test_explicit_navigation_page_selection_wins_over_prompt_inference(self) -> None:
        with self.client.stream(
            "POST",
            "/api/studio/run",
            data={"message": "open my generated library", "page_id": "upload"},
        ) as response:
            self.assertEqual(response.status_code, 200)
            events = _sse_events("".join(response.iter_text()))

        route = next(payload for name, payload in events if name == "route")
        execution = next(payload for name, payload in events if name == "execution_request")

        self.assertEqual(route["page"]["id"], "upload")
        self.assertEqual(execution["executor"], "navigation")
        self.assertTrue(execution["navigationPath"].startswith("/upload?slug_id="), execution["navigationPath"])

    def test_contextual_navigation_pages_include_required_query_params(self) -> None:
        expected = {
            "bot-detail": "/bot?slug_id=",
            "upload": "/upload?slug_id=",
            "tag-generator": "/tag-generator?slug_id=",
        }

        for page_id, prefix in expected.items():
            with self.subTest(page_id=page_id):
                with self.client.stream(
                    "POST",
                    "/api/studio/run",
                    data={"message": "open this tattoo generator", "page_id": page_id},
                ) as response:
                    self.assertEqual(response.status_code, 200)
                    events = _sse_events("".join(response.iter_text()))

                execution = next(payload for name, payload in events if name == "execution_request")
                self.assertEqual(execution["executor"], "navigation")
                self.assertTrue(execution["navigationPath"].startswith(prefix), execution["navigationPath"])
                self.assertIn(execution["botSlug"], execution["navigationPath"])

    def test_navigation_run_with_missing_route_params_records_error_evidence(self) -> None:
        with self.client.stream(
            "POST",
            "/api/studio/run",
            data={"message": "open this tattoo generator", "page_id": "tag-generator"},
        ) as response:
            self.assertEqual(response.status_code, 200)
            events = _sse_events("".join(response.iter_text()))

        execution = next(payload for name, payload in events if name == "execution_request")
        job_payloads = [payload["job"] for name, payload in events if name == "job"]
        done = next(payload for name, payload in events if name == "done")

        self.assertEqual(execution["executor"], "navigation")
        self.assertEqual(execution["missingRouteParams"], ["img"])
        self.assertTrue(execution["navigationPath"].startswith("/tag-generator?slug_id="), execution["navigationPath"])
        self.assertEqual(job_payloads[-1]["status"], "error")
        self.assertFalse(job_payloads[-1]["evidence"]["accepted"])
        self.assertIn("Missing route parameters: img", job_payloads[-1]["evidence"]["message"])
        self.assertEqual(done["status"], "error")

    def test_project_and_job_queue_endpoints_include_evidence_trail(self) -> None:
        with self.client.stream(
            "POST",
            "/api/studio/run",
            data={"message": "queue evidence segment"},
        ) as response:
            events = _sse_events("".join(response.iter_text()))

        meta = next(payload for name, payload in events if name == "meta")
        execution = next(payload for name, payload in events if name == "execution_request")

        projects = self.client.get("/api/studio/projects")
        self.assertEqual(projects.status_code, 200)
        project_ids = [project["projectId"] for project in projects.json()["projects"]]
        self.assertIn(meta["projectId"], project_ids)

        jobs = self.client.get("/api/studio/jobs", params={"status": "queued"})
        self.assertEqual(jobs.status_code, 200)
        queued_job = next(job for job in jobs.json()["jobs"] if job["jobId"] == execution["jobId"])
        self.assertEqual(queued_job["projectId"], meta["projectId"])
        self.assertEqual(queued_job["evidenceTrail"][0]["status"], "queued")

        evidence = self.client.get(f"/api/studio/jobs/{execution['jobId']}/evidence")
        self.assertEqual(evidence.status_code, 200)
        self.assertEqual(evidence.json()["evidence"][0]["status"], "queued")

    def test_project_delivery_report_summarizes_handoff_evidence(self) -> None:
        with self.client.stream(
            "POST",
            "/api/studio/run",
            data={"message": "queue delivery segment"},
        ) as response:
            events = _sse_events("".join(response.iter_text()))

        meta = next(payload for name, payload in events if name == "meta")
        execution = next(payload for name, payload in events if name == "execution_request")

        pending_report = self.client.get(f"/api/studio/projects/{meta['projectId']}/delivery-report")
        self.assertEqual(pending_report.status_code, 200)
        self.assertEqual(pending_report.headers.get("content-type", "").split(";")[0], "application/json")
        pending_body = pending_report.json()
        self.assertEqual(pending_body["projectId"], meta["projectId"])
        self.assertEqual(pending_body["handoffStatus"], "in_progress")
        self.assertFalse(pending_body["readyForHandoff"])
        self.assertEqual(pending_body["summary"]["totalJobs"], 1)
        self.assertEqual(pending_body["summary"]["acceptedEvidence"], 0)
        self.assertEqual(pending_body["summary"]["pendingEvidence"], 1)
        self.assertEqual(pending_body["statusCounts"]["queued"], 1)
        self.assertEqual(pending_body["segments"][0]["jobId"], execution["jobId"])
        self.assertEqual(pending_body["segments"][0]["evidenceTrail"][0]["status"], "queued")
        self.assertEqual(pending_body["unresolvedActions"][0]["action"], "wait-for-adapter")

        done = self.client.post(
            f"/api/studio/projects/{meta['projectId']}/client-result",
            json={
                "segmentId": execution["segmentId"],
                "jobId": execution["jobId"],
                "status": "done",
                "taskId": "task_delivery_done",
                "url": "https://example.com/fresh-delivery.png",
                "posterUrl": "https://example.com/fresh-delivery.png",
            },
        )
        self.assertEqual(done.status_code, 200)

        ready_report = self.client.get(f"/api/studio/projects/{meta['projectId']}/delivery-report")
        self.assertEqual(ready_report.status_code, 200)
        ready_body = ready_report.json()
        self.assertEqual(ready_body["handoffStatus"], "ready")
        self.assertTrue(ready_body["readyForHandoff"])
        self.assertEqual(ready_body["summary"]["acceptedEvidence"], 1)
        self.assertEqual(ready_body["summary"]["pendingEvidence"], 0)
        self.assertEqual(ready_body["summary"]["issueCount"], 0)
        self.assertEqual(ready_body["segments"][0]["evidence"]["mediaUrl"], "https://example.com/fresh-delivery.png")
        self.assertEqual(ready_body["unresolvedActions"], [])

    def test_project_delivery_bundle_packages_sessions_coverage_and_evidence(self) -> None:
        def fake_auth_status(page_id: str) -> dict:
            if page_id == "myshell-art":
                return {"status": "auth_missing", "mode": "browser-cookies", "message": "Missing MyShell cookies"}
            return {"status": "client_delegated", "mode": "telegram-init-data", "message": "Client delegated"}

        with patch("studio_app.infrastructure.runtime.health.adapter_auth_status", side_effect=fake_auth_status):
            with self.client.stream(
                "POST",
                "/api/studio/run",
                data={"message": "create delivery bundle source image"},
            ) as response:
                self.assertEqual(response.status_code, 200)
                events = _sse_events("".join(response.iter_text()))

            meta = next(payload for name, payload in events if name == "meta")
            execution = next(payload for name, payload in events if name == "execution_request")
            update = self.client.post(
                f"/api/studio/projects/{meta['projectId']}/client-result",
                json={
                    "segmentId": execution["segmentId"],
                    "jobId": execution["jobId"],
                    "status": "done",
                    "taskId": "task_delivery_bundle_source",
                    "url": "https://example.com/delivery-bundle-source.png",
                    "posterUrl": "https://example.com/delivery-bundle-source.png",
                },
            )
            self.assertEqual(update.status_code, 200)

            session_response = self.client.post(
                "/api/studio/dispatch-sessions",
                json={
                    "project_id": meta["projectId"],
                    "source_segment_id": execution["segmentId"],
                    "limit": 50,
                },
            )
            self.assertEqual(session_response.status_code, 200)
            session = session_response.json()
            target = session["nextTarget"]
            completed = self.client.post(
                f"/api/studio/dispatch-sessions/{session['sessionId']}/targets/{target['id']}",
                json={"status": "completed", "evidence": {"accepted": True, "completedFrom": "bundle-test"}},
            )
            self.assertEqual(completed.status_code, 200)

            bundle = self.client.get(
                f"/api/studio/projects/{meta['projectId']}/delivery-bundle",
                params={"source_segment_id": execution["segmentId"]},
            )

        self.assertEqual(bundle.status_code, 200)
        self.assertEqual(bundle.headers.get("content-type", "").split(";")[0], "application/json")
        body = bundle.json()
        self.assertEqual(body["projectId"], meta["projectId"])
        self.assertEqual(body["sourceSegmentId"], execution["segmentId"])
        self.assertIn(body["status"], {"ready", "blocked", "needs_attention"})
        self.assertEqual(body["summary"]["dispatchSessions"], 1)
        self.assertEqual(body["summary"]["completedTargets"], 1)
        self.assertGreaterEqual(body["summary"]["pendingTargets"], 10)
        self.assertGreaterEqual(body["summary"]["acceptedJobs"], 2)
        self.assertEqual(body["reports"]["deliveryReport"]["projectId"], meta["projectId"])
        self.assertEqual(body["reports"]["coverage"]["projectId"], meta["projectId"])
        self.assertEqual(body["reports"]["handoffSnapshot"]["projectId"], meta["projectId"])

        first_session = body["dispatchSessions"][0]
        self.assertEqual(first_session["sessionId"], session["sessionId"])
        self.assertEqual(first_session["summary"]["completed"], 1)
        accepted_job_ids = {job["jobId"] for job in body["acceptedJobs"]}
        completed_target = next(item for item in first_session["targets"] if item["id"] == target["id"])
        self.assertIn(completed_target["evidenceJobId"], accepted_job_ids)
        self.assertEqual(completed_target["evidence"]["dispatchSessionId"], session["sessionId"])

        artifact_endpoints = {artifact["endpoint"] for artifact in body["artifacts"]}
        self.assertIn("/api/studio/projects/{project_id}/delivery-bundle", artifact_endpoints)
        self.assertIn("/api/studio/dispatch-sessions/{session_id}", artifact_endpoints)
        artifact_urls = {artifact["id"]: artifact.get("url") for artifact in body["artifacts"]}
        self.assertTrue(all(artifact_urls.values()), artifact_urls)
        self.assertEqual(artifact_urls["project"], f"/api/studio/projects/{meta['projectId']}")
        self.assertEqual(
            artifact_urls["delivery-bundle"],
            f"/api/studio/projects/{meta['projectId']}/delivery-bundle?source_segment_id={execution['segmentId']}",
        )
        self.assertEqual(
            artifact_urls[f"dispatch-session:{session['sessionId']}"],
            f"/api/studio/dispatch-sessions/{session['sessionId']}",
        )
        session_artifact = next(artifact for artifact in body["artifacts"] if artifact["id"] == f"dispatch-session:{session['sessionId']}")
        self.assertEqual(session_artifact["uiUrl"], f"/dreamy?dispatch_session_id={session['sessionId']}")
        target_artifact_id = f"dispatch-target:{session['sessionId']}:{target['id']}"
        self.assertEqual(
            artifact_urls[target_artifact_id],
            f"/api/studio/dispatch-sessions/{session['sessionId']}?target_id=dispatch%3Aexplore",
        )
        target_artifact = next(artifact for artifact in body["artifacts"] if artifact["id"] == target_artifact_id)
        self.assertEqual(target_artifact["targetId"], target["id"])
        self.assertEqual(target_artifact["sessionId"], session["sessionId"])
        self.assertEqual(
            target_artifact["uiUrl"],
            f"/dreamy?dispatch_session_id={session['sessionId']}&target_id=dispatch%3Aexplore",
        )
        self.assertNotIn("{session_id}", str(artifact_urls))

        download = self.client.get(
            f"/api/studio/projects/{meta['projectId']}/delivery-bundle",
            params={"source_segment_id": execution["segmentId"], "download": "1"},
        )
        self.assertEqual(download.status_code, 200)
        self.assertEqual(download.headers.get("content-type", "").split(";")[0], "application/json")
        disposition = download.headers.get("content-disposition", "")
        self.assertIn("attachment", disposition)
        self.assertIn(f"myshell-studio-delivery-{meta['projectId']}.json", disposition)
        download_body = download.json()
        self.assertEqual(download_body["projectId"], meta["projectId"])
        self.assertEqual(download_body["reports"]["handoffSnapshot"]["projectId"], meta["projectId"])

    def test_project_delivery_bundle_keeps_visited_targets_remaining(self) -> None:
        def fake_auth_status(page_id: str) -> dict:
            if page_id == "myshell-art":
                return {"status": "auth_missing", "mode": "browser-cookies", "message": "Missing MyShell cookies"}
            return {"status": "client_delegated", "mode": "telegram-init-data", "message": "Client delegated"}

        with patch("studio_app.infrastructure.runtime.health.adapter_auth_status", side_effect=fake_auth_status):
            with self.client.stream(
                "POST",
                "/api/studio/run",
                data={"message": "create visited remaining source image"},
            ) as response:
                self.assertEqual(response.status_code, 200)
                events = _sse_events("".join(response.iter_text()))

            meta = next(payload for name, payload in events if name == "meta")
            execution = next(payload for name, payload in events if name == "execution_request")
            update = self.client.post(
                f"/api/studio/projects/{meta['projectId']}/client-result",
                json={
                    "segmentId": execution["segmentId"],
                    "jobId": execution["jobId"],
                    "status": "done",
                    "taskId": "task_visited_remaining_source",
                    "url": "https://example.com/visited-remaining-source.png",
                    "posterUrl": "https://example.com/visited-remaining-source.png",
                },
            )
            self.assertEqual(update.status_code, 200)

            session_response = self.client.post(
                "/api/studio/dispatch-sessions",
                json={
                    "project_id": meta["projectId"],
                    "source_segment_id": execution["segmentId"],
                    "limit": 50,
                },
            )
            self.assertEqual(session_response.status_code, 200)
            session = session_response.json()
            visited_target = session["nextTarget"]
            visited = self.client.post(
                f"/api/studio/dispatch-sessions/{session['sessionId']}/targets/{visited_target['id']}",
                json={"status": "visited", "evidence": {"openedFrom": "bundle-remaining-test"}},
            )
            self.assertEqual(visited.status_code, 200)

            bundle = self.client.get(
                f"/api/studio/projects/{meta['projectId']}/delivery-bundle",
                params={"source_segment_id": execution["segmentId"]},
            )

        self.assertEqual(bundle.status_code, 200)
        body = bundle.json()
        self.assertEqual(body["summary"]["visitedTargets"], 1)
        self.assertEqual(
            body["summary"]["remainingTargets"],
            body["summary"]["pendingTargets"] + body["summary"]["visitedTargets"],
        )
        remaining_by_id = {target["id"]: target for target in body["remainingTargets"]}
        self.assertIn(visited_target["id"], remaining_by_id)
        self.assertEqual(remaining_by_id[visited_target["id"]]["status"], "visited")

    def test_handoff_actions_keep_visited_dispatch_targets_visible(self) -> None:
        def fake_auth_status(page_id: str) -> dict:
            if page_id == "myshell-art":
                return {"status": "auth_missing", "mode": "browser-cookies", "message": "Missing MyShell cookies"}
            return {"status": "client_delegated", "mode": "telegram-init-data", "message": "Client delegated"}

        with patch("studio_app.infrastructure.runtime.health.adapter_auth_status", side_effect=fake_auth_status):
            with self.client.stream(
                "POST",
                "/api/studio/run",
                data={"message": "create visited handoff action source image"},
            ) as response:
                self.assertEqual(response.status_code, 200)
                events = _sse_events("".join(response.iter_text()))

            meta = next(payload for name, payload in events if name == "meta")
            execution = next(payload for name, payload in events if name == "execution_request")
            update = self.client.post(
                f"/api/studio/projects/{meta['projectId']}/client-result",
                json={
                    "segmentId": execution["segmentId"],
                    "jobId": execution["jobId"],
                    "status": "done",
                    "taskId": "task_visited_handoff_action_source",
                    "url": "https://example.com/visited-handoff-action-source.png",
                    "posterUrl": "https://example.com/visited-handoff-action-source.png",
                },
            )
            self.assertEqual(update.status_code, 200)

            session_response = self.client.post(
                "/api/studio/dispatch-sessions",
                json={
                    "project_id": meta["projectId"],
                    "source_segment_id": execution["segmentId"],
                    "page_ids": ["explore"],
                    "limit": 1,
                },
            )
            self.assertEqual(session_response.status_code, 200)
            session = session_response.json()
            visited_target = session["nextTarget"]
            visited = self.client.post(
                f"/api/studio/dispatch-sessions/{session['sessionId']}/targets/{visited_target['id']}",
                json={"status": "visited", "evidence": {"openedFrom": "handoff-visited-action-test"}},
            )
            self.assertEqual(visited.status_code, 200)

            handoff = self.client.get(
                "/api/studio/handoff-snapshot",
                params={"project_id": meta["projectId"], "source_segment_id": execution["segmentId"]},
            )
            audit = self.client.get(
                "/api/studio/delivery-audit",
                params={"project_id": meta["projectId"], "source_segment_id": execution["segmentId"]},
            )
            resolved_action = self.client.post(
                "/api/studio/actions/resolve",
                json={
                    "action": "inspect-gap",
                    "target_id": visited_target["id"],
                    "session_id": session["sessionId"],
                    "project_id": meta["projectId"],
                    "source_segment_id": execution["segmentId"],
                },
            )

        expected_gap_id = f"dispatch-session:{session['sessionId']}:{visited_target['id']}"
        expected_action_id = f"dispatch-target:inspect-gap:{session['sessionId']}:{visited_target['id']}"
        expected_ui_url = f"/dreamy?dispatch_session_id={session['sessionId']}&target_id=dispatch%3Aexplore"

        self.assertEqual(handoff.status_code, 200)
        handoff_body = handoff.json()
        handoff_gap_by_id = {gap["id"]: gap for gap in handoff_body["gaps"]}
        self.assertIn(expected_gap_id, handoff_gap_by_id)
        self.assertEqual(handoff_gap_by_id[expected_gap_id]["kind"], "dispatch_target")
        self.assertEqual(handoff_gap_by_id[expected_gap_id]["status"], "visited")
        self.assertEqual(handoff_gap_by_id[expected_gap_id]["reason"], "visited")
        self.assertIn("not been marked", handoff_gap_by_id[expected_gap_id]["message"])
        handoff_action_by_id = {action["id"]: action for action in handoff_body["actions"]}
        self.assertIn(expected_action_id, handoff_action_by_id)
        self.assertEqual(handoff_action_by_id[expected_action_id]["action"], "inspect-gap")
        self.assertEqual(handoff_action_by_id[expected_action_id]["status"], "visited")
        self.assertEqual(handoff_action_by_id[expected_action_id]["uiUrl"], expected_ui_url)

        self.assertEqual(audit.status_code, 200)
        audit_action_by_id = {action["id"]: action for action in audit.json()["actions"]}
        self.assertIn(expected_action_id, audit_action_by_id)
        self.assertEqual(audit_action_by_id[expected_action_id]["uiUrl"], expected_ui_url)

        self.assertEqual(resolved_action.status_code, 200)
        resolved_body = resolved_action.json()
        self.assertEqual(resolved_body["status"], "manual_required")
        self.assertEqual(resolved_body["next"]["uiUrl"], expected_ui_url)
        self.assertEqual(resolved_body["next"]["targetId"], visited_target["id"])
        self.assertEqual(resolved_body["next"]["sessionId"], session["sessionId"])

    def test_project_delivery_bundle_keeps_operator_skipped_targets(self) -> None:
        def fake_auth_status(page_id: str) -> dict:
            if page_id == "myshell-art":
                return {"status": "auth_missing", "mode": "browser-cookies", "message": "Missing MyShell cookies"}
            return {"status": "client_delegated", "mode": "telegram-init-data", "message": "Client delegated"}

        with patch("studio_app.infrastructure.runtime.health.adapter_auth_status", side_effect=fake_auth_status):
            with self.client.stream(
                "POST",
                "/api/studio/run",
                data={"message": "create skipped handoff source image"},
            ) as response:
                self.assertEqual(response.status_code, 200)
                events = _sse_events("".join(response.iter_text()))

            meta = next(payload for name, payload in events if name == "meta")
            execution = next(payload for name, payload in events if name == "execution_request")
            update = self.client.post(
                f"/api/studio/projects/{meta['projectId']}/client-result",
                json={
                    "segmentId": execution["segmentId"],
                    "jobId": execution["jobId"],
                    "status": "done",
                    "taskId": "task_skipped_handoff_source",
                    "url": "https://example.com/skipped-handoff-source.png",
                    "posterUrl": "https://example.com/skipped-handoff-source.png",
                },
            )
            self.assertEqual(update.status_code, 200)

            session_response = self.client.post(
                "/api/studio/dispatch-sessions",
                json={
                    "project_id": meta["projectId"],
                    "source_segment_id": execution["segmentId"],
                    "limit": 50,
                },
            )
            self.assertEqual(session_response.status_code, 200)
            session = session_response.json()
            skipped_target = session["nextTarget"]
            skipped = self.client.post(
                f"/api/studio/dispatch-sessions/{session['sessionId']}/targets/{skipped_target['id']}",
                json={"status": "skipped", "evidence": {"reason": "operator skipped in handoff test"}},
            )
            self.assertEqual(skipped.status_code, 200)

            bundle = self.client.get(
                f"/api/studio/projects/{meta['projectId']}/delivery-bundle",
                params={"source_segment_id": execution["segmentId"]},
            )

        self.assertEqual(bundle.status_code, 200)
        body = bundle.json()
        self.assertEqual(body["summary"]["skippedTargets"], 1)
        plan_skipped_count = sum(1 for target in body["skippedTargets"] if str(target["id"]).startswith("skip:"))
        self.assertEqual(body["summary"]["dispatchTargets"], len(body["dispatchSessions"][0]["targets"]) + plan_skipped_count)
        skipped_by_id = {target["id"]: target for target in body["skippedTargets"]}
        self.assertIn(skipped_target["id"], skipped_by_id)
        self.assertEqual(skipped_by_id[skipped_target["id"]]["status"], "skipped")
        self.assertEqual(skipped_by_id[skipped_target["id"]]["reason"], "operator_skipped")

    def test_project_delivery_bundle_keeps_error_targets_for_review(self) -> None:
        def fake_auth_status(page_id: str) -> dict:
            if page_id == "myshell-art":
                return {"status": "auth_missing", "mode": "browser-cookies", "message": "Missing MyShell cookies"}
            return {"status": "client_delegated", "mode": "telegram-init-data", "message": "Client delegated"}

        with patch("studio_app.infrastructure.runtime.health.adapter_auth_status", side_effect=fake_auth_status):
            with self.client.stream(
                "POST",
                "/api/studio/run",
                data={"message": "create error handoff source image"},
            ) as response:
                self.assertEqual(response.status_code, 200)
                events = _sse_events("".join(response.iter_text()))

            meta = next(payload for name, payload in events if name == "meta")
            execution = next(payload for name, payload in events if name == "execution_request")
            update = self.client.post(
                f"/api/studio/projects/{meta['projectId']}/client-result",
                json={
                    "segmentId": execution["segmentId"],
                    "jobId": execution["jobId"],
                    "status": "done",
                    "taskId": "task_error_handoff_source",
                    "url": "https://example.com/error-handoff-source.png",
                    "posterUrl": "https://example.com/error-handoff-source.png",
                },
            )
            self.assertEqual(update.status_code, 200)

            session_response = self.client.post(
                "/api/studio/dispatch-sessions",
                json={
                    "project_id": meta["projectId"],
                    "source_segment_id": execution["segmentId"],
                    "limit": 50,
                },
            )
            self.assertEqual(session_response.status_code, 200)
            session = session_response.json()
            error_target = session["nextTarget"]
            errored = self.client.post(
                f"/api/studio/dispatch-sessions/{session['sessionId']}/targets/{error_target['id']}",
                json={"status": "error", "evidence": {"message": "operator saw broken target"}},
            )
            self.assertEqual(errored.status_code, 200)

            bundle = self.client.get(
                f"/api/studio/projects/{meta['projectId']}/delivery-bundle",
                params={"source_segment_id": execution["segmentId"]},
            )
            handoff = self.client.get(
                "/api/studio/handoff-snapshot",
                params={"project_id": meta["projectId"], "source_segment_id": execution["segmentId"]},
            )
            audit = self.client.get(
                "/api/studio/delivery-audit",
                params={"project_id": meta["projectId"], "source_segment_id": execution["segmentId"]},
            )
            resolved_action = self.client.post(
                "/api/studio/actions/resolve",
                json={
                    "action": "inspect-gap",
                    "target_id": error_target["id"],
                    "session_id": session["sessionId"],
                    "project_id": meta["projectId"],
                    "source_segment_id": execution["segmentId"],
                },
            )

        self.assertEqual(bundle.status_code, 200)
        body = bundle.json()
        self.assertEqual(body["summary"]["errorTargets"], 1)
        plan_skipped_count = sum(1 for target in body["skippedTargets"] if str(target["id"]).startswith("skip:"))
        self.assertEqual(body["summary"]["dispatchTargets"], len(body["dispatchSessions"][0]["targets"]) + plan_skipped_count)
        error_by_id = {target["id"]: target for target in body["errorTargets"]}
        self.assertIn(error_target["id"], error_by_id)
        self.assertEqual(error_by_id[error_target["id"]]["status"], "error")
        self.assertEqual(error_by_id[error_target["id"]]["message"], "operator saw broken target")

        self.assertEqual(handoff.status_code, 200)
        handoff_body = handoff.json()
        self.assertFalse(handoff_body["readyForDelivery"])
        handoff_gap_by_id = {gap["id"]: gap for gap in handoff_body["gaps"]}
        expected_gap_id = f"dispatch-session:{session['sessionId']}:{error_target['id']}"
        self.assertIn(expected_gap_id, handoff_gap_by_id)
        self.assertEqual(handoff_gap_by_id[expected_gap_id]["kind"], "dispatch_target")
        self.assertEqual(handoff_gap_by_id[expected_gap_id]["reason"], "error")
        self.assertEqual(handoff_gap_by_id[expected_gap_id]["message"], "operator saw broken target")
        handoff_action_by_id = {action["id"]: action for action in handoff_body["actions"]}
        expected_action_id = f"dispatch-target:inspect-gap:{session['sessionId']}:{error_target['id']}"
        expected_ui_url = f"/dreamy?dispatch_session_id={session['sessionId']}&target_id=dispatch%3Aexplore"
        self.assertIn(expected_action_id, handoff_action_by_id)
        self.assertEqual(handoff_action_by_id[expected_action_id]["action"], "inspect-gap")
        self.assertEqual(handoff_action_by_id[expected_action_id]["uiUrl"], expected_ui_url)

        self.assertEqual(audit.status_code, 200)
        audit_action_by_id = {action["id"]: action for action in audit.json()["actions"]}
        self.assertIn(expected_action_id, audit_action_by_id)
        self.assertEqual(audit_action_by_id[expected_action_id]["uiUrl"], expected_ui_url)

        self.assertEqual(resolved_action.status_code, 200)
        resolved_body = resolved_action.json()
        self.assertEqual(resolved_body["status"], "manual_required")
        self.assertEqual(resolved_body["action"], "inspect-gap")
        self.assertEqual(resolved_body["targetId"], error_target["id"])
        self.assertEqual(resolved_body["sessionId"], session["sessionId"])
        self.assertEqual(resolved_body["next"]["sessionId"], session["sessionId"])
        self.assertEqual(resolved_body["next"]["targetId"], error_target["id"])
        self.assertEqual(
            resolved_body["next"]["url"],
            f"/api/studio/dispatch-sessions/{session['sessionId']}?target_id=dispatch%3Aexplore",
        )
        self.assertEqual(
            resolved_body["next"]["uiUrl"],
            f"/dreamy?dispatch_session_id={session['sessionId']}&target_id=dispatch%3Aexplore",
        )

    def test_job_queue_can_filter_by_page_and_agent(self) -> None:
        with self.client.stream(
            "POST",
            "/api/studio/run",
            data={"message": "queue planner job", "agent_id": "asset-planner"},
        ) as response:
            planner_events = _sse_events("".join(response.iter_text()))
        with self.client.stream(
            "POST",
            "/api/studio/run",
            data={"message": "open my generated library", "page_id": "library"},
        ) as response:
            library_events = _sse_events("".join(response.iter_text()))

        planner_job_id = next(payload for name, payload in planner_events if name == "execution_request")["jobId"]
        library_job_id = next(payload for name, payload in library_events if name == "execution_request")["jobId"]

        by_agent = self.client.get("/api/studio/jobs", params={"agent_id": "asset-planner"})
        self.assertEqual(by_agent.status_code, 200)
        self.assertEqual([job["jobId"] for job in by_agent.json()["jobs"]], [planner_job_id])

        by_page = self.client.get("/api/studio/jobs", params={"page_id": "library"})
        self.assertEqual(by_page.status_code, 200)
        self.assertEqual([job["jobId"] for job in by_page.json()["jobs"]], [library_job_id])

        combined = self.client.get(
            "/api/studio/jobs",
            params={"page_id": "library", "agent_id": "asset-planner"},
        )
        self.assertEqual(combined.status_code, 200)
        self.assertEqual(combined.json()["jobs"], [])

    def test_retry_returns_client_execution_request(self) -> None:
        with self.client.stream(
            "POST",
            "/api/studio/run",
            data={"message": "retryable segment"},
        ) as response:
            events = _sse_events("".join(response.iter_text()))

        execution = next(payload for name, payload in events if name == "execution_request")
        retry = self.client.post(f"/api/studio/jobs/{execution['jobId']}/retry")

        self.assertEqual(retry.status_code, 200)
        body = retry.json()
        self.assertEqual(body["job"]["attempt"], 2)
        self.assertEqual(body["job"]["status"], "queued")
        self.assertEqual(body["executionRequest"]["executor"], "client")
        self.assertEqual(body["executionRequest"]["jobId"], execution["jobId"])
        self.assertEqual(body["executionRequest"]["segmentId"], execution["segmentId"])
        self.assertEqual(body["executionRequest"]["segment"]["status"], "queued")

    def test_done_without_media_is_rejected_as_error_evidence(self) -> None:
        with self.client.stream(
            "POST",
            "/api/studio/run",
            data={"message": "new segment"},
        ) as response:
            events = _sse_events("".join(response.iter_text()))

        meta = next(payload for name, payload in events if name == "meta")
        execution = next(payload for name, payload in events if name == "execution_request")

        update = self.client.post(
            f"/api/studio/projects/{meta['projectId']}/client-result",
            json={
                "segmentId": execution["segmentId"],
                "jobId": execution["jobId"],
                "status": "done",
                "taskId": "task_without_media",
            },
        )

        self.assertEqual(update.status_code, 200)
        body = update.json()
        self.assertEqual(body["segment"]["status"], "error")
        self.assertEqual(body["segment"]["evidence"]["accepted"], False)
        self.assertIn("no media URL", body["segment"]["evidence"]["message"])

    def test_project_can_be_restored_from_store_after_memory_clear(self) -> None:
        with self.client.stream(
            "POST",
            "/api/studio/run",
            data={"message": "persistent segment"},
        ) as response:
            events = _sse_events("".join(response.iter_text()))

        project_id = next(payload["projectId"] for name, payload in events if name == "meta")
        PROJECTS.clear()

        restored = self.client.get(f"/api/studio/projects/{project_id}")
        self.assertEqual(restored.status_code, 200)
        body = restored.json()
        self.assertEqual(body["projectId"], project_id)
        self.assertEqual(len(body["segments"]), 1)
        self.assertEqual(len(body["jobs"]), 1)

    def test_reset_project_removes_in_memory_state(self) -> None:
        with self.client.stream(
            "POST",
            "/api/studio/run",
            data={"message": "new segment"},
        ) as response:
            events = _sse_events("".join(response.iter_text()))

        project_id = next(payload["projectId"] for name, payload in events if name == "meta")
        self.assertIn(project_id, PROJECTS)

        reset = self.client.post(f"/api/studio/projects/{project_id}/reset")
        self.assertEqual(reset.status_code, 200)
        self.assertNotIn(project_id, PROJECTS)
        self.assertEqual(self.client.get(f"/api/studio/projects/{project_id}").status_code, 404)


if __name__ == "__main__":
    unittest.main()
