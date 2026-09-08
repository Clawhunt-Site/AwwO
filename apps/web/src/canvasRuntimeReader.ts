import { canvasFetch } from './saas/canvasBridge';
import { paperclipApiBase } from './paperclipBridge';

/** Adapt the live Node registry to RuntimePicker's existing inventory contract.
 * Registered adapters are not a claim that their CLI is logged in or executable.
 * The registry does not advertise effort levels, so those controls stay hidden.
 */
export function createCanvasRuntimeReader(base = paperclipApiBase(), fetchImpl: typeof fetch = canvasFetch) {
  const apiBase = base.replace(/\/+$/, '');
  async function get(path: string, signal?: AbortSignal | null): Promise<unknown> {
    const timeout = AbortSignal.timeout(10_000);
    const response = await fetchImpl(`${apiBase}${path}`, {
      credentials: 'include', headers: { accept: 'application/json' },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) throw new Error(`Runtime registry request failed (${response.status}).`);
    return response.json();
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
      if (adapters.some(item => !(item.modelsCount > 0))) {
        const companies = await get('/companies', init?.signal);
        if (!Array.isArray(companies)) throw new Error('Invalid workspace registry response.');
        companyId = companies.find(item => typeof item?.id === 'string' && item.status !== 'archived')?.id;
      }
      return { agents: await Promise.all(adapters.map(async item => ({
        name: item.type,
        supports_model_selection: item.modelsCount > 0 || Boolean(companyId && (await modelIds(item.type, init?.signal, companyId)).length),
        supports_effort_selection: false,
        ...(item.supportsNodeTeams === true ? { supports_node_teams: true } : {}),
      }))) };
    }
    const models = /^\/api\/agents\/([^/]+)\/models$/.exec(path);
    if (!models) throw new Error('Unsupported runtime inventory request.');
    // Discovery never changes the workspace selected for binding or member administration.
    return { models: await modelIds(decodeURIComponent(models[1]), init?.signal) };
  };
}
