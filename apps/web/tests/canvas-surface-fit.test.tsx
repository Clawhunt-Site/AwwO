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
// a side rail toggling) — but never while a node is focused, since that camera is the operator's.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CanvasSurface } from '../src/canvas/CanvasSurface';
import { CANVAS_STORAGE_KEY, createSessionNode, emptyDocument, type CanvasDocument } from '../src/canvas/canvasDoc';
import { canvasStorage, configureCanvasStorage } from '../src/canvas/canvasStorage';
import { clearSaaSCanvas, configureSaaSCanvas } from '../src/saas/canvasBridge';
import { resetAllSessions } from '../src/canvas/sessions';
import { RAIL_MODEL_KEY } from '../src/canvas/railState';

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
  it('caps the focus scale so a node with its delivery drawer never overflows the stage', async () => {
    // Saved 1400x900 with the drawer open: wider AND taller than a 1280x720 stage minus padding.
    localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify(seed({ w: 1400, h: 900, deliverablesOpen: true })));
    const stage = { w: 1280, h: 720 };
    stubRootSize(stage.w, stage.h);
    render(<CanvasSurface />);
    const world = document.querySelector('.canvas-world') as HTMLElement;
    fireEvent.click(screen.getByRole('button', { name: '打开 LLM 会话', exact: true }));
    await waitFor(() => expect(screen.getByTestId('canvas-tile-s1').dataset.lod).toBe('focus'));
    const scale = expectBoxOnStage(world, { x: 900, y: 700, w: 1400, h: 900 }, stage);
    // Below fitBounds' 0.75 readable floor: only the cap can put the whole node on stage.
    expect(scale).toBeLessThan(0.75);
    expect(scale).toBeCloseTo((stage.h - 24 - 82) / 900, 3);
  });

  it('refits the overview when the stage resizes while nothing is focused, and leaves a focused camera alone', async () => {
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

    // Focused: the operator owns the camera, a resize must not move it.
    fireEvent.click(screen.getByRole('button', { name: '打开 LLM 会话', exact: true }));
    await waitFor(() => expect(screen.getByTestId('canvas-tile-s1').dataset.lod).toBe('focus'));
    const focused = world.style.transform;
    stage.w = 1000; stage.h = 700;
    act(() => deliverResize());
    await settle();
    expect(world.style.transform).toBe(focused);
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
    const stage = { w: 1200, h: 800 };
    stubStage(stage);
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

    // The operator zooms: the camera is theirs, and neither rail moves it.
    fireEvent.click(screen.getByRole('button', { name: '放大', exact: true }));
    const zoomed = world.style.transform;
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
    stage.w = 800;
    fireEvent.click(screen.getByRole('button', { name: '收起模型' }));
    await settle();
    expect(world.style.transform).not.toBe(refitted);
    expectBoxOnStage(world, node, stage);

    // Focused: a rail toggle leaves the camera where the operator put it.
    fireEvent.click(screen.getByRole('button', { name: '打开 LLM 会话', exact: true }));
    await waitFor(() => expect(screen.getByTestId('canvas-tile-s1').dataset.lod).toBe('focus'));
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
