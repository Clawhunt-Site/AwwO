// UNDO / REDO.
//
// A canvas without ⌘Z is a canvas you are afraid to touch: one stray Delete removes a node AND
// the agent session inside it, and one bad drag scatters a layout you arranged by hand. This is
// the single largest thing standing between "a graph editor" and "a tool you can play in".
//
// Three rules are being defended here, because getting any of them wrong makes undo worse than
// having none:
//   1. USER EDITS are steps (add / delete / connect / disconnect / move / resize / config).
//   2. MACHINE WRITES are NOT (a server-minted issueId, a transcript-derived preview line, the
//      debounced viewport save) — undoing "the agent replied" is meaningless, and letting those
//      writes clear the redo stack would destroy a redo the user was about to reach for.
//   3. A CONTINUOUS GESTURE is ONE step, or a single drag buries the stack and ⌘Z rewinds pixel
//      by pixel.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CanvasSurface } from '../src/canvas/CanvasSurface';
import { CANVAS_STORAGE_KEY, createSessionNode, type CanvasDocument } from '../src/canvas/canvasDoc';
import { resetAllSessions } from '../src/canvas/sessions';

class SilentResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function seed(): CanvasDocument {
  const a = { ...createSessionNode('llm', { x: 100, y: 100 }), id: 'a', title: '甲' };
  const b = { ...createSessionNode('coding', { x: 600, y: 100 }), id: 'b', title: '乙' };
  return { version: 2, updatedAt: 1, nodes: [a, b], edges: [], waypoints: [], view: { x: 0, y: 0, scale: 1 } };
}

function storedNodeIds(): string[] {
  const raw = localStorage.getItem(CANVAS_STORAGE_KEY);
  return raw ? (JSON.parse(raw) as CanvasDocument).nodes.map((n) => n.id) : [];
}

function storedNode(id: string) {
  const raw = localStorage.getItem(CANVAS_STORAGE_KEY);
  return raw ? (JSON.parse(raw) as CanvasDocument).nodes.find((n) => n.id === id) : undefined;
}

function deleteTile(id: string) {
  const tile = within(screen.getByTestId(`canvas-tile-${id}`));
  fireEvent.click(tile.getByRole('button', { name: '更多节点操作' }));
  fireEvent.click(tile.getByRole('button', { name: '删除', exact: true }));
}

const mod = { ctrlKey: true, bubbles: true, cancelable: true } as const;

beforeEach(() => {
  cleanup();
  resetAllSessions();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.stubGlobal('ResizeObserver', SilentResizeObserver);
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 503, json: async () => ({}) })));
  localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify(seed()));
});

describe('undo / redo', () => {
  it('brings back a deleted node — and its wires — then removes it again on redo', async () => {
    render(<CanvasSurface />);
    await waitFor(() => expect(screen.getByTestId('canvas-tile-a')).toBeTruthy());

    // Delete via the tile's own action so this covers the real path, not an internal.
    deleteTile('a');
    await waitFor(() => expect(screen.queryByTestId('canvas-tile-a')).toBeNull());
    expect(storedNodeIds()).toEqual(['b']);

    fireEvent.keyDown(document, { key: 'z', code: 'KeyZ', ...mod });
    await waitFor(() => expect(screen.getByTestId('canvas-tile-a')).toBeTruthy());
    expect(storedNodeIds()).toEqual(['a', 'b']);

    fireEvent.keyDown(document, { key: 'z', code: 'KeyZ', shiftKey: true, ...mod });
    await waitFor(() => expect(screen.queryByTestId('canvas-tile-a')).toBeNull());
    expect(storedNodeIds()).toEqual(['b']);
  });

  it('collapses one continuous drag into ONE step', async () => {
    render(<CanvasSurface />);
    const tile = screen.getByTestId('canvas-tile-a');

    fireEvent.pointerDown(tile, { button: 0, clientX: 0, clientY: 0 });
    for (let i = 1; i <= 12; i += 1) {
      fireEvent.pointerMove(window, { clientX: i * 10, clientY: i * 4 });
    }
    fireEvent.pointerUp(window, { clientX: 120, clientY: 48 });

    await waitFor(() => expect(storedNode('a')!.x).not.toBe(100));

    // ONE undo returns to the pre-drag position — not one undo per pointer move.
    fireEvent.keyDown(document, { key: 'z', code: 'KeyZ', ...mod });
    await waitFor(() => expect(storedNode('a')!.x).toBe(100));
    expect(storedNode('a')!.y).toBe(100);
  });

  it('does not treat a machine write as an undo step, and does not let it eat the redo stack', async () => {
    render(<CanvasSurface />);
    deleteTile('a');
    await waitFor(() => expect(storedNodeIds()).toEqual(['b']));

    fireEvent.keyDown(document, { key: 'z', code: 'KeyZ', ...mod });
    await waitFor(() => expect(storedNodeIds()).toEqual(['a', 'b']));

    // A transcript-derived preview write lands (machine, not user). Redo must survive it.
    const { appendTurn } = await import('../src/canvas/sessions');
    appendTurn('a', { role: 'agent', text: '一句真实输出' });
    await waitFor(() => expect(storedNode('a')!.kind === 'session' && storedNode('a')!.preview).toBeTruthy());

    fireEvent.keyDown(document, { key: 'z', code: 'KeyZ', shiftKey: true, ...mod });
    await waitFor(() => expect(storedNodeIds()).toEqual(['b']));
  });

  it('offers undo in the palette, disabled until there is something to undo', async () => {
    render(<CanvasSurface />);
    fireEvent.keyDown(document, { key: 'p', code: 'KeyP', ...mod });
    await waitFor(() => expect(document.querySelector('.canvas-cmdbar-overlay')).toBeTruthy());

    const rowFor = (label: string) =>
      [...document.querySelectorAll('.canvas-cmdbar-row')].find((r) => r.textContent?.startsWith(label));
    expect(rowFor('撤销')?.getAttribute('aria-disabled')).toBe('true');

    fireEvent.keyDown(document, { key: 'Escape', code: 'Escape', bubbles: true });
    deleteTile('a');
    await waitFor(() => expect(storedNodeIds()).toEqual(['b']));

    fireEvent.keyDown(document, { key: 'p', code: 'KeyP', ...mod });
    await waitFor(() => expect(document.querySelector('.canvas-cmdbar-overlay')).toBeTruthy());
    expect(rowFor('撤销')?.getAttribute('aria-disabled')).not.toBe('true');
  });

  it('never lets the browser run its own undo over the canvas', () => {
    render(<CanvasSurface />);
    const e = new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', ctrlKey: true, bubbles: true, cancelable: true });
    document.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
  });
});
