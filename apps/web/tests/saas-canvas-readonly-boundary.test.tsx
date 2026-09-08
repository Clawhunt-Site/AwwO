import type { AgentWorkspaceProps } from '../src/canvas/AgentWorkspace';
import type { SessionTileProps } from '../src/canvas/SessionTile';
import type { RunControlsProps } from '../src/canvas/RunControls';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { CanvasSurface } from '../src/canvas/CanvasSurface';
import { CANVAS_STORAGE_KEY, createSessionNode, type CanvasDocument } from '../src/canvas/canvasDoc';
import { resetAllSessions } from '../src/canvas/sessions';

const boundary = vi.hoisted(() => ({ workspace: null as AgentWorkspaceProps | null, tile: null as SessionTileProps | null, run: null as RunControlsProps | null }));
// Capture callbacks handed to children, including those retained across a permission change.
// These deliberately bypass disabled DOM buttons to verify the owning mutation boundary.
vi.mock('../src/canvas/SessionTile', () => ({ SessionTile: (props: SessionTileProps) => { boundary.tile = props; return null; } }));
vi.mock('../src/canvas/AgentWorkspace', () => ({ AgentWorkspace: (props: AgentWorkspaceProps) => { boundary.workspace = props; return <>{props.toolbar}{props.children}</>; } }));
vi.mock('../src/canvas/RunControls', () => ({ RunControls: (props: RunControlsProps) => { boundary.run = props; return null; } }));
class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
beforeEach(() => {
  cleanup(); resetAllSessions(); localStorage.clear(); vi.restoreAllMocks();
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ companies: [], available: false }) })));
  const node = { ...createSessionNode('llm', { x: 10, y: 20 }), id: 'node', title: 'Editable node', binding: { companyId: 'c', agentId: 'a', agentName: 'Agent' } };
  const doc: CanvasDocument = { version: 2, updatedAt: 1, nodes: [node], edges: [], waypoints: [], view: { x: 0, y: 0, scale: 1 } };
  localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify(doc));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('rejects retained editor callbacks after readOnly changes, before ownership or side effects', async () => {
  const { rerender } = render(<CanvasSurface />);
  const oldTile = boundary.tile!; const oldWorkspace = boundary.workspace!; const oldRun = boundary.run!;
  expect(oldTile.onUpdateNode).toBeTypeOf('function');
  rerender(<CanvasSurface readOnly />);
  const before = localStorage.getItem(CANVAS_STORAGE_KEY);
  const write = vi.spyOn(localStorage, 'setItem'); const remove = vi.spyOn(localStorage, 'removeItem');
  const fetch = vi.mocked(globalThis.fetch); fetch.mockClear();
  const locks = vi.spyOn(navigator.locks, 'request'); const accepted = vi.fn();
  await act(async () => {
    oldWorkspace.onAddAgent('general'); oldWorkspace.onCreateTemplate();
    oldTile.onMove?.('node', 100, 200); oldTile.onResizeNode?.('node', 900, 600);
    oldTile.onUpdateNode?.({ ...oldTile.node, title: 'forbidden' });
    oldTile.onDraftChange?.('node', 'default', 'forbidden draft');
    oldTile.onPreview?.('node', 'forbidden preview', 'default');
    oldTile.onToggleDeliverables?.('node', true);
    oldTile.onIssueId?.('node', 'forbidden-session-id', 'default');
    oldTile.onDelete?.('node'); oldTile.onRunNode?.('node');
    if (oldTile.node.kind === 'session') oldTile.onSend?.(oldTile.node, 'forbidden run', accepted);
    oldRun.onStart(); oldRun.onStop();
    await Promise.resolve();
  });
  expect(localStorage.getItem(CANVAS_STORAGE_KEY)).toBe(before);
  expect(boundary.workspace?.nodes).toHaveLength(1);
  expect(write).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled(); expect(locks).not.toHaveBeenCalled(); expect(accepted).not.toHaveBeenCalled();
});
