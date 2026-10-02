import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gzipSync, strFromU8 } from 'fflate';
import { canvasStorageKey, configureCanvasStorage } from '../src/canvas/canvasStorage';
import { plannerRecovery } from '../src/saas/plannerRecovery';
import { trackSignedInSession } from '../src/saas/api';
import { buildPlanningContext, type PlanningMessage } from '../src/canvas/canvasPlanning';
import { emptyDocument } from '../src/canvas/canvasDoc';
import { canvasPlanRevision } from '../src/canvas/canvasPlan';
import { clearSaaSCanvas, configureSaaSCanvas } from '../src/saas/canvasBridge';

const scope = { tenant: { id: '8170ce22-9eba-4b34-a209-b9b3e70aee04' }, canvasId: '6405bb10-8b6d-4729-bc27-290bfdba928d' };
const key = () => canvasStorageKey(`awwo.canvas.planning.run.v1:${scope.tenant.id}:${scope.canvasId}`);
const json = (value: unknown) => new Response(JSON.stringify(value));
const legacy = () => ({ version: 1, tenantId: scope.tenant.id, canvasId: scope.canvasId, operationId: 'original-operation',
  prompt: '保留任务 🧭', context: 'exact original context', revision: 'revision', knowledgeRevisionIds: ['source-1'] });
function packed(bytes: Uint8Array, expectedSize = bytes.length) {
  const gzip = gzipSync(bytes, { mtime: 0 });
  return { version: 2, encoding: 'gzip', bytes: expectedSize, data: btoa(strFromU8(gzip, true)) };
}
beforeEach(() => { localStorage.clear(); configureCanvasStorage('995a1a4f-c1f0-4428-a249-f050b315e95d', scope.tenant.id, scope.canvasId); trackSignedInSession(false); document.documentElement.lang = 'en';
  vi.spyOn(crypto, 'randomUUID').mockReturnValue('a02b9f73-5ed0-429c-980b-7a4c1eb89b66'); });
afterEach(() => { clearSaaSCanvas(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('bounded compressed planner recovery journal', () => {
  it.each(['zh', 'en'] as const)('fits the complete real %s protocol/template catalog in the observed remaining storage budget', async locale => {
    configureSaaSCanvas({ tenant: { ...scope.tenant, name: 'Fixture', role: 'owner', status: 'active', maxConcurrentRuns: 2, maxRunsPerDay: 10 }, canvasId: scope.canvasId });
    const doc = emptyDocument();
    const prompt = ('创建一个适合独立开发者展示产品的发布页面，需要清楚说明用户面对的问题、我们的解决方法以及具体使用流程。页面包含简洁的产品介绍、三张功能卡片、价格比较、常见问题、客户案例和开始使用按钮。请安排设计、开发和质量检查角色，让它们依次交付可以直接打开的网页，并检查手机和电脑上的排版、按钮状态、键盘操作及表单提示。整体采用明亮配色，减少无关说明，保持中文自然易读。').slice(0, 150);
    const messages: PlanningMessage[] = [];
    for (let index = 0; index < 5; index++) {
      messages.push({ id: `user-${index}`, role: 'user', content: prompt });
      if (index < 4) messages.push({ id: `error-${index}`, role: 'assistant', status: 'error', content: '无法保存或读取规划恢复记录。请先恢复浏览器存储，再读取原运行状态，避免重复提交。' });
    }
    const context = buildPlanningContext(doc, messages, locale);
    const runId = '1e8d5c98-58dd-4b8a-855a-9d61b07c584e';
    const set = localStorage.setItem.bind(localStorage);
    vi.spyOn(localStorage, 'setItem').mockImplementation((name, value) => {
      if (name === key() && name.length + value.length > 5837) throw new DOMException('Full', 'QuotaExceededError');
      set(name, value);
    });
    const fetch = vi.fn(async () => json({ id: runId, status: 'running' }));
    vi.stubGlobal('fetch', fetch);
    const recovery = plannerRecovery(scope);
    await expect(recovery.begin(prompt, canvasPlanRevision(doc), context)).resolves.toMatchObject({ run: { id: runId } });
    const raw = localStorage.getItem(key())!;
    console.info(JSON.stringify({ fixture: 'complete-planning-context', locale, contextUTF8Bytes: new TextEncoder().encode(context).length,
      promptChars: prompt.length, conversationMessages: messages.length, legacyJSONChars: JSON.stringify(recovery.read()).length, envelopeChars: raw.length, keyChars: key().length,
      totalUTF16Bytes: 2 * (key().length + raw.length), availableUTF16Bytes: 11674 }));
    expect(recovery.read()?.context).toBe(context);
    expect(key().length + raw.length).toBeLessThanOrEqual(5837);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('fits near quota without deleting other drafts and replays the lossless original payload after refresh', async () => {
    const otherDraft = JSON.stringify({ unsynced: 'user work that must survive' });
    localStorage.setItem('other-account-draft', otherDraft);
    const set = localStorage.setItem.bind(localStorage);
    const availableChars = 2200;
    vi.spyOn(localStorage, 'setItem').mockImplementation((name, value) => {
      if (name === key() && value.length > availableChars) throw new DOMException('Full', 'QuotaExceededError');
      set(name, value);
    });
    const context = `${'原始规划上下文与代码 🧭 <main>hello</main>\n'.repeat(1800)}\u0000\ud800`;
    const revision = 'original graph revision';
    const prompt = '做一个无损的报告 🧭';
    const payloads: string[] = [];
    const fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url.endsWith('/plan')) {
        payloads.push(init.body as string);
        if (payloads.length === 1) throw new TypeError('Response lost');
        return json({ id: 'original-run', status: 'running' });
      }
      return json({ items: [] });
    });
    vi.stubGlobal('fetch', fetch);
    const recovery = plannerRecovery(scope, ['source-1']);
    await expect(recovery.begin(prompt, revision, context)).rejects.toMatchObject({ code: 'planning_recovery_required' });
    const original = recovery.read()!;
    expect(JSON.stringify(original).length).toBeGreaterThan(availableChars);
    const raw = localStorage.getItem(key())!;
    expect(JSON.parse(raw)).toMatchObject({ version: 2, encoding: 'gzip' });
    expect(raw.length).toBeLessThan(availableChars);
    expect(original).toMatchObject({ version: 1, prompt, context, revision, knowledgeRevisionIds: ['source-1'] });
    await expect(plannerRecovery(scope, ['source-1']).begin(prompt, revision, 'new error history must not replace context', undefined, original.operationId))
      .resolves.toMatchObject({ run: { id: 'original-run' }, recovering: true });
    expect(payloads).toHaveLength(2);
    expect(payloads[1]).toBe(payloads[0]);
    expect(JSON.parse(payloads[1]).context).toBe(context);
    expect(localStorage.getItem('other-account-draft')).toBe(otherDraft);
    expect(localStorage.length).toBe(2);
    expect(recovery.read()?.runId).toBe('original-run');
  });

  it('reads legacy v1 journals and recovers their existing run without a new admission', async () => {
    const entry = { ...legacy(), runId: 'legacy-run' };
    localStorage.setItem(key(), JSON.stringify(entry));
    const fetch = vi.fn(async () => json({ id: 'legacy-run', status: 'completed' }));
    vi.stubGlobal('fetch', fetch);
    const recovery = plannerRecovery(scope, ['source-1']);
    expect(recovery.read()).toEqual(entry);
    await expect(recovery.begin(entry.prompt, entry.revision, 'changed history', undefined, entry.operationId)).resolves.toMatchObject({ run: { id: 'legacy-run' }, recovering: true });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0]).toContain('/runs/legacy-run');
  });

  it('reports storage quota precisely and never submits or removes existing work when compression still cannot fit', async () => {
    localStorage.setItem('other-account-draft', 'unsaved work');
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new DOMException('Full', 'QuotaExceededError'); });
    const remove = vi.spyOn(localStorage, 'removeItem');
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(plannerRecovery(scope).begin('Task', 'revision', 'Context')).rejects.toMatchObject({
      code: 'planning_recovery_storage', message: expect.stringMatching(/storage is full/i),
    });
    expect(fetch).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
    expect(localStorage.getItem('other-account-draft')).toBe('unsaved work');
  });

  it.each(['json', 'utf8', 'compressed'] as const)('explains an oversized %s record before admission without touching existing work', async kind => {
    let seed = 0x12345678;
    const context = kind === 'json' ? 'x'.repeat(2 * 1024 * 1024) : kind === 'utf8' ? '界'.repeat(750_000)
      : Array.from({ length: 800_000 }, () => {
        seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
        return String.fromCharCode(33 + ((seed >>> 0) % 94));
      }).join('');
    localStorage.setItem('other-account-draft', 'unsaved work');
    const set = vi.spyOn(localStorage, 'setItem');
    const remove = vi.spyOn(localStorage, 'removeItem');
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(plannerRecovery(scope).begin('Task', 'revision', context)).rejects.toMatchObject({
      code: 'planning_recovery_storage', message: expect.stringMatching(/planning content is too large/i),
    });
    expect(fetch).not.toHaveBeenCalled(); expect(set).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
    expect(localStorage.getItem('other-account-draft')).toBe('unsaved work');
    expect(localStorage.length).toBe(1);
  });

  it('rejects corrupt gzip checksum, malformed base64, invalid UTF-8 and oversized envelopes without deleting them', () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const valid = packed(new TextEncoder().encode(JSON.stringify(legacy())));
    const bytes = Uint8Array.from(atob(valid.data), c => c.charCodeAt(0));
    bytes[bytes.length - 8] ^= 1;
    const cases = [
      { ...valid, data: btoa(strFromU8(bytes, true)) },
      { ...valid, data: '@invalid-base64' },
      { ...valid, bytes: 2 ** 32 },
      { ...valid, data: 'A'.repeat(1024 * 1024) },
      packed(new Uint8Array([0xff, 0xfe])),
    ];
    for (const item of cases) {
      const raw = JSON.stringify(item); localStorage.setItem(key(), raw);
      expect(() => plannerRecovery(scope, ['source-1']).read()).toThrow();
      expect(localStorage.getItem(key())).toBe(raw);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects an oversized gzip stream even when its forged size describes a valid truncated JSON prefix', () => {
    const prefix = new TextEncoder().encode(JSON.stringify(legacy()));
    const body = new Uint8Array(prefix.length + 100_000); body.set(prefix); body.fill(32, prefix.length);
    const envelope = packed(body, prefix.length);
    const gzip = Uint8Array.from(atob(envelope.data), c => c.charCodeAt(0));
    new DataView(gzip.buffer).setUint32(gzip.length - 4, prefix.length, true);
    envelope.data = btoa(strFromU8(gzip, true));
    const raw = JSON.stringify(envelope); localStorage.setItem(key(), raw);
    expect(() => plannerRecovery(scope, ['source-1']).read()).toThrow();
    expect(localStorage.getItem(key())).toBe(raw);
  });

  it('validates the original scope inside a compressed record', () => {
    const envelope = packed(new TextEncoder().encode(JSON.stringify({ ...legacy(), tenantId: 'other-tenant' })));
    localStorage.setItem(key(), JSON.stringify(envelope));
    expect(() => plannerRecovery(scope, ['source-1']).read()).toThrow();
  });
});
