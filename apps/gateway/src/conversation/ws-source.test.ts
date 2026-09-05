import { describe, expect, it, vi } from 'vitest';
import { openCompanyEventSource, toCompanyEventsWsUrl, type WebSocketLike } from './ws-source.js';
import type { LiveEventFrame } from './run-stream.js';

class FakeWs implements WebSocketLike {
  closed = false;
  private listeners: Record<string, Array<(ev?: any) => void>> = {};
  addEventListener(type: string, cb: (ev?: any) => void): void {
    (this.listeners[type] ??= []).push(cb);
  }
  emitMessage(data: unknown): void {
    for (const cb of this.listeners.message ?? []) cb({ data });
  }
  emitClose(): void {
    for (const cb of this.listeners.close ?? []) cb();
  }
  close(): void {
    this.closed = true;
  }
}

async function collect(src: AsyncIterable<LiveEventFrame>): Promise<LiveEventFrame[]> {
  const out: LiveEventFrame[] = [];
  for await (const e of src) out.push(e);
  return out;
}

describe('toCompanyEventsWsUrl', () => {
  it('maps http→ws / https→wss and appends the events path', () => {
    expect(toCompanyEventsWsUrl('http://127.0.0.1:3100', 'co-1')).toBe('ws://127.0.0.1:3100/api/companies/co-1/events/ws');
    expect(toCompanyEventsWsUrl('https://127.0.0.1:3100/', 'co 1')).toBe('wss://127.0.0.1:3100/api/companies/co%201/events/ws');
  });
});

describe('openCompanyEventSource', () => {
  it('connects synchronously on open (subscribe-before-wake), before any iteration', () => {
    const factory = vi.fn(() => new FakeWs());
    openCompanyEventSource('http://127.0.0.1:3100', 'co-1', { webSocketFactory: factory });
    expect(factory).toHaveBeenCalledTimes(1); // connected without awaiting the iterator
  });

  it('buffers JSON frames from connect and yields them; ignores non-JSON / non-string', async () => {
    const fake = new FakeWs();
    const src = openCompanyEventSource('http://127.0.0.1:3100', 'co-1', { webSocketFactory: () => fake });
    fake.emitMessage(JSON.stringify({ type: 'heartbeat.run.log', payload: { runId: 'r-1' } }));
    fake.emitMessage('not json{');
    fake.emitMessage(123); // non-string
    fake.emitMessage(JSON.stringify({ type: 'heartbeat.run.status', payload: { runId: 'r-1', status: 'succeeded' } }));
    fake.emitClose(); // ends the stream
    expect(await collect(src)).toEqual([
      { type: 'heartbeat.run.log', payload: { runId: 'r-1' } },
      { type: 'heartbeat.run.status', payload: { runId: 'r-1', status: 'succeeded' } },
    ]);
  });

  it('a bounded buffer overflow closes the source (never silently drops mid-stream unbounded)', async () => {
    const fake = new FakeWs();
    const src = openCompanyEventSource('http://127.0.0.1:3100', 'co-1', { webSocketFactory: () => fake, bufferCap: 2 });
    fake.emitMessage(JSON.stringify({ type: 'a', payload: {} }));
    fake.emitMessage(JSON.stringify({ type: 'b', payload: {} }));
    fake.emitMessage(JSON.stringify({ type: 'c', payload: {} })); // overflow → close
    expect(fake.closed).toBe(true); // overflow tears down the underlying socket (no leak)
    const out = await collect(src);
    expect(out.map((e) => e.type)).toEqual(['a', 'b']); // buffered up to the cap, then ended
  });

  it('close() closes the underlying socket and ends iteration', async () => {
    const fake = new FakeWs();
    const src = openCompanyEventSource('http://127.0.0.1:3100', 'co-1', { webSocketFactory: () => fake });
    src.close();
    expect(fake.closed).toBe(true);
    expect(await collect(src)).toEqual([]);
  });

  it('a factory that throws → an immediately-closed empty source (never throws)', async () => {
    const src = openCompanyEventSource('http://127.0.0.1:3100', 'co-1', {
      webSocketFactory: () => {
        throw new Error('connect refused');
      },
    });
    expect(await collect(src)).toEqual([]);
  });
});
