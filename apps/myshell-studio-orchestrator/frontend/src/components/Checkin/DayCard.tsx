import { REWARDS_SCHEDULE } from '../../services/checkin';

export type DayCardStatus = 'future' | 'today' | 'claimed';

interface Props {
  day: number;        // 1..7
  status: DayCardStatus;
  isWide?: boolean;   // Day 7 is double-wide
}

// ── Lightning bolt SVG (energy icon) ──
function EnergyIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="20" height="20" viewBox="0 0 20 20" fill="none">
      <defs>
        <linearGradient id="energy-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#ffec8c" />
          <stop offset="100%" stopColor="#f4b335" />
        </linearGradient>
      </defs>
      <path
        d="M11.5 2L5 11h4.5l-1 7L15 9h-4.5l1-7z"
        fill="url(#energy-grad)"
      />
    </svg>
  );
}

// ── Checkmark SVG (claimed icon) ──
function CheckIcon({ isDay7 }: { isDay7: boolean }) {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
      <defs>
        <linearGradient id={isDay7 ? 'check-grad-7' : 'check-grad'} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={isDay7 ? '#ea6748' : '#ffed8c'} />
          <stop offset="100%" stopColor={isDay7 ? '#dc114e' : '#f4b335'} />
        </linearGradient>
      </defs>
      <path
        d="M4 10.5L8 14.5L16 6.5"
        stroke={`url(#${isDay7 ? 'check-grad-7' : 'check-grad'})`}
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

// ── Gift icon for Day 7 ──
function GiftIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
      <defs>
        <linearGradient id="gift-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#ea6748" />
          <stop offset="50%" stopColor="#ec2a64" />
          <stop offset="100%" stopColor="#dc114e" />
        </linearGradient>
      </defs>
      <rect x="2" y="9" width="18" height="11" rx="2" fill="url(#gift-grad)" />
      <rect x="4" y="5" width="14" height="6" rx="2" fill="url(#gift-grad)" opacity="0.8" />
      <rect x="10" y="5" width="2" height="15" fill="#ffffff" opacity="0.3" />
      <path d="M11 5C11 5 8 2 6 3.5S8 7 11 5Z" fill="#ffffff" opacity="0.4" />
      <path d="M11 5C11 5 14 2 16 3.5S14 7 11 5Z" fill="#ffffff" opacity="0.4" />
    </svg>
  );
}

export default function DayCard({ day, status, isWide }: Props) {
  const isDay7 = day === 7;
  const reward = REWARDS_SCHEDULE[day - 1];
  const hasBonus = reward.bonus > 0;
  const hasSelfDirector = reward.selfDirector > 0;

  // Card background + border classes
  let cardBg: string;
  let borderClass = '';

  if (isDay7) {
    switch (status) {
      case 'future':
        cardBg = 'bg-dreamy-checkin-day7-future-v2';
        borderClass = 'border border-dreamy-checkin-day7-accent-v2/40';
        break;
      case 'today':
        cardBg = 'bg-dreamy-checkin-day7-today-v2';
        borderClass = 'border border-dreamy-checkin-day7-accent-v2';
        break;
      case 'claimed':
        cardBg = 'bg-dreamy-checkin-day7-future-v2';
        break;
    }
  } else {
    switch (status) {
      case 'future':
        cardBg = 'bg-dreamy-checkin-card-future-v2';
        break;
      case 'today':
        cardBg = 'bg-dreamy-checkin-card-today-v2';
        borderClass = 'border border-dreamy-checkin-gold-v2';
        break;
      case 'claimed':
        cardBg = 'bg-dreamy-checkin-card-claimed-v2';
        break;
    }
  }

  // Text color
  const accentColor = isDay7 ? 'text-dreamy-checkin-day7-accent-v2' : 'text-dreamy-checkin-gold-text-v2';
  const labelColor = isDay7 && status !== 'claimed'
    ? 'text-dreamy-checkin-day7-accent-v2'
    : 'text-Cr-text-static-white-v2/40';

  return (
    <div className="relative flex-1">
      {/* Bonus tag */}
      {(hasBonus || hasSelfDirector) && (
        <div className="absolute -top-3 left-1/2 -translate-x-1/2 z-10 whitespace-nowrap">
          <span className="inline-block px-2 py-0.5 rounded-full bg-dreamy-checkin-tag-bg-v2 text-dreamy-checkin-tag-text-v2 text-[10px] font-medium leading-tight">
            {hasBonus ? `Extra+${reward.bonus}` : 'Big Reward'}
          </span>
        </div>
      )}

      <div
        className={[
          'flex flex-col items-center justify-center gap-2 rounded-md py-2.5 px-3',
          cardBg,
          borderClass,
          isWide ? 'min-w-0' : '',
          'h-[94px]',
        ].filter(Boolean).join(' ')}
      >
        {/* Day label */}
        <span className={`text-xs font-medium ${labelColor}`}>
          {status === 'today' ? 'Today' : `Day ${day}`}
        </span>

        {/* Icon */}
        {status === 'claimed' ? (
          <CheckIcon isDay7={isDay7} />
        ) : isDay7 ? (
          <GiftIcon />
        ) : (
          <EnergyIcon />
        )}

        {/* Reward amount */}
        <span className={`text-sm font-medium ${accentColor}`}>
          +{reward.energy}
        </span>
      </div>
    </div>
  );
}
