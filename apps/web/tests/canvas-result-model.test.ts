import { describe, expect, it } from 'vitest';
import { createAgentTemplate } from '../src/canvas/agentTemplates';
import { createFormNode, createSessionNode, type CanvasEdge, type CanvasNode, type NodeOutput, type SessionNode } from '../src/canvas/canvasDoc';
import { canvasResult, stepDelivery } from '../src/canvas/canvasResultModel';
import { nodeDepths } from '../src/canvas/nodePresentation';

const at = 1_790_000_000_000;
let ids = 0;
function step(title: string, type: 'markdown' | 'html' | 'text' | 'file', output?: string, extra: Partial<NodeOutput> = {}, node: Partial<SessionNode> = {}): SessionNode {
  const base = createSessionNode('llm', { x: 0, y: 0 });
  return { ...base, id: `n${++ids}`, title, ...node,
    contract: { version: 1, inputs: [], outputs: [{ id: 'result', label: title, type, required: true, value: '' }] },
    lastOutput: output === undefined ? null : { text: JSON.stringify({ result: output }), at: at + ids, source: 'run', ...extra } };
}
const wire = (from: CanvasNode, to: CanvasNode, kind?: CanvasEdge['kind']): CanvasEdge =>
  ({ id: `${from.id}-${to.id}`, fromNode: from.id, fromPort: 'out:result', toNode: to.id, toPort: 'in:brief', dataType: 'text', ...(kind ? { kind } : {}) });
const finalizer = (output?: string, extra: Partial<NodeOutput> = {}): SessionNode => ({
  ...createAgentTemplate('review', { x: 0, y: 0 }), id: `n${++ids}`, title: '方案检查与最终化',
  lastOutput: output === undefined ? null : { text: JSON.stringify({ report: output }), at: at + ids, source: 'run', ...extra },
});

describe('the canvas result model', () => {
  it.each([false, true])('selects the final plan produced by a review role regardless of document order (reverse=%s)', reverse => {
    const draft = step('活动方案拟定', 'text', '初稿');
    const final = finalizer('完整的最终活动方案');
    const nodes = reverse ? [final, draft] : [draft, final];
    const result = canvasResult({ nodes, edges: [wire(draft, final)] });
    expect(result.final?.node.id).toBe(final.id);
    expect(result.final?.text).toBe('完整的最终活动方案');
    expect(result).toMatchObject({ review: null, pending: [], complete: true });
  });

  it.each([undefined, '未写完的最终稿'])('keeps an unfinished finalization pending instead of calling the draft complete (%s)', output => {
    const draft = step('活动方案拟定', 'markdown', '初稿');
    const final = finalizer(output, { partial: true });
    const result = canvasResult({ nodes: [draft, final], edges: [wire(draft, final)] });
    expect(result.final?.node.id).toBe(draft.id);
    expect(result.pending.map(item => item.node.id)).toEqual([final.id]);
    expect(result.complete).toBe(false);
  });

  it('uses explicit final delivery fields over a review template and an earlier richer draft', () => {
    const draft = step('页面草稿', 'html', '<!doctype html><html><head><title>draft</title></head><body></body></html>');
    const final = { ...step('编辑检查', 'markdown', '最终活动方案', {}, { templateId: 'review' }),
      contract: { version: 1 as const, inputs: [], outputs: [{ id: 'finalMarkdown', label: '最终方案', type: 'markdown' as const, required: true, value: '' }] },
      lastOutput: { text: JSON.stringify({ finalMarkdown: '最终活动方案' }), at, source: 'run' as const } };
    expect(canvasResult({ nodes: [draft, final], edges: [wire(draft, final)] }).final?.node.id).toBe(final.id);
  });

  it('keeps an explicit policy reviewer as a check even when it is named a final report', () => {
    const draft = step('交付正文', 'markdown', '正文');
    const check = step('Final report', 'markdown', '检查通过');
    const result = canvasResult({ nodes: [draft, check], edges: [wire(draft, check)],
      execution: { mode: 'review', maxRounds: 1, reviewerNodeId: check.id, verdictFieldId: 'result' } });
    expect(result.final?.node.id).toBe(draft.id);
    expect(result.review?.node.id).toBe(check.id);
  });

  it('chooses consistently between equally recent final sinks and ignores dangling and feedback edges', () => {
    const draft = step('草稿', 'text', '草稿');
    const alpha = { ...finalizer('甲版'), id: 'final-a' };
    const beta = { ...finalizer('乙版'), id: 'final-b', lastOutput: { ...alpha.lastOutput!, text: '{"report":"乙版"}' } };
    const missing = { ...draft, id: 'missing' };
    const edges = [wire(draft, alpha), wire(draft, beta), wire(beta, missing), wire(beta, draft, 'feedback')];
    expect(canvasResult({ nodes: [draft, alpha, beta], edges }).final?.node.id).toBe('final-b');
    expect(canvasResult({ nodes: [beta, alpha, draft], edges }).final?.node.id).toBe('final-b');
  });

  it('orders steps by depth, side-by-side steps sharing one, and ignores a review sent back', () => {
    const design = step('玩法与数值', 'markdown', '规格'); const art = step('像素美术', 'markdown', '精灵'); const sound = step('音效', 'markdown', '音效');
    const build = step('可玩试玩关', 'html', '<!doctype html><html><head><title>game</title></head><body></body></html>'); const review = step('试玩验收', 'markdown', '通过');
    const result = canvasResult({ nodes: [review, build, sound, art, design],
      edges: [wire(design, art), wire(design, sound), wire(art, build), wire(sound, build), wire(build, review), wire(review, build, 'feedback')] });
    expect(result.stages.map(stage => stage.map(item => item.node.title))).toEqual([['玩法与数值'], ['音效', '像素美术'], ['可玩试玩关'], ['试玩验收']]);
    expect(result.final?.node.title).toBe('可玩试玩关');
    expect(result.final?.kind).toBe('html');
    expect(result.final?.html).toContain('<title>game</title>');
    // The acceptance step reports on the result; it is not the result.
    expect(result.review?.node.title).toBe('试玩验收');
    expect(result.pending).toEqual([]);
  });

  it('prefers the furthest product, a page, over later notes, and the furthest step when there is no product', () => {
    const page = step('产品界面', 'html', '<!doctype html><html><head><title>ui</title></head><body><p>ui</p></body></html>'); const plan = step('上线计划', 'markdown', '计划');
    expect(canvasResult({ nodes: [page, plan], edges: [wire(page, plan)] }).final?.node.title).toBe('产品界面');
    const notes = step('需求整理', 'markdown', '需求'); const report = step('分析报告', 'markdown', '报告');
    expect(canvasResult({ nodes: [notes, report], edges: [wire(notes, report)] }).final?.node.title).toBe('分析报告');
  });

  it('knows an acceptance step by its template or its name, and uses one only when nothing else delivered', () => {
    const review = { ...createAgentTemplate('review', { x: 0, y: 0 }), id: 'tpl-review', title: '最终把关' };
    expect(stepDelivery(review, 0).review).toBe(true);
    for (const title of ['试玩验收', 'Code review', '内容评审', 'QA']) expect(stepDelivery(step(title, 'markdown', 'x'), 0).review).toBe(true);
    for (const title of ['Preview page', '产品界面', '数据检查']) expect(stepDelivery(step(title, 'markdown', 'x'), 0).review).toBe(false);
    const only = step('试玩验收', 'markdown', '通过');
    expect(canvasResult({ nodes: [only], edges: [] }).final?.node.title).toBe('试玩验收');
  });

  it('keeps where a result came from: a run, a failed run’s capture, or a hand publication', () => {
    expect(stepDelivery(step('a', 'markdown', 'x'), 0).state).toBe('run');
    expect(stepDelivery(step('b', 'markdown', 'x', { partial: true }), 0).state).toBe('partial');
    expect(stepDelivery(step('c', 'markdown', 'x', { source: 'manual' }), 0).state).toBe('manual');
    expect(stepDelivery(step('d', 'markdown'), 0)).toMatchObject({ state: 'none', output: null, kind: null });
    // A production case copied with its run: real, but not run here.
    expect(stepDelivery(step('e', 'markdown', 'x', { source: 'case', model: 'qwen3.8-27b-p6' }), 0).state).toBe('case');
    expect(stepDelivery(step('f', 'markdown', 'x', { source: 'case', partial: true }), 0).state).toBe('partial');
  });

  it('counts only what a node published, not an earlier conversation’s result, and never an input form', () => {
    const talked = step('草稿', 'markdown', undefined, {}, { threads: [{ id: 't', title: 'Session', issueId: null, preview: '', draft: '', createdAt: 1, lastOutput: { text: '{"result":"old"}', at, source: 'run' } }] });
    const form = { ...createFormNode({ x: 0, y: 0 }), id: 'form', fields: [{ id: 'brief', label: '需求', value: '一个游戏' }] };
    const result = canvasResult({ nodes: [form, talked], edges: [wire(form, talked)] });
    expect(result.final).toBeNull();
    expect(result.stages[0][0]).toMatchObject({ input: true, state: 'none' });
  });

  it('calls the furthest delivered step what it is while later steps have delivered nothing', () => {
    const first = step('玩法与数值', 'markdown', '规格'); const second = step('像素美术', 'markdown'); const third = step('可玩试玩关', 'html');
    const result = canvasResult({ nodes: [first, second, third], edges: [wire(first, second), wire(second, third)] });
    expect(result.final?.node.title).toBe('玩法与数值');
    expect(result.pending.map(item => item.node.title)).toEqual(['像素美术', '可玩试玩关']);
  });

  it('reads a result that does not match its contract as text, and a media record as media', () => {
    const broken = { ...step('a', 'html'), lastOutput: { text: 'not json at all', at, source: 'run' as const } };
    expect(stepDelivery(broken, 0)).toMatchObject({ kind: 'text', text: 'not json at all' });
    const media = { ...createSessionNode('image', { x: 0, y: 0 }), id: 'img', title: '海报', contract: { version: 1 as const, inputs: [], outputs: [] },
      lastOutput: { text: JSON.stringify({ type: 'awwo.media', version: 1, kind: 'image', model: 'm', items: [{ artifactId: 'aAAAAAAAAAAA', name: 'p.png', contentType: 'image/png', size: 10 }] }), at, source: 'run' as const } };
    expect(stepDelivery(media, 0).kind).toBe('media');
  });

  it('takes a copied case’s complete recording as its result, and a rerun step over it', () => {
    const page = step('页面', 'html', '<!doctype html><html><head><title>p</title></head><body></body></html>', { source: 'case', model: 'm' });
    const notes = step('说明', 'markdown', '说明', { source: 'case', model: 'm' });
    const copied = canvasResult({ nodes: [page, notes], edges: [wire(page, notes)] });
    expect(copied).toMatchObject({ final: { state: 'case' }, complete: true, pending: [] });
    expect(copied.final?.node.title).toBe('页面');
  });

  it('never lets a failed run’s capture pass as delivered', () => {
    const form = { ...createFormNode({ x: 0, y: 0 }), id: 'brief', fields: [{ id: 'b', label: '需求', value: 'x' }] };
    const page = step('页面', 'html', '<!doctype html><html><head><title>p</title></head><body></body></html>');
    const guide = step('说明', 'markdown', '写了一半', { partial: true });
    const done = canvasResult({ nodes: [form, page, guide], edges: [wire(form, page), wire(page, guide)] });
    expect(done.final?.node.title).toBe('页面');
    // The guide after the page failed: the canvas still owes it, so the page is not yet the canvas's result.
    expect(done.pending.map(item => item.node.title)).toEqual(['说明']);
    expect(done.complete).toBe(false);
    const writer = step('初稿', 'markdown', '完整的初稿'); const editor = step('编辑', 'markdown', '改了一半', { partial: true });
    const edited = canvasResult({ nodes: [writer, editor], edges: [wire(writer, editor)] });
    expect(edited.final?.node.title).toBe('初稿');
    expect(edited.complete).toBe(false);
    const early = step('早期页面', 'html', '<!doctype html><html><head><title>a</title></head><body></body></html>');
    const late = step('最终页面', 'html', '<!doctype html><html><head><title>b</title></head><body></body></html>', { partial: true });
    expect(canvasResult({ nodes: [early, late], edges: [wire(early, late)] }).final?.node.title).toBe('早期页面');
    const alone = step('只有失败', 'markdown', '残留', { partial: true });
    expect(canvasResult({ nodes: [alone], edges: [] })).toMatchObject({ final: { state: 'partial' }, complete: false });
  });

  it('takes only an acceptance step fed by the result as its check', () => {
    const form = { ...createFormNode({ x: 0, y: 0 }), id: 'brief2', fields: [{ id: 'b', label: '需求', value: 'x' }] };
    const page = step('页面', 'html', '<!doctype html><html><head><title>p</title></head><body></body></html>');
    const research = step('调研', 'markdown', '调研'); const copy = step('文案', 'markdown', '文案'); const copyReview = step('文案评审', 'markdown', '通过');
    const result = canvasResult({ nodes: [form, page, research, copy, copyReview],
      edges: [wire(form, page), wire(form, research), wire(research, copy), wire(copy, copyReview)] });
    expect(result.final?.node.title).toBe('页面');
    expect(result.review).toBeNull();
  });

  it('knows the review policy’s reviewer and checks named the way people name them as acceptance steps', () => {
    const page = step('页面', 'html', '<!doctype html><html><head><title>p</title></head><body></body></html>');
    const check = step('最后看一眼', 'markdown', '没问题');
    const result = canvasResult({ nodes: [page, check], edges: [wire(page, check)],
      execution: { mode: 'review', maxRounds: 1, reviewerNodeId: check.id, verdictFieldId: 'result' } });
    expect(result.review?.node.title).toBe('最后看一眼');
    for (const title of ['体验与实现核对', '玩法回归', '数学与渲染核对']) expect(stepDelivery(step(title, 'markdown', 'x'), 0).review).toBe(true);
    for (const title of ['回归测试', '功能回归']) expect(stepDelivery(step(title, 'markdown', 'x'), 0).review).toBe(true);
    // Regression as analysis is a working step, not a check.
    for (const title of ['回归分析', '线性回归', '逻辑回归', '回归预测']) expect(stepDelivery(step(title, 'markdown', 'x'), 0).review).toBe(false);
  });

  it('keeps the layout depths it shares with arranging the canvas, cycles included', () => {
    const a = step('a', 'text'); const b = step('b', 'text'); const c = step('c', 'text');
    const depths = nodeDepths([a, b, c], [wire(a, b), wire(b, c), wire(c, b)]);
    expect(depths.get(a.id)).toBe(0);
    // b and c form a cycle: both share the step after everything else.
    expect(depths.get(b.id)).toBe(depths.get(c.id));
    expect(depths.get(b.id)).toBeGreaterThan(0);
  });
});
