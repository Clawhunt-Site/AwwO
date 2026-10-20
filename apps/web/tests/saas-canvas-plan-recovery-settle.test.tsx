// A hosted canvas reads its planning recovery (an earlier plan it can still resume) for the document it holds. A drag
// changes the document on every frame: the recovery is read once the document settles, not on every frame (each read,
// started from the effects of a frame's commit, set state React counted as nested: error #185 in a long drag on a slow
// machine), and until it has been read for this document nothing may resume what was read for another one.
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CanvasSurface } from '../src/canvas/CanvasSurface';
import { createSessionNode, emptyDocument, loadDocumentWithStatus, saveDocument, type SessionNode } from '../src/canvas/canvasDoc';
import { canvasPlanRevision } from '../src/canvas/canvasPlan';
import { readCanvasPlanRecovery } from '../src/canvas/canvasPlanning';
import { canvasStorageKey, configureCanvasStorage } from '../src/canvas/canvasStorage';
import { getSnapshot, resetAllSessions } from '../src/canvas/sessions';
import { clearSaaSCanvas, configureSaaSCanvas, configureSaaSCanvasSave } from '../src/saas/canvasBridge';

vi.mock('../src/canvas/canvasPlanning', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/canvas/canvasPlanning')>();
  return { ...actual, readCanvasPlanRecovery: vi.fn(actual.readCanvasPlanRecovery) };
});

const tenant = { id: 'tenant-a', name: 'Workspace A', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 100 };
const ready = { available: true, configured: true, plannerAvailable: true, plannerRuntime: 'pi', models: [{ id: 'fixture-model' }] };
const reply = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const quiet = (ms: number) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });
const reads = () => vi.mocked(readCanvasPlanRecovery).mock.calls;

beforeEach(() => {
  cleanup(); resetAllSessions(); localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh');
  configureCanvasStorage('user-a', tenant.id, 'canvas-a');
  configureSaaSCanvas({ tenant, canvasId: 'canvas-a' }); configureSaaSCanvasSave(async () => 2);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => String(input).endsWith('/runtime') ? reply(ready) : reply({ items: [], models: [] })));
  vi.mocked(readCanvasPlanRecovery).mockClear();
  const node: SessionNode = { ...createSessionNode('llm', { x: 0, y: 0 }), id: 'a', title: '甲' };
  saveDocument({ ...emptyDocument(), nodes: [node], view: { x: 0, y: 0, scale: 1 } });
  // A plan this page started for this very document and did not receive: it can be resumed.
  plannedFor(canvasPlanRevision(loadDocumentWithStatus().doc));
});

/** The page's planning recovery: a plan it asked for, for the document of this revision, and did not receive. */
function plannedFor(revision: string) {
  localStorage.setItem(canvasStorageKey(`awwo.canvas.planning.run.v1:${encodeURIComponent(tenant.id)}:canvas-a`), JSON.stringify({
    version: 1, tenantId: tenant.id, canvasId: 'canvas-a', operationId: 'operation-a', prompt: '加一个节点', revision, knowledgeRevisionIds: [],
  }));
}
afterEach(() => { cleanup(); clearSaaSCanvas(); configureSaaSCanvasSave(null); vi.unstubAllGlobals(); });

it('reads the recovery once a drag settles, and lets nothing resume what was read for the document before it', async () => {
  render(<CanvasSurface storageMode="cloud" />);
  const resume = await screen.findByRole('button', { name: '继续接收这次规划' });
  await waitFor(() => expect(resume).toBeEnabled());
  const before = reads().length;
  fireEvent.pointerDown(screen.getByTestId('canvas-tile-a'), { button: 0, clientX: 0, clientY: 0 });
  for (let step = 1; step <= 6; step += 1) fireEvent.pointerMove(window, { clientX: step * 10, clientY: 0 });
  fireEvent.pointerUp(window, { clientX: 60, clientY: 0 });
  // The document moved on: what was read for the one before it cannot be resumed, and nothing was read on the way.
  expect(screen.getByRole('button', { name: '继续接收这次规划' })).toBeDisabled();
  expect(reads().length).toBe(before);
  const moved = canvasPlanRevision(loadDocumentWithStatus().doc);
  expect((loadDocumentWithStatus().doc.nodes[0] as SessionNode).x).toBe(60);
  // Had the plan been asked for the moved document, the read once the drag settles lets it be resumed again.
  plannedFor(moved);
  await quiet(700);
  expect(reads().length).toBe(before + 1);
  expect(reads().at(-1)?.[2]).toBe(moved);
  expect(screen.getByRole('button', { name: '继续接收这次规划' })).toBeEnabled();
});

it('does not resume for a document that a tile’s waiting last line has just changed', async () => {
  // 乙 is bound, and its stored conversation is about to settle with a line its document does not have yet.
  const b: SessionNode = { ...createSessionNode('llm', { x: 0, y: 0 }), id: 'b', title: '乙', runtime: 'pi', model: 'profile-main',
    binding: { companyId: tenant.id, agentId: 'agent-b', agentName: '乙' }, issueId: 'session-b', preview: 'old' };
  saveDocument({ ...emptyDocument(), nodes: [b], view: { x: 0, y: 0, scale: 1 } });
  plannedFor(canvasPlanRevision(loadDocumentWithStatus().doc));
  let release!: () => void;
  const settled = new Promise<void>(resolve => { release = resolve; });
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = String(input);
    if (/\/sessions\/session-b\/messages$/.test(url)) {
      await settled;
      return reply({ items: [{ role: 'user', content: '请完成' }, { role: 'assistant', content: '第一行\n乙的最后一行' }] });
    }
    if (/\/sessions\?/.test(url)) return reply({ items: [{ id: 'session-b', agentId: 'agent-b', title: 'Session 1', createdAt: '2026-10-19T00:00:00Z' }], nextCursor: null });
    return url.endsWith('/runtime') ? reply(ready) : reply({ items: [], models: [] });
  }));
  const planRequest = vi.fn<NonNullable<ComponentProps<typeof CanvasSurface>['planRequest']>>(() => new Promise(() => {}));
  const reader = async (path: string) => path === '/api/agents' ? { agents: [{ name: 'pi', supports_model_selection: true }] } : { models: ['profile-main'] };
  render(<CanvasSurface storageMode="cloud" runtimeReadJson={reader} planRequest={planRequest} />);
  const resume = await screen.findByRole('button', { name: '继续接收这次规划' });
  await waitFor(() => expect(resume).toBeEnabled());
  act(() => release());
  await waitFor(() => expect(getSnapshot('b').history).toBe('loaded'), { interval: 5 });
  // The line waits to be written (else this proves nothing).
  expect((loadDocumentWithStatus().doc.nodes[0] as SessionNode).preview).toBe('old');
  fireEvent.click(resume);
  // The line went in first and made another document: nothing was asked for, and the plan waits for its recovery.
  expect((loadDocumentWithStatus().doc.nodes[0] as SessionNode).preview).toBe('乙的最后一行');
  expect(planRequest).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: '继续接收这次规划' })).toBeDisabled();
});
