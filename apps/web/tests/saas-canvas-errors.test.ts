import { afterEach, expect, it, vi } from 'vitest';
import { canvasErrorMessage, runErrorText } from '../src/saas/canvasErrors';
import { SaaSApiError, saasErrorMessage } from '../src/saas/api';
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
it('explains unready execution in both languages without changing the backend status or code', () => {
  const failure = new SaaSApiError(503, 'runtime_unavailable', 'Runtime is not configured');
  expect(failure.status).toBe(503);
  expect(failure.code).toBe('runtime_unavailable');
  document.documentElement.lang = 'zh-CN';
  for (const text of [saasErrorMessage(failure, 'zh'), saasErrorMessage('Runtime is not configured', 'zh'), canvasErrorMessage(failure)]) {
    expect(text).toContain('模型连接');
    expect(text).toContain('节点');
    expect(text).not.toContain('Runtime is not configured');
  }
  document.documentElement.lang = 'en';
  for (const text of [saasErrorMessage(failure, 'en'), saasErrorMessage('Runtime is not configured', 'en'), canvasErrorMessage(failure)]) {
    expect(text).toContain('model connection');
    expect(text).toContain('nodes in this run');
  }
  expect(saasErrorMessage(new SaaSApiError(503, 'unknown_provider', 'Provider diagnostic'), 'zh')).toBe('Provider diagnostic');
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
    workspace_context_limit: ['上下文已满', 'context is full'],
    workspace_step_limit: ['调用步数上限', 'model-call limit'],
    workspace_admission_failed: ['额度不可用', 'quota is unavailable'],
    workspace_file_invalid: ['交付文件无效', 'deliverable file is invalid'],
    workspace_unavailable: ['沙箱暂不可用', 'sandbox is unavailable'],
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
it('explains the project step budget in current and historical failures without promising to resume failed files', () => {
  const error = new SaaSApiError(500, 'workspace_step_limit', 'MaxTurnsExceededError');
  for (const locale of ['zh', 'en'] as const) {
    document.documentElement.lang = locale;
    const message = canvasErrorMessage(error);
    expect(runErrorText(error.code, locale)).toBe(message);
    expect(message).toContain(locale === 'zh' ? '拆分任务' : 'Split the task');
    expect(message).toContain(locale === 'zh' ? '联系管理员调整执行预算后重试' : 'contact an administrator to adjust the execution budget, then retry');
    expect(message).not.toMatch(/续跑|继续执行|恢复文件|resume|restored files/i);
  }
  expect(error.code).toBe('workspace_step_limit');
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
it.each([
  ['runtime_failed', 'Pi execution failed', 'Model execution failed'],
  ['workspace_step_limit', 'Model call limit reached.', 'model-call limit'],
])('localizes failed streamed events for %s while keeping the terminal failure visible', async (code, message, expected) => {
  document.documentElement.lang = 'en'; configureSaaSCanvas({ tenant, canvasId: 'canvas-a' }); configureSaaSCanvasSave(async () => {});
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('operationId=')) return new Response(JSON.stringify({ items: [] }));
    if (url.endsWith('/runs')) return new Response(JSON.stringify({ id: 'run-a', sessionId: 'session-a', status: 'queued' }));
    if (url.endsWith('/events')) return new Response(`data: ${JSON.stringify({ type: 'failed', code, message })}\n\n`);
    throw new Error(url);
  }));
  const r = await canvasFetch('/gateway-api/conversations/tenant-a/agents/a/messages', { method: 'POST', body: JSON.stringify({ message: 'hello', issueId: 'session-a' }) });
  const text = await r.text(); expect(text).toContain(expected); expect(text).toContain('"status":"failed"');
});
