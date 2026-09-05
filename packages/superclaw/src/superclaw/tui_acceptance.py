from __future__ import annotations

import json
import os
import select
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Callable, Sequence


AcceptanceStepRunner = Callable[[], dict[str, Any]]

try:
    import pty
except ModuleNotFoundError:  # pragma: no cover - Windows import guard.
    pty = None


def tui_acceptance_report_path(*, workspace_root: Path) -> Path:
    configured = os.environ.get("SUPERCLAW_TUI_ACCEPTANCE_REPORT", "").strip()
    if configured:
        return Path(configured).expanduser().resolve()
    return workspace_root / ".superclaw" / "tui" / "tui-acceptance.json"


def _ensure_parent_directory(target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)


def _tail_lines(text: str, *, limit: int = 20) -> list[str]:
    return text.strip().splitlines()[-limit:] if text.strip() else []


def _default_python_executable(workspace_root: Path) -> Path:
    venv_python = workspace_root / ".venv" / "bin" / "python"
    if venv_python.exists():
        return venv_python.absolute()
    venv_python3 = workspace_root / ".venv" / "bin" / "python3"
    if venv_python3.exists():
        return venv_python3.absolute()
    return Path(sys.executable).absolute()


def _acceptance_env(workspace_root: Path, artifact_root: Path) -> dict[str, str]:
    env = os.environ.copy()
    pythonpath_entries = [str((workspace_root / "packages" / "superclaw" / "src").resolve())]
    existing_pythonpath = env.get("PYTHONPATH", "").strip()
    if existing_pythonpath:
        pythonpath_entries.append(existing_pythonpath)
    env["PYTHONPATH"] = os.pathsep.join(pythonpath_entries)
    # Pin the whole HOME data root into the report tmp so the acceptance subprocess
    # never reads/writes the developer's real ~/.superclaw (state, telemetry, artifacts,
    # plugin evidence). The explicit per-var pins below stay for clarity/back-compat.
    env["SUPERCLAW_HOME"] = str(artifact_root.resolve())
    env["SUPERCLAW_STATE_PATH"] = str((artifact_root / "state.db").resolve())
    env["SUPERCLAW_PLUGIN_CACHE_PATH"] = str((artifact_root / "plugin-cache").resolve())
    # NOTE: the artifacts-root env var is SUPERCLAW_ARTIFACT_DIR (read by
    # environment.default_artifact_dir); the old SUPERCLAW_ARTIFACT_ROOT name was a no-op.
    env["SUPERCLAW_ARTIFACT_DIR"] = str((artifact_root / "artifacts").resolve())
    env.setdefault("TERM", "xterm-256color")
    env.setdefault("COLUMNS", "120")
    env.setdefault("LINES", "40")
    return env


def _run_command_step(*, name: str, command: list[str], cwd: Path, env: dict[str, str], timeout_seconds: float = 120.0) -> dict[str, Any]:
    started_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    timer_started_at = time.time()
    completed = subprocess.run(
        command,
        cwd=str(cwd),
        env=env,
        check=False,
        capture_output=True,
        text=True,
        timeout=timeout_seconds,
    )
    duration_ms = int(round((time.time() - timer_started_at) * 1000))
    return {
        "name": name,
        "command": " ".join(command),
        "started_at": started_at,
        "duration_ms": duration_ms,
        "code": completed.returncode,
        "signal": None,
        "ok": completed.returncode == 0,
        "stdout_tail": _tail_lines(completed.stdout),
        "stderr_tail": _tail_lines(completed.stderr),
    }


def _run_launch_smoke_step(*, command: list[str], cwd: Path, env: dict[str, str], timeout_seconds: float = 12.0) -> dict[str, Any]:
    started_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    timer_started_at = time.time()
    if pty is None:
        return {
            "name": "launch_smoke",
            "command": " ".join(command),
            "started_at": started_at,
            "duration_ms": int(round((time.time() - timer_started_at) * 1000)),
            "code": None,
            "signal": None,
            "ok": False,
            "stdout_tail": [],
            "stderr_tail": ["TUI launch smoke requires POSIX pty support."],
        }
    master_fd, slave_fd = pty.openpty()
    output = bytearray()
    child = subprocess.Popen(
        command,
        cwd=str(cwd),
        env=env,
        stdin=slave_fd,
        stdout=slave_fd,
        stderr=slave_fd,
        close_fds=True,
    )
    os.close(slave_fd)

    sent_quit = False
    try:
        while time.time() - timer_started_at < timeout_seconds:
            ready, _, _ = select.select([master_fd], [], [], 0.1)
            if ready:
                try:
                    chunk = os.read(master_fd, 4096)
                except OSError:
                    chunk = b""
                if chunk:
                    output.extend(chunk)
            if not sent_quit and time.time() - timer_started_at >= 1.0:
                try:
                    os.write(master_fd, b"\x11")
                except OSError:
                    pass
                sent_quit = True
            return_code = child.poll()
            if return_code is not None:
                break
        else:
            try:
                os.write(master_fd, b"\x03")
            except OSError:
                pass
            child.terminate()
            try:
                child.wait(timeout=2.0)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=2.0)
    finally:
        try:
            os.close(master_fd)
        except OSError:
            pass

    duration_ms = int(round((time.time() - timer_started_at) * 1000))
    stdout_text = output.decode("utf-8", errors="replace")
    return_code = child.poll()
    ok = return_code == 0 and sent_quit
    stderr_tail = [] if ok else ["TUI launch smoke did not exit cleanly after Ctrl+Q."]
    return {
        "name": "launch_smoke",
        "command": " ".join(command),
        "started_at": started_at,
        "duration_ms": duration_ms,
        "code": return_code,
        "signal": None,
        "ok": ok,
        "stdout_tail": _tail_lines(stdout_text),
        "stderr_tail": stderr_tail,
    }


def _default_step_runners(
    *,
    workspace_root: Path,
    python_executable: Path,
    artifact_root: Path,
    snapshot_file: Path,
) -> list[tuple[str, AcceptanceStepRunner]]:
    env = _acceptance_env(workspace_root, artifact_root)
    return [
        (
            "pytest",
            lambda: _run_command_step(
                name="pytest",
                command=[str(python_executable), "-m", "pytest", "tests/test_tui.py"],
                cwd=workspace_root,
                env=env,
            ),
        ),
        (
            "snapshot_dump",
            lambda: _run_command_step(
                name="snapshot_dump",
                command=[
                    str(python_executable),
                    "-m",
                    "superclaw.cli",
                    "tui",
                    "--backend",
                    "local",
                    "--mode",
                    "chat",
                    "--repo",
                    ".",
                    "--dump-snapshot",
                ],
                cwd=workspace_root,
                env=env,
            ),
        ),
        (
            "snapshot_export",
            lambda: _run_command_step(
                name="snapshot_export",
                command=[
                    str(python_executable),
                    "-m",
                    "superclaw.cli",
                    "tui",
                    "--backend",
                    "local",
                    "--mode",
                    "chat",
                    "--repo",
                    ".",
                    "--snapshot-file",
                    str(snapshot_file),
                ],
                cwd=workspace_root,
                env=env,
            ),
        ),
        (
            "launch_smoke",
            lambda: _run_launch_smoke_step(
                command=[
                    str(python_executable),
                    "-m",
                    "superclaw.cli",
                    "tui",
                    "--backend",
                    "local",
                    "--mode",
                    "chat",
                    "--repo",
                    ".",
                ],
                cwd=workspace_root,
                env=env,
            ),
        ),
    ]


def run_tui_acceptance(
    *,
    workspace_root: Path,
    python_executable: Path | None = None,
    report_path: Path | None = None,
    report_file: Path | None = None,
    snapshot_file: Path | None = None,
    step_runners: Sequence[tuple[str, AcceptanceStepRunner]] | None = None,
) -> dict[str, Any]:
    resolved_workspace_root = workspace_root.resolve()
    resolved_python = (python_executable or _default_python_executable(resolved_workspace_root)).absolute()
    selected_report_path = report_path or report_file or tui_acceptance_report_path(workspace_root=resolved_workspace_root)
    resolved_report_path = selected_report_path.resolve()
    artifact_root = resolved_report_path.parent / "tmp"
    resolved_snapshot_file = (snapshot_file or artifact_root / "tui-snapshot.json").resolve()
    _ensure_parent_directory(resolved_report_path)
    _ensure_parent_directory(resolved_snapshot_file)
    artifact_root.mkdir(parents=True, exist_ok=True)

    runners = list(step_runners or _default_step_runners(
        workspace_root=resolved_workspace_root,
        python_executable=resolved_python,
        artifact_root=artifact_root,
        snapshot_file=resolved_snapshot_file,
    ))
    report: dict[str, Any] = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "workspace_root": str(resolved_workspace_root),
        "python_executable": str(resolved_python),
        "snapshot_path": str(resolved_snapshot_file),
        "success": True,
        "failed_step": None,
        "steps": [],
    }

    for name, runner in runners:
        try:
            result = dict(runner())
        except Exception as exc:
            result = {
                "name": name,
                "command": name,
                "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "duration_ms": 0,
                "code": None,
                "signal": None,
                "ok": False,
                "stdout_tail": [],
                "stderr_tail": [str(exc)],
            }
        result.setdefault("name", name)
        report["steps"].append(result)
        if result.get("ok") is not True:
            report["success"] = False
            report["failed_step"] = result["name"]
            break

    resolved_report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return report
