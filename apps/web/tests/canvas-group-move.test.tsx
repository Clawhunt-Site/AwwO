// MULTI-SELECT + GROUP MOVE.
//
// Selecting several nodes was possible (marquee), but useless: pressing any member collapsed the
// selection to that one node before the drag began, and the move callback moved a single node
// anyway. So an arrangement could be selected and never moved — one of the most basic gestures a
// canvas has, and one you notice the absence of immediately.
//
// The behaviour being pinned is the one every canvas tool shares:
//   press a selected node  → the group survives, and the whole group translates rigidly
//   click a selected node  → collapse to just that node (a click is not a drag)
//   shift-click            → toggle a node in or out of the group
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CanvasSurface } from '../src/canvas/CanvasSurface';
import { CANVAS_STORAGE_KEY, createSessionNode, type CanvasDocument } from '../src/canvas/canvasDoc';
import { resetAllSessions } from '../src/canvas/sessions';

class SilentResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function seed(): CanvasDocument {
  return {
    version: 2,
    updatedAt: 1,
    nodes: [
      { ...createSessionNode('llm', { x: 100, y: 100 }), id: 'a', title: '甲' },
      { ...createSessionNode('coding', { x: 500, y: 100 }), id: 'b', title: '乙' },
      { ...createSessionNode('llm', { x: 900, y: 100 }), id: 'c', title: '丙' },
    ],
    edges: [],
    waypoints: [],
    view: { x: 0, y: 0, scale: 1 },
  };
}

function pos(id: string): { x: number; y: number } {
  const doc = JSON.parse(localStorage.getItem(CANVAS_STORAGE_KEY)!) as CanvasDocument;
  const n = doc.nodes.find((x) => x.id === id)!;
  return { x: n.x, y: n.y };
}

function selected(): string[] {
  return [...document.querySelectorAll('.canvas-tile--selected')].map((t) => (t as HTMLElement).dataset.nodeId!);
}

function drag(tileId: string, dx: number, dy: number): void {
  const tile = screen.getByTestId(`canvas-tile-${tileId}`);
  fireEvent.pointerDown(tile, { button: 0, clientX: 0, clientY: 0 });
  fireEvent.pointerMove(window, { clientX: dx / 2, clientY: dy / 2 });
  fireEvent.pointerMove(window, { clientX: dx, clientY: dy });
  fireEvent.pointerUp(window, { clientX: dx, clientY: dy });
}

beforeEach(() => {
  cleanup();
  resetAllSessions();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.stubGlobal('ResizeObserver', SilentResizeObserver);
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 503, json: async () => ({}) })));
  localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify(seed()));
});

describe('selection', () => {
  it('shift-click adds to the group and shift-click again removes', async () => {
    render(<CanvasSurface />);
    fireEvent.pointerDown(screen.getByTestId('canvas-tile-a'), { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerUp(window, { clientX: 0, clientY: 0 });
    await waitFor(() => expect(selected()).toEqual(['a']));

    fireEvent.pointerDown(screen.getByTestId('canvas-tile-b'), { button: 0, shiftKey: true, clientX: 0, clientY: 0 });
    fireEvent.pointerUp(window, { clientX: 0, clientY: 0 });
    await waitFor(() => expect(selected().sort()).toEqual(['a', 'b']));

    fireEvent.pointerDown(screen.getByTestId('canvas-tile-b'), { button: 0, shiftKey: true, clientX: 0, clientY: 0 });
    fireEvent.pointerUp(window, { clientX: 0, clientY: 0 });
    await waitFor(() => expect(selected()).toEqual(['a']));
  });

  it('a CLICK on a member of a group collapses the selection to it', async () => {
    render(<CanvasSurface />);
    fireEvent.pointerDown(screen.getByTestId('canvas-tile-a'), { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerUp(window, { clientX: 0, clientY: 0 });
    fireEvent.pointerDown(screen.getByTestId('canvas-tile-b'), { button: 0, shiftKey: true, clientX: 0, clientY: 0 });
    fireEvent.pointerUp(window, { clientX: 0, clientY: 0 });
    await waitFor(() => expect(selected().sort()).toEqual(['a', 'b']));

    // Press and release without travelling: that is a click, not a drag.
    fireEvent.pointerDown(screen.getByTestId('canvas-tile-a'), { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(window, { clientX: 10, clientY: 10 });
    await waitFor(() => expect(selected()).toEqual(['a']));
  });
});

describe('group move', () => {
  it('translates the WHOLE selection rigidly', async () => {
    render(<CanvasSurface />);
    fireEvent.pointerDown(screen.getByTestId('canvas-tile-a'), { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerUp(window, { clientX: 0, clientY: 0 });
    fireEvent.pointerDown(screen.getByTestId('canvas-tile-b'), { button: 0, shiftKey: true, clientX: 0, clientY: 0 });
    fireEvent.pointerUp(window, { clientX: 0, clientY: 0 });
    await waitFor(() => expect(selected().sort()).toEqual(['a', 'b']));

    drag('a', 60, 40);

    await waitFor(() => expect(pos('a')).toEqual({ x: 160, y: 140 }));
    expect(pos('b')).toEqual({ x: 560, y: 140 }); // moved by the same delta
    expect(pos('c')).toEqual({ x: 900, y: 100 }); // untouched: not in the selection
  });

  it('the whole group move is ONE undo step', async () => {
    render(<CanvasSurface />);
    fireEvent.pointerDown(screen.getByTestId('canvas-tile-a'), { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerUp(window, { clientX: 0, clientY: 0 });
    fireEvent.pointerDown(screen.getByTestId('canvas-tile-b'), { button: 0, shiftKey: true, clientX: 0, clientY: 0 });
    fireEvent.pointerUp(window, { clientX: 0, clientY: 0 });

    drag('a', 60, 40);
    await waitFor(() => expect(pos('a')).toEqual({ x: 160, y: 140 }));

    fireEvent.keyDown(document, { key: 'z', code: 'KeyZ', ctrlKey: true, bubbles: true, cancelable: true });
    await waitFor(() => expect(pos('a')).toEqual({ x: 100, y: 100 }));
    expect(pos('b')).toEqual({ x: 500, y: 100 });
  });

  it('dragging an UNSELECTED node moves only that node', async () => {
    render(<CanvasSurface />);
    fireEvent.pointerDown(screen.getByTestId('canvas-tile-a'), { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerUp(window, { clientX: 0, clientY: 0 });
    fireEvent.pointerDown(screen.getByTestId('canvas-tile-b'), { button: 0, shiftKey: true, clientX: 0, clientY: 0 });
    fireEvent.pointerUp(window, { clientX: 0, clientY: 0 });

    drag('c', 30, 30); // c is not in the group — pressing it replaces the selection

    await waitFor(() => expect(pos('c')).toEqual({ x: 930, y: 130 }));
    expect(pos('a')).toEqual({ x: 100, y: 100 });
    expect(pos('b')).toEqual({ x: 500, y: 100 });
  });

  it('a press that never travels does not move anything', async () => {
    render(<CanvasSurface />);
    const tile = screen.getByTestId('canvas-tile-a');
    fireEvent.pointerDown(tile, { button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(window, { clientX: 2, clientY: 1 }); // under the drag threshold
    fireEvent.pointerUp(window, { clientX: 2, clientY: 1 });
    await waitFor(() => expect(selected()).toEqual(['a']));
    expect(pos('a')).toEqual({ x: 100, y: 100 });
  });
});
