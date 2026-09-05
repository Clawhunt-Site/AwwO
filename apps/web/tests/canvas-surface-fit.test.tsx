// CanvasSurface viewport-fit fallback.
//
// The fit math needs the viewport's pixel size. That size normally arrives from the viewport's own
// mount measurement plus a ResizeObserver — but BOTH can still report 0 when a fit is requested:
// the mount measure runs before layout settles, and RO callbacks are delivered on frame
// boundaries, which stall in a backgrounded / non-compositing tab (observed live: 焦点 and 适应全部
// became silent no-ops, with nothing on screen to explain why).
//
// So focus/fit must fall back to a live measurement of the canvas root rather than doing nothing.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CanvasSurface } from '../src/canvas/CanvasSurface';
import { CANVAS_STORAGE_KEY, createSessionNode, type CanvasDocument } from '../src/canvas/canvasDoc';
import { resetAllSessions } from '../src/canvas/sessions';

/** A ResizeObserver that never delivers — the exact condition that stranded focus/fit. */
class SilentResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function seed(): CanvasDocument {
  const n = { ...createSessionNode('llm', { x: 900, y: 700 }), id: 's1', title: 'LLM 会话' };
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

beforeEach(() => {
  cleanup();
  resetAllSessions();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.stubGlobal('ResizeObserver', SilentResizeObserver);
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 503, json: async () => ({}) })));
  localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify(seed()));
});

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
