import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canvasNameFromPrompt, clearHomeDraft, readHomeDraft, saveHomeDraft } from '../src/saas/homePrompt';
import {
  PLAN_HANDOFF_PREFIX, PLAN_HANDOFF_TTL_MS, claimPlanHandoff, clearPlanHandoff, savePlanHandoff, takePlanHandoff,
} from '../src/saas/planHandoff';
import { CASE_CATEGORIES, STARTER_CASES, caseSketch } from '../src/saas/starterCases';
import { canvasShape } from '../src/saas/CanvasThumbnail';

const scope = { user: 'user-a', tenant: 'tenant-a', canvas: 'canvas-a' };
const key = `${PLAN_HANDOFF_PREFIX}:user-a:tenant-a:canvas-a`;
const storedKeys = () => Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index));

beforeEach(() => sessionStorage.clear());
afterEach(() => { vi.restoreAllMocks(); sessionStorage.clear(); });

describe('a canvas named after its request', () => {
  it('takes the first clause of the first line, without polite fillers', () => {
    expect(canvasNameFromPrompt('请帮我做一个面向中小团队的任务协作 SaaS：成员用邮箱注册登录', '未命名')).toBe('做一个面向中小团队的任务协作 SaaS');
    expect(canvasNameFromPrompt('\n\n  搭建销售周报流程。先统一口径\n第二行', '未命名')).toBe('搭建销售周报流程');
    expect(canvasNameFromPrompt('麻烦你整理竞品资料；注明来源', '未命名')).toBe('整理竞品资料');
    expect(canvasNameFromPrompt('帮我  规划\t下个月的内容！再写文案', '未命名')).toBe('规划 下个月的内容');
    expect(canvasNameFromPrompt('Please build a CRM for our sales team: contacts and deals', 'Untitled')).toBe('Build a CRM for our sales team');
  });

  it('keeps words that only begin with 请, and ASCII punctuation inside a clause', () => {
    expect(canvasNameFromPrompt('请假审批流程：员工提交申请', '未命名')).toBe('请假审批流程');
    expect(canvasNameFromPrompt('请求日志分析？按接口汇总', '未命名')).toBe('请求日志分析');
    expect(canvasNameFromPrompt('Upgrade to v1.2 of the API. Then test it', 'Untitled')).toBe('Upgrade to v1.2 of the API');
  });

  it('cuts a long clause to 30 characters plus an ellipsis, never splitting a Latin word, within 200 bytes', () => {
    const zh = canvasNameFromPrompt('我们的销售数据分散在 CRM 导出表、线上商城订单和线下门店的 Excel 里，口径不统一。', '未命名');
    expect(zh).toBe('我们的销售数据分散在 CRM 导出表、线上商城订单和线下门店…');
    expect([...zh]).toHaveLength(31);
    expect(canvasNameFromPrompt('Design an onboarding experience for enterprise administrators', 'Untitled')).toBe('Design an onboarding…');
    const wide = canvasNameFromPrompt('😀'.repeat(80), 'Untitled');
    expect(new TextEncoder().encode(wide).length).toBeLessThan(200);
    expect(wide.endsWith('…')).toBe(true);
  });

  it('falls back when nothing readable is left', () => {
    expect(canvasNameFromPrompt('  \n ：。 ', '未命名')).toBe('未命名');
    expect(canvasNameFromPrompt('请', '未命名')).toBe('请');
    expect(canvasNameFromPrompt('', 'Untitled')).toBe('Untitled');
  });
});

describe('the unsent home prompt', () => {
  it('is kept per account and workspace for this tab, and removed when empty', () => {
    saveHomeDraft({ user: 'user-a', tenant: 'tenant-a' }, '我的需求');
    expect(readHomeDraft({ user: 'user-a', tenant: 'tenant-a' })).toBe('我的需求');
    expect(readHomeDraft({ user: 'user-b', tenant: 'tenant-a' })).toBe('');
    expect(readHomeDraft({ user: 'user-a', tenant: 'tenant-b' })).toBe('');
    saveHomeDraft({ user: 'user-a', tenant: 'tenant-a' }, '');
    expect(storedKeys()).toEqual([]);
    saveHomeDraft({ user: 'user-a', tenant: 'tenant-a' }, '再写一次');
    clearHomeDraft({ user: 'user-a', tenant: 'tenant-a' });
    expect(readHomeDraft({ user: 'user-a', tenant: 'tenant-a' })).toBe('');
  });
});

describe('the planning handoff from the home to a new canvas', () => {
  it('starts a fresh pending request, and taking it does not change it', () => {
    expect(savePlanHandoff(scope, '  搭建销售周报流程  ', 1_000)).toBe(true);
    expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual({ v: 1, prompt: '搭建销售周报流程', createdAt: 1_000, state: 'pending' });
    expect(takePlanHandoff(scope, 2_000)).toEqual({ prompt: '搭建销售周报流程', start: true, interrupted: false });
    expect(takePlanHandoff(scope, 2_000)).toEqual({ prompt: '搭建销售周报流程', start: true, interrupted: false });
    expect(savePlanHandoff(scope, '   ')).toBe(false);
  });

  it('lets exactly one caller claim it, after which it reads as interrupted rather than startable', () => {
    savePlanHandoff(scope, '搭建销售周报流程', 1_000);
    expect(claimPlanHandoff(scope, 1_500)).toBe(true);
    expect(claimPlanHandoff(scope, 1_600)).toBe(false);
    expect(takePlanHandoff(scope, 1_700)).toEqual({ prompt: '搭建销售周报流程', start: false, interrupted: true });
    // It was sent and never came back, however long ago that was.
    expect(takePlanHandoff(scope, 1_000 + 10 * PLAN_HANDOFF_TTL_MS)).toEqual({ prompt: '搭建销售周报流程', start: false, interrupted: true });
    clearPlanHandoff(scope);
    expect(takePlanHandoff(scope, 1_800)).toBeNull();
    expect(claimPlanHandoff(scope, 1_800)).toBe(false);
  });

  it('only restores an expired or future-dated pending request, never starts it', () => {
    savePlanHandoff(scope, '过期的需求', 1_000);
    expect(takePlanHandoff(scope, 1_000 + PLAN_HANDOFF_TTL_MS)).toEqual({ prompt: '过期的需求', start: true, interrupted: false });
    expect(takePlanHandoff(scope, 1_001 + PLAN_HANDOFF_TTL_MS)).toEqual({ prompt: '过期的需求', start: false, interrupted: false });
    expect(claimPlanHandoff(scope, 1_001 + PLAN_HANDOFF_TTL_MS)).toBe(false);
    savePlanHandoff(scope, '来自未来的需求', 100_000);
    expect(takePlanHandoff(scope, 10_000)).toEqual({ prompt: '来自未来的需求', start: false, interrupted: false });
    expect(claimPlanHandoff(scope, 10_000)).toBe(false);
  });

  it('removes a malformed entry instead of acting on it', () => {
    for (const raw of ['{broken', 'null', '[]', JSON.stringify({ v: 2, prompt: 'x', createdAt: 1, state: 'pending' }),
      JSON.stringify({ v: 1, prompt: ' ', createdAt: 1, state: 'pending' }), JSON.stringify({ v: 1, prompt: 'x', createdAt: 'soon', state: 'pending' }),
      JSON.stringify({ v: 1, prompt: 'x', createdAt: 1, state: 'running' })]) {
      sessionStorage.setItem(key, raw);
      expect(takePlanHandoff(scope, 2)).toBeNull();
      expect(sessionStorage.getItem(key)).toBeNull();
    }
    sessionStorage.setItem(key, '{broken');
    expect(claimPlanHandoff(scope, 2)).toBe(false);
    expect(sessionStorage.getItem(key)).toBeNull();
  });

  it('is scoped to one account, workspace and canvas', () => {
    savePlanHandoff(scope, '只属于这张画布', 1_000);
    for (const other of [{ ...scope, user: 'user-b' }, { ...scope, tenant: 'tenant-b' }, { ...scope, canvas: 'canvas-b' }]) {
      expect(takePlanHandoff(other, 1_000)).toBeNull();
      expect(claimPlanHandoff(other, 1_000)).toBe(false);
      clearPlanHandoff(other);
    }
    expect(takePlanHandoff(scope, 1_000)?.start).toBe(true);
  });

  it('fails closed, without throwing, when the browser refuses storage', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Quota exceeded', 'QuotaExceededError'); });
    expect(savePlanHandoff(scope, '存不下的需求', 1_000)).toBe(false);
    vi.mocked(Storage.prototype.setItem).mockRestore();
    savePlanHandoff(scope, '已经存下的需求', 1_000);
    // A request that cannot be marked as sent is never sent automatically.
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Quota exceeded', 'QuotaExceededError'); });
    expect(claimPlanHandoff(scope, 1_000)).toBe(false);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('Denied', 'SecurityError'); });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new DOMException('Denied', 'SecurityError'); });
    expect(takePlanHandoff(scope, 1_000)).toBeNull();
    expect(claimPlanHandoff(scope, 1_000)).toBe(false);
    expect(() => clearPlanHandoff(scope)).not.toThrow();
    expect(readHomeDraft({ user: 'user-a', tenant: 'tenant-a' })).toBe('');
    expect(() => saveHomeDraft({ user: 'user-a', tenant: 'tenant-a' }, 'x')).not.toThrow();
    expect(() => clearHomeDraft({ user: 'user-a', tenant: 'tenant-a' })).not.toThrow();
  });
});

describe('the curated example catalogue', () => {
  it('has eleven examples with every text in both languages and a readable sketch', () => {
    expect(STARTER_CASES).toHaveLength(11);
    expect(new Set(STARTER_CASES.map(item => item.id)).size).toBe(11);
    const categories = new Set(CASE_CATEGORIES.map(item => item.id));
    for (const item of STARTER_CASES) {
      expect(categories.has(item.category)).toBe(true);
      for (const text of [item.title, item.summary, item.prompt]) {
        expect(text.zh.trim()).not.toBe('');
        expect(text.en.trim()).not.toBe('');
        expect(text.en).not.toMatch(/[一-鿿]/u);
      }
      const shape = canvasShape(item.sketch);
      expect(shape.boxes.length).toBeGreaterThan(1);
      expect(shape.links.length).toBe(item.sketch.edges.length);
    }
    expect(CASE_CATEGORIES.map(item => STARTER_CASES.filter(example => example.category === item.id).length)).toEqual([3, 2, 2, 2, 2]);
  });

  it('lays sketches out in columns and links neighbouring columns unless told otherwise', () => {
    const sketch = caseSketch([['data'], ['general', 'general'], ['review']]);
    expect(sketch.nodes.map(({ id, x, y, w, h }) => ({ id, x, y, w, h }))).toEqual([
      { id: '0.0', x: 0, y: -95, w: 300, h: 190 },
      { id: '1.0', x: 420, y: -245, w: 300, h: 190 }, { id: '1.1', x: 420, y: 55, w: 300, h: 190 },
      { id: '2.0', x: 840, y: -95, w: 300, h: 190 },
    ]);
    expect(sketch.edges).toEqual([
      { fromNode: '0.0', toNode: '1.0' }, { fromNode: '0.0', toNode: '1.1' },
      { fromNode: '1.0', toNode: '2.0' }, { fromNode: '1.1', toNode: '2.0' },
    ]);
    expect(caseSketch([['data'], ['backend']], [['0.0', '1.0']]).edges).toEqual([{ fromNode: '0.0', toNode: '1.0' }]);
  });
});
