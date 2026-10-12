// A media node's result feeding a text input is the canvas's one soft dependency (ports.ts isSoftMediaFeed, the API's
// softMediaEdge): a picture, clip or model that was not made leaves the page a note instead of holding it back, so a
// refused or failed generation never costs the page that would have shown it.
import { describe, expect, it } from 'vitest';
import { createSessionNode, type CanvasEdge, type SessionNode } from '../src/canvas/canvasDoc';
import { mediaInputText, mediaMissingText } from '../src/canvas/mediaOutput';
import { prepareNodeConversation } from '../src/canvas/nodeConversation';
import { isSoftMediaFeed } from '../src/canvas/ports';
import { runGraph, type RunNodeStatus } from '../src/canvas/runGraph';

const RECORD = JSON.stringify({ type: 'awwo.media', version: 1, kind: 'image', model: 'xt.seedream-5-pro',
  items: [{ artifactId: 'aAAAAAAAAAAA', name: 'image-1.png', contentType: 'image/png', size: 2048 }] });
const MISSING = '「主视觉」这次没有生成出图片文件，没有可以引用的路径：网页里不要引用它的任何文件，也不要编造文件名，用不依赖它的设计完成。';

function picture(id: string, lastOutput?: SessionNode['lastOutput']): SessionNode {
  return { ...createSessionNode('image', { x: 0, y: 0 }), id, title: '主视觉', model: 'xt.seedream-5-pro',
    binding: { companyId: 'c1', agentId: `ag-${id}`, agentName: id }, ...(lastOutput ? { lastOutput } : {}) };
}
function page(id: string, contract = false): SessionNode {
  const base: SessionNode = { ...createSessionNode('coding', { x: 700, y: 0 }), id, title: '页面', runtime: 'claude_local',
    binding: { companyId: 'c1', agentId: `ag-${id}`, agentName: id } };
  return contract ? { ...base, contract: { version: 1,
    inputs: [{ id: 'art', label: '主视觉', type: 'markdown', required: true, value: '' }],
    outputs: [{ id: 'result', label: '页面', type: 'markdown', required: true, value: '' }] } } : base;
}
function wire(from: string, to: string, toPort: string, dataType: CanvasEdge['dataType'] = 'image'): CanvasEdge {
  return { id: `${from}:result->${to}:${toPort}`, fromNode: from, fromPort: 'result', toNode: to, toPort, dataType };
}

describe('soft media feed', () => {
  it('is only a media result into a text input', () => {
    const hero = picture('hero');
    expect(isSoftMediaFeed(hero, page('page'), { fromPort: 'result', toPort: 'context' })).toBe(true);
    expect(isSoftMediaFeed(hero, page('page', true), { fromPort: 'result', toPort: 'in:art' })).toBe(true);
    // A picture as another picture's reference, and text into text, still hold their target back.
    expect(isSoftMediaFeed(hero, picture('edit'), { fromPort: 'result', toPort: 'reference' })).toBe(false);
    expect(isSoftMediaFeed(page('plan'), page('page'), { fromPort: 'result', toPort: 'context' })).toBe(false);
  });

  it('reads the files that were made, or the note the API writes when none was', () => {
    const hero = picture('hero');
    expect(mediaMissingText(hero)).toBe(MISSING);
    expect(mediaInputText(hero, RECORD)).toContain('- hero/image-1.png');
    expect(mediaInputText(hero, '')).toBe(MISSING);
    expect(mediaInputText(hero, undefined)).toBe(MISSING);
  });

  it('makes the page without a picture whose generation failed, and fails only the picture', async () => {
    const statuses: Record<string, RunNodeStatus['state']> = {};
    const messages: Record<string, string> = {};
    const summary = await runGraph({
      nodes: [picture('hero'), page('page')],
      edges: [wire('hero', 'page', 'context')],
      execAgent: async (node, message) => {
        messages[node.id] = message;
        return node.id === 'hero' ? { ok: false, output: '', detail: 'media_quota_exceeded' } : { ok: true, output: 'PAGE' };
      },
      onStatus: (id, status) => { statuses[id] = status.state; },
    });
    expect(statuses).toMatchObject({ hero: 'failed', page: 'done' });
    expect(messages.page).toContain(MISSING);
    expect(summary).toMatchObject({ done: 1, failed: 1, blocked: 0 });
  });

  it('still blocks a picture whose reference picture failed', async () => {
    const statuses: Record<string, RunNodeStatus['state']> = {};
    await runGraph({
      nodes: [picture('hero'), picture('edit')],
      edges: [wire('hero', 'edit', 'reference')],
      execAgent: async () => ({ ok: false, output: '', detail: 'media_quota_exceeded' }),
      onStatus: (id, status) => { statuses[id] = status.state; },
    });
    expect(statuses).toMatchObject({ hero: 'failed', edit: 'blocked' });
  });

  it("lets a node's own Send go on when its wired picture made nothing", () => {
    const target = page('page', true);
    for (const hero of [picture('hero'), picture('hero', { text: '', at: 1 }), picture('hero', { text: RECORD, at: 1, partial: true })]) {
      const prepared = prepareNodeConversation(target, [hero, target], [wire('hero', 'page', 'in:art')]);
      expect(prepared.error).toBeUndefined();
      expect(prepared.inputs?.find(field => field.id === 'art')?.value).toBe(MISSING);
      expect(prepared.messagePrefix).toContain(MISSING);
    }
    const made = prepareNodeConversation(target, [picture('hero', { text: RECORD, at: 1 }), target], [wire('hero', 'page', 'in:art')]);
    expect(made.inputs?.find(field => field.id === 'art')?.value).toContain('- hero/image-1.png');
  });
});
