// Settings primitives (settings-redesign PR-3).
// Small, token-driven building blocks for the settings surface: a panel of
// rows instead of free-form cards. Components accept semantic state only —
// never color classes — so theming stays in CSS variables.
import type { ReactNode } from 'react';

export type StatusTone = 'good' | 'bad' | 'warn' | 'neutral' | 'live';

export function StatusPill({ tone = 'neutral', children }: { tone?: StatusTone; children: ReactNode }) {
  return <span className={`status-pill ${tone}`}>{children}</span>;
}

// A rounded container that stacks SettingRows with hairline dividers,
// macOS-System-Settings style. Complex modules keep their cards; plain
// preferences and configuration belong in rows.
export function SettingsPanel({
  id,
  ariaLabel,
  children,
}: {
  id?: string;
  ariaLabel?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="settings-panel" aria-label={ariaLabel}>
      {children}
    </section>
  );
}

// One setting: label + optional description on the left, the control on the
// right. `footer` renders full-width under the row (history lists, hints).
export function SettingRow({
  id,
  icon,
  label,
  description,
  control,
  footer,
}: {
  id?: string;
  icon?: ReactNode;
  label: ReactNode;
  description?: ReactNode;
  control?: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div id={id} className="setting-row">
      <div className="setting-row-main">
        {icon ? <span className="setting-row-icon">{icon}</span> : null}
        <div className="setting-row-text">
          <span className="setting-row-label">{label}</span>
          {description ? <span className="setting-row-description">{description}</span> : null}
        </div>
        {control ? <div className="setting-row-control">{control}</div> : null}
      </div>
      {footer ? <div className="setting-row-footer">{footer}</div> : null}
    </div>
  );
}

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  ariaLabel?: string;
  icon?: ReactNode;
}

// Single-choice control for 2-4 options (theme, language). Keeps the
// radiogroup/radio semantics the app-shell tests assert on.
export function SegmentedControl<T extends string>({
  ariaLabel,
  options,
  value,
  onChange,
}: {
  ariaLabel: string;
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="segmented-control" role="radiogroup" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          aria-label={option.ariaLabel}
          className={value === option.value ? 'active' : ''}
          onClick={() => onChange(option.value)}
        >
          {option.icon}
          {option.label != null ? <span>{option.label}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function ToggleSwitch({
  ariaLabel,
  checked,
  onChange,
}: {
  ariaLabel: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      className={`toggle-switch${checked ? ' on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="toggle-switch-thumb" aria-hidden="true" />
    </button>
  );
}
