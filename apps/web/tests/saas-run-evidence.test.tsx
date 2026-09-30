import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RunEvidence } from '../src/saas/RunEvidence';
import { SaaSPreferencesProvider } from '../src/saas/preferences';

const path = '/api/v1/tenants/tenant-a/runs/run-a';
const evidence = (patch = {}) => ({ runId: 'run-a', status: 'completed', outputPresent: true, outputBytes: 42, artifactCount: 0,
  contract: { declared: true, validated: true }, manualAcceptance: { required: true, verified: false },
  evidenceSources: ['model_output', 'contract_validated'], observational: true, preview: 'Observed output <script>never execute</script>', previewTruncated: false, ...patch });
const invocation = (patch: Record<string, unknown> = {}) => ({ id: 'invocation-a', runId: 'run-a', runtime: 'pi', provider: 'llmgate', modelId: 'qwen3.8-27b-p6', providerModel: 'qwen3-8-27b-p6',
  status: 'completed', usageStatus: 'reported', ...patch,
  usage: { inputTokens: '22', outputTokens: '30', cachedInputTokens: null, cacheWriteTokens: null, reasoningTokens: null,
    providerTotalTokens: null, computedTotalTokens: '52', ...(patch.usage && typeof patch.usage === 'object' ? patch.usage : {}) } });
const invocationPage = (items: unknown[], nextCursor: string | null = null) => ({ items, page: { nextCursor } });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const view = (tenantId = 'tenant-a', runId = 'run-a') => <SaaSPreferencesProvider><RunEvidence tenantId={tenantId} runId={runId} runStatus="completed" /></SaaSPreferencesProvider>;
beforeEach(() => { localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh'); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('reads only on demand with credentials and never treats completion or contract validation as acceptance', async () => {
  const fetcher = vi.fn(async () => json(evidence())); vi.stubGlobal('fetch', fetcher); render(view());
  expect(fetcher).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '证据摘要' }));
  expect(await screen.findByText('人工验收尚未确认')).toBeVisible();
  expect(screen.getByText('交付格式：已通过检查')).toBeVisible();
  expect(screen.getByText('证据来源：模型输出 · 交付格式检查')).toBeVisible();
  expect(screen.getByText(/Observed output/)).toHaveTextContent('<script>never execute</script>');
  expect(document.querySelector('script')).toBeNull();
  expect(fetcher).toHaveBeenCalledWith(`${path}/evidence`, expect.objectContaining({ credentials: 'include', signal: expect.any(AbortSignal) }));
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it.each(['failed', 'cancelled', 'interrupted'])('shows %s partial evidence without presenting an accepted result', async status => {
  vi.stubGlobal('fetch', vi.fn(async () => json(evidence({ status, contract: { declared: false, validated: false }, previewTruncated: true }))));
  render(view()); fireEvent.click(screen.getByRole('button', { name: '证据摘要' }));
  expect(await screen.findByText('人工验收尚未确认')).toBeVisible();
  expect(screen.getByText('交付格式：未声明')).toBeVisible();
  expect(screen.getByText(/预览已截取/)).toBeVisible();
});

it('downloads an authenticated NDJSON response only after an explicit click', async () => {
  const archive = '{"record":"redacted"}\n';
  const fetcher = vi.fn(async (url: string) => url.endsWith('/archive')
    ? new Response(archive, { headers: { 'Content-Type': 'application/x-ndjson', 'Content-Disposition': 'attachment; filename="run-redacted.ndjson"' } }) : json(evidence()));
  vi.stubGlobal('fetch', fetcher);
  const objectURL = vi.fn<(blob: Blob) => string>(() => 'blob:archive'); const revoke = vi.fn();
  vi.stubGlobal('URL', class extends URL { static createObjectURL = objectURL; static revokeObjectURL = revoke; });
  let savedName = ''; const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { savedName = this.download; });
  render(view()); fireEvent.click(screen.getByRole('button', { name: '证据摘要' }));
  await screen.findByText('人工验收尚未确认'); expect(fetcher).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: '下载脱敏记录' }));
  await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
  expect(savedName).toBe('run-redacted.ndjson');
  // Node's Response.blob() and jsdom's Blob belong to different realms.
  // Validate the downloaded payload rather than its constructor identity.
  expect(objectURL).toHaveBeenCalledTimes(1);
  const [downloaded] = objectURL.mock.calls[0]!;
  expect(downloaded.type).toBe('application/x-ndjson');
  expect(downloaded.size).toBe(new TextEncoder().encode(archive).byteLength);
  await expect(downloaded.text()).resolves.toBe(archive);
  expect(fetcher).toHaveBeenLastCalledWith(`${path}/archive`, expect.objectContaining({ credentials: 'include' }));
});

it('reports denied downloads without creating a local file', async () => {
  const fetcher = vi.fn(async (url: string) => url.endsWith('/archive') ? json({ error: { code: 'forbidden' } }, 403) : json(evidence()));
  vi.stubGlobal('fetch', fetcher); const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  render(view()); fireEvent.click(screen.getByRole('button', { name: '证据摘要' })); await screen.findByText('人工验收尚未确认');
  fireEvent.click(screen.getByRole('button', { name: '下载脱敏记录' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('你没有执行此操作的权限');
  expect(click).not.toHaveBeenCalled();
});

it('rejects a successful HTML login response rather than downloading it as evidence', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/archive')
    ? new Response('<html>Sign in</html>', { headers: { 'Content-Type': 'text/html' } }) : json(evidence())));
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  render(view()); fireEvent.click(screen.getByRole('button', { name: '证据摘要' })); await screen.findByText('人工验收尚未确认');
  fireEvent.click(screen.getByRole('button', { name: '下载脱敏记录' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('下载记录响应无效'); expect(click).not.toHaveBeenCalled();
});

it.each([{ manualAcceptance: { required: true, verified: true } }, { observational: false }])('rejects a response that does not honor observation-only semantics: %j', patch => {
  vi.stubGlobal('fetch', vi.fn(async () => json(evidence(patch))));
  render(view()); fireEvent.click(screen.getByRole('button', { name: '证据摘要' }));
  return screen.findByRole('alert').then(alert => {
    expect(alert).toHaveTextContent('证据响应无效');
    expect(screen.queryByText(/Observed output/)).toBeNull();
  });
});

it('rejects mismatched evidence identities and never renders their preview', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json(evidence({ runId: 'other-run', preview: 'OTHER TENANT DATA' }))));
  render(view()); fireEvent.click(screen.getByRole('button', { name: '证据摘要' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('证据响应无效');
  expect(screen.queryByText('OTHER TENANT DATA')).toBeNull();
});

it('clears the prior identity immediately when switching tenants or runs', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json(evidence())));
  const page = render(view()); fireEvent.click(screen.getByRole('button', { name: '证据摘要' }));
  await screen.findByText('人工验收尚未确认');
  page.rerender(view('tenant-b', 'run-b'));
  expect(screen.queryByText(/Observed output/)).toBeNull();
  expect(screen.getByRole('button', { name: '证据摘要' })).toHaveAttribute('aria-expanded', 'false');
});

it.each([401, 403, 404])('clears observed evidence when an active refresh loses access (%s)', async status => {
  vi.useFakeTimers(); let denied = false;
  const fetcher = vi.fn(async () => denied ? json({ error: { code: status === 401 ? 'unauthenticated' : 'forbidden' } }, status) : json(evidence({ status: 'running' })));
  vi.stubGlobal('fetch', fetcher); render(view());
  fireEvent.click(screen.getByRole('button', { name: '证据摘要' }));
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(screen.getByText('人工验收尚未确认')).toBeVisible();
  denied = true; await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(screen.getByRole('alert')).toBeVisible();
  expect(screen.queryByText(/Observed output/)).toBeNull();
  expect(screen.queryByRole('button', { name: '下载脱敏记录' })).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('ignores a late response after closing the evidence disclosure', async () => {
  let resolve!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(done => { resolve = done; })));
  render(view()); fireEvent.click(screen.getByRole('button', { name: '证据摘要' }));
  fireEvent.click(screen.getByRole('button', { name: '证据摘要' }));
  await act(async () => { resolve(json(evidence())); });
  expect(screen.queryByText(/Observed output/)).toBeNull();
});

it('shows only this run’s ledger on demand, preserving reported zero and unknown usage', async () => {
  const fetcher = vi.fn(async (url: string) => {
    if (url.includes('/invocations')) return json(invocationPage([
      invocation({ id: 'zero', usage: { inputTokens: '0', outputTokens: '0', computedTotalTokens: '0' } }),
      invocation({ id: 'unknown', provider: '', modelId: '', providerModel: '', usageStatus: 'unknown',
        usage: { inputTokens: null, outputTokens: null, computedTotalTokens: null } }),
    ]));
    return json(evidence());
  });
  vi.stubGlobal('fetch', fetcher); render(view());
  expect(fetcher).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '模型调用' }));
  expect(await screen.findByText('输入 0 · 输出 0 · 合计 0 tokens')).toBeVisible();
  expect(screen.getByText('用量待确认')).toBeVisible();
  expect(screen.getByText('服务商未记录 · 模型未记录')).toBeVisible();
  expect(screen.getByText('llmgate · qwen3-8-27b-p6')).toBeVisible();
  expect(screen.getByText('画布模型：qwen3.8-27b-p6')).toBeVisible();
  expect(fetcher).toHaveBeenCalledWith(`${path}/invocations?pageSize=100`, expect.objectContaining({ credentials: 'include', signal: expect.any(AbortSignal) }));
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('uses the provider model for BYOK calls without exposing the opaque connection selector', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json(invocationPage([
    invocation({ id: 'byok-known', modelId: 'byok_private-connection-id', providerModel: 'qwen3.8-27b-p6' }),
    invocation({ id: 'byok-unknown', modelId: 'byok_other-private-id', providerModel: '' }),
    invocation({ id: 'both-opaque', provider: 'private', modelId: 'byok_private-id', providerModel: 'byok_provider-id' }),
    invocation({ id: 'canvas-fallback', modelId: 'gemini-2.5-pro', providerModel: '' }),
  ]))));
  render(view()); fireEvent.click(screen.getByRole('button', { name: '模型调用' }));
  expect((await screen.findAllByText('llmgate · qwen3.8-27b-p6')).length).toBe(1);
  expect(screen.getByText('llmgate · 模型未记录')).toBeVisible();
  expect(screen.getByText('private · 模型未记录')).toBeVisible();
  expect(screen.getByText('llmgate · gemini-2.5-pro')).toBeVisible();
  expect(screen.queryByText(/byok_/i)).toBeNull();
  expect(screen.queryByText(/画布模型：/)).toBeNull();
});

it('loads later invocation pages without converting missing token fields to zero', async () => {
  const fetcher = vi.fn(async (url: string) => url.includes('cursor=next-page')
    ? json(invocationPage([
      invocation({ id: 'later', usageStatus: 'partial', usage: { inputTokens: '7', outputTokens: null, computedTotalTokens: null } }),
      invocation({ id: 'cache-only', usageStatus: 'partial', usage: { inputTokens: null, outputTokens: null, cachedInputTokens: '4', computedTotalTokens: null } }),
      invocation({ id: 'total-only', usageStatus: 'partial', usage: { inputTokens: null, outputTokens: null, providerTotalTokens: '9', computedTotalTokens: null } }),
    ]))
    : json(invocationPage([invocation()], 'next-page')));
  vi.stubGlobal('fetch', fetcher); render(view());
  fireEvent.click(screen.getByRole('button', { name: '模型调用' }));
  expect(await screen.findByText('输入 22 · 输出 30 · 合计 52 tokens')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '加载更多调用' }));
  expect(await screen.findByText('部分用量：输入 7 · 输出 未提供 tokens')).toBeVisible();
  expect(screen.getByText('部分用量：输入 未提供 · 输出 未提供 · 缓存输入 4 tokens')).toBeVisible();
  expect(screen.getByText('部分用量：输入 未提供 · 输出 未提供 · 服务商总量 9 tokens')).toBeVisible();
  expect(screen.queryByRole('button', { name: '加载更多调用' })).toBeNull();
  expect(fetcher).toHaveBeenLastCalledWith(`${path}/invocations?pageSize=100&cursor=next-page`, expect.objectContaining({ credentials: 'include' }));
});

it('clears previously observed calls when access is lost while loading another page', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('cursor=next-page')
    ? json({ error: { code: 'forbidden' } }, 403)
    : json(invocationPage([invocation()], 'next-page'))));
  render(view()); fireEvent.click(screen.getByRole('button', { name: '模型调用' }));
  expect(await screen.findByText('输入 22 · 输出 30 · 合计 52 tokens')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '加载更多调用' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('你没有执行此操作的权限');
  expect(screen.queryByText('输入 22 · 输出 30 · 合计 52 tokens')).toBeNull();
});

it('rejects another run’s invocation and retries without showing the foreign model', async () => {
  let invalid = true;
  vi.stubGlobal('fetch', vi.fn(async () => invalid
    ? json(invocationPage([invocation({ runId: 'other-run', modelId: 'FOREIGN MODEL' })]))
    : json(invocationPage([invocation()]))));
  render(view()); fireEvent.click(screen.getByRole('button', { name: '模型调用' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('模型调用记录响应无效');
  expect(screen.queryByText(/FOREIGN MODEL/)).toBeNull();
  invalid = false; fireEvent.click(screen.getByRole('button', { name: '重试' }));
  expect(await screen.findByText('输入 22 · 输出 30 · 合计 52 tokens')).toBeVisible();
});

it('refreshes the same invocation when a running task settles', async () => {
  const fetcher = vi.fn(async () => json(invocationPage([invocation(fetcher.mock.calls.length === 1
    ? { status: 'running', usageStatus: 'unknown', usage: { inputTokens: null, outputTokens: null, computedTotalTokens: null } }
    : {})])));
  vi.stubGlobal('fetch', fetcher);
  const page = render(<SaaSPreferencesProvider><RunEvidence tenantId="tenant-a" runId="run-a" runStatus="running" /></SaaSPreferencesProvider>);
  fireEvent.click(screen.getByRole('button', { name: '模型调用' }));
  expect(await screen.findByText('用量待确认')).toBeVisible();
  page.rerender(<SaaSPreferencesProvider><RunEvidence tenantId="tenant-a" runId="run-a" runStatus="completed" /></SaaSPreferencesProvider>);
  expect(await screen.findByText('输入 22 · 输出 30 · 合计 52 tokens')).toBeVisible();
  expect(screen.queryByText('用量待确认')).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('drops a late ledger response when switching runs', async () => {
  let resolveOld!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn((url: string) => url.includes('tenant-a')
    ? new Promise<Response>(resolve => { resolveOld = resolve; })
    : Promise.resolve(json(invocationPage([invocation({ id: 'new', runId: 'run-b', modelId: 'NEW MODEL', providerModel: 'NEW MODEL' })])))));
  const page = render(view()); fireEvent.click(screen.getByRole('button', { name: '模型调用' }));
  page.rerender(view('tenant-b', 'run-b'));
  fireEvent.click(screen.getByRole('button', { name: '模型调用' }));
  expect(await screen.findByText('llmgate · NEW MODEL')).toBeVisible();
  await act(async () => { resolveOld(json(invocationPage([invocation({ modelId: 'OLD MODEL' })]))); });
  expect(screen.queryByText(/OLD MODEL/)).toBeNull();
});
