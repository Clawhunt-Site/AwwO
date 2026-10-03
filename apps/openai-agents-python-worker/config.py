"""Worker configuration from the same AWWO_OPENAI_AGENTS_* environment the
Node worker uses, so a deployment can swap the runtime without new variables.
"""

import json
import os
import re
from dataclasses import dataclass, field, replace

from bedrock_bridge import bridge_base_url, valid_region
from bedrock_catalog import (
    OPERATOR_ONLY_BEDROCK, CatalogError, bedrock_api_key, bedrock_region, catalog_selection, parse_platform_providers, platform_health,
    platform_providers_in_use,
)
from tools import tool_metadata

MODEL_SELECTOR = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$")
MAX_CATALOG_MODELS = 256  # Includes the required default profile.
MAX_CATALOG_BYTES = 512 * 1024
EFFORT_LEVELS = ["low", "medium", "high"]
PROTOCOLS = {"chat_completions", "responses"}
DEFAULT_BASE_URLS = {"openai": "https://api.openai.com/v1", "llmgate": "https://api.clawhunt.site/v1"}


class ConfigError(ValueError):
    pass


@dataclass(frozen=True)
class ModelProfile:
    id: str
    provider: str
    model: str
    base_url: str
    api_key: str
    protocol: str
    context_window: int
    max_tokens: int
    reasoning_efforts: tuple = field(default_factory=tuple)
    default_reasoning_effort: str = ""
    # False sends `chat_template_kwargs.enable_thinking=false` on Chat Completions, for models
    # (Qwen-style chat templates) whose hidden reasoning would otherwise spend the output budget.
    thinking: bool = True
    # Display name for the model picker; empty keeps the provider model ID.
    name: str = ""
    # Bedrock runtime region; set only for provider "bedrock".
    region: str = ""

    def to_health(self) -> dict:
        return {
            "id": self.id,
            "name": self.name or self.model,
            "providerModel": self.model,
            "provider": self.provider,
            "runtime": "openai-agents",
            "protocol": self.protocol,
            "maxContextTextBytes": max(0, self.context_window - self.max_tokens - 256),
            "messageOverheadBytes": 32,
            "reasoningEfforts": list(self.reasoning_efforts),
            "defaultReasoningEffort": self.default_reasoning_effort,
        }


@dataclass(frozen=True)
class Config:
    host: str
    port: int
    token: str
    provider: str
    model: str
    api_key: str
    base_url: str
    protocol: str
    environment: str
    enabled_tools: tuple
    timeout_ms: int
    max_concurrency: int
    max_output_bytes: int
    context_window: int
    max_tokens: int
    models: tuple
    ready: bool
    missing: tuple
    user_credentials: bool = False
    llmgate_only: bool = False
    platform_providers: tuple = ("llmgate",)


def _integer(env: dict, key: str, fallback: int, minimum: int, maximum: int) -> int:
    raw = env.get(key)
    if raw is None or raw == "":
        return fallback
    try:
        value = int(raw)
    except ValueError:
        raise ConfigError(f"{key} must be an integer")
    if value < minimum or value > maximum:
        raise ConfigError(f"{key} out of range")
    return value


def _parse_efforts(levels, fallback: str | None) -> tuple[tuple, str]:
    if levels is None or levels == "":
        parsed: list = []
    elif isinstance(levels, str):
        parsed = [part.strip() for part in levels.split(",") if part.strip()]
    else:
        parsed = list(levels)
    if len(parsed) > len(EFFORT_LEVELS) or any(level not in EFFORT_LEVELS for level in parsed) or len(set(parsed)) != len(parsed):
        raise ConfigError("Invalid reasoning effort levels")
    default_effort = fallback or ""
    if default_effort and default_effort not in parsed:
        raise ConfigError("Invalid default reasoning effort")
    return tuple(parsed), default_effort


def _flag(env: dict, key: str) -> bool:
    value = env.get(key, "")
    if value not in ("", "false", "true"):
        raise ConfigError(f"{key} must be true or false")
    return value == "true"


BEDROCK_PROFILE_FIELDS = {"id", "provider", "model", "region", "apiKeyEnv", "contextWindow", "maxTokens", "name",
                          "reasoningEfforts", "defaultReasoningEffort", "structuredOutput"}


def _bedrock_profile(entry_id: str, name: str, target: str, region: str, api_key: str, context_window: int, max_tokens: int) -> ModelProfile:
    # Bedrock is reached only through the Converse bridge, as an OpenAI-compatible endpoint;
    # it never advertises effort (the bridge refuses it).
    return ModelProfile(id=entry_id, provider="bedrock", model=target, base_url=bridge_base_url(region), api_key=api_key,
                        protocol="chat_completions", context_window=context_window, max_tokens=max_tokens, name=name, region=region)


def _bedrock_models_json_profile(value: dict, env: dict, ids: set, default: ModelProfile, missing: list) -> ModelProfile:
    invalid = ConfigError("Invalid Bedrock profile in AWWO_OPENAI_AGENTS_MODELS_JSON")
    if (set(value) - BEDROCK_PROFILE_FIELDS or not isinstance(value.get("id"), str)
            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", value["id"]) or value["id"] in ids
            or not isinstance(value.get("model"), str) or not MODEL_SELECTOR.fullmatch(value["model"])
            or ("region" in value and not valid_region(value["region"]))
            or ("apiKeyEnv" in value and (not isinstance(value["apiKeyEnv"], str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,127}", value["apiKeyEnv"])))
            or value.get("reasoningEfforts", []) != [] or value.get("defaultReasoningEffort", "") != ""
            or value.get("structuredOutput", False) is not False
            or ("name" in value and (not isinstance(value["name"], str) or not 1 <= len(value["name"]) <= 80))):
        raise invalid
    api_key = ""
    if "apiKeyEnv" in value:
        try:
            api_key = bedrock_api_key(env, value["apiKeyEnv"])
        except CatalogError:
            raise invalid
        if not api_key:
            missing.append("AWWO_OPENAI_AGENTS_MODELS_JSON_CREDENTIALS")
    context_window = value.get("contextWindow", default.context_window)
    max_tokens = value.get("maxTokens", default.max_tokens)
    if (not isinstance(context_window, int) or not 4096 <= context_window <= 2_000_000
            or not isinstance(max_tokens, int) or not 128 <= max_tokens <= 32_768 or max_tokens + 256 >= context_window):
        raise invalid
    try:
        region = value.get("region") or bedrock_region(env)
    except CatalogError as e:
        raise ConfigError(str(e))
    return _bedrock_profile(value["id"], value.get("name", value["model"]), value["model"], region, api_key, context_window, max_tokens)


def _load_profiles(serialized: str | None, env: dict, default: ModelProfile, missing: list) -> list:
    if serialized is None or serialized == "":
        return [default]
    if len(serialized.encode("utf-8")) > MAX_CATALOG_BYTES:
        raise ConfigError("AWWO_OPENAI_AGENTS_MODELS_JSON too large")
    try:
        values = json.loads(serialized)
    except json.JSONDecodeError:
        raise ConfigError("AWWO_OPENAI_AGENTS_MODELS_JSON must be a JSON array")
    if not isinstance(values, list) or len(values) >= MAX_CATALOG_MODELS:
        raise ConfigError("AWWO_OPENAI_AGENTS_MODELS_JSON must be a JSON array of at most 255 additional profiles")
    profiles = [default]
    ids = {default.id}
    for value in values:
        if isinstance(value, dict) and value.get("provider") == "bedrock":
            profiles.append(_bedrock_models_json_profile(value, env, ids, default, missing))
            ids.add(value["id"])
            continue
        if not isinstance(value, dict) or not isinstance(value.get("id"), str) or value.get("id") in ids:
            raise ConfigError("Invalid model profile in AWWO_OPENAI_AGENTS_MODELS_JSON")
        provider = value.get("provider", "openai")
        if provider not in DEFAULT_BASE_URLS:
            raise ConfigError("Unsupported provider in AWWO_OPENAI_AGENTS_MODELS_JSON")
        model = value.get("model")
        if not isinstance(model, str) or not MODEL_SELECTOR.fullmatch(model):
            raise ConfigError("Invalid model in AWWO_OPENAI_AGENTS_MODELS_JSON")
        api_key_env = value.get("apiKeyEnv")
        if not isinstance(api_key_env, str) or not api_key_env:
            raise ConfigError("apiKeyEnv required in AWWO_OPENAI_AGENTS_MODELS_JSON")
        api_key = (env.get(api_key_env) or "").strip()
        if not api_key or "\n" in api_key:
            missing.append("AWWO_OPENAI_AGENTS_MODELS_JSON_CREDENTIALS")
        context_window = value.get("contextWindow", default.context_window)
        max_tokens = value.get("maxTokens", default.max_tokens)
        if not isinstance(context_window, int) or not 4096 <= context_window <= 2_000_000:
            raise ConfigError("Invalid contextWindow in AWWO_OPENAI_AGENTS_MODELS_JSON")
        if not isinstance(max_tokens, int) or not 128 <= max_tokens <= 32_768:
            raise ConfigError("Invalid maxTokens in AWWO_OPENAI_AGENTS_MODELS_JSON")
        if max_tokens + 256 >= context_window:
            raise ConfigError("maxTokens too large for contextWindow")
        try:
            efforts, default_effort = _parse_efforts(value.get("reasoningEfforts"), value.get("defaultReasoningEffort"))
        except ConfigError:
            raise ConfigError("Invalid reasoningEfforts in AWWO_OPENAI_AGENTS_MODELS_JSON")
        # Never inherited: each profile says for its own model whether thinking is switched off.
        disable_thinking = value.get("disableThinking", False)
        if not isinstance(disable_thinking, bool):
            raise ConfigError("Invalid disableThinking in AWWO_OPENAI_AGENTS_MODELS_JSON")
        profiles.append(ModelProfile(
            id=value["id"],
            provider=provider,
            model=model,
            base_url=value.get("baseURL", DEFAULT_BASE_URLS[provider]),
            api_key=api_key,
            protocol=value.get("protocol", default.protocol),
            context_window=context_window,
            max_tokens=max_tokens,
            reasoning_efforts=efforts,
            default_reasoning_effort=default_effort,
            thinking=not disable_thinking,
        ))
        ids.add(value["id"])
    return profiles


def load_config(env: dict | None = None) -> Config:
    env = env if env is not None else dict(os.environ)
    gate_only_value = env.get("AWWO_LLMGATE_ONLY", "")
    if gate_only_value not in ("", "false", "true"):
        raise ConfigError("AWWO_LLMGATE_ONLY must be true or false")
    llmgate_only = gate_only_value == "true"
    mode = env.get("AWWO_CREDENTIAL_MODE", "operator")
    if mode not in ("user", "operator"):
        raise ConfigError("AWWO_CREDENTIAL_MODE must be user or operator")
    personal = mode == "user"
    provider = (env.get("AWWO_OPENAI_AGENTS_PROVIDER") or ("llmgate" if llmgate_only else "openai")).strip()
    protocol = env.get("AWWO_OPENAI_AGENTS_PROTOCOL") or "chat_completions"
    environment = env.get("APP_ENV") or "development"
    if environment not in ("development", "staging", "production"):
        raise ConfigError("APP_ENV must be development, staging, or production")
    try:
        enabled_tools = tuple(json.loads(env.get("AWWO_OPENAI_AGENTS_TOOLS_JSON") or "[]"))
    except json.JSONDecodeError:
        raise ConfigError("AWWO_OPENAI_AGENTS_TOOLS_JSON must be a JSON array")
    model = (env.get("AWWO_OPENAI_AGENTS_MODEL") or "").strip()
    api_key = (env.get("AWWO_OPENAI_AGENTS_API_KEY") or "").strip()
    token = env.get("AWWO_OPENAI_AGENTS_TOKEN") or ""
    base_url = (env.get("AWWO_OPENAI_AGENTS_BASE_URL") or "").strip() or DEFAULT_BASE_URLS.get(provider, "")

    missing: list = []
    if len(token) < 32 or "\n" in token:
        missing.append("AWWO_OPENAI_AGENTS_TOKEN")
    if protocol not in PROTOCOLS:
        missing.append("AWWO_OPENAI_AGENTS_PROTOCOL")
    if provider not in DEFAULT_BASE_URLS:
        missing.append("AWWO_OPENAI_AGENTS_PROVIDER")
    if not MODEL_SELECTOR.fullmatch(model):
        missing.append("AWWO_OPENAI_AGENTS_MODEL")
    if not api_key or "\n" in api_key:
        missing.append("AWWO_OPENAI_AGENTS_API_KEY")
    if not base_url or not re.fullmatch(r"https?://[^\s]+", base_url):
        missing.append("AWWO_OPENAI_AGENTS_BASE_URL")

    context_window = _integer(env, "AWWO_OPENAI_AGENTS_CONTEXT_WINDOW", 32_768, 4096, 2_000_000)
    max_tokens = _integer(env, "AWWO_OPENAI_AGENTS_MAX_TOKENS", 4096, 128, 32_768)
    if max_tokens + 256 >= context_window:
        missing.append("AWWO_OPENAI_AGENTS_MAX_TOKENS")
    try:
        efforts, default_effort = _parse_efforts(env.get("AWWO_OPENAI_AGENTS_REASONING_EFFORTS"), env.get("AWWO_OPENAI_AGENTS_DEFAULT_REASONING_EFFORT"))
    except ConfigError as e:
        raise ConfigError(str(e))
    disable_thinking = _flag(env, "AWWO_OPENAI_AGENTS_DISABLE_THINKING")

    default_profile = ModelProfile(
        id=model, provider=provider, model=model,
        base_url=base_url, api_key=api_key, protocol=protocol,
        context_window=context_window, max_tokens=max_tokens,
        reasoning_efforts=efforts, default_reasoning_effort=default_effort,
        thinking=not disable_thinking,
    )
    configured = _load_profiles(env.get("AWWO_OPENAI_AGENTS_MODELS_JSON"), env, default_profile, missing)
    try:
        selected = catalog_selection("openai-agents", env)
        region = bedrock_region(env) if selected else ""
        catalog_key = bedrock_api_key(env) if selected else ""
        platform_providers = parse_platform_providers(env.get("AWWO_PLATFORM_PROVIDERS"))
    except CatalogError as e:
        raise ConfigError(f"Bedrock catalog configuration is invalid: {e}")
    catalog = [_bedrock_profile(entry["id"], entry["name"], entry["target"], region, catalog_key, entry["contextWindow"], entry["maxTokens"])
               for entry in selected]
    if any(p.id in {c.id for c in configured} for p in catalog) or len(configured) + len(catalog) > MAX_CATALOG_MODELS:
        raise ConfigError("Bedrock catalog models must have unique IDs and fit the 256-model catalog")
    models = tuple(configured + catalog)
    # Legacy "openai" profiles can be protocol adapters for the Gate endpoint.
    # Personal mode replaces every profile before a request can reach the SDK.
    # Bedrock is a second operator destination only where the platform policy names it.
    if llmgate_only and any(p.provider != "bedrock" and p.base_url != DEFAULT_BASE_URLS["llmgate"] for p in models):
        raise ConfigError("AWWO_LLMGATE_ONLY requires the LLM Gate endpoint for every model profile")
    if llmgate_only and any(p.provider == "bedrock" for p in models) and "bedrock" not in platform_providers:
        raise ConfigError("AWWO_LLMGATE_ONLY allows Bedrock profiles only when AWWO_PLATFORM_PROVIDERS includes bedrock")
    if personal and any(p.provider == "bedrock" for p in models):
        raise ConfigError(OPERATOR_ONLY_BEDROCK)
    served = () if personal else models

    return Config(
        host=env.get("AWWO_OPENAI_AGENTS_HOST") or "127.0.0.1",
        port=_integer(env, "AWWO_OPENAI_AGENTS_PORT", 8099, 0, 65535),
        token=token, provider=provider, model=model,
        api_key=api_key, base_url=base_url, protocol=protocol,
        environment=environment,
        enabled_tools=tuple(enabled_tools),
        timeout_ms=_integer(env, "AWWO_OPENAI_AGENTS_TIMEOUT_MS", 120_000, 100, 600_000),
        max_concurrency=_integer(env, "AWWO_OPENAI_AGENTS_MAX_CONCURRENCY", 4, 1, 32),
        max_output_bytes=_integer(env, "AWWO_OPENAI_AGENTS_MAX_OUTPUT_BYTES", 1_048_576, 1024, 8_388_608),
        context_window=context_window, max_tokens=max_tokens,
        models=served,
        ready=(len(token) >= 32 and not re.search(r"[\r\n]", token)) if personal else not missing,
        missing=tuple(x for x in dict.fromkeys(missing) if not personal or x == "AWWO_OPENAI_AGENTS_TOKEN"),
        user_credentials=personal,
        llmgate_only=llmgate_only,
        # What health claims: the destinations these profiles reach, within the policy checked above.
        platform_providers=platform_providers_in_use(platform_providers, [p.provider for p in served]),
    )


def public_health(config: Config, active_runs: int = 0) -> dict:
    return {
        "status": "ready" if config.ready else "unconfigured",
        "ready": config.ready,
        "configured": config.ready,
        "userCredentials": config.user_credentials,
        **platform_health(config.llmgate_only, config.platform_providers),
        "provider": config.provider or None,
        "model": config.model or None,
        "runtime": "openai-agents",
        "tracingEnabled": False,
        "maxModelCallsPerRun": 1,
        "supportsEffortSelection": any(p.reasoning_efforts for p in config.models),
        "tools": [tool_metadata(name) for name in config.enabled_tools],
        "models": [p.to_health() for p in config.models if p.id and p.provider],
        "activeRuns": active_runs,
        "version": "0.1.0",
        "telemetryProtocolVersion": 1,
        "metricsEnabled": False,
        "selfHostedTracingEnabled": False,
        "sdkVersion": "python",
        "modelConnectivityVerified": False,
        "limits": {
            "bodyBytes": 2_097_152,
            "promptChars": 200_000,
            "systemPromptChars": 200_000,
            "historyMessages": 200,
            "historyMessageChars": 100_000,
            "totalTextChars": 500_000,
            "contextWindow": config.context_window,
            "maxOutputTokens": config.max_tokens,
            "maxContextTextBytes": max(0, config.context_window - config.max_tokens - 256),
            "messageOverheadBytes": 32,
        },
    }


PERSONAL_ENDPOINTS = {
    "llmgate": "https://api.clawhunt.site/v1",
    "openai": "https://api.openai.com/v1",
    "xai": "https://api.x.ai/v1",
    "google": "https://generativelanguage.googleapis.com/v1beta/openai",
}


def bind_user_model(config: Config, body: dict) -> tuple[Config, dict]:
    """Resolve only an authenticated request's profile, without shared mutation."""
    if not isinstance(body, dict):
        raise ValueError("Invalid request")
    if not config.user_credentials:
        if "userModel" in body:
            raise ValueError("Personal credentials are disabled")
        return config, body
    model = body.get("userModel")
    fields = {"id", "provider", "model", "baseURL", "apiKey", "protocol", "contextWindow",
              "maxTokens", "reasoningEfforts", "defaultReasoningEffort"}
    if not isinstance(model, dict) or set(model) != fields:
        raise ValueError("Invalid personal model configuration")
    if (not isinstance(model["id"], str)
            or not re.fullmatch(r"byok_[A-Za-z0-9_-]{33}_[0-9a-f]{16}", model["id"])
            or model["id"] != body.get("model")
            or not isinstance(model["model"], str)
            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:/-]{0,159}", model["model"])
            or not isinstance(model["provider"], str)
            or model["provider"] not in PERSONAL_ENDPOINTS
            or (config.llmgate_only and model["provider"] != "llmgate")
            or model["baseURL"] != PERSONAL_ENDPOINTS[model["provider"]]
            or not isinstance(model["apiKey"], str)
            or not re.fullmatch(r"[\x21-\x7e]{8,4096}", model["apiKey"])
            or not isinstance(model["protocol"], str) or model["protocol"] not in PROTOCOLS
            or type(model["contextWindow"]) is not int or model["contextWindow"] != 32768
            or type(model["maxTokens"]) is not int or model["maxTokens"] != 4096
            or model["reasoningEfforts"] != [] or model["defaultReasoningEffort"] != ""):
        raise ValueError("Invalid personal model configuration")
    profile = ModelProfile(id=model["id"], provider="openai", model=model["model"],
                           base_url=model["baseURL"], api_key=model["apiKey"], protocol=model["protocol"],
                           context_window=32768, max_tokens=4096)
    clean = {key: value for key, value in body.items() if key != "userModel"}
    return replace(config, models=(profile,), model=profile.id, api_key="", ready=True), clean


def resolve_model_config(config: Config, selector: str | None) -> ModelProfile:
    if selector is None:
        return config.models[0]
    for profile in config.models:
        if profile.id == selector:
            return profile
    raise ValueError("Unknown configured model")


def fits_context_budget(text_bytes: int, tool_bytes: int, message_count: int, profile: ModelProfile) -> bool:
    return text_bytes + tool_bytes + 32 * (message_count + 1) <= profile.context_window - profile.max_tokens - 256


def authorize_effort(profile: ModelProfile, effort: str | None) -> str:
    if effort is None:
        return ""
    if effort not in profile.reasoning_efforts:
        raise ValueError("Effort is not supported by the selected model")
    return effort
