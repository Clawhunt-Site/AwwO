from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any


MAX_PROMPT_CHARS = 8_000
MAX_NODE_COUNT = 80
MAX_CONNECTION_COUNT = 160


class SuperClawCanvasError(Exception):
    def __init__(self, status_code: int, detail: str) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


@dataclass(frozen=True)
class SuperClawCanvasDeps:
    create_goal: Callable[[dict[str, Any]], Awaitable[dict[str, Any]]]
    create_run: Callable[[dict[str, Any]], Awaitable[dict[str, Any]]]


def _text(value: Any, fallback: str = "") -> str:
    return str(value or fallback).strip()


def _bool(value: Any, fallback: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return fallback


def _int(value: Any, fallback: int, *, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = fallback
    return max(minimum, min(parsed, maximum))


def _record(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _compact_node(raw: Any) -> dict[str, Any]:
    node = _record(raw)
    return {
        "id": _text(node.get("id")),
        "kind": _text(node.get("kind") or node.get("type")),
        "title": _text(node.get("title") or node.get("name")),
        "status": _text(node.get("status")),
        "action": _text(node.get("action")),
        "prompt": _text(node.get("prompt"))[:1200],
        "outputText": _text(node.get("outputText") or node.get("text"))[:1200],
        "botSlug": _text(node.get("botSlug")),
        "botName": _text(node.get("botName")),
        "sourceType": _text(node.get("sourceType")),
        "fileName": _text(node.get("fileName")),
        "mediaUrl": _text(node.get("mediaUrl") or node.get("url"))[:500],
    }


def _compact_connection(raw: Any) -> dict[str, Any]:
    connection = _record(raw)
    return {
        "id": _text(connection.get("id")),
        "from": _text(connection.get("from") or connection.get("source")),
        "to": _text(connection.get("to") or connection.get("target")),
        "label": _text(connection.get("label") or connection.get("type")),
    }


def _canvas_context(payload: dict[str, Any]) -> dict[str, Any]:
    nodes = [_compact_node(item) for item in _list(payload.get("nodes"))[:MAX_NODE_COUNT]]
    connections = [_compact_connection(item) for item in _list(payload.get("connections"))[:MAX_CONNECTION_COUNT]]
    selected_node_id = _text(payload.get("selectedNodeId"))
    selected_node_ids = [_text(item) for item in _list(payload.get("selectedNodeIds")) if _text(item)]
    selected = next((node for node in nodes if node["id"] == selected_node_id), None)
    if not selected and selected_node_ids:
        selected = next((node for node in nodes if node["id"] == selected_node_ids[0]), None)
    return {
        "projectId": _text(payload.get("projectId")),
        "action": _text(payload.get("action"), "generate"),
        "selectedNodeId": selected_node_id,
        "selectedNodeIds": selected_node_ids,
        "selectedNode": selected,
        "nodes": nodes,
        "connections": connections,
    }


def _goal_title(prompt: str, context: dict[str, Any]) -> str:
    selected = _record(context.get("selectedNode"))
    label = _text(selected.get("title")) or _text(context.get("action"), "Canvas workflow")
    prompt_prefix = prompt[:48].strip()
    if prompt_prefix:
        return f"{label}: {prompt_prefix}"
    return f"{label}: SuperClaw canvas workflow"


def _goal_description(prompt: str, context: dict[str, Any]) -> str:
    compact = {
        "projectId": context.get("projectId"),
        "action": context.get("action"),
        "selectedNodeId": context.get("selectedNodeId"),
        "selectedNodeIds": context.get("selectedNodeIds"),
        "selectedNode": context.get("selectedNode"),
        "nodes": context.get("nodes"),
        "connections": context.get("connections"),
    }
    graph_json = json.dumps(compact, ensure_ascii=False, indent=2)
    return (
        "Execute this Studio canvas workflow through SuperClaw.\n\n"
        f"User instruction:\n{prompt or 'Run the selected canvas workflow.'}\n\n"
        "Canvas graph context:\n"
        f"```json\n{graph_json}\n```\n\n"
        "Return concise progress, preserve artifact links, and describe which canvas node each output belongs to."
    )


async def run_canvas_workflow(payload: dict[str, Any], *, deps: SuperClawCanvasDeps) -> dict[str, Any]:
    prompt = _text(payload.get("prompt") or payload.get("message"))[:MAX_PROMPT_CHARS]
    if not prompt:
        raise SuperClawCanvasError(422, "prompt is required")
    context = _canvas_context(payload)
    run_options = _record(payload.get("run"))
    goal_payload = {
        "title": _goal_title(prompt, context),
        "description": _goal_description(prompt, context),
    }
    goal_response = await deps.create_goal(goal_payload)
    goal_id = _text(goal_response.get("goal_id") or _record(goal_response.get("goal")).get("goal_id"))
    if not goal_id:
        raise SuperClawCanvasError(502, "SuperClaw did not return a goal_id")
    run_payload = {
        "goal_id": goal_id,
        "dry_run": _bool(run_options.get("dryRun") if "dryRun" in run_options else run_options.get("dry_run"), False),
        "async_execution": True,
        "backend_policy": _text(run_options.get("backendPolicy") or run_options.get("backend_policy"), "claude"),
        "model": run_options.get("model") or None,
        "effort": run_options.get("effort") or None,
        "harness_policy": _text(run_options.get("harnessPolicy") or run_options.get("harness_policy"), "codex"),
        "concurrency": _int(run_options.get("concurrency"), 1, minimum=1, maximum=64),
        "repo_path": _text(run_options.get("repoPath") or run_options.get("repo_path"), "."),
        "budget_seconds": _int(run_options.get("budgetSeconds") or run_options.get("budget_seconds"), 600, minimum=1, maximum=86400),
        "verification_policy": _text(
            run_options.get("verificationPolicy") or run_options.get("verification_policy"),
            "adversarial",
        ),
        "permission_preset": _text(run_options.get("permissionPreset") or run_options.get("permission_preset"), "ask"),
        "chat_session_id": _text(run_options.get("chatSessionId") or run_options.get("chat_session_id")) or None,
    }
    run_response = await deps.create_run(run_payload)
    run_id = _text(run_response.get("run_id"))
    if not run_id:
        raise SuperClawCanvasError(502, "SuperClaw did not return a run_id")
    return {
        "mode": "goal-run",
        "goal": goal_response,
        "run": run_response,
        "context": context,
        "execution": {
            "goalId": goal_id,
            "runId": run_id,
            "eventsUrl": f"/api/studio/superclaw/runs/{run_id}/events",
        },
    }
