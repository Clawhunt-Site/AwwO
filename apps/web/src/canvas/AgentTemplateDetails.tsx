import { Bot, Boxes, CheckCheck, Code2, Database, FileText, TerminalSquare } from 'lucide-react';
import { AGENT_TEMPLATES, getAgentTemplates, type AgentTemplate, type AgentTemplateId } from './agentTemplates';
import type { NodeContract } from './nodeContracts';
import { useCanvasI18n } from './i18n';

const ICONS = { general: Bot, frontend: Code2, backend: TerminalSquare, data: Database, users: Boxes, materials: FileText, review: CheckCheck };

export function AgentGlyph({ title, templateId, size = 18 }: { title?: string; templateId?: AgentTemplateId; size?: number }) {
  const template = [...AGENT_TEMPLATES, ...getAgentTemplates('en')]
    .find(t => t.id === templateId || (!templateId && (t.title === title || (t.id === 'backend' && title === '后端 / 用户系统'))));
  const Icon = template ? ICONS[template.id] : Bot;
  return <Icon size={size} aria-hidden="true" />;
}

/** A template describes intended work; it never claims that work has been performed. */
export function AgentTemplateDetails({ template, contract }: { template: AgentTemplate; contract?: NodeContract }) {
  const { t } = useCanvasI18n();
  const inputs = contract?.inputs ?? template.inputs;
  const outputs = contract?.outputs ?? template.outputs;
  return <div className="awwo-template-details" data-template={template.id}>
    <div className="awwo-template-contract">
      <section aria-label={t('template.inputs')}><h4>{t('template.prepare')} <span>{inputs.length}</span></h4>
        <div>{inputs.map(field => <span key={field.id} title={field.help}>{field.label}{field.required && <i aria-label={t('common.required')}>*</i>}</span>)}</div>
      </section>
      <section aria-label={t('template.outputs')}><h4>{template.deliverableTitle} <span>{outputs.length}</span></h4>
        <div>{outputs.map(field => <span key={field.id} title={field.help}>{field.label}{field.required && <i aria-label={t('common.required')}>*</i>}</span>)}</div>
      </section>
    </div>
    <section className="awwo-template-workflow" aria-label={t('template.workflow')}><h4>{t('template.how')}</h4><ol>
      {template.workflow.map((step, index) => <li key={step}><span>{String(index + 1).padStart(2, '0')}</span><p>{step}</p></li>)}
    </ol></section>
    <details className="awwo-template-checklist"><summary>{t('template.criteria')} <span>{t('template.itemCount', { count: template.checklist.length })}</span></summary><ul>
      {template.checklist.map(item => <li key={item}>{item}</li>)}
    </ul><small>{t('template.evidenceHint')}</small></details>
  </div>;
}
