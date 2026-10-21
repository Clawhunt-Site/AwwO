"""The token estimate agrees with the TypeScript and Go implementations on the shared vectors, and a model's measured
prose rate reaches its health and its admission."""
import json
import unittest
from pathlib import Path

from config import ConfigError, context_tokens, fits_context_budget, load_config, public_health, resolve_model_config
from context_estimate import PROSE_RATE_MAX, estimate_tokens, prose_rate, text_cost
from runner import RunRequest, _prepare

GATE = {
    "AWWO_OPENAI_AGENTS_TOKEN": "x" * 32, "AWWO_OPENAI_AGENTS_PROVIDER": "llmgate", "AWWO_OPENAI_AGENTS_MODEL": "qwen3.8-27b-p6",
    "AWWO_OPENAI_AGENTS_API_KEY": "sk-llmgate-synthetic", "AWWO_OPENAI_AGENTS_CONTEXT_WINDOW": "4096", "AWWO_OPENAI_AGENTS_MAX_TOKENS": "128",
}
REVIEWER = {"id": "reviewer", "provider": "llmgate", "model": "review-model", "apiKeyEnv": "REVIEW_KEY", "contextWindow": 4096, "maxTokens": 128,
            "proseBytesPerToken": 2.15}

APPS = Path(__file__).resolve().parent.parent
VECTORS = json.loads((APPS / "context-estimate-vectors.json").read_text(encoding="utf-8"))


def utf8_bytes(text: str) -> int:
    return len(text.encode("utf-8", "replace"))


class ContextEstimateTest(unittest.TestCase):
    def test_shared_vectors(self):
        self.assertGreaterEqual(len(VECTORS["cases"]), 20)
        for case in VECTORS["cases"]:
            with self.subTest(case["name"]):
                self.assertEqual(text_cost(case["text"]), (case["strict"], case["prose"]))
                for rate, expected in zip(VECTORS["rates"], case["estimate"]):
                    self.assertEqual(estimate_tokens(case["text"], rate), expected)

    def test_rate_one_is_bytes(self):
        for case in VECTORS["cases"]:
            if "\ud800" in case["text"]:
                continue  # a lone surrogate has no UTF-8 form here; the vector itself pins it at 3 bytes
            with self.subTest(case["name"]):
                self.assertEqual(estimate_tokens(case["text"]), utf8_bytes(case["text"]))
                self.assertEqual(estimate_tokens(case["text"], 1), utf8_bytes(case["text"]))

    def test_bounds(self):
        text = "说明 version 5.6 " + "x" * 40 + " 😀 plain words"
        strict, _ = text_cost(text)
        for rate in (1, 1.5, 2.15, 3.3, 4):
            estimate = estimate_tokens(text, rate)
            self.assertTrue(strict <= estimate <= utf8_bytes(text), (rate, estimate))
        self.assertEqual(estimate_tokens(text, 9), estimate_tokens(text, PROSE_RATE_MAX))

    def test_declared_rate(self):
        self.assertEqual(prose_rate(), 1)
        for ok in (1, 1.05, 2.15, 3.3, 4):
            self.assertEqual(prose_rate(ok), ok)
        for bad in (0, 0.95, 4.05, 2.13, "2", True, None, float("nan"), float("inf"), [2]):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                prose_rate(bad)


class ProseRateConfigTest(unittest.TestCase):
    def config(self, **extra):
        env = {**GATE, "AWWO_OPENAI_AGENTS_PROSE_BYTES_PER_TOKEN": "2.95", "REVIEW_KEY": "k",
               "AWWO_OPENAI_AGENTS_MODELS_JSON": json.dumps([REVIEWER]), **extra}
        return load_config(env)

    def test_health_publishes_the_rate_only_where_one_is_set(self):
        health = public_health(self.config())
        self.assertEqual(health["limits"]["proseBytesPerToken"], 2.95)
        rates = {model["id"]: model.get("proseBytesPerToken") for model in health["models"]}
        self.assertEqual(rates, {"qwen3.8-27b-p6": 2.95, "reviewer": 2.15})
        self.assertEqual(next(m for m in health["models"] if m["id"] == "reviewer")["maxContextTextBytes"], 4096 - 128 - 256)
        plain = public_health(load_config(GATE))
        self.assertNotIn("proseBytesPerToken", plain["limits"])
        self.assertTrue(all("proseBytesPerToken" not in model for model in plain["models"]))

    def test_admission_counts_the_estimate(self):
        config = self.config()
        room = 4096 - 128 - 256 - 32
        prose = "画布方案" * -(-room * 2 // 12)
        plain = load_config(GATE)
        self.assertFalse(fits_context_budget(context_tokens([prose], resolve_model_config(plain, None)), 0, 0, resolve_model_config(plain, None)))
        for model in (None, "reviewer"):
            profile = resolve_model_config(config, model)
            self.assertTrue(fits_context_budget(context_tokens([prose], profile), 0, 0, profile), model)
        reviewer = resolve_model_config(config, "reviewer")
        self.assertFalse(fits_context_budget(context_tokens([prose + prose], reviewer), 0, 0, reviewer))
        for dense in ("QUJD" * (room // 4 + 1), "1234 " * (room // 5 + 1), "y" * (room + 1)):
            profile = resolve_model_config(config, None)
            self.assertFalse(fits_context_budget(context_tokens([dense], profile), 0, 0, profile))
        # The run's own admission counts the same way: the prose is admitted, the base64 refused.
        _prepare(RunRequest("r1", "t1", "s1", prose, []), config)
        with self.assertRaisesRegex(ValueError, "too large"):
            _prepare(RunRequest("r1", "t1", "s1", "QUJD" * (room // 4 + 1), []), config)

    def test_a_run_too_large_by_this_workers_measure_ends_as_that_refusal(self):
        # The stream has begun by then (server.py), so the refusal is its terminal event: CONTEXT_LIMIT, which the API
        # settles as a call that never began, not a model failure it charges and runs again.
        import asyncio
        from runner import stream_run
        config = self.config()
        room = 4096 - 128 - 256 - 32

        async def collect():
            return [event async for event in stream_run(RunRequest("r1", "t1", "s1", "QUJD" * (room // 4 + 1), []), config, asyncio.Event())]

        events = asyncio.run(collect())
        self.assertEqual((events[-1]["type"], events[-1]["code"]), ("failed", "CONTEXT_LIMIT"), events)

    def test_bad_rates_stop_the_worker(self):
        for bad in ("abc", "4.5", "0.9", "2.13", "-1"):
            with self.subTest(env=bad), self.assertRaisesRegex(ConfigError, "AWWO_OPENAI_AGENTS_PROSE_BYTES_PER_TOKEN"):
                self.config(AWWO_OPENAI_AGENTS_PROSE_BYTES_PER_TOKEN=bad)
        for bad in (0.5, 4.05, 2.13, "2", None, True):
            with self.subTest(profile=bad), self.assertRaisesRegex(ConfigError, "proseBytesPerToken"):
                self.config(AWWO_OPENAI_AGENTS_MODELS_JSON=json.dumps([{**REVIEWER, "proseBytesPerToken": bad}]))
        bedrock = {"id": "bedrock.custom", "provider": "bedrock", "model": "us.anthropic.claude-haiku-4-5-20251001-v1:0",
                   "contextWindow": 200000, "maxTokens": 8192}
        env = {"AWWO_PLATFORM_PROVIDERS": "llmgate,bedrock", "AWWO_LLMGATE_ONLY": "true"}
        ok = self.config(**env, AWWO_OPENAI_AGENTS_MODELS_JSON=json.dumps([{**bedrock, "proseBytesPerToken": 2.35}]))
        self.assertEqual(resolve_model_config(ok, "bedrock.custom").prose_bytes_per_token, 2.35)
        with self.assertRaisesRegex(ConfigError, "Bedrock profile"):
            self.config(**env, AWWO_OPENAI_AGENTS_MODELS_JSON=json.dumps([{**bedrock, "proseBytesPerToken": 5}]))


if __name__ == "__main__":
    unittest.main()
