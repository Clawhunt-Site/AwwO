import { Fragment, lazy, Suspense, useEffect, useId, useMemo, useState } from 'react';
import { ArrowDown, Copy, Maximize2, Minimize2, RotateCcw } from 'lucide-react';
import { htmlDocumentSource, htmlPreviewDocument } from '../canvas/htmlDeliverable';
import { loadPreviewLibraries, NO_PREVIEW_SCRIPT_NEEDS, previewScriptNeeds } from '../canvas/previewLibraries';
import { formatDuration, loadProductionMedia, loadProductionRun, type ProductionRunRecord } from './productionRuns';
import { showcasePage } from './examples/showcaseDocument';
import { PRODUCTION_WORKFLOWS } from './productionWorkflows';
import type { OfficialWorkflow } from './examples/officialWorkflows';
import type { ProductionCase } from './productionCatalog';
import { NodeOutput, NodeWork, StatusChip } from './productionMadeParts';
import './production-made.css';

// A recorded-canvas case (a film) has its own dialog, which loads with the first such case opened.
const ProductionFilm = lazy(() => import('./ProductionFilm'));

// The case dialog reads in English in both interface languages, as the cases do (owner 2026-10-14).
const ROLES: Readonly<Record<string, string>> = {
  general: 'Custom agent', frontend: 'Front end', backend: 'Backend', data: 'Data', users: 'Identity', materials: 'Content', review: 'Review',
};

/** A model-generated page runs only in an opaque sandbox, through the canvas's own preview sanitizer. A library AwwO
 * supplies (three.js r128) runs from its pinned copy, exactly as the Results preview runs it; other external scripts stay
 * blocked. A media case's page runs the way the canvas runs a page that shows generated media (studio/liveDocument.ts:
 * every element kept, so its <video> plays; opaque origin, injected policy, links stopped), with the files its run's
 * image, video and 3D model nodes made (published as static files, fetched when the case opens) as data: URLs in place
 * of the `<node id>/<file>` paths it names (showcaseDocument.ts). */
function ResultFrame({ html, title, media }: { html: string; title: string; media: Readonly<Record<string, string>> }) {
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
  const [built, setBuilt] = useState<{ html: string; media: Readonly<Record<string, string>>; document: string | null; sandbox: string; allow: string } | null>(null);
  useEffect(() => {
    if (!inline) return;
    let live = true;
    // The live-page builder loads with the first media case opened, not with the homepage.
    import('../canvas/studio/liveDocument').then(async module => {
      const document = await module.buildLiveDocument(showcasePage(html, media)).catch(() => null);
      if (live) setBuilt({ html, media, document, sandbox: module.LIVE_PAGE_SANDBOX, allow: module.LIVE_PAGE_ALLOW });
    }, () => { if (live) setBuilt({ html, media, document: null, sandbox: '', allow: '' }); });
    return () => { live = false; };
  }, [html, media, inline]);
  const loading = inline ? built?.html !== html || built.media !== media : needs.libraries.length > 0 && libraries?.needs !== needs;
  const code = !inline && !loading && libraries?.code ? libraries.code : undefined;
  const source = useMemo(() => {
    if (loading) return undefined;
    if (inline) return built?.document ?? null;
    try { return htmlPreviewDocument(html, true, code); } catch { return null; }
  }, [html, loading, code, inline, built]);
  if (source === undefined) return <p className="production-made-empty" role="status">Loading the result…</p>;
  if (!source) return <p className="production-made-empty">The result is too large to preview here.</p>;
  return inline
    ? <iframe className="production-made-frame" title={title} sandbox={built!.sandbox} allow={built!.allow} referrerPolicy="no-referrer" srcDoc={source} />
    : <iframe className="production-made-frame" title={title} sandbox="allow-scripts allow-pointer-lock" referrerPolicy="no-referrer" srcDoc={source} />;
}

const NO_MEDIA: Readonly<Record<string, string>> = {};

/** What the canvas's image, video and 3D model nodes generated in the run, shown small beside the agents (they are not
 * agents); a 3D model by its rendered preview picture. */
function MediaStrip({ record, files, stage }: { record: ProductionRunRecord; files: Readonly<Record<string, string>> | undefined; stage?: string }) {
  if (!record.media?.length) return null;
  const count = record.media.length;
  const made = `${count} media ${count === 1 ? 'node' : 'nodes'}, generated in the same run`;
  return <section className="production-made-media" aria-label="What the media nodes generated in this run">
    <span>{stage ? `Stage ${stage} · ${made}` : made}</span>
    <ul>{record.media.map(item => {
      const shown = item.kind === 'model3d' ? item.files.find(file => /\.(?:png|jpe?g|webp)$/i.test(file)) : item.files[0];
      const url = files?.[shown ?? ''];
      return <li key={item.id}>
        {url ? (item.kind === 'video' ? <video src={url} muted playsInline preload="metadata" aria-hidden="true" /> : <img src={url} alt="" />) : <i aria-hidden="true" />}
        <span>{item.title}</span><StatusChip status={item.status} />
      </li>;
    })}</ul>
  </section>;
}

/** How a case was made: its canvas stage by stage, what every agent actually handed over, and the
 * delivered result. Everything shown comes from the run record; the workflow adds only each node's
 * written task and acceptance, which tests pin to the canvas that ran. */
export default function ProductionShowcase({ item, onReuse, onCopyRecorded }: { item: ProductionCase; onReuse?: (workflow: OfficialWorkflow) => void;
  /** Copy a recorded-canvas case (a film), whose canvas is stored beside its record rather than defined as a workflow. */
  onCopyRecorded?: (item: ProductionCase) => void }) {
  const id = useId();
  const [record, setRecord] = useState<ProductionRunRecord | null | undefined>(undefined);
  const [selected, setSelected] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const [revision, setRevision] = useState(0);
  const workflow = PRODUCTION_WORKFLOWS[item.id];
  useEffect(() => {
    let live = true;
    loadProductionRun(item.id).then(value => { if (live) setRecord(value ?? null); }, () => { if (live) setRecord(null); });
    return () => { live = false; };
  }, [item.id]);
  // A media case's files load with it; undefined until they are here, {} when there are none. A load that failed (a file
  // missing, short or too slow) shows no page at all, with a way to try again: never a page without the files it uses.
  const [media, setMedia] = useState<{ id: string; files?: Readonly<Record<string, string>> } | undefined>(undefined);
  const [mediaAttempt, setMediaAttempt] = useState(0);
  // A film's dialog streams its files from their URLs instead (ProductionFilm.tsx): nothing is fetched whole here.
  const hasMedia = Boolean(record?.media?.length) && record?.canvas !== 'recorded';
  useEffect(() => {
    if (!hasMedia) return;
    let live = true;
    loadProductionMedia(item.id).then(files => { if (live) setMedia({ id: item.id, files }); }, () => { if (live) setMedia({ id: item.id }); });
    return () => { live = false; };
  }, [item.id, hasMedia, mediaAttempt]);
  const files = hasMedia ? (media?.id === item.id ? media.files : undefined) : NO_MEDIA;
  const mediaFailed = hasMedia && media?.id === item.id && !media.files;
  const retryMedia = () => { setMedia(undefined); setMediaAttempt(value => value + 1); };
  const reuse = onReuse && workflow && <button type="button" className="production-made-reuse" onClick={() => onReuse(workflow)}><Copy size={14} aria-hidden="true" />Copy this canvas</button>;
  if (!record) return <section className="production-made" lang="en" aria-labelledby={`${id}-title`}>
    <header className="production-made-heading"><div><span className="production-eyebrow"><span />HOW IT WAS MADE</span>
      <h3 id={`${id}-title`}>{record === undefined ? 'Loading the run record…' : 'No run record has been published for this case yet'}</h3></div>{reuse}</header>
  </section>;
  if (record.canvas === 'recorded') return <Suspense fallback={<section className="production-made" lang="en"><p className="production-made-empty" role="status">Loading the run record…</p></section>}>
    {/* Keyed by the case, so which file is playing, the frame decoded from it and a carried-over moment belong to that
        case and cannot survive into another one. No path reaches a second case without closing this dialog today; the
        key is what keeps that true if one is ever added. */}
    <ProductionFilm key={item.id} item={item} record={record} onCopy={onCopyRecorded ? () => onCopyRecorded(item) : undefined} />
  </Suspense>;

  const stages = [...new Set(record.nodes.map(node => node.column))].sort((a, b) => a - b).map(column => record.nodes.filter(node => node.column === column).sort((a, b) => a.row - b.row));
  // A media node's stage is where its canvas placed it, so the run's stages are counted and numbered over agents and
  // media alike (as the team above shows them), and its nodes include the media nodes.
  const mediaColumns = [...new Set((record.media ?? []).flatMap(value => workflow?.media?.find(spec => spec.id === value.id)?.column ?? []))].sort((a, b) => a - b);
  const columns = [...new Set([...stages.map(group => group[0].column), ...mediaColumns])].sort((a, b) => a - b);
  const stageLabel = (column: number) => String(columns.indexOf(column) + 1).padStart(2, '0');
  const nodesDone = record.completed + (record.media ?? []).filter(value => value.status === 'done').length, nodeCount = record.total + (record.media?.length ?? 0);
  const deliveryNode = record.nodes.find(value => value.id === record.artifactNodeId);
  const artifact = deliveryNode?.status === 'done' && deliveryNode.outputType === 'html' && deliveryNode.output ? deliveryNode : undefined;
  const node = record.nodes.find(value => value.id === (selected ?? artifact?.id ?? record.nodes[0].id)) ?? record.nodes[0];
  const spec = workflow?.nodes.find(value => value.id === node.id);
  const title = (target: string) => record.nodes.find(value => value.id === target)?.title ?? target;
  const inputs = record.edges.filter(edge => edge.to === node.id), outputs = record.edges.filter(edge => edge.from === node.id);
  const role = spec ? ROLES[spec.role] : undefined;
  return <section className={`production-made${focused ? ' is-result-focused' : ''}`} lang="en" aria-labelledby={`${id}-title`}>
    <header className="production-made-heading">
      <div><span className="production-eyebrow"><span />HOW IT WAS MADE</span>
        <h3 id={`${id}-title`}>{`${record.nodes.filter(value => value.kind !== 'assemble').length} agents, ${columns.length} stages, ${record.runs && record.activeSeconds !== undefined
          ? `${formatDuration(record.activeSeconds, 'en')} in ${record.runs} runs` : `${formatDuration(record.seconds, 'en')} end to end`}`}</h3>
        <p className="production-made-receipt"><span className="production-label is-real">Real run</span>
          <span>{record.model}</span><span>{record.capturedOn}</span><span>{`${nodesDone}/${nodeCount} nodes done`}</span></p></div>
      {reuse}
    </header>
    <div className="production-made-grid">
      <div className="production-made-process" hidden={focused}>
        <MediaStrip record={record} files={files} stage={mediaColumns.map(stageLabel).join(', ') || undefined} />
        <ol className="production-made-stages" aria-label="Every agent, stage by stage">
          {stages.map(group => <li key={group[0].column}>
            <span className="production-made-stage">{stageLabel(group[0].column)}{group.length > 1 && <small>{`${group.length} in parallel`}</small>}</span>
            <div>{group.map(value => <button type="button" key={value.id} aria-pressed={value.id === node.id} aria-controls={`${id}-node`} onClick={() => setSelected(value.id)}>
              <span>{value.title}</span><StatusChip status={value.status} />{value.seconds !== undefined && <small>{formatDuration(value.seconds, 'en')}</small>}
            </button>)}</div>
          </li>)}
        </ol>
        <article className="production-made-node" id={`${id}-node`}>
          <header><h4>{node.title}</h4>{role && <span>{role}</span>}<StatusChip status={node.status} /></header>
          {spec && <p className="production-made-task">{spec.task.split('\n')[0]}</p>}
          <NodeWork node={node} />
          {spec && <p className="production-made-handoff"><ArrowDown size={13} aria-hidden="true" />{spec.output}</p>}
          {inputs.length > 0 && <div className="production-made-links"><span>RECEIVED</span>{inputs.map(edge => <button type="button" key={edge.from + edge.to} onClick={() => setSelected(edge.from)}>{title(edge.from)} · {edge.label}</button>)}</div>}
          {outputs.length > 0 && <div className="production-made-links"><span>HANDED TO</span>{outputs.map(edge => <button type="button" key={edge.from + edge.to} onClick={() => setSelected(edge.to)}>{title(edge.to)}</button>)}</div>}
          {spec && spec.acceptance.length > 0 && <p className="production-made-acceptance"><b>Acceptance</b>{spec.acceptance.join('; ')}</p>}
          <div className="production-made-output"><span>What this agent actually delivered</span><NodeOutput node={node} /></div>
        </article>
      </div>
      <div className="production-made-result">
        <header><span>{artifact ? 'The delivered result · runs in a sandbox' : 'Delivery'}</span>
          {artifact && <div><button type="button" onClick={() => { setRevision(value => value + 1); if (mediaFailed) retryMedia(); }} aria-label="Reload the result" title="Reload the result"><RotateCcw size={14} aria-hidden="true" /></button>
            <button type="button" aria-pressed={focused} onClick={() => setFocused(value => !value)}>{focused ? <Minimize2 size={14} aria-hidden="true" /> : <Maximize2 size={14} aria-hidden="true" />}Focus the result</button></div>}</header>
        {artifact?.output ? (files ? <Fragment key={revision}><ResultFrame html={artifact.output} media={files} title={`${item.title}: the result an AwwO run delivered`} /></Fragment>
          : mediaFailed ? <p className="production-made-empty" role="alert">The pictures, clips or models this page uses could not be loaded, so it is not shown without them.
            <button type="button" onClick={retryMedia}>Try again</button></p>
          : <p className="production-made-empty" role="status">Loading the result…</p>)
          : <p className="production-made-empty">This run did not deliver the result; the failed and blocked nodes are on the left.</p>}
        {artifact && <p className="production-made-hint">Click the page, then use the keyboard. The result is model-generated and runs as delivered, without manual edits.</p>}
      </div>
    </div>
    <footer className="production-made-notes">
      <p><b>What happened</b>{record.note}</p>
      <p><b>Checked before publishing</b>{record.verification}</p>
      <details><summary>Run receipt</summary><dl>
        <dt>Environment</dt><dd>{record.edition}</dd>
        <dt>Runtime and model</dt><dd>{record.runtime} · {record.model}</dd>
        <dt>Execution settings</dt><dd>{`${record.limits.modelCallsPerNode === 1 ? '1 model call' : `up to ${record.limits.modelCallsPerNode} model calls`} per node${record.limits.thinking ? '' : ' with thinking off'}, at most ${record.limits.maxOutputTokens} output tokens, ${record.limits.contextWindow}-token context, up to ${record.limits.concurrency} nodes at a time`}</dd>
        <dt>Release</dt><dd>{record.source.runs && record.source.runs.length > 1
          ? record.source.runs.map(entry => `API ${entry.api.slice(0, 12)} · runtime ${entry.worker.slice(0, 12)} (${entry.nodes.map(title).join(', ')})`).join('; then ')
          : `API ${record.source.api} · runtime ${record.source.worker}`}</dd>
        {record.runs && record.activeSeconds !== undefined && <><dt>Time</dt><dd>{`${record.runs} runs took ${formatDuration(record.activeSeconds, 'en')}, ${formatDuration(record.seconds, 'en')} from the first start to the last finish`}</dd></>}
        {record.artifactSHA256 && <><dt>Result checksum</dt><dd><code>SHA-256 {record.artifactSHA256}</code></dd></>}
      </dl></details>
    </footer>
  </section>;
}
