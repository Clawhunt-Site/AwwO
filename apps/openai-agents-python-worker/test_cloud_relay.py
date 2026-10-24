"""「AwwO 线上」 models (docs/awwo-cloud-relay.md): bound only to the relay the runtime links to, with their own limits."""
import copy
import json
import os
import unittest
from pathlib import Path
from unittest.mock import patch

from config import bind_user_model, cloud_relay_url, load_config, valid_cloud_origin

VECTORS = json.loads((Path(__file__).resolve().parent.parent / "cloud-origin-vectors.json").read_text(encoding="utf-8"))

RELAY = "https://awwo.clawhunt.store/api/v1/relay/v1"


class CloudRelayModelTests(unittest.TestCase):
    def setUp(self):
        self.config = load_config({"AWWO_CREDENTIAL_MODE": "user", "AWWO_OPENAI_AGENTS_TOKEN": "t" * 32})
        self.selector = "byok_" + "a" * 33 + "_" + "b" * 16
        self.body = {"model": self.selector, "userModel": {
            "id": self.selector, "provider": "awwo", "model": "bedrock.claude-opus-5-5",
            "baseURL": RELAY, "apiKey": "awwo_lk_" + "x" * 43,
            "protocol": "chat_completions", "contextWindow": 200000, "maxTokens": 64000,
            "reasoningEfforts": [], "defaultReasoningEffort": "", "input": ["text", "image"], "proseBytesPerToken": 2.15,
        }}

    def bind(self, body, origin="https://awwo.clawhunt.store"):
        with patch.dict(os.environ, {"AWWO_CLOUD_ORIGIN": origin}):
            return bind_user_model(self.config, copy.deepcopy(body))

    def test_a_relayed_model_keeps_its_own_limits_and_input(self):
        config, clean = self.bind(self.body)
        profile = config.models[0]
        self.assertEqual((profile.provider, profile.base_url, profile.context_window, profile.max_tokens), ("openai", RELAY, 200000, 64000))
        self.assertEqual(profile.input, ("text", "image"))
        self.assertEqual(profile.prose_bytes_per_token, 2.15)
        self.assertNotIn("userModel", clean)
        model = copy.deepcopy(self.body)
        del model["userModel"]["input"], model["userModel"]["proseBytesPerToken"]
        plain, _ = self.bind(model)
        self.assertEqual((plain.models[0].input, plain.models[0].prose_bytes_per_token), (("text",), 1.0))

    def test_only_the_runtimes_own_relay_is_taken(self):
        for origin in ["", "http://awwo.clawhunt.store", "https://awwo.clawhunt.store/path", "https://evil.example"]:
            with self.subTest(origin=origin), self.assertRaises(ValueError):
                self.bind(self.body, origin)
        self.assertEqual(cloud_relay_url({"AWWO_CLOUD_ORIGIN": "http://127.0.0.1:18087"}), "http://127.0.0.1:18087/api/v1/relay/v1")
        self.assertEqual(cloud_relay_url({"AWWO_CLOUD_ORIGIN": "http://localhost:18087"}), "")

    def test_the_origin_is_read_as_every_reader_reads_it(self):
        self.assertGreaterEqual(len(VECTORS["cases"]), 20)
        for case in VECTORS["cases"]:
            with self.subTest(origin=case["origin"]):
                self.assertEqual(valid_cloud_origin(case["origin"]), case["valid"])
                self.assertEqual(cloud_relay_url({"AWWO_CLOUD_ORIGIN": case["origin"]}), case["origin"] + "/api/v1/relay/v1" if case["valid"] else "")
        self.assertFalse(valid_cloud_origin(None))

    def test_limits_and_fields_outside_the_catalogs_bounds_are_refused(self):
        for key, value in [("contextWindow", 2_000_001), ("maxTokens", 65_537), ("maxTokens", 199_900), ("input", ["image"]),
                           ("input", ["text", "audio"]), ("proseBytesPerToken", 9), ("protocol", "responses"), ("contextWindow", 200000.0)]:
            body = copy.deepcopy(self.body)
            body["userModel"][key] = value
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                self.bind(body)
        stray = copy.deepcopy(self.body)
        stray["userModel"]["structuredOutput"] = True
        with self.assertRaises(ValueError):
            self.bind(stray)

    def test_other_providers_keep_their_fixed_limits_and_take_no_relay_fields(self):
        gate = copy.deepcopy(self.body)
        gate["userModel"].update({"provider": "llmgate", "baseURL": "https://api.clawhunt.site/v1", "contextWindow": 32768, "maxTokens": 4096})
        with self.assertRaises(ValueError):
            self.bind(gate)  # it carries input and proseBytesPerToken
        del gate["userModel"]["input"], gate["userModel"]["proseBytesPerToken"]
        config, _ = self.bind(gate)
        self.assertEqual((config.models[0].context_window, config.models[0].max_tokens), (32768, 4096))
        gate["userModel"]["contextWindow"] = 200000
        with self.assertRaises(ValueError):
            self.bind(gate)
        relay_at_gate = copy.deepcopy(self.body)
        relay_at_gate["userModel"]["baseURL"] = "https://api.clawhunt.site/v1"
        with self.assertRaises(ValueError):
            self.bind(relay_at_gate)


if __name__ == "__main__":
    unittest.main()
