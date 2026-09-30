"""Exercise the real Agents SDK against a loopback provider; no credentials/network."""
import asyncio
import json
import unittest
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from agents import FunctionTool, set_trace_processors
from openai import AsyncOpenAI

from config import load_config
from runner import ReasoningCounter, RunRequest, _build_tools, stream_run
from server import _authorized, create_app

# Private scratchpad text a provider streams in its reasoning field; it must never leave the worker.
REASONING_TEXT = "weigh 权衡 the private ledger 44102 before answering"


class TraceRecorder:
    def __init__(self):
        self.events = []

    def on_trace_start(self, trace): self.events.append(trace)
    def on_trace_end(self, trace): self.events.append(trace)
    def on_span_start(self, span): self.events.append(span)
    def on_span_end(self, span): self.events.append(span)
    def force_flush(self): pass
    def shutdown(self): pass


class RunnerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.calls = []
        self.mode = "text"
        self.entered = asyncio.Event()
        self.release = asyncio.Event()
        app = web.Application()
        app.router.add_post("/v1/chat/completions", self.provider)
        app.router.add_post("/v1/responses", self.responses_provider)
        self.server = web.AppRunner(app)
        await self.server.setup()
        site = web.TCPSite(self.server, "127.0.0.1", 0)
        await site.start()
        port = site._server.sockets[0].getsockname()[1]
        self.config = load_config({
            "AWWO_OPENAI_AGENTS_TOKEN": "x" * 32,
            "AWWO_OPENAI_AGENTS_MODEL": "mock-model",
            "AWWO_OPENAI_AGENTS_API_KEY": "synthetic",
            "AWWO_OPENAI_AGENTS_BASE_URL": f"http://127.0.0.1:{port}/v1",
            "AWWO_OPENAI_AGENTS_TOOLS_JSON": '["calculator", "current_time"]',
        })
        self.traces = TraceRecorder()
        set_trace_processors([self.traces])

    async def asyncTearDown(self):
        self.release.set()
        await self.server.cleanup()
        set_trace_processors([])

    async def provider(self, request):
        self.calls.append(await request.json())
        self.entered.set()
        if self.mode == "wait":
            await self.release.wait()
            return web.Response()
        response = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
        await response.prepare(request)
        delta = {"role": "assistant", "content": "Hello"}
        finish = "stop"
        chunks = [(delta, None), ({}, finish)]
        if self.mode == "tool":
            delta = {"role": "assistant", "tool_calls": [{"index": 0, "id": "call_1", "type": "function",
                "function": {"name": "calculator", "arguments": '{"expression":"2+3"}'}}]}
            chunks = [(delta, None), ({}, "tool_calls")]
        elif self.mode == "reasoning":
            # A provider that streams its reasoning in a separate field before answering.
            chunks = [({"role": "assistant", "reasoning_content": REASONING_TEXT[:12]}, None),
                      ({"reasoning_content": REASONING_TEXT[12:]}, None),
                      ({"content": "Hello"}, None), ({}, "stop")]
        for content, reason in chunks:
            payload = {"id": "chatcmpl_1", "object": "chat.completion.chunk", "created": 1,
                "model": "mock-model", "choices": [{"index": 0, "delta": content, "finish_reason": reason}]}
            await response.write(f"data: {json.dumps(payload)}\n\n".encode())
        await response.write(b"data: [DONE]\n\n")
        return response

    async def responses_provider(self, request):
        self.calls.append(await request.json())
        response = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
        await response.prepare(request)
        item = {"id": "msg_1", "type": "message", "role": "assistant", "status": "completed",
                "content": [{"type": "output_text", "text": "Hello", "annotations": []}]}
        payload = {"id": "resp_1", "object": "response", "created_at": 1, "status": "completed",
                   "model": "mock-model", "output": [item], "parallel_tool_calls": False,
                   "tool_choice": "auto", "tools": [], "error": None, "incomplete_details": None}
        events = [
            {"type": "response.output_text.delta", "sequence_number": 0, "item_id": "msg_1", "output_index": 0, "content_index": 0, "delta": "Hello", "logprobs": []},
            {"type": "response.output_item.done", "sequence_number": 1, "output_index": 0, "item": item},
            {"type": "response.completed", "sequence_number": 2, "response": payload},
        ]
        if self.mode == "reasoning":
            # A Responses model announces its reasoning item and streams a summary of it.
            thought = {"id": "rs_1", "type": "reasoning", "summary": []}
            done = {**thought, "summary": [{"type": "summary_text", "text": REASONING_TEXT}]}
            payload["output"] = [done, item]
            events = [
                {"type": "response.output_item.added", "sequence_number": 0, "output_index": 0, "item": thought},
                {"type": "response.reasoning_summary_text.delta", "sequence_number": 1, "item_id": "rs_1", "output_index": 0, "summary_index": 0, "delta": REASONING_TEXT[:12]},
                {"type": "response.reasoning_summary_text.delta", "sequence_number": 2, "item_id": "rs_1", "output_index": 0, "summary_index": 0, "delta": REASONING_TEXT[12:]},
                {"type": "response.output_item.done", "sequence_number": 3, "output_index": 0, "item": done},
                {"type": "response.output_text.delta", "sequence_number": 4, "item_id": "msg_1", "output_index": 1, "content_index": 0, "delta": "Hello", "logprobs": []},
                {"type": "response.output_item.done", "sequence_number": 5, "output_index": 1, "item": item},
                {"type": "response.completed", "sequence_number": 6, "response": payload},
            ]
        for event in events:
            await response.write(f"event: {event['type']}\ndata: {json.dumps(event)}\n\n".encode())
        return response

    def request(self, **values):
        return RunRequest("r1", "t1", "s1", "Synthetic task", [], **values)

    async def collect(self, request=None, config=None, cancel=None):
        return [event async for event in stream_run(request or self.request(), config or self.config, cancel or asyncio.Event())]

    async def test_registered_tools_are_real_sdk_tools_and_bind_independently(self):
        tools = _build_tools(self.request(tools=["calculator", "current_time"]), self.config)
        self.assertTrue(all(isinstance(tool, FunctionTool) for tool in tools))
        self.assertEqual(json.loads(await tools[0].on_invoke_tool(None, '{"expression":"3*4"}')), {"value": 12.0})
        self.assertIn("UTC", await tools[1].on_invoke_tool(None, '{"timeZone":"UTC"}'))
        self.assertEqual(list(tools[0].params_json_schema["properties"]), ["expression"])

    async def test_real_sdk_tool_round_trip_is_one_model_call_without_traces(self):
        self.mode = "tool"
        events = await self.collect(self.request(tools=["calculator"]))
        self.assertEqual(events[-1]["type"], "completed", events)
        self.assertEqual(json.loads(events[-1]["text"]), {"value": 5.0})
        self.assertEqual("".join(e["delta"] for e in events if e["type"] == "text_delta"), events[-1]["text"])
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.calls[0]["tools"][0]["function"]["name"], "calculator")
        self.assertFalse(self.calls[0]["store"])
        self.assertFalse(self.calls[0]["parallel_tool_calls"])
        self.assertEqual(self.calls[0].get("max_tokens", self.calls[0].get("max_completion_tokens")), self.config.max_tokens)
        self.assertEqual(self.traces.events, [])

    async def test_text_round_trip_has_no_trace_or_span(self):
        events = await self.collect()
        self.assertEqual(events[-1]["text"], "Hello")
        self.assertEqual(self.traces.events, [])

    async def test_google_chat_wire_omits_unsupported_store(self):
        profile = replace(self.config.models[0], base_url="https://generativelanguage.googleapis.com/v1beta/openai")
        config = replace(self.config, models=(profile,))
        # Exercise the actual SDK serialization, routing transport to our fixture.
        def local_client(**kwargs):
            return AsyncOpenAI(**{**kwargs, "base_url": self.config.base_url})
        with patch("runner.AsyncOpenAI", side_effect=local_client):
            events = await self.collect(self.request(tools=["calculator"]), config=config)
        self.assertEqual(events[-1]["type"], "completed", events)
        self.assertNotIn("store", self.calls[0])
        self.assertFalse(self.calls[0]["parallel_tool_calls"])
        self.assertEqual(self.traces.events, [])

    async def test_setup_failures_are_terminal_wire_events(self):
        events = await self.collect(self.request(model="unknown"))
        self.assertEqual(events[0]["code"], "MODEL_REQUEST_REJECTED")
        events = await self.collect(self.request(tools=["calculator"]), replace(self.config, enabled_tools=()))
        self.assertEqual(events[0]["code"], "TOOL_DENIED")
        self.assertEqual(self.calls, [])

    async def test_sdk_setup_failures_close_client_and_emit_terminal_event(self):
        for constructor in ["Agent", "ModelSettings", "OpenAIChatCompletionsModel"]:
            client = SimpleNamespace(close=AsyncMock())
            with patch("runner.AsyncOpenAI", return_value=client), patch("runner." + constructor, side_effect=ValueError("synthetic")):
                events = await self.collect()
            self.assertEqual(events[-1]["type"], "failed", (constructor, events))
            client.close.assert_awaited_once()
        with patch("runner.AsyncOpenAI", side_effect=ValueError("synthetic")):
            events = await self.collect()
        self.assertEqual(events[-1]["type"], "failed")

    async def test_cancel_stalled_provider_terminates_sdk_run(self):
        self.mode = "wait"
        cancel = asyncio.Event()
        run = asyncio.create_task(self.collect(cancel=cancel))
        await asyncio.wait_for(self.entered.wait(), 5)
        cancel.set()
        events = await asyncio.wait_for(run, 2)
        self.assertEqual(events[-1]["type"], "cancelled", events)

    def assert_reasoning_as_counts(self, events):
        counts = [event for event in events if event["type"] == "reasoning"]
        # The start is reported before anything is counted; the settled total precedes the answer.
        self.assertGreaterEqual(len(counts), 2, events)
        self.assertEqual(counts[0], {"type": "reasoning", "characters": 0})
        self.assertEqual(counts[-1], {"type": "reasoning", "characters": len(REASONING_TEXT)})
        first_text = next(index for index, event in enumerate(events) if event["type"] == "text_delta")
        self.assertLess(events.index(counts[-1]), first_text)
        self.assertEqual(events[-1]["type"], "completed", events)
        self.assertEqual(events[-1]["text"], "Hello")
        dumped = json.dumps(events, ensure_ascii=False)
        self.assertNotIn("44102", dumped)
        self.assertNotIn("权衡", dumped)

    async def test_chat_reasoning_fields_cross_the_worker_as_counts_only(self):
        self.mode = "reasoning"
        self.assert_reasoning_as_counts(await self.collect())

    async def test_responses_reasoning_summaries_cross_the_worker_as_counts_only(self):
        self.mode = "reasoning"
        config = replace(self.config, models=(replace(self.config.models[0], protocol="responses"),))
        self.assert_reasoning_as_counts(await self.collect(config=config))

    async def test_a_model_that_never_reasons_reports_no_reasoning(self):
        events = await self.collect()
        self.assertEqual([event["type"] for event in events], ["text_delta", "completed"], events)

    def test_reasoning_counter_coalesces_but_never_hides_a_start_or_the_final_total(self):
        now = [100.0]
        counter = ReasoningCounter(clock=lambda: now[0])
        # Before any reasoning is observed there is nothing to report, even when forced.
        self.assertIsNone(counter.report(force=True))
        counter.start()
        self.assertEqual(counter.report(force=True), {"type": "reasoning", "characters": 0})
        self.assertIsNone(counter.report(force=True), "an unchanged count was sent twice")
        counter.add("abc")
        self.assertIsNone(counter.report(force=False), "a count inside the interval was not coalesced")
        now[0] += 0.6
        self.assertEqual(counter.report(force=False), {"type": "reasoning", "characters": 3})
        counter.add("数据")
        self.assertEqual(counter.report(force=True), {"type": "reasoning", "characters": 5})

    async def test_output_limit_is_enforced(self):
        events = await self.collect(config=replace(self.config, max_output_bytes=3))
        self.assertEqual(events[-1]["code"], "OUTPUT_LIMIT", events)

    async def test_stalled_provider_deadline_is_a_wire_failure(self):
        self.mode = "wait"
        events = await self.collect(config=replace(self.config, timeout_ms=100))
        self.assertEqual(events[-1]["code"], "DEADLINE_EXCEEDED", events)

    async def test_responses_protocol_uses_real_responses_model(self):
        config = replace(self.config, models=(replace(self.config.models[0], protocol="responses"),))
        events = await self.collect(config=config)
        self.assertEqual(events[-1]["type"], "completed", events)
        self.assertEqual(events[-1]["text"], "Hello")
        self.assertIn("input", self.calls[0])
        self.assertEqual(self.traces.events, [])

    def test_minimum_length_token_is_authorized_and_wrong_tokens_are_rejected(self):
        request = SimpleNamespace(app={"config": self.config}, headers={"Authorization": "Bearer " + "x" * 32})
        self.assertTrue(_authorized(request))
        for value in ["Bearer " + "y" * 32, "Bearer ", "", "Basic " + "x" * 32]:
            request.headers["Authorization"] = value
            self.assertFalse(_authorized(request))


class WorkerHTTPContractTests(unittest.IsolatedAsyncioTestCase):
    """Exercise Go's private HTTP boundary without invoking a model provider."""

    async def asyncSetUp(self):
        self.config = load_config({
            "AWWO_OPENAI_AGENTS_TOKEN": "x" * 32,
            "AWWO_OPENAI_AGENTS_MODEL": "mock-model",
            "AWWO_OPENAI_AGENTS_API_KEY": "synthetic",
            "AWWO_OPENAI_AGENTS_BASE_URL": "http://127.0.0.1:1/v1",
        })
        self.calls = []
        self.stream_events = [{"type": "text_delta", "delta": "Contract result"},
                              {"type": "completed", "text": "Contract result"}]

        async def fake_stream(request, config, cancel_event):
            self.calls.append(request)
            for event in self.stream_events:
                yield event

        self.stream_patch = patch("server.stream_run", fake_stream)
        self.stream_patch.start()
        self.addCleanup(self.stream_patch.stop)
        with patch("server.load_config", return_value=self.config):
            self.client = TestClient(TestServer(create_app()))
        self.addAsyncCleanup(self.client.close)
        await self.client.start_server()

    def go_request(self, suffix=""):
        # Fields emitted by Go run admission / executeTeamTurn, including
        # explicit runtime/model and role/content-only history messages.
        return {
            "runId": "aGoRun" + suffix,
            "tenantId": "aGoTenant",
            "sessionId": "aGoSession" + suffix,
            "prompt": "Produce the requested result.",
            "messages": [{"role": "user", "content": "Previous goal"},
                         {"role": "assistant", "content": "Previous result"}],
            "systemPrompt": "Use the supplied role instructions.",
            "model": "mock-model",
            "runtime": "openai-agents",
        }

    async def test_go_and_legacy_routes_require_authentication(self):
        for path in ("/internal/runs", "/v1/runs"):
            with self.subTest(path=path):
                response = await self.client.post(path, json=self.go_request())
                self.assertEqual(response.status, 401)
                self.assertEqual((await response.json())["error"], "unauthorized")
        self.assertEqual(self.calls, [])

    async def test_go_and_legacy_routes_reject_invalid_requests_before_streaming(self):
        for path in ("/internal/runs", "/v1/runs"):
            with self.subTest(path=path):
                response = await self.client.post(path, json={"runId": "aGoRun"},
                    headers={"Authorization": "Bearer " + self.config.token})
                self.assertEqual(response.status, 400)
                self.assertEqual((await response.json())["error"], "invalid_request")
        self.assertEqual(self.calls, [])

    async def test_go_wire_shape_streams_to_completion_on_both_routes(self):
        for index, path in enumerate(("/internal/runs", "/v1/runs")):
            with self.subTest(path=path):
                body = self.go_request(str(index))
                response = await self.client.post(path, json=body,
                    headers={"Authorization": "Bearer " + self.config.token})
                self.assertEqual(response.status, 200)
                self.assertTrue(response.headers["Content-Type"].startswith("text/event-stream"))
                events = [json.loads(line[5:].strip()) for line in (await response.text()).splitlines()
                          if line.startswith("data:")]
                self.assertEqual(events, [{"type": "text_delta", "delta": "Contract result"},
                                          {"type": "completed", "text": "Contract result"}])
                self.assertEqual(self.calls[-1].run_id, body["runId"])
                self.assertEqual(self.calls[-1].model, body["model"])
                self.assertEqual(self.calls[-1].runtime, body["runtime"])
                self.assertEqual(self.calls[-1].messages, body["messages"])
                health = await (await self.client.get("/health")).json()
                self.assertEqual(health["activeRuns"], 0)
        self.assertEqual(len(self.calls), 2)

    async def test_reasoning_counts_reach_only_a_caller_that_opted_in(self):
        self.stream_events = [{"type": "reasoning", "characters": 0}, {"type": "reasoning", "characters": 7},
                              {"type": "text_delta", "delta": "Contract result"},
                              {"type": "completed", "text": "Contract result"}]
        authorization = {"Authorization": "Bearer " + self.config.token}
        for suffix, extra, expected in [
            ("plain", {}, ["text_delta", "completed"]),
            ("other", {"X-Awwo-Run-Activity": "everything"}, ["text_delta", "completed"]),
            ("opted", {"X-Awwo-Run-Activity": "reasoning"}, ["reasoning", "reasoning", "text_delta", "completed"]),
        ]:
            with self.subTest(suffix=suffix):
                response = await self.client.post("/internal/runs", json=self.go_request(suffix),
                    headers={**authorization, **extra})
                self.assertEqual(response.status, 200)
                events = [json.loads(line[5:].strip()) for line in (await response.text()).splitlines()
                          if line.startswith("data:")]
                self.assertEqual([event["type"] for event in events], expected)


if __name__ == "__main__":
    unittest.main()
