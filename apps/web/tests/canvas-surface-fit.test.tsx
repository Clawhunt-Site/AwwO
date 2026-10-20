// CanvasSurface viewport fitting.
//
// Part 1 — the fit fallback. The fit math needs the viewport's pixel size. That size normally
// arrives from the viewport's own mount measurement plus a ResizeObserver — but BOTH can still
// report 0 when a fit is requested: the mount measure runs before layout settles, and RO callbacks
// are delivered on frame boundaries, which stall in a backgrounded / non-compositing tab (observed
// live: 焦点 and 适应全部 became silent no-ops, with nothing on screen to explain why). So focus/fit
// must fall back to a live measurement of the canvas root rather than doing nothing.
//
// Part 2 — fitting to the REAL stage. A focused node (delivery drawer included) is capped so it
// never overflows the stage, and the overview refits when the stage changes shape (window resize,
// a side rail toggling). An open node refits to the new stage instead, while its camera is still the
// one the app opened it with; a camera the operator zoomed or panned is theirs and is left alone.
//
// Part 3 — opening a node where it is. Opening keeps the card's corner where it sat on screen (it is
// never re-centred) and moves the camera only as far as the stage needs; every way out of the open
// node — closing it, deleting it — glides back to the operator's camera, which is also the one saved.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CanvasSurface } from '../src/canvas/CanvasSurface';
import { CANVAS_STORAGE_KEY, createSessionNode, emptyDocument, type CanvasDocument } from '../src/canvas/canvasDoc';
import { canvasStorage, configureCanvasStorage } from '../src/canvas/canvasStorage';
import { PLANNING_STORAGE_KEY } from '../src/canvas/canvasPlanning';
import { clearSaaSCanvas, configureSaaSCanvas } from '../src/saas/canvasBridge';
import { resetAllSessions } from '../src/canvas/sessions';
import { RAIL_BOT_KEY, RAIL_MODEL_KEY } from '../src/canvas/railState';
import { CanvasUiModeProvider } from '../src/canvas/uiMode';

/** A ResizeObserver that never delivers — the exact condition that stranded focus/fit. */
class SilentResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function seed(over: Partial<ReturnType<typeof createSessionNode>> = {}): CanvasDocument {
  const n = { ...createSessionNode('llm', { x: 900, y: 700 }), id: 's1', title: 'LLM 会话', ...over };
  return { version: 2, updatedAt: 1, nodes: [n], edges: [], waypoints: [], view: { x: 0, y: 0, scale: 1 } };
}

/**
 * jsdom reports 0 for every rect. Give ONLY the canvas root a real size so the fallback has
 * something to measure, and leave the inner viewport at 0 so the normal path stays unavailable —
 * that is precisely the situation being pinned.
 */
function stubRootSize(w = 1280, h = 720) {
  const real = Element.prototype.getBoundingClientRect;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.classList.contains('canvas-root')) {
      return { x: 0, y: 0, top: 0, left: 0, right: w, bottom: h, width: w, height: h, toJSON: () => ({}) } as DOMRect;
    }
    return real.call(this);
  });
}

/** Every element measures as the current stage box, so the viewport's own measurement works too. */
function stubStage(stage: { w: number; h: number }) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() =>
    ({ x: 0, y: 0, top: 0, left: 0, right: stage.w, bottom: stage.h, width: stage.w, height: stage.h, toJSON: () => ({}) } as DOMRect));
}

function transformOf(world: HTMLElement): [number, number, number] {
  const match = world.style.transform.match(/^translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)$/)!;
  return match.slice(1).map(Number) as [number, number, number];
}

function expectBoxOnStage(world: HTMLElement, box: { x: number; y: number; w: number; h: number }, stage: { w: number; h: number }) {
  const [x, y, scale] = transformOf(world);
  expect(x + box.x * scale).toBeGreaterThanOrEqual(0);
  expect(x + (box.x + box.w) * scale).toBeLessThanOrEqual(stage.w);
  expect(y + box.y * scale).toBeGreaterThanOrEqual(0);
  expect(y + (box.y + box.h) * scale).toBeLessThanOrEqual(stage.h);
  return scale;
}

const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 250)); });
/** Opening and closing a node glide the camera (260 ms); wait for the glide to land. */
const glideDone = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 340)); });

beforeEach(() => {
  cleanup();
  resetAllSessions();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.stubGlobal('ResizeObserver', SilentResizeObserver);
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 503, json: async () => ({}) })));
  localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify(seed()));
});
afterEach(() => { cleanup(); clearSaaSCanvas(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('CanvasSurface fit fallback', () => {
  it('focuses a node even when the observed viewport size never arrives', async () => {
    stubRootSize();
    render(<CanvasSurface />);

    const world = document.querySelector('.canvas-world') as HTMLElement;
    expect(world.style.transform).toBe('translate(0px, 0px) scale(1)');

    fireEvent.click(screen.getByRole('button', { name: '打开 LLM 会话', exact: true }));

    await waitFor(() => {
      // The node sits at (900,700), far from the origin — any real fit must both pan and zoom.
      expect(world.style.transform).not.toBe('translate(0px, 0px) scale(1)');
    });
    expect(screen.getByTestId('canvas-tile-s1').dataset.lod).toBe('focus');
  });

  it('does nothing (rather than dividing by a zero size) when NOTHING is laid out', async () => {
    // No root stub: every rect is 0, so there is genuinely no viewport to fit into.
    render(<CanvasSurface />);
    const world = document.querySelector('.canvas-world') as HTMLElement;

    fireEvent.click(screen.getByRole('button', { name: '打开 LLM 会话', exact: true }));

    await waitFor(() => expect(screen.getByTestId('canvas-tile-s1')).toBeTruthy());
    expect(world.style.transform).toBe('translate(0px, 0px) scale(1)');
  });
});

describe('CanvasSurface fits the real stage', () => {
  it('keeps a delivery open at readable width when the two rails leave a 700px stage', async () => {
    localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify(seed({ w: 520, h: 380, deliverablesOpen: true })));
    const stage = { w: 700, h: 700 };
    stubStage(stage);
    render(<CanvasSurface />);
    fireEvent.click(screen.getByRole('button', { name: '打开 LLM 会话', exact: true }));
    const tile = await screen.findByTestId('canvas-tile-s1');
    await waitFor(() => expect(tile.dataset.lod).toBe('focus'));
    await glideDone();
    expect(document.querySelector('.canvas-root')).toHaveAttribute('data-narrow-focus', 'true');
    expect(tile.style.width).toBe('520px');
    expect(transformOf(document.querySelector('.canvas-world') as HTMLElement)[2]).toBeGreaterThanOrEqual(0.95);
  });

  it('caps the focus scale so a node with its delivery drawer never overflows the stage', async () => {
    // Saved 1400x900 with the drawer open: wider AND taller than a 1280x720 stage minus padding.
    localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify(seed({ w: 1400, h: 900, deliverablesOpen: true })));
    const stage = { w: 1280, h: 720 };
    stubRootSize(stage.w, stage.h);
    render(<CanvasSurface />);
    const world = document.querySelector('.canvas-world') as HTMLElement;
    fireEvent.click(screen.getByRole('button', { name: '打开 LLM 会话', exact: true }));
    await waitFor(() => expect(screen.getByTestId('canvas-tile-s1').dataset.lod).toBe('focus'));
    await glideDone();
    const scale = expectBoxOnStage(world, { x: 900, y: 700, w: 1400, h: 900 }, stage);
    // Below fitBounds' 0.75 readable floor: only the cap can put the whole node on stage.
    expect(scale).toBeLessThan(0.75);
    expect(scale).toBeCloseTo((stage.h - 24 - 82) / 900, 3);
  });

  it('saves a requested Fit All even when the stage changes before that save lands', async () => {
    // Every observer hears the resize, as the file's other tests do: an opened node observes its chat column too (useShortColumn).
    const observers: Array<() => void> = [];
    const deliverResize = () => observers.forEach(deliver => deliver());
    vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { observers.push(callback); } observe() {} unobserve() {} disconnect() {} });
    localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...seed(), view: null }));
    const stage = { w: 1200, h: 800 };
    stubStage(stage);
    render(<CanvasSurface />);
    const world = document.querySelector('.canvas-world') as HTMLElement;
    await waitFor(() => expect(world.style.transform).not.toBe('translate(0px, 0px) scale(1)'));
    fireEvent.click(screen.getByRole('button', { name: '放大', exact: true }));
    fireEvent.click(screen.getByRole('button', { name: '查看全部节点', exact: true }));
    const requested = transformOf(world);
    // Within the save's 400 ms the stage changes and the app refits its own camera: the requested one still lands.
    stage.w = 900;
    act(() => deliverResize());
    await settle();
    expect(transformOf(world)).not.toEqual(requested);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
    const saved = (JSON.parse(localStorage.getItem(CANVAS_STORAGE_KEY)!) as CanvasDocument).view!;
    expect([saved.x, saved.y, saved.scale]).toEqual(requested);
  });

  it('refits the overview, and an open node, when the stage resizes, but never a camera the operator took', async () => {
    // Every observer hears the resize, as the file's other tests do: an opened node observes its chat column too (useShortColumn).
    const observers: Array<() => void> = [];
    const deliverResize = () => observers.forEach(deliver => deliver());
    vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { observers.push(callback); } observe() {} unobserve() {} disconnect() {} });
    localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...seed(), view: null }));
    const stage = { w: 1200, h: 800 };
    stubStage(stage);
    render(<CanvasSurface />);
    const world = document.querySelector('.canvas-world') as HTMLElement;
    await waitFor(() => expect(world.style.transform).not.toBe('translate(0px, 0px) scale(1)'));
    expectBoxOnStage(world, { x: 900, y: 700, w: 260, h: 128 }, stage);
    const wide = world.style.transform;

    // The window shrinks: the graph is refitted to the smaller stage after the debounce.
    stage.w = 600; stage.h = 400;
    act(() => deliverResize());
    expect(world.style.transform).toBe(wide);
    await settle();
    expect(world.style.transform).not.toBe(wide);
    expectBoxOnStage(world, { x: 900, y: 700, w: 260, h: 128 }, stage);

    // A click on the background wobbles a pixel or two. That moves the camera but is not the operator
    // taking it, so the next stage change still refits.
    const viewport = document.querySelector('.canvas-viewport') as HTMLElement;
    const beforeClick = world.style.transform;
    fireEvent.pointerDown(viewport, { button: 0, pointerId: 7, clientX: 300, clientY: 200 });
    fireEvent.pointerMove(viewport, { pointerId: 7, clientX: 302, clientY: 201 });
    fireEvent.pointerUp(viewport, { pointerId: 7, clientX: 302, clientY: 201 });
    const jittered = world.style.transform;
    expect(jittered).not.toBe(beforeClick);
    stage.w = 800; stage.h = 500;
    act(() => deliverResize());
    await settle();
    expect(world.style.transform).not.toBe(jittered);
    expectBoxOnStage(world, { x: 900, y: 700, w: 260, h: 128 }, stage);

    // The operator zooms: from then on the camera is theirs and a resize leaves it alone...
    fireEvent.click(screen.getByRole('button', { name: '放大', exact: true }));
    const zoomed = world.style.transform;
    stage.w = 900; stage.h = 600;
    act(() => deliverResize());
    await settle();
    expect(world.style.transform).toBe(zoomed);
    // ...until they ask for the overview again, which hands the camera back to the fit.
    fireEvent.click(screen.getByRole('button', { name: '查看全部节点', exact: true }));
    const fittedAgain = world.style.transform;
    stage.w = 600; stage.h = 400;
    act(() => deliverResize());
    await settle();
    expect(world.style.transform).not.toBe(fittedAgain);
    expectBoxOnStage(world, { x: 900, y: 700, w: 260, h: 128 }, stage);

    // A real drag across the background takes the camera just as a zoom does.
    fireEvent.pointerDown(viewport, { button: 0, pointerId: 8, clientX: 300, clientY: 200 });
    fireEvent.pointerMove(viewport, { pointerId: 8, clientX: 360, clientY: 240 });
    fireEvent.pointerUp(viewport, { pointerId: 8, clientX: 360, clientY: 240 });
    const panned = world.style.transform;
    stage.w = 700; stage.h = 450;
    act(() => deliverResize());
    await settle();
    expect(world.style.transform).toBe(panned);

    // Open, with the camera the app opened the node with: a resize gives the node the new stage's room and keeps
    // it whole on it (owner request 2026-10-15: an opened node shows all of its content)...
    fireEvent.click(screen.getByRole('button', { name: '打开 LLM 会话', exact: true }));
    await waitFor(() => expect(screen.getByTestId('canvas-tile-s1').dataset.lod).toBe('focus'));
    await glideDone();
    const opened = world.style.transform;
    stage.w = 1000; stage.h = 700;
    act(() => deliverResize());
    await settle();
    await glideDone();
    expect(world.style.transform).not.toBe(opened);
    const tile = screen.getByTestId('canvas-tile-s1');
    expect([parseFloat(tile.style.width), parseFloat(tile.style.height)]).toEqual([1000 - 28 * 2, 700 - 24 - 82]);
    expectBoxOnStage(world, { x: 900, y: 700, w: parseFloat(tile.style.width), h: parseFloat(tile.style.height) }, stage);
    // ...but once the operator zooms the open node, the camera is theirs: a resize moves neither it nor the node.
    fireEvent.click(screen.getByRole('button', { name: '缩小', exact: true }));
    const zoomedOpen = world.style.transform;
    const zoomedFrame = [tile.style.width, tile.style.height];
    stage.w = 1100; stage.h = 760;
    act(() => deliverResize());
    await settle();
    await glideDone();
    expect(world.style.transform).toBe(zoomedOpen);
    expect([tile.style.width, tile.style.height]).toEqual(zoomedFrame);
  });
});

describe('CanvasSurface camera ownership', () => {
  it('hands the camera to the operator on a zoom that leaves its position where it was', async () => {
    // Every observer hears the resize, as the file's other tests do: an opened node observes its chat column too (useShortColumn).
    const observers: Array<() => void> = [];
    const deliverResize = () => observers.forEach(deliver => deliver());
    vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { observers.push(callback); } observe() {} unobserve() {} disconnect() {} });
    localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...seed(), view: null }));
    const stage = { w: 1200, h: 800 };
    stubStage(stage);
    render(<CanvasSurface />);
    const world = document.querySelector('.canvas-world') as HTMLElement;
    await waitFor(() => expect(world.style.transform).not.toBe('translate(0px, 0px) scale(1)'));
    const [x, y, scale] = transformOf(world);
    // A wheel tick anchored on the world origin changes only the scale: the translation stays put.
    fireEvent.wheel(document.querySelector('.canvas-viewport') as HTMLElement, { deltaY: -120, clientX: x, clientY: y });
    const [x2, y2, scale2] = transformOf(world);
    expect(scale2).toBeGreaterThan(scale);
    expect(Math.abs(x2 - x)).toBeLessThan(1);
    expect(Math.abs(y2 - y)).toBeLessThan(1);
    const zoomed = world.style.transform;
    stage.w = 700; stage.h = 500;
    act(() => deliverResize());
    await settle();
    expect(world.style.transform).toBe(zoomed);
  });
});

describe('CanvasSurface keeps a saved view only while it fits', () => {
  it('treats a saved view that still shows the whole graph as fitted, so a smaller stage refits it', async () => {
    // Every observer hears the resize, as the file's other tests do: an opened node observes its chat column too (useShortColumn).
    const observers: Array<() => void> = [];
    const deliverResize = () => observers.forEach(deliver => deliver());
    vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { observers.push(callback); } observe() {} unobserve() {} disconnect() {} });
    const saved = 'translate(-800px, -600px) scale(1)';
    localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...seed(), view: { x: -800, y: -600, scale: 1 } }));
    const stage = { w: 1200, h: 800 };
    stubStage(stage);
    render(<CanvasSurface />);
    const world = document.querySelector('.canvas-world') as HTMLElement;
    await settle();
    expect(world.style.transform).toBe(saved);
    stage.w = 300; stage.h = 200;
    act(() => deliverResize());
    await settle();
    expect(world.style.transform).not.toBe(saved);
    expectBoxOnStage(world, { x: 900, y: 700, w: 260, h: 128 }, stage);
  });
});

describe('CanvasSurface stage chrome', () => {
  it('shows the view tools only once the canvas has nodes', () => {
    localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify(emptyDocument()));
    const empty = render(<CanvasSurface />);
    expect(screen.queryByRole('toolbar', { name: '画布视图' })).toBeNull();
    expect(screen.queryByRole('button', { name: '放大', exact: true })).toBeNull();
    empty.unmount();
    localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify(seed()));
    render(<CanvasSurface />);
    expect(screen.getByRole('toolbar', { name: '画布视图' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '放大', exact: true })).toBeEnabled();
  });

  it('keeps the view tools, with an enabled Undo, after the last node is deleted', async () => {
    render(<CanvasSurface />);
    fireEvent.pointerDown(screen.getByTestId('canvas-tile-s1'), { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerUp(window, { clientX: 0, clientY: 0 });
    fireEvent.keyDown(window, { key: 'Delete' });
    await waitFor(() => expect(screen.queryByTestId('canvas-tile-s1')).toBeNull());
    const undo = within(screen.getByRole('toolbar', { name: '画布视图' })).getByRole('button', { name: '撤销', exact: true });
    expect(undo).toBeEnabled();
    fireEvent.click(undo);
    await waitFor(() => expect(screen.getByTestId('canvas-tile-s1')).toBeTruthy());
  });
});

describe('CanvasSurface opens a node where it is', () => {
  const stage = { w: 1600, h: 1000 };
  // A personal camera (zoomed out to 0.8 and panned). Only the root is measured here and the
  // ResizeObserver never delivers, so nothing refits: the saved camera is the one the canvas opens on.
  const personal = { x: 40, y: 30, scale: 0.8 };
  const open = async () => {
    fireEvent.click(screen.getByRole('button', { name: '打开 LLM 会话', exact: true }));
    await waitFor(() => expect(screen.getByTestId('canvas-tile-s1').dataset.lod).toBe('focus'));
    await glideDone();
  };
  // Through canvasStorage(), whatever account scope an earlier test left configured.
  beforeEach(() => {
    canvasStorage().setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...seed({ x: 200, y: 150 }), view: personal }));
    stubRootSize(stage.w, stage.h);
  });

  it('opens at 100 % zoom in the room its content can use, the card\'s corner kept where it sat as far as the stage allows', async () => {
    render(<CanvasSurface />);
    const world = document.querySelector('.canvas-world') as HTMLElement;
    expect(world.style.transform).toBe('translate(40px, 30px) scale(0.8)');
    await open();
    const [x, y, scale] = transformOf(world);
    expect(scale).toBe(1);
    // A conversation opens a readable column wide (1100) and the stage's height less its padding.
    const tile = screen.getByTestId('canvas-tile-s1');
    expect([parseFloat(tile.style.width), parseFloat(tile.style.height)]).toEqual([1100, stage.h - 24 - 82]);
    // The corner stays where it sat across, where the stage has the room, and moves up only as far as the node's height needs.
    expect(x + 200 * scale).toBeCloseTo(200, 3);
    expect(y + 150 * scale).toBeCloseTo(24, 3);
    expectBoxOnStage(world, { x: 200, y: 150, w: parseFloat(tile.style.width), h: parseFloat(tile.style.height) }, stage);
    expect(document.querySelector('.canvas-root')).toHaveAttribute('data-node-open', 'true');
  });

  it('keeps the card\'s corner exactly where it sat when the stage has room for the opened node', async () => {
    const tall = { w: 1600, h: 1400 };
    vi.restoreAllMocks();
    stubRootSize(tall.w, tall.h);
    render(<CanvasSurface />);
    const world = document.querySelector('.canvas-world') as HTMLElement;
    await open();
    const [x, y, scale] = transformOf(world);
    expect(scale).toBe(1);
    expect(x + 200 * scale).toBeCloseTo(200, 3);
    expect(y + 150 * scale).toBeCloseTo(150, 3);
    const tile = screen.getByTestId('canvas-tile-s1');
    // No taller than 1100, however tall the stage.
    expect([parseFloat(tile.style.width), parseFloat(tile.style.height)]).toEqual([1100, 1100]);
    expectBoxOnStage(world, { x: 200, y: 150, w: 1100, h: 1100 }, tall);
  });

  it('moves the camera only as far as the stage needs when the card sits near an edge', async () => {
    canvasStorage().setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...seed({ x: 1700, y: 1000 }), view: personal }));
    render(<CanvasSurface />);
    const world = document.querySelector('.canvas-world') as HTMLElement;
    await open();
    const tile = screen.getByTestId('canvas-tile-s1');
    const width = parseFloat(tile.style.width), height = parseFloat(tile.style.height);
    const [x, y, scale] = transformOf(world);
    // Pinned to the padded bottom-right corner (28 px sides, 82 px bottom), not centred.
    expect(x + (1700 + width) * scale).toBeCloseTo(stage.w - 28, 3);
    expect(y + (1000 + height) * scale).toBeCloseTo(stage.h - 82, 3);
  });

  it('glides back to the operator\'s camera when the node closes, by Escape or by its close button', async () => {
    render(<CanvasSurface />);
    const world = document.querySelector('.canvas-world') as HTMLElement;
    await open();
    expect(world.style.transform).not.toBe('translate(40px, 30px) scale(0.8)');
    fireEvent.keyDown(window, { key: 'Escape' });
    await glideDone();
    expect(world.style.transform).toBe('translate(40px, 30px) scale(0.8)');
    expect(document.querySelector('.canvas-root')).not.toHaveAttribute('data-node-open');
    await open();
    fireEvent.click(within(screen.getByTestId('canvas-tile-s1')).getByRole('button', { name: '收起节点' }));
    await glideDone();
    expect(world.style.transform).toBe('translate(40px, 30px) scale(0.8)');
  });

  it('still returns to the operator\'s camera when the node is reopened during the glide back', async () => {
    render(<CanvasSurface />);
    const world = document.querySelector('.canvas-world') as HTMLElement;
    await open();
    fireEvent.keyDown(window, { key: 'Escape' });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 60)); });
    fireEvent.click(screen.getByRole('button', { name: '打开 LLM 会话', exact: true }));
    await glideDone();
    fireEvent.keyDown(window, { key: 'Escape' });
    await glideDone();
    expect(world.style.transform).toBe('translate(40px, 30px) scale(0.8)');
  });

  it('returns to the operator\'s camera when the open node is deleted', async () => {
    render(<CanvasSurface />);
    const world = document.querySelector('.canvas-world') as HTMLElement;
    await open();
    const tile = within(screen.getByTestId('canvas-tile-s1'));
    fireEvent.click(tile.getByRole('button', { name: '更多节点操作' }));
    fireEvent.click(tile.getByRole('button', { name: '删除', exact: true }));
    await glideDone();
    expect(screen.queryByTestId('canvas-tile-s1')).toBeNull();
    expect(world.style.transform).toBe('translate(40px, 30px) scale(0.8)');
  });

  it('closes a node whose addition is undone, back to the camera from before it was added', async () => {
    render(<CanvasSurface />);
    const world = document.querySelector('.canvas-world') as HTMLElement;
    const before = world.style.transform;
    fireEvent.doubleClick(document.querySelector('.canvas-viewport') as HTMLElement, { clientX: 700, clientY: 500 });
    await waitFor(() => expect(document.querySelector('.canvas-root')).toHaveAttribute('data-node-open', 'true'));
    await glideDone();
    expect(world.style.transform).not.toBe(before);
    fireEvent.click(screen.getByRole('button', { name: '撤销', exact: true }));
    await glideDone();
    expect(document.querySelectorAll('.canvas-tile')).toHaveLength(1);
    expect(document.querySelector('.canvas-root')).not.toHaveAttribute('data-node-open');
    expect(document.querySelector('.canvas-tile--focus')).toBeNull();
    expect(world.style.transform).toBe(before);
    // With nothing open, the camera is saved again where the operator takes it.
    fireEvent.click(screen.getByRole('button', { name: '放大', exact: true }));
    const zoomed = transformOf(world);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 600)); });
    const saved = JSON.parse(canvasStorage().getItem(CANVAS_STORAGE_KEY)!) as CanvasDocument;
    expect([saved.view!.x, saved.view!.y, saved.view!.scale]).toEqual(zoomed);
  });

  it('leaves the camera where Fit All put it when a review partner is added afterwards', async () => {
    const output = { id: 'result', label: '结果', type: 'markdown' as const, required: true, value: '' };
    canvasStorage().setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...seed({ x: 200, y: 150, contract: { version: 1, inputs: [], outputs: [output] } }), view: personal }));
    render(<CanvasSurface />);
    const world = document.querySelector('.canvas-world') as HTMLElement;
    await open();
    fireEvent.click(screen.getByRole('button', { name: '查看全部节点', exact: true }));
    const fitted = world.style.transform;
    expect(fitted).not.toBe('translate(40px, 30px) scale(0.8)');
    fireEvent.click(screen.getByRole('button', { name: '协作设置' }));
    fireEvent.click(screen.getByRole('button', { name: '添加互审搭档' }));
    await glideDone();
    expect(document.querySelectorAll('.canvas-tile')).toHaveLength(2);
    expect(world.style.transform).toBe(fitted);
  });

  it('saves the operator\'s camera, not the open node\'s, so leaving from an open node reopens where they were', async () => {
    render(<CanvasSurface />);
    const world = document.querySelector('.canvas-world') as HTMLElement;
    // The operator's own camera first, so the save has something new to record.
    fireEvent.click(screen.getByRole('button', { name: '放大', exact: true }));
    const mine = transformOf(world);
    expect(mine).not.toEqual([personal.x, personal.y, personal.scale]);
    await open();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 600)); });
    const saved = JSON.parse(canvasStorage().getItem(CANVAS_STORAGE_KEY)!) as CanvasDocument;
    expect([saved.view!.x, saved.view!.y, saved.view!.scale]).toEqual(mine);
  });
});

// Last on purpose: the cloud canvas scopes the storage namespace for the rest of the process,
// so every local-mode test in this file has to run before it.
describe('CanvasSurface fits the real stage (cloud rails)', () => {
  const renderCloud = () => {
    const tenant = { id: 'workspace', name: 'Workspace', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 100 };
    configureCanvasStorage('user', tenant.id, 'canvas');
    configureSaaSCanvas({ tenant, canvasId: 'canvas' });
    canvasStorage().setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...seed(), view: null }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [] }))));
    return render(<CanvasSurface storageMode="cloud" runtimeReadJson={async () => ({ agents: [], models: [] })} />);
  };

  it('refits an app-fitted overview when a side rail toggles, but never an operator camera or a focused node', async () => {
    // Only the operator's camera is saved: the app's fits (on open, after a rail toggles) are not.
    const savedCamera = async () => {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 450)); });
      const view = (JSON.parse(canvasStorage().getItem(CANVAS_STORAGE_KEY)!) as CanvasDocument).view;
      return view ? [view.x, view.y, view.scale] : null;
    };
    const stage = { w: 1200, h: 800 };
    stubStage(stage);
    localStorage.setItem(RAIL_BOT_KEY, '1');
    renderCloud();
    const world = document.querySelector('.canvas-world') as HTMLElement;
    const node = { x: 900, y: 700, w: 260, h: 128 };
    await waitFor(() => expect(world.style.transform).not.toBe('translate(0px, 0px) scale(1)'));
    const overview = world.style.transform;

    // The camera is still the app's fit: the Bot rail opens and narrows the stage, so it refits.
    stage.w = 900;
    fireEvent.click(screen.getByRole('button', { name: '展开 Bot 清单' }));
    await settle();
    expect(world.style.transform).not.toBe(overview);
    expectBoxOnStage(world, node, stage);
    expect(await savedCamera()).toBeNull();

    // The operator zooms: the camera is theirs, and neither rail moves it.
    fireEvent.click(screen.getByRole('button', { name: '放大', exact: true }));
    const zoomed = world.style.transform;
    expect(await savedCamera()).toEqual(transformOf(world));
    stage.w = 1200;
    fireEvent.click(screen.getByRole('button', { name: '展开模型' }));
    await settle();
    expect(world.style.transform).toBe(zoomed);
    fireEvent.click(screen.getByRole('button', { name: '收起 Bot 清单' }));
    await settle();
    expect(world.style.transform).toBe(zoomed);

    // View all hands the camera back to the fit, and the next rail toggle refits again.
    fireEvent.click(screen.getByRole('button', { name: '查看全部节点', exact: true }));
    const refitted = world.style.transform;
    const requested = transformOf(world);
    // A requested fit is the operator's camera and is saved; the refit after the next rail toggle is not.
    expect(await savedCamera()).toEqual(requested);
    stage.w = 800;
    fireEvent.click(screen.getByRole('button', { name: '收起模型' }));
    await settle();
    expect(world.style.transform).not.toBe(refitted);
    expectBoxOnStage(world, node, stage);
    expect(await savedCamera()).toEqual(requested);

    // Focused: a rail toggle leaves the camera where the operator put it.
    fireEvent.click(screen.getByRole('button', { name: '打开 LLM 会话', exact: true }));
    await waitFor(() => expect(screen.getByTestId('canvas-tile-s1').dataset.lod).toBe('focus'));
    await glideDone();
    const focused = world.style.transform;
    fireEvent.click(screen.getByRole('button', { name: '展开 Bot 清单' }));
    await settle();
    expect(world.style.transform).toBe(focused);
  });

  it('opens the narrow-stage model drawer on the full shelf whatever the desktop rail stored', () => {
    const width = window.innerWidth;
    localStorage.setItem(RAIL_MODEL_KEY, '1');
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 });
    try {
      renderCloud();
      const shelf = () => screen.getByRole('complementary', { name: '执行与编排模型' });
      expect(shelf()).not.toHaveClass('is-collapsed');
      // Widening back to a desktop stage restores the rail state the operator chose there.
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
      act(() => { window.dispatchEvent(new Event('resize')); });
      expect(shelf()).toHaveClass('is-collapsed');
      expect(localStorage.getItem(RAIL_MODEL_KEY)).toBe('1');
    } finally { Object.defineProperty(window, 'innerWidth', { configurable: true, value: width }); }
  });
});

describe('CanvasSurface keeps an opened node clear of a sidebar floating over the stage', () => {
  // The hosted workspace (with its model library) lays the assistant's sidebar over the board's left edge: the stage
  // still spans the window, and the part under the sidebar cannot be seen. Seen on production 2026-10-15: an opened
  // node was fitted to the whole stage, so its left third (its task card's first words) sat under the sidebar. Here the
  // part right of the sidebar (1000 px) is narrower than a conversation's frame (1100 px) needs.
  const stage = { w: 1400, h: 1000 };
  const SIDEBAR = 400;
  // What the stage and the sidebar measure in the current case (the cases below the first three set their own).
  // `viewportLate`: the viewport measures nothing until a ResizeObserver delivery (its first size comes late). `tools`:
  // the view tools' width (their row is the stage's bottom 16-56 px; the minimap's 200 x 130 box sits at its bottom right).
  let layout = { ...stage, sidebar: SIDEBAR, stageLeft: 0, sidebarLeft: 0, viewportLate: false, tools: 200 };
  const box = (left: number, w: number, h: number) => ({ x: left, y: 0, top: 0, left, right: left + w, bottom: h, width: w, height: h, toJSON: () => ({}) } as DOMRect);
  beforeEach(() => {
    layout = { ...stage, sidebar: SIDEBAR, stageLeft: 0, sidebarLeft: 0, viewportLate: false, tools: 200 };
    canvasStorage().setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...seed({ x: 60, y: 150 }), view: { x: 0, y: 0, scale: 1 } }));
    const real = Element.prototype.getBoundingClientRect;
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      if (this.classList.contains('canvas-viewport') && layout.viewportLate) return box(0, 0, 0);
      if (this.classList.contains('canvas-root') || this.classList.contains('canvas-viewport')) return box(layout.stageLeft, layout.w, layout.h);
      // A sidebar stepped aside (hidden, display: none) lays out nothing, as in a browser.
      if (this.classList.contains('awwo-planner-sidebar')) return (this as HTMLElement).hidden ? box(0, 0, 0) : box(layout.sidebarLeft, layout.sidebar, layout.h);
      // The view tools' row: the stage's bottom 16-56 px, raised by the margin-bottom the app may set.
      if (this.classList.contains('awwo-view-tools')) {
        const up = Number.parseFloat((this as HTMLElement).style.marginBottom) || 0;
        return { ...box(layout.stageLeft + 16, layout.tools, layout.h - 16 - up), top: layout.h - 56 - up, y: layout.h - 56 - up, height: 40 };
      }
      if (this.classList.contains('canvas-minimap')) return { ...box(layout.stageLeft + layout.w - 220, 200, layout.h - 20), top: layout.h - 150, y: layout.h - 150, height: 130 };
      return real.call(this);
    });
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('awwo-view-tools')) return layout.tools;
      return this.classList.contains('awwo-planner-sidebar') && !this.hidden ? layout.sidebar : 0;
    });
    // The view tools' 16 px margin, plus the margin the app sets to move them, as a browser lays them out.
    vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('awwo-view-tools') ? 16 + (Number.parseFloat(this.style.marginLeft) || 0) : 0;
    });
  });
  const addSidebar = () => {
    const side = document.createElement('aside');
    side.className = 'awwo-planner-sidebar';
    document.querySelector('.awwo-workspace')!.appendChild(side);
  };
  const narrowLayout = () => document.querySelector('.canvas-root')!.getAttribute('data-narrow-focus') === 'true';
  /** Where the node's card, or its open frame, sits on the stage. */
  const measure = () => {
    const tile = screen.getByTestId('canvas-tile-s1');
    const [x, , scale] = transformOf(document.querySelector('.canvas-world') as HTMLElement);
    const left = parseFloat(tile.style.left), width = parseFloat(tile.style.width);
    return { left: x + left * scale, right: x + (left + width) * scale, width };
  };
  const openNode = async () => {
    fireEvent.click(screen.getByRole('button', { name: '打开 LLM 会话', exact: true }));
    await waitFor(() => expect(screen.getByTestId('canvas-tile-s1').dataset.lod).toBe('focus'));
    await glideDone();
    return measure();
  };

  it('opens a node in the stage right of the sidebar, its frame sized to that part', async () => {
    render(<CanvasSurface />);
    addSidebar();
    const opened = await openNode();
    expect(opened.width).toBeLessThanOrEqual(stage.w - SIDEBAR - 56);
    expect(opened.left).toBeGreaterThanOrEqual(SIDEBAR + 28 - 1e-6);
    expect(opened.right).toBeLessThanOrEqual(stage.w - 28 + 1e-6);
  });

  it('opens it where it sat when no sidebar covers the stage', async () => {
    render(<CanvasSurface />);
    const opened = await openNode();
    // The corner keeps its place on screen (60 px from the stage's edge), as the stage has the room.
    expect(opened.left).toBeCloseTo(60, 3);
  });

  it('ignores a sidebar that spans the stage (a phone), which is closed to see the board', async () => {
    layout.sidebar = stage.w;
    render(<CanvasSurface />);
    addSidebar();
    const opened = await openNode();
    expect(opened.left).toBeCloseTo(60, 3);
  });

  it('does not count a sidebar that takes its own room beside the stage (a wide screen)', async () => {
    layout.stageLeft = SIDEBAR;
    render(<CanvasSurface />);
    addSidebar();
    const opened = await openNode();
    expect(opened.left).toBeCloseTo(60, 3);
  });

  it('measures the sidebar where it lands, not where its entrance slide has it now', async () => {
    // Mid-slide (translate: -14px 0 → none) the sidebar is drawn 14 px left of where it lays out.
    layout.sidebarLeft = -14;
    const real = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation((element: Element, pseudo?: string | null) => {
      const style = real(element, pseudo);
      if (!element.classList?.contains('awwo-planner-sidebar')) return style;
      return new Proxy(style, { get: (target, key) => {
        if (key === 'translate') return '-14px';
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
    });
    render(<CanvasSurface />);
    addSidebar();
    const opened = await openNode();
    expect(opened.left).toBeGreaterThanOrEqual(SIDEBAR + 28 - 1e-6);
    expect(opened.width).toBeLessThanOrEqual(stage.w - SIDEBAR - 56);
  });

  it('moves the view tools right of a sidebar floating over the stage, where they fit beside it', async () => {
    // The zoom and fit buttons sit in the stage's bottom-left corner, under the sidebar while the assistant was open
    // (found 2026-10-16 at 1244 px): they move right of it as far as it covers, while they fit there.
    const tools = () => document.querySelector<HTMLElement>('.awwo-view-tools')!;
    const toggle = () => fireEvent.click(screen.getByRole('button', { name: '画布助手', exact: true }));
    for (const [sidebar, shift] of [[SIDEBAR, `${SIDEBAR}px`], [stage.w - 100, '']] as const) {
      layout = { ...layout, sidebar };
      const view = render(<CanvasSurface />);
      expect(tools().style.marginLeft).toBe('');
      toggle();
      await waitFor(() => expect(document.querySelector('.awwo-planner-sidebar')).not.toBeNull());
      await settle();
      expect(tools().style.marginLeft, `a ${sidebar} px sidebar`).toBe(shift);
      toggle();
      await waitFor(() => expect(document.querySelector('.awwo-planner-sidebar')).toBeNull());
      await settle();
      expect(tools().style.marginLeft).toBe('');
      view.unmount();
    }
    // Beside the stage (a wide screen), the sidebar covers nothing.
    layout = { ...layout, sidebar: SIDEBAR, stageLeft: SIDEBAR };
    const wide = render(<CanvasSurface />);
    toggle();
    await waitFor(() => expect(document.querySelector('.awwo-planner-sidebar')).not.toBeNull());
    await settle();
    expect(tools().style.marginLeft).toBe('');
    wide.unmount();
    // Reaching the minimap in their row they step up over it (in review: at 880 px it covered undo and redo; in a
    // browser the developer row did not fit beside it and stayed covered), and they are measured again when a
    // selection adds 运行所选及下游 (here as if it made the row 440 px wide).
    layout = { ...layout, w: 800, stageLeft: 0 };
    render(<CanvasSurface />);
    toggle();
    await waitFor(() => expect(document.querySelector('.awwo-planner-sidebar')).not.toBeNull());
    await settle();
    expect(screen.getByTestId('canvas-minimap')).toBeTruthy();
    expect([tools().style.marginLeft, tools().style.marginBottom], 'reaching the minimap: 416 + 200 + 16 > 580').toEqual([`${SIDEBAR}px`, '150px']);
    fireEvent.click(screen.getByRole('button', { name: '显示小地图' }));
    await waitFor(() => expect(screen.queryByTestId('canvas-minimap')).toBeNull());
    expect([tools().style.marginLeft, tools().style.marginBottom], 'without it').toEqual([`${SIDEBAR}px`, '']);
    layout.tools = 440;
    fireEvent.pointerDown(screen.getByTestId('canvas-tile-s1'), { button: 0, clientX: 0, clientY: 0 });
    await waitFor(() => expect(within(tools()).getByRole('button', { name: '运行所选及下游' })).toBeTruthy());
    expect([tools().style.marginLeft, tools().style.marginBottom], 'grown past the stage').toEqual(['', '']);
  });

  it('steps the view tools over the minimap only while it is drawn', async () => {
    // An open node hides the minimap (visibility: hidden, canvas.css, modelled here), and deleting the last node
    // unmounts it while undo keeps the tools: neither counts then, and undo bringing it back is measured again (found
    // in review). Moved 400 px right the tools reach the minimap's 580 px, so they step up over it. An earlier
    // assistant task keeps the assistant's panel open with no node left.
    canvasStorage().setItem(PLANNING_STORAGE_KEY, JSON.stringify({ draft: '', messages: [{ id: 'm1', role: 'user', content: '做个页面', taskId: 'task-1' }] }));
    const real = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation((element: Element, pseudo?: string | null) => {
      const style = real(element, pseudo);
      if (!element.classList?.contains('canvas-minimap') || !element.closest('.canvas-root[data-node-open]')) return style;
      return new Proxy(style, { get: (target, key) => {
        if (key === 'visibility') return 'hidden';
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
    });
    layout = { ...layout, w: 800 };
    render(<CanvasSurface />);
    const tools = () => document.querySelector<HTMLElement>('.awwo-view-tools')!;
    fireEvent.click(screen.getByRole('button', { name: '画布助手', exact: true }));
    await waitFor(() => expect(document.querySelector('.awwo-planner-sidebar')).not.toBeNull());
    await settle();
    const placed = () => [tools().style.marginLeft, tools().style.marginBottom];
    expect(placed(), 'over the minimap').toEqual([`${SIDEBAR}px`, '150px']);
    await openNode();
    expect(document.querySelector('.canvas-root')).toHaveAttribute('data-node-open');
    expect(placed(), 'the minimap hidden under an open node').toEqual([`${SIDEBAR}px`, '']);
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.getByTestId('canvas-tile-s1').dataset.lod).not.toBe('focus'));
    await glideDone();
    expect(placed(), 'the node closed').toEqual([`${SIDEBAR}px`, '150px']);
    const tile = within(screen.getByTestId('canvas-tile-s1'));
    fireEvent.click(tile.getByRole('button', { name: '更多节点操作' }));
    fireEvent.click(tile.getByRole('button', { name: '删除', exact: true }));
    await waitFor(() => expect(screen.queryByTestId('canvas-tile-s1')).toBeNull());
    expect(screen.queryByTestId('canvas-minimap')).toBeNull();
    expect(placed(), 'the last node deleted').toEqual([`${SIDEBAR}px`, '']);
    fireEvent.click(within(tools()).getByRole('button', { name: '撤销' }));
    await waitFor(() => expect(screen.getByTestId('canvas-minimap')).toBeTruthy());
    expect(placed(), 'undone').toEqual([`${SIDEBAR}px`, '150px']);
  });

  it('keeps the view tools in their corner while Configure lifts the board over the sidebar', async () => {
    // At 900 px and below Configure raises the board above the sidebar, which then covers nothing; moved right, the
    // tools sat under the inspector (found in review).
    const deliveries: Array<() => void> = [];
    vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { deliveries.push(callback); } observe() {} unobserve() {} disconnect() {} });
    await renderHosted(880, 340, true);
    // The sidebar comes after the first measurement: a stage resize measures the tools again.
    layout.w = 878;
    act(() => { deliveries.forEach(deliver => deliver()); });
    await settle();
    const tools = () => document.querySelector<HTMLElement>('.awwo-view-tools')!;
    expect(tools().style.marginLeft).toBe('340px');
    await configure();
    expect(tools().style.marginLeft, 'with Configure open').toBe('');
    fireEvent.click(screen.getByRole('button', { name: '关闭配置' }));
    await waitFor(() => expect(document.querySelector('.canvas-root > .canvas-inspector')).toBeNull());
    expect(tools().style.marginLeft, 'Configure closed').toBe('340px');
  });

  it('hands the stylesheets the part of the stage a floating sidebar covers, where it leaves a readable part', async () => {
    // The run notes in the stage's top-left corner, the selection bar at its top centre and the 成果 view are laid out
    // right of --awwo-stage-cover (canvas-stage-cover.test.ts reads those rules): they sat under the sidebar (found
    // 2026-10-16). None where the sidebar takes its own room beside the stage, leaves it less than 200 px (here below
    // the 266 px an open node needs: a note still reads there, found in review), or is closed.
    const cover = () => document.querySelector<HTMLElement>('.awwo-stage-canvas')!.style.getPropertyValue('--awwo-stage-cover');
    const toggle = () => fireEvent.click(screen.getByRole('button', { name: '画布助手', exact: true }));
    const cases = [[stage.w, 0, `${SIDEBAR}px`], [SIDEBAR + 200, 0, `${SIDEBAR}px`], [SIDEBAR + 199, 0, ''], [stage.w, SIDEBAR, '']] as const;
    for (const [w, stageLeft, want] of cases) {
      layout = { ...layout, w, stageLeft };
      const view = render(<CanvasSurface />);
      expect(cover(), 'the assistant closed').toBe('');
      toggle();
      await waitFor(() => expect(document.querySelector('.awwo-planner-sidebar')).not.toBeNull());
      await settle();
      expect(cover(), `a ${SIDEBAR} px sidebar on a ${w} px stage from ${stageLeft} px`).toBe(want);
      toggle();
      await waitFor(() => expect(document.querySelector('.awwo-planner-sidebar')).toBeNull());
      await settle();
      expect(cover(), 'closed again').toBe('');
      view.unmount();
    }
  });

  it('measures the cover again when the stage changes size under an open sidebar', async () => {
    // A window resized with the assistant open: the stage narrows past the 200 px left beside the sidebar, and back.
    const deliveries: Array<() => void> = [];
    vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { deliveries.push(callback); } observe() {} unobserve() {} disconnect() {} });
    const cover = () => document.querySelector<HTMLElement>('.awwo-stage-canvas')!.style.getPropertyValue('--awwo-stage-cover');
    render(<CanvasSurface />);
    fireEvent.click(screen.getByRole('button', { name: '画布助手', exact: true }));
    await waitFor(() => expect(document.querySelector('.awwo-planner-sidebar')).not.toBeNull());
    await settle();
    expect(cover(), 'a 1400 px stage').toBe(`${SIDEBAR}px`);
    for (const [w, want] of [[SIDEBAR + 199, ''], [stage.w, `${SIDEBAR}px`]] as const) {
      layout.w = w;
      act(() => { deliveries.forEach(deliver => deliver()); });
      await settle();
      expect(cover(), `resized to ${w} px`).toBe(want);
    }
  });

  it('moves an open node clear of the sidebar when the assistant opens, and gives it the stage back when it closes', async () => {
    render(<CanvasSurface />);
    const alone = await openNode();
    expect(alone.left).toBeCloseTo(60, 3);
    const toggle = () => fireEvent.click(screen.getByRole('button', { name: '画布助手', exact: true }));
    toggle();
    await waitFor(() => expect(document.querySelector('.awwo-planner-sidebar')).not.toBeNull());
    await settle();
    await glideDone();
    const beside = measure();
    expect(beside.width).toBeLessThanOrEqual(stage.w - SIDEBAR - 56);
    expect(beside.left).toBeGreaterThanOrEqual(SIDEBAR + 28 - 1e-6);
    expect(beside.right).toBeLessThanOrEqual(stage.w - 28 + 1e-6);
    toggle();
    await waitFor(() => expect(document.querySelector('.awwo-planner-sidebar')).toBeNull());
    await settle();
    await glideDone();
    expect(measure().width).toBeCloseTo(alone.width, 3);
  });

  it('refits the overview in the stage right of the sidebar when the assistant opens over it', async () => {
    render(<CanvasSurface />);
    const world = document.querySelector('.canvas-world') as HTMLElement;
    const centre = () => {
      const [, , scale] = transformOf(world);
      const card = measure();
      return { x: (card.left + card.right) / 2, scale };
    };
    fireEvent.click(screen.getByRole('button', { name: '查看全部节点', exact: true }));
    await glideDone();
    const alone = centre();
    fireEvent.click(screen.getByRole('button', { name: '画布助手', exact: true }));
    await waitFor(() => expect(document.querySelector('.awwo-planner-sidebar')).not.toBeNull());
    await settle();
    await glideDone();
    // The graph is centred in the part right of the sidebar: half the sidebar further right, at the same zoom.
    const beside = centre();
    expect(beside.scale).toBeCloseTo(alone.scale, 6);
    expect(beside.x - alone.x).toBeCloseTo(SIDEBAR / 2, 0);
  });

  it('keeps a saved camera on opening only if the part right of the sidebar shows the whole graph', async () => {
    // Simple mode opens the assistant with the canvas, so no panel toggle refits after the first fit (in review: a
    // 1232 px stage, a 398 px sidebar and a camera saved with the card at x 60 opened with the card under the sidebar).
    layout = { ...layout, w: 1232, h: 900, sidebar: 398 };
    render(<CanvasUiModeProvider mode="simple"><CanvasSurface /></CanvasUiModeProvider>);
    await waitFor(() => expect(document.querySelector('.awwo-planner-sidebar')).not.toBeNull());
    await settle();
    const card = measure();
    expect(card.left).toBeGreaterThanOrEqual(398 - 1e-6);
    expect(card.right).toBeLessThanOrEqual(1232 + 1e-6);
  });

  // Closing a node glides back to the overview (260 ms); the refit 150 ms after the panel opens must not take a camera on
  // the way for the operator's. On a fake clock from Fit All on (every save debounce on it too): no render runs inside
  // one advance, as when a timer runs between a frame and the render showing it; `stepped` renders frame by frame, as a
  // browser does, so every camera on the way waits to be saved in turn. `saveFirst`: Fit All's camera is saved (its
  // 400 ms debounce) before the node opens; without it, the open node's frames keep restarting that debounce.
  // `fitAll: false`: a canvas with no saved camera, on the app's own fit (never saved) instead of a requested one.
  const closeThenOpenAssistant = async (openAfter: number, { stepped = false, saveFirst = true, fitAll = true } = {}) => {
    const savedView = () => (JSON.parse(canvasStorage().getItem(CANVAS_STORAGE_KEY)!) as CanvasDocument).view;
    if (!fitAll) canvasStorage().setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...seed({ x: 60, y: 150 }), view: null }));
    render(<CanvasSurface />);
    await settle();
    const before = savedView();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'] });
    let alone: ReturnType<typeof measure>;
    let fitted: [number, number, number];
    try {
      const advance = (ms: number, frames = stepped) => {
        if (!frames) { act(() => { vi.advanceTimersByTime(ms); }); return; }
        for (let elapsed = 0; elapsed < ms; elapsed += 16) act(() => { vi.advanceTimersByTime(16); });
      };
      // A requested fit is the operator's camera.
      if (fitAll) fireEvent.click(screen.getByRole('button', { name: '查看全部节点', exact: true }));
      fitted = transformOf(document.querySelector('.canvas-world') as HTMLElement);
      alone = measure();
      advance(saveFirst ? 500 : 100);
      fireEvent.click(screen.getByRole('button', { name: '打开 LLM 会话', exact: true }));
      advance(400, true);
      expect(screen.getByTestId('canvas-tile-s1').dataset.lod).toBe('focus');
      fireEvent.keyDown(window, { key: 'Escape' });
      advance(openAfter);
      fireEvent.click(screen.getByRole('button', { name: '画布助手', exact: true }));
      expect(document.querySelector('.awwo-planner-sidebar')).not.toBeNull();
      advance(600);
      // Past every save debounce.
      act(() => { vi.advanceTimersByTime(1000); });
    } finally {
      vi.useRealTimers();
    }
    await glideDone();
    const beside = measure();
    expect(beside.width).toBeCloseTo(alone.width, 3);
    // Recentred in the part right of the sidebar: half the sidebar further right.
    expect((beside.left + beside.right) / 2 - (alone.left + alone.right) / 2).toBeCloseTo(SIDEBAR / 2, 0);
    const saved = savedView();
    return { before, fitted, saved: saved ? [saved.x, saved.y, saved.scale] : null };
  };
  const expectSaved = (saved: number[] | null, fitted: number[]) => {
    expect(saved).not.toBeNull();
    saved!.forEach((value, i) => expect(value).toBeCloseTo(fitted[i], 6));
  };

  it('refits the overview right of the sidebar when the assistant opens while closing a node glides back to it', async () => {
    // The refit runs at 150 ms, mid-glide: it judges where the glide lands, not the frame it passes.
    await closeThenOpenAssistant(0);
  });

  it('refits it too when the refit runs after the glide landed but before the render showing that', async () => {
    // The refit runs at 350 ms, after the last frame (≤ 276 ms) cleared the glide's target, in the same advance.
    await closeThenOpenAssistant(200);
  });

  it('keeps the operator’s saved camera when that refit takes over the glide back to it', async () => {
    // The refit's flush of the operator's waiting camera saved the frame it took over at as theirs (found in review).
    const { fitted, saved } = await closeThenOpenAssistant(48, { stepped: true });
    expectSaved(saved, fitted);
  });

  it('saves the operator’s camera the glide returns to when its own save was still waiting', async () => {
    // The node opened within Fit All's 400 ms debounce and closed again: the frames on the way replaced its waiting
    // save, and dropping the frame the refit took over at lost it (found in review: the canvas kept its older camera).
    const { before, fitted, saved } = await closeThenOpenAssistant(48, { stepped: true, saveFirst: false });
    expect(before).not.toEqual({ x: fitted[0], y: fitted[1], scale: fitted[2] });
    expectSaved(saved, fitted);
  });

  it('saves it as well when the refit runs between the glide’s last frame and the render showing it', async () => {
    // There the glide's target is gone and the rendered frame waiting to be saved is one on the way (found in review).
    const { fitted, saved } = await closeThenOpenAssistant(200, { saveFirst: false });
    expectSaved(saved, fitted);
  });

  it('saves the open node’s return camera, not its own, when the first fit runs while it is open', async () => {
    // The viewport's first size can come only after a node opened: the first fit then flushes the waiting save, which
    // is the operator's camera the node returns to, not the open node's camera (found in review). Read before that
    // save's own debounce would write it again.
    const deliveries: Array<() => void> = [];
    vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { deliveries.push(callback); } observe() {} unobserve() {} disconnect() {} });
    layout.viewportLate = true;
    const returnTo = { x: -5000, y: 0, scale: 1 };
    canvasStorage().setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...seed({ x: 60, y: 150 }), view: returnTo }));
    render(<CanvasSurface />);
    await openNode();
    layout.viewportLate = false;
    act(() => { deliveries.forEach(deliver => deliver()); });
    const saved = (JSON.parse(canvasStorage().getItem(CANVAS_STORAGE_KEY)!) as CanvasDocument).view;
    expect(saved).toEqual(returnTo);
  });

  it('does not save the app’s own camera the glide returns to', async () => {
    // A canvas with no saved camera opens on the app's fit, a fit to this screen and not the operator's: the refit's
    // flush must not save it as theirs either.
    const { before, saved } = await closeThenOpenAssistant(48, { stepped: true, fitAll: false });
    expect(before ?? null).toBeNull();
    expect(saved).toBeNull();
  });

  /** The hosted app on a `w` px stage with a `sidebar` px sidebar; `narrowScreen`: at 900 px and below, where
   *  Configure raises the board above the sidebar. */
  const renderHosted = async (w: number, sidebar: number, narrowScreen: boolean) => {
    layout = { ...layout, w, h: 900, sidebar };
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: narrowScreen && query.includes('max-width: 900px'), media: query, onchange: null,
      addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
    }));
    const tenant = { id: 'workspace', name: 'Workspace', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 100 };
    configureCanvasStorage('user', tenant.id, 'canvas');
    configureSaaSCanvas({ tenant, canvasId: 'canvas' });
    canvasStorage().setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...seed({ x: 60, y: 150 }), view: { x: 0, y: 0, scale: 1 } }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [] }))));
    render(<div className="saas-canvas-shell"><CanvasSurface storageMode="cloud" runtimeReadJson={async () => ({ agents: [], models: [] })} /></div>);
    await screen.findByTestId('canvas-tile-s1');
    addSidebar();
  };
  const configure = async () => {
    const tile = within(screen.getByTestId('canvas-tile-s1'));
    fireEvent.click(tile.getByRole('button', { name: '更多节点操作' }));
    fireEvent.click(tile.getByRole('button', { name: '配置', exact: true }));
    await waitFor(() => expect(screen.getByTestId('canvas-tile-s1').dataset.lod).toBe('focus'));
    await glideDone();
    expect(document.querySelector('.canvas-root > .canvas-inspector')).not.toBeNull();
  };

  it('counts no sidebar while Configure raises the board above it (the hosted app at 900 px and below)', async () => {
    // There Configure lifts the whole board over the sidebar (awwo-workspace.css): a node opened to be configured keeps
    // clear of the inspector as without a sidebar (in review, an 880 px stage and a 340 px sidebar put 223 px of it
    // under the inspector), and takes the room right of the sidebar again once Configure closes.
    await renderHosted(880, 340, true);
    await configure();
    // 12 px inset + 360 px inspector + 16 px clear space on the right.
    const configured = measure();
    expect(configured.left).toBeGreaterThanOrEqual(28 - 1e-6);
    expect(configured.right).toBeLessThanOrEqual(880 - 388 + 1e-6);
    fireEvent.click(screen.getByRole('button', { name: '关闭配置' }));
    await waitFor(() => expect(document.querySelector('.canvas-root > .canvas-inspector')).toBeNull());
    await settle();
    await glideDone();
    expect(measure().left).toBeGreaterThanOrEqual(340 + 28 - 1e-6);
  });

  it('fits the board as it is once Configure closes, when 查看全部节点 or 整理布局 closes it', async () => {
    // Both close Configure in the handler that fits, while it still reads as open: the fit is for the board without it,
    // the sidebar over its left edge again (in review: the overview fitted the whole stage, a card's left 36 px under
    // the sidebar).
    await renderHosted(880, 340, true);
    for (const control of ['查看全部节点', '整理布局']) {
      await configure();
      fireEvent.click(screen.getByRole('button', { name: control, exact: true }));
      await waitFor(() => expect(document.querySelector('.canvas-root > .canvas-inspector')).toBeNull());
      await glideDone();
      const card = measure();
      expect(card.left, control).toBeGreaterThanOrEqual(340 - 1e-6);
      expect(card.right, control).toBeLessThanOrEqual(880 + 1e-6);
    }
  });

  it('configures a node clear of the inspector where the part right of the sidebar has no readable room for both', async () => {
    // A 1028 px hosted stage (a 1200 px window, both rails collapsed) and a 340 px sidebar leave 688 px: beside the
    // 388 px the inspector needs, a node would drop below the readable scale, and keeping it readable there put 102 px
    // of it under the inspector (found in review). It opens as without the sidebar, clear of the panel in use.
    await renderHosted(1028, 340, false);
    await configure();
    expect(measure().right).toBeLessThanOrEqual(1028 - 388 + 1e-6);
  });

  it('fits no overview over a node opened before the stage’s first size arrived', async () => {
    // The first fit would judge the saved camera, see the card under the sidebar and fit the overview over the open
    // node, its expanded frame then running off the stage (found in review). The open node keeps its camera.
    const deliveries: Array<() => void> = [];
    vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { deliveries.push(callback); } observe() {} unobserve() {} disconnect() {} });
    layout = { ...layout, w: 1232, h: 900, sidebar: 398, viewportLate: true };
    render(<CanvasSurface />);
    addSidebar();
    const opened = await openNode();
    expect(opened.left).toBeGreaterThanOrEqual(398 + 28 - 1e-6);
    layout.viewportLate = false;
    act(() => { deliveries.forEach(deliver => deliver()); });
    await settle();
    await glideDone();
    const after = measure();
    expect(after.left).toBeCloseTo(opened.left, 3);
    expect(after.right).toBeLessThanOrEqual(1232 - 28 + 1e-6);
  });

  it('lands on the overview when a node opened before the stage’s first size arrived closes, unless a saved camera shows the graph', async () => {
    // Its first fit was put off while the node was open, and closing it glided back to the camera the canvas started
    // with: with none saved the app's default, where the card at x 3000 stayed off the stage (pre-existing, 2026-10-16).
    const savedView = () => (JSON.parse(canvasStorage().getItem(CANVAS_STORAGE_KEY)!) as CanvasDocument).view ?? null;
    for (const saved of [null, { x: -2800, y: -1800, scale: 1 }]) {
      const deliveries: Array<() => void> = [];
      vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { deliveries.push(callback); } observe() {} unobserve() {} disconnect() {} });
      layout = { ...layout, viewportLate: true };
      canvasStorage().setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...seed({ x: 3000, y: 2000 }), view: saved }));
      const view = render(<CanvasSurface />);
      await openNode();
      layout.viewportLate = false;
      act(() => { deliveries.forEach(deliver => deliver()); });
      await settle();
      fireEvent.keyDown(window, { key: 'Escape' });
      await waitFor(() => expect(screen.getByTestId('canvas-tile-s1').dataset.lod).not.toBe('focus'));
      await glideDone();
      await settle();
      const card = measure();
      const [x, y, scale] = transformOf(document.querySelector('.canvas-world') as HTMLElement);
      if (saved) {
        // A saved camera that shows the graph is the operator's: closing returns to it.
        expect([x, y, scale]).toEqual([saved.x, saved.y, saved.scale]);
      } else {
        expect(card.left, 'none saved').toBeGreaterThanOrEqual(0);
        expect(card.right, 'none saved').toBeLessThanOrEqual(stage.w);
        // The overview is the app's camera, a fit to this screen: not saved as the operator's (past the save's
        // debounce), and refitted when the stage changes shape.
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 500)); });
        expect(savedView()).toBeNull();
        layout.w = 600;
        act(() => { deliveries.forEach(deliver => deliver()); });
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
        expect(measure().right, 'refitted').toBeLessThanOrEqual(600);
      }
      view.unmount();
    }
  });

  it('returns to the operator’s camera once 查看全部节点 has taken the first fit’s place, whenever the first size arrives', async () => {
    // 查看全部节点 fits the overview itself: a camera the operator takes after it is theirs to return to, also where the
    // stage's first size only arrives after that (the first fit then re-armed the overview on return, found in review).
    for (const firstSize of ['before', 'after'] as const) {
      const deliveries: Array<() => void> = [];
      vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { deliveries.push(callback); } observe() {} unobserve() {} disconnect() {} });
      layout = { ...layout, viewportLate: true };
      canvasStorage().setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...seed({ x: 3000, y: 2000 }), view: null }));
      const view = render(<CanvasSurface />);
      const deliver = async () => {
        layout.viewportLate = false;
        act(() => { deliveries.forEach(callback => callback()); });
        await settle();
      };
      await openNode();
      if (firstSize === 'before') await deliver();
      fireEvent.click(screen.getByRole('button', { name: '查看全部节点', exact: true }));
      await waitFor(() => expect(screen.getByTestId('canvas-tile-s1').dataset.lod).not.toBe('focus'));
      await glideDone();
      fireEvent.click(screen.getByRole('button', { name: '放大', exact: true }));
      await settle();
      const world = document.querySelector('.canvas-world') as HTMLElement;
      const mine = transformOf(world);
      await openNode();
      if (firstSize === 'after') await deliver();
      fireEvent.keyDown(window, { key: 'Escape' });
      await waitFor(() => expect(screen.getByTestId('canvas-tile-s1').dataset.lod).not.toBe('focus'));
      await glideDone();
      expect(transformOf(world), `first size ${firstSize}`).toEqual(mine);
      view.unmount();
    }
  });

  it('returns to a camera the operator took before opening the node, the first size arriving after', async () => {
    // The put-off first fit stands only for the camera the canvas started with: a zoom before opening is the
    // operator's, and closing returns to it (found in review).
    const deliveries: Array<() => void> = [];
    vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { deliveries.push(callback); } observe() {} unobserve() {} disconnect() {} });
    layout = { ...layout, viewportLate: true };
    canvasStorage().setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...seed({ x: 300, y: 200 }), view: null }));
    render(<CanvasSurface />);
    fireEvent.click(screen.getByRole('button', { name: '放大', exact: true }));
    await settle();
    const world = document.querySelector('.canvas-world') as HTMLElement;
    const mine = transformOf(world);
    expect(mine).not.toEqual([0, 0, 1]);
    await openNode();
    layout.viewportLate = false;
    act(() => { deliveries.forEach(deliver => deliver()); });
    await settle();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.getByTestId('canvas-tile-s1').dataset.lod).not.toBe('focus'));
    await glideDone();
    expect(transformOf(world)).toEqual(mine);
  });

  it('steps the assistant aside when the stage shrinks under an open node until it leaves no readable room', async () => {
    // Opened beside the sidebar on a wide stage, the node kept the whole stage under the sidebar once the window
    // narrowed (found in review). Bringing the assistant back over it then is the reader's choice, kept.
    const deliveries: Array<() => void> = [];
    vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { deliveries.push(callback); } observe() {} unobserve() {} disconnect() {} });
    const side = () => document.querySelector<HTMLElement>('.awwo-planner-sidebar');
    const shown = () => Boolean(side() && !side()!.hidden);
    render(<CanvasSurface />);
    act(() => { deliveries.forEach(deliver => deliver()); });
    fireEvent.click(screen.getByRole('button', { name: '画布助手', exact: true }));
    await waitFor(() => expect(shown()).toBe(true));
    await settle();
    await openNode();
    expect(shown()).toBe(true);
    layout = { ...layout, w: 600, sidebar: 340 };
    act(() => { deliveries.forEach(deliver => deliver()); });
    await waitFor(() => expect(shown(), 'narrowed').toBe(false));
    await settle();
    await glideDone();
    const opened = measure();
    expect(opened.left).toBeGreaterThanOrEqual(0);
    expect(opened.right).toBeLessThanOrEqual(600);
    fireEvent.click(screen.getByRole('button', { name: '画布助手', exact: true }));
    await waitFor(() => expect(shown()).toBe(true));
    await settle();
    expect(shown(), 'the reader brought it back').toBe(true);
  });

  /** A node open beside the assistant on the 1400 px stage, the stage about to narrow to 600 px under it (as above). */
  const openBesideAssistant = async () => {
    const deliveries: Array<() => void> = [];
    vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { deliveries.push(callback); } observe() {} unobserve() {} disconnect() {} });
    render(<CanvasSurface />);
    act(() => { deliveries.forEach(deliver => deliver()); });
    fireEvent.click(screen.getByRole('button', { name: '画布助手', exact: true }));
    const side = () => document.querySelector<HTMLElement>('.awwo-planner-sidebar');
    await waitFor(() => expect(side()?.hidden).toBe(false));
    await settle();
    await openNode();
    expect(side()!.hidden).toBe(false);
    layout = { ...layout, w: 600, sidebar: 340 };
    return { box: within(side()!).getByRole('textbox'), stowed: () => side()!.hidden, deliver: () => deliveries.forEach(deliver => deliver()) };
  };

  // 2026-10-20: stepping aside hides the panel and keeps it mounted, so a focus in it stayed on its box, hidden but on
  // the page, and the check that moves a lost focus left it there (a browser then drops it to the page). Where a
  // recovered run's result opens its node and frames pass before that is drawn: saas-recovery-observer.
  it('hands a focus left in the assistant to its toggle when it steps aside for the open node', async () => {
    const assistant = await openBesideAssistant();
    assistant.box.focus();
    act(assistant.deliver);
    await waitFor(() => expect(assistant.stowed()).toBe(true));
    await waitFor(() => expect(screen.getByRole('button', { name: '画布助手', exact: true })).toHaveFocus());
  });

  it('leaves a focus outside the assistant where it is when the assistant steps aside', async () => {
    const assistant = await openBesideAssistant();
    const search = screen.getByRole('searchbox', { name: '查找 Agent' });
    search.focus();
    act(assistant.deliver);
    await waitFor(() => expect(assistant.stowed()).toBe(true));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    expect(search).toHaveFocus();
  });

  it('judges the camera a node configured before the first size returns to on the board as it is once Configure closes', async () => {
    // At 900 px and below Configure lifts the board over the sidebar, so the first fit judged the saved camera (the card
    // at x 60, under the 340 px sidebar) on the whole stage and kept it: closing Configure and then the node returned the
    // card under the sidebar (pre-existing, found in review). It returns to the overview right of the sidebar.
    const deliveries: Array<() => void> = [];
    vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { deliveries.push(callback); } observe() {} unobserve() {} disconnect() {} });
    layout = { ...layout, viewportLate: true };
    await renderHosted(880, 340, true);
    await configure();
    layout.viewportLate = false;
    act(() => { deliveries.forEach(deliver => deliver()); });
    await settle();
    fireEvent.click(screen.getByRole('button', { name: '关闭配置' }));
    await waitFor(() => expect(document.querySelector('.canvas-root > .canvas-inspector')).toBeNull());
    await settle();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.getByTestId('canvas-tile-s1').dataset.lod).not.toBe('focus'));
    await glideDone();
    const card = measure();
    expect(card.left).toBeGreaterThanOrEqual(340 - 1e-6);
    expect(card.right).toBeLessThanOrEqual(880 + 1e-6);
  });

  it('steps the assistant aside for a node opened on a stage it leaves no readable room on, back once the node closes', async () => {
    // Beside a 340 px sidebar a 600 px stage leaves 204 px, and a phone's sidebar spans the stage: the node opens as
    // without the sidebar, under it (pre-existing, 2026-10-16). The assistant steps aside while the node is open, kept
    // mounted (a reply being written, a file uploading: unmounting it dropped an upload, found in review), and comes
    // back when the node closes; 画布助手 brings it back over the node. Where the part right of the sidebar has readable
    // room, the assistant stays beside the node.
    const toggle = () => fireEvent.click(screen.getByRole('button', { name: '画布助手', exact: true }));
    const side = () => document.querySelector<HTMLElement>('.awwo-planner-sidebar');
    const shown = () => Boolean(side() && !side()!.hidden);
    for (const [w, sidebar, stows] of [[600, 340, true], [600, 600, true], [1400, 400, false]] as const) {
      const where = `${w}/${sidebar}`;
      layout = { ...layout, w, h: 900, sidebar };
      canvasStorage().setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...seed({ x: 60, y: 150 }), view: { x: 0, y: 0, scale: 1 } }));
      const view = render(<CanvasSurface />);
      toggle();
      await waitFor(() => expect(shown()).toBe(true));
      await settle();
      const composer = within(side()!).getByRole('textbox');
      const opened = await openNode();
      expect(shown(), where).toBe(!stows);
      expect(within(side()!).getByRole('textbox', { hidden: true }), `${where}: still mounted`).toBe(composer);
      if (stows) {
        expect(screen.getByRole('button', { name: '画布助手', exact: true })).toHaveAttribute('aria-expanded', 'false');
        // Laid out as without the sidebar, on the whole stage and readable (at least 100 %).
        expect(transformOf(document.querySelector('.canvas-world') as HTMLElement)[2], where).toBeGreaterThanOrEqual(1 - 1e-3);
        expect(opened.left, where).toBeGreaterThanOrEqual(0);
        expect(opened.right, where).toBeLessThanOrEqual(w);
        // Back over the open node by its toggle.
        toggle();
        await waitFor(() => expect(shown(), where).toBe(true));
        expect(screen.getByTestId('canvas-tile-s1').dataset.lod, where).toBe('focus');
        toggle();
        await waitFor(() => expect(side(), where).toBeNull());
        // Opened with the node open and stepped aside again, it comes back by itself once the node closes.
        fireEvent.keyDown(window, { key: 'Escape' });
        await glideDone();
        toggle();
        await waitFor(() => expect(shown(), where).toBe(true));
        await openNode();
        expect(shown(), where).toBe(false);
        fireEvent.keyDown(window, { key: 'Escape' });
        await waitFor(() => expect(shown(), `${where}: back after closing`).toBe(true));
        await glideDone();
      }
      view.unmount();
    }
    // It stays aside for the next node opened while it is (the sidebar measures nothing then), and a wider stage later
    // opens that node beside it again.
    layout = { ...layout, w: 600, h: 900, sidebar: 340 };
    const doc = seed({ x: 60, y: 150 });
    canvasStorage().setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...doc, view: { x: 0, y: 0, scale: 1 },
      nodes: [...doc.nodes, { ...createSessionNode('llm', { x: 60, y: 420 }), id: 's2', title: 'LLM 会话二' }] }));
    render(<CanvasSurface />);
    toggle();
    await waitFor(() => expect(shown()).toBe(true));
    await settle();
    await openNode();
    expect(shown()).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '打开 LLM 会话二', exact: true }));
    await waitFor(() => expect(screen.getByTestId('canvas-tile-s2').dataset.lod).toBe('focus'));
    await glideDone();
    expect(shown(), 'the next node').toBe(false);
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(shown()).toBe(true));
    await glideDone();
    layout = { ...layout, w: 1400 };
    fireEvent.click(screen.getByRole('button', { name: '打开 LLM 会话二', exact: true }));
    await waitFor(() => expect(screen.getByTestId('canvas-tile-s2').dataset.lod).toBe('focus'));
    await glideDone();
    expect(shown(), 'a wider stage').toBe(true);
  });

  it('opens a delivered node’s drawer by itself only where the stylesheet lays it beside the conversation', async () => {
    // A 750 px frame is under the 770 px a drawer needs beside the conversation (740 px of workbench inside the tile's
    // 30 px of padding and border): by itself it opened there over the conversation (found 2026-10-16). 794 px holds it.
    for (const [w, sidebar, frame, open] of [[1193, 387, 750, false], [1250, 400, 794, true]] as const) {
      layout = { ...layout, w, h: 900, sidebar };
      canvasStorage().setItem(CANVAS_STORAGE_KEY, JSON.stringify({
        ...seed({ x: 60, y: 150, lastOutput: { text: '## 关卡规格\n- 三段', source: 'run', at: 1 } }), view: { x: 0, y: 0, scale: 1 },
      }));
      const view = render(<CanvasSurface />);
      addSidebar();
      const opened = await openNode();
      expect(opened.width, `stage ${w}`).toBeCloseTo(frame, 3);
      expect(Boolean(screen.queryByRole('region', { name: '交付物' })), `stage ${w}`).toBe(open);
      view.unmount();
    }
  });

  it('keeps the frame layout beside a sidebar that leaves less than a narrow stage (production: 1232 px, 398 px)', async () => {
    // 834 px are left right of the sidebar, less than the 900 px below which a stage opens nodes in its narrow layout
    // (a 520 × 380 card zoomed in, its delivery over the conversation). The stage is not narrow: the node keeps its
    // frame, as wide as that part allows.
    layout = { ...layout, w: 1232, h: 900, sidebar: 398 };
    render(<CanvasSurface />);
    addSidebar();
    const opened = await openNode();
    expect(narrowLayout()).toBe(false);
    expect(opened.width).toBeCloseTo(1232 - 398 - 56, 3);
    expect(opened.left).toBeGreaterThanOrEqual(398 + 28 - 1e-6);
    expect(opened.right).toBeLessThanOrEqual(1232 - 28 + 1e-6);
  });

  it('opens a node in the narrow layout where the part right of the sidebar has no room for an open frame', async () => {
    // A 910 px stage is not narrow, but beside a 340 px sidebar 514 px are left inside the padding, less than an open
    // frame's 520: the node fell back to its card plus its delivery drawer (840 px) zoomed to 61 % (found in review). It
    // opens in the narrow layout, as wide as that part, at 100 %.
    layout = { ...layout, w: 910, h: 900, sidebar: 340 };
    canvasStorage().setItem(CANVAS_STORAGE_KEY, JSON.stringify({
      ...seed({ x: 60, y: 150, lastOutput: { text: '## 关卡规格\n- 三段', source: 'run', at: 1 } }), view: { x: 0, y: 0, scale: 1 },
    }));
    render(<CanvasSurface />);
    addSidebar();
    const opened = await openNode();
    expect(narrowLayout()).toBe(true);
    expect(transformOf(document.querySelector('.canvas-world') as HTMLElement)[2]).toBeCloseTo(1, 3);
    expect(opened.width).toBeCloseTo(910 - 340 - 56, 3);
    expect(opened.left).toBeGreaterThanOrEqual(340 + 28 - 1e-6);
  });

  it('does not count a sidebar that leaves no room for an open node at a readable scale', async () => {
    // A 600 px stage beside a 340 px sidebar leaves 204 px inside the padding: the narrow layout's 280 px node would
    // open at 73 %, its text about 9.5 px (found in review). The node opens as without the sidebar, at 100 %.
    layout = { ...layout, w: 600, h: 900, sidebar: 340 };
    render(<CanvasSurface />);
    addSidebar();
    await openNode();
    expect(transformOf(document.querySelector('.canvas-world') as HTMLElement)[2]).toBeCloseTo(1, 3);
  });

  it('opens a node in the narrow layout of a narrow stage as wide as the part right of the sidebar, at 100 %', async () => {
    layout = { ...layout, w: 880, h: 900, sidebar: 350 };
    render(<CanvasSurface />);
    addSidebar();
    const opened = await openNode();
    expect(narrowLayout()).toBe(true);
    const [, , scale] = transformOf(document.querySelector('.canvas-world') as HTMLElement);
    expect(scale).toBeCloseTo(1, 3);
    expect(opened.width).toBeCloseTo(880 - 350 - 56, 3);
    expect(opened.left).toBeGreaterThanOrEqual(350 + 28 - 1e-6);
    expect(opened.right).toBeLessThanOrEqual(880 - 28 + 1e-6);
  });
});

describe('CanvasSurface keeps an opened node clear of the inspector (cloud)', () => {
  it('opened for configuration, a node near the right edge stays left of the floating inspector', async () => {
    const stage = { w: 1600, h: 1000 };
    stubStage(stage);
    const tenant = { id: 'workspace', name: 'Workspace', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 100 };
    configureCanvasStorage('user', tenant.id, 'canvas');
    configureSaaSCanvas({ tenant, canvasId: 'canvas' });
    // On screen the card sits at x = 2000 × 0.8 − 800 = 800 px: opened in place at 1.25× (520 px wide
    // opened, 650 px on screen) its right edge would reach 1450 px, under the 360 px inspector.
    canvasStorage().setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...seed({ x: 2000, y: 300 }), view: { x: -800, y: 0, scale: 0.8 } }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [] }))));
    render(<CanvasSurface storageMode="cloud" runtimeReadJson={async () => ({ agents: [], models: [] })} />);
    const world = document.querySelector('.canvas-world') as HTMLElement;
    const tile = within(await screen.findByTestId('canvas-tile-s1'));
    expect(world.style.transform).toBe('translate(-800px, 0px) scale(0.8)');
    fireEvent.click(tile.getByRole('button', { name: '更多节点操作' }));
    fireEvent.click(tile.getByRole('button', { name: '配置', exact: true }));
    await waitFor(() => expect(screen.getByTestId('canvas-tile-s1').dataset.lod).toBe('focus'));
    await glideDone();
    expect(document.querySelector('.canvas-root > .canvas-inspector')).not.toBeNull();
    const opened = screen.getByTestId('canvas-tile-s1');
    const [x, , scale] = transformOf(world);
    // 12 px inset + 360 px inspector + 16 px clear space on the right: pinned against that edge.
    expect(x + (2000 + parseFloat(opened.style.width)) * scale).toBeCloseTo(stage.w - 388, 3);
  });

  it('keeps the node clear of the inspector when it re-fits while being configured (its deliverables open)', async () => {
    const stage = { w: 1600, h: 1000 };
    stubStage(stage);
    const tenant = { id: 'workspace', name: 'Workspace', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 100 };
    configureCanvasStorage('user', tenant.id, 'canvas');
    configureSaaSCanvas({ tenant, canvasId: 'canvas' });
    canvasStorage().setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...seed({ x: 2000, y: 300 }), view: { x: -800, y: 0, scale: 0.8 } }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [] }))));
    render(<CanvasSurface storageMode="cloud" runtimeReadJson={async () => ({ agents: [], models: [] })} />);
    const world = document.querySelector('.canvas-world') as HTMLElement;
    const tile = within(await screen.findByTestId('canvas-tile-s1'));
    fireEvent.click(tile.getByRole('button', { name: '更多节点操作' }));
    fireEvent.click(tile.getByRole('button', { name: '配置', exact: true }));
    await waitFor(() => expect(screen.getByTestId('canvas-tile-s1').dataset.lod).toBe('focus'));
    await glideDone();
    // The deliverables widen the node; it re-fits a frame later, with the inspector still open.
    fireEvent.click(within(screen.getByTestId('canvas-tile-s1')).getByRole('button', { name: '展开交付物' }));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 420)); });
    expect(document.querySelector('.canvas-root > .canvas-inspector')).not.toBeNull();
    const opened = screen.getByTestId('canvas-tile-s1');
    const [x, , scale] = transformOf(world);
    expect(x + (parseFloat(opened.style.left) + parseFloat(opened.style.width)) * scale).toBeLessThanOrEqual(stage.w - 388 + 0.001);
  });

  it('opens narrower beside Configure and takes its room back when Configure closes', async () => {
    const stage = { w: 1400, h: 900 };
    stubStage(stage);
    const tenant = { id: 'workspace', name: 'Workspace', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 100 };
    configureCanvasStorage('user', tenant.id, 'canvas');
    configureSaaSCanvas({ tenant, canvasId: 'canvas' });
    canvasStorage().setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...seed({ x: 300, y: 200 }), view: { x: 0, y: 0, scale: 0.8 } }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [] }))));
    render(<CanvasSurface storageMode="cloud" runtimeReadJson={async () => ({ agents: [], models: [] })} />);
    const world = document.querySelector('.canvas-world') as HTMLElement;
    const tile = within(await screen.findByTestId('canvas-tile-s1'));
    fireEvent.click(tile.getByRole('button', { name: '更多节点操作' }));
    fireEvent.click(tile.getByRole('button', { name: '配置', exact: true }));
    await waitFor(() => expect(screen.getByTestId('canvas-tile-s1').dataset.lod).toBe('focus'));
    await glideDone();
    const opened = screen.getByTestId('canvas-tile-s1');
    // The stage less its padding and Configure's 388 px: 1400 − 56 − 388.
    expect(parseFloat(opened.style.width)).toBe(956);
    const [x, , scale] = transformOf(world);
    expect(scale).toBe(1);
    expect(x + (300 + 956) * scale).toBeLessThanOrEqual(stage.w - 388 + 0.001);
    fireEvent.click(screen.getByRole('button', { name: '关闭配置' }));
    await settle();
    await glideDone();
    expect(document.querySelector('.canvas-root > .canvas-inspector')).toBeNull();
    // A conversation's readable column again (1100), still whole on the stage.
    expect(parseFloat(opened.style.width)).toBe(1100);
    expectBoxOnStage(world, { x: 300, y: 200, w: 1100, h: parseFloat(opened.style.height) }, stage);
  });

  it('gives up part of that clear space before the node would drop below the readable scale', async () => {
    // A 700 px stage: the full 388 px reserve would leave 284 px for a 520 px node (0.55×).
    const stage = { w: 700, h: 1000 };
    stubStage(stage);
    const tenant = { id: 'workspace', name: 'Workspace', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 100 };
    configureCanvasStorage('user', tenant.id, 'canvas');
    configureSaaSCanvas({ tenant, canvasId: 'canvas' });
    canvasStorage().setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...seed({ x: 500, y: 300 }), view: { x: 0, y: 0, scale: 0.8 } }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [] }))));
    render(<CanvasSurface storageMode="cloud" runtimeReadJson={async () => ({ agents: [], models: [] })} />);
    const world = document.querySelector('.canvas-world') as HTMLElement;
    const tile = within(await screen.findByTestId('canvas-tile-s1'));
    expect(world.style.transform).toBe('translate(0px, 0px) scale(0.8)');
    fireEvent.click(tile.getByRole('button', { name: '更多节点操作' }));
    fireEvent.click(tile.getByRole('button', { name: '配置', exact: true }));
    await waitFor(() => expect(screen.getByTestId('canvas-tile-s1').dataset.lod).toBe('focus'));
    await glideDone();
    const opened = screen.getByTestId('canvas-tile-s1');
    const width = parseFloat(opened.style.width);
    const [x, , scale] = transformOf(world);
    expect(scale).toBeCloseTo(0.75, 3);
    // The reserve that leaves: 700 − 28 − 520 × 0.75 = 282 px, so the node ends 282 px from the right.
    const reserve = stage.w - 28 - width * 0.75;
    expect(x + (500 + width) * scale).toBeCloseTo(stage.w - reserve, 3);
  });

  it('reserves nothing where the inspector spans the stage (the hosted app at phone width), and still does on the desktop', async () => {
    const stage = { w: 700, h: 1000 };
    stubStage(stage);
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('max-width: 760px'), media: query, onchange: null,
      addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
    }));
    const tenant = { id: 'workspace', name: 'Workspace', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 100 };
    configureCanvasStorage('user', tenant.id, 'canvas');
    configureSaaSCanvas({ tenant, canvasId: 'canvas' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [] }))));
    const openForConfiguration = async (shell: boolean) => {
      canvasStorage().setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...seed({ x: 500, y: 300 }), view: { x: 0, y: 0, scale: 0.8 } }));
      const surface = <CanvasSurface storageMode="cloud" runtimeReadJson={async () => ({ agents: [], models: [] })} />;
      const view = render(shell ? <div className="saas-canvas-shell">{surface}</div> : surface);
      const tile = within(await screen.findByTestId('canvas-tile-s1'));
      fireEvent.click(tile.getByRole('button', { name: '更多节点操作' }));
      fireEvent.click(tile.getByRole('button', { name: '配置', exact: true }));
      await waitFor(() => expect(screen.getByTestId('canvas-tile-s1').dataset.lod).toBe('focus'));
      await glideDone();
      const opened = screen.getByTestId('canvas-tile-s1');
      const scale = transformOf(document.querySelector('.canvas-world') as HTMLElement)[2];
      const size = { w: parseFloat(opened.style.width), h: parseFloat(opened.style.height) };
      view.unmount();
      return { scale, size };
    };
    // In the hosted app the inspector covers the whole stage there: the node opens as without one.
    const hosted = await openForConfiguration(true);
    expect(hosted.scale).toBeCloseTo(Math.min(1.25, (stage.w - 56) / hosted.size.w, (stage.h - 106) / hosted.size.h), 3);
    // The desktop's inspector stays a 360 px panel at that width, so the node still keeps clear of it.
    const desktop = await openForConfiguration(false);
    expect(desktop.scale).toBeCloseTo(0.75, 3);
  });
});

// Review fixes, 2026-10-15: what an opened node keeps as the reader left it, and what a refit may not take back.
describe('CanvasSurface keeps an opened node as the reader left it', () => {
  const delivered = (over: Partial<ReturnType<typeof createSessionNode>> = {}) =>
    seed({ lastOutput: { text: '## 关卡规格\n- 三段', source: 'run', at: 1 }, ...over });
  const openOn = async (stage: { w: number; h: number }) => {
    stubStage(stage);
    render(<CanvasSurface />);
    fireEvent.click(screen.getByRole('button', { name: '打开 LLM 会话', exact: true }));
    await waitFor(() => expect(screen.getByTestId('canvas-tile-s1').dataset.lod).toBe('focus'));
    await glideDone();
    return { world: document.querySelector('.canvas-world') as HTMLElement, tile: screen.getByTestId('canvas-tile-s1') };
  };
  const saved = () => (JSON.parse(canvasStorage().getItem(CANVAS_STORAGE_KEY)!) as CanvasDocument).nodes[0] as ReturnType<typeof createSessionNode>;

  it('remembers a delivery drawer closed after it opened by itself, without moving, resizing or refitting the node', async () => {
    canvasStorage().setItem(CANVAS_STORAGE_KEY, JSON.stringify(delivered()));
    const before = saved();
    const { world, tile } = await openOn({ w: 1600, h: 1000 });
    expect(within(tile).getByRole('region', { name: '交付物' })).toBeTruthy();
    const camera = world.style.transform;
    fireEvent.click(within(tile).getByRole('button', { name: '关闭交付物' }));
    await settle();
    await waitFor(() => expect(saved().deliverablesOpen).toBe(false));
    expect([saved().x, saved().y, saved().w, saved().h]).toEqual([before.x, before.y, before.w, before.h]);
    expect(world.style.transform).toBe(camera);
    expect(within(tile).queryByRole('region', { name: '交付物' })).toBeNull();
  });

  it('keeps a drawer that opened by itself open, its form editor too, while the reader edits a delivered value and publishes it', async () => {
    // Editing the value takes the delivery back until it is published again (invalidateOutputs). The first keystroke
    // used to close the drawer and its editor with it (2026-10-20), so publishing took 展开交付物 and 编辑输出表单 again.
    const contract = { version: 1 as const, inputs: [], outputs: [{ id: 'result', label: 'Result', type: 'markdown' as const, required: true, value: '' }] };
    canvasStorage().setItem(CANVAS_STORAGE_KEY, JSON.stringify(delivered({ contract, lastOutput: { text: '{"result":"## 关卡规格"}', source: 'run', at: 1 } })));
    const { world, tile } = await openOn({ w: 1600, h: 1000 });
    const drawer = within(tile).getByRole('region', { name: '交付物' });
    // The camera the opening glide lands on: under load its last frame can come after openOn's wait.
    for (let landed = '', waits = 0; landed !== world.style.transform; waits += 1) {
      if (waits === 10) throw new Error(`the opening glide never landed: ${world.style.transform}`);
      landed = world.style.transform;
      await glideDone();
    }
    const camera = world.style.transform;
    const size = [tile.style.width, tile.style.height];
    const share = () => tile.style.getPropertyValue('--awwo-drawer-width');
    expect(share()).toBe('52%');
    fireEvent.click(within(drawer).getByText('编辑输出表单'));
    const field = within(drawer).getByLabelText('Result的值');
    field.focus();
    fireEvent.change(field, { target: { value: '## 关卡规格（第二' } });
    await waitFor(() => expect(saved().lastOutput ?? null).toBeNull(), { timeout: 3000 });
    // Nothing about the drawer is recorded.
    expect(saved()).not.toHaveProperty('deliverablesOpen');
    // Past the refit the canvas would make for the delivery it took back, and its glide: the same drawer with its
    // editor open, the same field focused and taking the next keystroke, the node where it was.
    await settle();
    await glideDone();
    expect(screen.getByTestId('canvas-tile-s1')).toBe(tile);
    expect(within(tile).queryByRole('region', { name: '交付物' })).toBe(drawer);
    expect(within(tile).getByRole('button', { name: '收起交付物' })).toHaveAttribute('aria-expanded', 'true');
    expect(within(drawer).getByText('编辑输出表单').closest('details')).toHaveAttribute('open');
    expect(within(drawer).getByLabelText('Result的值')).toBe(field);
    expect(document.activeElement).toBe(field);
    fireEvent.change(field, { target: { value: '## 关卡规格（第二版）' } });
    expect(field).toHaveValue('## 关卡规格（第二版）');
    // Nor does the drawer narrow under the keystroke.
    expect(share()).toBe('52%');
    expect(world.style.transform).toBe(camera);
    expect([tile.style.width, tile.style.height]).toEqual(size);
    // Published where the reader is, nothing opened again: the drawer opens by itself for the new delivery.
    fireEvent.click(within(drawer).getByRole('button', { name: '发布输出' }));
    await waitFor(() => expect(saved().lastOutput).toMatchObject({ text: '{"result":"## 关卡规格（第二版）"}', source: 'manual' }), { timeout: 3000 });
    expect(saved()).not.toHaveProperty('deliverablesOpen');
    await settle();
    await glideDone();
    expect(screen.getByTestId('canvas-tile-s1')).toBe(tile);
    expect(within(drawer).getByRole('heading', { name: '关卡规格（第二版）' })).toBeTruthy();
    expect(within(tile).getByRole('region', { name: '交付物' })).toBe(drawer);
    expect(share()).toBe('52%');
    expect(world.style.transform).toBe(camera);
    expect([tile.style.width, tile.style.height]).toEqual(size);
  });

  it('keeps the drawer closed by default on a stage where it would cover the conversation', async () => {
    canvasStorage().setItem(CANVAS_STORAGE_KEY, JSON.stringify(delivered()));
    const { tile } = await openOn({ w: 800, h: 700 });
    expect(within(tile).queryByRole('region', { name: '交付物' })).toBeNull();
  });

  it('takes a hand resize of the open frame as a view choice: the saved node keeps its size and the stage no longer refits it', async () => {
    // Every observer hears the resize, as the file's other tests do: an opened node observes its chat column too (useShortColumn).
    const observers: Array<() => void> = [];
    const deliverResize = () => observers.forEach(deliver => deliver());
    vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { observers.push(callback); } observe() {} unobserve() {} disconnect() {} });
    const stage = { w: 1600, h: 1000 };
    canvasStorage().setItem(CANVAS_STORAGE_KEY, JSON.stringify(seed()));
    const before = seed().nodes[0] as ReturnType<typeof createSessionNode>;
    const { world, tile } = await openOn(stage);
    const handle = screen.getByTestId('canvas-tile-resize-s1');
    const [w0, h0] = [parseFloat(tile.style.width), parseFloat(tile.style.height)];
    fireEvent.pointerDown(handle, { button: 0, clientX: 500, clientY: 500 });
    fireEvent.pointerMove(window, { clientX: 400, clientY: 450 });
    fireEvent.pointerUp(window, { clientX: 400, clientY: 450 });
    expect([parseFloat(tile.style.width), parseFloat(tile.style.height)]).toEqual([w0 - 100, h0 - 50]);
    await settle();
    expect([saved().w, saved().h]).toEqual([before.w, before.h]);
    const camera = world.style.transform;
    stage.w = 1400; stage.h = 900;
    act(() => deliverResize());
    await settle();
    await glideDone();
    expect(world.style.transform).toBe(camera);
    expect([parseFloat(tile.style.width), parseFloat(tile.style.height)]).toEqual([w0 - 100, h0 - 50]);
  });

  it('shrinks a node saved larger than its frame when it is resized by hand, and keeps that size when opened again in place', async () => {
    canvasStorage().setItem(CANVAS_STORAGE_KEY, JSON.stringify(seed({ w: 1400, h: 900 })));
    const { tile } = await openOn({ w: 1600, h: 1000 });
    expect([parseFloat(tile.style.width), parseFloat(tile.style.height)]).toEqual([1400, 900]);
    const handle = screen.getByTestId('canvas-tile-resize-s1');
    fireEvent.pointerDown(handle, { button: 0, clientX: 800, clientY: 800 });
    fireEvent.pointerMove(window, { clientX: 500, clientY: 500 });
    fireEvent.pointerUp(window, { clientX: 500, clientY: 500 });
    // A 300 px drag at the open node's zoom, below the 1400 × 900 it is saved at.
    const scale = transformOf(document.querySelector('.canvas-world') as HTMLElement)[2];
    const resized = [parseFloat(tile.style.width), parseFloat(tile.style.height)];
    expect(resized[0]).toBeCloseTo(1400 - 300 / scale, 0);
    expect(resized[1]).toBeCloseTo(900 - 300 / scale, 0);
    expect([saved().w, saved().h]).toEqual([1400, 900]);
    // Configure places the open node again: the size the reader chose stays.
    fireEvent.click(within(tile).getByRole('button', { name: '更多节点操作' }));
    fireEvent.click(within(tile).getByRole('button', { name: '配置', exact: true }));
    await glideDone();
    const again = screen.getByTestId('canvas-tile-s1');
    expect([parseFloat(again.style.width), parseFloat(again.style.height)]).toEqual(resized);
  });

  it('places a display shown from a card beside the open node clear of that node’s frame', async () => {
    const doc = delivered();
    const beside = { ...createSessionNode('llm', { x: 600, y: 800 }), id: 's2', title: '旁边的节点', lastOutput: { text: '## 草图', source: 'run' as const, at: 1 } };
    canvasStorage().setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...doc, nodes: [...doc.nodes, beside] }));
    const { tile } = await openOn({ w: 1600, h: 1000 });
    const frame = { x: 900, y: 700, w: parseFloat(tile.style.width), h: parseFloat(tile.style.height) };
    // The card's own spot, right of it at x = 932, lies under the open node.
    const card = within(screen.getByTestId('canvas-tile-s2'));
    fireEvent.click(card.getByRole('button', { name: '更多节点操作' }));
    fireEvent.click(card.getByRole('button', { name: '在预览展示中查看' }));
    await waitFor(() => expect((JSON.parse(canvasStorage().getItem(CANVAS_STORAGE_KEY)!) as CanvasDocument).displays?.length).toBe(1));
    const display = (JSON.parse(canvasStorage().getItem(CANVAS_STORAGE_KEY)!) as CanvasDocument).displays![0];
    const overlaps = display.x < frame.x + frame.w && display.x + display.w > frame.x && display.y < frame.y + frame.h && display.y + display.h > frame.y;
    expect(overlaps).toBe(false);
  });

  it('keeps the room of a delivery a run clears while the node is open', async () => {
    canvasStorage().setItem(CANVAS_STORAGE_KEY, JSON.stringify(delivered()));
    const { tile } = await openOn({ w: 1800, h: 1000 });
    expect(parseFloat(tile.style.width)).toBe(1440);
    // A new conversation clears the delivery (nodeThreads.ts), as a run invalidating it would: the open node stays as wide.
    fireEvent.click(within(tile).getByRole('button', { name: '展开 Session 列表' }));
    fireEvent.click(within(tile).getByRole('button', { name: '新建 Session' }));
    await waitFor(() => expect(saved().lastOutput ?? null).toBeNull());
    await settle();
    await glideDone();
    expect(parseFloat(screen.getByTestId('canvas-tile-s1').style.width)).toBe(1440);
  });

  it('returns to the operator’s camera when the node closes after a refit', async () => {
    // Every observer hears the resize, as the file's other tests do: an opened node observes its chat column too (useShortColumn).
    const observers: Array<() => void> = [];
    const deliverResize = () => observers.forEach(deliver => deliver());
    vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { observers.push(callback); } observe() {} unobserve() {} disconnect() {} });
    const stage = { w: 1600, h: 1000 };
    canvasStorage().setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...seed(), view: { x: 40, y: 30, scale: 0.8 } }));
    stubStage(stage);
    render(<CanvasSurface />);
    const world = document.querySelector('.canvas-world') as HTMLElement;
    await settle();
    const operator = world.style.transform;
    fireEvent.click(screen.getByRole('button', { name: '打开 LLM 会话', exact: true }));
    await waitFor(() => expect(screen.getByTestId('canvas-tile-s1').dataset.lod).toBe('focus'));
    await glideDone();
    const opened = world.style.transform;
    stage.w = 1300;
    act(() => deliverResize());
    await settle();
    await glideDone();
    expect(world.style.transform).not.toBe(opened);
    fireEvent.keyDown(window, { key: 'Escape' });
    await glideDone();
    expect(world.style.transform).toBe(operator);
  });
});
