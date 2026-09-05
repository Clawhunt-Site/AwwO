import { Router, type Response } from "express";
import type { Db } from "@paperclipai/db";
import type { DeploymentMode } from "@paperclipai/shared";
import {
  appendChatSystemNote,
  appendUserTurn,
  assignChatAgent,
  buildChatWorkspaceInventory,
  builtinOnlyChatWorkspaceInventory,
  chatCompatService,
  chatWorkspaceExists,
  createChatSession,
  createChatWorkspace,
  deleteChatWorkspace,
  ensureChatAgent,
  isChatEligibleAdapter,
  ensureLocalChatCompany,
  resolveChatCompanyId,
  findLocalChatCompanyId,
  hasPendingWakeForComment,
  renameChatWorkspace,
  hasChatSessionResume,
  moveChatSession,
  persistChatTurnRuntime,
  resetChatSessionResume,
  setChatArchived,
  toBackendChatSession,
} from "../services/chat-compat.js";
import { readChatPins, setChatPin } from "../services/chat-pins.js";
import { applyChatRuntime, resolveChatRuntime } from "../services/chat-runtime-selection.js";
import { applyEffortToAdapterConfig } from "../services/adapter-effort.js";
import { getServerAdapter, listEnabledServerAdapters } from "../adapters/registry.js";
import {
  chatDisplayFormatForAdapter,
  createChatDisplayProjector,
  type ChatDisplayProjector,
} from "../services/chat-display-projector.js";
import { heartbeatService } from "../services/heartbeat.js";
import { CHAT_STOP_HOLD_REASON, issueTreeControlService } from "../services/issue-tree-control.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { assertBoardOrgAccess, assertCompanyAccess } from "./authz.js";

/** Default runtime when the request doesn't pick one (inventory slice wires real selection). */
const DEFAULT_CHAT_ADAPTER = "claude_local";
/** Hard ceiling on a single chat turn, mirroring the legacy budget_seconds. */
const DEFAULT_TURN_BUDGET_SECONDS = 120;
const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled", "timed_out"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function deriveTitle(message: string): string {
  const firstLine = message.split("\n", 1)[0].trim();
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine || "New chat";
}

function extractFinalText(run: { resultJson?: unknown } | null): string | null {
  const result = run?.resultJson;
  if (result && typeof result === "object") {
    for (const key of ["summary", "result", "message"]) {
      const value = (result as Record<string, unknown>)[key];
      if (typeof value === "string" && value.trim().length > 0) return value;
    }
  }
  return null;
}

/**
 * The explicitly-requested backend for this turn, or undefined if none (so the
 * session's sticky runtime / the default governs). Mirrors the CLI shell's
 * backend/backend_policy/runtime_id precedence.
 */
function requestedBackendOf(body: Record<string, unknown> | undefined): string | undefined {
  for (const key of ["backend", "backend_policy", "runtime_id"]) {
    const value = body?.[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/**
 * contextSnapshot key heartbeat reads to inline a transcript into the wake
 * context (mirrors heartbeat's WAKE_COMMENT_IDS_KEY). Used to replay prior turns
 * into a freshly-switched runtime that cannot resume the old native session.
 */
const WAKE_COMMENT_IDS_KEY = "wakeCommentIds";

/**
 * SuperClaw continuous-chat surface on the Node backend — legacy `/api/chat/*`
 * paths backed by the native issue + issue-comment + heartbeat model.
 *
 * Read face: list/detail. Streaming face: POST /chat/stream stores the user turn
 * as an issue comment, assigns + wakes the chat agent on that issue (heartbeat
 * kicks an async run), and bridges the run's live events into the legacy chat
 * SSE (`chat.started` / `message.delta` / `message.completed` / `chat.completed`).
 * Pure chat reports `run_id: null` and never emits a `delivery` event, keeping
 * the legacy chat semantics (no run cockpit). Gated to `local_trusted`.
 */
export function chatRoutes(
  db: Db,
  opts: { deploymentMode: DeploymentMode; pluginWorkerManager?: PluginWorkerManager },
) {
  const router = Router();
  const svc = chatCompatService(db);
  const heartbeat = heartbeatService(db, { pluginWorkerManager: opts.pluginWorkerManager });
  const treeControlSvc = issueTreeControlService(db);

  // A user's Stop parks the chat-backed issue under a chat-stop pause hold so
  // the periodic stranded-issue recovery cannot revive it (see
  // cancelChatSessionExecution). The user's next turn on the SAME session is
  // the resume signal: release that hold before waking, or the wake would be
  // skipped and the turn dropped. Only chat-stop holds rooted at this issue are
  // touched — a deliberate tree-control pause (other reason / ancestor root)
  // keeps gating. Racing releases tolerate conflict: the wake-side gate re-reads.
  async function releaseChatStopHold(companyId: string, issueId: string) {
    // Only unpark when the EFFECTIVE gate is the chat-stop hold. If a manual or
    // ancestor pause hold shadows it, leave the park in place: the wake below
    // would be skipped by that hold anyway, and consuming the park while the
    // turn is dropped would let stranded recovery revive the chat the moment
    // the other hold is released.
    const gate = await treeControlSvc.getActivePauseHoldGate(companyId, issueId);
    if (!gate || gate.reason !== CHAT_STOP_HOLD_REASON || gate.rootIssueId !== issueId) return;
    // Release EVERY chat-stop hold on this issue, not just the gate's newest —
    // a stale duplicate left active would skip this turn's wake.
    await treeControlSvc.releaseChatStopHolds(companyId, issueId, {
      reason: "Released by new user chat turn",
      actor: { actorType: "user", actorId: "chat" },
    });
  }

  router.use(["/chat", "/workspaces", "/runs"], (_req, res, next) => {
    if (opts.deploymentMode !== "local_trusted") {
      res.status(403).json({
        error: "Chat is only available on local single-operator instances",
        code: "DEPLOYMENT_MODE_UNSUPPORTED",
      });
      return;
    }
    next();
  });

  // Sidebar workspace inventory (projects → WorkspaceInfo). Empty until a chat
  // is moved into a project; ungrouped chats are the "unassigned" count.
  router.get("/workspaces", async (req, res) => {
    assertBoardOrgAccess(req);
    const companyId = await findLocalChatCompanyId(db);
    if (!companyId) {
      // Local chat company not bootstrapped yet (no chat created) — still serve
      // the built-in Chat home so the sidebar's Projects/Chats split is present
      // on a brand-new instance, not the legacy flat list.
      res.json(builtinOnlyChatWorkspaceInventory());
      return;
    }
    res.json(await buildChatWorkspaceInventory(db, companyId));
  });

  // Create a chat workspace (= a Paperclip project) from the sidebar. Adapts the
  // frontend's {name, attach_repo, trust_confirmed} request to native project
  // CRUD; a local-folder create carries no SuperClaw trust gate (owner
  // calibration: hard gates are reserved for payment + outbound scanning).
  router.post("/workspaces", async (req, res) => {
    assertBoardOrgAccess(req);
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    if (!name) {
      res.status(422).json({ error: "name is required", detail: "Workspace name is required." });
      return;
    }
    const rawAttach = req.body?.attach_repo;
    const attachRepo =
      typeof rawAttach === "string" && rawAttach.trim().length > 0 ? rawAttach.trim() : null;
    try {
      const workspace = await createChatWorkspace(db, { name, attachRepo });
      res.status(201).json(workspace);
    } catch (err) {
      const detail = err instanceof Error ? err.message : "Could not create workspace.";
      res.status(422).json({ error: "Could not create workspace", detail });
    }
  });

  // Rename a chat workspace (native project update), scoped to the local company.
  router.patch("/workspaces/:id", async (req, res) => {
    assertBoardOrgAccess(req);
    const id = req.params.id as string;
    if (!UUID_RE.test(id)) {
      res.status(404).json({ error: "Workspace not found" });
      return;
    }
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    if (!name) {
      res.status(422).json({ error: "name is required", detail: "Workspace name is required." });
      return;
    }
    const companyId = await findLocalChatCompanyId(db);
    if (!companyId || !(await renameChatWorkspace(db, id, name, { companyId }))) {
      res.status(404).json({ error: "Workspace not found" });
      return;
    }
    res.json({ ok: true });
  });

  // Delete a chat workspace WITHOUT losing chats — its sessions reassign to the
  // flat "Chat" list, then the project is hard-deleted in one transaction.
  router.delete("/workspaces/:id", async (req, res) => {
    assertBoardOrgAccess(req);
    const id = req.params.id as string;
    if (!UUID_RE.test(id)) {
      res.status(404).json({ error: "Workspace not found" });
      return;
    }
    const companyId = await findLocalChatCompanyId(db);
    if (!companyId) {
      res.status(404).json({ error: "Workspace not found" });
      return;
    }
    try {
      if (!(await deleteChatWorkspace(db, id, { companyId }))) {
        res.status(404).json({ error: "Workspace not found" });
        return;
      }
    } catch (err) {
      // A RESTRICT child (e.g. a financial ledger row) still references the
      // project; the transaction rolled back, so nothing was detached. Surface a
      // clean 409 instead of a 500.
      const detail = err instanceof Error ? err.message : "Workspace could not be deleted.";
      res.status(409).json({ error: "Workspace could not be deleted", detail });
      return;
    }
    res.json({ ok: true });
  });

  // Pin / unpin a workspace into the sidebar's "Pinned" zone (cross-surface
  // preference stored in chat_sidebar_pins).
  router.post("/workspaces/:id/pin", async (req, res) => {
    assertBoardOrgAccess(req);
    const id = req.params.id as string;
    if (!UUID_RE.test(id)) {
      res.status(404).json({ error: "Workspace not found" });
      return;
    }
    const companyId = await findLocalChatCompanyId(db);
    if (!companyId) {
      res.status(404).json({ error: "Workspace not found" });
      return;
    }
    await setChatPin(db, companyId, "workspace", id, req.body?.pinned === true);
    res.json({ ok: true });
  });

  // Chat is run-cockpit-free (run_id is always null), so the legacy run list is
  // empty — the endpoint exists only so the frontend's run poll never 404s.
  router.get("/runs", (req, res) => {
    assertBoardOrgAccess(req);
    res.json({ runs: [] });
  });

  router.get("/chat/sessions", async (req, res) => {
    assertBoardOrgAccess(req);
    const includeArchived = req.query.include_archived === "true";
    const companyId = await findLocalChatCompanyId(db);
    if (!companyId) {
      res.json({ sessions: [] });
      return;
    }
    const rows = await svc.listChatSessions(companyId, { includeArchived });
    const pins = await readChatPins(db, companyId, "session");
    res.json({
      sessions: rows.map(({ issue, comments }) =>
        toBackendChatSession(issue, comments, pins.get(issue.id) ?? null),
      ),
    });
  });

  router.get("/chat/sessions/:id", async (req, res) => {
    assertBoardOrgAccess(req);
    const id = req.params.id as string;
    if (!UUID_RE.test(id)) {
      res.status(404).json({ error: "Chat session not found" });
      return;
    }
    const companyId = await findLocalChatCompanyId(db);
    const found = companyId ? await svc.getChatSession(id, { companyId }) : null;
    if (!found) {
      res.status(404).json({ error: "Chat session not found" });
      return;
    }
    res.json(toBackendChatSession(found.issue, found.comments));
  });

  // Respond with the (re-fetched) session in legacy shape, or 404 if it vanished.
  const respondSession = async (res: Response, companyId: string, issueId: string) => {
    const found = await svc.getChatSession(issueId, { companyId });
    if (!found) {
      res.status(404).json({ error: "Chat session not found" });
      return;
    }
    res.json(toBackendChatSession(found.issue, found.comments));
  };

  router.post("/chat/sessions/:id/archive", async (req, res) => {
    assertBoardOrgAccess(req);
    const id = req.params.id as string;
    if (!UUID_RE.test(id)) {
      res.status(404).json({ error: "Chat session not found" });
      return;
    }
    const companyId = await findLocalChatCompanyId(db);
    const archived = typeof req.body?.archived === "boolean" ? req.body.archived : true;
    // Fail-closed: never archive a chat whose agent is still running — that would
    // orphan the live run (it keeps executing, invisible to the user). The owner
    // chose "reject and prompt": stop the chat first, then archive.
    if (archived && companyId && (await heartbeat.getActiveChatRun(companyId, id))) {
      res.status(409).json({ error: "Stop the running chat before archiving it", code: "chat_running" });
      return;
    }
    if (!companyId || !(await setChatArchived(db, id, archived, { companyId }))) {
      res.status(404).json({ error: "Chat session not found" });
      return;
    }
    await respondSession(res, companyId, id);
  });

  // User-initiated Stop for a chat turn. Natively cancels the Node heartbeat run
  // backing this session (kills the agent runtime's process group), clears the
  // session's pending wakes, and suppresses recovery/promotion so Stop means the
  // chat goes idle — never "stop then auto-run the next turn". Keyed by session
  // id so the run_id stays null (chat is run-cockpit-free); a no-op when idle.
  router.post("/chat/sessions/:id/cancel", async (req, res) => {
    assertBoardOrgAccess(req);
    const id = req.params.id as string;
    if (!UUID_RE.test(id)) {
      res.status(404).json({ error: "Chat session not found" });
      return;
    }
    const companyId = await findLocalChatCompanyId(db);
    const found = companyId ? await svc.getChatSession(id, { companyId }) : null;
    if (!companyId || !found) {
      res.status(404).json({ error: "Chat session not found" });
      return;
    }
    const result = await heartbeat.cancelChatSessionExecution(companyId, id, "Cancelled by chat stop");
    res.json({
      ok: true,
      cancelled: Boolean(result.run),
      status: result.run?.status ?? "idle",
      wakeups_cancelled: result.wakeupsCancelled,
      // The chat-stop pause hold that now parks this issue against automatic
      // recovery (null when an earlier hold already covers it).
      parked_hold_id: result.parkedHoldId,
    });
  });

  router.post("/chat/sessions/:id/move", async (req, res) => {
    assertBoardOrgAccess(req);
    const id = req.params.id as string;
    if (!UUID_RE.test(id)) {
      res.status(404).json({ error: "Chat session not found" });
      return;
    }
    const raw = req.body?.workspace_id;
    // null/absent → ungroup; a uuid string → a target workspace (= project id);
    // anything else (empty string, number, object, …) is malformed input.
    let workspaceId: string | null;
    if (raw === undefined || raw === null) {
      workspaceId = null;
    } else if (typeof raw === "string" && UUID_RE.test(raw)) {
      workspaceId = raw;
    } else {
      res.status(422).json({ error: "workspace_id must be a uuid or null" });
      return;
    }
    const companyId = await findLocalChatCompanyId(db);
    if (!companyId) {
      res.status(404).json({ error: "Chat session not found" });
      return;
    }
    // Fail-closed: moving a chat re-homes its execution boundary (workspace ==
    // project root). Doing so while the agent is running would leave the live
    // process in the OLD cwd/boundary. Stop the chat first.
    if (await heartbeat.getActiveChatRun(companyId, id)) {
      res.status(409).json({ error: "Stop the running chat before moving it", code: "chat_running" });
      return;
    }
    const result = await moveChatSession(db, id, workspaceId, { companyId });
    if (result === "unknown_workspace") {
      res.status(404).json({ error: "unknown workspace" });
      return;
    }
    if (result === "not_found") {
      res.status(404).json({ error: "Chat session not found" });
      return;
    }
    await respondSession(res, companyId, id);
  });

  // Pin / unpin a chat session into the sidebar's "Pinned" zone (stored in
  // chat_sidebar_pins, mirrors the workspace pin route).
  router.post("/chat/sessions/:id/pin", async (req, res) => {
    assertBoardOrgAccess(req);
    const id = req.params.id as string;
    if (!UUID_RE.test(id)) {
      res.status(404).json({ error: "Chat session not found" });
      return;
    }
    const companyId = await findLocalChatCompanyId(db);
    if (!companyId) {
      res.status(404).json({ error: "Chat session not found" });
      return;
    }
    await setChatPin(db, companyId, "session", id, req.body?.pinned === true);
    res.json({ ok: true });
  });

  router.post("/chat/stream", async (req, res) => {
    assertBoardOrgAccess(req);
    const body = req.body as Record<string, unknown> | undefined;
    const message = typeof body?.message === "string" ? body.message.trim() : "";
    if (!message) {
      res.status(400).json({ error: "message is required" });
      return;
    }
    const sessionIdIn = typeof body?.session_id === "string" ? body.session_id : null;
    const requestedBackend = requestedBackendOf(body);
    // Per-turn model/effort: a string (incl. "" = REQUEST_CLEAR) is an explicit
    // request; absent ⇒ undefined (the session's sticky runtime governs). The
    // composer's visible state IS the per-turn request (CLI shell parity).
    const requestedModel = typeof body?.model === "string" ? body.model : undefined;
    const requestedEffort = typeof body?.effort === "string" ? body.effort : undefined;
    // The first turn of a workspace-pinned chat carries the target workspace id
    // (B2: workspace == Paperclip project). It binds a NEW session into that
    // project so the run executes in the workspace's root instead of the dev
    // server's cwd. A non-uuid is rejected (fail-closed) rather than silently
    // dropped; absent/empty ⇒ no pin. Subsequent turns omit it — the binding
    // then lives on the session, and re-homing goes through the dedicated move
    // endpoint (with its boundary-change ack), never a silent stream re-file.
    const rawWorkspaceId = body?.workspace_id;
    let requestedWorkspaceId: string | null = null;
    if (rawWorkspaceId !== undefined && rawWorkspaceId !== null && rawWorkspaceId !== "") {
      // A pin that is present but not a uuid string (a number, object, or a
      // malformed string) is REJECTED, never silently coerced to "no pin" — a
      // bad pin must not let the turn fall through to the dev server's cwd.
      if (typeof rawWorkspaceId !== "string" || !UUID_RE.test(rawWorkspaceId)) {
        res.status(400).json({ error: "workspace_id must be a uuid" });
        return;
      }
      requestedWorkspaceId = rawWorkspaceId;
    }
    const budgetSeconds =
      typeof body?.budget_seconds === "number" && body.budget_seconds > 0
        ? Math.min(body.budget_seconds, 86_400)
        : DEFAULT_TURN_BUDGET_SECONDS;

    // The composer's @company selection runs the turn natively INSIDE that company
    // (its agents/issues/budget/governance) instead of the default personal-chat
    // company. Validated + access-checked BEFORE the SSE stream opens so a bad or
    // forbidden company fails CLOSED with a real status code, never a mid-stream
    // error. A non-uuid is rejected (never coerced to "no company"); a uuid that does
    // not resolve to a real company is a 404; absent ⇒ the personal-chat company.
    const rawCompanyId = body?.company_id;
    let requestedCompanyId: string | null = null;
    if (rawCompanyId !== undefined && rawCompanyId !== null && rawCompanyId !== "") {
      if (typeof rawCompanyId !== "string" || !UUID_RE.test(rawCompanyId)) {
        res.status(400).json({ error: "company_id must be a uuid" });
        return;
      }
      assertCompanyAccess(req, rawCompanyId);
      requestedCompanyId = rawCompanyId;
    }
    // Explicit @company ⇒ validate it resolves to a real company (fail-closed 404 if not).
    // No @company ⇒ the default personal-chat company (unchanged / back-compat).
    const companyId = requestedCompanyId
      ? await resolveChatCompanyId(db, requestedCompanyId)
      : await ensureLocalChatCompany(db);
    if (!companyId) {
      res.status(404).json({ error: "company not found" });
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    let closed = false;
    const send = (event: string, data: unknown) => {
      if (!closed && res.writable) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    let unsubscribe: () => void = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;
    // Created up front so a client close during setup (before the run is woken)
    // resolves a REAL terminal promise rather than an early no-op.
    let terminalDone = false;
    let resolveTerminal: () => void = () => {};
    const terminalPromise = new Promise<void>((resolve) => {
      resolveTerminal = () => {
        if (!terminalDone) {
          terminalDone = true;
          resolve();
        }
      };
    });
    const cleanup = () => {
      unsubscribe();
      unsubscribe = () => {};
      if (timer) clearTimeout(timer);
      if (poll) clearInterval(poll);
    };
    // A disconnecting client must release the live-event listener + timers and
    // unblock the terminal wait, instead of leaking until the budget expires.
    res.on("close", () => {
      closed = true;
      cleanup();
      resolveTerminal();
    });

    try {
      // companyId was resolved + access-checked above (before the SSE head). A client
      // that closed during that setup short-circuits here rather than waking a run.
      if (closed) {
        res.end();
        return;
      }
      // Resolve an EXISTING session's sticky runtime + transcript FIRST so we
      // pick this turn's backend before touching anything. A NEW session's issue
      // is created LATER — only after the resolved backend passes the fail-closed
      // check — so an invalid backend never leaves a garbage empty chat session.
      let issueId: string | null = sessionIdIn;
      let stickyExecutionState: Record<string, unknown> | null = null;
      let priorAssigneeOverrides: Record<string, unknown> | null = null;
      let priorCommentIds: string[] = [];
      if (sessionIdIn) {
        // A reused session must be a well-formed chat session id in THIS company
        // before we assign/comment — never touch a bad/non-chat/cross-company
        // issue (and a non-uuid would otherwise blow up the uuid-column query).
        const found = UUID_RE.test(sessionIdIn)
          ? await svc.getChatSession(sessionIdIn, { companyId })
          : null;
        if (!found) {
          send("chat.completed", {
            session_id: sessionIdIn,
            run_id: null,
            status: "failed",
            response: null,
            failure_reason: "session_not_found",
          });
          res.end();
          return;
        }
        stickyExecutionState = (found.issue.executionState as Record<string, unknown> | null) ?? null;
        priorAssigneeOverrides =
          (found.issue.assigneeAdapterOverrides as Record<string, unknown> | null) ?? null;
        priorCommentIds = found.comments.map((comment) => comment.id);
      }
      if (closed) {
        res.end();
        return;
      }

      // Per-turn runtime resolution (request > sticky > default) — faithful port
      // of the SuperClaw kernel (chat-runtime-selection.ts). A backend switch
      // mid-chat is an in-chat handoff (drop old model/effort, mark a system
      // note, replay the transcript into the new runtime's context).
      const selection = resolveChatRuntime(stickyExecutionState, {
        requestedBackend,
        requestedModel,
        requestedEffort,
        defaultBackend: DEFAULT_CHAT_ADAPTER,
      });
      const adapterType = selection.backend;
      // Fail-closed BEFORE any persistent write: the resolved backend MUST be a
      // registered AND enabled adapter. `getServerAdapter` silently falls back to
      // the built-in `process` adapter for an unknown type, so detect the
      // mismatch; a disabled adapter is also refused. A failed NEW chat reports
      // `session_id: null` (no issue was ever created) so the surface never
      // migrates to / persists a phantom session — mirrors the CLI failing an
      // unavailable backend instead of falling back.
      const resolvedAdapter = getServerAdapter(adapterType);
      const backendEnabled = listEnabledServerAdapters().some((a) => a.type === adapterType);
      if (resolvedAdapter.type !== adapterType || !backendEnabled) {
        send("chat.completed", {
          session_id: issueId,
          run_id: null,
          status: "failed",
          response: null,
          failure_reason: "unknown_or_disabled_backend",
        });
        res.end();
        return;
      }
      // Fail-closed: chat may only run on an eligible local conversational runtime
      // (isChatEligibleAdapter = allow-listed type AND trusted built-in module).
      // Everything else — gateway/cloud relays that hardcode a Paperclip shell, the
      // process/http built-ins, any unlisted adapter, OR an external adapter that
      // overrode an allow-listed type — is refused BEFORE any persistent write.
      if (!isChatEligibleAdapter(adapterType)) {
        send("chat.completed", {
          session_id: issueId,
          run_id: null,
          status: "failed",
          response: null,
          failure_reason: "ineligible_chat_backend",
        });
        res.end();
        return;
      }

      // Fail-closed: a NEW session pinned to a workspace must reference a real
      // project in THIS company BEFORE the issue is created — a bad/cross-company
      // pin must never file a chat into a non-existent cwd or orphan an empty
      // session (mirrors the pre-creation backend check above). An existing
      // session ignores the field: its binding already lives on the session.
      if (!issueId && requestedWorkspaceId) {
        if (!(await chatWorkspaceExists(db, requestedWorkspaceId, { companyId }))) {
          send("chat.completed", {
            session_id: null,
            run_id: null,
            status: "failed",
            response: null,
            failure_reason: "unknown_workspace",
          });
          res.end();
          return;
        }
      }

      // Backend (and any workspace pin) is valid → NOW materialize a brand-new
      // session (an existing one was already resolved above). Nothing persistent
      // is written for an invalid backend or an unknown workspace. A pin is filed
      // ATOMICALLY at creation (projectId passed into the native issue create,
      // which also resolves the project's PRIMARY project-workspace) — never a
      // post-hoc move that could half-apply or run in the wrong cwd on failure.
      if (!issueId) {
        const issue = await createChatSession(db, companyId, {
          title: deriveTitle(message),
          projectId: requestedWorkspaceId,
        });
        issueId = issue.id;
      }
      if (closed) {
        res.end();
        return;
      }

      const agentId = await ensureChatAgent(db, companyId, adapterType);

      // Per-turn model/effort applied as an ISSUE-scoped adapter override —
      // heartbeat resolves it per run WITHOUT mutating the shared per-adapter
      // chat agent (other chats on the same runtime are unaffected). The sticky
      // {backend, model, effort} is persisted onto the issue's executionState.
      const overrideAdapterConfig = applyEffortToAdapterConfig(
        adapterType,
        selection.model ? { model: selection.model } : {},
        selection.effort,
      );
      // Merge into any EXISTING assigneeAdapterOverrides (e.g. modelProfile
      // "cheap", useProjectWorkspace) — only this turn's `adapterConfig` is
      // (re)written; an empty config drops just that key. Never clobber the
      // sibling override fields heartbeat also consumes.
      const mergedOverrides: Record<string, unknown> = { ...(priorAssigneeOverrides ?? {}) };
      if (Object.keys(overrideAdapterConfig).length > 0) {
        mergedOverrides.adapterConfig = overrideAdapterConfig;
      } else {
        delete mergedOverrides.adapterConfig;
      }
      const assigneeAdapterOverrides =
        Object.keys(mergedOverrides).length > 0 ? mergedOverrides : null;
      const { executionState: nextExecutionState } = applyChatRuntime(stickyExecutionState, selection);
      await persistChatTurnRuntime(db, issueId, {
        companyId,
        executionState: nextExecutionState,
        assigneeAdapterOverrides,
      });

      // A backend switch must start a FRESH native session (the old runtime's
      // session can't continue) — reset the issue's resume state so a switch
      // BACK to a previously-used backend also begins clean, then replay the
      // transcript (below) into the new runtime.
      if (selection.backendSwitched) {
        await resetChatSessionResume(db, issueId, { companyId });
      }

      // Backend switch → append the handoff note as a `system` transcript marker
      // (it joins priorCommentIds so it replays too).
      if (selection.backendSwitched && selection.handoffNote) {
        const note = await appendChatSystemNote(db, issueId, selection.handoffNote, { companyId });
        priorCommentIds = [...priorCommentIds, note.id];
      }
      if (closed) {
        res.end();
        return;
      }
      // The chat agent must own the issue or heartbeat cancels the run as stale.
      await assignChatAgent(db, issueId, agentId, { companyId });
      const userComment = await appendUserTurn(db, issueId, message, { companyId });
      if (closed) {
        res.end();
        return;
      }
      // Replay the transcript whenever the run will start a FRESH native session
      // (no resume for this agent on this issue) AND there is prior context to
      // carry — after a backend switch (resume just reset), OR a turn whose prior
      // switch never established a session (wakeup skipped / launch failed: sticky
      // is already the new backend so `backendSwitched` is false, but the session
      // is still fresh). A live session carries continuity via native resume.
      let replayCommentIds: string[] | null = null;
      if (
        priorCommentIds.length > 0 &&
        !(await hasChatSessionResume(db, issueId, agentId, { companyId }))
      ) {
        replayCommentIds = [...priorCommentIds, userComment.id];
      }
      send("chat.started", {
        session_id: issueId,
        backend: adapterType,
        run_id: null,
        turn_id: userComment.id,
      });

      // Subscribe BEFORE waking: wakeup kicks execution immediately and live
      // events are non-replay, so a fast run could finish before we listen.
      // runId is unknown until wakeup returns → buffer events until then.
      let runId: string | null = null;
      // The projector turns the adapter's streamed stdout (claude_local emits
      // stream-json JSON-lines; others emit plain text) into the chat SSE
      // vocabulary: assistant text → message.delta, tool/reasoning/usage →
      // canonical DisplayProtocol events. Created once runId is known.
      let projector: ChatDisplayProjector | null = null;
      const buffered: Array<{ type?: string; payload?: Record<string, unknown> }> = [];
      const handleRunEvent = (type: string | undefined, payload: Record<string, unknown>) => {
        if (type === "heartbeat.run.log") {
          // Only assistant stdout becomes chat output; stderr is diagnostics and
          // must not be projected as assistant text.
          if (payload.stream !== "stdout") return;
          const chunk = typeof payload.chunk === "string" ? payload.chunk : "";
          if (chunk) projector?.ingest(chunk);
        } else if (type === "heartbeat.run.status" && TERMINAL_RUN_STATUSES.has(String(payload.status))) {
          resolveTerminal();
        }
      };
      unsubscribe = subscribeCompanyLiveEvents(companyId, (event) => {
        const e = event as { type?: string; payload?: Record<string, unknown> };
        if (!e?.payload) return;
        if (runId === null) {
          buffered.push(e);
          return;
        }
        if (e.payload.runId !== runId) return;
        handleRunEvent(e.type, e.payload);
      });

      // This user turn is the resume signal for a previously-stopped chat —
      // lift the chat-stop hold BEFORE waking or the wake would be skipped.
      await releaseChatStopHold(companyId, issueId);

      const run = await heartbeat.wakeup(agentId, {
        source: "on_demand",
        payload: { issueId, commentId: userComment.id },
        // On a runtime switch, replay the whole transcript into the new wake
        // context (the fresh native session inherits nothing from the old one).
        ...(replayCommentIds
          ? { contextSnapshot: { [WAKE_COMMENT_IDS_KEY]: replayCommentIds } }
          : {}),
      });
      if (!run) {
        // wakeup returned null. Two very different reasons share that signal:
        //  (a) the agent is already running THIS issue, so the prompt was durably
        //      enqueued as a deferred wake that the in-flight run promotes on
        //      completion — the prompt is NOT lost, it runs next; or
        //  (b) a genuine skip (pause hold / agent uninvokable / company inactive)
        //      that records a `skipped` (or no) wake and drops the turn.
        // Probe the wake ledger for THIS prompt's OWN wake (scoped to userComment.id
        // — NOT the issue, or the in-flight run's claimed wake would mask a genuine
        // skip as queued) to tell them apart and report honestly: "queued" (will run
        // next) vs "failed" (wakeup_skipped). Reporting (a) as a failure is the gap —
        // the second same-chat prompt looked dropped when it wasn't.
        const queued = await hasPendingWakeForComment(db, companyId, agentId, userComment.id);
        cleanup();
        send("chat.completed", {
          session_id: issueId,
          run_id: null,
          status: queued ? "queued" : "failed",
          response: null,
          failure_reason: queued ? "wakeup_deferred" : "wakeup_skipped",
        });
        res.end();
        return;
      }
      if (closed) {
        cleanup();
        res.end();
        return;
      }
      runId = run.id;
      projector = createChatDisplayProjector({
        send,
        runtimeId: adapterType,
        runId,
        sessionId: issueId,
        format: chatDisplayFormatForAdapter(adapterType),
      });
      // Drain anything that arrived between subscribe and wakeup-return.
      for (const e of buffered) {
        if (e.payload?.runId === runId) handleRunEvent(e.type, e.payload);
      }

      // Terminal resolution: the status event is the fast path; a getRun poll is
      // the backstop if that event is missed; the budget is the hard ceiling.
      timer = setTimeout(() => resolveTerminal(), budgetSeconds * 1000);
      if (typeof timer.unref === "function") timer.unref();
      poll = setInterval(() => {
        void heartbeat
          .getRun(runId as string)
          .then((r) => {
            if (r && TERMINAL_RUN_STATUSES.has(String(r.status))) resolveTerminal();
          })
          .catch(() => {});
      }, 500);
      if (typeof poll.unref === "function") poll.unref();

      await terminalPromise;
      projector?.flush();
      cleanup();
      if (closed) return;

      const finalRun = await heartbeat.getRun(runId);
      const runStatus = finalRun?.status ?? "failed";
      const succeeded = runStatus === "succeeded";
      const streamedText = projector?.text() ?? "";
      const response = extractFinalText(finalRun) ?? (streamedText.length > 0 ? streamedText : null);
      send("message.completed", { text: response ?? "" });
      send("chat.completed", {
        session_id: issueId,
        run_id: null,
        status: succeeded ? "completed" : "failed",
        backend: adapterType,
        response,
        failure_reason: succeeded ? null : ((finalRun as { error?: string })?.error ?? "run_failed"),
      });
      res.end();
    } catch (err) {
      cleanup();
      send("chat.completed", {
        session_id: sessionIdIn,
        run_id: null,
        status: "failed",
        response: null,
        failure_reason: err instanceof Error ? err.message : "chat_stream_error",
      });
      res.end();
    }
  });

  return router;
}
