import { api } from './api';
import type { Credits, PlanId } from './billing';

export type RouteName = 'gate' | 'bedrock' | 'media';
export type RouteAllowance = { limit: number; used: number };
/** What a daily check-in adds to today's allowances: calls, and image / video / 3D generations. */
export type CheckinBonus = { daily: number; media: number };
/** A member's daily check-in while a promotion runs (POST /tenants/{id}/checkin): checkedIn when this person checked
 * this workspace in today, taken when another member did, elsewhere when this person did in another workspace; today is
 * what this workspace's check-in today added, streak the person's run of consecutive days. */
export type CheckinState = { available: boolean; checkedIn: boolean; taken?: boolean; elsewhere?: boolean; bonus: CheckinBonus;
  today?: CheckinBonus; streak: number; endsAt: string };
/** A promotion's floors while it raises this workspace's free allowances, and when it ends. */
export type PromoView = { until: string; daily: number; routes?: Partial<Record<RouteName, number>> };
/** GET /tenants/{id}/route-usage: today's allowances, counted with admission's own filters (the
 * deployment-wide ceilings, the media caps and the model allowlist are not shown, so admission can still refuse). `routes`
 * is present only for a route-limited workspace and lists only the routes it limits; a route it leaves
 * out has no limit of its own. */
export type RouteUsage = { limited: boolean; daily: RouteAllowance; routes?: Partial<Record<RouteName, RouteAllowance>>; interested: boolean; resetsAt?: string;
  /** The canvas assistant's changes on the operator's model today: outside the daily calls, up to their own daily
   * number. Absent when changes run on the default model, which then counts like any call. */
  planner?: RouteAllowance;
  /** Set when the workspace's owner has a paid plan: its paid routes spend the owner's credits instead of route limits. */
  // The renewal date and a pending cancellation are shown to the workspace's owner alone; owner says the plan is
  // the viewer's own (only its owner can upgrade it).
  plan?: { id: PlanId; owner?: boolean; periodEnd?: string; cancelAtPeriodEnd?: boolean; credits: Credits };
  /** Set while a promotion raises this free workspace; the limits above already include it and today's check-in. */
  promo?: PromoView;
  /** Set for a member who may run things, while check-ins are offered to this workspace. */
  checkin?: CheckinState };

export const routeOrder: RouteName[] = ['gate', 'bedrock', 'media'];

/** Said on the page when something that spends calls has ended (a direct task, a canvas run, a plan): the header
 * meter reads today's numbers again instead of waiting for its next refresh. */
export const ROUTE_USAGE_CHANGED = 'awwo:route-usage-changed';
export function announceRouteUsageChanged() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(ROUTE_USAGE_CHANGED));
}

export function fetchRouteUsage(tenantId: string, signal?: AbortSignal) {
  return api<RouteUsage>(`/tenants/${encodeURIComponent(tenantId)}/route-usage`, { signal });
}

/** The server records what this person has used up at the moment they ask, so the request names nothing. */
export function recordUpgradeInterest(tenantId: string) {
  return api<{ recorded: boolean; clicks: number }>(`/tenants/${encodeURIComponent(tenantId)}/upgrade-interest`, { method: 'POST', body: '{}' });
}

/** Today's check-in: a second press the same day changes nothing and answers with the same state. */
export function checkIn(tenantId: string) {
  return api<{ checkin: CheckinState }>(`/tenants/${encodeURIComponent(tenantId)}/checkin`, { method: 'POST', body: '{}' });
}

/** Whether this person can still check this workspace in today. */
export function canCheckIn(checkin: CheckinState | undefined): boolean {
  return Boolean(checkin?.available && !checkin.checkedIn && !checkin.taken && !checkin.elsewhere);
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
