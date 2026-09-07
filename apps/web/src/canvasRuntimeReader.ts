import { paperclipApiBase } from './paperclipBridge';

/** Adapt the live Node registry to RuntimePicker's existing inventory contract.
 * Registered adapters are not a claim that their CLI is logged in or executable.
 * Codex uses the gateway's host CLI catalog; other adapters retain their registry contract.
 */
export function createCanvasRuntimeReader(base = paperclipApiBase(), fetchImpl: typeof fetch = fetch) {
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

  async function modelIds(type: string, signal?: AbortSignal | null, selectedCompany?: string): Promise<string[]> {
    let companyId = selectedCompany;
    if (!companyId) {
      const companies = await get('/companies', signal);
      if (!Array.isArray(companies)) throw new Error('Invalid workspace registry response.');
      companyId = companies.find(item => typeof item?.id === 'string' && item.status !== 'archived')?.id;
    }
    if (!companyId) return [];
    const data = await get(`/companies/${encodeURIComponent(companyId)}/adapters/${encodeURIComponent(type)}/models`, signal);
    if (!Array.isArray(data)) throw new Error('Invalid model registry response.');
    return data.map(item => typeof item === 'string' ? item : item?.id)
      .filter((id): id is string => typeof id === 'string' && Boolean(id.trim()));
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
      if (adapters.some(item => item.type !== 'codex_local' && !(item.modelsCount > 0))) {
        const companies = await get('/companies', init?.signal);
        if (!Array.isArray(companies)) throw new Error('Invalid workspace registry response.');
        companyId = companies.find(item => typeof item?.id === 'string' && item.status !== 'archived')?.id;
      }
      return { agents: await Promise.all(adapters.map(async item => item.type === 'codex_local' ? {
        name: item.type, supports_model_selection: true, supports_effort_selection: true, model_catalog_source: 'codex_app_server',
      } : ({
        name: item.type,
        supports_model_selection: item.modelsCount > 0 || Boolean(companyId && (await modelIds(item.type, init?.signal, companyId)).length),
        supports_effort_selection: false,
      }))) };
    }
    const models = /^\/api\/agents\/([^/]+)\/models$/.exec(path);
    if (!models) throw new Error('Unsupported runtime inventory request.');
    // Discovery never changes the workspace selected for binding or member administration.
    const type = decodeURIComponent(models[1]);
    if (type === 'codex_local') return codexModels(init?.signal);
    return { models: await modelIds(type, init?.signal) };
  };
}
