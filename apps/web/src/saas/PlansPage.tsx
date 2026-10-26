import { useEffect, useRef, useState } from 'react';
import { saasErrorMessage, type Identity } from './api';
import { billingNavigation, fetchBilling, formatCredits, openBillingPortal, planName, startCheckout, stripePage, type Billing, type PlanId } from './billing';
import { PlanVoucher } from './PlanVoucher';
import { useSaaSPreferences } from './preferences';
import './plans.css';

// After Stripe sends the browser back, the plan reaches AwwO within moments (ClawHunt reads the finished
// checkout from Stripe); the page asks again a few times before it says the sync is still on its way.
const RETURN_POLLS = 8;
export const returnPoll = { ms: 2500 };
// A subscription Stripe still holds, whether or not it entitles right now: it is managed, never bought again.
const SUBSCRIBED = new Set(['active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'paused']);

/** The account's plan and credits, and Pro / Max to buy or change (?account=plans). */
export function PlansPage({ identity }: { identity: Identity }) {
  const { t, locale } = useSaaSPreferences();
  const [billing, setBilling] = useState<Billing | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<PlanId | 'portal' | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const returned = useRef(new URLSearchParams(location.search).get('billing'));
  const [syncing, setSyncing] = useState(returned.current === 'success');
  const linked = identity.authentication === 'clawhunt';
  // The payment page's answer is read once: a reload or a later visit does not show it again.
  useEffect(() => {
    const query = new URLSearchParams(location.search);
    if (!query.has('billing')) return;
    query.delete('billing');
    window.history.replaceState(window.history.state, '', location.pathname + (query.size ? '?' + query : '') + location.hash);
  }, []);
  // Coming back from Stripe with the browser's Back button restores this page as it was left: busy.
  useEffect(() => {
    const restored = (event: PageTransitionEvent) => { if (event.persisted) setBusy(null); };
    window.addEventListener('pageshow', restored);
    return () => window.removeEventListener('pageshow', restored);
  }, []);
  useEffect(() => {
    if (!linked) return;
    const controller = new AbortController();
    let polls = 0;
    let timer: number | undefined;
    const load = (refresh: boolean) => {
      fetchBilling(refresh, controller.signal).then(value => {
        if (controller.signal.aborted) return;
        setBilling(value);
        setError(null);
        // Back from a paid checkout: keep asking until the plan arrives.
        if (returned.current === 'success' && !value.plan?.entitled && ++polls < RETURN_POLLS) {
          timer = window.setTimeout(() => load(true), returnPoll.ms);
        } else {
          setSyncing(false);
        }
      }).catch(cause => {
        if (controller.signal.aborted) return;
        setError(cause);
        setSyncing(false);
      });
    };
    load(returned.current !== null);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [identity.user.id, linked]);
  const go = async (action: PlanId | 'portal') => {
    setBusy(action); setActionError(null);
    try {
      const { url } = action === 'portal' ? await openBillingPortal() : await startCheckout(action);
      const page = stripePage(url, action === 'portal' ? 'billing.stripe.com' : 'checkout.stripe.com');
      if (!page) throw new Error(t('支付页面地址无效，请稍后重试。', 'The payment page address is invalid. Try again later.'));
      billingNavigation.go(page);
    } catch (cause) {
      setActionError(cause);
      setBusy(null);
    }
  };
  if (!linked) return <section className="saas-card saas-plans-note"><p>{t('付费套餐随 ClawHunt 账号提供。使用 ClawHunt 账号登录 AwwO 后即可在这里订阅。', 'Paid plans come with a ClawHunt account. Sign in to AwwO with ClawHunt to subscribe here.')}</p></section>;
  if (!billing) return <section className="saas-card saas-plans-note" role={error ? 'alert' : 'status'}>{error ? saasErrorMessage(error, locale) : t('正在读取套餐…', 'Loading plans…')}</section>;
  const date = (raw: string) => new Date(raw).toLocaleDateString(locale === 'zh' ? 'zh-CN' : 'en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const current = billing.plan?.entitled ? billing.plan : null;
  // Subscribed, but not entitled: a first payment or a renewal that has not gone through.
  const held = !current && billing.plan && SUBSCRIBED.has(billing.plan.status) ? billing.plan : null;
  const smallest = billing.catalog.reduce((least, plan) => (plan.credits < least.credits ? plan : least), billing.catalog[0]);
  return <div className="saas-plans">
    {returned.current === 'cancel' && <p className="saas-plans-notice" role="status">{t('已取消支付，没有扣款。', 'Payment cancelled; you were not charged.')}</p>}
    {returned.current === 'success' && <p className="saas-plans-notice" role="status">{syncing ? t('支付完成，正在开通套餐…', 'Payment complete. Turning on your plan…')
      : current ? t(`已开通 ${planName(current.id)}，点数已到账。`, `${planName(current.id)} is on and your credits are ready.`)
        : t('支付完成，套餐还在同步，几分钟内会生效；刷新本页即可查看。', 'Payment complete. The plan is still syncing and takes effect within minutes; refresh this page to check.')}</p>}
    {billing.stale && <p className="saas-plans-notice" role="status">{t('暂时无法向 ClawHunt 确认最新状态，下面显示的是上次同步的结果。', 'ClawHunt could not confirm the latest state right now; this is the last synced result.')}</p>}
    <section className="saas-card saas-plans-current" aria-labelledby="saas-plans-current-title">
      <h2 id="saas-plans-current-title">{t('当前套餐', 'Current plan')}</h2>
      {current ? <>
        <p className="saas-plans-current-name">{planName(current.id)}</p>
        {billing.credits && <dl className="saas-plans-facts">
          <div><dt>{t('本期剩余点数', 'Credits left this period')}</dt><dd>{formatCredits(billing.credits.remaining, locale)} / {formatCredits(billing.credits.granted, locale)}</dd></div>
          {(billing.credits.gift ?? 0) > 0 && <div><dt>{t('其中赠送', 'Of that, gifted')}</dt><dd>{formatCredits(billing.credits.gift ?? 0, locale)}</dd></div>}
          {(billing.credits.carried ?? 0) > 0 && <div><dt>{t('上期超支（本期扣除）', 'Carried from last period')}</dt><dd>{formatCredits(billing.credits.carried ?? 0, locale)}</dd></div>}
          <div><dt>{current.cancelAtPeriodEnd ? t('到期日', 'Ends on') : t('下次续费', 'Renews on')}</dt><dd>{!current.cancelAtPeriodEnd && new Date(current.periodEnd).getTime() < Date.now()
            ? t('续费处理中，付款完成后新一期的点数会自动到账', 'Renewal in progress; the new period’s credits arrive once it is paid') : date(current.periodEnd)}</dd></div>
          {current.status === 'past_due' && <div><dt>{t('付款状态', 'Payment')}</dt><dd>{t('续费扣款失败，Stripe 正在重试；请在管理订阅中更新付款方式。', 'The renewal payment failed and Stripe is retrying. Update your payment method in Manage subscription.')}</dd></div>}
        </dl>}
        <button type="button" disabled={busy !== null} onClick={() => go('portal')}>{busy === 'portal' ? t('正在打开…', 'Opening…') : t('管理订阅', 'Manage subscription')}</button>
        <p className="saas-plans-hint">{t('在管理订阅中可以切换 Pro / Max、更新付款方式或取消订阅；取消后本期结束前仍可使用。', 'In Manage subscription you can switch between Pro and Max, update the payment method or cancel; a cancelled plan stays on until the period ends.')}</p>
      </> : held ? <>
        <p className="saas-plans-current-name">{planName(held.id)}</p>
        <p>{t('订阅还没有生效：付款没有完成或续费扣款失败。请在管理订阅中完成付款或更新付款方式，付款成功后点数会自动到账。', 'The subscription is not in effect yet: its payment has not gone through. Complete it or update the payment method in Manage subscription; the credits arrive once it is paid.')}</p>
        <button type="button" disabled={busy !== null} onClick={() => go('portal')}>{busy === 'portal' ? t('正在打开…', 'Opening…') : t('管理订阅', 'Manage subscription')}</button>
      </> : <>
        <p>{t('免费版：每天有固定的总次数，默认模型和 Claude / GPT、Bedrock 等高级模型都能用（高级模型全站每天共享一份免费名额），图片视频另有免费次数；详见工作区顶部的「今日额度」。Claude Opus 5.5 和标着「不含」的模型需要 Pro 或 Max。', 'Free: a daily number of calls for the default model and for premium models such as Claude / GPT and Bedrock (premium calls share one service-wide daily number), plus free image or video calls; see Today’s allowance at the top of a workspace. Claude Opus 5.5, and what is marked Not included, need Pro or Max.')}</p>
        {billing.checkoutEnabled && <p className="saas-plans-lead">{t('选一张点数券：付款成功后点数自动到账，按月订阅，可随时取消。', 'Pick a voucher: the credits arrive automatically once the payment goes through. Monthly, cancel anytime.')}</p>}
      </>}
    </section>
    <div className="saas-vouchers">
      {billing.catalog.map(plan => {
        const isCurrent = current?.id === plan.id;
        const subscribed = current ?? held;
        const name = planName(plan.id);
        const buying = busy === plan.id;
        const action = isCurrent ? <p className="saas-voucher-state">{t('当前套餐', 'Your plan')}</p>
          : subscribed ? <button type="button" disabled={busy !== null} onClick={() => go('portal')}>{t(`在管理订阅中切换到 ${name}`, `Switch to ${name} in Manage subscription`)}</button>
            : billing.checkoutEnabled ? <button type="button" className="saas-primary" disabled={busy !== null} onClick={() => go(plan.id)}>{buying ? t('正在打开支付页…', 'Opening checkout…') : t(`立即开通 ${name}`, `Get ${name}`)}</button>
              : <button type="button" disabled>{t('即将开放', 'Coming soon')}</button>;
        // An upgrade during a paid period adds what its prorated charge paid (the hint below says how credits work); a
        // subscription not paid yet has no difference to pay.
        const upgrade = current !== null && plan.credits > (billing.catalog.find(item => item.id === current.id)?.credits ?? Infinity);
        const fine = isCurrent ? (current?.cancelAtPeriodEnd ? t('已取消续费，本期结束前照常可用', 'Renewal cancelled; on until the period ends') : t('每期自动续费，点数随新一期到账', 'Renews each period with new credits'))
          : subscribed ? (upgrade ? t('期中升级只补按剩余天数折算的差价，补多少钱就加多少点', 'Upgrading mid-period charges only the prorated difference and adds 1 credit per cent of it') : undefined)
            : billing.checkoutEnabled ? t('按月订阅 · 可随时取消 · 由 Stripe 安全支付', 'Monthly · cancel anytime · paid securely through Stripe') : undefined;
        return <PlanVoucher key={plan.id} plan={plan} smallest={smallest} current={isCurrent} action={action} fine={fine} />;
      })}
    </div>
    {Boolean(actionError) && <p role="alert" className="saas-error">{saasErrorMessage(actionError, locale)}</p>}
    <p className="saas-plans-hint">{t('点数按官方 API 价格的 1.5 倍扣除：文字模型按实际用量；取消的或没有上报用量的调用按发送和收到的内容长度、以及开始输出前的思考时长估算，且不少于调用开始时预留的点数；图片和视频按次计，提供方没有接下的生成不扣点。每期点数等于这一期实际支付的金额（1 点 = 1 美分），期中升级按补差价增加点数，退款会相应扣回；当期有效，不结转，超出当期点数的部分从下一期扣除。AwwO 赠送的点数不是支付金额的一部分，付费点数先扣，赠送的同样当期有效。支付由 ClawHunt 通过 Stripe 处理，按美元结算。', 'Credits are charged at 1.5 times the official API price: text models by actual usage; a cancelled call, or one without reported usage, is estimated from what it sent and received and how long it thought before answering, and never less than the credits it reserved when it started; images and video per generation, and nothing when the provider never took it. A period’s credits are what was paid for it (1 credit = 1 cent); an upgrade during the period adds what its prorated charge paid, and a refund takes its share back. Credits last for the period and do not roll over; spending past them comes off the next period. Credits AwwO gifts you are not part of what you paid: the paid ones are spent first, and a gift lasts for the period as they do. Payment is handled by ClawHunt through Stripe, in US dollars.')}</p>
  </div>;
}
