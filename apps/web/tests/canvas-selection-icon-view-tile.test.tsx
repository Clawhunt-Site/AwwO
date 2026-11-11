// A COMPONENT'S LIVE ICON (图标视图, NodeIconTile.tsx). What it draws and says must be true of its component, and its
// press, drag, double-click and keys must be the card's: a press selects (keeping a group), a drag past the threshold
// moves it at the zoom, a release without one selects it alone, a double-click or Enter opens it, a screen reader's
// click opens it, and a port's press or click is the port's. Its ports are never a button's children.
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createAssembleNode, createEditNode, createFormNode, createSessionNode, type CanvasNode, type FormNode, type SessionNode } from '../src/canvas/canvasDoc';
import { eyeGaze } from '../src/canvas/avatarFace';
import { canvasText, LocaleProvider } from '../src/canvas/i18n';
import { NodeIconTile, type NodeIconTileProps } from '../src/canvas/NodeIconTile';
import { nodeIconGeometry, nodeIconLabelWidth } from '../src/canvas/nodeIcons';
import { portsFor } from '../src/canvas/ports';
import type { RunView } from '../src/canvas/RunTimeline';
import { appendTurn, getSnapshot, resetAllSessions } from '../src/canvas/sessions';
import { compactSessionPreview } from '../src/canvas/SessionTile';
import type { WiringApi } from '../src/canvas/TilePorts';
import { holdCardGesture } from '../src/canvas/cardGesture';
import { CanvasUiModeProvider } from '../src/canvas/uiMode';

const zh = (key: Parameters<typeof canvasText>[1], values?: Record<string, string | number>) => canvasText('zh', key, values);
const agent = (id = 'a', extra: Partial<CanvasNode> = {}): CanvasNode =>
  ({ ...createSessionNode('llm', { x: 100, y: 200 }), id, title: '甲', ...extra } as CanvasNode);
const bound = { binding: { companyId: 'c1', agentId: 'agent-a', agentName: '甲' }, runtime: 'claude_local' } as Partial<CanvasNode>;

function fakeWiring(interactive = true): WiringApi {
  return { pendingPort: null, wireDrag: null, interactive, wireCount: () => 0, canEndDrag: () => false, clearPending: vi.fn(),
    cancelWiring: vi.fn(), onPortPointerDown: vi.fn(), onPortClick: vi.fn() };
}

function draw(node: CanvasNode, props: Partial<NodeIconTileProps> = {}, wrap?: (child: ReactElement) => ReactElement) {
  const handlers = { onMove: vi.fn(), onSelect: vi.fn(), onToggleFocus: vi.fn() };
  const base: NodeIconTileProps = { node, drawn: node, run: null, live: false, scale: 1, selected: false, soleSelected: false, tabbable: true, ...handlers, ...props };
  const element = (more: Partial<NodeIconTileProps> = {}) => { const tile = <NodeIconTile {...base} {...more} />; return wrap ? wrap(tile) : tile; };
  const view = render(element());
  const root = () => screen.getByTestId(`node-icon-${node.id}`);
  const hit = () => root().querySelector<HTMLElement>('.awwo-node-icon-hit')!;
  const row = () => root().querySelector('.awwo-converged-state')?.textContent ?? null;
  return { ...view, ...handlers, root, hit, row, again: (more: Partial<NodeIconTileProps>) => view.rerender(element(more)) };
}

beforeEach(() => { cleanup(); resetAllSessions(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('what it draws', () => {
  it('draws an Agent as the flat head with a face for its state, and any other kind as a token on the same plate', () => {
    const { root } = draw(agent());
    expect(root().className.split(' ')).toEqual(expect.arrayContaining(['canvas-tile', 'awwo-node', 'awwo-node-icon', 'is-idle']));
    expect(root().classList.contains('awwo-converged')).toBe(false);
    // The plate is no button and names no node: the button is the hit over it, and cards alone carry data-node-id.
    expect(root().getAttribute('role')).toBeNull();
    expect(root().hasAttribute('data-node-id')).toBe(false);
    expect(root().dataset.nodeIcon).toBe('a');
    expect(root().querySelector('.awwo-converged-face')?.getAttribute('data-expression')).toBe('calm');
    expect(root().querySelector('.awwo-node-icon-eyes')).toBeTruthy();
    expect(root().querySelector('.awwo-node-icon-token')).toBeNull();
    cleanup();
    for (const node of [{ ...createFormNode({ x: 0, y: 0 }), id: 'f' }, { ...createAssembleNode({ x: 0, y: 0 }), id: 'm' }, { ...createEditNode({ x: 0, y: 0 }), id: 'e' }]) {
      const tile = draw(node);
      expect(tile.root().querySelector('.awwo-node-icon-token')?.getAttribute('data-token')).toBe(node.kind);
      expect(tile.root().querySelector('.awwo-node-icon-eyes')).toBeNull();
      expect(tile.root().querySelectorAll('.awwo-node-icon-token path').length).toBeGreaterThanOrEqual(3);
      cleanup();
    }
  });

  it('says its state in its ring: its state\'s arc, a keyline when failed, and the arc going round while it runs', () => {
    const failed = draw(agent(), { run: { state: 'failed' }, live: true });
    expect(failed.root().querySelector('.awwo-converged-keyline')).toBeTruthy();
    expect(failed.root().querySelector('.awwo-converged-arc.is-failed')).toBeTruthy();
    expect(failed.root().querySelector('.awwo-node-icon-orbit')).toBeNull();
    cleanup();
    const running = draw(agent(), { run: { state: 'running' }, live: true });
    expect(running.root().classList.contains('is-running')).toBe(true);
    // The collar's track, the quarter going round it, and a full still ring for reduced motion.
    expect(running.root().querySelector('.awwo-converged-ring .awwo-converged-arc.is-idle')).toBeTruthy();
    expect(running.root().querySelector('.awwo-node-icon-orbit .awwo-converged-arc.is-running')).toBeTruthy();
    expect(running.root().querySelector('.awwo-node-icon-still.is-running')).toBeTruthy();
    expect(running.root().querySelector('.awwo-converged-face')?.getAttribute('data-expression')).toBe('working');
    expect(running.root().querySelector('.awwo-converged-keyline')).toBeNull();
    cleanup();
    const done = draw(agent(), { run: { state: 'done' }, live: true });
    expect(done.root().querySelector('.awwo-converged-arc.is-done')).toBeTruthy();
    expect(done.root().querySelector('.awwo-node-icon-orbit, .awwo-node-icon-still')).toBeNull();
    expect(done.root().querySelector('.awwo-converged-face')?.getAttribute('data-expression')).toBe('happy');
  });

  it('sits on its icon box, at the zoom\'s pixel, and a failed Agent\'s eyes look down', () => {
    const node = agent();
    const { root } = draw(node, { scale: .5, run: { state: 'failed' }, live: true });
    const { icon } = nodeIconGeometry(node);
    expect(root().style.left).toBe(`${icon.x}px`);
    expect(root().style.top).toBe(`${icon.y}px`);
    expect(root().style.width).toBe('112px');
    expect(root().style.height).toBe('112px');
    expect(root().style.getPropertyValue('--cv-px')).toBe('2');
    // The room its rows may take: the card it replaces (a session's compact card), which the sheet caps them at.
    expect(root().style.getPropertyValue('--cv-label-w')).toBe(String(nodeIconLabelWidth(node)));
    const [gx, gy] = eyeGaze(.5).map(share => Math.round(share * 100) / 100);
    expect(root().querySelector<HTMLElement>('.awwo-node-icon-gaze')!.style.translate).toBe(`${gx}% ${gy}%`);
    cleanup();
    expect(draw(agent()).root().querySelector<HTMLElement>('.awwo-node-icon-gaze')!.style.translate).toBe('0% 0%');
  });
});

describe('its words', () => {
  const line = (node: CanvasNode, run: RunView | null, live = true) => { const tile = draw(node, { run, live }); const text = tile.row(); cleanup(); return text; };

  it('says what a run is doing, in the card\'s words', () => {
    expect(line(agent(), { state: 'running', startedAt: Date.now() - 5000 })).toMatch(/^运行中 · /);
    expect(line(agent(), { state: 'running' })).toBe('运行中');
    expect(line(agent(), { state: 'waiting' })).toBe(zh('tile.queued'));
    expect(line(agent(), { state: 'waiting', detail: 'retrying', attempts: 2, retryLimit: 3 })).toBe(zh('tile.retrying', { attempt: 2, limit: 3 }));
    // A run whose stream was lost is confirmed, never shown as plainly running.
    expect(line(agent(), { state: 'running', unconfirmed: true })).toBe(zh('converge.confirming'));
    expect(line(agent('a', { lastOutput: { text: 'x', at: 1, source: 'run' } } as Partial<CanvasNode>), { state: 'done' })).toBe(zh('tile.completed'));
    expect(line(agent(), { state: 'cached' })).toBe(zh('tile.cached'));
    expect(line(agent(), { state: 'failed', detail: 'timed_out' })).toBe(`${zh('tile.failed')} · ${zh('session.timedOut')}`);
    expect(line(agent(), { state: 'failed' })).toBe(zh('tile.failed'));
    // Never the bare 被阻断: what holds it back, or that what it waits on did not finish, in every engine's words.
    expect(line(agent(), { state: 'blocked' })).toBe(zh('surface.upstreamIncomplete'));
    expect(line(agent(), { state: 'blocked', detail: '上游未完成' })).toBe(zh('surface.upstreamIncomplete'));
    expect(line(agent(), { state: 'blocked', detail: 'Upstream did not complete' })).toBe(zh('surface.upstreamIncomplete'));
    expect(line(agent(), { state: 'cancelled' as RunView['state'] })).toBe(zh('tile.cancelled'));
    expect(line(agent(), { state: 'cancelled' as RunView['state'], detail: '已取消' })).toBe(zh('tile.cancelled'));
    // A run's own status as its detail says nothing more: never 「失败 · 失败」, and never 失败 for a node that never ran.
    expect(line(agent(), { state: 'failed', detail: 'failed' })).toBe(zh('tile.failed'));
    expect(line(agent(), { state: 'blocked', detail: 'failed' })).toBe(zh('surface.upstreamIncomplete'));
    // A connection still to confirm is said whatever the run says.
    expect(line(agent('a', { bindAttempt: 'unknown' } as Partial<CanvasNode>), { state: 'failed', detail: 'timed_out' }))
      .toBe(`${zh('tile.failed')} · ${zh('session.timedOut')} · ${zh('tile.bindPending')}`);
    expect(line(agent('a', { bindAttempt: 'unknown' } as Partial<CanvasNode>), { state: 'blocked' }))
      .toBe(`${zh('surface.upstreamIncomplete')} · ${zh('tile.bindPending')}`);
  });

  it('colours a failure and a hold, and says the line once: in the name and the tooltip, the description only how to open', () => {
    const failed = draw(agent(), { run: { state: 'failed', detail: 'timed_out' }, live: true });
    expect(failed.root().querySelector('.awwo-converged-state .is-failed')).toBeTruthy();
    const hint = document.getElementById(failed.hit().getAttribute('aria-describedby')!)!;
    expect(hint.textContent).toBe(zh('nodeIcon.openHint'));
    // Hidden, so reading the page never meets it beside every icon (a description is read hidden or not).
    expect(hint.hidden).toBe(true);
    expect(failed.hit().getAttribute('aria-label')).toBe(`甲，${zh('node.llm')}：${zh('tile.failed')} · ${zh('session.timedOut')}`);
    expect(failed.root().getAttribute('title')).toBe(`甲\n${zh('tile.failed')} · ${zh('session.timedOut')}`);
    cleanup();
    const held = draw(agent(), { run: { state: 'blocked' }, live: true });
    expect(held.root().querySelector('.awwo-converged-state .is-blocked')).toBeTruthy();
    expect(held.root().getAttribute('title')).toBe(`甲\n${zh('surface.upstreamIncomplete')}`);
  });

  it('says at rest what the card says: a connection to confirm (a warning), a draft, what it delivered, or nothing yet', () => {
    expect(line(agent('a', { bindAttempt: 'unknown' } as Partial<CanvasNode>), null, false)).toBe(zh('tile.bindPending'));
    const pending = draw(agent('a', { bindAttempt: 'unknown' } as Partial<CanvasNode>));
    expect(pending.root().querySelector('.awwo-converged-state .is-blocked')).toBeTruthy();
    cleanup();
    expect(line(agent(), null, false)).toBe(zh('tile.draft'));
    expect(line(agent('a', bound), null, false)).toBe(zh('tile.noDeliverables'));
    expect(line(agent('a', { ...bound, lastOutput: { text: '一页落地页的文案', at: 1, source: 'run' } } as Partial<CanvasNode>), null, false)).toContain('一页落地页的文案');
    expect(line(agent('a', { ...bound, lastOutput: { text: '半截', at: 1, source: 'run', partial: true } } as Partial<CanvasNode>), null, false))
      .toBe(`${zh('tile.partialOutput')} · 半截`);
    const assemble = { ...createAssembleNode({ x: 0, y: 0 }), id: 'm' };
    expect(line(assemble, null, false)).toBe(zh('tile.assembleSummary', { inputs: 1, outputs: '页面' }));
    expect(line({ ...createEditNode({ x: 0, y: 0 }), id: 'e' }, null, false)).toBe(zh('edit.emptyTitle'));
  });

  it('says at rest what its compact card says, from the conversation chosen, and follows that conversation', () => {
    const node = agent('a', bound);
    const card = (turns = getSnapshot('a').turns) => compactSessionPreview(node as SessionNode, turns, 'zh', zh);
    appendTurn('a', { role: 'user', text: '调研三家竞品' });
    appendTurn('a', { role: 'agent', text: '一份调研摘要：三家都按年收费。' });
    const tile = draw(node);
    expect(tile.row()).toBe(card());
    expect(tile.row()).toContain('一份调研摘要');
    act(() => { appendTurn('a', { role: 'agent', text: '补充：其中一家另收席位费。' }); });
    expect(tile.row()).toBe(card());
    expect(tile.row()).toContain('补充');
    cleanup();
    // The conversation chosen holds no result but an earlier one does: said so, as the card says it.
    const earlier = { ...bound, activeThreadId: 'thread-2', threads: [
      { id: 'thread-1', title: 'Session 1', issueId: null, preview: '', draft: '', createdAt: 1 },
      { id: 'thread-2', title: 'Session 2', issueId: null, preview: '', draft: '', createdAt: 2, lastOutput: { text: '旧的产出', at: 5, source: 'run' } },
    ] } as Partial<CanvasNode>;
    expect(line(agent('a', earlier), null, false)).toBe(zh('tile.historicalAvailable'));
  });

  it('tells a form by its fields: filled in (the done look) or how many wait, whatever a run says', () => {
    const form = { ...createFormNode({ x: 0, y: 0 }), id: 'f' } as FormNode;
    const waiting = draw(form, { run: { state: 'done' }, live: true });
    expect(waiting.row()).toBe(zh('nodeIcon.formToFill', { count: 2 }));
    expect(waiting.root().dataset.state).toBe('idle');
    cleanup();
    const half = { ...form, fields: [{ ...form.fields[0], value: '一个落地页' }, form.fields[1]] };
    expect(line(half, null)).toBe(zh('nodeIcon.formToFill', { count: 1 }));
    const filled = { ...form, fields: form.fields.map((field, index) => ({ ...field, value: index ? '三天' : '一个落地页' })) };
    const done = draw(filled, { run: { state: 'failed' }, live: true });
    expect(done.row()).toBe(`${zh('nodeIcon.formFilled')} · 一个落地页`);
    expect(done.root().dataset.state).toBe('done');
    expect(done.root().classList.contains('is-done')).toBe(true);
    cleanup();
    expect(line({ ...form, fields: [] }, null)).toBe(zh('nodeIcon.formEmpty'));
  });

  it('is named for a screen reader with its title, kind and state, selected or not, and what opens it', () => {
    const tile = draw(agent());
    expect(tile.hit().getAttribute('role')).toBe('button');
    expect(tile.hit().getAttribute('aria-label')).toBe(`甲，${zh('node.llm')}：${zh('tile.draft')}`);
    expect(document.getElementById(tile.hit().getAttribute('aria-describedby')!)!.textContent).toBe(zh('nodeIcon.openHint'));
    tile.again({ selected: true });
    expect(tile.hit().getAttribute('aria-label')).toBe(`甲，${zh('node.llm')}：${zh('tile.draft')}。已选中`);
    expect(tile.root().classList.contains('canvas-tile--selected')).toBe(true);
    cleanup();
    // A finished node's word, not the card's check mark.
    const done = draw(agent('a', { lastOutput: { text: 'x', at: 1, source: 'run' } } as Partial<CanvasNode>), { run: { state: 'done' }, live: true });
    expect(done.hit().getAttribute('aria-label')).toBe(`甲，${zh('node.llm')}：${zh('nodeIcon.done')}`);
    cleanup();
    const english = draw(agent(), {}, child => <LocaleProvider locale="en">{child}</LocaleProvider>);
    expect(english.hit().getAttribute('aria-label')).toBe(`甲, ${canvasText('en', 'node.llm')}: ${canvasText('en', 'tile.draft')}`);
    expect(english.row()).toBe('Draft');
  });

  it('shows its rows by its size on screen: none when tiny, its name, then its state line too', () => {
    const tiny = draw(agent(), { scale: .1 });
    expect(tiny.root().dataset.tier).toBe('S');
    expect(tiny.root().querySelector('.awwo-node-icon-label')).toBeNull();
    cleanup();
    const fitted = draw(agent(), { scale: .24 });
    expect(fitted.root().dataset.tier).toBe('M');
    expect(fitted.root().querySelector('.awwo-converged-name')?.textContent).toBe('甲');
    expect(fitted.row()).toBeNull();
    cleanup();
    const near = draw(agent(), { scale: 1 });
    expect(near.root().dataset.tier).toBe('L');
    expect(near.row()).toBe(zh('tile.draft'));
    // The rows are words the hit's name already says.
    expect(near.root().querySelector('.awwo-node-icon-label')?.getAttribute('aria-hidden')).toBe('true');
    // An untitled component is a dash, never an empty row.
    cleanup();
    expect(draw(agent('a', { title: '  ' })).root().querySelector('.awwo-converged-name')?.textContent).toBe('—');
  });
});

describe('its ports', () => {
  it('sits them on the band the wires end on, beside the button and never inside it', () => {
    const node = { ...createSessionNode('video', { x: 100, y: 200 }), id: 'v', title: '视频' } as CanvasNode;
    const { root } = draw(node, { wiring: fakeWiring() });
    const { icon, wire } = nodeIconGeometry(node);
    const band = root().querySelector<HTMLElement>('.awwo-node-icon-ports')!;
    expect(band.style.top).toBe(`${wire.y - icon.y}px`);
    expect(band.style.height).toBe(`${wire.h}px`);
    const ports = [...band.querySelectorAll<HTMLElement>('.canvas-port')];
    expect(ports.map(port => `${port.dataset.portSide}:${port.dataset.portId}`)).toEqual(portsFor(node).map(port => `${port.side}:${port.id}`));
    expect(root().querySelectorAll('[role="button"] .canvas-port, [role="button"] button')).toHaveLength(0);
    expect(ports.every(port => port.classList.contains('canvas-port--interactive'))).toBe(true);
    // Each handle on the rim of the 112-unit plate (the band's own coordinates).
    for (const port of ports) {
      const x = Number.parseFloat(port.style.left);
      const y = Number.parseFloat(port.style.top) + (wire.y - icon.y);
      expect(Math.hypot(x - 56, y - 56)).toBeCloseTo(56, 0);
    }
  });

  it('keeps them inert for a reader, while the canvas is busy and in the simple view, as the card does', () => {
    const inert = (props: Partial<NodeIconTileProps>, wrap?: (child: ReactElement) => ReactElement) => {
      const { root } = draw(agent(), { wiring: fakeWiring(), ...props }, wrap);
      const ports = [...root().querySelectorAll<HTMLButtonElement>('.canvas-port')];
      const result = ports.length > 0 && ports.every(port => port.disabled && !port.classList.contains('canvas-port--interactive'));
      cleanup();
      return result;
    };
    expect(inert({})).toBe(false);
    expect(inert({ readOnly: true })).toBe(true);
    expect(inert({ interactionLocked: true })).toBe(true);
    expect(inert({}, child => <CanvasUiModeProvider mode="simple">{child}</CanvasUiModeProvider>)).toBe(true);
  });

  it('lets Tab reach them only on the board\'s one stop, right after its button', () => {
    const stop = draw(agent(), { wiring: fakeWiring(), tabbable: true });
    const portsOf = () => [...stop.root().querySelectorAll<HTMLButtonElement>('.canvas-port')];
    expect(portsOf().length).toBeGreaterThan(0);
    expect(portsOf().every(port => port.tabIndex === 0)).toBe(true);
    stop.again({ wiring: fakeWiring(), tabbable: false });
    expect(portsOf().every(port => port.tabIndex === -1)).toBe(true);
    expect(stop.hit().tabIndex).toBe(-1);
  });

  it('keeps a group selected after a press on a port', () => {
    const tile = draw(agent(), { wiring: fakeWiring() });
    fireEvent.pointerDown(tile.root().querySelector('.canvas-port')!, { button: 0, pointerId: 1 });
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(tile.onSelect.mock.calls).toEqual([['a', 'preserve']]);
  });
});

describe('a press and a drag', () => {
  it('selects on a press (keeping a group), claims a left press from the board, and selects it alone on a release', () => {
    const boardDown = vi.fn();
    const tile = draw(agent(), {}, child => <div onPointerDown={boardDown}>{child}</div>);
    fireEvent.pointerDown(tile.hit(), { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    expect(tile.onSelect).toHaveBeenLastCalledWith('a', 'preserve');
    expect(boardDown).not.toHaveBeenCalled();
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 10, clientY: 10 });
    expect(tile.onSelect).toHaveBeenLastCalledWith('a', 'only');
    expect(tile.onMove).not.toHaveBeenCalled();
    // A middle press is the board's (it pans): selected, not claimed, no gesture.
    tile.onSelect.mockClear();
    fireEvent.pointerDown(tile.hit(), { button: 1, pointerId: 2 });
    expect(boardDown).toHaveBeenCalledTimes(1);
    fireEvent.pointerUp(window, { pointerId: 2 });
    expect(tile.onSelect.mock.calls).toEqual([['a', 'preserve']]);
    // Shift, Ctrl or ⌘ adds or removes it, and the release leaves the selection as it is.
    tile.onSelect.mockClear();
    fireEvent.pointerDown(tile.hit(), { button: 0, pointerId: 3, shiftKey: true });
    fireEvent.pointerUp(window, { pointerId: 3 });
    expect(tile.onSelect.mock.calls).toEqual([['a', 'additive']]);
  });

  it('moves it by the pointer\'s travel at the zoom once past 3 px, following its own pointer only', () => {
    const node = agent();
    const tile = draw(node, { scale: .5 });
    fireEvent.pointerDown(tile.hit(), { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(window, { buttons: 1, pointerId: 1, clientX: 102, clientY: 101 });
    expect(tile.onMove).not.toHaveBeenCalled();
    fireEvent.pointerMove(window, { buttons: 1, pointerId: 2, clientX: 300, clientY: 300 });
    expect(tile.onMove).not.toHaveBeenCalled();
    fireEvent.pointerMove(window, { buttons: 1, pointerId: 1, clientX: 110, clientY: 104 });
    expect(tile.onMove).toHaveBeenLastCalledWith('a', node.x + 20, node.y + 8);
    fireEvent.pointerUp(window, { pointerId: 2 });
    fireEvent.pointerMove(window, { buttons: 1, pointerId: 1, clientX: 120, clientY: 100 });
    expect(tile.onMove).toHaveBeenLastCalledWith('a', node.x + 40, node.y);
    fireEvent.pointerUp(window, { pointerId: 1 });
    // A drag is no click: it does not select it alone, and its own last click does not open it.
    expect(tile.onSelect.mock.calls).toEqual([['a', 'preserve']]);
    fireEvent.doubleClick(tile.hit());
    expect(tile.onToggleFocus).not.toHaveBeenCalled();
    // The pointer let go: nothing follows it any more.
    tile.onMove.mockClear();
    fireEvent.pointerMove(window, { buttons: 1, pointerId: 1, clientX: 200, clientY: 200 });
    expect(tile.onMove).not.toHaveBeenCalled();
  });

  it('ends a drag let go where the page never heard it, at the first move with no button held', () => {
    const node = agent();
    const tile = draw(node);
    fireEvent.pointerDown(tile.hit(), { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(window, { buttons: 1, pointerId: 1, clientX: 30, clientY: 0 });
    expect(tile.onMove).toHaveBeenCalledTimes(1);
    // Released outside the window (no pointerup here); back over the board, the pointer moves with no button held.
    fireEvent.pointerMove(window, { buttons: 0, pointerId: 1, clientX: 90, clientY: 40 });
    fireEvent.pointerMove(window, { buttons: 0, pointerId: 1, clientX: 120, clientY: 60 });
    expect(tile.onMove).toHaveBeenCalledTimes(1);
    // It was a drag: no selection of it alone, and its last click opens nothing.
    expect(tile.onSelect.mock.calls).toEqual([['a', 'preserve']]);
    fireEvent.doubleClick(tile.hit());
    expect(tile.onToggleFocus).not.toHaveBeenCalled();
    // A later press starts afresh.
    fireEvent.pointerDown(tile.hit(), { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(window, { buttons: 1, pointerId: 1, clientX: 0, clientY: 20 });
    expect(tile.onMove).toHaveBeenLastCalledWith('a', node.x, node.y + 20);
  });

  it('takes a finger\'s wobble (10 px) as a tap, and opens the sole selection at the tap\'s own click, which comes later', () => {
    vi.useFakeTimers();
    const tap = (id: number, click = true) => {
      fireEvent.pointerDown(tile.hit(), { button: 0, pointerId: id, pointerType: 'touch', clientX: 50, clientY: 50 });
      fireEvent.pointerMove(window, { buttons: 1, pointerId: id, pointerType: 'touch', clientX: 58, clientY: 56 });
      fireEvent.pointerUp(window, { pointerId: id, pointerType: 'touch', clientX: 58, clientY: 56 });
      // The browser's tap gesture sends the click in a later task, after the touch has ended.
      act(() => { vi.advanceTimersByTime(120); });
      if (click) fireEvent.click(tile.hit(), { detail: 1 });
    };
    const tile = draw(agent(), { soleSelected: true });
    tap(1, false);
    expect(tile.onMove).not.toHaveBeenCalled();
    // Not at the release: the card drawn in its place would take the tap's click.
    expect(tile.onToggleFocus).not.toHaveBeenCalled();
    fireEvent.click(tile.hit(), { detail: 1 });
    expect(tile.onToggleFocus).toHaveBeenCalledWith('a');
    // A tap on an icon not selected alone selects it and opens nothing, its late click included.
    tile.onToggleFocus.mockClear();
    tile.again({ soleSelected: false });
    tap(2);
    expect(tile.onSelect).toHaveBeenLastCalledWith('a', 'only');
    expect(tile.onToggleFocus).not.toHaveBeenCalled();
    // A finger that travels drags, and its click opens nothing.
    tile.again({ soleSelected: true });
    fireEvent.pointerDown(tile.hit(), { button: 0, pointerId: 3, pointerType: 'touch', clientX: 50, clientY: 50 });
    fireEvent.pointerMove(window, { buttons: 1, pointerId: 3, pointerType: 'touch', clientX: 62, clientY: 50 });
    expect(tile.onMove).toHaveBeenCalled();
    fireEvent.pointerUp(window, { pointerId: 3, pointerType: 'touch' });
    fireEvent.click(tile.hit(), { detail: 1 });
    // A mouse's press on the one selected only selects it.
    fireEvent.pointerDown(tile.hit(), { button: 0, pointerId: 4, pointerType: 'mouse' });
    fireEvent.pointerUp(window, { pointerId: 4, pointerType: 'mouse' });
    fireEvent.click(tile.hit(), { detail: 1 });
    expect(tile.onToggleFocus).not.toHaveBeenCalled();
    // Once the press has ended (its click never came), a click is no press's: a screen reader's, which opens it.
    fireEvent.pointerDown(tile.hit(), { button: 0, pointerId: 5, pointerType: 'mouse' });
    fireEvent.pointerUp(window, { pointerId: 5, pointerType: 'mouse' });
    act(() => { vi.advanceTimersByTime(10); });
    fireEvent.click(tile.hit(), { detail: 1 });
    expect(tile.onToggleFocus).toHaveBeenCalledTimes(1);
  });

  it('takes a press while another pointer holds a card as a press, never a drag', () => {
    const tile = draw(agent());
    const release = holdCardGesture({ pointerId: 1, pointerType: 'mouse', isPrimary: true }, () => release());
    fireEvent.pointerDown(tile.hit(), { button: 0, pointerId: 2, pointerType: 'touch', isPrimary: true, clientX: 50, clientY: 50 });
    expect(tile.onSelect).toHaveBeenCalledWith('a', 'preserve');
    fireEvent.pointerMove(window, { buttons: 1, pointerId: 2, pointerType: 'touch', clientX: 90, clientY: 50 });
    expect(tile.onMove).not.toHaveBeenCalled();
    fireEvent.pointerUp(window, { pointerId: 2, pointerType: 'touch' });
    // The hold is still the first pointer's: a third pointer's press drags nothing either.
    fireEvent.pointerDown(tile.hit(), { button: 0, pointerId: 3, pointerType: 'touch', isPrimary: false, clientX: 50, clientY: 50 });
    fireEvent.pointerMove(window, { buttons: 1, pointerId: 3, pointerType: 'touch', clientX: 90, clientY: 50 });
    expect(tile.onMove).not.toHaveBeenCalled();
    fireEvent.pointerUp(window, { pointerId: 3, pointerType: 'touch' });
    release();
    // Once the card is let go, the same finger drags the icon.
    fireEvent.pointerDown(tile.hit(), { button: 0, pointerId: 2, pointerType: 'touch', isPrimary: true, clientX: 50, clientY: 50 });
    fireEvent.pointerMove(window, { buttons: 1, pointerId: 2, pointerType: 'touch', clientX: 90, clientY: 50 });
    expect(tile.onMove).toHaveBeenCalled();
    fireEvent.pointerUp(window, { pointerId: 2, pointerType: 'touch' });
  });

  it('takes a pen\'s tap as a tap too, and lets only the latest press end the press', () => {
    vi.useFakeTimers();
    const tile = draw(agent(), { soleSelected: true });
    // A pen's click comes late, as a finger's: the one selected opens at it, and one not selected alone only selects.
    fireEvent.pointerDown(tile.hit(), { button: 0, pointerId: 1, pointerType: 'pen' });
    fireEvent.pointerUp(window, { pointerId: 1, pointerType: 'pen' });
    act(() => { vi.advanceTimersByTime(150); });
    fireEvent.click(tile.hit(), { detail: 1 });
    expect(tile.onToggleFocus).toHaveBeenCalledTimes(1);
    tile.again({ soleSelected: false });
    fireEvent.pointerDown(tile.hit(), { button: 0, pointerId: 4, pointerType: 'pen' });
    fireEvent.pointerUp(window, { pointerId: 4, pointerType: 'pen' });
    act(() => { vi.advanceTimersByTime(150); });
    fireEvent.click(tile.hit(), { detail: 1 });
    expect(tile.onToggleFocus).toHaveBeenCalledTimes(1);
    tile.again({ soleSelected: true });
    act(() => { vi.advanceTimersByTime(1000); });
    // Two quick taps on an icon not selected alone: the first's timer (800 ms) does not end the second press, whose late
    // click is still the press's (it opens nothing), never a screen reader's.
    tile.onToggleFocus.mockClear();
    tile.again({ soleSelected: false });
    fireEvent.pointerDown(tile.hit(), { button: 0, pointerId: 2, pointerType: 'touch' });
    fireEvent.pointerUp(window, { pointerId: 2, pointerType: 'touch' });
    act(() => { vi.advanceTimersByTime(500); });
    fireEvent.pointerDown(tile.hit(), { button: 0, pointerId: 3, pointerType: 'touch' });
    fireEvent.pointerUp(window, { pointerId: 3, pointerType: 'touch' });
    act(() => { vi.advanceTimersByTime(400); });
    fireEvent.click(tile.hit(), { detail: 1 });
    expect(tile.onToggleFocus).not.toHaveBeenCalled();
  });

  it('forgets a Space whose key came up after the focus left and came back', () => {
    const tile = draw(agent());
    act(() => tile.hit().focus());
    fireEvent.keyDown(tile.hit(), { key: ' ' });
    act(() => tile.hit().blur());
    act(() => tile.hit().focus());
    fireEvent.keyUp(tile.hit(), { key: ' ' });
    expect(tile.onToggleFocus).not.toHaveBeenCalled();
  });

  it('never drags for a reader, without a mover, from a port, or after it is gone', () => {
    const tryDrag = (props: Partial<NodeIconTileProps>, from: (root: HTMLElement) => HTMLElement = root => root.querySelector('.awwo-node-icon-hit')!) => {
      const tile = draw(agent(), { wiring: fakeWiring(), ...props });
      fireEvent.pointerDown(from(tile.root()), { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
      fireEvent.pointerMove(window, { buttons: 1, pointerId: 1, clientX: 40, clientY: 40 });
      fireEvent.pointerUp(window, { pointerId: 1 });
      const moved = tile.onMove.mock.calls.length > 0;
      cleanup();
      return moved;
    };
    expect(tryDrag({})).toBe(true);
    expect(tryDrag({ readOnly: true })).toBe(false);
    expect(tryDrag({ onMove: undefined })).toBe(false);
    expect(tryDrag({}, root => root.querySelector('.canvas-port')!)).toBe(false);
    // Unmounted mid-drag: its gesture ends with it.
    const tile = draw(agent());
    fireEvent.pointerDown(tile.hit(), { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
    tile.unmount();
    fireEvent.pointerMove(window, { buttons: 1, pointerId: 1, clientX: 40, clientY: 40 });
    expect(tile.onMove).not.toHaveBeenCalled();
  });
});

describe('opening it', () => {
  it('opens on a double-click, Enter or Space, and on a screen reader\'s click; never from a pointer\'s click or a port', () => {
    const boardDoubleClick = vi.fn();
    const tile = draw(agent(), { wiring: fakeWiring() }, child => <div onDoubleClick={boardDoubleClick}>{child}</div>);
    fireEvent.doubleClick(tile.hit());
    expect(tile.onToggleFocus).toHaveBeenCalledTimes(1);
    // The double-click is the icon's, as a card's is: the board around it never hears it.
    expect(boardDoubleClick).not.toHaveBeenCalled();
    // A pointer's click (detail 1 after its press) is the press's: it selected.
    fireEvent.pointerDown(tile.hit(), { button: 0, pointerId: 1 });
    fireEvent.pointerUp(window, { pointerId: 1 });
    fireEvent.click(tile.hit(), { detail: 1 });
    expect(tile.onToggleFocus).toHaveBeenCalledTimes(1);
    // A click with no press before it, or of detail 0 (NVDA, JAWS, VoiceOver, TalkBack), opens it.
    fireEvent.click(tile.hit(), { detail: 1 });
    expect(tile.onToggleFocus).toHaveBeenCalledTimes(2);
    fireEvent.click(tile.hit(), { detail: 0 });
    expect(tile.onToggleFocus).toHaveBeenCalledTimes(3);
    fireEvent.click(tile.hit(), { detail: 0, shiftKey: true });
    expect(tile.onToggleFocus).toHaveBeenCalledTimes(3);
    // A screen reader that sends a press before its click (detail 0) still opens it.
    fireEvent.pointerDown(tile.hit(), { button: 0, pointerId: 2 });
    fireEvent.pointerUp(window, { pointerId: 2 });
    fireEvent.click(tile.hit(), { detail: 0 });
    expect(tile.onToggleFocus).toHaveBeenCalledTimes(4);
    // A port's click and double-click are the port's.
    const port = tile.root().querySelector<HTMLElement>('.canvas-port')!;
    fireEvent.click(port, { detail: 0 });
    fireEvent.doubleClick(port);
    expect(tile.onToggleFocus).toHaveBeenCalledTimes(4);
    // Enter opens at its keydown; Space when it comes up (as a button's Space), so its keyup never reaches the card.
    fireEvent.keyDown(tile.hit(), { key: 'Enter' });
    fireEvent.keyUp(tile.hit(), { key: 'Enter' });
    expect(tile.onToggleFocus).toHaveBeenCalledTimes(5);
    const space = fireEvent.keyDown(tile.hit(), { key: ' ' });
    expect(space).toBe(false);
    expect(tile.onToggleFocus).toHaveBeenCalledTimes(5);
    fireEvent.keyDown(tile.hit(), { key: ' ', repeat: true });
    fireEvent.keyUp(tile.hit(), { key: ' ' });
    expect(tile.onToggleFocus).toHaveBeenCalledTimes(6);
    // A keyup with no keydown of its own here (the Space began elsewhere) opens nothing; nor do repeats or modifiers.
    fireEvent.keyUp(tile.hit(), { key: ' ' });
    for (const init of [{ key: 'Enter', repeat: true }, { key: 'Enter', ctrlKey: true }, { key: ' ', shiftKey: true }, { key: 'a' }]) fireEvent.keyDown(tile.hit(), init);
    fireEvent.keyUp(tile.hit(), { key: ' ' });
    expect(tile.onToggleFocus).toHaveBeenCalledTimes(6);
    expect(tile.onToggleFocus.mock.calls.every(call => call[0] === 'a')).toBe(true);
  });

  it('lets an Enter held down open it once, and refuses its repeats to whatever the focus went to', () => {
    const tile = draw(agent());
    const after = vi.fn();
    window.addEventListener('keydown', after);
    try {
      fireEvent.keyDown(tile.hit(), { key: 'Enter' });
      expect(tile.onToggleFocus).toHaveBeenCalledTimes(1);
      // The focus is in the card now (its close button); the held key's repeats go nowhere until it comes up.
      const close = document.createElement('button');
      document.body.append(close);
      const repeat = fireEvent.keyDown(close, { key: 'Enter', repeat: true });
      expect(repeat).toBe(false);
      expect(after).not.toHaveBeenCalled();
      fireEvent.keyUp(close, { key: 'Enter' });
      fireEvent.keyDown(close, { key: 'Enter' });
      expect(after).toHaveBeenCalledTimes(1);
      close.remove();
    } finally {
      window.removeEventListener('keydown', after);
    }
  });

  it('is one tab stop at most, and selects it, keeping a selection it is in, when the focus comes without a press', () => {
    vi.useFakeTimers();
    const tile = draw(agent(), { tabbable: false });
    expect(tile.hit().tabIndex).toBe(-1);
    tile.again({ tabbable: true });
    expect(tile.hit().tabIndex).toBe(0);
    act(() => tile.hit().focus());
    expect(document.activeElement).toBe(tile.hit());
    expect(tile.onSelect.mock.calls).toEqual([['a', 'preserve']]);
    act(() => tile.hit().blur());
    // A press's own focus is the press's (it selected already).
    tile.onSelect.mockClear();
    fireEvent.pointerDown(tile.hit(), { button: 0, pointerId: 1 });
    act(() => tile.hit().focus());
    expect(tile.onSelect.mock.calls).toEqual([['a', 'preserve']]);
    act(() => tile.hit().blur());
    // A press let go off the icon (no click follows) is over once its task is: a later focus selects again.
    fireEvent.pointerUp(window, { pointerId: 1 });
    act(() => { vi.advanceTimersByTime(10); });
    tile.onSelect.mockClear();
    act(() => tile.hit().focus());
    expect(tile.onSelect.mock.calls).toEqual([['a', 'preserve']]);
  });
});

describe('its motion', () => {
  it('turns its arc and its eyes in one phase taken when the run starts, and blinks in its own', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_001_234);
    const { root } = draw(agent(), { run: { state: 'running' }, live: true });
    const phase = `${-(1_001_234 % 2200)}ms`;
    expect(root().querySelector<HTMLElement>('.awwo-node-icon-orbit')!.style.animationDelay).toBe(phase);
    expect(root().querySelector<HTMLElement>('.awwo-node-icon-gaze')!.style.animationDelay).toBe(phase);
    expect(root().querySelector<SVGElement>('.awwo-node-icon-eyes')!.style.animationDelay).toBe(`${-(1_001_234 % 4400)}ms`);
  });

  it('hops once when a watched run ends done and shakes when it fails, but not for a result put back as it was', () => {
    vi.useFakeTimers();
    const resting: RunView = { state: 'done' };
    const tile = draw(agent('a', { lastOutput: { text: 'x', at: 1, source: 'run' } } as Partial<CanvasNode>), { run: resting, live: true });
    expect(tile.root().className).not.toMatch(/is-just-/);
    tile.again({ run: { state: 'running' } });
    tile.again({ run: { state: 'done' } });
    expect(tile.root().classList.contains('is-just-done')).toBe(true);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(tile.root().classList.contains('is-just-done')).toBe(false);
    tile.again({ run: { state: 'running' } });
    tile.again({ run: { state: 'failed' } });
    expect(tile.root().classList.contains('is-just-failed')).toBe(true);
    act(() => { vi.advanceTimersByTime(1000); });
    // A page repair the service refused before it ran gives the node its earlier run back: no hop.
    const earlier: RunView = { state: 'done' };
    tile.again({ run: earlier });
    tile.again({ run: { state: 'running' } });
    tile.again({ run: earlier });
    expect(tile.root().className).not.toMatch(/is-just-/);
    // Run again within its second: the mark goes with the state it was for.
    tile.again({ run: { state: 'running' } });
    tile.again({ run: { state: 'done' } });
    expect(tile.root().classList.contains('is-just-done')).toBe(true);
    tile.again({ run: { state: 'running' } });
    expect(tile.root().className).not.toMatch(/is-just-/);
  });
});
