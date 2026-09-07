import { canvasFetch } from './saas/canvasBridge';
// P3d part 3 — apps/web client for a REAL per-agent conversation, streamed from
// the gateway BFF (which orchestrates the zero-server issue+wake+WS pipeline).
//
// POST /gateway-api/conversations/:companyId/agents/:agentId/messages returns an
// SSE stream of honest frames. The /gateway-api front door injects the gateway
// control token (same as mission planning) — the client never handles the token.
// Fail-soft: any transport failure yields a single 'error' frame, never a throw.
import { readSseFrames } from './sse';

export type AgentChatFrame =
  // The turn landed on the agent's dedicated issue and the wake fired.
  | { event: 'accepted'; issueId: string; runId: string | null; runVisible: boolean; operationId?: string }
  | { event: 'delta'; text: string } // a chunk of the agent's textual output
  | { event: 'phase'; phase: string; message: string | null } // progress note
  | { event: 'status'; status: string } // run status transition
  | { event: 'done'; status: string } // the run ended
  // Message delivered + agent woken, but no live run surfaced (honest, not a fake reply).
  | { event: 'no_run'; issueId: string; detail: string }
  | { event: 'error'; detail: string; code?: string };

function s(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Normalize a raw SSE frame object into a typed AgentChatFrame. An unknown or
 *  garbled frame collapses to an 'error' frame — never silently dropped or
 *  mistyped (the panel must render only honest, recognized states). */
export function normalizeFrame(data: unknown): AgentChatFrame {
  const d = (data ?? {}) as Record<string, unknown>;
  switch (s(d.event)) {
    case 'accepted':
      return { event: 'accepted', issueId: s(d.issueId), runId: typeof d.runId === 'string' ? d.runId : null, runVisible: d.runVisible === true,
        ...(s(d.operationId) ? { operationId: s(d.operationId) } : {}) };
    case 'delta':
      return { event: 'delta', text: s(d.text) };
    case 'phase':
      return { event: 'phase', phase: s(d.phase), message: typeof d.message === 'string' ? d.message : null };
    case 'status':
      return { event: 'status', status: s(d.status) };
    case 'done':
      return { event: 'done', status: s(d.status) };
    case 'no_run':
      return { event: 'no_run', issueId: s(d.issueId), detail: s(d.detail) };
    case 'error':
      return { event: 'error', detail: s(d.detail) || 'unknown error', ...(s(d.code) ? { code: s(d.code) } : {}) };
    default:
      return { event: 'error', detail: `unrecognized frame: ${s(d.event) || '(none)'}` };
  }
}

export interface StreamOpts {
  nodeId?: string;
  /** Reuse the agent's dedicated conversation issue (continuity across turns). */
  issueId?: string;
  /** Stable identity for exactly one upstream mutation, persisted before POST. */
  operationId?: string;
  signal?: AbortSignal;
}

async function responseFailure(res: Response): Promise<{ detail: string; code?: string }> {
  const failure = typeof res.json === 'function'
    ? await res.json().catch(() => null) as Record<string, unknown> | null
    : null;
  return {
    detail: s(failure?.detail) || s(failure?.error) || `gateway responded ${res.status}`,
    ...(s(failure?.error) ? { code: s(failure?.error) } : {}),
  };
}

/** Persist an operation identity without sending or waking an Agent. */
export async function prepareConversationOperation(
  gatewayBase: string,
  companyId: string,
  agentId: string,
  operationId: string,
  message: string,
  issueId?: string,
  signal?: AbortSignal,
): Promise<Response> {
  const base = (gatewayBase || '').replace(/\/+$/, '');
  const parts = [companyId, 'agents', agentId, 'operations', operationId, 'prepare'].map(encodeURIComponent).join('/');
  return canvasFetch(`${base}/conversations/${parts}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ message, ...(issueId ? { issueId } : {}) }),
    signal,
  });
}

/** Stream one conversation turn with a SPECIFIC hired agent. Never throws — a
 *  transport failure or abort yields a single honest 'error' frame. Frames are
 *  delivered in order via onFrame. */
export async function streamAgentConversation(
  gatewayBase: string,
  companyId: string,
  agentId: string,
  message: string,
  onFrame: (frame: AgentChatFrame) => void,
  opts: StreamOpts = {},
): Promise<void> {
  const base = (gatewayBase || '').replace(/\/+$/, '');
  const url = `${base}/conversations/${encodeURIComponent(companyId)}/agents/${encodeURIComponent(agentId)}/messages`;
  let res: Response;
  let operationPrepared = !opts.operationId;
  try {
    if (opts.operationId) {
      const prepared = await prepareConversationOperation(
        base, companyId, agentId, opts.operationId, message, opts.issueId, opts.signal,
      );
      if (!prepared.ok) {
        const failure = await responseFailure(prepared);
        onFrame({ event: 'error', detail: failure.detail, code: 'operation_prepare_failed' });
        return;
      }
      operationPrepared = true;
    }
    res = await canvasFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...(opts.nodeId ? { 'X-Awwo-Node-Id': opts.nodeId } : {}) },
      credentials: 'include',
      body: JSON.stringify({ message, ...(opts.issueId ? { issueId: opts.issueId } : {}), ...(opts.operationId ? { operationId: opts.operationId } : {}) }),
      signal: opts.signal,
    });
  } catch (err) {
    onFrame({
      event: 'error', detail: isAbort(err) ? 'aborted' : 'network error reaching the gateway',
      ...(!operationPrepared ? { code: 'operation_prepare_failed' } : {}),
    });
    return;
  }
  if (!res.ok || !res.body) {
    const failure = await responseFailure(res);
    onFrame({ event: 'error', ...failure });
    return;
  }
  try {
    await readSseFrames(res.body, (_event, data) => onFrame(normalizeFrame(data)));
  } catch (err) {
    onFrame({ event: 'error', detail: isAbort(err) ? 'aborted' : 'stream read error' });
  }
}

export interface ConversationOperationStatus {
  operationId: string;
  state: 'not_started' | 'in_flight' | 'accepted' | 'terminal' | 'rejected' | 'uncertain';
  issueId: string | null;
  runId: string | null;
  terminal: boolean;
  status: string | null;
  output: string;
  outputAvailable: boolean;
  detail: string | null;
}

/** Recover an operation without sending a message, comment, or wake. Throws on an
 * unreadable/invalid response so callers keep the durable run lock. */
export async function fetchConversationOperation(
  gatewayBase: string,
  companyId: string,
  agentId: string,
  operationId: string,
  signal?: AbortSignal,
): Promise<ConversationOperationStatus> {
  const base = gatewayBase.replace(/\/+$/, '');
  const parts = [companyId, 'agents', agentId, 'operations', operationId].map(encodeURIComponent).join('/');
  const response = await canvasFetch(`${base}/conversations/${parts}`, { headers: { Accept: 'application/json' }, credentials: 'include', signal });
  if (!response.ok) throw new Error(`operation recovery responded ${response.status}`);
  const value = await response.json() as Partial<ConversationOperationStatus>;
  if (value.operationId !== operationId || !['not_started', 'in_flight', 'accepted', 'terminal', 'rejected', 'uncertain'].includes(String(value.state))
    || (value.issueId !== null && typeof value.issueId !== 'string') || (value.runId !== null && typeof value.runId !== 'string')
    || typeof value.terminal !== 'boolean' || (value.status !== null && typeof value.status !== 'string')
    || typeof value.output !== 'string' || typeof value.outputAvailable !== 'boolean' || (value.detail !== null && typeof value.detail !== 'string')) {
    throw new Error('invalid operation recovery response');
  }
  return value as ConversationOperationStatus;
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException ? err.name === 'AbortError' : err instanceof Error && err.name === 'AbortError';
}

// ---- P3f: company-wide conversation index -------------------------------------------------
// Conversations were always durable (issue + comments); what was missing was a way to find them
// again, so reopening a chat showed a blank panel as if nothing had ever been said. These read
// the gateway's index (conversation/index-store.ts) so a reopened panel can resume the real
// stored transcript instead of starting over.

/** One past conversation in a company. `agentId` is the assignee it belongs to. */
export interface ConversationSummary {
  issueId: string;
  title: string;
  agentId: string | null;
  updatedAt: string | null;
}

/** A stored transcript turn, normalized from an issue comment. */
export interface StoredMessage {
  role: 'user' | 'agent';
  text: string;
}

/** FAIL-SOFT: null means "could not read the index" — which callers must NOT render as
 *  "no history", because an empty list and an unreachable index look identical to a user. */
export async function fetchConversationIndex(
  gatewayBase: string,
  companyId: string,
  signal?: AbortSignal,
): Promise<ConversationSummary[] | null> {
  try {
    const res = await canvasFetch(`${gatewayBase}/conversations/${encodeURIComponent(companyId)}`, {
      headers: { Accept: 'application/json' },
      credentials: 'include',
      signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { conversations?: unknown };
    if (!Array.isArray(body?.conversations)) return null;
    return body.conversations
      .map((raw): ConversationSummary | null => {
        const d = (raw ?? {}) as Record<string, unknown>;
        const issueId = typeof d.issueId === 'string' ? d.issueId : '';
        if (!issueId) return null;
        return {
          issueId,
          title: typeof d.title === 'string' ? d.title : issueId,
          agentId: typeof d.agentId === 'string' ? d.agentId : null,
          updatedAt: typeof d.updatedAt === 'string' ? d.updatedAt : null,
        };
      })
      .filter((c): c is ConversationSummary => c !== null);
  } catch {
    return null;
  }
}

/** The stored transcript of one conversation, oldest first. null = unreadable (see above). */
export async function fetchConversationMessages(
  gatewayBase: string,
  companyId: string,
  issueId: string,
  signal?: AbortSignal,
): Promise<StoredMessage[] | null> {
  try {
    const res = await canvasFetch(
      `${gatewayBase}/conversations/${encodeURIComponent(companyId)}/issues/${encodeURIComponent(issueId)}/messages`,
      { headers: { Accept: 'application/json' }, credentials: 'include', signal },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { messages?: unknown; complete?: unknown };
    // A bounded server must explicitly attest that no newer tail was omitted.
    // Missing/false metadata stays unreadable instead of replacing live UI with
    // a partial transcript and marking it loaded.
    if (body?.complete !== true || !Array.isArray(body.messages)) return null;
    return body.messages
      .map((raw): StoredMessage | null => {
        const d = (raw ?? {}) as Record<string, unknown>;
        const text = typeof d.body === 'string' ? d.body : typeof d.content === 'string' ? d.content : '';
        if (!text.trim()) return null;
        // An agent-authored comment carries authorAgentId; anything else is the operator's turn.
        const role: StoredMessage['role'] = typeof d.authorAgentId === 'string' && d.authorAgentId ? 'agent' : 'user';
        return { role, text };
      })
      .filter((m): m is StoredMessage => m !== null);
  } catch {
    return null;
  }
}
