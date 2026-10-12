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

export function ReworkFindingsNote({ node }: { node: SessionNode }) {
  const { t } = useCanvasI18n();
  const simple = useSimpleCanvas();
  const findings = useMemo(() => reworkFindings(node.taskFrame, MARKERS), [node.taskFrame]);
  const [open, setOpen] = useState(false);
  if (!findings.length) return null;
  const title = findings.length === 1 ? t('tile.reworkFrom', { node: findings[0].reviewer }) : t('tile.reworkFromMany', { count: findings.length });
  return <section className="awwo-rework-note" aria-label={t('tile.reworkNote')} data-testid={`rework-findings-${node.id}`}>
    <button type="button" className="awwo-rework-note-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
      <ClipboardCheck size={13} aria-hidden="true" /><span>{title}</span>
      <small>{t(open ? 'tile.reworkHide' : 'tile.reworkShow')}</small><ChevronRight className="awwo-rework-note-chevron" size={13} aria-hidden="true" />
    </button>
    {open ? <div className="awwo-rework-note-body">
      {findings.map((item, index) => <article key={`${index}-${item.reviewer}`}>
        {findings.length > 1 ? <strong>{t('tile.reworkFrom', { node: item.reviewer })}</strong> : null}
        <div className="awwo-deliverable-body awwo-markdown-preview"><DeliverableMarkdown>{item.text}</DeliverableMarkdown></div>
      </article>)}
      <p className="awwo-rework-note-foot">{t(simple ? 'tile.reworkFootSimple' : 'tile.reworkFoot')}</p>
    </div> : null}
  </section>;
}
