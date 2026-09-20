// The run lock must cover EVERY structural edit, wiring included.
//
// Move / resize / delete / add were all gated on `running`, but connecting and cutting wires were
// not. A run executes a SNAPSHOT of the graph, so a wire cut mid-run changes nothing about what
// is executing — it just leaves the user looking at a graph that no longer matches the timeline
// describing the run. Ports stay VISIBLE while locked (they are the graph's structure, not a
// control); they simply stop accepting input.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CanvasSurface } from '../src/canvas/CanvasSurface';
import { CommandBar } from '../src/canvas/CommandBar';
import * as Workspace from '../src/canvas/AgentWorkspace';
import * as Tiles from '../src/canvas/SessionTile';
import * as Wires from '../src/canvas/WirePlane';
import * as Ports from '../src/canvas/TilePorts';
import * as Commands from '../src/canvas/CommandBar';
import {
  CANVAS_STORAGE_KEY,
  createFormNode,
  createSessionNode,
  type CanvasDocument,
} from '../src/canvas/canvasDoc';
import { getSnapshot, resetAllSessions, setStreaming } from '../src/canvas/sessions';
import { loadRunJournal } from '../src/canvas/runJournal';

// Wrap the memo component in a callable facade so callback-capture spies retain
// the actual renderer without trying to spy on React's memo descriptor object.
vi.mock('../src/canvas/SessionTile', async (importOriginal) => {
 const original = await importOriginal<typeof import('../src/canvas/SessionTile')>();
 return { ...original, SessionTile: (props: Tiles.SessionTileProps) => <original.SessionTile {...props} /> };
});

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
    issueId: 'iss-1',
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
      if (String(input).endsWith('/prepare')) {
        return Promise.resolve({ ok: true, status: 200 });
      }
      if (String(input).includes('/cancel')) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ confirmed: true, cancelled: true, status: 'cancelled' }) });
      }
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

function sentMessages() {
  return vi.mocked(fetch).mock.calls.filter(([input, init]) => String(input).includes('/messages') && init?.method === 'POST');
}

function expectOriginalGraph() {
  expect([...document.querySelectorAll('.canvas-tile[data-testid]')].map(node => node.getAttribute('data-testid')).sort())
    .toEqual(['canvas-tile-f1', 'canvas-tile-s1']);
  expect(JSON.parse(localStorage.getItem(CANVAS_STORAGE_KEY)!).nodes.map((node: { id: string }) => node.id)).toEqual(['f1', 's1']);
}

describe('CanvasSurface run lock', () => {
  it('rejects stale delete, move, resize, config, and wiring callbacks while nodes are waiting', async () => {
    const OriginalTile = Tiles.SessionTile;
    let tile: Tiles.SessionTileProps | undefined;
    vi.spyOn(Tiles, 'SessionTile').mockImplementation(props => {
      if (props.node.id === 'f1') tile ??= props;
      return <OriginalTile {...props} />;
    });
    const originalWiring = Ports.useWiring;
    let connect: Ports.UseWiringOptions['onConnect'];
    vi.spyOn(Ports, 'useWiring').mockImplementation(options => {
      connect ??= options.onConnect;
      return originalWiring(options);
    });
    const OriginalWires = Wires.WirePlane;
    let disconnect: Parameters<typeof OriginalWires>[0]['onDisconnect'];
    vi.spyOn(Wires, 'WirePlane').mockImplementation(props => {
      disconnect ??= props.onDisconnect;
      return <OriginalWires {...props} />;
    });
    const edge = { id: 'f1:data->s1:context', fromNode: 'f1', fromPort: 'data', toNode: 's1', toPort: 'context', dataType: 'text' as const };
    const doc = seed();
    doc.edges = [edge];
    localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify(doc));
    render(<CanvasSurface />);
    fireEvent.pointerDown(screen.getByTestId('canvas-tile-f1'), { button: 0 });
    fireEvent.pointerUp(window);
    fireEvent.keyDown(document, { key: 'p', ctrlKey: true });
    const remove = screen.getByTestId('cmdbar-row-delete');
    expect(remove).not.toHaveAttribute('aria-disabled', 'true');
    act(() => {
      fireEvent.click(screen.getByTestId('cmdbar-row-run'));
      expect(loadRunJournal()?.nodes.s1.state).toBe('waiting');
      fireEvent.click(remove);
      tile!.onMove!('f1', 900, 800);
      tile!.onResizeNode!('f1', 999, 888);
      tile!.onUpdateNode!({ ...tile!.node, title: 'must not change' });
      tile!.onDelete!('f1');
      disconnect!(edge);
      connect!({ nodeId: 's1', portId: 'result' }, { nodeId: 'f1', portId: 'data' }, 'text');
    });
    await waitFor(() => expect(sentMessages()).toHaveLength(1));
    expectOriginalGraph();
    const saved = JSON.parse(localStorage.getItem(CANVAS_STORAGE_KEY)!) as CanvasDocument;
    expect(saved.nodes[0]).toMatchObject({ id: 'f1', title: '需求表单', x: doc.nodes[0].x, y: doc.nodes[0].y, w: doc.nodes[0].w, h: doc.nodes[0].h });
    expect(saved.edges).toEqual([edge]);
    expect(sentMessages()[0][1]?.signal?.aborted).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /停止/ }));
    await waitFor(() => expect(loadRunJournal()).toBeNull());
  });

  it('keeps a non-streaming completed node undeletable until settlement confirms, then persists its output', async () => {
    const OriginalTile = Tiles.SessionTile;
    let remove: Tiles.SessionTileProps['onDelete'];
    vi.spyOn(Tiles, 'SessionTile').mockImplementation(props => {
      if (props.node.id === 's1') remove ??= props.onDelete;
      return <OriginalTile {...props} />;
    });
    let confirm!: (response: unknown) => void;
    const settle = new Promise(resolve => { confirm = resolve; });
    const frames = ['event: accepted\ndata: {"event":"accepted","issueId":"iss-1","runId":"run-1","runVisible":true}\n\n',
      'event: delta\ndata: {"event":"delta","text":"Finished result"}\n\n', 'event: done\ndata: {"event":"done","status":"succeeded"}\n\n'].join('');
    const ordinaryFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((input, init) => {
      if (String(input).endsWith('/settle')) return settle as Promise<Response>;
      if (String(input).endsWith('/messages') && init?.method === 'POST') return Promise.resolve(new Response(frames, { headers: { 'content-type': 'text/event-stream' } }));
      return ordinaryFetch(input, init);
    });
    render(<CanvasSurface />);
    fireEvent.click(screen.getByRole('button', { name: /运行图/ }));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('/settle'))).toBe(true));
    expect(getSnapshot('s1').streaming).toBe(false);
    const acceptedId = loadRunJournal()!.id;
    fireEvent.click(screen.getByRole('button', { name: '定位 LLM 会话', exact: true }));
    fireEvent.keyDown(document, { key: 'p', ctrlKey: true });
    const row = screen.getByTestId('cmdbar-row-delete');
    expect(row).toHaveAttribute('aria-disabled', 'true');
    act(() => { fireEvent.click(row); remove!('s1'); });
    expectOriginalGraph();
    expect(loadRunJournal()?.id).toBe(acceptedId);
    expect(getSnapshot('s1').turns.at(-1)?.text).toBe('Finished result');
    expect(sentMessages()).toHaveLength(1);
    await act(async () => confirm({ ok: true, json: async () => ({ confirmed: true, status: 'succeeded', holdId: 'hold-1' }) }));
    await waitFor(() => expect(loadRunJournal()).toBeNull());
    expect((JSON.parse(localStorage.getItem(CANVAS_STORAGE_KEY)!) as CanvasDocument).nodes[1].lastOutput?.text).toBe('Finished result');
  });

  it('preserves both undo and redo stacks when stale history actions run during acceptance', async () => {
    const OriginalBar = Commands.CommandBar;
    let actions: Commands.CanvasCommandActions | undefined;
    vi.spyOn(Commands, 'CommandBar').mockImplementation(props => {
      actions ??= props.actions;
      return <OriginalBar {...props} />;
    });
    render(<CanvasSurface />);
    for (const [id, dx] of [['f1', 100], ['s1', 80]] as const) {
      fireEvent.pointerDown(screen.getByTestId(`canvas-tile-${id}`), { button: 0, clientX: 0, clientY: 0 });
      fireEvent.pointerMove(window, { clientX: dx, clientY: 0 });
      fireEvent.pointerUp(window, { clientX: dx, clientY: 0 });
    }
    fireEvent.keyDown(document, { key: 'z', ctrlKey: true });
    fireEvent.keyDown(document, { key: 'p', ctrlKey: true });
    expect(actions).toMatchObject({ canUndo: true, canRedo: true });
    act(() => {
      fireEvent.click(screen.getByTestId('cmdbar-row-run'));
      actions!.undo!(); actions!.redo!(); actions!.saveWaypoint!();
    });
    await waitFor(() => expect(sentMessages()).toHaveLength(1));
    const positions = () => (JSON.parse(localStorage.getItem(CANVAS_STORAGE_KEY)!) as CanvasDocument).nodes.map(node => node.x);
    expect(positions()).toEqual([100, 600]);
    expect((JSON.parse(localStorage.getItem(CANVAS_STORAGE_KEY)!) as CanvasDocument).waypoints).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: /停止/ }));
    await waitFor(() => expect(loadRunJournal()).toBeNull());
    act(() => actions!.redo!());
    expect(positions()).toEqual([100, 680]);
    act(() => { actions!.undo!(); actions!.undo!(); });
    expect(positions()).toEqual([0, 600]);
  });

  it.each([{ running: true }, { running: false, canEdit: false }])('disables delete, undo, redo, and waypoint edits for %j', ({ running, canEdit }) => {
    const mutate = vi.fn();
    render(<CommandBar mode="commands" nodes={[]} running={running} selectionCount={1}
      actions={{ canEdit, canUndo: true, canRedo: true, deleteSelection: mutate, undo: mutate, redo: mutate, saveWaypoint: mutate }}
      onFocusNode={vi.fn()} onClose={vi.fn()} />);
    for (const row of screen.getAllByRole('option')) {
      expect(row).toHaveAttribute('aria-disabled', 'true');
      fireEvent.click(row);
    }
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
    expect(mutate).not.toHaveBeenCalled();
  });

  it('rejects an already-open add menu immediately after run acceptance, before the running render', async () => {
    render(<CanvasSurface />);
    fireEvent.contextMenu(document.querySelector('.canvas-viewport')!, { clientX: 40, clientY: 60 });
    const add = within(screen.getByTestId('canvas-add-menu')).getByRole('menuitem', { name: '前端开发' });
    let acceptedId: string | undefined;
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /运行图/ }));
      acceptedId = loadRunJournal()?.id;
      expect(acceptedId).toBeTruthy();
      // This callback still belongs to the idle render. `running` alone cannot guard it.
      fireEvent.click(add);
    });
    await waitFor(() => expect(sentMessages()).toHaveLength(1));
    expectOriginalGraph();
    expect(loadRunJournal()?.id).toBe(acceptedId);
    expect(sentMessages()[0][1]?.signal?.aborted).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /停止/ }));
    await waitFor(() => expect(loadRunJournal()).toBeNull());
  });

  it('disables all session additions when the command palette is opened during a live run', async () => {
    render(<CanvasSurface />);
    fireEvent.click(screen.getByRole('button', { name: /运行图/ }));
    await waitFor(() => expect(sentMessages()).toHaveLength(1));
    const acceptedId = loadRunJournal()!.id;
    fireEvent.keyDown(document, { key: 'p', ctrlKey: true });
    for (const kind of ['llm', 'coding', 'image']) {
      const row = screen.getByTestId(`cmdbar-row-add-session-${kind}`);
      expect(row.getAttribute('aria-disabled')).toBe('true');
      fireEvent.click(row);
    }
    expectOriginalGraph();
    expect(loadRunJournal()?.id).toBe(acceptedId);
    expect(sentMessages()).toHaveLength(1);
    expect(sentMessages()[0][1]?.signal?.aborted).toBe(false);
    fireEvent.click(screen.getByTestId('cmdbar-row-stop'));
    await waitFor(() => expect(loadRunJournal()).toBeNull());
  });

  it('guards a palette action captured before run acceptance without waiting for disabled rows to render', async () => {
    render(<CanvasSurface />);
    fireEvent.keyDown(document, { key: 'p', ctrlKey: true });
    const add = screen.getByTestId('cmdbar-row-add-session-coding');
    act(() => {
      fireEvent.click(screen.getByTestId('cmdbar-row-run'));
      expect(loadRunJournal()).not.toBeNull();
      fireEvent.click(add);
    });
    await waitFor(() => expect(sentMessages()).toHaveLength(1));
    expectOriginalGraph();
    expect(sentMessages()[0][1]?.signal?.aborted).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /停止/ }));
    await waitFor(() => expect(loadRunJournal()).toBeNull());
  });

  it('also guards a full-template callback captured while idle after a run is accepted', async () => {
    const OriginalWorkspace = Workspace.AgentWorkspace;
    let createTemplate: (() => void) | undefined;
    vi.spyOn(Workspace, 'AgentWorkspace').mockImplementation(props => {
      createTemplate ??= props.onCreateTemplate;
      return <OriginalWorkspace {...props} />;
    });
    render(<CanvasSurface />);
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /运行图/ }));
      expect(loadRunJournal()).not.toBeNull();
      createTemplate!();
    });
    await waitFor(() => expect(sentMessages()).toHaveLength(1));
    expectOriginalGraph();
    expect(JSON.parse(localStorage.getItem(CANVAS_STORAGE_KEY)!).edges).toEqual([]);
    expect(sentMessages()[0][1]?.signal?.aborted).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /停止/ }));
    await waitFor(() => expect(loadRunJournal()).toBeNull());
  });

  it('rejects an idle-render menu callback when a session store starts streaming independently', () => {
    render(<CanvasSurface />);
    fireEvent.contextMenu(document.querySelector('.canvas-viewport')!, { clientX: 40, clientY: 60 });
    const add = within(screen.getByTestId('canvas-add-menu')).getByRole('menuitem', { name: '前端开发' });
    act(() => {
      setStreaming('s1', true);
      expect(loadRunJournal()).toBeNull();
      fireEvent.click(add);
    });
    expectOriginalGraph();
    expect(sentMessages()).toHaveLength(0);
    act(() => setStreaming('s1', false));
  });

  it.each([{ running: true }, { running: false, canEdit: false }])('keeps form and session palette additions inert for %j', ({ running, canEdit }) => {
    const addSession = vi.fn();
    const addForm = vi.fn();
    const onClose = vi.fn();
    render(<CommandBar mode="commands" nodes={[]} running={running} actions={{ addSession, addForm, canEdit }} onFocusNode={vi.fn()} onClose={onClose} />);
    for (const row of screen.getAllByRole('option')) {
      expect(row.getAttribute('aria-disabled')).toBe('true');
      fireEvent.click(row);
    }
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
    expect(addSession).not.toHaveBeenCalled();
    expect(addForm).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

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

  it('runs the first click after a drag even before the autosave effect commits', async () => {
    render(<CanvasSurface />);
    const tile = screen.getByTestId('canvas-tile-s1');
    fireEvent.click(within(tile).getByRole('button', { name: /更多节点操作/ }));
    const runNode = within(tile).getByRole('button', { name: /运行节点/ });
    act(() => {
      fireEvent.pointerDown(tile, { button: 0, clientX: 0, clientY: 0 });
      fireEvent.pointerMove(window, { clientX: 120, clientY: 80 });
      fireEvent.pointerUp(window, { clientX: 120, clientY: 80 });
      // Keep the edit and run in one render batch: localStorage still holds the pre-drag doc.
      expect(JSON.parse(localStorage.getItem(CANVAS_STORAGE_KEY)!).nodes.find((node: { id: string }) => node.id === 's1').x).toBe(600);
      fireEvent.click(runNode);
    });
    await waitFor(() => expect(loadRunJournal()?.scope).toEqual(['s1']));
    expect(screen.queryByText(/画布已在其他标签页更新/)).toBeNull();
    expect(JSON.parse(localStorage.getItem(CANVAS_STORAGE_KEY)!).nodes.find((node: { id: string }) => node.id === 's1')).toMatchObject({ x: 720, y: 80 });
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.filter(([input]) => String(input).endsWith('/prepare'))).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: /停止/ }));
    await waitFor(() => expect(loadRunJournal()).toBeNull());
  });

  it('still refuses a pending local edit when another tab actually changed the saved canvas', async () => {
    render(<CanvasSurface />);
    const tile = screen.getByTestId('canvas-tile-s1');
    const external = JSON.parse(localStorage.getItem(CANVAS_STORAGE_KEY)!) as CanvasDocument;
    external.nodes = external.nodes.map(node => node.id === 's1' ? { ...node, title: '另一个标签页的节点', x: 900 } : node);
    act(() => {
      fireEvent.pointerDown(tile, { button: 0, clientX: 0, clientY: 0 });
      fireEvent.pointerMove(window, { clientX: 120, clientY: 80 });
      fireEvent.pointerUp(window, { clientX: 120, clientY: 80 });
      localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify(external));
      fireEvent.click(screen.getByRole('button', { name: /运行图/ }));
    });
    expect(await screen.findByText(/画布已在其他标签页更新/)).toBeTruthy();
    expect(loadRunJournal()).toBeNull();
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).endsWith('/prepare') || String(input).includes('/messages'))).toBe(false);
    expect(JSON.parse(localStorage.getItem(CANVAS_STORAGE_KEY)!).nodes.find((node: { id: string }) => node.id === 's1')).toMatchObject({ title: '另一个标签页的节点', x: 900 });
  });
});
