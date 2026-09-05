"""Stream a Claude Code headless turn via ``--output-format stream-json``.

SuperClaw's legacy Claude path used ``--print --output-format json``, which
buffers the whole turn and returns once at the end (no live output). Claude
Code's headless mode also speaks a JSONL streaming protocol; this module drives
that protocol so output reaches the runtime as it is produced.

It parses the JSONL event stream from::

    claude --print --output-format stream-json --verbose --include-partial-messages ...

coalesces text deltas into bounded ``message.delta`` events, emits ``tool.*`` and
``message.completed`` through an optional ``on_event`` sink, and returns an
aggregated result for the normal WorkerResult bridge. The caller falls back to
the batch ``--output-format json`` path if streaming yields nothing parseable.

The event shapes follow Claude Code's documented stream-json format (the
Anthropic streaming event envelope):

- ``{"type":"system","subtype":"init", ...}``                          session init
- ``{"type":"stream_event","event":{"type":"content_block_delta",
       "delta":{"type":"text_delta","text":"..."}}}``                  partial text
- ``{"type":"assistant","message":{"content":[{"type":"tool_use",...}]}}`` tool use
- ``{"type":"user","message":{"content":[{"type":"tool_result",...}]}}``  tool result
- ``{"type":"result","subtype":"success","result":"...","is_error":false}`` final

Parsing is defensive: unknown event types are recorded and ignored, and a
malformed line never aborts the turn.
"""

from __future__ import annotations

import json
import os
import queue
import signal
import subprocess
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from superclaw import trace_context
from superclaw.credential_guard import scrub_operator_authority_env
from superclaw.display_projection import (
    new_claude_projection_state,
    project_claude_event,
    project_claude_usage,
    project_terminal_repair,
)


@dataclass
class ClaudeStreamResult:
    final_text: str
    output: str
    exit_code: int
    cancelled: bool = False
    timed_out: bool = False
    error: str | None = None
    is_error: bool = False
    tool_iterations: int = 0
    parsed_events: int = 0
    usage: dict[str, Any] | None = None
    raw_events: list[dict[str, Any]] = field(default_factory=list)
    started_at: float = 0.0
    finished_at: float = 0.0
    duration_seconds: float = 0.0


def run_claude_stream(
    command: list[str],
    *,
    cwd: Path,
    budget_seconds: float,
    cancel_check: Callable[[], bool] | None = None,
    on_event: Callable[[str, dict[str, Any]], None] | None = None,
    max_raw_events: int = 500,
) -> ClaudeStreamResult:
    """Run a Claude Code stream-json turn, emitting live events via on_event."""
    started_at = time.time()
    started = time.monotonic()
    deadline = started + max(0.001, budget_seconds)

    popen_kwargs: dict[str, Any] = {
        "cwd": str(cwd),
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.PIPE,
        "stderr": subprocess.PIPE,
        "text": True,
        "encoding": "utf-8",
        "errors": "replace",
        "bufsize": 1,
    }
    if os.name == "nt":
        popen_kwargs["creationflags"] = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    else:
        popen_kwargs["start_new_session"] = True
    # Propagate trace correlation to the claude stream child process. Scrub
    # operator-authority vars (route B): the agent backend never inherits the
    # operator's ambient API token (SUPERCLAW_CONTROL_TOKEN).
    popen_kwargs["env"] = scrub_operator_authority_env(trace_context.child_env())

    try:
        process = subprocess.Popen(command, **popen_kwargs)
    except OSError as exc:
        return ClaudeStreamResult(
            final_text="",
            output=f"failed to start claude: {exc}",
            exit_code=127,
            error=str(exc),
            started_at=started_at,
            finished_at=time.time(),
            duration_seconds=time.monotonic() - started,
        )

    lines: queue.Queue[str | None] = queue.Queue()
    stderr_parts: list[str] = []

    def _read_stdout() -> None:
        try:
            assert process.stdout is not None
            for line in process.stdout:
                lines.put(line)
        finally:
            lines.put(None)  # EOF sentinel

    def _read_stderr() -> None:
        try:
            assert process.stderr is not None
            for line in process.stderr:
                stderr_parts.append(line)
        except Exception:  # pragma: no cover - defensive
            pass

    stdout_thread = threading.Thread(target=_read_stdout, daemon=True)
    stderr_thread = threading.Thread(target=_read_stderr, daemon=True)
    stdout_thread.start()
    stderr_thread.start()

    raw_events: list[dict[str, Any]] = []
    text_parts: list[str] = []
    final_text = ""
    error: str | None = None
    is_error = False
    usage: dict[str, Any] | None = None
    tool_iterations = 0
    parsed_events = 0
    cancelled = False
    timed_out = False
    eof = False

    # Display Protocol projection state (DL1). claude_stream is a stateless
    # per-turn subprocess (no persistent session object at this layer), so the
    # ctx is per-turn; synthetic ids are turn-local, which the per-turn chat
    # reducer scopes correctly. Tool/usage events are canonical; the text stream
    # (message.delta/completed) stays bare so existing surfaces are untouched.
    proj_ctx = new_claude_projection_state()

    # --include-partial-messages streams a tool_use's arguments incrementally via
    # content_block_start (tool_use) + input_json_delta; the final `assistant`
    # wrapper may then carry an EMPTY input. Accumulate the streamed JSON (by
    # content-block index, mapped to the tool_use id) so the projector can recover
    # the real arguments instead of silently emitting {} (Full Disclosure).
    tool_input_parts: dict[int, list[str]] = {}
    tool_index_id: dict[int, str] = {}

    # Coalesce text deltas: bounded message.delta events, not one per token.
    delta_buffer: list[str] = []
    streamed_chars = 0
    last_flush = time.monotonic()
    flush_char_threshold = 512
    flush_interval_seconds = 0.25

    def _emit(event_type: str, payload: dict[str, Any]) -> None:
        if on_event is None:
            return
        try:
            on_event(event_type, payload)
        except Exception:  # pragma: no cover - sink is best-effort
            pass

    def _flush_delta(*, force: bool = False) -> None:
        nonlocal streamed_chars, last_flush
        if not delta_buffer:
            return
        now_m = time.monotonic()
        buffered = sum(len(p) for p in delta_buffer)
        if not force and buffered < flush_char_threshold and (now_m - last_flush) < flush_interval_seconds:
            return
        text = "".join(delta_buffer)
        delta_buffer.clear()
        streamed_chars += len(text)
        last_flush = now_m
        _emit("message.delta", {"text": text, "streamed_chars": streamed_chars})

    def _terminate() -> None:
        if process.poll() is not None:
            return
        try:
            if os.name == "nt":
                process.terminate()
            else:
                os.killpg(os.getpgid(process.pid), signal.SIGTERM)
        except (ProcessLookupError, PermissionError):  # pragma: no cover
            return
        try:
            process.wait(timeout=2.0)
        except subprocess.TimeoutExpired:
            try:
                if os.name == "nt":
                    process.kill()
                else:
                    os.killpg(os.getpgid(process.pid), signal.SIGKILL)
            except (ProcessLookupError, PermissionError):  # pragma: no cover
                pass

    def _backfill_streamed_tool_input(message: dict[str, Any]) -> None:
        """Recover tool_use input that streamed via input_json_delta but is empty
        on the final assistant wrapper. A non-empty wrapper always wins.

        Honesty (Codex r2 #2): if streamed parts existed for a tool but cannot be
        reconstructed (truncated/garbage JSON), the input is marked UNAVAILABLE
        (set to None so the projector degrades it) rather than left as a fake
        no-args ``{}``. A genuinely empty streamed object or no streamed parts at
        all keeps the ``{}`` wrapper (real no-args)."""
        if not tool_input_parts:
            return
        by_id: dict[str, str] = {}
        for idx, parts in tool_input_parts.items():
            bid = tool_index_id.get(idx)
            if bid and parts:
                by_id[bid] = "".join(parts)
        if not by_id:
            return
        for block in message.get("content", []) or []:
            if not (isinstance(block, dict) and block.get("type") == "tool_use"):
                continue
            if block.get("input"):  # non-empty wrapper is authoritative
                continue
            bid = block.get("id")
            raw = by_id.get(bid) if isinstance(bid, str) else None
            if not raw:
                continue  # no streamed parts -> genuine no-args {}
            try:
                parsed = json.loads(raw)
            except (json.JSONDecodeError, ValueError):
                parsed = None
            if isinstance(parsed, dict):
                if parsed:
                    block["input"] = parsed
                # else: streamed an empty object -> real no-args, keep {}
            else:
                # Streamed input existed but is unreconstructable -> unavailable.
                block["input"] = None

    def _handle(obj: dict[str, Any]) -> bool:
        """Process one parsed event. Returns True when the turn is finished."""
        nonlocal final_text, error, is_error, usage, tool_iterations, parsed_events
        parsed_events += 1
        if len(raw_events) < max_raw_events:
            raw_events.append(obj)
        etype = obj.get("type")
        if etype == "stream_event":
            event = obj.get("event") if isinstance(obj.get("event"), dict) else {}
            ev_type = event.get("type")
            if ev_type == "content_block_start":
                block = event.get("content_block") if isinstance(event.get("content_block"), dict) else {}
                if block.get("type") == "tool_use":
                    idx = event.get("index")
                    if isinstance(idx, int):
                        # RESET, not setdefault: a multi-tool agent loop reuses the
                        # same content-block index (0,1,...) per assistant message,
                        # so a fresh block must start clean or the next tool's
                        # partial_json concatenates onto the previous tool's leftover
                        # and parses to garbage (Codex r2 #1).
                        tool_input_parts[idx] = []
                        bid = block.get("id")
                        if isinstance(bid, str) and bid:
                            tool_index_id[idx] = bid
                        elif idx in tool_index_id:
                            # New block at a reused index with no id: drop the stale
                            # mapping so old parts can't be misattributed.
                            del tool_index_id[idx]
                return False
            if ev_type == "content_block_delta":
                delta = event.get("delta") if isinstance(event.get("delta"), dict) else {}
                dtype = delta.get("type")
                if dtype == "text_delta":
                    chunk = delta.get("text")
                    if isinstance(chunk, str) and chunk:
                        text_parts.append(chunk)
                        delta_buffer.append(chunk)
                        _flush_delta()
                elif dtype == "input_json_delta":
                    idx = event.get("index")
                    partial = delta.get("partial_json")
                    if isinstance(idx, int) and isinstance(partial, str):
                        tool_input_parts.setdefault(idx, []).append(partial)
            return False
        if etype == "assistant":
            message = obj.get("message") if isinstance(obj.get("message"), dict) else {}
            # Recover streamed-but-empty tool input before projecting (Full Disclosure).
            _backfill_streamed_tool_input(message)
            for block in message.get("content", []) or []:
                if isinstance(block, dict) and block.get("type") == "tool_use":
                    tool_iterations += 1
            # Canonical tool.started (with input) via the projector (DL1).
            for de in project_claude_event(obj, proj_ctx):
                _emit(de.type, de.to_dict())
            return False
        if etype == "user":
            # Canonical tool.completed: correlate to the open tool_use for
            # name/kind and carry the tool_result content (the closed gap).
            for de in project_claude_event(obj, proj_ctx):
                _emit(de.type, de.to_dict())
            return False
        if etype == "result":
            result_text = obj.get("result")
            if isinstance(result_text, str):
                final_text = result_text
            is_error_flag = bool(obj.get("is_error"))
            if is_error_flag:
                is_error = True
                error = obj.get("subtype") or "claude result reported is_error"
            if isinstance(obj.get("usage"), dict):
                usage = obj.get("usage")
            _flush_delta(force=True)
            # Usage honesty is the emit behaviour (DL3): when the stream carries
            # usage, surface it as a canonical usage event.
            if isinstance(usage, dict):
                for de in project_claude_usage(usage, proj_ctx):
                    _emit(de.type, de.to_dict())
            # Text stream stays bare (design doc §9 "保持现有 message.delta 不变").
            if final_text:
                _emit("message.completed", {"text": final_text})
            return True
        return False

    while True:
        now = time.monotonic()
        _flush_delta()  # time-based flush even when idle
        if cancel_check and cancel_check():
            cancelled = True
            _terminate()
            break
        if now >= deadline:
            timed_out = True
            _terminate()
            break
        try:
            line = lines.get(timeout=0.1)
        except queue.Empty:
            if process.poll() is not None and lines.empty():
                eof = True
                break
            continue
        if line is None:
            eof = True
            break
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            if len(raw_events) < max_raw_events:
                raw_events.append({"non_json": line[:500]})
            continue
        if isinstance(obj, dict) and _handle(obj):
            break

    _flush_delta(force=True)

    # Drain any final events already buffered (e.g. result arrived right at EOF).
    if eof:
        while True:
            try:
                line = lines.get_nowait()
            except queue.Empty:
                break
            if line is None:
                continue
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(obj, dict):
                _handle(obj)
        _flush_delta(force=True)

    # Terminal repair (DL8): a tool_use with no matching tool_result (turn
    # cancelled/timed out / claude exited mid-tool) is closed so the UI never
    # spins forever. cancel/timeout -> cancelled; otherwise error.
    for de in project_terminal_repair(proj_ctx, cancelled=(cancelled or timed_out)):
        _emit(de.type, de.to_dict())

    if not (cancelled or timed_out):
        try:
            process.wait(timeout=5.0)
        except subprocess.TimeoutExpired:  # pragma: no cover - defensive
            _terminate()

    exit_code = process.returncode if process.returncode is not None else 0
    if cancelled:
        exit_code = 130
    elif timed_out:
        exit_code = 124
    elif is_error and exit_code == 0:
        exit_code = 1

    if not final_text:
        final_text = "".join(text_parts).strip()

    stderr_text = "".join(stderr_parts).strip()
    output = final_text
    if stderr_text and (exit_code != 0 or not final_text):
        output = (output + "\n" + stderr_text).strip() if output else stderr_text

    return ClaudeStreamResult(
        final_text=final_text,
        output=output,
        exit_code=exit_code,
        cancelled=cancelled,
        timed_out=timed_out,
        error=error,
        is_error=is_error,
        tool_iterations=tool_iterations,
        parsed_events=parsed_events,
        usage=usage,
        raw_events=raw_events,
        started_at=started_at,
        finished_at=time.time(),
        duration_seconds=time.monotonic() - started,
    )
