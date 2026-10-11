// The attachment half of a composite composer: a "+" button, drag-and-drop and paste for files of any type, with
// one chip per file. The draft text stays the single source of truth: an uploaded file becomes a line at its end
// (attachments.ts), so whatever already keeps, recovers or sends a draft keeps, recovers and sends its files too.

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type ClipboardEvent, type DragEvent, type ReactNode } from 'react';
import { AlertCircle, Box, File as FileIcon, FileArchive, FileCode, FileText, Film, Image as ImageIcon, Loader2, Music, Plus, X } from 'lucide-react';
import { useCanvasI18n } from './i18n';
import {
  attachmentKind, carriesFiles, eventFiles, formatFileSize, joinAttachments, MAX_COMPOSER_ATTACHMENTS, MAX_UPLOAD_BYTES,
  splitAttachments, type AttachmentKind, type ComposerAttachment,
} from './attachments';
import { canvasUploadsAvailable, deleteCanvasUpload, storedArtifactUrl, storedMediaUrl, uploadCanvasFile } from '../saas/canvasBridge';
import { saasErrorMessage } from '../saas/api';
import './composer-attachments.css';

interface PendingUpload { key: string; name: string; size: number; progress: number; error?: string; controller?: AbortController }

export interface ComposerAttachmentsOptions {
  /** The whole draft, attachment lines included. */
  value: string;
  onChange: (value: string) => void;
  /** Provenance only: the node the files are attached on. */
  nodeId?: string;
  disabled?: boolean;
  max?: number;
  /** A file input's value may already have gone with a run, so taking a chip back never deletes the file. */
  keepOnRemove?: boolean;
}

export function useComposerAttachments({ value, onChange, nodeId, disabled = false, max = MAX_COMPOSER_ATTACHMENTS, keepOnRemove = false }: ComposerAttachmentsOptions) {
  const { locale, t } = useCanvasI18n();
  const { body, attachments } = useMemo(() => splitAttachments(value), [value]);
  const latest = useRef({ value, onChange, locale });
  latest.current = { value, onChange, locale };
  const [uploads, setUploads] = useState<PendingUpload[]>([]);
  const [notice, setNotice] = useState('');
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  // Files uploaded by this box and not yet sent; only those are deleted when taken back.
  const uploadedHere = useRef(new Set<string>());
  const available = canvasUploadsAvailable();
  const mounted = useRef(true);
  const uploadsRef = useRef(uploads);
  uploadsRef.current = uploads;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const upload of uploadsRef.current) upload.controller?.abort();
    };
  }, []);

  const setBody = useCallback((next: string) => {
    const current = splitAttachments(latest.current.value);
    latest.current.onChange(joinAttachments(next, current.attachments, latest.current.locale));
  }, []);

  const add = useCallback((files: File[]) => {
    if (!files.length || disabled || !canvasUploadsAvailable()) return;
    const inFlight = uploadsRef.current.filter(upload => !upload.error).length;
    let room = max - splitAttachments(latest.current.value).attachments.length - inFlight;
    const refused: string[] = [];
    for (const file of files) {
      if (room <= 0) { setNotice(t('attach.tooMany', { count: max })); break; }
      if (file.size > MAX_UPLOAD_BYTES) { refused.push(t('attach.tooLarge', { name: file.name, size: formatFileSize(MAX_UPLOAD_BYTES, locale) })); continue; }
      if (file.size === 0) { refused.push(t('attach.empty', { name: file.name })); continue; }
      room--;
      const key = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
      const controller = new AbortController();
      setUploads(previous => [...previous, { key, name: file.name, size: file.size, progress: 0, controller }]);
      uploadCanvasFile(file, { nodeId, signal: controller.signal,
        onProgress: fraction => { if (mounted.current) setUploads(previous => previous.map(upload => upload.key === key ? { ...upload, progress: fraction } : upload)); } })
        .then(result => {
          uploadedHere.current.add(result.id);
          if (!mounted.current) return;
          setUploads(previous => previous.filter(upload => upload.key !== key));
          const current = splitAttachments(latest.current.value);
          const item: ComposerAttachment = { id: result.id, name: result.name, kind: attachmentKind(result.name, result.kind) };
          latest.current.onChange(joinAttachments(current.body, [...current.attachments, item], latest.current.locale));
        })
        .catch((error: unknown) => {
          if (!mounted.current) return;
          if (error instanceof DOMException && error.name === 'AbortError') {
            setUploads(previous => previous.filter(upload => upload.key !== key));
            return;
          }
          const reason = saasErrorMessage(error, locale);
          setUploads(previous => previous.map(upload => upload.key === key ? { ...upload, controller: undefined, error: reason } : upload));
        });
    }
    if (refused.length) setNotice(refused.join(' '));
  }, [disabled, max, nodeId, locale, t]);

  const remove = useCallback((id: string) => {
    const current = splitAttachments(latest.current.value);
    latest.current.onChange(joinAttachments(current.body, current.attachments.filter(item => item.id !== id), latest.current.locale));
    if (uploadedHere.current.delete(id) && !keepOnRemove) void deleteCanvasUpload(id).catch(() => { /* the file stays until its canvas goes */ });
  }, [keepOnRemove]);

  const dismiss = useCallback((key: string) => {
    const upload = uploadsRef.current.find(item => item.key === key);
    upload?.controller?.abort();
    setUploads(previous => previous.filter(item => item.key !== key));
  }, []);

  /** A sent draft's files belong to the conversation now: taking the chip back must no longer delete them. */
  const markSent = useCallback(() => { uploadedHere.current.clear(); setNotice(''); }, []);

  const enabled = available && !disabled;
  const onPaste = useCallback((event: ClipboardEvent<HTMLElement>) => {
    if (!enabled) return;
    const files = eventFiles(event.clipboardData);
    if (!files.length) return;
    event.preventDefault();
    add(files);
  }, [enabled, add]);
  const dropProps = {
    onDragEnter: (event: DragEvent<HTMLElement>) => { if (enabled && carriesFiles(event.dataTransfer)) { event.preventDefault(); setDragging(true); } },
    onDragOver: (event: DragEvent<HTMLElement>) => { if (enabled && carriesFiles(event.dataTransfer)) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } },
    onDragLeave: (event: DragEvent<HTMLElement>) => {
      if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDragging(false);
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      setDragging(false);
      if (!enabled || !carriesFiles(event.dataTransfer)) return;
      event.preventDefault();
      // The canvas below must not also read this drop as a model or node being placed.
      event.stopPropagation();
      add(eventFiles(event.dataTransfer));
    },
  };
  const openPicker = () => { if (enabled) picker.current?.click(); };
  const onPicked = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    add(files);
  };
  const busy = uploads.some(upload => !upload.error);
  return { body, setBody, attachments, uploads, notice, clearNotice: () => setNotice(''), add, remove, dismiss, markSent, busy, available,
    enabled, dragging, dropProps, onPaste, openPicker, picker, onPicked };
}

export type ComposerAttachmentsState = ReturnType<typeof useComposerAttachments>;

const KIND_ICON: Record<AttachmentKind, typeof FileIcon> = {
  image: ImageIcon, video: Film, audio: Music, model3d: Box, document: FileText, text: FileCode, archive: FileArchive, file: FileIcon,
};

/** The "+" that opens the file picker, and the hidden input it drives. */
export function AttachButton({ state, className }: { state: ComposerAttachmentsState; className?: string }) {
  const { t } = useCanvasI18n();
  if (!state.available) return null;
  const full = state.attachments.length + state.uploads.filter(upload => !upload.error).length >= MAX_COMPOSER_ATTACHMENTS;
  return <>
    <button type="button" className={`awwo-attach-button${className ? ` ${className}` : ''}`} data-testid="composer-attach"
      aria-label={t('attach.add')} title={full ? t('attach.tooMany', { count: MAX_COMPOSER_ATTACHMENTS }) : t('attach.addHint')}
      disabled={!state.enabled || full} onClick={state.openPicker}>
      <Plus size={15} aria-hidden="true" />
    </button>
    <input ref={state.picker} type="file" multiple hidden tabIndex={-1} aria-hidden="true" onChange={state.onPicked} />
  </>;
}

/** One chip per attached file, uploads in flight and refusals included. Read-only in a transcript. */
export function AttachmentChips({ attachments, uploads = [], onRemove, onDismiss, disabled = false, compact = false }: {
  attachments: ReadonlyArray<ComposerAttachment>;
  uploads?: ReadonlyArray<PendingUpload>;
  onRemove?: (id: string) => void;
  onDismiss?: (key: string) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  const { t, locale } = useCanvasI18n();
  if (!attachments.length && !uploads.length) return null;
  return <ul className={`awwo-attachment-chips${compact ? ' is-compact' : ''}`} aria-label={t('attach.list')}>
    {attachments.map(item => {
      const Icon = KIND_ICON[item.kind];
      const media = storedMediaUrl(item.id);
      const href = item.kind === 'image' || item.kind === 'video' || item.kind === 'audio' ? media : storedArtifactUrl(`awwo-file:${item.id}`);
      return <li key={item.id} className={`awwo-attachment-chip is-${item.kind}`}>
        {item.kind === 'image' && media ? <AttachmentThumb src={media} fallback={<Icon size={14} aria-hidden="true" />} />
          : <span className="awwo-attachment-icon"><Icon size={14} aria-hidden="true" /></span>}
        {href ? <a className="awwo-attachment-name" href={href} target="_blank" rel="noopener noreferrer" title={item.name}>{item.name}</a>
          : <span className="awwo-attachment-name" title={item.name}>{item.name}</span>}
        <span className="sr-only">{t(`attach.kind.${item.kind}`)}</span>
        {onRemove ? <button type="button" className="awwo-attachment-remove" disabled={disabled} aria-label={t('attach.remove', { name: item.name })}
          onClick={() => onRemove(item.id)}><X size={12} aria-hidden="true" /></button> : null}
      </li>;
    })}
    {uploads.map(upload => <li key={upload.key} className={`awwo-attachment-chip is-pending${upload.error ? ' is-failed' : ''}`} role={upload.error ? 'alert' : 'status'}>
      <span className="awwo-attachment-icon">{upload.error ? <AlertCircle size={14} aria-hidden="true" /> : <Loader2 size={14} className="awwo-attachment-spin" aria-hidden="true" />}</span>
      <span className="awwo-attachment-name" title={upload.error || upload.name}>{upload.name}</span>
      <span className="awwo-attachment-meta">{upload.error ? t('attach.failed') : t('attach.uploading', { percent: Math.round(upload.progress * 100), size: formatFileSize(upload.size, locale) })}</span>
      {upload.error ? <span className="sr-only">{upload.error}</span> : null}
      {onDismiss ? <button type="button" className="awwo-attachment-remove" aria-label={t(upload.error ? 'attach.dismiss' : 'attach.cancel', { name: upload.name })}
        onClick={() => onDismiss(upload.key)}><X size={12} aria-hidden="true" /></button> : null}
    </li>)}
  </ul>;
}

function AttachmentThumb({ src, fallback }: { src: string; fallback: ReactNode }) {
  const [failed, setFailed] = useState(false);
  return failed ? <span className="awwo-attachment-icon">{fallback}</span>
    : <img className="awwo-attachment-thumb" src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />;
}

/** The tray under a composer's text: its chips, the reason a file was refused, and the drop hint. */
export function AttachmentTray({ state, disabled = false }: { state: ComposerAttachmentsState; disabled?: boolean }) {
  const { t } = useCanvasI18n();
  const noticeId = useId();
  return <>
    <AttachmentChips attachments={state.attachments} uploads={state.uploads} onRemove={state.remove} onDismiss={state.dismiss} disabled={disabled} />
    {state.notice ? <p className="awwo-attachment-notice" id={noticeId} role="status">{state.notice}
      <button type="button" aria-label={t('attach.closeNotice')} onClick={state.clearNotice}><X size={12} aria-hidden="true" /></button></p> : null}
    {state.dragging ? <div className="awwo-attachment-drop" aria-hidden="true">{t('attach.drop')}</div> : null}
  </>;
}

/** A transcript's read-only view of a sent message: the words, then the files. */
export function MessageWithAttachments({ text, render }: { text: string; render?: (body: string) => ReactNode }) {
  const { body, attachments } = splitAttachments(text);
  return <>
    {body ? (render ? render(body) : <p>{body}</p>) : null}
    <AttachmentChips attachments={attachments} compact />
  </>;
}
