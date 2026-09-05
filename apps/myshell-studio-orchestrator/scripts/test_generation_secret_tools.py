import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
EXPORT_MODULE_PATH = Path(__file__).with_name("export_myshell_chrome_cookies.py")
CONFIGURE_SCRIPT = Path(__file__).with_name("configure_generation_secrets.sh")

spec = importlib.util.spec_from_file_location("export_myshell_chrome_cookies", EXPORT_MODULE_PATH)
export_myshell_chrome_cookies = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(export_myshell_chrome_cookies)


class GenerationSecretToolsTest(unittest.TestCase):
    def test_cookie_validation_uses_stdin_instead_of_process_arguments(self) -> None:
        content = CONFIGURE_SCRIPT.read_text(encoding="utf-8")

        self.assertIn("printf '%s' \"${myshell_cookies}\" | python3 -c", content)
        self.assertNotIn('python3 - "${myshell_cookies}"', content)

    def test_cookie_dedupe_keeps_secret_values_out_of_summary_shape(self) -> None:
        cookies = export_myshell_chrome_cookies._dedupe(
            [
                {"domain": ".myshell.ai", "path": "/", "name": "session", "value": "first"},
                {"domain": ".myshell.ai", "path": "/", "name": "session", "value": "second"},
            ]
        )

        self.assertEqual(len(cookies), 1)
        summary = {
            "status": "ready",
            "cookieCount": len(cookies),
            "profiles": [{"profile": "Default", "cookieCount": len(cookies)}],
        }
        self.assertNotIn("value", json.dumps(summary))
        self.assertNotIn("second", json.dumps(summary))

    def test_configure_generation_secrets_dry_run_redacts_values(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            init_data = "query_id=fake&user=%7B%22id%22%3A1%7D&auth_date=1700000000&hash=fakehash"
            cookies = '[{"name":"session","value":"super-secret-cookie","domain":".myshell.ai","path":"/","secure":true}]'
            init_path = temp_path / "init.txt"
            cookies_path = temp_path / "cookies.json"
            init_path.write_text(init_data, encoding="utf-8")
            cookies_path.write_text(cookies, encoding="utf-8")

            completed = subprocess.run(
                [
                    str(CONFIGURE_SCRIPT),
                    "--init-data-file",
                    str(init_path),
                    "--cookies-file",
                    str(cookies_path),
                    "--no-deploy",
                    "--no-smoke",
                ],
                cwd=REPO_ROOT,
                check=True,
                capture_output=True,
                text=True,
            )

        combined = completed.stdout + completed.stderr
        self.assertIn("[dry-run]", combined)
        self.assertIn("validated 1 MyShell cookies", combined)
        self.assertNotIn("super-secret-cookie", combined)
        self.assertNotIn("fakehash", combined)

    def test_configure_generation_secrets_apply_requires_art_api_probe(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            init_data = "query_id=fake&user=%7B%22id%22%3A1%7D&auth_date=1700000000&hash=fakehash"
            cookies = '[{"name":"ms_token","value":"super-secret-cookie","domain":".myshell.ai","path":"/","secure":true}]'
            init_path = temp_path / "init.txt"
            cookies_path = temp_path / "cookies.json"
            gcloud_path = temp_path / "gcloud"
            probe_path = temp_path / "probe.sh"
            init_path.write_text(init_data, encoding="utf-8")
            cookies_path.write_text(cookies, encoding="utf-8")
            gcloud_path.write_text("#!/usr/bin/env bash\necho gcloud should not run >&2\nexit 99\n", encoding="utf-8")
            probe_path.write_text("#!/usr/bin/env bash\necho '{\"status\":\"blocked\"}'\nexit 1\n", encoding="utf-8")
            gcloud_path.chmod(0o755)
            probe_path.chmod(0o755)

            completed = subprocess.run(
                [
                    str(CONFIGURE_SCRIPT),
                    "--apply",
                    "--init-data-file",
                    str(init_path),
                    "--cookies-file",
                    str(cookies_path),
                    "--no-deploy",
                    "--no-smoke",
                ],
                cwd=REPO_ROOT,
                check=False,
                capture_output=True,
                text=True,
                env={
                    "PATH": f"{temp_path}:{os.environ.get('PATH', '')}",
                    "MYSHELL_ART_API_PROBE_CMD": str(probe_path),
                },
            )

        combined = completed.stdout + completed.stderr
        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("MyShell Art API auth probe failed", combined)
        self.assertNotIn("super-secret-cookie", combined)
        self.assertNotIn("gcloud should not run", combined)

    def test_configure_generation_secrets_apply_uses_explicit_project_for_secret_writes(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            init_data = "query_id=fake&user=%7B%22id%22%3A1%7D&auth_date=1700000000&hash=fakehash"
            cookies = '[{"name":"ms_token","value":"super-secret-cookie","domain":".myshell.ai","path":"/","secure":true}]'
            init_path = temp_path / "init.txt"
            cookies_path = temp_path / "cookies.json"
            gcloud_log = temp_path / "gcloud.log"
            gcloud_path = temp_path / "gcloud"
            probe_path = temp_path / "probe.sh"
            init_path.write_text(init_data, encoding="utf-8")
            cookies_path.write_text(cookies, encoding="utf-8")
            gcloud_path.write_text(
                "#!/usr/bin/env bash\n"
                f"printf '%s\\n' \"$*\" >> {gcloud_log}\n"
                "if [ \"$1 $2\" = \"secrets describe\" ]; then exit 1; fi\n"
                "if [ \"$1 $2\" = \"secrets create\" ]; then cat >/dev/null; exit 0; fi\n"
                "exit 0\n",
                encoding="utf-8",
            )
            probe_path.write_text("#!/usr/bin/env bash\nexit 0\n", encoding="utf-8")
            gcloud_path.chmod(0o755)
            probe_path.chmod(0o755)

            completed = subprocess.run(
                [
                    str(CONFIGURE_SCRIPT),
                    "--apply",
                    "--project",
                    "k-project-481102",
                    "--init-data-file",
                    str(init_path),
                    "--cookies-file",
                    str(cookies_path),
                    "--no-deploy",
                    "--no-smoke",
                ],
                cwd=REPO_ROOT,
                check=False,
                capture_output=True,
                text=True,
                env={
                    "PATH": f"{temp_path}:{os.environ.get('PATH', '')}",
                    "MYSHELL_ART_API_PROBE_CMD": str(probe_path),
                },
            )

            combined = completed.stdout + completed.stderr
            self.assertEqual(completed.returncode, 0, combined)
            gcloud_calls = gcloud_log.read_text(encoding="utf-8")
            self.assertIn("secrets describe myshell-dreamy-init-data --project k-project-481102", gcloud_calls)
            self.assertIn("secrets create myshell-dreamy-init-data --project k-project-481102 --data-file=-", gcloud_calls)
            self.assertIn("secrets describe myshell-cookies --project k-project-481102", gcloud_calls)
            self.assertIn("secrets create myshell-cookies --project k-project-481102 --data-file=-", gcloud_calls)
            self.assertNotIn("super-secret-cookie", combined)

    def test_configure_generation_secrets_deploy_uses_explicit_project(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            init_data = "query_id=fake&user=%7B%22id%22%3A1%7D&auth_date=1700000000&hash=fakehash"
            cookies = '[{"name":"ms_token","value":"super-secret-cookie","domain":".myshell.ai","path":"/","secure":true}]'
            init_path = temp_path / "init.txt"
            cookies_path = temp_path / "cookies.json"
            gcloud_log = temp_path / "gcloud.log"
            gcloud_path = temp_path / "gcloud"
            probe_path = temp_path / "probe.sh"
            init_path.write_text(init_data, encoding="utf-8")
            cookies_path.write_text(cookies, encoding="utf-8")
            gcloud_path.write_text(
                "#!/usr/bin/env bash\n"
                f"printf '%s\\n' \"$*\" >> {gcloud_log}\n"
                "if [ \"$1 $2\" = \"secrets describe\" ]; then exit 1; fi\n"
                "if [ \"$1 $2\" = \"secrets create\" ]; then cat >/dev/null; exit 0; fi\n"
                "exit 0\n",
                encoding="utf-8",
            )
            probe_path.write_text("#!/usr/bin/env bash\nexit 0\n", encoding="utf-8")
            gcloud_path.chmod(0o755)
            probe_path.chmod(0o755)

            completed = subprocess.run(
                [
                    str(CONFIGURE_SCRIPT),
                    "--apply",
                    "--project",
                    "k-project-481102",
                    "--init-data-file",
                    str(init_path),
                    "--cookies-file",
                    str(cookies_path),
                    "--no-smoke",
                    "--short-sha",
                    "testsha",
                ],
                cwd=REPO_ROOT,
                check=False,
                capture_output=True,
                text=True,
                env={
                    "PATH": f"{temp_path}:{os.environ.get('PATH', '')}",
                    "MYSHELL_ART_API_PROBE_CMD": str(probe_path),
                },
            )

            combined = completed.stdout + completed.stderr
            self.assertEqual(completed.returncode, 0, combined)
            gcloud_calls = gcloud_log.read_text(encoding="utf-8")
            self.assertIn("builds submit --config", gcloud_calls)
            self.assertIn("--project k-project-481102", gcloud_calls)
            self.assertIn("--substitutions SHORT_SHA=testsha", gcloud_calls)
            self.assertIn("run services describe art-chat-orchestrator --region europe-west1 --project k-project-481102", gcloud_calls)
            self.assertNotIn("super-secret-cookie", combined)


if __name__ == "__main__":
    unittest.main()
