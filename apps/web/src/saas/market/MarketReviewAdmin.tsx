// 平台管理 → 市场审核: every version waiting for review, shown whole (its instructions and the full text of its skills
// included) for the administrator to check for hidden text, prompt injection, impersonation and content that breaks
// the rules, then approve or reject with a note the author reads; suspending and restoring an Agent; and the monthly
// statements of authors' earnings, each transferred to the author's ClawHunt wallet only once approved here.
import { useEffect, useState } from 'react';
import { SaaSApiError, saasErrorMessage } from '../api';
import { approveMarketStatement, browseMarketAgents, decideMarketReview, readMarketPayouts, readMarketReviews, setMarketAgentStatus,
  type MarketAdminPayout, type MarketAgentSummary, type MarketReview, type MarketStatements } from '../marketApi';
import { hasHiddenText } from './publishForm';
import { authorText, categoryName, creditsText, dateText, monthText, payoutErrorText, payoutStatusName, priceText, useMarketI18n } from './marketText';
import './market.css';

/** `open` false: the market is closed, and only the settling of what was earned goes on (market_config.go). */
export function MarketReviewAdmin({ open = true }: { open?: boolean }) {
  const { t } = useMarketI18n();
  if (!open) return <div className="saas-market-review">
    <p className="saas-admin-note">{t('Agent 市场现在关闭：不能再审核或使用 Agent，已赚的收益照常结算、每月出账单，批准后转账。', 'The Agent market is closed: Agents can no longer be reviewed or used, and what was earned settles as usual, on monthly statements that transfer once approved.')}</p>
    <Statements />
  </div>;
  return <div className="saas-market-review">
    <p className="saas-admin-note">{t('作者提交的每个版本在这里审核：看全部内容（含指令与技能全文），检查隐藏字符、提示词注入、冒名和违规内容，再批准或驳回并写意见，作者能看到意见。批准后该版本上架，旧的上架版本被替换，已锁定旧版本的节点继续用旧版本。',
      'Each version an author submits is reviewed here: read all of it (its instructions and its skills’ full text included), check for hidden characters, prompt injection, impersonation and content that breaks the rules, then approve or reject it with a note its author reads. An approved version lists and replaces the listed one; nodes locked to the old version keep it.')}</p>
    <Reviews />
    <Suspensions />
    <Statements />
  </div>;
}

function Reviews() {
  const { locale, t } = useMarketI18n();
  const [items, setItems] = useState<MarketReview[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState('');
  const [revision, setRevision] = useState(0);
  // Why the list was read again after a decision the server refused as made on an older reading.
  const [staleNotice, setStaleNotice] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    readMarketReviews(controller.signal).then(value => { if (!controller.signal.aborted) { setItems(value); setError(null); } },
      cause => { if (!controller.signal.aborted) setError(cause); });
    return () => controller.abort();
  }, [revision]);
  const decide = async (item: MarketReview, decision: 'approve' | 'reject') => {
    const key = `${item.agentId}@${item.version}`;
    const note = (notes[key] ?? '').trim();
    if (busy || (decision === 'reject' && !note)) return;
    setBusy(key); setError(null); setStaleNotice('');
    try { await decideMarketReview(item.agentId, item.version, decision, note, item.reviewHash); setRevision(value => value + 1); }
    catch (cause) {
      // A version its author changed since it was read, or one no longer in review, is read again, and the reason stays.
      const stale = cause instanceof SaaSApiError && (cause.code === 'market_review_changed' || cause.code === 'market_not_pending');
      if (stale) { setStaleNotice(saasErrorMessage(cause, locale)); setRevision(value => value + 1); } else setError(cause);
    }
    finally { setBusy(''); }
  };
  return <section aria-label={t('待审版本', 'Versions to review')}>
    <h2>{t('待审版本', 'Versions to review')}</h2>
    {error !== null && <p role="alert" className="saas-error">{saasErrorMessage(error, locale)}</p>}
    {staleNotice && <p role="status" className="saas-admin-note">{staleNotice}</p>}
    {!items ? error === null && <p role="status">{t('正在加载…', 'Loading…')}</p>
      : !items.length ? <p>{t('没有待审的版本。', 'No versions are waiting for review.')}</p>
      : items.map(item => {
        const key = `${item.agentId}@${item.version}`;
        const hidden = [item.name, item.tagline, item.description, item.instructions, ...item.skills.map(skill => skill.body), ...item.examples.map(example => example.prompt + example.result)].some(hasHiddenText);
        return <article key={key} className="saas-market-review-item" aria-label={t(`${item.name} v${item.version}`, `${item.name} v${item.version}`)}>
          <h3>{item.name} · v{item.version}</h3>
          <p>{[item.authorName && t(`署名：${item.authorName}`, `Signed: ${item.authorName}`),
            item.listedAuthorName && item.listedAuthorName !== item.authorName && t(`（现在显示的署名：${item.listedAuthorName}，批准后换成新的）`, `(shown now: ${item.listedAuthorName}; approving replaces it)`),
            item.author && t(`账号：${item.author}`, `Account: ${item.author}`),
            categoryName(item.category, t), item.kind === 'coding' ? t('编程', 'Coding') : t('文字', 'Text'), priceText(item.price, t),
            t(`提交于 ${dateText(item.submittedAt, locale)}`, `Submitted ${dateText(item.submittedAt, locale)}`)].filter(Boolean).join(' · ')}</p>
          {hidden && <p role="alert" className="saas-error">{t('内容里有看不见的格式字符。', 'The content holds invisible formatting characters.')}</p>}
          <p>{t('模型：', 'Model: ')}{item.model.id ? `${item.model.runtime ? `${item.model.runtime} · ` : ''}${item.model.id}${item.model.effort ? ` · ${item.model.effort}` : ''}${item.model.locked ? t('（锁定）', ' (locked)') : ''}` : t('未指定', 'None')}
            {' · '}{item.instructionsPublic ? t('指令公开', 'Instructions public') : t('指令不公开', 'Instructions private')}</p>
          {item.tagline && <p>{item.tagline}</p>}
          {item.description && <><h4>{t('介绍', 'Description')}</h4><pre>{item.description}</pre></>}
          <h4>{t('指令', 'Instructions')}</h4><pre>{item.instructions || t('（空）', '(empty)')}</pre>
          {item.skills.map(skill => <details key={skill.name || skill.title}><summary>{t(`技能：${skill.title || skill.name}`, `Skill: ${skill.title || skill.name}`)}{skill.license ? ` · ${skill.license}` : ''}{skill.attribution ? ` · ${skill.attribution}` : ''}</summary>
            <pre>{skill.body || t('（没有返回技能全文）', '(no skill text returned)')}</pre></details>)}
          {item.examples.map((example, index) => <details key={index}><summary>{t(`示例 ${index + 1}`, `Example ${index + 1}`)}</summary><pre>{example.prompt}{'\n\n'}{example.result}</pre></details>)}
          <label>{t('审核意见（驳回时必填，作者能看到）', 'Review note (needed to reject; the author reads it)')}
            <textarea value={notes[key] ?? ''} disabled={Boolean(busy)} onChange={event => setNotes(current => ({ ...current, [key]: event.target.value }))} /></label>
          <div className="saas-admin-actions">
            <button type="button" disabled={Boolean(busy)} onClick={() => void decide(item, 'approve')}>{t('批准上架', 'Approve')}</button>
            <button type="button" disabled={Boolean(busy) || !(notes[key] ?? '').trim()} onClick={() => void decide(item, 'reject')}>{t('驳回', 'Reject')}</button>
          </div>
        </article>;
      })}
  </section>;
}

function Suspensions() {
  const { locale, t } = useMarketI18n();
  const [listed, setListed] = useState<MarketAgentSummary[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const [agentId, setAgentId] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    browseMarketAgents({ sort: 'new', limit: 50 }, controller.signal).then(page => { if (!controller.signal.aborted) setListed(page.items); },
      cause => { if (!controller.signal.aborted) setError(cause); });
    return () => controller.abort();
  }, [revision]);
  const change = async (id: string, status: 'suspended' | 'listed') => {
    if (busy || !id.trim()) return;
    setBusy(true); setError(null); setNotice('');
    try {
      await setMarketAgentStatus(id.trim(), status);
      setNotice(status === 'suspended' ? t('已停用：这个 Agent 的所有使用立即停止。', 'Suspended: every use of the Agent stops at once.') : t('已恢复上架。', 'Restored to the market.'));
      setRevision(value => value + 1);
    } catch (cause) { setError(cause); }
    finally { setBusy(false); }
  };
  return <section aria-label={t('停用与恢复', 'Suspend and restore')}>
    <h2>{t('停用与恢复', 'Suspend and restore')}</h2>
    {error !== null && <p role="alert" className="saas-error">{saasErrorMessage(error, locale)}</p>}
    {notice && <p role="status">{notice}</p>}
    <div className="saas-admin-tools"><label>{t('Agent ID', 'Agent ID')}<input value={agentId} disabled={busy} onChange={event => setAgentId(event.target.value)} /></label>
      <button type="button" disabled={busy || !agentId.trim()} onClick={() => void change(agentId, 'suspended')}>{t('停用', 'Suspend')}</button>
      <button type="button" disabled={busy || !agentId.trim()} onClick={() => void change(agentId, 'listed')}>{t('恢复', 'Restore')}</button></div>
    {listed && listed.length > 0 && <div className="saas-table-wrap"><table>
      <thead><tr><th>{t('上架的 Agent', 'Listed Agent')}</th><th>{t('作者', 'Author')}</th><th>{t('价格', 'Price')}</th><th>ID</th><th>{t('操作', 'Actions')}</th></tr></thead>
      <tbody>{listed.map(agent => <tr key={agent.id}><td>{agent.name} · v{agent.version}</td><td>{authorText(agent, t)}</td><td>{priceText(agent.price, t)}</td><td>{agent.id}</td>
        <td><button type="button" disabled={busy} onClick={() => void change(agent.id, 'suspended')}>{t('停用', 'Suspend')}</button></td></tr>)}</tbody>
    </table></div>}
  </section>;
}

/** ClawHunt's default cap on one transfer, in cents ($10,000): a statement above it is refused until ClawHunt raises it. */
const CLAWHUNT_TRANSFER_CAP_CENTS = 1_000_000;

/** The monthly statements (market_settle.go): each author's earnings made final in a calendar month (UTC), made on the
 *  1st, and transferred only once an administrator approves them here (owner 2026-10-29: no automatic transfers). */
function Statements() {
  const { locale, t } = useMarketI18n();
  const [list, setList] = useState<MarketStatements | null>(null);
  const [error, setError] = useState<unknown>(null);
  // Why the last approval failed: kept apart from the list's own reading, which an approval's re-read would clear.
  const [failure, setFailure] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  // The statement whose approval waits for its confirmation, and the one being approved.
  const [confirming, setConfirming] = useState('');
  const [busy, setBusy] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    readMarketPayouts(controller.signal).then(value => { if (!controller.signal.aborted) { setList(value); setError(null); } },
      cause => { if (!controller.signal.aborted) setError(cause); });
    return () => controller.abort();
  }, [revision]);
  const dollars = (cents: number) => new Intl.NumberFormat(locale === 'zh' ? 'zh-CN' : 'en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
  const approve = async (item: MarketAdminPayout) => {
    if (busy) return;
    setBusy(item.id); setFailure(null); setNotice('');
    try {
      const done = await approveMarketStatement(item.id, item.amountCents);
      const who = item.author || t('作者', 'the author');
      setNotice(done.status === 'sent' ? t(`已转入 ${who} 的 ClawHunt 钱包：${dollars(done.amountCents)}。`, `Transferred ${dollars(done.amountCents)} to ${who}’s ClawHunt wallet.`)
        : done.status === 'held' ? t('已批准，但作者的 ClawHunt 账号现在不能收款：每天重试。', 'Approved, but the author’s ClawHunt account cannot receive it now: it is tried again daily.')
        : t(`已批准，这次没有转成功：${payoutErrorText(done.lastError, t)}。`, `Approved; this attempt did not go through: ${payoutErrorText(done.lastError, t)}.`));
    } catch (cause) {
      // One approved meanwhile (in another tab), or of another amount than the one confirmed, is read again, and the
      // reason stays.
      if (cause instanceof SaaSApiError && (cause.code === 'market_statement_not_in_review' || cause.code === 'market_statement_changed')) setNotice(saasErrorMessage(cause, locale));
      else setFailure(cause);
    } finally { setBusy(''); setConfirming(''); setRevision(value => value + 1); }
  };
  const items = list?.items ?? [];
  const waiting = items.filter(item => item.status === 'review').length;
  return <section aria-label={t('月度账单', 'Monthly statements')}>
    <h2>{t('月度账单', 'Monthly statements')}</h2>
    <p className="saas-admin-note">{t('每个月（UTC）结束后，通常是次月 1 日（后台停过时会按月补出），那个月确定的收益按作者汇总成一张账单：调用次数、点数和收益，按 Agent 分列。核对后点「批准并转入」，金额转入作者的 ClawHunt 钱包；没有批准的账单不会转账。',
      'Once a month (UTC) has ended, usually on the 1st (months the job missed are caught up one by one), the earnings settled in it are gathered into one statement per author: its calls, credits and earnings, by Agent. Check it, then press “Approve and transfer” to send the amount to the author’s ClawHunt wallet; no statement is transferred without an approval.')}</p>
    {list && !list.payoutsEnabled && <p role="status" className="saas-admin-note">{t('转账没有开启（AWWO_MARKET_PAYOUTS）：账单照常生成，开启后才能批准。', 'Transfers are off (AWWO_MARKET_PAYOUTS): statements are made as usual, and can be approved once transfers are on.')}</p>}
    {waiting > 0 && <p role="status">{t(`有 ${waiting} 张账单等待审核。`, `${waiting} ${waiting === 1 ? 'statement is' : 'statements are'} waiting for review.`)}</p>}
    {error !== null && <p role="alert" className="saas-error">{saasErrorMessage(error, locale)}</p>}
    {failure !== null && <p role="alert" className="saas-error">{saasErrorMessage(failure, locale)}</p>}
    {notice && <p role="status">{notice}</p>}
    {!list ? error === null && <p role="status">{t('正在加载…', 'Loading…')}</p>
      : !items.length ? <p>{t('还没有账单。', 'No statements yet.')}</p>
      : <>
        <div className="saas-table-wrap"><table>
          <thead><tr><th>{t('月份', 'Month')}</th><th>{t('作者', 'Author')}</th><th>{t('调用', 'Calls')}</th><th>{t('点数', 'Credits')}</th><th>{t('金额', 'Amount')}</th>
            <th>{t('状态', 'Status')}</th><th>{t('ClawHunt 交易', 'ClawHunt transaction')}</th><th>{t('操作', 'Actions')}</th></tr></thead>
          <tbody>{items.map(item => <tr key={item.id} aria-label={`${monthText(item.month, locale)} · ${item.author || item.id}`}>
            <td>{monthText(item.month, locale)}</td><td>{item.author || '—'}</td><td>{item.calls}</td><td>{creditsText(item.credits, locale)}</td><td>{dollars(item.amountCents)}</td>
            <td>{payoutStatusName(item.status, t)}{item.lastError ? ` · ${payoutErrorText(item.lastError, t)}` : ''}
              {item.approvedBy && <><br />{t(`批准：${item.approvedBy}，${dateText(item.approvedAt, locale)}`, `Approved by ${item.approvedBy}, ${dateText(item.approvedAt, locale)}`)}</>}
              {item.status === 'review' && item.amountCents > CLAWHUNT_TRANSFER_CAP_CENTS && <><br />{t('超过 ClawHunt 默认的单笔上限 $10,000：批准前先请 ClawHunt 调高上限。', 'Above ClawHunt’s default cap of $10,000 a transfer: have ClawHunt raise it before approving.')}</>}</td>
            <td>{item.transaction || '—'}</td>
            <td>{item.status !== 'review' ? '—' : !item.complete ? t('数据不完整，不能在这里批准', 'Incomplete data: it cannot be approved here') : confirming === item.id
              ? <span className="saas-admin-actions">
                <button type="button" disabled={Boolean(busy)} onClick={() => void approve(item)}>{t(`确认转入 ${dollars(item.amountCents)}`, `Confirm ${dollars(item.amountCents)}`)}</button>
                <button type="button" disabled={Boolean(busy)} onClick={() => setConfirming('')}>{t('取消', 'Cancel')}</button></span>
              : <button type="button" disabled={Boolean(busy) || !list.payoutsEnabled} onClick={() => setConfirming(item.id)}>{t('批准并转入', 'Approve and transfer')}</button>}</td>
          </tr>)}</tbody>
        </table></div>
        {items.filter(item => item.agents.length > 0).map(item => <details key={item.id}>
          <summary>{t(`${monthText(item.month, locale)} · ${item.author || item.id}：按 Agent`, `${monthText(item.month, locale)} · ${item.author || item.id}: by Agent`)}</summary>
          <div className="saas-table-wrap"><table>
            <thead><tr><th>Agent</th><th>{t('调用', 'Calls')}</th><th>{t('点数', 'Credits')}</th><th>{t('收益（点）', 'Earned (credits)')}</th></tr></thead>
            <tbody>{item.agents.map(agent => <tr key={agent.id}><td>{agent.name ? `${agent.name} · ${agent.id}` : agent.id}</td><td>{agent.calls}</td>
              <td>{creditsText(agent.credits, locale)}</td><td>{creditsText(agent.earnedMicrocredits / 1_000_000, locale)}</td></tr>)}</tbody>
          </table></div>
          {item.carryInMicrocredits > 0 && <p className="saas-admin-note">{t(`含上一张账单留下的不足 1 美分的 ${creditsText(item.carryInMicrocredits / 1_000_000, locale)} 点。`, `Includes ${creditsText(item.carryInMicrocredits / 1_000_000, locale)} credits below a cent left by the statement before.`)}</p>}
        </details>)}
      </>}
  </section>;
}
