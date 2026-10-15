// A hosted node's Configure model and effort picker (NodeModelSettings): the levels it offers are the automatic
// runtime's, so choosing one also moves a node AwwO set up elsewhere there; a team keeps the runtime it is set up on
// (Codex review 2026-10-15: a legacy Pi node saved an effort only openai-agents has, which node setup refuses).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NodeModelSettings } from '../src/canvas/NodeModelSettings';
import type { ModelPaletteGroup } from '../src/canvas/modelPalette';

const groups: ModelPaletteGroup[] = [{ id: 'anthropic', label: 'Anthropic', available: true, models: [
  { key: 'opus', label: 'Claude Opus 5.5', providerGroup: 'anthropic', runtime: 'openai-agents', model: 'bedrock.claude-opus-5-5', available: true, efforts: ['low', 'medium', 'high'] },
] }];

afterEach(() => cleanup());

describe('the effort a node runs its model with', () => {
  it('moves a node set up on another runtime to the one whose levels it chose', () => {
    const change = vi.fn();
    render(<NodeModelSettings node={{ runtime: 'pi', model: 'bedrock.claude-opus-5-5', effort: '' }} groups={groups} onChange={change} />);
    fireEvent.change(screen.getByRole('combobox', { name: '思考强度' }), { target: { value: 'high' } });
    expect(change).toHaveBeenCalledWith({ runtime: 'openai-agents', model: 'bedrock.claude-opus-5-5', effort: 'high' });
  });

  it('offers a team on another runtime no levels it may not have, and keeps its runtime', () => {
    const change = vi.fn();
    const { unmount } = render(<NodeModelSettings node={{ runtime: 'pi', model: 'bedrock.claude-opus-5-5', effort: '' }} groups={groups} keepRuntime onChange={change} />);
    expect(screen.queryByRole('combobox', { name: '思考强度' })).toBeNull();
    unmount();
    render(<NodeModelSettings node={{ runtime: 'openai-agents', model: 'bedrock.claude-opus-5-5', effort: '' }} groups={groups} keepRuntime onChange={change} />);
    fireEvent.change(screen.getByRole('combobox', { name: '思考强度' }), { target: { value: 'low' } });
    expect(change).toHaveBeenCalledWith({ runtime: 'openai-agents', model: 'bedrock.claude-opus-5-5', effort: 'low' });
  });
});
