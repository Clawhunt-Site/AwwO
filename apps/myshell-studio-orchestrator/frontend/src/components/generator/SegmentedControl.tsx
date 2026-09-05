/**
 * SegmentedControl
 * Multi-segment pill control (Quality / Duration)
 * Active segment uses brand gradient background
 */

interface SegmentedControlProps {
  options: string[];
  value: string;
  onChange: (value: string) => void;
  labels?: string[];
}

export function SegmentedControl({ options, value, onChange, labels }: SegmentedControlProps) {
  return (
    <div
      role="radiogroup"
      className={[
        'grid h-10 p-[3px] rounded-full-v2',
        'bg-Cr-beta-white-3-v2 border border-Cr-beta-white-8-v2',
      ].join(' ')}
      style={{ gridTemplateColumns: `repeat(${options.length}, 1fr)` }}
    >
      {options.map((opt, idx) => {
        const active = opt === value;
        const displayLabel = labels?.[idx] ?? opt;
        return (
          <button
            key={opt}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(opt)}
            className={[
              'rounded-full-v2 border-0 cursor-pointer tabular-nums',
              'text-xs font-semibold',
              'transition-[background,color] duration-200',
              active
                ? 'bg-[image:var(--gradient-dreamy-brand-vertical)] text-Cr-text-default-v2'
                : 'bg-transparent text-Cr-text-subtler-v2',
            ].join(' ')}
            aria-label={`Select ${opt}`}
          >
            {displayLabel}
          </button>
        );
      })}
    </div>
  );
}
