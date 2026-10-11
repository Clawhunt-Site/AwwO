import { Bot, Boxes, CheckCheck, Code2, Database, DraftingCompass, FileText, Pencil, TerminalSquare } from 'lucide-react';
import { AGENT_TEMPLATES, getAgentTemplates, type AgentTemplate, type AgentTemplateId } from './agentTemplates';
import type { NodeContract } from './nodeContracts';
import { useCanvasI18n } from './i18n';

const ICONS: Record<AgentTemplateId, typeof Bot> = { general: Bot, frontend: Code2, backend: TerminalSquare, data: Database, users: Boxes, materials: FileText, review: CheckCheck, figure: DraftingCompass };

export function AgentGlyph({ title, templateId, size = 18 }: { title?: string; templateId?: AgentTemplateId; size?: number }) {
  const template = [...AGENT_TEMPLATES, ...getAgentTemplates('en')]
    .find(t => t.id === templateId || (!templateId && (t.title === title || (t.id === 'backend' && title === '后端 / 用户系统'))));
  const Icon = template ? ICONS[template.id] : Bot;
  return <Icon size={size} aria-hidden="true" />;
}

/** A template describes intended work; it never claims that work has been performed. Its inputs and deliverables
 *  are the node's own, so where the host lets them change the guide says how and opens the editor for each side. */
export function AgentTemplateDetails({ template, contract, onEditInputs, onEditOutputs }: {
  template: AgentTemplate; contract?: NodeContract; onEditInputs?: () => void; onEditOutputs?: () => void;
}) {
  const { t } = useCanvasI18n();
  const inputs = contract?.inputs ?? template.inputs;
  const outputs = contract?.outputs ?? template.outputs;
  const editable = Boolean(onEditInputs || onEditOutputs);
  return <div className="awwo-template-details" data-template={template.id}>
    <div className="awwo-template-contract">
      <section aria-label={t('template.inputs')}><h4>{t('template.prepare')} <span>{inputs.length}</span>
        {onEditInputs ? <button type="button" className="awwo-template-edit" aria-label={t('template.editInputsLabel')} onClick={onEditInputs}><Pencil size={12} aria-hidden="true" />{t('template.edit')}</button> : null}</h4>
        <div>{inputs.map(field => <span key={field.id} title={field.help}>{field.label}{field.required && <i aria-label={t('common.required')}>*</i>}</span>)}</div>
      </section>
      <section aria-label={t('template.outputs')}><h4>{template.deliverableTitle} <span>{outputs.length}</span>
        {onEditOutputs ? <button type="button" className="awwo-template-edit" aria-label={t('template.editOutputsLabel')} onClick={onEditOutputs}><Pencil size={12} aria-hidden="true" />{t('template.edit')}</button> : null}</h4>
        <div>{outputs.map(field => <span key={field.id} title={field.help}>{field.label}{field.required && <i aria-label={t('common.required')}>*</i>}</span>)}</div>
      </section>
    </div>
    {editable ? <p className="awwo-template-edit-hint">{t('template.editHint')}</p> : null}
    <section className="awwo-template-workflow" aria-label={t('template.workflow')}><h4>{t('template.how')}</h4><ol>
      {template.workflow.map((step, index) => <li key={step}><span>{String(index + 1).padStart(2, '0')}</span><p>{step}</p></li>)}
    </ol></section>
    <details className="awwo-template-checklist"><summary>{t('template.criteria')} <span>{t('template.itemCount', { count: template.checklist.length })}</span></summary><ul>
      {template.checklist.map(item => <li key={item}>{item}</li>)}
    </ul><small>{t('template.evidenceHint')}</small></details>
  </div>;
}
