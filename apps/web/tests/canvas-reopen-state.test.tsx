import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CanvasSurface } from '../src/canvas/CanvasSurface';
import { CANVAS_STORAGE_KEY, createSessionNode, emptyDocument, loadDocumentWithStatus } from '../src/canvas/canvasDoc';
import { createAgentTemplate } from '../src/canvas/agentTemplates';
import { appendTurn, resetAllSessions } from '../src/canvas/sessions';

class MeasuredResizeObserver { observe() {} unobserve() {} disconnect() {} }
// The node sits at (2000,1500) as a 260x128 compact card. This view keeps it fully inside a
// 1200x800 stage (screen x 100..295, y 125..221), so the canvas must reopen exactly here.
const savedView = { x: -1400, y: -1000, scale: 0.75 };
const savedTransform = 'translate(-1400px, -1000px) scale(0.75)';
// The same scale panned so the card lands past the right edge (screen x 1265): off stage.
const offStageView = { x: -235, y: 71, scale: 0.75 };
beforeEach(() => {
  cleanup(); resetAllSessions(); localStorage.clear(); vi.restoreAllMocks();
  vi.stubGlobal('ResizeObserver', MeasuredResizeObserver);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })));
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800, toJSON() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function store(view: unknown) {
  const node = { ...createSessionNode('llm', { x: 2000, y: 1500 }), id: 'reopened-node' };
  localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...emptyDocument(), nodes: [node], view }));
}

function parseTransform(world: HTMLElement): [number, number, number] {
  const match = world.style.transform.match(/^translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)$/)!;
  return match.slice(1).map(Number) as [number, number, number];
}

function expectCardOnStage(world: HTMLElement, stage = { w: 1200, h: 800 }) {
  const [x, y, scale] = parseTransform(world);
  expect(scale).toBeGreaterThan(0);
  expect(x + 2000 * scale).toBeGreaterThanOrEqual(0);
  expect(x + (2000 + 260) * scale).toBeLessThanOrEqual(stage.w);
  expect(y + 1500 * scale).toBeGreaterThanOrEqual(0);
  expect(y + (1500 + 128) * scale).toBeLessThanOrEqual(stage.h);
}

describe('canvas reopen state', () => {
  it('retains a saved viewport that still shows the graph after layout measurement', async () => {
    store(savedView);
    const { container } = render(<CanvasSurface />);
    const world = container.querySelector('.canvas-world') as HTMLElement;
    expect(world.style.transform).toBe(savedTransform);
    // Covers the debounced document write as well as the initial measurement effect.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 450)); });
    expect(world.style.transform).toBe(savedTransform);
    expect(loadDocumentWithStatus().doc.view).toEqual(savedView);
    // An explicit operator fit remains available.
    fireEvent.click(screen.getByRole('button', { name: '查看全部节点' }));
    expect(world.style.transform).not.toBe(savedTransform);
    expectCardOnStage(world);
  });

  it('refits once when the saved viewport leaves the graph off this stage', async () => {
    store(offStageView);
    const { container } = render(<CanvasSurface />);
    const world = container.querySelector('.canvas-world') as HTMLElement;
    await waitFor(() => expect(world.style.transform).not.toBe('translate(-235px, 71px) scale(0.75)'));
    expectCardOnStage(world);
    const refitted = world.style.transform;
    // The refit is a one-off: the same measurement again does not move the camera.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 450)); });
    expect(world.style.transform).toBe(refitted);
    expect(loadDocumentWithStatus().doc.view).not.toEqual(offStageView);
  });

  it.each([null, { x: 12, y: 13, scale: 0 }])('fits a graph that has no valid saved viewport (%j)', async view => {
    store(view);
    const { container } = render(<CanvasSurface />);
    const world = container.querySelector('.canvas-world') as HTMLElement;
    await waitFor(() => expect(world.style.transform).not.toBe('translate(0px, 0px) scale(1)'));
    expectCardOnStage(world);
  });

  it.each(['factory', 'template', 'missing-old-preview'])('persists the first reply preview from %s input', async source => {
    const node = source === 'template' ? createAgentTemplate('general', { x: 0, y: 0 }) : createSessionNode('llm', { x: 0, y: 0 });
    expect(node.preview).toBe('');
    const raw = source === 'missing-old-preview' ? { ...node, preview: undefined } : node;
    localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...emptyDocument(), nodes: [raw], view: savedView }));
    const normalized = loadDocumentWithStatus().doc.nodes[0];
    expect(normalized.kind === 'session' && normalized.preview).toBe('');
    render(<CanvasSurface />);
    act(() => appendTurn(node.id, { role: 'agent', text: '首条实际回复' }));
    await waitFor(() => {
      const stored = loadDocumentWithStatus().doc.nodes[0];
      expect(stored.kind === 'session' && stored.preview).toBe('首条实际回复');
    });
  });
});
