import type { UiLocale } from '../locale';
import { SaaSApiError, saasErrorMessage } from '../saas/api';
import { runErrorText } from '../saas/canvasErrors';
import type { CanvasTranslate } from './i18n';
import { recoveryDetailMessage } from './surfaceMessages';

// A node's failure that was a refusal, as the canvas assistant's Next card reads it (nextSteps.ts). A failure's detail is
// the refusal's code where a cloud run's node records it (graph_runs.go records the child run's error code; graph_media.go
// and edits.go their admission codes), or its copy where a node's own Send was refused (canvasBridge.ts reads the code to
// its copy, in the language of the page that sent it): both are recognised, the code only whole.

/** The service's copy of a code (api.ts), or undefined when it has none. */
function serviceText(code: string, locale: UiLocale): string | undefined {
  const text = saasErrorMessage(new SaaSApiError(0, code, code), locale);
  return text !== code ? text : undefined;
}

/** A code's copy as a failure records it: a run's (canvasErrors), else the service's. */
const copyOf = (code: string, locale: UiLocale) => runErrorText(code, locale) ?? serviceText(code, locale);

const PREMIUM = ['premium_quota_exceeded', 'premium_capacity_exceeded'];
/** The workspace may not run the node today: its own run allowance is full (today's calls, or runs at once), the
 * service's free calls for today are (plans.go), or it may not make the generation or the edit (its or its plan's
 * generations or edits are used up, the plan's credits are, or the node needs a paid plan: media_runs.go, edits.go).
 * Running it again today is refused the same way. */
const QUOTA = ['quota_exceeded', 'free_capacity_exceeded', 'media_quota_exceeded', 'media_capacity_exceeded', 'model3d_quota_exceeded',
  'model3d_capacity_exceeded', 'plan_media_quota_exceeded', 'model3d_motion_plan_required', 'credits_exhausted', 'edit_allowance'];

/** A code's copies in both languages, read once: the card asks on every render while a node has failed. */
const copies = new Map<string, string[]>();
function copiesOf(code: string): string[] {
  let found = copies.get(code);
  if (!found) {
    found = (['zh', 'en'] as const).map(language => copyOf(code, language) ?? '').filter(Boolean);
    copies.set(code, found);
  }
  return found;
}

/** Which of the codes the detail is: the code itself, or a detail holding its copy in either language. */
function refusalCode(detail: string | undefined, codes: ReadonlyArray<string>): string | undefined {
  const text = detail?.trim() ?? '';
  if (!text) return undefined;
  return codes.find(code => code === text) ?? codes.find(code => copiesOf(code).some(copy => text.includes(copy)));
}

/** Refused by the free premium allowance: today's premium calls are used up, or the model is not in it. */
export const isPremiumRefusal = (detail: string) => Boolean(refusalCode(detail, PREMIUM));

/** Refused because the workspace may not run the node today (QUOTA above). */
export const isQuotaRefusal = (detail: string) => Boolean(refusalCode(detail, QUOTA));

/** Whether a paid plan lifts the refusal: not the service's own edit limits, which edits.go reads from its configuration. */
export const upgradeHelps = (detail: string) => refusalCode(detail, QUOTA) !== 'edit_allowance';

/** Whether an Agent goes on by switching to the default model, which spends none of the plan's credits. */
export const modelSwitchHelps = (detail: string) => refusalCode(detail, QUOTA) === 'credits_exhausted';

/**
 * The refusal's own words in the reader's language: an edit's (surfaceMessages), a run's (canvasErrors) or the service's
 * (api.ts). An image, video, 3D or audio node (`media`) is told the plan's credits come back at its renewal, since the
 * default model it could switch to writes text. Undefined for the workspace's run allowance (`quota_exceeded`), which the
 * card says in its own short line, and for anything that is not such a refusal.
 */
export function refusalReason(detail: string | undefined, t: CanvasTranslate, locale: UiLocale, media = false): string | undefined {
  const code = refusalCode(detail, QUOTA);
  if (!code || code === 'quota_exceeded') return undefined;
  if (code === 'credits_exhausted' && media) return t('assistant.creditsUsedUpMedia');
  const edit = recoveryDetailMessage(t, code);
  return edit && edit !== code ? edit : copyOf(code, locale);
}
