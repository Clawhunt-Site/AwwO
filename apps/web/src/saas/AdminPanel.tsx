import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, saasErrorMessage, type Identity } from './api';
import { adminPage, collectAdminExport, downloadJSON, type AdminKind, type AdminRow } from './adminData';
import type { RouteName } from './routeUsage';
import { useSaaSPreferences } from './preferences';
import { AdminRunSummary } from './AdminRunSummary';
import { DeletionDecisionDialog, deletionStatusLabel, type DeletionOutcome } from './DeletionDecision';
import { MarketReviewAdmin } from './market/MarketReviewAdmin';
import { useMarketSettings } from './market/useMarket';
import './admin.css';

/** The tabs: the paged record lists, and 市场审核 where this server has the Agent market (市场账单 while it is closed:
 *  what was earned still settles on monthly statements, approved there). */
type AdminTab = AdminKind | 'market';

export function AdminPanel({ identity, controls }: { identity: Identity; controls?: ReactNode }) {
  const { t, locale } = useSaaSPreferences();
  const [tab, setTab] = useState<AdminTab>('tenants');
  // The market is the service's: any workspace's capabilities say whether this server has it.
  const market = useMarketSettings(identity.user.platformRole === 'admin' ? identity.tenants.find(item => item.status === 'active')?.id : null);
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [rows, setRows] = useState<AdminRow[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [revision, setRevision] = useState(0);
  const [editing, setEditing] = useState<AdminRow | null>(null);
  const [deciding, setDeciding] = useState<{ row: AdminRow; outcome: DeletionOutcome } | null>(null);
  const [pending, setPending] = useState(false);
  const [exportCount, setExportCount] = useState<number | null>(null);
  const exporting = useRef<AbortController | null>(null);
  const isAdmin = identity.user.platformRole === 'admin';
  const cursor = cursors[cursors.length - 1];
  useEffect(() => {
    if (!isAdmin || tab === 'market') return;
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
    if (tab === 'market') return;
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
  const labels: Partial<Record<AdminTab, string>> = { tenants: t('租户', 'Tenants'), users: t('用户', 'Users'), runs: t('运行', 'Runs'), audit: t('审计日志', 'Audit log'), interests: t('付费意向', 'Upgrade interest'), deletions: t('删除申请', 'Deletion requests'),
    ...(market ? { market: t('市场审核', 'Market review') } : market === null ? { market: t('市场账单', 'Market statements') } : {}) };
  const date = (value: string) => value ? new Date(value).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US') : '—';
  return <main className="saas-dashboard"><header><a href="/" className="saas-logo">AwwO</a><a href="/">{t('返回工作区', 'Back to workspace')}</a>{controls}</header>
    <section className="saas-page-intro"><span className="saas-eyebrow">{t('仅平台管理员可见', 'Visible to platform administrators')}</span><h1>{t('平台管理', 'Platform administration')}</h1><p>{t('管理工作区状态与执行额度，查询用户、运行及审计记录。', 'Manage workspace status and run limits; inspect users, runs and audit records.')}</p></section>
    <AdminRunSummary key={identity.user.id} identity={identity} />
    <nav className="saas-tabs saas-admin-tabs" aria-label={t('管理分类', 'Administration sections')}>{Object.entries(labels).map(([key, label]) => <button key={key} disabled={pending || exportCount !== null} aria-pressed={tab === key} onClick={() => { setCursors([null]); setTab(key as AdminTab); }}>{label}</button>)}<button disabled={pending} onClick={refresh}>{t('刷新数据', 'Refresh')}</button></nav>
    {tab === 'market' ? <MarketReviewAdmin key={revision} open={Boolean(market)} /> : <>
    <div className="saas-admin-tools"><p>{t('每页 50 条；导出会读取当前分类的全部分页，范围以首次查询时间限定。记录内容以各页读取时为准。', '50 records per page. Export reads all pages in this section, bounded by the first query time. Record values reflect when each page is read.')}</p>
      {exportCount === null ? <button onClick={exportAll}>{t('导出全部 JSON', 'Export all JSON')}</button> : <><span role="status">{t(`已读取 ${exportCount} 条`, `Read ${exportCount} records`)}</span><button onClick={() => exporting.current?.abort()}>{t('取消导出', 'Cancel export')}</button></>}
    </div>
    {tab === 'deletions' && <p className="saas-admin-note">{t('用户在「设置 → 数据管理」里提交的删除账号申请。提交不会删除任何东西：人工核实后，先人工删除账号、再在这里标记已处理；或者拒绝并写明理由，对方会在数据管理里看到。处理前用户可以撤回。', 'Account deletion requests people send from Settings → Data management. A request deletes nothing: check it by hand, then either delete the account by hand and mark the request handled here, or decline it with a reason they see in Data management. People can withdraw one until it is decided.')}</p>}
    {tab === 'interests' && <p className="saas-admin-note">{t('用户在「今日额度」里点「升级 Pro / Max」或「想要更多次数」、或在因免费额度失败的运行里点升级后出现在这里，每人每个工作区一行；「提出时已用完」汇总每次提出时已经用完的额度；10 分钟内重复点击只算一次。', 'People appear here after choosing “Upgrade to Pro or Max” or “I want more calls” in Today’s allowance, or the upgrade on a run that failed on the free allowance, one row per person and workspace. “Used up when asked” gathers what they had used up each time they asked; presses within 10 minutes count once.')}</p>}
    {Boolean(error) && <p role="alert" className="saas-error">{saasErrorMessage(error, locale)}</p>}
    {!rows ? <p role="status">{error ? t('数据加载失败，可刷新重试。', 'Loading failed. Refresh to retry.') : t('正在加载…', 'Loading…')}</p> : <div className="saas-table-wrap"><table><thead><tr>{tab === 'tenants' ? <><th>{t('工作区', 'Workspace')}</th><th>{t('状态', 'Status')}</th><th>{t('并发 / 每日次数', 'Concurrent / daily runs')}</th><th>{t('可用模型', 'Available models')}</th><th>{t('路由次数（每天）', 'Route limits (daily)')}</th><th>{t('操作', 'Actions')}</th></> : tab === 'deletions' ? <><th>{t('用户', 'User')}</th><th>{t('邮箱', 'Email')}</th><th>{t('原因', 'Reason')}</th><th>{t('状态', 'Status')}</th><th>{t('提出时间', 'Requested')}</th><th>{t('处理', 'Decision')}</th></> : tab === 'interests' ? <><th>{t('用户', 'User')}</th><th>{t('邮箱', 'Email')}</th><th>{t('工作区', 'Workspace')}</th><th>{t('提出时已用完', 'Used up when asked')}</th><th>{t('提出次数', 'Times asked')}</th><th>{t('首次', 'First')}</th><th>{t('最近', 'Latest')}</th></> : tab === 'users' ? <><th>{t('用户', 'User')}</th><th>{t('邮箱', 'Email')}</th><th>{t('平台角色', 'Platform role')}</th></> : tab === 'runs' ? <><th>{t('运行', 'Run')}</th><th>{t('租户', 'Tenant')}</th><th>{t('状态', 'Status')}</th><th>{t('创建时间', 'Created')}</th></> : <><th>{t('操作', 'Action')}</th><th>{t('操作者', 'Actor')}</th><th>{t('租户', 'Tenant')}</th><th>{t('时间', 'Time')}</th></>}</tr></thead><tbody>{rows.map(row => <tr key={row.id}>{tab === 'tenants' ? <><td>{row.name}</td><td>{row.status === 'active' ? t('正常', 'Active') : t('已暂停', 'Suspended')}</td><td>{row.maxConcurrentRuns} / {row.maxRunsPerDay}</td><td>{allowedModelsLabel(row.allowedModels, t)}</td><td>{routeLimitsLabel(row.routeLimits, t)}</td><td className="saas-admin-actions"><button disabled={pending} onClick={() => setEditing(row)}>{t('编辑配额', 'Edit limits')}</button><button disabled={pending} onClick={() => changeStatus(row)}>{row.status === 'active' ? t('暂停工作区', 'Suspend workspace') : t('恢复工作区', 'Resume workspace')}</button></td></> : tab === 'deletions' ? <><td>{row.userId ? row.name || '—' : (row.name || '') + t('（账号已删除）', ' (account deleted)')}</td><td>{row.email}</td><td>{row.reason || '—'}</td><td>{deletionStatusLabel(row.status, t)}</td><td>{date(row.createdAt)}</td><td>{row.status === 'pending' ? <><button disabled={pending || Boolean(row.userId)} title={row.userId ? t('先人工删除这个账号，才能标记已处理', 'Delete this account by hand first, then mark the request handled') : undefined} onClick={() => setDeciding({ row, outcome: 'handled' })}>{t('标记已处理', 'Mark handled')}</button><button disabled={pending || !row.userId} title={row.userId ? undefined : t('账号已删除，只能标记已处理', 'The account is deleted: mark the request handled')} onClick={() => setDeciding({ row, outcome: 'declined' })}>{t('拒绝…', 'Decline…')}</button></> : row.decidedAt ? `${date(row.decidedAt)}${row.decisionNote ? ' · ' + row.decisionNote : ''}` : '—'}</td></> : tab === 'interests' ? <><td>{row.userName}</td><td>{row.email}</td><td>{row.tenantName}</td><td>{routesLabel(row.routes, t)}</td><td>{row.clicks}</td><td>{date(row.createdAt)}</td><td>{date(row.lastAt)}</td></> : tab === 'users' ? <><td>{row.name}</td><td>{row.email}</td><td>{row.platformRole}</td></> : tab === 'runs' ? <><td>{row.id}</td><td>{row.tenantId}</td><td>{row.status}</td><td>{date(row.createdAt)}</td></> : <><td>{row.action}</td><td>{row.actorId || '—'}</td><td>{row.tenantId || '—'}</td><td>{date(row.createdAt)}</td></>}</tr>)}</tbody></table>{rows.length === 0 && <p>{t('暂无记录。', 'No records.')}</p>}</div>}
    <div className="saas-admin-tools"><button disabled={pending || !rows || cursors.length === 1} onClick={() => setCursors(value => value.slice(0, -1))}>{t('上一页', 'Previous')}</button><span>{t(`第 ${cursors.length} 页`, `Page ${cursors.length}`)}</span><button disabled={pending || !rows || !nextCursor} onClick={() => setCursors(value => [...value, nextCursor])}>{t('下一页', 'Next')}</button></div>
    </>}
    {editing && <QuotaEditor row={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh(); }} />}
    {deciding && <DeletionDecisionDialog row={deciding.row} outcome={deciding.outcome} onClose={() => setDeciding(null)} onDecided={() => { setDeciding(null); refresh(); }} onStale={refresh} />}
  </main>;
}

/** An absent list is unrestricted, a present-but-empty list blocks everything.
 * They must read differently or an operator cannot tell which one is stored. */
function allowedModelsLabel(value: unknown, t: (zh: string, en: string) => string): string {
  if (!Array.isArray(value)) return t('全部可用', 'All models');
  return value.length === 0 ? t('全部禁止', 'None') : value.join(', ');
}

const routeNames: Array<[RouteName, string, string]> = [['gate', 'Claude / GPT', 'Claude / GPT'], ['bedrock', 'Bedrock', 'Bedrock'], ['media', '图片视频', 'Images / video']];

/** Absent route limits are no limits; a stored object names each limited route. */
function routeLimitsLabel(value: unknown, t: (zh: string, en: string) => string): string {
  if (!value || typeof value !== 'object') return t('不限', 'None');
  const limits = value as Record<string, unknown>;
  const parts = routeNames.filter(([route]) => typeof limits[route] === 'number').map(([route, zh, en]) => `${t(zh, en)} ${limits[route] === 0 ? t('关闭', 'closed') : limits[route]}`);
  return parts.length ? parts.join(' · ') : t('不限', 'None');
}

/** What a person had used up when they asked for more: the daily total ("daily") and the routes. */
function routesLabel(value: unknown, t: (zh: string, en: string) => string): string {
  const routes = Array.isArray(value) ? value : [];
  const parts = [...(routes.includes('daily') ? [t('总次数', 'All calls')] : []), ...routeNames.filter(([route]) => routes.includes(route)).map(([, zh, en]) => t(zh, en))];
  return parts.length ? parts.join(t('、', ', ')) : t('提出时未用完', 'Nothing used up yet');
}

function QuotaEditor({ row, onClose, onSaved }: { row: AdminRow; onClose: () => void; onSaved: () => void }) {
  const { t, locale } = useSaaSPreferences();
  const [concurrent, setConcurrent] = useState(String(row.maxConcurrentRuns));
  const [daily, setDaily] = useState(String(row.maxRunsPerDay));
  const [restricted, setRestricted] = useState(Array.isArray(row.allowedModels));
  const [models, setModels] = useState(Array.isArray(row.allowedModels) ? row.allowedModels.join(', ') : '');
  // The entitlement is only sent when the operator actually touched it, so editing
  // a quota never rewrites an allowlist it was not shown editing.
  const [touched, setTouched] = useState(false);
  // Route limits follow the same rule: sent only when edited, so a quota edit never rewrites them.
  const stored = row.routeLimits && typeof row.routeLimits === 'object' ? row.routeLimits as Record<string, unknown> : null;
  const [routed, setRouted] = useState(stored !== null);
  const [routes, setRoutes] = useState<Record<RouteName, string>>(() => ({ gate: String(stored?.gate ?? ''), bedrock: String(stored?.bedrock ?? ''), media: String(stored?.media ?? '') }));
  const [routesTouched, setRoutesTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return <div className="saas-dialog-backdrop"><form className="saas-card" role="dialog" aria-modal="true" aria-labelledby="saas-quota-title" onSubmit={async event => {
    event.preventDefault();
    const c = Number(concurrent), d = Number(daily);
    if (!Number.isInteger(c) || c < 1 || c > 100 || !Number.isInteger(d) || d < 1 || d > 100000) { setError(t('请输入范围内的整数。', 'Enter whole numbers within the allowed range.')); return; }
    // Commas and whitespace cannot appear in a worker model id, which is what makes
    // them safe separators here.
    const ids = models.split(/[\s,]+/).filter(Boolean);
    if (touched && restricted && (ids.length > 64 || ids.some(id => id.length > 200))) { setError(t('最多 64 个模型 ID，每个不超过 200 字节。', 'At most 64 model ids, each up to 200 bytes.')); return; }
    // Hidden route fields are not checked: unticking the box drops them.
    const limits: Partial<Record<RouteName, number>> = {};
    for (const [route] of routed ? routeNames : []) {
      const raw = routes[route].trim();
      if (!raw) continue;
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 0 || value > 100000) { setError(t('路由次数请输入 0–100000 的整数。', 'Route limits must be whole numbers from 0 to 100000.')); return; }
      limits[route] = value;
    }
    if (routesTouched && routed && Object.keys(limits).length === 0) { setError(t('至少填写一项路由次数，或取消勾选。', 'Fill in at least one route limit, or clear the checkbox.')); return; }
    setBusy(true); setError('');
    const body: Record<string, unknown> = { maxConcurrentRuns: c, maxRunsPerDay: d };
    if (touched) body.allowedModels = restricted ? ids : null;
    if (routesTouched) body.routeLimits = routed ? limits : null;
    try { await api(`/admin/tenants/${encodeURIComponent(row.id)}`, { method: 'PATCH', body: JSON.stringify(body) }); onSaved(); }
    catch (cause) { setError(cause); }
    finally { setBusy(false); }
  }}><h2 id="saas-quota-title">{t('编辑配额', 'Edit limits')} · {row.name}</h2><p>{t('新额度影响后续运行准入；减少额度不会终止已有运行。每日额度以 UTC 日期计算。', 'New limits apply to subsequent run admission. Lower limits do not terminate existing runs. Daily limits use UTC dates.')}</p>
    <label>{t('最大并发运行数', 'Maximum concurrent runs')}<input autoFocus required type="number" min="1" max="100" step="1" value={concurrent} onChange={event => setConcurrent(event.target.value)} /></label>
    <label>{t('每日运行上限', 'Daily run limit')}<input required type="number" min="1" max="100000" step="1" value={daily} onChange={event => setDaily(event.target.value)} /></label>
    <label><input type="checkbox" checked={restricted} onChange={event => { setRestricted(event.target.checked); setTouched(true); }} />{t('限制可用模型', 'Restrict available models')}</label>
    {restricted && <label>{t('可用模型 ID（逗号或空格分隔）', 'Allowed model ids (comma or space separated)')}<input value={models} onChange={event => { setModels(event.target.value); setTouched(true); }} /></label>}
    <p>{t('留空表示禁止全部模型。被移除的模型在后续每次调用准入时都会被拒绝，但已经发出的调用不会被追溯终止；要立即掐断在途调用请暂停工作区。', 'An empty list blocks every model. A removed model is refused at every later invocation, but calls already sent are not terminated retroactively. Suspend the workspace to cut those off.')}</p>
    <label><input type="checkbox" checked={routed} onChange={event => { setRouted(event.target.checked); setRoutesTouched(true); }} />{t('按路由限每日次数', 'Limit daily calls per model route')}</label>
    {routed && routeNames.map(([route, zh, en]) => <label key={route}>{t(`${zh}（每天）`, `${en} (per day)`)}<input type="number" min="0" max="100000" step="1" placeholder={t('不限', 'No limit')} value={routes[route]} onChange={event => { const value = event.target.value; setRoutes(current => ({ ...current, [route]: value })); setRoutesTouched(true); }} /></label>)}
    <p>{t('路由次数算在每日上限之内；默认模型不受路由次数限制。留空表示该路由不限，0 表示关闭该路由。', 'Route limits count inside the daily limit; the default model is not route-limited. Leave a route empty for no limit; 0 closes it.')}</p>
    {Boolean(error) && <p role="alert" className="saas-error">{saasErrorMessage(error, locale)}</p>}<button type="submit" disabled={busy}>{busy ? t('保存中…', 'Saving…') : t('保存配额', 'Save limits')}</button><button type="button" disabled={busy} onClick={onClose}>{t('取消', 'Cancel')}</button>
  </form></div>;
}
