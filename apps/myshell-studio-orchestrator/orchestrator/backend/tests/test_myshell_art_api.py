import sys
import unittest
from pathlib import Path


BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))

from studio_app.infrastructure.adapters.myshell_art import api as myshell_art_api  # noqa: E402


class MyShellArtApiTest(unittest.IsolatedAsyncioTestCase):
    def test_safe_probe_summary_accepts_current_top_level_payloads(self) -> None:
        summary = myshell_art_api._safe_probe_summary({"httpStatus": 200, "payload": {"running": []}})

        self.assertTrue(summary["success"])
        self.assertEqual(summary["dataKeys"], ["running"])

    async def test_generate_via_art_api_submits_input_values_and_extracts_media(self) -> None:
        calls = []

        async def fake_post(path, body, cookies, timeout=30.0):
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
                        "data": {"tasks": [{"result": '{"outputImg":"https://cdn.example/brat.png"}'}]},
                    },
                }
            raise AssertionError(path)

        result = await myshell_art_api.generate_via_art_api(
            bot_id="1751532766",
            input_values=["lime green cover text"],
            cookies=[{"name": "ms_token", "value": "secret-token"}],
            requester=fake_post,
            sleep=lambda _seconds: None,
        )

        self.assertEqual(result["status"], "done")
        self.assertEqual(result["output_url"], "https://cdn.example/brat.png")
        self.assertEqual(
            calls[2],
            (
                "/v1/homepage/art/generate",
                {"botId": "1751532766", "inputImg": ["lime green cover text"]},
            ),
        )

    async def test_generate_via_art_api_does_not_submit_when_auth_fails(self) -> None:
        calls = []

        async def fake_post(path, body, cookies, timeout=30.0):
            calls.append(path)
            if path == "/v1/user/get_info":
                return {"httpStatus": 401, "payload": {"success": False, "reason": "UNAUTHORIZED"}}
            if path == "/v1/homepage/art/task/running":
                return {"httpStatus": 401, "payload": {"success": False, "reason": "UNAUTHORIZED"}}
            raise AssertionError(f"generation should not be called: {path}")

        result = await myshell_art_api.generate_via_art_api(
            bot_id="1751532766",
            input_values=["lime green cover text"],
            cookies=[{"name": "ms_token", "value": "expired"}],
            requester=fake_post,
        )

        self.assertEqual(result["status"], "auth_missing")
        self.assertEqual(calls, ["/v1/user/get_info", "/v1/homepage/art/task/running"])


if __name__ == "__main__":
    unittest.main()
