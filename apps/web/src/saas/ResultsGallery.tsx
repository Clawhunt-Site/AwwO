// The workspace home's 最近的成果: canvases that have delivered something, each shown by its result (picked
// exactly as the canvas's 成果 view picks it) and opening straight into that view. Built from the canvas
// list the home has already loaded, so it fetches nothing; a page's thumbnail is that page rendered
// static, in the same sandbox as every preview (no scripts, no network, opaque origin).
import { memo, useDeferredValue, useId, useMemo } from 'react';
import { Clapperboard, FileText, Image as ImageIcon } from 'lucide-react';
import { caseRunLabel, sanitizeDocument } from '../canvas/canvasDoc';
import { canvasResult, type StepDelivery } from '../canvas/canvasResultModel';
import { htmlPreviewDocument } from '../canvas/htmlDeliverable';
import { relativeTime } from './CanvasThumbnail';
import type { CanvasRecord, Tenant } from './api';
import { useSaaSPreferences } from './preferences';
import './results-gallery.css';

/** How many results the home shows. */
export const RESULTS_GALLERY_COUNT = 6;
/** How many of the most recently updated canvases are read for results: a delivery updates its canvas, so
 *  the newest results are among them, and the home never parses every output of a whole page of canvases. */
export const RESULTS_GALLERY_CANDIDATES = 18;
/** A larger page is shown by its kind, not printed: the home builds each print synchronously. */
const THUMBNAIL_BYTES = 512 * 1024;
/** A recorded delivery time, or nothing (a legacy output has none; a corrupt one must not break the page). */
const deliveredAt = (at: number) => at >= 1e12 && at <= 8.64e15 ? new Date(at).toISOString() : '';
const updatedAt = (canvas: CanvasRecord) => Date.parse(canvas.updatedAt) || 0;

type Entry = { canvas: CanvasRecord; final: StepDelivery; pending: number };

// Memoised: the home re-renders on every keystroke in its prompt, and nothing here depends on it.
export const ResultsGallery = memo(function ResultsGallery({ tenant, canvases }: { tenant: Tenant; canvases: ReadonlyArray<CanvasRecord> | null }) {
  const { locale, t } = useSaaSPreferences();
  const titleId = useId();
  // Reading results waits for the rest of the home to paint.
  const loaded = useDeferredValue(canvases);
  const entries = useMemo(() => [...(loaded ?? [])].sort((a, b) => updatedAt(b) - updatedAt(a)).slice(0, RESULTS_GALLERY_CANDIDATES).flatMap<Entry>(canvas => {
    // The stored document as the canvas itself would read it (unknown parts dropped, never trusted as is).
    const result = canvasResult(sanitizeDocument(canvas.document));
    return result.final ? [{ canvas, final: result.final, pending: result.pending.length }] : [];
  }).sort((a, b) => b.final.output!.at - a.final.output!.at).slice(0, RESULTS_GALLERY_COUNT), [loaded]);
  // Nothing to say before the list has loaded and been read, or in a workspace without canvases (the list
  // invites the first).
  if (!loaded || !loaded.length) return null;
  const state = (entry: Entry) => entry.final.state === 'partial' ? t('部分结果', 'Partial result')
    : entry.final.state === 'case' ? t('案例实录', 'Case recording')
    : entry.final.state === 'manual' ? t('手动发布', 'Published by hand') : t('运行交付', 'From a run');
  return <section className="saas-home-section saas-results-gallery" aria-labelledby={titleId}>
    <div className="saas-home-section-header">
      <div className="saas-home-section-title">
        <h2 id={titleId}>{t('最近的成果', 'Recent results')}</h2>
        <p>{t('这个工作区的画布交付的成果，最新的在前。打开就是它的成果页，可以看到每一步怎么来的。', 'What this workspace’s canvases delivered, newest first. Each opens on its results, with every step that made it.')}</p>
      </div>
    </div>
    {entries.length ? <ul className="saas-results-list">{entries.map(entry => <li key={entry.canvas.id}>
      <a className="saas-result-card" href={`/?${new URLSearchParams({ tenant: tenant.id, canvas: entry.canvas.id, view: 'results' })}`}>
        <ResultThumbnail step={entry.final} />
        <span className="saas-result-body">
          <strong>{entry.final.node.title || entry.canvas.name}</strong>
          <span className="saas-result-canvas">{entry.canvas.name}</span>
          <span className="saas-result-meta">
            <span className={`saas-result-chip is-${entry.final.state}`}>{state(entry)}</span>
            {entry.pending > 0 && <span className="saas-result-chip is-partial">{t(`还有 ${entry.pending} 步没有交付`, `Still to deliver: ${entry.pending}`)}</span>}
            {/* Outputs saved before delivery times were recorded carry none, and claim none. */}
            {/* A case recording is dated by the case's run (model and day), not by when the copy got it. */}
            {entry.final.state === 'case' ? <span>{caseRunLabel(entry.final.output!)}</span>
              : deliveredAt(entry.final.output!.at) && <time dateTime={deliveredAt(entry.final.output!.at)}>{relativeTime(deliveredAt(entry.final.output!.at), locale)}</time>}
          </span>
        </span>
      </a>
    </li>)}</ul>
      : <p className="saas-results-empty">{tenant.role === 'reader' ? t('还没有交付。成员运行画布后，成果会出现在这里。', 'Nothing delivered yet. When a member runs a canvas, its result appears here.')
        : t('还没有交付。运行一张画布后，它交付的东西会出现在这里。', 'Nothing delivered yet. Run a canvas and what it delivers appears here.')}</p>}
  </section>;
});

/** The result itself, small: a web page as it renders without scripts, a document's opening lines, or its kind. */
function ResultThumbnail({ step }: { step: StepDelivery }) {
  const { t } = useSaaSPreferences();
  const page = step.kind === 'html' ? step.html : undefined;
  const srcDoc = useMemo(() => page && page.length <= THUMBNAIL_BYTES && new TextEncoder().encode(page).byteLength <= THUMBNAIL_BYTES
    ? htmlPreviewDocument(page, false) : '', [page]);
  // Without scripts a game or an animation may show little; the label says this is the page at rest.
  if (srcDoc) return <span className="saas-result-thumb is-page">
    {/* inert: nothing inside the print can take focus or be reached with Tab. */}
    <iframe title="" aria-hidden="true" tabIndex={-1} inert sandbox="" referrerPolicy="no-referrer" loading="lazy" srcDoc={srcDoc} />
    <small className="saas-result-thumb-label">{t('网页 · 静态预览', 'Web page · at rest')}</small>
  </span>;
  if (step.text && (step.kind === 'markdown' || step.kind === 'text')) return <span className="saas-result-thumb is-text" aria-hidden="true">
    <span>{step.text.replace(/[#>*_`|-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 360)}</span>
  </span>;
  const Icon = step.kind === 'media' ? ImageIcon : step.kind === 'html' ? Clapperboard : FileText;
  return <span className="saas-result-thumb is-kind" aria-hidden="true"><Icon size={26} />
    <small>{step.kind === 'media' ? t('图片或视频', 'Image or video') : step.kind === 'html' ? t('网页', 'Web page') : t('文件', 'File')}</small></span>;
}
