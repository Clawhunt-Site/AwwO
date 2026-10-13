// Invites a free workspace to pay for Claude Opus 5.5 where the model is chosen in the canvas (owner request
// 2026-10-13: 在画布里面鼓励用户支付付费享受opus5.5的模型能力). Opus 5.5 stays usable on the free allowance (owner
// 2026-10-11: every advanced model open to free users); what Pro and Max add is using it on credits, past the free daily
// calls. So it is shown only where that is true, a route-limited workspace without a paid plan: a paid or an unlimited
// workspace never sees it, and nothing here refuses or gates a model.
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
 * `enabled` is false. `free` is a route-limited workspace without a paid plan; an unreadable allowance is never free. */
export function useFreeAllowance(tenantId: string, enabled = true) {
  const [usage, setUsage] = useState<RouteUsage | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    fetchRouteUsage(tenantId, controller.signal).then(value => { if (!controller.signal.aborted) setUsage(value); }).catch(() => {});
    return () => controller.abort();
  }, [tenantId, revision, enabled]);
  return { usage, free: enabled && usage !== null && usage.limited === true && !usage.plan, refresh: () => setRevision(value => value + 1) };
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
  const today = !included ? t('这个工作区的免费额度不含它。', 'This workspace’s free allowance does not include it.')
    : left === 0 ? t('今天的免费次数已经用完。', 'Today’s free calls are used up.')
      : left !== null ? t(`这个工作区今天还能免费用 ${left} 次。`, `This workspace has ${left} free ${left === 1 ? 'call' : 'calls'} left today.`)
        : t('免费版每天有少量次数。', 'The free plan has a few calls a day.');
  return <div className="saas-opus-upsell" role="note">
    <p className="saas-opus-upsell-title"><Sparkles size={14} aria-hidden="true" />{t('Claude Opus 5.5 · 这里最强的模型', 'Claude Opus 5.5 · the strongest model here')}</p>
    <p>{t('复杂的网页、游戏、3D 和长流程交给它，做得更完整，返工更少。', 'Give it complex pages, games, 3D and long workflows: more complete results, less rework.')}</p>
    <p className="saas-opus-upsell-allowance">{today}{' '}
      {t('升级 Pro / Max，用点数畅用 Opus 5.5，不受每天免费次数的限制。', 'Pro and Max run Opus 5.5 on credits, past the free daily calls.')}</p>
    <div className="saas-opus-upsell-actions">
      {included && !chosen && left !== 0 && onChoose && <button type="button" className="saas-opus-upsell-choose" onClick={onChoose}>{t('换成 Opus 5.5', 'Switch to Opus 5.5')}</button>}
      <a className="saas-opus-upsell-upgrade" href={accountURL('plans')} target="_blank" rel="noopener noreferrer"
        onClick={() => { void recordUpgradeInterest(tenantId).catch(() => {}); }}>{t('升级 Pro / Max', 'Upgrade to Pro or Max')}</a>
    </div>
  </div>;
}
