// The run lock must cover EVERY structural edit, wiring included.
//
// Move / resize / delete / add were all gated on `running`, but connecting and cutting wires were
// not. A run executes a SNAPSHOT of the graph, so a wire cut mid-run changes nothing about what
// is executing — it just leaves the user looking at a graph that no longer matches the timeline
// describing the run. Ports stay VISIBLE while locked (they are the graph's structure, not a
// control); they simply stop accepting input.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CanvasSurface } from '../src/canvas/CanvasSurface';
import {
  CANVAS_STORAGE_KEY,
  createFormNode,
  createSessionNode,
  type CanvasDocument,
} from '../src/canvas/canvasDoc';
import { resetAllSessions } from '../src/canvas/sessions';

class SilentResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

/** A bound session node + a form node — enough to pass preflight and start a real run. */
function seed(): CanvasDocument {
  const form = { ...createFormNode({ x: 0, y: 0 }), id: 'f1', title: '需求表单' };
  const agent = {
    ...createSessionNode('llm', { x: 600, y: 0 }),
    id: 's1',
    title: 'LLM 会话',
    runtime: 'claude_local',
    binding: { companyId: 'c1', agentId: 'a1', agentName: '策划' },
  };
  return { version: 2, updatedAt: 1, nodes: [form, agent], edges: [], waypoints: [], view: { x: 0, y: 0, scale: 1 } };
}

beforeEach(() => {
  cleanup();
  resetAllSessions();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.stubGlobal('ResizeObserver', SilentResizeObserver);
  // The SSE POST stays open for the duration of the assertions, and — like a real fetch —
  // REJECTS when the abort signal fires, so pressing 停止 actually ends the run.
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown, init?: { signal?: AbortSignal }) => {
      if (!String(input).includes('/messages')) {
        return Promise.resolve({ ok: false, status: 503, json: async () => ({}) });
      }
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        if (signal.aborted) fail();
        else signal.addEventListener('abort', fail, { once: true });
      });
    }),
  );
  localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify(seed()));
});

function ports(): HTMLButtonElement[] {
  return [...document.querySelectorAll('.canvas-port')] as HTMLButtonElement[];
}

describe('CanvasSurface run lock', () => {
  it('ports accept wiring before a run', () => {
    render(<CanvasSurface />);
    const all = ports();
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((p) => !p.disabled)).toBe(true);
  });

  it('freezes wiring while a run is in flight, without hiding the graph structure', async () => {
    render(<CanvasSurface />);

    fireEvent.click(screen.getByRole('button', { name: /运行图/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: /停止/ })).toBeTruthy());

    const all = ports();
    // Still rendered — the wires and their endpoints stay readable during the run.
    expect(all.length).toBeGreaterThan(0);
    // ...but inert, exactly like move / resize / delete.
    expect(all.every((p) => p.disabled)).toBe(true);
  });

  it('restores wiring once the run is stopped', async () => {
    render(<CanvasSurface />);
    fireEvent.click(screen.getByRole('button', { name: /运行图/ }));
    await waitFor(() => expect(ports().every((p) => p.disabled)).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: /停止/ }));
    await waitFor(() => expect(ports().every((p) => !p.disabled)).toBe(true));
  });
});
