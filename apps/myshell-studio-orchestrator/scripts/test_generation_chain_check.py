import importlib.util
import json
import os
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch


MODULE_PATH = Path(__file__).with_name("generation_chain_check.py")
spec = importlib.util.spec_from_file_location("generation_chain_check", MODULE_PATH)
generation_chain_check = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(generation_chain_check)


def _fake_fetch(payloads):
    def fetcher(_base_url, path, _timeout):
        return payloads[path]

    return fetcher


def _fake_runner(existing_secrets=True, cloud_run_ready=True):
    def runner(command):
        text = " ".join(command)
        if "secrets describe" in text:
            return (0, "secret-name", "") if existing_secrets else (1, "", "NOT_FOUND")
        if "run services describe" in text:
            if not cloud_run_ready:
                return 1, "", "service missing"
            return (
                0,
                '{"status":{"url":"https://studio.example","latestReadyRevisionName":"rev-ready","traffic":[{"revisionName":"rev-ready","percent":100}]}}',
                "",
            )
        return 0, "", ""

    return runner


class GenerationChainCheckTest(unittest.TestCase):
    def test_fetch_json_sends_operator_identity_token_when_configured(self) -> None:
        response = MagicMock()
        response.read.return_value = json.dumps({"status": "ok"}).encode("utf-8")
        response.__enter__.return_value = response
        response.__exit__.return_value = False

        with (
            patch.dict(os.environ, {"STUDIO_AUTH_TOKEN": "identity-token"}, clear=True),
            patch.object(generation_chain_check, "urlopen", return_value=response) as mocked_urlopen,
        ):
            payload = generation_chain_check.fetch_json("https://studio.example", "/api/health")

        request = mocked_urlopen.call_args.args[0]
        self.assertEqual(payload, {"status": "ok"})
        self.assertEqual(request.get_header("Authorization"), "Bearer identity-token")

    def test_report_blocks_when_live_generation_credentials_are_missing(self) -> None:
        report = generation_chain_check.build_generation_chain_report(
            base_url="https://studio.example",
            project="project",
            require_live=True,
            fetcher=_fake_fetch(
                {
                    "/api/health": {
                        "status": "degraded",
                        "components": {
                            "dreamyApiAuth": {"status": "client_delegated"},
                            "myshellCookies": {"status": "auth_missing"},
                            "cookieInjection": {"status": "auth_missing"},
                            "chromeCdp": {"status": "ok"},
                        },
                    },
                    "/api/studio/bot-previews": {"summary": {"ready": 40, "total": 40, "botSpecific": 6, "targetBotExecuted": 0}},
                    "/api/studio/generation-smoke": {"status": "needs_configuration", "latest": {"accepted": False}},
                }
            ),
            runner=_fake_runner(existing_secrets=False),
        )

        self.assertEqual(report["status"], "blocked")
        self.assertEqual(report["summary"]["previewReady"], 40)
        self.assertEqual(report["summary"]["previewBotSpecific"], 6)
        blocking_ids = {item["id"] for item in report["blocking"]}
        self.assertIn("bot-previews", blocking_ids)
        self.assertIn("secret-manager", blocking_ids)
        self.assertIn("dreamy-server-auth", blocking_ids)
        self.assertIn("myshell-art-auth", blocking_ids)
        self.assertIn("live-generation-smoke", blocking_ids)

    def test_report_next_actions_mentions_project_bound_secret_setup_command(self) -> None:
        report = generation_chain_check.build_generation_chain_report(
            base_url="https://studio.example",
            project="k-project-481102",
            require_live=True,
            fetcher=_fake_fetch(
                {
                    "/api/health": {
                        "status": "degraded",
                        "components": {
                            "dreamyApiAuth": {"status": "client_delegated"},
                            "myshellCookies": {"status": "auth_missing"},
                            "cookieInjection": {"status": "auth_missing"},
                            "chromeCdp": {"status": "ok"},
                        },
                    },
                    "/api/studio/bot-previews": {"summary": {"ready": 40, "total": 40, "botSpecific": 40, "targetBotExecuted": 0}},
                    "/api/studio/generation-smoke": {"status": "needs_configuration", "latest": {"accepted": False}},
                }
            ),
            runner=_fake_runner(existing_secrets=False),
        )

        actions = " ".join(report["nextActions"])
        self.assertIn("scripts/configure_generation_secrets.sh", actions)
        self.assertIn("--project k-project-481102", actions)

    def test_report_ready_when_generation_media_is_accepted(self) -> None:
        report = generation_chain_check.build_generation_chain_report(
            base_url="https://studio.example",
            project="project",
            require_live=True,
            fetcher=_fake_fetch(
                {
                    "/api/health": {
                        "status": "ok",
                        "components": {
                            "dreamyApiAuth": {"status": "ready"},
                            "myshellCookies": {"status": "ready"},
                            "cookieInjection": {"status": "ready"},
                            "chromeCdp": {"status": "ok"},
                        },
                    },
                    "/api/studio/bot-previews": {"summary": {"ready": 40, "total": 40, "botSpecific": 40, "targetBotExecuted": 40}},
                    "/api/studio/generation-smoke": {
                        "status": "done",
                        "latest": {"accepted": True, "mediaUrl": "https://cdn.example/generated.png"},
                    },
                }
            ),
            runner=_fake_runner(existing_secrets=True),
        )

        self.assertEqual(report["status"], "ready")
        self.assertTrue(report["readyForDelivery"])
        self.assertEqual(report["blocking"], [])

    def test_report_accepts_ready_myshell_art_api_auth_smoke(self) -> None:
        report = generation_chain_check.build_generation_chain_report(
            base_url="https://studio.example",
            project="project",
            require_live=True,
            fetcher=_fake_fetch(
                {
                    "/api/health": {
                        "status": "ok",
                        "components": {
                            "dreamyApiAuth": {"status": "ready"},
                            "myshellCookies": {"status": "ready"},
                            "cookieInjection": {"status": "auth_missing"},
                            "chromeCdp": {"status": "unavailable"},
                        },
                    },
                    "/api/studio/bot-previews": {"summary": {"ready": 40, "total": 40, "botSpecific": 40, "targetBotExecuted": 40}},
                    "/api/studio/generation-smoke": {
                        "status": "done",
                        "latest": {"accepted": True, "mediaUrl": "https://cdn.example/generated.png"},
                    },
                    "/api/studio/art-api-auth-smoke": {
                        "status": "ready",
                        "ready": True,
                        "authProbe": {"httpStatus": 200},
                    },
                }
            ),
            runner=_fake_runner(existing_secrets=True),
        )

        self.assertEqual(report["status"], "ready")
        self.assertTrue(report["readyForDelivery"])
        art_auth = next(item for item in report["requirements"] if item["id"] == "myshell-art-auth")
        self.assertEqual(art_auth["evidence"]["artApiAuth"], "ready")

    def test_report_blocks_representative_preview_assets(self) -> None:
        report = generation_chain_check.build_generation_chain_report(
            base_url="https://studio.example",
            project="project",
            require_live=False,
            fetcher=_fake_fetch(
                {
                    "/api/health": {
                        "status": "ok",
                        "components": {
                            "dreamyApiAuth": {"status": "ready"},
                            "myshellCookies": {"status": "ready"},
                            "cookieInjection": {"status": "ready"},
                            "chromeCdp": {"status": "ok"},
                        },
                    },
                    "/api/studio/bot-previews": {"summary": {"ready": 40, "total": 40, "botSpecific": 6}},
                    "/api/studio/generation-smoke": {
                        "status": "done",
                        "latest": {"accepted": True, "mediaUrl": "https://cdn.example/generated.png"},
                    },
                }
            ),
            runner=_fake_runner(existing_secrets=True),
        )

        self.assertEqual(report["status"], "degraded")
        self.assertFalse(report["readyForDelivery"])
        self.assertEqual(report["blocking"][0]["id"], "bot-previews")

    def test_report_blocks_without_target_bot_execution_evidence(self) -> None:
        report = generation_chain_check.build_generation_chain_report(
            base_url="https://studio.example",
            project="project",
            require_live=False,
            fetcher=_fake_fetch(
                {
                    "/api/health": {
                        "status": "ok",
                        "components": {
                            "dreamyApiAuth": {"status": "ready"},
                            "myshellCookies": {"status": "ready"},
                            "cookieInjection": {"status": "ready"},
                            "chromeCdp": {"status": "ok"},
                        },
                    },
                    "/api/studio/bot-previews": {"summary": {"ready": 40, "total": 40, "botSpecific": 40, "targetBotExecuted": 0}},
                    "/api/studio/generation-smoke": {
                        "status": "done",
                        "latest": {"accepted": True, "mediaUrl": "https://cdn.example/generated.png"},
                    },
                }
            ),
            runner=_fake_runner(existing_secrets=True),
        )

        self.assertEqual(report["status"], "degraded")
        blocking_ids = {item["id"] for item in report["blocking"]}
        self.assertIn("target-bot-preview-execution", blocking_ids)

    def test_report_splits_art_and_dreamy_target_execution_gaps(self) -> None:
        report = generation_chain_check.build_generation_chain_report(
            base_url="https://studio.example",
            project="project",
            require_live=False,
            fetcher=_fake_fetch(
                {
                    "/api/health": {
                        "status": "ok",
                        "components": {
                            "dreamyApiAuth": {"status": "ready"},
                            "myshellCookies": {"status": "ready"},
                            "cookieInjection": {"status": "ready"},
                            "chromeCdp": {"status": "ok"},
                        },
                    },
                    "/api/studio/bot-previews": {
                        "summary": {
                            "ready": 40,
                            "total": 40,
                            "botSpecific": 40,
                            "targetBotExecuted": 38,
                            "dreamyBots": 2,
                            "artBots": 38,
                        },
                        "previews": [
                            {
                                "pageId": "dreamy-miniapp",
                                "status": "ready",
                                "accepted": True,
                                "targetBotExecuted": False,
                            },
                            {
                                "pageId": "dreamy-miniapp",
                                "status": "ready",
                                "accepted": True,
                                "targetBotExecuted": False,
                            },
                            *[
                                {
                                    "pageId": "myshell-art",
                                    "status": "ready",
                                    "accepted": True,
                                    "targetBotExecuted": True,
                                }
                                for _ in range(38)
                            ],
                        ],
                    },
                    "/api/studio/generation-smoke": {
                        "status": "done",
                        "latest": {"accepted": True, "mediaUrl": "https://cdn.example/generated.png"},
                    },
                }
            ),
            runner=_fake_runner(existing_secrets=True),
        )

        self.assertEqual(report["summary"]["previewArtTargetBotExecuted"], 38)
        self.assertEqual(report["summary"]["previewArtTargetBotTotal"], 38)
        self.assertEqual(report["summary"]["previewDreamyTargetBotExecuted"], 0)
        self.assertEqual(report["summary"]["previewDreamyTargetBotTotal"], 2)
        target_execution = next(item for item in report["requirements"] if item["id"] == "target-bot-preview-execution")
        self.assertEqual(target_execution["evidence"]["artTargetBotExecuted"], 38)
        self.assertEqual(target_execution["evidence"]["dreamyTargetBotExecuted"], 0)
        actions = " ".join(report["nextActions"]).lower()
        self.assertIn("dreamy", actions)
        self.assertNotIn("art target execution", actions)

    def test_report_next_actions_mentions_captcha_required(self) -> None:
        report = generation_chain_check.build_generation_chain_report(
            base_url="https://studio.example",
            project="project",
            require_live=False,
            fetcher=_fake_fetch(
                {
                    "/api/health": {
                        "status": "degraded",
                        "components": {
                            "dreamyApiAuth": {"status": "ready"},
                            "myshellCookies": {"status": "ready"},
                            "cookieInjection": {"status": "captcha_required"},
                            "chromeCdp": {"status": "ok"},
                        },
                    },
                    "/api/studio/bot-previews": {"summary": {"ready": 40, "total": 40, "botSpecific": 40, "targetBotExecuted": 0}},
                    "/api/studio/generation-smoke": {
                        "status": "done",
                        "latest": {"accepted": True, "mediaUrl": "https://cdn.example/generated.png"},
                    },
                }
            ),
            runner=_fake_runner(existing_secrets=True),
        )

        self.assertIn("captcha", " ".join(report["nextActions"]).lower())

    def test_report_local_cookie_evidence_mentions_missing_ms_token(self) -> None:
        with patch.object(
            generation_chain_check,
            "_local_cookie_status",
            return_value={
                "status": "ready",
                "cookieCount": 2,
                "cookieNames": ["privy-session", "privy-token"],
                "missingCookieNames": ["ms_token"],
                "profiles": [{"profile": "Default", "cookieCount": 2, "domains": [".myshell.ai"]}],
            },
        ):
            report = generation_chain_check.build_generation_chain_report(
                base_url="https://studio.example",
                project="project",
                require_live=False,
                check_local_cookies=True,
                fetcher=_fake_fetch(
                    {
                        "/api/health": {
                            "status": "ok",
                            "components": {
                                "dreamyApiAuth": {"status": "ready"},
                                "myshellCookies": {"status": "ready"},
                                "cookieInjection": {"status": "ready"},
                                "chromeCdp": {"status": "ok"},
                            },
                        },
                        "/api/studio/bot-previews": {
                            "summary": {"ready": 40, "total": 40, "botSpecific": 40, "targetBotExecuted": 40}
                        },
                        "/api/studio/generation-smoke": {
                            "status": "done",
                            "latest": {"accepted": True, "mediaUrl": "https://cdn.example/generated.png"},
                        },
                    }
                ),
                runner=_fake_runner(existing_secrets=True),
            )

        local = next(item for item in report["requirements"] if item["id"] == "local-cookies")
        self.assertEqual(local["evidence"]["missingCookieNames"], ["ms_token"])
        self.assertEqual(local["evidence"]["cookieNames"], ["privy-session", "privy-token"])

    def test_report_blocks_when_local_art_api_probe_rejects_cookies(self) -> None:
        report = generation_chain_check.build_generation_chain_report(
            base_url="https://studio.example",
            project="project",
            require_live=False,
            check_local_cookies=True,
            probe_local_art_api=True,
            local_cookies_file="/tmp/myshell-cookies.json",
            local_art_api_probe=lambda _path: {
                "status": "blocked",
                "authProbe": {"httpStatus": 401, "reason": "UNAUTHORIZED"},
                "runningTasksProbe": {"httpStatus": 401, "reason": "UNAUTHORIZED"},
            },
            fetcher=_fake_fetch(
                {
                    "/api/health": {
                        "status": "ok",
                        "components": {
                            "dreamyApiAuth": {"status": "ready"},
                            "myshellCookies": {"status": "ready"},
                            "cookieInjection": {"status": "ready"},
                            "chromeCdp": {"status": "ok"},
                        },
                    },
                    "/api/studio/bot-previews": {
                        "summary": {"ready": 40, "total": 40, "botSpecific": 40, "targetBotExecuted": 40}
                    },
                    "/api/studio/generation-smoke": {
                        "status": "done",
                        "latest": {"accepted": True, "mediaUrl": "https://cdn.example/generated.png"},
                    },
                }
            ),
            runner=_fake_runner(existing_secrets=True),
        )

        local_art_api = next(item for item in report["requirements"] if item["id"] == "local-art-api-auth")
        self.assertEqual(local_art_api["status"], "blocked")
        self.assertEqual(local_art_api["evidence"]["authProbe"]["httpStatus"], 401)
        self.assertIn("do not upload", " ".join(report["nextActions"]).lower())


if __name__ == "__main__":
    unittest.main()
