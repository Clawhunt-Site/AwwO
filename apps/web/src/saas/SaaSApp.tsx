import { SecretInput } from './SecretInput';
import { PersonalEngineGate, PasswordRecovery, accountURL } from './PersonalAccount';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LogOut, Plus, ArrowLeft, ShieldCheck, Save } from 'lucide-react';
import { api, tenantPath, SaaSApiError, saasErrorMessage, type Identity, type Tenant, type CanvasRecord } from './api';
import { configureSaaSCanvas, configureSaaSCanvasSave, configureSaaSCanvasInitialize, currentSaaSCanvas, clearSaaSCanvas } from './canvasBridge';
import { configureCanvasStorage, canvasStorage, canvasStorageKey } from '../canvas/canvasStorage';
import { CANVAS_DRAFT_PREFIX, persistCanvasDraft, readCanvasDrafts, removeCanvasDraft, acknowledgeCanvasDraft, rememberCanvasBaseline, isKnownSyncedCache, canonicalCanvasDocumentJSON, type CanvasDraft, type SavedCanvasDraft } from './canvasDraft';
import { CanvasSurface } from '../canvas/CanvasSurface';
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
import { CanvasList } from './CanvasList';
import { AppearanceScope } from './SaaSAppearance';
import { SaaSOnboarding, GuideLauncher, MainSiteLink } from './SaaSOnboarding';

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
  return <a className="saas-canvas-back" href={workspaceURL(tenantId)}><ArrowLeft size={14} aria-hidden="true" />{t('返回画布列表', 'Back to canvases')}</a>;
}
function CanvasPageHeader({ tenantId, controls }: { tenantId: string; controls: React.ReactNode }) {
  return <header className="saas-canvas-page-header"><div className="saas-canvas-page-navigation"><a href="/" className="saas-logo">AwwO</a><CanvasBackLink tenantId={tenantId} /></div>{controls}</header>;
}
export function SaaSApp() { return <SaaSPreferencesProvider><AuthenticatedApp /></SaaSPreferencesProvider>; }
function AuthenticatedApp() {
  const { locale, t } = useSaaSPreferences();
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [loading, setLoading] = useState(true);
  const [resetToken] = useState(() => new URLSearchParams(window.location.search).get('reset'));
  useEffect(() => { if (resetToken) { const url = new URL(location.href); url.searchParams.delete('reset'); history.replaceState(null, '', url.pathname + url.search); } }, [resetToken]);
  const [failure, setFailure] = useState('');
  const onProfile = useCallback((name: string) => setIdentity(current => current ? { ...current, user: { ...current.user, name } } : current), []);
  useEffect(() => {
    let live = true;
    api<Identity>('/auth/me').then(value => { if (live) setIdentity(value); })
      .catch(error => { if (live && !(error instanceof SaaSApiError && error.status === 401)) setFailure(message(error)); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, []);
  const inviteToken = new URLSearchParams(window.location.search).get('invite');
  if (resetToken) return <PasswordRecovery token={resetToken} onBack={() => location.assign('/')} />;
  if (loading) return <Notice text={t('正在验证会话…', 'Checking your session…')} />;
  if (failure) return <Notice text={saasErrorMessage(failure, locale)} retry />;
  if (!identity) return <Login invited={Boolean(inviteToken)} onAuthenticated={setIdentity} />;
  const controls = <WorkspaceControls identity={identity} onProfile={onProfile} />;
  const content = inviteToken ? <InviteAcceptance key={inviteToken + identity.user.id} token={inviteToken} identity={identity} controls={controls} />
    : window.location.pathname === '/admin' ? <AdminPanel identity={identity} controls={controls} />
    : <Workspace identity={identity} onProfile={onProfile} />;
  return <AppearanceScope key={identity.user.id} userId={identity.user.id}><SaaSOnboarding identity={identity}><PersonalEngineGate identity={identity}>{content}</PersonalEngineGate></SaaSOnboarding></AppearanceScope>;
}
function Notice({ text, retry = false }: { text: string; retry?: boolean }) {
  const { locale, t } = useSaaSPreferences();
  return <main className="saas-notice"><PreferenceControls /><strong>AwwO</strong><p role={retry ? 'alert' : 'status'}>{text}</p>{retry && <button onClick={() => window.location.reload()}>{t('重新连接', 'Reconnect')}</button>}</main>;
}
function Login({ onAuthenticated, invited }: { onAuthenticated: (identity: Identity) => void; invited: boolean }) {
  const { locale, t } = useSaaSPreferences();
  const [register, setRegister] = useState(false);
  const [forgot, setForgot] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (forgot) return <PasswordRecovery onBack={() => setForgot(false)} />;
  return <main className="saas-login"><PreferenceControls /><div className="saas-login-brand"><span>AwwO</span><MainSiteLink /><h1>{t('让 Agent 在同一张画布上协作。', 'Bring your agents together on one canvas.')}</h1><p>{t('独立工作区、持久会话与实时执行。你的团队，从这里开始。', 'Separate workspaces, persistent conversations and live execution. Your team starts here.')}</p></div>
    <form className="saas-card" onSubmit={async event => {
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
    </form></main>;
}
function Workspace({ identity, onProfile }: { identity: Identity; onProfile: (name: string) => void }) {
  const { t } = useSaaSPreferences();
  const params = new URLSearchParams(window.location.search);
  const requested = params.get('tenant');
  const tenant = identity.tenants.find(item => item.id === requested) || (!requested ? identity.tenants.find(item => item.status === 'active') || identity.tenants[0] : undefined);
  const canvasId = params.get('canvas');
  const controls = <WorkspaceControls key={tenant?.id || 'none'} identity={identity} tenant={tenant} canvasId={canvasId} onProfile={onProfile} />;
  if (!tenant || tenant.status !== 'active') return <main className="saas-dashboard"><header><a href="/" className="saas-logo">AwwO</a>{controls}</header><section className="saas-page-intro"><h1>{tenant ? t('工作区已暂停', 'Workspace suspended') : t('选择工作区', 'Choose a workspace')}</h1><p role="status">{tenant ? t('你可以切换其他工作区，或联系工作区管理员恢复访问。', 'Switch to another workspace or contact its administrator to restore access.') : requested ? t('你无权访问这个工作区，请切换其他工作区。', 'You cannot access this workspace. Choose another one.') : t('账号尚未加入工作区。可以新建工作区，或请所有者发送邀请链接。', 'You have not joined a workspace. Create one or ask its owner for an invitation.')}</p>{identity.user.platformRole === 'admin' && <a href="/admin">{t('进入平台管理', 'Open platform administration')}</a>}</section></main>;
  const readOnly = tenant.role === 'reader';
  if (canvasId) return readOnly ? <ReadOnlyCanvas key={tenant.id + canvasId} identity={identity} tenant={tenant} canvasId={canvasId} controls={controls} /> : <CloudCanvas key={tenant.id + canvasId} identity={identity} tenant={tenant} canvasId={canvasId} controls={controls} />;
  return <main className="saas-dashboard"><header><a href="/" className="saas-logo">AwwO</a>{controls}</header><section className="saas-page-intro"><span className="saas-eyebrow">{t('工作区', 'WORKSPACE')}</span><h1>{tenant.name}</h1><p>{t('选择画布，继续你的团队任务。', 'Choose a canvas to continue your team’s work.')}</p></section>
    <CanvasList key={identity.user.id + ':' + tenant.id + ':' + tenant.role} tenant={tenant} onOpen={id => navigate(tenant.id, id)} />
  </main>;
}
function WorkspaceControls({ identity, tenant, canvasId, onProfile }: { identity: Identity; tenant?: Tenant; canvasId?: string | null; onProfile: (name: string) => void }) {
  const { locale, t } = useSaaSPreferences();
  const [error, setError] = useState('');
  const [managementTenant, setManagementTenant] = useState<string | null>(tenant?.id || null);
  const [creatingWorkspace, setCreatingWorkspace] = useState(() => new URLSearchParams(window.location.search).get('createWorkspace') === '1');
  const accountApi = useMemo(() => createSaaSAccountApi(onProfile), [identity.user.id, onProfile]);
  return <div className="saas-account-actions" data-onboarding="workspace-actions"><PreferenceControls /><GuideLauncher /><MainSiteLink />
    {identity.tenants.length > 0 && <select aria-label={t('切换工作区', 'Switch workspace')} value={tenant?.id || ''} onChange={event => navigate(event.target.value)}>{!tenant && <option value="" disabled>{t('选择工作区', 'Choose a workspace')}</option>}{identity.tenants.map(item => <option key={item.id} value={item.id}>{item.name}{item.status !== 'active' ? t('（已暂停）', ' (suspended)') : ''}</option>)}</select>}
    <button className="saas-create-workspace-trigger" title={t('新建工作区', 'Create workspace')} aria-label={t('新建工作区', 'Create workspace')} onClick={() => setCreatingWorkspace(true)}><Plus size={16}/><span>{t('新建工作区', 'Create workspace')}</span></button>
    {creatingWorkspace && <CreateWorkspaceDialog onClose={() => setCreatingWorkspace(false)} onCreated={id => navigate(id)} />}
    {canvasId && tenant && <button title={t('返回画布列表', 'Back to canvases')} aria-label={t('返回画布列表', 'Back to canvases')} onClick={() => navigate(tenant.id)}><ArrowLeft size={16}/></button>}
    {identity.user.platformRole === 'admin' && <a href="/admin" title={t('平台管理', 'Platform administration')} aria-label={t('平台管理', 'Platform administration')}><ShieldCheck size={17}/>{t('平台管理', 'Administration')}</a>}
    {identity.personalCredentialsRequired && <a data-onboarding="engine-link" href={accountURL('engines')}>{t('我的引擎', 'My engines')}</a>}<a href={accountURL('security')}>{t('账号安全', 'Security')}</a>
    <CanvasAccountControl locale={locale} identity={null} onLogin={() => {}} onLogout={() => {}} onOpenWorkspaceAuth={() => navigate()}
      workspace={{ displayName: identity.user.name, selectedCompanyId: managementTenant, onCompanyChange: setManagementTenant, api: accountApi }} />
    <button title={t('退出登录', 'Sign out')} aria-label={t('退出登录', 'Sign out')} onClick={async () => { try { await api('/auth/logout', { method: 'POST' }); window.location.reload(); } catch (error) { setError(message(error)); } }}><LogOut size={16}/></button>
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
  return <div className="saas-canvas-shell"><div className="saas-cloud-status"><CanvasBackLink tenantId={tenant.id} /><span>{tenant.name} / {record.name}</span><GraphRunPanel tenantId={tenant.id} canvasId={canvasId} readOnly /><span role="status">{t('只读视图：可浏览原画布及会话，不能编辑或运行。', 'Read-only: browse the original canvas and conversations. Editing and execution are disabled.')}</span><button onClick={() => downloadDocument(record.document, record.name + '.json')}>{t('导出画布 JSON', 'Export canvas JSON')}</button></div>
    <CanvasSurface readOnly storageMode="cloud" workspaceName={tenant.name} workspaceCaption={t('云端工作区', 'Cloud workspace')} runtimeReadJson={runtimeReader} accountControl={controls} onOpenSettings={() => setSettingsOpen(true)} />
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
    try { const saved = readCanvasDrafts(storage); if (saved.length) setRecovery(saved); }
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
        if (!saved.length && cached) {
          let document: CanvasDocument | null = null;
          try { const parsed = JSON.parse(cached); if (parsed?.version === 2 && Array.isArray(parsed.nodes) && Array.isArray(parsed.edges)) document = sanitizeDocument(parsed); } catch { /* Preserve the raw payload below. */ }
          if (!document || (!isKnownSyncedCache(storage, document) && canonicalCanvasDocumentJSON(document) !== canonicalCanvasDocumentJSON(value.document)) || (hasJournal && baseVersion !== value.version)) {
            if (document && baseVersion > 0) persistCanvasDraft(storage, writerId, baseVersion, document);
            else storage.setItem(`${CANVAS_DRAFT_PREFIX}${writerId}`, JSON.stringify({ unrecognizedCache: cached, baseVersion }));
            saved = readCanvasDrafts(storage);
          }
        }
        if (saved.length) { setRecovery(saved); setSaveState('存在未同步草稿'); }
        else {
          if (!hasJournal) storage.setItem(CANVAS_STORAGE_KEY, JSON.stringify(sanitizeDocument(value.document)));
          storage.setItem('awwo.cloud.version', String(value.version));
          rememberCanvasBaseline(storage, value.version, value.document);
          setSaveState('已同步');
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
      while (pending.current && !failed.current && !disposed) {
        const sent: CanvasDraft = draft.current || persistCanvasDraft(storage, writerId, current.current!.version, pending.current);
        const document: CanvasDocument = sent.document; pending.current = null;
        setSaveState('正在保存…');
        try {
          const saved: CanvasRecord = await api<CanvasRecord>(tenantPath(tenant.id, `/canvases/${encodeURIComponent(canvasId)}`), { method: 'PUT', body: JSON.stringify({ name: current.current!.name, document, version: current.current!.version }) });
          rememberCanvasBaseline(storage, saved.version, saved.document);
          acknowledgeCanvasDraft(storage, sent, saved.version);
          if (restoredSource.current) { removeCanvasDraft(storage, restoredSource.current); restoredSource.current = null; }
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
      saving.current = false;
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
    if (pending.current) timer = setTimeout(() => void flush().catch(() => {}), 450);
    return () => { disposed = true; setupAbort.abort(); configureSaaSCanvasSave(null); configureSaaSCanvasInitialize(null); clearTimeout(timer); window.removeEventListener('awwo:canvas-cache-write', observe); window.removeEventListener('beforeunload', leave); };
  }, [record, recovery, tenant.id, canvasId, writerId]);
  const useCloud = () => {
    const storage = scopedStorage.current!;
    try {
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
        }
      }
      storage.setItem(CANVAS_STORAGE_KEY, cloud);
      storage.setItem('awwo.cloud.version', String(current.current!.version));
      rememberCanvasBaseline(storage, current.current!.version, current.current!.document);
      // Keep the journal: CanvasSurface reconciles accepted runs by GET and blocks unsent nodes.
      setRecovery(null); setError(''); setSaveState('已同步');
    } catch (error) { setError(message(error)); }
  };
  if (recovery) return <DraftRecovery tenantId={tenant.id} controls={controls} record={record} drafts={recovery} error={error}
    hasJournal={Boolean(scopedStorage.current && loadRunJournal(scopedStorage.current))} onUseCloud={useCloud}
    onRestore={saved => {
      if (!saved.draft || !current.current || saved.draft.baseVersion !== current.current.version) return;
      const storage = scopedStorage.current!;
      try {
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
      if (remaining.length) setRecovery(remaining); else useCloud();
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
  return <div className="saas-canvas-shell"><div className="saas-cloud-status"><CanvasBackLink tenantId={tenant.id} /><span>{tenant.name} / {record.name}</span><button onClick={exportLocal}>{t('导出画布 JSON', 'Export canvas JSON')}</button><GraphRunPanel tenantId={tenant.id} canvasId={canvasId} /><span role="status"><Save size={13}/>{({ '正在加载…': t('正在加载…', 'Loading…'), '存在未同步草稿': t('存在未同步草稿', 'Unsynced draft found'), '已同步': t('已同步', 'Synced'), '正在保存…': t('正在保存…', 'Saving…'), '等待同步…': t('等待同步…', 'Waiting to sync…'), '未同步': t('未同步', 'Not synced'), '已恢复草稿，等待同步…': t('已恢复草稿，等待同步…', 'Draft restored, waiting to sync…') }[saveState] || saveState)}</span></div>
    {error && <div className="saas-error-banner" role="alert">{saasErrorMessage(error, locale)}<button onClick={exportLocal}>{t('导出本地副本', 'Export local copy')}</button><button onClick={() => window.location.reload()}>{t('重新加载', 'Reload')}</button></div>}
    {runtime && executionUnavailableReason && <div className="saas-runtime-note" role="status">{t('执行尚未就绪：', 'Execution is not ready: ')}{executionUnavailableReason}{' '}{identity.personalCredentialsRequired && <a data-onboarding="engine-link" href={accountURL('engines')}>{t('我的引擎', 'My engines')}</a>}{' '}{t('画布编辑仍可使用。', 'Canvas editing remains available.')}</div>}
    <CanvasSurface storageMode="cloud" personalCredentialsRequired={identity.personalCredentialsRequired === true}
      executionUnavailableReason={executionUnavailableReason}
      workspaceName={tenant.name} workspaceCaption={t('云端工作区', 'Cloud workspace')} runtimeReadJson={runtimeReader} accountControl={controls} onCreateCompany={() => window.location.assign('/?createWorkspace=1')} onOpenSettings={() => setSettingsOpen(true)} />
    {settingsOpen && <RuntimeSettings tenantId={tenant.id} personalCredentialsRequired={identity.personalCredentialsRequired === true} onClose={() => setSettingsOpen(false)} />}
  </div>;
}

function DraftRecovery({ tenantId, controls, record, drafts, error, hasJournal, onRestore, onDiscard, onUseCloud }: {
  tenantId: string; controls: React.ReactNode; record: CanvasRecord | null; drafts: SavedCanvasDraft[]; error: string; hasJournal: boolean;
  onRestore: (saved: SavedCanvasDraft) => void; onDiscard: (saved: SavedCanvasDraft) => void; onUseCloud: () => void;
}) {
  const { locale, t } = useSaaSPreferences();
  const [selectedKey, setSelectedKey] = useState(drafts[0]?.key || '');
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const selected = drafts.find(saved => saved.key === selectedKey) || drafts[0];
  const canRestore = Boolean(record && selected?.draft && selected.draft.baseVersion === record.version);
  return <main className="saas-dashboard"><CanvasPageHeader tenantId={tenantId} controls={controls} /><section className="saas-page-intro"><h1>{t('发现未同步的本机草稿', 'Unsynced local drafts found')}</h1><p role="status">{t('本机修改已保留。确认如何处理后才会打开编辑器；重新加载不会丢弃草稿。', 'Your local changes are preserved. Choose how to handle them before opening the editor. Reloading will not discard drafts.')}</p></section>
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
