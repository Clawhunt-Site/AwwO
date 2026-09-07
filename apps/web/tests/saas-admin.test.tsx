import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AdminPanel } from '../src/saas/AdminPanel';
import { collectAdminExport } from '../src/saas/adminData';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
const identity = { user: { id: 'admin-a', name: 'Admin', email: 'a@example.invalid', platformRole: 'admin' as const }, tenants: [] };
const tenant = { id: 't-a', name: 'Tenant A', status: 'active', maxConcurrentRuns: 2, maxRunsPerDay: 10 };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
beforeEach(() => { localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('edits quota through Go without changing tenant status and reloads the first page', async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
    requests.push({ url, init });
    if (init.method === 'PATCH') return response({ ...tenant, ...JSON.parse(String(init.body)) });
    return response({ items: [tenant], nextCursor: null });
  });
  vi.stubGlobal('fetch', fetch);
  render(<SaaSPreferencesProvider><AdminPanel identity={identity}/></SaaSPreferencesProvider>);
  fireEvent.click(await screen.findByRole('button', { name: '编辑配额' }));
  fireEvent.change(screen.getByLabelText('最大并发运行数'), { target: { value: '5' } });
  fireEvent.change(screen.getByLabelText('每日运行上限'), { target: { value: '321' } });
  fireEvent.click(screen.getByRole('button', { name: '保存配额' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  const patch = requests.find(request => request.init.method === 'PATCH')!;
  expect(patch.url).toBe('/api/v1/admin/tenants/t-a');
  expect(JSON.parse(String(patch.init.body))).toEqual({ maxConcurrentRuns: 5, maxRunsPerDay: 321 });
  expect(requests.filter(request => !request.init.method)).toHaveLength(2);
});

it('follows opaque cursors, restores the previous page and resets on a new section', async () => {
  const fetch = vi.fn(async (url: string) => response({ items: [{ ...tenant, name: url.includes('cursor=') ? 'Tenant B' : 'Tenant A' }], nextCursor: url.includes('cursor=') ? null : 'opaque:token' }));
  vi.stubGlobal('fetch', fetch);
  render(<SaaSPreferencesProvider><AdminPanel identity={identity}/></SaaSPreferencesProvider>);
  await screen.findByText('Tenant A');
  fireEvent.click(screen.getByRole('button', { name: '下一页' }));
  await screen.findByText('Tenant B');
  expect(fetch.mock.calls.at(-1)?.[0]).toContain('cursor=opaque%3Atoken');
  fireEvent.click(screen.getByRole('button', { name: '上一页' }));
  await screen.findByText('Tenant A');
  fireEvent.click(screen.getByRole('button', { name: '用户', exact: true }));
  await waitFor(() => expect(fetch.mock.calls.at(-1)?.[0]).toBe('/api/v1/admin/users?limit=50'));
});

it('exports beyond 200 records and does not return a partial result after a later-page failure', async () => {
  const first = Array.from({ length: 200 }, (_, id) => ({ id: String(id) }));
  const fetch = vi.fn().mockResolvedValueOnce(response({ items: first, nextCursor: 'page2', snapshot: 'fixed' }))
    .mockResolvedValueOnce(response({ items: [{ id: '200' }], nextCursor: null, snapshot: 'fixed' }));
  vi.stubGlobal('fetch', fetch);
  const progress = vi.fn();
  const result = await collectAdminExport('users', new AbortController().signal, progress);
  expect(result.count).toBe(201); expect(result.insertionBoundary).toBe('fixed');
  expect(progress.mock.calls).toEqual([[200], [201]]);
  fetch.mockResolvedValueOnce(response({ items: first, nextCursor: 'page2', snapshot: 'fixed' })).mockResolvedValueOnce(response({ error: { message: 'Offline' } }, 503));
  await expect(collectAdminExport('users', new AbortController().signal, vi.fn())).rejects.toThrow('Offline');
});

it('cancels before another page and rejects repeated cursors instead of looping', async () => {
  const fetch = vi.fn(async () => response({ items: [tenant], nextCursor: 'same', snapshot: 'fixed' }));
  vi.stubGlobal('fetch', fetch);
  const controller = new AbortController();
  await expect(collectAdminExport('tenants', controller.signal, () => controller.abort())).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(1);
  fetch.mockClear();
  await expect(collectAdminExport('tenants', new AbortController().signal, vi.fn())).rejects.toThrow('Pagination did not advance');
  expect(fetch).toHaveBeenCalledTimes(2);
});
