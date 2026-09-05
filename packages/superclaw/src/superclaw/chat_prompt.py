from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable, Mapping

from superclaw.prompt_contracts import (
    LAYER_AUTHORITY,
    PromptEnvelope,
    PromptLayerKind,
    prompt_layer,
)


@dataclass(frozen=True)
class ChatAttachmentMetadata:
    name: str
    mime_type: str | None = None
    size: int | None = None
    reference: str | None = None

    @classmethod
    def from_mapping(cls, value: Mapping[str, Any]) -> "ChatAttachmentMetadata":
        return cls(
            name=str(value.get("name") or value.get("filename") or "attachment"),
            mime_type=str(value["mime_type"]) if value.get("mime_type") else None,
            size=_parse_attachment_size(value.get("size")),
            reference=str(value["reference"]) if value.get("reference") else None,
        )

    def render(self) -> str:
        parts = [self.name]
        if self.mime_type:
            parts.append(f"mime={self.mime_type}")
        if self.size is not None:
            parts.append(f"size={self.size}")
        if self.reference:
            parts.append(f"ref={self.reference}")
        return " | ".join(parts)


def _parse_attachment_size(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if value >= 0 else None
    if isinstance(value, str):
        text = value.strip()
        return int(text) if text.isdecimal() else None
    return None


@dataclass(frozen=True)
class ChatPromptEnvelope:
    envelope: PromptEnvelope
    prompt: str
    projection_audit: dict[str, Any] = field(default_factory=dict)
    legacy_fallback: dict[str, Any] = field(default_factory=dict)


def _truncate_history_line(line: str, max_chars: int) -> str:
    if len(line) <= max_chars:
        return line
    role, separator, content = line.partition(": ")
    if separator and len(role) + len(separator) < max_chars:
        content_budget = max_chars - len(role) - len(separator)
        return f"{role}{separator}{content[-content_budget:]}"
    return line[-max_chars:]


def format_chat_history(messages: list[Any], *, max_messages: int = 20, max_chars: int = 6000) -> str:
    """Render recent chat turns without cutting through role boundaries."""

    if max_chars <= 0:
        return ""

    role_label = {"user": "User", "assistant": "Assistant", "system": "System"}
    lines: list[str] = []
    for message in messages[-max_messages:]:
        if getattr(message, "status", None) == "failed":
            continue
        raw_role = getattr(message, "role", "") or "Unknown"
        role = role_label.get(raw_role, str(raw_role))
        content = str(getattr(message, "content", "") or "").strip()
        if content:
            lines.append(f"{role}: {content}")

    selected: list[str] = []
    total_chars = 0
    for line in reversed(lines):
        separator_chars = 1 if selected else 0
        next_total = total_chars + separator_chars + len(line)
        if next_total <= max_chars:
            selected.append(line)
            total_chars = next_total
            continue
        if not selected:
            selected.append(_truncate_history_line(line, max_chars))
        break
    return "\n".join(reversed(selected))


def _normalize_attachments(
    attachments: Iterable[ChatAttachmentMetadata | Mapping[str, Any]] | None,
) -> tuple[ChatAttachmentMetadata, ...]:
    normalized: list[ChatAttachmentMetadata] = []
    for item in attachments or ():
        if isinstance(item, ChatAttachmentMetadata):
            normalized.append(item)
        elif isinstance(item, Mapping):
            normalized.append(ChatAttachmentMetadata.from_mapping(item))
        else:
            normalized.append(ChatAttachmentMetadata(name=str(item)))
    return tuple(normalized)


def _task_context(
    *,
    history_text: str = "",
    context_text: str = "",
    attachments: tuple[ChatAttachmentMetadata, ...] = (),
    history_heading: str,
) -> tuple[str, tuple[str, ...]]:
    blocks: list[str] = []
    sections: list[str] = []
    if history_text.strip():
        blocks.append(f"{history_heading}\n{history_text.strip()}")
        sections.append("history")
    if context_text.strip():
        blocks.append(f"Context References:\n{context_text.strip()}")
        sections.append("context")
    if attachments:
        blocks.append("Attachment Metadata:\n" + "\n".join(f"- {item.render()}" for item in attachments))
        sections.append("attachments")
    return "\n\n".join(blocks), tuple(sections)


def _render_legacy_prompt(envelope: PromptEnvelope, *, current_user_heading: str) -> str:
    user = envelope.get(PromptLayerKind.USER_TURN)
    task = envelope.get(PromptLayerKind.TASK_CONTEXT)
    rendered: list[str] = []
    for kind in (
        PromptLayerKind.RUNTIME_ADAPTER,
        PromptLayerKind.TOOL_CONTRACT,
        PromptLayerKind.AGENT_CHARTER,
    ):
        layer = envelope.get(kind)
        if layer and layer.content.strip():
            rendered.append(layer.content.strip())
    if task and task.content.strip():
        rendered.append(task.content.strip())
    if user and user.content:
        if not rendered:
            return user.content
        rendered.append(f"{current_user_heading}\n{user.content}")
    return "\n\n".join(rendered)


def _audit_metadata(
    envelope: PromptEnvelope,
    *,
    task_sections: tuple[str, ...],
    legacy_fallback: dict[str, Any],
) -> dict[str, Any]:
    return {
        "schema": "superclaw.chat_prompt_envelope.v1",
        "contains_prompt_content": False,
        "layer_kinds": [kind.value for kind in envelope.kinds()],
        "layer_authorities": {
            kind.value: LAYER_AUTHORITY[kind].value for kind in envelope.kinds()
        },
        "task_context_sections": list(task_sections),
        "has_tool_contract": envelope.get(PromptLayerKind.TOOL_CONTRACT) is not None,
        "has_runtime_adapter": envelope.get(PromptLayerKind.RUNTIME_ADAPTER) is not None,
        "has_current_user_turn": envelope.get(PromptLayerKind.USER_TURN) is not None,
        "legacy_fallback": dict(legacy_fallback),
    }


def build_chat_prompt_envelope(
    message: str,
    *,
    history_text: str = "",
    context_text: str = "",
    attachments: Iterable[ChatAttachmentMetadata | Mapping[str, Any]] | None = None,
    runtime_notice: str = "",
    tool_contract: str = "",
    agent_charter: str = "",
    history_heading: str = "Conversation so far (oldest first; this is your memory of this session — rely on it):",
    current_user_heading: str = "Current user message:",
) -> ChatPromptEnvelope:
    normalized_attachments = _normalize_attachments(attachments)
    task_context, task_sections = _task_context(
        history_text=history_text,
        context_text=context_text,
        attachments=normalized_attachments,
        history_heading=history_heading,
    )
    layers = []
    if runtime_notice.strip():
        layers.append(prompt_layer(PromptLayerKind.RUNTIME_ADAPTER, runtime_notice.strip()))
    if tool_contract.strip():
        layers.append(prompt_layer(PromptLayerKind.TOOL_CONTRACT, tool_contract.strip()))
    if agent_charter.strip():
        layers.append(prompt_layer(PromptLayerKind.AGENT_CHARTER, agent_charter.strip()))
    if task_context.strip():
        layers.append(prompt_layer(PromptLayerKind.TASK_CONTEXT, task_context.strip()))
    layers.append(prompt_layer(PromptLayerKind.USER_TURN, message))
    envelope = PromptEnvelope.build(layers)
    legacy_fallback = {
        "mode": "flattened_compatibility",
        "content_free": True,
        "reason": "runtime prompt transport still accepts prompt: str",
    }
    return ChatPromptEnvelope(
        envelope=envelope,
        prompt=_render_legacy_prompt(envelope, current_user_heading=current_user_heading),
        projection_audit=_audit_metadata(
            envelope,
            task_sections=task_sections,
            legacy_fallback=legacy_fallback,
        ),
        legacy_fallback=legacy_fallback,
    )
