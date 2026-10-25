import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSessionNode, emptyDocument, type CanvasDocument, type SessionNode } from '../src/canvas/canvasDoc';
import { canvasStorage, configureCanvasStorage } from '../src/canvas/canvasStorage';
import { clearRunJournal, journalSummary, loadRunJournal, reconcileRunJournal, saveRunJournal, type CanvasRunJournal } from '../src/canvas/runJournal';
import { applyRecoveredDocument, recoveryJournalForDocument, runInputFingerprint } from '../src/canvas/runRecoveryDocument';
import { SaaSApiError, type Tenant } from '../src/saas/api';
import { clearSaaSCanvas, configureSaaSCanvas, configureSaaSCanvasSave, configureCanvasKnowledge, canvasKnowledgeRevisionIds } from '../src/saas/canvasBridge';
import { GraphNotSubmittedError, graphAdmissionRejected, graphRecoveryJournal, graphRefusedNodeId, mergeGraphSnapshot, observeCloudGraph, submitCloudGraph,
  type GraphCollaborationTurn, type GraphObservation, type GraphRunSnapshot } from '../src/saas/graphRuns';
import { graphRunSummary, graphRunWithoutDocument } from './saas-graph-run-summary-fixture';

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

  it('replaces a stale observer diagnostic while retaining fresh server errors and genuine input mismatches', () => {
    const accepted = snapshot({ status: 'completed', nodes: [{ nodeId: 'a', state: 'done', output: 'Accepted A' }, { nodeId: 'b', state: 'done', output: 'Accepted B' }] });
    const original = accepted.document!;
    const changed = structuredClone(original); (changed.nodes[0] as SessionNode).persona = 'Different actual task';
    const stale = recoveryJournalForDocument(changed, graphRecoveryJournal(accepted, tenant.id, original));
    expect(stale.nodes.a.detail).toBe('recovery_input_changed');
    const fresh = mergeGraphSnapshot(stale, accepted);
    expect(fresh.nodes.a).toMatchObject({ state: 'done', output: 'Accepted A' });
    expect(fresh.nodes.a.detail).toBeUndefined();
    expect(recoveryJournalForDocument(original, fresh).nodes.a.state).toBe('done');
    expect(recoveryJournalForDocument(changed, fresh).nodes.a).toMatchObject({ state: 'failed', detail: 'recovery_input_changed' });
    const rejected = mergeGraphSnapshot(stale, { ...accepted, status: 'failed', nodes: [{ nodeId: 'a', state: 'failed', detail: 'model_unavailable' }] });
    expect(rejected.nodes.a.detail).toBe('model_unavailable');
    expect(rejected.nodes.b.detail).toBe('recovery_input_changed'); // An omitted node was not refreshed.
  });

  // Live 2026-10-18: every row of the execution timeline drew no bar and 「—」 for a cloud run, because the graph's nodes
  // carried no times and each poll replaced the page's own. The server now says when each node's run began and ended.
  it('carries each node’s recorded run times into the journal, through a reload, and drops an end the run no longer has', () => {
    const begun = Date.parse('2026-09-08T03:04:06.000Z');
    const ended = Date.parse('2026-09-08T03:04:36.500Z');
    const journal = graphRecoveryJournal(snapshot({ nodes: [
      { nodeId: 'a', state: 'done', runId: 'run-a', sessionId: 'session-a', output: 'A', startedAt: '2026-09-08T03:04:06.000Z', endedAt: '2026-09-08T03:04:36.500Z' },
      { nodeId: 'b', state: 'running', runId: 'run-b', startedAt: '2026-09-08T03:04:37.000Z', endedAt: null },
      { nodeId: 'upstream', state: 'cached', output: 'Published source', startedAt: null, endedAt: null },
    ] }), tenant.id, document());
    expect(journal.nodes.a).toMatchObject({ startedAt: begun, endedAt: ended });
    expect(journal.nodes.b).toMatchObject({ startedAt: Date.parse('2026-09-08T03:04:37.000Z') });
    expect(journal.nodes.b).not.toHaveProperty('endedAt');
    expect(journal.nodes.upstream).not.toHaveProperty('startedAt');
    const storage = memoryStorage();
    expect(saveRunJournal(journal, storage)).toBe(true);
    expect(loadRunJournal(storage)!.nodes.a).toMatchObject({ startedAt: begun, endedAt: ended });
    // A retry's new run: its own start, and no end yet.
    const retried = mergeGraphSnapshot(journal, snapshot({ nodes: [{ nodeId: 'a', state: 'running', runId: 'run-a-2', startedAt: '2026-09-08T03:05:00.000Z', endedAt: null }] }));
    expect(retried.nodes.a.startedAt).toBe(Date.parse('2026-09-08T03:05:00.000Z'));
    expect(retried.nodes.a).not.toHaveProperty('endedAt');
    // Unreadable or backwards times are not drawn; a node the server gives none keeps what it had.
    const odd = mergeGraphSnapshot(journal, snapshot({ nodes: [{ nodeId: 'a', state: 'done', startedAt: 'yesterday' }, { nodeId: 'b', state: 'done', startedAt: '2026-09-08T03:04:37.000Z', endedAt: '2026-09-08T03:00:00.000Z' }] }));
    expect(odd.nodes.a).toMatchObject({ startedAt: begun, endedAt: ended });
    expect(odd.nodes.b).not.toHaveProperty('endedAt');
    storage.setItem('awwo.canvas.active-run.v1', JSON.stringify({ ...journal, nodes: { ...journal.nodes, a: { ...journal.nodes.a, startedAt: 'soon', endedAt: ended } } }));
    expect(loadRunJournal(storage)!.nodes.a).not.toHaveProperty('startedAt');
    expect(loadRunJournal(storage)!.nodes.a).not.toHaveProperty('endedAt');
  });

  it('shows a node waiting for its automatic retry with its attempts and limit, through a reload and its next attempt', () => {
    const failed = { runId: 'run-a-1', code: 'runtime_rejected', endedAt: '2026-09-08T03:05:00Z', attempt: 1 };
    const retrying = snapshot({ nodeRetries: 2, nodes: [
      { nodeId: 'a', state: 'waiting', detail: 'retrying', runId: 'run-a-1', sessionId: 'session-a', output: '', attempts: 1, attemptLog: [failed] },
      { nodeId: 'b', state: 'waiting', detail: '', attempts: 0, attemptLog: [] },
    ] });
    const journal = graphRecoveryJournal(retrying, tenant.id, document());
    // The failed attempt is named, never shown as running.
    expect(journal.nodes.a).toMatchObject({ state: 'waiting', detail: 'retrying', runId: 'run-a-1', attempts: 1, retryLimit: 2 });
    expect(journal.nodes.b).not.toHaveProperty('attempts');
    expect(journal.nodes.b).not.toHaveProperty('retryLimit');
    const storage = memoryStorage();
    expect(saveRunJournal(journal, storage)).toBe(true);
    expect(loadRunJournal(storage)!.nodes.a).toMatchObject({ detail: 'retrying', attempts: 1, retryLimit: 2 });
    const next = mergeGraphSnapshot(journal, { ...retrying, nodes: [{ nodeId: 'a', state: 'running', detail: '', runId: 'run-a-2', sessionId: 'session-a', attempts: 1, attemptLog: [failed] }] });
    expect(next.nodes.a).toMatchObject({ state: 'running', runId: 'run-a-2', attempts: 1, retryLimit: 2 });
    expect(next.nodes.a.detail).toBeUndefined();
    // Retries show only while the server reports them, and only within its range.
    const unreported = mergeGraphSnapshot(journal, { ...retrying, nodeRetries: undefined, nodes: [{ nodeId: 'a', state: 'running', runId: 'run-a-2' }] });
    expect(unreported.nodes.a).not.toHaveProperty('attempts');
    expect(unreported.nodes.a).not.toHaveProperty('retryLimit');
    const odd = mergeGraphSnapshot(journal, { ...retrying, nodeRetries: 9, nodes: [{ nodeId: 'a', state: 'waiting', detail: 'retrying', attempts: 1.5 }] });
    expect(odd.nodes.a).not.toHaveProperty('attempts');
    const unlimited = mergeGraphSnapshot(journal, { ...retrying, nodeRetries: 0, nodes: [{ nodeId: 'a', state: 'waiting', detail: 'retrying', attempts: 1 }] });
    expect(unlimited.nodes.a).toMatchObject({ attempts: 1 });
    expect(unlimited.nodes.a).not.toHaveProperty('retryLimit');
    storage.setItem('awwo.canvas.active-run.v1', JSON.stringify({ ...journal, nodes: { ...journal.nodes, a: { ...journal.nodes.a, attempts: 7, retryLimit: 'two' } } }));
    expect(loadRunJournal(storage)!.nodes.a).not.toHaveProperty('attempts');
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
    // The list finds the operation's run and carries none of its outputs; the run's own read carries them.
    const fetcher = vi.fn(async (url: string, _init: RequestInit = {}) => json(url.endsWith('/graph-runs/graph-a') ? actual
      : { items: [snapshot({ id: 'unrelated-graph', operationId: 'unrelated-operation' }), actual].map(graphRunSummary) }));
    vi.stubGlobal('fetch', fetcher);
    const recovered = await observeCloudGraph(original);
    expect(recovered.serverGraph!.id).toBe('graph-a');
    expect(recovered.nodes.a).toMatchObject({ runId: 'run-a', issueId: 'session-a', state: 'running', output: 'partial A' });
    expect(original.serverGraph!.id).toBeUndefined();
    expect(fetcher.mock.calls.map(([url, init]) => [url, init.method || 'GET'])).toEqual([
      ['/api/v1/tenants/tenant-a/canvases/canvas-a/graph-runs?operationId=operation-a', 'GET'],
      ['/api/v1/tenants/tenant-a/canvases/canvas-a/graph-runs/graph-a', 'GET'],
    ]);
  });

  it('shows only server-confirmed cached ancestors in a live scoped run without expanding the execution scope', () => {
    const original = pending();
    delete original.nodes.upstream; // A newly submitted scoped run journals only executable nodes.
    const observed = mergeGraphSnapshot(original, snapshot({ status: 'completed', nodes: [
      { nodeId: 'a', state: 'done', runId: 'run-a', output: 'New A' },
      { nodeId: 'b', state: 'done', runId: 'run-b', output: 'New B' },
      { nodeId: 'upstream', state: 'cached', output: 'Published source', detail: 'cached predecessor' },
    ] }));
    expect(observed.nodes.upstream).toMatchObject({ state: 'cached', output: 'Published source', runId: null, threadId: 'thread-upstream' });
    expect(observed.scope).toEqual(['b', 'a']);
    expect(journalSummary(observed)).toMatchObject({ ok: true, done: 2, total: 2, cached: 1 });
    const storage = memoryStorage();
    expect(saveRunJournal(observed, storage)).toBe(true);
    expect(loadRunJournal(storage)?.nodes.upstream).toMatchObject({ state: 'cached', output: 'Published source', runId: null });

    const withoutProof = mergeGraphSnapshot(original, snapshot({ document: undefined, nodes: [
      { nodeId: 'a', state: 'running' }, { nodeId: 'b', state: 'waiting' },
      { nodeId: 'upstream', state: 'cached', output: 'Published source' },
    ] }));
    expect(withoutProof.nodes.upstream).toBeUndefined();
    expect(journalSummary(withoutProof)).toMatchObject({ total: 2, cached: 0 });
  });

  // The canvas observes a run that goes on every 2.5 s (hours, for a film), and the canvas the run froze at admission (a
  // megabyte, for a film) never changes after it: an observer reads it with the run once, then reads the run without it
  // and merges the one it kept, which still names a cached ancestor's node.
  it('reads its run whole once per observer, then without the canvas it froze, merging the one it kept', async () => {
    const served: Record<string, GraphRunSnapshot> = { 'graph-a': snapshot(), 'graph-b': snapshot({ id: 'graph-b', operationId: 'operation-b' }) };
    const reads: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const [path, query] = url.split('?');
      const id = path!.slice('/api/v1/tenants/tenant-a/canvases/canvas-a/graph-runs/'.length);
      reads.push(query ? `${id}?${query}` : id);
      const run = served[id];
      if (!run || (query && query !== 'document=false')) return json({ error: { code: 'not_found', message: 'Not found' } }, 404);
      return json(query ? graphRunWithoutDocument(run) : run);
    }));
    const observation: GraphObservation = {};
    const admitted = served['graph-a']!;
    const first = await observeCloudGraph(graphRecoveryJournal(admitted, tenant.id, admitted.document!), undefined, observation);
    expect(observation).toEqual({ run: JSON.stringify(['tenant-a', 'canvas-a', 'graph-a']), document: admitted.document });
    // A journal that holds only the nodes it executes, as a scoped run's does when it is submitted: the read without the
    // canvas lists the cached ancestor, and the merge finds its node in the canvas kept.
    const { upstream: _upstream, ...executed } = first.nodes;
    served['graph-a'] = snapshot({ nodes: [{ nodeId: 'a', state: 'done', runId: 'run-a', sessionId: 'session-a', output: 'Final A' },
      { nodeId: 'b', state: 'running', runId: 'run-b' }, { nodeId: 'upstream', state: 'cached', output: 'Published source' }] });
    const second = await observeCloudGraph({ ...first, nodes: executed }, undefined, observation);
    expect(second.nodes.a).toMatchObject({ state: 'done', output: 'Final A', runId: 'run-a' });
    expect(second.nodes.upstream).toMatchObject({ state: 'cached', output: 'Published source', threadId: 'thread-upstream', runId: null });
    expect(second.scope).toEqual(['b', 'a']);
    await observeCloudGraph(second, undefined, observation);
    // Another run in the same observer is read whole, and its canvas is kept in place of the first's.
    const other = graphRecoveryJournal(served['graph-b']!, tenant.id, document());
    await observeCloudGraph(other, undefined, observation);
    await observeCloudGraph(other, undefined, observation);
    // Without an observation (a single pass), every read is whole.
    await observeCloudGraph(second);
    await reconcileRunJournal(second, document().nodes, '/unused');
    expect(reads).toEqual(['graph-a', 'graph-a?document=false', 'graph-a?document=false', 'graph-b', 'graph-b?document=false', 'graph-a', 'graph-a']);
  });

  it('still checks a collaboration’s frozen canvas against its admission on the reads that leave it out', async () => {
    const policy = { goal: 'Agree on one plan', rounds: 1, synthesizerNodeId: 'a' };
    const run = (turns: GraphCollaborationTurn[]) => snapshot({ scope: ['a', 'b'],
      collaboration: { ...policy, maxModelCalls: 5, phase: 'proposal', round: 1, turns },
      nodes: [{ nodeId: 'a', state: turns.length ? 'running' : 'waiting', ...(turns.length ? { runId: 'run-a1', sessionId: 'session-a' } : {}) },
        { nodeId: 'b', state: 'waiting' }] });
    let served = run([]);
    const reads: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      reads.push(url.slice(url.lastIndexOf('/') + 1));
      return json(url.endsWith('?document=false') ? graphRunWithoutDocument(served) : served);
    }));
    const observation: GraphObservation = {};
    const journal = graphRecoveryJournal(served, tenant.id, document());
    expect(journal.inputFingerprint).toBe(runInputFingerprint(document(), ['a', 'b']));
    const observed = await reconcileRunJournal(journal, document().nodes, '/unused', undefined, observation);
    // The run goes on; read without its canvas, it still merges against the canvas kept.
    served = run([{ ordinal: 1, nodeId: 'a', phase: 'proposal', round: 1, status: 'running', runId: 'run-a1', sessionId: 'session-a' }]);
    const next = await reconcileRunJournal(observed, document().nodes, '/unused', undefined, observation);
    expect(next.collaboration?.turns).toHaveLength(1);
    expect(next.nodes.a).toMatchObject({ state: 'running', runId: 'run-a1' });
    // A journal admitted on other inputs than the canvas the run froze is refused on those reads as on a whole one.
    const changed = structuredClone(document()); (changed.nodes[0] as SessionNode).persona = 'Changed after admission';
    const foreign = { ...observed, inputFingerprint: runInputFingerprint(changed, ['a', 'b']) };
    await expect(observeCloudGraph(foreign, undefined, observation)).rejects.toThrow('Collaboration document changed after admission');
    expect(await reconcileRunJournal(foreign, document().nodes, '/unused', undefined, observation)).toEqual(foreign);
    expect(reads).toEqual(['graph-a', 'graph-a?document=false', 'graph-a?document=false', 'graph-a?document=false']);
  });

  it('reads the run whole until the merge accepts a read, and without its canvas after that whatever a read’s outcome', async () => {
    const replies: Array<() => Response> = [
      () => json(snapshot({ canvasId: 'canvas-b' })), // another canvas's run: the merge refuses it
      () => { throw new TypeError('Failed to fetch'); },
      () => json({ ...snapshot(), id: 'graph-b' }), // not the run asked for
      () => json(snapshot()),
      () => json(graphRunWithoutDocument(snapshot())),
      () => { throw new TypeError('Failed to fetch'); },
      () => json(graphRunWithoutDocument(snapshot({ canvasId: 'canvas-b' }))),
      () => json(graphRunWithoutDocument(snapshot({ status: 'completed', nodes: [{ nodeId: 'a', state: 'done', output: 'Final A' },
        { nodeId: 'b', state: 'done', output: 'Final B' }, { nodeId: 'upstream', state: 'cached', output: 'Published source' }] }))),
    ];
    const fetcher = vi.fn(async (_url: string) => replies.shift()!());
    vi.stubGlobal('fetch', fetcher);
    const observation: GraphObservation = {};
    const journal = graphRecoveryJournal(snapshot(), tenant.id, document());
    for (let i = 0; i < 3; i++) expect(await reconcileRunJournal(journal, document().nodes, '/unused', undefined, observation)).toEqual(journal);
    expect(observation).toEqual({});
    await reconcileRunJournal(journal, document().nodes, '/unused', undefined, observation);
    const kept = { ...observation };
    expect(kept.run).toBe(JSON.stringify(['tenant-a', 'canvas-a', 'graph-a']));
    await reconcileRunJournal(journal, document().nodes, '/unused', undefined, observation);
    // Kept, the run's canvas stays the observer's through a read that fails and one the merge refuses.
    for (let i = 0; i < 2; i++) expect(await reconcileRunJournal(journal, document().nodes, '/unused', undefined, observation)).toEqual(journal);
    expect(observation).toEqual(kept);
    const settled = await reconcileRunJournal(journal, document().nodes, '/unused', undefined, observation);
    expect(settled.nodes.a).toMatchObject({ state: 'done', output: 'Final A' });
    expect(fetcher.mock.calls.map(([url]) => url.slice(url.lastIndexOf('/') + 1))).toEqual(['graph-a', 'graph-a', 'graph-a', 'graph-a',
      'graph-a?document=false', 'graph-a?document=false', 'graph-a?document=false', 'graph-a?document=false']);
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
    const fetcher = vi.fn(async (url: string, init: RequestInit = {}) => init.method === 'POST'
      ? json({ confirmed: true, graphId: 'graph-a', status: finalStatus }) : json(url.endsWith('/graph-runs/graph-a') ? terminal : { items: [graphRunSummary(terminal)] }));
    vi.stubGlobal('fetch', fetcher);
    const recovered = await observeCloudGraph(journal);
    expect(recovered.nodes.a).toMatchObject({ state: finalStatus === 'completed' ? 'done' : 'failed', output: 'Original durable A', runId: 'run-a' });
    expect(recovered.nodes.b.state).toBe(finalStatus === 'completed' ? 'done' : 'blocked');
    expect(recovered.serverGraph).toMatchObject({ id: 'graph-a', cancelRequested: true });
    // Stop named the graph, which is then read whole by its id: there is nothing to find in the list.
    expect(fetcher.mock.calls.map(([url, init]) => [url, init.method || 'GET'])).toEqual([
      ['/api/v1/tenants/tenant-a/canvases/canvas-a/graph-runs/operations/operation-a/cancel', 'POST'],
      ['/api/v1/tenants/tenant-a/canvases/canvas-a/graph-runs/graph-a', 'GET'],
    ]);
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
    const fetcher = vi.fn(async (url: string, init: RequestInit = {}) => init.method === 'POST'
      ? json({ confirmed: true, graphId: 'graph-a', status: 'cancelled' }) : json(url.endsWith('/graph-runs/graph-a') ? terminal : { items: [graphRunSummary(terminal)] }));
    vi.stubGlobal('fetch', fetcher);
    const recovered = await observeCloudGraph(journal);
    expect(recovered.nodes.a).toMatchObject({ state: 'done', output: 'Completed before Stop', runId: 'run-a' });
    expect(recovered.nodes.b).toMatchObject({ state: 'cancelled', output: 'Last partial B', runId: 'run-b' });
    expect(journalSummary(recovered)).toMatchObject({ ok: false, done: 1, cancelled: 1 });
    expect(fetcher.mock.calls.map(([url, init]) => [url, init.method || 'GET'])).toEqual([
      ['/api/v1/tenants/tenant-a/canvases/canvas-a/graph-runs/operations/operation-a/cancel', 'POST'],
      ['/api/v1/tenants/tenant-a/canvases/canvas-a/graph-runs/graph-a', 'GET'],
    ]);
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
  it('captures knowledge revisions before a save wait and clears references when scope changes', async () => {
    configureSaaSCanvas({ tenant, canvasId: 'canvas-a' }); configureCanvasKnowledge(['revision-first']);
    let saved!: (version: number) => void;
    configureSaaSCanvasSave(() => new Promise<number>(resolve => { saved = resolve; }));
    const fetcher = vi.fn(async (_url: string, _init: RequestInit = {}) => json(snapshot())); vi.stubGlobal('fetch', fetcher);
    const result = submitCloudGraph('operation-a', ['a']);
    configureCanvasKnowledge(['revision-later']); saved(17); await result;
    expect(JSON.parse(fetcher.mock.calls[0]![1].body as string).knowledgeRevisionIds).toEqual(['revision-first']);
    configureSaaSCanvas({ tenant, canvasId: 'canvas-b' }); expect(canvasKnowledgeRevisionIds()).toEqual([]);
  });
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

  it('reads the node a refusal of the whole canvas was refused for, and claims none where the service named none', async () => {
    const refusal = async (body: unknown, status = 400) => {
      configureSaaSCanvas({ tenant, canvasId: 'canvas-a' }); configureSaaSCanvasSave(async () => 17);
      vi.stubGlobal('fetch', vi.fn(async () => json(body, status)));
      return submitCloudGraph('operation-a', ['a']).catch(error => error);
    };
    // A media node's own saved settings refuse the whole canvas; the service carries that node's id.
    expect(graphRefusedNodeId(await refusal({ error: { code: 'media_params_invalid', message: 'Node media settings are invalid for its model', details: { nodeId: 'vid' } } })))
      .toBe('vid');
    expect(graphRefusedNodeId(await refusal({ error: { code: 'node_setup_required', message: 'Initialize the node', details: { nodeId: 'vid' } } }, 409))).toBe('vid');
    // The deployment's own refusals, and every other refusal, name no node: nothing is invented for them.
    expect(graphRefusedNodeId(await refusal({ error: { code: 'media_unavailable', message: 'Not configured', details: {} } }, 503))).toBeNull();
    expect(graphRefusedNodeId(await refusal({ error: { code: 'version_conflict', message: 'Changed' } }, 409))).toBeNull();
    // A detail that is not a node's id is no node: an empty string, another type, a missing details object.
    expect(graphRefusedNodeId(await refusal({ error: { code: 'media_params_invalid', message: 'Invalid', details: { nodeId: '' } } }))).toBeNull();
    expect(graphRefusedNodeId(await refusal({ error: { code: 'media_params_invalid', message: 'Invalid', details: { nodeId: 7 } } }))).toBeNull();
    expect(graphRefusedNodeId(new GraphNotSubmittedError('never sent'))).toBeNull();
    expect(graphRefusedNodeId(new TypeError('Failed to fetch'))).toBeNull();
  });
});
