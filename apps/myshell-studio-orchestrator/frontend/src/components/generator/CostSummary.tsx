/**
 * CostSummary
 * Two-column card showing estimated time + energy cost
 * Uses brand-tinted border + bg via design tokens
 * Container-query responsive: stacks on narrow devices, side-by-side on wider
 */

import energyBoltImg from '../../assets/energy-bolt.png';
import { useTranslation } from 'react-i18next';

interface CostSummaryProps {
  estimatedMins: number;
  energyCost: number;
}

function ClockIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
    </svg>
  );
}

function BoltIcon({ size = 11 }: { size?: number }) {
  return (
    <img src={energyBoltImg} alt="" width={size} height={size} className="inline-block" />
  );
}

export function CostSummary({ estimatedMins, energyCost }: CostSummaryProps) {
  const { t } = useTranslation('tagGenerator');
  return (
    <div
      className={[
        '@container py-spacing-xl-v2 px-spacing-xs-v2 rounded-xl-v2',
        'bg-[rgb(255_25_94_/_0.08)] border border-[rgb(255_25_94_/_0.25)]',
      ].join(' ')}
    >
      <div className={[
        'grid gap-spacing-md-v2 grid-cols-1',
        '@xs:gap-0 @xs:grid-cols-[1fr_1px_1fr]',
      ].join(' ')}>
        {/* Left: Estimated time */}
        <div className="px-spacing-xl-v2 min-w-0 flex flex-col items-start gap-spacing-sm-v2">
          <div className={[
            'flex items-center gap-spacing-sm-v2',
            'text-[10px] font-semibold uppercase tracking-[0.08em]',
            'text-Cr-text-subtler-v2',
          ].join(' ')}>
            <ClockIcon />
            {t('estTime')}
          </div>
          <div className="flex items-baseline gap-spacing-xs-v2">
            <span className="text-2xl font-semibold text-Cr-text-default-v2 tabular-nums">{estimatedMins}</span>
            <span className="text-xs text-Cr-text-subtler-v2">{t('mins')}</span>
          </div>
        </div>

        {/* Divider — horizontal on narrow, vertical on wider */}
        <div className="bg-Cr-beta-white-8-v2 h-px mx-spacing-xl-v2 @xs:h-auto @xs:w-px @xs:mx-0" />

        {/* Right: Energy cost */}
        <div className="px-spacing-xl-v2 min-w-0 flex flex-col items-start gap-spacing-sm-v2">
          <div className={[
            'flex items-center gap-spacing-sm-v2',
            'text-[10px] font-semibold uppercase tracking-[0.08em]',
            'text-Cr-Fg-brand-default-v2',
          ].join(' ')}>
            <BoltIcon size={11} />
            {t('energyCost')}
          </div>
          <div className="flex items-baseline gap-spacing-xs-v2">
            <span className="text-2xl font-semibold text-Cr-Fg-brand-default-v2 tabular-nums">{energyCost}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
