import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowUpFromLine, Check, Copy, FileCode2, FileDown, FileText, RotateCcw } from 'lucide-react';
import { caseRunLabel, type SessionNode } from './canvasDoc';
import { ContractFields } from './ContractFields';
import { emptyContract, parseContractOutput, validateContractFields, type ContractField } from './nodeContracts';
import { activeNodeThread } from './nodeThreads';
import { getAgentTemplateForNode } from './agentTemplates';
import { useCanvasI18n } from './i18n';
import { ArtifactPreview, StoredArtifactPreview } from './ArtifactPreview';
import { currentSaaSCanvas, storedArtifactUrl } from '../saas/canvasBridge';
import { appendDeliveryProfile, deliveryCapabilityNotice, deliveryProfiles, type DeliveryProfileId } from './deliveryProfiles';
import { deliveryPresentation } from './fileDeliveryPresentation';
import { PendingFileDelivery } from './PendingFileDelivery';
import { parseMediaOutput } from './mediaOutput';
import { MediaResult } from './MediaResult';
import { mediaKindOf } from './mediaCatalog';
import { DeliverableMarkdown, LocalFileReference, localFilePath } from './DeliverableMarkdown';
import { canvasResolver } from './studio/canvasAssets';
import type { StudioEntry } from './studio/studioModel';

// Results and other surfaces render deliveries through the same inert Markdown.
export { DeliverableMarkdown };

/** Recover a readable preview from a legacy one-field result with unescaped inner quotes. */
function legacyWrappedPreview(source: string, fieldId: string): string | undefined {
  const trimmed = source.trim();
  const prefix = `{"${fieldId}":"`;
  if (!trimmed.startsWith(prefix) || !trimmed.endsWith('"}')) return;
  try { JSON.parse(trimmed); return; } catch { /* The original source remains available below. */ }
  return trimmed.slice(prefix.length, -2).replace(/\\n/g, '\n').replace(/\\"/g, '"');
}

/** Copies a field's exact published value. A quiet icon at rest; it confirms in place. */
function CopyValue({ value, title }: { value: string; title: string }) {
  const { t } = useCanvasI18n();
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const timer = setTimeout(() => setState('idle'), 1600);
    return () => clearTimeout(timer);
  }, [state]);
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); setState('copied'); }
    catch { setState('failed'); }
  };
  const label = t('deliverable.copyValue', { title });
  return <button type="button" className={`awwo-deliverable-copy${state === 'copied' ? ' is-copied' : ''}`} aria-label={label} title={label}
    onClick={() => { void copy(); }}>
    {state === 'copied' ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
    <span className="awwo-deliverable-copy-text" aria-live="polite">{state === 'copied' ? t('deliverable.copied') : state === 'failed' ? t('deliverable.copyFailed') : ''}</span>
  </button>;
}

/** Re-render once a minute, only while a dated delivery is shown, so its relative time stays true. */
function useMinuteClock(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [enabled]);
  return now;
}

/** "3 minutes ago" for a stored delivery; nothing for the legacy outputs that carry no time. */
function deliveryAge(at: number, now: number, t: ReturnType<typeof useCanvasI18n>['t']): string {
  if (!at || at < 1e12) return '';
  const minutes = Math.round(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return t('time.justNow');
  if (minutes < 60) return t('time.minutesAgo', { count: minutes });
  const hours = Math.round(minutes / 60);
  return hours < 24 ? t('time.hoursAgo', { count: hours }) : t('time.daysAgo', { count: Math.round(hours / 24) });
}

export interface NodeDeliverablesProps {
  node: SessionNode;
  readOnly: boolean;
  onUpdateNode?: (node: SessionNode) => void;
  /** 'result' shows only what the node published, as the canvas's 成果 view does: no editors, and not an
   *  earlier conversation's result. The tile drawer is 'drawer'. */
  presentation?: 'drawer' | 'result';
  /** Open with the deliverable form's editor expanded (the template guide's "edit deliverables"). */
  editorOpen?: boolean;
  /** Counts the presses of that edit button: each one opens the editor again, also after it was collapsed. */
  editorRequest?: number;
  /** Run the node's task again: offered where a file field came back as a name with no file behind it. */
  onRerun?: () => void;
  /** The field to show first (the 成果 view opens the deliverable a reader picked from its index). */
  initialFieldId?: string;
  /** Every file of the canvas (studioModel.ts), so a delivered page shows the pictures and clips other nodes made and
   *  names by `<node id>/<file name>` (a media node wired into it), as the card preview and the studio do. */
  canvasEntries?: ReadonlyArray<StudioEntry>;
}

/** What a published `file` field holds: bytes the server keeps, or (in a cloud workspace) only words — a name,
 *  a path or a link that no file stands behind, which is said rather than shown as if it were a delivery. A value a
 *  person published by hand is their own reference (the field invites a path or an https:// link) and is shown as it is. */
function fileState(field: ContractField, value: string, manual: boolean): 'stored' | 'missing' | null {
  if (field.type !== 'file' || !currentSaaSCanvas()) return null;
  if (storedArtifactUrl(value)) return 'stored';
  return value.trim() && !manual ? 'missing' : null;
}

function MissingFile({ value, onRerun, readOnly }: { value: string; onRerun?: () => void; readOnly: boolean }) {
  const { t } = useCanvasI18n();
  const name = value.trim().length > 120 ? `${value.trim().slice(0, 120)}…` : value.trim();
  return <div className="awwo-deliverable-missing-file" role="note">
    <p><AlertTriangle size={14} aria-hidden="true" /><span>{t('deliverable.fileMissing', { name })}</span></p>
    <p className="awwo-field-hint">{t(onRerun && !readOnly ? 'deliverable.fileMissingRerunHint' : 'deliverable.fileMissingHint')}</p>
    {onRerun && !readOnly ? <button type="button" onClick={onRerun}><RotateCcw size={13} aria-hidden="true" />{t('deliverable.fileMissingRerun')}</button> : null}
  </div>;
}

/** Only published output is a deliverable. Editing a form never creates one implicitly. */
export function NodeDeliverables({ node, readOnly, onUpdateNode, presentation = 'drawer', editorOpen = false, editorRequest = 0, onRerun, initialFieldId, canvasEntries }: NodeDeliverablesProps) {
  const { locale, t } = useCanvasI18n();
  const resolveAsset = useMemo(() => canvasEntries?.length ? canvasResolver(canvasEntries) : undefined, [canvasEntries]);
  const editor = useRef<HTMLDetailsElement>(null);
  // A collapsed <details> keeps its own state; each edit request opens it again.
  useEffect(() => { if (editorOpen && editor.current) editor.current.open = true; }, [editorOpen, editorRequest]);
  const [publishErrors, setPublishErrors] = useState<string[]>([]);
  const [selection, setSelection] = useState<{ identity: string; fieldId: string } | null>(null);
  const [deliveryProfile, setDeliveryProfile] = useState<DeliveryProfileId>('web');
  const selectedPanelId = useId();
  const deliverableTitle = getAgentTemplateForNode(node, locale)?.deliverableTitle;
  const contract = node.contract ?? emptyContract();
  const result = presentation === 'result';
  const output = result ? node.lastOutput ?? undefined : node.lastOutput ?? activeNodeThread(node).lastOutput;
  // Looking at an earlier Session must not publish its historical result downstream.
  const historical = !node.lastOutput && Boolean(output);
  const locked = readOnly || !onUpdateNode;
  const parsed = output ? deliveryPresentation(contract, output.text) : null;
  const publishedFields = parsed ? contract.outputs.filter(field => Object.hasOwn(parsed.values, field.id) || parsed.pendingFiles.has(field.id)) : [];
  const outputIdentity = `${node.id}:${activeNodeThread(node).id}:${output?.at ?? ''}`;
  // A selection belongs to one publication. New Sessions/results and removed fields fall
  // back synchronously, so no render exposes a previous file while effects catch up.
  const selectedField = (selection?.identity === outputIdentity && publishedFields.find(field => field.id === selection.fieldId))
    || (initialFieldId ? publishedFields.find(field => field.id === initialFieldId) : undefined) || publishedFields[0];
  // An image or video node's result names stored files; it is shown as them, not as its record.
  const media = output && !contract.outputs.length && mediaKindOf(node.agentKind) ? parseMediaOutput(output.text) : null;
  // A malformed or legacy result remains visible as evidence, without manufacturing fields.
  const showRawOutput = output && !media && (!contract.outputs.length || Boolean(parsed?.errors.length) || !publishedFields.length);

  const updateFields = (fields: ContractField[]) => {
    if (locked) return;
    setPublishErrors([]);
    onUpdateNode?.({ ...node, contract: { ...contract, outputs: fields } });
  };
  const publishOutput = () => {
    if (locked || !contract.outputs.length) return;
    const errors = validateContractFields(contract.outputs);
    if (errors.length) { setPublishErrors(errors); return; }
    // Optional empty scalar fields stay absent; Markdown retains its exact source text.
    const values = Object.fromEntries(contract.outputs
      .filter(field => field.value.trim() || field.required || (field.type !== 'number' && field.type !== 'boolean'))
      .map(field => [field.id, field.type === 'number' ? Number(field.value) : field.type === 'boolean' ? field.value === 'true' : field.value]));
    const text = JSON.stringify(values);
    const validation = parseContractOutput(contract, text);
    if (validation.errors.length) { setPublishErrors(validation.errors); return; }
    setPublishErrors([]);
    onUpdateNode?.({ ...node, lastOutput: { text, at: Date.now(), source: 'manual' } });
  };

  // Only recorded facts: an output with no source claims no provenance, a legacy one no time, and a
  // case recording only the day its run is labelled with.
  const dated = Boolean(output && output.source !== 'case' && output.at >= 1e12);
  const now = useMinuteClock(dated);
  const age = output ? deliveryAge(output.at, now, t) : '';
  const receipt = output ? [
    output.source === 'run' ? t('deliverable.fromRun') : output.source === 'manual' ? t('deliverable.fromManual')
      : output.source === 'case' ? t('deliverable.fromCase', { run: caseRunLabel(output) }) : '',
    // A case recording's date is the case's run, already named above, not when this canvas got it.
    age && output.source !== 'case' ? t('deliverable.receivedAt', { age }) : '',
    // A field present but blank was not delivered; count only what has content.
    !showRawOutput && contract.outputs.length > 1
      ? t('deliverable.fieldCount', { done: publishedFields.filter(field => String(parsed!.values[field.id]).trim() !== '').length, total: contract.outputs.length }) : '',
  ].filter(Boolean) : [];

  return <div className="awwo-deliverables">
    {deliverableTitle && !result ? <h3 className="awwo-deliverables-title">{deliverableTitle}</h3> : null}
    {!locked && !result && <details className="awwo-deliverables-editor">
      <summary>{locale === 'zh' ? '添加交付要求' : 'Add a deliverable'}</summary>
      <label>{locale === 'zh' ? '交付形式' : 'Deliverable type'}
        <select value={deliveryProfile} onChange={event => setDeliveryProfile(event.target.value as DeliveryProfileId)}>
          {deliveryProfiles(locale).map(profile => <option key={profile.id} value={profile.id}>{profile.label}</option>)}
        </select>
      </label>
      <p className="awwo-field-hint">{deliveryProfiles(locale).find(profile => profile.id === deliveryProfile)!.description}</p>
      <button type="button" onClick={() => {
        try {
          const next = appendDeliveryProfile(contract, deliveryProfile, locale);
          if (next !== contract) updateFields(next.outputs);
        } catch (error) { setPublishErrors([error instanceof Error ? error.message : String(error)]); }
      }}>{locale === 'zh' ? '添加到交付' : 'Add requirement'}</button>
      <p className="awwo-field-hint">{deliveryCapabilityNotice(locale)}</p>
    </details>}
    {!output ? <>
      <p className="awwo-deliverables-empty">{t('deliverable.empty', { title: deliverableTitle || t('deliverable.defaultTitle') })}</p>
      {contract.outputs.length ? <ul className="awwo-expected-deliverables" aria-label={t('deliverable.expected')}>
        {contract.outputs.map(field => <li key={field.id}><span>{field.label || field.id}</span><span>{t('deliverable.pending')}</span></li>)}
      </ul> : null}
      {/* Stored files open in their own viewer only in a cloud workspace. */}
      {currentSaaSCanvas() ? <p className="awwo-field-hint">{t('deliverable.previewTypes')}</p> : null}
    </> : <>
      {/* Where this came from and how complete it is, before the content itself. Caveats
          (history, partial, manual) are amber; plain provenance stays quiet. */}
      {/* The 成果 view states where a result came from in its own heading. */}
      {receipt.length && !result ? <div className={`awwo-deliverables-receipt${output.partial || historical || output.source === 'case' ? ' is-caveat' : ''}`}>
        <span className="awwo-deliverables-source" title={dated ? new Date(output.at).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US') : undefined}>{receipt.join(' · ')}</span>
      </div> : null}
      {!result && (historical || output.partial || output.source === 'manual' || output.source === 'case') && <div className="awwo-deliverables-meta">
        {historical && <span>{t('deliverable.historical')}</span>}
        {output.partial && <span>{t('deliverable.partial')}</span>}
        {output.source === 'manual' && <span>{t('deliverable.manual')}</span>}
        {output.source === 'case' && !historical && <span>{t('deliverable.case')}</span>}
      </div>}
      {parsed?.errors.length ? <p className="awwo-contract-errors" role="alert" title={parsed.errors.join(' ')}>{t('deliverable.invalid')}</p> : null}
      {media ? <article className="awwo-deliverable" data-testid={`canvas-tile-output-${node.id}`}><MediaResult output={media} /></article>
      : showRawOutput ? <article className="awwo-deliverable" data-testid={`canvas-tile-output-${node.id}`}>
        <h3 className="awwo-deliverable-title">{t(parsed?.errors.length ? 'deliverable.raw' : 'deliverable.runOutput')}</h3>
        <div className="awwo-deliverable-body awwo-markdown-preview">
          <DeliverableMarkdown>{parsed!.displaySource}</DeliverableMarkdown>
        </div>
      </article> : <div data-testid={`canvas-tile-output-${node.id}`}>
        {/* Where the files are, said first: a page or a stored file is the delivery people look for, and its tab name
            ("预览入口") does not say that a file is behind it. A file field that holds only a name is said too. */}
        {(() => {
          const files = publishedFields.map(field => {
            const value = String(parsed!.values[field.id] ?? '');
            const state = field.type === 'html' && value.trim() ? 'page' : fileState(field, value, output.source === 'manual');
            return state ? { field, state } : null;
          }).filter((item): item is { field: ContractField; state: 'page' | 'stored' | 'missing' } => item !== null);
          if (!files.length || publishedFields.length < 2) return null;
          return <div className="awwo-deliverable-filelist" role="group" aria-label={t('deliverable.filesTitle')}>
            <span className="awwo-deliverable-filelist-lead">{(() => {
              const count = files.filter(item => item.state !== 'missing').length;
              return t(count ? 'deliverable.filesLead' : 'deliverable.filesNone', { count });
            })()}</span>
            {files.map(({ field, state }) => <button key={field.id} type="button" className={state === 'missing' ? 'is-missing' : undefined}
              aria-controls={selectedPanelId} onClick={() => setSelection({ identity: outputIdentity, fieldId: field.id })}>
              {state === 'missing' ? <AlertTriangle size={13} aria-hidden="true" /> : state === 'page' ? <FileCode2 size={13} aria-hidden="true" /> : <FileDown size={13} aria-hidden="true" />}
              <span>{field.label || field.id}</span>
              <small>{t(state === 'missing' ? 'deliverable.fileOnlyName' : state === 'page' ? 'deliverable.filePage' : 'deliverable.fileOpen')}</small>
            </button>)}
          </div>;
        })()}
        {publishedFields.length > 1 && <div className="awwo-deliverable-files" role="group" aria-label={t('deliverable.defaultTitle')}>
          {publishedFields.map(field => {
            const value = String(parsed!.values[field.id] ?? '');
            const state = field.type === 'html' && value.trim() ? 'page' : fileState(field, value, output.source === 'manual');
            return <button key={field.id} type="button" aria-pressed={field.id === selectedField?.id}
              aria-controls={selectedPanelId} title={field.label || field.id}
              onClick={() => setSelection({ identity: outputIdentity, fieldId: field.id })}>
              {state === 'missing' ? <AlertTriangle size={13} aria-hidden="true" /> : state === 'page' ? <FileCode2 size={13} aria-hidden="true" />
                : state === 'stored' ? <FileDown size={13} aria-hidden="true" /> : <FileText size={13} aria-hidden="true" />}<span>{field.label || field.id}</span>
            </button>;
          })}
        </div>}
        {selectedField && [selectedField].map(field => {
          const value = parsed!.values[field.id] ?? '';
          const pendingFile = parsed!.pendingFiles.get(field.id);
          // A stored deliverable is bytes the server holds, so it offers a real download; a local
          // reference stays a path, and neither is presented as the other.
          const artifactUrl = field.type === 'file' ? storedArtifactUrl(value) : null;
          const filePath = field.type === 'file' && !artifactUrl ? localFilePath(value, true) : null;
          // Text-like values get a copy action. A file reference has its own path copy, a stored
          // artifact a download, and an HTML document is downloaded rather than pasted.
          const copyable = typeof value === 'string' && !filePath && !artifactUrl && field.type !== 'html' && value.trim() !== '';
          return <article className="awwo-deliverable" key={field.id} id={selectedPanelId} aria-label={field.label || field.id}>
          {publishedFields.length === 1 || copyable ? <header className="awwo-deliverable-head">
            {publishedFields.length === 1 ? <h3 className="awwo-deliverable-title">{field.label || field.id}</h3> : <span className="awwo-deliverable-head-spacer" />}
            {/* Keyed to this publication: a new delivery must not inherit an earlier "Copied". */}
            {copyable ? <CopyValue key={`${outputIdentity}:${field.id}`} value={value} title={field.label || field.id} /> : null}
          </header> : null}
          <div className={`awwo-deliverable-body${field.type === 'html' || field.type === 'markdown' || artifactUrl ? ' awwo-deliverable-with-preview' : ''}`}>
            {pendingFile ? <PendingFileDelivery file={pendingFile} /> : field.type === 'html' || field.type === 'markdown'
              ? <ArtifactPreview key={`${node.id}:${activeNodeThread(node).id}:${output.at}:${field.id}:${field.type}`} type={field.type} source={value}
                  previewSource={field.type === 'markdown' ? legacyWrappedPreview(value, field.id) : undefined}
                  title={field.label || field.id} canDownload={Boolean(value.trim()) && !output.partial}
                  resolveAsset={field.type === 'html' ? resolveAsset : undefined}
                  renderMarkdown={source => <DeliverableMarkdown>{source}</DeliverableMarkdown>} />
              : artifactUrl ? <StoredArtifactPreview reference={value} title={field.label || field.id}
                  identity={`${node.id}:${activeNodeThread(node).id}:${output.at}:${field.id}`}
                  renderMarkdown={source => <DeliverableMarkdown>{source}</DeliverableMarkdown>} />
              : fileState(field, String(value), output.source === 'manual') === 'missing' ? <MissingFile value={String(value)} onRerun={onRerun} readOnly={readOnly} />
              : filePath ? <LocalFileReference key={filePath} path={filePath} />
              : <span style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{value}</span>}
          </div>
        </article>;
        })}
      </div>}
    </>}
    {!result && <details ref={editor} className="awwo-deliverables-editor" open={editorOpen || undefined}>
      <summary>{t('deliverable.editForm')}</summary>
      <ContractFields fields={contract.outputs} label={t('deliverable.outputLabel')} readOnly={locked} onChange={updateFields} />
      <div className="awwo-output-publish">
        <p>{t('deliverable.republishHint')}</p>
        <button type="button" disabled={locked || !contract.outputs.length} onClick={publishOutput}>
          <ArrowUpFromLine size={14} aria-hidden="true" />{t('deliverable.publish')}
        </button>
      </div>
      {publishErrors.length ? <div className="awwo-contract-errors" role="alert">{publishErrors.join(' ')}</div> : null}
    </details>}
  </div>;
}
