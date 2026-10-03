import { lazy, Suspense, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Check, X } from 'lucide-react';
import { useSaaSPreferences } from './preferences';
import type { UiLocale } from '../locale';
import { PRODUCTION_CASES, PRODUCTION_KIND_LABELS, type ProductionCase } from './productionCatalog';
import { PRODUCTION_RUN_SUMMARY } from './productionRuns';
import type { OfficialWorkflow } from './examples/officialWorkflows';
import { LazyBoundary } from './LazyBoundary';
import './production-cases.css';

const ProductionShowcase = lazy(() => import('./ProductionShowcase'));

/** `compact` (the workspace homes) shows this many — one row — until expanded; the landing page shows every case. */
export const COMPACT_CASE_COUNT = 3;

const reducedMotion = () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const saveData = () => (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;
const footageOf = (item: ProductionCase, locale: UiLocale) => locale === 'en' && item.footageEn ? item.footageEn : item.footage;
const quote = (text: string, locale: UiLocale) => locale === 'zh' ? `「${text}」` : `“${text}”`;
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
  const { t } = useSaaSPreferences();
  return <span id={id} className={`production-label${recording ? ' is-real' : ''}`}>{recording ? t('交付录屏', 'Recorded delivery') : t('封面示意 · AI 生成', 'Cover: AI illustration')}</span>;
}

/** Delivered only when the published run delivered it; otherwise it is still the brief's goal. */
function Deliverable({ item }: { item: ProductionCase }) {
  const { locale, t } = useSaaSPreferences();
  const delivered = PRODUCTION_RUN_SUMMARY[item.id]?.delivered === true;
  return <p className={`production-delivered${delivered ? ' is-done' : ''}`}>{delivered && <Check size={13} aria-hidden="true" />}
    <b>{delivered ? t('已交付', 'Delivered') : t('交付目标', 'Deliverable')}</b><span>{item.deliverable[locale]}</span></p>;
}

function RunChip({ item }: { item: ProductionCase }) {
  const { t } = useSaaSPreferences();
  const run = PRODUCTION_RUN_SUMMARY[item.id];
  if (!run) return null;
  return <span className="production-run-chip">{t(`真实运行 · ${run.completed}/${run.total} 节点完成`, `Real run · ${run.completed}/${run.total} nodes done`)}</span>;
}

function CaseCard({ item, active, onOpen }: { item: ProductionCase; active: boolean; onOpen: (item: ProductionCase, trigger: HTMLButtonElement) => void }) {
  const { locale, t } = useSaaSPreferences();
  const id = useId();
  const translated = locale === 'en' && item.footageEn !== undefined;
  return <li className={`production-card${item.recording ? ' is-real' : ''}`}>
    <div className="production-card-media"><Footage stem={footageOf(item, locale)} active={active} /><Label recording={item.recording} id={`${id}-label`} /><span className="production-kind">{PRODUCTION_KIND_LABELS[item.kind][locale]}</span>
      {translated && <span id={`${id}-translated`} className="production-translated">UI translated from Chinese</span>}</div>
    <div className="production-card-copy">
      <h3><button type="button" className="production-card-open" aria-haspopup="dialog" aria-describedby={[`${id}-label`, translated && `${id}-translated`, `${id}-brief`].filter(Boolean).join(' ')}
        onClick={event => onOpen(item, event.currentTarget)}>{item.title[locale]}</button></h3>
      <p id={`${id}-brief`} className="production-brief">{quote(item.brief[locale], locale)}</p>
      <ol role="list" className="production-team" aria-label={t('Agent 团队，按阶段', 'Agent team, by stage')}>
        {item.stages.map((stage, index) => <li key={index}>{stage.map(value => value[locale]).join(' · ')}</li>)}
      </ol>
      <div className="production-card-footer"><Deliverable item={item} /><RunChip item={item} /></div>
    </div>
  </li>;
}

function CaseDialog({ item, onClose, onReuse }: { item: ProductionCase; onClose: () => void; onReuse?: (workflow: OfficialWorkflow) => void }) {
  const { locale, t } = useSaaSPreferences();
  const dialog = useRef<HTMLDialogElement>(null);
  const pressedOutside = useRef(false);
  const titleId = useId();
  const still = reducedMotion() || saveData();
  // Layout timing: the dialog must close while it is still in the document, before the page behind it can take focus.
  useLayoutEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close(); }, []);
  const agents = item.stages.reduce((sum, stage) => sum + stage.length, 0);
  return <dialog ref={dialog} className="saas-native-dialog production-dialog" aria-labelledby={titleId}
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
      <header><div><span className="production-dialog-meta"><Label recording={item.recording} />{PRODUCTION_KIND_LABELS[item.kind][locale]}</span><h2 id={titleId}>{item.title[locale]}</h2></div>
        <button type="button" className="production-close" onClick={onClose} aria-label={t('关闭', 'Close')}><X size={18} aria-hidden="true" /></button></header>
      <div className="production-dialog-grid">
        <figure className="production-dialog-media">
          <video src={`/showcase/${footageOf(item, locale)}.mp4`} poster={`/showcase/${footageOf(item, locale)}.jpg`} muted loop playsInline autoPlay={!still} controls={still}
            aria-label={item.recording ? t(`${item.title.zh}：交付界面实录`, `${item.title.en}: the delivered interface, recorded`) : t(`${item.title.zh}：AI 生成的示意画面`, `${item.title.en}: AI-generated illustration`)} />
          <figcaption>{item.recording
            ? t('界面实录：2026-09-04 一次 AwwO 真实运行交付的知识库工作台（演示模式，使用模拟数据）。', 'Recorded: the knowledge-base workspace a real AwwO run delivered on 2026-09-04, in its demo mode with simulated data. UI translated from Chinese.')
            : PRODUCTION_RUN_SUMMARY[item.id]
              ? t('封面示意 · AI 生成：这段画面由 AI 视频模型生成，只说明方向；AwwO 实际运行交付的成品在下方「它是怎么做出来的」。', 'Cover: AI illustration. This footage was made by an AI video model and only shows the direction; what an AwwO run actually delivered is below, under “How it was made”.')
              : t('封面示意 · AI 生成：这段画面由 AI 视频模型生成，只说明方向。', 'Cover: AI illustration. This footage was made by an AI video model and only shows the direction.')}</figcaption>
        </figure>
        <ol role="list" className="production-steps">
          <li><span className="production-step">01</span><div><h3>{t('需求', 'Brief')}</h3><p className="production-brief">{quote(item.brief[locale], locale)}</p></div></li>
          <li><span className="production-step">02</span><div><h3>{t('Agent 团队', 'Agent team')}</h3>
            <p className="production-team-meta">{t(`${agents} 个 Agent · ${item.stages.length} 个阶段`, `${agents} agents · ${item.stages.length} stages`)}</p>
            <ol role="list" className="production-stages">{item.stages.map((stage, index) => <li key={index}><b>{String(index + 1).padStart(2, '0')}</b>
              <div>{stage.map(value => <span key={value.en}>{value[locale]}</span>)}</div>{stage.length > 1 && <small>{t(`${stage.length} 路并行`, `${stage.length} in parallel`)}</small>}</li>)}</ol></div></li>
          <li><span className="production-step">03</span><div><h3>{t('交付', 'Delivery')}</h3><Deliverable item={item} />
            {item.facts && <ul role="list" className="production-facts">{item.facts.map(fact => <li key={fact.en}>{fact[locale]}</li>)}</ul>}</div></li>
        </ol>
      </div>
      <LazyBoundary fallback={<p className="production-made-pending" role="alert">{t('暂时无法读取运行记录。', 'The run record could not be loaded.')}{' '}
        <button type="button" className="saas-link" onClick={() => location.reload()}>{t('刷新页面', 'Reload the page')}</button></p>}>
        <Suspense fallback={<p className="production-made-pending" role="status">{t('正在读取运行记录…', 'Loading the run record…')}</p>}>
          <ProductionShowcase item={item} onReuse={onReuse && (workflow => { onClose(); onReuse(workflow); })} />
        </Suspense>
      </LazyBoundary>
    </div>
  </dialog>;
}

export function ProductionCases({ compact = false, onReuse }: { compact?: boolean; onReuse?: (workflow: OfficialWorkflow) => void }) {
  const { t } = useSaaSPreferences();
  const [expanded, setExpanded] = useState(false);
  const [open, setOpen] = useState<ProductionCase | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();
  const listId = useId();
  const items = compact && !expanded ? PRODUCTION_CASES.slice(0, COMPACT_CASE_COUNT) : PRODUCTION_CASES;
  // Say every case ran only when every case has a published run.
  const ran = PRODUCTION_CASES.filter(item => PRODUCTION_RUN_SUMMARY[item.id]).length;
  const close = () => setOpen(null);
  // Back to the card that opened the case, once the dialog is gone and the page is no longer inert.
  useEffect(() => { if (!open && trigger.current?.isConnected) trigger.current.focus(); }, [open]);
  return <section className={`production-cases${compact ? ' is-compact' : ''}`} aria-labelledby={titleId}>
    <div className="production-heading">
      <div><span className="production-eyebrow"><span />{t('制作案例', 'PRODUCTION CASES')}</span>
        <h2 id={titleId}>{t('一句话需求，交给一支 Agent 团队。', 'One brief, handed to a team of agents.')}</h2>
        <p>{ran === PRODUCTION_CASES.length
          ? t('每个案例都是一张真实的 AwwO 画布，并且真的跑过一遍：一句需求，一支分阶段协作的 Agent 团队，一份交付。打开案例，看每个 Agent 实际交了什么、整张画布怎么一步步跑完。',
            'Every case is a real AwwO canvas that actually ran: a one-line brief, a team of agents working in stages, and the deliverable. Open one to see what each agent actually handed over and how the canvas ran, step by step.')
          : t(`每个案例都是一张真实的 AwwO 画布：一句需求，一支分阶段协作的 Agent 团队，一份交付。其中 ${ran} 个已经在 AwwO 里跑过一遍，打开就能看到每个 Agent 实际交了什么；其余的运行记录发布后会出现在案例里。`,
            `Every case is a real AwwO canvas: a one-line brief, a team of agents working in stages, and the deliverable. ${ran} of them have actually run in AwwO; open one to see what each agent handed over. The others show their run once it is published.`)}</p>
        <p className="production-legend"><span><span className="production-label is-real">{t('真实运行', 'Real run')}</span>{t('画布在 AwwO 里实际运行的记录与交付', 'The canvas’s actual AwwO run and what it delivered')}</span>
          <span><Label />{t('团队知识库以外的封面画面由 AI 生成，只作示意', 'Apart from the knowledge base, cover footage is AI-generated, for illustration only')}</span></p></div>
      {compact && <button type="button" className="production-toggle" aria-expanded={expanded} aria-controls={listId} onClick={() => setExpanded(value => !value)}>
        {expanded ? t('收起', 'Show fewer') : t(`查看全部 ${PRODUCTION_CASES.length} 个制作案例`, `See all ${PRODUCTION_CASES.length} cases`)}</button>}
    </div>
    <ul role="list" id={listId} className="production-grid">{items.map(item => <CaseCard key={item.id} item={item} active={!open} onOpen={(value, button) => { trigger.current = button; setOpen(value); }} />)}</ul>
    {open && <CaseDialog item={open} onClose={close} onReuse={onReuse} />}
  </section>;
}
