import { canvasFetch } from './saas/canvasBridge';
import { paperclipApiBase } from './paperclipBridge';
import { modelLabels } from './modelLabels';

/** Adapt the live Node registry to RuntimePicker's existing inventory contract.
 * Registered adapters are not a claim that their CLI is logged in or executable.
 * Codex uses the gateway's host CLI catalog; other adapters retain their registry contract.
 */
export function createCanvasRuntimeReader(base = paperclipApiBase(), fetchImpl: typeof fetch = canvasFetch) {
  const apiBase = base.replace(/\/+$/, '');
  async function get(path: string, signal?: AbortSignal | null, requestBase = apiBase, timeoutMs = 10_000): Promise<unknown> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const response = await fetchImpl(`${requestBase}${path}`, {
      credentials: 'include', headers: { accept: 'application/json' },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) throw new Error(`Runtime registry request failed (${response.status}).`);
    return response.json();
  }

  async function codexModels(signal?: AbortSignal | null) {
    const data = await get('/canvas/runtimes/codex_local/models', signal, '/gateway-api', 35_000) as {
      source?: unknown; models?: { id?: unknown; reasoningEfforts?: unknown; defaultReasoningEffort?: unknown }[];
    };
    if (data?.source !== 'codex_app_server' || !Array.isArray(data.models) || !data.models.length || data.models.length > 500) throw new Error('Codex model catalog unavailable.');
    const capabilities = data.models.map(item => {
      if (!item || typeof item.id !== 'string' || !item.id.trim() || !Array.isArray(item.reasoningEfforts)
        || item.reasoningEfforts.some(level => typeof level !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(level))
        || typeof item.defaultReasoningEffort !== 'string'
        || (item.reasoningEfforts.length ? !item.reasoningEfforts.includes(item.defaultReasoningEffort) : item.defaultReasoningEffort !== '')) throw new Error('Codex model catalog unavailable.');
      return [item.id, { effort_levels: item.reasoningEfforts as string[], default_effort: item.defaultReasoningEffort }] as const;
    });
    const ids = capabilities.map(([id]) => id);
    if (new Set(ids).size !== ids.length) throw new Error('Codex model catalog unavailable.');
    return { models: ids, source: 'codex_app_server', model_capabilities: Object.fromEntries(capabilities) };
  }

  async function modelCatalog(type: string, signal?: AbortSignal | null, selectedCompany?: string): Promise<{ models: string[]; source?: string; model_labels?: Record<string, string>; model_capabilities?: Record<string, { effort_levels: string[]; default_effort: string }> }> {
    let companyId = selectedCompany;
    if (!companyId) {
      const companies = await get('/companies', signal);
      if (!Array.isArray(companies)) throw new Error('Invalid workspace registry response.');
      companyId = companies.find(item => typeof item?.id === 'string' && item.status !== 'archived')?.id;
    }
    if (!companyId) return { models: [] };
    const data = await get(`/companies/${encodeURIComponent(companyId)}/adapters/${encodeURIComponent(type)}/models`, signal) as any;
    const saas = data?.source === 'saas_runtime';
    const models = saas ? data.models : data;
    if (!Array.isArray(models)) throw new Error('Invalid model registry response.');
    const ids = [...new Set<string>(models.map(item => typeof item === 'string' ? item : item?.id)
      .filter((id): id is string => typeof id === 'string' && Boolean(id.trim())))];
    if (!saas) return { models: ids };
    // Effort levels are part of the model, never of the runtime: a level is offered only for the
    // model that advertised it, and a malformed advertisement yields no selectable level at all.
    const capabilities: Record<string, { effort_levels: string[]; default_effort: string }> = {};
    for (const item of models) {
      if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !ids.includes(item.id)) continue;
      const levels: string[] = Array.isArray(item.effort_levels) ? [...new Set<string>(item.effort_levels.filter((level: unknown): level is string => typeof level === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(level)))] : [];
      capabilities[item.id] = { effort_levels: levels, default_effort: typeof item.default_effort === 'string' && levels.includes(item.default_effort) ? item.default_effort : '' };
    }
    const labels = modelLabels(Object.fromEntries(models.filter(item => item && typeof item === 'object' && ids.includes(item.id)).map(item => [item.id, item.label])));
    return { models: ids, source: 'saas_runtime', model_capabilities: capabilities, ...(Object.keys(labels).length ? { model_labels: labels } : {}) };
  }

  return async function readCanvasRuntime(path: string, init?: RequestInit): Promise<any> {
    if (init?.method && init.method.toUpperCase() !== 'GET') throw new Error('Runtime inventory is read-only.');
    if (path === '/api/agents') {
      const data = await get('/adapters', init?.signal);
      if (!Array.isArray(data)) throw new Error('Invalid runtime registry response.');
      const adapters = data.filter(item => item && typeof item.type === 'string'
        && item.loaded === true && item.disabled !== true);
      // A zero static count does not mean model selection is unsupported: dynamic adapters
      // (for example pi_local) populate their catalog through the company model endpoint.
      let companyId: string | undefined;
      if (adapters.some(item => item.type !== 'codex_local' && !item.supportsModelSelection && !(item.modelsCount > 0))) {
        const companies = await get('/companies', init?.signal);
        if (!Array.isArray(companies)) throw new Error('Invalid workspace registry response.');
        companyId = companies.find(item => typeof item?.id === 'string' && item.status !== 'archived')?.id;
      }
      return { agents: await Promise.all(adapters.map(async item => item.type === 'codex_local' ? {
        name: item.type, supports_model_selection: true, supports_effort_selection: true, model_catalog_source: 'codex_app_server',
      } : ({
        name: item.type,
        supports_model_selection: item.supportsModelSelection === true || item.modelsCount > 0 || Boolean(companyId && (await modelCatalog(item.type, init?.signal, companyId)).models.length),
        // Only a SaaS runtime can advertise effort here, and it does so per model: the levels
        // arrive with the model catalog, so the picker treats them as a closed, model-scoped enum.
        supports_effort_selection: item.modelCatalogSource === 'saas_runtime' && item.supportsEffortSelection === true,
        ...(item.supportsNodeTeams === true ? { supports_node_teams: true } : {}),
        ...(item.modelCatalogSource === 'saas_runtime' ? { model_catalog_source: 'saas_runtime', tools: Array.isArray(item.tools) ? item.tools : [] } : {}),
      }))) };
    }
    const models = /^\/api\/agents\/([^/]+)\/models$/.exec(path);
    if (!models) throw new Error('Unsupported runtime inventory request.');
    // Discovery never changes the workspace selected for binding or member administration.
    const type = decodeURIComponent(models[1]);
    if (type === 'codex_local') return codexModels(init?.signal);
    return modelCatalog(type, init?.signal);
  };
}
