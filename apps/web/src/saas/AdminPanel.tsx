import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, saasErrorMessage, type Identity } from './api';
import { adminPage, collectAdminExport, downloadJSON, type AdminKind, type AdminRow } from './adminData';
import { useSaaSPreferences } from './preferences';
import './admin.css';

export function AdminPanel({ identity, controls }: { identity: Identity; controls?: ReactNode }) {
  const { t, locale } = useSaaSPreferences();
  const [tab, setTab] = useState<AdminKind>('tenants');
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [rows, setRows] = useState<AdminRow[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [revision, setRevision] = useState(0);
  const [editing, setEditing] = useState<AdminRow | null>(null);
  const [pending, setPending] = useState(false);
  const [exportCount, setExportCount] = useState<number | null>(null);
  const exporting = useRef<AbortController | null>(null);
  const isAdmin = identity.user.platformRole === 'admin';
  const cursor = cursors[cursors.length - 1];
  useEffect(() => {
    if (!isAdmin) return;
    const controller = new AbortController();
    setRows(null); setNextCursor(null); setError('');
    adminPage(tab, cursor, controller.signal).then(page => {
      if (!controller.signal.aborted) { setRows(page.items); setNextCursor(page.nextCursor); }
    }).catch(cause => { if (!controller.signal.aborted) setError(cause); });
    return () => controller.abort();
  }, [tab, cursor, revision, isAdmin]);
  useEffect(() => () => { exporting.current?.abort(); }, []);
  const refresh = () => { setCursors([null]); setRevision(value => value + 1); };
  const exportAll = async () => {
    const controller = new AbortController();
    exporting.current = controller; setExportCount(0); setError('');
    try {
      const result = await collectAdminExport(tab, controller.signal, setExportCount);
      downloadJSON(result, `awwo-${tab}-${new Date().toISOString().slice(0, 10)}.json`);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause);
    } finally { if (exporting.current === controller) { exporting.current = null; setExportCount(null); } }
  };
  const changeStatus = async (row: AdminRow) => {
    setPending(true); setError('');
    try {
      await api(`/admin/tenants/${encodeURIComponent(row.id)}`, { method: 'PATCH', body: JSON.stringify({ status: row.status === 'active' ? 'suspended' : 'active' }) });
      refresh();
    } catch (cause) { setError(cause); }
    finally { setPending(false); }
  };
  if (!isAdmin) return <main className="saas-notice"><h1>{t('无平台管理权限', 'Platform access denied')}</h1><p>{t('请联系平台管理员。', 'Contact a platform administrator.')}</p><a href="/">{t('返回工作区', 'Back to workspace')}</a></main>;
  const labels: Record<AdminKind, string> = { tenants: t('租户', 'Tenants'), users: t('用户', 'Users'), runs: t('运行', 'Runs'), audit: t('审计日志', 'Audit log') };
  const date = (value: string) => value ? new Date(value).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US') : '—';
  return <main className="saas-dashboard"><header><a href="/" className="saas-logo">AwwO</a><a href="/">{t('返回工作区', 'Back to workspace')}</a>{controls}</header>
    <section className="saas-page-intro"><span className="saas-eyebrow">ADMINISTRATION</span><h1>{t('平台管理', 'Platform administration')}</h1><p>{t('管理工作区状态与执行额度，查询用户、运行及审计记录。', 'Manage workspace status and run limits; inspect users, runs and audit records.')}</p></section>
    <nav className="saas-tabs" aria-label={t('管理分类', 'Administration sections')}>{Object.entries(labels).map(([key, label]) => <button key={key} disabled={pending || exportCount !== null} aria-pressed={tab === key} onClick={() => { setCursors([null]); setTab(key as AdminKind); }}>{label}</button>)}<button disabled={pending} onClick={refresh}>{t('刷新数据', 'Refresh')}</button></nav>
    <div className="saas-admin-tools"><p>{t('每页 50 条；导出会读取当前分类的全部分页，范围以首次查询时间限定。记录内容以各页读取时为准。', '50 records per page. Export reads all pages in this section, bounded by the first query time. Record values reflect when each page is read.')}</p>
      {exportCount === null ? <button onClick={exportAll}>{t('导出全部 JSON', 'Export all JSON')}</button> : <><span role="status">{t(`已读取 ${exportCount} 条`, `Read ${exportCount} records`)}</span><button onClick={() => exporting.current?.abort()}>{t('取消导出', 'Cancel export')}</button></>}
    </div>
    {Boolean(error) && <p role="alert" className="saas-error">{saasErrorMessage(error, locale)}</p>}
    {!rows ? <p role="status">{error ? t('数据加载失败，可刷新重试。', 'Loading failed. Refresh to retry.') : t('正在加载…', 'Loading…')}</p> : <div className="saas-table-wrap"><table><thead><tr>{tab === 'tenants' ? <><th>{t('工作区', 'Workspace')}</th><th>{t('状态', 'Status')}</th><th>{t('并发 / 每日次数', 'Concurrent / daily runs')}</th><th>{t('操作', 'Actions')}</th></> : tab === 'users' ? <><th>{t('用户', 'User')}</th><th>{t('邮箱', 'Email')}</th><th>{t('平台角色', 'Platform role')}</th></> : tab === 'runs' ? <><th>{t('运行', 'Run')}</th><th>{t('租户', 'Tenant')}</th><th>{t('状态', 'Status')}</th><th>{t('创建时间', 'Created')}</th></> : <><th>{t('操作', 'Action')}</th><th>{t('操作者', 'Actor')}</th><th>{t('租户', 'Tenant')}</th><th>{t('时间', 'Time')}</th></>}</tr></thead><tbody>{rows.map(row => <tr key={row.id}>{tab === 'tenants' ? <><td>{row.name}</td><td>{row.status === 'active' ? t('正常', 'Active') : t('已暂停', 'Suspended')}</td><td>{row.maxConcurrentRuns} / {row.maxRunsPerDay}</td><td className="saas-admin-actions"><button disabled={pending} onClick={() => setEditing(row)}>{t('编辑配额', 'Edit limits')}</button><button disabled={pending} onClick={() => changeStatus(row)}>{row.status === 'active' ? t('暂停工作区', 'Suspend workspace') : t('恢复工作区', 'Resume workspace')}</button></td></> : tab === 'users' ? <><td>{row.name}</td><td>{row.email}</td><td>{row.platformRole}</td></> : tab === 'runs' ? <><td>{row.id}</td><td>{row.tenantId}</td><td>{row.status}</td><td>{date(row.createdAt)}</td></> : <><td>{row.action}</td><td>{row.actorId || '—'}</td><td>{row.tenantId || '—'}</td><td>{date(row.createdAt)}</td></>}</tr>)}</tbody></table>{rows.length === 0 && <p>{t('暂无记录。', 'No records.')}</p>}</div>}
    <div className="saas-admin-tools"><button disabled={pending || !rows || cursors.length === 1} onClick={() => setCursors(value => value.slice(0, -1))}>{t('上一页', 'Previous')}</button><span>{t(`第 ${cursors.length} 页`, `Page ${cursors.length}`)}</span><button disabled={pending || !rows || !nextCursor} onClick={() => setCursors(value => [...value, nextCursor])}>{t('下一页', 'Next')}</button></div>
    {editing && <QuotaEditor row={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh(); }} />}
  </main>;
}

function QuotaEditor({ row, onClose, onSaved }: { row: AdminRow; onClose: () => void; onSaved: () => void }) {
  const { t, locale } = useSaaSPreferences();
  const [concurrent, setConcurrent] = useState(String(row.maxConcurrentRuns));
  const [daily, setDaily] = useState(String(row.maxRunsPerDay));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return <div className="saas-dialog-backdrop"><form className="saas-card" role="dialog" aria-modal="true" aria-labelledby="saas-quota-title" onSubmit={async event => {
    event.preventDefault();
    const c = Number(concurrent), d = Number(daily);
    if (!Number.isInteger(c) || c < 1 || c > 100 || !Number.isInteger(d) || d < 1 || d > 100000) { setError(t('请输入范围内的整数。', 'Enter whole numbers within the allowed range.')); return; }
    setBusy(true); setError('');
    try { await api(`/admin/tenants/${encodeURIComponent(row.id)}`, { method: 'PATCH', body: JSON.stringify({ maxConcurrentRuns: c, maxRunsPerDay: d }) }); onSaved(); }
    catch (cause) { setError(cause); }
    finally { setBusy(false); }
  }}><h2 id="saas-quota-title">{t('编辑配额', 'Edit limits')} · {row.name}</h2><p>{t('新额度影响后续运行准入；减少额度不会终止已有运行。每日额度以 UTC 日期计算。', 'New limits apply to subsequent run admission. Lower limits do not terminate existing runs. Daily limits use UTC dates.')}</p>
    <label>{t('最大并发运行数', 'Maximum concurrent runs')}<input autoFocus required type="number" min="1" max="100" step="1" value={concurrent} onChange={event => setConcurrent(event.target.value)} /></label>
    <label>{t('每日运行上限', 'Daily run limit')}<input required type="number" min="1" max="100000" step="1" value={daily} onChange={event => setDaily(event.target.value)} /></label>
    {Boolean(error) && <p role="alert" className="saas-error">{saasErrorMessage(error, locale)}</p>}<button type="submit" disabled={busy}>{busy ? t('保存中…', 'Saving…') : t('保存配额', 'Save limits')}</button><button type="button" disabled={busy} onClick={onClose}>{t('取消', 'Cancel')}</button>
  </form></div>;
}
