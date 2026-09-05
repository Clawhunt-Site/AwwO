/**
 * SelectionTray
 * Shows selected tags with × remove + Clear All
 */
import { useTranslation } from 'react-i18next';

interface SelectionTrayProps {
  selections: Record<string, string | undefined>;
  total: number;
  onRemove: (categoryId: string) => void;
  onClear: () => void;
  autoRolled: boolean;
  categories: Array<{ id: string; label: string; emoji: string }>;
  tagOptions: Record<string, Array<{ id: string; label: string }>>;
}

function XIcon({ size = 10 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.4" strokeLinecap="round" aria-hidden>
      <path d="M5 5l14 14M19 5L5 19" />
    </svg>
  );
}

export function SelectionTray({
  selections,
  total,
  onRemove,
  onClear,
  autoRolled,
  categories,
  tagOptions,
}: SelectionTrayProps) {
  const { t } = useTranslation('tagGenerator');
  const entries = categories
    .filter((cat) => selections[cat.id])
    .map((cat) => {
      const tag = tagOptions[cat.id]?.find((t) => t.id === selections[cat.id]);
      return { catId: cat.id, label: tag?.label || selections[cat.id] || '' };
    });
  const count = entries.length;
  const empty = count === 0;
  const complete = count === total;

  return (
    <div className={[
      'mx-spacing-xl-v2 p-spacing-lg-v2 rounded-xl-v2',
      'bg-Cr-beta-white-3-v2 border border-Cr-beta-white-8-v2',
    ].join(' ')}>
      <div className={[
        'flex items-center justify-between',
        empty ? '' : 'mb-spacing-md-v2',
      ].filter(Boolean).join(' ')}>
        <div className={[
          'inline-flex items-center gap-spacing-md-v2',
          'text-[10px] font-semibold uppercase tracking-[0.08em]',
          'text-Cr-text-subtler-v2 tabular-nums',
        ].join(' ')}>
          {t('selections')} · {count}/{total}
          {complete && (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
              className="stroke-dreamy-brand-hot-v2"
              strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12l5 5L20 7" />
            </svg>
          )}
          {autoRolled && count > 0 && (
            <span className={[
              'inline-flex items-center py-0.5 px-spacing-sm-v2 rounded-md-v2',
              'border border-[rgb(255_25_94_/_0.35)] bg-[rgb(255_25_94_/_0.16)]',
              'text-Cr-Fg-brand-default-v2 text-[10px] tracking-[0.1em]',
            ].join(' ')}>{t('autoRolled')}</span>
          )}
        </div>
        {!empty && (
          <button
            type="button"
            onClick={onClear}
            aria-label="Clear all selections"
            className="bg-transparent border-0 p-0 cursor-pointer text-Cr-text-subtler-v2 text-xs font-medium"
          >{t('clearAll')}</button>
        )}
      </div>
      {!empty && (
        <div className="flex flex-wrap gap-spacing-md-v2">
          {entries.map(({ catId, label }) => (
            <span
              key={catId}
              className={[
                'inline-flex items-center gap-spacing-sm-v2 h-7',
                'pl-spacing-lg-v2 pr-spacing-sm-v2 rounded-full-v2',
                'bg-[rgb(255_25_94_/_0.16)] border border-[rgb(255_25_94_/_0.35)]',
                'text-Cr-Fg-brand-default-v2 text-xs font-medium',
              ].join(' ')}
            >
              {label}
              <button
                type="button"
                onClick={() => onRemove(catId)}
                aria-label={`Remove ${label}`}
                className="w-[18px] h-[18px] rounded-full-v2 bg-transparent border-0 p-0 text-Cr-Fg-brand-default-v2 cursor-pointer inline-flex items-center justify-center"
              ><XIcon size={10} /></button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
