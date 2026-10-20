import { useMemo, useState } from 'react';
import { ChevronRight, ClipboardCheck } from 'lucide-react';
import type { SessionNode } from './canvasDoc';
import { DeliverableMarkdown } from './DeliverableMarkdown';
import { canvasText, useCanvasI18n } from './i18n';
import { reworkFindings } from './reviewVerdict';
import { useSimpleCanvas } from './uiMode';

// 「按验收意见返工」 writes the review's findings into the reviewed Agent's task requirements (reworkFromReview in
// CanvasSurface), and every later run of the Agent is given them. The settings that edit task requirements are a
// developer surface, so the Agent's own chat shows them too, in either mode: whoever asked for the rework can read
// what the Agent is told. Read-only here; the text is the canvas document's own.
const MARKERS = (['zh', 'en'] as const).map(locale => canvasText(locale, 'assistant.reworkMarker'));

// While the opened inputs take a short column (`waiting`) there is no room for the findings: the note stays closed, as it
// says, and its toggle asks for the inputs to be closed first (it does not close them itself: that would end an upload
// in one of their fields). It stays focusable (aria-disabled), and a note left open shows again once the inputs close.
export function ReworkFindingsNote({ node, waiting = false }: { node: SessionNode; waiting?: boolean }) {
  const { t } = useCanvasI18n();
  const simple = useSimpleCanvas();
  const findings = useMemo(() => reworkFindings(node.taskFrame, MARKERS), [node.taskFrame]);
  const [open, setOpen] = useState(false);
  if (!findings.length) return null;
  const shown = open && !waiting;
  const title = findings.length === 1 ? t('tile.reworkFrom', { node: findings[0].reviewer }) : t('tile.reworkFromMany', { count: findings.length });
  return <section className="awwo-rework-note" aria-label={t('tile.reworkNote')} data-testid={`rework-findings-${node.id}`}>
    <button type="button" className="awwo-rework-note-toggle" aria-expanded={shown} aria-disabled={waiting || undefined} onClick={() => { if (!waiting) setOpen(!open); }}>
      <ClipboardCheck size={13} aria-hidden="true" /><span>{title}</span>
      <small>{t(waiting ? 'tile.reworkWaiting' : shown ? 'tile.reworkHide' : 'tile.reworkShow')}</small><ChevronRight className="awwo-rework-note-chevron" size={13} aria-hidden="true" />
    </button>
    {shown ? <div className="awwo-rework-note-body">
      {findings.map((item, index) => <article key={`${index}-${item.reviewer}`}>
        {findings.length > 1 ? <strong>{t('tile.reworkFrom', { node: item.reviewer })}</strong> : null}
        <div className="awwo-deliverable-body awwo-markdown-preview"><DeliverableMarkdown>{item.text}</DeliverableMarkdown></div>
      </article>)}
      <p className="awwo-rework-note-foot">{t(simple ? 'tile.reworkFootSimple' : 'tile.reworkFoot')}</p>
    </div> : null}
  </section>;
}
