from __future__ import annotations

import json
import logging
import os
import re
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from superclaw.chat_prompt import (
    build_chat_prompt_envelope,
    format_chat_history as _format_chat_history,
)
from superclaw.models import GoalSpec, RunSession, TaskNode, WorkerRole, _id
from superclaw.permissions import PRESET_TO_MODE
from superclaw.runtime import codex_cli_mode, desktop_toolchain_env, find_codex_executable, redact_secrets
from superclaw.runtime_config import applied_runtime_environment

SHELL_MODES = {"auto", "chat", "delivery"}
# Backends that answer direct chat over the bespoke codex exec channel
# (--output-last-message one-shot). Every other backend answers over its own
# kernel run() channel — same registry, same fail-closed gates.
CODEX_DIRECT_CHAT_BACKENDS = {"codex", "codex-app-server"}
# Default permission mode for a chat turn when the caller does not pass one.
# Derived from the "ask" preset projection (PRESET_TO_MODE["ask"]) so it can
# never drift from the kernel contract. Under the max-permission doctrine that
# is bypassPermissions: the runtime is a pure execution engine handed its max
# permission (a conservative headless mode like acceptEdits silently auto-DENIES
# tools that need approval instead of escalating). A chat turn is a NATIVE
# runtime turn — the user's selected permission preset (ask / allow) passes
# through to the runtime's own sandbox mapping, exactly like a delivery run.
# Low-trust runs are still floored read-only by ContainmentPolicy, independent
# of this default. Every registered runtime is a first-class chat substrate
# (unified-task-entry).
DEFAULT_CHAT_PERMISSION_MODE = PRESET_TO_MODE["ask"]


def _skill_create_enabled() -> bool:
    """Whether conversational skill creation (directive + harvest) is on.

    Default ON; ``SUPERCLAW_SKILL_CREATE=0`` disables it so an operator can turn
    off the injected directive + proposal harvesting entirely.
    """
    return os.environ.get("SUPERCLAW_SKILL_CREATE", "1").strip().lower() not in {"0", "false", "no", "off"}


# Intent understanding is the RUNTIME LLM's job, NOT a keyword gate (owner
# decision). The short SKILL_CREATION_DIRECTIVE is injected on every chat turn
# (when the feature is enabled); the model decides — by understanding the
# conversation — whether the user actually wants to create a skill, and only then
# emits a proposal block. SuperClaw harvests whatever it emits and registers it
# through the governed pipeline (prose-only, no executable), surfaces a visible
# "✓ Created skill X" (deletable), and the feature is env-disableable. There is
# deliberately no brittle regex deciding intent.


_PLUGIN_MARKER_RE = re.compile(r"(?:^|\s)@?plugin:([A-Za-z0-9][A-Za-z0-9_.-]*)", re.IGNORECASE)
_SKILL_MARKER_RE = re.compile(r"(?:^|\s)@?skill:([A-Za-z0-9][A-Za-z0-9_.-]*)", re.IGNORECASE)


def extract_plugin_id(content: str) -> str | None:
    """Return the explicitly addressed plugin id from a chat turn, if present."""
    match = _PLUGIN_MARKER_RE.search(content.strip())
    if not match:
        return None
    return match.group(1)


def extract_skill_id(content: str) -> str | None:
    """Return the explicitly addressed skill id from a chat turn, if present."""
    match = _SKILL_MARKER_RE.search(content.strip())
    if not match:
        return None
    return match.group(1)


# --- Unified task entry: route = one runtime turn + optional overlays ---------
# parse_chat_route supersedes classify_intent's role. Instead of forking into
# chat/task/delivery execution paths, every turn is a single runtime turn; the
# only variable is which (if any) overlays it carries. @plugin / @skill are
# additive overlays projected onto the same agent-runtime path; @delivery is a
# DEPRECATED legacy marker (delivery becomes an Agent company, not an entry
# intent). See docs/unified-task-entry.md.

OverlayKind = Literal["plugin", "skill"]


@dataclass(frozen=True)
class OverlayRef:
    kind: OverlayKind
    id: str


@dataclass(frozen=True)
class ChatRoutePlan:
    """How to run one chat turn: always a runtime turn, plus optional overlays.

    - ``overlays`` empty  -> pure native runtime turn (zero-overhead chat).
    - ``overlays`` present -> project those plugin/skill tools onto the runtime.
    - ``delivery_legacy``  -> @delivery was used; deprecated, surface a warning.
    - ``forced_mode``      -> an explicit non-auto shell mode (e.g. delivery).
    """

    overlays: tuple[OverlayRef, ...] = ()
    delivery_legacy: bool = False
    forced_mode: str | None = None

    @property
    def has_overlay(self) -> bool:
        return bool(self.overlays)

    @property
    def plugin_ids(self) -> tuple[str, ...]:
        return tuple(ref.id for ref in self.overlays if ref.kind == "plugin")

    @property
    def skill_ids(self) -> tuple[str, ...]:
        return tuple(ref.id for ref in self.overlays if ref.kind == "skill")


def parse_chat_route(content: str, *, mode: str) -> ChatRoutePlan:
    """Parse a turn into a single runtime turn + overlays (no business intent).

    This is the unified-entry replacement for ``classify_intent``: it never
    decides whether to run an orchestrator pipeline — it only reports what
    overlays the turn carries and whether the deprecated @delivery marker is
    present.
    """
    selected_mode = mode.strip().lower()
    if selected_mode not in SHELL_MODES:
        raise ValueError(f"invalid shell mode: {mode}")

    text = content.strip()
    lowered = text.lower()

    delivery_legacy = (
        selected_mode == "delivery"
        or "@delivery" in lowered
        or lowered.startswith("/delivery")
        or " /delivery" in lowered
    )

    overlays: list[OverlayRef] = []
    plugin_id = extract_plugin_id(text)
    if plugin_id:
        overlays.append(OverlayRef(kind="plugin", id=plugin_id))
    skill_id = extract_skill_id(text)
    if skill_id:
        overlays.append(OverlayRef(kind="skill", id=skill_id))

    return ChatRoutePlan(
        overlays=tuple(overlays),
        delivery_legacy=delivery_legacy,
        forced_mode=selected_mode if selected_mode != "auto" else None,
    )


def classify_intent(content: str, *, mode: str) -> str:
    """Route a turn to one of: 'chat', 'task', or 'delivery'.

    DEPRECATED legacy projection (see docs/unified-task-entry.md): the real
    router is ``parse_chat_route`` — one runtime turn + optional overlays. This
    function only projects that plan back onto the legacy intent strings so the
    CLI shell and older callers keep working while they migrate:

        forced (non-auto) mode  -> that mode
        delivery legacy marker  -> "delivery"   (future: Agent company)
        any overlay (@plugin / @skill) -> "task" (an overlay turn, NOT
                                          necessarily a *plugin* turn — callers
                                          must not assume a plugin id exists)
        otherwise               -> "chat"       (pure native runtime turn)

    Because both the CLI shell and the API project from the same plan, a marker
    like ``@skill:<id>`` routes identically on every surface.
    """
    plan = parse_chat_route(content, mode=mode)
    if plan.forced_mode is not None:
        return plan.forced_mode
    if plan.delivery_legacy:
        return "delivery"
    if plan.has_overlay:
        return "task"
    return "chat"


def format_chat_history(messages: list[Any], *, max_messages: int = 20, max_chars: int = 6000) -> str:
    """Render recent chat turns as a transcript block (canonical formatter).

    Used wherever a surface replays conversation context into a runtime that has
    no native memory of it: CLI delivery turns, API direct chat, and the
    post-backend-switch handoff (the new runtime inherits nothing natively).
    """
    return _format_chat_history(messages, max_messages=max_messages, max_chars=max_chars)


def direct_chat_prompt(content: str, *, context_text: str = "", history: str = "", tool_contract: str = "") -> str:
    """Render a chat turn for the runtime, as natively as possible.

    No persona, no behavioral constraints, no delivery redirection: a chat turn
    IS a native runtime turn — what the runtime may do is governed by the
    permission mode passed through to its own sandbox, not by prompt text. The
    only additions are conversation replay (for runtimes without native session
    memory) and user-selected context references; with neither, the user's
    message passes through verbatim.
    """
    return build_chat_prompt_envelope(
        content,
        history_text=history,
        context_text=context_text,
        tool_contract=tool_contract,
    ).prompt


_RESULT_EVENT_RE = re.compile(r'\{\s*"type"\s*:\s*"result"')

# Terminal escape sequences leak into chat when a CLI writes tty-styled logs
# (e.g. grok's Rust tracing lines: \x1b[2m<timestamp>\x1b[0m \x1b[31mERROR...).
# Browsers don't interpret the ESC byte, so the user sees `[2m...[0m` garbage.
# Coverage: CSI (colors/cursor), OSC (hyperlinks/titles, BEL- or ST-terminated),
# DCS/SOS/PM/APC blocks, two-char Fe escapes, and any stray ESC remnant.
# Stripped ONLY at the user-visible chat boundary — artifacts and transcripts
# keep the original bytes for forensics.
_ANSI_ESCAPE_RE = re.compile(
    # OSC/DCS payloads stop at newlines: their terminator is OPTIONAL here (a
    # crashed CLI can emit an unterminated sequence), so an unbounded payload
    # class would swallow every real line that follows. Terminals abort these
    # sequences at a newline anyway; leaking an odd payload fragment beats
    # eating diagnostics.
    r"\x1b\[[0-?]*[ -/]*[@-~]"                  # CSI ... final byte
    r"|\x1b\][^\x07\x1b\r\n]*(?:\x07|\x1b\\)?"  # OSC ... BEL or ST
    r"|\x1b[PX^_][^\x1b\r\n]*(?:\x1b\\)?"       # DCS / SOS / PM / APC ... ST
    r"|\x1b[@-_]"                               # remaining two-char Fe escapes
    r"|\x1b"                                    # bare ESC remnant
)


def strip_ansi_sequences(text: str) -> str:
    """Remove terminal escape sequences from user-facing chat text.

    Matches real ESC bytes only — literal ``\\x1b`` text (e.g. in a code block
    discussing ANSI codes) is untouched.
    """
    return _ANSI_ESCAPE_RE.sub("", text)


def _extract_direct_chat_response(output: str) -> str:
    """Normalize a backend run() output into a chat reply.

    Batch agent CLIs differ in envelope: claude --output-format json wraps the
    reply in {"result": ...}; CLIs that stream worker output may carry the
    superclaw_worker_result marker line. Strip both — plus any terminal escape
    sequences — so the chat surface shows only the reply text.
    """
    text = strip_ansi_sequences(output or "").strip()
    if not text:
        return ""
    payload = None
    if text.startswith("{") or text.startswith("["):
        # run_command() output is stdout + stderr (+ a failure-classification
        # line on nonzero exit), so the JSON envelope may carry a trailing
        # non-JSON tail. raw_decode parses the leading JSON value and ignores
        # the tail — otherwise a failed claude turn surfaces the init event's
        # tool list instead of the actual result text (e.g. "Not logged in").
        try:
            payload, _end = json.JSONDecoder().raw_decode(text)
        except ValueError:
            payload = None
    if payload is None:
        # Salvage path: WorkerResult.output keeps only the TAIL of large
        # outputs (PRIMARY_EVIDENCE_TEXT_LIMIT), so the event array's opening
        # bracket may be gone while the trailing result object survived. Find
        # the last result-event object in the text and decode just that.
        for match in reversed(list(_RESULT_EVENT_RE.finditer(text))):
            try:
                candidate, _end = json.JSONDecoder().raw_decode(text[match.start():])
            except ValueError:
                continue
            if isinstance(candidate, dict) and isinstance(candidate.get("result"), str) and candidate["result"].strip():
                payload = candidate
                break
    if isinstance(payload, list):
        # claude CLI 2.x --output-format json emits an event ARRAY; the
        # trailing result object carries the reply text.
        for item in reversed(payload):
            if isinstance(item, dict) and isinstance(item.get("result"), str) and item["result"].strip():
                text = item["result"].strip()
                break
    elif isinstance(payload, dict):
        for key in ("result", "response", "final_text", "text"):
            value = payload.get(key)
            if isinstance(value, str) and value.strip():
                text = value.strip()
                break
    lines = [line for line in text.splitlines() if not line.strip().startswith("superclaw_worker_result ")]
    # Strip AGAIN after envelope extraction: a JSON string value carries ESC
    # as a backslash-u escape ("\\u001b"), which json decode turns back into
    # a real ESC byte AFTER the entry-point strip already ran.
    return strip_ansi_sequences("\n".join(lines)).strip()


def _failed_chat_turn(backend: str, failure_reason: str) -> dict[str, Any]:
    return {"intent": "chat", "backend": backend, "status": "failed", "failure_reason": failure_reason}


_AUTH_FAILURE_MARKERS = (
    "401",
    "authenticate",
    "not logged in",
    "unauthenticated",
    "invalid auth",
    "credentials",
    "please run",
    "/login",
)


def friendly_chat_failure(failure_reason: str | None, backend: str) -> str:
    """Turn a raw runtime failure into a user-actionable message.

    The dominant real-world case is an expired login surfacing as an opaque
    ``401`` — the user must be told to re-authenticate, not stare at a stack of
    HTTP codes. The raw reason is kept appended for debugging. Non-auth failures
    pass through unchanged.
    """
    reason = (failure_reason or "chat turn failed").strip()
    lowered = reason.lower()
    if any(marker in lowered for marker in _AUTH_FAILURE_MARKERS):
        if backend == "claude":
            return f"Claude Code 登录已失效，请在终端运行 `claude` 重新登录后再试。\n（原始错误：{reason}）"
        return f"{backend} 认证失败，请检查该后端的登录或密钥后再试。\n（原始错误：{reason}）"
    return reason


_FAILURE_DETAIL_LIMIT = 240
_FAILURE_DETAIL_STDERR_BUDGET = 140


def _squeeze_middle(text: str, limit: int) -> str:
    """Cap ``text`` at ``limit`` chars keeping BOTH ends, eliding the middle.

    Failure text carries its actionable part at either end — "fatal: ..."
    first line followed by a stack trace, or a banner followed by the error —
    so any single-ended truncation (head-only or tail-only) systematically
    loses one of the two shapes.
    """
    if len(text) <= limit:
        return text
    head_len = (limit - 5) // 2
    tail_len = limit - 5 - head_len
    return f"{text[:head_len].rstrip()} ... {text[-tail_len:].lstrip()}"


def _compose_failure_detail(primary: str, stderr_text: str | None) -> str:
    """One-line failure detail under the display budget, with the stderr
    fragment GUARANTEED to survive truncation.

    A naive append-then-truncate loses the stderr fatal whenever the primary
    detail (a long JSON result, a partial last-message) fills the budget on
    its own — the same information loss the append was meant to fix. So the
    stderr fragment reserves its slice of the budget first and the primary
    yields whatever room is left; every slice keeps both ends via
    _squeeze_middle. Inputs are ANSI-stripped here; secret redaction is the
    caller's responsibility (kernel streams arrive redacted).
    """
    primary_line = " ".join(strip_ansi_sequences(primary or "").split())
    stderr_line = " ".join(strip_ansi_sequences(stderr_text or "").split())
    if not stderr_line:
        return _squeeze_middle(primary_line, _FAILURE_DETAIL_LIMIT)
    if not primary_line:
        return _squeeze_middle(stderr_line, _FAILURE_DETAIL_LIMIT)
    # Dedup decides on the KEPT slice, never the full primary: a plain merged
    # output carries stderr at its END, so checking the full string would drop
    # the stderr segment right before truncation cuts that very end off.
    kept_primary = _squeeze_middle(primary_line, _FAILURE_DETAIL_LIMIT)
    if stderr_line in kept_primary:
        return kept_primary
    sep = " | stderr: "
    stderr_part = _squeeze_middle(stderr_line, _FAILURE_DETAIL_STDERR_BUDGET)
    room = max(16, _FAILURE_DETAIL_LIMIT - len(sep) - len(stderr_part))
    primary_part = _squeeze_middle(primary_line, room)
    return f"{primary_part}{sep}{stderr_part}"


def _execute_generic_direct_chat_turn(
    *, content: str, backend: str, repo: Path, budget_seconds: int, context_text: str, history: str,
    model: str | None, effort: str | None = None, permission_mode: str | None = None, event_sink=None, protected_cwd: bool = False,
    skill_ids: tuple[str, ...] = (), available_skill_catalog: str = "",
) -> dict[str, Any]:
    """Answer a direct chat turn over an arbitrary registered backend.

    A chat turn is a NATIVE runtime turn: it reuses the kernel
    WorkerBackend.run() channel (same registry, executable resolution, model
    fail-closed rules, and secret redaction as delivery runs) and passes the
    user's permission mode straight through — each backend maps the mode onto
    its own sandbox/approval mechanism (the same mapping a delivery run uses),
    so "ask" vs "allow" is decided by the user, not hardcoded here. The mode is
    always explicit (never ``None``): ``policy=None`` is not uniform across the
    registry (e.g. bobo runs ``--full-auto``), so the default chat posture is
    ``DEFAULT_CHAT_PERMISSION_MODE`` — the "ask" preset projection.

    ``@skill`` overlays ARE honored here: ``skill_ids`` is threaded into
    ``WorkerLimits`` and the backend resolves them against its own capability
    (prose projection into its run-scoped skill dir / tool-skill fail-closed). A
    backend that declares no ``skill_capability`` refuses the turn rather than
    dropping the overlay. (``@plugin`` overlays still route through the governed
    MCP proxy elsewhere.)
    """
    # Imported lazily: the codex fast path must not pay for the full backend
    # registry import, and tests monkeypatch superclaw.backends.default_backends.
    from superclaw.backends import WorkerLimits, default_backends
    from superclaw.runtime import PermissionPolicy

    registry = default_backends()
    worker = registry.get(backend)
    if worker is None:
        known = ", ".join(sorted(registry))
        return _failed_chat_turn(backend, f"direct_chat_unsupported: unknown backend {backend}; known backends: {known}")
    availability = worker.available()
    if not availability.available:
        return _failed_chat_turn(backend, f"backend {backend} is not available: {availability.reason or 'unavailable'}")

    # @skill overlays are honored by the backend (it projects prose into its own
    # run-scoped skill dir / fail-closes a tool-skill it cannot host). A backend
    # that does not declare a skill capability cannot honor @skill, so refuse the
    # turn rather than silently dropping the overlay (fail-closed; no silent no-op).
    if skill_ids:
        # Accept either a method (the current convention, lazy-imported to keep
        # backends.py import-light) or a property / attribute, so a future backend
        # that declares skill_capability as a value is not mis-read as "no support".
        cap_attr = getattr(worker, "skill_capability", None)
        capability = cap_attr() if callable(cap_attr) else cap_attr
        if capability is None:
            return _failed_chat_turn(
                backend,
                f"skill_overlay_unsupported: backend {backend} does not support @skill overlays",
            )

    prompt = direct_chat_prompt(content, context_text=context_text, history=history)
    # Conversational create: append the short directive (when the feature is on)
    # so the runtime LLM — understanding the conversation — hands a governed
    # proposal back instead of writing a file itself. Intent is the LLM's call,
    # not a keyword gate. Runtime-agnostic (works on ClawWork too). Excluded on an
    # explicit @skill USE turn (skill_ids threaded) — that is a USE turn, never a
    # create turn (overlay-derived, not keyword-based; matches the codex path's
    # intent != "task" exclusion).
    skill_create_turn = _skill_create_enabled() and not skill_ids
    if skill_create_turn:
        from superclaw.skill_author import SKILL_CREATION_DIRECTIVE

        prompt = f"{prompt}\n\n{SKILL_CREATION_DIRECTIVE}"
    goal = GoalSpec(
        title="SuperClaw direct chat",
        description=prompt,
        acceptance_criteria=[],
        metadata={"chat_turn_intent": "chat"},
    )
    task = TaskNode(task_id=_id("task"), role=WorkerRole.IMPLEMENT, title="direct chat turn")
    session = RunSession(goal_id=goal.goal_id)
    effective_mode = (permission_mode or "").strip() or DEFAULT_CHAT_PERMISSION_MODE
    # Choke point (avoids per-endpoint drift): when no caller sink is wired — the
    # synchronous /api/chat/turn and /api/chat/direct endpoints — collect the
    # backend's display events HERE so the JSON result carries them. An api-agent
    # that ran real tools is then NEVER silent on a sync endpoint either (it
    # returns ``display_events`` instead of streaming them). A streaming caller
    # passes its own event_sink and gets them live; we then don't double-collect.
    _display_collected: list[dict[str, Any]] = []
    # Capture the last USAGE event the backend projects so the JSON result carries
    # the same token tally the live Display Protocol stream shows — whether or not
    # a streaming caller wired its own sink (which would otherwise bypass the sync
    # collector below). The API persists this on the assistant message so the chat
    # metering row survives a reload, byte-for-byte with the live display.
    _last_usage: dict[str, Any] | None = None

    def _sink(et: str, p: Any) -> None:
        nonlocal _last_usage
        if et == "usage" and isinstance(p, dict) and isinstance(p.get("usage"), dict):
            _last_usage = p["usage"]
        if event_sink is not None:
            event_sink(et, p)
        else:
            _display_collected.append({"type": et, "payload": p})
    with applied_runtime_environment():
        with tempfile.TemporaryDirectory(prefix="superclaw-chat-") as temp_dir:
            limits = WorkerLimits(
                repo_path=repo,
                artifact_dir=Path(temp_dir),
                budget_seconds=max(1, int(budget_seconds)),
                # Always explicit (never None) — see the docstring.
                permission_policy=PermissionPolicy(mode=effective_mode),
                model_override=(model or "").strip() or None,
                # Per-turn reasoning-effort; the backend validates + fails closed if
                # it does not support effort (same channel as a delivery run).
                effort_override=(effort or "").strip() or None,
                # Set by the (store-aware) caller for an inode-pinned real-folder
                # project, so the backend won't re-create a deleted/swapped cwd.
                protected_cwd=protected_cwd,
                # Display event sink (chat channel): an api-agent backend
                # (gemini/anthropic, surfaces_live_tools=True) projects its real
                # tool cards through this. Streaming callers pass their own sink;
                # sync callers get the choke-point collector (_sink) so the result
                # still carries the tool cards (never silent execution).
                event_sink=_sink,
                # @skill overlays for this turn; the backend resolves them against
                # its own capability (prose projection / tool-skill fail-closed).
                skill_ids=tuple(skill_ids),
                # Semantic-discovery catalog (no explicit @skill); inlined into
                # TOOL_CONTRACT so the model can apply a relevant skill on its own.
                available_skill_catalog=available_skill_catalog,
            )
            result = worker.run(task, goal, session, limits)
            # The chat reply comes from the stdout-only channel: stderr is
            # where CLIs put log noise (e.g. grok's ANSI-colored tracing
            # lines), so the merged ``output`` is never a success reply.
            # ``stdout=None`` (a legacy/direct WorkerResult construction)
            # falls back to the merged output; an EMPTY stdout stays empty —
            # a CLI that wrote only stderr on exit 0 did not answer.
            response_source = result.stdout if result.stdout is not None else result.output
            # WorkerResult fields keep only the tail of large outputs; the
            # full streams live in the transcript artifact (inside temp_dir,
            # so read it before the context manager deletes it). Synthetic
            # transcripts carry only the merged ``output`` — no stdout key.
            if getattr(result, "output_truncated", False) and getattr(result, "transcript_path", None):
                try:
                    transcript = json.loads(Path(result.transcript_path).read_text(encoding="utf-8"))
                    full_stdout = transcript.get("stdout")
                    if not isinstance(full_stdout, str) or not full_stdout.strip():
                        full_stdout = transcript.get("output")
                    if isinstance(full_stdout, str) and full_stdout.strip():
                        response_source = full_stdout
                except (OSError, ValueError):
                    pass

    def _finalize(d: dict[str, Any]) -> dict[str, Any]:
        # Sync endpoints (no caller sink): attach the collected tool cards so a
        # real-tool api-agent turn is visible even when it ultimately FAILED (tools
        # may have run before the failure — never silent). Streaming callers already
        # got them live, so don't duplicate into the result.
        out = d
        if _last_usage is not None and out.get("usage") is None:
            out = {**out, "usage": _last_usage}
        if event_sink is None and _display_collected:
            out = {**out, "display_events": _display_collected}
        return out

    response = _extract_direct_chat_response(response_source)
    if result.timed_out:
        return _finalize(_failed_chat_turn(backend, f"timeout: {backend} direct chat exceeded {int(budget_seconds)}s"))
    if result.cancelled:
        return _finalize(_failed_chat_turn(backend, f"{backend} direct chat was cancelled"))
    if result.exit_code != 0:
        # Failure detail starts from the FULL-stream view (run_command's merged
        # output): _failure_marker verdicts and CLI diagnostics ("Not logged
        # in", auth hints) often live on stderr, so consulting the stdout-only
        # reply first would let a harmless stdout banner short-circuit the real
        # error away.
        detail_source = _extract_direct_chat_response(result.output) or response
        marker_line = next(
            (line for line in result.output.splitlines() if line.startswith("SuperClaw classified backend output as failure:")),
            None,
        )
        if marker_line and marker_line not in detail_source:
            detail_source = f"{marker_line} | {detail_source}" if detail_source else marker_line
        # The extraction is envelope-aware and therefore LOSSY for diagnostics:
        # a JSON envelope on stdout makes raw_decode keep the leading JSON and
        # drop the tail — including a stderr fatal. _compose_failure_detail
        # appends the stderr tail with its own reserved budget slice so it
        # survives even when the primary detail fills the display limit.
        detail = _compose_failure_detail(detail_source, result.stderr)
        return _finalize(_failed_chat_turn(backend, f"{backend} direct chat failed with exit code {result.exit_code}: {detail}"))
    if not response and isinstance(result.stderr, str) and result.stderr.strip():
        # exit 0 but nothing on stdout: surface a diagnostic failure instead
        # of an empty bubble — and never promote stderr to a reply.
        tail = _compose_failure_detail("", result.stderr)
        return _finalize(_failed_chat_turn(backend, f"{backend} returned no reply on stdout (exit 0); stderr: {tail}"))
    # Conversational create: harvest any governed skill proposal the runtime
    # emitted (per the injected directive), register it through the SuperClaw
    # kernel, strip the raw block from the displayed reply, and report what landed.
    # Done only on the success path, AFTER the governance decision (never strip as
    # a standalone sanitizer). Registration uses the default store (the user's).
    created_skills: list[str] = []
    if skill_create_turn and response:
        from superclaw.skill_author import (
            created_skill_receipt,
            harvest_skill_proposals,
            strip_skill_proposals,
        )

        registered, skill_errors = harvest_skill_proposals(response)
        if registered or skill_errors:
            response = strip_skill_proposals(response)
            created_skills = [record.slug for record in registered]
            if created_skills:
                response = (response + "\n\n" + created_skill_receipt(created_skills)).strip()
            if skill_errors:
                response = (response + "\n\n⚠ Skill not created: " + "; ".join(skill_errors)).strip()
    result_payload: dict[str, Any] = {
        "intent": "chat",
        "backend": backend,
        "status": "completed",
        "response": response,
    }
    if created_skills:
        result_payload["created_skills"] = created_skills
    return _finalize(result_payload)


# Backends whose chat turns ride the runtime's OWN durable session (no transcript
# replay). The API dispatches each to its executor via NATIVE_SESSION_CHAT_EXECUTORS.
NATIVE_SESSION_CHAT_BACKENDS = {"claude", "clawwork"}

CATCH_UP_HEADER = "[Context synchronized from another runtime — the conversation continued elsewhere while this session was inactive:]"


def _is_sync_worthy(message: Any) -> bool:
    """Only REAL dialogue syncs across runtimes (advisor B2): system rows
    (handoff markers) and run-dispatch placeholders (``run_id=... status=...``)
    are SuperClaw plumbing — feeding them to a model reads as user intent."""
    role = getattr(message, "role", "")
    if role not in ("user", "assistant"):
        return False
    # A failed assistant turn is surfaced to the user but is not conversation —
    # never sync it into a runtime's native session.
    if getattr(message, "status", None) == "failed":
        return False
    content = str(getattr(message, "content", "") or "").strip()
    if not content:
        return False
    return not content.startswith("run_id=")


def unseen_messages_since(messages: list[Any], last_seen_message_id: str | None) -> list[Any]:
    """Messages a runtime has NOT seen, by stable message id.

    An unknown/absent ``last_seen_message_id`` (legacy binding, edited
    transcript) degrades safely to "nothing seen" — the caller syncs the full
    dialogue rather than silently skipping context.
    """
    if last_seen_message_id:
        for index, message in enumerate(messages):
            if getattr(message, "message_id", None) == last_seen_message_id:
                return [m for m in messages[index + 1:] if _is_sync_worthy(m)]
    return [m for m in messages if _is_sync_worthy(m)]


def build_catch_up_block(messages: list[Any], last_seen_message_id: str | None) -> str:
    """A one-time context block covering the turns this runtime missed while
    the conversation ran on another runtime (the cross-runtime handoff gap).
    Empty when the runtime is already up to date."""
    unseen = unseen_messages_since(messages, last_seen_message_id)
    if not unseen:
        return ""
    body = format_chat_history(unseen)
    if not body.strip():
        return ""
    return f"{CATCH_UP_HEADER}\n{body}"


def execute_claude_native_chat_turn(
    *,
    content: str,
    repo: Path,
    budget_seconds: int,
    model: str | None = None,
    effort: str | None = None,
    permission_mode: str | None = None,
    native_session_id: str,
    is_resume: bool,
    history_seed: str = "",
    catch_up: str = "",
    context_text: str = "",
    on_event: Any = None,
) -> dict[str, Any]:
    """One NATIVE Claude Code chat turn — the runtime's own session memory.

    Unified chat entry: a SuperClaw chat session binds to one claude session
    (``--session-id`` on the first turn, ``--resume`` afterwards), so the
    conversation continues inside claude's native memory — no transcript
    replay. Streaming rides claude's ``stream-json`` (message.delta /
    message.completed via ``on_event``, the same event contract codex inline
    chat uses). The user's permission preset passes through to claude's own
    ``--permission-mode``. ``history_seed`` is injected ONCE when an existing
    SuperClaw conversation gets its first native claude session (mid-chat
    runtime switch), never on resumed turns. ``catch_up`` carries the turns
    this session MISSED while the chat ran on another runtime (switch-away /
    switch-back): injected ahead of the user's message on a resumed turn, then
    the binding's last-seen advances so it is never repeated.
    """
    from superclaw.backends import ClaudeCliBackend
    from superclaw.claude_stream import run_claude_stream

    backend = ClaudeCliBackend()
    resolved = backend._resolve_executable()
    executable = resolved[0] if isinstance(resolved, tuple) else resolved
    if not executable:
        return _failed_chat_turn("claude", "claude executable not found; configure SUPERCLAW_CLAUDE_EXECUTABLE")

    effort_value = (effort or "").strip().lower()
    if effort_value and effort_value not in ClaudeCliBackend.EFFORT_LEVELS:
        # Same fail-loud rule as the kernel ClaudeCliBackend: reject a typo'd level
        # rather than handing claude a malformed --effort it rejects generically.
        return _failed_chat_turn(
            "claude",
            f"EFFORT_INVALID: effort={effort_value!r} is not one of "
            f"{'/'.join(ClaudeCliBackend.EFFORT_LEVELS)}; fix or clear the effort selection",
        )

    pieces: list[str] = []
    if not is_resume and history_seed.strip():
        pieces.append(
            "Conversation so far (oldest first; carried over from before this native session started):\n"
            + history_seed.strip()
        )
    if is_resume and catch_up.strip():
        pieces.append(catch_up.strip())
    if context_text.strip():
        pieces.append("Context References:\n" + context_text.strip())
    pieces.append(content)
    prompt = "\n\n".join(pieces)

    mode = (permission_mode or "").strip() or DEFAULT_CHAT_PERMISSION_MODE
    command = [
        str(executable),
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--permission-mode",
        mode,
    ]
    model_value = (model or "").strip()
    if model_value:
        command.extend(["--model", model_value])
    if effort_value:
        command.extend(["--effort", effort_value])
    command.extend(["--resume" if is_resume else "--session-id", native_session_id])
    command.append(prompt)

    with applied_runtime_environment():
        result = run_claude_stream(
            command,
            cwd=repo,
            budget_seconds=float(max(1, int(budget_seconds))),
            on_event=on_event,
        )

    if result.timed_out:
        return _failed_chat_turn("claude", f"timeout: claude native chat exceeded {int(budget_seconds)}s")
    if result.exit_code != 0 or result.is_error:
        detail = (result.final_text or result.error or result.output or "").replace("\n", " ")
        if len(detail) > 240:
            detail = detail[:237].rstrip() + "..."
        failed = _failed_chat_turn("claude", f"claude native chat failed (exit {result.exit_code}): {detail}")
        # A broken resume must not pin the chat to a dead session.
        failed["retire_native_session"] = is_resume
        return failed
    reply = redact_secrets((result.final_text or "").strip())
    if not reply:
        # exit 0 with no text is not a successful turn — treat it as a failure
        # (same posture as the generic channel), so it persists as failed and
        # does not leave a blank completed bubble that vanishes on reload.
        return _failed_chat_turn("claude", "claude native chat returned no reply (exit 0 with empty output)")
    return {
        "intent": "chat",
        "backend": "claude",
        "status": "completed",
        "response": reply,
        "native_session_id": native_session_id,
        # The token tally parsed from claude's result event (same dict the live
        # Display Protocol ``usage`` event carries), so the API can persist it on
        # the assistant message and the chat metering row survives a reload.
        "usage": result.usage if isinstance(result.usage, dict) else None,
    }


def execute_clawwork_native_chat_turn(
    *,
    content: str,
    repo: Path,
    budget_seconds: int,
    model: str | None = None,
    effort: str | None = None,
    permission_mode: str | None = None,
    native_session_id: str,
    is_resume: bool,
    expect_resume: bool | None = None,
    history_seed: str = "",
    catch_up: str = "",
    context_text: str = "",
    on_event: Any = None,
    chat_session_id: str = "",
) -> dict[str, Any]:
    """One NATIVE ClawWork chat turn — the runtime's own on-disk session memory.

    Mirrors :func:`execute_claude_native_chat_turn`'s contract (the API dispatch is
    symmetric) but drives the GOVERNED ``ClawWorkBackend.run()`` channel — it does NOT
    reimplement governance (signed snapshot / handshake / relay key all ride run()).
    The chat prompt is carried as a ``chat_turn_intent="chat"`` goal (run()'s
    ``_legacy_prompt`` returns the description verbatim as the chat prompt), and the
    durable native session rides ``WorkerLimits.native_session_id`` /
    ``native_session_dir`` so ClawWork resumes its own memory via ``--session-id``.

    Resume safety: the API pre-flight already header-verified the session before
    deciding ``is_resume``; ``native_session_expect_resume`` makes run() re-verify under
    the cross-process lock right before the spawn, failing closed
    (``CLAWWORK_NATIVE_SESSION_LOST``) on a concurrent loss so the binding is retired and
    the next turn full-seeds — never a silent empty resume.
    """
    from superclaw.backends import ClawWorkBackend, WorkerLimits
    from superclaw.clawwork_session import is_valid_native_session_id, native_session_dir
    from superclaw.runtime import PermissionPolicy

    # Fail loud + retire on an invalid native id: unlike a one-shot worker run (which
    # safely downgrades to --no-session), a native chat turn that silently ran without a
    # session would persist a binding with no backing session (Tier 2 design, blocker #5).
    if not is_valid_native_session_id(native_session_id):
        failed = _failed_chat_turn(
            "clawwork", f"NATIVE_SESSION_ID_INVALID: {native_session_id!r} is not a valid ClawWork session id"
        )
        failed["retire_native_session"] = True
        return failed

    effort_value = (effort or "").strip().lower() or None

    pieces: list[str] = []
    if not is_resume and history_seed.strip():
        pieces.append(
            "Conversation so far (oldest first; carried over from before this native session started):\n"
            + history_seed.strip()
        )
    if is_resume and catch_up.strip():
        pieces.append(catch_up.strip())
    if context_text.strip():
        pieces.append("Context References:\n" + context_text.strip())
    pieces.append(content)
    prompt = "\n\n".join(pieces)

    backend_obj = ClawWorkBackend()
    availability = backend_obj.available()
    if not availability.available:
        failed = _failed_chat_turn("clawwork", f"backend clawwork is not available: {availability.reason or 'unavailable'}")
        # A resume that cannot even start must not pin the chat to a dead session.
        failed["retire_native_session"] = is_resume
        return failed

    session_dir = native_session_dir(chat_session_id or native_session_id, backend="clawwork", create=True)
    goal = GoalSpec(
        title="SuperClaw native chat",
        description=prompt,
        acceptance_criteria=[],
        metadata={"chat_turn_intent": "chat"},
    )
    task = TaskNode(task_id=_id("task"), role=WorkerRole.IMPLEMENT, title="clawwork native chat turn")
    session = RunSession(goal_id=goal.goal_id)
    effective_mode = (permission_mode or "").strip() or DEFAULT_CHAT_PERMISSION_MODE

    _last_usage: dict[str, Any] | None = None

    def _sink(et: str, p: Any) -> None:
        nonlocal _last_usage
        if et == "usage" and isinstance(p, dict) and isinstance(p.get("usage"), dict):
            _last_usage = p["usage"]
        if on_event is not None:
            on_event(et, p)

    with applied_runtime_environment():
        with tempfile.TemporaryDirectory(prefix="superclaw-clawwork-chat-") as temp_dir:
            limits = WorkerLimits(
                repo_path=repo,
                artifact_dir=Path(temp_dir),
                budget_seconds=max(1, int(budget_seconds)),
                permission_policy=PermissionPolicy(mode=effective_mode),
                model_override=(model or "").strip() or None,
                effort_override=effort_value,
                event_sink=_sink,
                native_session_id=native_session_id,
                native_session_dir=session_dir,
                # STRICT file-must-exist re-verify only for a TRUE resume (a prior turn
                # completed). Falls back to is_resume when the caller doesn't distinguish.
                # A reused PENDING binding (expect_resume=False) must NOT hard-fail before
                # its in-flight creator persists the file — both attach via create-if-missing.
                native_session_expect_resume=is_resume if expect_resume is None else expect_resume,
            )
            result = backend_obj.run(task, goal, session, limits)

    response = redact_secrets(_extract_direct_chat_response(
        result.stdout if result.stdout is not None else result.output
    ))

    if result.timed_out:
        # Surface the underlying clawwork output/stderr tail (run()/_spawn_rpc fold the
        # child's stderr into the result on timeout): a bare "timeout" hides WHY clawwork
        # never finished (e.g. relay stall, governance handshake), which is exactly what a
        # packaged-app diagnosis needs. Bounded so the chat surface stays readable.
        tail = _compose_failure_detail("", result.stderr) or (result.output or "")
        suffix = f": {tail.strip()[:400]}" if tail and tail.strip() else ""
        return _failed_chat_turn("clawwork", f"timeout: clawwork native chat exceeded {int(budget_seconds)}s{suffix}")
    if result.cancelled:
        return _failed_chat_turn("clawwork", "clawwork native chat was cancelled")
    if result.exit_code != 0:
        detail = _compose_failure_detail(_extract_direct_chat_response(result.output) or response, result.stderr)
        failed = _failed_chat_turn("clawwork", f"clawwork native chat failed (exit {result.exit_code}): {detail}")
        # A lost/ambiguous session under lock (or any resume failure) retires the binding
        # so the next turn full-seeds a fresh session instead of re-resuming a dead one.
        failed["retire_native_session"] = is_resume or "CLAWWORK_NATIVE_SESSION_LOST" in (result.output or "")
        return failed
    if not response:
        return _failed_chat_turn("clawwork", "clawwork native chat returned no reply (exit 0 with empty output)")
    return {
        "intent": "chat",
        "backend": "clawwork",
        "status": "completed",
        "response": response,
        "native_session_id": native_session_id,
        # Usage projection for the clawwork chat channel is a follow-up (clawwork run()
        # records usage in the cost snapshot but does not yet emit a Display ``usage``
        # event); _last_usage stays None until that lands, so the metering row is honest
        # rather than fabricated.
        "usage": _last_usage,
    }


def execute_direct_chat_turn(
    *, content: str, backend: str, repo: Path, budget_seconds: int, context_text: str = "", history: str = "",
    model: str | None = None, effort: str | None = None, permission_mode: str | None = None, event_sink=None, protected_cwd: bool = False,
    skill_ids: tuple[str, ...] = (),
) -> dict[str, Any]:
    backend = (backend or "").strip() or "codex"
    # Defense at the kernel boundary: if the message ADDRESSES an @skill but the
    # caller did not thread skill_ids (e.g. the legacy /api/chat/direct endpoint
    # that never parses overlays), refuse rather than silently run it as a plain
    # chat turn. Closes the silent-no-op hole for every caller, not just ones that
    # opt in. Same marker semantics every surface routes on (extract_skill_id).
    if not skill_ids and extract_skill_id(content):
        return _failed_chat_turn(
            backend,
            "skill_overlay_unthreaded: message addresses @skill but this entry point did not "
            "receive skill_ids (use the chat turn/stream path that parses overlays)",
        )
    # Semantic auto-trigger (default on): on a chat turn that did NOT name an explicit
    # @skill, offer the model the fail-closed, bounded catalog of available native
    # skills so it can apply a relevant one on its own. Computed here (the chat entry)
    # so it is chat-only and honors the toggle; the explicit @skill path is unaffected.
    available_skill_catalog = ""
    if not skill_ids:
        from superclaw.runtime_config import semantic_skill_autotrigger_enabled

        if semantic_skill_autotrigger_enabled():
            from superclaw.skill_runtime import build_available_skill_catalog
            from superclaw.skill_store import SkillStoreError

            # Semantic discovery is a CONVENIENCE layer: a corrupt skill store /
            # revocation file must never turn an ordinary chat into an uncaught error
            # now that this defaults ON. Degrade to no catalog (chat still works) and
            # log it — the EXPLICIT @skill path stays fail-closed on its own, which is
            # the right place to hard-fail when the user actually invoked a skill.
            try:
                available_skill_catalog = build_available_skill_catalog().text
            except (SkillStoreError, OSError, UnicodeError) as exc:
                logging.getLogger(__name__).warning(
                    "semantic skill catalog unavailable; continuing without it: %s", exc
                )
                available_skill_catalog = ""
    if backend not in CODEX_DIRECT_CHAT_BACKENDS:
        return _execute_generic_direct_chat_turn(
            content=content,
            backend=backend,
            repo=repo,
            budget_seconds=budget_seconds,
            context_text=context_text,
            history=history,
            model=model,
            effort=effort,
            permission_mode=permission_mode,
            event_sink=event_sink,
            protected_cwd=protected_cwd,
            skill_ids=skill_ids,
            available_skill_catalog=available_skill_catalog,
        )
    # Codex direct-chat fast-path: this hand-rolled `codex exec` subprocess does NOT
    # go through CodexCliBackend.run()/_prompt_envelope, so resolve @skill overlays
    # here and inline the prose into the prompt explicitly — same fail-closed kernel
    # choke (prepare_inline_skill_overlay) and prose-only capability the backend run()
    # path uses, so behavior matches. An unknown / tool / too-large skill refuses.
    skill_overlay_text = ""
    if skill_ids:
        from superclaw.skill_runtime import (
            BackendSkillCapability,
            SkillRuntimeError,
            prepare_inline_skill_overlay,
        )

        try:
            _overlay = prepare_inline_skill_overlay(
                tuple(skill_ids), capability=BackendSkillCapability.prose_only()
            )
        except SkillRuntimeError as exc:
            return _failed_chat_turn(backend, f"skill_overlay_unavailable: {exc}")
        skill_overlay_text = "\n\n".join(
            f"Apply this SuperClaw skill now — «{name}» ({slug}):\n{body}"
            for slug, name, body in _overlay.prose
        )
    from superclaw.backends import CodexCliBackend

    model = (model or "").strip() or None
    effort = (effort or "").strip().lower() or None
    if effort and effort not in CodexCliBackend.EFFORT_LEVELS:
        # Same fail-loud rule as the kernel codex backends.
        return {
            "intent": "chat",
            "backend": backend,
            "status": "failed",
            "failure_reason": (
                f"EFFORT_INVALID: effort={effort!r} is not one of "
                f"{'/'.join(CodexCliBackend.EFFORT_LEVELS)}; fix or clear the effort selection"
            ),
        }
    effective_mode = (permission_mode or "").strip() or DEFAULT_CHAT_PERMISSION_MODE

    with applied_runtime_environment():
        executable, _source = find_codex_executable(os.environ.get("SUPERCLAW_CODEX_EXECUTABLE"))
        if not executable:
            return {
                "intent": "chat",
                "backend": backend,
                "status": "failed",
                "failure_reason": "codex executable not found; configure with /config set SUPERCLAW_CODEX_EXECUTABLE /path/to/codex",
            }

        # Skill content rides the TOOL_CONTRACT layer (audited, governance-ordered),
        # same layer the backend.run() path injects into — not appended raw to the
        # flattened prompt. Either the explicit @skill overlay OR (when none) the
        # semantic-discovery catalog; they are mutually exclusive by construction.
        prompt = direct_chat_prompt(
            content,
            context_text=context_text,
            history=history,
            tool_contract=skill_overlay_text or available_skill_catalog,
        )
        mode = codex_cli_mode(executable)
        if model and mode != "exec":
            # Same fail-closed rule as the kernel CodexCliBackend: the legacy CLI
            # cannot honor a model selection, and running anyway would silently
            # answer on a different model than the user picked.
            return {
                "intent": "chat",
                "backend": backend,
                "status": "failed",
                "failure_reason": (
                    f"MODEL_OVERRIDE_UNSUPPORTED: legacy codex CLI mode cannot honor a model "
                    f"selection ({model}); upgrade to a codex exec-capable CLI or clear the model"
                ),
            }
        if effort and mode != "exec":
            # model_reasoning_effort rides `codex exec -c`; legacy `-q` has no
            # equivalent, so refuse rather than silently dropping it.
            return {
                "intent": "chat",
                "backend": backend,
                "status": "failed",
                "failure_reason": (
                    f"EFFORT_OVERRIDE_UNSUPPORTED: legacy codex CLI mode cannot honor a reasoning-effort "
                    f"selection ({effort}); upgrade to a codex exec-capable CLI or clear the effort"
                ),
            }
        with tempfile.TemporaryDirectory(prefix="superclaw-chat-") as temp_dir:
            output_path = Path(temp_dir) / "last-message.txt"
            if mode == "exec":
                # Permission mode passes through to codex's own sandbox, the
                # SAME mapping the kernel CodexCliBackend uses for a delivery
                # run: plan → read-only; bypassPermissions/dontAsk → bypass
                # approvals+sandbox; everything else (acceptEdits/default) →
                # workspace-write. Chat is a native runtime turn, not a forced
                # read-only one.
                sandbox = "read-only" if effective_mode == "plan" else "workspace-write"
                command = [
                    executable,
                    "exec",
                    "--skip-git-repo-check",
                    "--ephemeral",
                    "--sandbox",
                    sandbox,
                    "--color",
                    "never",
                    "--cd",
                    str(repo),
                    "--output-last-message",
                    str(output_path),
                ]
                if effective_mode in {"bypassPermissions", "dontAsk"}:
                    command.append("--dangerously-bypass-approvals-and-sandbox")
                if model:
                    command.extend(["--model", model])
                if effort:
                    command.extend(["-c", f"model_reasoning_effort={effort}"])
                command.append(prompt)
            else:
                command = [executable, "-q", "--full-stdout", prompt]
            try:
                completed = subprocess.run(
                    command,
                    cwd=repo,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    env=desktop_toolchain_env(),
                    timeout=max(1, int(budget_seconds)),
                    check=False,
                )
            except subprocess.TimeoutExpired:
                return {
                    "intent": "chat",
                    "backend": backend,
                    "status": "failed",
                    "failure_reason": f"timeout: codex direct chat exceeded {int(budget_seconds)}s",
                }

            response = output_path.read_text(encoding="utf-8").strip() if output_path.exists() else ""
            if not response:
                # Same stream policy as the generic path: a success reply only
                # ever comes from stdout; stderr (CLI log noise) joins only the
                # failure detail below.
                if completed.returncode == 0:
                    response = (completed.stdout or "").strip()
                else:
                    response = ((completed.stdout or "") + ("\n" + completed.stderr if completed.stderr else "")).strip()
            response = redact_secrets(strip_ansi_sequences(response))
            if completed.returncode != 0:
                # Same lossy-detail guard as the generic path: a partial
                # --output-last-message (or stdout banner) must not mask the
                # stderr fatal. The compose helper reserves budget for the
                # stderr tail so it survives a long primary detail.
                detail = _compose_failure_detail(response, redact_secrets(completed.stderr or ""))
                return {
                    "intent": "chat",
                    "backend": backend,
                    "status": "failed",
                    "failure_reason": f"codex direct chat failed with exit code {completed.returncode}: {detail}",
                }
            if not response and (completed.stderr or "").strip():
                tail = _compose_failure_detail("", redact_secrets(completed.stderr))
                return {
                    "intent": "chat",
                    "backend": backend,
                    "status": "failed",
                    "failure_reason": f"codex returned no reply on stdout (exit 0); stderr: {tail}",
                }
            return {
                "intent": "chat",
                "backend": backend,
                "status": "completed",
                "response": response,
            }
