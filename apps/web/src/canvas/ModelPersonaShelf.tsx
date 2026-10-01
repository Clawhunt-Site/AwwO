import { useEffect, useId, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { Asterisk, Boxes, Code2, Search, Sparkles, Slash, X } from 'lucide-react';
import { getAgentTemplates, type AgentTemplateId } from './agentTemplates';
import { useCanvasI18n } from './i18n';
import type { ModelPaletteGroup, ModelPaletteSelection } from './modelPalette';
import './model-persona-shelf.css';

const providerGlyphs = { codex: Code2, claude: Asterisk, grok: Slash, gemini: Sparkles, clawhunt: Boxes };

export interface ModelPersonaShelfProps {
  groups: readonly ModelPaletteGroup[];
  loading: boolean;
  error?: string;
  disabled?: boolean;
  personaId: AgentTemplateId | null;
  onPersonaChange: (id: AgentTemplateId | null) => void;
  onAddModel: (model: ModelPaletteSelection, personaId: AgentTemplateId | null) => void;
  /** The host owns the canvas drop protocol and writes the drag payload. */
  onModelDragStart?: (event: DragEvent<HTMLButtonElement>, model: ModelPaletteSelection, personaId: AgentTemplateId | null) => void;
  onOpenWorkspaceAgents: () => void;
  onRetry?: () => void;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  orchestrationControls?: ReactNode;
  modelsOnly?: boolean;
  configureModelsHref?: string;
  operatorManaged?: boolean;
}

/** Persona selection lives with Bots; the selected value is shared with the model shelf. */
export function ModelPersonaControls({ personaId, onPersonaChange, disabled = false }: Pick<ModelPersonaShelfProps, 'personaId' | 'onPersonaChange' | 'disabled'>) {
  const { locale } = useCanvasI18n();
  const en = locale === 'en';
  const id = useId();
  return <fieldset className="model-persona-shelf-personas" disabled={disabled}>
    <legend>{en ? 'Persona' : '人设'}</legend>
    <p className="model-persona-shelf-hint">{en ? 'Applied to the next model you add from the left.' : '应用到接下来从左侧添加的模型。'}</p>
    <div className="model-persona-shelf-persona-grid">
      <label className={`model-persona-shelf-persona${personaId === null ? ' is-selected' : ''}`}>
        <input type="radio" name={`${id}-persona`} value="" checked={personaId === null}
          onChange={() => { if (!disabled) onPersonaChange(null); }} />
        <span>{en ? 'No preset' : '无预设'}</span>
      </label>
      {getAgentTemplates(locale).map(template => <label key={template.id} className={`model-persona-shelf-persona${personaId === template.id ? ' is-selected' : ''}`} title={template.subtitle}>
        <input type="radio" name={`${id}-persona`} value={template.id} checked={personaId === template.id}
          onChange={() => { if (!disabled) onPersonaChange(template.id); }} />
        <span>{template.title}</span>
      </label>)}
    </div>
  </fieldset>;
}

/** Catalog presentation only. The host revalidates availability before creating a node. */
export function ModelPersonaShelf({ groups, loading, error, disabled = false, personaId, onPersonaChange,
  onAddModel, onModelDragStart, onOpenWorkspaceAgents, onRetry, collapsed, onCollapsedChange,
  orchestrationControls, modelsOnly = false, configureModelsHref, operatorManaged = false }: ModelPersonaShelfProps) {
  const { locale } = useCanvasI18n();
  const en = locale === 'en';
  const id = useId();
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [showAllBrands, setShowAllBrands] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(() => new Set());
  const searchInput = useRef<HTMLInputElement>(null);
  const blocked = disabled || loading || Boolean(error);
  const search = query.trim().toLocaleLowerCase();
  useEffect(() => { if (searchOpen) searchInput.current?.focus(); }, [searchOpen]);
  const configuredGroups = groups.filter(group => group.models.length > 0);
  const listedGroups = showAllBrands || !configuredGroups.length ? groups : configuredGroups;
  const visibleGroups = search ? groups.flatMap(group => {
    const groupMatch = group.label.toLocaleLowerCase().includes(search);
    const models = groupMatch ? group.models : group.models.filter(model =>
      [model.label, model.model, model.runtime, model.effort].some(value => value?.toLocaleLowerCase().includes(search)));
    return groupMatch || models.length ? [{ ...group, models }] : [];
  }) : listedGroups;
  const modelCount = visibleGroups.reduce((count, group) => count + group.models.length, 0);
  // The host owns the collapsed state for both shelf flavours: a models-only rail collapses to
  // its 70px sidebar strip exactly like the full shelf does.
  const isCollapsed = collapsed;
  const title = modelsOnly ? (en ? 'Models' : '模型') : (en ? 'Models & personas' : '模型与人设');
  const unavailable = en ? 'Unavailable' : '不可用';
  return <aside className={`model-persona-shelf${isCollapsed ? ' is-collapsed' : ''}`} aria-label={modelsOnly ? (en ? 'Execution and orchestration models' : '执行与编排模型') : title}
    onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
    <header className="model-persona-shelf-head">
      {!isCollapsed && <h2>{title}</h2>}
      <button type="button" className="model-persona-shelf-toggle" aria-expanded={!collapsed} aria-controls={`${id}-body`}
        aria-label={modelsOnly ? (collapsed ? (en ? 'Expand models' : '展开模型') : (en ? 'Collapse models' : '收起模型')) : collapsed ? (en ? 'Expand models and personas' : '展开模型与人设') : (en ? 'Collapse models and personas' : '收起模型与人设')}
        onClick={() => onCollapsedChange(!collapsed)}>
        <span aria-hidden="true">{collapsed ? '‹' : '›'}</span>
      </button>
    </header>
    <div id={`${id}-body`} className="model-persona-shelf-body" hidden={isCollapsed}>
      {orchestrationControls && <div className="model-persona-shelf-orchestration">{orchestrationControls}</div>}
      <section className="model-persona-shelf-models" aria-labelledby={`${id}-models`}>
        <div className="model-persona-shelf-section-head">
          <h3 id={`${id}-models`}>{en ? 'Execution models' : '执行模型'}</h3>
          {groups.some(group => group.models.length) && <button type="button" className="model-persona-shelf-search-toggle"
            aria-label={en ? 'Search models' : '搜索模型'} aria-expanded={searchOpen}
            onClick={() => { if (searchOpen) setQuery(''); setSearchOpen(!searchOpen); }}><Search size={15} aria-hidden="true" /></button>}
        </div>
        {searchOpen && <div className="model-persona-shelf-search">
          <Search size={15} aria-hidden="true" />
          <input ref={searchInput} type="search" value={query} aria-label={en ? 'Find a model' : '查找模型'}
            placeholder={en ? 'Search models or connections' : '搜索模型或连接'} onChange={event => setQuery(event.target.value)}
            onKeyDown={event => { if (event.key === 'Escape' && query) { event.preventDefault(); event.stopPropagation(); setQuery(''); } }} />
          {query && <button type="button" aria-label={en ? 'Clear model search' : '清除模型搜索'} onClick={() => { setQuery(''); searchInput.current?.focus(); }}><X size={14} aria-hidden="true" /></button>}
        </div>}
        {search && !loading && !error && <p className="model-persona-shelf-search-count" role="status">{en ? `${modelCount} matching ${modelCount === 1 ? 'model' : 'models'}` : `找到 ${modelCount} 个模型`}</p>}
        {loading && <p className="model-persona-shelf-status" role="status">{en ? 'Loading model catalog…' : '正在读取模型目录…'}</p>}
        {error && <div className="model-persona-shelf-error" role="alert"><p>{error}</p>
          {onRetry && <button type="button" disabled={loading} onClick={onRetry}>{en ? 'Retry' : '重试'}</button>}
        </div>}
        {visibleGroups.map(group => <section key={group.id} className="model-persona-shelf-group" aria-labelledby={`${id}-${group.id}`}>
          <div className="model-persona-shelf-group-head">
            <h4 id={`${id}-${group.id}`}><span className={`model-persona-shelf-provider is-${group.id}`} aria-hidden="true">{(() => { const Icon = providerGlyphs[group.id]; return <Icon size={15} />; })()}</span>{group.label}</h4>
            {!group.available && <span className="model-persona-shelf-badge" title={group.reason}>
              {loading ? (en ? 'Loading' : '读取中') : error ? (en ? 'Not loaded' : '未读取') : group.models.length ? (en ? 'Not ready' : '未就绪') : (en ? 'Not configured' : '未配置')}
            </span>}
          </div>
          {(search || expandedGroups.has(group.id) ? group.models : group.models.slice(0, 3)).map(model => {
            const canAdd = !blocked && group.available && model.available;
            const reason = model.reason || (!group.available ? group.reason : undefined) || unavailable;
            const runtimeLabel = model.runtime === 'pi' ? 'Pi' : model.runtime === 'openai-agents' ? 'Agents' : model.runtime;
            const [modelName, ...connection] = model.label.split(' · ');
            const sameNameModels = group.models.filter(item => item.label.split(' · ')[0] === modelName);
            const showRuntime = sameNameModels.some(item => item.runtime !== model.runtime);
            return <button key={model.key} type="button" className="model-persona-shelf-model" disabled={!canAdd}
              draggable={canAdd && Boolean(onModelDragStart)}
              aria-label={`${en ? 'Add' : '添加'} ${model.label} · ${runtimeLabel}${model.effort ? ` · ${model.effort}` : ''}`}
              title={`${model.label} · ${runtimeLabel}${model.effort ? ` · ${model.effort}` : ''}`}
              onClick={() => { if (canAdd) onAddModel(model, personaId); }}
              onDragStart={event => {
                if (!canAdd || !onModelDragStart) { event.preventDefault(); return; }
                onModelDragStart(event, model, personaId);
              }}>
              <span className="model-persona-shelf-model-title">{modelName}</span>
              {sameNameModels.length > 1 && (connection.length > 0 || showRuntime)
                && <span className="model-persona-shelf-model-connection">{[...connection, ...(showRuntime ? [runtimeLabel] : [])].join(' · ')}</span>}
              {(!group.available || !model.available) && <span className="model-persona-shelf-model-meta">{reason}</span>}
              <span className="model-persona-shelf-model-add" aria-hidden="true">+</span>
            </button>;
          })}
          {!search && group.models.length > 3 && <button type="button" className="model-persona-shelf-group-more"
            aria-expanded={expandedGroups.has(group.id)}
            onClick={() => setExpandedGroups(current => {
              const next = new Set(current);
              if (next.has(group.id)) next.delete(group.id); else next.add(group.id);
              return next;
            })}>{expandedGroups.has(group.id)
              ? (en ? 'Show fewer' : '收起')
              : (en ? `Show all ${group.models.length} models` : `查看全部 ${group.models.length} 个模型`)}</button>}
        </section>)}
        {!search && configuredGroups.length > 0 && configuredGroups.length < groups.length &&
          <button type="button" className="model-persona-shelf-all-brands" aria-expanded={showAllBrands}
            onClick={() => setShowAllBrands(!showAllBrands)}>{showAllBrands
              ? (en ? 'Show configured only' : '只看已配置')
              : (en ? `Show all ${groups.length} brands` : `查看全部 ${groups.length} 个品牌`)}</button>}
        {search && !visibleGroups.length && !loading && !error && <p className="model-persona-shelf-status">{en ? 'No matching model. Try a provider, model, or connection name.' : '没有匹配的模型。试试品牌、模型名或连接名称。'}</p>}
        {!loading && !error && groups.length === 0 && <p className="model-persona-shelf-status" role="status">
          {en ? 'No model catalog is available.' : '暂无模型目录。'}
        </p>}
      </section>
      {configureModelsHref && <div className="model-persona-shelf-setup">
        {!loading && !error && !groups.some(group => group.available && group.models.some(model => model.available)) && <p>{en ? 'No models are available. Check your connections or ask the workspace admin.' : '当前没有可用模型。请检查个人连接或联系工作区管理员。'}</p>}
        <a href={configureModelsHref}>{en ? 'Manage my model connections' : '配置我的模型连接'} ↗</a>
      </div>}
      {operatorManaged && !loading && !error && !groups.some(group => group.available && group.models.some(model => model.available)) && <div className="model-persona-shelf-setup">
        <p>{en ? 'No models are available. Ask your workspace admin to check model access and service status.' : '当前没有可用模型。请联系工作区管理员检查模型权限和服务状态。'}</p>
        {onRetry && <button type="button" onClick={onRetry}>{en ? 'Check again' : '重新检查'}</button>}
      </div>}
      {!modelsOnly && <ModelPersonaControls personaId={personaId} onPersonaChange={onPersonaChange} disabled={disabled} />}
      {!modelsOnly && <button type="button" className="model-persona-shelf-workspace" disabled={disabled}
        onClick={() => { if (!disabled) onOpenWorkspaceAgents(); }}>
        {en ? 'Existing workspace Agents' : '已有工作区 Agent'}<span aria-hidden="true">↗</span>
      </button>}
    </div>
  </aside>;
}
