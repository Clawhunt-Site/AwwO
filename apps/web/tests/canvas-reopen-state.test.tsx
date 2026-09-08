import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CanvasSurface } from '../src/canvas/CanvasSurface';
import { CANVAS_STORAGE_KEY, createSessionNode, emptyDocument, loadDocumentWithStatus } from '../src/canvas/canvasDoc';
import { createAgentTemplate } from '../src/canvas/agentTemplates';
import { appendTurn, resetAllSessions } from '../src/canvas/sessions';

class MeasuredResizeObserver { observe() {} unobserve() {} disconnect() {} }
const savedView = { x: -235, y: 71, scale: 0.75 };
const savedTransform = 'translate(-235px, 71px) scale(0.75)';
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

describe('canvas reopen state', () => {
  it('retains a saved viewport after layout measurement', async () => {
    store(savedView);
    const { container } = render(<CanvasSurface />);
    const world = container.querySelector('.canvas-world') as HTMLElement;
    expect(world.style.transform).toBe(savedTransform);
    // Covers the debounced document write as well as the initial measurement effect.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 450)); });
    expect(world.style.transform).toBe(savedTransform);
    expect(loadDocumentWithStatus().doc.view).toEqual(savedView);
    // An explicit operator fit remains available for an intentionally off-screen saved view.
    fireEvent.click(screen.getByRole('button', { name: '查看全部节点' }));
    expect(world.style.transform).not.toBe(savedTransform);
  });

  it.each([null, { x: 12, y: 13, scale: 0 }])('fits a graph that has no valid saved viewport (%j)', async view => {
    store(view);
    const { container } = render(<CanvasSurface />);
    const world = container.querySelector('.canvas-world') as HTMLElement;
    await waitFor(() => expect(world.style.transform).not.toBe('translate(0px, 0px) scale(1)'));
    const match = world.style.transform.match(/^translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)$/)!;
    const [x, y, scale] = match.slice(1).map(Number);
    expect(scale).toBeGreaterThan(0);
    expect(x + 2000 * scale).toBeGreaterThanOrEqual(0);
    expect(x + (2000 + 260) * scale).toBeLessThanOrEqual(1200);
    expect(y + 1500 * scale).toBeGreaterThanOrEqual(0);
    expect(y + (1500 + 128) * scale).toBeLessThanOrEqual(800);
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
