// An enlarged card shows its deliverable live, on the board: the page running, the document, the pictures, the video,
// the 3D model. Drawn from the node's published output (studioModel.ts), bytes from the shared canvas cache; nothing
// here edits or runs the node. The full studio opens from the footer.
import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Box, FileText, Loader2, Maximize2, MessageSquare } from 'lucide-react';
import type { SessionNode } from './canvasDoc';
import type { DeliveryState } from './canvasResultModel';
import { DeliverableMarkdown } from './DeliverableMarkdown';
import { useCanvasI18n } from './i18n';
import { useMarketPage } from './marketPages';
import { ModelPreview } from './ModelPreview';
import { canvasFileBytes, canvasResolver } from './studio/canvasAssets';
import { LivePage } from './studio/LivePage';
import { decodeText, entryMediaUrl, type LoadedFile } from './studio/studioData';
import { kindOfName, kindOfType, nodeEntries, type StudioEntry, type StudioKind } from './studio/studioModel';
import './card-preview.css';

export interface CardPreviewProps {
  node: SessionNode;
  /** Every file of the canvas, so a page can show what other nodes made (stable between renders). */
  canvasEntries?: ReadonlyArray<StudioEntry>;
  /** The node is working now: its previous result stays visible, marked as being redone. */
  running: boolean;
  /** What the agent is writing right now, for a node that has delivered nothing yet. */
  liveText?: string;
  onOpenStudio?: (entryId?: string) => void;
  onOpenChat?: () => void;
}

function stateOf(node: SessionNode): DeliveryState {
  const output = node.lastOutput;
  return !output ? 'none' : output.partial ? 'partial' : output.source === 'case' ? 'case' : output.source === 'manual' ? 'manual' : 'run';
}

/** A stored file's bytes and what they turned out to be. */
function useStoredFile(entry: StudioEntry | undefined) {
  const [file, setFile] = useState<{ id: string; file: LoadedFile | null } | null>(null);
  useEffect(() => {
    if (!entry || (entry.source.type !== 'stored' && !(entry.source.type === 'media' && entry.kind === 'model'))) return;
    let live = true;
    void canvasFileBytes(entry).then(value => { if (live) setFile({ id: entry.id, file: value }); });
    return () => { live = false; };
  }, [entry?.id]);
  return file && entry && file.id === entry.id ? file : null;
}

export function CardPreview({ node, canvasEntries, running, liveText, onOpenStudio, onOpenChat }: CardPreviewProps) {
  const { t } = useCanvasI18n();
  const state = stateOf(node);
  const entries = useMemo(() => nodeEntries(node, state), [node.lastOutput, node.contract, node.agentKind, node.title, state]);
  const [chosen, setChosen] = useState<string | null>(null);
  const entry = entries.find(item => item.id === chosen) ?? entries.find(item => item.primary) ?? entries[0];
  const stored = useStoredFile(entry);
  const resolver = useMemo(() => canvasEntries ? canvasResolver(canvasEntries, entry?.id) : undefined, [canvasEntries, entry?.id]);
  const market = useMarketPage(node.id);
  const images = entries.filter(item => item.kind === 'image' && item.source.type === 'media');
  // What the file is once a stored one has been read.
  const storedName = stored?.file?.name || entry?.name || '';
  const kind: StudioKind | undefined = entry?.source.type === 'stored' && stored?.file
    ? (kindOfName(storedName) !== 'file' ? kindOfName(storedName) : kindOfType(stored.file.contentType) ?? 'file') : entry?.kind;
  const text = entry?.source.type === 'inline' ? entry.source.text : stored?.file ? decodeText(stored.file.bytes) : null;

  let body;
  if (!entry) {
    body = running || liveText ? <div className="awwo-card-preview-live" role="status">
      <span className="awwo-card-preview-pulse"><Loader2 size={16} aria-hidden="true" />{t('card.previewRunning')}</span>
      {liveText ? <p>{liveText.length > 1600 ? `…${liveText.slice(-1600)}` : liveText}</p> : null}
    </div> : <div className="awwo-card-preview-empty"><FileText size={22} aria-hidden="true" /><p>{t('card.previewEmpty')}</p></div>;
  } else if (kind === 'missing') {
    body = <div className="awwo-card-preview-empty is-warning"><AlertTriangle size={20} aria-hidden="true" />
      <p>{t('studio.missingFile', { name: entry.source.type === 'missing' ? entry.source.claimed : entry.name })}</p></div>;
  } else if (kind === 'page') {
    body = text !== null ? <LivePage passive html={text} title={entry.name} path={entry.name} resolve={resolver} market={market} />
      : <div className="awwo-card-preview-empty"><Loader2 size={18} aria-hidden="true" className="awwo-studio-spin" /></div>;
  } else if (kind === 'image' && images.length > 1) {
    body = <div className={`awwo-card-preview-grid is-${Math.min(images.length, 4)}`}>{images.slice(0, 4).map(image =>
      <button key={image.id} type="button" onClick={() => onOpenStudio?.(image.id)} aria-label={image.name}><img src={entryMediaUrl(image) ?? undefined} alt={image.name} draggable={false} /></button>)}</div>;
  } else if (kind === 'image' && entry.source.type === 'media') {
    body = <div className="awwo-card-preview-image"><img src={entryMediaUrl(entry) ?? undefined} alt={entry.name} draggable={false} /></div>;
  } else if (kind === 'video' && entry.source.type === 'media') {
    body = <div className="awwo-card-preview-video"><video src={entryMediaUrl(entry) ?? undefined} controls muted loop playsInline preload="metadata" /></div>;
  } else if (kind === 'model') {
    body = stored?.file ? <div className="awwo-card-preview-model"><ModelPreview file={{ name: stored.file.name || entry.name, bytes: stored.file.bytes }} /></div>
      : <div className="awwo-card-preview-empty"><Box size={20} aria-hidden="true" /><Loader2 size={16} aria-hidden="true" className="awwo-studio-spin" /></div>;
  } else if (kind === 'markdown' && text !== null) {
    body = <div className="awwo-card-preview-doc awwo-markdown-preview"><DeliverableMarkdown>{text}</DeliverableMarkdown></div>;
  } else if (text !== null) {
    body = <pre className="awwo-card-preview-text">{text.length > 20000 ? `${text.slice(0, 20000)}\n…` : text}</pre>;
  } else {
    body = <div className="awwo-card-preview-empty"><FileText size={20} aria-hidden="true" /><p>{entry.name}</p>
      {onOpenStudio && <button type="button" onClick={() => onOpenStudio(entry.id)}>{t('studio.open')}</button>}</div>;
  }

  return <section className={`awwo-card-preview${running ? ' is-running' : ''}`} aria-label={t('card.preview', { title: node.title })}>
    <div className="awwo-card-preview-body">{body}</div>
    <footer className="awwo-card-preview-foot">
      {entries.length > 1 ? <div className="awwo-card-preview-files" role="group" aria-label={t('card.files', { count: entries.length })}>
        {entries.slice(0, 3).map(item => <button key={item.id} type="button" aria-pressed={item.id === entry?.id} title={item.name} onClick={() => setChosen(item.id)}>{item.name}</button>)}
        {entries.length > 3 && <button type="button" onClick={() => onOpenStudio?.()}>+{entries.length - 3}</button>}
      </div> : <span className="awwo-card-preview-name" title={entry?.name}>{entry?.name ?? ''}</span>}
      <div className="awwo-card-preview-actions">
        {onOpenChat && <button type="button" onClick={onOpenChat}><MessageSquare size={13} aria-hidden="true" />{t('card.openChat')}</button>}
        {onOpenStudio && entries.length > 0 && <button type="button" className="is-primary" onClick={() => onOpenStudio(entry?.id)}><Maximize2 size={13} aria-hidden="true" />{t('studio.open')}</button>}
      </div>
    </footer>
  </section>;
}
