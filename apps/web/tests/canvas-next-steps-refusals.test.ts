import { describe, expect, it } from 'vitest';
import { canvasText } from '../src/canvas/i18n';
import { isPremiumRefusal, isQuotaRefusal, modelSwitchHelps, refusalReason, upgradeHelps } from '../src/canvas/runRefusals';
import { saasErrorMessage, SaaSApiError } from '../src/saas/api';
import { runErrorText } from '../src/saas/canvasErrors';

// How the Next card reads a refused node: a cloud run's node records the refusal's code as its detail (graph_runs.go),
// a node's own Send the refusal's copy, in the language of the page that sent it (canvasBridge.ts).
type Key = Parameters<typeof canvasText>[1];
const en = (key: Key, values?: Record<string, string | number>) => canvasText('en', key, values);
const zh = (key: Key, values?: Record<string, string | number>) => canvasText('zh', key, values);
const service = (code: string, locale: 'zh' | 'en') => saasErrorMessage(new SaaSApiError(429, code, ''), locale);

describe('a refused node, as the Next card reads it', () => {
  it.each(['quota_exceeded', 'free_capacity_exceeded', 'media_quota_exceeded', 'media_capacity_exceeded', 'model3d_quota_exceeded',
    'model3d_capacity_exceeded', 'plan_media_quota_exceeded', 'model3d_motion_plan_required', 'credits_exhausted', 'edit_allowance'])('takes %s as a refusal for today', code => {
    expect(isQuotaRefusal(code)).toBe(true);
    expect(isPremiumRefusal(code)).toBe(false);
  });

  it('knows a refusal by its copy in either language too, the service’s included, but a code only whole', () => {
    expect(isQuotaRefusal(`${runErrorText('quota_exceeded', 'zh')}（第 2 次）`)).toBe(true);
    // A node's own Send refused for today's generations records the service's copy (api.ts), not the run errors'.
    expect(isQuotaRefusal(service('media_quota_exceeded', 'zh'))).toBe(true);
    expect(isQuotaRefusal(service('model3d_motion_plan_required', 'en'))).toBe(true);
    expect(isPremiumRefusal(runErrorText('premium_quota_exceeded', 'en')!)).toBe(true);
    expect(isPremiumRefusal(' premium_capacity_exceeded ')).toBe(true);
    // A premium refusal's code holds "quota_exceeded": it is not the workspace's allowance.
    expect(isQuotaRefusal('premium_quota_exceeded')).toBe(false);
    expect(isQuotaRefusal('media_failed')).toBe(false);
    expect(isQuotaRefusal('The generation failed after media_quota_exceeded was retried')).toBe(false);
  });

  it('sends every such refusal to the plans but the service’s own edit limit, and only credits to the default model', () => {
    expect(upgradeHelps('media_quota_exceeded')).toBe(true);
    expect(upgradeHelps('credits_exhausted')).toBe(true);
    expect(upgradeHelps('edit_allowance')).toBe(false);
    expect(modelSwitchHelps('credits_exhausted')).toBe(true);
    expect(modelSwitchHelps(runErrorText('credits_exhausted', 'zh')!)).toBe(true);
    expect(modelSwitchHelps('media_quota_exceeded')).toBe(false);
  });

  it('says why in the refusal’s own words, in the reader’s language', () => {
    expect(refusalReason('media_quota_exceeded', en, 'en')).toBe('This workspace has used today’s image and video generations. Try again after the next UTC day; '
      + 'for more, see the Pro and Max plans (account menu → Plans and credits).');
    expect(refusalReason('credits_exhausted', en, 'en')).toBe(runErrorText('credits_exhausted', 'en'));
    expect(refusalReason('model3d_motion_plan_required', en, 'en')).toMatch(/^Rigging and animating a 3D model needs the Pro or Max plan/);
    expect(refusalReason('edit_allowance', en, 'en')).toBe(en('edit.allowance'));
    expect(refusalReason('free_capacity_exceeded', en, 'en')).toBe(runErrorText('free_capacity_exceeded', 'en'));
    expect(refusalReason('media_quota_exceeded', zh, 'zh')).toMatch(/^本工作区今日的图像与视频生成次数已用完/);
    // A copy recorded in the other language is said in the reader's.
    expect(refusalReason(service('media_quota_exceeded', 'zh'), en, 'en')).toBe(service('media_quota_exceeded', 'en'));
    // A media node out of the plan's credits is not told to switch to the default model, which writes text.
    expect(refusalReason('credits_exhausted', en, 'en', true)).toBe(en('assistant.creditsUsedUpMedia'));
    expect(refusalReason('credits_exhausted', zh, 'zh', true)).toBe(zh('assistant.creditsUsedUpMedia'));
    // The workspace's run allowance keeps the card's own line; other failures have no reason of their own here.
    expect(refusalReason('quota_exceeded', en, 'en')).toBeUndefined();
    expect(refusalReason('This workspace has used today’s image and video generations.', en, 'en')).toBeUndefined();
    expect(refusalReason('some_unknown_code', en, 'en')).toBeUndefined();
    expect(refusalReason(undefined, en, 'en')).toBeUndefined();
  });
});
