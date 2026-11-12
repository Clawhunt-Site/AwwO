import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectDevice } from '../src/canvas/multiplayer/device';
import { followedPage, peopleCount, peopleOf, personKey } from '../src/canvas/multiplayer/people';
import { createLiveLane, editorsOf, freshPreview, PREVIEW_SHOWN_MS, previewTargets, wiresOf, type LaneSource } from '../src/canvas/multiplayer/liveLane';
import { DRAWER_CHOICES_KEY, heldDrawerChoices, installDrawerChoices, readDrawerChoices, withDrawerChoice, writeDrawerChoices } from '../src/canvas/drawerChoices';
import { deliverablesShown } from '../src/canvas/nodePresentation';
import { canvasStorage, configureCanvasStorage } from '../src/canvas/canvasStorage';
import { createSessionNode } from '../src/canvas/canvasDoc';
import type { LiveParticipant, LiveState } from '../src/canvas/multiplayer/types';

// 多人同屏's live lane (docs/awwo-canvas-live-collaboration.md, Presence): what a page says it runs in, the people its
// participants are, others' edits in progress and editing marks, following, and a person's drawers on their device.

const state = (over: Partial<LiveState> = {}): LiveState => ({ selection: [], focus: null, cursor: null, status: null, ...over });
const page = (id: string, userId: string, over: Partial<LiveParticipant> = {}): LiveParticipant => ({
  id, kind: 'human', port: 'web', name: `Person ${userId}`, color: '#0090ff', userId, state: state(), since: '2026-11-09T00:00:00Z', ...over,
});

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); installDrawerChoices(null); });

describe('what a page runs in', () => {
  const env = (userAgent: string, extra: Record<string, unknown> = {}) => ({ navigator: { userAgent, maxTouchPoints: 0, ...(extra.navigator as object ?? {}) }, ...extra });
  it('tells the apps, the browsers, phones and tablets apart', () => {
    const safari = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
    const macApp = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)';
    const chrome = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
    const edgeWebView = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0';
    expect(detectDevice(env(chrome))).toBe('browser');
    expect(detectDevice(env(safari))).toBe('browser');
    // AwwO Cloud for Windows is WebView2, which gives the page window.chrome.webview; Edge itself does not.
    expect(detectDevice(env(edgeWebView, { chrome: { webview: {} } }))).toBe('windows');
    expect(detectDevice(env(edgeWebView))).toBe('browser');
    // The Mac app: WebKit with no browser of its own in its user agent, or (its local workspace) a script handler.
    expect(detectDevice(env(macApp))).toBe('mac');
    expect(detectDevice(env(safari, { webkit: { messageHandlers: {} } }))).toBe('mac');
    expect(detectDevice(env('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'))).toBe('phone');
    expect(detectDevice(env('Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36'))).toBe('phone');
    expect(detectDevice(env('Mozilla/5.0 (Linux; Android 15; SM-X910) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36'))).toBe('tablet');
    // iPadOS says it is a Mac, with touch: a tablet, never the Mac app.
    expect(detectDevice({ navigator: { userAgent: macApp, maxTouchPoints: 5 } })).toBe('tablet');
    expect(detectDevice(undefined)).toBe('browser');
  });
});

describe('the people on a canvas', () => {
  it('shows one person for all their pages, with each device once, and this page’s person first', () => {
    const heard = new Map([['laptop', 100], ['phone', 300], ['ada-1', 200]]);
    const participants: LiveParticipant[] = [
      page('ada-1', 'ada', { device: 'browser' }),
      { id: 't_0123456789abcdef', kind: 'agent', port: 'mcp', name: 'Claude Code', color: '#8e4ec6', userId: 'leon', state: state(), since: '' },
      page('laptop', 'leon', { device: 'browser' }),
      page('phone', 'leon', { device: 'phone', state: state({ viewport: { x: 0, y: 0, w: 390, h: 700 } }) }),
      page('ada-2', 'ada', { device: 'windows' }),
      { id: 'run_r1', kind: 'awwo', port: 'awwo', name: 'Build', color: '#30a46c', state: state(), since: '' },
      page('old-page', 'ada'),
    ];
    const people = peopleOf(participants, 'laptop', heard);
    expect(people.map(person => person.key)).toEqual(['u_leon', 'u_ada', 't_0123456789abcdef', 'run_r1']);
    expect(people[0].self).toBe(true);
    // This page is its person's lead; another person's is their page heard from last.
    expect(people[0].lead.id).toBe('laptop');
    expect(people[0].devices).toEqual(['browser', 'phone']);
    expect(people[1].lead.id).toBe('ada-1');
    // A page that says no device is a browser's; each device once, in the order they are named.
    expect(people[1].devices).toEqual(['browser', 'windows']);
    expect(peopleCount(people)).toBe(4);
    expect(peopleCount(people.filter(person => !person.self))).toBe(4);
    // A person is followed on the page of theirs heard from last that says what its screen shows.
    expect(followedPage(peopleOf(participants, 'ada-1', heard).find(person => person.key === 'u_leon'))?.id).toBe('phone');
    expect(personKey({ id: 'p1', kind: 'human', userId: 'x' })).toBe('u_x');
  });
});

describe('others’ edits in progress and editing marks', () => {
  const now = 10_000;
  const heard = new Map([['a', now - 100], ['b', now - 50], ['stale', now - PREVIEW_SHOWN_MS - 1], ['self', now]]);
  const participants: LiveParticipant[] = [
    page('a', 'u1', { state: state({ preview: { nodes: [{ id: 'n1', x: 10, y: 20 }, { id: 'n2', x: 30, y: 40 }] }, editing: { node: 'n1', field: 'title' } }) }),
    page('b', 'u2', { color: '#e5484d', state: state({ preview: { nodes: [{ id: 'n2', x: 99, y: 99 }], wire: { node: 'n3', port: 'result', side: 'output', from: { x: 1, y: 2 }, to: { x: 3, y: 4 } } } }) }),
    page('stale', 'u3', { state: state({ preview: { resize: { id: 'n4', x: 0, y: 0, w: 300, h: 200 } } }) }),
    page('self', 'u4', { state: state({ preview: { nodes: [{ id: 'n5', x: 0, y: 0 }] }, editing: { node: 'n5', field: 'persona' } }) }),
  ];
  it('takes the others’ fresh previews, the newest heard winning a node two move', () => {
    const targets = previewTargets(participants, 'self', heard, now);
    expect([...targets.keys()].sort()).toEqual(['n1', 'n2']);
    // Each place says whose edit it is (a takeover hides only that edit).
    expect(targets.get('n2')).toEqual({ x: 99, y: 99, color: '#e5484d', by: 'b' });
    expect(freshPreview(participants[2], heard, now)).toBeNull();
    expect(wiresOf(participants, 'self', heard, now)).toEqual([{ participantId: 'b', name: 'Person u2', color: '#e5484d', from: { x: 1, y: 2 }, to: { x: 3, y: 4 } }]);
    expect([...editorsOf(participants, 'self')]).toEqual([['n1', [{ participantId: 'a', name: 'Person u1', color: '#0090ff', field: 'title' }]]]);
  });

  /** A source the test moves, with animation frames it steps by hand. */
  function fakeSource(initial: LiveParticipant[]) {
    let snapshot = { participants: initial, heard: new Map<string, number>(initial.map(p => [p.id, Date.now()])) };
    const listeners = new Set<() => void>();
    const source: LaneSource = { snapshot: () => snapshot, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); } };
    return {
      source,
      set(next: LiveParticipant[]) { snapshot = { participants: next, heard: new Map(next.map(p => [p.id, Date.now()])) }; for (const listener of [...listeners]) listener(); },
    };
  }
  function frames() {
    let queue: FrameRequestCallback[] = [];
    let time = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { queue.push(callback); return queue.length; });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    return {
      step(count = 1, ms = 16) {
        for (let i = 0; i < count; i += 1) { time += ms; const due = queue; queue = []; for (const callback of due) callback(time); }
      },
      pending: () => queue.length,
    };
  }

  it('glides a card from where the document has it to where the drag puts it, and keeps it there until the change comes', () => {
    const tick = frames();
    const doc = new Map([['n1', { x: 0, y: 0, w: 260, h: 128 }]]);
    const feed = fakeSource([page('a', 'u1', { state: state({ preview: { nodes: [{ id: 'n1', x: 100, y: 0 }] } }) })]);
    const lane = createLiveLane(feed.source, 'self', id => doc.get(id) ?? null);
    tick.step(1);
    const first = lane.moves().get('n1')!;
    expect(first.x).toBeGreaterThan(0);
    expect(first.x).toBeLessThan(100);
    // The glide spring settles within about a second (laneMotion.ts).
    tick.step(90);
    expect(lane.moves().get('n1')?.x).toBe(100);
    // The drag ends: the card stays where it was put while the change is on its way…
    feed.set([page('a', 'u1')]);
    tick.step(10);
    expect(lane.moves().get('n1')?.x).toBe(100);
    // …and once the document holds it there, it is let go (the canvas says when its document changes).
    doc.set('n1', { x: 100, y: 0, w: 260, h: 128 });
    lane.documentChanged();
    tick.step(2);
    expect(lane.moves().has('n1')).toBe(false);
    lane.stop();
  });

  it('goes on to where an ended drag put the card, and lets it go once the document has it there', () => {
    const tick = frames();
    const doc = new Map([['n1', { x: 0, y: 0, w: 260, h: 128 }]]);
    const feed = fakeSource([page('a', 'u1', { state: state({ preview: { nodes: [{ id: 'n1', x: 1000, y: 0 }] } }) })]);
    const lane = createLiveLane(feed.source, 'self', id => doc.get(id) ?? null);
    tick.step(2);
    expect(lane.moves().get('n1')!.x).toBeLessThan(900);
    // The drag ends and its change lands at once, the card still on its way: it goes on there, never back.
    feed.set([page('a', 'u1')]);
    doc.set('n1', { x: 1000, y: 0, w: 260, h: 128 });
    lane.documentChanged();
    let last = lane.moves().get('n1')!.x!;
    for (let i = 0; i < 150 && lane.moves().has('n1'); i += 1) {
      tick.step(1);
      const x = lane.moves().get('n1')?.x;
      if (x !== undefined) { expect(x).toBeGreaterThanOrEqual(last); last = x; }
    }
    expect(lane.moves().has('n1')).toBe(false);
    lane.stop();
  });

  it('takes a change somewhere other than the last place heard only after the wait (a late save from mid-drag is not it)', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(1_000_000);
    const tick = frames();
    const doc = new Map([['n1', { x: 0, y: 0, w: 260, h: 128 }]]);
    const feed = fakeSource([page('a', 'u1', { state: state({ preview: { nodes: [{ id: 'n1', x: 100, y: 0 }] } }) })]);
    const lane = createLiveLane(feed.source, 'self', id => doc.get(id) ?? null);
    tick.step(90);
    expect(lane.moves().get('n1')?.x).toBe(100);
    feed.set([page('a', 'u1')]);
    tick.step(5);
    // A save from the middle of the drag lands after its end: the card stays at the drop.
    doc.set('n1', { x: 50, y: 0, w: 260, h: 128 });
    lane.documentChanged();
    tick.step(60);
    expect(lane.moves().get('n1')?.x).toBe(100);
    // The wait over, the card goes to wherever the document has it.
    vi.advanceTimersByTime(2_100);
    tick.step(150);
    expect(lane.moves().has('n1')).toBe(false);
    lane.stop();
    vi.useRealTimers();
  });

  it('jumps under reduced motion, and eases a card home whose change never comes', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(1_000_000);
    const tick = frames();
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce'), media: query, addEventListener() {}, removeEventListener() {} }));
    const doc = new Map([['n1', { x: 0, y: 0, w: 260, h: 128 }]]);
    const feed = fakeSource([page('a', 'u1', { state: state({ preview: { nodes: [{ id: 'n1', x: 50, y: 60 }] } }) })]);
    const lane = createLiveLane(feed.source, 'self', id => doc.get(id) ?? null);
    tick.step(1);
    expect(lane.moves().get('n1')).toMatchObject({ x: 50, y: 60 });
    feed.set([page('a', 'u1')]);
    tick.step(1);
    // Waiting, nothing runs; the wait over, the card goes home.
    expect(tick.pending()).toBe(0);
    vi.advanceTimersByTime(2_500);
    tick.step(3);
    expect(lane.moves().has('n1')).toBe(false);
    lane.stop();
    vi.useRealTimers();
  });

  it('marks a resize with the size it is taking, and a drag with no size at all', () => {
    const tick = frames();
    const doc = new Map([['n1', { x: 0, y: 0, w: 260, h: 128 }], ['n2', { x: 300, y: 0, w: 200, h: 100 }]]);
    const feed = fakeSource([page('a', 'u1', { state: state({ preview: { nodes: [{ id: 'n1', x: 40, y: 0 }] } }) }),
      page('b', 'u2', { state: state({ preview: { resize: { id: 'n2', x: 300, y: 0, w: 320, h: 180 } } }) })]);
    const lane = createLiveLane(feed.source, 'self', id => doc.get(id) ?? null);
    tick.step(150);
    expect(lane.moves().get('n1')).toMatchObject({ x: 40, y: 0 });
    expect(lane.moves().get('n1')).not.toHaveProperty('w');
    expect(lane.moves().get('n1')).not.toHaveProperty('resize');
    expect(lane.moves().get('n2')).toMatchObject({ x: 300, y: 0, w: 320, h: 180, resize: true });
    lane.stop();
  });

  it('takes a short drag on to where it was let go, never letting it go on its way', () => {
    const tick = frames();
    const doc = new Map([['n1', { x: 0, y: 0, w: 260, h: 128 }]]);
    const feed = fakeSource([page('a', 'u1', { state: state({ preview: { nodes: [{ id: 'n1', x: 6, y: 0 }] } }) })]);
    const lane = createLiveLane(feed.source, 'self', id => doc.get(id) ?? null);
    // It ends before the card has gone any way at all: the card still goes on there, and waits for the change.
    feed.set([page('a', 'u1')]);
    tick.step(1);
    expect(lane.moves().has('n1')).toBe(true);
    tick.step(150);
    expect(lane.moves().get('n1')?.x).toBe(6);
    lane.stop();
  });

  it('keeps the set of moved nodes while they glide, rests while nothing moves, and wakes when a wait is over', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(1_000_000);
    const tick = frames();
    const doc = new Map([['n1', { x: 0, y: 0, w: 260, h: 128 }]]);
    const feed = fakeSource([page('a', 'u1', { state: state({ preview: { nodes: [{ id: 'n1', x: 100, y: 0 }] } }) })]);
    const lane = createLiveLane(feed.source, 'self', id => doc.get(id) ?? null);
    const ids = lane.movedIds();
    expect([...ids]).toEqual(['n1']);
    tick.step(5);
    expect(lane.movedIds()).toBe(ids);
    tick.step(150);
    // At rest under a pointer held still: no frame is asked for.
    expect(lane.moves().get('n1')?.x).toBe(100);
    expect(tick.pending()).toBe(0);
    // The drag ends where it was: the card waits for its change with no frames, and goes home once the wait is over.
    feed.set([page('a', 'u1')]);
    tick.step(1);
    expect(tick.pending()).toBe(0);
    expect(lane.moves().get('n1')?.x).toBe(100);
    vi.advanceTimersByTime(2_100);
    expect(tick.pending()).toBe(1);
    tick.step(150);
    expect(lane.moves().has('n1')).toBe(false);
    expect(lane.movedIds().size).toBe(0);
    lane.stop();
    vi.useRealTimers();
  });

  it('lets go at once of a card whose change came before the edit’s end, at its last place', () => {
    const tick = frames();
    const doc = new Map([['n1', { x: 0, y: 0, w: 260, h: 128 }]]);
    const feed = fakeSource([page('a', 'u1', { state: state({ preview: { nodes: [{ id: 'n1', x: 100, y: 0 }] } }) })]);
    const lane = createLiveLane(feed.source, 'self', id => doc.get(id) ?? null);
    tick.step(150);
    // The change lands while the drag still shows: the card stays on the drag till its end…
    doc.set('n1', { x: 100, y: 0, w: 260, h: 128 });
    lane.documentChanged();
    tick.step(1);
    expect(lane.moves().get('n1')?.x).toBe(100);
    // …and is let go then, not after the 2 s wait.
    feed.set([page('a', 'u1')]);
    tick.step(5);
    expect(lane.moves().has('n1')).toBe(false);
    lane.stop();
  });

  it('waits at the drop when only a save from the middle of the drag came before its end, never going back to it', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(1_000_000);
    const tick = frames();
    const doc = new Map([['n1', { x: 0, y: 0, w: 260, h: 128 }]]);
    const feed = fakeSource([page('a', 'u1', { state: state({ preview: { nodes: [{ id: 'n1', x: 50, y: 0 }] } }) })]);
    const lane = createLiveLane(feed.source, 'self', id => doc.get(id) ?? null);
    tick.step(150);
    // A save from the middle of the drag lands while it goes on to 100…
    doc.set('n1', { x: 50, y: 0, w: 260, h: 128 });
    lane.documentChanged();
    feed.set([page('a', 'u1', { state: state({ preview: { nodes: [{ id: 'n1', x: 100, y: 0 }] } }) })]);
    tick.step(150);
    // …and the drag ends at 100: the card waits there for the change.
    feed.set([page('a', 'u1')]);
    let least = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 60; i += 1) { tick.step(1); least = Math.min(least, lane.moves().get('n1')?.x ?? least); }
    expect(least).toBe(100);
    doc.set('n1', { x: 100, y: 0, w: 260, h: 128 });
    lane.documentChanged();
    tick.step(5);
    expect(lane.moves().has('n1')).toBe(false);
    lane.stop();
    vi.useRealTimers();
  });

  it('lets go of the nodes this page takes over, drawing them again only once the edit puts them somewhere new', () => {
    const tick = frames();
    const doc = new Map([['n1', { x: 0, y: 0, w: 260, h: 128 }]]);
    const feed = fakeSource([page('a', 'u1', { state: state({ preview: { nodes: [{ id: 'n1', x: 100, y: 0 }] } }) })]);
    const lane = createLiveLane(feed.source, 'self', id => doc.get(id) ?? null);
    tick.step(150);
    expect(lane.moves().get('n1')?.x).toBe(100);
    lane.release(['n1']);
    expect(lane.moves().has('n1')).toBe(false);
    expect(lane.movedIds().has('n1')).toBe(false);
    // The same place heard again (a renewal) is not drawn; a new one is.
    feed.set([page('a', 'u1', { state: state({ preview: { nodes: [{ id: 'n1', x: 100, y: 0 }] } }) })]);
    tick.step(5);
    expect(lane.moves().has('n1')).toBe(false);
    feed.set([page('a', 'u1', { state: state({ preview: { nodes: [{ id: 'n1', x: 140, y: 0 }] } }) })]);
    tick.step(1);
    expect(lane.moves().has('n1')).toBe(true);
    lane.stop();
  });

  it('hides only the edit it took over: someone else’s at the same place is drawn, and so is a resize where it stood', () => {
    const tick = frames();
    const doc = new Map([['n1', { x: 0, y: 0, w: 260, h: 128 }], ['n2', { x: 300, y: 0, w: 200, h: 100 }]]);
    const feed = fakeSource([page('a', 'u1', { state: state({ preview: { nodes: [{ id: 'n1', x: 100, y: 0 }],
      resize: { id: 'n2', x: 300, y: 0, w: 260, h: 160 } } }) })]);
    const lane = createLiveLane(feed.source, 'self', id => doc.get(id) ?? null);
    tick.step(150);
    // Both taken over (n2's resize moves it nowhere: it is released all the same).
    lane.release(['n1', 'n2']);
    expect(lane.moves().size).toBe(0);
    feed.set([page('a', 'u1', { state: state({ preview: { nodes: [{ id: 'n1', x: 100, y: 0 }],
      resize: { id: 'n2', x: 300, y: 0, w: 260, h: 160 } } }) })]);
    tick.step(5);
    expect(lane.moves().size).toBe(0);
    // Another person puts n1 at that very place: theirs is drawn.
    feed.set([page('a', 'u1', { state: state({ preview: { resize: { id: 'n2', x: 300, y: 0, w: 260, h: 160 } } }) }),
      page('b', 'u2', { state: state({ preview: { nodes: [{ id: 'n1', x: 100, y: 0 }] } }) })]);
    tick.step(1);
    expect(lane.moves().has('n1')).toBe(true);
    expect(lane.moves().has('n2')).toBe(false);
    lane.stop();
  });

  it('keeps a take-over while the edit’s page is only quiet, and forgets it once the page says the edit ended', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(1_000_000);
    const tick = frames();
    const doc = new Map([['n1', { x: 0, y: 0, w: 260, h: 128 }]]);
    const held = () => [page('a', 'u1', { state: state({ preview: { nodes: [{ id: 'n1', x: 100, y: 0 }] } }) })];
    const feed = fakeSource(held());
    const lane = createLiveLane(feed.source, 'self', id => doc.get(id) ?? null);
    tick.step(150);
    expect(lane.moves().get('n1')?.x).toBe(100);
    lane.release(['n1']);
    // Her page is not heard for more than 2 s (a tab asleep, a link stalled) and still says its edit: the lane looks
    // again when the edit is stale, and the same place heard after that is the edit this page took the card from.
    vi.advanceTimersByTime(PREVIEW_SHOWN_MS + 100);
    tick.step(5);
    expect(lane.moves().has('n1')).toBe(false);
    feed.set(held());
    tick.step(5);
    expect(lane.moves().has('n1')).toBe(false);
    // Quiet again, then heard at a new place: that is drawn.
    vi.advanceTimersByTime(PREVIEW_SHOWN_MS + 100);
    feed.set([page('a', 'u1', { state: state({ preview: { nodes: [{ id: 'n1', x: 140, y: 0 }] } }) })]);
    tick.step(1);
    expect(lane.moves().has('n1')).toBe(true);
    // Taken over again; she says her edit ended, then starts one at that very place: a new edit, drawn.
    lane.release(['n1']);
    feed.set([page('a', 'u1')]);
    tick.step(2);
    expect(lane.moves().has('n1')).toBe(false);
    feed.set([page('a', 'u1', { state: state({ preview: { nodes: [{ id: 'n1', x: 140, y: 0 }] } }) })]);
    tick.step(1);
    expect(lane.moves().has('n1')).toBe(true);
    // She says that edit ended while its card waits for the change, this page takes the card over then, and she
    // starts an edit at that very place before anything else is heard: a new edit, drawn.
    tick.step(150);
    feed.set([page('a', 'u1')]);
    tick.step(2);
    expect(lane.moves().has('n1')).toBe(true);
    lane.release(['n1']);
    feed.set([page('a', 'u1', { state: state({ preview: { nodes: [{ id: 'n1', x: 140, y: 0 }] } }) })]);
    tick.step(1);
    expect(lane.moves().has('n1')).toBe(true);
    // Taken over once more; her page goes quiet, leaves, and comes back saying that place: a new edit too.
    lane.release(['n1']);
    vi.advanceTimersByTime(PREVIEW_SHOWN_MS + 100);
    feed.set([]);
    feed.set([page('a', 'u1', { state: state({ preview: { nodes: [{ id: 'n1', x: 140, y: 0 }] } }) })]);
    tick.step(1);
    expect(lane.moves().has('n1')).toBe(true);
    tick.step(150);
    expect(lane.moves().get('n1')?.x).toBe(140);
    // Her page goes quiet first this time: her edit is stale, its card on its way home, when this page takes the card
    // over. Heard again at that place, it is still the edit the card was taken from.
    vi.advanceTimersByTime(PREVIEW_SHOWN_MS + 100);
    tick.step(2);
    expect(lane.moves().get('n1')?.x).toBeLessThan(140);
    lane.release(['n1']);
    feed.set([page('a', 'u1', { state: state({ preview: { nodes: [{ id: 'n1', x: 140, y: 0 }] } }) })]);
    tick.step(5);
    expect(lane.moves().has('n1')).toBe(false);
    lane.stop();
    vi.useRealTimers();
  });

  it('lets a card go home 2 s after the last update of an edit whose page went quiet', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(1_000_000);
    const tick = frames();
    const doc = new Map([['n1', { x: 0, y: 0, w: 260, h: 128 }]]);
    const feed = fakeSource([page('a', 'u1', { state: state({ preview: { nodes: [{ id: 'n1', x: 100, y: 0 }] } }) })]);
    const lane = createLiveLane(feed.source, 'self', id => doc.get(id) ?? null);
    tick.step(150);
    expect(lane.moves().get('n1')?.x).toBe(100);
    // Nothing more comes: the edit is stale at 2 s, and the card goes home then, not 2 s later.
    vi.advanceTimersByTime(2_100);
    tick.step(150);
    expect(lane.moves().has('n1')).toBe(false);
    lane.stop();
    vi.useRealTimers();
  });

  it('draws a box another person takes over at the very same place in their colour', () => {
    const tick = frames();
    const doc = new Map([['n2', { x: 300, y: 0, w: 200, h: 100 }]]);
    const resize = { resize: { id: 'n2', x: 300, y: 0, w: 260, h: 160 } };
    const feed = fakeSource([page('a', 'u1', { color: '#e5484d', state: state({ preview: resize }) })]);
    const lane = createLiveLane(feed.source, 'self', id => doc.get(id) ?? null);
    tick.step(150);
    expect(lane.moves().get('n2')?.color).toBe('#e5484d');
    feed.set([page('b', 'u2', { color: '#30a46c', state: state({ preview: resize }) })]);
    tick.step(2);
    expect(lane.moves().get('n2')?.color).toBe('#30a46c');
    lane.stop();
  });

  it('follows a person by the page whose screen moved last, never one that only went quiet', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
    const laptop = page('lap', 'u1', { state: state({ viewport: { x: 0, y: 0, w: 1440, h: 900 } }) });
    const feed = fakeSource([laptop]);
    const lane = createLiveLane(feed.source, 'self', () => null);
    const key = personKey(laptop);
    lane.follow(key);
    expect(lane.followed()?.viewport).toEqual({ x: 0, y: 0, w: 1440, h: 900 });
    // The person opens the canvas on their phone too: its screen is the newest.
    const phone = page('phn', 'u1', { device: 'phone', state: state({ viewport: { x: 500, y: 500, w: 390, h: 800 } }) });
    vi.setSystemTime(1_005_000);
    feed.set([laptop, phone]);
    expect(lane.followed()?.viewport).toEqual({ x: 500, y: 500, w: 390, h: 800 });
    // The laptop's stream closes: it is heard of once more (its pointer gone), its old screen kept. The phone stays.
    vi.setSystemTime(1_010_000);
    feed.set([phone, { ...laptop, state: state({ viewport: { x: 0, y: 0, w: 1440, h: 900 }, cursor: null }) }]);
    expect(lane.followed()?.viewport).toEqual({ x: 500, y: 500, w: 390, h: 800 });
    lane.stop();
    vi.useRealTimers();
  });

  it('keeps following a person by the same page when their pages came together, whatever is heard of them later', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
    // Both of their pages come in one hello: their screens are first seen at the same moment.
    const laptop = page('lap', 'u1', { state: state({ viewport: { x: 0, y: 0, w: 1440, h: 900 }, cursor: { x: 1, y: 1 } }) });
    const phone = page('phn', 'u1', { device: 'phone', state: state({ viewport: { x: 500, y: 500, w: 390, h: 800 }, cursor: { x: 2, y: 2 } }) });
    const feed = fakeSource([laptop, phone]);
    const lane = createLiveLane(feed.source, 'self', () => null);
    lane.follow(personKey(laptop));
    const first = lane.followed()?.viewport;
    expect(first).not.toBeNull();
    // Each page in turn is heard of again (a stream closing: its pointer gone, its screen kept): the page shown stays.
    vi.setSystemTime(1_003_000);
    feed.set([{ ...laptop, state: state({ viewport: laptop.state!.viewport, cursor: null }) }, phone]);
    expect(lane.followed()?.viewport).toEqual(first);
    vi.setSystemTime(1_006_000);
    feed.set([laptop, { ...phone, state: state({ viewport: phone.state!.viewport, cursor: null }) }]);
    expect(lane.followed()?.viewport).toEqual(first);
    lane.stop();
    vi.useRealTimers();
  });

  it('follows a person by the page of theirs that says what its screen shows, and stops when they leave', () => {
    const feed = fakeSource([
      page('ada-laptop', 'ada', { state: state({ viewport: { x: 10, y: 20, w: 800, h: 600 } }) }),
      page('ada-phone', 'ada'),
    ]);
    const lane = createLiveLane(feed.source, 'self', () => null);
    const told = vi.fn();
    lane.subscribe(told);
    lane.follow('u_ada');
    expect(lane.following()).toBe('u_ada');
    expect(lane.followed()).toMatchObject({ key: 'u_ada', viewport: { x: 10, y: 20, w: 800, h: 600 } });
    feed.set([page('ada-laptop', 'ada', { state: state({ viewport: { x: 50, y: 20, w: 800, h: 600 } }) })]);
    expect(lane.followed()?.viewport?.x).toBe(50);
    feed.set([]);
    expect(lane.following()).toBeNull();
    expect(lane.followed()).toBeNull();
    expect(told).toHaveBeenCalled();
    lane.stop();
  });
});

describe('a person’s drawers, on their device', () => {
  it('overrides the document’s default for every layout path, and is kept in the canvas’s own storage', () => {
    configureCanvasStorage('user-lane', 'tenant-lane', 'canvas-lane');
    const delivered = { ...createSessionNode('llm', { x: 0, y: 0 }), id: 'n1', lastOutput: { text: 'done', at: 1 } } as Parameters<typeof deliverablesShown>[0];
    // A delivered node shows its drawer by the rule; the document may say otherwise (a case copy opens it).
    expect(deliverablesShown(delivered)).toBe(true);
    expect(deliverablesShown({ ...delivered, deliverablesOpen: false } as typeof delivered)).toBe(false);
    let choices = withDrawerChoice(new Map(), 'n1', false);
    installDrawerChoices(choices);
    expect(deliverablesShown(delivered)).toBe(false);
    expect(deliverablesShown({ ...delivered, deliverablesOpen: true } as typeof delivered)).toBe(false);
    choices = withDrawerChoice(choices, 'n1', true);
    installDrawerChoices(choices);
    expect(deliverablesShown({ ...delivered, deliverablesOpen: false } as typeof delivered)).toBe(true);
    expect(withDrawerChoice(choices, 'n1', true)).toBe(choices);
    writeDrawerChoices(choices);
    expect(JSON.parse(canvasStorage().getItem(DRAWER_CHOICES_KEY)!)).toEqual({ n1: true });
    expect([...readDrawerChoices()]).toEqual([['n1', true]]);
    // A deleted node's choice goes.
    expect([...heldDrawerChoices(withDrawerChoice(choices, 'gone', false), new Set(['n1']))]).toEqual([['n1', true]]);
    installDrawerChoices(null);
    expect(deliverablesShown({ ...delivered, deliverablesOpen: false } as typeof delivered)).toBe(false);
  });
});
