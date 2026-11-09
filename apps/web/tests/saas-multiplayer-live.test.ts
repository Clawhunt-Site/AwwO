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

describe('the live lane on the connection', () => {
  const started: { stop(): void }[] = [];
  const track = <T extends { stop(): void }>(live: T): T => { started.push(live); return live; };
  afterEach(() => { for (const live of started.splice(0)) live.stop(); });
  function stubbed(answer: (body: { state: Record<string, unknown> }) => Response = () => new Response(null, { status: 204 })) {
    const posts: { at: number; state: Record<string, unknown> }[] = [];
    const streams: ReturnType<typeof scriptedStream>[] = [];
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/live/events')) {
        urls.push(String(url));
        // As a real fetch does, an abort errors the body being read.
        const encoder = new TextEncoder();
        let push: (frame: Frame) => void = () => {};
        let end: () => void = () => {};
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            push = frame => controller.enqueue(encoder.encode(`event: ${frame.event}
data: ${JSON.stringify(frame.data)}

`));
            end = () => { try { controller.close(); } catch { /* errored */ } };
            init?.signal?.addEventListener('abort', () => { try { controller.error(new DOMException('Aborted', 'AbortError')); } catch { /* closed */ } });
          },
        });
        streams.push({ body, push: (frame: Frame) => push(frame), end: () => end() });
        return new Response(body, { status: 200 });
      }
      const body = JSON.parse(String(init?.body));
      posts.push({ at: Date.now(), state: body.state });
      return answer(body);
    }));
    return { posts, streams, urls };
  }
  const hello = (self: string, parts?: string[]) => ({ event: 'hello', data: { you: participant(self), version: 1, participants: [participant(self), participant('other')],
    claims: [], messages: [], ...(parts ? { presenceParts: parts } : {}) } });
  const ALL = ['selection', 'focus', 'cursor', 'status', 'preview', 'editing', 'viewport'];

  it('says what it runs in, and sends the newer parts only to an API that names them', async () => {
    const { posts, streams, urls } = stubbed();
    const live = track(createCanvasLive('t1', 'c1', { confirmedVersion: () => 1, changes: () => {}, reset: () => {} }, 'page-lane-01', 'tablet'));
    live.start();
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    expect(urls[0]).toContain('&device=tablet');
    // An API from before the live lane: its hello names no parts, and a preview stays on the page.
    streams[0].push(hello('page-lane-01'));
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    live.setPresence({ preview: { nodes: [{ id: 'a', x: 1, y: 2 }] }, cursor: { x: 5, y: 5 } });
    await vi.waitFor(() => expect(posts).toHaveLength(2));
    expect(posts.every(post => !('preview' in post.state) && !('viewport' in post.state))).toBe(true);
    live.stop();
    // One that names them takes them, the waiting preview at once.
    const second = stubbed();
    const next = track(createCanvasLive('t1', 'c1', { confirmedVersion: () => 1, changes: () => {}, reset: () => {} }, 'page-lane-02', 'browser'));
    next.start();
    await vi.waitFor(() => expect(second.streams).toHaveLength(1));
    next.setPresence({ preview: { nodes: [{ id: 'a', x: 1, y: 2 }] }, editing: { node: 'a', field: 'title' } });
    second.streams[0].push(hello('page-lane-02', ALL));
    await vi.waitFor(() => expect(second.posts.some(post => 'preview' in post.state)).toBe(true));
    expect(second.posts.at(-1)!.state).toMatchObject({ preview: { nodes: [{ id: 'a', x: 1, y: 2 }] }, editing: { node: 'a', field: 'title' } });
    next.stop();
  });

  it('sends at most eight times a second, the latest of what changed', async () => {
    const { posts, streams } = stubbed();
    const live = track(createCanvasLive('t1', 'c1', { confirmedVersion: () => 1, changes: () => {}, reset: () => {} }, 'page-lane-03', 'browser'));
    live.start();
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    streams[0].push(hello('page-lane-03', ALL));
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    const started = Date.now();
    for (let i = 1; i <= 50; i += 1) {
      live.setPresence({ cursor: { x: i, y: 0 } });
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    await new Promise(resolve => setTimeout(resolve, 300));
    const moved = posts.slice(1);
    const seconds = (Date.now() - started) / 1000;
    expect(moved.length).toBeLessThanOrEqual(Math.ceil(seconds * 8) + 1);
    expect(moved.length).toBeGreaterThan(3);
    // No two posts closer than the pace.
    for (let i = 1; i < moved.length; i += 1) expect(moved[i].at - moved[i - 1].at).toBeGreaterThanOrEqual(110);
    expect(moved.at(-1)!.state).toEqual({ cursor: { x: 50, y: 0 } });
    live.stop();
  });

  it('sends a refused post again a moment later, unless something newer replaced it', async () => {
    let refuse = true;
    const { posts, streams } = stubbed(() => {
      if (refuse) { refuse = false; return new Response(JSON.stringify({ error: { code: 'presence_too_fast', message: 'slow down' } }), { status: 429 }); }
      return new Response(null, { status: 204 });
    });
    const live = track(createCanvasLive('t1', 'c1', { confirmedVersion: () => 1, changes: () => {}, reset: () => {} }, 'page-lane-04', 'browser'));
    live.start();
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    live.setPresence({ selection: ['a'] });
    streams[0].push(hello('page-lane-04', ALL));
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    await vi.waitFor(() => expect(posts).toHaveLength(2), { timeout: 3000 });
    expect(posts[1].at - posts[0].at).toBeGreaterThanOrEqual(800);
    expect(posts[1].state).toMatchObject({ selection: ['a'] });
    live.stop();
  });

  it('holds a post that was waiting back too when the server says too fast', async () => {
    let refuse = true;
    const { posts, streams } = stubbed(() => {
      if (refuse) { refuse = false; return new Response(JSON.stringify({ error: { code: 'presence_too_fast', message: 'slow down' } }), { status: 429 }); }
      return new Response(null, { status: 204 });
    });
    const live = track(createCanvasLive('t1', 'c1', { confirmedVersion: () => 1, changes: () => {}, reset: () => {} }, 'page-lane-07', 'browser'));
    live.start();
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    live.setPresence({ selection: ['a'] });
    streams[0].push(hello('page-lane-07', ALL));
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    // A change queued right after the refused post (its timer already set) goes no sooner than the server asked.
    live.setPresence({ cursor: { x: 1, y: 1 } });
    await vi.waitFor(() => expect(posts).toHaveLength(2), { timeout: 3000 });
    expect(posts[1].at - posts[0].at).toBeGreaterThanOrEqual(800);
    expect(posts[1].state).toMatchObject({ selection: ['a'], cursor: { x: 1, y: 1 } });
    live.stop();
  });

  it('keeps one post at a time, merging what changes meanwhile, and sends again what a failed one carried', async () => {
    let release: (() => void) | null = null;
    let calls = 0;
    const { posts, streams } = stubbed(() => new Response(null, { status: 204 }));
    const fetchStub = vi.mocked(fetch);
    const base = fetchStub.getMockImplementation()!;
    fetchStub.mockImplementation(async (url: string, init?: RequestInit) => {
      if (!String(url).includes('/live/presence')) return base(url, init);
      calls += 1;
      const answer = await base(url, init);
      if (calls === 2) await new Promise<void>(resolve => { release = resolve; });
      if (calls === 3) return new Response(JSON.stringify({ error: { code: 'bad_gateway', message: 'x' } }), { status: 502 });
      return answer;
    });
    const live = track(createCanvasLive('t1', 'c1', { confirmedVersion: () => 1, changes: () => {}, reset: () => {} }, 'page-lane-09', 'browser'));
    live.start();
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    streams[0].push(hello('page-lane-09', ALL));
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    live.setPresence({ editing: { node: 'a', field: 'title' } });
    await vi.waitFor(() => expect(posts).toHaveLength(2));
    // While the second post is out, two more changes come: nothing goes until it is answered, then both together.
    live.setPresence({ editing: null });
    live.setPresence({ cursor: { x: 1, y: 1 } });
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(posts).toHaveLength(2);
    release!();
    await vi.waitFor(() => expect(posts).toHaveLength(3));
    expect(posts[2].state).toEqual({ editing: null, cursor: { x: 1, y: 1 } });
    // That one failed (no answer from the server): what it carried goes again, a moment later.
    await vi.waitFor(() => expect(posts).toHaveLength(4), { timeout: 3000 });
    expect(posts[3].state).toEqual({ editing: null, cursor: { x: 1, y: 1 } });
    expect(posts[3].at - posts[2].at).toBeGreaterThanOrEqual(800);
    live.stop();
  });

  it('sends where an edit in progress was let go before saying it ended', async () => {
    const { posts, streams } = stubbed();
    const live = track(createCanvasLive('t1', 'c1', { confirmedVersion: () => 1, changes: () => {}, reset: () => {} }, 'page-lane-10', 'browser'));
    live.start();
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    streams[0].push(hello('page-lane-10', ALL));
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    live.setPresence({ preview: { nodes: [{ id: 'a', x: 10, y: 0 }] } });
    await vi.waitFor(() => expect(posts).toHaveLength(2));
    // The drop's place has not gone out when the drag ends.
    live.setPresence({ preview: { nodes: [{ id: 'a', x: 90, y: 0 }] } });
    live.setPresence({ preview: null });
    await vi.waitFor(() => expect(posts).toHaveLength(4), { timeout: 3000 });
    expect(posts[2].state).toEqual({ preview: { nodes: [{ id: 'a', x: 90, y: 0 }] } });
    expect(posts[3].state).toEqual({ preview: null });
    live.stop();
  });

  it('gives up a post that never answers, sends what it carried again, and waits longer after each failure in a row', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    let calls = 0;
    const { posts, streams } = stubbed();
    const fetchStub = vi.mocked(fetch);
    const base = fetchStub.getMockImplementation()!;
    fetchStub.mockImplementation(async (url: string, init?: RequestInit) => {
      if (!String(url).includes('/live/presence')) return base(url, init);
      calls += 1;
      await base(url, init);
      // The first never answers (a connection that died quietly) until it is given up; the next two fail.
      if (calls === 1) return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
      if (calls <= 3) return new Response(JSON.stringify({ error: { code: 'bad_gateway', message: 'x' } }), { status: 502 });
      return new Response(null, { status: 204 });
    });
    const live = track(createCanvasLive('t1', 'c1', { confirmedVersion: () => 1, changes: () => {}, reset: () => {} }, 'page-lane-11', 'browser'));
    live.start();
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    streams[0].push(hello('page-lane-11', ALL));
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    live.setPresence({ editing: { node: 'a', field: 'title' } });
    await vi.advanceTimersByTimeAsync(4_800);
    expect(posts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(posts).toHaveLength(4);
    // Given up at 5 s, it goes again a second later with what changed meanwhile; then 2 s, then 4 s after each failure.
    expect(posts[1].at - posts[0].at).toBeGreaterThanOrEqual(6_000);
    expect(posts[1].state).toMatchObject({ editing: { node: 'a', field: 'title' }, selection: [] });
    expect(posts[2].at - posts[1].at).toBeGreaterThanOrEqual(2_000);
    expect(posts[3].at - posts[2].at).toBeGreaterThanOrEqual(4_000);
    expect(posts[3].state).toMatchObject({ editing: { node: 'a', field: 'title' } });
    // Through, it goes at its pace again.
    const at = Date.now();
    live.setPresence({ cursor: { x: 1, y: 1 } });
    await vi.advanceTimersByTimeAsync(200);
    expect(posts).toHaveLength(5);
    expect(posts[4].at - at).toBeLessThan(200);
    live.stop();
    vi.useRealTimers();
  });

  it('sends nothing while its stream is down, and all of it at once with the next hello', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    let fail = false;
    const { posts, streams } = stubbed(() => fail ? new Response(JSON.stringify({ error: { code: 'bad_gateway', message: 'x' } }), { status: 502 })
      : new Response(null, { status: 204 }));
    const live = track(createCanvasLive('t1', 'c1', { confirmedVersion: () => 1, changes: () => {}, reset: () => {} }, 'page-lane-12', 'browser'));
    live.start();
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    streams[0].push(hello('page-lane-12', ALL));
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    // A post fails, and the stream drops before it would go again.
    fail = true;
    live.setPresence({ cursor: { x: 5, y: 5 } });
    await vi.advanceTimersByTimeAsync(200);
    expect(posts).toHaveLength(2);
    streams[0].end();
    await vi.waitFor(() => expect(live.snapshot().status).toBe('connecting'));
    live.setPresence({ cursor: { x: 6, y: 6 } });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(posts).toHaveLength(2);
    fail = false;
    for (let i = 0; i < 31 && streams.length < 2; i += 1) await vi.advanceTimersByTimeAsync(1_000);
    expect(posts).toHaveLength(2);
    const at = Date.now();
    streams.at(-1)!.push(hello('page-lane-12', ALL));
    await vi.waitFor(() => expect(posts).toHaveLength(3));
    expect(posts[2].state).toMatchObject({ cursor: { x: 6, y: 6 } });
    expect(posts[2].at - at).toBeLessThan(200);
    live.stop();
    vi.useRealTimers();
  });

  it('lets a new edit in progress take over from an ended one’s last place, and sends a last place that failed again first', async () => {
    let fail = 0;
    const { posts, streams } = stubbed(() => fail-- > 0 ? new Response(JSON.stringify({ error: { code: 'bad_gateway', message: 'x' } }), { status: 502 })
      : new Response(null, { status: 204 }));
    const live = track(createCanvasLive('t1', 'c1', { confirmedVersion: () => 1, changes: () => {}, reset: () => {} }, 'page-lane-13', 'browser'));
    live.start();
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    streams[0].push(hello('page-lane-13', ALL));
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    live.setPresence({ preview: { nodes: [{ id: 'a', x: 10, y: 0 }] } });
    await vi.waitFor(() => expect(posts).toHaveLength(2));
    // A drag ends before its last place went out, and a new one starts before the next post: the new one goes, alone.
    live.setPresence({ preview: { nodes: [{ id: 'a', x: 90, y: 0 }] } });
    live.setPresence({ preview: null });
    live.setPresence({ preview: { nodes: [{ id: 'b', x: 5, y: 5 }] } });
    await vi.waitFor(() => expect(posts).toHaveLength(3));
    expect(posts[2].state).toEqual({ preview: { nodes: [{ id: 'b', x: 5, y: 5 }] } });
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(posts).toHaveLength(3);
    // That one ends too, its last place not gone out, and the post carrying it fails: the place goes again, then the end.
    live.setPresence({ preview: { nodes: [{ id: 'b', x: 50, y: 5 }] } });
    live.setPresence({ preview: null });
    fail = 1;
    await vi.waitFor(() => expect(posts).toHaveLength(6), { timeout: 4000 });
    expect(posts.slice(3).map(post => post.state)).toEqual([
      { preview: { nodes: [{ id: 'b', x: 50, y: 5 }] } }, { preview: { nodes: [{ id: 'b', x: 50, y: 5 }] } }, { preview: null }]);
    live.stop();
  });

  it('sends all of its state at once with a new hello, whatever a failure before it set it to wait', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    let fail = true;
    const { posts, streams } = stubbed(() => fail ? new Response(JSON.stringify({ error: { code: 'bad_gateway', message: 'x' } }), { status: 502 })
      : new Response(null, { status: 204 }));
    const live = track(createCanvasLive('t1', 'c1', { confirmedVersion: () => 1, changes: () => {}, reset: () => {} }, 'page-lane-14', 'browser'));
    live.start();
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    streams[0].push(hello('page-lane-14', ALL));
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(1_100);
    expect(posts).toHaveLength(2);
    // Two failures: the next try waits 2 s. A hello comes meanwhile: everything goes at once.
    fail = false;
    const at = Date.now();
    streams[0].push(hello('page-lane-14', ALL));
    await vi.waitFor(() => expect(posts).toHaveLength(3));
    expect(posts[2].at - at).toBeLessThan(500);
    live.stop();
    vi.useRealTimers();
  });

  it('owes nothing for a post from before a new hello, and sends again a last place lost while it was out', async () => {
    let calls = 0;
    let release: ((response: Response) => void) | null = null;
    const { posts, streams } = stubbed();
    const fetchStub = vi.mocked(fetch);
    const base = fetchStub.getMockImplementation()!;
    const failed = () => new Response(JSON.stringify({ error: { code: 'bad_gateway', message: 'x' } }), { status: 502 });
    fetchStub.mockImplementation(async (url: string, init?: RequestInit) => {
      if (!String(url).includes('/live/presence')) return base(url, init);
      calls += 1;
      await base(url, init);
      if (calls === 3 || calls === 6) return new Promise<Response>(resolve => { release = resolve; });
      return new Response(null, { status: 204 });
    });
    const live = track(createCanvasLive('t1', 'c1', { confirmedVersion: () => 1, changes: () => {}, reset: () => {} }, 'page-lane-15', 'browser'));
    live.start();
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    streams[0].push(hello('page-lane-15', ALL));
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    live.setPresence({ preview: { nodes: [{ id: 'a', x: 10, y: 0 }] } });
    await vi.waitFor(() => expect(posts).toHaveLength(2));
    // A drop place is out when a new hello comes, and then fails: the hello's state goes, with no drop place in it.
    live.setPresence({ preview: { nodes: [{ id: 'a', x: 90, y: 0 }] } });
    live.setPresence({ preview: null });
    await vi.waitFor(() => expect(posts).toHaveLength(3));
    expect(posts[2].state).toEqual({ preview: { nodes: [{ id: 'a', x: 90, y: 0 }] } });
    streams[0].push(hello('page-lane-15', ALL));
    await new Promise(resolve => setTimeout(resolve, 50));
    release!(failed());
    await vi.waitFor(() => expect(posts).toHaveLength(4));
    expect(posts[3].state).toMatchObject({ preview: null, selection: [] });
    await new Promise(resolve => setTimeout(resolve, 1_300));
    expect(posts).toHaveLength(4);
    // An edit's place is out when the edit ends, and fails: that place goes again, then the end.
    live.setPresence({ preview: { nodes: [{ id: 'b', x: 7, y: 7 }] } });
    await vi.waitFor(() => expect(posts).toHaveLength(5));
    live.setPresence({ preview: { nodes: [{ id: 'b', x: 70, y: 7 }] } });
    await vi.waitFor(() => expect(posts).toHaveLength(6));
    live.setPresence({ preview: null });
    release!(failed());
    await vi.waitFor(() => expect(posts).toHaveLength(8), { timeout: 4000 });
    expect(posts.slice(5).map(post => post.state)).toEqual([
      { preview: { nodes: [{ id: 'b', x: 70, y: 7 }] } }, { preview: { nodes: [{ id: 'b', x: 70, y: 7 }] } }, { preview: null }]);
    live.stop();
  });

  it('renews an edit in progress every second while it lasts', async () => {
    const { posts, streams } = stubbed();
    const live = track(createCanvasLive('t1', 'c1', { confirmedVersion: () => 1, changes: () => {}, reset: () => {} }, 'page-lane-05', 'browser'));
    live.start();
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    streams[0].push(hello('page-lane-05', ALL));
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    live.setPresence({ preview: { resize: { id: 'a', x: 0, y: 0, w: 300, h: 200 } } });
    await new Promise(resolve => setTimeout(resolve, 2300));
    const previews = posts.filter(post => post.state.preview);
    expect(previews.length).toBeGreaterThanOrEqual(3);
    live.setPresence({ preview: null });
    await vi.waitFor(() => expect(posts.at(-1)!.state).toEqual({ preview: null }));
    const after = posts.length;
    await new Promise(resolve => setTimeout(resolve, 1300));
    expect(posts.length).toBe(after);
    live.stop();
  });

  it('opens a stream again that went quiet, and one the browser says is back online at once', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const { streams } = stubbed();
    const live = track(createCanvasLive('t1', 'c1', { confirmedVersion: () => 1, changes: () => {}, reset: () => {} }, 'page-lane-06', 'browser'));
    live.start();
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    streams[0].push(hello('page-lane-06', ALL));
    await vi.waitFor(() => expect(live.snapshot().status).toBe('live'));
    // Nothing for 35 s (not even a ping): opened again after the reconnect wait.
    await vi.advanceTimersByTimeAsync(41_000);
    await vi.waitFor(() => expect(streams.length).toBeGreaterThanOrEqual(2));
    // Back online while it waits to connect again: no back-off.
    streams.at(-1)!.end();
    await vi.advanceTimersByTimeAsync(10);
    const before = streams.length;
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(10);
    await vi.waitFor(() => expect(streams.length).toBe(before + 1));
    live.stop();
  });

  it('gives up an attempt to open the stream that never answers, and one in flight when the browser is back online', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const attempts: AbortSignal[] = [];
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      attempts.push(init!.signal!);
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    })));
    const live = track(createCanvasLive('t1', 'c1', { confirmedVersion: () => 1, changes: () => {}, reset: () => {} }, 'page-lane-08', 'browser'));
    live.start();
    await vi.waitFor(() => expect(attempts).toHaveLength(1));
    expect(live.snapshot().status).toBe('connecting');
    // The watchdog looks every 5 s: past 35 s with no answer, the attempt is given up.
    await vi.advanceTimersByTimeAsync(41_000);
    expect(attempts[0].aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(attempts.length).toBeGreaterThanOrEqual(2));
    // Back online while an attempt hangs: it is given up and the next goes at once, with no back-off.
    const hanging = attempts.length;
    await vi.advanceTimersByTimeAsync(20_000);
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts[hanging - 1].aborted).toBe(true);
    await vi.waitFor(() => expect(attempts.length).toBe(hanging + 1));
    live.stop();
  });
});
