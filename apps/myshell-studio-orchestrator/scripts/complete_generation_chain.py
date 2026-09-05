#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Callable, NamedTuple


REPO_ROOT = Path(__file__).resolve().parents[1]
WORKSPACE_ROOT = REPO_ROOT.parents[1]
DEFAULT_BASE_URL = "https://art-chat-orchestrator-ju35f47zeq-ew.a.run.app"
DEFAULT_PROJECT = "k-project-481102"
DEFAULT_SERVICE = "art-chat-orchestrator"
DEFAULT_REGION = "europe-west1"
ART_TARGET_OUTPUT = REPO_ROOT / ".studio-delivery-check" / "target-bot-preview-urls.json"
DREAMY_TARGET_OUTPUT = REPO_ROOT / ".studio-delivery-check" / "dreamy-target-preview-urls.json"
CLOUDBUILD_CONFIG = REPO_ROOT / "orchestrator" / "cloudbuild.yaml"


class CommandResult(NamedTuple):
    returncode: int
    stdout: str
    stderr: str


Runner = Callable[[list[str], float, dict[str, str]], CommandResult]


class CompleteGenerationChainError(RuntimeError):
    pass


def _now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def _script(path: str) -> str:
    return str(REPO_ROOT / path)


def _chain_check_command(*, base_url: str, project: str, service: str, region: str, require_live: bool) -> list[str]:
    command = [
        sys.executable,
        _script("scripts/generation_chain_check.py"),
        "--base-url",
        base_url,
        "--project",
        project,
        "--service",
        service,
        "--region",
        region,
    ]
    if require_live:
        command.append("--require-live")
    return command


def _default_short_sha() -> str:
    try:
        completed = subprocess.run(
            ["git", "-C", str(WORKSPACE_ROOT), "rev-parse", "--short", "HEAD"],
            capture_output=True,
            text=True,
            timeout=10.0,
            check=True,
        )
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError):
        return "local"
    return completed.stdout.strip() or "local"


def _deploy_command(*, project: str, short_sha: str) -> list[str]:
    return [
        "gcloud",
        "builds",
        "submit",
        "--config",
        str(CLOUDBUILD_CONFIG),
        "--project",
        project,
        "--substitutions",
        f"SHORT_SHA={short_sha}",
        str(WORKSPACE_ROOT),
    ]


def _step(
    *,
    step_id: str,
    label: str,
    command: list[str],
    enabled: bool,
    generating: bool = False,
    timeout: float = 300.0,
    env: dict[str, str] | None = None,
) -> dict[str, Any]:
    return {
        "id": step_id,
        "label": label,
        "enabled": enabled,
        "willRun": False,
        "generating": generating,
        "timeout": timeout,
        "command": command,
        "env": dict(env or {}),
    }


def build_plan(
    *,
    base_url: str = DEFAULT_BASE_URL,
    project: str = DEFAULT_PROJECT,
    service: str = DEFAULT_SERVICE,
    region: str = DEFAULT_REGION,
    apply: bool = False,
    configure_secrets: bool = False,
    init_data_file: Path | None = None,
    cookies_file: Path | None = None,
    execute_live: bool = False,
    execute_art_targets: bool = False,
    import_dreamy_targets: bool = False,
    materialize: bool = False,
    deploy_after_materialize: bool = False,
    allow_partial: bool = False,
    short_sha: str = "",
) -> dict[str, Any]:
    if configure_secrets and (not init_data_file or not cookies_file):
        raise CompleteGenerationChainError("--configure-secrets requires --init-data-file and --cookies-file")
    if deploy_after_materialize and not materialize:
        raise CompleteGenerationChainError("--deploy-after-materialize requires --materialize")

    active_short_sha = short_sha or _default_short_sha()

    configure_command = [
        _script("scripts/configure_generation_secrets.sh"),
        "--project",
        project,
        "--init-data-file",
        str(init_data_file or "<dreamy-init-data.txt>"),
        "--cookies-file",
        str(cookies_file or "<myshell-cookies.json>"),
        "--apply",
        "--no-smoke",
    ]
    if short_sha:
        configure_command.extend(["--short-sha", short_sha])

    dreamy_command = [
        sys.executable,
        _script("scripts/materialize_dreamy_target_previews.py"),
        "--base-url",
        base_url,
        "--output",
        str(DREAMY_TARGET_OUTPUT),
    ]
    if allow_partial:
        dreamy_command.append("--allow-partial")
    art_target_env = {"MYSHELL_COOKIES_FILE": str(cookies_file)} if cookies_file else {}

    steps = [
        _step(
            step_id="precheck",
            label="Read current generation chain state",
            command=_chain_check_command(base_url=base_url, project=project, service=service, region=region, require_live=False),
            enabled=True,
            timeout=120.0,
        ),
        _step(
            step_id="configure-secrets",
            label="Validate and upload generation secrets, then deploy Cloud Run",
            command=configure_command,
            enabled=configure_secrets,
            timeout=1800.0,
        ),
        _step(
            step_id="live-smoke",
            label="Run real Dreamy live generation smoke",
            command=[
                sys.executable,
                _script("orchestrator/backend/generation_smoke.py"),
                "--base-url",
                base_url,
                "--execute",
                "--require-live",
                "--timeout",
                "180",
            ],
            enabled=execute_live,
            generating=True,
            timeout=240.0,
        ),
        _step(
            step_id="art-target-previews",
            label="Run real MyShell Art target bot previews",
            command=[
                sys.executable,
                _script("scripts/run_target_bot_previews.py"),
                "--executor",
                "art-api",
                "--output",
                str(ART_TARGET_OUTPUT),
                "--merge-existing",
            ],
            enabled=execute_art_targets,
            generating=True,
            timeout=3600.0,
            env=art_target_env,
        ),
        _step(
            step_id="materialize-art-targets",
            label="Merge Art target execution evidence into preview manifest",
            command=[
                sys.executable,
                _script("scripts/materialize_bot_preview_manifest.py"),
                "--input",
                str(ART_TARGET_OUTPUT),
                "--merge-existing-manifest",
            ],
            enabled=execute_art_targets and materialize,
            timeout=900.0,
        ),
        _step(
            step_id="dreamy-target-import",
            label="Import accepted Dreamy server jobs as target preview evidence",
            command=dreamy_command,
            enabled=import_dreamy_targets,
            timeout=120.0,
        ),
        _step(
            step_id="materialize-dreamy-targets",
            label="Merge Dreamy target execution evidence into preview manifest",
            command=[
                sys.executable,
                _script("scripts/materialize_bot_preview_manifest.py"),
                "--input",
                str(DREAMY_TARGET_OUTPUT),
                "--merge-existing-manifest",
            ],
            enabled=import_dreamy_targets and materialize,
            timeout=900.0,
        ),
        _step(
            step_id="deploy-after-materialize",
            label="Deploy materialized preview manifest to Cloud Run",
            command=_deploy_command(project=project, short_sha=active_short_sha),
            enabled=deploy_after_materialize,
            timeout=1800.0,
        ),
        _step(
            step_id="final-check",
            label="Require the public generation chain to be fully live",
            command=_chain_check_command(base_url=base_url, project=project, service=service, region=region, require_live=True),
            enabled=True,
            timeout=120.0,
        ),
    ]
    for step in steps:
        step["willRun"] = bool(apply and step["enabled"])
    return {
        "status": "ready_to_apply" if apply else "dry_run",
        "checkedAt": _now_iso(),
        "baseUrl": base_url,
        "project": project,
        "service": service,
        "region": region,
        "steps": steps,
        "warnings": [
            "Default mode is a dry-run; pass --apply to run enabled steps.",
            "Live smoke and Art target preview execution spend real generation capacity and require explicit flags.",
            "Post-materialize deployment is explicit; pass --deploy-after-materialize to publish manifest changes before the final public gate.",
        ],
    }


def _run_command(command: list[str], timeout: float, env: dict[str, str]) -> CommandResult:
    completed = subprocess.run(
        command,
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        timeout=timeout,
        env={**os.environ, **env} if env else None,
    )
    return CommandResult(returncode=completed.returncode, stdout=completed.stdout, stderr=completed.stderr)


def run_plan(plan: dict[str, Any], *, runner: Runner = _run_command) -> dict[str, Any]:
    report_steps: list[dict[str, Any]] = []
    failed_step: dict[str, Any] | None = None
    for step in plan["steps"]:
        step_report = {key: value for key, value in step.items() if key != "command"}
        step_report["command"] = step["command"]
        if not step.get("willRun"):
            step_report["ran"] = False
            step_report["status"] = "skipped"
            report_steps.append(step_report)
            continue
        result = runner(
            [str(part) for part in step["command"]],
            float(step.get("timeout") or 300.0),
            {str(key): str(value) for key, value in dict(step.get("env") or {}).items()},
        )
        step_report.update(
            {
                "ran": True,
                "status": "ok" if result.returncode == 0 else "failed",
                "returncode": result.returncode,
                "stdout": result.stdout,
                "stderr": result.stderr,
            }
        )
        report_steps.append(step_report)
        if result.returncode != 0:
            failed_step = step_report
            break
    return {
        "status": "failed" if failed_step else "ok",
        "checkedAt": _now_iso(),
        "baseUrl": plan.get("baseUrl"),
        "project": plan.get("project"),
        "steps": report_steps,
        "failedStep": failed_step,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Plan or run the full MyShell Studio generation chain finalization.")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--project", default=DEFAULT_PROJECT)
    parser.add_argument("--service", default=DEFAULT_SERVICE)
    parser.add_argument("--region", default=DEFAULT_REGION)
    parser.add_argument("--apply", action="store_true", help="Run enabled steps. Omit for a dry-run plan.")
    parser.add_argument("--configure-secrets", action="store_true", help="Run configure_generation_secrets.sh before live checks.")
    parser.add_argument("--init-data-file", type=Path)
    parser.add_argument("--cookies-file", type=Path)
    parser.add_argument("--execute-live", action="store_true", help="Run a real Dreamy live generation smoke.")
    parser.add_argument("--execute-art-targets", action="store_true", help="Run real Art target bot previews.")
    parser.add_argument("--import-dreamy-targets", action="store_true", help="Import accepted Dreamy jobs as target preview evidence.")
    parser.add_argument("--materialize", action="store_true", help="Merge target preview evidence into the public manifest.")
    parser.add_argument("--deploy-after-materialize", action="store_true", help="Deploy Cloud Run after manifest materialization.")
    parser.add_argument("--allow-partial", action="store_true", help="Allow partial Dreamy import evidence.")
    parser.add_argument("--short-sha", default="")
    args = parser.parse_args(argv)

    try:
        plan = build_plan(
            base_url=args.base_url,
            project=args.project,
            service=args.service,
            region=args.region,
            apply=args.apply,
            configure_secrets=args.configure_secrets,
            init_data_file=args.init_data_file,
            cookies_file=args.cookies_file,
            execute_live=args.execute_live,
            execute_art_targets=args.execute_art_targets,
            import_dreamy_targets=args.import_dreamy_targets,
            materialize=args.materialize,
            deploy_after_materialize=args.deploy_after_materialize,
            allow_partial=args.allow_partial,
            short_sha=args.short_sha,
        )
        result = run_plan(plan) if args.apply else plan
    except CompleteGenerationChainError as exc:
        print(json.dumps({"status": "error", "message": str(exc)}, indent=2, ensure_ascii=False), file=sys.stderr)
        return 2
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0 if result["status"] in {"dry_run", "ready_to_apply", "ok"} else 1


if __name__ == "__main__":
    raise SystemExit(main())
