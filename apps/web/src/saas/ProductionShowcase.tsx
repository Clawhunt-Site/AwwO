import { Fragment, useEffect, useId, useMemo, useState } from 'react';
import { ArrowDown, Check, CircleSlash, Copy, Maximize2, Minimize2, RotateCcw, TriangleAlert } from 'lucide-react';
import { useSaaSPreferences } from './preferences';
import type { UiLocale } from '../locale';
import { htmlDocumentSource, htmlPreviewDocument } from '../canvas/htmlDeliverable';
import { loadPreviewLibraries, NO_PREVIEW_SCRIPT_NEEDS, previewScriptNeeds } from '../canvas/previewLibraries';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { formatDuration, loadProductionMedia, loadProductionRun, type ProductionNodeStatus, type ProductionRunNode, type ProductionRunRecord } from './productionRuns';
import { showcasePage } from './examples/showcaseDocument';
import { buildLiveDocument, LIVE_PAGE_ALLOW, LIVE_PAGE_SANDBOX } from '../canvas/studio/liveDocument';
import { PRODUCTION_WORKFLOWS } from './productionWorkflows';
import { RECORDED_CASE_WORKFLOWS } from './recordedCanvases';
import type { OfficialWorkflow } from './examples/officialWorkflows';
import type { ProductionCase } from './productionCatalog';
import './production-made.css';

const ROLES: Readonly<Record<string, readonly [string, string]>> = {
  general: ['自定义 Agent', 'Custom agent'], frontend: ['前端开发', 'Front end'], backend: ['后端服务', 'Backend'],
  data: ['数据治理', 'Data'], users: ['用户系统', 'Identity'], materials: ['物料制作', 'Content'], review: ['交付验收', 'Review'],
};
const STATUS: Readonly<Record<ProductionNodeStatus, readonly [string, string]>> = {
  done: ['完成', 'Done'], failed: ['失败', 'Failed'], blocked: ['被阻断', 'Blocked'], cancelled: ['已停止', 'Stopped'], cached: ['沿用结果', 'Reused'],
};
function StatusChip({ status }: { status: ProductionNodeStatus }) {
  const { t } = useSaaSPreferences();
  const [zh, en] = STATUS[status];
  return <em className={`production-made-status is-${status}`}>{status === 'done' ? <Check size={11} aria-hidden="true" /> : status === 'failed' ? <TriangleAlert size={11} aria-hidden="true" /> : <CircleSlash size={11} aria-hidden="true" />}{t(zh, en)}</em>;
}

// Inert like the delivery reader (canvas/DeliverableMarkdown.tsx), but stricter: only http(s) links are
// links, and a path on the machine the run used (kept only as artifacts/<name>) is plain text.
const external = (href?: string) => /^https?:\/\//i.test(href || '');
const RECORD_MARKDOWN: Components = {
  img: ({ alt }) => <span>{alt || '🖼'}</span>,
  a: ({ node: _node, href, children, ...props }) => external(href) ? <a {...props} href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span title={href}>{children}</span>,
};
const renderRecordMarkdown = (source: string) => <ReactMarkdown remarkPlugins={[remarkGfm]} components={RECORD_MARKDOWN}>{source}</ReactMarkdown>;

/** A model-generated page runs only in an opaque sandbox, through the canvas's own preview sanitizer. A library AwwO
 * supplies (three.js r128) runs from its pinned copy, exactly as the 成果 preview runs it; other external scripts stay
 * blocked. A media case's page runs the way the canvas runs a page that shows generated media (studio/liveDocument.ts:
 * every element kept, so its <video> plays; opaque origin, injected policy, links stopped), with the files its run's
 * image and video nodes made as data: URLs in place of the `<node id>/<file>` paths it names (showcaseDocument.ts). */
function ResultFrame({ html, title, media }: { html: string; title: string; media: Readonly<Record<string, string>> }) {
  const { t } = useSaaSPreferences();
  const inline = Object.keys(media).length > 0;
  const needs = useMemo(() => { try { return previewScriptNeeds(htmlDocumentSource(html)); } catch { return NO_PREVIEW_SCRIPT_NEEDS; } }, [html]);
  // undefined while the pinned copy loads; null when none is needed or it could not be loaded (the page then runs without it).
  const [libraries, setLibraries] = useState<{ needs: typeof needs; code: ReadonlyMap<string, string> | null } | null>(null);
  useEffect(() => {
    if (inline || !needs.libraries.length) return;
    let live = true;
    loadPreviewLibraries(needs).then(code => { if (live) setLibraries({ needs, code }); }, () => { if (live) setLibraries({ needs, code: null }); });
    return () => { live = false; };
  }, [needs, inline]);
  const [built, setBuilt] = useState<{ html: string; media: Readonly<Record<string, string>>; document: string | null } | null>(null);
  useEffect(() => {
    if (!inline) return;
    let live = true;
    buildLiveDocument(showcasePage(html, media)).then(document => { if (live) setBuilt({ html, media, document }); }, () => { if (live) setBuilt({ html, media, document: null }); });
    return () => { live = false; };
  }, [html, media, inline]);
  const loading = inline ? built?.html !== html || built.media !== media : needs.libraries.length > 0 && libraries?.needs !== needs;
  const code = !inline && !loading && libraries?.code ? libraries.code : undefined;
  const source = useMemo(() => {
    if (loading) return undefined;
    if (inline) return built?.document ?? null;
    try { return htmlPreviewDocument(html, true, code); } catch { return null; }
  }, [html, loading, code, inline, built]);
  if (source === undefined) return <p className="production-made-empty" role="status">{t('正在载入成品…', 'Loading the result…')}</p>;
  if (!source) return <p className="production-made-empty">{t('成品过大，无法在这里预览。', 'The result is too large to preview here.')}</p>;
  return inline
    ? <iframe className="production-made-frame" title={title} sandbox={LIVE_PAGE_SANDBOX} allow={LIVE_PAGE_ALLOW} referrerPolicy="no-referrer" srcDoc={source} />
    : <iframe className="production-made-frame" title={title} sandbox="allow-scripts allow-pointer-lock" referrerPolicy="no-referrer" srcDoc={source} />;
}

const NO_MEDIA: Readonly<Record<string, string>> = {};

/** What the canvas's image and video nodes generated in the run, shown small beside the agents (they are not agents). */
function MediaStrip({ record, files }: { record: ProductionRunRecord; files: Readonly<Record<string, string>> | undefined }) {
  const { locale, t } = useSaaSPreferences();
  if (!record.media?.length) return null;
  return <section className="production-made-media" aria-label={t('媒体节点在这次运行里生成的素材', 'What the media nodes generated in this run')}>
    <span>{t(`媒体节点 · ${record.media.length} 个，和 Agent 同一次运行生成`, `${record.media.length} media nodes, generated in the same run`)}</span>
    <ul>{record.media.map(item => {
      const url = files?.[item.files[0] ?? ''];
      return <li key={item.id}>
        {url ? (item.kind === 'video' ? <video src={url} muted playsInline preload="metadata" aria-hidden="true" /> : <img src={url} alt="" />) : <i aria-hidden="true" />}
        <span>{item.title[locale]}</span><StatusChip status={item.status} />
      </li>;
    })}</ul>
  </section>;
}

function NodeOutput({ node }: { node: ProductionRunNode }) {
  const { t } = useSaaSPreferences();
  if (node.status !== 'done') return node.detail ? <p className="production-made-detail">{node.detail}</p> : null;
  if (node.outputType === 'fields') return <dl className="production-made-fields">{node.fields?.map(field => <Fragment key={field.id}><dt>{field.id}</dt><dd>{renderRecordMarkdown(field.value)}</dd></Fragment>)}</dl>;
  if (node.outputType === 'html') return <details className="production-made-source"><summary>{t(`查看页面源码（${(node.output || '').length.toLocaleString()} 字符）`, `View the page source (${(node.output || '').length.toLocaleString()} characters)`)}</summary><pre><code>{node.output}</code></pre></details>;
  return <div className="production-made-markdown">{renderRecordMarkdown(node.output || '')}</div>;
}

/** How a case was made: its canvas stage by stage, what every agent actually handed over, and the
 * delivered result. Everything shown comes from the run record; the workflow adds only each node's
 * written task and acceptance, which tests pin to the canvas that ran, or for a recorded canvas its
 * persona, read from the instructions file its agent loaded (production-canvases/). */
export default function ProductionShowcase({ item, onReuse }: { item: ProductionCase; onReuse?: (workflow: OfficialWorkflow) => void }) {
  const { locale, t } = useSaaSPreferences();
  const id = useId();
  const [record, setRecord] = useState<ProductionRunRecord | null | undefined>(undefined);
  const [selected, setSelected] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const [revision, setRevision] = useState(0);
  const workflow = PRODUCTION_WORKFLOWS[item.id] ?? RECORDED_CASE_WORKFLOWS[item.id];
  useEffect(() => {
    let live = true;
    loadProductionRun(item.id).then(value => { if (live) setRecord(value ?? null); }, () => { if (live) setRecord(null); });
    return () => { live = false; };
  }, [item.id]);
  // A media case's files load with it (one lazy chunk); undefined until they are here, {} when there are none.
  const [media, setMedia] = useState<{ id: string; files: Readonly<Record<string, string>> } | undefined>(undefined);
  const hasMedia = Boolean(record?.media?.length);
  useEffect(() => {
    if (!hasMedia) return;
    let live = true;
    loadProductionMedia(item.id).then(files => { if (live) setMedia({ id: item.id, files }); }, () => { if (live) setMedia({ id: item.id, files: {} }); });
    return () => { live = false; };
  }, [item.id, hasMedia]);
  const files = hasMedia ? (media?.id === item.id ? media.files : undefined) : NO_MEDIA;
  const reuse = onReuse && workflow && <button type="button" className="production-made-reuse" onClick={() => onReuse(workflow)}><Copy size={14} aria-hidden="true" />{t('复制这张画布', 'Copy this canvas')}</button>;
  if (!record) return <section className="production-made" aria-labelledby={`${id}-title`}>
    <header className="production-made-heading"><div><span className="production-eyebrow"><span />{t('它是怎么做出来的', 'HOW IT WAS MADE')}</span>
      <h3 id={`${id}-title`}>{record === undefined ? t('正在读取运行记录…', 'Loading the run record…') : t('这个案例还没有发布运行记录', 'No run record has been published for this case yet')}</h3></div>{reuse}</header>
  </section>;

  const stages = [...new Set(record.nodes.map(node => node.column))].sort((a, b) => a - b).map(column => record.nodes.filter(node => node.column === column).sort((a, b) => a.row - b.row));
  const deliveryNode = record.nodes.find(value => value.id === record.artifactNodeId);
  const artifact = deliveryNode?.status === 'done' && deliveryNode.outputType === 'html' && deliveryNode.output ? deliveryNode : undefined;
  const node = record.nodes.find(value => value.id === (selected ?? artifact?.id ?? record.nodes[0].id)) ?? record.nodes[0];
  const spec = workflow?.nodes.find(value => value.id === node.id);
  const title = (target: string) => record.nodes.find(value => value.id === target)?.title[locale] ?? target;
  const inputs = record.edges.filter(edge => edge.to === node.id), outputs = record.edges.filter(edge => edge.from === node.id);
  const translated = record.outputLocale !== locale;
  const role = spec ? ROLES[spec.role] : undefined;
  return <section className={`production-made${focused ? ' is-result-focused' : ''}`} aria-labelledby={`${id}-title`}>
    <header className="production-made-heading">
      <div><span className="production-eyebrow"><span />{t('它是怎么做出来的', 'HOW IT WAS MADE')}</span>
        <h3 id={`${id}-title`}>{t(`${record.total} 个 Agent，${stages.length} 个阶段，${formatDuration(record.seconds, 'zh')}跑完`, `${record.total} agents, ${stages.length} stages, ${formatDuration(record.seconds, 'en')} end to end`)}</h3>
        <p className="production-made-receipt"><span className="production-label is-real">{t('真实运行', 'Real run')}</span>
          <span>{record.model}</span><span>{record.capturedOn}</span><span>{t(`${record.completed}/${record.total} 个节点完成`, `${record.completed}/${record.total} nodes done`)}</span></p></div>
      {reuse}
    </header>
    {translated && <p className="production-made-language">{t(`Agent 用${record.outputLocale === 'en' ? '英文' : '中文'}完成了这次运行，内容按原样显示。`, `The agents worked in ${record.outputLocale === 'zh' ? 'Chinese' : 'English'}; their outputs are shown as delivered.`)}</p>}
    <div className="production-made-grid">
      <div className="production-made-process" hidden={focused}>
        <MediaStrip record={record} files={files} />
        <ol className="production-made-stages" aria-label={t('按阶段查看每个 Agent', 'Every agent, stage by stage')}>
          {stages.map((group, index) => <li key={group[0].column}>
            <span className="production-made-stage">{String(index + 1).padStart(2, '0')}{group.length > 1 && <small>{t(`${group.length} 路并行`, `${group.length} in parallel`)}</small>}</span>
            <div>{group.map(value => <button type="button" key={value.id} aria-pressed={value.id === node.id} aria-controls={`${id}-node`} onClick={() => setSelected(value.id)}>
              <span>{value.title[locale]}</span><StatusChip status={value.status} />{value.seconds !== undefined && <small>{formatDuration(value.seconds, locale)}</small>}
            </button>)}</div>
          </li>)}
        </ol>
        <article className="production-made-node" id={`${id}-node`}>
          <header><h4>{node.title[locale]}</h4>{role && <span>{t(role[0], role[1])}</span>}<StatusChip status={node.status} /></header>
          {spec && <p className="production-made-task">{spec.task[locale].split('\n')[0]}</p>}
          {spec && <p className="production-made-handoff"><ArrowDown size={13} aria-hidden="true" />{spec.output[locale]}</p>}
          {inputs.length > 0 && <div className="production-made-links"><span>{t('收到', 'RECEIVED')}</span>{inputs.map(edge => <button type="button" key={edge.from + edge.to} onClick={() => setSelected(edge.from)}>{title(edge.from)} · {edge.label[locale]}</button>)}</div>}
          {outputs.length > 0 && <div className="production-made-links"><span>{t('交给', 'HANDED TO')}</span>{outputs.map(edge => <button type="button" key={edge.from + edge.to} onClick={() => setSelected(edge.to)}>{title(edge.to)}</button>)}</div>}
          {spec && spec.acceptance.length > 0 && <p className="production-made-acceptance"><b>{t('验收标准', 'Acceptance')}</b>{spec.acceptance.map(value => value[locale]).join('；')}</p>}
          <div className="production-made-output"><span>{t('这个 Agent 实际交付的内容', 'What this agent actually delivered')}</span><NodeOutput node={node} /></div>
        </article>
      </div>
      <div className="production-made-result">
        <header><span>{artifact ? t('交付的成品 · 在沙箱里运行', 'The delivered result · runs in a sandbox') : t('交付成果', 'Delivery')}</span>
          {artifact && <div><button type="button" onClick={() => setRevision(value => value + 1)} aria-label={t('重新载入成品', 'Reload the result')} title={t('重新载入成品', 'Reload the result')}><RotateCcw size={14} aria-hidden="true" /></button>
            <button type="button" aria-pressed={focused} onClick={() => setFocused(value => !value)}>{focused ? <Minimize2 size={14} aria-hidden="true" /> : <Maximize2 size={14} aria-hidden="true" />}{t('专注成品', 'Focus the result')}</button></div>}</header>
        {artifact?.output ? (files ? <Fragment key={revision}><ResultFrame html={artifact.output} media={files} title={t(`${item.title.zh}：AwwO 运行交付的成品`, `${item.title.en}: the result an AwwO run delivered`)} /></Fragment>
          : <p className="production-made-empty" role="status">{t('正在载入成品…', 'Loading the result…')}</p>)
          : <p className="production-made-empty">{item.recording && deliveryNode?.status === 'done' ? t('这个案例交付的是一个多文件应用，封面就是它的录屏；各个 Agent 交付的契约与说明见左侧。', 'This case delivered a multi-file app; the cover is a recording of it, and each agent’s contracts and notes are on the left.')
            : t('这次运行没有交付成品，失败与被阻断的节点见左侧。', 'This run did not deliver the result; the failed and blocked nodes are on the left.')}</p>}
        {artifact && <p className="production-made-hint">{t('点一下画面，再用键盘操作。成品由模型生成，原样运行，未经人工修改。', 'Click the page, then use the keyboard. The result is model-generated and runs as delivered, without manual edits.')}</p>}
      </div>
    </div>
    <footer className="production-made-notes">
      <p><b>{t('运行情况', 'What happened')}</b>{record.note[locale]}</p>
      <p><b>{t('发布前核对', 'Checked before publishing')}</b>{record.verification[locale]}</p>
      <details><summary>{t('运行回执', 'Run receipt')}</summary><dl>
        <dt>{t('运行环境', 'Environment')}</dt><dd>{record.edition[locale]}</dd>
        <dt>{t('执行器与模型', 'Runtime and model')}</dt><dd>{record.runtime} · {record.model}</dd>
        {record.limits && <><dt>{t('执行设置', 'Execution settings')}</dt><dd>{t(`每个节点调用 ${record.limits.modelCallsPerNode} 次模型${record.limits.thinking ? '' : '、关闭思考'}，最多输出 ${record.limits.maxOutputTokens} token，上下文 ${record.limits.contextWindow} token，同时最多 ${record.limits.concurrency} 个节点`, `${record.limits.modelCallsPerNode} model call per node${record.limits.thinking ? '' : ' with thinking off'}, at most ${record.limits.maxOutputTokens} output tokens, ${record.limits.contextWindow}-token context, up to ${record.limits.concurrency} nodes at a time`)}</dd></>}
        {record.source && <><dt>{t('版本', 'Release')}</dt><dd>API {record.source.api} · {t('执行器', 'runtime')} {record.source.worker}</dd></>}
        {record.artifactSHA256 && <><dt>{t('成品校验', 'Result checksum')}</dt><dd><code>SHA-256 {record.artifactSHA256}</code></dd></>}
      </dl></details>
    </footer>
  </section>;
}
