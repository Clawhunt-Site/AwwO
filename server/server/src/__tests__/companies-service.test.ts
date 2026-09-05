import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  budgetPolicies,
  companies,
  costEvents,
  createDb,
  financeEvents,
  goals,
  heartbeatRunEvents,
  heartbeatRuns,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { companyService } from "../services/companies.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres company service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("companyService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-service-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(financeEvents);
    await db.delete(costEvents);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(activityLog);
    await db.delete(budgetPolicies);
    await db.delete(projects);
    await db.delete(goals);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("retries generated issue prefixes when Drizzle wraps the unique constraint error", async () => {
    await db.insert(companies).values({
      name: "Aron Existing",
      issuePrefix: "ARO",
    });

    const created = await companyService(db).create({
      name: "Aron & Sharon",
    });

    expect(created.issuePrefix).toBe("AROA");

    const rows = await db.select({ issuePrefix: companies.issuePrefix }).from(companies);
    expect(rows.map((row) => row.issuePrefix).sort()).toEqual(["ARO", "AROA"]);
  });

  it("removes a company that has a budget policy (NO ACTION orphan cascade-gap regression)", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Budgeted Co", issuePrefix: "BUD" });
    // A budget policy references the company via a NO ACTION FK with no cascading
    // parent — exactly what made DELETE /api/companies 500 before remove() learned to
    // delete it first. (upsertPolicy creates this whenever budgetMonthlyCents > 0.)
    await db.insert(budgetPolicies).values({
      companyId,
      scopeType: "company",
      scopeId: companyId,
      windowKind: "calendar_month_utc",
      amount: 1000,
    });

    const removed = await companyService(db).remove(companyId);
    expect(removed?.id).toBe(companyId);

    expect(await db.select().from(companies).where(eq(companies.id, companyId))).toHaveLength(0);
    expect(await db.select().from(budgetPolicies).where(eq(budgetPolicies.companyId, companyId))).toHaveLength(0);
  });

  it("removes a company whose runs accrued cost and finance events (delete-order regression)", async () => {
    // The exact live-repro shape: any company whose agent ran at least one costed
    // heartbeat run. cost_events / finance_events reference heartbeat_runs (and
    // finance_events references cost_events) via NO ACTION FKs, so remove() must
    // delete finance -> cost -> runs in that order; the old runs-first order 500'd
    // with cost_events_heartbeat_run_id_heartbeat_runs_id_fk.
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const costEventId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Costed Co", issuePrefix: "COS" });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CEO",
      role: "ceo",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "timer",
      status: "completed",
    });
    await db.insert(costEvents).values({
      id: costEventId,
      companyId,
      agentId,
      heartbeatRunId: runId,
      provider: "anthropic",
      model: "claude-opus-4-8",
      costCents: 12,
      occurredAt: new Date(),
    });
    await db.insert(financeEvents).values({
      companyId,
      agentId,
      heartbeatRunId: runId,
      costEventId,
      eventKind: "model_usage",
      biller: "relay",
      amountCents: 12,
      occurredAt: new Date(),
    });

    const removed = await companyService(db).remove(companyId);
    expect(removed?.id).toBe(companyId);
    expect(await db.select().from(companies).where(eq(companies.id, companyId))).toHaveLength(0);
    expect(await db.select().from(costEvents).where(eq(costEvents.companyId, companyId))).toHaveLength(0);
    expect(await db.select().from(financeEvents).where(eq(financeEvents.companyId, companyId))).toHaveLength(0);
  });

  it("unlinks (never deletes) another company's legacy cost event that references the removed company's run", async () => {
    // Legacy cross-company shape: before costService validated FK ownership, company
    // A could record a cost event pointing at company B's heartbeat run. Removing B
    // must not 500 on that NO ACTION FK — and must not destroy A's accounting row;
    // it nulls the dangling reference instead.
    const companyA = randomUUID();
    const companyB = randomUUID();
    const agentA = randomUUID();
    const agentB = randomUUID();
    const runB = randomUUID();
    const crossEventId = randomUUID();
    await db.insert(companies).values([
      { id: companyA, name: "Alpha", issuePrefix: "ALP" },
      { id: companyB, name: "Beta", issuePrefix: "BET" },
    ]);
    for (const [agentId, companyId] of [
      [agentA, companyA],
      [agentB, companyB],
    ] as const) {
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "CEO",
        role: "ceo",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
    }
    await db.insert(heartbeatRuns).values({
      id: runB,
      companyId: companyB,
      agentId: agentB,
      invocationSource: "timer",
      status: "completed",
    });
    // Company A's ledger row referencing B's run — inserted directly, as the
    // (now-guarded) write path once allowed.
    await db.insert(costEvents).values({
      id: crossEventId,
      companyId: companyA,
      agentId: agentA,
      heartbeatRunId: runB,
      provider: "anthropic",
      model: "claude-opus-4-8",
      costCents: 5,
      occurredAt: new Date(),
    });

    const removed = await companyService(db).remove(companyB);
    expect(removed?.id).toBe(companyB);
    expect(await db.select().from(companies).where(eq(companies.id, companyB))).toHaveLength(0);

    // A's row survives, unlinked.
    const [survivor] = await db.select().from(costEvents).where(eq(costEvents.id, crossEventId));
    expect(survivor).toBeDefined();
    expect(survivor.companyId).toBe(companyA);
    expect(survivor.heartbeatRunId).toBeNull();
  });

  it("removes a company whose project is linked to a goal (delete-order regression)", async () => {
    // projects.goal_id is a NO ACTION FK to goals; remove() must delete projects
    // before goals. The old goals-first order 500'd for Goal Mode companies.
    const companyId = randomUUID();
    const goalId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Goal Co", issuePrefix: "GOA" });
    await db.insert(goals).values({ id: goalId, companyId, title: "Ship v1" });
    await db.insert(projects).values({ companyId, goalId, name: "v1 delivery" });

    const removed = await companyService(db).remove(companyId);
    expect(removed?.id).toBe(companyId);
    expect(await db.select().from(companies).where(eq(companies.id, companyId))).toHaveLength(0);
    expect(await db.select().from(projects).where(eq(projects.companyId, companyId))).toHaveLength(0);
    expect(await db.select().from(goals).where(eq(goals.companyId, companyId))).toHaveLength(0);
  });

  it("archives companies by pausing runnable agents and cancelling active runs", async () => {
    const companyId = randomUUID();
    const runningAgentId = randomUUID();
    const idleAgentId = randomUUID();
    const errorAgentId = randomUUID();
    const pausedAgentId = randomUUID();
    const pendingAgentId = randomUUID();
    const terminatedAgentId = randomUUID();
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Archive Test Co",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: runningAgentId,
        companyId,
        name: "Running Agent",
        role: "engineer",
        status: "running",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: idleAgentId,
        companyId,
        name: "Idle Agent",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: errorAgentId,
        companyId,
        name: "Error Agent",
        role: "engineer",
        status: "error",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: pausedAgentId,
        companyId,
        name: "Paused Agent",
        role: "engineer",
        status: "paused",
        pauseReason: "manual",
        pausedAt: new Date("2026-06-01T00:00:00Z"),
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: pendingAgentId,
        companyId,
        name: "Pending Agent",
        role: "engineer",
        status: "pending_approval",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: terminatedAgentId,
        companyId,
        name: "Terminated Agent",
        role: "engineer",
        status: "terminated",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId: runningAgentId,
      source: "timer",
      status: "queued",
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: runningAgentId,
      invocationSource: "timer",
      status: "running",
      wakeupRequestId,
    });

    const archived = await companyService(db).archive(companyId, {
      actorType: "user",
      actorId: "test-user",
      agentId: null,
      runId: null,
    });

    expect(archived?.status).toBe("archived");

    const archiveActivity = await db
      .select({
        actorType: activityLog.actorType,
        actorId: activityLog.actorId,
        details: activityLog.details,
      })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, "company.archived"),
      ));
    expect(archiveActivity).toHaveLength(1);
    expect(archiveActivity[0]).toMatchObject({
      actorType: "user",
      actorId: "test-user",
      details: { agentsPaused: 3, runsCancelled: 1 },
    });

    const rows = await db
      .select({
        id: agents.id,
        status: agents.status,
        pauseReason: agents.pauseReason,
      })
      .from(agents);

    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(runningAgentId)).toMatchObject({ status: "paused", pauseReason: "company_archived" });
    expect(byId.get(idleAgentId)).toMatchObject({ status: "paused", pauseReason: "company_archived" });
    expect(byId.get(errorAgentId)).toMatchObject({ status: "paused", pauseReason: "company_archived" });
    expect(byId.get(pausedAgentId)).toMatchObject({ status: "paused", pauseReason: "manual" });
    expect(byId.get(pendingAgentId)).toMatchObject({ status: "pending_approval", pauseReason: null });
    expect(byId.get(terminatedAgentId)).toMatchObject({ status: "terminated", pauseReason: null });

    const run = await db
      .select({
        status: heartbeatRuns.status,
        error: heartbeatRuns.error,
      })
      .from(heartbeatRuns)
      .then((result) => result[0] ?? null);
    expect(run).toMatchObject({
      status: "cancelled",
      error: "Cancelled because the company was archived",
    });

    const wakeup = await db
      .select({
        status: agentWakeupRequests.status,
        error: agentWakeupRequests.error,
      })
      .from(agentWakeupRequests)
      .then((result) => result[0] ?? null);
    expect(wakeup).toMatchObject({
      status: "cancelled",
      error: "Cancelled because the company was archived",
    });
  });

  it("reactivates only agents paused because the company was archived", async () => {
    const companyId = randomUUID();
    const archivedPausedAgentId = randomUUID();
    const manualPausedAgentId = randomUUID();
    const pendingAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Reactivate Test Co",
      status: "archived",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: archivedPausedAgentId,
        companyId,
        name: "Archived Paused Agent",
        role: "engineer",
        status: "paused",
        pauseReason: "company_archived",
        pausedAt: new Date("2026-06-01T00:00:00Z"),
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: manualPausedAgentId,
        companyId,
        name: "Manual Paused Agent",
        role: "engineer",
        status: "paused",
        pauseReason: "manual",
        pausedAt: new Date("2026-06-01T00:00:00Z"),
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: pendingAgentId,
        companyId,
        name: "Pending Approval Agent",
        role: "engineer",
        status: "pending_approval",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    const reactivated = await companyService(db).update(
      companyId,
      { status: "active" },
      { actorType: "user", actorId: "test-user", agentId: null, runId: null },
    );

    expect(reactivated?.status).toBe("active");

    const reactivateActivity = await db
      .select({
        actorType: activityLog.actorType,
        actorId: activityLog.actorId,
        details: activityLog.details,
      })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, "company.reactivated"),
      ));
    expect(reactivateActivity).toHaveLength(1);
    expect(reactivateActivity[0]).toMatchObject({
      actorType: "user",
      actorId: "test-user",
      details: { agentsRestored: 1 },
    });

    const rows = await db
      .select({
        id: agents.id,
        status: agents.status,
        pauseReason: agents.pauseReason,
        pausedAt: agents.pausedAt,
      })
      .from(agents);

    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(archivedPausedAgentId)).toMatchObject({
      status: "idle",
      pauseReason: null,
      pausedAt: null,
    });
    expect(byId.get(manualPausedAgentId)).toMatchObject({
      status: "paused",
      pauseReason: "manual",
    });
    expect(byId.get(pendingAgentId)).toMatchObject({
      status: "pending_approval",
      pauseReason: null,
    });
  });

  it("runs the archive cascade when update() transitions a company to archived", async () => {
    const companyId = randomUUID();
    const runningAgentId = randomUUID();
    const idleAgentId = randomUUID();
    const pendingAgentId = randomUUID();
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Update Archive Test Co",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: runningAgentId,
        companyId,
        name: "Running Agent",
        role: "engineer",
        status: "running",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: idleAgentId,
        companyId,
        name: "Idle Agent",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: pendingAgentId,
        companyId,
        name: "Pending Agent",
        role: "engineer",
        status: "pending_approval",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId: runningAgentId,
      source: "timer",
      status: "queued",
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: runningAgentId,
      invocationSource: "timer",
      status: "running",
      wakeupRequestId,
    });

    const archived = await companyService(db).update(
      companyId,
      { status: "archived" },
      { actorType: "user", actorId: "test-user", agentId: null, runId: null },
    );

    expect(archived?.status).toBe("archived");

    const rows = await db
      .select({ id: agents.id, status: agents.status, pauseReason: agents.pauseReason })
      .from(agents);
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(runningAgentId)).toMatchObject({ status: "paused", pauseReason: "company_archived" });
    expect(byId.get(idleAgentId)).toMatchObject({ status: "paused", pauseReason: "company_archived" });
    expect(byId.get(pendingAgentId)).toMatchObject({ status: "pending_approval", pauseReason: null });

    const run = await db
      .select({ status: heartbeatRuns.status, error: heartbeatRuns.error })
      .from(heartbeatRuns)
      .then((result) => result[0] ?? null);
    expect(run).toMatchObject({
      status: "cancelled",
      error: "Cancelled because the company was archived",
    });

    const archiveActivity = await db
      .select({
        actorType: activityLog.actorType,
        actorId: activityLog.actorId,
        details: activityLog.details,
      })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, "company.archived"),
      ));
    expect(archiveActivity).toHaveLength(1);
    expect(archiveActivity[0]).toMatchObject({
      actorType: "user",
      actorId: "test-user",
      details: { agentsPaused: 2, runsCancelled: 1 },
    });
  });

  it("reactivates company_archived agents even when going via paused state (archived → paused → active)", async () => {
    const companyId = randomUUID();
    const archivedPausedAgentId = randomUUID();
    const manualPausedAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Indirect Reactivate Test Co",
      status: "paused",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: archivedPausedAgentId,
        companyId,
        name: "Archived Paused Agent",
        role: "engineer",
        status: "paused",
        pauseReason: "company_archived",
        pausedAt: new Date("2026-06-01T00:00:00Z"),
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: manualPausedAgentId,
        companyId,
        name: "Manual Paused Agent",
        role: "engineer",
        status: "paused",
        pauseReason: "manual",
        pausedAt: new Date("2026-06-01T00:00:00Z"),
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    const reactivated = await companyService(db).update(
      companyId,
      { status: "active" },
      { actorType: "user", actorId: "test-user", agentId: null, runId: null },
    );

    expect(reactivated?.status).toBe("active");

    const rows = await db
      .select({ id: agents.id, status: agents.status, pauseReason: agents.pauseReason })
      .from(agents);
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(archivedPausedAgentId)).toMatchObject({ status: "idle", pauseReason: null });
    expect(byId.get(manualPausedAgentId)).toMatchObject({ status: "paused", pauseReason: "manual" });

    const reactivateActivity = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, "company.reactivated"),
      ));
    expect(reactivateActivity).toHaveLength(1);
    expect(reactivateActivity[0]).toMatchObject({ details: { agentsRestored: 1 } });
  });

  it("emits company.reactivated for archived → active even when no agents need restoring", async () => {
    const companyId = randomUUID();
    const terminatedAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Empty Reactivate Co",
      status: "archived",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: terminatedAgentId,
      companyId,
      name: "Terminated Agent",
      role: "engineer",
      status: "terminated",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const reactivated = await companyService(db).update(
      companyId,
      { status: "active" },
      { actorType: "user", actorId: "test-user", agentId: null, runId: null },
    );

    expect(reactivated?.status).toBe("active");

    const reactivateActivity = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, "company.reactivated"),
      ));
    expect(reactivateActivity).toHaveLength(1);
    expect(reactivateActivity[0]).toMatchObject({ details: { agentsRestored: 0 } });
  });

  it("does not emit company.reactivated when paused → active restores no archive-paused agents", async () => {
    const companyId = randomUUID();
    const manualPausedAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Plain Unpause Co",
      status: "paused",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: manualPausedAgentId,
      companyId,
      name: "Manual Paused Agent",
      role: "engineer",
      status: "paused",
      pauseReason: "manual",
      pausedAt: new Date("2026-06-01T00:00:00Z"),
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const reactivated = await companyService(db).update(
      companyId,
      { status: "active" },
      { actorType: "user", actorId: "test-user", agentId: null, runId: null },
    );

    expect(reactivated?.status).toBe("active");

    const reactivateActivity = await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, "company.reactivated"),
      ));
    expect(reactivateActivity).toHaveLength(0);

    const agent = await db
      .select({ status: agents.status, pauseReason: agents.pauseReason })
      .from(agents)
      .then((rows) => rows[0] ?? null);
    expect(agent).toMatchObject({ status: "paused", pauseReason: "manual" });
  });

  it("cancels orphan queued wakeup requests with no runId during archive", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const orphanWakeupId = randomUUID();
    const runWakeupId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Orphan Wakeup Co",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Idle Agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(agentWakeupRequests).values([
      {
        id: orphanWakeupId,
        companyId,
        agentId,
        source: "automation",
        status: "queued",
      },
      {
        id: runWakeupId,
        companyId,
        agentId,
        source: "timer",
        status: "queued",
      },
    ]);

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "timer",
      status: "running",
      wakeupRequestId: runWakeupId,
    });

    const archived = await companyService(db).archive(companyId, {
      actorType: "user",
      actorId: "test-user",
      agentId: null,
      runId: null,
    });
    expect(archived?.status).toBe("archived");

    const wakeups = await db
      .select({
        id: agentWakeupRequests.id,
        status: agentWakeupRequests.status,
        error: agentWakeupRequests.error,
      })
      .from(agentWakeupRequests);
    const byId = new Map(wakeups.map((row) => [row.id, row]));
    expect(byId.get(orphanWakeupId)).toMatchObject({
      status: "cancelled",
      error: "Cancelled because the company was archived",
    });
    expect(byId.get(runWakeupId)).toMatchObject({
      status: "cancelled",
      error: "Cancelled because the company was archived",
    });
  });

  it("archive() is idempotent — re-archiving emits no second cascade or activity entry", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Idempotent Archive Test Co",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Idle Agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const actor = { actorType: "user" as const, actorId: "test-user", agentId: null, runId: null };
    const first = await companyService(db).archive(companyId, actor);
    expect(first?.status).toBe("archived");

    const second = await companyService(db).archive(companyId, actor);
    expect(second?.status).toBe("archived");

    const archiveActivity = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, "company.archived"),
      ));
    expect(archiveActivity).toHaveLength(1);
    expect(archiveActivity[0]).toMatchObject({ details: { agentsPaused: 1, runsCancelled: 0 } });
  });

  it("runs the archive cascade when update() transitions a paused company to archived", async () => {
    const companyId = randomUUID();
    const idleAgentId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paused To Archived Test Co",
      status: "paused",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: idleAgentId,
      companyId,
      name: "Idle Agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: idleAgentId,
      invocationSource: "timer",
      status: "queued",
    });

    const archived = await companyService(db).update(
      companyId,
      { status: "archived" },
      { actorType: "user", actorId: "test-user", agentId: null, runId: null },
    );

    expect(archived?.status).toBe("archived");

    const agent = await db
      .select({ status: agents.status, pauseReason: agents.pauseReason })
      .from(agents)
      .then((rows) => rows[0] ?? null);
    expect(agent).toMatchObject({ status: "paused", pauseReason: "company_archived" });

    const run = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .then((rows) => rows[0] ?? null);
    expect(run?.status).toBe("cancelled");

    const archiveActivity = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, "company.archived"),
      ));
    expect(archiveActivity).toHaveLength(1);
    expect(archiveActivity[0]).toMatchObject({
      details: { agentsPaused: 1, runsCancelled: 1 },
    });
  });
});
