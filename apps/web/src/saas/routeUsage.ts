import { api } from './api';

export type RouteName = 'gate' | 'bedrock' | 'media';
export type RouteAllowance = { limit: number; used: number };
/** GET /tenants/{id}/route-usage: today's allowances, counted with admission's own filters (the
 * deployment-wide ceilings, the media caps and the model allowlist are not shown, so admission can still refuse). `routes`
 * is present only for a route-limited workspace and lists only the routes it limits; a route it leaves
 * out has no limit of its own. */
export type RouteUsage = { limited: boolean; daily: RouteAllowance; routes?: Partial<Record<RouteName, RouteAllowance>>; interested: boolean; resetsAt?: string };

export const routeOrder: RouteName[] = ['gate', 'bedrock', 'media'];

export function fetchRouteUsage(tenantId: string, signal?: AbortSignal) {
  return api<RouteUsage>(`/tenants/${encodeURIComponent(tenantId)}/route-usage`, { signal });
}

/** The server records what this person has used up at the moment they ask, so the request names nothing. */
export function recordUpgradeInterest(tenantId: string) {
  return api<{ recorded: boolean; clicks: number }>(`/tenants/${encodeURIComponent(tenantId)}/upgrade-interest`, { method: 'POST', body: '{}' });
}

/** A route is used up only when it offered calls today; one closed with 0 never did. */
export function routeUsedUp(allowance: RouteAllowance | undefined): boolean {
  return allowance !== undefined && allowance.limit > 0 && allowance.used >= allowance.limit;
}

export type MeterState = { kind: 'ok' | 'partial' | 'premium-out' | 'daily-out'; usedUp: RouteName[]; left: number };

/** What the header chip says. The daily total decides first, since nothing runs once it is spent. Premium
 * calls are used up only when no route can take another one: a route without a limit of its own still
 * can, and a route closed with 0 never could, so neither counts as used up. */
export function meterState(usage: RouteUsage): MeterState {
  const left = Math.max(0, usage.daily.limit - usage.daily.used);
  const usedUp = routeOrder.filter(route => routeUsedUp(usage.routes?.[route]));
  const open = routeOrder.filter(route => {
    const allowance = usage.routes?.[route];
    return !allowance || (allowance.limit > 0 && allowance.used < allowance.limit);
  });
  if (left === 0) return { kind: 'daily-out', usedUp, left };
  if (open.length === 0 && usedUp.length > 0) return { kind: 'premium-out', usedUp, left };
  return { kind: usedUp.length ? 'partial' : 'ok', usedUp, left };
}
