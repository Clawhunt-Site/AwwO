from __future__ import annotations

import math
import re
from dataclasses import dataclass
from mimetypes import guess_extension
from pathlib import Path
from typing import Any, Awaitable, Callable


class CanvasProSourceAssetError(Exception):
    def __init__(self, status_code: int, detail: str) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


@dataclass(frozen=True)
class CanvasProUseCaseDeps:
    generated_media_root: Callable[[], Path]
    now_iso: Callable[[], str]
    make_id: Callable[[str], str]
    source_asset_max_bytes: int
    source_asset_media_prefixes: tuple[str, ...]
    execute_canvaspro_task: Callable[..., Awaitable[dict[str, Any]]]
    build_canvaspro_plan: Callable[..., dict[str, Any]]
    fetch_canvaspro_task_result: Callable[..., Awaitable[dict[str, Any]]]
    fetch_art_api_result: Callable[..., Awaitable[dict[str, Any]]]
    generate_via_art_api: Callable[..., Awaitable[dict[str, Any]]]
    cookie_source_status: Callable[[], dict[str, Any]]


def generation_kind(value: Any) -> str:
    kind = str(value or "").strip().lower()
    if kind in {"video", "ai-video"}:
        return "video"
    return "image"


def generation_settings(kind: str, value: Any) -> dict[str, Any]:
    settings = value if isinstance(value, dict) else {}
    media_kind = generation_kind(kind)
    allowed_aspect_ratios = {"auto", "1:1", "9:16", "16:9", "4:3", "3:4", "3:2", "2:3", "21:9"}
    default_aspect_ratio = "16:9" if media_kind == "video" else "9:16"
    aspect_ratio = str(settings.get("aspectRatio") or settings.get("aspect_ratio") or default_aspect_ratio)
    if aspect_ratio not in allowed_aspect_ratios:
        aspect_ratio = default_aspect_ratio
    if media_kind == "video":
        allowed_modes = {"text-to-video", "image-to-video"}
        allowed_models = {"wan-2.2", "auto", "video-fast", "video-pro"}
        default_mode = "image-to-video"
        default_model = "wan-2.2"
    else:
        allowed_modes = {"text-to-image", "reference-to-image"}
        allowed_models = {"doubao-seedream-5.0-lite", "auto", "image-fast", "image-pro"}
        default_mode = "text-to-image"
        default_model = "doubao-seedream-5.0-lite"
    mode = str(settings.get("mode") or default_mode)
    if mode not in allowed_modes:
        mode = default_mode
    model = str(settings.get("model") or default_model)
    if model not in allowed_models:
        model = default_model
    quality = str(settings.get("quality") or "balanced")
    if quality not in {"fast", "balanced", "high"}:
        quality = "balanced"
    resolution = str(settings.get("resolution") or "").strip().upper()
    allowed_resolutions = {"720P", "1080P"} if media_kind == "video" else {"2K", "3K"}
    if resolution not in allowed_resolutions:
        resolution = "1080P" if media_kind == "video" else "2K"
    try:
        output_count = int(settings.get("outputCount") or settings.get("output_count") or 1)
    except (TypeError, ValueError):
        output_count = 1
    output_count = max(1, min(output_count, 4))
    try:
        duration_seconds = int(settings.get("durationSeconds") or settings.get("duration_seconds") or 5)
    except (TypeError, ValueError):
        duration_seconds = 5
    duration_seconds = max(2, min(duration_seconds, 12)) if media_kind == "video" else 0
    return {
        "aspectRatio": aspect_ratio,
        "durationSeconds": duration_seconds,
        "mode": mode,
        "model": model,
        "outputCount": output_count,
        "quality": quality,
        "resolution": resolution,
    }


def generation_cost_estimate(kind: str, settings: dict[str, Any]) -> dict[str, Any]:
    media_kind = generation_kind(kind)
    output_count = max(1, min(int(settings.get("outputCount") or 1), 4))
    resolution = str(settings.get("resolution") or ("1080P" if media_kind == "video" else "2K"))
    if media_kind == "video":
        duration_seconds = max(2, min(int(settings.get("durationSeconds") or 5), 12))
        duration_blocks = max(1, math.ceil(duration_seconds / 5))
        credits = (50 if resolution == "1080P" else 35) * duration_blocks * output_count
    else:
        credits = (8 if resolution == "3K" else 5) * output_count
    return {"credits": credits, "label": f"约 {credits} 点", "unit": "credits"}


def generation_outputs(
    *,
    kind: str,
    output_count: int,
    status: str,
    now_iso: Callable[[], str],
    make_id: Callable[[str], str],
    media_url: str = "",
    media_urls: list[str] | None = None,
    poster_url: str = "",
    existing_outputs: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    now = now_iso()
    outputs: list[dict[str, Any]] = []
    urls = [str(item) for item in (media_urls or []) if str(item).strip()]
    if media_url and not urls:
        urls = [media_url]
    existing_by_index = {
        int(output.get("index") or index + 1): output
        for index, output in enumerate(existing_outputs or [])
        if isinstance(output, dict)
    }
    slot_status = "pending" if status in {"queued", "running", "done"} else "waiting_service"
    for index in range(1, max(1, min(output_count, 4)) + 1):
        existing = existing_by_index.get(index, {})
        output_media_url = urls[index - 1] if len(urls) >= index else str(existing.get("mediaUrl") or "")
        output_status = "done" if output_media_url else slot_status
        output = {
            **existing,
            "id": str(existing.get("id") or make_id("canvaspro_output")),
            "index": index,
            "kind": kind,
            "label": "已生成" if output_status == "done" else "等待结果" if output_status == "pending" else "待连接服务",
            "mediaUrl": output_media_url,
            "posterUrl": (poster_url if index == 1 else "") or str(existing.get("posterUrl") or ""),
            "status": output_status,
            "createdAt": str(existing.get("createdAt") or now),
            "updatedAt": now,
        }
        outputs.append(output)
    return outputs


def source_asset_extension(filename: str, content_type: str) -> str:
    suffix = Path(filename or "").suffix.lower()
    if suffix and re.fullmatch(r"\.[a-z0-9]{1,8}", suffix):
        return suffix
    guessed = guess_extension((content_type or "").split(";")[0].strip())
    if guessed and re.fullmatch(r"\.[a-z0-9]{1,8}", guessed):
        return guessed
    if content_type.startswith("image/"):
        return ".png"
    if content_type.startswith("video/"):
        return ".mp4"
    if content_type.startswith("audio/"):
        return ".mp3"
    return ".bin"


def generation_response(
    *,
    payload: dict[str, Any],
    status: str,
    label: str,
    message: str,
    now_iso: Callable[[], str],
    make_id: Callable[[str], str],
    executor: dict[str, Any] | None = None,
    media_url: str = "",
    poster_url: str = "",
    task_id: str = "",
    ready_for_execution: bool = False,
) -> dict[str, Any]:
    kind = generation_kind(payload.get("kind"))
    settings = generation_settings(kind, payload.get("settings"))
    now = now_iso()
    source_node_ids = payload.get("sourceNodeIds") or payload.get("source_node_ids") or []
    if isinstance(source_node_ids, str):
        source_node_ids = [source_node_ids]
    if not isinstance(source_node_ids, list):
        source_node_ids = []
    task = {
        "id": str(payload.get("taskId") or payload.get("id") or make_id("canvaspro_task")),
        "kind": kind,
        "label": label,
        "nodeId": str(payload.get("nodeId") or payload.get("node_id") or ""),
        "prompt": str(payload.get("prompt") or "").strip(),
        "progress": 100 if status == "done" else 25 if status == "running" else 0,
        "settings": settings,
        "costEstimate": generation_cost_estimate(kind, settings),
        "sourceNodeIds": [str(item) for item in source_node_ids if item],
        "status": status,
        "submittedAt": now,
        "updatedAt": now,
        "outputs": generation_outputs(
            kind=kind,
            output_count=int(settings["outputCount"]),
            status=status,
            now_iso=now_iso,
            make_id=make_id,
            media_url=media_url,
            poster_url=poster_url,
        ),
        "executor": executor or {},
    }
    if task_id:
        task["externalTaskId"] = task_id
    return {
        "status": status,
        "ready": status in {"queued", "running", "done", "ready"},
        "readyForExecution": ready_for_execution,
        "message": message,
        "task": task,
    }


def generation_label(status: str) -> str:
    if status == "done":
        return "已生成"
    if status == "running":
        return "生成中"
    if status == "queued":
        return "已加入队列"
    if status == "ready":
        return "待原子能力"
    if status == "auth_missing":
        return "待连接服务"
    if status == "timeout":
        return "超时"
    if status == "error":
        return "失败"
    return "等待生成"


def normalized_sync_status(status: str, media_url: str = "") -> str:
    value = str(status or "").strip().lower()
    if media_url:
        return "done"
    if value in {"done", "completed", "success"}:
        return "done"
    if value in {"queued", "pending", "submitted"}:
        return "queued"
    if value in {"running", "processing", "in_progress", "progress"}:
        return "running"
    if value in {"auth_missing", "unauthorized"}:
        return "auth_missing"
    if value in {"timeout"}:
        return "timeout"
    if value in {"error", "failed", "failure", "cancelled", "canceled"}:
        return "error"
    if value == "ready":
        return "ready"
    return "running"


def existing_task_from_payload(payload: dict[str, Any]) -> dict[str, Any]:
    task = payload.get("task") if isinstance(payload.get("task"), dict) else {}
    return task if isinstance(task, dict) else {}


def external_task_id(payload: dict[str, Any], task: dict[str, Any]) -> str:
    for value in (
        payload.get("externalTaskId"),
        payload.get("external_task_id"),
        payload.get("outputJobId"),
        payload.get("output_job_id"),
        task.get("externalTaskId"),
        task.get("external_task_id"),
        task.get("outputJobId"),
        task.get("output_job_id"),
    ):
        text = str(value or "").strip()
        if text:
            return text
    return ""


def existing_media_url(outputs: list[dict[str, Any]]) -> str:
    for output in outputs:
        media_url = str(output.get("mediaUrl") or output.get("url") or "").strip()
        if media_url:
            return media_url
    return ""


def existing_media_count(outputs: list[dict[str, Any]]) -> int:
    return sum(1 for output in outputs if str(output.get("mediaUrl") or output.get("url") or "").strip())


def sync_media_urls(sync_result: dict[str, Any]) -> list[str]:
    urls: list[str] = []
    for key in ("output_urls", "outputUrls", "media_urls", "mediaUrls", "result_urls", "resultUrls", "urls"):
        value = sync_result.get(key)
        if isinstance(value, list):
            urls.extend(str(item).strip() for item in value if str(item).strip())
        elif isinstance(value, str) and value.strip():
            urls.append(value.strip())
    output_url = str(sync_result.get("output_url") or sync_result.get("outputUrl") or "").strip()
    if output_url and output_url not in urls:
        urls.append(output_url)
    return urls


def generation_task_sync_response(
    *,
    body: dict[str, Any],
    existing_task: dict[str, Any],
    kind: str,
    settings: dict[str, Any],
    executor: dict[str, Any],
    sync_result: dict[str, Any],
    external_task_id: str,
    now_iso: Callable[[], str],
    make_id: Callable[[str], str],
) -> dict[str, Any]:
    media_urls = sync_media_urls(sync_result)
    media_url = media_urls[0] if media_urls else ""
    status = normalized_sync_status(str(sync_result.get("status") or ""), media_url)
    now = now_iso()
    task_id = str(existing_task.get("id") or body.get("taskId") or body.get("id") or make_id("canvaspro_task"))
    source_node_ids = body.get("sourceNodeIds") or existing_task.get("sourceNodeIds") or []
    if isinstance(source_node_ids, str):
        source_node_ids = [source_node_ids]
    if not isinstance(source_node_ids, list):
        source_node_ids = []
    existing_outputs = existing_task.get("outputs") if isinstance(existing_task.get("outputs"), list) else []
    existing_outputs = [output for output in existing_outputs if isinstance(output, dict)]
    outputs = generation_outputs(
        kind=kind,
        output_count=int(settings["outputCount"]),
        status=status,
        now_iso=now_iso,
        make_id=make_id,
        media_urls=media_urls,
        existing_outputs=existing_outputs,
    )
    task = {
        **existing_task,
        "id": task_id,
        "kind": kind,
        "label": generation_label(status),
        "nodeId": str(body.get("nodeId") or existing_task.get("nodeId") or body.get("node_id") or ""),
        "prompt": str(body.get("prompt") or existing_task.get("prompt") or "").strip(),
        "progress": 100 if status == "done" else 50 if status == "running" else 25 if status == "queued" else 0,
        "settings": settings,
        "costEstimate": generation_cost_estimate(kind, settings),
        "sourceNodeIds": [str(item) for item in source_node_ids if item],
        "status": status,
        "submittedAt": str(existing_task.get("submittedAt") or now),
        "updatedAt": now,
        "outputs": outputs,
        "executor": sync_result.get("executor") if isinstance(sync_result.get("executor"), dict) else executor,
        "backendMessage": str(sync_result.get("message") or ""),
    }
    if external_task_id:
        task["externalTaskId"] = external_task_id
    return {
        "status": status,
        "ready": status in {"queued", "running", "done", "ready"},
        "message": str(sync_result.get("message") or "CanvasPro generation task synced."),
        "syncedAt": now,
        "task": task,
    }


def _generation_response_with_deps(
    deps: CanvasProUseCaseDeps,
    *,
    payload: dict[str, Any],
    status: str,
    label: str,
    message: str,
    executor: dict[str, Any] | None = None,
    media_url: str = "",
    poster_url: str = "",
    task_id: str = "",
    ready_for_execution: bool = False,
) -> dict[str, Any]:
    return generation_response(
        payload=payload,
        status=status,
        label=label,
        message=message,
        now_iso=deps.now_iso,
        make_id=deps.make_id,
        executor=executor,
        media_url=media_url,
        poster_url=poster_url,
        task_id=task_id,
        ready_for_execution=ready_for_execution,
    )


def _public_canvaspro_executor(result: dict[str, Any]) -> dict[str, Any]:
    executor = result.get("executor") if isinstance(result.get("executor"), dict) else {}
    public_executor = {
        key: executor.get(key)
        for key in ("provider", "capabilityId", "atom", "mode", "readyForExecution", "missingInputs")
        if key in executor
    }
    auth_status = executor.get("authStatus") if isinstance(executor.get("authStatus"), dict) else {}
    if auth_status:
        public_executor["authStatus"] = {
            key: auth_status.get(key)
            for key in ("status", "ready", "hasToken", "cookieCount", "missingCookieNames")
            if key in auth_status
        }
    cli_status = executor.get("cliStatus") if isinstance(executor.get("cliStatus"), dict) else {}
    if cli_status:
        public_executor["cliStatus"] = {
            "status": cli_status.get("status"),
            "ready": cli_status.get("ready"),
            "provider": cli_status.get("provider"),
            "message": cli_status.get("message"),
        }
    return public_executor


async def upload_source_asset_remote(
    deps: CanvasProUseCaseDeps,
    *,
    local_path: Path,
    content_type: str,
) -> dict[str, Any]:
    if not content_type.startswith("image/"):
        return {
            "status": "skipped",
            "ready": False,
            "message": "Remote CanvasPro source upload currently supports images.",
        }
    result = await deps.execute_canvaspro_task(
        kind="image",
        prompt="",
        settings={},
        executor={
            "provider": "myshell-art-cli",
            "atom": "upload-image",
        },
        input_values=[str(local_path)],
    )
    status = str(result.get("status") or "error")
    media_url = str(result.get("output_url") or "")
    return {
        "status": "ready" if media_url else status,
        "ready": bool(media_url),
        "mediaUrl": media_url,
        "message": str(result.get("message") or ""),
        "executor": _public_canvaspro_executor(result),
    }


async def stage_source_asset(
    deps: CanvasProUseCaseDeps,
    *,
    filename: str,
    content_type: str,
    data: bytes,
    upload_remote: bool = False,
) -> dict[str, Any]:
    normalized_content_type = str(content_type or "application/octet-stream").lower()
    if not any(normalized_content_type.startswith(prefix) for prefix in deps.source_asset_media_prefixes):
        raise CanvasProSourceAssetError(400, "CanvasPro source assets must be image, video, or audio files.")
    if not data:
        raise CanvasProSourceAssetError(400, "CanvasPro source asset is empty.")
    if len(data) > deps.source_asset_max_bytes:
        raise CanvasProSourceAssetError(413, "CanvasPro source asset is too large.")

    output_dir = deps.generated_media_root() / "canvaspro-inputs"
    output_dir.mkdir(parents=True, exist_ok=True)
    extension = source_asset_extension(filename, normalized_content_type)
    output_name = f"{deps.make_id('canvaspro_input')}{extension}"
    output_path = output_dir / output_name
    output_path.write_bytes(data)
    media_url = f"/generated/canvaspro-inputs/{output_name}"
    remote_upload = (
        await upload_source_asset_remote(deps, local_path=output_path, content_type=normalized_content_type)
        if upload_remote
        else {"status": "skipped", "ready": False, "message": "Remote upload was not requested."}
    )
    remote_media_url = str(remote_upload.get("mediaUrl") or "")
    return {
        "status": "ready",
        "preferredUrl": remote_media_url or media_url,
        "localUrl": media_url,
        "mediaUrl": media_url,
        "remoteMediaUrl": remote_media_url,
        "remoteUpload": remote_upload,
        "url": media_url,
        "fileName": filename or output_name,
        "mimeType": normalized_content_type,
        "size": len(data),
        "storedAt": deps.now_iso(),
    }


async def fetch_generation_sync_result(
    deps: CanvasProUseCaseDeps,
    *,
    kind: str,
    task_id: str,
    executor: dict[str, Any],
) -> dict[str, Any]:
    provider = str(executor.get("provider") or executor.get("providerId") or "").strip().lower()
    if provider in {"myshell-art-cli", "myshell_art_cli", "cli"}:
        return await deps.fetch_canvaspro_task_result(
            kind=kind,
            task_id=task_id,
            executor=executor,
        )
    try:
        return await deps.fetch_art_api_result(task_id=task_id)
    except RuntimeError as exc:
        return {
            "status": "auth_missing",
            "message": str(exc),
            "task_id": task_id,
            "executor": "myshell-art-api",
        }


async def generation_task_sync(payload: dict[str, Any], *, deps: CanvasProUseCaseDeps) -> dict[str, Any]:
    body = payload if isinstance(payload, dict) else {}
    existing_task = existing_task_from_payload(body)
    kind = generation_kind(body.get("kind") or existing_task.get("kind"))
    settings = generation_settings(kind, body.get("settings") or existing_task.get("settings"))
    executor = body.get("executor") if isinstance(body.get("executor"), dict) else existing_task.get("executor")
    executor = executor if isinstance(executor, dict) else {}
    existing_outputs = existing_task.get("outputs") if isinstance(existing_task.get("outputs"), list) else []
    existing_outputs = [output for output in existing_outputs if isinstance(output, dict)]
    task_external_id = external_task_id(body, existing_task)

    if task_external_id and existing_media_count(existing_outputs) <= 0:
        sync_result = await fetch_generation_sync_result(
            deps,
            kind=kind,
            task_id=task_external_id,
            executor=executor,
        )
    else:
        sync_result = {
            "status": str(existing_task.get("status") or body.get("status") or "ready"),
            "message": "CanvasPro task already has media." if existing_media_count(existing_outputs) else "CanvasPro task has not been submitted to an external generator yet.",
            "output_urls": [],
            "task_id": task_external_id,
            "executor": executor,
        }

    return generation_task_sync_response(
        body=body,
        existing_task=existing_task,
        kind=kind,
        settings=settings,
        executor=executor,
        sync_result=sync_result,
        external_task_id=task_external_id,
        now_iso=deps.now_iso,
        make_id=deps.make_id,
    )


def _cli_generation_status_label(result_status: str) -> tuple[str, str]:
    if result_status == "done":
        return "done", "已生成"
    if result_status == "running":
        return "running", "生成中"
    if result_status == "ready":
        return "ready", "待原子能力"
    if result_status == "auth_missing":
        return "auth_missing", "待连接服务"
    if result_status == "timeout":
        return "timeout", "超时"
    return "error", "失败"


def _art_api_generation_status_label(result_status: str) -> tuple[str, str]:
    if result_status == "done":
        return "done", "已生成"
    if result_status == "running":
        return "running", "生成中"
    if result_status == "auth_missing":
        return "auth_missing", "待连接服务"
    return "error", "失败"


async def generation_task(payload: dict[str, Any], *, deps: CanvasProUseCaseDeps) -> dict[str, Any]:
    body = payload if isinstance(payload, dict) else {}
    kind = generation_kind(body.get("kind"))
    settings = generation_settings(kind, body.get("settings"))
    execute = bool(body.get("execute")) if not isinstance(body.get("execute"), str) else body.get("execute", "").strip().lower() in {"1", "true", "yes", "on"}
    executor = body.get("executor") if isinstance(body.get("executor"), dict) else {}
    provider = str(executor.get("provider") or executor.get("providerId") or "").strip().lower()
    if provider in {"myshell-art-cli", "myshell_art_cli", "cli"}:
        input_values = body.get("inputValues") if isinstance(body.get("inputValues"), list) else []
        clean_inputs = [str(item) for item in input_values if str(item).strip()]
        prompt = str(body.get("prompt") or "").strip()
        if not execute:
            plan = deps.build_canvaspro_plan(
                kind=kind,
                prompt=prompt,
                settings=settings,
                executor=executor,
                input_values=clean_inputs,
            )
            return _generation_response_with_deps(
                deps,
                payload={**body, "kind": kind, "settings": settings},
                status="ready",
                label="待原子能力",
                message="CanvasPro generation task prepared with the MyShell Art CLI atom. Pass execute=true with slugId/botId and credentials to run it.",
                executor=plan,
                ready_for_execution=bool(plan.get("readyForExecution")),
            )
        result = await deps.execute_canvaspro_task(
            kind=kind,
            prompt=prompt,
            settings=settings,
            executor=executor,
            input_values=clean_inputs,
        )
        status, label = _cli_generation_status_label(str(result.get("status") or "error"))
        result_executor = result.get("executor") if isinstance(result.get("executor"), dict) else {}
        return _generation_response_with_deps(
            deps,
            payload={**body, "kind": kind, "settings": settings},
            status=status,
            label=label,
            message=str(result.get("message") or "CanvasPro generation task handled by MyShell Art CLI."),
            executor=result_executor,
            media_url=str(result.get("output_url") or ""),
            task_id=str(result.get("task_id") or ""),
            ready_for_execution=bool(result_executor.get("readyForExecution")),
        )

    cookie_source = deps.cookie_source_status()
    ready_for_execution = cookie_source.get("status") == "ready"
    if not execute:
        return _generation_response_with_deps(
            deps,
            payload={**body, "kind": kind, "settings": settings},
            status="ready",
            label="待执行器",
            message="CanvasPro generation task prepared. Pass execute=true with an executor botId to submit live generation.",
            executor={"provider": "myshell-art-api", "mode": "dry-run", "cookieSource": cookie_source},
            ready_for_execution=ready_for_execution,
        )
    if not ready_for_execution:
        return _generation_response_with_deps(
            deps,
            payload={**body, "kind": kind, "settings": settings},
            status="auth_missing",
            label="待连接服务",
            message=str(cookie_source.get("message") or "MyShell cookies are not configured; generation was not submitted."),
            executor={"provider": "myshell-art-api", "cookieSource": cookie_source},
            ready_for_execution=False,
        )
    bot_id = str(executor.get("botId") or executor.get("bot_id") or "").strip()
    article_id = str(executor.get("articleId") or executor.get("article_id") or "").strip()
    if not bot_id:
        return _generation_response_with_deps(
            deps,
            payload={**body, "kind": kind, "settings": settings},
            status="ready",
            label="待执行器",
            message="CanvasPro live generation requires executor.botId.",
            executor={"provider": "myshell-art-api", "cookieSource": cookie_source},
            ready_for_execution=True,
        )
    prompt = str(body.get("prompt") or "").strip()
    input_values = body.get("inputValues") if isinstance(body.get("inputValues"), list) else []
    clean_inputs = [str(item) for item in input_values if str(item).strip()]
    if prompt:
        clean_inputs.insert(0, prompt)
    result = await deps.generate_via_art_api(
        bot_id=bot_id,
        input_values=clean_inputs,
        article_id=article_id,
    )
    status, label = _art_api_generation_status_label(str(result.get("status") or "error"))
    return _generation_response_with_deps(
        deps,
        payload={**body, "kind": kind, "settings": settings},
        status=status,
        label=label,
        message=str(result.get("message") or result.get("reason") or "CanvasPro generation task submitted."),
        executor={"provider": "myshell-art-api", "botId": bot_id, "articleId": article_id, "cookieSource": cookie_source},
        media_url=str(result.get("output_url") or ""),
        task_id=str(result.get("task_id") or ""),
        ready_for_execution=True,
    )
