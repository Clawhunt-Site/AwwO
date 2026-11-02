import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AdminPanel } from '../src/saas/AdminPanel';
import { SaaSPreferencesProvider } from '../src/saas/preferences';

const identity = { user: { id: 'admin-a', name: 'Admin', email: 'a@example.invalid', platformRole: 'admin' as const }, tenants: [] };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const summary = { tenantCount: 0, userCount: 0, activeRuns: 0, completedRuns: 0, failedRuns: 0 };
const path = (model: string, patch: Record<string, unknown> = {}) => ({ runtime: 'pi', kind: 'computer', model, calls: 30, cacheKnownCalls: 30, inputTokens: '30000',
  cachedInputTokens: '24000', cacheWriteTokens: '1500', outputTokens: '3000', readShare: 0.8, previous: { calls: 30, cacheKnownCalls: 30, readShare: 0.9 }, falling: false, ...patch });
const view = (days: number, paths: unknown[]) => ({ days, asOf: '2026-11-02T12:00:00Z', alert: { drop: 0.2, calls: 20 }, paths });

beforeEach(() => { localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

/** Serves the panel, with cache answering each request for days. */
function serve(cache: (days: number) => Response | Promise<Response>) {
  const urls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    urls.push(url);
    if (url.endsWith('/admin/summary')) return response(summary);
    const asked = /\/admin\/observability\/cache\?days=(\d+)$/.exec(url);
    if (asked) return cache(Number(asked[1]));
    return response({ items: [], nextCursor: null });
  }));
  return urls;
}

async function openTab() {
  render(<SaaSPreferencesProvider><AdminPanel identity={identity}/></SaaSPreferencesProvider>);
  fireEvent.click(await screen.findByRole('button', { name: '提示缓存' }));
  return screen.findByRole('region', { name: '提示缓存' });
}

it('shows each path’s cache read share beside the days before, marks one that fell, and says when not every call reported the cache', async () => {
  serve(() => response(view(7, [path('loop-model'), path('single-model', { runtime: 'openai-agents', kind: 'node', cacheKnownCalls: 25, readShare: 0.1,
    previous: { calls: 25, cacheKnownCalls: 25, readShare: 0.6 }, falling: true })])));
  const region = await openTab();
  const rows = await within(region).findAllByRole('row');
  expect(rows).toHaveLength(3);
  expect(within(rows[1]).getByText('pi · 直接执行 · loop-model')).toBeVisible();
  expect(within(rows[1]).getByText('80.0%')).toBeVisible();
  expect(within(rows[1]).getByText('30,000')).toBeVisible();
  expect(within(rows[1]).queryByText('下降')).toBeNull();
  expect(rows[1]).not.toHaveClass('saas-admin-falling');
  expect(within(rows[2]).getByText('openai-agents · 画布节点 · single-model')).toBeVisible();
  expect(within(rows[2]).getByText('下降')).toBeVisible();
  expect(within(rows[2]).getByText('30（25 次报告了缓存）')).toBeVisible();
  expect(rows[2]).toHaveClass('saas-admin-falling');
});

it('reads the days chosen, shows what they hold, and keeps them when the panel is refreshed', async () => {
  const urls = serve(days => response(view(days, [path(`model-of-${days}-days`)])));
  const region = await openTab();
  expect(await within(region).findByText('pi · 直接执行 · model-of-7-days')).toBeVisible();
  fireEvent.change(within(region).getByLabelText('天数'), { target: { value: '30' } });
  expect(await within(region).findByText('pi · 直接执行 · model-of-30-days')).toBeVisible();
  expect(within(region).queryByText('pi · 直接执行 · model-of-7-days')).toBeNull();
  const before = urls.filter(url => url.endsWith('cache?days=30')).length;
  fireEvent.click(screen.getByRole('button', { name: '刷新数据' }));
  await waitFor(() => expect(urls.filter(url => url.endsWith('cache?days=30')).length).toBe(before + 1));
  expect(within(screen.getByRole('region', { name: '提示缓存' })).getByLabelText('天数')).toHaveValue('30');
  expect(await screen.findByText('pi · 直接执行 · model-of-30-days')).toBeVisible();
});

it('shows the days last chosen, not an answer for days chosen before it that came late', async () => {
  let late: (value: Response) => void = () => undefined;
  serve(days => days === 7 ? new Promise<Response>(resolve => { late = resolve; }) : response(view(days, [path(`model-of-${days}-days`)])));
  const region = await openTab();
  fireEvent.change(within(region).getByLabelText('天数'), { target: { value: '14' } });
  expect(await within(region).findByText('pi · 直接执行 · model-of-14-days')).toBeVisible();
  await act(async () => { late(response(view(7, [path('model-of-7-days')]))); });
  expect(within(region).getByText('pi · 直接执行 · model-of-14-days')).toBeVisible();
  expect(within(region).queryByText('pi · 直接执行 · model-of-7-days')).toBeNull();
});

it('groups token totals beyond what a JavaScript number holds exactly as the integers they are', async () => {
  serve(() => response(view(7, [path('big-model', { inputTokens: '9007199254740993' })])));
  const region = await openTab();
  expect(await within(region).findByText('9,007,199,254,740,993')).toBeVisible();
});

it('refuses a view whose paths are not all whole, rather than showing part of it', async () => {
  for (const broken of [{ runtime: 'pi', model: 'half-model' }, path('no-tokens', { inputTokens: undefined, cachedInputTokens: undefined, readShare: undefined }),
    path('not-a-number', { inputTokens: '12e3' }), path('no-share', { previous: { calls: 3, cacheKnownCalls: 3, readShare: 'high' } })]) {
    serve(() => response(view(7, [path('loop-model'), broken])));
    const region = await openTab();
    expect(await within(region).findByRole('alert')).toBeVisible();
    expect(within(region).queryByRole('table')).toBeNull();
    cleanup();
    vi.unstubAllGlobals();
  }
});

it('refuses a view that is not for the days asked or lacks its time or alert, rather than showing it empty', async () => {
  for (const broken of [view(30, []), { ...view(7, []), asOf: undefined }, { ...view(7, []), alert: {} }, { ...view(7, []), alert: { drop: 0.2, calls: -1 } }]) {
    serve(() => response(broken));
    const region = await openTab();
    expect(await within(region).findByRole('alert')).toBeVisible();
    expect(within(region).queryByRole('table')).toBeNull();
    cleanup();
    vi.unstubAllGlobals();
  }
});

it('says so when the view cannot be read, rather than showing an empty one', async () => {
  serve(() => response({ error: { code: 'usage_unavailable', message: 'Usage is unavailable' } }, 503));
  const region = await openTab();
  expect(await within(region).findByRole('alert')).toBeVisible();
  expect(within(region).queryByRole('table')).toBeNull();
});
