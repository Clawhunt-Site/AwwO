from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from studio_app.application.state import project as project_state
from studio_app.application.policies import dispatch as dispatch_rules


COMPLETED_TASK_STATUSES = {"completed", "success", "done"}
FAILED_TASK_STATUSES = {"failed", "failure", "error", "cancelled", "canceled"}
JOB_CONTEXT_EVIDENCE_KEYS = (
    "dispatchSessionId",
    "dispatchTargetId",
    "dispatchTargetPageId",
    "coverageVerification",
)


@dataclass(frozen=True)
class DreamyLiveGenerationDeps:
    project: Callable[[str | None, str], dict[str, Any]]
    append_message: Callable[..., dict[str, Any]]
    choose_route: Callable[..., Awaitable[dict[str, Any]]]
    get_page: Callable[[str], dict[str, Any]]
    navigation_contract: Callable[[dict[str, Any], dict[str, Any], dict[str, Any] | None], dict[str, Any]]
    missing_route_params: Callable[[dict[str, Any], str], list[str]]
    agent_id_for_dispatch: Callable[[dict[str, Any], str | None], str]
    append_queued_segment: Callable[..., dict[str, Any]]
    create_job: Callable[..., dict[str, Any]]
    make_id: Callable[[str], str]
    save_job: Callable[[dict[str, Any]], None]
    save_evidence: Callable[[dict[str, Any], dict[str, Any]], None]
    run_dreamy_server_adapter: Callable[..., Awaitable[dict[str, Any]]]
    evidence: Callable[..., dict[str, Any]]
    exception_message: Callable[[Exception], str]
    now_iso: Callable[[], str]
    update_job: Callable[..., dict[str, Any]]
    set_graph_status: Callable[[dict[str, Any], dict[str, Any], dict[str, Any] | None], list[dict[str, Any]]]
    save_project: Callable[[dict[str, Any]], None]
    sync_project_jobs: Callable[[dict[str, Any]], None]
    get_job: Callable[[str], dict[str, Any] | None]
    job_with_evidence: Callable[[dict[str, Any]], dict[str, Any] | None]
    dreamy_bot_route: Callable[..., dict[str, Any] | None]
    dreamy_bots: Callable[[], list[dict[str, Any]]]


def job_route_for_graph(job: dict[str, Any], analysis: str = "Dreamy result refreshed.") -> dict[str, Any]:
    return {
        "bot": {
            "slug": job.get("botSlug") or "",
            "name": job.get("botName") or "Dreamy Miniapp",
            "type": job.get("botType") or "image",
        },
        "executor": job.get("executor") or "server",
        "analysis": analysis,
        "sourceSummary": "Timeline updated from persisted job evidence.",
    }


def evidence_with_job_context(job: dict[str, Any], evidence: dict[str, Any]) -> dict[str, Any]:
    current = job.get("evidence") if isinstance(job.get("evidence"), dict) else {}
    return {
        **{key: current[key] for key in JOB_CONTEXT_EVIDENCE_KEYS if current.get(key)},
        **evidence,
    }


def dreamy_media_job_update(
    segment: dict[str, Any],
    job: dict[str, Any],
    media: dict[str, Any],
    *,
    auth_status: dict[str, Any],
    message_prefix: str,
    checked_at: str,
) -> dict[str, Any]:
    output_job_id = str(media.get("taskId") or job.get("taskId") or segment.get("taskId") or "")
    task_status = str(media.get("status") or "running").lower()
    media_url = str(media.get("mediaUrl") or "")
    poster_url = str(media.get("posterUrl") or segment.get("posterUrl") or media_url)
    queue_position = str(media.get("queuePosition") or "")

    if media_url and task_status in COMPLETED_TASK_STATUSES:
        normalized_status = "done"
        evidence = project_state.evidence(
            "done",
            "dreamy-miniapp",
            checked_at=checked_at,
            accepted=True,
            media_url=media_url,
            task_id=output_job_id,
            message=f"{message_prefix} Fresh Dreamy task media accepted.",
        )
        segment_patch = {"url": media_url, "posterUrl": poster_url}
        job_patch = {
            "status": "done",
            "taskId": output_job_id,
            "mediaUrl": media_url,
            "posterUrl": poster_url,
        }
    elif task_status in FAILED_TASK_STATUSES:
        normalized_status = "error"
        evidence = project_state.evidence(
            "error",
            "dreamy-miniapp",
            checked_at=checked_at,
            task_id=output_job_id,
            message=f"{message_prefix} Dreamy task {output_job_id} returned {task_status}.",
        )
        segment_patch = {}
        job_patch = {"status": "error", "taskId": output_job_id, "posterUrl": poster_url}
    else:
        normalized_status = "running"
        evidence = project_state.evidence(
            "running",
            "dreamy-miniapp",
            checked_at=checked_at,
            task_id=output_job_id,
            message=f"{message_prefix} Dreamy task {output_job_id} is {task_status or 'running'}; poll result for final media.",
        )
        segment_patch = {}
        job_patch = {"status": "running", "taskId": output_job_id, "posterUrl": poster_url}

    if queue_position:
        evidence["queuePosition"] = queue_position
    if task_status:
        evidence["rawTaskStatus"] = task_status

    evidence = evidence_with_job_context(job, evidence)
    segment_patch.update(
        {
            "status": normalized_status,
            "taskId": output_job_id,
            "authStatus": auth_status,
            "evidence": evidence,
        }
    )
    job_patch.update({"authStatus": auth_status, "evidence": evidence})
    return {
        "status": normalized_status,
        "segmentPatch": segment_patch,
        "jobPatch": job_patch,
        "evidence": evidence,
    }


def dispatch_target_update_from_polled_job(
    job: dict[str, Any],
    segment: dict[str, Any],
    status: str,
) -> dict[str, Any] | None:
    evidence = job.get("evidence") if isinstance(job.get("evidence"), dict) else {}
    dispatch_session_id = evidence.get("dispatchSessionId")
    dispatch_target_id = evidence.get("dispatchTargetId")
    if not dispatch_session_id or not dispatch_target_id:
        return None
    if status not in {"done", "error", "timeout", "auth_missing", "cancelled"}:
        return None

    target_status = "completed" if status == "done" and (segment.get("evidence") or {}).get("accepted") else "error"
    return {
        "sessionId": str(dispatch_session_id),
        "targetId": str(dispatch_target_id),
        "status": target_status,
        "evidence": {
            "dispatchSessionId": str(dispatch_session_id),
            "dispatchTargetId": str(dispatch_target_id),
            "jobId": segment.get("jobId") or job.get("jobId") or "",
            "segmentId": segment.get("id") or "",
            "accepted": bool((segment.get("evidence") or {}).get("accepted")),
            "mediaUrl": segment.get("url") or "",
            "posterUrl": segment.get("posterUrl") or "",
            "taskId": segment.get("taskId") or job.get("taskId") or "",
            "message": (segment.get("evidence") or {}).get("message") or "",
        },
    }


def dispatch_target_update_from_client_result(
    payload: dict[str, Any],
    job: dict[str, Any] | None,
    segment: dict[str, Any],
    status: str,
) -> dict[str, Any] | None:
    job_evidence = job.get("evidence") if isinstance((job or {}).get("evidence"), dict) else {}
    dispatch_session_id = payload.get("dispatchSessionId") or job_evidence.get("dispatchSessionId")
    dispatch_target_id = payload.get("dispatchTargetId") or job_evidence.get("dispatchTargetId")
    if not dispatch_session_id or not dispatch_target_id:
        return None
    if status not in {"done", "error", "timeout", "auth_missing"}:
        return None

    target_status = "completed" if status == "done" and (segment.get("evidence") or {}).get("accepted") else "error"
    return {
        "sessionId": str(dispatch_session_id),
        "targetId": str(dispatch_target_id),
        "status": target_status,
        "evidence": {
            "dispatchSessionId": str(dispatch_session_id),
            "dispatchTargetId": str(dispatch_target_id),
            "jobId": segment.get("jobId") or "",
            "segmentId": segment.get("id") or "",
            "accepted": bool((segment.get("evidence") or {}).get("accepted")),
            "mediaUrl": segment.get("url") or "",
            "posterUrl": segment.get("posterUrl") or "",
            "taskId": segment.get("taskId") or "",
            "message": (segment.get("evidence") or {}).get("message") or "",
        },
    }


def generation_smoke_status_from_latest(
    latest_job: dict[str, Any] | None,
    prerequisites: dict[str, Any],
) -> str:
    prerequisite_status = str(prerequisites.get("status") or "unknown")
    if prerequisite_status in {"needs_configuration", "auth_missing"}:
        return prerequisite_status
    if latest_job and latest_job.get("status") == "done" and latest_job.get("mediaUrl"):
        return "done"
    return "needs_verification"


def generation_smoke_context(*, probe_id: str, prompt: str) -> dict[str, Any]:
    return {
        "generationSmoke": True,
        "probeId": probe_id,
        "probeType": "dreamy-server-live",
        "prompt": prompt,
    }


def generation_smoke_summary(
    *,
    prerequisites: dict[str, Any],
    latest_job: dict[str, Any] | None,
    checked_at: str,
    executed_job: dict[str, Any] | None = None,
    project: dict[str, Any] | None = None,
    message: str = "",
) -> dict[str, Any]:
    job = executed_job or latest_job
    evidence = job.get("evidence") if isinstance((job or {}).get("evidence"), dict) else {}
    status = str(job.get("status") or "") if executed_job else generation_smoke_status_from_latest(latest_job, prerequisites)
    if executed_job and status == "done" and not job.get("mediaUrl"):
        status = "error"
    return {
        "status": status or "unknown",
        "readyForLiveRun": prerequisites.get("status") == "ready",
        "checkedAt": checked_at,
        "message": message
        or (
            "Latest live generation smoke accepted real media."
            if status == "done"
            else prerequisites.get("message", "Live generation smoke has not produced accepted media yet.")
        ),
        "prerequisites": prerequisites,
        "latest": {
            "jobId": job.get("jobId", "") if job else "",
            "projectId": job.get("projectId", "") if job else "",
            "segmentId": job.get("segmentId", "") if job else "",
            "taskId": job.get("taskId", "") if job else "",
            "status": job.get("status", "") if job else "",
            "mediaUrl": job.get("mediaUrl", "") if job else "",
            "posterUrl": job.get("posterUrl", "") if job else "",
            "checkedAt": evidence.get("checkedAt", "") if evidence else "",
            "accepted": bool(evidence.get("accepted")) if evidence else False,
            "message": evidence.get("message", "") if evidence else "",
        },
        "project": {"projectId": project.get("projectId", "")} if project else None,
        "actions": [
            {
                "label": "Create Cloud Run secrets",
                "message": "Create myshell-dreamy-init-data and myshell-cookies, deploy again, then run POST /api/studio/generation-smoke with execute=true.",
                "endpoint": "/api/studio/generation-smoke",
                "missingEnv": prerequisites.get("missingEnv") or [],
            }
        ]
        if prerequisites.get("status") in {"needs_configuration", "auth_missing"}
        else [
            {
                "label": "Run live smoke",
                "message": "POST /api/studio/generation-smoke with execute=true to prove fresh Dreamy media output.",
                "endpoint": "/api/studio/generation-smoke",
            }
        ],
    }


def dreamy_server_page(get_page: Callable[[str], dict[str, Any]]) -> dict[str, Any]:
    return {
        **get_page("dreamy-miniapp"),
        "executor": "server",
        "dispatchMode": "execute-server",
    }


def prepare_dreamy_server_route(
    deps: DreamyLiveGenerationDeps,
    *,
    bot: dict[str, Any],
    prompt: str,
    action: str,
    source_segment_id: str | None,
    source_segment: dict[str, Any] | None,
    agent_id: str | None = None,
) -> tuple[dict[str, Any], dict[str, Any], list[str]]:
    route = deps.dreamy_bot_route(
        bot_id=str(bot.get("id") or bot.get("botId") or "").strip(),
        bot_slug=str(bot.get("slug") or bot.get("botSlug") or bot.get("id") or "").strip(),
        bot_name=str(bot.get("name") or bot.get("botName") or "").strip(),
        bot_type=str(bot.get("type") or bot.get("botType") or "").strip(),
        article_id=str(bot.get("articleId") or bot.get("article_id") or bot.get("slug") or bot.get("id") or "").strip(),
        message=prompt,
    )
    if route is None:
        raise RuntimeError("Dreamy bot route could not be resolved")
    page = dreamy_server_page(deps.get_page)
    contract = deps.navigation_contract(page, route, source_segment)
    navigation_path = contract.get("navigationPath", "")
    missing_route_params = deps.missing_route_params(page, navigation_path)
    route = dispatch_rules.enrich_dispatch_route(
        route,
        page,
        action=action,
        source_segment_id=source_segment_id,
        agent_id=deps.agent_id_for_dispatch(page, agent_id),
        contract=contract,
        missing_route_params=missing_route_params,
    )
    return route, page, missing_route_params


async def execute_generation_smoke(prompt: str, *, deps: DreamyLiveGenerationDeps) -> dict[str, Any]:
    project = deps.project(None, "player")
    prompt = prompt.strip() or "Create a short cinematic neon city source image for live generation smoke."
    deps.append_message(project, "user", prompt, action="generate", hasImage=False)
    route = await deps.choose_route(prompt, False, "generate", None)
    page = dreamy_server_page(deps.get_page)
    contract = deps.navigation_contract(page, route, None)
    route = dispatch_rules.enrich_dispatch_route(
        route,
        page,
        action="generate",
        source_segment_id=None,
        agent_id=deps.agent_id_for_dispatch(page, None),
        contract=contract,
        missing_route_params=deps.missing_route_params(page, contract.get("navigationPath", "")),
    )
    route["sourceSummary"] = "Live generation smoke from backend credentials"
    segment = deps.append_queued_segment(project, route, route.get("optimizedPrompt") or prompt, "generate", None)
    job = deps.create_job(project, segment, route, page, None, agent_id=route["agentId"])
    smoke_context = generation_smoke_context(
        probe_id=deps.make_id("generation_smoke"),
        prompt=route.get("optimizedPrompt") or prompt,
    )
    job["evidence"] = {**(job.get("evidence") or {}), **smoke_context}
    deps.save_job(job)
    deps.save_evidence(job, job["evidence"])
    try:
        job = await deps.run_dreamy_server_adapter(
            project=project,
            segment=segment,
            job=job,
            route=route,
            prompt=route.get("optimizedPrompt") or prompt,
            source_segment=None,
        )
    except Exception as exc:
        segment["status"] = "error"
        segment["evidence"] = deps.evidence("error", "dreamy-miniapp", message=deps.exception_message(exc))
        segment["updatedAt"] = deps.now_iso()
        job = deps.update_job(job, status="error", evidence=segment["evidence"])
        deps.set_graph_status(project, route, segment)
        deps.save_project(project)
        deps.sync_project_jobs(project)
    refreshed = deps.get_job(job["jobId"]) or job
    evidence = {
        **(refreshed.get("evidence") if isinstance(refreshed.get("evidence"), dict) else {}),
        **smoke_context,
    }
    refreshed = deps.update_job(refreshed, evidence=evidence)
    segment["evidence"] = evidence
    segment["updatedAt"] = deps.now_iso()
    deps.save_project(project)
    deps.sync_project_jobs(project)
    return {"project": project, "job": refreshed, "segment": segment}


async def execute_dreamy_workshop_smoke(
    prompt: str,
    *,
    deps: DreamyLiveGenerationDeps,
    limit: int | None = None,
) -> dict[str, Any]:
    project = deps.project(None, "player")
    base_prompt = prompt.strip() or "Create a short cinematic neon city media segment for Dreamy workshop verification."
    deps.append_message(project, "user", base_prompt, action="generate", hasImage=False)
    dreamy_bots = deps.dreamy_bots()
    selected_bots = dreamy_bots[: max(1, min(limit or len(dreamy_bots), len(dreamy_bots)))]
    results: list[dict[str, Any]] = []
    source_segment: dict[str, Any] | None = None
    source_segment_id: str | None = None

    for index, bot in enumerate(selected_bots):
        bot_type = str(bot.get("type") or "")
        step_action = "extend" if bot_type == "image-to-video" and source_segment else "generate"
        step_prompt = f"{base_prompt} Step {index + 1}: {bot.get('name') or bot.get('slug')}."
        route, page, _missing = prepare_dreamy_server_route(
            deps,
            bot=bot,
            prompt=step_prompt,
            action=step_action,
            source_segment_id=source_segment_id if step_action == "extend" else None,
            source_segment=source_segment if step_action == "extend" else None,
        )
        segment = deps.append_queued_segment(
            project,
            route,
            route.get("optimizedPrompt") or step_prompt,
            step_action,
            route.get("sourceSegmentId"),
        )
        job = deps.create_job(project, segment, route, page, source_segment if step_action == "extend" else None, agent_id=route["agentId"])
        smoke_context = {
            "generationSmoke": True,
            "dreamyWorkshopSmoke": True,
            "probeId": deps.make_id("dreamy_workshop_smoke"),
            "probeType": "dreamy-workshop-server-live",
            "botIndex": index,
            "botSlug": route["bot"]["slug"],
            "prompt": route.get("optimizedPrompt") or step_prompt,
        }
        job["evidence"] = {**(job.get("evidence") or {}), **smoke_context}
        deps.save_job(job)
        deps.save_evidence(job, job["evidence"])
        try:
            job = await deps.run_dreamy_server_adapter(
                project=project,
                segment=segment,
                job=job,
                route=route,
                prompt=route.get("optimizedPrompt") or step_prompt,
                source_segment=source_segment if step_action == "extend" else None,
            )
        except Exception as exc:
            segment["status"] = "error"
            segment["evidence"] = deps.evidence("error", "dreamy-miniapp", message=deps.exception_message(exc))
            segment["updatedAt"] = deps.now_iso()
            job = deps.update_job(job, status="error", evidence=segment["evidence"])
            deps.set_graph_status(project, route, segment)
            deps.save_project(project)
            deps.sync_project_jobs(project)

        refreshed = deps.get_job(job["jobId"]) or job
        evidence = {
            **(refreshed.get("evidence") if isinstance(refreshed.get("evidence"), dict) else {}),
            **smoke_context,
        }
        refreshed = deps.update_job(refreshed, evidence=evidence)
        segment["evidence"] = evidence
        segment["updatedAt"] = deps.now_iso()
        deps.save_project(project)
        deps.sync_project_jobs(project)
        results.append(deps.job_with_evidence(refreshed) or refreshed)
        if segment.get("status") == "done" and (segment.get("evidence") or {}).get("accepted"):
            source_segment = segment
            source_segment_id = segment["id"]

    accepted_count = sum(1 for item in results if ((item.get("evidence") or {}).get("accepted") or item.get("status") == "done"))
    status = "done" if results and accepted_count == len(results) else "partial" if accepted_count else "error"
    return {
        "status": status,
        "project": project,
        "jobs": results,
        "count": len(results),
        "acceptedCount": accepted_count,
        "botSlugs": [str(bot.get("slug") or "") for bot in selected_bots],
    }
