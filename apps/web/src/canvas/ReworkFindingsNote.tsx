import { useCallback, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { ChevronRight, ClipboardCheck } from 'lucide-react';
import type { SessionNode } from './canvasDoc';
import { DeliverableMarkdown } from './DeliverableMarkdown';
import { canvasText, useCanvasI18n } from './i18n';
import { useNodeViewPreference } from './nodeViewStyle';
import { reworkFindings } from './reviewVerdict';
import { useSimpleCanvas } from './uiMode';
import { useCutsComposer } from './useCutsComposer';

// 「按验收意见返工」 writes the review's findings into the reviewed Agent's task requirements (reworkFromReview in
// CanvasSurface), and every later run of the Agent is given them. The settings that edit task requirements are a
// developer surface, so the Agent's own chat shows them too, in either mode: whoever asked for the rework can read
// what the Agent is told. Read-only here; the text is the canvas document's own.
const MARKERS = (['zh', 'en'] as const).map(locale => canvasText(locale, 'assistant.reworkMarker'));

// While the opened inputs take a short column (`waiting`) there is no room for the findings: the note stays closed, as it
// says, and its toggle asks for the inputs to be closed first (it does not close them itself: that would end an upload
// in one of their fields). It stays focusable (aria-disabled), and a note left open shows again once the inputs close.
// Beside the opened inputs in a taller column (`column`: the chat column they take) the open findings show where the
// column holds them, as before, and wait the same way only while they would push the message box out of it
// (useCutsComposer.ts, measured before the page is painted). Taken out while the keyboard's focus is in them (a link,
// a path's copy button), they hand it to the toggle, which stays.
export function ReworkFindingsNote({ node, waiting = false, column }: { node: SessionNode; waiting?: boolean; column?: RefObject<HTMLElement | null> }) {
  const { t, locale } = useCanvasI18n();
  const simple = useSimpleCanvas();
  const findings = useMemo(() => reworkFindings(node.taskFrame, MARKERS), [node.taskFrame]);
  const [open, setOpen] = useState(false);
  // What the findings' height depends on besides the column: their text, the foot line's mode, the language, and the
  // opened node's look (its font, size and density live on the canvas root, which renders no tile when they change).
  const [look] = useNodeViewPreference();
  const drawn = useMemo(() => [findings, simple, locale, look], [findings, simple, locale, look]);
  const crowded = useCutsComposer(column, open && !waiting && findings.length > 0, drawn);
  const toggle = useRef<HTMLButtonElement>(null);
  const focusTaken = useRef(false);
  // Called once per body, before it leaves the page (a React 19 ref cleanup), while its focused element still is in it.
  // It must stay one callback (no deps): a new one each render would run the cleanup on every render and mark the
  // focus taken while the findings still show. The toggle takes the focus only if it fell to the page, and without
  // scrolling: the canvas root clips its world and is moved by the camera alone (TileTranscript hands its focus on the
  // same way).
  const watchFocus = useCallback((body: HTMLDivElement | null) => {
    if (!body) return;
    return () => { if (body.contains(document.activeElement)) focusTaken.current = true; };
  }, []);
  useLayoutEffect(() => {
    if (!focusTaken.current) return;
    focusTaken.current = false;
    if (!document.activeElement || document.activeElement === document.body) toggle.current?.focus({ preventScroll: true });
  });
  if (!findings.length) return null;
  const waits = waiting || crowded;
  const shown = open && !waits;
  const title = findings.length === 1 ? t('tile.reworkFrom', { node: findings[0].reviewer }) : t('tile.reworkFromMany', { count: findings.length });
  return <section className="awwo-rework-note" aria-label={t('tile.reworkNote')} data-testid={`rework-findings-${node.id}`}>
    <button ref={toggle} type="button" className="awwo-rework-note-toggle" aria-expanded={shown} aria-disabled={waits || undefined} onClick={() => { if (!waits) setOpen(!open); }}>
      <ClipboardCheck size={13} aria-hidden="true" /><span>{title}</span>
      <small>{t(waits ? 'tile.reworkWaiting' : shown ? 'tile.reworkHide' : 'tile.reworkShow')}</small><ChevronRight className="awwo-rework-note-chevron" size={13} aria-hidden="true" />
    </button>
    {shown ? <div ref={watchFocus} className="awwo-rework-note-body">
      {findings.map((item, index) => <article key={`${index}-${item.reviewer}`}>
        {findings.length > 1 ? <strong>{t('tile.reworkFrom', { node: item.reviewer })}</strong> : null}
        <div className="awwo-deliverable-body awwo-markdown-preview"><DeliverableMarkdown>{item.text}</DeliverableMarkdown></div>
      </article>)}
      <p className="awwo-rework-note-foot">{t(simple ? 'tile.reworkFootSimple' : 'tile.reworkFoot')}</p>
    </div> : null}
  </section>;
}
