import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { InspectorPanel, type InspectorPanelProps } from '../src/canvas/InspectorPanel';
import { createAgentTemplate, getAgentTemplate } from '../src/canvas/agentTemplates';
import { PersonaPicker } from '../src/canvas/PersonaPicker';
import type { SessionNode } from '../src/canvas/canvasDoc';
import { LocaleProvider } from '../src/canvas/i18n';

afterEach(cleanup);
function inspector(node: SessionNode, overrides: Partial<InspectorPanelProps> = {}): InspectorPanelProps {
  return { node, liveCompanies: [], apiBase: '/api', onSave: vi.fn(), onClose: vi.fn(), onInitialize: vi.fn(async () => {}), ...overrides };
}

describe('persona presets only update instructions', () => {
  it('preserves the existing model, runtime, contract, template and binding when selecting another persona', async () => {
    const node: SessionNode = { ...createAgentTemplate('backend', { x: 30, y: 40 }), runtime: 'pi', model: 'catalog-model', effort: 'high',
      binding: { companyId: 'workspace', agentId: 'bound', agentName: 'Existing' }, issueId: 'session-1', activeThreadId: 'thread-1' };
    const p = inspector(node); render(<InspectorPanel {...p} />);
    fireEvent.change(screen.getByRole('combobox', { name: '人设预设' }), { target: { value: 'frontend' } });
    expect(screen.getByLabelText('人设 / 系统提示词')).toHaveValue(getAgentTemplate('frontend').persona);
    fireEvent.click(screen.getByRole('button', { name: '保存并准备运行' }));
    await waitFor(() => expect(p.onInitialize).toHaveBeenCalledOnce());
    expect(p.onInitialize).toHaveBeenCalledWith({ ...node, persona: getAgentTemplate('frontend').persona });
  });

  it('does not expose persona presets or mutate a referenced workspace Agent', async () => {
    const node: SessionNode = { ...createAgentTemplate('backend', { x: 0, y: 0 }), agentRef: { source: 'workspace', agentId: 'shared' } };
    const p = inspector(node); render(<InspectorPanel {...p} />);
    expect(screen.queryByRole('combobox', { name: '人设预设' })).toBeNull();
    expect(screen.getByLabelText('人设 / 系统提示词')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '保存并准备运行' }));
    await waitFor(() => expect(p.onInitialize).toHaveBeenCalledWith(node));
  });

  it('locks the preset control along with the rest of the inspector', () => {
    const p = inspector(createAgentTemplate('general', { x: 0, y: 0 }), { readOnly: true });
    render(<InspectorPanel {...p} />);
    const picker = screen.getByRole('combobox', { name: '人设预设' }); expect(picker).toBeDisabled();
    fireEvent.change(picker, { target: { value: 'frontend' } });
    expect(screen.getByLabelText('人设 / 系统提示词')).toHaveValue(p.node.kind === 'session' ? p.node.persona : '');
    expect(p.onInitialize).not.toHaveBeenCalled();
  });

  it('recognizes saved presets across UI languages without rewriting their text', () => {
    const onChange = vi.fn();
    const view = render(<LocaleProvider locale="en"><PersonaPicker persona={getAgentTemplate('frontend', 'zh').persona} onChange={onChange} /></LocaleProvider>);
    expect(screen.getByRole('combobox', { name: 'Persona preset' })).toHaveValue('frontend');
    expect(onChange).not.toHaveBeenCalled();
    view.rerender(<LocaleProvider locale="en"><PersonaPicker persona="Keep my custom instructions" onChange={onChange} /></LocaleProvider>);
    expect(screen.getByRole('combobox', { name: 'Persona preset' })).toHaveValue('');
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'data' } });
    expect(onChange).toHaveBeenCalledWith(getAgentTemplate('data', 'en').persona);
  });
});
