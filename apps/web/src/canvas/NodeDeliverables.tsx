import { useState, type ReactNode } from 'react';
import { ArrowUpFromLine } from 'lucide-react';
import ReactMarkdown, { defaultUrlTransform, type Components, type UrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { SessionNode } from './canvasDoc';
import { ContractFields } from './ContractFields';
import { emptyContract, parseContractOutput, validateContractFields, type ContractField } from './nodeContracts';
import { activeNodeThread } from './nodeThreads';
import { getAgentTemplateForNode } from './agentTemplates';
import { useCanvasI18n } from './i18n';

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
      : <a {...props} href={href}>{children}</a>;
  },
};

function DeliverableMarkdown({ children }: { children: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={deliveryUrlTransform} components={deliveryMarkdownComponents}>{children}</ReactMarkdown>;
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
  const deliverableTitle = getAgentTemplateForNode(node, locale)?.deliverableTitle;
  const contract = node.contract ?? emptyContract();
  const output = node.lastOutput ?? activeNodeThread(node).lastOutput;
  // Looking at an earlier Session must not publish its historical result downstream.
  const historical = !node.lastOutput && Boolean(output);
  const locked = readOnly || !onUpdateNode;
  const parsed = output ? parseContractOutput(contract, output.text) : null;
  const publishedFields = parsed ? contract.outputs.filter(field => Object.hasOwn(parsed.values, field.id)) : [];
  // A malformed or legacy result remains visible as evidence, without manufacturing fields.
  const showRawOutput = output && (!contract.outputs.length || Boolean(parsed?.errors.length) || !publishedFields.length);

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

  return <div className="awwo-deliverables">
    {deliverableTitle ? <h3 className="awwo-deliverables-title">{deliverableTitle}</h3> : null}
    {!output ? <>
      <p className="awwo-deliverables-empty">{t('deliverable.empty', { title: deliverableTitle || t('deliverable.defaultTitle') })}</p>
      {contract.outputs.length ? <ul className="awwo-expected-deliverables" aria-label={t('deliverable.expected')}>
        {contract.outputs.map(field => <li key={field.id}><span>{field.label || field.id}</span><span>{t('deliverable.pending')}</span></li>)}
      </ul> : null}
    </> : <>
      {(historical || output.partial || output.source === 'manual') && <div className="awwo-deliverables-meta">
        {historical && <span>{t('deliverable.historical')}</span>}
        {output.partial && <span>{t('deliverable.partial')}</span>}
        {output.source === 'manual' && <span>{t('deliverable.manual')}</span>}
      </div>}
      {parsed?.errors.length ? <p className="awwo-contract-errors" role="alert" title={parsed.errors.join(' ')}>{t('deliverable.invalid')}</p> : null}
      {showRawOutput ? <article className="awwo-deliverable" data-testid={`canvas-tile-output-${node.id}`}>
        <h3 className="awwo-deliverable-title">{t(parsed?.errors.length ? 'deliverable.raw' : 'deliverable.runOutput')}</h3>
        <div className="awwo-deliverable-body awwo-markdown-preview">
          <DeliverableMarkdown>{output.text}</DeliverableMarkdown>
        </div>
      </article> : <div data-testid={`canvas-tile-output-${node.id}`}>
        {publishedFields.map(field => {
          const value = parsed!.values[field.id];
          const filePath = field.type === 'file' ? localFilePath(value, true) : null;
          return <article className="awwo-deliverable" key={field.id}>
          <h3 className="awwo-deliverable-title">{field.label || field.id}</h3>
          <div className={`awwo-deliverable-body${field.type === 'markdown' ? ' awwo-markdown-preview' : ''}`}>
            {field.type === 'markdown'
              ? <DeliverableMarkdown>{value}</DeliverableMarkdown>
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
