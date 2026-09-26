"""Personal model admission: no shared-key fallback or cross-request mutation."""
import copy
import json
import unittest
from unittest.mock import patch
from aiohttp.test_utils import TestClient, TestServer

from config import ConfigError, bind_user_model, load_config, public_health
from server import create_app


class PersonalCredentialsTests(unittest.TestCase):
    def setUp(self):
        self.config = load_config({"AWWO_CREDENTIAL_MODE": "user", "AWWO_OPENAI_AGENTS_TOKEN": "t" * 32})
        self.selector = "byok_" + "a" * 33 + "_" + "b" * 16
        self.body = {"model": self.selector, "userModel": {
            "id": self.selector, "provider": "llmgate", "model": "test-model",
            "baseURL": "https://api.clawhunt.site/v1", "apiKey": "synthetic-personal-key",
            "protocol": "chat_completions", "contextWindow": 32768, "maxTokens": 4096,
            "reasoningEfforts": [], "defaultReasoningEffort": "",
        }}

    def test_personal_health_and_per_request_isolation(self):
        health = public_health(self.config)
        self.assertTrue(health["ready"])
        self.assertTrue(health["userCredentials"])
        self.assertEqual(health["models"], [])
        first, clean = bind_user_model(self.config, self.body)
        second_body = copy.deepcopy(self.body)
        second_body["userModel"]["apiKey"] = "second-personal-key"
        second, _ = bind_user_model(self.config, second_body)
        self.assertEqual(first.models[0].api_key, "synthetic-personal-key")
        self.assertEqual(second.models[0].api_key, "second-personal-key")
        self.assertEqual(self.config.models, ())
        self.assertNotIn("userModel", clean)
        self.assertIn("userModel", self.body)

    def test_missing_and_invalid_credentials_never_fall_back(self):
        with self.assertRaises(ValueError):
            bind_user_model(self.config, {"model": self.selector})
        for field, value in [("baseURL", "http://127.0.0.1/v1"), ("provider", "anthropic"),
                             ("apiKey", "invalid\nkey"), ("id", "other"), ("maxTokens", True),
                             ("protocol", "unknown"), ("reasoningEfforts", ["high"])]:
            with self.subTest(field=field):
                body = copy.deepcopy(self.body)
                body["userModel"][field] = value
                with self.assertRaises(ValueError):
                    bind_user_model(self.config, body)

    def test_operator_rejects_personal_override(self):
        config = load_config({"AWWO_OPENAI_AGENTS_TOKEN": "t" * 32})
        with self.assertRaises(ValueError):
            bind_user_model(config, self.body)

    def test_gate_only_rejects_direct_provider_even_with_valid_endpoint(self):
        env = {"AWWO_CREDENTIAL_MODE": "user", "AWWO_LLMGATE_ONLY": "true", "AWWO_OPENAI_AGENTS_TOKEN": "t" * 32}
        config = load_config(env)
        self.assertTrue(config.ready)
        self.assertEqual(config.provider, "llmgate")
        self.assertTrue(public_health(config)["llmgateOnly"])
        bind_user_model(config, self.body)
        legacy_alias = load_config({**env, "AWWO_OPENAI_AGENTS_PROVIDER": "openai",
                                    "AWWO_OPENAI_AGENTS_BASE_URL": "https://api.clawhunt.site/v1"})
        self.assertEqual(legacy_alias.base_url, "https://api.clawhunt.site/v1")
        direct = copy.deepcopy(self.body)
        direct["userModel"].update(provider="openai", baseURL="https://api.openai.com/v1")
        with self.assertRaises(ValueError):
            bind_user_model(config, direct)
        for override in ({"AWWO_OPENAI_AGENTS_PROVIDER": "openai"}, {"AWWO_OPENAI_AGENTS_BASE_URL": "https://api.openai.com/v1"}, {"AWWO_LLMGATE_ONLY": "yes"}):
            with self.subTest(override=override), self.assertRaises(ConfigError):
                load_config({**env, **override})
        direct_profile = [{"id": "direct", "provider": "openai", "model": "test-model",
                           "baseURL": "https://api.openai.com/v1", "apiKeyEnv": "SYNTHETIC_KEY"}]
        with self.assertRaises(ConfigError):
            load_config({**env, "SYNTHETIC_KEY": "synthetic-key",
                         "AWWO_OPENAI_AGENTS_MODELS_JSON": json.dumps(direct_profile)})

    def test_gate_only_operator_requires_gate_endpoint_for_all_profiles(self):
        env = {"AWWO_CREDENTIAL_MODE": "operator", "AWWO_LLMGATE_ONLY": "true",
               "AWWO_OPENAI_AGENTS_TOKEN": "t" * 32, "AWWO_OPENAI_AGENTS_MODEL": "gate-model",
               "AWWO_OPENAI_AGENTS_API_KEY": "synthetic-operator-key"}
        config = load_config(env)
        self.assertTrue(config.ready)
        self.assertFalse(config.user_credentials)
        self.assertEqual(config.models[0].base_url, "https://api.clawhunt.site/v1")
        self.assertTrue(public_health(config)["llmgateOnly"])
        alias = load_config({**env, "AWWO_OPENAI_AGENTS_PROVIDER": "openai",
                             "AWWO_OPENAI_AGENTS_BASE_URL": "https://api.clawhunt.site/v1"})
        self.assertTrue(alias.ready)
        self.assertEqual(alias.models[0].base_url, "https://api.clawhunt.site/v1")
        for override in ({"AWWO_OPENAI_AGENTS_BASE_URL": "https://api.openai.com/v1"},
                         {"AWWO_OPENAI_AGENTS_PROVIDER": "openai"}):
            with self.subTest(override=override), self.assertRaises(ConfigError):
                load_config({**env, **override})
        direct = [{"id": "direct", "provider": "openai", "model": "direct-model",
                   "baseURL": "https://api.openai.com/v1", "apiKeyEnv": "SYNTHETIC_KEY"}]
        with self.assertRaises(ConfigError):
            load_config({**env, "SYNTHETIC_KEY": "synthetic-key",
                         "AWWO_OPENAI_AGENTS_MODELS_JSON": json.dumps(direct)})


class PersonalHTTPTests(unittest.IsolatedAsyncioTestCase):
    async def test_http_requires_key_and_binds_separate_request_config(self):
        fixture = PersonalCredentialsTests()
        fixture.setUp()
        config = fixture.config
        received = []

        async def stream(request, run_config, cancel_event):
            received.append((request.model, run_config.models[0].api_key))
            yield {"type": "completed", "text": "Personal result"}

        with patch("server.load_config", return_value=config), patch("server.stream_run", stream):
            async with TestClient(TestServer(create_app())) as client:
                headers = {"Authorization": "Bearer " + config.token}
                body = {**fixture.body, "runId": "personal-run", "tenantId": "personal-tenant",
                        "sessionId": "personal-session", "prompt": "Answer", "messages": [],
                        "runtime": "openai-agents"}
                missing = {k: v for k, v in body.items() if k != "userModel"}
                denied = await client.post("/internal/runs", json=missing, headers=headers)
                self.assertEqual(denied.status, 400)
                self.assertEqual(received, [])
                for key in ["first-user-key", "second-user-key"]:
                    body["userModel"]["apiKey"] = key
                    response = await client.post("/internal/runs", json=body, headers=headers)
                    self.assertEqual(response.status, 200)
                    text = await response.text()
                    self.assertIn('"type": "completed"', text)
                    self.assertNotIn(key, text)
                self.assertEqual(received, [(fixture.selector, "first-user-key"), (fixture.selector, "second-user-key")])
                self.assertEqual(config.models, ())


if __name__ == "__main__":
    unittest.main()
