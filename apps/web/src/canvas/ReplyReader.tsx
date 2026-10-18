// A node's reply read at full size. In an opened node a long reply with wide tables could only be read through the
// band its task card and message box left, and nothing enlarged it (customer report 2026-10-18: 「这里面的文字根本看
// 不全，也没办法放大」). The reader shows the reply as the conversation renders it, in the canvas's expanded preview
// dialog, wide, at a text size the reader picks and keeps for the next reply.
import { useState, type ReactNode } from 'react';
import { Maximize2, Minus, Plus } from 'lucide-react';
import { ExpandedPreview } from './ArtifactPreview';
import { useCanvasI18n } from './i18n';
import './reply-reader.css';

export const READER_TEXT_SIZES = [13, 14, 15, 16, 18, 20, 22] as const;
export const READER_TEXT_SIZE_KEY = 'awwo.reply-reader.text-size.v1';
const DEFAULT_SIZE = 16;

function storedSize(): number {
  try {
    const value = Number(localStorage.getItem(READER_TEXT_SIZE_KEY));
    return (READER_TEXT_SIZES as readonly number[]).includes(value) ? value : DEFAULT_SIZE;
  } catch { return DEFAULT_SIZE; }
}

/** Whether a reply is worth a full-size reading: long, or holding a table, which the conversation column cuts first. */
export function readerWorthy(text: string): boolean {
  return text.length >= 600 || /^\s*\|.*\|\s*$/m.test(text);
}

/** The reply's first words, which tell its reader button and dialog from another reply's (a code fence's own line, which
 *  names only its language, is not words of the reply). */
function preview(text: string): string {
  const line = text.split('\n').filter(part => !/^\s*(?:```|~~~)/.test(part))
    .map(part => part.replace(/[#>*_`|[\]-]+/g, ' ').replace(/\s+/g, ' ').trim()).find(Boolean) ?? '';
  return [...line].length > 24 ? [...line].slice(0, 24).join('') + '…' : line;
}

/** The button that opens the reply full size, in a sticky row that keeps it in view while any of the reply is, taking no
 *  width from it; `children` is the reply as the conversation renders it, `text` what it is about. */
export function ReplyReader({ text, children }: { text: string; children: ReactNode }) {
  const { locale, t } = useCanvasI18n();
  const [open, setOpen] = useState(false);
  const about = preview(text);
  const label = about ? `${t('transcript.readerOpen')}${locale === 'zh' ? '：' : ': '}${about}` : t('transcript.readerOpen');
  return <>
    <div className="canvas-transcript-reader-row">
      <button type="button" className="canvas-transcript-reader-open" aria-label={label} title={label} onClick={() => setOpen(true)}>
        <Maximize2 size={13} aria-hidden="true" /><span>{t('transcript.readerOpen')}</span>
      </button>
    </div>
    {open ? <ExpandedPreview title={about ? `${t('transcript.readerTitle')} · ${about}` : t('transcript.readerTitle')} closeLabel={t('transcript.readerClose')} onClose={() => setOpen(false)}>
      <ReaderBody>{children}</ReaderBody>
    </ExpandedPreview> : null}
  </>;
}

function ReaderBody({ children }: { children: ReactNode }) {
  const { t } = useCanvasI18n();
  const [size, setSize] = useState(storedSize);
  const sizes = READER_TEXT_SIZES as readonly number[];
  const at = sizes.indexOf(size);
  // A size button at its end stays focusable (aria-disabled, not disabled), so keyboard focus is not dropped.
  const step = (by: number) => {
    const next = sizes[Math.max(0, Math.min(sizes.length - 1, at + by))];
    if (next === size) return;
    try { localStorage.setItem(READER_TEXT_SIZE_KEY, String(next)); } catch { /* the size stays for this reading */ }
    setSize(next);
  };
  return <div className="awwo-reply-reader">
    <div className="awwo-reply-reader-tools" role="group" aria-label={t('transcript.readerTextSize')}>
      <button type="button" aria-label={t('transcript.readerSmaller')} title={t('transcript.readerSmaller')} aria-disabled={at === 0} onClick={() => step(-1)}><Minus size={15} aria-hidden="true" /></button>
      <output className="awwo-reply-reader-size" aria-live="polite">{size}px</output>
      <button type="button" aria-label={t('transcript.readerLarger')} title={t('transcript.readerLarger')} aria-disabled={at === sizes.length - 1} onClick={() => step(1)}><Plus size={15} aria-hidden="true" /></button>
    </div>
    <div className="awwo-reply-reader-body awwo-artifact-markdown" style={{ fontSize: `${size}px` }} data-testid="reply-reader-body">{children}</div>
  </div>;
}
