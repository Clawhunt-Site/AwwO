import { SecretInput } from './SecretInput';
import { CanvasThumbnail } from './CanvasThumbnail';
import { PersonalEngineGate, PasswordRecovery, accountURL } from './PersonalAccount';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LogOut, Plus, ArrowLeft, ShieldCheck, Save, Check, Download, Eye, KeyRound, Gift, Scale, Settings2 } from 'lucide-react';
import { api, onSessionEnded, tenantPath, trackSignedInSession, SaaSApiError, saasErrorMessage, type Identity, type Tenant, type CanvasRecord } from './api';
import { configureSaaSCanvas, configureSaaSCanvasSave, configureSaaSCanvasInitialize, currentSaaSCanvas, clearSaaSCanvas } from './canvasBridge';
import { configureCanvasStorage, canvasStorage, canvasStorageKey, canvasStore, canvasStoragePrefix, canvasStoreUsable, openCanvasStorage, openCanvasStorageInMemory, setLegacyCachePreservation } from '../canvas/canvasStorage';
import { sweepLegacyCanvasStorage } from './canvasStoreSweep';
import { CANVAS_DRAFT_PREFIX, persistCanvasDraft, preserveLegacyCanvasCache, readCanvasDrafts, removeCanvasDraft, acknowledgeCanvasDraft, isCanvasStorageQuotaError, rememberCanvasBaseline, rememberKeptCanvasDrafts, unreviewedCanvasDrafts, isKnownSyncedCache, canonicalCanvasDocumentJSON, canvasDocumentHash, restorableCanvasDraftBase, type CanvasDraft, type CanvasDraftSending, type SavedCanvasDraft } from './canvasDraft';
import { AUTOSAVE_QUIET_MS, autosavePace } from './autosavePace';
import { CanvasSurface, type CanvasResultsOptions, type InitialPlanRequest } from '../canvas/CanvasSurface';
import { CanvasRunReceipt } from './CanvasRunReceipt';
import { CANVAS_STORAGE_KEY, sanitizeDocument, type CanvasDocument } from '../canvas/canvasDoc';
import { CANVAS_RUN_JOURNAL_KEY, loadRunJournal, saveRunJournal } from '../canvas/runJournal';
import { MAX_RUN_LANES, laneStorage, loadLaneJournals, withLaneOwnership } from '../canvas/runLanes';
import { withCanvasRunOwnership } from '../canvas/runOwnership';
import { supersededGraphNodes } from '../canvas/followupDelivery';
import { recoverableOutput, runInputFingerprint } from '../canvas/runRecoveryDocument';
import { graphPath, graphIsActive, graphRecoveryJournal, type GraphRunSnapshot } from './graphRuns';
import { GraphRunPanel } from './GraphRunPanel';
import { createCanvasRuntimeReader } from '../canvasRuntimeReader';
import { CanvasAccountControl } from '../CanvasAccountControl';
import { createSaaSAccountApi } from './accountApi';
import { SaaSPreferencesProvider, useSaaSPreferences, PreferenceControls, UiModeSwitch, LanguageSwitch } from './preferences';
import { BootSurface } from './BootSurface';
import { navigateTo } from './navigation';
import { StaleBuildNotice } from './StaleBuildNotice';
import { InviteAcceptance } from './InviteAcceptance';
import { forgetPendingInvite, rememberPendingInvite, restorePendingInvite } from './pendingInvite';
import { AdminPanel } from './AdminPanel';
import { RouteUsageMeter } from './RouteUsageMeter';
import { RuntimeSettings } from './RuntimeSettings';
import { WorkspaceHome } from './WorkspaceHome';
import { ProductionCases } from './ProductionCases';
import { claimPlanHandoff, clearPlanHandoff, takePlanHandoff } from './planHandoff';
import { ActionMenu } from './ActionMenu';
import { CanvasKnowledgeDock, type CanvasTaskDraft } from './CanvasKnowledgeDock';
import { CanvasWebReader } from './CanvasWebReader';
import { CanvasLibraryTools } from './CanvasLibraryTools';
import { executionHost } from './AssistantExecution';
import { routeAssistantMessage } from './assistantRouteApi';
import type { RouteAssistant } from '../canvas/assistantRouting';
import { useManagedExecution } from './useManagedExecution';
import { notifyTaskFinished } from './taskNotifications';
import { signOut } from './signOut';
import { AccountPreferencesProvider } from './accountPreferences';
import { AppearanceScope } from './SaaSAppearance';
import { ThemePicker } from './ThemePicker';
import { SaaSOnboarding, GuideLauncher, MainSiteLink, TutorialLauncher } from './SaaSOnboarding';
import { AcademyLauncher, AcademyProvider } from './Academy';
import { clearSSOReturnURL, clawHuntAccountURL, clawHuntRedeemURL, clawHuntStartURL, readSSOReturn, trustedAwwORedirectURL, type AuthOptions, type SSOFailureReason, type SSOReturn } from './clawhuntAuth';

const message = (error: unknown) => error instanceof Error ? error.message : 'Request failed';
// An earlier release's document cache the canvas store does not take in is kept as a draft when it may hold unsynced edits.
setLegacyCachePreservation(preserveLegacyCanvasCache);
/** The license texts of the open-source code this site ships, which the hosted build writes to its root (scripts/bundle-licences.mjs). */
const LICENSES_URL = '/third-party-licenses.txt';
/** A link to them, in a tab of its own, as the skill library and the PDF preview open theirs. */
function LicensesLink({ icon = false }: { icon?: boolean }) {
  const { t } = useSaaSPreferences();
  return <a href={LICENSES_URL} target="_blank" rel="noreferrer" title={t('打开开源许可（新窗口）', 'Open the open-source licenses in a new window')}>{icon && <Scale size={16}/>}{t('开源许可', 'Open-source licenses')}</a>;
}
const workspaceURL = (tenant?: string, canvas?: string) => {
  const query = new URLSearchParams();
  if (tenant) query.set('tenant', tenant);
  if (canvas) query.set('canvas', canvas);
  return '/' + (query.size ? '?' + query : '');
};
const navigate = (tenant?: string, canvas?: string) => navigateTo(workspaceURL(tenant, canvas));
/** A canvas page's 成果 view, kept in the address (?view=results) so a reload or a link opens it again. */
function canvasResultsOptions(tenantId: string, canvasId: string): CanvasResultsOptions {
  return {
    // Read when the canvas mounts (a remount after draft recovery must see the address as it is then).
    get initialView() { return new URLSearchParams(window.location.search).get('view') === 'results' ? 'results' : 'canvas'; },
    onViewChange: view => {
      const url = new URL(window.location.href);
      if (view === 'results') url.searchParams.set('view', 'results'); else url.searchParams.delete('view');
      history.replaceState(history.state, '', url.pathname + url.search + url.hash);
    },
    receipt: (final, names) => <CanvasRunReceipt tenantId={tenantId} canvasId={canvasId} final={final} names={names} />,
    studio: true,
  };
}
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
// Every page, signed in or not, can say that AwwO was updated after it opened and part of it is gone (staleBuild.ts),
// and can open the Academy, its tutorial videos (Academy.tsx).
export function SaaSApp() { return <SaaSPreferencesProvider><AcademyProvider><AuthenticatedApp /><StaleBuildNotice /></AcademyProvider></SaaSPreferencesProvider>; }
function AuthenticatedApp() {
  const { locale, t } = useSaaSPreferences();
  const [ssoReturn, setSSOReturn] = useState<SSOReturn | null>(() => readSSOReturn(location.search));
  // A sign-in error, an account link or a password reset holds its own screen, so a stored
  // invitation waits: a completed link or login restores it through onAuthenticated instead.
  const deferInviteRestore = useRef(ssoReturn !== null || new URLSearchParams(window.location.search).has('reset'));
  useEffect(() => { rememberPendingInvite(new URLSearchParams(window.location.search).get('invite')); }, []);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [loading, setLoading] = useState(true);
  const [resetToken] = useState(() => new URLSearchParams(window.location.search).get('reset'));
  useEffect(() => { if (resetToken) { const url = new URL(location.href); url.searchParams.delete('reset'); history.replaceState(null, '', url.pathname + url.search); } }, [resetToken]);
  useEffect(() => { if (ssoReturn) clearSSOReturnURL(); }, [ssoReturn]);
  const [failure, setFailure] = useState('');
  const [sessionEnded, setSessionEnded] = useState(false);
  useEffect(() => {
    const stop = onSessionEnded(() => setSessionEnded(true));
    return () => { stop(); trackSignedInSession(false); };
  }, []);
  const sessionRequestGeneration = useRef(0);
  const onAuthenticated = useCallback((value: Identity) => {
    // A completed login/link supersedes the initial session lookup, even if
    // that older request later returns another account or a service error.
    sessionRequestGeneration.current += 1;
    restorePendingInvite();
    trackSignedInSession(true);
    setSessionEnded(false);
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
    api<Identity>('/auth/me', { signal: controller.signal }).then(value => { if (current()) { if (!deferInviteRestore.current) restorePendingInvite(); trackSignedInSession(true); setIdentity(value); } })
      .catch(error => {
        if (!current()) return;
        if (!(error instanceof SaaSApiError && error.status === 401)) { setFailure(message(error)); return; }
        // Every sign-out path ends on a signed-out landing. A plain one forgets the stored
        // invitation, so the next person to sign in in this tab is not offered it.
        if (!deferInviteRestore.current && !new URLSearchParams(window.location.search).has('invite')) forgetPendingInvite();
      })
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
  return <AppearanceScope key={identity.user.id} userId={identity.user.id}><AccountPreferencesProvider userId={identity.user.id}>{sessionEnded && <SessionEndedNotice identity={identity} />}<SaaSOnboarding identity={identity}><PersonalEngineGate identity={identity} onProfile={onProfile}>{content}</PersonalEngineGate></SaaSOnboarding></AccountPreferencesProvider></AppearanceScope>;
}
/** The page stays as it is, so nothing typed is lost; leaving through sign-in keeps the unsaved-canvas warning. */
function SessionEndedNotice({ identity }: { identity: Identity }) {
  const { t } = useSaaSPreferences();
  const clawhunt = identity.authentication === 'clawhunt';
  return <div className="saas-session-ended" role="alert">
    <p>{t('登录已失效，页面已停止自动更新。本机草稿仍保留，重新登录后即可继续。', 'Your session has ended, so this page stopped updating. Local drafts are kept; sign in again to continue.')}</p>
    <a className="saas-sso-action" href={clawhunt ? clawHuntStartURL(location.search) : '/'}>{clawhunt ? t('使用 ClawHunt 账号继续', 'Continue with ClawHunt') : t('重新登录', 'Sign in again')}</a>
  </div>;
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
  waitlisted: ['这个 ClawHunt 账号还未开通 AwwO。使用邀请码兑换后即可直接进入；没有邀请码也可以在兑换页加入候补名单。', "This ClawHunt account doesn't have AwwO access yet. Redeem an invite code to enter right away, or join the waitlist on the redemption page."],
  expired: ['登录请求已过期。请重新使用 ClawHunt 账号继续。', 'The sign-in request expired. Continue with ClawHunt again.'],
  unavailable: ['暂时无法完成统一登录。请稍后重试。', 'Unified sign-in is temporarily unavailable. Please try again.'],
  conflict: ['此账号关联存在冲突，尚未访问任何 AwwO 工作区。请联系管理员处理。', 'This account has a linking conflict. No AwwO workspace was opened. Contact an administrator.'],
  invalid_identity: ['无法验证 ClawHunt 账号身份。请返回主站确认账号状态后重试。', 'We could not verify your ClawHunt identity. Check your account on the main site and try again.'],
  // The server's opt-in sign-up limits refused a first sign-in: no account was created, and existing accounts are
  // never held by either limit.
  signup_limited: ['今天从你所在的网络新建的 AwwO 账号已达上限，这次没有创建账号。已有的 AwwO 账号不受影响，可以照常登录；新账号请在 UTC 次日再试。', 'Today’s limit on new AwwO accounts from your network has been reached, so no account was created. Existing AwwO accounts are not affected and can sign in as usual; try a new account again after the next UTC day.'],
  email_unverified: ['你的 ClawHunt 账号邮箱还没有验证，所以这次没有创建 AwwO 账号。请先在 ClawHunt 账号里验证邮箱，再回来用 ClawHunt 账号继续。', 'The email address of your ClawHunt account is not verified yet, so no AwwO account was created. Verify it in your ClawHunt account first, then continue with ClawHunt again.'],
};
function ssoFailureHeading(reason: SSOFailureReason, t: (zh: string, en: string) => string): string {
  if (reason === 'waitlisted') return t('用邀请码开通 AwwO', 'Unlock AwwO with an invite code');
  if (reason === 'signup_limited') return t('今天无法创建新账号', 'No new account today');
  if (reason === 'email_unverified') return t('请先验证邮箱', 'Verify your email first');
  return t('请检查登录状态', 'Check your sign-in');
}
function SSOFailure({ reason, signedIn = false }: { reason: SSOFailureReason; signedIn?: boolean }) {
  const { t, locale } = useSaaSPreferences();
  const { options } = useAuthOptions();
  const redeemURL = clawHuntRedeemURL(options?.clawhuntSiteURL);
  const accountURL = reason === 'email_unverified' ? clawHuntAccountURL(options?.clawhuntSiteURL) : null;
  return <main className="saas-login saas-sso-layout"><PreferenceControls /><div className="saas-login-brand"><span>AwwO</span><MainSiteLink /><h1>{t('账号连接未完成', 'Account connection not completed')}</h1></div>
    <section className="saas-card"><h2>{ssoFailureHeading(reason, t)}</h2><p role="alert">{ssoFailureCopy[reason][locale === 'zh' ? 0 : 1]}</p>
      {reason === 'waitlisted' && redeemURL && <a className="saas-primary saas-sso-action" href={redeemURL}>{t('输入邀请码进入 AwwO', 'Enter your invite code')}</a>}
      {accountURL && <a className="saas-primary saas-sso-action" href={accountURL}>{t('到 ClawHunt 验证邮箱', 'Verify your email on ClawHunt')}</a>}
      {reason !== 'waitlisted' && <a className={accountURL ? 'saas-sso-action' : 'saas-primary saas-sso-action'} href={clawHuntStartURL(location.search)}>{t('重新使用 ClawHunt 账号继续', 'Continue with ClawHunt again')}</a>}
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
  // Still loading: the boot surface the page opened on stays until there is something to show.
  if (!retry) return <BootSurface text={text} canvas={Boolean(new URLSearchParams(window.location.search).get('canvas'))} />;
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
  return <main className="saas-login"><PreferenceControls><AcademyLauncher variant="landing" /></PreferenceControls><div className="saas-login-brand"><span>AwwO</span><MainSiteLink /><h1>{t('让 Agent 在同一张画布上协作。', 'Bring your agents together on one canvas.')}</h1><p>{t('独立工作区、持久会话与实时执行。你的团队，从这里开始。', 'Separate workspaces, persistent conversations and live execution. Your team starts here.')}</p><LoginPreview /></div>
    {optionsError ? <section className="saas-card"><h2>{t('无法确认登录方式', 'Could not check sign-in methods')}</h2><p role="alert">{t('请检查网络连接后重试。', 'Check your connection and try again.')}</p><button onClick={retryOptions}>{t('重试', 'Retry')}</button></section>
    : !options ? <section className="saas-card" role="status">{t('正在读取登录方式…', 'Loading sign-in methods…')}</section>
    : <div className="saas-auth-choices">{options.clawhuntSSO === true && <section className="saas-card saas-sso-choice"><span className="saas-eyebrow">{t('统一账号', 'ONE ACCOUNT')}</span><h2>{t('使用 ClawHunt 登录 AwwO', 'Sign in to AwwO with ClawHunt')}</h2><p>{t('使用主站账号继续，保留已关联的工作区和个人执行引擎。', 'Continue with your main-site account and keep linked workspaces and personal engines.')}</p><a className="saas-primary saas-sso-action" href={clawHuntStartURL(location.search)}>{t('使用 ClawHunt 账号继续', 'Continue with ClawHunt')}</a><a className="saas-sso-signup" href={clawHuntStartURL(location.search, { signup: true })}>{t('没有账号？注册 ClawHunt 账号', 'New here? Create a ClawHunt account')}</a><small>{t('还没开通 AwwO？注册或登录后会弹出邀请码输入框，输入后即可进入。', 'No access yet? After you sign up or sign in, a box asks for your invite code and you go straight in.')}</small></section>}
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
    </div>}<ProductionCases />
    <footer className="saas-login-footer"><LicensesLink /></footer></main>;
}
function Workspace({ identity, onProfile }: { identity: Identity; onProfile: (name: string) => void }) {
  const { t } = useSaaSPreferences();
  const params = new URLSearchParams(window.location.search);
  const requested = params.get('tenant');
  const tenant = identity.tenants.find(item => item.id === requested) || (!requested ? identity.tenants.find(item => item.status === 'active') || identity.tenants[0] : undefined);
  const canvasId = params.get('canvas');
  const controls = <WorkspaceControls key={tenant?.id || 'none'} identity={identity} tenant={tenant} onProfile={onProfile} />;
  // The home pages' top bar has the Academy's button too; a canvas page's header keeps it in More options.
  const homeControls = <WorkspaceControls key={tenant?.id || 'none'} identity={identity} tenant={tenant} onProfile={onProfile} academy />;
  if (!tenant || tenant.status !== 'active') return <main className="saas-dashboard"><header><a href="/" className="saas-logo">AwwO</a>{homeControls}</header><section className="saas-page-intro"><h1>{tenant ? t('工作区已暂停', 'Workspace suspended') : t('选择工作区', 'Choose a workspace')}</h1><p role="status">{tenant ? t('你可以切换其他工作区，或联系工作区管理员恢复访问。', 'Switch to another workspace or contact its administrator to restore access.') : requested ? t('你无权访问这个工作区，请切换其他工作区。', 'You cannot access this workspace. Choose another one.') : t('账号尚未加入工作区。可以新建工作区，或请所有者发送邀请链接。', 'You have not joined a workspace. Create one or ask its owner for an invitation.')}</p>{identity.user.platformRole === 'admin' && <a href="/admin">{t('进入平台管理', 'Open platform administration')}</a>}</section></main>;
  const readOnly = tenant.role === 'reader';
  if (canvasId) return readOnly ? <ReadOnlyCanvas key={tenant.id + canvasId} identity={identity} tenant={tenant} canvasId={canvasId} controls={controls} /> : <CloudCanvas key={tenant.id + canvasId} identity={identity} tenant={tenant} canvasId={canvasId} controls={controls} />;
  return <main className="saas-dashboard saas-home"><header><a href="/" className="saas-logo">AwwO</a>{homeControls}</header>
    <WorkspaceHome key={identity.user.id + ':' + tenant.id + ':' + tenant.role} identity={identity} tenant={tenant} onOpen={id => navigate(tenant.id, id)} />
  </main>;
}
function WorkspaceControls({ identity, tenant, onProfile, academy = false }: { identity: Identity; tenant?: Tenant; onProfile: (name: string) => void; academy?: boolean }) {
  const { locale, t } = useSaaSPreferences();
  const [error, setError] = useState('');
  const [managementTenant, setManagementTenant] = useState<string | null>(tenant?.id || null);
  const [creatingWorkspace, setCreatingWorkspace] = useState(() => new URLSearchParams(window.location.search).get('createWorkspace') === '1');
  const accountApi = useMemo(() => createSaaSAccountApi(onProfile), [identity.user.id, onProfile]);
  return <div className="saas-account-actions" data-onboarding="workspace-actions">
    {tenant && tenant.status === 'active' && <RouteUsageMeter key={tenant.id} tenantId={tenant.id} />}
    {identity.tenants.length > 0 && <select aria-label={t('切换工作区', 'Switch workspace')} value={tenant?.id || ''} onChange={event => navigate(event.target.value)}>{!tenant && <option value="" disabled>{t('选择工作区', 'Choose a workspace')}</option>}{identity.tenants.map(item => <option key={item.id} value={item.id}>{item.name}{item.status !== 'active' ? t('（已暂停）', ' (suspended)') : ''}</option>)}</select>}
    {identity.personalCredentialsRequired && <a data-onboarding="engine-link" href={accountURL('engines')}>{t('我的引擎', 'My engines')}</a>}
    <CanvasAccountControl locale={locale} identity={null} onLogin={() => {}} onLogout={() => {}} onOpenWorkspaceAuth={() => navigate()}
      workspace={{ displayName: identity.user.name, selectedCompanyId: managementTenant, onCompanyChange: setManagementTenant, api: accountApi,
        ...(identity.authentication === 'clawhunt' ? { externalProfile: { url: clawHuntAccountURL(identity.clawhuntSiteURL) || undefined, invitesUrl: accountURL('invites'), plansUrl: accountURL('plans') } } : {}) }} />
    {academy && <AcademyLauncher />}
    <ThemePicker />
    <ActionMenu label={t('更多选项', 'More options')}>{close => <>
      <a href={accountURL('general')}><Settings2 size={16}/>{t('设置', 'Settings')}</a>
      <LanguageSwitch variant="menu" />
      <UiModeSwitch onSwitched={close} />
      <AcademyLauncher variant="menu" onLaunch={close} /><TutorialLauncher onLaunch={close} /><GuideLauncher onLaunch={close} /><MainSiteLink />
      <LicensesLink icon />
      <button className="saas-create-workspace-trigger" onClick={() => { close(); setCreatingWorkspace(true); }}><Plus size={16}/>{t('新建工作区', 'Create workspace')}</button>
      {identity.authentication === 'clawhunt' && <a href={accountURL('invites')}><Gift size={16}/>{t('邀请好友', 'Invite friends')}</a>}
      <a href={accountURL('security')}><KeyRound size={16}/>{t('账号安全', 'Security')}</a>
      {identity.user.platformRole === 'admin' && <a href="/admin"><ShieldCheck size={17}/>{t('平台管理', 'Administration')}</a>}
    <button title={t('退出登录', 'Sign out')} aria-label={t('退出登录', 'Sign out')} onClick={async () => {
      const failure = await signOut(identity, t);
      if (failure) setError(failure);
    }}><LogOut size={16}/><span>{t('退出登录', 'Sign out')}</span></button>
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
  const { locale, t, uiMode } = useSaaSPreferences();
  // A viewer can review the canvas's tasks in the assistant but not start or answer one.
  const execution = useManagedExecution(tenant.id, canvasId, { readOnly: true });
  const resultsView = useMemo(() => canvasResultsOptions(tenant.id, canvasId), [tenant.id, canvasId]);
  const [record, setRecord] = useState<CanvasRecord | null>(null);
  const [error, setError] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const runtimeReader = useRef(createCanvasRuntimeReader()).current;
  useEffect(() => {
    const controller = new AbortController(); configureSaaSCanvasSave(null);
    api<CanvasRecord>(tenantPath(tenant.id, '/canvases/' + encodeURIComponent(canvasId)), { signal: controller.signal }).then(value => {
      if (controller.signal.aborted) return;
      // A separate viewer cache never overwrites the same user's editable draft after a role change. A reader's copy is
      // only the server's document handed to the surface, so it stays in this page's memory: it takes no browser storage.
      configureCanvasStorage(identity.user.id, tenant.id, canvasId + '/read-only');
      openCanvasStorageInMemory(identity.user.id, tenant.id, canvasId + '/read-only');
      // A reader-only account opens no editable canvas: move what earlier releases left from here too.
      void canvasStoreUsable().then(usable => { if (usable) sweepLegacyCanvasStorage(canvasStoragePrefix(identity.user.id, tenant.id, canvasId + '/read-only')); });
      canvasStorage().setItem(CANVAS_STORAGE_KEY, JSON.stringify(sanitizeDocument(value.document)));
      configureSaaSCanvas({ tenant, canvasId }); setRecord(value);
    }).catch(error => { if (!controller.signal.aborted) setError(message(error)); });
    return () => { controller.abort(); clearSaaSCanvas(); configureSaaSCanvasSave(null); };
  }, [identity.user.id, tenant.id, canvasId]);
  if (!record) return error
    ? <main className="saas-dashboard"><CanvasPageHeader tenantId={tenant.id} controls={controls} /><p role="alert">{saasErrorMessage(error, locale)}</p></main>
    : <main className="saas-canvas-loading"><BootSurface canvas text={t('正在加载云端画布…', 'Loading cloud canvas…')} /><CanvasPageHeader tenantId={tenant.id} controls={controls} /></main>;
  return <div className="saas-canvas-shell">
    <CanvasSurface readOnly storageMode="cloud" workspaceName={tenant.name} workspaceCaption={t('云端工作区', 'Cloud workspace')} runtimeReadJson={runtimeReader} accountControl={controls} onOpenSettings={() => setSettingsOpen(true)}
      headerTitle={<CanvasTitle tenant={tenant} name={record.name} tone="readonly" status={<><Eye size={12} aria-hidden="true" /><span title={t('只读视图：可浏览原画布及会话，不能编辑或运行。', 'Read-only: browse the original canvas and conversations. Editing and execution are disabled.')}>{t('只读', 'Read-only')}</span><span className="saas-visually-hidden">{t('只读视图：可浏览原画布及会话，不能编辑或运行。', 'Read-only: browse the original canvas and conversations. Editing and execution are disabled.')}</span></>} />}
      canvasTools={uiMode === 'developer' ? <CanvasKnowledgeDock tenantId={tenant.id} canvasId={canvasId} readOnly extraTools={<CanvasLibraryTools tenantId={tenant.id} canvasId={canvasId} readOnly />} /> : undefined}
      assistantExecution={executionHost(execution)}
      results={resultsView}
      headerActions={<div className="saas-canvas-doc-actions"><UiModeSwitch variant="pill" />{uiMode === 'developer' && <><GraphRunPanel tenantId={tenant.id} canvasId={canvasId} readOnly /><button type="button" className="saas-icon-action" aria-label={t('导出画布 JSON', 'Export canvas JSON')} title={t('导出画布 JSON', 'Export canvas JSON')} onClick={() => downloadDocument(record.document, record.name + '.json')}><Download size={16} aria-hidden="true" /></button></>}</div>} />
    {settingsOpen && <RuntimeSettings tenantId={tenant.id} personalCredentialsRequired={identity.personalCredentialsRequired === true} onClose={() => setSettingsOpen(false)} />}
  </div>;
}

type CloudRuntimeStatus = { configured: boolean; available: boolean; reason?: string; models?: unknown[] };
const unavailableRuntimeStatus = (): CloudRuntimeStatus => ({ configured: false, available: false, reason: 'Runtime status unavailable' });
function readCloudRuntimeStatus(value: unknown): CloudRuntimeStatus {
  if (!value || typeof value !== 'object') return unavailableRuntimeStatus();
  const status = value as Record<string, unknown>;
  if (typeof status.configured !== 'boolean' || typeof status.available !== 'boolean'
    || (status.reason !== undefined && typeof status.reason !== 'string')
    || (status.models !== undefined && !Array.isArray(status.models))) return unavailableRuntimeStatus();
  return { configured: status.configured, available: status.available && status.configured,
    reason: status.reason as string | undefined, models: status.models as unknown[] | undefined };
}

function CloudCanvas({ identity, tenant, canvasId, controls }: { identity: Identity; tenant: Tenant; canvasId: string; controls: React.ReactNode }) {
  const { locale, t, uiMode } = useSaaSPreferences();
  // The canvas assistant's tasks; the canvas has the service read once it opens, so routing knows whether one can start.
  const execution = useManagedExecution(tenant.id, canvasId, { userId: identity.user.id });
  // The server decides whether each assistant message arranges the canvas or becomes a task.
  const routeAssistant = useCallback<RouteAssistant>((request, signal) => routeAssistantMessage(tenant.id, canvasId, request, signal), [tenant.id, canvasId]);
  const resultsView = useMemo(() => canvasResultsOptions(tenant.id, canvasId), [tenant.id, canvasId]);
  const localDraftFailure = (error: unknown) => isCanvasStorageQuotaError(error)
    ? t('本机存储空间已满，自动保存已暂停。请先导出本地副本保留最新编辑。', 'Local browser storage is full. Autosave is paused. Export a local copy to preserve your latest edits.')
    : `本机草稿保存失败：${message(error)}。请立即导出本地副本。`;
  const [record, setRecord] = useState<CanvasRecord | null>(null);
  const [error, setError] = useState('');
  const [saveState, setSaveState] = useState('正在加载…');
  const [runtime, setRuntime] = useState<CloudRuntimeStatus | null>(null);
  const [runtimeChecking, setRuntimeChecking] = useState(false);
  const runtimeRequest = useRef<AbortController | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [recovery, setRecovery] = useState<SavedCanvasDraft[] | null>(null);
  const [localDraftCount, setLocalDraftCount] = useState(0);
  const [manualRecovery, setManualRecovery] = useState(false);
  // A request typed on the workspace home for this canvas, handed to the surface to plan once.
  const [initialPlan, setInitialPlan] = useState<InitialPlanRequest | null>(null);
  const [knowledgeTaskDraft, setKnowledgeTaskDraft] = useState<CanvasTaskDraft | null>(null);
  const current = useRef<CanvasRecord | null>(null);
  const pending = useRef<CanvasDocument | null>(null);
  const writerId = useRef(crypto.randomUUID()).current;
  const draft = useRef<CanvasDraft | null>(null);
  // The save this page has out (or had, when its reply never came), recorded in the drafts written meanwhile.
  const sending = useRef<CanvasDraftSending | null>(null);
  // No other tab had the canvas open when this page opened it: the pages that wrote the drafts it found have closed.
  const alone = useRef(false);
  const restoredSource = useRef<SavedCanvasDraft | null>(null);
  const scopedStorage = useRef<ReturnType<typeof canvasStorage> | null>(null);
  const saving = useRef(false);
  const failed = useRef(false);
  const runtimeReader = useRef(createCanvasRuntimeReader()).current;
  const localDocumentSaveFailed = useCallback((document: CanvasDocument) => {
    pending.current = document;
    failed.current = true;
    setSaveState('未同步');
    setError(t('本机无法保存最新编辑，自动保存已暂停。请先导出本地副本，保留当前页面中的修改。',
      'Your latest edits could not be saved on this device. Autosave is paused. Export a local copy to preserve the changes in this page.'));
  }, [t]);
  useEffect(() => {
    setRuntime(null); setRuntimeChecking(false);
    return () => {
      const request = runtimeRequest.current;
      runtimeRequest.current = null;
      request?.abort();
    };
  }, [identity.user.id, tenant.id, canvasId]);
  const recheckRuntime = useCallback(async () => {
    if (runtimeRequest.current) return;
    const controller = new AbortController();
    runtimeRequest.current = controller;
    setRuntimeChecking(true);
    try {
      const health = await api<unknown>(tenantPath(tenant.id, '/runtime'), { signal: controller.signal });
      if (!controller.signal.aborted && runtimeRequest.current === controller) setRuntime(readCloudRuntimeStatus(health));
    } catch {
      if (!controller.signal.aborted && runtimeRequest.current === controller) setRuntime(unavailableRuntimeStatus());
    } finally {
      if (runtimeRequest.current === controller) {
        runtimeRequest.current = null;
        if (!controller.signal.aborted) setRuntimeChecking(false);
      }
    }
  }, [identity.user.id, tenant.id, canvasId]);
  useEffect(() => {
    const controller = new AbortController();
    configureCanvasStorage(identity.user.id, tenant.id, canvasId);
    const storage = canvasStorage(); scopedStorage.current = storage;
    // The canvas's own storage is read before anything uses it: IndexedDB (asked twice, for a momentary refusal), or
    // localStorage where the browser has none.
    alone.current = false;
    const opened = openCanvasStorage(identity.user.id, tenant.id, canvasId)
      .catch(() => openCanvasStorage(identity.user.id, tenant.id, canvasId))
      .then(async mode => {
        if (controller.signal.aborted) return null;
        // With no other tab on this canvas, the pages that wrote the drafts found here have closed.
        const others = mode === 'store' ? await canvasStore().otherTabs(canvasStoragePrefix(identity.user.id, tenant.id, canvasId)).catch(() => null) : null;
        if (controller.signal.aborted) return null;
        alone.current = others === 0;
        const saved = readCanvasDrafts(storage);
        setLocalDraftCount(saved.length);
        // Offered at once, before the cloud's version comes, unless the opening may still find that a draft is the
        // cloud's own document (alone): then settle decides with it, and a failed read offers them without it.
        if (!alone.current && unreviewedCanvasDrafts(storage, saved).length) setRecovery(saved);
        if (mode === 'store') sweepLegacyCanvasStorage(canvasStoragePrefix(identity.user.id, tenant.id, canvasId));
        return mode;
      })
      .catch(error => { if (!controller.signal.aborted) setError(`无法读取本机草稿：${message(error)}`); return null; });
    // Canvas data stays available when the separate runtime-status request fails.
    // Its failure disables execution until an explicit status check confirms readiness.
    Promise.all([opened, api<CanvasRecord>(tenantPath(tenant.id, `/canvases/${encodeURIComponent(canvasId)}`), { signal: controller.signal }),
      api<unknown>(tenantPath(tenant.id, '/runtime'), { signal: controller.signal })
        .then(readCloudRuntimeStatus).catch(unavailableRuntimeStatus)])
      .then(async ([mode, value, health]) => {
        if (mode === null || controller.signal.aborted) return;
        configureSaaSCanvas({ tenant, canvasId });
        let hasJournal = false;
        const settle = () => {
          let saved = readCanvasDrafts(storage);
          // A draft holding exactly the cloud's document has nothing left to send: its page's last save was stored after
          // the page closed.
          if (alone.current && saved.some(each => each.draft)) {
            const cloud = canonicalCanvasDocumentJSON(value.document);
            const synced = saved.filter(each => each.draft && canonicalCanvasDocumentJSON(each.draft.document) === cloud);
            for (const each of synced) removeCanvasDraft(storage, each);
            if (synced.length) saved = readCanvasDrafts(storage);
          }
          const cached = storage.getItem(CANVAS_STORAGE_KEY);
          const baseVersion = Number(storage.getItem('awwo.cloud.version'));
          const rawJournal = storage.getItem(CANVAS_RUN_JOURNAL_KEY);
          // Any lane's run counts: several components may have been running when this page was last open.
          hasJournal = Boolean(loadRunJournal(storage)) || loadLaneJournals(storage).length > 0;
          if (rawJournal && !loadRunJournal(storage)) storage.setItem(`${CANVAS_RUN_JOURNAL_KEY}.corrupt.${Date.now()}`, rawJournal);
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
        };
        // Where the browser has no IndexedDB, a full localStorage must not take the canvas down: its copy moves to this
        // page's memory, and autosave pauses behind the warning an edit that could not be kept on this device shows (also
        // when the canvas is opened again in this page: its copy is still in memory only).
        let storageFull: unknown = mode === 'memory' ? new DOMException('Local storage is full', 'QuotaExceededError') : null;
        try { settle(); }
        catch (error) {
          if (mode !== 'local' || !isCanvasStorageQuotaError(error)) throw error;
          openCanvasStorageInMemory(identity.user.id, tenant.id, canvasId, true);
          storageFull = error;
          settle();
        }
        if (!hasJournal) {
          // Cloud execution is discoverable on another browser/device. Local journals are
          // an observation cache; the server owns accepted task and dependency state.
          try {
            const graphs = await api<{ items: GraphRunSnapshot[] }>(graphPath(tenant.id, canvasId), { signal: controller.signal });
            const items = graphs.items ?? [];
            const latest = items[0];
            // Every graph still running (components run side by side, each in its own lane), and the latest one if it
            // finished with a result this page has not published yet.
            const candidates = [...items.filter(graphIsActive), ...(latest && !graphIsActive(latest) ? [latest] : [])].slice(0, MAX_RUN_LANES);
            let nextLane = 0;
            for (const graph of candidates) {
              if (controller.signal.aborted) break;
              const document = sanitizeDocument(value.document);
              const recovered = graphRecoveryJournal(graph, tenant.id, document);
              const inputsMatch = recovered.inputFingerprint === runInputFingerprint(document, recovered.scope);
              // Only a result the recovery would publish counts. Outside a collaboration the server records every
              // waiting, blocked or reused step with an empty output; counting that as missing re-recovered an
              // applied run on every open.
              const superseded = supersededGraphNodes(document, graph);
              const unpublished = recovered.scope.some(id => {
                const item = recovered.nodes[id];
                const output = item ? recoverableOutput(recovered, item) : null;
                const shown = document.nodes.find(node => node.id === id)?.lastOutput;
                // This graph was admitted from a version that did not include the revision.
                if (superseded.has(id)) return false;
                return output !== null && shown?.text !== output;
              });
              if (!graphIsActive(graph) && !(inputsMatch && unpublished)) continue;
              const lane = nextLane++;
              await withLaneOwnership(lane, async () => {
                // Another tab may have started a newer operation while discovery was pending.
                // Share its execution lock and preserve any journal written in the meantime.
                const target = laneStorage(lane, storage);
                if (controller.signal.aborted || loadRunJournal(target)) return;
                saveRunJournal(recovered, target);
              }, () => {});
            }
          } catch { /* The run panel shows connectivity errors; backend admission prevents overlap. */ }
        }
        if (controller.signal.aborted) return;
        current.current = value; setRuntime(health); setRecord(value);
        if (storageFull) { failed.current = true; setSaveState('未同步'); setError(localDraftFailure(storageFull)); }
      }).catch(async error => {
        if (controller.signal.aborted) return;
        setError(message(error));
        // The drafts an opening alone held back for the cloud's document are offered without it.
        if ((await opened) === null || controller.signal.aborted || !alone.current) return;
        try { const saved = readCanvasDrafts(storage); if (unreviewedCanvasDrafts(storage, saved).length) setRecovery(saved); }
        catch { /* The error stands. */ }
      });
    return () => { controller.abort(); clearSaaSCanvas(); };
  }, [identity.user.id, tenant.id, canvasId, writerId]);
  // IndexedDB refusing this canvas's writes (a full disk) pauses autosave behind the same warning a full localStorage did.
  useEffect(() => canvasStore().onFailure((error, prefixes) => {
    if (!prefixes.includes(canvasStoragePrefix(identity.user.id, tenant.id, canvasId))) return;
    failed.current = true; setSaveState('未同步'); setError(localDraftFailure(error));
  }), [identity.user.id, tenant.id, canvasId, t]);

  useEffect(() => {
    if (!record || recovery || !scopedStorage.current) return;
    const storage = scopedStorage.current;
    const cacheKey = canvasStorageKey(CANVAS_STORAGE_KEY);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    const setupAbort = new AbortController();
    let initializationQueue: Promise<unknown> = Promise.resolve();
    const pace = autosavePace();
    // Autosave goes when the pace lets it (autosavePace.ts): a held pointer or a burst of writes still going puts it off.
    const later = (delay: number) => {
      clearTimeout(timer);
      timer = setTimeout(function due() {
        const wait = pace.wait();
        if (wait > 0) { timer = setTimeout(due, wait); return; }
        void flush(true).catch(() => {});
      }, delay);
    };
    const flush = async (autosave = false) => {
      while (saving.current && !disposed) await new Promise(resolve => setTimeout(resolve, 20));
      if (failed.current || disposed) throw new Error('画布未同步，请先解决保存错误再运行。');
      if (!current.current || !pending.current) return current.current?.version;
      saving.current = true;
      let busyRetries = 0;
      let retrying = false;
      try {
        while (pending.current && !failed.current && !disposed) {
          // An edit made while autosave's last save was out goes once its own burst is over, as the first one did; a run
          // or a node setup sends it at once, and so does a save the API answered busy (its turns are counted here).
          if (autosave && !retrying && pace.wait() > 0) { later(pace.wait()); break; }
          retrying = false;
          const pendingDocument = pending.current;
          const pendingCanonical = canonicalCanvasDocumentJSON(pendingDocument);
          // An editor may re-publish the same snapshot while its previous PUT is in flight.
          // Once that PUT is acknowledged, the newer draft has no unsent change; do not
          // advance the cloud version again or discard a genuinely different pending edit.
          if (!restoredSource.current && pendingCanonical === canonicalCanvasDocumentJSON(current.current!.document)) {
            try {
              const redundant = draft.current;
              if (redundant) acknowledgeCanvasDraft(storage, redundant, current.current!.version);
              pending.current = null;
              draft.current = null;
              if (!disposed) setSaveState('已同步');
            } catch (error) {
              failed.current = true;
              if (!disposed) { setSaveState('未同步'); setError(localDraftFailure(error)); }
            }
            break;
          }
          const sent: CanvasDraft = draft.current || persistCanvasDraft(storage, writerId, current.current!.version, pendingDocument);
          const document: CanvasDocument = sent.document; pending.current = null; pace.sent();
          // Drafts written while this save is out record what it sends (CanvasDraft.sending).
          sending.current = { baseVersion: current.current!.version,
            hash: canvasDocumentHash(document, document === pendingDocument ? pendingCanonical : undefined) };
          setSaveState('正在保存…');
          let serverConfirmed = false;
          try {
            const saved: CanvasRecord | null = await api<CanvasRecord | null>(tenantPath(tenant.id, `/canvases/${encodeURIComponent(canvasId)}`), { method: 'PUT', body: JSON.stringify({ name: current.current!.name, document, version: current.current!.version }) });
            // A reply without the saved canvas confirms nothing: the edit stays unsynced.
            if (!saved || !Number.isSafeInteger(saved.version)) throw new SaaSApiError(502, 'empty_reply', t('服务器没有返回保存结果', 'The server did not return the saved canvas'));
            serverConfirmed = true;
            // Release this page's confirmed revision before writing a full baseline.
            // Other writers' drafts remain untouched: Storage cannot atomically compare/delete them.
            acknowledgeCanvasDraft(storage, sent, saved.version);
            rememberCanvasBaseline(storage, saved.version, saved.document);
            if (restoredSource.current) { removeCanvasDraft(storage, restoredSource.current); restoredSource.current = null; }
            if (!disposed) { try { setLocalDraftCount(readCanvasDrafts(storage).length); } catch { /* Draft count is decorative; save acknowledgement remains authoritative. */ } }
            if (draft.current?.revision === sent.revision) draft.current = null;
            else if (draft.current) draft.current = { ...draft.current, baseVersion: saved.version, sending: undefined };
            // The save is no longer out once this page's drafts build on it (a failure above leaves the record standing).
            current.current = saved; busyRetries = 0; sending.current = null;
            storage.setItem('awwo.cloud.version', String(Math.max(saved.version, Number(storage.getItem('awwo.cloud.version')) || 0)));
            if (!disposed) setSaveState(failed.current ? '未同步' : pending.current ? '等待同步…' : '已同步');
          } catch (error) {
            // The API had no free save slot: the same edit goes again shortly, a few times, before it counts as failed.
            if (!serverConfirmed && error instanceof SaaSApiError && error.status === 503 && error.code === 'canvas_save_busy' && busyRetries < 3) {
              busyRetries += 1; pending.current ||= document;
              if (!disposed) setSaveState('等待同步…');
              await new Promise(resolve => setTimeout(resolve, 2000));
              retrying = true;
              continue;
            }
            const alreadyFailed = failed.current;
            failed.current = true; pending.current ||= document;
            if (!disposed) {
              setSaveState('未同步');
              // A newer local save failure means pending may exist only in memory.
              // Do not replace its export warning with a claim that all edits are on disk.
              if (!alreadyFailed) setError(serverConfirmed || isCanvasStorageQuotaError(error) ? localDraftFailure(error)
                : error instanceof SaaSApiError && error.status === 409 ? '画布已在另一页面更新。未同步草稿已独立保存在本机，重新加载后可恢复或导出，不会覆盖云端版本。'
                : error instanceof SaaSApiError && error.status === 413 ? t('画布超过 8 MB 的单次保存上限，未同步的修改保留在本机。删掉不再需要的节点输出或拆分画布后，重新加载再保存。', 'This canvas is over the 8 MB save limit. Unsynced changes stay on this device. Remove node outputs you no longer need or split the canvas, then reload and save again.')
                : `保存失败：${message(error)}。未同步草稿保留在本机，重新加载后可恢复或导出。`);
            }
          }
        }
      } finally { saving.current = false; }
      if (failed.current) throw new Error('画布未同步，请先解决保存错误再运行。');
    };
    const observe = (event: Event) => {
      if ((event as CustomEvent).detail?.storageKey !== cacheKey) return;
      let size = 0;
      try {
        const raw = storage.getItem(CANVAS_STORAGE_KEY) || '{}'; size = raw.length;
        const document: CanvasDocument = JSON.parse(raw);
        if (!pending.current && !draft.current && canonicalCanvasDocumentJSON(document) === canonicalCanvasDocumentJSON(current.current!.document)) return;
        pending.current = document;
        draft.current = persistCanvasDraft(storage, writerId, current.current!.version, pending.current!, sending.current);
      } catch (error) {
        failed.current = true; setSaveState('未同步'); setError(localDraftFailure(error)); return;
      }
      setSaveState('等待同步…'); later(pace.wrote(size));
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
    if (pending.current) later(AUTOSAVE_QUIET_MS);
    return () => { disposed = true; setupAbort.abort(); configureSaaSCanvasSave(null); configureSaaSCanvasInitialize(null); clearTimeout(timer); pace.dispose(); window.removeEventListener('awwo:canvas-cache-write', observe); window.removeEventListener('beforeunload', leave); };
  }, [record, recovery, tenant.id, canvasId, writerId]);
  // The cloud document's hash for the recovery, once per version: a big canvas's takes a moment.
  const cloudHash = useMemo(() => { let hash: string | null = null; return () => hash ??= canvasDocumentHash(record?.document); }, [record]);
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
      if ((storage.getItem(CANVAS_RUN_JOURNAL_KEY) || loadLaneJournals(storage).length) && cached) {
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
    closed={alone.current} cloudHash={cloudHash}
    hasJournal={Boolean(scopedStorage.current && (loadRunJournal(scopedStorage.current) || loadLaneJournals(scopedStorage.current).length))} manual={manualRecovery} onUseCloud={() => useCloud()}
    onRestore={saved => {
      // Onto its own base, or onto the cloud version that is the save its page had out when it closed.
      const base = saved.draft && current.current
        ? restorableCanvasDraftBase(saved.draft, current.current, alone.current, current.current === record ? cloudHash : undefined) : null;
      if (!saved.draft || base === null) return;
      const storage = scopedStorage.current!;
      try {
        if (storage.getItem(saved.key) !== saved.raw) {
          const latest = readCanvasDrafts(storage);
          setLocalDraftCount(latest.length); setRecovery(latest); setManualRecovery(false);
          setError('草稿状态刚被另一个页面更新，请重新连接后核对。');
          return;
        }
        draft.current = persistCanvasDraft(storage, writerId, base, saved.draft.document);
        restoredSource.current = saved; pending.current = saved.draft.document;
        storage.setItem(CANVAS_STORAGE_KEY, JSON.stringify(saved.draft.document));
        storage.setItem('awwo.cloud.version', String(base));
        setError(''); setRecovery(null); setSaveState('已恢复草稿，等待同步…');
      } catch (error) { setError(`无法恢复草稿：${message(error)}`); }
    }} onDiscard={saved => {
      const storage = scopedStorage.current!;
      if (!removeCanvasDraft(storage, saved)) { const remaining = readCanvasDrafts(storage); if (remaining.length) setRecovery(remaining); setError('草稿状态刚被另一个页面更新，请重新连接后核对。'); return; }
      const remaining = readCanvasDrafts(storage);
      setLocalDraftCount(remaining.length);
      if (remaining.length) setRecovery(remaining); else useCloud(remaining);
    }} />;
  if (!record) return error
    ? <main className="saas-dashboard"><CanvasPageHeader tenantId={tenant.id} controls={controls} /><section className="saas-page-intro"><p role="alert">{saasErrorMessage(error, locale)}</p><button onClick={() => window.location.reload()}>{t('重新连接', 'Reconnect')}</button></section></main>
    : <main className="saas-canvas-loading"><BootSurface canvas text={t('正在加载云端画布…', 'Loading cloud canvas…')} /><CanvasPageHeader tenantId={tenant.id} controls={controls} /></main>;
  const exportLocal = () => {
    const latest = pending.current ?? draft.current?.document;
    const bytes = latest ? JSON.stringify(latest) : scopedStorage.current?.getItem(CANVAS_STORAGE_KEY) || '{}';
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/json' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'awwo-canvas-recovery.json'; anchor.click(); URL.revokeObjectURL(url);
  };
  const executionUnavailableReason = runtime === null
    ? t('正在检查执行引擎…', 'Checking the execution engine…')
    : runtime.available === true && !runtime.reason && Array.isArray(runtime.models) && runtime.models.length > 0
      ? undefined
      : runtime.reason
        ? saasErrorMessage(runtime.reason, locale)
        : t('当前没有可用的执行引擎。', 'No execution engine is currently available.');
  const syncTone = saveState === '已同步' ? 'synced' : saveState === '未同步' || saveState === '存在未同步草稿' ? 'warning' : 'pending';
  return <div className="saas-canvas-shell">
    {error && <div className="saas-error-banner" role="alert">{saasErrorMessage(error, locale)}<button onClick={exportLocal}>{t('导出本地副本', 'Export local copy')}</button><button onClick={() => window.location.reload()}>{t('重新加载', 'Reload')}</button></div>}
    {runtime && executionUnavailableReason && <div className="saas-runtime-note" role="status"><span>{t('执行尚未就绪：', 'Execution is not ready: ')}{executionUnavailableReason}{' '}{identity.personalCredentialsRequired && <a data-onboarding="engine-link" href={accountURL('engines')}>{t('我的引擎', 'My engines')}</a>}{' '}{t('画布编辑仍可使用。', 'Canvas editing remains available.')}</span><button type="button" disabled={runtimeChecking} onClick={() => void recheckRuntime()}>{runtimeChecking ? t('正在检查…', 'Checking…') : t('重新检查', 'Check again')}</button></div>}
    <CanvasSurface storageMode="cloud" personalCredentialsRequired={identity.personalCredentialsRequired === true} onLocalDocumentSaveFailed={localDocumentSaveFailed}
      executionUnavailableReason={executionUnavailableReason} initialPlan={initialPlan}
      taskDraft={knowledgeTaskDraft} canvasTools={uiMode === 'developer' ? <CanvasKnowledgeDock tenantId={tenant.id} canvasId={canvasId} onTaskDraft={setKnowledgeTaskDraft} extraTools={<CanvasLibraryTools tenantId={tenant.id} canvasId={canvasId} />} />
        : <CanvasWebReader tenantId={tenant.id} canvasId={canvasId} onTaskDraft={setKnowledgeTaskDraft} />}
      assistantExecution={executionHost(execution)} routeAssistant={routeAssistant}
      results={resultsView}
      workspaceName={tenant.name} workspaceCaption={t('云端工作区', 'Cloud workspace')} runtimeReadJson={runtimeReader} accountControl={controls} onCreateCompany={() => window.location.assign('/?createWorkspace=1')} onOpenSettings={() => setSettingsOpen(true)}
      onWorkSettled={event => notifyTaskFinished(event.kind === 'plan'
        ? { title: event.failed ? t('画布规划没有完成', 'Canvas plan did not finish') : t('画布规划已完成', 'Canvas plan finished'), body: record.name, failed: event.failed }
        : { title: event.failed ? t('画布运行结束，有节点未完成', 'Canvas run ended with unfinished nodes') : t('画布运行已完成', 'Canvas run finished'), body: record.name, failed: event.failed })}
      headerTitle={<CanvasTitle tenant={tenant} name={record.name} tone={syncTone} status={<>{syncTone === 'synced' ? <Check size={12} aria-hidden="true" /> : <Save size={12} aria-hidden="true" />}<span>{({ '正在加载…': t('正在加载…', 'Loading…'), '存在未同步草稿': t('存在未同步草稿', 'Unsynced draft found'), '已同步': t('已同步', 'Synced'), '正在保存…': t('正在保存…', 'Saving…'), '等待同步…': t('等待同步…', 'Waiting to sync…'), '未同步': t('未同步', 'Not synced'), '已恢复草稿，等待同步…': t('已恢复草稿，等待同步…', 'Draft restored, waiting to sync…') }[saveState] || saveState)}</span></>} />}
      headerActions={<div className="saas-canvas-doc-actions"><UiModeSwitch variant="pill" />{uiMode === 'developer' && <GraphRunPanel tenantId={tenant.id} canvasId={canvasId} />}{localDraftCount > 0 && <button type="button" className="saas-local-drafts-action" aria-label={`${t('查看本机草稿', 'View local drafts')} (${localDraftCount})`} disabled={saveState !== '已同步'} onClick={() => {
        if (pending.current || saving.current || failed.current || !scopedStorage.current) return;
        const saved = readCanvasDrafts(scopedStorage.current);
        setLocalDraftCount(saved.length);
        if (saved.length) { setManualRecovery(true); setRecovery(saved); }
      }}><span className="saas-draft-desktop-label">{t('查看本机草稿', 'View local drafts')}</span><span className="saas-draft-mobile-label">{t('草稿', 'Drafts')}</span><span aria-hidden="true">({localDraftCount})</span></button>}{uiMode === 'developer' && <button type="button" className="saas-icon-action" aria-label={t('导出画布 JSON', 'Export canvas JSON')} title={t('导出画布 JSON', 'Export canvas JSON')} onClick={exportLocal}><Download size={16} aria-hidden="true" /></button>}</div>} />
    {settingsOpen && <RuntimeSettings tenantId={tenant.id} personalCredentialsRequired={identity.personalCredentialsRequired === true} onClose={() => setSettingsOpen(false)} />}
  </div>;
}

function DraftRecovery({ tenantId, controls, record, drafts, error, hasJournal, manual, closed, cloudHash, onRestore, onDiscard, onUseCloud }: {
  tenantId: string; controls: React.ReactNode; record: CanvasRecord | null; drafts: SavedCanvasDraft[]; error: string; hasJournal: boolean; manual: boolean;
  /** No other tab has the canvas open (see restorableCanvasDraftBase). */
  closed: boolean; cloudHash: () => string;
  onRestore: (saved: SavedCanvasDraft) => void; onDiscard: (saved: SavedCanvasDraft) => void; onUseCloud: () => void;
}) {
  const { locale, t } = useSaaSPreferences();
  const [selectedKey, setSelectedKey] = useState(drafts[0]?.key || '');
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const selected = drafts.find(saved => saved.key === selectedKey) || drafts[0];
  // An earlier release's cache kept for export has no known base version: never restored over the cloud.
  const restoreBase = record && selected?.draft ? restorableCanvasDraftBase(selected.draft, record, closed, cloudHash) : null;
  const canRestore = restoreBase !== null;
  if (!selected) return <main className="saas-dashboard"><CanvasPageHeader tenantId={tenantId} controls={controls} /><section className="saas-page-intro"><h1>{t('本机草稿已变化', 'Local drafts changed')}</h1><p role="alert" className="saas-error">{error ? saasErrorMessage(error, locale) : t('请重新连接云端后核对。', 'Reconnect to the cloud to review the latest version.')}</p><button onClick={() => window.location.reload()}>{t('重新连接云端', 'Reconnect to cloud')}</button></section></main>;
  return <main className="saas-dashboard"><CanvasPageHeader tenantId={tenantId} controls={controls} /><section className="saas-page-intro"><h1>{manual ? t('已保留的本机草稿', 'Saved local drafts') : t('发现未同步的本机草稿', 'Unsynced local drafts found')}</h1><p role="status">{manual ? t('草稿仍留在这台设备上，可导出核对；画布继续使用云端版本。', 'These drafts remain on this device for review or export. The canvas continues using the cloud version.') : t('本机修改已保留。确认如何处理后才会打开编辑器；重新加载不会丢弃草稿。', 'Your local changes are preserved. Choose how to handle them before opening the editor. Reloading will not discard drafts.')}</p></section>
    {error && <p className="saas-error" role="alert">{saasErrorMessage(error, locale)}</p>}
    <section className="saas-card saas-draft-recovery"><label>{t('选择本机草稿', 'Choose a local draft')}<select aria-label={t('选择本机草稿', 'Choose a local draft')} value={selected?.key || ''} onChange={event => { setSelectedKey(event.target.value); setConfirmDiscard(false); }}>{drafts.map((saved, index) => <option key={saved.key} value={saved.key}>{t('草稿', 'Draft')} {index + 1}{saved.draft ? ' · ' + new Date(saved.draft.updatedAt).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US') : t(' · 需要人工检查', ' · Manual inspection required')}</option>)}</select></label>
      {selected?.draft ? <><p>{t('草稿基于云端版本', 'Draft base version:')} {selected.draft.baseVersion}{t('；当前云端版本', '; current cloud version:')} {record?.version ?? t('读取中', 'loading')}{t('。', '.')}</p><p>{t('包含节点：', 'Nodes: ')}{selected.draft.document.nodes.map(node => node.title).join(', ') || t('空画布', 'Empty canvas')}</p>{selected.draft.legacyCache ? <p className="saas-error">{t('这是旧版本页面留在本机的画布副本，不知道它基于哪个云端版本。请导出后核对，它不会覆盖云端内容。', 'This is a copy of the canvas an earlier version of the page left on this device; the cloud version it was based on is not known. Export it to review it. It will not overwrite cloud content.')}</p>
        : record && !canRestore ? <p className="saas-error">{t('云端版本已有变化。请导出草稿后核对，当前草稿不会自动覆盖较新的云端内容。', 'The cloud version has changed. Export and review your draft. It will not automatically overwrite newer cloud content.')}</p>
        : restoreBase !== null && restoreBase !== selected.draft.baseVersion && <p>{t(`云端版本 ${restoreBase} 正是这个页面关闭前送出的保存，恢复会接着它继续同步。`, `Cloud version ${restoreBase} is the save this page sent before it closed. Restoring carries on from it.`)}</p>}</> : <p className="saas-error">{t('草稿格式无法自动恢复。原始内容仍可导出，尚未删除。', 'This draft format cannot be restored automatically. Its original content is preserved and can be exported.')}</p>}
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
