// Files attached to a message travel as lines at the end of its text, one per file:
//
//   [附件] cover.png · awwo-file:a8x…   (English: "[Attachment] cover.png · awwo-file:a8x…")
//
// A composer shows those lines as chips and the rest as the text being written; a transcript does the same for a
// sent message. The server reads the awwo-file references, attaches the files that belong to the canvas, and
// appends one quoted data block after the marker below (uploads.go), which is never shown as the user's words.
//
// Keeping the files in the text means a draft, a recovered request, a planner proposal and a node's file input
// all carry them without a second channel that could fall out of step.

import type { UiLocale } from '../locale';

export type AttachmentKind = 'image' | 'video' | 'audio' | 'model3d' | 'document' | 'text' | 'archive' | 'file';

export interface ComposerAttachment {
  id: string;
  name: string;
  kind: AttachmentKind;
}

/** What the upload route answers (uploads.go uploadView). */
export interface UploadedCanvasFile {
  id: string;
  reference: string;
  name: string;
  size: number;
  contentType: string;
  kind: string;
  inline: boolean;
}

export const MAX_COMPOSER_ATTACHMENTS = 10;
/** AWWO_UPLOAD_MAX_MB's default; the server's own limit decides, this only spares a doomed upload. */
export const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
export const ATTACHMENT_DATA_MARKER = '【用户上传的附件 · Uploaded files】';

const ID = /^a[A-Za-z0-9_-]{8,128}$/;
const LINE = /^\[(附件|Attachment)\] (.+) · awwo-file:(a[A-Za-z0-9_-]{8,128})$/;

const EXTENSION_KINDS: Record<string, AttachmentKind> = {};
const kinds: Array<[AttachmentKind, string]> = [
  ['image', 'png jpg jpeg webp gif bmp avif heic heif svg tif tiff ico psd dng raw'],
  ['video', 'mp4 mov webm mkv avi flv wmv m4v'],
  ['audio', 'mp3 wav flac ogg m4a aac opus wma mid'],
  ['model3d', 'glb gltf obj stl fbx ply dae usdz 3mf blend'],
  ['document', 'pdf docx doc xlsx xls pptx ppt odt rtf epub key pages numbers'],
  ['text', 'txt md markdown csv tsv json jsonl xml yaml yml html htm css js mjs ts tsx jsx py go java c cpp h cs rs rb php sh sql srt vtt log'],
  ['archive', 'zip gz tgz tar 7z rar'],
];
for (const [kind, list] of kinds) for (const ext of list.split(' ')) EXTENSION_KINDS[ext] = kind;

/** A file's kind from what the server sniffed, or else from its name. */
export function attachmentKind(name: string, serverKind?: string): AttachmentKind {
  if (serverKind && (['image', 'video', 'audio', 'model3d', 'document', 'text', 'archive', 'file'] as const).includes(serverKind as AttachmentKind)) {
    return serverKind as AttachmentKind;
  }
  const dot = name.lastIndexOf('.');
  return (dot >= 0 ? EXTENSION_KINDS[name.slice(dot + 1).toLowerCase()] : undefined) ?? 'file';
}

/** A name can never break its own line: no line breaks, and no text that reads as the reference part. */
function lineName(name: string): string {
  const cleaned = name.replace(/[\r\n\u2028\u2029]+/g, ' ').replace(/ · awwo-file:/g, ' - ').trim();
  return cleaned || 'file';
}

export function attachmentLine(item: Pick<ComposerAttachment, 'id' | 'name'>, locale: UiLocale): string {
  return `[${locale === 'zh' ? '附件' : 'Attachment'}] ${lineName(item.name)} · awwo-file:${item.id}`;
}

/** The text a person wrote, and the files it carries. A server data block after the lines is dropped. */
export function splitAttachments(text: string): { body: string; attachments: ComposerAttachment[] } {
  const marker = text.indexOf(ATTACHMENT_DATA_MARKER);
  const source = marker >= 0 ? text.slice(0, marker).replace(/\s+$/, '') : text;
  const lines = source.split('\n');
  const found: ComposerAttachment[] = [];
  while (lines.length) {
    const match = LINE.exec(lines[lines.length - 1]);
    if (!match) break;
    lines.pop();
    found.unshift({ id: match[3], name: match[2], kind: attachmentKind(match[2]) });
  }
  if (!found.length) return { body: source, attachments: [] };
  // joinAttachments put one blank line between the text and the first file.
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const seen = new Set<string>();
  return { body: lines.join('\n'), attachments: found.filter(item => !seen.has(item.id) && Boolean(seen.add(item.id))) };
}

export function joinAttachments(body: string, attachments: ReadonlyArray<Pick<ComposerAttachment, 'id' | 'name'>>, locale: UiLocale): string {
  const valid = attachments.filter(item => ID.test(item.id));
  if (!valid.length) return body;
  const lines = valid.map(item => attachmentLine(item, locale)).join('\n');
  return body ? `${body}\n\n${lines}` : lines;
}

/** Only the text a person wrote, for previews and titles. */
export function withoutAttachments(text: string): string {
  return splitAttachments(text).body;
}

export function formatFileSize(bytes: number, locale: UiLocale): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${new Intl.NumberFormat(locale === 'zh' ? 'zh-CN' : 'en', { maximumFractionDigits: value < 10 && unit > 0 ? 1 : 0 }).format(value)} ${units[unit]}`;
}

/** Files a drag or a paste carries; text and links on their own are left to the box. */
export function eventFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  const files = Array.from(data.files ?? []);
  if (files.length) return files;
  return Array.from(data.items ?? []).filter(item => item.kind === 'file').map(item => item.getAsFile()).filter((file): file is File => Boolean(file));
}

export function carriesFiles(data: DataTransfer | null): boolean {
  return Boolean(data && Array.from(data.types ?? []).includes('Files'));
}
