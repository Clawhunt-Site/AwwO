import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowRight, ChevronRight, Code2, Database, FolderOpen, GitBranch, Layers3, Menu, MessageSquare, Plus, Search, Settings2, TerminalSquare, X } from 'lucide-react';
import type { CanvasEdge, CanvasNode } from './canvasDoc';
import type { RunNodeStatus } from './runGraph';
import { AGENT_TEMPLATE_VERSION, getAgentTemplateForNode, getAgentTemplates, type AgentTemplateId } from './agentTemplates';
import { AgentGlyph, AgentTemplateDetails } from './AgentTemplateDetails';
import { useCanvasI18n } from './i18n';
export { AgentGlyph } from './AgentTemplateDetails';
import './awwo-workspace.css';

export interface AgentWorkspaceProps {
  workspaceName?: string;
  workspaceCaption?: string;
  nodes: ReadonlyArray<CanvasNode>;
  edges: ReadonlyArray<CanvasEdge>;
  selectedIds: ReadonlyArray<string>;
  runs: Readonly<Record<string, RunNodeStatus>>;
  running: boolean;
  onFocusNode: (id: string) => void;
  onAddAgent: (id: AgentTemplateId) => void;
  onCreateTemplate: () => void;
  onSearch: () => void;
  onOpenSettings?: () => void;
  toolbar?: ReactNode;
  accountControl?: ReactNode;
  assistant?: ReactNode;
  welcome?: ReactNode;
  assistantOpen?: boolean;
  onToggleAssistant?: () => void;
  children: ReactNode;
}

export function AgentWorkspace({ workspaceName, workspaceCaption, nodes, edges, selectedIds, runs, running, onFocusNode, onAddAgent, onCreateTemplate, onSearch, onOpenSettings, toolbar, accountControl, assistant, welcome, assistantOpen, onToggleAssistant, children }: AgentWorkspaceProps) {
  const { locale, t } = useCanvasI18n();
  const [query, setQuery] = useState('');
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState<AgentTemplateId>('frontend');
  const templates = getAgentTemplates(locale);
  const template = templates.find(item => item.id === selectedTemplate)!;
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [navExpanded, setNavExpanded] = useState(false);
  const libraryRef = useRef<HTMLElement>(null);
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
  const pick = (id: AgentTemplateId) => { onAddAgent(id); setLibraryOpen(false); setSidebarOpen(false); };

  return <div className={`awwo-workspace${sidebarOpen ? ' is-sidebar-open' : ''}${navExpanded ? '' : ' is-nav-compact'}`}>
    {sidebarOpen && <button className="awwo-sidebar-scrim" aria-label={t('workspace.closeNavigation')} onClick={() => setSidebarOpen(false)} />}
    <aside className="awwo-sidebar" aria-label={t('workspace.navigation')}>
      <div className="awwo-brand"><button className="awwo-brand-mark" aria-label={t(navExpanded ? 'workspace.collapseNavigation' : 'workspace.expandNavigation')} title={t('workspace.navigationTitle')} onClick={() => setNavExpanded(!navExpanded)}><GitBranch size={23} /></button><span>AwwO</span><span className="awwo-brand-caption">{t('workspace.caption')}</span></div>
      <div className="awwo-workspace-name"><span className="awwo-workspace-avatar"><FolderOpen size={16} /></span><div><strong>{workspaceName || t('workspace.name')}</strong><small>{workspaceCaption || t('workspace.local')}</small></div></div>
      <div className="awwo-nav-active" aria-current="page"><Layers3 size={17} /><span>{t('workspace.canvas')}</span><span className="awwo-nav-badge">{nodes.length}</span></div>
      <button className="awwo-new-agent" aria-label={t('workspace.addAgent')} title={t('workspace.addAgent')} disabled={running} onClick={() => setLibraryOpen(true)}><Plus size={17} />{t('workspace.addAgent')}</button>
      <div className="awwo-list-heading"><span>{t('workspace.canvasAgents')}</span><span>{nodes.length.toString().padStart(2, '0')}</span></div>
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
      <div className="awwo-sidebar-footer"><div className="awwo-workspace-note"><GitBranch size={16} /><span>{t('workspace.independentChats')}</span></div>{onOpenSettings && <button onClick={onOpenSettings}><Settings2 size={17} />{t('workspace.settings')}<ChevronRight size={14} /></button>}</div>
    </aside>
    <main className="awwo-main">
      <header className="awwo-header">
        <button className="awwo-mobile-menu awwo-icon-button" aria-label={t('workspace.openNavigation')} onClick={() => setSidebarOpen(true)}><Menu size={19} /></button>
        <div className="awwo-page-title"><div className="awwo-breadcrumb">AwwO<ChevronRight size={12} /><span>{workspaceName || t('workspace.name')}</span></div></div>
        <div className="awwo-header-actions"><button className="awwo-icon-button awwo-command-search" aria-label={t('workspace.search')} onClick={onSearch}><Search size={18} /></button>{accountControl}</div>
      </header>
      <div className="awwo-canvas-bar">{onToggleAssistant && nodes.length > 0 ? <button className="awwo-assistant-toggle" type="button" aria-label={t('workspace.assistant')} aria-expanded={assistantOpen} onClick={onToggleAssistant}><MessageSquare size={15} /><span>{t('workspace.assistant')}</span></button> : null}<div className="awwo-canvas-tab"><GitBranch size={16} /><span>{t('workspace.collaborationCanvas')}</span></div><span className="awwo-canvas-meta">{t('workspace.agentCount', { count: nodes.length })}<span>·</span>{t('workspace.connectionCount', { count: edges.length })}</span><div className="awwo-run-slot">{toolbar}</div></div>
      <section className="awwo-stage" aria-label={t('workspace.stage')}>
        {assistant ? <aside className="awwo-planner-sidebar" aria-label={t('workspace.planning')}>{assistant}</aside> : null}
        <div className="awwo-stage-canvas">{children}
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
          <div className="awwo-empty-actions"><button className="awwo-primary" onClick={onCreateTemplate} disabled={running}><GitBranch size={17} />{t('workspace.createProductCanvas')}<ArrowRight size={16} /></button><button className="awwo-secondary" onClick={() => pick('general')} disabled={running}><Plus size={16} />{t('workspace.startBlank')}</button></div>
          <span className="awwo-empty-note">{welcome ? t('workspace.templateHint') : t('workspace.draftHint')}</span>
        </div>}
        </div>
      </section>
      <footer className="awwo-statusbar"><span><span className="awwo-status-dot is-draft" />{connected ? t('workspace.connectedCount', { count: connected }) : t('workspace.noneConnected')}</span><span>{t('workspace.panHint')}<span className="awwo-status-divider">/</span>{t('workspace.zoomHint')}<span className="awwo-status-divider">/</span>{t('workspace.focusHint')}</span><span className="awwo-local-tag">{t('workspace.localCanvas')}</span></footer>
    </main>
    {libraryOpen && <div className="awwo-library-backdrop" onPointerDown={e => { if (e.target === e.currentTarget) setLibraryOpen(false); }} onKeyDown={e => { if (e.key === 'Escape') setLibraryOpen(false); }}>
      <section ref={libraryRef} className="awwo-agent-library" role="dialog" aria-modal="true" aria-label={t('workspace.addAgent')}>
        <header><div><span className="awwo-eyebrow">AGENT TEMPLATES</span><h2>{t('workspace.chooseCollaborator')}</h2></div><button className="awwo-icon-button" aria-label={t('workspace.closeAddAgent')} onClick={() => setLibraryOpen(false)}><X size={19} /></button></header>
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
        <footer className="awwo-template-library-footer"><span>{t('workspace.libraryFooter')}</span><button className="awwo-primary" type="button" disabled={running} onClick={() => pick(template.id)}><Plus size={16} />{t('workspace.addTemplate', { title: template.title })}</button></footer>
      </section>
    </div>}
  </div>;
}
