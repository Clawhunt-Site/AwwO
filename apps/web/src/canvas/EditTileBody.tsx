// An edit node's card body and result (canvasDoc.ts EditNode): once a cloud run made its film, the film plays like a video
// node's (MediaResult) with a line of what the edit says of it and its other files; before that, what to wire into it.
import { Download } from 'lucide-react';
import type { EditNode } from './canvasDoc';
import { useCanvasI18n, type CanvasTranslate } from './i18n';
import { MediaResult } from './MediaResult';
import { parseEditFacts, parseMediaOutput, type EditFacts, type EditFile } from './mediaOutput';
import { formatBytes } from './studio/studioModel';
import { storedArtifactUrl, storedMediaUrl } from '../saas/canvasBridge';
import './edit-node.css';

/** Stills shown in the card; the studio lists every one. */
const STILLS_SHOWN = 4;

/** "−16" for a level in dB or LUFS: at most one decimal, a true minus sign. */
function level(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return `${rounded < 0 ? '−' : ''}${Math.abs(rounded)}`;
}

/** "12.5 s · 1920×822 · −16 LUFS · Warnings: 1": the film's length, frame, loudness and how many things the edit adjusted. */
export function editSummary(facts: EditFacts, t: CanvasTranslate): string {
  const lufs = facts.loudness?.integratedLUFS;
  return [
    t('edit.seconds', { seconds: facts.seconds.toFixed(1) }),
    facts.width && facts.height ? `${facts.width}×${facts.height}` : '',
    lufs !== undefined ? `${level(lufs)} LUFS` : '',
    facts.warnings.length ? t('edit.warnings', { count: facts.warnings.length }) : '',
  ].filter(Boolean).join(' · ');
}

/** The node's one line on a card too small for its film: the film's summary, or that there is none yet. */
export function editPreview(node: EditNode, t: CanvasTranslate): string {
  const facts = parseEditFacts(node.lastOutput?.text);
  if (facts) return editSummary(facts, t);
  return parseMediaOutput(node.lastOutput?.text) ? t('media.generatedVideos', { count: 1 }) : t('edit.emptyTitle');
}

/** A stored file's download, or its bare name where no workspace serves it (a local canvas showing a cloud result). */
function FileLink({ file, label }: { file: EditFile; label: string }) {
  const { t } = useCanvasI18n();
  const download = storedArtifactUrl(`awwo-file:${file.artifactId}`);
  const text = `${label} · ${file.name} · ${formatBytes(file.size)}`;
  return download ? <a href={download} download={file.name} rel="noreferrer" aria-label={t('edit.download', { name: file.name })}>
    <Download size={12} aria-hidden="true" />{text}</a> : <span>{text}</span>;
}

/** The edit's subtitles and report to download, and its stills: the first few, each opening full size, and how many. */
function EditFiles({ files }: { files: ReadonlyArray<EditFile> }) {
  const { t } = useCanvasI18n();
  const stills = files.filter(file => file.role === 'still');
  return <section className="awwo-edit-files" aria-label={t('edit.files')}>
    <h4>{t('edit.files')}</h4>
    <ul>{files.filter(file => file.role !== 'still').map(file => <li key={file.artifactId}>
      <FileLink file={file} label={t(file.role === 'report' ? 'edit.roleReport' : 'edit.roleSubtitles')} /></li>)}</ul>
    {stills.length ? <>
      <p className="awwo-edit-note">{t('edit.stills', { count: stills.length })}</p>
      <div className="awwo-edit-stills">{stills.slice(0, STILLS_SHOWN).map(still => {
        const url = storedMediaUrl(still.artifactId);
        return url ? <a key={still.artifactId} href={url} target="_blank" rel="noopener noreferrer" title={still.name}>
          <img src={url} alt={still.name} loading="lazy" decoding="async" /></a> : <span key={still.artifactId}>{still.name}</span>;
      })}</div>
    </> : null}
  </section>;
}

/** An edit's delivery: its summary, the film, and its other files. A record that is not a film shows nothing made. */
export function EditResult({ node }: { node: EditNode }) {
  const { t } = useCanvasI18n();
  const film = parseMediaOutput(node.lastOutput?.text);
  const facts = parseEditFacts(node.lastOutput?.text);
  if (!film) return <p className="awwo-edit-note">{t('edit.emptyTitle')}</p>;
  return <div className="awwo-edit-result" data-testid={`edit-result-${node.id}`}>
    {facts ? <p className="awwo-edit-summary" title={facts.warnings.join('\n') || undefined}>{editSummary(facts, t)}</p> : null}
    <MediaResult output={film} />
    {facts?.files.length ? <EditFiles files={facts.files} /> : null}
  </div>;
}

/** The card's body: the result once opened enough to watch it, its one line when not; before a film, what to wire. */
export function EditTileBody({ node, expanded }: { node: EditNode; expanded: boolean }) {
  const { t } = useCanvasI18n();
  const made = Boolean(parseMediaOutput(node.lastOutput?.text));
  return <div className="awwo-edit-body" data-testid={`edit-body-${node.id}`}>
    {made ? expanded ? <EditResult node={node} /> : <p className="awwo-edit-summary">{editPreview(node, t)}</p>
      : <div className="awwo-edit-empty">
        <strong>{t('edit.emptyTitle')}</strong>
        <span>{t('edit.emptyWire')}</span>
        <span className="awwo-edit-note">{t(node.timeline.trim() ? 'edit.timelineOwn' : 'edit.timelineNone')}</span>
        {expanded ? <span className="awwo-edit-note">{t('edit.noModel')}</span> : null}
      </div>}
  </div>;
}
