// What opening a large canvas costs React, kept small (React error #185 on a 142-node canvas, 2026-10-19).
//
// Every tile restores its history on open, each in a render of its own (its transcript store is read through
// useSyncExternalStore), and each then reports its transcript's last line for the document to keep. Written one by
// one, every report re-rendered and saved the whole canvas, and run after run of them, each leaving the next document
// write pending, was counted by React as an update loop. What keeps that from coming back:
//   1. the reports of tiles that settle together are written together, in one machine write (and before anything that
//      takes no edit for a while or compares whole documents: a run, a node setup, a plan);
//   2. a tile re-renders only when something it shows changed (its props keep their identity);
//   3. the canvas's plan revision, a hash of the whole document, is worked out once per document, not per render;
//   4. an opening canvas mounts only the tiles its first camera shows, so only those read their histories.
import { createElement, memo, type ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { CanvasSurface } from '../src/canvas/CanvasSurface';
import { CANVAS_STORAGE_KEY, createSessionNode, type CanvasDocument, type SessionNode } from '../src/canvas/canvasDoc';
import { canvasPlanRevision } from '../src/canvas/canvasPlan';
import type { CanvasPlan } from '../src/canvas/canvasPlan';
import type { requestCanvasPlan } from '../src/canvas/canvasPlanning';
import { updateNodeDraft } from '../src/canvas/nodeThreads';
import { edgeId } from '../src/canvas/ports';
import { CANVAS_RUN_JOURNAL_KEY } from '../src/canvas/runJournal';
import { forgetNode } from '../src/canvas/sessionTransport';
import { getSnapshot, resetAllSessions } from '../src/canvas/sessions';
import { useWiring } from '../src/canvas/TilePorts';

const counts = vi.hoisted(() => ({ tiles: new Map<string, number>() }));

vi.mock('../src/canvas/SessionTile', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/canvas/SessionTile')>();
  const Real = actual.SessionTile;
  // The same memo the tile has: a render counted here is one the real tile's memo let through.
  const Counted = memo((props: ComponentProps<typeof Real>) => {
    counts.tiles.set(props.node.id, (counts.tiles.get(props.node.id) ?? 0) + 1);
    return createElement(Real, props);
  });
  return { ...actual, SessionTile: Counted };
});

vi.mock('../src/canvas/canvasPlan', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/canvas/canvasPlan')>();
  return { ...actual, canvasPlanRevision: vi.fn(actual.canvasPlanRevision) };
});

class SilentResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const mod = { ctrlKey: true, bubbles: true, cancelable: true } as const;
const quiet = (ms: number) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });
const stored = () => JSON.parse(localStorage.getItem(CANVAS_STORAGE_KEY)!) as CanvasDocument;
const reply = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });

/** How many of the canvas's saves changed what its tiles keep as their last line. */
function previewWrites(spy: { mock: { calls: unknown[][] } }): number {
  let last = '';
  let changes = 0;
  for (const [key, value] of spy.mock.calls) {
    if (key !== CANVAS_STORAGE_KEY) continue;
    const previews = JSON.stringify((JSON.parse(String(value)) as CanvasDocument).nodes.map(node => node.kind === 'session' ? node.preview : ''));
    if (last && previews !== last) changes += 1;
    last = previews;
  }
  return changes;
}

function bound(index: number): SessionNode {
  return { ...createSessionNode('llm', { x: (index % 4) * 400, y: Math.floor(index / 4) * 300 }), id: `n${index}`, title: `节点 ${index}`,
    binding: { companyId: 'c1', agentId: `agent-${index}`, agentName: `Agent ${index}` }, issueId: `issue-${index}`, preview: 'old' };
}

function seed(nodes: SessionNode[], edges: CanvasDocument['edges'] = []): void {
  localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify({ version: 2, updatedAt: 1, nodes, edges, waypoints: [], view: { x: 0, y: 0, scale: 1 } }));
}

const THREAD = /\/issues\/issue-(\d+)\/messages$/;
const INDEX = /\/conversations\/c1(\?|$)/;

/** The gateway's stored threads: each node's history arrives `stagger` ms after the one before, in a task of its own. */
function serveHistories(stagger: number) {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    const thread = THREAD.exec(url);
    if (thread) {
      await new Promise(resolve => setTimeout(resolve, 5 + Number(thread[1]) * stagger));
      return reply(200, { complete: true, messages: [
        { body: '请完成这一步', createdAt: '2026-10-19T00:00:00Z' },
        { body: `第一行\n节点 ${thread[1]} 的最后一行`, authorAgentId: `agent-${thread[1]}`, createdAt: '2026-10-19T00:00:01Z' },
      ] });
    }
    if (INDEX.test(url)) return reply(200, { conversations: Array.from({ length: 12 }, (_, index) => ({ issueId: `issue-${index}` })) });
    return reply(503, {});
  }));
}

beforeEach(() => {
  cleanup();
  resetAllSessions();
  localStorage.clear();
  counts.tiles.clear();
  vi.mocked(canvasPlanRevision).mockClear();
  vi.stubGlobal('ResizeObserver', SilentResizeObserver);
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(reply(503, {}))));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('a canvas whose tiles settle their histories one after another', () => {
  it('keeps every tile’s last line, written together rather than one document save per tile', async () => {
    const nodes = Array.from({ length: 12 }, (_, index) => bound(index));
    seed(nodes);
    serveHistories(15);
    const setItem = vi.spyOn(localStorage, 'setItem');
    render(<CanvasSurface />);

    await waitFor(() => expect(stored().nodes.map(node => node.kind === 'session' && node.preview))
      .toEqual(nodes.map((_, index) => `节点 ${index} 的最后一行`)), { timeout: 5000 });
    await quiet(800);
    // Twelve histories settled about 15 ms apart: one write for all of them (a slow machine may split it in two).
    expect(previewWrites(setItem)).toBeLessThanOrEqual(2);
    // Each thread keeps the line too, as a write of one tile's line always did.
    for (const node of stored().nodes) {
      if (node.kind === 'session') expect(node.threads?.find(thread => thread.id === 'default')?.preview).toBe(node.preview);
    }
  });

  it('writes no preview for a tile whose transcript already ends with it', async () => {
    const nodes = Array.from({ length: 12 }, (_, index) => ({ ...bound(index), preview: `节点 ${index} 的最后一行` }));
    seed(nodes);
    serveHistories(5);
    const setItem = vi.spyOn(localStorage, 'setItem');
    render(<CanvasSurface />);
    await waitFor(() => expect(screen.getByTestId('canvas-tile-n11')).toBeTruthy());
    await quiet(1200);
    expect(previewWrites(setItem)).toBe(0);
    expect(stored().nodes.map(node => node.kind === 'session' && node.preview)).toEqual(nodes.map(node => node.preview));
  });
});

describe('a tile’s last line while it waits to be written', () => {
  const LAST = '节点 0 的最后一行';
  const line = () => (stored().nodes.find(node => node.id === 'n0') as SessionNode).preview;
  const settledHistory = () => waitFor(() => expect(getSnapshot('n0').history).toBe('loaded'), { interval: 5 });
  // A message sent to 节点 0 leaves the transport's record of it behind (sessionTransport keeps one per node).
  beforeEach(() => forgetNode('n0'));
  afterEach(() => forgetNode('n0'));

  // 节点 0's stored conversation ends with a line its document does not have yet. Its history is read once `release` is
  // called; a message sent to it streams until `finish`.
  function serveNodeZero() {
    let release!: () => void;
    const settled = new Promise<void>(resolve => { release = resolve; });
    let finish!: () => void;
    const finished = new Promise<void>(resolve => { finish = resolve; });
    const messages: Array<Record<string, unknown>> = [
      { body: '请完成这一步', createdAt: '2026-10-19T00:00:00Z' },
      { body: `第一行\n${LAST}`, authorAgentId: 'agent-0', createdAt: '2026-10-19T00:00:01Z' },
    ];
    const frame = (event: string, data: Record<string, unknown>) => new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify({ event, ...data })}\n\n`);
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST' && url.endsWith('/prepare')) return reply(201, {});
      if (init?.method === 'POST' && url.endsWith('/messages')) {
        const sent = JSON.parse(String(init.body)) as { operationId: string; message: string };
        messages.push({ id: `${sent.operationId}-user`, body: sent.message, metadata: { version: 1, sections: [{ title: 'AwwO conversation',
          rows: [{ type: 'key_value', label: 'Operation', value: sent.operationId }] }] } },
        { id: `${sent.operationId}-agent`, body: '新的回复', authorAgentId: 'agent-0', createdByRunId: 'run-0' });
        return { ok: true, status: 200, body: new ReadableStream({ async start(controller) {
          controller.enqueue(frame('accepted', { issueId: 'issue-0', runId: 'run-0', runVisible: true }));
          await finished;
          controller.enqueue(frame('delta', { text: '新的回复' }));
          controller.enqueue(frame('done', { status: 'succeeded' }));
          controller.close();
        } }) };
      }
      if (url.endsWith('/settle')) return reply(200, { confirmed: true, status: 'succeeded', holdId: 'hold' });
      if (THREAD.test(url)) { await settled; return reply(200, { complete: true, messages }); }
      if (INDEX.test(url)) return reply(200, { conversations: [{ issueId: 'issue-0' }] });
      return reply(503, {});
    }));
    return { release, finish };
  }

  it('goes in before a message to its node runs, as a running node takes no edit', async () => {
    seed([updateNodeDraft({ ...bound(0), runtime: 'codex_local' }, '继续')]);
    const thread = serveNodeZero();
    render(<CanvasSurface />);
    fireEvent.click(screen.getByRole('button', { name: '打开 节点 0', exact: true }));
    act(() => thread.release());
    await settledHistory();
    // The line waits to be written (else this proves nothing).
    expect(line()).toBe('old');
    fireEvent.click(screen.getByTestId('composer-send'));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url, init]) => init?.method === 'POST' && String(url).endsWith('/messages'))).toBe(true));
    await quiet(800);
    // The run holds the node: its line was written before it began.
    expect(line()).toBe(LAST);
    act(() => thread.finish());
    await waitFor(() => expect(localStorage.getItem(CANVAS_RUN_JOURNAL_KEY)).toBeNull());
  });

  it('goes in before a plan is asked for, as a plan for a document that changed meanwhile is refused', async () => {
    seed([bound(0)]);
    const thread = serveNodeZero();
    let answer!: (plan: CanvasPlan) => void;
    const planRequest = vi.fn<typeof requestCanvasPlan>().mockImplementation(() => new Promise<CanvasPlan>(resolve => { answer = resolve; }));
    render(<CanvasSurface planRequest={planRequest} />);
    if (!screen.queryByRole('textbox', { name: '画布需求' })) fireEvent.click(screen.getByRole('button', { name: '画布助手', exact: true }));
    fireEvent.change(screen.getByRole('textbox', { name: '画布需求' }), { target: { value: '再加一个节点' } });
    act(() => thread.release());
    await settledHistory();
    expect(line()).toBe('old');
    fireEvent.click(screen.getByRole('button', { name: '修改画布', exact: true }));
    await waitFor(() => expect(planRequest).toHaveBeenCalledOnce());
    await quiet(800);
    act(() => answer({ version: 1, summary: '加了一个节点。', operations: [{ type: 'add_node', ref: 'more', templateId: 'general', title: '新节点' }] }));
    await waitFor(() => expect(stored().nodes).toHaveLength(2));
    expect(line()).toBe(LAST);
  });

  it('waits while a review loop another tab started holds the canvas, and goes in when it ends', async () => {
    seed([bound(0)]);
    const thread = serveNodeZero();
    render(<CanvasSurface />);
    act(() => thread.release());
    await settledHistory();
    expect(line()).toBe('old');
    // Another tab's review loop: its journal holds the whole canvas until it is gone.
    localStorage.setItem(CANVAS_RUN_JOURNAL_KEY, JSON.stringify({ version: 1, id: 'other-tab', startedAt: 1, scope: ['n0'],
      nodes: { n0: { nodeId: 'n0', threadId: 'default', state: 'running' } }, review: { round: 1, maxRounds: 2, outcome: 'running', turns: [] } }));
    await quiet(900);
    expect(line()).toBe('old');
    localStorage.removeItem(CANVAS_RUN_JOURNAL_KEY);
    await waitFor(() => expect(line()).toBe(LAST), { timeout: 2000 });
  });
});

describe('a tile re-renders only when what it shows changed', () => {
  // 甲 feeds 乙's brief; 丙 stands alone.
  function threeWired(first: Partial<SessionNode> = {}) {
    const contract = { version: 1 as const, inputs: [{ id: 'brief', label: 'Brief', type: 'markdown' as const, required: true, value: '' }],
      outputs: [{ id: 'result', label: 'Result', type: 'markdown' as const, required: true, value: '' }] };
    const a = { ...createSessionNode('llm', { x: 0, y: 0 }), id: 'a', title: '甲', contract,
      lastOutput: { text: '甲的交付', at: 1, source: 'run' as const }, ...first };
    const b = { ...createSessionNode('llm', { x: 500, y: 0 }), id: 'b', title: '乙', contract };
    const c = { ...createSessionNode('llm', { x: 1000, y: 0 }), id: 'c', title: '丙', contract };
    const from = { nodeId: 'a', portId: 'out:result' };
    const to = { nodeId: 'b', portId: 'in:brief' };
    seed([a, b, c], [{ id: edgeId(from, to), fromNode: 'a', fromPort: from.portId, toNode: 'b', toPort: to.portId, dataType: 'text' }]);
  }
  const renders = () => Object.fromEntries(['a', 'b', 'c'].map(id => [id, counts.tiles.get(id) ?? 0]));

  it('leaves every tile alone when only the canvas around them changes', async () => {
    threeWired();
    render(<CanvasSurface />);
    await quiet(600);
    counts.tiles.clear();
    // The command palette opens and closes over the board: the canvas renders, its tiles do not.
    fireEvent.keyDown(document, { key: 'p', code: 'KeyP', ...mod });
    await waitFor(() => expect(document.querySelector('.canvas-cmdbar-overlay')).toBeTruthy());
    fireEvent.keyDown(document, { key: 'Escape', code: 'Escape', bubbles: true });
    await waitFor(() => expect(document.querySelector('.canvas-cmdbar-overlay')).toBeNull());
    await quiet(100);
    expect(renders()).toEqual({ a: 0, b: 0, c: 0 });
  });

  it('re-renders only the pressed tile when a press selects it', async () => {
    threeWired();
    render(<CanvasSurface />);
    await quiet(600);
    counts.tiles.clear();
    fireEvent.pointerDown(screen.getByTestId('canvas-tile-c'), { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(window, { clientX: 10, clientY: 10 });
    await quiet(100);
    expect(renders().a).toBe(0);
    expect(renders().b).toBe(0);
    expect(renders().c).toBeGreaterThan(0);
  });

  it('re-renders only the dragged tile while it moves, not the tile it feeds', async () => {
    threeWired();
    render(<CanvasSurface />);
    await quiet(600);
    fireEvent.pointerDown(screen.getByTestId('canvas-tile-a'), { button: 0, clientX: 0, clientY: 0 });
    counts.tiles.clear();
    for (let step = 1; step <= 8; step += 1) fireEvent.pointerMove(window, { clientX: step * 10, clientY: step * 4 });
    fireEvent.pointerUp(window, { clientX: 80, clientY: 32 });
    await waitFor(() => expect((stored().nodes.find(node => node.id === 'a') as SessionNode).x).toBe(80));
    expect(renders().a).toBeGreaterThan(0);
    expect(renders().b).toBe(0);
    expect(renders().c).toBe(0);
  });

  it('shows a tile what a changed delivery now gives it', async () => {
    // 甲's delivery drawer stays open while its value is edited (the reader left it open): opening it again would queue a
    // re-open of 甲 for the next frame (toggleDeliverables), which could land after the next open below.
    threeWired({ deliverablesOpen: true });
    render(<CanvasSurface />);
    await quiet(600);
    const tile = (id: string) => within(screen.getByTestId(`canvas-tile-${id}`));
    const open = async (id: string, title: string) => {
      fireEvent.click(screen.getByRole('button', { name: `打开 ${title}`, exact: true }));
      await waitFor(() => expect(screen.getByTestId(`canvas-tile-${id}`).dataset.lod).toBe('focus'));
    };
    const close = async (id: string) => {
      fireEvent.keyDown(document, { key: 'Escape', code: 'Escape', bubbles: true });
      await waitFor(() => expect(screen.getByTestId(`canvas-tile-${id}`).dataset.lod).not.toBe('focus'));
    };
    const inputs = (id: string) => {
      const toggle = tile(id).getByRole('button', { name: '输入', exact: true });
      if (toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle);
    };
    // 乙's inputs read 甲's delivery.
    await open('b', '乙');
    inputs('b');
    await waitFor(() => expect(screen.getByTestId('canvas-tile-b').textContent).toContain('甲的交付'));
    await close('b');
    // 甲's delivery is published again by hand: its node changes (not where it sits).
    await open('a', '甲');
    fireEvent.click(tile('a').getByText('编辑输出表单'));
    fireEvent.change(tile('a').getByLabelText('Result的值'), { target: { value: '甲的新交付' } });
    fireEvent.click(tile('a').getByRole('button', { name: '发布输出' }));
    await waitFor(() => expect((stored().nodes.find(node => node.id === 'a') as SessionNode).lastOutput?.source).toBe('manual'));
    await close('a');
    // 乙 reads the new one.
    await open('b', '乙');
    inputs('b');
    await waitFor(() => expect(screen.getByTestId('canvas-tile-b').textContent).toContain('甲的新交付'));
    expect(screen.getByTestId('canvas-tile-b').textContent).not.toContain('甲的交付');
  });

  it('redraws both ends of a wire that is removed', async () => {
    threeWired();
    render(<CanvasSurface />);
    await quiet(600);
    const port = (node: string, id: string) => document.querySelector(`[data-node-id="${node}"][data-port-id="${id}"]`)!;
    expect(port('a', 'out:result').classList.contains('is-connected')).toBe(true);
    expect(port('b', 'in:brief').classList.contains('is-connected')).toBe(true);
    fireEvent.doubleClick(screen.getByTestId(`canvas-wire-hit-${edgeId({ nodeId: 'a', portId: 'out:result' }, { nodeId: 'b', portId: 'in:brief' })}`));
    await waitFor(() => expect(port('a', 'out:result').classList.contains('is-connected')).toBe(false));
    expect(port('b', 'in:brief').classList.contains('is-connected')).toBe(false);
  });
});

describe('useWiring', () => {
  it('hands its tiles the same object until something in it changes', () => {
    const rootRef = { current: null };
    const props = { nodes: [], edges: [], onConnect: () => {}, rootRef, view: { x: 0, y: 0, scale: 1 } } as Parameters<typeof useWiring>[0];
    const { result, rerender } = renderHook((current: Parameters<typeof useWiring>[0]) => useWiring(current), { initialProps: props });
    const first = result.current;
    rerender({ ...props, view: { x: 10, y: 0, scale: 1 } });
    expect(result.current).toBe(first);
    rerender({ ...props, onConnect: undefined });
    expect(result.current).not.toBe(first);
    expect(result.current.interactive).toBe(false);
  });
});

describe('the plan revision', () => {
  it('is worked out once per document, not on every render or save', async () => {
    seed([{ ...createSessionNode('llm', { x: 0, y: 0 }), id: 'a', title: '甲' }]);
    render(<CanvasSurface />);
    await quiet(600);
    vi.mocked(canvasPlanRevision).mockClear();
    // Renders with the same document hash nothing.
    for (let round = 0; round < 3; round += 1) {
      fireEvent.keyDown(document, { key: 'p', code: 'KeyP', ...mod });
      await waitFor(() => expect(document.querySelector('.canvas-cmdbar-overlay')).toBeTruthy());
      fireEvent.keyDown(document, { key: 'Escape', code: 'Escape', bubbles: true });
      await waitFor(() => expect(document.querySelector('.canvas-cmdbar-overlay')).toBeNull());
    }
    expect(canvasPlanRevision).not.toHaveBeenCalled();
    // A drag changes the document on every move: one hash for each, none for the save that follows it.
    fireEvent.pointerDown(screen.getByTestId('canvas-tile-a'), { button: 0, clientX: 0, clientY: 0 });
    for (let step = 1; step <= 6; step += 1) fireEvent.pointerMove(window, { clientX: step * 10, clientY: 0 });
    fireEvent.pointerUp(window, { clientX: 60, clientY: 0 });
    await waitFor(() => expect((stored().nodes[0] as SessionNode).x).toBe(60));
    expect(vi.mocked(canvasPlanRevision).mock.calls.length).toBeLessThanOrEqual(6);
  });
});

describe('the tiles an opening canvas mounts', () => {
  it('are the ones its first camera shows: a tile far off screen neither mounts nor reads its history', async () => {
    // A stage that measures itself: 1280 x 720.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() =>
      ({ x: 0, y: 0, top: 0, left: 0, right: 1280, bottom: 720, width: 1280, height: 720, toJSON: () => ({}) } as DOMRect));
    // The overview centres the middle node; the other two are a hundred thousand pixels to either side.
    const nodes = [{ ...bound(0), x: -100000 }, { ...bound(1), x: 0, y: 0 }, { ...bound(2), x: 100000, y: 0 }];
    localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify({ version: 2, updatedAt: 1, nodes, edges: [], waypoints: [], view: null }));
    serveHistories(0);
    render(<CanvasSurface />);
    await waitFor(() => expect(screen.getByTestId('canvas-tile-n1')).toBeTruthy());
    await quiet(400);
    expect(screen.queryByTestId('canvas-tile-n0')).toBeNull();
    expect(screen.queryByTestId('canvas-tile-n2')).toBeNull();
    const read = vi.mocked(fetch).mock.calls.map(([input]) => THREAD.exec(String(input))?.[1]).filter(Boolean);
    expect(read).toEqual(['1']);
  });
});
