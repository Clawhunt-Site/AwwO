// An author's earnings from their market Agents: what is waiting for its period to be settled, what is settled and waits
// for the month's statement, what is on a statement the platform reviews, what is on its way and what arrived, and the
// monthly statements themselves. Amounts are in credits, and 1 credit is 1 US cent.
import { useEffect, useState } from 'react';
import { saasErrorMessage } from '../api';
import { readMarketEarnings, type MarketEarnings } from '../marketApi';
import { creditsText, dateText, monthText, payoutStatusName, useMarketI18n } from './marketText';

const dollars = (cents: number, locale: 'zh' | 'en') => new Intl.NumberFormat(locale === 'zh' ? 'zh-CN' : 'en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);

/** `onlyIfAny`: shown only once it has something to show (the market closed, where earnings still settle and transfer). */
export function MarketEarningsPanel({ onlyIfAny = false }: { onlyIfAny?: boolean }) {
  const { locale, t } = useMarketI18n();
  const [earnings, setEarnings] = useState<MarketEarnings | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    readMarketEarnings(controller.signal).then(value => { if (!controller.signal.aborted) setEarnings(value); }, cause => { if (!controller.signal.aborted) setError(cause); });
    return () => controller.abort();
  }, [attempt]);
  if (onlyIfAny && !(earnings && (earnings.pending || earnings.available || earnings.inReview || earnings.transferring || earnings.paid || earnings.payouts.length))) return null;
  const amount = (credits: number) => t(`${creditsText(credits, locale)} 点（${dollars(credits, locale)}）`, `${creditsText(credits, locale)} credits (${dollars(credits, locale)})`);
  return <section className="saas-card saas-settings-card saas-market-earnings" aria-label={t('收益', 'Earnings')}>
    <h2>{t('收益', 'Earnings')}</h2>
    {error !== null ? <p role="alert" className="saas-error">{saasErrorMessage(error, locale)} <button type="button" onClick={() => setAttempt(value => value + 1)}>{t('重试', 'Retry')}</button></p>
      : !earnings ? <p role="status">{t('正在读取收益…', 'Loading earnings…')}</p>
      : <>
        <dl>
          <div><dt>{t('待确定', 'Pending')}</dt><dd>{amount(earnings.pending)}</dd></div>
          <div><dt>{t('已确定，待出账单', 'Settled, for the next statement')}</dt><dd>{amount(earnings.available)}</dd></div>
          <div><dt>{t('账单审核中', 'On a statement in review')}</dt><dd>{amount(earnings.inReview)}</dd></div>
          <div><dt>{t('正在转入', 'Transferring')}</dt><dd>{amount(earnings.transferring)}</dd></div>
          <div><dt>{t('已转入', 'Transferred')}</dt><dd>{amount(earnings.paid)}</dd></div>
        </dl>
        {earnings.asOf && <p className="saas-settings-description">{t(`截至 ${dateText(earnings.asOf, locale)}。`, `As of ${dateText(earnings.asOf, locale)}.`)}</p>}
        <p className="saas-settings-description">{t(`每次成功的付费调用，你得到价格减去平台抽成（${earnings.feeBps / 100}%）后的部分，而且只计调用方买来的点数：调用方这一期用的有赠送的点数时按比例减少，期内退款或拒付就没有收益。调用方的计费期结束后再过 ${earnings.holdDays} 天，收益才确定，计入那个月的账单。`,
          `For each successful paid call you get its price less the platform’s fee (${earnings.feeBps / 100}%), counting only credits the caller bought: a period the caller also spent gifted credits in pays proportionally less, and a refund or chargeback in the period leaves nothing. Earnings are settled ${earnings.holdDays} days after the caller’s billing period ends, and go on that month’s statement.`)}</p>
        <p role="status">{!earnings.payoutsEnabled ? t('转入 ClawHunt 钱包暂未开放：收益照常记账，每月出账单，开放并经平台审核后转入。', 'Transfers to ClawHunt wallets are not open yet: earnings are recorded as usual and gathered into a statement each month, which transfers once they open and the platform has reviewed it.')
          : earnings.clawHuntLinked ? t('每个月（UTC）结束后，通常是次月 1 日，那个月确定的收益汇总成一张账单；平台审核通过后转入你的 ClawHunt 钱包，之后用 ClawHunt 的提现取出。', 'Once a month (UTC) has ended, usually on the 1st, the earnings settled in it are gathered into one statement; once the platform has reviewed it, it transfers to your ClawHunt wallet, and you withdraw it with ClawHunt’s payouts.')
          : t('绑定 ClawHunt 账号后才有账单、才能转入：在那之前收益一直累积，绑定后按月补出账单。', 'Statements and transfers need a linked ClawHunt account: until then earnings build up, and after you link one they go on statements, one for each month.')}</p>
        {earnings.payouts.length > 0 ? <div className="saas-table-wrap"><table>
          <thead><tr><th>{t('月份', 'Month')}</th><th>{t('调用', 'Calls')}</th><th>{t('金额', 'Amount')}</th><th>{t('状态', 'Status')}</th><th>{t('转入', 'Transferred')}</th></tr></thead>
          <tbody>{earnings.payouts.map(payout => <tr key={payout.id}><td>{monthText(payout.month, locale)}</td><td>{payout.calls}</td><td>{dollars(payout.amountCents, locale)}</td>
            <td>{payoutStatusName(payout.status, t)}</td><td>{dateText(payout.sentAt, locale)}</td></tr>)}</tbody>
        </table></div> : <p className="saas-settings-description">{t('还没有账单。', 'No statements yet.')}</p>}
      </>}
  </section>;
}
