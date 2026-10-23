import { afterEach, describe, expect, it } from 'vitest';
import { createAgentTemplate } from '../src/canvas/agentTemplates';
import { createFormNode, createSessionNode, emptyDocument, type CanvasDocument, type SessionNode } from '../src/canvas/canvasDoc';
import { applyCanvasPlan, CANVAS_PLAN_PROTOCOL, condensedMark, hostedPagePersona, markPlanContextCondensed, parseCanvasPlan, PLAN_NOTES_SHOWN, sharedRequirements,
  type CanvasPlanModels } from '../src/canvas/canvasPlan';
import { buildPlanningContext } from '../src/canvas/canvasPlanning';
import { withAssistantModel } from '../src/canvas/assistantModel';
import { clearSaaSCanvas, configureSaaSCanvas } from '../src/saas/canvasBridge';

// What developer mode used to be opened for in the case tutorials (owner request 2026-10-15): every node's task
// requirements and its model, now set by the canvas assistant from the conversation.
afterEach(() => clearSaaSCanvas());
const tenant = { id: 'tenant', name: 'Workspace', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 10 } as const;
const plan = (...operations: unknown[]) => parseCanvasPlan({ version: 1, summary: 'S', operations });
const frame = (constraints: string[], acceptanceCriteria: string[] = []) => ({ version: 1 as const, source: 'manual' as const, constraints, acceptanceCriteria });
const agent = (id: string, extra: Partial<SessionNode> = {}): SessionNode => ({ ...createAgentTemplate('general', { x: 0, y: 0 }, 'en'), id, title: id, ...extra });
const doc = (...nodes: CanvasDocument['nodes']): CanvasDocument => ({ ...emptyDocument(), nodes });
const session = (value: CanvasDocument, id: string) => value.nodes.find(node => node.id === id) as SessionNode;
const models: CanvasPlanModels = { choices: [
  { runtime: 'pi', model: 'bedrock.claude-opus-5-5', available: true, name: 'Claude Opus 5.5', efforts: ['low', 'xhigh'] },
  { runtime: 'openai-agents', model: 'bedrock.claude-opus-5-5', available: true, name: 'Claude Opus 5.5', efforts: ['low', 'medium', 'high'] },
  { runtime: 'pi', model: 'qwen3.8-27b-p6', available: true, name: 'Qwen 3.8' },
  { runtime: 'openai-agents', model: 'gated-model', available: false, name: 'Gated' },
] };
const REQUEST = 'Build a pixel platformer with 3 levels and a boss; deliver one HTML page.';

describe('the protocol for task requirements and models', () => {
  it('parses set_task, set_model and acceptance criteria on a new node', () => {
    expect(plan({ type: 'set_task', nodeId: 'n', acceptanceCriteria: ['Opens in one file'] }).operations[0]).toEqual({ type: 'set_task', nodeId: 'n', acceptanceCriteria: ['Opens in one file'] });
    expect(plan({ type: 'set_task', nodeId: 'n', constraints: [] }).operations[0]).toEqual({ type: 'set_task', nodeId: 'n', constraints: [] });
    expect(plan({ type: 'set_model', nodeId: 'n', model: ' Claude Opus 5.5 ', effort: 'high' }).operations[0]).toEqual({ type: 'set_model', nodeId: 'n', model: 'Claude Opus 5.5', effort: 'high' });
    expect(plan({ type: 'set_model', nodeId: 'n', model: 'default', effort: '' }).operations[0]).toEqual({ type: 'set_model', nodeId: 'n', model: 'default' });
    expect(plan({ type: 'add_node', ref: 'a', templateId: 'frontend', acceptanceCriteria: ['One HTML page'] }).operations[0]).toMatchObject({ acceptanceCriteria: ['One HTML page'] });
    expect(plan({ type: 'add_node', ref: 'a', templateId: 'frontend', constraints: ['At most 2,000 words'] }).operations[0]).toMatchObject({ constraints: ['At most 2,000 words'] });
  });

  it.each([
    [{ type: 'set_task', nodeId: 'n' }, '没有要修改的任务要求'],
    [{ type: 'set_task', nodeId: 'n', constraints: 'one' }, 'constraints必须是数组'],
    [{ type: 'set_task', nodeId: 'n', acceptanceCriteria: Array(21).fill('x') }, '最多 20 项'],
    [{ type: 'set_task', nodeId: 'n', acceptanceCriteria: ['x'.repeat(2001)] }, '最多 2000 字符'],
    [{ type: 'set_task', nodeId: 'n', acceptanceCriteria: [3] }, '必须是字符串'],
    [{ type: 'set_task', nodeId: 'n', constraints: [], runtime: 'pi' }, '不允许字段「runtime」'],
    [{ type: 'set_model', nodeId: 'n', model: '' }, 'model必须是非空字符串'],
    [{ type: 'set_model', nodeId: 'n', model: 'qwen', effort: 'HIGH' }, '不是有效的思考强度档位'],
    [{ type: 'set_model', nodeId: 'n', model: 'qwen', runtime: 'pi' }, '不允许字段「runtime」'],
    [{ type: 'add_node', ref: 'a', templateId: 'general', constraints: 'x' }, 'constraints必须是数组'],
    [{ type: 'add_node', ref: 'a', templateId: 'general', model: 'qwen' }, '不允许字段「model」'],
  ])('refuses %j', (operation, message) => {
    expect(() => plan(operation)).toThrow(message);
  });

  it('asks for every new Agent node’s acceptance criteria in add_node’s own shape, still taking a plan without them', () => {
    // Production 2026-10-15 (qwen3.8-27b-p6): a plan added 「贪吃蛇游戏」 with none, though the instructions asked for one to
    // three in words: the shape the planner copies listed them last and optional. A plan that leaves them out applies as
    // before (the request stays its constraints).
    expect(CANVAS_PLAN_PROTOCOL).toContain('title?:string,acceptanceCriteria:string[],persona?:string,inputValues?:');
    expect(CANVAS_PLAN_PROTOCOL).not.toContain('inputValues?:{[已有输入字段ID]:string},acceptanceCriteria?:string[]}');
    expect(CANVAS_PLAN_PROTOCOL).toContain('新增 Agent 节点的 add_node 必须写 acceptanceCriteria：1 到 3 条');
    configureSaaSCanvas({ tenant, canvasId: 'canvas' });
    const hosted = buildPlanningContext(doc(), [], 'zh', ['image']);
    expect(hosted).toContain('不写 persona、constraints、acceptanceCriteria 和其他输入');
    // The rule sits after the add_node line and the media line that follows it.
    expect(hosted.indexOf('必须写 acceptanceCriteria')).toBeGreaterThan(hosted.indexOf('媒体节点（templateId'));
    const bare = applyCanvasPlan(doc(), plan({ type: 'add_node', ref: 'a', templateId: 'general', title: 'Writer' }), 'en', REQUEST);
    expect(session(bare.doc, bare.addedNodeIds[0]).taskFrame).toEqual(frame([REQUEST]));
  });

  it('still forbids runtime, model and effort outside set_model', () => {
    for (const key of ['runtime', 'model', 'effort']) expect(() => plan({ type: 'update_node', nodeId: 'n', title: 'T', [key]: 'x' })).toThrow(`不允许字段「${key}」`);
  });
});

describe('task requirements a plan sets', () => {
  it('gives a new node the request as constraints and the plan’s acceptance criteria', () => {
    const applied = applyCanvasPlan(emptyDocument(), plan({ type: 'add_node', ref: 'page', templateId: 'frontend', acceptanceCriteria: ['  One complete HTML page  ', ''] }), 'en', REQUEST);
    expect((applied.doc.nodes[0] as SessionNode).taskFrame).toEqual(frame([REQUEST], ['  One complete HTML page  ']));
    expect(applied.adjustments).toEqual([]);
  });

  it('keeps the request whole and leaves criteria out that would pass the limits', () => {
    const request = '界'.repeat(11000);
    const applied = applyCanvasPlan(emptyDocument(), plan({ type: 'add_node', ref: 'page', templateId: 'frontend', acceptanceCriteria: ['x'.repeat(1500)] }), 'zh', request);
    const taskFrame = (applied.doc.nodes[0] as SessionNode).taskFrame as ReturnType<typeof frame>;
    expect(taskFrame.constraints.join('')).toBe(request);
    expect(taskFrame.acceptanceCriteria).toEqual([]);
    expect(applied.adjustments).toEqual([expect.stringContaining('验收标准太长')]);
  });

  // 27 of the 40 plans of Claude Haiku 4.5 refused in the 7 days to 2026-10-23 gave a new node constraints on add_node;
  // the server took them from 2026-10-23. They come after the request, which every new node keeps first.
  it('gives a new node the plan’s own constraints after the request, expanded, once each', () => {
    const before = doc(agent('layout', { taskFrame: frame([REQUEST, 'Only data']) }), agent('style', { taskFrame: frame([REQUEST]) }));
    expect([...sharedRequirements(before)]).toEqual([['@R1', REQUEST]]);
    const applied = applyCanvasPlan(before, plan({ type: 'add_node', ref: 'page', templateId: 'frontend', acceptanceCriteria: ['One page'],
      constraints: ['@R1', 'At most 2,000 words', '@R7', 'At most 2,000 words'] }), 'en', REQUEST);
    expect(session(applied.doc, applied.addedNodeIds[0]).taskFrame).toEqual(frame([REQUEST, 'At most 2,000 words'], ['One page']));
    expect(applied.adjustments).toEqual([expect.stringContaining('“@R7”')]);
  });

  it('keeps the request whole and leaves a new node’s own constraints out that would pass the limits, its checks where they fit', () => {
    const request = '界'.repeat(11000);
    const alone = applyCanvasPlan(emptyDocument(), plan({ type: 'add_node', ref: 'page', templateId: 'frontend', constraints: ['y'.repeat(1500)] }), 'zh', request);
    const taskFrame = (alone.doc.nodes[0] as SessionNode).taskFrame as ReturnType<typeof frame>;
    expect(taskFrame.constraints.join('')).toBe(request);
    expect(alone.adjustments).toEqual([expect.stringContaining('的约束太长，没有写入')]);
    const withChecks = applyCanvasPlan(emptyDocument(), plan({ type: 'add_node', ref: 'page', templateId: 'frontend', constraints: ['y'.repeat(1500)],
      acceptanceCriteria: ['One page'] }), 'zh', request);
    const kept = (withChecks.doc.nodes[0] as SessionNode).taskFrame as ReturnType<typeof frame>;
    expect([kept.constraints.join(''), kept.acceptanceCriteria]).toEqual([request, ['One page']]);
    expect(withChecks.adjustments).toEqual([expect.stringContaining('的约束太长，没有写入')]);
    const neither = applyCanvasPlan(emptyDocument(), plan({ type: 'add_node', ref: 'page', templateId: 'frontend', constraints: ['y'.repeat(1500)],
      acceptanceCriteria: ['z'.repeat(1500)] }), 'zh', request);
    expect(((neither.doc.nodes[0] as SessionNode).taskFrame as ReturnType<typeof frame>).acceptanceCriteria).toEqual([]);
    expect(neither.adjustments).toEqual([expect.stringContaining('约束和验收标准太长')]);
    const withoutChecks = applyCanvasPlan(emptyDocument(), plan({ type: 'add_node', ref: 'page', templateId: 'frontend', constraints: ['Short'],
      acceptanceCriteria: ['z'.repeat(1500)] }), 'zh', request);
    const constraintsKept = (withoutChecks.doc.nodes[0] as SessionNode).taskFrame as ReturnType<typeof frame>;
    expect([constraintsKept.constraints.join(''), constraintsKept.acceptanceCriteria]).toEqual([request + 'Short', []]);
    expect(withoutChecks.adjustments).toEqual([expect.stringContaining('的验收标准太长，没有写入')]);
  });

  const media = { models: { image: 'xt.seedream-5-pro' }, promptMax: () => 32000 };
  it('says it leaves out constraints given to a media node, which has no task requirements', () => {
    const applied = applyCanvasPlan(emptyDocument(), plan({ type: 'add_node', ref: 'poster', templateId: 'image', inputValues: { prompt: 'a red car' },
      constraints: ['No logos or watermarks'] }), 'en', REQUEST, media);
    expect((applied.doc.nodes[0] as SessionNode).taskFrame).toBeUndefined();
    expect(applied.adjustments).toEqual([expect.stringContaining('the constraints given it were left out')]);
  });

  const unknown = (from: number) => Array.from({ length: 20 }, (_, i) => `@R${from + i}`);
  it('names in one note the requirement names new nodes were given that the canvas does not have, five nodes and the rest counted', () => {
    const roles = Array.from({ length: 6 }, (_, n) => ({ type: 'add_node' as const, ref: `role${n}`, templateId: 'general' as const,
      title: `Role ${n + 1}`, acceptanceCriteria: ['Done'], constraints: unknown(2) }));
    // A set_task on a node the plan adds says what it does not get in the same note, under the same node.
    const applied = applyCanvasPlan(emptyDocument(), plan(...roles, { type: 'set_task', nodeId: 'role0', constraints: ['@R40'] }), 'en', REQUEST);
    expect(applied.adjustments).toEqual(['Skipped constraints that name a requirement the canvas does not have: '
      + Array.from({ length: 5 }, (_, n) => `“@R2”, “@R3”, “@R4”, “@R5”, “@R6” and ${n ? 15 : 16} more on “Role ${n + 1}”`).join('; ') + '; and on 1 more node']);
    expect(session(applied.doc, applied.addedNodeIds[5]).taskFrame).toEqual(frame([REQUEST], ['Done']));
  });

  it('says each kind of what nodes the plan adds did not get first, from add_node and set_task alike, within the notes shown, past 100 other notes', () => {
    const request = '界'.repeat(11000);
    // set_task steps naming 20 requirements the canvas does not have on each of five nodes already on it: 100 notes.
    const before = doc(...['a', 'b', 'c', 'd', 'e'].map(id => agent(id)));
    const fillers = ['a', 'b', 'c', 'd', 'e'].map(id => ({ type: 'set_task' as const, nodeId: id, constraints: unknown(2) }));
    const shortened = plan(...fillers,
      { type: 'add_node', ref: 'poster', templateId: 'image', title: 'Poster', inputValues: { prompt: 'a red car' }, constraints: ['No watermarks'] },
      { type: 'add_node', ref: 'notes', templateId: 'general', title: 'Notes', acceptanceCriteria: ['Done'],
        constraints: ['Keep browser offline', condensedMark(5, 'en')] },
      { type: 'add_node', ref: 'page', templateId: 'frontend', title: 'Page', constraints: ['y'.repeat(1500)], acceptanceCriteria: ['z'.repeat(1500)] },
      { type: 'add_node', ref: 'odd', templateId: 'general', title: 'Odd', acceptanceCriteria: ['Done'], constraints: ['@R9'] },
      { type: 'set_task', nodeId: 'poster', acceptanceCriteria: ['No logos'] },
      { type: 'set_task', nodeId: 'notes', acceptanceCriteria: [condensedMark(5, 'en')] },
      { type: 'set_task', nodeId: 'odd', constraints: ['@R10'] });
    markPlanContextCondensed(shortened, new Map());
    const applied = applyCanvasPlan(before, shortened, 'en', request, media);
    expect(applied.adjustments.slice(0, 4)).toEqual([
      '“Poster” is a media node, which has no task requirements: the constraints and acceptance criteria given it were left out; put requirements in its prompt',
      'Added “Notes” without the constraints and acceptance criteria the plan gave it: that text copied text the plan saw only in part',
      'The constraints and acceptance criteria of “Page” were too long and were left out (task requirements allow 20 entries per list and 12000 characters in all)',
      'Skipped constraints that name a requirement the canvas does not have: “@R9” and “@R10” on “Odd”']);
    expect(applied.adjustments).toHaveLength(104);
    expect(4).toBeLessThanOrEqual(PLAN_NOTES_SHOWN);
    expect(session(applied.doc, applied.addedNodeIds[1]).taskFrame).toEqual(frame([request.slice(0, 2000), request.slice(2000, 4000),
      request.slice(4000, 6000), request.slice(6000, 8000), request.slice(8000, 10000), request.slice(10000)], ['Done']));
  });

  it('keeps the request first on a node the plan adds when a set_task gives it constraints', () => {
    const applied = applyCanvasPlan(emptyDocument(), plan({ type: 'add_node', ref: 'writer', templateId: 'general', acceptanceCriteria: ['Done'],
      constraints: ['Use the brand voice'] }, { type: 'set_task', nodeId: 'writer', constraints: ['At most 2,000 words', REQUEST] }), 'en', REQUEST);
    expect(session(applied.doc, applied.addedNodeIds[0]).taskFrame).toEqual(frame([REQUEST, 'At most 2,000 words'], ['Done']));
    expect(applied.adjustments).toEqual([]);
  });

  it('keeps a new node’s constraints over its checks where either alone fits, if they name a shared requirement', () => {
    // A shared requirement the canvas holds (on two nodes), named @R1.
    const brief = 'b'.repeat(2000);
    const before = doc(agent('a', { taskFrame: frame([brief]) }), agent('b', { taskFrame: frame([brief]) }));
    const request = '界'.repeat(9000);
    const add = (constraints: string[]) => applyCanvasPlan(before, plan({ type: 'add_node', ref: 'part', templateId: 'general', title: 'Part',
      constraints, acceptanceCriteria: ['c'.repeat(1500)] }), 'en', request);
    const named = add(['@R1']);
    expect(session(named.doc, named.addedNodeIds[0]).taskFrame).toEqual(frame([...frame([request.slice(0, 2000), request.slice(2000, 4000),
      request.slice(4000, 6000), request.slice(6000, 8000), request.slice(8000)]).constraints, brief]));
    expect(named.adjustments).toEqual([expect.stringContaining('The acceptance criteria of “Part” were too long')]);
    const own = add(['x'.repeat(2000)]);
    expect(session(own.doc, own.addedNodeIds[0]).taskFrame).toEqual(frame([request.slice(0, 2000), request.slice(2000, 4000),
      request.slice(4000, 6000), request.slice(6000, 8000), request.slice(8000)], ['c'.repeat(1500)]));
    expect(own.adjustments).toEqual([expect.stringContaining('The constraints of “Part” were too long')]);
    // The shared requirement written out instead of named counts as the user's words too.
    const written = add([brief]);
    expect(session(written.doc, written.addedNodeIds[0]).taskFrame?.constraints).toEqual([...frame([request.slice(0, 2000),
      request.slice(2000, 4000), request.slice(4000, 6000), request.slice(6000, 8000), request.slice(8000)]).constraints, brief]);
  });

  it('keeps the checks where the shared requirement a new node’s constraints name is the request it already holds', () => {
    // A resent request: the canvas holds it on two nodes, so @R1 is the request's own text, and it is the node's first
    // constraint already.
    const request = 'r'.repeat(2000);
    const before = doc(agent('a', { taskFrame: frame([request]) }), agent('b', { taskFrame: frame([request]) }));
    const applied = applyCanvasPlan(before, plan({ type: 'add_node', ref: 'part', templateId: 'general', title: 'Part',
      constraints: ['@R1', ...Array.from({ length: 4 }, (_, i) => `${i}`.repeat(2000))], acceptanceCriteria: ['c'.repeat(2000), 'd'.repeat(1000)] }), 'en', request);
    expect(session(applied.doc, applied.addedNodeIds[0]).taskFrame).toEqual(frame([request], ['c'.repeat(2000), 'd'.repeat(1000)]));
    expect(applied.adjustments).toEqual([expect.stringContaining('The constraints of “Part” were too long')]);
  });

  it('says a media node’s acceptance criteria are left out too, counts a list’s entries, and names no node the plan removes again', () => {
    expect(applyCanvasPlan(emptyDocument(), plan({ type: 'add_node', ref: 'shot', templateId: 'image', title: 'Shot', inputValues: { prompt: 'a red car' },
      acceptanceCriteria: ['No watermarks'] }), 'en', REQUEST, media).adjustments).toEqual([
      '“Shot” is a media node, which has no task requirements: the acceptance criteria given it were left out; put requirements in its prompt']);
    const many = applyCanvasPlan(emptyDocument(), plan({ type: 'add_node', ref: 'page', templateId: 'frontend', title: 'Page',
      constraints: Array.from({ length: 20 }, (_, i) => `Rule ${i + 1}`) }), 'en', 'R');
    expect(many.adjustments).toEqual(['The constraints of “Page” were too long and were left out (task requirements allow 20 entries per list and 12000 characters in all)']);
    expect(session(many.doc, many.addedNodeIds[0]).taskFrame).toEqual(frame(['R']));
    expect(applyCanvasPlan(emptyDocument(), plan({ type: 'add_node', ref: 'shot', templateId: 'image', inputValues: { prompt: 'a red car' },
      constraints: ['No watermarks'] }, { type: 'remove_node', nodeId: 'shot' }), 'en', REQUEST, media).adjustments).toEqual([]);
  });

  it('names in one note the new nodes whose lists copied shortened text', () => {
    const shortened = plan(...['A', 'B'].map(title => ({ type: 'add_node', ref: title.toLowerCase(), templateId: 'general', title,
      acceptanceCriteria: title === 'A' ? ['Done'] : [condensedMark(5, 'en')], constraints: [condensedMark(5, 'en')] })));
    markPlanContextCondensed(shortened, new Map());
    expect(applyCanvasPlan(emptyDocument(), shortened, 'en', REQUEST).adjustments).toEqual([
      'Added “A” without its constraints and “B” without its constraints and acceptance criteria: the text the plan gave them copied text it saw only in part']);
    expect(applyCanvasPlan(emptyDocument(), shortened, 'zh', REQUEST).adjustments).toEqual([
      '新增的「A」没有写入约束、「B」没有写入约束和验收标准：方案给的内容抄了只显示了开头的文字']);
  });

  it('names in one note the new nodes whose lists were too long, five of them and the rest counted', () => {
    const request = '界'.repeat(11000);
    const long = Array.from({ length: 7 }, (_, n) => ({ type: 'add_node' as const, ref: `page${n}`, templateId: 'frontend' as const, title: `Page ${n + 1}`,
      constraints: n % 2 ? ['y'.repeat(1500)] : ['Short'], acceptanceCriteria: n % 2 ? ['One page'] : ['z'.repeat(1500)] }));
    expect(applyCanvasPlan(emptyDocument(), plan(...long.slice(0, 2)), 'en', request).adjustments).toEqual([
      'The acceptance criteria of “Page 1” and the constraints of “Page 2” were too long and were left out (task requirements allow 20 entries per list and 12000 characters in all)']);
    expect(applyCanvasPlan(emptyDocument(), plan(...long), 'zh', request).adjustments).toEqual([
      '「Page 1」的验收标准、「Page 2」的约束、「Page 3」的验收标准、「Page 4」的约束、「Page 5」的验收标准等 7 个节点的任务要求太长，没有写入（每个列表最多 20 条，合计最多 12000 字）']);
  });

  it('names the media nodes given constraints in one note, five of them and the rest counted', () => {
    const images = (count: number) => Array.from({ length: count }, (_, n) => ({ type: 'add_node' as const, ref: `img${n}`, templateId: 'image' as const,
      title: `Shot ${n + 1}`, inputValues: { prompt: 'a red car' }, constraints: ['No watermarks'] }));
    expect(applyCanvasPlan(emptyDocument(), plan(...images(2)), 'en', REQUEST, media).adjustments).toEqual([
      '“Shot 1” and “Shot 2” are media nodes, which have no task requirements: the constraints given them were left out; put requirements in their prompts']);
    expect(applyCanvasPlan(emptyDocument(), plan(...images(7)), 'zh', REQUEST, media).adjustments).toEqual([
      '「Shot 1」、「Shot 2」、「Shot 3」、「Shot 4」、「Shot 5」等 7 个节点是媒体节点，没有任务要求：给它们的约束没有写入，要求请写进各自的提示词']);
  });

  it('replaces only the lists it gives, expanding a shared requirement’s name and refusing an unknown one', () => {
    const before = doc(agent('layout', { taskFrame: frame([REQUEST, 'Only data']) }), agent('page', { taskFrame: frame([REQUEST], ['Old check']) }));
    expect([...sharedRequirements(before)]).toEqual([['@R1', REQUEST]]);
    const applied = applyCanvasPlan(before, plan(
      { type: 'set_task', nodeId: 'page', acceptanceCriteria: ['All three levels are reachable', 'The boss can be beaten'] },
      { type: 'set_task', nodeId: 'layout', constraints: ['@R1', 'Write the level layout as constants', '@R7'] },
    ), 'en');
    expect(session(applied.doc, 'page').taskFrame).toEqual(frame([REQUEST], ['All three levels are reachable', 'The boss can be beaten']));
    expect(session(applied.doc, 'layout').taskFrame).toEqual(frame([REQUEST, 'Write the level layout as constants']));
    expect(applied.adjustments).toEqual([expect.stringContaining('“@R7”')]);
  });

  it('says why it leaves a media node, a form or an oversized frame alone', () => {
    const image = { ...createSessionNode('image', { x: 0, y: 0 }), id: 'img', title: 'Cover' } as SessionNode;
    const form = { ...createFormNode({ x: 0, y: 0 }), id: 'form', title: 'Brief' };
    const before = doc(image, form, agent('page'), agent('odd', { taskFrame: { version: 2, rules: [] } }));
    const applied = applyCanvasPlan(before, plan(
      { type: 'set_task', nodeId: 'img', acceptanceCriteria: ['x'] },
      { type: 'set_task', nodeId: 'form', acceptanceCriteria: ['x'] },
      { type: 'set_task', nodeId: 'page', constraints: Array(6).fill('y'.repeat(2000)), acceptanceCriteria: ['z'] },
      { type: 'set_task', nodeId: 'odd', acceptanceCriteria: ['x'] },
    ), 'zh');
    expect(applied.adjustments).toEqual([expect.stringContaining('只有 Agent 节点'), expect.stringContaining('只有 Agent 节点'),
      expect.stringContaining('超过了长度限制'), expect.stringContaining('版本不能在这里修改')]);
    expect(session(applied.doc, 'page').taskFrame).toBeUndefined();
    expect(session(applied.doc, 'odd').taskFrame).toEqual({ version: 2, rules: [] });
  });
});

describe('models a plan sets', () => {
  it('puts a node on the model it names, by id or by name, on the runtime AwwO runs it on', () => {
    const before = doc(agent('page', { runtime: 'pi', model: 'qwen3.8-27b-p6' }), agent('review'));
    const applied = applyCanvasPlan(before, plan(
      { type: 'set_model', nodeId: 'page', model: 'claude opus 5.5', effort: 'high' },
      { type: 'set_model', nodeId: 'review', model: 'bedrock.claude-opus-5-5', effort: 'xhigh' },
    ), 'en', '', undefined, models);
    expect(session(applied.doc, 'page')).toMatchObject({ runtime: 'openai-agents', model: 'bedrock.claude-opus-5-5', effort: 'high' });
    // xhigh is only Pi's level: the node runs the model's default effort, and the reply says so.
    expect(session(applied.doc, 'review')).toMatchObject({ runtime: 'openai-agents', model: 'bedrock.claude-opus-5-5', effort: '' });
    expect(applied.adjustments).toEqual([expect.stringContaining('no “xhigh” reasoning effort')]);
  });

  it('goes back to the workspace default, and refuses a model it cannot run', () => {
    const before = doc(agent('page', { runtime: 'openai-agents', model: 'bedrock.claude-opus-5-5', effort: 'high' }), agent('other'));
    const applied = applyCanvasPlan(before, plan(
      { type: 'set_model', nodeId: 'page', model: 'DEFAULT' },
      { type: 'set_model', nodeId: 'other', model: 'gated-model' },
      { type: 'set_model', nodeId: 'other', model: 'made-up' },
    ), 'en', '', undefined, models);
    expect(session(applied.doc, 'page')).toMatchObject({ runtime: '', model: '', effort: '' });
    expect(session(applied.doc, 'other')).toMatchObject({ runtime: '', model: '' });
    expect(applied.adjustments).toEqual([expect.stringContaining('“gated-model”'), expect.stringContaining('“made-up”')]);
  });

  it('leaves media nodes, teams and workspace Agents on their own models, and changes nothing without a catalogue', () => {
    const image = { ...createSessionNode('image', { x: 0, y: 0 }), id: 'img', title: 'Cover' } as SessionNode;
    const team = agent('team', { team: { version: 1, mode: 'sequential', members: [] } as unknown as SessionNode['team'] });
    const shared = agent('shared', { agentRef: { source: 'workspace', agentId: 'a' } });
    const before = doc(image, team, shared, agent('page'));
    const ops = ['img', 'team', 'shared'].map(nodeId => ({ type: 'set_model', nodeId, model: 'Qwen 3.8' }));
    const applied = applyCanvasPlan(before, plan(...ops), 'en', '', undefined, models);
    expect(applied.adjustments).toHaveLength(3);
    expect(applyCanvasPlan(before, plan({ type: 'set_model', nodeId: 'page', model: 'Qwen 3.8' }), 'en').adjustments).toEqual([expect.stringContaining('no such model ready')]);
    expect(session(applyCanvasPlan(before, plan(...ops), 'en', '', undefined, models).doc, 'img').model).toBe(image.model);
  });

  it('sets a model on a node the same plan adds, which the assistant’s own model then leaves alone', () => {
    const applied = applyCanvasPlan(emptyDocument(), plan(
      { type: 'add_node', ref: 'page', templateId: 'frontend' },
      { type: 'set_model', nodeId: 'page', model: 'Qwen 3.8' },
    ), 'en', REQUEST, undefined, models);
    expect(applied.doc.nodes[0]).toMatchObject({ runtime: 'pi', model: 'qwen3.8-27b-p6' });
    expect(applied.modelSetNodeIds).toEqual(applied.addedNodeIds);
  });

  it('keeps a new node the plan put on the workspace default there, though the assistant runs another model (Codex review)', () => {
    const applied = applyCanvasPlan(emptyDocument(), plan(
      { type: 'add_node', ref: 'page', templateId: 'frontend' },
      { type: 'add_node', ref: 'copy', templateId: 'materials' },
      { type: 'set_model', nodeId: 'page', model: 'default' },
    ), 'en', REQUEST, undefined, models);
    const [page, copy] = applied.addedNodeIds;
    expect(applied.modelSetNodeIds).toEqual([page]);
    // As the hosted canvas applies it (CanvasSurface): the assistant's model goes only to the nodes the plan left unset.
    const assistant = { runtime: 'openai-agents', model: 'bedrock.claude-opus-5-5' };
    const choices = models.choices.map(choice => ({ runtime: choice.runtime, model: choice.model, available: choice.available }));
    const doc = withAssistantModel(applied.doc, applied.addedNodeIds.filter(id => !applied.modelSetNodeIds.includes(id)), assistant, choices);
    expect(session(doc, page)).toMatchObject({ runtime: '', model: '' });
    expect(session(doc, copy)).toMatchObject({ runtime: 'openai-agents', model: 'bedrock.claude-opus-5-5' });
  });

  it('counts a model name in characters, as the plan gate does', () => {
    expect(plan({ type: 'set_model', nodeId: 'n', model: `m${'🙂'.repeat(199)}` }).operations[0]).toMatchObject({ type: 'set_model' });
    expect(() => plan({ type: 'set_model', nodeId: 'n', model: `m${'🙂'.repeat(200)}` })).toThrow('最多 200 字符');
  });
});

describe('what the planner is shown', () => {
  it('shows each node’s requirements, shared ones once by name, its model and its last run where it can act on them', () => {
    configureSaaSCanvas({ tenant, canvasId: 'canvas' });
    const before = doc(
      agent('layout', { taskFrame: frame([REQUEST, 'Only data'], ['Has 3 levels']), model: 'bedrock.claude-opus-5-5', lastOutput: { text: 'x', at: 1, source: 'run' } }),
      agent('page', { taskFrame: frame([REQUEST]) }),
    );
    const context = buildPlanningContext(before, [], 'en', [], {
      models: [{ id: 'bedrock.claude-opus-5-5', name: 'Claude Opus 5.5', efforts: ['low', 'high'], paid: true }, { id: 'qwen3.8-27b-p6', name: 'Qwen 3.8' }],
      runs: { page: { state: 'failed', detail: 'The run output exceeds the limit. Reduce the task scope.' }, layout: { state: 'done', detail: 'ignored' } },
    });
    expect(context).toContain(`"requirements":{"@R1":${JSON.stringify(REQUEST)}}`);
    expect(context).toContain('"constraints":["@R1","Only data"],"acceptanceCriteria":["Has 3 levels"],"model":"bedrock.claude-opus-5-5"');
    expect(context).toContain('"delivered":true,"run":{"state":"done"}');
    expect(context).toContain('"constraints":["@R1"],"model":"default"');
    expect(context).toContain('"run":{"state":"failed","detail":"The run output exceeds the limit. Reduce the task scope."}');
    expect(context).toContain('[{"id":"bedrock.claude-opus-5-5","name":"Claude Opus 5.5","efforts":["low","high"],"paid":true},{"id":"qwen3.8-27b-p6","name":"Qwen 3.8"}]');
    expect(context).toContain('set_model: {type:"set_model"');
    // A hosted planner has its briefing and sizing rules in its server instructions (planning.go), not in this context.
    expect(context).not.toContain('acceptanceCriteria in add_node');
    // The request appears once, in the table, not once per node.
    expect(context.split(REQUEST).length - 1).toBe(1);
  });

  it('tells a local planner how to brief its nodes and fix a failure, without set_model', () => {
    const context = buildPlanningContext(doc(agent('page')), [], 'en', [], { runs: { page: { state: 'failed', detail: 'Timed out' } } });
    expect(context).toContain('Give every Agent node you add 1–3 acceptanceCriteria in add_node');
    expect(context).toContain('To fix a failed node');
    expect(context).not.toContain('set_model');
    expect(context).toContain('"run":{"state":"failed","detail":"Timed out"}');
  });

  it('offers no set_model and shows no model where the host offers no models', () => {
    configureSaaSCanvas({ tenant, canvasId: 'canvas' });
    const context = buildPlanningContext(doc(agent('page', { model: 'x' })), [], 'zh');
    expect(context).not.toContain('set_model: {');
    expect(context).not.toContain('"model":');
    expect(context).toContain('set_task: {type:"set_task"');
    expect(CANVAS_PLAN_PROTOCOL).toContain('set_model: {type:"set_model"');
  });
});

// Every case tutorial turned the page's node into one html output by hand; a 27B planner given the rule in words still
// left the frontend template's three markdown/file outputs (local planner check, 2026-10-15). On a hosted canvas the
// frontend node is the page itself, as the planner is shown it and as a plan makes it.
describe('a page on a hosted canvas', () => {
  const page = plan(
    { type: 'add_node', ref: 'game', templateId: 'frontend', title: 'Snake' },
    { type: 'add_node', ref: 'check', templateId: 'review', title: 'Play test' },
    { type: 'connect', fromNode: 'game', fromField: 'page', toNode: 'check', toField: 'delivery' },
  );

  it('makes a plan’s frontend node deliver one html page, with a brief for a page, wired on by that page', () => {
    const applied = applyCanvasPlan(doc(), page, 'en', REQUEST, undefined, undefined, true);
    const game = applied.doc.nodes.find(node => node.id === applied.addedNodeIds[0]) as SessionNode;
    expect(game.contract!.outputs.map(field => [field.id, field.type, field.required])).toEqual([['page', 'html', true]]);
    expect(game.persona).toBe(hostedPagePersona('en'));
    expect(game.persona).toContain('one complete HTML file');
    expect(game.contract!.inputs.map(field => field.id)).toEqual(['api', 'screens', 'design', 'assets']);
    expect(applied.doc.edges).toEqual([expect.objectContaining({ fromNode: game.id, fromPort: 'out:page', toNode: applied.addedNodeIds[1] })]);
    expect(applied.adjustments).toEqual([]);
    // A persona the plan writes is the node's brief.
    const briefed = applyCanvasPlan(doc(), plan({ type: 'add_node', ref: 'game', templateId: 'frontend', persona: 'A snake game.' }), 'zh', REQUEST, undefined, undefined, true);
    expect((briefed.doc.nodes[0] as SessionNode).persona).toBe('A snake game.');
    expect((briefed.doc.nodes[0] as SessionNode).contract!.outputs.map(field => field.label)).toEqual(['网页']);
  });

  it('keeps the frontend template elsewhere: off a hosted canvas, and on a frontend node already on the canvas', () => {
    const local = applyCanvasPlan(doc(), plan({ type: 'add_node', ref: 'game', templateId: 'frontend' }), 'en', REQUEST);
    expect((local.doc.nodes[0] as SessionNode).contract!.outputs.map(field => field.id)).toEqual(['delivery', 'preview', 'checks']);
    const existing = { ...createAgentTemplate('frontend', { x: 0, y: 0 }, 'en'), id: 'old' } as SessionNode;
    const renamed = applyCanvasPlan(doc(existing), plan({ type: 'update_node', nodeId: 'old', title: 'Shop' }), 'en', REQUEST, undefined, undefined, true);
    expect(session(renamed.doc, 'old').contract!.outputs.map(field => field.id)).toEqual(['delivery', 'preview', 'checks']);
  });

  it('shows the hosted planner a frontend node as that page, and a local planner the template', () => {
    configureSaaSCanvas({ tenant, canvasId: 'canvas' });
    const hosted = buildPlanningContext(doc(), [], 'en');
    expect(hosted).toContain('"id":"frontend","title":"Frontend development","responsibility":"Delivers one page that works when opened');
    expect(hosted).toContain('"outputs":[{"id":"page","label":"Page","type":"html","required":true}]');
    clearSaaSCanvas();
    const local = buildPlanningContext(doc(), [], 'en');
    expect(local).not.toContain('"id":"page","label":"Page"');
    expect(local).toContain('{"id":"delivery"');
  });
});
