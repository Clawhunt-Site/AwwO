// The workspace home's former 最近的成果: canvases that have delivered something, each shown by its result (picked
// exactly as the canvas's 成果 view picks it) and opening straight into that view. NOT MOUNTED: the home keeps
// 「继续工作」 (CanvasList.tsx) as its one canvas section (owner 2026-10-13 15:28: 还不如保留那个工作中的画布更好). Built from
// a canvas list already loaded, so it fetches nothing to show; a page's thumbnail is that page rendered
// static, in the same sandbox as every preview (no scripts, no network, opaque origin).
// Each card's menu takes its result off this list (kept per person in this browser; the canvas is untouched)
// or, for a member, deletes the canvas; 管理 does either for several cards at once.
import { memo, useDeferredValue, useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { Clapperboard, FileText, Image as ImageIcon } from 'lucide-react';
import { caseRunLabel, sanitizeDocument } from '../canvas/canvasDoc';
import { forgetCanvasStorage } from '../canvas/canvasStorage';
import { canvasResult, type StepDelivery } from '../canvas/canvasResultModel';
import { htmlPreviewDocument } from '../canvas/htmlDeliverable';
import { ActionMenu } from './ActionMenu';
import { relativeTime } from './CanvasThumbnail';
import { api, saasErrorMessage, tenantPath, type CanvasRecord, type Tenant } from './api';
import { useSaaSPreferences } from './preferences';
import { hiddenResultKey, hiddenResultTime, readHiddenResults, saveHiddenResults, type HiddenResult } from './resultsGalleryHidden';
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
/** The delivery a card shows, as a removal names it. */
const entryResult = (entry: Entry): HiddenResult => ({ canvasId: entry.canvas.id, at: hiddenResultTime(entry.final.output?.at) });
const entryTitle = (entry: Entry) => entry.final.node.title || entry.canvas.name;

type GalleryProps = {
  tenant: Tenant;
  canvases: ReadonlyArray<CanvasRecord> | null;
  /** Whose removals these are: kept per person and workspace. Without it a removal lasts until a reload. */
  userId?: string;
  /** The canvases this list deleted on the server, for the page around it to drop and reload. Keep it
   *  stable: the gallery is memoised against the home's per-keystroke renders. */
  onCanvasesDeleted?: (canvasIds: ReadonlyArray<string>) => void;
};
type Notice = { text: string; undo?: ReadonlyArray<HiddenResult> };

// Memoised: the home re-renders on every keystroke in its prompt, and nothing here depends on it.
export const ResultsGallery = memo(function ResultsGallery(props: GalleryProps) {
  // Another person or workspace never inherits this one's removals, selection or open dialog.
  return <ScopedResultsGallery key={JSON.stringify([props.userId ?? null, props.tenant.id])} {...props} />;
});

function ScopedResultsGallery({ tenant, canvases, userId, onCanvasesDeleted }: GalleryProps) {
  const { locale, t } = useSaaSPreferences();
  const titleId = useId();
  // Reading results waits for the rest of the home to paint.
  const loaded = useDeferredValue(canvases);
  // Deleting a canvas is a member's action, as in the canvas list; taking a result off one's own list is anyone's.
  const canDelete = tenant.role !== 'reader' && tenant.status === 'active';
  const [hidden, setHidden] = useState<ReadonlyArray<HiddenResult>>(() => readHiddenResults(userId, tenant.id));
  const hiddenNow = useRef(hidden);
  hiddenNow.current = hidden;
  // Deleted here and not yet gone from the list the home reloads.
  const [deleted, setDeleted] = useState<ReadonlySet<string>>(() => new Set());
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [confirming, setConfirming] = useState<ReadonlyArray<CanvasRecord> | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const undoButton = useRef<HTMLButtonElement>(null);
  // A removed card takes the focus with it: it moves to the notice's 撤销, or to the heading.
  const focusNext = useRef<'undo' | 'heading' | null>(null);
  useEffect(() => {
    const target = focusNext.current;
    focusNext.current = null;
    if (target === 'undo') undoButton.current?.focus({ preventScroll: true });
    else if (target === 'heading') heading.current?.focus({ preventScroll: true });
  });

  // Every delivering canvas among the most recently updated ones, newest delivery first.
  const delivering = useMemo(() => [...(loaded ?? [])].filter(canvas => !deleted.has(canvas.id))
    .sort((a, b) => updatedAt(b) - updatedAt(a)).slice(0, RESULTS_GALLERY_CANDIDATES).flatMap<Entry>(canvas => {
      // The stored document as the canvas itself would read it (unknown parts dropped, never trusted as is).
      const result = canvasResult(sanitizeDocument(canvas.document));
      return result.final ? [{ canvas, final: result.final, pending: result.pending.length }] : [];
    }).sort((a, b) => b.final.output!.at - a.final.output!.at), [loaded, deleted]);
  // A removed result frees its place for the next one.
  const { shown, removedHere } = useMemo(() => {
    const keys = new Set(hidden.map(hiddenResultKey));
    const kept = delivering.filter(entry => !keys.has(hiddenResultKey(entryResult(entry))));
    return { shown: kept.slice(0, RESULTS_GALLERY_COUNT), removedHere: delivering.length - kept.length };
  }, [delivering, hidden]);
  // Nothing to say before the list has loaded and been read, or in a workspace without canvases (the list
  // invites the first).
  if (!loaded || !loaded.length) return null;

  const managing = selecting && shown.length > 0;
  const chosen = shown.filter(entry => selected.has(entry.canvas.id));
  const allChosen = chosen.length === shown.length;
  const store = (next: ReadonlyArray<HiddenResult>) => {
    hiddenNow.current = next;
    setHidden(next);
    return saveHiddenResults(userId, tenant.id, next);
  };
  const remove = (items: ReadonlyArray<Entry>) => {
    const known = new Set(hiddenNow.current.map(hiddenResultKey));
    const added = items.map(entryResult).filter(entry => !known.has(hiddenResultKey(entry)));
    if (!added.length) return;
    const saved = store([...hiddenNow.current, ...added]);
    setSelected(new Set());
    const text = items.length === 1
      ? t(`已从最近的成果中移除「${entryTitle(items[0])}」。画布还在，交付新的成果时会重新出现在这里。`, `Removed “${entryTitle(items[0])}” from Recent results. Its canvas is untouched, and a new delivery shows here again.`)
      : t(`已从最近的成果中移除 ${items.length} 项。画布都还在，交付新的成果时会重新出现在这里。`, `Removed ${items.length} results from Recent results. Their canvases are untouched, and new deliveries show here again.`);
    focusNext.current = 'undo';
    setNotice({ undo: added, text: saved ? text : text + t('这个浏览器不允许保存，刷新页面后它们会重新显示。', ' This browser refuses storage, so they show again after a reload.') });
  };
  const undo = (entries: ReadonlyArray<HiddenResult>) => {
    const back = new Set(entries.map(hiddenResultKey));
    store(hiddenNow.current.filter(entry => !back.has(hiddenResultKey(entry))));
    focusNext.current = 'heading';
    setNotice({ text: t('已撤销，成果回到了列表里。', 'Undone: the results are back on the list.') });
  };
  const restoreAll = () => {
    store([]);
    focusNext.current = 'heading';
    setNotice({ text: t('移除的成果已全部恢复。', 'Every removed result is back on the list.') });
  };
  const deletedCanvases = (ids: ReadonlyArray<string>) => {
    const gone = new Set(ids);
    setDeleted(value => new Set([...value, ...ids]));
    setSelected(value => new Set([...value].filter(id => !gone.has(id))));
    // A deleted canvas leaves nothing to hide.
    if (hiddenNow.current.some(entry => gone.has(entry.canvasId))) store(hiddenNow.current.filter(entry => !gone.has(entry.canvasId)));
    focusNext.current = 'heading';
    setNotice({ text: ids.length === 1 ? t('画布已删除。', 'Canvas deleted.') : t(`已删除 ${ids.length} 张画布。`, `Deleted ${ids.length} canvases.`) });
    onCanvasesDeleted?.(ids);
  };
  const toggle = (id: string) => setSelected(value => {
    const next = new Set(value);
    if (!next.delete(id)) next.add(id);
    return next;
  });
  const stopManaging = () => { setSelecting(false); setSelected(new Set()); };
  const state = (entry: Entry) => entry.final.state === 'partial' ? t('部分结果', 'Partial result')
    : entry.final.state === 'case' ? t('案例实录', 'Case recording')
    : entry.final.state === 'manual' ? t('手动发布', 'Published by hand') : t('运行交付', 'From a run');
  const body = (entry: Entry) => <>
    <ResultThumbnail step={entry.final} />
    <span className="saas-result-body">
      <strong>{entryTitle(entry)}</strong>
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
  </>;

  return <section className="saas-home-section saas-results-gallery" aria-labelledby={titleId}>
    <div className="saas-home-section-header">
      <div className="saas-home-section-title">
        <h2 id={titleId} ref={heading} tabIndex={-1}>{t('最近的成果', 'Recent results')}</h2>
        <p>{t('这个工作区的画布交付的成果，最新的在前。打开就是它的成果页，可以看到每一步怎么来的。', 'What this workspace’s canvases delivered, newest first. Each opens on its results, with every step that made it.')}</p>
      </div>
      {(shown.length > 0 || removedHere > 0) && <div className="saas-library-meta saas-results-tools" role="group" aria-label={t('管理最近的成果', 'Manage recent results')}>
        {managing ? <>
          <span className="saas-results-count">{t(`已选 ${chosen.length} 项`, `${chosen.length} selected`)}</span>
          <button type="button" className="saas-results-tool" onClick={() => setSelected(allChosen ? new Set() : new Set(shown.map(entry => entry.canvas.id)))}>{allChosen ? t('取消全选', 'Clear selection') : t('全选', 'Select all')}</button>
          <button type="button" className="saas-results-tool" disabled={!chosen.length} onClick={() => remove(chosen)}>{t('从最近的成果中移除', 'Remove from Recent results')}</button>
          {canDelete && <button type="button" className="saas-results-tool is-danger" disabled={!chosen.length} onClick={() => setConfirming(chosen.map(entry => entry.canvas))}>{t('删除所选画布', 'Delete selected canvases')}</button>}
          <button type="button" className="saas-results-tool" onClick={stopManaging}>{t('完成', 'Done')}</button>
        </> : <>
          {removedHere > 0 && <button type="button" className="saas-link" onClick={restoreAll}>{t(`已移除 ${removedHere} 项 · 全部恢复`, `${removedHere} removed · Restore all`)}</button>}
          {shown.length > 0 && <button type="button" className="saas-results-tool" onClick={() => { setNotice(null); setSelecting(true); }}>{t('管理', 'Manage')}</button>}
        </>}
      </div>}
    </div>
    <p className="saas-results-notice" role="status">{notice && <>{notice.text}{notice.undo && <>{' '}<button ref={undoButton} type="button" className="saas-link" onClick={() => undo(notice.undo!)}>{t('撤销', 'Undo')}</button></>}</>}</p>
    {shown.length ? <ul className={`saas-results-list${managing ? ' is-selecting' : ''}`}>{shown.map(entry => {
      const id = entry.canvas.id;
      return <li key={id} className={managing && selected.has(id) ? 'is-selected' : undefined}>
        {managing ? <label className="saas-result-card is-selectable">
          {/* While selecting, a click anywhere on the card ticks it instead of opening it. */}
          <input type="checkbox" className="saas-result-check" checked={selected.has(id)} onChange={() => toggle(id)}
            aria-label={t(`选择「${entryTitle(entry)}」（画布：${entry.canvas.name}）`, `Select “${entryTitle(entry)}” (canvas: ${entry.canvas.name})`)} />
          {body(entry)}
        </label> : <>
          <a className="saas-result-card" href={`/?${new URLSearchParams({ tenant: tenant.id, canvas: id, view: 'results' })}`}>{body(entry)}</a>
          {/* Beside the link, not in it: a link cannot hold buttons. */}
          <div className="saas-result-actions"><ActionMenu label={t(`成果选项：${entry.canvas.name}`, `Result options: ${entry.canvas.name}`)}>{close => <>
            <button type="button" onClick={() => { close(); remove([entry]); }}>{t('从最近的成果中移除', 'Remove from Recent results')}</button>
            {canDelete && <button type="button" className="saas-danger-action" onClick={() => { close(); setConfirming([entry.canvas]); }}>{t('删除画布…', 'Delete canvas…')}</button>}
          </>}</ActionMenu></div>
        </>}
      </li>;
    })}</ul>
      : <p className="saas-results-empty">{removedHere > 0 ? t('这里的成果都移除了，画布还在上面的「继续工作」里。', 'Every result here was removed; the canvases are still under Continue working above.')
        : tenant.role === 'reader' ? t('还没有交付。成员运行画布后，成果会出现在这里。', 'Nothing delivered yet. When a member runs a canvas, its result appears here.')
        : t('还没有交付。运行一张画布后，它交付的东西会出现在这里。', 'Nothing delivered yet. Run a canvas and what it delivers appears here.')}</p>}
    {confirming && canDelete && <DeleteCanvasesDialog key={confirming.map(canvas => canvas.id).join(' ')} tenantId={tenant.id} userId={userId} canvases={confirming}
      onDeleted={deletedCanvases} onClose={() => setConfirming(null)} />}
  </section>;
}

type Refusal = { canvas: CanvasRecord; error: unknown };

/** Deletes one or several canvases, one request each: a canvas the server refuses (an active run) stays
 *  listed with its reason, and the ones deleted are reported at once. */
function DeleteCanvasesDialog({ tenantId, userId, canvases, onDeleted, onClose }: {
  tenantId: string; userId?: string; canvases: ReadonlyArray<CanvasRecord>; onDeleted: (canvasIds: ReadonlyArray<string>) => void; onClose: () => void;
}) {
  const { locale, t } = useSaaSPreferences();
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const alive = useRef(true);
  const [busy, setBusy] = useState(false);
  // After a partial failure only the refused canvases are left to retry.
  const [remaining, setRemaining] = useState(canvases);
  const [refusals, setRefusals] = useState<ReadonlyArray<Refusal>>([]);
  const [done, setDone] = useState(0);
  useEffect(() => {
    alive.current = true; dialog.current?.showModal();
    return () => { alive.current = false; dialog.current?.close(); };
  }, []);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !remaining.length) return;
    setBusy(true); setRefusals([]);
    const deleted: string[] = [];
    const refused: Refusal[] = [];
    // One at a time: each deletion is its own transaction, and one refusal must not stop the rest.
    for (const canvas of remaining) {
      try {
        await api(tenantPath(tenantId, `/canvases/${encodeURIComponent(canvas.id)}`), { method: 'DELETE' });
        deleted.push(canvas.id);
        // A deleted canvas leaves nothing in this browser either.
        if (userId) void forgetCanvasStorage(userId, tenantId, canvas.id);
      } catch (error) { refused.push({ canvas, error }); }
      if (!alive.current) return;
    }
    if (deleted.length) onDeleted(deleted);
    if (!refused.length) { onClose(); return; }
    setDone(value => value + deleted.length);
    setRemaining(refused.map(item => item.canvas));
    setRefusals(refused);
    setBusy(false);
  };
  return <dialog ref={dialog} className="saas-native-dialog" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <form className="saas-card" onSubmit={submit}>
      <h2 id={titleId}>{canvases.length === 1 ? t('确认删除画布', 'Delete canvas?') : t(`确认删除 ${canvases.length} 张画布`, `Delete ${canvases.length} canvases?`)}</h2>
      {remaining.length === 1
        ? <p>{t(`确认删除“${remaining[0].name}”及其全部会话和运行历史？此操作无法撤销；正在运行的画布不能删除。`, `Delete “${remaining[0].name}” and all its conversations and run history? This cannot be undone. A canvas with active runs cannot be deleted.`)}</p>
        : <>
          <p>{t(`确认删除下面 ${remaining.length} 张画布及其全部会话和运行历史？此操作无法撤销；正在运行的画布不能删除。`, `Delete these ${remaining.length} canvases and all their conversations and run history? This cannot be undone. A canvas with active runs cannot be deleted.`)}</p>
          <ul className="saas-results-confirm-list">{remaining.map(canvas => <li key={canvas.id}>{canvas.name}</li>)}</ul>
        </>}
      <p className="saas-results-confirm-hint">{t('只想让成果不出现在首页，可以取消后改用「从最近的成果中移除」，画布会保留。', 'To only take results off the home, cancel and use “Remove from Recent results”; the canvases stay.')}</p>
      {refusals.length > 0 && <div role="alert" className="saas-error">
        {done > 0 && <p>{t(`已删除 ${done} 张，下面的没有删除：`, `Deleted ${done}. These were not:`)}</p>}
        <ul className="saas-results-confirm-list">{refusals.map(({ canvas, error }) => <li key={canvas.id}>
          {canvases.length > 1 && t(`${canvas.name}：`, `${canvas.name}: `)}{saasErrorMessage(error, locale)}
        </li>)}</ul>
      </div>}
      <div className="saas-draft-actions">
        <button type="button" disabled={busy} onClick={onClose}>{done > 0 ? t('关闭', 'Close') : t('取消', 'Cancel')}</button>
        <button className="saas-danger-button" disabled={busy || !remaining.length}>{busy ? t('请稍候…', 'Please wait…') : t('确认删除', 'Confirm deletion')}</button>
      </div>
    </form>
  </dialog>;
}

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
