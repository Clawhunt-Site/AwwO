import type {
  AccountApi,
  AccountCompany,
  AccountHealth,
  AccountProfile,
  AccountSession,
  CompanyInviteCreated,
  CompanyInviteListResponse,
  CompanyMember,
  CompanyMembersResponse,
  CompanyUserDirectoryResponse,
  CurrentWorkspaceAccess,
  HumanCompanyRole,
} from './types';

export class AccountApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'AccountApiError';
    this.status = status;
  }
}

type AccountApiOptions = {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
};

function cleanBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  return trimmed || '/paperclip-api';
}

function errorMessage(payload: unknown, status: number): string {
  if (payload && typeof payload === 'object') {
    const value = payload as { detail?: unknown; error?: unknown; message?: unknown };
    for (const candidate of [value.detail, value.error, value.message]) {
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    }
  }
  return `AwwO workspace request failed (${status})`;
}

export function createAccountApi(options: AccountApiOptions = {}): AccountApi {
  const baseUrl = cleanBaseUrl(options.baseUrl ?? '/paperclip-api');
  const fetchImpl = options.fetchImpl ?? fetch;

  async function request<T>(
    path: string,
    init: RequestInit = {},
    nullableOn401 = false,
  ): Promise<T | null> {
    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/json');
    if (typeof init.body === 'string' && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    const response = await fetchImpl(`${baseUrl}${path}`, {
      ...init,
      credentials: 'include',
      headers,
    });
    if (nullableOn401 && response.status === 401) return null;
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new AccountApiError(response.status, errorMessage(payload, response.status));
    return payload as T;
  }

  const companyPath = (companyId: string, suffix = '') =>
    `/companies/${encodeURIComponent(companyId)}${suffix}`;

  return {
    getHealth: async () => (await request<AccountHealth>('/health')) as AccountHealth,
    getSession: () => request<AccountSession>('/auth/get-session', {}, true),
    getCurrentAccess: () => request<CurrentWorkspaceAccess>('/cli-auth/me', {}, true),
    listCompanies: async () => (await request<AccountCompany[]>('/companies')) as AccountCompany[],
    getProfile: async () => (await request<AccountProfile>('/auth/profile')) as AccountProfile,
    updateProfile: async (input) =>
      (await request<AccountProfile>('/auth/profile', {
        method: 'PATCH',
        body: JSON.stringify(input),
      })) as AccountProfile,
    listMembers: async (companyId) =>
      (await request<CompanyMembersResponse>(companyPath(companyId, '/members'))) as CompanyMembersResponse,
    listUserDirectory: async (companyId) =>
      (await request<CompanyUserDirectoryResponse>(companyPath(companyId, '/user-directory'))) as CompanyUserDirectoryResponse,
    listInvites: async (companyId) =>
      (await request<CompanyInviteListResponse>(companyPath(companyId, '/invites?state=active&limit=1'))) as CompanyInviteListResponse,
    createHumanInvite: async (companyId: string, role: HumanCompanyRole) =>
      (await request<CompanyInviteCreated>(companyPath(companyId, '/invites'), {
        method: 'POST',
        body: JSON.stringify({ allowedJoinTypes: 'human', humanRole: role }),
      })) as CompanyInviteCreated,
    updateMember: async (companyId, memberId, input) =>
      (await request<CompanyMember>(
        companyPath(companyId, `/members/${encodeURIComponent(memberId)}`),
        { method: 'PATCH', body: JSON.stringify(input) },
      )) as CompanyMember,
  };
}

export const accountApi = createAccountApi();
