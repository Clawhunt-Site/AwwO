/**
 * Per-chat runtime (backend + model + effort) stickiness — kernel rules.
 *
 * Faithful TypeScript port of SuperClaw's `superclaw/chat_runtime.py` into the
 * Paperclip Node adapter layer, so the in-chat runtime-switch semantics are
 * IDENTICAL across the legacy CLI/Python surfaces and this Node chat surface
 * (no drift between surfaces — the whole point of a single resolver).
 *
 * A chat session remembers which backend/model/effort it runs on (stored in the
 * chat issue's `executionState.runtime`). Every turn resolves its effective
 * runtime through {@link resolveChatRuntime}:
 *  - An explicit per-turn request wins.
 *  - Otherwise the session's sticky runtime applies (the chat "remembers").
 *  - Otherwise the surface default backend applies, with no model selection.
 *  - A model/effort selection never crosses a backend switch implicitly: model
 *    ids and effort levels are runtime-specific, so switching backend drops them
 *    unless the same turn explicitly requests one.
 *  - A backend switch mid-chat stays in the SAME chat (in-chat handoff, not a
 *    forked child chat). The old backend's native session cannot continue, so
 *    the selection carries a `handoffNote` the surface must: append as a
 *    `system` transcript marker AND replay prior turns into the new backend's
 *    context.
 *
 * `REQUEST_CLEAR` (the empty string) is the explicit "clear the selection"
 * request — distinct from `undefined` ("nothing requested this turn").
 */

export const RUNTIME_METADATA_KEY = "runtime";

/**
 * Explicit clear sentinel for a requested model/effort: "" (e.g. an empty model
 * field in an API request). `undefined` means "not requested this turn".
 */
export const REQUEST_CLEAR = "";

export interface ChatRuntimeSelection {
  /** The resolved backend (adapter type) for this turn. */
  backend: string;
  /** Resolved model id, or null to inherit the runtime's configured default. */
  model: string | null;
  /** True when this turn switched the backend away from the sticky one. */
  backendSwitched: boolean;
  previousBackend: string | null;
  previousModel: string | null;
  /**
   * In-chat handoff marker, set only on a backend switch. The surface MUST
   * append it as a `system` transcript marker and replay prior turns into the
   * new backend's context (the old native session cannot continue).
   */
  handoffNote: string | null;
  /**
   * Per-chat sticky reasoning-effort / thinking level — same stickiness +
   * backend-switch rules as `model` (effort levels are runtime-specific and NOT
   * portable across backends). null ⇒ inherit the runtime's configured default.
   */
  effort: string | null;
  previousEffort: string | null;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** Return the (backend, model, effort) a chat session is sticky to, if any. */
export function stickyChatRuntime(
  metadata: Record<string, unknown> | null | undefined,
): { backend: string | null; model: string | null; effort: string | null } {
  const runtime = (metadata ?? {})[RUNTIME_METADATA_KEY];
  if (!runtime || typeof runtime !== "object") {
    return { backend: null, model: null, effort: null };
  }
  const r = runtime as Record<string, unknown>;
  return {
    backend: nonEmpty(r.backend),
    model: nonEmpty(r.model),
    effort: nonEmpty(r.effort),
  };
}

export interface ResolveChatRuntimeInput {
  /** Explicit per-turn backend; falsy/blank ⇒ not requested. */
  requestedBackend?: string | null;
  /** "" = REQUEST_CLEAR; undefined/null = not requested this turn. */
  requestedModel?: string | null;
  /** "" = REQUEST_CLEAR; undefined/null = not requested this turn. */
  requestedEffort?: string | null;
  defaultBackend?: string;
}

/**
 * Resolve the effective runtime for a turn (request > sticky > default).
 *
 * `requestedModel`/`requestedEffort === ""` (REQUEST_CLEAR) explicitly clears
 * that selection; `undefined`/`null` means nothing was requested this turn.
 */
export function resolveChatRuntime(
  metadata: Record<string, unknown> | null | undefined,
  input: ResolveChatRuntimeInput = {},
): ChatRuntimeSelection {
  const sticky = stickyChatRuntime(metadata);
  const requestedBackend = (input.requestedBackend ?? "").trim();
  const defaultBackend = input.defaultBackend ?? "claude";
  const backend = requestedBackend || sticky.backend || defaultBackend;
  const backendSwitched = Boolean(sticky.backend) && backend !== sticky.backend;

  // `undefined`/`null` ⇒ not requested; a string (incl. "") ⇒ requested.
  const modelRequested = input.requestedModel !== undefined && input.requestedModel !== null;
  const effortRequested = input.requestedEffort !== undefined && input.requestedEffort !== null;

  let model: string | null;
  if (modelRequested) {
    model = (input.requestedModel as string).trim() || null;
  } else if (backendSwitched) {
    // Sticky model belongs to the previous backend; never carry it across.
    model = null;
  } else {
    model = sticky.model;
  }

  let effort: string | null;
  if (effortRequested) {
    effort = (input.requestedEffort as string).trim() || null;
  } else if (backendSwitched) {
    // Effort levels are runtime-specific; never carry a sticky effort across.
    effort = null;
  } else {
    effort = sticky.effort;
  }

  const handoffNote = backendSwitched
    ? `[runtime switched: ${sticky.backend} → ${backend}; the conversation continues ` +
      `in this chat — the new runtime starts a fresh native session and inherits ` +
      `nothing from the previous runtime; prior turns are carried only via the ` +
      `transcript context this surface provides]`
    : null;

  return {
    backend,
    model,
    backendSwitched,
    previousBackend: sticky.backend,
    previousModel: sticky.model,
    handoffNote,
    effort,
    previousEffort: sticky.effort,
  };
}

/** Encode a selection into the `executionState.runtime` shape (sticky storage). */
export function chatRuntimeToMetadata(selection: ChatRuntimeSelection): Record<string, string> {
  const payload: Record<string, string> = { backend: selection.backend };
  if (selection.model) payload.model = selection.model;
  if (selection.effort) payload.effort = selection.effort;
  return payload;
}

/**
 * Write the selection back into the issue's executionState. Returns
 * `{ executionState, changed }`; `changed` is false when the stored runtime
 * already matches, so callers can skip an idempotent row rewrite.
 */
export function applyChatRuntime(
  executionState: Record<string, unknown> | null | undefined,
  selection: ChatRuntimeSelection,
): { executionState: Record<string, unknown>; changed: boolean } {
  const next = { ...(executionState ?? {}) };
  const desired = chatRuntimeToMetadata(selection);
  const current = next[RUNTIME_METADATA_KEY];
  if (current && typeof current === "object" && JSON.stringify(current) === JSON.stringify(desired)) {
    return { executionState: next, changed: false };
  }
  next[RUNTIME_METADATA_KEY] = desired;
  return { executionState: next, changed: true };
}
