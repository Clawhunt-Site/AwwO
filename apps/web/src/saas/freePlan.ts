// The end of the free trial as the hosted pages say it (owner 2026-11-07: the trial ends on 2026-11-12 at 24:00 Beijing
// time; after it a workspace whose owner has no paid plan runs nothing until it subscribes). The server says when
// (route-usage `freePlan`, AWWO_FREE_PLAN_UNTIL) and whether it has passed by its own clock; these helpers only word it.
import type { RouteUsage } from './routeUsage';

const DAY_MS = 86_400_000;

/** A moment as the reader's local date and time: 11月12日 16:00 / Nov 12, 16:00. With `end`, a moment on a local midnight
 *  reads as the end of the day before (11月12日 24:00 / Nov 12, 24:00), the way people name the last day of something:
 *  16:00 UTC on 11-12 is 24:00 on the 12th in Beijing. '' for a time that does not parse. */
export function momentText(iso: string, locale: 'zh' | 'en', options: { end?: boolean } = {}): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '';
  const date = new Date(at);
  const midnight = Boolean(options.end) && date.getHours() === 0 && date.getMinutes() === 0 && date.getSeconds() === 0;
  const shown = midnight ? new Date(at - 60_000) : date;
  const day = new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-US', locale === 'zh' ? { month: 'long', day: 'numeric' } : { month: 'short', day: 'numeric' }).format(shown);
  const time = midnight ? '24:00'
    : `${String(shown.getHours()).padStart(2, '0')}:${String(shown.getMinutes()).padStart(2, '0')}`;
  return locale === 'zh' ? `${day} ${time}` : `${day}, ${time}`;
}

/** Whole days left until a moment, counting a part of a day as one; 0 once it has come. */
export function daysLeft(iso: string, now: number): number {
  const at = Date.parse(iso);
  if (!Number.isFinite(at) || at <= now) return 0;
  return Math.ceil((at - now) / DAY_MS);
}

/** Where a workspace stands, from its route-usage: on its owner's paid plan; in a free trial that ends (freePlan, not
 *  ended); past that end; free with no end known (a promotion's end, if any, is promo.until); or none of these (an
 *  unlimited workspace, the local edition, or no answer yet). */
export type FreePlanStanding = 'paid' | 'trial' | 'ended' | 'free' | 'none';
export function freePlanStanding(usage: RouteUsage | null | undefined): FreePlanStanding {
  if (!usage) return 'none';
  if (usage.plan) return 'paid';
  if (usage.freePlan) return usage.freePlan.ended ? 'ended' : 'trial';
  return usage.limited ? 'free' : 'none';
}

/** The moment the free allowance of a free workspace ends: the free plan's end where the server ends it, else the
 *  promotion's; null where neither is known. */
export function trialEnd(usage: RouteUsage | null | undefined): string | null {
  if (!usage || usage.plan) return null;
  return usage.freePlan?.until ?? usage.promo?.until ?? null;
}
