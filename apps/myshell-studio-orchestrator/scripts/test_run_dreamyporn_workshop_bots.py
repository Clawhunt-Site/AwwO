from __future__ import annotations

import json
import sys
import unittest
import asyncio
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import run_dreamyporn_workshop_bots as runner  # noqa: E402


def _flight_html(info: dict) -> str:
    payload = '7:[["$","$L16",null,{"info":' + json.dumps(info) + ',"showFooter":true}]]'
    return f'<script>self.__next_f.push([1,{json.dumps(payload)}])</script>'


class DreamyPornWorkshopRunnerTest(unittest.TestCase):
    def test_extract_detail_info_reads_next_flight_payload(self) -> None:
        info = {
            "botName": "AI Oil Massage",
            "botId": "1779936515",
            "slugId": "ai-oil-massage",
            "template": "template6",
            "singleText": json.dumps(
                {
                    "title": "AI Oil Massage",
                    "form": [{"title": "Drop any Photo", "component": "Uploader", "index": 0, "options": []}],
                }
            ),
        }

        parsed = runner.extract_detail_info(_flight_html(info))

        self.assertEqual(parsed["botId"], "1779936515")
        self.assertEqual(parsed["slugId"], "ai-oil-massage")
        self.assertEqual(parsed["singleTextJson"]["form"][0]["component"], "Uploader")

    def test_form_values_fill_supported_components_in_order(self) -> None:
        form = [
            {"title": "Mood", "component": "RadioGroup", "index": 2, "options": [{"value": "cinematic"}]},
            {"title": "Drop any Photo", "component": "Uploader", "index": 0},
            {"title": "Prompt", "component": "Textarea", "index": 1, "default": ""},
            {"title": "Optional", "component": "Input", "index": 3, "required": False},
        ]

        values = runner._form_values(form, source_image_url="https://cdn.example/source.jpg", prompt="verify prompt")

        self.assertEqual(values, ["https://cdn.example/source.jpg", "verify prompt", "cinematic", "verify prompt"])

    def test_form_values_support_multi_uploaders(self) -> None:
        form = [{"title": "Photos", "component": "Uploader", "index": 0, "multi": True}]

        values = runner._form_values(form, source_image_url="https://cdn.example/source.jpg", prompt="ignored")

        self.assertEqual(json.loads(values[0]), ["https://cdn.example/source.jpg"])

    def test_render_html_report_exposes_done_and_active_items(self) -> None:
        output = SCRIPT_DIR / ".tmp-dreamy-workshop-report.html"
        try:
            runner.render_html_report(
                {
                    "summary": {"done": 1, "running": 1, "queueFull": 1, "cancelled": 1},
                    "results": [
                        {
                            "slug": "done-bot",
                            "name": "Done Bot",
                            "status": "done",
                            "taskId": "task-done",
                            "mediaUrl": "https://cdn.example/done.mp4",
                            "posterUrl": "https://cdn.example/done.jpg",
                        },
                        {
                            "slug": "image-bot",
                            "name": "Image Bot",
                            "status": "done",
                            "taskId": "task-image",
                            "mediaUrl": "https://cdn.example/image.png",
                        },
                        {"slug": "active-bot", "name": "Active Bot", "status": "running", "taskId": "task-active"},
                        {"slug": "queued-bot", "name": "Queued Bot", "status": "queue_full", "articleId": "queued-bot"},
                        {"slug": "cancelled-bot", "name": "Cancelled Bot", "status": "cancelled", "taskId": "task-cancelled"},
                    ],
                },
                output,
            )
            html = output.read_text(encoding="utf-8")
        finally:
            output.unlink(missing_ok=True)

        self.assertIn("https://cdn.example/done.mp4", html)
        self.assertIn('<img class="media"', html)
        self.assertIn("Active Bot", html)
        self.assertIn("queue_full", html)
        self.assertIn("Cancelled Bot", html)

    def test_poll_task_records_dreamy_error_message(self) -> None:
        original_request = runner._dreamyporn_web_request
        original_media = runner._dreamyporn_web_task_media

        async def fake_request(_url: str, _body: dict) -> dict:
            return {
                "tasks": [
                    {
                        "jobId": "task-error",
                        "status": "error",
                        "result": {"errMsg": "widget failed"},
                    }
                ]
            }

        def fake_media(_payload: dict, _task_id: str) -> dict:
            return {"status": "error", "queuePosition": "0"}

        try:
            runner._dreamyporn_web_request = fake_request
            runner._dreamyporn_web_task_media = fake_media
            record = {"taskId": "task-error", "message": "old queue full"}
            asyncio.run(runner._poll_task(record))
        finally:
            runner._dreamyporn_web_request = original_request
            runner._dreamyporn_web_task_media = original_media

        self.assertEqual(record["status"], "error")
        self.assertEqual(record["message"], "widget failed")


if __name__ == "__main__":
    unittest.main()
