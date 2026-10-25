"""Error codes and messages, mirroring the Node worker's errors.mjs."""

import json
import re

from context_overflow import context_overflow

MESSAGES = {
    "MODEL_AUTHENTICATION": "The model service rejected its configured credentials.",
    "MODEL_RATE_LIMIT": "The model service is rate limited.",
    "MODEL_UNAVAILABLE": "The model service is unavailable.",
    "MODEL_STALLED": "The model service sent nothing for too long.",
    "MODEL_REQUEST_REJECTED": "The model service rejected the request.",
    "MODEL_CONTEXT_LIMIT": "The model service refused the request as larger than the model's context window.",
    "CONTEXT_LIMIT": "The prompt and history exceed the configured model context budget.",
    "MODEL_OUTPUT_LIMIT": "The model response reached its configured output limit.",
    "MODEL_REFUSAL": "The model declined the request.",
    "MODEL_PROTOCOL_ERROR": "The model returned an incomplete or invalid response.",
    "MODEL_ERROR": "The model request failed.",
    "TOOL_DENIED": "The model requested an unregistered or disabled tool.",
    "TOOL_INPUT_INVALID": "The registered tool received invalid input.",
    "MODEL_CALL_LIMIT": "The single model call limit was reached.",
    "DEADLINE_EXCEEDED": "The model request timed out.",
    "OUTPUT_LIMIT": "The model output exceeded the configured limit.",
    "WORKER_ERROR": "The model worker could not start.",
    "WORKER_LOST": "The model worker exited before completing.",
}


class RuntimeError(Exception):
    def __init__(self, code: str):
        super().__init__(MESSAGES.get(code, MESSAGES["MODEL_ERROR"]))
        self.code = code


def failure_event(code: str) -> dict:
    safe = code if code in MESSAGES else "MODEL_ERROR"
    return {"type": "failed", "code": safe, "message": MESSAGES[safe]}


# The rule for a refusal before any work is the JavaScript worker's (openai-agents-worker/usage.mjs and errors.mjs) and
# the Pi child's (pi-worker/usage.mjs), so that the three read one body alike, but for the statuses (the JavaScript worker
# takes a 400 or 413; this worker, as the Pi child, a 422 too) and two ways this reading is more careful: a JSON integer
# of more than 4,300 digits makes json.loads refuse the body, which so cannot say it carries no work, and the rate limit's
# veto in context_overflow.py also spans a character outside the Basic Multilingual Plane, which JavaScript's does not.

# A refusal's body is read only up to this many bytes; a longer one cannot say it carries no work.
REFUSAL_BODY_LIMIT = 65_536
# The keys a provider reports usage under (Gemini's two among them), and the parts of an answer a refusal's body could
# carry (Chat Completions, Responses, Anthropic, Gemini).
USAGE_KEYS = ("usage", "usage_metadata", "usageMetadata")
ANSWER_KEYS = ("choices", "output", "content", "candidates")
# Words JavaScript's Number() reads as a number (its StringToNumber), so that a count in words is read as the other
# workers read it: around it, ECMAScript's white space and line terminators; inside, a decimal or Infinity with its sign,
# or a hexadecimal, octal or binary integer. (Its white space: tab, the vertical tab, form feed, U+FEFF and every space
# separator; its line terminators: LF, CR, U+2028, U+2029.) No repetition in the grammar overlaps another, so a long run
# of digits is judged in linear time: one with overlapping runs held a 64 KiB refusal for 19 s.
_JS_SPACE = "".join(map(chr, (0x09, 0x0B, 0x0C, 0x20, 0xA0, 0x1680, *range(0x2000, 0x200B), 0x202F, 0x205F, 0x3000, 0xFEFF,
                              0x0A, 0x0D, 0x2028, 0x2029)))
_JS_DECIMAL = re.compile(r"[+-]?(?:Infinity|(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)")
_JS_INTEGER = re.compile(r"0(?:[xX][0-9a-fA-F]+|[oO][0-7]+|[bB][01]+)")


def _positive_words(text: str) -> bool:
    """Whether words are a positive number, as JavaScript's Number() reads them."""
    text = text.strip(_JS_SPACE)
    if _JS_INTEGER.fullmatch(text):
        return int(text[2:], {"x": 16, "o": 8, "b": 2}[text[1].lower()]) > 0
    return bool(_JS_DECIMAL.fullmatch(text)) and float(text.replace("Infinity", "inf")) > 0


def _no_constant(name: str):
    # JSON.parse, which reads a refusal's body in the JavaScript worker and the Pi child, accepts no NaN or Infinity.
    raise ValueError(name)


def counts_work(usage, depth: int = 0) -> bool:
    """Whether a provider's usage counts anything (a token read or written, a cost: a positive number, or words that are
    one, anywhere in it, its lists included): the provider read the request. Usage whose objects or lists nest past 64
    levels is taken to count."""
    if isinstance(usage, bool):
        return False
    if isinstance(usage, (int, float)):
        return usage > 0
    if isinstance(usage, str):
        return _positive_words(usage)
    if isinstance(usage, (dict, list)):
        return depth > 64 or any(counts_work(value, depth + 1) for value in (usage.values() if isinstance(usage, dict) else usage))
    return False


def carries_work(value, depth: int = 0) -> bool:
    """Whether a refusal's body carries anything of the work it refused, anywhere in it (its error, a provider's own
    envelope, a detail under either): usage that counts anything, or any of an answer. A body whose objects or lists nest
    past 64 levels is taken to carry work."""
    if not isinstance(value, (dict, list)):
        return False
    if depth > 64:
        return True
    if isinstance(value, list):
        return any(carries_work(item, depth + 1) for item in value)
    return (any(counts_work(value.get(key), depth + 1) for key in USAGE_KEYS)
            or any(value.get(key) not in (None, "", [], {}) for key in ANSWER_KEYS)
            or any(carries_work(item, depth + 1) for item in value.values()))


def stalled(error: BaseException, bedrock: bool) -> bool:
    """Whether the error is the Bedrock bridge's read timeout (bedrock_bridge.bridge_failure: Bedrock sent nothing for
    the call's silence limit, bedrock_bridge.call_read_timeout), for a call the bridge served (`bedrock`: no other
    provider's answer is taken for it, whatever its body says): the bridge's own failure, or the SDK's error for the
    bridge's answer to it, before its stream (an HTTP 504 with the bridge's body) or inside one (its error frame, which
    the SDK raises without a status of its own), its body the bridge's type and code with the status 504."""
    from bedrock_bridge import BridgeError

    if not bedrock:
        return False
    if isinstance(error, BridgeError):
        return error.kind == "ReadTimeoutError" and error.status == 504
    if getattr(error, "status_code", None) not in (None, 504):
        return False
    body = getattr(error, "body", None)
    inner = body.get("error") if isinstance(body, dict) and isinstance(body.get("error"), dict) else body
    return (isinstance(inner, dict) and inner.get("type") == "ReadTimeoutError" and inner.get("code") == "ReadTimeoutError"
            and inner.get("status") == 504)


def provider_words(body: dict) -> list:
    """The provider's own words in a refusal's body: its error's message (or the error itself, where that is only
    words), code and type. Never anything else in the body, where a provider may echo words of the request, and never
    the SDK's own message (str(error)), which spells out the whole body."""
    error = body.get("error")
    words = [error] if isinstance(error, str) else [error.get(k) for k in ("message", "code", "type")] if isinstance(error, dict) else []
    return [item for item in words if isinstance(item, str)]


def refuses_size(body) -> bool:
    """A provider's refusal of the request as larger than the model's window (context_overflow.py), in its own words
    (provider_words), which are read here and never relayed."""
    return isinstance(body, dict) and any(context_overflow(words) for words in provider_words(body))


def refused_before_any_work(error: BaseException):
    """The body of the provider's refusal of the request with an HTTP 400, 413 or 422 answer, before any stream (a refusal
    inside a stream that answered 200 may follow work: it carries its status in its body, never as the SDK's
    status_code), when it can say it carries no work: read from the response the SDK kept (never relayed), at most
    REFUSAL_BODY_LIMIT bytes, not typed a stream (in any letters), JSON as the other workers read it (its text as UTF-8,
    no NaN or Infinity), an object, and no work anywhere in it. None for any other."""
    if getattr(error, "status_code", None) not in (400, 413, 422):
        return None
    response = getattr(error, "response", None)
    try:
        content, kind = response.content, response.headers.get("content-type", "")
        if not isinstance(content, bytes) or len(content) > REFUSAL_BODY_LIMIT or "text/event-stream" in kind.lower():
            return None
        body = json.loads(content.decode("utf-8-sig", errors="replace"), parse_constant=_no_constant)
    except Exception:  # noqa: BLE001 - a body that cannot be read says nothing
        return None
    return body if isinstance(body, dict) and not carries_work(body) else None


def classify_error(error: BaseException, requests: int = 1, bedrock: bool = False) -> dict:
    """The wire failure for an error. A provider's refusal of the request as too large is MODEL_CONTEXT_LIMIT only when
    it came before any work: to the call's one request (`requests`, as the runner counted them), in a body that
    refused_before_any_work reads as carrying no work, and in the provider's own words there (refuses_size); otherwise
    it is the refusal it otherwise is. `bedrock` says the Bedrock bridge served the call (its profile is a Bedrock one):
    only then can it have stalled (MODEL_STALLED)."""
    from tools import ToolInputError

    name = type(error).__name__
    if isinstance(error, RuntimeError):
        return failure_event(error.code)
    if name == "ToolInputError" or isinstance(error, ToolInputError):
        return failure_event("TOOL_INPUT_INVALID")
    if name == "MaxTurnsExceededError":
        return failure_event("MODEL_CALL_LIMIT")
    if name == "ModelRefusalError":
        return failure_event("MODEL_REFUSAL")
    if name == "ModelBehaviorError":
        return failure_event("MODEL_PROTOCOL_ERROR")
    if name == "ToolCallError":
        return failure_event("TOOL_INPUT_INVALID")
    if stalled(error, bedrock):
        # The service failed, not the run's deadline: a canvas node whose call stalled before anything streamed runs
        # again (graph_retry.go), as after MODEL_UNAVAILABLE. Told apart so that the API does not charge a call that a
        # time limit of the platform's cut before it returned anything (plans.go stalledBeforeOutput).
        return failure_event("MODEL_STALLED")
    status = getattr(error, "status_code", None) or getattr(error, "status", None)
    if status is None:
        # An error frame inside a stream that already answered 200 carries its status in its body.
        body = getattr(error, "body", None)
        inner = body.get("status") if isinstance(body, dict) else None
        if isinstance(inner, int) and not isinstance(inner, bool) and 400 <= inner <= 599:
            status = inner
    if requests == 1 and refuses_size(refused_before_any_work(error)):
        return failure_event("MODEL_CONTEXT_LIMIT")
    if status in (401, 403):
        return failure_event("MODEL_AUTHENTICATION")
    if status == 429:
        return failure_event("MODEL_RATE_LIMIT")
    # A status past 599 (one an HTTP client passes through) is no outage and no refusal, as in the other workers: an
    # outage answered at once is not charged (plans.go refusedBeforeOutput), which such an answer has not shown it is.
    if isinstance(status, int) and 500 <= status <= 599:
        return failure_event("MODEL_UNAVAILABLE")
    if isinstance(status, int) and 400 <= status <= 599:
        return failure_event("MODEL_REQUEST_REJECTED")
    # The Python SDK's timeout is APITimeoutError (the Node SDK's name is APIConnectionTimeoutError). One raised while
    # connecting (5 s) never reached the model service, which is unavailable: the run's deadline is the other kind, and
    # a node whose run timed out is not run again (graph_retry.go), while an outage may be.
    if name in ("APIConnectionTimeoutError", "APITimeoutError"):
        if type(error.__cause__).__name__ == "ConnectTimeout":
            return failure_event("MODEL_UNAVAILABLE")
        return failure_event("DEADLINE_EXCEEDED")
    return failure_event("MODEL_ERROR")
