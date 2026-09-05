"""Runtime-specific display projectors (Display Protocol section 2, DL1).

The normalization boundary is NOT inside the adapter (which would grow fat and
keep drifting) but in these small, *pure* projector functions: they take a raw
runtime event plus an explicit :class:`ProjectionState` ``ctx`` and return
canonical :class:`~superclaw.display_contracts.DisplayEvent` objects. The emit
site (``codex_app_server.run_turn`` / ``claude_stream.run_claude_stream``) owns
the ``ctx`` and threads it across raw events; the adapter only forwards.

First principle -- Full Disclosure: every field a runtime *can* provide is
projected; a field it truly cannot provide is set ``null`` and named in
``degraded_fields`` (never fabricated). Tool input/output is redacted then
truncated before display (design doc section 7.4/7.5).

Channel-neutral ids (DL5): the projector stamps a *synthetic* session-local
monotonic ``id`` (``id_source="synthetic"``) good for the realtime chat channel.
The durable run channel overrides ``id`` with the SQLite ``events.id`` at read
time (PR-4); the synthetic value is harmless there.

PR-2 wires the codex projector; PR-3 adds the claude projector here. The module
stays dependency-light (stdlib + ``display_contracts``) so it never import-cycles
with runtime/backends/orchestrator.
"""
from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from typing import Any

from superclaw.display_contracts import (
    CallIdSource,
    CapabilityTier,
    DisplayEvent,
    EventType,
    IdSource,
    StreamType,
    ToolCall,
    ToolKind,
    ToolStatus,
    redact_payload,
    truncate_field,
    utc_now_iso,
)

CODEX_RUNTIME_ID = "codex-app-server"
CLAUDE_RUNTIME_ID = "claude-cli"


@dataclass
class ProjectionState:
    """Explicit per-turn projection context (DL1).

    Held locally by the emit site and passed across raw events -- no hidden
    global state, no IO. ``open_calls`` indexes in-flight tool calls by their
    (native or synthesized) ``call_id`` so interleaved / late-delta / terminal
    repair all resolve to the right card. ``command_buffers`` keeps the streamed
    command output so ``tool.completed`` can fall back to it when the runtime
    gives no aggregated output (DL5).
    """

    runtime_id: str
    capability_tier: str
    turn_id: str | None = None
    seq: int = 0
    open_calls: dict[str, ToolCall] = field(default_factory=dict)
    command_buffers: dict[str, list[str]] = field(default_factory=dict)
    reasoning_parts: list[str] = field(default_factory=list)
    _synth_counter: int = 0

    def next_seq(self) -> int:
        self.seq += 1
        return self.seq

    def synth_call_id(self, prefix: str) -> str:
        self._synth_counter += 1
        return f"{prefix}-{self._synth_counter}"

    def begin_turn(self, turn_id: str | None) -> None:
        """Start a new turn ON THE SAME session-scoped state. seq and the
        synthesized-id counter MUST persist so ids stay session-local-monotonic
        and never collide across turns (DL5 "session-local 单调"); only the
        per-turn transient maps reset. A new chat turn that reuses the codex
        thread therefore gets fresh, non-colliding tool-call ids."""
        self.turn_id = turn_id
        self.open_calls.clear()
        self.command_buffers.clear()
        self.reasoning_parts.clear()


def new_codex_projection_state(turn_id: str | None = None) -> ProjectionState:
    # codex app-server is a FULL-tier runtime (streaming + tool lifecycle + input
    # + output); the tier is a constant summary label per runtime (design doc §4).
    return ProjectionState(
        runtime_id=CODEX_RUNTIME_ID, capability_tier="full", turn_id=turn_id
    )


def new_claude_projection_state(turn_id: str | None = None) -> ProjectionState:
    # claude-cli is PARTIAL: it streams text + tool lifecycle + tool input, and
    # PR-3 now carries tool_result content too, BUT the headless stream gives no
    # incremental tool deltas (no live per-line command stdout like codex's
    # commandExecution/outputDelta), and tool_result carries no name (recovered by
    # correlation, which can fail). The conservative tier label is partial; the
    # per-call degraded_fields give the precise truth.
    return ProjectionState(
        runtime_id=CLAUDE_RUNTIME_ID, capability_tier="partial", turn_id=turn_id
    )


# api-agent runtimes (gemini / anthropic): SuperClaw OWNS the tool loop
# (_RealToolExecution executes run_shell/write_file/read_file/list_files itself),
# so the kernel holds the authoritative tool input AND output. Projected POST-HOC
# as real tool cards (the kernel truly executed them — not fabricated, not a
# faked live stream). partial tier: full tool input/output, but no incremental
# deltas and no live streaming (the tools run after each model round).
GEMINI_AGENT_RUNTIME_ID = "gemini-agent"
ANTHROPIC_AGENT_RUNTIME_ID = "anthropic-agent"


def new_agent_projection_state(runtime_id: str, turn_id: str | None = None) -> ProjectionState:
    return ProjectionState(runtime_id=runtime_id, capability_tier="partial", turn_id=turn_id)


def _event(ctx: ProjectionState, etype: str, payload: dict[str, Any]) -> DisplayEvent:
    seq = ctx.next_seq()
    return DisplayEvent(
        type=etype,
        runtime_id=ctx.runtime_id,
        seq=seq,
        ts=utc_now_iso(),
        capability_tier=ctx.capability_tier,
        payload=payload,
        turn_id=ctx.turn_id,
        # Synthetic id for the realtime chat channel; the durable run channel
        # overrides it with the SQLite events.id at read time (DL5).
        id=seq,
        id_source=IdSource.SYNTHETIC.value,
    )


def _redact_truncate(value: Any) -> tuple[Any, list[str], bool]:
    """Redaction BEFORE display, then inline truncation to the field budget.

    Returns ``(value, redacted_field_paths, was_truncated)``.
    """
    if value is None:
        return None, [], False
    redacted, redacted_fields = redact_payload(value)
    truncated_value, was_truncated = truncate_field(redacted)
    return truncated_value, redacted_fields, was_truncated


def _finalize_tool_call(
    call: ToolCall, *, input_value: Any, output_value: Any
) -> ToolCall:
    """Apply redaction + truncation to a tool call's input/output and record the
    ``redacted_fields`` / ``truncated`` flags honestly."""
    redacted_fields: list[str] = []
    if input_value is not None:
        value, fields, trunc = _redact_truncate(input_value)
        call.input = value
        call.truncated["input"] = trunc
        redacted_fields.extend(f"input.{f}" if f != "$" else "input" for f in fields)
        # A field that is now present is NOT degraded: clear a stale marker left by
        # a started phase that hadn't yet seen the value (cross-phase recovery).
        if "input" in call.degraded_fields:
            call.degraded_fields.remove("input")
    if output_value is not None:
        value, fields, trunc = _redact_truncate(output_value)
        call.output = value
        call.truncated["output"] = trunc
        redacted_fields.extend(f"output.{f}" if f != "$" else "output" for f in fields)
        if "output" in call.degraded_fields:
            call.degraded_fields.remove("output")
    if redacted_fields:
        # Extend, never overwrite: a call finalized twice (input at item/started,
        # output at item/completed) must keep BOTH sets of "已脱敏" markers honest.
        call.redacted_fields = list(call.redacted_fields) + redacted_fields
    return call


# --- codex ------------------------------------------------------------------

_CODEX_TOOL_ITEM_TYPES = {"commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall"}


def _codex_call_id(item: dict[str, Any], ctx: ProjectionState, prefix: str) -> tuple[str, str]:
    native = item.get("id") or item.get("itemId")
    if isinstance(native, str) and native:
        return native, CallIdSource.RUNTIME.value
    return ctx.synth_call_id(prefix), CallIdSource.PROJECTOR.value


def _codex_kind(item_type: str) -> str:
    if item_type == "commandExecution":
        return ToolKind.COMMAND.value
    if item_type == "fileChange":
        return ToolKind.FILE.value
    if item_type in {"mcpToolCall", "dynamicToolCall"}:
        return ToolKind.MCP.value
    return ToolKind.UNKNOWN.value


# --- codex v2 protocol field accessors (authoritative: app-server-protocol
# v2/item.rs ThreadItem). Field names match the real wire shape; defensive
# fallbacks remain for older/variant shapes but never fabricate. ----------------


def _codex_file_changes(item: dict[str, Any]) -> tuple[str | None, str | None]:
    """Extract (path summary, joined diff) from a v2 fileChange item. The per-file
    changes live in ``changes`` (a list of {path, kind, diff}); there is NO
    top-level diff/patch field."""
    changes = item.get("changes")
    if not isinstance(changes, list):
        return None, None
    paths: list[str] = []
    diffs: list[str] = []
    for change in changes:
        if not isinstance(change, dict):
            continue
        path = change.get("path")
        if isinstance(path, str) and path:
            paths.append(path)
        diff = change.get("diff")
        if isinstance(diff, str) and diff:
            diffs.append(diff)
    return ("; ".join(paths) if paths else None), ("\n".join(diffs) if diffs else None)


def _codex_mcp_name(item: dict[str, Any]) -> str | None:
    # v2: the tool name field is `tool` (McpToolCall.tool / DynamicToolCall.tool);
    # keep `name` only as a defensive fallback.
    tool = item.get("tool") or item.get("name")
    return tool if isinstance(tool, str) and tool else None


def _codex_args(item: dict[str, Any]) -> Any:
    # v2: tool args are `arguments`; keep input/params as defensive fallbacks. Used
    # by BOTH started and completed so a completed-only recovery stays consistent.
    for key in ("arguments", "input", "params"):
        value = item.get(key)
        if value is not None:
            return value
    return None


def _codex_terminal_status(item: dict[str, Any], *, error: bool = False) -> str | None:
    """Map the authoritative v2 status enum (inProgress/completed/failed/declined)
    to a ToolStatus. Returns None when the runtime gives no status, so the caller
    falls back to its own signal (e.g. a command exit code)."""
    raw = str(item.get("status") or "")
    if raw == "declined":
        return ToolStatus.CANCELLED.value
    if raw == "failed" or error:
        return ToolStatus.ERROR.value
    if raw == "completed":
        return ToolStatus.OK.value
    if raw == "inProgress":
        return ToolStatus.RUNNING.value
    return None


def _codex_apply_duration(call: ToolCall, item: dict[str, Any]) -> None:
    value = item.get("durationMs")
    if isinstance(value, int):
        call.duration_ms = value


def _mark_degraded(call: ToolCall, field: str) -> None:
    """Record a field the runtime could not provide (honest degradation), without
    duplicating it across the started -> completed phases."""
    if field not in call.degraded_fields:
        call.degraded_fields.append(field)


def _codex_started_call(item: dict[str, Any], ctx: ProjectionState) -> ToolCall | None:
    item_type = str(item.get("type") or "")
    if item_type not in _CODEX_TOOL_ITEM_TYPES:
        return None
    call_id, source = _codex_call_id(item, ctx, item_type)
    kind = _codex_kind(item_type)
    call = ToolCall(call_id=call_id, call_id_source=source, kind=kind, status=ToolStatus.RUNNING.value)
    if kind == ToolKind.COMMAND.value:
        call.name = "command"
        _finalize_tool_call(call, input_value={"command": item.get("command"), "cwd": item.get("cwd")}, output_value=None)
    elif kind == ToolKind.FILE.value:
        call.name = "file"
        path_summary, _diff = _codex_file_changes(item)
        # Honest, consistent with mcp: no path provided -> degraded input (the
        # completed item, terminal-authoritative, will correct it if it arrives).
        if not path_summary:
            _mark_degraded(call, "input")
        _finalize_tool_call(call, input_value={"path": path_summary} if path_summary else None, output_value=None)
    else:  # mcp / dynamic
        call.name = _codex_mcp_name(item)
        args = _codex_args(item)
        if args is None:
            _mark_degraded(call, "input")
        _finalize_tool_call(call, input_value=args, output_value=None)
    return call


def _codex_completion_call_id(
    item: dict[str, Any], ctx: ProjectionState, item_type: str, kind: str
) -> tuple[str, str]:
    """Resolve the call_id for an item/completed. Prefer the native id; with no
    native id, CORRELATE to the most-recent still-open call of the same kind so
    started+completed stay ONE card (else completed would synthesize a *new* id,
    leaving the started call open -> terminal repair would emit a phantom error).
    Only synthesize a fresh id when nothing matches."""
    native = item.get("id") or item.get("itemId")
    if isinstance(native, str) and native:
        return native, CallIdSource.RUNTIME.value
    for cid in reversed(list(ctx.open_calls)):
        if ctx.open_calls[cid].kind == kind:
            return cid, ctx.open_calls[cid].call_id_source
    return ctx.synth_call_id(item_type), CallIdSource.PROJECTOR.value


def _codex_completed_call(item: dict[str, Any], ctx: ProjectionState) -> ToolCall:
    item_type = str(item.get("type") or "")
    kind = _codex_kind(item_type)
    call_id, source = _codex_completion_call_id(item, ctx, item_type, kind)
    # Reuse the open call if we saw item/started, so the started input survives.
    call = ctx.open_calls.pop(call_id, None)
    if call is None:
        call = ToolCall(call_id=call_id, call_id_source=source, kind=kind, status=ToolStatus.RUNNING.value)
    if kind == ToolKind.COMMAND.value:
        call.name = call.name or "command"
        _codex_apply_duration(call, item)
        exit_code = item.get("exitCode")
        if isinstance(exit_code, int):
            call.exit_code = exit_code
        # Honest output (Full Disclosure): a present empty string is REAL empty
        # output (ran, produced nothing) and is NOT degraded; only a genuinely
        # absent field with no buffered stream is "unavailable" -> output=null +
        # degraded["output"]. Never conflate the two.
        raw_output = item.get("aggregatedOutput")
        buffered = ctx.command_buffers.pop(call_id, None)
        if isinstance(raw_output, str) and raw_output:
            output: Any = raw_output
        elif buffered:
            output = "".join(buffered)
        elif isinstance(raw_output, str):
            output = ""  # present-but-empty: ran, produced no output
        else:
            output = None  # truly unavailable
        # Authoritative v2 status first (declined/failed); otherwise exit-code
        # derived (completed + exitCode!=0 is still an error).
        status = _codex_terminal_status(item)
        if status is None or status == ToolStatus.OK.value:
            status = ToolStatus.OK.value if (exit_code in (0, None)) else ToolStatus.ERROR.value
        call.status = status
        if output is None:
            _mark_degraded(call, "output")
        _finalize_tool_call(
            call,
            input_value=None if call.input is not None else {"command": item.get("command")},
            output_value=output,
        )
    elif kind == ToolKind.FILE.value:
        call.name = call.name or "file"
        _codex_apply_duration(call, item)
        path_summary, joined_diff = _codex_file_changes(item)
        call.status = _codex_terminal_status(item) or ToolStatus.OK.value
        # The diff lives in changes[].diff (v2); no diff -> honest degraded.
        if joined_diff is None:
            _mark_degraded(call, "output")
        input_value = {"path": path_summary} if (call.input is None and path_summary) else None
        if call.input is None and not path_summary:
            _mark_degraded(call, "input")
        _finalize_tool_call(call, input_value=input_value, output_value=joined_diff)
    else:  # mcp / dynamic
        call.name = call.name or _codex_mcp_name(item)
        _codex_apply_duration(call, item)
        if item_type == "dynamicToolCall":
            # v2 DynamicToolCall: output is `contentItems`; failure is success==False.
            result = item.get("contentItems")
            is_error = item.get("success") is False
        else:
            # v2 McpToolCall: output is `result`; failure is the `error` object.
            result = item.get("result")
            is_error = item.get("error") is not None
        call.status = _codex_terminal_status(item, error=is_error) or (
            ToolStatus.ERROR.value if is_error else ToolStatus.OK.value
        )
        # Recover arguments on a completed-only item (no item/started seen): the
        # v2 McpToolCall/DynamicToolCall both carry `arguments` on completion too.
        # Same variant fallback as started (consistency).
        args = _codex_args(item)
        input_value = None if call.input is not None else args
        if call.input is None and args is None:
            _mark_degraded(call, "input")
        if result is None:
            _mark_degraded(call, "output")
        _finalize_tool_call(call, input_value=input_value, output_value=result)
    return call


def project_codex_event(raw: dict[str, Any], ctx: ProjectionState) -> list[DisplayEvent]:
    """Project one codex app-server notification into canonical DisplayEvents.

    ``message.delta`` / ``message.completed`` are intentionally NOT projected
    here: the text stream keeps its existing bare wire shape so the surfaces that
    already render it are untouched (the emit site still emits those directly).
    Returns ``[]`` for raw events that carry no tool/reasoning display content.
    """
    method = str(raw.get("method") or "")
    params = raw.get("params") if isinstance(raw.get("params"), dict) else {}
    out: list[DisplayEvent] = []

    if method == "item/started":
        item = params.get("item") if isinstance(params.get("item"), dict) else {}
        item_type = str(item.get("type") or "")
        call = _codex_started_call(item, ctx)
        if call is not None:
            ctx.open_calls[call.call_id] = call
            out.append(_event(ctx, EventType.TOOL_STARTED.value, call.to_dict()))
        elif item_type == "reasoning":
            # No canonical reasoning.started -- the content rides reasoning.delta /
            # reasoning.completed. Nothing to emit on start.
            pass
        return out

    if method in {
        "item/commandExecution/outputDelta",
        "item/commandExecution/output/delta",
        "commandExecution/output/delta",
    }:
        delta = params.get("delta")
        if isinstance(delta, str) and delta:
            call_id = params.get("itemId") or params.get("item_id")
            if not (isinstance(call_id, str) and call_id):
                # No item id on the delta: attribute to the single open command.
                open_cmd = [cid for cid, c in ctx.open_calls.items() if c.kind == ToolKind.COMMAND.value]
                call_id = open_cmd[-1] if open_cmd else ctx.synth_call_id("commandExecution")
            ctx.command_buffers.setdefault(call_id, []).append(delta)
            chunk, _fields, _trunc = _redact_truncate(delta)
            out.append(
                _event(
                    ctx,
                    EventType.TOOL_DELTA.value,
                    {"call_id": call_id, "stream_type": StreamType.STDOUT.value, "chunk": chunk},
                )
            )
        return out

    if method in {
        "item/reasoning/delta",
        "item/reasoning/summaryDelta",
        "item/agentReasoning/delta",
        "agent/reasoning/delta",
    }:
        delta = params.get("delta") or params.get("text")
        if isinstance(delta, str) and delta:
            ctx.reasoning_parts.append(delta)
            text, _fields, _trunc = _redact_truncate(delta)
            out.append(_event(ctx, EventType.REASONING_DELTA.value, {"text": text}))
        return out

    if method == "item/completed":
        item = params.get("item") if isinstance(params.get("item"), dict) else {}
        item_type = str(item.get("type") or "")
        if item_type in _CODEX_TOOL_ITEM_TYPES:
            call = _codex_completed_call(item, ctx)
            out.append(_event(ctx, EventType.TOOL_COMPLETED.value, call.to_dict()))
        elif item_type == "reasoning":
            text = _extract_codex_reasoning(item)
            if not text and ctx.reasoning_parts:
                text = "".join(ctx.reasoning_parts)
            ctx.reasoning_parts.clear()
            if text:
                value, _fields, _trunc = _redact_truncate(text)
                out.append(_event(ctx, EventType.REASONING_COMPLETED.value, {"text": value}))
        return out

    return out


def _extract_codex_reasoning(item: dict[str, Any]) -> str:
    parts: list[str] = []
    for key in ("summary", "content"):
        seq = item.get(key)
        if isinstance(seq, list):
            for el in seq:
                if isinstance(el, str):
                    parts.append(el)
                elif isinstance(el, dict):
                    text = el.get("text") or el.get("summary") or el.get("content")
                    if isinstance(text, str):
                        parts.append(text)
    return "\n".join(p for p in parts if p).strip()


# --- claude (stream-json) ---------------------------------------------------

_CLAUDE_FILE_TOOLS = {"Read", "Write", "Edit", "MultiEdit", "NotebookEdit"}


def _claude_kind(name: Any) -> str:
    if not isinstance(name, str) or not name:
        return ToolKind.UNKNOWN.value
    if name.startswith("mcp__"):
        return ToolKind.MCP.value
    if name == "Bash":
        return ToolKind.COMMAND.value
    if name in _CLAUDE_FILE_TOOLS:
        return ToolKind.FILE.value
    return ToolKind.BUILTIN.value


def _claude_started_call(block: dict[str, Any], ctx: ProjectionState) -> ToolCall:
    tool_use_id = block.get("id")
    if isinstance(tool_use_id, str) and tool_use_id:
        call_id, source = tool_use_id, CallIdSource.RUNTIME.value
    else:
        call_id, source = ctx.synth_call_id("tool"), CallIdSource.PROJECTOR.value
    name = block.get("name")
    call = ToolCall(
        call_id=call_id,
        call_id_source=source,
        kind=_claude_kind(name),
        status=ToolStatus.RUNNING.value,
        name=name if isinstance(name, str) and name else None,
    )
    if call.name is None:
        call.degraded_fields.append("name")
    input_value = block.get("input")
    if input_value is None:
        call.degraded_fields.append("input")
    _finalize_tool_call(call, input_value=input_value, output_value=None)
    return call


def _claude_completed_call(block: dict[str, Any], ctx: ProjectionState) -> ToolCall:
    tool_use_id = block.get("tool_use_id")
    # tool_result carries no tool name -- correlate to the open tool_use to
    # recover name/kind/input; if correlation fails, name is honestly degraded.
    call: ToolCall | None = None
    if isinstance(tool_use_id, str) and tool_use_id:
        call = ctx.open_calls.pop(tool_use_id, None)
    if call is None:
        cid = tool_use_id if (isinstance(tool_use_id, str) and tool_use_id) else ctx.synth_call_id("tool")
        src = CallIdSource.RUNTIME.value if (isinstance(tool_use_id, str) and tool_use_id) else CallIdSource.PROJECTOR.value
        call = ToolCall(call_id=cid, call_id_source=src, kind=ToolKind.UNKNOWN.value, status=ToolStatus.RUNNING.value)
        call.degraded_fields.append("name")
    content = block.get("content")
    is_error = bool(block.get("is_error"))
    call.status = ToolStatus.ERROR.value if is_error else ToolStatus.OK.value
    if content is None:
        call.degraded_fields.append("output")
    _finalize_tool_call(call, input_value=None, output_value=content)
    return call


def project_claude_event(raw: dict[str, Any], ctx: ProjectionState) -> list[DisplayEvent]:
    """Project one claude stream-json event into canonical DisplayEvents.

    Like the codex projector, ``message.delta``/``message.completed`` (text) and
    the ``usage`` event are NOT produced here -- the emit site owns the bare text
    stream and emits usage via :func:`project_claude_usage`. Returns ``[]`` for
    events with no tool display content.
    """
    etype = raw.get("type")
    message = raw.get("message") if isinstance(raw.get("message"), dict) else {}
    out: list[DisplayEvent] = []
    if etype == "assistant":
        for block in message.get("content", []) or []:
            if isinstance(block, dict) and block.get("type") == "tool_use":
                call = _claude_started_call(block, ctx)
                ctx.open_calls[call.call_id] = call
                out.append(_event(ctx, EventType.TOOL_STARTED.value, call.to_dict()))
    elif etype == "user":
        for block in message.get("content", []) or []:
            if isinstance(block, dict) and block.get("type") == "tool_result":
                call = _claude_completed_call(block, ctx)
                out.append(_event(ctx, EventType.TOOL_COMPLETED.value, call.to_dict()))
    return out


def project_claude_usage(usage: dict[str, Any], ctx: ProjectionState) -> list[DisplayEvent]:
    """Emit a canonical ``usage`` event from claude's parsed token usage. claude
    has no live capability object; usage honesty is the emit behaviour itself
    (DL3) -- when the stream carries usage we surface it, otherwise nothing."""
    if not isinstance(usage, dict) or not usage:
        return []
    return [_event(ctx, EventType.USAGE.value, {"usage": usage})]


# --- codex auto-approval (DL7) ----------------------------------------------

_CODEX_APPROVAL_META = {
    "item/commandExecution/requestApproval": (ToolKind.COMMAND.value, "command"),
    "item/fileChange/requestApproval": (ToolKind.FILE.value, "file"),
    "item/permissions/requestApproval": (ToolKind.APPROVAL.value, "permissions"),
    "mcpServer/elicitation/request": (ToolKind.MCP.value, "mcp-elicitation"),
}


def _approval_id(request: dict[str, Any]) -> str:
    params = request.get("params") if isinstance(request.get("params"), dict) else {}
    candidate = request.get("id")
    if candidate is None:
        candidate = params.get("itemId") or params.get("item_id")
    return str(candidate) if candidate is not None else "unknown"


def _approval_input_preview(method: str, params: dict[str, Any]) -> Any:
    if method == "item/commandExecution/requestApproval":
        return params.get("command")
    if method == "item/fileChange/requestApproval":
        return params.get("path")
    if method == "mcpServer/elicitation/request":
        return params.get("message") or params.get("serverName")
    return None


def project_codex_approval_requested(request: dict[str, Any], ctx: ProjectionState) -> list[DisplayEvent]:
    """Read-only broadcast of a codex internal auto-approval BEFORE the kernel
    responds (DL7). decided_by is always the kernel; the display channel never
    carries a client->kernel write back."""
    method = str(request.get("method") or "")
    kind, tool_name = _CODEX_APPROVAL_META.get(method, (ToolKind.APPROVAL.value, method or "approval"))
    params = request.get("params") if isinstance(request.get("params"), dict) else {}
    preview, _fields, _trunc = _redact_truncate(_approval_input_preview(method, params))
    return [
        _event(
            ctx,
            EventType.APPROVAL_REQUESTED.value,
            {
                "approval_id": _approval_id(request),
                "tool_name": tool_name,
                "kind": kind,
                "input_preview": preview,
            },
        )
    ]


def project_codex_approval_resolved(
    request: dict[str, Any], decision: str | None, ctx: ProjectionState
) -> list[DisplayEvent]:
    """Read-only broadcast of the kernel's auto-approval decision AFTER it
    responds (DL7)."""
    return [
        _event(
            ctx,
            EventType.APPROVAL_RESOLVED.value,
            {
                "approval_id": _approval_id(request),
                "decided_by": "kernel",
                "decision": decision or "unknown",
            },
        )
    ]


# --- terminal repair (DL8) --------------------------------------------------


def project_terminal_repair(ctx: ProjectionState, *, cancelled: bool) -> list[DisplayEvent]:
    """Close every still-open tool call when the turn breaks abnormally so the UI
    never spins forever (design doc section 7.6). Partial buffered output is
    folded into ``output`` honestly."""
    status = ToolStatus.CANCELLED.value if cancelled else ToolStatus.ERROR.value
    out: list[DisplayEvent] = []
    for call_id, call in list(ctx.open_calls.items()):
        ctx.open_calls.pop(call_id, None)
        call.status = status
        if call.output is None:
            buffered = ctx.command_buffers.pop(call_id, None)
            if buffered:
                value, fields, trunc = _redact_truncate("".join(buffered))
                call.output = value
                call.truncated["output"] = trunc
                if fields:
                    call.redacted_fields = list(call.redacted_fields) + [
                        f"output.{f}" if f != "$" else "output" for f in fields
                    ]
            else:
                if "output" not in call.degraded_fields:
                    call.degraded_fields.append("output")
        out.append(_event(ctx, EventType.TOOL_COMPLETED.value, call.to_dict()))
    # Flush any dangling reasoning so a half-streamed thought is not lost.
    if ctx.reasoning_parts:
        value, _fields, _trunc = _redact_truncate("".join(ctx.reasoning_parts))
        ctx.reasoning_parts.clear()
        if value:
            out.append(_event(ctx, EventType.REASONING_COMPLETED.value, {"text": value}))
    return out


# --- BATCH runtime diagnostic (DL4) -----------------------------------------


def build_adapter_diagnostic(
    runtime_id: str,
    reason: str,
    *,
    seq: int = 1,
    event_id: int | str | None = None,
) -> DisplayEvent:
    """One-shot adapter diagnostic for a BATCH (non-streaming) runtime (DL4).

    A batch backend (grok/cursor/opencode/http/anthropic-api/…) does NOT emit any
    tool.* during execution; this single event honestly tells the surface why —
    so the UI shows "this runtime is batch, no live tools" instead of either
    spinning forever or fabricating tool traces (the first principle: never
    reconstruct tool traces from natural language). ``capability_tier=batch``.
    """
    if event_id is None:
        digest = hashlib.sha256(f"{runtime_id}\0{reason}".encode("utf-8")).hexdigest()[:12]
        event_id = f"adapter.diagnostic:{runtime_id}:{seq}:{digest}"
    return DisplayEvent(
        type=EventType.ADAPTER_DIAGNOSTIC.value,
        runtime_id=runtime_id,
        seq=seq,
        ts=utc_now_iso(),
        capability_tier=CapabilityTier.BATCH.value,
        payload={"streaming": False, "tool_lifecycle": False, "reason": reason},
        id=event_id,
        id_source=IdSource.SYNTHETIC.value,
    )


# --- api-agent (gemini / anthropic): post-hoc real-tool projection -----------

_AGENT_TOOL_KINDS = {
    "run_shell": ToolKind.COMMAND.value,
    "write_file": ToolKind.FILE.value,
    "read_file": ToolKind.FILE.value,
    "list_files": ToolKind.FILE.value,
}


def _agent_tool_kind(name: str) -> str:
    return _AGENT_TOOL_KINDS.get(name, ToolKind.UNKNOWN.value)


_AGENT_EXIT_CODE_RE = re.compile(r"exit_code=(-?\d+)")


def _agent_tool_status(name: str, result: Any) -> str:
    """Map a kernel tool result string to a ToolStatus.

    ``run_shell`` returns ``exit_code=N\\n<output>`` after the command RAN — a
    non-zero exit is a FAILURE (consistent with the codex projector's
    ``exitCode != 0 => error``); a pre-exec failure (empty command / timeout)
    returns ``error: ...`` instead. The other tools (write/read/list) return an
    ``error: <reason>`` string ONLY on failure; success is ``wrote N bytes``, the
    file content, or a directory listing.

    Edge: a ``read_file`` whose content itself begins with ``error:`` is
    mis-flagged as error — accepted as a rare, harmless display nuance (status
    only drives a UI icon, never governance; the real output is shown verbatim)."""
    text = str(result)
    if name == "run_shell":
        m = _AGENT_EXIT_CODE_RE.match(text)
        if m is not None:
            return ToolStatus.OK.value if m.group(1) == "0" else ToolStatus.ERROR.value
        return ToolStatus.ERROR.value  # "error: ..." pre-exec failure
    return ToolStatus.ERROR.value if text.startswith("error:") else ToolStatus.OK.value


def project_agent_tool_execution(
    call_id: str | None,
    name: str,
    args: Any,
    result: Any,
    ctx: ProjectionState,
) -> list[DisplayEvent]:
    """Post-hoc projection of ONE kernel-executed tool for an api-agent backend
    (gemini-agent / anthropic-agent).

    SuperClaw's ``_RealToolExecution`` ran the tool itself and holds BOTH the
    authoritative input (``args``) and output (``result``), so this emits a REAL
    ``tool.started`` + ``tool.completed`` card — not a fabricated trace, not a
    faked live stream. It is emitted AFTER execution returns, so there is never an
    orphan ``started`` without a ``completed`` (a tool whose escalation gate raises
    EscalationPending never reaches here and re-projects cleanly on resume).
    Input/output go through the shared redaction + truncation path (Full
    Disclosure); the started/completed pair shares one ``call_id`` so the surface
    accumulates them into a single card."""
    if isinstance(call_id, str) and call_id:
        resolved_id, source = call_id, CallIdSource.RUNTIME.value
    else:
        resolved_id, source = ctx.synth_call_id(name or "tool"), CallIdSource.PROJECTOR.value
    kind = _agent_tool_kind(name)
    tool_name = name or None
    started = ToolCall(call_id=resolved_id, call_id_source=source, kind=kind, status=ToolStatus.RUNNING.value)
    started.name = tool_name
    _finalize_tool_call(started, input_value=args, output_value=None)
    completed = ToolCall(call_id=resolved_id, call_id_source=source, kind=kind, status=_agent_tool_status(name, result))
    completed.name = tool_name
    _finalize_tool_call(completed, input_value=args, output_value=result)
    return [
        _event(ctx, EventType.TOOL_STARTED.value, started.to_dict()),
        _event(ctx, EventType.TOOL_COMPLETED.value, completed.to_dict()),
    ]


# --- clawwork (pi-fork RPC) -------------------------------------------------
# ClawWork's ``--mode rpc`` stream emits tool_execution_{start,update,end} events
# on stdout (third_party/clawwork agent/src/types.ts AgentEvent):
#   start{toolCallId, toolName, args}
#   update{toolCallId, toolName, args, partialResult}
#   end{toolCallId, toolName, result, isError}
# SuperClaw already reads this same JSONL stream for governance-block detection;
# here we ALSO project the lifecycle into canonical tool.* cards. partial tier:
# authoritative input (args) + output (result) + start/completed lifecycle, but
# ``partialResult`` is a CUMULATIVE snapshot (rpc.md: clients "replace their
# display on each update"), NOT an incremental delta -- so we deliberately do NOT
# synthesize tool.delta from it (appending would double-render). The latest
# snapshot is buffered so terminal repair can fold it into ``output`` if a tool
# never finalizes.

CLAWWORK_RUNTIME_ID = "clawwork"

_CLAWWORK_FILE_TOOLS = {"read", "write", "edit"}
_CLAWWORK_BUILTIN_TOOLS = {"grep", "find", "ls"}
_CLAWWORK_EXIT_CODE_RE = re.compile(r"exited with code (-?\d+)")


def new_clawwork_projection_state(turn_id: str | None = None) -> ProjectionState:
    # partial tier: ClawWork streams the tool lifecycle with authoritative input
    # (args) AND output (result), but NO incremental per-line deltas are
    # synthesized (partialResult is a cumulative snapshot, not a delta), mirroring
    # the claude tier's honesty.
    return ProjectionState(
        runtime_id=CLAWWORK_RUNTIME_ID, capability_tier="partial", turn_id=turn_id
    )


def _clawwork_kind(name: Any) -> str:
    if not isinstance(name, str) or not name:
        return ToolKind.UNKNOWN.value
    if name.startswith("mcp__"):
        return ToolKind.MCP.value
    if name == "bash":
        return ToolKind.COMMAND.value
    if name in _CLAWWORK_FILE_TOOLS:
        return ToolKind.FILE.value
    if name in _CLAWWORK_BUILTIN_TOOLS:
        return ToolKind.BUILTIN.value
    return ToolKind.UNKNOWN.value


def _clawwork_call_id(raw: dict[str, Any], ctx: ProjectionState) -> tuple[str, str]:
    native = raw.get("toolCallId")
    if isinstance(native, str) and native:
        return native, CallIdSource.RUNTIME.value
    return ctx.synth_call_id("tool"), CallIdSource.PROJECTOR.value


def _clawwork_text(value: Any) -> str:
    """Best-effort text extraction WITHOUT importing json (this module stays
    stdlib-light). A ClawWork tool ``result``/``partialResult`` is the documented
    shape ``{"content": [{"type":"text","text":"..."}], "details": {...}}`` (rpc.md);
    a bare string or content array is also tolerated.

    A content envelope that yields no text (empty array, image-only blocks, missing
    ``content``) returns ``""`` -- NEVER a Python ``str(dict)``/``str(list)`` repr,
    which would leak quoted dict syntax into a tool card / terminal-repair output.
    Only a genuinely scalar non-string (number/bool) degrades to ``str()``."""
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        # The documented envelope: recurse into content (a list OR, defensively, a
        # bare string). A dict with no/None content yields "" -- not a repr.
        content = value.get("content")
        return _clawwork_text(content) if content is not None else ""
    if isinstance(value, list):
        parts: list[str] = []
        for el in value:
            if isinstance(el, dict):
                text = el.get("text")
                if isinstance(text, str):
                    parts.append(text)
            elif isinstance(el, str):
                parts.append(el)
        # Empty / non-text content -> "" (honest "no text"), never str(list).
        return "\n".join(parts)
    return str(value)


def _clawwork_output_value(result: Any) -> Any:
    """The canonical tool ``output`` for a ClawWork result. The wire result is
    ``{"content": [...], "details": {...}}`` (rpc.md); surface the ``content`` array
    (same shape claude's tool_result output uses) so the card shows real tool
    output, not the harness's internal ``details`` envelope. A bare string / array
    (or any non-standard shape) passes through unchanged (Full Disclosure)."""
    if isinstance(result, dict):
        content = result.get("content")
        if isinstance(content, list):
            return content
    return result


def _clawwork_bash_exit_code(result: Any, is_error: bool) -> int | None:
    """ClawWork's bash tool throws ``Command exited with code N`` on a non-zero
    exit (core/tools/bash.ts), so the code is embedded in the errored result text
    rather than a structured field; a clean (non-error) bash result means exit 0.
    Only bash carries an exit code -- never fabricate one for other tools.

    The status line is APPENDED last, so take the LAST match: a command whose own
    output echoes e.g. ``exited with code 0`` must not spoof an earlier match into
    masking the real (appended) non-zero code."""
    if not is_error:
        return 0
    matches = _CLAWWORK_EXIT_CODE_RE.findall(_clawwork_text(result))
    return int(matches[-1]) if matches else None


def _clawwork_started_call(raw: dict[str, Any], ctx: ProjectionState) -> ToolCall:
    call_id, source = _clawwork_call_id(raw, ctx)
    name = raw.get("toolName")
    call = ToolCall(
        call_id=call_id,
        call_id_source=source,
        kind=_clawwork_kind(name),
        status=ToolStatus.RUNNING.value,
        name=name if isinstance(name, str) and name else None,
    )
    if call.name is None:
        call.degraded_fields.append("name")
    args = raw.get("args")
    if args is None:
        call.degraded_fields.append("input")
    _finalize_tool_call(call, input_value=args, output_value=None)
    return call


def _clawwork_completion_call_id(raw: dict[str, Any], ctx: ProjectionState) -> tuple[str, str]:
    """Resolve the call_id for a tool_execution_end. When the native ``toolCallId``
    is present (the normal case) use it. When it is absent (a degraded / malformed
    stream) DO NOT synthesize a fresh id -- that would orphan the matching started
    card (terminal repair then emits a phantom error) and spawn a stunted duplicate.
    Instead correlate to the most-recent still-open call, preferring the same
    toolName; only synthesize when nothing is open (mirrors the codex projector's
    _codex_completion_call_id robustness)."""
    native = raw.get("toolCallId")
    if isinstance(native, str) and native:
        return native, CallIdSource.RUNTIME.value
    name = raw.get("toolName")
    if ctx.open_calls:
        if isinstance(name, str) and name:
            for cid in reversed(list(ctx.open_calls)):
                if ctx.open_calls[cid].name == name:
                    return cid, ctx.open_calls[cid].call_id_source
        last_cid = next(reversed(ctx.open_calls))
        return last_cid, ctx.open_calls[last_cid].call_id_source
    return ctx.synth_call_id("tool"), CallIdSource.PROJECTOR.value


def _clawwork_completed_call(raw: dict[str, Any], ctx: ProjectionState) -> ToolCall:
    call_id, source = _clawwork_completion_call_id(raw, ctx)
    name = raw.get("toolName")
    # Correlate to the open start to recover input/kind/name; tool_execution_end
    # carries toolName + result but NOT args.
    call = ctx.open_calls.pop(call_id, None)
    if call is None:
        call = ToolCall(
            call_id=call_id,
            call_id_source=source,
            kind=_clawwork_kind(name),
            status=ToolStatus.RUNNING.value,
            name=name if isinstance(name, str) and name else None,
        )
        if call.name is None:
            call.degraded_fields.append("name")
    elif call.name is None and isinstance(name, str) and name:
        # The start phase lacked a name; the end phase supplies it -- recover both
        # name and kind and clear the stale degraded marker.
        call.name = name
        call.kind = _clawwork_kind(name)
        if "name" in call.degraded_fields:
            call.degraded_fields.remove("name")
    is_error = bool(raw.get("isError"))
    call.status = ToolStatus.ERROR.value if is_error else ToolStatus.OK.value
    if call.name == "bash":
        call.exit_code = _clawwork_bash_exit_code(raw.get("result"), is_error)
    result = raw.get("result")
    if result is None:
        call.degraded_fields.append("output")
    # The authoritative result is in; drop any buffered cumulative snapshot.
    ctx.command_buffers.pop(call_id, None)
    _finalize_tool_call(call, input_value=None, output_value=_clawwork_output_value(result))
    return call


def project_clawwork_event(raw: dict[str, Any], ctx: ProjectionState) -> list[DisplayEvent]:
    """Project one ClawWork ``--mode rpc`` stdout event into canonical
    DisplayEvents. Like the codex/claude projectors, message text + usage are NOT
    produced here (the emit site reads those from agent_end). Returns ``[]`` for
    non-tool events.

    ``tool_execution_update`` carries a CUMULATIVE ``partialResult`` snapshot, not
    a delta -- buffered (replace, not append) so terminal repair can fold the last
    snapshot into ``output`` if the tool never finalizes; no fake tool.delta is
    synthesized from it."""
    etype = raw.get("type")
    if etype == "tool_execution_start":
        call = _clawwork_started_call(raw, ctx)
        ctx.open_calls[call.call_id] = call
        return [_event(ctx, EventType.TOOL_STARTED.value, call.to_dict())]
    if etype == "tool_execution_update":
        native = raw.get("toolCallId")
        partial = raw.get("partialResult")
        # Buffer only under the real native id so it matches the open call's id
        # (terminal repair folds it in by that id); replace, never append.
        if isinstance(native, str) and native and partial is not None:
            ctx.command_buffers[native] = [_clawwork_text(partial)]
        return []
    if etype == "tool_execution_end":
        call = _clawwork_completed_call(raw, ctx)
        return [_event(ctx, EventType.TOOL_COMPLETED.value, call.to_dict())]
    return []


__all__ = [
    "CODEX_RUNTIME_ID",
    "CLAUDE_RUNTIME_ID",
    "GEMINI_AGENT_RUNTIME_ID",
    "ANTHROPIC_AGENT_RUNTIME_ID",
    "CLAWWORK_RUNTIME_ID",
    "ProjectionState",
    "new_codex_projection_state",
    "new_claude_projection_state",
    "new_agent_projection_state",
    "new_clawwork_projection_state",
    "project_codex_event",
    "project_codex_approval_requested",
    "project_codex_approval_resolved",
    "project_claude_event",
    "project_claude_usage",
    "project_agent_tool_execution",
    "project_clawwork_event",
    "project_terminal_repair",
    "build_adapter_diagnostic",
]
