import { describe, expect, it } from 'vitest';
import { createSessionNode, type CanvasDocument, type SessionNode } from '../src/canvas/canvasDoc';
import { automaticEntries, automaticEntry, choosesRuntime, withAutomaticRuntime, withAutomaticRuntimes } from '../src/canvas/nodeRuntime';

const entries = [
  { runtime: 'pi', model: 'opus', available: true, key: 'pi-opus' },
  { runtime: 'openai-agents', model: 'opus', available: true, key: 'agents-opus' },
  { runtime: 'pi', model: 'deepseek-r1', available: true, key: 'pi-r1' },
  { runtime: 'openai-agents', model: 'gated', available: false, key: 'agents-gated' },
  { runtime: 'pi', model: 'gated', available: false, key: 'pi-gated' },
];
const efforts = (runtime: string, model: string) => runtime === 'openai-agents' && model === 'opus' ? ['low', 'medium', 'high'] : runtime === 'pi' && model === 'opus' ? ['low', 'xhigh'] : [];
const node = (extra: Partial<SessionNode> = {}): SessionNode => ({ ...createSessionNode('llm', { x: 0, y: 0 }), id: 'n', ...extra });

describe('the runtime AwwO runs a model on', () => {
  it('is openai-agents wherever a ready worker offers the model, Pi otherwise, and none when no ready runtime has it', () => {
    expect(automaticEntry('opus', entries)?.key).toBe('agents-opus');
    expect(automaticEntry('deepseek-r1', entries)?.key).toBe('pi-r1');
    expect(automaticEntry('gated', entries)).toBeUndefined();
    expect(automaticEntry('', entries)).toBeUndefined();
    const agentsDown = entries.map(entry => entry.runtime === 'openai-agents' ? { ...entry, available: false } : entry);
    expect(automaticEntry('opus', agentsDown)?.key).toBe('pi-opus');
  });

  it('lists each model once, where its first entry stood, keeping an unready model visible', () => {
    expect(automaticEntries(entries).map(entry => entry.key)).toEqual(['agents-opus', 'pi-r1', 'agents-gated']);
    expect(automaticEntries([])).toEqual([]);
  });
});

describe('a node on its automatic runtime', () => {
  it('moves from Pi to openai-agents for a model both offer, keeping an effort the new entry advertises', () => {
    expect(withAutomaticRuntime(node({ runtime: 'pi', model: 'opus', effort: 'low' }), entries, efforts)).toMatchObject({ runtime: 'openai-agents', model: 'opus', effort: 'low' });
    // xhigh is Pi's level only: the node goes back to the model's own default effort.
    expect(withAutomaticRuntime(node({ runtime: 'pi', model: 'opus', effort: 'xhigh' }), entries, efforts)).toMatchObject({ runtime: 'openai-agents', effort: '' });
    // A runtime the workspace does not have any more is left for the ready one too.
    expect(withAutomaticRuntime(node({ runtime: 'retired', model: 'opus' }), entries, efforts).runtime).toBe('openai-agents');
  });

  it('stays where it is for a Pi-only model, a model no ready runtime offers, or a node already there', () => {
    const r1 = node({ runtime: 'pi', model: 'deepseek-r1' });
    expect(withAutomaticRuntime(r1, entries, efforts)).toBe(r1);
    const gated = node({ runtime: 'pi', model: 'gated' });
    expect(withAutomaticRuntime(gated, entries, efforts)).toBe(gated);
    const there = node({ runtime: 'openai-agents', model: 'opus' });
    expect(withAutomaticRuntime(there, entries, efforts)).toBe(there);
    // A node left unset is set up on the server's default (openai-agents) and is not touched.
    const unset = node();
    expect(withAutomaticRuntime(unset, entries, efforts)).toBe(unset);
  });

  it('runs a Pi node without a model on the workspace default once openai-agents is ready', () => {
    expect(withAutomaticRuntime(node({ runtime: 'pi', model: '', effort: 'low' }), entries, efforts)).toMatchObject({ runtime: '', model: '', effort: '' });
    const agentsDown = entries.map(entry => entry.runtime === 'openai-agents' ? { ...entry, available: false } : entry);
    const pi = node({ runtime: 'pi', model: '' });
    expect(withAutomaticRuntime(pi, agentsDown, efforts)).toBe(pi);
  });

  it('never touches a team, a workspace Agent or a media node, but moves a node AwwO set up before', () => {
    const team = node({ runtime: 'pi', model: 'opus', team: { version: 1, mode: 'sequential', members: [] } as unknown as SessionNode['team'] });
    const shared = node({ runtime: 'pi', model: 'opus', agentRef: { source: 'workspace', agentId: 'a' } });
    const image = { ...createSessionNode('image', { x: 0, y: 0 }), id: 'img', runtime: 'pi', model: 'opus' } as SessionNode;
    for (const item of [team, shared, image]) {
      expect(choosesRuntime(item)).toBe(false);
      expect(withAutomaticRuntime(item, entries, efforts)).toBe(item);
    }
    // A hosted node's binding is the Agent AwwO's own setup made for it: the node is set up again on the new runtime.
    const setUp = node({ runtime: 'pi', model: 'opus', binding: { companyId: 'w', agentId: 'a', agentName: 'A' }, issueId: 's' });
    expect(withAutomaticRuntime(setUp, entries, efforts)).toMatchObject({ runtime: 'openai-agents', binding: setUp.binding, issueId: 's' });
  });

  it('moves only the nodes a run executes, and keeps the document when nothing moves', () => {
    const doc = { version: 2, updatedAt: 0, edges: [], nodes: [node({ id: 'a', runtime: 'pi', model: 'opus' }), node({ id: 'b', runtime: 'pi', model: 'opus' })] } as unknown as CanvasDocument;
    const scoped = withAutomaticRuntimes(doc, ['b'], entries, efforts);
    expect(scoped.nodes.map(item => (item as SessionNode).runtime)).toEqual(['pi', 'openai-agents']);
    expect(withAutomaticRuntimes(doc, undefined, entries, efforts).nodes.map(item => (item as SessionNode).runtime)).toEqual(['openai-agents', 'openai-agents']);
    expect(withAutomaticRuntimes(doc, ['a'], [], efforts)).toBe(doc);
    const settled = withAutomaticRuntimes(doc, undefined, entries, efforts);
    expect(withAutomaticRuntimes(settled, undefined, entries, efforts)).toBe(settled);
  });
});
