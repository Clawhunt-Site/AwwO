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
import { clearSaaSCanvas, configureSaaSCanvas } from '../src/saas/canvasBridge';
import { resetAllSessions } from '../src/canvas/sessions';
import { RAIL_BOT_KEY, RAIL_MODEL_KEY } from '../src/canvas/railState';

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
    let deliverResize = () => {};
    vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { deliverResize = callback; } observe() {} unobserve() {} disconnect() {} });
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
    let deliverResize = () => {};
    vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { deliverResize = callback; } observe() {} unobserve() {} disconnect() {} });
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
    let deliverResize = () => {};
    vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { deliverResize = callback; } observe() {} unobserve() {} disconnect() {} });
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
    let deliverResize = () => {};
    vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { deliverResize = callback; } observe() {} unobserve() {} disconnect() {} });
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

  it('keeps the drawer closed by default on a stage where it would cover the conversation', async () => {
    canvasStorage().setItem(CANVAS_STORAGE_KEY, JSON.stringify(delivered()));
    const { tile } = await openOn({ w: 800, h: 700 });
    expect(within(tile).queryByRole('region', { name: '交付物' })).toBeNull();
  });

  it('takes a hand resize of the open frame as a view choice: the saved node keeps its size and the stage no longer refits it', async () => {
    let deliverResize = () => {};
    vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { deliverResize = callback; } observe() {} unobserve() {} disconnect() {} });
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
    let deliverResize = () => {};
    vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { deliverResize = callback; } observe() {} unobserve() {} disconnect() {} });
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
