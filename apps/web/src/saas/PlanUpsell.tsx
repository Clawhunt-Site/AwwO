import { accountURL } from './PersonalAccount';
import { useSaaSPreferences } from './preferences';
import { recordUpgradeInterest } from './routeUsage';
import './plan-upsell.css';

/** Run failures that only a paid plan lifts: the workspace's free premium allowance and the service-wide one, and the
 * workspace's own run allowance (today's calls, or runs at once), which admission applies only without a plan. */
const UPSELL_CODES: ReadonlySet<string> = new Set(['premium_quota_exceeded', 'premium_capacity_exceeded', 'quota_exceeded']);

export const planUpsellCode = (codes: ReadonlyArray<string | null | undefined>): string | undefined =>
  codes.find((code): code is string => Boolean(code && UPSELL_CODES.has(code)));

/** What the plans would lift: a premium model refused, or the day's calls used up. */
export type UpsellReason = 'premium' | 'daily';
export const upsellReason = (code: string): UpsellReason => code === 'quota_exceeded' ? 'daily' : 'premium';

/** The upgrade offered at the moment a run is refused for want of a plan. It opens the plans page in a new tab so the
 * canvas, its draft and this failure stay where they are; a click also records the interest the operator reads from
 * the free allowance's own "I want more calls". */
export function PlanUpsell({ tenantId, reason = 'premium' }: { tenantId: string; reason?: UpsellReason }) {
  const { t } = useSaaSPreferences();
  const daily = reason === 'daily';
  return <div className="saas-plan-upsell" role="note">
    <a className="saas-primary" href={accountURL('plans')} target="_blank" rel="noopener noreferrer"
      onClick={() => { void recordUpgradeInterest(tenantId).catch(() => {}); }}>
      {daily ? t('升级 Pro / Max，今天就能继续', 'Upgrade to Pro or Max to continue today')
        : t('升级 Pro / Max，继续使用高级模型', 'Upgrade to Pro or Max to keep using premium models')}
    </a>
    <p>{daily
      ? t('Pro / Max 每天的调用次数多得多，能同时运行更多任务，Claude、GPT 等高级模型按点数使用，不占全站的免费名额。升级后回到这里重新运行即可。',
        'Pro and Max have many more calls a day and more runs at once, and run premium models such as Claude and GPT on credits, outside the service-wide free calls. After upgrading, come back and run again.')
      : t('Claude、GPT、Bedrock 按点数计费，默认模型照常免费。升级后回到这里重新发送即可。',
        'Claude, GPT and Bedrock run on credits; the default model stays free. After upgrading, come back and send again.')}</p>
  </div>;
}
