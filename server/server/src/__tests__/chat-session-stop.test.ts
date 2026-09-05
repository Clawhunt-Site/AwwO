import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agents,
  agentWakeupRequests,
  companies,
  companySkills,
  costEvents,
  createDb,
  documents,
  environmentLeases,
  environments,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueTreeHoldMembers,
  issueTreeHolds,
  issues,
  workspaceOperations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { CHAT_STOP_HOLD_REASON } from "../services/issue-tree-control.ts";

// The resume-path test wakes the agent for real; stub the adapter so the run
// completes instantly in-process instead of spawning an agent runtime.
const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Chat stop test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

// Kernel-level proof that a user Stop on a chat session is a TRUE stop:
//   - it cancels the active heartbeat run (which kills the agent runtime's
//     process group; no live process here, so only the lifecycle is exercised),
//   - it cancels THIS session's pending queued/deferred wakes, and
//   - it suppresses immediate recovery + deferred-wake promotion for this issue,
//     so the chat goes idle instead of "stop, then auto-run the next turn".
// It must NOT, however, starve the agent's OTHER work: a sibling issue's wake is
// left untouched. Without the suppression a raw cancelRun would re-open the issue
// for immediate recovery AND promote the deferred wake into a fresh run — exactly
// the "stopped but it keeps going" symptom this primitive exists to prevent.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping chat-session stop tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("cancelChatSessionExecution (native chat stop)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-chat-stop-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    // Order matters: heartbeat_runs.wakeup_request_id FKs agent_wakeup_requests,
    // and issues/run-events reference runs — delete dependents before their
    // referents so cleanup never trips a foreign-key constraint.
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await db.delete(costEvents);
    await db.delete(workspaceOperations);
    await db.delete(environmentLeases);
    await db.delete(environments);
    await db.delete(executionWorkspaces);
    await db.delete(issueTreeHoldMembers);
    await db.delete(issueTreeHolds);
    await db.delete(issueComments);
    await db.delete(issueDocuments);
    await db.delete(documents);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, name = "Chat") {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role: "engineer",
      status: "running",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return agentId;
  }

  async function seedChatIssue(companyId: string, agentId: string) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "chat session",
      // todo/in_progress + assigned to THIS agent + no human assignee is the
      // precise state that would trigger immediate recovery on a raw cancel.
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    return issueId;
  }

  // The live chat run, plus the issue's execution lock pointing at it.
  async function seedActiveRun(companyId: string, agentId: string, issueId: string) {
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
    });
    await db
      .update(issues)
      .set({ executionRunId: runId, executionAgentNameKey: "chat", executionLockedAt: new Date() })
      .where(eq(issues.id, issueId));
    return runId;
  }

  // A queued "next turn" the user enqueued while the first turn was running.
  async function seedDeferredWake(companyId: string, agentId: string, issueId: string) {
    const id = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id,
      companyId,
      agentId,
      source: "on_demand",
      status: "deferred_issue_execution",
      payload: { issueId },
    });
    return id;
  }

  // Mirror of CANCELLABLE_HEARTBEAT_RUN_STATUSES (the real "still active" set) —
  // includes scheduled_retry, which a naive "queued/running" filter would miss.
  const ACTIVE_RUN_STATUSES = ["queued", "running", "scheduled_retry"];
  async function activeRunsForCompany(companyId: string) {
    const rows = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    return rows.filter((r) => ACTIVE_RUN_STATUSES.includes(String(r.status)));
  }

  it("cancels the active run, clears the deferred wake, and leaves the chat idle", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const issueId = await seedChatIssue(companyId, agentId);
    const runId = await seedActiveRun(companyId, agentId, issueId);
    const deferredWakeId = await seedDeferredWake(companyId, agentId, issueId);

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.cancelChatSessionExecution(companyId, issueId, "Cancelled by chat stop");

    // The active run is cancelled and one pending wake was cleared.
    expect(result.run?.status).toBe("cancelled");
    expect(result.wakeupsCancelled).toBe(1);

    const [runAfter] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(runAfter?.status).toBe("cancelled");

    // The deferred "next turn" wake is cancelled, NOT promoted into a new run.
    const [wakeAfter] = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, deferredWakeId));
    expect(wakeAfter?.status).toBe("cancelled");

    // The key user-facing guarantee: no run is left (or newly created) active for
    // this chat — neither immediate recovery nor queue promotion revived it.
    expect(await activeRunsForCompany(companyId)).toHaveLength(0);
    expect(await heartbeat.getActiveChatRun(companyId, issueId)).toBeNull();

    // And the issue execution lock is released.
    const [issueAfter] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issueAfter?.executionRunId).toBeNull();

    // Stop is DURABLE: the issue is parked under a chat-stop pause hold, so the
    // periodic stranded-issue recovery (which cannot tell "user said stop" from
    // "execution path lost") does not revive the chat on its next sweep.
    expect(result.parkedHoldId).toBeTruthy();
    const [hold] = await db
      .select()
      .from(issueTreeHolds)
      .where(and(eq(issueTreeHolds.rootIssueId, issueId), eq(issueTreeHolds.status, "active")));
    expect(hold?.reason).toBe(CHAT_STOP_HOLD_REASON);
    expect(hold?.mode).toBe("pause");

    const reconciled = await heartbeat.reconcileStrandedAssignedIssues();
    expect(reconciled.continuationRequeued).toBe(0);
    expect(reconciled.dispatchRequeued).toBe(0);
    expect(reconciled.escalated).toBe(0);
    expect(await activeRunsForCompany(companyId)).toHaveLength(0);
    const [issueAfterSweep] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issueAfterSweep?.status).toBe("in_progress");
  });

  it("a second Stop reuses the existing park instead of stacking holds", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const issueId = await seedChatIssue(companyId, agentId);

    const heartbeat = heartbeatService(db);
    const first = await heartbeat.cancelChatSessionExecution(companyId, issueId);
    const second = await heartbeat.cancelChatSessionExecution(companyId, issueId);

    expect(first.parkedHoldId).toBeTruthy();
    expect(second.parkedHoldId).toBeNull();

    const activeHolds = await db
      .select()
      .from(issueTreeHolds)
      .where(and(eq(issueTreeHolds.rootIssueId, issueId), eq(issueTreeHolds.status, "active")));
    expect(activeHolds).toHaveLength(1);
  });

  it("parks with its own hold even when a manual pause hold is already active (Stop must survive that hold's release)", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const issueId = await seedChatIssue(companyId, agentId);

    // A pre-existing manual/tree-control pause hold on the same issue. It is
    // NOT a substitute for the chat-stop park: an operator can release it at
    // any time, and Stop's guarantee must survive that release.
    const [manualHold] = await db
      .insert(issueTreeHolds)
      .values({
        companyId,
        rootIssueId: issueId,
        mode: "pause",
        status: "active",
        reason: "manual operator pause",
        releasePolicy: { strategy: "manual" },
      })
      .returning();

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.cancelChatSessionExecution(companyId, issueId);
    expect(result.parkedHoldId).toBeTruthy();

    const activeHolds = await db
      .select()
      .from(issueTreeHolds)
      .where(and(eq(issueTreeHolds.rootIssueId, issueId), eq(issueTreeHolds.status, "active")));
    expect(activeHolds).toHaveLength(2);

    // Operator releases the manual hold — the chat-stop park must still gate
    // the periodic stranded-issue recovery.
    await db
      .update(issueTreeHolds)
      .set({ status: "released", releasedAt: new Date() })
      .where(eq(issueTreeHolds.id, manualHold.id));

    const reconciled = await heartbeat.reconcileStrandedAssignedIssues();
    expect(reconciled.continuationRequeued).toBe(0);
    expect(reconciled.dispatchRequeued).toBe(0);
    expect(reconciled.escalated).toBe(0);
    expect(await activeRunsForCompany(companyId)).toHaveLength(0);
  });

  it("a second Stop behind a newer manual hold neither duplicates the park nor strands it (one user turn fully unparks)", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const issueId = await seedChatIssue(companyId, agentId);

    const heartbeat = heartbeatService(db);
    const first = await heartbeat.cancelChatSessionExecution(companyId, issueId);
    expect(first.parkedHoldId).toBeTruthy();

    // An operator pauses the same issue AFTER the Stop. The pause-hold gate
    // collapses same-root holds to the newest, so the manual hold now shadows
    // the chat-stop park — a gate-based idempotency probe would create a
    // duplicate chat-stop hold here, and a stale duplicate would later swallow
    // the user's resume turn.
    const [manualHold] = await db
      .insert(issueTreeHolds)
      .values({
        companyId,
        rootIssueId: issueId,
        mode: "pause",
        status: "active",
        reason: "manual operator pause",
        releasePolicy: { strategy: "manual" },
        createdAt: new Date(Date.now() + 1_000),
      })
      .returning();

    const second = await heartbeat.cancelChatSessionExecution(companyId, issueId);
    expect(second.parkedHoldId).toBeNull();

    const chatStopHolds = await db
      .select()
      .from(issueTreeHolds)
      .where(and(eq(issueTreeHolds.rootIssueId, issueId), eq(issueTreeHolds.status, "active"), eq(issueTreeHolds.reason, CHAT_STOP_HOLD_REASON)));
    expect(chatStopHolds).toHaveLength(1);

    // Operator resumes their own hold; the chat-stop park must still gate the
    // sweep, and ONE user wake must then fully unpark the chat.
    await db
      .update(issueTreeHolds)
      .set({ status: "released", releasedAt: new Date() })
      .where(eq(issueTreeHolds.id, manualHold.id));

    const reconciled = await heartbeat.reconcileStrandedAssignedIssues();
    expect(reconciled.continuationRequeued).toBe(0);

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      payload: { issueId },
      requestedByActorType: "user",
      requestedByActorId: "local-user",
    });
    expect(run).not.toBeNull();

    const activeHolds = await db
      .select()
      .from(issueTreeHolds)
      .where(and(eq(issueTreeHolds.rootIssueId, issueId), eq(issueTreeHolds.status, "active")));
    expect(activeHolds).toHaveLength(0);

    // Settle the mocked-adapter run (terminal status lands before its post-run
    // comment) so afterEach cleanup never races it.
    let settled = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      settled = (
        await db.select({ id: issueComments.id }).from(issueComments).where(eq(issueComments.issueId, issueId))
      ).length;
      if (settled > 0 && (await activeRunsForCompany(companyId)).length === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(settled).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 150));
  });

  it("keeps automatic wakes parked after Stop", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const issueId = await seedChatIssue(companyId, agentId);

    const heartbeat = heartbeatService(db);
    await heartbeat.cancelChatSessionExecution(companyId, issueId);

    const wake = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_continuation_needed",
      payload: { issueId },
    });
    expect(wake).toBeNull();

    const [skipped] = await db
      .select({ status: agentWakeupRequests.status, reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.agentId, agentId), eq(agentWakeupRequests.status, "skipped")));
    expect(skipped).toMatchObject({ status: "skipped", reason: "issue_tree_hold_active" });

    const activeHolds = await db
      .select()
      .from(issueTreeHolds)
      .where(and(eq(issueTreeHolds.rootIssueId, issueId), eq(issueTreeHolds.status, "active")));
    expect(activeHolds).toHaveLength(1);
  });

  it("a user-requested wake releases the park and proceeds (Stop must not turn the chat deaf)", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const issueId = await seedChatIssue(companyId, agentId);

    const heartbeat = heartbeatService(db);
    await heartbeat.cancelChatSessionExecution(companyId, issueId);

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      payload: { issueId },
      requestedByActorType: "user",
      requestedByActorId: "local-user",
    });
    expect(run).not.toBeNull();

    // The chat-stop hold is released; a fresh Stop could park it again later.
    const activeHolds = await db
      .select()
      .from(issueTreeHolds)
      .where(and(eq(issueTreeHolds.rootIssueId, issueId), eq(issueTreeHolds.status, "active")));
    expect(activeHolds).toHaveLength(0);

    // Let the mocked-adapter run settle before afterEach cleanup. The run's
    // terminal status lands BEFORE its post-run writes (continuation summary,
    // run-linked comment), so wait for the comment — the last such write — not
    // merely for "no active runs".
    let settledComments = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      settledComments = (
        await db.select({ id: issueComments.id }).from(issueComments).where(eq(issueComments.issueId, issueId))
      ).length;
      if (settledComments > 0 && (await activeRunsForCompany(companyId)).length === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(settledComments).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 150));
  });

  it("is a no-op for an idle session but still clears its pending wakes", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const issueId = await seedChatIssue(companyId, agentId);
    const deferredWakeId = await seedDeferredWake(companyId, agentId, issueId);

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.cancelChatSessionExecution(companyId, issueId);

    expect(result.run).toBeNull();
    expect(result.wakeupsCancelled).toBe(1);

    const [wakeAfter] = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, deferredWakeId));
    expect(wakeAfter?.status).toBe("cancelled");
    expect(await activeRunsForCompany(companyId)).toHaveLength(0);
  });

  it("does NOT touch a sibling issue's pending wake on the same agent (no starvation)", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const stoppedIssueId = await seedChatIssue(companyId, agentId);
    await seedActiveRun(companyId, agentId, stoppedIssueId);
    await seedDeferredWake(companyId, agentId, stoppedIssueId);

    // A SECOND chat session on the SAME agent with its own queued work.
    const siblingIssueId = await seedChatIssue(companyId, agentId);
    const siblingWakeId = await seedDeferredWake(companyId, agentId, siblingIssueId);

    const heartbeat = heartbeatService(db);
    await heartbeat.cancelChatSessionExecution(companyId, stoppedIssueId, "Cancelled by chat stop");

    // The stopped session's wake is cancelled; the sibling's is left intact so the
    // agent can still serve it — Stop on one chat must not freeze the others.
    const [siblingWakeAfter] = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, siblingWakeId));
    expect(siblingWakeAfter?.status).toBe("deferred_issue_execution");

    // The sibling session is still reported idle-or-running per its own state, but
    // crucially it was NOT cancelled by the other session's Stop.
    expect(siblingWakeAfter?.error).toBeNull();
  });
});
