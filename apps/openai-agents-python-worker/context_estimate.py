"""How many input tokens a text can take, from its characters: the Python twin of apps/context-estimate.ts (see there
for the measurements behind it). A word is a run of code points that are neither ASCII whitespace nor CJK, the
whitespace before it going with it; a word longer than 32 code points, or one holding an ASCII digit, counts byte for
byte (strict) with its whitespace; in any other word a non-ASCII code point is strict and the rest is prose; a CJK
character, and the whitespace before one, is prose. The estimate is strict + ceil(prose / proseBytesPerToken): the
text's UTF-8 bytes at a rate of 1. apps/context-estimate-vectors.json holds the cases every implementation agrees on."""

from __future__ import annotations

import math

PROSE_RATE_MIN = 1.0
PROSE_RATE_MAX = 4.0
_LONG_WORD = 32


def _cjk(cp: int) -> bool:
    return 0x2E80 <= cp <= 0x9FFF or 0xAC00 <= cp <= 0xD7AF or 0xF900 <= cp <= 0xFAFF or 0xFF00 <= cp <= 0xFFEF


def _utf8(cp: int) -> int:
    # As the TypeScript side counts (Buffer.byteLength writes a lone surrogate as U+FFFD, 3 bytes); never raises.
    return 1 if cp < 0x80 else 2 if cp < 0x800 else 3 if cp < 0x10000 else 4


def text_cost(text: str) -> tuple[int, int]:
    """A text's (strict, prose) bytes; together its UTF-8 bytes."""
    strict = prose = 0
    space = word_bytes = word_ascii = word_length = 0
    word_digit = False
    for ch in text:
        cp = ord(ch)
        if cp == 0x20 or 0x09 <= cp <= 0x0D:
            if word_length:
                if word_length > _LONG_WORD or word_digit:
                    strict += space + word_bytes
                else:
                    prose += space + word_ascii
                    strict += word_bytes - word_ascii
                space = word_bytes = word_ascii = word_length = 0
                word_digit = False
            space += 1
        elif _cjk(cp):
            if word_length > _LONG_WORD or word_digit:
                strict += space + word_bytes
            else:
                prose += space + word_ascii
                strict += word_bytes - word_ascii
            space = word_bytes = word_ascii = word_length = 0
            word_digit = False
            prose += 3
        else:
            word_bytes += _utf8(cp)
            if cp < 0x80:
                word_ascii += 1
            if 0x30 <= cp <= 0x39:
                word_digit = True
            word_length += 1
    if word_length > _LONG_WORD or word_digit:
        strict += space + word_bytes
    else:
        prose += space + word_ascii
        strict += word_bytes - word_ascii
    return strict, prose


def estimate_tokens(text: str, prose_bytes_per_token: float = PROSE_RATE_MIN) -> int:
    """A text's estimated input tokens at a model's prose rate (1: its UTF-8 bytes)."""
    strict, prose = text_cost(text)
    if not prose_bytes_per_token > PROSE_RATE_MIN:
        return strict + prose
    return strict + math.ceil(prose / min(prose_bytes_per_token, PROSE_RATE_MAX))


# What a profile or catalog entry without the field passes (value.get("proseBytesPerToken", ABSENT)): JSON null is a
# value, and refused, as the TypeScript side refuses it.
ABSENT = object()


def prose_rate(value: object = ABSENT) -> float:
    """A profile's declared rate, checked: ABSENT means 1; otherwise a number from 1 to 4 in steps of 0.05, or ValueError,
    so a misspelt rate never loosens a budget."""
    if value is ABSENT:
        return PROSE_RATE_MIN
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) \
            or not PROSE_RATE_MIN <= value <= PROSE_RATE_MAX or abs(value * 20 - round(value * 20)) > 1e-9:
        raise ValueError("Invalid proseBytesPerToken")
    return float(value)
