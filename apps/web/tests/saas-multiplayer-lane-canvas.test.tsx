import { appearanceFixture } from './saas-appearance-fixture';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SaaSApp } from '../src/saas/SaaSApp';
import type { CanvasRecord, Tenant } from '../src/saas/api';
import { createSessionNode, emptyDocument, sanitizeDocument, type CanvasDocument } from '../src/canvas/canvasDoc';
import { canvasStorage } from '../src/canvas/canvasStorage';
import { DRAWER_CHOICES_KEY } from '../src/canvas/drawerChoices';
import { applyOps } from '../src/canvas/multiplayer/changes';
import type { CanvasChange, CanvasOp, LiveParticipant, LiveState } from '../src/canvas/multiplayer/types';
import { cardPressAllowed, endPassivePress, holdCardGesture, holdPassivePress } from '../src/canvas/cardGesture';

// 多人同屏's live lane on the hosted canvas page (docs/awwo-canvas-live-collaboration.md, Presence): others' edits in
// progress drawn where they put the nodes, this page's own sent while they last, following a person by their avatar,
// a viewer's live canvas, and a person's delivery drawers kept on their device, never in the shared document.

const owner: Tenant = { id: 'tenant-lane', name: 'Workspace', role: 'owner', status: 'active', maxConcurrentRuns: 2, maxRunsPerDay: 10 };
const viewer: Tenant = { ...owner, role: 'reader' };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const capabilities = { skills: { enabled: true, maxNodeSkills: 4, maxNodeSkillBytes: 20480 }, memory: { enabled: true, maxRunItems: 0, maxRunBytes: 0, maxPerScope: 0 },
  webReader: { enabled: false, perDay: 0, usedToday: 0 }, render: { enabled: false, perDay: 0, usedToday: 0, limits: {} }, multiplayer: { enabled: true, maxChangeOps: 500 } };
const PARTS = ['selection', 'focus', 'cursor', 'status', 'preview', 'editing', 'viewport'];

type Frame = { event: string; data: unknown };
function scriptedStream() {
  const encoder = new TextEncoder();
  let push: (frame: Frame) => void = () => {};
  const body = new ReadableStream<Uint8Array>({ start(controller) { push = frame => controller.enqueue(encoder.encode(`event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`)); } });
  return { body, push: (frame: Frame) => push(frame) };
}

function canvasDocument(): CanvasDocument {
  const a = { ...createSessionNode('llm', { x: 0, y: 0 }), id: 'a', title: 'Plan' };
  const b = { ...createSessionNode('llm', { x: 420, y: 0 }), id: 'b', title: 'Build', lastOutput: { text: 'Built it', at: 1 } };
  return sanitizeDocument({ ...emptyDocument(), view: { x: 10, y: 10, scale: 1 }, nodes: [a, b] });
}
const state = (over: Partial<LiveState> = {}): LiveState => ({ selection: [], focus: null, cursor: null, status: null, preview: null, editing: null, viewport: null, ...over });
const ada = (over: Partial<LiveState> = {}, extra: Partial<LiveParticipant> = {}): LiveParticipant => ({ id: 'page-ada-0001', kind: 'human', port: 'web', name: 'Ada',
  color: '#e5484d', userId: 'user-ada', role: 'member', device: 'phone', state: state(over), since: '2026-11-09T00:00:00Z', ...extra });

beforeEach(() => {
  localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh');
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.setAttribute('open', ''); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.removeAttribute('open'); } });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function openLive(tenant: Tenant) {
  const identity = { user: { id: 'user-self', email: 'self@example.test', name: 'Leon', platformRole: 'user' }, tenants: [tenant] };
  localStorage.setItem(`awwo.workmode.v1:${identity.user.id}`, 'completed');
  let cloud: CanvasRecord = { id: 'canvas-lane', tenantId: tenant.id, name: 'Lane canvas', version: 3, document: canvasDocument(), createdAt: '', updatedAt: '' };
  const streams: ReturnType<typeof scriptedStream>[] = [];
  const streamUrls: string[] = [];
  const writes: { method: string; url: string; body: any }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = String(input);
    if (init.method && init.method !== 'GET') {
      const body = init.body ? JSON.parse(String(init.body)) : null;
      writes.push({ method: init.method, url, body });
      if (init.method === 'POST' && url.endsWith('/live/presence')) return new Response(null, { status: 204 });
      // A change is answered as the API answers it: applied to the server's document, at the next version (after the
      // page's, should a case have pushed someone else's change on the stream, which this document never took), with
      // the page's own change in the answer (`changes` holds every change after baseVersion). The page takes the
      // server's value at each path it sent (canvasSync.ts rebaseFor), so an answer without its change puts a card
      // this page dragged back where the server's document still had it. Autosave sends by the clock (autosavePace.ts:
      // 450 ms after the last write once no pointer is held, 1.5 s after the first unsent one at the latest while
      // someone else is on the canvas), so its answer can land between any two steps of a case.
      if (init.method === 'PATCH') {
        cloud = { ...cloud, version: Math.max(cloud.version, body.baseVersion) + 1, document: applyOps(cloud.document as object, body.ops as CanvasOp[]).doc };
        const own: CanvasChange = { version: cloud.version, actor: { kind: 'human', name: identity.user.name, clientId: body.clientId, userId: identity.user.id },
          label: 'edit', ops: body.ops, at: '2026-11-09T00:00:00Z' };
        return json({ version: cloud.version, results: body.ops.map(() => 'ok'), changes: [own] });
      }
      if (init.method === 'PUT') { cloud = { ...cloud, version: cloud.version + 1, document: body.document }; return json(cloud); }
      return json({});
    }
    if (url.includes('/live/events')) {
      streamUrls.push(url);
      const stream = scriptedStream();
      streams.push(stream);
      return new Response(stream.body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    if (url.endsWith('/appearance')) return json(appearanceFixture);
    if (url.endsWith('/auth/me')) return json(identity);
    if (url.endsWith('/runtime')) return json({ available: false, configured: false, models: [] });
    if (url.endsWith('/capabilities')) return json(capabilities);
    if (url.endsWith('/graph-runs')) return json({ items: [] });
    if (url.includes('/canvases/canvas-lane')) return json(cloud);
    return json({ items: [] });
  }));
  window.history.replaceState({}, '', `/?tenant=${tenant.id}&canvas=canvas-lane`);
  render(<SaaSApp />);
  const presence = () => writes.filter(write => write.url.endsWith('/live/presence')).map(write => write.body.state as Record<string, unknown>);
  return { streams, streamUrls, writes, presence, identity };
}

async function hello(page: ReturnType<typeof openLive>, others: LiveParticipant[]) {
  await waitFor(() => expect(page.streams).toHaveLength(1), { timeout: 5000 });
  const self = page.streamUrls[0].match(/client=([^&]+)/)![1];
  const you: LiveParticipant = { id: self, kind: 'human', port: 'web', name: 'Leon', color: '#0090ff', userId: page.identity.user.id, state: state(), since: '' };
  await act(async () => {
    page.streams[0].push({ event: 'hello', data: { you, version: 3, participants: [you, ...others], claims: [], messages: [], presenceParts: PARTS } });
  });
  return self;
}

const tileOf = (id: string) => screen.getByTestId(`canvas-tile-${id}`);
/** Holds the clock (Date.now) where it is for the rest of a case (afterEach lets it go); timers and animation frames
 *  still run. Another person's edit in progress is shown for 2 s after it was last heard, by Date.now (liveLane.ts):
 *  then it has ended, its card goes home, and the lane forgets that this page took the card over. A case whose steps
 *  are all within one edit of theirs holds the clock, so a busy run that takes longer than that between two steps
 *  never ends the edit under it. (Autosave goes by the same clock, autosavePace.ts: such a case sends no change.) */
const holdClock = () => { const at = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(at); };

describe('the live lane on the canvas page', () => {
  it('draws another person’s drag where it puts the node, and sends this page’s own while it lasts', async () => {
    const page = openLive(owner);
    await screen.findByTestId('canvas-tile-b', {}, { timeout: 5000 });
    await hello(page, [ada()]);
    // Ada's edit lasts until its card has been seen where she holds it.
    holdClock();
    // Ada drags Build: it is carried where she holds it (a translate from its own place: no layout moves), the document
    // unchanged.
    await act(async () => { page.streams[0].push({ event: 'presence', data: { participant: ada({ preview: { nodes: [{ id: 'b', x: 900, y: 300 }] } }) } }); });
    await waitFor(() => expect(tileOf('b').style.translate).toBe('480px 300px'), { timeout: 3000 });
    expect(tileOf('b').style.left).toBe('420px');
    expect(page.writes.some(write => write.method === 'PATCH' || write.method === 'PUT')).toBe(false);
    // This page drags Plan: the drag goes in presence as it happens, and ends with the pointer.
    fireEvent.pointerDown(tileOf('a'), { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(window, { clientX: 40, clientY: 0 });
    fireEvent.pointerMove(window, { clientX: 80, clientY: 30 });
    await waitFor(() => expect(page.presence().some(sent => (sent.preview as { nodes?: { id: string }[] } | null)?.nodes?.[0]?.id === 'a')).toBe(true));
    fireEvent.pointerUp(window, { clientX: 80, clientY: 30 });
    await waitFor(() => expect(page.presence().at(-1)).toMatchObject({ preview: null }));
  });

  it('marks the person each avatar is, follows one with a click, and stops at Esc', async () => {
    // A stage with a size (jsdom measures none), so the camera has a screen to fit the followed one to.
    const measured = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const box = this.classList.contains('canvas-viewport') || this.classList.contains('canvas-root') ? { w: 1200, h: 800 } : { w: 0, h: 0 };
      return { x: 0, y: 0, left: 0, top: 0, right: box.w, bottom: box.h, width: box.w, height: box.h, toJSON() { return this; } } as DOMRect;
    });
    const page = openLive(owner);
    await screen.findByTestId('canvas-tile-b', {}, { timeout: 5000 });
    await hello(page, [ada({ viewport: { x: 2000, y: 1000, w: 800, h: 600 } }), ada({}, { id: 'page-ada-0002', device: 'browser' })]);
    // Ada's two pages are one person, with both devices.
    const follow = await screen.findByRole('button', { name: '跟随 Ada' });
    expect(follow.querySelector('.awwo-multiplayer-avatar')).toHaveAttribute('title', 'Ada · 浏览器、手机');
    const world = document.querySelector<HTMLElement>('.canvas-world')!;
    const before = world.style.transform;
    // Before it follows anyone, the page says what its own screen shows.
    await waitFor(() => expect(page.presence().some(sent => !!sent.viewport && typeof sent.viewport === 'object')).toBe(true));
    fireEvent.click(follow);
    expect(await screen.findByText('正在跟随 Ada')).toBeInTheDocument();
    await waitFor(() => expect(world.style.transform).not.toBe(before), { timeout: 3000 });
    // While it follows Ada, the page says it shows no screen of its own (so people who follow each other hold still).
    await waitFor(() => expect(page.presence().filter(sent => 'viewport' in sent).at(-1)?.viewport).toBeNull());
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByText('正在跟随 Ada')).toBeNull());
    expect(screen.getByRole('button', { name: '跟随 Ada' })).toHaveAttribute('aria-pressed', 'false');
    // Any move of the camera of this person's own ends it too, the toolbar's zoom included.
    fireEvent.click(screen.getByRole('button', { name: '跟随 Ada' }));
    expect(await screen.findByText('正在跟随 Ada')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '放大' }));
    await waitFor(() => expect(screen.queryByText('正在跟随 Ada')).toBeNull());
    measured.mockRestore();
  });

  it('ends following as one step of Escape: after what is open, before the selection, never for a key taken already', async () => {
    const measured = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const box = this.classList.contains('canvas-viewport') || this.classList.contains('canvas-root') ? { w: 1200, h: 800 } : { w: 0, h: 0 };
      return { x: 0, y: 0, left: 0, top: 0, right: box.w, bottom: box.h, width: box.w, height: box.h, toJSON() { return this; } } as DOMRect;
    });
    const page = openLive(owner);
    await screen.findByTestId('canvas-tile-b', {}, { timeout: 5000 });
    await hello(page, [ada({ viewport: { x: 2000, y: 1000, w: 800, h: 600 } })]);
    // Plan selected, then Ada followed.
    fireEvent.pointerDown(tileOf('a'), { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerUp(window, { clientX: 0, clientY: 0 });
    await waitFor(() => expect(tileOf('a')).toHaveClass('canvas-tile--selected'));
    fireEvent.click(await screen.findByRole('button', { name: '跟随 Ada' }));
    expect(await screen.findByText('正在跟随 Ada')).toBeInTheDocument();
    // An Escape something else took already (a dialog, a field) leaves both.
    const taken = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    taken.preventDefault();
    act(() => { window.dispatchEvent(taken); });
    expect(screen.getByText('正在跟随 Ada')).toBeInTheDocument();
    expect(tileOf('a')).toHaveClass('canvas-tile--selected');
    // One Escape ends following and keeps the selection; the next lets the selection go.
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByText('正在跟随 Ada')).toBeNull());
    expect(tileOf('a')).toHaveClass('canvas-tile--selected');
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(tileOf('a')).not.toHaveClass('canvas-tile--selected'));
    measured.mockRestore();
  });

  it('stops following for a glide of the camera of this person’s own (收敛)', async () => {
    const measured = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const box = this.classList.contains('canvas-viewport') || this.classList.contains('canvas-root') ? { w: 1200, h: 800 } : { w: 0, h: 0 };
      return { x: 0, y: 0, left: 0, top: 0, right: box.w, bottom: box.h, width: box.w, height: box.h, toJSON() { return this; } } as DOMRect;
    });
    const page = openLive(owner);
    await screen.findByTestId('canvas-tile-b', {}, { timeout: 5000 });
    await hello(page, [ada({ viewport: { x: 2000, y: 1000, w: 800, h: 600 } })]);
    fireEvent.click(await screen.findByRole('button', { name: '跟随 Ada' }));
    expect(await screen.findByText('正在跟随 Ada')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'g', ctrlKey: true });
    await waitFor(() => expect(screen.queryByText('正在跟随 Ada')).toBeNull());
    measured.mockRestore();
  });

  it('takes over a card someone else carries from where it is drawn, never back from its own place', async () => {
    const page = openLive(owner);
    await screen.findByTestId('canvas-tile-b', {}, { timeout: 5000 });
    await hello(page, [ada()]);
    // Ada's edit is one edit from here to the end: heard again below, it is the one this page took the card over from.
    holdClock();
    await act(async () => { page.streams[0].push({ event: 'presence', data: { participant: ada({ preview: { nodes: [{ id: 'b', x: 900, y: 300 }] } }) } }); });
    await waitFor(() => expect(tileOf('b').style.translate).toBe('480px 300px'), { timeout: 3000 });
    // This page grabs Build while Ada still holds it: it goes on from where it is drawn, its carry now its own place.
    fireEvent.pointerDown(tileOf('b'), { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(window, { clientX: 40, clientY: 0 });
    await waitFor(() => expect(tileOf('b').style.left).toBe('940px'));
    expect(tileOf('b').style.top).toBe('300px');
    expect(tileOf('b').style.translate).toBe('');
    await waitFor(() => expect(page.presence().some(sent => JSON.stringify(sent.preview) === JSON.stringify({ nodes: [{ id: 'b', x: 940, y: 300 }] }))).toBe(true));
    fireEvent.pointerUp(window, { clientX: 40, clientY: 0 });
    // Let go, it stays where this page put it: Ada's edit, heard again where it had the card, no longer carries it.
    await act(async () => { page.streams[0].push({ event: 'presence', data: { participant: ada({ preview: { nodes: [{ id: 'b', x: 900, y: 300 }] } }) } }); });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(tileOf('b').style.translate).toBe('');
    expect(tileOf('b').style.left).toBe('940px');
  });

  it('ends its own drag at its own pointer’s lift, and at a mouse let go outside the window', async () => {
    const page = openLive(owner);
    await screen.findByTestId('canvas-tile-b', {}, { timeout: 5000 });
    await hello(page, [ada()]);
    const dragging = () => page.presence().filter(sent => 'preview' in sent).at(-1)?.preview;
    const touch = (pointerId: number, isPrimary: boolean) => ({ pointerId, pointerType: 'touch', isPrimary });
    fireEvent.pointerDown(tileOf('a'), { button: 0, buttons: 1, clientX: 0, clientY: 0, ...touch(1, true) });
    fireEvent.pointerMove(window, { clientX: 40, clientY: 0, buttons: 1, ...touch(1, true) });
    // (Before this page's first post goes there is no preview to read at all, which is not a drag said yet.)
    await waitFor(() => expect(dragging() ?? null).not.toBeNull());
    await waitFor(() => expect(tileOf('a').style.left).not.toBe('0px'));
    const held = tileOf('a').style.left;
    // A second finger comes on Build, moves and goes: a press, never a drag, it moves nothing, and the drag goes on,
    // the first finger's still (its preview names Plan).
    const build = tileOf('b').style.left;
    fireEvent.pointerDown(tileOf('b'), { button: 0, buttons: 1, clientX: 500, clientY: 0, ...touch(2, false) });
    fireEvent.pointerMove(window, { clientX: 400, clientY: 300, buttons: 1, ...touch(2, false) });
    expect(tileOf('a').style.left).toBe(held);
    expect(tileOf('b').style.left).toBe(build);
    expect((dragging() as { nodes?: { id: string }[] } | null)?.nodes?.[0]?.id).toBe('a');
    // It is a press all the same: Build is selected now.
    await waitFor(() => expect(tileOf('b')).toHaveClass('canvas-tile--selected'));
    fireEvent.pointerUp(window, touch(2, false));
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(dragging()).not.toBeNull();
    fireEvent.pointerMove(window, { clientX: 80, clientY: 0, buttons: 1, ...touch(1, true) });
    await waitFor(() => expect(tileOf('a').style.left).not.toBe(held));
    fireEvent.pointerUp(window, touch(1, true));
    await waitFor(() => expect(dragging()).toBeNull());
    // A touch whose lift never came (the phone went to another app): the next first finger starts afresh, ending it.
    fireEvent.pointerDown(tileOf('a'), { button: 0, buttons: 1, clientX: 0, clientY: 0, ...touch(11, true) });
    fireEvent.pointerMove(window, { clientX: 30, clientY: 0, buttons: 1, ...touch(11, true) });
    await waitFor(() => expect(dragging()).not.toBeNull());
    fireEvent.pointerDown(window, { button: 0, buttons: 1, ...touch(12, true) });
    await waitFor(() => expect(dragging()).toBeNull());
    fireEvent.pointerUp(window, touch(12, true));
    // A mouse drag let go outside the window: its next move, with no button held, ends it, and a hover after moves
    // nothing and says nothing.
    const before = tileOf('a').style.left;
    fireEvent.pointerDown(tileOf('a'), { button: 0, buttons: 1, clientX: 0, clientY: 0, pointerId: 7, pointerType: 'mouse' });
    fireEvent.pointerMove(window, { clientX: 60, clientY: 0, buttons: 1, pointerId: 7, pointerType: 'mouse' });
    await waitFor(() => expect(dragging()).not.toBeNull());
    await waitFor(() => expect(tileOf('a').style.left).not.toBe(before));
    const dropped = tileOf('a').style.left;
    fireEvent.pointerMove(window, { clientX: 70, clientY: 0, buttons: 0, pointerId: 7, pointerType: 'mouse' });
    await waitFor(() => expect(dragging()).toBeNull());
    fireEvent.pointerMove(window, { clientX: 200, clientY: 50, buttons: 0, pointerId: 7, pointerType: 'mouse' });
    expect(tileOf('a').style.left).toBe(dropped);
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(dragging()).toBeNull();
    // A lift that never came, then the same mouse presses Build: Plan's drag is over, and only Build moves.
    fireEvent.pointerDown(tileOf('a'), { button: 0, buttons: 1, clientX: 0, clientY: 0, pointerId: 7, pointerType: 'mouse' });
    fireEvent.pointerMove(window, { clientX: 20, clientY: 0, buttons: 1, pointerId: 7, pointerType: 'mouse' });
    await waitFor(() => expect(tileOf('a').style.left).not.toBe(dropped));
    const plan = tileOf('a').style.left;
    const buildBefore = tileOf('b').style.left;
    fireEvent.pointerDown(tileOf('b'), { button: 0, buttons: 1, clientX: 500, clientY: 0, pointerId: 7, pointerType: 'mouse' });
    fireEvent.pointerMove(window, { clientX: 560, clientY: 0, buttons: 1, pointerId: 7, pointerType: 'mouse' });
    await waitFor(() => expect(tileOf('b').style.left).not.toBe(buildBefore));
    expect(tileOf('a').style.left).toBe(plan);
    fireEvent.pointerUp(window, { pointerId: 7, pointerType: 'mouse' });
  });

  it('sends a group drag with the grabbed card first', async () => {
    const page = openLive(owner);
    await screen.findByTestId('canvas-tile-b', {}, { timeout: 5000 });
    await hello(page, [ada()]);
    fireEvent.pointerDown(tileOf('a'), { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerUp(window, { clientX: 0, clientY: 0 });
    fireEvent.pointerDown(tileOf('b'), { button: 0, clientX: 0, clientY: 0, shiftKey: true });
    fireEvent.pointerMove(window, { clientX: 40, clientY: 0, shiftKey: true });
    await waitFor(() => expect(page.presence().some(sent => (sent.preview as { nodes?: { id: string }[] } | null)?.nodes?.length === 2)).toBe(true));
    const sent = page.presence().find(state => (state.preview as { nodes?: { id: string }[] } | null)?.nodes?.length === 2)!;
    expect((sent.preview as { nodes: { id: string }[] }).nodes.map(node => node.id)).toEqual(['b', 'a']);
    fireEvent.pointerUp(window, { clientX: 40, clientY: 0 });
  });

  it('keeps the cards a drag took at its first step, whatever the selection does meanwhile', async () => {
    const page = openLive(owner);
    await screen.findByTestId('canvas-tile-b', {}, { timeout: 5000 });
    await hello(page, [ada()]);
    const touch = (pointerId: number, isPrimary: boolean) => ({ pointerId, pointerType: 'touch', isPrimary });
    fireEvent.pointerDown(tileOf('a'), { button: 0, clientX: 0, clientY: 0, ...touch(1, true) });
    fireEvent.pointerUp(window, touch(1, true));
    fireEvent.pointerDown(tileOf('b'), { button: 0, buttons: 1, clientX: 0, clientY: 0, shiftKey: true, ...touch(1, true) });
    fireEvent.pointerMove(window, { clientX: 40, clientY: 0, buttons: 1, shiftKey: true, ...touch(1, true) });
    await waitFor(() => expect(tileOf('a').style.left).toBe('40px'));
    // A second finger taps Build alone: the selection is Build's now, and the drag still moves both.
    fireEvent.pointerDown(tileOf('b'), { button: 0, buttons: 1, clientX: 500, clientY: 0, ...touch(2, false) });
    fireEvent.pointerUp(window, touch(2, false));
    await waitFor(() => expect(tileOf('a')).not.toHaveClass('canvas-tile--selected'));
    expect(tileOf('b')).toHaveClass('canvas-tile--selected');
    fireEvent.pointerMove(window, { clientX: 80, clientY: 0, buttons: 1, shiftKey: true, ...touch(1, true) });
    await waitFor(() => expect(tileOf('a').style.left).toBe('80px'));
    expect(tileOf('b').style.left).toBe('500px');
    fireEvent.pointerUp(window, touch(1, true));
  });

  it('lets the whole gesture go with its card, and draws no wire from another pointer\'s port drag', async () => {
    const page = openLive(owner);
    await screen.findByTestId('canvas-tile-b', {}, { timeout: 5000 });
    await hello(page, [ada()]);
    const dragging = () => page.presence().filter(sent => 'preview' in sent).at(-1)?.preview as { nodes?: { id: string }[]; wire?: unknown } | null | undefined;
    const touch = (pointerId: number, isPrimary: boolean) => ({ pointerId, pointerType: 'touch', isPrimary });
    // Finger 1 drags Plan; a second finger's drag from Build's port draws no wire, and Plan's preview stays.
    fireEvent.pointerDown(tileOf('a'), { button: 0, buttons: 1, clientX: 0, clientY: 0, ...touch(1, true) });
    fireEvent.pointerMove(window, { clientX: 40, clientY: 0, buttons: 1, ...touch(1, true) });
    await waitFor(() => expect(dragging()?.nodes?.[0]?.id).toBe('a'));
    const port = tileOf('b').querySelector<HTMLElement>('.canvas-port')!;
    fireEvent.pointerDown(port, { button: 0, buttons: 1, clientX: 500, clientY: 0, ...touch(2, false) });
    fireEvent.pointerMove(port, { clientX: 600, clientY: 100, buttons: 1, ...touch(2, false) });
    fireEvent.pointerUp(port, { clientX: 600, clientY: 100, ...touch(2, false) });
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(page.presence().some(sent => !!(sent.preview as { wire?: unknown } | null)?.wire)).toBe(false);
    expect(dragging()?.nodes?.[0]?.id).toBe('a');
    // Plan is deleted mid-drag (Delete, its card selected): the gesture goes with it, and so does its preview; a
    // second finger then drags Build, and the first finger's lift leaves that drag alone.
    fireEvent.keyDown(window, { key: 'Delete', code: 'Delete' });
    await waitFor(() => expect(screen.queryByTestId('canvas-tile-a')).toBeNull());
    await waitFor(() => expect(dragging()).toBeNull());
    fireEvent.pointerDown(tileOf('b'), { button: 0, buttons: 1, clientX: 500, clientY: 0, ...touch(3, false) });
    fireEvent.pointerMove(window, { clientX: 540, clientY: 0, buttons: 1, ...touch(3, false) });
    await waitFor(() => expect(dragging()?.nodes?.[0]?.id).toBe('b'));
    fireEvent.pointerUp(window, touch(1, true));
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(dragging()?.nodes?.[0]?.id).toBe('b');
    fireEvent.pointerUp(window, touch(3, false));
    await waitFor(() => expect(dragging()).toBeNull());
  });

  it('ends a wire gesture whose lift never came, and one whose port went before it drew, so another can drag', async () => {
    const page = openLive(owner);
    await screen.findByTestId('canvas-tile-b', {}, { timeout: 5000 });
    await hello(page, [ada()]);
    const dragging = () => page.presence().filter(sent => 'preview' in sent).at(-1)?.preview as { nodes?: { id: string }[]; wire?: unknown } | null | undefined;
    const touch = (pointerId: number, isPrimary: boolean) => ({ pointerId, pointerType: 'touch', isPrimary });
    // A pen draws a wire from Build's port and is let go where the page never heard it: its next move, with no button
    // held, ends the wire, for the others too, and a finger can then drag Plan.
    const pen = { pointerId: 21, pointerType: 'pen' };
    const port = tileOf('b').querySelector<HTMLElement>('.canvas-port')!;
    fireEvent.pointerDown(port, { button: 0, buttons: 1, clientX: 500, clientY: 0, ...pen });
    fireEvent.pointerMove(port, { clientX: 600, clientY: 100, buttons: 1, ...pen });
    await waitFor(() => expect(!!dragging()?.wire).toBe(true));
    fireEvent.pointerMove(port, { clientX: 610, clientY: 110, buttons: 0, ...pen });
    await waitFor(() => expect(dragging()).toBeNull());
    const plan = tileOf('a').style.left;
    fireEvent.pointerDown(tileOf('a'), { button: 0, buttons: 1, clientX: 0, clientY: 0, ...touch(22, false) });
    fireEvent.pointerMove(window, { clientX: 40, clientY: 0, buttons: 1, ...touch(22, false) });
    await waitFor(() => expect(tileOf('a').style.left).not.toBe(plan));
    fireEvent.pointerUp(window, touch(22, false));
    await waitFor(() => expect(dragging()).toBeNull());
    // Plan's port is pressed, then Plan is deleted before the press draws anything: the gesture goes with its port,
    // and a finger can drag Build.
    fireEvent.pointerDown(tileOf('a'), { button: 0, clientX: 0, clientY: 0, pointerId: 23, pointerType: 'mouse' });
    fireEvent.pointerUp(window, { pointerId: 23, pointerType: 'mouse' });
    await waitFor(() => expect(tileOf('a')).toHaveClass('canvas-tile--selected'));
    fireEvent.pointerDown(tileOf('a').querySelector<HTMLElement>('.canvas-port')!, { button: 0, buttons: 1, clientX: 0, clientY: 0, ...touch(24, true) });
    fireEvent.keyDown(window, { key: 'Delete', code: 'Delete' });
    await waitFor(() => expect(screen.queryByTestId('canvas-tile-a')).toBeNull());
    const build = tileOf('b').style.left;
    fireEvent.pointerDown(tileOf('b'), { button: 0, buttons: 1, clientX: 500, clientY: 0, ...touch(25, false) });
    fireEvent.pointerMove(window, { clientX: 540, clientY: 0, buttons: 1, ...touch(25, false) });
    await waitFor(() => expect(tileOf('b').style.left).not.toBe(build));
    fireEvent.pointerUp(window, touch(25, false));
  });

  it('hears a wire\'s lift after its card left the screen, so the wire ends and another finger can drag', async () => {
    // A stage with a size, so a card the board pans away is culled (not mounted), its port button with it.
    const measured = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const box = this.classList.contains('canvas-viewport') || this.classList.contains('canvas-root') ? { w: 1200, h: 800 } : { w: 0, h: 0 };
      return { x: 0, y: 0, left: 0, top: 0, right: box.w, bottom: box.h, width: box.w, height: box.h, toJSON() { return this; } } as DOMRect;
    });
    const page = openLive(owner);
    await screen.findByTestId('canvas-tile-b', {}, { timeout: 5000 });
    await hello(page, [ada()]);
    const dragging = () => page.presence().filter(sent => 'preview' in sent).at(-1)?.preview as { wire?: unknown } | null | undefined;
    const touch = (pointerId: number, isPrimary: boolean) => ({ pointerId, pointerType: 'touch', isPrimary });
    const mouse = { pointerId: 1, pointerType: 'mouse' };
    const viewport = document.querySelector<HTMLElement>('.canvas-viewport')!;
    // jsdom finds no element at a point: the lift lands on no port.
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => null });
    const pan = (from: number, to: number) => {
      fireEvent.pointerDown(viewport, { button: 1, buttons: 4, clientX: from, clientY: 400, ...mouse });
      fireEvent.pointerMove(viewport, { buttons: 4, clientX: to, clientY: 400, ...mouse });
      fireEvent.pointerUp(viewport, { button: 1, clientX: to, clientY: 400, ...mouse });
    };
    // A finger draws a wire from Build's port; the mouse's middle button pans the board until Build is culled.
    fireEvent.pointerDown(tileOf('b').querySelector<HTMLElement>('.canvas-port')!, { button: 0, buttons: 1, clientX: 500, clientY: 0, ...touch(41, true) });
    fireEvent.pointerMove(window, { clientX: 600, clientY: 100, buttons: 1, ...touch(41, true) });
    await waitFor(() => expect(!!dragging()?.wire).toBe(true));
    pan(600, -9000);
    await waitFor(() => expect(screen.queryByTestId('canvas-tile-b')).toBeNull());
    // Its lift, wherever it comes, ends the wire, for the others too.
    fireEvent.pointerUp(window, { clientX: 700, clientY: 100, ...touch(41, true) });
    await waitFor(() => expect(dragging()).toBeNull());
    // The board panned back, a second finger drags Plan: nothing holds the canvas's gesture any more.
    pan(-9000, 600);
    await screen.findByTestId('canvas-tile-a', {}, { timeout: 5000 });
    const plan = tileOf('a').style.left;
    fireEvent.pointerDown(tileOf('a'), { button: 0, buttons: 1, clientX: 0, clientY: 0, ...touch(42, false) });
    fireEvent.pointerMove(window, { clientX: 40, clientY: 0, buttons: 1, ...touch(42, false) });
    await waitFor(() => expect(tileOf('a').style.left).not.toBe(plan));
    fireEvent.pointerUp(window, touch(42, false));
    Reflect.deleteProperty(document, 'elementFromPoint');
    measured.mockRestore();
  });

  it('ends a passive press whose lift never came when its pointer presses again', async () => {
    const page = openLive(owner);
    await screen.findByTestId('canvas-tile-b', {}, { timeout: 5000 });
    await hello(page, [ada()]);
    const touch = (pointerId: number, isPrimary: boolean) => ({ pointerId, pointerType: 'touch', isPrimary });
    // Finger 1 drags Plan; finger 2 presses Build (a press, not a drag) and its lift never comes; finger 1 lets go;
    // finger 2 then drags Plan and lifts. Build's press ended with finger 2's next press: its lift selects nothing.
    fireEvent.pointerDown(tileOf('a'), { button: 0, buttons: 1, clientX: 0, clientY: 0, ...touch(31, true) });
    fireEvent.pointerMove(window, { clientX: 40, clientY: 0, buttons: 1, ...touch(31, true) });
    fireEvent.pointerDown(tileOf('b'), { button: 0, buttons: 1, clientX: 500, clientY: 0, ...touch(32, false) });
    await waitFor(() => expect(tileOf('b')).toHaveClass('canvas-tile--selected'));
    fireEvent.pointerUp(window, touch(31, true));
    const plan = tileOf('a').style.left;
    // Finger 2 drags Plan to where its stale press on Build began (x 500) and lifts there: a press still listening
    // would take that lift, within its threshold, for a click on Build.
    fireEvent.pointerDown(tileOf('a'), { button: 0, buttons: 1, clientX: 40, clientY: 0, ...touch(32, false) });
    fireEvent.pointerMove(window, { clientX: 500, clientY: 0, buttons: 1, ...touch(32, false) });
    await waitFor(() => expect(tileOf('a').style.left).not.toBe(plan));
    await waitFor(() => expect(tileOf('b')).not.toHaveClass('canvas-tile--selected'));
    fireEvent.pointerUp(window, { clientX: 500, clientY: 0, ...touch(32, false) });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(tileOf('b')).not.toHaveClass('canvas-tile--selected');
  });

  it('takes over carried cards of a group on a first step that leaves the grabbed one where it is drawn', async () => {
    const page = openLive(owner);
    await screen.findByTestId('canvas-tile-b', {}, { timeout: 5000 });
    await hello(page, [ada()]);
    // Ada carries Plan 40 to the left and Build 20 to the right, and still does when this page grabs them.
    holdClock();
    await act(async () => { page.streams[0].push({ event: 'presence', data: { participant: ada({ preview: { nodes: [{ id: 'a', x: -40, y: 0 }, { id: 'b', x: 440, y: 0 }] } }) } }); });
    // Both have come to rest where Ada has them (a card goes on from where it is drawn, mid-glide too).
    await waitFor(() => expect(tileOf('b').style.translate).toBe('20px 0px'), { timeout: 3000 });
    await waitFor(() => expect(tileOf('a').style.translate).toBe('-40px 0px'), { timeout: 3000 });
    // This page selects both, and drags Plan 40 to the right: Plan lands on its own place again, Build goes on from where
    // it is drawn.
    fireEvent.pointerDown(tileOf('a'), { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerUp(window, { clientX: 0, clientY: 0 });
    fireEvent.pointerDown(tileOf('b'), { button: 0, clientX: 500, clientY: 0, shiftKey: true });
    fireEvent.pointerUp(window, { clientX: 500, clientY: 0, shiftKey: true });
    fireEvent.pointerDown(tileOf('a'), { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(window, { clientX: 40, clientY: 0 });
    await waitFor(() => expect(tileOf('b').style.left).toBe('480px'));
    expect(tileOf('a').style.left).toBe('0px');
    fireEvent.pointerUp(window, { clientX: 40, clientY: 0 });
  });

  it('keeps a person’s delivery drawer on their device, never in the shared document', async () => {
    const page = openLive(owner);
    await screen.findByTestId('canvas-tile-b', {}, { timeout: 5000 });
    await hello(page, []);
    fireEvent.click(screen.getByRole('button', { name: '打开 Build' }));
    const toggle = await screen.findByRole('button', { name: /收起交付物|展开交付物/ }, { timeout: 5000 });
    const open = toggle.getAttribute('aria-expanded') === 'true';
    fireEvent.click(toggle);
    await waitFor(() => expect(JSON.parse(canvasStorage().getItem(DRAWER_CHOICES_KEY) || '{}')).toEqual({ b: !open }));
    await new Promise(resolve => setTimeout(resolve, 1600));
    const sent = page.writes.filter(write => write.method === 'PATCH').flatMap(write => write.body.ops as { path: string[] }[]);
    expect(sent.some(op => op.path.includes('deliverablesOpen'))).toBe(false);
  });

  it('says the field this person types in, and marks the one someone else types in', async () => {
    const page = openLive(owner);
    await screen.findByTestId('canvas-tile-a', {}, { timeout: 5000 });
    await hello(page, [ada()]);
    fireEvent.click(screen.getByRole('button', { name: '打开 Plan' }));
    fireEvent.click(await screen.findByRole('button', { name: '配置' }, { timeout: 5000 }));
    const title = await screen.findByLabelText('名称', { selector: '#cv-cfg-title' }, { timeout: 5000 });
    fireEvent.focusIn(title);
    await waitFor(() => expect(page.presence().some(sent => JSON.stringify(sent.editing) === JSON.stringify({ node: 'a', field: 'title' }))).toBe(true));
    fireEvent.focusOut(title);
    await waitFor(() => expect(page.presence().at(-1)).toMatchObject({ editing: null }));
    await act(async () => { page.streams[0].push({ event: 'presence', data: { participant: ada({ editing: { node: 'a', field: 'persona' } }) } }); });
    expect(await screen.findByText('Ada 正在编辑这个组件')).toBeInTheDocument();
    expect(document.querySelector('#cv-cfg-persona')).toHaveAttribute('data-editing');
    expect(document.querySelector('#cv-cfg-persona')).toHaveAttribute('title', 'Ada 正在这里输入');
  });

  it('gives a viewer the live canvas: others’ changes arrive, and the people are in its header', async () => {
    const page = openLive(viewer);
    await screen.findByTestId('canvas-tile-b', {}, { timeout: 5000 });
    expect(page.streamUrls[0]).toContain('/live/events');
    await hello(page, [ada()]);
    expect(await screen.findByRole('button', { name: '同屏 · 2 人在线' })).toBeInTheDocument();
    await act(async () => {
      page.streams[0].push({ event: 'changes', data: { version: 4, actor: { kind: 'human', userId: 'user-ada', name: 'Ada', clientId: 'page-ada-0001' }, label: 'edit',
        ops: [{ op: 'set', path: ['nodes', 'b', 'title'], value: 'Built live' }], at: '' } });
    });
    await waitFor(() => expect(tileOf('b')).toHaveTextContent('Built live'), { timeout: 3000 });
    // A viewer makes no change of its own.
    expect(page.writes.some(write => write.method === 'PATCH' || write.method === 'PUT')).toBe(false);
  });
});

describe('the canvas\'s one gesture (cardGesture.ts)', () => {
  it('ends a pointer\'s passive press whose lift never came when that pointer presses again, or the board hears it press', () => {
    const release = holdCardGesture({ pointerId: 1, pointerType: 'touch', isPrimary: true }, () => release());
    const ended: string[] = [];
    const first = holdPassivePress({ pointerId: 2, pointerType: 'touch', isPrimary: false }, () => { ended.push('first'); first(); });
    // Its pointer presses again while the first still holds: refused again, and the first passive press ends before.
    expect(cardPressAllowed({ pointerId: 2, pointerType: 'touch', isPrimary: false })).toBe(false);
    expect(ended).toEqual(['first']);
    const second = holdPassivePress({ pointerId: 2, pointerType: 'touch', isPrimary: false }, () => { ended.push('second'); second(); });
    // A third passive press of the same pointer ends the second; the board's hearing of a press ends the third.
    const third = holdPassivePress({ pointerId: 2, pointerType: 'touch', isPrimary: false }, () => { ended.push('third'); third(); });
    expect(ended).toEqual(['first', 'second']);
    endPassivePress(2);
    expect(ended).toEqual(['first', 'second', 'third']);
    release();
  });
});
