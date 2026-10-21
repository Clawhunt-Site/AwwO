"""The DeepSeek API as a third operator platform: configuration and health (no network)."""
import json
import unittest

from bedrock_catalog import (
    DEEPSEEK_BASE_URL, PLATFORM_PROVIDERS, CatalogError, deepseek_key_problem, deepseek_profile_problem, parse_platform_providers, platform_providers_in_use,
)
from config import ConfigError, load_config, public_health

GATE = {
    "AWWO_OPENAI_AGENTS_TOKEN": "x" * 32, "AWWO_LLMGATE_ONLY": "true", "AWWO_CREDENTIAL_MODE": "operator",
    "AWWO_OPENAI_AGENTS_PROVIDER": "llmgate", "AWWO_OPENAI_AGENTS_MODEL": "qwen3.8-27b-p6", "AWWO_OPENAI_AGENTS_API_KEY": "sk-llmgate-synthetic",
    "AWWO_DEEPSEEK_API_KEY": "sk-deepseek-synthetic",
}
FLASH = {"id": "deepseek-flash", "name": "DeepSeek V4.1 Flash", "provider": "deepseek", "model": "deepseek-flash",
         "apiKeyEnv": "AWWO_DEEPSEEK_API_KEY", "contextWindow": 1_000_000, "maxTokens": 32_768, "reasoningEfforts": ["low", "medium", "high"]}


def with_profiles(profiles, **overrides):
    return load_config({**GATE, "AWWO_OPENAI_AGENTS_MODELS_JSON": json.dumps(profiles), **overrides})


class DeepSeekPlatformTests(unittest.TestCase):
    def test_policy_lists_deepseek_third_and_refuses_anything_else(self):
        self.assertEqual(PLATFORM_PROVIDERS, ("llmgate", "bedrock", "deepseek"))
        self.assertEqual(parse_platform_providers("deepseek,llmgate"), ("llmgate", "deepseek"))
        self.assertEqual(parse_platform_providers(" deepseek , bedrock , llmgate "), ("llmgate", "bedrock", "deepseek"))
        for value in ("deepseek", "llmgate,deepseek,deepseek", "llmgate,DeepSeek", "llmgate,deepseek-v4"):
            with self.assertRaisesRegex(CatalogError, "llmgate, bedrock, deepseek and include llmgate"):
                parse_platform_providers(value)
        self.assertEqual(platform_providers_in_use(("llmgate", "deepseek"), ["llmgate"]), ("llmgate",))
        self.assertEqual(platform_providers_in_use(("llmgate", "bedrock", "deepseek"), ["llmgate", "deepseek"]), ("llmgate", "deepseek"))

    def test_gate_only_worker_serves_deepseek_only_where_the_policy_names_it_and_then_says_so(self):
        with self.assertRaisesRegex(ConfigError, "AWWO_PLATFORM_PROVIDERS includes deepseek"):
            with_profiles([FLASH])
        with self.assertRaisesRegex(ConfigError, "AWWO_PLATFORM_PROVIDERS includes deepseek"):
            with_profiles([FLASH], AWWO_PLATFORM_PROVIDERS="llmgate,bedrock")
        config = with_profiles([FLASH], AWWO_PLATFORM_PROVIDERS="llmgate,deepseek")
        self.assertTrue(config.ready)
        flash = next(p for p in config.models if p.id == "deepseek-flash")
        self.assertEqual((flash.provider, flash.base_url, flash.api_key, flash.protocol), ("deepseek", DEEPSEEK_BASE_URL, "sk-deepseek-synthetic", "chat_completions"))
        health = public_health(config)
        self.assertNotIn("llmgateOnly", health)
        self.assertEqual((health["platformOnly"], health["platformProviders"]), (True, ["llmgate", "deepseek"]))
        # A policy that names deepseek is not a claim to reach it.
        self.assertTrue(public_health(load_config({**GATE, "AWWO_PLATFORM_PROVIDERS": "llmgate,deepseek"}))["llmgateOnly"])

    def test_the_deepseek_name_reaches_only_the_deepseek_api_and_only_with_operator_credentials(self):
        policy = {"AWWO_PLATFORM_PROVIDERS": "llmgate,deepseek"}
        for other in ({"baseURL": "https://api.deepseek.com/v1"}, {"baseURL": "https://api.clawhunt.site/v1"}, {"baseURL": "https://deepseek.example/v1"},
                      {"protocol": "responses"}):
            with self.subTest(other=other), self.assertRaisesRegex(ConfigError, "must use https://api.deepseek.com with Chat Completions"):
                with_profiles([{**FLASH, **other}], **policy)
        with self.assertRaisesRegex(ConfigError, "must use https://api.deepseek.com"):
            with_profiles([{**FLASH, "baseURL": "https://deepseek.example/v1"}], AWWO_LLMGATE_ONLY="false")
        self.assertEqual(next(p for p in with_profiles([FLASH], AWWO_LLMGATE_ONLY="false").models if p.id == "deepseek-flash").base_url, DEEPSEEK_BASE_URL)
        with self.assertRaisesRegex(ConfigError, "DeepSeek models use operator credentials"):
            with_profiles([FLASH], AWWO_CREDENTIAL_MODE="user", **policy)
        # A default profile on DeepSeek is held to the same rules.
        default = {**GATE, **policy, "AWWO_OPENAI_AGENTS_PROVIDER": "deepseek", "AWWO_OPENAI_AGENTS_MODEL": "deepseek-flash"}
        self.assertEqual(load_config(default).base_url, DEEPSEEK_BASE_URL)
        self.assertEqual(public_health(load_config(default))["platformProviders"], ["llmgate", "deepseek"])
        with self.assertRaisesRegex(ConfigError, "must use https://api.deepseek.com"):
            load_config({**default, "AWWO_OPENAI_AGENTS_BASE_URL": "https://deepseek.example/v1"})
        # A missing key is a missing credential, never a request without one.
        keyless = with_profiles([FLASH], AWWO_DEEPSEEK_API_KEY="", **policy)
        self.assertFalse(keyless.ready)
        self.assertIn("AWWO_OPENAI_AGENTS_MODELS_JSON_CREDENTIALS", keyless.missing)

    def test_the_deepseek_key_is_read_from_its_own_variable_only_and_reaches_no_other_profile(self):
        policy = {"AWWO_PLATFORM_PROVIDERS": "llmgate,bedrock,deepseek"}
        with self.assertRaisesRegex(ConfigError, "reads its key from AWWO_DEEPSEEK_API_KEY"):
            with_profiles([{**FLASH, "apiKeyEnv": "AWWO_OPENAI_AGENTS_API_KEY"}], **policy)
        for other in ({"id": "gate-two", "provider": "llmgate", "model": "gpt-5.5"}, {"id": "bedrock-two", "provider": "bedrock", "model": "us.anthropic.claude-haiku-4-5-20251001-v1:0"}):
            with self.subTest(other=other["provider"]), self.assertRaisesRegex(ConfigError, "Only a deepseek profile .* may read AWWO_DEEPSEEK_API_KEY"):
                with_profiles([{**other, "apiKeyEnv": "AWWO_DEEPSEEK_API_KEY"}], **policy)
        # A DeepSeek default model reads the DeepSeek key, never the worker's own key variable, even with both set.
        default = {**GATE, **policy, "AWWO_OPENAI_AGENTS_PROVIDER": "deepseek", "AWWO_OPENAI_AGENTS_MODEL": "deepseek-flash"}
        self.assertEqual((load_config(default).api_key, load_config(default).models[0].api_key), ("sk-deepseek-synthetic", "sk-deepseek-synthetic"))
        keyless = load_config({**default, "AWWO_DEEPSEEK_API_KEY": ""})
        self.assertFalse(keyless.ready)
        self.assertIn("AWWO_DEEPSEEK_API_KEY", keyless.missing)
        self.assertEqual(keyless.models[0].api_key, "")
        # The backstop: another profile's key pasted into the DeepSeek variable stops startup, whichever profile is the default.
        with self.assertRaisesRegex(ConfigError, "AWWO_DEEPSEEK_API_KEY must hold a DeepSeek API key"):
            with_profiles([FLASH], AWWO_DEEPSEEK_API_KEY="sk-llmgate-synthetic", **policy)
        gate_profile = {"id": "qwen3.8-27b", "provider": "llmgate", "model": "qwen3.8-27b", "apiKeyEnv": "AWWO_OPENAI_AGENTS_API_KEY"}
        with self.assertRaisesRegex(ConfigError, "AWWO_DEEPSEEK_API_KEY must hold a DeepSeek API key"):
            load_config({**default, "AWWO_DEEPSEEK_API_KEY": "sk-llmgate-synthetic", "AWWO_OPENAI_AGENTS_MODELS_JSON": json.dumps([gate_profile])})
        # Also before any DeepSeek profile exists: the key would otherwise reach the other service.
        with self.assertRaisesRegex(ConfigError, "AWWO_DEEPSEEK_API_KEY must hold a DeepSeek API key"):
            load_config({**GATE, "AWWO_DEEPSEEK_API_KEY": "sk-llmgate-synthetic"})
        self.assertTrue(load_config(GATE).ready, "a distinct DeepSeek key without a DeepSeek profile changes nothing")

    def test_a_deepseek_profile_cannot_claim_structured_output(self):
        with self.assertRaisesRegex(ConfigError, "cannot enable structuredOutput"):
            with_profiles([{**FLASH, "structuredOutput": True}], AWWO_PLATFORM_PROVIDERS="llmgate,deepseek")
        self.assertTrue(with_profiles([{**FLASH, "structuredOutput": False}], AWWO_PLATFORM_PROVIDERS="llmgate,deepseek").ready)

    def test_a_deepseek_profile_that_turns_thinking_off_lists_no_thinking_level(self):
        policy = {"AWWO_PLATFORM_PROVIDERS": "llmgate,deepseek"}
        with self.assertRaisesRegex(ConfigError, "turns thinking off lists no thinking level"):
            with_profiles([{**FLASH, "disableThinking": True}], **policy)
        quiet = {key: value for key, value in FLASH.items() if key != "reasoningEfforts"}
        self.assertFalse(next(p for p in with_profiles([{**quiet, "disableThinking": True}], **policy).models if p.id == "deepseek-flash").thinking)

    def test_under_gate_only_another_provider_cannot_reach_the_deepseek_api(self):
        # Only the deepseek name reaches DeepSeek: any other profile at its URL is outside the LLM Gate, and refused.
        policy = {"AWWO_PLATFORM_PROVIDERS": "llmgate,deepseek"}
        for provider in ("openai", "llmgate"):
            with self.subTest(provider=provider), self.assertRaisesRegex(ConfigError, "requires the LLM Gate endpoint"):
                with_profiles([{"id": "lookalike", "provider": provider, "model": "deepseek-flash", "baseURL": DEEPSEEK_BASE_URL,
                                "apiKeyEnv": "AWWO_OPENAI_AGENTS_API_KEY"}], **policy)
        with self.assertRaisesRegex(ConfigError, "requires the LLM Gate endpoint"):
            load_config({**GATE, **policy, "AWWO_OPENAI_AGENTS_BASE_URL": DEEPSEEK_BASE_URL})

    def test_problem_text_is_empty_without_deepseek_profiles(self):
        class P:
            def __init__(self, provider, base_url="", protocol="chat_completions"):
                self.provider, self.base_url, self.protocol = provider, base_url, protocol
                self.api_key, self.thinking, self.reasoning_efforts = "k-" + provider, True, ()
        self.assertEqual(deepseek_profile_problem(True, True, ("llmgate",), [P("llmgate")]), "")
        self.assertEqual(deepseek_profile_problem(False, True, ("llmgate", "deepseek"), [P("llmgate"), P("deepseek", DEEPSEEK_BASE_URL)]), "")
        self.assertEqual(deepseek_key_problem("deepseek", "AWWO_DEEPSEEK_API_KEY"), "")
        self.assertEqual(deepseek_key_problem("llmgate", "AWWO_OPENAI_AGENTS_API_KEY"), "")
        self.assertEqual(deepseek_key_problem("openai", None), "")


if __name__ == "__main__":
    unittest.main()
