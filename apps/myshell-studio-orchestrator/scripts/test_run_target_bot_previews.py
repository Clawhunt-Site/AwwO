import importlib.util
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).with_name("run_target_bot_previews.py")
spec = importlib.util.spec_from_file_location("run_target_bot_previews", MODULE_PATH)
run_target = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(run_target)


class RunTargetBotPreviewsTest(unittest.IsolatedAsyncioTestCase):
    def test_extracts_public_art_metadata_for_target_slug(self) -> None:
        html = r'''
        self.__next_f.push([1,"...\"botId\":\"1751532766\",\"template\":\"template1\",\"floorUrl\":\"creative\",\"singleText\":\"{\\\"title\\\":\\\"Create Iconic Brat Album Covers Instantly\\\",\\\"button_text\\\":\\\"Generate Brat Cover\\\",\\\"inputComponents\\\":[{\\\"type\\\":\\\"prompt\\\"}]}\",\"slugId\":\"brat-generator\",\"metaTitle\":\"Brat Generator\"..."]);
        self.__next_f.push([1,"...\"botId\":\"1764310790\",\"template\":\"template4\",\"floorUrl\":\"creative\",\"singleText\":\"$1a\",\"slugId\":\"urban-whimsy-filter\",\"metaTitle\":\"Fisheye Lens Filter\"..."]);
        '''

        metadata = run_target.extract_public_art_metadata(html, "brat-generator")

        self.assertEqual(metadata["targetBotId"], "1751532766")
        self.assertEqual(metadata["targetSlugId"], "brat-generator")
        self.assertEqual(metadata["template"], "template1")
        self.assertEqual(metadata["buttonText"], "Generate Brat Cover")

    def test_plan_can_include_resolved_public_metadata(self) -> None:
        def fake_resolver(slug: str) -> dict[str, str]:
            self.assertEqual(slug, "brat-generator")
            return {
                "targetBotId": "1751532766",
                "targetSlugId": "brat-generator",
                "template": "template1",
                "buttonText": "Generate Brat Cover",
            }

        plan = run_target.build_run_plan(
            slugs=["brat-generator"],
            include_dreamy=False,
            public_metadata_resolver=fake_resolver,
        )

        self.assertEqual(plan[0]["targetBotId"], "1751532766")
        self.assertEqual(plan[0]["targetSlugId"], "brat-generator")
        self.assertEqual(plan[0]["targetTemplate"], "template1")

    async def test_run_selected_art_bot_marks_target_execution(self) -> None:
        calls = []

        async def fake_runner(**kwargs):
            calls.append(kwargs)
            return {"status": "done", "output_url": "https://cdn.example/brat.png", "task_id": "task-1"}

        report = await run_target.run_preview_batch(
            slugs=["brat-generator"],
            runner=fake_runner,
            include_dreamy=False,
        )

        self.assertEqual(report["summary"]["executed"], 1)
        self.assertEqual(report["summary"]["failed"], 0)
        self.assertEqual(calls[0]["bot_slug"], "brat-generator")
        self.assertEqual(calls[0]["gen_button"], "Generate Brat Cover")
        entry = report["previews"]["brat-generator"]
        self.assertEqual(entry["remoteUrl"], "https://cdn.example/brat.png")
        self.assertEqual(entry["source"], "myshell-target-bot-cdp")
        self.assertTrue(entry["targetBotExecuted"])
        self.assertEqual(entry["execution"]["status"], "done")

    async def test_art_api_executor_passes_target_metadata_and_input_values(self) -> None:
        calls = []

        async def fake_runner(**kwargs):
            calls.append(kwargs)
            return {
                "status": "done",
                "output_url": "https://cdn.example/brat-api.png",
                "task_id": "api-job-1",
                "executor": "myshell-art-api",
            }

        report = await run_target.run_preview_batch(
            slugs=["brat-generator"],
            runner=fake_runner,
            include_dreamy=False,
            executor_mode="art-api",
            public_metadata_resolver=lambda _slug: {
                "targetBotId": "1751532766",
                "targetSlugId": "brat-generator",
                "template": "template1",
                "buttonText": "Generate Brat Cover",
            },
        )

        self.assertEqual(calls[0]["target_bot_id"], "1751532766")
        self.assertEqual(calls[0]["target_article_id"], "brat-generator")
        self.assertEqual(calls[0]["input_values"], [report["previews"]["brat-generator"]["prompt"]])
        entry = report["previews"]["brat-generator"]
        self.assertEqual(entry["source"], "myshell-target-bot-api")
        self.assertEqual(entry["execution"]["executor"], "myshell-art-api")
        self.assertEqual(entry["execution"]["targetBotId"], "1751532766")

    async def test_default_art_api_runner_passes_article_id_and_poll_options(self) -> None:
        calls = []

        async def fake_generate_via_art_api(**kwargs):
            calls.append(kwargs)
            return {
                "status": "done",
                "output_url": "https://cdn.example/brat-api.png",
                "task_id": "api-job-1",
                "executor": "myshell-art-api",
            }

        fake_module = types.SimpleNamespace(generate_via_art_api=fake_generate_via_art_api)

        with patch.dict(sys.modules, {"myshell_art_api": fake_module}):
            runner = run_target._default_art_api_runner(poll_attempts=7, poll_interval=2.5)
            result = await runner(
                target_bot_id="1751532766",
                target_article_id="brat-generator",
                input_values=["lime green brat album cover text"],
            )

        self.assertEqual(result["status"], "done")
        self.assertEqual(calls[0]["bot_id"], "1751532766")
        self.assertEqual(calls[0]["article_id"], "brat-generator")
        self.assertEqual(calls[0]["poll_attempts"], 7)
        self.assertEqual(calls[0]["poll_interval"], 2.5)

    async def test_art_api_executor_uses_manifest_remote_source_for_image_inputs(self) -> None:
        calls = []

        async def fake_runner(**kwargs):
            calls.append(kwargs)
            return {
                "status": "done",
                "output_url": "https://cdn.example/seedream-output.png",
                "task_id": "api-job-image-1",
                "executor": "myshell-art-api",
            }

        with tempfile.TemporaryDirectory() as tmp_dir:
            manifest_path = Path(tmp_dir) / "manifest.json"
            manifest_path.write_text(
                json.dumps(
                    {
                        "assets": [
                            {
                                "id": "seedream-multi-chart",
                                "botSlug": "seedream-multi-chart",
                                "originalRemoteUrl": "https://cdn.example/source-seedream.png",
                            }
                        ],
                        "botPreviews": {"seedream-multi-chart": {"assetId": "seedream-multi-chart"}},
                    }
                ),
                encoding="utf-8",
            )
            with patch.object(run_target, "DEFAULT_PREVIEW_MANIFEST", manifest_path):
                report = await run_target.run_preview_batch(
                    slugs=["seedream-multi-chart"],
                    runner=fake_runner,
                    include_dreamy=False,
                    executor_mode="art-api",
                    public_metadata_resolver=lambda _slug: {
                        "targetBotId": "1785902750",
                        "targetSlugId": "seedream-multi-chart",
                        "template": "template1",
                        "buttonText": "Generate",
                    },
                )

        self.assertEqual(calls[0]["input_values"], ["https://cdn.example/source-seedream.png"])
        self.assertEqual(calls[0]["image_data"], "")
        self.assertEqual(report["previews"]["seedream-multi-chart"]["execution"]["targetBotId"], "1785902750")

    async def test_failed_target_run_does_not_mark_executed(self) -> None:
        async def fake_runner(**_kwargs):
            return {"status": "error", "message": "Generate button not found"}

        report = await run_target.run_preview_batch(
            slugs=["brat-generator"],
            runner=fake_runner,
            include_dreamy=False,
        )

        self.assertEqual(report["summary"]["executed"], 0)
        self.assertEqual(report["summary"]["failed"], 1)
        self.assertNotIn("brat-generator", report["previews"])
        self.assertEqual(report["results"][0]["status"], "error")

    def test_plan_requires_source_image_for_image_input_bots(self) -> None:
        plan = run_target.build_run_plan(slugs=["seedream-multi-chart"], include_dreamy=False)

        self.assertEqual(len(plan), 1)
        self.assertEqual(plan[0]["botSlug"], "seedream-multi-chart")
        self.assertTrue(plan[0]["requiresImage"])
        self.assertIn("sourceImage", plan[0])

    def test_default_plan_targets_art_bots_only(self) -> None:
        plan = run_target.build_run_plan()
        slugs = {item["botSlug"] for item in plan}

        self.assertIn("brat-generator", slugs)
        self.assertNotIn("ai-porn-generator", slugs)


if __name__ == "__main__":
    unittest.main()
