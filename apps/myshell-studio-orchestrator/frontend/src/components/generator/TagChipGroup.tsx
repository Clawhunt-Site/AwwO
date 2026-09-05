/**
 * TagChipGroup
 * Wrap-layout chips with single-select per category
 */

interface TagChipGroupProps {
  categoryId: string;
  options: Array<{ id: string; label: string }>;
  selected: string | undefined;
  onSelect: (categoryId: string, tagId: string) => void;
}

export function TagChipGroup({ categoryId, options, selected, onSelect }: TagChipGroupProps) {
  return (
    <div className="flex flex-wrap gap-spacing-md-v2 px-spacing-xl-v2">
      {options.map((option) => {
        const isSelected = selected === option.id;

        return (
          <button
            key={option.id}
            type="button"
            onClick={() => onSelect(categoryId, option.id)}
            aria-pressed={isSelected}
            className={[
              'h-8 px-spacing-lg-v2 rounded-full-v2 border',
              'text-xs font-medium cursor-pointer',
              'transition-[background,border-color,color] duration-[180ms]',
              isSelected
                ? 'border-Cr-border-brand-v2 bg-[rgb(255_25_94_/_0.16)] text-Cr-Fg-brand-default-v2'
                : 'border-transparent bg-Cr-beta-white-5-v2 text-Cr-text-default-v2',
            ].join(' ')}
            aria-label={`Select ${option.label}`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
