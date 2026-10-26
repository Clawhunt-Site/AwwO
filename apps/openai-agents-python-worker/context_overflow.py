"""A provider's refusal of a request as larger than its model's context window.

The Python twin of apps/context-overflow.ts (see that file for the rationale and the sources of the patterns): the
provider's own error message is read inside the worker and never relayed, and the worker answers the refusal with its
closed code (MODEL_CONTEXT_LIMIT), so the API settles it as the size refusal it is. Shared cases:
apps/context-overflow-vectors.json.
"""

from __future__ import annotations

import re

# Read as the TypeScript twin's regular expressions read a message (JavaScript's dialect, not Python's): its "." stops at
# every line terminator (LF, CR, U+2028, U+2029), so it is written out where the patterns need it; its \d is an ASCII
# digit; and with its case ignored no letter outside ASCII matches one inside it (re.ASCII), as Python's case folding of
# U+017F, U+0130, U+0131 and the Kelvin sign would. One gap is left, on the careful side: JavaScript matches a UTF-16
# code unit at a time, so the rate limit's "rate.?limit" cannot span a character outside the Basic Multilingual Plane
# (two units) there, and here it can: such a message is vetoed, and so charged, here alone.
_DOT = "[^" + "".join(map(chr, (0x0A, 0x0D, 0x2028, 0x2029))) + "]"
_OVERFLOW = tuple(re.compile(pattern, re.IGNORECASE | re.ASCII) for pattern in (
    r"prompt is too long",
    r"exceeds? (?:the )?context limit",
    r"input is too long",
    r"number of input tokens exceeds",
    r"request_too_large",
    r"exceeds the context window",
    r"maximum context length",
    rf"input token count{_DOT}*exceeds the maximum",
    r"maximum prompt length is \d+",
    r"reduce the length of the messages",
    r"exceeds (?:the )?maximum allowed input length",
    r"is longer than the model'?s context length",
    r"context window exceeds limit",
    r"exceeded model token limit",
    r"too large for model with \d+ maximum context length",
    r"range of input length should be",
    r"context[_ ]length[_ ]exceeded",
))
_NOT_OVERFLOW = tuple(re.compile(pattern, re.IGNORECASE | re.ASCII) for pattern in (rf"rate{_DOT}?limit", r"too many requests", r"throttl"))


def context_overflow(message: object) -> bool:
    """Whether a provider's error message refuses the request as larger than the model's window: its first 4,096 UTF-16
    code units, as the TypeScript twin's slice counts them (a character outside the Basic Multilingual Plane is two, and a
    lone surrogate stays one), not its first 4,096 code points."""
    if not isinstance(message, str) or not message:
        return False
    text = message[:4096].encode("utf-16-le", "surrogatepass")[:8192].decode("utf-16-le", "surrogatepass")
    return not any(p.search(text) for p in _NOT_OVERFLOW) and any(p.search(text) for p in _OVERFLOW)
