// 设置 → 成员与工作区 for a person invited into a workspace (account/AccountWorkspacePanel.tsx with the hosted app's account
// API, saas/accountApi.ts): the members list gives them names, never ids where emails are left out (tenant_pagination.go
// shows emails to owners and admins only), and they can leave the workspace, which its owner cannot (resources.go
// leaveTenant); its invitations are asked for by its owners and admins only. Every id, name and email here is made up.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountWorkspacePanel } from '../src/account/AccountWorkspacePanel';
import { createSaaSAccountApi } from '../src/saas/accountApi';

const json = (value: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(value), { status });
const me = (role: string) => ({ user: { id: 'user-bea', name: 'Bea', email: 'bea@example.test', platformRole: 'user' },
  tenants: [{ id: 'team-a', name: 'Team A', role, status: 'active', maxConcurrentRuns: 2, maxRunsPerDay: 10 },
    { id: 'team-b', name: 'Team B', role, status: 'active', maxConcurrentRuns: 2, maxRunsPerDay: 10 }] });
// As a member reads them: names and roles, no email.
const NAMES = [{ userId: 'user-olive', name: 'Olive', role: 'owner' }, { userId: 'user-bea', name: 'Bea', role: 'member' }];

function serve(role: string, members: unknown[] = NAMES) {
  const fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = new URL(url, 'http://localhost').pathname;
    if (path.endsWith('/auth/me')) return json(me(role));
    if (path.endsWith('/members')) return json({ items: members, nextCursor: null });
    if (path.endsWith('/invites')) return json({ items: [], nextCursor: null });
    if (path.endsWith('/leave') && init.method === 'POST') return json(null, 204);
    return json({ items: [] });
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
// One account API per page, as the app has: it keeps the account it read (accountApi.ts), so a test's own is fresh.
const element = (api: ReturnType<typeof createSaaSAccountApi>, onLeftWorkspace: (id: string) => void, locale: 'zh' | 'en', selected: string) => <AccountWorkspacePanel
  locale={locale} clawHuntIdentity={null} selectedCompanyId={selected} onCompanyChange={vi.fn()} onClawHuntLogin={() => {}} onClawHuntLogout={() => {}} api={api}
  workspaceOnly onLeftWorkspace={onLeftWorkspace} />;
const panel = (onLeftWorkspace = vi.fn(), locale: 'zh' | 'en' = 'zh') => {
  render(element(createSaaSAccountApi(() => {}), onLeftWorkspace, locale, 'team-a'));
  return onLeftWorkspace;
};

beforeEach(() => { localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('a person invited into a workspace', () => {
  it('sees the other members by name, with no id where their email is left out', async () => {
    serve('member');
    panel();
    const olive = (await screen.findByText('Olive')).closest('article')!;
    expect(within(olive).queryByText('user-olive')).toBeNull();
    expect(olive.querySelectorAll('.account-member-identity > span')).toHaveLength(0);
  });

  // An account linked to ClawHunt with no name kept yet is named by nothing (tenant_pagination.go, shownUserName).
  it('calls a member the server names by nothing 有人 as the canvas does, never by their id', async () => {
    serve('member', [...NAMES, { userId: 'user-kite', name: '', role: 'member' }]);
    panel();
    const kite = (await screen.findByText('有人')).closest('article')!;
    expect(within(kite).queryByText('user-kite')).toBeNull();
    expect(kite.querySelectorAll('.account-member-identity > span')).toHaveLength(0);
    cleanup();
    serve('reader', [...NAMES, { userId: 'user-kite', name: '  ', role: 'member' }]);
    panel(vi.fn(), 'en');
    expect(within((await screen.findByText('Someone')).closest('article')!).queryByText('user-kite')).toBeNull();
  });

  it('shows its owner such a member by the email once, which names its controls', async () => {
    serve('owner', [{ userId: 'user-bea', name: 'Bea', email: 'bea@example.test', role: 'owner' },
      { userId: 'user-kite', name: '', email: 'kite@example.test', role: 'member' }]);
    panel();
    const kite = (await screen.findByText('kite@example.test')).closest('article')!;
    expect(within(kite).getAllByText('kite@example.test')).toHaveLength(1);
    expect(within(kite).getByRole('combobox', { name: 'kite@example.test 的角色' })).toBeInTheDocument();
    // A named member keeps their email under the name.
    expect(within((await screen.findByText('Bea')).closest('article')!).getByText('bea@example.test')).toBeInTheDocument();
  });

  it('leaves the workspace once confirmed, and the page goes on from there', async () => {
    const fetch = serve('member');
    const left = panel();
    fireEvent.click(await screen.findByRole('button', { name: '离开这个工作区' }));
    const confirm = screen.getByRole('alert');
    expect(confirm).toHaveTextContent('确认离开「Team A」？离开后你打不开其中任何画布，要重新受邀才能回来。');
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/leave'))).toBe(false);
    fireEvent.click(within(confirm).getByRole('button', { name: '确认离开' }));
    await waitFor(() => expect(left).toHaveBeenCalledWith('team-a'));
    expect(fetch.mock.calls.filter(([url, init]) => String(url).endsWith('/tenants/team-a/leave') && (init as RequestInit).method === 'POST')).toHaveLength(1);
    // Nothing of the workspace just left is read again (its members would answer not found).
    const leftAt = fetch.mock.calls.findIndex(([url]) => String(url).endsWith('/leave'));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(fetch.mock.calls.slice(leftAt + 1).filter(([url]) => String(url).includes('/tenants/team-a/'))).toEqual([]);
  });

  it('lets an open Leave go when the selected workspace changes', async () => {
    const fetch = serve('member');
    const api = createSaaSAccountApi(() => {});
    const { rerender } = render(element(api, vi.fn(), 'zh', 'team-a'));
    fireEvent.click(await screen.findByRole('button', { name: '离开这个工作区' }));
    expect(screen.getByRole('alert')).toHaveTextContent('确认离开「Team A」？');
    rerender(element(api, vi.fn(), 'zh', 'team-b'));
    expect(await screen.findByRole('button', { name: '离开这个工作区' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '确认离开' })).toBeNull();
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/leave'))).toBe(false);
  });

  it('keeps the workspace for a cancelled confirmation, and offers its owner no way out', async () => {
    const fetch = serve('member');
    panel();
    fireEvent.click(await screen.findByRole('button', { name: '离开这个工作区' }));
    fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: '取消' }));
    expect(screen.getByRole('button', { name: '离开这个工作区' })).toBeInTheDocument();
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/leave'))).toBe(false);
    cleanup();
    serve('owner', [{ userId: 'user-bea', name: 'Bea', email: 'bea@example.test', role: 'owner' }]);
    panel();
    expect(await screen.findByText('bea@example.test')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '离开这个工作区' })).toBeNull();
  });

  it('says it in English', async () => {
    serve('reader');
    panel(vi.fn(), 'en');
    fireEvent.click(await screen.findByRole('button', { name: 'Leave this workspace' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Leave “Team A”? You can no longer open any of its canvases, and you need a new invitation to come back.');
    expect(within(screen.getByRole('alert')).getByRole('button', { name: 'Leave the workspace' })).toBeInTheDocument();
  });
});

// A workspace's invitations are listed to its owners and admins only (GET …/invites, a suspended workspace's too): anyone
// else's panel asks for none, so no refused request is logged in the browser's console.
describe('the invitations a workspace has made', () => {
  const INVITE = { id: 'inv-1', role: 'member', status: 'active', expiresAt: '2026-11-12T10:00:00Z', email: 'cy@example.test', canvasId: null, canvasName: null };
  // `role` may change between reads: the account as the server has it then. While `down()` says so, reading the
  // account fails as a server that cannot answer does.
  function serveAs(role: string | (() => string), status = 'active', down: () => boolean = () => false) {
    const roleNow = () => typeof role === 'function' ? role() : role;
    const fetch = vi.fn(async (url: string, _init?: RequestInit) => {
      const path = new URL(url, 'http://localhost').pathname;
      if (path.endsWith('/auth/me') && down()) return json({ error: { code: 'service_unavailable', message: 'Service unavailable' } }, 503);
      if (path.endsWith('/auth/me')) return json({ ...me(roleNow()), tenants: me(roleNow()).tenants.map(item => ({ ...item, status })) });
      if (path.endsWith('/members')) return json({ items: NAMES, nextCursor: null });
      if (path.endsWith('/invites')) return json({ items: [INVITE], nextCursor: null });
      return json({ items: [] });
    });
    vi.stubGlobal('fetch', fetch);
    return fetch;
  }
  const reads = (fetch: ReturnType<typeof serveAs>, suffix: string) => fetch.mock.calls
    .filter(([url, init]) => new URL(String(url), 'http://localhost').pathname.endsWith(suffix) && ((init as RequestInit | undefined)?.method ?? 'GET') === 'GET')
    .map(([url]) => new URL(String(url), 'http://localhost').pathname);

  it('are never asked for by a member or a reader, whose panel still lists the people', async () => {
    for (const role of ['member', 'reader']) {
      const fetch = serveAs(role);
      panel();
      expect(await screen.findByText('Olive')).toBeInTheDocument();
      expect(reads(fetch, '/members')).toEqual(['/api/v1/tenants/team-a/members']);
      expect(reads(fetch, '/invites')).toEqual([]);
      expect(screen.queryByText('已创建的邀请')).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
      cleanup();
    }
  });

  it('answer a member as the server would, and leave a workspace this account does not hold to the server', async () => {
    const fetch = serveAs('member');
    const api = createSaaSAccountApi(() => {});
    await expect(api.listInvites('team-a')).rejects.toMatchObject({ status: 403 });
    expect(reads(fetch, '/invites')).toEqual([]);
    await expect(api.listInvites('team-gone')).resolves.toMatchObject({ invites: [INVITE] });
    expect(reads(fetch, '/invites')).toEqual(['/api/v1/tenants/team-gone/invites']);
  });

  it('read the account again before they are refused, so a person made an admin since gets them at once', async () => {
    let role = 'member';
    const fetch = serveAs(() => role);
    const api = createSaaSAccountApi(() => {});
    await expect(api.listMembers('team-a')).resolves.toMatchObject({ access: { canManageMembers: false } });
    await expect(api.listInvites('team-a')).rejects.toMatchObject({ status: 403 });
    role = 'admin';
    await expect(api.listInvites('team-a')).resolves.toMatchObject({ invites: [INVITE] });
    expect(reads(fetch, '/invites')).toEqual(['/api/v1/tenants/team-a/invites']);
    // The members list read after it goes by the account read again.
    await expect(api.listMembers('team-a')).resolves.toMatchObject({ access: { canManageMembers: true } });
    // An admin's next read asks the server straight away.
    const accountReads = reads(fetch, '/auth/me').length;
    await api.listInvites('team-a');
    expect(reads(fetch, '/auth/me')).toHaveLength(accountReads);
  });

  // The members list's own 刷新列表: the panel reads the members and the invitations again, side by side.
  const refresh = () => fireEvent.click(within(screen.getByRole('navigation', { name: '成员分页' })).getByRole('button', { name: '刷新列表' }));

  it('are listed at once for a person made an admin since, though the panel reads the members beside them', async () => {
    let role = 'member';
    const fetch = serveAs(() => role);
    panel();
    expect(await screen.findByText('Olive')).toBeInTheDocument();
    // The page's own read of the account, and the one read again before a member was refused.
    expect(reads(fetch, '/auth/me')).toHaveLength(2);
    expect(reads(fetch, '/invites')).toEqual([]);
    role = 'admin';
    refresh();
    // The invitations' side finds the account changed and lists them, with one more read of the account and one of
    // the invitations, while the members are read once beside it.
    expect(await screen.findByText('已创建的邀请')).toBeInTheDocument();
    expect(reads(fetch, '/auth/me')).toHaveLength(3);
    expect(reads(fetch, '/invites')).toEqual(['/api/v1/tenants/team-a/invites']);
    expect(reads(fetch, '/members')).toHaveLength(2);
    expect(screen.queryByRole('alert')).toBeNull();
    // The members read beside them went by the account the page held. The next load goes by the account read again:
    // an admin's controls, the invitation's 撤销邀请 among them, and no further read of the account.
    refresh();
    expect(await screen.findByRole('button', { name: '撤销邀请' })).toBeInTheDocument();
    expect(reads(fetch, '/auth/me')).toHaveLength(3);
    expect(reads(fetch, '/invites')).toHaveLength(2);
  });

  it('pass on a failed read of the account, ask for none, and read it again the next time', async () => {
    let role = 'member';
    let down = false;
    const fetch = serveAs(() => role, 'active', () => down);
    const api = createSaaSAccountApi(() => {});
    await expect(api.listMembers('team-a')).resolves.toMatchObject({ access: { canManageMembers: false } });
    // The account read again before a refusal fails: that failure is what the caller gets, not a refusal or an empty
    // list, and no invitation is asked for.
    role = 'admin';
    down = true;
    await expect(api.listInvites('team-a')).rejects.toMatchObject({ status: 503 });
    expect(reads(fetch, '/invites')).toEqual([]);
    // The failed read is not kept: the next call reads the account again, and lists them for the admin it finds.
    down = false;
    const accountReads = reads(fetch, '/auth/me').length;
    await expect(api.listInvites('team-a')).resolves.toMatchObject({ invites: [INVITE] });
    expect(reads(fetch, '/auth/me')).toHaveLength(accountReads + 1);
    expect(reads(fetch, '/invites')).toEqual(['/api/v1/tenants/team-a/invites']);
    // The members list read after it goes by that account too.
    await expect(api.listMembers('team-a')).resolves.toMatchObject({ access: { canManageMembers: true } });
    expect(reads(fetch, '/auth/me')).toHaveLength(accountReads + 1);
  });

  it('say so in the panel when the account cannot be read again, and a refresh lists them', async () => {
    let role = 'member';
    let down = false;
    const fetch = serveAs(() => role, 'active', () => down);
    panel();
    expect(await screen.findByText('Olive')).toBeInTheDocument();
    role = 'admin';
    down = true;
    refresh();
    // The people are listed still, and the panel says the read failed instead of showing no invitations.
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('Olive')).toBeInTheDocument();
    expect(screen.queryByText('已创建的邀请')).toBeNull();
    expect(reads(fetch, '/invites')).toEqual([]);
    down = false;
    refresh();
    expect(await screen.findByText('已创建的邀请')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(reads(fetch, '/invites')).toEqual(['/api/v1/tenants/team-a/invites']);
  });

  it('are read and listed for an owner and an admin, a suspended workspace’s too, in either language', async () => {
    for (const [role, status, locale] of [['owner', 'active', 'zh'], ['admin', 'active', 'en'], ['owner', 'suspended', 'zh']] as const) {
      const fetch = serveAs(role, status);
      panel(vi.fn(), locale);
      expect(await screen.findByText(locale === 'zh' ? '已创建的邀请' : 'Created invitations')).toBeInTheDocument();
      expect(reads(fetch, '/invites')).toEqual(['/api/v1/tenants/team-a/invites']);
      cleanup();
    }
  });
});
