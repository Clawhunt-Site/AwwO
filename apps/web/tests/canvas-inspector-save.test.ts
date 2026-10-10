import { describe, expect, it } from 'vitest';
import { createSessionNode, type SessionNode } from '../src/canvas/canvasDoc';
import { inspectorSavedNode } from '../src/canvas/inspectorSave';

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
});
