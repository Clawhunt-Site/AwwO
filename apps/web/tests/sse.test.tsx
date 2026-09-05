import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchSse, readSseFrames } from '../src/sse';

afterEach(() => vi.restoreAllMocks());

// A fake ReadableStream over a list of byte chunks, with a spy on cancel() so we
// can assert the reader is always torn down.
function streamFrom(chunks: string[]) {
  const enc = new TextEncoder();
  let i = 0;
  const cancel = vi.fn(async () => {});
  const stream = {
    getReader() {
      return {
        async read() {
          if (i < chunks.length) return { done: false, value: enc.encode(chunks[i++]) };
          return { done: true, value: undefined };
        },
        cancel,
      };
    },
  } as unknown as ReadableStream<Uint8Array>;
  return { stream, cancel };
}

describe('readSseFrames', () => {
  it('parses event/data frames and invokes onEvent with parsed JSON', async () => {
    const { stream } = streamFrom([
      'id: 1\nevent: reasoning.delta\ndata: {"payload":{"text":"hi"}}\n\n',
      'event: tool.started\ndata: {"payload":{"call_id":"c1"}}\n\n',
    ]);
    const events: Array<[string, any]> = [];
    await readSseFrames(stream, (e, d) => events.push([e, d]));
    expect(events).toEqual([
      ['reasoning.delta', { payload: { text: 'hi' } }],
      ['tool.started', { payload: { call_id: 'c1' } }],
    ]);
  });

  it('handles a frame split across chunks', async () => {
    const { stream } = streamFrom(['event: x\nda', 'ta: {"a":1}\n\n']);
    const events: Array<[string, any]> = [];
    await readSseFrames(stream, (e, d) => events.push([e, d]));
    expect(events).toEqual([['x', { a: 1 }]]);
  });

  it('ALWAYS cancels the reader (no leaked reader), even on parse-free completion', async () => {
    const { stream, cancel } = streamFrom(['event: x\ndata: {"a":1}\n\n']);
    await readSseFrames(stream, () => {});
    expect(cancel).toHaveBeenCalled();
  });

  it('cancels the reader even when onEvent throws', async () => {
    const { stream, cancel } = streamFrom(['event: x\ndata: {"a":1}\n\n']);
    await expect(
      readSseFrames(stream, () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(cancel).toHaveBeenCalled(); // finally still ran
  });

  // Against a REAL ReadableStream — proves the lock is genuinely released
  // (cancel() alone leaves stream.locked === true; releaseLock() clears it).
  function realStream(frame: string) {
    return new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(frame));
        c.close();
      },
    });
  }

  it('releases the lock (stream.locked === false) after normal completion', async () => {
    const stream = realStream('event: x\ndata: {"a":1}\n\n');
    await readSseFrames(stream, () => {});
    expect(stream.locked).toBe(false);
  });

  it('releases the lock even when onEvent throws (real stream)', async () => {
    const stream = realStream('event: x\ndata: {"a":1}\n\n');
    await expect(
      readSseFrames(stream, () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(stream.locked).toBe(false);
  });
});

describe('fetchSse', () => {
  it('sends the control token in the HEADER (never the URL) and streams frames', async () => {
    const { stream } = streamFrom(['event: ping\ndata: {"ok":true}\n\n']);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      body: stream,
    } as unknown as Response);

    const events: Array<[string, any]> = [];
    await fetchSse('/api/runs/run_1/events', {
      headers: { 'X-SuperClaw-Token': 'secret' },
      onEvent: (e, d) => events.push([e, d]),
    });

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('/api/runs/run_1/events');
    expect(String(url)).not.toContain('secret'); // token NOT in the URL
    expect((init as RequestInit).headers).toEqual({ 'X-SuperClaw-Token': 'secret' });
    expect(events).toEqual([['ping', { ok: true }]]);
  });

  it('passes the abort signal through to fetch', async () => {
    const { stream } = streamFrom([]);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, body: stream } as unknown as Response);
    const controller = new AbortController();
    await fetchSse('/api/runs/run_1/events', { signal: controller.signal, onEvent: () => {} });
    expect((fetchSpy.mock.calls[0][1] as RequestInit).signal).toBe(controller.signal);
  });

  it('throws on a non-ok response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 404, body: null } as unknown as Response);
    await expect(fetchSse('/api/runs/run_1/events', { onEvent: () => {} })).rejects.toThrow('404');
  });
});
