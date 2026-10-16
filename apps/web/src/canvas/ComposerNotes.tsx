// 用户须知: the notes a composer used to print around itself (that nothing sensitive belongs in a message and AI output
// can be wrong, what a message costs, how a node's chat differs from its task), behind one small button in the
// composer's toolbar, as chat apps keep them out of the way of the box (owner request 2026-10-12: 这里都放到用户须知里面).
//
// The list opens above the button in a layer of its own (a portal on the page), so a card or a scrolled panel never
// clips it, and closes on a click elsewhere, on Escape (the focus goes back to the button), when anything scrolls
// or the window is resized, since it is placed where the button was, or when the button is no longer laid out (the
// assistant's panel it is in steps aside for an open node).
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Info } from 'lucide-react';
import './composer-notes.css';
import { useCanvasI18n } from './i18n';

export interface ComposerNotesProps {
  /** The notes, in the order shown; empty ones are left out, and with none the button is not drawn. */
  notes: ReadonlyArray<string | false | null | undefined>;
  className?: string;
}

export function ComposerNotes({ notes, className }: ComposerNotesProps) {
  const { t } = useCanvasI18n();
  const shown = notes.filter((note): note is string => typeof note === 'string' && note.trim().length > 0);
  const [place, setPlace] = useState<{ left: number; width: number; bottom: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const open = place !== null;

  useEffect(() => {
    if (!open) return;
    const close = () => setPlace(null);
    const away = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (button.current?.contains(target) || panel.current?.contains(target))) return;
      close();
    };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { close(); button.current?.focus(); } };
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', key);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    const gone = typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => { if (button.current && !button.current.getClientRects().length) close(); }) : null;
    if (button.current) gone?.observe(button.current);
    return () => {
      gone?.disconnect();
      document.removeEventListener('pointerdown', away, true);
      document.removeEventListener('keydown', key);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [open]);

  if (!shown.length) return null;
  const toggle = () => {
    if (open || !button.current) { setPlace(null); return; }
    // Right-aligned to the button, but never past either edge of the window (a panel at the screen's edge included).
    const rect = button.current.getBoundingClientRect();
    const width = Math.min(320, window.innerWidth - 16);
    const left = Math.min(Math.max(8, rect.right + 6 - width), window.innerWidth - width - 8);
    setPlace({ left, width, bottom: Math.max(8, window.innerHeight - rect.top + 8) });
  };
  return <>
    <button ref={button} type="button" className={`awwo-composer-notes-button${className ? ` ${className}` : ''}`}
      aria-label={t('composer.notesTitle')} title={t('composer.notesTitle')} aria-expanded={open} aria-controls={open ? id : undefined} onClick={toggle}>
      <Info size={15} aria-hidden="true" />
    </button>
    {open ? createPortal(<div ref={panel} id={id} className="awwo-composer-notes" role="region" aria-label={t('composer.notesTitle')}
      style={{ left: place.left, width: place.width, bottom: place.bottom }}>
      <p className="awwo-composer-notes-title">{t('composer.notesTitle')}</p>
      <ul>{shown.map(note => <li key={note}>{note}</li>)}</ul>
    </div>, document.body) : null}
  </>;
}
