import { StrictMode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CanvasSurface } from '../src/canvas/CanvasSurface';
import { CANVAS_STORAGE_KEY, emptyDocument, loadDocumentWithStatus } from '../src/canvas/canvasDoc';
import { canvasStorage, configureCanvasStorage } from '../src/canvas/canvasStorage';
import { configureSaaSCanvas, clearSaaSCanvas } from '../src/saas/canvasBridge';
import { resetAllSessions } from '../src/canvas/sessions';

const tenant = { id: 'workspace', name: 'Workspace', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 100 };
const agent = { id: 'shared-agent', tenantId: tenant.id, name: 'QA Analyst', runtime: 'pi', model: 'qa-pi', effort: '', instructions: 'Synthetic role', status: 'active' };
const reader = async (path: string) => path === '/api/agents'
  ? { agents: [{ name: 'pi', supports_model_selection: true, supports_node_teams: true }] }
  : { models: ['qa-pi'] };

beforeEach(() => {
  localStorage.clear(); resetAllSessions(); configureCanvasStorage('user', tenant.id, 'canvas');
  configureSaaSCanvas({ tenant, canvasId: 'canvas' });
  canvasStorage().setItem(CANVAS_STORAGE_KEY, JSON.stringify(emptyDocument()));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [agent] }))));
});
afterEach(() => { cleanup(); clearSaaSCanvas(); resetAllSessions(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function addWorkspaceAgent() {
  fireEvent.click(screen.getByRole('button', { name: '添加 Bot', exact: true }));
  fireEvent.click(await screen.findByRole('button', { name: '选择 QA Analyst' }));
  fireEvent.click(screen.getByRole('button', { name: '添加所选 Agent' }));
}

it('adds one node per explicit workspace selection under StrictMode, with distinct nodes for repeated selections', async () => {
  const errors = vi.spyOn(console, 'error');
  render(<StrictMode><CanvasSurface storageMode="cloud" runtimeReadJson={reader} /></StrictMode>);
  await addWorkspaceAgent();
  await waitFor(() => expect(loadDocumentWithStatus().doc.nodes).toHaveLength(1));
  const first = loadDocumentWithStatus().doc.nodes[0];
  expect(first).toMatchObject({ agentRef: { source: 'workspace', agentId: agent.id }, binding: null, issueId: null });
  // The new node opens focused without an auto-opened inspector; configuration stays a tile action.
  expect(screen.queryByRole('dialog', { name: /节点配置/ })).toBeNull();
  expect(screen.getByTestId(`canvas-tile-${first.id}`).dataset.lod).toBe('focus');
  await addWorkspaceAgent();
  await waitFor(() => expect(loadDocumentWithStatus().doc.nodes).toHaveLength(2));
  const nodes = loadDocumentWithStatus().doc.nodes;
  expect(new Set(nodes.map(node => node.id)).size).toBe(2);
  expect(nodes[0].id).toBe(first.id);
  expect(errors.mock.calls.filter(call => String(call[0]).includes('same key'))).toEqual([]);
});

it('adds a market role once under StrictMode without shared Agent identity or duplicate keys', async () => {
  const errors = vi.spyOn(console, 'error');
  render(<StrictMode><CanvasSurface storageMode="cloud" runtimeReadJson={reader} /></StrictMode>);
  fireEvent.click(screen.getByRole('button', { name: '添加 Bot', exact: true }));
  fireEvent.click(screen.getByRole('button', { name: '团队市场角色' }));
  fireEvent.click(screen.getByRole('button', { name: '选择 Content Lead · Content Machine' }));
  fireEvent.click(screen.getByRole('button', { name: '添加所选角色' }));
  await waitFor(() => expect(loadDocumentWithStatus().doc.nodes).toHaveLength(1));
  expect(loadDocumentWithStatus().doc.nodes[0]).toMatchObject({ title: 'Content Lead · Content Machine', binding: null, issueId: null });
  expect(loadDocumentWithStatus().doc.nodes[0]).not.toHaveProperty('agentRef');
  expect(screen.queryByRole('dialog', { name: /节点配置/ })).toBeNull();
  expect(errors.mock.calls.filter(call => String(call[0]).includes('same key'))).toEqual([]);
});
