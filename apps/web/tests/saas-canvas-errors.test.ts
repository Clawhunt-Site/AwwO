import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { canvasErrorMessage, isRunFailureCopy, planErrorMessage, runErrorCodes, runErrorText, runFailureText } from '../src/saas/canvasErrors';
import { SaaSApiError, saasErrorMessage } from '../src/saas/api';
import { canvasFetch, configureSaaSCanvas, configureSaaSCanvasSave, clearSaaSCanvas } from '../src/saas/canvasBridge';
import { fetchConversationIndex } from '../src/canvasAgentChat';
import { canvasText } from '../src/canvas/i18n';
import { failureCause } from '../src/canvas/surfaceMessages';
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
    output_limit: ['超过了一次运行的上限', 'went past what one run may write'],
    run_timeout: ['超时', 'timed out'],
    team_timeout: ['节点团队超过了团队设置的时间上限', 'ran past its time limit'],
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
// Owner 2026-10-21: 「运行超时，请缩小任务范围后重试」 came up again and again; an error has to say what to do. Nearly every
// timeout in production was a call that never wrote a word, and running the node again was what finished it.
it('tells a timed-out run to run again first, then to change the model or split the work, never to shrink the task', () => {
  const zh = runErrorText('run_timeout', 'zh')!;
  const en = runErrorText('run_timeout', 'en')!;
  expect(zh.indexOf('先重新运行')).toBeGreaterThan(-1);
  expect(zh.indexOf('先重新运行')).toBeLessThan(zh.indexOf('换个模型'));
  expect(zh.indexOf('换个模型')).toBeLessThan(zh.indexOf('让助手调整画布'));
  expect(zh).toContain('迟迟没有给出结果');
  expect(en.indexOf('Run it again first')).toBeGreaterThan(-1);
  expect(en.indexOf('Run it again first')).toBeLessThan(en.indexOf('choose another model'));
  expect(en.indexOf('choose another model')).toBeLessThan(en.indexOf('let the assistant adjust the canvas'));
  // One line of the failure note in a wide chat column (about 55 characters with 「上次运行失败：」 at 12.5 px in 860 px).
  expect([...zh].length).toBeLessThanOrEqual(48);
  // No node is named: the copy also reads under a team member's turn and on every node of a collaboration it ended.
  for (const text of [zh, en]) expect(text).not.toMatch(/这个节点|this node/);
  expect(zh).not.toContain('缩小任务范围');
  expect(en).not.toMatch(/reduce the task scope/i);
  // A node's own Send and a recovered run read the same words.
  document.documentElement.lang = 'zh-CN';
  expect(canvasErrorMessage('The model request timed out.', 'run_timeout')).toBe(zh);
  document.documentElement.lang = 'en';
  expect(canvasErrorMessage('run_timeout')).toBe(en);
});
it('says what to do after every run failure, and never asks to restore a run state or check a runtime configuration', () => {
  const codes = ['runtime_session_busy', 'runtime_rejected', 'invalid_canvas_plan', 'database_unavailable', 'history_unavailable',
    'invalid_runtime_event', 'output_limit', 'runtime_disconnected', 'server_restarted', 'API restarted before completion', 'interrupted',
    'execution_interrupted', 'runtime_failed', 'run_timeout', 'team_timeout', 'team_turn_budget_exhausted', 'review_rounds_exhausted',
    'invalid_review_verdict', 'tool_unavailable', 'turn_persistence_failed', 'accounting_commit_failed', 'provider_rate_limited',
    'provider_unavailable', 'runtime_stream_ended', 'event_persistence_failed', 'inconsistent_runtime_output', 'deliverable_storage_failed'];
  const actions = { zh: /重新运行|重试|再运行|换一个模型|联系管理员|刷新页面|调大|取消这个工具/, en: /\bretry\b|run it again|try again|choose another model|contact an administrator|reload the page|\braise\b|clear the tool/i };
  const vague = { zh: /恢复运行状态|运行配置|核对历史|缩小任务范围/, en: /restore (?:the|its) (?:run )?state|runtime configuration|check its history|reduce the task scope/i };
  for (const code of codes) {
    for (const locale of ['zh', 'en'] as const) {
      const text = runErrorText(code, locale);
      expect(text, `${code} ${locale}`).toBeTruthy();
      expect(text, `${code} ${locale}`).toMatch(actions[locale]);
      expect(text, `${code} ${locale}`).not.toMatch(vague[locale]);
    }
  }
  // Only a restart is said to be one: a graph run's interrupted node may have had its executor stop instead (runs.go
  // dispatchFor's execution_interrupted), and that one says no cause.
  expect(runErrorText('API restarted before completion', 'zh')).toContain('服务重启打断');
  expect(runErrorText('interrupted', 'zh')).toContain('多半是服务重启');
  expect(runErrorText('interrupted', 'en')).toContain('most often by a service restart');
  for (const locale of ['zh', 'en'] as const) expect(runErrorText('execution_interrupted', locale)).not.toMatch(/重启|restart/);
  // No copy that a collaboration's failed turn can put on every node, or a team member's turn can carry, names "this node",
  // nor the canvas's own copy of a delivery-format refusal (graph_collaboration.go finishCollaboration).
  const thisNode = /这个节点|该节点|这个组件|该组件|this node|this component/;
  for (const code of ['runtime_rejected', 'output_limit', 'runtime_failed', 'run_timeout', 'provider_rate_limited', 'provider_unavailable',
    'output_contract_invalid', 'deliverable_storage_failed', 'interrupted', 'execution_interrupted', 'event_persistence_failed']) {
    for (const locale of ['zh', 'en'] as const) expect(runErrorText(code, locale), `${code} ${locale}`).not.toMatch(thisNode);
  }
  for (const locale of ['zh', 'en'] as const) expect(canvasText(locale, 'surface.deliveryFormat'), locale).not.toMatch(thisNode);
  // A stream piece that could not be stored leaves what came before it with the run.
  expect(runErrorText('event_persistence_failed', 'zh')).toContain('已写出的部分可能留在对话里');
  // Not "did not start": the worker may have answered with an error after it began.
  for (const locale of ['zh', 'en'] as const) expect(runErrorText('runtime_rejected', locale)).not.toMatch(/没有开始|did not start/);
  // A team's own limits name the setting and its editor's bound (nodeTeam.ts validateNodeTeam).
  expect(runErrorText('team_turn_budget_exhausted', 'zh')).toContain('「最多模型调用次数」');
  expect(runErrorText('team_turn_budget_exhausted', 'zh')).toContain('最多 64 次');
  expect(runErrorText('review_rounds_exhausted', 'en')).toContain('“Maximum rounds”');
  expect(runErrorText('review_rounds_exhausted', 'en')).toContain('up to 8');
  const team = readFileSync(resolve(process.cwd(), 'src/canvas/nodeTeam.ts'), 'utf8');
  expect(team).toContain("['maxRounds', 1, 8], ['maxTurns', 1, 64]");
  const editor = readFileSync(resolve(process.cwd(), 'src/canvas/NodeTeamEditor.tsx'), 'utf8');
  for (const label of ["rounds: '最多轮数'", "turns: '最多模型调用次数'", "rounds: 'Maximum rounds'", "turns: 'Maximum model calls'"]) expect(editor).toContain(label);
});
it('names the node team setting a team timeout is lifted in, as its editor labels it', () => {
  const editor = readFileSync(resolve(process.cwd(), 'src/canvas/NodeTeamEditor.tsx'), 'utf8');
  expect(editor).toContain("timeout: '节点超时（秒）'");
  expect(editor).toContain("timeout: 'Node timeout (seconds)'");
  expect(runErrorText('team_timeout', 'zh')).toContain('「节点超时（秒）」');
  expect(runErrorText('team_timeout', 'en')).toContain('“Node timeout (seconds)”');
  // validateNodeTeam's own bound (nodeTeam.ts) is the most the copy offers.
  expect(readFileSync(resolve(process.cwd(), 'src/canvas/nodeTeam.ts'), 'utf8')).toContain("['timeoutSeconds', 10, 1800]");
  expect(runErrorText('team_timeout', 'zh')).toContain('最多 1800 秒');
});
it('reads a failed plan as the canvas assistant’s, with no node to run again and no model to change', () => {
  for (const [locale, lang, kept, node] of [['zh', 'zh-CN', '画布保持原样', /这个节点|换一个模型|重新运行/], ['en', 'en', 'the canvas has not changed', /this node|choose another model|run it again/i]] as const) {
    document.documentElement.lang = lang;
    for (const code of ['run_timeout', 'runtime_failed', 'provider_unavailable', 'provider_rate_limited', 'output_limit', 'runtime_session_busy',
      'API restarted before completion', 'interrupted', 'execution_interrupted', 'runtime_stream_ended', 'invalid_runtime_event', 'accounting_commit_failed']) {
      const text = planErrorMessage('Pi execution failed', code);
      expect(text, code).not.toMatch(node);
      expect(text, code).not.toBe(runErrorText(code, locale));
      if (code !== 'runtime_session_busy') expect(text, code).toContain(kept);
    }
    // One too large for a plan is sent in parts; only a restart is said to be one; a plan another page stopped says so.
    expect(planErrorMessage('', 'output_limit')).toMatch(locale === 'zh' ? /分成几步/ : /split the request into steps/i);
    expect(planErrorMessage('', 'API restarted before completion')).toMatch(/重启|restart/);
    expect(planErrorMessage('', 'interrupted')).not.toMatch(/重启|restart/);
    expect(planErrorMessage(undefined, 'cancelled')).toContain(locale === 'zh' ? '这次规划已停止' : 'This plan was stopped');
    // Everything else reads as a run's failure does.
    for (const code of ['invalid_canvas_plan', 'quota_exceeded', 'premium_quota_exceeded', 'reasoning_only_output']) {
      expect(planErrorMessage('Pi execution failed', code), code).toBe(canvasErrorMessage('Pi execution failed', code));
    }
    expect(planErrorMessage('provider diagnostic', '')).toBe('provider diagnostic');
  }
});
it('finds a failure’s copy as a node records it: a run’s, else the service’s, and nothing for the provider’s own words', () => {
  for (const locale of ['zh', 'en'] as const) {
    expect(runFailureText('run_timeout', locale)).toBe(runErrorText('run_timeout', locale));
    expect(runFailureText('context_limit', locale)).toBe(saasErrorMessage(new SaaSApiError(0, 'context_limit', 'x'), locale));
    expect(runFailureText('media_quota_exceeded', locale)).toBe(saasErrorMessage(new SaaSApiError(0, 'media_quota_exceeded', 'x'), locale));
    expect(runFailureText('provider said no', locale)).toBeUndefined();
    expect(runFailureText('Output must be a JSON object keyed by output field IDs', locale)).toBeUndefined();
    // Nothing for nothing: the service's own fallback for an empty message is no copy of a detail.
    expect(runFailureText('', locale)).toBeUndefined();
  }
});
it('tells a copy a node’s own Send recorded, a run’s or the service’s, from the provider’s own words', () => {
  for (const locale of ['zh', 'en'] as const) {
    expect(isRunFailureCopy(runErrorText('run_timeout', locale)!)).toBe(true);
    expect(isRunFailureCopy(saasErrorMessage(new SaaSApiError(0, 'context_limit', ''), locale))).toBe(true);
    expect(isRunFailureCopy(saasErrorMessage(new SaaSApiError(0, 'media_quota_exceeded', ''), locale))).toBe(true);
  }
  expect(isRunFailureCopy('Request rejected. max_tokens exceeds 32000 for this model.')).toBe(false);
  expect(isRunFailureCopy('context_limit')).toBe(false);
  expect(isRunFailureCopy('')).toBe(false);
});
it('says a run too large for its model did not run and what to change, never the history it trims by itself', () => {
  document.documentElement.lang = 'zh-CN';
  const zh = canvasErrorMessage(new SaaSApiError(413, 'context_limit', 'Prompt and instructions exceed the selected runtime context budget'));
  expect(zh).toContain('没有运行');
  expect(zh).toContain('上下文更大的模型');
  expect(zh).toContain('上游节点的交付');
  expect(zh).not.toContain('历史');
  document.documentElement.lang = 'en';
  const en = canvasErrorMessage(new SaaSApiError(413, 'context_limit', 'Prompt and instructions exceed the selected runtime context budget'));
  expect(en).toContain('did not run');
  expect(en).toContain('larger context');
  expect(en).not.toMatch(/history/i);
  // What happened, as a node's recorded code tells the assistant (failureCause): the first sentence, not the advice.
  expect(failureCause(zh)).toBe('这次要发给模型的内容超出了它一次能读的量，没有运行');
  expect(failureCause(en)).toBe('What this would send is more than the model can read at once, so it did not run');
  for (const locale of ['zh', 'en'] as const) expect(runFailureText('context_limit', locale)).toBe(locale === 'zh' ? zh : en);
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
// A live interrupted event carries no code (runs.go finishOnce): it read as 「请求失败，请重试。」, and a stream that broke
// asked to "restore the run state".
it('says a node’s own run was interrupted, or its connection dropped, with what to do', async () => {
  document.documentElement.lang = 'zh-CN'; configureSaaSCanvas({ tenant, canvasId: 'canvas-a' }); configureSaaSCanvasSave(async () => {});
  let events = `data: ${JSON.stringify({ type: 'interrupted' })}\n\n`;
  let eventsStatus = 200;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('operationId=')) return new Response(JSON.stringify({ items: [] }));
    if (url.endsWith('/runs')) return new Response(JSON.stringify({ id: 'run-a', sessionId: 'session-a', status: 'queued' }));
    if (url.endsWith('/events')) return new Response(events, { status: eventsStatus });
    throw new Error(url);
  }));
  const send = () => canvasFetch('/gateway-api/conversations/tenant-a/agents/a/messages', { method: 'POST', body: JSON.stringify({ message: 'hello', issueId: 'session-a' }) });
  let text = await (await send()).text();
  expect(text).toContain(runErrorText('interrupted', 'zh')!); expect(text).toContain('"status":"failed"');
  expect(text).not.toContain('请求失败');
  // A completed text that disagrees with what streamed ends the read as a broken stream.
  events = [{ type: 'text_delta', delta: 'mine' }, { type: 'completed', text: 'other' }].map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
  text = await (await send()).text();
  expect(text).toContain(runErrorText('runtime_disconnected', 'zh')!);
  expect(text).not.toContain('恢复运行状态');
  // An admitted run whose events could not be opened: a reload shows how it went (review 2026-10-21: 「请刷新后恢复」).
  eventsStatus = 502;
  const unreachable = await send();
  expect(unreachable.status).toBe(502);
  expect((await unreachable.json()).error).toBe(runErrorText('runtime_disconnected', 'zh'));
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

it('tells the reader to turn on Real people when the service refuses a photorealistic person (code 1505)', () => {
  expect(runErrorText('media_real_person_rejected', 'zh')).toContain('「真人模式」');
  expect(runErrorText('media_real_person_rejected', 'zh')).toContain('1505');
  expect(runErrorText('media_real_person_rejected', 'en')).toContain('turn on Real people');
  expect(runErrorText('media_real_person_rejected', 'en')).toContain('1505');
  expect(runErrorText('media_voice_unavailable', 'en')).toContain('at most 3, each 2 to 15 seconds (15 seconds in all)');
});

/** The media providers behind the picture, video, sound and 3D models: a name no message a user reads may carry. */
const PROVIDERS = ['RunningHub', 'Running Hub', 'Tripo', 'Seedream', 'Seedance', 'Jimeng', 'X-tasy', 'Xtasy', 'Kling',
  'Hailuo', 'Volcengine', 'MiniMax', 'Suno', 'Udio', 'ElevenLabs', 'Midjourney', '即梦', '可灵', '海螺', '豆包'];

/** Which provider a piece of copy names, if any. A name in Latin letters has to stand as its own word, so "audio" does
 * not name Udio and "sparkling" does not name Kling; a name in Chinese has no such boundary to rely on — Chinese runs
 * without spaces, and 豆包 in 豆包生成服务 sits between two letters — so those are looked for exactly as written. */
const providerNamed = (text: string) => PROVIDERS.find(provider => (/^[\x20-\x7e]+$/.test(provider)
  // A hyphen needs no escape outside a character class, and `\-` is an invalid escape under the u flag.
  ? new RegExp(`(^|[^\\p{L}\\p{N}])${provider.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'iu').test(text)
  : text.includes(provider)));

it('names no media provider in any message a user reads', () => {
  // The messages as a reader gets them: every code of the table, in both languages, through the function the app calls
  // (owner 2026-10-11: on-screen model names, never the provider behind them). Reading them evaluated rather than
  // scraped holds a message built by interpolation, written in double quotes, or joined from parts to the rule too.
  const codes = runErrorCodes();
  expect(codes.length).toBeGreaterThan(20);
  for (const code of codes) {
    for (const locale of ['zh', 'en'] as const) {
      const text = runErrorText(code, locale);
      expect(text, `${code} (${locale})`).toBeTruthy();
      expect(providerNamed(text!), `${code} (${locale}): ${text}`).toBeUndefined();
    }
  }
  // And the rest of the file's copy — the HTTP, plan and service messages, which are not in that table — from the
  // source with its comments stripped, so a comment may still record which service a code came from. Every quote
  // style, and short strings too: 'RunningHub' on its own is ten characters.
  const source = readFileSync(resolve(process.cwd(), 'src/saas/canvasErrors.ts'), 'utf8');
  const copy = [...source.replace(/^[^'"`\n]*\/\/[^'"`\n]*$/gm, '').matchAll(/'((?:[^'\\\n]|\\.)+)'|"((?:[^"\\\n]|\\.)+)"|`((?:[^`\\]|\\.)+)`/g)]
    .map(match => match[1] ?? match[2] ?? match[3]);
  expect(copy.length).toBeGreaterThan(60);
  for (const text of copy) expect(providerNamed(text), `in: ${text.slice(0, 120)}`).toBeUndefined();
});
