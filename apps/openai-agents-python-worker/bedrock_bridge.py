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
first tool call of a turn, request metadata without a Converse counterpart) are the same
as the TypeScript bridge's and are listed in docs/awwo-bedrock.md.
"""

from __future__ import annotations

import asyncio
import json
import re
import threading
import time
import uuid
from typing import Any, Callable

from httpx2 import AsyncBaseTransport, AsyncByteStream, Request, Response

BEDROCK_REGIONS = (
    "us-east-1", "us-east-2", "us-west-2", "ca-central-1", "sa-east-1",
    "eu-central-1", "eu-west-1", "eu-west-2", "eu-west-3", "eu-north-1", "eu-south-1",
    "ap-northeast-1", "ap-northeast-2", "ap-south-1", "ap-southeast-1", "ap-southeast-2",
)
BRIDGE_PATH = "/awwo-bedrock-converse/v1"
# The OpenAI SDK requires an API key string; the bridge ignores the header it produces.
BRIDGE_API_KEY = "awwo-bedrock-bridge"
MAX_REQUEST_BYTES = 32 * 1024 * 1024
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


class BridgeError(Exception):
    def __init__(self, status: int, kind: str, message: str, upstream: bool = False):
        super().__init__(message)
        self.status = status
        self.kind = kind
        self.message = message
        # True when AWS reported the failure; the bridge's own refusals are not provider outages.
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


def to_converse_input(body: Any, model_id: str) -> dict:
    """Translate a Chat Completions request body into ConverseStream input."""
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
    if body.get("reasoning_effort") is not None:
        _reject("Reasoning effort is not supported for this Bedrock model")
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
    for message in messages_in:
        if not isinstance(message, dict) or not isinstance(message.get("role"), str):
            _reject("Invalid message")
        role = message["role"]
        if role in ("system", "developer"):
            system.extend(_text_block(_message_text(message.get("content"), "system")))
        elif role == "user":
            push("user", _text_block(_message_text(message.get("content"), "user")))
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
    return result


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


def bridge_failure(error: BaseException) -> BridgeError:
    """Status and type only: SDK messages can carry account IDs and role ARNs."""
    if isinstance(error, BridgeError):
        return error
    if type(error).__name__ in CREDENTIAL_ERRORS:
        # No usable AWS credentials: an authentication failure, like a rejected key.
        return BridgeError(401, "api_error", "The Bedrock request failed", upstream=True)
    code = ""
    status = None
    response = getattr(error, "response", None)
    if isinstance(response, dict):
        details = response.get("Error") if isinstance(response.get("Error"), dict) else {}
        code = details.get("Code") if isinstance(details.get("Code"), str) else ""
        metadata = response.get("ResponseMetadata") if isinstance(response.get("ResponseMetadata"), dict) else {}
        if isinstance(metadata.get("HTTPStatusCode"), int):
            status = metadata["HTTPStatusCode"]
    name = _SDK_NAMES.get(code.lower(), "")
    if name:
        return BridgeError(SDK_STATUS[name], name, "The Bedrock request failed", upstream=True)
    if code in STREAM_EXCEPTIONS:
        return BridgeError(STREAM_EXCEPTIONS[code], code, "The Bedrock request failed", upstream=True)
    if status is not None and 400 <= status <= 599:
        return BridgeError(status, "api_error", "The Bedrock request failed", upstream=True)
    return BridgeError(502, "api_error", "The Bedrock request failed", upstream=True)


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
    # not reported as a provider outage.
    body = {"message": error.message, "type": error.kind, "code": error.kind}
    if error.upstream:
        body["status"] = error.status
    return {"error": body}


class _ConverseStream(AsyncByteStream):
    def __init__(self, queue: asyncio.Queue, mapper: ChunkMapper, cancel: Callable[[], None]):
        self.queue = queue
        self.mapper = mapper
        self.cancel = cancel

    async def __aiter__(self):
        try:
            while True:
                kind, value = await self.queue.get()
                if kind == "event":
                    try:
                        for payload in self.mapper.map(value):
                            yield _sse(payload)
                    except BridgeError as error:
                        yield _sse(_error_body(error))
                        return
                elif kind == "end":
                    try:
                        self.mapper.finish()
                    except BridgeError as error:
                        yield _sse(_error_body(error))
                        return
                    yield _sse("[DONE]")
                    return
                else:
                    # A failure after the stream began is an SSE error frame, which the OpenAI SDK raises.
                    yield _sse(_error_body(bridge_failure(value)))
                    return
        finally:
            self.cancel()

    async def aclose(self) -> None:
        self.cancel()


class BedrockConverseTransport(AsyncBaseTransport):
    """Serves ``POST <bridge base URL>/chat/completions`` from Bedrock ConverseStream."""

    def __init__(self, *, region: str, model: str, auth: dict, read_timeout: float = 120.0,
                 client_factory: Callable[[str, dict, float], Any] = default_client):
        if not valid_auth(auth):
            raise ValueError("Invalid Bedrock credentials")
        self.endpoint = bridge_base_url(region) + "/chat/completions"
        self.region = region
        self.model = model
        self.auth = auth
        self.read_timeout = read_timeout
        self.client_factory = client_factory

    @staticmethod
    def _json_error(error: BridgeError) -> Response:
        return Response(error.status, json=_error_body(error))

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
            command = to_converse_input(body, self.model)
            single_tool_call = body.get("parallel_tool_calls") is False
        except BridgeError as error:
            return self._json_error(error)

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

        def worker():
            try:
                client = self.client_factory(self.region, self.auth, self.read_timeout)
                response = client.converse_stream(**command)
                stream = response["stream"]
                holder["stream"] = stream
                if stop.is_set():
                    cancel()
                    return
                put(("open", None))
                for event in stream:
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
        if kind == "error":
            return self._json_error(bridge_failure(value))
        return Response(200, headers={"content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache"},
                              stream=_ConverseStream(queue, ChunkMapper(self.model, single_tool_call=single_tool_call), cancel))
