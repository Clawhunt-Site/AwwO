"""Per-chat runtime (backend + model) stickiness — kernel rules.

A chat session remembers which backend/model it runs on (``ChatSession.metadata
["runtime"]``). Every surface (CLI shell, scriptable ``superclaw chat``, API,
Web/Desktop) resolves a turn's effective runtime through :func:`resolve_chat_runtime`
so the semantics cannot drift between surfaces:

- An explicit per-turn request wins.
- Otherwise the session's sticky runtime applies (the chat "remembers").
- Otherwise the surface's default backend applies, with no model selection
  (the backend's ``SUPERCLAW_*_MODEL`` env default governs).
- A model selection never crosses a backend switch implicitly: model ids are
  not portable between runtimes, so switching backend drops the sticky model
  unless the same turn explicitly requests one. The reasoning-effort / thinking
  level (``effort``) follows the exact same stickiness + backend-switch rules —
  effort levels are runtime-specific (codex minimal/xhigh vs claude max), so
  they are never carried across a backend switch.
- A backend switch mid-chat stays in the SAME chat (user decision: in-chat
  handoff, not a forked child chat). The native session of the old backend
  cannot continue, so the selection carries a ``handoff_note`` the surface must
  surface: append it as a ``system`` transcript marker and replay prior turns
  into the new backend's context.

``REQUEST_CLEAR`` (the empty string) is the explicit "clear the model
selection" request — distinct from ``None`` ("nothing requested this turn").
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

RUNTIME_METADATA_KEY = "runtime"
# Explicit clear sentinel for requested_model: "" (e.g. `/model clear`, an empty
# model field in an API request). None means "not requested this turn".
REQUEST_CLEAR = ""


@dataclass(frozen=True)
class ChatRuntimeSelection:
    """The resolved runtime for one chat turn."""

    backend: str
    model: str | None
    backend_switched: bool
    previous_backend: str | None
    previous_model: str | None
    handoff_note: str | None
    # Per-chat sticky reasoning-effort / thinking level — same stickiness +
    # backend-switch rules as ``model`` (effort levels are runtime-specific and
    # NOT portable across backends, so a backend switch drops it). None ⇒ inherit
    # the runtime's configured default. Defaulted so existing positional/keyword
    # construction stays valid.
    effort: str | None = None
    previous_effort: str | None = None

    def to_metadata(self) -> dict[str, Any]:
        payload: dict[str, Any] = {"backend": self.backend}
        if self.model:
            payload["model"] = self.model
        if self.effort:
            payload["effort"] = self.effort
        return payload


def sticky_chat_runtime(
    metadata: dict[str, Any] | None,
) -> tuple[str | None, str | None, str | None]:
    """Return the (backend, model, effort) a chat session is sticky to, if any."""
    runtime = (metadata or {}).get(RUNTIME_METADATA_KEY)
    if not isinstance(runtime, dict):
        return None, None, None
    backend = runtime.get("backend")
    model = runtime.get("model")
    effort = runtime.get("effort")
    return (
        backend if isinstance(backend, str) and backend.strip() else None,
        model if isinstance(model, str) and model.strip() else None,
        effort if isinstance(effort, str) and effort.strip() else None,
    )


def resolve_chat_runtime(
    metadata: dict[str, Any] | None,
    *,
    requested_backend: str | None = None,
    requested_model: str | None = None,
    requested_effort: str | None = None,
    default_backend: str = "claude",
) -> ChatRuntimeSelection:
    """Resolve the effective runtime for a turn (request > sticky > default).

    ``requested_model``/``requested_effort=REQUEST_CLEAR`` ("") explicitly clears
    that selection; ``None`` means nothing was requested this turn.
    """
    sticky_backend, sticky_model, sticky_effort = sticky_chat_runtime(metadata)
    backend = (requested_backend or "").strip() or sticky_backend or default_backend
    backend_switched = bool(sticky_backend) and backend != sticky_backend

    if requested_model is not None:
        model = requested_model.strip() or None
    elif backend_switched:
        # Sticky model belongs to the previous backend; never carry it across.
        model = None
    else:
        model = sticky_model

    if requested_effort is not None:
        effort = requested_effort.strip() or None
    elif backend_switched:
        # Effort levels are runtime-specific (codex minimal/xhigh vs claude max);
        # never carry a sticky effort across a backend switch.
        effort = None
    else:
        effort = sticky_effort

    handoff_note = None
    if backend_switched:
        handoff_note = (
            f"[runtime switched: {sticky_backend} → {backend}; the conversation continues "
            "in this chat — the new runtime starts a fresh native session and inherits "
            "nothing from the previous runtime; prior turns are carried only via the "
            "transcript context this surface provides]"
        )
    return ChatRuntimeSelection(
        backend=backend,
        model=model,
        backend_switched=backend_switched,
        previous_backend=sticky_backend,
        previous_model=sticky_model,
        handoff_note=handoff_note,
        effort=effort,
        previous_effort=sticky_effort,
    )


def apply_chat_runtime(metadata: dict[str, Any] | None, selection: ChatRuntimeSelection) -> tuple[dict[str, Any], bool]:
    """Write the selection back into session metadata.

    Returns ``(metadata, changed)``; ``changed`` is False when the stored runtime
    already matches, so callers can skip an idempotent row rewrite.
    """
    metadata = dict(metadata or {})
    desired = selection.to_metadata()
    if metadata.get(RUNTIME_METADATA_KEY) == desired:
        return metadata, False
    metadata[RUNTIME_METADATA_KEY] = desired
    return metadata, True
