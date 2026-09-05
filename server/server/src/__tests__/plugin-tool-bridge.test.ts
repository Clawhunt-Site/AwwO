/**
 * Coverage for the agent-capability bridge P0 slice 1 (see
 * `docs/node-agent-capability-bridge-design.md` §3 blockers 3 & 4):
 *
 *   - Blocker 4: tool-call parameters are validated server-side against the
 *     declared JSON Schema BEFORE any dispatch, fail-closed. The MCP schema
 *     only guides the model; the host must re-check.
 *   - Blocker 3: the dispatcher executes through the governed
 *     `plugin-runtime-router.executeTool` (super provenance / digest / dual-store
 *     conflict live there) instead of hitting the native registry directly, and
 *     adapts a super NormalizedToolResult into the dispatcher's ToolResult.
 */

import { describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import {
  assertValidToolParameters,
  ToolParameterValidationError,
} from "../services/plugin-tool-schema.js";

// ---------------------------------------------------------------------------
// Router mock — lets us observe routing and inject runtime results without a DB.
// ---------------------------------------------------------------------------
vi.mock("../services/plugin-runtime-router.js", () => ({
  executeTool: vi.fn(),
  PluginRuntimeRouterError: class PluginRuntimeRouterError extends Error {},
}));
vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => ({
    getByKey: async () => null,
    listByStatus: async () => [],
  }),
}));

import { executeTool as routeMock } from "../services/plugin-runtime-router.js";
import { createPluginToolDispatcher } from "../services/plugin-tool-dispatcher.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

const PLUGIN_KEY = "acme.demo";
const PLUGIN_DB_ID = "00000000-0000-4000-8000-000000000001";

function manifestWithSchema(schema: Record<string, unknown>): PaperclipPluginManifestV1 {
  return {
    id: PLUGIN_KEY,
    apiVersion: 1,
    version: "1.0.0",
    displayName: "Demo plugin",
    description: "Bridge fixture",
    author: "Acme",
    categories: ["automation"],
    capabilities: [],
    entrypoints: { worker: "dist/worker.js" },
    tools: [
      { name: "search", displayName: "Search", description: "t", parametersSchema: schema },
    ],
  } as unknown as PaperclipPluginManifestV1;
}

function workerManagerStub(): PluginWorkerManager {
  const isRunning = vi.fn(() => true);
  return {
    startWorker: vi.fn(),
    stopWorker: vi.fn(),
    getWorker: vi.fn(),
    isRunning,
    stopAll: vi.fn(),
    diagnostics: vi.fn(() => []),
    call: vi.fn(async () => ({ content: "ok" })),
  } as unknown as PluginWorkerManager;
}

const RUN_CTX = { agentId: "a", runId: "r", companyId: "c", projectId: "p" };

// ---------------------------------------------------------------------------
// Blocker 4 — schema helper (pure, fail-closed)
// ---------------------------------------------------------------------------
describe("assertValidToolParameters — server-side schema enforcement", () => {
  const schema = {
    type: "object",
    required: ["query"],
    properties: { query: { type: "string" } },
    additionalProperties: false,
  };

  it("accepts parameters that satisfy the schema", () => {
    expect(() => assertValidToolParameters(schema, { query: "hi" }, "acme:search")).not.toThrow();
  });

  it("rejects missing required field", () => {
    expect(() => assertValidToolParameters(schema, {}, "acme:search")).toThrow(
      ToolParameterValidationError,
    );
  });

  it("rejects wrong type", () => {
    expect(() => assertValidToolParameters(schema, { query: 7 }, "acme:search")).toThrow(
      ToolParameterValidationError,
    );
  });

  it("rejects undeclared extra field when additionalProperties:false", () => {
    expect(() =>
      assertValidToolParameters(schema, { query: "x", evil: 1 }, "acme:search"),
    ).toThrow(ToolParameterValidationError);
  });

  it("treats no-schema + supplied args as out of contract (fail-closed)", () => {
    expect(() => assertValidToolParameters(undefined, { a: 1 }, "acme:noargs")).toThrow(
      ToolParameterValidationError,
    );
  });

  it("accepts no-schema + empty args", () => {
    expect(() => assertValidToolParameters(undefined, {}, "acme:noargs")).not.toThrow();
    expect(() => assertValidToolParameters({}, undefined, "acme:noargs")).not.toThrow();
  });

  it("treats an uncompilable schema as a failure, not a pass (fail-closed)", () => {
    expect(() =>
      assertValidToolParameters({ type: "not-a-real-type" }, { a: 1 }, "acme:bad"),
    ).toThrow(ToolParameterValidationError);
  });

  it("rejects async ($async) schemas instead of failing open (Promise is truthy)", () => {
    // `if (!validate(x))` would admit invalid input if validate returned a Promise.
    expect(() =>
      assertValidToolParameters(
        { $async: true, type: "object", required: ["x"], properties: { x: { type: "string" } } },
        {},
        "acme:async",
      ),
    ).toThrow(ToolParameterValidationError);
  });

  it("treats empty {} schema as allow-anything (JSON Schema semantics), not no-params", () => {
    // `{}` is a valid schema meaning 'any value' — must NOT be reinterpreted as
    // 'tool declares no parameters' (that would mis-reject existing {} tools).
    expect(() => assertValidToolParameters({}, { anything: 1 }, "acme:empty")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Blocker 4 — no-DB path still enforces schema before registry dispatch
// ---------------------------------------------------------------------------
describe("dispatcher.executeTool (no DB) — schema enforced before dispatch", () => {
  it("rejects invalid params before calling the worker", async () => {
    const workerManager = workerManagerStub();
    const dispatcher = createPluginToolDispatcher({ workerManager });
    dispatcher.registerPluginTools(
      PLUGIN_KEY,
      manifestWithSchema({ type: "object", required: ["query"], properties: { query: { type: "string" } } }),
      PLUGIN_DB_ID,
    );

    await expect(
      dispatcher.executeTool(`${PLUGIN_KEY}:search`, { wrong: 1 }, RUN_CTX),
    ).rejects.toThrow(ToolParameterValidationError);
    expect(workerManager.call).not.toHaveBeenCalled();
  });

  it("dispatches when params satisfy the schema", async () => {
    const workerManager = workerManagerStub();
    const dispatcher = createPluginToolDispatcher({ workerManager });
    dispatcher.registerPluginTools(
      PLUGIN_KEY,
      manifestWithSchema({ type: "object", required: ["query"], properties: { query: { type: "string" } } }),
      PLUGIN_DB_ID,
    );

    await expect(
      dispatcher.executeTool(`${PLUGIN_KEY}:search`, { query: "hi" }, RUN_CTX),
    ).resolves.toBeDefined();
    expect(workerManager.call).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Blocker 3 — DB path routes through the governed runtime-router
// ---------------------------------------------------------------------------
describe("dispatcher.executeTool (with DB) — routes through runtime-router", () => {
  it("invokes plugin-runtime-router and adapts a super result into ToolResult", async () => {
    vi.mocked(routeMock).mockResolvedValueOnce({
      kind: "super",
      result: { text: "hello", structured: { a: 1 }, blockTypes: [], isError: false },
    } as never);

    const workerManager = workerManagerStub();
    const dispatcher = createPluginToolDispatcher({ workerManager, db: {} as never });

    const out = await dispatcher.executeTool(`${PLUGIN_KEY}:search`, { query: "x" }, RUN_CTX);

    // Routed through the governed router, not the registry directly.
    expect(routeMock).toHaveBeenCalledTimes(1);
    const args = vi.mocked(routeMock).mock.calls[0];
    expect(args[1]).toBe(PLUGIN_KEY); // pluginId/pluginKey
    expect(args[2]).toBe("search"); // bare tool name
    expect(args[3]).toEqual({ query: "x" }); // business params only
    // deps carry the three runtime hooks.
    const deps = args[4] as Record<string, unknown>;
    expect(typeof deps.callSuperTool).toBe("function");
    expect(typeof deps.dispatchPaperclipTool).toBe("function");
    expect(typeof deps.isPaperclipPlugin).toBe("function");

    // NormalizedToolResult → ToolResult adaptation.
    expect(out.pluginId).toBe(PLUGIN_KEY);
    expect(out.toolName).toBe("search");
    expect(out.result.content).toBe("hello");
    expect(out.result.data).toEqual({ a: 1 });
    expect(out.result.error).toBeUndefined();

    // The worker was never hit directly — the router owns dispatch.
    expect(workerManager.call).not.toHaveBeenCalled();
  });

  it("surfaces a super isError result as a ToolResult error", async () => {
    vi.mocked(routeMock).mockResolvedValueOnce({
      kind: "super",
      result: { text: "boom", structured: null, blockTypes: [], isError: true },
    } as never);

    const dispatcher = createPluginToolDispatcher({ workerManager: workerManagerStub(), db: {} as never });
    const out = await dispatcher.executeTool(`${PLUGIN_KEY}:search`, {}, RUN_CTX);
    expect(out.result.error).toBe("boom");
  });

  it("rejects an invalid namespaced tool name", async () => {
    const dispatcher = createPluginToolDispatcher({ workerManager: workerManagerStub(), db: {} as never });
    await expect(dispatcher.executeTool("no-colon-name", {}, RUN_CTX)).rejects.toThrow();
  });

  // The deps closures carry the ACTUAL server-side schema enforcement on the DB
  // path. Drive them via a router mock that invokes the host hooks, so blocker 4
  // can't silently regress on the production (DB) path.
  it("DB path: callSuperTool validates super inputSchema before sidecar dispatch", async () => {
    vi.mocked(routeMock).mockImplementationOnce(
      async (_db: unknown, _pk: unknown, tn: unknown, input: unknown, deps: unknown) => {
        const record = {
          tools: [
            {
              name: tn,
              inputSchema: { type: "object", required: ["x"], properties: { x: { type: "string" } } },
            },
          ],
        };
        const d = deps as { callSuperTool: (r: unknown, t: unknown, i: unknown) => Promise<unknown> };
        return { kind: "super", result: await d.callSuperTool(record, tn, input) };
      },
    );
    const dispatcher = createPluginToolDispatcher({ workerManager: workerManagerStub(), db: {} as never });
    await expect(
      dispatcher.executeTool(`${PLUGIN_KEY}:search`, { wrong: 1 }, RUN_CTX),
    ).rejects.toThrow(ToolParameterValidationError);
  });

  it("DB path: dispatchPaperclipTool validates parametersSchema before worker dispatch", async () => {
    const workerManager = workerManagerStub();
    const dispatcher = createPluginToolDispatcher({ workerManager, db: {} as never });
    dispatcher.registerPluginTools(
      PLUGIN_KEY,
      manifestWithSchema({ type: "object", required: ["query"], properties: { query: { type: "string" } } }),
      PLUGIN_DB_ID,
    );
    vi.mocked(routeMock).mockImplementationOnce(
      async (_db: unknown, pk: unknown, tn: unknown, input: unknown, deps: unknown) => {
        const d = deps as { dispatchPaperclipTool: (k: unknown, t: unknown, i: unknown) => Promise<unknown> };
        return { kind: "paperclip_js", result: await d.dispatchPaperclipTool(pk, tn, input) };
      },
    );
    await expect(
      dispatcher.executeTool(`${PLUGIN_KEY}:search`, { wrong: 1 }, RUN_CTX),
    ).rejects.toThrow(ToolParameterValidationError);
    expect(workerManager.call).not.toHaveBeenCalled();
  });

  // A typo'd paperclip tool must read as unknown (→ 404 at the route), NOT as a
  // schema violation (→400) nor a worker-down error (→502). Cover both arg shapes.
  it("DB path: unknown paperclip tool throws a not-declared error (not a schema/worker error)", async () => {
    vi.mocked(routeMock).mockImplementation(
      async (_db: unknown, pk: unknown, tn: unknown, input: unknown, deps: unknown) => {
        const d = deps as { dispatchPaperclipTool: (k: unknown, t: unknown, i: unknown) => Promise<unknown> };
        return { kind: "paperclip_js", result: await d.dispatchPaperclipTool(pk, tn, input) };
      },
    );
    const dispatcher = createPluginToolDispatcher({ workerManager: workerManagerStub(), db: {} as never });
    // No tool registered → getToolByPlugin returns null.
    await expect(
      dispatcher.executeTool(`${PLUGIN_KEY}:missing`, {}, RUN_CTX),
    ).rejects.toThrow(/does not declare tool/);
    await expect(
      dispatcher.executeTool(`${PLUGIN_KEY}:missing`, { any: 1 }, RUN_CTX),
    ).rejects.toThrow(/does not declare tool/);
    vi.mocked(routeMock).mockReset();
  });

  it("no-DB path: unknown tool throws a not-declared error for both arg shapes", async () => {
    const dispatcher = createPluginToolDispatcher({ workerManager: workerManagerStub() });
    await expect(dispatcher.executeTool(`${PLUGIN_KEY}:missing`, {}, RUN_CTX)).rejects.toThrow(
      /does not declare tool/,
    );
    await expect(
      dispatcher.executeTool(`${PLUGIN_KEY}:missing`, { any: 1 }, RUN_CTX),
    ).rejects.toThrow(/does not declare tool/);
  });
});
