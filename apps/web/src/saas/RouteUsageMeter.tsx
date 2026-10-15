import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { CalendarCheck, Gauge } from 'lucide-react';
import { Popover } from '../ui/Popover';
import { saasErrorMessage } from './api';
import { formatCredits, planName } from './billing';
import { accountURL } from './PersonalAccount';
import { useSaaSPreferences } from './preferences';
import { canCheckIn, checkIn, fetchRouteUsage, meterState, recordUpgradeInterest, routeOrder, routeUsedUp, type CheckinBonus, type CheckinState, type PromoView, type RouteName, type RouteUsage } from './routeUsage';
import './route-usage.css';

const REFRESH_MS = 120_000;

/** Today's free allowance of a route-limited workspace, and the "I want more calls" that tells the
 * operator who would pay; for a workspace on a paid plan, the owner's credits this period. A workspace with
 * neither shows nothing and stops asking. While a promotion offers check-ins, a chip beside the meter checks
 * the workspace in for today's bonus, and the meter's popover says what the promotion and the check-in give. */
export function RouteUsageMeter({ tenantId }: { tenantId: string }) {
  const { t, locale } = useSaaSPreferences();
  const [usage, setUsage] = useState<RouteUsage | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [recorded, setRecorded] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [checking, setChecking] = useState(false);
  const [checkedNow, setCheckedNow] = useState(false);
  const [checkError, setCheckError] = useState<unknown>(null);
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
  const names: Record<RouteName, string> = { gate: t('Claude / GPT 等', 'Claude / GPT and others'), bedrock: t('Bedrock（Opus 5.5 等）', 'Bedrock (Opus 5.5 and others)'), media: t('图片 / 视频', 'Images / video') };
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
  // A premium text route closed with 0 never offered a call: this workspace's free allowance does not include it.
  const premiumClosed = (['gate', 'bedrock'] as const).some(route => usage.routes?.[route]?.limit === 0);
  const interested = recorded || usage.interested;
  const ask = async () => {
    setBusy(true); setError(null);
    try { await recordUpgradeInterest(tenantId); setRecorded(true); }
    catch (cause) { setError(cause); }
    finally { setBusy(false); }
  };
  // The answer is today's check-in; the meter then reads the raised limits again.
  const check = async () => {
    setChecking(true); setCheckError(null);
    try {
      const { checkin } = await checkIn(tenantId);
      setUsage(value => value ? { ...value, checkin } : value);
      setCheckedNow(true);
    } catch (cause) { setCheckError(cause); }
    finally { setChecking(false); reload.current(); }
  };
  const checkin = usage.checkin;
  return <>
    {/* The chip opens the meter's popover too, where the check-in's result or refusal is said. */}
    {checkin && canCheckIn(checkin) && <button type="button" className="saas-checkin-trigger" disabled={checking} onClick={() => { setOpen(true); void check(); }}
      title={checkinOffer(checkin, locale)}><CalendarCheck size={16} aria-hidden="true" />{checking ? t('正在签到…', 'Checking in…') : t('签到领次数', 'Check in')}</button>}
    <button ref={anchor} type="button" className={`saas-route-usage-trigger${warn ? ' is-out' : ''}`} aria-haspopup="dialog" aria-expanded={open}
      onClick={() => { if (!open) reload.current(); setOpen(value => !value); }}><Gauge size={16} aria-hidden="true" />{label}</button>
    <Popover containKeyboard open={open} anchorRef={anchor} ariaLabel={t('今日免费额度', 'Today’s free allowance')} className="saas-route-usage" onClose={() => setOpen(false)}>
      <h2>{t('今日免费额度', 'Today’s free allowance')}</h2>
      <p>{t('每天 UTC 0 点重置。默认模型不单独限次，只占总次数。', 'Resets at 00:00 UTC. The default model has no limit of its own and only uses the daily total.')}</p>
      {usage.promo && <PromoNote promo={usage.promo} />}
      {checkin && <CheckinRow checkin={checkin} busy={checking} announced={checkedNow} onCheckIn={check} />}
      {Boolean(checkError) && <p role="alert" className="saas-error">{saasErrorMessage(checkError, locale)}</p>}
      <dl>
        <div className={state.kind === 'daily-out' ? 'is-out' : undefined}><dt>{t('总次数', 'All calls')}</dt><dd>{Math.min(usage.daily.used, usage.daily.limit)} / {usage.daily.limit}</dd></div>
        {usage.planner && <PlannerRow allowance={usage.planner} />}
        {routeOrder.map(route => {
          const allowance = usage.routes?.[route];
          return <div key={route} className={routeUsedUp(allowance) ? 'is-out' : undefined}><dt>{names[route]}</dt>
            <dd>{!allowance ? t('不单独限次', 'No limit of its own') : allowance.limit === 0 ? t('不含', 'Not included') : `${Math.min(allowance.used, allowance.limit)} / ${allowance.limit}`}</dd></div>;
        })}
      </dl>
      {state.kind === 'daily-out' && <p className="saas-route-usage-out">{t('今天的总次数已用完，所有模型都要等到 UTC 0 点后才能再运行。', 'Today’s calls are used up; no model can run again until 00:00 UTC.')}</p>}
      {premiumClosed && <p className="saas-route-usage-out">{t('标着「不含」的高级模型不在这个工作区的免费额度里，需要 Pro / Max 套餐，按点数使用。', 'Premium models marked Not included are outside this workspace’s free allowance; they need the Pro or Max plan and run on credits.')}</p>}
      {interested && <p role="status" className="saas-route-usage-recorded">{t('已记录你的需求。现在就能升级 Pro / Max，用点数继续使用高级模型。', 'Noted. You can upgrade to Pro or Max now and keep using premium models on credits.')}</p>}
      {/* Paid plans are on sale, so upgrading is the way to more calls; a click still records the interest the
          admin panel lists, without waiting for it before the plans open. */}
      <a className="saas-primary" href={accountURL('plans')} target="_blank" rel="noopener noreferrer"
        onClick={() => { void recordUpgradeInterest(tenantId).catch(() => {}); }}>{t('升级 Pro / Max', 'Upgrade to Pro or Max')}</a>
      <button type="button" className="saas-route-usage-ask" disabled={busy} onClick={ask}>{busy ? t('正在记录…', 'Recording…') : interested ? t('我还需要更多次数', 'I still need more calls') : t('想要更多次数', 'I want more calls')}</button>
      {Boolean(error) && <p role="alert" className="saas-error">{saasErrorMessage(error, locale)}</p>}
    </Popover>
  </>;
}

/** The canvas assistant's free changes today: their own daily number, outside the calls counted above. */
function PlannerRow({ allowance }: { allowance: NonNullable<RouteUsage['planner']> }) {
  const { t } = useSaaSPreferences();
  return <div className={allowance.used >= allowance.limit ? 'is-out' : undefined}>
    <dt>{t('助手改画布（免费，不占总次数）', 'Assistant canvas changes (free, outside the daily calls)')}</dt>
    <dd>{Math.min(allowance.used, allowance.limit)} / {allowance.limit}</dd>
  </div>;
}

/** What a bonus adds, in the reader's language: calls, and generations where this workspace gets any. */
function bonusText({ daily, media }: CheckinBonus, locale: 'zh' | 'en'): string {
  if (locale === 'zh') return media > 0 ? `${daily} 次调用和 ${media} 次图片 / 视频生成` : `${daily} 次调用`;
  return media > 0 ? `${daily} more calls and ${media} more image / video generations` : `${daily} more calls`;
}

/** What one check-in gives this workspace today, in the reader's language. */
function checkinOffer(checkin: CheckinState, locale: 'zh' | 'en'): string {
  return locale === 'zh' ? `签到：今天再多 ${bonusText(checkin.bonus, locale)}` : `Check in for ${bonusText(checkin.bonus, locale)} today`;
}

/** A promotion's limited-time allowances and when they end, in the reader's own time. */
function PromoNote({ promo }: { promo: PromoView }) {
  const { t, locale } = useSaaSPreferences();
  const until = new Date(promo.until).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const media = promo.routes?.media;
  return <p className="saas-route-usage-promo">{media
    ? t(`限时放开：到 ${until}，免费版每天 ${promo.daily} 次调用、${media} 次图片 / 视频生成，下面的数字已经算上。`, `Limited time: until ${until}, the free plan has ${promo.daily} calls and ${media} image / video generations a day; the numbers below include it.`)
    : t(`限时放开：到 ${until}，免费版每天 ${promo.daily} 次调用，下面的数字已经算上。`, `Limited time: until ${until}, the free plan has ${promo.daily} calls a day; the numbers below include it.`)}</p>;
}

/** Today's check-in: the button while this person can still check in, otherwise what today's check-in gave or why
 * there is none to make. announced is set once this person checked in from this page, to say so to a screen reader. */
function CheckinRow({ checkin, busy, announced, onCheckIn }: { checkin: CheckinState; busy: boolean; announced: boolean; onCheckIn: () => void }) {
  const { t, locale } = useSaaSPreferences();
  if (checkin.checkedIn) {
    const got = checkin.today ?? checkin.bonus;
    return <p role={announced ? 'status' : undefined} className="saas-route-usage-checkin is-done">
      {locale === 'zh' ? `今天已签到，多了 ${bonusText(got, locale)}` : `Checked in today: ${bonusText(got, locale)}`}
      {checkin.streak > 1 ? t(` · 已连续签到 ${checkin.streak} 天`, ` · ${checkin.streak} days in a row`) : ''}</p>;
  }
  if (checkin.taken) return <p className="saas-route-usage-checkin">{t('这个工作区今天已经有成员签到了，多出的次数已经加上。', 'Another member checked this workspace in today; the extra calls are already added.')}</p>;
  if (checkin.elsewhere) return <p className="saas-route-usage-checkin">{t('你今天已经在另一个工作区签到了，每人每天签一次。', 'You checked in another workspace today; it is one check-in a person a day.')}</p>;
  return <>
    <button type="button" className="saas-route-usage-checkin-button" disabled={busy} onClick={onCheckIn}>
      <CalendarCheck size={16} aria-hidden="true" />{busy ? t('正在签到…', 'Checking in…') : checkinOffer(checkin, locale)}</button>
    {checkin.streak > 0 && <p className="saas-route-usage-checkin">{t(`已连续签到 ${checkin.streak} 天，今天签了接着算。`, `${checkin.streak} days in a row so far; check in today to keep it going.`)}</p>}
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
        {usage.planner && <PlannerRow allowance={usage.planner} />}
        {(credits.carried ?? 0) > 0 && <div><dt>{t('上期超支（本期扣除）', 'Carried from last period')}</dt><dd>{formatCredits(credits.carried ?? 0, locale)}</dd></div>}
      </dl>
      {empty && <p className="saas-route-usage-out">{!plan.owner ? t('本期点数已用完：可以把节点换成默认模型继续；需要更多点数请联系工作区所有者。', 'This period’s credits are used up: switch nodes to the default model to keep going; ask the workspace’s owner for more.')
        : plan.id === 'max' ? t('本期点数已用完：可以把节点换成默认模型继续，点数在续费后重置。', 'This period’s credits are used up: switch nodes to the default model to keep going. Credits reset at renewal.')
          : t('本期点数已用完：可以把节点换成默认模型继续，或在套餐页升级到 Max。', 'This period’s credits are used up: switch nodes to the default model to keep going, or upgrade to Max on the plans page.')}</p>}
      <a className="saas-route-usage-plans" href={accountURL('plans')}>{t('套餐与点数', 'Plans and credits')}</a>
    </Popover>
  </>;
}
