"""A provider's refusal of a request as larger than its model's window is read as the TypeScript workers read it (the
shared cases), and answered with the worker's own code, whatever the provider calls it."""
import json
import time
import unittest
from pathlib import Path

import httpx2
from openai import APIError, BadRequestError, InternalServerError, OpenAI, RateLimitError

import errors
from context_overflow import context_overflow
from errors import classify_error

VECTORS = json.loads((Path(__file__).resolve().parent.parent / "context-overflow-vectors.json").read_text(encoding="utf-8"))
TOO_LONG = "This model's maximum context length is 131072 tokens. However, you requested 140000 tokens."
# Only its error-making: no request is ever sent.
SDK = OpenAI(api_key="synthetic", base_url="https://gate.invalid/v1")


def provider_error(cls, status: int, body: dict):
    response = httpx2.Response(status, request=httpx2.Request("POST", "https://gate.invalid/v1/chat/completions"), json=body)
    return cls(f"Error code: {status} - {body}", response=response, body=body.get("error", body))


def refusal(status: int, body, content_type: str = "application/json"):
    """The error the SDK itself makes of a provider's answer (its message spells out the whole body; its body is the
    body's error field, or the whole body)."""
    content = body if isinstance(body, bytes) else (body if isinstance(body, str) else json.dumps(body, ensure_ascii=False)).encode()
    response = httpx2.Response(status, request=httpx2.Request("POST", "https://gate.invalid/v1/chat/completions"),
                               content=content, headers={"content-type": content_type})
    return SDK._make_status_error_from_response(response)


def nested(depth: int, leaf=None):
    """`leaf` (an empty object unless given) inside `depth` objects nested one in another."""
    value = {} if leaf is None else leaf
    for _ in range(depth):
        value = {"detail": value}
    return value


class ContextOverflowTest(unittest.TestCase):
    def test_shared_cases(self):
        self.assertTrue(any(case["overflow"] for case in VECTORS["cases"]) and not all(case["overflow"] for case in VECTORS["cases"]))
        for case in VECTORS["cases"]:
            self.assertEqual(context_overflow(case["message"]), case["overflow"], case["message"])

    def test_reads_only_a_message_and_its_first_4096_characters(self):
        for value in (None, 413, {"message": "prompt is too long"}):
            self.assertFalse(context_overflow(value))
        self.assertTrue(context_overflow("x" * 4000 + " prompt is too long"))
        self.assertFalse(context_overflow("x" * 4096 + " prompt is too long"))
        # Counted in UTF-16 code units, as the TypeScript twin's slice counts them: a character outside the Basic
        # Multilingual Plane is two (2,036 of them and the words fit in 4,096; 2,047 do not), and a lone surrogate stays
        # one, between the words as in JavaScript.
        self.assertTrue(context_overflow(chr(0x1F600) * 2036 + "maximum context length"))
        self.assertFalse(context_overflow(chr(0x1F600) * 2047 + "maximum context length"))
        self.assertTrue(context_overflow("x" * 4073 + "maximum context length" + chr(0x1F600)))
        self.assertFalse(context_overflow("maxi" + chr(0xD800) + "mum context length"))
        # The edge itself: 2,037 of them and the words are 4,096 units; one more character leaves the words cut.
        self.assertTrue(context_overflow(chr(0x1F600) * 2037 + "maximum context length"))
        self.assertFalse(context_overflow(chr(0x1F600) * 2037 + "x" + "maximum context length"))

    def test_the_patterns_read_a_message_as_javascript_reads_it(self):
        # The TypeScript twin's answers (checked with it): its "." stops at every line terminator, its \d is an ASCII
        # digit, and no letter outside ASCII matches one inside it, whatever its case.
        for message in ("The input token count (5)\rexceeds the maximum", "The input token count (5)" + chr(0x2028) + "exceeds the maximum",
                        "The input token count (5)" + chr(0x2029) + "exceeds the maximum",
                        "maximum prompt length is " + "".join(map(chr, (0x0664, 0x0660, 0x0669, 0x0666))),
                        "prompt i" + chr(0x017F) + " too long", "exceeded model to" + chr(0x212A) + "en limit", "Input " + chr(0x0131) + "s too long",
                        "Input " + chr(0x0130) + "s too long"):
            self.assertFalse(context_overflow(message), repr(message))
        # The one gap left, on the careful side: a character outside the Basic Multilingual Plane between the veto's words
        # is no veto in JavaScript (its ".?" takes one UTF-16 unit) and is one here.
        self.assertFalse(context_overflow("rate" + chr(0x1F600) + "limit: maximum context length"))
        # Its ASCII letters in any case, and a rate limit's veto, which a line terminator between its words also stops.
        self.assertTrue(context_overflow("PROMPT IS TOO LONG"))
        self.assertTrue(context_overflow("The input token count (5) exceeds the maximum"))
        self.assertFalse(context_overflow("rate limit: maximum context length"))
        self.assertTrue(context_overflow("rate\rlimit: maximum context length"))
        self.assertTrue(context_overflow("rate" + chr(0x2028) + "limit: maximum context length"))

    def test_a_providers_size_refusal_is_the_workers_own_code(self):
        by_message = provider_error(BadRequestError, 400, {"error": {"message": "This model's maximum context length is 131072 tokens. However, you requested 140000 tokens.",
                                                                    "type": "invalid_request_error"}})
        self.assertEqual(classify_error(by_message)["code"], "MODEL_CONTEXT_LIMIT")
        by_code = provider_error(BadRequestError, 400, {"error": {"message": "Bad request", "code": "context_length_exceeded"}})
        self.assertEqual(classify_error(by_code)["code"], "MODEL_CONTEXT_LIMIT")
        event = classify_error(by_message)
        self.assertNotIn("131072", json.dumps(event))
        # After an earlier attempt of the same call it is not one made before any work.
        self.assertEqual(classify_error(by_code, requests=2)["code"], "MODEL_REQUEST_REJECTED")
        # Only an HTTP refusal whose JSON body carries no work: usage that counts something (beside its error, inside it,
        # under usage_metadata) or any of an answer makes it the refusal of the request it otherwise is; zero usage, an
        # empty list or an empty text carries nothing.
        for body, code in [
            ({"error": {"code": "context_length_exceeded"}, "usage": {"prompt_tokens": 11, "completion_tokens": 9}}, "MODEL_REQUEST_REJECTED"),
            ({"error": {"code": "context_length_exceeded", "usage": {"input_tokens": 0, "cache": {"read": 3}}}}, "MODEL_REQUEST_REJECTED"),
            ({"error": {"code": "context_length_exceeded"}, "usage_metadata": {"promptTokenCount": 7}}, "MODEL_REQUEST_REJECTED"),
            ({"error": {"code": "context_length_exceeded"}, "choices": [{"message": {"content": "answer"}}]}, "MODEL_REQUEST_REJECTED"),
            ({"error": {"code": "context_length_exceeded", "output": [{"type": "reasoning"}]}}, "MODEL_REQUEST_REJECTED"),
            ({"error": {"code": "context_length_exceeded"}, "usage": {"prompt_tokens": 0, "completion_tokens": 0}, "choices": []}, "MODEL_CONTEXT_LIMIT"),
        ]:
            with self.subTest(body=body):
                self.assertEqual(classify_error(provider_error(BadRequestError, 400, body))["code"], code)
        # A body that is not JSON cannot say it carries no work.
        unreadable = BadRequestError("Error code: 400 - prompt is too long", response=httpx2.Response(
            400, request=httpx2.Request("POST", "https://gate.invalid/v1/chat/completions"),
            content=b'{"error":{"code":"context_length_exceeded"},"usage":{"prompt_tokens":11}'), body=None)
        self.assertEqual(classify_error(unreadable)["code"], "MODEL_REQUEST_REJECTED")
        # Nor does another status naming the context (an outage's, a rate limit's).
        self.assertEqual(classify_error(provider_error(InternalServerError, 500, {"error": {"code": "context_length_exceeded"}}))["code"], "MODEL_UNAVAILABLE")
        self.assertEqual(classify_error(provider_error(RateLimitError, 429, {"error": {"code": "context_length_exceeded"}}))["code"], "MODEL_RATE_LIMIT")
        # Nor does a refusal inside a stream that answered 200 (its status in its body, not the SDK's status_code).
        streamed = APIError("This model's maximum context length is 131072 tokens.", httpx2.Request("POST", "https://gate.invalid/v1/chat/completions"),
                            body={"code": "context_length_exceeded", "status": 400})
        self.assertEqual(classify_error(streamed)["code"], "MODEL_REQUEST_REJECTED")
        # Another refusal of the request, and a rate limit that names the context, are not.
        self.assertEqual(classify_error(provider_error(BadRequestError, 400, {"error": {"message": "messages: text content blocks must be non-empty"}}))["code"],
                         "MODEL_REQUEST_REJECTED")
        self.assertEqual(classify_error(provider_error(RateLimitError, 429, {"error": {"message": "Rate limit reached for the maximum context length per minute"}}))["code"],
                         "MODEL_RATE_LIMIT")

    def test_the_shared_cases_at_400_and_413_through_the_sdks_own_errors(self):
        for status in (400, 413):
            for case in VECTORS["cases"]:
                with self.subTest(status=status, message=case["message"]):
                    code = classify_error(refusal(status, {"error": {"message": case["message"]}}))["code"]
                    self.assertEqual(code, "MODEL_CONTEXT_LIMIT" if case["overflow"] else "MODEL_REQUEST_REJECTED")

    def test_a_size_refusal_is_read_as_the_other_workers_read_one(self):
        # The rule the JavaScript worker and the Pi child keep for one body, with their statuses (a 400 or 413): the
        # provider's own words, work looked for anywhere in a body of at most 64 KiB, a body not typed a stream and JSON
        # as JavaScript reads it.
        for status, body, code, *content_type in [
            # By its code or its type, whatever its message says, and by an error that is only words.
            (400, {"error": {"message": "Bad request", "code": "context_length_exceeded"}}, "MODEL_CONTEXT_LIMIT"),
            (413, {"type": "error", "error": {"type": "request_too_large", "message": "Request exceeds the maximum size"}}, "MODEL_CONTEXT_LIMIT"),
            (400, {"error": TOO_LONG}, "MODEL_CONTEXT_LIMIT"),
            # The provider's own words only: never the SDK's message, which spells out the whole body, words of the
            # request it echoes included, nor words outside its error.
            (400, {"error": {"code": "invalid_request", "details": {"prompt": "Explain maximum context length"}}}, "MODEL_REQUEST_REJECTED"),
            (400, {"error": {"message": "Invalid request"}, "echo": "prompt is too long"}, "MODEL_REQUEST_REJECTED"),
            (400, {"message": TOO_LONG, "code": "context_length_exceeded"}, "MODEL_REQUEST_REJECTED"),
            # Usage that counts nothing and an empty answer carry no work.
            (400, {"error": {"message": TOO_LONG}, "usage": {"prompt_tokens": 0, "completion_tokens": 0}, "choices": []}, "MODEL_CONTEXT_LIMIT"),
            # Work anywhere in its body: usage beside its error, inside it or under a detail of it, under usage_metadata or
            # usageMetadata, or any of an answer; and a body nested too deep to read through.
            (400, {"error": {"message": TOO_LONG}, "usage": {"prompt_tokens": 11}}, "MODEL_REQUEST_REJECTED"),
            (400, {"error": {"message": TOO_LONG, "usage": {"input_tokens": 0, "cache": {"read": 3}}}}, "MODEL_REQUEST_REJECTED"),
            (400, {"error": {"code": "context_length_exceeded", "details": {"usage": {"prompt_tokens": 123, "completion_tokens": 4}}}}, "MODEL_REQUEST_REJECTED"),
            (400, {"error": {"code": "context_length_exceeded"}, "usage": {"cache": {"tokens": {"read": 123}}}}, "MODEL_REQUEST_REJECTED"),
            (400, {"error": {"code": "context_length_exceeded"}, "usage": {"counts": [0, 0, 7]}}, "MODEL_REQUEST_REJECTED"),
            (400, {"error": {"code": "context_length_exceeded"}, "usage": {"prompt_tokens": "11"}}, "MODEL_REQUEST_REJECTED"),
            (400, {"error": {"code": "context_length_exceeded"}, "usage": {"cache": {"tokens": {"read": 0}}, "counts": [0], "total": "0", "model": "m1", "cached": False, "estimated": True}}, "MODEL_CONTEXT_LIMIT"),
            # Usage nested past 64 levels counts (and is read without running out of stack), under that it counts as
            # what it holds.
            (400, {"error": {"message": TOO_LONG}, "usage": nested(500)}, "MODEL_REQUEST_REJECTED"),
            (400, {"error": {"message": TOO_LONG}, "usage": nested(60)}, "MODEL_CONTEXT_LIMIT"),
            (400, {"error": {"message": TOO_LONG}, "usage": nested(64, 0)}, "MODEL_CONTEXT_LIMIT"),
            (400, {"error": {"message": TOO_LONG}, "usage_metadata": {"promptTokenCount": 7}}, "MODEL_REQUEST_REJECTED"),
            (400, {"error": {"message": TOO_LONG}, "usageMetadata": {"promptTokenCount": 7}}, "MODEL_REQUEST_REJECTED"),
            (400, {"error": {"message": TOO_LONG}, "choices": [{"message": {"content": "answer"}}]}, "MODEL_REQUEST_REJECTED"),
            (400, {"error": {"message": TOO_LONG, "output": [{"type": "reasoning"}]}}, "MODEL_REQUEST_REJECTED"),
            (400, {"error": {"message": TOO_LONG, "details": [[{"candidates": [{"index": 0}]}]]}}, "MODEL_REQUEST_REJECTED"),
            # (the body is level 0, its error 1, the details 2: nested(63) puts an object at level 65)
            (400, {"error": {"message": TOO_LONG, "details": nested(63)}}, "MODEL_REQUEST_REJECTED"),
            (400, {"error": {"message": TOO_LONG, "details": nested(62)}}, "MODEL_CONTEXT_LIMIT"),
            (400, {"error": {"message": TOO_LONG, "details": nested(63, "words")}}, "MODEL_CONTEXT_LIMIT"),
            (400, f'{{"error":{{"code":"context_length_exceeded","details":{"[" * 70}{{}}{"]" * 70}}}}}', "MODEL_REQUEST_REJECTED"),
            (400, f'{{"error":{{"code":"context_length_exceeded","details":{"[" * 50}{{}}{"]" * 50}}}}}', "MODEL_CONTEXT_LIMIT"),
            (400, {"error": {"message": TOO_LONG, "details": {"usage": {"prompt_tokens": 0}, "content": "", "choices": []}, "requestId": ""}}, "MODEL_CONTEXT_LIMIT"),
            # A body that cannot say so: JSON typed a stream (in any letters), past 64 KiB of bytes (a body under 64 KiB
            # is read whole), not JSON, or JSON only Python reads (NaN, Infinity).
            (400, {"error": {"message": TOO_LONG}}, "MODEL_REQUEST_REJECTED", "text/event-stream"),
            (400, {"error": {"message": TOO_LONG}}, "MODEL_REQUEST_REJECTED", "Text/Event-Stream; charset=utf-8"),
            (400, TOO_LONG, "MODEL_REQUEST_REJECTED", "text/plain"),
            (400, {"error": {"message": f"{TOO_LONG} {'漢' * 30_000}"}}, "MODEL_REQUEST_REJECTED"),
            (400, {"error": {"message": f"{TOO_LONG} {'漢' * 21_000}"}}, "MODEL_CONTEXT_LIMIT"),
            (400, '{"error":{"code":"context_length_exceeded"},"usage":{"prompt_tokens":NaN}}', "MODEL_REQUEST_REJECTED"),
            (400, '{"error":{"code":"context_length_exceeded"},"usage":{"prompt_tokens":-Infinity}}', "MODEL_REQUEST_REJECTED"),
            # A body as UTF-8 with its byte order mark, as JavaScript's decoder reads one.
            (400, b"\xef\xbb\xbf" + json.dumps({"error": {"message": TOO_LONG}}).encode(), "MODEL_CONTEXT_LIMIT"),
            # Only the first 4,096 UTF-16 code units of the provider's message are read, as JavaScript counts them (not
            # bytes; a character outside the Basic Multilingual Plane is two).
            (400, {"error": {"message": f"{'x' * (4096 - len('maximum context length'))}maximum context length"}}, "MODEL_CONTEXT_LIMIT"),
            (400, {"error": {"message": f"{'x' * 4096} {TOO_LONG}"}}, "MODEL_REQUEST_REJECTED"),
            (400, {"error": {"message": f"{'漢' * 2000} maximum context length"}}, "MODEL_CONTEXT_LIMIT"),
            (400, {"error": {"message": f"{chr(0x1F600) * 2047}maximum context length"}}, "MODEL_REQUEST_REJECTED"),
            (400, {"error": {"message": f"{chr(0x1F600) * 2036}maximum context length"}}, "MODEL_CONTEXT_LIMIT"),
            # Another status, as in the other workers: a 422 (owner 2026-10-25), a rate limit, an outage, and a status
            # past 599, which is neither an outage nor a refusal.
            (422, {"error": {"message": TOO_LONG}}, "MODEL_REQUEST_REJECTED"),
            (422, {"error": {"message": TOO_LONG, "code": "context_length_exceeded"}}, "MODEL_REQUEST_REJECTED"),
            (429, {"error": {"message": TOO_LONG, "code": "context_length_exceeded"}}, "MODEL_RATE_LIMIT"),
            (500, {"error": {"message": TOO_LONG}}, "MODEL_UNAVAILABLE"),
            (599, {"error": {"message": TOO_LONG}}, "MODEL_UNAVAILABLE"),
            (600, {"error": {"message": TOO_LONG}}, "MODEL_ERROR"),
            (799, {"error": {"message": TOO_LONG}}, "MODEL_ERROR"),
        ]:
            with self.subTest(status=status, body=str(body)[:120], content_type=content_type):
                error = refusal(status, body, *content_type)
                self.assertEqual(classify_error(error)["code"], code)
                self.assertEqual(classify_error(error, requests=2)["code"], "MODEL_REQUEST_REJECTED" if code == "MODEL_CONTEXT_LIMIT" else code)

    def test_of_every_status_from_400_to_599_only_a_400_or_413_is_a_size_refusal(self):
        # As in the other workers (a 422 is not: owner 2026-10-25).
        body = {"error": {"message": TOO_LONG, "code": "context_length_exceeded"}}
        sized = [status for status in range(400, 600) if classify_error(refusal(status, body))["code"] == "MODEL_CONTEXT_LIMIT"]
        self.assertEqual(sized, [400, 413])

    def test_a_refusals_words_are_the_providers_own_read_from_its_error_alone(self):
        for body, words in [
            ({"error": {"message": "maximum context length", "code": "context_length_exceeded", "type": "invalid_request_error", "param": "messages"}},
             ["maximum context length", "context_length_exceeded", "invalid_request_error"]),
            ({"type": "error", "error": {"type": "request_too_large", "message": "Request exceeds the maximum size"}},
             ["Request exceeds the maximum size", "request_too_large"]),
            ({"error": "prompt is too long"}, ["prompt is too long"]),
            ({"error": {"code": "invalid_request", "details": {"prompt": "Explain maximum context length"}}, "echo": "prompt is too long"}, ["invalid_request"]),
            ({"message": "maximum context length", "detail": "prompt is too long"}, []),
            ({"error": {"message": {"text": "prompt is too long"}, "code": 400, "type": None}}, []),
            ({"error": ["prompt is too long"]}, []),
        ]:
            self.assertEqual(errors.provider_words(body), words, body)

    def test_words_that_are_a_positive_number_as_javascript_reads_them(self):
        _positive_words = errors._positive_words
        # JavaScript's white space and line terminators are not Python's: U+FEFF is one, U+001F and U+0085 are not.
        for words in ("11", " 7 ", chr(0xA0) + chr(0x3000) + "+3" + chr(0x2028), chr(0xFEFF) + "5", "1e3", "0.5", ".5", "5.", "0x1A", "0o7",
                      "0B1", "Infinity", "+Infinity", "1e400", "00012"):
            self.assertTrue(_positive_words(words), repr(words))
        for words in ("", " ", "0", "-5", "-0.0", "0x0", "0x", "+0x10", "-Infinity", "infinity", "inf", "NaN", "1_000", "1e", ".", "m1",
                      "٥", "١٢", "0x1G", "1 2", chr(0x1F) + "5", chr(0x85) + "5"):
            self.assertFalse(_positive_words(words), repr(words))
        # A long run of digits is judged at once (no repetition of the grammar overlaps another; one that did held a
        # refusal like this one for 19 s), in words and through the classification of a refusal of 64 KiB at most.
        started = time.perf_counter()
        self.assertFalse(_positive_words("1" * 50_000 + "x"))
        self.assertTrue(_positive_words("1" * 50_000))
        long_words = refusal(400, {"error": {"code": "context_length_exceeded"}, "usage": {"prompt_tokens": "1" * 60_000 + "x"}})
        self.assertEqual(classify_error(long_words)["code"], "MODEL_CONTEXT_LIMIT")
        self.assertLess(time.perf_counter() - started, 2.0)


if __name__ == "__main__":
    unittest.main()
