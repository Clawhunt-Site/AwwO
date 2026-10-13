// Invites a workspace without a paid plan to Claude Opus 5.5 where the model is chosen in the canvas (owner requests
// 2026-10-13: 在画布里面鼓励用户支付付费享受opus5.5的模型能力, then Opus 5.5 改成只给付费用户). Opus 5.5 runs only on
// Pro and Max, or in the operator's own workspaces: the server marks it requiresUpgrade for every other workspace and
// refuses a call on it (plan_only_models.go). So the card says it is Pro and Max's and opens the plans; a paid or an
// operator workspace never sees it. Only where the server still offers it on the free allowance (AWWO_PLAN_ONLY_MODELS
// set to "none") does the card count today's free calls and switch to it.
import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { accountURL } from './PersonalAccount';
import { useSaaSPreferences } from './preferences';
import { fetchRouteUsage, recordUpgradeInterest, routeOrder, type RouteName, type RouteUsage } from './routeUsage';
import './opus-upsell.css';

/** The model this invites to: the strongest one the canvas offers. */
export const OPUS_MODEL_ID = 'bedrock.claude-opus-5-5';

/** Whose allowance an offered model spends: the route the server names, else what its id says. */
export function modelRoute(model: { id: string; route?: string }): RouteName | undefined {
  if (model.route && (routeOrder as string[]).includes(model.route)) return model.route as RouteName;
  return model.id.startsWith('bedrock.') ? 'bedrock' : undefined;
}

/** This workspace's allowance, read when the canvas opens and again on request (a menu opening); not read at all while
 * `enabled` is false. `free` is a route-limited workspace without a paid plan, `unpaid` any workspace without one (a
 * reader is never told the plan, so it reads as unpaid too); an unreadable allowance is neither. */
export function useFreeAllowance(tenantId: string, enabled = true) {
  const [usage, setUsage] = useState<RouteUsage | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    fetchRouteUsage(tenantId, controller.signal).then(value => { if (!controller.signal.aborted) setUsage(value); }).catch(() => {});
    return () => controller.abort();
  }, [tenantId, revision, enabled]);
  const unpaid = enabled && usage !== null && !usage.plan;
  return { usage, free: unpaid && usage?.limited === true, unpaid, refresh: () => setRevision(value => value + 1) };
}

/** The invitation: what Opus 5.5 is for, what is left of today's free calls, and the way to a plan. The plans page opens in
 * a new tab so the canvas and its draft stay put; a click records the interest the operator reads, as PlanUpsell does. */
export function OpusUpsell({ tenantId, usage, route, chosen, available, onChoose }: {
  tenantId: string; usage: RouteUsage; route: RouteName | undefined;
  /** Opus 5.5 is the model chosen now. */ chosen: boolean;
  /** Opus 5.5 is on offer here and in this workspace's free allowance, so switching to it can run. */ available: boolean;
  /** Switches to Opus 5.5; absent while the model cannot be changed. */ onChoose?: () => void;
}) {
  const { t } = useSaaSPreferences();
  const allowance = route ? usage.routes?.[route] : undefined;
  const left = allowance && allowance.limit > 0 ? Math.max(0, allowance.limit - allowance.used) : null;
  const included = available && allowance?.limit !== 0;
  const today = !included ? t('Pro / Max 专享：升级后按点数使用，不受次数限制。', 'Pro and Max only: upgrade and run it on credits, with no daily limit.')
    : left === 0 ? t('今天的免费次数已用完；升级 Pro / Max 用点数接着用。', 'Today’s free calls are used up; Pro and Max carry on with credits.')
      : left !== null ? t(`今天还能免费用 ${left} 次；升级 Pro / Max 用点数畅用，不受次数限制。`, `${left} free ${left === 1 ? 'call' : 'calls'} left today; Pro and Max run it on credits, past that limit.`)
        : t('免费版每天有少量次数；升级 Pro / Max 用点数畅用。', 'The free plan has a few calls a day; Pro and Max run it on credits.');
  return <div className="saas-opus-upsell" role="note">
    <p className="saas-opus-upsell-title"><Sparkles size={14} aria-hidden="true" />{t('Claude Opus 5.5 · 这里最强的模型', 'Claude Opus 5.5 · the strongest model here')}</p>
    <p>{t('复杂网页、游戏和 3D 交给它，做得更完整。', 'Complex pages, games and 3D come out more complete.')}{' '}
      <span className="saas-opus-upsell-allowance">{today}</span></p>
    <div className="saas-opus-upsell-actions">
      {included && !chosen && left !== 0 && onChoose && <button type="button" className="saas-opus-upsell-choose" onClick={onChoose}>{t('换成 Opus 5.5', 'Switch to Opus 5.5')}</button>}
      <a className="saas-opus-upsell-upgrade" href={accountURL('plans')} target="_blank" rel="noopener noreferrer"
        onClick={() => { void recordUpgradeInterest(tenantId).catch(() => {}); }}>{t('升级 Pro / Max', 'Upgrade to Pro or Max')}</a>
    </div>
  </div>;
}
