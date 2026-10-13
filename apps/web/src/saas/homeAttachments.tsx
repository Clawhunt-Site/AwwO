// Files sent with the workspace home's request (owner request 2026-10-13: 这个一开始的输入框要支持各种格式的文件输入。
// 包括媒体文件). Files of any type, pictures, video, audio and 3D included, come in through the "+", a drop or a paste.
// The home has no canvas yet, so each file waits in this tab until the request is sent: the canvas is created first,
// the files are uploaded to it, and their lines go at the end of the request it is handed (attachments.ts), exactly
// as if they had been attached in the canvas assistant's own box. A file already uploaded is never uploaded again.
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type ClipboardEvent, type DragEvent, type ReactNode } from 'react';
import { AlertCircle, Box, Check, File as FileIcon, FileArchive, FileCode, FileText, Film, Image as ImageIcon, Loader2, Music, Plus, X } from 'lucide-react';
import { attachmentKind, carriesFiles, eventFiles, formatFileSize, joinAttachments, MAX_COMPOSER_ATTACHMENTS, MAX_UPLOAD_BYTES,
  type AttachmentKind, type UploadedCanvasFile } from '../canvas/attachments';
import type { UiLocale } from '../locale';

type T = (zh: string, en: string) => string;

/** A file waiting on the home: `uploaded` once the canvas holds it, `progress` while it goes, `failed` with the reason. */
export type HomeFile = { key: string; file: File; uploaded?: UploadedCanvasFile; progress?: number; failed?: string };

/** The planner takes at most this many bytes of request (planning.go), the files' lines included. */
export const PLAN_PROMPT_MAX_BYTES = 8000;
/** Longer than any upload id the server issues ("a" and 32 base64url characters), so an estimate never comes out short. */
const ID_ESTIMATE = `a${'x'.repeat(39)}`;
const bytes = (text: string) => new TextEncoder().encode(text).length;

/** The request's size once its files' lines are added, counted before anything is created or uploaded. */
export function requestBytes(prompt: string, files: ReadonlyArray<HomeFile>, locale: UiLocale): number {
  return bytes(joinAttachments(prompt, files.map(item => ({ id: item.uploaded?.id ?? ID_ESTIMATE, name: item.file.name })), locale));
}

/** A file's kind by its name, or by the type the browser gives it when the name says nothing. */
export function homeFileKind(file: File): AttachmentKind {
  const kind = attachmentKind(file.name);
  if (kind !== 'file') return kind;
  const type = file.type.toLowerCase();
  return type.startsWith('image/') ? 'image' : type.startsWith('video/') ? 'video' : type.startsWith('audio/') ? 'audio'
    : type.startsWith('text/') ? 'text' : type === 'application/pdf' ? 'document' : 'file';
}

const newKey = () => typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;

export function useHomeFiles({ disabled, t, locale }: { disabled: boolean; t: T; locale: UiLocale }) {
  const [files, setFiles] = useState<HomeFile[]>([]);
  const latest = useRef(files);
  latest.current = files;
  const [notice, setNotice] = useState('');
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const set = useCallback((next: (files: HomeFile[]) => HomeFile[]) => {
    latest.current = next(latest.current);
    setFiles(latest.current);
  }, []);

  const add = useCallback((incoming: File[]) => {
    if (!incoming.length || disabled) return;
    let room = MAX_COMPOSER_ATTACHMENTS - latest.current.length;
    const refused: string[] = [];
    const added: HomeFile[] = [];
    for (const file of incoming) {
      if (room <= 0) { refused.push(t(`最多带 ${MAX_COMPOSER_ATTACHMENTS} 个文件。`, `Up to ${MAX_COMPOSER_ATTACHMENTS} files.`)); break; }
      if (file.size > MAX_UPLOAD_BYTES) {
        refused.push(t(`「${file.name}」超过 ${formatFileSize(MAX_UPLOAD_BYTES, locale)}，没有添加。`, `“${file.name}” is over ${formatFileSize(MAX_UPLOAD_BYTES, locale)} and was not added.`));
        continue;
      }
      if (file.size === 0) { refused.push(t(`「${file.name}」是空文件，没有添加。`, `“${file.name}” is empty and was not added.`)); continue; }
      room--;
      added.push({ key: newKey(), file });
    }
    if (added.length) set(current => [...current, ...added]);
    setNotice(refused.join(' '));
  }, [disabled, locale, set, t]);
  const remove = useCallback((key: string) => { set(current => current.filter(item => item.key !== key)); setNotice(''); }, [set]);
  const progress = useCallback((key: string, fraction: number) => set(current => current.map(item => item.key === key ? { ...item, progress: fraction, failed: undefined } : item)), [set]);
  const uploaded = useCallback((key: string, result: UploadedCanvasFile) => set(current => current.map(item => item.key === key ? { ...item, uploaded: result, progress: undefined, failed: undefined } : item)), [set]);
  const failed = useCallback((key: string, reason: string) => set(current => current.map(item => item.key === key ? { ...item, progress: undefined, failed: reason } : item)), [set]);
  const clear = useCallback(() => { set(() => []); setNotice(''); }, [set]);

  const onPaste = useCallback((event: ClipboardEvent<HTMLElement>) => {
    if (disabled) return;
    const pasted = eventFiles(event.clipboardData);
    if (!pasted.length) return;
    event.preventDefault();
    add(pasted);
  }, [add, disabled]);
  const dropProps = {
    onDragEnter: (event: DragEvent<HTMLElement>) => { if (!disabled && carriesFiles(event.dataTransfer)) { event.preventDefault(); setDragging(true); } },
    onDragOver: (event: DragEvent<HTMLElement>) => { if (!disabled && carriesFiles(event.dataTransfer)) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } },
    onDragLeave: (event: DragEvent<HTMLElement>) => {
      if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDragging(false);
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      setDragging(false);
      if (disabled || !carriesFiles(event.dataTransfer)) return;
      event.preventDefault();
      add(eventFiles(event.dataTransfer));
    },
  };
  const openPicker = () => { if (!disabled) picker.current?.click(); };
  const onPicked = (event: ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(event.target.files ?? []);
    event.target.value = '';
    add(picked);
  };
  return { files, snapshot: () => latest.current, add, remove, progress, uploaded, failed, clear, notice, clearNotice: () => setNotice(''),
    dragging, dropProps, onPaste, openPicker, onPicked, picker, full: files.length >= MAX_COMPOSER_ATTACHMENTS };
}

export type HomeFilesState = ReturnType<typeof useHomeFiles>;

const KIND_ICON: Record<AttachmentKind, typeof FileIcon> = {
  image: ImageIcon, video: Film, audio: Music, model3d: Box, document: FileText, text: FileCode, archive: FileArchive, file: FileIcon,
};

/** The "+" in the home composer's toolbar, and the file input it opens: any type, several at once. */
export function HomeAttachButton({ state, disabled, t }: { state: HomeFilesState; disabled: boolean; t: T }) {
  const hint = state.full ? t(`最多带 ${MAX_COMPOSER_ATTACHMENTS} 个文件`, `Up to ${MAX_COMPOSER_ATTACHMENTS} files`)
    : t('添加文件：图片、视频、音频、3D、文档等任意格式，也可以拖进来或粘贴', 'Add files of any type (pictures, video, audio, 3D, documents), or drop or paste them');
  return <>
    <button type="button" className="saas-home-attach" aria-label={t('添加文件', 'Add files')} title={hint} disabled={disabled || state.full} onClick={state.openPicker}>
      <Plus size={16} aria-hidden="true" />
    </button>
    <input ref={state.picker} type="file" multiple hidden tabIndex={-1} aria-hidden="true" onChange={state.onPicked} />
  </>;
}

/** One chip per file: its picture when it is one, its kind otherwise, its size, and where its upload stands. */
export function HomeFileChips({ state, disabled, t, locale }: { state: HomeFilesState; disabled: boolean; t: T; locale: UiLocale }) {
  if (!state.files.length) return null;
  return <ul className="saas-home-files" aria-label={t('要一起发送的文件', 'Files to send with the request')}>
    {state.files.map(item => {
      const kind = homeFileKind(item.file);
      const Icon = KIND_ICON[kind];
      const status = item.failed ? t('没有传上去', 'Not uploaded') : item.uploaded ? t('已上传', 'Uploaded')
        : item.progress !== undefined ? t(`正在上传 ${Math.round(item.progress * 100)}%`, `Uploading ${Math.round(item.progress * 100)}%`)
          : formatFileSize(item.file.size, locale);
      return <li key={item.key} className={`saas-home-file is-${kind}${item.failed ? ' is-failed' : ''}${item.uploaded ? ' is-uploaded' : ''}`}
        title={item.failed ? `${item.file.name}：${item.failed}` : item.file.name}>
        {kind === 'image' ? <LocalThumb file={item.file} fallback={<Icon size={14} aria-hidden="true" />} />
          : <span className="saas-home-file-icon">{item.failed ? <AlertCircle size={14} aria-hidden="true" /> : <Icon size={14} aria-hidden="true" />}</span>}
        <span className="saas-home-file-name">{item.file.name}</span>
        <span className="saas-home-file-meta" role={item.failed ? 'alert' : undefined}>
          {item.progress !== undefined ? <Loader2 size={12} className="saas-home-file-spin" aria-hidden="true" /> : item.uploaded ? <Check size={12} aria-hidden="true" /> : null}
          {status}
        </span>
        <button type="button" className="saas-home-file-remove" disabled={disabled} aria-label={t(`移除「${item.file.name}」`, `Remove “${item.file.name}”`)}
          onClick={() => state.remove(item.key)}><X size={12} aria-hidden="true" /></button>
      </li>;
    })}
  </ul>;
}

/** A picture's own preview, read from the file in this tab; nothing is sent to show it. */
function LocalThumb({ file, fallback }: { file: File; fallback: ReactNode }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (typeof URL.createObjectURL !== 'function') return;
    const made = URL.createObjectURL(file);
    setUrl(made);
    return () => URL.revokeObjectURL(made);
  }, [file]);
  return url ? <img className="saas-home-file-thumb" src={url} alt="" onError={() => setUrl(null)} /> : <span className="saas-home-file-icon">{fallback}</span>;
}
