"""A provider's refusal of a request as larger than its model's window is read as the TypeScript workers read it (the
shared cases), and answered with the worker's own code, whatever the provider calls it."""
import json
import unittest
from pathlib import Path

import httpx2
from openai import APIError, BadRequestError, InternalServerError, RateLimitError

from context_overflow import context_overflow
from errors import classify_error

VECTORS = json.loads((Path(__file__).resolve().parent.parent / "context-overflow-vectors.json").read_text(encoding="utf-8"))


def provider_error(cls, status: int, body: dict):
    response = httpx2.Response(status, request=httpx2.Request("POST", "https://gate.invalid/v1/chat/completions"), json=body)
    return cls(f"Error code: {status} - {body}", response=response, body=body.get("error", body))


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

    def test_a_providers_size_refusal_is_the_workers_own_code(self):
        by_message = provider_error(BadRequestError, 400, {"error": {"message": "This model's maximum context length is 131072 tokens. However, you requested 140000 tokens.",
                                                                    "type": "invalid_request_error"}})
        self.assertEqual(classify_error(by_message)["code"], "MODEL_CONTEXT_LIMIT")
        by_code = provider_error(BadRequestError, 400, {"error": {"message": "Bad request", "code": "context_length_exceeded"}})
        self.assertEqual(classify_error(by_code)["code"], "MODEL_CONTEXT_LIMIT")
        event = classify_error(by_message)
        self.assertNotIn("131072", json.dumps(event))
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


if __name__ == "__main__":
    unittest.main()
