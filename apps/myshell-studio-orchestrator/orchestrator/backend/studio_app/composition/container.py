from __future__ import annotations

import os
from typing import Any, Optional

from fastapi import HTTPException, UploadFile
from sse_starlette.sse import EventSourceResponse

from studio_app.infrastructure.adapters.myshell_art import api as myshell_art_api
from studio_app.infrastructure.adapters.myshell_art import cli as myshell_art_cli
from studio_app.registry.bot_catalog import MYSHELL_BOTS, get_bot_by_slug
from studio_app.registry.bot_previews import DREAMY_BOTS, get_dreamy_bot_by_slug, list_bot_previews
from studio_app.api.route_mounting import StudioRouteMountDeps
from studio_app.application.use_cases import canvaspro as canvaspro_rules
from studio_app.application.use_cases import superclaw_canvas
from studio_app.application.use_cases import delivery as delivery_use_cases
from studio_app.application.use_cases import dreamy_generation
from studio_app.application.services import dreamy_jobs
from studio_app.application.policies import dispatch as dispatch_rules
from studio_app.application.policies.handoff import artifacts as handoff_artifacts
from studio_app.application.use_cases import jobs as job_lifecycle
from studio_app.application.use_cases import client_results as project_results
from studio_app.application.use_cases import projects as project_use_cases
from studio_app.application.state import project as project_state
from studio_app.application.services import route_selection
from studio_app.application.policies import routing as routing_policy
from studio_app.application.state.project_cache import PROJECTS
from studio_app.application.use_cases import run as run_flow
from studio_app.application.use_cases import timeline_exports
from studio_app.infrastructure.adapters.dreamy import client as dreamy_client
from studio_app.infrastructure.adapters.superclaw import client as superclaw_client
from studio_app.infrastructure.storage import media, timeline_video
from studio_app.registry import get_page, list_studio_agents, list_studio_pages, page_for_dispatch
from studio_app.infrastructure.runtime import health as runtime_health_service
from studio_app.infrastructure.runtime.task_runner import STUDIO_TASK_RUNNER
from studio_app.infrastructure.db.sqlite_store import STUDIO_STORE
from studio_app.composition.settings import (
    CANVASPRO_SOURCE_ASSET_MAX_BYTES,
    CANVASPRO_SOURCE_ASSET_MEDIA_PREFIXES,
    CORE_DELIVERY_AGENT_IDS,
    CORE_DELIVERY_PAGE_IDS,
    IGNORED_FRONTEND_ROUTE_EXACT,
    IGNORED_FRONTEND_ROUTE_PREFIXES,
    ISSUE_DELIVERY_STATUSES,
    MANUAL_STUDIO_ACTIONS,
    PENDING_DELIVERY_STATUSES,
    PLACEHOLDER_POSTERS,
    READY_AUTH_STATUSES,
    READY_GATE_STATUSES,
    STATUS_COUNT_KEYS,
    TERMINAL_CANCEL_STATUSES,
    VALID_ACTIONS,
    VALID_DISPATCH_TARGET_STATUSES,
    VALID_MODES,
    VALID_STATUSES,
    VERIFIED_DREAMY_WORKSHOP_PROJECT_ID,
    VERIFIED_DREAMY_WORKSHOP_SEGMENTS,
    frontend_route_source_path,
)

try:
    from orchestrator import understand_intent
except Exception:  # pragma: no cover - keeps tests independent of optional AI deps
    understand_intent = None


StudioProject = dict[str, Any]
StudioSegment = dict[str, Any]


def _delivery_use_case_deps() -> delivery_use_cases.StudioDeliveryDeps:
    return delivery_use_cases.StudioDeliveryDeps(
        store=STUDIO_STORE,
        list_pages=list_studio_pages,
        list_agents=list_studio_agents,
        get_page=get_page,
        page_for_dispatch=page_for_dispatch,
        get_default_bot=lambda: get_bot_by_slug("seedream-multi-chart") or MYSHELL_BOTS[0],
        get_project=_get_project,
        project=_project,
        save_project=_save_project,
        resolve_source_segment=_resolve_source_segment,
        append_queued_segment=_append_queued_segment,
        create_job=_create_job,
        update_job=_update_job,
        job_with_evidence=_job_with_evidence,
        evidence=_evidence,
        set_graph_status=_set_graph_status,
        append_message=_append_message,
        sync_project_jobs=_sync_project_jobs,
        project_delivery_report=_project_delivery_report,
        build_execution_request=_build_execution_request,
        runtime_health=runtime_health_service.runtime_health,
        adapter_auth_status=runtime_health_service.adapter_auth_status,
        choose_route=choose_route,
        dreamy_bot_route=_dreamy_bot_route,
        normalize_action=_normalize_action,
        latest_generation_smoke_job=_latest_generation_smoke_job,
        generation_smoke_summary=_generation_smoke_summary,
        now_iso=now_iso,
        make_id=make_id,
        frontend_route_source_path=frontend_route_source_path,
        ignored_frontend_route_exact=IGNORED_FRONTEND_ROUTE_EXACT,
        ignored_frontend_route_prefixes=IGNORED_FRONTEND_ROUTE_PREFIXES,
        ready_auth_statuses=READY_AUTH_STATUSES,
        status_count_keys=STATUS_COUNT_KEYS,
        pending_delivery_statuses=PENDING_DELIVERY_STATUSES,
        issue_delivery_statuses=ISSUE_DELIVERY_STATUSES,
        valid_dispatch_target_statuses=VALID_DISPATCH_TARGET_STATUSES,
        core_delivery_page_ids=CORE_DELIVERY_PAGE_IDS,
        core_delivery_agent_ids=CORE_DELIVERY_AGENT_IDS,
        ready_gate_statuses=READY_GATE_STATUSES,
        manual_studio_actions=MANUAL_STUDIO_ACTIONS,
    )


def _delivery_use_cases() -> delivery_use_cases.StudioDeliveryUseCases:
    return delivery_use_cases.StudioDeliveryUseCases(_delivery_use_case_deps())


def _raise_delivery_error(exc: delivery_use_cases.StudioDeliveryError) -> None:
    raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc


def _raise_superclaw_error(exc: Exception) -> None:
    if isinstance(exc, superclaw_canvas.SuperClawCanvasError):
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc
    if isinstance(exc, superclaw_client.SuperClawClientError):
        detail: dict[str, Any] = {"message": exc.detail}
        if exc.upstream_status is not None:
            detail["upstreamStatus"] = exc.upstream_status
        raise HTTPException(status_code=exc.status_code, detail=detail) from exc
    raise exc


def _agent_id_for_page(page: dict[str, Any]) -> str:
    return _delivery_use_cases().agent_id_for_page(page)


def _agent_id_for_dispatch(page: dict[str, Any], preferred_agent_id: str | None = None) -> str:
    return _delivery_use_cases().agent_id_for_dispatch(page, preferred_agent_id)


def _navigation_contract(
    page: dict[str, Any],
    route: dict[str, Any] | None = None,
    source_segment: Optional[StudioSegment] = None,
) -> dict[str, Any]:
    return dispatch_rules.navigation_contract(page, route, source_segment)


def _missing_route_params(page: dict[str, Any], navigation_path: str) -> list[str]:
    return dispatch_rules.missing_route_params(page, navigation_path)


def _page_with_runtime_status(page: dict[str, Any]) -> dict[str, Any]:
    return _delivery_use_cases().page_with_runtime_status(page)


def _studio_overview(limit: int = 50) -> dict[str, Any]:
    return _delivery_use_cases().studio_overview(limit)


def _dispatch_matrix(project_id: str | None = None, source_segment_id: str | None = None) -> dict[str, Any]:
    return _delivery_use_cases().dispatch_matrix(project_id=project_id, source_segment_id=source_segment_id)


def _studio_coverage(project_id: str | None = None, source_segment_id: str | None = None) -> dict[str, Any]:
    return _delivery_use_cases().studio_coverage(project_id=project_id, source_segment_id=source_segment_id)


def _verify_studio_coverage(
    *,
    project_id: str | None = None,
    source_segment_id: str | None = None,
    page_ids: list[str] | None = None,
    limit: int = 50,
) -> dict[str, Any]:
    try:
        return _delivery_use_cases().verify_studio_coverage(
            project_id=project_id,
            source_segment_id=source_segment_id,
            page_ids=page_ids,
            limit=limit,
        )
    except delivery_use_cases.StudioDeliveryError as exc:
        _raise_delivery_error(exc)


async def _studio_dispatch_batch_plan(
    *,
    project_id: str | None = None,
    source_segment_id: str | None = None,
    page_ids: list[str] | None = None,
    limit: int = 50,
    exclude_covered: bool = False,
) -> dict[str, Any]:
    try:
        return await _delivery_use_cases().studio_dispatch_batch_plan(
            project_id=project_id,
            source_segment_id=source_segment_id,
            page_ids=page_ids,
            limit=limit,
            exclude_covered=exclude_covered,
        )
    except delivery_use_cases.StudioDeliveryError as exc:
        _raise_delivery_error(exc)


def _dispatch_session_view(session: dict[str, Any]) -> dict[str, Any]:
    return _delivery_use_cases().dispatch_session_view(session)


async def _create_dispatch_session(
    *,
    project_id: str | None = None,
    source_segment_id: str | None = None,
    page_ids: list[str] | None = None,
    limit: int = 50,
    exclude_covered: bool = False,
) -> dict[str, Any]:
    try:
        return await _delivery_use_cases().create_dispatch_session(
            project_id=project_id,
            source_segment_id=source_segment_id,
            page_ids=page_ids,
            limit=limit,
            exclude_covered=exclude_covered,
        )
    except delivery_use_cases.StudioDeliveryError as exc:
        _raise_delivery_error(exc)


def _get_dispatch_session_or_404(session_id: str) -> dict[str, Any]:
    try:
        return _delivery_use_cases().get_dispatch_session_or_404(session_id)
    except delivery_use_cases.StudioDeliveryError as exc:
        _raise_delivery_error(exc)


def _dispatch_session_with_focused_target(session: dict[str, Any], target_id: str | None = None) -> dict[str, Any]:
    return _delivery_use_cases().dispatch_session_with_focused_target(session, target_id)


def _record_dispatch_session_target_completion(
    session: dict[str, Any],
    target: dict[str, Any],
    operator_evidence: dict[str, Any],
) -> dict[str, Any] | None:
    return _delivery_use_cases().record_dispatch_session_target_completion(session, target, operator_evidence)


def _update_dispatch_session_target(
    session_id: str,
    target_id: str,
    *,
    status: str,
    evidence: dict[str, Any] | None = None,
) -> dict[str, Any]:
    try:
        return _delivery_use_cases().update_dispatch_session_target(
            session_id,
            target_id,
            status=status,
            evidence=evidence,
        )
    except delivery_use_cases.StudioDeliveryError as exc:
        _raise_delivery_error(exc)


def _run_dispatch_session_target(session_id: str, target_id: str) -> dict[str, Any]:
    try:
        return _delivery_use_cases().run_dispatch_session_target(session_id, target_id)
    except delivery_use_cases.StudioDeliveryError as exc:
        _raise_delivery_error(exc)


def _cancel_dispatch_session(session_id: str) -> dict[str, Any]:
    try:
        return _delivery_use_cases().cancel_dispatch_session(session_id)
    except delivery_use_cases.StudioDeliveryError as exc:
        _raise_delivery_error(exc)


def _retry_dispatch_session(session_id: str) -> dict[str, Any]:
    try:
        return _delivery_use_cases().retry_dispatch_session(session_id)
    except delivery_use_cases.StudioDeliveryError as exc:
        _raise_delivery_error(exc)


def _delivery_bundle_artifacts(
    project_id: str,
    sessions: list[dict[str, Any]],
    source_segment_id: str | None = None,
) -> list[dict[str, Any]]:
    return handoff_artifacts.delivery_bundle_artifacts(project_id, sessions, source_segment_id)


async def _studio_handoff_snapshot(
    project_id: str | None = None,
    source_segment_id: str | None = None,
) -> dict[str, Any]:
    try:
        return await _delivery_use_cases().studio_handoff_snapshot(
            project_id=project_id,
            source_segment_id=source_segment_id,
        )
    except delivery_use_cases.StudioDeliveryError as exc:
        _raise_delivery_error(exc)


async def _studio_readiness() -> dict[str, Any]:
    try:
        return await _delivery_use_cases().studio_readiness()
    except delivery_use_cases.StudioDeliveryError as exc:
        _raise_delivery_error(exc)


async def _studio_delivery_audit(
    project_id: str | None = None,
    source_segment_id: str | None = None,
) -> dict[str, Any]:
    try:
        return await _delivery_use_cases().studio_delivery_audit(
            project_id=project_id,
            source_segment_id=source_segment_id,
        )
    except delivery_use_cases.StudioDeliveryError as exc:
        _raise_delivery_error(exc)


async def _resolve_studio_action(payload: dict[str, Any] | None) -> dict[str, Any]:
    try:
        return await _delivery_use_cases().resolve_studio_action(payload)
    except delivery_use_cases.StudioDeliveryError as exc:
        _raise_delivery_error(exc)


async def _resolve_studio_actions_batch(payload: dict[str, Any] | None) -> dict[str, Any]:
    try:
        return await _delivery_use_cases().resolve_studio_actions_batch(payload)
    except delivery_use_cases.StudioDeliveryError as exc:
        _raise_delivery_error(exc)


def _job_lifecycle_deps() -> job_lifecycle.JobLifecycleDeps:
    return job_lifecycle.JobLifecycleDeps(
        evidence=_evidence,
        update_job=_update_job,
        get_project=_get_project,
        now_iso=now_iso,
        sync_project_jobs=_sync_project_jobs,
        build_execution_request=_build_execution_request,
    )


def _cancel_job_record(job: dict[str, Any]) -> tuple[dict[str, Any], StudioProject | None]:
    return job_lifecycle.cancel_job_record(job, deps=_job_lifecycle_deps())


def _retry_job_record(job: dict[str, Any]) -> tuple[dict[str, Any], StudioProject | None, dict[str, Any] | None]:
    return job_lifecycle.retry_job_record(job, deps=_job_lifecycle_deps())


async def _dispatch_preview(
    *,
    message: str,
    action: str,
    page_id: str,
    agent_id: str | None = None,
    project_id: str | None = None,
    source_segment_id: str | None = None,
    has_image: bool = False,
    bot_id: str | None = None,
    bot_slug: str | None = None,
    bot_name: str | None = None,
    bot_type: str | None = None,
    article_id: str | None = None,
) -> dict[str, Any]:
    try:
        return await _delivery_use_cases().dispatch_preview(
            message=message,
            action=action,
            page_id=page_id,
            agent_id=agent_id,
            project_id=project_id,
            source_segment_id=source_segment_id,
            has_image=has_image,
            bot_id=bot_id,
            bot_slug=bot_slug,
            bot_name=bot_name,
            bot_type=bot_type,
            article_id=article_id,
        )
    except delivery_use_cases.StudioDeliveryError as exc:
        _raise_delivery_error(exc)


def now_iso() -> str:
    return project_state.now_iso()


def make_id(prefix: str) -> str:
    return project_state.make_id(prefix)


def _normalize_mode(mode: str) -> str:
    return project_state.normalize_mode(mode, valid_modes=VALID_MODES)


def _normalize_action(action: str) -> str:
    return project_state.normalize_action(action, valid_actions=VALID_ACTIONS)


def _normalize_status(status: str | None) -> str:
    return project_state.normalize_status(status, valid_statuses=VALID_STATUSES)


def _project_use_case_deps() -> project_use_cases.ProjectUseCaseDeps:
    return project_use_cases.ProjectUseCaseDeps(
        projects_cache=PROJECTS,
        store=STUDIO_STORE,
        valid_modes=VALID_MODES,
        status_count_keys=STATUS_COUNT_KEYS,
        pending_delivery_statuses=PENDING_DELIVERY_STATUSES,
        issue_delivery_statuses=ISSUE_DELIVERY_STATUSES,
        placeholder_posters=PLACEHOLDER_POSTERS,
        verified_workshop_project_id=VERIFIED_DREAMY_WORKSHOP_PROJECT_ID,
        verified_workshop_segments=VERIFIED_DREAMY_WORKSHOP_SEGMENTS,
        now_iso=now_iso,
        make_id=make_id,
        adapter_auth_status=runtime_health_service.adapter_auth_status,
        get_page=get_page,
        get_bot_by_slug=get_bot_by_slug,
        get_dreamy_bot_by_slug=get_dreamy_bot_by_slug,
        navigation_contract=_navigation_contract,
        missing_route_params=_missing_route_params,
        agent_id_for_dispatch=_agent_id_for_dispatch,
        agent_id_for_page=_agent_id_for_page,
        set_graph_status=_set_graph_status,
        studio_coverage=_studio_coverage,
        studio_handoff_snapshot=_studio_handoff_snapshot,
        dispatch_session_view=_dispatch_session_view,
        delivery_bundle_artifacts=_delivery_bundle_artifacts,
    )


def _project_use_cases() -> project_use_cases.ProjectUseCases:
    return project_use_cases.ProjectUseCases(_project_use_case_deps())


def _save_project(project: StudioProject) -> None:
    return _project_use_cases().save_project(project)


def _get_project(project_id: str) -> Optional[StudioProject]:
    return _project_use_cases().get_project(project_id)


def _segment_type_for_bot(bot: dict[str, Any]) -> str:
    return project_state.segment_type_for_bot(bot)


def _project(project_id: Optional[str] = None, mode: str = "player") -> StudioProject:
    return _project_use_cases().project(project_id, mode)


def _verified_dreamy_workshop_project() -> StudioProject:
    return _project_use_cases().verified_dreamy_workshop_project()


def _set_graph_status(
    project: StudioProject,
    route: dict[str, Any],
    segment: Optional[StudioSegment] = None,
) -> list[dict[str, Any]]:
    return project_state.set_graph_status(project, route, segment)


def _dreamy_bot_route(
    *,
    bot_id: str | None = None,
    bot_slug: str | None,
    bot_name: str | None = None,
    bot_type: str | None = None,
    article_id: str | None = None,
    message: str = "",
) -> dict[str, Any] | None:
    slug = (bot_slug or bot_id or "").strip()
    return routing_policy.dreamy_bot_route(
        bot_id=bot_id,
        bot_slug=bot_slug,
        bot_name=bot_name,
        bot_type=bot_type,
        article_id=article_id,
        message=message,
        seed=get_dreamy_bot_by_slug(slug) or {},
    )


def _manual_bot_sequence_items(bot_sequence: str | None, default_action: str) -> list[dict[str, str]]:
    return routing_policy.manual_bot_sequence_items(
        bot_sequence,
        default_action,
        valid_actions=VALID_ACTIONS,
    )


def _route_selection_deps() -> route_selection.RouteSelectionDeps:
    return route_selection.RouteSelectionDeps(
        env_get=os.environ.get,
        understand_intent=understand_intent,
        get_bot_by_slug=get_bot_by_slug,
        bots=lambda: MYSHELL_BOTS,
    )


async def choose_route(message: str, has_image: bool, action: str, source_segment: Optional[StudioSegment]) -> dict[str, Any]:
    return await route_selection.choose_route(
        message,
        has_image,
        action,
        source_segment,
        deps=_route_selection_deps(),
    )


def _find_segment(project: StudioProject, segment_id: Optional[str]) -> Optional[StudioSegment]:
    return project_state.find_segment(project, segment_id)


def _resolve_source_segment(project: StudioProject | None, segment_id: Optional[str]) -> Optional[StudioSegment]:
    return project_state.resolve_source_segment(project, segment_id)


def _append_message(project: StudioProject, role: str, content: str, **extra: Any) -> dict[str, Any]:
    return project_state.append_message(
        project,
        role,
        content,
        make_id=make_id,
        now_iso=now_iso,
        save_project=_save_project,
        extra=extra,
    )


def _evidence(
    status: str,
    source: str,
    *,
    accepted: bool = False,
    message: str = "",
    media_url: str = "",
    task_id: str = "",
) -> dict[str, Any]:
    return project_state.evidence(
        status,
        source,
        checked_at=now_iso(),
        accepted=accepted,
        message=message,
        media_url=media_url,
        task_id=task_id,
    )


def _exception_message(exc: Exception) -> str:
    return project_state.exception_message(exc)


def _sync_project_jobs(project: StudioProject) -> None:
    return _project_use_cases().sync_project_jobs(project)


def _job_with_evidence(job: dict[str, Any] | None) -> dict[str, Any] | None:
    return _project_use_cases().job_with_evidence(job)


def _project_delivery_report(project: StudioProject) -> dict[str, Any]:
    return _project_use_cases().project_delivery_report(project)


async def _project_delivery_bundle(
    project: StudioProject,
    source_segment_id: str | None = None,
) -> dict[str, Any]:
    return await _project_use_cases().project_delivery_bundle(project, source_segment_id)


def _create_timeline_export(project: StudioProject, segment_ids: list[str] | None = None) -> dict[str, Any]:
    return timeline_exports.create_timeline_export(
        project,
        segment_ids,
        make_id=make_id,
        now_iso=now_iso,
        evidence_factory=_evidence,
        save_project=_save_project,
        compose_video=timeline_video.compose_timeline_video,
        exception_message=_exception_message,
    )


def _dreamy_generation_deps() -> dreamy_generation.DreamyGenerationDeps:
    return dreamy_generation.DreamyGenerationDeps(
        get_project=_get_project,
        find_segment=_find_segment,
        adapter_auth_status=runtime_health_service.adapter_auth_status,
        dreamy_init_data=runtime_health_service.dreamy_init_data,
        dreamyporn_web_cookie_status=runtime_health_service.dreamyporn_web_cookie_status,
        dreamy_api_request=dreamy_client.dreamy_api_request,
        dreamyporn_web_request=dreamy_client.dreamyporn_web_request,
        dreamyporn_web_input_images=dreamy_client.dreamyporn_web_input_images,
        evidence=_evidence,
        now_iso=now_iso,
        update_job=_update_job,
        set_graph_status=_set_graph_status,
        save_project=_save_project,
        sync_project_jobs=_sync_project_jobs,
        update_dispatch_session_target=_update_dispatch_session_target,
        seed_dreamy_bots=lambda: DREAMY_BOTS,
    )


def _raise_dreamy_generation_error(exc: dreamy_generation.DreamyGenerationError) -> None:
    raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc


async def _dreamy_catalog_bots() -> tuple[list[dict[str, Any]], str]:
    return await dreamy_generation.dreamy_catalog_bots(deps=_dreamy_generation_deps())


async def _poll_dreamy_job_result(job: dict[str, Any]) -> tuple[dict[str, Any], StudioProject | None]:
    try:
        return await dreamy_generation.poll_dreamy_job_result(job, deps=_dreamy_generation_deps())
    except dreamy_generation.DreamyGenerationError as exc:
        _raise_dreamy_generation_error(exc)


async def _run_dreamy_server_adapter(
    *,
    project: StudioProject,
    segment: StudioSegment,
    job: dict[str, Any],
    route: dict[str, Any],
    prompt: str,
    source_segment: StudioSegment | None,
    input_image_bytes: bytes | None = None,
    input_image_filename: str = "",
    input_image_content_type: str = "",
) -> dict[str, Any]:
    return await dreamy_generation.run_dreamy_server_adapter(
        project=project,
        segment=segment,
        job=job,
        route=route,
        prompt=prompt,
        source_segment=source_segment,
        input_image_bytes=input_image_bytes,
        input_image_filename=input_image_filename,
        input_image_content_type=input_image_content_type,
        deps=_dreamy_generation_deps(),
    )


def _build_execution_request(project: StudioProject, job: dict[str, Any]) -> dict[str, Any]:
    return _project_use_cases().build_execution_request(project, job)


def _create_job(
    project: StudioProject,
    segment: StudioSegment,
    route: dict[str, Any],
    page: dict[str, Any],
    source_segment: Optional[StudioSegment] = None,
    status: str = "queued",
    agent_id: str | None = None,
) -> dict[str, Any]:
    return _project_use_cases().create_job(
        project,
        segment,
        route,
        page,
        source_segment,
        status=status,
        agent_id=agent_id,
    )


def _update_job(job: dict[str, Any], **patch: Any) -> dict[str, Any]:
    return _project_use_cases().update_job(job, **patch)


def _latest_generation_smoke_job() -> dict[str, Any] | None:
    for job in STUDIO_STORE.list_jobs(page_id="dreamy-miniapp", limit=100):
        evidence = job.get("evidence") if isinstance(job.get("evidence"), dict) else {}
        if evidence.get("generationSmoke"):
            return job
    return None


def _generation_smoke_summary(
    *,
    prerequisites: dict[str, Any],
    latest_job: dict[str, Any] | None,
    executed_job: dict[str, Any] | None = None,
    project: StudioProject | None = None,
    message: str = "",
) -> dict[str, Any]:
    return dreamy_jobs.generation_smoke_summary(
        prerequisites=prerequisites,
        latest_job=latest_job,
        checked_at=now_iso(),
        executed_job=executed_job,
        project=project,
        message=message,
    )


def _canvaspro_use_case_deps() -> canvaspro_rules.CanvasProUseCaseDeps:
    return canvaspro_rules.CanvasProUseCaseDeps(
        generated_media_root=media.generated_media_root,
        now_iso=now_iso,
        make_id=make_id,
        source_asset_max_bytes=CANVASPRO_SOURCE_ASSET_MAX_BYTES,
        source_asset_media_prefixes=CANVASPRO_SOURCE_ASSET_MEDIA_PREFIXES,
        execute_canvaspro_task=myshell_art_cli.execute_canvaspro_task,
        build_canvaspro_plan=myshell_art_cli.build_canvaspro_plan,
        fetch_canvaspro_task_result=myshell_art_cli.fetch_canvaspro_task_result,
        fetch_art_api_result=myshell_art_api.fetch_art_api_result,
        generate_via_art_api=myshell_art_api.generate_via_art_api,
        cookie_source_status=runtime_health_service.cookie_source_status,
    )


async def _canvaspro_stage_source_asset(file: UploadFile, upload_remote: bool = False) -> dict[str, Any]:
    data = await file.read()
    try:
        return await canvaspro_rules.stage_source_asset(
            _canvaspro_use_case_deps(),
            filename=file.filename or "",
            content_type=str(file.content_type or "application/octet-stream"),
            data=data,
            upload_remote=upload_remote,
        )
    except canvaspro_rules.CanvasProSourceAssetError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc


async def _canvaspro_generation_task_sync(payload: dict[str, Any]) -> dict[str, Any]:
    return await canvaspro_rules.generation_task_sync(payload, deps=_canvaspro_use_case_deps())


async def _canvaspro_generation_task(payload: dict[str, Any]) -> dict[str, Any]:
    return await canvaspro_rules.generation_task(payload, deps=_canvaspro_use_case_deps())


def _dreamy_live_generation_deps() -> dreamy_jobs.DreamyLiveGenerationDeps:
    return dreamy_jobs.DreamyLiveGenerationDeps(
        project=_project,
        append_message=_append_message,
        choose_route=choose_route,
        get_page=get_page,
        navigation_contract=_navigation_contract,
        missing_route_params=_missing_route_params,
        agent_id_for_dispatch=_agent_id_for_dispatch,
        append_queued_segment=_append_queued_segment,
        create_job=_create_job,
        make_id=make_id,
        save_job=STUDIO_STORE.save_job,
        save_evidence=STUDIO_STORE.save_evidence,
        run_dreamy_server_adapter=_run_dreamy_server_adapter,
        evidence=_evidence,
        exception_message=_exception_message,
        now_iso=now_iso,
        update_job=_update_job,
        set_graph_status=_set_graph_status,
        save_project=_save_project,
        sync_project_jobs=_sync_project_jobs,
        get_job=STUDIO_STORE.get_job,
        job_with_evidence=_job_with_evidence,
        dreamy_bot_route=_dreamy_bot_route,
        dreamy_bots=lambda: DREAMY_BOTS,
    )


async def _execute_generation_smoke(prompt: str) -> dict[str, Any]:
    return await dreamy_jobs.execute_generation_smoke(prompt, deps=_dreamy_live_generation_deps())


async def _execute_dreamy_workshop_smoke(prompt: str, limit: int | None = None) -> dict[str, Any]:
    return await dreamy_jobs.execute_dreamy_workshop_smoke(
        prompt,
        deps=_dreamy_live_generation_deps(),
        limit=limit,
    )


def _append_queued_segment(
    project: StudioProject,
    route: dict[str, Any],
    prompt: str,
    action: str,
    source_segment_id: Optional[str],
) -> StudioSegment:
    return _project_use_cases().append_queued_segment(project, route, prompt, action, source_segment_id)


async def _generate_via_myshell_art(**kwargs: Any) -> dict[str, Any]:
    from myshell_bridge import generate_via_bot

    return await generate_via_bot(**kwargs)


def _run_flow_deps() -> run_flow.StudioRunFlowDeps:
    return run_flow.StudioRunFlowDeps(
        normalize_mode=_normalize_mode,
        normalize_action=_normalize_action,
        project=_project,
        append_message=_append_message,
        resolve_source_segment=_resolve_source_segment,
        manual_bot_sequence_items=_manual_bot_sequence_items,
        dreamy_bot_route=_dreamy_bot_route,
        choose_route=choose_route,
        page_for_dispatch=page_for_dispatch,
        adapter_auth_status=runtime_health_service.adapter_auth_status,
        navigation_contract=_navigation_contract,
        missing_route_params=_missing_route_params,
        agent_id_for_dispatch=_agent_id_for_dispatch,
        append_queued_segment=_append_queued_segment,
        create_job=_create_job,
        set_graph_status=_set_graph_status,
        run_dreamy_server_adapter=_run_dreamy_server_adapter,
        get_job=STUDIO_STORE.get_job,
        update_job=_update_job,
        save_project=_save_project,
        sync_project_jobs=_sync_project_jobs,
        evidence=_evidence,
        now_iso=now_iso,
        exception_message=_exception_message,
        guess_image_content_type=dreamy_client.guess_image_content_type,
        get_bot_by_slug=get_bot_by_slug,
        generate_via_myshell_art=_generate_via_myshell_art,
    )


async def _run_studio_response(
    message: str = "",
    project_id: Optional[str] = None,
    mode: str = "player",
    action: str = "generate",
    source_segment_id: Optional[str] = None,
    page_id: str = "dreamy-miniapp",
    agent_id: Optional[str] = None,
    bot_id: Optional[str] = None,
    bot_slug: Optional[str] = None,
    bot_name: Optional[str] = None,
    bot_type: Optional[str] = None,
    article_id: Optional[str] = None,
    bot_sequence: Optional[str] = None,
    agent_graph: Optional[str] = None,
    image: Optional[UploadFile] = None,
):
    return EventSourceResponse(
        run_flow.run_studio_events(
            message=message,
            project_id=project_id,
            mode=mode,
            action=action,
            source_segment_id=source_segment_id,
            page_id=page_id,
            agent_id=agent_id,
            bot_id=bot_id,
            bot_slug=bot_slug,
            bot_name=bot_name,
            bot_type=bot_type,
            article_id=article_id,
            bot_sequence=bot_sequence,
            agent_graph=agent_graph,
            image=image,
            deps=_run_flow_deps(),
        ),
        ping=15,
    )


def _apply_studio_client_result(project_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    try:
        return project_results.apply_client_result(
            project_id,
            payload,
            deps=project_results.ClientResultDeps(
                get_project=_get_project,
                find_segment=_find_segment,
                get_dreamy_bot_by_slug=get_dreamy_bot_by_slug,
                get_bot_by_slug=get_bot_by_slug,
                make_id=make_id,
                segment_type_for_bot=_segment_type_for_bot,
                adapter_auth_status=runtime_health_service.adapter_auth_status,
                now_iso=now_iso,
                normalize_status=_normalize_status,
                evidence=_evidence,
                set_graph_status=_set_graph_status,
                append_message=_append_message,
                get_job=STUDIO_STORE.get_job,
                find_job_by_segment=STUDIO_STORE.find_job_by_segment,
                update_job=_update_job,
                update_dispatch_session_target=_update_dispatch_session_target,
                sync_project_jobs=_sync_project_jobs,
            ),
        )
    except project_results.ProjectResultError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc


def _reset_studio_project(project_id: str) -> dict[str, Any]:
    if project_id in PROJECTS:
        del PROJECTS[project_id]
    STUDIO_STORE.delete_project(project_id)
    return {"projectId": project_id, "status": "reset"}


async def _superclaw_status() -> dict[str, Any]:
    try:
        return await superclaw_client.superclaw_status()
    except superclaw_client.SuperClawClientError as exc:
        _raise_superclaw_error(exc)
        raise RuntimeError("unreachable") from exc


async def _superclaw_run_canvas_workflow(payload: dict[str, Any]) -> dict[str, Any]:
    try:
        return await superclaw_canvas.run_canvas_workflow(
            payload,
            deps=superclaw_canvas.SuperClawCanvasDeps(
                create_goal=superclaw_client.create_goal,
                create_run=superclaw_client.create_run,
            ),
        )
    except (superclaw_canvas.SuperClawCanvasError, superclaw_client.SuperClawClientError) as exc:
        _raise_superclaw_error(exc)
        raise RuntimeError("unreachable") from exc


async def _superclaw_list_runs() -> dict[str, Any]:
    try:
        return await superclaw_client.list_runs()
    except superclaw_client.SuperClawClientError as exc:
        _raise_superclaw_error(exc)
        raise RuntimeError("unreachable") from exc


async def _superclaw_get_run(run_id: str) -> dict[str, Any]:
    try:
        return await superclaw_client.get_run(run_id)
    except superclaw_client.SuperClawClientError as exc:
        _raise_superclaw_error(exc)
        raise RuntimeError("unreachable") from exc


def _superclaw_stream_run_events(run_id: str):
    return superclaw_client.stream_run_events(run_id)


async def _superclaw_cancel_run(run_id: str) -> dict[str, Any]:
    try:
        return await superclaw_client.cancel_run(run_id)
    except superclaw_client.SuperClawClientError as exc:
        _raise_superclaw_error(exc)
        raise RuntimeError("unreachable") from exc


async def _superclaw_resume_run(run_id: str) -> dict[str, Any]:
    try:
        return await superclaw_client.resume_run(run_id)
    except superclaw_client.SuperClawClientError as exc:
        _raise_superclaw_error(exc)
        raise RuntimeError("unreachable") from exc


async def _superclaw_create_automation(payload: dict[str, Any]) -> dict[str, Any]:
    try:
        return await superclaw_client.create_automation(payload)
    except superclaw_client.SuperClawClientError as exc:
        _raise_superclaw_error(exc)
        raise RuntimeError("unreachable") from exc


async def _superclaw_list_automations(session_issue_id: str | None = None) -> list[dict[str, Any]]:
    try:
        return await superclaw_client.list_automations(session_issue_id)
    except superclaw_client.SuperClawClientError as exc:
        _raise_superclaw_error(exc)
        raise RuntimeError("unreachable") from exc


async def _superclaw_approve_automation(automation_id: str) -> dict[str, Any]:
    try:
        return await superclaw_client.approve_automation(automation_id)
    except superclaw_client.SuperClawClientError as exc:
        _raise_superclaw_error(exc)
        raise RuntimeError("unreachable") from exc


async def _superclaw_delete_automation(automation_id: str) -> dict[str, Any]:
    try:
        return await superclaw_client.delete_automation(automation_id)
    except superclaw_client.SuperClawClientError as exc:
        _raise_superclaw_error(exc)
        raise RuntimeError("unreachable") from exc


def build_studio_route_mount_deps() -> StudioRouteMountDeps:
    return StudioRouteMountDeps(
        list_pages=list_studio_pages,
        page_with_runtime_status=_page_with_runtime_status,
        list_agents=list_studio_agents,
        dreamy_catalog_bots=_dreamy_catalog_bots,
        list_bot_previews=list_bot_previews,
        verified_dreamy_workshop_project=_verified_dreamy_workshop_project,
        sync_project_jobs=_sync_project_jobs,
        studio_overview=_studio_overview,
        dispatch_matrix=_dispatch_matrix,
        studio_coverage=_studio_coverage,
        verify_studio_coverage=_verify_studio_coverage,
        resolve_studio_action=_resolve_studio_action,
        resolve_studio_actions_batch=_resolve_studio_actions_batch,
        studio_handoff_snapshot=_studio_handoff_snapshot,
        studio_readiness=_studio_readiness,
        studio_delivery_audit=_studio_delivery_audit,
        dispatch_preview=_dispatch_preview,
        store=lambda: STUDIO_STORE,
        dispatch_batch_plan=_studio_dispatch_batch_plan,
        create_dispatch_session=_create_dispatch_session,
        dispatch_session_view=_dispatch_session_view,
        get_dispatch_session_or_404=_get_dispatch_session_or_404,
        dispatch_session_with_focused_target=_dispatch_session_with_focused_target,
        cancel_dispatch_session=_cancel_dispatch_session,
        retry_dispatch_session=_retry_dispatch_session,
        run_dispatch_session_target=_run_dispatch_session_target,
        update_dispatch_session_target=_update_dispatch_session_target,
        store_path=lambda: STUDIO_STORE.path,
        runtime_health=lambda store_path: runtime_health_service.runtime_health(store_path),
        latest_generation_smoke_job=_latest_generation_smoke_job,
        generation_smoke_summary=_generation_smoke_summary,
        execute_generation_smoke=_execute_generation_smoke,
        cookie_source_status=lambda: runtime_health_service.cookie_source_status(),
        probe_art_api_auth=lambda: myshell_art_api.probe_art_api_auth(),
        canvaspro_node_capabilities=lambda: myshell_art_cli.canvaspro_node_capabilities(),
        canvaspro_cli_auth=lambda: myshell_art_cli.auth_status(),
        canvaspro_cli_auth_doctor=lambda: myshell_art_cli.auth_doctor(),
        canvaspro_login_with_token=lambda token: myshell_art_cli.login_with_token(token),
        canvaspro_login_with_cookie=lambda cookie: myshell_art_cli.login_with_cookie(cookie),
        canvaspro_stage_source_asset=_canvaspro_stage_source_asset,
        canvaspro_generation_task=_canvaspro_generation_task,
        canvaspro_generation_task_sync=_canvaspro_generation_task_sync,
        dreamy_bots=lambda: DREAMY_BOTS,
        execute_dreamy_workshop_smoke=_execute_dreamy_workshop_smoke,
        run_studio_response=_run_studio_response,
        superclaw_status=_superclaw_status,
        superclaw_run_canvas_workflow=_superclaw_run_canvas_workflow,
        superclaw_list_runs=_superclaw_list_runs,
        superclaw_get_run=_superclaw_get_run,
        superclaw_stream_run_events=_superclaw_stream_run_events,
        superclaw_cancel_run=_superclaw_cancel_run,
        superclaw_resume_run=_superclaw_resume_run,
        superclaw_create_automation=_superclaw_create_automation,
        superclaw_list_automations=_superclaw_list_automations,
        superclaw_approve_automation=_superclaw_approve_automation,
        superclaw_delete_automation=_superclaw_delete_automation,
        job_with_evidence=_job_with_evidence,
        get_project=_get_project,
        project_delivery_report=_project_delivery_report,
        project_delivery_bundle=_project_delivery_bundle,
        create_timeline_export=_create_timeline_export,
        apply_client_result=_apply_studio_client_result,
        reset_project=_reset_studio_project,
        terminal_cancel_statuses=TERMINAL_CANCEL_STATUSES,
        cancel_job_record=_cancel_job_record,
        retry_job_record=_retry_job_record,
        poll_dreamy_job_result=_poll_dreamy_job_result,
        task_runner=STUDIO_TASK_RUNNER,
    )
