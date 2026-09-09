import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSessionNode, emptyDocument, type CanvasDocument, type SessionNode } from '../src/canvas/canvasDoc';
import { canvasStorage, configureCanvasStorage } from '../src/canvas/canvasStorage';
import { clearRunJournal, journalSummary, loadRunJournal, reconcileRunJournal, saveRunJournal, type CanvasRunJournal } from '../src/canvas/runJournal';
import { applyRecoveredDocument, recoveryJournalForDocument, runInputFingerprint } from '../src/canvas/runRecoveryDocument';
import { SaaSApiError, type Tenant } from '../src/saas/api';
import { clearSaaSCanvas, configureSaaSCanvas, configureSaaSCanvasSave } from '../src/saas/canvasBridge';
import { GraphNotSubmittedError, graphAdmissionRejected, graphRecoveryJournal, mergeGraphSnapshot, observeCloudGraph, submitCloudGraph, type GraphRunSnapshot } from '../src/saas/graphRuns';

const tenant: Tenant = { id: 'tenant-a', name: 'A', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 10 };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const session = (id: string): SessionNode => ({
  ...createSessionNode('llm', { x: 0, y: 0 }), id, title: id.toUpperCase(), runtime: 'pi', model: 'writer-profile', persona: `Instructions for ${id}`,
  activeThreadId: `thread-${id}`, binding: { companyId: tenant.id, agentId: `agent-${id}`, agentName: id },
});
const document = (): CanvasDocument => ({ ...emptyDocument(), nodes: [session('a'), session('b'), session('upstream')] });
const snapshot = (patch: Partial<GraphRunSnapshot> = {}): GraphRunSnapshot => ({
  id: 'graph-a', operationId: 'operation-a', canvasId: 'canvas-a', documentVersion: 17, document: document(), scope: ['b', 'a'],
  status: 'running', createdAt: '2026-09-08T03:04:05.000Z', nodes: [
    { nodeId: 'a', state: 'running', runId: 'run-a', sessionId: 'session-a', output: 'partial A' },
    { nodeId: 'b', state: 'waiting' },
    { nodeId: 'upstream', state: 'cached', output: 'Published source', detail: 'cached predecessor' },
  ], ...patch,
});
const pending = (): CanvasRunJournal => {
  const journal = graphRecoveryJournal(snapshot(), tenant.id, document());
  delete journal.serverGraph!.id;
  journal.nodes.a = { ...journal.nodes.a!, state: 'waiting', runId: null, issueId: null };
  return journal;
};
const memoryStorage = () => {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
};
afterEach(() => { clearSaaSCanvas(); configureSaaSCanvasSave(null); vi.unstubAllGlobals(); localStorage.clear(); });

describe('durable cloud graph identity and recovery', () => {
  it('round-trips exact operation, graph, tenant, scope, member session and Stop intent through storage', () => {
    const accepted = snapshot();
    const journal = graphRecoveryJournal(accepted, tenant.id, document());
    journal.serverGraph!.cancelRequested = true;
    const storage = memoryStorage();
    expect(saveRunJournal(journal, storage)).toBe(true);
    const restored = loadRunJournal(storage)!;
    expect(restored).toEqual(journal);
    expect(restored).toMatchObject({ id: 'operation-a', startedAt: Date.parse(accepted.createdAt), scope: ['b', 'a'],
      serverGraph: { id: 'graph-a', tenantId: 'tenant-a', canvasId: 'canvas-a', cancelRequested: true },
      nodes: { a: { threadId: 'thread-a', companyId: 'tenant-a', agentId: 'agent-a', issueId: 'session-a', runId: 'run-a', output: 'partial A' } },
    });
    expect(restored.inputFingerprint).toBe(runInputFingerprint(accepted.document!, ['b', 'a']));
    expect(restored.scope).not.toContain('upstream');
  });

  it('retains the originally captured storage namespace after account and canvas changes', () => {
    configureCanvasStorage('alice', 'tenant-a', 'canvas-a');
    const originalStorage = canvasStorage();
    const original = pending();
    saveRunJournal(original, originalStorage);
    configureCanvasStorage('bob', 'tenant-b', 'canvas-b');
    const current = { ...pending(), id: 'new-operation', serverGraph: { tenantId: 'tenant-b', canvasId: 'canvas-b' } };
    saveRunJournal(current);
    saveRunJournal({ ...original, serverGraph: { ...original.serverGraph!, cancelRequested: true } }, originalStorage);
    expect(loadRunJournal()!.id).toBe('new-operation');
    expect(loadRunJournal(originalStorage)!.serverGraph!.cancelRequested).toBe(true);
    expect(clearRunJournal(originalStorage, 'new-operation')).toBe(false);
    expect(clearRunJournal(originalStorage, original.id)).toBe(true);
    expect(loadRunJournal()!.id).toBe('new-operation');
  });

  it('uses the accepted document fingerprint and refuses publication into a changed draft', () => {
    const accepted = snapshot({ status: 'completed', nodes: [{ nodeId: 'a', state: 'done', output: 'Accepted result' }, { nodeId: 'b', state: 'done', output: 'Accepted B' }] });
    const changed = structuredClone(accepted.document!);
    (changed.nodes[0] as SessionNode).persona = 'Changed after admission';
    const journal = graphRecoveryJournal(accepted, tenant.id, changed);
    expect(journal.inputFingerprint).not.toBe(runInputFingerprint(changed, journal.scope));
    expect(recoveryJournalForDocument(changed, journal).nodes.a).toMatchObject({ state: 'failed', detail: 'recovery_input_changed', output: 'Accepted result' });
    expect(applyRecoveredDocument(changed, journal).nodes[0]!.lastOutput ?? null).toBeNull();
  });

  it('keeps missing-document recovery unverified instead of trusting the currently open draft', () => {
    const accepted = snapshot({ document: undefined });
    expect(graphRecoveryJournal(accepted, tenant.id, document()).inputFingerprint).toBe('unverified-server-document');
  });

  it('never re-POSTs an absent pending operation, including after a reload', async () => {
    const fetcher = vi.fn(async (_url: string, _init: RequestInit = {}) => json({ items: [] }));
    vi.stubGlobal('fetch', fetcher);
    const original = pending(); const storage = memoryStorage();
    saveRunJournal(original, storage);
    const first = await observeCloudGraph(loadRunJournal(storage)!);
    saveRunJournal(first, storage);
    const second = await reconcileRunJournal(loadRunJournal(storage)!, document().nodes, '/unused');
    expect(first).toEqual(original); expect(second).toEqual(original);
    expect(journalSummary(second)).toMatchObject({ ok: false, done: 0, blocked: 0, cancelled: 0 });
    expect(fetcher.mock.calls.map(([url, init]) => [url, init.method || 'GET'])).toEqual([
      ['/api/v1/tenants/tenant-a/canvases/canvas-a/graph-runs?operationId=operation-a', 'GET'],
      ['/api/v1/tenants/tenant-a/canvases/canvas-a/graph-runs?operationId=operation-a', 'GET'],
    ]);
  });

  it('recovers an accepted-before-response operation by exact identity without dispatching again', async () => {
    const original = pending();
    const actual = snapshot();
    const fetcher = vi.fn(async (_url: string, _init: RequestInit = {}) => json({ items: [snapshot({ id: 'unrelated-graph', operationId: 'unrelated-operation' }), actual] }));
    vi.stubGlobal('fetch', fetcher);
    const recovered = await observeCloudGraph(original);
    expect(recovered.serverGraph!.id).toBe('graph-a');
    expect(recovered.nodes.a).toMatchObject({ runId: 'run-a', issueId: 'session-a', state: 'running', output: 'partial A' });
    expect(original.serverGraph!.id).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![1].method).toBeUndefined();
  });

  it.each(['offline', 'unauthenticated', 'foreign-canvas', 'foreign-operation'])('preserves the recovery lock and evidence on %s', async scenario => {
    const original = graphRecoveryJournal(snapshot(), tenant.id, document());
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (scenario === 'offline') throw new TypeError('Failed to fetch');
      if (scenario === 'unauthenticated') return json({ error: { code: 'unauthenticated' } }, 401);
      return json(snapshot({ ...(scenario === 'foreign-canvas' ? { canvasId: 'canvas-b' } : { operationId: 'operation-b' }), status: 'completed', nodes: [{ nodeId: 'a', state: 'done', output: 'Foreign result' }] }));
    }));
    expect(await reconcileRunJournal(original, document().nodes, '/unused')).toEqual(original);
  });

  it('an explicit operation tombstone cancels only unfinished nodes and preserves prior output', async () => {
    const journal = pending(); journal.serverGraph!.cancelRequested = true;
    journal.nodes.a = { ...journal.nodes.a!, state: 'done', output: 'Already completed A' };
    const storage = memoryStorage(); saveRunJournal(journal, storage);
    const fetcher = vi.fn(async (_url: string, _init: RequestInit = {}) => json({ confirmed: true, status: 'cancelled' }));
    vi.stubGlobal('fetch', fetcher);
    const recovered = await observeCloudGraph(loadRunJournal(storage)!);
    expect(recovered.nodes.a).toMatchObject({ state: 'done', output: 'Already completed A' });
    expect(recovered.nodes.b).toMatchObject({ state: 'cancelled', detail: 'cancelled' });
    expect(recovered.nodes.upstream).toMatchObject({ state: 'cached', output: 'Published source' });
    expect(journalSummary(recovered)).toMatchObject({ ok: false, done: 1, cancelled: 1 });
    expect(fetcher.mock.calls.map(([url, init]) => [url, init.method, init.body])).toEqual([
      ['/api/v1/tenants/tenant-a/canvases/canvas-a/graph-runs/operations/operation-a/cancel', 'POST', '{}'],
    ]);
  });

  it.each(['completed', 'failed'] as const)('fetches the original %s outcome when Stop arrives after completion', async finalStatus => {
    const journal = pending(); journal.serverGraph!.cancelRequested = true;
    const terminal = snapshot({ status: finalStatus, nodes: [
      { nodeId: 'a', state: finalStatus === 'completed' ? 'done' : 'failed', output: 'Original durable A', runId: 'run-a', sessionId: 'session-a' },
      { nodeId: 'b', state: finalStatus === 'completed' ? 'done' : 'blocked', output: 'Original durable B' },
    ] });
    const fetcher = vi.fn(async (_url: string, init: RequestInit = {}) => init.method === 'POST'
      ? json({ confirmed: true, graphId: 'graph-a', status: finalStatus }) : json({ items: [terminal] }));
    vi.stubGlobal('fetch', fetcher);
    const recovered = await observeCloudGraph(journal);
    expect(recovered.nodes.a).toMatchObject({ state: finalStatus === 'completed' ? 'done' : 'failed', output: 'Original durable A', runId: 'run-a' });
    expect(recovered.nodes.b.state).toBe(finalStatus === 'completed' ? 'done' : 'blocked');
    expect(recovered.serverGraph).toMatchObject({ id: 'graph-a', cancelRequested: true });
    expect(fetcher.mock.calls.map(([, init]) => init.method || 'GET')).toEqual(['POST', 'GET']);
  });

  it('does not clear waiting nodes for an unconfirmed cancellation', async () => {
    const journal = pending(); journal.serverGraph!.cancelRequested = true;
    const fetcher = vi.fn(async (_url: string, init: RequestInit = {}) => json(init.method === 'POST' ? { confirmed: false, status: 'cancelled' } : { items: [] }));
    vi.stubGlobal('fetch', fetcher);
    expect(await observeCloudGraph(journal)).toEqual(journal);
    expect(fetcher.mock.calls.map(([, init]) => init.method || 'GET')).toEqual(['POST', 'GET']);
  });

  it('reads an existing cancelled graph so a completed node and last partial output survive Stop', async () => {
    const journal = pending(); journal.serverGraph!.cancelRequested = true;
    const terminal = snapshot({ status: 'cancelled', nodes: [
      { nodeId: 'a', state: 'done', output: 'Completed before Stop', runId: 'run-a', sessionId: 'session-a' },
      { nodeId: 'b', state: 'cancelled', output: 'Last partial B', runId: 'run-b', sessionId: 'session-b' },
    ] });
    const fetcher = vi.fn(async (_url: string, init: RequestInit = {}) => init.method === 'POST'
      ? json({ confirmed: true, graphId: 'graph-a', status: 'cancelled' }) : json({ items: [terminal] }));
    vi.stubGlobal('fetch', fetcher);
    const recovered = await observeCloudGraph(journal);
    expect(recovered.nodes.a).toMatchObject({ state: 'done', output: 'Completed before Stop', runId: 'run-a' });
    expect(recovered.nodes.b).toMatchObject({ state: 'cancelled', output: 'Last partial B', runId: 'run-b' });
    expect(journalSummary(recovered)).toMatchObject({ ok: false, done: 1, cancelled: 1 });
    expect(fetcher.mock.calls.map(([, init]) => init.method || 'GET')).toEqual(['POST', 'GET']);
  });

  it('settles nodes omitted from a terminal snapshot while retaining cached ancestors and partial output', () => {
    const original = graphRecoveryJournal(snapshot(), tenant.id, document());
    const recovered = mergeGraphSnapshot(original, snapshot({ status: 'interrupted', error: 'server restarted', nodes: [] }));
    expect(recovered.nodes.a).toMatchObject({ state: 'blocked', detail: 'server restarted', output: 'partial A' });
    expect(recovered.nodes.b.state).toBe('blocked');
    expect(recovered.nodes.upstream.state).toBe('cached');
    expect(original.nodes.a.state).toBe('running');
  });
});

describe('cloud graph admission', () => {
  it('waits for the exact save callback version and posts it once with the requested scope', async () => {
    configureSaaSCanvas({ tenant, canvasId: 'canvas-a' });
    let saved!: (version: number) => void;
    configureSaaSCanvasSave(() => new Promise<number>(resolve => { saved = resolve; }));
    const accepted = snapshot();
    const fetcher = vi.fn(async (_url: string, _init: RequestInit = {}) => json(accepted));
    vi.stubGlobal('fetch', fetcher);
    const result = submitCloudGraph('operation-a', ['b', 'a']);
    expect(fetcher).not.toHaveBeenCalled();
    saved(17);
    expect(await result).toEqual(accepted);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('/api/v1/tenants/tenant-a/canvases/canvas-a/graph-runs');
    expect(init.method).toBe('POST'); expect(init.credentials).toBe('include');
    expect(JSON.parse(init.body as string)).toEqual({ operationId: 'operation-a', scope: ['b', 'a'], documentVersion: 17 });
  });

  it('rejects a workspace change while saving before any graph POST', async () => {
    configureSaaSCanvas({ tenant, canvasId: 'canvas-a' });
    let saved!: (version: number) => void;
    configureSaaSCanvasSave(() => new Promise<number>(resolve => { saved = resolve; }));
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const result = submitCloudGraph('operation-a', ['a']);
    configureSaaSCanvas({ tenant: { ...tenant, id: 'tenant-b' }, canvasId: 'canvas-a' });
    saved(17);
    await expect(result).rejects.toBeInstanceOf(GraphNotSubmittedError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([undefined, 0, -1, 1.5, NaN])('rejects an unavailable or invalid saved version %s', async version => {
    configureSaaSCanvas({ tenant, canvasId: 'canvas-a' }); configureSaaSCanvasSave(async () => version);
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await expect(submitCloudGraph('operation-a', ['a'])).rejects.toBeInstanceOf(GraphNotSubmittedError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('classifies a failed save as definitely not submitted', async () => {
    configureSaaSCanvas({ tenant, canvasId: 'canvas-a' }); configureSaaSCanvasSave(async () => { throw new Error('Version conflict'); });
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const failure = await submitCloudGraph('operation-a', ['a']).catch(error => error);
    expect(failure).toBeInstanceOf(GraphNotSubmittedError); expect(graphAdmissionRejected(failure)).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    [409, 'version_conflict', true], [403, 'forbidden', true], [429, 'quota_exceeded', true],
    [503, 'runtime_unavailable', true], [503, 'worker_unavailable', true], [503, 'database_unavailable', true],
    [503, 'proxy_unavailable', false], [504, 'gateway_timeout', false], [500, 'internal_error', false],
  ])('classifies HTTP %i/%s admission evidence as rejected=%s', async (status, code, rejected) => {
    configureSaaSCanvas({ tenant, canvasId: 'canvas-a' }); configureSaaSCanvasSave(async () => 17);
    const fetcher = vi.fn(async () => json({ error: { code, message: 'Admission result' } }, status)); vi.stubGlobal('fetch', fetcher);
    const error = await submitCloudGraph('operation-a', ['a']).catch(error => error);
    expect(error).toBeInstanceOf(SaaSApiError); expect(graphAdmissionRejected(error)).toBe(rejected);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('retains unknown network admission outcomes instead of claiming rejection', async () => {
    configureSaaSCanvas({ tenant, canvasId: 'canvas-a' }); configureSaaSCanvasSave(async () => 17);
    const fetcher = vi.fn(async () => { throw new TypeError('Failed to fetch'); }); vi.stubGlobal('fetch', fetcher);
    const error = await submitCloudGraph('operation-a', ['a']).catch(error => error);
    expect(error).toBeInstanceOf(TypeError); expect(graphAdmissionRejected(error)).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
