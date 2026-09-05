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
  | { event: 'accepted'; issueId: string; runId: string | null; runVisible: boolean }
  | { event: 'delta'; text: string } // a chunk of the agent's textual output
  | { event: 'phase'; phase: string; message: string | null } // progress note
  | { event: 'status'; status: string } // run status transition
  | { event: 'done'; status: string } // the run ended
  // Message delivered + agent woken, but no live run surfaced (honest, not a fake reply).
  | { event: 'no_run'; issueId: string; detail: string }
  | { event: 'error'; detail: string };

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
      return { event: 'accepted', issueId: s(d.issueId), runId: typeof d.runId === 'string' ? d.runId : null, runVisible: d.runVisible === true };
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
      return { event: 'error', detail: s(d.detail) || 'unknown error' };
    default:
      return { event: 'error', detail: `unrecognized frame: ${s(d.event) || '(none)'}` };
  }
}

export interface StreamOpts {
  /** Reuse the agent's dedicated conversation issue (continuity across turns). */
  issueId?: string;
  signal?: AbortSignal;
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
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      credentials: 'include',
      body: JSON.stringify({ message, ...(opts.issueId ? { issueId: opts.issueId } : {}) }),
      signal: opts.signal,
    });
  } catch (err) {
    onFrame({ event: 'error', detail: isAbort(err) ? 'aborted' : 'network error reaching the gateway' });
    return;
  }
  if (!res.ok || !res.body) {
    onFrame({ event: 'error', detail: `gateway responded ${res.status}` });
    return;
  }
  try {
    await readSseFrames(res.body, (_event, data) => onFrame(normalizeFrame(data)));
  } catch (err) {
    onFrame({ event: 'error', detail: isAbort(err) ? 'aborted' : 'stream read error' });
  }
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
    const res = await fetch(`${gatewayBase}/conversations/${encodeURIComponent(companyId)}`, {
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
    const res = await fetch(
      `${gatewayBase}/conversations/${encodeURIComponent(companyId)}/issues/${encodeURIComponent(issueId)}/messages`,
      { headers: { Accept: 'application/json' }, credentials: 'include', signal },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { messages?: unknown };
    if (!Array.isArray(body?.messages)) return null;
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
