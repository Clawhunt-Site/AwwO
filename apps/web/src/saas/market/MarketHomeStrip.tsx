// The workspace home's Agent market strip: the best-ranked Agents (the server's order), each opening its page in the
// market dialog, and 查看全部 for the whole market. From here an Agent starts a new canvas with one node that uses it;
// a reader of the workspace browses only.
import { useEffect, useId, useState } from 'react';
import { api, tenantPath, type CanvasRecord, type Tenant } from '../api';
import { emptyDocument } from '../../canvas/canvasDoc';
import { createMarketAgentNode, marketChoice } from '../../canvas/marketAgents';
import { browseMarketAgents, type MarketAgentDetail, type MarketAgentSummary } from '../marketApi';
import { AgentMarket } from './AgentMarket';
import { MarketAgentCard } from './MarketAgentCard';
import type { MarketModelDecision } from './marketModel';
import { useMarketI18n } from './marketText';
import { useMarketSettings } from './useMarket';
import './market.css';

/** The Agents the strip shows. */
export const HOME_MARKET_AGENTS = 6;

export function MarketHomeStrip({ tenant, onOpen }: { tenant: Tenant; onOpen: (canvasId: string) => void }) {
  const { locale, t } = useMarketI18n();
  const titleId = useId();
  const settings = useMarketSettings(tenant.status === 'active' ? tenant.id : null);
  const [items, setItems] = useState<MarketAgentSummary[] | null>(null);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [open, setOpen] = useState<{ agentId?: string } | null>(null);
  useEffect(() => {
    if (!settings) return;
    const controller = new AbortController();
    setError(false);
    browseMarketAgents({ sort: 'score', limit: HOME_MARKET_AGENTS }, controller.signal)
      .then(page => { if (!controller.signal.aborted) setItems(page.items.slice(0, HOME_MARKET_AGENTS)); }, () => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [settings, revision]);
  if (!settings) return null;
  const canCreate = tenant.role !== 'reader' && tenant.status === 'active';
  // A canvas of one node that uses the Agent, opened at once (the workspace home makes a blank canvas the same way).
  const use = async (agent: MarketAgentDetail, decision: MarketModelDecision) => {
    const node = createMarketAgentNode(marketChoice(agent, decision), { x: 0, y: 0 }, locale);
    const canvas = await api<CanvasRecord>(tenantPath(tenant.id, '/canvases'), { method: 'POST', body: JSON.stringify({ name: agent.name, document: { ...emptyDocument(), nodes: [node] } }) });
    setOpen(null);
    onOpen(canvas.id);
  };
  return <section className="saas-home-section saas-market-strip" aria-labelledby={titleId}>
    <div className="saas-home-section-header">
      <div className="saas-home-section-title">
        <h2 id={titleId}>{t('Agent 市场', 'Agent market')}</h2>
        <p>{t('除了选模型，也可以挑一个运行表现好的 Agent 用在节点上：它带着作者写好的指令和技能，排行只看真实运行。', 'Besides a model, a node can use a well-performing Agent: it brings the instructions and skills its author wrote, ranked by real runs only.')}</p>
      </div>
      <div className="saas-library-meta"><button type="button" className="saas-list-refresh" onClick={() => setOpen({})}>{t('查看全部', 'See all')}</button></div>
    </div>
    {error ? <p className="saas-market-status" role="alert">{t('暂时读不到 Agent 市场。', 'The Agent market cannot be read right now.')} <button type="button" className="saas-link" onClick={() => setRevision(value => value + 1)}>{t('重试', 'Retry')}</button></p>
      : !items ? <p className="saas-market-status" role="status">{t('正在读取 Agent 市场…', 'Loading the Agent market…')}</p>
      : !items.length ? <p className="saas-market-status">{t('市场里还没有上架的 Agent。', 'No Agents are listed yet.')}</p>
      : <ul className="awwo-market-cards">{items.map(agent => <li key={agent.id}><MarketAgentCard agent={agent} onSelect={() => setOpen({ agentId: agent.id })} /></li>)}</ul>}
    {open && <AgentMarket tenantId={tenant.id} target={{ kind: 'home', canCreate }} initialAgentId={open.agentId}
      onUse={canCreate ? use : undefined} onClose={() => setOpen(null)} />}
  </section>;
}
