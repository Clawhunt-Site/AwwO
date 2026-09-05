import { describe, expect, it, vi } from 'vitest';
import { ConversationIndexStore, CONVERSATION_LABEL } from './index-store.js';

const json = (body: unknown, ok = true, status = 200) =>
  ({ ok, status, json: async () => body }) as unknown as Response;

function store(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  // `RequestInfo` is not in this package's TS lib (Node types only), so the input is typed
  // structurally — String() is all the handler needs from it.
  const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) =>
    handler(String(input), init),
  );
  return { s: new ConversationIndexStore({ upstreamBaseUrl: 'http://up', fetchImpl: fetchImpl as any }), fetchImpl };
}

describe('P3f — ConversationIndexStore', () => {
  it('reuses an existing conversation label instead of creating a second one', async () => {
    const { s, fetchImpl } = store((url, init) => {
      if (url.endsWith('/labels') && init?.method !== 'POST') {
        return json([{ id: 'lab-1', name: CONVERSATION_LABEL }, { id: 'other', name: 'bug' }]);
      }
      throw new Error(`unexpected ${init?.method ?? 'GET'} ${url}`);
    });
    expect(await s.ensureConversationLabel('co-1')).toBe('lab-1');
    // Second call is served from cache — no extra round trip per conversation turn.
    expect(await s.ensureConversationLabel('co-1')).toBe('lab-1');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('creates the label on first use', async () => {
    const { s } = store((url, init) => {
      if (url.endsWith('/labels') && init?.method === 'POST') return json({ id: 'lab-new' }, true, 201);
      if (url.endsWith('/labels')) return json([]);
      throw new Error(`unexpected ${url}`);
    });
    expect(await s.ensureConversationLabel('co-1')).toBe('lab-new');
  });

  it('recovers the winner when a concurrent create loses the unique-index race', async () => {
    // labels_company_name_idx makes a racing insert a hard error, not a no-op, so losing the
    // race must re-read rather than give up (which would leave the thread unindexed forever).
    let created = false;
    const { s } = store((url, init) => {
      if (url.endsWith('/labels') && init?.method === 'POST') {
        created = true;
        return json({ error: 'duplicate' }, false, 500);
      }
      if (url.endsWith('/labels')) return json(created ? [{ id: 'lab-race', name: CONVERSATION_LABEL }] : []);
      throw new Error(`unexpected ${url}`);
    });
    expect(await s.ensureConversationLabel('co-1')).toBe('lab-race');
  });

  it('degrades to null (never throws) so a message is never lost to indexing', async () => {
    const { s } = store(() => json(null, false, 0));
    await expect(s.ensureConversationLabel('co-1')).resolves.toBeNull();
  });

  it('lists the company-wide index newest-first, filtered server-side by the label', async () => {
    let issuesUrl = '';
    const { s } = store((url) => {
      if (url.endsWith('/labels')) return json([{ id: 'lab-1', name: CONVERSATION_LABEL }]);
      if (url.includes('/issues?')) {
        issuesUrl = url;
        return json([
          { id: 'i-2', title: '对话 · b', assigneeAgentId: 'ag-2', status: 'todo', updatedAt: '2026-07-20T02:00:00Z' },
          { id: 'i-1', title: '对话 · a', assigneeAgentId: 'ag-1', status: 'done', updatedAt: '2026-07-20T01:00:00Z' },
          { title: 'no id — dropped' },
        ]);
      }
      throw new Error(`unexpected ${url}`);
    });
    const list = await s.listConversations('co-1');
    expect(list.map((c) => c.issueId)).toEqual(['i-2', 'i-1']);
    expect(list[0]).toMatchObject({ agentId: 'ag-2', status: 'todo' });
    expect(issuesUrl).toContain('labelId=lab-1');
    expect(issuesUrl).toContain('sortDir=desc');
  });

  it('a company that never talked has no label — a REAL empty index, not an error', async () => {
    const { s } = store((url) => (url.endsWith('/labels') ? json([]) : json([])));
    await expect(s.listConversations('co-1')).resolves.toEqual([]);
  });

  it('THROWS when the index read fails — an empty list would fake "never talked"', async () => {
    const { s } = store((url) => {
      if (url.endsWith('/labels')) return json([{ id: 'lab-1', name: CONVERSATION_LABEL }]);
      return json(null, false, 500);
    });
    await expect(s.listConversations('co-1')).rejects.toThrow(/upstream 500/);
  });

  it('prepends the exact first user turn and pages every comment oldest-first', async () => {
    const commentsUrls: string[] = [];
    const firstPage = Array.from({ length: 200 }, (_, index) => ({ id: `c${index + 1}`, body: `message ${index + 1}` }));
    const { s } = store((url) => {
      if (url.endsWith('/api/issues/i-1')) {
        return json({ id: 'i-1', companyId: 'co-1', description: 'first prompt' });
      }
      commentsUrls.push(url);
      if (!url.includes('after=')) return json(firstPage);
      if (url.includes('after=c200')) return json([{ id: 'c201', body: 'latest reply' }]);
      return json([]);
    });
    const messages = await s.listMessages('co-1', 'i-1', 201);
    expect(messages).toHaveLength(202);
    expect(messages[0]).toMatchObject({ body: 'first prompt', source: 'issue_description' });
    expect(messages.at(-1)).toEqual({ id: 'c201', body: 'latest reply' });
    expect(commentsUrls[0]).toContain('order=asc&limit=200');
    expect(commentsUrls[1]).toContain('order=asc&limit=1&after=c200');
    expect(commentsUrls[2]).toContain('order=asc&limit=1&after=c201');
  });

  it('refuses an over-limit transcript instead of presenting an incomplete history as loaded', async () => {
    const { s } = store((url) => {
      if (url.endsWith('/api/issues/i-1')) return json({ id: 'i-1', companyId: 'co-1', description: 'first' });
      if (url.includes('after=c2')) return json([{ id: 'c3', body: 'newest omitted turn' }]);
      return json([{ id: 'c1', body: 'one' }, { id: 'c2', body: 'two' }]);
    });
    await expect(s.listMessages('co-1', 'i-1', 2)).rejects.toThrow(/exceeds the 2-comment recovery limit/);
  });

  it('rejects a cross-company transcript identity before reading comments', async () => {
    const { s, fetchImpl } = store((url) => {
      if (url.endsWith('/api/issues/i-1')) return json({ id: 'i-1', companyId: 'other-company', description: 'private' });
      throw new Error(`unexpected ${url}`);
    });
    await expect(s.listMessages('co-1', 'i-1')).rejects.toThrow(/identity mismatch/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
