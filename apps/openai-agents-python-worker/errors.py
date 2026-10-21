"""Error codes and messages, mirroring the Node worker's errors.mjs."""

from context_overflow import context_overflow

MESSAGES = {
    "MODEL_AUTHENTICATION": "The model service rejected its configured credentials.",
    "MODEL_RATE_LIMIT": "The model service is rate limited.",
    "MODEL_UNAVAILABLE": "The model service is unavailable.",
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


def classify_error(error: BaseException) -> dict:
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
    status = getattr(error, "status_code", None) or getattr(error, "status", None)
    if status is None:
        # An error frame inside a stream that already answered 200 carries its status in its body.
        body = getattr(error, "body", None)
        inner = body.get("status") if isinstance(body, dict) else None
        if isinstance(inner, int) and not isinstance(inner, bool) and 400 <= inner <= 599:
            status = inner
    if status in (400, 413, 422) and refuses_size(error):
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
