/**
 * CategoryTabBar
 * Horizontal wrap-layout category pills with active state + filled dot indicator
 */

interface CategoryTabBarProps {
  items: Array<{ id: string; label: string; emoji: string }>;
  activeId: string;
  onSelect: (id: string) => void;
  filledIds: Set<string>;
}

export function CategoryTabBar({ items, activeId, onSelect, filledIds }: CategoryTabBarProps) {
  return (
    <div className="flex flex-wrap gap-spacing-md-v2 px-spacing-xl-v2 shrink-0">
      {items.map((item) => {
        const active = item.id === activeId;
        const filled = filledIds.has(item.id);

        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onSelect(item.id)}
            aria-pressed={active}
            className={[
              'inline-flex items-center gap-spacing-sm-v2 h-8 px-spacing-lg-v2',
              'rounded-full-v2 border text-xs font-medium',
              'text-Cr-text-default-v2 cursor-pointer shrink-0',
              'transition-[background,border-color] duration-[180ms]',
              active
                ? 'border-Cr-border-brand-v2 bg-[rgb(255_25_94_/_0.16)]'
                : 'border-transparent bg-Cr-beta-white-5-v2',
            ].join(' ')}
            aria-label={`Select ${item.label} category`}
          >
            {item.emoji && (
              <span aria-hidden className="text-xs leading-none shrink-0">{item.emoji}</span>
            )}
            {item.label}
            {filled && (
              <span
                aria-hidden
                className="w-1.5 h-1.5 rounded-full-v2 bg-dreamy-brand-hot-v2 shadow-[0_0_6px_rgb(255_25_94_/_0.35)]"
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
