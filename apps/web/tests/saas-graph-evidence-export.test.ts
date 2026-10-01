import { afterEach, expect, it, vi } from 'vitest';
import { createSessionNode, emptyDocument } from '../src/canvas/canvasDoc';
import { collectGraphEvidence, GRAPH_EVIDENCE_LIMITS } from '../src/saas/graphEvidenceExport';

const scope = { tenantId: 'tenant-a', canvasId: 'canvas-a', graphId: 'graph-a' };
const path = '/api/v1/tenants/tenant-a/canvases/canvas-a/graph-runs/graph-a';
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const graph = (ids = ['a'], patch = {}) => ({ id: 'graph-a', canvasId: 'canvas-a', operationId: 'operation-a', documentVersion: 2,
  document: { ...emptyDocument(), nodes: ids.map(id => ({ ...createSessionNode('llm', { x: 0, y: 0 }), id })) },
  scope: ids, nodes: ids.map(id => ({ nodeId: id, state: 'done', runId: `run-${id}`, sessionId: `session-${id}` })),
  status: 'completed', createdAt: '2026-10-01T01:00:00Z', ...patch });
const record = (id: string, patch = {}) => ({ id, tenantId: 'tenant-a', sessionId: id.replace('run-', 'session-'), status: 'completed', output: 'Actual saved output', ...patch });
const evidence = (id: string, patch = {}) => ({ runId: id, status: 'completed', outputPresent: true, outputBytes: 19, artifactCount: 0,
  contract: { declared: true, validated: true }, manualAcceptance: { required: true, verified: false },
  evidenceSources: ['model_output', 'contract_validated'], observational: true, preview: 'Actual saved output', previewTruncated: false, ...patch });
const invocation = (id: string, n = 1) => ({ id: `${id}-call-${n}`, runId: id, runtime: 'pi', provider: 'llmgate', modelId: 'qwen3.8', providerModel: 'qwen3.8', status: 'completed', usageStatus: 'reported',
  usage: { inputTokens: '11', outputTokens: '19', cachedInputTokens: null, cacheWriteTokens: null, reasoningTokens: null, providerTotalTokens: '30', computedTotalTokens: '30' } });
const page = (id: string) => ({ items: [invocation(id)], page: { nextCursor: null } });
function server(snapshot = graph(), override?: (url: URL, init: RequestInit) => Response | undefined | Promise<Response | undefined>) {
  const fetcher = vi.fn(async (raw: string, init: RequestInit = {}) => {
    const url = new URL(raw, 'http://local.test');
    const overridden = await override?.(url, init);
    if (overridden) return overridden;
    if (url.pathname === path) return json(snapshot);
    const match = /\/runs\/(run-[^/]+)(\/evidence|\/invocations)?$/.exec(url.pathname);
    if (match) return json(match[2] === '/evidence' ? evidence(match[1]) : match[2] === '/invocations' ? page(match[1]) : record(match[1]));
    throw new Error('Unexpected URL');
  });
  vi.stubGlobal('fetch', fetcher); return fetcher;
}
const collect = () => collectGraphEvidence(scope, new AbortController().signal);
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

it('exports a freshly fetched frozen graph, full invocation pagination and exact scoped GET identities', async () => {
  const snapshot = graph();
  const fetcher = server(snapshot, url => url.pathname.endsWith('/invocations') ? json(url.searchParams.has('cursor')
    ? { items: [invocation('run-a', 2)], page: { nextCursor: null } }
    : { items: [invocation('run-a')], page: { nextCursor: 'next-page' } }) : undefined);
  const result = await collect();
  expect(result.graph).toEqual(snapshot);
  expect(result.schemaVersion).toBe(1);
  expect(result.runs[0].invocations).toMatchObject({ pagesRead: 2, nextCursor: null, complete: true });
  expect(result.runs[0].invocations.items.map(item => item.id)).toEqual(['run-a-call-1', 'run-a-call-2']);
  expect(result.completeness).toMatchObject({ complete: true, status: 'complete', graphStable: true });
  expect(result.coverage).toMatchObject({ atomicSnapshot: false, manualAcceptance: 'not-assessed', redacted: false });
  expect(fetcher.mock.calls.filter(([url]) => url === path)).toHaveLength(2);
  for (const [url, init] of fetcher.mock.calls) {
    expect(url).toMatch(/^\/api\/v1\/tenants\/tenant-a\//);
    expect(init?.method).toBeUndefined(); expect(init?.credentials).toBe('include');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  }
  expect(fetcher.mock.calls.some(([url]) => url.includes('cursor=next-page'))).toBe(true);
  expect(fetcher.mock.calls.some(([url]) => url.endsWith('/archive'))).toBe(false);
});

it('limits all endpoint reads to two concurrent requests without dropping either run', async () => {
  let active = 0, peak = 0;
  server(graph(['a', 'b', 'c']), async () => {
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, 1)); --active;
    return undefined;
  });
  const result = await collect();
  expect(peak).toBe(2); expect(result.runs).toHaveLength(3); expect(result.completeness.complete).toBe(true);
});

it('records partial network failures while keeping independently observed node data', async () => {
  server(graph(['a', 'b']), url => url.pathname.endsWith('/run-a/evidence') ? json({ error: { code: 'database_unavailable', message: 'do not copy raw diagnostic' } }, 503) : undefined);
  const result = await collect();
  expect(result.completeness).toMatchObject({ complete: false, status: 'partial' });
  expect(result.errors).toContainEqual({ stage: 'evidence', runId: 'run-a', code: 'database_unavailable', status: 503 });
  expect(result.runs[0].record).not.toBeNull(); expect(result.runs[0].evidence).toBeNull();
  expect(result.runs[0].invocations.complete).toBe(true); expect(result.runs[1].complete).toBe(true);
  expect(JSON.stringify(result)).not.toContain('do not copy raw diagnostic');
});

it('retains previously read pages but never reports a failed later page as complete', async () => {
  server(graph(), url => url.pathname.endsWith('/invocations') ? url.searchParams.has('cursor')
    ? json({ error: { code: 'unavailable' } }, 500)
    : json({ items: [invocation('run-a')], page: { nextCursor: 'page-two' } }) : undefined);
  const result = await collect();
  expect(result.runs[0].invocations).toMatchObject({ pagesRead: 1, nextCursor: 'page-two', complete: false });
  expect(result.runs[0].invocations.items).toHaveLength(1);
  expect(result.completeness.complete).toBe(false);
});

it('marks active snapshots in-progress even when every current call page was read', async () => {
  server(graph(['a'], { status: 'running' }));
  const result = await collect();
  expect(result.runs[0].complete).toBe(true);
  expect(result.completeness).toMatchObject({ complete: false, inProgress: true, status: 'in-progress' });
});

it('detects graph changes during collection without replacing its original frozen snapshot', async () => {
  let reads = 0; const snapshot = graph();
  server(snapshot, url => url.pathname === path ? json(++reads === 1 ? snapshot : { ...snapshot, updatedAt: 'later' }) : undefined);
  const result = await collect();
  expect(result.graph).toEqual(snapshot); expect(result.completeness.graphStable).toBe(false);
  expect(result.errors).toContainEqual({ stage: 'graph_recheck', code: 'graph_changed_during_export' });
});

it.each([{ id: 'other-graph' }, { canvasId: 'other-canvas' }, { tenantId: 'other-tenant' }])('rejects a mismatched graph before reading any run: %j', async patch => {
  const fetcher = server(graph(['a'], patch));
  await expect(collect()).rejects.toMatchObject({ code: 'invalid_graph_evidence' });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it.each([{ tenantId: 'other-tenant' }, { id: 'other-run' }, { sessionId: 'other-session' }])('omits mismatched node run data and never follows its evidence endpoints: %j', async patch => {
  const fetcher = server(graph(), url => url.pathname.endsWith('/runs/run-a') ? json(record('run-a', { ...patch, output: 'FOREIGN DATA' })) : undefined);
  const result = await collect();
  expect(result.completeness.complete).toBe(false);
  expect(result.errors).toContainEqual({ stage: 'run', runId: 'run-a', code: 'invalid_run_binding', status: 502 });
  expect(JSON.stringify(result)).not.toContain('FOREIGN DATA');
  expect(fetcher.mock.calls.some(([url]) => /\/(evidence|invocations)/.test(url))).toBe(false);
});

it.each([401, 403, 404])('does not export earlier observations after final graph access is denied or missing (%s)', async status => {
  let reads = 0;
  server(graph(), url => url.pathname === path && ++reads > 1 ? json({ error: { code: status === 404 ? 'not_found' : 'forbidden' } }, status) : undefined);
  await expect(collect()).rejects.toMatchObject({ status });
});

it('cancels the other collector immediately when a parallel read loses authorization', async () => {
  let parallelSignal: AbortSignal | undefined;
  server(graph(['a', 'b', 'c']), async (url, init) => {
    if (url.pathname.endsWith('/runs/run-a')) {
      await vi.waitFor(() => expect(parallelSignal).toBeDefined());
      return json({ error: { code: 'forbidden' } }, 403);
    }
    if (url.pathname.endsWith('/runs/run-b')) {
      parallelSignal = init.signal as AbortSignal;
      return new Promise<Response>((_, reject) => parallelSignal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
    }
  });
  await expect(collect()).rejects.toMatchObject({ status: 403 });
  expect(parallelSignal!.aborted).toBe(true);
});

it('does not include a ledger page belonging to another run', async () => {
  server(graph(), url => url.pathname.endsWith('/invocations') ? json(page('other-run')) : undefined);
  const result = await collect();
  expect(result.runs[0].invocations.items).toEqual([]);
  expect(result.errors).toContainEqual({ stage: 'invocations', runId: 'run-a', code: 'invalid_run_invocations', status: 502 });
  expect(result.completeness.complete).toBe(false);
});

it('marks a missing frozen document incomplete and rejects a document from another tenant', async () => {
  server(graph(['a'], { document: undefined }));
  const result = await collect();
  expect(result.errors).toContainEqual({ stage: 'graph', code: 'frozen_document_missing' });
  expect(result.completeness.complete).toBe(false);
  const snapshot = graph();
  snapshot.document.nodes[0].binding = { companyId: 'tenant-b', agentId: 'agent-b', agentName: 'Other agent' };
  const fetcher = server(snapshot);
  await expect(collect()).rejects.toMatchObject({ code: 'invalid_graph_evidence' });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('ends a stalled read at the deadline and labels the remaining export partial', async () => {
  vi.useFakeTimers(); let requested: AbortSignal | undefined;
  server(graph(), async (url, init) => {
    if (!url.pathname.endsWith('/runs/run-a')) return;
    requested = init.signal as AbortSignal;
    return new Promise<Response>((_, reject) => requested!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
  });
  const pending = collect();
  await vi.advanceTimersByTimeAsync(GRAPH_EVIDENCE_LIMITS.timeoutMs);
  const result = await pending;
  expect(requested!.aborted).toBe(true);
  expect(result.completeness.complete).toBe(false);
  expect(result.errors).toContainEqual({ stage: 'run', runId: 'run-a', code: 'export_timeout' });
});

it('marks the page cap, preserves continuation cursor and does not invent completeness', async () => {
  let reads = 0;
  server(graph(), url => url.pathname.endsWith('/invocations') ? json({ items: [invocation('run-a', ++reads)], page: { nextCursor: 'cursor-'+reads } }) : undefined);
  const result = await collect();
  expect(reads).toBe(GRAPH_EVIDENCE_LIMITS.maxPagesPerRun);
  expect(result.runs[0].invocations.nextCursor).toBe('cursor-10');
  expect(result.completeness.boundsReached).toContain('maxPagesPerRun');
  expect(result.completeness.complete).toBe(false);
});

it('stops repeated cursors and duplicate ledger rows instead of looping or hiding inconsistency', async () => {
  server(graph(), url => url.pathname.endsWith('/invocations') ? json({ items: [invocation('run-a')], page: { nextCursor: 'same' } }) : undefined);
  const result = await collect();
  expect(result.runs[0].invocations.pagesRead).toBe(2);
  expect(result.runs[0].invocations.items).toHaveLength(1);
  expect(result.errors.some(error => error.code === 'repeated_invocation_page')).toBe(true);
  expect(result.completeness.complete).toBe(false);
});

it('bounds combined ledger rows across parallel runs', async () => {
  server(graph(['a', 'b', 'c', 'd', 'e', 'f']), url => {
    if (!url.pathname.endsWith('/invocations')) return;
    const id = url.pathname.split('/').at(-2)!;
    const offset = Number(url.searchParams.get('cursor') || '0');
    return json({ items: Array.from({ length: 100 }, (_, i) => invocation(id, offset+i)), page: { nextCursor: String(offset+100) } });
  });
  const result = await collect();
  expect(result.runs.reduce((sum, run) => sum+run.invocations.items.length, 0)).toBe(5000);
  expect(result.completeness.boundsReached).toContain('maxInvocations'); expect(result.completeness.complete).toBe(false);
});

it('marks omitted oversized records rather than silently truncating their output', async () => {
  server(graph(), url => url.pathname.endsWith('/runs/run-a') ? json(record('run-a', { output: 'x'.repeat(15*1024*1024) })) : undefined);
  const result = await collect();
  expect(result.runs[0].record).toBeNull(); expect(result.completeness.boundsReached).toContain('maxBytes');
  expect(result.errors.some(error => error.stage === 'run' && error.code === 'export_byte_limit')).toBe(true);
  expect(result.completeness.complete).toBe(false);
});

it('includes every collaboration turn run, deduplicating the final node references', async () => {
  const turns = [ ['a', 'proposal', 'run-a1'], ['b', 'proposal', 'run-b1'], ['a', 'review', 'run-a2'], ['b', 'review', 'run-b2'], ['a', 'synthesis', 'run-a3'] ].map(([nodeId, phase, runId], i) => ({ ordinal: i+1, nodeId, phase, runId, sessionId: 'session-'+nodeId, round: 1, status: 'completed' }));
  server(graph(['a', 'b'], { nodes: [{ nodeId: 'a', state: 'done', runId: 'run-a3', sessionId: 'session-a' }, { nodeId: 'b', state: 'done', runId: 'run-b2', sessionId: 'session-b' }],
    collaboration: { goal: 'Review results', rounds: 1, synthesizerNodeId: 'a', maxModelCalls: 5, phase: 'synthesis', round: 1, turns } }), url => {
    const id = /\/runs\/(run-[ab]\d)$/.exec(url.pathname)?.[1];
    return id ? json(record(id, { sessionId: 'session-'+id[4] })) : undefined;
  });
  const result = await collect();
  expect(new Set(result.runs.map(run => run.runId))).toEqual(new Set(['run-a1', 'run-a2', 'run-a3', 'run-b1', 'run-b2']));
  expect(result.completeness.complete).toBe(true);
});

it('aborts in-flight reads and never returns an old tenant export after cancellation', async () => {
  const controller = new AbortController(); let requested: AbortSignal | undefined;
  server(graph(), async (url, init) => {
    if (!url.pathname.endsWith('/runs/run-a')) return;
    requested = init.signal as AbortSignal;
    return new Promise<Response>((_, reject) => requested!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
  });
  const pending = collectGraphEvidence(scope, controller.signal);
  await vi.waitFor(() => expect(requested).toBeDefined());
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' }); expect(requested!.aborted).toBe(true);
});
