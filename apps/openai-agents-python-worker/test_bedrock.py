"""Bedrock through the Converse bridge: parity with the TypeScript bridge, configuration,
and the real Agents SDK over the bridge transport with a fake boto3 client (no network)."""
import asyncio
import json
import os
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

import httpx2
from agents import set_trace_processors
from botocore.exceptions import ClientError, EventStreamError

from bedrock_bridge import (
    BRIDGE_API_KEY, BedrockConverseTransport, BridgeError, ChunkMapper, bridge_base_url, bridge_failure, default_client,
    to_converse_input, valid_auth,
)
from bedrock_catalog import (
    catalog_selection, parse_catalog, parse_catalog_file, parse_platform_providers, platform_health, platform_providers_in_use, read_catalog,
    read_catalog_regions,
)
from config import ConfigError, load_config, public_health, resolve_model_config
from errors import classify_error
from runner import RunRequest, stream_run

APPS = Path(__file__).resolve().parent.parent
VECTORS = json.loads((APPS / "bedrock-bridge-vectors.json").read_text(encoding="utf-8"))
REASONING_TEXT = "weigh 权衡 the private ledger 44102 before answering"
BEDROCK_KEY = "ABSKbedrockkey000000000000000000"
GATE = {
    "AWWO_OPENAI_AGENTS_TOKEN": "x" * 32, "AWWO_OPENAI_AGENTS_PROVIDER": "llmgate",
    "AWWO_OPENAI_AGENTS_MODEL": "qwen3.8-27b-p6", "AWWO_OPENAI_AGENTS_API_KEY": "sk-llmgate-synthetic",
}


def catalog_config(**overrides):
    return load_config({**GATE, "AWWO_BEDROCK_CATALOG": "builtin-all", **overrides})


class VectorParityTests(unittest.TestCase):
    """The Python bridge must match the TypeScript bridge on the shared vectors."""

    def test_requests_map_identically(self):
        for vector in VECTORS["requests"]:
            with self.subTest(vector["name"]):
                self.assertEqual(to_converse_input(vector["body"], VECTORS["model"]), vector["expect"])

    def test_refusals_match(self):
        for vector in VECTORS["errors"]:
            with self.subTest(vector["name"]):
                with self.assertRaises(BridgeError) as caught:
                    to_converse_input(vector["body"], VECTORS["model"])
                self.assertEqual(caught.exception.status, vector["status"])
                self.assertEqual(caught.exception.message, vector["message"])

    def test_streams_map_identically(self):
        def run(events, single=False):
            mapper = ChunkMapper(VECTORS["model"], chunk_id="chatcmpl-vector", created=1, single_tool_call=single)
            chunks = []
            for event in events:
                if event == "__finish__":
                    mapper.finish()
                    continue
                chunks.extend(mapper.map(event))
            mapper.finish()
            return chunks
        for vector in VECTORS["streams"]:
            with self.subTest(vector["name"]):
                self.assertEqual(run(vector["events"], vector.get("singleToolCall", False)), vector["expect"])
        self.assertTrue(any(vector.get("singleToolCall") for vector in VECTORS["streams"]))
        for vector in VECTORS["streamErrors"]:
            with self.subTest(vector["name"]):
                with self.assertRaises(BridgeError) as caught:
                    run(vector["events"])
                self.assertEqual((caught.exception.status, caught.exception.kind, caught.exception.message, caught.exception.upstream),
                                 (vector["status"], vector["type"], vector["message"], vector["upstream"]))


class CatalogTests(unittest.TestCase):
    def test_catalog_matches_the_shared_file_and_runtime_split(self):
        raw = json.loads((APPS / "bedrock-models.json").read_text(encoding="utf-8"))
        entries = read_catalog()
        self.assertEqual([entry["id"] for entry in entries], [entry["id"] for entry in raw["models"]])
        agents = catalog_selection("openai-agents", {"AWWO_BEDROCK_CATALOG": "builtin-all"})
        pi = catalog_selection("pi", {"AWWO_BEDROCK_CATALOG": "builtin-all"})
        self.assertEqual(len(agents) + len(pi), len(entries))
        # builtin alone offers only the models verified with a real call.
        verified = catalog_selection("openai-agents", {"AWWO_BEDROCK_CATALOG": "builtin"})
        self.assertEqual([e["id"] for e in verified], [e["id"] for e in entries if e["runtime"] == "openai-agents" and e["verified"]])
        self.assertNotIn("bedrock.claude-opus-5-5", [e["id"] for e in verified])
        self.assertTrue(all(entry["tools"] for entry in agents))
        self.assertEqual(catalog_selection("openai-agents", {}), [])
        picked = catalog_selection("openai-agents", {"AWWO_BEDROCK_CATALOG": "builtin", "AWWO_BEDROCK_MODELS": "bedrock.kimi-k3,bedrock.claude-opus-5-5"})
        self.assertEqual([entry["id"] for entry in picked], ["bedrock.claude-opus-5-5", "bedrock.kimi-k3"])
        for env in ({"AWWO_BEDROCK_CATALOG": "all"}, {"AWWO_BEDROCK_CATALOG": "builtin", "AWWO_BEDROCK_MODELS": "bedrock.gemma-3-27b"},
                    {"AWWO_BEDROCK_CATALOG": "builtin", "AWWO_BEDROCK_MODELS": "bedrock.unknown"}):
            with self.subTest(env), self.assertRaises(ValueError):
                catalog_selection("openai-agents", env)

    def test_catalog_is_offered_only_in_its_verified_regions(self):
        raw = json.loads((APPS / "bedrock-models.json").read_text(encoding="utf-8"))
        self.assertEqual(read_catalog_regions(), tuple(raw["regions"]))
        for region in ("us-east-2", "eu-central-1"):
            with self.subTest(region), self.assertRaisesRegex(ValueError, "verified for us-east-1; for .* explicit MODELS_JSON profiles"):
                catalog_selection("openai-agents", {"AWWO_BEDROCK_CATALOG": "builtin", "AWWO_BEDROCK_REGION": region})
        entries = read_catalog()
        self.assertEqual(len(catalog_selection("pi", {"AWWO_BEDROCK_CATALOG": "builtin-all", "AWWO_BEDROCK_REGION": "us-west-2"}, entries, ("us-west-2",))),
                         len([e for e in entries if e["runtime"] == "pi"]))
        self.assertEqual(catalog_selection("pi", {"AWWO_BEDROCK_REGION": "eu-central-1"}), [])

    def test_missing_catalog_file_is_a_clear_error(self):
        from bedrock_catalog import CatalogError, read_catalog as read
        with self.assertRaisesRegex(CatalogError, "not deployed"):
            read((Path("/nonexistent/bedrock-models.json"),))
        self.assertEqual(len(read((APPS / "bedrock-models.json",))), len(read_catalog()))

    def test_malformed_catalog_and_policy_are_refused(self):
        good = {"id": "bedrock.test", "name": "Test", "vendor": "test", "target": "test.model-v1:0", "contextWindow": 32768,
                "maxTokens": 4096, "input": ["text"], "tools": True, "runtime": "openai-agents", "verified": ""}
        self.assertEqual(len(parse_catalog({"version": 1, "regions": ["us-east-1"], "models": [good]})), 1)
        for bad in ({**good, "tools": False}, {**good, "extra": 1}, {**good, "target": "nope"}, {**good, "input": ["image"]}, {**good, "name": "a\u0000b"}):
            with self.subTest(bad), self.assertRaises(ValueError):
                parse_catalog({"version": 1, "regions": ["us-east-1"], "models": [bad]})
        # The regions the entries were verified in are part of the catalog.
        for regions in (None, [], ["us-east-1", "us-east-1"], ["us-gov-west-1"], "us-east-1", [1]):
            with self.subTest(regions=regions), self.assertRaises(ValueError):
                parse_catalog({"version": 1, "regions": regions, "models": [good]} if regions is not None else {"version": 1, "models": [good]})
        self.assertEqual(parse_catalog_file({"version": 1, "regions": ["us-east-1", "us-west-2"], "models": [good]})[0], ("us-east-1", "us-west-2"))
        self.assertEqual(parse_platform_providers(None), ("llmgate",))
        self.assertEqual(parse_platform_providers("bedrock,llmgate"), ("llmgate", "bedrock"))
        for value in ("bedrock", "llmgate,llmgate", "llmgate,openai"):
            with self.subTest(value), self.assertRaises(ValueError):
                parse_platform_providers(value)
        self.assertEqual(platform_health(True, ("llmgate",)), {"llmgateOnly": True})
        self.assertEqual(platform_health(True, ("llmgate", "bedrock")), {"platformOnly": True, "platformProviders": ["llmgate", "bedrock"]})
        self.assertEqual(platform_health(False, ("llmgate", "bedrock")), {})


class ConfigTests(unittest.TestCase):
    def test_catalog_profiles_and_health(self):
        config = catalog_config()
        self.assertTrue(config.ready)
        claude = resolve_model_config(config, "bedrock.claude-opus-5-5")
        self.assertEqual((claude.provider, claude.model, claude.region, claude.base_url, claude.protocol, claude.api_key),
                         ("bedrock", "global.anthropic.claude-opus-5-5", "us-east-1", bridge_base_url("us-east-1"), "chat_completions", ""))
        health = public_health(config)
        entry = next(model for model in health["models"] if model["id"] == "bedrock.claude-opus-5-5")
        self.assertEqual(entry["name"], "Claude Opus 5.5")
        self.assertEqual(entry["provider"], "bedrock")
        self.assertEqual(entry["reasoningEfforts"], [])
        self.assertNotIn("amazonaws", json.dumps(health))
        # The JS and Python workers advertise the same Bedrock catalog for the Agents runtime.
        self.assertEqual([m["id"] for m in health["models"][1:]], [e["id"] for e in read_catalog() if e["runtime"] == "openai-agents"])

    def test_gate_only_policy(self):
        with self.assertRaisesRegex(ConfigError, "AWWO_PLATFORM_PROVIDERS includes bedrock"):
            catalog_config(AWWO_LLMGATE_ONLY="true")
        allowed = public_health(catalog_config(AWWO_LLMGATE_ONLY="true", AWWO_PLATFORM_PROVIDERS="llmgate,bedrock"))
        self.assertNotIn("llmgateOnly", allowed)
        self.assertEqual((allowed["platformOnly"], allowed["platformProviders"]), (True, ["llmgate", "bedrock"]))
        gate = public_health(load_config({**GATE, "AWWO_LLMGATE_ONLY": "true"}))
        self.assertEqual(gate["llmgateOnly"], True)
        self.assertNotIn("platformOnly", gate)
        # A policy that allows Bedrock is not a claim to reach it: without a Bedrock model the
        # worker stays exactly Gate-only, in operator and personal mode alike.
        allowed_unused = public_health(load_config({**GATE, "AWWO_LLMGATE_ONLY": "true", "AWWO_PLATFORM_PROVIDERS": "llmgate,bedrock"}))
        self.assertEqual((allowed_unused.get("llmgateOnly"), allowed_unused.get("platformOnly")), (True, None))
        personal = public_health(load_config({**GATE, "AWWO_LLMGATE_ONLY": "true", "AWWO_PLATFORM_PROVIDERS": "llmgate,bedrock", "AWWO_CREDENTIAL_MODE": "user"}))
        self.assertEqual(personal.get("llmgateOnly"), True)
        with self.assertRaisesRegex(ConfigError, "operator credentials"):
            catalog_config(AWWO_CREDENTIAL_MODE="user")
        self.assertEqual(platform_providers_in_use(("llmgate", "bedrock"), ["llmgate"]), ("llmgate",))
        self.assertEqual(platform_providers_in_use(("llmgate", "bedrock"), ["llmgate", "bedrock"]), ("llmgate", "bedrock"))
        with self.assertRaisesRegex(ConfigError, "Bedrock catalog configuration is invalid"):
            catalog_config(AWWO_BEDROCK_REGION="mars-1")

    def test_models_json_bedrock_profiles(self):
        def config(value, **extra):
            return load_config({**GATE, "AWWO_OPENAI_AGENTS_MODELS_JSON": json.dumps([{"id": "bedrock-kimi", "provider": "bedrock", "model": "moonshotai.kimi-k2.5", **value}]), **extra})
        kimi = resolve_model_config(config({"region": "us-east-2", "apiKeyEnv": "BEDROCK_KEY", "name": "Kimi K2.5"}, BEDROCK_KEY=BEDROCK_KEY), "bedrock-kimi")
        self.assertEqual((kimi.region, kimi.api_key, kimi.name, kimi.base_url), ("us-east-2", BEDROCK_KEY, "Kimi K2.5", bridge_base_url("us-east-2")))
        self.assertEqual(resolve_model_config(config({}), "bedrock-kimi").api_key, "")
        # The thinking switch has no Converse counterpart: both workers refuse it on a Bedrock profile.
        for extra in ({"baseURL": "https://x"}, {"reasoningEfforts": ["high"]}, {"structuredOutput": True}, {"disableThinking": True},
                      {"disableThinking": False}, {"region": "us-gov-west-1"}, {"unknown": 1}, {"contextWindow": 4096, "maxTokens": 4000}):
            with self.subTest(extra), self.assertRaises(ConfigError):
                config(extra)
        missing = config({"apiKeyEnv": "ABSENT_KEY"})
        self.assertFalse(missing.ready)
        self.assertIn("AWWO_OPENAI_AGENTS_MODELS_JSON_CREDENTIALS", missing.missing)


class FakeStream:
    def __init__(self, events, fail_after=None, fail_code="modelStreamErrorException"):
        self.events = events
        self.fail_after = fail_after
        self.fail_code = fail_code
        self.closed = False

    def __iter__(self):
        for index, event in enumerate(self.events):
            if self.closed:
                return
            if self.fail_after is not None and index == self.fail_after:
                raise EventStreamError({"Error": {"Code": self.fail_code, "Message": "arn:aws:iam::563688183799:role/x"}}, "ConverseStream")
            yield event

    def close(self):
        self.closed = True


class FakeClient:
    def __init__(self, record, events, fail=None, fail_after=None, fail_code="modelStreamErrorException"):
        self.record = record
        self.events = events
        self.fail = fail
        self.fail_after = fail_after
        self.fail_code = fail_code

    def converse_stream(self, **kwargs):
        self.record["input"] = kwargs
        if self.fail:
            raise self.fail
        return {"stream": FakeStream(self.events, self.fail_after, self.fail_code)}


def text_turn(text, prefix=()):
    return [{"messageStart": {"role": "assistant"}}, *prefix,
            {"contentBlockDelta": {"contentBlockIndex": 1, "delta": {"text": text}}},
            {"contentBlockStop": {"contentBlockIndex": 1}}, {"messageStop": {"stopReason": "end_turn"}},
            {"metadata": {"usage": {"inputTokens": 12, "outputTokens": 4, "totalTokens": 16}, "metrics": {"latencyMs": 3}}}]


class BridgedRunTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        set_trace_processors([])
        self.record = {}
        self.events = text_turn("你好，来自 Bedrock。")
        self.fail = None
        self.fail_after = None
        self.fail_code = "modelStreamErrorException"

        def factory(region, auth, read_timeout):
            self.record.update(region=region, auth=auth, read_timeout=read_timeout, thread=threading.current_thread().name)
            return FakeClient(self.record, self.events, self.fail, self.fail_after, self.fail_code)
        import runner
        original = runner.BedrockConverseTransport

        def transport(**kwargs):
            return original(**kwargs, client_factory=factory)
        runner.BedrockConverseTransport = transport
        self.addCleanup(setattr, runner, "BedrockConverseTransport", original)

    async def run_model(self, model, **values):
        config = catalog_config(AWWO_BEDROCK_API_KEY=BEDROCK_KEY, AWWO_OPENAI_AGENTS_TOOLS_JSON='["calculator"]')
        request = RunRequest("r1", "t1", "s1", values.pop("prompt", "Say hello"), values.pop("messages", []), model=model, **values)
        return [event async for event in stream_run(request, config, asyncio.Event())]

    async def test_text_turn_with_usage_and_reasoning_count_only(self):
        self.events = text_turn("你好，来自 Bedrock。", prefix=[{"contentBlockDelta": {"contentBlockIndex": 0, "delta": {"reasoningContent": {"text": REASONING_TEXT}}}},
                                                       {"contentBlockStop": {"contentBlockIndex": 0}}])
        events = await self.run_model("bedrock.kimi-k2-5", system_prompt="You are terse.",
                                      messages=[{"role": "user", "content": "Earlier"}, {"role": "assistant", "content": "Earlier answer"}])
        self.assertEqual(events[-1]["type"], "completed", events[-1])
        self.assertEqual(events[-1]["text"], "你好，来自 Bedrock。")
        self.assertEqual("".join(e["delta"] for e in events if e["type"] == "text_delta"), "你好，来自 Bedrock。")
        self.assertNotIn("44102", json.dumps(events, ensure_ascii=False))
        usage = events[-1]["observability"]["usage"]
        self.assertEqual((usage["status"], usage["inputTokens"], usage["outputTokens"]), ("reported", 12, 4))
        sent = self.record["input"]
        self.assertEqual(sent["modelId"], "moonshotai.kimi-k2.5")
        self.assertEqual(sent["system"], [{"text": "You are terse."}])
        self.assertEqual([[m["role"], "".join(b.get("text", "") for b in m["content"])] for m in sent["messages"]],
                         [["user", "Earlier"], ["assistant", "Earlier answer"], ["user", "Say hello"]])
        self.assertEqual(self.record["auth"], {"bearer_token": BEDROCK_KEY})
        self.assertEqual(self.record["read_timeout"], 120.0)
        self.assertEqual(self.record["thread"], "awwo-bedrock-converse", "boto3 never blocks the event loop")

    async def test_tool_call_result_is_the_output(self):
        self.events = [{"messageStart": {"role": "assistant"}},
                       {"contentBlockStart": {"contentBlockIndex": 0, "start": {"toolUse": {"toolUseId": "tooluse_calc", "name": "calculator"}}}},
                       {"contentBlockDelta": {"contentBlockIndex": 0, "delta": {"toolUse": {"input": '{"expression":"(2+3)*4"}'}}}},
                       {"contentBlockStop": {"contentBlockIndex": 0}}, {"messageStop": {"stopReason": "tool_use"}},
                       {"metadata": {"usage": {"inputTokens": 30, "outputTokens": 9}}}]
        events = await self.run_model("bedrock.deepseek-v3-2", tools=["calculator"], prompt="Compute (2+3)*4")
        self.assertEqual(events[-1]["type"], "completed", events[-1])
        self.assertIn("20", events[-1]["text"])
        self.assertEqual([tool["toolSpec"]["name"] for tool in self.record["input"]["toolConfig"]["tools"]], ["calculator"])

    async def test_provider_failures_map_to_known_codes(self):
        self.fail = ClientError({"Error": {"Code": "AccessDeniedException", "Message": "User: arn:aws:sts::563688183799:assumed-role/x"},
                                 "ResponseMetadata": {"HTTPStatusCode": 403}}, "ConverseStream")
        denied = await self.run_model("bedrock.glm-5")
        self.assertEqual((denied[-1]["type"], denied[-1]["code"]), ("failed", "MODEL_AUTHENTICATION"))
        self.assertNotIn("563688183799", json.dumps(denied))
        self.fail = ClientError({"Error": {"Code": "ThrottlingException", "Message": "slow"}, "ResponseMetadata": {"HTTPStatusCode": 429}}, "ConverseStream")
        self.assertEqual((await self.run_model("bedrock.glm-5"))[-1]["code"], "MODEL_RATE_LIMIT")
        self.fail = None
        self.events = [{"messageStart": {}}, {"contentBlockDelta": {"delta": {"text": "half"}}}, {"messageStop": {"stopReason": "end_turn"}}]
        self.fail_after = 2
        broken = await self.run_model("bedrock.glm-5")
        self.assertEqual(broken[-1]["type"], "failed")
        self.assertFalse(any(event["type"] == "completed" for event in broken))
        # A throttle after the stream began is still a rate limit, not an unknown model error.
        self.fail_code = "throttlingException"
        self.assertEqual((await self.run_model("bedrock.glm-5"))[-1]["code"], "MODEL_RATE_LIMIT")
        self.fail_code = "modelStreamErrorException"
        self.fail_after = None
        self.events = [{"messageStart": {}}, {"contentBlockDelta": {"delta": {"text": "cut"}}}, {"messageStop": {"stopReason": "max_tokens"}}]
        self.assertEqual((await self.run_model("bedrock.glm-5"))[-1]["type"], "failed")

    async def test_one_tool_call_per_turn_runs_only_the_first(self):
        # The worker asks for parallel_tool_calls: false; a model that answers with two calls
        # has only the first relayed, so only one tool runs.
        def call(index, tool_id, expression):
            return [{"contentBlockStart": {"contentBlockIndex": index, "start": {"toolUse": {"toolUseId": tool_id, "name": "calculator"}}}},
                    {"contentBlockDelta": {"contentBlockIndex": index, "delta": {"toolUse": {"input": json.dumps({"expression": expression})}}}},
                    {"contentBlockStop": {"contentBlockIndex": index}}]
        self.events = [{"messageStart": {"role": "assistant"}}, *call(0, "tooluse_a", "(2+3)*4"), *call(1, "tooluse_b", "7*6"),
                       {"messageStop": {"stopReason": "tool_use"}}, {"metadata": {"usage": {"inputTokens": 30, "outputTokens": 12}}}]
        import runner
        ran = []
        original = runner.execute_tool

        def counting(name, value):
            ran.append(value)
            return original(name, value)
        runner.execute_tool = counting
        self.addCleanup(setattr, runner, "execute_tool", original)
        events = await self.run_model("bedrock.deepseek-v3-2", tools=["calculator"], prompt="Compute two things")
        self.assertEqual(events[-1]["type"], "completed", events[-1])
        self.assertEqual(ran, [{"expression": "(2+3)*4"}])
        self.assertNotIn("42", events[-1]["text"])


class TransportTests(unittest.IsolatedAsyncioTestCase):
    async def test_only_the_pinned_endpoint_is_served(self):
        calls = []
        transport = BedrockConverseTransport(region="us-east-1", model="zai.glm-5", auth={"aws": True},
                                             client_factory=lambda *args: calls.append(args) or FakeClient({}, text_turn("x")))
        async with httpx2.AsyncClient(transport=transport) as client:
            base = bridge_base_url("us-east-1")
            for url in (f"{base}/chat/completions?x=1", f"{base}/responses", "https://example.com/chat/completions"):
                self.assertEqual((await client.post(url, json={})).status_code, 404)
            self.assertEqual((await client.get(f"{base}/chat/completions")).status_code, 404)
            bad = await client.post(f"{base}/chat/completions", content=b"{")
            self.assertEqual(bad.status_code, 400)
            self.assertEqual(calls, [])
            body = {"model": "zai.glm-5", "stream": True, "messages": [{"role": "user", "content": "hi"}]}
            async with client.stream("POST", f"{base}/chat/completions", json=body, headers={"authorization": f"Bearer {BRIDGE_API_KEY}"}) as response:
                self.assertEqual(response.status_code, 200)
                frames = [line async for line in response.aiter_lines() if line]
        self.assertEqual(frames[-1], "data: [DONE]")
        self.assertEqual(calls[0][:2], ("us-east-1", {"aws": True}))

    def test_auth_records_and_failures(self):
        self.assertTrue(valid_auth({"bearer_token": BEDROCK_KEY}))
        self.assertTrue(valid_auth({"aws": True}))
        for value in ({}, {"aws": False}, {"bearer_token": "short"}, {"aws": True, "bearer_token": BEDROCK_KEY}, None):
            self.assertFalse(valid_auth(value))
        with self.assertRaises(ValueError):
            BedrockConverseTransport(region="us-east-1", model="m", auth={})
        with self.assertRaises(ValueError):
            BedrockConverseTransport(region="us-gov-west-1", model="m", auth={"aws": True})
        denied = bridge_failure(ClientError({"Error": {"Code": "AccessDeniedException", "Message": "arn:aws:iam::1:role/x"}, "ResponseMetadata": {"HTTPStatusCode": 403}}, "ConverseStream"))
        self.assertEqual((denied.status, denied.kind), (403, "AccessDeniedException"))
        self.assertNotIn("arn", denied.message)
        stream = bridge_failure(EventStreamError({"Error": {"Code": "throttlingException", "Message": "x"}}, "ConverseStream"))
        self.assertEqual((stream.status, stream.kind), (429, "ThrottlingException"))
        self.assertEqual(bridge_failure(OSError("reset")).status, 502)
        from botocore.exceptions import NoCredentialsError
        self.assertEqual(bridge_failure(NoCredentialsError()).status, 401, "no usable AWS credentials is an authentication failure")
        self.assertEqual(classify_error(BridgeError(401, "api_error", "x"))["code"], "MODEL_AUTHENTICATION")
        self.assertEqual(classify_error(httpx2.HTTPStatusError("x", request=httpx2.Request("POST", "https://x"), response=httpx2.Response(429)))["code"], "MODEL_ERROR")

    def test_default_client_pins_endpoint_and_sends_a_bearer_key_unsigned(self):
        from botocore import UNSIGNED
        # Stub credentials: the test never consults this machine's AWS chain or instance metadata.
        stub = {"AWS_ACCESS_KEY_ID": "AKIAEXAMPLESTUB00000", "AWS_SECRET_ACCESS_KEY": "stub-secret-stub-secret-0000",
                "AWS_EC2_METADATA_DISABLED": "true", "AWS_CONFIG_FILE": os.devnull, "AWS_SHARED_CREDENTIALS_FILE": os.devnull}
        self.enterContext(mock.patch.dict(os.environ, stub))
        client = default_client("us-east-2", {"bearer_token": BEDROCK_KEY}, 42.0)
        self.assertEqual(client.meta.endpoint_url, "https://bedrock-runtime.us-east-2.amazonaws.com")
        self.assertIs(client.meta.config.signature_version, UNSIGNED)
        self.assertEqual(client.meta.config.read_timeout, 42.0)
        self.assertEqual(client.meta.config.retries["total_max_attempts"], 1)

        class Request:
            headers = {}
        request = Request()
        client.meta.events.emit("before-send.bedrock-runtime.ConverseStream", request=request)
        self.assertEqual(request.headers["Authorization"], f"Bearer {BEDROCK_KEY}")
        signed = default_client("us-east-1", {"aws": True}, 10.0)
        self.assertIsNot(signed.meta.config.signature_version, UNSIGNED)
        # One client per region, key and timeout, reused across model calls.
        self.assertIs(default_client("us-east-2", {"bearer_token": BEDROCK_KEY}, 42.0), client)
        self.assertIs(default_client("us-east-1", {"aws": True}, 10.0), signed)
        self.assertIsNot(default_client("us-east-1", {"aws": True}, 11.0), signed)
        self.assertEqual(signed.meta.config.max_pool_connections, 32)

    def test_a_client_is_not_cached_while_the_credential_chain_has_nothing(self):
        from botocore.exceptions import NoCredentialsError
        empty = tempfile.mkdtemp()
        isolated = {"AWS_EC2_METADATA_DISABLED": "true", "AWS_CONFIG_FILE": os.path.join(empty, "config"),
                    "AWS_SHARED_CREDENTIALS_FILE": os.path.join(empty, "credentials")}
        cleared = {name: value for name, value in os.environ.items() if not name.startswith("AWS_")}
        with mock.patch.dict(os.environ, {**cleared, **isolated}, clear=True):
            # An instance role that is briefly unavailable must not poison later calls.
            with self.assertRaises(NoCredentialsError):
                default_client("eu-west-1", {"aws": True}, 33.0)
            os.environ.update({"AWS_ACCESS_KEY_ID": "AKIAEXAMPLESTUB00000", "AWS_SECRET_ACCESS_KEY": "stub-secret-stub-secret-0000"})
            client = default_client("eu-west-1", {"aws": True}, 33.0)
            self.assertIsNotNone(client._request_signer._credentials)
        self.assertEqual(bridge_failure(NoCredentialsError()).status, 401)

    def test_only_aws_failures_carry_a_status_in_error_frames(self):
        from bedrock_bridge import _error_body
        refused = ChunkMapper("m")
        with self.assertRaises(BridgeError) as caught:
            refused.map({"contentBlockDelta": {"delta": {"citation": {"title": "doc"}}}})
        self.assertNotIn("status", _error_body(caught.exception)["error"])
        with self.assertRaises(BridgeError) as throttled:
            ChunkMapper("m").map({"throttlingException": {"message": "slow"}})
        self.assertEqual(_error_body(throttled.exception)["error"]["status"], 429)
        self.assertEqual(_error_body(bridge_failure(OSError("reset")))["error"]["status"], 502)


if __name__ == "__main__":
    unittest.main()
