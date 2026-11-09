// 多人同屏: a person's model pick keeps what the agents handed in (docs/awwo-canvas-live-collaboration.md, The canvas page).
// Recording the 多人同屏 tutorial on 2026-11-07, the person picked a model for a node that had never run, and the result an
// agent had handed in below it was emptied (invalidateOutputs took any change of a node's settings to make everything
// below it stale). Agents cannot pick models, so the person's own required step undid the agent's work.
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFormNode, emptyDocument, type CanvasDocument, type NodeOutput } from '../src/canvas/canvasDoc';
import { agentNode, handIn, nodeIn, openLiveCanvas, setUpLiveCanvas, tearDownLiveCanvas, wire } from './saas-multiplayer-surface-fixture';

beforeEach(setUpLiveCanvas);
afterEach(tearDownLiveCanvas);

/** Claude Code's canvas: the brief and the rules (never run) feed the levels, which Codex holds. */
function canvas(): CanvasDocument {
  const brief = { ...createFormNode({ x: 0, y: 0 }), id: 'brief', title: 'Brief', fields: [{ id: 'f1', label: 'Game', value: 'A two-character puzzle' }] };
  return { ...emptyDocument(), nodes: [brief, agentNode('rules', 'Rules and feel', 0, 400), agentNode('levels', 'Levels', 500, 200)],
    edges: [wire('brief', 'data', 'levels', 'context'), wire('rules', 'result', 'levels', 'context')] };
}
const handedIn = (id: string, output: NodeOutput) => (doc: CanvasDocument): CanvasDocument =>
  ({ ...doc, nodes: doc.nodes.map(node => node.id === id ? { ...node, lastOutput: output } : node) });
/** The person's pick on the node's own card, as in the tutorial. */
async function pick(title: string, model: string) {
  fireEvent.click(await screen.findByRole('button', { name: `打开 ${title}` }));
  const picker = await screen.findByRole('combobox', { name: '这个组件使用的模型' });
  const option = await within(picker).findByRole('option', { name: model });
  fireEvent.change(picker, { target: { value: (option as HTMLOptionElement).value } });
}

describe('a person’s model pick on a 多人同屏 canvas', () => {
  it('keeps the levels an agent handed in when the person picks a model for the rules, which never ran', async () => {
    const live = openLiveCanvas(canvas());
    await screen.findByTestId('canvas-tile-levels');
    live.othersChange(handedIn('levels', handIn('Level 1, Lantern Path: …')));
    expect(nodeIn(live.surface().document(), 'levels').lastOutput?.text).toBe('Level 1, Lantern Path: …');
    await pick('Rules and feel', 'Opus fixture');
    await waitFor(() => expect(nodeIn(live.surface().document(), 'rules').model).toBe('opus-fixture'));
    // What this page holds, and so sends: the hand-in is still there.
    expect(nodeIn(live.surface().document(), 'levels').lastOutput).toEqual(handIn('Level 1, Lantern Path: …'));
  }, 30000);

  it('keeps an agent’s hand-in when the person picks a model for that node itself', async () => {
    const live = openLiveCanvas(canvas());
    await screen.findByTestId('canvas-tile-levels');
    live.othersChange(handedIn('levels', handIn('Level 1, Lantern Path: …')));
    await pick('Levels', 'Qwen fixture');
    await waitFor(() => expect(nodeIn(live.surface().document(), 'levels').model).toBe('qwen-fixture'));
    expect(nodeIn(live.surface().document(), 'levels').lastOutput).toEqual(handIn('Level 1, Lantern Path: …'));
  }, 30000);

  it('keeps an agent’s hand-in on a node already set up when the person picks it another model, in the new conversation that opens', async () => {
    const doc = canvas();
    const setUp = { ...doc, nodes: doc.nodes.map(node => node.id === 'levels'
      ? { ...node, issueId: 'issue-levels', binding: { companyId: 'company-mp', agentId: 'agent-levels', agentName: 'Levels' } } : node) };
    const live = openLiveCanvas(setUp);
    await screen.findByTestId('canvas-tile-levels');
    live.othersChange(handedIn('levels', handIn('Level 1, Lantern Path: …')));
    await pick('Levels', 'Qwen fixture');
    await waitFor(() => expect(nodeIn(live.surface().document(), 'levels').model).toBe('qwen-fixture'));
    const levels = nodeIn(live.surface().document(), 'levels');
    // Its Agent was set up with the earlier model: a new conversation opens, not bound, as it always has.
    expect(levels.binding).toBeNull();
    expect(levels.activeThreadId).toMatch(/^thread-/);
    expect(levels.lastOutput).toEqual(handIn('Level 1, Lantern Path: …'));
  }, 30000);
});
