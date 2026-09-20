import { useEffect, useRef, useState, type ReactNode, type DragEventHandler } from 'react';
import { ArrowRight, Bot, ChevronRight, Code2, Cpu, Database, FolderOpen, GitBranch, Layers3, Menu, MessageSquare, Plus, Search, Settings2, TerminalSquare, X } from 'lucide-react';
import type { CanvasEdge, CanvasNode } from './canvasDoc';
import type { RunNodeStatus } from './runGraph';
import { AGENT_TEMPLATE_VERSION, getAgentTemplateForNode, getAgentTemplates, type AgentTemplateId } from './agentTemplates';
import { AgentGlyph, AgentTemplateDetails } from './AgentTemplateDetails';
import { useCanvasI18n } from './i18n';
export { AgentGlyph } from './AgentTemplateDetails';
import './awwo-workspace.css';
import { TeamMarketAgentPicker } from './TeamMarketAgentPicker';
import type { TeamMarketAgent } from './teamMarketAgents';
import { WorkspaceAgentPicker } from './WorkspaceAgentPicker';
import type { WorkspaceAgent, WorkspaceAgentLoader } from './workspaceAgents';

export interface AgentWorkspaceProps {
  workspaceName?: string;
  workspaceCaption?: string;
  storageMode?: 'local' | 'cloud';
  nodes: ReadonlyArray<CanvasNode>;
  edges: ReadonlyArray<CanvasEdge>;
  selectedIds: ReadonlyArray<string>;
  runs: Readonly<Record<string, RunNodeStatus>>;
  running: boolean;
  readOnly?: boolean;
  onFocusNode: (id: string) => void;
  onAddAgent: (id: AgentTemplateId) => void;
  loadWorkspaceAgents?: WorkspaceAgentLoader;
  agentLibraryRequest?: number;
  onAddWorkspaceAgent?: (agent: WorkspaceAgent) => void;
  onAddMarketAgent?: (agent: TeamMarketAgent) => void;
  onCreateTemplate: () => void;
  onSearch: () => void;
  onOpenSettings?: () => void;
  toolbar?: ReactNode;
  accountControl?: ReactNode;
  assistant?: ReactNode;
  modelShelf?: ReactNode;
  personaControls?: ReactNode;
  onModelDragOver?: DragEventHandler<HTMLDivElement>;
  onModelDrop?: DragEventHandler<HTMLDivElement>;
  welcome?: ReactNode;
  assistantOpen?: boolean;
  onToggleAssistant?: () => void;
  children: ReactNode;
}

export function AgentWorkspace({ workspaceName, workspaceCaption, storageMode = 'local', nodes, edges, selectedIds, runs, running, readOnly = false, onFocusNode, onAddAgent, loadWorkspaceAgents, agentLibraryRequest, onAddWorkspaceAgent, onAddMarketAgent, onCreateTemplate, onSearch, onOpenSettings, toolbar, accountControl, assistant, modelShelf, personaControls, onModelDragOver, onModelDrop, welcome, assistantOpen, onToggleAssistant, children }: AgentWorkspaceProps) {
  const { locale, t } = useCanvasI18n();
  const [query, setQuery] = useState('');
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [librarySource, setLibrarySource] = useState<'workspace' | 'market' | 'templates'>(loadWorkspaceAgents ? 'workspace' : 'templates');
  const [selectedTemplate, setSelectedTemplate] = useState<AgentTemplateId>('frontend');
  const templates = getAgentTemplates(locale);
  const template = templates.find(item => item.id === selectedTemplate)!;
  useEffect(() => { if (agentLibraryRequest) { setLibrarySource('workspace'); setLibraryOpen(true); setSidebarOpen(false); setModelLibraryOpen(false); } }, [agentLibraryRequest]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [modelLibraryOpen, setModelLibraryOpen] = useState(false);
  const [mobile, setMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth <= 900);
  const [navExpanded, setNavExpanded] = useState(false);
  const [botSource, setBotSource] = useState<'canvas' | 'workspace' | 'market'>('canvas');
  useEffect(() => { setModelLibraryOpen(false); }, [nodes.length]);
  const libraryRef = useRef<HTMLElement>(null);
  const modelSidebarRef = useRef<HTMLElement>(null);
  const botSidebarRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const resize = () => {
      const next = window.innerWidth <= 900; setMobile(next);
      if (!next) { setModelLibraryOpen(false); setSidebarOpen(false); }
    };
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  useEffect(() => {
    if (!mobile || (!modelLibraryOpen && !sidebarOpen)) return;
    const panel = modelLibraryOpen ? modelSidebarRef.current : botSidebarRef.current;
    const previous = document.activeElement as HTMLElement | null;
    const controls = () => Array.from(panel?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), summary, a[href]') ?? [])
      .filter(element => element.getClientRects().length > 0 && !element.closest('[hidden]'));
    controls()[0]?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const items = controls(); const first = items[0]; const last = items.at(-1);
      if (!first || !last) return;
      if (!panel?.contains(document.activeElement) || (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
        event.preventDefault(); (event.shiftKey ? last : first).focus();
      }
    };
    document.addEventListener('keydown', trap);
    return () => { document.removeEventListener('keydown', trap); if (previous?.isConnected) previous.focus(); };
  }, [mobile, modelLibraryOpen, sidebarOpen]);
  useEffect(() => {
    if (!sidebarOpen && !modelLibraryOpen) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') { setSidebarOpen(false); setModelLibraryOpen(false); } };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [sidebarOpen, modelLibraryOpen]);
  useEffect(() => {
    if (!libraryOpen) return;
    const previous = document.activeElement as HTMLElement | null;
    const panel = libraryRef.current;
    const controls = () => Array.from(panel?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), summary, [tabindex="0"]') ?? []);
    controls()[0]?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setLibraryOpen(false); }
      if (event.key !== 'Tab') return;
      const items = controls();
      const first = items[0];
      const last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', trap);
    return () => { document.removeEventListener('keydown', trap); previous?.focus(); };
  }, [libraryOpen]);
  const visible = nodes.filter(n => n.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const connected = nodes.filter(n => n.kind === 'session' && n.binding).length;
  const pick = (id: AgentTemplateId) => { if (readOnly) return; onAddAgent(id); setLibraryOpen(false); setSidebarOpen(false); };

  const botSidebar = (
<aside ref={botSidebarRef} className={`awwo-sidebar${modelShelf ? ' awwo-bot-sidebar' : ''}`} aria-label={modelShelf ? (locale === 'zh' ? 'Bot 清单' : 'Bot list') : t('workspace.navigation')}>
      {modelShelf ? <header className="awwo-bot-header"><div><span className="awwo-eyebrow">YOUR TEAM</span><h2><Bot size={20} />{locale === 'zh' ? 'Bot 清单' : 'Bots'}</h2></div><button type="button" className="awwo-icon-button awwo-mobile-menu" aria-label={t('workspace.closeNavigation')} onClick={() => setSidebarOpen(false)}><X size={18} /></button></header> : <>
      <div className="awwo-brand"><button className="awwo-brand-mark" aria-label={t(navExpanded ? 'workspace.collapseNavigation' : 'workspace.expandNavigation')} title={t('workspace.navigationTitle')} onClick={() => setNavExpanded(!navExpanded)}><GitBranch size={23} /></button><span>AwwO</span><span className="awwo-brand-caption">{t('workspace.caption')}</span></div>
      <div className="awwo-workspace-name"><span className="awwo-workspace-avatar"><FolderOpen size={16} /></span><div><strong>{workspaceName || t('workspace.name')}</strong><small>{workspaceCaption || t('workspace.local')}</small></div></div>
      </>}
      {!modelShelf && <div className="awwo-nav-active" aria-current="page"><Layers3 size={17} /><span>{t('workspace.canvas')}</span><span className="awwo-nav-badge">{nodes.length}</span></div>}
      <button className="awwo-new-agent" aria-label={t('workspace.addAgent')} title={t('workspace.addAgent')} disabled={readOnly || running} onClick={() => { setSidebarOpen(false); setLibraryOpen(true); }}><Plus size={17} />{modelShelf ? (locale === 'zh' ? '添加 Bot' : 'Add Bot') : t('workspace.addAgent')}</button>
      {modelShelf && <div className="awwo-bot-tabs" role="group" aria-label={locale === 'zh' ? 'Bot 来源' : 'Bot source'}>
        <button type="button" aria-pressed={botSource === 'canvas'} onClick={() => setBotSource('canvas')}>{locale === 'zh' ? '画布中' : 'Canvas'}<span>{nodes.length}</span></button>
        {loadWorkspaceAgents && onAddWorkspaceAgent && <button type="button" aria-pressed={botSource === 'workspace'} onClick={() => setBotSource('workspace')}>{locale === 'zh' ? '工作区' : 'Workspace'}</button>}
        {onAddMarketAgent && <button type="button" aria-pressed={botSource === 'market'} onClick={() => setBotSource('market')}>{locale === 'zh' ? '产品 Bot' : 'Product Bots'}</button>}
      </div>}
      <div className="awwo-bot-content">
      {(!modelShelf || botSource === 'canvas') && <>
      <div className="awwo-list-heading"><span>{modelShelf ? (locale === 'zh' ? '画布中的 Bot' : 'Bots on canvas') : t('workspace.canvasAgents')}</span><span>{nodes.length.toString().padStart(2, '0')}</span></div>
      <label className="awwo-search"><Search size={15} /><input type="search" aria-label={t('workspace.findAgent')} placeholder={t('workspace.findAgentPlaceholder')} value={query} onChange={e => setQuery(e.target.value)} /></label>
      <div className="awwo-agent-list">
        {visible.map((node, i) => {
          const state = runs[node.id]?.state;
          const caption = state ? t(`status.${state}`) : node.kind === 'session' && node.binding ? t('status.bound') : t('status.unbound');
          return <button key={node.id} className={`awwo-agent-row${selectedIds.includes(node.id) ? ' is-selected' : ''}`} aria-label={t('workspace.locateAgent', { title: node.title })} title={node.title} onClick={() => { onFocusNode(node.id); setSidebarOpen(false); }}>
            <span className="awwo-agent-row-icon"><AgentGlyph title={node.title} templateId={node.kind === 'session' ? getAgentTemplateForNode(node, locale)?.id : undefined} size={17} /></span>
            <span className="awwo-agent-row-copy"><strong>{node.title}</strong><small><i className={`awwo-status-dot is-${state ?? 'draft'}`} />{caption}</small></span>
            <span className="awwo-agent-index">{(i + 1).toString().padStart(2, '0')}</span>
          </button>;
        })}
        {!visible.length && <p className="awwo-list-empty">{query ? t('workspace.noAgentMatch') : t('workspace.firstAgent')}</p>}
      </div>
      </>}
      {modelShelf && botSource === 'workspace' && loadWorkspaceAgents && onAddWorkspaceAgent && <WorkspaceAgentPicker compact loadPage={loadWorkspaceAgents} disabled={readOnly || running} onSelect={agent => { if (readOnly || running) return; onAddWorkspaceAgent(agent); setBotSource('canvas'); setSidebarOpen(false); }} />}
      {modelShelf && botSource === 'market' && onAddMarketAgent && <TeamMarketAgentPicker compact disabled={readOnly || running} onSelect={agent => { if (readOnly || running) return; onAddMarketAgent(agent); setBotSource('canvas'); setSidebarOpen(false); }} />}
      {personaControls && <details className="awwo-bot-personas"><summary>{locale === 'zh' ? '人设预设' : 'Persona presets'}</summary>{personaControls}</details>}
      </div>
      <div className="awwo-sidebar-footer"><div className="awwo-workspace-note"><GitBranch size={16} /><span>{t('workspace.independentChats')}</span></div>{!modelShelf && onOpenSettings && <button onClick={onOpenSettings}><Settings2 size={17} />{t('workspace.settings')}<ChevronRight size={14} /></button>}</div>
    </aside>
  );

  return <div className={`awwo-workspace${sidebarOpen ? ' is-sidebar-open' : ''}${modelLibraryOpen ? ' is-model-library-open' : ''}${modelShelf ? ' has-model-library' : navExpanded ? '' : ' is-nav-compact'}`}>
    {(sidebarOpen || modelLibraryOpen) && <button className="awwo-sidebar-scrim" aria-label={t('workspace.closeNavigation')} onClick={() => { setSidebarOpen(false); setModelLibraryOpen(false); }} />}
    {modelShelf && <aside ref={modelSidebarRef} className="awwo-model-sidebar" aria-label={locale === 'zh' ? '模型库' : 'Model library'} onPointerDown={() => setSidebarOpen(false)}>
      <div className="awwo-brand"><span className="awwo-brand-mark" aria-hidden="true"><GitBranch size={23} /></span><span>AwwO</span><button type="button" className="awwo-icon-button awwo-mobile-menu" aria-label={locale === 'zh' ? '关闭模型库' : 'Close model library'} onClick={() => setModelLibraryOpen(false)}><X size={18} /></button></div>
      <div className="awwo-workspace-name"><span className="awwo-workspace-avatar"><FolderOpen size={16} /></span><div><strong>{workspaceName || t('workspace.name')}</strong><small>{locale === 'zh' ? '模型与编排' : 'Models & orchestration'}</small></div></div>
      {modelShelf}
      {onOpenSettings && <div className="awwo-sidebar-footer"><button onClick={onOpenSettings}><Settings2 size={17} />{t('workspace.settings')}<ChevronRight size={14} /></button></div>}
    </aside>}
    {!modelShelf && botSidebar}
    <main className="awwo-main" inert={mobile && (modelLibraryOpen || sidebarOpen)}>
      <header className="awwo-header">
        {modelShelf && <button className="awwo-mobile-menu awwo-icon-button" aria-label={locale === 'zh' ? '打开模型库' : 'Open model library'} aria-expanded={modelLibraryOpen} onClick={() => { setModelLibraryOpen(true); setSidebarOpen(false); }}><Cpu size={19} /></button>}
        <button className="awwo-mobile-menu awwo-icon-button" aria-label={t('workspace.openNavigation')} aria-expanded={sidebarOpen} onClick={() => { setSidebarOpen(true); setModelLibraryOpen(false); }}><Menu size={19} /></button>
        <div className="awwo-page-title"><div className="awwo-breadcrumb">AwwO<ChevronRight size={12} /><span>{workspaceName || t('workspace.name')}</span></div></div>
        <div className="awwo-header-actions"><button className="awwo-icon-button awwo-command-search" aria-label={t('workspace.search')} onClick={onSearch}><Search size={18} /></button>{accountControl}</div>
      </header>
      <div className="awwo-canvas-bar">{onToggleAssistant && nodes.length > 0 ? <button className="awwo-assistant-toggle" type="button" aria-label={t('workspace.assistant')} aria-expanded={assistantOpen} onClick={onToggleAssistant}><MessageSquare size={15} /><span>{t('workspace.assistant')}</span></button> : null}<div className="awwo-canvas-tab"><GitBranch size={16} /><span>{t('workspace.collaborationCanvas')}</span></div><span className="awwo-canvas-meta">{t('workspace.agentCount', { count: nodes.length })}<span>·</span>{t('workspace.connectionCount', { count: edges.length })}</span><div className="awwo-run-slot">{toolbar}</div></div>
      <section className="awwo-stage" aria-label={t('workspace.stage')}>
        {assistant ? <aside className="awwo-planner-sidebar" aria-label={t('workspace.planning')}>{assistant}</aside> : null}
        <div className="awwo-stage-canvas" onDragOver={onModelDragOver} onDrop={onModelDrop}>{children}
        {!nodes.length && <div className={`awwo-empty${welcome ? ' has-assistant' : ''}`}>
          {welcome || <>
          <div className="awwo-empty-kicker"><span />{t('workspace.emptyKicker')}</div>
          <h2>{t('workspace.emptyTitle')}</h2>
          <p>{t('workspace.emptyBody')}</p>
          <div className="awwo-empty-diagram" aria-hidden="true">
            <div className="awwo-example-node"><span><Database size={19} /></span><strong>{t('workspace.exampleData')}</strong><small>{t('workspace.exampleDataDetail')}</small><i /></div>
            <div className="awwo-example-line"><span /><ArrowRight size={15} /></div>
            <div className="awwo-example-node is-featured"><span><TerminalSquare size={19} /></span><strong>{t('workspace.exampleBackend')}</strong><small>{t('workspace.exampleBackendDetail')}</small><i /></div>
            <div className="awwo-example-line"><span /><ArrowRight size={15} /></div>
            <div className="awwo-example-node"><span><Code2 size={19} /></span><strong>{t('workspace.exampleFrontend')}</strong><small>{t('workspace.exampleFrontendDetail')}</small></div>
          </div>
          </>}
          {modelShelf ? <p className="awwo-empty-note">{locale === 'zh' ? '从左侧拖入模型，在右侧选择 Bot 或人设。' : 'Drag a model from the left, or choose a Bot from the right.'}</p> : <>
          <div className="awwo-empty-actions"><button className="awwo-primary" onClick={() => { if (!readOnly) onCreateTemplate(); }} disabled={readOnly || running}><GitBranch size={17} />{t('workspace.createProductCanvas')}<ArrowRight size={16} /></button><button className="awwo-secondary" onClick={() => pick('general')} disabled={readOnly || running}><Plus size={16} />{t('workspace.startBlank')}</button></div>
          <span className="awwo-empty-note">{welcome ? t('workspace.templateHint') : t('workspace.draftHint')}</span></>}
        </div>}
        </div>
      </section>
      <footer className="awwo-statusbar"><span><span className="awwo-status-dot is-draft" />{connected ? t('workspace.connectedCount', { count: connected }) : t('workspace.noneConnected')}</span><span>{t('workspace.panHint')}<span className="awwo-status-divider">/</span>{t('workspace.zoomHint')}<span className="awwo-status-divider">/</span>{t('workspace.focusHint')}</span><span className="awwo-local-tag">{storageMode === 'cloud' ? `${t('workspace.cloudCanvas')}${readOnly ? ` · ${t('common.readOnly')}` : ''}` : t(readOnly ? 'common.readOnly' : 'workspace.localCanvas')}</span></footer>
    </main>
    {modelShelf && botSidebar}
    {libraryOpen && <div className="awwo-library-backdrop" onPointerDown={e => { if (e.target === e.currentTarget) setLibraryOpen(false); }} onKeyDown={e => { if (e.key === 'Escape') setLibraryOpen(false); }}>
      <section ref={libraryRef} className="awwo-agent-library" role="dialog" aria-modal="true" aria-label={t('workspace.addAgent')}>
        <header><div><span className="awwo-eyebrow">AGENT LIBRARY</span><h2>{t('workspace.chooseCollaborator')}</h2></div><button className="awwo-icon-button" aria-label={t('workspace.closeAddAgent')} onClick={() => setLibraryOpen(false)}><X size={19} /></button></header>
        {loadWorkspaceAgents && onAddWorkspaceAgent && <div className="awwo-library-sources" role="group" aria-label={locale === 'zh' ? 'Agent 来源' : 'Agent source'}>
          <button type="button" aria-pressed={librarySource === 'workspace'} onClick={() => setLibrarySource('workspace')}>{locale === 'zh' ? '工作区 Agent' : 'Workspace Agents'}</button>
          {onAddMarketAgent && <button type="button" aria-pressed={librarySource === 'market'} onClick={() => setLibrarySource('market')}>{locale === 'zh' ? '团队市场角色' : 'Team market roles'}</button>}
          {!modelShelf && <button type="button" aria-pressed={librarySource === 'templates'} onClick={() => setLibrarySource('templates')}>{locale === 'zh' ? '角色模板' : 'Role templates'}</button>}
        </div>}
        {librarySource === 'workspace' && loadWorkspaceAgents && onAddWorkspaceAgent ? <WorkspaceAgentPicker loadPage={loadWorkspaceAgents} disabled={readOnly || running} onSelect={agent => { if (readOnly || running) return; onAddWorkspaceAgent(agent); setLibraryOpen(false); setSidebarOpen(false); }} /> : librarySource === 'market' && onAddMarketAgent ? <TeamMarketAgentPicker disabled={readOnly || running} onSelect={agent => { if (readOnly || running) return; onAddMarketAgent(agent); setLibraryOpen(false); setSidebarOpen(false); }} /> : <>
        <p>{t('workspace.libraryBody')}</p>
        <div className="awwo-template-browser">
          <nav className="awwo-template-list" aria-label={t('workspace.templateList')}>{templates.map(item => <button key={item.id} type="button" aria-label={t('workspace.previewTemplate', { title: item.title })} aria-pressed={selectedTemplate === item.id} data-template={item.id} onClick={() => setSelectedTemplate(item.id)}>
            <span className="awwo-template-icon"><AgentGlyph templateId={item.id} size={18} /></span><span><strong>{item.title}</strong><small>{item.subtitle}</small></span><ChevronRight size={14} />
          </button>)}</nav>
          <div className="awwo-template-preview" data-template={template.id} key={template.id} role="region" aria-label={t('workspace.templateDetails', { title: template.title })}>
            <div className="awwo-template-hero"><span className="awwo-template-icon"><AgentGlyph templateId={template.id} size={23} /></span><div><span className="awwo-template-tag">{template.tag}</span><h3>{template.title}</h3></div><span className="awwo-template-version">v{AGENT_TEMPLATE_VERSION}</span></div>
            <p className="awwo-template-description">{template.emptyDescription}</p>
            <AgentTemplateDetails template={template} />
          </div>
        </div>
        <footer className="awwo-template-library-footer"><span>{t('workspace.libraryFooter')}</span><button className="awwo-primary" type="button" disabled={readOnly || running} onClick={() => pick(template.id)}><Plus size={16} />{t('workspace.addTemplate', { title: template.title })}</button></footer></>}
      </section>
    </div>}
  </div>;
}
