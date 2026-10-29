// A run made with a market Agent, beside the run's outcome: the Agent's fee and where it stands (held at admission,
// taken when the run completes or was stopped after the Agent had written, given back otherwise), and, on a run whose
// call was charged (it gave the caller the Agent's text, a free Agent's too), the 👍 / 👎 its rating counts in the
// Agent's ranking. Members and above rate; pressing the chosen one again takes the rating back.
import { useEffect, useState } from 'react';
import { ThumbsDown, ThumbsUp } from 'lucide-react';
import { api, saasErrorMessage, tenantPath } from '../api';
import { marketRunInfo, rateMarketRun, type MarketRating, type MarketRunInfo } from '../marketApi';
import { callStatusName, useMarketI18n } from './marketText';
import './market.css';

export function MarketRunFee({ tenantId, runId, market, completed, canRate }: { tenantId: string; runId: string; market: MarketRunInfo; completed: boolean; canRate: boolean }) {
  const { locale, t } = useMarketI18n();
  const [rating, setRating] = useState<MarketRating>(market.rating);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => { setRating(market.rating); }, [market.rating]);
  const rate = async (score: 1 | -1) => {
    if (busy) return;
    const next: MarketRating = rating === score ? 0 : score;
    setBusy(true); setError(null);
    try { setRating(await rateMarketRun(tenantId, runId, next)); }
    catch (cause) { setError(cause); }
    finally { setBusy(false); }
  };
  return <div className="awwo-market-run" role="group" aria-label={t('市场 Agent', 'Market Agent')}>
    <span>{market.insider ? t('作者本人或在作者自己的工作区里的调用：不收 Agent 费用，也不计入排行', 'A call by its author, or in a workspace its author owns: no Agent fee, and not counted in the ranking')
      : market.price > 0 ? t(`Agent 费用：每次 ${market.price} 点 · ${callStatusName(market.status, t)}`, `Agent fee: ${market.price} credits · ${callStatusName(market.status, t)}`)
        + (market.status === 'charged' && !completed ? t('（Agent 已经写出了内容，内容归你，所以照常计费）', ' (the Agent had written its text, which is yours, so it is charged)') : '')
      : t('免费 Agent，不收 Agent 费用', 'A free Agent: no Agent fee')}</span>
    {market.status === 'charged' && canRate && !market.insider && <>
      <span>{t('这次的效果：', 'How it went:')}</span>
      <button type="button" aria-pressed={rating === 1} aria-label={t('好评', 'Thumbs up')} disabled={busy} onClick={() => void rate(1)}><ThumbsUp size={12} aria-hidden="true" /></button>
      <button type="button" aria-pressed={rating === -1} aria-label={t('差评', 'Thumbs down')} disabled={busy} onClick={() => void rate(-1)}><ThumbsDown size={12} aria-hidden="true" /></button>
    </>}
    {error !== null && <span role="alert">{saasErrorMessage(error, locale)}</span>}
  </div>;
}

/** The run's market Agent, read from the run itself (GET /tenants/{t}/runs/{id}); null for a run made without one. */
export function useRunMarket(tenantId: string, runId: string | undefined): MarketRunInfo | null {
  const [read, setRead] = useState<{ runId: string; market: MarketRunInfo | null } | null>(null);
  useEffect(() => {
    if (!runId) return;
    const controller = new AbortController();
    api<{ market?: unknown }>(tenantPath(tenantId, `/runs/${encodeURIComponent(runId)}`), { signal: controller.signal })
      .then(run => { if (!controller.signal.aborted) setRead({ runId, market: marketRunInfo(run?.market) }); }, () => undefined);
    return () => controller.abort();
  }, [tenantId, runId]);
  return read && read.runId === runId ? read.market : null;
}
