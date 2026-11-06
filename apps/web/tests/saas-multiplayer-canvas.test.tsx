import { appearanceFixture } from './saas-appearance-fixture';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SaaSApp } from '../src/saas/SaaSApp';
import type { CanvasRecord, Tenant } from '../src/saas/api';
import { CANVAS_STORAGE_KEY, createSessionNode, emptyDocument, sanitizeDocument, type CanvasDocument } from '../src/canvas/canvasDoc';
import { canvasStorage } from '../src/canvas/canvasStorage';
import type { CanvasChange, CanvasOp } from '../src/canvas/multiplayer/types';
import { applyOps } from '../src/canvas/multiplayer/changes';

// 多人同屏 in the hosted app (useCanvasMultiplayer.tsx, canvasSync.ts): a page on a server that offers it saves by
// changes and takes others' changes from the live stream into the canvas, with no save of its own.

const tenant: Tenant = { id: 'tenant-mp', name: 'Workspace', role: 'owner', status: 'active', maxConcurrentRuns: 2, maxRunsPerDay: 10 };
const identity = { user: { id: 'user-mp', email: 'mp@example.test', name: 'Owner', platformRole: 'user' }, tenants: [tenant] };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const capabilities = (multiplayer: boolean) => ({
  skills: { enabled: true, maxNodeSkills: 4, maxNodeSkillBytes: 20480 }, memory: { enabled: true, maxRunItems: 0, maxRunBytes: 0, maxPerScope: 0 },
  webReader: { enabled: false, perDay: 0, usedToday: 0 }, render: { enabled: false, perDay: 0, usedToday: 0, limits: {} },
  ...(multiplayer ? { multiplayer: { enabled: true, maxChangeOps: 500 } } : {}),
});

type Frame = { event: string; data: unknown };
function scriptedStream() {
  const encoder = new TextEncoder();
  let push: (frame: Frame) => void = () => {};
  const body = new ReadableStream<Uint8Array>({ start(controller) { push = frame => controller.enqueue(encoder.encode(`event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`)); } });
  return { body, push: (frame: Frame) => push(frame) };
}

function canvasDocument(): CanvasDocument {
  const a = { ...createSessionNode('llm', { x: 0, y: 0 }), id: 'a', title: 'Plan' };
  const b = { ...createSessionNode('llm', { x: 420, y: 0 }), id: 'b', title: 'Build' };
  return sanitizeDocument({ ...emptyDocument(), view: { x: 10, y: 10, scale: 1 }, nodes: [a, b] });
}

beforeEach(() => {
  localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh');
  localStorage.setItem(`awwo.workmode.v1:${identity.user.id}`, 'completed');
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.setAttribute('open', ''); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.removeAttribute('open'); } });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function openLive(options: { multiplayer?: boolean; patch?: (body: { baseVersion: number; ops: CanvasOp[]; clientId: string }) => Response } = {}) {
  let cloud: CanvasRecord = { id: 'canvas-mp', tenantId: tenant.id, name: 'Live canvas', version: 3, document: canvasDocument(), createdAt: '', updatedAt: '' };
  const streams: ReturnType<typeof scriptedStream>[] = [];
  const streamUrls: string[] = [];
  const writes: { method: string; url: string; body: any }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = String(input);
    if (init.method && init.method !== 'GET') {
      const body = init.body ? JSON.parse(String(init.body)) : null;
      writes.push({ method: init.method, url, body });
      if (init.method === 'PATCH' && options.patch) return options.patch(body);
      if (init.method === 'POST' && url.endsWith('/live/presence')) return new Response(null, { status: 204 });
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
    if (url.endsWith('/capabilities')) return json(capabilities(options.multiplayer !== false));
    if (url.endsWith('/graph-runs')) return json({ items: [] });
    if (url.includes('/canvases/canvas-mp')) return json(cloud);
    return json({ items: [] });
  }));
  window.history.replaceState({}, '', `/?tenant=${tenant.id}&canvas=canvas-mp`);
  render(<SaaSApp />);
  const shown = () => JSON.parse(canvasStorage().getItem(CANVAS_STORAGE_KEY) || '{}') as CanvasDocument;
  return { streams, streamUrls, writes, shown, cloud: () => cloud, setCloud: (next: CanvasRecord) => { cloud = next; } };
}

const change = (version: number, ops: CanvasOp[], clientId = 'other-page-1', userId = 'user-other'): CanvasChange => ({ version, actor: { kind: 'human', name: 'Member', clientId, userId }, label: 'edit', ops, at: '2026-11-06T00:00:00Z' });
/** This page's own change, as the API answers it: its client id and the signed-in account. */
const ownChange = (version: number, ops: CanvasOp[], clientId: string) => change(version, ops, clientId, identity.user.id);
const participant = (id: string, name: string) => ({ id, kind: id.startsWith('t_') ? 'agent' : 'human', port: id.startsWith('t_') ? 'mcp' : 'web', name, color: '#0090ff', state: { selection: [], focus: null, cursor: null, status: null }, since: '' });
const quiet = (ms = 1500) => act(() => new Promise(resolve => setTimeout(resolve, ms)));

describe('a canvas page with 多人同屏', () => {
  it('opens the live stream from the version it opened, and shows who is here', async () => {
    const view = openLive();
    await screen.findByTestId('canvas-tile-a');
    await waitFor(() => expect(view.streams).toHaveLength(1));
    expect(view.streamUrls[0]).toContain('/api/v1/tenants/tenant-mp/canvases/canvas-mp/live/events?after=3&client=p');
    const you = new URL(view.streamUrls[0], 'http://localhost').searchParams.get('client')!;
    await act(async () => view.streams[0].push({ event: 'hello', data: { you: participant(you, 'Owner'), version: 3, participants: [participant(you, 'Owner'), participant('t_0123456789abcdef', 'Claude Code')], claims: [], messages: [] } }));
    expect(await screen.findByRole('button', { name: /同屏 · 2 人在线/ })).toBeTruthy();
  }, 30000);

  it('takes another participant’s change into the canvas with no save of its own', async () => {
    const view = openLive({ patch: () => json({ error: { code: 'unexpected' } }, 500) });
    await screen.findByTestId('canvas-tile-a');
    await waitFor(() => expect(view.streams).toHaveLength(1));
    await act(async () => view.streams[0].push({ event: 'changes', data: change(4, [{ op: 'set', path: ['nodes', 'a', 'title'], value: 'Plan by the member' }]) }));
    await waitFor(() => expect(screen.getByTestId('canvas-tile-a').textContent).toContain('Plan by the member'));
    await quiet(2500);
    expect(view.writes.filter(w => w.method === 'PATCH' || w.method === 'PUT')).toEqual([]);
    expect(view.shown().nodes.find(node => node.id === 'a')?.title).toBe('Plan by the member');
    // Its own camera stays its own.
    expect(view.shown().view).toEqual({ x: 10, y: 10, scale: 1 });
  }, 30000);

  it('sends a camera move as nothing, and an edit as exactly its ops on the version it holds', async () => {
    const answers: { baseVersion: number; ops: CanvasOp[] }[] = [];
    const view = openLive({
      patch: body => {
        answers.push(body);
        // Someone else's change came first at the server; the answer carries it and this page's own.
        const theirs = change(4, [{ op: 'set', path: ['nodes', 'b', 'title'], value: 'Build by the agent' }], 't_x');
        const mine = ownChange(5, body.ops, body.clientId);
        return json({ version: 5, results: body.ops.map(() => 'ok'), changes: [theirs, mine] });
      },
    });
    await screen.findByTestId('canvas-tile-a');
    await waitFor(() => expect(view.streams).toHaveLength(1));
    // A zoom changes the camera only: nothing goes.
    fireEvent.click(screen.getByRole('button', { name: '放大', exact: true }));
    await quiet(3000);
    expect(view.writes.filter(w => w.method === 'PATCH' || w.method === 'PUT')).toEqual([]);
    // A new node (a double click on the board) goes as one op.
    fireEvent.doubleClick(document.querySelector('.canvas-viewport')!, { clientX: 300, clientY: 300 });
    await waitFor(() => expect(answers).toHaveLength(1), { timeout: 8000 });
    const sent = answers[0];
    expect(sent.baseVersion).toBe(3);
    expect(sent.ops.length).toBeGreaterThanOrEqual(1);
    expect(sent.ops.every(op => op.path[0] === 'nodes' || op.path[0] === 'doc')).toBe(true);
    expect(sent.ops.some(op => op.path.includes('view') || op.path.includes('updatedAt'))).toBe(false);
    // The other participant's change in the answer reaches the canvas too.
    await waitFor(() => expect(screen.getByTestId('canvas-tile-b').textContent).toContain('Build by the agent'));
    await quiet(2500);
    expect(answers).toHaveLength(1);
  }, 40000);

  it('takes a saved edit back on undo, and sends that as a change too', async () => {
    const answers: { baseVersion: number; ops: CanvasOp[] }[] = [];
    let version = 3;
    const view = openLive({
      patch: body => {
        answers.push(body);
        version += 1;
        return json({ version, results: body.ops.map(() => 'ok'), changes: [ownChange(version, body.ops, body.clientId)] });
      },
    });
    await screen.findByTestId('canvas-tile-a');
    await waitFor(() => expect(view.streams).toHaveLength(1));
    const tiles = () => document.querySelectorAll('[data-testid^="canvas-tile-"].canvas-tile').length;
    expect(tiles()).toBe(2);
    fireEvent.doubleClick(document.querySelector('.canvas-viewport')!, { clientX: 300, clientY: 300 });
    await waitFor(() => expect(answers).toHaveLength(1), { timeout: 8000 });
    await waitFor(() => expect(tiles()).toBe(3));
    const created = answers[0].ops.find(op => op.op === 'set' && op.path.length === 2 && op.path[0] === 'nodes')!;
    expect(created).toBeTruthy();
    await quiet(600);
    // The save is answered: an undo still takes the new node back, and that goes as its own change.
    fireEvent.keyDown(window, { key: 'z', code: 'KeyZ', ctrlKey: true });
    await waitFor(() => expect(tiles()).toBe(2));
    await waitFor(() => expect(answers).toHaveLength(2), { timeout: 8000 });
    expect(answers[1].baseVersion).toBe(4);
    expect(answers[1].ops).toEqual([{ op: 'del', path: created.path }]);
  }, 40000);

  it('takes a change sent under its page id by another account as someone else’s', async () => {
    const view = openLive({ patch: () => json({ error: { code: 'unexpected' } }, 500) });
    await screen.findByTestId('canvas-tile-a');
    await waitFor(() => expect(view.streams).toHaveLength(1));
    const mine = new URL(view.streamUrls[0], 'http://localhost').searchParams.get('client')!;
    await act(async () => view.streams[0].push({ event: 'changes', data: change(4, [{ op: 'set', path: ['nodes', 'a', 'title'], value: 'Not mine' }], mine, 'user-copycat') }));
    await waitFor(() => expect(screen.getByTestId('canvas-tile-a').textContent).toContain('Not mine'));
    await quiet(2500);
    // Taken in as anyone else's change: nothing sent back to undo it.
    expect(view.writes.filter(w => w.method === 'PATCH' || w.method === 'PUT')).toEqual([]);
    expect(view.shown().nodes.find(node => node.id === 'a')?.title).toBe('Not mine');
  }, 30000);

  it('opens again with no drafts to review after others changed the canvas since', async () => {
    let view: ReturnType<typeof openLive>;
    view = openLive({
      patch: body => {
        const cloud = view.cloud();
        const version = cloud.version + 1;
        view.setCloud({ ...cloud, version, document: applyOps(cloud.document as object, body.ops).doc });
        return json({ version, results: body.ops.map(() => 'ok'), changes: [ownChange(version, body.ops, body.clientId)] });
      },
    });
    await screen.findByTestId('canvas-tile-a');
    await waitFor(() => expect(view.streams).toHaveLength(1));
    // An edit of this page's own, saved, and a camera move of its own.
    fireEvent.doubleClick(document.querySelector('.canvas-viewport')!, { clientX: 300, clientY: 300 });
    await waitFor(() => expect(view.writes.filter(w => w.method === 'PATCH')).toHaveLength(1), { timeout: 8000 });
    fireEvent.click(screen.getByRole('button', { name: '放大', exact: true }));
    await quiet(2500);
    cleanup();
    // Meanwhile someone else changed the canvas.
    const cloud = view.cloud();
    view.setCloud({ ...cloud, version: cloud.version + 1, document: applyOps(cloud.document as object, [{ op: 'set', path: ['nodes', 'b', 'title'], value: 'Build by the member' }]).doc });
    render(<SaaSApp />);
    await waitFor(() => expect(screen.getByTestId('canvas-tile-b').textContent).toContain('Build by the member'), { timeout: 8000 });
    expect(screen.queryByText('发现未同步的本机草稿')).toBeNull();
  }, 40000);

  it('keeps an edit the server held back unsynced, and the page waiting', async () => {
    const view = openLive({ patch: body => json({ version: 3, results: body.ops.map(() => 'node_running'), changes: [] }) });
    await screen.findByTestId('canvas-tile-a');
    await waitFor(() => expect(view.streams).toHaveLength(1));
    fireEvent.doubleClick(document.querySelector('.canvas-viewport')!, { clientX: 300, clientY: 300 });
    await waitFor(() => expect(view.writes.filter(w => w.method === 'PATCH')).toHaveLength(1), { timeout: 8000 });
    await quiet(1500);
    expect(screen.queryByText('已同步')).toBeNull();
    expect(screen.getByText('等待同步…')).toBeTruthy();
    // Leaving now asks first.
    const leaving = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(leaving);
    expect(leaving.defaultPrevented).toBe(true);
  }, 30000);

  it('saves whole documents on a server that does not offer it', async () => {
    const view = openLive({ multiplayer: false });
    await screen.findByTestId('canvas-tile-a');
    await quiet(800);
    expect(view.streams).toHaveLength(0);
    fireEvent.doubleClick(document.querySelector('.canvas-viewport')!, { clientX: 300, clientY: 300 });
    await waitFor(() => expect(view.writes.some(w => w.method === 'PUT')).toBe(true), { timeout: 8000 });
    expect(view.writes.some(w => w.method === 'PATCH')).toBe(false);
  }, 30000);
});
