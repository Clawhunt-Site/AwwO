import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AccountWorkspacePanel } from '../src/account/AccountWorkspacePanel';
import { createSaaSAccountApi } from '../src/saas/accountApi';
import { listPage } from '../src/saas/listPage';

const identity = { user: { id: 'owner', name: 'Owner', email: 'owner@example.test', platformRole: 'user' }, tenants: ['a', 'b'].map(id => ({ id, name: `Workspace ${id}`, status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 10 })) };
const member = (i: number) => ({ id: `m-${i}`, userId: `u-${i}`, name: `Member ${i}`, email: `m${i}@example.test`, role: 'member' });
const invite = (i: number) => ({ id: `invite-${i}`, role: 'reader', status: 'active', expiresAt: new Date(Date.UTC(2099, 0, i + 1)).toISOString() });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const props = { locale: 'zh' as const, clawHuntIdentity: null, onCompanyChange: vi.fn(), onClawHuntLogin: vi.fn(), onClawHuntLogout: vi.fn(), workspaceOnly: true };
beforeEach(() => { localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('pages past 200 members in the original account panel and updates a member without fetching the first page', async () => {
  const rows = Array.from({ length: 201 }, (_, i) => member(i));
  const calls: Array<{ url: URL; method: string; body?: any }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, 'http://localhost'); calls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body as string) : undefined });
    if (url.pathname.endsWith('/auth/me')) return json(identity);
    if (init.method === 'PATCH') return new Response(null, { status: 204 });
    if (url.pathname.endsWith('/invites')) return json({ items: [], nextCursor: null });
    const start = Number(url.searchParams.get('cursor') || 0), limit = Number(url.searchParams.get('limit'));
    return json({ items: rows.slice(start, start + limit), nextCursor: start + limit < rows.length ? String(start + limit) : null });
  }));
  render(<AccountWorkspacePanel {...props} selectedCompanyId="a" api={createSaaSAccountApi(vi.fn())}/>);
  await screen.findByText('m0@example.test');
  for (let page = 1; page < 5; page++) {
    fireEvent.click(within(screen.getByRole('navigation', { name: '成员分页' })).getByRole('button', { name: '下一页' }));
    await screen.findByText(`m${page * 50}@example.test`);
  }
  const countBefore = calls.length;
  fireEvent.change(screen.getByRole('combobox', { name: 'Member 200 的角色' }), { target: { value: 'reader' } });
  await waitFor(() => expect(screen.getByRole('combobox', { name: 'Member 200 的角色' })).toHaveValue('reader'));
  expect(calls.slice(countBefore)).toHaveLength(1);
  expect(calls.at(-1)).toMatchObject({ method: 'PATCH', body: { role: 'reader' } });
  expect(calls.at(-1)!.url.pathname).toBe('/api/v1/tenants/a/members/u-200');
  expect(calls.filter(call => call.url.pathname.endsWith('/members')).map(call => call.url.searchParams.get('cursor'))).toEqual([null, '50', '100', '150', '200']);
  expect(calls.filter(call => call.url.pathname.endsWith('/members')).every(call => call.url.searchParams.get('limit') === '50')).toBe(true);
});

it('pages and revokes the 201st invitation without enumerating all invitations upfront', async () => {
  const rows = Array.from({ length: 201 }, (_, i) => invite(i)); const gets: URL[] = []; const deleted: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, 'http://localhost');
    if (url.pathname.endsWith('/auth/me')) return json(identity);
    if (init.method === 'DELETE') { deleted.push(url.pathname); return new Response(null, { status: 204 }); }
    if (url.pathname.endsWith('/members')) return json({ items: [member(0)], nextCursor: null });
    gets.push(url); const start = Number(url.searchParams.get('cursor') || 0);
    return json({ items: rows.slice(start, start + 50), nextCursor: start + 50 < rows.length ? String(start + 50) : null });
  }));
  render(<AccountWorkspacePanel {...props} selectedCompanyId="a" api={createSaaSAccountApi(vi.fn())}/>);
  await screen.findByRole('navigation', { name: '邀请分页' });
  expect(gets).toHaveLength(1);
  for (let page = 1; page < 5; page++) {
    const pager = within(screen.getByRole('navigation', { name: '邀请分页' }));
    fireEvent.click(pager.getByRole('button', { name: '下一页' }));
    await waitFor(() => expect(screen.getAllByRole('button', { name: '撤销邀请' })).toHaveLength(page === 4 ? 1 : 50));
    await waitFor(() => expect(within(screen.getByRole('navigation', { name: '邀请分页' })).getByRole('button', { name: '刷新列表' })).toBeEnabled());
  }
  fireEvent.click(screen.getByRole('button', { name: '撤销邀请' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: '撤销邀请' })).toBeNull());
  expect(deleted).toEqual(['/api/v1/tenants/a/invites/invite-200']);
  expect(gets.map(url => url.searchParams.get('cursor'))).toEqual([null, '50', '100', '150', '200']);
  fireEvent.click(within(screen.getByRole('navigation', { name: '邀请分页' })).getByRole('button', { name: '刷新列表' }));
  await waitFor(() => expect(screen.getAllByRole('button', { name: '撤销邀请' })).toHaveLength(50));
  expect(gets.at(-1)!.searchParams.has('cursor')).toBe(false);
});

it('discards old-scope responses and resets member and invite cursors when switching workspaces', async () => {
  let resolveOld!: (response: Response) => void;
  const calls: URL[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const url = new URL(input, 'http://localhost'); calls.push(url);
    if (url.pathname.endsWith('/auth/me')) return json(identity);
    if (url.pathname.includes('/a/') && url.pathname.endsWith('/members')) return new Promise<Response>(resolve => { resolveOld = resolve; });
    if (url.pathname.endsWith('/members')) return json({ items: [{ ...member(0), name: 'Only B', email: 'only-b@example.test' }], nextCursor: null });
    return json({ items: [], nextCursor: null });
  }));
  const api = createSaaSAccountApi(vi.fn());
  const view = render(<AccountWorkspacePanel {...props} selectedCompanyId="a" api={api}/>);
  await waitFor(() => expect(resolveOld).toBeTypeOf('function'));
  view.rerender(<AccountWorkspacePanel {...props} selectedCompanyId="b" api={api}/>);
  await screen.findByText('only-b@example.test');
  await act(async () => resolveOld(json({ items: [{ ...member(1), email: 'private-a@example.test' }], nextCursor: 'a-secret-cursor' })));
  expect(screen.queryByText('private-a@example.test')).toBeNull();
  expect(calls.filter(url => url.pathname.includes('/b/')).every(url => !url.searchParams.has('cursor'))).toBe(true);
  expect(within(screen.getByRole('navigation', { name: '成员分页' })).getByRole('button', { name: '下一页' })).toBeDisabled();
});

it('keeps current-page member metadata when an older page request resolves late', async () => {
  let resolveOld!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
    if (input.endsWith('/auth/me')) return json(identity);
    if (init.method === 'PATCH') return new Response(null, { status: 204 });
    if (input.includes('cursor=next')) return json({ items: [member(200)], nextCursor: null });
    return new Promise<Response>(resolve => { resolveOld = resolve; });
  }));
  const api = createSaaSAccountApi(vi.fn());
  const old = api.listMembers('a'); await waitFor(() => expect(resolveOld).toBeTypeOf('function'));
  await api.listMembers('a', { cursor: 'next' });
  resolveOld(json({ items: [member(0)], nextCursor: 'next' })); await old;
  expect(await api.updateMember('a', 'u-200', { membershipRole: 'reader' })).toMatchObject({ principalId: 'u-200', membershipRole: 'reader' });
});

it('retains filters and requests exactly one bounded page in the shared helper', async () => {
  const fetcher = vi.fn().mockResolvedValue(json({ items: [], nextCursor: 'another-page' })); vi.stubGlobal('fetch', fetcher);
  await listPage('/tenants/a/sessions?canvasId=canvas-a', 'next token', undefined, 50);
  expect(fetcher).toHaveBeenCalledTimes(1);
  const url = new URL(fetcher.mock.calls[0][0], 'http://localhost');
  expect(Object.fromEntries(url.searchParams)).toEqual({ canvasId: 'canvas-a', limit: '50', cursor: 'next token' });
});
