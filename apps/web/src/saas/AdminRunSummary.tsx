import { useEffect, useRef, useState } from 'react';
import { api, type Identity } from './api';
import { useSaaSPreferences } from './preferences';

type Summary = { tenantCount: number; userCount: number; activeRuns: number; completedRuns: number; failedRuns: number };
const summaryKeys = ['tenantCount', 'userCount', 'activeRuns', 'completedRuns', 'failedRuns'] as const;
export function validAdminSummary(value: unknown): value is Summary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return summaryKeys.every(key => typeof record[key] === 'number' && Number.isSafeInteger(record[key]) && (record[key] as number) >= 0);
}
type State = { scope: string; status: 'loading' | 'error' } | { scope: string; status: 'ready'; data: Summary; readAt: string };

/** An explicit point-in-time read. Missing/invalid data must never look like an idle platform. */
export function AdminRunSummary({ identity }: { identity: Identity }) {
  return identity.user.platformRole === 'admin' ? <AdminSummaryRead key={identity.user.id} identity={identity}/> : null;
}
function AdminSummaryRead({ identity }: { identity: Identity }) {
  const { t, locale } = useSaaSPreferences();
  const isAdmin = identity.user.platformRole === 'admin';
  const scope = `${identity.user.id}:${identity.user.platformRole}`;
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<State>({ scope, status: 'loading' });
  const epoch = useRef(0);
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!isAdmin) return;
    const generation = ++epoch.current;
    const controller = new AbortController();
    request.current = controller;
    const current = () => epoch.current === generation && !controller.signal.aborted;
    setState({ scope, status: 'loading' });
    const timeout = window.setTimeout(() => {
      if (!current()) return;
      controller.abort();
      setState({ scope, status: 'error' });
    }, 30_000);
    api<unknown>('/admin/summary', { signal: controller.signal }).then(value => {
      if (!current()) return;
      if (!validAdminSummary(value)) { setState({ scope, status: 'error' }); return; }
      setState({ scope, status: 'ready', data: value, readAt: new Date().toISOString() });
    }).catch(() => {
      if (current()) setState({ scope, status: 'error' });
    }).finally(() => window.clearTimeout(timeout));
    return () => {
      controller.abort(); window.clearTimeout(timeout);
      if (request.current === controller) request.current = null;
    };
  }, [scope, isAdmin, revision]);
  if (!isAdmin) return null;
  // Hide another account's result synchronously, before the replacement effect runs.
  const visible = state.scope === scope ? state : { scope, status: 'loading' as const };
  const ready = visible.status === 'ready' ? visible : null;
  const refresh = () => {
    request.current?.abort(); epoch.current += 1;
    setState({ scope, status: 'loading' }); setRevision(value => value + 1);
  };
  return <section className="saas-admin-summary" aria-labelledby="admin-summary-title" aria-busy={visible.status === 'loading'}>
    <div className="saas-admin-summary-heading"><div><h2 id="admin-summary-title">{t('全站运行概览', 'Platform run overview')}</h2>
      <p>{t('按读取时刻统计；不自动刷新。', 'A point-in-time snapshot; refresh to update.')}</p></div>
      <button type="button" disabled={visible.status === 'loading'} onClick={refresh}>{t('刷新概览', 'Refresh overview')}</button></div>
    {ready ? <><dl className="saas-admin-summary-values">
      <div className="saas-admin-summary-active"><dt>{t('执行中任务（排队 + 运行）', 'Active tasks (queued + running)')}</dt><dd>{ready.data.activeRuns.toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US')}</dd></div>
      <div><dt>{t('工作区总数', 'Workspaces')}</dt><dd>{ready.data.tenantCount.toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US')}</dd></div>
      <div><dt>{t('用户总数', 'Users')}</dt><dd>{ready.data.userCount.toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US')}</dd></div>
      <div><dt>{t('已完成运行', 'Completed runs')}</dt><dd>{ready.data.completedRuns.toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US')}</dd></div>
      <div><dt>{t('失败或中断', 'Failed or interrupted')}</dt><dd>{ready.data.failedRuns.toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US')}</dd></div>
    </dl><p className="saas-admin-summary-time">{t('读取于', 'Read at')} <time dateTime={ready.readAt}>{new Date(ready.readAt).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US')}</time></p></>
      : visible.status === 'loading' ? <p role="status">{t('正在读取全站运行状态…', 'Reading platform run status…')}</p>
      : <p role="alert">{t('无法读取运行概览，当前任务数量未知。请检查登录权限或稍后刷新。', 'Run overview unavailable; the current task count is unknown. Check your access or refresh later.')}</p>}
  </section>;
}
