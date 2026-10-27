"""Amazon Bedrock Converse behind the OpenAI Chat Completions wire format.

The Python counterpart of apps/bedrock-bridge.ts (see that file for the rationale):
an httpx2 transport that answers exactly the request the OpenAI SDK sends to
``<bridge base URL>/chat/completions`` by calling ConverseStream once, and streams
the answer back as ``chat.completion.chunk`` SSE. The Agents SDK, the provider
observation and the reasoning counter therefore see one more OpenAI-compatible
endpoint.

Nothing is invented: content the bridge cannot map faithfully is refused with a
400, and a stream that ends without a stop reason, or carries an event or content type
the bridge does not know, is an error. The deliberate adaptations (an empty tool result
sent as "(empty result)", ``parallel_tool_calls: false`` enforced by relaying only the
first tool call of a turn, request metadata without a Converse counterpart, a user turn's
base64 pictures sent as Converse image blocks without their ``detail`` hint) are the same
as the TypeScript bridge's and are listed in docs/awwo-bedrock.md.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import json
import re
import threading
import time
import uuid
from typing import Any, Callable

from httpx2 import AsyncBaseTransport, AsyncByteStream, Request, Response

from context_overflow import context_overflow

BEDROCK_REGIONS = (
    "us-east-1", "us-east-2", "us-west-2", "ca-central-1", "sa-east-1",
    "eu-central-1", "eu-west-1", "eu-west-2", "eu-west-3", "eu-north-1", "eu-south-1",
    "ap-northeast-1", "ap-northeast-2", "ap-south-1", "ap-southeast-1", "ap-southeast-2",
)
BRIDGE_PATH = "/awwo-bedrock-converse/v1"
# The OpenAI SDK requires an API key string; the bridge ignores the header it produces.
BRIDGE_API_KEY = "awwo-bedrock-bridge"
# Six pictures of 3.75 MiB are 31.5 MB as base64; the rest is room for the largest text the worker accepts.
MAX_REQUEST_BYTES = 40 * 1024 * 1024
# How long a Bedrock stream may send nothing (BEDROCK_STREAM_IDLE_MS in apps/bedrock-bridge.ts). Claude Opus 5.5 thinks
# before its first word and Bedrock sends nothing until it is done, so a working stream is silent for minutes: of the
# 3,384 Opus 5.5 calls that completed on the three workers from 2026-10-12 to 10-19, the longest wait for the first token
# was 436 s (99th percentile 230-296 s), none over 600 s. Some silent far longer had stalled: on 2026-10-19 five Opus 5.5
# calls gave nothing back for their runs' whole 25 minutes, and the same nodes, run again, answered in 64-164 s.
BEDROCK_STREAM_IDLE_SECONDS = 15 * 60
# Models that think before every answer (Bedrock refuses to turn it off, commit 7b495004) and stream their thinking only
# when asked, by Converse model ID without its inference profile's prefix. As Bedrock calls them by default (adaptive
# thinking, display "omitted") it sends nothing at all, not even messageStart, until the thinking ends, and since the
# move to UCloud a stream silent for more than about 6 minutes has not been delivered: on 2026-10-21 Bedrock's records
# showed it had run 11 calls of this worker to their 64,000-token cap in 559-647 s whose answers never arrived (the
# sandbox worker lost 3 it finished in 435-457 s; fully silent streams of up to 360.6 s were delivered).
THINKS_SILENTLY = frozenset({"anthropic.claude-opus-5-5"})
# Those asked to stream a summary of their thinking, which they then do from the start: in 14 probe calls to Claude
# Opus 5.5 on 2026-10-21, the first reasoning text came 3.7-8.6 s into a call (8.6 s with a 110,668-token input) and no
# call was ever silent for more than 6.5 s, also two that thought for 3.2 and 3.5 minutes (1,825 and 1,953 reasoning
# deltas) on a question that, asked without the summary, sent nothing for 192.5 s; calls of the same question took about
# as long as without it. The summary crosses the worker only as a count (runner.ReasoningCounter). A model taken out of
# this set is asked as before, and THINKS_SILENTLY keeps it waiting the idle limit.
SUMMARIZED_THINKING_MODELS = frozenset({"anthropic.claude-opus-5-5"})
SUMMARIZED_THINKING = {"type": "adaptive", "display": "summarized"}
# The thinking efforts a catalog entry may offer for a Claude model (BEDROCK_REASONING_EFFORTS in apps/bedrock-bridge.ts):
# a request's reasoning_effort that its profile offers goes to Bedrock as Claude's output_config.effort. Claude Opus 5.5
# also takes xhigh and max, which think more within the same output limit; this worker's request check (EFFORT_LEVELS
# in config.py) takes these three. Bedrock refuses any other value (minimal and none, probed on 2026-10-26).
REASONING_EFFORTS = ("low", "medium", "high")
# A Claude model's Converse ID, with or without an inference profile's prefix: the only models output_config is for.
CLAUDE_MODEL = re.compile(r"(?:(?:global|us|eu|apac|jp|au|ca)\.)?anthropic\.")
# The same limit, for a call that offers the model no tools, on a model whose calls were never seen silent for long: its
# answer is text, which Bedrock streams as it is written. Only models measured so are here, by Converse model ID without
# its inference profile's prefix; the limit is an empirical bound, not a guarantee. Claude Opus 4.8 was never seen to
# think silently: none of the 5,341 of its calls that completed on the Python and sandbox workers from 2026-10-12 to 10-21
# took 3 minutes in all (the longest 123.5 s, the longest wait for the first text 48.8 s), so no gap in one was that
# long; on 10-20 two of its canvas node calls on this worker waited the whole 15 minutes for nothing before their nodes
# ran again (graph_retry.go runs a node again only once its call has failed) and answered in 32 and 34 s. Claude Opus 5.5
# (THINKS_SILENTLY) waits it only in a call that asks for its thinking summarized: asked otherwise it sends nothing until
# its thinking ends, which can take its whole 64,000-token limit, 11 minutes or more, so a silent call may still be
# working. A call that offers tools keeps the idle limit whatever the model: Bedrock holds a tool call's input back until
# the model has written it.
QUICK_FIRST_BYTE_SECONDS = {"anthropic.claude-opus-4-8": 3 * 60, "anthropic.claude-opus-5-5": 3 * 60}
# An inference profile's prefix on a Converse model ID (as bedrock_catalog.PROFILE_PREFIX).
PROFILE_PREFIX = re.compile(r"(?:global|us|eu|apac|jp|au|ca)\.")
TOOL_NAME = re.compile(r"[A-Za-z][A-Za-z0-9_-]{0,63}")
TOOL_USE_ID = re.compile(r"[A-Za-z0-9_-]{1,128}")
BEARER = re.compile(r"[\x21-\x7e]{16,8192}")

REQUEST_FIELDS = {
    "model", "messages", "tools", "tool_choice", "parallel_tool_calls", "temperature", "top_p",
    "max_tokens", "max_completion_tokens", "stream", "stream_options", "stop", "store", "user", "metadata",
    "n", "seed", "prompt_cache_key", "safety_identifier", "reasoning_effort", "response_format",
    "frequency_penalty", "presence_penalty", "logprobs", "top_logprobs",
}
STOP_REASONS = {
    "end_turn": "stop", "stop_sequence": "stop", "tool_use": "tool_calls",
    "max_tokens": "length", "model_context_window_exceeded": "length",
    "content_filtered": "content_filter", "guardrail_intervened": "content_filter",
}
STREAM_EXCEPTIONS = {
    "internalServerException": 500, "modelStreamErrorException": 502, "validationException": 400,
    "throttlingException": 429, "serviceUnavailableException": 503,
}
# botocore raises these before any request when the worker has no usable AWS credentials.
CREDENTIAL_ERRORS = {
    "NoCredentialsError", "PartialCredentialsError", "CredentialRetrievalError", "NoAuthTokenError",
    "TokenRetrievalError", "UnauthorizedSSOTokenError", "SSOTokenLoadError",
}
REASONING_MEMBERS = {"text", "signature", "redactedContent"}
SDK_STATUS = {
    "AccessDeniedException": 403, "UnrecognizedClientException": 401, "ExpiredTokenException": 401,
    "ValidationException": 400, "ResourceNotFoundException": 404, "ThrottlingException": 429,
    "ServiceQuotaExceededException": 429, "ModelTimeoutException": 408, "ModelNotReadyException": 503,
    "ServiceUnavailableException": 503, "InternalServerException": 500, "ModelErrorException": 502,
    "ModelStreamErrorException": 502,
}
_SDK_NAMES = {name.lower(): name for name in SDK_STATUS}


# The type and message of a request AWS refused as larger than its model's window (bridge_failure): the label an
# OpenAI-compatible provider gives it, and words the worker's reading of a refusal knows (context_overflow.py).
BEDROCK_CONTEXT_LIMIT_TYPE = "context_length_exceeded"
BEDROCK_CONTEXT_LIMIT_MESSAGE = "Input is too long for requested model"
# The type of a failure on the way to AWS that AWS never reported (bridge_failure): no answer of AWS's (botocore's
# ClientError) and no HTTP status, such as a connection reset or a stream cut off or unreadable partway. Its body carries no status (_error_body), so a
# stream lost this way after it began is not reported as the provider's outage, which a call refused at once is not
# billed for (plans.go refusedBeforeOutput): AWS may already have done, and billed, the work. As
# BEDROCK_CONNECTION_FAILURE in apps/bedrock-bridge.ts.
BEDROCK_CONNECTION_FAILURE = "connection_error"


class BridgeError(Exception):
    def __init__(self, status: int, kind: str, message: str, upstream: bool = False):
        super().__init__(message)
        self.status = status
        self.kind = kind
        self.message = message
        # True for AWS's answer or the way to it (the connection, the credentials); the bridge's own refusals are not
        # provider outages.
        self.upstream = upstream


def _reject(message: str):
    raise BridgeError(400, "invalid_request_error", message)


def _unrelayable() -> BridgeError:
    return BridgeError(502, "api_error", "Bedrock returned content the bridge cannot relay")


def _union_member(value: dict) -> str:
    """The one member a Converse union carries, "" for an empty union; more than one is malformed."""
    members = [key for key, item in value.items() if item is not None]
    if len(members) > 1:
        raise BridgeError(502, "api_error", "Unexpected Bedrock stream event")
    return members[0] if members else ""


def _no_constant(name: str):
    # JSON.parse in the TypeScript bridge accepts no NaN or Infinity; neither does this one.
    raise ValueError(name)


def valid_region(region: object) -> bool:
    return isinstance(region, str) and region in BEDROCK_REGIONS


def bedrock_origin(region: str) -> str:
    if not valid_region(region):
        raise ValueError("Unsupported Bedrock region")
    return f"https://bedrock-runtime.{region}.amazonaws.com"


def bridge_base_url(region: str) -> str:
    return bedrock_origin(region) + BRIDGE_PATH


def _message_text(content: Any, role: str) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        _reject(f"Unsupported {role} message content")
    parts = []
    for part in content:
        if not isinstance(part, dict) or part.get("type") not in ("text", "input_text", "output_text") or not isinstance(part.get("text"), str):
            _reject(f"Only text content is supported in {role} messages")
        parts.append(part["text"])
    return "".join(parts)


def _text_block(text: str) -> list:
    # Converse rejects blank text blocks; an empty turn contributes nothing.
    return [{"text": text}] if text.strip() else []


# A picture the worker sends in a user turn (vision): a data: URL of a Converse image format, decoded here. Bedrock
# takes at most 20 per request and 3.75 MB each; a remote URL is never fetched. botocore does not check the format.
IMAGE_DATA_URL = re.compile(r"data:image/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})")
MAX_IMAGE_BYTES = 3_932_160
MAX_IMAGES = 20


def _image_block(part: dict) -> dict:
    image = part.get("image_url")
    if set(part) - {"type", "image_url"} or not isinstance(image, dict) or set(image) - {"url", "detail"} \
            or image.get("detail", "auto") not in ("auto", "low", "high"):
        _reject("Invalid image content")
    match = IMAGE_DATA_URL.fullmatch(image["url"]) if isinstance(image.get("url"), str) else None
    if not match or len(match.group(2)) % 4:
        _reject("Only PNG, JPEG, GIF or WebP images sent as base64 data URLs are supported")
    try:
        raw = base64.b64decode(match.group(2), validate=True)
    except (binascii.Error, ValueError):
        _reject("Only PNG, JPEG, GIF or WebP images sent as base64 data URLs are supported")
    if not 1 <= len(raw) <= MAX_IMAGE_BYTES:
        _reject("An image is empty or larger than 3.75 MiB")
    # `detail` has no Converse counterpart: the model reads the picture as it is (docs/awwo-bedrock.md).
    return {"image": {"format": match.group(1), "source": {"bytes": raw}}}


def _user_blocks(content: Any, images: list) -> list:
    """A user turn's blocks: its text (adjacent text parts joined, as before) and its pictures, in order."""
    if not isinstance(content, list) or not any(isinstance(p, dict) and p.get("type") == "image_url" for p in content):
        return _text_block(_message_text(content, "user"))
    blocks: list = []
    text = ""
    for part in content:
        if isinstance(part, dict) and part.get("type") == "image_url":
            blocks.extend(_text_block(text))
            text = ""
            images.append(None)
            if len(images) > MAX_IMAGES:
                _reject(f"At most {MAX_IMAGES} images are supported in one request")
            blocks.append(_image_block(part))
        else:
            text += _message_text([part], "user")
    blocks.extend(_text_block(text))
    return blocks


def _tool_use_block(call: Any) -> dict:
    if (not isinstance(call, dict) or call.get("type") != "function" or not isinstance(call.get("function"), dict)
            or not isinstance(call.get("id"), str) or not TOOL_USE_ID.fullmatch(call["id"])
            or not isinstance(call["function"].get("name"), str) or not TOOL_NAME.fullmatch(call["function"]["name"])):
        _reject("Invalid assistant tool call")
    raw = call["function"].get("arguments", "")
    value: Any = {}
    # The wire format carries arguments as a JSON string; an absent or empty one is a call without arguments.
    if isinstance(raw, str) and raw.strip():
        try:
            value = json.loads(raw, parse_constant=_no_constant)
        except ValueError:
            _reject("Assistant tool call arguments are not JSON")
    elif raw != "":
        _reject("Assistant tool call arguments must be a JSON string")
    if not isinstance(value, dict):
        _reject("Assistant tool call arguments must be a JSON object")
    return {"toolUse": {"toolUseId": call["id"], "name": call["function"]["name"], "input": value}}


def _number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def valid_reasoning_efforts(value: Any) -> bool:
    """True for a list of distinct REASONING_EFFORTS (an empty one offers none)."""
    return (isinstance(value, (list, tuple)) and all(isinstance(level, str) and level in REASONING_EFFORTS for level in value)
            and len(set(value)) == len(value))


def to_converse_input(body: Any, model_id: str, efforts: tuple = ()) -> dict:
    """Translate a Chat Completions request body into ConverseStream input. `efforts` are the thinking efforts the profile
    offers (valid_reasoning_efforts): a reasoning_effort must be one of them and is sent as output_config.effort; with none
    offered, any is refused."""
    if not isinstance(body, dict):
        _reject("The request body must be a JSON object")
    for key in body:
        if key not in REQUEST_FIELDS:
            _reject(f"Unsupported request field: {key}")
    if body.get("model") != model_id:
        _reject("The request model does not match the configured Bedrock model")
    if body.get("stream") is not True:
        _reject("Only streaming requests are supported")
    if "n" in body and body["n"] != 1:
        _reject("Only one choice is supported")
    effort = body.get("reasoning_effort")
    if effort is not None and (not isinstance(effort, str) or effort not in efforts):
        _reject("This Bedrock model does not offer that reasoning effort" if efforts else "Reasoning effort is not supported for this Bedrock model")
    for key in ("frequency_penalty", "presence_penalty"):
        if body.get(key) not in (None, 0, 0.0):
            _reject(f"{key} is not supported by Bedrock Converse")
    if body.get("logprobs") is True or body.get("top_logprobs") is not None:
        _reject("Log probabilities are not supported")
    if body.get("seed") is not None:
        _reject("seed is not supported by Bedrock Converse")
    fmt = body.get("response_format")
    if fmt is not None and not (isinstance(fmt, dict) and fmt.get("type") == "text"):
        _reject("Structured response formats are not supported for this Bedrock model")
    # true (or absent) relays every tool call the model makes; false is enforced by the chunk mapper.
    if body.get("parallel_tool_calls") is not None and not isinstance(body["parallel_tool_calls"], bool):
        _reject("Invalid parallel_tool_calls")
    messages_in = body.get("messages")
    if not isinstance(messages_in, list) or not messages_in:
        _reject("At least one message is required")

    system: list = []
    messages: list = []

    def push(role: str, blocks: list):
        if not blocks:
            return
        # Converse requires alternating roles; adjacent turns of one role are one message.
        if messages and messages[-1]["role"] == role:
            messages[-1]["content"].extend(blocks)
        else:
            messages.append({"role": role, "content": list(blocks)})

    tool_blocks = False
    images: list = []
    for message in messages_in:
        if not isinstance(message, dict) or not isinstance(message.get("role"), str):
            _reject("Invalid message")
        role = message["role"]
        if role in ("system", "developer"):
            system.extend(_text_block(_message_text(message.get("content"), "system")))
        elif role == "user":
            push("user", _user_blocks(message.get("content"), images))
        elif role == "assistant":
            if message.get("refusal") is not None:
                _reject("Assistant refusals cannot be replayed")
            blocks = _text_block(_message_text(message.get("content"), "assistant"))
            calls = message.get("tool_calls")
            if calls is not None:
                if not isinstance(calls, list):
                    _reject("Invalid assistant tool calls")
                for call in calls:
                    blocks.append(_tool_use_block(call))
                    tool_blocks = True
            push("assistant", blocks)
        elif role == "tool":
            call_id = message.get("tool_call_id")
            if not isinstance(call_id, str) or not TOOL_USE_ID.fullmatch(call_id):
                _reject("Invalid tool result")
            text = _message_text(message.get("content"), "tool")
            push("user", [{"toolResult": {"toolUseId": call_id, "content": [{"text": text or "(empty result)"}]}}])
            tool_blocks = True
        else:
            _reject("Unsupported message role")
    # Nothing is fabricated to make a request fit: such a request is refused.
    if not messages or messages[0]["role"] != "user":
        _reject("The conversation must start with a user message")
    if messages[-1]["role"] != "user":
        _reject("The conversation must end with a user message")

    result: dict = {"modelId": model_id, "messages": messages}
    if system:
        result["system"] = system
    inference: dict = {}
    max_tokens = body.get("max_completion_tokens", body.get("max_tokens"))
    if max_tokens is not None:
        if not isinstance(max_tokens, int) or isinstance(max_tokens, bool) or max_tokens < 1:
            _reject("Invalid max tokens")
        inference["maxTokens"] = max_tokens
    for source, target in (("temperature", "temperature"), ("top_p", "topP")):
        value = body.get(source)
        if value is None:
            continue
        if not _number(value) or not 0 <= value <= 2:
            _reject(f"Invalid {source}")
        inference[target] = value
    stop = body.get("stop")
    if stop is not None:
        stops = [stop] if isinstance(stop, str) else stop
        if not isinstance(stops, list) or len(stops) > 4 or any(not isinstance(item, str) or not item for item in stops):
            _reject("Invalid stop sequences")
        inference["stopSequences"] = stops
    if inference:
        result["inferenceConfig"] = inference

    tools = body.get("tools") or []
    if not isinstance(tools, list) or len(tools) > 128:
        _reject("Invalid tools")
    specs = []
    for tool in tools:
        fn = tool.get("function") if isinstance(tool, dict) else None
        if (not isinstance(tool, dict) or tool.get("type") != "function" or not isinstance(fn, dict)
                or not isinstance(fn.get("name"), str) or not TOOL_NAME.fullmatch(fn["name"])):
            _reject("Invalid tool definition")
        parameters = fn.get("parameters") if fn.get("parameters") is not None else {"type": "object", "properties": {}}
        if not isinstance(parameters, dict):
            _reject("Invalid tool parameters")
        spec = {"name": fn["name"], "inputSchema": {"json": parameters}}
        if isinstance(fn.get("description"), str) and fn["description"]:
            spec = {"name": fn["name"], "description": fn["description"], "inputSchema": {"json": parameters}}
        specs.append({"toolSpec": spec})
    choice = body.get("tool_choice")
    if choice == "none":
        # Converse has no "none"; it can only be honoured by not offering tools at all.
        if tool_blocks:
            _reject('tool_choice "none" cannot be combined with tool history')
    elif specs:
        tool_config: dict = {"tools": specs}
        if choice == "required":
            tool_config["toolChoice"] = {"any": {}}
        elif isinstance(choice, dict) and choice.get("type") == "function" and isinstance(choice.get("function"), dict) and isinstance(choice["function"].get("name"), str):
            if not any(spec["toolSpec"]["name"] == choice["function"]["name"] for spec in specs):
                _reject("tool_choice names an unknown tool")
            tool_config["toolChoice"] = {"tool": {"name": choice["function"]["name"]}}
        elif choice not in (None, "auto"):
            _reject("Unsupported tool_choice")
        result["toolConfig"] = tool_config
    elif choice not in (None, "auto"):
        _reject("tool_choice requires tools")
    if tool_blocks and "toolConfig" not in result:
        _reject("Tool history requires tool definitions")
    if effort is not None:
        result["additionalModelRequestFields"] = {"output_config": {"effort": effort}}
    return result


def with_claude_prompt_cache(command: dict) -> dict:
    """Claude explicit prompt caching for one Converse command (see withClaudePromptCache in
    apps/bedrock-bridge.ts). Only a request that re-sends an earlier exchange, a conversation with
    history or a tool loop, gets checkpoints: after the tool definitions, after the system prompt
    and at the end of the last message. A single-message request is returned unchanged."""
    messages = command.get("messages")
    if not isinstance(messages, list) or len(messages) < 2:
        return command

    def point() -> dict:
        return {"cachePoint": {"type": "default"}}

    out = dict(command)
    tool_config = command.get("toolConfig")
    if isinstance(tool_config, dict) and isinstance(tool_config.get("tools"), list) and tool_config["tools"]:
        out["toolConfig"] = {**tool_config, "tools": [*tool_config["tools"], point()]}
    system = command.get("system")
    if isinstance(system, list) and system:
        out["system"] = [*system, point()]
    last = messages[-1]
    out["messages"] = [*messages[:-1], {**last, "content": [*last["content"], point()]}]
    return out


def _non_negative(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def chat_usage(usage: Any) -> dict | None:
    """Converse usage to Chat Completions usage; cache reads are a subset of prompt tokens."""
    if not isinstance(usage, dict) or not _non_negative(usage.get("inputTokens")) or not _non_negative(usage.get("outputTokens")):
        return None
    read = usage.get("cacheReadInputTokens") if _non_negative(usage.get("cacheReadInputTokens")) else 0
    write = usage.get("cacheWriteInputTokens") if _non_negative(usage.get("cacheWriteInputTokens")) else 0
    result = {"prompt_tokens": usage["inputTokens"] + read + write, "completion_tokens": usage["outputTokens"]}
    if _non_negative(usage.get("cacheReadInputTokens")):
        result["prompt_tokens_details"] = {"cached_tokens": usage["cacheReadInputTokens"]}
    return result


class ChunkMapper:
    """Maps one Converse stream into Chat Completions chunk payloads.

    With ``single_tool_call`` (the request set ``parallel_tool_calls: false``) the turn ends with
    its first complete tool call: later tool calls are neither relayed nor executed and never
    enter the conversation. Usage still covers the whole turn.
    """

    def __init__(self, model: str, *, chunk_id: str | None = None, created: int | None = None, single_tool_call: bool = False):
        self.model = model
        self.id = chunk_id or f"chatcmpl-bedrock-{uuid.uuid4()}"
        self.created = int(time.time()) if created is None else created
        self.single_tool_call = single_tool_call
        self.tool_index = -1
        self.tool_open = False
        self.tool_dropped = False
        self.finish_reason: str | None = None
        self.done = False

    def _chunk(self, delta: dict, finish: str | None = None) -> dict:
        return {"id": self.id, "object": "chat.completion.chunk", "created": self.created, "model": self.model,
                "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}

    def map(self, event: Any) -> list:
        if self.done or not isinstance(event, dict):
            raise BridgeError(502, "api_error", "Unexpected Bedrock stream event")
        keys = [key for key, value in event.items() if value is not None]
        if len(keys) != 1:
            raise BridgeError(502, "api_error", "Unexpected Bedrock stream event")
        key = keys[0]
        value = event[key]
        if key in STREAM_EXCEPTIONS:
            raise BridgeError(STREAM_EXCEPTIONS[key], key, "The Bedrock stream reported an error", upstream=True)
        if not isinstance(value, dict):
            raise BridgeError(502, "api_error", "Unexpected Bedrock stream event")
        if key == "messageStart":
            return [self._chunk({"role": "assistant", "content": ""})]
        if key == "contentBlockStart":
            start = {} if value.get("start") is None else value["start"]
            if not isinstance(start, dict):
                raise _unrelayable()
            member = _union_member(start)
            # Text and reasoning blocks may open without a start member; only tool calls carry one.
            if member == "":
                return []
            tool = start[member]
            if member != "toolUse" or not isinstance(tool, dict):
                raise _unrelayable()
            if (not isinstance(tool.get("toolUseId"), str) or not TOOL_USE_ID.fullmatch(tool["toolUseId"])
                    or not isinstance(tool.get("name"), str) or not TOOL_NAME.fullmatch(tool["name"])):
                raise BridgeError(502, "api_error", "Bedrock returned an invalid tool call")
            self.tool_open = True
            self.tool_dropped = self.single_tool_call and self.tool_index >= 0
            if self.tool_dropped:
                return []
            self.tool_index += 1
            return [self._chunk({"tool_calls": [{"index": self.tool_index, "id": tool["toolUseId"], "type": "function",
                                                 "function": {"name": tool["name"], "arguments": ""}}]})]
        if key == "contentBlockDelta":
            delta = {} if value.get("delta") is None else value["delta"]
            if not isinstance(delta, dict):
                raise _unrelayable()
            member = _union_member(delta)
            if member == "":
                return []
            if member == "text":
                if not isinstance(delta["text"], str):
                    raise _unrelayable()
                return [self._chunk({"content": delta["text"]})] if delta["text"] else []
            if member == "toolUse":
                piece = delta["toolUse"].get("input") if isinstance(delta["toolUse"], dict) else None
                if not self.tool_open or not isinstance(piece, str):
                    raise BridgeError(502, "api_error", "Bedrock returned tool input outside a tool call")
                if not piece or self.tool_dropped:
                    return []
                return [self._chunk({"tool_calls": [{"index": self.tool_index, "function": {"arguments": piece}}]})]
            if member == "reasoningContent":
                # Reasoning is relayed only as text the worker counts; signatures and redacted
                # blocks carry nothing a reader may see and are dropped.
                reasoning = delta["reasoningContent"]
                if not isinstance(reasoning, dict) or (_union_member(reasoning) or "text") not in REASONING_MEMBERS:
                    raise _unrelayable()
                text = reasoning.get("text")
                if text is not None and not isinstance(text, str):
                    raise _unrelayable()
                return [self._chunk({"reasoning_content": text})] if text else []
            # Citations, images and future content types are refused rather than dropped.
            raise _unrelayable()
        if key == "contentBlockStop":
            self.tool_open = False
            self.tool_dropped = False
            return []
        if key == "messageStop":
            reason = value.get("stopReason")
            if reason not in STOP_REASONS:
                raise BridgeError(502, "api_error", "Bedrock ended the response for an unsupported reason")
            self.finish_reason = STOP_REASONS[reason]
            return [self._chunk({}, self.finish_reason)]
        if key == "metadata":
            usage = chat_usage(value.get("usage"))
            if usage is None:
                return []
            return [{"id": self.id, "object": "chat.completion.chunk", "created": self.created, "model": self.model,
                     "choices": [], "usage": usage}]
        # An event this bridge does not know may carry content.
        raise BridgeError(502, "api_error", "Unexpected Bedrock stream event")

    def finish(self) -> None:
        self.done = True
        if not self.finish_reason:
            raise BridgeError(502, "api_error", "The Bedrock stream ended before the response was complete")


# AWS errors that say a profile cannot serve the call at this moment (its capacity, its quotas, a transient fault). The
# model's other inference profile has capacity and quotas of its own and may still serve it. Named as bridge_failure
# names them: the SDK's exception names and the stream's exception members (PROFILE_REFUSALS in apps/bedrock-bridge.ts).
PROFILE_REFUSALS = frozenset({
    "ThrottlingException", "ServiceUnavailableException", "InternalServerException", "ModelNotReadyException",
    "ServiceQuotaExceededException", "throttlingException", "serviceUnavailableException", "internalServerException",
})
FACT_LABEL = re.compile(r"[A-Za-z0-9_.:-]{1,128}")


def _stream_exception(event: Any) -> BridgeError | None:
    """The stream's exception member as ChunkMapper.map would raise it; None for any other event."""
    if not isinstance(event, dict):
        return None
    keys = [key for key, value in event.items() if value is not None]
    if len(keys) == 1 and keys[0] in STREAM_EXCEPTIONS:
        return BridgeError(STREAM_EXCEPTIONS[keys[0]], keys[0], "The Bedrock stream reported an error", upstream=True)
    return None


def bedrock_fact_line(service: str, run_id: Any, fact: Any) -> str | None:
    """One JSON log line for a call's content-free fact (a fallback to the model's other profile, a failure by AWS error
    type; and this worker's own, a change in SummaryWatch), or None for anything else, as bedrockFactLine in
    apps/bedrock-bridge.ts: closed labels and a status only."""
    if not isinstance(fact, dict):
        return None

    def label(value: Any) -> bool:
        return isinstance(value, str) and FACT_LABEL.fullmatch(value) is not None

    run = {"runId": run_id} if isinstance(run_id, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", run_id) else {}
    if fact.get("event") == "fallback" and label(fact.get("from")) and label(fact.get("to")) and label(fact.get("after")):
        return json.dumps({"service": service, **run, "event": "bedrock_profile_fallback", "from": fact["from"], "to": fact["to"],
                           "after": fact["after"]})
    status = fact.get("status")
    if (fact.get("event") == "failed" and label(fact.get("model")) and label(fact.get("error"))
            and isinstance(status, int) and not isinstance(status, bool) and 100 <= status <= 599 and fact.get("stage") in ("request", "stream")
            and isinstance(fact.get("upstream"), bool)):
        return json.dumps({"service": service, **run, "event": "bedrock_call_failed", "model": fact["model"], "error": fact["error"],
                           "status": status, "stage": fact["stage"], "upstream": fact["upstream"]})
    # SummaryWatch: Bedrock stopped (silent) or began again (streams) streaming a model's thinking summary at an effort.
    if (fact.get("event") == "summary_watch" and label(fact.get("model")) and label(fact.get("effort"))
            and fact.get("state") in ("silent", "streams")):
        return json.dumps({"service": service, **run, "event": "bedrock_summary_watch", "model": fact["model"], "effort": fact["effort"],
                           "state": fact["state"]})
    return None


def stream_read_timeout(run_seconds: float) -> float:
    """botocore's read timeout for a call: the stream's idle limit, or the run's own deadline when that comes first."""
    return min(run_seconds, BEDROCK_STREAM_IDLE_SECONDS)


def base_model_id(model_id: str) -> str:
    """A Converse model ID without its inference profile's prefix (global., us., ...)."""
    prefix = PROFILE_PREFIX.match(model_id)
    return model_id[prefix.end():] if prefix else model_id


def with_summarized_thinking(command: dict, model_id: str) -> dict:
    """Asks a model of SUMMARIZED_THINKING_MODELS (`model_id`, the command's) to stream a summary of the thinking it does
    anyway, so that its stream is not silent while it thinks. The effort a request names (output_config,
    to_converse_input) stays beside it (both together answered on both profiles, 2026-10-26). Any other command, and one
    whose model fields already set thinking, is returned unchanged."""
    fields = command.get("additionalModelRequestFields")
    if base_model_id(model_id) not in SUMMARIZED_THINKING_MODELS or (fields is not None and (not isinstance(fields, dict) or "thinking" in fields)):
        return command
    return {**command, "additionalModelRequestFields": {**(fields or {}), "thinking": dict(SUMMARIZED_THINKING)}}


def asks_for_summary(command: dict, model_id: str) -> bool:
    """Whether a ConverseStream command to `model_id` asks a model that thinks silently (THINKS_SILENTLY) for its
    thinking summarized (with_summarized_thinking)."""
    fields = command.get("additionalModelRequestFields")
    return base_model_id(model_id) in THINKS_SILENTLY and isinstance(fields, dict) and fields.get("thinking") == SUMMARIZED_THINKING


def command_effort(command: dict) -> str:
    """The thinking effort a ConverseStream command names (output_config, to_converse_input), or "" for the model's own."""
    fields = command.get("additionalModelRequestFields")
    config = fields.get("output_config") if isinstance(fields, dict) else None
    effort = config.get("effort") if isinstance(config, dict) else None
    return effort if isinstance(effort, str) else ""


class SummaryWatch:
    """Whether Bedrock streams a silent model's thinking summary right now, by model (without its inference profile's
    prefix) and the effort its calls name, as this worker last saw it. A call that asked for the summary and got some in
    time marks it streaming; one that asked, was answered (its stream began) and then got neither summary nor answer
    before its read timeout marks it silent (_SummaryCall). While it is silent, such a call at that model and effort waits
    the stream's idle limit, not its model's QUICK_FIRST_BYTE_SECONDS (call_read_timeout), and the first summary in time
    that any call at that model and effort gets ends that. A call that offers tools waits the idle limit anyway, but its
    stall begins a spell too. A stream lost after its headers looks the same and begins one; a summary that stops partway
    through a call does not.

    2026-10-26 (at the owner's 「Bedrock 不发思考摘要时，Opus 5.5 的调用恢复 15 分钟空闲上限」): from about 16:00Z Bedrock
    sent Claude Opus 5.5's calls nothing while they thought, at the default effort and at low (high was not probed),
    though they asked for the summary; the same calls had streamed it from 9-13 s that afternoon, and it streamed again by
    01:15Z the next day. Every call that thought longer than 3 minutes was cut with nothing (two of four in the 16:00Z
    hour, all three tries of a page node at 17:36Z). A call whose stream never began (Bedrock never answered, the lost
    deliveries of 10-19) says nothing about the summary and leaves the watch as it is. Since the move to UCloud a silent
    stream longer than about 6 minutes has not been delivered (THINKS_SILENTLY), so the idle limit saves the calls that
    think 3 to about 6 minutes; a longer one now fails at 15 minutes, not 3.

    One for the worker's process (SUMMARY_WATCH: its transports are made per run); it starts streaming, as before it."""

    def __init__(self) -> None:
        self._silent: set[tuple[str, str]] = set()
        self._lock = threading.Lock()

    def streams(self, model_id: str, effort: str) -> bool:
        with self._lock:
            return (base_model_id(model_id), effort) not in self._silent

    def saw_summary(self, model_id: str, effort: str) -> bool:
        """Marks it streaming; True when that ends a silent spell."""
        with self._lock:
            key = (base_model_id(model_id), effort)
            if key not in self._silent:
                return False
            self._silent.discard(key)
            return True

    def missed_summary(self, model_id: str, effort: str) -> bool:
        """Marks it silent; True when that begins a silent spell."""
        with self._lock:
            key = (base_model_id(model_id), effort)
            if key in self._silent:
                return False
            self._silent.add(key)
            return True


SUMMARY_WATCH = SummaryWatch()


def call_read_timeout(read_timeout: float, command: dict, model_id: str, watch: SummaryWatch | None = None) -> float:
    """The read timeout of one call (its ConverseStream command, to `model_id`): the transport's, or the model's
    QUICK_FIRST_BYTE_SECONDS when that comes first and the call offers the model no tools (no toolConfig: none were
    given, or tool_choice was "none"); for a model that thinks silently (THINKS_SILENTLY) only while the command asks for
    its thinking summarized, at whatever effort (with low effort a long think still streamed its summary from 12.8 s,
    never silent for longer, 2026-10-26), and while `watch` has not seen Bedrock stop streaming it (SummaryWatch)."""
    model = base_model_id(model_id)
    quick = QUICK_FIRST_BYTE_SECONDS.get(model)
    if quick is None or command.get("toolConfig") is not None:
        return read_timeout
    if model in THINKS_SILENTLY and not asks_for_summary(command, model_id):
        return read_timeout
    if model in THINKS_SILENTLY and watch is not None and not watch.streams(model_id, command_effort(command)):
        return read_timeout
    return min(read_timeout, quick)


def _delta_kind(event: Any) -> str:
    """What a ConverseStream event carries: "summary" (text of the thinking summary, a reasoningContent delta with text),
    "answer" (answer text, or a tool call's start or input: the thinking is over), or "" (anything else, a signature among
    them)."""
    start = event.get("contentBlockStart") if isinstance(event, dict) else None
    if isinstance(start, dict) and isinstance(start.get("start"), dict) and isinstance(start["start"].get("toolUse"), dict):
        return "answer"
    block = event.get("contentBlockDelta") if isinstance(event, dict) else None
    delta = block.get("delta") if isinstance(block, dict) else None
    if not isinstance(delta, dict):
        return ""
    reasoning = delta.get("reasoningContent")
    if isinstance(reasoning, dict) and isinstance(reasoning.get("text"), str) and reasoning["text"] != "":
        return "summary"
    if (isinstance(delta.get("text"), str) and delta["text"] != "") or isinstance(delta.get("toolUse"), dict):
        return "answer"
    return ""


class _SummaryCall:
    """One call's part in its transport's SummaryWatch: a call that asked for the summary tells the watch what it got.

    Only a summary that comes in time ends a spell: a piece after a silence longer than the model's quick limit (a summary
    held back to the end of the thinking) would make the quick limit cut the next call again. And only a call that got
    neither summary nor answer before its read timeout begins one: a stall after the answer began says nothing about the
    summary (Claude review, 2026-10-27)."""

    def __init__(self, watch: SummaryWatch, model_id: str, effort: str, tell: Callable[[dict], None],
                 clock: Callable[[], float] = time.monotonic) -> None:
        self.watch = watch
        self.model = base_model_id(model_id)
        self.effort = effort
        self.tell = tell
        self.clock = clock
        self.quick = QUICK_FIRST_BYTE_SECONDS.get(self.model)
        self.last = clock()
        self.late = False
        self.seen = False
        self.answered = False

    def _told(self, state: str) -> None:
        self.tell({"event": "summary_watch", "model": self.model, "effort": self.effort or "default", "state": state})

    def restart(self) -> None:
        """The call is sent again, to the model's other profile, before anything of the first attempt was relayed: its
        summary is in time from then (Codex review, 2026-10-27). Called from the transport's thread."""
        self.last = self.clock()

    def event(self, event: Any) -> None:
        now = self.clock()
        if self.quick is not None and now - self.last > self.quick:
            self.late = True
        self.last = now
        kind = _delta_kind(event)
        if kind == "answer":
            self.answered = True
        if kind != "summary":
            return
        # Every piece of summary counts, not only a call's first: a concurrent call may begin a spell while this one's
        # summary streams, and this one's next piece ends it (Codex review, 2026-10-27).
        self.seen = True
        if not self.late and self.watch.saw_summary(self.model, self.effort):
            self._told("streams")

    def failure(self, error: BridgeError) -> None:
        # Only a read timeout after the stream began, before any summary or answer: Bedrock answered and then sent no
        # summary while the model thought.
        if (not self.seen and not self.answered and error.kind == "ReadTimeoutError"
                and self.watch.missed_summary(self.model, self.effort)):
            self._told("silent")


def bridge_failure(error: BaseException) -> BridgeError:
    """Status and type only: SDK messages can carry account IDs and role ARNs. A request AWS refused as larger than its
    model's window, read from its message here and only here, is told apart by its type (BEDROCK_CONTEXT_LIMIT_TYPE), as
    apps/bedrock-bridge.ts does."""
    if isinstance(error, BridgeError):
        return error
    if any(cls.__name__ == "ReadTimeoutError" for cls in type(error).__mro__):
        # botocore's read timeout (urllib3's inside a stream): Bedrock sent nothing for the stream's idle limit. The
        # service failed, not the run's deadline (MODEL_STALLED, never DEADLINE_EXCEEDED, errors.stalled): a canvas node
        # whose call stalled before anything streamed runs again (graph_retry.go), and such a call is not charged.
        return BridgeError(504, "ReadTimeoutError", "Bedrock sent nothing for too long", upstream=True)
    if type(error).__name__ in CREDENTIAL_ERRORS:
        # No usable AWS credentials: an authentication failure, like a rejected key.
        return BridgeError(401, "api_error", "The Bedrock request failed", upstream=True)
    code = ""
    status = None
    details: dict = {}
    response = getattr(error, "response", None)
    if isinstance(response, dict):
        details = response.get("Error") if isinstance(response.get("Error"), dict) else {}
        code = details.get("Code") if isinstance(details.get("Code"), str) else ""
        metadata = response.get("ResponseMetadata") if isinstance(response.get("ResponseMetadata"), dict) else {}
        if isinstance(metadata.get("HTTPStatusCode"), int):
            status = metadata["HTTPStatusCode"]
    name = _SDK_NAMES.get(code.lower(), "")
    if name == "ValidationException" and context_overflow(details.get("Message")):
        return BridgeError(400, BEDROCK_CONTEXT_LIMIT_TYPE, BEDROCK_CONTEXT_LIMIT_MESSAGE, upstream=True)
    if name:
        return BridgeError(SDK_STATUS[name], name, "The Bedrock request failed", upstream=True)
    if code in STREAM_EXCEPTIONS:
        return BridgeError(STREAM_EXCEPTIONS[code], code, "The Bedrock request failed", upstream=True)
    if status is not None and 400 <= status <= 599:
        return BridgeError(status, "api_error", "The Bedrock request failed", upstream=True)
    if isinstance(response, dict):
        # An error AWS answered with that the bridge does not know: botocore's ClientError, among them the EventStreamError
        # of an exception the stream reports and the service model lacks, which botocore gives an empty code. AWS's own
        # failure, as before.
        return BridgeError(502, "api_error", "The Bedrock request failed", upstream=True)
    return BridgeError(502, BEDROCK_CONNECTION_FAILURE, "The Bedrock request failed", upstream=True)


def valid_auth(auth: Any) -> bool:
    if not isinstance(auth, dict) or len(auth) != 1:
        return False
    if "bearer_token" in auth:
        return isinstance(auth["bearer_token"], str) and bool(BEARER.fullmatch(auth["bearer_token"]))
    return auth.get("aws") is True


_CLIENTS: dict = {}
_CLIENTS_LOCK = threading.Lock()


def default_client(region: str, auth: dict, read_timeout: float):
    """A boto3 Bedrock runtime client pinned to the region's endpoint, without retries.

    A Bedrock API key is sent as a bearer header on an unsigned request (botocore otherwise
    reads such a key only from the process environment); without one the client signs with
    the worker's AWS credential chain, such as an EC2 instance role, which botocore refreshes.
    Clients are thread-safe and reused per region, key and timeout, so a model call neither
    rebuilds the service model nor fetches credentials again.
    """
    key = (region, auth.get("bearer_token") or "", read_timeout)
    with _CLIENTS_LOCK:
        client = _CLIENTS.get(key)
        if client is None:
            # Built (and so cached) only once credentials resolve; a failure is retried next call.
            client = _CLIENTS[key] = _new_client(region, auth, read_timeout)
    return client


def _new_client(region: str, auth: dict, read_timeout: float):
    import boto3
    from botocore import UNSIGNED
    from botocore.config import Config

    from botocore.exceptions import NoCredentialsError

    # One pool slot per concurrent run the worker admits (AWWO_OPENAI_AGENTS_MAX_CONCURRENCY <= 32).
    options = {"retries": {"total_max_attempts": 1, "mode": "standard"}, "connect_timeout": 10, "read_timeout": read_timeout,
               "max_pool_connections": 32}
    bearer = auth.get("bearer_token")
    session = boto3.session.Session()
    if bearer:
        options["signature_version"] = UNSIGNED
    elif session.get_credentials() is None:
        # botocore fixes a client's credentials when it is built: a client made while the chain
        # (an instance role) was briefly unavailable would fail every later call.
        raise NoCredentialsError()
    client = session.client("bedrock-runtime", region_name=region, endpoint_url=bedrock_origin(region), config=Config(**options))
    if bearer:
        def add_bearer(request, **_):
            request.headers["Authorization"] = f"Bearer {bearer}"
        client.meta.events.register("before-send.bedrock-runtime.ConverseStream", add_bearer)
    return client


def _sse(payload: dict | str) -> bytes:
    return f"data: {payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False)}\n\n".encode()


def _error_body(error: BridgeError) -> dict:
    # ``status`` lets the worker classify an AWS failure that arrives after the stream began. The
    # bridge's own refusals (an event it cannot relay, a truncated stream) carry none, so they are
    # not reported as a provider outage; nor does a failure AWS never reported (BEDROCK_CONNECTION_FAILURE).
    # A failure before the stream began is classified by the response's own status, which it keeps.
    body = {"message": error.message, "type": error.kind, "code": error.kind}
    if error.upstream and error.kind != BEDROCK_CONNECTION_FAILURE:
        body["status"] = error.status
    return {"error": body}


class _ConverseStream(AsyncByteStream):
    def __init__(self, queue: asyncio.Queue, mapper: ChunkMapper, cancel: Callable[[], None],
                 failed: Callable[[BridgeError], BridgeError] = lambda error: error, summary: _SummaryCall | None = None):
        self.queue = queue
        self.mapper = mapper
        self.cancel = cancel
        # Told each failure the stream relays (BedrockConverseTransport._failed), and hands it back.
        self.failed = failed
        # A call that asked for its thinking summarized: told each event and the failure that ends the stream.
        self.summary = summary

    async def __aiter__(self):
        try:
            while True:
                kind, value = await self.queue.get()
                if kind == "event":
                    if self.summary is not None:
                        self.summary.event(value)
                    try:
                        for payload in self.mapper.map(value):
                            yield _sse(payload)
                    except BridgeError as error:
                        yield _sse(_error_body(self.failed(error)))
                        return
                elif kind == "end":
                    try:
                        self.mapper.finish()
                    except BridgeError as error:
                        yield _sse(_error_body(self.failed(error)))
                        return
                    yield _sse("[DONE]")
                    return
                else:
                    # A failure after the stream began is an SSE error frame, which the OpenAI SDK raises.
                    failure = bridge_failure(value)
                    relayed = self.failed(failure)
                    if self.summary is not None:
                        self.summary.failure(failure)
                    yield _sse(_error_body(relayed))
                    return
        finally:
            self.cancel()

    async def aclose(self) -> None:
        self.cancel()


class BedrockConverseTransport(AsyncBaseTransport):
    """Serves ``POST <bridge base URL>/chat/completions`` from Bedrock ConverseStream."""

    def __init__(self, *, region: str, model: str, auth: dict, read_timeout: float = 120.0,
                 client_factory: Callable[[str, dict, float], Any] = default_client, prompt_cache: bool = False,
                 reasoning_efforts: tuple = (), fallback_model: str = "", report: Callable[[dict], None] | None = None,
                 summary_watch: SummaryWatch | None = None):
        if not valid_auth(auth):
            raise ValueError("Invalid Bedrock credentials")
        if not isinstance(prompt_cache, bool):
            raise ValueError("Invalid Bedrock prompt cache setting")
        if not valid_reasoning_efforts(reasoning_efforts) or (reasoning_efforts and not CLAUDE_MODEL.match(model)):
            raise ValueError("Invalid Bedrock reasoning efforts")
        if not isinstance(fallback_model, str) or (fallback_model and (not FACT_LABEL.fullmatch(fallback_model) or fallback_model == model)):
            raise ValueError("Invalid Bedrock fallback model")
        if report is not None and not callable(report):
            raise ValueError("Invalid Bedrock call reporter")
        if summary_watch is not None and not isinstance(summary_watch, SummaryWatch):
            raise ValueError("Invalid Bedrock summary watch")
        self.endpoint = bridge_base_url(region) + "/chat/completions"
        self.region = region
        self.model = model
        self.auth = auth
        self.read_timeout = read_timeout
        self.client_factory = client_factory
        # Claude only, operator-enabled (AWWO_BEDROCK_PROMPT_CACHE_MODELS): see with_claude_prompt_cache.
        self.prompt_cache = prompt_cache
        # Claude only: the thinking efforts the profile's catalog entry offers, which a request may name (to_converse_input).
        self.reasoning_efforts = tuple(reasoning_efforts)
        # The same model through its other inference profile (the catalog's fallbackTarget): asked once, on the same
        # client, when `model` refuses the call for capacity or quota (PROFILE_REFUSALS) before anything streamed.
        # Empty: one profile, exactly as before.
        self.fallback_model = fallback_model
        # Told each content-free fact of a call (bedrock_fact_line); a reporter that raises never fails the call.
        self.report = report
        # Whether Bedrock streams a silent model's thinking summary right now: the worker's own (SUMMARY_WATCH) unless one
        # is given (tests).
        self.summary_watch = summary_watch if summary_watch is not None else SUMMARY_WATCH

    @staticmethod
    def _json_error(error: BridgeError) -> Response:
        return Response(error.status, json=_error_body(error))

    def _tell(self, fact: dict) -> None:
        if self.report is None:
            return
        try:
            self.report(fact)
        except Exception:  # noqa: BLE001 - a log line is never worth a call
            pass

    def _failed(self, error: BridgeError, model: str, stage: str) -> BridgeError:
        # upstream: AWS's answer or the way to it (the connection, the credentials); otherwise the bridge's own refusal
        # (a request or content it cannot relay).
        self._tell({"event": "failed", "model": model, "error": error.kind, "status": error.status, "stage": stage, "upstream": error.upstream})
        return error

    async def handle_async_request(self, request: Request) -> Response:
        if str(request.url) != self.endpoint or request.method != "POST":
            return self._json_error(BridgeError(404, "not_found_error", "Unknown bridge endpoint"))
        try:
            raw = await request.aread()
            if len(raw) > MAX_REQUEST_BYTES:
                _reject("The request is too large")
            try:
                body = json.loads(raw)
            except (json.JSONDecodeError, UnicodeDecodeError):
                _reject("The request body is not JSON")
            command = with_summarized_thinking(to_converse_input(body, self.model, self.reasoning_efforts), self.model)
            if self.prompt_cache:
                command = with_claude_prompt_cache(command)
            single_tool_call = body.get("parallel_tool_calls") is False
            read_timeout = call_read_timeout(self.read_timeout, command, self.model, self.summary_watch)
            summary = (_SummaryCall(self.summary_watch, self.model, command_effort(command), self._tell)
                       if asks_for_summary(command, self.model) else None)
        except BridgeError as error:
            return self._json_error(self._failed(error, self.model, "request"))

        loop = asyncio.get_running_loop()
        queue: asyncio.Queue = asyncio.Queue()
        stop = threading.Event()
        holder: dict = {}

        def put(item):
            try:
                loop.call_soon_threadsafe(queue.put_nowait, item)
            except RuntimeError:
                pass  # The event loop is gone; nobody is reading.

        def cancel():
            stop.set()
            stream = holder.get("stream")
            if stream is not None:
                try:
                    stream.close()
                except Exception:  # noqa: BLE001 - best effort teardown
                    pass

        def open_stream(client, model_id: str, read_ahead: bool):
            response = client.converse_stream(**(command if model_id == self.model else {**command, "modelId": model_id}))
            stream = response["stream"]
            holder["stream"] = stream
            events = iter(stream)
            # A call cancelled while it was sent reads nothing more: the worker closes its stream at once.
            if not read_ahead or stop.is_set():
                return events, None
            # With a fallback to turn to, the first event is read here as well: an exception that opens the stream is
            # that profile's refusal, met before anything reached the caller. Any other first event (or failure) stays
            # at the head of the stream, to be relayed as it always was.
            try:
                head = ("event", next(events))
            except StopIteration:
                head = ("end", None)
            except Exception as error:  # noqa: BLE001 - relayed or refused below, as the stream would
                head = ("error", error)
            refusal = (bridge_failure(head[1]) if head[0] == "error"
                       else _stream_exception(head[1]) if head[0] == "event" else None)
            if refusal is not None and refusal.kind in PROFILE_REFUSALS and not stop.is_set():
                try:
                    stream.close()
                except Exception:  # noqa: BLE001 - best effort teardown
                    pass
                raise refusal
            return events, head

        def worker():
            try:
                client = self.client_factory(self.region, self.auth, read_timeout)
                try:
                    events, head = open_stream(client, self.model, bool(self.fallback_model))
                except Exception as error:  # noqa: BLE001 - a profile's refusal turns to the model's other profile
                    refusal = bridge_failure(error)
                    if not self.fallback_model or stop.is_set() or refusal.kind not in PROFILE_REFUSALS:
                        raise
                    self._tell({"event": "fallback", "from": self.model, "to": self.fallback_model, "after": refusal.kind})
                    holder["active"] = self.fallback_model
                    if summary is not None:
                        summary.restart()
                    events, head = open_stream(client, self.fallback_model, False)
                if stop.is_set():
                    cancel()
                    return
                put(("open", None))
                if head is not None:
                    put(head)
                    if head[0] != "event":
                        return
                for event in events:
                    if stop.is_set():
                        return
                    put(("event", event))
                put(("end", None))
            except BaseException as error:  # noqa: BLE001 - every failure crosses as a value
                put(("error", error))

        threading.Thread(target=worker, name="awwo-bedrock-converse", daemon=True).start()
        try:
            kind, value = await queue.get()
        except asyncio.CancelledError:
            cancel()
            raise
        # The profile that answered (or refused last): written by the worker thread before what it put.
        active = holder.get("active", self.model)
        if kind == "error":
            failure = bridge_failure(value)
            # A refusal as too large from the other profile follows the first one's refusal: two requests, so not one made
            # before any work (the workers' rule): it goes out as AWS's validation failure it is.
            if active != self.model and failure.kind == BEDROCK_CONTEXT_LIMIT_TYPE:
                failure = BridgeError(400, "ValidationException", "The Bedrock request failed", upstream=True)
            return self._json_error(self._failed(failure, active, "request"))
        # The chunks name the model the caller asked for, whichever of its profiles answers.
        return Response(200, headers={"content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache"},
                        stream=_ConverseStream(queue, ChunkMapper(self.model, single_tool_call=single_tool_call), cancel,
                                               failed=lambda error: self._failed(error, active, "stream"), summary=summary))
