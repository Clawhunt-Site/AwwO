from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from studio_app.api.routers.core import StudioCoreRouterDeps, build_studio_core_router
from studio_app.api.routers.delivery import StudioDeliveryRouterDeps, build_studio_delivery_router
from studio_app.api.routers.dispatch_sessions import (
    StudioDispatchSessionsRouterDeps,
    build_studio_dispatch_sessions_router,
)
from studio_app.api.routers.generation import StudioGenerationRouterDeps, build_studio_generation_router
from studio_app.api.routers.jobs import StudioJobsRouterDeps, build_studio_jobs_router
from studio_app.api.routers.projects import StudioProjectsRouterDeps, build_studio_projects_router
from studio_app.api.routers.run import StudioRunRouterDeps, build_studio_run_router
from studio_app.api.routers.superclaw import StudioSuperClawRouterDeps, build_studio_superclaw_router
from studio_app.ports.repositories import StudioStore
from studio_app.ports.task_runner import StudioTaskRunner


@dataclass(frozen=True)
class StudioRouteMountDeps:
    list_pages: Callable[..., Any]
    page_with_runtime_status: Callable[..., Any]
    list_agents: Callable[..., Any]
    dreamy_catalog_bots: Callable[..., Any]
    list_bot_previews: Callable[..., Any]
    verified_dreamy_workshop_project: Callable[..., Any]
    sync_project_jobs: Callable[..., Any]
    studio_overview: Callable[..., Any]
    dispatch_matrix: Callable[..., Any]
    studio_coverage: Callable[..., Any]
    verify_studio_coverage: Callable[..., Any]
    resolve_studio_action: Callable[..., Any]
    resolve_studio_actions_batch: Callable[..., Any]
    studio_handoff_snapshot: Callable[..., Any]
    studio_readiness: Callable[..., Any]
    studio_delivery_audit: Callable[..., Any]
    dispatch_preview: Callable[..., Any]
    store: Callable[[], StudioStore]
    dispatch_batch_plan: Callable[..., Any]
    create_dispatch_session: Callable[..., Any]
    dispatch_session_view: Callable[..., Any]
    get_dispatch_session_or_404: Callable[..., Any]
    dispatch_session_with_focused_target: Callable[..., Any]
    cancel_dispatch_session: Callable[..., Any]
    retry_dispatch_session: Callable[..., Any]
    run_dispatch_session_target: Callable[..., Any]
    update_dispatch_session_target: Callable[..., Any]
    store_path: Callable[[], Path]
    runtime_health: Callable[..., Any]
    latest_generation_smoke_job: Callable[..., Any]
    generation_smoke_summary: Callable[..., Any]
    execute_generation_smoke: Callable[..., Any]
    cookie_source_status: Callable[..., Any]
    probe_art_api_auth: Callable[..., Any]
    canvaspro_node_capabilities: Callable[..., Any]
    canvaspro_cli_auth: Callable[..., Any]
    canvaspro_cli_auth_doctor: Callable[..., Any]
    canvaspro_login_with_token: Callable[..., Any]
    canvaspro_login_with_cookie: Callable[..., Any]
    canvaspro_stage_source_asset: Callable[..., Any]
    canvaspro_generation_task: Callable[..., Any]
    canvaspro_generation_task_sync: Callable[..., Any]
    dreamy_bots: Callable[..., Any]
    execute_dreamy_workshop_smoke: Callable[..., Any]
    run_studio_response: Callable[..., Any]
    superclaw_status: Callable[..., Any]
    superclaw_run_canvas_workflow: Callable[..., Any]
    superclaw_list_runs: Callable[..., Any]
    superclaw_get_run: Callable[..., Any]
    superclaw_stream_run_events: Callable[..., Any]
    superclaw_cancel_run: Callable[..., Any]
    superclaw_resume_run: Callable[..., Any]
    superclaw_create_automation: Callable[..., Any]
    superclaw_list_automations: Callable[..., Any]
    superclaw_approve_automation: Callable[..., Any]
    superclaw_delete_automation: Callable[..., Any]
    job_with_evidence: Callable[..., Any]
    get_project: Callable[..., Any]
    project_delivery_report: Callable[..., Any]
    project_delivery_bundle: Callable[..., Any]
    create_timeline_export: Callable[..., Any]
    apply_client_result: Callable[..., Any]
    reset_project: Callable[..., Any]
    terminal_cancel_statuses: set[str]
    cancel_job_record: Callable[..., Any]
    retry_job_record: Callable[..., Any]
    poll_dreamy_job_result: Callable[..., Any]
    task_runner: StudioTaskRunner


def mount_studio_routes(app: Any, deps: StudioRouteMountDeps) -> None:
    app.include_router(
        build_studio_core_router(
            StudioCoreRouterDeps(
                list_pages=deps.list_pages,
                page_with_runtime_status=deps.page_with_runtime_status,
                list_agents=deps.list_agents,
                dreamy_catalog_bots=deps.dreamy_catalog_bots,
                list_bot_previews=deps.list_bot_previews,
                verified_dreamy_workshop_project=deps.verified_dreamy_workshop_project,
                sync_project_jobs=deps.sync_project_jobs,
                studio_overview=deps.studio_overview,
            )
        )
    )
    app.include_router(
        build_studio_delivery_router(
            StudioDeliveryRouterDeps(
                dispatch_matrix=deps.dispatch_matrix,
                studio_coverage=deps.studio_coverage,
                verify_studio_coverage=deps.verify_studio_coverage,
                resolve_studio_action=deps.resolve_studio_action,
                resolve_studio_actions_batch=deps.resolve_studio_actions_batch,
                studio_handoff_snapshot=deps.studio_handoff_snapshot,
                studio_readiness=deps.studio_readiness,
                studio_delivery_audit=deps.studio_delivery_audit,
                dispatch_preview=deps.dispatch_preview,
            )
        )
    )
    app.include_router(
        build_studio_dispatch_sessions_router(
            StudioDispatchSessionsRouterDeps(
                store=deps.store,
                dispatch_batch_plan=deps.dispatch_batch_plan,
                create_dispatch_session=deps.create_dispatch_session,
                dispatch_session_view=deps.dispatch_session_view,
                get_dispatch_session_or_404=deps.get_dispatch_session_or_404,
                dispatch_session_with_focused_target=deps.dispatch_session_with_focused_target,
                cancel_dispatch_session=deps.cancel_dispatch_session,
                retry_dispatch_session=deps.retry_dispatch_session,
                run_dispatch_session_target=deps.run_dispatch_session_target,
                update_dispatch_session_target=deps.update_dispatch_session_target,
            )
        )
    )
    app.include_router(
        build_studio_generation_router(
            StudioGenerationRouterDeps(
                store_path=deps.store_path,
                runtime_health=deps.runtime_health,
                latest_generation_smoke_job=deps.latest_generation_smoke_job,
                generation_smoke_summary=deps.generation_smoke_summary,
                execute_generation_smoke=deps.execute_generation_smoke,
                cookie_source_status=deps.cookie_source_status,
                probe_art_api_auth=deps.probe_art_api_auth,
                canvaspro_node_capabilities=deps.canvaspro_node_capabilities,
                canvaspro_cli_auth=deps.canvaspro_cli_auth,
                canvaspro_cli_auth_doctor=deps.canvaspro_cli_auth_doctor,
                canvaspro_login_with_token=deps.canvaspro_login_with_token,
                canvaspro_login_with_cookie=deps.canvaspro_login_with_cookie,
                canvaspro_stage_source_asset=deps.canvaspro_stage_source_asset,
                canvaspro_generation_task=deps.canvaspro_generation_task,
                canvaspro_generation_task_sync=deps.canvaspro_generation_task_sync,
                dreamy_bots=deps.dreamy_bots,
                execute_dreamy_workshop_smoke=deps.execute_dreamy_workshop_smoke,
            )
        )
    )
    app.include_router(build_studio_run_router(StudioRunRouterDeps(run_studio_response=deps.run_studio_response)))
    app.include_router(
        build_studio_superclaw_router(
            StudioSuperClawRouterDeps(
                status=deps.superclaw_status,
                run_canvas_workflow=deps.superclaw_run_canvas_workflow,
                list_runs=deps.superclaw_list_runs,
                get_run=deps.superclaw_get_run,
                stream_run_events=deps.superclaw_stream_run_events,
                cancel_run=deps.superclaw_cancel_run,
                resume_run=deps.superclaw_resume_run,
                create_automation=deps.superclaw_create_automation,
                list_automations=deps.superclaw_list_automations,
                approve_automation=deps.superclaw_approve_automation,
                delete_automation=deps.superclaw_delete_automation,
            )
        )
    )
    app.include_router(
        build_studio_projects_router(
            StudioProjectsRouterDeps(
                store=deps.store,
                job_with_evidence=deps.job_with_evidence,
                get_project=deps.get_project,
                sync_project_jobs=deps.sync_project_jobs,
                project_delivery_report=deps.project_delivery_report,
                project_delivery_bundle=deps.project_delivery_bundle,
                create_timeline_export=deps.create_timeline_export,
                apply_client_result=deps.apply_client_result,
                reset_project=deps.reset_project,
            )
        )
    )
    app.include_router(
        build_studio_jobs_router(
            StudioJobsRouterDeps(
                store=deps.store,
                terminal_cancel_statuses=deps.terminal_cancel_statuses,
                job_with_evidence=deps.job_with_evidence,
                cancel_job_record=deps.cancel_job_record,
                retry_job_record=deps.retry_job_record,
                poll_dreamy_job_result=deps.poll_dreamy_job_result,
                task_runner=deps.task_runner,
            )
        )
    )
