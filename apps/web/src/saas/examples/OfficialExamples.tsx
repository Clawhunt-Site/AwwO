import { lazy, Suspense, useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { ArrowDownToLine, ArrowUpRight, Check, ChevronLeft, Copy, GitBranch, Play, Workflow } from 'lucide-react';
import { useSaaSPreferences, PreferenceControls } from '../preferences';
import { OFFICIAL_WORKFLOWS, createOfficialDocument, getOfficialWorkflow, type OfficialWorkflow } from './officialWorkflows';
import type { UiLocale } from '../../locale';
import { rememberOfficialSelection, officialSignInURL } from './officialSelection';
import './official-examples.css';

const InteractionDemo = lazy(() => import('./CreativeDemos').then(module => ({ default: module.InteractionDemo })));
const GameDemo = lazy(() => import('./CreativeDemos').then(module => ({ default: module.GameDemo })));
const SceneDemo = lazy(() => import('./CreativeDemos').then(module => ({ default: module.SceneDemo })));
const KnowledgeDemo = lazy(() => import('./IntelligenceDemos').then(module => ({ default: module.KnowledgeDemo })));
const TrainingDemo = lazy(() => import('./IntelligenceDemos').then(module => ({ default: module.TrainingDemo })));
const OperationsDemo = lazy(() => import('./IntelligenceDemos').then(module => ({ default: module.OperationsDemo })));

function Demo({ id, locale }: { id: string; locale: UiLocale }) {
  switch (id) {
    case 'interaction-page': return <InteractionDemo locale={locale} />;
    case 'orbit-game': return <GameDemo locale={locale} />;
    case 'spatial-studio': return <SceneDemo locale={locale} />;
    case 'knowledge-desk': return <KnowledgeDemo locale={locale} />;
    case 'model-lab': return <TrainingDemo locale={locale} />;
    case 'operations-hub': return <OperationsDemo locale={locale} />;
    default: return null;
  }
}

/** Tiny original covers. The interactive implementation loads only after a case is opened. */
function CaseCover({ category }: { category: OfficialWorkflow['category'] }) {
  return <div className={`official-cover official-cover-${category}`} aria-hidden="true">
    {category === 'design' && <div className="official-cover-browser"><i /><div className="official-cover-page"><span>ORBIT®</span><strong>Good work.<br />Great together.</strong><b>Build your space ↗</b><div className="official-cover-orb" /></div></div>}
    {category === 'game' && <><div className="official-cover-game-title">SIGNAL<br /><strong>RUN</strong></div><div className="official-cover-grid">{Array.from({ length: 25 }, (_, i) => <i key={i} className={[2, 8, 16, 19, 22].includes(i) ? 'lit' : i === 12 ? 'player' : ''} />)}</div><span className="official-cover-caption">MOVE · COLLECT · ESCAPE</span></>}
    {category === '3d' && <><div className="official-cover-space-grid" /><div className="official-cover-object"><i /><i /><i /></div><span className="official-cover-space-label">FIELD<br /><small>AN OBJECT IN SPACE</small></span><b className="official-cover-axis">Y<br />└── X</b></>}
    {category === 'knowledge' && <><span className="official-cover-doc-label">ATLAS / KNOWLEDGE</span><div className="official-cover-doc"><small>SOURCE 01</small><b /><i /><i /><b /><i /></div><div className="official-cover-answer"><span>↗</span><i /><i /><b>01 &nbsp; 02 &nbsp; 03</b></div></>}
    {category === 'training' && <><span className="official-cover-chart-label">MODEL LAB<span>LEARN BY DOING</span></span><svg viewBox="0 0 320 130"><path className="grid" d="M0 20H320 M0 60H320 M0 100H320 M40 0V130 M120 0V130 M200 0V130 M280 0V130" /><path className="curve" d="M10 12C50 10 35 78 100 82S220 112 310 115" /><path className="curve second" d="M10 30C65 26 50 90 125 95S240 108 310 109" /></svg><span className="official-cover-chart-key">● TRAIN &nbsp; ○ VALIDATE</span></>}
    {category === 'operations' && <div className="official-cover-ops"><aside>▦<i /><i /><i /></aside><div><small>CONTROL ROOM</small><div className="official-cover-metrics"><b>24<i /></b><b>08<i /></b><b>16<i /></b></div>{[0, 1, 2].map(i => <p key={i}><i /><span /><b /></p>)}</div></div>}
  </div>;
}

type GalleryProps = {
  onReuse?: (item: OfficialWorkflow) => void;
  disabled?: boolean;
  readOnly?: boolean;
  error?: string;
  initialId?: string;
  standalone?: boolean;
};

export function OfficialExamples({ onReuse, disabled = false, readOnly = false, error, initialId, standalone = false }: GalleryProps) {
  const { locale, t } = useSaaSPreferences();
  const [category, setCategory] = useState('all');
  const [selected, setSelected] = useState<string | null>(() => getOfficialWorkflow(initialId || '')?.id ?? null);
  const [tab, setTab] = useState<'demo' | 'workflow' | 'guide'>('demo');
  const detail = useRef<HTMLDivElement>(null);
  const firstFilter = useRef<HTMLButtonElement>(null);
  const selectedTrigger = useRef<HTMLButtonElement | null>(null);
  const shouldFocus = useRef(false);
  const titleId = useId();
  const tabsId = useId();
  const item = selected ? getOfficialWorkflow(selected) : undefined;
  useEffect(() => {
    if (selected && shouldFocus.current) {
      detail.current?.focus({ preventScroll: true });
      detail.current?.scrollIntoView?.({ behavior: 'instant', block: 'start' });
      shouldFocus.current = false;
    }
  }, [selected]);
  const open = (example: OfficialWorkflow, trigger: HTMLButtonElement) => {
    selectedTrigger.current = trigger;
    shouldFocus.current = true;
    setTab('demo');
    setSelected(example.id);
  };
  const close = () => { setSelected(null); (selectedTrigger.current?.isConnected ? selectedTrigger.current : firstFilter.current)?.focus(); };
  const Heading = standalone ? 'h1' : 'h2';
  const tabItems = [
    { id: 'demo' as const, label: t('体验作品', 'Try the demo'), icon: Play },
    { id: 'workflow' as const, label: t('编排画布', 'Workflow canvas'), icon: Workflow },
    { id: 'guide' as const, label: t('复用指南', 'Build your version'), icon: Copy },
  ];
  return <section className="official-examples" aria-labelledby={titleId} id="official-examples">
    <div className="official-heading">
      <div><span className="official-eyebrow"><span />AWWO ORIGINALS / 01—06</span><Heading id={titleId}>{t('从想法，到可运行的作品。', 'An idea. A workflow. A working result.')}</Heading><p>{t('六种创作方向，六套完整编排。先体验，再拆开看，带走你的下一张画布。', 'Six directions, six complete workflows. Try a result, look inside, then make the canvas yours.')}</p></div>
      <span className="official-edition">{t('官方工作流参考', 'OFFICIAL WORKFLOW LIBRARY')}<b>VOL. 001</b></span>
    </div>
    <div className="official-filters" role="group" aria-label={t('官方案例分类', 'Official example categories')}>
      <button ref={firstFilter} type="button" aria-pressed={category === 'all'} onClick={() => setCategory('all')}>{t('全部作品', 'All work')}<span>06</span></button>
      {OFFICIAL_WORKFLOWS.map(example => <button type="button" key={example.id} aria-pressed={category === example.category} onClick={() => setCategory(example.category)}>{example.categoryLabel[locale]}</button>)}
    </div>
    <div className="official-cards">
      {OFFICIAL_WORKFLOWS.filter(example => category === 'all' || example.category === category).map((example) => <article key={example.id} className="official-card" style={{ '--case-accent': example.accent } as CSSProperties}>
        <button type="button" className="official-card-open" onClick={event => open(example, event.currentTarget)} aria-label={t(`查看官方案例：${example.title.zh}`, `Open official example: ${example.title.en}`)} aria-expanded={selected === example.id}>
          <CaseCover category={example.category} />
          <div className="official-card-copy"><div className="official-card-meta"><span>{example.categoryLabel[locale]}</span><span><GitBranch size={12} />{example.nodes.length} {t('节点', 'nodes')}</span></div><h3>{example.title[locale]}<ArrowUpRight size={19} /></h3><p>{example.summary[locale]}</p><div className="official-card-footer"><span>{example.pattern[locale]}</span><strong>{t('打开作品', 'Explore')} ↗</strong></div></div>
        </button>
      </article>)}
    </div>
    {item && <div key={item.id} className="official-detail" ref={detail} tabIndex={-1} aria-label={item.title[locale]} style={{ '--case-accent': item.accent } as CSSProperties}>
      <div className="official-detail-heading"><button type="button" onClick={close} className="official-back"><ChevronLeft size={16} />{t('收起作品', 'Close example')}</button><span>{item.categoryLabel[locale]} / {item.pattern[locale]}</span></div>
      <div className="official-detail-title"><div><h3>{item.title[locale]}</h3><p>{item.description[locale]}</p></div>
        {onReuse ? <button type="button" className="official-primary" disabled={disabled || readOnly} onClick={() => onReuse(item)}><Copy size={16} />{disabled ? t('正在创建…', 'Creating…') : t('复制到我的画布', 'Copy to my canvases')}</button>
          : !readOnly && <a className="official-primary" href={officialSignInURL(item.id, window.location.search)} onClick={() => rememberOfficialSelection(item.id)}><Copy size={16} />{t('登录并复用', 'Sign in to reuse')}</a>}
      </div>
      {readOnly && <p className="official-caption">{t('你可以体验和下载工作流。复制到工作区需要编辑权限。', 'You can explore and download this workflow. Copying into a workspace requires edit access.')}</p>}
      {error && <p className="saas-error" role="alert">{error}</p>}
      <div className="official-tabs" role="tablist" aria-label={t('案例内容', 'Example content')}>
        {tabItems.map(({ id, label, icon: Icon }, index) => <button key={id} id={`${tabsId}-${id}`} type="button" role="tab" aria-selected={tab === id} aria-controls={`${tabsId}-panel`} tabIndex={tab === id ? 0 : -1} onClick={() => setTab(id)} onKeyDown={event => {
          const next = event.key === 'ArrowRight' ? (index + 1) % 3 : event.key === 'ArrowLeft' ? (index + 2) % 3 : event.key === 'Home' ? 0 : event.key === 'End' ? 2 : null;
          if (next === null) return; event.preventDefault(); setTab(tabItems[next].id); document.getElementById(`${tabsId}-${tabItems[next].id}`)?.focus();
        }}><Icon size={15} />{label}</button>)}
      </div>
      <div id={`${tabsId}-panel`} role="tabpanel" aria-labelledby={`${tabsId}-${tab}`} tabIndex={0}>
        {tab === 'demo' ? <><div className="official-live-label"><span />{t('可交互参考实现 · 浏览器本地运行', 'Interactive reference · Runs in your browser')}</div><Suspense fallback={<p role="status">{t('正在载入作品…', 'Loading demo…')}</p>}><Demo id={item.id} locale={locale} /></Suspense><p className="official-caption">{item.limitations[locale]}</p></>
          : tab === 'workflow' ? <WorkflowInspector item={item} />
            : <ReuseGuide item={item} />}
      </div>
      <p className="official-provenance">{t('官方设计的参考实现与编排模板。复制后是未执行的草稿；选择模型并运行后，才会产生你自己的交付物。', 'Officially authored reference implementations and workflow templates. A copy is an unexecuted draft. Choose your models and run it to create your own deliverables.')}</p>
    </div>}
    <div className="official-library-note"><Workflow size={17} /><p>{t('每张画布都保留分工、输入输出与验收要求。复用结构，再按你的目标继续创作。', 'Every canvas carries the roles, inputs, outputs and acceptance criteria. Reuse the structure, then take it in your direction.')}</p></div>
  </section>;
}

export function WorkflowInspector({ item }: { item: OfficialWorkflow }) {
  const { locale, t } = useSaaSPreferences();
  const [active, setActive] = useState(item.nodes[0].id);
  const [zoom, setZoom] = useState(1);
  const node = item.nodes.find(value => value.id === active) || item.nodes[0];
  const width = (Math.max(...item.nodes.map(value => value.column)) + 1) * 235 + 40;
  const minRow = Math.min(...item.nodes.map(value => value.row));
  const maxRow = Math.max(...item.nodes.map(value => value.row));
  const height = (maxRow - minRow + 1) * 142 + 96;
  const position = (id: string) => { const value = item.nodes.find(entry => entry.id === id)!; return { x: 22 + value.column * 235, y: 80 + (value.row - minRow) * 142 }; };
  return <div className="official-workflow">
    <div className="official-canvas-toolbar"><span><GitBranch size={15} />{item.nodes.length} {t('节点', 'nodes')} / {item.edges.length} {t('依赖', 'dependencies')}</span><div><button type="button" onClick={() => setZoom(value => Math.max(.5, +(value - .1).toFixed(1)))} aria-label={t('缩小画布', 'Zoom out')}>−</button><output>{Math.round(zoom * 100)}%</output><button type="button" onClick={() => setZoom(value => Math.min(1.5, +(value + .1).toFixed(1)))} aria-label={t('放大画布', 'Zoom in')}>+</button><button type="button" onClick={() => setZoom(1)}>{t('重置', 'Reset')}</button></div></div>
    <div className="official-canvas-scroll" tabIndex={0} aria-label={t('工作流画布，可横向滚动并选择节点', 'Workflow canvas; scroll horizontally and select nodes')}><div style={{ width: width * zoom, height: height * zoom }}><div className="official-canvas-world" style={{ width, height, transform: `scale(${zoom})` }}>
      <svg className="official-wires" width={width} height={height} aria-hidden="true">{item.edges.map((edge, index) => {
        const a = position(edge.from); const b = position(edge.to);
        const lane = 16 + (index % 5) * 10;
        const path = b.x - a.x > 235
          ? `M${a.x + 196},${a.y + 43} H${a.x + 207} Q${a.x + 215},${a.y + 43} ${a.x + 215},${a.y + 35} V${lane + 8} Q${a.x + 215},${lane} ${a.x + 223},${lane} H${b.x - 20} Q${b.x - 12},${lane} ${b.x - 12},${lane + 8} V${b.y + 35} Q${b.x - 12},${b.y + 43} ${b.x - 4},${b.y + 43} H${b.x}`
          : `M${a.x + 196},${a.y + 43} C${a.x + 219},${a.y + 43} ${b.x - 22},${b.y + 43} ${b.x},${b.y + 43}`;
        return <g key={index} className={edge.from === active || edge.to === active ? 'active' : ''}><path d={path} /><circle cx={b.x} cy={b.y + 43} r="3" /></g>;
      })}</svg>
      {item.nodes.map((entry, index) => { const p = position(entry.id); return <button key={entry.id} type="button" className="official-graph-node" aria-pressed={active === entry.id} onClick={() => setActive(entry.id)} style={{ left: p.x, top: p.y }}><span>{String(index + 1).padStart(2, '0')}<small>{entry.role.toUpperCase()}</small></span><strong>{entry.title[locale]}</strong><i>{entry.output[locale]}</i></button>; })}
    </div></div></div>
    <div className="official-node-inspector" aria-live="polite"><div><span className="official-eyebrow">{t('节点职责', 'NODE INSTRUCTIONS')}</span><h4>{node.title[locale]}</h4><p>{node.task[locale]}</p><b>{t('交付物', 'Output')}</b><p>{node.output[locale]}</p></div><div><b>{t('验收条件', 'Acceptance criteria')}</b><ul>{node.acceptance.map((criterion, index) => <li key={index}><Check size={14} />{criterion[locale]}</li>)}</ul><b>{t('上下游交接', 'Dependency handoffs')}</b><ul>{item.edges.filter(edge => edge.to === node.id || edge.from === node.id).map((edge, index) => <li key={index}>{item.nodes.find(entry => entry.id === edge.from)?.title[locale]} → {item.nodes.find(entry => entry.id === edge.to)?.title[locale]}<br />{edge.label[locale]}</li>)}</ul></div></div>
  </div>;
}

function ReuseGuide({ item }: { item: OfficialWorkflow }) {
  const { locale, t } = useSaaSPreferences();
  const [downloadError, setDownloadError] = useState(false);
  const download = () => {
    let url: string | undefined;
    try {
      const document = createOfficialDocument(item, locale);
      url = URL.createObjectURL(new Blob([JSON.stringify(document, null, 2)], { type: 'application/json' }));
      const link = window.document.createElement('a'); link.href = url; link.download = `awwo-${item.id}.json`; window.document.body.append(link); link.click(); link.remove();
      const savedURL = url; window.setTimeout(() => URL.revokeObjectURL(savedURL), 1000);
      setDownloadError(false);
    } catch { if (url) URL.revokeObjectURL(url); setDownloadError(true); }
  };
  return <div className="official-guide"><div><h4>{t('把这一套，变成你的下一套。', 'Make this workflow your starting point.')}</h4><ol><li>{t('复制画布，保留所有节点、依赖和交付约定。', 'Copy the canvas with its nodes, dependencies and deliverable contracts.')}</li><li>{t('在节点的任务输入中替换目标、数据与约束。', 'Replace the goals, data and constraints in each node’s task input.')}</li><li>{t('使用工作区已配置的引擎初始化节点，确认模型后运行。', 'Initialize nodes with your workspace engine, confirm your models and run.')}</li><li>{t('核对验收节点的记录，再决定是否发布成果。', 'Check the review node’s evidence before publishing your results.')}</li></ol><button type="button" onClick={download}><ArrowDownToLine size={16} />{t('下载画布 JSON', 'Download canvas JSON')}</button>{downloadError && <p role="alert">{t('下载失败，请重试。', 'Download failed. Please retry.')}</p>}</div><div><h4>{t('输入目标', 'The brief')}</h4><p className="official-brief">{item.brief[locale]}</p><h4>{t('预期交付', 'Expected deliverables')}</h4><ul>{item.artifacts.map((artifact, i) => <li key={i}>{artifact[locale]}</li>)}</ul><p className="official-caption">{item.limitations[locale]}</p></div></div>;
}

export function PublicOfficialExamples() {
  const { t } = useSaaSPreferences();
  const initialId = new URLSearchParams(window.location.search).get('official') || undefined;
  return <main className="saas-dashboard official-public"><header><a href="/" className="saas-logo">AwwO</a><div className="official-public-nav"><a href="/">{t('进入工作区', 'Open workspace')}<ArrowUpRight size={14} /></a><PreferenceControls /></div></header><OfficialExamples initialId={initialId} standalone /></main>;
}
