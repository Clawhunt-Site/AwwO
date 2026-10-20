// A tile's last line waits a moment before the canvas writes it (canvas-open-load.test.tsx). A node setup takes no edit
// until it is over, so it takes the waiting lines first, as it did when each line was written as it came.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CanvasSurface } from '../src/canvas/CanvasSurface';
import { CANVAS_STORAGE_KEY, createSessionNode, emptyDocument, loadDocumentWithStatus, type SessionNode } from '../src/canvas/canvasDoc';
import { canvasStorage, configureCanvasStorage } from '../src/canvas/canvasStorage';
import { configureSaaSCanvas, configureSaaSCanvasInitialize, configureSaaSCanvasSave, clearSaaSCanvas } from '../src/saas/canvasBridge';
import { getSnapshot, resetAllSessions } from '../src/canvas/sessions';

const tenant = { id: 'workspace', name: 'Workspace', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 100 };
const reader = async (path: string) => path === '/api/agents' ? { agents: [{ name: 'pi', supports_model_selection: true, supports_node_teams: true }] } : { models: ['profile-main'] };
const quiet = (ms: number) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });
const stored = (id: string) => loadDocumentWithStatus().doc.nodes.find(node => node.id === id) as SessionNode;

let releaseSetup: () => void;
let releaseHistory: () => void;

beforeEach(() => {
  localStorage.clear(); configureCanvasStorage('user', 'workspace', 'canvas'); resetAllSessions();
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: vi.fn(async (_name, _options, callback) => callback({ name: 'owned' })) } });
  configureSaaSCanvas({ tenant, canvasId: 'canvas' }); configureSaaSCanvasSave(async () => 9);
  // 甲 has a stored conversation; 乙 is a draft whose setup the test holds open.
  const a = { ...createSessionNode('llm', { x: 50, y: 50 }), id: 'a', title: '甲', runtime: 'pi', model: 'profile-main',
    binding: { companyId: tenant.id, agentId: 'agent-a', agentName: '甲' }, issueId: 'session-a', preview: 'old' };
  const b = { ...createSessionNode('llm', { x: 600, y: 50 }), id: 'b', title: '乙', persona: 'Draft' };
  canvasStorage().setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...emptyDocument(), nodes: [a, b], view: { x: 0, y: 0, scale: 1 } }));
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = String(input);
    if (/\/sessions\/session-a\/messages$/.test(url)) {
      await new Promise<void>(resolve => { releaseHistory = resolve; });
      return new Response(JSON.stringify({ items: [{ role: 'user', content: '请完成' }, { role: 'assistant', content: '第一行\n甲的最后一行' }] }));
    }
    if (/\/sessions\?/.test(url)) return new Response(JSON.stringify({ items: [{ id: 'session-a', agentId: 'agent-a', title: 'Session 1', createdAt: '2026-10-19T00:00:00Z' }], nextCursor: null }));
    return new Response(JSON.stringify({ items: [], models: [] }));
  }));
  configureSaaSCanvasInitialize(() => new Promise(resolve => { releaseSetup = () => resolve(loadDocumentWithStatus().doc); }));
});
afterEach(() => { cleanup(); clearSaaSCanvas(); resetAllSessions(); configureCanvasStorage('user', 'workspace', 'canvas'); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('writes a tile’s waiting last line before a node setup starts', async () => {
  render(<CanvasSurface storageMode="cloud" runtimeReadJson={reader} />);
  fireEvent.click(screen.getByRole('button', { name: '打开 乙', exact: true }));
  fireEvent.click(screen.getByRole('button', { name: '配置', exact: true }));
  const save = await screen.findByRole('button', { name: /保存配置|保存并准备运行/ });
  await waitFor(() => expect(save).not.toBeDisabled());
  // 甲's history settles (its line waits to be written), and 乙's setup starts at once.
  await waitFor(() => expect(releaseHistory).toBeDefined());
  act(() => releaseHistory());
  await waitFor(() => expect(getSnapshot('a').history).toBe('loaded'), { interval: 5 });
  // The line waits to be written (else this proves nothing).
  expect(stored('a').preview).toBe('old');
  fireEvent.click(save);
  // The setup is still being made: the line went in before it began.
  await waitFor(() => expect(stored('a').preview).toBe('甲的最后一行'));
  act(() => releaseSetup());
  await quiet(300);
  expect(stored('a').preview).toBe('甲的最后一行');
});
