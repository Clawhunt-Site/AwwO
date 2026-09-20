"""Error codes and messages, mirroring the Node worker's errors.mjs."""

MESSAGES = {
    "MODEL_AUTHENTICATION": "The model service rejected its configured credentials.",
    "MODEL_RATE_LIMIT": "The model service is rate limited.",
    "MODEL_UNAVAILABLE": "The model service is unavailable.",
    "MODEL_REQUEST_REJECTED": "The model service rejected the request.",
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
    if status in (401, 403):
        return failure_event("MODEL_AUTHENTICATION")
    if status == 429:
        return failure_event("MODEL_RATE_LIMIT")
    if isinstance(status, int) and status >= 500:
        return failure_event("MODEL_UNAVAILABLE")
    if isinstance(status, int) and status >= 400:
        return failure_event("MODEL_REQUEST_REJECTED")
    if name == "APIConnectionTimeoutError":
        return failure_event("DEADLINE_EXCEEDED")
    return failure_event("MODEL_ERROR")
