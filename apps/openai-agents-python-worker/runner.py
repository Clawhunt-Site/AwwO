"""Run one agent task with the openai-agents Python SDK, streaming text deltas."""

import asyncio
import json
import sys
import time
from contextlib import aclosing, suppress
from dataclasses import dataclass
from typing import AsyncIterator

from agents import Agent, FunctionTool, ModelSettings, OpenAIChatCompletionsModel, OpenAIResponsesModel, RunConfig, Runner
from openai import AsyncOpenAI, DefaultAsyncHttpxClient, Timeout

from bedrock_bridge import BRIDGE_API_KEY, BedrockConverseTransport, bedrock_fact_line, stream_read_timeout
from config import MAX_IMAGE_BYTES, MAX_IMAGES, PERSONAL_ENDPOINTS, Config, ModelProfile, authorize_effort, fits_context_budget, resolve_model_config
from errors import RuntimeError, classify_error
from provider_observation import ProviderObservation
from tools import TOOL_SCHEMAS, ToolInputError, execute_tool, tool_definition_bytes, validate_tool_names


# Provider reasoning crosses this worker as a count, never as its text, and at most
# this often: a reader needs to see that the model is working, not each token of it.
REASONING_REPORT_SECONDS = 0.5
# Chat Completions reasoning fields reach the SDK stream as these Responses events,
# exactly as a Responses model's own reasoning deltas do.
REASONING_DELTA_EVENTS = frozenset({"response.reasoning_summary_text.delta", "response.reasoning_text.delta"})


class ReasoningCounter:
    """Coalesce streamed provider reasoning into cumulative, content-free counts."""

    def __init__(self, clock=time.monotonic):
        self.characters = 0
        self._started = False
        self._reported = -1
        self._reported_at = 0.0
        self._clock = clock

    def start(self) -> None:
        self._started = True

    def add(self, delta: str) -> None:
        self._started = True
        self.characters += len(delta)

    def report(self, force: bool) -> dict | None:
        """Return the count event to send now, if the count changed and is due. Nothing is
        reported for a model that never reasons: a zero would claim it is thinking."""
        if not self._started or self.characters == self._reported:
            return None
        now = self._clock()
        if not force and now - self._reported_at < REASONING_REPORT_SECONDS:
            return None
        self._reported, self._reported_at = self.characters, now
        return {"type": "reasoning", "characters": self.characters}


@dataclass
class RunRequest:
    run_id: str
    tenant_id: str
    session_id: str
    prompt: str
    messages: list
    system_prompt: str | None = None
    model: str | None = None
    runtime: str | None = None
    tools: list | None = None
    effort: str | None = None
    # The run's pictures for the final user turn: [{name, mimeType, data (base64)}] (vision).
    images: list | None = None


IMAGE_TYPES = ("image/png", "image/jpeg", "image/gif", "image/webp")


def _validate_images(images) -> list:
    import re
    if not isinstance(images, list) or not 1 <= len(images) <= MAX_IMAGES:
        raise ValueError("Invalid images")
    for image in images:
        if (not isinstance(image, dict) or set(image) != {"name", "mimeType", "data"}
                or not isinstance(image["name"], str) or not 1 <= len(image["name"]) <= 200
                or image["mimeType"] not in IMAGE_TYPES or not isinstance(image["data"], str)
                or len(image["data"]) % 4 or not re.fullmatch(r"[A-Za-z0-9+/]+={0,2}", image["data"])):
            raise ValueError("Invalid images")
        size = len(image["data"]) // 4 * 3 - (len(image["data"]) - len(image["data"].rstrip("=")))
        if not 1 <= size <= MAX_IMAGE_BYTES:
            raise ValueError("Invalid images")
    return images


def model_takes_images(config: Config, selector: str | None) -> bool:
    """Whether the model a run selects lists "image" in what it takes; an unknown model takes none."""
    try:
        return "image" in resolve_model_config(config, selector).input
    except Exception:
        return False

def validate_request(value: dict, config: Config) -> RunRequest:
    allowed = {"runId", "tenantId", "sessionId", "prompt", "messages", "systemPrompt", "model", "runtime", "tools", "effort", "images"}
    if not isinstance(value, dict) or any(key not in allowed for key in value):
        raise ValueError("Invalid request fields")
    images = _validate_images(value["images"]) if value.get("images") is not None else None
    import re
    for field_name in ("runId", "tenantId", "sessionId"):
        if not isinstance(value.get(field_name), str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}", value[field_name]):
            raise ValueError(f"Invalid {field_name}")
    if value.get("model") is not None and (not isinstance(value["model"], str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}", value["model"])):
        raise ValueError("Invalid model selector")
    if value.get("effort") is not None and value["effort"] not in ("low", "medium", "high"):
        raise ValueError("Invalid effort selector")
    if value.get("runtime") is not None and value["runtime"] != "openai-agents":
        raise ValueError("Invalid runtime selector")
    tools = value.get("tools") or []
    try:
        validate_tool_names(tools)
    except ToolInputError:
        raise ValueError("Invalid tool selection")
    if not isinstance(value.get("prompt"), str) or not value["prompt"].strip() or len(value["prompt"]) > 200_000:
        raise ValueError("Invalid prompt")
    if value.get("systemPrompt") is not None and (not isinstance(value["systemPrompt"], str) or len(value["systemPrompt"]) > 200_000):
        raise ValueError("Invalid systemPrompt")
    messages = value.get("messages") or []
    if not isinstance(messages, list) or len(messages) > 200:
        raise ValueError("Invalid messages")
    total = len(value["prompt"]) + len(value.get("systemPrompt") or "")
    for message in messages:
        if not isinstance(message, dict) or set(message.keys()) != {"role", "content"} \
                or message["role"] not in ("user", "assistant") or not isinstance(message["content"], str) \
                or len(message["content"]) > 100_000:
            raise ValueError("Invalid history message")
        total += len(message["content"])
    if total > 500_000:
        raise ValueError("Conversation is too large")
    return RunRequest(
        run_id=value["runId"],
        tenant_id=value["tenantId"],
        session_id=value["sessionId"],
        prompt=value["prompt"],
        messages=messages,
        system_prompt=value.get("systemPrompt"),
        model=value.get("model"),
        runtime=value.get("runtime"),
        tools=tools,
        effort=value.get("effort"),
        images=images,
    )


def _build_tools(request: RunRequest, config: Config) -> list:
    names = request.tools or []
    if any(name not in config.enabled_tools for name in names):
        raise RuntimeError("TOOL_DENIED")
    functions = []
    for name in names:
        schema = TOOL_SCHEMAS[name]

        def make_handler(n: str):
            async def handler(_context, arguments: str):
                try:
                    value = json.loads(arguments)
                except (TypeError, ValueError) as exc:
                    raise ToolInputError() from exc
                return execute_tool(n, value)
            return handler

        functions.append(FunctionTool(
            name=name, description=schema["description"],
            params_json_schema=schema["parameters"],
            on_invoke_tool=make_handler(name),
        ))
    return functions


def _prepare(request: RunRequest, config: Config) -> tuple[ModelProfile, str]:
    profile = resolve_model_config(config, request.model)
    effort = authorize_effort(profile, request.effort)
    # The server refused pictures for a text model already; a bound personal model is never one that takes them.
    if request.images and "image" not in profile.input:
        raise ValueError("Images are not supported by this model")
    text_bytes = len(request.prompt.encode("utf-8")) + len((request.system_prompt or "").encode("utf-8"))
    for message in request.messages:
        text_bytes += len(message["content"].encode("utf-8"))
    if not fits_context_budget(text_bytes, tool_definition_bytes(request.tools or []), len(request.messages), profile):
        raise ValueError("Conversation is too large")
    return profile, effort


class _CheckedCompletion:
    """Prevent SDK-normalized success (and tool execution) after provider truncation."""
    def __init__(self, *args, observation, **kwargs):
        super().__init__(*args, **kwargs)
        self.observation = observation

    async def stream_response(self, *args, **kwargs):
        async with aclosing(super().stream_response(*args, **kwargs)) as events:
            async for event in events:
                if event.type == "response.completed":
                    self.observation.require_complete()
                yield event
            self.observation.require_complete()


class _CheckedChatModel(_CheckedCompletion, OpenAIChatCompletionsModel):
    pass


class _CheckedResponsesModel(_CheckedCompletion, OpenAIResponsesModel):
    pass


async def stream_run(request: RunRequest, config: Config, cancel_event: asyncio.Event) -> AsyncIterator[dict]:
    """Yield wire events: {"type":"text_delta","delta":...} then a terminal event."""
    observation = ProviderObservation(config.protocol)
    try:
        profile, effort = _prepare(request, config)
    except ValueError as e:
        yield {**classify_error(RuntimeError("OUTPUT_LIMIT" if "too large" in str(e) else "MODEL_REQUEST_REJECTED")),
               "observability": observation.snapshot("failed")}
        return
    observation.protocol = profile.protocol

    input_messages = [{"role": m["role"], "content": m["content"]} for m in request.messages]
    final_turn: dict = {"role": "user", "content": request.prompt}
    if request.images:
        # The SDK's chat converter makes each input_image an image_url part; the Bedrock bridge, an image block.
        final_turn = {"role": "user", "content": [{"type": "input_text", "text": request.prompt}] + [
            {"type": "input_image", "image_url": f"data:{image['mimeType']};base64,{image['data']}", "detail": "auto"}
            for image in request.images]}
    input_messages.append(final_turn)

    settings = {"max_tokens": profile.max_tokens, "parallel_tool_calls": False}
    if profile.protocol == "chat_completions":
        # Third-party endpoints do not get this SDK opt-in by default. Omitted provider
        # usage still remains unknown, never synthesized from SDK token defaults.
        settings["include_usage"] = True
    # Gemini rejects OpenAI's optional storage field, including store=false.
    # Keep explicit no-storage requests for providers which accept that field.
    if profile.base_url.rstrip("/") != PERSONAL_ENDPOINTS["google"]:
        settings["store"] = False
    if effort:
        settings["reasoning"] = {"effort": effort}
    if not profile.thinking and profile.protocol == "chat_completions":
        # The model's own "do not think" switch: the chat-template switch Qwen-style models read, or the
        # DeepSeek API's thinking field (which ignores the chat template). Opt-in per profile: an endpoint
        # that does not know the field may reject it.
        settings["extra_body"] = ({"thinking": {"type": "disabled"}} if profile.provider == "deepseek"
                                  else {"chat_template_kwargs": {"enable_thinking": False}})

    client = None
    http_client = None

    async def _run() -> AsyncIterator[dict]:
        nonlocal client, http_client
        if cancel_event.is_set():
            yield {"type": "cancelled"}
            return
        # A Bedrock profile is served by the Converse bridge transport: the SDK keeps its
        # OpenAI-compatible request and the observation hooks see the bridged stream.
        bridge = None
        if profile.provider == "bedrock":
            def report(fact: dict) -> None:
                # A fallback to the model's other profile, or a failure by AWS error type: content-free, for the log only.
                line = bedrock_fact_line("awwo-openai-agents-python-worker", request.run_id, fact)
                if line:
                    print(line, file=sys.stderr, flush=True)

            # A stream that sends nothing for 15 minutes (3 for a call to Claude Opus 4.8 or Opus 5.5 that offers no tools;
            # Opus 5.5 is asked to stream its thinking) fails as the service's outage instead of riding out the run.
            bridge = BedrockConverseTransport(region=profile.region, model=profile.model,
                                              auth={"bearer_token": profile.api_key} if profile.api_key else {"aws": True},
                                              read_timeout=stream_read_timeout(config.timeout_ms / 1000), prompt_cache=profile.prompt_cache,
                                              fallback_model=profile.fallback_model, report=report)
        # A DeepSeek call follows no redirect: the API has one address, and the profile may reach only that one.
        http_client = DefaultAsyncHttpxClient(event_hooks={
            "request": [observation.on_request], "response": [observation.on_response],
        }, **({"transport": bridge} if bridge else {}), **({"follow_redirects": False} if profile.provider == "deepseek" else {}))
        # The SDK's own 600 s default would cut a call short of the run's deadline (the Bedrock bridge keeps its own read
        # timeout, the stream's idle limit above).
        client = AsyncOpenAI(base_url=profile.base_url, api_key=BRIDGE_API_KEY if bridge else profile.api_key, max_retries=0, http_client=http_client,
                             timeout=Timeout(config.timeout_ms / 1000, connect=5.0))
        tools = _build_tools(request, config)
        agent = Agent(
            name="awwo",
            instructions=request.system_prompt or "",
            model=(_CheckedResponsesModel if profile.protocol == "responses" else _CheckedChatModel)(
                model=profile.model, openai_client=client, observation=observation,
            ),
            tools=tools,
            # Match the existing JS worker and its advertised single-call contract.
            tool_use_behavior="stop_on_first_tool",
            model_settings=ModelSettings(**settings),
        )
        result = Runner.run_streamed(
            agent, input_messages, max_turns=1,
            run_config=RunConfig(tracing_disabled=True, trace_include_sensitive_data=False),
        )
        async def watch_cancel():
            await cancel_event.wait()
            result.cancel(mode="immediate")

        watcher = asyncio.create_task(watch_cancel())
        streamed = ""
        reasoning = ReasoningCounter()
        try:
            async for event in result.stream_events():
                if getattr(event, "type", None) != "raw_response_event":
                    continue
                data = getattr(event, "data", None)
                kind = getattr(data, "type", None)
                if kind == "response.output_text.delta":
                    delta = getattr(data, "delta", "")
                    if delta and not tools:
                        # The settled reasoning count goes out before the answer it preceded.
                        report = reasoning.report(force=True)
                        if report:
                            yield report
                        streamed += delta
                        if len(streamed.encode("utf-8")) > config.max_output_bytes:
                            raise RuntimeError("OUTPUT_LIMIT")
                        yield {"type": "text_delta", "delta": delta}
                elif kind in REASONING_DELTA_EVENTS:
                    delta = getattr(data, "delta", "")
                    if isinstance(delta, str) and delta:
                        reasoning.add(delta)
                        report = reasoning.report(force=False)
                        if report:
                            yield report
                elif kind == "response.output_item.added" and getattr(getattr(data, "item", None), "type", None) == "reasoning":
                    # That reasoning began is itself the fact a waiting reader lacks, so it is
                    # reported at once, before anything is counted.
                    reasoning.start()
                    report = reasoning.report(force=True)
                    if report:
                        yield report
            if cancel_event.is_set():
                yield {"type": "cancelled"}
                return
            observation.require_complete()
            final = result.final_output_as(str)
            if not isinstance(final, str) or not final.strip() or not final.startswith(streamed):
                raise RuntimeError("MODEL_PROTOCOL_ERROR")
            if len(final.encode("utf-8")) > config.max_output_bytes:
                raise RuntimeError("OUTPUT_LIMIT")
            if len(final) > len(streamed):
                yield {"type": "text_delta", "delta": final[len(streamed):]}
            yield {"type": "completed", "text": final, "model": profile.model}
        finally:
            result.cancel(mode="immediate")
            watcher.cancel()
            with suppress(asyncio.CancelledError):
                await watcher

    try:
        async with asyncio.timeout(config.timeout_ms / 1000):
            async for event in _run():
                if event["type"] == "text_delta" and observation.first_delta is None:
                    observation.first_delta = observation.clock()
                if event["type"] in ("completed", "failed", "cancelled"):
                    event = {**event, "observability": observation.snapshot(event["type"])}
                yield event
    except TimeoutError:
        event = {"type": "cancelled"} if cancel_event.is_set() else classify_error(RuntimeError("DEADLINE_EXCEEDED"))
        yield {**event, "observability": observation.snapshot(event["type"])}
        return
    except asyncio.CancelledError:
        yield {"type": "cancelled", "observability": observation.snapshot("cancelled")}
        return
    except Exception as e:  # noqa: BLE001 - boundary: map everything to a wire failure
        event = {"type": "cancelled"} if cancel_event.is_set() else classify_error(RuntimeError(observation.failure) if observation.failure else e)
        yield {**event, "observability": observation.snapshot(event["type"])}
    finally:
        if client is not None:
            await client.close()
        if http_client is not None and not http_client.is_closed:
            await http_client.aclose()
