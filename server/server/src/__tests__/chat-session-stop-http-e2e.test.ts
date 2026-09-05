import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import http from "node:http";
import express, { type Request } from "express";
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
import { chatRoutes } from "../routes/chat.ts";
import {
  createChatSession,
  ensureChatAgent,
  ensureLocalChatCompany,
} from "../services/chat-compat.ts";
import { runningProcesses } from "../adapters/index.ts";

// FULL-CHAIN e2e: a REAL Node http.Server listening on a real port, a REAL
// `fetch` POST to /api/chat/sessions/:id/cancel, routed through the REAL chat
// router + chat-compat service + heartbeat kernel against a REAL Postgres, that
// terminates a REAL subprocess. The only thing simulated is the run's ORIGIN
// (we register the live child directly instead of going through the claude CLI,
// which needs credentials) — the cancel path itself is fully real, HTTP included.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping chat-session stop HTTP e2e on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
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

describeEmbeddedPostgres("chat Stop over real HTTP kills the live runtime", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let server: http.Server | null = null;
  let baseUrl = "";
  let spawnedPid: number | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-chat-http-");
    db = createDb(tempDb.connectionString);

    // The REAL chat router, real services, real db — only a board actor is
    // injected (what the real deployment's auth middleware would set locally).
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        userId: "local-board",
        source: "local_implicit",
        isInstanceAdmin: true,
      } as Request["actor"];
      next();
    });
    app.use("/api", chatRoutes(db, { deploymentMode: "local_trusted" }));

    server = http.createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no server address");
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }, 30_000);

  afterEach(async () => {
    if (spawnedPid && isAlive(spawnedPid)) {
      try {
        process.kill(-spawnedPid, "SIGKILL");
      } catch {
        try {
          process.kill(spawnedPid, "SIGKILL");
        } catch {
          /* gone */
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
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    await tempDb?.cleanup();
  });

  it("POST /api/chat/sessions/:id/cancel terminates the agent process group", async () => {
    // Real local chat company + chat agent + chat session, via the real services.
    const companyId = await ensureLocalChatCompany(db);
    const agentId = await ensureChatAgent(db, companyId, "claude_local");
    const session = await createChatSession(db, companyId, { title: "e2e stop" });
    const issueId = session.id;

    // A REAL live subprocess in its own group that ignores SIGTERM.
    const child = spawn(
      process.execPath,
      ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1e9);"],
      { detached: true, stdio: "ignore" },
    );
    child.unref();
    const pid = child.pid!;
    spawnedPid = pid;
    await new Promise((r) => setTimeout(r, 200));
    expect(isAlive(pid)).toBe(true);

    // Wire it as the session's live heartbeat run, exactly as a real chat turn would.
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
    runningProcesses.set(runId, { child, graceSec: 1, processGroupId: pid });

    // THE REAL HTTP STOP.
    const res = await fetch(`${baseUrl}/api/chat/sessions/${issueId}/cancel`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; cancelled: boolean; status: string };
    expect(body.ok).toBe(true);
    expect(body.cancelled).toBe(true);
    expect(body.status).toBe("cancelled");

    // The real OS process is gone (SIGKILL escalated past the ignored SIGTERM).
    expect(await waitUntilDead(pid)).toBe(true);
    expect(isAlive(pid)).toBe(false);

    const [runAfter] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(runAfter?.status).toBe("cancelled");
    expect(runningProcesses.has(runId)).toBe(false);
  }, 25_000);

  it("POST cancel for an unknown session is fail-closed (404) and kills nothing", async () => {
    const res = await fetch(`${baseUrl}/api/chat/sessions/${randomUUID()}/cancel`, { method: "POST" });
    expect(res.status).toBe(404);
  });
});
