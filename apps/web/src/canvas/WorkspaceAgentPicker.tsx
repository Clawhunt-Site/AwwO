import { useEffect, useRef, useState } from 'react';
import { Plus, RefreshCw, Search } from 'lucide-react';
import { useCanvasI18n } from './i18n';
import { SaaSApiError, saasErrorMessage } from '../saas/api';
import type { WorkspaceAgent, WorkspaceAgentLoader } from './workspaceAgents';

export function WorkspaceAgentPicker({ loadPage, onSelect, disabled, compact = false }: {
  loadPage: WorkspaceAgentLoader; onSelect: (agent: WorkspaceAgent) => void; disabled: boolean; compact?: boolean;
}) {
  const { locale } = useCanvasI18n();
  const text = (zh: string, en: string) => locale === 'zh' ? zh : en;
  const [items, setItems] = useState<WorkspaceAgent[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const request = useRef<AbortController | null>(null);
  const seenCursors = useRef(new Set<string>());
  const load = async (next: string | null) => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setError(null);
    try {
      const page = await loadPage(next, controller.signal);
      if (controller.signal.aborted) return;
      if (page.nextCursor && (page.nextCursor === next || seenCursors.current.has(page.nextCursor))) {
        throw new Error(text('目录分页已变化，请刷新重试。', 'The catalogue pagination changed. Refresh and retry.'));
      }
      if (next) seenCursors.current.add(next);
      setItems(previous => Array.from(new Map([...(next ? previous : []), ...page.items].map(agent => [agent.id, agent])).values()));
      setCursor(page.nextCursor ?? null);
    } catch (cause) {
      if (!controller.signal.aborted) {
        if (cause instanceof SaaSApiError && ([401, 403].includes(cause.status) || cause.code === 'invalid_cursor')) {
          setItems([]); setSelected(null); setCursor(null); seenCursors.current.clear();
        }
        setError(cause);
      }
    }
    finally { if (!controller.signal.aborted) setBusy(false); }
  };
  useEffect(() => {
    setItems([]); setSelected(null); setCursor(null); seenCursors.current.clear();
    void load(null);
    return () => request.current?.abort();
  }, [loadPage, revision]);
  const normalized = query.trim().toLocaleLowerCase();
  const visible = items.filter(agent => `${agent.name}\n${agent.instructions}\n${agent.model}`.toLocaleLowerCase().includes(normalized));
  const agent = visible.find(item => item.id === selected);
  const canUse = (item: WorkspaceAgent) => item.status === 'active' && ['pi', 'openai-agents'].includes(item.runtime);
  return <div className={`awwo-workspace-agent-picker${compact ? ' is-compact' : ''}`}>
    {!compact && <p>{text('选择工作区中已有的 Agent。每个画布节点保留独立会话，并沿用该 Agent 的配置。', 'Choose an existing workspace Agent. Each canvas node keeps an independent conversation using that Agent’s configuration.')}</p>}
    <div className="awwo-catalog-tools"><label className="awwo-search"><Search size={15} /><input type="search" aria-label={text('搜索已加载的 Agent', 'Search loaded Agents')} placeholder={text('搜索已加载的 Agent…', 'Search loaded Agents…')} value={query} onChange={event => { setQuery(event.target.value); setSelected(null); }} /></label><button type="button" disabled={busy} onClick={() => setRevision(value => value + 1)}><RefreshCw size={14} />{text('刷新', 'Refresh')}</button></div>
    {error !== null && <div role="alert" className="awwo-catalog-error"><p>{saasErrorMessage(error, locale)}</p><button type="button" disabled={busy} onClick={() => void load(cursor)}>{text('重试', 'Retry')}</button></div>}
    <div className="awwo-catalog-list" aria-label={text('工作区 Agent 目录', 'Workspace Agent catalogue')}>
      {visible.map(item => <button type="button" key={item.id} aria-pressed={selected === item.id} aria-label={text(`选择 ${item.name}`, `Select ${item.name}`)} onClick={() => setSelected(item.id)}><strong>{item.name}</strong><span className="awwo-catalog-id">ID · {item.id.slice(-8)}</span><span>{item.model || text('未配置模型', 'No model configured')} · {item.runtime}</span><small>{item.instructions || text('未设置角色说明', 'No role instructions')}</small>{!canUse(item) && <em>{text('当前不可运行', 'Currently unavailable')}</em>}</button>)}
    </div>
    {busy && <p role="status">{text('正在读取 Agent 目录…', 'Loading Agent catalogue…')}</p>}
    {!busy && !error && !visible.length && <p role="status">{items.length ? text('已加载的 Agent 中没有匹配项。', 'No matches among the loaded Agents.') : text('此工作区尚无 Agent。可以先从角色模板创建。', 'This workspace has no Agents yet. Start with a role template.')}</p>}
    {cursor && <button className="awwo-catalog-more" type="button" disabled={busy} onClick={() => void load(cursor)}>{text('加载更多 Agent', 'Load more Agents')}</button>}
    <footer className="awwo-template-library-footer"><span>{text(`已加载 ${items.length} 个 Agent${cursor ? '，还有更多' : ''}`, `${items.length} Agents loaded${cursor ? ', more available' : ''}`)}{agent && <span className="awwo-catalog-selection">{text('已选择：', 'Selected: ')}{agent.name}</span>}</span><button className="awwo-primary" type="button" disabled={disabled || busy || !agent || !canUse(agent)} onClick={() => { if (!disabled && !busy && agent && canUse(agent)) onSelect(agent); }}><Plus size={16} />{text('添加所选 Agent', 'Add selected Agent')}</button></footer>
  </div>;
}
