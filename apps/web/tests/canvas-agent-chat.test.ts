import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeFrame, streamAgentConversation, type AgentChatFrame } from '../src/canvasAgentChat';

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
