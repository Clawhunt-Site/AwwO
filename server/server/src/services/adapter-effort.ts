/**
 * Per-adapter reasoning-effort ("thinking effort") capability + mapping.
 *
 * Server-side mirror of `server/ui` (`IssueProperties.thinkingEffortKeyFor` +
 * `ISSUE_THINKING_EFFORT_OPTIONS`). Lives on the Node server so the chat-runtime
 * contract reports REAL per-adapter effort capability (not a flat
 * `supports_effort_selection: false`) and so the chat orchestrator can project a
 * per-turn effort selection onto the right adapter config key.
 *
 * Effort is runtime-specific. Each level set mirrors what the REAL runtime
 * actually honors (probed from the installed binaries / the model's documented
 * reasoning-effort support; an out-of-range value would only be ignored/rejected,
 * so we never offer one):
 *  - codex_local    → `modelReasoningEffort` (minimal/low/medium/high/xhigh, `-c model_reasoning_effort=`)
 *  - opencode_local → `variant`              (minimal…max, `--variant`)
 *  - claude_local   → `effort`               (low/medium/high/xhigh/max, `--effort`)
 *  - grok_local     → NONE. The grok CLI has an --effort flag, but no Grok MODEL
 *    honors a reasoning-effort selection (grok-4 rejects it; grok-3-mini is
 *    low/high only; grok-4-fast/4.3 are none/low/medium/high — none support
 *    xhigh/max), so we don't advertise it (mirrors GrokCliBackend.supports_effort
 *    = False in the Python kernel, which fail-closes on an explicit effort).
 *  - others (gemini/cursor/…) → no native effort axis.
 */

export interface EffortOption {
  value: string;
  label: string;
}

/** Mirrors `server/ui` ISSUE_THINKING_EFFORT_OPTIONS (single source: keep in lockstep). */
const THINKING_EFFORT_OPTIONS: Record<string, readonly EffortOption[]> = {
  claude_local: [
    { value: "", label: "Default" },
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
    { value: "xhigh", label: "X-High" },
    { value: "max", label: "Max" },
  ],
  codex_local: [
    { value: "", label: "Default" },
    { value: "minimal", label: "Minimal" },
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
    { value: "xhigh", label: "X-High" },
  ],
  opencode_local: [
    { value: "", label: "Default" },
    { value: "minimal", label: "Minimal" },
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
    { value: "xhigh", label: "X-High" },
    { value: "max", label: "Max" },
  ],
  // grok_local is intentionally ABSENT: the grok CLI advertises an --effort flag,
  // but no Grok model reliably honors a reasoning-effort selection (grok-4 rejects
  // it outright; grok-3-mini is low/high only; grok-4-fast/4.3 are
  // none/low/medium/high — none support xhigh/max), so SuperClaw does not offer the
  // control. This mirrors GrokCliBackend.supports_effort = False in the Python
  // kernel (single source of truth), which fail-closes on an explicit effort.
};

/** True only for adapters with a native effort axis (drives `supports_effort_selection`). */
export function adapterSupportsEffort(adapterType: string | null | undefined): boolean {
  return typeof adapterType === "string" && Object.prototype.hasOwnProperty.call(THINKING_EFFORT_OPTIONS, adapterType);
}

/** Per-adapter effort options ([] when the adapter has no effort axis — iron rule: don't offer a rejected control). */
export function thinkingEffortOptionsFor(adapterType: string | null | undefined): readonly EffortOption[] {
  return adapterSupportsEffort(adapterType) ? THINKING_EFFORT_OPTIONS[adapterType as string] : [];
}

/** The adapter-config key a generic effort value maps to (mirrors server/ui thinkingEffortKeyFor). */
export function thinkingEffortKeyFor(adapterType: string | null | undefined): string {
  if (adapterType === "codex_local") return "modelReasoningEffort";
  if (adapterType === "opencode_local") return "variant";
  // claude_local rides the `--effort` flag (config key `effort`). grok_local is not
  // effort-capable (see THINKING_EFFORT_OPTIONS) so it never reaches this mapping.
  return "effort";
}

/**
 * Project a per-turn effort selection onto an adapter config. Returns a NEW
 * object. **Fail-closed**: only an effort value that is an allowed level for
 * this runtime is written; a blank value (REQUEST_CLEAR / default) OR an
 * out-of-range value removes the key so the runtime falls back to its own
 * default instead of receiving a value it would reject. No-op for adapters
 * without an effort axis (nothing to set).
 */
export function applyEffortToAdapterConfig(
  adapterType: string | null | undefined,
  adapterConfig: Record<string, unknown> | null | undefined,
  effort: string | null | undefined,
): Record<string, unknown> {
  const next = { ...(adapterConfig ?? {}) };
  if (!adapterSupportsEffort(adapterType)) return next;
  const key = thinkingEffortKeyFor(adapterType);
  const value = typeof effort === "string" ? effort.trim() : "";
  const allowed = new Set(
    thinkingEffortOptionsFor(adapterType)
      .map((option) => option.value)
      .filter((level) => level.length > 0),
  );
  if (value && allowed.has(value)) next[key] = value;
  else delete next[key];
  return next;
}
