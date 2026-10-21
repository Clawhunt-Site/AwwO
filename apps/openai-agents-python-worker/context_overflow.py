"""A provider's refusal of a request as larger than its model's context window.

The Python twin of apps/context-overflow.ts (see that file for the rationale and the sources of the patterns): the
provider's own error message is read inside the worker and never relayed, and the worker answers the refusal with its
closed code (MODEL_CONTEXT_LIMIT), so the API settles it as the size refusal it is. Shared cases:
apps/context-overflow-vectors.json.
"""

from __future__ import annotations

import re

_OVERFLOW = tuple(re.compile(pattern, re.IGNORECASE) for pattern in (
    r"prompt is too long",
    r"exceeds? (?:the )?context limit",
    r"input is too long",
    r"number of input tokens exceeds",
    r"request_too_large",
    r"exceeds the context window",
    r"maximum context length",
    r"input token count.*exceeds the maximum",
    r"maximum prompt length is \d+",
    r"reduce the length of the messages",
    r"exceeds (?:the )?maximum allowed input length",
    r"is longer than the model'?s context length",
    r"context window exceeds limit",
    r"exceeded model token limit",
    r"too large for model with \d+ maximum context length",
    r"range of input length should be",
    r"model_context_window_exceeded",
    r"context[_ ]length[_ ]exceeded",
))
_NOT_OVERFLOW = tuple(re.compile(pattern, re.IGNORECASE) for pattern in (r"rate.?limit", r"too many requests", r"throttl"))


def context_overflow(message: object) -> bool:
    """Whether a provider's error message refuses the request as larger than the model's window (its first 4 KiB)."""
    if not isinstance(message, str) or not message:
        return False
    text = message[:4096]
    return not any(p.search(text) for p in _NOT_OVERFLOW) and any(p.search(text) for p in _OVERFLOW)
