// An Agent's page in the market dialog: what it does and how, the skills and model it brings, how its runs went in plain
// words, and the one action the dialog was opened for. A paid Agent the workspace's plan cannot pay says so instead of
// offering an action the server would refuse.
import { Lock, ThumbsDown, ThumbsUp } from 'lucide-react';
import { saasErrorMessage } from '../api';
import { useLocalEdition } from '../edition';
import { accountURL } from '../PersonalAccount';
import { recordUpgradeInterest } from '../routeUsage';
import { renderInertMarkdown } from '../inertMarkdown';
import type { MarketAgentDetail as Detail } from '../marketApi';
import type { MarketAgentReference } from '../../canvas/canvasDoc';
import { decisionNote, type MarketModelDecision } from './marketModel';
import { authorText, categoryName, creditsText, dateText, numberText, percentText, priceText, secondsText, useMarketI18n } from './marketText';

export type MarketTarget =
  /** Choosing the Agent for one node (its composer chip, or its settings). */
  | { kind: 'node'; title: string; current?: MarketAgentReference }
  /** Adding a node with the Agent to the open canvas. */
  | { kind: 'canvas' }
  /** The workspace home: a new canvas with the Agent, where the reader may create canvases. */
  | { kind: 'home'; canCreate: boolean };

interface Props {
  detail: Detail; tenantId: string; target: MarketTarget;
  /** What choosing the Agent does to the node's model; null while the workspace's models are read. */
  decision: MarketModelDecision | null;
  /** A paid Agent whose workspace owner has no paid plan (and the reader is not its author). */
  planNeeded: boolean;
  busy: boolean; error: unknown;
  onUse?: () => void; onDetach?: () => void;
}

export function MarketAgentDetailView({ detail, tenantId, target, decision, planNeeded, busy, error, onUse, onDetach }: Props) {
  const { locale, t } = useMarketI18n();
  const localEdition = useLocalEdition();
  const stats = detail.stats;
  const current = target.kind === 'node' ? target.current : undefined;
  // The node's version of this Agent; one that names none takes the listed one (this detail).
  const pinned = current?.agentId === detail.id ? current.version ?? detail.version : null;
  const inUse = pinned === detail.version;
  const newer = pinned !== null && pinned < detail.version;
  const useLabel = target.kind === 'node' ? newer ? t(`更新到 v${detail.version}`, `Update to v${detail.version}`) : t('用在这个节点', 'Use on this node')
    : target.kind === 'canvas' ? t('添加到画布', 'Add to the canvas') : t('新建画布使用', 'Use in a new canvas');
  const canUse = Boolean(onUse) && (target.kind !== 'home' || target.canCreate);
  return <article className="awwo-library-detail awwo-market-detail" aria-label={t(`${detail.name} 的详情`, `${detail.name} details`)}>
    <div className="awwo-library-item-head">
      <span className="awwo-library-badge">{categoryName(detail.category, t)}</span>
      <span className="awwo-library-badge">{detail.kind === 'coding' ? t('编程', 'Coding') : t('文字', 'Text')}</span>
      <span className="awwo-library-badge">v{detail.version}</span>
      {detail.official && <span className="awwo-library-badge is-pinned">{t('官方', 'Official')}</span>}
    </div>
    <h3>{detail.name}</h3>
    {detail.tagline && <p className="awwo-library-help">{detail.tagline}</p>}
    <p className="awwo-library-meta">{authorText(detail, t)} · {priceText(detail.price, t)}{detail.listedAt ? t(` · ${dateText(detail.listedAt, locale)} 上架`, ` · listed ${dateText(detail.listedAt, locale)}`) : ''}</p>

    <section className="awwo-market-actions" aria-label={t('使用', 'Use')}>
      {pinned !== null && <p className="awwo-library-meta" role="status">{inUse ? t('这个节点正在用这个版本。', 'This node uses this version.')
        : t(`这个节点用的是 v${pinned}，最新上架的是 v${detail.version}。`, `This node uses v${pinned}; v${detail.version} is listed now.`)}</p>}
      {decision && <p className={`awwo-market-note${decision.kind === 'blocked' ? ' is-warning' : ''}`}>{decisionNote(decision, detail.model.locked, t)}</p>}
      {planNeeded && <div className="awwo-market-plan" role="note">
        <p>{t(`这是付费 Agent，每次成功调用扣 ${detail.price} 点：工作区所有者有 Pro / Max 付费套餐才能用。免费 Agent 不需要套餐。`,
          `This is a paid Agent that takes ${detail.price} credits a successful call: it needs the workspace owner to have the Pro or Max plan. Free Agents need no plan.`)}</p>
        {!localEdition && <a className="awwo-library-primary awwo-market-plan-link" href={accountURL('plans')} target="_blank" rel="noopener noreferrer"
          onClick={() => { void recordUpgradeInterest(tenantId).catch(() => {}); }}>{t('查看 Pro / Max 套餐', 'See the Pro and Max plans')}</a>}
      </div>}
      {(canUse && !planNeeded) || (current && onDetach) ? <div className="awwo-library-editor-actions">
        {current && onDetach && <button type="button" disabled={busy} onClick={onDetach}>{t('不用 Agent', 'No Agent')}</button>}
        {canUse && !planNeeded && <button type="button" className="awwo-library-primary" disabled={busy || inUse || !decision || decision.kind === 'blocked'} onClick={onUse}>
          {busy ? t('正在处理…', 'Working…') : inUse ? t('正在使用', 'In use') : useLabel}</button>}
      </div> : null}
      {detail.price > 0 && !planNeeded && <p className="awwo-library-meta">{t('节点运行完成时扣费。Agent 已经写出内容后，运行被你停止、被你的节点自己的输出格式拒收、被截断、中途拒答或超时，也照常扣费（写出的内容归你）。Agent 写出内容前就结束的、平台和服务商的故障，以及其余失败都不扣。',
        'The fee is taken when the node’s run completes. Once the Agent has written, it is also taken when you stop the run, your node’s own output format rejects it, or it is cut off, refused part way or times out (what it wrote is yours). A run that ends before the Agent writes, a platform or provider fault, and any other failure cost nothing.')}</p>}
      {error !== null && error !== undefined && <p className="awwo-library-alert" role="alert">{saasErrorMessage(error, locale)}</p>}
    </section>

    {detail.description && <div className="awwo-library-markdown">{renderInertMarkdown(detail.description)}</div>}

    <section className="awwo-market-section" aria-label={t('运行表现', 'How it runs')}>
      <h4>{t('近 30 天的真实运行', 'Real runs in the last 30 days')}</h4>
      <dl className="awwo-market-stats">
        <div><dt>{t('调用次数', 'Calls')}</dt><dd>{numberText(stats.calls, locale)}</dd></div>
        <div><dt>{t('成功率（有效运行里完成并通过交付检查的比例）', 'Success rate (of counted runs, the share that completed and passed the delivery check)')}</dt><dd>{percentText(stats.successRate)}</dd></div>
        <div><dt>{t('用过的人', 'People who used it')}</dt><dd>{numberText(stats.users, locale)}</dd></div>
        <div><dt>{t('评价', 'Ratings')}</dt><dd className="awwo-market-votes"><ThumbsUp size={13} aria-hidden="true" />{stats.up}<ThumbsDown size={13} aria-hidden="true" />{stats.down}</dd></div>
        <div><dt>{t('平均用时', 'Average time')}</dt><dd>{secondsText(stats.avgSeconds, t)}</dd></div>
        <div><dt>{t('平均模型花费', 'Average model cost')}</dt><dd>{stats.avgModelCredits === null ? '—' : t(`${creditsText(stats.avgModelCredits, locale)} 点`, `${creditsText(stats.avgModelCredits, locale)} credits`)}</dd></div>
      </dl>
      {!stats.ranked && <p className="awwo-library-meta">{t('有效运行还不到 10 次或用过的人不到 3 位，还没进排行，先放在「新上架」。', 'It has fewer than 10 counted runs or 3 different people, so it is not ranked yet and shows under New.')}</p>}
      <p className="awwo-library-meta">{t('作者自己和同一工作区的调用、取消，以及平台或服务商的故障都不计入。', 'Calls by its author or their workspace, cancellations, and platform or provider faults are not counted.')}</p>
    </section>

    <section className="awwo-market-section" aria-label={t('模型', 'Model')}>
      <h4>{t('推荐模型', 'Suggested model')}</h4>
      <p>{detail.model.id ? <>{decision?.label || detail.model.id}{detail.model.effort ? t(` · 推理强度 ${detail.model.effort}`, ` · reasoning effort ${detail.model.effort}`) : ''}</> : t('没有指定，用节点自己的模型。', 'None: the node runs its own model.')}</p>
      {detail.model.locked && <p className="awwo-library-meta"><Lock size={12} aria-hidden="true" /> {t('作者锁定了模型：用这个 Agent 时节点只能用这个模型。', 'Its author locked the model: a node using this Agent runs only that model.')}</p>}
    </section>

    {detail.skills.length > 0 && <section className="awwo-market-section" aria-label={t('技能', 'Skills')}>
      <h4>{t('自带技能', 'Skills it brings')}</h4>
      <ul className="awwo-market-skills">{detail.skills.map(skill => <li key={skill.name || skill.title}>
        <strong>{skill.title || skill.name}</strong>
        {(skill.attribution || skill.license) && <span className="awwo-library-meta">{[skill.attribution, skill.license && t(`许可：${skill.license}`, `License: ${skill.license}`)].filter(Boolean).join(' · ')}</span>}
      </li>)}</ul>
    </section>}

    {detail.examples.length > 0 && <section className="awwo-market-section" aria-label={t('示例', 'Examples')}>
      <h4>{t('示例', 'Examples')}</h4>
      {detail.examples.map((example, index) => <div key={index} className="awwo-market-example">
        <p><strong>{t('请求', 'Request')}</strong> {example.prompt}</p>
        <p><strong>{t('结果', 'Result')}</strong> {example.result}</p>
      </div>)}
    </section>}

    <section className="awwo-market-section" aria-label={t('指令', 'Instructions')}>
      <h4>{t('指令', 'Instructions')}</h4>
      {detail.instructions !== undefined ? <details className="awwo-market-instructions"><summary>{detail.official ? t('AwwO 官方 Agent 的指令是公开的', 'An AwwO official Agent’s instructions are public')
        : detail.instructionsPublic ? t('作者公开了指令', 'Its author made the instructions public') : t('你能看到指令（作者或管理员）', 'You can read the instructions (author or administrator)')}</summary>
        <pre className="awwo-library-preview">{detail.instructions}</pre></details>
        : <p className="awwo-library-meta">{t('指令不公开：运行时由服务器交给模型，不会写进你的画布。', 'The instructions are not public: the server gives them to the model at each run, and they never enter your canvas.')}</p>}
    </section>
  </article>;
}
