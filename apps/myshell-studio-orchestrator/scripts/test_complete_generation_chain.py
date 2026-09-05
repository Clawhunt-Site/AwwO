import importlib.util
import sys
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("complete_generation_chain.py")
spec = importlib.util.spec_from_file_location("complete_generation_chain", MODULE_PATH)
complete_chain = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(complete_chain)


class CompleteGenerationChainTest(unittest.TestCase):
    def test_default_plan_is_dry_run_and_does_not_enable_generation_steps(self) -> None:
        plan = complete_chain.build_plan(
            base_url="https://studio.example",
            project="k-project-481102",
            apply=False,
        )

        self.assertEqual(plan["status"], "dry_run")
        by_id = {step["id"]: step for step in plan["steps"]}
        self.assertTrue(by_id["precheck"]["enabled"])
        self.assertTrue(by_id["final-check"]["enabled"])
        self.assertFalse(by_id["live-smoke"]["enabled"])
        self.assertFalse(by_id["art-target-previews"]["enabled"])
        self.assertFalse(by_id["configure-secrets"]["enabled"])
        self.assertFalse(any(step["willRun"] for step in plan["steps"]))

    def test_full_apply_plan_orders_secret_setup_generation_targets_and_final_gate(self) -> None:
        plan = complete_chain.build_plan(
            base_url="https://studio.example",
            project="k-project-481102",
            apply=True,
            configure_secrets=True,
            init_data_file=Path("/tmp/dreamy-init-data.txt"),
            cookies_file=Path("/tmp/myshell-cookies.json"),
            execute_live=True,
            execute_art_targets=True,
            import_dreamy_targets=True,
            materialize=True,
            short_sha="abc123",
        )

        enabled_steps = [step for step in plan["steps"] if step["enabled"]]
        self.assertEqual(
            [step["id"] for step in enabled_steps],
            [
                "precheck",
                "configure-secrets",
                "live-smoke",
                "art-target-previews",
                "materialize-art-targets",
                "dreamy-target-import",
                "materialize-dreamy-targets",
                "final-check",
            ],
        )
        self.assertTrue(all(step["willRun"] for step in enabled_steps))
        configure_command = " ".join(enabled_steps[1]["command"])
        self.assertIn("scripts/configure_generation_secrets.sh", configure_command)
        self.assertIn("--project k-project-481102", configure_command)
        self.assertIn("--no-smoke", configure_command)
        self.assertIn("--short-sha abc123", configure_command)
        live_command = " ".join(enabled_steps[2]["command"])
        self.assertIn("generation_smoke", live_command)
        self.assertIn("--execute", live_command)
        self.assertIn("--require-live", live_command)
        final_command = " ".join(enabled_steps[-1]["command"])
        self.assertIn("--project k-project-481102", final_command)
        self.assertIn("--require-live", final_command)

    def test_deploy_after_materialize_runs_before_final_public_gate(self) -> None:
        plan = complete_chain.build_plan(
            base_url="https://studio.example",
            project="k-project-481102",
            apply=True,
            execute_art_targets=True,
            import_dreamy_targets=True,
            materialize=True,
            deploy_after_materialize=True,
            short_sha="abc123",
        )

        enabled_steps = [step for step in plan["steps"] if step["enabled"]]
        self.assertEqual(
            [step["id"] for step in enabled_steps],
            [
                "precheck",
                "art-target-previews",
                "materialize-art-targets",
                "dreamy-target-import",
                "materialize-dreamy-targets",
                "deploy-after-materialize",
                "final-check",
            ],
        )
        deploy_step = enabled_steps[-2]
        self.assertTrue(deploy_step["willRun"])
        self.assertEqual(deploy_step["command"][:3], ["gcloud", "builds", "submit"])
        deploy_command = " ".join(deploy_step["command"])
        self.assertIn("--project k-project-481102", deploy_command)
        self.assertIn("orchestrator/cloudbuild.yaml", deploy_command)
        self.assertIn("--substitutions SHORT_SHA=abc123", deploy_command)

    def test_art_target_step_reuses_supplied_cookie_file_without_cookie_values(self) -> None:
        plan = complete_chain.build_plan(
            base_url="https://studio.example",
            project="k-project-481102",
            apply=True,
            cookies_file=Path("/tmp/myshell-cookies.json"),
            execute_art_targets=True,
        )

        art_step = next(step for step in plan["steps"] if step["id"] == "art-target-previews")
        self.assertEqual(art_step["env"], {"MYSHELL_COOKIES_FILE": "/tmp/myshell-cookies.json"})
        self.assertNotIn("MYSHELL_COOKIES", art_step["env"])

    def test_run_plan_executes_only_enabled_steps_and_stops_on_failure(self) -> None:
        plan = complete_chain.build_plan(
            base_url="https://studio.example",
            project="k-project-481102",
            apply=True,
            execute_live=True,
        )
        calls = []

        def fake_runner(command, timeout, env):
            calls.append((command, timeout, env))
            if any("generation_smoke" in part for part in command):
                return complete_chain.CommandResult(returncode=9, stdout="", stderr="smoke failed")
            return complete_chain.CommandResult(returncode=0, stdout="{}", stderr="")

        report = complete_chain.run_plan(plan, runner=fake_runner)

        self.assertEqual(report["status"], "failed")
        self.assertEqual([step["id"] for step in report["steps"] if step.get("ran")], ["precheck", "live-smoke"])
        self.assertEqual(report["failedStep"]["id"], "live-smoke")
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0][0][0], sys.executable)

    def test_run_plan_passes_art_cookie_file_env_to_runner(self) -> None:
        plan = complete_chain.build_plan(
            base_url="https://studio.example",
            project="k-project-481102",
            apply=True,
            cookies_file=Path("/tmp/myshell-cookies.json"),
            execute_art_targets=True,
        )
        calls = []

        def fake_runner(command, timeout, env):
            calls.append((command, timeout, env))
            return complete_chain.CommandResult(returncode=0, stdout="{}", stderr="")

        report = complete_chain.run_plan(plan, runner=fake_runner)

        self.assertEqual(report["status"], "ok")
        art_call = next(call for call in calls if "run_target_bot_previews.py" in " ".join(call[0]))
        self.assertEqual(art_call[2], {"MYSHELL_COOKIES_FILE": "/tmp/myshell-cookies.json"})


if __name__ == "__main__":
    unittest.main()
