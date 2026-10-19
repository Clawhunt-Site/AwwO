import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { CanvasList } from '../src/saas/CanvasList';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import { setCanvasStoreForTests, workspaceStoragePrefix } from '../src/canvas/canvasStorage';
import { createCanvasStore } from '../src/canvas/canvasStore';
import { resetCanvasStorageEvictionForTests } from '../src/saas/canvasStorageEviction';
import type { CanvasListItem, Tenant } from '../src/saas/api';
import { channelHub, countedLocks, memoryBackend, quotaStorage } from './saas-canvas-store-fakes';

// The canvas list, once its first page is read and the page is idle, forgets what this browser keeps of the account's
// canvases the server no longer has.
const tenant: Tenant = { id: 'tenant-a', name: 'Workspace A', role: 'owner', status: 'active', maxConcurrentRuns: 2, maxRunsPerDay: 10 };
const W = workspaceStoragePrefix('user-a', 'tenant-a');
const id = (n: number) => 'a' + String(n).padStart(32, 'x');
const item = (canvas: string): CanvasListItem => ({ id: canvas, tenantId: tenant.id, name: `Canvas ${canvas.slice(-2)}`, version: 1,
  createdAt: '2026-10-19T00:00:00Z', updatedAt: '2026-10-19T00:00:00Z', outline: { nodes: [], edges: [], nodeCount: 0 } });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

let local: ReturnType<typeof quotaStorage>;
let backend: ReturnType<typeof memoryBackend>;
let idle: Array<() => void>;
let requests: string[];
const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')!;
beforeEach(() => {
  local = quotaStorage(); backend = memoryBackend(); idle = []; requests = [];
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: local.storage });
  localStorage.setItem('superclaw_locale', 'zh');
  Object.defineProperty(navigator.locks, 'query', { configurable: true, value: async () => ({ held: [], pending: [] }) });
  setCanvasStoreForTests(createCanvasStore({ backend: async () => backend.backend, channel: channelHub().channel, locks: countedLocks().locks,
    legacy: local.storage, flushDelay: 5, peerWait: 50, watchPage: false }));
  resetCanvasStorageEvictionForTests();
  vi.stubGlobal('requestIdleCallback', (callback: () => void) => { idle.push(callback); return idle.length; });
});
afterEach(() => {
  cleanup(); vi.unstubAllGlobals(); setCanvasStoreForTests(null);
  Object.defineProperty(globalThis, 'localStorage', original);
  delete (navigator.locks as { query?: unknown }).query;
});

function serve(pages: Array<{ items: CanvasListItem[]; nextCursor: string | null }>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    requests.push(`${init.method ?? 'GET'} ${url}`);
    if (init.method === 'HEAD') return new Response(null, { status: 404 });
    const cursor = new URL(url, 'http://test').searchParams.get('cursor');
    return json(pages[cursor ? Number(cursor) : 0]);
  }));
}

it('forgets, once the page is idle, the copies of a canvas the list no longer has and the server says is gone', async () => {
  const [listed, deleted] = [1, 2].map(id);
  local.storage.setItem(`${W}${listed}:superclaw.canvas.v2`, '{"listed":true}');
  local.storage.setItem(`${W}${deleted}:superclaw.canvas.v2`, '{"deleted elsewhere":true}');
  backend.records.set(`${W}${deleted}:awwo.cloud.baseline.v1`, { k: `${W}${deleted}:awwo.cloud.baseline.v1`, v: '{}', c: 1, p: 'x', t: 1 });
  serve([{ items: [item(listed)], nextCursor: null }]);
  render(<SaaSPreferencesProvider><CanvasList tenant={tenant} userId="user-a" onOpen={vi.fn()} /></SaaSPreferencesProvider>);
  await screen.findByRole('heading', { name: `Canvas ${listed.slice(-2)}` });
  // Nothing before the page is idle.
  expect(requests.filter(line => line.startsWith('HEAD'))).toEqual([]);
  expect(idle).toHaveLength(1);
  await act(async () => { idle[0](); });
  await waitFor(() => expect(local.storage.getItem(`${W}${deleted}:superclaw.canvas.v2`)).toBeNull());
  await waitFor(() => expect(backend.value(`${W}${deleted}:awwo.cloud.baseline.v1`)).toBeNull());
  expect(requests.filter(line => line.startsWith('HEAD'))).toEqual([`HEAD /api/v1/tenants/tenant-a/canvases/${deleted}`]);
  expect(local.storage.getItem(`${W}${listed}:superclaw.canvas.v2`)).toBe('{"listed":true}');
});

it('reads the rest of a longer list on from its first page\'s cursor before it forgets anything, and keeps a canvas on a later page', async () => {
  const [first, later, deleted] = [3, 4, 5].map(id);
  local.storage.setItem(`${W}${later}:superclaw.canvas.v2`, '{"on page two":true}');
  local.storage.setItem(`${W}${deleted}:superclaw.canvas.v2`, '{"deleted":true}');
  serve([{ items: [item(first)], nextCursor: '1' }, { items: [item(later)], nextCursor: null }]);
  render(<SaaSPreferencesProvider><CanvasList tenant={tenant} userId="user-a" onOpen={vi.fn()} /></SaaSPreferencesProvider>);
  await screen.findByRole('heading', { name: `Canvas ${first.slice(-2)}` });
  await waitFor(() => expect(idle).toHaveLength(1));
  await act(async () => { idle[0](); });
  await waitFor(() => expect(local.storage.getItem(`${W}${deleted}:superclaw.canvas.v2`)).toBeNull());
  expect(local.storage.getItem(`${W}${later}:superclaw.canvas.v2`)).toBe('{"on page two":true}');
  expect(requests.filter(line => line.includes('limit=200'))).toEqual(['GET /api/v1/tenants/tenant-a/canvases?view=summary&limit=200&cursor=1']);
  expect(requests.filter(line => line.startsWith('HEAD'))).toEqual([`HEAD /api/v1/tenants/tenant-a/canvases/${deleted}`]);
});

it('leaves everything to a list read without an account', async () => {
  local.storage.setItem(`${W}${id(6)}:superclaw.canvas.v2`, '{}');
  serve([{ items: [item(id(7))], nextCursor: null }]);
  render(<SaaSPreferencesProvider><CanvasList tenant={tenant} onOpen={vi.fn()} /></SaaSPreferencesProvider>);
  await screen.findByRole('heading', { name: `Canvas ${id(7).slice(-2)}` });
  expect(idle).toHaveLength(0);
  expect(local.storage.getItem(`${W}${id(6)}:superclaw.canvas.v2`)).toBe('{}');
});
