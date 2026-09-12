import { afterEach, describe, expect, it, vi } from 'vitest';
import { CANVAS_BACKUP_KEY, CANVAS_STORAGE_KEY, createSessionNode, emptyDocument, loadDocumentWithStatus, sanitizeDocument, type CanvasDocument, type SessionNode } from '../src/canvas/canvasDoc';
import { createNodeTeam, nodeTeamFingerprint, nodeTeamTurnEstimate, sanitizeNodeTeam, validateNodeTeam } from '../src/canvas/nodeTeam';
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
    const team = node().team!; team.members[1].id = team.members[0].id; (team.members[0] as any).tools = ['shell'];
    expect(validateNodeTeam(team, ['other-model']).map(issue => issue.path)).toEqual(expect.arrayContaining(['members.1.id', 'members.0.tools', 'members.0.model']));
    expect(sanitizeNodeTeam(team)).toBeNull();
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
  it.each(['mode', 'model', 'role', 'context', 'instructions', 'runtime', 'order', 'budget', 'disable'])('invalidates outputs and recovery when team %s changes', (field) => {
    const before = document(); const next = structuredClone(before); const session = next.nodes[0] as SessionNode;
    switch (field) {
      case 'mode': session.team!.mode = 'parallel'; break;
      case 'model': session.team!.members[0].model = 'other-model'; break;
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

it('round-trips OpenAI Agents JS models and allowlisted tools with the node and thread runtime', () => {
  const original = node(); original.runtime = 'openai-agents'; original.model = 'agents-model'; original.team = createNodeTeam(original);
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
