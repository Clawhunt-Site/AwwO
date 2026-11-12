// The plan button in the bottom-left corner of every page but the home (owner 2026-11-12: 「整个会员套餐购买按钮就呈现在页面
// 左下角，买好的也能实时的看到自己的套餐等级」; asked where: on every page, the feedback button beside it). The home keeps
// its account card there (home/HomeAccountCard.tsx), which says the same and more. It reads the workspace's
// route-usage, as the card does: the plan is the workspace owner's, its level is the badge, and the credits left are
// beside it; a workspace on no plan is offered the plans. It reads again every two minutes, when the page is looked at
// again, and at once when the plans page says a plan has landed (ROUTE_USAGE_CHANGED), so a plan just bought shows
// without a reload. The feedback button keeps clear of it (data-feedback-avoid) and sits to its right.
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Crown } from 'lucide-react';
import type { Identity } from './api';
import { formatCredits, planName } from './billing';
import { useLauncherPlacement } from './feedbackPlacement';
import { planView } from './home/accountPlan';
import { accountURL } from './PersonalAccount';
import { gateSkipped, shownTenant } from './PlanGate';
import { useSaaSPreferences } from './preferences';
import { ROUTE_USAGE_CHANGED, fetchRouteUsage, recordUpgradeInterest, type RouteUsage } from './routeUsage';
import './plan-dock.css';

export const DOCK_REFRESH_MS = 120_000;

/** The home page (its rail has the account card): the app's root with no canvas, account page or case open. */
export function onHomePage(pathname = window.location.pathname, search = window.location.search): boolean {
  const query = new URLSearchParams(search);
  return pathname === '/' && !query.has('canvas') && !query.has('account');
}

/** The workspace's route-usage, kept up as the dock needs it; null until read or where the read failed. */
function useDockUsage(tenantId: string | undefined, off: boolean): RouteUsage | null {
  const [usage, setUsage] = useState<RouteUsage | null>(null);
  useEffect(() => {
    setUsage(null);
    if (off || !tenantId) return;
    let live = true;
    let controller: AbortController | undefined;
    const read = () => {
      controller?.abort();
      const mine = controller = new AbortController();
      fetchRouteUsage(tenantId, mine.signal).then(value => { if (live && !mine.signal.aborted) setUsage(value); }).catch(() => { /* the last answer stays */ });
    };
    const seen = () => { if (document.visibilityState === 'visible') read(); };
    read();
    const timer = window.setInterval(seen, DOCK_REFRESH_MS);
    window.addEventListener(ROUTE_USAGE_CHANGED, read);
    document.addEventListener('visibilitychange', seen);
    return () => {
      live = false;
      controller?.abort();
      window.clearInterval(timer);
      window.removeEventListener(ROUTE_USAGE_CHANGED, read);
      document.removeEventListener('visibilitychange', seen);
    };
  }, [tenantId, off]);
  return usage;
}

export function PlanDock({ identity }: { identity: Identity }) {
  const { t, locale } = useSaaSPreferences();
  const tenant = shownTenant(identity);
  const off = gateSkipped(identity, tenant) || onHomePage();
  const usage = useDockUsage(tenant?.id, off);
  const button = useRef<HTMLAnchorElement>(null);
  const { place, covered } = useLauncherPlacement(button, true);
  const view = off || !tenant ? null : planView(usage, tenant.role);
  // Nothing to say: an unlimited workspace, no answer yet, or a reader of a workspace on no plan (offered nothing).
  if (!view || (view.standing !== 'paid' && !view.call)) return null;
  const style = place ? { '--plan-dock-left': `${place.left}px`, '--plan-dock-bottom': `${place.bottom}px` } as CSSProperties : undefined;
  const hidden = place === null || covered;
  if (view.standing === 'paid') {
    const name = planName(view.plan);
    const left = view.credits ? t(`剩 ${formatCredits(view.credits.remaining, locale)} 点`, `${formatCredits(view.credits.remaining, locale)} credits left`) : '';
    // The plan is the workspace owner's: anyone else is told whose it is, and the link opens their own account's plans.
    const label = tenant!.role === 'owner'
      ? t(`当前套餐 ${name}${left ? '，' + left : ''}。查看套餐与点数`, `Current plan: ${name}${left ? ', ' + left : ''}. See plans and credits`)
      : t(`这个工作区的套餐 ${name}（由所有者订阅）${left ? '，' + left : ''}。查看我自己的套餐`, `This workspace’s plan: ${name} (its owner’s)${left ? ', ' + left : ''}. See my own plans`);
    return <a ref={button} className={`saas-plan-dock is-paid is-${view.plan}${view.low ? ' is-low' : ''}`} style={style} data-hidden={hidden ? '' : undefined}
      data-feedback-avoid="beside" data-plan-dock={view.plan} href={accountURL('plans')} aria-label={label} title={label}>
      <span className="saas-plan-dock-badge"><Crown size={13} aria-hidden="true" />{name}</span>
      {left && <span className="saas-plan-dock-credits">{left}</span>}
    </a>;
  }
  const words = t('订阅套餐', 'Choose a plan');
  return <a ref={button} className="saas-plan-dock is-call" style={style} data-hidden={hidden ? '' : undefined} data-feedback-avoid="beside" data-plan-dock="none"
    href={accountURL('plans')} aria-label={words} title={words} onClick={() => { void recordUpgradeInterest(tenant!.id).catch(() => {}); }}>
    <Crown size={15} aria-hidden="true" /><span>{words}</span>
  </a>;
}
