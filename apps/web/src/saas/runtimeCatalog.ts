import { NODE_TEAM_RUNTIMES, NODE_TEAM_TOOLS, nodeTeamRuntimeLabel, type NodeTeamRuntime, type NodeTeamTool } from '../canvas/nodeTeam';

export type SaaSRuntimeModel = { id: string; runtime?: string; name?: string; label?: string; provider?: string };
export type SaaSRuntimeDefinition = {
  id: NodeTeamRuntime; name: string; available: boolean; configured: boolean;
  supportsEffortSelection: false; tools: NodeTeamTool[]; reason?: string;
};
export type SaaSRuntimeStatus = {
  engine?: string; available: boolean; configured: boolean; reason?: string; plannerAvailable?: boolean;
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
      supportsEffortSelection: false, reason: runtime.reason,
      tools: runtime.id === 'openai-agents' ? [...new Set(runtime.tools.filter(tool => NODE_TEAM_TOOLS.includes(tool)))] : [] };
  });
}
