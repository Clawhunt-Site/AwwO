import { useLocalEdition } from './edition';
import { accountURL } from './PersonalAccount';
import { useSaaSPreferences } from './preferences';
import { recordUpgradeInterest } from './routeUsage';
import './plan-upsell.css';

/** Run failures that only a paid plan lifts: the workspace's free premium allowance and the service-wide one, the
 * workspace's own run allowance (today's calls, or runs at once), which admission applies only without a plan, and the
 * end of the free trial, after which a workspace without its owner's plan runs nothing (free_plan_ended). */
const UPSELL_CODES: ReadonlySet<string> = new Set(['premium_quota_exceeded', 'premium_capacity_exceeded', 'quota_exceeded', 'free_plan_ended']);

export const planUpsellCode = (codes: ReadonlyArray<string | null | undefined>): string | undefined =>
  codes.find((code): code is string => Boolean(code && UPSELL_CODES.has(code)));

/** What the plans would lift: a premium model refused, the day's calls used up, or the free trial over. */
export type UpsellReason = 'premium' | 'daily' | 'ended';
export const upsellReason = (code: string): UpsellReason => code === 'quota_exceeded' ? 'daily' : code === 'free_plan_ended' ? 'ended' : 'premium';

/** The upgrade offered at the moment a run is refused for want of a plan, as a small voucher like the plans page's
 * (plan-voucher.css). It opens the plans page in a new tab so the canvas, its draft and this failure stay where they
 * are; a click also records the interest the operator reads from the free allowance's own "I want more calls". The local
 * edition sells no plan and shows none. Past the free trial's end the refusal above it has said so (free_plan_ended's
 * copy), so the voucher says what the plans give, and that the workspace runs again once its owner subscribes (only the
 * owner's plan opens it); the default model runs no more than any other there. */
export function PlanUpsell({ tenantId, reason = 'premium' }: { tenantId: string; reason?: UpsellReason }) {
  const { t } = useSaaSPreferences();
  const local = useLocalEdition();
  if (local) return null;
  const copy = reason === 'ended'
    ? [t('Pro / Max 按月订阅：点数用于 Claude、GPT 等高级模型和图片视频生成，默认模型每天另有不扣点的次数。工作区所有者订阅后，回到这里重新运行即可。',
      'Pro and Max are monthly plans: their credits run Claude, GPT and the other premium models and make images and video, and the default model has its own calls a day, free of credits. After the workspace owner subscribes, come back and run again.'),
    t('查看 Pro / Max 套餐', 'See the Pro and Max plans')]
    : reason === 'daily'
      ? [t('Pro / Max 每天的调用次数多得多，能同时运行更多任务，Claude、GPT 等高级模型按点数使用，不占全站的免费名额。升级后回到这里重新运行即可。',
        'Pro and Max have many more calls a day and more runs at once, and run premium models such as Claude and GPT on credits, outside the service-wide free calls. After upgrading, come back and run again.'),
      t('升级 Pro / Max，今天就能继续', 'Upgrade to Pro or Max to continue today')]
      : [t('Claude、GPT、Bedrock 按点数计费，默认模型照常免费。升级后回到这里重新发送即可。',
        'Claude, GPT and Bedrock run on credits; the default model stays free. After upgrading, come back and send again.'),
      t('升级 Pro / Max，继续使用高级模型', 'Upgrade to Pro or Max to keep using premium models')];
  return <div className="saas-plan-upsell" role="note">
    <div className="saas-plan-upsell-ticket">
      <div className="saas-plan-upsell-body">
        <p className="saas-plan-upsell-kicker">{t('Pro / Max 点数券', 'Pro and Max credit vouchers')}</p>
        <p>{copy[0]}</p>
      </div>
      <div className="saas-plan-upsell-stub">
        <a className="saas-primary" href={accountURL('plans')} target="_blank" rel="noopener noreferrer"
          onClick={() => { void recordUpgradeInterest(tenantId).catch(() => {}); }}>{copy[1]}</a>
      </div>
    </div>
  </div>;
}
