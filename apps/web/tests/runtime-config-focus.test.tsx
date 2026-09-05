import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RuntimeConfigFields } from '../src/settings/RuntimeConfigFields';
import type { RuntimeConfigPayload } from '../src/App';

type ConfigEntry = RuntimeConfigPayload['entries'][number];

const t = ((key: string) => key) as unknown as (key: never) => string;

function entry(name: string): ConfigEntry {
  return {
    name,
    category: 'runtime',
    description: `${name} executable`,
    default: null,
    configured: false,
    persist_allowed: true,
    persisted: false,
    secret: false,
    source: 'env',
    value: '',
    display_value: '',
    ui: { type: 'text', section: 'advanced', choices: null },
  };
}

const ENTRIES = [entry('SUPERCLAW_CURSOR_EXECUTABLE'), entry('SUPERCLAW_CODEX_EXECUTABLE')];

afterEach(cleanup);

describe('RuntimeConfigFields deep-link focus (read-only Diagnostics target)', () => {
  it('opens the advanced disclosure and highlights ONLY the targeted env', () => {
    const { container } = render(
      <RuntimeConfigFields entries={ENTRIES} t={t} onSave={vi.fn()} focusName="SUPERCLAW_CURSOR_EXECUTABLE" />,
    );
    const details = container.querySelector('details.settings-advanced-disclosure');
    expect(details?.hasAttribute('open')).toBe(true);
    const focused = container.querySelectorAll('.config-field-focused');
    expect(focused).toHaveLength(1);
    expect(focused[0].textContent).toContain('SUPERCLAW_CURSOR_EXECUTABLE');
    expect(focused[0].textContent).not.toContain('SUPERCLAW_CODEX_EXECUTABLE');
  });

  it('without a focus target, nothing is highlighted and advanced stays collapsed', () => {
    const { container } = render(<RuntimeConfigFields entries={ENTRIES} t={t} onSave={vi.fn()} />);
    const details = container.querySelector('details.settings-advanced-disclosure');
    expect(details?.hasAttribute('open')).toBe(false);
    expect(container.querySelector('.config-field-focused')).toBeNull();
  });
});
