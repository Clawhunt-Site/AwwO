import importlib.util
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("materialize_dreamy_target_previews.py")
spec = importlib.util.spec_from_file_location("materialize_dreamy_target_previews", MODULE_PATH)
materialize_dreamy = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(materialize_dreamy)


class MaterializeDreamyTargetPreviewsTest(unittest.TestCase):
    def test_build_report_maps_accepted_dreamy_jobs_to_preview_slugs(self) -> None:
        report = materialize_dreamy.build_preview_report(
            slugs=["luna-star", "aurora-dusk"],
            jobs=[
                {
                    "jobId": "job_image",
                    "pageId": "dreamy-miniapp",
                    "status": "done",
                    "botType": "text-to-image",
                    "botSlug": "seedream-multi-chart",
                    "prompt": "accepted image prompt",
                    "taskId": "dreamy_image_task",
                    "mediaUrl": "https://cdn.example/image.png",
                    "evidence": {"accepted": True, "mediaUrl": "https://cdn.example/image.png", "checkedAt": "2026-06-03T00:00:00Z"},
                },
                {
                    "jobId": "job_video",
                    "pageId": "dreamy-miniapp",
                    "status": "done",
                    "botType": "image-to-video",
                    "botSlug": "video-source-bot",
                    "prompt": "accepted video prompt",
                    "taskId": "dreamy_video_task",
                    "mediaUrl": "https://cdn.example/video.mp4",
                    "posterUrl": "https://cdn.example/video.jpg",
                    "evidence": {"accepted": True, "mediaUrl": "https://cdn.example/video.mp4", "checkedAt": "2026-06-03T00:01:00Z"},
                },
            ],
            checked_at="2026-06-03T00:02:00Z",
        )

        self.assertEqual(report["summary"]["planned"], 2)
        self.assertEqual(report["summary"]["executed"], 2)
        self.assertEqual(report["summary"]["failed"], 0)
        image = report["previews"]["luna-star"]
        self.assertTrue(image["targetBotExecuted"])
        self.assertEqual(image["remoteUrl"], "https://cdn.example/image.png")
        self.assertEqual(image["execution"]["executor"], "dreamy-server")
        self.assertEqual(image["execution"]["sourceJobId"], "job_image")
        self.assertEqual(image["execution"]["sourceBotSlug"], "seedream-multi-chart")
        video = report["previews"]["aurora-dusk"]
        self.assertEqual(video["remoteUrl"], "https://cdn.example/video.mp4")
        self.assertEqual(video["posterUrl"], "https://cdn.example/video.jpg")
        self.assertEqual(video["execution"]["sourceJobId"], "job_video")

    def test_build_report_refuses_unaccepted_jobs(self) -> None:
        report = materialize_dreamy.build_preview_report(
            slugs=["luna-star"],
            jobs=[
                {
                    "jobId": "job_unaccepted",
                    "pageId": "dreamy-miniapp",
                    "status": "done",
                    "botType": "text-to-image",
                    "mediaUrl": "https://cdn.example/image.png",
                    "evidence": {"accepted": False, "mediaUrl": "https://cdn.example/image.png"},
                }
            ],
            checked_at="2026-06-03T00:02:00Z",
        )

        self.assertEqual(report["summary"]["executed"], 0)
        self.assertEqual(report["summary"]["failed"], 1)
        self.assertEqual(report["results"][0]["status"], "missing")
        self.assertEqual(report["previews"], {})


if __name__ == "__main__":
    unittest.main()
