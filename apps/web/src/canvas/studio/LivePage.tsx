// One delivered page, running (liveDocument.ts) in an opaque-origin sandbox. Used by the studio and by enlarged cards.
// A page holding a market Agent's words, or one an Agent invited to the canvas handed in (agentPages.ts), shows still,
// its scripts not run, until the reader chooses to run it.
import { useEffect, useMemo, useRef, useState, type SyntheticEvent } from 'react';
import { Loader2 } from 'lucide-react';
import { agentDisplayName } from '../agentPages';
import { htmlPreviewDocument } from '../htmlDeliverable';
import { useCanvasI18n } from '../i18n';
import { buildLiveDocument, LIVE_LINK_MESSAGE, LIVE_PAGE_ALLOW, LIVE_PAGE_SANDBOX, type AssetResolver } from './liveDocument';
import { readPageErrorMessage, reportPageError } from '../pageErrors';

export type LiveDevice = 'desktop' | 'tablet' | 'mobile';
export const DEVICE_WIDTH: Record<LiveDevice, number | null> = { desktop: null, tablet: 820, mobile: 390 };

export interface LivePageProps {
  html: string;
  title: string;
  path?: string;
  resolve?: AssetResolver;
  device?: LiveDevice;
  /** Bump to restart the page from scratch. */
  reloadKey?: number;
  /** A link the page asked to follow (its own navigation is stopped). */
  onLink?: (href: string) => void;
  /** The built document, for 「在新标签页打开」; null once the page shows still or goes, so no earlier build of it is
   *  taken for what is shown. */
  onDocument?: (document: string | null) => void;
  /** Cards on the board: no focus ring while the board is panned, no tab stop. */
  passive?: boolean;
  /** The page holds a market Agent's words (marketPages.ts): it shows still until the reader chooses to run it (on a
   *  card it only shows still: the studio runs it); running, pictures and media by URL stay off, and a line says so. */
  market?: boolean;
  /** An Agent invited to the canvas handed the page in (agentPages.ts), by this name ('' where it has none): it is held
   *  as a market Agent's page is, and says who wrote it. */
  handedInBy?: string;
  /** Which delivery the page is (its result's time): a held page runs for the delivery its reader chose, so the same
   *  page delivered again asks again. */
  delivery?: number;
  /** The reader already chose to run this very page, where it is shown (ArtifactPreview's own Run page). */
  runChosen?: boolean;
  className?: string;
}

export function LivePage({ html, title, path, resolve, device = 'desktop', reloadKey = 0, onLink, onDocument, passive = false, market = false, handedInBy, delivery, runChosen = false, className }: LivePageProps) {
  const { t } = useCanvasI18n();
  const frame = useRef<HTMLIFrameElement>(null);
  // A held page (a market Agent's words, or an invited Agent's hand-in) runs only once its reader chooses to, under the
  // policy that loads no pictures or media by URL but from the CDNs (liveDocument.ts MARKET_PAGE_CSP).
  const held = market || handedInBy !== undefined;
  const agent = handedInBy === undefined ? '' : agentDisplayName(handedInBy);
  // A build is of one page under one policy: a page that comes to be held is built again.
  const [built, setBuilt] = useState<{ source: string; held: boolean; document: string; id: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const builds = useRef(0);
  const linkRef = useRef(onLink); linkRef.current = onLink;
  const documentRef = useRef(onDocument); documentRef.current = onDocument;
  // The choice to run is the reader's for this delivery: a new one, or the same page delivered again, shows still again.
  const [chosen, setChosen] = useState<{ html: string; delivery: number | undefined } | null>(null);
  const still = held && !runChosen && !(chosen && chosen.html === html && chosen.delivery === delivery);
  // A page shown still, or gone, has no build to hand on (an earlier one was of a delivery not chosen here).
  useEffect(() => { if (still) documentRef.current?.(null); }, [still]);
  useEffect(() => () => documentRef.current?.(null), []);
  // The still page: rebuilt from an allowlist of elements, no script, nothing loaded from elsewhere (htmlDeliverable.ts).
  const stillDocument = useMemo(() => {
    if (!still) return null;
    try { return htmlPreviewDocument(html); } catch { return null; }
  }, [still, html]);
  // The page the frame runs now, for an error report it posts (pageErrors.ts): its line numbers are this document's.
  const builtRef = useRef(built); builtRef.current = built;
  useEffect(() => {
    if (still) return;
    let live = true;
    setFailed(false);
    void buildLiveDocument(html, { path, resolve, market: held }).then(document => {
      if (!live) return;
      // A build that comes out as the document the frame runs keeps that frame. The canvas hands every page a new
      // resolver whenever any of its nodes publishes (CanvasSurface's canvasEntries), and a new frame would start the
      // page again from a blank first paint: every page on the board flashed each time a node finished in a run.
      const current = builtRef.current;
      if (!current || current.source !== html || current.held !== held || current.document !== document) {
        builds.current += 1;
        setBuilt({ source: html, held, document, id: builds.current });
      }
      documentRef.current?.(document);
    }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [html, path, resolve, held, still]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      const data = event.data as { type?: unknown; href?: unknown } | null;
      if (data?.type === LIVE_LINK_MESSAGE && typeof data.href === 'string' && /^https?:\/\//i.test(data.href)) linkRef.current?.(data.href);
      const current = builtRef.current;
      const report = current ? readPageErrorMessage(event.data, current.document, current.source) : null;
      if (report) reportPageError(report);
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, []);
  // No sandbox flag stops a script from sending its own frame to another address (links are already handed to the
  // host). A second load of one frame is exactly that: the delivered page is put back, and a page that keeps doing it
  // (three times within 15 seconds) is stopped, as the 成果 preview does.
  const [epoch, setEpoch] = useState(0);
  const [navigation, setNavigation] = useState<'none' | 'restored' | 'stopped'>('none');
  // Loads are counted per frame element: a frame mounted again under the same key (a held page shown still and then
  // run again, now that a build of the same document keeps its key) loads its own document once more, which is no
  // redirect.
  const loads = useRef<{ frame: EventTarget | null; count: number }>({ frame: null, count: 0 });
  const redirects = useRef<number[]>([]);
  useEffect(() => { setNavigation('none'); redirects.current = []; }, [html, reloadKey]);
  const frameKey = `${reloadKey}:${epoch}:${built?.id ?? 0}`;
  const onFrameLoad = (event: SyntheticEvent<HTMLIFrameElement>) => {
    if (loads.current.frame !== event.currentTarget) loads.current = { frame: event.currentTarget, count: 0 };
    loads.current.count += 1;
    if (loads.current.count === 1) return;
    const now = Date.now();
    redirects.current = [...redirects.current.filter(at => now - at < 15_000), now];
    if (redirects.current.length >= 3) { setNavigation('stopped'); return; }
    setNavigation('restored');
    setEpoch(value => value + 1);
  };
  // A held page says, as it starts, why pictures by URL stay off, then gives the page its room back: each time its
  // reader chooses to run it, a delivery of the same page that reuses its build included.
  const [heldNote, setHeldNote] = useState(false);
  const builtId = built?.id ?? 0;
  useEffect(() => {
    if (!held || passive || !builtId || still) return;
    setHeldNote(true);
    const timer = window.setTimeout(() => setHeldNote(false), 8000);
    return () => { window.clearTimeout(timer); setHeldNote(false); };
  }, [held, passive, builtId, still, chosen]);
  // Who wrote a held page, said in its own words: an invited Agent's hand-in names that Agent.
  const stillText = handedInBy === undefined ? t('studio.marketPageStill') : agent ? t('studio.agentPageStill', { name: agent }) : t('studio.agentPageStillUnnamed');
  const noteText = handedInBy === undefined ? t('studio.marketPageNote') : agent ? t('studio.agentPageNote', { name: agent }) : t('studio.agentPageNoteUnnamed');
  const width = DEVICE_WIDTH[device];
  const ready = built?.source === html && built.held === held;
  return <div className={`awwo-live-page is-${device}${className ? ` ${className}` : ''}`}>
    <div className="awwo-live-page-viewport" style={width ? { width: `min(${width}px, 100%)` } : undefined}>
      {still ? <>
        {stillDocument !== null
          ? <iframe key="still" className="awwo-live-page-frame" title={t('studio.pageFrame', { title })} sandbox="" referrerPolicy="no-referrer" srcDoc={stillDocument}
            {...passive ? { tabIndex: -1 } : {}} />
          : <div className="awwo-live-page-loading" role="alert">{t('studio.pageFailed')}</div>}
        {!passive && <div className="awwo-live-page-run">
          <p>{stillText}</p>
          <button type="button" onClick={() => setChosen({ html, delivery })}>{t('studio.runPage')}</button>
        </div>}
      </> : ready && navigation !== 'stopped' ? <iframe ref={frame} key={frameKey} className="awwo-live-page-frame" title={t('studio.pageFrame', { title })}
        sandbox={LIVE_PAGE_SANDBOX} allow={LIVE_PAGE_ALLOW} referrerPolicy="no-referrer" srcDoc={built.document} onLoad={onFrameLoad}
        {...passive ? { tabIndex: -1 } : {}} />
        : <div className="awwo-live-page-loading" role={failed || navigation === 'stopped' ? 'alert' : 'status'}>
          {navigation === 'stopped' ? t('studio.pageNavigationStopped') : failed ? t('studio.pageFailed') : <><Loader2 size={18} aria-hidden="true" />{t('studio.pageLoading')}</>}
        </div>}
      {navigation === 'restored' ? <p className="awwo-live-page-note" role="status">{t('studio.pageNavigationRestored')}</p>
        : heldNote && <p className="awwo-live-page-note" role="status">{noteText}</p>}
    </div>
  </div>;
}
