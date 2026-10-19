import type { ReactNode } from 'react';
import { Check } from 'lucide-react';
import { formatCredits, planName, type CatalogPlan } from './billing';
import { useSaaSPreferences } from './preferences';
import './plan-voucher.css';

/**
 * One plan as a voucher (owner 2026-10-19: 「要做出来 coupon 这种质感的东西，兑换券的感觉，要吸引他们购买」): its monthly
 * credits as the face value, what else it gives, and a tear-off stub with its price and the way to buy or change it.
 * Every figure comes from the server's catalog (GET /billing), so a voucher never promises more than the plan gives.
 */
export function PlanVoucher({ plan, smallest, current, action, fine }: {
  plan: CatalogPlan;
  /** The catalog's plan with the fewest credits: a larger plan says how many times its credits it holds. */
  smallest: CatalogPlan;
  /** This is the account's plan now. */
  current: boolean;
  /** The stub's way to buy, switch or wait. */
  action: ReactNode;
  /** The stub's small print under it. */
  fine?: ReactNode;
}) {
  const { t, locale } = useSaaSPreferences();
  const name = planName(plan.id);
  const base = smallest.credits;
  const times = base > 0 && plan.credits > base && plan.credits % base === 0 ? plan.credits / base : 0;
  const tagline = times ? t(`进阶创作 · 点数是 ${planName(smallest.id)} 的 ${times} 倍`, `For heavy making · ${times}× the credits of ${planName(smallest.id)}`)
    : t('日常创作', 'For everyday making');
  const perks = [
    t('点数用于 Claude Opus 5.5 等高级模型，以及图片和视频生成', 'Credits run Claude Opus 5.5 and the other premium models, and image and video generation'),
    t(`默认模型每天 ${formatCredits(plan.dailyCalls, locale)} 次，不扣点`, `${formatCredits(plan.dailyCalls, locale)} default-model calls a day, free of credits`),
    t(`同时运行 ${plan.concurrentAgents} 个 Agent`, `${plan.concurrentAgents} agents at once`),
    t(`最多 ${plan.workspaces} 个工作区`, `Up to ${plan.workspaces} workspaces`),
    t(`每天最多 ${plan.mediaPerDay} 次图片 / 视频生成`, `Up to ${plan.mediaPerDay} image or video generations a day`),
  ];
  return <section className={`saas-voucher saas-voucher-${plan.id}${current ? ' is-current' : ''}`} aria-labelledby={`saas-plan-${plan.id}`}>
    <div className="saas-voucher-ticket">
      <div className="saas-voucher-body">
        <p className="saas-voucher-kicker">{t('AwwO 点数券', 'AwwO credit voucher')}{' '}<span className="saas-voucher-tag">{tagline}</span></p>
        <h2 id={`saas-plan-${plan.id}`}>{name}</h2>
        <p className="saas-voucher-face">
          <span className="saas-voucher-face-label">{t('面值', 'Face value')}</span>{' '}
          <strong>{formatCredits(plan.credits, locale)}</strong>{' '}
          <span className="saas-voucher-unit">{t('点', 'credits')}</span>
          {/* The plan the account holds, stamped in the face value's row, where it never covers the tagline. */}
          {current && <span className="saas-voucher-stamp" aria-hidden="true">{t('使用中', 'Active')}</span>}
        </p>
        <p className="saas-voucher-face-note">{t('每月到账 · 1 点 = 1 美分', 'Every month · 1 credit = 1 cent')}</p>
        <ul className="saas-voucher-perks">{perks.map(text => <li key={text}><Check size={15} aria-hidden="true" />{text}</li>)}</ul>
        <p className="saas-voucher-serial" aria-hidden="true">AWWO · {name.toUpperCase()} · {plan.credits}</p>
      </div>
      <div className="saas-voucher-stub">
        <p className="saas-voucher-price"><strong>${plan.priceUsd}</strong>{t(' / 月', ' / month')}</p>
        {action}
        {fine && <p className="saas-voucher-fine">{fine}</p>}
      </div>
    </div>
  </section>;
}
