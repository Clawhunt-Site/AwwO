import { describe, expect, it } from 'vitest';
import { createModelNode, modelDragPayload, resolveModelDrop } from '../src/canvas/canvasModelDrop';
import { getAgentTemplates } from '../src/canvas/agentTemplates';
import type { ModelPaletteSelection } from '../src/canvas/modelPalette';

const model: ModelPaletteSelection = { key: '["pi","qwen-test"]', label: 'Qwen', providerGroup: 'clawhunt',
  runtime: 'pi', model: 'qwen-test', available: true, effort: 'high' };

describe('canvas model drops', () => {
  it('uses a concise published name while preserving the exact connected model selector', () => {
    const connected = { ...model, model: 'opaque-connection-selector', label: 'Qwen P6 · LLM Gate · primary / abc123', displayName: 'Qwen P6' };
    expect(createModelNode(connected, null, { x: 0, y: 0 }, 'zh')).toMatchObject({ title: 'Qwen P6', model: connected.model });
    expect(createModelNode(connected, 'frontend', { x: 0, y: 0 }, 'zh').title).toBe(`Qwen P6 · ${getAgentTemplates('zh').find(item => item.id === 'frontend')!.title}`);
    expect(createModelNode({ ...model, label: 'Custom · Model' }, null, { x: 0, y: 0 }, 'zh').title).toBe('Custom · Model');
  });
  it('resolves only the current workspace catalogue identity', () => {
    const raw = modelDragPayload('workspace-a', model, 'frontend');
    expect(resolveModelDrop(raw, 'workspace-a', [model])).toEqual({ model, personaId: 'frontend' });
    expect(resolveModelDrop(raw, 'workspace-b', [model])).toBeNull();
    expect(resolveModelDrop(raw, 'workspace-a', [])).toBeNull();
    expect(resolveModelDrop(raw, 'workspace-a', [{ ...model, available: false }])).toBeNull();
    expect(resolveModelDrop(JSON.stringify({ ...JSON.parse(raw), model: 'injected' }), 'workspace-a', [model])).toBeNull();
    expect(resolveModelDrop(JSON.stringify({ ...JSON.parse(raw), personaId: 'unknown' }), 'workspace-a', [model])).toBeNull();
    expect(resolveModelDrop('{', 'workspace-a', [model])).toBeNull();
  });

  it('creates an executable-model draft with persona and a neutral contract', () => {
    const node = createModelNode(model, 'frontend', { x: 10, y: 20 }, 'zh');
    expect(node).toMatchObject({ runtime: 'pi', model: 'qwen-test', effort: '', x: 10, y: 20, templateId: 'general' });
    expect(node.persona).toBe(getAgentTemplates('zh').find(item => item.id === 'frontend')!.persona);
    expect(node.contract!.inputs.filter(field => field.required).map(field => field.id)).toEqual(['brief']);
    expect(node.contract!.outputs.map(field => ({ id: field.id, type: field.type }))).toEqual([{ id: 'result', type: 'markdown' }]);
    expect(node.binding).toBeNull();
    expect(node.agentRef).toBeUndefined();
    expect(() => createModelNode({ ...model, available: false }, null, { x: 0, y: 0 }, 'zh')).toThrow();
  });
});
