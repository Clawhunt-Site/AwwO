"""Run one agent task with the openai-agents Python SDK, streaming text deltas."""

import asyncio
import json
from contextlib import suppress
from dataclasses import dataclass
from typing import AsyncIterator

from agents import Agent, FunctionTool, ModelSettings, OpenAIChatCompletionsModel, OpenAIResponsesModel, RunConfig, Runner
from openai import AsyncOpenAI

from config import Config, ModelProfile, authorize_effort, fits_context_budget, resolve_model_config
from errors import RuntimeError, classify_error
from tools import TOOL_SCHEMAS, ToolInputError, execute_tool, tool_definition_bytes, validate_tool_names


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


def validate_request(value: dict, config: Config) -> RunRequest:
    allowed = {"runId", "tenantId", "sessionId", "prompt", "messages", "systemPrompt", "model", "runtime", "tools", "effort"}
    if not isinstance(value, dict) or any(key not in allowed for key in value):
        raise ValueError("Invalid request fields")
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
    text_bytes = len(request.prompt.encode("utf-8")) + len((request.system_prompt or "").encode("utf-8"))
    for message in request.messages:
        text_bytes += len(message["content"].encode("utf-8"))
    if not fits_context_budget(text_bytes, tool_definition_bytes(request.tools or []), len(request.messages), profile):
        raise ValueError("Conversation is too large")
    return profile, effort


async def stream_run(request: RunRequest, config: Config, cancel_event: asyncio.Event) -> AsyncIterator[dict]:
    """Yield wire events: {"type":"text_delta","delta":...} then a terminal event."""
    try:
        profile, effort = _prepare(request, config)
    except ValueError as e:
        yield classify_error(RuntimeError("OUTPUT_LIMIT" if "too large" in str(e) else "MODEL_REQUEST_REJECTED"))
        return

    input_messages = [{"role": m["role"], "content": m["content"]} for m in request.messages]
    if input_messages:
        input_messages.append({"role": "user", "content": request.prompt})
    else:
        input_messages = [{"role": "user", "content": request.prompt}]

    settings = {"max_tokens": profile.max_tokens, "store": False, "parallel_tool_calls": False}
    if effort:
        settings["reasoning"] = {"effort": effort}

    client = None

    async def _run() -> AsyncIterator[dict]:
        nonlocal client
        if cancel_event.is_set():
            yield {"type": "cancelled"}
            return
        client = AsyncOpenAI(base_url=profile.base_url, api_key=profile.api_key, max_retries=0)
        tools = _build_tools(request, config)
        agent = Agent(
            name="awwo",
            instructions=request.system_prompt or "",
            model=(OpenAIResponsesModel if profile.protocol == "responses" else OpenAIChatCompletionsModel)(
                model=profile.model, openai_client=client,
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
        try:
            async for event in result.stream_events():
                if getattr(event, "type", None) == "raw_response_event":
                    data = getattr(event, "data", None)
                    if getattr(data, "type", None) == "response.output_text.delta":
                        delta = getattr(data, "delta", "")
                        if delta and not tools:
                            streamed += delta
                            if len(streamed.encode("utf-8")) > config.max_output_bytes:
                                raise RuntimeError("OUTPUT_LIMIT")
                            yield {"type": "text_delta", "delta": delta}
            if cancel_event.is_set():
                yield {"type": "cancelled"}
                return
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
                yield event
    except TimeoutError:
        yield classify_error(RuntimeError("DEADLINE_EXCEEDED"))
        return
    except asyncio.CancelledError:
        yield {"type": "cancelled"}
        return
    except Exception as e:  # noqa: BLE001 - boundary: map everything to a wire failure
        yield classify_error(e)
    finally:
        if client is not None:
            await client.close()
