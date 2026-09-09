import { afterEach, describe, expect, it, vi } from 'vitest';
import { canvasStorage, configureCanvasStorage } from '../src/canvas/canvasStorage';
import { CANVAS_RUN_JOURNAL_KEY, clearRunJournal, journalSummary, loadRunJournal, reconcileRunJournal, saveRunJournal, type CanvasRunJournal } from '../src/canvas/runJournal';
import { clearSaaSCanvas } from '../src/saas/canvasBridge';

const journal = (id: string): CanvasRunJournal => ({ version: 1, id, startedAt: 1000, scope: ['node'],
  nodes: { node: { nodeId: 'node', threadId: 'thread', companyId: 'tenant', agentId: 'agent', issueId: 'session', runId: 'run', operationId: 'operation', state: 'waiting' } } });
const cloud = (): CanvasRunJournal => ({ ...journal('cloud-operation'), serverGraph: { id: 'graph', tenantId: 'tenant', canvasId: 'canvas' } });
const review = (): CanvasRunJournal => ({ ...journal('review-operation'), review: { round: 2, maxRounds: 3, outcome: 'exhausted', turns: [
  { ...journal('unused').nodes.node, round: 1, state: 'done', output: 'First candidate' },
] } });
afterEach(() => { clearSaaSCanvas(); vi.unstubAllGlobals(); localStorage.clear(); });

describe('online Review journals coexist with cloud recovery', () => {
  it('round-trips Review evidence and cloud identity in separate namespaces without stale clearing', () => {
    configureCanvasStorage('alice', 'tenant', 'native-review'); const captured = canvasStorage();
    expect(saveRunJournal(review())).toBe(true);
    configureCanvasStorage('alice', 'tenant', 'cloud-canvas');
    expect(saveRunJournal(cloud())).toBe(true);
    expect(loadRunJournal()).toEqual(cloud());
    expect(loadRunJournal(captured)).toEqual(review());
    expect(clearRunJournal('review-operation')).toBe(false);
    expect(clearRunJournal(captured, 'review-operation')).toBe(true);
    expect(loadRunJournal()).toEqual(cloud());
  });

  it('validates both metadata blocks and keeps approved-only Review success', () => {
    const combined: CanvasRunJournal = { ...review(), serverGraph: cloud().serverGraph,
      nodes: { node: { ...review().nodes.node, state: 'done', output: 'Candidate' } } };
    saveRunJournal(combined);
    expect(loadRunJournal()).toEqual(combined);
    expect(journalSummary(loadRunJournal()!)).toMatchObject({ ok: false, done: 1, review: { outcome: 'exhausted', rounds: 2 } });
    saveRunJournal({ ...combined, review: { ...combined.review!, outcome: 'approved' } });
    expect(journalSummary(loadRunJournal()!).ok).toBe(true);
    for (const invalid of [{ ...combined, serverGraph: { ...combined.serverGraph, canvasId: '' } },
      { ...combined, review: { ...combined.review, maxRounds: 0 } }]) {
      canvasStorage().setItem(CANVAS_RUN_JOURNAL_KEY, JSON.stringify(invalid));
      expect(loadRunJournal()).toBeNull();
    }
  });

  it('keeps a cloud waiting node active until the server reports completion and never calls native recovery', async () => {
    const active = cloud();
    const response = { id: 'graph', operationId: active.id, canvasId: 'canvas', documentVersion: 1, scope: ['node'],
      status: 'running', createdAt: '2026-09-09T00:00:00Z', nodes: [{ nodeId: 'node', state: 'waiting' }] };
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(response)))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...response, status: 'completed', nodes: [{ nodeId: 'node', state: 'done', output: 'Server result' }] })));
    vi.stubGlobal('fetch', fetcher);
    const first = await reconcileRunJournal(active, [], '/native-gateway');
    expect(first.nodes.node.state).toBe('waiting');
    const terminal = await reconcileRunJournal(first, [], '/native-gateway');
    expect(terminal.nodes.node).toMatchObject({ state: 'done', output: 'Server result' });
    expect(journalSummary(terminal).ok).toBe(true);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(Array(2).fill('/api/v1/tenants/tenant/canvases/canvas/graph-runs/graph'));
    expect(fetcher.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
  });

  it('keeps cloud uncertainty locked while native waiting recovery remains undispatched', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 403 })));
    const active = cloud(); expect(await reconcileRunJournal(active, [], '/native-gateway')).toEqual(active);
    const restored = await reconcileRunJournal(review(), [], '/native-gateway');
    expect(restored.nodes.node).toMatchObject({ state: 'blocked', detail: 'recovery_not_dispatched' });
    expect(restored.review).toEqual(review().review);
    expect(journalSummary(restored).ok).toBe(false);
  });
});
