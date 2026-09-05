/**
 * SuperClaw plugin-tool MCP bridge (Form A — docs/node-agent-capability-bridge-design.md §4.1).
 *
 * A stateless stdio MCP server the agent CLI spawns. It surfaces installed
 * plugin tools to the model and proxies tools/call to the governed host route
 * (POST /api/plugins/tools/execute), which enforces super provenance + schema +
 * agent-identity binding (slices 1+2). The bridge holds NO governance of its own;
 * it only translates MCP <-> the host's REST contract and binds the runContext
 * from host-issued env (never from model-supplied arguments).
 *
 * Engineering chokepoints (agy review): cancellation propagation (MCP abort ->
 * fetch AbortSignal), and never spawning untrusted children with the run JWT.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readPluginBridgeConfig, type PluginBridgeConfig } from "./plugin-bridge-config.js";

/** What the host's GET /api/plugins/tools returns per tool (AgentToolDescriptor). */
interface HostToolDescriptor {
  name: string; // fully namespaced, e.g. "acme.linear:search-issues"
  displayName?: string;
  description?: string;
  parametersSchema?: Record<string, unknown>;
}

/** What the host's POST /api/plugins/tools/execute returns (ToolExecutionResult). */
interface HostToolResult {
  result?: { content?: string; data?: unknown; error?: string };
}

export type FetchImpl = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

/**
 * Sanitize a namespaced tool name into an MCP-safe identifier. MCP clients
 * constrain tool names to a conservative charset; `plugin:tool` (with `:` and
 * `.`) is not safe. We replace disallowed chars with `_` and keep a registry of
 * sanitized -> original so tools/call can recover the exact namespaced name
 * (encoding alone is ambiguous; a registry is unambiguous).
 */
export function sanitizeToolName(namespaced: string): string {
  return namespaced.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function toMcpContent(result: HostToolResult["result"]): {
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
} {
  const r = result ?? {};
  if (r.error) {
    return { content: [{ type: "text", text: r.error }], isError: true };
  }
  if (typeof r.content === "string" && r.content.length > 0) {
    return { content: [{ type: "text", text: r.content }], isError: false };
  }
  if (r.data !== undefined) {
    return { content: [{ type: "text", text: JSON.stringify(r.data) }], isError: false };
  }
  return { content: [{ type: "text", text: "" }], isError: false };
}

export interface PluginBridge {
  /** MCP tools/list handler — fetches the host tool list, registers name mapping. */
  listTools(signal?: AbortSignal): Promise<{ tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> }>;
  /** MCP tools/call handler. `signal` propagates client cancellation to the host fetch. */
  callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ content: Array<{ type: "text"; text: string }>; isError: boolean }>;
}

/**
 * Build the bridge logic (transport-agnostic, fetch-injectable for tests).
 */
export function createPluginBridge(config: PluginBridgeConfig, fetchImpl: FetchImpl): PluginBridge {
  // sanitized MCP name -> original namespaced name, populated on every list.
  const nameRegistry = new Map<string, string>();

  const authHeaders = (): Record<string, string> => ({
    Authorization: `Bearer ${config.apiKey}`,
    "Content-Type": "application/json",
  });

  async function fetchHostTools(signal?: AbortSignal): Promise<HostToolDescriptor[]> {
    const res = await fetchImpl(`${config.apiUrl}/plugins/tools`, {
      method: "GET",
      headers: authHeaders(),
      signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`plugin bridge: list tools failed (${res.status}): ${text.slice(0, 200)}`);
    }
    const parsed = text ? (JSON.parse(text) as unknown) : [];
    return Array.isArray(parsed) ? (parsed as HostToolDescriptor[]) : [];
  }

  // Rebuild the sanitized-name -> original-namespaced-name registry from a host
  // tool list, disambiguating lossy-sanitize collisions (`a.b:c` and `a_b:c`
  // both -> `a_b_c`) with a numeric suffix. Returns the MCP-facing tool list.
  // Shared by tools/list and the cold-registry refresh in tools/call so both
  // advertise and resolve the SAME disambiguated names — never a wrong tool.
  function rebuildRegistry(hostTools: HostToolDescriptor[]) {
    nameRegistry.clear();
    // Sort by original name FIRST so collision disambiguation (`_2`, `_3`) is
    // deterministic: the host list order is not guaranteed stable, and an
    // order-dependent suffix would make a sanitized name point at a different
    // tool across refreshes — the model would then call the wrong tool. Use a
    // raw codepoint comparison (NOT localeCompare, whose ordering varies by
    // locale/ICU) so the order is identical on every host.
    const ordered = [...hostTools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return ordered.map((t) => {
      const base = sanitizeToolName(t.name);
      let safe = base;
      for (let i = 2; nameRegistry.has(safe); i += 1) safe = `${base}_${i}`;
      nameRegistry.set(safe, t.name);
      return {
        name: safe,
        description: t.description ?? t.displayName ?? t.name,
        inputSchema:
          t.parametersSchema && typeof t.parametersSchema === "object"
            ? t.parametersSchema
            : { type: "object" },
      };
    });
  }

  return {
    async listTools(signal?: AbortSignal) {
      return { tools: rebuildRegistry(await fetchHostTools(signal)) };
    },

    async callTool(name, args, signal) {
      // Recover the original namespaced name. If the registry is cold (call
      // before list, or a stale name), refresh once before giving up.
      try {
        // Recover the original namespaced name; refresh once if cold/stale. This
        // fetch is inside the try so a cold-start list failure surfaces as a tool
        // error, not an unhandled throw the SDK turns into an opaque error.
        let namespaced = nameRegistry.get(name);
        if (!namespaced) {
          rebuildRegistry(await fetchHostTools(signal));
          namespaced = nameRegistry.get(name);
        }
        if (!namespaced) {
          return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
        }

        const res = await fetchImpl(`${config.apiUrl}/plugins/tools/execute`, {
          method: "POST",
          headers: authHeaders(),
          // runContext is host-bound: assembled from host-issued env, NEVER from
          // the model's arguments. parameters carries ONLY the business args.
          body: JSON.stringify({
            tool: namespaced,
            parameters: args ?? {},
            runContext: {
              agentId: config.agentId,
              companyId: config.companyId,
              runId: config.runId,
              projectId: config.projectId,
            },
          }),
          signal,
        });
        const text = await res.text();
        if (!res.ok) {
          return {
            content: [{ type: "text", text: `tool execution failed (${res.status}): ${text.slice(0, 300)}` }],
            isError: true,
          };
        }
        const parsed = text ? (JSON.parse(text) as HostToolResult) : {};
        return toMcpContent(parsed.result);
      } catch (err) {
        // Transport/parse failures (ECONNREFUSED, aborted, malformed JSON) must
        // surface as a tool error, not an unhandled throw that the SDK turns
        // into an opaque internal JSON-RPC error.
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `tool execution error: ${msg}` }], isError: true };
      }
    },
  };
}

/**
 * Wire the bridge onto an MCP low-level Server (raw JSON-Schema pass-through —
 * the high-level `McpServer.tool` expects zod, but plugin tools carry JSON
 * Schema, so we register handlers directly).
 */
export function createPluginBridgeServer(bridge: PluginBridge): Server {
  const server = new Server(
    { name: "superclaw-plugins", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async (_req, extra) => bridge.listTools(extra?.signal));

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const { name, arguments: args } = req.params;
    return bridge.callTool(name, (args ?? {}) as Record<string, unknown>, extra?.signal);
  });

  return server;
}

/** Bin entrypoint: read host-issued env, connect over stdio. */
export async function runPluginBridge(): Promise<void> {
  const config = readPluginBridgeConfig();
  const bridge = createPluginBridge(config, globalThis.fetch as unknown as FetchImpl);
  const server = createPluginBridgeServer(bridge);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
