import { describe, expect, it, vi } from 'vitest';
import { UpstreamChatTurnDispatcher } from './fire.js';

function sseResponse(frames: string[]): Response {
  return new Response(frames.map((f) => `${f}\n\n`).join(''), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  return vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as { url: string }).url;
    return handler(url, init ?? {});
  }) as unknown as typeof fetch;
}

describe('UpstreamChatTurnDispatcher.inject', () => {
  it('POSTs to /api/chat/stream and returns ok once it sees chat.started (turn accepted)', async () => {
    let seen: { url: string; body: unknown } | null = null;
    const fetchImpl = fakeFetch((url, init) => {
      seen = { url, body: JSON.parse(String(init.body)) };
      // The upstream emits chat.started AFTER appendUserTurn, immediately before wakeup.
      return sseResponse(['event: chat.started\ndata: {"turn_id":"c1"}']);
    });
    const d = new UpstreamChatTurnDispatcher('http://127.0.0.1:3100/', { fetchImpl });
    const out = await d.inject('chat-issue-1', 'morning digest');
    expect(out).toEqual({ ok: true });
    expect(seen!.url).toBe('http://127.0.0.1:3100/api/chat/stream');
    expect(seen!.body).toEqual({ message: 'morning digest', session_id: 'chat-issue-1' });
  });

  it('does NOT treat a bare 200 as accepted: a stream that ends before chat.started fails', async () => {
    // Regression guard for the cancel-on-200 bug: the old code returned ok here, but the
    // upstream may bail before appendUserTurn — so no chat.started means not injected.
    const fetchImpl = fakeFetch(() => sseResponse(['event: ready\ndata: {}']));
    const d = new UpstreamChatTurnDispatcher('http://127.0.0.1:3100', { fetchImpl });
    const out = await d.inject('chat-issue-1', 'x');
    expect(out.ok).toBe(false);
  });

  it('chat.completed before chat.started is an early failure (no injection)', async () => {
    const fetchImpl = fakeFetch(() => sseResponse(['event: chat.completed\ndata: {"run_id":null}']));
    const d = new UpstreamChatTurnDispatcher('http://127.0.0.1:3100', { fetchImpl });
    const out = await d.inject('chat-issue-1', 'x');
    expect(out.ok).toBe(false);
  });

  it('FAILS when wakeup is skipped after chat.started (turn appended but agent never ran)', async () => {
    // The exact gap Codex flagged: chat.started proves injection, not that the run started.
    const fetchImpl = fakeFetch(() =>
      sseResponse([
        'event: chat.started\ndata: {"run_id":null}',
        'event: chat.completed\ndata: {"run_id":null,"failure_reason":"wakeup_skipped"}',
      ]),
    );
    const d = new UpstreamChatTurnDispatcher('http://127.0.0.1:3100', { fetchImpl });
    const out = await d.inject('chat-issue-1', 'x');
    expect(out.ok).toBe(false);
    expect(out).toMatchObject({ error: expect.stringContaining('wakeup skipped') });
  });

  it('SUCCEEDS when the run produces output (message.delta) after chat.started', async () => {
    const fetchImpl = fakeFetch(() =>
      sseResponse(['event: chat.started\ndata: {}', 'event: message.delta\ndata: {"text":"hi"}']),
    );
    const d = new UpstreamChatTurnDispatcher('http://127.0.0.1:3100', { fetchImpl });
    expect(await d.inject('chat-issue-1', 'x')).toEqual({ ok: true });
  });

  it('SUCCEEDS when wakeup is deferred/queued (chat.completed without wakeup_skipped)', async () => {
    const fetchImpl = fakeFetch(() =>
      sseResponse([
        'event: chat.started\ndata: {}',
        'event: chat.completed\ndata: {"run_id":null,"failure_reason":"wakeup_deferred"}',
      ]),
    );
    const d = new UpstreamChatTurnDispatcher('http://127.0.0.1:3100', { fetchImpl });
    expect(await d.inject('chat-issue-1', 'x')).toEqual({ ok: true });
  });

  it('handles CRLF frame separators (proxy newline normalization)', async () => {
    const body = 'event: chat.started\r\ndata: {}\r\n\r\nevent: message.delta\r\ndata: {}\r\n\r\n';
    const fetchImpl = fakeFetch(() => new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
    const d = new UpstreamChatTurnDispatcher('http://127.0.0.1:3100', { fetchImpl });
    expect(await d.inject('chat-issue-1', 'x')).toEqual({ ok: true });
  });

  it('SUCCEEDS on accept-timeout if the turn was already injected (slow first token, not a skip)', async () => {
    // A stream that emits chat.started then stalls. The accept timeout fires; since the turn
    // was injected (and a real skip arrives fast), this is treated as accepted.
    const fetchImpl = vi.fn((_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('event: chat.started\ndata: {}\n\n'));
          // then never closes; the abort signal will interrupt the next read
          init?.signal?.addEventListener('abort', () => {
            try {
              controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            } catch {
              /* already closed */
            }
          });
        },
      });
      return Promise.resolve(new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
    }) as unknown as typeof fetch;
    const d = new UpstreamChatTurnDispatcher('http://127.0.0.1:3100', { fetchImpl, acceptTimeoutMs: 20 });
    expect(await d.inject('chat-issue-1', 'x')).toEqual({ ok: true });
  });

  it('surfaces a typed failure with the upstream error on non-2xx', async () => {
    const fetchImpl = fakeFetch(
      () =>
        new Response(JSON.stringify({ error: 'Chat session not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    const d = new UpstreamChatTurnDispatcher('http://127.0.0.1:3100', { fetchImpl });
    expect(await d.inject('missing', 'x')).toEqual({ ok: false, status: 404, error: 'Chat session not found' });
  });

  it('reports an accept timeout as a failure (does not hang)', async () => {
    const fetchImpl = vi.fn((_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      });
    }) as unknown as typeof fetch;
    const d = new UpstreamChatTurnDispatcher('http://127.0.0.1:3100', { fetchImpl, acceptTimeoutMs: 10 });
    expect(await d.inject('chat-issue-1', 'x')).toEqual({ ok: false, status: null, error: 'accept timeout' });
  });
});
