import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

const liveInventory = {
  agents: [{
    name: 'codex_local',
    supports_model_selection: true,
    supports_effort_selection: true,
    model_catalog_source: 'codex_app_server',
    // The live catalog must never inherit these legacy fallback values.
    suggested_models: ['gpt-5.3-codex-spark'],
    effort_levels: ['legacy-effort'],
  }],
};

const liveCatalog = {
  models: ['model-alpha', 'model-beta', 'model-gamma'],
  source: 'codex_app_server',
  model_capabilities: {
    'model-alpha': { effort_levels: ['low', 'medium', 'high'], default_effort: 'medium' },
    'model-beta': { effort_levels: ['low'], default_effort: 'low' },
    'model-gamma': { effort_levels: [], default_effort: '' },
  },
};

function liveReadJson() {
  return vi.fn(async (path: string) => path === '/api/agents' ? liveInventory : liveCatalog);
}

function liveHarness(initial: RuntimeValue, readJson = liveReadJson(), lang: 'en' | 'zh' = 'en') {
  const onChange = vi.fn();
  function ControlledPicker() {
    const [value, setValue] = useState(initial);
    return <RuntimePicker runtimes={['codex_local']} value={value} onChange={(next) => { onChange(next); setValue(next); }} readJson={readJson} lang={lang} />;
  }
  return { onChange, ...render(<ControlledPicker />) };
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

  it('uses only the genuine live models and keeps the advertised default effort implicit', async () => {
    const { onChange } = liveHarness({ backend: 'codex_local', model: 'model-alpha', effort: '' });
    await waitFor(() => expect(screen.getByLabelText('Model')).toBeEnabled());
    const effort = screen.getByLabelText('Effort');
    expect(effort).toHaveTextContent('Inherit (runtime default) · medium');
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText('Model'));
    expect(screen.getByRole('option', { name: 'model-beta' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'gpt-5.3-codex-spark' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Model'));
    fireEvent.click(effort);
    expect(screen.getByRole('option', { name: 'high' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'legacy-effort' })).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('clears an incompatible effort on model change and then uses that model\'s own levels', async () => {
    const { onChange } = liveHarness({ backend: 'codex_local', model: 'model-alpha', effort: 'high' });
    await waitFor(() => expect(screen.getByLabelText('Model')).toBeEnabled());
    fireEvent.click(screen.getByLabelText('Model'));
    fireEvent.click(screen.getByRole('option', { name: 'model-beta' }));
    expect(onChange).toHaveBeenLastCalledWith({ backend: 'codex_local', model: 'model-beta', effort: '' });
    fireEvent.click(screen.getByLabelText('Effort'));
    expect(screen.getByRole('option', { name: 'low' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'high' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: 'low' }));
    expect(onChange).toHaveBeenLastCalledWith({ backend: 'codex_local', model: 'model-beta', effort: 'low' });
    fireEvent.click(screen.getByLabelText('Model'));
    fireEvent.click(screen.getByRole('option', { name: 'model-alpha' }));
    expect(onChange).toHaveBeenLastCalledWith({ backend: 'codex_local', model: 'model-alpha', effort: 'low' });
    fireEvent.click(screen.getByLabelText('Model'));
    fireEvent.click(screen.getByRole('option', { name: 'model-gamma' }));
    expect(onChange).toHaveBeenLastCalledWith({ backend: 'codex_local', model: 'model-gamma', effort: '' });
    expect(screen.getByLabelText('Effort')).toBeDisabled();
  });

  it('retains an unknown saved model visibly without inventing its effort capabilities', async () => {
    const { onChange } = liveHarness({ backend: 'codex_local', model: 'saved-private-model', effort: 'saved-effort' });
    await waitFor(() => expect(screen.getByLabelText('Model')).toBeEnabled());
    expect(screen.getByLabelText('Model')).toHaveTextContent('saved-private-model');
    expect(screen.getByLabelText('Effort')).toBeDisabled();
    expect(screen.getByLabelText('Effort')).toHaveTextContent('saved-effort');
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText('Model'));
    expect(screen.getByRole('option', { name: /saved-private-model/ })).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(screen.getByRole('option', { name: 'model-alpha' }));
    expect(onChange).toHaveBeenLastCalledWith({ backend: 'codex_local', model: 'model-alpha', effort: '' });
  });

  it('does not infer a model or effort when the runtime default is selected', async () => {
    const { onChange } = liveHarness({ backend: 'codex_local', model: '', effort: '' });
    await waitFor(() => expect(screen.getByLabelText('Model')).toBeEnabled());
    expect(screen.getByLabelText('Model')).toHaveTextContent('Default model');
    expect(screen.getByLabelText('Effort')).toBeDisabled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it.each(['en', 'zh'] as const)('shows a fixed localized catalog failure with a fresh retry (%s)', async (lang) => {
    let resolveRetry!: (value: typeof liveCatalog) => void;
    const retriedCatalog = new Promise<typeof liveCatalog>((resolve) => { resolveRetry = resolve; });
    let modelRequests = 0;
    const readJson = vi.fn(async (path: string) => {
      if (path === '/api/agents') return liveInventory;
      modelRequests += 1;
      if (modelRequests === 1) throw new Error('private diagnostic and auth path');
      return retriedCatalog;
    });
    const { onChange } = liveHarness({ backend: 'codex_local', model: 'model-alpha', effort: 'high' }, readJson, lang);
    const labels = lang === 'en'
      ? { model: 'Model', effort: 'Effort', error: 'The Codex model catalog is unavailable. Please retry.', retry: 'Retry model catalog' }
      : { model: '模型', effort: '思考强度', error: 'Codex 模型目录暂不可用，请重试。', retry: '重试模型目录' };
    expect(await screen.findByRole('status')).toHaveTextContent(labels.error);
    expect(screen.queryByText(/private diagnostic/)).not.toBeInTheDocument();
    expect(screen.getByLabelText(labels.model)).toBeDisabled();
    expect(screen.getByLabelText(labels.effort)).toBeDisabled();
    expect(screen.queryByText('gpt-5.3-codex-spark')).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: labels.retry }));
    await waitFor(() => expect(modelRequests).toBe(2));
    expect(screen.getByLabelText(labels.model)).toBeDisabled();
    expect(screen.getByLabelText(labels.effort)).toBeDisabled();
    await act(async () => { resolveRetry(liveCatalog); });
    await waitFor(() => expect(screen.getByLabelText(labels.model)).toBeEnabled());
    expect(screen.getByLabelText(labels.effort)).toBeEnabled();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it.each([
    { models: [], source: 'codex_app_server' },
    { models: ['legacy-model'] },
    { source: 'codex_app_server' },
  ])('fails closed for an empty or invalid live model response: %j', async (response) => {
    const readJson = vi.fn(async (path: string) => path === '/api/agents' ? liveInventory : response);
    liveHarness({ backend: 'codex_local', model: '', effort: '' }, readJson);
    expect(await screen.findByRole('status')).toHaveTextContent('The Codex model catalog is unavailable. Please retry.');
    expect(screen.getByLabelText('Model')).toBeDisabled();
    expect(screen.getByLabelText('Effort')).toBeDisabled();
    expect(screen.queryByText('gpt-5.3-codex-spark')).not.toBeInTheDocument();
  });

  it('ignores a stale Codex catalog after switching to another runtime', async () => {
    let resolveCatalog!: (value: typeof liveCatalog) => void;
    const pendingCatalog = new Promise<typeof liveCatalog>((resolve) => { resolveCatalog = resolve; });
    const readJson = vi.fn(async (path: string) => {
      if (path === '/api/agents/codex_local/models') return pendingCatalog;
      if (path === '/api/agents') return { agents: [...liveInventory.agents, { name: 'claude', supports_model_selection: true, supports_effort_selection: true, effort_levels: ['custom-level'] }] };
      return { models: ['claude-current'] };
    });
    const onChange = vi.fn();
    const { rerender } = render(<RuntimePicker runtimes={['codex_local', 'claude']} value={{ backend: 'codex_local', model: 'model-alpha', effort: '' }} onChange={onChange} readJson={readJson} lang="en" />);
    await waitFor(() => expect(screen.getByLabelText('Model')).toBeDisabled());
    rerender(<RuntimePicker runtimes={['codex_local', 'claude']} value={{ backend: 'claude', model: 'claude-current', effort: '' }} onChange={onChange} readJson={readJson} lang="en" />);
    await waitFor(() => expect(screen.getByLabelText('Model')).toHaveValue('claude-current'));
    await act(async () => { resolveCatalog(liveCatalog); });
    fireEvent.focus(screen.getByLabelText('Model'));
    expect(screen.getByRole('option', { name: 'claude-current' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'model-alpha' })).not.toBeInTheDocument();
    fireEvent.blur(screen.getByLabelText('Model'));
    fireEvent.click(screen.getByLabelText('Effort'));
    expect(screen.getByRole('option', { name: 'custom-level' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'high' })).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });
});
