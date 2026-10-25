import { api } from './api';

export type PlanId = 'pro' | 'max';
/** One row of GET /billing's catalog: what the plan gives. The charged price is Stripe's. */
export type CatalogPlan = { id: PlanId; priceUsd: number; credits: number; dailyCalls: number; concurrentAgents: number; workspaces: number; mediaPerDay: number };
export type AccountPlan = { id: PlanId; status: string; periodStart: string; periodEnd: string; cancelAtPeriodEnd: boolean; entitled: boolean };
// granted is what this period was given in all: what was paid for it plus `gift`, the part AwwO gifted the account
// for this period (spent only after the paid credits, and lasting as long as the period, as they do). carried is
// what an earlier period spent beyond its credits; it comes off this period's.
export type Credits = { granted: number; gift?: number; spent: number; carried?: number; remaining: number };
/** GET /billing: the catalog, whether checkout is open, and this account's plan with this period's credits. */
export type Billing = { catalog: CatalogPlan[]; checkoutEnabled: boolean; plan: AccountPlan | null; credits: Credits | null; stale: boolean };

export function fetchBilling(refresh = false, signal?: AbortSignal) {
  return api<Billing>(refresh ? '/billing?refresh=1' : '/billing', { signal });
}

export function startCheckout(plan: PlanId) {
  return api<{ url: string }>('/billing/checkout', { method: 'POST', body: JSON.stringify({ plan }) });
}

export function openBillingPortal() {
  return api<{ url: string }>('/billing/portal', { method: 'POST', body: '{}' });
}

/** Only Stripe's own page on the expected host is followed; the server checks the same. */
export function stripePage(raw: string, host: 'checkout.stripe.com' | 'billing.stripe.com'): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && url.host === host && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

export const planName = (id: PlanId) => (id === 'pro' ? 'Pro' : 'Max');

/** Leaving AwwO for Stripe's page; one place, so tests can watch it. */
export const billingNavigation = { go(url: string) { window.location.assign(url); } };

export const formatCredits = (n: number, locale: string) => new Intl.NumberFormat(locale === 'zh' ? 'zh-CN' : 'en-US').format(Math.max(0, Math.floor(n)));
