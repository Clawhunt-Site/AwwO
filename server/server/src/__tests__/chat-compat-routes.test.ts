import express, { type Request } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSvc = vi.hoisted(() => ({
  listChatSessions: vi.fn(),
  getChatSession: vi.fn(),
}));
const mockFindLocalChatCompanyId = vi.hoisted(() => vi.fn());
const mockEnsureLocalChatCompany = vi.hoisted(() => vi.fn());
const mockResolveChatCompanyId = vi.hoisted(() => vi.fn());
const mockEnsureChatAgent = vi.hoisted(() => vi.fn());
const mockCreateChatSession = vi.hoisted(() => vi.fn());
const mockAppendUserTurn = vi.hoisted(() => vi.fn());
const mockAppendChatSystemNote = vi.hoisted(() => vi.fn());
const mockPersistChatTurnRuntime = vi.hoisted(() => vi.fn(async () => {}));
const mockResetChatSessionResume = vi.hoisted(() => vi.fn(async () => {}));
const mockHasChatSessionResume = vi.hoisted(() => vi.fn(async () => false));
const mockAssignChatAgent = vi.hoisted(() => vi.fn(async () => {}));
const mockSetChatArchived = vi.hoisted(() => vi.fn());
const mockMoveChatSession = vi.hoisted(() => vi.fn());
const mockCreateChatWorkspace = vi.hoisted(() => vi.fn());
const mockRenameChatWorkspace = vi.hoisted(() => vi.fn());
const mockDeleteChatWorkspace = vi.hoisted(() => vi.fn());
const mockReadChatPins = vi.hoisted(() => vi.fn(async () => new Map<string, number>()));
const mockSetChatPin = vi.hoisted(() => vi.fn(async () => {}));
const mockChatWorkspaceExists = vi.hoisted(() => vi.fn(async () => true));
const mockBuildChatWorkspaceInventory = vi.hoisted(() => vi.fn());
const mockHasPendingWakeForComment = vi.hoisted(() => vi.fn(async () => false));
const mockHeartbeat = vi.hoisted(() => ({
  wakeup: vi.fn(),
  getRun: vi.fn(),
  getActiveChatRun: vi.fn(async () => null as unknown),
  cancelChatSessionExecution: vi.fn(async () => ({ run: null as unknown, wakeupsCancelled: 0 })),
}));
const mockSubscribe = vi.hoisted(() => vi.fn(() => () => {}));
const mockGetActivePauseHoldGate = vi.hoisted(() => vi.fn(async () => null as unknown));
const mockReleaseChatStopHolds = vi.hoisted(() => vi.fn(async () => 0));
const mockReleaseHold = vi.hoisted(() => vi.fn(async () => ({})));

// Keep the REAL serializer (the wire-shape contract under test); stub only the
// data-access + bootstrap functions so routes run without a database.
vi.mock("../services/chat-compat.js", async (importActual) => {
  const actual = await importActual<typeof import("../services/chat-compat.js")>();
  return {
    ...actual,
    chatCompatService: () => mockSvc,
    findLocalChatCompanyId: mockFindLocalChatCompanyId,
    ensureLocalChatCompany: mockEnsureLocalChatCompany,
    resolveChatCompanyId: mockResolveChatCompanyId,
    ensureChatAgent: mockEnsureChatAgent,
    createChatSession: mockCreateChatSession,
    appendUserTurn: mockAppendUserTurn,
    appendChatSystemNote: mockAppendChatSystemNote,
    persistChatTurnRuntime: mockPersistChatTurnRuntime,
    resetChatSessionResume: mockResetChatSessionResume,
    hasChatSessionResume: mockHasChatSessionResume,
    assignChatAgent: mockAssignChatAgent,
    setChatArchived: mockSetChatArchived,
    moveChatSession: mockMoveChatSession,
    createChatWorkspace: mockCreateChatWorkspace,
    renameChatWorkspace: mockRenameChatWorkspace,
    deleteChatWorkspace: mockDeleteChatWorkspace,
    chatWorkspaceExists: mockChatWorkspaceExists,
    buildChatWorkspaceInventory: mockBuildChatWorkspaceInventory,
    hasPendingWakeForComment: mockHasPendingWakeForComment,
  };
});
vi.mock("../services/chat-pins.js", () => ({
  readChatPins: mockReadChatPins,
  setChatPin: mockSetChatPin,
}));
vi.mock("../services/heartbeat.js", () => ({ heartbeatService: () => mockHeartbeat }));
// The stream route probes/releases the chat-stop pause hold before waking; these
// route tests run without a database, so stub the tree-control service ("no
// active hold" is the steady state — the hold paths have their own db tests).
vi.mock("../services/issue-tree-control.js", async (importActual) => {
  const actual = await importActual<typeof import("../services/issue-tree-control.js")>();
  return {
    ...actual,
    issueTreeControlService: () => ({
      getActivePauseHoldGate: mockGetActivePauseHoldGate,
      releaseChatStopHolds: mockReleaseChatStopHolds,
      releaseHold: mockReleaseHold,
    }),
  };
});
vi.mock("../services/live-events.js", () => ({ subscribeCompanyLiveEvents: mockSubscribe }));
// Registry: `claude_local`/`codex_local` are known+enabled; anything else is
// unknown (getServerAdapter falls back to `process`, like the real registry).
// isBuiltinAdapterActive: the two local conversational types are trusted built-ins
// (so isChatEligibleAdapter passes the provenance check); `process` is not.
vi.mock("../adapters/registry.js", () => {
  const KNOWN = new Set(["claude_local", "codex_local", "process"]);
  return {
    getServerAdapter: (type: string) => ({ type: KNOWN.has(type) ? type : "process" }),
    listEnabledServerAdapters: () => [{ type: "claude_local" }, { type: "codex_local" }],
    isBuiltinAdapterActive: (type: string) =>
      type === "claude_local" || type === "codex_local",
  };
});

const { chatRoutes } = await import("../routes/chat.js");

function fakeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    companyId: "c0000000-0000-0000-0000-000000000000",
    title: "hello chat",
    projectId: null,
    hiddenAt: null,
    createdAt: new Date("2026-04-21T10:00:00.000Z"),
    updatedAt: new Date("2026-04-21T11:00:00.000Z"),
    ...overrides,
  };
}

function fakeComment(overrides: Record<string, unknown> = {}) {
  return {
    id: "22222222-2222-2222-2222-222222222222",
    issueId: "11111111-1111-1111-1111-111111111111",
    body: "hi",
    authorType: "user",
    createdByRunId: null,
    createdAt: new Date("2026-04-21T10:30:00.000Z"),
    ...overrides,
  };
}

function buildApp(deploymentMode: "local_trusted" | "authenticated") {
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
  app.use("/api", chatRoutes({} as never, { deploymentMode }));
  return app;
}

describe("chat-compat read routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refuses chat off local_trusted (single-operator gate)", async () => {
    const res = await request(buildApp("authenticated")).get("/api/chat/sessions");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("DEPLOYMENT_MODE_UNSUPPORTED");
    expect(mockFindLocalChatCompanyId).not.toHaveBeenCalled();
  });

  it("returns an empty list before the local chat company is bootstrapped", async () => {
    mockFindLocalChatCompanyId.mockResolvedValue(null);
    const res = await request(buildApp("local_trusted")).get(
      "/api/chat/sessions?personal_only=true",
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sessions: [] });
    expect(mockSvc.listChatSessions).not.toHaveBeenCalled();
  });

  it("lists sessions in the legacy wire shape and honors include_archived", async () => {
    mockFindLocalChatCompanyId.mockResolvedValue("c0000000-0000-0000-0000-000000000000");
    mockSvc.listChatSessions.mockResolvedValue([
      { issue: fakeIssue(), comments: [fakeComment(), fakeComment({ id: "x", authorType: "agent", body: "yo" })] },
    ]);

    const res = await request(buildApp("local_trusted")).get(
      "/api/chat/sessions?personal_only=true&include_archived=true",
    );

    expect(res.status).toBe(200);
    expect(mockSvc.listChatSessions).toHaveBeenCalledWith(
      "c0000000-0000-0000-0000-000000000000",
      { includeArchived: true },
    );
    const session = res.body.sessions[0];
    expect(session.session_id).toBe("11111111-1111-1111-1111-111111111111");
    expect(session.title).toBe("hello chat");
    expect(typeof session.created_at).toBe("number");
    expect(session.archived).toBe(false);
    expect(session.workspace_id).toBeNull();
    expect(session.messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant"]);
    expect(session).not.toHaveProperty("runtime");
  });

  it("returns 404 for a session detail before the local company exists", async () => {
    mockFindLocalChatCompanyId.mockResolvedValue(null);
    const res = await request(buildApp("local_trusted")).get(
      "/api/chat/sessions/11111111-1111-1111-1111-111111111111",
    );
    expect(res.status).toBe(404);
    expect(mockSvc.getChatSession).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown session detail (scoped to local company)", async () => {
    const unknownId = "88888888-8888-8888-8888-888888888888";
    mockFindLocalChatCompanyId.mockResolvedValue("c0000000-0000-0000-0000-000000000000");
    mockSvc.getChatSession.mockResolvedValue(null);
    const res = await request(buildApp("local_trusted")).get(`/api/chat/sessions/${unknownId}`);
    expect(res.status).toBe(404);
    expect(mockSvc.getChatSession).toHaveBeenCalledWith(unknownId, {
      companyId: "c0000000-0000-0000-0000-000000000000",
    });
  });

  it("returns a single session detail in the legacy wire shape", async () => {
    mockFindLocalChatCompanyId.mockResolvedValue("c0000000-0000-0000-0000-000000000000");
    mockSvc.getChatSession.mockResolvedValue({
      issue: fakeIssue({ hiddenAt: new Date("2026-04-21T12:00:00.000Z") }),
      comments: [fakeComment()],
    });
    const res = await request(buildApp("local_trusted")).get(
      "/api/chat/sessions/11111111-1111-1111-1111-111111111111",
    );
    expect(res.status).toBe(200);
    expect(res.body.session_id).toBe("11111111-1111-1111-1111-111111111111");
    expect(res.body.archived).toBe(true); // hidden → archived
    expect(res.body.messages).toHaveLength(1);
  });
});

describe("chat-compat lifecycle routes (native stop + orphan guards)", () => {
  const COMPANY = "c0000000-0000-0000-0000-000000000000";
  const SESSION = "11111111-1111-1111-1111-111111111111";

  beforeEach(() => {
    vi.clearAllMocks();
    mockFindLocalChatCompanyId.mockResolvedValue(COMPANY);
    mockHeartbeat.getActiveChatRun.mockResolvedValue(null);
    mockHeartbeat.cancelChatSessionExecution.mockResolvedValue({ run: null, wakeupsCancelled: 0 });
  });

  it("refuses stop off local_trusted (single-operator gate)", async () => {
    const res = await request(buildApp("authenticated")).post(`/api/chat/sessions/${SESSION}/cancel`);
    expect(res.status).toBe(403);
    expect(mockHeartbeat.cancelChatSessionExecution).not.toHaveBeenCalled();
  });

  it("stop 404s for an unknown session and never cancels", async () => {
    mockSvc.getChatSession.mockResolvedValue(null);
    const res = await request(buildApp("local_trusted")).post(`/api/chat/sessions/${SESSION}/cancel`);
    expect(res.status).toBe(404);
    expect(mockHeartbeat.cancelChatSessionExecution).not.toHaveBeenCalled();
  });

  it("stop natively cancels the session's run and reports the result", async () => {
    mockSvc.getChatSession.mockResolvedValue({ issue: fakeIssue(), comments: [] });
    mockHeartbeat.cancelChatSessionExecution.mockResolvedValue({
      run: { status: "cancelled" },
      wakeupsCancelled: 2,
    });
    const res = await request(buildApp("local_trusted")).post(`/api/chat/sessions/${SESSION}/cancel`);
    expect(res.status).toBe(200);
    expect(mockHeartbeat.cancelChatSessionExecution).toHaveBeenCalledWith(
      COMPANY,
      SESSION,
      expect.any(String),
    );
    expect(res.body).toMatchObject({ ok: true, cancelled: true, status: "cancelled", wakeups_cancelled: 2 });
  });

  it("stop is a no-op (idle) when the session has no active run", async () => {
    mockSvc.getChatSession.mockResolvedValue({ issue: fakeIssue(), comments: [] });
    const res = await request(buildApp("local_trusted")).post(`/api/chat/sessions/${SESSION}/cancel`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, cancelled: false, status: "idle" });
  });

  it("archive is rejected (409) while the chat is still running", async () => {
    mockHeartbeat.getActiveChatRun.mockResolvedValue({ id: "run1", status: "running" });
    const res = await request(buildApp("local_trusted"))
      .post(`/api/chat/sessions/${SESSION}/archive`)
      .send({ archived: true });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("chat_running");
    expect(mockSetChatArchived).not.toHaveBeenCalled();
  });

  it("archive proceeds when the chat is idle", async () => {
    mockSetChatArchived.mockResolvedValue(true);
    mockSvc.getChatSession.mockResolvedValue({ issue: fakeIssue({ hiddenAt: new Date() }), comments: [] });
    const res = await request(buildApp("local_trusted"))
      .post(`/api/chat/sessions/${SESSION}/archive`)
      .send({ archived: true });
    expect(res.status).toBe(200);
    expect(mockSetChatArchived).toHaveBeenCalled();
  });

  it("un-archiving is allowed even with an active run (guard only blocks archiving)", async () => {
    mockHeartbeat.getActiveChatRun.mockResolvedValue({ id: "run1", status: "running" });
    mockSetChatArchived.mockResolvedValue(true);
    mockSvc.getChatSession.mockResolvedValue({ issue: fakeIssue(), comments: [] });
    const res = await request(buildApp("local_trusted"))
      .post(`/api/chat/sessions/${SESSION}/archive`)
      .send({ archived: false });
    expect(res.status).toBe(200);
    expect(mockSetChatArchived).toHaveBeenCalled();
  });

  it("move is rejected (409) while the chat is still running", async () => {
    mockHeartbeat.getActiveChatRun.mockResolvedValue({ id: "run1", status: "running" });
    const res = await request(buildApp("local_trusted"))
      .post(`/api/chat/sessions/${SESSION}/move`)
      .send({ workspace_id: null });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("chat_running");
    expect(mockMoveChatSession).not.toHaveBeenCalled();
  });

  it("move proceeds when the chat is idle", async () => {
    mockMoveChatSession.mockResolvedValue("ok");
    mockSvc.getChatSession.mockResolvedValue({ issue: fakeIssue(), comments: [] });
    const res = await request(buildApp("local_trusted"))
      .post(`/api/chat/sessions/${SESSION}/move`)
      .send({ workspace_id: null });
    expect(res.status).toBe(200);
    expect(mockMoveChatSession).toHaveBeenCalled();
  });
});

describe("chat-compat stream route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSubscribe.mockReturnValue(() => {});
  });

  it("rejects an empty message with 400", async () => {
    const res = await request(buildApp("local_trusted")).post("/api/chat/stream").send({ message: "  " });
    expect(res.status).toBe(400);
  });

  it("streams a turn: chat.started → message.delta* → message.completed → chat.completed", async () => {
    mockEnsureLocalChatCompany.mockResolvedValue("company1");
    mockEnsureChatAgent.mockResolvedValue("agent1");
    mockCreateChatSession.mockResolvedValue({ id: "issue1" });
    mockAppendUserTurn.mockResolvedValue({ id: "comment1" });
    mockHeartbeat.wakeup.mockResolvedValue({ id: "run1", status: "queued" });
    mockHeartbeat.getRun.mockResolvedValue({ status: "succeeded", resultJson: { summary: "Final answer" } });
    // Drive the run lifecycle through the live-events listener: two deltas, then terminal.
    mockSubscribe.mockImplementation((_companyId: string, listener: (e: unknown) => void) => {
      setImmediate(() => {
        // Default runtime is claude → the projector parses stream-json stdout.
        listener({
          type: "heartbeat.run.log",
          payload: {
            runId: "run1",
            stream: "stdout",
            chunk: `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Hello world" }] } })}\n`,
          },
        });
        listener({ type: "heartbeat.run.status", payload: { runId: "run1", status: "succeeded" } });
      });
      return () => {};
    });

    const res = await request(buildApp("local_trusted")).post("/api/chat/stream").send({ message: "hi" });

    expect(res.status).toBe(200);
    const body = res.text;
    expect(body).toContain("event: chat.started");
    expect(body).toContain('"session_id":"issue1"');
    expect(body).toContain("event: message.delta");
    expect(body).toContain("Hello world");
    expect(body).toContain("event: message.completed");
    expect(body).toContain("event: chat.completed");
    expect(body).toContain('"response":"Final answer"');
    expect(body).toContain('"run_id":null');
    expect(body).toContain('"status":"completed"');
    // A new session was created and the user turn was persisted.
    expect(mockCreateChatSession).toHaveBeenCalled();
    expect(mockHeartbeat.wakeup).toHaveBeenCalledWith("agent1", {
      source: "on_demand",
      payload: { issueId: "issue1", commentId: "comment1" },
    });
    expect(mockAppendUserTurn).toHaveBeenCalledWith(expect.anything(), "issue1", "hi", {
      companyId: "company1",
    });
  });

  it("reuses an existing session when session_id is supplied (no new session)", async () => {
    mockEnsureLocalChatCompany.mockResolvedValue("company1");
    mockEnsureChatAgent.mockResolvedValue("agent1");
    // The reused session must validate as a chat session in this company.
    mockSvc.getChatSession.mockResolvedValue({ issue: fakeIssue(), comments: [] });
    mockAppendUserTurn.mockResolvedValue({ id: "comment2" });
    mockHeartbeat.wakeup.mockResolvedValue({ id: "run2", status: "queued" });
    mockHeartbeat.getRun.mockResolvedValue({ status: "succeeded", resultJson: { result: "ok" } });
    mockSubscribe.mockImplementation((_c: string, listener: (e: unknown) => void) => {
      setImmediate(() =>
        listener({ type: "heartbeat.run.status", payload: { runId: "run2", status: "succeeded" } }),
      );
      return () => {};
    });

    const reuseId = "66666666-6666-6666-6666-666666666666";
    const res = await request(buildApp("local_trusted"))
      .post("/api/chat/stream")
      .send({ message: "again", session_id: reuseId });

    expect(res.status).toBe(200);
    expect(mockCreateChatSession).not.toHaveBeenCalled();
    expect(mockSvc.getChatSession).toHaveBeenCalledWith(reuseId, { companyId: "company1" });
    expect(mockAppendUserTurn).toHaveBeenCalledWith(expect.anything(), reuseId, "again", {
      companyId: "company1",
    });
  });

  it("runs the turn inside an explicit @company (company_id) and not the default chat company", async () => {
    const companyUuid = "99999999-9999-4999-8999-999999999999";
    mockResolveChatCompanyId.mockResolvedValue(companyUuid);
    mockEnsureChatAgent.mockResolvedValue("agent1");
    mockAppendUserTurn.mockResolvedValue({ id: "comment1" });
    mockHeartbeat.wakeup.mockResolvedValue({ id: "run1", status: "queued" });
    mockHeartbeat.getRun.mockResolvedValue({ status: "succeeded", resultJson: { summary: "ok" } });
    mockSubscribe.mockImplementation((_c: string, listener: (e: unknown) => void) => {
      setImmediate(() =>
        listener({ type: "heartbeat.run.status", payload: { runId: "run1", status: "succeeded" } }),
      );
      return () => {};
    });

    const res = await request(buildApp("local_trusted"))
      .post("/api/chat/stream")
      .send({ message: "hi", company_id: companyUuid });

    expect(res.status).toBe(200);
    expect(mockResolveChatCompanyId).toHaveBeenCalledWith(expect.anything(), companyUuid);
    // The default personal-chat company is NOT consulted when an explicit company is given.
    expect(mockEnsureLocalChatCompany).not.toHaveBeenCalled();
    // The turn's agent is ensured inside the explicit company, not the default.
    expect(mockEnsureChatAgent).toHaveBeenCalledWith(expect.anything(), companyUuid, expect.anything());
  });

  it("fail-closed: rejects a non-uuid company_id with 400 before opening the stream", async () => {
    const res = await request(buildApp("local_trusted"))
      .post("/api/chat/stream")
      .send({ message: "hi", company_id: "company_legacy1" });

    expect(res.status).toBe(400);
    // Neither company-resolution path runs for a malformed company_id.
    expect(mockResolveChatCompanyId).not.toHaveBeenCalled();
    expect(mockEnsureLocalChatCompany).not.toHaveBeenCalled();
  });

  it("fail-closed: returns 404 when an explicit company_id does not resolve to a real company", async () => {
    mockResolveChatCompanyId.mockResolvedValue(null);

    const res = await request(buildApp("local_trusted"))
      .post("/api/chat/stream")
      .send({ message: "hi", company_id: "99999999-9999-4999-8999-999999999999" });

    expect(res.status).toBe(404);
    // Never falls back to the default company on an unresolved explicit company.
    expect(mockEnsureLocalChatCompany).not.toHaveBeenCalled();
  });

  it("applies per-turn model + effort as an issue-scoped override (no switch)", async () => {
    mockEnsureLocalChatCompany.mockResolvedValue("company1");
    mockEnsureChatAgent.mockResolvedValue("agent1");
    mockCreateChatSession.mockResolvedValue({ id: "issue1", executionState: null });
    mockAppendUserTurn.mockResolvedValue({ id: "comment1" });
    mockHeartbeat.wakeup.mockResolvedValue({ id: "run1", status: "queued" });
    mockHeartbeat.getRun.mockResolvedValue({ status: "succeeded", resultJson: { summary: "ok" } });
    mockSubscribe.mockImplementation((_c: string, listener: (e: unknown) => void) => {
      setImmediate(() =>
        listener({ type: "heartbeat.run.status", payload: { runId: "run1", status: "succeeded" } }),
      );
      return () => {};
    });

    await request(buildApp("local_trusted"))
      .post("/api/chat/stream")
      .send({ message: "hi", backend: "claude_local", model: "claude-opus-4-8", effort: "high" });

    // claude_local effort key is `effort`; model + effort land in the per-turn
    // adapterConfig override, and the sticky runtime is persisted.
    expect(mockEnsureChatAgent).toHaveBeenCalledWith(expect.anything(), "company1", "claude_local");
    expect(mockPersistChatTurnRuntime).toHaveBeenCalledWith(expect.anything(), "issue1", {
      companyId: "company1",
      executionState: { runtime: { backend: "claude_local", model: "claude-opus-4-8", effort: "high" } },
      assigneeAdapterOverrides: { adapterConfig: { model: "claude-opus-4-8", effort: "high" } },
    });
    expect(mockAppendChatSystemNote).not.toHaveBeenCalled();
    // No switch ⇒ no transcript replay (session resume carries continuity).
    expect(mockHeartbeat.wakeup).toHaveBeenCalledWith("agent1", {
      source: "on_demand",
      payload: { issueId: "issue1", commentId: "comment1" },
    });
  });

  it("on a backend switch: handoff note + drop old model/effort + transcript replay", async () => {
    mockEnsureLocalChatCompany.mockResolvedValue("company1");
    mockEnsureChatAgent.mockResolvedValue("agent-claude");
    // Sticky runtime is codex; this turn requests claude (a switch). Prior turns exist.
    mockSvc.getChatSession.mockResolvedValue({
      issue: fakeIssue({ executionState: { runtime: { backend: "codex_local", model: "gpt-5.5", effort: "high" } } }),
      comments: [fakeComment({ id: "c-old" })],
    });
    mockAppendChatSystemNote.mockResolvedValue({ id: "handoff1" });
    mockHasChatSessionResume.mockResolvedValue(false); // switch reset ⇒ fresh session
    mockAppendUserTurn.mockResolvedValue({ id: "comment-new" });
    mockHeartbeat.wakeup.mockResolvedValue({ id: "run", status: "queued" });
    mockHeartbeat.getRun.mockResolvedValue({ status: "succeeded", resultJson: { summary: "ok" } });
    mockSubscribe.mockImplementation((_c: string, listener: (e: unknown) => void) => {
      setImmediate(() =>
        listener({ type: "heartbeat.run.status", payload: { runId: "run", status: "succeeded" } }),
      );
      return () => {};
    });

    const reuseId = "66666666-6666-6666-6666-666666666666";
    await request(buildApp("local_trusted"))
      .post("/api/chat/stream")
      .send({ message: "switch now", session_id: reuseId, backend: "claude_local" });

    // Switched to claude; the old codex model/effort are NOT carried across.
    expect(mockEnsureChatAgent).toHaveBeenCalledWith(expect.anything(), "company1", "claude_local");
    expect(mockAppendChatSystemNote).toHaveBeenCalledWith(
      expect.anything(),
      reuseId,
      expect.stringContaining("codex_local → claude_local"),
      { companyId: "company1" },
    );
    expect(mockPersistChatTurnRuntime).toHaveBeenCalledWith(expect.anything(), reuseId, {
      companyId: "company1",
      executionState: { runtime: { backend: "claude_local" } },
      assigneeAdapterOverrides: null,
    });
    // The old native session is reset so a switch-back to a prior backend starts clean.
    expect(mockResetChatSessionResume).toHaveBeenCalledWith(expect.anything(), reuseId, {
      companyId: "company1",
    });
    // Replay the WHOLE transcript (prior + handoff + this turn) into the new runtime.
    expect(mockHeartbeat.wakeup).toHaveBeenCalledWith(
      "agent-claude",
      expect.objectContaining({
        contextSnapshot: { wakeCommentIds: ["c-old", "handoff1", "comment-new"] },
      }),
    );
  });

  it("preserves sibling assigneeAdapterOverrides (modelProfile/useProjectWorkspace) when writing this turn's adapterConfig", async () => {
    mockEnsureLocalChatCompany.mockResolvedValue("company1");
    mockEnsureChatAgent.mockResolvedValue("agent1");
    // Existing session already carries a cheap modelProfile + project workspace.
    mockSvc.getChatSession.mockResolvedValue({
      issue: fakeIssue({
        executionState: { runtime: { backend: "claude_local" } },
        assigneeAdapterOverrides: { modelProfile: "cheap", useProjectWorkspace: true },
      }),
      comments: [],
    });
    mockAppendUserTurn.mockResolvedValue({ id: "c1" });
    mockHeartbeat.wakeup.mockResolvedValue({ id: "run", status: "queued" });
    mockHeartbeat.getRun.mockResolvedValue({ status: "succeeded", resultJson: { summary: "ok" } });
    mockSubscribe.mockImplementation((_c: string, listener: (e: unknown) => void) => {
      setImmediate(() =>
        listener({ type: "heartbeat.run.status", payload: { runId: "run", status: "succeeded" } }),
      );
      return () => {};
    });

    const reuseId = "55555555-5555-5555-5555-555555555555";
    await request(buildApp("local_trusted"))
      .post("/api/chat/stream")
      .send({ message: "hi", session_id: reuseId, model: "claude-opus-4-8", effort: "high" });

    // No backend switch ⇒ no reset; sibling fields preserved, only adapterConfig (re)written.
    expect(mockResetChatSessionResume).not.toHaveBeenCalled();
    expect(mockPersistChatTurnRuntime).toHaveBeenCalledWith(expect.anything(), reuseId, {
      companyId: "company1",
      executionState: {
        runtime: { backend: "claude_local", model: "claude-opus-4-8", effort: "high" },
      },
      assigneeAdapterOverrides: {
        modelProfile: "cheap",
        useProjectWorkspace: true,
        adapterConfig: { model: "claude-opus-4-8", effort: "high" },
      },
    });
  });

  it("does NOT replay when a live native session exists (continuity via resume)", async () => {
    mockEnsureLocalChatCompany.mockResolvedValue("company1");
    mockEnsureChatAgent.mockResolvedValue("agent1");
    // Same backend (no switch), prior turns exist, AND a resumable session exists.
    mockSvc.getChatSession.mockResolvedValue({
      issue: fakeIssue({ executionState: { runtime: { backend: "claude_local" } } }),
      comments: [fakeComment({ id: "c-old" })],
    });
    mockHasChatSessionResume.mockResolvedValue(true);
    mockAppendUserTurn.mockResolvedValue({ id: "c-new" });
    mockHeartbeat.wakeup.mockResolvedValue({ id: "run", status: "queued" });
    mockHeartbeat.getRun.mockResolvedValue({ status: "succeeded", resultJson: { summary: "ok" } });
    mockSubscribe.mockImplementation((_c: string, listener: (e: unknown) => void) => {
      setImmediate(() =>
        listener({ type: "heartbeat.run.status", payload: { runId: "run", status: "succeeded" } }),
      );
      return () => {};
    });

    const reuseId = "44444444-4444-4444-4444-444444444444";
    await request(buildApp("local_trusted"))
      .post("/api/chat/stream")
      .send({ message: "again", session_id: reuseId, backend: "claude_local" });

    expect(mockResetChatSessionResume).not.toHaveBeenCalled();
    expect(mockHeartbeat.wakeup).toHaveBeenCalledWith("agent1", {
      source: "on_demand",
      payload: { issueId: reuseId, commentId: "c-new" },
    });
  });

  it("replays the transcript on a fresh session even WITHOUT a switch (recovers a failed prior switch)", async () => {
    mockEnsureLocalChatCompany.mockResolvedValue("company1");
    mockEnsureChatAgent.mockResolvedValue("agent1");
    // No backend change this turn (sticky already claude), but the session is
    // fresh (a prior switch's run never established one) → must replay.
    mockSvc.getChatSession.mockResolvedValue({
      issue: fakeIssue({ executionState: { runtime: { backend: "claude_local" } } }),
      comments: [fakeComment({ id: "c-old" })],
    });
    mockHasChatSessionResume.mockResolvedValue(false);
    mockAppendUserTurn.mockResolvedValue({ id: "c-new" });
    mockHeartbeat.wakeup.mockResolvedValue({ id: "run", status: "queued" });
    mockHeartbeat.getRun.mockResolvedValue({ status: "succeeded", resultJson: { summary: "ok" } });
    mockSubscribe.mockImplementation((_c: string, listener: (e: unknown) => void) => {
      setImmediate(() =>
        listener({ type: "heartbeat.run.status", payload: { runId: "run", status: "succeeded" } }),
      );
      return () => {};
    });

    const reuseId = "33333333-3333-3333-3333-333333333333";
    await request(buildApp("local_trusted"))
      .post("/api/chat/stream")
      .send({ message: "again", session_id: reuseId, backend: "claude_local" });

    expect(mockResetChatSessionResume).not.toHaveBeenCalled(); // not a switch
    expect(mockHeartbeat.wakeup).toHaveBeenCalledWith(
      "agent1",
      expect.objectContaining({ contextSnapshot: { wakeCommentIds: ["c-old", "c-new"] } }),
    );
  });

  it("fail-closed: refuses an UNKNOWN backend WITHOUT creating a phantom session", async () => {
    mockEnsureLocalChatCompany.mockResolvedValue("company1");

    const res = await request(buildApp("local_trusted"))
      .post("/api/chat/stream")
      .send({ message: "hi", backend: "nope" });

    expect(res.status).toBe(200);
    expect(res.text).toContain('"failure_reason":"unknown_or_disabled_backend"');
    expect(res.text).toContain('"status":"failed"');
    // The failure event carries NO session_id (no issue was created) so the
    // surface never migrates to / persists a phantom session.
    expect(res.text).toContain('"session_id":null');
    // Nothing persistent happens for a bad backend on a NEW chat.
    expect(mockCreateChatSession).not.toHaveBeenCalled();
    expect(mockEnsureChatAgent).not.toHaveBeenCalled();
    expect(mockPersistChatTurnRuntime).not.toHaveBeenCalled();
    expect(mockAppendUserTurn).not.toHaveBeenCalled();
    expect(mockHeartbeat.wakeup).not.toHaveBeenCalled();
  });

  it("fail-closed: refuses a registered-but-DISABLED backend without creating a session", async () => {
    mockEnsureLocalChatCompany.mockResolvedValue("company1");

    // `process` is a known adapter but NOT in the enabled list.
    const res = await request(buildApp("local_trusted"))
      .post("/api/chat/stream")
      .send({ message: "hi", backend: "process" });

    expect(res.status).toBe(200);
    expect(res.text).toContain('"failure_reason":"unknown_or_disabled_backend"');
    expect(mockCreateChatSession).not.toHaveBeenCalled();
    expect(mockEnsureChatAgent).not.toHaveBeenCalled();
    expect(mockHeartbeat.wakeup).not.toHaveBeenCalled();
  });

  it("rejects a reused session that is not a chat session in this company", async () => {
    mockEnsureLocalChatCompany.mockResolvedValue("company1");
    mockEnsureChatAgent.mockResolvedValue("agent1");
    mockSvc.getChatSession.mockResolvedValue(null);

    const res = await request(buildApp("local_trusted"))
      .post("/api/chat/stream")
      .send({ message: "hi", session_id: "77777777-7777-7777-7777-777777777777" });

    expect(res.status).toBe(200);
    expect(res.text).toContain('"failure_reason":"session_not_found"');
    expect(mockAppendUserTurn).not.toHaveBeenCalled();
    expect(mockHeartbeat.wakeup).not.toHaveBeenCalled();
  });

  it("emits a failed chat.completed when wakeup is a genuine skip (no pending wake recorded)", async () => {
    mockEnsureLocalChatCompany.mockResolvedValue("company1");
    mockEnsureChatAgent.mockResolvedValue("agent1");
    mockCreateChatSession.mockResolvedValue({ id: "issue1" });
    mockAppendUserTurn.mockResolvedValue({ id: "comment1" });
    mockHeartbeat.wakeup.mockResolvedValue(null);
    // A true skip records no pending wake → the prompt really was dropped.
    mockHasPendingWakeForComment.mockResolvedValue(false);

    const res = await request(buildApp("local_trusted")).post("/api/chat/stream").send({ message: "hi" });
    expect(res.status).toBe(200);
    expect(res.text).toContain("event: chat.completed");
    expect(res.text).toContain('"failure_reason":"wakeup_skipped"');
    expect(res.text).toContain('"status":"failed"');
  });

  it("emits a QUEUED chat.completed when wakeup is durably deferred behind an in-flight run", async () => {
    mockEnsureLocalChatCompany.mockResolvedValue("company1");
    mockEnsureChatAgent.mockResolvedValue("agent1");
    mockCreateChatSession.mockResolvedValue({ id: "issue1" });
    mockAppendUserTurn.mockResolvedValue({ id: "comment1" });
    // Same-chat concurrency: heartbeat returns null but enqueues a deferred wake
    // that the in-flight run promotes on completion — the prompt is NOT lost.
    mockHeartbeat.wakeup.mockResolvedValue(null);
    // mockResolvedValueOnce so the deferred override cannot leak into later
    // stream tests (the default hoisted impl returns false).
    mockHasPendingWakeForComment.mockResolvedValueOnce(true);

    const res = await request(buildApp("local_trusted")).post("/api/chat/stream").send({ message: "hi" });
    expect(res.status).toBe(200);
    expect(res.text).toContain("event: chat.completed");
    expect(res.text).toContain('"failure_reason":"wakeup_deferred"');
    expect(res.text).toContain('"status":"queued"');
  });

  it("files a NEW session into its pinned workspace (valid uuid → atomic create with projectId)", async () => {
    mockEnsureLocalChatCompany.mockResolvedValue("company1");
    mockEnsureChatAgent.mockResolvedValue("agent1");
    mockCreateChatSession.mockResolvedValue({ id: "issue1" });
    mockAppendUserTurn.mockResolvedValue({ id: "comment1" });
    mockChatWorkspaceExists.mockResolvedValue(true);
    mockHeartbeat.wakeup.mockResolvedValue({ id: "run1", status: "queued" });
    mockHeartbeat.getRun.mockResolvedValue({ status: "succeeded", resultJson: { summary: "ok" } });
    mockSubscribe.mockImplementation((_c: string, listener: (e: unknown) => void) => {
      setImmediate(() =>
        listener({ type: "heartbeat.run.status", payload: { runId: "run1", status: "succeeded" } }),
      );
      return () => {};
    });

    const wsId = "88888888-8888-8888-8888-888888888888";
    const res = await request(buildApp("local_trusted"))
      .post("/api/chat/stream")
      .send({ message: "hi", workspace_id: wsId });

    expect(res.status).toBe(200);
    expect(res.text).toContain('"status":"completed"');
    // Existence is pre-checked BEFORE the issue is created, then the session is
    // filed into the project ATOMICALLY by passing projectId into the native
    // create (which resolves the project's PRIMARY workspace) — never a post-hoc
    // move that could half-apply or run in the wrong cwd on failure.
    expect(mockChatWorkspaceExists).toHaveBeenCalledWith(expect.anything(), wsId, {
      companyId: "company1",
    });
    expect(mockCreateChatSession).toHaveBeenCalledWith(expect.anything(), "company1", {
      title: "hi",
      projectId: wsId,
    });
    expect(mockMoveChatSession).not.toHaveBeenCalled();
  });

  it("rejects a typed (non-string) workspace_id with 400 (never silently no-pin)", async () => {
    mockEnsureLocalChatCompany.mockResolvedValue("company1");

    // A number (or object) pin is malformed — reject rather than coerce to "no
    // pin" and run in the dev server's cwd.
    const res = await request(buildApp("local_trusted"))
      .post("/api/chat/stream")
      .send({ message: "hi", workspace_id: 12345 });

    expect(res.status).toBe(400);
    expect(mockChatWorkspaceExists).not.toHaveBeenCalled();
    expect(mockCreateChatSession).not.toHaveBeenCalled();
    expect(mockHeartbeat.wakeup).not.toHaveBeenCalled();
  });

  it("fail-closed: refuses a NEW chat pinned to an UNKNOWN workspace, creating nothing", async () => {
    mockEnsureLocalChatCompany.mockResolvedValue("company1");
    mockEnsureChatAgent.mockResolvedValue("agent1");
    mockChatWorkspaceExists.mockResolvedValue(false);

    const wsId = "99999999-9999-9999-9999-999999999999";
    const res = await request(buildApp("local_trusted"))
      .post("/api/chat/stream")
      .send({ message: "hi", workspace_id: wsId });

    expect(res.status).toBe(200);
    expect(res.text).toContain('"failure_reason":"unknown_workspace"');
    // No issue is created for a bad pin (no orphan empty session); the failure
    // carries session_id:null so the surface never persists a phantom session.
    expect(res.text).toContain('"session_id":null');
    expect(mockCreateChatSession).not.toHaveBeenCalled();
    expect(mockMoveChatSession).not.toHaveBeenCalled();
    expect(mockHeartbeat.wakeup).not.toHaveBeenCalled();
  });

  it("rejects a malformed workspace_id with 400 before streaming", async () => {
    mockEnsureLocalChatCompany.mockResolvedValue("company1");

    const res = await request(buildApp("local_trusted"))
      .post("/api/chat/stream")
      .send({ message: "hi", workspace_id: "not-a-uuid" });

    // Rejected at body parse (before the SSE head opens), so it's a plain 400 —
    // never silently dropped into the dev server's cwd.
    expect(res.status).toBe(400);
    expect(mockChatWorkspaceExists).not.toHaveBeenCalled();
    expect(mockCreateChatSession).not.toHaveBeenCalled();
  });

  it("ignores workspace_id for an EXISTING session (binding stays; no silent re-file)", async () => {
    mockEnsureLocalChatCompany.mockResolvedValue("company1");
    mockEnsureChatAgent.mockResolvedValue("agent1");
    mockSvc.getChatSession.mockResolvedValue({ issue: fakeIssue(), comments: [] });
    mockAppendUserTurn.mockResolvedValue({ id: "comment2" });
    mockHeartbeat.wakeup.mockResolvedValue({ id: "run2", status: "queued" });
    mockHeartbeat.getRun.mockResolvedValue({ status: "succeeded", resultJson: { result: "ok" } });
    mockSubscribe.mockImplementation((_c: string, listener: (e: unknown) => void) => {
      setImmediate(() =>
        listener({ type: "heartbeat.run.status", payload: { runId: "run2", status: "succeeded" } }),
      );
      return () => {};
    });

    const reuseId = "66666666-6666-6666-6666-666666666666";
    const wsId = "88888888-8888-8888-8888-888888888888";
    const res = await request(buildApp("local_trusted"))
      .post("/api/chat/stream")
      .send({ message: "again", session_id: reuseId, workspace_id: wsId });

    expect(res.status).toBe(200);
    // The field is a first-turn affordance; an existing session's binding lives
    // on the session, and re-homing is the dedicated move endpoint's job (with
    // its boundary-change ack) — the stream never silently re-files.
    expect(mockChatWorkspaceExists).not.toHaveBeenCalled();
    expect(mockMoveChatSession).not.toHaveBeenCalled();
    expect(mockCreateChatSession).not.toHaveBeenCalled();
  });
});

describe("chat-compat management routes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("archives a session and returns the updated legacy shape", async () => {
    mockFindLocalChatCompanyId.mockResolvedValue("company1");
    mockSetChatArchived.mockResolvedValue(true);
    mockSvc.getChatSession.mockResolvedValue({
      issue: fakeIssue({ hiddenAt: new Date("2026-04-21T12:00:00.000Z") }),
      comments: [],
    });
    const res = await request(buildApp("local_trusted"))
      .post("/api/chat/sessions/11111111-1111-1111-1111-111111111111/archive")
      .send({ archived: true });
    expect(res.status).toBe(200);
    expect(res.body.archived).toBe(true);
    expect(mockSetChatArchived).toHaveBeenCalledWith(expect.anything(), expect.any(String), true, {
      companyId: "company1",
    });
  });

  it("returns 404 archiving an unknown/non-chat session", async () => {
    mockFindLocalChatCompanyId.mockResolvedValue("company1");
    mockSetChatArchived.mockResolvedValue(false);
    const res = await request(buildApp("local_trusted"))
      .post("/api/chat/sessions/55555555-5555-5555-5555-555555555555/archive")
      .send({ archived: true });
    expect(res.status).toBe(404);
    expect(mockSetChatArchived).toHaveBeenCalled();
  });

  it("rejects a non-uuid :id with 404 before any db work", async () => {
    mockFindLocalChatCompanyId.mockResolvedValue("company1");
    const res = await request(buildApp("local_trusted"))
      .post("/api/chat/sessions/nope/archive")
      .send({});
    expect(res.status).toBe(404);
    expect(mockSetChatArchived).not.toHaveBeenCalled();
  });

  it("rejects a typed (non-string) workspace_id with 422", async () => {
    mockFindLocalChatCompanyId.mockResolvedValue("company1");
    const res = await request(buildApp("local_trusted"))
      .post("/api/chat/sessions/11111111-1111-1111-1111-111111111111/move")
      .send({ workspace_id: 12345 });
    expect(res.status).toBe(422);
    expect(mockMoveChatSession).not.toHaveBeenCalled();
  });

  it("moves a session to a workspace and returns the updated session", async () => {
    mockFindLocalChatCompanyId.mockResolvedValue("company1");
    mockMoveChatSession.mockResolvedValue("ok");
    mockSvc.getChatSession.mockResolvedValue({ issue: fakeIssue({ projectId: "33333333-3333-3333-3333-333333333333" }), comments: [] });
    const res = await request(buildApp("local_trusted"))
      .post("/api/chat/sessions/11111111-1111-1111-1111-111111111111/move")
      .send({ workspace_id: "33333333-3333-3333-3333-333333333333" });
    expect(res.status).toBe(200);
    expect(res.body.workspace_id).toBe("33333333-3333-3333-3333-333333333333");
  });

  it("rejects a malformed workspace_id with 422 before touching the db", async () => {
    mockFindLocalChatCompanyId.mockResolvedValue("company1");
    const res = await request(buildApp("local_trusted"))
      .post("/api/chat/sessions/11111111-1111-1111-1111-111111111111/move")
      .send({ workspace_id: "not-a-uuid" });
    expect(res.status).toBe(422);
    expect(mockMoveChatSession).not.toHaveBeenCalled();
  });

  it("returns 404 moving to an unknown workspace", async () => {
    mockFindLocalChatCompanyId.mockResolvedValue("company1");
    mockMoveChatSession.mockResolvedValue("unknown_workspace");
    const res = await request(buildApp("local_trusted"))
      .post("/api/chat/sessions/11111111-1111-1111-1111-111111111111/move")
      .send({ workspace_id: "44444444-4444-4444-4444-444444444444" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("unknown workspace");
  });

  it("ungroups a session when workspace_id is null", async () => {
    mockFindLocalChatCompanyId.mockResolvedValue("company1");
    mockMoveChatSession.mockResolvedValue("ok");
    mockSvc.getChatSession.mockResolvedValue({ issue: fakeIssue(), comments: [] });
    const res = await request(buildApp("local_trusted"))
      .post("/api/chat/sessions/11111111-1111-1111-1111-111111111111/move")
      .send({ workspace_id: null });
    expect(res.status).toBe(200);
    expect(mockMoveChatSession).toHaveBeenCalledWith(expect.anything(), expect.any(String), null, {
      companyId: "company1",
    });
  });
});

describe("chat-compat sidebar routes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("/api/workspaces returns the projected inventory", async () => {
    mockFindLocalChatCompanyId.mockResolvedValue("company1");
    mockBuildChatWorkspaceInventory.mockResolvedValue({
      count: 1,
      workspaces: [{ workspace_id: "w1", name: "Alpha", kind: "project", is_trusted: true, session_count: 2 }],
      unassigned_session_count: 3,
    });
    const res = await request(buildApp("local_trusted")).get("/api/workspaces");
    expect(res.status).toBe(200);
    expect(res.body.workspaces[0].workspace_id).toBe("w1");
    expect(res.body.unassigned_session_count).toBe(3);
  });

  it("/api/workspaces serves the built-in Chat home before the local company exists", async () => {
    mockFindLocalChatCompanyId.mockResolvedValue(null);
    const res = await request(buildApp("local_trusted")).get("/api/workspaces");
    expect(res.status).toBe(200);
    // Persistent Projects/Chats split even on a brand-new instance: the built-in
    // Chat home is served WITHOUT bootstrapping the company or hitting the DB.
    expect(res.body.count).toBe(1);
    expect(res.body.workspaces).toHaveLength(1);
    expect(res.body.workspaces[0].builtin_chat).toBe(true);
    expect(res.body.unassigned_session_count).toBe(0);
    expect(mockBuildChatWorkspaceInventory).not.toHaveBeenCalled();
  });

  it("/api/runs is an empty list (chat is run-cockpit-free)", async () => {
    const res = await request(buildApp("local_trusted")).get("/api/runs");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ runs: [] });
  });

  it("refuses /api/workspaces off local_trusted", async () => {
    const res = await request(buildApp("authenticated")).get("/api/workspaces");
    expect(res.status).toBe(403);
  });

  it("POST /api/workspaces creates a workspace and returns the projection", async () => {
    mockCreateChatWorkspace.mockResolvedValue({ workspace_id: "w9", name: "Beta", kind: "project" });
    const res = await request(buildApp("local_trusted"))
      .post("/api/workspaces")
      .send({ name: "Beta", attach_repo: null, trust_confirmed: false });
    expect(res.status).toBe(201);
    expect(res.body.workspace_id).toBe("w9");
    expect(mockCreateChatWorkspace).toHaveBeenCalledWith({} as never, {
      name: "Beta",
      attachRepo: null,
    });
  });

  it("POST /api/workspaces passes a non-empty attach_repo through to the service", async () => {
    mockCreateChatWorkspace.mockResolvedValue({ workspace_id: "w9", name: "Beta" });
    await request(buildApp("local_trusted"))
      .post("/api/workspaces")
      .send({ name: "Beta", attach_repo: "  /repo/beta  " });
    expect(mockCreateChatWorkspace).toHaveBeenCalledWith({} as never, {
      name: "Beta",
      attachRepo: "/repo/beta",
    });
  });

  it("POST /api/workspaces 422s a blank name without touching the service", async () => {
    const res = await request(buildApp("local_trusted"))
      .post("/api/workspaces")
      .send({ name: "   " });
    expect(res.status).toBe(422);
    expect(mockCreateChatWorkspace).not.toHaveBeenCalled();
  });

  it("POST /api/workspaces surfaces a creation failure as 422 with detail", async () => {
    mockCreateChatWorkspace.mockRejectedValue(new Error("bad repo"));
    const res = await request(buildApp("local_trusted"))
      .post("/api/workspaces")
      .send({ name: "X" });
    expect(res.status).toBe(422);
    expect(res.body.detail).toBe("bad repo");
  });

  it("PATCH /api/workspaces/:id renames within the local company", async () => {
    mockFindLocalChatCompanyId.mockResolvedValue("c1");
    mockRenameChatWorkspace.mockResolvedValue(true);
    const res = await request(buildApp("local_trusted"))
      .patch("/api/workspaces/11111111-1111-1111-1111-111111111111")
      .send({ name: "Renamed" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockRenameChatWorkspace).toHaveBeenCalledWith(
      {} as never,
      "11111111-1111-1111-1111-111111111111",
      "Renamed",
      { companyId: "c1" },
    );
  });

  it("PATCH /api/workspaces/:id 404s a non-uuid id and a missing project", async () => {
    const bad = await request(buildApp("local_trusted"))
      .patch("/api/workspaces/not-a-uuid")
      .send({ name: "x" });
    expect(bad.status).toBe(404);
    expect(mockRenameChatWorkspace).not.toHaveBeenCalled();
    mockFindLocalChatCompanyId.mockResolvedValue("c1");
    mockRenameChatWorkspace.mockResolvedValue(false);
    const missing = await request(buildApp("local_trusted"))
      .patch("/api/workspaces/11111111-1111-1111-1111-111111111111")
      .send({ name: "x" });
    expect(missing.status).toBe(404);
  });

  it("DELETE /api/workspaces/:id deletes via the service", async () => {
    mockFindLocalChatCompanyId.mockResolvedValue("c1");
    mockDeleteChatWorkspace.mockResolvedValue(true);
    const res = await request(buildApp("local_trusted")).delete(
      "/api/workspaces/11111111-1111-1111-1111-111111111111",
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockDeleteChatWorkspace).toHaveBeenCalledWith(
      {} as never,
      "11111111-1111-1111-1111-111111111111",
      { companyId: "c1" },
    );
  });

  it("DELETE /api/workspaces/:id 409s when a RESTRICT child blocks the delete", async () => {
    mockFindLocalChatCompanyId.mockResolvedValue("c1");
    mockDeleteChatWorkspace.mockRejectedValue(new Error("fk violation"));
    const res = await request(buildApp("local_trusted")).delete(
      "/api/workspaces/11111111-1111-1111-1111-111111111111",
    );
    expect(res.status).toBe(409);
    expect(res.body.detail).toBe("fk violation");
  });

  it("workspace mutations are refused off local_trusted", async () => {
    const res = await request(buildApp("authenticated"))
      .post("/api/workspaces")
      .send({ name: "X" });
    expect(res.status).toBe(403);
  });

  it("POST /api/workspaces/:id/pin records the pin", async () => {
    mockFindLocalChatCompanyId.mockResolvedValue("c1");
    const res = await request(buildApp("local_trusted"))
      .post("/api/workspaces/11111111-1111-1111-1111-111111111111/pin")
      .send({ pinned: true });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockSetChatPin).toHaveBeenCalledWith(
      {} as never,
      "c1",
      "workspace",
      "11111111-1111-1111-1111-111111111111",
      true,
    );
  });

  it("POST /api/workspaces/:id/pin with pinned:false unpins", async () => {
    mockFindLocalChatCompanyId.mockResolvedValue("c1");
    await request(buildApp("local_trusted"))
      .post("/api/workspaces/11111111-1111-1111-1111-111111111111/pin")
      .send({ pinned: false });
    expect(mockSetChatPin).toHaveBeenCalledWith(
      {} as never,
      "c1",
      "workspace",
      "11111111-1111-1111-1111-111111111111",
      false,
    );
  });

  it("POST /api/chat/sessions/:id/pin records the session pin", async () => {
    mockFindLocalChatCompanyId.mockResolvedValue("c1");
    const res = await request(buildApp("local_trusted"))
      .post("/api/chat/sessions/22222222-2222-2222-2222-222222222222/pin")
      .send({ pinned: true });
    expect(res.status).toBe(200);
    expect(mockSetChatPin).toHaveBeenCalledWith(
      {} as never,
      "c1",
      "session",
      "22222222-2222-2222-2222-222222222222",
      true,
    );
  });

  it("pin routes 404 a non-uuid id without touching storage", async () => {
    const ws = await request(buildApp("local_trusted"))
      .post("/api/workspaces/not-a-uuid/pin")
      .send({ pinned: true });
    expect(ws.status).toBe(404);
    const sess = await request(buildApp("local_trusted"))
      .post("/api/chat/sessions/not-a-uuid/pin")
      .send({ pinned: true });
    expect(sess.status).toBe(404);
    expect(mockSetChatPin).not.toHaveBeenCalled();
  });

  it("the session list projects pinned_at from chat_sidebar_pins", async () => {
    mockFindLocalChatCompanyId.mockResolvedValue("c1");
    mockSvc.listChatSessions.mockResolvedValue([{ issue: fakeIssue(), comments: [] }]);
    mockReadChatPins.mockResolvedValue(new Map([["11111111-1111-1111-1111-111111111111", 1782440000]]));
    const res = await request(buildApp("local_trusted")).get("/api/chat/sessions");
    expect(res.status).toBe(200);
    expect(res.body.sessions[0].pinned).toBe(true);
    expect(res.body.sessions[0].pinned_at).toBe(1782440000);
  });
});
