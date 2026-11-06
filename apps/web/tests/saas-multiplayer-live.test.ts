import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCanvasLive, newLiveClientId, type CanvasLiveHandlers } from '../src/saas/canvasLive';
import type { CanvasChange } from '../src/canvas/multiplayer/types';

// 多人同屏: one canvas's live connection (src/saas/canvasLive.ts) against a scripted stream.

type Frame = { event: string; data: unknown };

/** A stream the test writes frames into, then ends. */
function scriptedStream() {
  const encoder = new TextEncoder();
  let push: (frame: Frame) => void = () => {};
  let end: () => void = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      push = frame => controller.enqueue(encoder.encode(`event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`));
      end = () => controller.close();
    },
  });
  return { body, push: (frame: Frame) => push(frame), end: () => end() };
}

const participant = (id: string, extra: Record<string, unknown> = {}) => ({
  id, kind: 'human', port: 'web', name: id, color: '#0090ff', state: { selection: [], focus: null, cursor: null, status: null }, since: '2026-11-06T00:00:00Z', ...extra,
});
const change = (version: number): CanvasChange => ({ version, actor: { kind: 'human', name: 'Other', clientId: 'other' }, label: 'edit', ops: [{ op: 'set', path: ['nodes', 'a', 'title'], value: `v${version}` }], at: '' });

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('the live connection', () => {
  it('names each tab by its own id', () => {
    const a = newLiveClientId(), b = newLiveClientId();
    expect(a).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(a).not.toBe(b);
  });

  it('opens from the confirmed version, takes everyone, and hands changes over together', async () => {
    const streams: ReturnType<typeof scriptedStream>[] = [];
    const urls: string[] = [];
    const posts: { url: string; body: unknown }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/live/events')) {
        urls.push(String(url));
        const stream = scriptedStream();
        streams.push(stream);
        return new Response(stream.body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      posts.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
      return new Response(null, { status: 204 });
    }));
    const batches: number[][] = [];
    let version = 7;
    const handlers: CanvasLiveHandlers = { confirmedVersion: () => version, changes: list => { batches.push(list.map(c => c.version)); version = list.at(-1)!.version; }, reset: () => {} };
    const live = createCanvasLive('t1', 'c1', handlers, 'page-one-1');
    live.start();
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    expect(urls[0]).toContain('/api/v1/tenants/t1/canvases/c1/live/events?after=7&client=page-one-1');
    streams[0].push({ event: 'hello', data: { you: participant('page-one-1'), version: 7, participants: [participant('page-one-1'), participant('other')], claims: [], messages: [{ id: 'm2' }, { id: 'm1' }] } });
    await vi.waitFor(() => expect(live.snapshot().status).toBe('live'));
    expect(live.snapshot().participants.map(p => p.id)).toEqual(['page-one-1', 'other']);
    // The newest message last.
    expect(live.snapshot().messages.map(m => m.id)).toEqual(['m1', 'm2']);
    streams[0].push({ event: 'changes', data: change(8) });
    streams[0].push({ event: 'changes', data: change(9) });
    await vi.waitFor(() => expect(batches).toEqual([[8, 9]]));
    // Presence: someone leaves, a claim list, a message.
    streams[0].push({ event: 'presence', data: { left: 'other' } });
    streams[0].push({ event: 'claims', data: { claims: [{ nodeId: 'a', participantId: 't_x', holderKind: 'agent', name: 'Claude Code', note: '', expiresAt: '' }] } });
    streams[0].push({ event: 'message', data: { message: { id: 'm3', text: 'hi' } } });
    await vi.waitFor(() => expect(live.snapshot().messages.map(m => m.id)).toEqual(['m1', 'm2', 'm3']));
    expect(live.snapshot().participants.map(p => p.id)).toEqual(['page-one-1']);
    expect(live.snapshot().claims).toHaveLength(1);
    // A dropped stream connects again, from the version the page holds now.
    streams[0].end();
    await vi.waitFor(() => expect(streams).toHaveLength(2), { timeout: 5000 });
    expect(urls[1]).toContain('after=9');
    live.stop();
    expect(live.snapshot().status).toBe('offline');
  });

  it('sends this page’s state at a pace, and all of it again after every hello', async () => {
    const posts: unknown[] = [];
    const streams: ReturnType<typeof scriptedStream>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/live/events')) { const s = scriptedStream(); streams.push(s); return new Response(s.body, { status: 200 }); }
      posts.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    }));
    const live = createCanvasLive('t1', 'c1', { confirmedVersion: () => 1, changes: () => {}, reset: () => {} }, 'page-two-22');
    live.start();
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    // Alone on the canvas, a page sends nothing: no one would see it.
    streams[0].push({ event: 'hello', data: { you: participant('page-two-22'), version: 1, participants: [participant('page-two-22')], claims: [], messages: [] } });
    live.setPresence({ selection: ['z'] });
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(posts).toHaveLength(0);
    // Someone comes: they are told where this page is, all of it, at once.
    streams[0].push({ event: 'presence', data: { participant: participant('other') } });
    await vi.waitFor(() => expect(posts.length).toBe(1));
    expect((posts[0] as { state: Record<string, unknown> }).state).toMatchObject({ selection: ['z'] });
    live.setPresence({ selection: ['a'] });
    live.setPresence({ selection: ['a', 'b'], cursor: { x: 1, y: 2 } });
    live.setPresence({ cursor: { x: 3, y: 4 } });
    await vi.waitFor(() => expect(posts.length).toBeGreaterThan(1));
    await new Promise(resolve => setTimeout(resolve, 400));
    const sent = posts.slice(1).map(p => (p as { state: Record<string, unknown> }).state);
    // Coalesced: the last selection and pointer, not every one; nothing sent twice that did not change.
    expect(sent.at(-1)).toMatchObject({ selection: ['a', 'b'], cursor: { x: 3, y: 4 } });
    expect(sent.length).toBeLessThanOrEqual(2);
    live.stop();
  });

  it('ends for good when access ends, and says why', async () => {
    const streams: ReturnType<typeof scriptedStream>[] = [];
    vi.stubGlobal('fetch', vi.fn(async () => { const s = scriptedStream(); streams.push(s); return new Response(s.body, { status: 200 }); }));
    const live = createCanvasLive('t1', 'c1', { confirmedVersion: () => 1, changes: () => {}, reset: () => {} }, 'page-three-3');
    live.start();
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    streams[0].push({ event: 'bye', data: { reason: 'access' } });
    streams[0].end();
    await vi.waitFor(() => expect(live.snapshot().ended).toBe('access'));
    expect(live.snapshot().status).toBe('offline');
    await new Promise(resolve => setTimeout(resolve, 1200));
    expect(streams).toHaveLength(1);
  });

  it('stops for a canvas that is gone', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'not_found' } }), { status: 404 })));
    const live = createCanvasLive('t1', 'c1', { confirmedVersion: () => 1, changes: () => {}, reset: () => {} }, 'page-four-4');
    live.start();
    await vi.waitFor(() => expect(live.snapshot().ended).toBe('deleted'));
  });

  it('asks for the changes again after a reset', async () => {
    const streams: ReturnType<typeof scriptedStream>[] = [];
    vi.stubGlobal('fetch', vi.fn(async () => { const s = scriptedStream(); streams.push(s); return new Response(s.body, { status: 200 }); }));
    const resets: number[] = [];
    const live = createCanvasLive('t1', 'c1', { confirmedVersion: () => 1, changes: () => {}, reset: version => resets.push(version) }, 'page-five-5');
    live.start();
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    streams[0].push({ event: 'reset', data: { version: 40 } });
    await vi.waitFor(() => expect(resets).toEqual([40]));
    live.stop();
  });
});
