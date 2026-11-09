// Accepting a workspace invitation (saas/InviteAcceptance.tsx; invitations.go): the canvas it was sent from opens once the
// person has joined, an invitation bound to another email says whose it is and is not offered to this account, and the
// server's refusal of a wrong account is said in both languages. Every id, email and token here is made up.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InviteAcceptance, joinedURL } from '../src/saas/InviteAcceptance';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
import type { Identity } from '../src/saas/api';

const identity: Identity = { user: { id: 'user-bea', name: 'Bea', email: 'bea@example.test', platformRole: 'user' }, tenants: [] };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const preview = (over: Record<string, unknown> = {}) => ({ tenantId: 'tenant-team', tenantName: 'Team', role: 'member', status: 'active', expiresAt: '2099-01-01T00:00:00Z', ...over });

function serve(previewed: Record<string, unknown>, accept: () => Response) {
  const fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url.endsWith('/accept') && init.method === 'POST') return accept();
    if (url.includes('/invites/')) return json(previewed);
    return json({ error: { code: 'not_found', message: 'Not found' } }, 404);
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
const show = (navigate = vi.fn()) => {
  render(<SaaSPreferencesProvider><InviteAcceptance token="made-up-invitation-token" identity={identity} controls={null} navigate={navigate} /></SaaSPreferencesProvider>);
  return navigate;
};

beforeEach(() => { localStorage.clear(); localStorage.setItem('superclaw_locale', 'zh'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('accepting an invitation', () => {
  it('opens the canvas it was sent from once joined', async () => {
    const fetch = serve(preview({ canvasId: 'canvas-plan', canvasName: 'Launch plan' }), () => json({ tenantId: 'tenant-team', role: 'member', canvasId: 'canvas-plan' }));
    const navigate = show();
    expect(await screen.findByText('邀请你打开画布「Launch plan」。')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '加入并打开画布' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/?tenant=tenant-team&canvas=canvas-plan'));
    expect(await screen.findByRole('link', { name: '打开画布' })).toHaveAttribute('href', '/?tenant=tenant-team&canvas=canvas-plan');
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/accept'))).toHaveLength(1);
  });

  it('opens the workspace when the canvas is gone, as an invitation from no canvas does', async () => {
    serve(preview(), () => json({ tenantId: 'tenant-team', role: 'reader' }));
    const navigate = show();
    fireEvent.click(await screen.findByRole('button', { name: '确认加入' }));
    expect(await screen.findByRole('link', { name: '打开工作区' })).toHaveAttribute('href', '/?tenant=tenant-team');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('names the email an invitation is for, and offers one bound to another email to no other account', async () => {
    const fetch = serve(preview({ email: 'c***@example.test', emailMatches: false }), () => json({}));
    show();
    expect(await screen.findByRole('alert')).toHaveTextContent('这个邀请是发给 c***@example.test 的，不是当前账号：请用那个邮箱的账号登录后再打开这个链接。');
    expect(screen.getByRole('button', { name: '确认加入' })).toBeDisabled();
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/accept'))).toBe(false);
    cleanup();
    serve(preview({ email: 'b***@example.test', emailMatches: true }), () => json({ tenantId: 'tenant-team', role: 'member' }));
    show();
    expect(await screen.findByText('这个邀请是发给你的邮箱（b***@example.test）的。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '确认加入' })).toBeEnabled();
  });

  it('says the server refused another account, and keeps the invitation to try again', async () => {
    serve(preview({ email: 'b***@example.test', emailMatches: true }), () => json({ error: { code: 'invite_wrong_account', message: 'This invitation is for another account' } }, 403));
    show();
    fireEvent.click(await screen.findByRole('button', { name: '确认加入' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('这个邀请是发给另一个邮箱的：请用收到邀请的那个邮箱的账号登录，再打开链接。');
    expect(screen.queryByRole('heading', { name: '已加入工作区' })).toBeNull();
    expect(screen.getByRole('button', { name: '重新读取邀请' })).toBeInTheDocument();
  });

  it('offers an invitation already taken to confirm again, as the server lets the account that took it', async () => {
    serve(preview({ status: 'accepted', email: 'c***@example.test', emailMatches: false }), () => json({ tenantId: 'tenant-team', role: 'member' }));
    show();
    expect(await screen.findByText('这个邀请是发给 c***@example.test 的。')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: '确认加入' })).toBeEnabled();
  });

  it('renders in English', async () => {
    localStorage.setItem('superclaw_locale', 'en');
    // The server names the canvas only to the account the invitation is for (invitations.go previewInvite).
    serve(preview({ email: 'c***@example.test', emailMatches: false }), () => json({}));
    show();
    expect(await screen.findByRole('alert')).toHaveTextContent('This invitation was sent to c***@example.test, not to this account');
    expect(screen.getByRole('button', { name: 'Confirm membership' })).toBeDisabled();
    cleanup();
    serve(preview({ canvasId: 'canvas-plan', canvasName: 'Launch plan', email: 'b***@example.test', emailMatches: true }), () => json({}));
    show();
    expect(await screen.findByText('You are invited to the canvas “Launch plan”.')).toBeInTheDocument();
    expect(screen.getByText('This invitation was sent to your email (b***@example.test).')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Join and open the canvas' })).toBeEnabled();
  });

  it('builds the address it opens from the ids alone', () => {
    expect(joinedURL({ tenantId: 'a b', role: 'member', canvasId: 'c&d' })).toBe('/?tenant=a%20b&canvas=c%26d');
    expect(joinedURL({ tenantId: 'a', role: 'member' })).toBe('/?tenant=a');
  });
});
