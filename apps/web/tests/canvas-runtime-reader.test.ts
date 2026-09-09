import { describe, expect, it, vi } from 'vitest';
import { createCanvasRuntimeReader } from '../src/canvasRuntimeReader';

describe('standalone canvas runtime discovery', () => {
  it('marks Codex for live discovery without trusting its static model count or fetching a company', async () => {
    const fetcher = vi.fn(async () => Response.json([{ type: 'codex_local', loaded: true, modelsCount: 0 }]));
    const read = createCanvasRuntimeReader('/paperclip-api', fetcher);
    expect(await read('/api/agents')).toEqual({ agents: [{
      name: 'codex_local', supports_model_selection: true, supports_effort_selection: true, model_catalog_source: 'codex_app_server',
    }] });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('gets Codex models and their effort levels from the same-origin gateway, not Node fallback lists', async () => {
    const fetcher = vi.fn(async () => Response.json({ source: 'codex_app_server', models: [
      { id: 'live-model-a', reasoningEfforts: ['low', 'ultra'], defaultReasoningEffort: 'low' },
      { id: 'live-model-b', reasoningEfforts: ['high'], defaultReasoningEffort: 'high' },
    ] }));
    const read = createCanvasRuntimeReader('/paperclip-api', fetcher);
    expect(await read('/api/agents/codex_local/models')).toEqual({
      source: 'codex_app_server', models: ['live-model-a', 'live-model-b'], model_capabilities: {
        'live-model-a': { effort_levels: ['low', 'ultra'], default_effort: 'low' },
        'live-model-b': { effort_levels: ['high'], default_effort: 'high' },
      },
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith('/gateway-api/canvas/runtimes/codex_local/models', expect.objectContaining({ credentials: 'include' }));
  });
  it('does not fall back to old Codex models when live discovery is unavailable', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: 'SECRET remote diagnostics' }), { status: 503 }));
    await expect(createCanvasRuntimeReader('/paperclip-api', fetcher)('/api/agents/codex_local/models')).rejects.toThrow('Runtime registry request failed (503)');
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([
    { source: 'static', models: [{ id: 'old-model' }] },
    { source: 'codex_app_server', models: [] },
    { source: 'codex_app_server', models: [{ id: 'live-model', reasoningEfforts: ['low'], defaultReasoningEffort: 'unsupported' }] },
    { source: 'codex_app_server', models: [{ id: 'live-model', reasoningEfforts: [1], defaultReasoningEffort: 'low' }] },
  ])('rejects malformed live metadata instead of inventing capabilities', async payload => {
    await expect(createCanvasRuntimeReader('/paperclip-api', vi.fn(async () => Response.json(payload)))('/api/agents/codex_local/models')).rejects.toThrow('Codex model catalog unavailable');
  });
  it('discovers selectable models for an adapter with an empty static catalog', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json([{ type: 'pi_local', loaded: true, modelsCount: 0 }]))
      .mockResolvedValueOnce(Response.json([{ id: 'space-a', status: 'active' }]))
      .mockResolvedValueOnce(Response.json([{ id: 'provider/dynamic-model' }]));
    const read = createCanvasRuntimeReader('/paperclip-api', fetcher);
    expect(await read('/api/agents')).toEqual({ agents: [
      { name: 'pi_local', supports_model_selection: true, supports_effort_selection: false },
    ] });
    expect(fetcher.mock.calls[2][0]).toBe('/paperclip-api/companies/space-a/adapters/pi_local/models');
  });
  it('reads available registered adapters from Node without contacting the legacy Python service', async () => {
    const fetcher = vi.fn(async () => Response.json([
      { type: 'example_local', loaded: true, disabled: false, modelsCount: 2 },
      { type: 'disabled', loaded: true, disabled: true, modelsCount: 4 },
      { type: 'not_loaded', loaded: false, disabled: false, modelsCount: 1 },
    ]));
    const read = createCanvasRuntimeReader('/paperclip-api', fetcher as typeof fetch);
    expect(await read('/api/agents')).toEqual({ agents: [
      { name: 'example_local', supports_model_selection: true, supports_effort_selection: false },
    ] });
    expect(fetcher).toHaveBeenCalledWith('/paperclip-api/adapters', expect.objectContaining({ credentials: 'include' }));
  });

  it('uses an accessible company for the real model catalog and retains model IDs verbatim', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json([{ id: 'space-a', status: 'active' }]))
      .mockResolvedValueOnce(Response.json([{ id: 'model-from-server', label: 'Example' }, { id: 'second' }]));
    const read = createCanvasRuntimeReader('/paperclip-api', fetcher);
    expect(await read('/api/agents/example_local/models')).toEqual({ models: ['model-from-server', 'second'] });
    expect(fetcher.mock.calls[1][0]).toBe('/paperclip-api/companies/space-a/adapters/example_local/models');
  });

  it('propagates authorization and malformed registry failures without returning a false empty inventory', async () => {
    const denied = createCanvasRuntimeReader('/paperclip-api', vi.fn(async () => new Response('', { status: 403 })));
    await expect(denied('/api/agents')).rejects.toThrow('403');
    const malformed = createCanvasRuntimeReader('/paperclip-api', vi.fn(async () => Response.json({ adapters: [] })));
    await expect(malformed('/api/agents')).rejects.toThrow('Invalid runtime');
  });

  it('rejects mutations and arbitrary paths before making a request', async () => {
    const fetcher = vi.fn();
    const read = createCanvasRuntimeReader('/paperclip-api', fetcher);
    await expect(read('/api/agents', { method: 'POST' })).rejects.toThrow('read-only');
    await expect(read('https://unrelated.example/models')).rejects.toThrow('Unsupported');
    expect(fetcher).not.toHaveBeenCalled();
  });
});

it('advertises node team execution only for explicit runtime capability', async () => {
  const read = createCanvasRuntimeReader('/runtime-registry', vi.fn(async () => Response.json([
    { type: 'pi', loaded: true, modelsCount: 2, supportsNodeTeams: true },
    { type: 'legacy', loaded: true, modelsCount: 2 },
  ])));
  expect(await read('/api/agents')).toEqual({ agents: [
    { name: 'pi', supports_model_selection: true, supports_effort_selection: false, supports_node_teams: true },
    { name: 'legacy', supports_model_selection: true, supports_effort_selection: false },
  ] });
});
