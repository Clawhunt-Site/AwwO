/**
 * ClawWork-specific terminal-error detection (fake-success guard).
 *
 * pi-local's `parsePiJsonl` captures `type:"error"` events and exhausted-retry
 * frames, but it does NOT inspect the terminal assistant message's `stopReason`.
 * ClawWork's `AssistantMessage` (third_party/clawwork ai/types.ts) carries
 * `stopReason: "stop"|"length"|"toolUse"|"error"|"aborted"` + optional
 * `errorMessage`, and the agent loop emits such a message inside `agent_end` /
 * `turn_end` even when the process exits 0 with partial text. Without this check a
 * relay/model failure (stopReason=error) would be reported as a successful run —
 * the exact fake-success the Python ClawWorkBackend guards against
 * (`last_assistant_stop == "error"` -> model_error). So we scan the stream for a
 * terminal assistant message whose stopReason is error/aborted and surface it.
 */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function assistantError(msg: unknown): string | null {
  const record = asRecord(msg);
  if (!record || record.role !== "assistant") return null;
  const stop = typeof record.stopReason === "string" ? record.stopReason : "";
  if (stop !== "error" && stop !== "aborted") return null;
  const detail = typeof record.errorMessage === "string" && record.errorMessage.trim()
    ? record.errorMessage.trim()
    : `request ${stop}`;
  return detail;
}

/**
 * Detect a governance EXTENSION error in the run output (defense in depth for the
 * pay/scan hard gate). ClawWork surfaces an `-e` extension's runtime failure as an
 * `extension_error` JSONL event (which pi-local's parser SKIPS) and/or an
 * `Extension error (...)` line on stderr (print-mode). Either means the governance
 * handler may have thrown after loading — so the run must be treated as ungoverned
 * rather than reported as success. Returns a short reason or null.
 */
export function clawworkExtensionError(stdout: string, stderr: string): string | null {
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let event: Record<string, unknown> | null;
    try {
      event = asRecord(JSON.parse(line));
    } catch {
      continue;
    }
    if (event && event.type === "extension_error") {
      const msg = typeof event.error === "string" ? event.error : typeof event.message === "string" ? event.message : "extension error";
      return msg.slice(0, 300);
    }
  }
  const match = /Extension error[^\n]*/i.exec(stderr ?? "");
  if (match) return match[0].slice(0, 300);
  return null;
}

/**
 * Returns a terminal-error string when ClawWork ended a turn with an
 * error/aborted assistant message, else null. Scans `agent_end` (messages[]) and
 * `turn_end` (message) events; tolerant of malformed lines.
 */
export function clawworkTerminalError(stdout: string): string | null {
  let lastError: string | null = null;
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let event: Record<string, unknown> | null;
    try {
      event = asRecord(JSON.parse(line));
    } catch {
      continue;
    }
    if (!event) continue;
    const type = event.type;
    if (type === "agent_end") {
      const messages = Array.isArray(event.messages) ? event.messages : [];
      for (const msg of messages) {
        const err = assistantError(msg);
        if (err) lastError = err;
      }
    } else if (type === "turn_end") {
      const err = assistantError(event.message);
      if (err) lastError = err;
    }
  }
  return lastError;
}
