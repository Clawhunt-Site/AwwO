/**
 * CheckRow
 * Checkbox row for toggles (Audio)
 * Label LEFT, checkbox RIGHT — per design handoff
 */

interface CheckRowProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}

export function CheckRow({ checked, onChange, label }: CheckRowProps) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      aria-pressed={checked}
      className={[
        'w-full h-12 px-spacing-lg-v2 rounded-xl-v2',
        'flex items-center justify-between gap-spacing-lg-v2',
        'bg-transparent border border-Cr-border-default-v2',
        'text-Cr-text-default-v2 text-sm font-medium cursor-pointer',
      ].join(' ')}
      aria-label={`${checked ? 'Disable' : 'Enable'} ${label}`}
    >
      <span>{label}</span>
      <span
        className={[
          'w-[18px] h-[18px] rounded-md-v2 border inline-flex items-center justify-center shrink-0',
          checked
            ? 'border-Cr-border-brand-v2 bg-dreamy-brand-hot-v2'
            : 'border-Cr-beta-white-20-v2 bg-transparent',
        ].join(' ')}
        aria-hidden
      >
        {checked && (
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
            stroke="var(--color-CCr-button-brand-fg_default-v2)" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12l5 5L20 7" />
          </svg>
        )}
      </span>
    </button>
  );
}
