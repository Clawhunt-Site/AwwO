import { AccountApiError } from '../account/accountApi';
import type { AccountApi, AccountProfile, CompanyMember, HumanCompanyRole, WorkspaceInviteSummary } from '../account/types';
import { api, SaaSApiError, saasErrorMessage, tenantPath, type Identity, type Tenant } from './api';
import { readInitialLocale } from '../locale';

type Member = { userId: string; name: string; email: string; role: HumanCompanyRole };
const profile = (user: { id: string; email: string; name: string }): AccountProfile => ({ ...user, image: null });
const canManage = (tenant?: Tenant) => tenant?.status === 'active' && ['owner', 'admin'].includes(tenant.role);
const roles = (tenant?: Tenant): HumanCompanyRole[] => canManage(tenant) ? tenant?.role === 'owner' ? ['reader', 'member', 'admin'] : ['reader', 'member'] : [];

/** Translate the existing account panel's data contract at its HTTP boundary. No external identity is used. */
export function createSaaSAccountApi(onProfile: (name: string) => void): AccountApi {
  let identityRequest: Promise<Identity> | undefined;
  const identity = () => identityRequest ||= api<Identity>('/auth/me').catch(error => { identityRequest = undefined; throw error; });
  const request = async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
    try { return await api<T>(path, init); }
    catch (error) { if (error instanceof SaaSApiError) throw new AccountApiError(error.status, saasErrorMessage(error, readInitialLocale())); throw error; }
  };
  const tenant = async (id: string) => (await identity()).tenants.find(item => item.id === id);
  const member = (item: Member, tenantId: string, actor?: Tenant): CompanyMember => {
    const editable = Boolean(canManage(actor) && item.role !== 'owner' && (actor?.role === 'owner' || item.role !== 'admin'));
    return { id: item.userId, companyId: tenantId, principalType: 'user', principalId: item.userId,
      status: 'active', membershipRole: item.role, user: profile({ id: item.userId, name: item.name, email: item.email }), grants: [], editable,
      removal: { canArchive: editable, reason: item.role === 'owner' ? 'protected_owner' : null } };
  };
  const listMembers: AccountApi['listMembers'] = async id => {
    const actor = await tenant(id);
    const result = await request<{ items: Member[] }>(tenantPath(id, '/members'));
    return { members: result.items.map(item => member(item, id, actor)), access: {
      currentUserRole: actor?.role as HumanCompanyRole || null, canManageMembers: Boolean(canManage(actor)),
      canInviteUsers: Boolean(canManage(actor)), canApproveJoinRequests: false, assignableRoles: roles(actor), canChangeStatus: false,
    } };
  };
  return {
    getHealth: async () => { await identity(); return { status: 'ok', deploymentMode: 'authenticated', authReady: true }; },
    getSession: async () => { const me = await identity(); return { session: { id: '', userId: me.user.id }, user: profile(me.user) }; },
    getCurrentAccess: async () => { const me = await identity(); return { user: profile(me.user), userId: me.user.id,
      isInstanceAdmin: me.user.platformRole === 'admin', companyIds: me.tenants.map(item => item.id), source: 'saas_cookie', keyId: null }; },
    listCompanies: async () => (await identity()).tenants.map(({ id, name, status }) => ({ id, name, status })),
    getProfile: async () => profile((await identity()).user),
    updateProfile: async ({ name }) => {
      const user = await request<{ id: string; email: string; name: string }>('/auth/profile', { method: 'PATCH', body: JSON.stringify({ name }) });
      identityRequest = undefined; onProfile(user.name); return profile(user);
    },
    listMembers,
    listUserDirectory: async id => ({ users: (await listMembers(id)).members.map(item => ({ principalId: item.principalId, status: 'active' as const, user: item.user })) }),
    listInvites: async id => ({ invites: (await request<{ items: WorkspaceInviteSummary[] }>(tenantPath(id, '/invites'))).items, nextOffset: null }),
    createHumanInvite: async (id, role) => {
      const invite = await request<{ id: string; role: HumanCompanyRole; token: string; inviteUrl: string; expiresAt: string }>(tenantPath(id, '/invites'), { method: 'POST', body: JSON.stringify({ role }) });
      return { ...invite, allowedJoinTypes: 'human', humanRole: invite.role };
    },
    revokeInvite: async (id, inviteId) => { await request(tenantPath(id, `/invites/${encodeURIComponent(inviteId)}`), { method: 'DELETE' }); },
    addMember: async (id, input) => { await request(tenantPath(id, '/members'), { method: 'POST', body: JSON.stringify(input) }); },
    removeMember: async (id, userId) => { await request(tenantPath(id, `/members/${encodeURIComponent(userId)}`), { method: 'DELETE' }); },
    updateMember: async (id, userId, input) => {
      if (!input.membershipRole || input.status !== undefined) throw new AccountApiError(400, 'Unsupported member update');
      await request(tenantPath(id, `/members/${encodeURIComponent(userId)}`), { method: 'PATCH', body: JSON.stringify({ role: input.membershipRole }) });
      const result = (await listMembers(id)).members.find(item => item.principalId === userId);
      if (!result) throw new AccountApiError(404, 'Member no longer exists');
      return result;
    },
  };
}
