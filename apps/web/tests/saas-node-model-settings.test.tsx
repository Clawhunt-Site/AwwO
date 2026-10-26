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

  it('shows a saved level its model no longer offers as unavailable, so the node can go back to the default (2026-10-26)', () => {
    // A worker that stops listing Opus 5.5's levels (rolled back) leaves a node that saved one unable to run: its setup
    // refuses the level. The picker shows it, and choosing the default clears it.
    const plain: ModelPaletteGroup[] = [{ ...groups[0], models: [{ ...groups[0].models[0], efforts: undefined }] }];
    const change = vi.fn();
    render(<NodeModelSettings node={{ runtime: 'openai-agents', model: 'bedrock.claude-opus-5-5', effort: 'low' }} groups={plain} onChange={change} />);
    const picker = screen.getByRole('combobox', { name: '思考强度' }) as HTMLSelectElement;
    expect(picker.value).toBe('low');
    expect(screen.getByRole('option', { name: '低 · 当前不可用' })).toHaveProperty('disabled', true);
    fireEvent.change(picker, { target: { value: '' } });
    expect(change).toHaveBeenCalledWith({ runtime: 'openai-agents', model: 'bedrock.claude-opus-5-5', effort: '' });
    cleanup();
    // Without a saved level there is still nothing to choose.
    render(<NodeModelSettings node={{ runtime: 'openai-agents', model: 'bedrock.claude-opus-5-5', effort: '' }} groups={plain} onChange={change} />);
    expect(screen.queryByRole('combobox', { name: '思考强度' })).toBeNull();
  });

  it('calls a saved level unavailable only where the levels are known (2026-10-26, review)', () => {
    // The list is empty while the models load and after they failed to: the node's level is not known to be gone then,
    // and choosing the default there would lose it.
    const change = vi.fn();
    const saved = { runtime: 'openai-agents', model: 'bedrock.claude-opus-5-5', effort: 'low' };
    render(<NodeModelSettings node={saved} groups={[]} loading onChange={change} />);
    expect(screen.queryByRole('combobox', { name: '思考强度' })).toBeNull();
    cleanup();
    render(<NodeModelSettings node={saved} groups={[]} error="offline" onChange={change} />);
    expect(screen.queryByRole('combobox', { name: '思考强度' })).toBeNull();
    cleanup();
    // Nor is a level a team kept on another runtime holds there, whose levels are not listed here.
    render(<NodeModelSettings node={{ ...saved, runtime: 'pi' }} groups={groups} keepRuntime onChange={change} />);
    expect(screen.queryByRole('combobox', { name: '思考强度' })).toBeNull();
    cleanup();
    // While the models reload, the levels shown cannot be chosen, as the model cannot.
    render(<NodeModelSettings node={saved} groups={groups} loading onChange={change} />);
    expect(screen.getByRole('combobox', { name: '思考强度' })).toHaveProperty('disabled', true);
    expect(change).not.toHaveBeenCalled();
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
