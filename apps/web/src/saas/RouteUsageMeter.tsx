import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { Gauge } from 'lucide-react';
import { Popover } from '../ui/Popover';
import { saasErrorMessage } from './api';
import { formatCredits, planName } from './billing';
import { accountURL } from './PersonalAccount';
import { useSaaSPreferences } from './preferences';
import { fetchRouteUsage, meterState, recordUpgradeInterest, routeOrder, routeUsedUp, type RouteName, type RouteUsage } from './routeUsage';
import './route-usage.css';

const REFRESH_MS = 120_000;

/** Today's free allowance of a route-limited workspace, and the "I want more calls" that tells the
 * operator who would pay; for a workspace on a paid plan, the owner's credits this period. A workspace with
 * neither shows nothing and stops asking. */
export function RouteUsageMeter({ tenantId }: { tenantId: string }) {
  const { t, locale } = useSaaSPreferences();
  const [usage, setUsage] = useState<RouteUsage | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [recorded, setRecorded] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const anchor = useRef<HTMLButtonElement>(null);
  const reload = useRef<() => void>(() => {});
  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    reload.current = () => {
      fetchRouteUsage(tenantId, controller.signal).then(value => {
        if (controller.signal.aborted) return;
        setUsage(value);
        if (!value.limited && !value.plan) window.clearInterval(timer);
      }).catch(() => {});
    };
    reload.current();
    timer = window.setInterval(() => { if (document.visibilityState !== 'hidden') reload.current(); }, REFRESH_MS);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [tenantId]);
  if (!usage) return null;
  if (usage.plan) return <PaidMeter usage={usage} plan={usage.plan} open={open} setOpen={setOpen} reload={reload.current} />;
  if (!usage.limited) return null;
  const names: Record<RouteName, string> = { gate: t('Claude / GPT 等', 'Claude / GPT and others'), bedrock: t('Bedrock（Opus 5.5、Fable 5.1 等）', 'Bedrock (Opus 5.5, Fable 5.1 and others)'), media: t('图片 / 视频', 'Images / video') };
  const short: Record<RouteName, string> = { gate: 'Claude / GPT', bedrock: 'Bedrock', media: t('图片视频', 'images / video') };
  const state = meterState(usage);
  const left = state.left;
  const one = state.usedUp.length === 1 ? short[state.usedUp[0]] : null;
  const label = {
    'daily-out': t('今日次数已用完', 'No calls left today'),
    'premium-out': t(`剩 ${left} 次 · 高级次数已用完`, `${left} left · premium used up`),
    partial: one ? t(`剩 ${left} 次 · ${one} 已用完`, `${left} left · ${one} used up`) : t(`剩 ${left} 次 · 部分高级次数已用完`, `${left} left · some premium used up`),
    ok: t(`今日额度 · 剩 ${left} 次`, `Today · ${left} calls left`),
  }[state.kind];
  const warn = state.kind === 'daily-out' || state.kind === 'premium-out';
  const interested = recorded || usage.interested;
  const ask = async () => {
    setBusy(true); setError(null);
    try { await recordUpgradeInterest(tenantId); setRecorded(true); }
    catch (cause) { setError(cause); }
    finally { setBusy(false); }
  };
  return <>
    <button ref={anchor} type="button" className={`saas-route-usage-trigger${warn ? ' is-out' : ''}`} aria-haspopup="dialog" aria-expanded={open}
      onClick={() => { if (!open) reload.current(); setOpen(value => !value); }}><Gauge size={16} aria-hidden="true" />{label}</button>
    <Popover containKeyboard open={open} anchorRef={anchor} ariaLabel={t('今日免费额度', 'Today’s free allowance')} className="saas-route-usage" onClose={() => setOpen(false)}>
      <h2>{t('今日免费额度', 'Today’s free allowance')}</h2>
      <p>{t('每天 UTC 0 点重置。默认模型不单独限次，只占总次数。', 'Resets at 00:00 UTC. The default model has no limit of its own and only uses the daily total.')}</p>
      <dl>
        <div className={state.kind === 'daily-out' ? 'is-out' : undefined}><dt>{t('总次数', 'All calls')}</dt><dd>{Math.min(usage.daily.used, usage.daily.limit)} / {usage.daily.limit}</dd></div>
        {routeOrder.map(route => {
          const allowance = usage.routes?.[route];
          return <div key={route} className={routeUsedUp(allowance) ? 'is-out' : undefined}><dt>{names[route]}</dt>
            <dd>{!allowance ? t('不单独限次', 'No limit of its own') : allowance.limit === 0 ? t('不含', 'Not included') : `${Math.min(allowance.used, allowance.limit)} / ${allowance.limit}`}</dd></div>;
        })}
      </dl>
      {state.kind === 'daily-out' && <p className="saas-route-usage-out">{t('今天的总次数已用完，所有模型都要等到 UTC 0 点后才能再运行。', 'Today’s calls are used up; no model can run again until 00:00 UTC.')}</p>}
      {interested && <p role="status" className="saas-route-usage-recorded">{t('已记录，付费套餐上线时第一时间通知你。', 'Noted. We’ll tell you first when paid plans launch.')}</p>}
      <button type="button" className="saas-primary" disabled={busy} onClick={ask}>{busy ? t('正在记录…', 'Recording…') : interested ? t('我还需要更多次数', 'I still need more calls') : t('想要更多次数', 'I want more calls')}</button>
      <a className="saas-route-usage-plans" href={accountURL('plans')}>{t('查看 Pro / Max 付费套餐', 'See the Pro and Max plans')}</a>
      {Boolean(error) && <p role="alert" className="saas-error">{saasErrorMessage(error, locale)}</p>}
    </Popover>
  </>;
}

/** The chip of a workspace on a paid plan: the owner's credits left this period and today's calls. */
function PaidMeter({ usage, plan, open, setOpen, reload }: { usage: RouteUsage; plan: NonNullable<RouteUsage['plan']>; open: boolean; setOpen: Dispatch<SetStateAction<boolean>>; reload: () => void }) {
  const { t, locale } = useSaaSPreferences();
  const anchor = useRef<HTMLButtonElement>(null);
  const name = planName(plan.id);
  const credits = plan.credits;
  const dailyOut = usage.daily.used >= usage.daily.limit;
  const empty = credits.remaining <= 0;
  // The daily calls a plan counts are the default model's only: paid models keep running on the credits.
  const label = empty ? t(`${name} · 点数已用完`, `${name} · credits used up`) : dailyOut ? t(`${name} · 默认模型今日已用完`, `${name} · default model used up today`) : t(`${name} · 剩 ${formatCredits(credits.remaining, locale)} 点`, `${name} · ${formatCredits(credits.remaining, locale)} credits left`);
  const ends = plan.periodEnd ? new Date(plan.periodEnd).toLocaleDateString(locale === 'zh' ? 'zh-CN' : 'en-US', { month: 'long', day: 'numeric' }) : null;
  const period = !ends ? t('点数按套餐的计费周期发放，续费后重置。默认模型不扣点。', 'Credits come with each paid billing period and reset at renewal. The default model spends no credits.')
    : plan.cancelAtPeriodEnd ? t(`套餐将于 ${ends} 结束。`, `The plan ends on ${ends}.`)
      : t(`点数在 ${ends} 续费后重置。默认模型不扣点。`, `Credits reset once the plan renews on ${ends}. The default model spends no credits.`);
  return <>
    <button ref={anchor} type="button" className={`saas-route-usage-trigger${dailyOut || empty ? ' is-out' : ''}`} aria-haspopup="dialog" aria-expanded={open}
      onClick={() => { if (!open) reload(); setOpen(value => !value); }}><Gauge size={16} aria-hidden="true" />{label}</button>
    <Popover containKeyboard open={open} anchorRef={anchor} ariaLabel={t(`${name} 套餐`, `${name} plan`)} className="saas-route-usage" onClose={() => setOpen(false)}>
      <h2>{t(`${name} 套餐`, `${name} plan`)}</h2>
      <p>{period}</p>
      <dl>
        <div className={empty ? 'is-out' : undefined}><dt>{t('本期剩余点数', 'Credits left this period')}</dt><dd>{formatCredits(credits.remaining, locale)} / {formatCredits(credits.granted, locale)}</dd></div>
        <div className={dailyOut ? 'is-out' : undefined}><dt>{t('默认模型今日次数', 'Default-model calls today')}</dt><dd>{Math.min(usage.daily.used, usage.daily.limit)} / {usage.daily.limit}</dd></div>
        {(credits.carried ?? 0) > 0 && <div><dt>{t('上期超支（本期扣除）', 'Carried from last period')}</dt><dd>{formatCredits(credits.carried ?? 0, locale)}</dd></div>}
      </dl>
      {empty && <p className="saas-route-usage-out">{!plan.owner ? t('本期点数已用完：可以把节点换成默认模型继续；需要更多点数请联系工作区所有者。', 'This period’s credits are used up: switch nodes to the default model to keep going; ask the workspace’s owner for more.')
        : plan.id === 'max' ? t('本期点数已用完：可以把节点换成默认模型继续，点数在续费后重置。', 'This period’s credits are used up: switch nodes to the default model to keep going. Credits reset at renewal.')
          : t('本期点数已用完：可以把节点换成默认模型继续，或在套餐页升级到 Max。', 'This period’s credits are used up: switch nodes to the default model to keep going, or upgrade to Max on the plans page.')}</p>}
      <a className="saas-route-usage-plans" href={accountURL('plans')}>{t('套餐与点数', 'Plans and credits')}</a>
    </Popover>
  </>;
}
