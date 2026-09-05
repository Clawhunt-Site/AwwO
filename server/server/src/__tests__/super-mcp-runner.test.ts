import { describe, expect, it, vi } from "vitest";

import {
  callSuperPluginTool,
  connectWithTimeout,
  normalizeMcpResult,
  SuperMcpRunError,
  type McpSession,
} from "../services/super-mcp-runner.js";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("normalizeMcpResult", () => {
  it("joins text blocks and records non-text block types", () => {
    const r = normalizeMcpResult({
      content: [
        { type: "text", text: "hello" },
        { type: "text", text: "world" },
        { type: "image", data: "..." },
        { type: "audio" },
      ],
      structuredContent: { words: 2 },
      isError: false,
    });
    expect(r.text).toBe("hello\nworld");
    expect(r.blockTypes).toEqual(["image", "audio"]);
    expect(r.structured).toEqual({ words: 2 });
    expect(r.isError).toBe(false);
  });

  it("surfaces the tool-level isError flag", () => {
    expect(normalizeMcpResult({ content: [{ type: "text", text: "boom" }], isError: true }).isError).toBe(true);
  });

  it("handles missing/empty content and non-object input", () => {
    expect(normalizeMcpResult({}).text).toBe("");
    expect(normalizeMcpResult({}).blockTypes).toEqual([]);
    expect(normalizeMcpResult({}).structured).toBeNull();
    expect(normalizeMcpResult("nope").text).toBe("");
    expect(normalizeMcpResult(null).text).toBe("");
  });

  it("drops a non-object/array structuredContent", () => {
    expect(normalizeMcpResult({ structuredContent: "str" }).structured).toBeNull();
    expect(normalizeMcpResult({ structuredContent: [1, 2] }).structured).toEqual([1, 2]);
  });

  it("ignores malformed content entries", () => {
    const r = normalizeMcpResult({ content: ["str", null, { type: "text", text: "ok" }, { notype: 1 }] });
    expect(r.text).toBe("ok");
    expect(r.blockTypes).toEqual(["unknown"]);
  });
});

function fakeSession(over: Partial<McpSession> = {}): McpSession & { close: ReturnType<typeof vi.fn> } {
  const close = vi.fn(async () => {});
  return {
    callTool: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })),
    close,
    ...over,
  } as McpSession & { close: ReturnType<typeof vi.fn> };
}

describe("callSuperPluginTool", () => {
  it("opens a session, calls the tool, normalizes, and closes", async () => {
    const session = fakeSession();
    const out = await callSuperPluginTool("t", { x: 1 }, { openSession: async () => session, timeoutMs: 1000 });
    expect(out.text).toBe("ok");
    expect(session.callTool).toHaveBeenCalledWith("t", { x: 1 });
    expect(session.close).toHaveBeenCalledTimes(1);
  });

  it("times out a hung tool call and still tears the session down", async () => {
    const session = fakeSession({ callTool: vi.fn(() => new Promise(() => {})) });
    await expect(
      callSuperPluginTool("t", {}, { openSession: async () => session, timeoutMs: 10 }),
    ).rejects.toThrow(SuperMcpRunError);
    expect(session.close).toHaveBeenCalledTimes(1);
  });

  it("on a tool error the PRIMARY error wins over a teardown failure (still closes)", async () => {
    const session = fakeSession({
      callTool: vi.fn(async () => {
        throw new Error("tool boom");
      }),
      close: vi.fn(async () => {
        throw new Error("close boom");
      }),
    });
    // The tool error is what the caller needs; a secondary teardown failure must not mask it.
    await expect(
      callSuperPluginTool("t", {}, { openSession: async () => session, timeoutMs: 1000 }),
    ).rejects.toThrow(/tool boom/);
    expect(session.close).toHaveBeenCalledTimes(1);
  });

  it("SURFACES a teardown failure on the success path (a leaked process group is not hidden)", async () => {
    const session = fakeSession({
      close: vi.fn(async () => {
        throw new Error("process group not reaped");
      }),
    });
    // The call succeeded, so the only failure is the leak — it must propagate, not be
    // swallowed behind a successful-looking result.
    await expect(
      callSuperPluginTool("t", {}, { openSession: async () => session, timeoutMs: 1000 }),
    ).rejects.toThrow(/not reaped/);
  });
});

describe("connectWithTimeout", () => {
  it("returns on a successful connect without tearing down", async () => {
    const teardown = vi.fn(async () => {});
    await connectWithTimeout(async () => {}, teardown, 1000);
    expect(teardown).not.toHaveBeenCalled();
  });

  it("on timeout, AWAITS the full teardown before rejecting (no fire-and-forget)", async () => {
    let teardownComplete = false;
    await expect(
      connectWithTimeout(
        () => new Promise(() => {}), // connect hangs forever
        async () => {
          await delay(15); // simulate SIGTERM -> grace -> SIGKILL
          teardownComplete = true;
        },
        5,
      ),
    ).rejects.toThrow(/timed out/);
    expect(teardownComplete).toBe(true); // reap fully completed before we returned
  });

  it("on a connect error, also awaits teardown then rethrows", async () => {
    const teardown = vi.fn(async () => {});
    await expect(
      connectWithTimeout(
        async () => {
          throw new Error("initialize failed");
        },
        teardown,
        1000,
      ),
    ).rejects.toThrow(/initialize failed/);
    expect(teardown).toHaveBeenCalledTimes(1);
  });
});
