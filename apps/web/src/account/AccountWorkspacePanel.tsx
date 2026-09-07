import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Check, Copy, ExternalLink, RefreshCw, ShieldCheck, UserPlus, Users } from 'lucide-react';
import { accountApi, AccountApiError } from './accountApi';
import type {
  AccountApi,
  AccountCompany,
  AccountHealth,
  AccountLocale,
  AccountProfile,
  AccountSession,
  ClawHuntIdentity,
  CompanyInviteCreated,
  CompanyMember,
  CompanyMembersResponse,
  CompanyMembershipStatus,
  CompanyUserDirectoryResponse,
  CurrentWorkspaceAccess,
  HumanCompanyRole,
  WorkspaceInviteSummary,
} from './types';
import './account.css';

export interface AccountWorkspacePanelProps {
  locale: AccountLocale;
  clawHuntIdentity: ClawHuntIdentity | null;
  selectedCompanyId: string | null;
  onCompanyChange: (companyId: string) => void;
  onClawHuntLogin: () => void | Promise<void>;
  onClawHuntLogout: () => void | Promise<void>;
  /** Opens the existing Node sign-in or invite surface. It must not forward the
   * ClawHunt bearer token; the Node service owns its own cookie session. */
  onOpenWorkspaceAuth?: () => void;
  /** Opens the existing company/team surface for the selected management scope. */
  onOpenTeam?: (companyId: string) => void;
  /** Injectable only at the HTTP boundary so the panel can be tested without a live service. */
  api?: AccountApi;
  /** SaaS uses its own cookie identity and never exposes an external-account login. */
  workspaceOnly?: boolean;
}

type Copy = ReturnType<typeof accountCopy>;

type BootstrapState = {
  health: AccountHealth;
  session: AccountSession | null;
  access: CurrentWorkspaceAccess | null;
  companies: AccountCompany[];
  profile: AccountProfile | null;
};

type TeamState = {
  members: CompanyMembersResponse | null;
  directory: CompanyUserDirectoryResponse | null;
  canInvite: boolean;
  loading: boolean;
  restricted: boolean;
  error: string | null;
  invites: WorkspaceInviteSummary[];
};

const EMPTY_TEAM: TeamState = {
  members: null,
  directory: null,
  canInvite: false,
  loading: false,
  restricted: false,
  error: null,
  invites: [],
};

const HUMAN_ROLES: HumanCompanyRole[] = ['owner', 'admin', 'operator', 'viewer'];
const EDITABLE_STATUSES: Array<Exclude<CompanyMembershipStatus, 'archived'>> = [
  'active',
  'suspended',
  'pending',
];

function accountCopy(locale: AccountLocale) {
  const en = {
    title: 'Accounts and members',
    subtitle: 'External identity and workspace access stay separate and auditable.',
    externalAccount: 'ClawHunt account',
    externalConnected: (name: string) => `Signed in to ClawHunt as ${name}`,
    externalDisconnected: 'ClawHunt is not connected',
    connect: 'Connect ClawHunt',
    disconnect: 'Disconnect',
    externalPurpose: 'Used for ClawHunt services and plan identity.',
    workspaceAccount: 'AwwO workspace session',
    localAdmin: 'Local device administrator',
    localBadge: 'Local trusted',
    localExplanation: 'This single-operator mode does not create a shared AwwO user session.',
    signedIn: 'Authenticated workspace',
    signedInAs: (name: string) => `Workspace session for ${name}`,
    noSession: 'No AwwO workspace session',
    noSessionExplanation: 'ClawHunt sign-in does not grant access to this workspace.',
    openSignIn: 'Open AwwO sign-in',
    unavailableSignIn: 'Open the existing AwwO sign-in or an invite link to continue.',
    loading: 'Loading account access…',
    retry: 'Retry',
    profile: 'Workspace profile',
    displayName: 'Display name',
    email: 'Email',
    saveProfile: 'Save profile',
    saved: 'Saved',
    workspaces: 'Workspaces',
    currentWorkspace: 'Current workspace',
    workspaceScope: 'This selection changes the member view only. Canvas nodes keep their own workspace binding.',
    openTeam: 'Open team workspace',
    noWorkspaces: 'No accessible workspaces were returned by the server.',
    members: 'Members',
    membersLoading: 'Loading members…',
    noMembers: 'No members are visible in this workspace.',
    restrictedRoles: 'Member roles are visible to workspace managers.',
    roleFor: (name: string) => `Role for ${name}`,
    statusFor: (name: string) => `Status for ${name}`,
    role: 'Role',
    status: 'Status',
    invite: 'Invite a member',
    inviteRole: 'Invite role',
    createInvite: 'Create invite link',
    inviting: 'Creating link…',
    inviteRestricted: 'Your workspace session does not have permission to create invites.',
    inviteReady: 'Invite link created',
    copyInvite: 'Copy invite link',
    copied: 'Copied',
    expires: (value: string) => `Expires ${value}`,
    unknownUser: 'Unknown member',
    notAvailable: 'Not available',
    ownerProtected: 'Protected owner',
  };
  if (locale === 'en') return en;
  return {
    title: '账户与成员',
    subtitle: '外部身份和工作区权限保持独立，并由服务端审计。',
    externalAccount: 'ClawHunt 账户',
    externalConnected: (name: string) => `已登录 ClawHunt：${name}`,
    externalDisconnected: '尚未连接 ClawHunt',
    connect: '连接 ClawHunt',
    disconnect: '解除连接',
    externalPurpose: '用于 ClawHunt 服务和套餐身份。',
    workspaceAccount: 'AwwO 工作区会话',
    localAdmin: '本机管理员',
    localBadge: '本机可信模式',
    localExplanation: '这是单人本机模式，不会创建可共享的 AwwO 用户会话。',
    signedIn: '已认证工作区',
    signedInAs: (name: string) => `当前工作区用户：${name}`,
    noSession: '尚未登录 AwwO 工作区',
    noSessionExplanation: '登录 ClawHunt 不会自动获得此工作区权限。',
    openSignIn: '打开 AwwO 登录',
    unavailableSignIn: '请打开现有 AwwO 登录页或邀请链接继续。',
    loading: '正在加载账户权限…',
    retry: '重试',
    profile: '工作区资料',
    displayName: '显示名称',
    email: '邮箱',
    saveProfile: '保存资料',
    saved: '已保存',
    workspaces: '工作区',
    currentWorkspace: '当前工作区',
    workspaceScope: '此选择只切换成员管理视图；画布节点仍保留各自的工作区绑定。',
    openTeam: '打开团队工作区',
    noWorkspaces: '服务端没有返回可访问的工作区。',
    members: '成员',
    membersLoading: '正在加载成员…',
    noMembers: '此工作区没有可见成员。',
    restrictedRoles: '只有工作区管理员可以查看成员角色。',
    roleFor: (name: string) => `${name} 的角色`,
    statusFor: (name: string) => `${name} 的状态`,
    role: '角色',
    status: '状态',
    invite: '邀请成员',
    inviteRole: '邀请角色',
    createInvite: '创建邀请链接',
    inviting: '正在创建…',
    inviteRestricted: '当前工作区会话没有创建邀请的权限。',
    inviteReady: '邀请链接已创建',
    copyInvite: '复制邀请链接',
    copied: '已复制',
    expires: (value: string) => `${value} 到期`,
    unknownUser: '未知成员',
    notAvailable: '暂无',
    ownerProtected: '受保护的所有者',
  } satisfies typeof en;
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isForbidden(error: unknown): boolean {
  return error instanceof AccountApiError && (error.status === 401 || error.status === 403);
}

function identityLabel(profile: AccountProfile | null, fallback: string): string {
  return profile?.name?.trim() || profile?.email?.trim() || fallback;
}

function initials(value: string): string {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return parts.slice(0, 2).map((part) => part[0]?.toUpperCase()).join('');
}

function roleLabel(role: HumanCompanyRole | null, locale: AccountLocale): string {
  if (!role) return locale === 'zh' ? '未设置' : 'Unassigned';
  const zh: Record<HumanCompanyRole, string> = {
    owner: '所有者',
    admin: '管理员',
    operator: '操作员',
    viewer: '只读成员',
    member: '成员',
    reader: '只读成员',
  };
  return locale === 'zh' ? zh[role] : role[0].toUpperCase() + role.slice(1);
}

function statusLabel(status: CompanyMembershipStatus, locale: AccountLocale): string {
  const zh: Record<CompanyMembershipStatus, string> = {
    active: '正常',
    pending: '待处理',
    suspended: '已暂停',
    archived: '已归档',
  };
  return locale === 'zh' ? zh[status] : status[0].toUpperCase() + status.slice(1);
}

async function copyToClipboard(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  try { if (!document.execCommand('copy')) throw new Error('Clipboard is unavailable'); }
  finally { textarea.remove(); }
}

function IdentityAvatar({ label, image }: { label: string; image?: string | null }) {
  if (image) return <img className="account-avatar" src={image} alt="" referrerPolicy="no-referrer" />;
  return <span className="account-avatar account-avatar-fallback" aria-hidden="true">{initials(label)}</span>;
}

function AccountStatusCard({
  eyebrow,
  label,
  detail,
  image,
  badge,
  action,
}: {
  eyebrow: string;
  label: string;
  detail: string;
  image?: string | null;
  badge?: string;
  action?: ReactNode;
}) {
  return (
    <section className="account-identity-card" aria-label={eyebrow}>
      <IdentityAvatar label={label} image={image} />
      <div className="account-identity-copy">
        <span className="account-eyebrow">{eyebrow}</span>
        <strong>{label}</strong>
        <span>{detail}</span>
      </div>
      <div className="account-identity-action">
        {badge ? <span className="account-status-badge"><ShieldCheck size={14} aria-hidden="true" />{badge}</span> : null}
        {action}
      </div>
    </section>
  );
}

export function AccountWorkspacePanel({
  locale,
  clawHuntIdentity,
  selectedCompanyId,
  onCompanyChange,
  onClawHuntLogin,
  onClawHuntLogout,
  onOpenWorkspaceAuth,
  onOpenTeam,
  api = accountApi,
  workspaceOnly = false,
}: AccountWorkspacePanelProps) {
  const text = accountCopy(locale);
  const [bootstrap, setBootstrap] = useState<BootstrapState | null>(null);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [bootstrapVersion, setBootstrapVersion] = useState(0);
  const [profileName, setProfileName] = useState('');
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileNotice, setProfileNotice] = useState<string | null>(null);
  const [identityBusy, setIdentityBusy] = useState(false);
  const [team, setTeam] = useState<TeamState>(EMPTY_TEAM);
  const [memberBusyId, setMemberBusyId] = useState<string | null>(null);
  const [inviteRole, setInviteRole] = useState<HumanCompanyRole>(workspaceOnly ? 'member' : 'operator');
  const [inviteBusy, setInviteBusy] = useState(false);
  const [invite, setInvite] = useState<CompanyInviteCreated | null>(null);
  const [inviteCopied, setInviteCopied] = useState(false);
  const [teamVersion, setTeamVersion] = useState(0);
  const [newMemberEmail, setNewMemberEmail] = useState('');
  const [removeTarget, setRemoveTarget] = useState<CompanyMember | null>(null);

  useEffect(() => {
    let cancelled = false;
    setBootstrapError(null);
    void (async () => {
      try {
        const [health, session, access] = await Promise.all([
          api.getHealth(),
          api.getSession(),
          api.getCurrentAccess(),
        ]);
        const canReadWorkspace = Boolean(access) || health.deploymentMode === 'local_trusted';
        const companies = canReadWorkspace ? await api.listCompanies() : [];
        let profile = session?.user ?? access?.user ?? null;
        if (session) {
          try {
            profile = await api.getProfile();
          } catch {
            // The session payload remains an authoritative, useful fallback.
          }
        }
        if (cancelled) return;
        setBootstrap({ health, session, access, companies, profile });
        setProfileName(profile?.name ?? '');
      } catch (error) {
        if (!cancelled) setBootstrapError(messageFor(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, bootstrapVersion]);

  const activeCompanyId = useMemo(() => {
    if (!bootstrap?.companies.length) return null;
    if (selectedCompanyId && bootstrap.companies.some((company) => company.id === selectedCompanyId)) {
      return selectedCompanyId;
    }
    return bootstrap.companies[0]?.id ?? null;
  }, [bootstrap?.companies, selectedCompanyId]);

  useEffect(() => {
    let cancelled = false;
    setInvite(null);
    setInviteCopied(false);
    if (!activeCompanyId || !bootstrap?.access) {
      setTeam(EMPTY_TEAM);
      return () => {
        cancelled = true;
      };
    }
    setTeam({ ...EMPTY_TEAM, loading: true });
    void (async () => {
      const [memberResult, inviteResult] = await Promise.allSettled([
        api.listMembers(activeCompanyId),
        api.listInvites(activeCompanyId),
      ]);
      if (cancelled) return;

      let members: CompanyMembersResponse | null = null;
      let directory: CompanyUserDirectoryResponse | null = null;
      let restricted = false;
      let error: string | null = null;
      if (memberResult.status === 'fulfilled') {
        members = memberResult.value;
      } else if (isForbidden(memberResult.reason)) {
        restricted = true;
        try {
          directory = await api.listUserDirectory(activeCompanyId);
        } catch (directoryError) {
          if (!isForbidden(directoryError)) error = messageFor(directoryError);
        }
      } else {
        error = messageFor(memberResult.reason);
      }
      if (cancelled) return;
      if (inviteResult.status === 'rejected' && !isForbidden(inviteResult.reason) && !error) error = messageFor(inviteResult.reason);
      setTeam({
        members,
        directory,
        canInvite:
          inviteResult.status === 'fulfilled' || Boolean(members?.access.canInviteUsers),
        loading: false,
        restricted,
        error,
        invites: api.revokeInvite && inviteResult.status === 'fulfilled' ? inviteResult.value.invites as WorkspaceInviteSummary[] : [],
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [activeCompanyId, api, bootstrap?.access, teamVersion]);

  const assignableRoles = team.members?.access.assignableRoles ?? (workspaceOnly ? [] : HUMAN_ROLES);
  const roleSignature = assignableRoles.join(',');
  useEffect(() => {
    if (assignableRoles.length && !assignableRoles.includes(inviteRole)) setInviteRole(assignableRoles.includes('member') ? 'member' : assignableRoles[0]);
  }, [roleSignature, inviteRole]);

  const members = team.members?.members ?? [];
  const directory = team.directory?.users ?? [];
  const isLocalTrusted =
    bootstrap?.health.deploymentMode === 'local_trusted' || bootstrap?.access?.source === 'local_implicit';

  async function runIdentityAction(action: () => void | Promise<void>) {
    setIdentityBusy(true);
    setBootstrapError(null);
    try {
      await action();
    } catch (error) {
      setBootstrapError(messageFor(error));
    } finally {
      setIdentityBusy(false);
    }
  }

  async function saveProfile() {
    const name = profileName.trim();
    if (!name || !bootstrap?.profile) return;
    setProfileBusy(true);
    setProfileNotice(null);
    try {
      const profile = await api.updateProfile({ name, image: bootstrap.profile.image });
      setBootstrap({ ...bootstrap, profile, session: bootstrap.session ? { ...bootstrap.session, user: profile } : null });
      setProfileName(profile.name ?? '');
      setProfileNotice(text.saved);
    } catch (error) {
      setProfileNotice(messageFor(error));
    } finally {
      setProfileBusy(false);
    }
  }

  async function updateMember(member: CompanyMember, patch: { membershipRole?: HumanCompanyRole; status?: Exclude<CompanyMembershipStatus, 'archived'> }) {
    if (!activeCompanyId || !team.members?.access.canManageMembers) return;
    setMemberBusyId(member.id);
    setTeam((current) => ({ ...current, error: null }));
    try {
      const updated = await api.updateMember(activeCompanyId, member.id, patch);
      setTeam((current) => current.members ? {
        ...current,
        members: {
          ...current.members,
          members: current.members.members.map((entry) => entry.id === updated.id ? updated : entry),
        },
      } : current);
    } catch (error) {
      setTeam((current) => ({ ...current, error: messageFor(error) }));
    } finally {
      setMemberBusyId(null);
    }
  }

  async function createInvite() {
    if (!activeCompanyId || !team.canInvite || !assignableRoles.includes(inviteRole)) return;
    setInviteBusy(true);
    setInvite(null);
    setInviteCopied(false);
    setTeam((current) => ({ ...current, error: null }));
    try {
      const created = await api.createHumanInvite(activeCompanyId, inviteRole);
      setInvite(created);
      if (api.revokeInvite) setTeam(current => ({ ...current, invites: [{ id: created.id, role: created.humanRole || inviteRole, expiresAt: created.expiresAt, status: 'active' }, ...current.invites] }));
    } catch (error) {
      setTeam((current) => ({ ...current, error: messageFor(error) }));
    } finally {
      setInviteBusy(false);
    }
  }

  async function memberAction(action: () => Promise<void>) {
    setMemberBusyId('$action'); setTeam(current => ({ ...current, error: null }));
    try { await action(); setNewMemberEmail(''); setRemoveTarget(null); setTeamVersion(value => value + 1); }
    catch (error) { setTeam(current => ({ ...current, error: messageFor(error) })); }
    finally { setMemberBusyId(null); }
  }

  async function revokeInvite(id: string) {
    if (!activeCompanyId || !api.revokeInvite) return;
    setInviteBusy(true); setTeam(current => ({ ...current, error: null }));
    try {
      await api.revokeInvite(activeCompanyId, id);
      setTeam(current => ({ ...current, invites: current.invites.map(item => item.id === id ? { ...item, status: 'revoked' } : item) }));
      if (invite?.id === id) { setInvite(null); setInviteCopied(false); }
    } catch (error) { setTeam(current => ({ ...current, error: messageFor(error) })); }
    finally { setInviteBusy(false); }
  }

  if (!bootstrap && !bootstrapError) {
    return <div className="account-workspace-state" role="status"><RefreshCw size={18} className="account-spin" aria-hidden="true" />{text.loading}</div>;
  }

  return (
    <main className="account-workspace-panel" aria-labelledby="account-workspace-title">
      <header className="account-workspace-header">
        <div>
          <h1 id="account-workspace-title">{text.title}</h1>
          <p>{workspaceOnly ? (locale === 'zh' ? 'AwwO 账号、工作区权限与邀请由服务端管理。' : 'Your AwwO account, workspace access and invitations are managed by the server.') : text.subtitle}</p>
        </div>
        <button
          type="button"
          className="account-icon-button"
          aria-label={text.retry}
          title={text.retry}
          onClick={() => setBootstrapVersion((value) => value + 1)}
        >
          <RefreshCw size={17} aria-hidden="true" />
        </button>
      </header>

      {bootstrapError ? <div className="account-notice account-notice-error" role="alert">{bootstrapError}</div> : null}

      <div className="account-identity-grid">
        {!workspaceOnly && <AccountStatusCard
          eyebrow={text.externalAccount}
          label={clawHuntIdentity ? text.externalConnected(clawHuntIdentity.username) : text.externalDisconnected}
          detail={clawHuntIdentity?.email || text.externalPurpose}
          image={clawHuntIdentity?.avatar_url}
          action={
            <button
              type="button"
              className="account-secondary-button"
              disabled={identityBusy}
              onClick={() => void runIdentityAction(clawHuntIdentity ? onClawHuntLogout : onClawHuntLogin)}
            >
              {clawHuntIdentity ? text.disconnect : text.connect}
            </button>
          }
        />}

        {isLocalTrusted ? (
          <AccountStatusCard
            eyebrow={text.workspaceAccount}
            label={text.localAdmin}
            detail={text.localExplanation}
            badge={text.localBadge}
          />
        ) : bootstrap?.session ? (
          <AccountStatusCard
            eyebrow={text.workspaceAccount}
            label={text.signedIn}
            detail={text.signedInAs(identityLabel(bootstrap.profile, bootstrap.session.user.id))}
            image={bootstrap.profile?.image}
            badge={bootstrap.access?.isInstanceAdmin ? (locale === 'zh' ? '实例管理员' : 'Instance admin') : undefined}
          />
        ) : (
          <AccountStatusCard
            eyebrow={text.workspaceAccount}
            label={text.noSession}
            detail={text.noSessionExplanation}
            action={onOpenWorkspaceAuth ? (
              <button type="button" className="account-primary-button" onClick={onOpenWorkspaceAuth}>
                {text.openSignIn}<ExternalLink size={14} aria-hidden="true" />
              </button>
            ) : <span className="account-inline-note">{text.unavailableSignIn}</span>}
          />
        )}
      </div>

      {bootstrap?.session && bootstrap.profile ? (
        <section className="account-section" aria-labelledby="account-profile-heading">
          <div className="account-section-heading">
            <div><span>{text.workspaceAccount}</span><h2 id="account-profile-heading">{text.profile}</h2></div>
          </div>
          <div className="account-profile-grid">
            <label>
              <span>{text.displayName}</span>
              <input aria-label={text.displayName} value={profileName} maxLength={120} onChange={(event) => setProfileName(event.target.value)} />
            </label>
            <label>
              <span>{text.email}</span>
              <input value={bootstrap.profile.email ?? ''} readOnly aria-readonly="true" />
            </label>
            <button type="button" className="account-primary-button" disabled={profileBusy || !profileName.trim()} onClick={() => void saveProfile()}>
              {text.saveProfile}
            </button>
          </div>
          {profileNotice ? <div className="account-inline-note" role="status">{profileNotice}</div> : null}
        </section>
      ) : null}

      {bootstrap?.access ? (
        <section className="account-section" aria-labelledby="account-workspaces-heading">
          <div className="account-section-heading">
            <div><span>{locale === 'zh' ? '权限范围' : 'Access scope'}</span><h2 id="account-workspaces-heading">{text.workspaces}</h2></div>
          </div>
          {bootstrap.companies.length ? (
            <div className="account-company-scope">
              <label className="account-company-select">
                <span>{text.currentWorkspace}</span>
                <select aria-label={text.currentWorkspace} value={activeCompanyId ?? ''} onChange={(event) => onCompanyChange(event.target.value)}>
                  {bootstrap.companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}
                </select>
              </label>
              {onOpenTeam && activeCompanyId ? (
                <button type="button" className="account-secondary-button" onClick={() => onOpenTeam(activeCompanyId)}>
                  {text.openTeam}<ExternalLink size={14} aria-hidden="true" />
                </button>
              ) : null}
              <p>{text.workspaceScope}</p>
            </div>
          ) : <p className="account-empty-state">{text.noWorkspaces}</p>}
        </section>
      ) : null}

      {bootstrap?.access && activeCompanyId ? (
        <section className="account-section" aria-labelledby="account-members-heading">
          <div className="account-section-heading">
            <div><span>{bootstrap.companies.find((company) => company.id === activeCompanyId)?.name}</span><h2 id="account-members-heading">{text.members}</h2></div>
            <Users size={18} aria-hidden="true" />
          </div>
          {team.loading ? <div className="account-workspace-state" role="status">{text.membersLoading}</div> : null}
          {team.error ? <div className="account-notice account-notice-error" role="alert">{team.error}</div> : null}
          {team.restricted ? <p className="account-permission-note"><ShieldCheck size={15} aria-hidden="true" />{text.restrictedRoles}</p> : null}

          <div className="account-member-list">
            {members.map((member) => {
              const label = identityLabel(member.user, member.principalId || text.unknownUser);
              const editable = Boolean(team.members?.access.canManageMembers) && member.editable !== false;
              return (
                <article className="account-member-row" key={member.id}>
                  <IdentityAvatar label={label} image={member.user?.image} />
                  <div className="account-member-identity">
                    <strong>{label}</strong>
                    <span>{member.user?.email ?? member.principalId}</span>
                    {!member.removal?.canArchive && member.removal?.reason ? <small>{text.ownerProtected}</small> : null}
                  </div>
                  {editable ? (
                    <div className="account-member-controls">
                      <label>
                        <span>{text.role}</span>
                        <select
                          aria-label={text.roleFor(label)}
                          value={member.membershipRole ?? 'operator'}
                          disabled={memberBusyId !== null}
                          onChange={(event) => void updateMember(member, { membershipRole: event.target.value as HumanCompanyRole })}
                        >
                          {assignableRoles.map((role) => <option key={role} value={role}>{roleLabel(role, locale)}</option>)}
                        </select>
                      </label>
                      {team.members?.access.canChangeStatus !== false && <label>
                        <span>{text.status}</span>
                        <select
                          aria-label={text.statusFor(label)}
                          value={member.status === 'archived' ? 'suspended' : member.status}
                          disabled={memberBusyId === member.id}
                          onChange={(event) => void updateMember(member, { status: event.target.value as Exclude<CompanyMembershipStatus, 'archived'> })}
                        >
                          {EDITABLE_STATUSES.map((status) => <option key={status} value={status}>{statusLabel(status, locale)}</option>)}
                        </select>
                      </label>}
                      {api.removeMember && member.removal?.canArchive && <button type="button" className="account-secondary-button" disabled={memberBusyId !== null} onClick={() => setRemoveTarget(member)}>{locale === 'zh' ? '移除成员' : 'Remove member'}</button>}
                    </div>
                  ) : (
                    <div className="account-member-summary"><strong>{roleLabel(member.membershipRole, locale)}</strong><span>{statusLabel(member.status, locale)}</span></div>
                  )}
                </article>
              );
            })}
            {directory.map((entry) => {
              const label = identityLabel(entry.user, entry.principalId || text.unknownUser);
              return (
                <article className="account-member-row" key={entry.principalId}>
                  <IdentityAvatar label={label} image={entry.user?.image} />
                  <div className="account-member-identity"><strong>{label}</strong><span>{entry.user?.email ?? entry.principalId}</span></div>
                  <div className="account-member-summary"><strong>{text.notAvailable}</strong><span>{statusLabel(entry.status, locale)}</span></div>
                </article>
              );
            })}
            {!team.loading && members.length === 0 && directory.length === 0 ? <p className="account-empty-state">{text.noMembers}</p> : null}
          </div>

          {api.addMember && team.members?.access.canManageMembers && <form className="account-member-add" onSubmit={event => {
            event.preventDefault(); if (activeCompanyId) void memberAction(() => api.addMember!(activeCompanyId, { email: newMemberEmail, role: inviteRole }));
          }}><p>{locale === 'zh' ? '可直接添加已注册邮箱；新用户可使用下方邀请链接。' : 'Add a registered email directly, or invite a new user with a link below.'}</p><label><span>{text.email}</span><input type="email" aria-label={locale === 'zh' ? '成员邮箱' : 'Member email'} required value={newMemberEmail} onChange={event => setNewMemberEmail(event.target.value)} /></label>
            <label><span>{text.role}</span><select aria-label={locale === 'zh' ? '新成员角色' : 'New member role'} value={inviteRole} onChange={event => setInviteRole(event.target.value as HumanCompanyRole)}>{assignableRoles.map(role => <option key={role} value={role}>{roleLabel(role, locale)}</option>)}</select></label>
            <button type="submit" className="account-primary-button" disabled={memberBusyId !== null}>{locale === 'zh' ? '添加成员' : 'Add member'}</button></form>}
          {removeTarget && <div className="account-notice" role="alert"><p>{locale === 'zh' ? `确认移除 ${identityLabel(removeTarget.user, removeTarget.principalId)}？` : `Remove ${identityLabel(removeTarget.user, removeTarget.principalId)}?`}</p><button type="button" disabled={memberBusyId !== null} onClick={() => void memberAction(() => api.removeMember!(activeCompanyId!, removeTarget.principalId))}>{locale === 'zh' ? '确认移除' : 'Confirm removal'}</button><button type="button" onClick={() => setRemoveTarget(null)}>{locale === 'zh' ? '取消' : 'Cancel'}</button></div>}

          <div className="account-invite-panel">
            <div className="account-invite-heading"><UserPlus size={18} aria-hidden="true" /><strong>{text.invite}</strong></div>
            <label>
              <span>{text.inviteRole}</span>
              <select aria-label={text.inviteRole} value={inviteRole} onChange={(event) => setInviteRole(event.target.value as HumanCompanyRole)} disabled={!team.canInvite || inviteBusy}>
                {assignableRoles.map((role) => <option key={role} value={role}>{roleLabel(role, locale)}</option>)}
              </select>
            </label>
            <button type="button" className="account-primary-button" disabled={!team.canInvite || inviteBusy || !assignableRoles.includes(inviteRole)} onClick={() => void createInvite()}>
              {inviteBusy ? text.inviting : text.createInvite}
            </button>
            {!team.loading && !team.canInvite ? <p className="account-permission-note">{text.inviteRestricted}</p> : null}
            {invite ? (
              <div className="account-invite-result" role="status">
                <div><strong>{text.inviteReady}</strong><span>{text.expires(new Date(invite.expiresAt).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US'))}</span></div>
                <code>{invite.inviteUrl}</code>
                <button type="button" className="account-secondary-button" aria-label={text.copyInvite} onClick={() => void copyToClipboard(invite.inviteUrl).then(() => setInviteCopied(true)).catch((error) => setTeam((current) => ({ ...current, error: messageFor(error) })))}>
                  {inviteCopied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}{inviteCopied ? text.copied : text.copyInvite}
                </button>
              </div>
            ) : null}
            {api.revokeInvite && team.invites.length > 0 && <div className="account-invite-list"><h3>{locale === 'zh' ? '已创建的邀请' : 'Created invitations'}</h3><p>{locale === 'zh' ? '完整链接仅在创建时显示，请当时复制；已有链接可撤销。' : 'The full link is shown only when created. Copy it then; existing links can be revoked.'}</p>{team.invites.map(item => <article key={item.id} className="account-invite-row"><span>{roleLabel(item.role, locale)} · {text.expires(new Date(item.expiresAt).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US'))} · {locale === 'zh' ? ({ active: '有效', expired: '已过期', revoked: '已撤销', accepted: '已领取', unavailable: '已失效', suspended: '工作区暂停' }[item.status] || item.status) : item.status}</span>
              {item.status === 'active' && assignableRoles.includes(item.role) && <button type="button" className="account-secondary-button" disabled={inviteBusy} onClick={() => void revokeInvite(item.id)}>{locale === 'zh' ? '撤销邀请' : 'Revoke invitation'}</button>}</article>)}</div>}
          </div>
        </section>
      ) : null}
    </main>
  );
}

export default AccountWorkspacePanel;
