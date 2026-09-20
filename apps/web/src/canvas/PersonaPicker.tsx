import { useId } from 'react';
import { getAgentTemplates } from './agentTemplates';
import { useCanvasI18n } from './i18n';
import './persona-picker.css';

export interface PersonaPickerProps {
  persona: string;
  disabled?: boolean;
  onChange: (persona: string) => void;
}

/** Applies instructions only; node models, references and port contracts are host-owned. */
export function PersonaPicker({ persona, disabled = false, onChange }: PersonaPickerProps) {
  const { locale } = useCanvasI18n();
  const id = useId();
  const templates = getAgentTemplates(locale);
  const selected = [...templates, ...getAgentTemplates(locale === 'en' ? 'zh' : 'en')]
    .find(template => template.persona === persona)?.id || '';
  return <div className="canvas-persona-picker">
    <label className="canvas-inspector-label" htmlFor={id}>{locale === 'en' ? 'Persona preset' : '人设预设'}</label>
    <select id={id} className="canvas-inspector-input" value={selected} disabled={disabled}
      aria-describedby={`${id}-hint`} onChange={event => {
        if (disabled) return;
        const template = templates.find(item => item.id === event.target.value);
        if (template) onChange(template.persona);
      }}>
      <option value="" disabled>{locale === 'en' ? 'Custom instructions' : '自定义指令'}</option>
      {templates.map(template => <option key={template.id} value={template.id}>{template.title}</option>)}
    </select>
    <p id={`${id}-hint`} className="canvas-inspector-hint">{locale === 'en' ? 'Updates only the instructions below.' : '只更新下方人设指令。'}</p>
  </div>;
}
