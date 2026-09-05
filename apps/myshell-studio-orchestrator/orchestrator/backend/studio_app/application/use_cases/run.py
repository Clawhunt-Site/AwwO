from __future__ import annotations

import base64
import json
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from studio_app.application.policies import dispatch as dispatch_rules
from studio_app.application.services import execution_requests


@dataclass(frozen=True)
class StudioRunFlowDeps:
    normalize_mode: Callable[[str], str]
    normalize_action: Callable[[str], str]
    project: Callable[[str | None, str], dict[str, Any]]
    append_message: Callable[..., dict[str, Any]]
    resolve_source_segment: Callable[[dict[str, Any] | None, str | None], dict[str, Any] | None]
    manual_bot_sequence_items: Callable[[str | None, str], list[dict[str, str]]]
    dreamy_bot_route: Callable[..., dict[str, Any] | None]
    choose_route: Callable[..., Awaitable[dict[str, Any]]]
    page_for_dispatch: Callable[[dict[str, Any], str, str], dict[str, Any]]
    adapter_auth_status: Callable[[str], dict[str, Any]]
    navigation_contract: Callable[[dict[str, Any], dict[str, Any], dict[str, Any] | None], dict[str, Any]]
    missing_route_params: Callable[[dict[str, Any], str], list[str]]
    agent_id_for_dispatch: Callable[[dict[str, Any], str | None], str]
    append_queued_segment: Callable[..., dict[str, Any]]
    create_job: Callable[..., dict[str, Any]]
    set_graph_status: Callable[[dict[str, Any], dict[str, Any], dict[str, Any] | None], list[dict[str, Any]]]
    run_dreamy_server_adapter: Callable[..., Awaitable[dict[str, Any]]]
    get_job: Callable[[str], dict[str, Any] | None]
    update_job: Callable[..., dict[str, Any]]
    save_project: Callable[[dict[str, Any]], None]
    sync_project_jobs: Callable[[dict[str, Any]], None]
    evidence: Callable[..., dict[str, Any]]
    now_iso: Callable[[], str]
    exception_message: Callable[[Exception], str]
    guess_image_content_type: Callable[[str], str]
    get_bot_by_slug: Callable[[str], dict[str, Any] | None]
    generate_via_myshell_art: Callable[..., Awaitable[dict[str, Any]]]


def event(event: str, payload: dict[str, Any]) -> dict[str, str]:
    payload.setdefault("type", event)
    return {"event": event, "data": json.dumps(payload, ensure_ascii=False)}


def default_prompt(action: str) -> str:
    return {
        "generate": "Create a new Dreamy media segment.",
        "extend": "Extend the selected video with a natural next shot.",
        "restyle": "Restyle the selected segment while keeping the subject consistent.",
        "retry-agent": "Try another agent for the selected segment.",
    }[action]


def server_enabled_page(page: dict[str, Any], *, auth_status: dict[str, Any]) -> dict[str, Any]:
    if page["id"] == "dreamy-miniapp" and auth_status.get("status") == "ready":
        return {
            **page,
            "executor": "server",
            "dispatchMode": "execute-server",
        }
    return page


def error_job_update(
    project: dict[str, Any],
    segment: dict[str, Any],
    job: dict[str, Any],
    route: dict[str, Any],
    exc: Exception,
    *,
    deps: StudioRunFlowDeps,
) -> dict[str, Any]:
    segment["status"] = "error"
    segment["evidence"] = deps.evidence("error", "dreamy-miniapp", message=deps.exception_message(exc))
    segment["updatedAt"] = deps.now_iso()
    job = deps.update_job(job, status="error", evidence=segment["evidence"])
    deps.set_graph_status(project, route, segment)
    deps.save_project(project)
    deps.sync_project_jobs(project)
    return job


async def _run_manual_bot_sequence(
    *,
    project: dict[str, Any],
    prompt: str,
    normalized_action: str,
    page_id: str,
    agent_id: str | None,
    source_segment: dict[str, Any] | None,
    resolved_source_segment_id: str | None,
    manual_bot_sequence: list[dict[str, str]],
    image_bytes: bytes | None,
    image_filename: str,
    image_content_type: str,
    deps: StudioRunFlowDeps,
) -> AsyncIterator[dict[str, str]]:
    yield event(
        "progress",
        {
            "step": "manual-bot-sequence",
            "message": f"Queueing {len(manual_bot_sequence)} manual Dreamy bot steps",
            "progress": 18,
        },
    )
    sequence_source_segment = source_segment
    sequence_source_segment_id = resolved_source_segment_id
    last_segment: dict[str, Any] | None = None
    last_job: dict[str, Any] | None = None
    for index, manual_bot in enumerate(manual_bot_sequence):
        step_prompt = manual_bot.get("prompt") or prompt
        step_action = manual_bot.get("action") or ("extend" if index else normalized_action)
        route = deps.dreamy_bot_route(
            bot_id=manual_bot.get("botId"),
            bot_slug=manual_bot.get("botSlug"),
            bot_name=manual_bot.get("botName"),
            bot_type=manual_bot.get("botType"),
            article_id=manual_bot.get("articleId"),
            message=step_prompt,
        )
        if route is None:
            continue
        page = deps.page_for_dispatch(route["bot"], page_id, step_prompt)
        page = server_enabled_page(page, auth_status=deps.adapter_auth_status("dreamy-miniapp"))
        contract = deps.navigation_contract(page, route, sequence_source_segment)
        navigation_path = contract.get("navigationPath", "")
        missing_route_params = deps.missing_route_params(page, navigation_path)
        route = dispatch_rules.enrich_dispatch_route(
            route,
            page,
            action=step_action,
            source_segment_id=sequence_source_segment_id,
            agent_id=deps.agent_id_for_dispatch(page, agent_id),
            contract=contract,
            missing_route_params=missing_route_params,
        )
        yield event("route", route)
        yield event(
            "progress",
            {
                "step": "manual-bot-sequence",
                "message": f"Queued manual bot {index + 1}/{len(manual_bot_sequence)}",
                "progress": min(85, 25 + index * 10),
            },
        )

        segment = deps.append_queued_segment(
            project,
            route,
            route.get("optimizedPrompt") or step_prompt,
            step_action,
            sequence_source_segment_id,
        )
        job = deps.create_job(project, segment, route, page, sequence_source_segment, agent_id=route["agentId"])
        graph = deps.set_graph_status(project, route, segment)
        deps.append_message(
            project,
            "assistant",
            f"Queued {route['bot']['name']} as manual sequence step {index + 1}/{len(manual_bot_sequence)}.",
            route=route,
            segmentId=segment["id"],
            jobId=job["jobId"],
        )
        yield event(
            "execution_request",
            execution_requests.execution_request_from_route(
                route,
                page,
                job,
                segment,
                prompt=route.get("optimizedPrompt") or step_prompt,
                action=step_action,
                source_segment=sequence_source_segment,
                graph=graph,
                contract=deps.navigation_contract(page, route, sequence_source_segment),
                missing_route_params=missing_route_params,
            ),
        )
        yield event("job", {"job": job})
        if page["id"] == "dreamy-miniapp" and page["executor"] == "server":
            yield event(
                "progress",
                {
                    "step": "manual-bot-sequence",
                    "message": f"Running Dreamy bot {index + 1}/{len(manual_bot_sequence)} from the Studio backend",
                    "progress": min(95, 35 + index * 10),
                },
            )
            try:
                job = await deps.run_dreamy_server_adapter(
                    project=project,
                    segment=segment,
                    job=job,
                    route=route,
                    prompt=route.get("optimizedPrompt") or step_prompt,
                    source_segment=sequence_source_segment,
                    input_image_bytes=image_bytes if index == 0 else None,
                    input_image_filename=image_filename,
                    input_image_content_type=image_content_type,
                )
            except Exception as exc:
                job = error_job_update(project, segment, job, route, exc, deps=deps)
            job = deps.get_job(job["jobId"]) or job
            yield event("job", {"job": job})
        sequence_source_segment = segment
        sequence_source_segment_id = segment["id"]
        last_segment = segment
        last_job = job

    yield event("project", {"project": project})
    yield event(
        "done",
        {
            "status": (last_segment or {}).get("status", "queued"),
            "projectId": project["projectId"],
            "segmentId": (last_segment or {}).get("id"),
            "jobId": (last_job or {}).get("jobId"),
        },
    )


async def run_studio_events(
    *,
    message: str = "",
    project_id: str | None = None,
    mode: str = "player",
    action: str = "generate",
    source_segment_id: str | None = None,
    page_id: str = "dreamy-miniapp",
    agent_id: str | None = None,
    bot_id: str | None = None,
    bot_slug: str | None = None,
    bot_name: str | None = None,
    bot_type: str | None = None,
    article_id: str | None = None,
    bot_sequence: str | None = None,
    agent_graph: str | None = None,
    image: Any = None,
    deps: StudioRunFlowDeps,
) -> AsyncIterator[dict[str, str]]:
    normalized_mode = deps.normalize_mode(mode)
    normalized_action = deps.normalize_action(action)
    prompt = message.strip() or default_prompt(normalized_action)

    project = deps.project(project_id, normalized_mode)
    if agent_graph:
        try:
            parsed_graph = json.loads(agent_graph)
            if isinstance(parsed_graph, list):
                project["agentGraph"] = parsed_graph
        except json.JSONDecodeError:
            pass

    image_data = None
    image_bytes: bytes | None = None
    image_filename = ""
    image_content_type = ""
    if image is not None:
        image_bytes = await image.read()
        image_data = base64.b64encode(image_bytes).decode()
        image_filename = image.filename or "studio-source.jpg"
        image_content_type = image.content_type or deps.guess_image_content_type(image_filename)
    has_image = image_data is not None
    source_segment = deps.resolve_source_segment(project, source_segment_id)
    resolved_source_segment_id = source_segment.get("id") if source_segment else source_segment_id
    manual_bot_sequence = deps.manual_bot_sequence_items(bot_sequence, normalized_action)
    deps.append_message(
        project,
        "user",
        prompt,
        action=normalized_action,
        sourceSegmentId=resolved_source_segment_id,
        hasImage=has_image,
    )

    yield event(
        "meta",
        {
            "projectId": project["projectId"],
            "conversationId": project["conversationId"],
            "mode": normalized_mode,
        },
    )

    if manual_bot_sequence:
        async for item in _run_manual_bot_sequence(
            project=project,
            prompt=prompt,
            normalized_action=normalized_action,
            page_id=page_id,
            agent_id=agent_id,
            source_segment=source_segment,
            resolved_source_segment_id=resolved_source_segment_id,
            manual_bot_sequence=manual_bot_sequence,
            image_bytes=image_bytes,
            image_filename=image_filename,
            image_content_type=image_content_type,
            deps=deps,
        ):
            yield item
        return

    route = (
        deps.dreamy_bot_route(
            bot_id=bot_id,
            bot_slug=bot_slug,
            bot_name=bot_name,
            bot_type=bot_type,
            article_id=article_id,
            message=prompt,
        )
        if page_id == "dreamy-miniapp" and (bot_slug or bot_id)
        else None
    )
    if route is None:
        route = await deps.choose_route(prompt, has_image, normalized_action, source_segment)
    page = deps.page_for_dispatch(route["bot"], page_id, prompt)
    page = server_enabled_page(page, auth_status=deps.adapter_auth_status("dreamy-miniapp"))
    contract = deps.navigation_contract(page, route, source_segment)
    navigation_path = contract.get("navigationPath", "")
    missing_route_params = deps.missing_route_params(page, navigation_path)
    route = dispatch_rules.enrich_dispatch_route(
        route,
        page,
        action=normalized_action,
        source_segment_id=resolved_source_segment_id,
        agent_id=deps.agent_id_for_dispatch(page, agent_id),
        contract=contract,
        missing_route_params=missing_route_params,
    )
    yield event("route", route)

    yield event(
        "progress",
        {
            "step": "planning",
            "message": "Preparing Studio dispatch request",
            "progress": 20,
        },
    )

    segment = deps.append_queued_segment(
        project,
        route,
        route.get("optimizedPrompt") or prompt,
        normalized_action,
        resolved_source_segment_id,
    )
    job = deps.create_job(project, segment, route, page, source_segment, agent_id=route["agentId"])
    graph = deps.set_graph_status(project, route, segment)
    deps.append_message(
        project,
        "assistant",
        (
            f"Queued {page['name']} navigation dispatch."
            if page["executor"] == "navigation"
            else f"Queued {route['bot']['name']} for {normalized_action}."
        ),
        route=route,
        segmentId=segment["id"],
        jobId=job["jobId"],
    )

    yield event(
        "execution_request",
        execution_requests.execution_request_from_route(
            route,
            page,
            job,
            segment,
            prompt=route.get("optimizedPrompt") or prompt,
            action=normalized_action,
            source_segment=source_segment,
            graph=graph,
            contract=deps.navigation_contract(page, route, source_segment),
            missing_route_params=missing_route_params,
        ),
    )
    yield event("job", {"job": job})

    if page["id"] == "dreamy-miniapp" and page["executor"] == "server":
        yield event(
            "progress",
            {
                "step": "dreamy-server",
                "message": "Running Dreamy generation from the Studio backend",
                "progress": 45,
            },
        )
        try:
            job = await deps.run_dreamy_server_adapter(
                project=project,
                segment=segment,
                job=job,
                route=route,
                prompt=route.get("optimizedPrompt") or prompt,
                source_segment=source_segment,
                input_image_bytes=image_bytes,
                input_image_filename=image_filename,
                input_image_content_type=image_content_type,
            )
        except Exception as exc:
            job = error_job_update(project, segment, job, route, exc, deps=deps)
        yield event("job", {"job": deps.get_job(job["jobId"])})

    if page["executor"] == "navigation":
        if missing_route_params:
            segment["status"] = "error"
            segment["evidence"] = dispatch_rules.navigation_evidence_payload(
                deps.evidence(
                    "error",
                    page["id"],
                    accepted=False,
                    message=f"Missing route parameters: {', '.join(missing_route_params)}.",
                ),
                page=page,
                agent_id=job["agentId"],
                navigation_path=navigation_path,
                missing_route_params=missing_route_params,
            )
        else:
            segment["status"] = "done"
            segment["evidence"] = dispatch_rules.navigation_evidence_payload(
                deps.evidence(
                    "done",
                    page["id"],
                    accepted=True,
                    message=f"Navigation dispatch prepared for {page['name']} at {navigation_path}.",
                ),
                page=page,
                agent_id=job["agentId"],
                navigation_path=navigation_path,
                missing_route_params=[],
            )
        segment["updatedAt"] = deps.now_iso()
        deps.update_job(
            job,
            status=segment["status"],
            evidence=segment["evidence"],
            authStatus=deps.adapter_auth_status(page["id"]),
        )
        deps.set_graph_status(project, route, segment)
        deps.save_project(project)
        deps.sync_project_jobs(project)
        yield event("job", {"job": deps.get_job(job["jobId"])})

    if page["id"] == "myshell-art":
        auth_status = deps.adapter_auth_status(page["id"])
        if auth_status["status"] == "auth_missing":
            segment["status"] = "auth_missing"
            segment["authStatus"] = auth_status
            auth_message = str(
                auth_status.get("message")
                or "MyShell Art authentication is missing; no generation was attempted."
            )
            segment["evidence"] = deps.evidence(
                "auth_missing",
                "myshell-art",
                message=f"{auth_message}; no generation was attempted.",
            )
            segment["updatedAt"] = deps.now_iso()
            deps.update_job(
                job,
                status="auth_missing",
                authStatus=auth_status,
                evidence=segment["evidence"],
            )
            deps.set_graph_status(project, route, segment)
            deps.save_project(project)
            deps.sync_project_jobs(project)
            yield event("job", {"job": deps.get_job(job["jobId"])})
        elif route["bot"]["type"] in {"image-to-image", "image-to-video"} and not image_data:
            segment["status"] = "error"
            segment["evidence"] = deps.evidence(
                "error",
                "myshell-art",
                message="This MyShell Art bot requires an uploaded source image.",
            )
            segment["updatedAt"] = deps.now_iso()
            deps.update_job(job, status="error", evidence=segment["evidence"])
            deps.set_graph_status(project, route, segment)
            deps.save_project(project)
            deps.sync_project_jobs(project)
            yield event("job", {"job": deps.get_job(job["jobId"])})
        else:
            segment["status"] = "running"
            segment["updatedAt"] = deps.now_iso()
            deps.update_job(job, status="running")
            deps.save_project(project)
            deps.sync_project_jobs(project)
            yield event(
                "progress",
                {
                    "step": "myshell-art",
                    "message": "Running MyShell Art through the CDP bridge",
                    "progress": 45,
                },
            )
            try:
                result = await deps.generate_via_myshell_art(
                    bot_slug=route["bot"]["slug"],
                    prompt=route.get("optimizedPrompt") or prompt,
                    gen_button=(deps.get_bot_by_slug(route["bot"]["slug"]) or {}).get("gen_button", ""),
                    image_data=image_data,
                )
                if result.get("status") == "done" and result.get("output_url"):
                    segment["status"] = "done"
                    segment["url"] = result["output_url"]
                    segment["posterUrl"] = result["output_url"]
                    segment["evidence"] = deps.evidence(
                        "done",
                        "myshell-art",
                        accepted=True,
                        media_url=result["output_url"],
                        message="Fresh output URL extracted after generation.",
                    )
                    deps.update_job(
                        job,
                        status="done",
                        mediaUrl=result["output_url"],
                        posterUrl=result["output_url"],
                        evidence=segment["evidence"],
                    )
                else:
                    error_message = result.get("message", "MyShell Art generation did not return output media.")
                    status = "timeout" if "timed out" in error_message.lower() else "error"
                    segment["status"] = status
                    segment["evidence"] = deps.evidence(status, "myshell-art", message=error_message)
                    deps.update_job(job, status=status, evidence=segment["evidence"])
            except Exception as exc:
                segment["status"] = "error"
                segment["evidence"] = deps.evidence("error", "myshell-art", message=deps.exception_message(exc))
                deps.update_job(job, status="error", evidence=segment["evidence"])
            segment["updatedAt"] = deps.now_iso()
            deps.set_graph_status(project, route, segment)
            deps.save_project(project)
            deps.sync_project_jobs(project)
            yield event("job", {"job": deps.get_job(job["jobId"])})

    yield event("project", {"project": project})

    yield event(
        "done",
        {
            "status": segment.get("status", "queued"),
            "projectId": project["projectId"],
            "segmentId": segment["id"],
            "jobId": job["jobId"],
        },
    )
