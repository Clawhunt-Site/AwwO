function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

export function getOrchestratorBaseUrl(): string {
  const configured = import.meta.env.VITE_DREAMY_ORCHESTRATOR_BASE_URL as string | undefined;
  return configured ? stripTrailingSlash(configured) : '';
}

export function getOrchestratorChatEndpoint(): string {
  const base = getOrchestratorBaseUrl();
  return base ? `${base}/api/chat` : '/api/chat';
}

export function getStudioRunEndpoint(): string {
  const base = getOrchestratorBaseUrl();
  return base ? `${base}/api/studio/run` : '/api/studio/run';
}

export function getStudioHealthEndpoint(): string {
  const base = getOrchestratorBaseUrl();
  return base ? `${base}/api/health` : '/api/health';
}

export function getStudioProjectEndpoint(projectId: string): string {
  const base = getOrchestratorBaseUrl();
  const path = `/api/studio/projects/${encodeURIComponent(projectId)}`;
  return base ? `${base}${path}` : path;
}

export function getStudioJobEndpoint(jobId: string): string {
  const base = getOrchestratorBaseUrl();
  const path = `/api/studio/jobs/${encodeURIComponent(jobId)}`;
  return base ? `${base}${path}` : path;
}

export function getStudioRootEndpoint(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const base = getOrchestratorBaseUrl();
  return base ? `${base}${path}` : path;
}

export function resolveOrchestratorAssetUrl(url: string | undefined): string {
  if (!url) return '';
  if (/^https?:\/\//i.test(url) || url.startsWith('data:')) return url;
  const base = getOrchestratorBaseUrl();
  return base ? `${base}${url.startsWith('/') ? '' : '/'}${url}` : url;
}

export const resolveStudioAssetUrl = resolveOrchestratorAssetUrl;
