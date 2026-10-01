import { describe, expect, it } from 'vitest';
import { appendDeliveryProfile, deliveryProfiles } from '../src/canvas/deliveryProfiles';
import { createAgentTemplate, AGENT_TEMPLATES } from '../src/canvas/agentTemplates';

describe('delivery requirements are independent from persona', () => {
  it('can add every delivery type to every existing role without replacing inputs, outputs or persona', () => {
    for (const template of AGENT_TEMPLATES) {
      const node = createAgentTemplate(template.id, { x: 0, y: 0 });
      const before = structuredClone(node);
      for (const profile of deliveryProfiles()) {
        const contract = appendDeliveryProfile(node.contract!, profile.id);
        expect(contract.inputs).toEqual(before.contract!.inputs);
        expect(contract.outputs.slice(0, before.contract!.outputs.length)).toEqual(before.contract!.outputs);
        expect(contract.outputs.find(field => field.id === profile.field.id)).toMatchObject({ type: profile.field.type, required: true, value: '' });
      }
      expect(node).toEqual(before);
    }
  });

  it('preserves a user-owned field with the same ID and never manufactures a published result', () => {
    const node = createAgentTemplate('general', { x: 0, y: 0 });
    node.contract!.outputs.push({ id: 'delivery_game', label: 'Custom evidence', type: 'markdown', required: false, value: 'keep', help: 'Operator instructions' });
    const contract = appendDeliveryProfile(node.contract!, 'game');
    expect(contract.outputs.at(-2)).toEqual(node.contract!.outputs.at(-1));
    expect(contract.outputs.at(-1)).toMatchObject({ id: 'delivery_game_2', type: 'html', value: '' });
    expect(appendDeliveryProfile(contract, 'game')).toBe(contract);
    expect(node.lastOutput).toBeUndefined();
  });

  it('does not duplicate an unchanged requirement', () => {
    const contract = createAgentTemplate('general', { x: 0, y: 0 }).contract!;
    const once = appendDeliveryProfile(contract, 'web');
    expect(appendDeliveryProfile(once, 'web')).toBe(once);
  });

  it('keeps generated fields inside the existing persisted contract vocabulary', () => {
    const node = createAgentTemplate('general', { x: 0, y: 0 });
    for (const profile of deliveryProfiles()) node.contract = appendDeliveryProfile(node.contract!, profile.id);
    expect(node.contract!.outputs.map(field => field.type)).toEqual(['markdown', 'markdown', 'html', 'html', 'file', 'html', 'markdown', 'file', 'file', 'file']);
    expect(node.contract!.outputs.every(field => field.value === '')).toBe(true);
  });

  it('keeps a required real 3D file beside an optional self-contained viewer and a report beside its optional PDF', () => {
    const profiles = deliveryProfiles('en');
    const model = profiles.find(profile => profile.id === 'model3d')!;
    expect(model.field).toMatchObject({ type: 'file', required: true });
    expect(model.companions).toEqual([expect.objectContaining({ type: 'html', required: false })]);
    const report = profiles.find(profile => profile.id === 'report')!;
    expect(report.field).toMatchObject({ type: 'markdown', required: true });
    expect(report.companions).toEqual([expect.objectContaining({ type: 'file', required: false })]);
  });

  it('fails without mutating the contract when the server field or file budget is exhausted', () => {
    const contract = createAgentTemplate('general', { x: 0, y: 0 }).contract!;
    const fields = Array.from({ length: 32 }, (_, index) => ({ id: `field_${index}`, label: 'Existing', type: 'markdown' as const, required: false, value: '' }));
    const full = { ...contract, outputs: fields };
    expect(() => appendDeliveryProfile(full, 'report')).toThrow('32');
    expect(full.outputs).toBe(fields);
    const files = { ...contract, outputs: fields.slice(0, 8).map(field => ({ ...field, type: 'file' as const })) };
    expect(() => appendDeliveryProfile(files, 'project')).toThrow('8');
    expect(files.outputs).toHaveLength(8);
  });
});
