/**
 * Chat display projector — turns an adapter's streamed stdout into the legacy
 * chat SSE vocabulary the frontend's DisplayAccumulator expects.
 *
 * Two output channels (see apps/web/src/displayProtocol.ts):
 *  - Plain chat text → `message.delta { text }` (NOT a DisplayProtocol event;
 *    the frontend renders it as assistant text).
 *  - Tool / reasoning / usage → canonical DisplayProtocol events wrapped in the
 *    envelope `{ schema_version, type, seq, ts, runtime_id, capability_tier,
 *    payload, run_id, session_id }` so they fold into tool cards / reasoning /
 *    the usage meter.
 *
 * Two formats:
 *  - "claude": the adapter streams stream-json JSON-lines; each line is parsed
 *    into structured tool/reasoning/usage/text events. Claude's own control
 *    noise (system/init/control) is ignored. Only used for claude-family runtimes.
 *  - "text": the adapter streams plain text — every chunk passes through VERBATIM
 *    as `message.delta` (no buffering/trimming) so token streaming is preserved.
 *    A non-claude JSONL runtime falls here, so its output is visible (not parsed,
 *    not swallowed) until a runtime-specific projector exists.
 */

export type ChatDisplayFormat = "claude" | "codex" | "text";

export interface ChatDisplaySend {
  (event: string, data: unknown): void;
}

export interface ChatDisplayProjectorOptions {
  send: ChatDisplaySend;
  runtimeId: string;
  runId: string;
  sessionId: string;
  format: ChatDisplayFormat;
}

type Json = Record<string, unknown>;

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Coarse tool kind from a tool name (case-insensitive; mirrors the frontend ToolKind). */
function toolKind(name: string): "command" | "file" | "mcp" | "builtin" | "unknown" {
  const n = name.toLowerCase();
  if (n.startsWith("mcp__")) return "mcp";
  if (n === "bash" || n === "bashoutput" || n === "killbash") return "command";
  if (["read", "write", "edit", "multiedit", "notebookedit", "glob", "grep"].includes(n)) return "file";
  if (name) return "builtin";
  return "unknown";
}

/** Flatten a tool_result `content` (string or content-block array) to text. */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (block && typeof block === "object" ? asString((block as Json).text) : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

export function createChatDisplayProjector(opts: ChatDisplayProjectorOptions) {
  let buffer = "";
  let seq = 0;
  let textAcc = "";
  // claude --verbose emits live token deltas as `stream_event` AND a consolidated
  // `assistant` message. Track whether we already streamed live text/reasoning so
  // the consolidated message doesn't double it — but still fall back to the
  // consolidated message when the runtime is NOT verbose (no stream_event).
  let streamedText = false;
  let streamedThinking = false;
  // Remember each tool_use so the terminal tool.completed can carry the same
  // name/kind/input — the frontend treats completed as authoritative and does
  // not merge it with the earlier tool.started.
  const toolsByCallId = new Map<string, { name: string | null; kind: string; input: unknown }>();

  const envelope = (type: string, payload: Json) => ({
    schema_version: 1,
    type,
    seq: seq++,
    ts: new Date().toISOString(),
    runtime_id: opts.runtimeId,
    capability_tier: "full",
    payload,
    run_id: opts.runId,
    session_id: opts.sessionId,
  });

  const emitText = (text: string) => {
    if (text) {
      textAcc += text;
      opts.send("message.delta", { text });
    }
  };
  const emitDisplay = (type: string, payload: Json) => {
    opts.send(type, envelope(type, payload));
  };

  function handleStructured(ev: Json): void {
    const type = ev.type;

    // Live token stream (claude --verbose): content_block_delta carries the
    // incremental text/thinking. This is the real token-by-token path.
    if (type === "stream_event") {
      const event = ev.event as Json | undefined;
      if (event?.type === "content_block_delta") {
        const delta = event.delta as Json | undefined;
        if (delta?.type === "text_delta") {
          const text = asString(delta.text);
          if (text) {
            streamedText = true;
            emitText(text);
          }
        } else if (delta?.type === "thinking_delta") {
          const text = asString(delta.thinking);
          if (text) {
            streamedThinking = true;
            emitDisplay("reasoning.delta", { text });
          }
        }
      }
      return;
    }

    const message = ev.message as Json | undefined;
    const content = message?.content;

    if (type === "assistant" && Array.isArray(content)) {
      for (const raw of content) {
        const block = raw as Json;
        // Text/reasoning already arrived live via stream_event when verbose;
        // only emit from the consolidated message as a fallback (non-verbose).
        if (block.type === "text") {
          if (!streamedText) emitText(asString(block.text));
        } else if (block.type === "thinking") {
          if (!streamedThinking) emitDisplay("reasoning.delta", { text: asString(block.thinking) });
        } else if (block.type === "tool_use") {
          const callId = asString(block.id);
          const name = asString(block.name) || null;
          const kind = toolKind(asString(block.name));
          toolsByCallId.set(callId, { name, kind, input: block.input ?? null });
          emitDisplay("tool.started", {
            call_id: callId,
            call_id_source: "runtime",
            name,
            kind,
            status: "running",
            input: block.input ?? null,
            truncated: { input: false, output: false },
          });
        }
      }
      return;
    }

    if (type === "user" && Array.isArray(content)) {
      for (const raw of content) {
        const block = raw as Json;
        if (block.type === "tool_result") {
          const callId = asString(block.tool_use_id);
          const started = toolsByCallId.get(callId);
          emitDisplay("tool.completed", {
            call_id: callId,
            call_id_source: "runtime",
            // Carry the started identity forward so the card keeps name/kind/input.
            name: started?.name ?? null,
            kind: started?.kind ?? "unknown",
            input: started?.input ?? null,
            status: block.is_error === true ? "error" : "ok",
            output: toolResultText(block.content),
            truncated: { input: false, output: false },
          });
        }
      }
      return;
    }

    if (type === "result") {
      const usage = ev.usage;
      if (usage && typeof usage === "object") emitDisplay("usage", { usage: usage as Json });
      return;
    }
    // system / init / control events carry no chat-visible content → ignore.
  }

  // Codex emits its own JSON-lines schema (item.started / item.completed wrapping an
  // `item` whose `type` is agent_message / command_execution / reasoning, plus
  // thread.started / turn.* control noise). Project it into the SAME DisplayProtocol
  // vocabulary as claude so the surface renders a clean assistant message + COLLAPSED
  // tool cards — never the raw command/port/env text the legacy "text" passthrough
  // dumped inline. Non-JSON adapter logs (e.g. "[superclaw] …") are dropped by
  // consumeLine's `{`-guard, so they never reach the user either.
  function handleCodex(ev: Json): void {
    const type = ev.type;
    const item = ev.item as Json | undefined;
    if (!item || typeof item !== "object") return; // thread.started / turn.* → ignore
    const itemType = asString(item.type);
    const callId = asString(item.id) || `codex-${seq}`;

    if (itemType === "agent_message") {
      // The model's visible answer — emit on completion (started may be empty/partial).
      if (type === "item.completed") emitText(asString(item.text));
      return;
    }
    if (itemType === "reasoning") {
      if (type === "item.completed") emitDisplay("reasoning.delta", { text: asString(item.text) });
      return;
    }
    if (itemType === "command_execution") {
      const command = asString(item.command);
      if (type === "item.started") {
        toolsByCallId.set(callId, { name: "bash", kind: "command", input: { command } });
        emitDisplay("tool.started", {
          call_id: callId,
          call_id_source: "runtime",
          name: "bash",
          kind: "command",
          status: "running",
          input: { command },
          truncated: { input: false, output: false },
        });
      } else if (type === "item.completed") {
        const started = toolsByCallId.get(callId);
        const exit = item.exit_code;
        const ok = exit === 0 || exit === null || exit === undefined;
        emitDisplay("tool.completed", {
          call_id: callId,
          call_id_source: "runtime",
          name: started?.name ?? "bash",
          kind: started?.kind ?? "command",
          input: started?.input ?? { command },
          status: ok ? "ok" : "error",
          output: asString(item.aggregated_output),
          truncated: { input: false, output: false },
        });
      }
      return;
    }
    // Unknown codex item type → ignore (never a raw text leak).
  }

  function consumeLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return; // JSON-lines; ignore stray noise (incl. "[superclaw] …" logs)
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === "object" && typeof (parsed as Json).type === "string") {
        if (opts.format === "codex") handleCodex(parsed as Json);
        else handleStructured(parsed as Json);
      }
    } catch {
      // Incomplete/invalid JSON line — ignore (final text comes from the run result).
    }
  }

  return {
    /** Feed a raw stdout chunk; emits SSE events. */
    ingest(chunk: string): void {
      if (opts.format === "text") {
        // Verbatim — preserve token streaming for plain-text runtimes. No
        // content filtering here: operational run-log notes ([superclaw] …)
        // are kept out of chat at the SOURCE by emitting them on stderr (the
        // chat stream projects only stdout). Filtering model stdout was
        // rejected — chunk boundaries make line filters corrupt newlines, and
        // legitimate model prose may start a line with the prefix.
        emitText(chunk);
        return;
      }
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        consumeLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
    },
    /** Flush a trailing partial JSON line at end-of-stream (claude format only). */
    flush(): void {
      if (opts.format === "text") return;
      const rest = buffer;
      buffer = "";
      consumeLine(rest);
    },
    /** Plain assistant text emitted so far (fallback when the run has no summary). */
    text(): string {
      return textAcc;
    },
  };
}

export type ChatDisplayProjector = ReturnType<typeof createChatDisplayProjector>;

/**
 * Pick the projection format for a runtime: claude-family streams stream-json; codex
 * streams its own item.* JSON-lines (parsed into tool cards + clean text so the raw
 * command/port/env never leaks inline); everything else falls back to plain text.
 */
export function chatDisplayFormatForAdapter(adapterType: string): ChatDisplayFormat {
  const t = adapterType.toLowerCase();
  if (t.includes("claude")) return "claude";
  if (t.includes("codex")) return "codex";
  return "text";
}
