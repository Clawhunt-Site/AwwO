import { describe, expect, it, vi } from 'vitest';
import { applyCanvasPlan, CANVAS_PLAN_NODE_OPERATION_TYPES, CANVAS_PLAN_OPERATION_TYPES, condensedMark, markPlanContextCondensed, markPlanOffersTeams, parseCanvasPlan, planContextOffersTeams, planOffersTeams, type CanvasPlan } from '../src/canvas/canvasPlan';
import { buildPlanningContext, fitPlanningContext, utf8Bytes } from '../src/canvas/canvasPlanning';
import { createAgentTemplate } from '../src/canvas/agentTemplates';
import { createFormNode, createSessionNode, emptyDocument, type CanvasDocument, type CanvasNode, type SessionNode } from '../src/canvas/canvasDoc';
import { createNodeTeam, validateNodeTeam } from '../src/canvas/nodeTeam';
import { NODE_TEAM_TEMPLATE_IDS, createNodeTeamFromTemplate, nodeTeamTemplate } from '../src/canvas/nodeTeamTemplates';
import { describePlanChanges } from '../src/canvas/planChanges';
import { canvasText, type CanvasTranslate } from '../src/canvas/i18n';
import { clearSaaSCanvas, configureSaaSCanvas } from '../src/saas/canvasBridge';

vi.mock('../src/chatAutomations', () => ({ gatewayApiBase: () => '/fixture-gateway' }));

const plan = (...operations: unknown[]): CanvasPlan => ({ version: 1, summary: '配团队', operations }) as CanvasPlan;
/** A plan whose request offered set_team, as requestCanvasPlan marks one. */
const offered = (...operations: unknown[]): CanvasPlan => { const value = plan(...operations); markPlanOffersTeams(value); return value; };
const member = (name: string, patch: object = {}) => ({ name, role: 'r', ...patch });
const custom = (members: unknown[], patch: object = {}) => ({ type: 'set_team', nodeId: 'writer', mode: 'review', members, ...patch });
const template = (id = 'draft-review', nodeId = 'writer') => ({ type: 'set_team', nodeId, template: id });
function agent(id = 'writer', patch: Partial<SessionNode> = {}): SessionNode {
  return { ...createAgentTemplate('general', { x: 0, y: 0 }), id, title: '撰写', runtime: 'pi', model: 'model-a', ...patch };
}
const doc = (...nodes: CanvasNode[]): CanvasDocument => ({ ...emptyDocument(), nodes });
const apply = (document: CanvasDocument, value: CanvasPlan, teams = true, locale: 'zh' | 'en' = 'zh') => {
  markPlanOffersTeams(value);
  return applyCanvasPlan(document, value, locale, '', undefined, undefined, false, false, teams);
};
const teamOf = (document: CanvasDocument, id = 'writer') => (document.nodes.find(node => node.id === id) as SessionNode).team;
const translate = (locale: 'zh' | 'en'): CanvasTranslate => (key, values) => canvasText(locale, key, values);

describe('set_team in the plan protocol', () => {
  it('is an operation that concerns one node', () => {
    expect(CANVAS_PLAN_OPERATION_TYPES.has('set_team')).toBe(true);
    expect(CANVAS_PLAN_NODE_OPERATION_TYPES.has('set_team')).toBe(true);
  });

  it('reads a template and a written team, trimming names and roles and defaulting the instructions', () => {
    expect(parseCanvasPlan(plan(template('debate-verdict'))).operations[0]).toEqual({ type: 'set_team', nodeId: 'writer', template: 'debate-verdict' });
    expect(parseCanvasPlan(plan(custom([member(' 撰写 ', { role: ' 写 ' }), member('审核', { instructions: '只看事实' })], { maxRounds: 3 }))).operations[0])
      .toEqual({ type: 'set_team', nodeId: 'writer', mode: 'review', maxRounds: 3, members: [{ name: '撰写', role: '写', instructions: '' }, { name: '审核', role: 'r', instructions: '只看事实' }] });
  });

  it.each([
    ['an unknown template', template('general')],
    ['a template beside members', { ...template(), mode: 'review', members: [member('a'), member('b')] }],
    ['a model on the step', { ...custom([member('a'), member('b')]), model: 'model-a' }],
    ['a model on a member', custom([member('a', { model: 'model-a' }), member('b')])],
    ['a runtime on a member', custom([member('a', { runtime: 'pi' }), member('b')])],
    ['tools on a member', custom([member('a', { tools: ['calculator'] }), member('b')])],
    ['an unknown mode', custom([member('a')], { mode: 'swarm' })],
    ['a fractional round count', custom([member('a'), member('b')], { maxRounds: 1.5 })],
    ['nine rounds', custom([member('a'), member('b')], { maxRounds: 9 })],
    ['no members', custom([])],
    ['nine members', custom(Array.from({ length: 9 }, (_, index) => member(`m${index}`)), { mode: 'parallel' })],
    ['a review of one', custom([member('a')])],
    ['the same name twice', custom([member('a'), member(' a ')])],
    ['a blank name', custom([member(' '), member('b')])],
    ['a blank role', custom([member('a', { role: ' ' }), member('b')])],
    ['a name over 128 characters', custom([member('名'.repeat(129)), member('b')])],
    ['a role over 512 characters', custom([member('a', { role: 'r'.repeat(513) }), member('b')])],
    ['instructions over 16000 characters', custom([member('a', { instructions: 'i'.repeat(16001) }), member('b')])],
  ])('refuses %s', (_, op) => {
    expect(() => parseCanvasPlan(plan(op))).toThrow(/画布方案/);
  });

  // The same cases as planning_team_test.go TestPlanGateTrimsTeamNamesAsTheCanvasDoes: the gate trims as this trims.
  it.each([
    ['a byte order mark repeats a name', ['A', '\uFEFFA'], false],
    ['an ideographic space is blank', ['\u3000'], false],
    ['a line separator is blank', ['\u2028'], false],
    ['a next-line character is a character', ['\u0085'], true],
    ['a next-line character makes another name', ['A', '\u0085A'], true],
    ['no-break spaces trim', ['A', '\u00a0A\u00a0'], false],
  ])('trims names as the plan gate does: %s', (_, names, admit) => {
    const read = () => parseCanvasPlan(plan({ type: 'set_team', nodeId: 'writer', mode: 'sequential', members: (names as string[]).map(name => member(name)) }));
    if (admit) expect(read).not.toThrow();
    else expect(read).toThrow(/画布方案/);
  });

  // The editor judges a saved team as the gate and the API do (teams.go validateTeam with jsTrim).
  it.each([
    ['a next-line character names a member', '\u0085', true],
    ['a byte order mark is blank', '\uFEFF', false],
    ['an ideographic space is blank', '\u3000', false],
    ['a line separator is blank', '\u2028', false],
  ])('judges a saved team as the API does: %s', (_, name, valid) => {
    const team = createNodeTeam(agent());
    const issues = validateNodeTeam({ ...team, members: [{ ...team.members[0], name }, { ...team.members[1], role: name }] });
    expect(issues.length === 0).toBe(valid);
  });

  it('counts a member’s text in characters, as the plan gate counts it', () => {
    expect(() => parseCanvasPlan(plan(custom([member('😀'.repeat(128)), member('b')])))).not.toThrow();
  });
});

describe('applying set_team', () => {
  it('gives an Agent node a template team on its runtime, its members on the node’s model', () => {
    const before = doc(agent('writer', { runtime: 'openai-agents', model: 'agents-model' }));
    const applied = apply(before, plan(template()));
    const team = teamOf(applied.doc)!;
    expect(team).toMatchObject({ mode: 'review', runtime: 'openai-agents', maxRounds: 2, maxTurns: 4 });
    expect(team.members.map(item => item.name)).toEqual(nodeTeamTemplate('draft-review')!.zh.members.map(item => item.name));
    expect(team.members.every(item => item.model === '' && item.runtime === '' && item.tools.length === 0)).toBe(true);
    expect(validateNodeTeam(team)).toEqual([]);
    expect(applied.adjustments).toEqual([]);
    expect(teamOf(before)).toBeUndefined();
  });

  it('writes the members a plan gives, in its language, with the rounds it names', () => {
    const existing = agent(); existing.team = { ...createNodeTeam(existing), mode: 'debate', maxRounds: 2 };
    const applied = apply(doc(existing), plan(custom([member('甲', { role: '正方' }), member('乙', { role: '反方' })], { mode: 'debate', maxRounds: 4 })));
    expect(teamOf(applied.doc)).toMatchObject({ mode: 'debate', maxRounds: 4, maxTurns: 9 });
    const english = apply(doc(agent()), plan(template('translate-review')), true, 'en');
    expect(teamOf(english.doc)!.members.map(item => item.name)).toEqual(['Translator', 'Reviewer']);
  });

  it('replaces a team keeping a same-name member’s own model, and says who left with one of their own', () => {
    const existing = agent(); const team = createNodeTeam(existing);
    existing.team = { ...team, members: [{ ...team.members[0], name: '撰写者', model: 'model-b' }, { ...team.members[1], name: '旧审核', model: 'model-c' }] };
    const applied = apply(doc(existing), plan(template()));
    const next = teamOf(applied.doc)!;
    expect(next.members.map(item => [item.name, item.model])).toEqual([['撰写者', 'model-b'], ['审核者', '']]);
    expect(next.members[0].id).toBe(existing.team.members[0].id);
    expect(applied.adjustments).toEqual(['「撰写」换了团队成员：原来单独选了模型的「旧审核」不在新团队里']);
  });

  it.each([
    ['a host that runs no teams', () => doc(agent()), false, '没有给「撰写」配团队：此工作区现在没有能运行协作团队的执行引擎'],
    ['a workspace Agent', () => doc(agent('writer', { agentRef: { source: 'workspace', agentId: 'agent-1' } })), true, '没有给「撰写」配团队：它使用工作区 Agent，按那个 Agent 的设置运行'],
    ['a media node', () => doc({ ...createSessionNode('image', { x: 0, y: 0 }), id: 'writer', title: '撰写' }), true, '没有给「撰写」配团队：只有 Agent 节点能配协作团队'],
    ['a form', () => doc({ ...createFormNode({ x: 0, y: 0 }), id: 'writer', title: '撰写' }), true, '没有给「撰写」配团队：只有 Agent 节点能配协作团队'],
  ])('leaves %s as it is and says why', (_, make, teams, note) => {
    const before = make();
    const applied = apply(before, plan(template()), teams);
    expect(applied.doc.nodes).toEqual(before.nodes);
    expect(applied.adjustments).toEqual([note]);
  });

  it('leaves a sandbox node, which runs one Agent in its sandbox computer', () => {
    const before = doc(agent('writer', { runtime: 'sandbox', model: 'box' }));
    const applied = apply(before, plan(template()));
    expect(applied.doc.nodes).toEqual(before.nodes);
    expect(applied.adjustments).toEqual(['没有给「撰写」配团队：它在沙箱电脑里运行，只能是单个 Agent']);
  });

  it('puts a new team where its node runs, never where a health check happened to answer', () => {
    expect(teamOf(apply(doc(agent('writer', { runtime: 'pi' })), plan(template())).doc)?.runtime).toBe('pi');
    expect(teamOf(apply(doc(agent('writer', { runtime: 'openai-agents' })), plan(template())).doc)?.runtime).toBe('openai-agents');
    // A node without a runtime runs where the API resolves it (defaultRuntime), and so does its team.
    expect(teamOf(apply(doc(agent('writer', { runtime: '' })), plan(template())).doc)?.runtime).toBe('openai-agents');
  });

  it('lets a later set_model move a team this plan gave a node, as if the model had been set first', () => {
    const choices = { choices: [{ runtime: 'pi', model: 'pi-model', available: true }] };
    const at = (operations: unknown[]) => applyCanvasPlan(doc(), offered(...operations), 'zh', '', undefined, choices, false, false, true);
    const add = { type: 'add_node', ref: 'n', templateId: 'general', title: '团队' };
    for (const operations of [[add, template('draft-review', 'n'), { type: 'set_model', nodeId: 'n', model: 'pi-model' }],
      [add, { type: 'set_model', nodeId: 'n', model: 'pi-model' }, template('draft-review', 'n')]]) {
      const applied = at(operations);
      const node = applied.doc.nodes[0] as SessionNode;
      expect([node.runtime, node.model, node.team?.runtime]).toEqual(['pi', 'pi-model', 'pi']);
      expect(applied.adjustments).toEqual([]);
      expect(applied.modelSetNodeIds).toEqual([node.id]);
    }
    // A team the plan did not make, or one with a member set up its own way, still runs as it is set up.
    const existing = agent('writer', { runtime: 'openai-agents', model: 'own' }); existing.team = createNodeTeam(existing);
    const kept = applyCanvasPlan(doc(existing), plan({ type: 'set_model', nodeId: 'writer', model: 'pi-model' }), 'zh', '', undefined, choices, false, false, true);
    expect((kept.doc.nodes[0] as SessionNode).model).toBe('own');
    expect(kept.adjustments).toEqual(['没有改动「撰写」的模型：它是团队或工作区 Agent，按自己的设置运行']);
  });

  // A set_team keeps the members' own runtimes, models and tools of the team a node had, which another runtime may not run.
  it('never moves a node whose team it only rebuilt, whatever the order of its steps', () => {
    const choices = { choices: [{ runtime: 'pi', model: 'pi-model', available: true }] };
    const existing = agent('writer', { runtime: 'openai-agents', model: '' }); const team = createNodeTeam(existing);
    existing.team = { ...team, members: [{ ...team.members[0], name: '撰写者', tools: ['calculator'] }, team.members[1]] };
    const toPi = { type: 'set_model', nodeId: 'writer', model: 'pi-model' };
    for (const operations of [[template(), toPi], [toPi, template()], [template(), toPi, template()], [template(), { type: 'set_model', nodeId: 'writer', model: 'default' }]]) {
      const applied = applyCanvasPlan(doc(existing), offered(...operations), 'zh', '', undefined, choices, false, false, true);
      const node = applied.doc.nodes[0] as SessionNode;
      expect([node.runtime, node.team?.runtime, node.team?.members[0].tools]).toEqual(['openai-agents', 'openai-agents', ['calculator']]);
      expect(validateNodeTeam(node.team!)).toEqual([]);
      expect(applied.adjustments).toEqual(['没有改动「撰写」的模型：它是团队或工作区 Agent，按自己的设置运行']);
    }
  });

  it('never leaves a team on another runtime than its node, for a model or a node on an engine that runs no team', () => {
    const choices = { choices: [{ runtime: 'later', model: 'box', available: true }] };
    const at = (...operations: unknown[]) => applyCanvasPlan(doc(agent()), offered(...operations), 'zh', '', undefined, choices, false, false, true);
    const toBox = { type: 'set_model', nodeId: 'writer', model: 'box' };
    const kept = at(template(), toBox);
    expect([(kept.doc.nodes[0] as SessionNode).runtime, teamOf(kept.doc)?.runtime]).toEqual(['pi', 'pi']);
    expect(kept.adjustments).toEqual(['没有把「撰写」改用「box」：它的协作团队不能在这个模型的执行引擎上运行']);
    const moved = at(toBox, template());
    expect([(moved.doc.nodes[0] as SessionNode).runtime, teamOf(moved.doc)]).toEqual(['later', undefined]);
    expect(moved.adjustments).toEqual(['没有给「撰写」配团队：它的执行引擎不能运行协作团队']);
  });

  it('measures a second set_team on a node against the team it had before the plan, not the first step’s', () => {
    const existing = agent(); const team = createNodeTeam(existing);
    existing.team = { ...team, maxTurns: 10, timeoutSeconds: 600, members: [{ ...team.members[0], name: '撰写者', model: 'model-b' }, team.members[1]] };
    const applied = apply(doc(existing), plan(template('debate-verdict'), template('plan-build-check')));
    // The debate's 7 calls and 1260 s never reach the final team; the user's own limits and member settings do.
    expect(teamOf(applied.doc)).toMatchObject({ mode: 'sequential', maxTurns: 10, timeoutSeconds: 600 });
    expect(applied.adjustments).toEqual(['「撰写」换了团队成员：原来单独选了模型的「撰写者」不在新团队里']);
  });

  it('gives a written team two rounds where the plan names none, whatever the team before had', () => {
    const existing = agent(); existing.team = { ...createNodeTeam(existing), mode: 'review', maxRounds: 8, maxTurns: 16 };
    const applied = apply(doc(existing), plan(custom([member('甲'), member('乙')])));
    expect(teamOf(applied.doc)).toMatchObject({ mode: 'review', maxRounds: 2 });
  });

  it('applies set_team only from a plan whose request offered it, whatever the host runs now', () => {
    const before = doc(agent());
    const unoffered = applyCanvasPlan(before, plan(template()), 'zh', '', undefined, undefined, false, false, true);
    expect(unoffered.doc.nodes).toEqual(before.nodes);
    expect(unoffered.adjustments).toEqual(['没有给「撰写」配团队：这份方案所依据的请求没有提供协作团队配置']);
    expect(planOffersTeams(offered(template()))).toBe(true);
    expect(planOffersTeams(null)).toBe(false);
  });

  it.each([[true, false], [false, false], [true, true], [false, true]])('reads from a context whether it offered set_team (teams %s, hosted %s)', (teams, hosted) => {
    if (hosted) configureSaaSCanvas({ tenant: { id: 't', name: 'W', status: 'active', role: 'owner', maxConcurrentRuns: 1, maxRunsPerDay: 1 }, canvasId: 'c' });
    try {
      const context = buildPlanningContext(doc(agent()), [], 'zh', ['image'], { teams, models: [{ id: 'model-a', name: 'A' }] });
      expect(planContextOffersTeams(context)).toBe(teams);
    } finally { clearSaaSCanvas(); }
  });

  it('cuts the rounds of a team that could not finish them within one run’s calls, and says so', () => {
    const eight = Array.from({ length: 8 }, (_, index) => member(`成员${index}`));
    const applied = apply(doc(agent()), plan(custom(eight, { mode: 'debate', maxRounds: 8 })));
    expect(teamOf(applied.doc)).toMatchObject({ maxRounds: 7, maxTurns: 57 });
    expect(applied.adjustments).toEqual(['「撰写」的 8 人团队按 8 轮要超过一次运行最多 64 次模型调用，已改为 7 轮']);
  });

  it('keeps the settings of a member whose name the plan writes back trimmed', () => {
    const existing = agent(); const team = createNodeTeam(existing);
    existing.team = { ...team, members: [{ ...team.members[0], name: ' 撰写者 ', model: 'model-b' }, team.members[1]] };
    const applied = apply(doc(existing), plan(template()));
    expect(teamOf(applied.doc)!.members[0]).toMatchObject({ id: team.members[0].id, model: 'model-b' });
  });

  it('gives a node the same plan adds a team, and the reply says what one run of it plans to cost', () => {
    const before = doc();
    const applied = apply(before, plan({ type: 'add_node', ref: 'panel', templateId: 'general', title: '调研' }, template('research-panel', 'panel')));
    const added = applied.doc.nodes.find(node => node.id === applied.addedNodeIds[0]) as SessionNode;
    expect(added.team?.members).toHaveLength(4);
    expect(describePlanChanges(before, applied.doc, 'zh', translate('zh'), id => id)).toContain('「调研」现在是 4 人协作团队（并行汇总），每次运行计划最多 4 次模型调用');
    const changed = apply(doc(agent()), plan(template('debate-verdict')), true, 'en');
    expect(describePlanChanges(doc(agent()), changed.doc, 'en', translate('en'), id => id))
      .toContain('“撰写” is now a team of 3 (Multi-round discussion), planned for up to 7 model calls per run');
  });

  it('says nothing of a team the plan left as it was', () => {
    const existing = agent(); existing.team = createNodeTeam(existing);
    const applied = apply(doc(existing), plan({ type: 'update_node', nodeId: 'writer', title: '撰写' }));
    expect(describePlanChanges(doc(existing), applied.doc, 'zh', translate('zh'), id => id).some(line => line.includes('协作团队'))).toBe(false);
  });

  it('puts a node it made a team on the workspace default with its team, in either order', () => {
    const toDefault = { type: 'set_model', nodeId: 'writer', model: 'default' };
    for (const operations of [[template(), toDefault], [toDefault, template()]]) {
      const applied = apply(doc(agent()), plan(...operations));
      const node = applied.doc.nodes[0] as SessionNode;
      // The API runs a node on the workspace default with OpenAI Agents (defaultRuntime), so its team runs there too.
      expect([node.runtime, node.model, node.team?.runtime]).toEqual(['', '', 'openai-agents']);
      expect(applied.adjustments).toEqual([]);
    }
  });

  it('clears the result the new team makes stale', () => {
    const applied = apply(doc(agent('writer', { lastOutput: { text: 'old', source: 'run', at: 1 } })), plan(template()));
    expect((applied.doc.nodes[0] as SessionNode).lastOutput).toBeNull();
  });

  it('leaves a team the plan saw only in part, and a team that copies shortened text', () => {
    const existing = agent(); existing.team = createNodeTeam(existing);
    const partial = plan(template());
    markPlanContextCondensed(partial, new Map([['writer', new Set(['team'])]]));
    const kept = apply(doc(existing), partial);
    expect(teamOf(kept.doc)).toEqual(existing.team);
    expect(kept.adjustments).toHaveLength(1);
    expect(kept.adjustments[0]).toMatch(/^没有改动「撰写」的「协作团队」：画布内容较多/);
    const copied = plan(custom([member('a', { instructions: `开头${condensedMark(500, 'zh')}` }), member('b')]));
    markPlanContextCondensed(copied, new Map());
    const refused = apply(doc(existing), copied);
    expect(teamOf(refused.doc)).toEqual(existing.team);
    expect(refused.adjustments).toEqual(['没有改动「撰写」的「协作团队」：新的内容抄了只显示了开头的文字']);
  });

  it.each(['name', 'role'] as const)('leaves a team whose member %s copies shortened text', field => {
    const existing = agent(); existing.team = createNodeTeam(existing);
    const copied = plan(custom([member('a', { [field]: `开头${condensedMark(500, 'zh')}` }), member('b')]));
    markPlanContextCondensed(copied, new Map());
    const refused = apply(doc(existing), copied);
    expect(teamOf(refused.doc)).toEqual(existing.team);
    expect(refused.adjustments).toEqual(['没有改动「撰写」的「协作团队」：新的内容抄了只显示了开头的文字']);
  });

  // Sub-agent review 2026-10-25: a team the old default left on Pi beside an OpenAI node gave every new member Pi's
  // default model, though the protocol tells the planner new members inherit the node's.
  it('moves a replaced team where its node runs, or says why it stays elsewhere', () => {
    const node = agent('writer', { runtime: 'openai-agents', model: 'own' });
    node.team = { ...createNodeTeam(node), runtime: 'pi' };
    const moved = apply(doc(node), plan(template()));
    expect(teamOf(moved.doc)?.runtime).toBe('openai-agents');
    expect(moved.adjustments).toEqual(['「撰写」的团队改在节点所在的 OpenAI Agents 上运行，成员继承节点的模型']);
    const anchored = { ...node, team: { ...node.team, members: [{ ...node.team.members[0], name: '撰写者', model: 'pi-model' }, node.team.members[1]] } };
    const stays = apply(doc(anchored), plan(template()));
    expect(teamOf(stays.doc)?.runtime).toBe('pi');
    // Only the member left on Pi without a model of its own misses the node's model (Codex review 2026-10-25).
    expect(stays.adjustments).toEqual(['「撰写」的团队仍在 Pi 上运行（有成员单独设置了执行框架、模型或工具）：「审核者」没有单独设置模型，使用所在执行框架的默认模型，不继承节点的模型']);
    const own = { ...node, team: { ...node.team, members: [{ ...node.team.members[0], name: '撰写者', runtime: 'openai-agents' as const },
      { ...node.team.members[1], name: '审核者', model: 'pi-model' }] } };
    const none = apply(doc(own), plan(template()));
    expect(teamOf(none.doc)?.runtime).toBe('pi');
    expect(none.adjustments).toEqual([]);
  });

  // Codex review 2026-10-25: a later set_team on a node left the notes an earlier one wrote, though they no longer held.
  it('describes the team a node ends with, not the one an earlier step wrote', () => {
    const node = agent('writer', { runtime: 'openai-agents', model: 'own' });
    const team = createNodeTeam(node);
    node.team = { ...team, runtime: 'pi', members: [{ ...team.members[0], name: 'A', model: 'a' }, { ...team.members[1], name: 'B', model: 'b' }] };
    const applied = apply(doc(node), plan(template(), custom([member('A'), member('B')])));
    expect(teamOf(applied.doc)?.runtime).toBe('pi');
    expect(teamOf(applied.doc)!.members.map(item => item.model)).toEqual(['a', 'b']);
    expect(applied.adjustments).toEqual([]);
    // A node the plan removes again says nothing of its team.
    expect(apply(doc(node), plan(template(), { type: 'remove_node', nodeId: 'writer' })).adjustments).toEqual([]);
  });

  it('keeps the settings of a member the template names in the other language', () => {
    const existing = agent(); const zhTeam = createNodeTeamFromTemplate(nodeTeamTemplate('draft-review')!, existing, 'zh');
    existing.team = { ...zhTeam, members: [{ ...zhTeam.members[0], model: 'model-b' }, zhTeam.members[1]] };
    const applied = apply(doc(existing), plan(template()), true, 'en');
    expect(teamOf(applied.doc)!.members.map(item => [item.id, item.name, item.model])).toEqual([[zhTeam.members[0].id, 'Writer', 'model-b'], [zhTeam.members[1].id, 'Reviewer', '']]);
    expect(applied.adjustments).toEqual([]);
  });
});

describe('the planner’s view of teams', () => {
  const graph = (context: string, heading = '当前画布：') => JSON.parse(context.slice(context.indexOf(`${heading}\n`) + heading.length + 1).split('\n\n')[0]);

  it('shows a team’s members and the templates only where the host runs teams, never a member’s model or tools', () => {
    const node = agent(); node.team = createNodeTeam(node);
    node.team.members[1] = { ...node.team.members[1], model: 'secret-model', runtime: 'openai-agents', tools: ['calculator'] };
    const withTeams = buildPlanningContext(doc(node), [], 'zh', [], { teams: true });
    expect(graph(withTeams).nodes[0].team).toEqual({ mode: 'sequential', maxRounds: 2,
      members: node.team.members.map(({ name, role, instructions }) => ({ name, role, ...(instructions ? { instructions } : {}) })) });
    expect(withTeams).not.toContain('secret-model');
    expect(withTeams).toMatch(/^set_team: /m);
    expect(withTeams).toContain('协作团队模板（set_team 的 template）');
    for (const id of NODE_TEAM_TEMPLATE_IDS) expect(withTeams).toContain(`"id":"${id}"`);
    const without = buildPlanningContext(doc(node), [], 'zh', [], {});
    expect(graph(without).nodes[0].team).toBe(true);
    expect(without).not.toContain('协作团队模板');
    expect(without).not.toMatch(/^set_team/m);
  });

  it('fits a canvas of large teams by shortening their members’ roles and names too', () => {
    const nodes = Array.from({ length: 24 }, (_, index) => {
      const node = agent(`team-${index}`);
      const team = createNodeTeam(node);
      node.team = { ...team, maxTurns: 8, members: Array.from({ length: 8 }, (_, ordinal) => ({ ...team.members[0], id: `m-${index}-${ordinal}`,
        name: `成员${ordinal}${'名'.repeat(100)}`, role: `职责${ordinal}${'r'.repeat(500)}`, instructions: '' })) };
      return node;
    });
    const document = doc(...nodes);
    const room = 60_000;
    expect(utf8Bytes(buildPlanningContext(document, [], 'zh', [], { teams: true }))).toBeGreaterThan(room);
    const fitted = fitPlanningContext(document, [], 'zh', [], { teams: true }, room);
    expect(fitted).not.toBeNull();
    expect(utf8Bytes(fitted!.context)).toBeLessThanOrEqual(room);
    expect([...fitted!.condensed.values()].some(fields => fields.has('team'))).toBe(true);
  });

  it('shortens long member instructions in a shortened view and marks the team as shown in part', () => {
    const node = agent(); node.team = createNodeTeam(node);
    node.team.members = node.team.members.map(item => ({ ...item, instructions: '很长的成员指令。'.repeat(1000) }));
    const others = Array.from({ length: 6 }, (_, index) => agent(`other-${index}`, { persona: '其他节点的职责说明。'.repeat(300) }));
    const document = doc(node, ...others);
    const room = Math.floor(utf8Bytes(buildPlanningContext(document, [], 'zh', [], { teams: true })) / 2);
    const fitted = fitPlanningContext(document, [], 'zh', [], { teams: true }, room)!;
    expect(fitted.shortened).toBe(true);
    expect(fitted.condensed.get('writer')?.has('team')).toBe(true);
    expect(utf8Bytes(fitted.context)).toBeLessThanOrEqual(room);
  });
});
