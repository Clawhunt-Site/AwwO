import { useEffect, useRef, useState } from 'react';
import { LogOut, Plus, ArrowLeft, ShieldCheck, Save, RefreshCw, Users } from 'lucide-react';
import { api, tenantPath, SaaSApiError, type Identity, type Tenant, type CanvasRecord } from './api';
import { configureSaaSCanvas, configureSaaSCanvasSave } from './canvasBridge';
import { configureCanvasStorage, canvasStorage, canvasStorageKey } from '../canvas/canvasStorage';
import { CANVAS_DRAFT_PREFIX, persistCanvasDraft, readCanvasDrafts, removeCanvasDraft, acknowledgeCanvasDraft, rememberCanvasBaseline, isKnownSyncedCache, type CanvasDraft, type SavedCanvasDraft } from './canvasDraft';
import { CanvasSurface } from '../canvas/CanvasSurface';
import { LocaleProvider } from '../canvas/i18n';
import { CANVAS_STORAGE_KEY, emptyDocument, sanitizeDocument, type CanvasDocument } from '../canvas/canvasDoc';
import { CANVAS_RUN_JOURNAL_KEY } from '../canvas/runJournal';
import { createCanvasRuntimeReader } from '../canvasRuntimeReader';

const message = (error: unknown) => error instanceof Error ? error.message : '请求失败，请重试。';
const navigate = (tenant?: string, canvas?: string) => {
  const query = new URLSearchParams();
  if (tenant) query.set('tenant', tenant);
  if (canvas) query.set('canvas', canvas);
  window.location.assign(`/${query.size ? `?${query}` : ''}`);
};

export function SaaSApp() {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState('');
  useEffect(() => {
    let live = true;
    api<Identity>('/auth/me').then(value => { if (live) setIdentity(value); })
      .catch(error => { if (live && !(error instanceof SaaSApiError && error.status === 401)) setFailure(message(error)); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, []);
  if (loading) return <Notice text="正在验证会话…" />;
  if (failure) return <Notice text={failure} retry />;
  if (!identity) return <Login onAuthenticated={setIdentity} />;
  if (window.location.pathname === '/admin') return <Admin identity={identity} />;
  return <Workspace identity={identity} />;
}

function Notice({ text, retry = false }: { text: string; retry?: boolean }) {
  return <main className="saas-notice"><strong>AwwO</strong><p role={retry ? 'alert' : 'status'}>{text}</p>{retry && <button onClick={() => window.location.reload()}>重新连接</button>}</main>;
}

function Login({ onAuthenticated }: { onAuthenticated: (identity: Identity) => void }) {
  const [register, setRegister] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <main className="saas-login"><div className="saas-login-brand"><span>AwwO</span><h1>让 Agent 在同一张画布上协作。</h1><p>独立工作区、持久会话与实时执行。你的团队，从这里开始。</p></div>
    <form className="saas-card" onSubmit={async event => {
      event.preventDefault(); setBusy(true); setError('');
      const values = Object.fromEntries(new FormData(event.currentTarget));
      try { onAuthenticated(await api<Identity>(register ? '/auth/register' : '/auth/login', { method: 'POST', body: JSON.stringify(values) })); }
      catch (error) { setError(message(error)); } finally { setBusy(false); }
    }}>
      <span className="saas-eyebrow">AGENT WORKSPACE</span><h2>{register ? '创建你的工作区' : '欢迎回来'}</h2>
      {register && <><label>姓名<input name="name" autoComplete="name" required maxLength={100} /></label><label>工作区名称<input name="tenantName" required maxLength={100} /></label></>}
      <label>邮箱<input name="email" type="email" autoComplete="email" required /></label>
      <label>密码<input name="password" type="password" minLength={12} autoComplete={register ? 'new-password' : 'current-password'} required /></label>
      {register && <small>密码至少 12 位。</small>}
      {error && <p className="saas-error" role="alert">{error}</p>}
      <button className="saas-primary" disabled={busy}>{busy ? '请稍候…' : register ? '注册并创建工作区' : '登录'}</button>
      <button type="button" className="saas-link" disabled={busy} onClick={() => { setRegister(!register); setError(''); }}>{register ? '已有账号？登录' : '创建账号和工作区'}</button>
    </form></main>;
}

function Workspace({ identity }: { identity: Identity }) {
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
  const controls = <WorkspaceControls identity={identity} tenant={tenant} canvasId={canvasId} />;
  if (!tenant || tenant.status !== 'active') return <main className="saas-dashboard"><header><a href="/" className="saas-logo">AwwO</a>{controls}</header><section className="saas-page-intro"><h1>{tenant ? '工作区已暂停' : '选择工作区'}</h1><p role="status">{tenant ? '你可以切换其他工作区，或联系工作区管理员恢复访问。' : requested ? '你无权访问这个工作区，请切换其他工作区。' : '账号尚未加入工作区。请联系工作区所有者添加你的注册邮箱。'}</p>{identity.user.platformRole === 'admin' && <a href="/admin">进入平台管理</a>}</section></main>;
  const readOnly = tenant.role === 'reader';
  if (canvasId) return readOnly ? <ReadOnlyCanvas tenant={tenant} canvasId={canvasId} controls={controls} /> : <CloudCanvas identity={identity} tenant={tenant} canvasId={canvasId} controls={controls} />;
  return <main className="saas-dashboard"><header><a href="/" className="saas-logo">AwwO</a>{controls}</header><section className="saas-page-intro"><span className="saas-eyebrow">WORKSPACE</span><h1>{tenant.name}</h1><p>选择画布，继续你的团队任务。</p></section>
    {readOnly && <p className="saas-runtime-note" role="status">只读成员：可以浏览画布、会话和导出副本，不能编辑或运行。</p>}
    {!readOnly && <form className="saas-create" onSubmit={async event => {
      event.preventDefault(); setBusy(true); setError('');
      try { const canvas = await api<CanvasRecord>(tenantPath(tenant.id, '/canvases'), { method: 'POST', body: JSON.stringify({ name: newName, document: emptyDocument() }) }); navigate(tenant.id, canvas.id); }
      catch (error) { setError(message(error)); setBusy(false); }
    }}><input aria-label="新画布名称" placeholder="为新画布起个名字" value={newName} onChange={event => setNewName(event.target.value)} required maxLength={100}/><button disabled={busy} className="saas-primary"><Plus size={16}/>新建画布</button></form>}
    {error && <p role="alert" className="saas-error">{error}</p>}
    {list === null ? <p role="status">{error ? '画布列表加载失败，请重新连接。' : '正在加载画布…'}</p> : <div className="saas-canvas-list">{list.map(canvas => <button key={canvas.id} className="saas-canvas-card" onClick={() => navigate(tenant.id, canvas.id)}><span>↗</span><h2>{canvas.name}</h2><p>{new Date(canvas.updatedAt).toLocaleString('zh-CN')}</p></button>)}{list.length === 0 && <p>{readOnly ? '工作区还没有画布。' : '还没有画布。创建后可添加、配置和连接 Agent。'}</p>}</div>}
  </main>;
}

function WorkspaceControls({ identity, tenant, canvasId }: { identity: Identity; tenant?: Tenant; canvasId?: string | null }) {
  const [membersOpen, setMembersOpen] = useState(false);
  const [error, setError] = useState('');
  return <div className="saas-account-actions">
    {identity.tenants.length > 0 && <select aria-label="切换工作区" value={tenant?.id || ''} onChange={event => navigate(event.target.value)}>{!tenant && <option value="" disabled>选择工作区</option>}{identity.tenants.map(item => <option key={item.id} value={item.id}>{item.name}{item.status !== 'active' ? '（已暂停）' : ''}</option>)}</select>}
    {canvasId && tenant && <button title="返回画布列表" aria-label="返回画布列表" onClick={() => navigate(tenant.id)}><ArrowLeft size={16}/></button>}
    {tenant?.status === 'active' && ['owner', 'admin'].includes(tenant.role) && <button title="工作区成员" aria-label="工作区成员" onClick={() => setMembersOpen(true)}><Users size={17}/></button>}
    {identity.user.platformRole === 'admin' && <a href="/admin" title="平台管理" aria-label="平台管理"><ShieldCheck size={17}/>平台管理</a>}
    <span>{identity.user.name}</span><button title="退出登录" aria-label="退出登录" onClick={async () => { try { await api('/auth/logout', { method: 'POST' }); window.location.assign('/'); } catch (error) { setError(message(error)); } }}><LogOut size={16}/></button>
    {error && <p role="alert" className="saas-error">{error}</p>}
    {membersOpen && tenant && <Members tenant={tenant} onClose={() => setMembersOpen(false)} />}
  </div>;
}

type Member = { id: string; userId: string; email: string; name: string; role: string };
const memberRoles: Record<string, string> = { owner: '所有者', admin: '管理员', member: '成员', reader: '只读成员' };
function Members({ tenant, onClose }: { tenant: Tenant; onClose: () => void }) {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('member');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const roles = tenant.role === 'owner' ? ['reader', 'member', 'admin'] : ['reader', 'member'];
  useEffect(() => {
    const controller = new AbortController();
    api<{ items: Member[] }>(tenantPath(tenant.id, '/members'), { signal: controller.signal }).then(value => setMembers(value.items))
      .catch(error => { if (!controller.signal.aborted) setError(message(error)); });
    return () => controller.abort();
  }, [tenant.id, revision]);
  const mutate = async (suffix: string, method: string, body?: unknown) => {
    setBusy(true); setError('');
    try { await api(tenantPath(tenant.id, `/members${suffix}`), { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); setRevision(value => value + 1); if (method === 'POST') setEmail(''); }
    catch (error) { setError(message(error)); } finally { setBusy(false); }
  };
  return <div className="saas-dialog-backdrop"><section role="dialog" aria-modal="true" aria-labelledby="saas-members-title" className="saas-card saas-members"><div className="saas-panel-heading"><h2 id="saas-members-title">工作区成员</h2><button onClick={onClose} aria-label="关闭成员管理">关闭</button></div><p>输入已注册的邮箱添加成员。只读成员可以查看与导出；成员可以编辑与运行。</p>
    <form className="saas-create" onSubmit={event => { event.preventDefault(); void mutate('', 'POST', { email, role }); }}><input type="email" aria-label="成员邮箱" value={email} onChange={event => setEmail(event.target.value)} placeholder="已注册的邮箱" required/><select aria-label="新成员角色" value={role} onChange={event => setRole(event.target.value)}>{roles.map(item => <option key={item} value={item}>{memberRoles[item]}</option>)}</select><button disabled={busy} className="saas-primary">添加成员</button></form>
    {error && <p className="saas-error" role="alert">{error}</p>}
    {!members ? <p role="status">{error ? '成员列表暂不可用。' : '正在加载成员…'}</p> : <div className="saas-table-wrap"><table><thead><tr><th>成员</th><th>邮箱</th><th>角色</th><th>操作</th></tr></thead><tbody>{members.map(member => {
      const canChange = member.role !== 'owner' && (tenant.role === 'owner' || member.role !== 'admin');
      return <tr key={member.userId}><td>{member.name}</td><td>{member.email}</td><td>{canChange ? <select aria-label={`${member.email}的角色`} value={member.role} disabled={busy} onChange={event => void mutate(`/${encodeURIComponent(member.userId)}`, 'PATCH', { role: event.target.value })}>{roles.map(item => <option key={item} value={item}>{memberRoles[item]}</option>)}</select> : memberRoles[member.role] || member.role}</td><td>{canChange && <button disabled={busy} aria-label={`移除${member.email}`} onClick={() => void mutate(`/${encodeURIComponent(member.userId)}`, 'DELETE')}>移除</button>}</td></tr>;
    })}</tbody></table></div>}
  </section></div>;
}

function downloadDocument(value: unknown, name: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click(); URL.revokeObjectURL(url);
}

function ReadOnlyCanvas({ tenant, canvasId, controls }: { tenant: Tenant; canvasId: string; controls: React.ReactNode }) {
  const [record, setRecord] = useState<CanvasRecord | null>(null);
  const [sessions, setSessions] = useState<Array<{ id: string; nodeId: string; title: string }>>([]);
  const [sessionId, setSessionId] = useState('');
  const [messages, setMessages] = useState<Array<{ id: string; role: string; content: string }> | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    Promise.all([api<CanvasRecord>(tenantPath(tenant.id, `/canvases/${encodeURIComponent(canvasId)}`), { signal: controller.signal }), api<{ items: typeof sessions }>(tenantPath(tenant.id, `/sessions?canvasId=${encodeURIComponent(canvasId)}`), { signal: controller.signal })])
      .then(([canvas, history]) => { setRecord(canvas); setSessions(history.items); setSessionId(history.items[0]?.id || ''); })
      .catch(error => { if (!controller.signal.aborted) setError(message(error)); });
    return () => controller.abort();
  }, [tenant.id, canvasId]);
  useEffect(() => {
    if (!sessionId) return;
    const controller = new AbortController(); setMessages(null);
    api<{ items: NonNullable<typeof messages> }>(tenantPath(tenant.id, `/sessions/${encodeURIComponent(sessionId)}/messages`), { signal: controller.signal }).then(value => setMessages(value.items))
      .catch(error => { if (!controller.signal.aborted) setError(message(error)); });
    return () => controller.abort();
  }, [tenant.id, sessionId]);
  const doc = record ? sanitizeDocument(record.document) : null;
  return <main className="saas-dashboard"><header><a href="/" className="saas-logo">AwwO</a>{controls}</header><section className="saas-page-intro"><h1>{record?.name || '云端画布'}</h1><p role="status">只读视图：浏览节点、依赖和会话；编辑及运行需要成员权限。</p>{record && <button onClick={() => downloadDocument(record.document, `${record.name}.json`)}>导出画布 JSON</button>}</section>
    {error && <p role="alert" className="saas-error">{error}</p>}
    {!doc ? <p>{error ? '画布加载失败。' : '正在加载云端画布…'}</p> : <><div className="saas-readonly-nodes">{doc.nodes.map(node => <article className="saas-card" key={node.id}><h2>{node.title}</h2>{node.kind === 'form' ? node.fields.map(field => <div key={field.id}><strong>{field.label}</strong><pre>{field.value || '未填写'}</pre></div>) : <><p>{node.persona || '未设置角色说明'}</p>{node.contract && <details><summary>输入输出契约</summary><pre>{JSON.stringify(node.contract, null, 2)}</pre></details>}{node.lastOutput && <><strong>{node.lastOutput.partial ? '部分输出（运行未成功）' : '最近输出'}</strong><pre>{node.lastOutput.text}</pre></>}</>}</article>)}</div><section className="saas-readonly-history"><h2>节点依赖</h2>{doc.edges.length ? <ul>{doc.edges.map(edge => <li key={edge.id}>{doc.nodes.find(node => node.id === edge.fromNode)?.title || edge.fromNode} · {edge.fromPort} → {doc.nodes.find(node => node.id === edge.toNode)?.title || edge.toNode} · {edge.toPort}</li>)}</ul> : <p>暂无连线。</p>}<h2>历史会话</h2>{sessions.length ? <><select aria-label="浏览会话" value={sessionId} onChange={event => setSessionId(event.target.value)}>{sessions.map(session => <option key={session.id} value={session.id}>{doc.nodes.find(node => node.id === session.nodeId)?.title || '节点'} / {session.title}</option>)}</select>{messages === null ? <p>正在加载会话…</p> : messages.map(item => <article className="saas-readonly-message" key={item.id}><strong>{item.role === 'user' ? '用户' : 'Agent'}</strong><pre>{item.content}</pre></article>)}</> : <p>暂无历史会话。</p>}</section></>}
  </main>;
}

function CloudCanvas({ identity, tenant, canvasId, controls }: { identity: Identity; tenant: Tenant; canvasId: string; controls: React.ReactNode }) {
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
  if (!record) return <main className="saas-dashboard"><header><a href="/" className="saas-logo">AwwO</a>{controls}</header><section className="saas-page-intro"><p role={error ? 'alert' : 'status'}>{error || '正在加载云端画布…'}</p>{error && <button onClick={() => window.location.reload()}>重新连接</button>}</section></main>;
  const exportLocal = () => {
    const url = URL.createObjectURL(new Blob([scopedStorage.current?.getItem(CANVAS_STORAGE_KEY) || '{}'], { type: 'application/json' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'awwo-canvas-recovery.json'; anchor.click(); URL.revokeObjectURL(url);
  };
  return <div className="saas-canvas-shell"><div className="saas-cloud-status"><span>{tenant.name} / {record.name}</span><span role="status"><Save size={13}/>{saveState}</span></div>
    {error && <div className="saas-error-banner" role="alert">{error}<button onClick={exportLocal}>导出本地副本</button><button onClick={() => window.location.reload()}>重新加载</button></div>}
    {runtime && !runtime.available && <div className="saas-runtime-note" role="status">Pi 执行尚未就绪：{runtime.reason || '请由服务管理员配置模型。'} 画布编辑仍可使用。</div>}
    <LocaleProvider locale="zh"><CanvasSurface workspaceName={tenant.name} workspaceCaption="云端工作区" runtimeReadJson={runtimeReader} accountControl={controls} onCreateCompany={() => navigate(tenant.id)} onOpenSettings={() => setSettingsOpen(true)} /></LocaleProvider>
    {settingsOpen && <div className="saas-dialog-backdrop"><section role="dialog" aria-modal="true" aria-labelledby="saas-runtime-title" className="saas-card"><h2 id="saas-runtime-title">工作区运行设置</h2><p>执行引擎：Pi</p><p>{runtime?.available ? '运行服务已就绪。模型可在节点配置中选择。' : runtime?.reason || '运行服务尚未配置。'}</p><p>凭据和模型由服务管理员配置；成员可在各节点选择可用模型。</p><button autoFocus onClick={() => setSettingsOpen(false)}>关闭</button></section></div>}
  </div>;
}

function DraftRecovery({ controls, record, drafts, error, hasJournal, onRestore, onDiscard, onUseCloud }: {
  controls: React.ReactNode; record: CanvasRecord | null; drafts: SavedCanvasDraft[]; error: string; hasJournal: boolean;
  onRestore: (saved: SavedCanvasDraft) => void; onDiscard: (saved: SavedCanvasDraft) => void; onUseCloud: () => void;
}) {
  const [selectedKey, setSelectedKey] = useState(drafts[0]?.key || '');
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const selected = drafts.find(saved => saved.key === selectedKey) || drafts[0];
  const canRestore = Boolean(record && selected?.draft && selected.draft.baseVersion === record.version);
  return <main className="saas-dashboard"><header><a href="/" className="saas-logo">AwwO</a>{controls}</header><section className="saas-page-intro"><h1>发现未同步的本机草稿</h1><p role="status">本机修改已保留。确认如何处理后才会打开编辑器；重新加载不会丢弃草稿。</p></section>
    {error && <p className="saas-error" role="alert">{error}</p>}
    <section className="saas-card saas-draft-recovery"><label>选择本机草稿<select aria-label="选择本机草稿" value={selected?.key || ''} onChange={event => { setSelectedKey(event.target.value); setConfirmDiscard(false); }}>{drafts.map((saved, index) => <option key={saved.key} value={saved.key}>草稿 {index + 1}{saved.draft ? ` · ${new Date(saved.draft.updatedAt).toLocaleString('zh-CN')}` : ' · 需要人工检查'}</option>)}</select></label>
      {selected?.draft ? <><p>草稿基于云端版本 {selected.draft.baseVersion}；当前云端版本 {record?.version ?? '读取中'}。</p><p>包含节点：{selected.draft.document.nodes.map(node => node.title).join('、') || '空画布'}</p>{record && !canRestore && <p className="saas-error">云端版本已有变化。请导出草稿后核对，当前草稿不会自动覆盖较新的云端内容。</p>}</> : <p className="saas-error">草稿格式无法自动恢复。原始内容仍可导出，尚未删除。</p>}
      {hasJournal && <p>本机还保存着待恢复运行记录。请保留草稿并核对运行；版本一致时可恢复编辑器继续处理。</p>}
      <div className="saas-draft-actions"><button onClick={() => {
        const url = URL.createObjectURL(new Blob([selected.draft ? JSON.stringify(selected.draft.document, null, 2) : selected.raw], { type: 'application/json' }));
        const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'awwo-unsynced-draft.json'; anchor.click(); URL.revokeObjectURL(url);
      }}>导出未同步草稿</button><button disabled={!canRestore} onClick={() => onRestore(selected)}>恢复草稿并继续同步</button>
      {!hasJournal && record && <><button onClick={onUseCloud}>使用云端版本，保留草稿</button><button onClick={() => setConfirmDiscard(true)}>丢弃这份本机草稿</button></>}</div>
      {confirmDiscard && <div role="alert"><p>确定丢弃所选草稿？该草稿中尚未同步的修改将被删除。</p><button onClick={() => { onDiscard(selected); setConfirmDiscard(false); }}>确认丢弃</button><button onClick={() => setConfirmDiscard(false)}>保留草稿</button></div>}
      <button onClick={() => window.location.reload()}>重新连接云端</button>
    </section>
  </main>;
}

function Admin({ identity }: { identity: Identity }) {
  const [tab, setTab] = useState('tenants');
  const [rows, setRows] = useState<any[] | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (identity.user.platformRole !== 'admin') return;
    const controller = new AbortController(); setRows(null); setError('');
    api<any>(`/admin/${tab}`, { signal: controller.signal }).then(value => setRows(value.items))
      .catch(error => { if (!controller.signal.aborted) setError(message(error)); });
    return () => controller.abort();
  }, [tab, revision, identity.user.platformRole]);
  if (identity.user.platformRole !== 'admin') return <main className="saas-notice"><h1>无平台管理权限</h1><p>请联系平台管理员。</p><a href="/">返回工作区</a></main>;
  const tabs = { tenants: '租户', users: '用户', runs: '运行', audit: '审计日志' };
  return <main className="saas-dashboard"><header><a href="/" className="saas-logo">AwwO</a><a href="/">返回工作区</a><WorkspaceControls identity={identity} /></header><section className="saas-page-intro"><span className="saas-eyebrow">ADMINISTRATION</span><h1>平台管理</h1><p>租户状态、成员与执行记录。</p></section>
    <nav className="saas-tabs">{Object.entries(tabs).map(([key, name]) => <button key={key} aria-pressed={tab === key} onClick={() => setTab(key)}>{name}</button>)}<button aria-label="刷新数据" onClick={() => setRevision(value => value + 1)}><RefreshCw size={16}/></button></nav>
    {error && <p role="alert" className="saas-error">{error}</p>}
    {!rows ? <p role="status">正在加载…</p> : <div className="saas-table-wrap"><table><thead><tr>{tab === 'tenants' ? <><th>工作区</th><th>状态</th><th>并发 / 每日次数</th><th>操作</th></> : tab === 'users' ? <><th>用户</th><th>邮箱</th><th>平台角色</th></> : tab === 'runs' ? <><th>运行</th><th>租户</th><th>状态</th><th>创建时间</th></> : <><th>操作</th><th>操作者</th><th>租户</th><th>时间</th></>}</tr></thead><tbody>{rows.map((row, index) => <tr key={row.id || index}>{tab === 'tenants' ? <><td>{row.name}</td><td>{row.status === 'active' ? '正常' : '已暂停'}</td><td>{row.maxConcurrentRuns} / {row.maxRunsPerDay}</td><td><button onClick={async () => {
      try { await api(`/admin/tenants/${encodeURIComponent(row.id)}`, { method: 'PATCH', body: JSON.stringify({ status: row.status === 'active' ? 'suspended' : 'active' }) }); setRevision(value => value + 1); } catch (error) { setError(message(error)); }
    }}>{row.status === 'active' ? '暂停工作区' : '恢复工作区'}</button></td></> : tab === 'users' ? <><td>{row.name}</td><td>{row.email}</td><td>{row.platformRole}</td></> : tab === 'runs' ? <><td>{row.id}</td><td>{row.tenantId}</td><td>{row.status}</td><td>{row.createdAt}</td></> : <><td>{row.action}</td><td>{row.actorId || row.userId}</td><td>{row.tenantId || '—'}</td><td>{row.createdAt}</td></>}</tr>)}</tbody></table>{rows.length === 0 && <p>暂无记录。</p>}</div>}
  </main>;
}
