/**
 * GenerateDock
 * Absolute-positioned bottom dock with gradient fade, inline Toast, and Generate CTA
 */
import energyBoltImg from '../../assets/energy-bolt.png';
import { useTranslation } from 'react-i18next';

interface GenerateDockProps {
  isEmpty: boolean;
  energyCost: number;
  onGenerate: () => void;
  disabled?: boolean;
}

function DiceIcon({ size = 10 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="3" width="18" height="18" rx="3.5" />
      <circle cx="8.5" cy="8.5" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="15.5" cy="8.5" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="8.5" cy="15.5" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="15.5" cy="15.5" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  );
}

function SparkleIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 2 L13.5 9.5 L21 11 L13.5 12.5 L12 20 L10.5 12.5 L3 11 L10.5 9.5 Z" />
    </svg>
  );
}

export function GenerateDock({ isEmpty, onGenerate, disabled }: GenerateDockProps) {
  const isDisabled = disabled || isEmpty;
  const { t } = useTranslation('tagGenerator');

  return (
    <div
      className={[
        'absolute left-0 right-0 bottom-0 pointer-events-none',
        'py-spacing-2xl-v2 px-spacing-xl-v2 pb-[calc(env(safe-area-inset-bottom,16px)+12px)]',
        'bg-[image:linear-gradient(180deg,rgba(14,14,15,0)_0%,rgba(14,14,15,0.85)_35%,var(--color-Cr-Bg-clean-v2)_70%)]',
      ].join(' ')}
    >
      <div className="pointer-events-auto">
        {/* Toast — shown when empty */}
        {isEmpty && (
          <div className="mb-spacing-md-v2">
            <div className={[
              'flex items-center gap-spacing-md-v2 py-2.5 px-spacing-lg-v2 rounded-full-v2',
              'bg-[rgb(255_25_94_/_0.16)] border border-[rgb(255_25_94_/_0.35)]',
              'text-Cr-text-default-v2 text-xs',
            ].join(' ')}>
              <span className="text-Cr-text-warning-default-v2 inline-flex">
                <SparkleIcon />
              </span>
              {t('tapChipOrRandom')}{' '}
              <span className={[
                'inline-flex items-center gap-spacing-xs-v2',
                'py-px px-spacing-sm-v2 rounded-md-v2',
                'bg-Cr-beta-white-8-v2 text-Cr-text-default-v2',
                'text-[10px] font-semibold tracking-[0.08em]',
              ].join(' ')}>
                <DiceIcon size={10} /> {t('randomButton')}
              </span>{' '}
              {t('toStart')}
            </div>
          </div>
        )}

        {/* Generate CTA */}
        <button
          type="button"
          onClick={onGenerate}
          disabled={isDisabled}
          aria-disabled={isDisabled}
          className={[
            'flex h-12 w-full items-center justify-center gap-spacing-sm-v2',
            'rounded-xl-v2 text-base font-semibold',
            isDisabled
              ? 'opacity-50 cursor-not-allowed'
              : [
                  'cursor-pointer',
                  'bg-[image:linear-gradient(90deg,var(--color-dreamy-generate-from-v2)_0%,var(--color-dreamy-generate-to-v2)_100%)]',
                  'shadow-[inset_0_1px_0_rgb(255_255_255_/_0.18)]',
                ].join(' '),
          ].join(' ')}
          aria-label="Generate"
        >
          <img src={energyBoltImg} alt="" width={14} height={14} className="inline-block" />
          {t('generate')}
        </button>
      </div>
    </div>
  );
}
