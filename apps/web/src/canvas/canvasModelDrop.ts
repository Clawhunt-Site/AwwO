import { createAgentTemplate, getAgentTemplates, type AgentTemplateId } from './agentTemplates';
import type { ModelPaletteSelection } from './modelPalette';
import type { SessionNode } from './canvasDoc';
import type { UiLocale } from '../locale';

export const MODEL_DRAG_MIME = 'application/x-awwo-model';

export function modelDragPayload(scope: string, model: ModelPaletteSelection, personaId: AgentTemplateId | null): string {
  return JSON.stringify({ version: 1, scope, key: model.key, personaId });
}

/** The drag transports an identity only. Runtime, model and permission come from the live catalogue. */
export function resolveModelDrop(raw: string, scope: string, models: readonly ModelPaletteSelection[]):
  { model: ModelPaletteSelection; personaId: AgentTemplateId | null } | null {
  if (!raw || raw.length > 4096) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const item = value as Record<string, unknown>;
    if (Object.keys(item).some(key => !['version', 'scope', 'key', 'personaId'].includes(key))
      || item.version !== 1 || !scope || item.scope !== scope || typeof item.key !== 'string') return null;
    if (item.personaId !== null && !getAgentTemplates('en').some(template => template.id === item.personaId)) return null;
    const model = models.find(candidate => candidate.key === item.key && candidate.available);
    return model ? { model, personaId: item.personaId as AgentTemplateId | null } : null;
  } catch { return null; }
}

/** A model creates a neutral task contract; choosing a persona never imports unrelated required fields. */
export function createModelNode(model: ModelPaletteSelection, personaId: AgentTemplateId | null,
  world: { x: number; y: number }, locale: UiLocale): SessionNode {
  if (!model.available || !model.model || !['pi', 'openai-agents'].includes(model.runtime)) {
    throw new Error(locale === 'zh' ? '这个模型尚未配置，无法添加。' : 'This model is not configured.');
  }
  const node = createAgentTemplate('general', world, locale);
  const persona = personaId ? getAgentTemplates(locale).find(template => template.id === personaId) : undefined;
  if (personaId && !persona) throw new Error('Unknown persona');
  return { ...node, title: persona ? `${model.label} · ${persona.title}` : model.label,
    contract: { ...node.contract!, outputs: node.contract!.outputs.filter(field => field.id === 'result') },
    runtime: model.runtime, model: model.model, effort: '', persona: persona?.persona ?? node.persona };
}
