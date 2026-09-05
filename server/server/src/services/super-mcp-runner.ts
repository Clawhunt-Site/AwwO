import { Client } from "@modelcontextprotocol/sdk/client/index.js";

import { resolveSpawnSpec, type ExecPreflightOptions } from "./super-plugin-exec.js";
import type { SuperPluginRuntimeRecord } from "./super-plugin-runtime-store.js";
import { SuperStdioTransport } from "./super-stdio-transport.js";

/** Default connect (spawn + MCP initialize handshake) timeout. */
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

/**
 * Super-plugin MCP runner (P4 of the dual plugin runtime).
 *
 * Runs a super plugin's tool by spawning its process (an mcp_sidecar binary or an
 * external_mcp launcher, both speaking MCP over stdio) and driving it with the
 * MCP client. Per-call (MVP): open a session, call one tool, tear down — no
 * pooling. The exec governance (P3) is re-run IMMEDIATELY before each spawn (a
 * stored SpawnSpec is not a long-term authorization — TOCTOU).
 *
 * env: the child gets ONLY the P3-narrowed spawn env (no host env / no host PATH),
 * NOT the MCP SDK's getDefaultEnvironment() inheritance.
 */

export class SuperMcpRunError extends Error {}

export interface NormalizedToolResult {
  readonly text: string;
  readonly structured: unknown;
  readonly blockTypes: string[];
  readonly isError: boolean;
}

/**
 * Normalize an MCP `tools/call` result into a stable envelope (port of
 * plugin_proxy.py `_normalize_mcp_result`): join text blocks into `text`, pass
 * `structuredContent` through, record non-text block types (never inline raw
 * image/audio bytes), and surface the tool-level `isError` flag.
 */
export function normalizeMcpResult(result: unknown): NormalizedToolResult {
  const root = typeof result === "object" && result !== null ? (result as Record<string, unknown>) : {};
  const texts: string[] = [];
  const blockTypes: string[] = [];
  if (Array.isArray(root.content)) {
    for (const block of root.content) {
      if (typeof block !== "object" || block === null) continue;
      const b = block as Record<string, unknown>;
      const btype = typeof b.type === "string" ? b.type : "";
      if (btype === "text") texts.push(typeof b.text === "string" ? b.text : "");
      else blockTypes.push(btype || "unknown");
    }
  }
  const structured = root.structuredContent;
  return {
    text: texts.join("\n"),
    structured: structured !== null && typeof structured === "object" ? structured : null,
    blockTypes,
    isError: Boolean(root.isError),
  };
}

/** A live MCP session against one spawned plugin process. */
export interface McpSession {
  callTool(name: string, input: unknown): Promise<unknown>;
  close(): Promise<void>;
}

export interface SuperMcpRunDeps {
  /** Open a session (real adapter spawns + connects; injected fake in unit tests). */
  readonly openSession: () => Promise<McpSession>;
  /** Per-call timeout. On timeout the session is torn down (kills the process). */
  readonly timeoutMs: number;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new SuperMcpRunError(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Run `connect` under a timeout; on ANY failure (timeout or connect error) AWAIT
 * a single `teardown()` so the spawned process group is FULLY reaped before this
 * rejects — never a fire-and-forget close that could let the caller return while
 * SIGKILL is still pending. A catch is attached to the connect promise so a late
 * rejection (after the timeout won) is not unhandled.
 */
export async function connectWithTimeout(
  connect: () => Promise<void>,
  teardown: () => Promise<void>,
  timeoutMs: number,
): Promise<void> {
  const connecting = connect();
  connecting.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new SuperMcpRunError(`connect timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    await Promise.race([connecting, timeout]);
  } catch (err) {
    await teardown().catch(() => {});
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Call one tool on a super plugin and return the normalized result. Opens a
 * session, races the call against the timeout, and ALWAYS tears the session down
 * (so a hung/slow plugin process is killed, not leaked).
 */
export async function callSuperPluginTool(
  toolName: string,
  input: unknown,
  deps: SuperMcpRunDeps,
): Promise<NormalizedToolResult> {
  const session = await deps.openSession();
  let raw: unknown;
  try {
    raw = await withTimeout(session.callTool(toolName, input), deps.timeoutMs, "tool call");
  } catch (callErr) {
    // The call failed/timed out: tear down (reaping the spawned process), but let the
    // PRIMARY error win — a secondary teardown failure must not mask it.
    await session.close().catch(() => {});
    throw callErr;
  }
  // The call succeeded: a teardown failure here is the only thing that can go wrong, so
  // it is SURFACED (not swallowed) — a leaked, un-reaped process group is a real failure
  // the caller must learn about, not hide behind a successful-looking result.
  await session.close();
  return normalizeMcpResult(raw);
}

/**
 * Real session adapter: re-run the P3 exec preflight, spawn the validated process
 * via our own stdio transport (EXACT narrowed env, own process group, stderr
 * drained), and connect the MCP client under a connect timeout. Only stdio launch
 * targets are supported in the MVP (external_mcp sse/http is a later phase —
 * mirror plugin_proxy.py "external_mcp transport not supported yet").
 */
export async function openSuperMcpSession(
  record: SuperPluginRuntimeRecord,
  options: ExecPreflightOptions = {},
  runtime: { connectTimeoutMs?: number } = {},
): Promise<McpSession> {
  if (record.transport !== "stdio") {
    throw new SuperMcpRunError(`external_mcp transport not supported yet: ${record.transport}`);
  }
  // TOCTOU: validate the launch target RIGHT NOW, immediately before spawning.
  const spec = resolveSpawnSpec(record, options);
  const transport = new SuperStdioTransport({
    command: spec.argv[0],
    args: [...spec.argv.slice(1)],
    env: spec.env, // EXACT narrowed env — never the host env
    cwd: spec.cwd,
  });
  const client = new Client({ name: "superclaw-dual-runtime", version: "0.1.0" });
  // connect() spawns + runs the MCP initialize handshake — bound it, and AWAIT a
  // full teardown (killpg) on a hang/failure so nothing is left running.
  await connectWithTimeout(
    () => client.connect(transport),
    () => transport.close(),
    runtime.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
  );

  return {
    async callTool(name: string, input: unknown): Promise<unknown> {
      return client.callTool({ name, arguments: (input ?? {}) as Record<string, unknown> });
    },
    async close(): Promise<void> {
      // client.close() closes the transport (killpg); also close directly so the
      // process group is reaped even if the client teardown throws first.
      try {
        await client.close();
      } finally {
        await transport.close().catch(() => {});
      }
    },
  };
}
