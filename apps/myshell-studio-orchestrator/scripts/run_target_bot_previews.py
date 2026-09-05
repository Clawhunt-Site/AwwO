#!/usr/bin/env python3
from __future__ import annotations

import argparse
import asyncio
import base64
import json
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Awaitable, Callable
from urllib.error import URLError
from urllib.parse import quote
from urllib.request import Request, urlopen


REPO_ROOT = Path(__file__).resolve().parents[1]
BACKEND_DIR = REPO_ROOT / "orchestrator" / "backend"
SCRIPTS_DIR = REPO_ROOT / "scripts"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from studio_app.registry.bot_catalog import MYSHELL_BOTS  # noqa: E402
from studio_app.registry.bot_previews import DREAMY_BOTS  # noqa: E402
from materialize_bot_preview_manifest import prompt_for_bot  # noqa: E402


DEFAULT_OUTPUT = REPO_ROOT / ".studio-delivery-check" / "target-bot-preview-urls.json"
DEFAULT_SOURCE_IMAGE = REPO_ROOT / "frontend" / "public" / "generated" / "bot-previews" / "ai-porn-generator.jpg"
DEFAULT_PREVIEW_MANIFEST = REPO_ROOT / "frontend" / "public" / "generated" / "bot-previews" / "manifest.json"
PUBLIC_ART_PAGE_BASE = "https://art.myshell.ai/creative"

Runner = Callable[..., Awaitable[dict[str, Any]]]
PublicMetadataResolver = Callable[[str], dict[str, Any] | None]
EXECUTOR_MODES = {"cdp", "art-api"}


class TargetBotPreviewError(RuntimeError):
    pass


def _now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def _all_bots(include_dreamy: bool = False) -> list[dict[str, Any]]:
    dreamy = [{**bot, "pageId": "dreamy-miniapp"} for bot in DREAMY_BOTS] if include_dreamy else []
    art = [{**bot, "pageId": "myshell-art"} for bot in MYSHELL_BOTS]
    return [*dreamy, *art]


def _selected_bots(slugs: list[str] | None, include_dreamy: bool) -> list[dict[str, Any]]:
    bots = _all_bots(include_dreamy=include_dreamy)
    if not slugs:
        return bots
    by_slug = {str(bot["slug"]): bot for bot in bots}
    missing = [slug for slug in slugs if slug not in by_slug]
    if missing:
        raise TargetBotPreviewError(f"Unknown bot slug(s): {', '.join(missing)}")
    return [by_slug[slug] for slug in slugs]


def _read_flight_string(segment: str, field: str) -> str:
    token = f'\\"{field}\\":\\"'
    start = segment.find(token)
    if start < 0:
        return ""
    value_start = start + len(token)
    i = value_start
    while i < len(segment):
        if segment[i] == '"':
            backslashes = 0
            cursor = i - 1
            while cursor >= 0 and segment[cursor] == "\\":
                backslashes += 1
                cursor -= 1
            if backslashes == 1:
                return segment[value_start : i - backslashes]
        i += 1
    return ""


def _decode_single_text(raw_value: str) -> dict[str, Any]:
    if not raw_value or raw_value.startswith("$"):
        return {}
    try:
        decoded = json.loads(f'"{raw_value}"')
        return json.loads(decoded.replace('\\"', '"'))
    except json.JSONDecodeError:
        return {}


def extract_public_art_metadata(html: str, slug: str) -> dict[str, Any]:
    slug_token = f'\\"slugId\\":\\"{slug}\\"'
    slug_index = html.find(slug_token)
    if slug_index < 0:
        return {}
    record_start = html.rfind('\\"botId\\":\\"', 0, slug_index)
    if record_start < 0:
        return {}
    segment = html[record_start : slug_index + len(slug_token) + 2000]
    single_text = _decode_single_text(_read_flight_string(segment, "singleText"))
    return {
        "targetBotId": _read_flight_string(segment, "botId"),
        "targetSlugId": _read_flight_string(segment, "slugId") or slug,
        "template": _read_flight_string(segment, "template"),
        "buttonText": str(single_text.get("button_text") or single_text.get("buttonText") or ""),
    }


def fetch_public_art_metadata(slug: str, timeout: float = 30.0) -> dict[str, Any]:
    url = f"{PUBLIC_ART_PAGE_BASE}/{quote(slug, safe='')}"
    request = Request(
        url,
        headers={
            "Accept": "text/html,application/xhtml+xml",
            "User-Agent": "Mozilla/5.0 (compatible; myshell-studio-orchestrator/1.0)",
        },
    )
    try:
        with urlopen(request, timeout=timeout) as response:
            html = response.read().decode("utf-8", errors="replace")
    except (TimeoutError, URLError) as exc:
        raise TargetBotPreviewError(f"Failed to fetch public metadata for {slug}: {exc}") from exc
    metadata = extract_public_art_metadata(html, slug)
    if not metadata:
        raise TargetBotPreviewError(f"No public metadata found for {slug}")
    return metadata


def _resolve_public_metadata(slug: str, resolver: PublicMetadataResolver | None) -> dict[str, Any]:
    if not resolver:
        return {}
    try:
        return dict(resolver(slug) or {})
    except Exception as exc:
        return {"publicMetadataError": str(exc)}


def _manifest_remote_source_for(slug: str, manifest_path: Path | None = None) -> str:
    active_manifest_path = manifest_path or DEFAULT_PREVIEW_MANIFEST
    if not active_manifest_path.exists():
        return ""
    try:
        with active_manifest_path.open(encoding="utf-8") as manifest_file:
            manifest = json.load(manifest_file)
    except (OSError, json.JSONDecodeError):
        return ""
    assets = manifest.get("assets") if isinstance(manifest.get("assets"), list) else []
    for asset in assets:
        if not isinstance(asset, dict):
            continue
        if asset.get("botSlug") == slug or asset.get("targetBotSlug") == slug:
            remote_url = str(asset.get("originalRemoteUrl") or "")
            if remote_url.startswith(("http://", "https://")):
                return remote_url
    return ""


def _source_image_for(bot: dict[str, Any], explicit_source: Path | None, prefer_remote: bool = False) -> Path | str | None:
    if str(bot.get("type") or "") == "text-to-image":
        return None
    if prefer_remote:
        remote_source = _manifest_remote_source_for(str(bot["slug"]))
        if remote_source:
            return remote_source
    if explicit_source:
        return explicit_source
    candidate = REPO_ROOT / "frontend" / "public" / "generated" / "bot-previews" / f"{bot['slug']}.jpg"
    if candidate.exists():
        return candidate
    return DEFAULT_SOURCE_IMAGE


def build_run_plan(
    *,
    slugs: list[str] | None = None,
    include_dreamy: bool = False,
    source_image: Path | None = None,
    public_metadata_resolver: PublicMetadataResolver | None = None,
    executor_mode: str = "cdp",
) -> list[dict[str, Any]]:
    if executor_mode not in EXECUTOR_MODES:
        raise TargetBotPreviewError(f"Unknown executor mode: {executor_mode}")
    plan: list[dict[str, Any]] = []
    for bot in _selected_bots(slugs, include_dreamy=include_dreamy):
        requires_image = str(bot.get("type") or "") in {"image-to-image", "image-to-video"}
        source = _source_image_for(bot, source_image, prefer_remote=executor_mode == "art-api") if requires_image else None
        public_metadata = (
            _resolve_public_metadata(str(bot["slug"]), public_metadata_resolver)
            if bot.get("pageId") != "dreamy-miniapp"
            else {}
        )
        gen_button = str(public_metadata.get("buttonText") or bot.get("gen_button", ""))
        plan.append(
            {
                "botSlug": bot["slug"],
                "botName": bot.get("name"),
                "botType": bot.get("type"),
                "pageId": bot.get("pageId") or "myshell-art",
                "executor": (
                    "dreamy-server"
                    if bot.get("pageId") == "dreamy-miniapp"
                    else "myshell-art-api"
                    if executor_mode == "art-api"
                    else "myshell-art-cdp"
                ),
                "prompt": prompt_for_bot(bot),
                "genButton": gen_button,
                "requiresImage": requires_image,
                "sourceImage": str(source) if source else "",
                "targetPageUrl": f"{PUBLIC_ART_PAGE_BASE}/{bot['slug']}",
                "targetBotId": str(public_metadata.get("targetBotId") or ""),
                "targetSlugId": str(public_metadata.get("targetSlugId") or bot["slug"]),
                "targetTemplate": str(public_metadata.get("template") or ""),
                "publicMetadataResolved": bool(public_metadata.get("targetBotId")),
                "publicMetadataError": str(public_metadata.get("publicMetadataError") or ""),
            }
        )
    return plan


def _image_data(path: str) -> str:
    if not path:
        return ""
    source = Path(path).expanduser()
    if not source.exists():
        raise TargetBotPreviewError(f"Source image does not exist: {source}")
    return base64.b64encode(source.read_bytes()).decode("ascii")


def _default_runner() -> Runner:
    from myshell_bridge import generate_via_bot

    return generate_via_bot


def _default_art_api_runner(poll_attempts: int = 24, poll_interval: float = 5.0) -> Runner:
    from myshell_art_api import generate_via_art_api

    async def runner(**kwargs):
        target_bot_id = str(kwargs.get("target_bot_id") or "")
        target_article_id = str(kwargs.get("target_article_id") or "")
        input_values = kwargs.get("input_values") if isinstance(kwargs.get("input_values"), list) else []
        if not target_bot_id:
            return {"status": "error", "message": "MyShell Art API executor requires target_bot_id from public metadata."}
        if not input_values:
            return {"status": "error", "message": "MyShell Art API executor has no form input values to submit."}
        return await generate_via_art_api(
            bot_id=target_bot_id,
            input_values=[str(value) for value in input_values],
            article_id=target_article_id,
            poll_attempts=poll_attempts,
            poll_interval=poll_interval,
        )

    return runner


def _api_input_values(plan_item: dict[str, Any]) -> list[str]:
    if not plan_item.get("requiresImage"):
        return [str(plan_item["prompt"])]
    source = str(plan_item.get("sourceImage") or "")
    if source.startswith("http://") or source.startswith("https://"):
        return [source]
    return []


def _entry_from_result(plan_item: dict[str, Any], result: dict[str, Any], checked_at: str) -> dict[str, Any] | None:
    output_url = str(result.get("output_url") or result.get("mediaUrl") or result.get("remoteUrl") or "")
    if str(result.get("status") or "") != "done" or not output_url:
        return None
    executor = str(result.get("executor") or plan_item["executor"])
    source = "myshell-target-bot-api" if executor == "myshell-art-api" else "myshell-target-bot-cdp"
    return {
        "remoteUrl": output_url,
        "source": source,
        "sourceWidgetId": "",
        "sourceWidgetName": "",
        "prompt": plan_item["prompt"],
        "checkedAt": checked_at,
        "targetBotExecuted": True,
        "execution": {
            "status": "done",
            "executor": executor,
            "targetPageUrl": plan_item.get("targetPageUrl") or f"{PUBLIC_ART_PAGE_BASE}/{plan_item['botSlug']}",
            "targetBotId": plan_item.get("targetBotId", ""),
            "targetSlugId": plan_item.get("targetSlugId", plan_item["botSlug"]),
            "targetTemplate": plan_item.get("targetTemplate", ""),
            "botSlug": plan_item["botSlug"],
            "botName": plan_item.get("botName"),
            "taskId": result.get("task_id") or result.get("taskId") or "",
            "checkedAt": checked_at,
        },
    }


async def run_preview_batch(
    *,
    slugs: list[str] | None = None,
    include_dreamy: bool = False,
    source_image: Path | None = None,
    runner: Runner | None = None,
    continue_on_error: bool = True,
    resolve_public_metadata: bool = False,
    public_metadata_resolver: PublicMetadataResolver | None = None,
    executor_mode: str = "cdp",
    art_api_poll_attempts: int = 24,
    art_api_poll_interval: float = 5.0,
) -> dict[str, Any]:
    checked_at = _now_iso()
    if executor_mode not in EXECUTOR_MODES:
        raise TargetBotPreviewError(f"Unknown executor mode: {executor_mode}")
    active_runner = runner or (
        _default_art_api_runner(
            poll_attempts=art_api_poll_attempts,
            poll_interval=art_api_poll_interval,
        )
        if executor_mode == "art-api"
        else _default_runner()
    )
    active_public_metadata_resolver = public_metadata_resolver or (
        fetch_public_art_metadata if resolve_public_metadata or executor_mode == "art-api" else None
    )
    plan = build_run_plan(
        slugs=slugs,
        include_dreamy=include_dreamy,
        source_image=source_image,
        public_metadata_resolver=active_public_metadata_resolver,
        executor_mode=executor_mode,
    )
    previews: dict[str, dict[str, Any]] = {}
    results: list[dict[str, Any]] = []

    for item in plan:
        slug = item["botSlug"]
        if item["pageId"] == "dreamy-miniapp":
            result = {
                "botSlug": slug,
                "status": "skipped",
                "message": "Dreamy target execution requires DREAMY_TELEGRAM_INIT_DATA and is handled by /api/studio/generation-smoke.",
            }
            results.append(result)
            if not continue_on_error:
                raise TargetBotPreviewError(result["message"])
            continue
        try:
            if item["executor"] == "myshell-art-api":
                source_image_value = str(item.get("sourceImage") or "")
                result = await active_runner(
                    bot_slug=slug,
                    prompt=item["prompt"],
                    gen_button=item["genButton"],
                    image_data="" if source_image_value.startswith(("http://", "https://")) else _image_data(source_image_value),
                    target_bot_id=item.get("targetBotId", ""),
                    target_article_id=item.get("targetSlugId", ""),
                    input_values=_api_input_values(item),
                )
            else:
                result = await active_runner(
                    bot_slug=slug,
                    prompt=item["prompt"],
                    gen_button=item["genButton"],
                    image_data=_image_data(item["sourceImage"]),
                )
        except Exception as exc:
            result = {"status": "error", "message": str(exc)}
            if not continue_on_error:
                raise
        result = {"botSlug": slug, **result}
        results.append(result)
        entry = _entry_from_result(item, result, checked_at)
        if entry:
            previews[slug] = entry

    failed = sum(1 for item in results if item.get("status") != "done")
    return {
        "version": f"{checked_at[:10]}-target-bot-preview-runs",
        "checkedAt": checked_at,
        "summary": {
            "planned": len(plan),
            "executed": len(previews),
            "failed": failed,
            "dreamySkipped": sum(1 for item in results if item.get("status") == "skipped"),
        },
        "previews": previews,
        "results": results,
    }


def _load_existing(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    with path.open(encoding="utf-8") as handle:
        payload = json.load(handle)
    if isinstance(payload, dict) and isinstance(payload.get("previews"), dict):
        return dict(payload["previews"])
    if isinstance(payload, dict):
        return dict(payload)
    return {}


async def async_main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run real target MyShell Art bots and write manifest input JSON.")
    parser.add_argument("--slug", action="append", default=[], help="Bot slug to run. Repeatable. Defaults to all Art bots.")
    parser.add_argument("--include-dreamy", action="store_true", help="Include Dreamy bots in the plan; they are skipped unless run through generation-smoke.")
    parser.add_argument("--source-image", type=Path, help="Source image for image-to-image and image-to-video bots.")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--plan-only", action="store_true", help="Print the execution plan without running bots.")
    parser.add_argument("--continue-on-error", action="store_true", default=True)
    parser.add_argument("--merge-existing", action="store_true", help="Merge successful runs into an existing output file.")
    parser.add_argument("--resolve-public-metadata", action="store_true", help="Fetch each public art page and include exact target bot metadata in the plan/report.")
    parser.add_argument("--executor", choices=sorted(EXECUTOR_MODES), default="cdp", help="Execution transport for MyShell Art bots.")
    parser.add_argument("--art-api-poll-attempts", type=int, default=24, help="Poll attempts for Art API generation result.")
    parser.add_argument("--art-api-poll-interval", type=float, default=5.0, help="Seconds between Art API generation result polls.")
    args = parser.parse_args(argv)

    try:
        slugs = args.slug or None
        if args.plan_only:
            public_metadata_resolver = fetch_public_art_metadata if args.resolve_public_metadata or args.executor == "art-api" else None
            print(
                json.dumps(
                    {
                        "items": build_run_plan(
                            slugs=slugs,
                            include_dreamy=args.include_dreamy,
                            source_image=args.source_image,
                            public_metadata_resolver=public_metadata_resolver,
                            executor_mode=args.executor,
                        )
                    },
                    indent=2,
                    ensure_ascii=False,
                )
            )
            return 0
        report = await run_preview_batch(
            slugs=slugs,
            include_dreamy=args.include_dreamy,
            source_image=args.source_image,
            continue_on_error=args.continue_on_error,
            resolve_public_metadata=args.resolve_public_metadata,
            executor_mode=args.executor,
            art_api_poll_attempts=args.art_api_poll_attempts,
            art_api_poll_interval=args.art_api_poll_interval,
        )
        if args.merge_existing:
            merged = _load_existing(args.output)
            merged.update(report["previews"])
            report["previews"] = merged
            report["summary"]["executed"] = len(merged)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(json.dumps({"status": "ok", "output": str(args.output), "summary": report["summary"]}, indent=2, ensure_ascii=False))
        return 0 if report["summary"]["failed"] == 0 else 1
    except TargetBotPreviewError as exc:
        print(json.dumps({"status": "error", "message": str(exc)}, indent=2, ensure_ascii=False), file=sys.stderr)
        return 1


def main(argv: list[str] | None = None) -> int:
    return asyncio.run(async_main(argv))


if __name__ == "__main__":
    raise SystemExit(main())
