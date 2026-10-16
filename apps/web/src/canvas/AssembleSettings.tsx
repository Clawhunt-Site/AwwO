import type { AssembleNode } from './canvasDoc';
import type { ContractField, ContractFieldType } from './nodeContracts';
import { ASSEMBLE_DEFAULT_FILE, templateIssues } from './assembleNode';
import { useCanvasI18n } from './i18n';
import './assemble-node.css';

/** A slot id as the API accepts it (graph_assemble.go assembleSlot). */
const SLOT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const TEXT_TYPES: ReadonlyArray<ContractFieldType> = ['html', 'markdown', 'text'];

/** An assemble node's settings: its template, the inputs its slots read, and what it delivers. */
export function AssembleSettings({ draft, busy, onChange }: { draft: AssembleNode; busy: boolean; onChange: (next: AssembleNode) => void }) {
  const { t } = useCanvasI18n();
  const { inputs, outputs } = draft.contract;
  const text = outputs.find(field => field.type !== 'file');
  const file = outputs.find(field => field.type === 'file');
  const setContract = (patch: Partial<AssembleNode['contract']>) => onChange({ ...draft, contract: { ...draft.contract, ...patch } });
  const setInput = (index: number, patch: Partial<ContractField>) => setContract({ inputs: inputs.map((field, i) => i === index ? { ...field, ...patch } : field) });
  const nextSlotId = () => {
    for (let n = inputs.length + 1; ; n += 1) if (!inputs.some(field => field.id === `slot${n}`)) return `slot${n}`;
  };
  const issues = [
    ...templateIssues(draft.template, inputs.map(field => field.id)),
    ...inputs.filter(field => !SLOT_ID.test(field.id)).map(field => `“${field.id}”: A-Z a-z 0-9 _ -`),
    ...inputs.filter((field, i) => inputs.findIndex(other => other.id === field.id) !== i).map(field => `“${field.id}” ×2`),
  ];
  const textLabel = { html: t('assemble.outputHtml'), markdown: t('assemble.outputMarkdown'), text: t('assemble.outputText') };
  return <div className="awwo-assemble-settings">
    <label className="canvas-inspector-label" htmlFor={`assemble-template-${draft.id}`}>{t('assemble.template')}</label>
    <textarea id={`assemble-template-${draft.id}`} className="canvas-inspector-input awwo-assemble-template" spellCheck={false} rows={14}
      value={draft.template} disabled={busy} onChange={event => onChange({ ...draft, template: event.target.value })} />
    <p className="awwo-field-hint">{t('assemble.templateHint')}</p>

    <div className="canvas-inspector-label">{t('assemble.inputs')}</div>
    {inputs.map((field, index) => <div key={index} className="canvas-inspector-field-row awwo-assemble-input-row">
      <input className="canvas-inspector-input awwo-assemble-input-id" aria-label={t('assemble.inputId')} placeholder={t('assemble.inputId')}
        value={field.id} disabled={busy} onChange={event => setInput(index, { id: event.target.value.trim() })} />
      <input className="canvas-inspector-input" aria-label={t('assemble.inputLabel')} placeholder={t('assemble.inputLabel')}
        value={field.label} disabled={busy} onChange={event => setInput(index, { label: event.target.value })} />
      <label className="awwo-assemble-required"><input type="checkbox" checked={field.required} disabled={busy}
        onChange={event => setInput(index, { required: event.target.checked })} />{t('assemble.required')}</label>
      <button type="button" className="canvas-inspector-field-remove" aria-label={t('assemble.remove', { name: field.label || field.id })} disabled={busy}
        onClick={() => setContract({ inputs: inputs.filter((_, i) => i !== index) })}>✕</button>
    </div>)}
    <button type="button" className="canvas-inspector-add-field" disabled={busy}
      onClick={() => setContract({ inputs: [...inputs, { id: nextSlotId(), label: '', type: 'text', required: true, value: '' }] })}>＋ {t('assemble.addInput')}</button>

    <label className="canvas-inspector-label" htmlFor={`assemble-output-${draft.id}`}>{t('assemble.output')}</label>
    <select id={`assemble-output-${draft.id}`} className="canvas-inspector-input" disabled={busy} value={text?.type ?? 'html'}
      onChange={event => {
        const type = event.target.value as ContractFieldType;
        const label = textLabel[type as 'html' | 'markdown' | 'text'];
        setContract({ outputs: [{ id: text?.id ?? 'result', label: text && text.label !== textLabel[text.type as 'html'] ? text.label : label, type, required: true, value: '' }, ...(file ? [file] : [])] });
      }}>
      {TEXT_TYPES.map(type => <option key={type} value={type}>{textLabel[type as 'html' | 'markdown' | 'text']}</option>)}
    </select>
    <label className="awwo-assemble-also-file"><input type="checkbox" checked={Boolean(file)} disabled={busy} onChange={event => setContract({
      outputs: event.target.checked
        ? [...outputs, { id: 'file', label: t('assemble.fileName'), type: 'file', required: true, value: '' }]
        : outputs.filter(field => field.type !== 'file'),
    })} />{t('assemble.alsoFile')}</label>
    {file ? <>
      <label className="canvas-inspector-label" htmlFor={`assemble-file-${draft.id}`}>{t('assemble.fileName')}</label>
      <input id={`assemble-file-${draft.id}`} className="canvas-inspector-input" disabled={busy} placeholder={ASSEMBLE_DEFAULT_FILE}
        value={draft.fileName ?? ''} onChange={event => onChange({ ...draft, fileName: event.target.value || undefined })} />
    </> : null}
    {issues.length ? <p className="awwo-contract-errors" role="alert">{t('assemble.issues', { issues: issues.join(' ') })}</p> : null}
  </div>;
}
