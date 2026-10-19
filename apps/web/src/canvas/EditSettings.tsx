import type { EditNode } from './canvasDoc';
import { editTimelineExample, editTimelineIssue, type EditTimelineIssue, type EditWiredFiles } from './editNode';
import { useCanvasI18n, type CanvasTextKey } from './i18n';
import './edit-node.css';

const ISSUE_KEY: Record<EditTimelineIssue, CanvasTextKey> = { not_json: 'edit.issueJson', schema: 'edit.issueSchema', tracks: 'edit.issueTracks' };
const NOTHING_WIRED: EditWiredFiles = { clips: [], sounds: [], pictures: [] };

/**
 * An edit node's settings: its own timeline (a wired one is used instead), a short guide, the files wired in now and the
 * schema's example naming them. A timeline that is plainly not one is said, never refused: the API and the render worker
 * check it in full when it runs, and a half-written one is still worth saving.
 */
export function EditSettings({ draft, busy, files = NOTHING_WIRED, onChange }: {
  draft: EditNode;
  busy: boolean;
  files?: EditWiredFiles;
  onChange: (next: EditNode) => void;
}) {
  const { t, locale } = useCanvasI18n();
  const issue = editTimelineIssue(draft.timeline);
  const wired = [...files.clips, ...files.sounds, ...files.pictures];
  const id = `edit-timeline-${draft.id}`;
  return <div className="awwo-edit-settings">
    <p className="canvas-inspector-hint">{t('edit.help')}</p>
    <label className="canvas-inspector-label" htmlFor={id}>{t('edit.timeline')}</label>
    <textarea id={id} className="canvas-inspector-input awwo-edit-timeline" spellCheck={false} rows={16} value={draft.timeline} disabled={busy}
      placeholder={'{ "schema": "awwo.timeline/1", … }'} aria-describedby={`${id}-hint`}
      onChange={event => onChange({ ...draft, timeline: event.target.value })} />
    <p id={`${id}-hint`} className="awwo-field-hint">{t('edit.wiredFirst')}</p>
    {issue ? <p className="awwo-contract-errors" role="status">{t(ISSUE_KEY[issue])}</p> : null}
    <p className="awwo-field-hint awwo-edit-wired">{wired.length ? t('edit.wiredFiles', { files: wired.join(locale === 'zh' ? '、' : ', ') }) : t('edit.wiredNone')}</p>
    <button type="button" className="canvas-inspector-add-field" disabled={busy}
      onClick={() => onChange({ ...draft, timeline: editTimelineExample(files, locale) })}>
      {t(draft.timeline.trim() ? 'edit.replaceExample' : 'edit.insertExample')}
    </button>
  </div>;
}
