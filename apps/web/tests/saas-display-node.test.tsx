// 预览展示 (preview display) nodes: windows on the board that show, live, what one component or the whole canvas made
// (displayNodes.ts, DisplayTile.tsx). They live in the document's own `displays` list beside the graph, so nothing a run
// reads changes; the content runs as soon as it is shown, zooms, goes full screen and follows what it is pointed at.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { CanvasSurface } from '../src/canvas/CanvasSurface';
import { DisplayLinks, DisplayTile, type DisplayTileProps } from '../src/canvas/DisplayTile';
import { CANVAS_STORAGE_KEY, createSessionNode, sanitizeDocument, type CanvasDocument, type SessionNode } from '../src/canvas/canvasDoc';
import {
  clampDisplaySize, clampZoom, createDisplayNode, DISPLAY_MAX_SIZE, DISPLAY_MIN_SIZE, displayLinkPath, MAX_DISPLAYS, placeDisplayAfter,
  placeDisplayBeside, sanitizeDisplays, stepZoom, type DisplayNode,
} from '../src/canvas/displayNodes';
import { canvasPlanRevision } from '../src/canvas/canvasPlan';
import type { CanvasMultiplayerHost, CanvasMultiplayerSurface } from '../src/canvas/multiplayer/host';
import { canonicalCanvasDocumentJSON } from '../src/saas/canvasDraft';
import { resetAllSessions } from '../src/canvas/sessions';
import { studioGroups } from '../src/canvas/studio/studioModel';
import { LocaleProvider } from '../src/canvas/i18n';
import { outsideAct } from './draw-gap';

const PAGE = '<!doctype html><html><head><title>跳一跳</title></head><body><h1>跳一跳小游戏</h1></body></html>';

function pageNode(id: string, title: string, x = 0): SessionNode {
  return { ...createSessionNode('llm', { x, y: 0 }), id, title,
    contract: { version: 1, inputs: [{ id: 'brief', label: '需求', type: 'text', required: false, value: '' }],
      outputs: [{ id: 'page', label: '页面', type: 'html', required: true, value: '' }] },
    lastOutput: { text: JSON.stringify({ page: PAGE }), at: 2, source: 'run' } };
}
/** notes → page, over the page's own input. */
const WIRE = { id: 'e1', fromNode: 'notes', fromPort: 'result', toNode: 'game', toPort: 'in:brief', dataType: 'text' as const };
function notesNode(id: string, title: string, x = 0): SessionNode {
  return { ...createSessionNode('llm', { x, y: 0 }), id, title, lastOutput: { text: '## 设计说明\n\n- 第一关：跳上平台', at: 1, source: 'run' } };
}
function emptyNode(id: string, title: string, x = 0): SessionNode {
  return { ...createSessionNode('llm', { x, y: 0 }), id, title };
}
const display = (overrides: Partial<DisplayNode> = {}): DisplayNode => ({ id: 'dp-1', kind: 'display', x: 900, y: 0, w: 640, h: 480, title: '', source: { type: 'canvas' }, ...overrides });

describe('display model', () => {
  it('keeps well-formed displays and drops what names nothing to show', () => {
    const kept = sanitizeDisplays([
      { id: 'a', kind: 'display', x: 10, y: 20, w: 50, h: 99999, title: '游戏', source: { type: 'node', nodeId: 'n1' } },
      { id: 'a', kind: 'display', x: 0, y: 0, w: 640, h: 480, title: '', source: { type: 'canvas' } },
      { id: 'b', kind: 'display', x: 'x', y: null, title: 7, source: { type: 'canvas' } },
      { id: 'c', kind: 'display', x: 0, y: 0, source: { type: 'node', nodeId: '' } },
      { id: 'd', kind: 'session', x: 0, y: 0, source: { type: 'canvas' } },
      { id: 'e', kind: 'display', x: 0, y: 0, source: { type: 'everything' } },
      null, 'display', [],
    ]);
    expect(kept).toEqual([
      { id: 'a', kind: 'display', x: 10, y: 20, w: DISPLAY_MIN_SIZE.w, h: DISPLAY_MAX_SIZE.h, title: '游戏', source: { type: 'node', nodeId: 'n1' } },
      { id: 'b', kind: 'display', x: 0, y: 0, w: 720, h: 540, title: '', source: { type: 'canvas' } },
    ]);
    expect(sanitizeDisplays([])).toBeUndefined();
    expect(sanitizeDisplays(undefined)).toBeUndefined();
    expect(sanitizeDisplays({ id: 'a' })).toBeUndefined();
    const many = Array.from({ length: MAX_DISPLAYS + 5 }, (_, index) => display({ id: `d${index}` }));
    expect(sanitizeDisplays(many)).toHaveLength(MAX_DISPLAYS);
  });

  it('rides in the document beside the graph, and a document without one is exactly what it was', () => {
    const base: CanvasDocument = { version: 2, updatedAt: 1, nodes: [pageNode('n1', '游戏')], edges: [], waypoints: [], view: null };
    const plain = sanitizeDocument(base);
    expect('displays' in plain).toBe(false);
    expect(canonicalCanvasDocumentJSON(plain)).toBe(canonicalCanvasDocumentJSON(base));
    const shown = sanitizeDocument({ ...base, displays: [display({ source: { type: 'node', nodeId: 'n1' } })] });
    expect(shown.displays).toEqual([display({ source: { type: 'node', nodeId: 'n1' } })]);
    // It outlives the component it shows (deleting it can be undone), and it is no part of what a run or a plan reads.
    expect(sanitizeDocument({ ...shown, nodes: [] }).displays).toHaveLength(1);
    expect(canvasPlanRevision(shown)).toBe(canvasPlanRevision(plain));
    expect(JSON.parse(canonicalCanvasDocumentJSON(shown)).displays).toHaveLength(1);
  });

  it('places a display beside its component, clear of the other cards, or at the end of the board', () => {
    const card = { x: 0, y: 0, w: 260, h: 128 };
    expect(placeDisplayBeside(card, [card])).toEqual({ x: 332, y: 0 });
    const next = { x: 400, y: 0, w: 260, h: 128 };
    const spot = placeDisplayBeside(card, [card, next]);
    expect(spot).toEqual({ x: 0, y: 200 });
    expect(placeDisplayAfter([card, next])).toEqual({ x: 780, y: 0 });
    expect(placeDisplayAfter([])).toEqual({ x: 0, y: 0 });
    expect(createDisplayNode({ x: 10.4, y: 3.6 })).toMatchObject({ kind: 'display', x: 10, y: 4, w: 720, h: 540, source: { type: 'canvas' } });
    expect(clampDisplaySize(Number.NaN, 10)).toEqual({ w: 720, h: DISPLAY_MIN_SIZE.h });
  });

  it('zooms in steps and keeps a continuous zoom in range', () => {
    expect(stepZoom(1, 1)).toBe(1.1);
    expect(stepZoom(1, -1)).toBe(0.9);
    expect(stepZoom(1.2, 1)).toBe(1.25);
    expect(stepZoom(4, 1)).toBe(4);
    expect(stepZoom(0.25, -1)).toBe(0.25);
    expect(clampZoom(12)).toBe(4);
    expect(clampZoom(0.01)).toBe(0.25);
    expect(clampZoom(Number.NaN)).toBe(1);
  });

  it('links a component to its display between their facing sides', () => {
    expect(displayLinkPath({ x: 0, y: 0, w: 100, h: 50 }, { x: 300, y: 0, w: 200, h: 150 })).toMatch(/^M 100 25 C .* 300 75$/);
    expect(displayLinkPath({ x: 0, y: 0, w: 100, h: 50 }, { x: 0, y: 400, w: 100, h: 50 })).toMatch(/^M 50 50 C .* 50 400$/);
  });
});

describe('the display on the board', () => {
  afterEach(() => cleanup());
  const nodes = [notesNode('notes', '玩法设计'), pageNode('game', '小游戏页面', 400)];
  const groups = studioGroups({ nodes, edges: [WIRE] });
  const choices = [{ id: 'notes', title: '玩法设计' }, { id: 'game', title: '小游戏页面' }, { id: 'idle', title: '还没开始的组件' }];
  const canvasEntries = groups.flatMap(group => group.entries);
  const props = (overrides: Partial<DisplayTileProps> = {}): DisplayTileProps => ({
    display: display(), groups, choices, canvasEntries, running: new Set(), scale: 1, ...overrides,
  });
  const frame = (root: HTMLElement) => root.querySelector('iframe');

  it('shows the whole canvas: its result large and running, every other deliverable beside it', async () => {
    const view = render(<DisplayTile {...props()} />);
    const tile = screen.getByTestId('canvas-display-dp-1');
    expect(tile).toHaveAttribute('aria-label', '预览展示：整个画布 · 全部成果');
    const hero = tile.querySelector('.awwo-display-card.is-hero') as HTMLElement;
    expect(within(hero).getByText('小游戏页面')).toBeTruthy();
    expect(within(hero).getByText('最终成果')).toBeTruthy();
    // The page runs the moment it is shown: no button in between.
    await waitFor(() => expect(frame(hero)?.getAttribute('srcdoc')).toContain('跳一跳小游戏'));
    const strip = tile.querySelector('.awwo-display-strip') as HTMLElement;
    expect(within(strip).getByRole('heading', { name: '设计说明' })).toBeTruthy();
    expect(within(tile.querySelector('.awwo-display-chips') as HTMLElement).getAllByRole('button').map(button => button.textContent)).toEqual(['全部', '小游戏页面', '玩法设计']);
    // One component alone, and back.
    fireEvent.click(within(strip).getByRole('button', { name: '单独展示' }));
    expect(screen.getByRole('button', { name: '全部成果' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '设计说明' })).toBeTruthy();
    expect(frame(tile)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '全部成果' }));
    await waitFor(() => expect(frame(tile)).not.toBeNull());
    view.unmount();
  });

  it('zooms its content with the buttons and with Ctrl + scroll, and keeps every scroll over the content', async () => {
    const outside = vi.fn();
    render(<div onWheel={outside}><DisplayTile {...props({ display: display({ source: { type: 'node', nodeId: 'game' } }) })} /></div>);
    const tile = screen.getByTestId('canvas-display-dp-1');
    await waitFor(() => expect(frame(tile)).not.toBeNull());
    const stage = () => tile.querySelector('.awwo-display-zoom') as HTMLElement;
    expect(stage().style.transform).toBe('');
    fireEvent.click(screen.getByRole('button', { name: '放大' }));
    expect(stage().style.transform).toBe('scale(1.1)');
    expect(screen.getByRole('button', { name: /原始大小（当前 110%）/ })).toHaveTextContent('110%');
    fireEvent.click(screen.getByRole('button', { name: '缩小' }));
    fireEvent.click(screen.getByRole('button', { name: '缩小' }));
    expect(stage().style.transform).toBe('scale(0.9)');
    expect(parseFloat(stage().style.width)).toBeCloseTo(111.11, 1);
    fireEvent.click(screen.getByRole('button', { name: /原始大小/ }));
    expect(stage().style.transform).toBe('');
    const body = tile.querySelector('.awwo-display-body') as HTMLElement;
    fireEvent.wheel(body, { deltaY: -100, ctrlKey: true });
    expect(screen.getByRole('button', { name: /原始大小/ })).toHaveTextContent('122%');
    fireEvent.wheel(body, { deltaY: 100 });
    expect(outside).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /原始大小/ })).toHaveTextContent('122%');
    // Over the head the board zooms, as it does over any card.
    fireEvent.wheel(tile.querySelector('.awwo-display-head') as HTMLElement, { deltaY: 100 });
    expect(outside).toHaveBeenCalledTimes(1);
  });

  it('shows one component, file by file, and says what is missing or still on its way', async () => {
    const shared = { ...pageNode('multi', '多文件组件'), contract: { version: 1 as const, inputs: [], outputs: [
      { id: 'page', label: '页面', type: 'html' as const, required: true, value: '' },
      { id: 'notes', label: '说明', type: 'markdown' as const, required: false, value: '' },
    ] }, lastOutput: { text: JSON.stringify({ page: PAGE, notes: '## 玩法\n\n点击跳跃' }), at: 3, source: 'run' as const } };
    const multiGroups = studioGroups({ nodes: [shared], edges: [] });
    const view = render(<DisplayTile {...props({ groups: multiGroups, canvasEntries: multiGroups[0].entries, choices: [{ id: 'multi', title: '多文件组件' }],
      display: display({ source: { type: 'node', nodeId: 'multi' } }) })} />);
    const chips = within(document.querySelector('.awwo-display-chips') as HTMLElement);
    expect(chips.getAllByRole('button').map(button => button.textContent)).toEqual(['页面.html', '说明.md']);
    await waitFor(() => expect(frame(document.body)).not.toBeNull());
    fireEvent.click(chips.getByRole('button', { name: '说明.md' }));
    expect(screen.getByRole('heading', { name: '玩法' })).toBeTruthy();
    view.unmount();

    render(<DisplayTile {...props({ display: display({ source: { type: 'node', nodeId: 'idle' } }) })} />);
    expect(screen.getByText('「还没开始的组件」还没有交付物。和它对话或运行它，成果会显示在这里。')).toBeTruthy();
    cleanup();
    render(<DisplayTile {...props({ display: display({ source: { type: 'node', nodeId: 'idle' } }), running: new Set(['idle']) })} />);
    expect(screen.getByRole('status')).toHaveTextContent('「还没开始的组件」正在制作…');
    expect(screen.getByTestId('canvas-display-dp-1')).toHaveClass('is-running');
    cleanup();
    render(<DisplayTile {...props({ display: display({ source: { type: 'node', nodeId: 'gone' } }) })} />);
    expect(screen.getByText('它展示的组件已不在画布上，请在上方换一个。')).toBeTruthy();
    expect(screen.getByRole('combobox', { name: '展示内容' })).toHaveValue('node:gone');
  });

  it('is pointed, moved, resized and deleted through its own controls, in world units', () => {
    const onChangeSource = vi.fn(), onMove = vi.fn(), onResize = vi.fn(), onDelete = vi.fn(), onSelect = vi.fn();
    render(<DisplayTile {...props({ scale: 0.5, onChangeSource, onMove, onResize, onDelete, onSelect })} />);
    const select = screen.getByRole('combobox', { name: '展示内容' });
    expect(within(select).getAllByRole('option').map(option => option.textContent)).toEqual(['整个画布 · 全部成果', '玩法设计', '小游戏页面', '还没开始的组件']);
    fireEvent.change(select, { target: { value: 'node:game' } });
    expect(onChangeSource).toHaveBeenCalledWith('dp-1', { type: 'node', nodeId: 'game' });
    const head = document.querySelector('.awwo-display-head') as HTMLElement;
    fireEvent.pointerDown(head, { button: 0, clientX: 100, clientY: 100 });
    expect(onSelect).toHaveBeenCalledWith('dp-1');
    expect(document.querySelector('.canvas-root')).toBeNull();
    fireEvent.pointerMove(window, { clientX: 120, clientY: 110 });
    fireEvent.pointerUp(window, { clientX: 120, clientY: 110 });
    expect(onMove).toHaveBeenLastCalledWith('dp-1', 940, 20);
    fireEvent.pointerDown(screen.getByTestId('canvas-display-resize-dp-1'), { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(window, { clientX: 50, clientY: -30 });
    fireEvent.pointerUp(window, { clientX: 50, clientY: -30 });
    expect(onResize).toHaveBeenLastCalledWith('dp-1', 740, 420);
    fireEvent.click(screen.getByRole('button', { name: '删除这个预览展示' }));
    expect(onDelete).toHaveBeenCalledWith('dp-1');
  });

  it('can only be looked at on a canvas opened to read, and far out shows what it holds instead of running it', () => {
    render(<DisplayTile {...props({ scale: 0.1 })} />);
    expect(screen.getByRole('combobox', { name: '展示内容' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: '删除这个预览展示' })).toBeNull();
    expect(screen.queryByTestId('canvas-display-resize-dp-1')).toBeNull();
    expect(document.querySelector('iframe')).toBeNull();
    expect(document.querySelector('.awwo-display-summary')).toHaveTextContent('2 个成果');
    expect(screen.getByTestId('canvas-display-dp-1')).toHaveClass('is-far');
  });

  it('goes full screen on this very element, so what runs in it keeps running', async () => {
    const request = vi.fn(function (this: HTMLElement) {
      Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => this });
      document.dispatchEvent(new Event('fullscreenchange'));
      return Promise.resolve();
    });
    Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', { configurable: true, value: request });
    try {
      render(<DisplayTile {...props({ display: display({ source: { type: 'node', nodeId: 'game' } }), onDelete: vi.fn() })} />);
      const tile = screen.getByTestId('canvas-display-dp-1');
      await waitFor(() => expect(frame(tile)).not.toBeNull());
      const running = frame(tile);
      fireEvent.click(screen.getByRole('button', { name: '全屏' }));
      expect(request).toHaveBeenCalledTimes(1);
      expect(request.mock.contexts[0]).toBe(tile);
      await waitFor(() => expect(tile).toHaveClass('is-fullscreen'));
      expect(frame(tile)).toBe(running);
      expect(screen.getByRole('button', { name: '退出全屏' })).toHaveAttribute('aria-pressed', 'true');
      expect(screen.queryByRole('button', { name: '删除这个预览展示' })).toBeNull();
    } finally {
      delete (HTMLElement.prototype as { requestFullscreen?: unknown }).requestFullscreen;
      Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => null });
    }
  });

  it('speaks English where the canvas does', () => {
    render(<LocaleProvider locale="en"><DisplayTile {...props()} /></LocaleProvider>);
    expect(screen.getByTestId('canvas-display-dp-1')).toHaveAttribute('aria-label', 'Preview display: Whole canvas · all results');
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Show alone' })).toHaveLength(2);
  });

  // Someone else's change (多人同屏) reaches the page in a draw no input of its own asked for, and React runs that draw's
  // effects in a later task. A component picked in between is the reader's, kept and shown alone.
  describe('as someone else changes the components', () => {
    const three = [notesNode('notes', '玩法设计'), pageNode('game', '小游戏页面', 400), notesNode('story', '剧情设定', 800)];
    /** The board's stand-in: its components change from outside, and it counts the effects run of its draws. */
    function Board({ effects, change }: { effects: { ran: number }; change: { to?: (next: SessionNode[]) => void } }) {
      const [list, setList] = useState<SessionNode[]>(three);
      change.to = setList;
      useEffect(() => { effects.ran++; }, [list, effects]);
      const shown = studioGroups({ nodes: list, edges: [WIRE] });
      return <DisplayTile {...props({ groups: shown, canvasEntries: shown.flatMap(group => group.entries), choices: list.map(node => ({ id: node.id, title: node.title })) })} />;
    }
    const chip = (title: string) => within(document.querySelector('.awwo-display-chips') as HTMLElement).getByRole('button', { name: title });
    const shownAlone = () => document.querySelector('.awwo-display-chip-title')?.textContent ?? null;

    it('keeps a component picked right after the draw that took the one shown away, before that draw’s effects have run', async () => {
      const effects = { ran: 0 };
      const change: { to?: (next: SessionNode[]) => void } = {};
      render(<Board effects={effects} change={change} />);
      fireEvent.click(chip('剧情设定'));
      expect(shownAlone()).toBe('剧情设定');
      let effectsAtThePick = -1;
      await outsideAct(() => {
        if (shownAlone() !== null) return false;
        effectsAtThePick = effects.ran;
        chip('玩法设计').click();
        return true;
      }, () => change.to!(three.filter(node => node.id !== 'story')));
      // Picked before the effects of the draw that took 剧情设定 away ran (1, the first draw's), which have run since (2).
      expect([effectsAtThePick, effects.ran]).toEqual([1, 2]);
      expect(shownAlone()).toBe('玩法设计');
      expect(screen.getByRole('heading', { name: '设计说明' })).toBeTruthy();
    });

    it('forgets a component that went away: drawn again, the display still shows them all', () => {
      const effects = { ran: 0 };
      const change: { to?: (next: SessionNode[]) => void } = {};
      render(<Board effects={effects} change={change} />);
      fireEvent.click(chip('剧情设定'));
      act(() => change.to!(three.filter(node => node.id !== 'story')));
      expect(shownAlone()).toBeNull();
      act(() => change.to!(three));
      expect(shownAlone()).toBeNull();
      expect(chip('全部')).toHaveAttribute('aria-pressed', 'true');
    });
  });

  it('draws a dashed link only for a display that shows one component on the board', () => {
    const boxes = new Map([['game', { x: 0, y: 0, w: 260, h: 128 }]]);
    const view = render(<svg><DisplayLinks displays={[display({ source: { type: 'node', nodeId: 'game' } }), display({ id: 'dp-2' }), display({ id: 'dp-3', source: { type: 'node', nodeId: 'gone' } })]} boxes={boxes} /></svg>);
    expect(view.container.querySelectorAll('.awwo-display-link')).toHaveLength(1);
    view.unmount();
    const empty = render(<DisplayLinks displays={[display()]} boxes={boxes} />);
    expect(empty.container.firstChild).toBeNull();
  });
});

describe('displays on the canvas', () => {
  class SilentResizeObserver { observe() {} unobserve() {} disconnect() {} }
  const stored = () => JSON.parse(localStorage.getItem(CANVAS_STORAGE_KEY)!) as CanvasDocument;

  beforeEach(() => {
    cleanup(); resetAllSessions(); localStorage.clear();
    vi.stubGlobal('ResizeObserver', SilentResizeObserver);
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 503, json: async () => ({}) })));
    const doc: CanvasDocument = { version: 2, updatedAt: 1, nodes: [notesNode('notes', '玩法设计'), pageNode('game', '小游戏页面', 420)],
      edges: [WIRE], waypoints: [], view: { x: 0, y: 0, scale: 1 } };
    localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify(doc));
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('adds a whole-canvas display from the view tools, at the end of the board, and shows the same one again after', async () => {
    render(<CanvasSurface />);
    fireEvent.click(screen.getByRole('button', { name: '预览展示：实时查看整个画布的全部成果' }));
    const saved = await waitFor(() => { const list = stored().displays; expect(list).toHaveLength(1); return list!; });
    expect(saved[0]).toMatchObject({ kind: 'display', source: { type: 'canvas' }, w: 720, h: 540 });
    // Right of everything on the board (the page card is at x 420, 260 wide as a card).
    expect(saved[0].x).toBe(420 + 260 + 120);
    // Nothing a run reads changed.
    expect(stored().nodes.map(node => node.id)).toEqual(['notes', 'game']);
    expect(stored().edges).toHaveLength(1);
    const tile = screen.getByTestId(`canvas-display-${saved[0].id}`);
    expect(tile).toHaveClass('canvas-tile--selected');
    await waitFor(() => expect(tile.querySelector('iframe')?.getAttribute('srcdoc')).toContain('跳一跳小游戏'));
    fireEvent.click(screen.getByRole('button', { name: '预览展示：实时查看整个画布的全部成果' }));
    expect(stored().displays).toHaveLength(1);
  });

  it('shows one component from its card, beside it, linked to it; Delete removes it and undo brings it back', async () => {
    render(<CanvasSurface />);
    const card = screen.getByTestId('canvas-tile-game');
    fireEvent.click(within(card).getByRole('button', { name: '更多节点操作' }));
    fireEvent.click(within(card).getByRole('button', { name: '在预览展示中查看' }));
    const saved = await waitFor(() => { const list = stored().displays; expect(list).toHaveLength(1); return list!; });
    expect(saved[0].source).toEqual({ type: 'node', nodeId: 'game' });
    expect(saved[0].x).toBeGreaterThanOrEqual(420 + 260);
    expect(document.querySelectorAll('.awwo-display-link')).toHaveLength(1);
    // Asking again shows the same display rather than a second one.
    fireEvent.click(within(card).getByRole('button', { name: '更多节点操作' }));
    fireEvent.click(within(card).getByRole('button', { name: '在预览展示中查看' }));
    expect(stored().displays).toHaveLength(1);
    // Moving it while nothing else changes is one edit of the display alone.
    const head = screen.getByTestId(`canvas-display-${saved[0].id}`).querySelector('.awwo-display-head') as HTMLElement;
    fireEvent.pointerDown(head, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(window, { clientX: 30, clientY: 40 });
    fireEvent.pointerUp(window, { clientX: 30, clientY: 40 });
    await waitFor(() => expect(stored().displays![0]).toMatchObject({ x: saved[0].x + 30, y: saved[0].y + 40 }));
    act(() => { fireEvent.keyDown(window, { key: 'Delete' }); });
    await waitFor(() => expect(stored().displays).toBeUndefined());
    expect(screen.queryByTestId(`canvas-display-${saved[0].id}`)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /撤销/ }));
    await waitFor(() => expect(stored().displays).toHaveLength(1));
    expect(screen.getByTestId(`canvas-display-${saved[0].id}`)).toBeTruthy();
  });

  it('is offered in the right-click menu where the board is edited by hand', async () => {
    render(<CanvasSurface />);
    const world = document.querySelector('.canvas-viewport') as HTMLElement;
    fireEvent.contextMenu(world, { clientX: 200, clientY: 300 });
    fireEvent.click(screen.getByRole('menuitem', { name: '预览展示' }));
    await waitFor(() => expect(stored().displays).toHaveLength(1));
    expect(stored().displays![0].source).toEqual({ type: 'canvas' });
  });

  // 多人同屏: the host hands the surface someone else's change as it arrives (a stream's message), so the page draws it
  // in a task of its own and runs that draw's effects (the document's save among them) in a later one. A display pressed
  // in between is the reader's selection. (A draw that renders the cards right after their mount runs its effects at once
  // instead: React finishes it with a sync pass for the no-op updates the cards' layout effects queued, so someone else
  // has moved the cards first.)
  describe('as someone else changes the canvas', () => {
    let surface: CanvasMultiplayerSurface | null = null;
    const host: CanvasMultiplayerHost = { connect: next => { surface = next; }, presence: () => undefined };
    const tile = (id: string) => screen.queryByTestId(`canvas-display-${id}`);
    /** A press on a display's content, as a pointer's (no act: React handles it as the browser delivers it). */
    const press = (id: string) => tile(id)!.querySelector('.awwo-display-body')!
      .dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
    const moved = (doc: CanvasDocument) => ({ ...doc, nodes: doc.nodes.map(node => ({ ...node, x: node.x + 40 })) });
    beforeEach(() => {
      surface = null;
      localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...stored(), displays: [display({ id: 'dp-a', x: 900 }), display({ id: 'dp-b', x: 1700 })] }));
    });

    it('keeps the display a reader presses as someone else’s deletion of the selected one is drawn, before that draw’s effects', async () => {
      render(<CanvasSurface multiplayer={host} />);
      act(() => { press('dp-a'); });
      expect(tile('dp-a')).toHaveClass('canvas-tile--selected');
      await act(async () => { surface!.rebase({ working: moved, history: moved }); });
      const deleted = (doc: CanvasDocument) => ({ ...doc, displays: doc.displays!.filter(item => item.id !== 'dp-a') });
      let savedAtThePress: string[] = [];
      await outsideAct(() => {
        if (tile('dp-a')) return false;
        savedAtThePress = stored().displays!.map(item => item.id);
        press('dp-b');
        return true;
      }, () => surface!.rebase({ working: deleted, history: deleted }));
      // Pressed before that draw's effects ran: the document saved then still held the deleted display.
      expect(savedAtThePress).toEqual(['dp-a', 'dp-b']);
      expect(stored().displays!.map(item => item.id)).toEqual(['dp-b']);
      expect(tile('dp-b')).toHaveClass('canvas-tile--selected');
    });

    it('forgets a selected display someone else deleted: drawn again, it is not selected', async () => {
      render(<CanvasSurface multiplayer={host} />);
      act(() => { press('dp-a'); });
      const held = stored().displays!.find(item => item.id === 'dp-a')!;
      const deleted = (doc: CanvasDocument) => ({ ...doc, displays: doc.displays!.filter(item => item.id !== 'dp-a') });
      await act(async () => { surface!.rebase({ working: deleted, history: deleted }); });
      expect(tile('dp-a')).toBeNull();
      const restored = (doc: CanvasDocument) => ({ ...doc, displays: [held, ...doc.displays!] });
      await act(async () => { surface!.rebase({ working: restored, history: restored }); });
      expect(tile('dp-a')).not.toHaveClass('canvas-tile--selected');
    });

    it('keeps the display a reader presses as someone else’s deletion of one of the selected cards is drawn, before that draw’s effects', async () => {
      render(<CanvasSurface multiplayer={host} />);
      const selected = () => [...document.querySelectorAll('.canvas-tile--selected')].map(item => (item as HTMLElement).dataset.nodeId ?? (item as HTMLElement).dataset.displayId);
      // Selecting cards lets a selected display go.
      act(() => { press('dp-b'); });
      expect(selected()).toEqual(['dp-b']);
      for (const title of ['玩法设计', '小游戏页面']) {
        const target = screen.getByRole('button', { name: `打开 ${title}`, exact: true });
        fireEvent.pointerDown(target, { button: 0, pointerId: 1, shiftKey: true });
        fireEvent.pointerUp(target, { button: 0, pointerId: 1, shiftKey: true });
        fireEvent.click(target, { shiftKey: true });
      }
      expect(selected()).toEqual(['notes', 'game']);
      await act(async () => { surface!.rebase({ working: moved, history: moved }); });
      const deleted = (doc: CanvasDocument) => ({ ...doc, nodes: doc.nodes.filter(node => node.id !== 'notes'), edges: [] });
      let savedAtThePress: string[] = [];
      await outsideAct(() => {
        if (screen.queryByTestId('canvas-tile-notes')) return false;
        savedAtThePress = stored().nodes.map(node => node.id);
        press('dp-b');
        return true;
      }, () => surface!.rebase({ working: deleted, history: deleted }));
      // Pressed before that draw's effects ran (the saved document still held the deleted card); the press selects the
      // display alone, as it does on its own.
      expect(savedAtThePress).toEqual(['notes', 'game']);
      expect(stored().nodes.map(node => node.id)).toEqual(['game']);
      expect(selected()).toEqual(['dp-b']);
    });
  });
});
