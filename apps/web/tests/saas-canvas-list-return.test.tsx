import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CanvasList } from '../src/saas/CanvasList';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import type { CanvasRecord, Tenant } from '../src/saas/api';

const tenant: Tenant = { id: 'tenant-a', name: 'Workspace A', role: 'owner', status: 'active', maxConcurrentRuns: 2, maxRunsPerDay: 10 };
const record = (id: number, name = `Canvas ${id}`): CanvasRecord => ({ id: `canvas-${id}`, tenantId: tenant.id, name, version: 1,
  document: { nodes: [] }, createdAt: '2026-09-07T00:00:00Z', updatedAt: '2026-09-07T00:00:00Z' });
const list = (userId = 'alice', workspace = tenant, onOpen = vi.fn()) => <SaaSPreferencesProvider>
  <CanvasList userId={userId} tenant={workspace} onOpen={onOpen} recentLimit={4} />
</SaaSPreferencesProvider>;
const search = () => screen.getByRole('searchbox', { name: '按名称搜索画布' });
const server = (rows = Array.from({ length: 6 }, (_, i) => record(i))) => {
  const fetcher = vi.fn(async (input: string) => {
    const url = new URL(input, 'http://localhost');
    const offset = Number(url.searchParams.get('cursor') || 0);
    return Response.json({ items: rows.slice(offset, offset + 50), nextCursor: offset + 50 < rows.length ? String(offset + 50) : null });
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
};
beforeEach(() => { sessionStorage.clear(); localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh'); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('restores the search and expanded list after opening a canvas, but fetches fresh records', async () => {
  const rows = Array.from({ length: 6 }, (_, i) => record(i));
  const fetcher = server(rows);
  const open = vi.fn();
  const first = render(list('alice', tenant, open));
  await screen.findByRole('heading', { name: 'Canvas 0' });
  fireEvent.click(screen.getByRole('button', { name: '查看全部 6 张' }));
  fireEvent.change(search(), { target: { value: 'Canvas 5' } });
  fireEvent.click(screen.getByRole('button', { name: /^Canvas 5/ }));
  expect(open).toHaveBeenCalledWith('canvas-5');
  first.unmount();
  rows[5] = record(5, 'Canvas 5 updated remotely');
  render(list());
  expect(search()).toHaveValue('Canvas 5');
  expect(await screen.findByRole('heading', { name: 'Canvas 5 updated remotely' })).toBeVisible();
  expect(screen.getByRole('button', { name: '收起' })).toHaveAttribute('aria-expanded', 'true');
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(sessionStorage.getItem(sessionStorage.key(0)!)).not.toContain('updated remotely');
  fireEvent.click(screen.getByRole('button', { name: '清除搜索' }));
  expect(search()).toHaveValue('');
  expect(search()).toHaveFocus();
  expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(6);
});

it('keeps presentation state separate for accounts and workspaces even without an outer remount', async () => {
  server();
  const view = render(list());
  await screen.findByRole('heading', { name: 'Canvas 0' });
  fireEvent.click(screen.getByRole('button', { name: '查看全部 6 张' }));
  fireEvent.change(search(), { target: { value: 'Canvas 5' } });
  view.rerender(list('bob'));
  await screen.findByRole('heading', { name: 'Canvas 0' });
  expect(search()).toHaveValue('');
  expect(screen.getByRole('button', { name: '查看全部 6 张' })).toHaveAttribute('aria-expanded', 'false');
  view.rerender(list('alice', { ...tenant, id: 'tenant-b' }));
  await screen.findByRole('heading', { name: 'Canvas 0' });
  expect(search()).toHaveValue('');
  view.rerender(list());
  expect(search()).toHaveValue('Canvas 5');
  expect(await screen.findByRole('heading', { name: 'Canvas 5' })).toBeVisible();
  expect(screen.getByRole('button', { name: '收起' })).toBeVisible();
});

it('offers pagination immediately for a search with no matches on the loaded page', async () => {
  const fetcher = server(Array.from({ length: 51 }, (_, i) => record(i)));
  render(list());
  await screen.findByRole('heading', { name: 'Canvas 0' });
  expect(screen.getByText('只搜索当前页')).toBeVisible();
  expect(screen.queryByRole('navigation', { name: '画布分页' })).toBeNull();
  fireEvent.change(search(), { target: { value: 'Canvas 50' } });
  expect(screen.getByText('没有名称包含“Canvas 50”的画布（只搜索当前页）')).toBeVisible();
  const pager = within(screen.getByRole('navigation', { name: '画布分页' }));
  fireEvent.click(pager.getByRole('button', { name: '下一页' }));
  expect(await screen.findByRole('heading', { name: 'Canvas 50' })).toBeVisible();
  expect(search()).toHaveValue('Canvas 50');
  expect(screen.getByText('找到 1 张画布（只搜索当前页）')).toBeVisible();
  expect(fetcher).toHaveBeenCalledTimes(2);
  fireEvent.keyDown(search(), { key: 'Escape' });
  expect(await screen.findByRole('heading', { name: 'Canvas 0' })).toBeVisible();
  expect(search()).toHaveValue('');
  expect(screen.queryByRole('navigation', { name: '画布分页' })).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it('still supports searching and opening a canvas when session storage is blocked', async () => {
  server();
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('Blocked', 'SecurityError'); });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Blocked', 'SecurityError'); });
  const open = vi.fn();
  render(list('alice', tenant, open));
  await screen.findByRole('heading', { name: 'Canvas 0' });
  fireEvent.change(search(), { target: { value: 'Canvas 5' } });
  fireEvent.click(screen.getByRole('button', { name: /^Canvas 5/ }));
  expect(open).toHaveBeenCalledWith('canvas-5');
});

it('restores no cached canvas data or write permission for a reader returning to the list', async () => {
  server();
  const first = render(list());
  await screen.findByRole('heading', { name: 'Canvas 0' });
  fireEvent.change(search(), { target: { value: 'Canvas 5' } });
  first.unmount();
  render(list('alice', { ...tenant, role: 'reader' }));
  expect(await screen.findByRole('heading', { name: 'Canvas 5' })).toBeVisible();
  expect(screen.queryByRole('button', { name: /^画布选项：/ })).toBeNull();
  expect(screen.getByText(/只读成员/)).toBeVisible();
});

it('does not store list preferences without a known user scope', async () => {
  server();
  render(<SaaSPreferencesProvider><CanvasList tenant={tenant} onOpen={vi.fn()} recentLimit={4} /></SaaSPreferencesProvider>);
  await screen.findByRole('heading', { name: 'Canvas 0' });
  fireEvent.change(search(), { target: { value: 'Canvas 5' } });
  await waitFor(() => expect(search()).toHaveValue('Canvas 5'));
  expect(sessionStorage.length).toBe(0);
});

it('ignores invalid or oversized saved state and bounds an otherwise valid query', async () => {
  const { readCanvasListView, saveCanvasListView } = await import('../src/saas/canvasListView');
  saveCanvasListView('alice', tenant.id, { query: 'x'.repeat(300), expanded: true });
  const key = sessionStorage.key(0)!;
  expect(readCanvasListView('alice', tenant.id)).toEqual({ query: 'x'.repeat(100), expanded: true });
  for (const malformed of ['invalid json', 'null', '[]', '"text"', 'x'.repeat(2049)]) {
    sessionStorage.setItem(key, malformed);
    expect(readCanvasListView('alice', tenant.id)).toEqual({ query: '', expanded: false });
  }
  sessionStorage.setItem(key, JSON.stringify({ query: 7, expanded: 'true', document: { nodes: [] } }));
  expect(readCanvasListView('alice', tenant.id)).toEqual({ query: '', expanded: false });
  sessionStorage.setItem(key, JSON.stringify({ query: 'x'.repeat(300), expanded: true }));
  expect(readCanvasListView('alice', tenant.id)).toEqual({ query: 'x'.repeat(100), expanded: true });
});
