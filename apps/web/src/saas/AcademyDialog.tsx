import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowLeft, ArrowRight, GraduationCap, Play, RotateCcw, X } from 'lucide-react';
import { localeHtmlLang, type UiLocale } from '../locale';
import { useSaaSPreferences } from './preferences';
import { ACADEMY_SECTIONS, ACADEMY_VIDEOS, academyDuration, type AcademySection, type AcademyVideo } from './academyCatalog';
import { PRODUCTION_CASES, type ProductionCase } from './productionCatalog';
import { canOpenCase, caseURL, openCase, subscribeCaseOpeners } from './caseLink';
import { currentSaaSCanvas, subscribeSaaSCanvas } from './canvasBridge';
import { writeAcademyLink } from './academyLink';

type Filter = 'all' | AcademySection;
type T = (zh: string, en: string) => string;
/** How many videos "Up next" offers beside the one playing. */
const UP_NEXT = 3;
const outside = (box: DOMRect, x: number, y: number) => x < box.left || x > box.right || y < box.top || y > box.bottom;
const caseOf = (video: AcademyVideo): ProductionCase | undefined => PRODUCTION_CASES.find(item => item.id === video.caseId);
/** A video's poster: its own, or its case's cover. */
const posterOf = (video: AcademyVideo) => video.poster ?? (caseOf(video) ? `/showcase/${caseOf(video)!.footage}.jpg` : undefined);

const SECTION_COPY: Readonly<Record<AcademySection, { title: [string, string]; chip: [string, string]; note: [string, string] }>> = {
  start: { title: ['从这里开始', 'Start here'], chip: ['入门', 'Start here'],
    note: ['四个两分钟左右的短片：写代码、生图、做网页、写方案。中文讲解，中英字幕。', 'Four videos of about two minutes each: code, an image, a website and a plan. Chinese narration, with Chinese and English subtitles.'] },
  flagship: { title: ['拆解旗舰案例', 'Inside the flagship cases'], chip: ['旗舰案例', 'Flagship cases'],
    note: ['打开案例，看它是怎么做出来的，把画布复制成草稿，再用它交付的成品。英文讲解，中英字幕。', 'Open the case, see how it was made, copy its canvas as a draft and use what it delivered. English narration, with English and Chinese subtitles.'] },
  build: { title: ['跟着做一个案例', 'Build a case, step by step'], chip: ['跟着做', 'Build a case'],
    note: ['按四个部分写需求，让画布助手搭好团队，运行画布，再试用它做出的成品。英文讲解，中英字幕。', 'Write the request in four parts, let the canvas assistant build the team, then run the canvas and try what it made. English narration, with English and Chinese subtitles.'] },
};
const pick = (copy: [string, string], t: T) => t(copy[0], copy[1]);

function recorded(day: string, locale: UiLocale) {
  const date = new Date(`${day}T00:00:00Z`);
  return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-GB', { dateStyle: 'long', timeZone: 'UTC' }).format(date);
}

function VideoCard({ video, locale, t, onPlay }: { video: AcademyVideo; locale: UiLocale; t: T; onPlay: (video: AcademyVideo) => void }) {
  const id = useId();
  const item = caseOf(video);
  return <li className="academy-card">
    <div className="academy-card-media">
      <img src={posterOf(video)} alt="" loading="lazy" decoding="async" />
      <span className="academy-card-play" aria-hidden="true"><Play size={18} /></span>
      <span className="academy-card-duration"><Play size={9} aria-hidden="true" />{academyDuration(video.seconds)}</span>
    </div>
    <div className="academy-card-copy">
      {item && <span className="academy-card-case" lang="en">{item.title}</span>}
      <h4><button type="button" className="academy-card-open" aria-describedby={`${id}-summary`} data-video-id={video.id} onClick={() => onPlay(video)}>{video.title[locale]}</button></h4>
      <p id={`${id}-summary`} className="academy-card-summary">{video.summary[locale]}</p>
    </div>
  </li>;
}

function Lead({ t }: { t: T }) {
  const minutes = Math.round(ACADEMY_VIDEOS.reduce((sum, video) => sum + video.seconds, 0) / 60);
  return <p className="academy-lead">{t(`${ACADEMY_VIDEOS.length} 个视频，共 ${minutes} 分钟，全部在线上 AwwO 里真实操作录制：先看入门短片，再看首页的每个案例是怎么做出来的。`,
    `${ACADEMY_VIDEOS.length} videos, ${minutes} minutes in all, every one recorded on the live AwwO: start with the short how-tos, then see how each homepage case was made.`)}</p>;
}

function Library({ filter, setFilter, locale, t, onPlay }: { filter: Filter; setFilter: (value: Filter) => void; locale: UiLocale; t: T; onPlay: (video: AcademyVideo) => void }) {
  const count = (section: AcademySection) => ACADEMY_VIDEOS.filter(video => video.section === section).length;
  const shown = filter === 'all' ? ACADEMY_SECTIONS : [filter];
  return <>
    <div className="academy-filters" role="group" aria-label={t('显示', 'Show')}>
      <button type="button" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>{t('全部', 'All')}<span>{ACADEMY_VIDEOS.length}</span></button>
      {ACADEMY_SECTIONS.map(section => <button key={section} type="button" aria-pressed={filter === section} onClick={() => setFilter(section)}>
        {pick(SECTION_COPY[section].chip, t)}<span>{count(section)}</span></button>)}
    </div>
    {shown.map(section => <section key={section} className={`academy-section is-${section}`} aria-labelledby={`academy-section-${section}`}>
      <header><h3 id={`academy-section-${section}`}>{pick(SECTION_COPY[section].title, t)}</h3><p>{pick(SECTION_COPY[section].note, t)}</p></header>
      <ul role="list" className="academy-grid">{ACADEMY_VIDEOS.filter(video => video.section === section)
        .map(video => <VideoCard key={video.id} video={video} locale={locale} t={t} onPlay={onPlay} />)}</ul>
    </section>)}
  </>;
}

function Player({ video, list, autoPlay, locale, t, onPick, onClose }: { video: AcademyVideo; list: ReadonlyArray<AcademyVideo>; autoPlay: boolean; locale: UiLocale; t: T;
  onPick: (video: AcademyVideo | null) => void; onClose: () => void }) {
  const element = useRef<HTMLVideoElement>(null);
  const retryButton = useRef<HTMLButtonElement>(null);
  const retrying = useRef(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [video.id]);
  // A failure takes the video away: a focus that was on it (or nowhere) goes to "Try again", and back to the video then.
  useEffect(() => {
    const focus = document.activeElement;
    if (failed && (!focus || focus === document.body || focus === element.current)) retryButton.current?.focus();
    if (!failed && retrying.current) { retrying.current = false; element.current?.focus(); }
  }, [failed]);
  const item = caseOf(video);
  const index = list.indexOf(video);
  // Up next: the videos after this one in the list it was opened from.
  const upNext = index >= 0 ? list.slice(index + 1, index + 1 + UP_NEXT) : [];
  const voice = video.voice === 'zh' ? t('中文讲解，中英字幕', 'Chinese narration, Chinese and English subtitles') : t('英文讲解，中英字幕', 'English narration, English and Chinese subtitles');
  // Through the case library on this page, which can show up after this does (the home page, once the session is known);
  // from a page with a canvas open, a link to its workspace's home page; nothing where neither leads to the case (no
  // workspace, a suspended one, an invitation, administration).
  const library = useSyncExternalStore(subscribeCaseOpeners, canOpenCase);
  // A canvas page sets its canvas once the canvas has loaded, which can be after the Academy (opened from a link) drew.
  const canvas = useSyncExternalStore(subscribeSaaSCanvas, currentSaaSCanvas);
  const label = <>{t('打开这个案例', 'Open the case')}<ArrowRight size={15} aria-hidden="true" /></>;
  const openTheCase = item && (library
    ? <button type="button" className="saas-primary academy-open-case" onClick={() => { onClose(); openCase(item.id); }}>{label}</button>
    : canvas ? <a className="saas-primary academy-open-case" href={caseURL(item.id, canvas.tenant.id)}>{label}</a> : null);
  return <div className="academy-player">
    <div className="academy-player-bar">
      <button type="button" className="academy-back" onClick={() => onPick(null)}><ArrowLeft size={15} aria-hidden="true" />{t('全部视频', 'All videos')}</button>
      {index >= 0 && <span className="academy-position">{t(`第 ${index + 1} / ${list.length} 个`, `${index + 1} of ${list.length}`)}</span>}
    </div>
    <div className="academy-player-grid">
      <div className="academy-stage">
        {/* tabIndex: a video with controls is in the tab order already; said, so the focus can come back to it everywhere. */}
        <video key={video.id} ref={element} className="academy-video" src={video.src} poster={posterOf(video)} controls playsInline preload="metadata" autoPlay={autoPlay}
          tabIndex={0} hidden={failed} onError={() => setFailed(true)} aria-label={video.title[locale]} />
        {failed && <div className="academy-video-failed" role="alert"><p>{t('这个视频没能加载。', 'This video could not be loaded.')}</p>
          <button type="button" ref={retryButton} onClick={() => { retrying.current = true; setFailed(false); element.current?.load(); }}><RotateCcw size={15} aria-hidden="true" />{t('重试', 'Try again')}</button></div>}
      </div>
      <div className="academy-player-copy">
        {item && <p className="academy-player-case" lang="en">{item.title}</p>}
        <p className="academy-player-meta">{[academyDuration(video.seconds), voice, t(`录于 ${recorded(video.recordedOn, locale)}`, `Recorded ${recorded(video.recordedOn, locale)}`)].join(' · ')}</p>
        <p className="academy-player-summary">{video.summary[locale]}</p>
        {video.section === 'build' && <p className="academy-player-how">{pick(SECTION_COPY.build.note, t)}</p>}
        {openTheCase && <div className="academy-player-actions">{openTheCase}</div>}
        {upNext.length > 0 && <nav className="academy-up-next" aria-label={t('接下来', 'Up next')}><h3>{t('接下来', 'Up next')}</h3>
          <ol role="list">{upNext.map(value => <li key={value.id}><button type="button" onClick={() => onPick(value)}>
            <span className="academy-up-next-poster"><img src={posterOf(value)} alt="" loading="lazy" decoding="async" /><span>{academyDuration(value.seconds)}</span></span>
            <span className="academy-up-next-title">{value.title[locale]}</span></button></li>)}</ol></nav>}
      </div>
    </div>
  </div>;
}

/** The Academy, opened. It never starts, saves or changes anything but its own place in the address. */
export default function AcademyDialog({ initialVideo, fromLink, replacing = false, onClose }: { initialVideo: string; fromLink: boolean;
  /** It takes the place of its loading frame, which came in already. */ replacing?: boolean; onClose: () => void }) {
  const { locale, t } = useSaaSPreferences();
  const dialog = useRef<HTMLDialogElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const pressedOutside = useRef(false);
  /** The video left for the library: its card takes the focus back. */
  const left = useRef<string | null>(null);
  const moved = useRef(false);
  const titleId = useId();
  const [filter, setFilter] = useState<Filter>('all');
  const [current, setCurrent] = useState<AcademyVideo | null>(() => ACADEMY_VIDEOS.find(video => video.id === initialVideo) ?? null);
  // A video chosen here plays at once; one a link opened waits for its play button (the browser would refuse its sound).
  const [chosen, setChosen] = useState(!fromLink);
  const list = useMemo(() => filter === 'all' ? ACADEMY_VIDEOS : ACADEMY_VIDEOS.filter(video => video.section === filter), [filter]);
  // Layout timing, as the case dialog: closed while still in the document, before the page behind takes the focus back.
  useLayoutEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element?.showModal();
    return () => {
      element?.close();
      writeAcademyLink(null);
      if (previous?.isConnected && !previous.closest('[inert]')) previous.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    writeAcademyLink(current?.id ?? '');
    if (body.current) body.current.scrollTop = 0;
    // The control that moved there is gone with its view: the focus stays in the dialog, where its keys stay its own, on
    // the video's title, or back on the card of the video just left. (When it opens, showModal places it.)
    if (!moved.current) return;
    moved.current = false;
    const card = current ? null : dialog.current?.querySelector<HTMLButtonElement>(`button.academy-card-open[data-video-id="${left.current}"]`);
    if (card) card.focus(); else heading.current?.focus({ preventScroll: true });
  }, [current]);
  const pickVideo = (video: AcademyVideo | null) => { left.current = current?.id ?? null; moved.current = true; setChosen(true); setCurrent(video); };
  return <dialog ref={dialog} className={`saas-native-dialog academy-dialog${replacing ? ' is-replacing' : ''}`} lang={localeHtmlLang(locale)} aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); onClose(); }}
    // The canvas listens for its shortcuts on the window: keys pressed in here are the dialog's.
    onKeyDown={event => event.stopPropagation()}
    onMouseDown={event => { pressedOutside.current = event.target === event.currentTarget && outside(event.currentTarget.getBoundingClientRect(), event.clientX, event.clientY); }}
    onClick={event => {
      const backdrop = pressedOutside.current && event.target === event.currentTarget && outside(event.currentTarget.getBoundingClientRect(), event.clientX, event.clientY);
      pressedOutside.current = false;
      if (backdrop) onClose();
    }}>
    <div className="academy-shell">
      <header className={`academy-header${current ? ' is-playing' : ''}`}>
        <div>
          <span className="academy-eyebrow"><GraduationCap size={14} aria-hidden="true" />AwwO Academy</span>
          <h2 id={titleId} ref={heading} tabIndex={-1}>{current ? current.title[locale] : t('从真实画布学会 AwwO', 'Learn AwwO from real canvases')}</h2>
          {!current && <Lead t={t} />}
        </div>
        <button type="button" className="academy-close" onClick={onClose} aria-label={t('关闭', 'Close')}><X size={18} aria-hidden="true" /></button>
      </header>
      <div className="academy-body" ref={body}>
        {current ? <Player video={current} list={list.includes(current) ? list : ACADEMY_VIDEOS} autoPlay={chosen} locale={locale} t={t} onPick={pickVideo} onClose={onClose} />
          : <Library filter={filter} setFilter={setFilter} locale={locale} t={t} onPlay={pickVideo} />}
      </div>
    </div>
  </dialog>;
}
