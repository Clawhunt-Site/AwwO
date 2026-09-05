import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { SuperStdioTransport, type SuperStdioParams } from "../services/super-stdio-transport.js";

interface FakeChild extends EventEmitter {
  pid: number;
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: { write: (data: string, cb?: (err?: Error) => void) => boolean };
  stdinWrites: string[];
}

function fakeChild(pid = 4242): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdinWrites = [];
  child.stdin = {
    write: (data: string, cb?: (err?: Error) => void) => {
      child.stdinWrites.push(data);
      cb?.();
      return true;
    },
  };
  return child;
}

function setup(params: Partial<SuperStdioParams> = {}) {
  const child = fakeChild();
  const spawnCalls: Array<{ command: string; args: readonly string[]; opts: Record<string, unknown> }> = [];
  const killCalls: Array<{ pid: number; signal: string }> = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const spawn: any = (command: string, args: string[], opts: Record<string, unknown>) => {
    spawnCalls.push({ command, args, opts });
    queueMicrotask(() => child.emit("spawn"));
    return child;
  };
  let sigkilled = false;
  const transport = new SuperStdioTransport(
    {
      command: "/abs/bin/run",
      args: ["mcp"],
      env: { PATH: "/usr/bin:/bin", HOME: "/h" },
      cwd: "/install",
      killGraceMs: 0,
      ...params,
    },
    {
      spawn,
      kill: (pid, signal) => {
        killCalls.push({ pid, signal });
        if (signal === "SIGKILL") sigkilled = true;
      },
      // The group is "empty" (ESRCH) once SIGKILL has been delivered.
      killProbe: () => {
        if (sigkilled) {
          const err = new Error("no such process") as NodeJS.ErrnoException;
          err.code = "ESRCH";
          throw err;
        }
      },
      setTimeoutFn: ((fn: () => void) => (fn(), 0)) as never,
    },
  );
  return { transport, child, spawnCalls, killCalls };
}

describe("SuperStdioTransport", () => {
  it("spawns with the EXACT env (no host merge) in its own process group", async () => {
    const { transport, spawnCalls } = setup();
    await transport.start();
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].command).toBe("/abs/bin/run");
    expect(spawnCalls[0].args).toEqual(["mcp"]);
    expect(spawnCalls[0].opts.cwd).toBe("/install");
    expect(spawnCalls[0].opts.env).toEqual({ PATH: "/usr/bin:/bin", HOME: "/h" }); // exact, not merged
    expect(spawnCalls[0].opts.detached).toBe(true);
  });

  it("parses newline-delimited JSON-RPC messages (including split chunks)", async () => {
    const { transport, child } = setup();
    const messages: unknown[] = [];
    transport.onmessage = (m) => messages.push(m);
    await transport.start();
    child.stdout.write('{"jsonrpc":"2.0","id":1,"result":{}}\n{"jsonrpc":"2.0","me');
    child.stdout.write('thod":"x"}\n');
    await new Promise((r) => setImmediate(r));
    expect(messages).toEqual([
      { jsonrpc: "2.0", id: 1, result: {} },
      { jsonrpc: "2.0", method: "x" },
    ]);
  });

  it("reports a malformed JSON-RPC line via onerror without throwing", async () => {
    const { transport, child } = setup();
    const errors: Error[] = [];
    transport.onerror = (e) => errors.push(e);
    await transport.start();
    child.stdout.write("not json\n");
    await new Promise((r) => setImmediate(r));
    expect(errors[0].message).toMatch(/malformed JSON-RPC/);
  });

  it("drains stderr without backpressure or crashing", async () => {
    const { transport, child } = setup();
    await transport.start();
    expect(() => child.stderr.write("a".repeat(100000))).not.toThrow();
  });

  it("send writes newline-delimited JSON to stdin", async () => {
    const { transport, child } = setup();
    await transport.start();
    await transport.send({ jsonrpc: "2.0", id: 1, method: "ping" } as never);
    expect(child.stdinWrites).toEqual(['{"jsonrpc":"2.0","id":1,"method":"ping"}\n']);
  });

  it("close kills the whole process GROUP (SIGTERM then SIGKILL) and fires onclose", async () => {
    const { transport, killCalls } = setup();
    let closed = false;
    transport.onclose = () => (closed = true);
    await transport.start();
    await transport.close();
    expect(killCalls).toEqual([
      { pid: -4242, signal: "SIGTERM" }, // negative pid = process group
      { pid: -4242, signal: "SIGKILL" },
    ]);
    expect(closed).toBe(true);
  });

  it("rejects send before start", async () => {
    const { transport } = setup();
    await expect(transport.send({ jsonrpc: "2.0", id: 1, method: "x" } as never)).rejects.toThrow(/not connected/);
  });
});
