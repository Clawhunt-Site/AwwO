import { useId, useRef, useState } from 'react';
import { Bold, Eye, Heading2, Link2, List, Pencil, Plus, Trash2 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { validateContractFields, type ContractField, type ContractFieldType } from './nodeContracts';

const FIELD_TYPES: Array<{ value: ContractFieldType; label: string }> = [
  { value: 'text', label: '文本' },
  { value: 'markdown', label: '富文本' },
  { value: 'number', label: '数字' },
  { value: 'boolean', label: '布尔值' },
  { value: 'file', label: '文件引用' },
];

export interface ContractFieldsProps {
  fields: ContractField[];
  resolvedFields?: ContractField[];
  sources?: Record<string, string>;
  onChange: (fields: ContractField[]) => void;
  readOnly?: boolean;
  label: string;
}

/** The serialized value always remains Markdown; preview never rewrites the source. */
function MarkdownValue({ field, name, readOnly, onChange, placeholder, describedBy }: {
  field: ContractField;
  name: string;
  readOnly: boolean;
  onChange: (value: string) => void;
  placeholder?: string;
  describedBy?: string;
}) {
  const [preview, setPreview] = useState(false);
  const editor = useRef<HTMLTextAreaElement>(null);
  const format = (before: string, after = '') => {
    if (readOnly) return;
    const element = editor.current;
    const start = element?.selectionStart ?? field.value.length;
    const end = element?.selectionEnd ?? start;
    const selected = field.value.slice(start, end);
    onChange(field.value.slice(0, start) + before + selected + after + field.value.slice(end));
    queueMicrotask(() => {
      element?.focus();
      element?.setSelectionRange(start + before.length, end + before.length);
    });
  };
  return <div className="awwo-markdown">
    <div className="awwo-markdown-toolbar" role="toolbar" aria-label={`${name}富文本格式`}>
      {[
        { label: '加粗', Icon: Bold, before: '**', after: '**' },
        { label: '标题', Icon: Heading2, before: '## ', after: '' },
        { label: '列表', Icon: List, before: '- ', after: '' },
        { label: '插入链接', Icon: Link2, before: '[', after: '](https://)' },
      ].map(({ label, Icon, before, after }) => <button key={label} type="button" aria-label={`${name}${label}`} title={label}
        disabled={readOnly || preview} onMouseDown={(e) => e.preventDefault()} onClick={() => format(before, after)}>
        <Icon size={15} aria-hidden="true" />
      </button>)}
      <button type="button" className="awwo-markdown-preview-toggle" aria-label={`${preview ? '编辑' : '预览'}${name}`}
        aria-pressed={preview} onClick={() => setPreview(!preview)}>
        {preview ? <Pencil size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
        {preview ? '编辑' : '预览'}
      </button>
    </div>
    {preview ? <div className="awwo-markdown-preview" aria-label={`${name}预览`} aria-describedby={describedBy}>
      {field.value ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{field.value}</ReactMarkdown> : <span className="awwo-field-hint">还没有内容</span>}
    </div> : <textarea ref={editor} className="awwo-field-value" aria-label={`${name}的值`} aria-describedby={describedBy} value={field.value}
      disabled={readOnly} rows={4} onChange={(event) => onChange(event.target.value)} placeholder={placeholder ?? '写下内容，支持 Markdown…'} />}
  </div>;
}

export function ContractFields({ fields, resolvedFields, sources, onChange, readOnly = false, label }: ContractFieldsProps) {
  const instanceId = useId();
  const nextField = useRef(0);
  const errors = validateContractFields(resolvedFields ?? fields);
  const patch = (id: string, update: Partial<ContractField>) => {
    if (!readOnly) onChange(fields.map((field) => field.id === id ? { ...field, ...update } : field));
  };
  const add = () => {
    if (readOnly) return;
    let id: string;
    do { id = `field-${instanceId.replace(/[^a-zA-Z0-9]/g, '')}-${++nextField.current}`; } while (fields.some((field) => field.id === id));
    onChange([...fields, { id, label: `字段 ${fields.length + 1}`, type: 'text', required: false, value: '' }]);
  };
  return <section className="awwo-contract-fields" aria-label={`${label}字段`}>
    {fields.length === 0 ? <div className="awwo-contract-empty">定义{label}字段，让每次交接都有清晰的内容。</div> : null}
    {fields.map((field, index) => {
      const name = field.label || `字段 ${index + 1}`;
      const source = sources?.[field.id];
      const displayed = resolvedFields?.find(item => item.id === field.id) ?? (source ? { ...field, value: '' } : field);
      const valueReadOnly = readOnly || Boolean(source);
      const helpId = field.help ? `${instanceId}-field-${index}-help` : undefined;
      return <div key={field.id} className="awwo-contract-field">
        <div className="awwo-field-header">
          <input className="awwo-field-name" aria-label={`字段 ${index + 1} 名称`} value={field.label} placeholder="字段名称"
            disabled={readOnly} onChange={(event) => patch(field.id, { label: event.target.value })} />
          <select aria-label={`${name}的类型`} value={field.type} disabled={readOnly}
            onChange={(event) => patch(field.id, { type: event.target.value as ContractFieldType })}>
            {FIELD_TYPES.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
          </select>
          <button type="button" className="awwo-field-remove" aria-label={`删除${name}`} disabled={readOnly}
            onClick={() => !readOnly && onChange(fields.filter((candidate) => candidate.id !== field.id))}>
            <Trash2 size={15} aria-hidden="true" />
          </button>
        </div>
        <label className="awwo-field-required"><input type="checkbox" aria-label={`${name}必填`} checked={field.required}
          disabled={readOnly} onChange={(event) => patch(field.id, { required: event.target.checked })} />必填</label>
        {helpId ? <p className="awwo-field-help" id={helpId}>{field.help}</p> : null}
        {source && <p className="awwo-field-hint">{resolvedFields ? `来自「${source}」的已发布输出` : `等待「${source}」的可用输出`}；断开连线后可手动填写。</p>}
        {field.type === 'markdown' ? <MarkdownValue field={displayed} name={name} readOnly={valueReadOnly} placeholder={field.placeholder} describedBy={helpId} onChange={(value) => patch(field.id, { value })} />
          : field.type === 'boolean' ? <select className="awwo-field-value" aria-label={`${name}的值`} aria-describedby={helpId} value={displayed.value} disabled={valueReadOnly}
            onChange={(event) => patch(field.id, { value: event.target.value })}>
            <option value="">{field.placeholder ?? '请选择'}</option><option value="true">是 / true</option><option value="false">否 / false</option>
          </select>
          : <textarea className="awwo-field-value" aria-label={`${name}的值`} aria-describedby={helpId} value={displayed.value} disabled={valueReadOnly}
            inputMode={field.type === 'number' ? 'decimal' : undefined} rows={field.type === 'text' ? 3 : 2}
            placeholder={field.placeholder ?? (field.type === 'file' ? '文件路径或 https:// 链接' : field.type === 'number' ? '输入数字' : '输入内容…')}
            onChange={(event) => patch(field.id, { value: event.target.value })} />}
        {field.type === 'file' ? <p className="awwo-field-hint">填写文件路径或链接；不会上传文件。</p> : null}
      </div>;
    })}
    {errors.length > 0 ? <ul className="awwo-contract-errors" role="alert" aria-label={`${label}校验`}>
      {errors.map((error, index) => <li key={`${index}:${error}`}>{error}</li>)}
    </ul> : null}
    <button type="button" className="awwo-field-add" disabled={readOnly} onClick={add}><Plus size={15} aria-hidden="true" />添加字段</button>
  </section>;
}
