import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Captured snapshot of the `--mcp-config` file AT SPAWN TIME (before execute's
 * `finally` removes it), plus the argv the child was launched with. The plugin
 * bridge wires a per-run JWT into a temp file; this proves it lands correctly
 * and is cleaned up.
 */
type Captured = {
  args: string[];
  mcpConfigPath: string | null;
  mcpConfigContent: string | null;
  mcpConfigMode: number | null;
};

const captured: Captured = { args: [], mcpConfigPath: null, mcpConfigContent: null, mcpConfigMode: null };

const { runChildProcess } = vi.hoisted(() => ({
  runChildProcess: vi.fn(),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return { ...actual, runChildProcess };
});

import { execute } from "./execute.js";

const SESSION_JSON = [
  JSON.stringify({ type: "system", subtype: "init", session_id: "s1", model: "claude-sonnet" }),
  JSON.stringify({ type: "assistant", session_id: "s1", message: { content: [{ type: "text", text: "hi" }] } }),
  JSON.stringify({
    type: "result",
    session_id: "s1",
    result: "hi",
    usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
  }),
].join("\n");

describe("claude local plugin MCP bridge wiring", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.clearAllMocks();
    captured.args = [];
    captured.mcpConfigPath = null;
    captured.mcpConfigContent = null;
    captured.mcpConfigMode = null;
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function runLocal(opts: { withContext: boolean }) {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "claude-local-bridge-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });
    const instructionsPath = path.join(rootDir, "instructions.md");
    await writeFile(instructionsPath, "Do work.\n", "utf8");
    const bridgeBin = path.join(rootDir, "plugin-bridge-stdio.js");
    await writeFile(bridgeBin, "// bin\n", "utf8");

    // Capture the mcp-config at spawn time (the main --print attempt only).
    runChildProcess.mockImplementation(async (_cmd: string, _stdin: string, args: string[]) => {
      if (args.includes("--print")) {
        captured.args = args;
        const idx = args.indexOf("--mcp-config");
        if (idx >= 0 && args[idx + 1]) {
          captured.mcpConfigPath = args[idx + 1];
          captured.mcpConfigContent = await readFile(args[idx + 1], "utf8").catch(() => null);
          const st = await stat(args[idx + 1]).catch(() => null);
          captured.mcpConfigMode = st ? st.mode & 0o777 : null;
        }
      }
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: args.includes("--print") ? SESSION_JSON : "",
        stderr: "",
        pid: 1,
        startedAt: new Date().toISOString(),
      };
    });

    await execute({
      runId: "run-1",
      authToken: "run-jwt-secret",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Claude",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        command: "claude",
        cwd: workspaceDir,
        instructionsFilePath: instructionsPath,
        env: { SUPERCLAW_API_URL: "http://127.0.0.1:9911/api" },
        ...(opts.withContext
          ? { pluginToolRunContext: { projectId: "proj-1", bridgeBin } }
          : {}),
      },
      context: {},
      onLog: async () => {},
    });
  }

  it("injects --mcp-config with the per-run JWT in a 0600 file and cleans it up", async () => {
    await runLocal({ withContext: true });

    expect(captured.args).toContain("--mcp-config");
    expect(captured.mcpConfigPath).toBeTruthy();
    expect(captured.mcpConfigMode).toBe(0o600);

    const parsed = JSON.parse(captured.mcpConfigContent ?? "{}");
    const server = parsed.mcpServers?.superclaw;
    expect(server).toBeTruthy();
    expect(server.command).toBe(process.execPath);
    // the bin is always the final arg (any Node flags like --use-env-proxy precede it)
    expect(server.args[server.args.length - 1]).toMatch(/plugin-bridge-stdio\.js$/);
    expect(server.env).toMatchObject({
      SUPERCLAW_API_URL: "http://127.0.0.1:9911/api",
      SUPERCLAW_API_KEY: "run-jwt-secret",
      SUPERCLAW_AGENT_ID: "agent-1",
      SUPERCLAW_COMPANY_ID: "company-1",
      SUPERCLAW_RUN_ID: "run-1",
      SUPERCLAW_PROJECT_ID: "proj-1",
    });

    // The temp config dir is removed after the run (finally cleanup).
    const exists = await stat(captured.mcpConfigPath as string).then(
      () => true,
      () => false,
    );
    expect(exists).toBe(false);
  });

  it("does not add --mcp-config when the host planted no run context (fail-closed)", async () => {
    await runLocal({ withContext: false });
    expect(captured.args).not.toContain("--mcp-config");
  });
});
