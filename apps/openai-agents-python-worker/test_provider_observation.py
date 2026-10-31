"""Numeric wire contract and SSE boundaries; all inputs are synthetic provider data."""
import json
import unittest

from errors import RuntimeError
from provider_observation import MAX_FRAME, ProviderObservation, normalize_usage


class ProviderObservationTests(unittest.TestCase):
    def test_known_numeric_fields_only_and_invalid_values_never_become_zero(self):
        for bad in [True, -1, 0.5, "1", 9007199254740992]:
            with self.subTest(bad=bad):
                usage = normalize_usage({"prompt_tokens": bad, "completion_tokens": 0}, "chat_completions")
                self.assertEqual(usage["status"], "invalid")
                self.assertIsNone(usage["inputTokens"])
        for raw in [[], {"input_tokens": 3, "output_tokens": 1, "total_tokens": 9},
                    {"input_tokens": 3, "output_tokens": 1, "input_tokens_details": {"cached_tokens": 4}},
                    {"input_tokens": 3, "output_tokens": 1, "output_tokens_details": {"reasoning_tokens": 2}}]:
            with self.subTest(raw=raw):
                self.assertEqual(normalize_usage(raw, "responses")["status"], "invalid")
        usage = normalize_usage({"input_tokens": 0, "output_tokens": 0, "private": "SECRET"}, "responses")
        self.assertEqual(usage["status"], "reported")
        self.assertEqual(usage["computedTotalTokens"], 0)
        self.assertIsNone(usage["cachedInputTokens"])
        self.assertNotIn("SECRET", json.dumps(usage))

    def test_a_cache_write_count_is_a_subset_of_the_input_taken_only_where_it_fits(self):
        # The Bedrock bridge's report of a call: Converse's input, reads and writes all counted as prompt tokens.
        bridged = normalize_usage({"prompt_tokens": 5635, "completion_tokens": 48,
                                   "prompt_tokens_details": {"cached_tokens": 5575, "cache_write_tokens": 58}}, "chat_completions")
        self.assertEqual((bridged["status"], bridged["inputTokens"], bridged["cachedInputTokens"], bridged["cacheWriteTokens"],
                          bridged["computedTotalTokens"]), ("reported", 5635, 5575, 58, 5683))
        self.assertEqual(normalize_usage({"prompt_tokens": 9, "completion_tokens": 2, "prompt_tokens_details": {"cache_write_tokens": 6}},
                                         "chat_completions")["cacheWriteTokens"], 6)
        self.assertEqual(normalize_usage({"input_tokens": 20, "output_tokens": 1,
                                          "input_tokens_details": {"cached_tokens": 7, "cache_write_tokens": 13}}, "responses")["cacheWriteTokens"], 13)
        # A count that does not fit, or is no count, is left out and the report stands as it did before writes were read.
        for details in ({"cached_tokens": 5, "cache_write_tokens": 6}, {"cache_write_tokens": 11}, {"cache_write_tokens": -1},
                        {"cache_write_tokens": 1.5}, {"cache_write_tokens": "3"}, {"cache_write_tokens": True}):
            with self.subTest(details=details):
                usage = normalize_usage({"prompt_tokens": 10, "completion_tokens": 2, "prompt_tokens_details": details}, "chat_completions")
                self.assertEqual((usage["status"], usage["cacheWriteTokens"], usage["inputTokens"]), ("reported", None, 10))
        self.assertIsNone(normalize_usage({"completion_tokens": 2, "prompt_tokens_details": {"cache_write_tokens": 3}},
                                          "chat_completions")["cacheWriteTokens"])
        # A report that is invalid for another reason (a malformed read, reasoning beyond the output) keeps no write either.
        for raw in ({"prompt_tokens": 10, "completion_tokens": 2, "prompt_tokens_details": {"cached_tokens": "x", "cache_write_tokens": 3}},
                    {"prompt_tokens": 10, "completion_tokens": 2, "prompt_tokens_details": {"cache_write_tokens": 3},
                     "completion_tokens_details": {"reasoning_tokens": 5}}):
            with self.subTest(raw=raw):
                usage = normalize_usage(raw, "chat_completions")
                self.assertEqual((usage["status"], usage["cacheWriteTokens"]), ("invalid", None))

    def test_split_crlf_utf8_and_multiline_frames_preserve_raw_usage_and_finish(self):
        observer = ProviderObservation("chat_completions")
        raw = ('data: {"choices":[{"index":0,"delta":{"content":"你好"},"finish_reason":"length"}],\r\n'
               'data: "usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\r\n\r\n'
               'data: [DONE]\r\n\r\n').encode()
        for byte in raw:
            observer.feed(bytes([byte]))
        observer.feed(b"", final=True)
        with self.assertRaises(RuntimeError) as failed:
            observer.require_complete()
        self.assertEqual(failed.exception.code, "MODEL_OUTPUT_LIMIT")
        snapshot = observer.snapshot("failed")
        self.assertEqual(snapshot["usage"]["providerTotalTokens"], 5)
        self.assertEqual(snapshot["usage"]["status"], "reported")
        self.assertNotIn("你好", json.dumps(snapshot, ensure_ascii=False))

    def test_responses_done_marker_does_not_substitute_for_authoritative_terminal(self):
        observer = ProviderObservation("responses")
        observer.feed(b'data: {"type":"response.output_text.delta","delta":"partial"}\n\ndata: [DONE]\n\n', final=True)
        with self.assertRaises(RuntimeError) as failed:
            observer.require_complete()
        self.assertEqual(failed.exception.code, "MODEL_PROTOCOL_ERROR")

    def test_conflicting_finish_or_oversized_frame_cannot_be_completed(self):
        first = b'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n'
        other = b'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n'
        for raw in [first + other + b'data: [DONE]\n\n', b'data: ' + b'x' * (MAX_FRAME + 1) + b'\n\n' + first + b'data: [DONE]\n\n']:
            with self.subTest(size=len(raw)):
                observer = ProviderObservation("chat_completions")
                observer.feed(raw, final=True)
                with self.assertRaises(RuntimeError) as failed:
                    observer.require_complete()
                self.assertEqual(failed.exception.code, "MODEL_PROTOCOL_ERROR")
                self.assertLessEqual(len(observer._line) + sum(map(len, observer._data)), MAX_FRAME)


if __name__ == "__main__":
    unittest.main()
