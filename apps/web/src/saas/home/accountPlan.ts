// What the home's account card and trial banner say of a workspace's plan, from its route-usage alone: the home never
// reads GET /billing, which asks ClawHunt for every free account it is read for. route-usage's plan is the workspace
// owner's; its renewal date and a pending cancellation reach the owner alone, and a reader is sent no plan at all.
import type { Credits, PlanId } from '../billing';
import type { RouteUsage } from '../routeUsage';
import { freePlanStanding, trialEnd } from '../freePlan';
import type { Tenant } from '../api';

/** Less than this share of a period's credits left is low: the owner's first action becomes the bigger plan. */
export const LOW_CREDITS = 0.15;

/** The card's action: subscribe or upgrade from free, resume a plan set to end, move Pro up to Max, or manage it; for
 *  someone who is not the owner of a free workspace, a plan of their own (`own`), which opens their own workspaces only:
 *  the server opens a workspace by its owner's plan. */
export type PlanCall = 'subscribe' | 'upgrade' | 'resume' | 'upgrade-max' | 'manage' | 'own';
export type PaidView = { standing: 'paid'; plan: PlanId; owner: boolean; credits: Credits | null; periodEnd: string | null; cancel: boolean;
  low: boolean; call: PlanCall | null; primary: boolean };
/** `owner`: the viewer owns the workspace, the one account whose plan opens it. */
export type FreeView = { standing: 'trial' | 'ended' | 'free'; until: string | null; owner: boolean; call: PlanCall | null };
export type PlanView = PaidView | FreeView;

const isCredits = (value: unknown): value is Credits => typeof value === 'object' && value !== null
  && typeof (value as Credits).remaining === 'number' && typeof (value as Credits).granted === 'number';
const isPlanId = (value: unknown): value is PlanId => value === 'pro' || value === 'max';

/** Whether a period's credits are nearly spent (none granted counts as spent once none remain). */
export function lowCredits(credits: Credits | null): boolean {
  if (!credits) return false;
  return credits.granted > 0 ? credits.remaining / credits.granted < LOW_CREDITS : credits.remaining <= 0;
}

/** The owner's action on a paid plan: resume one set to end; with few credits left, Max for a Pro plan (managing a Max
 *  one); otherwise managing it, as a quieter link. Someone else's plan offers none. */
function paidView(plan: NonNullable<RouteUsage['plan']>): PaidView {
  const credits = isCredits(plan.credits) ? plan.credits : null;
  const owner = plan.owner === true, cancel = plan.cancelAtPeriodEnd === true, low = lowCredits(credits);
  const call: PlanCall | null = !owner ? null : cancel ? 'resume' : low && plan.id === 'pro' ? 'upgrade-max' : 'manage';
  return { standing: 'paid', plan: plan.id, owner, credits, periodEnd: typeof plan.periodEnd === 'string' ? plan.periodEnd : null, cancel, low,
    call, primary: call === 'resume' || call === 'upgrade-max' || (call === 'manage' && low) };
}

/** The plan block for this viewer, or null where there is none to show (an unlimited workspace, the local edition, no
 *  answer yet). Only the owner is offered a plan for the workspace: the server opens it by its owner's plan, so a member's
 *  purchase would leave it closed. An admin or a member is offered a plan of their own, said to be theirs; a reader,
 *  nothing. */
export function planView(usage: RouteUsage | null | undefined, role: Tenant['role']): PlanView | null {
  const standing = freePlanStanding(usage);
  if (!usage || standing === 'none') return null;
  if (standing === 'paid') return usage.plan && isPlanId(usage.plan.id) ? paidView(usage.plan) : null;
  const owner = role === 'owner';
  const until = standing === 'free' ? usage.promo?.until ?? null : trialEnd(usage);
  const call: PlanCall | null = owner ? (standing === 'free' ? 'upgrade' : 'subscribe') : role === 'reader' ? null : 'own';
  return { standing, until, owner, call };
}

/** The banner over the home's sections: a trial that ends, one that has ended, a promotion's end where the server says no
 *  more (one older than the free plan's end), or the owner's plan set to end. `key` names what was dismissed, so a new
 *  end, or another kind, shows again; an ended trial cannot be dismissed. */
export type BannerView =
  | { kind: 'trial' | 'promo'; until: string; key: string }
  | { kind: 'ended'; key: null }
  | { kind: 'cancel'; plan: PlanId; periodEnd: string; key: string };
export function bannerView(usage: RouteUsage | null | undefined): BannerView | null {
  const standing = freePlanStanding(usage);
  if (!usage || standing === 'none') return null;
  if (standing === 'ended') return { kind: 'ended', key: null };
  if (standing === 'trial') { const until = trialEnd(usage); return until ? { kind: 'trial', until, key: `trial:${until}` } : null; }
  if (standing === 'free') return usage.promo?.until ? { kind: 'promo', until: usage.promo.until, key: `promo:${usage.promo.until}` } : null;
  const plan = usage.plan;
  if (plan?.owner === true && plan.cancelAtPeriodEnd === true && typeof plan.periodEnd === 'string' && isPlanId(plan.id)) {
    return { kind: 'cancel', plan: plan.id, periodEnd: plan.periodEnd, key: `cancel:${plan.periodEnd}` };
  }
  return null;
}
