// An author's earnings from their market Agents: what is waiting for its period to be settled, what can be transferred,
// what was, and the transfers to their ClawHunt wallet. Amounts are in credits, and 1 credit is 1 US cent.
import { useEffect, useState } from 'react';
import { saasErrorMessage } from '../api';
import { readMarketEarnings, type MarketEarnings } from '../marketApi';
import { creditsText, dateText, payoutStatusName, useMarketI18n } from './marketText';

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
  if (onlyIfAny && !(earnings && (earnings.pending || earnings.available || earnings.transferring || earnings.paid || earnings.payouts.length))) return null;
  const amount = (credits: number) => t(`${creditsText(credits, locale)} 点（${dollars(credits, locale)}）`, `${creditsText(credits, locale)} credits (${dollars(credits, locale)})`);
  return <section className="saas-card saas-settings-card saas-market-earnings" aria-label={t('收益', 'Earnings')}>
    <h2>{t('收益', 'Earnings')}</h2>
    {error !== null ? <p role="alert" className="saas-error">{saasErrorMessage(error, locale)} <button type="button" onClick={() => setAttempt(value => value + 1)}>{t('重试', 'Retry')}</button></p>
      : !earnings ? <p role="status">{t('正在读取收益…', 'Loading earnings…')}</p>
      : <>
        <dl>
          <div><dt>{t('待确定', 'Pending')}</dt><dd>{amount(earnings.pending)}</dd></div>
          <div><dt>{t('可转出', 'Available')}</dt><dd>{amount(earnings.available)}</dd></div>
          <div><dt>{t('正在转入', 'Transferring')}</dt><dd>{amount(earnings.transferring)}</dd></div>
          <div><dt>{t('已转入', 'Transferred')}</dt><dd>{amount(earnings.paid)}</dd></div>
        </dl>
        {earnings.asOf && <p className="saas-settings-description">{t(`截至 ${dateText(earnings.asOf, locale)}。`, `As of ${dateText(earnings.asOf, locale)}.`)}</p>}
        <p className="saas-settings-description">{t(`每次成功的付费调用，你得到价格减去平台抽成（${earnings.feeBps / 100}%）后的部分，而且只计调用方买来的点数：调用方这一期用的有赠送的点数时按比例减少，期内退款或拒付就没有收益。调用方的计费期结束后再过 ${earnings.holdDays} 天，收益才确定、可以转出。`,
          `For each successful paid call you get its price less the platform’s fee (${earnings.feeBps / 100}%), counting only credits the caller bought: a period the caller also spent gifted credits in pays proportionally less, and a refund or chargeback in the period leaves nothing. Earnings are settled and can be transferred ${earnings.holdDays} days after the caller’s billing period ends.`)}</p>
        <p role="status">{!earnings.payoutsEnabled ? t('转入 ClawHunt 钱包暂未开放：收益照常记账，显示为待转入，开放后自动转入。', 'Transfers to ClawHunt wallets are not open yet: earnings are recorded as usual and wait, and they transfer once it opens.')
          : earnings.clawHuntLinked ? t('收益会自动转入你的 ClawHunt 钱包，之后用 ClawHunt 的提现取出。', 'Earnings transfer to your ClawHunt wallet by themselves; withdraw them with ClawHunt’s payouts.')
          : t('绑定 ClawHunt 账号后才能转入：在那之前收益一直累积，绑定后自动转入。', 'Earnings transfer once you link a ClawHunt account; until then they build up, and they transfer by themselves after you link one.')}</p>
        {earnings.payouts.length > 0 ? <div className="saas-table-wrap"><table>
          <thead><tr><th>{t('金额', 'Amount')}</th><th>{t('状态', 'Status')}</th><th>{t('创建', 'Created')}</th><th>{t('转入', 'Transferred')}</th></tr></thead>
          <tbody>{earnings.payouts.map(payout => <tr key={payout.id}><td>{dollars(payout.amountCents, locale)}</td><td>{payoutStatusName(payout.status, t)}</td>
            <td>{dateText(payout.createdAt, locale)}</td><td>{dateText(payout.sentAt, locale)}</td></tr>)}</tbody>
        </table></div> : <p className="saas-settings-description">{t('还没有转账记录。', 'No transfers yet.')}</p>}
      </>}
  </section>;
}
