import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RuntimeRoster } from '../src/settings/RuntimeRoster';
import type { AgentInventoryInfo, RuntimeConfigPayload, RuntimeProbeResult } from '../src/App';

const t = ((key: string) => key) as unknown as (key: never) => string;

const AGENTS: AgentInventoryInfo[] = [
  { name: 'cursor', available: false, reason: 'cursor-agent not found on PATH', kind: 'cli', config_env: 'SUPERCLAW_CURSOR_EXECUTABLE', configure: '/config set SUPERCLAW_CURSOR_EXECUTABLE /path/to/cursor-agent' },
  { name: 'codex', available: true, executable: '/bin/codex', kind: 'cli', config_env: 'SUPERCLAW_CODEX_EXECUTABLE' },
  { name: 'claude', available: true, executable: '/bin/claude', kind: 'cli', config_env: 'SUPERCLAW_CLAUDE_EXECUTABLE' },
] as unknown as AgentInventoryInfo[];

const CONFIG_ENTRIES = [
  { name: 'SUPERCLAW_CODEX_EXECUTABLE', display_value: '/bin/codex', default: null, persist_allowed: true, secret: false } as unknown as RuntimeConfigPayload['entries'][number],
];

function renderRoster(overrides: Partial<Parameters<typeof RuntimeRoster>[0]> = {}) {
  const onProbe = vi.fn();
  const onProbeDeep = vi.fn();
  const onProbeAll = vi.fn();
  const onSaveConfig = vi.fn(async () => true);
  const onInvalidateProbe = vi.fn();
  render(
    <RuntimeRoster
      t={t}
      agents={AGENTS}
      defaultBackend="claude"
      configEntries={CONFIG_ENTRIES}
      probeResults={{ claude: { backend: 'claude', verdict: 'runtime_ready', detail: 'ok', depth: 'live', present: true, models_count: 4, latency_ms: 257 } as RuntimeProbeResult }}
      probingBackends={{}}
      probeAllBusy={false}
      onProbe={onProbe}
      onProbeDeep={onProbeDeep}
      onProbeAll={onProbeAll}
      onSaveConfig={onSaveConfig}
      onInvalidateProbe={onInvalidateProbe}
      {...overrides}
    />,
  );
  return { onProbe, onProbeDeep, onProbeAll, onSaveConfig, onInvalidateProbe };
}

afterEach(cleanup);

describe('RuntimeRoster', () => {
  it('sorts default first, then installed, then not-installed last', () => {
    renderRoster();
    const names = Array.from(document.querySelectorAll('.runtime-row-name')).map((el) =>
      (el.textContent ?? '').replace('Default', '').trim(),
    );
    expect(names).toEqual(['claude', 'codex', 'cursor']);
  });

  it('shows lifecycle status per runtime and a Default badge', () => {
    renderRoster();
    const rows = document.querySelectorAll('.runtime-row');
    // claude: default + probed ready → Healthy + latency + Default badge
    expect(rows[0].textContent).toContain('Default');
    expect(rows[0].textContent).toContain('Healthy');
    expect(rows[0].textContent).toContain('257ms');
    // codex: installed, untested
    expect(rows[1].textContent).toContain('Ready, untested');
    // cursor: not installed → Not ready + the kernel's RAW reason (verbatim — the
    // surface never re-derives a diagnosis category from it).
    expect(rows[2].textContent).toContain('Not ready');
    expect(rows[2].textContent).toContain('cursor-agent not found on PATH');
  });

  it('runs a single test and a test-all', () => {
    const { onProbe, onProbeAll } = renderRoster();
    fireEvent.click(within(document.querySelectorAll('.runtime-row')[1] as HTMLElement).getByRole('button', { name: 'Test' }));
    expect(onProbe).toHaveBeenCalledWith('codex');
    fireEvent.click(screen.getByRole('button', { name: 'Test all runtimes' }));
    expect(onProbeAll).toHaveBeenCalled();
  });

  it('runs a deep (end-to-end) test per runtime via onProbeDeep', () => {
    const { onProbe, onProbeDeep } = renderRoster();
    const codexRow = document.querySelectorAll('.runtime-row')[1] as HTMLElement;
    fireEvent.click(within(codexRow).getByRole('button', { name: 'Deep test' }));
    expect(onProbeDeep).toHaveBeenCalledWith('codex');
    // Deep is a distinct action — it must not fire the lightweight probe.
    expect(onProbe).not.toHaveBeenCalled();
  });

  it('disables Deep test for a not-installed runtime', () => {
    renderRoster();
    const cursorRow = document.querySelectorAll('.runtime-row')[2] as HTMLElement; // cursor (unavailable)
    expect(within(cursorRow).getByRole('button', { name: 'Deep test' })).toBeDisabled();
  });

  it('renders a lightweight runtime_present probe as "Present, unverified" with the depth-derived method label', () => {
    renderRoster({
      probeResults: {
        codex: {
          backend: 'codex',
          verdict: 'runtime_present',
          detail: 'CLI present on PATH: codex',
          depth: 'shallow',
          present: true,
        } as RuntimeProbeResult,
      },
    });
    const codexRow = document.querySelectorAll('.runtime-row')[1] as HTMLElement; // codex (available)
    // presence-only is NOT shown as healthy/reachable — it is the honest warn state
    expect(codexRow.textContent).toContain('Present, unverified');
    // the verification method tracks the kernel depth, not a hardcoded model-list call
    fireEvent.click(within(codexRow).getByRole('button', { name: 'Diagnostics details' }));
    expect(codexRow.textContent).toContain('CLI presence (PATH + exec-bit)');
    expect(codexRow.textContent).not.toContain('GET /v1/models');
  });

  it('disables Test while a config edit is unsaved, then saves + invalidates the probe', async () => {
    const { onSaveConfig, onInvalidateProbe } = renderRoster();
    const codexRow = document.querySelectorAll('.runtime-row')[1] as HTMLElement;
    // expand codex and edit its executable
    fireEvent.click(within(codexRow).getByRole('button', { name: 'Diagnostics details' }));
    const input = within(codexRow).getByLabelText('codex Agent executable path');
    fireEvent.change(input, { target: { value: '/usr/local/bin/codex' } });
    // dirty → Test disabled
    expect(within(codexRow).getByRole('button', { name: 'Test' })).toBeDisabled();
    // save → onSaveConfig(env, value) + invalidate codex's stale probe
    fireEvent.click(within(codexRow).getByRole('button', { name: 'Save config key' }));
    await vi.waitFor(() => expect(onSaveConfig).toHaveBeenCalledWith('SUPERCLAW_CODEX_EXECUTABLE', '/usr/local/bin/codex'));
    expect(onInvalidateProbe).toHaveBeenCalledWith('codex');
  });

  it('disables every per-row Test while a Test-all sweep is running (no serial bypass)', () => {
    renderRoster({ probeAllBusy: true });
    for (const button of screen.getAllByRole('button', { name: /^(Test|Testing…)$/ })) {
      expect(button).toBeDisabled();
    }
  });

  it('sets a non-default runtime as default via /config backend', () => {
    const { onSaveConfig } = renderRoster();
    const codexRow = document.querySelectorAll('.runtime-row')[1] as HTMLElement;
    fireEvent.click(within(codexRow).getByRole('button', { name: 'Diagnostics details' }));
    fireEvent.click(within(codexRow).getByRole('button', { name: 'Set as default' }));
    expect(onSaveConfig).toHaveBeenCalledWith('backend', 'codex');
  });

  it('never offers Set as default for a not-installed runtime', () => {
    renderRoster();
    const cursorRow = document.querySelectorAll('.runtime-row')[2] as HTMLElement; // cursor (unavailable)
    fireEvent.click(within(cursorRow).getByRole('button', { name: 'Diagnostics details' }));
    expect(within(cursorRow).queryByRole('button', { name: 'Set as default' })).not.toBeInTheDocument();
  });

  it('blocks Test all while any row has an unsaved edit', () => {
    renderRoster();
    const codexRow = document.querySelectorAll('.runtime-row')[1] as HTMLElement;
    fireEvent.click(within(codexRow).getByRole('button', { name: 'Diagnostics details' }));
    fireEvent.change(within(codexRow).getByLabelText('codex Agent executable path'), {
      target: { value: '/usr/local/bin/codex' },
    });
    expect(screen.getByRole('button', { name: 'Test all runtimes' })).toBeDisabled();
  });
});
