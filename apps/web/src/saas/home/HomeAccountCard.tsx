// The home's account card, pinned to the bottom of its left rail (owner 2026-11-07: 首页的左下角要强调出用户系统，还有订阅
// 账号，要强调引导用户付费续费). Who is signed in, the workspace's plan as its route-usage says it (home/accountPlan.ts), the
// day's meter, and the way to the plans page. Its meter is the page's only route-usage reader: it hands each answer up to
// the frame, whose trial banner reads the same. The local edition sells nothing: no meter there, and no plan.
import { Settings2 } from 'lucide-react';
import type { Identity, Tenant } from '../api';
import { formatCredits, planName } from '../billing';
import { isLocalEdition } from '../edition';
import { daysLeft, momentText } from '../freePlan';
import { accountURL } from '../PersonalAccount';
import { useSaaSPreferences } from '../preferences';
import { RouteUsageMeter } from '../RouteUsageMeter';
import { recordUpgradeInterest, type RouteUsage } from '../routeUsage';
import { planView, type FreeView, type PaidView, type PlanCall } from './accountPlan';
import './home.css';

type T = (zh: string, en: string) => string;

/** The letters of the avatar: a name's first character, with its last word's for a Latin name of more than one word. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = words.length ? [...words[0]][0] : '';
  if (!first) return '?';
  if (words.length === 1 || /[^\x20-\x7e]/.test(first)) return first.toLocaleUpperCase();
  return (first + [...words[words.length - 1]][0]).toLocaleUpperCase();
}

/** A day as the card says it: 11月30日 / November 30. */
const dayText = (iso: string, locale: 'zh' | 'en') => {
  const at = Date.parse(iso);
  return Number.isFinite(at) ? new Date(at).toLocaleDateString(locale === 'zh' ? 'zh-CN' : 'en-US', { month: 'long', day: 'numeric' }) : '';
};

export function HomeAccountCard({ identity, tenant, usage, onUsage }: { identity: Identity; tenant: Tenant; usage: RouteUsage | null; onUsage: (usage: RouteUsage | null) => void }) {
  const { t } = useSaaSPreferences();
  const local = isLocalEdition(identity);
  const view = local ? null : planView(usage, tenant.role);
  return <section className="saas-home-account" aria-label={t('账号与套餐', 'Account and plan')}>
    <AccountWho identity={identity} reader={tenant.role === 'reader'} />
    {view && (view.standing === 'paid' ? <PaidPlan view={view} tenantId={tenant.id} /> : <FreePlan view={view} tenantId={tenant.id} />)}
    {!local && <div className="saas-home-account-meter"><RouteUsageMeter key={tenant.id} tenantId={tenant.id} variant="card" onUsage={onUsage} owner={tenant.role === 'owner'} /></div>}
    <a className="saas-home-account-link" href={accountURL('general')}><Settings2 size={15} aria-hidden="true" />{t('账号设置', 'Account settings')}</a>
  </section>;
}

function AccountWho({ identity, reader }: { identity: Identity; reader: boolean }) {
  const { t } = useSaaSPreferences();
  const { name, email } = identity.user;
  const shown = name || email;
  return <div className="saas-home-account-who">
    <span className="saas-home-account-avatar" aria-hidden="true">{initials(shown)}</span>
    <span className="saas-home-account-names">
      <strong title={shown}>{shown}</strong>
      {email && <span className="saas-home-account-email" title={email}>{email}</span>}
    </span>
    {reader && <span className="saas-home-account-role">{t('只读成员', 'Reader')}</span>}
  </div>;
}

const CALL_NAMES: Record<PlanCall, readonly [string, string]> = {
  subscribe: ['订阅 Pro / Max', 'Subscribe to Pro or Max'], upgrade: ['升级 Pro / Max', 'Upgrade to Pro or Max'],
  resume: ['恢复续订', 'Resume subscription'], 'upgrade-max': ['升级 Max', 'Upgrade to Max'], manage: ['管理订阅', 'Manage subscription'],
  own: ['为我自己的账号订阅', 'Subscribe for my own account'],
};

/** The plans page, in this tab. Every call but managing a plan says that its person would pay, without waiting for the
 *  answer before the page opens (as the meter's upgrade link does). */
function PlanAction({ call, primary, tenantId }: { call: PlanCall; primary: boolean; tenantId: string }) {
  const { t } = useSaaSPreferences();
  return <a className={primary ? 'saas-primary saas-home-account-action' : 'saas-home-account-action is-quiet'} href={accountURL('plans')}
    onClick={() => { if (call !== 'manage') void recordUpgradeInterest(tenantId).catch(() => {}); }}>{t(...CALL_NAMES[call])}</a>;
}

function PaidPlan({ view, tenantId }: { view: PaidView; tenantId: string }) {
  const { t, locale } = useSaaSPreferences();
  const name = planName(view.plan);
  const date = view.periodEnd ? dayText(view.periodEnd, locale) : '';
  const credits = view.credits;
  const share = credits && credits.granted > 0 ? Math.max(0, Math.min(1, credits.remaining / credits.granted)) : 0;
  return <div className="saas-home-account-plan">
    <span className="saas-home-account-badge is-paid">{name}</span>
    {!view.owner && <p>{t(`工作区所有者的 ${name} 套餐`, `The workspace owner’s ${name} plan`)}</p>}
    {credits && <>
      <p>{t(`本期剩余 ${formatCredits(credits.remaining, locale)} / ${formatCredits(credits.granted, locale)} 点`, `${formatCredits(credits.remaining, locale)} of ${formatCredits(credits.granted, locale)} credits left this period`)}</p>
      <span className={`saas-home-account-bar${view.low ? ' is-low' : ''}`} aria-hidden="true"><span style={{ width: `${Math.round(share * 100)}%` }} /></span>
    </>}
    {view.owner && date && <p>{view.cancel ? t(`${date} 到期，不会自动续费`, `Ends on ${date}; it will not renew`) : t(`${date} 自动续费`, `Renews on ${date}`)}</p>}
    {view.call && <PlanAction call={view.call} primary={view.primary} tenantId={tenantId} />}
  </div>;
}

/** The free plan's line: when the trial ends (and how many days are left), that it has, or the promotion's end. */
function freeLine(view: FreeView, t: T, locale: 'zh' | 'en'): string {
  if (view.standing === 'ended') return view.owner ? t('免费试用已结束，订阅后继续运行', 'The free trial has ended; subscribe to keep running')
    : t('免费试用已结束，工作区所有者订阅后继续运行', 'The free trial has ended; it runs again once the workspace owner subscribes');
  const end = view.until ? momentText(view.until, locale, { end: view.standing === 'trial' }) : '';
  if (!end) return '';
  if (view.standing === 'free') return t(`限时额度到 ${end}`, `Limited-time allowance until ${end}`);
  const days = daysLeft(view.until!, Date.now());
  return days > 0 ? t(`试用到 ${end} · 还剩 ${days} 天`, `Trial until ${end} · ${days} ${days === 1 ? 'day' : 'days'} left`) : t(`试用到 ${end}`, `Trial until ${end}`);
}

function FreePlan({ view, tenantId }: { view: FreeView; tenantId: string }) {
  const { t, locale } = useSaaSPreferences();
  const badge = { trial: t('免费试用', 'Free trial'), ended: t('未订阅', 'Not subscribed'), free: t('免费版', 'Free plan') }[view.standing];
  const line = freeLine(view, t, locale);
  return <div className="saas-home-account-plan">
    <span className={`saas-home-account-badge is-${view.standing}`}>{badge}</span>
    {line && <p>{line}</p>}
    {/* During the trial only: the ended line already says the owner opens it again, and a promotion's end closes nothing. */}
    {view.call === 'own' && view.standing === 'trial' && <p>{t('试用结束后，这个工作区要所有者订阅才能继续运行。', 'After the trial, this workspace keeps running once its owner subscribes.')}</p>}
    {view.call && <PlanAction call={view.call} primary={view.call !== 'own'} tenantId={tenantId} />}
  </div>;
}
