"""Observe provider facts before the Agents SDK normalizes them; never retain content."""
import codecs
import json
import re
import time

from httpx2 import AsyncByteStream

from errors import RuntimeError

TOKEN_FIELDS = ("inputTokens", "outputTokens", "cachedInputTokens", "cacheWriteTokens",
                "reasoningTokens", "providerTotalTokens", "computedTotalTokens")
MAX_FRAME = 1 << 20
MAX_INTEGER = 9007199254740991


def empty_usage(status="unavailable", reason="provider_missing"):
    return {"status": status, "source": "none", "reason": reason,
            **dict.fromkeys(TOKEN_FIELDS)}


def normalize_usage(raw, protocol):
    if not isinstance(raw, dict):
        return empty_usage() if raw is None else empty_usage("invalid", "protocol_invalid")
    chat = protocol == "chat_completions"
    details = raw.get("prompt_tokens_details" if chat else "input_tokens_details")
    output_details = raw.get("completion_tokens_details" if chat else "output_tokens_details")
    if any(detail is not None and not isinstance(detail, dict) for detail in (details, output_details)):
        return empty_usage("invalid", "protocol_invalid")
    fields = {
        "inputTokens": raw.get("prompt_tokens" if chat else "input_tokens"),
        "outputTokens": raw.get("completion_tokens" if chat else "output_tokens"),
        "cachedInputTokens": details.get("cached_tokens") if isinstance(details, dict) else None,
        "reasoningTokens": output_details.get("reasoning_tokens") if isinstance(output_details, dict) else None,
        "providerTotalTokens": raw.get("total_tokens"),
    }
    if any(n is not None and (type(n) is not int or not 0 <= n <= MAX_INTEGER) for n in fields.values()):
        return empty_usage("invalid", "protocol_invalid")
    if not any(n is not None for n in fields.values()):
        return empty_usage()
    result = {**empty_usage(), **fields, "source": "provider_raw"}
    incoming, outgoing = result["inputTokens"], result["outputTokens"]
    if incoming is not None and outgoing is not None:
        total = incoming + outgoing
        if total > MAX_INTEGER or (result["providerTotalTokens"] is not None and result["providerTotalTokens"] != total):
            return empty_usage("invalid", "total_mismatch")
        result["computedTotalTokens"] = total
    if any(part is not None and whole is not None and part > whole for part, whole in (
        (result["cachedInputTokens"], incoming), (result["reasoningTokens"], outgoing),
    )):
        return empty_usage("invalid", "total_mismatch")
    result["status"] = "reported" if incoming is not None and outgoing is not None else "partial"
    result["reason"] = "none" if result["status"] == "reported" else "field_missing"
    return result


class ProviderObservation:
    """Bounded SSE tap. Original bytes and network behavior are left to the SDK."""

    def __init__(self, protocol, clock=time.monotonic):
        self.protocol = protocol
        self.clock = clock
        self.born = clock()
        self.started = self.ended = self.first = self.first_delta = None
        self.usage = empty_usage()
        self.finish_reason = None
        self.complete = False
        self.failure = None
        self._decoder = codecs.getincrementaldecoder("utf-8")("strict")
        self._line = ""
        self._data = []
        self._frame_size = 0
        self._skip_line = False
        self._skip_frame = False
        self._skip_lf = False

    async def on_request(self, _request):
        if self.started is None:
            self.started = self.clock()

    async def on_response(self, response):
        if response.is_success and "text/event-stream" in response.headers.get("content-type", ""):
            response.stream = ObservedStream(response.stream, self)
        else:
            self.end()

    def end(self):
        if self.ended is None:
            self.ended = self.clock()

    def _reject(self, code="MODEL_PROTOCOL_ERROR"):
        if self.failure is None:
            self.failure = code

    def _consume(self, value):
        if not isinstance(value, dict):
            self._reject()
            return
        if self.protocol == "chat_completions":
            if "usage" in value and value["usage"] is not None:
                self.usage = normalize_usage(value["usage"], self.protocol)
            choices = value.get("choices", [])
            if not isinstance(choices, list):
                self._reject()
                return
            for choice in choices:
                if not isinstance(choice, dict) or choice.get("index") != 0:
                    self._reject()
                    continue
                delta = choice.get("delta")
                if isinstance(delta, dict) and isinstance(delta.get("content"), str) and delta["content"]:
                    if self.first is None:
                        self.first = self.clock()
                reason = choice.get("finish_reason")
                if reason is not None:
                    if self.finish_reason is not None and self.finish_reason != reason:
                        self._reject()
                    self.finish_reason = reason if reason in ("stop", "tool_calls", "length", "content_filter") else "invalid"
                    if reason == "length":
                        self._reject("MODEL_OUTPUT_LIMIT")
                    elif reason == "content_filter":
                        self._reject("MODEL_REFUSAL")
                    elif reason not in ("stop", "tool_calls"):
                        self._reject()
        else:
            kind = value.get("type")
            if kind == "response.output_text.delta" and isinstance(value.get("delta"), str) and value["delta"]:
                if self.first is None:
                    self.first = self.clock()
            if kind in ("response.completed", "response.incomplete", "response.failed", "response.cancelled"):
                self.complete = True
                self.end()
                response = value.get("response")
                if not isinstance(response, dict):
                    self._reject()
                    return
                self.usage = normalize_usage(response.get("usage"), self.protocol)
                expected_status = kind.removeprefix("response.")
                if response.get("status") != expected_status:
                    self._reject()
                if kind != "response.completed":
                    details = response.get("incomplete_details")
                    reason = details.get("reason") if isinstance(details, dict) else None
                    self._reject("MODEL_OUTPUT_LIMIT" if reason == "max_output_tokens" else
                                 "MODEL_REFUSAL" if reason == "content_filter" else "MODEL_PROTOCOL_ERROR")
                output = response.get("output")
                if isinstance(output, list) and any(isinstance(item, dict) and item.get("status") == "incomplete" for item in output):
                    self._reject()

    def _finish_line(self):
        if not self._skip_line:
            if self._line == "":
                if self._data and not self._skip_frame:
                    raw = "\n".join(self._data)
                    if raw.strip() == "[DONE]":
                        if self.protocol == "chat_completions":
                            self.complete = True
                        self.end()
                    else:
                        try:
                            self._consume(json.loads(raw))
                        except (ValueError, TypeError, RecursionError):
                            self._reject()
                self._data, self._frame_size, self._skip_frame = [], 0, False
            elif self._line.startswith("data:"):
                value = self._line[5:].removeprefix(" ")
                self._frame_size += len(value) + 1
                if self._frame_size > MAX_FRAME:
                    self._data, self._skip_frame = [], True
                    self._reject()
                elif not self._skip_frame:
                    self._data.append(value)
        self._line, self._skip_line = "", False

    def feed(self, chunk, final=False):
        try:
            text = self._decoder.decode(chunk, final=final)
        except UnicodeError:
            self._reject()
            return
        if not text and not final:
            return
        # Process whole line fragments, not one character at a time: even an oversized
        # provider frame must remain linear-time, with at most MAX_FRAME retained.
        if self._skip_lf and text.startswith("\n"):
            text = text[1:]
        self._skip_lf = False
        def append(part):
            if self._skip_line:
                return
            if len(self._line) + len(part) > MAX_FRAME:
                self._line, self._data, self._skip_line, self._skip_frame = "", [], True, True
                self._reject()
            else:
                self._line += part
        offset = 0
        for match in re.finditer(r"\r\n|\r|\n", text):
            append(text[offset:match.start()])
            self._finish_line()
            offset = match.end()
            self._skip_lf = match.group() == "\r" and offset == len(text)
        append(text[offset:])
        if final:
            self._finish_line()
            self._finish_line()
            self.end()

    def require_complete(self):
        if self.failure:
            raise RuntimeError(self.failure)
        if not self.complete or (self.protocol == "chat_completions" and self.finish_reason not in ("stop", "tool_calls")):
            raise RuntimeError("MODEL_PROTOCOL_ERROR")

    def snapshot(self, outcome):
        now = self.clock()
        usage = dict(self.usage)
        if usage["status"] == "reported" and not self.complete:
            usage.update(status="partial", reason="field_missing")
        if usage["status"] == "unavailable" and self.started is not None and outcome != "completed":
            usage = empty_usage("unknown", "transport_unknown")
        def elapsed(start, end):
            return None if start is None or end is None else max(0, int((end - start) * 1000))
        return {"version": 1, "usage": usage, "timing": {
            "setupMs": elapsed(self.born, self.started), "providerMs": elapsed(self.started, self.ended),
            "providerTtftMs": elapsed(self.started, self.first), "workerTotalMs": elapsed(self.born, now),
            "workerFirstDeltaMs": elapsed(self.born, self.first_delta),
        }}


class ObservedStream(AsyncByteStream):
    def __init__(self, stream, observer):
        self.stream, self.observer = stream, observer

    async def __aiter__(self):
        try:
            async for chunk in self.stream:
                self.observer.feed(chunk)
                yield chunk
            self.observer.feed(b"", final=True)
        finally:
            self.observer.end()

    async def aclose(self):
        self.observer.end()
        await self.stream.aclose()
