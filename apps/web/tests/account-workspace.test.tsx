import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountWorkspacePanel } from '../src/account/AccountWorkspacePanel';
import { AccountApiError, createAccountApi } from '../src/account/accountApi';
import type {
  AccountApi,
  AccountCompany,
  AccountSession,
  CompanyMembersResponse,
  CurrentWorkspaceAccess,
} from '../src/account/types';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const COMPANIES: AccountCompany[] = [
  { id: 'company-a', name: 'AwwO Studio', status: 'active' },
  { id: 'company-b', name: 'Second Space', status: 'active' },
];

const SESSION: AccountSession = {
  session: { id: 'session-1', userId: 'user-1' },
  user: { id: 'user-1', name: 'Ada', email: 'ada@example.com', image: null },
};

const ACCESS: CurrentWorkspaceAccess = {
  user: SESSION.user,
  userId: 'user-1',
  isInstanceAdmin: false,
  companyIds: ['company-a', 'company-b'],
  memberships: [
    { companyId: 'company-a', membershipRole: 'owner', status: 'active' },
    { companyId: 'company-b', membershipRole: 'viewer', status: 'active' },
  ],
  source: 'session',
  keyId: null,
};

const MEMBERS: CompanyMembersResponse = {
  members: [
    {
      id: 'membership-1',
      companyId: 'company-a',
      principalType: 'user',
      principalId: 'user-1',
      status: 'active',
      membershipRole: 'owner',
      user: SESSION.user,
      grants: [],
      removal: { canArchive: false, reason: 'Cannot remove the last active owner' },
    },
    {
      id: 'membership-2',
      companyId: 'company-a',
      principalType: 'user',
      principalId: 'user-2',
      status: 'active',
      membershipRole: 'operator',
      user: { id: 'user-2', name: 'Lin', email: 'lin@example.com', image: null },
      grants: [],
      removal: { canArchive: true, reason: null },
    },
  ],
  access: {
    currentUserRole: 'owner',
    canManageMembers: true,
    canInviteUsers: true,
    canApproveJoinRequests: true,
  },
};

function fakeApi(overrides: Partial<AccountApi> = {}): AccountApi {
  return {
    getHealth: async () => ({ status: 'ok', deploymentMode: 'authenticated' }),
    getSession: async () => SESSION,
    getCurrentAccess: async () => ACCESS,
    listCompanies: async () => COMPANIES,
    getProfile: async () => SESSION.user,
    updateProfile: async (input) => ({ ...SESSION.user, ...input }),
    listMembers: async () => MEMBERS,
    listUserDirectory: async () => ({ users: [] }),
    listInvites: async () => ({ invites: [], nextOffset: null }),
    createHumanInvite: async () => ({
      id: 'invite-1',
      token: 'token-1',
      inviteUrl: 'http://127.0.0.1:3100/invite/token-1',
      expiresAt: '2026-09-08T00:00:00.000Z',
      allowedJoinTypes: 'human',
      humanRole: 'operator',
    }),
    updateMember: async (_companyId, _memberId, input) => ({ ...MEMBERS.members[1], ...input }),
    ...overrides,
  };
}

describe('createAccountApi', () => {
  it('uses the same-origin Node proxy with cookies and never turns ClawHunt identity into Node authorization', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ...SESSION.user, name: 'Ada Lovelace' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const api = createAccountApi({ fetchImpl, baseUrl: '/paperclip-api' });

    await api.updateProfile({ name: 'Ada Lovelace', image: null });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('/paperclip-api/auth/profile');
    expect(init).toMatchObject({
      method: 'PATCH',
      credentials: 'include',
      body: JSON.stringify({ name: 'Ada Lovelace', image: null }),
    });
    const headers = new Headers(init?.headers);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.has('authorization')).toBe(false);
  });

  it('represents a missing workspace session as null while preserving other auth failures', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(new Response('{}', { status: 503 }));
    const api = createAccountApi({ fetchImpl, baseUrl: '/paperclip-api' });

    await expect(api.getSession()).resolves.toBeNull();
    await expect(api.getSession()).rejects.toMatchObject({ name: 'AccountApiError', status: 503 });
  });
});

describe('AccountWorkspacePanel', () => {
  it('keeps the external ClawHunt identity separate from the local trusted workspace administrator', async () => {
    const onCompanyChange = vi.fn();
    const onOpenTeam = vi.fn();
    render(
      <AccountWorkspacePanel
        locale="en"
        api={fakeApi({
          getHealth: async () => ({ status: 'ok', deploymentMode: 'local_trusted' }),
          getSession: async () => null,
          getCurrentAccess: async () => ({
            user: null,
            userId: 'local-board',
            isInstanceAdmin: true,
            companyIds: ['company-a', 'company-b'],
            memberships: [],
            source: 'local_implicit',
            keyId: null,
          }),
        })}
        clawHuntIdentity={{ id: 7, username: 'leon', email: 'leon@example.com' }}
        selectedCompanyId="company-a"
        onCompanyChange={onCompanyChange}
        onClawHuntLogin={vi.fn()}
        onClawHuntLogout={vi.fn()}
        onOpenTeam={onOpenTeam}
      />,
    );

    expect(await screen.findByText('Signed in to ClawHunt as leon')).toBeInTheDocument();
    expect(screen.getByText('Local device administrator')).toBeInTheDocument();
    expect(screen.getByText(/does not create a shared AwwO user session/i)).toBeInTheDocument();
    expect(await screen.findByText('Lin')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('combobox', { name: 'Current workspace' }), {
      target: { value: 'company-b' },
    });
    expect(onCompanyChange).toHaveBeenCalledWith('company-b');

    fireEvent.click(screen.getByRole('button', { name: 'Open team workspace' }));
    expect(onOpenTeam).toHaveBeenCalledWith('company-a');
  });

  it('does not treat a verified ClawHunt account as an authenticated AwwO workspace session', async () => {
    const onOpenWorkspaceAuth = vi.fn();
    const api = fakeApi({
      getHealth: async () => ({ status: 'ok', deploymentMode: 'authenticated' }),
      getSession: async () => null,
      getCurrentAccess: async () => null,
      listCompanies: async () => [],
    });
    render(
      <AccountWorkspacePanel
        locale="en"
        api={api}
        clawHuntIdentity={{ id: 'ch-1', username: 'remote-user' }}
        selectedCompanyId={null}
        onCompanyChange={vi.fn()}
        onClawHuntLogin={vi.fn()}
        onClawHuntLogout={vi.fn()}
        onOpenWorkspaceAuth={onOpenWorkspaceAuth}
      />,
    );

    expect(await screen.findByText('No AwwO workspace session')).toBeInTheDocument();
    expect(screen.getByText(/ClawHunt sign-in does not grant access to this workspace/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open AwwO sign-in' }));
    expect(onOpenWorkspaceAuth).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: /invite/i })).not.toBeInTheDocument();
  });

  it('falls back to the authorized user directory and disables management when the server refuses member permissions', async () => {
    const updateMember = vi.fn();
    render(
      <AccountWorkspacePanel
        locale="en"
        api={fakeApi({
          listMembers: async () => {
            throw new AccountApiError(403, 'Permission denied');
          },
          listUserDirectory: async () => ({
            users: [
              {
                principalId: 'user-2',
                status: 'active',
                user: { id: 'user-2', name: 'Lin', email: 'lin@example.com', image: null },
              },
            ],
          }),
          listInvites: async () => {
            throw new AccountApiError(403, 'Permission denied');
          },
          updateMember,
        })}
        clawHuntIdentity={null}
        selectedCompanyId="company-a"
        onCompanyChange={vi.fn()}
        onClawHuntLogin={vi.fn()}
        onClawHuntLogout={vi.fn()}
      />,
    );

    expect(await screen.findByText('Lin')).toBeInTheDocument();
    expect(screen.getByText('Member roles are visible to workspace managers.')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Role for Lin' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create invite link' })).toBeDisabled();
    expect(updateMember).not.toHaveBeenCalled();
  });

  it('edits the real workspace profile and applies member role changes through the API', async () => {
    const updateProfile = vi.fn(async (input) => ({ ...SESSION.user, ...input }));
    const updateMember = vi.fn(async (_companyId, _memberId, input) => ({ ...MEMBERS.members[1], ...input }));
    render(
      <AccountWorkspacePanel
        locale="en"
        api={fakeApi({ updateProfile, updateMember })}
        clawHuntIdentity={null}
        selectedCompanyId="company-a"
        onCompanyChange={vi.fn()}
        onClawHuntLogin={vi.fn()}
        onClawHuntLogout={vi.fn()}
      />,
    );

    await screen.findByDisplayValue('Ada');
    fireEvent.change(screen.getByRole('textbox', { name: 'Display name' }), {
      target: { value: 'Ada Lovelace' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    await waitFor(() => expect(updateProfile).toHaveBeenCalledWith({ name: 'Ada Lovelace', image: null }));
    expect(await screen.findByDisplayValue('Ada Lovelace')).toBeInTheDocument();

    fireEvent.change(await screen.findByRole('combobox', { name: 'Role for Lin' }), {
      target: { value: 'admin' },
    });
    await waitFor(() => expect(updateMember).toHaveBeenCalledWith('company-a', 'membership-2', {
      membershipRole: 'admin',
    }));
  });

  it.each([
    { locale: 'en' as const, label: 'Role for Lin', placeholder: 'Unassigned' },
    { locale: 'zh' as const, label: 'Lin 的角色', placeholder: '未设置' },
  ])('shows an unassigned member role in $locale until a real role is selected', async ({ locale, label, placeholder }) => {
    const member = { ...MEMBERS.members[1], membershipRole: null };
    const updateMember = vi.fn(async (_companyId, _memberId, input) => ({ ...member, ...input }));
    render(
      <AccountWorkspacePanel
        locale={locale}
        api={fakeApi({
          listMembers: async () => ({ ...MEMBERS, members: [member] }),
          updateMember,
        })}
        clawHuntIdentity={null}
        selectedCompanyId="company-a"
        onCompanyChange={vi.fn()}
        onClawHuntLogin={vi.fn()}
        onClawHuntLogout={vi.fn()}
      />,
    );

    const roles = await screen.findByRole('combobox', { name: label });
    expect(roles).toHaveValue('');
    expect(within(roles).getByRole('option', { name: placeholder })).toBeDisabled();
    expect(updateMember).not.toHaveBeenCalled();

    fireEvent.change(roles, { target: { value: 'operator' } });
    await waitFor(() => expect(updateMember).toHaveBeenCalledExactlyOnceWith('company-a', 'membership-2', {
      membershipRole: 'operator',
    }));
    await waitFor(() => expect(roles).toHaveValue('operator'));
    expect(within(roles).queryByRole('option', { name: placeholder })).not.toBeInTheDocument();
  });

  it('creates a human invite with the selected role and exposes the server-issued link for copying', async () => {
    const createHumanInvite = vi.fn(async () => ({
      id: 'invite-1',
      token: 'token-1',
      inviteUrl: 'http://127.0.0.1:3100/invite/token-1',
      expiresAt: '2026-09-08T00:00:00.000Z',
      allowedJoinTypes: 'human' as const,
      humanRole: 'viewer' as const,
    }));
    render(
      <AccountWorkspacePanel
        locale="en"
        api={fakeApi({ createHumanInvite })}
        clawHuntIdentity={null}
        selectedCompanyId="company-a"
        onCompanyChange={vi.fn()}
        onClawHuntLogin={vi.fn()}
        onClawHuntLogout={vi.fn()}
      />,
    );

    await screen.findByRole('button', { name: 'Create invite link' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Invite role' }), {
      target: { value: 'viewer' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create invite link' }));

    await waitFor(() => expect(createHumanInvite).toHaveBeenCalledWith('company-a', 'viewer'));
    expect(await screen.findByText('http://127.0.0.1:3100/invite/token-1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy invite link' })).toBeInTheDocument();
  });

  it('renders the account workflow in Chinese from the locale prop', async () => {
    render(
      <AccountWorkspacePanel
        locale="zh"
        api={fakeApi()}
        clawHuntIdentity={null}
        selectedCompanyId="company-a"
        onCompanyChange={vi.fn()}
        onClawHuntLogin={vi.fn()}
        onClawHuntLogout={vi.fn()}
      />,
    );

    expect(await screen.findByRole('heading', { name: '账户与成员' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: '当前工作区' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: '创建邀请链接' })).toBeInTheDocument();
  });
});
