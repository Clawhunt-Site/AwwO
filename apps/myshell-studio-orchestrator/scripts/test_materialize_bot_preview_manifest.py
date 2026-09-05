import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("materialize_bot_preview_manifest.py")
spec = importlib.util.spec_from_file_location("materialize_bot_preview_manifest", MODULE_PATH)
materialize = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(materialize)


class MaterializeBotPreviewManifestTest(unittest.TestCase):
    def test_load_url_map_accepts_target_runner_preview_report(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "target-report.json"
            path.write_text(
                json.dumps(
                    {
                        "version": "target-run",
                        "summary": {"planned": 1, "executed": 1},
                        "previews": {
                            "brat-generator": {
                                "remoteUrl": "https://cdn.example/brat.jpg",
                                "targetBotExecuted": True,
                            }
                        },
                    }
                ),
                encoding="utf-8",
            )

            url_map = materialize._load_url_map(path)

        self.assertEqual(list(url_map), ["brat-generator"])
        self.assertTrue(url_map["brat-generator"]["targetBotExecuted"])

    def test_build_manifest_marks_entries_bot_specific(self) -> None:
        manifest = materialize.build_manifest(
            {
                "luna-star": {"remoteUrl": "https://cdn.example/dreamy.jpg", "prompt": "dreamy prompt"},
                "brat-generator": {"remoteUrl": "https://cdn.example/brat.jpg", "targetBotExecuted": True},
            },
            dry_run=True,
        )

        self.assertEqual(manifest["summary"]["botSpecificAssets"], 2)
        self.assertEqual(manifest["botPreviews"]["luna-star"]["assetId"], "luna-star")
        self.assertTrue(manifest["botPreviews"]["brat-generator"]["targetBotExecuted"])
        assets_by_slug = {asset["botSlug"]: asset for asset in manifest["assets"]}
        self.assertTrue(assets_by_slug["luna-star"]["botSpecific"])
        self.assertEqual(assets_by_slug["brat-generator"]["sourceWidgetId"], materialize.DEFAULT_WIDGET_ID)

    def test_build_manifest_rejects_unknown_slug(self) -> None:
        with self.assertRaises(materialize.PreviewManifestError):
            materialize.build_manifest({"not-a-bot": {"remoteUrl": "https://cdn.example/x.jpg"}}, dry_run=True)

    def test_build_manifest_can_merge_single_target_run_into_existing_manifest(self) -> None:
        existing_manifest = materialize.build_manifest(
            {
                "luna-star": {"remoteUrl": "https://cdn.example/dreamy.jpg", "prompt": "dreamy prompt"},
                "brat-generator": {"remoteUrl": "https://cdn.example/old-brat.jpg", "targetBotExecuted": False},
            },
            dry_run=True,
        )

        manifest = materialize.build_manifest(
            {
                "brat-generator": {
                    "remoteUrl": "https://cdn.example/new-brat.jpg",
                    "targetBotExecuted": True,
                    "source": "myshell-target-bot-api",
                }
            },
            dry_run=True,
            merge_existing=True,
            existing_manifest=existing_manifest,
        )

        assets_by_slug = {asset["botSlug"]: asset for asset in manifest["assets"]}
        self.assertIn("luna-star", assets_by_slug)
        self.assertEqual(assets_by_slug["luna-star"]["originalRemoteUrl"], "https://cdn.example/dreamy.jpg")
        self.assertEqual(assets_by_slug["brat-generator"]["originalRemoteUrl"], "https://cdn.example/new-brat.jpg")
        self.assertEqual(assets_by_slug["brat-generator"]["source"], "myshell-target-bot-api")
        self.assertFalse(manifest["botPreviews"]["luna-star"]["targetBotExecuted"])
        self.assertTrue(manifest["botPreviews"]["brat-generator"]["targetBotExecuted"])
        self.assertEqual(manifest["summary"]["botSpecificAssets"], 2)

    def test_prompt_worklist_covers_dreamy_and_art_bots(self) -> None:
        bots = materialize._all_bots()
        self.assertGreaterEqual(len(bots), 40)
        slugs = {bot["slug"] for bot in bots}
        self.assertIn("luna-star", slugs)
        self.assertIn("brat-generator", slugs)
        self.assertIn("sora-video-generator", slugs)
        self.assertIn("MyShell Studio", materialize.prompt_for_bot(bots[0]))

    def test_brat_generator_prompt_is_short_album_text(self) -> None:
        bot = next(bot for bot in materialize._all_bots() if bot["slug"] == "brat-generator")

        self.assertEqual(materialize.prompt_for_bot(bot), "studio mode")


if __name__ == "__main__":
    unittest.main()
