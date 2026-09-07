import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchConversationMessages, normalizeFrame, streamAgentConversation, type AgentChatFrame } from '../src/canvasAgentChat';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('normalizeFrame', () => {
  it('maps each recognized frame type', () => {
    expect(normalizeFrame({ event: 'accepted', issueId: 'i1', runId: 'r1', runVisible: true })).toEqual({ event: 'accepted', issueId: 'i1', runId: 'r1', runVisible: true });
    expect(normalizeFrame({ event: 'accepted', issueId: 'i1', runId: null, runVisible: false })).toMatchObject({ runId: null, runVisible: false });
    expect(normalizeFrame({ event: 'delta', text: 'hi' })).toEqual({ event: 'delta', text: 'hi' });
    expect(normalizeFrame({ event: 'phase', phase: 'implement', message: null })).toEqual({ event: 'phase', phase: 'implement', message: null });
    expect(normalizeFrame({ event: 'status', status: 'running' })).toEqual({ event: 'status', status: 'running' });
    expect(normalizeFrame({ event: 'done', status: 'succeeded' })).toEqual({ event: 'done', status: 'succeeded' });
    expect(normalizeFrame({ event: 'no_run', issueId: 'i1', detail: 'woken' })).toEqual({ event: 'no_run', issueId: 'i1', detail: 'woken' });
    expect(normalizeFrame({ event: 'error', detail: 'boom' })).toEqual({ event: 'error', detail: 'boom' });
  });
  it('collapses an unknown/garbled frame to an honest error (never mistyped)', () => {
    expect(normalizeFrame({ event: 'wat' })).toEqual({ event: 'error', detail: 'unrecognized frame: wat' });
    expect(normalizeFrame({})).toEqual({ event: 'error', detail: 'unrecognized frame: (none)' });
    expect(normalizeFrame(null)).toEqual({ event: 'error', detail: 'unrecognized frame: (none)' });
  });
});

function sseBody(frames: Array<{ event: string; data: unknown }>): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const text = frames.map((f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`).join('');
  return new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode(text));
      controller.close();
    },
  });
}

describe('streamAgentConversation', () => {
  it('POSTs to the gateway conversation endpoint and delivers parsed frames in order', async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        captured = { url: String(url), init };
        return {
          ok: true,
          status: 200,
          body: sseBody([
            { event: 'accepted', data: { event: 'accepted', issueId: 'iss-1', runId: 'r-1', runVisible: true } },
            { event: 'delta', data: { event: 'delta', text: '你好' } },
            { event: 'done', data: { event: 'done', status: 'succeeded' } },
          ]),
        } as unknown as Response;
      }),
    );
    const frames: AgentChatFrame[] = [];
    await streamAgentConversation('/gateway-api', 'co-1', 'ag-1', '在吗', (f) => frames.push(f));
    expect(captured!.url).toBe('/gateway-api/conversations/co-1/agents/ag-1/messages');
    expect(JSON.parse(String(captured!.init.body))).toEqual({ message: '在吗' });
    expect(frames).toEqual([
      { event: 'accepted', issueId: 'iss-1', runId: 'r-1', runVisible: true },
      { event: 'delta', text: '你好' },
      { event: 'done', status: 'succeeded' },
    ]);
  });

  it('reuses the issueId for a continuing turn', async () => {
    let body: any = null;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return { ok: true, status: 200, body: sseBody([{ event: 'done', data: { event: 'done', status: 'succeeded' } }]) } as unknown as Response;
    }));
    await streamAgentConversation('/gateway-api', 'co-1', 'ag-1', 'next', () => {}, { issueId: 'iss-1' });
    expect(body).toEqual({ message: 'next', issueId: 'iss-1' });
  });

  it('durably prepares an operation before opening the streaming request', async () => {
    const operationId = '11111111-1111-4111-8111-111111111111';
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
      if (String(url).endsWith('/prepare')) {
        return new Response(JSON.stringify({ operationId, prepared: true }), { status: 201 });
      }
      return { ok: true, status: 200, body: sseBody([{ event: 'done', data: { event: 'done', status: 'succeeded' } }]) } as unknown as Response;
    }));

    await streamAgentConversation('/gateway-api', 'co-1', 'ag-1', 'next', () => {}, {
      issueId: 'iss-1', operationId,
    });

    expect(calls).toEqual([
      {
        url: `/gateway-api/conversations/co-1/agents/ag-1/operations/${operationId}/prepare`,
        body: { message: 'next', issueId: 'iss-1' },
      },
      {
        url: '/gateway-api/conversations/co-1/agents/ag-1/messages',
        body: { message: 'next', issueId: 'iss-1', operationId },
      },
    ]);
  });

  it('does not open the streaming request when operation preparation fails', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: 'operation_conflict', detail: 'different request' }), { status: 409 }));
    vi.stubGlobal('fetch', fetcher);
    const frames: AgentChatFrame[] = [];

    await streamAgentConversation('/gateway-api', 'co-1', 'ag-1', 'next', frame => frames.push(frame), {
      operationId: '11111111-1111-4111-8111-111111111111',
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(frames).toEqual([{ event: 'error', detail: 'different request', code: 'operation_prepare_failed' }]);
  });

  it('a non-2xx gateway response → a single error frame', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, body: null }) as unknown as Response));
    const frames: AgentChatFrame[] = [];
    await streamAgentConversation('/gateway-api', 'co-1', 'ag-1', 'x', (f) => frames.push(f));
    expect(frames).toEqual([{ event: 'error', detail: 'gateway responded 401' }]);
  });

  it('a network throw → a single honest error frame (never rejects)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
    const frames: AgentChatFrame[] = [];
    await streamAgentConversation('/gateway-api', 'co-1', 'ag-1', 'x', (f) => frames.push(f));
    expect(frames).toEqual([{ event: 'error', detail: 'network error reaching the gateway' }]);
  });
});

describe('fetchConversationMessages', () => {
  it('keeps valid native comment times without inventing times for legacy or invalid messages', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      complete: true, messages: [
        { body: 'native', createdAt: '2026-09-06T11:17:26.820Z' },
        { body: 'legacy' }, { body: 'invalid', createdAt: 'not-a-date' },
      ],
    }))));
    await expect(fetchConversationMessages('/gateway-api', 'company', 'issue')).resolves.toEqual([
      { role: 'user', text: 'native', createdAt: Date.parse('2026-09-06T11:17:26.820Z') },
      { role: 'user', text: 'legacy' }, { role: 'user', text: 'invalid' },
    ]);
  });

  it('restores the issue-description first turn only from an explicitly complete transcript', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      complete: true,
      messages: [
        { body: 'first prompt', source: 'issue_description', authorAgentId: null },
        { body: 'agent reply', authorAgentId: 'agent-1' },
      ],
    }))));

    await expect(fetchConversationMessages('/gateway-api', 'co-1', 'iss-1')).resolves.toEqual([
      { role: 'user', text: 'first prompt', nativeSource: 'issue_description' },
      { role: 'agent', text: 'agent reply' },
    ]);
  });

  it('preserves explicit context provenance without removing an identical real comment or guessing unknown sources', async () => {
    const body = '【工作流节点】会员后台\n完整的输入与输出约束';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ complete: true, messages: [
      { body, source: 'issue_description' },
      { id: 'comment-1', body, source: 'comment' },
      { id: 'comment-2', body, source: 'unknown' },
    ] }))));
    await expect(fetchConversationMessages('/gateway-api', 'company', 'issue')).resolves.toEqual([
      { role: 'user', text: body, nativeSource: 'issue_description' },
      { role: 'user', text: body, nativeCommentId: 'comment-1' },
      { role: 'user', text: body, nativeCommentId: 'comment-2' },
    ]);
  });

  it('keeps a response without completeness proof unreadable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ messages: [{ body: 'old prefix' }] }))));
    await expect(fetchConversationMessages('/gateway-api', 'co-1', 'iss-1')).resolves.toBeNull();
  });
});
