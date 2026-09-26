import { useId, type DragEvent, type ReactNode } from 'react';
import { getAgentTemplates, type AgentTemplateId } from './agentTemplates';
import { useCanvasI18n } from './i18n';
import type { ModelPaletteGroup, ModelPaletteSelection } from './modelPalette';
import './model-persona-shelf.css';

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
  const blocked = disabled || loading || Boolean(error);
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
        <h3 id={`${id}-models`}>{en ? 'Execution models' : '执行模型'}</h3>
        <p className="model-persona-shelf-hint">{en ? 'Click to add, or drag onto the canvas.' : '点击添加，或拖到画布。'}</p>
        {loading && <p className="model-persona-shelf-status" role="status">{en ? 'Loading model catalog…' : '正在读取模型目录…'}</p>}
        {error && <div className="model-persona-shelf-error" role="alert"><p>{error}</p>
          {onRetry && <button type="button" disabled={loading} onClick={onRetry}>{en ? 'Retry' : '重试'}</button>}
        </div>}
        {groups.map(group => <section key={group.id} className="model-persona-shelf-group" aria-labelledby={`${id}-${group.id}`}>
          <div className="model-persona-shelf-group-head">
            <h4 id={`${id}-${group.id}`}>{group.label}</h4>
            {!group.available && <span className="model-persona-shelf-badge" title={group.reason}>
              {loading ? (en ? 'Loading' : '读取中') : error ? (en ? 'Not loaded' : '未读取') : group.models.length ? (en ? 'Not ready' : '未就绪') : (en ? 'Not configured' : '未配置')}
            </span>}
          </div>
          {group.models.map(model => {
            const canAdd = !blocked && group.available && model.available;
            const reason = model.reason || (!group.available ? group.reason : undefined) || unavailable;
            const runtimeLabel = model.runtime === 'pi' ? 'Pi' : model.runtime === 'openai-agents' ? 'Agents' : model.runtime;
            return <button key={model.key} type="button" className="model-persona-shelf-model" disabled={!canAdd}
              draggable={canAdd && Boolean(onModelDragStart)}
              aria-label={`${en ? 'Add' : '添加'} ${model.label} · ${runtimeLabel}`}
              onClick={() => { if (canAdd) onAddModel(model, personaId); }}
              onDragStart={event => {
                if (!canAdd || !onModelDragStart) { event.preventDefault(); return; }
                onModelDragStart(event, model, personaId);
              }}>
              <span className="model-persona-shelf-model-title">{model.label}</span>
              <span className="model-persona-shelf-model-meta"><span>{runtimeLabel}</span>
                {model.effort && <span>{model.effort}</span>}
                {(!group.available || !model.available) && <span>{reason}</span>}
              </span>
              <span className="model-persona-shelf-model-add" aria-hidden="true">+</span>
            </button>;
          })}
        </section>)}
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
