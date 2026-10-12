// The canvas's 成果 view: its result shown large in the deliverable viewer, beside the steps that made it
// (each one openable), and the host's run receipt. Everything is read from the document as it stands;
// nothing here runs, publishes or edits on its own. A host opts in (the hosted app); the canvas stays as
// it is elsewhere.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, ArrowLeft, Box, Download, FileCode2, FileDown, FileText, Film, Image as ImageIcon, Loader2, Play, SquareArrowOutUpRight, X } from 'lucide-react';
import { caseRunLabel, type CanvasEdge, type CanvasNode, type ReviewGraphPolicy } from './canvasDoc';
import { canvasResult, deliveredItems, type DeliveredItem, type StepDelivery } from './canvasResultModel';
import { useCanvasI18n, type CanvasTextKey, type CanvasTranslate } from './i18n';
import { DeliverableMarkdown, NodeDeliverables } from './NodeDeliverables';
import type { RunNodeStatus } from './runGraph';
import { storedArtifactUrl } from '../saas/canvasBridge';
import { DeliverableStudio } from './studio/DeliverableStudio';
import { studioGroups, type StudioEntry } from './studio/studioModel';
import './canvas-results.css';

/** A notice the board would show (why a run did not start, what it is preparing): here, so it is seen. */
export interface CanvasResultsNotice { kind: 'status' | 'alert'; text: string; onDismiss?: () => void }

export interface CanvasResultsProps {
  nodes: ReadonlyArray<CanvasNode>;
  edges: ReadonlyArray<CanvasEdge>;
  execution?: ReviewGraphPolicy;
  runs: Readonly<Record<string, RunNodeStatus>>;
  running: boolean;
  readOnly: boolean;
  /** Why the canvas cannot run now; absent when it can. */
  runUnavailableReason?: string;
  onRun?: () => void;
  notice?: CanvasResultsNotice;
  /** Back to building, with this node open. */
  onOpenNode: (nodeId: string) => void;
  onBack: () => void;
  /** The host's record of the run behind the result. */
  receipt?: (final: CanvasNode | null) => ReactNode;
  /** Show the deliverables in the results studio (file tree, search, every file running or rendered) instead of the
   *  single-result viewer. The hosted app opts in. */
  studio?: boolean;
  /** Title of the studio (the canvas's name). */
  studioTitle?: string;
}

const RUN_STATE_KEY: Record<RunNodeStatus['state'], CanvasTextKey> = {
  waiting: 'results.stateWaiting', running: 'results.stateRunning', done: 'results.stateRun', failed: 'results.stateFailed',
  blocked: 'results.stateBlocked', cancelled: 'results.stateCancelled', cached: 'results.stateCached',
};
const DELIVERY_KEY: Record<StepDelivery['state'], CanvasTextKey> = {
  run: 'results.stateRun', partial: 'results.statePartial', manual: 'results.stateManual', case: 'results.stateCase', none: 'results.stateNone',
};

function deliveryAge(at: number, t: CanvasTranslate): string {
  if (!at || at < 1e12) return '';
  const minutes = Math.round(Math.max(0, Date.now() - at) / 60_000);
  const age = minutes < 1 ? t('time.justNow') : minutes < 60 ? t('time.minutesAgo', { count: minutes })
    : minutes < 1440 ? t('time.hoursAgo', { count: Math.round(minutes / 60) }) : t('time.daysAgo', { count: Math.round(minutes / 1440) });
  return t('deliverable.receivedAt', { age });
}

/** A step's chip: its live state while the canvas runs, otherwise what it has published. */
function stepChip(step: StepDelivery, runs: CanvasResultsProps['runs'], running: boolean, t: CanvasTranslate) {
  const live = running ? runs[step.node.id] : undefined;
  if (live) return { tone: live.state === 'done' ? 'run' : live.state === 'running' ? 'live' : live.state === 'failed' || live.state === 'blocked' ? 'failed' : 'idle', label: t(RUN_STATE_KEY[live.state]) };
  if (step.input) return { tone: 'idle', label: t('results.stateInput') };
  return { tone: step.state === 'run' ? 'run' : step.state === 'none' ? 'idle' : 'caveat', label: t(DELIVERY_KEY[step.state]) };
}

export function CanvasResults({ nodes, edges, execution, runs, running, readOnly, runUnavailableReason, onRun, notice, onOpenNode, onBack, receipt, studio = false, studioTitle }: CanvasResultsProps) {
  const { t } = useCanvasI18n();
  const result = useMemo(() => canvasResult({ nodes: [...nodes], edges: [...edges], execution }), [nodes, edges, execution]);
  // Every file of the canvas, so a step's page shows the pictures other nodes made for it (NodeDeliverables).
  const canvasEntries = useMemo(() => studioGroups({ nodes: [...nodes], edges: [...edges] }).flatMap(group => group.entries), [nodes, edges]);
  const steps = useMemo(() => result.stages.flat(), [result]);
  const items = useMemo(() => deliveredItems({ nodes: [...nodes], edges: [...edges], execution }), [nodes, edges, execution]);
  const [chosen, setChosen] = useState<string | null>(null);
  // The field picked from the index of everything made, shown first in that step's viewer. It belongs to its node:
  // once another step is shown (the node went away, or the final result changed), it applies to nothing.
  const [chosenField, setChosenField] = useState<{ nodeId: string; fieldId: string } | undefined>(undefined);
  const root = useRef<HTMLElement>(null);
  // 回到成果 and the review's link remove themselves; focus goes to the step now shown in the list.
  const show = (id: string | null) => {
    setChosen(id);
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active && active !== document.body && active.isConnected) return;
      root.current?.querySelector<HTMLElement>('.awwo-results-stage button[aria-pressed="true"]')?.focus();
    });
  };
  // A step that went away (deleted, or the canvas changed) falls back to the result.
  const selected = (chosen && steps.find(step => step.node.id === chosen)) || result.final;
  useEffect(() => { if (chosen && !steps.some(step => step.node.id === chosen)) setChosen(null); }, [chosen, steps]);
  const showingFinal = Boolean(selected && result.final && selected.node.id === result.final.node.id);
  const stageOf = (step: StepDelivery) => result.stages.findIndex(stage => stage.includes(step)) + 1;
  const tracked = Object.values(runs);
  const done = tracked.filter(item => item.state === 'done' || item.state === 'cached').length;
  const badge = t(result.complete ? 'results.finalBadge' : 'results.furthestBadge');
  const runButton = !readOnly && onRun ? <button type="button" className="awwo-results-run" disabled={running || Boolean(runUnavailableReason)}
    title={runUnavailableReason} onClick={onRun}><Play size={14} aria-hidden="true" />{t('results.run')}</button> : null;
  const useStudio = studio && items.length > 0;
  // What the studio's result is, said where it is seen: a copied case's recording, a failed run's capture, unfinished steps.
  const caveat = useStudio && result.final ? [
    result.final.state === 'case' && result.final.output ? `${t('deliverable.fromCase', { run: caseRunLabel(result.final.output) })} · ${t('deliverable.case')}` : '',
    result.final.state === 'partial' ? t('results.statePartial') : '',
    result.pending.length ? t('results.pendingSteps', { count: result.pending.length }) : '',
  ].filter(Boolean).join(' · ') : '';

  return <section ref={root} className={`awwo-results${useStudio ? ' is-studio' : ''}`} aria-label={t('results.region')}>
    {notice && <p className={`awwo-results-notice is-${notice.kind}`} role={notice.kind}>
      {notice.kind === 'status' && <Loader2 size={15} aria-hidden="true" />}<span>{notice.text}</span>
      {notice.onDismiss && <button type="button" aria-label={t('results.dismiss')} onClick={notice.onDismiss}><X size={14} aria-hidden="true" /></button>}
    </p>}
    {running && <p className="awwo-results-running" role="status"><Loader2 size={15} aria-hidden="true" />
      <span>{t('results.running', { done, total: tracked.length || steps.length })}</span><small>{t('results.runningHint')}</small></p>}
    <div className={`awwo-results-layout${useStudio ? ' is-studio' : ''}`}>
      {useStudio ? <div className="awwo-results-main is-studio">
        {caveat ? <p className="awwo-results-studio-caveat" role="note"><AlertTriangle size={14} aria-hidden="true" /><span>{caveat}</span>{runButton}</p> : null}
        <DeliverableStudio variant="embedded" nodes={nodes} edges={edges} execution={execution} title={studioTitle || t('results.indexTitle')}
          focusNodeId={chosen ?? undefined} onOpenNode={onOpenNode} />
      </div> : <div className="awwo-results-main">
        {items.length > 0 && <DeliveredIndex items={items} activeNodeId={chosen ?? result.final?.node.id}
          activeFieldId={chosenField && chosenField.nodeId === (chosen ?? result.final?.node.id) ? chosenField.fieldId : undefined} onOpen={item => {
          setChosenField(item.fieldId ? { nodeId: item.nodeId, fieldId: item.fieldId } : undefined);
          show(result.final && item.nodeId === result.final.node.id ? null : item.nodeId);
        }} />}
        {selected ? <SelectedStep step={selected} final={showingFinal} complete={result.complete} pending={showingFinal ? result.pending.length : 0} canvasEntries={canvasEntries}
          stage={stageOf(selected)} total={result.stages.length} onBackToResult={result.final && !showingFinal ? () => { setChosenField(undefined); show(null); } : undefined}
          onOpenNode={() => onOpenNode(selected.node.id)} fieldId={chosenField && chosenField.nodeId === selected.node.id ? chosenField.fieldId : undefined} />
          : <div className="awwo-results-empty">
            <h2>{t('results.emptyTitle')}</h2>
            <p>{t(readOnly ? 'results.emptyReadOnly' : 'results.emptyBody')}</p>
            {runUnavailableReason && !readOnly && <p className="awwo-results-reason">{runUnavailableReason}</p>}
            <div className="awwo-results-actions">{runButton}
              <button type="button" className="awwo-results-secondary" onClick={onBack}><ArrowLeft size={14} aria-hidden="true" />{t('results.backToCanvas')}</button>
            </div>
          </div>}
        {showingFinal && result.review && <ReviewNote step={result.review} onOpen={() => show(result.review!.node.id)} />}
      </div>}
      <aside className="awwo-results-aside" aria-label={t('results.stagesTitle')}>
        <section className="awwo-results-stages">
          <h3>{t('results.stagesTitle')}</h3>
          <p className="awwo-results-hint">{t('results.stagesHint')}</p>
          {/* The steps are a real sequence, so they are numbered; steps that run side by side share a number. */}
          <ol>{result.stages.map((stage, index) => <li key={index} className="awwo-results-stage">
            <span className="awwo-results-stage-number" aria-hidden="true">{index + 1}</span>
            <ul aria-label={t('results.stepNumber', { step: index + 1 })}>{stage.map(step => {
              const chip = stepChip(step, runs, running, t);
              const isFinal = result.final?.node.id === step.node.id;
              const state = isFinal ? `${badge} · ${chip.label}` : chip.label;
              return <li key={step.node.id}>
                {/* The name keeps what the row shows: which step, whether it is the result, how it stands. */}
                <button type="button" aria-pressed={selected?.node.id === step.node.id} aria-label={t('results.openStepState', { title: step.node.title || '—', state })}
                  onClick={() => { setChosenField(undefined); setChosen(isFinal && !useStudio ? null : step.node.id); }}>
                  <span className="awwo-results-step-title">{step.node.title || '—'}</span>
                  {isFinal && <span className="awwo-results-final">{badge}</span>}
                  <span className={`awwo-results-chip is-${chip.tone}`}>{chip.label}</span>
                </button>
              </li>;
            })}</ul>
          </li>)}</ol>
        </section>
        {receipt?.(result.final?.node ?? null)}
      </aside>
    </div>
  </section>;
}

function SelectedStep({ step, final, complete, pending, stage, total, onBackToResult, onOpenNode, fieldId, canvasEntries }: {
  step: StepDelivery; final: boolean; complete: boolean; pending: number; stage: number; total: number; onBackToResult?: () => void; onOpenNode: () => void; fieldId?: string;
  canvasEntries?: ReadonlyArray<StudioEntry>;
}) {
  const { t } = useCanvasI18n();
  // A case recording is named with the model and day it ran, not when this canvas received it.
  const facts = [step.input ? t('results.stateInput') : step.output?.source === 'case' && !step.output.partial
    ? t('deliverable.fromCase', { run: caseRunLabel(step.output) }) : t(DELIVERY_KEY[step.state]),
    step.output && step.output.source !== 'case' ? deliveryAge(step.output.at, t) : '', t('results.stepOf', { step: stage, total })].filter(Boolean);
  // The result is called the canvas's only when it is complete and nothing after it is still owed; a copied
  // case's recording is called the case's.
  const label = final ? t(step.state === 'case' ? 'results.caseLabel' : complete ? 'results.finalLabel' : 'results.furthestLabel')
    : t(step.output ? 'results.stepLabel' : 'results.stepNumber', { step: stage });
  return <article className={`awwo-results-step${final ? ' is-final' : ''}`} aria-label={step.node.title || undefined}>
    <header className="awwo-results-head">
      <div>
        <p className="awwo-results-label">{label}</p>
        <h2>{step.node.title || '—'}</h2>
        <p className="awwo-results-facts">
          <span>{facts.join(' · ')}</span>
          {final && pending > 0 ? <span className="awwo-results-caveat">{t('results.pendingSteps', { count: pending })}</span> : null}
          {final && step.state === 'case' ? <span className="awwo-results-caveat">{t('deliverable.case')}</span> : null}
        </p>
      </div>
      <div className="awwo-results-head-actions">
        {onBackToResult && <button type="button" className="awwo-results-secondary" onClick={onBackToResult}><ArrowLeft size={14} aria-hidden="true" />{t('results.backToResult')}</button>}
        <button type="button" className="awwo-results-secondary" onClick={onOpenNode}><SquareArrowOutUpRight size={14} aria-hidden="true" />{t('results.openInCanvas')}</button>
      </div>
    </header>
    <div className="awwo-results-body">
      {step.node.kind === 'form' ? <section className="awwo-results-form" aria-label={t('results.inputFields')}>
        <h3>{t('results.inputFields')}</h3>
        {step.node.fields.some(field => field.value.trim()) ? <dl>{step.node.fields.filter(field => field.value.trim()).map(field => <div key={field.id}>
          <dt>{field.label || field.id}</dt><dd>{field.value}</dd></div>)}</dl> : <p>{t('results.inputEmpty')}</p>}
      </section>
        : step.output ? <NodeDeliverables key={`${step.node.id}:${step.output.at}:${fieldId ?? ''}`} node={step.node} readOnly presentation="result" initialFieldId={fieldId} canvasEntries={canvasEntries} />
          : <p className="awwo-results-nothing">{t('results.noStepDelivery')}</p>}
    </div>
  </article>;
}

/** An acceptance step's report on the result, said for what it is: an agent's check (never a person's
 *  sign-off), a hand publication, or an unfinished check whose leftover text is not a conclusion. */
function ReviewNote({ step, onOpen }: { step: StepDelivery; onOpen: () => void }) {
  const { t } = useCanvasI18n();
  const title = step.node.title || '—';
  const note = step.state === 'partial' ? 'results.reviewPartial' : step.state === 'manual' ? 'results.reviewManual'
    : step.state === 'case' ? 'results.reviewCase' : 'results.reviewNote';
  return <section className={`awwo-results-review${step.state === 'partial' ? ' is-partial' : ''}`} aria-label={t('results.reviewTitle')}>
    <header><h3>{t('results.reviewTitle')}</h3><p>{t(note, { title })}</p></header>
    {step.text && step.state !== 'partial' ? <div className="awwo-results-review-text"><DeliverableMarkdown>{step.text.length > 900 ? `${step.text.slice(0, 900)}…` : step.text}</DeliverableMarkdown></div> : null}
    <button type="button" className="awwo-results-link" onClick={onOpen}>{t('results.openStep', { title })}</button>
  </section>;
}


const ITEM_ICON = { page: FileCode2, file: FileDown, image: ImageIcon, video: Film, model: Box, document: FileText, missing: AlertTriangle } as const;
const ITEM_KIND: Record<DeliveredItem['kind'], CanvasTextKey> = {
  page: 'results.itemPage', file: 'results.itemFile', image: 'results.itemImage', video: 'results.itemVideo', model: 'results.itemModel',
  document: 'results.itemDocument', missing: 'results.itemMissing',
};

/** Everything the canvas made, at once: each page, file, picture, video, 3D model and document of every step, so
 *  nothing a run produced has to be found behind a step or a tab. Picking one opens it in the viewer below; a stored
 *  file also downloads from here. A file field that came back as a name with no file is listed as what it is. */
function DeliveredIndex({ items, activeNodeId, activeFieldId, onOpen }: {
  items: DeliveredItem[]; activeNodeId?: string; activeFieldId?: string; onOpen: (item: DeliveredItem) => void;
}) {
  const { t } = useCanvasI18n();
  const made = items.filter(item => item.kind !== 'missing' && item.kind !== 'document').length;
  return <section className="awwo-results-index" aria-label={t('results.indexTitle')}>
    <header><h3>{t('results.indexTitle')}</h3><p>{t('results.indexLead', { count: items.length, made })}</p></header>
    <ul>{items.map(item => {
      const Icon = ITEM_ICON[item.kind];
      const download = item.reference ? storedArtifactUrl(item.reference) : item.artifactId ? storedArtifactUrl(`awwo-file:${item.artifactId}`) : null;
      const active = item.nodeId === activeNodeId && (item.fieldId === undefined || item.fieldId === activeFieldId);
      return <li key={item.key} className={`is-${item.kind}${active ? ' is-active' : ''}`}>
        <button type="button" aria-pressed={active} onClick={() => onOpen(item)}
          aria-label={t('results.indexOpen', { title: item.label, step: item.nodeTitle, kind: t(ITEM_KIND[item.kind]) })}>
          <Icon size={16} aria-hidden="true" />
          <span className="awwo-results-index-text"><strong>{item.label}</strong><small>{item.nodeTitle}</small></span>
          <span className="awwo-results-index-kind">{t(ITEM_KIND[item.kind])}</span>
        </button>
        {download ? <a className="awwo-results-index-download" href={download} download={item.name || true} rel="noreferrer"
          aria-label={t('results.indexDownload', { title: item.label })} title={t('results.indexDownload', { title: item.label })}><Download size={14} aria-hidden="true" /></a> : null}
      </li>;
    })}</ul>
  </section>;
}
