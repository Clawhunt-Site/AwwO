import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowRight, ChevronRight, Code2, Database, FolderOpen, GitBranch, Layers3, Menu, MessageSquare, Plus, Search, Settings2, TerminalSquare, X } from 'lucide-react';
import type { CanvasEdge, CanvasNode } from './canvasDoc';
import type { RunNodeStatus } from './runGraph';
import { AGENT_TEMPLATES, AGENT_TEMPLATE_VERSION, getAgentTemplateForNode, type AgentTemplateId } from './agentTemplates';
import { AgentGlyph, AgentTemplateDetails } from './AgentTemplateDetails';
export { AgentGlyph } from './AgentTemplateDetails';
import './awwo-workspace.css';

export interface AgentWorkspaceProps {
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

export function AgentWorkspace({ nodes, edges, selectedIds, runs, running, onFocusNode, onAddAgent, onCreateTemplate, onSearch, onOpenSettings, toolbar, accountControl, assistant, welcome, assistantOpen, onToggleAssistant, children }: AgentWorkspaceProps) {
  const [query, setQuery] = useState('');
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState<AgentTemplateId>('frontend');
  const template = AGENT_TEMPLATES.find(item => item.id === selectedTemplate)!;
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
    {sidebarOpen && <button className="awwo-sidebar-scrim" aria-label="关闭导航" onClick={() => setSidebarOpen(false)} />}
    <aside className="awwo-sidebar" aria-label="工作区导航">
      <div className="awwo-brand"><button className="awwo-brand-mark" aria-label={navExpanded ? "收起画布导航" : "展开画布导航"} title="AwwO · 画布导航" onClick={() => setNavExpanded(!navExpanded)}><GitBranch size={23} /></button><span>AwwO</span><span className="awwo-brand-caption">Agent workspace</span></div>
      <div className="awwo-workspace-name"><span className="awwo-workspace-avatar"><FolderOpen size={16} /></span><div><strong>我的工作区</strong><small>本地工作区</small></div></div>
      <div className="awwo-nav-active" aria-current="page"><Layers3 size={17} /><span>Agent 画布</span><span className="awwo-nav-badge">{nodes.length}</span></div>
      <button className="awwo-new-agent" aria-label="添加 Agent" title="添加 Agent" disabled={running} onClick={() => setLibraryOpen(true)}><Plus size={17} />添加 Agent</button>
      <div className="awwo-list-heading"><span>画布中的 Agent</span><span>{nodes.length.toString().padStart(2, '0')}</span></div>
      <label className="awwo-search"><Search size={15} /><input type="search" aria-label="查找 Agent" placeholder="查找 Agent…" value={query} onChange={e => setQuery(e.target.value)} /></label>
      <div className="awwo-agent-list">
        {visible.map((node, i) => {
          const state = runs[node.id]?.state;
          const caption = state ? ({ waiting: '等待上游', running: '运行中', done: '已完成', failed: '运行失败', blocked: '被上游阻断', cached: '沿用已存结果' }[state]) : node.kind === 'session' && node.binding ? '已连接' : '待配置';
          return <button key={node.id} className={`awwo-agent-row${selectedIds.includes(node.id) ? ' is-selected' : ''}`} aria-label={`定位 ${node.title}`} title={node.title} onClick={() => { onFocusNode(node.id); setSidebarOpen(false); }}>
            <span className="awwo-agent-row-icon"><AgentGlyph title={node.title} templateId={node.kind === 'session' ? getAgentTemplateForNode(node)?.id : undefined} size={17} /></span>
            <span className="awwo-agent-row-copy"><strong>{node.title}</strong><small><i className={`awwo-status-dot is-${state ?? 'draft'}`} />{caption}</small></span>
            <span className="awwo-agent-index">{(i + 1).toString().padStart(2, '0')}</span>
          </button>;
        })}
        {!visible.length && <p className="awwo-list-empty">{query ? '没有找到匹配的 Agent' : '你的第一个 Agent，\n从这里开始。'}</p>}
      </div>
      <div className="awwo-sidebar-footer"><div className="awwo-workspace-note"><GitBranch size={16} /><span>独立对话，有序协作</span></div>{onOpenSettings && <button onClick={onOpenSettings}><Settings2 size={17} />工作区设置<ChevronRight size={14} /></button>}</div>
    </aside>
    <main className="awwo-main">
      <header className="awwo-header">
        <button className="awwo-mobile-menu awwo-icon-button" aria-label="打开导航" onClick={() => setSidebarOpen(true)}><Menu size={19} /></button>
        <div className="awwo-page-title"><div className="awwo-breadcrumb">AwwO<ChevronRight size={12} /><span>我的工作区</span></div></div>
        <div className="awwo-header-actions"><button className="awwo-icon-button awwo-command-search" aria-label="搜索画布与命令" onClick={onSearch}><Search size={18} /></button>{accountControl}</div>
      </header>
      <div className="awwo-canvas-bar">{onToggleAssistant && nodes.length > 0 ? <button className="awwo-assistant-toggle" type="button" aria-label="画布助手" aria-expanded={assistantOpen} onClick={onToggleAssistant}><MessageSquare size={15} /><span>画布助手</span></button> : null}<div className="awwo-canvas-tab"><GitBranch size={16} /><span>协作画布</span></div><span className="awwo-canvas-meta">{nodes.length} Agent<span>·</span>{edges.length} 条连接</span><div className="awwo-run-slot">{toolbar}</div></div>
      <section className="awwo-stage" aria-label="Agent 协作画布">
        {assistant ? <aside className="awwo-planner-sidebar" aria-label="画布规划">{assistant}</aside> : null}
        <div className="awwo-stage-canvas">{children}
        {!nodes.length && <div className={`awwo-empty${welcome ? ' has-assistant' : ''}`}>
          {welcome || <>
          <div className="awwo-empty-kicker"><span />从独立对话，到共同交付</div>
          <h2>把想法，交给一组 Agent。</h2>
          <p>一个节点，一段专属对话。<br />定义输入与输出，连接彼此的工作。</p>
          <div className="awwo-empty-diagram" aria-hidden="true">
            <div className="awwo-example-node"><span><Database size={19} /></span><strong>数据治理</strong><small>定义数据结构</small><i /></div>
            <div className="awwo-example-line"><span /><ArrowRight size={15} /></div>
            <div className="awwo-example-node is-featured"><span><TerminalSquare size={19} /></span><strong>后端 Agent</strong><small>构建业务服务</small><i /></div>
            <div className="awwo-example-line"><span /><ArrowRight size={15} /></div>
            <div className="awwo-example-node"><span><Code2 size={19} /></span><strong>前端 Agent</strong><small>完成产品界面</small></div>
          </div>
          </>}
          <div className="awwo-empty-actions"><button className="awwo-primary" onClick={onCreateTemplate} disabled={running}><GitBranch size={17} />创建产品研发画布<ArrowRight size={16} /></button><button className="awwo-secondary" onClick={() => pick('general')} disabled={running}><Plus size={16} />从空白 Agent 开始</button></div>
          <span className="awwo-empty-note">{welcome ? '也可以从模板开始，之后用对话或手动调整。' : '创建 5 个可编辑的 Agent 草稿，配置后开始运行'}</span>
        </div>}
        </div>
      </section>
      <footer className="awwo-statusbar"><span><span className="awwo-status-dot is-draft" />{connected ? `${connected} 个 Agent 已连接` : '尚未连接 Agent'}</span><span>拖动画布平移<span className="awwo-status-divider">/</span>滚轮缩放<span className="awwo-status-divider">/</span>双击节点聚焦</span><span className="awwo-local-tag">本地画布</span></footer>
    </main>
    {libraryOpen && <div className="awwo-library-backdrop" onPointerDown={e => { if (e.target === e.currentTarget) setLibraryOpen(false); }} onKeyDown={e => { if (e.key === 'Escape') setLibraryOpen(false); }}>
      <section ref={libraryRef} className="awwo-agent-library" role="dialog" aria-modal="true" aria-label="添加 Agent">
        <header><div><span className="awwo-eyebrow">AGENT TEMPLATES</span><h2>选择你的下一位协作者</h2></div><button className="awwo-icon-button" aria-label="关闭添加 Agent" onClick={() => setLibraryOpen(false)}><X size={19} /></button></header>
        <p>从职责到交付，每个模板都有自己的工作方式。</p>
        <div className="awwo-template-browser">
          <nav className="awwo-template-list" aria-label="组件模板">{AGENT_TEMPLATES.map(item => <button key={item.id} type="button" aria-label={`预览${item.title}模板`} aria-pressed={selectedTemplate === item.id} data-template={item.id} onClick={() => setSelectedTemplate(item.id)}>
            <span className="awwo-template-icon"><AgentGlyph templateId={item.id} size={18} /></span><span><strong>{item.title}</strong><small>{item.subtitle}</small></span><ChevronRight size={14} />
          </button>)}</nav>
          <div className="awwo-template-preview" data-template={template.id} key={template.id} role="region" aria-label={`${template.title}模板详情`}>
            <div className="awwo-template-hero"><span className="awwo-template-icon"><AgentGlyph templateId={template.id} size={23} /></span><div><span className="awwo-template-tag">{template.tag}</span><h3>{template.title}</h3></div><span className="awwo-template-version">v{AGENT_TEMPLATE_VERSION}</span></div>
            <p className="awwo-template-description">{template.emptyDescription}</p>
            <AgentTemplateDetails template={template} />
          </div>
        </div>
        <footer className="awwo-template-library-footer"><span>包含专属表单、工作指引与交付规范</span><button className="awwo-primary" type="button" disabled={running} onClick={() => pick(template.id)}><Plus size={16} />添加{template.title}</button></footer>
      </section>
    </div>}
  </div>;
}
