import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockListServerAdapters = vi.hoisted(() => vi.fn());
const mockGetServerAdapter = vi.hoisted(() => vi.fn());
const mockListEnabledServerAdapters = vi.hoisted(() => vi.fn());
// chat-compat.isChatEligibleAdapter consults registry provenance; default to the
// trusted-builtin path so allow-listed types read as chat-capable unless a test
// flips it to simulate an external override.
const mockIsBuiltinAdapterActive = vi.hoisted(() => vi.fn((_type: string) => true));
// The lightweight probe reuses the shared `ensureCommandResolvable` primitive; mock
// it so reachability is deterministic (no real `which` against the host PATH).
const mockEnsureCommandResolvable = vi.hoisted(() => vi.fn());

vi.mock("../adapters/registry.js", () => ({
  listServerAdapters: mockListServerAdapters,
  getServerAdapter: mockGetServerAdapter,
  listEnabledServerAdapters: mockListEnabledServerAdapters,
  isBuiltinAdapterActive: mockIsBuiltinAdapterActive,
}));

// Partial mock: keep every real export (src/adapters/utils.ts re-exports
// runningProcesses/MAX_* from here) and only override the reachability primitive.
vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return { ...actual, ensureCommandResolvable: mockEnsureCommandResolvable };
});

const { chatRuntimeRoutes } = await import("../routes/chat-runtime.js");

function buildApp(deploymentMode: "local_trusted" | "authenticated") {
  const app = express();
  app.use(express.json());
  app.use("/api", chatRuntimeRoutes({ deploymentMode }));
  return app;
}

describe("chat runtime inventory routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListEnabledServerAdapters.mockReturnValue([]);
    // Default: the probed CLI resolves on PATH (override per-test to simulate
    // a missing/uninstalled runtime).
    mockEnsureCommandResolvable.mockResolvedValue(undefined);
  });

  it("projects /api/backends with model select + per-adapter effort capability + enabled availability", async () => {
    mockListServerAdapters.mockReturnValue([
      { type: "claude_local", models: [{ id: "claude-opus-4-8", label: "Opus" }, { id: "x", label: "X" }] },
      { type: "codex", models: [] },
    ]);
    // claude_local enabled; "codex" registered but DISABLED.
    mockListEnabledServerAdapters.mockReturnValue([{ type: "claude_local", models: [] }]);
    const res = await request(buildApp("local_trusted")).get("/api/backends");
    expect(res.status).toBe(200);
    const [first, second] = res.body.backends;
    expect(first.name).toBe("claude_local");
    expect(first.supports_model_selection).toBe(true);
    expect(first.default_model).toBe("claude-opus-4-8");
    expect(first.suggested_models).toEqual(["claude-opus-4-8", "x"]);
    // claude_local has a real effort axis → reported per-adapter (not flat false).
    expect(first.supports_effort_selection).toBe(true);
    expect(first.effort_levels).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(first.effort_input_mode).toBe("select");
    expect(first.chat_capable).toBe(true);
    expect(first.available).toBe(true);
    expect(first.chat_tier).toBe("native");
    expect(second.supports_model_selection).toBe(false);
    expect(second.default_model).toBeNull();
    // "codex" (not "codex_local") has no native effort axis here → still false.
    expect(second.supports_effort_selection).toBe(false);
    expect(second.effort_levels).toEqual([]);
    // Disabled adapter reads as unavailable so the composer hides it.
    expect(second.available).toBe(false);
    // Fail-closed chat eligibility: "codex" is NOT on the chat allow-list (only
    // "codex_local" is), so the inventory must report it non-chat-capable — the
    // composer never offers a runtime the chat run path would refuse.
    expect(second.chat_capable).toBe(false);
    expect(second.chat_tier).toBeNull();
  });

  it("reports grok_local as NOT effort-capable (no Grok model honors a unified effort axis)", async () => {
    mockListServerAdapters.mockReturnValue([{ type: "grok_local", models: [] }]);
    mockListEnabledServerAdapters.mockReturnValue([{ type: "grok_local", models: [] }]);
    const res = await request(buildApp("local_trusted")).get("/api/backends");
    expect(res.status).toBe(200);
    const [grok] = res.body.backends;
    expect(grok.name).toBe("grok_local");
    // grok's CLI has an --effort flag, but no Grok model reliably honors a
    // reasoning-effort selection — the surface must not offer the picker.
    expect(grok.supports_effort_selection).toBe(false);
    expect(grok.effort_levels).toEqual([]);
    expect(grok.effort_input_mode).toBeNull();
  });

  it("reports chat_capable:false for an allow-listed type that an external adapter overrode", async () => {
    // gemini_local IS on the chat allow-list, but provenance says the active
    // module is an external override → the inventory must NOT advertise it as chat.
    mockListServerAdapters.mockReturnValue([{ type: "gemini_local", models: [] }]);
    mockListEnabledServerAdapters.mockReturnValue([{ type: "gemini_local", models: [] }]);
    mockIsBuiltinAdapterActive.mockImplementation((t: string) => t !== "gemini_local");
    const res = await request(buildApp("local_trusted")).get("/api/backends");
    expect(res.status).toBe(200);
    const [only] = res.body.backends;
    expect(only.name).toBe("gemini_local");
    expect(only.available).toBe(true);
    expect(only.chat_capable).toBe(false);
    expect(only.chat_tier).toBeNull();
    mockIsBuiltinAdapterActive.mockImplementation(() => true);
  });

  it("/api/agents returns the inventory plus a summary (ready_count = enabled count)", async () => {
    mockListServerAdapters.mockReturnValue([
      { type: "claude_local", models: [] },
      { type: "codex_local", models: [] },
    ]);
    // Only claude_local enabled → ready_count is 1 of 2 registered.
    mockListEnabledServerAdapters.mockReturnValue([{ type: "claude_local", models: [] }]);
    const res = await request(buildApp("local_trusted")).get("/api/agents");
    expect(res.status).toBe(200);
    expect(res.body.summary).toEqual({ count: 2, ready_count: 1 });
    expect(res.body.agents[0].name).toBe("claude_local");
    expect(res.body.agents[0].available).toBe(true);
    expect(res.body.agents[1].available).toBe(false);
  });

  it("/api/agents/:backend/models projects the adapter's model ids as a string[]", async () => {
    mockGetServerAdapter.mockReturnValue({ type: "claude_local", models: [{ id: "m1", label: "M1" }] });
    const res = await request(buildApp("local_trusted")).get("/api/agents/claude_local/models");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: "claude_local", source: "static_contract" });
    expect(res.body.models).toEqual(["m1"]);
  });

  it("returns 404 models for an unknown backend (process-adapter fallback detected)", async () => {
    // getServerAdapter returns the built-in process adapter for unknown types.
    mockGetServerAdapter.mockReturnValue({ type: "process", models: [] });
    const res = await request(buildApp("local_trusted")).get("/api/agents/nope/models");
    expect(res.status).toBe(404);
  });

  it("/api/agents/probe (lightweight) reports runtime_present/shallow when the CLI resolves — presence, NOT live-ready", async () => {
    // Mirrors the CLI kernel (runtime_probe.py): a command on disk proves PRESENCE
    // only; live reachability is unverified, so it must be runtime_present/shallow.
    // runtime_ready is reserved for a deep/live testEnvironment pass.
    mockListServerAdapters.mockReturnValue([
      {
        type: "claude_local",
        models: [{ id: "claude-opus-4-8", label: "Opus" }],
        getRuntimeCommandSpec: () => ({ command: "claude", detectCommand: "claude" }),
      },
    ]);
    mockEnsureCommandResolvable.mockResolvedValue(undefined);
    const res = await request(buildApp("local_trusted")).get("/api/agents/probe?backend=claude_local");
    expect(res.status).toBe(200);
    expect(res.body.probes).toEqual([
      expect.objectContaining({
        backend: "claude_local",
        verdict: "runtime_present",
        depth: "shallow",
        present: true,
        models_count: 1,
        default_model: "claude-opus-4-8",
      }),
    ]);
    // Probes the adapter's OWN declared detectCommand via the shared primitive.
    expect(mockEnsureCommandResolvable).toHaveBeenCalledWith("claude", expect.any(String), expect.anything());
  });

  it("/api/agents/probe (lightweight) reports runtime_fail/none when the CLI is NOT installed (fixes registry fail-open)", async () => {
    mockListServerAdapters.mockReturnValue([
      { type: "codex_local", models: [], getRuntimeCommandSpec: () => ({ command: "codex", detectCommand: "codex" }) },
    ]);
    mockEnsureCommandResolvable.mockRejectedValue(new Error('Command not found in PATH: "codex"'));
    const res = await request(buildApp("local_trusted")).get("/api/agents/probe?backend=codex_local");
    expect(res.status).toBe(200);
    expect(res.body.probes[0]).toMatchObject({
      backend: "codex_local",
      verdict: "runtime_fail",
      depth: "none",
      present: false,
    });
    expect(res.body.probes[0].failure_reason).toContain("not found");
  });

  it("/api/agents/probe (lightweight) isolates a throwing getRuntimeCommandSpec to that runtime's runtime_fail (no 500 for the batch)", async () => {
    mockListServerAdapters.mockReturnValue([
      {
        type: "evil_external",
        models: [],
        getRuntimeCommandSpec: () => {
          throw new Error("external adapter boom");
        },
      },
      { type: "claude_local", models: [], getRuntimeCommandSpec: () => ({ command: "claude" }) },
    ]);
    mockEnsureCommandResolvable.mockResolvedValue(undefined);
    const res = await request(buildApp("local_trusted")).get("/api/agents/probe");
    expect(res.status).toBe(200); // batch survives the one bad adapter
    const evil = res.body.probes.find((p: { backend: string }) => p.backend === "evil_external");
    expect(evil).toMatchObject({ verdict: "runtime_fail", depth: "none", present: false });
    expect(evil.failure_reason).toContain("boom");
    // the healthy adapter still probed normally
    expect(res.body.probes.find((p: { backend: string }) => p.backend === "claude_local")).toMatchObject({
      verdict: "runtime_present",
    });
  });

  it("/api/agents/probe (lightweight) isolates a throwing models getter (no 500 for the batch)", async () => {
    mockListServerAdapters.mockReturnValue([
      {
        type: "evil_models",
        get models() {
          throw new Error("models getter boom");
        },
        getRuntimeCommandSpec: () => ({ command: "x" }),
      },
    ]);
    mockEnsureCommandResolvable.mockResolvedValue(undefined);
    const res = await request(buildApp("local_trusted")).get("/api/agents/probe?backend=evil_models");
    expect(res.status).toBe(200);
    expect(res.body.probes[0]).toMatchObject({ backend: "evil_models", verdict: "runtime_fail", depth: "none", present: false });
    expect(res.body.probes[0].failure_reason).toContain("boom");
  });

  it("/api/agents/probe?depth=deep isolates a throwing testEnvironment to runtime_fail (no 500)", async () => {
    const testEnvironment = vi.fn().mockRejectedValue(new Error("testEnvironment exploded"));
    mockListServerAdapters.mockReturnValue([{ type: "claude_local", models: [], testEnvironment }]);
    const res = await request(buildApp("local_trusted")).get("/api/agents/probe?backend=claude_local&depth=deep");
    expect(res.status).toBe(200);
    expect(res.body.probes[0]).toMatchObject({ backend: "claude_local", verdict: "runtime_fail", depth: "live", present: false });
    expect(res.body.probes[0].failure_reason).toContain("exploded");
  });

  it("/api/agents/probe (lightweight) reports runtime_present for adapters with no command spec (http/gateway)", async () => {
    // hermes_gateway has no getRuntimeCommandSpec — reachability needs a configured
    // endpoint we don't have company-externally, so it reads present (NOT fake ready).
    mockListServerAdapters.mockReturnValue([{ type: "hermes_gateway", models: [] }]);
    const res = await request(buildApp("local_trusted")).get("/api/agents/probe?backend=hermes_gateway");
    expect(res.status).toBe(200);
    expect(res.body.probes[0]).toMatchObject({
      backend: "hermes_gateway",
      verdict: "runtime_present",
      depth: "registry",
      present: true,
    });
    expect(mockEnsureCommandResolvable).not.toHaveBeenCalled();
  });

  it("/api/agents/probe?depth=deep delegates to the adapter's native testEnvironment (host-local, sentinel company)", async () => {
    const testEnvironment = vi.fn().mockResolvedValue({
      adapterType: "claude_local",
      status: "pass",
      checks: [{ code: "claude_command_resolvable", level: "info", message: "Command is executable: claude" }],
      testedAt: "2026-06-29T00:00:00.000Z",
    });
    mockListServerAdapters.mockReturnValue([
      { type: "claude_local", models: [{ id: "m", label: "M" }], testEnvironment },
    ]);
    const res = await request(buildApp("local_trusted")).get("/api/agents/probe?backend=claude_local&depth=deep");
    expect(res.status).toBe(200);
    expect(res.body.probes[0]).toMatchObject({
      backend: "claude_local",
      verdict: "runtime_ready",
      depth: "live",
      present: true,
    });
    expect(testEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "global-runtime-reachability",
        adapterType: "claude_local",
        executionTarget: null,
      }),
    );
  });

  it("/api/agents/probe?depth=deep maps a failing testEnvironment to runtime_fail with failure_reason", async () => {
    const testEnvironment = vi.fn().mockResolvedValue({
      adapterType: "codex_local",
      status: "fail",
      checks: [{ code: "codex_command_unresolvable", level: "error", message: "Command is not executable: codex" }],
      testedAt: "2026-06-29T00:00:00.000Z",
    });
    mockListServerAdapters.mockReturnValue([{ type: "codex_local", models: [], testEnvironment }]);
    const res = await request(buildApp("local_trusted")).get("/api/agents/probe?backend=codex_local&depth=deep");
    expect(res.status).toBe(200);
    expect(res.body.probes[0]).toMatchObject({
      backend: "codex_local",
      verdict: "runtime_fail",
      depth: "live",
      present: false,
    });
    expect(res.body.probes[0].failure_reason).toContain("not executable");
  });

  it("/api/agents/probe?depth=deep without ?backend= is refused (deep is manual, single-runtime)", async () => {
    mockListServerAdapters.mockReturnValue([{ type: "claude_local", models: [] }]);
    const res = await request(buildApp("local_trusted")).get("/api/agents/probe?depth=deep");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("DEEP_PROBE_REQUIRES_BACKEND");
  });

  it("refuses inventory off local_trusted", async () => {
    const res = await request(buildApp("authenticated")).get("/api/backends");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("DEPLOYMENT_MODE_UNSUPPORTED");
  });
});
