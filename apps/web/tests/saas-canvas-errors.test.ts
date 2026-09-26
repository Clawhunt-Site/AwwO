import { afterEach, expect, it, vi } from 'vitest';
import { canvasErrorMessage } from '../src/saas/canvasErrors';
import { SaaSApiError } from '../src/saas/api';
import { canvasFetch, configureSaaSCanvas, configureSaaSCanvasSave, clearSaaSCanvas } from '../src/saas/canvasBridge';
import { fetchConversationIndex } from '../src/canvasAgentChat';
const tenant = { id: 'tenant-a', name: 'A', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 10 };
afterEach(() => { vi.unstubAllGlobals(); clearSaaSCanvas(); configureSaaSCanvasSave(null); document.documentElement.lang = ''; });
it('tells a user with no personal engine to add a key while preserving real model errors', () => {
  document.documentElement.lang = 'zh-CN';
  expect(canvasErrorMessage(new SaaSApiError(409, 'personal_engine_required', 'Add your own API key in Personal engines'))).toContain('我的引擎');
  expect(canvasErrorMessage(new SaaSApiError(409, 'model_unavailable', 'Node model is unavailable'))).toContain('重新选择');
  document.documentElement.lang = 'en';
  expect(canvasErrorMessage(new SaaSApiError(409, 'personal_engine_required', 'Add your own API key in Personal engines'))).toContain('My engines');
  expect(canvasErrorMessage(new SaaSApiError(409, 'model_unavailable', 'Node model is unavailable'))).toContain('Choose a model');
});
it('translates HTTP and recovered error codes using the current locale while preserving unknown details', () => {
  document.documentElement.lang = 'en'; expect(canvasErrorMessage('quota_exceeded')).toContain('quota');
  expect(canvasErrorMessage('Pi execution failed', 'runtime_failed')).toContain('Model execution failed');
  document.documentElement.lang = 'zh-CN'; expect(canvasErrorMessage('Pi execution failed', 'runtime_failed')).toContain('模型执行失败');
  expect(canvasErrorMessage('diagnostic 123', 'unknown_provider')).toBe('diagnostic 123');
  // A run that produced only a scratchpad is withheld deliberately, so it needs its
  // own explanation instead of the generic execution failure.
  expect(canvasErrorMessage('Pi execution failed', 'reasoning_only_output')).toContain('只返回了思考过程');
  document.documentElement.lang = 'en'; expect(canvasErrorMessage('Pi execution failed', 'reasoning_only_output')).toContain('only its reasoning');
  // An invalid plan is transient model drift with nothing applied, so the message has to
  // say retrying is available; without that the reader cannot tell it from a fault to fix.
  expect(canvasErrorMessage('invalid_canvas_plan')).toContain('retry');
  document.documentElement.lang = 'zh-CN'; expect(canvasErrorMessage('invalid_canvas_plan')).toContain('重试');
  // A delivery that failed its frozen output contract is not a runtime fault: the node's
  // own fields are the contract, so the reader must be told to retry or change model
  // rather than to look for a format they never wrote.
  expect(canvasErrorMessage('Model execution failed', 'output_contract_invalid')).toContain('交付格式');
  document.documentElement.lang = 'en';
  expect(canvasErrorMessage('Model execution failed', 'output_contract_invalid')).toContain('delivery format');
  expect(canvasErrorMessage('Model execution failed', 'output_contract_invalid')).not.toContain('Check the runtime configuration');
});
it('names the worker failures the API maps instead of showing the generic runtime failure', () => {
  // These are the run codes Go derives from the worker's failed-event codes. Each asks
  // for a different action, so none may fall back to "check the runtime configuration",
  // and the localized text must exist in both languages so a code never leaks raw.
  const named: Record<string, [string, string]> = {
    model_refused: ['拒绝', 'declined'],
    provider_auth_failed: ['凭据', 'credentials'],
    provider_rate_limited: ['速率限制', 'rate limited'],
    provider_unavailable: ['不可用', 'unavailable'],
    output_limit: ['超过限制', 'exceeds the limit'],
    run_timeout: ['超时', 'timed out'],
  };
  for (const [code, [zh, en]] of Object.entries(named)) {
    document.documentElement.lang = 'en';
    expect(canvasErrorMessage('The model request failed.', code), code).toContain(en);
    expect(canvasErrorMessage('The model request failed.', code), code).not.toContain('Check the runtime configuration');
    expect(canvasErrorMessage('The model request failed.', code), code).not.toBe('The model request failed.');
    document.documentElement.lang = 'zh-CN';
    expect(canvasErrorMessage('The model request failed.', code), code).toContain(zh);
    expect(canvasErrorMessage('The model request failed.', code), code).not.toContain('运行配置');
  }
  // The raw worker codes themselves are never run codes; they still show as their own text.
  expect(canvasErrorMessage('diagnostic 456', 'MODEL_REFUSAL')).toBe('diagnostic 456');
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
