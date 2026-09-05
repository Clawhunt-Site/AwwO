import { describe, expect, it, vi } from "vitest";
import { createPluginBridge, sanitizeToolName, type FetchImpl } from "./plugin-bridge.js";
import { readPluginBridgeConfig, normalizeApiUrl } from "./plugin-bridge-config.js";

const CONFIG = {
  apiUrl: "http://127.0.0.1:3100/api",
  apiKey: "run-jwt-token",
  agentId: "agent-1",
  companyId: "co-1",
  runId: "run-1",
  projectId: "proj-1",
};

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

describe("sanitizeToolName", () => {
  it("replaces colon and dot (MCP-unsafe) with underscore", () => {
    expect(sanitizeToolName("acme.linear:search-issues")).toBe("acme_linear_search-issues");
  });
});

describe("readPluginBridgeConfig", () => {
  it("fails closed when any required field is missing", () => {
    expect(() => readPluginBridgeConfig({ SUPERCLAW_API_URL: "x", SUPERCLAW_API_KEY: "y" } as never)).toThrow(
      /missing required env/,
    );
  });

  it("reads all fields and SUPERCLAW wins over PAPERCLIP; apiUrl normalized to /api", () => {
    const cfg = readPluginBridgeConfig({
      SUPERCLAW_API_URL: "http://h:3100",
      PAPERCLIP_API_URL: "http://other",
      SUPERCLAW_API_KEY: "k",
      SUPERCLAW_AGENT_ID: "a",
      SUPERCLAW_COMPANY_ID: "c",
      SUPERCLAW_RUN_ID: "r",
      SUPERCLAW_PROJECT_ID: "p",
    } as never);
    expect(cfg.apiUrl).toBe("http://h:3100/api");
    expect(cfg).toMatchObject({ apiKey: "k", agentId: "a", companyId: "c", runId: "r", projectId: "p" });
  });

  it("normalizeApiUrl is idempotent and trims trailing slashes", () => {
    expect(normalizeApiUrl("http://h/api/")).toBe("http://h/api");
    expect(normalizeApiUrl("http://h")).toBe("http://h/api");
  });
});

describe("createPluginBridge.listTools", () => {
  it("maps host tools to MCP shape with sanitized names and JSON-schema passthrough", async () => {
    const fetchImpl: FetchImpl = vi.fn(async (url) => {
      expect(url).toBe("http://127.0.0.1:3100/api/plugins/tools");
      return jsonResponse(200, [
        {
          name: "acme.linear:search",
          displayName: "Search",
          description: "Search issues",
          parametersSchema: { type: "object", properties: { q: { type: "string" } } },
        },
      ]);
    });
    const bridge = createPluginBridge(CONFIG, fetchImpl);
    const out = await bridge.listTools();
    expect(out.tools).toEqual([
      {
        name: "acme_linear_search",
        description: "Search issues",
        inputSchema: { type: "object", properties: { q: { type: "string" } } },
      },
    ]);
  });

  it("disambiguates lossy-sanitize collisions so each tool maps back uniquely", async () => {
    const fetchImpl: FetchImpl = vi.fn(async (url, init) => {
      if (url.endsWith("/plugins/tools")) {
        return jsonResponse(200, [
          { name: "a.b:c", parametersSchema: { type: "object" } },
          { name: "a_b:c", parametersSchema: { type: "object" } }, // sanitizes to the same base
        ]);
      }
      return jsonResponse(200, { body: JSON.parse(init.body ?? "{}"), result: { content: "ok" } });
    });
    const bridge = createPluginBridge(CONFIG, fetchImpl);
    const list = await bridge.listTools();
    const names = list.tools.map((t) => t.name);
    expect(new Set(names).size).toBe(2); // no duplicate advertised name
    expect(names).toContain("a_b_c");
    expect(names).toContain("a_b_c_2");

    // each disambiguated name resolves to its DISTINCT original
    const posted: string[] = [];
    const fetch2: FetchImpl = vi.fn(async (url, init) => {
      if (url.endsWith("/plugins/tools")) {
        return jsonResponse(200, [
          { name: "a.b:c", parametersSchema: { type: "object" } },
          { name: "a_b:c", parametersSchema: { type: "object" } },
        ]);
      }
      posted.push((JSON.parse(init.body ?? "{}") as { tool: string }).tool);
      return jsonResponse(200, { result: { content: "ok" } });
    });
    const b2 = createPluginBridge(CONFIG, fetch2);
    await b2.listTools();
    await b2.callTool("a_b_c", {});
    await b2.callTool("a_b_c_2", {});
    // Order-agnostic: each disambiguated name resolves to a DISTINCT original
    // (no collision), and together they cover both originals. (Which original
    // gets the base vs `_2` is a deterministic function of the sort, but we
    // don't hardcode it here.)
    expect(new Set(posted)).toEqual(new Set(["a.b:c", "a_b:c"]));
    expect(posted[0]).not.toBe(posted[1]);
  });

  it("produces the SAME name->tool mapping regardless of host list order (deterministic sort)", async () => {
    const listFor = (order: string[]): FetchImpl => {
      const calls: string[] = [];
      const impl = (async (url: string, init: { body?: string }) => {
        if (url.endsWith("/plugins/tools")) {
          return jsonResponse(200, order.map((name) => ({ name, parametersSchema: { type: "object" } })));
        }
        calls.push((JSON.parse(init.body ?? "{}") as { tool: string }).tool);
        return jsonResponse(200, { result: { content: "ok" } });
      }) as unknown as FetchImpl;
      return Object.assign(impl, { calls });
    };
    const forward = listFor(["a.b:c", "a_b:c"]);
    const reverse = listFor(["a_b:c", "a.b:c"]); // host returns them in the OTHER order
    const bf = createPluginBridge(CONFIG, forward);
    const br = createPluginBridge(CONFIG, reverse);
    await bf.listTools();
    await br.listTools();
    await bf.callTool("a_b_c", {});
    await br.callTool("a_b_c", {});
    // Same MCP name resolves to the same original regardless of host order.
    expect((forward as unknown as { calls: string[] }).calls[0]).toBe(
      (reverse as unknown as { calls: string[] }).calls[0],
    );
  });

  it("throws on non-ok list response", async () => {
    const fetchImpl: FetchImpl = vi.fn(async () => jsonResponse(500, { error: "boom" }));
    await expect(createPluginBridge(CONFIG, fetchImpl).listTools()).rejects.toThrow(/list tools failed/);
  });
});

describe("createPluginBridge.callTool", () => {
  it("posts the host-bound runContext and business-only params, never model-supplied identity", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl: FetchImpl = vi.fn(async (url, init) => {
      if (url.endsWith("/plugins/tools")) {
        return jsonResponse(200, [{ name: "acme.linear:search", parametersSchema: { type: "object" } }]);
      }
      calls.push({ url, body: JSON.parse(init.body ?? "{}") });
      return jsonResponse(200, { pluginId: "acme.linear", toolName: "search", result: { content: "hi" } });
    });
    const bridge = createPluginBridge(CONFIG, fetchImpl);
    await bridge.listTools();
    const res = await bridge.callTool("acme_linear_search", {
      q: "x",
      // even if the model tries to inject identity, it stays in params and the
      // bridge overrides runContext from config:
      agentId: "EVIL",
      runId: "EVIL",
    });

    expect(res).toEqual({ content: [{ type: "text", text: "hi" }], isError: false });
    expect(calls[0].url).toBe("http://127.0.0.1:3100/api/plugins/tools/execute");
    expect(calls[0].body).toEqual({
      tool: "acme.linear:search",
      parameters: { q: "x", agentId: "EVIL", runId: "EVIL" },
      runContext: { agentId: "agent-1", companyId: "co-1", runId: "run-1", projectId: "proj-1" },
    });
  });

  it("refreshes the registry when called with a cold/unknown sanitized name", async () => {
    let listCount = 0;
    const fetchImpl: FetchImpl = vi.fn(async (url) => {
      if (url.endsWith("/plugins/tools")) {
        listCount += 1;
        return jsonResponse(200, [{ name: "acme.linear:search", parametersSchema: { type: "object" } }]);
      }
      return jsonResponse(200, { result: { content: "ok" } });
    });
    const bridge = createPluginBridge(CONFIG, fetchImpl);
    // No prior listTools(): registry cold -> callTool must refresh once.
    const res = await bridge.callTool("acme_linear_search", {});
    expect(res.isError).toBe(false);
    expect(listCount).toBe(1);
  });

  it("returns isError for a genuinely unknown tool", async () => {
    const fetchImpl: FetchImpl = vi.fn(async () => jsonResponse(200, []));
    const res = await createPluginBridge(CONFIG, fetchImpl).callTool("nope", {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/unknown tool/);
  });

  it("maps a host error result to an MCP error", async () => {
    const fetchImpl: FetchImpl = vi.fn(async (url) => {
      if (url.endsWith("/plugins/tools")) {
        return jsonResponse(200, [{ name: "acme.linear:search", parametersSchema: { type: "object" } }]);
      }
      return jsonResponse(200, { result: { error: "tool blew up" } });
    });
    const bridge = createPluginBridge(CONFIG, fetchImpl);
    await bridge.listTools();
    const res = await bridge.callTool("acme_linear_search", {});
    expect(res).toEqual({ content: [{ type: "text", text: "tool blew up" }], isError: true });
  });

  it("maps a non-ok execute response to an MCP error (not a throw)", async () => {
    const fetchImpl: FetchImpl = vi.fn(async (url) => {
      if (url.endsWith("/plugins/tools")) {
        return jsonResponse(200, [{ name: "acme.linear:search", parametersSchema: { type: "object" } }]);
      }
      return jsonResponse(403, { error: "runContext does not match the authenticated agent" });
    });
    const bridge = createPluginBridge(CONFIG, fetchImpl);
    await bridge.listTools();
    const res = await bridge.callTool("acme_linear_search", {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/403/);
  });

  it("passes the abort signal through to the host fetch", async () => {
    const ctrl = new AbortController();
    let seenSignal: AbortSignal | undefined;
    const fetchImpl: FetchImpl = vi.fn(async (url, init) => {
      if (url.endsWith("/plugins/tools")) {
        return jsonResponse(200, [{ name: "acme.linear:search", parametersSchema: { type: "object" } }]);
      }
      seenSignal = init.signal;
      return jsonResponse(200, { result: { content: "ok" } });
    });
    const bridge = createPluginBridge(CONFIG, fetchImpl);
    await bridge.listTools();
    await bridge.callTool("acme_linear_search", {}, ctrl.signal);
    expect(seenSignal).toBe(ctrl.signal);
  });
});
