// 设置 → 成员与工作区 for a person invited into a workspace (account/AccountWorkspacePanel.tsx with the hosted app's account
// API, saas/accountApi.ts): the members list gives them names, never ids where emails are left out (tenant_pagination.go
// shows emails to owners and admins only), and they can leave the workspace, which its owner cannot (resources.go
// leaveTenant). Every id, name and email here is made up.
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
