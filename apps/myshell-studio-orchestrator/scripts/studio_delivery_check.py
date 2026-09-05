#!/usr/bin/env python3
"""One-command local delivery check for MyShell Studio Orchestrator."""

from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path
from typing import Any
from urllib.error import URLError
from urllib.request import urlopen


DEFAULT_BACKEND_PORT = 8090
DEFAULT_FRONTEND_PORT = 5174
DEFAULT_TIMEOUT_SECONDS = 45.0
DEFAULT_FRONTEND_MODE = "preview"


class StepResult:
    def __init__(
        self,
        id: str,
        ok: bool,
        duration_seconds: float = 0.0,
        message: str = "",
        output: str = "",
    ) -> None:
        self.id = id
        self.ok = ok
        self.duration_seconds = duration_seconds
        self.message = message
        self.output = output

    def to_json(self) -> dict[str, Any]:
        result: dict[str, Any] = {
            "id": self.id,
            "ok": self.ok,
            "durationSeconds": round(self.duration_seconds, 3),
        }
        if self.message:
            result["message"] = self.message
        if self.output:
            result["output"] = self.output
        return result


class CommandSpec:
    def __init__(self, id: str, cwd: Path, command: list[str], env: dict[str, str] | None = None) -> None:
        self.id = id
        self.cwd = cwd
        self.command = command
        self.env = env or {}

    def merged_env(self) -> dict[str, str]:
        merged = os.environ.copy()
        merged.update(self.env)
        return merged


class DeliveryPlan:
    def __init__(
        self,
        backend: CommandSpec,
        frontend_build: CommandSpec | None,
        frontend: CommandSpec,
        backend_smoke: CommandSpec,
        frontend_smoke: CommandSpec,
        backend_health_url: str,
        frontend_url: str,
        frontend_mode: str,
        frontend_smoke_scope: str,
    ) -> None:
        self.backend = backend
        self.frontend_build = frontend_build
        self.frontend = frontend
        self.backend_smoke = backend_smoke
        self.frontend_smoke = frontend_smoke
        self.backend_health_url = backend_health_url
        self.frontend_url = frontend_url
        self.frontend_mode = frontend_mode
        self.frontend_smoke_scope = frontend_smoke_scope


def repo_root_from_script() -> Path:
    return Path(__file__).resolve().parents[1]


def is_port_free(port: int, host: str = "127.0.0.1") -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        try:
            sock.bind((host, port))
        except OSError:
            return False
    return True


def find_free_port(preferred_port: int, host: str = "127.0.0.1") -> int:
    if is_port_free(preferred_port, host=host):
        return preferred_port
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind((host, 0))
        return int(sock.getsockname()[1])


def build_delivery_plan(
    repo_root: Path,
    backend_port: int,
    frontend_port: int,
    workspace_screenshot_path: Path,
    evidence_screenshot_path: Path,
    frontend_smoke_report_path: Path | None = None,
    frontend_mode: str = DEFAULT_FRONTEND_MODE,
    frontend_smoke_scope: str = "full",
) -> DeliveryPlan:
    backend_url = f"http://127.0.0.1:{backend_port}"
    frontend_url = f"http://127.0.0.1:{frontend_port}"
    backend_cwd = repo_root / "orchestrator" / "backend"
    frontend_cwd = repo_root / "frontend"
    frontend_smoke_report = frontend_smoke_report_path or evidence_screenshot_path.with_name("frontend-smoke.json")
    if frontend_mode not in {"preview", "dev"}:
        raise ValueError(f"Unsupported frontend mode: {frontend_mode}")
    if frontend_smoke_scope not in {"full", "canvaspro"}:
        raise ValueError(f"Unsupported frontend smoke scope: {frontend_smoke_scope}")
    frontend_env = {
        "VITE_DREAMY_ORCHESTRATOR_BASE_URL": backend_url,
        "VITE_DREAMY_ORCHESTRATOR_PROXY_TARGET": backend_url,
        "STUDIO_FRONTEND_URL": frontend_url,
    }
    frontend_build = (
        CommandSpec(
            id="frontend-build",
            cwd=frontend_cwd,
            command=["npm", "run", "build"],
            env=frontend_env,
        )
        if frontend_mode == "preview"
        else None
    )
    frontend_command = (
        ["npm", "run", "preview", "--", "--host", "127.0.0.1", "--port", str(frontend_port)]
        if frontend_mode == "preview"
        else ["npm", "run", "dev", "--", "--host", "127.0.0.1", "--port", str(frontend_port), "--strictPort"]
    )
    frontend_smoke_command = [
        "npm",
        "run",
        "smoke:studio",
        "--",
        "--workspace-screenshot",
        str(workspace_screenshot_path),
        "--evidence-screenshot",
        str(evidence_screenshot_path),
        "--report",
        str(frontend_smoke_report),
    ]
    if frontend_smoke_scope == "canvaspro":
        frontend_smoke_command.append("--canvaspro-only")

    return DeliveryPlan(
        backend=CommandSpec(
            id="backend",
            cwd=backend_cwd,
            command=[sys.executable, "main.py"],
            env={"PORT": str(backend_port)},
        ),
        frontend_build=frontend_build,
        frontend=CommandSpec(
            id="frontend",
            cwd=frontend_cwd,
            command=frontend_command,
            env=frontend_env,
        ),
        backend_smoke=CommandSpec(
            id="backend-smoke",
            cwd=backend_cwd,
            command=[sys.executable, "-m", "studio_smoke", "--base-url", backend_url],
        ),
        frontend_smoke=CommandSpec(
            id="frontend-smoke",
            cwd=frontend_cwd,
            command=frontend_smoke_command,
            env={"STUDIO_FRONTEND_URL": frontend_url},
        ),
        backend_health_url=f"{backend_url}/api/health",
        frontend_url=frontend_url,
        frontend_mode=frontend_mode,
        frontend_smoke_scope=frontend_smoke_scope,
    )


def wait_for_url(url: str, timeout_seconds: float) -> StepResult:
    started = time.monotonic()
    last_error = ""
    while time.monotonic() - started < timeout_seconds:
        try:
            with urlopen(url, timeout=2) as response:
                if 200 <= int(response.status) < 500:
                    return StepResult(
                        id=f"wait:{url}",
                        ok=True,
                        duration_seconds=time.monotonic() - started,
                        message=f"Ready with HTTP {response.status}",
                    )
        except (OSError, URLError) as error:
            last_error = str(error)
        time.sleep(0.5)
    return StepResult(
        id=f"wait:{url}",
        ok=False,
        duration_seconds=time.monotonic() - started,
        message=last_error or "Timed out waiting for URL",
    )


def wait_for_process_url(
    process: subprocess.Popen[str],
    url: str,
    timeout_seconds: float,
) -> StepResult:
    started = time.monotonic()
    last_error = ""
    while time.monotonic() - started < timeout_seconds:
        return_code = process.poll()
        if return_code is not None:
            return StepResult(
                id=f"wait:{url}",
                ok=False,
                duration_seconds=time.monotonic() - started,
                message=f"Started process exited with code {return_code}",
            )
        try:
            with urlopen(url, timeout=2) as response:
                if 200 <= int(response.status) < 500:
                    return StepResult(
                        id=f"wait:{url}",
                        ok=True,
                        duration_seconds=time.monotonic() - started,
                        message=f"Ready with HTTP {response.status}",
                    )
        except (OSError, URLError) as error:
            last_error = str(error)
        time.sleep(0.5)
    return StepResult(
        id=f"wait:{url}",
        ok=False,
        duration_seconds=time.monotonic() - started,
        message=last_error or "Timed out waiting for process URL",
    )


def run_command(spec: CommandSpec, timeout_seconds: float) -> StepResult:
    started = time.monotonic()
    try:
        completed = subprocess.run(
            spec.command,
            cwd=spec.cwd,
            env=spec.merged_env(),
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=timeout_seconds,
            check=False,
        )
    except subprocess.TimeoutExpired as error:
        output = (error.stdout or "") if isinstance(error.stdout, str) else ""
        return StepResult(
            id=spec.id,
            ok=False,
            duration_seconds=time.monotonic() - started,
            message=f"Timed out after {timeout_seconds:.0f}s",
            output=output[-4000:],
        )
    except OSError as error:
        return StepResult(
            id=spec.id,
            ok=False,
            duration_seconds=time.monotonic() - started,
            message=str(error),
        )

    return StepResult(
        id=spec.id,
        ok=completed.returncode == 0,
        duration_seconds=time.monotonic() - started,
        message=f"exit {completed.returncode}",
        output=(completed.stdout or "")[-4000:],
    )


def start_process(spec: CommandSpec, log_path: Path) -> tuple[subprocess.Popen[str], Any]:
    log_path.parent.mkdir(parents=True, exist_ok=True)
    handle = log_path.open("w", encoding="utf-8")
    process = subprocess.Popen(
        spec.command,
        cwd=spec.cwd,
        env=spec.merged_env(),
        text=True,
        stdout=handle,
        stderr=subprocess.STDOUT,
    )
    return process, handle


def stop_process(process: subprocess.Popen[str], handle: Any) -> None:
    try:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=8)
    finally:
        handle.close()


def extract_json_object_from_output(output: str) -> dict[str, Any] | None:
    decoder = json.JSONDecoder()
    for index, character in enumerate(output or ""):
        if character != "{":
            continue
        try:
            candidate, end_index = decoder.raw_decode(output[index:])
        except json.JSONDecodeError:
            continue
        if isinstance(candidate, dict) and not output[index + end_index :].strip():
            return candidate
        if isinstance(candidate, dict):
            return candidate
    return None


def read_json_report(path: Path | None) -> dict[str, Any] | None:
    if not path or not path.exists():
        return None
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return parsed if isinstance(parsed, dict) else None


def build_step_reports(steps: list[StepResult], frontend_smoke_report_path: Path | None = None) -> dict[str, Any]:
    reports: dict[str, Any] = {}
    frontend_smoke_file = read_json_report(frontend_smoke_report_path)
    if frontend_smoke_file:
        reports["frontendSmoke"] = frontend_smoke_file
    for step in steps:
        if step.id == "frontend-smoke" and "frontendSmoke" not in reports:
            frontend_smoke = extract_json_object_from_output(step.output)
            if frontend_smoke:
                reports["frontendSmoke"] = frontend_smoke
        elif step.id == "backend-smoke":
            backend_smoke = extract_json_object_from_output(step.output)
            if backend_smoke:
                reports["backendSmoke"] = backend_smoke
    return reports


def create_delivery_summary(
    repo_root: Path,
    backend_port: int,
    frontend_port: int,
    artifacts_dir: Path,
    workspace_screenshot_path: Path,
    evidence_screenshot_path: Path,
    report_path: Path,
    steps: list[StepResult],
    frontend_mode: str = DEFAULT_FRONTEND_MODE,
    frontend_smoke_scope: str = "full",
    frontend_smoke_report_path: Path | None = None,
) -> dict[str, Any]:
    failures = [step.to_json() for step in steps if not step.ok]
    reports = build_step_reports(steps, frontend_smoke_report_path)
    artifacts: dict[str, Any] = {
        "directory": str(artifacts_dir),
        "report": str(report_path),
        "screenshot": str(evidence_screenshot_path),
        "workspaceScreenshot": str(workspace_screenshot_path),
        "evidenceScreenshot": str(evidence_screenshot_path),
        "backendLog": str(artifacts_dir / "backend.log"),
        "frontendLog": str(artifacts_dir / "frontend.log"),
    }
    if frontend_smoke_report_path:
        artifacts["frontendSmokeReport"] = str(frontend_smoke_report_path)
    return {
        "status": "failed" if failures else "ok",
        "checkedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "repoRoot": str(repo_root),
        "backendUrl": f"http://127.0.0.1:{backend_port}",
        "frontendUrl": f"http://127.0.0.1:{frontend_port}",
        "frontendMode": frontend_mode,
        "frontendSmokeScope": frontend_smoke_scope,
        "artifacts": artifacts,
        "summary": {
            "total": len(steps),
            "passed": len([step for step in steps if step.ok]),
            "failed": len(failures),
        },
        "steps": [step.to_json() for step in steps],
        "reports": reports,
        "failures": failures,
    }


def write_delivery_summary(summary: dict[str, Any], report_path: Path) -> None:
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")


def run_delivery_check(args: argparse.Namespace) -> dict[str, Any]:
    repo_root = Path(args.repo_root).resolve()
    backend_port = args.backend_port or find_free_port(DEFAULT_BACKEND_PORT)
    frontend_port = args.frontend_port or find_free_port(DEFAULT_FRONTEND_PORT)
    artifacts_dir = Path(args.artifacts_dir).resolve() if args.artifacts_dir else repo_root / ".studio-delivery-check"
    workspace_screenshot_path = (
        Path(args.workspace_screenshot).resolve()
        if args.workspace_screenshot
        else artifacts_dir / "dreamy-workspace.png"
    )
    evidence_screenshot_path = (
        Path(args.evidence_screenshot or args.screenshot).resolve()
        if args.evidence_screenshot or args.screenshot
        else artifacts_dir / "dreamy-evidence.png"
    )
    frontend_smoke_report_path = artifacts_dir / "frontend-smoke.json"
    report_path = Path(args.report).resolve() if args.report else artifacts_dir / "summary.json"
    plan = build_delivery_plan(
        repo_root=repo_root,
        backend_port=backend_port,
        frontend_port=frontend_port,
        workspace_screenshot_path=workspace_screenshot_path,
        evidence_screenshot_path=evidence_screenshot_path,
        frontend_smoke_report_path=frontend_smoke_report_path,
        frontend_mode=args.frontend_mode,
        frontend_smoke_scope=args.frontend_smoke_scope,
    )

    steps: list[StepResult] = []
    started: list[tuple[subprocess.Popen[str], Any]] = []
    def finish() -> dict[str, Any]:
        summary = create_delivery_summary(
            repo_root=repo_root,
            backend_port=backend_port,
            frontend_port=frontend_port,
            artifacts_dir=artifacts_dir,
            workspace_screenshot_path=workspace_screenshot_path,
            evidence_screenshot_path=evidence_screenshot_path,
            report_path=report_path,
            steps=steps,
            frontend_mode=plan.frontend_mode,
            frontend_smoke_scope=plan.frontend_smoke_scope,
            frontend_smoke_report_path=frontend_smoke_report_path,
        )
        write_delivery_summary(summary, report_path)
        return summary

    try:
        backend_process, backend_log = start_process(plan.backend, artifacts_dir / "backend.log")
        started.append((backend_process, backend_log))
        steps.append(wait_for_process_url(backend_process, plan.backend_health_url, args.timeout_seconds))
        if not steps[-1].ok:
            return finish()

        if plan.frontend_build:
            steps.append(run_command(plan.frontend_build, args.timeout_seconds))
            if not steps[-1].ok:
                return finish()

        frontend_process, frontend_log = start_process(plan.frontend, artifacts_dir / "frontend.log")
        started.append((frontend_process, frontend_log))
        steps.append(wait_for_process_url(frontend_process, plan.frontend_url, args.timeout_seconds))
        if not steps[-1].ok:
            return finish()

        steps.append(run_command(plan.backend_smoke, args.timeout_seconds))
        if args.stop_on_failure and not steps[-1].ok:
            return finish()

        steps.append(run_command(plan.frontend_smoke, args.timeout_seconds))
        return finish()
    finally:
        for process, handle in reversed(started):
            stop_process(process, handle)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run local MyShell Studio delivery smoke checks.")
    parser.add_argument("--repo-root", default=str(repo_root_from_script()))
    parser.add_argument("--backend-port", type=int, default=0, help="Backend port. Defaults to 8090 or a free port.")
    parser.add_argument("--frontend-port", type=int, default=0, help="Frontend port. Defaults to 5174 or a free port.")
    parser.add_argument(
        "--frontend-mode",
        choices=("preview", "dev"),
        default=DEFAULT_FRONTEND_MODE,
        help="Use production build preview by default; dev is faster for local iteration.",
    )
    parser.add_argument(
        "--frontend-smoke-scope",
        choices=("full", "canvaspro"),
        default="full",
        help="Run the full Studio frontend smoke or only /dreamy?workspace=canvaspro.",
    )
    parser.add_argument("--timeout-seconds", type=float, default=DEFAULT_TIMEOUT_SECONDS)
    parser.add_argument("--artifacts-dir", default="", help="Directory for logs, screenshots, and summary JSON.")
    parser.add_argument("--report", default="", help="Path for the delivery summary JSON.")
    parser.add_argument("--screenshot", default="", help="Legacy alias for --evidence-screenshot.")
    parser.add_argument("--workspace-screenshot", default="", help="Canvas workspace screenshot path.")
    parser.add_argument("--evidence-screenshot", default="", help="Delivery Evidence drawer screenshot path.")
    parser.add_argument("--stop-on-failure", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    summary = run_delivery_check(args)
    print(json.dumps(summary, indent=2))
    return 0 if summary["status"] == "ok" else 1


if __name__ == "__main__":
    raise SystemExit(main())
