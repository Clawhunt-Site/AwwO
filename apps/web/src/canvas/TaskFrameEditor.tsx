import { useCanvasI18n } from './i18n';
import { isTaskFrame, taskFrameError, TASK_FRAME_MAX_ENTRIES, type TaskFrame } from './taskFrame';
import './task-frame.css';

export function TaskFrameEditor({ value, disabled, onChange }: { value: unknown; disabled: boolean; onChange: (frame: TaskFrame) => void }) {
  const { locale } = useCanvasI18n();
  const text = (zh: string, en: string) => locale === 'zh' ? zh : en;
  const error = taskFrameError(value);
  const frame = isTaskFrame(value) ? value : { version: 1 as const, source: 'manual' as const, constraints: [], acceptanceCriteria: [] };
  const messages = {
    unsupported: text('此任务要求版本暂不支持编辑，原始内容已保留。请使用兼容版本后再保存。', 'This task requirement version cannot be edited here. The original data is preserved; use a compatible version to save.'),
    entries: text('约束和验收标准各最多 20 条。', 'Use up to 20 constraints and 20 acceptance criteria.'),
    entryLength: text('每条最多 2000 个字符，请缩短后保存。', 'Each entry allows up to 2,000 characters. Shorten it before saving.'),
    totalLength: text('任务要求总计最多 12000 个字符，请缩短后保存。', 'Task requirements allow up to 12,000 characters in total. Shorten them before saving.'),
  };
  return <section className="canvas-task-frame" aria-label={text('任务要求', 'Task requirements')}>
    <h3>{text('任务要求', 'Task requirements')}</h3>
    <p className="canvas-inspector-hint">{text('由你填写，运行时随任务传递。验收标准仍需人工核对。', 'Your requirements accompany the task. Acceptance criteria still need human review.')}</p>
    {error && <p className="canvas-task-frame-error" role="alert">{messages[error]}</p>}
    {error !== 'unsupported' && (['constraints', 'acceptanceCriteria'] as const).map(field => {
      const label = field === 'constraints' ? text('约束', 'Constraint') : text('验收标准', 'Acceptance criterion');
      const add = field === 'constraints' ? text('添加约束', 'Add constraint') : text('添加验收标准', 'Add acceptance criterion');
      return <fieldset key={field} disabled={disabled}>
        <legend>{field === 'constraints' ? text('约束', 'Constraints') : text('验收标准', 'Acceptance criteria')}</legend>
        {frame[field].map((entry, index) => <div className="canvas-task-frame-entry" key={index}>
          <label><span>{label} {index + 1}</span><textarea className="canvas-inspector-persona" rows={2}
            aria-label={`${label} ${index + 1}`} value={entry}
            onChange={event => { if (!disabled) onChange({ ...frame, [field]: frame[field].map((item, i) => i === index ? event.target.value : item) }); }} /></label>
          <button type="button" className="canvas-inspector-link" aria-label={`${text('移除', 'Remove ')}${label} ${index + 1}`}
            onClick={() => { if (!disabled) onChange({ ...frame, [field]: frame[field].filter((_, i) => i !== index) }); }}>{text('移除', 'Remove')}</button>
        </div>)}
        <button type="button" className="canvas-inspector-add-field" disabled={disabled || frame[field].length >= TASK_FRAME_MAX_ENTRIES}
          onClick={() => { if (!disabled) onChange({ ...frame, [field]: [...frame[field], ''] }); }}>{add}</button>
      </fieldset>;
    })}
  </section>;
}
