import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { runtimeDefinitions, runtimeModels, type SaaSRuntimeStatus } from '../src/saas/runtimeCatalog';
import { canvasFetch, configureSaaSCanvas, clearSaaSCanvas } from '../src/saas/canvasBridge';
import { createCanvasRuntimeReader } from '../src/canvasRuntimeReader';
import { RuntimePicker, type RuntimeValue } from '../src/RuntimePicker';
import { RuntimeSettings } from '../src/saas/RuntimeSettings';
import { SaaSPreferencesProvider } from '../src/saas/preferences';
const tenant = { id: 'runtime-tenant', name: 'Runtime test', status: 'active', role: 'owner', maxConcurrentRuns: 2, maxRunsPerDay: 10 };
const status: SaaSRuntimeStatus = { engine: 'pi', available: true, configured: true,
  runtimes: [
    { id: 'pi', name: 'Pi', available: true, configured: true, supportsEffortSelection: false, tools: [] },
    { id: 'openai-agents', name: 'OpenAI Agents JS', available: true, configured: true, supportsEffortSelection: false, tools: ['calculator', 'current_time'] },
  ], models: [{ id: 'pi-model', runtime: 'pi' }, { id: 'agents-model', runtime: 'openai-agents' }, { id: 'legacy-pi' }] };
afterEach(() => { cleanup(); clearSaaSCanvas(); vi.unstubAllGlobals(); localStorage.clear(); });
function setup(payload = status) {
  configureSaaSCanvas({ tenant, canvasId: 'runtime-canvas' });
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => Response.json(payload)); vi.stubGlobal('fetch', fetch); return fetch;
}
it('scopes mixed catalogs and legacy models without leaking models across runtimes', () => {
  expect(runtimeModels(status, 'pi').map(model => model.id)).toEqual(['pi-model', 'legacy-pi']);
  expect(runtimeModels(status, 'openai-agents').map(model => model.id)).toEqual(['agents-model']);
  expect(runtimeDefinitions({ ...status, runtimes: undefined }).map(runtime => runtime.id)).toEqual(['pi']);
  expect(runtimeDefinitions({ ...status, runtimes: [] })).toEqual([]);
});
it('adapts backend runtimes to node/team capabilities and separate model catalogs', async () => {
  const fetch = setup(); const read = createCanvasRuntimeReader();
  expect(await read('/api/agents')).toEqual({ agents: [
    { name: 'pi', supports_model_selection: true, supports_effort_selection: false, supports_node_teams: true, model_catalog_source: 'saas_runtime', tools: [] },
    { name: 'openai-agents', supports_model_selection: true, supports_effort_selection: false, supports_node_teams: true, model_catalog_source: 'saas_runtime', tools: ['calculator', 'current_time'] },
  ] });
  expect(await read('/api/agents/openai-agents/models')).toEqual({ source: 'saas_runtime', models: ['agents-model'], model_capabilities: { 'agents-model': { effort_levels: [], default_effort: '' } } });
  expect(await read('/api/agents/pi/models')).toEqual({ source: 'saas_runtime', models: ['pi-model', 'legacy-pi'], model_capabilities: { 'pi-model': { effort_levels: [], default_effort: '' }, 'legacy-pi': { effort_levels: [], default_effort: '' } } });
  await expect(read('/api/agents/unknown/models')).rejects.toThrow('404');
  expect(fetch.mock.calls.every(([url]) => url === `/api/v1/tenants/${tenant.id}/runtime`)).toBe(true);
});
it('rejects unadvertised runtimes instead of borrowing the legacy Pi catalog', async () => {
  setup({ ...status, runtimes: undefined });
  expect((await canvasFetch(`/paperclip-api/companies/${tenant.id}/adapters/openai-agents/models`)).status).toBe(404);
});
it('keeps an unconfigured runtime in status while excluding it from node selection', async () => {
  setup({ ...status, runtimes: status.runtimes!.map(runtime => runtime.id === 'openai-agents'
    ? { ...runtime, available: false, configured: false, reason: 'missing provider configuration' }
    : runtime) });
  const adapters = await (await canvasFetch('/paperclip-api/adapters')).json();
  expect(adapters).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: 'pi', loaded: true, disabled: false }),
    expect.objectContaining({ type: 'openai-agents', loaded: false, disabled: true, reason: 'missing provider configuration' }),
  ]));
  expect(await createCanvasRuntimeReader()('/api/agents')).toEqual({ agents: [expect.objectContaining({ name: 'pi' })] });
});
it('uses the SaaS bridge for closed node model selection and runtime changes', async () => {
  setup(); const read = createCanvasRuntimeReader(); const changed = vi.fn();
  function Picker() {
    const [value, setValue] = useState<RuntimeValue>({ backend: 'pi', model: 'pi-model', effort: '' });
    return <RuntimePicker lang="en" runtimes={['pi', 'openai-agents']} runtimeLabels={{ pi: 'Pi', 'openai-agents': 'OpenAI Agents JS' }} value={value} readJson={read} onChange={next => { changed(next); setValue(next); }} />;
  }
  render(<Picker />); await waitFor(() => expect(screen.getByLabelText('Model')).not.toBeDisabled());
  expect(screen.getByLabelText('Model').tagName).toBe('BUTTON'); expect(screen.queryByLabelText('Effort')).toBeNull();
  fireEvent.click(screen.getByLabelText('Runtime')); fireEvent.click(await screen.findByRole('option', { name: 'OpenAI Agents JS' }));
  expect(changed).toHaveBeenLastCalledWith({ backend: 'openai-agents', model: '', effort: '' });
  await waitFor(() => expect(screen.getByLabelText('Model')).not.toBeDisabled()); fireEvent.click(screen.getByLabelText('Model'));
  expect(await screen.findByRole('option', { name: 'agents-model' })).toBeInTheDocument(); expect(screen.queryByRole('option', { name: 'pi-model' })).toBeNull();
  fireEvent.click(screen.getByRole('option', { name: 'agents-model' })); expect(changed).toHaveBeenLastCalledWith({ backend: 'openai-agents', model: 'agents-model', effort: '' });
});
it('allows server defaults for an empty catalog while preserving retired saved models', async () => {
  setup({ ...status, models: [] }); const read = createCanvasRuntimeReader(); const changed = vi.fn();
  render(<RuntimePicker lang="en" runtimes={['openai-agents']} value={{ backend: 'openai-agents', model: 'retired', effort: '' }} readJson={read} onChange={changed} />);
  await waitFor(() => expect(screen.getByLabelText('Model')).not.toBeDisabled()); fireEvent.click(screen.getByLabelText('Model'));
  expect(await screen.findByRole('option', { name: /retired/ })).toHaveAttribute('aria-disabled', 'true');
  fireEvent.click(screen.getByRole('option', { name: 'Default model' })); expect(changed).toHaveBeenCalledWith({ backend: 'openai-agents', model: '', effort: '' });
});
it('persists runtime through the legacy hiring bridge to the SaaS Agent API', async () => {
  configureSaaSCanvas({ tenant, canvasId: 'runtime-canvas' });
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ id: 'created', tenantId: tenant.id, name: 'JS Agent', runtime: 'openai-agents', model: 'agents-model' })); vi.stubGlobal('fetch', fetch);
  const response = await canvasFetch(`/paperclip-api/companies/${tenant.id}/agent-hires`, { method: 'POST', body: JSON.stringify({ name: 'JS Agent', adapterType: 'openai-agents', adapterConfig: { model: 'agents-model' } }) });
  expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toEqual({ name: 'JS Agent', adapterType: 'openai-agents', adapterConfig: { model: 'agents-model' } });
  expect(await response.json()).toMatchObject({ agent: { runtime: 'openai-agents', adapterType: 'openai-agents', model: 'agents-model' } });
});
it('shows independent runtime availability without requesting secrets or claiming model connectivity', async () => {
  localStorage.setItem('superclaw_locale', 'en'); setup({ ...status, runtimes: status.runtimes!.map(runtime => runtime.id === 'pi' ? { ...runtime, available: false } : runtime) });
  render(<SaaSPreferencesProvider><RuntimeSettings tenantId={tenant.id} onClose={vi.fn()} /></SaaSPreferencesProvider>);
  const pi = await screen.findByRole('region', { name: 'Pi' }); const agents = screen.getByRole('region', { name: 'OpenAI Agents JS' });
  expect(within(pi).getByText('Unavailable')).toBeVisible(); expect(within(pi).getByText('pi-model, legacy-pi')).toBeVisible();
  expect(within(agents).getByText('Configured')).toBeVisible(); expect(within(agents).getByText('agents-model')).toBeVisible();
  expect(screen.queryAllByRole('textbox')).toHaveLength(0); expect(screen.getByText(/an actual canvas run verifies model connectivity/)).toBeVisible();
});

const effortStatus: SaaSRuntimeStatus = { ...status,
  runtimes: status.runtimes!.map(runtime => runtime.id === 'openai-agents' ? { ...runtime, supportsEffortSelection: true } : runtime),
  models: [{ id: 'pi-model', runtime: 'pi' },
    { id: 'agents-model', runtime: 'openai-agents', reasoningEfforts: ['low', 'high', 'high', 'Bad Level'], defaultReasoningEffort: 'low' },
    { id: 'plain-model', runtime: 'openai-agents', reasoningEfforts: [], defaultReasoningEffort: '' }] };
it('advertises reasoning effort per model as a closed enum and never for a runtime whose models lack levels', async () => {
  setup(effortStatus); const read = createCanvasRuntimeReader();
  expect(runtimeDefinitions(effortStatus).map(runtime => [runtime.id, runtime.supportsEffortSelection])).toEqual([['pi', false], ['openai-agents', true]]);
  // A flag without any advertised level is not trusted: the picker would only offer a control the server refuses.
  expect(runtimeDefinitions({ ...effortStatus, models: [{ id: 'agents-model', runtime: 'openai-agents' }] }).find(runtime => runtime.id === 'openai-agents')!.supportsEffortSelection).toBe(false);
  const adapters = await (await canvasFetch('/paperclip-api/adapters')).json();
  expect(adapters.find((item: any) => item.type === 'openai-agents').supportsEffortSelection).toBe(true);
  expect(adapters.find((item: any) => item.type === 'pi').supportsEffortSelection).toBe(false);
  expect(await read('/api/agents')).toEqual({ agents: [
    expect.objectContaining({ name: 'pi', supports_effort_selection: false }),
    expect.objectContaining({ name: 'openai-agents', supports_effort_selection: true }),
  ] });
  expect(await read('/api/agents/openai-agents/models')).toEqual({ source: 'saas_runtime', models: ['agents-model', 'plain-model'],
    model_capabilities: { 'agents-model': { effort_levels: ['low', 'high'], default_effort: 'low' }, 'plain-model': { effort_levels: [], default_effort: '' } } });
});
it('offers only the chosen model\'s advertised effort levels and resets effort when the model changes', async () => {
  setup(effortStatus); const read = createCanvasRuntimeReader(); const changed = vi.fn();
  function Picker() {
    const [value, setValue] = useState<RuntimeValue>({ backend: 'openai-agents', model: 'agents-model', effort: '' });
    return <RuntimePicker lang="en" runtimes={['pi', 'openai-agents']} runtimeLabels={{ pi: 'Pi', 'openai-agents': 'OpenAI Agents JS' }} value={value} readJson={read} onChange={next => { changed(next); setValue(next); }} />;
  }
  render(<Picker />); await waitFor(() => expect(screen.getByLabelText('Effort')).not.toBeDisabled());
  fireEvent.click(screen.getByLabelText('Effort'));
  expect((await screen.findAllByRole('option')).map(option => option.textContent)).toEqual(['Inherit (runtime default) · low', 'low', 'high']);
  fireEvent.click(screen.getByRole('option', { name: 'high' }));
  expect(changed).toHaveBeenLastCalledWith({ backend: 'openai-agents', model: 'agents-model', effort: 'high' });
  // A model without levels keeps the control but offers nothing, and drops the stale level.
  await waitFor(() => expect(screen.getByLabelText('Model')).not.toBeDisabled()); fireEvent.click(screen.getByLabelText('Model'));
  fireEvent.click(await screen.findByRole('option', { name: 'plain-model' }));
  expect(changed).toHaveBeenLastCalledWith({ backend: 'openai-agents', model: 'plain-model', effort: '' });
  expect(screen.getByLabelText('Effort')).toBeDisabled();
});
it('keeps a saved effort the runtime no longer advertises visible and clearable without offering it', async () => {
  setup(status); const read = createCanvasRuntimeReader(); const changed = vi.fn();
  function Picker() {
    const [value, setValue] = useState<RuntimeValue>({ backend: 'openai-agents', model: 'agents-model', effort: 'high' });
    return <RuntimePicker lang="en" runtimes={['pi', 'openai-agents']} runtimeLabels={{ pi: 'Pi', 'openai-agents': 'OpenAI Agents JS' }} value={value} readJson={read} onChange={next => { changed(next); setValue(next); }} />;
  }
  render(<Picker />); await waitFor(() => expect(screen.getByLabelText('Effort')).not.toBeDisabled());
  fireEvent.click(screen.getByLabelText('Effort'));
  expect(await screen.findByRole('option', { name: /high/ })).toHaveAttribute('aria-disabled', 'true');
  fireEvent.click(screen.getByRole('option', { name: 'Inherit (runtime default)' }));
  expect(changed).toHaveBeenLastCalledWith({ backend: 'openai-agents', model: 'agents-model', effort: '' });
  await waitFor(() => expect(screen.queryByLabelText('Effort')).toBeNull());
});
