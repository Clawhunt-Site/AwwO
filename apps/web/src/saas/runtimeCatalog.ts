import { NODE_TEAM_RUNTIMES, NODE_TEAM_TOOLS, nodeTeamRuntimeLabel, type NodeTeamRuntime, type NodeTeamTool } from '../canvas/nodeTeam';

export type SaaSRuntimeModel = {
  id: string; runtime?: string; name?: string; label?: string; provider?: string;
  /** Closed set of reasoning-effort levels this model advertises; empty means none is selectable. */
  reasoningEfforts?: string[]; defaultReasoningEffort?: string;
};
export type SaaSRuntimeDefinition = {
  id: NodeTeamRuntime; name: string; available: boolean; configured: boolean;
  /** True when at least one model of this runtime advertises effort levels. Per-model levels still rule. */
  supportsEffortSelection: boolean; tools: NodeTeamTool[]; reason?: string;
};

const EFFORT_LEVEL = /^[a-z][a-z0-9_-]{0,31}$/;

/** The picker's per-model effort contract. Malformed advertisements degrade to "no effort" rather than
 * to free text: a level the server would refuse must never be offered. */
export function modelEffortCapability(model: SaaSRuntimeModel): { effort_levels: string[]; default_effort: string } {
  const levels = Array.isArray(model.reasoningEfforts) ? model.reasoningEfforts.filter((level): level is string => typeof level === 'string' && EFFORT_LEVEL.test(level)) : [];
  const unique = [...new Set(levels)];
  const fallback = typeof model.defaultReasoningEffort === 'string' && unique.includes(model.defaultReasoningEffort) ? model.defaultReasoningEffort : '';
  return { effort_levels: unique, default_effort: fallback };
}
export type SaaSRuntimeStatus = {
  engine?: string; available: boolean; configured: boolean; reason?: string; plannerAvailable?: boolean; plannerRuntime?: string;
  models: SaaSRuntimeModel[]; runtimes?: SaaSRuntimeDefinition[];
};

/** Keep catalogs scoped to their advertised runtime. Missing runtime belongs only to legacy Pi. */
export function runtimeModels(status: SaaSRuntimeStatus, runtime: NodeTeamRuntime): SaaSRuntimeModel[] {
  if (!Array.isArray(status.models)) throw new Error('Invalid runtime model catalog.');
  return status.models.filter(model => model && typeof model.id === 'string' && model.id.trim()
    && (model.runtime === runtime || (runtime === 'pi' && model.runtime === undefined)));
}

export function runtimeDefinitions(status: SaaSRuntimeStatus): SaaSRuntimeDefinition[] {
  if (status.runtimes === undefined) return [{ id: 'pi', name: 'Pi', available: status.available === true,
    configured: status.configured === true, supportsEffortSelection: false, tools: [], reason: status.reason }];
  if (!Array.isArray(status.runtimes)) throw new Error('Invalid runtime inventory.');
  const seen = new Set<string>();
  return status.runtimes.filter(runtime => NODE_TEAM_RUNTIMES.includes(runtime?.id)).map(runtime => {
    if (seen.has(runtime.id) || !Array.isArray(runtime.tools)) throw new Error('Invalid runtime inventory.');
    seen.add(runtime.id);
    return { id: runtime.id, name: runtime.name || nodeTeamRuntimeLabel(runtime.id),
      available: runtime.available === true, configured: runtime.configured === true,
      // Trust the flag only when a model of this runtime really advertises levels, so a stale or
      // over-eager flag cannot surface an effort control that every model would refuse.
      supportsEffortSelection: runtime.supportsEffortSelection === true && runtimeModels(status, runtime.id).some(model => modelEffortCapability(model).effort_levels.length > 0),
      reason: runtime.reason,
      tools: runtime.id === 'openai-agents' ? [...new Set(runtime.tools.filter(tool => NODE_TEAM_TOOLS.includes(tool)))] : [] };
  });
}
