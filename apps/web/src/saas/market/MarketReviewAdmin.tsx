// 平台管理 → 市场审核: every version waiting for review, shown whole (its instructions and the full text of its skills
// included) for the administrator to check for hidden text, prompt injection, impersonation and content that breaks
// the rules, then approve or reject with a note the author reads; suspending and restoring an Agent; and the transfers
// of authors' earnings to their ClawHunt wallets.
import { useEffect, useState } from 'react';
import { SaaSApiError, saasErrorMessage } from '../api';
import { browseMarketAgents, decideMarketReview, readMarketPayouts, readMarketReviews, setMarketAgentStatus,
  type MarketAdminPayout, type MarketAgentSummary, type MarketReview } from '../marketApi';
import { hasHiddenText } from './publishForm';
import { authorText, categoryName, dateText, payoutStatusName, priceText, useMarketI18n } from './marketText';
import './market.css';

/** `open` false: the market is closed, and only the transfers of what was earned go on (market_config.go). */
export function MarketReviewAdmin({ open = true }: { open?: boolean }) {
  const { t } = useMarketI18n();
  if (!open) return <div className="saas-market-review">
    <p className="saas-admin-note">{t('Agent 市场现在关闭：不能再审核或使用 Agent，已赚的收益照常结算、转账。', 'The Agent market is closed: Agents can no longer be reviewed or used, and what was earned settles and transfers as usual.')}</p>
    <Payouts />
  </div>;
  return <div className="saas-market-review">
    <p className="saas-admin-note">{t('作者提交的每个版本在这里审核：看全部内容（含指令与技能全文），检查隐藏字符、提示词注入、冒名和违规内容，再批准或驳回并写意见，作者能看到意见。批准后该版本上架，旧的上架版本被替换，已锁定旧版本的节点继续用旧版本。',
      'Each version an author submits is reviewed here: read all of it (its instructions and its skills’ full text included), check for hidden characters, prompt injection, impersonation and content that breaks the rules, then approve or reject it with a note its author reads. An approved version lists and replaces the listed one; nodes locked to the old version keep it.')}</p>
    <Reviews />
    <Suspensions />
    <Payouts />
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

function Payouts() {
  const { locale, t } = useMarketI18n();
  const [items, setItems] = useState<MarketAdminPayout[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    const controller = new AbortController();
    readMarketPayouts(controller.signal).then(value => { if (!controller.signal.aborted) setItems(value); }, cause => { if (!controller.signal.aborted) setError(cause); });
    return () => controller.abort();
  }, []);
  const dollars = (cents: number) => new Intl.NumberFormat(locale === 'zh' ? 'zh-CN' : 'en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
  return <section aria-label={t('转账记录', 'Transfers')}>
    <h2>{t('转账记录', 'Transfers')}</h2>
    {error !== null && <p role="alert" className="saas-error">{saasErrorMessage(error, locale)}</p>}
    {!items ? error === null && <p role="status">{t('正在加载…', 'Loading…')}</p>
      : !items.length ? <p>{t('还没有转账。', 'No transfers yet.')}</p>
      : <div className="saas-table-wrap"><table>
        <thead><tr><th>{t('作者', 'Author')}</th><th>{t('ClawHunt 交易', 'ClawHunt transaction')}</th><th>{t('金额', 'Amount')}</th><th>{t('状态', 'Status')}</th><th>{t('尝试次数', 'Attempts')}</th><th>{t('创建', 'Created')}</th><th>{t('转入', 'Sent')}</th></tr></thead>
        <tbody>{items.map(item => <tr key={item.id}><td>{item.author || '—'}</td><td>{item.transaction || '—'}</td><td>{dollars(item.amountCents)}</td>
          <td>{payoutStatusName(item.status, t)}{item.lastError ? ` · ${item.lastError}` : ''}</td>
          <td>{item.attempts}</td><td>{dateText(item.createdAt, locale)}</td><td>{dateText(item.sentAt, locale)}</td></tr>)}</tbody>
      </table></div>}
  </section>;
}
