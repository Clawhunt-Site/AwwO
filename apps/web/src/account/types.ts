export type AccountLocale = 'en' | 'zh';

export type WorkspaceDeploymentMode = 'local_trusted' | 'authenticated';
export type HumanCompanyRole = 'owner' | 'admin' | 'operator' | 'viewer' | 'member' | 'reader';
export type CompanyMembershipStatus = 'pending' | 'active' | 'suspended' | 'archived';

export type ClawHuntIdentity = {
  id: number | string;
  username: string;
  email?: string;
  avatar_url?: string;
  access_status?: string;
  tier?: string;
  superclaw_plan?: string;
};

export type AccountProfile = {
  id: string;
  email: string | null;
  name: string | null;
  image: string | null;
};

export type AccountSession = {
  session: { id: string; userId: string };
  user: AccountProfile;
};

export type AccountHealth = {
  status: 'ok';
  deploymentMode?: WorkspaceDeploymentMode;
  deploymentExposure?: 'private' | 'public';
  authReady?: boolean;
};

export type AccountCompany = {
  id: string;
  name: string;
  status: string;
};

export type CurrentWorkspaceAccess = {
  user: AccountProfile | null;
  userId: string;
  isInstanceAdmin: boolean;
  companyIds: string[];
  memberships?: Array<{
    companyId: string;
    membershipRole: HumanCompanyRole | 'member' | null;
    status: CompanyMembershipStatus;
  }>;
  source: string;
  keyId: string | null;
};

export type CompanyMemberGrant = {
  id: string;
  companyId: string;
  principalType: 'user';
  principalId: string;
  permissionKey: string;
  scope: Record<string, unknown> | null;
  grantedByUserId: string | null;
};

export type CompanyMember = {
  id: string;
  companyId: string;
  principalType: 'user';
  principalId: string;
  status: CompanyMembershipStatus;
  membershipRole: HumanCompanyRole | null;
  user: AccountProfile | null;
  grants: CompanyMemberGrant[];
  removal?: { canArchive: boolean; reason: string | null };
  editable?: boolean;
};

export type CompanyMembersResponse = {
  members: CompanyMember[];
  access: {
    currentUserRole: HumanCompanyRole | null;
    canManageMembers: boolean;
    canInviteUsers: boolean;
    canApproveJoinRequests: boolean;
    assignableRoles?: HumanCompanyRole[];
    canChangeStatus?: boolean;
  };
};

export type CompanyUserDirectoryResponse = {
  users: Array<{
    principalId: string;
    status: 'active';
    user: AccountProfile | null;
  }>;
};

export type CompanyInviteListResponse = {
  invites: unknown[];
  nextOffset: number | null;
};

export type WorkspaceInviteSummary = { id: string; role: HumanCompanyRole; expiresAt: string; status: string };

export type CompanyInviteCreated = {
  id: string;
  token: string;
  inviteUrl: string;
  expiresAt: string;
  allowedJoinTypes: 'human' | 'agent' | 'both';
  humanRole?: HumanCompanyRole | null;
};

export interface AccountApi {
  getHealth(): Promise<AccountHealth>;
  getSession(): Promise<AccountSession | null>;
  getCurrentAccess(): Promise<CurrentWorkspaceAccess | null>;
  listCompanies(): Promise<AccountCompany[]>;
  getProfile(): Promise<AccountProfile>;
  updateProfile(input: { name: string; image?: string | null }): Promise<AccountProfile>;
  listMembers(companyId: string): Promise<CompanyMembersResponse>;
  listUserDirectory(companyId: string): Promise<CompanyUserDirectoryResponse>;
  listInvites(companyId: string): Promise<CompanyInviteListResponse>;
  createHumanInvite(companyId: string, role: HumanCompanyRole): Promise<CompanyInviteCreated>;
  updateMember(
    companyId: string,
    memberId: string,
    input: { membershipRole?: HumanCompanyRole; status?: Exclude<CompanyMembershipStatus, 'archived'> },
  ): Promise<CompanyMember>;
  addMember?(companyId: string, input: { email: string; role: HumanCompanyRole }): Promise<void>;
  removeMember?(companyId: string, userId: string): Promise<void>;
  revokeInvite?(companyId: string, inviteId: string): Promise<void>;
}
