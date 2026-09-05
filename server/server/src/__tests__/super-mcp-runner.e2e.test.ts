import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { callSuperPluginTool, openSuperMcpSession, SuperMcpRunError } from "../services/super-mcp-runner.js";
import type { SuperPluginRuntimeRecord } from "../services/super-plugin-runtime-store.js";
import { SuperStdioTransport } from "../services/super-stdio-transport.js";

/**
 * P7 — end-to-end against a REAL spawned MCP child (the P4 unit tests faked the
 * session/spawn). Drives the full P3 exec-gate → P4 stdio transport → MCP client
 * stack against a self-contained `node` external_mcp sidecar, proving: the real MCP
 * handshake + tools/call works; the child env is narrowed (exact key set, narrowed
 * PATH, no host-env leak); a hung tool call's timeout teardown FULLY reaps the child
 * before returning; close() tears down the whole process GROUP (killpg); and a hung
 * initialize (connect timeout) also reaps the spawned child.
 */

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-mcp-sidecar.mjs", import.meta.url));
const SAFE_SIDECAR_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
// Host keys the runner's buildBaseEnv may pass through (BASE_ENV_ALLOWLIST in P3).
const BASE_ENV_ALLOWLIST = ["HOME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TZ"];

/** Liveness: ONLY ESRCH means dead. EPERM (alive, not ours) and anything else → alive. */
const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
};
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await delay(20);
  }
  return false;
}

describe("super MCP runner — real child E2E", () => {
  let workDir: string;
  let pidFile: string;

  function record(installDir: string, mode?: string): SuperPluginRuntimeRecord {
    return {
      pluginKey: "dev.e2e.sidecar",
      version: "1.0.0",
      runtimeType: "external_mcp",
      transport: "stdio",
      entrypoint: null,
      command: "node", // allowlisted bare launcher (P3)
      url: null,
      args: mode ? [FIXTURE, pidFile, mode] : [FIXTURE, pidFile],
      tools: [
        { name: "echo", description: "", inputSchema: {}, outputSchema: {} },
        { name: "env_dump", description: "", inputSchema: {}, outputSchema: {} },
        { name: "hang", description: "", inputSchema: {}, outputSchema: {} },
        { name: "spawn_child", description: "", inputSchema: {}, outputSchema: {} },
      ],
      installDir,
      packageDigest: "sha256:" + "ab".repeat(32),
      status: "installed",
    };
  }

  async function sidecarPid(): Promise<number> {
    // Startup writes the sidecar pid to the first line (overwriting prior runs).
    const first = (await readFile(pidFile, "utf8")).split("\n")[0]?.trim();
    return Number.parseInt(first ?? "0", 10);
  }
  async function allPids(): Promise<number[]> {
    try {
      return (await readFile(pidFile, "utf8"))
        .split("\n")
        .map((s) => Number.parseInt(s.trim(), 10))
        .filter((n) => Number.isInteger(n) && n > 0);
    } catch {
      return [];
    }
  }

  beforeAll(async () => {
    workDir = await mkdtemp(path.join(os.tmpdir(), "super-mcp-e2e-"));
    pidFile = path.join(workDir, "pids.txt");
  });
  afterAll(async () => {
    for (const pid of await allPids()) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    await rm(workDir, { recursive: true, force: true });
  });

  it("completes the MCP handshake and calls a tool", async () => {
    const out = await callSuperPluginTool("echo", { hello: "world" }, {
      openSession: () => openSuperMcpSession(record(workDir)),
      timeoutMs: 10_000,
    });
    const payload = JSON.parse(out.text) as { args: unknown; hasHome: boolean };
    expect(payload.args).toEqual({ hello: "world" });
    expect(out.isError).toBe(false);
  }, 30_000);

  it("narrows the child env: exact key set, narrowed PATH, no host-env / NODE_PATH leak", async () => {
    process.env.SECRET_LEAK_TEST = "must-not-leak";
    process.env.NODE_PATH = "/some/host/modules";
    try {
      const out = await callSuperPluginTool("env_dump", {}, {
        openSession: () => openSuperMcpSession(record(workDir)),
        timeoutMs: 10_000,
      });
      const env = JSON.parse(out.text) as { keys: string[]; path: string };
      // EXACT non-system key set: the runner passes only the allowlisted host keys that
      // exist + PATH + PYTHONDONTWRITEBYTECODE. (OS-injected `__`-prefixed vars like
      // macOS's __CF_USER_TEXT_ENCODING are added by dyld/CoreFoundation, not our spec.)
      const expected = new Set([
        ...BASE_ENV_ALLOWLIST.filter((k) => process.env[k] != null),
        "PATH",
        "PYTHONDONTWRITEBYTECODE",
      ]);
      const observed = new Set(env.keys.filter((k) => !k.startsWith("__")));
      expect(observed).toEqual(expected);
      // EXACT PATH shape: [<one absolute launcher dir>, /usr/bin, /bin, /usr/sbin, /sbin]
      // — the host PATH is never inherited.
      const parts = env.path.split(":");
      expect(parts.slice(1)).toEqual(SAFE_SIDECAR_PATH.split(":"));
      expect(path.isAbsolute(parts[0])).toBe(true);
      expect(parts).toHaveLength(5);
    } finally {
      delete process.env.SECRET_LEAK_TEST;
      delete process.env.NODE_PATH;
    }
  }, 30_000);

  it("times out a hung tool call and FULLY reaps the process group before returning", async () => {
    const session = await openSuperMcpSession(record(workDir));
    const pid = await sidecarPid();
    expect(pid).toBeGreaterThan(0);
    expect(isAlive(pid)).toBe(true);

    await expect(
      // callSuperPluginTool's finally awaits session.close(), which now awaits child exit.
      callSuperPluginTool("hang", {}, { openSession: () => Promise.resolve(session), timeoutMs: 300 }),
    ).rejects.toBeInstanceOf(SuperMcpRunError);

    // No sleep: teardown completed before the rejection settled, so the child is gone.
    expect(isAlive(pid)).toBe(false);
  }, 30_000);

  it("close() SIGKILLs the whole process GROUP — even a SIGTERM-resistant grandchild", async () => {
    const session = await openSuperMcpSession(record(workDir));
    const out = await session.callTool("spawn_child", {});
    const grandchildPid = Number.parseInt(
      ((out as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? "0").trim(),
      10,
    );
    expect(grandchildPid).toBeGreaterThan(0);
    expect(isAlive(grandchildPid)).toBe(true);

    await session.close(); // SIGTERM (ignored) → grace → SIGKILL group → poll group-empty
    // close() returned only after the group was empty, so the SIGTERM-resistant
    // grandchild is ALREADY reaped on return (no poll/sleep).
    expect(isAlive(grandchildPid)).toBe(false);
  }, 30_000);

  it("a hung initialize (connect timeout) reaps the child AND its resistant descendant", async () => {
    await expect(openSuperMcpSession(record(workDir, "ignore-initialize"), {}, { connectTimeoutMs: 500 })).rejects.toThrow(
      /timed out/,
    );
    // ignore-initialize mode pre-spawned a SIGTERM-resistant grandchild; the connect-
    // timeout teardown awaited transport.close (which polls group-empty), so BOTH the
    // sidecar and that descendant are reaped by the time the rejection settles.
    const pids = await allPids();
    expect(pids.length).toBeGreaterThanOrEqual(2);
    for (const pid of pids) expect(isAlive(pid), `pid ${pid} survived connect-timeout teardown`).toBe(false);
  }, 30_000);

  it("close() reaps an orphaned descendant even when the launcher already exited", async () => {
    // The launcher spawns a resistant grandchild then EXITS immediately, so by close()
    // time the launcher is gone but the descendant lingers in the group. close() must
    // still killpg the group (via the saved group pid) and reap it. A DEDICATED pidfile
    // avoids racing against stale entries from earlier tests.
    const orphanPidFile = path.join(workDir, "orphan-pids.txt");
    const readOrphanPids = async (): Promise<number[]> => {
      try {
        return (await readFile(orphanPidFile, "utf8"))
          .split("\n")
          .map((s) => Number.parseInt(s.trim(), 10))
          .filter((n) => Number.isInteger(n) && n > 0);
      } catch {
        return [];
      }
    };
    const transport = new SuperStdioTransport({
      command: process.execPath, // absolute node — the transport does no PATH lookup
      args: [FIXTURE, orphanPidFile, "spawn-then-exit"],
      env: { PATH: SAFE_SIDECAR_PATH, HOME: os.homedir() },
      cwd: workDir,
    });
    await transport.start();
    // Wait until the pidfile has both the launcher and the grandchild, then the launcher dies.
    expect(await until(async () => (await readOrphanPids()).length >= 2)).toBe(true);
    const [launcherPid, grandchildPid] = await readOrphanPids();
    expect(await until(() => !isAlive(launcherPid))).toBe(true); // launcher exited naturally
    expect(isAlive(grandchildPid)).toBe(true); // but the resistant descendant lingers

    await transport.close(); // killpg the group via the SAVED group pid → reap the orphan
    expect(isAlive(grandchildPid)).toBe(false);
    // Clean up in case the assertion path changes.
    try {
      process.kill(grandchildPid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }, 30_000);
});
