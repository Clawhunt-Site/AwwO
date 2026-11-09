import { appearanceFixture } from './saas-appearance-fixture';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SaaSApp } from '../src/saas/SaaSApp';
import type { CanvasRecord, Tenant } from '../src/saas/api';
import { CANVAS_STORAGE_KEY, createSessionNode, emptyDocument, sanitizeDocument, type CanvasDocument, type CanvasEdge, type NodeOutput } from '../src/canvas/canvasDoc';
import { canvasStorage, canvasStorageKey } from '../src/canvas/canvasStorage';
import { applyOps, diffDocuments } from '../src/canvas/multiplayer/changes';
import type { CanvasChange, CanvasOp, ChangeActor } from '../src/canvas/multiplayer/types';
import type { GraphRunSnapshot } from '../src/saas/graphRuns';
import { setAdoptionPollForTests } from '../src/saas/runAdoption';
import { setLookTimeoutForTests } from '../src/saas/useRunLanding';
import { setCatchUpTimeoutForTests } from '../src/saas/useCanvasMultiplayer';
import { CANVAS_RUN_JOURNAL_KEY, clearRunJournal, loadRunJournal, saveRunJournal, type CanvasRunJournal } from '../src/canvas/runJournal';
import { runInputFingerprint } from '../src/canvas/runRecoveryDocument';
import { getSnapshot as sessionSnapshot, setHistory } from '../src/canvas/sessions';
import { graphRunSummary, graphRunWithoutDocument } from './saas-graph-run-summary-fixture';

// 多人同屏: a run whose starter's page closed before it ended lands on an open canvas (useRunLanding.ts): as a whole-document
// save on the version it was decided on, which the server records with no page's id, so this page too takes it in as
// someone else's change; a step whose result anyone changed since the run ended stays as the canvas shows it.

const tenant: Tenant = { id: 'tenant-mp', name: 'Workspace', role: 'owner', status: 'active', maxConcurrentRuns: 2, maxRunsPerDay: 10 };
const identity = { user: { id: 'user-mp', email: 'mp@example.test', name: 'Owner', platformRole: 'user' }, tenants: [tenant] };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const capabilities = {
  skills: { enabled: true, maxNodeSkills: 4, maxNodeSkillBytes: 20480 }, memory: { enabled: true, maxRunItems: 0, maxRunBytes: 0, maxPerScope: 0 },
  webReader: { enabled: false, perDay: 0, usedToday: 0 }, render: { enabled: false, perDay: 0, usedToday: 0, limits: {} },
  multiplayer: { enabled: true, maxChangeOps: 500 },
};
const RESTORED = '已从后台恢复运行结果。';
const member: ChangeActor = { kind: 'human', name: 'Member', clientId: 'page-member-1', userId: 'user-member' };

type Frame = { event: string; data: unknown };
function scriptedStream() {
  const encoder = new TextEncoder();
  let push: (frame: Frame) => void = () => {};
  const body = new ReadableStream<Uint8Array>({ start(controller) { push = frame => controller.enqueue(encoder.encode(`event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`)); } });
  return { body, push: (frame: Frame) => push(frame) };
}

const step = (id: string, x: number) => ({ ...createSessionNode('llm', { x, y: 0 }), id, title: `Step ${id}`, runtime: 'openai', model: 'qwen',
  binding: { companyId: tenant.id, agentId: `agent-${id}`, agentName: id } });
const steps = (ids: string[], edges: CanvasEdge[] = []) => sanitizeDocument({ ...emptyDocument(), view: { x: 10, y: 10, scale: 1 }, edges,
  nodes: ids.map((id, index) => step(id, index * 500)) });
const wire = (from: string, to: string): CanvasEdge => ({ id: `${from}-${to}`, fromNode: from, fromPort: 'result', toNode: to, toPort: 'context', dataType: 'text' });
const withOutputs = (document: CanvasDocument, outputs: Record<string, NodeOutput>) =>
  sanitizeDocument({ ...document, nodes: document.nodes.map(node => outputs[node.id] ? { ...node, lastOutput: outputs[node.id] } : node) });
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
/** A member's run of `scope` frozen on `frozen`, ended `endedAgo` ms ago: each node done with `${ID} delivered`, or as `failed` says. */
const endedRun = (frozen: CanvasDocument, scope: string[], failed: string[] = [], endedAgo = 20_000): GraphRunSnapshot => ({
  id: 'graph-member', operationId: 'operation-member', canvasId: 'canvas-mp', documentVersion: 3, document: frozen, scope,
  status: failed.length ? 'failed' : 'completed', createdAt: ago(endedAgo + 40_000), updatedAt: ago(endedAgo),
  nodes: scope.map(nodeId => failed.includes(nodeId) ? { nodeId, state: 'failed' as const, output: '' } : { nodeId, state: 'done' as const, output: `${nodeId.toUpperCase()} delivered` }),
});

/** The hosted page on a canvas the server keeps whole, with its change log and its runs. A page's change (PATCH) is its
 *  own; a whole-document save (PUT) on the canvas's current version is recorded with no page id, as the API does
 *  (resources.go updateCanvas: canvasActorOf(r, "")), and refused 409 on any other. `beforePut` runs first; `onGet` sees
 *  every read before it is answered; `fail` answers a read 502. The change log resets, as the API's does, past `logCap`
 *  changes at once (300, as canvasCatchUpMax; a smaller one stands for the API's 4 MiB of ops); the run list holds the
 *  newest 50, as graph_runs.go's. */
function openLanding(options: { document: CanvasDocument; version?: number; log?: CanvasChange[]; runs?: () => GraphRunSnapshot[];
  beforePut?: () => void; onGet?: (url: string) => void; hold?: (url: string) => boolean; fail?: (url: string) => boolean; logCap?: number;
  delay?: (url: string) => number; multiplayer?: boolean; refuseWrite?: (method: string, url: string) => boolean }) {
  let cloud: CanvasRecord = { id: 'canvas-mp', tenantId: tenant.id, name: 'Live canvas', version: options.version ?? 3, document: options.document, createdAt: '', updatedAt: '' };
  const log: CanvasChange[] = [...(options.log ?? [])];
  const streams: ReturnType<typeof scriptedStream>[] = [];
  const writes: { method: string; url: string; body: any }[] = [];
  const record = (ops: CanvasOp[], actor: ChangeActor, label: string, document: unknown, at = new Date().toISOString()) => {
    cloud = { ...cloud, version: cloud.version + 1, document };
    const made: CanvasChange = { version: cloud.version, actor, label, ops, at };
    log.push(made);
    return made;
  };
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = String(input);
    if (init.method && init.method !== 'GET') {
      const body = init.body ? JSON.parse(String(init.body)) : null;
      writes.push({ method: init.method, url, body });
      if (init.method === 'POST' && url.endsWith('/live/presence')) return new Response(null, { status: 204 });
      if (options.refuseWrite?.(init.method, url)) return json({ error: { code: 'invalid_input', message: 'Refused' } }, 400);
      if (init.method === 'POST' && /\/graph-runs\/operations\/[^/]+\/cancel$/.test(url)) return json({ confirmed: true, status: 'cancelled' });
      if (init.method === 'PATCH') {
        const after = applyOps(cloud.document as Record<string, unknown>, body.ops).doc;
        const ops = diffDocuments(cloud.document as object, after);
        if (ops.length) record(ops, { kind: 'human', name: 'Owner', clientId: body.clientId, userId: identity.user.id }, 'edit', after);
        return json({ version: cloud.version, results: body.ops.map(() => 'ok'), changes: log.filter(item => item.version > body.baseVersion) });
      }
      if (init.method === 'PUT') {
        options.beforePut?.();
        if (body.version !== cloud.version) return json({ error: { code: 'version_conflict', message: 'Canvas changed; reload before saving' } }, 409);
        record(diffDocuments(cloud.document as object, body.document), { kind: 'human', name: 'Owner', clientId: '', userId: identity.user.id }, 'save', body.document);
        return json(cloud);
      }
      return json({});
    }
    options.onGet?.(url);
    if (options.fail?.(url)) return json({ error: { code: 'bad_gateway', message: 'Upstream unavailable' } }, 502);
    const wait = options.delay?.(url) ?? 0;
    if (wait) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, wait);
        init.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('aborted', 'AbortError')); });
      });
    }
    // A read the server never answers, until the page lets it go (as the browser's fetch does).
    if (options.hold?.(url)) {
      await new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    }
    if (url.includes('/live/events')) {
      const stream = scriptedStream();
      streams.push(stream);
      return new Response(stream.body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    if (url.endsWith('/appearance')) return json(appearanceFixture);
    if (url.endsWith('/auth/me')) return json(identity);
    if (url.endsWith('/runtime')) return json({ available: false, configured: false, models: [] });
    if (url.endsWith('/capabilities')) return json(options.multiplayer === false ? { ...capabilities, multiplayer: { enabled: false, maxChangeOps: 0 } } : capabilities);
    const after = url.match(/\/canvases\/canvas-mp\/changes\?after=(\d+)$/);
    if (after) {
      if (cloud.version - Number(after[1]) > (options.logCap ?? 300)) return json({ version: cloud.version, reset: true, document: cloud.document });
      return json({ version: cloud.version, changes: log.filter(item => item.version > Number(after[1])) });
    }
    const runs = options.runs?.() ?? [];
    if (url.endsWith('/graph-runs')) return json({ items: runs.slice(0, 50).map(graphRunSummary) });
    const byOperation = url.match(/\/graph-runs\?operationId=([^&]+)$/);
    if (byOperation) return json({ items: runs.filter(item => item.operationId === decodeURIComponent(byOperation[1])).slice(0, 50).map(graphRunSummary) });
    const read = url.match(/\/graph-runs\/([^/?]+)(\?document=false)?$/);
    if (read) {
      const run = runs.find(item => item.id === decodeURIComponent(read[1]));
      if (!run) return json({ error: { code: 'not_found', message: 'No such run' } }, 404);
      return json(read[2] ? graphRunWithoutDocument(run) : run);
    }
    if (url.includes('/canvases/canvas-mp')) return json(cloud);
    return json({ items: [] });
  }));
  window.history.replaceState({}, '', `/?tenant=${tenant.id}&canvas=canvas-mp`);
  render(<SaaSApp />);
  const shown = () => JSON.parse(canvasStorage().getItem(CANVAS_STORAGE_KEY) || '{}') as CanvasDocument;
  return {
    streams, writes, shown, cloud: () => cloud,
    result: (id: string) => shown().nodes.find(node => node.id === id)?.lastOutput?.text,
    puts: () => writes.filter(item => item.method === 'PUT'),
    patches: () => writes.filter(item => item.method === 'PATCH'),
    /** A member's change at the server, on the page's live stream too. */
    others: async (ops: CanvasOp[]) => {
      const made = record(ops, member, 'edit', applyOps(cloud.document as Record<string, unknown>, ops).doc);
      await act(async () => streams.at(-1)?.push({ event: 'changes', data: made }));
    },
    /** A member's change at the server that no page hears of (none open, or its stream silent), at `at` by the server's clock. */
    serverChange: (ops: CanvasOp[], at?: number) => record(ops, member, 'edit', applyOps(cloud.document as Record<string, unknown>, ops).doc,
      at === undefined ? undefined : new Date(at).toISOString()),
    /** A change already at the server, on the page's live stream now. */
    push: async (version: number) => {
      const made = log.find(item => item.version === version);
      await act(async () => streams.at(-1)?.push({ event: 'changes', data: made }));
    },
    /** The page opened again (after `cleanup()`), on the same server. */
    reopen: () => render(<SaaSApp />),
  };
}

beforeEach(() => {
  localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh');
  localStorage.setItem(`awwo.workmode.v1:${identity.user.id}`, 'completed');
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.setAttribute('open', ''); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.removeAttribute('open'); } });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  setAdoptionPollForTests(200);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); setAdoptionPollForTests(null); setLookTimeoutForTests(null); setCatchUpTimeoutForTests(null); });

const quiet = (ms = 1500) => act(() => new Promise(resolve => setTimeout(resolve, ms)));
/** Whether the ops of a save are results of `ids` alone. */
const resultsOf = (ops: CanvasOp[], ids: string[]) => ops.length > 0
  && ops.every(op => op.path[0] === 'nodes' && ids.includes(op.path[1]) && ['lastOutput', 'issueId', 'threads'].includes(op.path[2]));

describe('a run whose starter’s page closed before it ended', () => {
  it('lands on the open canvas by one save on the version it was decided on, with no journal, badge or save of this page’s own', async () => {
    // The tests' localStorage is a plain object (tests/setup.ts): spied on itself, it shows every key the canvas writes.
    const setItem = vi.spyOn(localStorage, 'setItem');
    try {
      const frozen = steps(['a', 'b']);
      let runs: GraphRunSnapshot[] = [];
      const view = openLanding({ document: frozen, runs: () => runs });
      await screen.findByTestId('canvas-tile-a');
      await waitFor(() => expect(view.streams).toHaveLength(1));
      runs = [endedRun(frozen, ['a'])];
      await waitFor(() => expect(view.result('a')).toBe('A delivered'), { timeout: 15000 });
      const [put] = view.puts();
      expect(put.body.version).toBe(3);
      expect(resultsOf(diffDocuments(frozen, put.body.document), ['a'])).toBe(true);
      // The server took it as a change no page made; it came back to this page as someone else's.
      expect(view.cloud().version).toBe(4);
      expect(screen.getByText(RESTORED)).toBeTruthy();
      await quiet(1500);
      expect(view.puts()).toHaveLength(1);
      expect(view.patches()).toEqual([]);
      expect(setItem.mock.calls.some(([key]) => String(key).includes('awwo.canvas.active-run.v1'))).toBe(false);
      expect(screen.queryByTestId('canvas-tile-run-a')).toBeNull();
    } finally { setItem.mockRestore(); }
  }, 60000);

  it('stays through this page’s undo and redo of an edit it made before the run landed', async () => {
    const frozen = steps(['a', 'b']);
    let runs: GraphRunSnapshot[] = [];
    const view = openLanding({ document: frozen, runs: () => runs });
    await screen.findByTestId('canvas-tile-a');
    await waitFor(() => expect(view.streams).toHaveLength(1));
    // An edit of this page's own (a node added), saved: an undo step.
    fireEvent.doubleClick(document.querySelector('.canvas-viewport')!, { clientX: 300, clientY: 300 });
    await waitFor(() => expect(view.patches()).toHaveLength(1), { timeout: 8000 });
    const added = view.patches()[0].body.ops.find((op: CanvasOp) => op.op === 'set' && op.path.length === 2 && op.path[0] === 'nodes').path[1];
    await quiet(600);
    runs = [endedRun(frozen, ['a'])];
    await waitFor(() => expect(view.result('a')).toBe('A delivered'), { timeout: 15000 });
    await quiet(600);
    const stored = () => (view.cloud().document as CanvasDocument).nodes.find(node => node.id === 'a')?.lastOutput?.text;
    // The undo takes this page's node back and nothing else: the run's result stays, here and at the server.
    let sent = view.patches().length;
    fireEvent.keyDown(window, { key: 'z', code: 'KeyZ', ctrlKey: true });
    await waitFor(() => expect(view.shown().nodes.some(node => node.id === added)).toBe(false));
    await waitFor(() => expect(view.patches().length).toBeGreaterThan(sent), { timeout: 8000 });
    expect(view.patches().slice(sent).flatMap(patch => patch.body.ops)).toEqual([{ op: 'del', path: ['nodes', added] }]);
    expect(view.result('a')).toBe('A delivered');
    expect(stored()).toBe('A delivered');
    await quiet(600);
    // So does the redo.
    sent = view.patches().length;
    fireEvent.keyDown(window, { key: 'z', code: 'KeyZ', ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(view.shown().nodes.some(node => node.id === added)).toBe(true));
    await waitFor(() => expect(view.patches().length).toBeGreaterThan(sent), { timeout: 8000 });
    expect(view.patches().slice(sent).flatMap(patch => patch.body.ops).every((op: CanvasOp) => op.path[1] === added)).toBe(true);
    expect(view.result('a')).toBe('A delivered');
    expect(stored()).toBe('A delivered');
  }, 60000);

  it('stays through the redo of an edit this page undid before the run landed', async () => {
    const frozen = steps(['a', 'b']);
    let runs: GraphRunSnapshot[] = [];
    const view = openLanding({ document: frozen, runs: () => runs });
    await screen.findByTestId('canvas-tile-a');
    await waitFor(() => expect(view.streams).toHaveLength(1));
    fireEvent.doubleClick(document.querySelector('.canvas-viewport')!, { clientX: 300, clientY: 300 });
    await waitFor(() => expect(view.patches()).toHaveLength(1), { timeout: 8000 });
    const added = view.patches()[0].body.ops.find((op: CanvasOp) => op.op === 'set' && op.path.length === 2 && op.path[0] === 'nodes').path[1];
    await quiet(1000);
    // Undone before the run lands: the redo step (the canvas with the node) is older than the landing.
    fireEvent.keyDown(window, { key: 'z', code: 'KeyZ', ctrlKey: true });
    await waitFor(() => expect(view.shown().nodes.some(node => node.id === added)).toBe(false));
    await waitFor(() => expect(view.patches()).toHaveLength(2), { timeout: 8000 });
    runs = [endedRun(frozen, ['a'])];
    await waitFor(() => expect(view.result('a')).toBe('A delivered'), { timeout: 15000 });
    await quiet(600);
    const sent = view.patches().length;
    fireEvent.keyDown(window, { key: 'z', code: 'KeyZ', ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(view.shown().nodes.some(node => node.id === added)).toBe(true));
    await waitFor(() => expect(view.patches().length).toBeGreaterThan(sent), { timeout: 8000 });
    expect(view.patches().slice(sent).flatMap(patch => patch.body.ops).every((op: CanvasOp) => op.path[1] === added)).toBe(true);
    expect(view.result('a')).toBe('A delivered');
    expect((view.cloud().document as CanvasDocument).nodes.find(node => node.id === 'a')?.lastOutput?.text).toBe('A delivered');
  }, 60000);

  it('keeps a result published by hand since it ended on a step it failed, and the result downstream of that step', async () => {
    const edges = [wire('b', 'c')];
    const frozen = steps(['a', 'b', 'c'], edges);
    let runs: GraphRunSnapshot[] = [];
    const view = openLanding({ document: frozen, runs: () => runs });
    await screen.findByTestId('canvas-tile-a');
    await waitFor(() => expect(view.streams).toHaveLength(1));
    // a delivered and b failed; then, since it ended, a member published b by hand and c, downstream of b. Their clock runs
    // behind: what they stamped reads older than the run's end, which the server's log says it was not.
    const behind = Date.now() - 10 * 60_000;
    await view.others([{ op: 'set', path: ['nodes', 'b', 'lastOutput'], value: { text: 'B by hand', at: behind, source: 'manual' } }]);
    await view.others([{ op: 'set', path: ['nodes', 'c', 'lastOutput'], value: { text: 'C by hand', at: behind, source: 'manual' } }]);
    // Listed once both are in: the run ended 20 s before them.
    runs = [endedRun(frozen, ['a', 'b'], ['b'])];
    await waitFor(() => expect(view.result('a')).toBe('A delivered'), { timeout: 15000 });
    expect(view.result('b')).toBe('B by hand');
    expect(view.result('c')).toBe('C by hand');
    const [put] = view.puts();
    // On the canvas with both of the member's results: the save writes a's result alone.
    expect(put.body.version).toBe(5);
    expect(resultsOf(diffDocuments(withOutputs(frozen, { b: { text: 'B by hand', at: behind, source: 'manual' }, c: { text: 'C by hand', at: behind, source: 'manual' } }),
      put.body.document), ['a'])).toBe(true);
    await quiet(1500);
    expect(view.result('b')).toBe('B by hand');
    expect(view.result('c')).toBe('C by hand');
  }, 60000);

  it('is not landed by this page, nor said to be, when another page landed it first', async () => {
    const frozen = steps(['a', 'b']);
    let runs: GraphRunSnapshot[] = [];
    let first = true;
    let view: ReturnType<typeof openLanding>;
    // Another editor's page lands it a moment before this page's save reaches the server.
    view = openLanding({ document: frozen, runs: () => runs, beforePut: () => {
      if (!first) return;
      first = false;
      const cloud = view.cloud();
      const landed = withOutputs(cloud.document as CanvasDocument, { a: { text: 'A delivered', at: Date.parse(runs[0].createdAt), source: 'run' } });
      void view.others(diffDocuments(cloud.document as object, landed));
    } });
    await screen.findByTestId('canvas-tile-a');
    await waitFor(() => expect(view.streams).toHaveLength(1));
    runs = [endedRun(frozen, ['a'])];
    await waitFor(() => expect(view.puts()).toHaveLength(1), { timeout: 15000 });
    await waitFor(() => expect(view.result('a')).toBe('A delivered'), { timeout: 10000 });
    await quiet(2000);
    // Refused once (the canvas had moved on), then found landed: nothing sent again, nothing said.
    expect(view.puts()).toHaveLength(1);
    expect(view.cloud().version).toBe(4);
    expect(screen.queryByText(RESTORED)).toBeNull();
  }, 60000);

  it('that ended before the page opened, with a result by hand since on a step it failed, is left out of the opening’s lane and lands the rest', async () => {
    const setItem = vi.spyOn(localStorage, 'setItem');
    try {
      const frozen = steps(['a', 'b']);
      const runs = [endedRun(frozen, ['a', 'b'], ['b'], 5 * 60_000)];
      const byHand: NodeOutput = { text: 'B by hand', at: Date.now() - 60 * 60_000, source: 'manual' };
      const handed: CanvasChange = { version: 4, actor: member, label: 'edit', at: ago(2 * 60_000),
        ops: [{ op: 'set', path: ['nodes', 'b', 'lastOutput'], value: byHand }] };
      const view = openLanding({ document: withOutputs(frozen, { b: byHand }), version: 4, log: [handed], runs: () => runs });
      await screen.findByTestId('canvas-tile-a');
      await waitFor(() => expect(view.result('a')).toBe('A delivered'), { timeout: 15000 });
      expect(view.result('b')).toBe('B by hand');
      expect(view.puts()[0].body.version).toBe(4);
      expect(setItem.mock.calls.some(([key]) => String(key).includes('awwo.canvas.active-run.v1'))).toBe(false);
      await quiet(1500);
      expect(view.result('b')).toBe('B by hand');
    } finally { setItem.mockRestore(); }
  }, 60000);

  it('that ended before the page opened lands by a save on the version decided on, never through the opening’s lane', async () => {
    const setItem = vi.spyOn(localStorage, 'setItem');
    try {
      const frozen = steps(['a', 'b']);
      const runs = [endedRun(frozen, ['a', 'b'], [], 2 * 60_000)];
      const view = openLanding({ document: frozen, runs: () => runs });
      await screen.findByTestId('canvas-tile-a');
      await waitFor(() => expect(view.result('b')).toBe('B delivered'), { timeout: 15000 });
      expect(view.result('a')).toBe('A delivered');
      expect(view.puts()).toHaveLength(1);
      expect(view.puts()[0].body.version).toBe(3);
      expect(screen.getByText(RESTORED)).toBeTruthy();
      // No lane took it up: nothing a lane would land later, over what someone publishes meanwhile.
      expect(setItem.mock.calls.some(([key]) => String(key).includes('awwo.canvas.active-run.v1'))).toBe(false);
    } finally { setItem.mockRestore(); }
  }, 60000);

  it('that ended hours before the page opened still lands once the opening left it to the page', async () => {
    const frozen = steps(['a']);
    const runs = [endedRun(frozen, ['a'], [], 3 * 60 * 60_000)];
    const view = openLanding({ document: frozen, runs: () => runs });
    await screen.findByTestId('canvas-tile-a');
    await waitFor(() => expect(view.result('a')).toBe('A delivered'), { timeout: 15000 });
    expect(view.puts()).toHaveLength(1);
  }, 60000);

  it('leaves the steps a newer run took over between the page’s look and its save', async () => {
    const frozen = steps(['a', 'b']);
    const runs: GraphRunSnapshot[] = [];
    const view = openLanding({ document: frozen, runs: () => runs, onGet: url => {
      // As the page reads the run whole, a member starts a newer run over a and closes their page; it ends at once, and
      // neither its start nor its end moves the canvas's version.
      if (!url.endsWith('/graph-runs/graph-member') || runs.length !== 1) return;
      runs.unshift({ ...endedRun(frozen, ['a'], [], 0), id: 'graph-newer', operationId: 'operation-newer', createdAt: ago(0), updatedAt: ago(0),
        nodes: [{ nodeId: 'a', state: 'done', output: 'A again' }] });
    } });
    await screen.findByTestId('canvas-tile-a');
    await waitFor(() => expect(view.streams).toHaveLength(1));
    runs.push(endedRun(frozen, ['a', 'b']));
    await waitFor(() => expect(view.result('b')).toBe('B delivered'), { timeout: 15000 });
    await quiet(1500);
    // The older run's a never lands: the newer one's result is the one a takes.
    expect(view.puts().some(put => (put.body.document as CanvasDocument).nodes.find(node => node.id === 'a')?.lastOutput?.text === 'A delivered')).toBe(false);
    expect(view.result('a')).not.toBe('A delivered');
  }, 60000);

  it('reads the change log back past its newest few changes to find a result published by hand since the run ended', async () => {
    const frozen = steps(['a', 'b', 'c']);
    let runs: GraphRunSnapshot[] = [];
    const view = openLanding({ document: frozen, runs: () => runs });
    await screen.findByTestId('canvas-tile-a');
    await waitFor(() => expect(view.streams).toHaveLength(1));
    // After the run ended: b published by hand (a clock running behind stamped it long ago), then 25 moves of c.
    await view.others([{ op: 'set', path: ['nodes', 'b', 'lastOutput'], value: { text: 'B by hand', at: Date.now() - 60 * 60_000, source: 'manual' } }]);
    for (let x = 1; x <= 25; x += 1) await view.others([{ op: 'set', path: ['nodes', 'c', 'x'], value: 1000 + x }]);
    runs = [endedRun(frozen, ['a', 'b'], ['b'])];
    await waitFor(() => expect(view.result('a')).toBe('A delivered'), { timeout: 15000 });
    expect(view.result('b')).toBe('B by hand');
    await quiet(1500);
    expect(view.result('b')).toBe('B by hand');
  }, 60000);

  it('reopened in the browser whose journal holds it, lands by a save on the version decided on, never by that journal’s lane', async () => {
    const frozen = steps(['a', 'b']);
    let runs: GraphRunSnapshot[] = [];
    const view = openLanding({ document: frozen, runs: () => runs });
    await screen.findByTestId('canvas-tile-a');
    // This person started the run here and closed the page while it went; its journal stays on the device.
    const storage = canvasStorage();
    const going: CanvasRunJournal = { version: 1, id: 'operation-member', startedAt: Date.now() - 60_000, scope: ['a', 'b'],
      inputFingerprint: runInputFingerprint(frozen, ['a', 'b']), serverGraph: { tenantId: tenant.id, canvasId: 'canvas-mp', id: 'graph-member', documentVersion: 3 },
      nodes: Object.fromEntries(['a', 'b'].map(id => [id, { nodeId: id, threadId: 'default', companyId: tenant.id, agentId: `agent-${id}`, issueId: null, runId: null, state: 'running' as const }])) };
    expect(saveRunJournal(going, storage)).toBe(true);
    cleanup();
    // The run ended (b failed); since, a member published b by hand. The page had their change before it closed.
    runs = [endedRun(frozen, ['a', 'b'], ['b'])];
    view.serverChange([{ op: 'set', path: ['nodes', 'b', 'lastOutput'], value: { text: 'B by hand', at: Date.now(), source: 'manual' } }]);
    storage.setItem('awwo.cloud.version', String(view.cloud().version));
    storage.setItem(CANVAS_STORAGE_KEY, JSON.stringify(view.cloud().document));
    view.reopen();
    await screen.findByTestId('canvas-tile-a');
    await waitFor(() => expect(view.result('a')).toBe('A delivered'), { timeout: 15000 });
    expect(view.result('b')).toBe('B by hand');
    expect(view.puts()).toHaveLength(1);
    // Its outcome still shows here: the step that failed wears its badge.
    expect(screen.getByTestId('canvas-tile-run-b')).toBeTruthy();
    expect(loadRunJournal(storage)).toBeNull();
    await quiet(1500);
    expect(view.result('b')).toBe('B by hand');
    expect(view.patches().flatMap(patch => patch.body.ops as CanvasOp[]).some(op => op.path[1] === 'b')).toBe(false);
  }, 60000);

  it('looks again at its pace after a read the server never answers', async () => {
    setLookTimeoutForTests(1_000);
    const frozen = steps(['a']);
    let runs: GraphRunSnapshot[] = [];
    let reads = 0;
    // The page's first read of the run (only its look reads a run without its frozen canvas) is never answered.
    const view = openLanding({ document: frozen, runs: () => runs, hold: url => url.endsWith('/graph-runs/graph-member?document=false') && ++reads === 1 });
    await screen.findByTestId('canvas-tile-a');
    await waitFor(() => expect(view.streams).toHaveLength(1));
    runs = [endedRun(frozen, ['a'])];
    await waitFor(() => expect(view.result('a')).toBe('A delivered'), { timeout: 15000 });
    expect(reads).toBeGreaterThan(1);
  }, 60000);

  it('reads again the conversation of a landed step this page had loaded', async () => {
    const frozen = steps(['a']);
    let runs: GraphRunSnapshot[] = [];
    const reads: string[] = [];
    const view = openLanding({ document: frozen, runs: () => runs, onGet: url => { reads.push(url); } });
    await screen.findByTestId('canvas-tile-a');
    await waitFor(() => expect(view.streams).toHaveLength(1));
    await quiet(600);
    // a's conversation is loaded here (as when its chat was opened before the run ended).
    setHistory('a', 'loaded');
    runs = [{ ...endedRun(frozen, ['a']), nodes: [{ nodeId: 'a', state: 'done', output: 'A delivered', sessionId: 'session-run' }] }];
    await waitFor(() => expect(view.result('a')).toBe('A delivered'), { timeout: 15000 });
    // Read again in the run's session, which its turns joined.
    await waitFor(() => expect(reads.some(url => url.includes('session-run'))).toBe(true), { timeout: 5000 });
    expect(sessionSnapshot('a').history).toBe('loaded');
  }, 60000);

  /** This person's journal of a run of `ids` that was going when the page closed, in the canvas's own storage. */
  const journalOf = (frozen: CanvasDocument, ids: string[], graphId = 'graph-member', operationId = 'operation-member'): CanvasRunJournal => ({
    version: 1, id: operationId, startedAt: Date.now() - 60_000, scope: ids, inputFingerprint: runInputFingerprint(frozen, ids),
    serverGraph: { tenantId: tenant.id, canvasId: 'canvas-mp', id: graphId, documentVersion: 3 },
    nodes: Object.fromEntries(ids.map(id => [id, { nodeId: id, threadId: 'default', companyId: tenant.id, agentId: `agent-${id}`, issueId: null, runId: null, state: 'running' as const }])) });
  /** Opens the canvas, leaves `journal` on the device, closes the page, lets `meanwhile` happen at the server, and opens the
   *  page again with the device's copy of the canvas as the server holds it then. */
  async function reopenWith(view: ReturnType<typeof openLanding>, journal: CanvasRunJournal, meanwhile: () => void) {
    await screen.findByTestId('canvas-tile-a');
    const storage = canvasStorage();
    expect(saveRunJournal(journal, storage)).toBe(true);
    cleanup();
    meanwhile();
    storage.setItem('awwo.cloud.version', String(view.cloud().version));
    storage.setItem(CANVAS_STORAGE_KEY, JSON.stringify(view.cloud().document));
    view.reopen();
    await screen.findByTestId('canvas-tile-a');
    return storage;
  }
  const handB = { text: 'B by hand', at: Date.now(), source: 'manual' as const };

  it('reopened from its journal, applies nothing of it before the server answered for the run', async () => {
    const frozen = steps(['a', 'b']);
    let runs: GraphRunSnapshot[] = [];
    let wholeReads = 0;
    // The reopened page's first read of the run fails.
    const view = openLanding({ document: frozen, runs: () => runs, fail: url => url.endsWith('/graph-runs/graph-member') && ++wholeReads === 1 });
    const storage = await reopenWith(view, journalOf(frozen, ['a', 'b']), () => {
      runs = [endedRun(frozen, ['a', 'b'], ['b'])];
      view.serverChange([{ op: 'set', path: ['nodes', 'b', 'lastOutput'], value: handB }]);
    });
    await waitFor(() => expect(view.result('a')).toBe('A delivered'), { timeout: 15000 });
    expect(wholeReads).toBeGreaterThan(1);
    expect(view.result('b')).toBe('B by hand');
    expect(loadRunJournal(storage)).toBeNull();
    expect(view.patches().flatMap(patch => patch.body.ops as CanvasOp[]).some(op => op.path[1] === 'b')).toBe(false);
  }, 60000);

  it('reopened from a journal that never heard its run’s id, applies nothing of it before the server answered for the run', async () => {
    const frozen = steps(['a', 'b']);
    let runs: GraphRunSnapshot[] = [];
    let lookups = 0;
    // The run's admission answer was lost before the page closed: the reopened page finds the run by its operation, and
    // that first lookup fails.
    const view = openLanding({ document: frozen, runs: () => runs, fail: url => url.includes('/graph-runs?operationId=') && ++lookups === 1 });
    const { id: _never, ...admitted } = journalOf(frozen, ['a', 'b']).serverGraph!;
    const storage = await reopenWith(view, { ...journalOf(frozen, ['a', 'b']), serverGraph: admitted }, () => {
      runs = [endedRun(frozen, ['a', 'b'], ['b'])];
      view.serverChange([{ op: 'set', path: ['nodes', 'b', 'lastOutput'], value: handB }]);
    });
    await waitFor(() => expect(view.result('a')).toBe('A delivered'), { timeout: 15000 });
    expect(lookups).toBeGreaterThan(1);
    expect(view.result('b')).toBe('B by hand');
    expect(view.puts()).toHaveLength(1);
    expect(loadRunJournal(storage)).toBeNull();
    expect(view.patches().flatMap(patch => patch.body.ops as CanvasOp[]).some(op => op.path[1] === 'b')).toBe(false);
  }, 60000);

  it('lands a run whose journal another tab let go by a save on the version decided on, taking no tab’s copy of the canvas', async () => {
    const frozen = steps(['a', 'b']);
    const going: GraphRunSnapshot = { ...endedRun(frozen, ['a', 'b']), status: 'running', updatedAt: ago(1_000),
      nodes: [{ nodeId: 'a', state: 'running' }, { nodeId: 'b', state: 'running' }] };
    let runs: GraphRunSnapshot[] = [going];
    const view = openLanding({ document: frozen, runs: () => runs });
    const storage = await reopenWith(view, journalOf(frozen, ['a', 'b']), () => {});
    // The page follows the run while it goes: its steps' badges say so.
    await waitFor(() => expect(screen.getByTestId('canvas-tile-run-a').className).toContain('canvas-tile-badge--running'), { timeout: 15000 });
    await quiet(1000);
    // It ends (b failed), a member publishes b by hand, and another tab of this person, whose copy of the canvas on this
    // device is from before that, lets the journal go.
    runs = [endedRun(frozen, ['a', 'b'], ['b'], 12_000)];
    const older = view.cloud().document;
    await view.others([{ op: 'set', path: ['nodes', 'b', 'lastOutput'], value: handB }]);
    await quiet(300);
    // Another tab's writes reach this page as storage events (this page writes nothing of its own).
    act(() => {
      localStorage.setItem(canvasStorageKey(CANVAS_STORAGE_KEY), JSON.stringify(older));
      window.dispatchEvent(new StorageEvent('storage', { key: canvasStorageKey(CANVAS_STORAGE_KEY) }));
      clearRunJournal(storage, 'operation-member');
    });
    await waitFor(() => expect(view.puts()).toHaveLength(1), { timeout: 20000 });
    await quiet(2500);
    // That tab's copy is taken nowhere: b keeps the member's result, here and at the server, and a lands.
    expect(view.result('b')).toBe('B by hand');
    expect((view.cloud().document as CanvasDocument).nodes.find(node => node.id === 'b')?.lastOutput?.text).toBe('B by hand');
    expect(view.patches().flatMap(patch => patch.body.ops as CanvasOp[]).some(op => op.path[1] === 'b')).toBe(false);
    expect((view.cloud().document as CanvasDocument).nodes.find(node => node.id === 'a')?.lastOutput?.text).toBe('A delivered');
    expect(screen.queryByText('已恢复运行结果；未执行的下游可单独继续。')).toBeNull();
    // The run is over here too: no step of it still says it is running.
    for (const id of ['a', 'b']) expect(screen.queryByTestId(`canvas-tile-run-${id}`)?.className ?? '').not.toContain('canvas-tile-badge--running');
  }, 60000);

  it('lands a run whose journal another tab let go before this page heard the run’s id, finding it by its operation', async () => {
    const frozen = steps(['a']);
    let runs: GraphRunSnapshot[] = [];
    let lookups = 0;
    let found = false;
    // While this page watches, it never hears the run's id (each lookup by its operation fails).
    // The lookup that finds it answers after a moment, as over a network.
    const view = openLanding({ document: frozen, runs: () => runs, fail: url => url.includes('/graph-runs?operationId=') && !found && ++lookups > 0,
      delay: url => url.includes('/graph-runs?operationId=') ? 300 : 0 });
    const { id: _never, ...admitted } = journalOf(frozen, ['a']).serverGraph!;
    const storage = await reopenWith(view, { ...journalOf(frozen, ['a']), serverGraph: admitted }, () => {
      // It ended an hour ago: the page would not look at it by itself.
      runs = [endedRun(frozen, ['a'], [], 60 * 60_000)];
    });
    await waitFor(() => expect(lookups).toBeGreaterThan(1), { timeout: 10000 });
    // Another tab of this person lets the journal go; the run can be found again.
    act(() => { found = true; clearRunJournal(storage, 'operation-member'); });
    await waitFor(() => expect(view.result('a')).toBe('A delivered'), { timeout: 15000 });
    expect(view.puts()).toHaveLength(1);
    expect(screen.queryByText('已恢复运行结果；未执行的下游可单独继续。')).toBeNull();
  }, 60000);

  it('hands over a run whose journal another tab put in place of one this page watched, when its first read finds it ended', async () => {
    const frozen = steps(['a', 'b']);
    const first: GraphRunSnapshot = { ...endedRun(frozen, ['a']), id: 'graph-first', operationId: 'operation-first', status: 'running', updatedAt: ago(1_000),
      nodes: [{ nodeId: 'a', state: 'running' }] };
    let runs: GraphRunSnapshot[] = [first];
    const view = openLanding({ document: frozen, runs: () => runs });
    const storage = await reopenWith(view, journalOf(frozen, ['a'], 'graph-first', 'operation-first'), () => {});
    await waitFor(() => expect(screen.getByTestId('canvas-tile-run-a').className).toContain('canvas-tile-badge--running'), { timeout: 15000 });
    // Another tab of this person stops the first run and starts a second, whose journal takes the first one's place; that
    // tab closes, the second run ends (b failed), and a member publishes b by hand.
    act(() => {
      runs = [endedRun(frozen, ['a', 'b'], ['b']), { ...first, status: 'cancelled', nodes: [{ nodeId: 'a', state: 'cancelled' }] }];
      saveRunJournal(journalOf(frozen, ['a', 'b']), storage);
    });
    await view.others([{ op: 'set', path: ['nodes', 'b', 'lastOutput'], value: handB }]);
    await waitFor(() => expect(view.result('a')).toBe('A delivered'), { timeout: 15000 });
    expect(view.result('b')).toBe('B by hand');
    expect(view.puts()).toHaveLength(1);
    expect(view.patches().flatMap(patch => patch.body.ops as CanvasOp[]).some(op => op.path[1] === 'b')).toBe(false);
  }, 60000);

  it('leaves a run the list stops naming while its landing is decided: a newer run over its steps would not be seen', async () => {
    const frozen = sanitizeDocument({ ...steps(['a']), nodes: [...steps(['a']).nodes, step('z', 1000)] });
    const run = endedRun(frozen, ['a']);
    // As this page decides on the run, a newer run makes a again (done, never published), and fifty runs on z push both
    // out of the list.
    const again = { ...endedRun(frozen, ['a'], [], 2_000), id: 'graph-a-again', operationId: 'operation-a-again', createdAt: ago(8_000),
      nodes: [{ nodeId: 'a', state: 'done' as const, output: 'A made again' }] };
    const newer = Array.from({ length: 50 }, (_, index) => ({ ...endedRun(frozen, ['z'], [], 1_000), id: `graph-z-${index}`,
      operationId: `operation-z-${index}`, createdAt: ago(4_000) }));
    let runs: GraphRunSnapshot[] = [];
    let swapped = false;
    const view = openLanding({ document: frozen, runs: () => runs, onGet: url => {
      // The decision reads the canvas whole (its first read at opening came before the run ended).
      if (!swapped && runs.length && url.endsWith('/canvases/canvas-mp')) { swapped = true; runs = [...newer, again, run]; }
    } });
    await screen.findByTestId('canvas-tile-a');
    await waitFor(() => expect(view.streams).toHaveLength(1));
    runs = [run];
    await waitFor(() => expect(swapped).toBe(true), { timeout: 15000 });
    await quiet(2500);
    expect(view.puts()).toEqual([]);
    expect(view.result('a')).toBeUndefined();
  }, 60000);

  it('lets go of a run left to it only on the server’s newest version, and reads the conversation in the session it left there', async () => {
    // a shows an earlier run's result, in that run's session, and this page has its conversation loaded.
    const earlier = { text: 'A delivered', at: Date.now() - 3_600_000, source: 'run' as const };
    const frozen = steps(['a']);
    const shownBefore = sanitizeDocument({ ...frozen, nodes: frozen.nodes.map(node => ({ ...node, lastOutput: earlier, issueId: 'session-old' })) });
    const run = { ...endedRun(frozen, ['a']), nodes: [{ nodeId: 'a', state: 'done' as const, output: 'A delivered', sessionId: 'session-run' }] };
    let runs: GraphRunSnapshot[] = [];
    let armed = false;
    let landedElsewhere = false;
    const reads: string[] = [];
    const view = openLanding({ document: shownBefore, runs: () => runs, onGet: url => {
      reads.push(url);
      // Another page lands the run (the same text, its own session) just as this page's landing reads its outputs; this
      // page's stream is silent, and nothing has caught it up since.
      if (armed && !landedElsewhere && url.endsWith('/graph-runs/graph-member?document=false')) {
        landedElsewhere = true;
        view.serverChange([{ op: 'set', path: ['nodes', 'a', 'issueId'], value: 'session-run' }]);
      }
    } });
    await screen.findByTestId('canvas-tile-a');
    const storage = canvasStorage();
    expect(saveRunJournal(journalOf(frozen, ['a']), storage)).toBe(true);
    cleanup();
    runs = [run];
    storage.setItem('awwo.cloud.version', String(view.cloud().version));
    storage.setItem(CANVAS_STORAGE_KEY, JSON.stringify(view.cloud().document));
    armed = true;
    view.reopen();
    await screen.findByTestId('canvas-tile-a');
    setHistory('a', 'loaded');
    await waitFor(() => expect(landedElsewhere).toBe(true), { timeout: 10000 });
    await waitFor(() => expect(loadRunJournal(storage)).toBeNull(), { timeout: 10000 });
    // Its conversation is read again in the run's session, which this page learns of before it lets the run go.
    await waitFor(() => expect(reads.some(url => url.includes('session-run'))).toBe(true), { timeout: 15000 });
    expect(view.puts()).toEqual([]);
  }, 60000);

  it('lets go of a journal whose run the server never admitted once Stop is confirmed, applying nothing of it', async () => {
    const frozen = steps(['a', 'b']);
    const view = openLanding({ document: frozen, runs: () => [] });
    // The page that started it lost the admission's answer and closed; the server never admitted it, and since, a member
    // published b by hand.
    const { id: _never, ...admitted } = journalOf(frozen, ['a', 'b']).serverGraph!;
    const storage = await reopenWith(view, { ...journalOf(frozen, ['a', 'b']), serverGraph: admitted }, () => {
      view.serverChange([{ op: 'set', path: ['nodes', 'b', 'lastOutput'], value: handB }]);
    });
    // No run is found by its operation: the page keeps asking, until Stop.
    await quiet(3000);
    expect(view.result('b')).toBe('B by hand');
    fireEvent.click(screen.getByRole('button', { name: /停止/ }));
    await waitFor(() => expect(loadRunJournal(storage)).toBeNull(), { timeout: 10000 });
    await quiet(1500);
    expect(view.result('b')).toBe('B by hand');
    expect(view.patches().flatMap(patch => patch.body.ops as CanvasOp[]).some(op => op.path[1] === 'b')).toBe(false);
    expect(view.puts()).toEqual([]);
  }, 60000);

  it('lets go of a journal whose run the server never admitted once Stop is confirmed, without 多人同屏 too', async () => {
    const frozen = steps(['a', 'b']);
    const view = openLanding({ document: frozen, runs: () => [], multiplayer: false });
    const { id: _never, ...admitted } = journalOf(frozen, ['a', 'b']).serverGraph!;
    const storage = await reopenWith(view, { ...journalOf(frozen, ['a', 'b']), serverGraph: admitted }, () => {
      view.serverChange([{ op: 'set', path: ['nodes', 'b', 'lastOutput'], value: handB }]);
    });
    await quiet(3000);
    fireEvent.click(screen.getByRole('button', { name: /停止/ }));
    await waitFor(() => expect(loadRunJournal(storage)).toBeNull(), { timeout: 10000 });
    await quiet(2500);
    expect((view.cloud().document as CanvasDocument).nodes.find(node => node.id === 'b')?.lastOutput?.text).toBe('B by hand');
    expect(view.result('b')).toBe('B by hand');
  }, 60000);

  it('follows a journal another tab puts in the lane while it finds a run it never heard the id of, and hands that run over', async () => {
    const frozen = steps(['a', 'b']);
    // The run it watched ended an hour ago; the next one, of b, goes.
    const older = endedRun(frozen, ['a'], [], 60 * 60_000);
    const next: GraphRunSnapshot = { ...endedRun(frozen, ['b']), id: 'graph-next', operationId: 'operation-next', status: 'running', updatedAt: ago(1_000),
      nodes: [{ nodeId: 'b', state: 'running' }] };
    let runs: GraphRunSnapshot[] = [];
    let lookups = 0;
    let found = false;
    let replaced = false;
    const lookup = (url: string) => url.includes('/graph-runs?operationId=operation-member');
    const view = openLanding({ document: frozen, runs: () => runs, fail: url => lookup(url) && !found && ++lookups > 0,
      delay: url => lookup(url) ? 600 : 0, onGet: url => {
        // While this page finds the run by its operation, another tab starts the next run, whose journal takes the lane.
        if (found && !replaced && lookup(url)) {
          replaced = true;
          runs = [next, older];
          saveRunJournal(journalOf(frozen, ['b'], 'graph-next', 'operation-next'), canvasStorage());
          window.dispatchEvent(new StorageEvent('storage', { key: canvasStorageKey(CANVAS_RUN_JOURNAL_KEY) }));
        }
      } });
    const { id: _never, ...admitted } = journalOf(frozen, ['a']).serverGraph!;
    const storage = await reopenWith(view, { ...journalOf(frozen, ['a']), serverGraph: admitted }, () => { runs = [older]; });
    await waitFor(() => expect(lookups).toBeGreaterThan(1), { timeout: 10000 });
    // Another tab of this person lets the journal go.
    act(() => { found = true; clearRunJournal(storage, 'operation-member'); });
    // The run it found lands; the page follows the next run, which still goes.
    await waitFor(() => expect(view.result('a')).toBe('A delivered'), { timeout: 15000 });
    expect(replaced).toBe(true);
    await quiet(3000);
    expect(screen.getByTestId('canvas-tile-run-b').className).toContain('canvas-tile-badge--running');
    expect(loadRunJournal(storage)?.id).toBe('operation-next');
  }, 60000);

  it('reads a run whole only once this page could land it: not while a save of its own failed', async () => {
    const frozen = steps(['a']);
    let runs: GraphRunSnapshot[] = [];
    const reads: string[] = [];
    // This page's own saves are refused.
    const view = openLanding({ document: frozen, runs: () => runs, onGet: url => { reads.push(url); }, refuseWrite: method => method === 'PATCH' });
    await screen.findByTestId('canvas-tile-a');
    await waitFor(() => expect(view.streams).toHaveLength(1));
    fireEvent.doubleClick(document.querySelector('.canvas-viewport')!, { clientX: 300, clientY: 300 });
    await waitFor(() => expect(view.patches().length).toBeGreaterThan(0), { timeout: 8000 });
    await quiet(600);
    runs = [endedRun(frozen, ['a'])];
    await waitFor(() => expect(reads.some(url => url.endsWith('/graph-runs/graph-member?document=false'))).toBe(true), { timeout: 15000 });
    await quiet(2000);
    // Its outputs were read (cheap), the run whole never: it could not land while the page's save stands failed.
    expect(reads.some(url => url.endsWith('/graph-runs/graph-member'))).toBe(false);
    expect(view.puts()).toEqual([]);
  }, 60000);

  it('lands a run on a page behind after a catch-up of its that never answered', async () => {
    setCatchUpTimeoutForTests(1_000);
    const frozen = steps(['a', 'z']);
    let runs: GraphRunSnapshot[] = [];
    let armed = false;
    // A catch-up this page starts (its stream says it missed changes) is never answered, until the page lets it go.
    const view = openLanding({ document: frozen, runs: () => runs, hold: url => armed && /\/changes\?after=\d+$/.test(url) && !(armed = false) });
    await screen.findByTestId('canvas-tile-a');
    await waitFor(() => expect(view.streams).toHaveLength(1));
    await quiet(600);
    armed = true;
    await act(async () => view.streams.at(-1)?.push({ event: 'reset', data: { version: view.cloud().version } }));
    await quiet(300);
    // The run ends, and the canvas moves at the server without this page hearing of it: the landing has to catch up.
    runs = [endedRun(frozen, ['a'])];
    view.serverChange([{ op: 'set', path: ['nodes', 'z', 'title'], value: 'Step z renamed' }]);
    await waitFor(() => expect(view.result('a')).toBe('A delivered'), { timeout: 30000 });
    expect(view.puts()).toHaveLength(1);
  }, 60000);

  it('lets go of a run left to it on a canvas that keeps changing, once the run still holds nothing it lacks', async () => {
    // Another page landed the run before this page opened: a shows its result, in its session.
    const frozen = sanitizeDocument({ ...steps(['a']), nodes: [...steps(['a']).nodes, step('z', 1000)] });
    const delivered = sanitizeDocument({ ...frozen, nodes: frozen.nodes.map(node => node.id === 'a'
      ? { ...node, lastOutput: { text: 'A delivered', at: Date.now() - 5_000, source: 'run' as const }, issueId: 'session-run' } : node) });
    const run = { ...endedRun(frozen, ['a']), nodes: [{ nodeId: 'a', state: 'done' as const, output: 'A delivered', sessionId: 'session-run' }] };
    let runs: GraphRunSnapshot[] = [];
    let armed = false;
    let edits = 0;
    const reads: string[] = [];
    const view = openLanding({ document: delivered, runs: () => runs, onGet: url => {
      reads.push(url);
      // Someone edits z as each catch-up of this page goes out: the canvas moves under every one.
      if (armed && /\/changes\?after=\d+$/.test(url)) view.serverChange([{ op: 'set', path: ['nodes', 'z', 'title'], value: `Z ${++edits}` }]);
    } });
    await screen.findByTestId('canvas-tile-a');
    const storage = canvasStorage();
    expect(saveRunJournal(journalOf(frozen, ['a']), storage)).toBe(true);
    cleanup();
    runs = [run];
    storage.setItem('awwo.cloud.version', String(view.cloud().version));
    storage.setItem(CANVAS_STORAGE_KEY, JSON.stringify(view.cloud().document));
    view.reopen();
    await screen.findByTestId('canvas-tile-a');
    setHistory('a', 'loaded');
    armed = true;
    await waitFor(() => expect(loadRunJournal(storage)).toBeNull(), { timeout: 10000 });
    await waitFor(() => expect(reads.some(url => url.includes('sessions/session-run/messages'))).toBe(true), { timeout: 15000 });
    expect(view.puts()).toEqual([]);
  }, 60000);

  it('reads again a loaded conversation of a step of the run it handed over, which the tab that let it go had landed', async () => {
    const frozen = steps(['a']);
    const going: GraphRunSnapshot = { ...endedRun(frozen, ['a']), status: 'running', updatedAt: ago(1_000), nodes: [{ nodeId: 'a', state: 'running' }] };
    let runs: GraphRunSnapshot[] = [going];
    const reads: string[] = [];
    const view = openLanding({ document: frozen, runs: () => runs, onGet: url => { reads.push(url); } });
    const storage = await reopenWith(view, journalOf(frozen, ['a']), () => {});
    await waitFor(() => expect(screen.getByTestId('canvas-tile-run-a').className).toContain('canvas-tile-badge--running'), { timeout: 15000 });
    // a's conversation is loaded here (its chat was opened while the run went).
    setHistory('a', 'loaded');
    // The run ends; the other tab, which watched it too, lands it (a change of that page's own) and lets the journal go.
    act(() => {
      runs = [{ ...endedRun(frozen, ['a']), nodes: [{ nodeId: 'a', state: 'done', output: 'A delivered', sessionId: 'session-run' }] }];
      view.serverChange([{ op: 'set', path: ['nodes', 'a', 'lastOutput'], value: { text: 'A delivered', at: Date.now(), source: 'run' } },
        { op: 'set', path: ['nodes', 'a', 'issueId'], value: 'session-run' }]);
      clearRunJournal(storage, 'operation-member');
    });
    await view.push(view.cloud().version);
    await waitFor(() => expect(view.result('a')).toBe('A delivered'), { timeout: 5000 });
    // a's conversation is read again in the run's session, which its turns joined; nothing is saved here.
    await waitFor(() => expect(reads.some(url => url.includes('session-run'))).toBe(true), { timeout: 15000 });
    expect(view.puts()).toEqual([]);
    expect(view.patches()).toEqual([]);
  }, 60000);

  it('leaves a run its journal held that the run list no longer names (it lists the newest 50): a newer run over its steps would not be seen', async () => {
    const frozen = sanitizeDocument({ ...steps(['a', 'b']), nodes: [...steps(['a', 'b']).nodes, step('z', 1000)] });
    const old = { ...endedRun(frozen, ['a', 'b'], ['b'], 90 * 60_000), id: 'graph-old', operationId: 'operation-old', createdAt: ago(120 * 60_000) };
    // A newer run made a again (done, never published), and fifty runs since have pushed both out of the list.
    const again = { ...endedRun(frozen, ['a'], [], 80 * 60_000), id: 'graph-a-again', operationId: 'operation-a-again', createdAt: ago(85 * 60_000),
      nodes: [{ nodeId: 'a', state: 'done' as const, output: 'A made again' }] };
    const newer = Array.from({ length: 50 }, (_, index) => ({ ...endedRun(frozen, ['z'], [], 60 * 60_000), id: `graph-z-${index}`,
      operationId: `operation-z-${index}`, createdAt: ago(61 * 60_000) }));
    let runs: GraphRunSnapshot[] = [];
    let lists = 0;
    const view = openLanding({ document: frozen, runs: () => runs, onGet: url => { if (url.endsWith('/graph-runs')) lists += 1; } });
    const storage = await reopenWith(view, journalOf(frozen, ['a', 'b'], 'graph-old', 'operation-old'), () => { runs = [...newer, again, old]; });
    // The page hands the run over (its journal goes), and its host leaves it as the canvas shows it.
    await waitFor(() => expect(loadRunJournal(storage)).toBeNull(), { timeout: 15000 });
    const handed = lists;
    await waitFor(() => expect(lists).toBeGreaterThan(handed + 2), { timeout: 15000 });
    expect(view.result('a')).toBeUndefined();
    expect(view.puts()).toEqual([]);
    expect(view.patches()).toEqual([]);
  }, 60000);

  it('reads the log back a step at a time from the server’s own version when this page is far behind', async () => {
    const frozen = steps(['a', 'b', 'c']);
    let runs: GraphRunSnapshot[] = [];
    // The API answers at most 100 changes at once here (as it does 4 MiB of their ops).
    const view = openLanding({ document: frozen, runs: () => runs, logCap: 100 });
    await screen.findByTestId('canvas-tile-a');
    await waitFor(() => expect(view.streams).toHaveLength(1));
    // While this page's stream is silent: 257 moves before the run ended, b by hand after it (stamped by a clock running
    // behind), then 69 moves.
    const ended = Date.now() - 20_000;
    for (let x = 0; x < 257; x += 1) view.serverChange([{ op: 'set', path: ['nodes', 'c', 'x'], value: 1000 + x }], ended - 5 * 60_000);
    view.serverChange([{ op: 'set', path: ['nodes', 'b', 'lastOutput'], value: { text: 'B by hand', at: ended - 60 * 60_000, source: 'manual' } }], ended + 10_000);
    for (let x = 0; x < 69; x += 1) view.serverChange([{ op: 'set', path: ['nodes', 'c', 'x'], value: 2000 + x }], ended + 19_000);
    runs = [endedRun(frozen, ['a', 'b'], ['b'], 20_000)];
    await waitFor(() => expect(view.result('a')).toBe('A delivered'), { timeout: 20000 });
    expect(view.result('b')).toBe('B by hand');
  }, 60000);

  it('looks again at a run whose results it took for shown on a canvas it held behind', async () => {
    const frozen = steps(['a']);
    // This page shows a's earlier result, the same text the run will make.
    const view = openLanding({ document: withOutputs(frozen, { a: { text: 'A delivered', at: Date.now() - 60 * 60_000, source: 'run' } }), runs: () => runs });
    let runs: GraphRunSnapshot[] = [];
    await screen.findByTestId('canvas-tile-a');
    await waitFor(() => expect(view.streams).toHaveLength(1));
    // At the server, unheard here yet: a member clears a, and a run of a, admitted then, ends with that same text.
    view.serverChange([{ op: 'set', path: ['nodes', 'a', 'lastOutput'], value: null }]);
    runs = [{ ...endedRun(steps(['a']), ['a']), documentVersion: 4 }];
    await quiet(1500);
    expect(view.puts()).toEqual([]);
    // Once this page hears of the clearing, the run's result is missing and lands.
    await view.push(4);
    await waitFor(() => expect(view.puts()).toHaveLength(1), { timeout: 15000 });
    expect(view.result('a')).toBe('A delivered');
  }, 60000);

  it('reads a landed step’s conversation again only once this page holds what the landing made', async () => {
    const frozen = steps(['a']);
    let runs: GraphRunSnapshot[] = [];
    let saved = false;
    const reads: string[] = [];
    // Once the landing is saved, the page cannot read the changes again, and its stream is silent until told.
    const view = openLanding({ document: frozen, runs: () => runs, beforePut: () => { saved = true; }, onGet: url => { reads.push(url); },
      fail: url => saved && url.includes('/changes?after=') });
    await screen.findByTestId('canvas-tile-a');
    await waitFor(() => expect(view.streams).toHaveLength(1));
    await quiet(600);
    setHistory('a', 'loaded');
    runs = [{ ...endedRun(frozen, ['a']), nodes: [{ nodeId: 'a', state: 'done', output: 'A delivered', sessionId: 'session-run' }] }];
    await waitFor(() => expect(view.puts()).toHaveLength(1), { timeout: 15000 });
    await quiet(1500);
    expect(reads.some(url => url.includes('session-run'))).toBe(false);
    // The landing's change reaches the page: a now names the run's session, and its conversation is read there.
    await view.push(4);
    await waitFor(() => expect(view.result('a')).toBe('A delivered'), { timeout: 5000 });
    await waitFor(() => expect(reads.some(url => url.includes('session-run'))).toBe(true), { timeout: 5000 });
  }, 60000);
});
