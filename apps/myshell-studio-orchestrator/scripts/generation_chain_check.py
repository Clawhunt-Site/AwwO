#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin
from urllib.request import Request, urlopen


REQUIRED_SECRET_NAMES = ("myshell-dreamy-init-data", "myshell-cookies")


class GenerationChainCheckError(RuntimeError):
    pass


def _now_iso() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def fetch_json(base_url: str, path: str, timeout: float = 30.0) -> dict[str, Any]:
    url = urljoin(base_url.rstrip("/") + "/", path.lstrip("/"))
    headers = {"Accept": "application/json"}
    token = os.environ.get("STUDIO_AUTH_TOKEN", "").strip()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = Request(url, headers=headers)
    try:
        with urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (HTTPError, URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise GenerationChainCheckError(f"failed to fetch {path}: {exc}") from exc
    if not isinstance(payload, dict):
        raise GenerationChainCheckError(f"{path} returned a non-object payload")
    return payload


def _run_text(command: list[str], timeout: float = 30.0) -> tuple[int, str, str]:
    completed = subprocess.run(command, capture_output=True, text=True, timeout=timeout)
    return completed.returncode, completed.stdout.strip(), completed.stderr.strip()


def _secret_status(project: str, runner: Callable[[list[str]], tuple[int, str, str]] = _run_text) -> dict[str, Any]:
    if not project:
        return {
            "status": "skipped",
            "message": "No Google Cloud project was provided.",
            "secrets": [],
            "missing": list(REQUIRED_SECRET_NAMES),
        }
    if runner is _run_text and not shutil.which("gcloud"):
        return {
            "status": "skipped",
            "message": "gcloud is not available on this machine.",
            "secrets": [],
            "missing": list(REQUIRED_SECRET_NAMES),
        }

    secrets: list[dict[str, Any]] = []
    missing: list[str] = []
    for secret_name in REQUIRED_SECRET_NAMES:
        code, _stdout, stderr = runner(["gcloud", "secrets", "describe", secret_name, "--project", project, "--format=value(name)"])
        exists = code == 0
        secrets.append(
            {
                "name": secret_name,
                "exists": exists,
                "status": "ready" if exists else "missing",
                "message": "" if exists else (stderr or "Secret not found"),
            }
        )
        if not exists:
            missing.append(secret_name)
    return {
        "status": "ready" if not missing else "needs_configuration",
        "project": project,
        "secrets": secrets,
        "missing": missing,
    }


def _cloud_run_status(
    project: str,
    service: str,
    region: str,
    runner: Callable[[list[str]], tuple[int, str, str]] = _run_text,
) -> dict[str, Any]:
    if not project or not service or not region:
        return {"status": "skipped", "message": "Cloud Run project, service, or region is missing."}
    if runner is _run_text and not shutil.which("gcloud"):
        return {"status": "skipped", "message": "gcloud is not available on this machine."}
    code, stdout, stderr = runner(
        [
            "gcloud",
            "run",
            "services",
            "describe",
            service,
            "--region",
            region,
            "--project",
            project,
            "--format=json",
        ]
    )
    if code != 0:
        return {"status": "error", "message": stderr or stdout}
    try:
        payload = json.loads(stdout)
    except json.JSONDecodeError as exc:
        return {"status": "error", "message": f"Cloud Run describe did not return JSON: {exc}"}
    status = payload.get("status") if isinstance(payload.get("status"), dict) else {}
    traffic = status.get("traffic") if isinstance(status.get("traffic"), list) else []
    latest_ready = str(status.get("latestReadyRevisionName") or "")
    traffic_percent = 0
    for item in traffic:
        if isinstance(item, dict) and item.get("revisionName") == latest_ready:
            traffic_percent += int(item.get("percent") or 0)
    return {
        "status": "ready" if latest_ready and traffic_percent == 100 else "degraded",
        "url": status.get("url") or "",
        "latestReadyRevisionName": latest_ready,
        "latestReadyTrafficPercent": traffic_percent,
    }


def _local_cookie_status() -> dict[str, Any]:
    script_path = Path(__file__).with_name("export_myshell_chrome_cookies.py")
    completed = subprocess.run(
        [sys.executable, str(script_path), "--summary-json"],
        capture_output=True,
        text=True,
        timeout=60,
    )
    try:
        payload = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        return {"status": "error", "message": f"Cookie summary was not JSON: {exc}"}
    if completed.returncode != 0 and payload.get("status") != "ready":
        return {**payload, "status": payload.get("status") or "missing"}
    return payload


def _local_art_api_probe(cookies_file: str) -> dict[str, Any]:
    if not cookies_file:
        return {"status": "skipped", "message": "No local cookie file was provided for Art API probing."}
    script_path = Path(__file__).with_name("probe_myshell_art_api.py")
    completed = subprocess.run(
        [sys.executable, str(script_path), "--cookies-file", cookies_file],
        capture_output=True,
        text=True,
        timeout=90,
    )
    try:
        payload = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        return {"status": "error", "message": f"Art API probe summary was not JSON: {exc}"}
    if completed.returncode != 0 and payload.get("status") != "ready":
        return {**payload, "status": payload.get("status") or "blocked"}
    return payload


def _component_status(health: dict[str, Any], component_id: str) -> str:
    component = (health.get("components") or {}).get(component_id)
    return str(component.get("status") or "missing") if isinstance(component, dict) else "missing"


def _generation_latest_accepted(generation_smoke: dict[str, Any]) -> bool:
    latest = generation_smoke.get("latest") if isinstance(generation_smoke.get("latest"), dict) else {}
    return bool(latest.get("accepted") and latest.get("mediaUrl"))


def _int_value(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _target_execution_breakdown(previews: dict[str, Any], preview_summary: dict[str, Any]) -> dict[str, int]:
    preview_items = previews.get("previews") if isinstance(previews.get("previews"), list) else []
    if preview_items:
        dreamy_total = 0
        art_total = 0
        dreamy_executed = 0
        art_executed = 0
        for preview in preview_items:
            if not isinstance(preview, dict):
                continue
            is_dreamy = str(preview.get("pageId") or "") == "dreamy-miniapp"
            is_executed = bool(
                preview.get("status") == "ready" and preview.get("accepted") and preview.get("targetBotExecuted")
            )
            if is_dreamy:
                dreamy_total += 1
                if is_executed:
                    dreamy_executed += 1
            else:
                art_total += 1
                if is_executed:
                    art_executed += 1
        return {
            "artTargetBotExecuted": art_executed,
            "artTargetBotTotal": art_total,
            "dreamyTargetBotExecuted": dreamy_executed,
            "dreamyTargetBotTotal": dreamy_total,
        }

    art_total = _int_value(preview_summary.get("artBots"))
    dreamy_total = _int_value(preview_summary.get("dreamyBots"))
    art_executed = _int_value(preview_summary.get("artTargetBotExecuted"))
    dreamy_executed = _int_value(preview_summary.get("dreamyTargetBotExecuted"))
    if not art_executed and not dreamy_executed:
        preview_total = _int_value(preview_summary.get("total"))
        preview_target_executed = _int_value(preview_summary.get("targetBotExecuted"))
        if preview_total and preview_target_executed == preview_total and art_total + dreamy_total == preview_total:
            art_executed = art_total
            dreamy_executed = dreamy_total
    return {
        "artTargetBotExecuted": art_executed,
        "artTargetBotTotal": art_total,
        "dreamyTargetBotExecuted": dreamy_executed,
        "dreamyTargetBotTotal": dreamy_total,
    }


def _optional_fetch(fetcher: Callable[[str, str, float], dict[str, Any]], base_url: str, path: str) -> dict[str, Any]:
    try:
        return fetcher(base_url, path, 30.0)
    except Exception as exc:
        return {"status": "unavailable", "message": str(exc)}


def build_generation_chain_report(
    *,
    base_url: str,
    project: str = "",
    service: str = "art-chat-orchestrator",
    region: str = "europe-west1",
    require_live: bool = False,
    check_local_cookies: bool = False,
    probe_local_art_api: bool = False,
    local_cookies_file: str = "",
    local_art_api_probe: Callable[[str], dict[str, Any]] = _local_art_api_probe,
    fetcher: Callable[[str, str, float], dict[str, Any]] = fetch_json,
    runner: Callable[[list[str]], tuple[int, str, str]] = _run_text,
) -> dict[str, Any]:
    health = fetcher(base_url, "/api/health", 30.0)
    previews = fetcher(base_url, "/api/studio/bot-previews", 30.0)
    generation_smoke = fetcher(base_url, "/api/studio/generation-smoke", 30.0)
    art_api_auth = _optional_fetch(fetcher, base_url, "/api/studio/art-api-auth-smoke")

    preview_summary = previews.get("summary") if isinstance(previews.get("summary"), dict) else {}
    preview_ready = int(preview_summary.get("ready") or 0)
    preview_total = int(preview_summary.get("total") or 0)
    preview_bot_specific = int(preview_summary.get("botSpecific") or 0)
    preview_target_executed = int(preview_summary.get("targetBotExecuted") or 0)
    target_execution = _target_execution_breakdown(previews, preview_summary)
    target_execution_evidence = {**preview_summary, **target_execution}
    secrets = _secret_status(project, runner)
    cloud_run = _cloud_run_status(project, service, region, runner)
    local_cookies = _local_cookie_status() if check_local_cookies else {"status": "skipped"}
    local_art_api_auth = local_art_api_probe(local_cookies_file) if probe_local_art_api else {"status": "skipped"}
    latest_accepted = _generation_latest_accepted(generation_smoke)
    art_api_ready = bool(art_api_auth.get("ready") or art_api_auth.get("status") == "ready")
    cdp_art_ready = (
        _component_status(health, "myshellCookies") == "ready"
        and _component_status(health, "cookieInjection") == "ready"
        and _component_status(health, "chromeCdp") == "ok"
    )

    requirements = [
        {
            "id": "public-backend",
            "label": "Public backend responds",
            "status": "ready" if health.get("status") in {"ok", "degraded"} else "blocked",
            "evidence": {"healthStatus": health.get("status")},
        },
        {
            "id": "bot-previews",
            "label": "Dreamy and MyShell bot previews have bot-specific generated assets",
            "status": "ready" if preview_total and preview_ready == preview_total and preview_bot_specific == preview_total else "blocked",
            "evidence": preview_summary,
        },
        {
            "id": "target-bot-preview-execution",
            "label": "Each preview has target bot execution evidence",
            "status": "ready" if preview_total and preview_target_executed == preview_total else "blocked",
            "evidence": target_execution_evidence,
        },
        {
            "id": "cloud-run",
            "label": "Cloud Run latest revision serves 100 percent traffic",
            "status": cloud_run.get("status", "skipped"),
            "evidence": cloud_run,
        },
        {
            "id": "secret-manager",
            "label": "Generation credentials exist in Secret Manager",
            "status": secrets.get("status", "skipped"),
            "evidence": {k: v for k, v in secrets.items() if k != "secrets"},
        },
        {
            "id": "dreamy-server-auth",
            "label": "Dreamy backend generation auth is injected",
            "status": "ready" if _component_status(health, "dreamyApiAuth") == "ready" else "blocked",
            "evidence": {"status": _component_status(health, "dreamyApiAuth")},
        },
        {
            "id": "myshell-art-auth",
            "label": "MyShell Art API or CDP auth is ready",
            "status": "ready" if art_api_ready or cdp_art_ready else "blocked",
            "evidence": {
                "myshellCookies": _component_status(health, "myshellCookies"),
                "cookieInjection": _component_status(health, "cookieInjection"),
                "chromeCdp": _component_status(health, "chromeCdp"),
                "artApiAuth": art_api_auth.get("status"),
                "artApiReady": art_api_ready,
            },
        },
        {
            "id": "live-generation-smoke",
            "label": "Live generation smoke has accepted media",
            "status": "ready" if latest_accepted else str(generation_smoke.get("status") or "blocked"),
            "evidence": {
                "status": generation_smoke.get("status"),
                "readyForLiveRun": generation_smoke.get("readyForLiveRun"),
                "accepted": latest_accepted,
            },
        },
    ]
    if check_local_cookies:
        requirements.append(
            {
                "id": "local-cookies",
                "label": "Local Chrome has exportable MyShell cookies",
                "status": "ready" if local_cookies.get("status") == "ready" else str(local_cookies.get("status") or "missing"),
                "evidence": {
                    "status": local_cookies.get("status"),
                    "cookieCount": local_cookies.get("cookieCount"),
                    "cookieNames": local_cookies.get("cookieNames", []),
                    "requiredCookieNames": local_cookies.get("requiredCookieNames", []),
                    "missingCookieNames": local_cookies.get("missingCookieNames", []),
                    "profiles": [
                        {
                            "profile": profile.get("profile"),
                            "cookieCount": profile.get("cookieCount"),
                            "cookieNames": profile.get("cookieNames", []),
                            "missingCookieNames": profile.get("missingCookieNames", []),
                            "domains": profile.get("domains"),
                        }
                        for profile in local_cookies.get("profiles", [])
                        if isinstance(profile, dict)
                    ],
                },
            }
        )
    if probe_local_art_api:
        requirements.append(
            {
                "id": "local-art-api-auth",
                "label": "Local MyShell Art API auth accepts exported cookies",
                "status": "ready"
                if local_art_api_auth.get("status") == "ready"
                else "skipped"
                if local_art_api_auth.get("status") == "skipped"
                else "blocked",
                "evidence": {
                    "status": local_art_api_auth.get("status"),
                    "authProbe": local_art_api_auth.get("authProbe"),
                    "runningTasksProbe": local_art_api_auth.get("runningTasksProbe"),
                    "execute": local_art_api_auth.get("execute"),
                    "message": local_art_api_auth.get("message"),
                },
            }
        )

    blocking = [item for item in requirements if item["status"] not in {"ready", "skipped"}]
    status = "ready" if not blocking else "blocked" if require_live or any(item["id"] == "live-generation-smoke" for item in blocking) else "degraded"
    next_actions: list[str] = []
    if blocking:
        if preview_bot_specific < preview_total:
            next_actions.append("Refresh bot preview assets until /api/studio/bot-previews summary.botSpecific equals summary.total.")
        if preview_target_executed < preview_total:
            if target_execution["artTargetBotTotal"] and target_execution["artTargetBotExecuted"] < target_execution["artTargetBotTotal"]:
                next_actions.append(
                    "Run the MyShell Art target bot executor until Art target execution equals the Art bot total."
                )
            if target_execution["dreamyTargetBotTotal"] and target_execution["dreamyTargetBotExecuted"] < target_execution["dreamyTargetBotTotal"]:
                next_actions.append(
                    "Run real Dreamy server jobs for the Dreamy preview bots, then import accepted jobs with scripts/materialize_dreamy_target_previews.py."
                )
            if not target_execution["artTargetBotTotal"] and not target_execution["dreamyTargetBotTotal"]:
                next_actions.append(
                    "Run each target MyShell bot adapter until /api/studio/bot-previews summary.targetBotExecuted equals summary.total."
                )
        if _component_status(health, "cookieInjection") == "captcha_required":
            next_actions.append("Resolve the MyShell/Cloudflare captcha in a verified browser session before rerunning target-bot execution.")
        if check_local_cookies and local_cookies.get("missingCookieNames"):
            next_actions.append(
                "Refresh the local MyShell login until the cookie export includes: "
                + ", ".join(str(name) for name in local_cookies.get("missingCookieNames", []))
                + "."
            )
        if probe_local_art_api and local_art_api_auth.get("status") not in {"ready", "skipped"}:
            next_actions.append(
                "Refresh local MyShell login/cookies and rerun the local Art API probe; do not upload cookies until the probe is ready."
            )
        if secrets.get("status") not in {"ready", "skipped"}:
            project_arg = f" --project {project}" if project else ""
            next_actions.append(
                "Create or update generation secrets with "
                f"scripts/configure_generation_secrets.sh{project_arg} "
                "--init-data-file <dreamy-init-data.txt> --cookies-file <myshell-cookies.json> --apply."
            )
        if _component_status(health, "dreamyApiAuth") != "ready" or _component_status(health, "myshellCookies") != "ready":
            next_actions.append("Redeploy Cloud Run so DREAMY_TELEGRAM_INIT_DATA and MYSHELL_COOKIES are injected.")
        if not latest_accepted:
            next_actions.append("Run python -m generation_smoke --base-url <public-url> --execute --require-live --timeout 180.")
    return {
        "status": status,
        "readyForDelivery": not blocking,
        "checkedAt": _now_iso(),
        "baseUrl": base_url,
        "summary": {
            "requirements": len(requirements),
            "ready": sum(1 for item in requirements if item["status"] == "ready"),
            "blocked": len(blocking),
            "previewReady": preview_ready,
            "previewTotal": preview_total,
            "previewBotSpecific": preview_bot_specific,
            "previewTargetBotExecuted": preview_target_executed,
            "previewArtTargetBotExecuted": target_execution["artTargetBotExecuted"],
            "previewArtTargetBotTotal": target_execution["artTargetBotTotal"],
            "previewDreamyTargetBotExecuted": target_execution["dreamyTargetBotExecuted"],
            "previewDreamyTargetBotTotal": target_execution["dreamyTargetBotTotal"],
            "liveAccepted": latest_accepted,
        },
        "requirements": requirements,
        "blocking": [
            {
                "id": item["id"],
                "label": item["label"],
                "status": item["status"],
                "evidence": item.get("evidence"),
            }
            for item in blocking
        ],
        "nextActions": next_actions,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Verify the MyShell Studio end-to-end generation chain without printing secrets.")
    parser.add_argument("--base-url", default="https://art-chat-orchestrator-ju35f47zeq-ew.a.run.app")
    parser.add_argument("--project", default="k-project-481102")
    parser.add_argument("--service", default="art-chat-orchestrator")
    parser.add_argument("--region", default="europe-west1")
    parser.add_argument("--check-local-cookies", action="store_true")
    parser.add_argument("--probe-local-art-api", action="store_true", help="Probe a local cookie file against MyShell Art API without generating.")
    parser.add_argument("--local-cookies-file", default="", help="Local cookie JSON file for --probe-local-art-api.")
    parser.add_argument("--require-live", action="store_true", help="Exit non-zero unless live generation has accepted media.")
    args = parser.parse_args(argv)

    try:
        report = build_generation_chain_report(
            base_url=args.base_url,
            project=args.project,
            service=args.service,
            region=args.region,
            require_live=args.require_live,
            check_local_cookies=args.check_local_cookies,
            probe_local_art_api=args.probe_local_art_api,
            local_cookies_file=args.local_cookies_file,
        )
    except GenerationChainCheckError as exc:
        print(json.dumps({"status": "error", "message": str(exc)}, indent=2, ensure_ascii=False))
        return 1
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0 if report["status"] == "ready" or not args.require_live else 1


if __name__ == "__main__":
    raise SystemExit(main())
