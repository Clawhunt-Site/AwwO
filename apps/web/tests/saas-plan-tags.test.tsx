import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { withPlanTag, type SaaSRuntimeStatus } from '../src/saas/runtimeCatalog';
import { configureSaaSCanvas, clearSaaSCanvas } from '../src/saas/canvasBridge';
import { createCanvasRuntimeReader } from '../src/canvasRuntimeReader';
import { RuntimePicker } from '../src/RuntimePicker';
import { NodeTeamEditor } from '../src/canvas/NodeTeamEditor';
import { createSessionNode, type SessionNode } from '../src/canvas/canvasDoc';
import { createNodeTeam } from '../src/canvas/nodeTeam';
import { LocaleProvider } from '../src/canvas/i18n';
import { groupModels } from '../src/canvas/modelPalette';
import { readOfficialCopyModels } from '../src/saas/examples/OfficialCopySetup';

// Owner request 2026-10-10: free users kept picking Claude and GPT, which the free plan does not include, and their runs
// were refused. The server marks such a model requiresUpgrade for the workspace; every picker shows it tagged "Pro".
const tenant = { id: 'plan-tag-tenant', name: 'Plan tags', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 30 };
const freeTier: SaaSRuntimeStatus = { engine: 'pi', available: true, configured: true,
  runtimes: [{ id: 'pi', name: 'Pi', available: true, configured: true, supportsEffortSelection: false, tools: [] }],
  models: [
    { id: 'qwen3.8-27b-p6', name: 'Qwen 3.8', runtime: 'pi', route: 'free' },
    { id: 'claude-opus-5', name: 'Claude Opus 5', label: 'Claude Opus 5', runtime: 'pi', route: 'gate', requiresUpgrade: true },
    { id: 'bedrock.claude-opus-5-5', name: 'Claude Opus 5.5', runtime: 'pi', route: 'bedrock', requiresUpgrade: true },
  ] };
afterEach(() => { cleanup(); clearSaaSCanvas(); vi.unstubAllGlobals(); localStorage.clear(); });
function setup(payload: SaaSRuntimeStatus) {
  configureSaaSCanvas({ tenant, canvasId: 'plan-tag-canvas' });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(payload)));
}

it('tags only what the server marks, and only the shown text', () => {
  expect(withPlanTag('Claude Opus 5', { requiresUpgrade: true })).toBe('Claude Opus 5 · Pro');
  expect(withPlanTag('Qwen 3.8', {})).toBe('Qwen 3.8');
  expect(withPlanTag('Claude Opus 5', { requiresUpgrade: false })).toBe('Claude Opus 5');
});

it('shows Pro on premium models in the node model picker and the team member picker, selecting by id', async () => {
  setup(freeTier);
  const read = createCanvasRuntimeReader();
  const catalog = await read('/api/agents/pi/models');
  expect(catalog.models).toEqual(['qwen3.8-27b-p6', 'claude-opus-5', 'bedrock.claude-opus-5-5']);
  // A model without a label of its own is tagged from its name; an untagged one keeps the picker's own fallback.
  expect(catalog.model_labels).toEqual({ 'claude-opus-5': 'Claude Opus 5 · Pro', 'bedrock.claude-opus-5-5': 'Claude Opus 5.5 · Pro' });
  const changed = vi.fn();
  const view = render(<RuntimePicker lang="en" runtimes={['pi']} value={{ backend: 'pi', model: 'qwen3.8-27b-p6', effort: '' }} onChange={changed} readJson={read} />);
  await waitFor(() => expect(screen.getByLabelText('Model')).not.toBeDisabled());
  fireEvent.click(screen.getByLabelText('Model'));
  fireEvent.click(await screen.findByRole('option', { name: 'Claude Opus 5 · Pro' }));
  expect(changed).toHaveBeenLastCalledWith({ backend: 'pi', model: 'claude-opus-5', effort: '' });
  view.unmount();
  const node: SessionNode = { ...createSessionNode('llm', { x: 0, y: 0 }), runtime: 'pi', model: 'qwen3.8-27b-p6' };
  node.team = createNodeTeam(node);
  render(<LocaleProvider locale="en"><NodeTeamEditor node={node} available readJson={read} onChange={changed} /></LocaleProvider>);
  const selects = await screen.findAllByLabelText('Model');
  await waitFor(() => expect(within(selects[0]).getByRole('option', { name: 'Claude Opus 5.5 · Pro' })).toBeEnabled());
  expect(within(selects[0]).getByRole('option', { name: 'qwen3.8-27b-p6' })).toBeEnabled();
});

it('tags the model shelf and the official-copy picker, but never the title a dropped model gives its node', async () => {
  const models = groupModels(freeTier, 'en').flatMap(group => group.models);
  const opus = models.find(model => model.model === 'claude-opus-5')!;
  expect(opus.label).toBe('Claude Opus 5 · Pro');
  expect(opus.displayName).toBe('Claude Opus 5');
  expect(models.find(model => model.model === 'qwen3.8-27b-p6')!.label).toBe('Qwen 3.8');
  setup(freeTier);
  // The copy dialog names models without the runtime AwwO runs them on (nodeRuntime.ts).
  expect((await readOfficialCopyModels(tenant.id)).map(model => model.label)).toEqual(['Qwen 3.8', 'Claude Opus 5 · Pro', 'Claude Opus 5.5 · Pro']);
});

it('shows no tag when the workspace may use every model (a paid plan, or no route limits)', async () => {
  const paid: SaaSRuntimeStatus = { ...freeTier, models: freeTier.models.map(({ requiresUpgrade: _drop, ...model }) => model) };
  setup(paid);
  const catalog = await createCanvasRuntimeReader()('/api/agents/pi/models');
  expect(Object.values(catalog.model_labels ?? {}).some(label => label.includes('Pro'))).toBe(false);
  expect(groupModels(paid, 'en').flatMap(group => group.models).map(model => model.label).sort()).toEqual(['Claude Opus 5', 'Claude Opus 5.5', 'Qwen 3.8']);
});
