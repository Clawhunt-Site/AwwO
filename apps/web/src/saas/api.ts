export const API_BASE = '/api/v1';
export class SaaSApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export async function api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body) headers.set('Content-Type', 'application/json');
  const response = await fetch(`${API_BASE}${path}`, { ...init, credentials: 'include', headers });
  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    throw new SaaSApiError(response.status, payload?.error?.code || 'request_failed',
      payload?.error?.message || (typeof payload?.error === 'string' ? payload.error : `请求失败（${response.status}）`));
  }
  return payload as T;
}
export type Tenant = { id: string; name: string; status: string; role: string; maxConcurrentRuns: number; maxRunsPerDay: number };
export type Identity = { user: { id: string; email: string; name: string; platformRole: 'user' | 'admin' }; tenants: Tenant[] };
export type CanvasRecord = { id: string; tenantId: string; name: string; document: unknown; version: number; createdAt: string; updatedAt: string };
export const tenantPath = (tenantId: string, suffix = '') => `/tenants/${encodeURIComponent(tenantId)}${suffix}`;
