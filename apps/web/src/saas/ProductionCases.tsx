import { lazy, Suspense, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Check, X } from 'lucide-react';
import { ASSEMBLY_ROLE, MEDIA_ROLE, PRODUCTION_CASES, PRODUCTION_KIND_LABELS, RECORDER_ROLE, type ProductionCase } from './productionCatalog';
import { PRODUCTION_RUN_SUMMARY } from './productionRuns';
import type { OfficialWorkflow } from './examples/officialWorkflows';
import { LazyBoundary } from './LazyBoundary';
import { reloadAfterSaving } from './staleBuild';
import './production-cases.css';

const ProductionShowcase = lazy(() => import('./ProductionShowcase'));

/** `compact` (the workspace homes) shows this many — one row — until expanded; the landing page shows every case. */
export const COMPACT_CASE_COUNT = 3;

const reducedMotion = () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const saveData = () => (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;
const quote = (text: string) => `“${text}”`;
const outside = (box: DOMRect, x: number, y: number) => x < box.left || x > box.right || y < box.top || y > box.bottom;

/** A muted loop. Its poster and source load once it nears the viewport (a poster ignores
 * preload="none", and the hosted site serves everything no-store) — at once when `eager`, as in a
 * dialog, which scrolls on its own; it plays only while half on screen and `active`, never under
 * reduced motion or data saver, where the poster stays. */
function Footage({ stem, active = true, label, eager = false }: { stem: string; active?: boolean; label?: string; eager?: boolean }) {
  const video = useRef<HTMLVideoElement>(null);
  const [near, setNear] = useState(() => eager || typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const element = video.current;
    if (near || !element) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); setNear(true); }
    }, { rootMargin: '400px 0px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, [near]);
  useEffect(() => {
    const element = video.current;
    if (!element || !near || !active || typeof IntersectionObserver === 'undefined' || reducedMotion() || saveData()) return;
    const observer = new IntersectionObserver(entries => {
      // The latest entry wins: a quick in-and-out must not leave a loop playing off screen.
      if (entries[entries.length - 1].isIntersecting) element.play().catch(() => { /* The poster stays when playback is refused. */ });
      else element.pause();
    }, { threshold: 0.5 });
    observer.observe(element);
    return () => { observer.disconnect(); element.pause(); };
  }, [stem, active, near]);
  return <video ref={video} src={near ? `/showcase/${stem}.mp4` : undefined} poster={near ? `/showcase/${stem}.jpg` : undefined} muted loop playsInline preload="none"
    {...label ? { 'aria-label': label } : { 'aria-hidden': true }} />;
}

/** What the cover footage is: a recording of the delivery, or an AI-generated illustration. */
function Label({ recording, id }: { recording?: boolean; id?: string }) {
  return <span id={id} className={`production-label${recording ? ' is-real' : ''}`}>{recording ? 'Recorded delivery' : 'Cover: AI illustration'}</span>;
}

/** Delivered only when the published run delivered it; otherwise it is still the brief's goal. */
function Deliverable({ item }: { item: ProductionCase }) {
  const delivered = PRODUCTION_RUN_SUMMARY[item.id]?.delivered === true;
  return <p className={`production-delivered${delivered ? ' is-done' : ''}`}>{delivered && <Check size={13} aria-hidden="true" />}
    <b>{delivered ? 'Delivered' : 'Deliverable'}</b><span>{item.deliverable}</span></p>;
}

function RunChip({ item }: { item: ProductionCase }) {
  const run = PRODUCTION_RUN_SUMMARY[item.id];
  if (!run) return null;
  const done = run.completed + (run.media?.completed ?? 0), total = run.total + (run.media?.total ?? 0);
  return <span className="production-run-chip">{`Real run · ${done}/${total} nodes done`}</span>;
}

function CaseCard({ item, active, onOpen }: { item: ProductionCase; active: boolean; onOpen: (item: ProductionCase, trigger: HTMLButtonElement) => void }) {
  const id = useId();
  return <li className={`production-card${item.recording ? ' is-real' : ''}`}>
    <div className="production-card-media"><Footage stem={item.footage} active={active} /><Label recording={item.recording} id={`${id}-label`} /><span className="production-kind">{PRODUCTION_KIND_LABELS[item.kind]}</span></div>
    <div className="production-card-copy">
      <h3><button type="button" className="production-card-open" aria-haspopup="dialog" aria-describedby={`${id}-label ${id}-brief`}
        onClick={event => onOpen(item, event.currentTarget)}>{item.title}</button></h3>
      <p id={`${id}-brief`} className="production-brief">{quote(item.brief)}</p>
      <ol role="list" className="production-team" aria-label="Agent team, by stage">
        {item.stages.map((stage, index) => <li key={index}>{stage.join(' · ')}</li>)}
      </ol>
      <div className="production-card-footer"><Deliverable item={item} /><RunChip item={item} /></div>
    </div>
  </li>;
}

function CaseDialog({ item, onClose, onReuse }: { item: ProductionCase; onClose: () => void; onReuse?: (workflow: OfficialWorkflow) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const pressedOutside = useRef(false);
  const titleId = useId();
  const still = reducedMotion() || saveData();
  // Layout timing: the dialog must close while it is still in the document, before the page behind it can take focus.
  useLayoutEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close(); }, []);
  // Media nodes and a flagship's assembly run no agent.
  const agents = item.stages.reduce((sum, stage) => sum + stage.filter(role => role !== MEDIA_ROLE && role !== ASSEMBLY_ROLE && role !== RECORDER_ROLE).length, 0);
  return <dialog ref={dialog} className="saas-native-dialog production-dialog" lang="en" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); onClose(); }}
    // Close only when both the press and the release land on the backdrop, outside the box: the dialog's own scrollbar
    // reports the dialog as its target too, and a text selection inside may be released outside.
    onMouseDown={event => { pressedOutside.current = event.target === event.currentTarget && outside(event.currentTarget.getBoundingClientRect(), event.clientX, event.clientY); }}
    onClick={event => {
      const backdrop = pressedOutside.current && event.target === event.currentTarget && outside(event.currentTarget.getBoundingClientRect(), event.clientX, event.clientY);
      pressedOutside.current = false;
      if (backdrop) onClose();
    }}>
    <div className="production-dialog-body">
      <header><div><span className="production-dialog-meta"><Label recording={item.recording} />{PRODUCTION_KIND_LABELS[item.kind]}</span><h2 id={titleId}>{item.title}</h2></div>
        <button type="button" className="production-close" onClick={onClose} aria-label="Close"><X size={18} aria-hidden="true" /></button></header>
      <div className="production-dialog-grid">
        <figure className="production-dialog-media">
          <video src={`/showcase/${item.footage}.mp4`} poster={`/showcase/${item.footage}.jpg`} muted loop playsInline autoPlay={!still} controls={still}
            aria-label={item.recording ? `${item.title}: the delivered interface, recorded` : `${item.title}: AI-generated illustration`} />
          <figcaption>{item.recording
            ? `Recorded: the page a real AwwO run delivered on ${PRODUCTION_RUN_SUMMARY[item.id]?.capturedOn ?? ''}, running as delivered and played by a script; try it yourself below, under “How it was made”.`
            : PRODUCTION_RUN_SUMMARY[item.id]
              ? 'Cover: AI illustration. This footage was made by an AI video model and only shows the direction; what an AwwO run actually delivered is below, under “How it was made”.'
              : 'Cover: AI illustration. This footage was made by an AI video model and only shows the direction.'}</figcaption>
        </figure>
        <ol role="list" className="production-steps">
          <li><span className="production-step">01</span><div><h3>Brief</h3><p className="production-brief">{quote(item.brief)}</p></div></li>
          <li><span className="production-step">02</span><div><h3>Agent team</h3>
            <p className="production-team-meta">{`${agents} agents · ${item.stages.length} stages`}</p>
            <ol role="list" className="production-stages">{item.stages.map((stage, index) => <li key={index}><b>{String(index + 1).padStart(2, '0')}</b>
              <div>{stage.map(value => <span key={value}>{value}</span>)}</div>{stage.length > 1 && <small>{`${stage.length} in parallel`}</small>}</li>)}</ol></div></li>
          <li><span className="production-step">03</span><div><h3>Delivery</h3><Deliverable item={item} /></div></li>
        </ol>
      </div>
      <LazyBoundary fallback={<p className="production-made-pending" role="alert">The run record could not be loaded.{' '}
        <button type="button" className="saas-link" onClick={() => void reloadAfterSaving()}>Reload the page</button></p>}>
        <Suspense fallback={<p className="production-made-pending" role="status">Loading the run record…</p>}>
          <ProductionShowcase item={item} onReuse={onReuse && (workflow => { onClose(); onReuse(workflow); })} />
        </Suspense>
      </LazyBoundary>
    </div>
  </dialog>;
}

export function ProductionCases({ compact = false, onReuse }: { compact?: boolean; onReuse?: (workflow: OfficialWorkflow) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [open, setOpen] = useState<ProductionCase | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();
  const listId = useId();
  const items = compact && !expanded ? PRODUCTION_CASES.slice(0, COMPACT_CASE_COUNT) : PRODUCTION_CASES;
  // Say every case ran only when every case has a published run.
  const ran = PRODUCTION_CASES.filter(item => PRODUCTION_RUN_SUMMARY[item.id]).length;
  const illustrated = PRODUCTION_CASES.some(item => !item.recording);
  const close = () => setOpen(null);
  // Back to the card that opened the case, once the dialog is gone and the page is no longer inert.
  useEffect(() => { if (!open && trigger.current?.isConnected) trigger.current.focus(); }, [open]);
  // The section reads in English in both interface languages, as the cases do (owner 2026-10-14).
  return <section className={`production-cases${compact ? ' is-compact' : ''}`} lang="en" aria-labelledby={titleId}>
    <div className="production-heading">
      <div><span className="production-eyebrow"><span />PRODUCTION CASES</span>
        <h2 id={titleId}>One brief, handed to a team of agents.</h2>
        <p>{ran === PRODUCTION_CASES.length
          ? 'Every case is a real AwwO canvas that actually ran: a one-line brief, a team of agents working in stages, and the deliverable. Open one to see what each agent actually handed over and how the canvas ran, step by step.'
          : `Every case is a real AwwO canvas: a one-line brief, a team of agents working in stages, and the deliverable. ${ran} of them have actually run in AwwO; open one to see what each agent handed over. The others show their run once it is published.`}</p>
        <p className="production-legend"><span><span className="production-label is-real">Real run</span>The canvas’s actual AwwO run and what it delivered</span>
          <span><Label recording />The cover is a screen recording of that delivery</span>
          {illustrated && <span><Label />Cover footage made by an AI video model, for illustration only</span>}</p></div>
      {compact && <button type="button" className="production-toggle" aria-expanded={expanded} aria-controls={listId} onClick={() => setExpanded(value => !value)}>
        {expanded ? 'Show fewer' : `See all ${PRODUCTION_CASES.length} cases`}</button>}
    </div>
    <ul role="list" id={listId} className="production-grid">{items.map(item => <CaseCard key={item.id} item={item} active={!open} onOpen={(value, button) => { trigger.current = button; setOpen(value); }} />)}</ul>
    {open && <CaseDialog item={open} onClose={close} onReuse={onReuse} />}
  </section>;
}
