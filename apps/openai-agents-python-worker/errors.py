"""Error codes and messages, mirroring the Node worker's errors.mjs."""

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


def refuses_size(error: BaseException) -> bool:
    """A provider's refusal of the request as larger than the model's window (context_overflow.py): by its code (the
    Bedrock bridge's own, or an OpenAI-compatible provider's), or by its message, which is read here and never relayed."""
    body = getattr(error, "body", None)
    inner = body.get("error") if isinstance(body, dict) and isinstance(body.get("error"), dict) else body
    codes = (getattr(error, "code", None), getattr(error, "kind", None), inner.get("code") if isinstance(inner, dict) else None)
    if "context_length_exceeded" in codes:
        return True
    texts = (getattr(error, "message", None), inner.get("message") if isinstance(inner, dict) else None, str(error))
    return any(context_overflow(text) for text in texts)


def counts_work(usage) -> bool:
    """Whether a provider's usage counts anything (a token read or written, a cost: any positive number at its top level
    or one object down): the provider read the request."""
    def positive(value):
        return isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0
    return isinstance(usage, dict) and any(positive(v) or (isinstance(v, dict) and any(positive(x) for x in v.values()))
                                           for v in usage.values())


# The parts of an answer a refusal's body could carry (Chat Completions, Responses, Anthropic, Gemini).
ANSWER_KEYS = ("choices", "output", "content", "candidates")


def carries_work(body: dict) -> bool:
    """Whether a refusal's body carries anything of the work it refused, at its top level or inside any of its fields
    (its error, a provider's own envelope): usage that counts anything, or any of an answer."""
    parts = [body, *(v for v in body.values() if isinstance(v, dict))]
    return any(counts_work(p.get("usage")) or counts_work(p.get("usage_metadata"))
               or any(p.get(key) not in (None, "", [], {}) for key in ANSWER_KEYS) for p in parts)


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


def refused_before_any_work(error: BaseException) -> bool:
    """Whether the provider refused the request with an HTTP 400, 413 or 422 answer, before any stream (a refusal inside
    a stream that answered 200 may follow work: it carries its status in its body, never as the SDK's status_code), in a
    JSON body (read from the response the SDK kept; never relayed) that carries no work. A body that is not JSON cannot
    say so."""
    if getattr(error, "status_code", None) not in (400, 413, 422):
        return False
    response = getattr(error, "response", None)
    try:
        body = response.json() if response is not None else None
    except Exception:  # noqa: BLE001 - a body that cannot be read says nothing
        return False
    return isinstance(body, dict) and not carries_work(body)


def classify_error(error: BaseException, requests: int = 1, bedrock: bool = False) -> dict:
    """The wire failure for an error. A provider's refusal of the request as too large is MODEL_CONTEXT_LIMIT only when
    it came before any work: to the call's one request (`requests`, as the runner counted them) and as
    refused_before_any_work says; otherwise it is the refusal it otherwise is. `bedrock` says the Bedrock bridge served
    the call (its profile is a Bedrock one): only then can it have stalled (MODEL_STALLED)."""
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
    if requests == 1 and refuses_size(error) and refused_before_any_work(error):
        return failure_event("MODEL_CONTEXT_LIMIT")
    if status in (401, 403):
        return failure_event("MODEL_AUTHENTICATION")
    if status == 429:
        return failure_event("MODEL_RATE_LIMIT")
    if isinstance(status, int) and status >= 500:
        return failure_event("MODEL_UNAVAILABLE")
    if isinstance(status, int) and status >= 400:
        return failure_event("MODEL_REQUEST_REJECTED")
    # The Python SDK's timeout is APITimeoutError (the Node SDK's name is APIConnectionTimeoutError). One raised while
    # connecting (5 s) never reached the model service, which is unavailable: the run's deadline is the other kind, and
    # a node whose run timed out is not run again (graph_retry.go), while an outage may be.
    if name in ("APIConnectionTimeoutError", "APITimeoutError"):
        if type(error.__cause__).__name__ == "ConnectTimeout":
            return failure_event("MODEL_UNAVAILABLE")
        return failure_event("DEADLINE_EXCEEDED")
    return failure_event("MODEL_ERROR")
