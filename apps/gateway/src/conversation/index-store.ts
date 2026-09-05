// P3f — the COMPANY-WIDE conversation index.
//
// Conversations are already durable: the dispatcher stores turn 1 as an issue and every later
// turn as a comment on it (conversation/dispatcher.ts). What was missing is a way to find them
// again. Two gaps had to be closed, and neither needs a change under the vendored server/:
//
//  1. THE DISCRIMINATOR. Nothing marked a conversation issue as one. `originKind` cannot be used:
//     it is absent from the create schema and `validate()` runs `req.body = schema.parse(body)`,
//     so a client-sent value is silently STRIPPED by zod and the column falls to its default
//     'manual' -- the same value ordinary work issues carry. The only other marker was the
//     accidental Chinese title prefix, which is locale-bound and user-editable. So we attach a
//     per-company LABEL: `labelIds` IS an accepted create field, label CRUD is already mounted,
//     and `GET /companies/:id/issues?labelId=` filters server-side.
//
//  2. THE READ ROUTE. The gateway exposed no conversation read path at all, and the control
//     plane's own `GET /chat/sessions` is hard-bound to the single "Personal Chat" company, so
//     it can never serve a company-wide index.

/** Label name that marks an issue as an agent conversation. Namespaced so it cannot collide
 *  with a label an operator would plausibly create by hand. */
export const CONVERSATION_LABEL = 'superclaw:conversation';
const CONVERSATION_LABEL_COLOR = '#6366f1';

type Json = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

export interface IndexStoreDeps {
  upstreamBaseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface ConversationSummary {
  issueId: string;
  title: string;
  agentId: string | null;
  status: string | null;
  updatedAt: string | null;
  createdAt: string | null;
}

/**
 * Reads/writes the conversation index against the control plane.
 *
 * Every method is FAIL-SOFT in the direction that matters: obtaining the label can return null
 * (a turn must never fail to send because indexing metadata could not be written), while the
 * read path throws so a route can answer honestly with 502 instead of an empty list that would
 * read as "this company has never had a conversation".
 */
export class ConversationIndexStore {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  /** companyId -> labelId. Avoids a lookup round trip on every single turn. */
  private readonly labelCache = new Map<string, string>();

  constructor(deps: IndexStoreDeps) {
    this.base = deps.upstreamBaseUrl.replace(/\/+$/, '');
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.timeoutMs = deps.timeoutMs ?? 10_000;
  }

  private async req(path: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.base}${path}`, {
        headers: { Accept: 'application/json', ...(init?.body ? { 'content-type': 'application/json' } : {}) },
        signal: controller.signal,
        redirect: 'manual',
        ...init,
      });
      let parsed: unknown = null;
      try {
        parsed = await res.json();
      } catch {
        parsed = null;
      }
      return { ok: res.ok, status: res.status, body: parsed };
    } catch {
      return { ok: false, status: 0, body: null };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The conversation label id for a company, creating it on first use.
   *
   * Returns null rather than throwing: a failure here must DEGRADE to an unlabelled (and so
   * unindexed) conversation, never block the message. The create path re-reads on failure
   * because the unique index on (company_id, name) makes a concurrent create a hard error
   * rather than a no-op, so losing that race is expected and recoverable.
   */
  async ensureConversationLabel(companyId: string): Promise<string | null> {
    const cached = this.labelCache.get(companyId);
    if (cached) return cached;

    const found = await this.findLabel(companyId);
    if (found) {
      this.labelCache.set(companyId, found);
      return found;
    }
    const created = await this.req(`/api/companies/${encodeURIComponent(companyId)}/labels`, {
      method: 'POST',
      body: JSON.stringify({ name: CONVERSATION_LABEL, color: CONVERSATION_LABEL_COLOR }),
    });
    const id = created.ok ? str((created.body as Json | null)?.id) : null;
    if (id) {
      this.labelCache.set(companyId, id);
      return id;
    }
    // Lost the create race (or it failed): whoever won already wrote the row.
    const after = await this.findLabel(companyId);
    if (after) this.labelCache.set(companyId, after);
    return after;
  }

  private async findLabel(companyId: string): Promise<string | null> {
    const res = await this.req(`/api/companies/${encodeURIComponent(companyId)}/labels`);
    if (!res.ok || !Array.isArray(res.body)) return null;
    for (const raw of res.body as Json[]) {
      if (str(raw?.name) === CONVERSATION_LABEL) return str(raw?.id);
    }
    return null;
  }

  /**
   * Company-wide conversation index, newest first.
   *
   * Throws on an upstream failure so the caller can report it honestly. Returning [] on error
   * would be indistinguishable from "no conversations yet" -- exactly the fake-empty this
   * codebase forbids. A company that has never had a conversation has no label, which is a
   * REAL empty index, so that case returns [] legitimately.
   */
  async listConversations(companyId: string, limit = 100): Promise<ConversationSummary[]> {
    const labelId = await this.findLabel(companyId);
    if (!labelId) return [];
    const q = `labelId=${encodeURIComponent(labelId)}&limit=${encodeURIComponent(String(limit))}&sortField=updated&sortDir=desc`;
    const res = await this.req(`/api/companies/${encodeURIComponent(companyId)}/issues?${q}`);
    if (!res.ok || !Array.isArray(res.body)) {
      throw new Error(res.status === 0 ? 'conversation index: upstream unreachable' : `conversation index: upstream ${res.status}`);
    }
    return (res.body as Json[])
      .map((raw) => {
        const issueId = str(raw?.id);
        if (!issueId) return null;
        return {
          issueId,
          title: str(raw?.title) ?? issueId,
          agentId: str(raw?.assigneeAgentId),
          status: str(raw?.status),
          updatedAt: str(raw?.updatedAt),
          createdAt: str(raw?.createdAt),
        } satisfies ConversationSummary;
      })
      .filter((c): c is ConversationSummary => c !== null);
  }

  /** The stored transcript of one conversation (oldest first), for resuming it in the UI. */
  async listMessages(issueId: string, limit = 200): Promise<Json[]> {
    const res = await this.req(
      `/api/issues/${encodeURIComponent(issueId)}/comments?order=asc&limit=${encodeURIComponent(String(limit))}`,
    );
    if (!res.ok || !Array.isArray(res.body)) {
      throw new Error(res.status === 0 ? 'transcript: upstream unreachable' : `transcript: upstream ${res.status}`);
    }
    return res.body as Json[];
  }
}
