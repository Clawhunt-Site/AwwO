"""Pictures a model sees (vision): the API sends a run's pictures as `images` only to a worker that claims
`imageInput`, and only for a model whose input lists "image"; this worker checks both again."""

import json
import unittest
from unittest.mock import patch

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from bedrock_bridge import BridgeError, to_converse_input
from config import BODY_BYTES, MAX_IMAGE_BYTES, ConfigError, load_config, public_health, resolve_model_config
from runner import RunRequest, stream_run, validate_request
from server import create_app

PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
ENV = {"AWWO_OPENAI_AGENTS_TOKEN": "x" * 32, "AWWO_OPENAI_AGENTS_MODEL": "mock-model", "AWWO_OPENAI_AGENTS_API_KEY": "synthetic",
       "AWWO_OPENAI_AGENTS_BASE_URL": "http://127.0.0.1:1/v1"}
SEER = {"id": "seer", "provider": "openai", "model": "seeing-model", "apiKeyEnv": "SEER_KEY", "input": ["text", "image"]}
MODEL = "global.anthropic.claude-opus-5-5"


def picture(**extra):
    return {"name": "cat.png", "mimeType": "image/png", "data": PNG, **extra}


def request(**extra):
    return {"runId": "aRun", "tenantId": "aTenant", "sessionId": "aSession", "prompt": "What is in this picture?", "messages": [], **extra}


def seeing_config(base_url="http://127.0.0.1:1/v1"):
    return load_config({**ENV, "SEER_KEY": "k", "AWWO_OPENAI_AGENTS_MODELS_JSON": json.dumps([{**SEER, "baseURL": base_url}])})


class IntakeTests(unittest.TestCase):
    def test_a_run_may_carry_up_to_six_well_formed_pictures(self):
        config = seeing_config()
        self.assertEqual(validate_request(request(images=[picture()]), config).images, [picture()])
        self.assertEqual(len(validate_request(request(images=[picture(mimeType="image/webp")] * 6), config).images), 6)
        self.assertIsNone(validate_request(request(), config).images)
        for images in ([], {}, "cat.png", [picture()] * 7, [picture(mimeType="image/bmp")], [picture(mimeType="image/svg+xml")],
                       [picture(data="not base64!")], [picture(data="AAA")], [picture(data="")], [picture(name="")],
                       [picture(name="x" * 201)], [picture(url="https://example.test/cat.png")], ["cat.png"],
                       [picture(data="A" * 5_242_884)]):
            with self.subTest(images=str(images)[:60]):
                with self.assertRaisesRegex(ValueError, "Invalid images"):
                    validate_request(request(images=images), config)
        # The largest picture fits.
        largest = "A" * (MAX_IMAGE_BYTES // 3 * 4)
        self.assertEqual(len(validate_request(request(images=[picture(data=largest)]), config).images), 1)

    def test_profiles_say_what_their_model_takes_and_health_claims_pictures(self):
        config = seeing_config()
        self.assertEqual(resolve_model_config(config, None).input, ("text",))
        self.assertEqual(resolve_model_config(config, "seer").input, ("text", "image"))
        health = public_health(config)
        self.assertIs(health["imageInput"], True)
        self.assertEqual([m["input"] for m in health["models"]], [["text"], ["text", "image"]])
        self.assertEqual((health["limits"]["bodyBytes"], health["limits"]["images"], health["limits"]["imageBytes"]), (BODY_BYTES, 6, MAX_IMAGE_BYTES))
        self.assertEqual(resolve_model_config(load_config({**ENV, "AWWO_OPENAI_AGENTS_INPUT": "text, image"}), None).input, ("text", "image"))
        for value in ("image", "text,text", "text,audio"):
            with self.assertRaisesRegex(ConfigError, "AWWO_OPENAI_AGENTS_INPUT"):
                load_config({**ENV, "AWWO_OPENAI_AGENTS_INPUT": value})
        for kinds in (["image"], ["text", "text"], ["text", "audio"], "text", []):
            with self.assertRaisesRegex(ConfigError, "Invalid input"):
                load_config({**ENV, "SEER_KEY": "k", "AWWO_OPENAI_AGENTS_MODELS_JSON": json.dumps([{**SEER, "input": kinds}])})
        bedrock = load_config({**ENV, "AWWO_OPENAI_AGENTS_MODELS_JSON": json.dumps([
            {"id": "claude", "provider": "bedrock", "model": MODEL, "input": ["text", "image"]},
            {"id": "deepseek", "provider": "bedrock", "model": "deepseek.v3.2"}])})
        self.assertEqual(resolve_model_config(bedrock, "claude").input, ("text", "image"))
        self.assertEqual(resolve_model_config(bedrock, "deepseek").input, ("text",))

    def test_the_catalog_says_which_models_see(self):
        config = load_config({**ENV, "AWWO_BEDROCK_CATALOG": "builtin", "AWWO_BEDROCK_REGION": "us-east-1"})
        models = {m["id"]: m["input"] for m in public_health(config)["models"]}
        self.assertEqual(models["bedrock.claude-opus-5-5"], ["text", "image"])
        self.assertEqual(models["bedrock.deepseek-v3-2"], ["text"])


class ServerGateTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.config = seeing_config()
        self.calls = []

        async def fake_stream(run_request, config, cancel_event):
            self.calls.append(run_request)
            yield {"type": "completed", "text": "a cat"}

        stream_patch = patch("server.stream_run", fake_stream)
        stream_patch.start()
        self.addCleanup(stream_patch.stop)
        with patch("server.load_config", return_value=self.config):
            self.client = TestClient(TestServer(create_app()))
        self.addAsyncCleanup(self.client.close)
        await self.client.start_server()

    async def post(self, body):
        return await self.client.post("/internal/runs", json=body, headers={"Authorization": "Bearer " + "x" * 32})

    async def test_pictures_reach_a_seeing_model_and_a_text_model_gets_none(self):
        refused = await self.post(request(images=[picture()]))
        self.assertEqual(refused.status, 400)
        self.assertEqual((await refused.json())["error"], "images_unsupported")
        self.assertEqual(self.calls, [])
        accepted = await self.post(request(model="seer", images=[picture()]))
        self.assertEqual(accepted.status, 200)
        await accepted.read()
        self.assertEqual(self.calls[0].images, [picture()])
        # Six pictures of the largest size fit the body bound (aiohttp's default would refuse them).
        largest = "A" * (MAX_IMAGE_BYTES // 3 * 4)
        big = await self.post(request(runId="aRun2", sessionId="aSession2", model="seer", images=[picture(data=largest)] * 6))
        self.assertEqual(big.status, 200)
        await big.read()


class SDKInputTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.calls = []
        app = web.Application(client_max_size=BODY_BYTES)
        app.router.add_post("/v1/chat/completions", self.provider)
        self.runner = web.AppRunner(app)
        await self.runner.setup()
        site = web.TCPSite(self.runner, "127.0.0.1", 0)
        await site.start()
        self.base_url = f"http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}/v1"

    async def asyncTearDown(self):
        await self.runner.cleanup()

    async def provider(self, http_request):
        self.calls.append(await http_request.json())
        response = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
        await response.prepare(http_request)
        for delta, reason in (({"role": "assistant", "content": "A tiny picture."}, None), ({}, "stop")):
            payload = {"id": "chatcmpl_1", "object": "chat.completion.chunk", "created": 1, "model": "seeing-model",
                       "choices": [{"index": 0, "delta": delta, "finish_reason": reason}]}
            await response.write(f"data: {json.dumps(payload)}\n\n".encode())
        await response.write(b"data: [DONE]\n\n")
        return response

    async def test_the_final_user_turn_carries_the_pictures_and_history_stays_text(self):
        import asyncio
        config = seeing_config(self.base_url)
        run = RunRequest(run_id="aRun", tenant_id="aTenant", session_id="aSession", prompt="What is in this picture?",
                         messages=[{"role": "user", "content": "Earlier"}, {"role": "assistant", "content": "Answer"}],
                         model="seer", images=[picture()])
        events = [event async for event in stream_run(run, config, asyncio.Event())]
        self.assertEqual(events[-1]["type"], "completed", events[-1])
        messages = self.calls[0]["messages"]
        last = messages[-1]
        self.assertEqual(last["role"], "user")
        self.assertIn({"type": "image_url", "image_url": {"url": f"data:image/png;base64,{PNG}", "detail": "auto"}}, last["content"])
        self.assertTrue(any(part.get("type") == "text" and "What is in this picture?" in part.get("text", "") for part in last["content"]))
        self.assertNotIn("image_url", json.dumps(messages[:-1]))

    async def test_a_text_model_is_never_sent_pictures(self):
        import asyncio
        config = load_config({**ENV, "AWWO_OPENAI_AGENTS_BASE_URL": self.base_url})
        run = RunRequest(run_id="aRun", tenant_id="aTenant", session_id="aSession", prompt="Look", messages=[], images=[picture()])
        events = [event async for event in stream_run(run, config, asyncio.Event())]
        self.assertEqual(events[-1]["type"], "failed")
        self.assertEqual(self.calls, [])


class BridgeTests(unittest.TestCase):
    def body(self, content, **extra):
        return {"model": MODEL, "stream": True, "max_tokens": 512, "messages": [{"role": "user", "content": content}], **extra}

    def test_a_user_turns_pictures_become_image_blocks_between_its_text(self):
        command = to_converse_input(self.body([
            {"type": "text", "text": "What is "}, {"type": "text", "text": "this?"},
            {"type": "image_url", "image_url": {"url": "data:image/png;base64,iVBORw0KGgo=", "detail": "auto"}},
            {"type": "image_url", "image_url": {"url": "data:image/webp;base64,UklGRg=="}}, {"type": "text", "text": "And that."},
        ]), MODEL)
        content = command["messages"][0]["content"]
        self.assertEqual(content[0], {"text": "What is this?"})
        self.assertEqual(content[1], {"image": {"format": "png", "source": {"bytes": b"\x89PNG\r\n\x1a\n"}}})
        self.assertEqual(content[2]["image"]["format"], "webp")
        self.assertEqual(content[3], {"text": "And that."})
        self.assertEqual(to_converse_input(self.body("Hello"), MODEL)["messages"][0], {"role": "user", "content": [{"text": "Hello"}]})

    def test_anything_else_is_refused(self):
        def image(url, **extra):
            return {"type": "image_url", "image_url": {"url": url, **extra}}
        cases = [
            (self.body([image("https://example.test/cat.png")]), "base64 data URLs"),
            (self.body([image("data:image/bmp;base64,AAAA")]), "base64 data URLs"),
            (self.body([image("data:image/png;base64,AAA")]), "base64 data URLs"),
            (self.body([image("data:image/png;base64,AAAA", size=1)]), "Invalid image"),
            (self.body([image("data:image/png;base64,AAAA", detail="max")]), "Invalid image"),
            (self.body([image("data:image/png;base64," + "A" * 5_242_884)]), "larger than 3.75 MiB"),
            (self.body([image("data:image/png;base64,AAAA")] * 21), "At most 20 images"),
            ({"model": MODEL, "stream": True, "messages": [{"role": "user", "content": "Q"},
                {"role": "assistant", "content": [image("data:image/png;base64,AAAA")]}, {"role": "user", "content": "go"}]},
             "Only text content is supported in assistant"),
        ]
        for body, message in cases:
            with self.subTest(message=message):
                with self.assertRaisesRegex(BridgeError, message):
                    to_converse_input(body, MODEL)


if __name__ == "__main__":
    unittest.main()
