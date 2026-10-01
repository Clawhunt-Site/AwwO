import { lazy, Suspense, useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { ArrowDownToLine, ArrowUpRight, Check, ChevronLeft, Copy, GitBranch, Play, Workflow } from 'lucide-react';
import { useSaaSPreferences, PreferenceControls } from '../preferences';
import { OFFICIAL_WORKFLOWS, createOfficialDocument, getOfficialWorkflow, type OfficialWorkflow } from './officialWorkflows';
import type { UiLocale } from '../../locale';
import { rememberOfficialSelection, officialSignInURL } from './officialSelection';
import { CREATIVE_CASE_IDS, INTELLIGENCE_CASE_IDS, OPERATIONS_CASE_IDS } from './advanced/catalog';
import { AdvancedCover } from './advanced/AdvancedCover';
import { OFFICIAL_CATEGORY_LABELS, workflowShape } from './advanced/industryWorkflow';
import './official-examples.css';
import { OfficialShowcase } from './OfficialShowcase';
import { OFFICIAL_GENERATED_RECORDS } from './generatedRecords';
const GeneratedOfficialDemo = lazy(() => import('./GeneratedOfficialDemo'));

const InteractionDemo = lazy(() => import('./CreativeDemos').then(module => ({ default: module.InteractionDemo })));
const GameDemo = lazy(() => import('./CreativeDemos').then(module => ({ default: module.GameDemo })));
const SceneDemo = lazy(() => import('./CreativeDemos').then(module => ({ default: module.SceneDemo })));
const KnowledgeDemo = lazy(() => import('./IntelligenceDemos').then(module => ({ default: module.KnowledgeDemo })));
const TrainingDemo = lazy(() => import('./IntelligenceDemos').then(module => ({ default: module.TrainingDemo })));
const OperationsDemo = lazy(() => import('./IntelligenceDemos').then(module => ({ default: module.OperationsDemo })));

const AdvancedCreativeDemo = lazy(() => import('./advanced/AdvancedCreativeDemos').then(module => ({ default: module.AdvancedCreativeDemo })));
const AdvancedIntelligenceDemo = lazy(() => import('./advanced/AdvancedIntelligenceDemos').then(module => ({ default: module.AdvancedIntelligenceDemo })));
const AdvancedOperationsDemo = lazy(() => import('./advanced/AdvancedOperationsDemos').then(module => ({ default: module.AdvancedOperationsDemo })));

function Demo({ id, locale }: { id: string; locale: UiLocale }) {
  if (CREATIVE_CASE_IDS.has(id)) return <AdvancedCreativeDemo key={id} id={id} locale={locale} />;
  if (INTELLIGENCE_CASE_IDS.has(id)) return <AdvancedIntelligenceDemo key={id} id={id} locale={locale} />;
  if (OPERATIONS_CASE_IDS.has(id)) return <AdvancedOperationsDemo key={id} id={id} locale={locale} />;
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
  const flagshipCount = OFFICIAL_WORKFLOWS.filter(example => example.tier === 'flagship').length;
  const [tier, setTier] = useState<'flagship' | 'starter' | 'all'>(() => getOfficialWorkflow(initialId || '') && getOfficialWorkflow(initialId || '')?.tier !== 'flagship' ? 'starter' : flagshipCount ? 'flagship' : 'starter');
  const [category, setCategory] = useState('all');
  const [industry, setIndustry] = useState('all');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(() => getOfficialWorkflow(initialId || '')?.id ?? (standalone ? 'grid-balance' : null));
  const [tab, setTab] = useState<'demo' | 'workflow' | 'guide'>('demo');
  const detail = useRef<HTMLDivElement>(null);
  const firstFilter = useRef<HTMLButtonElement>(null);
  const selectedTrigger = useRef<HTMLButtonElement | null>(null);
  const shouldFocus = useRef(Boolean(getOfficialWorkflow(initialId || '')) || standalone);
  const titleId = useId();
  const tabsId = useId();
  const item = selected ? getOfficialWorkflow(selected) : undefined;
  const record = item ? OFFICIAL_GENERATED_RECORDS[item.id] : undefined;
  useEffect(() => {
    if (selected && shouldFocus.current) {
      detail.current?.focus({ preventScroll: true });
      detail.current?.scrollIntoView?.({ behavior: 'instant', block: 'start' });
      shouldFocus.current = false;
    }
  }, [selected]);
  const open = (example: OfficialWorkflow, trigger: HTMLButtonElement) => {
    selectedTrigger.current = trigger;
    if (selected === example.id) {
      detail.current?.focus({ preventScroll: true });
      detail.current?.scrollIntoView?.({ behavior: 'instant', block: 'start' });
    } else {
      shouldFocus.current = true;
    }
    setTab('demo');
    setSelected(example.id);
  };
  const close = () => { setSelected(null); (selectedTrigger.current?.isConnected ? selectedTrigger.current : firstFilter.current)?.focus(); };
  const Heading = standalone ? 'h1' : 'h2';
  const inTier = (example: OfficialWorkflow) => tier === 'all' || (example.tier || 'starter') === tier;
  const industries = Array.from(new Map(OFFICIAL_WORKFLOWS.filter(inTier).filter(example => example.industry).map(example => [example.industry!.en, example.industry!])).entries());
  const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  const filtered = OFFICIAL_WORKFLOWS.filter(example => inTier(example) && (category === 'all' || example.category === category)
    && (industry === 'all' || example.industry?.en === industry)
    && terms.every(term => [example.id, example.title.zh, example.title.en, example.summary[locale], example.industry?.[locale], ...(example.capabilities || []).map(value => value[locale])].join(' ').toLocaleLowerCase().includes(term)));
  const resetFilters = () => { setCategory('all'); setIndustry('all'); setQuery(''); };
  const selectTier = (value: 'flagship' | 'starter' | 'all') => { setTier(value); resetFilters(); };
  const allNodes = OFFICIAL_WORKFLOWS.reduce((sum, example) => sum + example.nodes.length, 0);
  const allIndustries = new Set(OFFICIAL_WORKFLOWS.filter(example => example.industry).map(example => example.industry!.en)).size;

  const tabItems = [
    { id: 'demo' as const, label: t('同屏体验', 'Workflow + result'), icon: Play },
    { id: 'workflow' as const, label: t('编排画布', 'Workflow canvas'), icon: Workflow },
    { id: 'guide' as const, label: t('复用指南', 'Build your version'), icon: Copy },
  ];
  return <section className="official-examples" aria-labelledby={titleId} id="official-examples">
    <div className="official-heading">
      <div><span className="official-eyebrow"><span />AWWO ORIGINALS / INDUSTRY SYSTEMS</span><Heading id={titleId}>{t('看它如何构建，亲手操作结果。', 'See the workflow. Work with the result.')}</Heading><p>{t('左边拆解编排过程，右边直接体验成果。从游戏与三维空间，到知识、模型与行业中台。', 'Explore the orchestration on the left, interact with the result on the right. From games and 3D worlds to knowledge, models and industry systems.')}</p></div>
      <span className="official-edition">{t('官方工作流参考', 'OFFICIAL WORKFLOW LIBRARY')}<b>VOL. 003</b></span>
    </div>
    <div className="official-collection-summary"><span><b>{flagshipCount}</b>{t('行业旗舰', 'industry systems')}</span><span><b>{allIndustries}</b>{t('行业场景', 'industry scenarios')}</span><span><b>{allNodes}</b>{t('编排节点', 'workflow nodes')}</span><p>{t('数据关联 · 真实算法 · 异常处置 · 多阶段交付', 'Linked data · Working algorithms · Exception handling · Staged delivery')}</p></div>
    <div className="showcase-featured" role="group" aria-label={t('精选同屏案例', 'Featured split-screen examples')}><span>{t('精选演示', 'FEATURED')}</span>{['commerce-ops', 'colony-command', 'habitat-twin', 'research-atlas', 'model-foundry', 'interaction-page'].map(id => { const example = getOfficialWorkflow(id)!; return <button key={id} type="button" aria-pressed={selected === id} onClick={event => open(example, event.currentTarget)}><b>{example.title[locale].split(/ \/ | · /)[0]}</b>{example.categoryLabel[locale]}</button>; })}</div>
    <div className="showcase-featured showcase-generated-picks" role="group" aria-label={t('模型生成实例', 'Model-generated examples')}><span>{t('已实测模型产物', 'BROWSER-CHECKED MODEL OUTPUT')}</span>{Object.keys(OFFICIAL_GENERATED_RECORDS).map(id => { const example = getOfficialWorkflow(id)!; return <button key={id} type="button" aria-pressed={selected === id} onClick={event => open(example, event.currentTarget)}><b>{example.title[locale].split(/ \/ | · /)[0]}</b>{t('运行过程 + 成果', 'Run + result')}<ArrowUpRight size={12} /></button>; })}</div>
    {item && <div key={item.id} className="official-detail" ref={detail} tabIndex={-1} aria-label={item.title[locale]} style={{ '--case-accent': item.accent } as CSSProperties}>
      <div className="official-detail-heading"><button type="button" onClick={close} className="official-back"><ChevronLeft size={16} />{t('收起作品', 'Close example')}</button><a className="official-permalink" href={`${officialSignInURL(item.id, window.location.search)}&examples=1`}>{t('独立打开此案例', 'Open this example directly')} ↗</a></div>
      <div className="official-detail-title"><div><h3>{item.title[locale]}</h3><p>{item.description[locale]}</p></div>
        {onReuse ? <button type="button" className="official-primary" disabled={disabled || readOnly} onClick={() => onReuse(item)}><Copy size={16} />{disabled ? t('正在创建…', 'Creating…') : t('复制到我的画布', 'Copy to my canvases')}</button>
          : !readOnly && <a className="official-primary" href={officialSignInURL(item.id, window.location.search)} onClick={() => rememberOfficialSelection(item.id)}><Copy size={16} />{t('登录并复用', 'Sign in to reuse')}</a>}
      </div>
      {item.tier === 'flagship' && <details className="official-case-scope"><summary>{t('业务能力与数据范围', 'Capabilities and data scope')}<span>{item.capabilities?.length} {t('项能力', 'capabilities')} · {item.datasets?.length} {t('组数据', 'data groups')}</span></summary><div className="official-scope-grid"><div><span className="official-eyebrow">{t('场景能力', 'SCENARIO CAPABILITIES')}</span><div>{item.capabilities?.map((value, index) => <span key={index}>{value[locale]}</span>)}</div></div><div><span className="official-eyebrow">{t('数据与约束', 'DATA AND CONSTRAINTS')}</span><ul>{item.datasets?.map((value, index) => <li key={index}>{value[locale]}</li>)}</ul></div></div></details>}

      {readOnly && <p className="official-caption">{t('你可以体验和下载工作流。复制到工作区需要编辑权限。', 'You can explore and download this workflow. Copying into a workspace requires edit access.')}</p>}
      {error && <p className="saas-error" role="alert">{error}</p>}
      <div className="official-tabs" role="tablist" aria-label={t('案例内容', 'Example content')}>
        {tabItems.map(({ id, label, icon: Icon }, index) => <button key={id} id={`${tabsId}-${id}`} type="button" role="tab" aria-selected={tab === id} aria-controls={`${tabsId}-panel`} tabIndex={tab === id ? 0 : -1} onClick={() => setTab(id)} onKeyDown={event => {
          const next = event.key === 'ArrowRight' ? (index + 1) % 3 : event.key === 'ArrowLeft' ? (index + 2) % 3 : event.key === 'Home' ? 0 : event.key === 'End' ? 2 : null;
          if (next === null) return; event.preventDefault(); setTab(tabItems[next].id); document.getElementById(`${tabsId}-${tabItems[next].id}`)?.focus();
        }}><Icon size={15} />{label}</button>)}
      </div>
      <div id={`${tabsId}-panel`} role="tabpanel" aria-labelledby={`${tabsId}-${tab}`} tabIndex={0}>
        <div hidden={tab !== 'demo'}><OfficialShowcase item={item} record={record} visible={tab === 'demo'} onOpenWorkflow={() => setTab('workflow')}><Suspense fallback={<p className="official-loading" role="status">{t('正在载入作品…', 'Loading demo…')}</p>}><>{record ? <GeneratedOfficialDemo id={item.id} title={t(`${item.title.zh} · 模型生成成果`, `${item.title.en} · Model-generated result`)} /> : <Demo id={item.id} locale={locale} />}</></Suspense></OfficialShowcase><p className="official-caption">{record ? record.note[locale] : item.limitations[locale]}</p></div>
        {tab === 'workflow' && <WorkflowInspector item={item} />}
        {tab === 'guide' && <ReuseGuide item={item} />}
      </div>
      <p className="official-provenance">{record ? t('此案例展示已实测的模型节点成果与脱敏运行快照；验收修订另行标注。复制画布仍会创建未执行草稿，不会复制历史结果或触发模型调用。', 'This case shows browser-checked model output and a sanitized run snapshot; QA revisions are labeled. Copying the canvas creates an unexecuted draft; it does not copy run history or trigger model calls.') : t('官方设计的参考实现与编排模板。复制后是未执行的草稿；选择模型并运行后，才会产生你自己的交付物。', 'Officially authored reference implementations and workflow templates. A copy is an unexecuted draft. Choose your models and run it to create your own deliverables.')}</p>
    </div>}
    <div className="official-discovery">
      <div className="official-tiers" role="group" aria-label={t('案例深度', 'Example depth')}>
        <button type="button" aria-pressed={tier === 'flagship'} onClick={() => selectTier('flagship')}>{t('行业旗舰', 'Industry systems')}<span>{flagshipCount}</span></button>
        <button type="button" aria-pressed={tier === 'starter'} onClick={() => selectTier('starter')}>{t('基础练习', 'Starter studies')}<span>{OFFICIAL_WORKFLOWS.length - flagshipCount}</span></button>
        <button type="button" aria-pressed={tier === 'all'} onClick={() => selectTier('all')}>{t('全部案例', 'All examples')}<span>{OFFICIAL_WORKFLOWS.length}</span></button>
      </div>
      <div className="official-search-controls"><input type="search" aria-label={t('搜索案例', 'Search examples')} placeholder={t('搜索行业、场景或能力', 'Search industry, scenario or capability')} value={query} onChange={event => setQuery(event.target.value)} /><select aria-label={t('行业筛选', 'Filter by industry')} value={industry} onChange={event => setIndustry(event.target.value)}><option value="all">{t('全部行业', 'All industries')}</option>{industries.map(([key, label]) => <option value={key} key={key}>{label[locale]}</option>)}</select></div>
    </div>
    <div className="official-filters" role="group" aria-label={t('官方案例分类', 'Official example categories')}>
      <button ref={firstFilter} type="button" aria-pressed={category === 'all'} onClick={() => setCategory('all')}>{t('全部能力', 'All capabilities')}</button>
      {Object.entries(OFFICIAL_CATEGORY_LABELS).map(([key, label]) => <button type="button" key={key} aria-pressed={category === key} onClick={() => setCategory(key)}>{label[locale]}<span>{OFFICIAL_WORKFLOWS.filter(example => inTier(example) && example.category === key).length}</span></button>)}
    </div>
    <div className="official-result-count" aria-live="polite">{t(`当前显示 ${filtered.length} 个案例`, `Showing ${filtered.length} examples`)}{(query || industry !== 'all' || category !== 'all') && <button type="button" onClick={resetFilters}>{t('清除筛选', 'Clear filters')}</button>}</div>
    <div className="official-cards">
      {filtered.map((example) => <article key={example.id} className="official-card" style={{ '--case-accent': example.accent } as CSSProperties}>
        <button type="button" className="official-card-open" onClick={event => open(example, event.currentTarget)} aria-label={t(`查看官方案例：${example.title.zh}`, `Open official example: ${example.title.en}`)} aria-expanded={selected === example.id}>
          {example.tier === 'flagship' ? <AdvancedCover item={example} /> : <CaseCover category={example.category} />}
          <div className="official-card-copy"><div className="official-card-meta"><span>{example.industry?.[locale] || example.categoryLabel[locale]}</span><span><GitBranch size={12} />{example.nodes.length} {t('节点', 'nodes')} · {example.edges.length} {t('依赖', 'handoffs')}</span></div><h3>{example.title[locale]}<ArrowUpRight size={19} /></h3><p>{example.summary[locale]}</p>{example.capabilities && <div className="official-card-capabilities">{example.capabilities.slice(0, 3).map((value, index) => <span key={index}>{value[locale]}</span>)}</div>}<div className="official-card-footer"><span>{example.tier === 'flagship' ? t(`${workflowShape(example).stages} 个编排阶段 · ${workflowShape(example).merges} 处交付汇合`, `${workflowShape(example).stages} stages · ${workflowShape(example).merges} result merges`) : example.pattern[locale]}</span><strong>{t('进入案例', 'Explore')} ↗</strong></div></div>
        </button>
      </article>)}
    </div>
    {filtered.length === 0 && <div className="official-empty"><h3>{t('没有找到匹配案例', 'No matching examples')}</h3><p>{t('换一个关键词，或清除行业和能力筛选。', 'Try another keyword or clear the industry and capability filters.')}</p><button type="button" onClick={resetFilters}>{t('重新浏览', 'Browse again')}</button></div>}
    <div className="official-library-note"><Workflow size={17} /><p>{t('每张画布包含真实依赖、输入输出和验收要求。行业旗舰展示完整本地业务闭环；接入生产数据与服务需要独立实施。', 'Every canvas includes real dependencies, contracts and acceptance criteria. Industry systems demonstrate complete local scenarios; production data and service integrations require separate implementation.')}</p></div>
  </section>;
}

export function WorkflowInspector({ item }: { item: OfficialWorkflow }) {
  const { locale, t } = useSaaSPreferences();
  const [active, setActive] = useState(item.nodes[0].id);
  const [zoom, setZoom] = useState(1);
  const [chainOnly, setChainOnly] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const node = item.nodes.find(value => value.id === active) || item.nodes[0];
  const shape = workflowShape(item);
  const width = (Math.max(...item.nodes.map(value => value.column)) + 1) * 235 + 40;
  const minRow = Math.min(...item.nodes.map(value => value.row));
  const maxRow = Math.max(...item.nodes.map(value => value.row));
  const height = (maxRow - minRow + 1) * 142 + 110;
  const position = (id: string) => { const value = item.nodes.find(entry => entry.id === id)!; return { x: 22 + value.column * 235, y: 94 + (value.row - minRow) * 142 }; };
  const related = new Set([active]);
  for (const direction of ['parents', 'children'] as const) {
    const visited = new Set<string>([active]); const queue = [active];
    while (queue.length) {
      const current = queue.shift()!;
      const adjacent = item.edges.filter(edge => direction === 'parents' ? edge.to === current : edge.from === current)
        .map(edge => direction === 'parents' ? edge.from : edge.to);
      for (const id of adjacent) if (!visited.has(id)) { visited.add(id); related.add(id); queue.push(id); }
    }
  }
  const select = (id: string, pan = false) => {
    setActive(id);
    if (pan && viewport.current) {
      const p = position(id);
      viewport.current.scrollTo?.({ left: Math.max(0, (p.x + 98) * zoom - viewport.current.clientWidth / 2), top: Math.max(0, p.y * zoom - 80), behavior: 'instant' });
    }
  };
  const fit = () => { if (viewport.current?.clientWidth) { setZoom(Math.min(1, Math.max(.15, Math.floor((viewport.current.clientWidth - 24) / width * 100) / 100))); viewport.current.scrollTo?.(0, 0); } };
  return <div className="official-workflow">
    <div className="official-workflow-shape"><span><b>{shape.stages}</b>{t('编排阶段', 'stages')}</span><span><b>{shape.parallel}</b>{t('同阶段分工', 'parallel roles')}</span><span><b>{shape.merges}</b>{t('依赖汇合', 'result merges')}</span><span><b>{shape.reviews}</b>{t('验收节点', 'review nodes')}</span></div>
    <div className="official-graph-explorer">
      <nav className="official-node-directory" aria-label={t('节点目录', 'Node directory')}><p>{t('选择节点，沿交付链查看', 'EXPLORE THE HANDOFFS')}</p>{item.nodes.map((entry, index) => <button type="button" key={entry.id} aria-current={active === entry.id ? 'step' : undefined} onClick={() => select(entry.id, true)}><span>{String(index + 1).padStart(2, '0')}</span><div><strong>{entry.title[locale]}</strong><small>{entry.role.toUpperCase()} / {t('阶段', 'STAGE')} {entry.column + 1}</small></div></button>)}</nav>
      <div className="official-graph-area"><div className="official-canvas-toolbar"><span><GitBranch size={15} />{item.nodes.length} {t('节点', 'nodes')} / {item.edges.length} {t('依赖', 'dependencies')}</span><div><label className="official-chain-toggle"><input type="checkbox" checked={chainOnly} onChange={event => setChainOnly(event.target.checked)} />{t('突出依赖链', 'Focus dependency chain')}</label><button type="button" onClick={() => setZoom(value => Math.max(.15, +(value - .1).toFixed(2)))} aria-label={t('缩小画布', 'Zoom out')}>−</button><output>{Math.round(zoom * 100)}%</output><button type="button" onClick={() => setZoom(value => Math.min(1.5, +(value + .1).toFixed(2)))} aria-label={t('放大画布', 'Zoom in')}>+</button><button type="button" onClick={fit}>{t('总览', 'Fit')}</button><button type="button" onClick={() => setZoom(1)}>{t('原比例', '100%')}</button></div></div>
      <div ref={viewport} className="official-canvas-scroll" tabIndex={0} aria-label={t('工作流画布，可横向滚动并选择节点', 'Workflow canvas; scroll horizontally and select nodes')}><div style={{ width: width * zoom, height: height * zoom }}><div className="official-canvas-world" style={{ width, height, transform: `scale(${zoom})` }}>
        <svg className="official-wires" width={width} height={height} aria-hidden="true">{item.edges.map((edge, index) => {
          const a = position(edge.from); const b = position(edge.to);
          const lane = 14 + (index % 8) * 9;
          const path = b.x - a.x > 235
            ? `M${a.x + 196},${a.y + 43} H${a.x + 207} Q${a.x + 215},${a.y + 43} ${a.x + 215},${a.y + 35} V${lane + 8} Q${a.x + 215},${lane} ${a.x + 223},${lane} H${b.x - 20} Q${b.x - 12},${lane} ${b.x - 12},${lane + 8} V${b.y + 35} Q${b.x - 12},${b.y + 43} ${b.x - 4},${b.y + 43} H${b.x}`
            : `M${a.x + 196},${a.y + 43} C${a.x + 219},${a.y + 43} ${b.x - 22},${b.y + 43} ${b.x},${b.y + 43}`;
          const connected = related.has(edge.from) && related.has(edge.to);
          return <g key={`${edge.from}-${edge.to}`} className={chainOnly ? connected ? 'active' : 'unrelated' : edge.from === active || edge.to === active ? 'active' : ''}><path d={path} /><circle cx={b.x} cy={b.y + 43} r="3" /></g>;
        })}</svg>
        {item.nodes.map((entry, index) => { const p = position(entry.id); return <button key={entry.id} type="button" className={`official-graph-node${chainOnly && !related.has(entry.id) ? ' unrelated' : ''}`} aria-pressed={active === entry.id} onClick={() => select(entry.id)} style={{ left: p.x, top: p.y }}><span>{String(index + 1).padStart(2, '0')}<small>{entry.role.toUpperCase()}</small></span><strong>{entry.title[locale]}</strong><i>{entry.output[locale]}</i></button>; })}
      </div></div></div></div>
    </div>
    <div className="official-node-inspector" aria-live="polite"><div><span className="official-eyebrow">{t('节点职责', 'NODE INSTRUCTIONS')}</span><h4>{node.title[locale]}</h4><p>{node.task[locale]}</p><b>{t('交付物', 'Output')}</b><p>{node.output[locale]}</p></div><div><b>{t('验收条件', 'Acceptance criteria')}</b><ul>{node.acceptance.map((criterion, index) => <li key={index}><Check size={14} />{criterion[locale]}</li>)}</ul><b>{t('上下游交接', 'Dependency handoffs')}</b><div className="official-node-paths">{item.edges.filter(edge => edge.to === node.id || edge.from === node.id).map((edge) => <button type="button" key={`${edge.from}-${edge.to}`} onClick={() => select(edge.to === node.id ? edge.from : edge.to, true)}>{item.nodes.find(entry => entry.id === edge.from)?.title[locale]} → {item.nodes.find(entry => entry.id === edge.to)?.title[locale]}<br />{edge.label[locale]}</button>)}</div></div></div>
  </div>;
}

function ReuseGuide({ item }: { item: OfficialWorkflow }) {
  const record = OFFICIAL_GENERATED_RECORDS[item.id];
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
  return <div className="official-guide"><div><h4>{t('把这一套，变成你的下一套。', 'Make this workflow your starting point.')}</h4><ol><li>{t('复制画布，保留所有节点、依赖和交付约定。', 'Copy the canvas with its nodes, dependencies and deliverable contracts.')}</li><li>{t('在节点的任务输入中替换目标、数据与约束。', 'Replace the goals, data and constraints in each node’s task input.')}</li><li>{t('使用工作区已配置的引擎初始化节点，确认模型后运行。', 'Initialize nodes with your workspace engine, confirm your models and run.')}</li><li>{t('核对验收节点的记录，再决定是否发布成果。', 'Check the review node’s evidence before publishing your results.')}</li></ol><button type="button" onClick={download}><ArrowDownToLine size={16} />{t('下载画布 JSON', 'Download canvas JSON')}</button>{downloadError && <p role="alert">{t('下载失败，请重试。', 'Download failed. Please retry.')}</p>}</div><div><h4>{t('输入目标', 'The brief')}</h4><p className="official-brief">{item.brief[locale]}</p><h4>{t('预期交付', 'Expected deliverables')}</h4><ul>{item.artifacts.map((artifact, i) => <li key={i}>{artifact[locale]}</li>)}</ul><p className="official-caption">{record ? record.note[locale] : item.limitations[locale]}</p></div></div>;
}

export function PublicOfficialExamples() {
  const { t } = useSaaSPreferences();
  const initialId = new URLSearchParams(window.location.search).get('official') || undefined;
  return <main className="saas-dashboard official-public"><header><a href="/" className="saas-logo">AwwO</a><div className="official-public-nav"><a href="/">{t('进入工作区', 'Open workspace')}<ArrowUpRight size={14} /></a><PreferenceControls /></div></header><OfficialExamples initialId={initialId} standalone /></main>;
}
