// Saving a hosted canvas that holds market nodes (SaaSApp.tsx, api.ts CANVAS_FEATURES_HEADER): every PUT says the page
// knows market nodes, and a save the API refuses for want of a newer page (409 canvas_reload_required) keeps the edit
// on this device and asks for a reload, as a conflicting save does.
import { appearanceFixture } from './saas-appearance-fixture';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { SaaSApp } from '../src/saas/SaaSApp';
import { createSessionNode, emptyDocument, saveDocument, type CanvasDocument } from '../src/canvas/canvasDoc';
import { CANVAS_MIRROR_GROUP, canvasStorage, configureCanvasStorage, keepLegacyCanvasCache, preserveRegisteredLegacyCache, setCanvasStoreForTests } from '../src/canvas/canvasStorage';
import { createCanvasStore } from '../src/canvas/canvasStore';
import { readCanvasDrafts } from '../src/saas/canvasDraft';
import * as bridge from '../src/saas/canvasBridge';
import { channelHub, countedLocks, memoryBackend, quotaStorage } from './saas-canvas-store-fakes';

const identity = { user: { id: 'user-a', name: 'Alice', email: 'a@example.test', platformRole: 'user' },
  tenants: [{ id: 'tenant-a', name: 'Workspace A', role: 'owner', status: 'active', maxConcurrentRuns: 2, maxRunsPerDay: 10 }] };
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const record = (document: CanvasDocument, version = 7) => ({ id: 'canvas-a', tenantId: 'tenant-a', name: 'Canvas', document, version, createdAt: '', updatedAt: '' });
const market = { source: 'market' as const, agentId: 'agent-1', version: 2 };
const documentWith = (title: string): CanvasDocument => ({ ...emptyDocument(), updatedAt: 1, view: { x: 0, y: 0, scale: 1 },
  nodes: [{ ...createSessionNode('llm', { x: 0, y: 0 }), id: 'node-a', title, agentRef: market }] });

async function writerReady() {
  await waitFor(() => {
    expect(document.querySelector('.awwo-workspace')).not.toBeNull();
    expect(vi.mocked(bridge.configureSaaSCanvasSave).mock.lastCall?.[0]).toBeTypeOf('function');
  }, { timeout: 5000 });
  return vi.mocked(bridge.configureSaaSCanvasSave).mock.lastCall![0]!;
}
function serve(cloud: { current: ReturnType<typeof record> }, refuse: boolean) {
  const puts: Array<{ headers: Headers; document: CanvasDocument }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url.endsWith('/appearance')) return response(appearanceFixture);
    if (url.endsWith('/artifacts')) return response({ items: [] });
    if (url.endsWith('/auth/me')) return response(identity);
    if (url.endsWith('/runtime')) return response({ available: false, models: [] });
    if (url.endsWith('/graph-runs')) return response({ items: [] });
    if (init.method === 'PUT') {
      const body = JSON.parse(init.body as string);
      puts.push({ headers: new Headers(init.headers), document: body.document });
      if (refuse) return response({ error: { code: 'canvas_reload_required', message: 'Reload the page to keep editing this canvas' } }, 409);
      cloud.current = record(body.document, body.version + 1);
    }
    return response(cloud.current);
  }));
  return puts;
}

const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')!;
beforeEach(() => {
  const local = quotaStorage();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: local.storage });
  Object.defineProperty(navigator.locks, 'query', { configurable: true, value: async () => ({ held: [], pending: [] }) });
  const backend = memoryBackend();
  setCanvasStoreForTests(createCanvasStore({ backend: async () => backend.backend, channel: channelHub().channel, locks: countedLocks().locks,
    legacy: local.storage, keepLegacy: keepLegacyCanvasCache, mirrorGroup: CANVAS_MIRROR_GROUP, preserveLegacy: preserveRegisteredLegacyCache,
    flushDelay: 5, peerWait: 100, watchPage: false }));
  vi.spyOn(bridge, 'configureSaaSCanvasSave');
  localStorage.setItem('superclaw_locale', 'zh'); configureCanvasStorage('user-a', 'tenant-a', 'canvas-a');
  window.history.replaceState({}, '', '/?tenant=tenant-a&canvas=canvas-a');
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => {
  cleanup(); bridge.clearSaaSCanvas(); bridge.configureSaaSCanvasSave(null); vi.restoreAllMocks(); vi.unstubAllGlobals();
  setCanvasStoreForTests(null);
  Object.defineProperty(globalThis, 'localStorage', original);
  delete (navigator.locks as { query?: unknown }).query;
  window.history.replaceState({}, '', '/');
});

it('saves a canvas with a market node, declaring the market feature', async () => {
  const cloud = { current: record(documentWith('Market node')) };
  const puts = serve(cloud, false);
  render(<SaaSApp />); const flush = await writerReady();
  act(() => { expect(saveDocument(documentWith('Renamed'))).toBe(true); });
  await act(async () => { await flush(); });
  expect(puts).toHaveLength(1);
  expect(puts[0].headers.get('X-Awwo-Canvas-Features')).toBe('market');
  expect(puts[0].document.nodes[0]).toMatchObject({ title: 'Renamed', agentRef: market });
});

it('keeps the edit on this device and asks for a reload when the API wants a newer page', async () => {
  const cloud = { current: record(documentWith('Market node')) };
  serve(cloud, true);
  render(<SaaSApp />); const flush = await writerReady();
  act(() => { expect(saveDocument(documentWith('Edited here'))).toBe(true); });
  await act(async () => { await expect(flush()).rejects.toThrow('画布未同步'); });
  const banner = screen.getByRole('alert');
  expect(banner).toHaveTextContent('AwwO 已经更新，这个页面的版本不能再保存这张画布');
  expect(banner).not.toHaveTextContent('画布已在另一页面更新');
  expect(screen.getByRole('button', { name: '重新加载' })).toBeVisible();
  expect(readCanvasDrafts(canvasStorage()).map(draft => draft.draft?.document.nodes[0].title)).toEqual(['Edited here']);
});
