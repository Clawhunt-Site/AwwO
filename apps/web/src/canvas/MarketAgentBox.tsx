// The market Agent in a node's settings: which one, at which version and price, who made it, and a newer listed version
// to update to. Choosing another, updating or taking it off changes the panel's draft, which the panel's own save (and
// preparation, 保存并准备运行) applies, as every other setting there.
import { useMemo } from 'react';
import { RefreshCw } from 'lucide-react';
import { useCanvasI18n } from './i18n';
import type { MarketAgentReference } from './canvasDoc';
import type { ModelPaletteSelection } from './modelPalette';
import { marketChoice, type MarketNodeChoice } from './marketAgents';
import { forgetMarketAgent, useMarketAgentInfo, useWorkspacePaidPlan } from '../saas/market/useMarket';
import { marketModelDecision } from '../saas/market/marketModel';
import { currentSaaSCanvas } from '../saas/canvasBridge';
import { accountURL } from '../saas/PersonalAccount';
import './market-agent.css';

export function MarketAgentBox({ agentRef, disabled, catalogue, onApply, onPick, onDetach }: {
  agentRef: MarketAgentReference; disabled: boolean;
  /** The workspace's chat models, which decide the model an update brings (null: they could not be read). */
  catalogue: ReadonlyArray<ModelPaletteSelection> | null;
  onApply: (choice: MarketNodeChoice) => void; onPick?: () => void; onDetach: () => void;
}) {
  const { locale } = useCanvasI18n();
  const text = (zh: string, en: string) => locale === 'zh' ? zh : en;
  const price = (value: number) => value > 0 ? text(`每次 ${value} 点`, `${value} credits a call`) : text('免费', 'Free');
  const info = useMarketAgentInfo(agentRef);
  const own = info.pinned ?? undefined;
  const listed = info.listed;
  const shown = own ?? listed ?? undefined;
  // A node that names no version takes the listed one when it is prepared: there is nothing newer to update to.
  const newer = listed && agentRef.version && listed.version > agentRef.version ? listed : null;
  const update = useMemo(() => newer ? marketModelDecision(newer.model, catalogue) : null, [newer, catalogue]);
  // A paid version needs the workspace owner's plan, as choosing it in the market does (its author is never charged).
  const paidUpdate = Boolean(newer && newer.price > 0 && !newer.status && !newer.latest);
  const plan = useWorkspacePaidPlan(currentSaaSCanvas()?.tenant.id, paidUpdate);
  const author = shown ? shown.official ? text('AwwO 官方', 'AwwO official') : shown.author?.name || text('作者未署名', 'Unnamed author') : '—';
  return <section className="canvas-inspector-hint awwo-market-box" role="group" aria-label={text('市场 Agent', 'Market Agent')}>
    <strong>{text('市场 Agent', 'Market Agent')}：{shown?.name ?? (info.failed ? text('读不到详情', 'Details unavailable') : text('正在读取…', 'Loading…'))}</strong>
    <dl>
      <dt>{text('版本', 'Version')}</dt><dd>{agentRef.version ? `v${agentRef.version}`
        : text(`上架的版本${listed ? `（现在是 v${listed.version}）` : ''}，准备运行时确定`, `The listed one${listed ? ` (v${listed.version} now)` : ''}, settled when the node is prepared`)}</dd>
      <dt>{text('价格', 'Price')}</dt><dd>{own ? price(own.price) : '—'}</dd>
      <dt>{text('作者', 'Author')}</dt><dd>{author}</dd>
    </dl>
    <p>{text('这个 Agent 带着自己的指令和技能；节点的任务要求、资料和对话照常是你的。节点运行完成时按价格扣点；Agent 写出内容后运行被你停止、被节点自己的输出格式拒收、被截断、中途拒答或超时，也照常扣点。',
      'The Agent brings its own instructions and skills; the node’s task requirements, knowledge and conversation stay yours. Its price is taken when the node completes, and also, once the Agent has written, when you stop the run or it is rejected by your node’s own output format, cut off, refused part way or timed out.')}</p>
    {newer && <div className="awwo-market-box-update" role="status">
      <span>{text(`有新版本 v${newer.version} · ${price(newer.price)}`, `New version v${newer.version} · ${price(newer.price)}`)}</span>
      {update?.kind === 'blocked' ? <span>{text('（锁定的模型你的工作区用不了）', '(its locked model is not available to your workspace)')}</span>
        : paidUpdate && plan === false ? <span>{text('（付费版本需要工作区所有者有 Pro / Max 套餐）', '(a paid version needs the workspace owner’s Pro or Max plan)')}{' '}
          <a href={accountURL('plans')} target="_blank" rel="noopener noreferrer">{text('查看套餐', 'See the plans')}</a></span>
        : <button type="button" className="canvas-inspector-link" disabled={disabled || !update} onClick={() => { if (update) onApply(marketChoice(newer, update)); }}>{text('更新', 'Update')}</button>}
    </div>}
    {listed === null && <p role="status">{text('这个 Agent 已不在市场上（下架或停用）：下架的照常运行，停用的不能再运行。', 'This Agent is no longer in the market (unlisted or suspended): an unlisted one still runs, a suspended one no longer does.')}</p>}
    {info.failed && <button type="button" className="canvas-inspector-link" onClick={() => forgetMarketAgent(agentRef.agentId)}><RefreshCw size={12} aria-hidden="true" />{text('重新读取', 'Read again')}</button>}
    <div className="awwo-market-box-actions">
      {onPick && <button type="button" className="canvas-inspector-link" disabled={disabled} onClick={onPick}>{text('换一个', 'Choose another')}</button>}
      <button type="button" className="canvas-inspector-link" disabled={disabled} onClick={onDetach}>{text('不用 Agent', 'No Agent')}</button>
    </div>
  </section>;
}
