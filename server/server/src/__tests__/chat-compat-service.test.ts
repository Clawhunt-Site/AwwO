import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentTaskSessions,
  companies,
  costEvents,
  createDb,
  environments,
  financeEvents,
  issueComments,
  issues,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  appendUserTurn,
  buildChatWorkspaceInventory,
  CHAT_BUILTIN_WORKSPACE_ID,
  chatCompatService,
  chatWorkspaceExists,
  createChatSession,
  createChatWorkspace,
  deleteChatWorkspace,
  ensureLocalChatCompany,
  LOCAL_CHAT_COMPANY_ID,
  moveChatSession,
  renameChatWorkspace,
  setChatArchived,
  toBackendChatSession,
} from "../services/chat-compat.ts";
import { chatSidebarPins, readChatPins, setChatPin } from "../services/chat-pins.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres chat-compat tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("chat-compat read projection", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("superclaw-chat-compat-");
    db = createDb(tempDb.connectionString);
    // chat_sidebar_pins is created lazily by the pin helpers; touch it once so
    // the table exists for the afterEach cleanup of every test (even pin-free ones).
    await readChatPins(db, "00000000-0000-0000-0000-000000000000", "workspace");
  }, 20_000);

  afterEach(async () => {
    await db.delete(chatSidebarPins);
    await db.delete(issueComments);
    await db.delete(agentTaskSessions);
    // finance_events references cost_events; both pin agents/companies/projects
    // (RESTRICT), so clear the ledgers before those parents.
    await db.delete(financeEvents);
    await db.delete(costEvents);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    // companyService.create provisions a local environment (FK to company).
    await db.delete(environments);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(): Promise<string> {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Local",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  // Chat sessions are issues marked with origin_kind="chat"; tests default to
  // that, and pass origin_kind="manual" to seed a non-chat work issue.
  async function seedIssue(
    companyId: string,
    title: string,
    overrides: { hiddenAt?: Date; updatedAt?: Date; originKind?: string } = {},
  ): Promise<string> {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId,
      title,
      originKind: overrides.originKind ?? "chat",
      ...(overrides.hiddenAt ? { hiddenAt: overrides.hiddenAt } : {}),
      ...(overrides.updatedAt ? { updatedAt: overrides.updatedAt } : {}),
    });
    return id;
  }

  async function seedComment(
    companyId: string,
    issueId: string,
    body: string,
    opts: { authorType?: string; createdAt?: Date; deletedAt?: Date; presentation?: unknown } = {},
  ): Promise<void> {
    await db.insert(issueComments).values({
      companyId,
      issueId,
      body,
      authorType: (opts.authorType ?? "user") as never,
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
      ...(opts.deletedAt ? { deletedAt: opts.deletedAt } : {}),
      ...(opts.presentation ? { presentation: opts.presentation as never } : {}),
    });
  }

  it("lists chat sessions newest-first, excludes hidden, and skips deleted comments", async () => {
    const companyId = await seedCompany();
    const alpha = await seedIssue(companyId, "alpha", {
      updatedAt: new Date("2026-04-21T10:00:00.000Z"),
    });
    const beta = await seedIssue(companyId, "beta", {
      updatedAt: new Date("2026-04-21T12:00:00.000Z"),
    });
    await seedIssue(companyId, "gamma-hidden", { hiddenAt: new Date("2026-04-21T11:00:00.000Z") });

    await seedComment(companyId, alpha, "hi there", {
      authorType: "user",
      createdAt: new Date("2026-04-21T10:01:00.000Z"),
    });
    await seedComment(companyId, alpha, "hello back", {
      authorType: "agent",
      createdAt: new Date("2026-04-21T10:02:00.000Z"),
    });
    await seedComment(companyId, alpha, "tombstone", {
      authorType: "user",
      createdAt: new Date("2026-04-21T10:03:00.000Z"),
      deletedAt: new Date("2026-04-21T10:04:00.000Z"),
    });
    await seedComment(companyId, beta, "only turn", { authorType: "user" });

    const svc = chatCompatService(db);
    const visible = await svc.listChatSessions(companyId);

    expect(visible.map((s) => s.issue.title)).toEqual(["beta", "alpha"]);
    const alphaResult = visible.find((s) => s.issue.title === "alpha")!;
    // Deleted comment excluded; remaining are chronological.
    expect(alphaResult.comments.map((c) => c.body)).toEqual(["hi there", "hello back"]);

    const withArchived = await svc.listChatSessions(companyId, { includeArchived: true });
    expect(withArchived.map((s) => s.issue.title)).toContain("gamma-hidden");
  });

  it("projects an issue + comments to the legacy chat wire shape", async () => {
    const companyId = await seedCompany();
    const issueId = await seedIssue(companyId, "shape", {
      hiddenAt: new Date("2026-04-21T13:00:00.000Z"),
    });
    await seedComment(companyId, issueId, "user says", { authorType: "user" });
    await seedComment(companyId, issueId, "agent says", { authorType: "agent" });

    const svc = chatCompatService(db);
    const found = await svc.getChatSession(issueId);
    expect(found).not.toBeNull();

    const wire = toBackendChatSession(found!.issue, found!.comments);
    expect(wire.session_id).toBe(issueId);
    expect(wire.title).toBe("shape");
    expect(typeof wire.created_at).toBe("number");
    expect(wire.archived).toBe(true); // hidden → archived
    expect(wire.pinned_at).toBeNull();
    expect(wire.workspace_id).toBeNull();
    expect(wire.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(wire.messages[0].content).toBe("user says");
    expect(wire.messages[0].run_id).toBeNull();
    expect(typeof wire.messages[0].created_at).toBe("number");
  });

  it("exposes executionState.runtime as metadata.runtime (per-chat sticky runtime)", async () => {
    const companyId = await seedCompany();
    const issueId = await seedIssue(companyId, "sticky runtime");
    // persistChatTurnRuntime stores the sticky runtime here every turn; the
    // projector must surface it so the surface can restore per-chat model/effort.
    await db
      .update(issues)
      .set({ executionState: { runtime: { backend: "codex", model: "gpt-5.5", effort: "high" } } })
      .where(eq(issues.id, issueId));

    const found = await chatCompatService(db).getChatSession(issueId);
    const wire = toBackendChatSession(found!.issue, found!.comments);
    expect(wire.metadata).toEqual({ runtime: { backend: "codex", model: "gpt-5.5", effort: "high" } });
  });

  it("emits empty metadata when the chat has no sticky runtime", async () => {
    const companyId = await seedCompany();
    const issueId = await seedIssue(companyId, "no runtime");
    const found = await chatCompatService(db).getChatSession(issueId);
    const wire = toBackendChatSession(found!.issue, found!.comments);
    expect(wire.metadata).toEqual({});
  });

  it("drops system entries (system_notice ops posts + system notes) from the projected transcript", async () => {
    const companyId = await seedCompany();
    const issueId = await seedIssue(companyId, "ops notice");
    await seedComment(companyId, issueId, "user turn", {
      authorType: "user",
      createdAt: new Date("2026-04-21T10:00:00.000Z"),
    });
    // An agent-authored operational post (e.g. a legacy workspace-ready comment)
    // marked system_notice must NOT masquerade as an assistant reply — and it is
    // not conversation either, so the projection drops it entirely.
    await seedComment(companyId, issueId, "## Workspace Ready", {
      authorType: "agent",
      presentation: { kind: "system_notice", tone: "neutral" },
      createdAt: new Date("2026-04-21T10:00:01.000Z"),
    });
    // A system-authored transcript marker (the runtime-switch handoff note) stays
    // in the DB for wake replay but never surfaces as a visible chat turn.
    await seedComment(companyId, issueId, "[runtime switched: codex_local → clawwork_local]", {
      authorType: "system",
      createdAt: new Date("2026-04-21T10:00:02.000Z"),
    });
    await seedComment(companyId, issueId, "real reply", {
      authorType: "agent",
      createdAt: new Date("2026-04-21T10:00:03.000Z"),
    });

    const found = await chatCompatService(db).getChatSession(issueId);
    const wire = toBackendChatSession(found!.issue, found!.comments);
    expect(wire.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(wire.messages[0].content).toBe("user turn");
    expect(wire.messages[1].content).toBe("real reply");
  });

  it("excludes non-chat issues from the list and refuses to fetch one as a chat", async () => {
    const companyId = await seedCompany();
    const work = await seedIssue(companyId, "real work item", { originKind: "manual" });
    await seedComment(companyId, work, "a work note");
    const chat = await seedIssue(companyId, "a chat");

    const svc = chatCompatService(db);
    const list = await svc.listChatSessions(companyId);
    expect(list.map((s) => s.issue.title)).toEqual(["a chat"]);
    expect(await svc.getChatSession(work)).toBeNull(); // non-chat issue is not a session
    expect(await svc.getChatSession(chat)).not.toBeNull();
  });

  it("maps a project-scoped chat's workspace_id to the project id (B2)", async () => {
    const companyId = await seedCompany();
    const projectId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId, name: "My Project" });
    const issueId = await seedIssue(companyId, "project chat");
    await db.update(issues).set({ projectId }).where(eq(issues.id, issueId));

    const found = await chatCompatService(db).getChatSession(issueId);
    const wire = toBackendChatSession(found!.issue, found!.comments);
    expect(wire.workspace_id).toBe(projectId);
  });

  it("scopes getChatSession to the requested company", async () => {
    const companyId = await seedCompany();
    const issueId = await seedIssue(companyId, "scoped");
    const svc = chatCompatService(db);
    expect(await svc.getChatSession(issueId, { companyId })).not.toBeNull();
    // A different company must not be able to fetch this session.
    expect(await svc.getChatSession(issueId, { companyId: randomUUID() })).toBeNull();
  });

  it("ensures the local chat company idempotently (fixed id, single row)", async () => {
    const first = await ensureLocalChatCompany(db);
    const second = await ensureLocalChatCompany(db);
    expect(first).toBe(second);
    const rows = await db.select().from(companies).where(eq(companies.id, first));
    expect(rows).toHaveLength(1);
  });

  it("creates a chat session + user turn readable through the projection", async () => {
    const companyId = await ensureLocalChatCompany(db);
    const issue = await createChatSession(db, companyId, { title: "first chat" });
    await appendUserTurn(db, issue.id, "hello world");

    const found = await chatCompatService(db).getChatSession(issue.id, { companyId });
    expect(found).not.toBeNull();
    expect(found!.issue.title).toBe("first chat");
    expect(found!.issue.originKind).toBe("chat");
    expect(found!.comments.map((c) => c.body)).toEqual(["hello world"]);
    expect(found!.comments[0].authorType).toBe("user");
  });

  it("createChatSession with a projectId files the chat into the project's PRIMARY workspace", async () => {
    const companyId = await seedCompany();
    const projectId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId, name: "Pinned" });
    // A NON-primary workspace created FIRST (earlier createdAt) and a PRIMARY one
    // created LATER. A createdAt-first pick would wrongly choose the secondary,
    // so asserting the primary proves the native `isPrimary DESC` selection is
    // honored — exactly what the old projectId-only move shortcut bypassed
    // (it left projectWorkspaceId null and let heartbeat resolve a non-primary cwd).
    const [secondary] = await db
      .insert(projectWorkspaces)
      .values({
        companyId,
        projectId,
        name: "secondary",
        cwd: "/repo/secondary",
        isPrimary: false,
        createdAt: new Date("2026-04-21T10:00:00.000Z"),
      })
      .returning({ id: projectWorkspaces.id });
    const [primary] = await db
      .insert(projectWorkspaces)
      .values({
        companyId,
        projectId,
        name: "primary",
        cwd: "/repo/primary",
        isPrimary: true,
        createdAt: new Date("2026-04-21T11:00:00.000Z"),
      })
      .returning({ id: projectWorkspaces.id });

    const issue = await createChatSession(db, companyId, { title: "pinned chat", projectId });
    const row = await db
      .select({ projectId: issues.projectId, projectWorkspaceId: issues.projectWorkspaceId })
      .from(issues)
      .where(eq(issues.id, issue.id))
      .then((r) => r[0]);
    expect(row.projectId).toBe(projectId);
    expect(row.projectWorkspaceId).toBe(primary.id);
    expect(row.projectWorkspaceId).not.toBe(secondary.id);
  });

  it("createChatSession without a projectId leaves the chat unbound", async () => {
    const companyId = await ensureLocalChatCompany(db);
    const issue = await createChatSession(db, companyId, { title: "loose chat" });
    const row = await db
      .select({ projectId: issues.projectId, projectWorkspaceId: issues.projectWorkspaceId })
      .from(issues)
      .where(eq(issues.id, issue.id))
      .then((r) => r[0]);
    expect(row.projectId).toBeNull();
    expect(row.projectWorkspaceId).toBeNull();
  });

  it("chatWorkspaceExists is true only for a project in the requested company", async () => {
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany();
    const projectId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId, name: "Owned" });
    expect(await chatWorkspaceExists(db, projectId, { companyId })).toBe(true);
    // Unknown id → false; a real project in ANOTHER company → false (scoped),
    // matching moveChatSession's own company-scoped validation.
    expect(await chatWorkspaceExists(db, randomUUID(), { companyId })).toBe(false);
    expect(await chatWorkspaceExists(db, projectId, { companyId: otherCompanyId })).toBe(false);
  });

  it("refuses to append a turn to a non-chat issue (no dirty comment)", async () => {
    const companyId = await seedCompany();
    const work = await seedIssue(companyId, "real work", { originKind: "manual" });
    await expect(appendUserTurn(db, work, "sneaky")).rejects.toBeTruthy();
    expect(await db.select().from(issueComments)).toHaveLength(0);
  });

  it("refuses to append a turn scoped to the wrong company (no dirty comment)", async () => {
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany();
    const issueId = await seedIssue(companyId, "a chat"); // origin_kind=chat by default
    await expect(appendUserTurn(db, issueId, "x", { companyId: otherCompanyId })).rejects.toBeTruthy();
    expect(await db.select().from(issueComments)).toHaveLength(0);
  });

  it("archives/unarchives a chat session, scoped to its company", async () => {
    const companyId = await seedCompany();
    const issueId = await seedIssue(companyId, "to archive");
    const svc = chatCompatService(db);
    expect(await setChatArchived(db, issueId, true, { companyId })).toBe(true);
    expect((await svc.getChatSession(issueId, { companyId }))!.issue.hiddenAt).not.toBeNull();
    expect(await setChatArchived(db, issueId, false, { companyId })).toBe(true);
    expect((await svc.getChatSession(issueId, { companyId }))!.issue.hiddenAt).toBeNull();
    expect(await setChatArchived(db, issueId, true, { companyId: randomUUID() })).toBe(false);
  });

  it("moves a chat session to a company project, rejecting unknown/missing targets", async () => {
    const companyId = await seedCompany();
    const projectId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId, name: "Proj" });
    const issueId = await seedIssue(companyId, "to move");
    const svc = chatCompatService(db);
    expect(await moveChatSession(db, issueId, projectId, { companyId })).toBe("ok");
    expect((await svc.getChatSession(issueId, { companyId }))!.issue.projectId).toBe(projectId);
    expect(await moveChatSession(db, issueId, randomUUID(), { companyId })).toBe("unknown_workspace");
    expect(await moveChatSession(db, randomUUID(), null, { companyId })).toBe("not_found");
  });

  it("atomically resets the adapter resume state on move", async () => {
    const companyId = await seedCompany();
    const projectId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId, name: "P" });
    const issueId = await seedIssue(companyId, "movable");
    const agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "A", adapterType: "claude_local" });
    await db.insert(agentTaskSessions).values({
      companyId,
      agentId,
      adapterType: "claude_local",
      taskKey: issueId,
      sessionParamsJson: { sessionId: "s1" },
    });

    expect(await moveChatSession(db, issueId, projectId, { companyId })).toBe("ok");
    const remaining = await db
      .select()
      .from(agentTaskSessions)
      .where(eq(agentTaskSessions.taskKey, issueId));
    expect(remaining).toHaveLength(0);
  });

  it("moveChatSession re-homes onto the project's PRIMARY workspace, and ungroup clears it", async () => {
    const companyId = await seedCompany();
    const projectId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId, name: "Multi" });
    // Secondary created FIRST (earlier createdAt), primary created LATER: a
    // createdAt-first pick would wrongly choose the secondary. The re-home must
    // pick the PRIMARY — the same cwd a fresh chat created in this project gets.
    await db.insert(projectWorkspaces).values({
      companyId,
      projectId,
      name: "secondary",
      cwd: "/repo/secondary",
      isPrimary: false,
      createdAt: new Date("2026-04-21T10:00:00.000Z"),
    });
    const [primary] = await db
      .insert(projectWorkspaces)
      .values({
        companyId,
        projectId,
        name: "primary",
        cwd: "/repo/primary",
        isPrimary: true,
        createdAt: new Date("2026-04-21T11:00:00.000Z"),
      })
      .returning({ id: projectWorkspaces.id });
    const issueId = await seedIssue(companyId, "to rehome");

    expect(await moveChatSession(db, issueId, projectId, { companyId })).toBe("ok");
    let row = await db
      .select({ projectId: issues.projectId, projectWorkspaceId: issues.projectWorkspaceId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((r) => r[0]);
    expect(row.projectId).toBe(projectId);
    expect(row.projectWorkspaceId).toBe(primary.id);

    // Ungrouping clears BOTH the project and its workspace binding (no stale cwd).
    expect(await moveChatSession(db, issueId, null, { companyId })).toBe("ok");
    row = await db
      .select({ projectId: issues.projectId, projectWorkspaceId: issues.projectWorkspaceId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((r) => r[0]);
    expect(row.projectId).toBeNull();
    expect(row.projectWorkspaceId).toBeNull();
  });

  it("create AND move both honor a project-policy default workspace (not the isPrimary one)", async () => {
    const companyId = await seedCompany();
    const projectId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId, name: "Policy" });
    const [wsPrimary] = await db
      .insert(projectWorkspaces)
      .values({
        companyId,
        projectId,
        name: "primary",
        cwd: "/repo/primary",
        isPrimary: true,
        createdAt: new Date("2026-04-21T10:00:00.000Z"),
      })
      .returning({ id: projectWorkspaces.id });
    const [wsDefault] = await db
      .insert(projectWorkspaces)
      .values({
        companyId,
        projectId,
        name: "policy-default",
        cwd: "/repo/default",
        isPrimary: false,
        createdAt: new Date("2026-04-21T11:00:00.000Z"),
      })
      .returning({ id: projectWorkspaces.id });
    // Project policy steers execution to a NON-primary workspace. Both the native
    // create path and the move resolver must honor it (else create and move pick
    // DIFFERENT cwds for the same project — the divergence this test guards).
    await db
      .update(projects)
      .set({ executionWorkspacePolicy: { defaultProjectWorkspaceId: wsDefault.id } })
      .where(eq(projects.id, projectId));

    const created = await createChatSession(db, companyId, { title: "policy chat", projectId });
    const createdRow = await db
      .select({ pwid: issues.projectWorkspaceId })
      .from(issues)
      .where(eq(issues.id, created.id))
      .then((r) => r[0]);
    expect(createdRow.pwid).toBe(wsDefault.id);
    expect(createdRow.pwid).not.toBe(wsPrimary.id);

    const movable = await seedIssue(companyId, "rehome under policy");
    expect(await moveChatSession(db, movable, projectId, { companyId })).toBe("ok");
    const movedRow = await db
      .select({ pwid: issues.projectWorkspaceId })
      .from(issues)
      .where(eq(issues.id, movable))
      .then((r) => r[0]);
    // Same selection as create — never the isPrimary fallback.
    expect(movedRow.pwid).toBe(wsDefault.id);
    expect(movedRow.pwid).not.toBe(wsPrimary.id);
  });

  it("refuses a policy default that points at ANOTHER project's workspace (create AND move fall back to the own primary)", async () => {
    const companyId = await seedCompany();
    // Foreign project with its own workspace.
    const foreignProjectId = randomUUID();
    await db.insert(projects).values({ id: foreignProjectId, companyId, name: "Foreign" });
    const [wsForeign] = await db
      .insert(projectWorkspaces)
      .values({ companyId, projectId: foreignProjectId, name: "foreign", cwd: "/repo/foreign", isPrimary: true })
      .returning({ id: projectWorkspaces.id });
    // Target project with its own primary, but a MISCONFIGURED policy default
    // pointing at the foreign workspace (the policy validator only checks UUID
    // shape, not ownership). Native create would reject this via
    // assertValidProjectWorkspace; the chat resolver instead refuses the foreign
    // id and falls back to the own primary — so create and move stay identical and
    // NEITHER ever writes a cross-project workspace onto the issue.
    const projectId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId, name: "Target" });
    const [wsOwn] = await db
      .insert(projectWorkspaces)
      .values({ companyId, projectId, name: "own", cwd: "/repo/own", isPrimary: true })
      .returning({ id: projectWorkspaces.id });
    await db
      .update(projects)
      .set({ executionWorkspacePolicy: { defaultProjectWorkspaceId: wsForeign.id } })
      .where(eq(projects.id, projectId));

    const created = await createChatSession(db, companyId, { title: "guarded", projectId });
    const createdRow = await db
      .select({ pwid: issues.projectWorkspaceId })
      .from(issues)
      .where(eq(issues.id, created.id))
      .then((r) => r[0]);
    expect(createdRow.pwid).toBe(wsOwn.id);
    expect(createdRow.pwid).not.toBe(wsForeign.id);

    const movable = await seedIssue(companyId, "rehome guarded");
    expect(await moveChatSession(db, movable, projectId, { companyId })).toBe("ok");
    const movedRow = await db
      .select({ pwid: issues.projectWorkspaceId })
      .from(issues)
      .where(eq(issues.id, movable))
      .then((r) => r[0]);
    expect(movedRow.pwid).toBe(wsOwn.id);
    expect(movedRow.pwid).not.toBe(wsForeign.id);
  });

  it("create AND move agree when a project has NO own workspace and only a foreign policy default (both bind a null workspace, neither throws)", async () => {
    const companyId = await seedCompany();
    // Foreign project owning the workspace the misconfigured default points at.
    const foreignProjectId = randomUUID();
    await db.insert(projects).values({ id: foreignProjectId, companyId, name: "Foreign" });
    const [wsForeign] = await db
      .insert(projectWorkspaces)
      .values({ companyId, projectId: foreignProjectId, name: "foreign", cwd: "/repo/foreign", isPrimary: true })
      .returning({ id: projectWorkspaces.id });
    // Target project with NO workspaces of its own + a policy default → foreign.
    // Native issueService.create would re-resolve that default and THROW; the chat
    // paths must instead bind the project with a NULL workspace (run in the managed
    // Chat scratch) — and create must agree with move (no divergence, no throw).
    const projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Empty",
      executionWorkspacePolicy: { defaultProjectWorkspaceId: wsForeign.id },
    });

    const created = await createChatSession(db, companyId, { title: "empty pin", projectId });
    const createdRow = await db
      .select({ projectId: issues.projectId, pwid: issues.projectWorkspaceId })
      .from(issues)
      .where(eq(issues.id, created.id))
      .then((r) => r[0]);
    expect(createdRow.projectId).toBe(projectId);
    expect(createdRow.pwid).toBeNull();

    const movable = await seedIssue(companyId, "empty rehome");
    expect(await moveChatSession(db, movable, projectId, { companyId })).toBe("ok");
    const movedRow = await db
      .select({ projectId: issues.projectId, pwid: issues.projectWorkspaceId })
      .from(issues)
      .where(eq(issues.id, movable))
      .then((r) => r[0]);
    expect(movedRow.projectId).toBe(projectId);
    expect(movedRow.pwid).toBeNull();
  });

  it("createChatSession returns the BOUND row for a folder-only project (no stale pre-bind projectId)", async () => {
    const companyId = await seedCompany();
    const projectId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId, name: "FolderOnly" });
    // No workspaces ⇒ the null-workspace bind path (create unbound, then move).
    const issue = await createChatSession(db, companyId, { title: "folder chat", projectId });
    // The RETURNED row must reflect the bind, not the stale pre-move object whose
    // projectId is still null.
    expect(issue.projectId).toBe(projectId);
    expect(issue.projectWorkspaceId).toBeNull();
  });

  it("createChatSession refuses an unknown / cross-company project (no unbound issue leaked)", async () => {
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany();
    const foreignProjectId = randomUUID();
    await db.insert(projects).values({ id: foreignProjectId, companyId: otherCompanyId, name: "Other" });

    const before = await db.select({ id: issues.id }).from(issues);
    // Unknown project id → fail-closed (throws), creates nothing — never a stray
    // unbound chat issue (which is what move rejects with "unknown_workspace").
    await expect(
      createChatSession(db, companyId, { title: "x", projectId: randomUUID() }),
    ).rejects.toBeTruthy();
    // A real project but in ANOTHER company → also refused (company-scoped).
    await expect(
      createChatSession(db, companyId, { title: "x", projectId: foreignProjectId }),
    ).rejects.toBeTruthy();
    const after = await db.select({ id: issues.id }).from(issues);
    expect(after.length).toBe(before.length);

    // move agrees: the same unknown/cross-company targets are rejected.
    const issueId = await seedIssue(companyId, "loose");
    expect(await moveChatSession(db, issueId, randomUUID(), { companyId })).toBe("unknown_workspace");
    expect(await moveChatSession(db, issueId, foreignProjectId, { companyId })).toBe("unknown_workspace");
  });

  it("builds the sidebar workspace inventory (projects + repo/trust + counts)", async () => {
    const companyId = await seedCompany();
    const projectId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId, name: "Alpha" });
    await db
      .insert(projectWorkspaces)
      .values({ companyId, projectId, name: "ws", cwd: "/repo/alpha", isPrimary: true });
    const a = await seedIssue(companyId, "c1");
    await db.update(issues).set({ projectId }).where(eq(issues.id, a));
    const b = await seedIssue(companyId, "c2");
    await db.update(issues).set({ projectId }).where(eq(issues.id, b));
    await seedIssue(companyId, "ungrouped"); // projectId null

    const inv = await buildChatWorkspaceInventory(db, companyId);
    expect(inv.count).toBe(2); // built-in Chat home + the project
    expect(inv.unassigned_session_count).toBe(1);
    // The inventory always leads with the built-in Chat home (persistent Chats
    // section); the lone ungrouped chat is hosted there.
    expect(inv.workspaces[0].builtin_chat).toBe(true);
    expect(inv.workspaces[0].workspace_id).toBe(CHAT_BUILTIN_WORKSPACE_ID);
    expect(inv.workspaces[0].session_count).toBe(1);
    const ws = inv.workspaces.find((w) => w.workspace_id === projectId)!;
    expect(ws.workspace_id).toBe(projectId);
    expect(ws.name).toBe("Alpha");
    expect(ws.repo_path).toBe("/repo/alpha");
    expect(ws.is_trusted).toBe(true);
    expect(ws.session_count).toBe(2);
    // §6.5 contract fidelity: every field the SuperClaw workspace_projection
    // declares is present and honest (explicit single-operator-local constants),
    // not stubbed/dropped. trust_status uses the contract's `active` value (a
    // non-`active` value would make the surface render a trust barrier), and the
    // governance fields project to the local floor rather than being omitted.
    expect(ws.trust_status).toBe("active");
    // trust_source must be a value the kernel actually emits (cli_prompt | managed
    // | api | legacy), never a surface-invented enum. A project WITH a real cwd is
    // not app-owned scratch, so it reports `api` (established via the surface),
    // never `managed` (which would mislabel a concrete path as app-owned).
    expect(ws.trust_source).toBe("api");
    // is_trusted is the kernel's derived boolean `trust_status === "active"`; lock
    // the invariant so the two can't drift apart.
    expect(ws.is_trusted).toBe(ws.trust_status === "active");
    expect(ws.company_profile_id).toBe(companyId);
    expect(ws.kind).toBe("project");
    expect(ws.builtin_chat).toBe(false);
    expect(ws.containment_preset).toBe("standard");
    expect(ws.effective_containment).toBe("standard");
    expect(ws.pinned).toBe(false);
    expect(ws.pinned_at).toBeNull();
  });

  it("workspace counts exclude hidden, non-chat, and cross-company issues", async () => {
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany();
    const projectId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId, name: "P" });
    // counts (ungrouped, chat, visible) = 1
    await seedIssue(companyId, "real");
    // excluded: hidden
    await seedIssue(companyId, "hidden", { hiddenAt: new Date() });
    // excluded: non-chat
    await seedIssue(companyId, "work", { originKind: "manual" });
    // excluded: another company
    await seedIssue(otherCompanyId, "foreign");

    const inv = await buildChatWorkspaceInventory(db, companyId);
    expect(inv.unassigned_session_count).toBe(1);
  });

  it("returns null for an unknown session", async () => {
    const svc = chatCompatService(db);
    expect(await svc.getChatSession(randomUUID())).toBeNull();
  });

  it("createChatWorkspace creates a project under the local chat company (folder-only)", async () => {
    const ws = await createChatWorkspace(db, { name: "Alpha" });
    expect(ws.name).toBe("Alpha");
    expect(ws.workspace_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(ws.repo_path).toBe("");
    expect(ws.session_count).toBe(0);
    // §6.5-faithful projection, identical shape to the inventory.
    expect(ws.trust_status).toBe("active");
    expect(ws.trust_source).toBe("managed");
    expect(ws.company_profile_id).toBe(LOCAL_CHAT_COMPANY_ID);
    const inv = await buildChatWorkspaceInventory(db, LOCAL_CHAT_COMPANY_ID);
    expect(inv.workspaces.map((w) => w.workspace_id)).toContain(ws.workspace_id);
  });

  it("renameChatWorkspace renames within the local company and rejects foreign/missing", async () => {
    const ws = await createChatWorkspace(db, { name: "Old" });
    expect(
      await renameChatWorkspace(db, ws.workspace_id, "New", { companyId: LOCAL_CHAT_COMPANY_ID }),
    ).toBe(true);
    const inv = await buildChatWorkspaceInventory(db, LOCAL_CHAT_COMPANY_ID);
    expect(inv.workspaces.find((w) => w.workspace_id === ws.workspace_id)?.name).toBe("New");
    // a different company can't rename it; an unknown id can't either
    const otherCompany = await seedCompany();
    expect(
      await renameChatWorkspace(db, ws.workspace_id, "Hijack", { companyId: otherCompany }),
    ).toBe(false);
    expect(
      await renameChatWorkspace(db, randomUUID(), "X", { companyId: LOCAL_CHAT_COMPANY_ID }),
    ).toBe(false);
  });

  it("deleteChatWorkspace removes the project but reassigns its chats to unassigned (no data loss)", async () => {
    const ws = await createChatWorkspace(db, { name: "Doomed" });
    const sessionId = await seedIssue(LOCAL_CHAT_COMPANY_ID, "kept");
    await db.update(issues).set({ projectId: ws.workspace_id }).where(eq(issues.id, sessionId));

    expect(
      await deleteChatWorkspace(db, ws.workspace_id, { companyId: LOCAL_CHAT_COMPANY_ID }),
    ).toBe(true);

    // Project gone from the inventory.
    const inv = await buildChatWorkspaceInventory(db, LOCAL_CHAT_COMPANY_ID);
    expect(inv.workspaces.map((w) => w.workspace_id)).not.toContain(ws.workspace_id);
    // The chat survives, now unassigned (projectId null) rather than deleted.
    const survivor = await db
      .select()
      .from(issues)
      .where(eq(issues.id, sessionId))
      .then((rows) => rows[0]);
    expect(survivor).toBeTruthy();
    expect(survivor!.projectId).toBeNull();
    expect(inv.unassigned_session_count).toBe(1);
  });

  it("deleteChatWorkspace detaches cost/finance ledger rows so a billed workspace is removable", async () => {
    // Regression: cost_events.projectId / finance_events.projectId are RESTRICT
    // and get stamped on every billed agent run, so a workspace that had ever run
    // an agent could never be deleted — the delete raised a foreign-key violation
    // ("Failed query: delete from projects ...") and the group stuck around.
    const ws = await createChatWorkspace(db, { name: "Billed" });
    const agentId = randomUUID();
    await db
      .insert(agents)
      .values({ id: agentId, companyId: LOCAL_CHAT_COMPANY_ID, name: "billed-agent" });
    const costId = randomUUID();
    await db.insert(costEvents).values({
      id: costId,
      companyId: LOCAL_CHAT_COMPANY_ID,
      agentId,
      projectId: ws.workspace_id,
      provider: "anthropic",
      model: "claude-opus-4-8",
      costCents: 42,
      occurredAt: new Date("2026-06-29T00:00:00.000Z"),
    });
    await db.insert(financeEvents).values({
      companyId: LOCAL_CHAT_COMPANY_ID,
      agentId,
      projectId: ws.workspace_id,
      costEventId: costId,
      eventKind: "llm_usage",
      biller: "anthropic",
      amountCents: 42,
      occurredAt: new Date("2026-06-29T00:00:00.000Z"),
    });

    expect(
      await deleteChatWorkspace(db, ws.workspace_id, { companyId: LOCAL_CHAT_COMPANY_ID }),
    ).toBe(true);

    // Project is gone.
    const inv = await buildChatWorkspaceInventory(db, LOCAL_CHAT_COMPANY_ID);
    expect(inv.workspaces.map((w) => w.workspace_id)).not.toContain(ws.workspace_id);
    // The audit ledgers survive — only their project pointer was nulled.
    const cost = await db
      .select()
      .from(costEvents)
      .where(eq(costEvents.id, costId))
      .then((rows) => rows[0]);
    expect(cost).toBeTruthy();
    expect(cost!.projectId).toBeNull();
    expect(cost!.costCents).toBe(42);
    const finance = await db
      .select()
      .from(financeEvents)
      .where(eq(financeEvents.costEventId, costId))
      .then((rows) => rows[0]);
    expect(finance).toBeTruthy();
    expect(finance!.projectId).toBeNull();
  });

  it("deleteChatWorkspace rejects a foreign or missing workspace", async () => {
    const ws = await createChatWorkspace(db, { name: "Safe" });
    const otherCompany = await seedCompany();
    expect(await deleteChatWorkspace(db, ws.workspace_id, { companyId: otherCompany })).toBe(false);
    expect(
      await deleteChatWorkspace(db, randomUUID(), { companyId: LOCAL_CHAT_COMPANY_ID }),
    ).toBe(false);
    // The rejected workspace still exists.
    const inv = await buildChatWorkspaceInventory(db, LOCAL_CHAT_COMPANY_ID);
    expect(inv.workspaces.map((w) => w.workspace_id)).toContain(ws.workspace_id);
  });

  it("createChatWorkspace attaches a repo and reports trust_source=api (not managed)", async () => {
    const ws = await createChatWorkspace(db, { name: "Repo", attachRepo: "/repo/attached" });
    expect(ws.repo_path).toBe("/repo/attached");
    // A real cwd is not app-owned scratch → `api`, never the `managed` lie.
    expect(ws.trust_source).toBe("api");
    const inv = await buildChatWorkspaceInventory(db, LOCAL_CHAT_COMPANY_ID);
    expect(inv.workspaces.find((w) => w.workspace_id === ws.workspace_id)?.repo_path).toBe(
      "/repo/attached",
    );
  });

  it("createChatWorkspace is atomic: a rejected attach leaves no orphan project", async () => {
    // The repo-only sentinel makes the native createWorkspace return null (no
    // repoUrl), which must be treated as a failure, not a silent folder fallback.
    await expect(
      createChatWorkspace(db, { name: "Orphan?", attachRepo: "/__paperclip_repo_only__" }),
    ).rejects.toThrow();
    // The just-created project was compensated away — no phantom workspace lingers.
    const inv = await buildChatWorkspaceInventory(db, LOCAL_CHAT_COMPANY_ID);
    // Only the built-in Chat home remains — no phantom project lingered.
    expect(inv.count).toBe(1);
    expect(inv.workspaces.every((w) => w.builtin_chat)).toBe(true);
  });

  it("deleteChatWorkspace clears the resume handle of reassigned chats", async () => {
    const ws = await createChatWorkspace(db, { name: "WithResume" });
    const sessionId = await seedIssue(LOCAL_CHAT_COMPANY_ID, "resumable");
    await db.update(issues).set({ projectId: ws.workspace_id }).where(eq(issues.id, sessionId));
    // An agent + its adapter resume handle keyed to this chat (taskKey = issue id).
    const agentId = randomUUID();
    await db
      .insert(agents)
      .values({ id: agentId, companyId: LOCAL_CHAT_COMPANY_ID, name: "chat-agent" });
    await db.insert(agentTaskSessions).values({
      companyId: LOCAL_CHAT_COMPANY_ID,
      agentId,
      adapterType: "claude_local",
      taskKey: sessionId,
    });

    expect(
      await deleteChatWorkspace(db, ws.workspace_id, { companyId: LOCAL_CHAT_COMPANY_ID }),
    ).toBe(true);

    // The reassigned chat survives, but its stale resume handle is gone — the next
    // turn can't resume the old native session in the deleted cwd (mirrors move).
    const remaining = await db
      .select()
      .from(agentTaskSessions)
      .where(eq(agentTaskSessions.taskKey, sessionId));
    expect(remaining).toHaveLength(0);
  });

  it("pins and unpins a workspace, reflected in the inventory", async () => {
    const ws = await createChatWorkspace(db, { name: "Pinnable" });
    let inv = await buildChatWorkspaceInventory(db, LOCAL_CHAT_COMPANY_ID);
    expect(inv.workspaces.find((w) => w.workspace_id === ws.workspace_id)?.pinned).toBe(false);

    await setChatPin(db, LOCAL_CHAT_COMPANY_ID, "workspace", ws.workspace_id, true);
    inv = await buildChatWorkspaceInventory(db, LOCAL_CHAT_COMPANY_ID);
    const pinned = inv.workspaces.find((w) => w.workspace_id === ws.workspace_id);
    expect(pinned?.pinned).toBe(true);
    expect(typeof pinned?.pinned_at).toBe("number");

    await setChatPin(db, LOCAL_CHAT_COMPANY_ID, "workspace", ws.workspace_id, false);
    inv = await buildChatWorkspaceInventory(db, LOCAL_CHAT_COMPANY_ID);
    expect(inv.workspaces.find((w) => w.workspace_id === ws.workspace_id)?.pinned).toBe(false);
  });

  it("deleteChatWorkspace drops the workspace's own pin (no dangling row)", async () => {
    const ws = await createChatWorkspace(db, { name: "PinnedDoomed" });
    await setChatPin(db, LOCAL_CHAT_COMPANY_ID, "workspace", ws.workspace_id, true);
    expect(
      (await readChatPins(db, LOCAL_CHAT_COMPANY_ID, "workspace")).has(ws.workspace_id),
    ).toBe(true);
    await deleteChatWorkspace(db, ws.workspace_id, { companyId: LOCAL_CHAT_COMPANY_ID });
    expect(
      (await readChatPins(db, LOCAL_CHAT_COMPANY_ID, "workspace")).has(ws.workspace_id),
    ).toBe(false);
  });

  it("deleteChatWorkspace stays successful even if pin cleanup throws (best-effort)", async () => {
    const ws = await createChatWorkspace(db, { name: "CleanupFail" });
    const chatPinsModule = await import("../services/chat-pins.ts");
    const spy = vi
      .spyOn(chatPinsModule, "setChatPin")
      .mockRejectedValueOnce(new Error("cleanup boom"));
    try {
      // The delete transaction already committed; a cleanup failure must NOT turn
      // a successful delete into a rejection.
      await expect(
        deleteChatWorkspace(db, ws.workspace_id, { companyId: LOCAL_CHAT_COMPANY_ID }),
      ).resolves.toBe(true);
      expect(spy).toHaveBeenCalledWith(
        db,
        LOCAL_CHAT_COMPANY_ID,
        "workspace",
        ws.workspace_id,
        false,
      );
    } finally {
      spy.mockRestore();
    }
    // The project is genuinely gone despite the cleanup throw.
    const inv = await buildChatWorkspaceInventory(db, LOCAL_CHAT_COMPANY_ID);
    expect(inv.workspaces.map((w) => w.workspace_id)).not.toContain(ws.workspace_id);
  });

  it("keys pins by kind so workspace and session pins never collide", async () => {
    const sharedId = randomUUID();
    await setChatPin(db, LOCAL_CHAT_COMPANY_ID, "session", sharedId, true);
    expect((await readChatPins(db, LOCAL_CHAT_COMPANY_ID, "session")).has(sharedId)).toBe(true);
    // The same id under the workspace kind is independent — not pinned.
    expect((await readChatPins(db, LOCAL_CHAT_COMPANY_ID, "workspace")).has(sharedId)).toBe(false);
  });

  it("re-pinning is idempotent (ON CONFLICT DO NOTHING), not an error", async () => {
    const id = randomUUID();
    await setChatPin(db, LOCAL_CHAT_COMPANY_ID, "workspace", id, true);
    await setChatPin(db, LOCAL_CHAT_COMPANY_ID, "workspace", id, true);
    const pins = await readChatPins(db, LOCAL_CHAT_COMPANY_ID, "workspace");
    expect(pins.has(id)).toBe(true);
    expect(typeof pins.get(id)).toBe("number");
  });

  it("toBackendChatSession surfaces a session's pinned_at when provided", async () => {
    const issueId = randomUUID();
    await setChatPin(db, LOCAL_CHAT_COMPANY_ID, "session", issueId, true);
    const pins = await readChatPins(db, LOCAL_CHAT_COMPANY_ID, "session");
    // toBackendChatSession is a pure projector; a fake issue avoids an FK on a
    // company this test doesn't otherwise need.
    const fakeIssue = {
      id: issueId,
      title: "pinned chat",
      projectId: null,
      hiddenAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const session = toBackendChatSession(fakeIssue as never, [], pins.get(issueId) ?? null);
    expect(session.pinned).toBe(true);
    expect(typeof session.pinned_at).toBe("number");
  });
});
