import type { UiLocale } from '../locale';
import { api, tenantPath } from '../saas/api';
import { currentSaaSCanvas } from '../saas/canvasBridge';
import { runtimeDefinitions, runtimeModels, type SaaSRuntimeModel, type SaaSRuntimeStatus } from '../saas/runtimeCatalog';
import type { NodeTeamRuntime } from './nodeTeam';

export type ModelProviderGroup = 'codex' | 'claude' | 'grok' | 'gemini' | 'clawhunt';
export interface ModelPaletteSelection {
  key: string;
  label: string;
  providerGroup: ModelProviderGroup;
  runtime: NodeTeamRuntime;
  model: string;
  available: boolean;
  effort?: string;
  reason?: string;
}
export interface ModelPaletteGroup {
  id: ModelProviderGroup;
  label: string;
  models: ModelPaletteSelection[];
  available: boolean;
  reason?: string;
}
export interface ModelPaletteCatalog {
  tenantId: string;
  canvasId: string;
  status: SaaSRuntimeStatus;
  groups: ModelPaletteGroup[];
  /** Includes unavailable entries for honest display; admission must check available. */
  models: ModelPaletteSelection[];
}

const GROUPS: readonly ModelProviderGroup[] = ['codex', 'claude', 'grok', 'gemini', 'clawhunt'];
const LABELS: Record<ModelProviderGroup, string> = { codex: 'Codex / OpenAI', claude: 'Claude', grok: 'Grok', gemini: 'Gemini', clawhunt: 'ClawHunt' };
const text = (locale: UiLocale, zh: string, en: string) => locale === 'zh' ? zh : en;
const clean = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

/** Protocol providers are not model brands: openai can also carry Qwen or other compatible models. */
function providerGroup(model: SaaSRuntimeModel): ModelProviderGroup {
  // Published model names are authoritative; selectors and display labels can be aliases.
  const name = clean(model.name);
  const identity = (name || clean(model.id)).toLowerCase();
  const provider = name ? '' : clean(model.provider).toLowerCase();
  if (/(?:^|[^a-z0-9])codex(?:[^a-z0-9]|$)/.test(identity)) return 'codex';
  if (/(?:^|[^a-z0-9])claude(?:[^a-z0-9]|$)/.test(identity) || provider === 'anthropic') return 'claude';
  if (/(?:^|[^a-z0-9])grok(?:[^a-z0-9]|$)/.test(identity) || ['xai', 'x-ai'].includes(provider)) return 'grok';
  if (/(?:^|[^a-z0-9])gemini(?:[^a-z0-9]|$)/.test(identity) || ['google', 'google-ai', 'google-vertex'].includes(provider)) return 'gemini';
  if (/^(?:openai[/:])?gpt(?:[- ]?\d)/.test(identity)) return 'codex';
  // This group means platform-configured models, not a claim of proprietary model training.
  return 'clawhunt';
}

/** Pure projection of this workspace's published catalogue; never invents selectors or model defaults. */
export function groupModels(status: SaaSRuntimeStatus | null, locale: UiLocale = 'zh'): ModelPaletteGroup[] {
  const unavailable = text(locale, '此工作区尚未配置此品牌的模型。', 'No model from this brand is configured for this workspace.');
  const groups = GROUPS.map(id => ({ id, label: id === 'clawhunt' ? text(locale, 'ClawHunt · 平台模型', 'ClawHunt · Platform models') : LABELS[id],
    models: [] as ModelPaletteSelection[], available: false, reason: status ? unavailable : text(locale, '尚未读取模型目录。', 'The model catalogue has not been loaded.') }));
  if (!status) return groups;
  const seen = new Map<string, string>();
  for (const runtime of runtimeDefinitions(status)) {
    for (const model of runtimeModels(status, runtime.id)) {
      if (model.id !== model.id.trim() || model.id.length > 200) throw new Error(text(locale, '模型目录包含无效标识。', 'The model catalogue contains an invalid selector.'));
      const key = JSON.stringify([runtime.id, model.id]);
      const signature = JSON.stringify([model.name, model.label, model.provider, model.reasoningEfforts, model.defaultReasoningEffort]);
      if (seen.has(key)) {
        if (seen.get(key) !== signature) throw new Error(text(locale, '模型目录包含冲突的重复项，请刷新重试。', 'The model catalogue contains conflicting entries. Refresh and retry.'));
        continue;
      }
      seen.set(key, signature);
      const group = providerGroup(model);
      const available = runtime.available && runtime.configured;
      groups.find(item => item.id === group)!.models.push({ key, label: clean(model.label) || clean(model.name) || model.id,
        providerGroup: group, runtime: runtime.id, model: model.id, available,
        ...(available ? {} : { reason: runtime.reason || text(locale, '此模型的执行服务尚未就绪。', 'This model’s runtime is not ready.') }) });
    }
  }
  return groups.map(group => {
    const available = group.models.some(model => model.available);
    return { ...group, available, reason: available ? undefined : group.models.length
      ? text(locale, '此组模型的执行服务尚未就绪。', 'The runtimes for these models are not ready.') : group.reason };
  });
}

export const buildModelPalette = groupModels;

/** Read once from the current scope; failures never fall back to a previous workspace's catalogue. */
export async function readModelPalette(signal?: AbortSignal, locale: UiLocale = 'zh'): Promise<ModelPaletteCatalog> {
  signal?.throwIfAborted();
  const captured = currentSaaSCanvas();
  if (!captured) throw new Error(text(locale, '请先打开工作区画布。', 'Open a workspace canvas first.'));
  const status = await api<SaaSRuntimeStatus>(tenantPath(captured.tenant.id, '/runtime'), { signal });
  signal?.throwIfAborted();
  if (currentSaaSCanvas() !== captured) throw new Error(text(locale, '工作区或画布已切换，请重新读取模型目录。', 'The workspace or canvas changed. Reload the model catalogue.'));
  if (!status || !Array.isArray(status.models)) throw new Error(text(locale, '模型目录无效，请刷新重试。', 'The model catalogue is invalid. Refresh and retry.'));
  const groups = groupModels(status, locale);
  return { tenantId: captured.tenant.id, canvasId: captured.canvasId, status, groups, models: groups.flatMap(group => group.models) };
}
