// 成果工作台 — every file a canvas (or one node) made, in one place: a file tree with search across names and
// contents, the right viewer for each file (a page running as written, rendered Markdown, highlighted code, images
// with zoom, video, audio, 3D, PDF, tables, archives opened in place), and downloads one by one or all at once.
//
// Read only. It shows published outputs (studioModel.ts) and the bytes the server stores for them; nothing here
// edits a node, publishes, or runs anything outside the page sandbox (liveDocument.ts).
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle, Archive, Box, ChevronDown, ChevronRight, Clapperboard, Code2, Copy, Download, ExternalLink, Eye, File as FileIcon, FileCode2, FileImage,
  FileJson, FileText, FileVideo, Folder, FolderDown, Loader2, Maximize2, Minimize2, Monitor, Music, PanelLeft, RotateCw, Search,
  Smartphone, SquareArrowOutUpRight, Table2, Tablet, X, ZoomIn, ZoomOut,
} from 'lucide-react';
import type { CanvasEdge, CanvasNode, ReviewGraphPolicy } from '../canvasDoc';
import { useCanvasI18n, type CanvasTextKey } from '../i18n';
import { DeliverableMarkdown } from '../DeliverableMarkdown';
import { marketPageNodes } from '../marketPages';
import { ModelPreview } from '../ModelPreview';
import { PdfPreview } from '../PdfPreview';
import { highlight, languageOf, type Token } from './codeHighlight';
import { DEVICE_WIDTH, LivePage, type LiveDevice } from './LivePage';
import { standaloneWrapper, type AssetResolver } from './liveDocument';
import { pickCanvasFile } from './canvasAssets';
import { RenderVideoPanel, useRenderCapability } from './RenderVideoPanel';
import { buildArchive, decodeText, entryMediaUrl, fetchEntryBytes, mimeOfName, saveBlob, unzipMembers, type LoadedFile } from './studioData';
import { formatBytes, isTextKind, kindOfName, kindOfType, studioGroups, type StudioEntry, type StudioGroup, type StudioKind } from './studioModel';
import './studio.css';

export interface DeliverableStudioProps {
  nodes: ReadonlyArray<CanvasNode>;
  edges: ReadonlyArray<CanvasEdge>;
  execution?: ReviewGraphPolicy;
  /** Only this node's deliverables; absent shows the whole canvas. */
  nodeId?: string;
  initialEntryId?: string;
  title: string;
  /** dialog: a window over the page; embedded: fills the element it is placed in (the 成果 view). */
  variant?: 'dialog' | 'embedded';
  onClose?: () => void;
  onOpenNode?: (nodeId: string) => void;
  /** Every file of the canvas, for a page that names a file another node made (a node-scoped studio included). */
  assetEntries?: ReadonlyArray<StudioEntry>;
  /** Select this node's main deliverable whenever it changes (the 成果 view's step list). */
  focusNodeId?: string;
}

type Loaded = { state: 'loading' } | { state: 'ready'; file: LoadedFile; text: string | null; url?: string } | { state: 'error'; reason: string };
type ContentHit = { entryId: string; line: number; snippet: string; column: number };

const KIND_ICON: Record<StudioKind, typeof FileIcon> = {
  page: FileCode2, markdown: FileText, text: FileText, code: Code2, data: FileJson, table: Table2, image: FileImage, video: FileVideo,
  audio: Music, model: Box, pdf: FileText, archive: Archive, file: FileIcon, missing: AlertTriangle,
};
const KIND_LABEL: Record<StudioKind, CanvasTextKey> = {
  page: 'studio.kindPage', markdown: 'studio.kindMarkdown', text: 'studio.kindText', code: 'studio.kindCode', data: 'studio.kindData',
  table: 'studio.kindTable', image: 'studio.kindImage', video: 'studio.kindVideo', audio: 'studio.kindAudio', model: 'studio.kindModel',
  pdf: 'studio.kindPdf', archive: 'studio.kindArchive', file: 'studio.kindFile', missing: 'studio.kindMissing',
};
const STATE_LABEL: Record<StudioGroup['state'], CanvasTextKey> = {
  run: 'results.stateRun', partial: 'results.statePartial', manual: 'results.stateManual', case: 'results.stateCase', none: 'results.stateNone',
};
const PREVIEWABLE: ReadonlySet<StudioKind> = new Set(['page', 'markdown', 'table']);
/** The studio's own width (px) at and below which its file tree is laid over the file instead of beside it; studio.css
 *  wraps the header at the same width (@container awwo-studio). */
const STUDIO_NARROW = 760;

/** An entry as the studio shows it once its bytes are known: a stored file takes its real name and kind. */
function shown(entry: StudioEntry, loaded?: Loaded): StudioEntry {
  if (entry.source.type !== 'stored' || loaded?.state !== 'ready') return entry;
  const name = loaded.file.name || entry.name;
  const kind = kindOfName(name) !== 'file' ? kindOfName(name) : kindOfType(loaded.file.contentType) ?? (loaded.text !== null ? 'text' : 'file');
  return { ...entry, name, kind, size: loaded.file.bytes.length };
}

export function DeliverableStudio({ nodes, edges, execution, nodeId, initialEntryId, title, variant = 'dialog', onClose, onOpenNode, assetEntries, focusNodeId }: DeliverableStudioProps) {
  const { t, locale } = useCanvasI18n();
  const groups = useMemo(() => studioGroups({ nodes: [...nodes], edges: [...edges], execution }, nodeId), [nodes, edges, execution, nodeId]);
  const [loaded, setLoaded] = useState<Record<string, Loaded>>({});
  const loadedRef = useRef(loaded); loadedRef.current = loaded;
  const [members, setMembers] = useState<Record<string, StudioEntry[] | 'loading' | 'error'>>({});
  const [openArchives, setOpenArchives] = useState<Record<string, boolean>>({});
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const flat = useMemo(() => {
    const list: StudioEntry[] = [];
    for (const group of groups) for (const entry of group.entries) {
      list.push(entry);
      const inside = members[entry.id];
      if (Array.isArray(inside)) list.push(...inside);
    }
    return list;
  }, [groups, members]);
  const firstId = initialEntryId && flat.some(entry => entry.id === initialEntryId) ? initialEntryId
    : groups[0]?.entries.find(entry => entry.primary)?.id ?? groups[0]?.entries[0]?.id ?? null;
  const [selectedId, setSelectedId] = useState<string | null>(firstId);
  const selectedSource = flat.find(entry => entry.id === selectedId) ?? flat.find(entry => entry.id === firstId) ?? null;
  const selected = selectedSource ? shown(selectedSource, loaded[selectedSource.id]) : null;
  const marketNodes = useMemo(() => marketPageNodes(nodes, edges), [nodes, edges]);
  const [mode, setMode] = useState<'preview' | 'code'>('preview');
  const [device, setDevice] = useState<LiveDevice>('desktop');
  const [reloadKey, setReloadKey] = useState(0);
  const [query, setQuery] = useState('');
  const [jump, setJump] = useState<{ entryId: string; line: number } | null>(null);
  // The file tree follows the studio's own width, not the window's (inline in the 成果 view the studio can be far
  // narrower: beside the assistant's panel, say). Wider than STUDIO_NARROW it sits beside the file and starts open; at
  // that width or below it lies over the file (studio.css) and starts closed. Crossing that width folds it away, or
  // brings back what the reader last chose while it sat beside the file (open, until they close it); the toggle decides
  // in between. A studio not laid out yet (its dialog before it opens) keeps the window's guess until its first width.
  // Closing it with focus inside moves focus to its toggle, never to the page's body.
  const root = useRef<HTMLDivElement>(null);
  const treeToggle = useRef<HTMLButtonElement>(null);
  const [sidebar, setSidebar] = useState(() => typeof window === 'undefined' || window.innerWidth > STUDIO_NARROW);
  const wideSeen = useRef<boolean | null>(null);
  const wideChoice = useRef(true);
  /** Closes the tree, focus inside it going to the toggle first (the tree's buttons leave the page with it). */
  const foldTree = useCallback(() => {
    if (root.current?.querySelector('.awwo-studio-tree')?.contains(document.activeElement)) treeToggle.current?.focus();
    setSidebar(false);
  }, []);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return undefined;
    const follow = (width: number) => {
      if (width <= 0) return;
      const wide = width > STUDIO_NARROW;
      if (wideSeen.current === wide) return;
      wideSeen.current = wide;
      if (wide) setSidebar(wideChoice.current); else foldTree();
    };
    follow(element.clientWidth);
    if (typeof ResizeObserver !== 'function') return undefined;
    // The content box's width as the container query reads it, fractions included (clientWidth rounds).
    const observer = new ResizeObserver(entries => follow(entries[0]?.contentBoxSize?.[0]?.inlineSize ?? element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, [foldTree]);
  /** Whether the tree lies over the file now: what the stylesheet laid out, where the tree is drawn; else the studio's
   *  width (the window's before the studio has one). */
  const treeOverFile = () => {
    const tree = root.current?.querySelector('.awwo-studio-tree');
    if (tree) return getComputedStyle(tree).position === 'absolute';
    const width = root.current?.clientWidth ?? 0;
    return width > 0 ? width <= STUDIO_NARROW : typeof window !== 'undefined' && window.innerWidth <= STUDIO_NARROW;
  };
  /** The reader opening or closing the tree: while it sits beside the file, what a widening brings back. */
  const setTreeOpen = (open: boolean) => {
    if (!treeOverFile()) wideChoice.current = open;
    if (open) setSidebar(true); else foldTree();
  };
  const [maximized, setMaximized] = useState(false);
  const [notice, setNotice] = useState<{ text: string; href?: string } | null>(null);
  const [bundling, setBundling] = useState<{ done: number; total: number } | null>(null);
  // The document the live page built, with the entry it was built for: a page still building, or another one
  // chosen since, never hands its predecessor's document to Open in a new tab or Render.
  const pageDocument = useRef<{ entryId: string; html: string } | null>(null);
  // Counts the builds, so the render panel can look up a page's earlier renders once its document exists.
  const [pageBuilds, setPageBuilds] = useState(0);
  // Rendering a page as a video: offered on a cloud canvas whose server has a render worker (RenderVideoPanel.tsx).
  const renderCapability = useRenderCapability();
  const [rendering, setRendering] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const controllers = useRef(new Set<AbortController>());
  useEffect(() => () => { for (const controller of controllers.current) controller.abort(); }, []);

  /** Load (once) and cache an entry's bytes; text kinds are decoded, binary kinds get an object URL. */
  const load = useCallback((entry: StudioEntry): Promise<LoadedFile | null> => {
    const current = loadedRef.current[entry.id];
    if (current?.state === 'ready') return Promise.resolve(current.file);
    if (current?.state === 'loading') {
      return new Promise(resolve => {
        const poll = setInterval(() => {
          const value = loadedRef.current[entry.id];
          if (value?.state !== 'loading') { clearInterval(poll); resolve(value?.state === 'ready' ? value.file : null); }
        }, 120);
      });
    }
    if (entry.source.type === 'missing') return Promise.resolve(null);
    const controller = new AbortController();
    controllers.current.add(controller);
    setLoaded(previous => ({ ...previous, [entry.id]: { state: 'loading' } }));
    return fetchEntryBytes(entry, controller.signal).then(file => {
      const name = file.name || entry.name;
      const kind = entry.source.type === 'stored' ? (kindOfName(name) !== 'file' ? kindOfName(name) : kindOfType(file.contentType) ?? 'file') : entry.kind;
      const text = isTextKind(kind) || kind === 'file' ? decodeText(file.bytes) : null;
      const binary = !text && ['image', 'video', 'audio'].includes(kind);
      const url = binary ? URL.createObjectURL(new Blob([file.bytes.slice().buffer as ArrayBuffer], { type: file.contentType && !/octet-stream/.test(file.contentType) ? file.contentType : mimeOfName(name) })) : undefined;
      setLoaded(previous => ({ ...previous, [entry.id]: { state: 'ready', file, text, ...(url ? { url } : {}) } }));
      return file;
    }).catch(error => {
      if (!controller.signal.aborted) setLoaded(previous => ({ ...previous, [entry.id]: { state: 'error', reason: error instanceof Error ? error.message : 'studio_unavailable' } }));
      return null;
    }).finally(() => controllers.current.delete(controller));
  }, []);
  // Object URLs live as long as the studio.
  useEffect(() => () => { for (const value of Object.values(loadedRef.current)) if (value.state === 'ready' && value.url) URL.revokeObjectURL(value.url); }, []);

  // The selected file loads as soon as it is chosen (an inline value needs nothing).
  useEffect(() => {
    if (!selectedSource || selectedSource.source.type === 'inline' || selectedSource.source.type === 'missing') return;
    if (selectedSource.source.type === 'media' && (selectedSource.kind === 'image' || selectedSource.kind === 'video')) return;
    void load(selectedSource);
  }, [selectedSource?.id, load]);

  const toggleArchive = useCallback((entry: StudioEntry) => {
    const open = !openArchives[entry.id];
    setOpenArchives(previous => ({ ...previous, [entry.id]: open }));
    if (!open || members[entry.id]) return;
    setMembers(previous => ({ ...previous, [entry.id]: 'loading' }));
    const controller = new AbortController();
    controllers.current.add(controller);
    void load(entry).then(async file => {
      if (!file) throw new Error('studio_unavailable');
      const inside = await unzipMembers(file.bytes, controller.signal);
      setMembers(previous => ({ ...previous, [entry.id]: inside.map(member => {
        const parts = member.path.split('/');
        const name = parts.pop()!;
        return { id: `${entry.id}::${member.path}`, nodeId: entry.nodeId, nodeTitle: entry.nodeTitle, folder: [...entry.folder, entry.name.replace(/\.zip$/i, ''), ...parts],
          name, label: member.path, kind: kindOfName(name), state: entry.state, size: member.bytes.length,
          source: { type: 'member', parentId: entry.id, path: member.path, bytes: member.bytes } };
      }) }));
    }).catch(() => setMembers(previous => ({ ...previous, [entry.id]: 'error' }))).finally(() => controllers.current.delete(controller));
  }, [openArchives, members, load]);

  // A stored archive opens in place when it is the file selected.
  useEffect(() => {
    if (selected?.kind === 'archive' && !openArchives[selected.id] && !members[selected.id]) toggleArchive(selected);
  }, [selected?.id, selected?.kind]);

  /** What a page's relative URLs point at: its archive's own files, or (for a page a node published) any file of the
   *  canvas with that name, such as a picture another node generated. */
  const resolverFor = useCallback((entry: StudioEntry): AssetResolver => async (path: string) => {
    if (entry.source.type === 'member') {
      const siblings = members[entry.source.parentId];
      if (!Array.isArray(siblings)) return null;
      const match = siblings.find(item => item.source.type === 'member' && item.source.path === path)
        ?? siblings.find(item => item.source.type === 'member' && item.source.path.toLowerCase() === path.toLowerCase());
      return match && match.source.type === 'member' ? { bytes: match.source.bytes, name: match.name } : null;
    }
    const pool = assetEntries ? [...flat, ...assetEntries.filter(item => !flat.some(own => own.id === item.id))] : flat;
    // Every image node calls its first picture image-1.jpg: a page names which by the node folder, `<node id>/image-1.jpg`
    // (pickCanvasFile). Matching the name alone gave every chapter of a page the first node's picture.
    const candidate = pickCanvasFile(pool, path, entry.id, item => shown(item, loadedRef.current[item.id]).name);
    if (!candidate) return null;
    const file = await load(candidate);
    return file ? { bytes: file.bytes, name: file.name || candidate.name } : null;
  }, [members, flat, load, assetEntries]);
  const selectedResolver = useMemo(() => selected ? resolverFor(selected) : undefined, [selected?.id, resolverFor]);
  // The 成果 view's step list picks a step: show its main deliverable.
  useEffect(() => {
    if (!focusNodeId) return;
    const group = groups.find(item => item.nodeId === focusNodeId);
    const entry = group?.entries.find(item => item.primary) ?? group?.entries[0];
    if (entry) { setSelectedId(entry.id); setJump(null); setMode('preview'); }
    // Lying over the file, the tree would hide the step's deliverable.
    if (entry && treeOverFile()) foldTree();
  }, [focusNodeId]);

  // Content search: inline values and every text file already read; text-like stored files are read when a search starts.
  const lowered = query.trim().toLowerCase();
  const searching = lowered.length >= 2;
  useEffect(() => {
    if (!searching) return;
    for (const entry of flat) {
      if (entry.source.type === 'stored' && !loadedRef.current[entry.id] && (isTextKind(kindOfName(entry.name)) || entry.kind === 'file')) void load(entry);
    }
  }, [searching, flat, load]);
  const textOf = useCallback((entry: StudioEntry): string | null => {
    if (entry.source.type === 'inline') return entry.source.text;
    if (entry.source.type === 'member' && isTextKind(entry.kind)) return decodeText(entry.source.bytes);
    const value = loaded[entry.id];
    return value?.state === 'ready' ? value.text : null;
  }, [loaded]);
  const hits = useMemo<ContentHit[]>(() => {
    if (lowered.length < 2) return [];
    const found: ContentHit[] = [];
    for (const entry of flat) {
      const text = textOf(entry);
      if (!text) continue;
      const lines = text.split(/\r?\n/);
      for (let index = 0; index < lines.length && found.length < 300; index += 1) {
        const column = lines[index].toLowerCase().indexOf(lowered);
        if (column < 0) continue;
        const start = Math.max(0, column - 36);
        found.push({ entryId: entry.id, line: index + 1, column, snippet: `${start ? '…' : ''}${lines[index].slice(start, column + lowered.length + 60)}` });
      }
    }
    return found;
  }, [lowered, flat, textOf]);
  const nameMatches = (entry: StudioEntry) => !lowered || [entry.name, entry.label, entry.nodeTitle, ...entry.folder].some(value => value.toLowerCase().includes(lowered));

  const choose = (entry: StudioEntry, line?: number) => {
    setSelectedId(entry.id);
    setJump(line ? { entryId: entry.id, line } : null);
    if (line) setMode('code');
    else setMode(PREVIEWABLE.has(shown(entry, loaded[entry.id]).kind) || !isTextKind(shown(entry, loaded[entry.id]).kind) ? 'preview' : 'code');
    setReloadKey(0);
    if (treeOverFile()) foldTree();
  };

  const downloadSelected = async () => {
    if (!selected) return;
    if (selected.source.type === 'inline') {
      saveBlob(new Blob([selected.source.text], { type: `${mimeOfName(selected.name, 'text/plain')};charset=utf-8` }), selected.name);
      return;
    }
    const file = await load(selected);
    if (file) saveBlob(new Blob([file.bytes.slice().buffer as ArrayBuffer], { type: file.contentType || mimeOfName(selected.name) }), shown(selected, loadedRef.current[selected.id]).name);
    else setNotice({ text: t('studio.downloadFailed') });
  };
  const downloadAll = async () => {
    if (bundling) return;
    const controller = new AbortController();
    controllers.current.add(controller);
    const entries = groups.flatMap(group => group.entries);
    setBundling({ done: 0, total: entries.length });
    try {
      const blob = await buildArchive(entries, controller.signal, (done, total) => setBundling({ done, total }));
      saveBlob(blob, `${title.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]+/g, '-').trim() || 'awwo'}-${locale === 'zh' ? '成果' : 'deliverables'}.zip`);
    } catch { if (!controller.signal.aborted) setNotice({ text: t('studio.downloadFailed') }); }
    finally { controllers.current.delete(controller); setBundling(null); }
  };
  const openInTab = () => {
    if (!selected) return;
    let url: string | null = null;
    const built = pageDocument.current?.entryId === selected.id ? pageDocument.current.html : null;
    if (selected.kind === 'page' && built) {
      url = URL.createObjectURL(new Blob([standaloneWrapper(selected.name, built)], { type: 'text/html;charset=utf-8' }));
    } else {
      const value = loaded[selected.id];
      // SVG can carry script: it is never opened as a document of this site.
      if (value?.state === 'ready' && value.url && !/svg/i.test(value.file.contentType || selected.name)) url = value.url;
      else if (selected.source.type === 'media') url = entryMediaUrl(selected);
    }
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
  };
  const copySelected = async () => {
    const text = selected ? textOf(selected) : null;
    if (text === null) return;
    try { await navigator.clipboard.writeText(text); setNotice({ text: t('studio.copied') }); } catch { setNotice({ text: t('studio.copyFailed') }); }
  };
  useEffect(() => {
    if (!notice || notice.href) return;
    const timer = setTimeout(() => setNotice(null), 2200);
    return () => clearTimeout(timer);
  }, [notice]);

  // Keyboard: Escape closes a studio window; Ctrl/⌘ + F or P searches.
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (!root.current?.contains(document.activeElement) && variant === 'embedded') return;
      if ((event.ctrlKey || event.metaKey) && (event.key === 'f' || event.key === 'p')) {
        event.preventDefault(); setTreeOpen(true); requestAnimationFrame(() => searchRef.current?.focus());
      }
    };
    document.addEventListener('keydown', keydown, true);
    return () => document.removeEventListener('keydown', keydown, true);
  }, [variant]);

  const total = groups.reduce((sum, group) => sum + group.entries.length, 0);
  const selectedLoaded = selected ? loaded[selected.id] : undefined;
  const selectedText = selected ? textOf(selected) : null;
  const hasPreview = selected ? PREVIEWABLE.has(selected.kind) : false;
  const canCode = selected ? isTextKind(selected.kind) && (selectedText !== null || selected.source.type === 'inline') : false;
  const showCode = canCode && (mode === 'code' || !hasPreview);

  const header = <header className="awwo-studio-header">
    <button type="button" className="awwo-studio-icon" aria-label={t(sidebar ? 'studio.hideFiles' : 'studio.showFiles')} title={t(sidebar ? 'studio.hideFiles' : 'studio.showFiles')}
      ref={treeToggle} aria-pressed={sidebar} onClick={() => setTreeOpen(!sidebar)}><PanelLeft size={16} aria-hidden="true" /></button>
    <div className="awwo-studio-title"><h2 id={titleId}>{title}</h2><span>{t('studio.fileCount', { count: total })}</span></div>
    {selected && <div className="awwo-studio-file" title={selected.label}>
      {(() => { const Icon = KIND_ICON[selected.kind]; return <Icon size={15} aria-hidden="true" />; })()}
      <strong>{selected.name}</strong>
    </div>}
    <div className="awwo-studio-tools">
      {hasPreview && canCode && <div className="awwo-studio-segment" role="group" aria-label={t('studio.viewMode')}>
        <button type="button" aria-pressed={!showCode} onClick={() => setMode('preview')}><Eye size={14} aria-hidden="true" />{t('studio.preview')}</button>
        <button type="button" aria-pressed={showCode} onClick={() => setMode('code')}><Code2 size={14} aria-hidden="true" />{t('studio.code')}</button>
      </div>}
      {selected?.kind === 'page' && !showCode && <div className="awwo-studio-segment is-icons" role="group" aria-label={t('studio.device')}>
        {(['desktop', 'tablet', 'mobile'] as const).map(value => {
          const Icon = value === 'desktop' ? Monitor : value === 'tablet' ? Tablet : Smartphone;
          const label = t(value === 'desktop' ? 'studio.deviceDesktop' : value === 'tablet' ? 'studio.deviceTablet' : 'studio.deviceMobile');
          return <button key={value} type="button" aria-pressed={device === value} aria-label={label} title={DEVICE_WIDTH[value] ? `${label} · ${DEVICE_WIDTH[value]}px` : label} onClick={() => setDevice(value)}><Icon size={14} aria-hidden="true" /></button>;
        })}
      </div>}
      {selected?.kind === 'page' && !showCode && <button type="button" className="awwo-studio-icon" aria-label={t('studio.reload')} title={t('studio.reload')} onClick={() => setReloadKey(value => value + 1)}><RotateCw size={15} aria-hidden="true" /></button>}
      {selected?.kind === 'page' && !showCode && renderCapability && <button type="button" className="awwo-studio-icon" aria-label={t('studio.renderVideo')} title={t('studio.renderVideo')}
        aria-pressed={rendering} onClick={() => setRendering(value => !value)}><Clapperboard size={15} aria-hidden="true" /></button>}
      {selected && (selected.kind === 'page' || selected.kind === 'image' || selected.kind === 'video' || selected.kind === 'pdf') && <button type="button" className="awwo-studio-icon"
        aria-label={t('studio.openInTab')} title={t('studio.openInTab')} onClick={openInTab}><ExternalLink size={15} aria-hidden="true" /></button>}
      {selectedText !== null && <button type="button" className="awwo-studio-icon" aria-label={t('studio.copy')} title={t('studio.copy')} onClick={() => { void copySelected(); }}><Copy size={15} aria-hidden="true" /></button>}
      {selected && selected.kind !== 'missing' && <button type="button" className="awwo-studio-icon" aria-label={t('studio.downloadFile')} title={t('studio.downloadFile')} onClick={() => { void downloadSelected(); }}><Download size={15} aria-hidden="true" /></button>}
      <button type="button" className="awwo-studio-action" disabled={!total || Boolean(bundling)} onClick={() => { void downloadAll(); }}>
        {bundling ? <Loader2 size={14} aria-hidden="true" className="awwo-studio-spin" /> : <FolderDown size={14} aria-hidden="true" />}
        <span>{bundling ? t('studio.bundling', { done: bundling.done, total: bundling.total }) : t('studio.downloadAll')}</span>
      </button>
      {variant === 'dialog' && <button type="button" className="awwo-studio-icon" aria-label={t(maximized ? 'studio.restore' : 'studio.maximize')} title={t(maximized ? 'studio.restore' : 'studio.maximize')}
        onClick={() => setMaximized(value => !value)}>{maximized ? <Minimize2 size={15} aria-hidden="true" /> : <Maximize2 size={15} aria-hidden="true" />}</button>}
      {onClose && <button type="button" className="awwo-studio-icon awwo-studio-close" aria-label={t('studio.close')} title={t('studio.close')} onClick={onClose}><X size={17} aria-hidden="true" /></button>}
    </div>
  </header>;

  const tree = <nav className="awwo-studio-tree" aria-label={t('studio.files')}>
    <label className="awwo-studio-search"><Search size={14} aria-hidden="true" />
      <input ref={searchRef} type="search" value={query} placeholder={t('studio.searchPlaceholder')} aria-label={t('studio.searchPlaceholder')}
        onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Escape' && query) { event.stopPropagation(); setQuery(''); } }} />
    </label>
    {lowered.length >= 2 && <section className="awwo-studio-hits" aria-label={t('studio.contentMatches')}>
      <h3>{t('studio.contentMatches')}<span>{hits.length >= 300 ? '300+' : hits.length}</span></h3>
      {hits.length ? <ul>{hits.slice(0, 120).map(hit => {
        const entry = flat.find(item => item.id === hit.entryId)!;
        const before = hit.snippet.toLowerCase().indexOf(lowered);
        return <li key={`${hit.entryId}:${hit.line}:${hit.column}`}><button type="button" onClick={() => choose(entry, hit.line)} title={`${entry.name}:${hit.line}`}>
          <span className="awwo-studio-hit-file">{shown(entry, loaded[entry.id]).name}<small>:{hit.line}</small></span>
          <span className="awwo-studio-hit-text">{before >= 0 ? <>{hit.snippet.slice(0, before)}<mark>{hit.snippet.slice(before, before + lowered.length)}</mark>{hit.snippet.slice(before + lowered.length)}</> : hit.snippet}</span>
        </button></li>;
      })}</ul> : <p>{t('studio.noContentMatch')}</p>}
    </section>}
    <div className="awwo-studio-groups">
      {groups.map(group => {
        const visible = group.entries.filter(entry => nameMatches(entry) || (Array.isArray(members[entry.id]) && (members[entry.id] as StudioEntry[]).some(nameMatches)));
        if (lowered && !visible.length && !group.title.toLowerCase().includes(lowered)) return null;
        const closed = collapsed[group.nodeId] && !lowered;
        return <section key={group.nodeId} className={`awwo-studio-group${group.final ? ' is-final' : ''}`}>
          <button type="button" className="awwo-studio-group-head" aria-expanded={!closed} onClick={() => setCollapsed(previous => ({ ...previous, [group.nodeId]: !closed }))}>
            {closed ? <ChevronRight size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
            <Folder size={14} aria-hidden="true" /><span title={group.title}>{group.title}</span>
            {group.final ? <em className="awwo-studio-badge is-final">{t('studio.finalBadge')}</em> : group.state !== 'run' ? <em className={`awwo-studio-badge is-${group.state}`}>{t(STATE_LABEL[group.state])}</em> : null}
          </button>
          {!closed && <ul>{(lowered ? visible : group.entries).map(entry => <TreeItem key={entry.id} entry={shown(entry, loaded[entry.id])} depth={0} selectedId={selected?.id ?? null}
            loading={loaded[entry.id]?.state === 'loading'} archive={entry.kind === 'archive' || shown(entry, loaded[entry.id]).kind === 'archive'}
            open={Boolean(openArchives[entry.id])} members={members[entry.id]} filter={lowered ? nameMatches : undefined}
            onChoose={choose} onToggle={() => toggleArchive(entry)} t={t} />)}</ul>}
        </section>;
      })}
      {!groups.length && <p className="awwo-studio-empty">{t('studio.empty')}</p>}
    </div>
  </nav>;

  let body: ReactNode;
  if (!selected) body = <div className="awwo-studio-placeholder"><FileIcon size={28} aria-hidden="true" /><p>{t('studio.empty')}</p></div>;
  else if (selected.kind === 'missing') body = <div className="awwo-studio-placeholder is-warning"><AlertTriangle size={26} aria-hidden="true" />
    <p>{t('studio.missingFile', { name: selected.source.type === 'missing' ? selected.source.claimed : selected.name })}</p>
    {onOpenNode && <button type="button" onClick={() => onOpenNode(selected.nodeId)}>{t('studio.openNode')}</button>}</div>;
  else if (showCode) body = selectedText === null ? <Pending loaded={selectedLoaded} t={t} />
    : <CodeView key={selected.id} name={selected.name} text={selected.kind === 'data' ? prettyJson(selectedText) : selectedText}
      line={jump?.entryId === selected.id ? jump.line : undefined} query={lowered} t={t} />;
  else if (selected.kind === 'page') body = selectedText === null ? <Pending loaded={selectedLoaded} t={t} />
    : <LivePage key={selected.id} html={selectedText} title={selected.name} path={selected.source.type === 'member' ? selected.source.path : selected.name}
      resolve={selectedResolver} device={device} reloadKey={reloadKey} market={marketNodes.has(selected.nodeId)} onDocument={document => { pageDocument.current = { entryId: selected.id, html: document }; setPageBuilds(count => count + 1); }}
      onLink={href => setNotice({ text: t('studio.linkBlocked'), href })} />;
  else if (selected.kind === 'markdown') body = selectedText === null ? <Pending loaded={selectedLoaded} t={t} />
    : <div className="awwo-studio-doc awwo-markdown-preview"><DeliverableMarkdown>{selectedText}</DeliverableMarkdown></div>;
  else if (selected.kind === 'table') body = selectedText === null ? <Pending loaded={selectedLoaded} t={t} /> : <TableView text={selectedText} tsv={/\.tsv$/i.test(selected.name)} t={t} />;
  else if (selected.kind === 'image') {
    const url = selectedLoaded?.state === 'ready' ? selectedLoaded.url : entryMediaUrl(selected);
    body = url ? <ImageView key={selected.id} url={url} name={selected.name} t={t} /> : <Pending loaded={selectedLoaded} t={t} />;
  } else if (selected.kind === 'video') {
    const url = selectedLoaded?.state === 'ready' ? selectedLoaded.url : entryMediaUrl(selected);
    body = url ? <div className="awwo-studio-media"><video key={selected.id} src={url} controls playsInline preload="metadata" /></div> : <Pending loaded={selectedLoaded} t={t} />;
  } else if (selected.kind === 'audio') {
    body = selectedLoaded?.state === 'ready' && selectedLoaded.url ? <div className="awwo-studio-media is-audio"><Music size={40} aria-hidden="true" /><audio src={selectedLoaded.url} controls preload="metadata" /></div> : <Pending loaded={selectedLoaded} t={t} />;
  } else if (selected.kind === 'model') {
    body = selectedLoaded?.state === 'ready' ? <div className="awwo-studio-model"><ModelPreview file={{ name: selectedLoaded.file.name || selected.name, bytes: selectedLoaded.file.bytes }} /></div> : <Pending loaded={selectedLoaded} t={t} />;
  } else if (selected.kind === 'pdf') {
    body = selectedLoaded?.state === 'ready' ? <div className="awwo-studio-pdf"><PdfPreview file={{ name: selectedLoaded.file.name || selected.name, bytes: selectedLoaded.file.bytes }} /></div> : <Pending loaded={selectedLoaded} t={t} />;
  } else if (selected.kind === 'archive') {
    const inside = members[selected.id];
    const pages = Array.isArray(inside) ? inside.filter(item => item.kind === 'page') : [];
    const index = pages.find(item => /(?:^|\/)index\.html?$/i.test(item.source.type === 'member' ? item.source.path : item.name)) ?? pages[0];
    body = <div className="awwo-studio-placeholder"><Archive size={28} aria-hidden="true" />
      <p>{inside === 'loading' || selectedLoaded?.state === 'loading' ? t('studio.archiveOpening') : inside === 'error' ? t('studio.archiveFailed')
        : Array.isArray(inside) ? t('studio.archiveCount', { count: inside.length }) : t('studio.archiveOpening')}</p>
      {index && <button type="button" onClick={() => choose(index)}><Eye size={14} aria-hidden="true" />{t('studio.archiveRun', { name: index.name })}</button>}</div>;
  } else body = selectedText !== null ? <CodeView key={selected.id} name={selected.name} text={selectedText} query={lowered} t={t} />
    : selectedLoaded?.state === 'ready' ? <div className="awwo-studio-placeholder"><FileIcon size={28} aria-hidden="true" /><p>{t('studio.binaryFile', { size: formatBytes(selectedLoaded.file.bytes.length) })}</p>
      <button type="button" onClick={() => { void downloadSelected(); }}><Download size={14} aria-hidden="true" />{t('studio.downloadFile')}</button></div>
      : <Pending loaded={selectedLoaded} t={t} />;

  const status = selected && <footer className="awwo-studio-status">
    <span>{t(KIND_LABEL[selected.kind])}</span>
    {selected.size !== undefined || selectedLoaded?.state === 'ready' ? <span>{formatBytes(selected.size ?? (selectedLoaded?.state === 'ready' ? selectedLoaded.file.bytes.length : undefined))}</span> : null}
    {selectedText !== null ? <span>{t('studio.lines', { count: selectedText.split('\n').length })}</span> : null}
    <span className="awwo-studio-status-node">{t('studio.fromNode', { title: selected.nodeTitle })}</span>
    {selected.kind === 'page' && !showCode ? <span className="awwo-studio-status-sandbox">{t('studio.sandboxNote')}</span> : null}
    {onOpenNode && <button type="button" onClick={() => onOpenNode(selected.nodeId)}><SquareArrowOutUpRight size={13} aria-hidden="true" />{t('studio.openNode')}</button>}
  </footer>;

  const content = <div ref={root} className={`awwo-studio is-${variant}${maximized ? ' is-maximized' : ''}${sidebar ? ' has-sidebar' : ''}`}
    role={variant === 'embedded' ? 'region' : undefined} aria-labelledby={titleId}>
    {header}
    <div className="awwo-studio-body">
      {sidebar && tree}
      <main className="awwo-studio-main">{body}</main>
      {rendering && selected?.kind === 'page' && !showCode && renderCapability && <RenderVideoPanel key={selected.id} nodeId={selected.nodeId} pageName={selected.name}
        capability={renderCapability} documentOf={() => pageDocument.current?.entryId === selected.id ? pageDocument.current.html : null} documentVersion={pageBuilds}
        onClose={() => setRendering(false)} />}
    </div>
    {status}
    {notice && <div className="awwo-studio-toast" role="status"><span>{notice.text}</span>
      {notice.href && <a href={notice.href} target="_blank" rel="noopener noreferrer" onClick={() => setNotice(null)}>{t('studio.openLink')}</a>}
      <button type="button" aria-label={t('studio.dismiss')} onClick={() => setNotice(null)}><X size={13} aria-hidden="true" /></button></div>}
  </div>;

  if (variant === 'embedded') return content;
  return <StudioDialog labelledBy={titleId} onClose={onClose}>{content}</StudioDialog>;
}

function TreeItem({ entry, depth, selectedId, loading, archive, open, members, filter, onChoose, onToggle, t }: {
  entry: StudioEntry; depth: number; selectedId: string | null; loading: boolean; archive: boolean; open: boolean;
  members?: StudioEntry[] | 'loading' | 'error'; filter?: (entry: StudioEntry) => boolean;
  onChoose: (entry: StudioEntry) => void; onToggle: () => void; t: ReturnType<typeof useCanvasI18n>['t'];
}) {
  const Icon = KIND_ICON[entry.kind];
  const children = Array.isArray(members) ? (filter ? members.filter(filter) : members) : [];
  return <li>
    <div className={`awwo-studio-item${entry.id === selectedId ? ' is-selected' : ''}${entry.kind === 'missing' ? ' is-missing' : ''}`} style={{ paddingLeft: 10 + depth * 14 }}>
      {archive ? <button type="button" className="awwo-studio-disclose" aria-label={t(open ? 'studio.collapseArchive' : 'studio.expandArchive', { name: entry.name })} aria-expanded={open} onClick={onToggle}>
        {open ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}</button> : <span className="awwo-studio-disclose" aria-hidden="true" />}
      <button type="button" className="awwo-studio-item-open" aria-current={entry.id === selectedId ? 'true' : undefined} title={entry.label !== entry.name ? `${entry.name} · ${entry.label}` : entry.name} onClick={() => onChoose(entry)}>
        {loading ? <Loader2 size={14} aria-hidden="true" className="awwo-studio-spin" /> : <Icon size={14} aria-hidden="true" />}
        <span className="awwo-studio-item-name">{entry.name}</span>
        {entry.primary && <i className="awwo-studio-primary" aria-label={t('studio.primary')} title={t('studio.primary')} />}
        {entry.size !== undefined ? <small>{formatBytes(entry.size)}</small> : null}
      </button>
    </div>
    {archive && open && (members === 'loading' ? <p className="awwo-studio-tree-note" style={{ paddingLeft: 34 + depth * 14 }}><Loader2 size={12} aria-hidden="true" className="awwo-studio-spin" />{t('studio.archiveOpening')}</p>
      : members === 'error' ? <p className="awwo-studio-tree-note is-error" style={{ paddingLeft: 34 + depth * 14 }}>{t('studio.archiveFailed')}</p>
        : <ArchiveTree entries={children} depth={depth + 1} selectedId={selectedId} onChoose={onChoose} t={t} />)}
  </li>;
}

/** An archive's files, nested by folder. */
function ArchiveTree({ entries, depth, selectedId, onChoose, t }: { entries: StudioEntry[]; depth: number; selectedId: string | null; onChoose: (entry: StudioEntry) => void; t: ReturnType<typeof useCanvasI18n>['t'] }) {
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  type Folder = { name: string; path: string; folders: Map<string, Folder>; files: StudioEntry[] };
  const rootFolder: Folder = { name: '', path: '', folders: new Map(), files: [] };
  for (const entry of entries) {
    const parts = entry.source.type === 'member' ? entry.source.path.split('/').slice(0, -1) : [];
    let folder = rootFolder;
    for (const part of parts) {
      if (!folder.folders.has(part)) folder.folders.set(part, { name: part, path: `${folder.path}${part}/`, folders: new Map(), files: [] });
      folder = folder.folders.get(part)!;
    }
    folder.files.push(entry);
  }
  const render = (folder: Folder, level: number): ReactNode => <>
    {[...folder.folders.values()].sort((a, b) => a.name.localeCompare(b.name)).map(child => <li key={child.path}>
      <button type="button" className="awwo-studio-folder" style={{ paddingLeft: 10 + level * 14 }} aria-expanded={!closed[child.path]} onClick={() => setClosed(previous => ({ ...previous, [child.path]: !previous[child.path] }))}>
        {closed[child.path] ? <ChevronRight size={13} aria-hidden="true" /> : <ChevronDown size={13} aria-hidden="true" />}<Folder size={13} aria-hidden="true" /><span>{child.name}</span>
      </button>
      {!closed[child.path] && <ul>{render(child, level + 1)}</ul>}
    </li>)}
    {folder.files.map(entry => <TreeItem key={entry.id} entry={entry} depth={level} selectedId={selectedId} loading={false} archive={false} open={false} onChoose={onChoose} onToggle={() => {}} t={t} />)}
  </>;
  return <ul>{render(rootFolder, depth)}</ul>;
}

function Pending({ loaded, t }: { loaded?: Loaded; t: ReturnType<typeof useCanvasI18n>['t'] }) {
  if (loaded?.state === 'error') {
    const key: CanvasTextKey = loaded.reason === 'studio_too_large' ? 'studio.tooLarge' : loaded.reason === 'studio_gone' ? 'studio.gone' : 'studio.unavailable';
    return <div className="awwo-studio-placeholder is-warning" role="alert"><AlertTriangle size={24} aria-hidden="true" /><p>{t(key)}</p></div>;
  }
  return <div className="awwo-studio-placeholder" role="status"><Loader2 size={22} aria-hidden="true" className="awwo-studio-spin" /><p>{t('studio.loading')}</p></div>;
}

function prettyJson(text: string): string {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}

/** Highlighted, numbered, searchable source. */
function CodeView({ name, text, line, query, t }: { name: string; text: string; line?: number; query: string; t: ReturnType<typeof useCanvasI18n>['t'] }) {
  const [wrap, setWrap] = useState(false);
  const lines = useMemo(() => highlight(text, languageOf(name)), [text, name]);
  const total = text.split(/\r?\n/).length;
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!line) return;
    container.current?.querySelector<HTMLElement>(`[data-line="${line}"]`)?.scrollIntoView({ block: 'center' });
  }, [line, text]);
  return <div className="awwo-studio-code-wrap">
    <div className="awwo-studio-code-tools"><span>{languageOf(name) === 'plain' ? t('studio.kindText') : languageOf(name).toUpperCase()}</span>
      <label><input type="checkbox" checked={wrap} onChange={event => setWrap(event.target.checked)} />{t('studio.wrapLines')}</label></div>
    <div ref={container} className={`awwo-studio-code${wrap ? ' is-wrapped' : ''}`} role="region" aria-label={t('studio.codeRegion', { name })} tabIndex={0}>
      {lines.map((tokens, index) => <div key={index} data-line={index + 1} className={index + 1 === line ? 'is-target' : undefined}>
        <span className="awwo-studio-gutter" aria-hidden="true">{index + 1}</span>
        <code>{tokens.length ? tokens.map((token, position) => <TokenView key={position} token={token} query={query} />) : ' '}</code>
      </div>)}
      {total > lines.length && <p className="awwo-studio-code-more">{t('studio.linesLimited', { count: lines.length })}</p>}
    </div>
  </div>;
}

function TokenView({ token, query }: { token: Token; query: string }) {
  if (!query || query.length < 2) return <span className={`tk-${token.type}`}>{token.text}</span>;
  const lower = token.text.toLowerCase();
  const parts: ReactNode[] = [];
  let last = 0, index = lower.indexOf(query);
  while (index >= 0) {
    parts.push(token.text.slice(last, index), <mark key={index}>{token.text.slice(index, index + query.length)}</mark>);
    last = index + query.length; index = lower.indexOf(query, last);
  }
  parts.push(token.text.slice(last));
  return <span className={`tk-${token.type}`}>{parts}</span>;
}

/** CSV/TSV as a table (quoted fields, the first 1000 rows). */
function TableView({ text, tsv, t }: { text: string; tsv: boolean; t: ReturnType<typeof useCanvasI18n>['t'] }) {
  const rows = useMemo(() => {
    const out: string[][] = [];
    const separator = tsv ? '\t' : ',';
    let row: string[] = [], cell = '', quoted = false;
    for (let index = 0; index < text.length && out.length < 1001; index += 1) {
      const char = text[index];
      if (quoted) {
        if (char === '"' && text[index + 1] === '"') { cell += '"'; index += 1; }
        else if (char === '"') quoted = false;
        else cell += char;
      } else if (char === '"' && !cell) quoted = true;
      else if (char === separator) { row.push(cell); cell = ''; }
      else if (char === '\n' || char === '\r') {
        if (char === '\r' && text[index + 1] === '\n') index += 1;
        row.push(cell); out.push(row); row = []; cell = '';
      } else cell += char;
    }
    if (cell || row.length) { row.push(cell); out.push(row); }
    return out;
  }, [text, tsv]);
  const [head, ...body] = rows;
  return <div className="awwo-studio-table-wrap"><table className="awwo-studio-table">
    {head && <thead><tr>{head.map((cell, index) => <th key={index} scope="col">{cell}</th>)}</tr></thead>}
    <tbody>{body.slice(0, 1000).map((row, index) => <tr key={index}>{row.map((cell, column) => <td key={column}>{cell}</td>)}</tr>)}</tbody>
  </table>{rows.length > 1000 && <p className="awwo-studio-code-more">{t('studio.rowsLimited', { count: 1000 })}</p>}</div>;
}

/** A picture to look at closely: fit or actual size, zoom with the wheel, drag to pan. */
function ImageView({ url, name, t }: { url: string; name: string; t: ReturnType<typeof useCanvasI18n>['t'] }) {
  const [zoom, setZoom] = useState<number | 'fit'>('fit');
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const scale = zoom === 'fit' ? null : zoom;
  const change = (factor: number) => { setZoom(current => Math.min(8, Math.max(.1, (current === 'fit' ? 1 : current) * factor))); };
  return <div className="awwo-studio-image">
    <div className="awwo-studio-image-tools">
      <button type="button" aria-label={t('studio.zoomOut')} onClick={() => change(1 / 1.25)}><ZoomOut size={14} aria-hidden="true" /></button>
      <button type="button" aria-pressed={zoom === 'fit'} onClick={() => { setZoom('fit'); setOffset({ x: 0, y: 0 }); }}>{t('studio.fit')}</button>
      <button type="button" aria-pressed={zoom === 1} onClick={() => { setZoom(1); setOffset({ x: 0, y: 0 }); }}>100%</button>
      <button type="button" aria-label={t('studio.zoomIn')} onClick={() => change(1.25)}><ZoomIn size={14} aria-hidden="true" /></button>
      {scale ? <span>{Math.round(scale * 100)}%</span> : null}
      {size ? <span>{size.w} × {size.h}</span> : null}
    </div>
    <div className={`awwo-studio-image-stage${zoom === 'fit' ? ' is-fit' : ''}`}
      onWheel={event => { if (!event.ctrlKey && zoom === 'fit') return; event.preventDefault(); change(event.deltaY < 0 ? 1.12 : 1 / 1.12); }}
      onPointerDown={event => { if (zoom === 'fit') return; (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId); drag.current = { x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y }; }}
      onPointerMove={event => { const start = drag.current; if (start) setOffset({ x: start.ox + event.clientX - start.x, y: start.oy + event.clientY - start.y }); }}
      onPointerUp={() => { drag.current = null; }}>
      <img src={url} alt={name} draggable={false} onLoad={event => setSize({ w: event.currentTarget.naturalWidth, h: event.currentTarget.naturalHeight })}
        style={scale ? { width: size ? size.w * scale : undefined, maxWidth: 'none', maxHeight: 'none', transform: `translate(${offset.x}px, ${offset.y}px)` } : undefined} />
    </div>
  </div>;
}

/** The studio as a window: a native modal dialog, so the page behind is inert and focus stays inside. */
function StudioDialog({ labelledBy, onClose, children }: { labelledBy: string; onClose?: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef(onClose); close.current = onClose;
  // Opened in a layout effect, before the studio's own (its parent's) measures its width: a dialog not open yet is
  // 0 px wide, and the studio would lay its file tree out by the window's width for a frame.
  useLayoutEffect(() => {
    const element = dialog.current!;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (typeof element.showModal === 'function' && !element.open) element.showModal(); else element.setAttribute('open', '');
    return () => { if (element.open && typeof element.close === 'function') element.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  return createPortal(<dialog ref={dialog} className="awwo-studio-dialog" aria-modal="true" aria-labelledby={labelledBy}
    onCancel={event => { event.preventDefault(); close.current?.(); }}
    onKeyDown={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}
    onMouseDown={event => { if (event.target === event.currentTarget) close.current?.(); }}>{children}</dialog>, document.body);
}
