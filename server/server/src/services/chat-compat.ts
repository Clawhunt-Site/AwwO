import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agentTaskSessions,
  agentWakeupRequests,
  companies,
  costEvents,
  financeEvents,
  issueComments,
  issues,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import { agentService } from "./agents.js";
import { companyService } from "./companies.js";
import { issueService } from "./issues.js";
import { projectService } from "./projects.js";
import { readChatPins, setChatPin } from "./chat-pins.js";
import { parseProjectExecutionWorkspacePolicy } from "./execution-workspace-policy.js";
import { RUNTIME_METADATA_KEY } from "./chat-runtime-selection.js";
import { badRequest, notFound } from "../errors.js";
import { isBuiltinAdapterActive } from "../adapters/registry.js";

/** Reserved display name for the auto-provisioned chat runtime agent. */
export const CHAT_AGENT_NAME = "Chat Assistant";

/**
 * Lean system charter for the chat runtime agent. Stamped onto the chat agent's
 * `adapterConfig.promptTemplate` so every local adapter renders THIS instead of
 * falling back to `DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE` (the heavy "Continue
 * your Paperclip work / Execution contract / done|in_review|blocked / child issues
 * / confirmations / budgets" agent base). Chat is a direct conversational surface,
 * not a board-driven delivery loop — but it MUST still execute (use tools, read
 * and write the authorized workspace) rather than answer in an ask-only mode.
 *
 * No `{{...}}` placeholders: the adapter renders this verbatim. Deliberately omits
 * all Paperclip issue/ticket/company/status/approval scaffolding.
 */
export const CHAT_AGENT_CHARTER = [
  "You are SuperClaw's chat assistant. Help the user directly and conversationally.",
  "",
  "- Do what the user asks. You may use any available tools and read or write the",
  "  authorized workspace to carry out real work — do not stop at describing a plan",
  "  or answer in a read-only/ask-only mode when the request calls for action.",
  "- The conversation so far is your memory of this session; rely on it for context.",
  "- Keep replies focused and useful.",
  "- This is a direct chat, not a managed work board — there is no issue tracker,",
  "  company, or ticket workflow behind it. Don't try to file or manage tracked",
  "  work items, request approvals, or hand off to other agents; just help the user",
  "  here, in this conversation.",
].join("\n");

/**
 * Adapter types eligible to back a chat session — a POSITIVE allow-list, so chat
 * is FAIL-CLOSED: anything not listed (cloud/gateway relays like hermes_gateway,
 * openclaw_gateway, cursor_cloud; the built-in process/http adapters; and any
 * external/hot-registered adapter) is refused. Only these local conversational
 * adapters (a) honor the chat agent's lean `adapterConfig.promptTemplate`
 * (CHAT_AGENT_CHARTER) instead of falling back to the heavy Paperclip base, and
 * (b) render their wake via renderPaperclipWakePrompt (which emits the lean chat
 * transcript for chat-origin). A deny-list was rejected as fail-open: an unknown
 * adapter must NOT be assumed chat-safe. A new chat runtime is opt-in here.
 *
 * Keep in sync with the local-conversational adapters registered in
 * adapters/registry.ts; the chat-runtime inventory (chat_capable / chat_tier) and
 * the chat run path both gate on this set, so removing a type here both rejects it
 * at the run path AND hides it from the composer (its chat_tier becomes null).
 *
 * acpx_local is intentionally EXCLUDED: it is an incomplete ACP bridge whose
 * streaming protocol frames (acpx.* JSON) and [superclaw] notes leak into the
 * chat output instead of clean text, so it is not supported as a chat backend.
 */
export const CHAT_ELIGIBLE_ADAPTER_TYPES = new Set<string>([
  "claude_local",
  "codex_local",
  "gemini_local",
  "cursor",
  "opencode_local",
  "pi_local",
  "grok_local",
  "clawwork_local",
  "hermes_local",
]);

/**
 * THE single chat-eligibility predicate — fail-closed on BOTH axes:
 *  1. the type is on the local-conversational allow-list, AND
 *  2. the ACTIVE registry module for that type is the trusted built-in (not an
 *     external adapter that overrode an allow-listed type — provenance check).
 * The chat run path (chat.ts), ensureChatAgent, and the chat-runtime inventory
 * (chat_capable) all gate on this, so the composer never offers — and the kernel
 * never provisions — a runtime the run path would refuse, including an external
 * adapter masquerading as e.g. "claude_local".
 */
export function isChatEligibleAdapter(adapterType: string): boolean {
  return CHAT_ELIGIBLE_ADAPTER_TYPES.has(adapterType) && isBuiltinAdapterActive(adapterType);
}

/** Postgres unique-violation SQLSTATE — the only recoverable create race. */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "23505"
  );
}

/** The implicit local single-operator actor (matches the local_trusted board). */
export const LOCAL_BOARD_USER_ID = "local-board";

/**
 * Personal chat lives under a single reserved "local" company addressed by a
 * FIXED id — deterministic and idempotent, with no stored pointer to drift.
 * (A pointer in instance-settings.general was rejected: the strict
 * general-settings normalizer drops unknown keys on any patch.) The streaming
 * slice creates this company lazily on the first turn (insert-if-absent on this
 * id); until then the resolver returns null and the read endpoints serve an
 * empty list.
 */
export const LOCAL_CHAT_COMPANY_ID = "00000000-c4a7-4000-a000-000000000001";

export async function findLocalChatCompanyId(db: Db): Promise<string | null> {
  const rows = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.id, LOCAL_CHAT_COMPANY_ID))
    .limit(1);
  return rows.length > 0 ? rows[0].id : null;
}

/**
 * Whether THIS chat prompt's wake is durably PENDING (i.e. it will still run).
 * When a second prompt arrives on a chat whose agent is already running this same
 * issue, `heartbeat.wakeup` returns null but does NOT drop the prompt — it records
 * a `deferred_issue_execution` wake (carrying this prompt's `commentId` in the
 * payload) that the in-flight run promotes on completion. The chat stream uses
 * this to report that null as "queued" (the prompt WILL run next) instead of a
 * "wakeup_skipped" failure.
 *
 * CRITICAL — scope by `commentId`, NOT by issue. The in-flight run sets its OWN
 * original wake to `claimed` on the SAME issue (heartbeat.ts ~7524). An issue-only
 * probe would therefore see that stale `claimed` row and falsely report "queued"
 * for a genuine skip that returned null for an unrelated reason (e.g. an active
 * issue-tree pause hold returns null BEFORE the deferral branch, heartbeat.ts
 * ~11092). Every wake row carries the originating prompt's `commentId` in its
 * payload (the chat wakeup payload is `{ issueId, commentId }`, and the deferral
 * insert/coalesce preserve it), so matching THIS prompt's `commentId` uniquely
 * identifies its own wake and never the in-flight run's. A genuine skip writes a
 * `status:"skipped"` row (heartbeat.ts ~10949) — outside the pending set — so it
 * correctly returns false and the caller reports the failure.
 *
 * COALESCE — the top-level `commentId` is not enough on its own. If a THIRD prompt
 * arrives while this one is still deferred, the deferral coalesces both into ONE
 * row and overwrites the top-level `commentId` with the newest (heartbeat.ts
 * ~11529). The earlier prompt's id survives only inside the merged wake context
 * (`_paperclipWakeContext`): `mergeCoalescedContextSnapshot` accumulates every
 * coalesced id into `wakeCommentIds` and keeps the latest in `commentId`/
 * `wakeCommentId` (heartbeat.ts ~2767). So we also match the nested context — its
 * single ids and the `wakeCommentIds` array — to recover a prompt that was
 * coalesced over. This never re-opens the over-report: the in-flight run's claimed
 * row carries its own (earlier) ids, never this later prompt's, so querying this
 * prompt's id can only hit its own (possibly coalesced) deferred row.
 */
export async function hasPendingWakeForComment(
  db: Db,
  companyId: string,
  agentId: string,
  commentId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: agentWakeupRequests.id })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, companyId),
        eq(agentWakeupRequests.agentId, agentId),
        // The non-terminal ("alive") wake states. `claimed` is included: scoped to
        // this prompt's own commentId it can only mean THIS prompt is being run
        // (the over-report vector was the OTHER run's claimed row, excluded by the
        // commentId match below — not by dropping the status). `skipped` and the
        // terminal states (succeeded/failed/cancelled/done) are deliberately out.
        inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution", "claimed"]),
        // Match this prompt's id at the payload top level OR inside the merged wake
        // context (single id or the coalesced `wakeCommentIds` array). The nested
        // keys mirror heartbeat's `_paperclipWakeContext` / `wakeCommentIds`.
        sql`(
          ${agentWakeupRequests.payload} ->> 'commentId' = ${commentId}
          or ${agentWakeupRequests.payload} -> '_paperclipWakeContext' ->> 'commentId' = ${commentId}
          or ${agentWakeupRequests.payload} -> '_paperclipWakeContext' ->> 'wakeCommentId' = ${commentId}
          or ${agentWakeupRequests.payload} -> '_paperclipWakeContext' -> 'wakeCommentIds' @> ${JSON.stringify([commentId])}::jsonb
        )`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

// Validate an EXPLICIT @company selection: the turn runs natively inside THAT company —
// its agents, issues, budget and governance are Paperclip's own — instead of the
// hardcoded personal-chat company. Returns the company id when it resolves to a real
// company, or null so the caller fails CLOSED (a stale/bad @company must never silently
// redirect the turn into the wrong company or the default). The default (no @company)
// path stays on ensureLocalChatCompany at the call site, so it is unchanged/back-compat.
export async function resolveChatCompanyId(db: Db, requestedCompanyId: string): Promise<string | null> {
  const company = await companyService(db).getById(requestedCompanyId);
  return company ? company.id : null;
}

/** Idempotently create the reserved "local" company that hosts personal chat. */
export async function ensureLocalChatCompany(db: Db): Promise<string> {
  const existing = await findLocalChatCompanyId(db);
  if (existing) return existing;
  try {
    await companyService(db).create({ id: LOCAL_CHAT_COMPANY_ID, name: "Personal Chat" });
  } catch (err) {
    // ONLY a concurrent insert of the same fixed id is recoverable. Any other
    // failure (e.g. a half-completed create whose environment provisioning
    // threw) must surface, not be masked by re-finding the bare company row.
    if (isUniqueViolation(err)) {
      const after = await findLocalChatCompanyId(db);
      if (after) return after;
    }
    throw err;
  }
  return LOCAL_CHAT_COMPANY_ID;
}

/** Create a new chat session = a chat-marked issue under the given company. */
export async function createChatSession(
  db: Db,
  companyId: string,
  input: { title: string; projectId?: string | null },
): Promise<ChatIssueRow> {
  // Unpinned chat → a plain issue.
  if (!input.projectId) {
    return issueService(db).create(companyId, {
      title: input.title,
      originKind: CHAT_SESSION_ORIGIN_KIND,
    }) as unknown as Promise<ChatIssueRow>;
  }
  // Pinned to a workspace (B2: workspace == project). Resolve through the SAME
  // ownership-safe resolver the re-home path uses, so first-turn create and later
  // move ALWAYS bind the identical workspace.
  const { projectExists, workspaceId } = await resolveProjectWorkspaceIdForChat(
    db,
    companyId,
    input.projectId,
  );
  // Fail-closed BEFORE creating anything: an unknown / cross-company project must
  // never leave a stray unbound chat issue behind (this is exactly what move
  // rejects with "unknown_workspace"). Mirrors moveChatSession so create and move
  // agree on this input too.
  if (!projectExists) {
    throw notFound("Chat workspace not found");
  }
  if (workspaceId) {
    // An own-project workspace exists → file ATOMICALLY (native create validates
    // the provided id via assertValidProjectWorkspace; it belongs, so it passes).
    return issueService(db).create(companyId, {
      title: input.title,
      originKind: CHAT_SESSION_ORIGIN_KIND,
      projectId: input.projectId,
      projectWorkspaceId: workspaceId,
    }) as unknown as Promise<ChatIssueRow>;
  }
  // Project exists but has no own workspace (folder-only project, or ONLY a
  // foreign/stale policy default). Create unbound, then bind projectId with a null
  // workspace through the SAME move path. Routing through move is what keeps create
  // and move identical here: passing only `projectId` to the native create would
  // make it RE-RESOLVE the project policy default (`projectWorkspaceId ?? null`
  // treats our null as "unset") and throw on a foreign default.
  const issue = (await issueService(db).create(companyId, {
    title: input.title,
    originKind: CHAT_SESSION_ORIGIN_KIND,
  })) as unknown as ChatIssueRow;
  let moved: MoveChatResult;
  try {
    moved = await moveChatSession(db, issue.id, input.projectId, { companyId });
  } catch {
    // A project deleted concurrently (between the existence check above and this
    // bind) makes the projectId write hit the FK and THROW rather than return a
    // non-ok result. Treat it as a failed bind — handled uniformly below.
    moved = "not_found";
  }
  if (moved !== "ok") {
    // Remove the just-created (still empty) chat issue so no stray unbound chat is
    // left behind, then fail closed — create and move stay in lockstep here too.
    await db.delete(issues).where(and(eq(issues.id, issue.id), eq(issues.companyId, companyId)));
    throw notFound("Chat workspace not found");
  }
  // Return the BOUND row (move set projectId + a null workspace), never the stale
  // pre-move object whose projectId is still null. If a concurrent delete removed
  // the issue right after the bind, fail closed rather than return a stale object.
  const bound = await db
    .select()
    .from(issues)
    .where(eq(issues.id, issue.id))
    .then((rows) => rows[0]);
  if (!bound) {
    throw notFound("Chat workspace not found");
  }
  return bound as unknown as ChatIssueRow;
}

/** Append the user's turn to a session as a native issue comment. */
export async function appendUserTurn(
  db: Db,
  issueId: string,
  content: string,
  opts: { companyId?: string } = {},
): Promise<ChatCommentRow> {
  // Refuse to write into anything but a chat issue in the expected company: a
  // wrong/work/cross-company issue id must never accrue chat comments (the read
  // side would hide them, but the row is dirty).
  const filters = [eq(issues.id, issueId)];
  if (opts.companyId) filters.push(eq(issues.companyId, opts.companyId));
  const target = await db
    .select({ originKind: issues.originKind })
    .from(issues)
    .where(and(...filters))
    .then((rows) => rows[0] ?? null);
  if (!target || target.originKind !== CHAT_SESSION_ORIGIN_KIND) {
    throw notFound("Chat session not found");
  }
  return issueService(db).addComment(
    issueId,
    content,
    { userId: LOCAL_BOARD_USER_ID },
    { authorType: "user" },
  ) as unknown as Promise<ChatCommentRow>;
}

/**
 * Append a `system` transcript marker to a chat session (e.g. the runtime-switch
 * handoff note). Scoped to a chat issue in the given company; a system comment
 * carries no actor (authorType="system"), matching the kernel's actor/authorType
 * consistency guard.
 */
export async function appendChatSystemNote(
  db: Db,
  issueId: string,
  content: string,
  opts: { companyId?: string } = {},
): Promise<ChatCommentRow> {
  const filters = [eq(issues.id, issueId)];
  if (opts.companyId) filters.push(eq(issues.companyId, opts.companyId));
  const target = await db
    .select({ originKind: issues.originKind })
    .from(issues)
    .where(and(...filters))
    .then((rows) => rows[0] ?? null);
  if (!target || target.originKind !== CHAT_SESSION_ORIGIN_KIND) {
    throw notFound("Chat session not found");
  }
  return issueService(db).addComment(
    issueId,
    content,
    {},
    { authorType: "system" },
  ) as unknown as Promise<ChatCommentRow>;
}

/**
 * Persist a turn's resolved runtime onto the chat issue:
 *  - `executionState.runtime` = the sticky {backend, model, effort} (so the next
 *    turn / another surface inherits it).
 *  - `assigneeAdapterOverrides` = the per-turn model/effort override the run
 *    applies WITHOUT mutating the shared per-adapter chat agent (null clears it).
 * Scoped to a chat issue in the company; touches nothing on a non-chat id.
 */
export async function persistChatTurnRuntime(
  db: Db,
  issueId: string,
  opts: {
    companyId: string;
    executionState?: Record<string, unknown>;
    assigneeAdapterOverrides?: Record<string, unknown> | null;
  },
): Promise<void> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (opts.executionState !== undefined) set.executionState = opts.executionState;
  if (opts.assigneeAdapterOverrides !== undefined) {
    set.assigneeAdapterOverrides = opts.assigneeAdapterOverrides;
  }
  await db
    .update(issues)
    .set(set)
    .where(
      and(
        eq(issues.id, issueId),
        eq(issues.originKind, CHAT_SESSION_ORIGIN_KIND),
        eq(issues.companyId, opts.companyId),
      ),
    );
}

/**
 * Reset a chat session's adapter resume state (the agent-task-session keyed by
 * the issue id) so the NEXT run starts a FRESH native session. Called on a
 * runtime backend switch — the old backend's native session cannot continue,
 * and a switch BACK to a previously-used backend must also begin clean rather
 * than resuming the stale session. Mirrors the resume reset `moveChatSession`
 * does when the execution boundary changes. Keyed by issue id, so it never
 * touches another chat's resume state.
 */
export async function resetChatSessionResume(
  db: Db,
  issueId: string,
  opts: { companyId: string },
): Promise<void> {
  await db
    .delete(agentTaskSessions)
    .where(
      and(eq(agentTaskSessions.taskKey, issueId), eq(agentTaskSessions.companyId, opts.companyId)),
    );
}

/**
 * True when the resolved agent already has a resumable native session for this
 * chat issue. The streaming turn keys transcript-replay on THIS (not just the
 * backend-switch flag): a fresh session — first turn after a switch reset, OR a
 * turn after a prior switch whose run never established a session (wakeup
 * skipped / adapter launch failed) — has no resume and MUST receive the prior
 * transcript as context; a live session carries continuity via native resume.
 */
export async function hasChatSessionResume(
  db: Db,
  issueId: string,
  agentId: string,
  opts: { companyId: string },
): Promise<boolean> {
  const rows = await db
    .select({ id: agentTaskSessions.id })
    .from(agentTaskSessions)
    .where(
      and(
        eq(agentTaskSessions.taskKey, issueId),
        eq(agentTaskSessions.agentId, agentId),
        eq(agentTaskSessions.companyId, opts.companyId),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Assign the chat agent to its session issue. Heartbeat's staleness guard
 * cancels a queued issue run whose agent isn't the issue's assignee, so the
 * chat agent must own the issue before we wake it (and re-own it when the
 * selected runtime — hence the agent — changes mid-conversation).
 */
export async function assignChatAgent(
  db: Db,
  issueId: string,
  agentId: string,
  opts: { companyId?: string } = {},
): Promise<void> {
  // Only ever reassign a real chat issue (optionally scoped to a company); a
  // bad/non-chat/cross-company id updates zero rows rather than mutating a work issue.
  const filters = [eq(issues.id, issueId), eq(issues.originKind, CHAT_SESSION_ORIGIN_KIND)];
  if (opts.companyId) filters.push(eq(issues.companyId, opts.companyId));
  await db
    .update(issues)
    .set({ assigneeAgentId: agentId, updatedAt: new Date() })
    .where(and(...filters));
}

/**
 * Find-or-create the chat runtime agent for an adapter. The host "local" company
 * is chat-dedicated, so an agent there is uniquely identified by its adapter
 * type — a different selected runtime gets its own agent.
 */
export async function ensureChatAgent(
  db: Db,
  companyId: string,
  adapterType: string,
): Promise<string> {
  // Defense-in-depth (the chat run path also gates before any write): fail-closed
  // on the unified eligibility predicate — never provision a chat agent for a
  // gateway/cloud relay, the process/http built-ins, an unlisted adapter, or an
  // external adapter that overrode an allow-listed type.
  if (!isChatEligibleAdapter(adapterType)) {
    throw badRequest(`Adapter "${adapterType}" cannot back a chat session`);
  }
  const existing = (await agentService(db).list(companyId)).find(
    (agent) => agent.adapterType === adapterType,
  );
  if (existing) {
    // Repair chat agents that predate (or somehow lack) the lean charter: without
    // promptTemplate set, every local adapter falls back to the heavy Paperclip
    // agent base. Idempotent — only writes when the template is missing/stale.
    const config =
      typeof existing.adapterConfig === "object" &&
      existing.adapterConfig !== null &&
      !Array.isArray(existing.adapterConfig)
        ? (existing.adapterConfig as Record<string, unknown>)
        : {};
    if (config.promptTemplate !== CHAT_AGENT_CHARTER) {
      await agentService(db).update(existing.id, {
        adapterConfig: { ...config, promptTemplate: CHAT_AGENT_CHARTER },
      });
    }
    return existing.id;
  }
  const created = await agentService(db).create(companyId, {
    name: CHAT_AGENT_NAME,
    adapterType,
    adapterConfig: { promptTemplate: CHAT_AGENT_CHARTER },
  });
  return created.id;
}

/**
 * Archive / unarchive a chat session via the native soft-delete timestamp,
 * scoped to a chat issue in the given company. Returns false if no such session.
 */
export async function setChatArchived(
  db: Db,
  issueId: string,
  archived: boolean,
  opts: { companyId: string },
): Promise<boolean> {
  const updated = await db
    .update(issues)
    .set({ hiddenAt: archived ? new Date() : null, updatedAt: new Date() })
    .where(
      and(
        eq(issues.id, issueId),
        eq(issues.originKind, CHAT_SESSION_ORIGIN_KIND),
        eq(issues.companyId, opts.companyId),
      ),
    )
    .returning({ id: issues.id });
  return updated.length > 0;
}

/**
 * The project-workspace a chat filed into `projectId` should run in — a VERBATIM
 * mirror of `issueService.create`'s selection (issues.ts: project policy's
 * `defaultProjectWorkspaceId`, else `isPrimary DESC, createdAt, id`). The native
 * create path resolves this for a NEW chat; `moveChatSession` (re-home of an
 * existing chat) has no native equivalent, so it calls this to pick the SAME
 * workspace — create and move never diverge for the same project, even when a
 * policy default points away from the primary. Keep in lockstep with that block.
 * Returns null for a project with no workspaces (run resolves the managed Chat
 * scratch). Scoped to the company (the projectId is validated before this call).
 */
async function resolveProjectWorkspaceIdForChat(
  db: Db,
  companyId: string,
  projectId: string,
): Promise<{ projectExists: boolean; workspaceId: string | null }> {
  const project = await db
    .select({ executionWorkspacePolicy: projects.executionWorkspacePolicy })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
    .then((rows) => rows[0] ?? null);
  // The project must exist in THIS company. Callers distinguish "exists but has no
  // workspace yet" (workspaceId=null, bind a folder-only chat) from "no such
  // project" (projectExists=false, fail-closed) — so an unknown/cross-company
  // project is never silently filed as an unbound chat.
  if (!project) return { projectExists: false, workspaceId: null };
  const policyDefault =
    parseProjectExecutionWorkspacePolicy(project.executionWorkspacePolicy)?.defaultProjectWorkspaceId ?? null;
  if (policyDefault) {
    // Honor the policy default ONLY if it is actually a workspace of THIS project
    // in THIS company — `issueService.create` gates the same id through
    // `assertValidProjectWorkspace`, so a default pointing at another project (the
    // policy validator only checks UUID shape, not ownership) must never be
    // written onto the issue. A misconfigured default falls through to the primary
    // (a guaranteed-valid pick), so this resolver NEVER returns a foreign/stale id.
    const owned = await db
      .select({ id: projectWorkspaces.id })
      .from(projectWorkspaces)
      .where(
        and(
          eq(projectWorkspaces.id, policyDefault),
          eq(projectWorkspaces.projectId, projectId),
          eq(projectWorkspaces.companyId, companyId),
        ),
      )
      .limit(1);
    if (owned.length > 0) return { projectExists: true, workspaceId: policyDefault };
  }
  const workspaceId = await db
    .select({ id: projectWorkspaces.id })
    .from(projectWorkspaces)
    .where(and(eq(projectWorkspaces.projectId, projectId), eq(projectWorkspaces.companyId, companyId)))
    .orderBy(desc(projectWorkspaces.isPrimary), asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id))
    .then((rows) => rows[0]?.id ?? null);
  return { projectExists: true, workspaceId };
}

export type MoveChatResult = "ok" | "not_found" | "unknown_workspace";

/**
 * Move a chat session to a workspace (= a project, B2 mapping), or ungroup it
 * (`projectId: null`). Validates the target project belongs to the company, and
 * resets the session's adapter resume state (keyed by issue id) because the
 * move changes the execution boundary — never silently resume in the old cwd.
 */
export async function moveChatSession(
  db: Db,
  issueId: string,
  projectId: string | null,
  opts: { companyId: string },
): Promise<MoveChatResult> {
  let projectWorkspaceId: string | null = null;
  if (projectId !== null) {
    // Re-home must land on the SAME project-workspace a fresh chat created in this
    // project gets — including a project-policy `defaultProjectWorkspaceId` that
    // points away from the primary. `resolveProjectWorkspaceIdForChat` mirrors
    // `issueService.create`'s selection (and refuses a foreign/stale default), so
    // create and move never diverge; it also reports project existence (scoped to
    // the company) so an unknown/cross-company target fails closed. Setting only
    // `projectId` would leave `projectWorkspaceId` stale/null and let heartbeat
    // fall back to a non-primary cwd. Ungrouping clears it (stays null).
    const resolved = await resolveProjectWorkspaceIdForChat(db, opts.companyId, projectId);
    if (!resolved.projectExists) return "unknown_workspace";
    projectWorkspaceId = resolved.workspaceId;
  }
  // The reassignment and the resume-state reset must be atomic: the move
  // changes the execution boundary, so a turn must never resume in the old cwd
  // because it observed the new project before the resume handles were dropped.
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(issues)
      .set({ projectId, projectWorkspaceId, updatedAt: new Date() })
      .where(
        and(
          eq(issues.id, issueId),
          eq(issues.originKind, CHAT_SESSION_ORIGIN_KIND),
          eq(issues.companyId, opts.companyId),
        ),
      )
      .returning({ id: issues.id });
    if (updated.length === 0) return "not_found";
    await tx
      .delete(agentTaskSessions)
      .where(
        and(eq(agentTaskSessions.taskKey, issueId), eq(agentTaskSessions.companyId, opts.companyId)),
      );
    return "ok";
  });
}

/**
 * True if `workspaceId` is a project (B2: workspace == project) in the company.
 * The streaming turn calls this to fail-closed a NEW chat pinned to a workspace
 * BEFORE the session issue is created, so a bad/cross-company pin never files a
 * chat into a non-existent cwd or leaves an orphan empty session (mirrors the
 * pre-creation backend check the stream already does).
 */
export async function chatWorkspaceExists(
  db: Db,
  workspaceId: string,
  opts: { companyId: string },
): Promise<boolean> {
  const rows = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, workspaceId), eq(projects.companyId, opts.companyId)))
    .limit(1);
  return rows.length > 0;
}

/**
 * Chat-compat service — projects the native issue + issue-comment model onto the
 * legacy SuperClaw chat-surface wire shape, so the existing frontend consumes it
 * unchanged while the engine is the Node backend.
 *
 * Anchoring model (see docs/chat-api-parity.md + the Spike A gate): each chat is
 * one issue; each turn is one issue comment; resume continuity rides the native
 * agent-task-session store keyed by the issue id. This module is the READ
 * projection (list/get) — the streaming turn that creates issues/comments and
 * the runtime bridge land in later slices on top of it.
 *
 * Comments are read DIRECTLY from the table (filtered to `deletedAt IS NULL`,
 * verbatim, chronological) rather than via `issueService.listComments`, which
 * returns soft-deleted rows as empty-body tombstones and applies a username
 * redaction pass. Chat must surface real turn text, so it bypasses both. (A chat
 * instance must therefore not enable `censorUsernameInLogs`, which would also
 * rewrite comment bodies on write.)
 */

export type ChatIssueRow = typeof issues.$inferSelect;
export type ChatCommentRow = typeof issueComments.$inferSelect;

/**
 * Marks an issue as a chat session (vs. a normal work issue). Reuses the native
 * `issues.origin_kind` column — no new table/column — so chat-issues are
 * queryable and a regular work issue is never mistaken for a chat session.
 * The streaming slice stamps this on the issues it creates.
 */
export const CHAT_SESSION_ORIGIN_KIND = "chat";

/** Epoch seconds — matches the legacy `created_at: float` UI contract. */
function epochSeconds(value: Date): number {
  return value.getTime() / 1000;
}

/**
 * Map a comment's native author type to the chat message role. An agent turn is
 * the assistant; a human/board turn is the user; anything else is a system note.
 */
function authorTypeToRole(authorType: string | null): "user" | "assistant" | "system" {
  if (authorType === "agent") return "assistant";
  if (authorType === "user" || authorType === "board") return "user";
  return "system";
}

export function toBackendChatMessage(comment: ChatCommentRow) {
  // Optional metering fields (usage / elapsed_ms / status / context_refs) are
  // populated by the streaming slice from the run; the read projection emits the
  // fields that exist verbatim on the comment. All optional fields are absent
  // rather than null-stuffed, matching the legacy contract.
  //
  // A `system_notice` presentation marks an operational comment (workspace-ready /
  // runtime-service posts made by the run agent) that is NOT a conversational turn.
  // Project it as `system` regardless of author so it renders as a system note
  // instead of masquerading as an assistant reply — otherwise it polluted the
  // transcript and, at equal length, could displace an in-flight working turn.
  const presentationKind = (comment.presentation as { kind?: string } | null)?.kind;
  const role = presentationKind === "system_notice" ? "system" : authorTypeToRole(comment.authorType);
  return {
    role,
    content: comment.body,
    run_id: comment.createdByRunId ?? null,
    created_at: epochSeconds(comment.createdAt),
  };
}

export function toBackendChatSession(
  issue: ChatIssueRow,
  comments: ChatCommentRow[],
  pinnedAt: number | null = null,
) {
  // Expose the chat's sticky runtime ({backend, model?, effort?}) persisted in
  // `executionState.runtime` (written every turn by persistChatTurnRuntime /
  // applyChatRuntime) so the surface can restore per-chat model/effort on switch —
  // the frontend reads `metadata.runtime`. Dropping it (the old `metadata: {}`)
  // meant the sticky runtime never reached the client, so every chat switch fell
  // back to the configured default and per-chat model was never remembered.
  const executionState = (issue.executionState as Record<string, unknown> | null) ?? null;
  const runtime =
    executionState && typeof executionState === "object" ? executionState[RUNTIME_METADATA_KEY] : null;
  return {
    session_id: issue.id,
    title: issue.title,
    created_at: epochSeconds(issue.createdAt),
    updated_at: epochSeconds(issue.updatedAt),
    // System entries (runtime-switch handoff notes, legacy `system_notice`
    // operational comments) stay in the DB — the wake path still replays them
    // into a fresh native session for continuity — but they are NOT part of the
    // visible conversation, so the projection drops them for every surface at
    // the single source instead of each client filtering its own copy.
    messages: comments.map(toBackendChatMessage).filter((message) => message.role !== "system"),
    metadata: (runtime && typeof runtime === "object"
      ? { [RUNTIME_METADATA_KEY]: runtime }
      : {}) as Record<string, unknown>,
    // Workspace grouping = the issue's project (B2 mapping: the sidebar
    // workspace_id IS the project id); null for a flat personal chat with no
    // project. Repo/trust details project from the project's primary workspace
    // in the workspace slice.
    workspace_id: issue.projectId ?? null,
    archived: issue.hiddenAt != null,
    // Sidebar pin: pinned sessions float to the "Pinned" zone ordered by
    // pinned_at (epoch seconds); null = not pinned. Stored in chat_sidebar_pins.
    pinned: pinnedAt !== null,
    pinned_at: pinnedAt,
  };
}

export interface ListChatSessionsOptions {
  includeArchived?: boolean;
}

export function chatCompatService(db: Db) {
  /** One batched query → grouped by issue, never a per-issue comment query. */
  async function commentsByIssue(issueIds: string[]): Promise<Map<string, ChatCommentRow[]>> {
    const grouped = new Map<string, ChatCommentRow[]>();
    if (issueIds.length === 0) return grouped;
    const rows = await db
      .select()
      .from(issueComments)
      .where(and(inArray(issueComments.issueId, issueIds), isNull(issueComments.deletedAt)))
      .orderBy(asc(issueComments.createdAt), asc(issueComments.id));
    for (const row of rows) {
      const bucket = grouped.get(row.issueId);
      if (bucket) bucket.push(row);
      else grouped.set(row.issueId, [row]);
    }
    return grouped;
  }

  return {
    /**
     * Chat sessions for a company — its chat-issues plus each one's turns.
     * Archived (hidden) sessions are excluded unless requested. The host
     * "local" company is chat-dedicated, so every issue in it is a chat session;
     * company-scoped chat markers arrive with the streaming slice.
     */
    async listChatSessions(
      companyId: string,
      options: ListChatSessionsOptions = {},
    ): Promise<{ issue: ChatIssueRow; comments: ChatCommentRow[] }[]> {
      const filters = [
        eq(issues.companyId, companyId),
        eq(issues.originKind, CHAT_SESSION_ORIGIN_KIND),
      ];
      if (!options.includeArchived) filters.push(isNull(issues.hiddenAt));
      const rows = await db
        .select()
        .from(issues)
        .where(and(...filters))
        .orderBy(desc(issues.updatedAt));
      const grouped = await commentsByIssue(rows.map((issue) => issue.id));
      return rows.map((issue) => ({ issue, comments: grouped.get(issue.id) ?? [] }));
    },

    async getChatSession(
      issueId: string,
      opts: { companyId?: string } = {},
    ): Promise<{ issue: ChatIssueRow; comments: ChatCommentRow[] } | null> {
      const filters = [eq(issues.id, issueId)];
      // Scope to the caller's company so a team/company chat id can never be
      // fetched through the personal legacy route.
      if (opts.companyId) filters.push(eq(issues.companyId, opts.companyId));
      const issue = await db
        .select()
        .from(issues)
        .where(and(...filters))
        .then((rows) => rows[0] ?? null);
      // Guard: a non-chat issue is not a chat session — never project it.
      if (!issue || issue.originKind !== CHAT_SESSION_ORIGIN_KIND) return null;
      const comments = await db
        .select()
        .from(issueComments)
        .where(and(eq(issueComments.issueId, issueId), isNull(issueComments.deletedAt)))
        .orderBy(asc(issueComments.createdAt), asc(issueComments.id));
      return { issue, comments };
    },
  };
}

export type ChatCompatService = ReturnType<typeof chatCompatService>;

export interface ChatWorkspaceInfo {
  workspace_id: string;
  name: string;
  kind: string;
  trust_status: string;
  is_trusted: boolean;
  trust_source: string;
  repo_path: string;
  company_profile_id: string;
  builtin_chat: boolean;
  containment_preset: string;
  effective_containment: string;
  session_count: number;
  pinned: boolean;
  pinned_at: number | null;
}

/**
 * §6.5 display contract: the surface renders trust/containment/grouping from
 * this projection and never derives semantics itself, so every field the
 * SuperClaw `ui_contracts.workspace_projection` declares must be present and
 * honest — not silently dropped, and never an enum value the kernel doesn't
 * emit. trust/containment are SuperClaw governance concepts Paperclip has no
 * native column for; under this single-operator-local surface they project to
 * the kernel's own enum values (never a surface-invented one). trust_status is
 * `active` (trusted by construction; a non-`active` value would make the surface
 * render a trust barrier) and containment is `standard` (Python's
 * `_workspace_risk_floor` only floors remote/untrusted-source workspaces, which
 * this surface cannot produce). trust_source reflects HOW the workspace exists:
 * a folder-only project is an app-owned scratch dir → `managed` (models.py:
 * MANAGED = "app-owned scratch/checkout dir, trusted by construction"); a project
 * with a real cwd (a user-attached path) is NOT app-owned scratch, so it reports
 * `api` (established via the API surface) — labelling a user path `managed` would
 * be a contract lie. These are deliberate constants for the local context, NOT a
 * claim that Node enforces trust — governance stays the Python kernel single
 * source. ⚠️ This projection is ONLY sound for the local chat company; a real
 * company/team workspace inventory MUST derive trust/containment from governed
 * state, never reuse these construction-trusted constants. Shared by the
 * inventory and the create response so a freshly created workspace serializes
 * identically.
 */
function projectToChatWorkspaceInfo(
  companyId: string,
  id: string,
  name: string,
  repoPath: string,
  sessionCount: number,
  pinnedAt: number | null = null,
): ChatWorkspaceInfo {
  return {
    workspace_id: id,
    name,
    kind: "project",
    trust_status: "active",
    is_trusted: true,
    trust_source: repoPath ? "api" : "managed",
    repo_path: repoPath,
    company_profile_id: companyId,
    builtin_chat: false,
    containment_preset: "standard",
    effective_containment: "standard",
    session_count: sessionCount,
    pinned: pinnedAt !== null,
    pinned_at: pinnedAt,
  };
}

/**
 * Stable sentinel id for the built-in Chat home workspace. Fixed + zero-heavy so
 * it can never collide with a real (random UUID) project. It is a display-only
 * affordance, not a DB project: chats live under it as "Chats (no project)".
 */
export const CHAT_BUILTIN_WORKSPACE_ID = "00000000-c4a7-4000-a000-0000000000c8";

/**
 * The built-in Chat home — a synthetic, always-present workspace the inventory
 * leads with so the sidebar ALWAYS renders the grouped Projects/Chats structure
 * (the surface switches to the grouped layout once the inventory is non-empty;
 * the built-in Chat home is what guarantees that even with zero real projects).
 * `builtin_chat: true` makes the surface treat it as the flat "Chats" section
 * (never a project group) and hide project CRUD on it. session_count is the
 * number of unassigned (no-project) chats it hosts.
 */
function builtinChatWorkspaceInfo(companyId: string, sessionCount: number): ChatWorkspaceInfo {
  return {
    workspace_id: CHAT_BUILTIN_WORKSPACE_ID,
    name: "Chat",
    kind: "managed",
    trust_status: "active",
    is_trusted: true,
    trust_source: "managed",
    repo_path: "",
    company_profile_id: companyId,
    builtin_chat: true,
    containment_preset: "standard",
    effective_containment: "standard",
    session_count: sessionCount,
    pinned: false,
    pinned_at: null,
  };
}

/**
 * Inventory to serve BEFORE the local chat company is lazily created (first chat
 * turn). No projects can exist yet, but the built-in Chat home must still be
 * present so the sidebar's grouped Projects/Chats structure is persistent on a
 * brand-new instance — not just one that already has a chat. Once the company is
 * bootstrapped, buildChatWorkspaceInventory takes over (also leading with the
 * built-in Chat home), so the two paths agree.
 */
export function builtinOnlyChatWorkspaceInventory(): {
  count: number;
  workspaces: ChatWorkspaceInfo[];
  unassigned_session_count: number;
} {
  return {
    count: 1,
    workspaces: [builtinChatWorkspaceInfo(LOCAL_CHAT_COMPANY_ID, 0)],
    unassigned_session_count: 0,
  };
}

/**
 * Sidebar workspace inventory (B2: a workspace IS a project). Each project in
 * the company projects to a `WorkspaceInfo` with repo/trust from its primary
 * project-workspace; ungrouped chats stay in the frontend's flat "Chats" list
 * via `unassigned_session_count` rather than a synthetic workspace. Local
 * single-operator workspaces are trusted by construction.
 */
export async function buildChatWorkspaceInventory(
  db: Db,
  companyId: string,
): Promise<{ count: number; workspaces: ChatWorkspaceInfo[]; unassigned_session_count: number }> {
  const projectRows = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(eq(projects.companyId, companyId))
    .orderBy(asc(projects.createdAt), asc(projects.id));

  const primaryWorkspaces = await db
    .select({ projectId: projectWorkspaces.projectId, cwd: projectWorkspaces.cwd })
    .from(projectWorkspaces)
    .where(
      and(eq(projectWorkspaces.companyId, companyId), eq(projectWorkspaces.isPrimary, true)),
    );
  const cwdByProject = new Map(primaryWorkspaces.map((row) => [row.projectId, row.cwd ?? ""]));

  const chatIssues = await db
    .select({ projectId: issues.projectId })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        eq(issues.originKind, CHAT_SESSION_ORIGIN_KIND),
        isNull(issues.hiddenAt),
      ),
    );
  const countByProject = new Map<string, number>();
  let unassigned = 0;
  for (const issue of chatIssues) {
    if (issue.projectId === null) unassigned += 1;
    else countByProject.set(issue.projectId, (countByProject.get(issue.projectId) ?? 0) + 1);
  }

  const pins = await readChatPins(db, companyId, "workspace");
  // Lead with the always-present built-in Chat home so the surface renders the
  // grouped Projects/Chats structure even with zero real projects (persistent
  // categories); real projects follow.
  const workspaces: ChatWorkspaceInfo[] = [
    builtinChatWorkspaceInfo(companyId, unassigned),
    ...projectRows.map((project) =>
      projectToChatWorkspaceInfo(
        companyId,
        project.id,
        project.name,
        cwdByProject.get(project.id) ?? "",
        countByProject.get(project.id) ?? 0,
        pins.get(project.id) ?? null,
      ),
    ),
  ];

  return { count: workspaces.length, workspaces, unassigned_session_count: unassigned };
}

/**
 * Create a chat workspace (B2: a workspace IS a Paperclip project) under the
 * local chat company. The frontend's request format is preserved; this adapts
 * it to Paperclip's native project service rather than reimplementing storage.
 * Folder-only (no attachRepo) creates a bare project — chat then runs from the
 * agent home. attachRepo creates a primary project-workspace at that path so
 * the inventory carries a repo_path and chat executes there. No SuperClaw trust
 * gate is layered on: per the owner's calibration the Paperclip base is the
 * trusted substrate and hard gates are reserved for payment + outbound
 * scanning, neither of which a local-folder create is; Paperclip's own
 * workspace validation still applies.
 */
export async function createChatWorkspace(
  db: Db,
  input: { name: string; attachRepo?: string | null },
): Promise<ChatWorkspaceInfo> {
  const companyId = await ensureLocalChatCompany(db);
  const svc = projectService(db);
  const project = await svc.create(companyId, { name: input.name });
  let repoPath = "";
  const attach = (input.attachRepo ?? "").trim();
  if (attach) {
    // The project is already persisted; if attaching the workspace fails we must
    // not leave a phantom repo-less project behind. `createWorkspace` returns null
    // on a rejected cwd (NOT a silent folder-only fallback when a repo WAS asked
    // for), so treat null and throws alike as failure: compensate by removing the
    // just-created project, then surface the error.
    let workspace: Awaited<ReturnType<typeof svc.createWorkspace>>;
    try {
      workspace = await svc.createWorkspace(project.id, { cwd: attach, isPrimary: true });
    } catch (err) {
      await svc.remove(project.id);
      throw err;
    }
    if (!workspace) {
      await svc.remove(project.id);
      throw new Error("Could not attach the workspace folder.");
    }
    repoPath = workspace.cwd ?? "";
  }
  return projectToChatWorkspaceInfo(companyId, project.id, project.name, repoPath, 0);
}

/**
 * Rename a chat workspace. Delegates to the native project update, scoped to the
 * local chat company so a stray id can't rename another company's project.
 * Returns false when the project is missing or owned by a different company.
 */
export async function renameChatWorkspace(
  db: Db,
  workspaceId: string,
  name: string,
  opts: { companyId: string },
): Promise<boolean> {
  const svc = projectService(db);
  const existing = await svc.getById(workspaceId);
  if (!existing || existing.companyId !== opts.companyId) return false;
  const updated = await svc.update(workspaceId, { name });
  return updated !== null;
}

/**
 * Delete a chat workspace WITHOUT losing the user's chats. `issues.projectId` is
 * RESTRICT (no cascade), so this project's chat sessions are reassigned to
 * unassigned first (they survive in the flat "Chat" list) before the project is
 * hard-deleted; project_workspaces / memberships / goals cascade.
 *
 * The cost/finance ledgers (`cost_events.projectId` / `finance_events.projectId`)
 * are ALSO RESTRICT and accrue on every billed agent run (heartbeat stamps the
 * project id onto each cost event). They were the real blocker: any workspace
 * that had ever run an agent kept ledger rows pinning the project, so the delete
 * always raised a foreign-key violation and the group could never be removed. We
 * cannot drop those rows (they are an append-only audit trail), so we DETACH them
 * — set `projectId = null`, mirroring the `issues` reassignment — before deleting
 * the project. The ledger totals stay intact; they simply stop pointing at a
 * project that no longer exists.
 *
 * The reassign + detach + delete run in ONE transaction: if some other RESTRICT
 * child still blocks the delete, the whole thing rolls back so the caller gets a
 * clean failure instead of a half-detached project. Returns false when the
 * project is missing or owned by a different company.
 *
 * Reassigning a session changes its execution boundary (the project's workspace
 * cwd → agent home), so each affected session's adapter resume handle
 * (`agentTaskSessions`, keyed by issue id) is dropped in the same transaction —
 * mirroring `moveChatSession`, so the next turn never resumes the old native
 * session in the now-deleted cwd.
 */
export async function deleteChatWorkspace(
  db: Db,
  workspaceId: string,
  opts: { companyId: string },
): Promise<boolean> {
  const svc = projectService(db);
  const existing = await svc.getById(workspaceId);
  if (!existing || existing.companyId !== opts.companyId) return false;
  await db.transaction(async (tx) => {
    const affected = await tx
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.companyId, opts.companyId), eq(issues.projectId, workspaceId)));
    const affectedIds = affected.map((row) => row.id);
    await tx
      .update(issues)
      .set({ projectId: null, projectWorkspaceId: null })
      .where(and(eq(issues.companyId, opts.companyId), eq(issues.projectId, workspaceId)));
    if (affectedIds.length > 0) {
      await tx
        .delete(agentTaskSessions)
        .where(
          and(
            eq(agentTaskSessions.companyId, opts.companyId),
            inArray(agentTaskSessions.taskKey, affectedIds),
          ),
        );
    }
    // Detach the RESTRICT cost/finance ledgers (preserve the audit rows, just
    // null out the project pointer) so they don't block the project delete.
    await tx
      .update(costEvents)
      .set({ projectId: null })
      .where(and(eq(costEvents.companyId, opts.companyId), eq(costEvents.projectId, workspaceId)));
    await tx
      .update(financeEvents)
      .set({ projectId: null })
      .where(
        and(eq(financeEvents.companyId, opts.companyId), eq(financeEvents.projectId, workspaceId)),
      );
    await tx
      .delete(projects)
      .where(and(eq(projects.id, workspaceId), eq(projects.companyId, opts.companyId)));
  });
  // The project is gone, so drop its (now-dangling) sidebar pin. This is strictly
  // best-effort and runs OUTSIDE the (already-committed) delete transaction: a
  // stale pin is harmless (the inventory only projects pins for existing
  // projects), so a cleanup failure must never turn a successful delete into a
  // 409. Swallow rather than reject after the project is already gone.
  try {
    await setChatPin(db, opts.companyId, "workspace", workspaceId, false);
  } catch {
    // intentionally ignored — see above; the dangling pin is never surfaced.
  }
  return true;
}
