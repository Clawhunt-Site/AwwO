import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, agentWakeupRequests, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { hasPendingWakeForComment } from "../services/chat-compat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres pending-wake tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// hasPendingWakeForComment is how the chat stream tells a durably-deferred prompt
// (the agent is already running this issue → the wake is enqueued under THIS
// prompt's commentId and the in-flight run promotes it) apart from a genuine skip
// (no alive wake under this commentId). The defining property is that it scopes by
// commentId, NOT by issue: the in-flight run's OWN wake is `claimed` on the same
// issue, so an issue-only probe would falsely report queued for an unrelated skip.
describeEmbeddedPostgres("hasPendingWakeForComment", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("superclaw-pending-wake-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent(companyId: string, name = "Chat Assistant"): Promise<string> {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role: "engineer",
      status: "running",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true } },
      permissions: {},
    });
    return agentId;
  }

  async function seed(): Promise<{ companyId: string; agentId: string; issueId: string; commentId: string }> {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Local",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const agentId = await seedAgent(companyId);
    return { companyId, agentId, issueId: randomUUID(), commentId: randomUUID() };
  }

  async function insertWake(
    base: { companyId: string; agentId: string; issueId: string },
    status: string,
    commentId: string | null,
  ): Promise<void> {
    // Chat wakeup payload shape: { issueId, commentId }. A genuine skip writes the
    // same payload but status "skipped".
    await db.insert(agentWakeupRequests).values({
      companyId: base.companyId,
      agentId: base.agentId,
      source: "on_demand",
      status,
      payload: commentId === null ? { issueId: base.issueId } : { issueId: base.issueId, commentId },
    });
  }

  it("returns false when no wake rows exist", async () => {
    const ctx = await seed();
    expect(await hasPendingWakeForComment(db, ctx.companyId, ctx.agentId, ctx.commentId)).toBe(false);
  });

  it("returns true for a deferred_issue_execution wake carrying this commentId", async () => {
    const ctx = await seed();
    await insertWake(ctx, "deferred_issue_execution", ctx.commentId);
    expect(await hasPendingWakeForComment(db, ctx.companyId, ctx.agentId, ctx.commentId)).toBe(true);
  });

  it("returns true for queued and claimed wakes carrying this commentId", async () => {
    const ctx = await seed();
    await insertWake(ctx, "queued", ctx.commentId);
    expect(await hasPendingWakeForComment(db, ctx.companyId, ctx.agentId, ctx.commentId)).toBe(true);
    await db.delete(agentWakeupRequests);
    await insertWake(ctx, "claimed", ctx.commentId);
    expect(await hasPendingWakeForComment(db, ctx.companyId, ctx.agentId, ctx.commentId)).toBe(true);
  });

  it("returns false for a skipped wake (genuine skip writes status:skipped with this commentId)", async () => {
    const ctx = await seed();
    await insertWake(ctx, "skipped", ctx.commentId);
    expect(await hasPendingWakeForComment(db, ctx.companyId, ctx.agentId, ctx.commentId)).toBe(false);
  });

  it("returns false for terminal-status wakes (already finished, not pending)", async () => {
    const ctx = await seed();
    await insertWake(ctx, "succeeded", ctx.commentId);
    await insertWake(ctx, "failed", ctx.commentId);
    await insertWake(ctx, "cancelled", ctx.commentId);
    await insertWake(ctx, "done", ctx.commentId);
    expect(await hasPendingWakeForComment(db, ctx.companyId, ctx.agentId, ctx.commentId)).toBe(false);
  });

  // THE over-report regression Codex flagged: the in-flight run sets its OWN wake
  // to `claimed` on the SAME issue (a DIFFERENT commentId). A second prompt that
  // hits a genuine skip (returns null, records nothing pending under its commentId)
  // must NOT inherit that stale claimed row as "queued".
  it("does NOT count the in-flight run's claimed wake (same issue, different commentId)", async () => {
    const ctx = await seed();
    const inFlightCommentId = randomUUID(); // prompt #1, already running
    await insertWake(ctx, "claimed", inFlightCommentId);
    // prompt #2 (ctx.commentId) was genuinely skipped — nothing pending under it.
    expect(await hasPendingWakeForComment(db, ctx.companyId, ctx.agentId, ctx.commentId)).toBe(false);
    // ...and once prompt #2 IS deferred under its own commentId, it resolves true.
    await insertWake(ctx, "deferred_issue_execution", ctx.commentId);
    expect(await hasPendingWakeForComment(db, ctx.companyId, ctx.agentId, ctx.commentId)).toBe(true);
  });

  // COALESCE: a third prompt coalescing over this one overwrites the top-level
  // commentId with the newest, but every coalesced id survives in the merged
  // wake context's `wakeCommentIds`. The probe must still find this prompt there.
  it("matches a prompt that was coalesced over (id only in _paperclipWakeContext.wakeCommentIds)", async () => {
    const ctx = await seed();
    const newestCommentId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      companyId: ctx.companyId,
      agentId: ctx.agentId,
      source: "on_demand",
      status: "deferred_issue_execution",
      payload: {
        issueId: ctx.issueId,
        commentId: newestCommentId, // top level overwritten to the latest
        _paperclipWakeContext: {
          issueId: ctx.issueId,
          commentId: newestCommentId,
          wakeCommentId: newestCommentId,
          wakeCommentIds: [ctx.commentId, newestCommentId], // this prompt survives here
        },
      },
    });
    // The older (coalesced-over) prompt resolves true via the nested array...
    expect(await hasPendingWakeForComment(db, ctx.companyId, ctx.agentId, ctx.commentId)).toBe(true);
    // ...and so does the newest, via the top level.
    expect(await hasPendingWakeForComment(db, ctx.companyId, ctx.agentId, newestCommentId)).toBe(true);
  });

  it("matches this prompt's id nested under _paperclipWakeContext.commentId / wakeCommentId", async () => {
    const ctx = await seed();
    await db.insert(agentWakeupRequests).values({
      companyId: ctx.companyId,
      agentId: ctx.agentId,
      source: "on_demand",
      status: "deferred_issue_execution",
      // No top-level commentId; only the nested single ids carry it.
      payload: {
        issueId: ctx.issueId,
        _paperclipWakeContext: { commentId: ctx.commentId, wakeCommentId: ctx.commentId },
      },
    });
    expect(await hasPendingWakeForComment(db, ctx.companyId, ctx.agentId, ctx.commentId)).toBe(true);
  });

  // The over-report stays closed even with nested ids: the in-flight run's claimed
  // wake carries ITS OWN earlier id (top level AND nested), never this later prompt.
  it("does NOT count the in-flight claimed wake even when it has a nested wakeCommentIds", async () => {
    const ctx = await seed();
    const inFlightCommentId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      companyId: ctx.companyId,
      agentId: ctx.agentId,
      source: "on_demand",
      status: "claimed",
      payload: {
        issueId: ctx.issueId,
        commentId: inFlightCommentId,
        _paperclipWakeContext: {
          commentId: inFlightCommentId,
          wakeCommentId: inFlightCommentId,
          wakeCommentIds: [inFlightCommentId],
        },
      },
    });
    expect(await hasPendingWakeForComment(db, ctx.companyId, ctx.agentId, ctx.commentId)).toBe(false);
  });

  it("returns false when a pending wake carries no commentId in payload", async () => {
    const ctx = await seed();
    await insertWake(ctx, "queued", null);
    expect(await hasPendingWakeForComment(db, ctx.companyId, ctx.agentId, ctx.commentId)).toBe(false);
  });

  it("scopes by agent: another agent's pending wake with this commentId does not count", async () => {
    const ctx = await seed();
    const otherAgentId = await seedAgent(ctx.companyId, "Other");
    await insertWake({ ...ctx, agentId: otherAgentId }, "queued", ctx.commentId);
    expect(await hasPendingWakeForComment(db, ctx.companyId, ctx.agentId, ctx.commentId)).toBe(false);
    // ...but the correct agent's own pending wake still resolves true.
    await insertWake(ctx, "queued", ctx.commentId);
    expect(await hasPendingWakeForComment(db, ctx.companyId, ctx.agentId, ctx.commentId)).toBe(true);
  });
});
