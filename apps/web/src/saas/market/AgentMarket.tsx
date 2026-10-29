// The Agent market (docs/awwo-agent-market.md): Agents authors published and the platform reviewed, ranked by how their
// real runs went, to put on a canvas node instead of writing its instructions by hand. The dialog lists them by
// category, search and order; an Agent's page says what it brings and costs, and offers the one thing it was opened for:
// using the Agent on a node, adding a node with it to the canvas, or starting a canvas with it from the home page.
import { useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, Search, Store, X } from 'lucide-react';
import { saasErrorMessage } from '../api';
import { WorkbenchOverlay } from '../CanvasKnowledgeDock';
import type { ModelPaletteSelection } from '../../canvas/modelPalette';
import { browseMarketAgents, MARKET_CATEGORIES, MARKET_SORTS, readMarketAgent, type MarketAgentDetail, type MarketAgentSummary,
  type MarketCategory, type MarketSort } from '../marketApi';
import { MarketAgentCard } from './MarketAgentCard';
import { MarketAgentDetailView, type MarketTarget } from './MarketAgentDetail';
import { marketModelDecision, type MarketModelDecision } from './marketModel';
import { categoryName, sortName, useMarketI18n } from './marketText';
import { rememberMarketAgent, useWorkspaceModels, useWorkspacePaidPlan } from './useMarket';
import '../canvas-library.css';
import './market.css';

export type { MarketTarget } from './MarketAgentDetail';

/** Agents a page of the list reads. */
const PAGE_SIZE = 24;

export interface AgentMarketProps {
  /** The workspace the Agent will be used in: its plan and its models decide what choosing one does. */
  tenantId: string;
  target: MarketTarget;
  /** The workspace's chat models as the canvas holds them; absent, the dialog reads them itself. */
  catalogue?: ReadonlyArray<ModelPaletteSelection>;
  /** Opens on this Agent's page (a card of the home page). */
  initialAgentId?: string;
  /** Uses the Agent; the host closes the dialog once it has. A rejection is shown on the Agent's page. */
  onUse?: (agent: MarketAgentDetail, decision: MarketModelDecision) => void | Promise<void>;
  /** Takes the Agent off the node (a node target with one). */
  onDetach?: () => void;
  onClose: () => void;
}

export function AgentMarket(props: AgentMarketProps) {
  const { t } = useMarketI18n();
  return <WorkbenchOverlay label={t('Agent 市场', 'Agent market')} onClose={props.onClose}><MarketBrowser {...props} /></WorkbenchOverlay>;
}

function MarketBrowser({ tenantId, target, catalogue, initialAgentId, onUse, onDetach, onClose }: AgentMarketProps) {
  const { locale, t } = useMarketI18n();
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<MarketCategory | ''>('');
  const [sort, setSort] = useState<MarketSort>('score');
  const [items, setItems] = useState<MarketAgentSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [revision, setRevision] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(initialAgentId ?? (target.kind === 'node' ? target.current?.agentId ?? null : null));
  const [detail, setDetail] = useState<{ id: string; value: MarketAgentDetail | null; error: unknown } | null>(null);
  const [busy, setBusy] = useState(false);
  const [useError, setUseError] = useState<unknown>(null);
  const request = useRef<AbortController | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; request.current?.abort(); }; }, []);
  // A search waits for a pause in typing, so the list does not ask on every keystroke.
  useEffect(() => { const timer = setTimeout(() => setQuery(search.trim()), 300); return () => clearTimeout(timer); }, [search]);

  const load = async (next: string | null) => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setLoading(true); setError(null);
    try {
      const page = await browseMarketAgents({ q: query, category, sort, limit: PAGE_SIZE, cursor: next }, controller.signal);
      if (controller.signal.aborted) return;
      setItems(previous => next ? [...previous, ...page.items.filter(item => !previous.some(seen => seen.id === item.id))] : page.items);
      setCursor(page.nextCursor);
      if (!next) setSelectedId(current => current ?? page.items[0]?.id ?? null);
    } catch (cause) { if (!controller.signal.aborted) setError(cause); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  };
  useEffect(() => { void load(null); }, [query, category, sort, revision]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!selectedId) return;
    const controller = new AbortController();
    setUseError(null);
    readMarketAgent(selectedId, { signal: controller.signal }).then(value => {
      if (controller.signal.aborted) return;
      rememberMarketAgent(value);
      setDetail({ id: selectedId, value, error: null });
    }, cause => { if (!controller.signal.aborted) setDetail({ id: selectedId, value: null, error: cause }); });
    return () => controller.abort();
  }, [selectedId]);

  const models = useWorkspaceModels(tenantId, catalogue);
  const shown = detail?.id === selectedId ? detail : null;
  const selected = shown?.value ?? null;
  const decision = useMemo(() => selected && (models.models || models.failed) ? marketModelDecision(selected.model, models.models) : null, [selected, models.models, models.failed]);
  // A paid Agent needs the workspace owner's plan; its author (who sees its status) is never charged for their own.
  const paid = Boolean(selected && selected.price > 0 && !selected.status && !selected.latest);
  const plan = useWorkspacePaidPlan(tenantId, paid);
  const ranked = items.filter(item => item.stats.ranked);
  const fresh = items.filter(item => !item.stats.ranked);
  const use = async () => {
    if (!selected || !onUse || busy || !decision || decision.kind === 'blocked') return;
    setBusy(true); setUseError(null);
    try { await onUse(selected, decision); }
    catch (cause) { if (alive.current) setUseError(cause); }
    finally { if (alive.current) setBusy(false); }
  };
  const subtitle = target.kind === 'node' ? t(`为「${target.title}」选一个 Agent：它带着自己的指令和技能，节点的任务要求、资料和对话照常是你的。`,
    `Choose an Agent for “${target.title}”: it brings its own instructions and skills, while the node’s task requirements, knowledge and conversation stay yours.`)
    : t('挑一个运行表现好的 Agent 用在画布上。排行只看真实运行：成功率越高、用的人越多越靠前。', 'Pick a well-performing Agent for your canvas. The ranking counts real runs only: a higher success rate and more people put an Agent higher.');
  const cards = (list: MarketAgentSummary[]) => <ul className="awwo-market-cards">{list.map(agent => <li key={agent.id}>
    <MarketAgentCard agent={agent} selected={agent.id === selectedId} onSelect={next => setSelectedId(next.id)} /></li>)}</ul>;

  return <section className="awwo-library awwo-market" aria-label={t('Agent 市场', 'Agent market')}>
    <header className="awwo-library-header">
      <div className="awwo-library-heading"><span className="awwo-library-mark"><Store size={20} aria-hidden="true" /></span><div>
        <h2>{t('Agent 市场', 'Agent market')}</h2><p>{subtitle}</p>
      </div></div>
      <div className="awwo-library-actions">
        <button type="button" disabled={loading} onClick={() => setRevision(value => value + 1)} aria-label={t('刷新 Agent 市场', 'Refresh the Agent market')}><RefreshCw size={16} aria-hidden="true" /></button>
        <button type="button" disabled={busy} onClick={onClose} aria-label={t('关闭 Agent 市场', 'Close the Agent market')}><X size={19} aria-hidden="true" /></button>
      </div>
    </header>
    <div className="awwo-library-body has-editor">
      <div className="awwo-library-list-column">
        <div className="awwo-library-filters">
          <label className="awwo-library-search"><Search size={15} aria-hidden="true" /><input type="search" value={search} onChange={event => setSearch(event.target.value)}
            placeholder={t('搜索 Agent', 'Search Agents')} aria-label={t('搜索 Agent', 'Search Agents')} /></label>
          <label className="awwo-market-sort">{t('排序', 'Sort')}<select value={sort} onChange={event => setSort(event.target.value as MarketSort)}>
            {MARKET_SORTS.map(value => <option key={value} value={value}>{sortName(value, t)}</option>)}</select></label>
        </div>
        <div className="awwo-market-chips" role="group" aria-label={t('类别', 'Category')}>
          <button type="button" aria-pressed={category === ''} onClick={() => setCategory('')}>{t('全部', 'All')}</button>
          {MARKET_CATEGORIES.map(value => <button key={value} type="button" aria-pressed={category === value} onClick={() => setCategory(value)}>{categoryName(value, t)}</button>)}
        </div>
        {error !== null && <p className="awwo-library-alert" role="alert">{saasErrorMessage(error, locale)} <button type="button" onClick={() => void load(items.length ? cursor : null)}>{t('重试', 'Retry')}</button></p>}
        {loading && !items.length ? <p className="awwo-library-empty" role="status">{t('正在读取 Agent 市场…', 'Loading the Agent market…')}</p>
          : !items.length && error === null ? <p className="awwo-library-empty">{query || category ? t('没有符合的 Agent。', 'No matching Agents.') : t('市场里还没有上架的 Agent。', 'No Agents are listed yet.')}</p>
          : <>
            {ranked.length > 0 && cards(ranked)}
            {fresh.length > 0 && <div className="awwo-library-group"><h3>{t('新上架', 'New')}</h3>{cards(fresh)}</div>}
            {cursor && <button type="button" className="awwo-market-more" disabled={loading} onClick={() => void load(cursor)}>{loading ? t('正在读取…', 'Loading…') : t('加载更多 Agent', 'Load more Agents')}</button>}
          </>}
      </div>
      {selected ? <MarketAgentDetailView key={selected.id} detail={selected} tenantId={tenantId} target={target} decision={decision}
        planNeeded={paid && plan === false} busy={busy} error={useError} onUse={onUse ? () => void use() : undefined}
        onDetach={target.kind === 'node' && target.current && onDetach ? onDetach : undefined} />
        : <div className="awwo-library-detail awwo-market-detail">
          {shown?.error ? <p className="awwo-library-alert" role="alert">{saasErrorMessage(shown.error, locale)}</p>
            : shown ? <p className="awwo-library-empty">{t('这个 Agent 已不在市场上。', 'This Agent is no longer in the market.')}</p>
            : <p className="awwo-library-empty" role="status">{selectedId ? t('正在读取 Agent…', 'Loading the Agent…') : t('选择左侧的 Agent 查看详情。', 'Choose an Agent to see its details.')}</p>}
          {target.kind === 'node' && target.current && onDetach && <div className="awwo-library-editor-actions"><button type="button" onClick={onDetach}>{t('不用 Agent', 'No Agent')}</button></div>}
        </div>}
    </div>
  </section>;
}
