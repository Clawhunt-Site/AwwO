import { afterEach, expect, it, vi } from 'vitest';
import { canvasErrorMessage } from '../src/saas/canvasErrors';
import { canvasFetch, configureSaaSCanvas, configureSaaSCanvasSave, clearSaaSCanvas } from '../src/saas/canvasBridge';
import { fetchConversationIndex } from '../src/canvasAgentChat';
const tenant = { id: 'tenant-a', name: 'A', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 10 };
afterEach(() => { vi.unstubAllGlobals(); clearSaaSCanvas(); configureSaaSCanvasSave(null); document.documentElement.lang = ''; });
it('translates HTTP and recovered error codes using the current locale while preserving unknown details', () => {
  document.documentElement.lang = 'en'; expect(canvasErrorMessage('quota_exceeded')).toContain('quota');
  expect(canvasErrorMessage('Pi execution failed', 'runtime_failed')).toContain('Model execution failed');
  document.documentElement.lang = 'zh-CN'; expect(canvasErrorMessage('Pi execution failed', 'runtime_failed')).toContain('模型执行失败');
  expect(canvasErrorMessage('diagnostic 123', 'unknown_provider')).toBe('diagnostic 123');
});
it('keeps HTTP status and code when displaying a localized quota rejection', async () => {
  document.documentElement.lang = 'en'; configureSaaSCanvas({ tenant, canvasId: 'canvas-a' }); configureSaaSCanvasSave(async () => {});
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'quota_exceeded', message: '额度不足' } }), { status: 429 })));
  const r = await canvasFetch('/gateway-api/conversations/tenant-a/agents/a/messages', { method: 'POST', body: JSON.stringify({ message: 'hello' }) });
  expect(r.status).toBe(429); expect(await r.json()).toMatchObject({ code: 'quota_exceeded', error: expect.stringContaining('quota') });
});
it('uses an exact session query for restore and follows complete legacy indexes without losing page two', async () => {
  configureSaaSCanvas({ tenant, canvasId: 'canvas-a' });
  const fetch = vi.fn(async (url: string) => {
    const u = new URL(url, 'http://localhost'); expect(u.searchParams.get('canvasId')).toBe('canvas-a');
    if (u.searchParams.has('sessionId')) { expect(u.searchParams.get('sessionId')).toBe('session-250'); return new Response(JSON.stringify({ items: [{ id: 'session-250', agentId: 'a' }], nextCursor: null })); }
    return new Response(JSON.stringify({ items: [{ id: u.searchParams.has('cursor') ? 'page-two' : 'page-one' }], nextCursor: u.searchParams.has('cursor') ? null : 'opaque+cursor' }));
  }); vi.stubGlobal('fetch', fetch);
  expect(await fetchConversationIndex('/gateway-api', 'tenant-a', undefined, 'session-250')).toMatchObject([{ issueId: 'session-250' }]); expect(fetch).toHaveBeenCalledTimes(1);
  expect(await fetchConversationIndex('/gateway-api', 'tenant-a')).toMatchObject([{ issueId: 'page-one' }, { issueId: 'page-two' }]);
});
it('localizes failed streamed events while keeping the terminal failure visible', async () => {
  document.documentElement.lang = 'en'; configureSaaSCanvas({ tenant, canvasId: 'canvas-a' }); configureSaaSCanvasSave(async () => {});
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('operationId=')) return new Response(JSON.stringify({ items: [] }));
    if (url.endsWith('/runs')) return new Response(JSON.stringify({ id: 'run-a', sessionId: 'session-a', status: 'queued' }));
    if (url.endsWith('/events')) return new Response('data: {"type":"failed","code":"runtime_failed","message":"Pi execution failed"}\n\n');
    throw new Error(url);
  }));
  const r = await canvasFetch('/gateway-api/conversations/tenant-a/agents/a/messages', { method: 'POST', body: JSON.stringify({ message: 'hello', issueId: 'session-a' }) });
  const text = await r.text(); expect(text).toContain('Model execution failed'); expect(text).toContain('"status":"failed"');
});
