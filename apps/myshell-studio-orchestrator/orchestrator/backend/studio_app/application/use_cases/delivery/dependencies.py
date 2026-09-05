from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from studio_app.ports.repositories import StudioStore


@dataclass(frozen=True)
class StudioDeliveryDeps:
    store: StudioStore
    list_pages: Callable[[], list[dict[str, Any]]]
    list_agents: Callable[[], list[dict[str, Any]]]
    get_page: Callable[[str], dict[str, Any]]
    page_for_dispatch: Callable[[dict[str, Any], str, str], dict[str, Any]]
    get_default_bot: Callable[[], dict[str, Any]]
    get_project: Callable[[str], dict[str, Any] | None]
    project: Callable[[str | None, str], dict[str, Any]]
    save_project: Callable[[dict[str, Any]], None]
    resolve_source_segment: Callable[[dict[str, Any] | None, str | None], dict[str, Any] | None]
    append_queued_segment: Callable[..., dict[str, Any]]
    create_job: Callable[..., dict[str, Any]]
    update_job: Callable[..., dict[str, Any]]
    job_with_evidence: Callable[[dict[str, Any] | None], dict[str, Any] | None]
    evidence: Callable[..., dict[str, Any]]
    set_graph_status: Callable[[dict[str, Any], dict[str, Any], dict[str, Any] | None], list[dict[str, Any]]]
    append_message: Callable[..., dict[str, Any]]
    sync_project_jobs: Callable[[dict[str, Any]], None]
    project_delivery_report: Callable[[dict[str, Any]], dict[str, Any]]
    build_execution_request: Callable[[dict[str, Any], dict[str, Any]], dict[str, Any]]
    runtime_health: Callable[[Any], Awaitable[dict[str, Any]]]
    adapter_auth_status: Callable[[str], dict[str, Any]]
    choose_route: Callable[..., Awaitable[dict[str, Any]]]
    dreamy_bot_route: Callable[..., dict[str, Any] | None]
    normalize_action: Callable[[str], str]
    latest_generation_smoke_job: Callable[[], dict[str, Any] | None]
    generation_smoke_summary: Callable[..., dict[str, Any]]
    now_iso: Callable[[], str]
    make_id: Callable[[str], str]
    frontend_route_source_path: Callable[[], Any]
    ignored_frontend_route_exact: set[str]
    ignored_frontend_route_prefixes: tuple[str, ...]
    ready_auth_statuses: set[str]
    status_count_keys: tuple[str, ...]
    pending_delivery_statuses: set[str]
    issue_delivery_statuses: set[str]
    valid_dispatch_target_statuses: set[str]
    core_delivery_page_ids: set[str]
    core_delivery_agent_ids: set[str]
    ready_gate_statuses: set[str]
    manual_studio_actions: set[str]
