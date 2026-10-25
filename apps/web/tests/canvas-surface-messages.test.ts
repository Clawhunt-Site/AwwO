import { describe, expect, it } from 'vitest';
import { createSessionNode } from '../src/canvas/canvasDoc';
import { canvasText, type CanvasTranslate } from '../src/canvas/i18n';
import { SaaSApiError, saasErrorMessage } from '../src/saas/api';
import { runErrorCodes, runErrorText } from '../src/saas/canvasErrors';
import type { PreflightIssue } from '../src/canvas/runGraph';
import { preflightReviewGraphIssue, type ReviewPreflightReason } from '../src/canvas/reviewGraph';
import {
  failureCause,
  failureReason,
  preflightIssueMessage,
  recoveryDetailCodes,
  recoveryDetailMessage,
  refusedNodeMessage,
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

  it('names a node waiting for its automatic retry in both languages', () => {
    expect(recoveryDetailMessage(translate('en'), 'retrying', 'en')).toBe('Retrying automatically');
    expect(recoveryDetailMessage(translate('zh'), 'retrying', 'zh')).toBe('自动重试中');
  });

  // A cloud graph run's node records its run's code (graph_runs.go), which the node's failure note, the timeline and the
  // assistant used to show as it is: 「上次运行失败：run_timeout」.
  it.each(['run_timeout', 'team_timeout', 'provider_unavailable', 'runtime_failed', 'output_limit', 'interrupted', 'deliverable_storage_failed'])(
    'reads a cloud run’s failure code %s as its copy, with what to do, in the reader’s language', code => {
      for (const locale of ['zh', 'en'] as const) {
        expect(recoveryDetailMessage(translate(locale), code, locale)).toBe(runErrorText(code, locale));
      }
      expect(recoveryDetailMessage(translate('zh'), code, 'zh')).toMatch(/[\u3400-\u9fff]/);
      expect(recoveryDetailMessage(translate('en'), code, 'en')).not.toMatch(/[\u3400-\u9fff]/);
    });

  it('takes what happened from a failure copy, never the advice after it', () => {
    expect(failureCause(runErrorText('run_timeout', 'zh')!)).toBe('运行超时：模型迟迟没有给出结果');
    expect(failureCause(runErrorText('run_timeout', 'en')!)).toBe('The run timed out: the model took too long to give a result');
    expect(failureCause(canvasText('zh', 'surface.deliveryFormat'))).toBe('交回的结果不符合要求的交付格式（模型没给出要求的字段）');
    // A 请 in the same Chinese sentence starts its advice (review 2026-10-21: 「生成超时，请稍后重试或换一个模型」).
    expect(failureCause(runErrorText('media_timeout', 'zh')!)).toBe('生成超时');
    expect(failureCause(saasErrorMessage(new SaaSApiError(0, 'context_limit', ''), 'zh'))).toBe('这次要发给模型的内容超出了它一次能读的量，没有运行');
    // Words with no sentence end, or a full stop inside a number, stay whole.
    expect(failureCause('上游节点未完成')).toBe('上游节点未完成');
    expect(failureCause('provider said no: model v1.5 refused')).toBe('provider said no: model v1.5 refused');
  });

  it('cuts every run failure copy, in both languages, to what happened, with no advice left in it', () => {
    // 请 asks, except in 请求 (a request).
    const advice = { zh: /请(?!求)|重试|重新运行|再运行|再发送|再试|换一个|换个|联系管理员|刷新|调大|升级|取消这个/, en: /\b(?:retry|try again|run it again|send it again|choose another|switch|contact|reload|raise|upgrade|clear the tool)\b/i };
    for (const code of runErrorCodes()) {
      for (const locale of ['zh', 'en'] as const) {
        const cause = failureCause(runErrorText(code, locale)!);
        expect(cause, `${code} ${locale}`).toBeTruthy();
        expect(cause, `${code} ${locale}`).not.toMatch(advice[locale]);
      }
    }
  });

  it('gives the assistant and the planner a copy’s cause, and any other detail whole', () => {
    const zh = translate('zh');
    const en = translate('en');
    // A recorded code, the copy a node's own Send recorded, the delivery-format copy: their cause.
    expect(failureReason(zh, 'run_timeout', 'zh')).toBe('运行超时：模型迟迟没有给出结果');
    expect(failureReason(zh, runErrorText('provider_unavailable', 'zh'), 'zh')).toBe('模型服务暂时不可用，这次没有完成');
    expect(failureReason(zh, 'Output must be a JSON object keyed by output field IDs', 'zh')).toBe('交回的结果不符合要求的交付格式（模型没给出要求的字段）');
    // A code only the service words, recorded as its code by a cloud run's node or as its copy by a node's own Send, in
    // either language (review 2026-10-21: 「输入超出模型上下文限制，请…」 asked the assistant to do what the reader should).
    const contextLimit = (locale: 'zh' | 'en') => saasErrorMessage(new SaaSApiError(0, 'context_limit', ''), locale);
    expect(failureReason(zh, 'context_limit', 'zh')).toBe('这次要发给模型的内容超出了它一次能读的量，没有运行');
    expect(failureReason(zh, contextLimit('zh'), 'zh')).toBe('这次要发给模型的内容超出了它一次能读的量，没有运行');
    expect(failureReason(zh, contextLimit('en'), 'zh')).toBe('What this would send is more than the model can read at once, so it did not run');
    expect(failureReason(en, contextLimit('en'), 'en')).toBe('What this would send is more than the model can read at once, so it did not run');
    // A code the canvas words itself, an edit's among them.
    expect(failureReason(zh, 'edit_busy', 'zh')).toBe('渲染服务一直在忙别的任务，这次剪辑没有执行');
    expect(failureReason(en, 'edit_file_missing', 'en')).toBe('A file the timeline names is no longer stored');
    // The provider's or the worker's own words, and an edit's refusal with the worker's words, whole (review 2026-10-21),
    // whatever sentences, question marks or field names they hold.
    expect(failureReason(zh, 'Request rejected. max_tokens exceeds 32000 for this model.', 'zh')).toBe('Request rejected. max_tokens exceeds 32000 for this model.');
    expect(failureReason(en, 'Output What happened? Details must be a string', 'en')).toBe('Output What happened? Details must be a string');
    expect(failureReason(en, 'Missing output summary. Missing output html', 'en')).toBe('Missing output summary. Missing output html');
    expect(failureReason(zh, 'edit_rejected: tracks.video[0] is missing. Wire a clip.', 'zh')).toBe(canvasText('zh', 'edit.rejected', { detail: 'tracks.video[0] is missing. Wire a clip.' }));
    expect(failureReason(zh, 'Upstream did not complete', 'zh')).toBe('上游节点未完成');
    expect(failureReason(zh, '', 'zh')).toBeUndefined();
    expect(failureReason(zh, undefined, 'zh')).toBeUndefined();
  });

  it('gives what happened, with no advice left in it, for every code and status the canvas words itself', () => {
    const advice = {
      zh: /请(?!求)|重试|重新运行|再运行|再发送|再试|换一个|换个|联系管理员|刷新|调大|升级|核对|检查|查看/,
      en: /\b(?:retry|try again|run it again|run the|send it again|choose another|switch|check|inspect|contact|reload|raise|upgrade)\b/i,
    };
    // 'retrying' is a status: the node waits for its automatic retry.
    for (const code of recoveryDetailCodes().filter(code => code !== 'retrying')) {
      for (const locale of ['zh', 'en'] as const) {
        const reason = failureReason(translate(locale), code, locale);
        expect(reason, `${code} ${locale}`).toBeTruthy();
        expect(reason, `${code} ${locale}`).not.toMatch(advice[locale]);
      }
    }
  });

  it('reads a code only the service words (an admission’s) as the service’s copy, and keeps its own codes first', () => {
    expect(recoveryDetailMessage(translate('zh'), 'context_limit', 'zh')).toBe(saasErrorMessage(new SaaSApiError(0, 'context_limit', ''), 'zh'));
    expect(recoveryDetailMessage(translate('en'), 'media_quota_exceeded', 'en')).toBe(saasErrorMessage(new SaaSApiError(0, 'media_quota_exceeded', ''), 'en'));
    // A code the canvas words itself is not replaced: an edit's 'timeout', a node's 'cancelled'.
    expect(recoveryDetailMessage(translate('en'), 'timeout', 'en')).toBe(canvasText('en', 'edit.timeout'));
    expect(recoveryDetailMessage(translate('zh'), 'cancelled', 'zh')).toBe('已取消');
  });

  it.each(['review_invalid_verdict', 'review_exhausted'])('translates persisted review status %s in both languages', detail => {
    expect(recoveryDetailMessage(translate('en'), detail, 'en')).not.toMatch(/[\u3400-\u9fff]/);
    expect(recoveryDetailMessage(translate('en'), detail, 'en')).not.toBe(detail);
    expect(recoveryDetailMessage(translate('zh'), detail, 'zh')).toMatch(/[\u3400-\u9fff]/);
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
    expect(recoveryDetailMessage(en, 'recovery_not_dispatched', 'en')).toBe(
      'Not dispatched before the page was interrupted.',
    );
    expect(recoveryDetailMessage(zh, 'recovery_identity_missing', 'zh')).toContain('缺少原生运行标识');
    expect(recoveryDetailMessage(en, 'succeeded', 'en')).toBe('Completed');
    expect(recoveryDetailMessage(en, 'timed_out', 'en')).toBe('Timed out');
    expect(recoveryDetailMessage(zh, 'failed', 'zh')).toBe('失败');
    expect(recoveryDetailMessage(zh, 'cancelled', 'zh')).toBe('已取消');
    expect(recoveryDetailMessage(zh, 'Upstream did not complete', 'zh')).toBe('上游节点未完成');
    expect(recoveryDetailMessage(en, 'Upstream did not complete', 'en')).toBe('Upstream node did not complete');
    expect(recoveryDetailMessage(zh, 'Missing cached upstream output', 'zh')).toBe('缺少可沿用的上游产出');
    expect(recoveryDetailMessage(zh, 'Cached upstream output holds no deliverable', 'zh')).toBe('上游旧产出没有可用交付物');
    expect(recoveryDetailMessage(en, 'native status: paused', 'en')).toBe('native status: paused');
    expect(recoveryDetailMessage(en, undefined, 'en')).toBeUndefined();
  });

  it('maps every structured preflight issue and formats title lists for the locale', () => {
    const cases: Array<[PreflightIssue, RegExp, RegExp]> = [
      [{ code: 'empty_graph', values: {}, message: 'legacy' }, /no nodes/i, /还没有节点/],
      [{ code: 'empty_scope', values: {}, message: 'legacy' }, /select at least one/i, /没有选中/],
      [{ code: 'unbound_nodes', values: { count: 2, titles: ['API', 'UI'] }, message: 'legacy' }, /API, UI/, /API、UI/],
      [{ code: 'multiple_inputs', values: { nodeTitle: 'Review', field: 'Brief' }, message: 'legacy' }, /Review.*Brief/, /Review.*Brief/],
      [{ code: 'missing_inputs', values: { nodeTitle: 'Review', errors: ['Brief is required'] }, message: 'legacy' }, /Review/, /Review/],
      [{ code: 'cycle', values: { titles: ['API', 'UI'] }, message: 'legacy' }, /API, UI/, /API、UI/],
      // Both languages say what to do about a catalogue that moved under an open canvas, not only to re-pick.
      [{ code: 'media_params', values: { count: 2, titles: ['海报', '封面'] }, message: 'legacy' }, /2 node\(s\).*海报, 封面.*reload the page/, /2 个节点.*海报、封面.*刷新页面/],
    ];

    for (const [issue, english, chinese] of cases) {
      expect(preflightIssueMessage(translate('en'), issue, 'en')).toMatch(english);
      expect(preflightIssueMessage(translate('zh'), issue, 'zh')).toMatch(chinese);
    }
    expect(preflightIssueMessage(translate('en'), null, 'en')).toBeNull();
  });

  // A canvas run freezes every media node in its scope before it starts, so one node's own saved state refuses the
  // whole canvas: the service carries that node's id and the page, which owns the titles, puts it in front.
  it('names the node a refused canvas run was refused for, and leaves a refusal that named none as it is', () => {
    const nodes = [
      { ...createSessionNode('image', { x: 0, y: 0 }), id: 'vid', title: '片头动画' },
      { ...createSessionNode('image', { x: 0, y: 0 }), id: 'img', title: '海报' },
    ];
    const refusal = new SaaSApiError(400, 'media_params_invalid', '', { nodeId: 'vid' });
    for (const locale of ['zh', 'en'] as const) {
      const copy = saasErrorMessage(refusal, locale);
      const named = refusedNodeMessage(copy, 'vid', nodes, locale);
      expect(named).toBe(`“片头动画”${locale === 'zh' ? '：' : ': '}${copy}`);
      // The copy the service worded is kept whole, and no other node is named.
      expect(named).toContain(copy);
      expect(named).not.toContain('海报');
      // A refusal that named no node, and one naming a node this page no longer holds, read exactly as worded.
      expect(refusedNodeMessage(copy, null, nodes, locale)).toBe(copy);
      expect(refusedNodeMessage(copy, 'deleted', nodes, locale)).toBe(copy);
      expect(refusedNodeMessage(copy, 'vid', [], locale)).toBe(copy);
    }
  });
});
