import { useEffect, useId, useState, type ReactNode } from 'react';
import { ArrowUpFromLine, Check, Copy, FileText } from 'lucide-react';
import ReactMarkdown, { defaultUrlTransform, type Components, type UrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { SessionNode } from './canvasDoc';
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

/** A display/copy reference only; recognizing a path never reads or opens a file. */
function localFilePath(value: string, plainFile = false): string | null {
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) return null;
  const fileUri = /^file:/i.test(value);
  let path = value;
  if (fileUri) {
    try {
      const url = new URL(value);
      path = `${url.hostname ? `//${url.hostname}` : ''}${url.pathname}`;
    } catch { return null; }
  } else if (!/^\/?[a-z]:(?:[\\/]|%5c|%2f)/i.test(value)
    && !(plainFile && value.startsWith('/') && !value.startsWith('//'))) return null;
  // Markdown hrefs are URI encoded; a plain file field already contains its literal path.
  if (fileUri || !plainFile) {
    try { path = decodeURIComponent(path); } catch { /* Preserve literal percent characters. */ }
  }
  if (/[\u0000-\u001f\u007f]/.test(path)) return null;
  return path.replace(/^\/(?=[a-z]:[\\/])/i, '');
}

function LocalFileReference({ path, children }: { path: string; children?: ReactNode }) {
  const { t } = useCanvasI18n();
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(path);
      setCopyState('copied');
    } catch { setCopyState('failed'); }
  };
  return <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 4, maxWidth: '100%', verticalAlign: 'top' }}>
    {children ? <span>{children}</span> : null}
    <code style={{ userSelect: 'text', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{path}</code>
    <button type="button" aria-label={t('deliverable.copyPath', { path })} style={{ alignSelf: 'flex-start' }} onClick={() => { void copyPath(); }}>{t('deliverable.copyPathButton')}</button>
    {copyState === 'copied' ? <span role="status">{t('deliverable.copied')}</span> : null}
    {copyState === 'failed' ? <span role="alert">{t('deliverable.copyFailed')}</span> : null}
  </span>;
}

const deliveryUrlTransform: UrlTransform = (url, key, node) =>
  // Only anchor paths reach our non-link renderer; images and every other URL keep sanitization.
  key === 'href' && node.tagName === 'a' && localFilePath(url) ? url : defaultUrlTransform(url);
const deliveryMarkdownComponents: Components = {
  a: ({ node: _node, href, children, ...props }) => {
    const path = href ? localFilePath(href) : null;
    return path ? <LocalFileReference key={path} path={path}>{children}</LocalFileReference>
      : <a {...props} href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
  },
  // Untrusted Markdown must not make credentialed image requests from the workbench origin.
  img: ({ alt }) => <span>{alt || '🖼'}</span>,
};

function DeliverableMarkdown({ children }: { children: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={deliveryUrlTransform} components={deliveryMarkdownComponents}>{children}</ReactMarkdown>;
}

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
}

/** Only published output is a deliverable. Editing a form never creates one implicitly. */
export function NodeDeliverables({ node, readOnly, onUpdateNode }: NodeDeliverablesProps) {
  const { locale, t } = useCanvasI18n();
  const [publishErrors, setPublishErrors] = useState<string[]>([]);
  const [selection, setSelection] = useState<{ identity: string; fieldId: string } | null>(null);
  const [deliveryProfile, setDeliveryProfile] = useState<DeliveryProfileId>('web');
  const selectedPanelId = useId();
  const deliverableTitle = getAgentTemplateForNode(node, locale)?.deliverableTitle;
  const contract = node.contract ?? emptyContract();
  const output = node.lastOutput ?? activeNodeThread(node).lastOutput;
  // Looking at an earlier Session must not publish its historical result downstream.
  const historical = !node.lastOutput && Boolean(output);
  const locked = readOnly || !onUpdateNode;
  const parsed = output ? deliveryPresentation(contract, output.text) : null;
  const publishedFields = parsed ? contract.outputs.filter(field => Object.hasOwn(parsed.values, field.id) || parsed.pendingFiles.has(field.id)) : [];
  const outputIdentity = `${node.id}:${activeNodeThread(node).id}:${output?.at ?? ''}`;
  // A selection belongs to one publication. New Sessions/results and removed fields fall
  // back synchronously, so no render exposes a previous file while effects catch up.
  const selectedField = (selection?.identity === outputIdentity && publishedFields.find(field => field.id === selection.fieldId)) || publishedFields[0];
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

  // Only recorded facts: an output with no source claims no provenance, a legacy one no time.
  const dated = Boolean(output && output.at >= 1e12);
  const now = useMinuteClock(dated);
  const age = output ? deliveryAge(output.at, now, t) : '';
  const receipt = output ? [
    output.source === 'run' ? t('deliverable.fromRun') : output.source === 'manual' ? t('deliverable.fromManual') : '',
    age ? t('deliverable.receivedAt', { age }) : '',
    // A field present but blank was not delivered; count only what has content.
    !showRawOutput && contract.outputs.length > 1
      ? t('deliverable.fieldCount', { done: publishedFields.filter(field => String(parsed!.values[field.id]).trim() !== '').length, total: contract.outputs.length }) : '',
  ].filter(Boolean) : [];

  return <div className="awwo-deliverables">
    {deliverableTitle ? <h3 className="awwo-deliverables-title">{deliverableTitle}</h3> : null}
    {!locked && <details className="awwo-deliverables-editor">
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
      {receipt.length ? <div className={`awwo-deliverables-receipt${output.partial || historical ? ' is-caveat' : ''}`}>
        <span className="awwo-deliverables-source" title={dated ? new Date(output.at).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US') : undefined}>{receipt.join(' · ')}</span>
      </div> : null}
      {(historical || output.partial || output.source === 'manual') && <div className="awwo-deliverables-meta">
        {historical && <span>{t('deliverable.historical')}</span>}
        {output.partial && <span>{t('deliverable.partial')}</span>}
        {output.source === 'manual' && <span>{t('deliverable.manual')}</span>}
      </div>}
      {parsed?.errors.length ? <p className="awwo-contract-errors" role="alert" title={parsed.errors.join(' ')}>{t('deliverable.invalid')}</p> : null}
      {media ? <article className="awwo-deliverable" data-testid={`canvas-tile-output-${node.id}`}><MediaResult output={media} /></article>
      : showRawOutput ? <article className="awwo-deliverable" data-testid={`canvas-tile-output-${node.id}`}>
        <h3 className="awwo-deliverable-title">{t(parsed?.errors.length ? 'deliverable.raw' : 'deliverable.runOutput')}</h3>
        <div className="awwo-deliverable-body awwo-markdown-preview">
          <DeliverableMarkdown>{parsed!.displaySource}</DeliverableMarkdown>
        </div>
      </article> : <div data-testid={`canvas-tile-output-${node.id}`}>
        {publishedFields.length > 1 && <div className="awwo-deliverable-files" role="group" aria-label={t('deliverable.defaultTitle')}>
          {publishedFields.map(field => <button key={field.id} type="button" aria-pressed={field.id === selectedField?.id}
            aria-controls={selectedPanelId} title={field.label || field.id}
            onClick={() => setSelection({ identity: outputIdentity, fieldId: field.id })}>
            <FileText size={13} aria-hidden="true" /><span>{field.label || field.id}</span>
          </button>)}
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
                  renderMarkdown={source => <DeliverableMarkdown>{source}</DeliverableMarkdown>} />
              : artifactUrl ? <StoredArtifactPreview reference={value} title={field.label || field.id}
                  identity={`${node.id}:${activeNodeThread(node).id}:${output.at}:${field.id}`}
                  renderMarkdown={source => <DeliverableMarkdown>{source}</DeliverableMarkdown>} />
              : filePath ? <LocalFileReference key={filePath} path={filePath} />
              : <span style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{value}</span>}
          </div>
        </article>;
        })}
      </div>}
    </>}
    <details className="awwo-deliverables-editor">
      <summary>{t('deliverable.editForm')}</summary>
      <ContractFields fields={contract.outputs} label={t('deliverable.outputLabel')} readOnly={locked} onChange={updateFields} />
      <div className="awwo-output-publish">
        <p>{t('deliverable.republishHint')}</p>
        <button type="button" disabled={locked || !contract.outputs.length} onClick={publishOutput}>
          <ArrowUpFromLine size={14} aria-hidden="true" />{t('deliverable.publish')}
        </button>
      </div>
      {publishErrors.length ? <div className="awwo-contract-errors" role="alert">{publishErrors.join(' ')}</div> : null}
    </details>
  </div>;
}
