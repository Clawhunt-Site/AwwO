import { describe, expect, it } from 'vitest';
import { canvasText, type CanvasTranslate } from '../src/canvas/i18n';
import type { PreflightIssue } from '../src/canvas/runGraph';
import { preflightReviewGraphIssue, type ReviewPreflightReason } from '../src/canvas/reviewGraph';
import {
  preflightIssueMessage,
  recoveryDetailMessage,
  surfaceNotice,
} from '../src/canvas/surfaceMessages';

const translate = (locale: 'zh' | 'en'): CanvasTranslate =>
  (key, values) => canvasText(locale, key, values);

describe('canvas surface messages', () => {
  it.each([
    'full_graph_required', 'invalid_round_limit', 'duplicate_nodes', 'duplicate_edges', 'invalid_edges',
    'missing_feedback', 'missing_reviewer', 'invalid_verdict_field', 'reviewer_not_terminal',
    'missing_reviewer_feedback', 'invalid_feedback_input', 'conflicting_feedback_input', 'invalid_feedback_path',
  ] satisfies ReviewPreflightReason[])('localizes the review preflight reason %s without leaking legacy Chinese fields', reviewReason => {
    const issue: PreflightIssue = { code: 'missing_inputs', values: {
      reviewReason, nodeTitle: 'Agent Graph', fields: ['旧中文错误'], errors: ['旧中文错误'],
    }, message: '旧中文错误' };
    const english = preflightIssueMessage(translate('en'), issue, 'en');
    const chinese = preflightIssueMessage(translate('zh'), issue, 'zh');
    expect(english).toBeTruthy();
    expect(english).not.toMatch(/[\u3400-\u9fff]/);
    expect(english).not.toContain(reviewReason);
    expect(chinese).toMatch(/[\u3400-\u9fff]/);
    expect(chinese).not.toContain('旧中文错误');
  });

  it('preserves legacy engine messages while translating its new stable review reason', () => {
    const issue = preflightReviewGraphIssue([], [], { mode: 'review', maxRounds: 9, reviewerNodeId: '', verdictFieldId: '' });
    expect(issue?.values.reviewReason).toBe('invalid_round_limit');
    expect(issue?.message).toBe('评审轮次必须是 1 到 5 之间的整数。');
    expect(preflightIssueMessage(translate('en'), issue, 'en')).toBe('Choose a round limit from 1 to 5.');
  });

  it.each(['review_invalid_verdict', 'review_exhausted'])('translates persisted review status %s in both languages', detail => {
    expect(recoveryDetailMessage(translate('en'), detail)).not.toMatch(/[\u3400-\u9fff]/);
    expect(recoveryDetailMessage(translate('en'), detail)).not.toBe(detail);
    expect(recoveryDetailMessage(translate('zh'), detail)).toMatch(/[\u3400-\u9fff]/);
  });

  it('localizes storage and known recovery evidence without rewriting unknown detail', () => {
    const en = translate('en');
    const zh = translate('zh');

    expect(surfaceNotice(en, 'storage_write_failed')).toBe(
      'Unable to save run recovery data. Keep this page open.',
    );
    expect(surfaceNotice(zh, 'storage_write_failed')).toBe(
      '无法保存运行恢复数据，请保持当前页面打开。',
    );
    expect(recoveryDetailMessage(en, 'recovery_not_dispatched')).toBe(
      'Not dispatched before the page was interrupted.',
    );
    expect(recoveryDetailMessage(zh, 'recovery_identity_missing')).toContain('缺少原生运行标识');
    expect(recoveryDetailMessage(en, 'succeeded')).toBe('Completed');
    expect(recoveryDetailMessage(en, 'timed_out')).toBe('Timed out');
    expect(recoveryDetailMessage(zh, 'failed')).toBe('失败');
    expect(recoveryDetailMessage(zh, 'cancelled')).toBe('已取消');
    expect(recoveryDetailMessage(en, 'native status: paused')).toBe('native status: paused');
    expect(recoveryDetailMessage(en, undefined)).toBeUndefined();
  });

  it('maps every structured preflight issue and formats title lists for the locale', () => {
    const cases: Array<[PreflightIssue, RegExp, RegExp]> = [
      [{ code: 'empty_graph', values: {}, message: 'legacy' }, /no nodes/i, /还没有节点/],
      [{ code: 'empty_scope', values: {}, message: 'legacy' }, /select at least one/i, /没有选中/],
      [{ code: 'unbound_nodes', values: { count: 2, titles: ['API', 'UI'] }, message: 'legacy' }, /API, UI/, /API、UI/],
      [{ code: 'multiple_inputs', values: { nodeTitle: 'Review', field: 'Brief' }, message: 'legacy' }, /Review.*Brief/, /Review.*Brief/],
      [{ code: 'missing_inputs', values: { nodeTitle: 'Review', errors: ['Brief is required'] }, message: 'legacy' }, /Review/, /Review/],
      [{ code: 'cycle', values: { titles: ['API', 'UI'] }, message: 'legacy' }, /API, UI/, /API、UI/],
    ];

    for (const [issue, english, chinese] of cases) {
      expect(preflightIssueMessage(translate('en'), issue, 'en')).toMatch(english);
      expect(preflightIssueMessage(translate('zh'), issue, 'zh')).toMatch(chinese);
    }
    expect(preflightIssueMessage(translate('en'), null, 'en')).toBeNull();
  });
});
