// The attachment half of a composite composer: a "+" button, drag-and-drop and paste for files of any type, with
// one chip per file. The draft text stays the single source of truth: an uploaded file becomes a line at its end
// (attachments.ts), so whatever already keeps, recovers or sends a draft keeps, recovers and sends its files too.

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type ClipboardEvent, type DragEvent, type MouseEvent, type ReactNode } from 'react';
import { AlertCircle, Box, File as FileIcon, FileArchive, FileCode, FileText, Film, Image as ImageIcon, Loader2, Music, Plus, X } from 'lucide-react';
import { useCanvasI18n } from './i18n';
import {
  attachmentKind, attachmentSeenBy, carriesFiles, eventFiles, formatFileSize, joinAttachments, MAX_COMPOSER_ATTACHMENTS, MAX_UPLOAD_BYTES,
  splitAttachments, type AttachmentKind, type ComposerAttachment,
} from './attachments';
import { canvasUploadsAvailable, deleteCanvasUpload, storedArtifactUrl, storedMediaUrl, uploadCanvasFile } from '../saas/canvasBridge';
import { saasErrorMessage } from '../saas/api';
import './composer-attachments.css';

/** `ready`: uploaded while the box was disabled, waiting on its chip to be added by hand (deferWhileDisabled). */
interface PendingUpload { key: string; name: string; size: number; progress: number; error?: string; controller?: AbortController; ready?: ComposerAttachment }

/** A box's chips that are not attached files yet: uploads still going, files uploaded and waiting to be added
 *  (deferWhileDisabled), and failed uploads not dismissed. */
export interface UploadCounts { pending: number; waiting: number; failed: number }

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
  /** For a value its owner locks while the box is disabled (a node's inputs while it works). A finished upload keeps its
   *  chip until the file is in the value, so an add the owner refuses leaves it to try again; it is added at once only
   *  where the box stayed enabled while it uploaded. Otherwise (a lock came, which may have been a run of the node: adding
   *  the file after it on its own would clear what the run made) it waits on its chip for its 加入, pressable once the box
   *  is enabled. Without this option a file is added as it lands and its chip goes. */
  deferWhileDisabled?: boolean;
  /** Hears the box's counts whenever they change, and none left once it unmounts (which ends its uploads). */
  onUploadsChange?: (counts: UploadCounts) => void;
}

export function useComposerAttachments({ value, onChange, nodeId, disabled = false, max = MAX_COMPOSER_ATTACHMENTS, keepOnRemove = false, deferWhileDisabled = false, onUploadsChange }: ComposerAttachmentsOptions) {
  const { locale, t } = useCanvasI18n();
  const { body, attachments } = useMemo(() => splitAttachments(value), [value]);
  const latest = useRef({ value, onChange, locale, disabled, onUploadsChange });
  latest.current = { value, onChange, locale, disabled, onUploadsChange };
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
  // Uploads that were in flight while the box was disabled (deferWhileDisabled).
  const lockedDuring = useRef(new Set<string>());
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const upload of uploadsRef.current) upload.controller?.abort();
      latest.current.onUploadsChange?.({ pending: 0, waiting: 0, failed: 0 });
    };
  }, []);
  // A finished upload waiting on its chip is done once its file is in the value: the chip goes in that same render (and
  // then from the state), and an add its owner refused leaves it there.
  const attachedIds = useMemo(() => new Set(attachments.map(item => item.id)), [attachments]);
  const shown = useMemo(() => uploads.filter(upload => !(upload.ready && attachedIds.has(upload.ready.id))), [uploads, attachedIds]);
  useEffect(() => {
    if (shown.length < uploads.length) setUploads(previous => previous.filter(upload => !(upload.ready && attachedIds.has(upload.ready.id))));
  }, [shown, uploads, attachedIds]);
  useEffect(() => {
    if (deferWhileDisabled && disabled) for (const upload of uploads) if (!upload.error && !upload.ready) lockedDuring.current.add(upload.key);
  }, [deferWhileDisabled, disabled, uploads]);
  const failed = shown.filter(upload => upload.error).length;
  const waiting = shown.filter(upload => upload.ready).length;
  const pending = shown.length - failed - waiting;
  useEffect(() => { latest.current.onUploadsChange?.({ pending, waiting, failed }); }, [pending, waiting, failed]);

  // The files this box added by writes whose answer is not drawn yet. Every write is built from the value it rendered plus
  // these, so writes made before the next render (two files landing at once) build on one another. A file goes from here
  // in the render that draws its owner's answer to the write that added it (`writes` is set with that write, so it is
  // drawn with the answer): shown then, or refused and not written again by a later edit. A file waiting on its chip then
  // goes in with its 加入 only, and a change of the value from elsewhere afterwards (an undo) is not undone.
  const added = useRef(new Map<string, { item: ComposerAttachment; write: number }>());
  const writeCount = useRef(0);
  const [writes, setWrites] = useState(0);
  useLayoutEffect(() => {
    for (const [id, entry] of added.current) if (entry.write <= writes) added.current.delete(id);
  }, [writes]);
  const composed = useCallback(() => {
    const current = splitAttachments(latest.current.value);
    const unseen = Array.from(added.current.values(), entry => entry.item).filter(item => !current.attachments.some(shown => shown.id === item.id));
    return { body: current.body, attachments: [...current.attachments, ...unseen] };
  }, []);
  const attach = useCallback((item: ComposerAttachment) => {
    added.current.set(item.id, { item, write: ++writeCount.current });
    const current = composed();
    latest.current.onChange(joinAttachments(current.body, current.attachments, latest.current.locale));
    setWrites(writeCount.current);
  }, [composed]);
  /** Adds a file waiting on its chip: its 加入, pressable once the box is enabled. */
  const addReady = useCallback((key: string) => {
    const item = uploadsRef.current.find(upload => upload.key === key)?.ready;
    if (item) attach(item);
  }, [attach]);

  /** The words, the files kept: those this box added and not drawn yet too. So whatever else puts words in the box (an
   *  example, a starter prompt) goes through here: built from the drawn value alone, it would drop a file that just landed.
   *  A function is handed the words the box last drew (only files are kept between renders, not words). */
  const setBody = useCallback((next: string | ((body: string) => string)) => {
    const current = composed();
    latest.current.onChange(joinAttachments(typeof next === 'function' ? next(current.body) : next, current.attachments, latest.current.locale));
  }, [composed]);

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
          const item: ComposerAttachment = { id: result.id, name: result.name, kind: attachmentKind(result.name, result.kind) };
          if (deferWhileDisabled) {
            const locked = lockedDuring.current.delete(key) || latest.current.disabled;
            setUploads(previous => previous.map(upload => upload.key === key ? { ...upload, progress: 1, controller: undefined, ready: item } : upload));
            if (!locked) attach(item);
            return;
          }
          setUploads(previous => previous.filter(upload => upload.key !== key));
          attach(item);
        })
        .catch((error: unknown) => {
          lockedDuring.current.delete(key);
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
  }, [disabled, max, nodeId, locale, t, deferWhileDisabled, attach]);

  const remove = useCallback((id: string) => {
    const current = composed();
    latest.current.onChange(joinAttachments(current.body, current.attachments.filter(item => item.id !== id), latest.current.locale));
    if (uploadedHere.current.delete(id) && !keepOnRemove) void deleteCanvasUpload(id).catch(() => { /* the file stays until its canvas goes */ });
  }, [keepOnRemove, composed]);

  const dismiss = useCallback((key: string) => {
    const upload = uploadsRef.current.find(item => item.key === key);
    lockedDuring.current.delete(key);
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
    'data-attachment-box': '',
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
  return { body, setBody, attachments, uploads: shown, notice, clearNotice: () => setNotice(''), add, remove, dismiss, addReady, markSent, busy, available,
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

/** One chip per attached file, uploads in flight and refusals included. Read-only in a transcript. A file that waits to
 *  be added (deferWhileDisabled) has a 加入 of its own, pressable while `canAdd`. */
/** A box's controls that can take the focus once neither chip beside a removed one is left, in the box's order. */
const BOX_CONTROLS = ':is(button, textarea, select, a[href], input:not([type="file"])):not([tabindex="-1"])';

/** On a chip's ✕: a pointer press leaves the focus where it was, as Safari does, instead of focusing the ✕ (Chrome
 *  does), which would have the press hand the focus on to another file's ✕, for a stray Enter or Space to remove that
 *  file — and, for an upload made in that box, delete it. */
const keepFocus = (event: MouseEvent<HTMLElement>) => event.preventDefault();

/**
 * A chip's own ✕ takes its chip away, and with the focus on the ✕ the keyboard's focus would fall to the page's body.
 * Pressed with the focus in its chip (from the keyboard: a click focuses nothing, see keepFocus), the ✕ hands the focus
 * on in the render its press draws, once the chip has gone — the box's owner may refuse the change, and then the chip
 * and the focus both stay. It goes to the chip that took its place, else to the one before it (that chip's ✕, else its
 * link), else to the box's text field, else to the box's first control that takes it. Nothing scrolls for it: the canvas
 * root clips, so a scroll would shift the canvas under the reader.
 */
function useChipFocusHandOff() {
  const pressed = useRef<{ chip: Element; next: Element | null; previous: Element | null; box: Element | null } | null>(null);
  // Every press draws a render, so a press whose change is refused is let go at once and moves nothing later.
  const [, setPresses] = useState(0);
  useLayoutEffect(() => {
    const press = pressed.current;
    if (!press) return;
    pressed.current = null;
    if (press.chip.isConnected || (document.activeElement && document.activeElement !== document.body)) return;
    // Tried in order until one takes the focus: a control that went too, is disabled or is not drawn takes none.
    const controls = (chip: Element | null) => [chip?.querySelector<HTMLElement>('.awwo-attachment-remove'), chip?.querySelector<HTMLElement>('a.awwo-attachment-name')];
    for (const candidate of [...controls(press.next), ...controls(press.previous), press.box?.querySelector<HTMLElement>('textarea'),
      ...Array.from(press.box?.querySelectorAll<HTMLElement>(BOX_CONTROLS) ?? [])]) {
      candidate?.focus({ preventScroll: true });
      if (candidate && document.activeElement === candidate) return;
    }
  });
  return useCallback((event: MouseEvent<HTMLElement>) => {
    const chip = event.currentTarget.closest('li');
    if (!chip?.contains(document.activeElement)) return;
    pressed.current = { chip, next: chip.nextElementSibling, previous: chip.previousElementSibling, box: chip.closest('[data-attachment-box]') };
    setPresses(count => count + 1);
  }, []);
}

export function AttachmentChips({ attachments, uploads = [], onRemove, onDismiss, onAdd, canAdd = false, disabled = false, compact = false }: {
  attachments: ReadonlyArray<ComposerAttachment>;
  uploads?: ReadonlyArray<PendingUpload>;
  onRemove?: (id: string) => void;
  onDismiss?: (key: string) => void;
  onAdd?: (key: string) => void;
  canAdd?: boolean;
  disabled?: boolean;
  compact?: boolean;
}) {
  const { t, locale } = useCanvasI18n();
  const noteId = useId();
  // A 加入 pressed with the focus on it (from the keyboard; Chrome focuses a clicked button too) is replaced by the added
  // file's chip: in the render the press draws (every add draws one, see `writes`), the focus goes to that chip's link (or
  // its remove button), not to the page's body. Only in that render: an add the canvas refused draws no chip, and
  // nothing is handed on later.
  const list = useRef<HTMLUListElement>(null);
  const focusAdded = useRef<string | null>(null);
  const handOff = useChipFocusHandOff();
  useLayoutEffect(() => {
    const id = focusAdded.current;
    if (!id) return;
    focusAdded.current = null;
    const chip = [...(list.current?.querySelectorAll<HTMLElement>('[data-attachment-id]') ?? [])].find(element => element.dataset.attachmentId === id);
    chip?.querySelector<HTMLElement>('a.awwo-attachment-name, .awwo-attachment-remove')?.focus({ preventScroll: true });
  });
  if (!attachments.length && !uploads.length) return null;
  return <><ul ref={list} className={`awwo-attachment-chips${compact ? ' is-compact' : ''}`} aria-label={t('attach.list')}>
    {attachments.map(item => {
      const Icon = KIND_ICON[item.kind];
      const media = storedMediaUrl(item.id);
      const href = item.kind === 'image' || item.kind === 'video' || item.kind === 'audio' ? media : storedArtifactUrl(`awwo-file:${item.id}`);
      return <li key={item.id} className={`awwo-attachment-chip is-${item.kind}`} data-attachment-id={item.id}>
        {item.kind === 'image' && media ? <AttachmentThumb src={media} fallback={<Icon size={14} aria-hidden="true" />} />
          : <span className="awwo-attachment-icon"><Icon size={14} aria-hidden="true" /></span>}
        {href ? <a className="awwo-attachment-name" href={href} target="_blank" rel="noopener noreferrer" title={item.name}>{item.name}</a>
          : <span className="awwo-attachment-name" title={item.name}>{item.name}</span>}
        <span className="sr-only">{t(`attach.kind.${item.kind}`)}</span>
        {onRemove ? <button type="button" className="awwo-attachment-remove" disabled={disabled} aria-label={t('attach.remove', { name: item.name })}
          onMouseDown={keepFocus} onClick={event => { handOff(event); onRemove(item.id); }}><X size={12} aria-hidden="true" /></button> : null}
      </li>;
    })}
    {uploads.map(upload => {
      const ReadyIcon = upload.ready ? KIND_ICON[upload.ready.kind] : null;
      return <li key={upload.key} className={`awwo-attachment-chip is-pending${upload.error ? ' is-failed' : ''}${upload.ready ? ' is-ready' : ''}`} role={upload.error ? 'alert' : 'status'}>
        <span className="awwo-attachment-icon">{upload.error ? <AlertCircle size={14} aria-hidden="true" /> : ReadyIcon ? <ReadyIcon size={14} aria-hidden="true" />
          : <Loader2 size={14} className="awwo-attachment-spin" aria-hidden="true" />}</span>
        <span className="awwo-attachment-name" title={upload.error || upload.name}>{upload.name}</span>
        <span className="awwo-attachment-meta">{upload.error ? t('attach.failed') : upload.ready ? t(canAdd ? 'attach.ready' : 'attach.readyLocked')
          : t('attach.uploading', { percent: Math.round(upload.progress * 100), size: formatFileSize(upload.size, locale) })}</span>
        {upload.error ? <span className="sr-only">{upload.error}</span> : null}
        {upload.ready && onAdd ? <button type="button" className="awwo-attachment-add" disabled={!canAdd} aria-label={t('attach.addReady', { name: upload.name })}
          aria-describedby={noteId} title={canAdd ? t('attach.addReadyNote') : undefined}
          onClick={event => { if (event.currentTarget === document.activeElement) focusAdded.current = upload.ready!.id; onAdd(upload.key); }}>{t('attach.addReadyShort')}</button> : null}
        {onDismiss ? <button type="button" className="awwo-attachment-remove" aria-label={t(upload.error ? 'attach.dismiss' : upload.ready ? 'attach.remove' : 'attach.cancel', { name: upload.name })}
          onMouseDown={keepFocus} onClick={event => { handOff(event); onDismiss(upload.key); }}><X size={12} aria-hidden="true" /></button> : null}
      </li>;
    })}
  </ul>
  {/* Adding a waiting file changes the inputs, which leaves this node and those after it needing a new run: its 加入 says so. */}
  {onAdd && uploads.some(upload => upload.ready) ? <span id={noteId} hidden>{t('attach.addReadyNote')}</span> : null}</>;
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
    <AttachmentChips attachments={state.attachments} uploads={state.uploads} onRemove={state.remove} onDismiss={state.dismiss}
      onAdd={state.addReady} canAdd={state.enabled} disabled={disabled} />
    {state.notice ? <p className="awwo-attachment-notice" id={noticeId} role="status">{state.notice}
      <button type="button" aria-label={t('attach.closeNotice')} onClick={state.clearNotice}><X size={12} aria-hidden="true" /></button></p> : null}
    {state.dragging ? <div className="awwo-attachment-drop" aria-hidden="true">{t('attach.drop')}</div> : null}
  </>;
}

/** A transcript's read-only view of a sent message: the words, then the files, and which model saw its pictures. */
export function MessageWithAttachments({ text, render }: { text: string; render?: (body: string) => ReactNode }) {
  const { t } = useCanvasI18n();
  const { body, attachments } = splitAttachments(text);
  const seenBy = attachmentSeenBy(text);
  return <>
    {body ? (render ? render(body) : <p>{body}</p>) : null}
    <AttachmentChips attachments={attachments} compact />
    {seenBy ? <p className="awwo-attach-seen-by" role="note">{t('attach.seenBy', { model: seenBy })}</p> : null}
  </>;
}
