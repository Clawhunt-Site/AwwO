import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LogOut, Plus, ArrowLeft, ShieldCheck, Save } from 'lucide-react';
import { api, tenantPath, SaaSApiError, saasErrorMessage, type Identity, type Tenant, type CanvasRecord } from './api';
import { configureSaaSCanvas, configureSaaSCanvasSave, clearSaaSCanvas } from './canvasBridge';
import { configureCanvasStorage, canvasStorage, canvasStorageKey } from '../canvas/canvasStorage';
import { CANVAS_DRAFT_PREFIX, persistCanvasDraft, readCanvasDrafts, removeCanvasDraft, acknowledgeCanvasDraft, rememberCanvasBaseline, isKnownSyncedCache, type CanvasDraft, type SavedCanvasDraft } from './canvasDraft';
import { CanvasSurface } from '../canvas/CanvasSurface';
import { CANVAS_STORAGE_KEY, emptyDocument, sanitizeDocument, type CanvasDocument } from '../canvas/canvasDoc';
import { CANVAS_RUN_JOURNAL_KEY } from '../canvas/runJournal';
import { createCanvasRuntimeReader } from '../canvasRuntimeReader';
import { CanvasAccountControl } from '../CanvasAccountControl';
import { createSaaSAccountApi } from './accountApi';
import { SaaSPreferencesProvider, useSaaSPreferences, PreferenceControls } from './preferences';
import { InviteAcceptance } from './InviteAcceptance';
import { AdminPanel } from './AdminPanel';
import { RuntimeSettings } from './RuntimeSettings';

const message = (error: unknown) => error instanceof Error ? error.message : 'Request failed';
const navigate = (tenant?: string, canvas?: string) => {
  const query = new URLSearchParams();
  if (tenant) query.set('tenant', tenant);
  if (canvas) query.set('canvas', canvas);
  window.location.assign('/' + (query.size ? '?' + query : ''));
};
export function SaaSApp() { return <SaaSPreferencesProvider><AuthenticatedApp /></SaaSPreferencesProvider>; }
function AuthenticatedApp() {
  const { locale, t } = useSaaSPreferences();
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [loading, setLoading] = useState(true);
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
  if (loading) return <Notice text={t('正在验证会话…', 'Checking your session…')} />;
  if (failure) return <Notice text={saasErrorMessage(failure, locale)} retry />;
  if (!identity) return <Login invited={Boolean(inviteToken)} onAuthenticated={setIdentity} />;
  const controls = <WorkspaceControls identity={identity} onProfile={onProfile} />;
  if (inviteToken) return <InviteAcceptance key={inviteToken + identity.user.id} token={inviteToken} identity={identity} controls={controls} />;
  if (window.location.pathname === '/admin') return <AdminPanel identity={identity} controls={controls} />;
  return <Workspace identity={identity} onProfile={onProfile} />;
}
function Notice({ text, retry = false }: { text: string; retry?: boolean }) {
  const { locale, t } = useSaaSPreferences();
  return <main className="saas-notice"><PreferenceControls /><strong>AwwO</strong><p role={retry ? 'alert' : 'status'}>{text}</p>{retry && <button onClick={() => window.location.reload()}>{t('重新连接', 'Reconnect')}</button>}</main>;
}
function Login({ onAuthenticated, invited }: { onAuthenticated: (identity: Identity) => void; invited: boolean }) {
  const { locale, t } = useSaaSPreferences();
  const [register, setRegister] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <main className="saas-login"><PreferenceControls /><div className="saas-login-brand"><span>AwwO</span><h1>{t('让 Agent 在同一张画布上协作。', 'Bring your agents together on one canvas.')}</h1><p>{t('独立工作区、持久会话与实时执行。你的团队，从这里开始。', 'Separate workspaces, persistent conversations and live execution. Your team starts here.')}</p></div>
    <form className="saas-card" onSubmit={async event => {
      event.preventDefault(); setBusy(true); setError('');
      const values = Object.fromEntries(new FormData(event.currentTarget));
      try { onAuthenticated(await api<Identity>(register ? '/auth/register' : '/auth/login', { method: 'POST', body: JSON.stringify(values) })); }
      catch (error) { setError(message(error)); } finally { setBusy(false); }
    }}>
      <span className="saas-eyebrow">{t('AGENT 工作区', 'AGENT WORKSPACE')}</span><h2>{register ? t('创建你的工作区', 'Create your workspace') : t('欢迎回来', 'Welcome back')}</h2>
      {invited && <p role="status">{t('请先登录或注册。邀请会保留，登录后由你确认加入；注册时也会建立你自己的工作区。', 'Sign in or register first. Your invitation is preserved for confirmation after sign-in. Registration also creates your own workspace.')}</p>}
      {register && <><label>{t('姓名', 'Name')}<input name="name" autoComplete="name" required maxLength={100} /></label><label>{t('工作区名称', 'Workspace name')}<input name="tenantName" required maxLength={100} /></label></>}
      <label>{t('邮箱', 'Email')}<input name="email" type="email" autoComplete="email" required /></label>
      <label>{t('密码', 'Password')}<input name="password" type="password" minLength={12} autoComplete={register ? 'new-password' : 'current-password'} required /></label>
      {register && <small>{t('密码至少 12 位。', 'Use at least 12 characters.')}</small>}
      {error && <p className="saas-error" role="alert">{saasErrorMessage(error, locale)}</p>}
      <button className="saas-primary" disabled={busy}>{busy ? t('请稍候…', 'Please wait…') : register ? t('注册并创建工作区', 'Register and create workspace') : t('登录', 'Sign in')}</button>
      <button type="button" className="saas-link" disabled={busy} onClick={() => { setRegister(!register); setError(''); }}>{register ? t('已有账号？登录', 'Already have an account? Sign in') : t('创建账号和工作区', 'Create an account and workspace')}</button>
    </form></main>;
}
function Workspace({ identity, onProfile }: { identity: Identity; onProfile: (name: string) => void }) {
  const { locale, t } = useSaaSPreferences();
  const params = new URLSearchParams(window.location.search);
  const requested = params.get('tenant');
  const tenant = identity.tenants.find(item => item.id === requested) || (!requested ? identity.tenants.find(item => item.status === 'active') || identity.tenants[0] : undefined);
  const canvasId = params.get('canvas');
  const [error, setError] = useState('');
  const [list, setList] = useState<CanvasRecord[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState('');
  useEffect(() => {
    if (!tenant || tenant.status !== 'active' || canvasId) return;
    const controller = new AbortController();
    api<{ items: CanvasRecord[] }>(tenantPath(tenant.id, '/canvases'), { signal: controller.signal })
      .then(value => setList(value.items)).catch(error => { if (!controller.signal.aborted) setError(message(error)); });
    return () => controller.abort();
  }, [tenant?.id, tenant?.status, canvasId]);
  const controls = <WorkspaceControls identity={identity} tenant={tenant} canvasId={canvasId} onProfile={onProfile} />;
  if (!tenant || tenant.status !== 'active') return <main className="saas-dashboard"><header><a href="/" className="saas-logo">AwwO</a>{controls}</header><section className="saas-page-intro"><h1>{tenant ? t('工作区已暂停', 'Workspace suspended') : t('选择工作区', 'Choose a workspace')}</h1><p role="status">{tenant ? t('你可以切换其他工作区，或联系工作区管理员恢复访问。', 'Switch to another workspace or contact its administrator to restore access.') : requested ? t('你无权访问这个工作区，请切换其他工作区。', 'You cannot access this workspace. Choose another one.') : t('账号尚未加入工作区。请联系工作区所有者添加你的注册邮箱或发送邀请链接。', 'You have not joined a workspace. Ask its owner to add your registered email or send an invitation.')}</p>{identity.user.platformRole === 'admin' && <a href="/admin">{t('进入平台管理', 'Open platform administration')}</a>}</section></main>;
  const readOnly = tenant.role === 'reader';
  if (canvasId) return readOnly ? <ReadOnlyCanvas key={tenant.id + canvasId} identity={identity} tenant={tenant} canvasId={canvasId} controls={controls} /> : <CloudCanvas key={tenant.id + canvasId} identity={identity} tenant={tenant} canvasId={canvasId} controls={controls} />;
  return <main className="saas-dashboard"><header><a href="/" className="saas-logo">AwwO</a>{controls}</header><section className="saas-page-intro"><span className="saas-eyebrow">{t('工作区', 'WORKSPACE')}</span><h1>{tenant.name}</h1><p>{t('选择画布，继续你的团队任务。', 'Choose a canvas to continue your team’s work.')}</p></section>
    {readOnly && <p className="saas-runtime-note" role="status">{t('只读成员：可以浏览画布、会话和导出副本，不能编辑或运行。', 'Reader: browse canvases and conversations or export a copy. Editing and execution require member access.')}</p>}
    {!readOnly && <form className="saas-create" onSubmit={async event => {
      event.preventDefault(); setBusy(true); setError('');
      try { const canvas = await api<CanvasRecord>(tenantPath(tenant.id, '/canvases'), { method: 'POST', body: JSON.stringify({ name: newName, document: emptyDocument() }) }); navigate(tenant.id, canvas.id); }
      catch (error) { setError(message(error)); setBusy(false); }
    }}><input aria-label={t('新画布名称', 'New canvas name')} placeholder={t('为新画布起个名字', 'Name your new canvas')} value={newName} onChange={event => setNewName(event.target.value)} required maxLength={100}/><button disabled={busy} className="saas-primary"><Plus size={16}/>{t('新建画布', 'Create canvas')}</button></form>}
    {error && <p role="alert" className="saas-error">{saasErrorMessage(error, locale)}</p>}
    {list === null ? <p role="status">{error ? t('画布列表加载失败，请重新连接。', 'Could not load canvases. Please reconnect.') : t('正在加载画布…', 'Loading canvases…')}</p> : <div className="saas-canvas-list">{list.map(canvas => <button key={canvas.id} className="saas-canvas-card" onClick={() => navigate(tenant.id, canvas.id)}><span>↗</span><h2>{canvas.name}</h2><p>{new Date(canvas.updatedAt).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US')}</p></button>)}{list.length === 0 && <p>{readOnly ? t('工作区还没有画布。', 'This workspace has no canvases yet.') : t('还没有画布。创建后可添加、配置和连接 Agent。', 'No canvases yet. Create one to add, configure and connect agents.')}</p>}</div>}
  </main>;
}
function WorkspaceControls({ identity, tenant, canvasId, onProfile }: { identity: Identity; tenant?: Tenant; canvasId?: string | null; onProfile: (name: string) => void }) {
  const { locale, t } = useSaaSPreferences();
  const [error, setError] = useState('');
  const [managementTenant, setManagementTenant] = useState<string | null>(tenant?.id || null);
  const accountApi = useMemo(() => createSaaSAccountApi(onProfile), [identity.user.id, onProfile]);
  return <div className="saas-account-actions"><PreferenceControls />
    {identity.tenants.length > 0 && <select aria-label={t('切换工作区', 'Switch workspace')} value={tenant?.id || ''} onChange={event => navigate(event.target.value)}>{!tenant && <option value="" disabled>{t('选择工作区', 'Choose a workspace')}</option>}{identity.tenants.map(item => <option key={item.id} value={item.id}>{item.name}{item.status !== 'active' ? t('（已暂停）', ' (suspended)') : ''}</option>)}</select>}
    {canvasId && tenant && <button title={t('返回画布列表', 'Back to canvases')} aria-label={t('返回画布列表', 'Back to canvases')} onClick={() => navigate(tenant.id)}><ArrowLeft size={16}/></button>}
    {identity.user.platformRole === 'admin' && <a href="/admin" title={t('平台管理', 'Platform administration')} aria-label={t('平台管理', 'Platform administration')}><ShieldCheck size={17}/>{t('平台管理', 'Administration')}</a>}
    <CanvasAccountControl locale={locale} identity={null} onLogin={() => {}} onLogout={() => {}} onOpenWorkspaceAuth={() => navigate()}
      workspace={{ displayName: identity.user.name, selectedCompanyId: managementTenant, onCompanyChange: setManagementTenant, api: accountApi }} />
    <button title={t('退出登录', 'Sign out')} aria-label={t('退出登录', 'Sign out')} onClick={async () => { try { await api('/auth/logout', { method: 'POST' }); window.location.reload(); } catch (error) { setError(message(error)); } }}><LogOut size={16}/></button>
    {error && <p role="alert" className="saas-error">{saasErrorMessage(error, locale)}</p>}
  </div>;
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
  if (!record) return <main className="saas-dashboard"><header><a href="/" className="saas-logo">AwwO</a>{controls}</header><p role={error ? 'alert' : 'status'}>{error ? saasErrorMessage(error, locale) : t('正在加载云端画布…', 'Loading cloud canvas…')}</p></main>;
  return <div className="saas-canvas-shell"><div className="saas-cloud-status"><span>{tenant.name} / {record.name}</span><span role="status">{t('只读视图：可浏览原画布及会话，不能编辑或运行。', 'Read-only: browse the original canvas and conversations. Editing and execution are disabled.')}</span><button onClick={() => downloadDocument(record.document, record.name + '.json')}>{t('导出画布 JSON', 'Export canvas JSON')}</button></div>
    <CanvasSurface readOnly storageMode="cloud" workspaceName={tenant.name} workspaceCaption={t('云端工作区', 'Cloud workspace')} runtimeReadJson={runtimeReader} accountControl={controls} onOpenSettings={() => setSettingsOpen(true)} />
    {settingsOpen && <RuntimeSettings onClose={() => setSettingsOpen(false)} />}
  </div>;
}

function CloudCanvas({ identity, tenant, canvasId, controls }: { identity: Identity; tenant: Tenant; canvasId: string; controls: React.ReactNode }) {
  const { locale, t } = useSaaSPreferences();
  const [record, setRecord] = useState<CanvasRecord | null>(null);
  const [error, setError] = useState('');
  const [saveState, setSaveState] = useState('正在加载…');
  const [runtime, setRuntime] = useState<{ configured: boolean; available: boolean; reason?: string } | null>(null);
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
    Promise.all([api<CanvasRecord>(tenantPath(tenant.id, `/canvases/${encodeURIComponent(canvasId)}`), { signal: controller.signal }), api<any>('/runtime', { signal: controller.signal })])
      .then(([value, health]) => {
        if (controller.signal.aborted) return;
        configureSaaSCanvas({ tenant, canvasId });
        let saved = readCanvasDrafts(storage);
        const cached = storage.getItem(CANVAS_STORAGE_KEY);
        const baseVersion = Number(storage.getItem('awwo.cloud.version'));
        const hasJournal = Boolean(storage.getItem(CANVAS_RUN_JOURNAL_KEY));
        // Migrate pre-draft caches conservatively, including edits whose draft write hit a storage error.
        // A confirmed clean cache can follow a newer server version without a false recovery prompt.
        if (!saved.length && cached) {
          let document: CanvasDocument | null = null;
          try { const parsed = JSON.parse(cached); if (parsed?.version === 2 && Array.isArray(parsed.nodes) && Array.isArray(parsed.edges)) document = sanitizeDocument(parsed); } catch { /* Preserve the raw payload below. */ }
          if (!document || (!isKnownSyncedCache(storage, document) && JSON.stringify(document) !== JSON.stringify(sanitizeDocument(value.document))) || (hasJournal && baseVersion !== value.version)) {
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
        current.current = value; setRuntime(health); setRecord(value);
      }).catch(error => { if (!controller.signal.aborted) setError(message(error)); });
    return () => controller.abort();
  }, [identity.user.id, tenant.id, canvasId, writerId]);

  useEffect(() => {
    if (!record || recovery || !scopedStorage.current) return;
    const storage = scopedStorage.current;
    const cacheKey = canvasStorageKey(CANVAS_STORAGE_KEY);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    const flush = async () => {
      while (saving.current && !disposed) await new Promise(resolve => setTimeout(resolve, 20));
      if (failed.current || disposed) throw new Error('画布未同步，请先解决保存错误再运行。');
      if (!current.current || !pending.current) return;
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
        if (!saving.current && !pending.current && !draft.current && JSON.stringify(sanitizeDocument(document)) === JSON.stringify(sanitizeDocument(current.current!.document))) return;
        pending.current = document;
        draft.current = persistCanvasDraft(storage, writerId, current.current!.version, pending.current!);
      } catch (error) {
        failed.current = true; setSaveState('未同步'); setError(`本机草稿保存失败：${message(error)}。请立即导出本地副本。`); return;
      }
      setSaveState('等待同步…'); clearTimeout(timer); timer = setTimeout(() => void flush().catch(() => {}), 450);
    };
    const leave = (event: BeforeUnloadEvent) => { if (pending.current || saving.current || failed.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('awwo:canvas-cache-write', observe); window.addEventListener('beforeunload', leave);
    configureSaaSCanvasSave(flush);
    if (pending.current) timer = setTimeout(() => void flush().catch(() => {}), 450);
    return () => { disposed = true; configureSaaSCanvasSave(null); clearTimeout(timer); window.removeEventListener('awwo:canvas-cache-write', observe); window.removeEventListener('beforeunload', leave); };
  }, [record, recovery, tenant.id, canvasId, writerId]);
  const useCloud = () => {
    const storage = scopedStorage.current!;
    storage.setItem(CANVAS_STORAGE_KEY, JSON.stringify(sanitizeDocument(current.current!.document)));
    storage.setItem('awwo.cloud.version', String(current.current!.version));
    rememberCanvasBaseline(storage, current.current!.version, current.current!.document);
    setRecovery(null); setError(''); setSaveState('已同步');
  };
  if (recovery) return <DraftRecovery controls={controls} record={record} drafts={recovery} error={error}
    hasJournal={Boolean(scopedStorage.current?.getItem(CANVAS_RUN_JOURNAL_KEY))} onUseCloud={useCloud}
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
  if (!record) return <main className="saas-dashboard"><header><a href="/" className="saas-logo">AwwO</a>{controls}</header><section className="saas-page-intro"><p role={error ? 'alert' : 'status'}>{error ? saasErrorMessage(error, locale) : t('正在加载云端画布…', 'Loading cloud canvas…')}</p>{error && <button onClick={() => window.location.reload()}>{t('重新连接', 'Reconnect')}</button>}</section></main>;
  const exportLocal = () => {
    const url = URL.createObjectURL(new Blob([scopedStorage.current?.getItem(CANVAS_STORAGE_KEY) || '{}'], { type: 'application/json' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'awwo-canvas-recovery.json'; anchor.click(); URL.revokeObjectURL(url);
  };
  return <div className="saas-canvas-shell"><div className="saas-cloud-status"><span>{tenant.name} / {record.name}</span><button onClick={exportLocal}>{t('导出画布 JSON', 'Export canvas JSON')}</button><span role="status"><Save size={13}/>{({ '正在加载…': t('正在加载…', 'Loading…'), '存在未同步草稿': t('存在未同步草稿', 'Unsynced draft found'), '已同步': t('已同步', 'Synced'), '正在保存…': t('正在保存…', 'Saving…'), '等待同步…': t('等待同步…', 'Waiting to sync…'), '未同步': t('未同步', 'Not synced'), '已恢复草稿，等待同步…': t('已恢复草稿，等待同步…', 'Draft restored, waiting to sync…') }[saveState] || saveState)}</span></div>
    {error && <div className="saas-error-banner" role="alert">{saasErrorMessage(error, locale)}<button onClick={exportLocal}>{t('导出本地副本', 'Export local copy')}</button><button onClick={() => window.location.reload()}>{t('重新加载', 'Reload')}</button></div>}
    {runtime && !runtime.available && <div className="saas-runtime-note" role="status">{t('Pi 执行尚未就绪：', 'Pi execution is not ready: ')}{runtime.reason ? saasErrorMessage(runtime.reason, locale) : t('请由服务管理员配置模型。', 'Ask the service administrator to configure a model.')}{t('画布编辑仍可使用。', 'Canvas editing remains available.')}</div>}
    <CanvasSurface storageMode="cloud" workspaceName={tenant.name} workspaceCaption={t('云端工作区', 'Cloud workspace')} runtimeReadJson={runtimeReader} accountControl={controls} onCreateCompany={() => navigate(tenant.id)} onOpenSettings={() => setSettingsOpen(true)} />
    {settingsOpen && <RuntimeSettings onClose={() => setSettingsOpen(false)} />}
  </div>;
}

function DraftRecovery({ controls, record, drafts, error, hasJournal, onRestore, onDiscard, onUseCloud }: {
  controls: React.ReactNode; record: CanvasRecord | null; drafts: SavedCanvasDraft[]; error: string; hasJournal: boolean;
  onRestore: (saved: SavedCanvasDraft) => void; onDiscard: (saved: SavedCanvasDraft) => void; onUseCloud: () => void;
}) {
  const { locale, t } = useSaaSPreferences();
  const [selectedKey, setSelectedKey] = useState(drafts[0]?.key || '');
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const selected = drafts.find(saved => saved.key === selectedKey) || drafts[0];
  const canRestore = Boolean(record && selected?.draft && selected.draft.baseVersion === record.version);
  return <main className="saas-dashboard"><header><a href="/" className="saas-logo">AwwO</a>{controls}</header><section className="saas-page-intro"><h1>{t('发现未同步的本机草稿', 'Unsynced local drafts found')}</h1><p role="status">{t('本机修改已保留。确认如何处理后才会打开编辑器；重新加载不会丢弃草稿。', 'Your local changes are preserved. Choose how to handle them before opening the editor. Reloading will not discard drafts.')}</p></section>
    {error && <p className="saas-error" role="alert">{saasErrorMessage(error, locale)}</p>}
    <section className="saas-card saas-draft-recovery"><label>{t('选择本机草稿', 'Choose a local draft')}<select aria-label={t('选择本机草稿', 'Choose a local draft')} value={selected?.key || ''} onChange={event => { setSelectedKey(event.target.value); setConfirmDiscard(false); }}>{drafts.map((saved, index) => <option key={saved.key} value={saved.key}>{t('草稿', 'Draft')} {index + 1}{saved.draft ? ' · ' + new Date(saved.draft.updatedAt).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US') : t(' · 需要人工检查', ' · Manual inspection required')}</option>)}</select></label>
      {selected?.draft ? <><p>{t('草稿基于云端版本', 'Draft base version:')} {selected.draft.baseVersion}{t('；当前云端版本', '; current cloud version:')} {record?.version ?? t('读取中', 'loading')}。</p><p>{t('包含节点：', 'Nodes: ')}{selected.draft.document.nodes.map(node => node.title).join(', ') || t('空画布', 'Empty canvas')}</p>{record && !canRestore && <p className="saas-error">{t('云端版本已有变化。请导出草稿后核对，当前草稿不会自动覆盖较新的云端内容。', 'The cloud version has changed. Export and review your draft. It will not automatically overwrite newer cloud content.')}</p>}</> : <p className="saas-error">{t('草稿格式无法自动恢复。原始内容仍可导出，尚未删除。', 'This draft format cannot be restored automatically. Its original content is preserved and can be exported.')}</p>}
      {hasJournal && <p>{t('本机还保存着待恢复运行记录。请保留草稿并核对运行；版本一致时可恢复编辑器继续处理。', 'A local run recovery record also exists. Keep your draft and review the run. You can restore the editor when the versions match.')}</p>}
      <div className="saas-draft-actions"><button onClick={() => {
        const url = URL.createObjectURL(new Blob([selected.draft ? JSON.stringify(selected.draft.document, null, 2) : selected.raw], { type: 'application/json' }));
        const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'awwo-unsynced-draft.json'; anchor.click(); URL.revokeObjectURL(url);
      }}>{t('导出未同步草稿', 'Export unsynced draft')}</button><button disabled={!canRestore} onClick={() => onRestore(selected)}>{t('恢复草稿并继续同步', 'Restore draft and resume syncing')}</button>
      {!hasJournal && record && <><button onClick={onUseCloud}>{t('使用云端版本，保留草稿', 'Use cloud version and keep draft')}</button><button onClick={() => setConfirmDiscard(true)}>{t('丢弃这份本机草稿', 'Discard this local draft')}</button></>}</div>
      {confirmDiscard && <div role="alert"><p>{t('确定丢弃所选草稿？该草稿中尚未同步的修改将被删除。', 'Discard this draft? Its unsynced changes will be deleted.')}</p><button onClick={() => { onDiscard(selected); setConfirmDiscard(false); }}>{t('确认丢弃', 'Confirm discard')}</button><button onClick={() => setConfirmDiscard(false)}>{t('保留草稿', 'Keep draft')}</button></div>}
      <button onClick={() => window.location.reload()}>{t('重新连接云端', 'Reconnect to cloud')}</button>
    </section>
  </main>;
}
