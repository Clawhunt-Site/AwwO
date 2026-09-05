#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import mimetypes
import re
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.error import URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen


REPO_ROOT = Path(__file__).resolve().parents[1]
BACKEND_DIR = REPO_ROOT / "orchestrator" / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from studio_app.registry.bot_catalog import MYSHELL_BOTS  # noqa: E402
from studio_app.registry.bot_previews import DREAMY_BOTS  # noqa: E402


DEFAULT_WIDGET_ID = "1912154065390264321"
DEFAULT_WIDGET_NAME = "GPT4o Image"
DEFAULT_ASSET_DIR = REPO_ROOT / "frontend" / "public" / "generated" / "bot-previews"
DEFAULT_MANIFEST = DEFAULT_ASSET_DIR / "manifest.json"
SAFE_SLUG_RE = re.compile(r"[^a-z0-9-]+")
BOT_PROMPT_OVERRIDES = {
    "brat-generator": "studio mode",
}


class PreviewManifestError(RuntimeError):
    pass


def _now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def _safe_slug(value: str) -> str:
    slug = SAFE_SLUG_RE.sub("-", value.lower()).strip("-")
    if not slug:
        raise PreviewManifestError(f"Invalid empty slug from {value!r}")
    return slug


def _all_bots() -> list[dict[str, Any]]:
    dreamy = [{**bot, "pageId": "dreamy-miniapp"} for bot in DREAMY_BOTS]
    art = [{**bot, "pageId": "myshell-art"} for bot in MYSHELL_BOTS]
    return [*dreamy, *art]


def prompt_for_bot(bot: dict[str, Any]) -> str:
    override = BOT_PROMPT_OVERRIDES.get(str(bot.get("slug") or ""))
    if override:
        return override
    bot_name = str(bot.get("name") or bot.get("slug") or "MyShell bot")
    bot_type = str(bot.get("type") or "image")
    description = str(bot.get("desc") or "")
    keywords = ", ".join(str(keyword) for keyword in bot.get("keywords", [])[:6])
    return (
        f"Create a safe 16:9 bot-specific preview image for MyShell Studio. "
        f"Bot: {bot_name}. Workflow: {bot_type}. Capability: {description}. "
        f"Visual cues: {keywords}. Make it look like a polished generated result from this bot, "
        "high detail, thumbnail friendly, no logos, no UI chrome, no watermarks, and no readable brand text."
    )


def _load_url_map(path: Path) -> dict[str, dict[str, Any]]:
    with path.open(encoding="utf-8") as handle:
        payload = json.load(handle)
    entries: dict[str, dict[str, Any]] = {}
    if isinstance(payload, dict):
        source_items = payload.get("previews") if isinstance(payload.get("previews"), (dict, list)) else payload
        if isinstance(source_items, dict):
            for slug, value in source_items.items():
                if isinstance(value, str):
                    entries[str(slug)] = {"remoteUrl": value}
                elif isinstance(value, dict):
                    entries[str(slug)] = dict(value)
        elif isinstance(source_items, list):
            payload = source_items
    if isinstance(payload, list):
        for item in payload:
            if not isinstance(item, dict):
                continue
            slug = item.get("botSlug") or item.get("slug")
            if slug:
                entries[str(slug)] = dict(item)
    if not entries:
        raise PreviewManifestError(f"No bot preview URLs found in {path}")
    return entries


def _extension_from_response(url: str, content_type: str) -> str:
    guessed = mimetypes.guess_extension(content_type.split(";")[0].strip()) if content_type else ""
    if guessed in {".jpeg", ".jpe"}:
        return ".jpg"
    if guessed:
        return guessed
    suffix = Path(urlparse(url).path).suffix.lower()
    if suffix in {".jpg", ".jpeg", ".png", ".webp", ".gif"}:
        return ".jpg" if suffix == ".jpeg" else suffix
    return ".jpg"


def _download_image(url: str, output_stem: Path, timeout: float = 60.0) -> Path:
    request = Request(url, headers={"User-Agent": "myshell-studio-orchestrator/1.0"})
    try:
        with urlopen(request, timeout=timeout) as response:
            content_type = response.headers.get("Content-Type", "")
            data = response.read()
    except (URLError, TimeoutError) as exc:
        raise PreviewManifestError(f"Failed to download {url}: {exc}") from exc
    if not data:
        raise PreviewManifestError(f"Downloaded empty image from {url}")
    extension = _extension_from_response(url, content_type)
    output_path = output_stem.with_suffix(extension)
    output_path.write_bytes(data)
    return output_path


def _asset_for_entry(
    *,
    bot: dict[str, Any],
    entry: dict[str, Any],
    asset_path: Path,
    asset_dir: Path,
    checked_at: str,
) -> dict[str, Any]:
    remote_url = str(entry.get("remoteUrl") or entry.get("url") or entry.get("mediaUrl") or entry.get("imageUrl") or "")
    rel_url = f"/generated/bot-previews/{asset_path.name}"
    return {
        "id": _safe_slug(str(bot["slug"])),
        "botSlug": bot["slug"],
        "targetBotSlug": bot["slug"],
        "botName": bot.get("name"),
        "botType": bot.get("type"),
        "pageId": bot.get("pageId") or "myshell-art",
        "title": bot.get("name") or bot["slug"],
        "mediaUrl": rel_url,
        "thumbnailUrl": rel_url,
        "originalRemoteUrl": remote_url,
        "source": entry.get("source") or "myshell-openapi-widget",
        "sourceWidgetId": entry.get("sourceWidgetId") or DEFAULT_WIDGET_ID,
        "sourceWidgetName": entry.get("sourceWidgetName") or DEFAULT_WIDGET_NAME,
        "prompt": entry.get("prompt") or prompt_for_bot(bot),
        "checkedAt": entry.get("checkedAt") or checked_at,
        "botSpecific": True,
        "targetBotExecuted": bool(entry.get("targetBotExecuted")),
        "localPath": str(asset_path.relative_to(asset_dir.parent.parent.parent)),
    }


def _asset_by_id(manifest: dict[str, Any]) -> dict[str, dict[str, Any]]:
    assets: dict[str, dict[str, Any]] = {}
    for asset in manifest.get("assets", []):
        if isinstance(asset, dict) and asset.get("id"):
            assets[str(asset["id"])] = asset
    return assets


def _starter_presets(existing_manifest: dict[str, Any] | None) -> dict[str, Any]:
    if existing_manifest and isinstance(existing_manifest.get("starterPresets"), dict):
        return dict(existing_manifest["starterPresets"])
    return {
        "cinematic-portrait": {"botSlug": "ai-porn-generator", "assetId": "ai-porn-generator"},
        "character-scene": {"botSlug": "image-to-video-generator", "assetId": "image-to-video-generator"},
        "style-poster": {"botSlug": "neon-art-generator", "assetId": "neon-art-generator"},
    }


def _existing_asset_for_bot(bot: dict[str, Any], existing_manifest: dict[str, Any]) -> dict[str, Any] | None:
    assets_by_id = _asset_by_id(existing_manifest)
    overrides = existing_manifest.get("botPreviews") if isinstance(existing_manifest.get("botPreviews"), dict) else {}
    override = overrides.get(bot["slug"], {}) if isinstance(overrides, dict) else {}
    asset_id = str(override.get("assetId") or _safe_slug(str(bot["slug"]))) if isinstance(override, dict) else _safe_slug(str(bot["slug"]))
    asset = assets_by_id.get(asset_id)
    if asset:
        return dict(asset)
    for candidate in existing_manifest.get("assets", []):
        if isinstance(candidate, dict) and (candidate.get("botSlug") == bot["slug"] or candidate.get("targetBotSlug") == bot["slug"]):
            return dict(candidate)
    return None


def _existing_preview_override(bot: dict[str, Any], asset: dict[str, Any], existing_manifest: dict[str, Any]) -> dict[str, Any]:
    overrides = existing_manifest.get("botPreviews") if isinstance(existing_manifest.get("botPreviews"), dict) else {}
    override = dict(overrides.get(bot["slug"], {})) if isinstance(overrides, dict) and isinstance(overrides.get(bot["slug"]), dict) else {}
    override.setdefault("assetId", asset.get("id") or _safe_slug(str(bot["slug"])))
    override.setdefault("botSpecific", bool(asset.get("botSpecific")))
    override.setdefault("targetBotExecuted", bool(asset.get("targetBotExecuted")))
    return override


def build_manifest(
    url_map: dict[str, dict[str, Any]],
    asset_dir: Path = DEFAULT_ASSET_DIR,
    dry_run: bool = False,
    merge_existing: bool = False,
    existing_manifest: dict[str, Any] | None = None,
) -> dict[str, Any]:
    checked_at = _now_iso()
    bots = _all_bots()
    bot_by_slug = {str(bot["slug"]): bot for bot in bots}
    unknown = sorted(slug for slug in url_map if slug not in bot_by_slug)
    if unknown:
        raise PreviewManifestError(f"Unknown bot slug(s): {', '.join(unknown)}")

    assets: list[dict[str, Any]] = []
    bot_previews: dict[str, dict[str, Any]] = {}
    asset_dir.mkdir(parents=True, exist_ok=True)

    for bot in bots:
        slug = str(bot["slug"])
        entry = url_map.get(slug)
        if not entry and merge_existing and existing_manifest:
            existing_asset = _existing_asset_for_bot(bot, existing_manifest)
            if existing_asset:
                assets.append(existing_asset)
                bot_previews[slug] = _existing_preview_override(bot, existing_asset, existing_manifest)
                continue
        if not entry:
            continue
        remote_url = str(entry.get("remoteUrl") or entry.get("url") or entry.get("mediaUrl") or entry.get("imageUrl") or "")
        if not remote_url:
            raise PreviewManifestError(f"Missing remote URL for {slug}")
        output_stem = asset_dir / _safe_slug(slug)
        asset_path = output_stem.with_suffix(".jpg") if dry_run else _download_image(remote_url, output_stem)
        assets.append(_asset_for_entry(bot=bot, entry=entry, asset_path=asset_path, asset_dir=asset_dir, checked_at=checked_at))
        bot_previews[slug] = {"assetId": _safe_slug(slug), "botSpecific": True, "targetBotExecuted": bool(entry.get("targetBotExecuted"))}

    return {
        "version": f"{checked_at[:10]}-myshell-bot-specific-preview",
        "generatedAt": checked_at,
        "source": "myshell-openapi-widget",
        "assets": assets,
        "botPreviews": bot_previews,
        "starterPresets": _starter_presets(existing_manifest if merge_existing else None),
        "summary": {
            "totalBots": len(bots),
            "botSpecificAssets": len(assets),
            "missingBotSpecificAssets": len(bots) - len(assets),
        },
    }


def print_worklist() -> None:
    items = [
        {
            "botSlug": bot["slug"],
            "botName": bot.get("name"),
            "botType": bot.get("type"),
            "pageId": bot.get("pageId") or "myshell-art",
            "widgetId": DEFAULT_WIDGET_ID,
            "prompt": prompt_for_bot(bot),
        }
        for bot in _all_bots()
    ]
    print(json.dumps({"count": len(items), "items": items}, indent=2, ensure_ascii=False))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Materialize bot-specific MyShell preview image URLs into the Studio manifest.")
    parser.add_argument("--input", type=Path, help="JSON mapping botSlug to remote MyShell image URL or entry object.")
    parser.add_argument("--asset-dir", type=Path, default=DEFAULT_ASSET_DIR)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--print-worklist", action="store_true", help="Print prompts for every registered Dreamy/MyShell bot.")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--allow-partial", action="store_true", help="Allow fewer URLs than registered bots.")
    parser.add_argument("--merge-existing-manifest", action="store_true", help="Preserve unchanged preview entries from the current manifest.")
    args = parser.parse_args(argv)

    if args.print_worklist:
        print_worklist()
        return 0
    if not args.input:
        raise SystemExit("--input is required unless --print-worklist is used")

    try:
        url_map = _load_url_map(args.input)
        if not args.allow_partial and not args.merge_existing_manifest and len(url_map) < len(_all_bots()):
            raise PreviewManifestError(f"Only {len(url_map)} URLs supplied for {len(_all_bots())} registered bots")
        existing_manifest: dict[str, Any] | None = None
        if args.merge_existing_manifest and args.manifest.exists():
            with args.manifest.open(encoding="utf-8") as manifest_file:
                existing_manifest = json.load(manifest_file)
            if not isinstance(existing_manifest, dict):
                raise PreviewManifestError(f"Existing manifest must be an object: {args.manifest}")
        manifest = build_manifest(
            url_map,
            asset_dir=args.asset_dir,
            dry_run=args.dry_run,
            merge_existing=args.merge_existing_manifest,
            existing_manifest=existing_manifest,
        )
        if not args.allow_partial and manifest["summary"]["missingBotSpecificAssets"]:
            raise PreviewManifestError(
                f"Only {manifest['summary']['botSpecificAssets']} bot-specific assets available for {len(_all_bots())} registered bots"
            )
        if not args.dry_run:
            args.manifest.parent.mkdir(parents=True, exist_ok=True)
            args.manifest.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(json.dumps({"status": "ok", "manifest": str(args.manifest), "summary": manifest["summary"]}, indent=2, ensure_ascii=False))
        return 0
    except PreviewManifestError as exc:
        print(json.dumps({"status": "error", "message": str(exc)}, indent=2, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
