// 我的画布 (CanvasList `grouped`): every canvas by when it was last updated, in the reader's own time: 今天, 最近 7 天 and
// 更早, a heading for each group that holds one; a search keeps the groups; renaming and deleting stay as they were.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CanvasList } from '../src/saas/CanvasList';
import { canvasGroupOf, groupCanvases } from '../src/saas/home/canvasGroups';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import type { CanvasRecord, Tenant } from '../src/saas/api';

const tenant: Tenant = { id: 'team-g', name: 'Team G', role: 'owner', status: 'active', maxConcurrentRuns: 2, maxRunsPerDay: 10 };
// Local times, so the groups are the same in any time zone the tests run in.
const NOW = new Date(2026, 10, 7, 15, 0);
const at = (days: number, hour = 9) => new Date(2026, 10, 7 - days, hour).toISOString();
const record = (id: string, name: string, updatedAt: string): CanvasRecord => ({ id, tenantId: tenant.id, name, version: 1, document: { nodes: [] }, createdAt: at(30), updatedAt });

describe('the groups', () => {
  it('put a canvas in today, the six days before or earlier, by local midnights', () => {
    expect(canvasGroupOf(new Date(2026, 10, 7, 0, 0).toISOString(), NOW)).toBe('today');
    expect(canvasGroupOf(new Date(2026, 10, 8, 2).toISOString(), NOW)).toBe('today');
    expect(canvasGroupOf(new Date(2026, 10, 6, 23, 59).toISOString(), NOW)).toBe('week');
    expect(canvasGroupOf(new Date(2026, 10, 1, 0, 0).toISOString(), NOW)).toBe('week');
    expect(canvasGroupOf(new Date(2026, 9, 31, 23, 59).toISOString(), NOW)).toBe('earlier');
    expect(canvasGroupOf('not a time', NOW)).toBe('earlier');
    const items = [{ updatedAt: at(10), id: 'a' }, { updatedAt: at(0), id: 'b' }, { updatedAt: at(12), id: 'c' }];
    expect(groupCanvases(items, NOW)).toEqual([{ id: 'today', items: [items[1]] }, { id: 'earlier', items: [items[0], items[2]] }]);
  });
});

describe('我的画布', () => {
  beforeEach(() => {
    localStorage.clear(); sessionStorage.clear(); localStorage.setItem('superclaw_locale', 'zh');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
  const server = (rows: CanvasRecord[]) => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: rows, nextCursor: null }))));
  const list = (role = 'owner') => render(<SaaSPreferencesProvider><CanvasList userId="user-g" tenant={{ ...tenant, role }} onOpen={vi.fn()} grouped /></SaaSPreferencesProvider>);
  const group = (name: string) => screen.getByRole('heading', { level: 3, name }).closest('section')!;
  const names = (name: string) => within(group(name)).getAllByRole('heading', { level: 4 }).map(heading => heading.textContent);

  it('draws a heading for each group that holds a canvas, newest first in each, and leaves out empty ones', async () => {
    server([record('c1', 'Old plan', at(20)), record('c2', 'Today’s brief', at(0, 11)), record('c3', 'Launch kit', at(2)), record('c4', 'This morning', at(0, 8)), record('c5', 'Older still', at(40))]);
    list();
    expect(await screen.findByRole('heading', { level: 2, name: '我的画布' })).toBeVisible();
    await waitFor(() => expect(screen.getAllByRole('heading', { level: 3 }).map(heading => heading.textContent)).toEqual(['今天', '最近 7 天', '更早']));
    expect(names('今天')).toEqual(['Today’s brief', 'This morning']);
    expect(names('最近 7 天')).toEqual(['Launch kit']);
    expect(names('更早')).toEqual(['Old plan', 'Older still']);
    expect(within(group('今天')).getByText('2 张')).toBeVisible();
    // Every canvas is here: no 查看全部, and 首页's tutorial anchor stays on 首页's list.
    expect(screen.queryByRole('button', { name: /查看全部/ })).toBeNull();
    expect(document.querySelector('[data-onboarding="canvas-list"]')).toBeNull();
    // Renaming and deleting are where they were.
    expect(within(group('最近 7 天')).getByRole('button', { name: '画布选项：Launch kit' })).toBeVisible();
  });

  it('keeps the groups for a search’s matches, and draws none without a canvas', async () => {
    server([record('c1', 'Plan A', at(0)), record('c2', 'Plan B', at(9)), record('c3', 'Report', at(1))]);
    list();
    await screen.findByRole('heading', { level: 3, name: '今天' });
    fireEvent.change(screen.getByRole('searchbox', { name: '按名称搜索画布' }), { target: { value: 'plan' } });
    expect(screen.getAllByRole('heading', { level: 3 }).map(heading => heading.textContent)).toEqual(['今天', '更早']);
    expect(screen.getByText('找到 2 张画布')).toBeVisible();
    cleanup();
    server([]);
    list();
    expect(await screen.findByRole('heading', { level: 3, name: '从第一张画布开始' })).toBeVisible();
    expect(screen.getByText(/在「首页」写下目标/)).toBeVisible();
  });

  it('reads in English, and gives a reader the groups without the canvas options', async () => {
    localStorage.setItem('superclaw_locale', 'en');
    server([record('c1', 'Plan', at(0)), record('c2', 'Kit', at(3)), record('c3', 'Old', at(9))]);
    list('reader');
    expect(await screen.findByRole('heading', { level: 2, name: 'My canvases' })).toBeVisible();
    await waitFor(() => expect(screen.getAllByRole('heading', { level: 3 }).map(heading => heading.textContent)).toEqual(['Today', 'Last 7 days', 'Earlier']));
    expect(screen.queryByRole('button', { name: /^Canvas options/ })).toBeNull();
  });
});
