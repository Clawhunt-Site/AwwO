import { accountURL } from './PersonalAccount';
import { useSaaSPreferences } from './preferences';
import { recordUpgradeInterest } from './routeUsage';
import './plan-upsell.css';

/** Run failures that only a paid plan lifts: the workspace's free premium allowance, and the service-wide one.
 * The default model keeps working on the free plan, which the error copy itself says. */
const UPSELL_CODES: ReadonlySet<string> = new Set(['premium_quota_exceeded', 'premium_capacity_exceeded']);

export const planUpsellCode = (codes: ReadonlyArray<string | null | undefined>): string | undefined =>
  codes.find((code): code is string => Boolean(code && UPSELL_CODES.has(code)));

/** The upgrade offered at the moment a premium model is refused for want of a plan. It opens the plans page in a new
 * tab so the canvas, its draft and this failure stay where they are; a click also records the interest the operator
 * reads from the free allowance's own "I want more calls". */
export function PlanUpsell({ tenantId }: { tenantId: string }) {
  const { t } = useSaaSPreferences();
  return <div className="saas-plan-upsell" role="note">
    <a className="saas-primary" href={accountURL('plans')} target="_blank" rel="noopener noreferrer"
      onClick={() => { void recordUpgradeInterest(tenantId).catch(() => {}); }}>
      {t('升级 Pro / Max，继续使用高级模型', 'Upgrade to Pro or Max to keep using premium models')}
    </a>
    <p>{t('Claude、GPT、Bedrock 按点数计费，默认模型照常免费。升级后回到这里重新发送即可。',
      'Claude, GPT and Bedrock run on credits; the default model stays free. After upgrading, come back and send again.')}</p>
  </div>;
}
