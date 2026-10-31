"""Bedrock through the Converse bridge: parity with the TypeScript bridge, configuration,
and the real Agents SDK over the bridge transport with a fake boto3 client (no network)."""
import asyncio
import json
import os
import socket
import struct
import tempfile
import threading
import time
import unittest
import zlib
from pathlib import Path
from unittest import mock

import httpx2
from agents import set_trace_processors
from botocore.exceptions import ClientError, EventStreamError
from urllib3.exceptions import ProtocolError

from bedrock_bridge import (
    BEDROCK_CONNECTION_FAILURE, BRIDGE_API_KEY, REASONING_EFFORTS, SUMMARIZED_THINKING, BedrockConverseTransport, BridgeError, ChunkMapper, SummaryWatch, bedrock_fact_line,
    bridge_base_url, bridge_failure, call_read_timeout, default_client, stream_read_timeout, to_converse_input, valid_auth, valid_reasoning_efforts,
    with_claude_prompt_cache, with_summarized_thinking,
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


class DeadlineTests(unittest.TestCase):
    def test_a_run_may_be_given_up_to_thirty_minutes(self):
        # 2 minutes by default; production gives 25 (the old cap, 10, cut Claude Opus 5.5's long tasks short).
        self.assertEqual(catalog_config().timeout_ms, 120_000)
        for value in ("1500000", "1800000"):
            self.assertEqual(catalog_config(AWWO_OPENAI_AGENTS_TIMEOUT_MS=value).timeout_ms, int(value))
        with self.assertRaises(ConfigError):
            catalog_config(AWWO_OPENAI_AGENTS_TIMEOUT_MS="1800001")

    def test_the_python_sdks_timeout_is_the_runs_deadline(self):
        from openai import APITimeoutError
        request = httpx2.Request("POST", "https://gate.example/v1/chat/completions")
        self.assertEqual(classify_error(APITimeoutError(request=request))["code"], "DEADLINE_EXCEEDED")
        # The SDK raises its timeout from the transport's own exception: a read past the deadline is the deadline, while
        # one that could not connect (5 s) never reached the model service, which a retry may find again.
        for cause, code in ((httpx2.ReadTimeout("read", request=request), "DEADLINE_EXCEEDED"),
                            (httpx2.ConnectTimeout("connect", request=request), "MODEL_UNAVAILABLE")):
            try:
                raise APITimeoutError(request=request) from cause
            except APITimeoutError as error:
                self.assertEqual(classify_error(error)["code"], code, type(cause).__name__)


class ConnectTimeoutRunTests(unittest.IsolatedAsyncioTestCase):
    async def test_a_run_that_cannot_connect_reads_as_the_service_unavailable_through_the_real_sdk(self):
        # The SDK raises its APITimeoutError from the transport's ConnectTimeout (openai 3.x, `from err`): the run never
        # reached the model service, which a canvas node is run again after, unlike the run's own deadline (2026-10-18).
        import runner

        def refuse(request):
            raise httpx2.ConnectTimeout("connect timed out", request=request)
        original = runner.DefaultAsyncHttpxClient

        def client(**kwargs):
            kwargs.setdefault("transport", httpx2.MockTransport(refuse))
            return original(**kwargs)
        runner.DefaultAsyncHttpxClient = client
        self.addCleanup(setattr, runner, "DefaultAsyncHttpxClient", original)
        # The Gate's own URL: the mock transport answers before any connection is tried.
        events = [event async for event in stream_run(RunRequest("r1", "t1", "s1", "Say hello", []), load_config(GATE), asyncio.Event())]
        self.assertEqual((events[-1]["type"], events[-1].get("code")), ("failed", "MODEL_UNAVAILABLE"), events[-1])


class VectorParityTests(unittest.TestCase):
    """The Python bridge must match the TypeScript bridge on the shared vectors."""

    def test_requests_map_identically(self):
        # "efforts": the thinking efforts the vector's profile offers (none where it says none).
        for vector in VECTORS["requests"]:
            with self.subTest(vector["name"]):
                self.assertEqual(to_converse_input(vector["body"], VECTORS["model"], tuple(vector.get("efforts", ()))), vector["expect"])
        self.assertTrue(any(vector.get("efforts") for vector in VECTORS["requests"]))

    def test_refusals_match(self):
        for vector in VECTORS["errors"]:
            with self.subTest(vector["name"]):
                with self.assertRaises(BridgeError) as caught:
                    to_converse_input(vector["body"], VECTORS["model"], tuple(vector.get("efforts", ())))
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
        self.assertIn("bedrock.claude-opus-5-5", [e["id"] for e in verified])
        self.assertNotIn("bedrock.gpt-6-1-sol", [e["id"] for e in verified])
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
        # The output limit per call goes up to 65,536 (Claude Opus 5.5 has 64,000), as in apps/bedrock-catalog.ts.
        self.assertEqual(len(parse_catalog({"version": 1, "regions": ["us-east-1"], "models": [{**good, "contextWindow": 200000, "maxTokens": 65536}]})), 1)
        for bad in ({**good, "tools": False}, {**good, "extra": 1}, {**good, "target": "nope"}, {**good, "input": ["image"]}, {**good, "name": "a\u0000b"},
                    {**good, "contextWindow": 200000, "maxTokens": 65537}):
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

    def test_a_fallback_target_is_the_same_model_through_its_other_profile(self):
        good = {"id": "bedrock.test", "name": "Test", "vendor": "test", "target": "global.anthropic.claude-x", "contextWindow": 32768,
                "maxTokens": 4096, "input": ["text"], "tools": True, "runtime": "openai-agents", "verified": ""}
        catalog = lambda entry: {"version": 1, "regions": ["us-east-1"], "models": [entry]}  # noqa: E731
        for target, fallback in (("global.anthropic.claude-x", "us.anthropic.claude-x"), ("us.anthropic.claude-x", "global.anthropic.claude-x"),
                                 ("eu.meta.llama-y:0", "global.meta.llama-y:0")):
            with self.subTest(target=target):
                self.assertEqual(parse_catalog(catalog({**good, "target": target, "fallbackTarget": fallback}))[0]["fallbackTarget"], fallback)
        for fallback in ("us.anthropic.claude-y", "global.anthropic.claude-x", "anthropic.claude-x", "us.anthropic.claude-x https://x", "", None,
                         ["us.anthropic.claude-x"]):
            with self.subTest(fallback=fallback), self.assertRaises(ValueError):
                parse_catalog(catalog({**good, "fallbackTarget": fallback}))
        with self.assertRaises(ValueError):
            parse_catalog(catalog({**good, "target": "anthropic.claude-x", "fallbackTarget": "us.anthropic.claude-x"}))
        with self.assertRaises(ValueError):
            parse_catalog(catalog({**good, "fallbackTarget": "us.anthropic.claude-x", "extra": 1}))
        self.assertNotIn("fallbackTarget", parse_catalog(catalog(good))[0])
        claude = [entry for entry in read_catalog() if entry["vendor"] == "anthropic"]
        self.assertGreaterEqual(len(claude), 7)
        for entry in claude:
            self.assertEqual(entry["fallbackTarget"], entry["target"].replace("global.", "us.", 1), entry["id"])
        self.assertTrue(all(entry["vendor"] == "anthropic" or "fallbackTarget" not in entry for entry in read_catalog()))

    def test_thinking_efforts_are_a_claude_entrys_own_levels_with_a_default_among_them(self):
        good = {"id": "bedrock.test", "name": "Test", "vendor": "anthropic", "target": "global.anthropic.claude-x", "contextWindow": 32768,
                "maxTokens": 4096, "input": ["text"], "tools": True, "runtime": "openai-agents", "verified": ""}
        catalog = lambda entry: {"version": 1, "regions": ["us-east-1"], "models": [entry]}  # noqa: E731
        entry = parse_catalog(catalog({**good, "reasoningEfforts": ["low", "medium", "high"], "defaultReasoningEffort": "medium"}))[0]
        self.assertEqual((entry["reasoningEfforts"], entry["defaultReasoningEffort"]), (["low", "medium", "high"], "medium"))
        self.assertEqual(parse_catalog(catalog({**good, "reasoningEfforts": ["low"]}))[0]["reasoningEfforts"], ["low"])
        for label, bad in (("another vendor", {**good, "vendor": "test", "reasoningEfforts": ["low"]}), ("no level", {**good, "reasoningEfforts": []}),
                           ("a level Bedrock refuses", {**good, "reasoningEfforts": ["minimal"]}), ("a level not offered", {**good, "reasoningEfforts": ["low", "xhigh"]}),
                           ("twice", {**good, "reasoningEfforts": ["low", "low"]}), ("not a list", {**good, "reasoningEfforts": "low"}),
                           ("a default not among them", {**good, "reasoningEfforts": ["low"], "defaultReasoningEffort": "medium"}),
                           ("a default without levels", {**good, "defaultReasoningEffort": "medium"}),
                           ("an empty default", {**good, "reasoningEfforts": ["low"], "defaultReasoningEffort": ""})):
            with self.subTest(label), self.assertRaises(ValueError):
                parse_catalog(catalog(bad))
        # The built-in catalog offers them for Claude Opus 5.5 alone, at its own default, as apps/bedrock-catalog.ts reads it.
        self.assertEqual([(e["id"], e["reasoningEfforts"], e.get("defaultReasoningEffort")) for e in read_catalog() if "reasoningEfforts" in e],
                         [("bedrock.claude-opus-5-5", ["low", "medium", "high"], "medium")])


class ConfigTests(unittest.TestCase):
    def test_catalog_profiles_and_health(self):
        config = catalog_config()
        self.assertTrue(config.ready)
        claude = resolve_model_config(config, "bedrock.claude-opus-5-5")
        self.assertEqual((claude.provider, claude.model, claude.region, claude.base_url, claude.protocol, claude.api_key),
                         ("bedrock", "global.anthropic.claude-opus-5-5", "us-east-1", bridge_base_url("us-east-1"), "chat_completions", ""))
        # The catalog's fallbackTarget reaches the profile; a model without one has none.
        self.assertEqual(claude.fallback_model, "us.anthropic.claude-opus-5-5")
        self.assertEqual(resolve_model_config(config, "bedrock.kimi-k3").fallback_model, "")
        health = public_health(config)
        entry = next(model for model in health["models"] if model["id"] == "bedrock.claude-opus-5-5")
        self.assertEqual(entry["name"], "Claude Opus 5.5")
        self.assertEqual(entry["provider"], "bedrock")
        # The thinking efforts its catalog entry offers, and the one it thinks at when none is chosen (shown, never sent).
        self.assertEqual((entry["reasoningEfforts"], entry["defaultReasoningEffort"]), (["low", "medium", "high"], "medium"))
        self.assertEqual(claude.reasoning_efforts, ("low", "medium", "high"))
        self.assertTrue(health["supportsEffortSelection"])
        self.assertEqual([m["id"] for m in health["models"] if m["reasoningEfforts"]], ["bedrock.claude-opus-5-5"])
        self.assertNotIn("amazonaws", json.dumps(health))
        # The JS and Python workers advertise the same Bedrock catalog for the Agents runtime.
        self.assertEqual([m["id"] for m in health["models"][1:]], [e["id"] for e in read_catalog() if e["runtime"] == "openai-agents"])

    def test_health_publishes_the_caps_each_model_is_called_with(self):
        # The output budget a model answers with is the one thing an operator cannot see from the
        # outside, and the Python worker was the only runtime omitting it: in production the default
        # model ran at 4,096 output tokens while Pi and the JS worker ran the same model at 16,384
        # (2026-10-06). Both numbers are published per model, so a mismatch between runtimes is visible.
        config = catalog_config(AWWO_OPENAI_AGENTS_CONTEXT_WINDOW="131072", AWWO_OPENAI_AGENTS_MAX_TOKENS="16384")
        health = public_health(config)
        default = next(model for model in health["models"] if model["id"] == config.model)
        self.assertEqual((default["contextWindow"], default["maxOutputTokens"], default["maxContextTextBytes"]),
                         (131072, 16384, 131072 - 16384 - 256))
        self.assertEqual((health["limits"]["contextWindow"], health["limits"]["maxOutputTokens"]), (131072, 16384))
        # A catalog entry keeps its own caps, which is what makes a per-model difference legible.
        claude = next(model for model in health["models"] if model["id"] == "bedrock.claude-opus-5-5")
        profile = resolve_model_config(config, "bedrock.claude-opus-5-5")
        self.assertEqual((claude["contextWindow"], claude["maxOutputTokens"]), (profile.context_window, profile.max_tokens))
        for model in health["models"]:
            self.assertGreaterEqual(model["contextWindow"], model["maxOutputTokens"] + 256, model["id"])
            self.assertEqual(model["maxContextTextBytes"], model["contextWindow"] - model["maxOutputTokens"] - 256, model["id"])
        # Unset caps stay the documented defaults rather than silently following a catalog entry.
        defaults = public_health(catalog_config())
        self.assertEqual((defaults["limits"]["contextWindow"], defaults["limits"]["maxOutputTokens"]), (32768, 4096))

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
    """A stream's events, failing at `fail_after` with AWS's EventStreamError of `fail_code`, or with `fail_code` itself
    when it is an exception (a failure AWS never reported, such as a connection reset)."""

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
                if isinstance(self.fail_code, BaseException):
                    raise self.fail_code
                raise EventStreamError({"Error": {"Code": self.fail_code, "Message": "arn:aws:iam::123456789012:role/x"}}, "ConverseStream")
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
        # The worker's own summary watch, fresh: its read timeouts are asserted below (SummaryWatch).
        self.enterContext(mock.patch("bedrock_bridge.SUMMARY_WATCH", SummaryWatch()))
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

    async def test_a_long_deadline_reaches_the_client_and_an_opus_5_5_call_streams_its_thinking(self):
        # Production gives a run 25 minutes, since Claude Opus 5.5 thinks before its first word (2026-10-18: a node cut
        # at 600 s with nothing written): the OpenAI client's own timeout follows the run's deadline, never the SDK's
        # 600 s default, and the call may write the model's 64,000 tokens. The call asks Bedrock to stream a summary of
        # its thinking, so without tools Bedrock's read waits at most 3 minutes for the next byte; with tools, the
        # stream's idle limit (2026-10-19: stalled calls rode out whole 25-minute runs), since Bedrock holds a tool call's
        # input back until the model has written it.
        import runner
        seen = {}
        original = runner.AsyncOpenAI

        def client(**kwargs):
            seen.update(kwargs)
            return original(**kwargs)
        runner.AsyncOpenAI = client
        self.addCleanup(setattr, runner, "AsyncOpenAI", original)
        config = catalog_config(AWWO_BEDROCK_API_KEY=BEDROCK_KEY, AWWO_OPENAI_AGENTS_TIMEOUT_MS="1500000",
                                AWWO_OPENAI_AGENTS_TOOLS_JSON='["calculator"]')
        for tools, want in (([], 180.0), (["calculator"], 900.0)):
            with self.subTest(tools=tools):
                request = RunRequest("r1", "t1", "s1", "Say hello", [], model="bedrock.claude-opus-5-5", tools=tools)
                events = [event async for event in stream_run(request, config, asyncio.Event())]
                self.assertEqual(events[-1]["type"], "completed", events[-1])
                self.assertEqual(self.record["read_timeout"], want)
                self.assertEqual((seen["timeout"].read, seen["timeout"].connect), (1500.0, 5.0))
                self.assertEqual(self.record["input"]["inferenceConfig"]["maxTokens"], 64000)
                self.assertEqual(self.record["input"]["additionalModelRequestFields"], {"thinking": {"type": "adaptive", "display": "summarized"}})

    async def test_an_opus_5_5_call_streams_its_summarized_thinking_as_a_count_and_answers(self):
        # As Bedrock streams it when asked (a probe call on 2026-10-21): reasoning text, then the block's signature, then
        # the answer. The thinking crosses the worker as a count only; the answer is the run's output.
        thinking = [{"contentBlockDelta": {"contentBlockIndex": 0, "delta": {"reasoningContent": {"text": REASONING_TEXT[:20]}}}},
                    {"contentBlockDelta": {"contentBlockIndex": 0, "delta": {"reasoningContent": {"text": REASONING_TEXT[20:]}}}},
                    {"contentBlockDelta": {"contentBlockIndex": 0, "delta": {"reasoningContent": {"signature": "c2lnbmF0dXJl"}}}},
                    {"contentBlockStop": {"contentBlockIndex": 0}}]
        self.events = text_turn("OK", prefix=thinking)
        events = await self.run_model("bedrock.claude-opus-5-5")
        self.assertEqual((events[-1]["type"], events[-1]["text"]), ("completed", "OK"), events[-1])
        self.assertEqual([event for event in events if event["type"] == "reasoning"][-1], {"type": "reasoning", "characters": len(REASONING_TEXT)})
        dumped = json.dumps(events, ensure_ascii=False)
        self.assertNotIn("44102", dumped)
        self.assertNotIn("c2lnbmF0dXJl", dumped)
        self.assertEqual(self.record["input"]["additionalModelRequestFields"], {"thinking": {"type": "adaptive", "display": "summarized"}})
        self.assertEqual(self.record["read_timeout"], 120.0, "the run's 2-minute deadline comes before the 3-minute limit")
        # A tool call after the thinking runs as before.
        self.events = [{"messageStart": {"role": "assistant"}}, *thinking,
                       {"contentBlockStart": {"contentBlockIndex": 1, "start": {"toolUse": {"toolUseId": "tooluse_calc", "name": "calculator"}}}},
                       {"contentBlockDelta": {"contentBlockIndex": 1, "delta": {"toolUse": {"input": '{"expression":"(2+3)*4"}'}}}},
                       {"contentBlockStop": {"contentBlockIndex": 1}}, {"messageStop": {"stopReason": "tool_use"}},
                       {"metadata": {"usage": {"inputTokens": 30, "outputTokens": 9}}}]
        events = await self.run_model("bedrock.claude-opus-5-5", tools=["calculator"], prompt="Compute (2+3)*4")
        self.assertEqual(events[-1]["type"], "completed", events[-1])
        self.assertIn("20", events[-1]["text"])
        self.assertNotIn("44102", json.dumps(events, ensure_ascii=False))
        self.assertEqual(self.record["input"]["additionalModelRequestFields"], {"thinking": {"type": "adaptive", "display": "summarized"}})

    async def test_an_opus_5_5_run_sends_the_effort_it_names_beside_the_summary(self):
        # A node's chosen thinking effort (2026-10-26): the Agents SDK sends it as reasoning_effort and the bridge as
        # Claude's output_config.effort, beside the summary of its thinking; the call keeps its 3-minute first-byte limit.
        config = catalog_config(AWWO_BEDROCK_API_KEY=BEDROCK_KEY, AWWO_OPENAI_AGENTS_TIMEOUT_MS="1500000")
        for effort in ("low", "medium", "high"):
            with self.subTest(effort=effort):
                request = RunRequest("r1", "t1", "s1", "Say hello", [], model="bedrock.claude-opus-5-5", effort=effort)
                events = [event async for event in stream_run(request, config, asyncio.Event())]
                self.assertEqual(events[-1]["type"], "completed", events[-1])
                self.assertEqual(self.record["input"]["additionalModelRequestFields"],
                                 {"output_config": {"effort": effort}, "thinking": {"type": "adaptive", "display": "summarized"}})
                self.assertEqual(self.record["read_timeout"], 180.0)
        # None named: the request it was before, the model at its own default.
        events = await self.run_model("bedrock.claude-opus-5-5")
        self.assertEqual(self.record["input"]["additionalModelRequestFields"], {"thinking": {"type": "adaptive", "display": "summarized"}})
        # A model that offers no level, or a level its model does not offer, is refused before any call.
        for model, effort in (("bedrock.kimi-k2-5", "low"), ("bedrock.claude-sonnet-5-5", "high")):
            with self.subTest(model=model):
                self.record.clear()
                events = await self.run_model(model, effort=effort)
                self.assertEqual((events[-1]["type"], events[-1].get("code")), ("failed", "MODEL_REQUEST_REJECTED"), events[-1])
                self.assertNotIn("input", self.record)

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
        self.fail = ClientError({"Error": {"Code": "AccessDeniedException", "Message": "User: arn:aws:sts::123456789012:assumed-role/x"},
                                 "ResponseMetadata": {"HTTPStatusCode": 403}}, "ConverseStream")
        denied = await self.run_model("bedrock.glm-5")
        self.assertEqual((denied[-1]["type"], denied[-1]["code"]), ("failed", "MODEL_AUTHENTICATION"))
        self.assertNotIn("123456789012", json.dumps(denied))
        self.fail = ClientError({"Error": {"Code": "ThrottlingException", "Message": "slow"}, "ResponseMetadata": {"HTTPStatusCode": 429}}, "ConverseStream")
        self.assertEqual((await self.run_model("bedrock.glm-5"))[-1]["code"], "MODEL_RATE_LIMIT")
        # A request larger than the model's window is that refusal, not a request the worker got wrong; AWS's words stay.
        self.fail = ClientError({"Error": {"Code": "ValidationException", "Message": "Input is too long for requested model. arn:aws:iam::123456789012:user/x"},
                                 "ResponseMetadata": {"HTTPStatusCode": 400}}, "ConverseStream")
        too_long = await self.run_model("bedrock.glm-5")
        self.assertEqual((too_long[-1]["type"], too_long[-1]["code"]), ("failed", "MODEL_CONTEXT_LIMIT"))
        self.assertNotIn("123456789012", json.dumps(too_long))
        self.fail = ClientError({"Error": {"Code": "ValidationException", "Message": "The provided model identifier is invalid."},
                                 "ResponseMetadata": {"HTTPStatusCode": 400}}, "ConverseStream")
        self.assertEqual((await self.run_model("bedrock.glm-5"))[-1]["code"], "MODEL_REQUEST_REJECTED")
        self.fail = None
        self.events = [{"messageStart": {}}, {"contentBlockDelta": {"delta": {"text": "half"}}}, {"messageStop": {"stopReason": "end_turn"}}]
        self.fail_after = 2
        broken = await self.run_model("bedrock.glm-5")
        self.assertEqual(broken[-1]["type"], "failed")
        self.assertFalse(any(event["type"] == "completed" for event in broken))
        # A throttle after the stream began is still a rate limit, not an unknown model error.
        self.fail_code = "throttlingException"
        self.assertEqual((await self.run_model("bedrock.glm-5"))[-1]["code"], "MODEL_RATE_LIMIT")
        # AWS's own outage after the stream began is the service's; a stream lost on its way to AWS (a connection reset,
        # which AWS never reported), with or without text before it, is the model's failure, billed as one: AWS may
        # already have done the work (plans.go refusedBeforeOutput).
        self.fail_code = "serviceUnavailableException"
        self.assertEqual((await self.run_model("bedrock.glm-5"))[-1]["code"], "MODEL_UNAVAILABLE")
        for fail_after in (1, 2):
            self.fail_after = fail_after
            self.fail_code = ProtocolError("Connection broken", ConnectionResetError(104, "Connection reset by peer"))
            reset = await self.run_model("bedrock.glm-5")
            self.assertEqual((reset[-1]["type"], reset[-1]["code"]), ("failed", "MODEL_ERROR"), fail_after)
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
        # Neither an AWS exception nor an HTTP status: the way to AWS failed, which AWS never reported.
        for error in (OSError("reset"), ProtocolError("Connection broken", ConnectionResetError(104, "Connection reset by peer"))):
            reset = bridge_failure(error)
            self.assertEqual((reset.status, reset.kind, reset.upstream), (502, BEDROCK_CONNECTION_FAILURE, True), repr(error))
        self.assertEqual(BEDROCK_CONNECTION_FAILURE, "connection_error")
        # An answer of AWS's that the bridge does not know is AWS's failure, as before: an error code it has no name for,
        # and the empty code botocore gives a stream exception its service model lacks (RealEventStreamTests).
        for code in ("someNewException", ""):
            unknown = bridge_failure(EventStreamError({"Error": {"Code": code, "Message": "arn:aws:iam::1:role/x"}}, "ConverseStream"))
            self.assertEqual((unknown.status, unknown.kind, unknown.upstream), (502, "api_error", True), code)
        from botocore.exceptions import NoCredentialsError
        self.assertEqual(bridge_failure(NoCredentialsError()).status, 401, "no usable AWS credentials is an authentication failure")
        self.assertEqual(classify_error(BridgeError(401, "api_error", "x"))["code"], "MODEL_AUTHENTICATION")
        too_long = bridge_failure(ClientError({"Error": {"Code": "ValidationException", "Message": "prompt is too long: 213462 tokens > 200000 maximum (arn:aws:iam::1:role/x)"},
                                               "ResponseMetadata": {"HTTPStatusCode": 400}}, "ConverseStream"))
        # (The worker classifies the HTTP 400 the transport makes of it, which the run above takes to MODEL_CONTEXT_LIMIT.)
        self.assertEqual((too_long.status, too_long.kind, too_long.message, too_long.upstream), (400, "context_length_exceeded", "Input is too long for requested model", True))
        invalid = bridge_failure(ClientError({"Error": {"Code": "ValidationException", "Message": "Malformed input request"}, "ResponseMetadata": {"HTTPStatusCode": 400}}, "ConverseStream"))
        self.assertEqual((invalid.status, invalid.kind), (400, "ValidationException"))
        self.assertEqual(classify_error(invalid)["code"], "MODEL_REQUEST_REJECTED")
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
        # Nor does a failure AWS never reported (a connection reset): AWS may already have done, and billed, the work.
        self.assertEqual(_error_body(bridge_failure(OSError("reset")))["error"],
                         {"message": "The Bedrock request failed", "type": "connection_error", "code": "connection_error"})


OPUS = "global.anthropic.claude-opus-5-5"
OPUS_US = "us.anthropic.claude-opus-5-5"
# The fact a call to Opus 5.5 at its own effort tells when it begins a spell of Bedrock streaming no thinking summary.
OPUS_SUMMARY_SILENT = {"event": "summary_watch", "model": "anthropic.claude-opus-5-5", "effort": "default", "state": "silent"}


def aws_error(code, status):
    return ClientError({"Error": {"Code": code, "Message": "arn:aws:iam::123456789012:user/machine/x is refused"},
                        "ResponseMetadata": {"HTTPStatusCode": status}}, "ConverseStream")


class ScriptedClient:
    """A boto3 client whose converse_stream calls play `steps` in order: an exception to raise, or a stream's events
    (with an optional EventStreamError at `fail_after`)."""

    def __init__(self, steps):
        self.steps = list(steps)
        self.calls = []
        self.streams = []

    def converse_stream(self, **kwargs):
        self.calls.append(kwargs)
        step = self.steps.pop(0)
        if isinstance(step, BaseException):
            raise step
        stream = FakeStream(step["events"], step.get("fail_after"), step.get("fail_code", "modelStreamErrorException"))
        self.streams.append(stream)
        return {"stream": stream}


class ProfileFallbackTests(unittest.IsolatedAsyncioTestCase):
    """The model's other inference profile (fallback_model), asked once when its profile refuses the call before
    anything streamed: as createBedrockFetch's fallbackModel in apps/bedrock-bridge.ts."""

    def setUp(self):
        # The worker's own summary watch, fresh: read timeouts are asserted below (SummaryWatch).
        self.enterContext(mock.patch("bedrock_bridge.SUMMARY_WATCH", SummaryWatch()))

    async def call(self, steps, **options):
        client = ScriptedClient(steps)
        facts = []
        settings = {"fallback_model": OPUS_US, "report": facts.append, **options}
        transport = BedrockConverseTransport(region="us-east-1", model=OPUS, auth={"aws": True}, client_factory=lambda *args: client, **settings)
        body = {"model": OPUS, "stream": True, "messages": [{"role": "user", "content": "hi"}]}
        async with httpx2.AsyncClient(transport=transport) as http:
            response = await http.post(f"{bridge_base_url('us-east-1')}/chat/completions", json=body)
        frames = [line[6:] for line in response.text.split("\n") if line.startswith("data: ")]
        return response.status_code, frames, client, facts

    def answered(self, status, frames):
        self.assertEqual(status, 200)
        self.assertEqual(frames[-1], "[DONE]")
        chunks = [json.loads(frame) for frame in frames[:-1]]
        self.assertTrue(all(chunk["model"] == OPUS for chunk in chunks), "the chunks name the model the caller asked for")
        return "".join(choice["delta"].get("content") or "" for chunk in chunks for choice in chunk["choices"])

    async def test_a_capacity_or_quota_refusal_turns_to_the_other_profile_once(self):
        for code, status in (("ServiceUnavailableException", 503), ("ThrottlingException", 429), ("InternalServerException", 500),
                             ("ModelNotReadyException", 503), ("ServiceQuotaExceededException", 429)):
            with self.subTest(code):
                status_code, frames, client, facts = await self.call([aws_error(code, status), {"events": text_turn("OK")}])
                self.assertEqual(self.answered(status_code, frames), "OK")
                self.assertEqual([call["modelId"] for call in client.calls], [OPUS, OPUS_US])
                self.assertEqual(client.calls[1], {**client.calls[0], "modelId": OPUS_US}, "the same request, only the profile differs")
                self.assertEqual(facts, [{"event": "fallback", "from": OPUS, "to": OPUS_US, "after": code}])

    async def test_the_other_profile_is_asked_with_the_calls_own_read_timeout(self):
        # One client serves both profiles of a call: a call to Claude Opus 4.8 or Opus 5.5 that offers no tools waits its
        # quick limit on its fallback profile too, and one that offers tools the transport's limit on both. Opus 5.5 asks
        # both profiles for its thinking summarized.
        tool = [{"type": "function", "function": {"name": "current_time", "parameters": {"type": "object", "properties": {}}}}]
        for (model, fallback), (extra, want) in [(pair, case) for pair in (("global.anthropic.claude-opus-4-8", "us.anthropic.claude-opus-4-8"),
                                                                          (OPUS, OPUS_US))
                                                 for case in (({}, 180.0), ({"tools": tool}, 900.0))]:
            with self.subTest(model=model, tools=bool(extra)):
                client, timeouts = ScriptedClient([aws_error("ThrottlingException", 429), {"events": text_turn("OK")}]), []

                def factory(region, auth, read_timeout, client=client, timeouts=timeouts):
                    timeouts.append(read_timeout)
                    return client
                transport = BedrockConverseTransport(region="us-east-1", model=model, auth={"aws": True}, read_timeout=900.0,
                                                     fallback_model=fallback, client_factory=factory, report=lambda fact: None)
                body = {"model": model, "stream": True, "messages": [{"role": "user", "content": "hi"}], **extra}
                async with httpx2.AsyncClient(transport=transport) as http:
                    response = await http.post(f"{bridge_base_url('us-east-1')}/chat/completions", json=body)
                self.assertEqual(response.status_code, 200)
                frames = [line[6:] for line in response.text.split("\n") if line.startswith("data: ")]
                self.assertEqual(frames[-1], "[DONE]")
                self.assertEqual("".join(choice["delta"].get("content") or "" for frame in frames[:-1]
                                         for choice in json.loads(frame)["choices"]), "OK")
                self.assertEqual([call["modelId"] for call in client.calls], [model, fallback])
                self.assertEqual(client.calls[1], {**client.calls[0], "modelId": fallback}, "the same request, only the profile differs")
                self.assertEqual("additionalModelRequestFields" in client.calls[0], model == OPUS)
                self.assertEqual(timeouts, [want], "one client, with the call's read timeout, for both profiles")

    async def test_an_exception_that_opens_the_stream_is_the_profiles_refusal(self):
        # As botocore raises it from the stream, and as the stream's first member.
        status, frames, client, facts = await self.call([{"events": text_turn("no"), "fail_after": 0, "fail_code": "throttlingException"},
                                                         {"events": text_turn("OK")}])
        self.assertEqual(self.answered(status, frames), "OK")
        self.assertEqual(facts, [{"event": "fallback", "from": OPUS, "to": OPUS_US, "after": "ThrottlingException"}])
        self.assertTrue(client.streams[0].closed, "the refused stream is closed")
        status, frames, client, facts = await self.call([{"events": [{"serviceUnavailableException": {"message": "busy"}}]}, {"events": text_turn("OK")}])
        self.assertEqual(self.answered(status, frames), "OK")
        self.assertEqual(facts, [{"event": "fallback", "from": OPUS, "to": OPUS_US, "after": "serviceUnavailableException"}])
        # An answer that opens normally is relayed as without a fallback, on the one profile.
        status, frames, client, facts = await self.call([{"events": text_turn("OK")}])
        self.assertEqual(self.answered(status, frames), "OK")
        self.assertEqual([call["modelId"] for call in client.calls], [OPUS])
        self.assertEqual(facts, [])
        # Once anything streamed, a refusal is the call's failure: nothing is asked again.
        status, frames, client, facts = await self.call([{"events": text_turn("late"), "fail_after": 1, "fail_code": "throttlingException"}])
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(frames[-1])["error"]["status"], 429)
        self.assertEqual([call["modelId"] for call in client.calls], [OPUS])
        self.assertEqual(facts, [{"event": "failed", "model": OPUS, "error": "ThrottlingException", "status": 429, "stage": "stream", "upstream": True}])
        # Another first exception is relayed as the stream's error, as it always was.
        status, frames, client, facts = await self.call([{"events": [{"validationException": {"message": "bad"}}]}])
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(frames[-1])["error"], {"message": "The Bedrock stream reported an error", "type": "validationException",
                                                           "code": "validationException", "status": 400})
        self.assertEqual(len(client.calls), 1)

    async def test_no_fallback_without_one_for_other_failures_or_a_second_time(self):
        status, frames, client, facts = await self.call([aws_error("ServiceUnavailableException", 503)], fallback_model="")
        self.assertEqual(status, 503)
        self.assertEqual(len(client.calls), 1)
        for code, code_status in (("AccessDeniedException", 403), ("ValidationException", 400), ("ModelTimeoutException", 408),
                                  ("ResourceNotFoundException", 404), ("ModelErrorException", 502)):
            with self.subTest(code):
                status, frames, client, facts = await self.call([aws_error(code, code_status)])
                self.assertEqual(status, code_status)
                self.assertEqual(len(client.calls), 1)
                self.assertEqual(facts, [{"event": "failed", "model": OPUS, "error": code, "status": code_status, "stage": "request", "upstream": True}])
        # Both profiles refuse: the fallback's refusal is the call's, with no account details, and nothing more is asked.
        status, frames, client, facts = await self.call([aws_error("ThrottlingException", 429), aws_error("ServiceUnavailableException", 503)])
        self.assertEqual(status, 503)
        self.assertNotIn("arn", json.dumps(frames))
        self.assertEqual([call["modelId"] for call in client.calls], [OPUS, OPUS_US])
        self.assertEqual(facts, [{"event": "fallback", "from": OPUS, "to": OPUS_US, "after": "ThrottlingException"},
                                 {"event": "failed", "model": OPUS_US, "error": "ServiceUnavailableException", "status": 503, "stage": "request", "upstream": True}])
        # A refusal as too large is that refusal asked once; from the other profile, after the first one's refusal, it is
        # two requests, not one made before any work, so it goes out as AWS's validation failure.
        too_long = ClientError({"Error": {"Code": "ValidationException", "Message": "Input is too long for requested model."},
                                "ResponseMetadata": {"HTTPStatusCode": 400}}, "ConverseStream")
        for steps, kind, profiles in (([too_long], "context_length_exceeded", [OPUS]),
                                      ([aws_error("ThrottlingException", 429), too_long], "ValidationException", [OPUS, OPUS_US])):
            with self.subTest(kind):
                client = ScriptedClient(steps)
                transport = BedrockConverseTransport(region="us-east-1", model=OPUS, auth={"aws": True}, client_factory=lambda *args: client,
                                                     fallback_model=OPUS_US, report=lambda fact: None)
                async with httpx2.AsyncClient(transport=transport) as http:
                    response = await http.post(f"{bridge_base_url('us-east-1')}/chat/completions",
                                               json={"model": OPUS, "stream": True, "messages": [{"role": "user", "content": "hi"}]})
                self.assertEqual((response.status_code, response.json()["error"]["type"]), (400, kind))
                self.assertEqual([call["modelId"] for call in client.calls], profiles)
        # The fallback's own stream is relayed as it comes, even an exception that opens it.
        status, frames, client, facts = await self.call([aws_error("ThrottlingException", 429), {"events": [{"throttlingException": {"message": "also"}}]}])
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(frames[-1])["error"]["status"], 429)
        self.assertEqual(facts[-1], {"event": "failed", "model": OPUS_US, "error": "throttlingException", "status": 429, "stage": "stream", "upstream": True})

    async def test_a_failing_reporter_never_fails_a_call_and_settings_are_checked(self):
        def broken(fact):
            raise RuntimeError("log down")
        status, frames, client, facts = await self.call([aws_error("ServiceUnavailableException", 503), {"events": text_turn("OK")}], report=broken)
        self.assertEqual(self.answered(status, frames), "OK")
        for fallback in (OPUS, "us.anthropic claude", "x" * 129, None):
            with self.subTest(fallback=fallback), self.assertRaisesRegex(ValueError, "fallback model"):
                BedrockConverseTransport(region="us-east-1", model=OPUS, auth={"aws": True}, fallback_model=fallback)
        with self.assertRaisesRegex(ValueError, "reporter"):
            BedrockConverseTransport(region="us-east-1", model=OPUS, auth={"aws": True}, report="log")

    async def test_the_bridges_own_refusal_is_not_awss(self):
        status, frames, client, facts = await self.call([{"events": [{"messageStart": {"role": "assistant"}},
                                                                     {"contentBlockDelta": {"delta": {"text": "cut"}}}]}])
        self.assertEqual(status, 200)
        self.assertEqual(facts, [{"event": "failed", "model": OPUS, "error": "api_error", "status": 502, "stage": "stream", "upstream": False}])

    async def test_a_failure_on_the_way_to_aws_is_no_profiles_refusal_and_its_frame_carries_no_status(self):
        # A failure AWS never reported (a connection reset), as the stream opens or partway: the call's own failure on the
        # way to AWS (upstream), with no status for the worker to take for AWS's outage, and the other profile never asked.
        for fail_after in (0, 1):
            with self.subTest(fail_after=fail_after):
                reset = ProtocolError("Connection broken", ConnectionResetError(104, "Connection reset by peer"))
                status, frames, client, facts = await self.call([{"events": text_turn("late"), "fail_after": fail_after, "fail_code": reset}])
                self.assertEqual(status, 200)
                self.assertEqual(json.loads(frames[-1])["error"], {"message": "The Bedrock request failed", "type": "connection_error", "code": "connection_error"})
                self.assertEqual([call["modelId"] for call in client.calls], [OPUS])
                self.assertEqual(facts, [{"event": "failed", "model": OPUS, "error": "connection_error", "status": 502, "stage": "stream", "upstream": True}])
        # A stream exception AWS reports that the service model lacks is AWS's own, and keeps its status.
        status, frames, client, facts = await self.call([{"events": text_turn("late"), "fail_after": 1, "fail_code": "someNewException"}])
        self.assertEqual(json.loads(frames[-1])["error"], {"message": "The Bedrock request failed", "type": "api_error", "code": "api_error", "status": 502})
        # Before any stream it keeps the response's own status, as every failure there does.
        status, frames, client, facts = await self.call([OSError("connection refused")])
        self.assertEqual(status, 502)
        self.assertEqual([call["modelId"] for call in client.calls], [OPUS])
        self.assertEqual(facts, [{"event": "failed", "model": OPUS, "error": "connection_error", "status": 502, "stage": "request", "upstream": True}])

    async def test_a_call_cancelled_while_it_is_sent_reads_nothing_more(self):
        sent, release = threading.Event(), threading.Event()

        class Blocking:
            """A first stream whose first event never comes until it is closed."""
            def __init__(self):
                self.closed = threading.Event()

            def __iter__(self):  # lazy, as botocore's EventStream: the wait is the first next()
                self.closed.wait(10)
                yield from ()

            def close(self):
                self.closed.set()

        stream = Blocking()

        class SlowClient:
            calls = 0

            def converse_stream(self, **kwargs):
                SlowClient.calls += 1
                sent.set()
                release.wait(10)
                return {"stream": stream}

        transport = BedrockConverseTransport(region="us-east-1", model=OPUS, auth={"aws": True}, client_factory=lambda *args: SlowClient(),
                                             fallback_model=OPUS_US, report=lambda fact: None)
        request = httpx2.Request("POST", f"{bridge_base_url('us-east-1')}/chat/completions",
                                 json={"model": OPUS, "stream": True, "messages": [{"role": "user", "content": "hi"}]})
        task = asyncio.create_task(transport.handle_async_request(request))
        await asyncio.get_running_loop().run_in_executor(None, sent.wait, 5)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        started = asyncio.get_running_loop().time()
        release.set()
        closed = await asyncio.get_running_loop().run_in_executor(None, stream.closed.wait, 5)
        self.assertTrue(closed, "the stream of a cancelled call is closed")
        self.assertLess(asyncio.get_running_loop().time() - started, 2, "closed at once, not after its first event")
        self.assertEqual(SlowClient.calls, 1, "a cancelled call never turns to the other profile")

    def test_facts_become_one_closed_log_line_each(self):
        line = bedrock_fact_line("awwo-openai-agents-python-worker", "run_1", {"event": "fallback", "from": OPUS, "to": OPUS_US, "after": "ThrottlingException"})
        self.assertEqual(json.loads(line), {"service": "awwo-openai-agents-python-worker", "runId": "run_1", "event": "bedrock_profile_fallback",
                                            "from": OPUS, "to": OPUS_US, "after": "ThrottlingException"})
        failed = {"event": "failed", "model": OPUS, "error": "ThrottlingException", "status": 429, "stage": "request", "upstream": True, "message": "secret"}
        self.assertEqual(json.loads(bedrock_fact_line("s", None, failed)), {"service": "s", "event": "bedrock_call_failed", "model": OPUS,
                                                                            "error": "ThrottlingException", "status": 429, "stage": "request", "upstream": True})
        self.assertNotIn("runId", json.loads(bedrock_fact_line("s", "run id", failed)))
        for fact in (None, "fallback", [], {"event": "other"}, {"event": "fallback", "from": OPUS, "to": OPUS_US},
                     {"event": "fallback", "from": OPUS, "to": 'us.x "y"', "after": "x"}, {**failed, "status": 99}, {**failed, "status": 600},
                     {**failed, "status": True}, {**failed, "status": 429.5}, {**failed, "stage": "later"}, {**failed, "error": "line\nbreak"},
                     {k: v for k, v in failed.items() if k != "upstream"}, {**failed, "upstream": "yes"}):
            with self.subTest(fact=fact):
                self.assertIsNone(bedrock_fact_line("s", "run_1", fact))


class FallbackRunTests(unittest.IsolatedAsyncioTestCase):
    async def test_a_run_whose_profile_refuses_completes_on_the_other_and_logs_it(self):
        set_trace_processors([])
        client = ScriptedClient([aws_error("ServiceUnavailableException", 503), {"events": text_turn("来自 US 的回答")}])
        import runner
        original = runner.BedrockConverseTransport
        runner.BedrockConverseTransport = lambda **kwargs: original(**kwargs, client_factory=lambda *args: client)
        self.addCleanup(setattr, runner, "BedrockConverseTransport", original)
        config = catalog_config(AWWO_BEDROCK_API_KEY=BEDROCK_KEY)
        request = RunRequest("r1", "t1", "s1", "Say hello", [], model="bedrock.claude-opus-5-5")
        with mock.patch("sys.stderr") as stderr:
            events = [event async for event in stream_run(request, config, asyncio.Event())]
        self.assertEqual(events[-1]["type"], "completed")
        self.assertEqual(events[-1]["text"], "来自 US 的回答")
        self.assertEqual([call["modelId"] for call in client.calls], [OPUS, OPUS_US])
        written = "".join(call.args[0] for call in stderr.write.call_args_list)
        self.assertEqual([json.loads(line) for line in written.splitlines() if line], [{
            "service": "awwo-openai-agents-python-worker", "runId": "r1", "event": "bedrock_profile_fallback",
            "from": OPUS, "to": OPUS_US, "after": "ServiceUnavailableException"}])


STUB_AWS = {"AWS_ACCESS_KEY_ID": "AKIAEXAMPLESTUB00000", "AWS_SECRET_ACCESS_KEY": "stub-secret-stub-secret-0000",
            "AWS_EC2_METADATA_DISABLED": "true", "AWS_CONFIG_FILE": os.devnull, "AWS_SHARED_CREDENTIALS_FILE": os.devnull}


def stalling_endpoint(test, headers):
    """A local endpoint that takes ConverseStream requests and then sends nothing (headers False) or only the response's
    headers (headers True) until the test ends: a Bedrock call that stalled. Returns its URL and the connections it took."""
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen(8)
    taken = []

    def serve():
        while True:
            try:
                conn, _ = listener.accept()
            except OSError:
                return
            taken.append(conn)
            conn.recv(65536)
            if headers:
                conn.sendall(b"HTTP/1.1 200 OK\r\nContent-Type: application/vnd.amazon.eventstream\r\n"
                             b"Transfer-Encoding: chunked\r\nx-amzn-RequestId: stub\r\n\r\n")
    threading.Thread(target=serve, daemon=True).start()

    def stop():
        listener.close()
        for conn in taken:
            conn.close()
    test.addCleanup(stop)
    return f"http://127.0.0.1:{listener.getsockname()[1]}", taken


def local_client(url, seen=None):
    """A real boto3 Bedrock client for the transport's client_factory, sent to `url` with stub credentials."""
    def factory(region, auth, read_timeout):
        import boto3
        from botocore.config import Config
        if seen is not None:
            seen.append(read_timeout)
        return boto3.session.Session().client("bedrock-runtime", region_name=region, endpoint_url=url, config=Config(
            read_timeout=read_timeout, connect_timeout=2, retries={"total_max_attempts": 1, "mode": "standard"}))
    return factory


def event_message(headers, payload=b""):
    """One AWS event-stream message as Bedrock sends it: its prelude (total and header lengths, their CRC), string
    headers, payload and the message's CRC."""
    encoded = b"".join(bytes([len(name)]) + name.encode() + b"\x07" + struct.pack(">H", len(value)) + value.encode()
                       for name, value in headers.items())
    prelude = struct.pack(">II", 12 + len(encoded) + len(payload) + 4, len(encoded))
    prelude += struct.pack(">I", zlib.crc32(prelude))
    message = prelude + encoded + payload
    return message + struct.pack(">I", zlib.crc32(message))


def answering_endpoint(test, body, length=None):
    """A local endpoint that answers each ConverseStream request it reads whole with an event stream of `body`, saying
    it is `length` bytes long (by default its own length: fewer cuts the stream off), and closes."""
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen(8)

    def serve():
        while True:
            try:
                conn, _ = listener.accept()
            except OSError:
                return
            with conn:
                request = b""
                while b"\r\n\r\n" not in request:
                    request += conn.recv(65536)
                head, _, rest = request.partition(b"\r\n\r\n")
                sent = next((int(line.split(b":", 1)[1]) for line in head.split(b"\r\n") if line.lower().startswith(b"content-length:")), 0)
                while len(rest) < sent:
                    rest += conn.recv(65536)
                conn.sendall(b"HTTP/1.1 200 OK\r\nContent-Type: application/vnd.amazon.eventstream\r\nx-amzn-RequestId: stub\r\n"
                             + f"Content-Length: {len(body) if length is None else length}\r\nConnection: close\r\n\r\n".encode() + body)
    threading.Thread(target=serve, daemon=True).start()
    test.addCleanup(listener.close)
    return f"http://127.0.0.1:{listener.getsockname()[1]}"


class RealEventStreamTests(unittest.IsolatedAsyncioTestCase):
    """What botocore itself makes of a Bedrock event stream that fails partway, read by the bridge: real botocore and
    its ConverseStream model against a local endpoint, no AWS."""

    START = event_message({":message-type": "event", ":event-type": "messageStart", ":content-type": "application/json"}, b'{"role":"assistant"}')

    def setUp(self):
        self.enterContext(mock.patch.dict(os.environ, STUB_AWS))
        # The worker's own summary watch, fresh (SummaryWatch).
        self.enterContext(mock.patch("bedrock_bridge.SUMMARY_WATCH", SummaryWatch()))

    async def call(self, body, length=None):
        facts = []
        transport = BedrockConverseTransport(region="us-east-1", model=OPUS, auth={"aws": True}, read_timeout=10.0,
                                             client_factory=local_client(answering_endpoint(self, body, length)), report=facts.append)
        async with httpx2.AsyncClient(transport=transport) as http:
            response = await http.post(f"{bridge_base_url('us-east-1')}/chat/completions",
                                       json={"model": OPUS, "stream": True, "messages": [{"role": "user", "content": "hi"}]})
        self.assertEqual(response.status_code, 200)
        self.assertNotIn("123456789012", response.text)
        return json.loads([line[6:] for line in response.text.split("\n") if line.startswith("data: ")][-1])["error"], facts

    async def test_an_exception_aws_reports_is_awss_whether_or_not_the_service_model_has_it(self):
        def exception(kind):
            return event_message({":message-type": "exception", ":exception-type": kind, ":content-type": "application/json"},
                                 b'{"message":"arn:aws:iam::123456789012:role/x is throttled"}')
        # One the model has keeps its name and status. One it lacks botocore raises with an empty code: still AWS's
        # answer (api_error, 502), never a connection lost on the way.
        for kind, want in (("throttlingException", ("ThrottlingException", 429)), ("someNewException", ("api_error", 502))):
            with self.subTest(kind):
                error, facts = await self.call(self.START + exception(kind))
                self.assertEqual((error["type"], error.get("status")), want)
                self.assertEqual(facts, [{"event": "failed", "model": OPUS, "error": want[0], "status": want[1], "stage": "stream", "upstream": True}])

    async def test_a_stream_cut_off_on_its_way_is_a_connection_failure_without_a_status(self):
        # The endpoint promises more than it sends and closes: urllib3 raises inside botocore's stream, as it does for a
        # connection reset.
        error, facts = await self.call(self.START, length=len(self.START) + 64)
        self.assertEqual(error, {"message": "The Bedrock request failed", "type": "connection_error", "code": "connection_error"})
        self.assertEqual(facts, [{"event": "failed", "model": OPUS, "error": "connection_error", "status": 502, "stage": "stream", "upstream": True}])


class StalledStreamTests(unittest.IsolatedAsyncioTestCase):
    """A Bedrock call that sends nothing for the stream's idle limit fails as a stall (MODEL_STALLED: the service's
    failure, which a canvas node runs again after and the API does not charge before any output) instead of riding out
    its run: real botocore against a local endpoint, no AWS."""

    def setUp(self):
        self.enterContext(mock.patch.dict(os.environ, STUB_AWS))

    def test_the_idle_limit_and_both_read_timeouts_botocore_raises(self):
        self.assertEqual(stream_read_timeout(120.0), 120.0, "a run's shorter deadline stays the read timeout")
        self.assertEqual(stream_read_timeout(1500.0), 900.0)
        # A call to Claude Opus 4.8, which was never seen to think silently (no completed call took 3 minutes in all,
        # 2026-10-21), that offers no tools waits 3 minutes, whichever inference profile serves it; so does one to Opus 5.5
        # that asks for its thinking summarized. One that offers tools (a toolConfig) keeps the idle limit, as does a call
        # to Opus 5.5 without the summary, which may think silently for 11 minutes or more, or to a model not measured.
        tools = {"toolConfig": {"tools": [{"toolSpec": {"name": "t", "inputSchema": {"json": {"type": "object"}}}}]}}
        summarized = {"additionalModelRequestFields": {"thinking": {"type": "adaptive", "display": "summarized"}}}
        for model, extra in [(model, {}) for model in ("global.anthropic.claude-opus-4-8", "us.anthropic.claude-opus-4-8", "anthropic.claude-opus-4-8")] + [
                (model, summarized) for model in (OPUS, OPUS_US, "anthropic.claude-opus-5-5")]:
            self.assertEqual(call_read_timeout(900.0, {"messages": [], **extra}, model), 180.0, model)
            self.assertEqual(call_read_timeout(900.0, {**tools, **extra}, model), 900.0, model)
            self.assertEqual(call_read_timeout(120.0, {"messages": [], **extra}, model), 120.0, "a run's shorter deadline still comes first")
        for model in (OPUS, OPUS_US, "global.anthropic.claude-sonnet-5", "moonshotai.kimi-k2.5", "global.anthropic.claude-opus-4-8-v2",
                      "global.anthropic.claude-opus-5-5-v2"):
            self.assertEqual(call_read_timeout(900.0, {"messages": []}, model), 900.0, model)
        for fields in ({"thinking": {"type": "adaptive"}}, {"thinking": {"type": "adaptive", "display": "omitted"}}, {}):
            self.assertEqual(call_read_timeout(900.0, {"messages": [], "additionalModelRequestFields": fields}, OPUS), 900.0, fields)
        self.assertEqual(call_read_timeout(900.0, {"messages": [], **summarized}, "global.anthropic.claude-sonnet-5"), 900.0)
        from botocore.exceptions import ReadTimeoutError as BotocoreReadTimeout
        from urllib3.exceptions import ReadTimeoutError as Urllib3ReadTimeout
        # botocore raises its own while it waits for the response, urllib3's inside a stream that already answered.
        for error in (BotocoreReadTimeout(endpoint_url="https://bedrock-runtime.us-east-1.amazonaws.com"), Urllib3ReadTimeout(None, None, "Read timed out.")):
            with self.subTest(type(error).__module__):
                failure = bridge_failure(error)
                self.assertEqual((failure.status, failure.kind, failure.upstream), (504, "ReadTimeoutError", True))
                self.assertEqual(classify_error(failure, bedrock=True)["code"], "MODEL_STALLED")
                self.assertEqual(classify_error(failure)["code"], "MODEL_UNAVAILABLE", "only a call the bridge served stalls")

    def test_only_the_bridges_read_timeout_is_a_stall(self):
        # For a call the bridge served, the SDK's error for its answer, before its stream (the 504 and its body) and
        # inside one (the error frame, its status in its body), reads as a stall; so does the bridge's own failure.
        from openai import APIError, BadRequestError, InternalServerError
        request = httpx2.Request("POST", f"{bridge_base_url('us-east-1')}/chat/completions")
        body = {"message": "Bedrock sent nothing for too long", "type": "ReadTimeoutError", "code": "ReadTimeoutError", "status": 504}
        before = InternalServerError("Error code: 504", response=httpx2.Response(504, request=request, json={"error": body}), body=body)
        stalls = (before, APIError("Bedrock sent nothing for too long", request, body=body), APIError("stalled", request, body={"error": body}),
                  BridgeError(504, "ReadTimeoutError", "Bedrock sent nothing for too long", upstream=True))
        for error in stalls:
            with self.subTest(type(error).__name__):
                self.assertEqual(classify_error(error, bedrock=True)["code"], "MODEL_STALLED")
                # The same answer from a call no bridge served (another provider's) is never a stall.
                self.assertNotEqual(classify_error(error)["code"], "MODEL_STALLED")
        # Any other 504, an HTTP status other than 504 under the bridge's body, a body that only names the type or
        # carries another status, and the bridge's other failures stay what they were, the bridge's own calls too.
        for error, code in ((InternalServerError("Error code: 504", response=httpx2.Response(504, request=request, json={"error": {"message": "Gateway Timeout"}}),
                                                 body={"message": "Gateway Timeout"}), "MODEL_UNAVAILABLE"),
                            (BadRequestError("Error code: 400", response=httpx2.Response(400, request=request, json={"error": body}), body=body),
                             "MODEL_REQUEST_REJECTED"),
                            (APIError("stalled", request, body={**body, "status": 502}), "MODEL_UNAVAILABLE"),
                            (APIError("stalled", request, body={"type": "ReadTimeoutError", "status": 504}), "MODEL_UNAVAILABLE"),
                            (APIError("stalled", request, body={**body, "code": "api_error"}), "MODEL_UNAVAILABLE"),
                            (BridgeError(502, "ReadTimeoutError", "Bedrock sent nothing for too long", upstream=True), "MODEL_UNAVAILABLE"),
                            (BridgeError(504, "api_error", "The Bedrock request failed", upstream=True), "MODEL_UNAVAILABLE"),
                            (BridgeError(400, "invalid_request_error", "Invalid request"), "MODEL_REQUEST_REJECTED")):
            with self.subTest(error=str(getattr(error, "body", None) or error)):
                self.assertEqual(classify_error(error, bedrock=True)["code"], code)

    async def test_a_stalled_call_fails_at_the_idle_limit_and_never_turns_to_the_other_profile(self):
        # With a fallback the first event is read ahead; without one the stream is read in the worker's own loop.
        for (headers, stage), fallback in [(case, fallback) for case in ((False, "request"), (True, "stream")) for fallback in (OPUS_US, "")]:
            with self.subTest(stage=stage, fallback=fallback):
                url, taken = stalling_endpoint(self, headers)
                facts = []
                transport = BedrockConverseTransport(region="us-east-1", model=OPUS, auth={"aws": True}, read_timeout=1.0,
                                                     client_factory=local_client(url), fallback_model=fallback, report=facts.append,
                                                     summary_watch=SummaryWatch())
                body = {"model": OPUS, "stream": True, "messages": [{"role": "user", "content": "hi"}]}
                started = time.monotonic()
                async with httpx2.AsyncClient(transport=transport) as http:
                    response = await http.post(f"{bridge_base_url('us-east-1')}/chat/completions", json=body)
                self.assertLess(time.monotonic() - started, 8)
                error = (response.json() if stage == "request" else
                         json.loads([line for line in response.text.split("\n") if line.startswith("data: ")][-1][6:]))["error"]
                self.assertEqual((response.status_code, error["type"], error["status"]), (504 if stage == "request" else 200, "ReadTimeoutError", 504))
                # Answered and then silent, a call that asked for the summary marks it missing (SummaryWatch); one never
                # answered says nothing about it.
                self.assertEqual(facts, [{"event": "failed", "model": OPUS, "error": "ReadTimeoutError", "status": 504, "stage": stage, "upstream": True}]
                                 + ([OPUS_SUMMARY_SILENT] if stage == "stream" else []))
                self.assertEqual(len(taken), 1, "a stall is not a profile's refusal: the other profile is never asked")

    async def test_a_stalled_call_that_offers_no_tools_fails_at_its_models_quick_limit_and_any_other_waits_the_idle_limit(self):
        # 2026-10-20: two canvas node calls to Claude Opus 4.8 (they offer no tools) waited the whole 15 minutes for nothing;
        # so did 14 to Opus 5.5 from 10-19 to 10-21, which now stream their thinking. A call that offers tools may be silent
        # while it writes a tool call's input, so it keeps the idle limit (here the transport's 3 s), as does a call to a
        # model not measured. tool_choice "none" offers Bedrock no tools at all.
        tool = [{"type": "function", "function": {"name": "current_time", "parameters": {"type": "object", "properties": {}}}}]
        opus48 = "global.anthropic.claude-opus-4-8"
        cases = (("opus 4.8", opus48, {}, 1), ("opus 4.8, tools", opus48, {"tools": tool}, 3.0),
                 ("opus 4.8, tool_choice none", opus48, {"tools": tool, "tool_choice": "none"}, 1), ("opus 5.5", OPUS, {}, 1),
                 ("opus 5.5, tools", OPUS, {"tools": tool}, 3.0), ("kimi", "moonshotai.kimi-k2.5", {}, 3.0))
        for headers, stage in ((False, "request"), (True, "stream")):
            for name, model, extra, want in cases:
                with self.subTest(stage=stage, call=name):
                    url, _ = stalling_endpoint(self, headers)
                    seen, facts = [], []
                    transport = BedrockConverseTransport(region="us-east-1", model=model, auth={"aws": True}, read_timeout=3.0,
                                                         client_factory=local_client(url, seen), report=facts.append, summary_watch=SummaryWatch())
                    body = {"model": model, "stream": True, "messages": [{"role": "user", "content": "hi"}], **extra}
                    started = time.monotonic()
                    with mock.patch.dict("bedrock_bridge.QUICK_FIRST_BYTE_SECONDS", {"anthropic.claude-opus-4-8": 1, "anthropic.claude-opus-5-5": 1}):
                        async with httpx2.AsyncClient(transport=transport) as http:
                            response = await http.post(f"{bridge_base_url('us-east-1')}/chat/completions", json=body)
                    waited = time.monotonic() - started
                    self.assertEqual(seen, [want], "botocore's read timeout for this call")
                    self.assertGreaterEqual(waited, want * 0.9)
                    self.assertLess(waited, want + 6)
                    error = (response.json() if stage == "request" else
                             json.loads([line for line in response.text.split("\n") if line.startswith("data: ")][-1][6:]))["error"]
                    self.assertEqual((error["type"], error["status"]), ("ReadTimeoutError", 504))
                    self.assertEqual(facts, [{"event": "failed", "model": model, "error": "ReadTimeoutError", "status": 504, "stage": stage, "upstream": True}]
                                     + ([OPUS_SUMMARY_SILENT] if stage == "stream" and model == OPUS else []))

    async def test_a_run_whose_call_stalls_ends_as_a_stall_long_before_its_deadline(self):
        set_trace_processors([])
        import runner
        original = runner.BedrockConverseTransport
        self.addCleanup(setattr, runner, "BedrockConverseTransport", original)
        config = catalog_config(AWWO_BEDROCK_API_KEY=BEDROCK_KEY, AWWO_OPENAI_AGENTS_TIMEOUT_MS="30000")
        # The JSON 504 answered before a stream, and the error frame inside one, both read as the service's outage. A run
        # offers no tools: an Opus 5.5 or Opus 4.8 call ends at its quick limit, a call to another model at the stream's
        # idle limit.
        runs = (("bedrock.claude-opus-5-5", OPUS, lambda: mock.patch.dict("bedrock_bridge.QUICK_FIRST_BYTE_SECONDS", {"anthropic.claude-opus-5-5": 1})),
                ("bedrock.claude-opus-4-8", "global.anthropic.claude-opus-4-8",
                 lambda: mock.patch.dict("bedrock_bridge.QUICK_FIRST_BYTE_SECONDS", {"anthropic.claude-opus-4-8": 1})),
                ("bedrock.kimi-k2-5", "moonshotai.kimi-k2.5", lambda: mock.patch("bedrock_bridge.BEDROCK_STREAM_IDLE_SECONDS", 1)))
        for (headers, stage), (model, target, limit) in [(case, run) for case in ((False, "request"), (True, "stream")) for run in runs]:
            with self.subTest(stage=stage, model=model):
                request = RunRequest("r1", "t1", "s1", "Say hello", [], model=model)
                url, _ = stalling_endpoint(self, headers)
                seen = []
                runner.BedrockConverseTransport = lambda **kwargs: original(**kwargs, client_factory=local_client(url, seen), summary_watch=SummaryWatch())
                started = time.monotonic()
                with limit(), mock.patch("sys.stderr") as stderr:
                    events = [event async for event in stream_run(request, config, asyncio.Event())]
                self.assertLess(time.monotonic() - started, 15, "the idle limit, not the run's 30 s deadline")
                self.assertEqual(seen, [1])
                self.assertEqual((events[-1]["type"], events[-1]["code"]), ("failed", "MODEL_STALLED"), events[-1])
                self.assertFalse([event for event in events if event["type"] == "text_delta"], "nothing was returned")
                written = "".join(call.args[0] for call in stderr.write.call_args_list)
                watched = ([{"service": "awwo-openai-agents-python-worker", "runId": "r1", "event": "bedrock_summary_watch",
                             "model": "anthropic.claude-opus-5-5", "effort": "default", "state": "silent"}]
                           if stage == "stream" and target == OPUS else [])
                self.assertEqual([json.loads(line) for line in written.splitlines() if line.startswith('{"service"')], [{
                    "service": "awwo-openai-agents-python-worker", "runId": "r1", "event": "bedrock_call_failed", "model": target,
                    "error": "ReadTimeoutError", "status": 504, "stage": stage, "upstream": True}] + watched)


SUMMARY_DELTA = {"contentBlockDelta": {"contentBlockIndex": 0, "delta": {"reasoningContent": {"text": "Weighing the layout"}}}}


def summary_turn(text="OK"):
    """A turn that streams its thinking summarized before its answer."""
    return text_turn(text, prefix=[SUMMARY_DELTA, {"contentBlockStop": {"contentBlockIndex": 0}}])


class SummaryWatchTests(unittest.IsolatedAsyncioTestCase):
    """2026-10-26: Bedrock stopped streaming Claude Opus 5.5's thinking summary, at every effort, though its calls asked for
    it, and every call that thought longer than its 3-minute quick limit was cut with nothing. While a call that asked for
    the summary has been answered and then got none before its read timeout, the next such call waits the stream's idle
    limit instead (the owner's 「Bedrock 不发思考摘要时，Opus 5.5 的调用恢复 15 分钟空闲上限」), until a call gets a summary."""

    def test_the_watch_is_by_model_and_effort(self):
        watch = SummaryWatch()
        self.assertTrue(watch.streams(OPUS, ""))
        self.assertTrue(watch.missed_summary(OPUS, ""), "begins a silent spell")
        self.assertFalse(watch.missed_summary(OPUS_US, ""), "the same model through its other profile: already silent")
        self.assertFalse(watch.streams("anthropic.claude-opus-5-5", ""))
        self.assertTrue(watch.streams(OPUS, "low"), "each effort has its own")
        self.assertTrue(watch.saw_summary(OPUS_US, ""), "a summary ends the spell")
        self.assertFalse(watch.saw_summary(OPUS, ""), "and only once")
        self.assertTrue(watch.streams(OPUS, ""))

    def test_a_silent_spell_gives_a_summarized_call_the_idle_limit(self):
        summarized = {"additionalModelRequestFields": {"thinking": dict(SUMMARIZED_THINKING)}}
        low = {"additionalModelRequestFields": {"thinking": dict(SUMMARIZED_THINKING), "output_config": {"effort": "low"}}}
        tools = {"toolConfig": {"tools": [{"toolSpec": {"name": "t", "inputSchema": {"json": {"type": "object"}}}}]}}
        watch = SummaryWatch()
        self.assertEqual(call_read_timeout(900.0, {"messages": [], **summarized}, OPUS, watch), 180.0)
        watch.missed_summary(OPUS, "")
        self.assertEqual(call_read_timeout(900.0, {"messages": [], **summarized}, OPUS, watch), 900.0)
        self.assertEqual(call_read_timeout(900.0, {"messages": [], **summarized}, OPUS_US, watch), 900.0)
        self.assertEqual(call_read_timeout(120.0, {"messages": [], **summarized}, OPUS, watch), 120.0, "a run's shorter deadline still comes first")
        self.assertEqual(call_read_timeout(900.0, {"messages": [], **low}, OPUS, watch), 180.0, "low effort has its own spell")
        self.assertEqual(call_read_timeout(900.0, {**tools, **summarized}, OPUS, watch), 900.0)
        self.assertEqual(call_read_timeout(900.0, {"messages": [], **summarized}, OPUS), 180.0, "no watch: as before")
        # Claude Opus 4.8 never thinks silently and is asked for no summary: its quick limit stays whatever the watch says.
        watch.missed_summary("global.anthropic.claude-opus-4-8", "")
        self.assertEqual(call_read_timeout(900.0, {"messages": []}, "global.anthropic.claude-opus-4-8", watch), 180.0)

    async def test_a_call_answered_without_a_summary_begins_a_spell_and_a_summary_ends_it(self):
        from botocore.exceptions import ReadTimeoutError as BotocoreReadTimeout
        from urllib3.exceptions import ReadTimeoutError as Urllib3ReadTimeout

        def silent():  # answered, then nothing until the read timeout (urllib3's, inside the stream)
            return FakeClient({}, text_turn("x"), fail_after=0, fail_code=Urllib3ReadTimeout(None, None, "Read timed out."))

        def unanswered():  # never answered (botocore's, while it waits for the response): says nothing about the summary
            return FakeClient({}, [], fail=BotocoreReadTimeout(endpoint_url="https://bedrock-runtime.us-east-1.amazonaws.com"))

        def thinking_then_silent():  # its summary began, then a long gap: the summary streams
            return FakeClient({}, summary_turn("x"), fail_after=2, fail_code=Urllib3ReadTimeout(None, None, "Read timed out."))

        for fallback in ("", OPUS_US):
            with self.subTest(fallback=fallback):
                watch, timeouts, facts = SummaryWatch(), [], []
                clients = [unanswered(), silent(), silent(), FakeClient({}, summary_turn()), FakeClient({}, text_turn("OK")),
                           thinking_then_silent(), FakeClient({}, text_turn("OK"))]

                def factory(region, auth, read_timeout):
                    timeouts.append(read_timeout)
                    return clients.pop(0)
                transport = BedrockConverseTransport(region="us-east-1", model=OPUS, auth={"aws": True}, read_timeout=900.0, client_factory=factory,
                                                     fallback_model=fallback, report=facts.append, summary_watch=watch)
                outcomes = []
                async with httpx2.AsyncClient(transport=transport) as http:
                    for _ in range(7):
                        response = await http.post(bridge_base_url("us-east-1") + "/chat/completions", json=chat_body(model=OPUS))
                        frames = [line[6:] for line in response.text.split("\n") if line.startswith("data: ")]
                        error = response.json()["error"]["type"] if response.status_code != 200 else (
                            json.loads(frames[-1]).get("error", {}).get("type") if frames and frames[-1] != "[DONE]" else None)
                        outcomes.append((response.status_code, error))
                self.assertEqual(outcomes, [(504, "ReadTimeoutError"), (200, "ReadTimeoutError"), (200, "ReadTimeoutError"), (200, None),
                                            (200, None), (200, "ReadTimeoutError"), (200, None)])
                # The never-answered call and the first silent one wait the quick limit; the silent one begins the spell, so
                # the next silent one and the one whose summary ends it wait the idle limit; then the quick limit again, and a
                # call whose summary began before its gap does not begin another spell.
                self.assertEqual(timeouts, [180.0, 180.0, 900.0, 900.0, 180.0, 180.0, 180.0])
                watched = [fact for fact in facts if fact["event"] == "summary_watch"]
                self.assertEqual(watched, [OPUS_SUMMARY_SILENT, {**OPUS_SUMMARY_SILENT, "state": "streams"}])
                self.assertEqual([fact["stage"] for fact in facts if fact["event"] == "failed"], ["request", "stream", "stream", "stream"])
                self.assertTrue(watch.streams(OPUS, ""))

    async def test_each_effort_keeps_its_own_spell_and_tools_learn_but_keep_the_idle_limit(self):
        from urllib3.exceptions import ReadTimeoutError as Urllib3ReadTimeout
        watch, timeouts, facts = SummaryWatch(), [], []
        silent = lambda: FakeClient({}, text_turn("x"), fail_after=0, fail_code=Urllib3ReadTimeout(None, None, "Read timed out."))  # noqa: E731
        clients = [silent(), FakeClient({}, text_turn("OK")), silent(), FakeClient({}, summary_turn())]

        def factory(region, auth, read_timeout):
            timeouts.append(read_timeout)
            return clients.pop(0)
        transport = BedrockConverseTransport(region="us-east-1", model=OPUS, auth={"aws": True}, read_timeout=900.0, client_factory=factory,
                                             reasoning_efforts=("low", "medium", "high"), report=facts.append, summary_watch=watch)
        async with httpx2.AsyncClient(transport=transport) as http:
            for body in (chat_body(model=OPUS, reasoning_effort="low"), chat_body(model=OPUS), chat_body(model=OPUS, tools=TIME_TOOL),
                         chat_body(model=OPUS, reasoning_effort="low")):
                await http.post(bridge_base_url("us-east-1") + "/chat/completions", json=body)
        # A low call without a summary begins low's spell only; a call at the model's own effort keeps its quick limit; one
        # that offers tools waits the idle limit as always, and without a summary begins the default effort's spell too;
        # a low call's summary ends low's.
        self.assertEqual(timeouts, [180.0, 180.0, 900.0, 900.0])
        self.assertEqual([fact for fact in facts if fact["event"] == "summary_watch"], [
            {**OPUS_SUMMARY_SILENT, "effort": "low"}, OPUS_SUMMARY_SILENT, {**OPUS_SUMMARY_SILENT, "effort": "low", "state": "streams"}])
        self.assertFalse(watch.streams(OPUS, ""))
        self.assertTrue(watch.streams(OPUS, "low"))

    async def test_only_a_model_asked_for_the_summary_is_watched(self):
        from urllib3.exceptions import ReadTimeoutError as Urllib3ReadTimeout
        for model in ("global.anthropic.claude-opus-4-8", "moonshotai.kimi-k2.5"):
            with self.subTest(model=model):
                watch, facts = SummaryWatch(), []
                transport = BedrockConverseTransport(region="us-east-1", model=model, auth={"aws": True}, read_timeout=900.0, report=facts.append,
                                                     client_factory=lambda *args: FakeClient({}, text_turn("x"), fail_after=0,
                                                                                             fail_code=Urllib3ReadTimeout(None, None, "Read timed out.")),
                                                     summary_watch=watch)
                async with httpx2.AsyncClient(transport=transport) as http:
                    await http.post(bridge_base_url("us-east-1") + "/chat/completions", json=chat_body(model=model))
                self.assertEqual([fact["event"] for fact in facts], ["failed"])
                self.assertTrue(watch.streams(model, ""))
        with mock.patch("bedrock_bridge.SUMMARIZED_THINKING_MODELS", frozenset()):
            watch, facts = SummaryWatch(), []
            transport = BedrockConverseTransport(region="us-east-1", model=OPUS, auth={"aws": True}, read_timeout=900.0, report=facts.append,
                                                 client_factory=lambda *args: FakeClient({}, text_turn("x"), fail_after=0,
                                                                                         fail_code=Urllib3ReadTimeout(None, None, "Read timed out.")),
                                                 summary_watch=watch)
            async with httpx2.AsyncClient(transport=transport) as http:
                await http.post(bridge_base_url("us-east-1") + "/chat/completions", json=chat_body(model=OPUS))
            self.assertEqual([fact["event"] for fact in facts], ["failed"], "not asked for the summary: nothing to learn")
            self.assertTrue(watch.streams(OPUS, ""))

    def test_every_piece_of_summary_counts_and_only_a_read_timeout_without_one_begins_a_spell(self):
        # Codex review, 2026-10-27: a call whose summary is streaming ends a spell a concurrent call began, with its next
        # piece of summary, not only with its first.
        from bedrock_bridge import _SummaryCall
        stalled = BridgeError(504, "ReadTimeoutError", "Bedrock sent nothing for too long", upstream=True)
        watch, told = SummaryWatch(), []
        a, b = _SummaryCall(watch, OPUS, "", told.append), _SummaryCall(watch, OPUS_US, "", told.append)
        a.event(SUMMARY_DELTA)
        b.failure(stalled)
        self.assertFalse(watch.streams(OPUS, ""))
        a.event({"messageStart": {"role": "assistant"}})
        self.assertFalse(watch.streams(OPUS, ""), "an event without summary text says nothing")
        a.event(SUMMARY_DELTA)
        self.assertTrue(watch.streams(OPUS, ""))
        self.assertEqual([fact["state"] for fact in told], ["silent", "streams"])
        # Any other failure, and a read timeout after a summary, begin no spell.
        for failure in (BridgeError(500, "InternalServerException", "The Bedrock stream reported an error", upstream=True),
                        BridgeError(502, "connection_error", "The connection to Bedrock failed", upstream=True)):
            _SummaryCall(watch, OPUS, "", told.append).failure(failure)
        late = _SummaryCall(watch, OPUS, "", told.append)
        late.event(SUMMARY_DELTA)
        late.failure(stalled)
        empty = _SummaryCall(watch, OPUS, "", told.append)
        empty.event({"contentBlockDelta": {"contentBlockIndex": 0, "delta": {"reasoningContent": {"signature": "c2ln"}}}})
        self.assertFalse(empty.seen, "a signature is no summary text")
        self.assertTrue(watch.streams(OPUS, ""))
        self.assertEqual(len(told), 2)

    def test_only_a_summary_in_time_ends_a_spell_and_only_a_call_with_neither_summary_nor_answer_begins_one(self):
        # Claude review, 2026-10-27: a summary held back to the end of the thinking (here 240 s, past Opus 5.5's quick 180)
        # must not end a spell, or the quick limit would cut the next call again; a stall after the answer began, and a
        # call that only ever sent a signature and completed, say nothing about the summary being streamed.
        from bedrock_bridge import _SummaryCall
        stalled = BridgeError(504, "ReadTimeoutError", "Bedrock sent nothing for too long", upstream=True)
        signature = {"contentBlockDelta": {"contentBlockIndex": 0, "delta": {"reasoningContent": {"signature": "c2ln"}}}}
        answer = {"contentBlockDelta": {"contentBlockIndex": 1, "delta": {"text": "<!doctype html>"}}}
        times = iter([0.0, 240.0, 240.5, 1000.0, 1004.0])
        watch, told = SummaryWatch(), []
        watch.missed_summary(OPUS, "")
        late = _SummaryCall(watch, OPUS, "", told.append, clock=lambda: next(times))
        late.event(SUMMARY_DELTA)
        late.event(SUMMARY_DELTA)
        self.assertTrue(late.late)
        self.assertFalse(watch.streams(OPUS, ""), "a summary 240 s into the call ends no spell, nor do its later pieces")
        in_time = _SummaryCall(watch, OPUS, "", told.append, clock=lambda: next(times))
        in_time.event(SUMMARY_DELTA)
        self.assertTrue(watch.streams(OPUS, ""), "a summary 4 s into the call ends it")
        answered = _SummaryCall(watch, OPUS, "", told.append)
        answered.event(answer)
        answered.failure(stalled)
        self.assertTrue(watch.streams(OPUS, ""), "a stall once the answer began begins no spell")
        tool = _SummaryCall(watch, OPUS, "", told.append)
        tool.event({"contentBlockDelta": {"contentBlockIndex": 1, "delta": {"toolUse": {"input": "{}"}}}})
        tool.failure(stalled)
        self.assertTrue(watch.streams(OPUS, ""), "nor once a tool call's input began")
        started = _SummaryCall(watch, OPUS, "", told.append)
        started.event({"contentBlockStart": {"contentBlockIndex": 1, "start": {"toolUse": {"toolUseId": "tooluse_1", "name": "current_time"}}}})
        started.failure(stalled)
        self.assertTrue(watch.streams(OPUS, ""), "nor once a tool call began, before its input (Codex review, round 2)")
        silent = _SummaryCall(watch, OPUS, "", told.append)
        silent.event({"messageStart": {"role": "assistant"}})
        silent.event(signature)
        silent.failure(stalled)
        self.assertFalse(watch.streams(OPUS, ""), "only a signature, then nothing: no summary")
        _SummaryCall(watch, OPUS, "", told.append).event(signature)
        self.assertFalse(watch.streams(OPUS, ""), "a call that sent only a signature leaves the spell on")
        # Sent again to the other profile after the first refused it 179 s in: its summary 5 s later is in time.
        times = iter([0.0, 179.0, 184.0])
        again = _SummaryCall(watch, OPUS, "", told.append, clock=lambda: next(times))
        again.restart()
        again.event(SUMMARY_DELTA)
        self.assertFalse(again.late)
        self.assertTrue(watch.streams(OPUS, ""), "the other profile's summary in time ends the spell (Codex review, round 2)")
        self.assertEqual([fact["state"] for fact in told], ["streams", "silent", "streams"])

    async def test_a_call_the_other_profile_answers_without_a_summary_begins_a_spell(self):
        from urllib3.exceptions import ReadTimeoutError as Urllib3ReadTimeout

        class FallingBack:
            """Refuses the first profile for capacity, then answers on the other with `stream`."""
            def __init__(self, stream):
                self.calls, self.stream = 0, stream

            def converse_stream(self, **kwargs):
                self.calls += 1
                if self.calls == 1:
                    raise ClientError({"Error": {"Code": "ThrottlingException", "Message": "busy"}, "ResponseMetadata": {"HTTPStatusCode": 429}},
                                      "ConverseStream")
                return {"stream": self.stream}
        watch, timeouts, facts = SummaryWatch(), [], []
        clients = [FallingBack(FakeStream(text_turn("x"), 0, Urllib3ReadTimeout(None, None, "Read timed out."))), FallingBack(FakeStream(summary_turn()))]

        def factory(region, auth, read_timeout):
            timeouts.append(read_timeout)
            return clients.pop(0)
        transport = BedrockConverseTransport(region="us-east-1", model=OPUS, auth={"aws": True}, read_timeout=900.0, client_factory=factory,
                                             fallback_model=OPUS_US, report=facts.append, summary_watch=watch)
        from bedrock_bridge import _SummaryCall
        with mock.patch.object(_SummaryCall, "restart", autospec=True, side_effect=_SummaryCall.restart) as restarted:
            async with httpx2.AsyncClient(transport=transport) as http:
                for _ in range(2):
                    await http.post(bridge_base_url("us-east-1") + "/chat/completions", json=chat_body(model=OPUS))
        self.assertEqual(restarted.call_count, 2, "each call's clock restarts when it is sent to the other profile")
        self.assertEqual(timeouts, [180.0, 900.0])
        fallback = {"event": "fallback", "from": OPUS, "to": OPUS_US, "after": "ThrottlingException"}
        self.assertEqual(facts, [fallback, {"event": "failed", "model": OPUS_US, "error": "ReadTimeoutError", "status": 504, "stage": "stream", "upstream": True},
                                 OPUS_SUMMARY_SILENT, fallback, {**OPUS_SUMMARY_SILENT, "state": "streams"}])
        self.assertTrue(watch.streams(OPUS, ""))

    def test_the_watch_is_the_workers_own_unless_one_is_given(self):
        import bedrock_bridge
        self.assertIs(BedrockConverseTransport(region="us-east-1", model=OPUS, auth={"aws": True}).summary_watch, bedrock_bridge.SUMMARY_WATCH)
        with self.assertRaisesRegex(ValueError, "summary watch"):
            BedrockConverseTransport(region="us-east-1", model=OPUS, auth={"aws": True}, summary_watch=object())

    def test_its_facts_are_closed_labels(self):
        line = bedrock_fact_line("s", "run_1", {"event": "summary_watch", "model": "anthropic.claude-opus-5-5", "effort": "low", "state": "silent"})
        self.assertEqual(json.loads(line), {"service": "s", "runId": "run_1", "event": "bedrock_summary_watch", "model": "anthropic.claude-opus-5-5",
                                            "effort": "low", "state": "silent"})
        for fact in ({"event": "summary_watch", "model": "anthropic.claude-opus-5-5", "effort": "low", "state": "unknown"},
                     {"event": "summary_watch", "model": "anthropic claude", "effort": "low", "state": "silent"},
                     {"event": "summary_watch", "model": "anthropic.claude-opus-5-5", "effort": "", "state": "streams"},
                     {"event": "summary_watch", "model": "anthropic.claude-opus-5-5", "state": "streams"}):
            with self.subTest(fact=fact):
                self.assertIsNone(bedrock_fact_line("s", "run_1", fact))


CACHE_POINT = {"cachePoint": {"type": "default"}}
TIME_TOOL = [{"type": "function", "function": {"name": "current_time", "parameters": {"type": "object", "properties": {}}}}]
TOOL_LOOP = [{"role": "system", "content": "Use tools."}, {"role": "user", "content": "Time?"},
             {"role": "assistant", "content": "", "tool_calls": [{"id": "tooluse_1", "type": "function", "function": {"name": "current_time", "arguments": "{}"}}]},
             {"role": "tool", "tool_call_id": "tooluse_1", "content": "noon"}]
CLAUDE = "global.anthropic.claude-opus-5-5"


def chat_body(**overrides):
    return {"model": CLAUDE, "stream": True, "max_tokens": 512, "messages": [{"role": "user", "content": "Hello"}], **overrides}


class PromptCacheTests(unittest.IsolatedAsyncioTestCase):
    """with_claude_prompt_cache matches withClaudePromptCache in apps/bedrock-bridge.ts, except on purpose for a single
    message that offers tools: the Node bridge marks it (it opens their tool loops), this worker leaves it unchanged (its
    runs make one call)."""

    def test_a_re_sent_prefix_gets_three_checkpoints_and_a_single_message_none(self):
        loop = to_converse_input(chat_body(tools=TIME_TOOL, messages=TOOL_LOOP), CLAUDE)
        snapshot = json.dumps(loop, sort_keys=True)
        cached = with_claude_prompt_cache(loop)
        self.assertEqual(cached["toolConfig"]["tools"], [*loop["toolConfig"]["tools"], CACHE_POINT])
        self.assertEqual(cached["system"], [{"text": "Use tools."}, CACHE_POINT])
        self.assertEqual(cached["messages"][:-1], loop["messages"][:-1])
        self.assertEqual(cached["messages"][-1]["content"], [*loop["messages"][-1]["content"], CACHE_POINT])
        self.assertEqual(json.dumps(cached).count('"cachePoint"'), 3)
        self.assertEqual(json.dumps(loop, sort_keys=True), snapshot, "the input command is not mutated")
        chat = to_converse_input(chat_body(messages=[{"role": "user", "content": "Hi"}, {"role": "assistant", "content": "Hello"}, {"role": "user", "content": "More"}]), CLAUDE)
        chat_cached = with_claude_prompt_cache(chat)
        self.assertNotIn("system", chat_cached)
        self.assertNotIn("toolConfig", chat_cached)
        self.assertEqual(chat_cached["messages"][-1]["content"], [{"text": "More"}, CACHE_POINT])
        # A single message stays as it was, even one that offers tools: this worker's runs make one call.
        single = to_converse_input(chat_body(tools=TIME_TOOL), CLAUDE)
        self.assertIs(with_claude_prompt_cache(single), single)

    def test_the_setting_marks_only_named_claude_catalog_models(self):
        self.assertFalse(any(p.prompt_cache for p in catalog_config().models))
        self.assertFalse(any(p.prompt_cache for p in catalog_config(AWWO_BEDROCK_PROMPT_CACHE_MODELS="").models))
        config = catalog_config(AWWO_BEDROCK_PROMPT_CACHE_MODELS="bedrock.claude-opus-5-5")
        self.assertEqual([p.id for p in config.models if p.prompt_cache], ["bedrock.claude-opus-5-5"])
        self.assertEqual(public_health(config), public_health(catalog_config()))
        for value in ("bedrock.glm-5", "bedrock.claude-opus-5-5,", "opus", "bedrock.claude-opus-5-5,bedrock.claude-opus-5-5", "bedrock.unknown"):
            with self.subTest(value=value), self.assertRaises(ConfigError):
                catalog_config(AWWO_BEDROCK_PROMPT_CACHE_MODELS=value)
        with self.assertRaises(ConfigError):
            load_config({**GATE, "AWWO_BEDROCK_PROMPT_CACHE_MODELS": "bedrock.claude-opus-5-5"})

    async def test_the_transport_sends_checkpoints_only_when_turned_on(self):
        usage = {"inputTokens": 3, "outputTokens": 2, "cacheReadInputTokens": 2000, "cacheWriteInputTokens": 40}
        events = [{"messageStart": {"role": "assistant"}}, {"contentBlockDelta": {"contentBlockIndex": 0, "delta": {"text": "OK"}}},
                  {"messageStop": {"stopReason": "end_turn"}}, {"metadata": {"usage": usage}}]
        with self.assertRaises(ValueError):
            BedrockConverseTransport(region="us-east-1", model=CLAUDE, auth={"aws": True}, prompt_cache="yes")
        body = chat_body(tools=TIME_TOOL, messages=TOOL_LOOP)
        for enabled in (True, False, None):
            record: dict = {}
            options = {} if enabled is None else {"prompt_cache": enabled}
            transport = BedrockConverseTransport(region="us-east-1", model=CLAUDE, auth={"aws": True},
                                                 client_factory=lambda *args: FakeClient(record, events), **options)
            async with httpx2.AsyncClient(transport=transport) as client:
                async with client.stream("POST", bridge_base_url("us-east-1") + "/chat/completions", json=body) as response:
                    frames = [line async for line in response.aiter_lines() if line]
            sent = json.dumps(record["input"])
            if enabled:
                self.assertEqual(sent.count('"cachePoint"'), 3)
                usage_frame = json.loads(frames[-2][len("data: "):])
                self.assertEqual(usage_frame["usage"], {"prompt_tokens": 2043, "completion_tokens": 2,
                                                        "prompt_tokens_details": {"cached_tokens": 2000, "cache_write_tokens": 40}})
            else:
                self.assertEqual(record["input"], with_summarized_thinking(to_converse_input(body, CLAUDE), CLAUDE),
                                 "off sends exactly the request the bridge builds without checkpoints")


class SummarizedThinkingTests(unittest.IsolatedAsyncioTestCase):
    """Claude Opus 5.5 always thinks, and as Bedrock calls it by default it sends nothing until the thinking ends: the
    bridge asks it to stream a summary of its thinking instead (SUMMARIZED_THINKING_MODELS)."""

    def test_only_a_model_that_thinks_silently_is_asked_for_its_thinking_summarized(self):
        command = {"modelId": CLAUDE, "messages": [{"role": "user", "content": [{"text": "hi"}]}], "inferenceConfig": {"maxTokens": 64000}}
        for model in (CLAUDE, "us.anthropic.claude-opus-5-5", "anthropic.claude-opus-5-5"):
            with self.subTest(model=model):
                given = {**command, "modelId": model}
                snapshot = json.dumps(given, sort_keys=True)
                asked = with_summarized_thinking(given, model)
                self.assertEqual(asked, {**command, "modelId": model,
                                         "additionalModelRequestFields": {"thinking": {"type": "adaptive", "display": "summarized"}}})
                self.assertIsNot(asked["additionalModelRequestFields"]["thinking"], SUMMARIZED_THINKING)
                self.assertEqual(json.dumps(given, sort_keys=True), snapshot, "the command given is not mutated")
        for model in ("global.anthropic.claude-opus-4-8", "global.anthropic.claude-sonnet-5", "moonshotai.kimi-k2.5",
                      "global.anthropic.claude-opus-5-5-v2"):
            with self.subTest(model=model):
                plain = {**command, "modelId": model}
                self.assertIs(with_summarized_thinking(plain, model), plain)

    async def test_the_transport_asks_for_it_only_for_such_a_model_and_keeps_its_prompt_cache(self):
        events = text_turn("OK")
        body = chat_body(messages=[{"role": "user", "content": "Hi"}, {"role": "assistant", "content": "Hello"}, {"role": "user", "content": "More"}])
        for model, prompt_cache, asked in ((CLAUDE, False, True), (CLAUDE, True, True), ("global.anthropic.claude-opus-4-8", True, False)):
            with self.subTest(model=model, prompt_cache=prompt_cache):
                record: dict = {}
                transport = BedrockConverseTransport(region="us-east-1", model=model, auth={"aws": True}, prompt_cache=prompt_cache,
                                                     client_factory=lambda *args, record=record: FakeClient(record, events))
                async with httpx2.AsyncClient(transport=transport) as client:
                    response = await client.post(bridge_base_url("us-east-1") + "/chat/completions", json={**body, "model": model})
                self.assertEqual(response.status_code, 200)
                self.assertEqual(record["input"].get("additionalModelRequestFields"),
                                 {"thinking": {"type": "adaptive", "display": "summarized"}} if asked else None)
                self.assertEqual(json.dumps(record["input"]).count('"cachePoint"'), 1 if prompt_cache else 0)

    async def test_a_model_no_longer_asked_for_the_summary_waits_the_idle_limit(self):
        # The rollback: taken out of SUMMARIZED_THINKING_MODELS, Opus 5.5 is asked as before (no thinking setting) and,
        # since it thinks silently (THINKS_SILENTLY), waits the transport's limit, not the 3 minutes it waits with a summary.
        timeouts, record = [], {}

        def factory(region, auth, read_timeout):
            timeouts.append(read_timeout)
            return FakeClient(record, text_turn("OK"))
        transport = BedrockConverseTransport(region="us-east-1", model=CLAUDE, auth={"aws": True}, read_timeout=900.0, client_factory=factory)
        with mock.patch("bedrock_bridge.SUMMARIZED_THINKING_MODELS", frozenset()):
            async with httpx2.AsyncClient(transport=transport) as client:
                response = await client.post(bridge_base_url("us-east-1") + "/chat/completions", json=chat_body())
        self.assertEqual(response.status_code, 200)
        self.assertNotIn("additionalModelRequestFields", record["input"])
        self.assertEqual(timeouts, [900.0])


class ReasoningEffortTests(unittest.IsolatedAsyncioTestCase):
    """A thinking effort a run names for a Claude model whose catalog entry offers it (2026-10-26), sent as Claude's
    output_config.effort, as apps/bedrock-bridge.ts sends it."""

    def test_an_offered_level_is_claudes_output_config_beside_the_summary_and_no_other_level_is(self):
        self.assertEqual(REASONING_EFFORTS, ("low", "medium", "high"))
        for level in REASONING_EFFORTS:
            with self.subTest(level=level):
                command = to_converse_input(chat_body(reasoning_effort=level), CLAUDE, REASONING_EFFORTS)
                self.assertEqual(command["additionalModelRequestFields"], {"output_config": {"effort": level}})
                self.assertEqual(with_summarized_thinking(command, CLAUDE)["additionalModelRequestFields"],
                                 {"output_config": {"effort": level}, "thinking": {"type": "adaptive", "display": "summarized"}})
        self.assertNotIn("additionalModelRequestFields", to_converse_input(chat_body(reasoning_effort=None), CLAUDE, REASONING_EFFORTS))
        for level in ("minimal", "none", "xhigh", "max", "LOW", "", 3, ["low"]):
            with self.subTest(level=level), self.assertRaises(BridgeError) as caught:
                to_converse_input(chat_body(reasoning_effort=level), CLAUDE, REASONING_EFFORTS)
            self.assertEqual(caught.exception.message, "This Bedrock model does not offer that reasoning effort")
        with self.assertRaises(BridgeError) as caught:
            to_converse_input(chat_body(reasoning_effort="low"), CLAUDE)
        self.assertEqual(caught.exception.message, "Reasoning effort is not supported for this Bedrock model")
        # Model fields that already set thinking are kept as they are, the effort with them.
        thought = {"modelId": CLAUDE, "messages": [], "additionalModelRequestFields": {"output_config": {"effort": "low"}, "thinking": {"type": "enabled"}}}
        self.assertIs(with_summarized_thinking(thought, CLAUDE), thought)
        for value, valid in (((), True), (("low", "medium", "high"), True), (["high", "low"], True), (("low", "low"), False), (("minimal",), False),
                             ("low", False), ((1,), False), (None, False)):
            with self.subTest(value=value):
                self.assertEqual(valid_reasoning_efforts(value), valid)

    def test_the_quick_first_byte_limit_holds_with_an_effort_beside_the_summary(self):
        summary = {"thinking": {"type": "adaptive", "display": "summarized"}}
        command = {"modelId": CLAUDE, "messages": []}
        for fields, want in ((summary, 180.0), ({"output_config": {"effort": "low"}, **summary}, 180.0),
                             ({"output_config": {"effort": "low"}}, 900.0), (None, 900.0), ("odd", 900.0)):
            with self.subTest(fields=fields):
                given = {**command, **({"additionalModelRequestFields": fields} if fields is not None else {})}
                self.assertEqual(call_read_timeout(900.0, given, CLAUDE), want)

    async def test_the_transport_sends_an_offered_effort_and_checks_its_setting(self):
        record: dict = {}
        transport = BedrockConverseTransport(region="us-east-1", model=CLAUDE, auth={"aws": True}, reasoning_efforts=REASONING_EFFORTS,
                                             client_factory=lambda *args: FakeClient(record, text_turn("OK")))
        async with httpx2.AsyncClient(transport=transport) as client:
            response = await client.post(bridge_base_url("us-east-1") + "/chat/completions", json=chat_body(reasoning_effort="high"))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(record["input"]["additionalModelRequestFields"],
                         {"output_config": {"effort": "high"}, "thinking": {"type": "adaptive", "display": "summarized"}})
        # Without efforts the request is refused by the bridge itself, before any call.
        bare: dict = {}
        plain = BedrockConverseTransport(region="us-east-1", model=CLAUDE, auth={"aws": True}, client_factory=lambda *args: FakeClient(bare, text_turn("OK")))
        async with httpx2.AsyncClient(transport=plain) as client:
            refused = await client.post(bridge_base_url("us-east-1") + "/chat/completions", json=chat_body(reasoning_effort="high"))
        self.assertEqual(refused.status_code, 400)
        self.assertNotIn("input", bare)
        # Only the bridge's levels, each once, and only for a Claude model.
        for efforts in (("minimal",), ("low", "low"), "low", (1,)):
            with self.subTest(efforts=efforts), self.assertRaises(ValueError):
                BedrockConverseTransport(region="us-east-1", model=CLAUDE, auth={"aws": True}, reasoning_efforts=efforts)
        for model in ("moonshotai.kimi-k2.5", "deepseek.v3.2"):
            with self.subTest(model=model), self.assertRaises(ValueError):
                BedrockConverseTransport(region="us-east-1", model=model, auth={"aws": True}, reasoning_efforts=("low",))
        BedrockConverseTransport(region="us-east-1", model="us.anthropic.claude-opus-5-5", auth={"aws": True}, reasoning_efforts=("low",))
        BedrockConverseTransport(region="us-east-1", model="moonshotai.kimi-k2.5", auth={"aws": True}, reasoning_efforts=())


if __name__ == "__main__":
    unittest.main()
