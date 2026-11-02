import { useEffect, useState } from 'react';
import { api, saasErrorMessage } from './api';
import { useSaaSPreferences } from './preferences';

/** One path of the prompt cache view (the API's adminPromptCache): a runtime, the kind of session its runs belong to,
 *  and a model, with its tokens as decimal strings and its read share beside the window before. The share is of the
 *  calls whose cache read the provider reported (cacheKnownCalls of calls). */
export interface PromptCachePath {
  runtime: string; kind: string; model: string; calls: number; cacheKnownCalls: number;
  inputTokens: string | null; cachedInputTokens: string | null; cacheWriteTokens: string | null; outputTokens: string | null;
  readShare: number | null; previous: { calls: number; cacheKnownCalls: number; readShare: number | null }; falling: boolean;
}
export interface PromptCacheView { days: number; asOf: string; alert: { drop: number; calls: number }; paths: PromptCachePath[] }

const count = (x: unknown) => typeof x === 'number' && Number.isInteger(x) && x >= 0;
const tokens = (x: unknown) => x === null || typeof x === 'string' && /^\d+$/.test(x);
const fraction = (x: unknown) => x === null || typeof x === 'number' && Number.isFinite(x) && x >= 0;
const isPath = (x: unknown): x is PromptCachePath => {
  const p = x as PromptCachePath | null;
  return !!p && typeof p.runtime === 'string' && typeof p.kind === 'string' && typeof p.model === 'string' && count(p.calls) && count(p.cacheKnownCalls)
    && tokens(p.inputTokens) && tokens(p.cachedInputTokens) && tokens(p.cacheWriteTokens) && tokens(p.outputTokens) && fraction(p.readShare)
    && typeof p.falling === 'boolean' && !!p.previous && count(p.previous.calls) && count(p.previous.cacheKnownCalls) && fraction(p.previous.readShare);
};
function checked(value: unknown, days: number): PromptCacheView {
  const v = value as Partial<PromptCacheView> | null;
  if (!v || v.days !== days || typeof v.asOf !== 'string' || !v.alert || !fraction(v.alert.drop) || !count(v.alert.calls) || !Array.isArray(v.paths)
    || !v.paths.every(isPath)) throw new Error('The prompt cache view returned incomplete data.');
  return v as PromptCacheView;
}

export function readPromptCache(days: number, signal?: AbortSignal) {
  return api<unknown>(`/admin/observability/cache?days=${days}`, { signal }).then(value => checked(value, days));
}

/** The 提示缓存 tab of platform administration: for each path, how much of its prompts the provider's cache read and
 *  wrote over the last days, beside the days before; a path whose share fell is marked, so that a change to a prompt
 *  that breaks its cache is seen. revision changing (the panel's refresh) reads it again, for the same days. */
export function AdminPromptCache({ revision = 0 }: { revision?: number }) {
  const { t, locale } = useSaaSPreferences();
  const [days, setDays] = useState(7);
  const [view, setView] = useState<PromptCacheView | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    const controller = new AbortController();
    setView(null); setError(null);
    readPromptCache(days, controller.signal).then(value => { if (!controller.signal.aborted) setView(value); },
      cause => { if (!controller.signal.aborted) setError(cause); });
    return () => controller.abort();
  }, [days, revision]);
  // Token totals may pass what a JavaScript number holds exactly: they are grouped as the integers they are.
  const number = (value: string | null) => value === null ? '—' : BigInt(value).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US');
  const share = (value: number | null) => value === null ? '—' : `${(value * 100).toFixed(1)}%`;
  const known = (known: number, calls: number) => known < calls ? t(`（${known} 次报告了缓存）`, ` (${known} reported the cache)`) : '';
  const kind = (value: string) => ({ node: t('画布节点', 'Canvas node'), planner: t('规划器', 'Planner'), computer: t('直接执行', 'Managed execution'),
    knowledge: t('资料库', 'Knowledge'), '': t('其他', 'Other') } as Record<string, string>)[value] ?? value;
  return <section className="saas-admin-cache" aria-label={t('提示缓存', 'Prompt cache')}>
    <p className="saas-admin-note">{t('每条路径（引擎 · 会话类型 · 模型）的提示有多少被服务商的缓存读到、写入，与之前同样长的一段时间对比。读到比例只算服务商报告了缓存的调用；两段各至少 20 次这样的调用、读到比例下降 20 个百分点及以上的标为「下降」，多半是改提示词弄坏了缓存。',
      'For each path (runtime · kind of session · model), how much of its prompts the provider’s cache read and wrote, beside the same number of days before. The read share counts only the calls whose cache the provider reported; a path with at least 20 such calls in both whose share fell by 20 points or more is marked falling, most often a prompt change that broke its cache.')}</p>
    <label className="saas-admin-days">{t('天数', 'Days')}
      <select value={days} onChange={event => setDays(Number(event.target.value))}>
        {[1, 7, 14, 30].map(n => <option key={n} value={n}>{n}</option>)}
      </select>
    </label>
    {error !== null && <p className="saas-error" role="alert">{saasErrorMessage(error, locale)}</p>}
    {!view ? (error === null && <p role="status">{t('正在加载…', 'Loading…')}</p>) : <div className="saas-table-wrap"><table>
      <thead><tr><th>{t('路径', 'Path')}</th><th>{t('调用', 'Calls')}</th><th>{t('提示 token', 'Prompt tokens')}</th><th>{t('缓存读到', 'Cache read')}</th>
        <th>{t('缓存写入', 'Cache written')}</th><th>{t('读到比例', 'Read share')}</th><th>{t('之前', 'Before')}</th></tr></thead>
      <tbody>{view.paths.map(path => <tr key={`${path.runtime}/${path.kind}/${path.model}`} className={path.falling ? 'saas-admin-falling' : undefined}>
        <td>{path.runtime} · {kind(path.kind)} · {path.model}</td><td>{path.calls}{known(path.cacheKnownCalls, path.calls)}</td><td>{number(path.inputTokens)}</td>
        <td>{number(path.cachedInputTokens)}</td><td>{number(path.cacheWriteTokens)}</td><td>{share(path.readShare)}{path.falling && <strong> {t('下降', 'Falling')}</strong>}</td>
        <td>{share(path.previous.readShare)}{path.previous.calls ? ` (${path.previous.calls})` : ''}</td></tr>)}</tbody>
    </table>{view.paths.length === 0 && <p>{t('这段时间没有记下用量的调用。', 'No calls with known usage in these days.')}</p>}</div>}
  </section>;
}
