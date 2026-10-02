import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AdminRunSummary, validAdminSummary } from '../src/saas/AdminRunSummary';
import { AdminPanel } from '../src/saas/AdminPanel';
import { trackSignedInSession, type Identity } from '../src/saas/api';
import { SaaSPreferencesProvider } from '../src/saas/preferences';

const admin: Identity = { user: { id: 'admin-a', name: 'Admin', email: 'admin@example.test', platformRole: 'admin' }, tenants: [] };
const summary = { tenantCount: 3, userCount: 5, activeRuns: 7, completedRuns: 41, failedRuns: 2 };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const view = (identity = admin) => <SaaSPreferencesProvider><AdminRunSummary identity={identity}/></SaaSPreferencesProvider>;
const pending = () => { let resolve!: (value: Response) => void; return { promise: new Promise<Response>(done => { resolve = done; }), resolve: (value: Response) => resolve(value) }; };
beforeEach(() => { localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh'); trackSignedInSession(false); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it('reads the existing summary endpoint with credentials and labels queued/running counts plus read time', async () => {
  const fetcher = vi.fn(async () => response(summary)); vi.stubGlobal('fetch', fetcher);
  render(view());
  expect(screen.getByRole('status')).toHaveTextContent('正在读取');
  await screen.findByText('7');
  expect(screen.getByText('执行中任务（排队 + 运行）').nextElementSibling).toHaveTextContent('7');
  expect(screen.getByText('失败或中断').nextElementSibling).toHaveTextContent('2');
  const time = document.querySelector('time')!;
  expect(Number.isFinite(Date.parse(time.dateTime))).toBe(true);
  expect(screen.getByText('按读取时刻统计；不自动刷新。')).toBeVisible();
  expect(fetcher).toHaveBeenCalledWith('/api/v1/admin/summary', expect.objectContaining({ credentials: 'include', signal: expect.any(AbortSignal) }));
});

it('hides previous counts immediately during refresh and failure, then permits a verified zero', async () => {
  const second = pending();
  const fetcher = vi.fn().mockResolvedValueOnce(response(summary)).mockReturnValueOnce(second.promise)
    .mockResolvedValueOnce(response({ ...summary, activeRuns: 0 }));
  vi.stubGlobal('fetch', fetcher); render(view()); await screen.findByText('7');
  fireEvent.click(screen.getByRole('button', { name: '刷新概览' }));
  expect(screen.queryByText('7')).toBeNull(); expect(document.querySelector('time')).toBeNull();
  expect(screen.getByRole('status')).toHaveTextContent('正在读取');
  await act(async () => second.resolve(response({ error: { code: 'forbidden' } }, 403)));
  expect(await screen.findByRole('alert')).toHaveTextContent('当前任务数量未知');
  expect(screen.queryByText('0')).toBeNull(); expect(screen.queryByText('7')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '刷新概览' }));
  expect(await screen.findByText('0')).toBeVisible();
  expect(document.querySelector('time')).not.toBeNull();
});

it('rejects malformed, partial, negative, fractional, nonfinite and unsafe-integer counters', () => {
  for (const value of [null, [], {}, 'summary', { ...summary, activeRuns: undefined }]) expect(validAdminSummary(value)).toBe(false);
  for (const key of Object.keys(summary)) for (const value of [-1, 1.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '0', null]) {
    expect(validAdminSummary({ ...summary, [key]: value })).toBe(false);
  }
  expect(validAdminSummary({ tenantCount: 0, userCount: 0, activeRuns: 0, completedRuns: 0, failedRuns: 0 })).toBe(true);
});

it('shows unknown instead of zero when a successful HTTP response has invalid summary data', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response({ ...summary, activeRuns: '0' })));
  render(view()); expect(await screen.findByRole('alert')).toHaveTextContent('当前任务数量未知');
  expect(screen.queryByText('0')).toBeNull(); expect(document.querySelector('time')).toBeNull();
});

it('does not request or render platform statistics for an ordinary workspace owner', () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  const owner: Identity = { ...admin, user: { ...admin.user, platformRole: 'user' }, tenants: [{ id: 'workspace', name: 'Owned', role: 'owner', status: 'active', maxConcurrentRuns: 2, maxRunsPerDay: 100 }] };
  const direct = render(view(owner)); expect(direct.container).toBeEmptyDOMElement(); direct.unmount();
  render(<SaaSPreferencesProvider><AdminPanel identity={owner}/></SaaSPreferencesProvider>);
  expect(screen.getByText('无平台管理权限')).toBeVisible();
  expect(screen.queryByText('全站运行概览')).toBeNull(); expect(fetcher).not.toHaveBeenCalled();
});

it('aborts old account reads and rejects late results after identity or role changes', async () => {
  const first = pending(), second = pending();
  const fetcher = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  vi.stubGlobal('fetch', fetcher);
  const mounted = render(view());
  const other: Identity = { ...admin, user: { ...admin.user, id: 'admin-b' } };
  mounted.rerender(view(other));
  expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
  await act(async () => first.resolve(response({ ...summary, activeRuns: 99 })));
  expect(screen.queryByText('99')).toBeNull();
  await act(async () => second.resolve(response(summary))); await screen.findByText('7');
  mounted.rerender(view({ ...other, user: { ...other.user, platformRole: 'user' } }));
  expect(screen.queryByText('7')).toBeNull(); expect(screen.queryByText('全站运行概览')).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('stops a hung read after 30 seconds and ignores a late success', async () => {
  vi.useFakeTimers(); const delayed = pending();
  const fetcher = vi.fn().mockReturnValueOnce(delayed.promise); vi.stubGlobal('fetch', fetcher);
  render(view());
  await act(async () => vi.advanceTimersByTime(30_000));
  expect(screen.getByRole('alert')).toHaveTextContent('当前任务数量未知');
  expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
  await act(async () => delayed.resolve(response(summary)));
  expect(screen.queryByText('7')).toBeNull(); expect(screen.getByRole('button', { name: '刷新概览' })).toBeEnabled();
});

it('cleans up the in-flight request on unmount', () => {
  const delayed = pending(); const fetcher = vi.fn().mockReturnValue(delayed.promise); vi.stubGlobal('fetch', fetcher);
  const mounted = render(view()); mounted.unmount(); expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
});
