import importlib.util
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("probe_myshell_art_api.py")
spec = importlib.util.spec_from_file_location("probe_myshell_art_api", MODULE_PATH)
probe = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(probe)


class ProbeMyShellArtApiTest(unittest.TestCase):
    def test_build_headers_uses_ms_token_without_exposing_it_in_summary(self) -> None:
        cookies = [
            {"name": "ms_token", "value": "secret-token", "domain": ".myshell.ai"},
            {"name": "VISITOR_ID", "value": "visitor-1", "domain": ".myshell.ai"},
        ]

        headers = probe.build_headers(cookies, now_ms=1_780_000_000_000)
        summary = probe.safe_probe_summary(
            {
                "success": True,
                "data": {"userId": "user-1", "nickname": "Alice", "token": "secret-token"},
            }
        )

        self.assertEqual(headers["Authorization"], "Bearer secret-token")
        self.assertIn("ms_token=secret-token", headers["Cookie"])
        self.assertNotIn("secret-token", str(summary))
        self.assertEqual(summary["dataKeys"], ["nickname", "token", "userId"])

    def test_safe_probe_summary_accepts_current_top_level_payloads(self) -> None:
        summary = probe.safe_probe_summary({"userDetail": {"summary": {"id": "user-1"}}})

        self.assertTrue(summary["success"])
        self.assertEqual(summary["dataKeys"], ["userDetail"])

    def test_generate_body_omits_empty_article_id(self) -> None:
        body = probe.generate_body("1751532766", [], "")

        self.assertEqual(body, {"botId": "1751532766", "inputImg": []})

    def test_cookie_header_skips_values_that_cannot_be_sent_as_http_headers(self) -> None:
        header = probe.cookie_header(
            [
                {"name": "ms_token", "value": "secret-token"},
                {"name": "localized", "value": "中文"},
            ]
        )

        self.assertIn("ms_token=secret-token", header)
        self.assertNotIn("localized", header)

    def test_build_headers_skips_authorization_when_ms_token_is_not_header_safe(self) -> None:
        headers = probe.build_headers([{"name": "ms_token", "value": "bad\ufffdtoken"}])

        self.assertNotIn("Authorization", headers)

    def test_run_probe_execute_uses_supplied_input_values(self) -> None:
        calls = []

        def fake_post(path, body, cookies, timeout=30.0):
            calls.append((path, body))
            if path == "/v1/user/get_info":
                return {"httpStatus": 200, "payload": {"success": True, "data": {"userId": "u1"}}}
            if path == "/v1/homepage/art/task/running":
                return {"httpStatus": 200, "payload": {"success": True, "data": {}}}
            if path == "/v1/homepage/art/generate":
                return {"httpStatus": 200, "payload": {"success": True, "data": {"outputJobId": "job-1"}}}
            if path == "/v1/homepage/art/generate_result":
                return {
                    "httpStatus": 200,
                    "payload": {
                        "success": True,
                        "data": {
                            "tasks": [
                                {
                                    "result": '{"outputImg":"https://cdn.example/brat.png"}',
                                }
                            ]
                        },
                    },
                }
            raise AssertionError(path)

        report = probe.run_probe(
            [{"name": "ms_token", "value": "secret-token"}],
            bot_id="1751532766",
            execute=True,
            input_values=["lime green cover text"],
            poster=fake_post,
            sleep=lambda _seconds: None,
        )

        self.assertEqual(report["status"], "ready")
        self.assertEqual(
            calls[2],
            (
                "/v1/homepage/art/generate",
                {"botId": "1751532766", "inputImg": ["lime green cover text"]},
            ),
        )
        self.assertEqual(report["generationResult"]["mediaUrl"], "https://cdn.example/brat.png")

    def test_run_probe_execute_skips_generation_when_auth_probe_fails(self) -> None:
        calls = []

        def fake_post(path, body, cookies, timeout=30.0):
            calls.append(path)
            if path == "/v1/user/get_info":
                return {"httpStatus": 401, "payload": {"success": False, "reason": "UNAUTHORIZED"}}
            if path == "/v1/homepage/art/task/running":
                return {"httpStatus": 401, "payload": {"success": False, "reason": "UNAUTHORIZED"}}
            raise AssertionError(f"generation should not be called: {path}")

        report = probe.run_probe(
            [{"name": "ms_token", "value": "expired-token"}],
            bot_id="1751532766",
            execute=True,
            input_values=["lime green cover text"],
            poster=fake_post,
        )

        self.assertEqual(report["status"], "blocked")
        self.assertEqual(calls, ["/v1/user/get_info", "/v1/homepage/art/task/running"])


if __name__ == "__main__":
    unittest.main()
