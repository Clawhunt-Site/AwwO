import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { isVerifiedIssueCommentInteractionWake } from "../services/issue-tree-control.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

// Direct, fail-closed coverage for the verifier that gates blocker-bypass /
// interaction wakes. Replaces the brittle integration coverage that relied on
// the (now removed) sync `allowsIssueInteractionWake`. The verifier must:
//   - accept a wake whose contextSnapshot names a real comment on the issue,
//     a matching source, and an actor matching the comment author (or system);
//   - reject a forged commentId, wrong source, wrong reason, or actor mismatch.
describeEmbeddedPostgres("isVerifiedIssueCommentInteractionWake", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const companyId = randomUUID();
  const authorAgentId = randomUUID();
  const otherAgentId = randomUUID();
  const issueId = randomUUID();
  const commentId = randomUUID();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-comment-interaction-wake-");
    db = createDb(tempDb.connectionString);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    for (const id of [authorAgentId, otherAgentId]) {
      await db.insert(agents).values({
        id,
        companyId,
        name: `agent-${id.slice(0, 4)}`,
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
    }
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Mission",
      status: "todo",
      priority: "medium",
    });
    await db.insert(issueComments).values({
      id: commentId,
      companyId,
      issueId,
      authorAgentId,
      authorType: "agent",
      body: "please advise",
    });
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const validContext = {
    wakeReason: "issue_commented",
    source: "issue.comment",
    commentId,
  };

  it("accepts a real comment wake whose requester matches the comment author", async () => {
    const ok = await isVerifiedIssueCommentInteractionWake(db, {
      companyId,
      issueId,
      agentId: authorAgentId,
      requestedByActorType: "agent",
      requestedByActorId: authorAgentId,
      contextSnapshot: validContext,
    });
    expect(ok).toBe(true);
  });

  it("accepts a trusted system requester for any real comment", async () => {
    const ok = await isVerifiedIssueCommentInteractionWake(db, {
      companyId,
      issueId,
      requestedByActorType: "system",
      requestedByActorId: "heartbeat",
      contextSnapshot: validContext,
    });
    expect(ok).toBe(true);
  });

  it("rejects a forged commentId that has no real comment", async () => {
    const bad = await isVerifiedIssueCommentInteractionWake(db, {
      companyId,
      issueId,
      requestedByActorType: "system",
      requestedByActorId: "heartbeat",
      contextSnapshot: { wakeReason: "issue_commented", source: "issue.comment", commentId: randomUUID() },
    });
    expect(bad).toBe(false);
  });

  it("rejects a wake whose source does not match the reason", async () => {
    const bad = await isVerifiedIssueCommentInteractionWake(db, {
      companyId,
      issueId,
      requestedByActorType: "system",
      requestedByActorId: "heartbeat",
      // issue_commented requires source "issue.comment", not the reopen source
      contextSnapshot: { wakeReason: "issue_commented", source: "issue.comment.reopen", commentId },
    });
    expect(bad).toBe(false);
  });

  it("rejects a wake whose reason is not a comment-interaction reason", async () => {
    const bad = await isVerifiedIssueCommentInteractionWake(db, {
      companyId,
      issueId,
      requestedByActorType: "system",
      requestedByActorId: "heartbeat",
      contextSnapshot: { wakeReason: "issue_assigned", source: "issue.comment", commentId },
    });
    expect(bad).toBe(false);
  });

  it("rejects an actor that is neither the comment author nor system (no verified wake request)", async () => {
    const bad = await isVerifiedIssueCommentInteractionWake(db, {
      companyId,
      issueId,
      agentId: otherAgentId,
      requestedByActorType: "agent",
      requestedByActorId: otherAgentId,
      contextSnapshot: validContext,
    });
    expect(bad).toBe(false);
  });

  it("rejects a contextSnapshot with no source", async () => {
    const bad = await isVerifiedIssueCommentInteractionWake(db, {
      companyId,
      issueId,
      requestedByActorType: "system",
      requestedByActorId: "heartbeat",
      contextSnapshot: { wakeReason: "issue_commented", commentId },
    });
    expect(bad).toBe(false);
  });

  it("rejects a comment that belongs to a different issue", async () => {
    const bad = await isVerifiedIssueCommentInteractionWake(db, {
      companyId,
      issueId: randomUUID(), // not the issue the comment is on
      requestedByActorType: "system",
      requestedByActorId: "heartbeat",
      contextSnapshot: validContext,
    });
    expect(bad).toBe(false);
  });
});
