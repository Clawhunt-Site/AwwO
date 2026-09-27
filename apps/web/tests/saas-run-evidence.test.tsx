import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RunEvidence } from '../src/saas/RunEvidence';
import { SaaSPreferencesProvider } from '../src/saas/preferences';

const path = '/api/v1/tenants/tenant-a/runs/run-a';
const evidence = (patch = {}) => ({ runId: 'run-a', status: 'completed', outputPresent: true, outputBytes: 42, artifactCount: 0,
  contract: { declared: true, validated: true }, manualAcceptance: { required: true, verified: false },
  evidenceSources: ['model_output', 'contract_validated'], observational: true, preview: 'Observed output <script>never execute</script>', previewTruncated: false, ...patch });
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
  const fetcher = vi.fn(async (url: string) => url.endsWith('/archive')
    ? new Response('{"record":"redacted"}\n', { headers: { 'Content-Type': 'application/x-ndjson', 'Content-Disposition': 'attachment; filename="run-redacted.ndjson"' } }) : json(evidence()));
  vi.stubGlobal('fetch', fetcher);
  const objectURL = vi.fn(() => 'blob:archive'); const revoke = vi.fn();
  vi.stubGlobal('URL', class extends URL { static createObjectURL = objectURL; static revokeObjectURL = revoke; });
  let savedName = ''; const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { savedName = this.download; });
  render(view()); fireEvent.click(screen.getByRole('button', { name: '证据摘要' }));
  await screen.findByText('人工验收尚未确认'); expect(fetcher).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: '下载脱敏记录' }));
  await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
  expect(savedName).toBe('run-redacted.ndjson');
  expect(objectURL).toHaveBeenCalledWith(expect.any(Blob));
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
