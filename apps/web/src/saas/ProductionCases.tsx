import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, X } from 'lucide-react';
import { useSaaSPreferences } from './preferences';
import type { UiLocale } from '../locale';
import { PRODUCTION_CASES, PRODUCTION_KIND_LABELS, type ProductionCase } from './productionCatalog';
import './production-cases.css';

/** `compact` (the workspace homes) shows this many — one row — until expanded; the landing page shows every case. */
export const COMPACT_CASE_COUNT = 3;

const reducedMotion = () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const saveData = () => (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;
const footageOf = (item: ProductionCase, locale: UiLocale) => locale === 'en' && item.footageEn ? item.footageEn : item.footage;
const playURL = (page: string, locale: UiLocale) => `/showcase/play/${page}.html${locale === 'en' ? '?lang=en' : ''}`;
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

function Label({ real, id }: { real?: boolean; id?: string }) {
  const { t } = useSaaSPreferences();
  return <span id={id} className={`production-label${real ? ' is-real' : ''}`}>{real ? t('真实实跑', 'Real run') : t('示意 · AI 生成', 'Illustration · AI-generated')}</span>;
}

/** Only the real run delivered its deliverable; an illustration's is the goal of the brief. */
function Deliverable({ item }: { item: ProductionCase }) {
  const { locale, t } = useSaaSPreferences();
  return <p className={`production-delivered${item.real ? ' is-done' : ''}`}>{item.real && <Check size={13} aria-hidden="true" />}
    <b>{item.real ? t('已交付', 'Delivered') : t('交付目标', 'Deliverable')}</b><span>{item.deliverable[locale]}</span></p>;
}

function CaseCard({ item, active, onOpen }: { item: ProductionCase; active: boolean; onOpen: (item: ProductionCase, trigger: HTMLButtonElement) => void }) {
  const { locale, t } = useSaaSPreferences();
  const id = useId();
  const translated = locale === 'en' && item.footageEn !== undefined;
  return <li className={`production-card${item.real ? ' is-real' : ''}`}>
    <div className="production-card-media"><Footage stem={footageOf(item, locale)} active={active} /><Label real={item.real} id={`${id}-label`} /><span className="production-kind">{PRODUCTION_KIND_LABELS[item.kind][locale]}</span>
      {translated && <span id={`${id}-translated`} className="production-translated">UI translated from Chinese</span>}</div>
    <div className="production-card-copy">
      <h3><button type="button" className="production-card-open" aria-haspopup="dialog" aria-describedby={[`${id}-label`, translated && `${id}-translated`, `${id}-brief`].filter(Boolean).join(' ')}
        onClick={event => onOpen(item, event.currentTarget)}>{item.title[locale]}</button></h3>
      <p id={`${id}-brief`} className="production-brief">{quote(item.brief[locale], locale)}</p>
      <ol role="list" className="production-team" aria-label={item.real ? t('Agent 团队，按阶段', 'Agent team, by stage') : t('设想的 Agent 团队，按阶段', 'Proposed agent team, by stage')}>
        {item.stages.map((stage, index) => <li key={index}>{stage.map(value => value[locale]).join(' · ')}</li>)}
      </ol>
      <div className="production-card-footer">
        <Deliverable item={item} />
        {item.build && <a className="production-play" href={playURL(item.build.page, locale)} target="_blank" rel="noopener"
          aria-label={t(`试玩示意版：${item.title.zh}`, `Play the mock-up: ${item.title.en}`)}>{t('试玩示意版', 'Play the mock-up')}<ArrowUpRight size={13} aria-hidden="true" /></a>}
      </div>
    </div>
  </li>;
}

function CaseDialog({ item, onClose }: { item: ProductionCase; onClose: () => void }) {
  const { locale, t } = useSaaSPreferences();
  const dialog = useRef<HTMLDialogElement>(null);
  const pressedOutside = useRef(false);
  const titleId = useId();
  const still = reducedMotion() || saveData();
  // Layout timing: the dialog must close while it is still in the document, before the page behind it can take focus.
  useLayoutEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close(); }, []);
  const graph = item.nodes ?? item.stages;
  const agents = graph.reduce((sum, stage) => sum + stage.length, 0);
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
      <header><div><span className="production-dialog-meta"><Label real={item.real} />{PRODUCTION_KIND_LABELS[item.kind][locale]}</span><h2 id={titleId}>{item.title[locale]}</h2></div>
        <button type="button" className="production-close" onClick={onClose} aria-label={t('关闭', 'Close')}><X size={18} aria-hidden="true" /></button></header>
      <div className="production-dialog-grid">
        <figure className="production-dialog-media">
          <video src={`/showcase/${footageOf(item, locale)}.mp4`} poster={`/showcase/${footageOf(item, locale)}.jpg`} muted loop playsInline autoPlay={!still} controls={still}
            aria-label={item.real ? t(`${item.title.zh}：交付界面实录`, `${item.title.en}: the delivered interface, recorded`) : t(`${item.title.zh}：AI 生成的示意画面`, `${item.title.en}: AI-generated illustration`)} />
          <figcaption>{item.real
            ? t('界面实录：2026-09-04 一次 AwwO 真实运行交付的知识库工作台（演示模式，使用模拟数据）。', 'Recorded: the knowledge-base workspace a real AwwO run delivered on 2026-09-04, in its demo mode with simulated data. UI translated from Chinese.')
            : t('示意 · AI 生成：画面由 AI 生成，说明这条路能通向哪里，不是一次 AwwO 运行的产出。', 'Illustration · AI-generated: the footage shows where this path can lead; it is not the output of an AwwO run.')}</figcaption>
        </figure>
        <ol role="list" className="production-steps">
          <li><span className="production-step">01</span><div><h3>{t('需求', 'Brief')}</h3><p className="production-brief">{quote(item.brief[locale], locale)}</p></div></li>
          <li><span className="production-step">02</span><div><h3>{item.real ? t('Agent 团队', 'Agent team') : t('设想的 Agent 团队', 'Proposed agent team')}</h3>
            <p className="production-team-meta">{t(`${agents} 个 Agent · ${graph.length} 个阶段`, `${agents} agents · ${graph.length} stages`)}</p>
            <ol role="list" className="production-stages">{graph.map((stage, index) => <li key={index}><b>{String(index + 1).padStart(2, '0')}</b>
              <div>{stage.map(value => <span key={value.en}>{value[locale]}</span>)}</div>{stage.length > 1 && <small>{t(`${stage.length} 路并行`, `${stage.length} in parallel`)}</small>}</li>)}</ol></div></li>
          <li><span className="production-step">03</span><div><h3>{t('交付', 'Delivery')}</h3><Deliverable item={item} />
            {item.facts && <ul role="list" className="production-facts">{item.facts.map(fact => <li key={fact.en}>{fact[locale]}</li>)}</ul>}
            {item.build && <div className="production-build"><Footage stem={item.build.footage} eager label={t('可试玩示意版的录屏', 'A recording of the playable mock-up')} />
              <div><b>{t('可试玩的示意版', 'Playable mock-up')}</b><small>{t('示意 · AI 生成，不是 AwwO 运行的产出', 'Illustration · AI-generated, not the output of an AwwO run')}</small>
                <a className="production-play" href={playURL(item.build.page, locale)} target="_blank" rel="noopener">{t('在新标签页试玩', 'Play in a new tab')}<ArrowUpRight size={13} aria-hidden="true" /></a></div></div>}
          </div></li>
        </ol>
      </div>
    </div>
  </dialog>;
}

export function ProductionCases({ compact = false }: { compact?: boolean }) {
  const { t } = useSaaSPreferences();
  const [expanded, setExpanded] = useState(false);
  const [open, setOpen] = useState<ProductionCase | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();
  const listId = useId();
  const items = compact && !expanded ? PRODUCTION_CASES.slice(0, COMPACT_CASE_COUNT) : PRODUCTION_CASES;
  const close = () => setOpen(null);
  // Back to the card that opened the case, once the dialog is gone and the page is no longer inert.
  useEffect(() => { if (!open && trigger.current?.isConnected) trigger.current.focus(); }, [open]);
  return <section className={`production-cases${compact ? ' is-compact' : ''}`} aria-labelledby={titleId}>
    <div className="production-heading">
      <div><span className="production-eyebrow"><span />{t('制作案例', 'PRODUCTION CASES')}</span>
        <h2 id={titleId}>{t('一句话需求，交给一支 Agent 团队。', 'One brief, handed to a team of agents.')}</h2>
        <p>{t('每个案例都按 AwwO 的方式拆开：一句需求，一支分阶段协作的 Agent 团队，一份要交付的成果。只有标「真实实跑」的那一个真的跑过，其余都是示意。',
          'Each case is laid out the AwwO way: a one-line brief, a team of agents working in stages, and the deliverable. Only the one marked Real run actually ran; the rest are illustrations.')}</p>
        <p className="production-legend"><span><Label real />{t('2026-09-04 一次 AwwO 真实运行的交付实录', 'What a real AwwO run delivered on 2026-09-04, its UI translated from Chinese')}</span>
          <span><Label />{t('画面由 AI 生成，说明这条路能通向哪里', 'AI-generated footage of where the path can lead')}</span></p></div>
      {compact && <button type="button" className="production-toggle" aria-expanded={expanded} aria-controls={listId} onClick={() => setExpanded(value => !value)}>
        {expanded ? t('收起', 'Show fewer') : t(`查看全部 ${PRODUCTION_CASES.length} 个制作案例`, `See all ${PRODUCTION_CASES.length} cases`)}</button>}
    </div>
    <ul role="list" id={listId} className="production-grid">{items.map(item => <CaseCard key={item.id} item={item} active={!open} onOpen={(value, button) => { trigger.current = button; setOpen(value); }} />)}</ul>
    {open && <CaseDialog item={open} onClose={close} />}
  </section>;
}
