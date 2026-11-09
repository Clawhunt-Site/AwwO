// 多人同屏: a person's deliverable keeps the wires the agents made (docs/awwo-canvas-live-collaboration.md, The canvas page).
// Recording the 多人同屏 tutorial on 2026-11-07, the person added the Game deliverable to a session the agents had wired, and
// every one of its wires went, unsaid: a node with a deliverable form has only the form's ports (portsFor, nodePort).
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFormNode, emptyDocument, type CanvasDocument, type SessionNode } from '../src/canvas/canvasDoc';
import { agentNode, handIn, nodeIn, openLiveCanvas, setUpLiveCanvas, tearDownLiveCanvas, wire } from './saas-multiplayer-surface-fixture';

beforeEach(setUpLiveCanvas);
afterEach(tearDownLiveCanvas);

/** The brief and the levels feed the build; the build feeds the review, whose checklist Claude Code handed in. */
function canvas(build: Partial<SessionNode> = {}): CanvasDocument {
  const brief = { ...createFormNode({ x: 0, y: 0 }), id: 'brief', title: 'Brief', fields: [{ id: 'f1', label: 'Game', value: 'A two-character puzzle' }] };
  return { ...emptyDocument(), nodes: [brief, agentNode('levels', 'Levels', 0, 400, { lastOutput: handIn('Level 1, Lantern Path: …') }),
    agentNode('build', 'Build the game', 500, 200, { deliverablesOpen: true, ...build }), agentNode('review', 'Review', 1000, 200, { lastOutput: handIn('Checklist: …') })],
  edges: [wire('brief', 'data', 'build', 'context'), wire('levels', 'result', 'build', 'context'), wire('build', 'result', 'review', 'context')] };
}
/** Deliverables → Add a deliverable → its type → Add requirement, on the opened build, as in the tutorial. */
async function addDeliverable(type: string) {
  fireEvent.click(await screen.findByRole('button', { name: '打开 Build the game' }));
  const drawer = within(await screen.findByRole('region', { name: '交付物' }));
  fireEvent.click(drawer.getByText('添加交付要求'));
  fireEvent.change(drawer.getByRole('combobox', { name: '交付形式' }), { target: { value: type } });
  fireEvent.click(drawer.getByRole('button', { name: '添加到交付' }));
}
const wires = (doc: CanvasDocument) => doc.edges.map(edge => edge.id).sort();
const notice = () => document.querySelector('.awwo-handoff-note');

describe('a person’s deliverable on a session the agents wired', () => {
  it('keeps every wire of the build on its new ports, and what the agents handed in', async () => {
    const live = openLiveCanvas(canvas());
    await addDeliverable('game');
    await waitFor(() => expect(nodeIn(live.surface().document(), 'build').contract?.outputs.map(field => field.id)).toEqual(['delivery_game']));
    const doc = live.surface().document();
    expect(nodeIn(doc, 'build').contract!.inputs.map(field => [field.id, field.label, field.type, field.required]))
      .toEqual([['context', 'Brief', 'text', false], ['context_2', 'Levels', 'text', false]]);
    expect(wires(doc)).toEqual(['brief:data->build:in:context', 'build:out:delivery_game->review:context', 'levels:result->build:in:context_2']);
    expect(nodeIn(doc, 'levels').lastOutput).toEqual(handIn('Level 1, Lantern Path: …'));
    expect(nodeIn(doc, 'review').lastOutput).toEqual(handIn('Checklist: …'));
    expect(notice()).toBeNull();
  }, 30000);

  it('keeps the page Codex handed in for the build, which the Game deliverable fits, and the review made from it', async () => {
    const page = '<!doctype html><html><head><title>Lockstep</title></head><body><canvas id="game"></canvas></body></html>';
    const live = openLiveCanvas(canvas({ lastOutput: handIn(page) }));
    await addDeliverable('game');
    await waitFor(() => expect(nodeIn(live.surface().document(), 'build').contract?.outputs.map(field => field.id)).toEqual(['delivery_game']));
    const doc = live.surface().document();
    expect(wires(doc)).toEqual(['brief:data->build:in:context', 'build:out:delivery_game->review:context', 'levels:result->build:in:context_2']);
    expect(nodeIn(doc, 'build').lastOutput).toEqual(handIn(page));
    expect(nodeIn(doc, 'review').lastOutput).toEqual(handIn('Checklist: …'));
    expect(nodeIn(doc, 'levels').lastOutput).toEqual(handIn('Level 1, Lantern Path: …'));
  }, 30000);

  it('says which wire a deliverable form cannot carry, and Undo brings it back', async () => {
    const live = openLiveCanvas(canvas());
    // A source project is a file, which the review's text input cannot take.
    await addDeliverable('project');
    await waitFor(() => expect(notice()).toHaveTextContent('交付要求接不上这个组件的一条连线，已移除：Build the game → Review。撤销可以恢复。'));
    expect(wires(live.surface().document())).toEqual(['brief:data->build:in:context', 'levels:result->build:in:context_2']);
    fireEvent.click(screen.getByRole('button', { name: '撤销', exact: true }));
    await waitFor(() => expect(wires(live.surface().document())).toEqual(['brief:data->build:context', 'build:result->review:context', 'levels:result->build:context']));
    expect(nodeIn(live.surface().document(), 'build').contract).toBeUndefined();
  }, 30000);
});
