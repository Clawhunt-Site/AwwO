#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urljoin, urlparse
from urllib.request import Request, urlopen


REPO_ROOT = Path(__file__).resolve().parents[1]
BACKEND_DIR = REPO_ROOT / "orchestrator" / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from studio_app.registry.bot_previews import DREAMY_BOTS  # noqa: E402


DEFAULT_BASE_URL = "https://art-chat-orchestrator-ju35f47zeq-ew.a.run.app"
DEFAULT_OUTPUT = REPO_ROOT / ".studio-delivery-check" / "dreamy-target-preview-urls.json"
VIDEO_SUFFIXES = {".mp4", ".mov", ".webm", ".m4v"}

Fetcher = Callable[[str, str, float], dict[str, Any]]


class DreamyTargetPreviewError(RuntimeError):
    pass


def _now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def fetch_json(base_url: str, path: str, timeout: float = 30.0) -> dict[str, Any]:
    url = urljoin(base_url.rstrip("/") + "/", path.lstrip("/"))
    request = Request(url, headers={"Accept": "application/json"})
    try:
        with urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (HTTPError, URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise DreamyTargetPreviewError(f"failed to fetch {path}: {exc}") from exc
    if not isinstance(payload, dict):
        raise DreamyTargetPreviewError(f"{path} returned a non-object payload")
    return payload


def _dreamy_bot_by_slug() -> dict[str, dict[str, Any]]:
    return {str(bot["slug"]): bot for bot in DREAMY_BOTS}


def _media_url(job: dict[str, Any]) -> str:
    evidence = job.get("evidence") if isinstance(job.get("evidence"), dict) else {}
    return str(job.get("mediaUrl") or evidence.get("mediaUrl") or "")


def _poster_url(job: dict[str, Any]) -> str:
    evidence = job.get("evidence") if isinstance(job.get("evidence"), dict) else {}
    return str(job.get("posterUrl") or evidence.get("posterUrl") or "")


def _accepted_dreamy_job(job: dict[str, Any]) -> bool:
    evidence = job.get("evidence") if isinstance(job.get("evidence"), dict) else {}
    media_url = _media_url(job)
    return bool(
        job.get("pageId") == "dreamy-miniapp"
        and job.get("status") == "done"
        and evidence.get("accepted")
        and media_url.startswith(("http://", "https://"))
    )


def _is_video_job(job: dict[str, Any]) -> bool:
    if str(job.get("botType") or "") == "image-to-video":
        return True
    suffix = Path(urlparse(_media_url(job)).path).suffix.lower()
    return suffix in VIDEO_SUFFIXES


def _job_matches_preview_slug(job: dict[str, Any], slug: str) -> bool:
    bot = _dreamy_bot_by_slug().get(slug)
    if not bot:
        raise DreamyTargetPreviewError(f"Unknown Dreamy bot slug: {slug}")
    wants_video = str(bot.get("type") or "") == "image-to-video"
    return _is_video_job(job) if wants_video else not _is_video_job(job)


def _select_job_for_slug(slug: str, jobs: list[dict[str, Any]]) -> dict[str, Any] | None:
    for job in jobs:
        if isinstance(job, dict) and _accepted_dreamy_job(job) and _job_matches_preview_slug(job, slug):
            return job
    return None


def _entry_from_job(slug: str, job: dict[str, Any], checked_at: str) -> dict[str, Any]:
    evidence = job.get("evidence") if isinstance(job.get("evidence"), dict) else {}
    entry_checked_at = str(evidence.get("checkedAt") or job.get("updatedAt") or checked_at)
    media_url = _media_url(job)
    return {
        "remoteUrl": media_url,
        "posterUrl": _poster_url(job),
        "source": "dreamy-server-target-job",
        "sourceWidgetId": "",
        "sourceWidgetName": "Dreamy Server",
        "prompt": str(job.get("prompt") or evidence.get("prompt") or ""),
        "checkedAt": entry_checked_at,
        "targetBotExecuted": True,
        "execution": {
            "status": "done",
            "executor": "dreamy-server",
            "pageId": "dreamy-miniapp",
            "botSlug": slug,
            "botName": (_dreamy_bot_by_slug().get(slug) or {}).get("name", slug),
            "sourceJobId": str(job.get("jobId") or ""),
            "sourceBotSlug": str(job.get("botSlug") or ""),
            "taskId": str(job.get("taskId") or evidence.get("taskId") or ""),
            "mediaUrl": media_url,
            "checkedAt": entry_checked_at,
        },
    }


def build_preview_report(
    *,
    slugs: list[str] | None,
    jobs: list[dict[str, Any]],
    checked_at: str | None = None,
) -> dict[str, Any]:
    active_checked_at = checked_at or _now_iso()
    selected_slugs = slugs or [str(bot["slug"]) for bot in DREAMY_BOTS]
    previews: dict[str, dict[str, Any]] = {}
    results: list[dict[str, Any]] = []
    for slug in selected_slugs:
        job = _select_job_for_slug(slug, jobs)
        if not job:
            results.append(
                {
                    "botSlug": slug,
                    "status": "missing",
                    "message": "No accepted Dreamy server job with matching media type was found.",
                }
            )
            continue
        previews[slug] = _entry_from_job(slug, job, active_checked_at)
        results.append(
            {
                "botSlug": slug,
                "status": "done",
                "sourceJobId": job.get("jobId") or "",
                "mediaUrl": _media_url(job),
            }
        )
    failed = sum(1 for result in results if result.get("status") != "done")
    return {
        "version": f"{active_checked_at[:10]}-dreamy-target-preview-runs",
        "checkedAt": active_checked_at,
        "summary": {
            "planned": len(selected_slugs),
            "executed": len(previews),
            "failed": failed,
        },
        "previews": previews,
        "results": results,
    }


def _load_jobs(
    *,
    base_url: str,
    job_ids: list[str],
    limit: int,
    fetcher: Fetcher = fetch_json,
) -> list[dict[str, Any]]:
    if job_ids:
        return [fetcher(base_url, f"/api/studio/jobs/{job_id}", 30.0) for job_id in job_ids]
    query = urlencode({"page_id": "dreamy-miniapp", "status": "done", "limit": limit})
    payload = fetcher(base_url, f"/api/studio/jobs?{query}", 30.0)
    jobs = payload.get("jobs") if isinstance(payload.get("jobs"), list) else []
    return [job for job in jobs if isinstance(job, dict)]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Materialize accepted Dreamy server jobs as target preview evidence.")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--slug", action="append", default=[], help="Dreamy preview slug to materialize. Repeatable.")
    parser.add_argument("--job-id", action="append", default=[], help="Specific Studio job id to use. Repeatable.")
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--allow-partial", action="store_true")
    args = parser.parse_args(argv)

    try:
        jobs = _load_jobs(base_url=args.base_url, job_ids=args.job_id, limit=args.limit)
        report = build_preview_report(slugs=args.slug or None, jobs=jobs)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    except DreamyTargetPreviewError as exc:
        print(json.dumps({"status": "error", "message": str(exc)}, indent=2, ensure_ascii=False), file=sys.stderr)
        return 1

    print(json.dumps({"status": "ok", "output": str(args.output), "summary": report["summary"]}, indent=2, ensure_ascii=False))
    return 0 if args.allow_partial or report["summary"]["failed"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
