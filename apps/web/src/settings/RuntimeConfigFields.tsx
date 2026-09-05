// Schema-driven runtime config editor (settings-redesign PR-5b).
// Renders the kernel's field-level UI schema (`entries[].ui` from
// /api/config — see runtime_config.RuntimeConfigSpec): the kernel decides
// whether a value is a path, enum, toggle, number or secret; this component
// only maps that contract onto the settings primitives. Entries from an
// older API without `ui` degrade to advanced text fields.
import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { Dropdown } from '../ui/Dropdown';
import { SettingRow, SettingsPanel, StatusPill, ToggleSwitch } from './primitives';
import type { AppCopyKey, RuntimeConfigPayload } from '../App';

type ConfigEntry = RuntimeConfigPayload['entries'][number];
type Translate = (key: AppCopyKey) => string;
type SaveConfigValue = (name: string, value: string) => Promise<boolean>;

const FALLBACK_UI = { type: 'text', section: 'advanced', choices: null } as const;
const TRUTHY_CONFIG_VALUES = new Set(['1', 'true', 'yes', 'on']);

function entryUi(entry: ConfigEntry) {
  return entry.ui ?? FALLBACK_UI;
}

function entryValue(entry: ConfigEntry): string {
  if (typeof entry.value === 'string') return entry.value;
  if (!entry.secret && typeof entry.display_value === 'string') return entry.display_value;
  return '';
}

function ConfigFieldControl({ entry, t, onSave }: { entry: ConfigEntry; t: Translate; onSave: SaveConfigValue }) {
  const ui = entryUi(entry);
  const current = entryValue(entry);
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const value = draft ?? current;
  const dirty = draft !== null && draft !== current;

  async function save(nextValue: string) {
    setBusy(true);
    try {
      const saved = await onSave(entry.name, nextValue);
      if (saved) setDraft(null);
    } finally {
      setBusy(false);
    }
  }

  if (entry.secret) {
    // secrets are configured through dedicated flows; the schema only
    // reports set/unset so nothing sensitive ever reaches this surface
    return (
      <StatusPill tone={entry.configured ? 'good' : 'neutral'}>{entry.configured ? 'set' : 'unset'}</StatusPill>
    );
  }

  if (ui.type === 'toggle') {
    return (
      <ToggleSwitch
        ariaLabel={entry.name}
        checked={TRUTHY_CONFIG_VALUES.has(current.toLowerCase())}
        onChange={(next) => void save(next ? '1' : '0')}
      />
    );
  }

  if (ui.type === 'select' && ui.choices?.length) {
    return (
      <Dropdown
        variant="field"
        ariaLabel={entry.name}
        value={current}
        options={ui.choices.map((choice) => ({ value: choice, label: choice }))}
        onChange={(next) => void save(next)}
      />
    );
  }

  return (
    <>
      <input
        aria-label={entry.name}
        type={ui.type === 'number' ? 'number' : 'text'}
        // the kernel consumes numbers as strings and some are floats — no
        // integer-only step constraint here
        step={ui.type === 'number' ? 'any' : undefined}
        value={value}
        placeholder={entry.default ?? ''}
        onChange={(event) => setDraft(event.target.value)}
      />
      {dirty ? (
        <button
          className="text-button compact"
          type="button"
          disabled={busy || !value.trim()}
          onClick={() => void save(value)}
        >
          {t('Save config key')}
        </button>
      ) : null}
    </>
  );
}

function configRows(
  entries: ConfigEntry[],
  t: Translate,
  onSave: SaveConfigValue,
  focusName: string | undefined,
  focusRef: RefObject<HTMLDivElement | null>,
) {
  return entries.map((entry) => {
    const focused = Boolean(focusName) && entry.name === focusName;
    return (
      <div key={entry.name} ref={focused ? focusRef : undefined} className={focused ? 'config-field-focused' : undefined}>
        <SettingRow
          label={<code>{entry.name}</code>}
          description={entry.description}
          control={<ConfigFieldControl entry={entry} t={t} onSave={onSave} />}
        />
      </div>
    );
  });
}

export function RuntimeConfigFields({
  entries,
  t,
  onSave,
  focusName,
}: {
  entries: ConfigEntry[];
  t: Translate;
  onSave: SaveConfigValue;
  // When set (a deep-link from the read-only Diagnostics surface targeting one
  // agent's executable env), the advanced disclosure auto-opens and the matching
  // field is highlighted + scrolled into view — editing a single env here never
  // changes the default runtime (unlike the runtime-agent card), so it is the
  // correct, side-effect-free target for "configure this agent's executable".
  focusName?: string;
}) {
  const editable = entries.filter((entry) => entry.persist_allowed && !entry.secret);
  const basic = editable.filter((entry) => entryUi(entry).section === 'basic');
  const advanced = editable.filter((entry) => entryUi(entry).section !== 'basic');
  const secrets = entries.filter((entry) => entry.secret);
  const focusRef = useRef<HTMLDivElement | null>(null);
  const focusInBasic = Boolean(focusName) && basic.some((entry) => entry.name === focusName);
  const focusInAdvanced =
    Boolean(focusName) && [...advanced, ...secrets].some((entry) => entry.name === focusName);

  useEffect(() => {
    // scrollIntoView is absent in jsdom (tests) — guard so it never throws.
    if (focusName && typeof focusRef.current?.scrollIntoView === 'function') {
      focusRef.current.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [focusName]);

  return (
    <div className="runtime-config-fields">
      {basic.length ? (
        <SettingsPanel ariaLabel={t('Runtime settings')}>
          {configRows(basic, t, onSave, focusInBasic ? focusName : undefined, focusRef)}
        </SettingsPanel>
      ) : null}
      {advanced.length || secrets.length ? (
        <details className="settings-advanced-disclosure" open={focusInAdvanced || undefined}>
          <summary>{t('Advanced configuration')}</summary>
          <SettingsPanel ariaLabel={t('Advanced configuration')}>
            {configRows([...advanced, ...secrets], t, onSave, focusInAdvanced ? focusName : undefined, focusRef)}
          </SettingsPanel>
        </details>
      ) : null}
    </div>
  );
}
