import sys
import unittest
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))

from studio_smoke import SmokeFailure, run_smoke  # noqa: E402


class StudioSmokeTest(unittest.TestCase):
    def test_smoke_summarizes_delivery_surface(self) -> None:
        responses = {
            "/api/health": {"backend": {"status": "ok"}},
            "/api/pages": {
                "pages": [
                    {"id": "dreamy-miniapp", "dispatchReady": True},
                    {"id": "myshell-art", "dispatchReady": False},
                    {"id": "explore", "dispatchReady": True},
                    {"id": "library", "dispatchReady": True},
                    {"id": "settings", "dispatchReady": True},
                ]
            },
            "/api/agents": {
                "agents": [
                    {"id": "intent-router"},
                    {"id": "dreamy-miniapp-executor"},
                    {"id": "myshell-art-cdp-executor"},
                    {"id": "miniapp-page-navigator"},
                    {"id": "evidence-verifier"},
                ]
            },
            "/api/studio/readiness": {
                "status": "degraded",
                "gates": [
                    {"id": "backend", "status": "ready", "required": True},
                    {"id": "storage", "status": "ready", "required": True},
                    {"id": "page-registry", "status": "ready", "required": True},
                    {"id": "agent-registry", "status": "ready", "required": True},
                    {"id": "myshell-art-auth", "status": "auth_missing", "required": False},
                ],
            },
            "/api/studio/dispatch-matrix": {
                "entries": [
                    {"pageId": "dreamy-miniapp"},
                    {"pageId": "myshell-art"},
                    {"pageId": "explore"},
                    {"pageId": "library"},
                    {"pageId": "settings"},
                ],
                "summary": {"ready": 4, "blocked": 1},
            },
            "/api/studio/coverage": {"summary": {"total": 5, "covered": 0, "blocked": 1}},
            "/api/studio/generation-smoke": {
                "status": "needs_configuration",
                "prerequisites": {"status": "needs_configuration"},
            },
            "/api/studio/delivery-audit": {
                "status": "degraded",
                "requirements": [{"id": "readiness", "status": "ready"}],
                "artifacts": [{"id": "delivery-audit", "url": "/api/studio/delivery-audit"}],
                "reports": {"readiness": {}, "dispatchMatrix": {}, "coverage": {}},
            },
        }

        result = run_smoke(
            "http://studio.local",
            min_pages=5,
            min_agents=5,
            required_pages={"dreamy-miniapp", "myshell-art", "explore", "library", "settings"},
            required_agents={"intent-router", "miniapp-page-navigator", "evidence-verifier"},
            fetch_json=lambda path: responses[path],
        )

        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["summary"]["pages"], 5)
        self.assertEqual(result["summary"]["agents"], 5)
        self.assertEqual(result["summary"]["requiredGatesReady"], 4)
        self.assertEqual(result["summary"]["matrixEntries"], 5)
        self.assertEqual(result["summary"]["generationSmoke"], "needs_configuration")
        self.assertEqual(result["summary"]["auditArtifacts"], 1)
        self.assertEqual(result["warnings"], ["Optional gate myshell-art-auth is auth_missing"])

    def test_smoke_fails_when_required_page_is_missing(self) -> None:
        responses = {
            "/api/health": {},
            "/api/pages": {"pages": [{"id": "dreamy-miniapp"}]},
            "/api/agents": {"agents": [{"id": "intent-router"}]},
            "/api/studio/readiness": {"gates": []},
            "/api/studio/dispatch-matrix": {"entries": []},
            "/api/studio/coverage": {"summary": {}},
            "/api/studio/generation-smoke": {
                "status": "needs_configuration",
                "prerequisites": {"status": "needs_configuration"},
            },
            "/api/studio/delivery-audit": {"requirements": [], "artifacts": [], "reports": {}},
        }

        with self.assertRaises(SmokeFailure) as context:
            run_smoke(
                "http://studio.local",
                min_pages=2,
                required_pages={"dreamy-miniapp", "library"},
                fetch_json=lambda path: responses[path],
            )

        self.assertIn("Missing required pages: library", str(context.exception))


if __name__ == "__main__":
    unittest.main()
