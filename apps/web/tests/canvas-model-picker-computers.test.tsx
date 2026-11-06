// The model picker in an open node's message box (NodeModelPicker, CanvasSurface changeNodeModel) on a node that works
// in a computer of its own: the Blender workstation (runtime 'blender') or a sandbox computer ('sandbox'). That computer
// is the node's own choice, made and undone only by its settings' switch (nodeRuntime.ts computerRuntime), so a pick
// there changes the node's model and keeps it on its computer, among the models that computer offers, as Configure
// (InspectorPanel withModelChoice), the canvas assistant (canvasPlan.ts set_model) and a case copy do. A plain node still
// takes each model on the runtime AwwO runs it on.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CanvasSurface } from '../src/canvas/CanvasSurface';
import { CanvasUiModeProvider } from '../src/canvas/uiMode';
import { CANVAS_STORAGE_KEY, createSessionNode, emptyDocument, loadDocumentWithStatus, type SessionNode } from '../src/canvas/canvasDoc';
import { canvasStorage, configureCanvasStorage } from '../src/canvas/canvasStorage';
import { clearSaaSCanvas, configureSaaSCanvas } from '../src/saas/canvasBridge';
import { resetAllSessions } from '../src/canvas/sessions';

const tenant = { id: 'workspace', name: 'Workspace', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 100 };
const OPUS = 'bedrock.claude-opus-5-5', SONNET = 'bedrock.claude-sonnet-5-5', HAIKU = 'bedrock.claude-haiku-5-5', QWEN = 'qwen3.8-27b-p6';
const computer = { version: 1, available: true, maxModelCalls: 64 };
// Opus runs everywhere; Sonnet in the workstation, not in the sandbox; Haiku in the sandbox, not in the workstation; Qwen
// on Pi only.
const status = { configured: true, available: true, plannerAvailable: true,
  models: [
    { id: OPUS, name: 'Claude Opus 5.5', runtime: 'openai-agents', provider: 'anthropic' },
    { id: OPUS, name: 'Claude Opus 5.5', runtime: 'sandbox', provider: 'anthropic' },
    { id: OPUS, name: 'Claude Opus 5.5', runtime: 'blender', provider: 'anthropic' },
    { id: SONNET, name: 'Claude Sonnet 5.5', runtime: 'openai-agents', provider: 'anthropic' },
    { id: SONNET, name: 'Claude Sonnet 5.5', runtime: 'blender', provider: 'anthropic' },
    { id: HAIKU, name: 'Claude Haiku 5.5', runtime: 'openai-agents', provider: 'anthropic' },
    { id: HAIKU, name: 'Claude Haiku 5.5', runtime: 'sandbox', provider: 'anthropic' },
    { id: QWEN, name: 'Qwen 3.8 27B', runtime: 'pi', provider: 'llmgate' },
  ],
  runtimes: [
    { id: 'pi', name: 'Pi', configured: true, available: true, tools: [] },
    { id: 'openai-agents', name: 'OpenAI Agents', configured: true, available: true, tools: [] },
    { id: 'sandbox', name: 'Sandbox computer', configured: true, available: true, tools: [], workspace: computer },
    { id: 'blender', name: 'Blender workstation', configured: true, available: true, tools: [], workspace: computer },
  ] };
const capabilities = { skills: { enabled: true, maxNodeSkills: 4, maxNodeSkillBytes: 20480 }, memory: { enabled: false, maxRunItems: 0, maxRunBytes: 0, maxPerScope: 0 },
  webReader: { enabled: false, perDay: 0, usedToday: 0 }, render: { enabled: false, perDay: 0, usedToday: 0, limits: { maxSeconds: 20, maxFps: 60, maxWidth: 1920, maxHeight: 1920, maxFrames: 1800, maxHtmlBytes: 1 } } };
const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { 'Content-Type': 'application/json' } });

function serve() {
  vi.stubGlobal('fetch', vi.fn(async (input: string | Request) => {
    const url = String(input);
    if (url.endsWith('/runtime')) return json(status);
    if (url.endsWith('/capabilities')) return json(capabilities);
    return json({ items: [] });
  }));
}
const agent = (id: string, title: string, runtime: string): SessionNode =>
  ({ ...createSessionNode('llm', { x: 0, y: 0 }), id, title, runtime, model: OPUS, effort: 'high' });
function seed(node: SessionNode) {
  canvasStorage().setItem(CANVAS_STORAGE_KEY, JSON.stringify({ ...emptyDocument(), nodes: [node] }));
}
const stored = (id: string) => loadDocumentWithStatus().doc.nodes.find(node => node.id === id) as SessionNode;
const view = () => render(<CanvasUiModeProvider mode="simple"><CanvasSurface storageMode="cloud" runtimeReadJson={async () => ({ agents: [], models: [] })} /></CanvasUiModeProvider>);

/** The open node's picker, once it lists the workspace's models. */
async function openPicker(title: string) {
  fireEvent.click(await screen.findByRole('button', { name: `打开 ${title}` }));
  const picker = await screen.findByRole('combobox', { name: '这个组件使用的模型' });
  await waitFor(() => expect(within(picker).getAllByRole('option').length).toBeGreaterThan(1));
  return picker as HTMLSelectElement;
}
const listed = (picker: HTMLSelectElement) => within(picker).getAllByRole('option').map(option => option.textContent);
/** Picks the model the picker names `label`, whatever its option's value. */
function pick(picker: HTMLSelectElement, label: string) {
  const option = within(picker).getByRole('option', { name: label }) as HTMLOptionElement;
  fireEvent.change(picker, { target: { value: option.value } });
}
/** Picks `runtime`'s entry for `model` as a list drawn before the node moved would offer it (another tab's change that
 *  this tab took in before drawing again): the option is added to the picker for the pick, then taken out. */
function pickStale(picker: HTMLSelectElement, runtime: string, model: string) {
  const option = document.createElement('option');
  option.value = JSON.stringify([runtime, model]);
  option.textContent = `${model} (stale)`;
  picker.appendChild(option);
  fireEvent.change(picker, { target: { value: option.value } });
  option.remove();
}

beforeEach(() => {
  localStorage.clear(); resetAllSessions(); configureCanvasStorage('user', tenant.id, 'canvas');
  configureSaaSCanvas({ tenant, canvasId: 'canvas' });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  serve();
});
afterEach(() => { cleanup(); clearSaaSCanvas(); resetAllSessions(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('keeps a Blender workstation node in its workstation, among the models the workstation offers', async () => {
  seed(agent('maker', 'Ring maker', 'blender'));
  view();
  const picker = await openPicker('Ring maker');
  expect(screen.getByTestId('blender-badge-maker')).toBeVisible();
  expect(picker.selectedOptions[0]?.textContent).toBe('Claude Opus 5.5');
  pick(picker, 'Claude Sonnet 5.5');
  // The node takes the model and stays in its workstation (it had moved to OpenAI Agents, losing Blender and its GPU).
  await waitFor(() => expect(stored('maker')).toMatchObject({ runtime: 'blender', model: SONNET, effort: '' }));
  expect(screen.getByTestId('blender-badge-maker')).toBeVisible();
  const after = await screen.findByRole('combobox', { name: '这个组件使用的模型' }) as HTMLSelectElement;
  expect(after.selectedOptions[0]?.textContent).toBe('Claude Sonnet 5.5');
  // The workstation's models only: Haiku runs in the sandbox but not here, and Qwen only on Pi.
  expect(listed(after)).toEqual(['Claude Opus 5.5', 'Claude Sonnet 5.5']);
});

it('keeps a sandbox node in its sandbox computer, among the models the sandbox offers', async () => {
  seed(agent('builder', 'Site builder', 'sandbox'));
  view();
  const picker = await openPicker('Site builder');
  expect(screen.getByTestId('sandbox-badge-builder')).toBeVisible();
  pick(picker, 'Claude Haiku 5.5');
  await waitFor(() => expect(stored('builder')).toMatchObject({ runtime: 'sandbox', model: HAIKU, effort: '' }));
  expect(screen.getByTestId('sandbox-badge-builder')).toBeVisible();
  // Sonnet runs in the workstation but not in the sandbox.
  expect(listed(await screen.findByRole('combobox', { name: '这个组件使用的模型' }) as HTMLSelectElement)).toEqual(['Claude Opus 5.5', 'Claude Haiku 5.5']);
});

it('keeps a workstation node there when the pick comes from a list drawn before it moved there', async () => {
  seed(agent('maker', 'Ring maker', 'blender'));
  view();
  const picker = await openPicker('Ring maker');
  // The chat list's entry for the model the node runs already: nothing changes, its effort included.
  pickStale(picker, 'openai-agents', OPUS);
  expect(stored('maker')).toMatchObject({ runtime: 'blender', model: OPUS, effort: 'high' });
  // A model the workstation does not offer: the node stays as it was.
  pickStale(picker, 'openai-agents', HAIKU);
  expect(stored('maker')).toMatchObject({ runtime: 'blender', model: OPUS, effort: 'high' });
  // One it offers: the node takes it in the workstation.
  pickStale(picker, 'openai-agents', SONNET);
  await waitFor(() => expect(stored('maker')).toMatchObject({ runtime: 'blender', model: SONNET, effort: '' }));
});

it('keeps a plain node out of a computer when the pick comes from a list drawn while it was in one', async () => {
  seed(agent('writer', 'Writer', 'openai-agents'));
  view();
  const picker = await openPicker('Writer');
  pickStale(picker, 'blender', SONNET);
  pickStale(picker, 'sandbox', HAIKU);
  expect(stored('writer')).toMatchObject({ runtime: 'openai-agents', model: OPUS, effort: 'high' });
  pick(picker, 'Claude Sonnet 5.5');
  await waitFor(() => expect(stored('writer')).toMatchObject({ runtime: 'openai-agents', model: SONNET, effort: '' }));
});

it('still puts a plain node on the runtime AwwO runs the picked model on, and never into a computer', async () => {
  seed(agent('writer', 'Writer', 'openai-agents'));
  view();
  const picker = await openPicker('Writer');
  expect(listed(picker)).toEqual(['Claude Opus 5.5', 'Claude Sonnet 5.5', 'Claude Haiku 5.5', 'Qwen 3.8 27B']);
  pick(picker, 'Qwen 3.8 27B');
  await waitFor(() => expect(stored('writer')).toMatchObject({ runtime: 'pi', model: QWEN, effort: '' }));
  pick(await screen.findByRole('combobox', { name: '这个组件使用的模型' }) as HTMLSelectElement, 'Claude Sonnet 5.5');
  await waitFor(() => expect(stored('writer')).toMatchObject({ runtime: 'openai-agents', model: SONNET }));
});
