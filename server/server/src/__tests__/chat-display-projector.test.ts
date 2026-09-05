import { describe, expect, it } from "vitest";
import { createChatDisplayProjector } from "../services/chat-display-projector.ts";

function makeProjector(format: "claude" | "codex" | "text" = "claude") {
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const projector = createChatDisplayProjector({
    send: (event, data) => events.push({ event, data: data as Record<string, unknown> }),
    runtimeId: "claude_local",
    runId: "run1",
    sessionId: "issue1",
    format,
  });
  return { projector, events };
}

const line = (obj: unknown) => `${JSON.stringify(obj)}\n`;

describe("chat display projector", () => {
  it("projects claude stream-json into message / tool / usage events", () => {
    const { projector, events } = makeProjector();
    projector.ingest(
      line({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Hi" },
            { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
          ],
        },
      }),
    );
    projector.ingest(
      line({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "file.txt", is_error: false }] },
      }),
    );
    projector.ingest(line({ type: "result", usage: { input_tokens: 5, output_tokens: 2 } }));

    expect(events.map((e) => e.event)).toEqual([
      "message.delta",
      "tool.started",
      "tool.completed",
      "usage",
    ]);

    const text = events.find((e) => e.event === "message.delta")!;
    expect(text.data.text).toBe("Hi");

    const started = events.find((e) => e.event === "tool.started")!.data;
    // DisplayProtocol envelope shape.
    expect(started.schema_version).toBe(1);
    expect(started.type).toBe("tool.started");
    expect(started.capability_tier).toBe("full");
    expect(started.run_id).toBe("run1");
    expect(typeof started.seq).toBe("number");
    expect(started.payload).toMatchObject({
      call_id: "t1",
      name: "Bash",
      kind: "command",
      status: "running",
      truncated: { input: false, output: false },
    });

    const completed = events.find((e) => e.event === "tool.completed")!.data;
    // tool.completed must carry the started identity forward (the frontend treats
    // completed as authoritative and does not merge it with tool.started).
    expect(completed.payload).toMatchObject({
      call_id: "t1",
      status: "ok",
      output: "file.txt",
      name: "Bash",
      kind: "command",
      input: { command: "ls" },
    });

    const usage = events.find((e) => e.event === "usage")!.data;
    expect((usage.payload as Record<string, unknown>).usage).toEqual({ input_tokens: 5, output_tokens: 2 });
  });

  it("streams live token deltas (stream_event) without doubling the consolidated text", () => {
    const { projector, events } = makeProjector("claude");
    projector.ingest(
      line({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } } }),
    );
    projector.ingest(
      line({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } } }),
    );
    // The consolidated assistant message repeats the full text — must NOT re-emit.
    projector.ingest(line({ type: "assistant", message: { content: [{ type: "text", text: "Hello" }] } }));
    expect(events.filter((e) => e.event === "message.delta").map((e) => e.data.text)).toEqual(["Hel", "lo"]);
    expect(projector.text()).toBe("Hello");
  });

  it("maps stream_event thinking deltas to reasoning.delta", () => {
    const { projector, events } = makeProjector("claude");
    projector.ingest(
      line({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "ponder" } } }),
    );
    expect((events.find((e) => e.event === "reasoning.delta")!.data.payload as Record<string, unknown>).text).toBe("ponder");
  });

  it("streams live token deltas via claude stream_event (no double from consolidated)", () => {
    const { projector, events } = makeProjector("claude");
    projector.ingest(
      line({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } } }),
    );
    projector.ingest(
      line({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } } }),
    );
    // The consolidated assistant message must NOT re-emit already-streamed text.
    projector.ingest(line({ type: "assistant", message: { content: [{ type: "text", text: "Hello" }] } }));
    const texts = events.filter((e) => e.event === "message.delta").map((e) => e.data.text);
    expect(texts).toEqual(["Hel", "lo"]);
    expect(projector.text()).toBe("Hello");
  });

  it("maps a live thinking_delta to reasoning.delta", () => {
    const { projector, events } = makeProjector("claude");
    projector.ingest(
      line({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "ponder" } },
      }),
    );
    const reasoning = events.find((e) => e.event === "reasoning.delta")!.data;
    expect((reasoning.payload as Record<string, unknown>).text).toBe("ponder");
  });

  it("maps thinking blocks to reasoning.delta", () => {
    const { projector, events } = makeProjector();
    projector.ingest(line({ type: "assistant", message: { content: [{ type: "thinking", thinking: "hmm" }] } }));
    const reasoning = events.find((e) => e.event === "reasoning.delta")!.data;
    expect((reasoning.payload as Record<string, unknown>).text).toBe("hmm");
  });

  it("maps an errored tool_result to status=error", () => {
    const { projector, events } = makeProjector();
    projector.ingest(
      line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t9", content: "boom", is_error: true }] } }),
    );
    expect((events.find((e) => e.event === "tool.completed")!.data.payload as Record<string, unknown>).status).toBe("error");
  });

  it("recognizes lowercase tool names (claude emits `bash`)", () => {
    const { projector, events } = makeProjector("claude");
    projector.ingest(
      line({ type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "bash", input: {} }] } }),
    );
    const started = events.find((e) => e.event === "tool.started")!.data;
    expect((started.payload as Record<string, unknown>).kind).toBe("command");
  });

  it("claude format ignores non-JSON and control noise (no leak as text)", () => {
    const { projector, events } = makeProjector("claude");
    projector.ingest("some stray non-json line\n");
    projector.ingest(line({ type: "system", subtype: "init" }));
    projector.ingest(line({ type: "control_request" }));
    expect(events).toHaveLength(0);
  });

  it("text format streams plain chunks verbatim (preserves token streaming)", () => {
    const { projector, events } = makeProjector("text");
    projector.ingest("Hel");
    projector.ingest("lo wor");
    projector.ingest("ld");
    expect(events).toEqual([
      { event: "message.delta", data: { text: "Hel" } },
      { event: "message.delta", data: { text: "lo wor" } },
      { event: "message.delta", data: { text: "ld" } },
    ]);
    expect(projector.text()).toBe("Hello world");
  });

  it("text format passes prefix-shaped model prose through verbatim (leak prevention lives on stderr routing)", () => {
    const { projector, events } = makeProjector("text");
    // Operational notes are kept out of chat by emitting them on stderr at the
    // source; the projector must NOT filter stdout content — legitimate model
    // prose may start a line with the prefix, and chunk-boundary line filters
    // corrupt newlines.
    projector.ingest("[superclaw] is the log prefix\n");
    projector.ingest("more text");
    expect(projector.text()).toBe("[superclaw] is the log prefix\nmore text");
    expect(events).toHaveLength(2);
  });

  describe("codex format (no raw command/port/env leak)", () => {
    it("projects a command_execution into COLLAPSED tool cards, never inline text", () => {
      const { projector, events } = makeProjector("codex");
      projector.ingest(
        line({ type: "item.started", item: { id: "i1", type: "command_execution", command: "SUPERCLAW_RUNTIME_API_URL=http://127.0.0.1:8791 manage.sh list" } }),
      );
      projector.ingest(
        line({ type: "item.completed", item: { id: "i1", type: "command_execution", command: "manage.sh list", aggregated_output: '[{"id":"co-1"}]', exit_code: 0 } }),
      );
      // The command/port goes into tool.started/tool.completed (a collapsible card),
      // NOT a message.delta — so it is never dumped as inline chat text.
      const types = events.map((e) => e.event);
      expect(types).toContain("tool.started");
      expect(types).toContain("tool.completed");
      expect(types).not.toContain("message.delta");
      const completed = events.find((e) => e.event === "tool.completed")!.data.payload as Record<string, unknown>;
      expect(completed.status).toBe("ok");
      expect(completed.output).toBe('[{"id":"co-1"}]');
    });

    it("projects an agent_message into clean visible chat text", () => {
      const { projector, events } = makeProjector("codex");
      projector.ingest(line({ type: "item.completed", item: { id: "m1", type: "agent_message", text: "I found 25 companies." } }));
      expect(events).toEqual([{ event: "message.delta", data: { text: "I found 25 companies." } }]);
      expect(projector.text()).toBe("I found 25 companies.");
    });

    it("a failed command surfaces status:error", () => {
      const { projector, events } = makeProjector("codex");
      projector.ingest(line({ type: "item.completed", item: { id: "i9", type: "command_execution", command: "x", aggregated_output: "boom", exit_code: 1 } }));
      const c = events.find((e) => e.event === "tool.completed")!.data.payload as Record<string, unknown>;
      expect(c.status).toBe("error");
    });

    it("DROPS non-JSON adapter log noise (e.g. de-branding leak lines) entirely", () => {
      const { projector, events } = makeProjector("codex");
      projector.ingest("[paperclip] Using fallback workspace /tmp/x\n");
      projector.ingest(line({ type: "thread.started", thread_id: "t" }));
      projector.ingest(line({ type: "turn.started" }));
      // No events at all — the log line + control noise never reach the user.
      expect(events).toEqual([]);
    });
  });
});
