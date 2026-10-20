import { useId, useRef, useState } from 'react';
import { Bold, Eye, Heading2, Link2, List, Pencil, Plus, Trash2 } from 'lucide-react';
import { DeliverableMarkdown } from './DeliverableMarkdown';
import { validateContractFields, type ContractField, type ContractFieldType } from './nodeContracts';
import { useCanvasI18n, type CanvasTextKey } from './i18n';
import type { MediaOutputKind } from './mediaOutput';
import { AttachButton, AttachmentTray, useComposerAttachments } from './ComposerAttachments';
import { canvasUploadsAvailable } from '../saas/canvasBridge';

const FIELD_TYPES: Array<{ value: ContractFieldType; label: CanvasTextKey }> = [
  { value: 'text', label: 'contract.text' },
  { value: 'markdown', label: 'contract.markdown' },
  { value: 'html', label: 'contract.html' },
  { value: 'number', label: 'contract.number' },
  { value: 'boolean', label: 'contract.boolean' },
  { value: 'file', label: 'contract.file' },
];
const MEDIA_KINDS: Record<MediaOutputKind, CanvasTextKey> = {
  image: 'media.kindImage', video: 'media.kindVideo', model3d: 'media.kindModel3d', audio: 'media.kindAudio',
};

export interface ContractFieldsProps {
  fields: ContractField[];
  resolvedFields?: ContractField[];
  sources?: Record<string, string>;
  /** Fields whose resolved value is an upstream case recording (nodeConversation.ts). */
  recorded?: Record<string, true>;
  /** Wired fields whose media upstream has made no file, by what it makes (nodeConversation.ts): their resolved value is
   *  the agent's note, so the field shows no value and says so in the page's language. */
  mediaMissing?: Record<string, MediaOutputKind>;
  onChange: (fields: ContractField[]) => void;
  readOnly?: boolean;
  /** Task entry starts with values; contract customization remains available on demand. */
  valuesFirst?: boolean;
  /** With valuesFirst: open with the field structure editable (rename, retype, add, remove). */
  initialEditingSchema?: boolean;
  /** With valuesFirst: offer to edit the field structure at all. The simple view only fills the values in. */
  structureEditable?: boolean;
  label: string;
}

/** The serialized value always remains Markdown; preview never rewrites the source. A wired value is
 * another agent's delivery, so the preview renders it as inert as the delivery itself. */
function MarkdownValue({ field, name, readOnly, onChange, placeholder, describedBy }: {
  field: ContractField;
  name: string;
  readOnly: boolean;
  onChange: (value: string) => void;
  placeholder?: string;
  describedBy?: string;
}) {
  const { locale, t } = useCanvasI18n();
  const [preview, setPreview] = useState(false);
  const editor = useRef<HTMLTextAreaElement>(null);
  const attach = useComposerAttachments({ value: field.value, onChange, disabled: readOnly, keepOnRemove: true });
  const source = attach.body;
  const format = (before: string, after = '') => {
    if (readOnly) return;
    const element = editor.current;
    const start = element?.selectionStart ?? source.length;
    const end = element?.selectionEnd ?? start;
    const selected = source.slice(start, end);
    attach.setBody(source.slice(0, start) + before + selected + after + source.slice(end));
    queueMicrotask(() => {
      element?.focus();
      element?.setSelectionRange(start + before.length, end + before.length);
    });
  };
  return <div className={`awwo-markdown${attach.dragging ? ' is-dropping' : ''}`} {...attach.dropProps}>
    <div className="awwo-markdown-toolbar" role="toolbar" aria-label={t('contract.formatToolbar', { name })}>
      {[
        { label: 'contract.bold' as const, Icon: Bold, before: '**', after: '**' },
        { label: 'contract.heading' as const, Icon: Heading2, before: '## ', after: '' },
        { label: 'contract.list' as const, Icon: List, before: '- ', after: '' },
        { label: 'contract.link' as const, Icon: Link2, before: '[', after: '](https://)' },
      ].map(({ label, Icon, before, after }) => <button key={label} type="button" aria-label={locale === 'zh' ? `${name}${t(label)}` : `${name} ${t(label)}`} title={t(label)}
        disabled={readOnly || preview} onMouseDown={(e) => e.preventDefault()} onClick={() => format(before, after)}>
        <Icon size={15} aria-hidden="true" />
      </button>)}
      <AttachButton state={attach} />
      <button type="button" className="awwo-markdown-preview-toggle" aria-label={locale === 'zh' ? `${t(preview ? 'contract.edit' : 'contract.preview')}${name}` : `${t(preview ? 'contract.edit' : 'contract.preview')} ${name}`}
        aria-pressed={preview} onClick={() => setPreview(!preview)}>
        {preview ? <Pencil size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
        {t(preview ? 'contract.edit' : 'contract.preview')}
      </button>
    </div>
    <AttachmentTray state={attach} disabled={readOnly} />
    {preview ? <div className="awwo-markdown-preview" aria-label={t('contract.previewName', { name })} aria-describedby={describedBy}>
      {source ? <DeliverableMarkdown>{source}</DeliverableMarkdown> : <span className="awwo-field-hint">{t('contract.noContent')}</span>}
    </div> : <textarea ref={editor} className="awwo-field-value" aria-label={t('contract.value', { name })} aria-describedby={describedBy} value={source}
      disabled={readOnly} rows={4} onChange={(event) => attach.setBody(event.target.value)} onPaste={attach.onPaste} placeholder={placeholder ?? t('contract.placeholder')} />}
  </div>;
}

/** A file input: upload files of any type (the "+", a drop or a paste) or enter a path or link. Uploaded files are
 * kept as attachment lines in the value, so a run of this node takes them along (uploads.go). */
function FileFieldValue({ field, name, readOnly, onChange, placeholder, describedBy, rows = 2 }: {
  field: ContractField;
  name: string;
  readOnly: boolean;
  onChange: (value: string) => void;
  placeholder?: string;
  describedBy?: string;
  rows?: number;
}) {
  const { t } = useCanvasI18n();
  const attach = useComposerAttachments({ value: field.value, onChange, disabled: readOnly, keepOnRemove: true });
  return <div className={`awwo-file-field${attach.dragging ? ' is-dropping' : ''}`} {...attach.dropProps}>
    <AttachmentTray state={attach} disabled={readOnly} />
    <div className="awwo-file-field-row">
      <AttachButton state={attach} />
      <textarea className="awwo-field-value" aria-label={t('contract.value', { name })} aria-describedby={describedBy} value={attach.body}
        disabled={readOnly} rows={rows} placeholder={placeholder} onChange={(event) => attach.setBody(event.target.value)} onPaste={attach.onPaste} />
    </div>
  </div>;
}

export function ContractFields({ fields, resolvedFields, sources, recorded, mediaMissing, onChange, readOnly = false, valuesFirst = false, initialEditingSchema = false, structureEditable = true, label }: ContractFieldsProps) {
  const { locale, t } = useCanvasI18n();
  const instanceId = useId();
  const [editingSchema, setEditingSchema] = useState(initialEditingSchema && !readOnly && structureEditable);
  const showSchema = !valuesFirst || editingSchema;
  const nextField = useRef(0);
  // A wired value is checked once it arrives, as a run's preflight does: until then its field says it is waiting for
  // its source, and only what is filled in here can be missing.
  const errors = validateContractFields(resolvedFields ?? fields.filter(field => !sources?.[field.id]), locale);
  const patch = (id: string, update: Partial<ContractField>) => {
    if (!readOnly) onChange(fields.map((field) => field.id === id ? { ...field, ...update } : field));
  };
  const add = () => {
    if (readOnly) return;
    let id: string;
    do { id = `field-${instanceId.replace(/[^a-zA-Z0-9]/g, '')}-${++nextField.current}`; } while (fields.some((field) => field.id === id));
    onChange([...fields, { id, label: t('contract.defaultField', { count: fields.length + 1 }), type: 'text', required: false, value: '' }]);
  };
  return <section className="awwo-contract-fields" aria-label={t('contract.fields', { label })}>
    {valuesFirst && !readOnly && structureEditable && <button type="button" className="awwo-field-structure-toggle" aria-expanded={editingSchema} onClick={() => setEditingSchema(value => !value)}>{locale === 'zh' ? (editingSchema ? '完成结构编辑' : '编辑字段结构') : (editingSchema ? 'Done editing fields' : 'Edit field structure')}</button>}
    {fields.length === 0 ? <div className="awwo-contract-empty">{t('contract.empty', { label })}</div> : null}
    {fields.map((field, index) => {
      const name = field.label || t('contract.defaultField', { count: index + 1 });
      const source = sources?.[field.id];
      const resolved = resolvedFields?.find(item => item.id === field.id);
      const missing = source ? mediaMissing?.[field.id] : undefined;
      const displayed = missing ? { ...field, value: '' } : resolved ?? (source ? { ...field, value: '' } : field);
      // Without its file a field holds the agent's note, so the node goes on without it; a field that refuses the note
      // (an HTML input) is named by the alert, and its hint then promises nothing.
      const mediaNote = source && missing ? t(resolved && validateContractFields([resolved]).length ? 'contract.sourceMediaMissingUnfit' : 'contract.sourceMediaMissing',
        { source, kind: t(MEDIA_KINDS[missing]) }) : '';
      const valueReadOnly = readOnly || Boolean(source);
      const helpId = field.help ? `${instanceId}-field-${index}-help` : undefined;
      // The assistant finds fields by name, so an empty name or one another field already has is said (not refused:
      // the name is edited a keystroke at a time).
      const folded = field.label.trim().toLowerCase();
      const twin = folded ? fields.findIndex((other, at) => at < index && other.label.trim().toLowerCase() === folded) : -1;
      const nameProblem = !showSchema || readOnly ? '' : !folded ? t('contract.nameEmpty') : twin >= 0 ? t('contract.nameRepeated', { count: twin + 1 }) : '';
      const nameProblemId = nameProblem ? `${instanceId}-field-${index}-name-problem` : undefined;
      return <div key={field.id} className="awwo-contract-field">
        {showSchema ? <><div className="awwo-field-header">
          <input className="awwo-field-name" aria-label={t('contract.fieldName', { count: index + 1 })} value={field.label} placeholder={t('contract.fieldNamePlaceholder')}
            disabled={readOnly} aria-invalid={nameProblem ? true : undefined} aria-describedby={nameProblemId}
            onChange={(event) => patch(field.id, { label: event.target.value })} />
          <select aria-label={t('contract.fieldType', { name })} value={field.type} disabled={readOnly}
            onChange={(event) => patch(field.id, { type: event.target.value as ContractFieldType })}>
            {FIELD_TYPES.map((type) => <option key={type.value} value={type.value}>{t(type.label)}</option>)}
          </select>
          <button type="button" className="awwo-field-remove" aria-label={t('contract.removeField', { name })} disabled={readOnly}
            onClick={() => !readOnly && onChange(fields.filter((candidate) => candidate.id !== field.id))}>
            <Trash2 size={15} aria-hidden="true" />
          </button>
        </div>
        {nameProblemId ? <p className="awwo-field-hint awwo-field-name-problem" id={nameProblemId}>{nameProblem}</p> : null}
        <label className="awwo-field-required"><input type="checkbox" aria-label={locale === 'zh' ? `${name}${t('contract.required')}` : `${name} ${t('contract.required')}`} checked={field.required}
          disabled={readOnly} onChange={(event) => patch(field.id, { required: event.target.checked })} />{t('contract.required')}</label></> : <div className="awwo-field-value-label"><strong>{name}</strong>{field.required && <span>{t('contract.required')}</span>}</div>}
        {helpId ? <p className="awwo-field-help" id={helpId}>{field.help}</p> : null}
        {source && <p className="awwo-field-hint">{mediaNote || t(resolvedFields ? (recorded?.[field.id] ? 'contract.sourceCase' : 'contract.sourceResolved') : 'contract.sourceWaiting', { source })}</p>}
        {field.type === 'markdown' ? <MarkdownValue field={displayed} name={name} readOnly={valueReadOnly} placeholder={field.placeholder} describedBy={helpId} onChange={(value) => patch(field.id, { value })} />
          : field.type === 'boolean' ? <select className="awwo-field-value" aria-label={t('contract.value', { name })} aria-describedby={helpId} value={displayed.value} disabled={valueReadOnly}
            onChange={(event) => patch(field.id, { value: event.target.value })}>
            <option value="">{field.placeholder ?? t('contract.choose')}</option><option value="true">{t('contract.yes')}</option><option value="false">{t('contract.no')}</option>
          </select>
          : field.type === 'file' || field.type === 'text' ? <FileFieldValue field={displayed} name={name} readOnly={valueReadOnly} describedBy={helpId}
            rows={field.type === 'text' ? 3 : 2}
            placeholder={field.placeholder ?? t(field.type === 'file' ? 'contract.filePlaceholder' : 'contract.textPlaceholder')} onChange={(value) => patch(field.id, { value })} />
          : <textarea className="awwo-field-value" aria-label={t('contract.value', { name })} aria-describedby={helpId} value={displayed.value} disabled={valueReadOnly}
            inputMode={field.type === 'number' ? 'decimal' : undefined} rows={field.type === 'html' ? 6 : 2}
            spellCheck={field.type === 'html' ? false : undefined}
            placeholder={field.placeholder ?? t(field.type === 'html' ? 'contract.htmlPlaceholder' : field.type === 'number' ? 'contract.numberPlaceholder' : 'contract.textPlaceholder')}
            onChange={(event) => patch(field.id, { value: event.target.value })} />}
        {field.type === 'file' ? <p className="awwo-field-hint">{t(canvasUploadsAvailable() ? 'contract.fileHint' : 'contract.fileHintLocal')}</p> : null}
      </div>;
    })}
    {errors.length > 0 ? <ul className="awwo-contract-errors" role="alert" aria-label={t('contract.validation', { label })}>
      {errors.map((error, index) => <li key={`${index}:${error}`}>{error}</li>)}
    </ul> : null}
    {showSchema && <button type="button" className="awwo-field-add" disabled={readOnly} onClick={add}><Plus size={15} aria-hidden="true" />{t('contract.addField')}</button>}
  </section>;
}
