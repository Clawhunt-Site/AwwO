// The workspace home's Agent market strip: the best-ranked Agents (the server's order), each opening its page in the
// market dialog, and 查看全部 for the whole market. From here an Agent starts a new canvas with one node that uses it;
// a reader of the workspace browses only. `expanded` is the home's own Agent 市场 section: category chips, more Agents,
// and the note of what the official Agents will cost.
import { useEffect, useId, useState } from 'react';
import { api, tenantPath, type CanvasRecord, type Tenant } from '../api';
import { readCapabilities, type WorkspaceCapabilities } from '../capabilitiesApi';
import { emptyDocument } from '../../canvas/canvasDoc';
import { createMarketAgentNode, marketChoice } from '../../canvas/marketAgents';
import { browseMarketAgents, marketSettingsOf, MARKET_CATEGORIES, type MarketAgentDetail, type MarketAgentSummary, type MarketCategory } from '../marketApi';
import { AgentMarket } from './AgentMarket';
import { MarketAgentCard } from './MarketAgentCard';
import type { MarketModelDecision } from './marketModel';
import { categoryName, officialPriceNotice, useMarketI18n } from './marketText';
import { useMarketSettings } from './useMarket';
import './market.css';

/** The Agents the strip shows. */
export const HOME_MARKET_AGENTS = 6;
/** The Agents the home's Agent 市场 section shows (its 查看全部 opens the whole market). */
export const SECTION_MARKET_AGENTS = 12;

type StripProps = { tenant: Tenant; onOpen: (canvasId: string) => void };

export function MarketHomeStrip({ expanded = false, ...props }: StripProps & { expanded?: boolean }) {
  return expanded ? <MarketSection {...props} /> : <HomeStrip {...props} />;
}

/** A canvas of one node that uses the Agent, opened at once (the workspace home makes a blank canvas the same way). */
async function canvasWithAgent(tenant: Tenant, agent: MarketAgentDetail, decision: MarketModelDecision, locale: 'zh' | 'en'): Promise<string> {
  const node = createMarketAgentNode(marketChoice(agent, decision), { x: 0, y: 0 }, locale);
  const canvas = await api<CanvasRecord>(tenantPath(tenant.id, '/canvases'), { method: 'POST', body: JSON.stringify({ name: agent.name, document: { ...emptyDocument(), nodes: [node] } }) });
  return canvas.id;
}

function HomeStrip({ tenant, onOpen }: StripProps) {
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
  const use = async (agent: MarketAgentDetail, decision: MarketModelDecision) => {
    const id = await canvasWithAgent(tenant, agent, decision, locale);
    setOpen(null);
    onOpen(id);
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

/** The workspace's capabilities, read once: the market's settings (null where it is off) with its official Agents'
 *  price, which the settings leave out. `failed` where they could not be read. */
type HomeMarket = { state: 'reading' } | { state: 'failed' } | { state: 'ready'; on: boolean; market: WorkspaceCapabilities['market'] };
function useHomeMarket(tenantId: string, revision: number): HomeMarket {
  const [read, setRead] = useState<{ key: string; value: HomeMarket } | null>(null);
  const key = `${tenantId}:${revision}`;
  useEffect(() => {
    const controller = new AbortController();
    readCapabilities(tenantId, controller.signal).then(
      value => { if (!controller.signal.aborted) setRead({ key, value: { state: 'ready', on: marketSettingsOf(value) !== null, market: value.market } }); },
      () => { if (!controller.signal.aborted) setRead({ key, value: { state: 'failed' } }); });
    return () => controller.abort();
  }, [tenantId, key]);
  return read?.key === key ? read.value : { state: 'reading' };
}

/** The home's Agent 市场 section: the section stays (and says so) where the market is off. */
function MarketSection({ tenant, onOpen }: StripProps) {
  const { locale, t } = useMarketI18n();
  const titleId = useId();
  const [revision, setRevision] = useState(0);
  const market = useHomeMarket(tenant.id, revision);
  const [open, setOpen] = useState<{ agentId?: string } | null>(null);
  const canCreate = tenant.role !== 'reader' && tenant.status === 'active';
  const notice = market.state === 'ready' && market.on ? officialPriceNotice(market.market, Date.now(), locale, t) : null;
  const use = async (agent: MarketAgentDetail, decision: MarketModelDecision) => {
    const id = await canvasWithAgent(tenant, agent, decision, locale);
    setOpen(null);
    onOpen(id);
  };
  return <section className="saas-home-section saas-market-strip saas-market-section" aria-labelledby={titleId}>
    <div className="saas-home-section-header">
      <div className="saas-home-section-title">
        <h2 id={titleId}>{t('Agent 市场', 'Agent market')}</h2>
        <p>{t('除了选模型，也可以挑一个运行表现好的 Agent 用在节点上：它带着作者写好的指令和技能，排行只看真实运行。', 'Besides a model, a node can use a well-performing Agent: it brings the instructions and skills its author wrote, ranked by real runs only.')}</p>
      </div>
      {market.state === 'ready' && market.on && <div className="saas-library-meta"><button type="button" className="saas-list-refresh" onClick={() => setOpen({})}>{t('查看全部', 'See all')}</button></div>}
    </div>
    {notice && <p className="saas-market-section-note" role="note">{notice}</p>}
    {market.state === 'reading' ? <p className="saas-market-status" role="status">{t('正在读取 Agent 市场…', 'Loading the Agent market…')}</p>
      : market.state === 'failed' ? <p className="saas-market-status" role="alert">{t('暂时读不到 Agent 市场。', 'The Agent market cannot be read right now.')} <button type="button" className="saas-link" onClick={() => setRevision(value => value + 1)}>{t('重试', 'Retry')}</button></p>
      : !market.on ? <p className="saas-market-status">{t('Agent 市场暂未开放。', 'The Agent market is not open yet.')}</p>
      : <SectionAgents onSelect={agentId => setOpen({ agentId })} />}
    {open && <AgentMarket tenantId={tenant.id} target={{ kind: 'home', canCreate }} initialAgentId={open.agentId}
      onUse={canCreate ? use : undefined} onClose={() => setOpen(null)} />}
  </section>;
}

/** The section's category chips (all of them first) and the best-ranked Agents of the one chosen. */
function SectionAgents({ onSelect }: { onSelect: (agentId: string) => void }) {
  const { t } = useMarketI18n();
  const listId = useId();
  const [category, setCategory] = useState<MarketCategory | null>(null);
  const [items, setItems] = useState<{ category: MarketCategory | null; agents: MarketAgentSummary[] } | null>(null);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError(false);
    browseMarketAgents({ sort: 'score', limit: SECTION_MARKET_AGENTS, category: category ?? undefined }, controller.signal)
      .then(page => { if (!controller.signal.aborted) setItems({ category, agents: page.items.slice(0, SECTION_MARKET_AGENTS) }); },
        () => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [category, revision]);
  const agents = items?.category === category ? items.agents : null;
  return <>
    <div className="saas-case-chips saas-market-section-chips" role="group" aria-label={t('Agent 类别', 'Agent categories')}>
      <button type="button" aria-pressed={category === null} aria-controls={listId} onClick={() => setCategory(null)}>{t('全部', 'All')}</button>
      {MARKET_CATEGORIES.map(value => <button key={value} type="button" aria-pressed={category === value} aria-controls={listId} onClick={() => setCategory(value)}>{categoryName(value, t)}</button>)}
    </div>
    <div id={listId}>
      {error ? <p className="saas-market-status" role="alert">{t('暂时读不到 Agent 市场。', 'The Agent market cannot be read right now.')} <button type="button" className="saas-link" onClick={() => setRevision(value => value + 1)}>{t('重试', 'Retry')}</button></p>
        : !agents ? <p className="saas-market-status" role="status">{t('正在读取 Agent 市场…', 'Loading the Agent market…')}</p>
        : !agents.length ? <p className="saas-market-status">{category ? t('这个类别还没有上架的 Agent。', 'No Agents are listed in this category yet.') : t('市场里还没有上架的 Agent。', 'No Agents are listed yet.')}</p>
        : <ul className="awwo-market-cards">{agents.map(agent => <li key={agent.id}><MarketAgentCard agent={agent} onSelect={() => onSelect(agent.id)} /></li>)}</ul>}
    </div>
  </>;
}
