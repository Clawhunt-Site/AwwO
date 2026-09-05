import { describe, expect, it } from 'vitest';
import { canvasText, type CanvasTranslate } from '../src/canvas/i18n';
import type { PreflightIssue } from '../src/canvas/runGraph';
import {
  preflightIssueMessage,
  recoveryDetailMessage,
  surfaceNotice,
} from '../src/canvas/surfaceMessages';

const translate = (locale: 'zh' | 'en'): CanvasTranslate =>
  (key, values) => canvasText(locale, key, values);

describe('canvas surface messages', () => {
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
