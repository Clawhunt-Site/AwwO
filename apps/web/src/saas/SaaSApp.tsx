import { SecretInput } from './SecretInput';
import { CanvasThumbnail } from './CanvasThumbnail';
import { PersonalEngineGate, PasswordRecovery, accountURL } from './PersonalAccount';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LogOut, Plus, ArrowLeft, ShieldCheck, Save, Check, Download, Eye } from 'lucide-react';
import { api, tenantPath, SaaSApiError, saasErrorMessage, type Identity, type Tenant, type CanvasRecord } from './api';
import { configureSaaSCanvas, configureSaaSCanvasSave, configureSaaSCanvasInitialize, currentSaaSCanvas, clearSaaSCanvas } from './canvasBridge';
import { configureCanvasStorage, canvasStorage, canvasStorageKey } from '../canvas/canvasStorage';
import { CANVAS_DRAFT_PREFIX, persistCanvasDraft, readCanvasDrafts, removeCanvasDraft, acknowledgeCanvasDraft, rememberCanvasBaseline, rememberKeptCanvasDrafts, unreviewedCanvasDrafts, isKnownSyncedCache, canonicalCanvasDocumentJSON, type CanvasDraft, type SavedCanvasDraft } from './canvasDraft';
import { CanvasSurface, type InitialPlanRequest } from '../canvas/CanvasSurface';
import { CANVAS_STORAGE_KEY, sanitizeDocument, type CanvasDocument } from '../canvas/canvasDoc';
import { CANVAS_RUN_JOURNAL_KEY, loadRunJournal, saveRunJournal } from '../canvas/runJournal';
import { withCanvasRunOwnership } from '../canvas/runOwnership';
import { runInputFingerprint } from '../canvas/runRecoveryDocument';
import { graphPath, graphIsActive, graphRecoveryJournal, type GraphRunSnapshot } from './graphRuns';
import { GraphRunPanel } from './GraphRunPanel';
import { createCanvasRuntimeReader } from '../canvasRuntimeReader';
import { CanvasAccountControl } from '../CanvasAccountControl';
import { createSaaSAccountApi } from './accountApi';
import { SaaSPreferencesProvider, useSaaSPreferences, PreferenceControls } from './preferences';
import { InviteAcceptance } from './InviteAcceptance';
import { AdminPanel } from './AdminPanel';
import { RuntimeSettings } from './RuntimeSettings';
import { WorkspaceHome } from './WorkspaceHome';
import { OfficialExamples, PublicOfficialExamples } from './examples/OfficialExamples';
import { rememberOfficialSelection } from './examples/officialSelection';
import { claimPlanHandoff, clearPlanHandoff, takePlanHandoff } from './planHandoff';
import { ActionMenu } from './ActionMenu';
import { AppearanceScope } from './SaaSAppearance';
import { SaaSOnboarding, GuideLauncher, MainSiteLink } from './SaaSOnboarding';
import { clearSSOReturnURL, clawHuntAccountURL, clawHuntStartURL, clawHuntWaitlistURL, readSSOReturn, trustedAwwORedirectURL, trustedClawHuntLogoutURL, type AuthOptions, type SSOFailureReason, type SSOReturn } from './clawhuntAuth';

const message = (error: unknown) => error instanceof Error ? error.message : 'Request failed';
const workspaceURL = (tenant?: string, canvas?: string) => {
  const query = new URLSearchParams();
  if (tenant) query.set('tenant', tenant);
  if (canvas) query.set('canvas', canvas);
  return '/' + (query.size ? '?' + query : '');
};
const navigate = (tenant?: string, canvas?: string) => window.location.assign(workspaceURL(tenant, canvas));
function CanvasBackLink({ tenantId }: { tenantId: string }) {
  const { t } = useSaaSPreferences();
  // A normal navigation preserves beforeunload protection for unsynced changes.
  return <a className="saas-canvas-back" href={workspaceURL(tenantId)}><ArrowLeft size={15} aria-hidden="true" /><span>{t('返回画布列表', 'Back to canvases')}</span></a>;
}
function CanvasTitle({ tenant, name, status, tone }: { tenant: Tenant; name: string; status: React.ReactNode; tone: 'synced' | 'pending' | 'readonly' | 'warning' }) {
  return <div className="saas-canvas-title"><CanvasBackLink tenantId={tenant.id} /><div className="saas-canvas-title-text"><span className="saas-canvas-title-workspace">{tenant.name}</span><strong title={name}>{name}</strong></div><span className={`saas-sync-pill is-${tone}`} role="status">{status}</span></div>;
}
function CanvasPageHeader({ tenantId, controls }: { tenantId: string; controls: React.ReactNode }) {
  return <header className="saas-canvas-page-header"><div className="saas-canvas-page-navigation"><a href="/" className="saas-logo">AwwO</a><CanvasBackLink tenantId={tenantId} /></div>{controls}</header>;
}
export function SaaSApp() { return <SaaSPreferencesProvider>{new URLSearchParams(window.location.search).get('examples') === '1' ? <PublicOfficialExamples /> : <AuthenticatedApp />}</SaaSPreferencesProvider>; }
function AuthenticatedApp() {
  const { locale, t } = useSaaSPreferences();
  useEffect(() => { const id = new URLSearchParams(window.location.search).get('official'); if (id) rememberOfficialSelection(id); }, []);
  const [ssoReturn, setSSOReturn] = useState<SSOReturn | null>(() => readSSOReturn(location.search));
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [loading, setLoading] = useState(true);
  const [resetToken] = useState(() => new URLSearchParams(window.location.search).get('reset'));
  useEffect(() => { if (resetToken) { const url = new URL(location.href); url.searchParams.delete('reset'); history.replaceState(null, '', url.pathname + url.search); } }, [resetToken]);
  useEffect(() => { if (ssoReturn) clearSSOReturnURL(); }, [ssoReturn]);
  const [failure, setFailure] = useState('');
  const sessionRequestGeneration = useRef(0);
  const onAuthenticated = useCallback((value: Identity) => {
    // A completed login/link supersedes the initial session lookup, even if
    // that older request later returns another account or a service error.
    sessionRequestGeneration.current += 1;
    setIdentity(value);
    setFailure('');
    setLoading(false);
    setSSOReturn(null);
  }, []);
  const onProfile = useCallback((name: string) => setIdentity(current => current ? { ...current, user: { ...current.user, name } } : current), []);
  useEffect(() => {
    let live = true;
    const generation = ++sessionRequestGeneration.current;
    const controller = new AbortController();
    const current = () => live && generation === sessionRequestGeneration.current;
    api<Identity>('/auth/me', { signal: controller.signal }).then(value => { if (current()) setIdentity(value); })
      .catch(error => { if (current() && !(error instanceof SaaSApiError && error.status === 401)) setFailure(message(error)); })
      .finally(() => { if (current()) setLoading(false); });
    return () => { live = false; controller.abort(); };
  }, []);
  const inviteToken = new URLSearchParams(window.location.search).get('invite');
  if (ssoReturn?.kind === 'error') return <SSOFailure reason={ssoReturn.reason} signedIn={Boolean(identity)} />;
  if (ssoReturn?.kind === 'link') return <LinkExistingAccount onAuthenticated={onAuthenticated} />;
  if (resetToken) return <PasswordRecovery token={resetToken} onBack={() => location.assign('/')} />;
  if (loading) return <Notice text={t('正在验证会话…', 'Checking your session…')} />;
  if (failure) return <Notice text={saasErrorMessage(failure, locale)} retry />;
  if (!identity) return <Login invited={Boolean(inviteToken)} onAuthenticated={onAuthenticated} />;
  const controls = <WorkspaceControls identity={identity} onProfile={onProfile} />;
  const content = inviteToken ? <InviteAcceptance key={inviteToken + identity.user.id} token={inviteToken} identity={identity} controls={controls} />
    : window.location.pathname === '/admin' ? <AdminPanel identity={identity} controls={controls} />
    : <Workspace identity={identity} onProfile={onProfile} />;
  return <AppearanceScope key={identity.user.id} userId={identity.user.id}><SaaSOnboarding identity={identity}><PersonalEngineGate identity={identity}>{content}</PersonalEngineGate></SaaSOnboarding></AppearanceScope>;
}
function useAuthOptions() {
  const [options, setOptions] = useState<AuthOptions | null>(null);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setOptions(null); setError(false);
    api<AuthOptions>('/auth/options', { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setOptions(value); })
      .catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [revision]);
  return { options, optionsError: error, retryOptions: () => setRevision(value => value + 1) };
}
const ssoFailureCopy: Record<SSOFailureReason, [string, string]> = {
  waitlisted: ['你的 ClawHunt 账号仍在 AwwO 轮候名单中。请返回主站查看申请状态。', 'Your ClawHunt account is still on the AwwO waitlist. Return to the main site to check your application.'],
  expired: ['登录请求已过期。请重新使用 ClawHunt 账号继续。', 'The sign-in request expired. Continue with ClawHunt again.'],
  unavailable: ['暂时无法完成统一登录。请稍后重试。', 'Unified sign-in is temporarily unavailable. Please try again.'],
  conflict: ['此账号关联存在冲突，尚未访问任何 AwwO 工作区。请联系管理员处理。', 'This account has a linking conflict. No AwwO workspace was opened. Contact an administrator.'],
  invalid_identity: ['无法验证 ClawHunt 账号身份。请返回主站确认账号状态后重试。', 'We could not verify your ClawHunt identity. Check your account on the main site and try again.'],
};
function SSOFailure({ reason, signedIn = false }: { reason: SSOFailureReason; signedIn?: boolean }) {
  const { t, locale } = useSaaSPreferences();
  const { options } = useAuthOptions();
  const waitlistURL = clawHuntWaitlistURL(options?.clawhuntSiteURL);
  return <main className="saas-login saas-sso-layout"><PreferenceControls /><div className="saas-login-brand"><span>AwwO</span><MainSiteLink /><h1>{t('账号连接未完成', 'Account connection not completed')}</h1></div>
    <section className="saas-card"><h2>{t('请检查登录状态', 'Check your sign-in')}</h2><p role="alert">{ssoFailureCopy[reason][locale === 'zh' ? 0 : 1]}</p>
      {reason === 'waitlisted' && waitlistURL && <a className="saas-primary saas-sso-action" href={waitlistURL}>{t('查看 AwwO 轮候', 'View the AwwO waitlist')}</a>}
      {reason !== 'waitlisted' && <a className="saas-primary saas-sso-action" href={clawHuntStartURL(location.search)}>{t('重新使用 ClawHunt 账号继续', 'Continue with ClawHunt again')}</a>}
      <a href="/">{signedIn ? t('返回工作区', 'Back to workspace') : t('返回登录', 'Back to sign in')}</a>
    </section></main>;
}
function LinkExistingAccount({ onAuthenticated }: { onAuthenticated: (identity: Identity) => void }) {
  const { t, locale } = useSaaSPreferences();
  const [pending, setPending] = useState<{ email: string; expiresAt: string } | null>(null);
  const [loadError, setLoadError] = useState<'expired' | 'unavailable' | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [linkConsumed, setLinkConsumed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    api<{ email: string; expiresAt: string }>('/auth/clawhunt/pending', { signal: controller.signal })
      .then(value => {
        if (controller.signal.aborted) return;
        if (typeof value.email !== 'string' || !value.email || typeof value.expiresAt !== 'string') { setLoadError('unavailable'); return; }
        setPending(value);
      })
      .catch(cause => { if (!controller.signal.aborted) setLoadError(cause instanceof SaaSApiError && (cause.code === 'sso_expired' || [400, 404, 410].includes(cause.status)) ? 'expired' : 'unavailable'); });
    return () => controller.abort();
  }, []);
  if (loadError) return <SSOFailure reason={loadError} />;
  return <main className="saas-login saas-sso-layout"><PreferenceControls /><div className="saas-login-brand"><span>AwwO</span><MainSiteLink /><h1>{t('保留你原来的工作区', 'Keep your existing workspace')}</h1><p>{t('已确认 ClawHunt 账号。关联前，请证明这个旧 AwwO 账号也属于你。', 'Your ClawHunt account is confirmed. Before linking, prove that the existing AwwO account is yours too.')}</p></div>
    <form className="saas-card" onSubmit={async event => {
      event.preventDefault(); if (busy || !pending) return;
      setBusy(true); setError(null);
      const form = event.currentTarget;
      const password = String(new FormData(form).get('password') || '');
      try {
        const result = await api<Identity & { redirectURL?: string }>('/auth/clawhunt/link', { method: 'POST', body: JSON.stringify({ password }) });
        const redirect = trustedAwwORedirectURL(result.redirectURL);
        if (redirect) history.replaceState(history.state, '', redirect);
        onAuthenticated(result);
      }
      catch (cause) {
        if (cause instanceof SaaSApiError && cause.code === 'sso_expired') setLoadError('expired');
        else {
          setError(cause);
          if (cause instanceof SaaSApiError && cause.code === 'sso_link_failed') setLinkConsumed(true);
        }
        form.reset();
      }
      finally { setBusy(false); }
    }}><span className="saas-eyebrow">{t('关联已有账号', 'LINK EXISTING ACCOUNT')}</span><h2>{t('验证原 AwwO 密码', 'Verify your original AwwO password')}</h2>
      {pending ? <><p>{t('原 AwwO 账号：', 'Existing AwwO account: ')}<strong>{pending.email}</strong></p>
        {linkConsumed ? <>{error !== null && <p className="saas-error" role="alert">{saasErrorMessage(error, locale)}</p>}<a className="saas-primary saas-sso-action" href={clawHuntStartURL(location.search)}>{t('从 ClawHunt 重新开始', 'Start again from ClawHunt')}</a></> : <>
        <SecretInput label={t('原 AwwO 密码', 'Original AwwO password')} name="password" autoComplete="current-password" disabled={busy} required />
        {error !== null && <p className="saas-error" role="alert">{saasErrorMessage(error, locale)}</p>}
        <button className="saas-primary" disabled={busy}>{busy ? t('正在验证…', 'Verifying…') : t('验证并保留工作区', 'Verify and keep workspace')}</button>
        <small>{t('验证后会沿用原工作区、画布、历史和个人模型连接。不会根据邮箱自动合并账号。忘记原密码时请联系管理员恢复。', 'Verification preserves your existing workspace, canvases, history and personal model connections. Accounts are never merged based on email alone. Contact an administrator if you lost the original password.')}</small></>}</>
        : <p role="status">{t('正在检查关联请求…', 'Checking the linking request…')}</p>}
    </form></main>;
}
function Notice({ text, retry = false }: { text: string; retry?: boolean }) {
  const { locale, t } = useSaaSPreferences();
  return <main className="saas-notice"><PreferenceControls /><strong>AwwO</strong><p role={retry ? 'alert' : 'status'}>{text}</p>{retry && <button onClick={() => window.location.reload()}>{t('重新连接', 'Reconnect')}</button>}</main>;
}
const LOGIN_PREVIEW_DOCUMENT = {
  nodes: [
    { id: 'plan', x: 0, y: 150, w: 300, h: 190 },
    { id: 'build', x: 420, y: 0, w: 300, h: 190 },
    { id: 'api', x: 420, y: 300, w: 300, h: 190 },
    { id: 'review', x: 840, y: 150, w: 300, h: 190 },
  ],
  edges: [{ fromNode: 'plan', toNode: 'build' }, { fromNode: 'plan', toNode: 'api' }, { fromNode: 'build', toNode: 'review' }, { fromNode: 'api', toNode: 'review' }],
};
/** Decorative: shows what a workspace canvas looks like before the visitor has one. */
function LoginPreview() {
  const { t } = useSaaSPreferences();
  return <div className="saas-login-preview">
    <CanvasThumbnail document={LOGIN_PREVIEW_DOCUMENT} />
    <ul>
      <li>{t('多个 Agent 节点按依赖顺序协作', 'Agent nodes run in dependency order')}</li>
      <li>{t('每个节点保留独立会话与交付物', 'Every node keeps its own session and output')}</li>
      <li>{t('使用你自己的模型服务与密钥', 'Bring your own model service and key')}</li>
    </ul>
  </div>;
}
function Login({ onAuthenticated, invited }: { onAuthenticated: (identity: Identity) => void; invited: boolean }) {
  const { locale, t } = useSaaSPreferences();
  const { options, optionsError, retryOptions } = useAuthOptions();
  const [register, setRegister] = useState(false);
  const [forgot, setForgot] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (forgot && options?.localAuth === true) return <PasswordRecovery onBack={() => setForgot(false)} />;
  return <main className="saas-login"><PreferenceControls /><div className="saas-login-brand"><span>AwwO</span><MainSiteLink /><h1>{t('让 Agent 在同一张画布上协作。', 'Bring your agents together on one canvas.')}</h1><p>{t('独立工作区、持久会话与实时执行。你的团队，从这里开始。', 'Separate workspaces, persistent conversations and live execution. Your team starts here.')}</p><LoginPreview /></div>
    {optionsError ? <section className="saas-card"><h2>{t('无法确认登录方式', 'Could not check sign-in methods')}</h2><p role="alert">{t('请检查网络连接后重试。', 'Check your connection and try again.')}</p><button onClick={retryOptions}>{t('重试', 'Retry')}</button></section>
    : !options ? <section className="saas-card" role="status">{t('正在读取登录方式…', 'Loading sign-in methods…')}</section>
    : <div className="saas-auth-choices">{options.clawhuntSSO === true && <section className="saas-card saas-sso-choice"><span className="saas-eyebrow">{t('统一账号', 'ONE ACCOUNT')}</span><h2>{t('使用 ClawHunt 登录 AwwO', 'Sign in to AwwO with ClawHunt')}</h2><p>{t('使用主站账号继续，保留已关联的工作区和个人执行引擎。', 'Continue with your main-site account and keep linked workspaces and personal engines.')}</p><a className="saas-primary saas-sso-action" href={clawHuntStartURL(location.search)}>{t('使用 ClawHunt 账号继续', 'Continue with ClawHunt')}</a></section>}
    {options.localAuth === true && <form className="saas-card" onSubmit={async event => {
      event.preventDefault(); if (busy) return; setBusy(true); setError(null);
      const values = Object.fromEntries(new FormData(event.currentTarget));
      try { onAuthenticated(await api<Identity>(register ? '/auth/register' : '/auth/login', { method: 'POST', body: JSON.stringify(values) })); }
      catch (error) { setError(error); } finally { setBusy(false); }
    }}>
      <span className="saas-eyebrow">{t('AGENT 工作区', 'AGENT WORKSPACE')}</span><h2>{register ? t('创建你的工作区', 'Create your workspace') : t('欢迎回来', 'Welcome back')}</h2>
      {invited && <p role="status">{t('请先登录或注册。邀请会保留，登录后由你确认加入；注册时也会建立你自己的工作区。', 'Sign in or register first. Your invitation is preserved for confirmation after sign-in. Registration also creates your own workspace.')}</p>}
      {register && <><label>{t('姓名', 'Name')}<input name="name" autoComplete="name" required maxLength={100} /></label><label>{t('工作区名称', 'Workspace name')}<input name="tenantName" required maxLength={100} /></label></>}
      <label>{t('邮箱', 'Email')}<input name="email" type="email" autoComplete="email" required /></label>
      <SecretInput key={register ? "register" : "login"} label={t('密码', 'Password')} name="password" minLength={register ? 12 : undefined} maxLength={1024} autoComplete={register ? 'new-password' : 'current-password'} disabled={busy} required />
      {!register && <button type="button" className="saas-link" disabled={busy} onClick={() => setForgot(true)}>{t('忘记密码？', 'Forgot password?')}</button>}
      {register && <small>{t('密码至少 12 位。注册后进入工作区，按提示选择模型服务，再创建第一张画布。工作区名称稍后可以修改。', 'Use at least 12 characters. After registering, enter your workspace, choose a model service as prompted, and create your first canvas. You can rename your workspace later.')}</small>}
      {error !== null && <p className="saas-error" role="alert">{saasErrorMessage(error, locale)}</p>}
      <button className="saas-primary" disabled={busy}>{busy ? t('请稍候…', 'Please wait…') : register ? t('注册并创建工作区', 'Register and create workspace') : t('登录', 'Sign in')}</button>
      <button type="button" className="saas-link" disabled={busy} onClick={() => { setRegister(!register); setError(null); }}>{register ? t('已有账号？登录', 'Already have an account? Sign in') : t('创建账号和工作区', 'Create an account and workspace')}</button>
    </form>}
    {options.localAuth !== true && options.clawhuntSSO !== true && <section className="saas-card"><h2>{t('登录暂不可用', 'Sign-in unavailable')}</h2><p role="alert">{t('暂时没有可用的登录方式，请稍后重试。', 'No sign-in method is available right now. Please try again later.')}</p></section>}
    </div>}<OfficialExamples initialId={new URLSearchParams(window.location.search).get('official') || undefined} /></main>;
}
function Workspace({ identity, onProfile }: { identity: Identity; onProfile: (name: string) => void }) {
  const { t } = useSaaSPreferences();
  const params = new URLSearchParams(window.location.search);
  const requested = params.get('tenant');
  const tenant = identity.tenants.find(item => item.id === requested) || (!requested ? identity.tenants.find(item => item.status === 'active') || identity.tenants[0] : undefined);
  const canvasId = params.get('canvas');
  const controls = <WorkspaceControls key={tenant?.id || 'none'} identity={identity} tenant={tenant} onProfile={onProfile} />;
  if (!tenant || tenant.status !== 'active') return <main className="saas-dashboard"><header><a href="/" className="saas-logo">AwwO</a>{controls}</header><section className="saas-page-intro"><h1>{tenant ? t('工作区已暂停', 'Workspace suspended') : t('选择工作区', 'Choose a workspace')}</h1><p role="status">{tenant ? t('你可以切换其他工作区，或联系工作区管理员恢复访问。', 'Switch to another workspace or contact its administrator to restore access.') : requested ? t('你无权访问这个工作区，请切换其他工作区。', 'You cannot access this workspace. Choose another one.') : t('账号尚未加入工作区。可以新建工作区，或请所有者发送邀请链接。', 'You have not joined a workspace. Create one or ask its owner for an invitation.')}</p>{identity.user.platformRole === 'admin' && <a href="/admin">{t('进入平台管理', 'Open platform administration')}</a>}</section></main>;
  const readOnly = tenant.role === 'reader';
  if (canvasId) return readOnly ? <ReadOnlyCanvas key={tenant.id + canvasId} identity={identity} tenant={tenant} canvasId={canvasId} controls={controls} /> : <CloudCanvas key={tenant.id + canvasId} identity={identity} tenant={tenant} canvasId={canvasId} controls={controls} />;
  return <main className="saas-dashboard saas-home"><header><a href="/" className="saas-logo">AwwO</a>{controls}</header>
    <WorkspaceHome key={identity.user.id + ':' + tenant.id + ':' + tenant.role} identity={identity} tenant={tenant} onOpen={id => navigate(tenant.id, id)} />
  </main>;
}
function WorkspaceControls({ identity, tenant, onProfile }: { identity: Identity; tenant?: Tenant; onProfile: (name: string) => void }) {
  const { locale, t } = useSaaSPreferences();
  const [error, setError] = useState('');
  const [managementTenant, setManagementTenant] = useState<string | null>(tenant?.id || null);
  const [creatingWorkspace, setCreatingWorkspace] = useState(() => new URLSearchParams(window.location.search).get('createWorkspace') === '1');
  const accountApi = useMemo(() => createSaaSAccountApi(onProfile), [identity.user.id, onProfile]);
  return <div className="saas-account-actions" data-onboarding="workspace-actions">
    {identity.tenants.length > 0 && <select aria-label={t('切换工作区', 'Switch workspace')} value={tenant?.id || ''} onChange={event => navigate(event.target.value)}>{!tenant && <option value="" disabled>{t('选择工作区', 'Choose a workspace')}</option>}{identity.tenants.map(item => <option key={item.id} value={item.id}>{item.name}{item.status !== 'active' ? t('（已暂停）', ' (suspended)') : ''}</option>)}</select>}
    {identity.personalCredentialsRequired && <a data-onboarding="engine-link" href={accountURL('engines')}>{t('我的引擎', 'My engines')}</a>}
    <CanvasAccountControl locale={locale} identity={null} onLogin={() => {}} onLogout={() => {}} onOpenWorkspaceAuth={() => navigate()}
      workspace={{ displayName: identity.user.name, selectedCompanyId: managementTenant, onCompanyChange: setManagementTenant, api: accountApi,
        ...(identity.authentication === 'clawhunt' ? { externalProfile: { url: clawHuntAccountURL(identity.clawhuntSiteURL) || undefined } } : {}) }} />
    <ActionMenu label={t('更多选项', 'More options')}>{close => <>
      <PreferenceControls />
      <GuideLauncher onLaunch={close} /><MainSiteLink />
      <button className="saas-create-workspace-trigger" onClick={() => { close(); setCreatingWorkspace(true); }}><Plus size={16}/>{t('新建工作区', 'Create workspace')}</button>
      <a href={accountURL('security')}>{t('账号安全', 'Security')}</a>
      {identity.user.platformRole === 'admin' && <a href="/admin"><ShieldCheck size={17}/>{t('平台管理', 'Administration')}</a>}
    <button title={t('退出登录', 'Sign out')} aria-label={t('退出登录', 'Sign out')} onClick={async () => {
      try {
        const result = await api<null | { logoutURL: string }>('/auth/logout', { method: 'POST' });
        if (identity.authentication === 'clawhunt') {
          const logoutURL = trustedClawHuntLogoutURL(result?.logoutURL, identity.clawhuntSiteURL);
          if (!logoutURL) { setError(t('AwwO 已退出，但无法确认 ClawHunt 主站退出。请到主站检查登录状态。', 'You signed out of AwwO, but we could not confirm ClawHunt sign-out. Check your main-site session.')); return; }
          location.assign(logoutURL);
        } else location.reload();
      } catch { setError(t('退出失败，请重试。', 'Sign-out failed. Please try again.')); }
    }}><LogOut size={16}/></button>
    </>}</ActionMenu>
    {creatingWorkspace && <CreateWorkspaceDialog onClose={() => setCreatingWorkspace(false)} onCreated={id => navigate(id)} />}
    {error && <p role="alert" className="saas-error">{saasErrorMessage(error, locale)}</p>}
  </div>;
}
export function CreateWorkspaceDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const { locale, t } = useSaaSPreferences();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; dialog.current?.showModal(); return () => { alive.current = false; dialog.current?.close(); }; }, []);
  return <dialog ref={dialog} className="saas-native-dialog" aria-labelledby="saas-create-workspace-title" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}><form className="saas-card" onSubmit={async event => {
    event.preventDefault(); if (busy || !name.trim()) return;
    setBusy(true); setError(null);
    try { const result = await api<Tenant>('/tenants', { method: 'POST', body: JSON.stringify({ name: name.trim() }) }); if (alive.current) onCreated(result.id); }
    catch (cause) { if (alive.current) setError(cause); }
    finally { if (alive.current) setBusy(false); }
  }}><h2 id="saas-create-workspace-title">{t('新建工作区', 'Create workspace')}</h2><p>{t('新工作区与现有工作区的数据和成员独立，你将成为所有者。', 'The new workspace has separate data and members. You will be its owner.')}</p><label>{t('工作区名称', 'Workspace name')}<input autoFocus required maxLength={100} value={name} onChange={event => setName(event.target.value)} disabled={busy}/></label>
    {error !== null && <p role="alert" className="saas-error">{saasErrorMessage(error, locale)}</p>}<div className="saas-draft-actions"><button type="button" disabled={busy} onClick={onClose}>{t('取消', 'Cancel')}</button><button className="saas-primary" disabled={busy || !name.trim()}>{busy ? t('正在创建…', 'Creating…') : t('创建工作区', 'Create workspace')}</button></div>
  </form></dialog>;
}
function downloadDocument(value: unknown, name: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click(); URL.revokeObjectURL(url);
}
function ReadOnlyCanvas({ identity, tenant, canvasId, controls }: { identity: Identity; tenant: Tenant; canvasId: string; controls: React.ReactNode }) {
  const { locale, t } = useSaaSPreferences();
  const [record, setRecord] = useState<CanvasRecord | null>(null);
  const [error, setError] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const runtimeReader = useRef(createCanvasRuntimeReader()).current;
  useEffect(() => {
    const controller = new AbortController(); configureSaaSCanvasSave(null);
    api<CanvasRecord>(tenantPath(tenant.id, '/canvases/' + encodeURIComponent(canvasId)), { signal: controller.signal }).then(value => {
      if (controller.signal.aborted) return;
      // A separate viewer cache never overwrites the same user's editable draft after a role change.
      configureCanvasStorage(identity.user.id, tenant.id, canvasId + '/read-only');
      canvasStorage().setItem(CANVAS_STORAGE_KEY, JSON.stringify(sanitizeDocument(value.document)));
      configureSaaSCanvas({ tenant, canvasId }); setRecord(value);
    }).catch(error => { if (!controller.signal.aborted) setError(message(error)); });
    return () => { controller.abort(); clearSaaSCanvas(); configureSaaSCanvasSave(null); };
  }, [identity.user.id, tenant.id, canvasId]);
  if (!record) return <main className="saas-dashboard"><CanvasPageHeader tenantId={tenant.id} controls={controls} /><p role={error ? 'alert' : 'status'}>{error ? saasErrorMessage(error, locale) : t('正在加载云端画布…', 'Loading cloud canvas…')}</p></main>;
  return <div className="saas-canvas-shell">
    <CanvasSurface readOnly storageMode="cloud" workspaceName={tenant.name} workspaceCaption={t('云端工作区', 'Cloud workspace')} runtimeReadJson={runtimeReader} accountControl={controls} onOpenSettings={() => setSettingsOpen(true)}
      headerTitle={<CanvasTitle tenant={tenant} name={record.name} tone="readonly" status={<><Eye size={12} aria-hidden="true" /><span title={t('只读视图：可浏览原画布及会话，不能编辑或运行。', 'Read-only: browse the original canvas and conversations. Editing and execution are disabled.')}>{t('只读', 'Read-only')}</span><span className="saas-visually-hidden">{t('只读视图：可浏览原画布及会话，不能编辑或运行。', 'Read-only: browse the original canvas and conversations. Editing and execution are disabled.')}</span></>} />}
      headerActions={<div className="saas-canvas-doc-actions"><GraphRunPanel tenantId={tenant.id} canvasId={canvasId} readOnly /><button type="button" className="saas-icon-action" aria-label={t('导出画布 JSON', 'Export canvas JSON')} title={t('导出画布 JSON', 'Export canvas JSON')} onClick={() => downloadDocument(record.document, record.name + '.json')}><Download size={16} aria-hidden="true" /></button></div>} />
    {settingsOpen && <RuntimeSettings tenantId={tenant.id} personalCredentialsRequired={identity.personalCredentialsRequired === true} onClose={() => setSettingsOpen(false)} />}
  </div>;
}

function CloudCanvas({ identity, tenant, canvasId, controls }: { identity: Identity; tenant: Tenant; canvasId: string; controls: React.ReactNode }) {
  const { locale, t } = useSaaSPreferences();
  const [record, setRecord] = useState<CanvasRecord | null>(null);
  const [error, setError] = useState('');
  const [saveState, setSaveState] = useState('正在加载…');
  const [runtime, setRuntime] = useState<{ configured: boolean; available: boolean; reason?: string; models?: unknown[] } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [recovery, setRecovery] = useState<SavedCanvasDraft[] | null>(null);
  const [localDraftCount, setLocalDraftCount] = useState(0);
  const [manualRecovery, setManualRecovery] = useState(false);
  // A request typed on the workspace home for this canvas, handed to the surface to plan once.
  const [initialPlan, setInitialPlan] = useState<InitialPlanRequest | null>(null);
  const current = useRef<CanvasRecord | null>(null);
  const pending = useRef<CanvasDocument | null>(null);
  const writerId = useRef(crypto.randomUUID()).current;
  const draft = useRef<CanvasDraft | null>(null);
  const restoredSource = useRef<SavedCanvasDraft | null>(null);
  const scopedStorage = useRef<ReturnType<typeof canvasStorage> | null>(null);
  const saving = useRef(false);
  const failed = useRef(false);
  const runtimeReader = useRef(createCanvasRuntimeReader()).current;
  useEffect(() => {
    const controller = new AbortController();
    configureCanvasStorage(identity.user.id, tenant.id, canvasId);
    const storage = canvasStorage(); scopedStorage.current = storage;
    try {
      const saved = readCanvasDrafts(storage);
      setLocalDraftCount(saved.length);
      if (unreviewedCanvasDrafts(storage, saved).length) setRecovery(saved);
    }
    catch (error) { setError(`无法读取本机草稿：${message(error)}`); return () => controller.abort(); }
    // Canvas data stays available when the separate runtime-status request fails.
    // Its failure still disables execution until a later reload confirms readiness.
    Promise.all([api<CanvasRecord>(tenantPath(tenant.id, `/canvases/${encodeURIComponent(canvasId)}`), { signal: controller.signal }),
      api<{ configured: boolean; available: boolean; reason?: string; models?: unknown[] }>(tenantPath(tenant.id, '/runtime'), { signal: controller.signal })
        .catch(() => ({ configured: false, available: false, reason: 'Runtime status unavailable' }))])
      .then(async ([value, health]) => {
        if (controller.signal.aborted) return;
        configureSaaSCanvas({ tenant, canvasId });
        let saved = readCanvasDrafts(storage);
        const cached = storage.getItem(CANVAS_STORAGE_KEY);
        const baseVersion = Number(storage.getItem('awwo.cloud.version'));
        const rawJournal = storage.getItem(CANVAS_RUN_JOURNAL_KEY);
        const hasJournal = Boolean(loadRunJournal(storage));
        if (rawJournal && !hasJournal) storage.setItem(`${CANVAS_RUN_JOURNAL_KEY}.corrupt.${Date.now()}`, rawJournal);
        // Migrate pre-draft caches conservatively, including edits whose draft write hit a storage error.
        // A confirmed clean cache can follow a newer server version without a false recovery prompt.
        if (!unreviewedCanvasDrafts(storage, saved).length && cached) {
          let document: CanvasDocument | null = null;
          try { const parsed = JSON.parse(cached); if (parsed?.version === 2 && Array.isArray(parsed.nodes) && Array.isArray(parsed.edges)) document = sanitizeDocument(parsed); } catch { /* Preserve the raw payload below. */ }
          if (!document || (!isKnownSyncedCache(storage, document) && canonicalCanvasDocumentJSON(document) !== canonicalCanvasDocumentJSON(value.document)) || (hasJournal && baseVersion !== value.version)) {
            if (document && baseVersion > 0) persistCanvasDraft(storage, writerId, baseVersion, document);
            else storage.setItem(`${CANVAS_DRAFT_PREFIX}${writerId}`, JSON.stringify({ unrecognizedCache: cached, baseVersion }));
            saved = readCanvasDrafts(storage);
          }
        }
        setLocalDraftCount(saved.length);
        if (unreviewedCanvasDrafts(storage, saved).length) { setManualRecovery(false); setRecovery(saved); setSaveState('存在未同步草稿'); }
        else {
          if (!hasJournal) storage.setItem(CANVAS_STORAGE_KEY, JSON.stringify(sanitizeDocument(value.document)));
          storage.setItem('awwo.cloud.version', String(value.version));
          rememberCanvasBaseline(storage, value.version, value.document);
          setRecovery(null); setSaveState('已同步');
        }
        if (!hasJournal) {
          // Cloud execution is discoverable on another browser/device. Local journals are
          // an observation cache; the server owns accepted task and dependency state.
          try {
            const graphs = await api<{ items: GraphRunSnapshot[] }>(graphPath(tenant.id, canvasId), { signal: controller.signal });
            const latest = graphs.items?.[0];
            if (latest && !controller.signal.aborted) {
              const document = sanitizeDocument(value.document);
              const recovered = graphRecoveryJournal(latest, tenant.id, document);
              const inputsMatch = recovered.inputFingerprint === runInputFingerprint(document, recovered.scope);
              const unpublished = latest.nodes.some(item => typeof item.output === 'string' && document.nodes.find(node => node.id === item.nodeId)?.lastOutput?.text !== item.output);
              if (graphIsActive(latest) || (inputsMatch && unpublished)) {
                await withCanvasRunOwnership(async () => {
                  // Another tab may have started a newer operation while discovery was pending.
                  // Share its execution lock and preserve any journal written in the meantime.
                  if (controller.signal.aborted || loadRunJournal(storage)) return;
                  saveRunJournal(recovered, storage);
                }, () => {});
              }
            }
          } catch { /* The run panel shows connectivity errors; backend admission prevents overlap. */ }
        }
        if (controller.signal.aborted) return;
        current.current = value; setRuntime(health); setRecord(value);
      }).catch(error => { if (!controller.signal.aborted) setError(message(error)); });
    return () => { controller.abort(); clearSaaSCanvas(); };
  }, [identity.user.id, tenant.id, canvasId, writerId]);

  useEffect(() => {
    if (!record || recovery || !scopedStorage.current) return;
    const storage = scopedStorage.current;
    const cacheKey = canvasStorageKey(CANVAS_STORAGE_KEY);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    const setupAbort = new AbortController();
    let initializationQueue: Promise<unknown> = Promise.resolve();
    const flush = async () => {
      while (saving.current && !disposed) await new Promise(resolve => setTimeout(resolve, 20));
      if (failed.current || disposed) throw new Error('画布未同步，请先解决保存错误再运行。');
      if (!current.current || !pending.current) return current.current?.version;
      saving.current = true;
      try {
        while (pending.current && !failed.current && !disposed) {
          // An editor may re-publish the same snapshot while its previous PUT is in flight.
          // Once that PUT is acknowledged, the newer draft has no unsent change; do not
          // advance the cloud version again or discard a genuinely different pending edit.
          if (!restoredSource.current && canonicalCanvasDocumentJSON(pending.current) === canonicalCanvasDocumentJSON(current.current!.document)) {
            try {
              const redundant = draft.current;
              if (redundant) acknowledgeCanvasDraft(storage, redundant, current.current!.version);
              pending.current = null;
              draft.current = null;
              if (!disposed) setSaveState('已同步');
            } catch (error) {
              failed.current = true;
              if (!disposed) { setSaveState('未同步'); setError(`本机草稿保存失败：${message(error)}。请立即导出本地副本。`); }
            }
            break;
          }
          const sent: CanvasDraft = draft.current || persistCanvasDraft(storage, writerId, current.current!.version, pending.current);
          const document: CanvasDocument = sent.document; pending.current = null;
          setSaveState('正在保存…');
          try {
            const saved: CanvasRecord = await api<CanvasRecord>(tenantPath(tenant.id, `/canvases/${encodeURIComponent(canvasId)}`), { method: 'PUT', body: JSON.stringify({ name: current.current!.name, document, version: current.current!.version }) });
            rememberCanvasBaseline(storage, saved.version, saved.document);
            acknowledgeCanvasDraft(storage, sent, saved.version);
            if (restoredSource.current) { removeCanvasDraft(storage, restoredSource.current); restoredSource.current = null; }
            if (!disposed) { try { setLocalDraftCount(readCanvasDrafts(storage).length); } catch { /* Draft count is decorative; save acknowledgement remains authoritative. */ } }
            if (draft.current?.revision === sent.revision) draft.current = null;
            else if (draft.current) draft.current = { ...draft.current, baseVersion: saved.version };
            current.current = saved;
            storage.setItem('awwo.cloud.version', String(Math.max(saved.version, Number(storage.getItem('awwo.cloud.version')) || 0)));
            if (!disposed) setSaveState(pending.current ? '等待同步…' : '已同步');
          } catch (error) {
            failed.current = true; pending.current ||= document;
            if (!disposed) {
              setSaveState('未同步');
              setError(error instanceof SaaSApiError && error.status === 409 ? '画布已在另一页面更新。未同步草稿已独立保存在本机，重新加载后可恢复或导出，不会覆盖云端版本。' : `保存失败：${message(error)}。未同步草稿保留在本机，重新加载后可恢复或导出。`);
            }
          }
        }
      } finally { saving.current = false; }
      if (failed.current) throw new Error('画布未同步，请先解决保存错误再运行。');
    };
    const observe = (event: Event) => {
      if ((event as CustomEvent).detail?.storageKey !== cacheKey) return;
      try {
        const document: CanvasDocument = JSON.parse(storage.getItem(CANVAS_STORAGE_KEY) || '{}');
        if (!pending.current && !draft.current && canonicalCanvasDocumentJSON(document) === canonicalCanvasDocumentJSON(current.current!.document)) return;
        pending.current = document;
        draft.current = persistCanvasDraft(storage, writerId, current.current!.version, pending.current!);
      } catch (error) {
        failed.current = true; setSaveState('未同步'); setError(`本机草稿保存失败：${message(error)}。请立即导出本地副本。`); return;
      }
      setSaveState('等待同步…'); clearTimeout(timer); timer = setTimeout(() => void flush().catch(() => {}), 450);
    };
    const leave = (event: BeforeUnloadEvent) => { if (pending.current || saving.current || failed.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('awwo:canvas-cache-write', observe); window.addEventListener('beforeunload', leave);
    configureSaaSCanvasSave(async () => { await flush(); return current.current?.version; });
    const initialize = async (scope?: readonly string[], signal?: AbortSignal) => {
      const captured = currentSaaSCanvas();
      await flush();
      if (disposed || signal?.aborted || currentSaaSCanvas() !== captured || !current.current) throw new Error('画布初始化已取消。');
      const before = current.current;
      const cacheBefore = canonicalCanvasDocumentJSON(JSON.parse(storage.getItem(CANVAS_STORAGE_KEY) || '{}'));
      if (cacheBefore !== canonicalCanvasDocumentJSON(before.document)) throw new Error('画布已在另一页面更新，请重新加载后核对。');
      saving.current = true;
      clearTimeout(timer);
      setSaveState('正在准备节点…');
      try {
        // Share autosave's queue. An uncertain POST must never be followed by a stale PUT.
        const saved = await api<CanvasRecord>(tenantPath(tenant.id, `/canvases/${encodeURIComponent(canvasId)}/initialize`), {
          method: 'POST', body: JSON.stringify({ documentVersion: before.version, ...(scope ? { scope: [...scope] } : {}) }),
          signal: AbortSignal.any([setupAbort.signal, AbortSignal.timeout(30000), ...(signal ? [signal] : [])]),
        });
        if (disposed || signal?.aborted || currentSaaSCanvas() !== captured) throw new Error('画布初始化已取消。');
        if (pending.current || draft.current || current.current !== before
            || Number(storage.getItem('awwo.cloud.version')) !== before.version
            || canonicalCanvasDocumentJSON(JSON.parse(storage.getItem(CANVAS_STORAGE_KEY) || '{}')) !== cacheBefore) {
          throw new Error('初始化期间画布已变化，本机草稿已保留，请重新加载后核对。');
        }
        const payload = saved.document as Partial<CanvasDocument> | null;
        if (saved.id !== before.id || saved.tenantId !== tenant.id || !Number.isSafeInteger(saved.version) || saved.version < before.version
            || payload?.version !== 2 || !Array.isArray(payload.nodes) || !Array.isArray(payload.edges)) throw new Error('初始化响应与当前画布不一致。');
        const document = sanitizeDocument(saved.document);
        current.current = { ...saved, document };
        rememberCanvasBaseline(storage, saved.version, document);
        storage.setItem('awwo.cloud.version', String(saved.version));
        storage.setItem(CANVAS_STORAGE_KEY, JSON.stringify(document));
        setSaveState('已同步');
        return document;
      } catch (error) {
        // A definitive 4xx rejection did not commit. Lost responses, version conflicts and
        // late edits instead require reconciliation, preserving the editor's independent draft.
        const rejected = error instanceof SaaSApiError && ((error.status >= 400 && error.status < 500 && error.code !== 'version_conflict')
          || (error.status === 503 && ['runtime_unavailable', 'database_unavailable'].includes(error.code)));
        if (!rejected) {
          failed.current = true;
          if (!draft.current) {
            const local = sanitizeDocument(JSON.parse(storage.getItem(CANVAS_STORAGE_KEY) || '{}'));
            draft.current = persistCanvasDraft(storage, writerId, before.version, local);
            pending.current = local;
          }
          if (!disposed) { setSaveState('需要重新连接'); setError('节点准备结果尚未确认。草稿已保留，请重新加载后核对云端版本，避免重复创建。'); }
        } else if (!disposed) setSaveState('已同步');
        throw error;
      } finally { saving.current = false; }
    };
    configureSaaSCanvasInitialize((scope, signal) => {
      const next = initializationQueue.then(() => initialize(scope, signal));
      initializationQueue = next.catch(() => {});
      return next;
    });
    // Planning saves through the hook configured above; before it exists the bridge refuses a plan.
    const handoffScope = { user: identity.user.id, tenant: tenant.id, canvas: canvasId };
    const handoff = takePlanHandoff(handoffScope);
    if (handoff) setInitialPlan({ ...handoff, claim: () => claimPlanHandoff(handoffScope),
      done: () => { clearPlanHandoff(handoffScope); setInitialPlan(null); } });
    if (pending.current) timer = setTimeout(() => void flush().catch(() => {}), 450);
    return () => { disposed = true; setupAbort.abort(); configureSaaSCanvasSave(null); configureSaaSCanvasInitialize(null); clearTimeout(timer); window.removeEventListener('awwo:canvas-cache-write', observe); window.removeEventListener('beforeunload', leave); };
  }, [record, recovery, tenant.id, canvasId, writerId]);
  const useCloud = (reviewedDrafts?: SavedCanvasDraft[]) => {
    const storage = scopedStorage.current!;
    try {
      const reviewed = reviewedDrafts ?? recovery ?? [];
      const currentDrafts = readCanvasDrafts(storage);
      if (currentDrafts.length !== reviewed.length || currentDrafts.some(saved => reviewed.find(item => item.key === saved.key)?.raw !== saved.raw)) {
        setRecovery(currentDrafts); setError('草稿状态刚被另一个页面更新，请重新连接后核对。'); return;
      }
      const kept = [...reviewed];
      const cloud = JSON.stringify(sanitizeDocument(current.current!.document));
      const cached = storage.getItem(CANVAS_STORAGE_KEY);
      if (storage.getItem(CANVAS_RUN_JOURNAL_KEY) && cached) {
        // An older conflicting draft may coexist with a newer detached run's local snapshot.
        // Archive that snapshot under its actual local base before replacing the working cache.
        const baseVersion = Number(storage.getItem('awwo.cloud.version'));
        let document: CanvasDocument | null = null;
        try { const parsed = JSON.parse(cached); if (parsed?.version === 2 && Array.isArray(parsed.nodes) && Array.isArray(parsed.edges)) document = parsed; } catch { /* Preserve the raw cache instead. */ }
        if (!document || canonicalCanvasDocumentJSON(document) !== canonicalCanvasDocumentJSON(current.current!.document)) {
          const backupWriter = crypto.randomUUID();
          if (document && Number.isInteger(baseVersion) && baseVersion > 0) persistCanvasDraft(storage, backupWriter, baseVersion, document);
          else storage.setItem(`${CANVAS_DRAFT_PREFIX}${backupWriter}`, JSON.stringify({ unrecognizedCache: cached, baseVersion }));
          const backup = readCanvasDrafts(storage).find(saved => saved.key === `${CANVAS_DRAFT_PREFIX}${backupWriter}`);
          if (backup) kept.push(backup);
        }
      }
      storage.setItem(CANVAS_STORAGE_KEY, cloud);
      storage.setItem('awwo.cloud.version', String(current.current!.version));
      rememberCanvasBaseline(storage, current.current!.version, current.current!.document);
      rememberKeptCanvasDrafts(storage, kept);
      const latest = readCanvasDrafts(storage);
      const changed = latest.some(saved => !kept.some(item => item.key === saved.key && item.raw === saved.raw));
      // Keep the journal: CanvasSurface reconciles accepted runs by GET and blocks unsent nodes.
      setLocalDraftCount(latest.length);
      setRecovery(changed ? latest : null);
      setManualRecovery(false);
      setError(changed ? '草稿状态刚被另一个页面更新，请重新连接后核对。' : '');
      setSaveState(changed ? '存在未同步草稿' : '已同步');
    } catch (error) { setError(message(error)); }
  };
  if (recovery) return <DraftRecovery tenantId={tenant.id} controls={controls} record={record} drafts={recovery} error={error}
    hasJournal={Boolean(scopedStorage.current && loadRunJournal(scopedStorage.current))} manual={manualRecovery} onUseCloud={() => useCloud()}
    onRestore={saved => {
      if (!saved.draft || !current.current || saved.draft.baseVersion !== current.current.version) return;
      const storage = scopedStorage.current!;
      try {
        if (storage.getItem(saved.key) !== saved.raw) {
          const latest = readCanvasDrafts(storage);
          setLocalDraftCount(latest.length); setRecovery(latest); setManualRecovery(false);
          setError('草稿状态刚被另一个页面更新，请重新连接后核对。');
          return;
        }
        draft.current = persistCanvasDraft(storage, writerId, saved.draft.baseVersion, saved.draft.document);
        restoredSource.current = saved; pending.current = saved.draft.document;
        storage.setItem(CANVAS_STORAGE_KEY, JSON.stringify(saved.draft.document));
        storage.setItem('awwo.cloud.version', String(saved.draft.baseVersion));
        setError(''); setRecovery(null); setSaveState('已恢复草稿，等待同步…');
      } catch (error) { setError(`无法恢复草稿：${message(error)}`); }
    }} onDiscard={saved => {
      const storage = scopedStorage.current!;
      if (!removeCanvasDraft(storage, saved)) { const remaining = readCanvasDrafts(storage); if (remaining.length) setRecovery(remaining); setError('草稿状态刚被另一个页面更新，请重新连接后核对。'); return; }
      const remaining = readCanvasDrafts(storage);
      setLocalDraftCount(remaining.length);
      if (remaining.length) setRecovery(remaining); else useCloud(remaining);
    }} />;
  if (!record) return <main className="saas-dashboard"><CanvasPageHeader tenantId={tenant.id} controls={controls} /><section className="saas-page-intro"><p role={error ? 'alert' : 'status'}>{error ? saasErrorMessage(error, locale) : t('正在加载云端画布…', 'Loading cloud canvas…')}</p>{error && <button onClick={() => window.location.reload()}>{t('重新连接', 'Reconnect')}</button>}</section></main>;
  const exportLocal = () => {
    const url = URL.createObjectURL(new Blob([scopedStorage.current?.getItem(CANVAS_STORAGE_KEY) || '{}'], { type: 'application/json' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'awwo-canvas-recovery.json'; anchor.click(); URL.revokeObjectURL(url);
  };
  const executionUnavailableReason = runtime === null
    ? t('正在检查执行引擎…', 'Checking the execution engine…')
    : runtime.available && !runtime.reason && Array.isArray(runtime.models) && runtime.models.length > 0
      ? undefined
      : runtime.reason
        ? saasErrorMessage(runtime.reason, locale)
        : t('当前没有可用的执行引擎。', 'No execution engine is currently available.');
  const syncTone = saveState === '已同步' ? 'synced' : saveState === '未同步' || saveState === '存在未同步草稿' ? 'warning' : 'pending';
  return <div className="saas-canvas-shell">
    {error && <div className="saas-error-banner" role="alert">{saasErrorMessage(error, locale)}<button onClick={exportLocal}>{t('导出本地副本', 'Export local copy')}</button><button onClick={() => window.location.reload()}>{t('重新加载', 'Reload')}</button></div>}
    {runtime && executionUnavailableReason && <div className="saas-runtime-note" role="status">{t('执行尚未就绪：', 'Execution is not ready: ')}{executionUnavailableReason}{' '}{identity.personalCredentialsRequired && <a data-onboarding="engine-link" href={accountURL('engines')}>{t('我的引擎', 'My engines')}</a>}{' '}{t('画布编辑仍可使用。', 'Canvas editing remains available.')}</div>}
    <CanvasSurface storageMode="cloud" personalCredentialsRequired={identity.personalCredentialsRequired === true}
      executionUnavailableReason={executionUnavailableReason} initialPlan={initialPlan}
      workspaceName={tenant.name} workspaceCaption={t('云端工作区', 'Cloud workspace')} runtimeReadJson={runtimeReader} accountControl={controls} onCreateCompany={() => window.location.assign('/?createWorkspace=1')} onOpenSettings={() => setSettingsOpen(true)}
      headerTitle={<CanvasTitle tenant={tenant} name={record.name} tone={syncTone} status={<>{syncTone === 'synced' ? <Check size={12} aria-hidden="true" /> : <Save size={12} aria-hidden="true" />}<span>{({ '正在加载…': t('正在加载…', 'Loading…'), '存在未同步草稿': t('存在未同步草稿', 'Unsynced draft found'), '已同步': t('已同步', 'Synced'), '正在保存…': t('正在保存…', 'Saving…'), '等待同步…': t('等待同步…', 'Waiting to sync…'), '未同步': t('未同步', 'Not synced'), '已恢复草稿，等待同步…': t('已恢复草稿，等待同步…', 'Draft restored, waiting to sync…') }[saveState] || saveState)}</span></>} />}
      headerActions={<div className="saas-canvas-doc-actions"><GraphRunPanel tenantId={tenant.id} canvasId={canvasId} />{localDraftCount > 0 && <button type="button" className="saas-local-drafts-action" aria-label={`${t('查看本机草稿', 'View local drafts')} (${localDraftCount})`} disabled={saveState !== '已同步'} onClick={() => {
        if (pending.current || saving.current || failed.current || !scopedStorage.current) return;
        const saved = readCanvasDrafts(scopedStorage.current);
        setLocalDraftCount(saved.length);
        if (saved.length) { setManualRecovery(true); setRecovery(saved); }
      }}><span className="saas-draft-desktop-label">{t('查看本机草稿', 'View local drafts')}</span><span className="saas-draft-mobile-label">{t('草稿', 'Drafts')}</span><span aria-hidden="true">({localDraftCount})</span></button>}<button type="button" className="saas-icon-action" aria-label={t('导出画布 JSON', 'Export canvas JSON')} title={t('导出画布 JSON', 'Export canvas JSON')} onClick={exportLocal}><Download size={16} aria-hidden="true" /></button></div>} />
    {settingsOpen && <RuntimeSettings tenantId={tenant.id} personalCredentialsRequired={identity.personalCredentialsRequired === true} onClose={() => setSettingsOpen(false)} />}
  </div>;
}

function DraftRecovery({ tenantId, controls, record, drafts, error, hasJournal, manual, onRestore, onDiscard, onUseCloud }: {
  tenantId: string; controls: React.ReactNode; record: CanvasRecord | null; drafts: SavedCanvasDraft[]; error: string; hasJournal: boolean; manual: boolean;
  onRestore: (saved: SavedCanvasDraft) => void; onDiscard: (saved: SavedCanvasDraft) => void; onUseCloud: () => void;
}) {
  const { locale, t } = useSaaSPreferences();
  const [selectedKey, setSelectedKey] = useState(drafts[0]?.key || '');
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const selected = drafts.find(saved => saved.key === selectedKey) || drafts[0];
  const canRestore = Boolean(record && selected?.draft && selected.draft.baseVersion === record.version);
  if (!selected) return <main className="saas-dashboard"><CanvasPageHeader tenantId={tenantId} controls={controls} /><section className="saas-page-intro"><h1>{t('本机草稿已变化', 'Local drafts changed')}</h1><p role="alert" className="saas-error">{error ? saasErrorMessage(error, locale) : t('请重新连接云端后核对。', 'Reconnect to the cloud to review the latest version.')}</p><button onClick={() => window.location.reload()}>{t('重新连接云端', 'Reconnect to cloud')}</button></section></main>;
  return <main className="saas-dashboard"><CanvasPageHeader tenantId={tenantId} controls={controls} /><section className="saas-page-intro"><h1>{manual ? t('已保留的本机草稿', 'Saved local drafts') : t('发现未同步的本机草稿', 'Unsynced local drafts found')}</h1><p role="status">{manual ? t('草稿仍留在这台设备上，可导出核对；画布继续使用云端版本。', 'These drafts remain on this device for review or export. The canvas continues using the cloud version.') : t('本机修改已保留。确认如何处理后才会打开编辑器；重新加载不会丢弃草稿。', 'Your local changes are preserved. Choose how to handle them before opening the editor. Reloading will not discard drafts.')}</p></section>
    {error && <p className="saas-error" role="alert">{saasErrorMessage(error, locale)}</p>}
    <section className="saas-card saas-draft-recovery"><label>{t('选择本机草稿', 'Choose a local draft')}<select aria-label={t('选择本机草稿', 'Choose a local draft')} value={selected?.key || ''} onChange={event => { setSelectedKey(event.target.value); setConfirmDiscard(false); }}>{drafts.map((saved, index) => <option key={saved.key} value={saved.key}>{t('草稿', 'Draft')} {index + 1}{saved.draft ? ' · ' + new Date(saved.draft.updatedAt).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US') : t(' · 需要人工检查', ' · Manual inspection required')}</option>)}</select></label>
      {selected?.draft ? <><p>{t('草稿基于云端版本', 'Draft base version:')} {selected.draft.baseVersion}{t('；当前云端版本', '; current cloud version:')} {record?.version ?? t('读取中', 'loading')}。</p><p>{t('包含节点：', 'Nodes: ')}{selected.draft.document.nodes.map(node => node.title).join(', ') || t('空画布', 'Empty canvas')}</p>{record && !canRestore && <p className="saas-error">{t('云端版本已有变化。请导出草稿后核对，当前草稿不会自动覆盖较新的云端内容。', 'The cloud version has changed. Export and review your draft. It will not automatically overwrite newer cloud content.')}</p>}</> : <p className="saas-error">{t('草稿格式无法自动恢复。原始内容仍可导出，尚未删除。', 'This draft format cannot be restored automatically. Its original content is preserved and can be exported.')}</p>}
      {hasJournal && <p>{t('本机还保存着待恢复运行记录。可保留草稿并使用云端版本核对运行；已提交的后台整图任务会继续调度下游。', 'A local recovery record exists. Keep your drafts and use the cloud version to check runs; accepted background graphs continue scheduling downstream nodes.')}</p>}
      <div className="saas-draft-actions"><button onClick={() => {
        const url = URL.createObjectURL(new Blob([selected.draft ? JSON.stringify(selected.draft.document, null, 2) : selected.raw], { type: 'application/json' }));
        const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'awwo-unsynced-draft.json'; anchor.click(); URL.revokeObjectURL(url);
      }}>{t('导出未同步草稿', 'Export unsynced draft')}</button><button disabled={!canRestore} onClick={() => onRestore(selected)}>{t('恢复草稿并继续同步', 'Restore draft and resume syncing')}</button>
      {record && <button onClick={onUseCloud}>{hasJournal ? t('使用云端版本并核对运行（保留草稿）', 'Use cloud version to check runs and keep drafts') : t('使用云端版本，保留草稿', 'Use cloud version and keep draft')}</button>}
      {!hasJournal && record && <button onClick={() => setConfirmDiscard(true)}>{t('丢弃这份本机草稿', 'Discard this local draft')}</button>}</div>
      {confirmDiscard && <div role="alert"><p>{t('确定丢弃所选草稿？该草稿中尚未同步的修改将被删除。', 'Discard this draft? Its unsynced changes will be deleted.')}</p><button onClick={() => { onDiscard(selected); setConfirmDiscard(false); }}>{t('确认丢弃', 'Confirm discard')}</button><button onClick={() => setConfirmDiscard(false)}>{t('保留草稿', 'Keep draft')}</button></div>}
      <button onClick={() => window.location.reload()}>{t('重新连接云端', 'Reconnect to cloud')}</button>
    </section>
  </main>;
}
