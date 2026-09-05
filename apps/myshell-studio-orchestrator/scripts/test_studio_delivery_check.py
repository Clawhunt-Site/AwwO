import importlib.util
import socket
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("studio_delivery_check.py")
spec = importlib.util.spec_from_file_location("studio_delivery_check", MODULE_PATH)
studio_delivery_check = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(studio_delivery_check)


class StudioDeliveryCheckTest(unittest.TestCase):
    def test_find_free_port_skips_busy_preferred_port(self) -> None:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind(("127.0.0.1", 0))
            sock.listen(1)
            busy_port = sock.getsockname()[1]

            found = studio_delivery_check.find_free_port(busy_port)

        self.assertNotEqual(found, busy_port)
        self.assertTrue(studio_delivery_check.is_port_free(found))

    def test_find_free_port_skips_wildcard_listener(self) -> None:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind(("0.0.0.0", 0))
            sock.listen(1)
            busy_port = sock.getsockname()[1]

            self.assertFalse(studio_delivery_check.is_port_free(busy_port))
            found = studio_delivery_check.find_free_port(busy_port)

        self.assertNotEqual(found, busy_port)

    def test_wait_for_process_url_fails_when_owned_process_exits(self) -> None:
        process = studio_delivery_check.subprocess.Popen(
            [studio_delivery_check.sys.executable, "-c", "import sys; sys.exit(7)"]
        )
        result = studio_delivery_check.wait_for_process_url(
            process,
            "http://127.0.0.1:9",
            timeout_seconds=2,
        )

        self.assertFalse(result.ok)
        self.assertIn("exited", result.message)

    def test_build_delivery_commands_wire_ports_and_backend_url(self) -> None:
        repo_root = Path("/repo")
        plan = studio_delivery_check.build_delivery_plan(
            repo_root=repo_root,
            backend_port=19090,
            frontend_port=15174,
            workspace_screenshot_path=repo_root / "tmp" / "dreamy-workspace.png",
            evidence_screenshot_path=repo_root / "tmp" / "dreamy-evidence.png",
        )

        self.assertEqual(plan.backend.cwd, repo_root / "orchestrator" / "backend")
        self.assertIn("main.py", plan.backend.command)
        self.assertEqual(plan.backend.env["PORT"], "19090")
        self.assertIsNotNone(plan.frontend_build)
        self.assertEqual(plan.frontend_build.command, ["npm", "run", "build"])
        self.assertEqual(plan.frontend_build.env["VITE_DREAMY_ORCHESTRATOR_BASE_URL"], "http://127.0.0.1:19090")
        self.assertEqual(plan.frontend.env["VITE_DREAMY_ORCHESTRATOR_BASE_URL"], "http://127.0.0.1:19090")
        self.assertEqual(plan.frontend.env["STUDIO_FRONTEND_URL"], "http://127.0.0.1:15174")
        self.assertIn("preview", plan.frontend.command)
        self.assertNotIn("dev", plan.frontend.command)
        self.assertIn("--port", plan.frontend.command)
        self.assertIn("15174", plan.frontend.command)
        self.assertIn("studio_smoke", " ".join(plan.backend_smoke.command))
        self.assertIn("smoke:studio", plan.frontend_smoke.command)
        self.assertIn("--workspace-screenshot", plan.frontend_smoke.command)
        self.assertIn("/repo/tmp/dreamy-workspace.png", plan.frontend_smoke.command)
        self.assertIn("--evidence-screenshot", plan.frontend_smoke.command)
        self.assertIn("/repo/tmp/dreamy-evidence.png", plan.frontend_smoke.command)
        self.assertIn("--report", plan.frontend_smoke.command)

    def test_dev_frontend_mode_skips_build_and_uses_vite_dev_server(self) -> None:
        repo_root = Path("/repo")
        plan = studio_delivery_check.build_delivery_plan(
            repo_root=repo_root,
            backend_port=19090,
            frontend_port=15174,
            workspace_screenshot_path=repo_root / "tmp" / "dreamy-workspace.png",
            evidence_screenshot_path=repo_root / "tmp" / "dreamy-evidence.png",
            frontend_mode="dev",
        )

        self.assertIsNone(plan.frontend_build)
        self.assertIn("dev", plan.frontend.command)
        self.assertNotIn("preview", plan.frontend.command)

    def test_create_delivery_summary_fails_when_any_step_fails(self) -> None:
        summary = studio_delivery_check.create_delivery_summary(
            repo_root=Path("/repo"),
            backend_port=19090,
            frontend_port=15174,
            artifacts_dir=Path("/repo/.studio-delivery-check"),
            workspace_screenshot_path=Path("/repo/.studio-delivery-check/dreamy-workspace.png"),
            evidence_screenshot_path=Path("/repo/.studio-delivery-check/dreamy-evidence.png"),
            report_path=Path("/repo/.studio-delivery-check/summary.json"),
            steps=[
                studio_delivery_check.StepResult(id="backend-smoke", ok=True, duration_seconds=1.2),
                studio_delivery_check.StepResult(id="frontend-smoke", ok=False, duration_seconds=0.4, message="missing Inspector"),
            ],
        )

        self.assertEqual(summary["status"], "failed")
        self.assertEqual(summary["summary"]["passed"], 1)
        self.assertEqual(summary["summary"]["failed"], 1)
        self.assertEqual(summary["failures"][0]["id"], "frontend-smoke")
        self.assertEqual(summary["artifacts"]["report"], "/repo/.studio-delivery-check/summary.json")
        self.assertEqual(summary["artifacts"]["workspaceScreenshot"], "/repo/.studio-delivery-check/dreamy-workspace.png")
        self.assertEqual(summary["artifacts"]["evidenceScreenshot"], "/repo/.studio-delivery-check/dreamy-evidence.png")
        self.assertEqual(summary["artifacts"]["screenshot"], "/repo/.studio-delivery-check/dreamy-evidence.png")

    def test_create_delivery_summary_embeds_frontend_smoke_report(self) -> None:
        frontend_output = """
> fantasia-miniapp@1.0.0 smoke:studio
> node scripts/studio-frontend-smoke.mjs

{
  "status": "ok",
  "summary": {
    "total": 22,
    "passed": 22,
    "failed": 0,
    "consoleErrors": 0
  },
  "checks": [
    {"id": "dispatch-session-started", "ok": true}
  ]
}
"""
        summary = studio_delivery_check.create_delivery_summary(
            repo_root=Path("/repo"),
            backend_port=19090,
            frontend_port=15174,
            artifacts_dir=Path("/repo/.studio-delivery-check"),
            workspace_screenshot_path=Path("/repo/.studio-delivery-check/dreamy-workspace.png"),
            evidence_screenshot_path=Path("/repo/.studio-delivery-check/dreamy-evidence.png"),
            report_path=Path("/repo/.studio-delivery-check/summary.json"),
            steps=[
                studio_delivery_check.StepResult(id="frontend-smoke", ok=True, output=frontend_output),
            ],
        )

        self.assertEqual(summary["reports"]["frontendSmoke"]["summary"]["total"], 22)
        self.assertEqual(summary["reports"]["frontendSmoke"]["checks"][0]["id"], "dispatch-session-started")

    def test_create_delivery_summary_prefers_frontend_smoke_report_file(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            frontend_report_path = Path(temp_dir) / "frontend-smoke.json"
            frontend_report_path.write_text(studio_delivery_check.json.dumps({
                "status": "ok",
                "summary": {"total": 32, "passed": 32, "failed": 0, "consoleErrors": 0},
                "checks": [{"id": "studio-return-restored", "ok": True}],
            }), encoding="utf-8")

            summary = studio_delivery_check.create_delivery_summary(
                repo_root=Path("/repo"),
                backend_port=19090,
                frontend_port=15174,
                artifacts_dir=Path("/repo/.studio-delivery-check"),
                workspace_screenshot_path=Path("/repo/.studio-delivery-check/dreamy-workspace.png"),
                evidence_screenshot_path=Path("/repo/.studio-delivery-check/dreamy-evidence.png"),
                report_path=Path("/repo/.studio-delivery-check/summary.json"),
                frontend_smoke_report_path=frontend_report_path,
                steps=[
                    studio_delivery_check.StepResult(id="frontend-smoke", ok=True, output='{"id":"truncated-check"}'),
                ],
            )

            self.assertEqual(summary["reports"]["frontendSmoke"]["summary"]["total"], 32)
            self.assertEqual(summary["reports"]["frontendSmoke"]["checks"][0]["id"], "studio-return-restored")
            self.assertEqual(summary["artifacts"]["frontendSmokeReport"], str(frontend_report_path))

    def test_write_delivery_summary_creates_report_file(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            report_path = Path(temp_dir) / "nested" / "summary.json"
            summary = {"status": "ok", "summary": {"passed": 1, "failed": 0}}

            studio_delivery_check.write_delivery_summary(summary, report_path)

            self.assertTrue(report_path.exists())
            self.assertEqual(studio_delivery_check.json.loads(report_path.read_text())["status"], "ok")


if __name__ == "__main__":
    unittest.main()
