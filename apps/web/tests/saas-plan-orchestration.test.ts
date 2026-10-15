import { afterEach, describe, expect, it } from 'vitest';
import { createAgentTemplate } from '../src/canvas/agentTemplates';
import { createFormNode, createSessionNode, emptyDocument, type CanvasDocument, type SessionNode } from '../src/canvas/canvasDoc';
import { applyCanvasPlan, CANVAS_PLAN_PROTOCOL, parseCanvasPlan, sharedRequirements, type CanvasPlanModels } from '../src/canvas/canvasPlan';
import { buildPlanningContext } from '../src/canvas/canvasPlanning';
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
    [{ type: 'add_node', ref: 'a', templateId: 'general', constraints: ['x'] }, '不允许字段「constraints」'],
  ])('refuses %j', (operation, message) => {
    expect(() => plan(operation)).toThrow(message);
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
