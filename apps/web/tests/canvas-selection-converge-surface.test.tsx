// CONVERGED VIEW on the real surface. Several components drawn as one live icon instead of cards linked by wires.
//
// What is pinned here is the part no look can change: converging is a way of looking. The members' cards are not
// mounted, the wires between them are not drawn, a wire that crosses the group's edge is still drawn (it ends on the
// icon), nothing the board does not draw can be selected and so deleted or run unseen, and opening a member from
// anywhere draws its group's cards again first. The document never changes.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CanvasSurface } from '../src/canvas/CanvasSurface';
import type { CanvasPlan } from '../src/canvas/canvasPlan';
import type { requestCanvasPlan } from '../src/canvas/canvasPlanning';
import { buildCommandRows } from '../src/canvas/CommandBar';
import { canvasKeyBindings, keyHintMap } from '../src/canvas/useCanvasKeys';
import { CANVAS_STORAGE_KEY, createFormNode, createSessionNode, sanitizeDocument, type CanvasDocument, type CanvasEdge } from '../src/canvas/canvasDoc';
import { CONVERGED_GROUPS_KEY } from '../src/canvas/convergedGroups';
import { resetAllSessions } from '../src/canvas/sessions';

class SilentResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const wire = (from: string, to: string): CanvasEdge => ({ id: `${from}:result->${to}:context`, fromNode: from, fromPort: 'result', toNode: to, toPort: 'context', dataType: 'text' });

function seed(): CanvasDocument {
  return {
    version: 2,
    updatedAt: 1,
    nodes: [
      { ...createSessionNode('llm', { x: 100, y: 100 }), id: 'a', title: '甲' },
      { ...createSessionNode('llm', { x: 500, y: 100 }), id: 'b', title: '乙' },
      { ...createSessionNode('llm', { x: 500, y: 400 }), id: 'c', title: '丙' },
      { ...createSessionNode('llm', { x: 900, y: 250 }), id: 'd', title: '丁' },
    ],
    edges: [wire('a', 'b'), wire('a', 'c'), wire('b', 'c'), wire('c', 'd')],
    waypoints: [],
    view: { x: 0, y: 0, scale: 1 },
  };
}

const storedDoc = () => JSON.parse(localStorage.getItem(CANVAS_STORAGE_KEY)!) as CanvasDocument;

/** Two bound Agents fed by a form: enough to pass preflight and start a real run (as tests/canvas-run-lock.test.tsx does). */
function seedRunnable() {
  const agent = (id: string, x: number) => ({ ...createSessionNode('llm', { x, y: 0 }), id, title: id, runtime: 'claude_local',
    binding: { companyId: 'c1', agentId: `agent-${id}`, agentName: id }, issueId: `iss-${id}` });
  localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...seed(), nodes: [{ ...createFormNode({ x: 0, y: 0 }), id: 'f1', title: '需求表单' },
    agent('s1', 500), agent('s2', 900)], edges: [] }));
}
/** A reply the server finished: accepted on a new thread, one delta, done (the gateway's SSE frames). */
const finishedReply = (issueId: string, text: string) => [
  `event: accepted\ndata: {"event":"accepted","issueId":"${issueId}","runId":"run-1","runVisible":true}\n\n`,
  `event: delta\ndata: {"event":"delta","text":"${text}"}\n\n`, 'event: done\ndata: {"event":"done","status":"succeeded"}\n\n'].join('');
/** A reply kept open, which rejects (as a real fetch does) once the run is stopped. */
function heldOpen(signal?: AbortSignal) {
  return new Promise((_resolve, reject) => {
    if (!signal) return;
    const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    if (signal.aborted) fail(); else signal.addEventListener('abort', fail, { once: true });
  });
}
/** The canvas assistant's request box and its send button (canvas-planning-integration.test.tsx's harness). */
function submitPlan(prompt: string) {
  if (!screen.queryByRole('textbox', { name: '画布需求' })) fireEvent.click(screen.getByRole('button', { name: '画布助手', exact: true }));
  fireEvent.change(screen.getByRole('textbox', { name: '画布需求' }), { target: { value: prompt } });
  fireEvent.click(screen.getByRole('button', { name: '修改画布', exact: true }));
}
const renamePlan = (): CanvasPlan => ({ version: 1, summary: '把乙改名。', operations: [{ type: 'update_node', nodeId: 'b', title: '乙二' }] });
const addPlan = (): CanvasPlan => ({ version: 1, summary: '加一个服务。', operations: [{ type: 'add_node', ref: 'service', templateId: 'backend', title: '业务服务' }] });
const mounted = () => [...document.querySelectorAll('.canvas-tile')].map(tile => (tile as HTMLElement).dataset.nodeId).filter(Boolean).sort();
const selected = () => [...document.querySelectorAll('.canvas-tile--selected')].map(tile => (tile as HTMLElement).dataset.nodeId!).sort();

beforeEach(() => {
  cleanup();
  resetAllSessions();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.stubGlobal('ResizeObserver', SilentResizeObserver);
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 503, json: async () => ({}) })));
  localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify(seed()));
});

describe('the palette', () => {
  it('offers the same toggle, greyed out when the canvas cannot converge', () => {
    const toggleConverged = vi.fn();
    // The host's hints, as the canvas passes them (off a Mac: jsdom's platform is no Mac).
    const row = (actions: Parameters<typeof buildCommandRows>[0]) => buildCommandRows(actions, { running: false, timelineOpen: false, minimapOpen: false, selectionCount: 0 },
      keyHintMap(canvasKeyBindings(false))).find(item => item.id === 'converge-toggle');
    expect(row({ toggleConverged, converged: false, canConverge: true })).toMatchObject({ label: '收敛成一个图标', disabled: false, keys: 'Ctrl+G' });
    expect(row({ toggleConverged, converged: false, canConverge: false })?.disabled).toBe(true);
    expect(row({ toggleConverged, converged: true, canConverge: false })).toMatchObject({ label: '展开全部组件', disabled: false });
    expect(row({})).toBeUndefined();
  });
});

describe('a converged group on the board', () => {
  it('draws the other cards and none of its members', async () => {
    localStorage.setItem(CONVERGED_GROUPS_KEY, JSON.stringify({ v: 1, canvas: false, groups: [{ id: 'g', members: ['b', 'c'] }] }));
    render(<CanvasSurface />);
    await waitFor(() => expect(mounted()).toEqual(['a', 'd']));
    expect(screen.queryByTestId('canvas-tile-b')).toBeNull();
    expect(screen.queryByTestId('canvas-tile-c')).toBeNull();
  });

  it('draws the wires that cross its edge and not the one inside it', async () => {
    localStorage.setItem(CONVERGED_GROUPS_KEY, JSON.stringify({ v: 1, canvas: false, groups: [{ id: 'g', members: ['b', 'c'] }] }));
    render(<CanvasSurface />);
    await waitFor(() => expect(screen.getByTestId('canvas-wire-a:result->b:context')).toBeTruthy());
    expect(screen.getByTestId('canvas-wire-a:result->c:context')).toBeTruthy();
    expect(screen.getByTestId('canvas-wire-c:result->d:context')).toBeTruthy();
    expect(screen.queryByTestId('canvas-wire-b:result->c:context')).toBeNull();
  });

  it('draws the board as before when nothing is converged', async () => {
    render(<CanvasSurface />);
    await waitFor(() => expect(mounted()).toEqual(['a', 'b', 'c', 'd']));
    expect(screen.getByTestId('canvas-wire-b:result->c:context')).toBeTruthy();
  });

  it('never changes the document', async () => {
    localStorage.setItem(CONVERGED_GROUPS_KEY, JSON.stringify({ v: 1, canvas: false, groups: [{ id: 'g', members: ['b', 'c'] }] }));
    // Loading normalises a document (sanitizeDocument fills defaults such as lastOutput): compare with that.
    const loaded = sanitizeDocument(seed());
    render(<CanvasSurface />);
    await waitFor(() => expect(mounted()).toEqual(['a', 'd']));
    expect(JSON.stringify({ nodes: storedDoc().nodes, edges: storedDoc().edges })).toBe(JSON.stringify({ nodes: loaded.nodes, edges: loaded.edges }));
  });

  it('converges the whole canvas into one icon from the view tools, and draws it as cards again on Enter', async () => {
    render(<CanvasSurface />);
    await waitFor(() => expect(mounted()).toEqual(['a', 'b', 'c', 'd']));
    const toggle = document.querySelector('[data-converge-toggle]') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    // Its key as this platform writes it (jsdom's platform is no Mac): Ctrl+G, never CtrlG.
    expect(toggle.title).toContain('（Ctrl+G）');
    fireEvent.click(toggle);
    await waitFor(() => expect(mounted()).toEqual([]));
    expect(toggle.title).toBe('把组件按原位展开（Ctrl+G）');
    const icon = screen.getByTestId('converged-icon-canvas');
    expect(icon.getAttribute('role')).toBe('button');
    expect(icon.getAttribute('aria-label')).toContain('整个画布，已收敛 4 个组件');
    // Every wire is inside the one icon: none is drawn, and none is invented.
    expect(document.querySelectorAll('[data-testid^="canvas-wire-"]').length).toBe(0);
    // A toggle button keeps its name and says its state by being pressed (not "Show all components, pressed").
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(toggle.getAttribute('aria-label')).toBe('收敛成一个图标');
    expect(JSON.parse(localStorage.getItem(CONVERGED_GROUPS_KEY) ?? 'null')).toBeNull(); // saved after its debounce, not at once
    await waitFor(() => expect(JSON.parse(localStorage.getItem(CONVERGED_GROUPS_KEY)!)).toEqual({ v: 1, canvas: true, groups: [] }));

    fireEvent.keyDown(icon, { key: 'Enter' });
    await waitFor(() => expect(mounted()).toEqual(['a', 'b', 'c', 'd']));
    expect(screen.queryByTestId('converged-icon-canvas')).toBeNull();
    await waitFor(() => expect(localStorage.getItem(CONVERGED_GROUPS_KEY)).toBeNull());
  });

  it('draws the cards again on a double-click on the icon', async () => {
    localStorage.setItem(CONVERGED_GROUPS_KEY, JSON.stringify({ v: 1, canvas: true, groups: [] }));
    render(<CanvasSurface />);
    await waitFor(() => expect(screen.getByTestId('converged-icon-canvas')).toBeTruthy());
    expect(mounted()).toEqual([]);
    fireEvent.doubleClick(screen.getByTestId('converged-icon-canvas'));
    await waitFor(() => expect(mounted()).toEqual(['a', 'b', 'c', 'd']));
  });

  it('toggles with Ctrl+G, says so, holds arranging, and never deletes the icon or what is in it', async () => {
    render(<CanvasSurface />);
    await waitFor(() => expect(mounted()).toEqual(['a', 'b', 'c', 'd']));
    const announcer = screen.getByTestId('converged-announcer');
    fireEvent.keyDown(document, { key: 'g', code: 'KeyG', ctrlKey: true, bubbles: true, cancelable: true });
    await waitFor(() => expect(screen.getByTestId('converged-icon-canvas')).toBeTruthy());
    expect(announcer.textContent).toContain('已把 4 个组件收敛成一个图标');
    const arrange = document.querySelector('button[title="展开后才能整理布局"]') as HTMLButtonElement;
    expect(arrange).toBeTruthy();
    expect(arrange.disabled).toBe(true);

    fireEvent.pointerDown(screen.getByTestId('converged-icon-canvas'), { button: 0 });
    fireEvent.keyDown(document, { key: 'Delete', code: 'Delete', bubbles: true, cancelable: true });
    await waitFor(() => expect(announcer.textContent).toContain('图标不会被删除'));
    expect(storedDoc().nodes).toHaveLength(4);

    fireEvent.keyDown(document, { key: 'g', code: 'KeyG', ctrlKey: true, bubbles: true, cancelable: true });
    await waitFor(() => expect(mounted()).toEqual(['a', 'b', 'c', 'd']));
    expect(announcer.textContent).toContain('已展开「整个画布」');
    // It speaks from outside the board, which turns inert (and silent) under the 成果 view while a run goes on.
    expect(announcer.closest('.canvas-root')).toBeNull();
  });

  it('ends a card\'s drag when the card goes into the icon: its node never moves unseen', async () => {
    render(<CanvasSurface />);
    await waitFor(() => expect(mounted()).toEqual(['a', 'b', 'c', 'd']));
    fireEvent.pointerDown(screen.getByTestId('canvas-tile-a'), { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(window, { clientX: 40, clientY: 0 });
    await waitFor(() => expect(storedDoc().nodes.find(node => node.id === 'a')!.x).toBe(140));
    // ⌘G with the button still held: the card goes into the icon, and its drag with it.
    fireEvent.keyDown(document, { key: 'g', code: 'KeyG', ctrlKey: true, bubbles: true, cancelable: true });
    await waitFor(() => expect(screen.getByTestId('converged-icon-canvas')).toBeTruthy());
    fireEvent.pointerMove(window, { clientX: 400, clientY: 0 });
    fireEvent.pointerUp(window, { clientX: 400, clientY: 0 });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(storedDoc().nodes.find(node => node.id === 'a')!.x).toBe(140);
    expect(screen.getByTestId('converged-icon-canvas')).toBeTruthy();
  });

  it('shows every component on expanding, the groups kept from before included', async () => {
    localStorage.setItem(CONVERGED_GROUPS_KEY, JSON.stringify({ v: 1, canvas: true, groups: [{ id: 'g', members: ['b', 'c'] }] }));
    render(<CanvasSurface />);
    await waitFor(() => expect(screen.getByTestId('converged-icon-canvas')).toBeTruthy());
    fireEvent.click(document.querySelector('[data-converge-toggle]') as HTMLButtonElement);
    await waitFor(() => expect(mounted()).toEqual(['a', 'b', 'c', 'd']));
    expect(screen.queryByTestId('converged-icon-g')).toBeNull();
  });

  it('writes nothing to the document, its camera included, when it converges and expands', async () => {
    // A measured board, so the converge camera really glides (in jsdom every box is 0 × 0 otherwise).
    const measured = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return (this.classList.contains('canvas-root') ? { x: 0, y: 0, left: 0, top: 0, width: 1200, height: 800, right: 1200, bottom: 800 }
        : { x: 0, y: 0, left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }) as DOMRect;
    });
    render(<CanvasSurface />);
    await waitFor(() => expect(mounted()).toEqual(['a', 'b', 'c', 'd']));
    await new Promise(resolve => setTimeout(resolve, 700)); // the first fit, and any camera save it makes
    const before = localStorage.getItem(CANVAS_STORAGE_KEY);
    const toggle = document.querySelector('[data-converge-toggle]') as HTMLButtonElement;
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByTestId('converged-icon-canvas')).toBeTruthy());
    await new Promise(resolve => setTimeout(resolve, 900)); // past the glide and the camera save's 400 ms debounce
    expect(localStorage.getItem(CANVAS_STORAGE_KEY)).toBe(before);
    fireEvent.click(toggle);
    await waitFor(() => expect(mounted()).toEqual(['a', 'b', 'c', 'd']));
    await new Promise(resolve => setTimeout(resolve, 900));
    expect(localStorage.getItem(CANVAS_STORAGE_KEY)).toBe(before);
    measured.mockRestore();
  });

  it('gives the focus to the toggle when the icon it was on goes, never to the page', async () => {
    localStorage.setItem(CONVERGED_GROUPS_KEY, JSON.stringify({ v: 1, canvas: true, groups: [] }));
    render(<div className="awwo-workspace"><CanvasSurface /></div>);
    const icon = await screen.findByTestId('converged-icon-canvas');
    icon.focus();
    expect(document.activeElement).toBe(icon);
    fireEvent.keyDown(icon, { key: 'Enter' });
    await waitFor(() => expect(mounted()).toEqual(['a', 'b', 'c', 'd']));
    await waitFor(() => expect(document.activeElement).toBe(document.querySelector('[data-converge-toggle]')));
  });

  it('does not put an open node away under the icon', async () => {
    render(<CanvasSurface />);
    await waitFor(() => expect(mounted()).toEqual(['a', 'b', 'c', 'd']));
    fireEvent.doubleClick(screen.getByTestId('canvas-tile-a'));
    const toggle = document.querySelector('[data-converge-toggle]') as HTMLButtonElement;
    await waitFor(() => expect(toggle.disabled).toBe(true));
    expect(toggle.title).toBe('请先关闭打开的节点');
    fireEvent.keyDown(document, { key: 'g', code: 'KeyG', ctrlKey: true, bubbles: true, cancelable: true });
    expect(screen.queryByTestId('converged-icon-canvas')).toBeNull();
  });

  it('cannot converge a single component', async () => {
    localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...seed(), nodes: seed().nodes.slice(0, 1), edges: [] }));
    render(<CanvasSurface />);
    await waitFor(() => expect(mounted()).toEqual(['a']));
    const toggle = document.querySelector('[data-converge-toggle]') as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
  });

  it('counts a form out: a form and one Agent are not two components', async () => {
    localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...seed(), nodes: [{ ...createFormNode({ x: 100, y: 100 }), id: 'f' }, seed().nodes[1]], edges: [] }));
    render(<CanvasSurface />);
    await waitFor(() => expect(mounted()).toEqual(['b', 'f']));
    const toggle = document.querySelector('[data-converge-toggle]') as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    expect(toggle.title).toBe('至少需要 2 个组件');
    fireEvent.keyDown(document, { key: 'g', code: 'KeyG', ctrlKey: true, bubbles: true, cancelable: true });
    await new Promise(resolve => setTimeout(resolve, 50));
    // Not converged at all: no icon, the toggle not pressed, and the key says why, never "1 component".
    expect(screen.queryByTestId('converged-icon-canvas')).toBeNull();
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByTestId('converged-announcer').textContent?.trim()).toBe('至少需要 2 个组件');
    fireEvent.keyDown(document, { key: 'p', ctrlKey: true });
    expect(screen.getByTestId('cmdbar-row-converge-toggle')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('cmdbar-row-converge-toggle').textContent).toContain('至少需要 2 个组件');
    // The palette draws the canvas's own keys (keyHintMap), also for a row it names otherwise: fit is the canvas's fit-all.
    expect(screen.getByTestId('cmdbar-row-converge-toggle').querySelector('kbd')?.textContent).toBe('Ctrl+G');
    expect(screen.getByTestId('cmdbar-row-fit').querySelector('kbd')?.textContent).toBe('Ctrl+0');
  });

  it('never draws a canvas kept converged as an icon of one component, beside a form', async () => {
    localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...seed(), nodes: [{ ...createFormNode({ x: 100, y: 100 }), id: 'f' }, seed().nodes[1]], edges: [] }));
    localStorage.setItem(CONVERGED_GROUPS_KEY, JSON.stringify({ v: 1, canvas: true, groups: [] }));
    render(<CanvasSurface />);
    await waitFor(() => expect(mounted()).toEqual(['b', 'f']));
    expect(screen.queryByTestId('converged-icon-canvas')).toBeNull();
    // The preference is let go without a word (nothing was converged): the toggle is not pressed, and the key is removed.
    expect((document.querySelector('[data-converge-toggle]') as HTMLButtonElement).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByTestId('converged-announcer').textContent).toBe('');
    await waitFor(() => expect(localStorage.getItem(CONVERGED_GROUPS_KEY)).toBeNull());
  });

  it('holds undo and redo while components are inside the icon, and says to expand first', async () => {
    render(<CanvasSurface />);
    await waitFor(() => expect(mounted()).toEqual(['a', 'b', 'c', 'd']));
    // One edit to step back over: deleting 丁.
    fireEvent.pointerDown(screen.getByTestId('canvas-tile-d'), { button: 0 });
    fireEvent.pointerUp(window);
    fireEvent.keyDown(document, { key: 'Delete', code: 'Delete', bubbles: true, cancelable: true });
    await waitFor(() => expect(storedDoc().nodes).toHaveLength(3));
    fireEvent.keyDown(document, { key: 'g', code: 'KeyG', ctrlKey: true, bubbles: true, cancelable: true });
    await waitFor(() => expect(screen.getByTestId('converged-icon-canvas')).toBeTruthy());
    const announcer = screen.getByTestId('converged-announcer');

    fireEvent.keyDown(document, { key: 'z', code: 'KeyZ', ctrlKey: true, bubbles: true, cancelable: true });
    await waitFor(() => expect(announcer.textContent).toContain('请先展开图标，再撤销'));
    expect(storedDoc().nodes).toHaveLength(3);
    expect(screen.getByTestId('converged-icon-canvas')).toBeTruthy();
    const undoButton = document.querySelector('.awwo-view-tools button[title="展开后才能撤销"]') as HTMLButtonElement;
    expect(undoButton.disabled).toBe(true);
    fireEvent.keyDown(document, { key: 'p', ctrlKey: true });
    // The palette says why, never that there is nothing to undo.
    expect(screen.getByTestId('cmdbar-row-undo')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('cmdbar-row-undo').textContent).toContain('展开后才能撤销');
    expect(screen.getByTestId('cmdbar-row-undo').textContent).not.toContain('没有可撤销的操作');
    fireEvent.keyDown(document, { key: 'Escape', bubbles: true, cancelable: true });

    // Drawn as cards again, the step back is the person's to take.
    fireEvent.keyDown(document, { key: 'g', code: 'KeyG', ctrlKey: true, bubbles: true, cancelable: true });
    await waitFor(() => expect(mounted()).toEqual(['a', 'b', 'c']));
    expect(undoButton.disabled).toBe(false);
    fireEvent.keyDown(document, { key: 'z', code: 'KeyZ', ctrlKey: true, bubbles: true, cancelable: true });
    await waitFor(() => expect(storedDoc().nodes).toHaveLength(4));

    // Redo the same way: held while converged (⌘⇧Z and ⌘Y), said, and the person's once the cards are drawn.
    fireEvent.keyDown(document, { key: 'g', code: 'KeyG', ctrlKey: true, bubbles: true, cancelable: true });
    await waitFor(() => expect(screen.getByTestId('converged-icon-canvas')).toBeTruthy());
    fireEvent.keyDown(document, { key: 'z', code: 'KeyZ', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
    await waitFor(() => expect(announcer.textContent).toContain('请先展开图标，再重做'));
    fireEvent.keyDown(document, { key: 'y', code: 'KeyY', ctrlKey: true, bubbles: true, cancelable: true });
    expect(storedDoc().nodes).toHaveLength(4);
    const redoButton = document.querySelector('.awwo-view-tools button[title="展开后才能重做"]') as HTMLButtonElement;
    expect(redoButton.disabled).toBe(true);
    fireEvent.keyDown(document, { key: 'p', ctrlKey: true });
    expect(screen.getByTestId('cmdbar-row-redo')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('cmdbar-row-redo').textContent).toContain('展开后才能重做');
    fireEvent.keyDown(document, { key: 'Escape', bubbles: true, cancelable: true });
    fireEvent.keyDown(document, { key: 'g', code: 'KeyG', ctrlKey: true, bubbles: true, cancelable: true });
    await waitFor(() => expect(mounted()).toEqual(['a', 'b', 'c', 'd']));
    fireEvent.keyDown(document, { key: 'z', code: 'KeyZ', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
    await waitFor(() => expect(storedDoc().nodes).toHaveLength(3));
  });

  it('never calls undo or redo held when the icon is not what holds them (a reader, a run, nothing to step to)', async () => {
    render(<CanvasSurface />);
    await waitFor(() => expect(mounted()).toEqual(['a', 'b', 'c', 'd']));
    fireEvent.keyDown(document, { key: 'g', code: 'KeyG', ctrlKey: true, bubbles: true, cancelable: true });
    await waitFor(() => expect(screen.getByTestId('converged-icon-canvas')).toBeTruthy());
    // Nothing to undo or redo: expanding would not enable them, so their titles do not say it would.
    expect(document.querySelector('.awwo-view-tools button[title="展开后才能撤销"]')).toBeNull();
    expect(document.querySelector('.awwo-view-tools button[title="展开后才能重做"]')).toBeNull();
    fireEvent.keyDown(document, { key: 'p', ctrlKey: true });
    expect(screen.getByTestId('cmdbar-row-undo').textContent).toContain('没有可撤销的操作');
  });

  it('stays one icon while the canvas runs: what a run writes to its members is no edit', async () => {
    seedRunnable();
    // The first reply finishes (its thread and its output are written to its member, silently); the other stays open, so
    // the run is still under way while it is looked at.
    let replies = 0;
    vi.stubGlobal('fetch', vi.fn((input: unknown, init?: { method?: string; signal?: AbortSignal }) => {
      const url = String(input);
      if (url.endsWith('/prepare')) return Promise.resolve({ ok: true, status: 200 });
      if (url.endsWith('/settle')) return Promise.resolve({ ok: true, json: async () => ({ confirmed: true, status: 'succeeded', holdId: 'hold-1' }) });
      if (!url.includes('/messages')) return Promise.resolve({ ok: false, status: 503, json: async () => ({}) });
      if (init?.method === 'POST' && replies++ === 0) return Promise.resolve(new Response(finishedReply('iss-new', '第一份结果'), { headers: { 'content-type': 'text/event-stream' } }));
      return heldOpen(init?.signal);
    }));
    render(<CanvasSurface />);
    await waitFor(() => expect(mounted()).toEqual(['f1', 's1', 's2']));
    fireEvent.keyDown(document, { key: 'g', code: 'KeyG', ctrlKey: true, bubbles: true, cancelable: true });
    const icon = await screen.findByTestId('converged-icon-canvas');
    expect(icon.dataset.state).toBe('idle');
    fireEvent.keyDown(document, { key: 'p', ctrlKey: true });
    fireEvent.click(screen.getByTestId('cmdbar-row-run'));
    await waitFor(() => expect(storedDoc().nodes.some(node => node.lastOutput?.text === '第一份结果')).toBe(true));
    // The icon follows the run, and the board stays one icon all along.
    expect(['running', 'waiting']).toContain(screen.getByTestId('converged-icon-canvas').dataset.state);
    expect(mounted()).toEqual([]);
    expect(screen.getByTestId('converged-announcer').textContent).not.toContain('以显示这次改动');
  });

  it('draws the cards again when another tab\'s document is taken in at a run\'s start, and says so', async () => {
    seedRunnable();
    vi.stubGlobal('fetch', vi.fn((input: unknown, init?: { signal?: AbortSignal }) => {
      if (String(input).endsWith('/prepare')) return Promise.resolve({ ok: true, status: 200 });
      if (!String(input).includes('/messages')) return Promise.resolve({ ok: false, status: 503, json: async () => ({}) });
      return heldOpen(init?.signal);
    }));
    render(<CanvasSurface />);
    await waitFor(() => expect(mounted()).toEqual(['f1', 's1', 's2']));
    fireEvent.keyDown(document, { key: 'g', code: 'KeyG', ctrlKey: true, bubbles: true, cancelable: true });
    await screen.findByTestId('converged-icon-canvas');
    // Another tab of this canvas renamed s1 and saved it where this page reads before running.
    const elsewhere = storedDoc();
    localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...elsewhere, updatedAt: elsewhere.updatedAt + 1,
      nodes: elsewhere.nodes.map(node => node.id === 's1' ? { ...node, title: '另一个标签页改的名' } : node) }));
    fireEvent.keyDown(document, { key: 'p', ctrlKey: true });
    fireEvent.click(screen.getByTestId('cmdbar-row-run'));
    await waitFor(() => expect(screen.queryByTestId('converged-icon-canvas')).toBeNull());
    expect(mounted()).toEqual(['f1', 's1', 's2']);
    expect(screen.getByTestId('converged-announcer').textContent).toContain('已展开全部组件，以显示这次改动');
  });

  it('toggles once while ⌘G is held down', async () => {
    render(<CanvasSurface />);
    await waitFor(() => expect(mounted()).toEqual(['a', 'b', 'c', 'd']));
    fireEvent.keyDown(document, { key: 'g', code: 'KeyG', ctrlKey: true, bubbles: true, cancelable: true });
    for (let repeat = 0; repeat < 3; repeat++) fireEvent.keyDown(document, { key: 'g', code: 'KeyG', ctrlKey: true, repeat: true, bubbles: true, cancelable: true });
    await waitFor(() => expect(screen.getByTestId('converged-icon-canvas')).toBeTruthy());
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(screen.getByTestId('converged-icon-canvas')).toBeTruthy();
    expect(mounted()).toEqual([]);
  });

  it('draws the cards again for an edit that reaches inside the icon, and says why', async () => {
    render(<CanvasSurface />);
    await waitFor(() => expect(mounted()).toEqual(['a', 'b', 'c', 'd']));
    fireEvent.keyDown(document, { key: 'g', code: 'KeyG', ctrlKey: true, bubbles: true, cancelable: true });
    await waitFor(() => expect(screen.getByTestId('converged-icon-canvas')).toBeTruthy());
    // A component added from the palette would join the icon unseen: the board is drawn as cards to show it.
    fireEvent.keyDown(document, { key: 'p', ctrlKey: true });
    fireEvent.click(screen.getByTestId('cmdbar-row-add-session-llm'));
    await waitFor(() => expect(storedDoc().nodes).toHaveLength(5));
    await waitFor(() => expect(screen.queryByTestId('converged-icon-canvas')).toBeNull());
    expect(mounted()).toHaveLength(5);
    expect(screen.getByTestId('converged-announcer').textContent).toContain('已展开全部组件，以显示这次改动');
    await waitFor(() => expect(localStorage.getItem(CONVERGED_GROUPS_KEY)).toBeNull());
  });

  it('draws the cards again when a member is opened from elsewhere (the palette, as from search or the timeline)', async () => {
    render(<CanvasSurface />);
    await waitFor(() => expect(mounted()).toEqual(['a', 'b', 'c', 'd']));
    fireEvent.keyDown(document, { key: 'g', code: 'KeyG', ctrlKey: true, bubbles: true, cancelable: true });
    await waitFor(() => expect(screen.getByTestId('converged-icon-canvas')).toBeTruthy());
    fireEvent.keyDown(document, { key: 'p', ctrlKey: true });
    fireEvent.click(screen.getByTestId('cmdbar-row-focus-b'));
    // Every card, not the opened one beside the icon.
    await waitFor(() => expect(mounted()).toEqual(['a', 'b', 'c', 'd']));
    expect(screen.queryByTestId('converged-icon-canvas')).toBeNull();
    expect(screen.getByTestId('converged-announcer').textContent).toContain('已展开「整个画布」');
  });

  it('marquee-selects only the cards the board draws', async () => {
    localStorage.setItem(CONVERGED_GROUPS_KEY, JSON.stringify({ v: 1, canvas: false, groups: [{ id: 'g', members: ['b', 'c'] }] }));
    render(<CanvasSurface />);
    await waitFor(() => expect(mounted()).toEqual(['a', 'd']));
    const viewport = document.querySelector('.canvas-viewport') as HTMLElement;
    const captured = new Set<number>();
    Object.defineProperties(viewport, {
      setPointerCapture: { configurable: true, value: (id: number) => captured.add(id) },
      releasePointerCapture: { configurable: true, value: (id: number) => captured.delete(id) },
      hasPointerCapture: { configurable: true, value: (id: number) => captured.has(id) },
    });
    // A box over the whole board, wherever its camera is.
    fireEvent.pointerDown(viewport, { button: 0, pointerId: 3, shiftKey: true, clientX: -100000, clientY: -100000 });
    fireEvent.pointerMove(viewport, { pointerId: 3, clientX: 100000, clientY: 100000 });
    fireEvent.pointerUp(viewport, { pointerId: 3, clientX: 100000, clientY: 100000 });
    await waitFor(() => expect(selected()).toEqual(['a', 'd']));
    fireEvent.keyDown(document, { key: 'p', ctrlKey: true });
    expect(screen.getByTestId('cmdbar-row-delete').textContent).toContain('删除选中（2）');
  });

  it('steps through the drawn cards only, so no member is selected (and deleted or run) unseen', async () => {
    localStorage.setItem(CONVERGED_GROUPS_KEY, JSON.stringify({ v: 1, canvas: false, groups: [{ id: 'g', members: ['b', 'c'] }] }));
    render(<CanvasSurface />);
    await waitFor(() => expect(mounted()).toEqual(['a', 'd']));
    for (let step = 0; step < 4; step++) {
      fireEvent.keyDown(document, { key: ']', code: 'BracketRight', ctrlKey: true, bubbles: true, cancelable: true });
      await waitFor(() => expect(selected().length).toBe(1));
      expect(['a', 'd']).toContain(selected()[0]);
    }
    fireEvent.keyDown(document, { key: 'Delete', code: 'Delete', bubbles: true, cancelable: true });
    await waitFor(() => expect(storedDoc().nodes.length).toBe(3));
    expect(storedDoc().nodes.map(node => node.id).sort()).toEqual(expect.arrayContaining(['b', 'c']));
  });
});

describe('the canvas assistant while the canvas is one icon', () => {
  // The assistant's side panel is laid out against a measured stage (as canvas-planning-integration.test.tsx measures it).
  beforeEach(() => {
    const originalRect = Element.prototype.getBoundingClientRect;
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      return this.classList.contains('canvas-root')
        ? { x: 0, y: 0, top: 0, left: 0, right: 1280, bottom: 720, width: 1280, height: 720, toJSON: () => ({}) } as DOMRect
        : originalRect.call(this);
    });
  });
  const converge = async () => {
    fireEvent.click(document.querySelector('[data-converge-toggle]') as HTMLButtonElement);
    await waitFor(() => expect(screen.getByTestId('converged-icon-canvas')).toBeTruthy());
  };

  it('draws the cards again for a plan that changes a member inside the icon, without opening anything', async () => {
    const planRequest = vi.fn<typeof requestCanvasPlan>().mockResolvedValue(renamePlan());
    render(<CanvasSurface planRequest={planRequest} />);
    await waitFor(() => expect(mounted()).toEqual(['a', 'b', 'c', 'd']));
    await converge();
    submitPlan('把乙改个名');
    await waitFor(() => expect(storedDoc().nodes.find(node => node.id === 'b')?.title).toBe('乙二'));
    // A plan opens no node (it closes one): only the edit's own rule can have drawn the cards.
    await waitFor(() => expect(screen.queryByTestId('converged-icon-canvas')).toBeNull());
    expect(mounted()).toEqual(['a', 'b', 'c', 'd']);
    expect(screen.getByTestId('converged-announcer').textContent).toContain('已展开全部组件，以显示这次改动');
  });

  it('draws the cards again when the assistant takes its plan back while the canvas is converged', async () => {
    const planRequest = vi.fn<typeof requestCanvasPlan>().mockResolvedValue(addPlan());
    render(<CanvasSurface planRequest={planRequest} />);
    await waitFor(() => expect(mounted()).toEqual(['a', 'b', 'c', 'd']));
    submitPlan('加一个服务');
    await waitFor(() => expect(storedDoc().nodes).toHaveLength(5));
    await converge();
    fireEvent.click(screen.getByRole('button', { name: '撤销本次更改', exact: true }));
    // The undo goes around patchDoc: without its own step, the plan's component would leave the icon unseen.
    await waitFor(() => expect(storedDoc().nodes).toHaveLength(4));
    await waitFor(() => expect(screen.queryByTestId('converged-icon-canvas')).toBeNull());
    expect(mounted()).toEqual(['a', 'b', 'c', 'd']);
    expect(screen.getByTestId('converged-announcer').textContent).toContain('已展开全部组件，以显示这次改动');
  });

  it('gives the focus the icon held to the toggle when a plan arriving draws the cards again', async () => {
    let arrive!: (plan: CanvasPlan) => void;
    const planRequest = vi.fn<typeof requestCanvasPlan>().mockReturnValue(new Promise<CanvasPlan>(resolve => { arrive = resolve; }));
    render(<div className="awwo-workspace"><CanvasSurface planRequest={planRequest} /></div>);
    await waitFor(() => expect(mounted()).toEqual(['a', 'b', 'c', 'd']));
    await converge();
    submitPlan('把乙改个名');
    await waitFor(() => expect(planRequest).toHaveBeenCalled());
    // While the plan is coming, the reader goes to the icon to hear how the canvas is doing.
    const icon = screen.getByTestId('converged-icon-canvas');
    icon.focus();
    expect(document.activeElement).toBe(icon);
    await act(async () => { arrive(renamePlan()); });
    await waitFor(() => expect(screen.queryByTestId('converged-icon-canvas')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(document.querySelector('[data-converge-toggle]')));
  });
});
