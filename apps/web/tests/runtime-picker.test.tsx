import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RuntimePicker, type RuntimeValue } from '../src/RuntimePicker';

// PR4 — the reusable runtime-linked selector. 铁律6: model/effort scoped to the
// chosen runtime, fail-closed (shown only on positive support), relay packages
// closed, default never backfilled, reset on switch.

afterEach(cleanup);

function mockReadJson() {
  return vi.fn(async (path: string) => {
    if (path === '/api/agents') {
      return {
        agents: [
          { name: 'claude', supports_model_selection: true, supports_effort_selection: true, effort_levels: ['low', 'high'], effort_input_mode: 'select' },
          { name: 'anthropic-agent', supports_model_selection: true, supports_effort_selection: false },
          { name: 'clawwork', supports_model_selection: true, uses_relay_packages: true, supports_effort_selection: false },
          { name: 'test-worker', supports_model_selection: false, supports_effort_selection: false },
        ],
      };
    }
    if (path === '/api/agents/claude/models') return { models: ['claude-opus-4-8'] };
    if (path === '/api/agents/clawwork/models') return { models: [] };
    if (path === '/api/relay/packages') return { available: true, packages: [{ id: 'superclaw-plus', name: 'ClawHunt Plus', tier: 'plus' }] };
    return {};
  });
}

function harness(initial: RuntimeValue, readJson = mockReadJson()) {
  let value = initial;
  const onChange = vi.fn((v: RuntimeValue) => {
    value = v;
  });
  const utils = render(
    <RuntimePicker runtimes={['claude', 'anthropic-agent', 'clawwork', 'test-worker']} value={value} onChange={onChange} readJson={readJson} lang="en" />,
  );
  return { onChange, getValue: () => value, ...utils };
}

describe('RuntimePicker', () => {
  it('shows the effort selector only when the runtime supports it', async () => {
    const { rerender, onChange } = harness({ backend: 'claude', model: '', effort: '' });
    expect(await screen.findByLabelText('Effort')).toBeInTheDocument();
    // switch to a runtime without effort
    rerender(<RuntimePicker runtimes={['claude', 'anthropic-agent']} value={{ backend: 'anthropic-agent', model: '', effort: '' }} onChange={onChange} readJson={mockReadJson()} lang="en" />);
    await waitFor(() => expect(screen.queryByLabelText('Effort')).not.toBeInTheDocument());
  });

  it('renders a CLOSED package dropdown (not a free input) for a relay runtime', async () => {
    harness({ backend: 'clawwork', model: '', effort: '' });
    const modelField = await screen.findByLabelText('Model');
    fireEvent.click(modelField);
    expect(await screen.findByRole('option', { name: /ClawHunt Plus/ })).toBeInTheDocument();
  });

  it('hides the model picker for a runtime that does not support model selection', async () => {
    harness({ backend: 'test-worker', model: '', effort: '' });
    await waitFor(() => expect(screen.queryByLabelText('Model')).not.toBeInTheDocument());
  });

  it('resets model + effort to empty when the runtime switches', async () => {
    const { onChange } = harness({ backend: 'claude', model: 'claude-opus-4-8', effort: 'high' });
    const runtime = await screen.findByLabelText('Runtime');
    fireEvent.click(runtime);
    fireEvent.click(await screen.findByRole('option', { name: 'anthropic-agent' }));
    expect(onChange).toHaveBeenCalledWith({ backend: 'anthropic-agent', model: '', effort: '' });
  });

  it('disables relay packages locked above the account tier ceiling (issue #452)', async () => {
    const readJson = vi.fn(async (path: string) => {
      if (path === '/api/agents') {
        return { agents: [{ name: 'clawwork', supports_model_selection: true, uses_relay_packages: true, supports_effort_selection: false }] };
      }
      if (path === '/api/agents/clawwork/models') return { models: [] };
      if (path === '/api/relay/packages') {
        return {
          available: true,
          tier_ceiling: 'core',
          packages: [
            { id: 'core', name: 'core', tier: 'core', locked: false },
            { id: 'plus', name: 'plus', tier: 'plus', locked: true },
            { id: 'max', name: 'max', tier: 'max', locked: true },
          ],
        };
      }
      return {};
    });
    harness({ backend: 'clawwork', model: '', effort: '' }, readJson);
    fireEvent.click(await screen.findByLabelText('Model'));
    // 越级档（plus/max）禁选；解锁档（core）可选 —— 裁决来自内核 locked，前端零计算
    const plusOption = await screen.findByRole('option', { name: /plus/ });
    expect(plusOption).toHaveAttribute('aria-disabled', 'true');
    const coreOption = screen.getByRole('option', { name: /^core/ });
    expect(coreOption).not.toHaveAttribute('aria-disabled', 'true');
    // 两个越级档各带「需升级」角标
    expect(screen.getAllByText('Upgrade').length).toBeGreaterThanOrEqual(2);
  });

  // An unset runtime used to render a BLANK trigger, which reads as a broken control rather
  // than as an invitation — on the canvas inspector that is the first step of binding a node.
  it('an UNSET runtime prompts instead of rendering a blank trigger', async () => {
    harness({ backend: '', model: '', effort: '' });
    expect(await screen.findByLabelText('Runtime')).toHaveTextContent('Select a runtime…');
  });

  it('but keeps the inherit label when the empty value is a REAL choice', async () => {
    render(
      <RuntimePicker
        runtimes={['claude']}
        value={{ backend: '', model: '', effort: '' }}
        onChange={vi.fn()}
        readJson={mockReadJson()}
        lang="en"
        allowInherit
      />,
    );
    const trigger = await screen.findByLabelText('Runtime');
    expect(trigger).toHaveTextContent('Use lead');
    expect(trigger).not.toHaveTextContent('Select a runtime…');
  });
});
