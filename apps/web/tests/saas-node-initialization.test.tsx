import { appearanceFixture } from './saas-appearance-fixture';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { SaaSApp } from '../src/saas/SaaSApp';
import { CANVAS_STORAGE_KEY, createSessionNode, emptyDocument, sanitizeDocument, saveDocument, type CanvasDocument } from '../src/canvas/canvasDoc';
import { canvasStorage, canvasStorageKey, configureCanvasStorage } from '../src/canvas/canvasStorage';
import { loadRunJournal } from '../src/canvas/runJournal';
import { canonicalCanvasDocumentJSON, isKnownSyncedCache, readCanvasDrafts } from '../src/saas/canvasDraft';
import { submitCloudGraph } from '../src/saas/graphRuns';
import * as bridge from '../src/saas/canvasBridge';
import type { CanvasRecord } from '../src/saas/api';

const tenant = { id: 'tenant-a', name: 'Workspace A', role: 'owner' as const, status: 'active' as const, maxConcurrentRuns: 2, maxRunsPerDay: 10 };
const identity = { user: { id: 'user-a', name: 'Alice', email: 'a@example.test', platformRole: 'user' }, tenants: [tenant] };
const canvasPath = '/api/v1/tenants/tenant-a/canvases/canvas-a';
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const record = (document: CanvasDocument, version = 7): CanvasRecord => ({
  id: 'canvas-a', tenantId: 'tenant-a', name: 'Team canvas', document, version, createdAt: '', updatedAt: '',
});
const documentWith = (title = 'Original node'): CanvasDocument => sanitizeDocument({
  ...emptyDocument(), updatedAt: 1, view: { x: 0, y: 0, scale: 1 },
  nodes: [{ ...createSessionNode('llm', { x: 0, y: 0 }), id: 'node-a', title, runtime: '', model: '', persona: 'Original persona' }],
});
function initialized(value: CanvasRecord, scope?: readonly string[]): CanvasRecord {
  const source = value.document as CanvasDocument;
  return record({ ...source, nodes: source.nodes.map(node => {
    if (node.kind !== 'session' || (scope && !scope.includes(node.id))) return node;
    const binding = { companyId: 'tenant-a', agentId: 'agent-initialized', agentName: node.title };
    const issueId = node.issueId || 'session-initialized';
    return { ...node, runtime: 'pi', model: 'profile-main', bindAttempt: null, binding, issueId,
      ...(node.threads ? { threads: node.threads.map(thread => thread.id === (node.activeThreadId || 'default')
        ? { ...thread, binding, issueId, runtime: 'pi', model: 'profile-main' } : thread) } : {}),
    };
  }) }, value.version + 1);
}
type Mutation = { url: string; method: string; body: any };
type InitializeHandler = (body: any, current: CanvasRecord) => Promise<Response> | Response;
function server(initial = record(documentWith())) {
  const state = { cloud: initial, mutations: [] as Mutation[], initialize: undefined as InitializeHandler | undefined };
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    if (method !== 'GET') state.mutations.push({ url, method, body });
    if (url.endsWith('/appearance')) return response(appearanceFixture);
    if (url.endsWith('/auth/me')) return response(identity);
    if (url.endsWith('/runtime')) return response({ configured: true, available: true, model: 'profile-main', models: [{ id: 'profile-main', name: 'Fixture model' }] });
    if (url === canvasPath && method === 'PUT') {
      if (body.version !== state.cloud.version) return response({ error: { code: 'version_conflict', message: 'Changed elsewhere' } }, 409);
      state.cloud = record(body.document, body.version + 1);
      return response(state.cloud);
    }
    if (url === `${canvasPath}/initialize` && method === 'POST') {
      if (state.initialize) return state.initialize(body, state.cloud);
      state.cloud = initialized(state.cloud);
      return response(state.cloud);
    }
    if (url === `${canvasPath}/graph-runs` && method === 'POST') return response({
      id: 'graph-initialized', operationId: body.operationId, canvasId: 'canvas-a', documentVersion: body.documentVersion,
      document: state.cloud.document, scope: body.scope, status: 'queued', createdAt: '', nodes: [],
    }, 202);
    if (url === canvasPath) return response(state.cloud);
    return response({ items: [], models: [] });
  }));
  return state;
}
async function writerReady() {
  await waitFor(() => {
    expect(document.querySelector('.awwo-workspace')).not.toBeNull();
    expect(vi.mocked(bridge.configureSaaSCanvasSave).mock.lastCall?.[0]).toBeTypeOf('function');
    expect(vi.mocked(bridge.configureSaaSCanvasInitialize).mock.lastCall?.[0]).toBeTypeOf('function');
  });
}
function startInitialization(scope: readonly string[] = ['node-a']) {
  // Attach rejection handling immediately: the real mutation may finish before a deferred test resumes.
  let result!: Promise<{ document: CanvasDocument; error?: never } | { error: unknown; document?: never }>;
  act(() => { result = bridge.initializeSaaSCanvas(scope).then(document => ({ document }), error => ({ error })); });
  return result;
}
async function expectInitializationFailure(result: ReturnType<typeof startInitialization>) {
  let outcome!: Awaited<typeof result>;
  await act(async () => { outcome = await result; });
  expect(outcome.error).toBeInstanceOf(Error);
  expect(outcome.document).toBeUndefined();
  expect(loadRunJournal()).toBeNull();
}

beforeEach(() => {
  vi.spyOn(bridge, 'configureSaaSCanvasSave');
  vi.spyOn(bridge, 'configureSaaSCanvasInitialize');
  localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh');
  configureCanvasStorage('user-a', 'tenant-a', 'canvas-a');
  window.history.replaceState({}, '', '/?tenant=tenant-a&canvas=canvas-a');
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => {
  cleanup(); bridge.clearSaaSCanvas(); bridge.configureSaaSCanvasSave(null); bridge.configureSaaSCanvasInitialize(null);
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

it('flushes the actual draft before initialization and immediately admits the graph with the canonical version and bindings', async () => {
  const state = server(); render(<SaaSApp />); await writerReady();
  const edited = documentWith('Saved configuration');
  if (edited.nodes[0].kind === 'session') edited.nodes[0].persona = 'Use the newly saved persona';
  act(() => { expect(saveDocument(edited)).toBe(true); });
  let canonical!: CanvasDocument;
  await act(async () => { canonical = await bridge.initializeSaaSCanvas(['node-a']); });
  expect(state.mutations.map(item => [item.method, item.url])).toEqual([
    ['PUT', canvasPath], ['POST', `${canvasPath}/initialize`],
  ]);
  expect(state.mutations[0].body).toMatchObject({ version: 7, document: { nodes: [{ title: 'Saved configuration', persona: 'Use the newly saved persona' }] } });
  expect(state.mutations[1].body).toEqual({ documentVersion: 8, scope: ['node-a'] });
  expect(canonical.nodes[0]).toMatchObject({ runtime: 'pi', model: 'profile-main', binding: { agentId: 'agent-initialized' } });
  expect(canonicalCanvasDocumentJSON(JSON.parse(canvasStorage().getItem(CANVAS_STORAGE_KEY)!))).toBe(canonicalCanvasDocumentJSON(canonical));
  expect(canvasStorage().getItem('awwo.cloud.version')).toBe('9');
  expect(isKnownSyncedCache(canvasStorage(), canonical)).toBe(true);
  expect(readCanvasDrafts(canvasStorage())).toHaveLength(0);
  expect(loadRunJournal()).toBeNull();
  await act(async () => {
    expect(await bridge.flushSaaSCanvas()).toBe(9);
    const graph = await submitCloudGraph('operation-after-initialize', ['node-a']);
    expect(graph.documentVersion).toBe(9);
    expect(graph.document?.nodes[0]).toMatchObject({ binding: { agentId: 'agent-initialized' } });
  });
  expect(state.mutations.at(-1)?.body).toEqual({ operationId: 'operation-after-initialize', scope: ['node-a'], documentVersion: 9 });
  expect(state.mutations.filter(item => item.method === 'PUT')).toHaveLength(1);
});

it('adopts canonical identity without creating a new dirty save, and retains old conversation history on refresh', async () => {
  const source = documentWith();
  const node = source.nodes[0];
  if (node.kind !== 'session') throw new Error('Expected session');
  node.activeThreadId = 'new-thread';
  node.threads = [
    { id: 'old-thread', title: 'Old conversation', issueId: 'old-session', preview: 'Prior answer', draft: '', createdAt: 1,
      binding: { companyId: 'tenant-a', agentId: 'old-agent', agentName: 'Old agent' }, runtime: 'pi', model: 'old-model', persona: 'Old persona' },
    { id: 'new-thread', title: 'New configuration', issueId: null, preview: '', draft: 'Keep this draft', createdAt: 2,
      binding: null, runtime: '', model: '', persona: 'Original persona' },
  ];
  const state = server(record(source)); render(<SaaSApp />); await writerReady();
  let canonical!: CanvasDocument;
  await act(async () => { canonical = await bridge.initializeSaaSCanvas(); });
  expect(canonical.nodes[0]).toMatchObject({ activeThreadId: 'new-thread', issueId: 'session-initialized', threads: [
    node.threads[0], { ...node.threads[1], binding: { agentId: 'agent-initialized' }, issueId: 'session-initialized', runtime: 'pi', model: 'profile-main' },
  ] });
  await act(async () => { expect(await bridge.flushSaaSCanvas()).toBe(8); });
  expect(state.mutations.map(item => item.method)).toEqual(['POST']);
  cleanup(); bridge.clearSaaSCanvas(); bridge.configureSaaSCanvasSave(null); bridge.configureSaaSCanvasInitialize(null);
  render(<SaaSApp />); await writerReady();
  expect(screen.queryByRole('heading', { name: '发现未同步的本机草稿' })).toBeNull();
  expect(readCanvasDrafts(canvasStorage())).toHaveLength(0);
  expect(JSON.parse(canvasStorage().getItem(CANVAS_STORAGE_KEY)!).nodes[0].threads[0]).toMatchObject({ issueId: 'old-session', binding: { agentId: 'old-agent' }, persona: 'Old persona' });
  expect(state.mutations.map(item => item.method)).toEqual(['POST']);
});

it.each(['lost-response', 'version-conflict', 'unknown-503'] as const)('%s preserves the initialization input and requires recovery before another mutation', async failure => {
  const state = server();
  state.initialize = (_body, current) => {
    state.cloud = failure === 'lost-response' ? initialized(current) : record(documentWith('Other device owns this version'), current.version + 1);
    if (failure === 'lost-response') throw new TypeError('Initialization response was lost');
    if (failure === 'unknown-503') return response({ error: { code: 'proxy_unavailable', message: 'The upstream response could not be confirmed' } }, 503);
    return response({ error: { code: 'version_conflict', message: 'Changed elsewhere' } }, 409);
  };
  render(<SaaSApp />); await writerReady();
  await expectInitializationFailure(startInitialization());
  expect(readCanvasDrafts(canvasStorage()).some(item => item.draft?.document.nodes[0].title === 'Original node')).toBe(true);
  expect(canvasStorage().getItem(CANVAS_STORAGE_KEY)).toContain('Original node');
  expect(document.querySelector('.saas-error-banner')).not.toBeNull();
  expect(screen.getByRole('button', { name: '重新加载' })).toBeVisible();
  await expectInitializationFailure(startInitialization());
  await act(async () => { await expect(bridge.flushSaaSCanvas()).rejects.toThrow(); });
  expect(state.mutations.map(item => [item.method, item.url])).toEqual([['POST', `${canvasPath}/initialize`]]);
});

it.each([{ status: 400, code: 'invalid_input' }, { status: 409, code: 'resource_in_use' },
  { status: 503, code: 'runtime_unavailable' }, { status: 503, code: 'database_unavailable' },
])('allows an explicit retry after definite $code rejection', async ({ status, code }) => {
  const state = server(); let attempts = 0;
  state.initialize = (_body, current) => {
    if (++attempts === 1) return response({ error: { code, message: 'Initialization was not accepted' } }, status);
    state.cloud = initialized(current); return response(state.cloud);
  };
  render(<SaaSApp />); await writerReady();
  await expectInitializationFailure(startInitialization());
  expect(readCanvasDrafts(canvasStorage())).toHaveLength(0);
  await act(async () => {
    const canonical = await bridge.initializeSaaSCanvas(['node-a']);
    expect(canonical.nodes[0]).toMatchObject({ binding: { agentId: 'agent-initialized' } });
    expect(await bridge.flushSaaSCanvas()).toBe(8);
  });
  expect(state.mutations.map(item => item.body)).toEqual([
    { documentVersion: 7, scope: ['node-a'] }, { documentVersion: 7, scope: ['node-a'] },
  ]);
  expect(document.querySelector('.saas-error-banner')).toBeNull();
});

it('retains a newer local edit when initialization returns the older canonical document', async () => {
  const state = server(); let resolve!: (value: Response) => void; let accepted!: CanvasRecord;
  state.initialize = (_body, current) => { accepted = initialized(current); return new Promise(done => { resolve = done; }); };
  render(<SaaSApp />); await writerReady(); const result = startInitialization();
  await waitFor(() => expect(resolve).toBeTypeOf('function'));
  const newer = documentWith('Edited during initialization');
  act(() => { expect(saveDocument(newer)).toBe(true); });
  await act(async () => { state.cloud = accepted; resolve(response(accepted)); });
  await expectInitializationFailure(result);
  expect(JSON.parse(canvasStorage().getItem(CANVAS_STORAGE_KEY)!).nodes[0].title).toBe('Edited during initialization');
  expect(readCanvasDrafts(canvasStorage()).some(item => item.draft?.document.nodes[0].title === 'Edited during initialization')).toBe(true);
  await act(async () => { await expect(bridge.flushSaaSCanvas()).rejects.toThrow(); });
  expect(state.mutations.map(item => item.method)).toEqual(['POST']);
});

it('serializes concurrent initialization scopes against the version returned by the preceding request', async () => {
  const source = documentWith();
  source.nodes.push({ ...source.nodes[0], id: 'node-b', title: 'Second node' });
  const state = server(record(source)); let resolveFirst!: () => void; let calls = 0;
  state.initialize = (body, current) => {
    calls++;
    const accepted = initialized(current, body.scope);
    if (calls === 1) return new Promise(done => { resolveFirst = () => { state.cloud = accepted; done(response(accepted)); }; });
    state.cloud = accepted;
    return response(accepted);
  };
  render(<SaaSApp />); await writerReady();
  const first = startInitialization(['node-a']); const second = startInitialization(['node-b']);
  await waitFor(() => expect(resolveFirst).toBeTypeOf('function'));
  await act(async () => { await Promise.resolve(); });
  const callsBeforeFirstResponse = calls;
  let outcomes!: Awaited<typeof first>[];
  await act(async () => { resolveFirst(); outcomes = await Promise.all([first, second]); });
  expect(callsBeforeFirstResponse).toBe(1);
  expect(outcomes.every(item => item.error === undefined)).toBe(true);
  expect(outcomes[1].document?.nodes[1]).toMatchObject({ binding: { agentId: 'agent-initialized' } });
  expect(state.mutations.map(item => item.body)).toEqual([
    { documentVersion: 7, scope: ['node-a'] }, { documentVersion: 8, scope: ['node-b'] },
  ]);
  expect(canvasStorage().getItem('awwo.cloud.version')).toBe('9');
  expect(readCanvasDrafts(canvasStorage())).toHaveLength(0);
  expect(loadRunJournal()).toBeNull();
});

it('does not overwrite a newer other-tab cache or roll its version backwards after a delayed response', async () => {
  const state = server(); let resolve!: (value: Response) => void; let accepted!: CanvasRecord;
  state.initialize = (_body, current) => { accepted = initialized(current); return new Promise(done => { resolve = done; }); };
  render(<SaaSApp />); await writerReady(); const result = startInitialization();
  await waitFor(() => expect(resolve).toBeTypeOf('function'));
  const cacheKey = canvasStorageKey(CANVAS_STORAGE_KEY); const changed = JSON.stringify(documentWith('Newer other-tab edit'));
  act(() => {
    // Native storage events do not run the same-tab custom cache-write listener.
    localStorage.setItem(cacheKey, changed);
    localStorage.setItem(canvasStorageKey('awwo.cloud.version'), '11');
    window.dispatchEvent(new StorageEvent('storage', { key: cacheKey, newValue: changed }));
  });
  await act(async () => { resolve(response(accepted)); });
  await expectInitializationFailure(result);
  expect(canvasStorage().getItem(CANVAS_STORAGE_KEY)).toBe(changed);
  expect(canvasStorage().getItem('awwo.cloud.version')).toBe('11');
  expect(state.mutations.map(item => item.method)).toEqual(['POST']);
});

it('keeps a delayed initialization scoped to its original canvas when the editor is unmounted', async () => {
  const state = server(); let resolve!: (value: Response) => void; let accepted!: CanvasRecord;
  state.initialize = (_body, current) => { accepted = initialized(current); return new Promise(done => { resolve = done; }); };
  render(<SaaSApp />); await writerReady(); const result = startInitialization();
  await waitFor(() => expect(resolve).toBeTypeOf('function'));
  cleanup();
  configureCanvasStorage('user-b', 'tenant-b', 'canvas-b');
  const nextStorage = canvasStorage(); const untouched = JSON.stringify(documentWith('Other account document'));
  nextStorage.setItem(CANVAS_STORAGE_KEY, untouched); nextStorage.setItem('awwo.cloud.version', '25');
  bridge.configureSaaSCanvas({ tenant: { ...tenant, id: 'tenant-b' }, canvasId: 'canvas-b' });
  await act(async () => { resolve(response(accepted)); });
  await expectInitializationFailure(result);
  expect(nextStorage.getItem(CANVAS_STORAGE_KEY)).toBe(untouched);
  expect(nextStorage.getItem('awwo.cloud.version')).toBe('25');
  expect(state.mutations.map(item => item.url)).toEqual([`${canvasPath}/initialize`]);
});

it.each(['canvas', 'tenant', 'older-version', 'missing-version', 'fractional-version'] as const)('rejects a canonical response with the wrong %s', async mismatch => {
  const state = server();
  state.initialize = (_body, current) => response({ ...initialized(current),
    ...(mismatch === 'canvas' ? { id: 'canvas-other' } : mismatch === 'tenant' ? { tenantId: 'tenant-other' }
      : { version: mismatch === 'missing-version' ? undefined : mismatch === 'fractional-version' ? current.version + 0.5 : current.version - 1 }),
  });
  render(<SaaSApp />); await writerReady();
  await expectInitializationFailure(startInitialization());
  expect(JSON.parse(canvasStorage().getItem(CANVAS_STORAGE_KEY)!).nodes[0].binding).toBeNull();
  expect(canvasStorage().getItem('awwo.cloud.version')).toBe('7');
  expect(state.mutations.map(item => item.method)).toEqual(['POST']);
});
