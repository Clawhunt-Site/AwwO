// The 预览展示 node on the board (displayNodes.ts): what one component, or the whole canvas, made, running and
// playable the moment it is shown, with no button in between. Pages run as delivered in the results studio's sandbox
// (studio/LivePage.tsx); pictures, video, audio, 3D models, PDFs, documents and data each get their viewer. The content
// zooms (buttons, or Ctrl/⌘ + scroll), the window resizes from its corner and goes full screen without restarting what
// runs in it. The zoom is a way of looking and is never saved; position, size and what it shows are the document's.
//
// Read only: it shows published outputs (studio/studioModel.ts) and the bytes the server stores for them, exactly as an
// enlarged card or the studio does, and it never edits, runs or publishes a node.
import { memo, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { AlertTriangle, ChevronLeft, FileText, Loader2, Maximize, Minimize, MonitorPlay, RotateCw, SquareArrowOutUpRight, Star, Trash2, ZoomIn, ZoomOut } from 'lucide-react';
import type { DeliveryState } from './canvasResultModel';
import { DeliverableMarkdown } from './DeliverableMarkdown';
import { clampZoom, DISPLAY_LIVE_MIN_PX, DISPLAY_ZOOM_STEPS, displayLinkPath, stepZoom, type DisplayNode, type DisplaySource } from './displayNodes';
import { useDisplayText, type DisplayTranslate } from './displayCopy';
import { useCanvasI18n } from './i18n';
import { ModelPreview } from './ModelPreview';
import { PdfPreview } from './PdfPreview';
import { canvasFileBytes, canvasResolver } from './studio/canvasAssets';
import { LivePage } from './studio/LivePage';
import { decodeText, entryMediaUrl, mimeOfName, type LoadedFile } from './studio/studioData';
import { isTextKind, kindOfName, kindOfType, type StudioEntry, type StudioGroup, type StudioKind } from './studio/studioModel';
import './studio/studio.css';
import './card-preview.css';
import './display-tile.css';

/** A component the display can be pointed at. */
export interface DisplayChoice { id: string; title: string }

export interface DisplayTileProps {
  display: DisplayNode;
  /** Every component that delivered, the canvas's result first (studioGroups). Stable between unrelated edits. */
  groups: ReadonlyArray<StudioGroup>;
  /** The components it can show, in step order. */
  choices: ReadonlyArray<DisplayChoice>;
  /** Every file of the canvas, so a page can show a picture another node made. */
  canvasEntries: ReadonlyArray<StudioEntry>;
  /** Components working right now. */
  running: ReadonlySet<string>;
  /** The board's zoom: drags are in world units, and far out the display shows its summary instead of running. */
  scale: number;
  selected?: boolean;
  onSelect?: (id: string) => void;
  /** Absent on a canvas opened to read: the display is looked at, not edited. */
  onMove?: (id: string, x: number, y: number) => void;
  onResize?: (id: string, w: number, h: number) => void;
  onChangeSource?: (id: string, source: DisplaySource) => void;
  onDelete?: (id: string) => void;
  /** The results studio, on one component's files or the whole canvas's. */
  onOpenStudio?: (nodeId?: string, entryId?: string) => void;
}

/** Media keep their own size and grow inside a scrolling stage; everything else is laid out at the zoomed size. */
const MAGNIFY_KINDS: ReadonlySet<StudioKind> = new Set(['image', 'video', 'model', 'pdf']);
const TEXT_LIMIT = 60_000;
const DRAG_THRESHOLD_PX = 3;

function stateLabel(state: DeliveryState, d: DisplayTranslate): string | null {
  return state === 'partial' ? d('display.statePartial') : state === 'manual' ? d('display.stateManual') : state === 'case' ? d('display.stateCase') : null;
}

/** A stored file's bytes (or a generated 3D model's), from the canvas's shared cache. */
function useEntryBytes(entry: StudioEntry) {
  const wanted = entry.source.type === 'stored' || (entry.source.type === 'media' && entry.kind === 'model');
  const [loaded, setLoaded] = useState<{ id: string; file: LoadedFile | null } | null>(null);
  useEffect(() => {
    if (!wanted) return;
    let live = true;
    void canvasFileBytes(entry).then(file => { if (live) setLoaded({ id: entry.id, file }); });
    return () => { live = false; };
  }, [entry.id, wanted]);
  const current = loaded?.id === entry.id ? loaded : null;
  return { wanted, file: current?.file ?? null, state: !wanted ? 'none' as const : !current ? 'loading' as const : current.file ? 'ready' as const : 'failed' as const };
}

/** An object URL for bytes the browser plays itself (a stored picture, clip or sound), released with them. */
function useObjectUrl(bytes: Uint8Array | null, type: string): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!bytes || typeof URL.createObjectURL !== 'function') { setUrl(null); return; }
    const made = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
    setUrl(made);
    return () => URL.revokeObjectURL(made);
  }, [bytes, type]);
  return url;
}

/**
 * The content at a zoom. `layout` lays the content out in a box 1/zoom the stage's size and scales it back, so zooming
 * out shows a page's whole desktop layout in a small window and zooming in reads it closer, without a scroll of its
 * own. `magnify` grows media inside a scrolling stage, kept centred while it is smaller than the stage.
 */
function ZoomStage({ zoom, mode, children }: { zoom: number; mode: 'layout' | 'magnify'; children: ReactNode }) {
  if (mode === 'magnify') {
    return <div className="awwo-display-stage is-magnify" data-zoom-mode="magnify">
      <div className="awwo-display-magnify" style={{ width: `${zoom * 100}%`, height: `${zoom * 100}%` }}>{children}</div>
    </div>;
  }
  return <div className="awwo-display-stage is-layout" data-zoom-mode="layout">
    <div className="awwo-display-zoom" style={zoom === 1 ? undefined : { width: `${100 / zoom}%`, height: `${100 / zoom}%`, transform: `scale(${zoom})` }}>{children}</div>
  </div>;
}

interface EntryViewProps {
  entry: StudioEntry;
  canvasEntries: ReadonlyArray<StudioEntry>;
  /** The content zoom, or null where the view around it is zoomed already (the overview). */
  zoom: number | null;
  onOpenStudio?: (nodeId?: string, entryId?: string) => void;
}

/** One deliverable, live. */
function EntryView({ entry, canvasEntries, zoom, onOpenStudio }: EntryViewProps) {
  const { t } = useCanvasI18n();
  const d = useDisplayText();
  const bytes = useEntryBytes(entry);
  const file = bytes.file;
  const name = (entry.source.type === 'stored' && file?.name) || entry.name;
  // What a stored file turns out to be once read: by its real name, then its type, then whether it is text.
  const resolved = useMemo((): { kind: StudioKind; text: string | null } => {
    if (entry.source.type === 'inline') return { kind: entry.kind, text: entry.source.text };
    if (entry.source.type !== 'stored' || !file) return { kind: entry.kind, text: null };
    const named = kindOfName(name);
    const kind = named !== 'file' ? named : kindOfType(file.contentType);
    if (kind && !isTextKind(kind)) return { kind, text: null };
    const text = decodeText(file.bytes);
    return { kind: kind ?? (text !== null ? 'text' : 'file'), text };
  }, [entry, file, name]);
  const kind = resolved.kind;
  const playable = kind === 'image' || kind === 'video' || kind === 'audio';
  const mime = file ? file.contentType.split(';')[0].trim() || mimeOfName(name) : '';
  const blobUrl = useObjectUrl(entry.source.type === 'stored' && file && playable ? file.bytes : null, mime);
  const mediaUrl = entry.source.type === 'media' ? entryMediaUrl(entry) : blobUrl;
  const resolve = useMemo(() => canvasResolver(canvasEntries, entry.id), [canvasEntries, entry.id]);

  const fileBox = (note?: string, warning = false) => <div className={`awwo-display-empty${warning ? ' is-warning' : ''}`}>
    {warning ? <AlertTriangle size={20} aria-hidden="true" /> : <FileText size={20} aria-hidden="true" />}
    <p>{note ?? name}</p>
    {onOpenStudio && entry.source.type !== 'missing' ? <button type="button" onClick={() => onOpenStudio(entry.nodeId, entry.id)}>{t('studio.open')}</button> : null}
  </div>;

  let body: ReactNode;
  if (kind === 'missing') body = fileBox(t('studio.missingFile', { name: entry.source.type === 'missing' ? entry.source.claimed : entry.name }), true);
  else if (bytes.state === 'loading') body = <div className="awwo-display-empty" role="status"><Loader2 size={18} className="awwo-studio-spin" aria-hidden="true" /></div>;
  else if (bytes.state === 'failed') body = fileBox(d('display.unreadable'), true);
  else if (kind === 'page' && resolved.text !== null) body = <LivePage html={resolved.text} title={entry.name} path={entry.name} resolve={resolve} />;
  else if (kind === 'image' && mediaUrl) body = <img className="awwo-display-picture" src={mediaUrl} alt={entry.name} draggable={false} />;
  else if (kind === 'video' && mediaUrl) body = <video className="awwo-display-picture" src={mediaUrl} controls playsInline preload="metadata" />;
  else if (kind === 'audio' && mediaUrl) body = <div className="awwo-display-audio"><audio src={mediaUrl} controls preload="metadata" /><span>{name}</span></div>;
  else if (kind === 'model' && file) body = <div className="awwo-display-model"><ModelPreview file={{ name, bytes: file.bytes }} /></div>;
  else if (kind === 'pdf' && file) body = <div className="awwo-display-pdf"><PdfPreview file={{ name, bytes: file.bytes }} /></div>;
  else if (kind === 'markdown' && resolved.text !== null) body = <div className="awwo-display-doc awwo-markdown-preview"><DeliverableMarkdown>{resolved.text}</DeliverableMarkdown></div>;
  else if (resolved.text !== null) body = <pre className="awwo-display-text">{resolved.text.length > TEXT_LIMIT ? `${resolved.text.slice(0, TEXT_LIMIT)}\n…` : resolved.text}</pre>;
  else body = fileBox();

  if (zoom === null) return <div className="awwo-display-entry" data-kind={kind}>{body}</div>;
  return <div className="awwo-display-entry" data-kind={kind}><ZoomStage zoom={zoom} mode={MAGNIFY_KINDS.has(kind) ? 'magnify' : 'layout'}>{body}</ZoomStage></div>;
}

interface OverviewProps {
  groups: ReadonlyArray<StudioGroup>;
  running: ReadonlySet<string>;
  canvasEntries: ReadonlyArray<StudioEntry>;
  zoom: number;
  onShow: (nodeId: string) => void;
  onOpenStudio?: (nodeId?: string, entryId?: string) => void;
}

/** The whole canvas: its result large, every other component's deliverable beside it, each one live. */
function Overview({ groups, running, canvasEntries, zoom, onShow, onOpenStudio }: OverviewProps) {
  const d = useDisplayText();
  const hero = groups.find(group => group.final) ?? groups[0];
  const rest = groups.filter(group => group !== hero);
  const card = (group: StudioGroup, isHero: boolean) => {
    const entry = group.entries.find(item => item.primary) ?? group.entries[0];
    const state = stateLabel(group.state, d);
    return <article key={group.nodeId} className={`awwo-display-card${isHero ? ' is-hero' : ''}${running.has(group.nodeId) ? ' is-running' : ''}`}
      aria-label={group.title} data-node-id={group.nodeId}>
      <header>
        {group.final ? <Star size={13} aria-hidden="true" className="awwo-display-star" /> : null}
        <strong title={group.title}>{group.title}</strong>
        {group.final && groups.length > 1 ? <span className="awwo-display-badge is-final">{d('display.final')}</span> : null}
        {state ? <span className="awwo-display-badge">{state}</span> : null}
        {running.has(group.nodeId) ? <span className="awwo-display-badge is-running">{d('display.runningShort')}</span> : null}
        <button type="button" onClick={() => onShow(group.nodeId)}>{d('display.only')}</button>
      </header>
      <div className="awwo-display-card-body">{entry ? <EntryView entry={entry} canvasEntries={canvasEntries} zoom={null} onOpenStudio={onOpenStudio} /> : null}</div>
    </article>;
  };
  return <div className="awwo-display-entry" data-kind="overview"><ZoomStage zoom={zoom} mode="layout">
    <div className={`awwo-display-overview${rest.length ? '' : ' is-single'}`}>
      {card(hero, true)}
      {rest.length ? <div className="awwo-display-strip">{rest.map(group => card(group, false))}</div> : null}
    </div>
  </ZoomStage></div>;
}

function Notice({ children, busy = false, warning = false }: { children: ReactNode; busy?: boolean; warning?: boolean }) {
  return <div className={`awwo-display-empty${warning ? ' is-warning' : ''}`} role={busy ? 'status' : undefined}>
    {busy ? <Loader2 size={20} className="awwo-studio-spin" aria-hidden="true" /> : warning ? <AlertTriangle size={20} aria-hidden="true" /> : <MonitorPlay size={22} aria-hidden="true" />}
    <p>{children}</p>
  </div>;
}

/** Follow a press until it is released, in screen pixels from where it started; iframes on the board stop taking the
 *  pointer meanwhile (a page under a fast drag would otherwise swallow the move). */
function track(event: ReactPointerEvent, root: HTMLElement | null, onMove: (dx: number, dy: number) => void) {
  const px = event.clientX, py = event.clientY;
  const board = root?.closest('.canvas-root');
  board?.classList.add('is-display-dragging');
  let started = false;
  const move = (pointer: PointerEvent) => {
    if (!started && Math.abs(pointer.clientX - px) <= DRAG_THRESHOLD_PX && Math.abs(pointer.clientY - py) <= DRAG_THRESHOLD_PX) return;
    started = true;
    onMove(pointer.clientX - px, pointer.clientY - py);
  };
  const up = () => {
    board?.classList.remove('is-display-dragging');
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

export const DisplayTile = memo(function DisplayTile({
  display, groups, choices, canvasEntries, running, scale, selected = false,
  onSelect, onMove, onResize, onChangeSource, onDelete, onOpenStudio,
}: DisplayTileProps) {
  const { t } = useCanvasI18n();
  const d = useDisplayText();
  const rootRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  // On a whole-canvas display: the one component picked to be shown alone, or null for all of them.
  const [tab, setTab] = useState<string | null>(null);
  // The file shown, per component, where a component delivered several.
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [reloadKey, setReloadKey] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const fullscreenRef = useRef(fullscreen);
  fullscreenRef.current = fullscreen;
  const scaleRef = useRef(scale);
  scaleRef.current = scale;

  const source = display.source;
  const sourceNodeId = source.type === 'node' ? source.nodeId : null;
  useEffect(() => { setTab(null); }, [source.type, sourceNodeId]);
  const tabGroup = !sourceNodeId && tab ? groups.find(group => group.nodeId === tab) : undefined;
  // A picked component that has nothing to show any more (deleted, or its result cleared) falls back to all.
  useEffect(() => { if (tab && !tabGroup) setTab(null); }, [tab, tabGroup]);
  const nodeId = sourceNodeId ?? tabGroup?.nodeId ?? null;
  const group = nodeId ? groups.find(item => item.nodeId === nodeId) : undefined;
  const choice = nodeId ? choices.find(item => item.id === nodeId) : undefined;
  const missing = Boolean(sourceNodeId) && !choice;
  const nodeTitle = choice?.title ?? group?.title ?? '';
  const label = display.title.trim() || (sourceNodeId ? (missing ? d('display.sourceMissing') : nodeTitle) : d('display.sourceCanvas'));
  const busy = sourceNodeId ? running.has(sourceNodeId) : choices.some(item => running.has(item.id));
  const entries = group?.entries ?? [];
  const entry = (group && entries.find(item => item.id === chosen[group.nodeId])) || entries.find(item => item.primary) || entries[0];
  const live = fullscreen || (display.w * scale >= DISPLAY_LIVE_MIN_PX.w && display.h * scale >= DISPLAY_LIVE_MIN_PX.h);
  const percent = Math.round(zoom * 100);

  // Full screen holds this very element, so whatever runs in it keeps running.
  useEffect(() => {
    const sync = () => setFullscreen(typeof document !== 'undefined' && document.fullscreenElement === rootRef.current && rootRef.current !== null);
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);
  const toggleFullscreen = useCallback(() => {
    const element = rootRef.current;
    if (!element) return;
    if (document.fullscreenElement === element) { void document.exitFullscreen?.()?.catch?.(() => undefined); return; }
    const studio = () => onOpenStudio?.(nodeId ?? undefined, entry?.id);
    if (typeof element.requestFullscreen !== 'function') { studio(); return; }
    void element.requestFullscreen().catch(studio);
  }, [onOpenStudio, nodeId, entry?.id]);

  // Scrolling over the content belongs to the content (a page, a document); Ctrl/⌘ + scroll zooms it. Over the head the
  // board zooms as it does over any card, except in full screen, where the board is out of sight.
  useEffect(() => {
    const element = rootRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      const target = event.target as HTMLElement | null;
      if (!fullscreenRef.current && !target?.closest?.('.awwo-display-body')) return;
      event.stopPropagation();
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        setZoom(current => clampZoom(current * Math.exp(-event.deltaY * 0.002)));
      }
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, []);

  // A press anywhere is the display's, never the board's: the content takes its own presses (a game, a page), and the
  // head drags the window.
  const onPointerDown = useCallback((event: ReactPointerEvent) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    onSelect?.(display.id);
    const target = event.target as HTMLElement | null;
    if (fullscreenRef.current || !onMove || !target?.closest?.('.awwo-display-head') || target.closest('button, select, input, textarea, a')) return;
    event.preventDefault();
    const ox = display.x, oy = display.y;
    track(event, rootRef.current, (dx, dy) => {
      const s = scaleRef.current || 1;
      onMove(display.id, Math.round(ox + dx / s), Math.round(oy + dy / s));
    });
  }, [display.id, display.x, display.y, onMove, onSelect]);

  const onResizePointerDown = useCallback((event: ReactPointerEvent) => {
    event.stopPropagation();
    if (event.button !== 0 || !onResize) return;
    event.preventDefault();
    onSelect?.(display.id);
    const ow = display.w, oh = display.h;
    track(event, rootRef.current, (dx, dy) => {
      const s = scaleRef.current || 1;
      onResize(display.id, ow + dx / s, oh + dy / s);
    });
  }, [display.id, display.w, display.h, onResize, onSelect]);

  const sourceValue = sourceNodeId ? `node:${sourceNodeId}` : 'canvas';
  const changeSource = (value: string) => {
    if (!onChangeSource || value === sourceValue) return;
    onChangeSource(display.id, value === 'canvas' ? { type: 'canvas' } : { type: 'node', nodeId: value.slice('node:'.length) });
  };

  let content: ReactNode;
  if (!sourceNodeId && !tabGroup) {
    content = groups.length
      ? <Overview groups={groups} running={running} canvasEntries={canvasEntries} zoom={zoom} onShow={setTab} onOpenStudio={onOpenStudio} />
      : <Notice busy={busy}>{d('display.emptyCanvas')}</Notice>;
  } else if (missing) {
    content = <Notice warning>{d('display.missingNode')}</Notice>;
  } else if (!group || !entry) {
    content = busy ? <Notice busy>{d('display.running', { title: nodeTitle })}</Notice> : <Notice>{d('display.emptyNode', { title: nodeTitle })}</Notice>;
  } else {
    content = <>
      {running.has(group.nodeId) ? <p className="awwo-display-note" role="status"><Loader2 size={12} className="awwo-studio-spin" aria-hidden="true" />{d('display.redoing')}</p> : null}
      <EntryView key={entry.id} entry={entry} canvasEntries={canvasEntries} zoom={zoom} onOpenStudio={onOpenStudio} />
    </>;
  }

  const chips: ReactNode = !sourceNodeId && !tabGroup
    ? groups.length > 1 ? <>
      <button type="button" aria-pressed="true">{d('display.all')}</button>
      {groups.map(item => <button key={item.nodeId} type="button" aria-pressed="false" title={item.title} onClick={() => setTab(item.nodeId)}>
        {item.final ? <Star size={11} aria-hidden="true" /> : null}<span>{item.title}</span></button>)}
    </> : null
    : <>
      {tabGroup ? <button type="button" className="awwo-display-back" onClick={() => setTab(null)}><ChevronLeft size={13} aria-hidden="true" />{d('display.back')}</button> : null}
      {tabGroup ? <strong className="awwo-display-chip-title" title={tabGroup.title}>{tabGroup.title}</strong> : null}
      {group && entries.length > 1 ? entries.map(item => <button key={item.id} type="button" aria-pressed={item.id === entry?.id} title={item.name}
        onClick={() => setChosen(previous => ({ ...previous, [group.nodeId]: item.id }))}><span>{item.name}</span></button>) : null}
    </>;

  return (
    <div
      ref={rootRef}
      className={`canvas-tile awwo-node awwo-display${selected ? ' canvas-tile--selected' : ''}${busy ? ' is-running' : ''}${fullscreen ? ' is-fullscreen' : ''}${live ? '' : ' is-far'}`}
      style={{ left: display.x, top: display.y, width: display.w, height: display.h }}
      data-testid={`canvas-display-${display.id}`}
      data-display-id={display.id}
      data-source={source.type}
      role="group"
      aria-label={d('display.frame', { title: label })}
      onPointerDown={onPointerDown}
      onDoubleClick={event => {
        event.stopPropagation();
        const target = event.target as HTMLElement | null;
        if (target?.closest?.('.awwo-display-head') && !target.closest('button, select')) toggleFullscreen();
      }}
      onContextMenu={event => event.stopPropagation()}
    >
      <div className="canvas-tile-head awwo-display-head">
        <span className="canvas-tile-glyph awwo-display-glyph" aria-hidden="true"><MonitorPlay size={15} /></span>
        <span className="canvas-tile-title awwo-display-title" title={label}>{display.title.trim() || d('display.label')}</span>
        <select className="awwo-display-source" aria-label={d('display.source')} title={label} value={sourceValue} disabled={!onChangeSource}
          onChange={event => changeSource(event.target.value)}>
          <option value="canvas">{d('display.sourceCanvas')}</option>
          {choices.map(item => <option key={item.id} value={`node:${item.id}`}>{item.title}</option>)}
          {missing ? <option value={sourceValue} disabled>{d('display.sourceMissing')}</option> : null}
        </select>
        <div className="awwo-node-tools awwo-display-tools">
          <button type="button" aria-label={d('display.reload')} title={d('display.reload')} onClick={() => setReloadKey(value => value + 1)}><RotateCw size={14} /></button>
          <button type="button" aria-label={d(fullscreen ? 'display.exitFullscreen' : 'display.fullscreen')} title={d(fullscreen ? 'display.exitFullscreen' : 'display.fullscreen')}
            aria-pressed={fullscreen} onClick={toggleFullscreen}>{fullscreen ? <Minimize size={14} /> : <Maximize size={14} />}</button>
          {onOpenStudio && groups.length > 0 ? <button type="button" aria-label={t('studio.open')} title={t('studio.open')}
            onClick={() => onOpenStudio(nodeId ?? undefined, entry?.id)}><SquareArrowOutUpRight size={14} /></button> : null}
          {onDelete && !fullscreen ? <button type="button" aria-label={d('display.delete')} title={d('display.delete')} onClick={() => onDelete(display.id)}><Trash2 size={14} /></button> : null}
        </div>
      </div>
      {live ? <div className="awwo-display-bar">
        <div className="awwo-display-chips" role="group" aria-label={group ? d('display.files', { title: group.title }) : d('display.sourceCanvas')}>{chips}</div>
        <div className="awwo-display-zoom-tools" role="group" aria-label={`${d('display.zoomOut')} / ${d('display.zoomIn')}`}>
          <button type="button" aria-label={d('display.zoomOut')} title={d('display.zoomOut')} disabled={zoom <= DISPLAY_ZOOM_STEPS[0] + 1e-6}
            onClick={() => setZoom(value => stepZoom(value, -1))}><ZoomOut size={14} /></button>
          <button type="button" className="awwo-display-zoom-value" aria-label={d('display.zoomReset', { percent })} title={d('display.zoomReset', { percent })}
            onClick={() => setZoom(1)}>{percent}%</button>
          <button type="button" aria-label={d('display.zoomIn')} title={d('display.zoomIn')} disabled={zoom >= DISPLAY_ZOOM_STEPS[DISPLAY_ZOOM_STEPS.length - 1] - 1e-6}
            onClick={() => setZoom(value => stepZoom(value, 1))}><ZoomIn size={14} /></button>
        </div>
      </div> : null}
      <div className="awwo-display-body">
        {live ? <div className="awwo-display-content" key={reloadKey}>{content}</div>
          : <div className="awwo-display-summary" style={{ fontSize: Math.max(10, Math.min(14 / Math.max(0.05, scale), (display.h - 60) / 8, display.w / 12)) }}>
            <MonitorPlay aria-hidden="true" />
            <strong>{label}</strong>
            {(sourceNodeId ? entries.length : groups.length) > 0 ? <span>{d('display.count', { count: sourceNodeId ? entries.length : groups.length })}</span> : null}
            <small>{d('display.farAway')}</small>
          </div>}
      </div>
      {onResize && !fullscreen ? <button type="button" className="awwo-card-resize awwo-display-resize" data-testid={`canvas-display-resize-${display.id}`}
        aria-label={d('display.resize')} onPointerDown={onResizePointerDown} onDoubleClick={event => event.stopPropagation()} /> : null}
    </div>
  );
});

type Box = { x: number; y: number; w: number; h: number };

/** The dashed links from each component to the displays showing it, under the cards. */
export function DisplayLinks({ displays, boxes }: { displays: ReadonlyArray<DisplayNode>; boxes: ReadonlyMap<string, Box> }) {
  const links = displays.flatMap(display => {
    const from = display.source.type === 'node' ? boxes.get(display.source.nodeId) : undefined;
    return from ? [{ id: display.id, path: displayLinkPath(from, display) }] : [];
  });
  if (!links.length) return null;
  return <svg className="canvas-wires awwo-display-links" width="1" height="1" aria-hidden="true" data-testid="canvas-display-links">
    {links.map(link => <path key={link.id} className="awwo-display-link" d={link.path} />)}
  </svg>;
}
