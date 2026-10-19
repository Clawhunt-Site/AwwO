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
  document.documentElement.lang = 'zh-CN';
  expect(canvasErrorMessage('generation stopped', 'media_credit_ceiling')).toContain('单次上限');
  document.documentElement.lang = 'en';
  expect(canvasErrorMessage('generation stopped', 'media_credit_ceiling')).toContain('per-generation limit');
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
it('points a free workspace at the paid plans first when its run allowance is full, and still says how to wait', () => {
  for (const [locale, plans, wait] of [['zh', '升级 Pro / Max 付费套餐', 'UTC 0 点'], ['en', 'Upgrade to the Pro or Max plan', '00:00 UTC']] as const) {
    const text = runErrorText('quota_exceeded', locale)!;
    expect(text).toContain(plans); expect(text).toContain(wait);
    expect(text.indexOf(plans)).toBeLessThan(text.indexOf(wait));
    // The API's own message and a node's both read the same copy; nobody is sent to an administrator.
    expect(saasErrorMessage(new SaaSApiError(429, 'quota_exceeded', 'Workspace run quota exceeded'), locale)).toBe(text);
    expect(text).not.toMatch(/管理员|administrator/);
  }
});
it('points a free workspace at the default model and the paid plans when its premium calls run out', () => {
  for (const code of ['premium_quota_exceeded', 'premium_capacity_exceeded']) {
    document.documentElement.lang = 'zh-CN';
    expect(canvasErrorMessage('Model execution failed', code)).toContain('默认模型');
    expect(runErrorText(code, 'zh')).toContain('付费套餐');
    document.documentElement.lang = 'en';
    expect(canvasErrorMessage('Model execution failed', code)).toContain('default model');
    expect(runErrorText(code, 'en')).toContain('Pro and Max plans');
    expect(runErrorText(code, 'en')).toContain('Plans and credits');
  }
  expect(saasErrorMessage(new SaaSApiError(429, 'media_quota_exceeded', 'x'), 'zh')).toContain('付费套餐');
  // A paid plan whose credits ran out: the default model still works, and the plans page upgrades.
  document.documentElement.lang = 'zh-CN';
  expect(runErrorText('credits_exhausted', 'zh')).toContain('默认模型');
  expect(runErrorText('credits_exhausted', 'en')).toContain('Plans and credits');
  expect(saasErrorMessage(new SaaSApiError(402, 'credits_exhausted', 'x'), 'zh')).toContain('点数已用完');
  expect(saasErrorMessage(new SaaSApiError(403, 'checkout_closed', 'x'), 'zh')).toContain('即将开放');
  expect(saasErrorMessage(new SaaSApiError(409, 'already_subscribed', 'x'), 'en')).toContain('Manage subscription');
});
it('says the free default model is full for the whole service today, and offers only the next UTC day or a plan', () => {
  const zh = saasErrorMessage(new SaaSApiError(500, 'free_capacity_exceeded', 'Model execution failed'), 'zh');
  const en = saasErrorMessage(new SaaSApiError(500, 'free_capacity_exceeded', 'Model execution failed'), 'en');
  for (const text of [zh, runErrorText('free_capacity_exceeded', 'zh')]) {
    expect(text).toContain('默认模型');
    expect(text).toContain('UTC 次日');
    expect(text).toContain('Pro / Max 付费套餐');
    expect(text).toContain('套餐与点数');
  }
  for (const text of [en, runErrorText('free_capacity_exceeded', 'en')]) {
    expect(text).toContain('whole service');
    expect(text).toContain('next UTC day');
    expect(text).toContain('Pro or Max plan');
    expect(text).toContain('Plans and credits');
    // There is no free model left to switch to, so the copy must not send the reader to "the default model".
    expect(text).not.toContain('Switch the node');
  }
  // A failed run carries the code; the node shows the same words in the reader's language.
  document.documentElement.lang = 'zh-CN';
  expect(canvasErrorMessage('Model execution failed', 'free_capacity_exceeded')).toBe(zh);
  document.documentElement.lang = 'en';
  expect(canvasErrorMessage('Model execution failed', 'free_capacity_exceeded')).toBe(en);
  expect(en).not.toBe(runErrorText('premium_capacity_exceeded', 'en'));
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

it('says a refused voice is the voice, not a picture, and that nothing was made or charged (M-1c)', () => {
  const zh = runErrorText('media_voice_unavailable', 'zh')!;
  const en = runErrorText('media_voice_unavailable', 'en')!;
  expect(zh).toContain('声音参考用不了');
  expect(zh).toContain('没有扣积分');
  expect(zh).toContain('至少要有一张参考图');
  expect(en).toContain('The voice reference cannot be used');
  expect(en).toContain('nothing was generated or charged');
  expect(en).toContain('MP3 or WAV');
  for (const text of [zh, en]) expect(text).not.toBe(runErrorText('media_reference_unavailable', text === zh ? 'zh' : 'en'));
});

it('tells the reader to turn on Real people when RunningHub refuses a photorealistic person (code 1505)', () => {
  expect(runErrorText('media_real_person_rejected', 'zh')).toContain('「真人模式」');
  expect(runErrorText('media_real_person_rejected', 'zh')).toContain('1505');
  expect(runErrorText('media_real_person_rejected', 'en')).toContain('turn on Real people');
  expect(runErrorText('media_real_person_rejected', 'en')).toContain('1505');
  expect(runErrorText('media_voice_unavailable', 'en')).toContain('at most 3, each 2 to 15 seconds (15 seconds in all)');
});
