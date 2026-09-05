import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
// The SAME module-global map heartbeat reads to find a run's live child — so a
// process we register here is terminated by the real cancel path, not a stub.
import { runningProcesses } from "../adapters/index.ts";

// END-TO-END PROOF that Stop actually terminates the agent runtime: spawn a REAL
// subprocess in its own process group, register it exactly as the adapter does,
// run the real cancelChatSessionExecution, and assert the OS process is dead.
// The child IGNORES SIGTERM, so passing requires the grace -> SIGKILL escalation
// (process.kill(-pgid, "SIGKILL")) to truly fire — not just a polite shutdown.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping chat-session process-kill test on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitUntilDead(pid: number, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !isAlive(pid);
}

describeEmbeddedPostgres("cancelChatSessionExecution kills the live agent runtime", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let spawnedPid: number | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-chat-kill-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    // Safety net: if an assertion failed, make sure we never leak the child.
    if (spawnedPid && isAlive(spawnedPid)) {
      try {
        process.kill(-spawnedPid, "SIGKILL");
      } catch {
        try {
          process.kill(spawnedPid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }
    spawnedPid = null;
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("SIGKILLs the agent subprocess group when a chat is stopped", async () => {
    // A real child in its OWN process group (detached) that deliberately ignores
    // SIGTERM and never exits on its own — only a process-group SIGKILL stops it.
    const child = spawn(
      process.execPath,
      ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1e9);"],
      { detached: true, stdio: "ignore" },
    );
    child.unref();
    const pid = child.pid!;
    spawnedPid = pid;
    expect(typeof pid).toBe("number");
    // Let it get into its run loop and be its own group leader.
    await new Promise((r) => setTimeout(r, 200));
    expect(isAlive(pid)).toBe(true);

    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Chat",
      role: "engineer",
      status: "running",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "chat session",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    const wakeupRequestId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "on_demand",
      status: "running",
      payload: { issueId },
    });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "running",
      wakeupRequestId,
      contextSnapshot: { issueId },
      processPid: pid,
      processGroupId: pid,
    });
    await db
      .update(issues)
      .set({ executionRunId: runId, executionAgentNameKey: "chat", executionLockedAt: new Date() })
      .where(eq(issues.id, issueId));

    // Register the live child the way the process adapter does, with a short
    // grace so the SIGTERM -> SIGKILL escalation completes fast in the test.
    runningProcesses.set(runId, { child, graceSec: 1, processGroupId: pid });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.cancelChatSessionExecution(companyId, issueId, "Cancelled by chat stop");

    // The real OS process must actually be gone (SIGKILL fired after the grace).
    expect(await waitUntilDead(pid)).toBe(true);
    expect(isAlive(pid)).toBe(false);

    // And the run is recorded cancelled + the in-memory handle released.
    expect(result.run?.status).toBe("cancelled");
    expect(runningProcesses.has(runId)).toBe(false);
  }, 20_000);
});
