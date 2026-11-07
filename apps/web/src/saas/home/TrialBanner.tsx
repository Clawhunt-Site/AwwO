// The line over every home section that says the free trial ends (and when), that it has ended, or that the owner's plan
// was set to end, with the way to the plans page for the workspace's owner (its plan alone opens the workspace). It reads the
// route-usage the account card's meter read (accountPlan.ts bannerView). A dismissed one stays hidden for the rest of
// the browser session, for this person and workspace, until another end or another kind comes; an ended trial cannot be
// dismissed: nothing runs until the workspace's owner subscribes.
import { useState } from 'react';
import { X } from 'lucide-react';
import { planName } from '../billing';
import { momentText } from '../freePlan';
import { accountURL } from '../PersonalAccount';
import { useSaaSPreferences } from '../preferences';
import { recordUpgradeInterest, type RouteUsage } from '../routeUsage';
import { bannerView, type BannerView } from './accountPlan';
import './home.css';

const dismissedKey = (userId: string, tenantId: string) => `awwo.home.banner.v1:${encodeURIComponent(userId)}:${encodeURIComponent(tenantId)}`;
function readDismissed(userId: string, tenantId: string): string | null {
  try { return window.sessionStorage.getItem(dismissedKey(userId, tenantId)); } catch { return null; }
}
function saveDismissed(userId: string, tenantId: string, key: string) {
  try { window.sessionStorage.setItem(dismissedKey(userId, tenantId), key); } catch { /* hidden for this page only */ }
}

type T = (zh: string, en: string) => string;
/** The banner's sentence and its action, in the reader's language. A workspace opens by its owner's plan, so to anyone
 *  else the sentence says the owner subscribes (and no action is offered: their own purchase would not open it). */
function bannerText(banner: BannerView, t: T, locale: 'zh' | 'en', owner: boolean): { text: string; action: string } {
  if (banner.kind === 'ended') return { text: owner
    ? t('免费试用已结束：订阅 Pro 或 Max 后就能继续规划和运行，画布和成果都还在。', 'The free trial has ended: subscribe to Pro or Max to plan and run again. Your canvases and results are all still here.')
    : t('免费试用已结束：工作区所有者订阅 Pro 或 Max 后，就能继续规划和运行，画布和成果都还在。', 'The free trial has ended: once the workspace owner subscribes to Pro or Max, planning and runs work again. The canvases and results are all still here.'),
    action: t('订阅 Pro / Max', 'Subscribe to Pro or Max') };
  if (banner.kind === 'cancel') {
    const date = new Date(banner.periodEnd).toLocaleDateString(locale === 'zh' ? 'zh-CN' : 'en-US', { month: 'long', day: 'numeric' });
    const name = planName(banner.plan);
    return { text: t(`你的 ${name} 套餐 ${date} 到期，不会自动续费。`, `Your ${name} plan ends on ${date} and will not renew.`), action: t('恢复续订', 'Resume subscription') };
  }
  const end = momentText(banner.until, locale, { end: banner.kind === 'trial' });
  const trial = owner
    ? t(`AwwO 内测即将结束：免费试用到 ${end} 结束，之后要订阅 Pro 或 Max 才能继续运行 Agent。`, `The AwwO beta is ending: the free trial ends on ${end}; after that, running Agents needs Pro or Max.`)
    : t(`AwwO 内测即将结束：免费试用到 ${end} 结束，之后这个工作区要所有者订阅 Pro 或 Max 才能继续运行 Agent。`, `The AwwO beta is ending: the free trial ends on ${end}; after that, this workspace runs Agents once its owner subscribes to Pro or Max.`);
  return { text: banner.kind === 'trial' ? trial : t(`免费试用到 ${end} 结束。`, `The free trial ends on ${end}.`), action: t('查看套餐', 'See plans') };
}

/** `owner`: the viewer owns the workspace, the one account whose plan opens it, and so the one offered the plans here. */
export function TrialBanner({ usage, userId, tenantId, owner, onDismiss }: { usage: RouteUsage | null; userId: string; tenantId: string; owner: boolean; onDismiss?: () => void }) {
  const { t, locale } = useSaaSPreferences();
  const [dismissed, setDismissed] = useState(() => readDismissed(userId, tenantId));
  const banner = bannerView(usage);
  if (!banner || (banner.key !== null && banner.key === dismissed)) return null;
  const { text, action } = bannerText(banner, t, locale, owner);
  const dismiss = () => {
    if (banner.key === null) return;
    onDismiss?.();
    saveDismissed(userId, tenantId, banner.key);
    setDismissed(banner.key);
  };
  return <div className={`saas-home-banner is-${banner.kind}`} role={banner.key !== null ? 'status' : undefined}>
    <p>{text}</p>
    {owner && <a className={banner.kind === 'ended' ? 'saas-primary saas-home-banner-action' : 'saas-home-banner-action'} href={accountURL('plans')}
      onClick={() => { void recordUpgradeInterest(tenantId).catch(() => {}); }}>{action}</a>}
    {banner.key !== null && <button type="button" className="saas-home-banner-close" aria-label={t('关闭这条提示', 'Dismiss this notice')} title={t('关闭这条提示', 'Dismiss this notice')}
      onClick={dismiss}><X size={15} aria-hidden="true" /></button>}
  </div>;
}
