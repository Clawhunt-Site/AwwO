// Running one component never holds the rest of the canvas: a second component runs in its own lane beside it, a
// third node stays editable, the same node cannot run twice, a whole-canvas run waits for the lanes, and stopping one
// node stops only its own lane.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CanvasSurface } from '../src/canvas/CanvasSurface';
import * as Tiles from '../src/canvas/SessionTile';
import { CANVAS_STORAGE_KEY, createFormNode, createSessionNode, type CanvasDocument } from '../src/canvas/canvasDoc';
import { resetAllSessions } from '../src/canvas/sessions';
import { loadRunJournal } from '../src/canvas/runJournal';
import { laneStorage, laneJournalKey } from '../src/canvas/runLanes';

vi.mock('../src/canvas/SessionTile', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/canvas/SessionTile')>();
  return { ...original, SessionTile: (props: Tiles.SessionTileProps) => <original.SessionTile {...props} /> };
});

class SilentResizeObserver { observe() {} unobserve() {} disconnect() {} }

function session(id: string, x: number, agentId: string) {
  return { ...createSessionNode('llm', { x, y: 0 }), id, title: `节点 ${id}`, runtime: 'claude_local',
    binding: { companyId: 'c1', agentId, agentName: id }, issueId: `iss-${id}` };
}
function seed(): CanvasDocument {
  const form = { ...createFormNode({ x: 0, y: 400 }), id: 'f1', title: '需求表单' };
  return { version: 2, updatedAt: 1, nodes: [session('s1', 0, 'a1'), session('s2', 600, 'a2'), form], edges: [], waypoints: [], view: { x: 0, y: 0, scale: 1 } };
}

beforeEach(() => {
  cleanup();
  resetAllSessions();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.stubGlobal('ResizeObserver', SilentResizeObserver);
  // Each conversation POST stays open until its run is stopped, then rejects like a real aborted fetch.
  vi.stubGlobal('fetch', vi.fn((input: unknown, init?: { signal?: AbortSignal }) => {
    if (String(input).endsWith('/prepare')) return Promise.resolve({ ok: true, status: 200 });
    if (String(input).includes('/cancel')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ confirmed: true, cancelled: true, status: 'cancelled' }) });
    if (!String(input).includes('/messages')) return Promise.resolve({ ok: false, status: 503, json: async () => ({}) });
    return new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      if (signal.aborted) fail(); else signal.addEventListener('abort', fail, { once: true });
    });
  }));
  localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify(seed()));
});

const sent = () => vi.mocked(fetch).mock.calls.filter(([input, init]) => String(input).includes('/messages') && init?.method === 'POST');
const laneJournal = (lane: number) => loadRunJournal(laneStorage(lane));

describe('CanvasSurface run lanes', () => {
  it('runs two components side by side and keeps the rest of the canvas editable', async () => {
    const OriginalTile = Tiles.SessionTile;
    const tiles: Record<string, Tiles.SessionTileProps> = {};
    vi.spyOn(Tiles, 'SessionTile').mockImplementation(props => {
      tiles[props.node.id] = props;
      return <OriginalTile {...props} />;
    });
    render(<CanvasSurface />);
    const runS1 = tiles.s1.onRunNode!;
    act(() => { runS1('s1'); });
    await waitFor(() => expect(sent()).toHaveLength(1));
    expect(laneJournal(0)?.scope).toEqual(['s1']);
    // The card no longer offers to run a running node.
    expect(tiles.s1.onRunNode).toBeUndefined();

    // s2 is a different component: it starts at once, in its own lane, while s1 is still working.
    act(() => { tiles.s2.onRunNode!('s2'); });
    await waitFor(() => expect(sent()).toHaveLength(2));
    expect(laneJournal(1)?.scope).toEqual(['s2']);
    expect(localStorage.getItem(laneJournalKey(1))).not.toBeNull();
    // The run chip says how many components run side by side.
    expect(await screen.findByText(/2 个组件运行中/)).toBeTruthy();

    // The same component cannot run twice, even through a callback captured before it started.
    act(() => { runS1('s1'); });
    expect(await screen.findByText(/这个组件已经在运行了/)).toBeTruthy();
    expect(laneJournal(2)).toBeNull();

    // A node no lane runs stays editable: its title changes while both components work.
    act(() => { tiles.f1.onUpdateNode!({ ...tiles.f1.node, title: '一边运行一边改' }); });
    await waitFor(() => expect((JSON.parse(localStorage.getItem(CANVAS_STORAGE_KEY)!) as CanvasDocument).nodes.find(node => node.id === 'f1')?.title).toBe('一边运行一边改'));
    // A running node's configuration is not.
    act(() => { tiles.s2.onUpdateNode?.({ ...tiles.s2.node, title: 'must not change' }); });
    expect((JSON.parse(localStorage.getItem(CANVAS_STORAGE_KEY)!) as CanvasDocument).nodes.find(node => node.id === 's2')?.title).toBe('节点 s2');

    // Stopping s1 stops its lane only.
    await waitFor(() => expect(screen.getAllByRole('button', { name: '停下这个组件' }).length).toBeGreaterThan(0));
    act(() => { tiles.s1.onStopNode!('s1'); });
    await waitFor(() => expect(laneJournal(0)).toBeNull());
    expect(laneJournal(1)?.scope).toEqual(['s2']);
    expect(sent()[1][1]?.signal?.aborted).toBe(false);
    act(() => { tiles.s2.onStopNode!('s2'); });
    await waitFor(() => expect(laneJournal(1)).toBeNull());
  });

  it('holds a whole-canvas run while a component runs, and runs it once the lanes are free', async () => {
    const OriginalTile = Tiles.SessionTile;
    const tiles: Record<string, Tiles.SessionTileProps> = {};
    vi.spyOn(Tiles, 'SessionTile').mockImplementation(props => {
      tiles[props.node.id] = props;
      return <OriginalTile {...props} />;
    });
    render(<CanvasSurface />);
    act(() => { tiles.s1.onRunNode!('s1'); });
    await waitFor(() => expect(sent()).toHaveLength(1));
    // While a component runs the toolbar offers Stop, not a whole-canvas run beside it.
    expect((document.querySelector('.canvas-run-btn') as HTMLElement).textContent).toMatch(/停止/);
    expect(laneJournal(1)).toBeNull();
    act(() => { tiles.s1.onStopNode!('s1'); });
    await waitFor(() => expect(laneJournal(0)).toBeNull());
    await waitFor(() => expect((document.querySelector('.canvas-run-btn') as HTMLElement).textContent).toMatch(/运行图/));
    fireEvent.click(document.querySelector('.canvas-run-btn') as HTMLElement);
    await waitFor(() => expect(laneJournal(0)?.scope.sort()).toEqual(['f1', 's1', 's2']));
    fireEvent.click(document.querySelector('.canvas-run-btn') as HTMLElement);
    await waitFor(() => expect(laneJournal(0)).toBeNull());
  });
});
