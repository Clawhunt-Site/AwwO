import { afterEach, describe, expect, it, vi } from 'vitest';
import { CANVAS_BACKUP_KEY, CANVAS_STORAGE_KEY, createSessionNode, emptyDocument, loadDocumentWithStatus, sanitizeDocument, type CanvasDocument, type SessionNode } from '../src/canvas/canvasDoc';
import { createNodeTeam, everyMemberInherits, followNodeModel, followNodeRuntime, inheritNodeModel, inheritingRuntime, nodeTeamFingerprint, nodeTeamModelOverrides, nodeTeamTurnEstimate, sanitizeNodeTeam, validateNodeTeam } from '../src/canvas/nodeTeam';
import { invalidateOutputs } from '../src/canvas/invalidateOutputs';
import { runInputFingerprint } from '../src/canvas/runRecoveryDocument';
function node(): SessionNode {
  const session = { ...createSessionNode('llm', { x: 0, y: 0 }), id: 'team-node', title: '研究', runtime: 'pi', model: 'catalog-model', persona: 'Use only facts.',
    binding: { companyId: 'tenant-1', agentId: 'agent-1', agentName: '研究' }, lastOutput: { text: 'old result', source: 'run' as const, at: 1 } };
  return { ...session, team: createNodeTeam(session) };
}
function document(): CanvasDocument {
  return { ...emptyDocument(), nodes: [node(), { ...createSessionNode('llm', { x: 10, y: 0 }), id: 'downstream', lastOutput: { text: 'old downstream', at: 1, source: 'run' } }],
    edges: [{ id: 'edge', fromNode: 'team-node', fromPort: 'result', toNode: 'downstream', toPort: 'context', dataType: 'text' }] };
}
afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });
describe('node team persistence and execution freshness', () => {
  it('round-trips members, budgets and mode without modifying the primary Agent', () => {
    const original = node(); original.team!.mode = 'review';
    original.team!.members[1] = { ...original.team!.members[1], runtime: 'pi', model: 'second-model', context: 'task' };
    const restored = sanitizeDocument(JSON.parse(JSON.stringify({ ...emptyDocument(), nodes: [original] }))).nodes[0] as SessionNode;
    expect(restored.team).toEqual(original.team); expect(restored.binding).toEqual(original.binding);
    expect(restored.persona).toBe('Use only facts.'); expect(restored.model).toBe('catalog-model');
  });
  it('does not opt legacy nodes into teams or invent model selections', () => {
    const restored = sanitizeDocument({ ...emptyDocument(), nodes: [createSessionNode('llm', { x: 0, y: 0 })] }).nodes[0] as SessionNode;
    expect(restored).not.toHaveProperty('team'); expect(restored.model).toBe('');
  });
  it('removes unknown credential metadata from a valid imported team', () => {
    const team = node().team!;
    const restored = sanitizeNodeTeam({ ...team, apiKey: 'should-not-export', members: team.members.map(member => ({ ...member, providerKey: 'should-not-export' })) });
    expect(restored).toEqual(team); expect(JSON.stringify(restored)).not.toContain('should-not-export');
  });
  it.each([
    ['version', { version: 2 }], ['rounds', { maxRounds: 0 }], ['fraction', { maxRounds: 1.5 }], ['turns', { maxTurns: 65 }],
    ['timeout', { timeoutSeconds: 9 }], ['runtime', { runtime: 'shell' }], ['mode', { mode: 'autonomous' }],
    ['empty members', { members: [] }], ['review singleton', { mode: 'review', members: [node().team!.members[0]] }],
  ])('rejects invalid %s without executable defaults', (_, patch) => {
    const invalid = { ...node().team, ...patch };
    expect(validateNodeTeam(invalid).length).toBeGreaterThan(0); expect(sanitizeNodeTeam(invalid)).toBeNull();
  });
  it('rejects duplicate identities, unsupported tools and unknown catalog models', () => {
    const team = node().team!; team.members[0].model = 'catalog-model'; team.members[1].id = team.members[0].id; (team.members[0] as any).tools = ['shell'];
    expect(validateNodeTeam(team, ['other-model']).map(issue => issue.path)).toEqual(expect.arrayContaining(['members.1.id', 'members.0.tools', 'members.0.model']));
    expect(sanitizeNodeTeam(team)).toBeNull();
  });
  it('validates member reasoning effort against the explicit model catalog and leaves legacy teams unchanged', () => {
    const legacy = node().team!;
    expect(sanitizeNodeTeam(legacy)!.members.some(member => 'effort' in member)).toBe(false);
    expect(nodeTeamFingerprint({ ...legacy, members: legacy.members.map(member => ({ ...member, effort: '' })) })).toBe(nodeTeamFingerprint(legacy));
    const team = node().team!;
    team.members[0] = { ...team.members[0], runtime: 'openai-agents', model: 'deep', effort: 'high' };
    const efforts = { 'openai-agents': { deep: ['low', 'high'] } };
    expect(validateNodeTeam(team, undefined, 'en', efforts)).toEqual([]);
    expect(sanitizeNodeTeam(team)!.members[0].effort).toBe('high');
    const withMember = (patch: object) => ({ ...team, members: [{ ...team.members[0], ...patch }, team.members[1]] });
    expect(validateNodeTeam(withMember({ effort: 'medium' }), undefined, 'en', efforts).map(issue => issue.path)).toContain('members.0.effort');
    expect(validateNodeTeam(withMember({ model: '' }), undefined, 'en', efforts).map(issue => issue.path)).toContain('members.0.effort');
    expect(validateNodeTeam(withMember({ model: 'plain' }), undefined, 'en', efforts).map(issue => issue.path)).toContain('members.0.effort');
    expect(validateNodeTeam(withMember({ effort: 'High' })).map(issue => issue.path)).toContain('members.0.effort');
    expect(validateNodeTeam(withMember({ effort: 7 })).map(issue => issue.path)).toContain('members.0.effort');
    expect(sanitizeNodeTeam(withMember({ effort: 'High' }))).toBeNull();
  });
  it('uses Unicode character limits shared with the Go contract', () => {
    const team = node().team!; team.members[0].name = '审'.repeat(128); team.members[0].role = '责'.repeat(512);
    expect(validateNodeTeam(team)).toEqual([]);
    team.members[0].name += '稿'; expect(validateNodeTeam(team).map(issue => issue.path)).toContain('members.0.name');
    team.members[0].name = '🙂'.repeat(128); expect(validateNodeTeam(team)).toEqual([]);
  });
  it('requires enough model calls for at least one pass through every member', () => {
    const team = node().team!; team.maxTurns = 1;
    expect(validateNodeTeam(team).map(issue => issue.path)).toContain('maxTurns');
  });
  it('backs up malformed teams and reports corrupt instead of converting to one Agent', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const original = document(); (original.nodes[0] as SessionNode).team!.maxTurns = 100;
    const raw = JSON.stringify(original); localStorage.setItem(CANVAS_STORAGE_KEY, raw);
    const restored = loadDocumentWithStatus(); expect(restored.status).toBe('corrupt');
    expect(restored.doc.nodes.map(item => item.id)).toEqual(['downstream']); expect(localStorage.getItem(CANVAS_BACKUP_KEY)).toBe(raw);
  });
  it.each(['mode', 'model', 'effort', 'role', 'context', 'instructions', 'runtime', 'order', 'budget', 'disable'])('invalidates outputs and recovery when team %s changes', (field) => {
    const before = document(); const next = structuredClone(before); const session = next.nodes[0] as SessionNode;
    switch (field) {
      case 'mode': session.team!.mode = 'parallel'; break;
      case 'model': session.team!.members[0].model = 'other-model'; break;
      case 'effort': session.team!.members[0].effort = 'high'; break;
      case 'role': session.team!.members[0].role = 'Auditor'; break;
      case 'context': session.team!.members[0].context = 'task'; break;
      case 'instructions': session.team!.members[0].instructions = 'Check sources'; break;
      case 'runtime': session.team!.members[0].runtime = 'pi'; break;
      case 'order': session.team!.members.reverse(); break;
      case 'budget': session.team!.maxTurns = 3; break;
      case 'disable': delete session.team; break;
    }
    expect(invalidateOutputs(before, next).nodes.map(item => item.lastOutput)).toEqual([null, null]);
    expect(runInputFingerprint(next, ['team-node'])).not.toBe(runInputFingerprint(before, ['team-node']));
    expect(before.nodes[0].lastOutput?.text).toBe('old result');
  });
  it('ignores layout and object key ordering for execution freshness', () => {
    const before = document(); const next = structuredClone(before); const session = next.nodes[0] as SessionNode; session.x = 300;
    session.team = { members: session.team!.members, ...session.team! };
    expect(nodeTeamFingerprint(session.team)).toBe(nodeTeamFingerprint((before.nodes[0] as SessionNode).team));
    expect(invalidateOutputs(before, next).nodes[0].lastOutput?.text).toBe('old result');
    expect(runInputFingerprint(next, ['team-node'])).toBe(runInputFingerprint(before, ['team-node']));
  });
  it('estimates model calls for all four modes', () => {
    const team = node().team!; expect(nodeTeamTurnEstimate(team)).toBe(2);
    expect(nodeTeamTurnEstimate({ ...team, mode: 'parallel' })).toBe(2);
    expect(nodeTeamTurnEstimate({ ...team, mode: 'debate', maxRounds: 3 })).toBe(7);
    expect(nodeTeamTurnEstimate({ ...team, mode: 'review', maxRounds: 3 })).toBe(6);
  });
});

it('round-trips OpenAI Agents models and allowlisted tools with the node and thread runtime', () => {
  const original = node(); original.runtime = 'openai-agents'; original.model = 'agents-model'; original.team = createNodeTeam(original);
  original.team.members[0].model = 'agents-model';
  original.team.members[0].tools = ['calculator', 'current_time'];
  original.team.members[1] = { ...original.team.members[1], runtime: 'pi', model: 'catalog-model' };
  const restored = sanitizeDocument(JSON.parse(JSON.stringify({ ...emptyDocument(), nodes: [original] }))).nodes[0] as SessionNode;
  expect(restored).toMatchObject({ runtime: 'openai-agents', model: 'agents-model', team: original.team });
  expect(validateNodeTeam(restored.team, { pi: ['catalog-model'], 'openai-agents': ['agents-model'] })).toEqual([]);
  expect(validateNodeTeam(restored.team, { pi: ['catalog-model'], 'openai-agents': ['other-model'] }).map(issue => issue.path)).toContain('members.0.model');
});
it('rejects Pi tools, duplicate tools and arbitrary tool identifiers while preserving safe tool ordering', () => {
  const team = node().team!;
  team.members[0].tools = ['calculator']; expect(sanitizeNodeTeam(team)).toBeNull();
  team.runtime = 'openai-agents'; expect(sanitizeNodeTeam(team)?.members[0].tools).toEqual(['calculator']);
  team.members[0].tools = ['calculator', 'calculator']; expect(sanitizeNodeTeam(team)).toBeNull();
  (team.members[0] as any).tools = ['shell']; expect(sanitizeNodeTeam(team)).toBeNull();
});
it('invalidates execution outputs when the runtime or tool authorization changes', () => {
  const before = document(); const after = structuredClone(before); const changed = after.nodes[0] as SessionNode;
  changed.team!.members[0].runtime = 'openai-agents'; changed.team!.members[0].tools = ['calculator'];
  expect(invalidateOutputs(before, after).nodes.map(item => item.lastOutput)).toEqual([null, null]);
  expect(runInputFingerprint(after, ['team-node'])).not.toBe(runInputFingerprint(before, ['team-node']));
  const withTools = structuredClone(after); (after.nodes[0] as SessionNode).team!.members[0].tools = [];
  expect(runInputFingerprint(after, ['team-node'])).not.toBe(runInputFingerprint(withTools, ['team-node']));
});


describe('the node model reaches its team', () => {
  it('lets a new team inherit the node model instead of freezing a copy of it', () => {
    const team = createNodeTeam({ title: '游戏化学习系统规划', persona: 'p', model: 'claude-opus-5', runtime: 'pi' });
    expect(team.members.map(member => member.model)).toEqual(['', '']);
    expect(nodeTeamModelOverrides({ runtime: 'pi', model: 'qwen3.8-27b-p6', team })).toEqual([]);
  });
  it('lists members whose own model the node model does not reach, and points them back at it', () => {
    // The reported canvas: the team was enabled while the node used claude-opus-5, then the node moved to qwen.
    const team = createNodeTeam({ title: '游戏化学习系统规划', persona: '', model: '', runtime: 'pi' });
    team.members[0] = { ...team.members[0], model: 'claude-opus-5' };
    const other = { ...team, members: [...team.members, { ...team.members[1], id: 'agents', runtime: 'openai-agents' as const, model: 'agents-model' }] };
    const node = { runtime: 'pi', model: 'qwen3.8-27b-p6', team: other };
    // A member on another runtime never inherits the node model, so it is not an override of it.
    expect(nodeTeamModelOverrides(node).map(({ index, member }) => [index, member.model])).toEqual([[0, 'claude-opus-5']]);
    const fixed = inheritNodeModel(other, [0]);
    expect(fixed.members[0].model).toBe(''); expect(fixed.members[0]).not.toHaveProperty('effort');
    expect(fixed.members.slice(1)).toEqual(other.members.slice(1));
    expect(nodeTeamModelOverrides({ ...node, team: fixed })).toEqual([]);
    expect(validateNodeTeam(fixed)).toEqual([]);
    // An own effort needs an own model, so it goes with it.
    const withEffort = structuredClone(other); withEffort.members[0].effort = 'high';
    expect(inheritNodeModel(withEffort, [0]).members[0]).not.toHaveProperty('effort');
  });
  it('carries a node model change to members that held the previous node model, and only to them', () => {
    const legacy = createNodeTeam({ title: 'Plan', persona: '', model: '', runtime: 'pi' });
    legacy.members[0].model = 'claude-opus-5'; // what a team enabled before inheritance stored
    legacy.members[1] = { ...legacy.members[1], model: 'model-b' }; // a deliberate other choice is kept
    const followed = followNodeModel(legacy, { runtime: 'pi', model: 'claude-opus-5', effort: '' }, { runtime: 'pi' });
    expect(followed.members.map(member => member.model)).toEqual(['', 'model-b']);
    expect(nodeTeamModelOverrides({ runtime: 'pi', model: 'qwen3.8-27b-p6', team: followed }).map(item => item.index)).toEqual([1]);
    // An own effort, a runtime change, or nothing that held the previous model leaves the team as it was.
    const withEffort = structuredClone(legacy); withEffort.members[0].effort = 'high';
    expect(followNodeModel(withEffort, { runtime: 'pi', model: 'claude-opus-5' }, { runtime: 'pi' })).toBe(withEffort);
    expect(followNodeModel(legacy, { runtime: 'pi', model: 'claude-opus-5' }, { runtime: 'openai-agents' })).toBe(legacy);
    expect(followNodeModel(legacy, { runtime: 'pi', model: 'other-model' }, { runtime: 'pi' })).toBe(legacy);
    expect(followNodeModel(legacy, { runtime: 'pi', model: '' }, { runtime: 'pi' })).toBe(legacy);
  });
  // Codex review 2026-10-25: a node on the workspace default gets a team on OpenAI Agents, where the API runs it, and
  // switching the node to a Pi model left the team there, its members on OpenAI Agents' default model.
  it('moves a team that runs where its node runs to the node’s new runtime, and no other team', () => {
    const fresh = createNodeTeam({ title: 'Plan', persona: '', model: '', runtime: '' });
    expect(fresh.runtime).toBe('openai-agents');
    const onPi = followNodeRuntime(fresh, { runtime: '' }, { runtime: 'pi' });
    expect(onPi).toEqual({ ...fresh, runtime: 'pi' });
    expect(followNodeRuntime(onPi, { runtime: 'pi' }, { runtime: '' }).runtime).toBe('openai-agents');
    expect(followNodeRuntime(fresh, { runtime: '' }, { runtime: 'openai-agents' })).toBe(fresh);
    // A team put on another runtime than its node's, a member with a runtime, a model or tools of its own, or a node
    // moving where no team runs keeps the team where it is.
    const elsewhere = { ...fresh, runtime: 'pi' as const };
    expect(followNodeRuntime(elsewhere, { runtime: 'openai-agents' }, { runtime: '' })).toBe(elsewhere);
    for (const patch of [{ runtime: 'openai-agents' as const }, { model: 'model-b' }, { tools: ['calculator'] }]) {
      const own = { ...fresh, members: [{ ...fresh.members[0], ...patch }, fresh.members[1]] };
      expect(followNodeRuntime(own, { runtime: '' }, { runtime: 'pi' })).toBe(own);
    }
    expect(followNodeRuntime(fresh, { runtime: '' }, { runtime: 'sandbox' })).toBe(fresh);
  });
  // Sub-agent review 2026-10-25: the editor read a node without a runtime as Pi, where the API runs it on OpenAI Agents.
  it('reads a node without a runtime as the API runs it, for what its members inherit', () => {
    expect([inheritingRuntime({ runtime: '' }), inheritingRuntime({}), inheritingRuntime({ runtime: 'pi' })]).toEqual(['openai-agents', 'openai-agents', 'pi']);
    const team = createNodeTeam({ title: 'Plan', persona: '', model: '', runtime: '' });
    const own = { ...team, members: [{ ...team.members[0], model: 'agents-model' }, team.members[1]] };
    expect(nodeTeamModelOverrides({ runtime: '', model: '', team: own }).map(item => item.index)).toEqual([0]);
    expect([everyMemberInherits(team), everyMemberInherits(own)]).toEqual([true, false]);
  });
});
