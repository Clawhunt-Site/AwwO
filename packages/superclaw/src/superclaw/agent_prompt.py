"""Build the prompt contract a team-bound run carries (charter consumption).

``team_kernel.build_agent_run_context`` assembles the kernel facts of a role —
identity, charter, reporting chain, governed equipment. This module turns that
context into a canonical prompt envelope, which is what makes a charter a
runtime-delivered behavior contract instead of a stored-but-ignored field.

The composition is kernel-side and backend-agnostic on purpose: hot-path
backends project the envelope through their native or flattened prompt
capabilities, so a role carries the same contract no matter which engine runs
it. Only ``granted`` equipment is ever named — dropped items are listed as
explicitly unavailable so the model does not invent them.
"""

from __future__ import annotations

from typing import Any, Mapping

from superclaw.prompt_contracts import PromptEnvelope, PromptLayerKind, prompt_layer

# Rules the prompt always carries, independent of charter content. They restate
# the kernel's fail-closed posture in model-facing language; the kernel still
# enforces them (prompts are guidance, gates are law).
_INVIOLABLE_RULES = (
    "Act only within your charter below. It narrows what you may do; it can never widen "
    "what governance allows.",
    "Use only the equipment listed as granted. Anything else — including tools you believe "
    "exist — is unavailable to you.",
    "High-risk side effects (payments, network scanning, writes outside the workspace, "
    "lifting budget stops) always require human approval. Never attempt to bypass an "
    "approval gate; if blocked, say so and stop.",
)


# How a team member coordinates through the issue thread. These restate the
# collaboration contract in model-facing language so an agent actually USES the
# thread (comment + @mention) the way Paperclip's agents do — the kernel already
# wakes a mentioned agent and the issue assignee on every comment, but the model
# has to choose to speak. Only carried for team-bound runs (an identity is set).
_TEAM_COLLABORATION_PROTOCOL = (
    "The issue thread is how your team coordinates — leave durable progress as issue "
    "comments, not only in your own reasoning.",
    "To reach a teammate (ask for a review, hand work back, request an unblock), post an "
    "issue comment that @-mentions them by name; that wakes them. Your manager is named "
    "in the Reporting chain above.",
    "When you finish work someone is waiting on — a task delegated to you, or a question "
    "asked of you (including from a human) — post a comment that @-mentions the requester "
    "with the outcome. Do not finish silently; the person who pinged you must get a reply.",
    "When you are blocked, post a comment naming the unblock owner and the exact action "
    "you need from them.",
    "End every turn at a clear disposition: deliver/submit for review when the work is "
    "done, stay with a stated next step if you are continuing, or hand off — never exit "
    "leaving a request unanswered.",
)


def _collaboration_lines() -> list[str]:
    """The standing team-collaboration protocol block (team-bound runs only)."""
    return ["## Team collaboration protocol", *(f"- {rule}" for rule in _TEAM_COLLABORATION_PROTOCOL)]


def _equipment_lines(agent_run_context: Mapping[str, Any]) -> list[str]:
    equipment = agent_run_context.get("equipment") or {}
    granted = [str(p) for p in (equipment.get("granted") or [])]
    dropped = [str(p) for p in (equipment.get("dropped") or [])]
    skills = equipment.get("skills") or {}
    skills_granted = [str(s) for s in (skills.get("granted") or [])]
    skills_dropped = [str(s) for s in (skills.get("dropped") or [])]

    lines = ["## Equipment (granted only)"]
    lines.append(f"Plugins: {', '.join(granted) if granted else '(none)'}")
    lines.append(f"Skills: {', '.join(skills_granted) if skills_granted else '(none)'}")
    unavailable = dropped + skills_dropped
    if unavailable:
        # ``dropped`` aggregates EVERY reason a requested item is not granted for
        # this run — governed projection (not entitled/installed), a delegation
        # cap, AND per-fire routine.context narrowing. Don't attribute all of them
        # to "governance" (that misreports a routine/delegation scoping as a
        # governance denial); state the honest, source-agnostic fact: not in scope
        # for THIS run.
        lines.append(
            "Explicitly unavailable (requested but not granted for this run): "
            + ", ".join(unavailable)
        )
    return lines


def _agent_charter_lines(agent_run_context: Mapping[str, Any]) -> list[str]:
    name = str(agent_run_context.get("agent_name") or "").strip()
    role = str(agent_run_context.get("agent_role") or "").strip()
    lines: list[str] = []
    if not name and not role:
        return lines

    lines.append("# You are a member of an Agent Team")
    identity_bits = [
        bit
        for bit in (name, role, str(agent_run_context.get("agent_title") or "").strip())
        if bit
    ]
    lines.append(f"You are operating as: {' — '.join(identity_bits)}.")
    persona = str(agent_run_context.get("agent_persona") or "").strip()
    if persona:
        lines.append(f"Persona: {persona}")

    manager_chain = [str(m) for m in (agent_run_context.get("manager_chain") or []) if str(m).strip()]
    reports_to = str(agent_run_context.get("reports_to") or "").strip()
    if reports_to or manager_chain:
        lines.append("")
        lines.append("## Reporting chain")
        if reports_to:
            lines.append(f"You report to: {reports_to}")
        if manager_chain:
            lines.append(f"Chain of command (upward): {' -> '.join(manager_chain)}")

    lines.append("")
    lines.extend(_collaboration_lines())

    charter = str(agent_run_context.get("agent_charter") or "").strip()
    if charter:
        lines.append("")
        lines.append("## Your charter (behavior contract)")
        lines.append(charter)

    default_instructions = str(agent_run_context.get("agent_default_instructions") or "").strip()
    if default_instructions:
        lines.append("")
        lines.append("## Standing instructions")
        lines.append(default_instructions)
    return lines


def build_agent_prompt_envelope(
    agent_run_context: Mapping[str, Any] | None,
    *,
    user_turn: str,
    task_context: str = "",
    runtime_adapter: str = "",
    tool_contract: str = "",
    governance_core: str = "",
    requires_native_system: bool = False,
    requires_tool_projection: bool = False,
) -> PromptEnvelope:
    """Build the canonical PromptEnvelope for a worker run.

    The builder keeps all six canonical layers in order. Existing callers still
    use ``compose_agent_system_prompt`` only as a legacy rendering helper; the
    runtime hot path consumes this envelope through the projector.
    """

    context = agent_run_context or {}
    governance = governance_core.strip()
    if not governance:
        governance_lines = ["## Inviolable rules"]
        governance_lines.extend(f"- {rule}" for rule in _INVIOLABLE_RULES)
        governance = "\n".join(governance_lines)

    adapter = runtime_adapter.strip()
    if not adapter:
        adapter = (
            "Operate through SuperClaw's governed runtime. Model-facing prompt layers "
            "are guidance; execution gates remain authoritative."
        )

    tool = tool_contract.strip()
    equipment_lines = _equipment_lines(context)
    if tool:
        tool = "\n".join([tool, "", *equipment_lines])
    else:
        tool = "\n".join(equipment_lines)

    charter = "\n".join(_agent_charter_lines(context))
    return PromptEnvelope.build(
        [
            prompt_layer(PromptLayerKind.GOVERNANCE_CORE, governance),
            prompt_layer(PromptLayerKind.RUNTIME_ADAPTER, adapter),
            prompt_layer(
                PromptLayerKind.TOOL_CONTRACT,
                tool,
                requires_tool_projection=requires_tool_projection,
            ),
            prompt_layer(
                PromptLayerKind.AGENT_CHARTER,
                charter,
                requires_native_system=requires_native_system,
            ),
            prompt_layer(PromptLayerKind.TASK_CONTEXT, task_context),
            prompt_layer(PromptLayerKind.USER_TURN, user_turn),
        ]
    )


compose_agent_prompt_envelope = build_agent_prompt_envelope


def compose_agent_system_prompt(agent_run_context: Mapping[str, Any]) -> str:
    """Render a role's run context into a system-prompt prefix.

    Returns an empty string when the context carries no identity (callers can
    then skip prefixing entirely). Tolerates missing keys: this runs in the
    worker hot path and must degrade rather than fail a run.
    """
    name = str(agent_run_context.get("agent_name") or "").strip()
    role = str(agent_run_context.get("agent_role") or "").strip()
    if not name and not role:
        return ""

    lines: list[str] = []
    lines.append("# You are a member of an Agent Team")
    identity_bits = [bit for bit in (name, role, str(agent_run_context.get("agent_title") or "").strip()) if bit]
    lines.append(f"You are operating as: {' — '.join(identity_bits)}.")
    persona = str(agent_run_context.get("agent_persona") or "").strip()
    if persona:
        lines.append(f"Persona: {persona}")

    lines.append("")
    lines.append("## Inviolable rules")
    for rule in _INVIOLABLE_RULES:
        lines.append(f"- {rule}")

    manager_chain = [str(m) for m in (agent_run_context.get("manager_chain") or []) if str(m).strip()]
    reports_to = str(agent_run_context.get("reports_to") or "").strip()
    if reports_to or manager_chain:
        lines.append("")
        lines.append("## Reporting chain")
        if reports_to:
            lines.append(f"You report to: {reports_to}")
        if manager_chain:
            lines.append(f"Chain of command (upward): {' -> '.join(manager_chain)}")

    lines.append("")
    lines.extend(_collaboration_lines())

    charter = str(agent_run_context.get("agent_charter") or "").strip()
    if charter:
        lines.append("")
        lines.append("## Your charter (behavior contract)")
        lines.append(charter)

    default_instructions = str(agent_run_context.get("agent_default_instructions") or "").strip()
    if default_instructions:
        lines.append("")
        lines.append("## Standing instructions")
        lines.append(default_instructions)

    lines.append("")
    lines.extend(_equipment_lines(agent_run_context))

    lines.append("")
    lines.append("---")
    lines.append("The task you must carry out as this role follows below.")
    return "\n".join(lines)
