from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from studio_app.application.services import dreamy_jobs
from studio_app.application.services import dreamy_protocol
from studio_app.application.policies import routing as routing_policy
from studio_app.application.policies.dispatch import accepted_source_media_url


class DreamyGenerationError(Exception):
    def __init__(self, status_code: int, detail: str) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


@dataclass(frozen=True)
class DreamyGenerationDeps:
    get_project: Callable[[str], dict[str, Any] | None]
    find_segment: Callable[[dict[str, Any], str | None], dict[str, Any] | None]
    adapter_auth_status: Callable[[str], dict[str, Any]]
    dreamy_init_data: Callable[[], str]
    dreamyporn_web_cookie_status: Callable[[], dict[str, Any]]
    dreamy_api_request: Callable[[str, dict[str, Any], str], Awaitable[dict[str, Any]]]
    dreamyporn_web_request: Callable[[str, dict[str, Any]], Awaitable[dict[str, Any]]]
    dreamyporn_web_input_images: Callable[..., Awaitable[list[str]]]
    evidence: Callable[..., dict[str, Any]]
    now_iso: Callable[[], str]
    update_job: Callable[..., dict[str, Any]]
    set_graph_status: Callable[[dict[str, Any], dict[str, Any], dict[str, Any] | None], list[dict[str, Any]]]
    save_project: Callable[[dict[str, Any]], None]
    sync_project_jobs: Callable[[dict[str, Any]], None]
    update_dispatch_session_target: Callable[..., dict[str, Any]]
    seed_dreamy_bots: Callable[[], list[dict[str, Any]]]


def dreamy_floor_defaults() -> list[dict[str, str]]:
    return [
        {"title": "Celebrity Style", "floorUrl": "celeb-sex"},
        {"title": "Sexy Outfits", "floorUrl": "sexy-outfits"},
        {"title": "Classic Acts", "floorUrl": "classic-acts"},
        {"title": "Wild Encounters", "floorUrl": "wild-encounters"},
        {"title": "LGBT", "floorUrl": "lgbt-sex"},
    ]


def dreamy_catalog_bot_from_image(item: dict[str, Any], floor: dict[str, Any]) -> dict[str, Any] | None:
    slug = routing_policy.slug_from_dreamy_goto_link(str(item.get("gotoLink") or item.get("goto_link") or ""))
    if not slug:
        return None
    name = str(item.get("title") or item.get("botName") or item.get("bot_name") or slug)
    image_url = str(item.get("imagePosterUrl") or item.get("image_poster_url") or item.get("imageUrl") or item.get("image_url") or "")
    template_url = str(item.get("templatePosterUrl") or item.get("template_poster_url") or item.get("templateUrl") or item.get("template_url") or "")
    return {
        "slug": slug,
        "name": name,
        "icon": "dreamy",
        "type": routing_policy.dreamy_catalog_type_from_media(item),
        "desc": f"Dreamy miniapp bot from {floor.get('title') or floor.get('floorUrl') or 'catalog'}.",
        "keywords": ["dreamy", str(floor.get("floorUrl") or ""), name.lower()],
        "rating": 4.6,
        "pageId": "dreamy-miniapp",
        "floorUrl": floor.get("floorUrl") or "",
        "imageUrl": image_url or template_url,
        "templateUrl": template_url,
    }


async def dreamy_catalog_bots(*, deps: DreamyGenerationDeps) -> tuple[list[dict[str, Any]], str]:
    init_data = deps.dreamy_init_data()
    auth_status = deps.adapter_auth_status("dreamy-miniapp")
    seed_bots = deps.seed_dreamy_bots()
    if not init_data and deps.dreamyporn_web_cookie_status().get("status") == "ready":
        bots: list[dict[str, Any]] = []
        seen: set[str] = set()
        for floor in dreamy_floor_defaults():
            floor_url = str(floor.get("floorUrl") or "")
            if not floor_url:
                continue
            try:
                payload = await deps.dreamyporn_web_request(
                    f"{dreamy_protocol.DREAMYPORN_WEB_GENERATE_PREFIX}/explore",
                    {"floorUrl": floor_url, "page": 1, "pageSize": 100},
                )
            except Exception:
                continue
            response_floors = payload.get("floors") if isinstance(payload.get("floors"), list) else []
            for response_floor in response_floors:
                if not isinstance(response_floor, dict):
                    continue
                images = response_floor.get("images") if isinstance(response_floor.get("images"), list) else []
                merged_floor = {**floor, **response_floor}
                for image in images:
                    if not isinstance(image, dict):
                        continue
                    bot = dreamy_catalog_bot_from_image(image, merged_floor)
                    if not bot or bot["slug"] in seen:
                        continue
                    seen.add(bot["slug"])
                    bots.append(bot)
        return (bots or seed_bots), "live-dreamyporn-web-explore" if bots else "seed-empty-web"

    if not init_data or auth_status.get("status") != "ready":
        return seed_bots, "seed-auth-missing"

    floors: list[dict[str, Any]] = dreamy_floor_defaults()
    try:
        init_payload = await deps.dreamy_api_request(f"{dreamy_protocol.DREAMY_API_PREFIX}/init", {}, init_data)
        init_floors = init_payload.get("floors")
        if isinstance(init_floors, list) and init_floors:
            floors = [floor for floor in init_floors if isinstance(floor, dict) and floor.get("floorUrl")]
    except Exception:
        floors = dreamy_floor_defaults()

    bots: list[dict[str, Any]] = []
    seen: set[str] = set()
    for floor in floors:
        floor_url = str(floor.get("floorUrl") or "")
        if not floor_url:
            continue
        try:
            payload = await deps.dreamy_api_request(
                f"{dreamy_protocol.DREAMY_API_PREFIX}/explore",
                {"floor_url": floor_url, "page": 1, "page_size": 100},
                init_data,
            )
        except Exception:
            continue
        response_floors = payload.get("floors") if isinstance(payload.get("floors"), list) else []
        for response_floor in response_floors:
            if not isinstance(response_floor, dict):
                continue
            images = response_floor.get("images") if isinstance(response_floor.get("images"), list) else []
            merged_floor = {**floor, **response_floor}
            for image in images:
                if not isinstance(image, dict):
                    continue
                bot = dreamy_catalog_bot_from_image(image, merged_floor)
                if not bot or bot["slug"] in seen:
                    continue
                seen.add(bot["slug"])
                bots.append(bot)

    return (bots or seed_bots), "live-dreamy-explore" if bots else "seed-empty-live"


def dreamy_input_images(prompt: str, source_segment: dict[str, Any] | None) -> list[str]:
    source_url = accepted_source_media_url(source_segment)
    return [source_url, prompt] if source_url else [prompt]


def job_route_for_graph(job: dict[str, Any], analysis: str = "Dreamy result refreshed.") -> dict[str, Any]:
    return dreamy_jobs.job_route_for_graph(job, analysis)


def sync_dispatch_target_from_polled_job(job: dict[str, Any], segment: dict[str, Any], status: str, *, deps: DreamyGenerationDeps) -> None:
    update = dreamy_jobs.dispatch_target_update_from_polled_job(job, segment, status)
    if not update:
        return
    try:
        deps.update_dispatch_session_target(
            str(update["sessionId"]),
            str(update["targetId"]),
            status=str(update["status"]),
            evidence=update["evidence"],
        )
    except Exception:
        return


def apply_dreamy_media_to_job(
    project: dict[str, Any],
    segment: dict[str, Any],
    job: dict[str, Any],
    media: dict[str, str],
    *,
    auth_status: dict[str, Any],
    message_prefix: str,
    deps: DreamyGenerationDeps,
) -> dict[str, Any]:
    update = dreamy_jobs.dreamy_media_job_update(
        segment,
        job,
        media,
        auth_status=auth_status,
        message_prefix=message_prefix,
        checked_at=deps.now_iso(),
    )
    segment.update(update["segmentPatch"])
    segment["updatedAt"] = deps.now_iso()
    job = deps.update_job(
        job,
        **update["jobPatch"],
    )
    deps.set_graph_status(project, job_route_for_graph(job), segment)
    deps.save_project(project)
    deps.sync_project_jobs(project)
    sync_dispatch_target_from_polled_job(job, segment, str(update["status"]), deps=deps)
    return job


async def poll_dreamyporn_web_job_result(
    job: dict[str, Any],
    *,
    deps: DreamyGenerationDeps,
) -> tuple[dict[str, Any], dict[str, Any] | None]:
    project = deps.get_project(str(job.get("projectId") or ""))
    if not project:
        raise DreamyGenerationError(404, "Project not found")
    segment = deps.find_segment(project, str(job.get("segmentId") or ""))
    if not segment:
        raise DreamyGenerationError(404, "Segment not found")
    task_id = str(job.get("taskId") or segment.get("taskId") or "")
    if not task_id:
        raise DreamyGenerationError(409, "Dreamy job has no task id to poll")
    auth_status = deps.adapter_auth_status("dreamy-miniapp")
    result = await deps.dreamyporn_web_request(f"{dreamy_protocol.DREAMYPORN_WEB_GENERATE_PREFIX}/generate_result", {})
    media = dreamy_protocol.dreamyporn_web_task_media(result, task_id)
    job = apply_dreamy_media_to_job(
        project,
        segment,
        job,
        media,
        auth_status=auth_status,
        message_prefix="DreamyPorn web poll.",
        deps=deps,
    )
    return job, project


async def run_dreamyporn_web_adapter(
    *,
    project: dict[str, Any],
    segment: dict[str, Any],
    job: dict[str, Any],
    route: dict[str, Any],
    prompt: str,
    source_segment: dict[str, Any] | None,
    input_image_bytes: bytes | None = None,
    input_image_filename: str = "",
    input_image_content_type: str = "",
    deps: DreamyGenerationDeps,
) -> dict[str, Any]:
    auth_status = deps.adapter_auth_status("dreamy-miniapp")
    if deps.dreamyporn_web_cookie_status().get("status") != "ready":
        segment["status"] = "auth_missing"
        segment["authStatus"] = auth_status
        segment["evidence"] = deps.evidence(
            "auth_missing",
            "dreamy-miniapp",
            message="DreamyPorn web cookies are missing; no external generation request was sent.",
        )
        segment["updatedAt"] = deps.now_iso()
        job = deps.update_job(job, status="auth_missing", authStatus=auth_status, evidence=segment["evidence"])
        deps.set_graph_status(project, route, segment)
        deps.save_project(project)
        deps.sync_project_jobs(project)
        return job

    bot_id = str(route["bot"].get("id") or route["bot"].get("botId") or job.get("botId") or segment.get("botId") or "").strip()
    article_id = str(route["bot"].get("articleId") or job.get("articleId") or segment.get("articleId") or route["bot"].get("slug") or "").strip()
    if not bot_id or not article_id:
        raise RuntimeError("DreamyPorn web generation requires explicit botId and articleId from the selected Dreamy bot.")

    segment["status"] = "running"
    segment["authStatus"] = auth_status
    segment["updatedAt"] = deps.now_iso()
    running_evidence = deps.evidence(
        "running",
        "dreamy-miniapp",
        message="DreamyPorn web generation submitted from Studio.",
    )
    job = deps.update_job(job, status="running", authStatus=auth_status, evidence=running_evidence)
    deps.set_graph_status(project, route, segment)
    deps.save_project(project)
    deps.sync_project_jobs(project)

    input_images = await deps.dreamyporn_web_input_images(
        source_segment=source_segment,
        input_image_bytes=input_image_bytes,
        input_image_filename=input_image_filename,
        input_image_content_type=input_image_content_type,
    )
    response = await deps.dreamyporn_web_request(
        f"{dreamy_protocol.DREAMYPORN_WEB_GENERATE_PREFIX}/generate",
        {
            "botId": bot_id,
            "inputImg": input_images,
            "articleId": article_id,
        },
    )
    output_job_id = str(response.get("outputJobId") or response.get("output_job_id") or "")
    if not output_job_id:
        raise RuntimeError("DreamyPorn web generate response did not include outputJobId")

    poll_attempts = dreamy_protocol.env_int("DREAMY_SERVER_POLL_ATTEMPTS", 3, minimum=1, maximum=20)
    poll_interval = dreamy_protocol.env_float("DREAMY_SERVER_POLL_INTERVAL_SECONDS", 0.75, minimum=0.0, maximum=30.0)
    media: dict[str, str] = {"status": "running", "taskId": output_job_id, "mediaUrl": "", "posterUrl": ""}
    for attempt in range(poll_attempts):
        if attempt and poll_interval:
            await asyncio.sleep(poll_interval)
        result = await deps.dreamyporn_web_request(f"{dreamy_protocol.DREAMYPORN_WEB_GENERATE_PREFIX}/generate_result", {})
        media = dreamy_protocol.dreamyporn_web_task_media(result, output_job_id)
        if media.get("mediaUrl") and media.get("status") in {"completed", "success", "done"}:
            break

    media["taskId"] = media.get("taskId") or output_job_id
    job = apply_dreamy_media_to_job(
        project,
        segment,
        job,
        media,
        auth_status=auth_status,
        message_prefix="DreamyPorn web submit.",
        deps=deps,
    )
    evidence = job.get("evidence") if isinstance(job.get("evidence"), dict) else {}
    evidence.update(
        {
            "executor": "dreamyporn-web",
            "articleId": article_id,
            "botId": bot_id,
            "queuePosition": media.get("queuePosition", ""),
            "inputImageCount": len(input_images),
        }
    )
    segment["evidence"] = evidence
    job = deps.update_job(job, evidence=evidence)
    deps.save_project(project)
    deps.sync_project_jobs(project)
    return job


async def poll_dreamy_job_result(
    job: dict[str, Any],
    *,
    deps: DreamyGenerationDeps,
) -> tuple[dict[str, Any], dict[str, Any] | None]:
    if job.get("pageId") != "dreamy-miniapp":
        raise DreamyGenerationError(409, "Only Dreamy miniapp jobs can be polled through this endpoint")
    project = deps.get_project(str(job.get("projectId") or ""))
    if not project:
        raise DreamyGenerationError(404, "Project not found")
    segment = deps.find_segment(project, str(job.get("segmentId") or ""))
    if not segment:
        raise DreamyGenerationError(404, "Segment not found")

    task_id = str(job.get("taskId") or segment.get("taskId") or "")
    auth_status = deps.adapter_auth_status("dreamy-miniapp")
    if not deps.dreamy_init_data() and deps.dreamyporn_web_cookie_status().get("status") == "ready":
        return await poll_dreamyporn_web_job_result(job, deps=deps)

    if not deps.dreamy_init_data() or auth_status.get("status") != "ready":
        evidence = dreamy_jobs.evidence_with_job_context(
            job,
            deps.evidence(
                "auth_missing",
                "dreamy-miniapp",
                task_id=task_id,
                message="Dreamy server polling needs DREAMY_TELEGRAM_INIT_DATA; result was not requested.",
            ),
        )
        segment["status"] = "auth_missing"
        segment["authStatus"] = auth_status
        segment["evidence"] = evidence
        segment["updatedAt"] = deps.now_iso()
        job = deps.update_job(job, status="auth_missing", authStatus=auth_status, evidence=evidence)
        deps.set_graph_status(project, job_route_for_graph(job, "Dreamy poll auth is missing."), segment)
        deps.save_project(project)
        deps.sync_project_jobs(project)
        sync_dispatch_target_from_polled_job(job, segment, "auth_missing", deps=deps)
        return job, project

    if not task_id:
        raise DreamyGenerationError(409, "Dreamy job has no task id to poll")

    result = await deps.dreamy_api_request(
        f"{dreamy_protocol.DREAMY_API_PREFIX}/generate/result",
        {"output_job_id": task_id},
        deps.dreamy_init_data(),
    )
    media = dreamy_protocol.dreamy_task_media(result, task_id)
    job = apply_dreamy_media_to_job(
        project,
        segment,
        job,
        media,
        auth_status=auth_status,
        message_prefix="Server poll.",
        deps=deps,
    )
    return job, project


async def run_dreamy_server_adapter(
    *,
    project: dict[str, Any],
    segment: dict[str, Any],
    job: dict[str, Any],
    route: dict[str, Any],
    prompt: str,
    source_segment: dict[str, Any] | None,
    input_image_bytes: bytes | None = None,
    input_image_filename: str = "",
    input_image_content_type: str = "",
    deps: DreamyGenerationDeps,
) -> dict[str, Any]:
    init_data = deps.dreamy_init_data()
    auth_status = deps.adapter_auth_status("dreamy-miniapp")
    if not init_data and deps.dreamyporn_web_cookie_status().get("status") == "ready":
        return await run_dreamyporn_web_adapter(
            project=project,
            segment=segment,
            job=job,
            route=route,
            prompt=prompt,
            source_segment=source_segment,
            input_image_bytes=input_image_bytes,
            input_image_filename=input_image_filename,
            input_image_content_type=input_image_content_type,
            deps=deps,
        )

    if not init_data or auth_status.get("status") != "ready":
        segment["status"] = "auth_missing"
        segment["authStatus"] = auth_status
        segment["evidence"] = deps.evidence(
            "auth_missing",
            "dreamy-miniapp",
            message="Dreamy server execution needs DREAMY_TELEGRAM_INIT_DATA; no external generation request was sent.",
        )
        segment["updatedAt"] = deps.now_iso()
        job = deps.update_job(job, status="auth_missing", authStatus=auth_status, evidence=segment["evidence"])
        deps.set_graph_status(project, route, segment)
        deps.save_project(project)
        deps.sync_project_jobs(project)
        return job

    segment["status"] = "running"
    segment["authStatus"] = auth_status
    segment["updatedAt"] = deps.now_iso()
    running_evidence = deps.evidence(
        "running",
        "dreamy-miniapp",
        message="Server-side Dreamy generation submitted from Studio.",
    )
    job = deps.update_job(job, status="running", authStatus=auth_status, evidence=running_evidence)
    deps.set_graph_status(project, route, segment)
    deps.save_project(project)
    deps.sync_project_jobs(project)

    slug = str(route["bot"].get("slug") or "")
    explicit_bot_id = str(
        route["bot"].get("id")
        or route["bot"].get("botId")
        or job.get("botId")
        or segment.get("botId")
        or ""
    ).strip()
    if explicit_bot_id:
        bot_id = explicit_bot_id
        article_id = str(route["bot"].get("articleId") or job.get("articleId") or segment.get("articleId") or slug or bot_id)
    else:
        detail = await deps.dreamy_api_request(f"{dreamy_protocol.DREAMY_API_PREFIX}/get-by-slug", {"slug_id": slug}, init_data)
        info = detail.get("info") if isinstance(detail.get("info"), dict) else {}
        bot_id = str(info.get("botId") or info.get("bot_id") or slug)
        article_id = str(info.get("slugId") or info.get("slug_id") or slug)
    generate_body = {
        "bot_id": bot_id,
        "input_img": dreamy_input_images(prompt, source_segment),
        "article_id": article_id,
    }
    response = await deps.dreamy_api_request(f"{dreamy_protocol.DREAMY_API_PREFIX}/generate", generate_body, init_data)
    output_job_id = str(response.get("outputJobId") or response.get("output_job_id") or "")
    if not output_job_id:
        raise RuntimeError("Dreamy generate response did not include outputJobId")

    poll_attempts = dreamy_protocol.env_int("DREAMY_SERVER_POLL_ATTEMPTS", 3, minimum=1, maximum=20)
    poll_interval = dreamy_protocol.env_float("DREAMY_SERVER_POLL_INTERVAL_SECONDS", 0.75, minimum=0.0, maximum=10.0)
    media: dict[str, str] = {"status": "running", "taskId": output_job_id, "mediaUrl": "", "posterUrl": ""}
    for attempt in range(poll_attempts):
        if attempt and poll_interval:
            await asyncio.sleep(poll_interval)
        result = await deps.dreamy_api_request(
            f"{dreamy_protocol.DREAMY_API_PREFIX}/generate/result",
            {"output_job_id": output_job_id},
            init_data,
        )
        media = dreamy_protocol.dreamy_task_media(result, output_job_id)
        if media.get("mediaUrl") and media.get("status") in {"completed", "success", "done"}:
            break

    media["taskId"] = media.get("taskId") or output_job_id
    return apply_dreamy_media_to_job(
        project,
        segment,
        job,
        media,
        auth_status=auth_status,
        message_prefix="Server submit.",
        deps=deps,
    )
