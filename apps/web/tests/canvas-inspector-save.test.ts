import { describe, expect, it } from 'vitest';
import { createSessionNode, emptyDocument, type CanvasDocument, type NodeOutput, type SessionNode } from '../src/canvas/canvasDoc';
import { inspectorSavedNode } from '../src/canvas/inspectorSave';
import { invalidateOutputs } from '../src/canvas/invalidateOutputs';
import { activeThreadId, getNodeThreads, rebindNodeThread } from '../src/canvas/nodeThreads';

const at = { x: 0, y: 0 };

describe('inspector save', () => {
  it("keeps a media node's own settings, which reach the run and its price", () => {
    const live: SessionNode = { ...createSessionNode('model3d', at), id: 'hero', model: 'tripo.v3-1', mediaParams: { texture: true } };
    const draft: SessionNode = { ...live, title: 'Hero', mediaParams: { texture: false, textureQuality: 'detailed' } };
    const saved = inspectorSavedNode(live, draft, live, { binding: false, config: false });
    expect(saved.mediaParams).toEqual({ texture: false, textureQuality: 'detailed' });
    expect(saved.title).toBe('Hero');
  });

  it('drops the settings when the draft has none, instead of keeping the live copy', () => {
    const live: SessionNode = { ...createSessionNode('image', at), id: 'pic', model: 'rh.seedream-v5-pro', mediaParams: { resolution: '1k' } };
    const draft: SessionNode = { ...live };
    delete draft.mediaParams;
    expect(inspectorSavedNode(live, draft, live, { binding: false, config: false })).not.toHaveProperty('mediaParams');
  });

  it('brings back no contract, template, team or task frame for a media node', () => {
    const agent = createSessionNode('llm', at);
    const live = { ...agent, id: 'n', contract: agent.contract, templateId: 'tpl', templateVersion: 2, team: 'team-a' } as SessionNode;
    const draft: SessionNode = { ...live, agentKind: 'video', model: 'rh.kling-v3-pro' };
    const saved = inspectorSavedNode(live, draft, live, { binding: false, config: true });
    expect(saved.agentKind).toBe('video');
    for (const key of ['contract', 'templateId', 'templateVersion', 'team', 'taskFrame']) expect(saved).not.toHaveProperty(key);
    expect(saved.binding).toBeNull();
    expect(saved.issueId).toBeNull();
  });

  it("leaves an agent node's contract alone and keeps its thread when nothing rebinds it", () => {
    const agent = createSessionNode('llm', at);
    const live = { ...agent, id: 'n', issueId: 'issue-1' } as SessionNode;
    const draft: SessionNode = { ...live, title: 'Writer' };
    const saved = inspectorSavedNode(live, draft, live, { binding: false, config: false });
    expect(saved.contract).toEqual(live.contract);
    expect(saved.issueId).toBe('issue-1');
    expect(inspectorSavedNode(live, draft, live, { binding: true, config: false }).issueId).toBeNull();
  });

  // On a node already bound, a configuration change opens a new conversation beside the old (rebindNodeThread). A
  // result handed in was made in neither, so it stays published, and invalidateOutputs decides as on a node not bound.
  describe('a hand-in through the conversation a rebinding opens', () => {
    const handIn: NodeOutput = { text: 'Levels by the agent', source: 'manual', at: 5 };
    const bound = (lastOutput: NodeOutput): SessionNode => ({ ...createSessionNode('llm', at), id: 'levels', title: 'Levels',
      persona: 'Write the levels', runtime: 'openai-agents', model: 'opus-fixture', issueId: 'issue-levels', lastOutput,
      binding: { companyId: 'company', agentId: 'levels-agent', agentName: 'Levels' } });
    /** The levels feed a review whose checklist was made from them. */
    const doc = (levels: SessionNode): CanvasDocument => ({ ...emptyDocument(),
      nodes: [levels, { ...createSessionNode('llm', at), id: 'review', title: 'Review', lastOutput: { text: 'Checklist', source: 'manual', at: 6 } }],
      edges: [{ id: 'levels-review', fromNode: 'levels', fromPort: 'result', toNode: 'review', toPort: 'context', dataType: 'text' }] });
    const reconfigured = (live: SessionNode, draft: SessionNode) => inspectorSavedNode(rebindNodeThread(live, null), draft, live, { binding: false, config: true });
    const resolved = (live: SessionNode, saved: SessionNode) => {
      const before = doc(live);
      return invalidateOutputs(before, { ...before, nodes: [saved, before.nodes[1]] }).nodes.map(node => node.lastOutput?.text ?? null);
    };

    it('keeps it published, and what was made from it, when the person picks another model', () => {
      const live = bound(handIn);
      const saved = reconfigured(live, { ...live, model: 'qwen-fixture' });
      expect(activeThreadId(saved)).not.toBe(activeThreadId(live));
      expect(saved.binding).toBeNull();
      expect(saved.lastOutput).toEqual(handIn);
      expect(resolved(live, saved)).toEqual(['Levels by the agent', 'Checklist']);
    });

    it('takes it back, and what was made from it, when the person changes the task', () => {
      const live = bound(handIn);
      expect(resolved(live, reconfigured(live, { ...live, persona: 'Write eight levels' }))).toEqual([null, null]);
    });

    it('keeps it through another Agent bound in its place', () => {
      const live = bound(handIn);
      const binding = { companyId: 'company', agentId: 'other-agent', agentName: 'Other' };
      const saved = inspectorSavedNode(rebindNodeThread(live, binding), { ...live, binding }, live, { binding: true, config: false });
      expect(saved.binding).toEqual(binding);
      expect(resolved(live, saved)).toEqual(['Levels by the agent', 'Checklist']);
    });

    it('leaves a run’s result with the old conversation, as before', () => {
      const run: NodeOutput = { text: 'Levels by a run', source: 'run', at: 5 };
      const live = bound(run);
      const saved = reconfigured(live, { ...live, model: 'qwen-fixture' });
      expect(saved.lastOutput ?? null).toBeNull();
      expect(getNodeThreads(saved).find(thread => thread.id === activeThreadId(live))?.lastOutput).toEqual(run);
    });
  });
});
