import { api, SaaSApiError, tenantPath } from './api';

/** Turning a delivered page into a video (renders.go): the server's render worker freezes the page at every frame. */
export interface RenderParams { width: number; height: number; fps: number; seconds: number; loop: boolean; gif: boolean; contact: boolean }
export interface RenderOutput { kind: 'mp4' | 'gif' | 'contact'; artifactId: string; name: string; contentType: string; size: number }
export interface RenderJob {
  id: string; canvasId: string; nodeId: string; status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  params: RenderParams; htmlBytes: number; htmlSha256?: string; errorCode: string | null; createdAt: string; startedAt: string | null; finishedAt: string | null;
  result: { mode?: 'contract' | 'virtual-time'; frames?: number; distinctFrames?: number; seconds?: number; fps?: number; width?: number; height?: number;
    elapsedMs?: number; warnings?: string[]; pageErrors?: string[]; outputs?: RenderOutput[] };
}

export const RENDER_PRESETS = [
  { id: 'landscape', width: 1920, height: 1080 }, { id: 'square', width: 1080, height: 1080 },
  { id: 'portrait', width: 1080, height: 1350 }, { id: 'story', width: 1080, height: 1920 }, { id: 'small', width: 1280, height: 720 },
] as const;

const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
function job(x: unknown): x is RenderJob {
  return object(x) && typeof x.id === 'string' && typeof x.canvasId === 'string' && ['queued', 'running', 'completed', 'failed', 'cancelled'].includes(String(x.status))
    && object(x.params) && object(x.result);
}
function checked<T>(value: unknown, check: (x: unknown) => x is T): T {
  if (!check(value)) throw new SaaSApiError(502, 'invalid_render_response', 'The renderer returned incomplete data. Try again.');
  return value;
}
const base = (tenantId: string, canvasId: string) => tenantPath(tenantId, `/canvases/${encodeURIComponent(canvasId)}/renders`);

export async function startRender(tenantId: string, canvasId: string, request: RenderParams & { operationId: string; nodeId: string; html: string }, signal?: AbortSignal): Promise<RenderJob> {
  return checked(await api<unknown>(base(tenantId, canvasId), { method: 'POST', body: JSON.stringify(request), signal }), job);
}
export async function readRender(tenantId: string, canvasId: string, id: string, signal?: AbortSignal): Promise<RenderJob> {
  return checked(await api<unknown>(`${base(tenantId, canvasId)}/${encodeURIComponent(id)}`, { signal }), (x): x is RenderJob => job(x) && x.id === id);
}
export async function listRenders(tenantId: string, canvasId: string, nodeId: string, signal?: AbortSignal): Promise<RenderJob[]> {
  const value = await api<unknown>(`${base(tenantId, canvasId)}?nodeId=${encodeURIComponent(nodeId)}`, { signal });
  return checked(value, (x): x is { items: RenderJob[] } => object(x) && Array.isArray(x.items) && x.items.every(job)).items;
}
export async function cancelRender(tenantId: string, canvasId: string, id: string, signal?: AbortSignal): Promise<RenderJob> {
  return checked(await api<unknown>(`${base(tenantId, canvasId)}/${encodeURIComponent(id)}/cancel`, { method: 'POST', signal }), job);
}
