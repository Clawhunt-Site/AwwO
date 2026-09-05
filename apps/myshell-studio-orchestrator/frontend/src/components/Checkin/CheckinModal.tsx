import { useState, useEffect, useCallback, useRef } from 'react';
import {
  fetchCheckinStatus,
  claimCheckin,
  REWARDS_SCHEDULE,
  type CheckinStatus,
} from '../../services/checkin';
import { trackEvent } from '../../services/tracking';
import { useEnergy } from '../../contexts/EnergyContext';
import Skeleton from '../Skeleton';
import DayCard, { type DayCardStatus } from './DayCard';

// ── Types ──

type ModalState = 'loading' | 'claimable' | 'claimed' | 'day7_big' | 'error';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Where the modal was triggered from (for tracking). */
  source?: 'auto' | 'sidebar' | 'lui';
}

// ── Large energy bolt for header ──
function LargeEnergyIcon() {
  return (
    <svg width="68" height="68" viewBox="0 0 68 68" fill="none">
      <defs>
        <linearGradient id="lg-energy" x1="34" y1="0" x2="34" y2="68">
          <stop offset="0%" stopColor="#ffed8f" />
          <stop offset="50%" stopColor="#ffe663" />
          <stop offset="100%" stopColor="#f5a60e" />
        </linearGradient>
      </defs>
      <path
        d="M38 6L16 36h14l-4 26L50 32H36l2-26z"
        fill="url(#lg-energy)"
      />
    </svg>
  );
}

// ── Close X icon ──
function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path d="M1 1L13 13M13 1L1 13" stroke="white" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

// ── Subtitle logic ──
function getSubtitle(status: CheckinStatus): string {
  const { cycleDay, todayClaimed, lastCycleCompleted, currentStreak } = status;
  const claimable = !todayClaimed;
  if (lastCycleCompleted && !claimable) return 'Final reward claimed, next cycle unlocks tomorrow.';
  if (currentStreak === 0 && claimable) return 'Hit Day 3 for a bonus. Reach Day 7 for the big reward.';
  if (cycleDay < 3) return `Bonus reward unlocks in ${3 - cycleDay} day${3 - cycleDay > 1 ? 's' : ''}.`;
  if (cycleDay < 7) return `Stay on track \u2014 big reward in ${7 - cycleDay} day${7 - cycleDay > 1 ? 's' : ''}.`;
  if (cycleDay === 7 && claimable) return 'Claim your big reward today!';
  return 'Keep going \u2014 you\'re doing great!';
}

// ── Day card status helpers ──
function getDayStatus(day: number, status: CheckinStatus): DayCardStatus {
  const { currentStreak, cycleDay, todayClaimed } = status;

  // Days already claimed in this cycle
  if (day <= currentStreak) return 'claimed';

  // Today's day
  if (day === cycleDay) {
    // If already claimed today, show as claimed
    if (todayClaimed) return 'claimed';
    return 'today';
  }

  return 'future';
}

// ── Component ──

export default function CheckinModal({ open, onClose, source = 'auto' }: Props) {
  const [modalState, setModalState] = useState<ModalState>('loading');
  const [status, setStatus] = useState<CheckinStatus | null>(null);
  const [claiming, setClaiming] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const claimedThisOpen = useRef(false);
  const { refresh: refreshEnergy } = useEnergy();

  // Load checkin status on open
  useEffect(() => {
    if (!open) return;
    claimedThisOpen.current = false;
    setShowSuccess(false);
    loadStatus();
  }, [open]);

  // Esc key to close
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open]);

  // Track modal open
  // Note: PRD §5.1 `checkin_popup_shown` is fired in CheckinContext (covers
  // both `source=home_auto` and `source=icon_click`). We keep an internal-only
  // debug event here removed to avoid duplicate popup tracking.
  // (No-op placeholder effect intentionally removed; keep open dependency flow.)

  async function loadStatus() {
    setModalState('loading');
    setErrorMsg('');
    try {
      const s = await fetchCheckinStatus();
      setStatus(s);
      const claimable = !s.todayClaimed;
      if (s.cycleDay === 7 && claimable) {
        setModalState('day7_big');
      } else if (claimable) {
        setModalState('claimable');
      } else {
        setModalState('claimed');
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to load');
      setModalState('error');
    }
  }

  async function handleClaim() {
    if (!status || claiming) return;
    setClaiming(true);

    const streakBefore = status.currentStreak;

    try {
      const result = await claimCheckin();

      // PRD §5.1: checkin_claimed — canonical claim event
      trackEvent('checkin_claimed', {
        streak_day: result.streakDay,
        energy_granted: result.energyGranted,
        bonus_energy: result.bonusGranted,
        self_director_granted: result.selfDirectorGranted,
        milestone: result.milestone,
        source,
        is_capped: result.isCapped,
        already_claimed: result.alreadyClaimed,
      });

      // PRD §5.1: checkin_milestone_reached — fire when milestone is set
      // (backend signals D3 bonus or D7 self-director via the `milestone` field;
      // falsy empty string means no milestone this day)
      if (result.milestone) {
        trackEvent('checkin_milestone_reached', {
          milestone_type: result.milestone, // 'd3' | 'd7'
          streak_day: result.streakDay,
        });
      }

      // PRD §5.1: checkin_streak_broken — fire when streak resets to 1
      // after being broken (streakBefore > 1 and newStreak == 1 means a break).
      // Cycle-completion at day 7 also resets to 1 but is not a break; skip those.
      if (streakBefore > 1 && result.streakDay === 1 && !result.cycleCompleted) {
        trackEvent('checkin_streak_broken', {
          last_streak: streakBefore,
        });
      }

      // Update local status optimistically
      setStatus(prev => prev ? {
        ...prev,
        currentStreak: result.streakDay,
        cycleDay: result.cycleDay,
        todayClaimed: true,
        lastCycleCompleted: result.cycleCompleted,
      } : prev);

      claimedThisOpen.current = true;
      setShowSuccess(true);

      // Show success for 2s, then transition to claimed state
      setTimeout(() => {
        setShowSuccess(false);
        setModalState('claimed');
      }, 2000);

      // Refresh energy balance in the global context
      void refreshEnergy();
    } catch (err) {
      // PRD §5.1 does not spec a failure event; keep internal debug event
      // under a non-PRD namespace so analytics teams can filter.
      trackEvent('checkin_claim_error_internal', {
        error_code: err instanceof Error ? err.message : 'unknown',
      });
      setErrorMsg(err instanceof Error ? err.message : 'Claim failed');
      setModalState('error');
    } finally {
      setClaiming(false);
    }
  }

  const handleClose = useCallback(() => {
    // PRD §5.1 does not spec a modal-close event; keep internal debug event.
    trackEvent('checkin_modal_close_internal', {
      streak: status?.currentStreak ?? 0,
      claimed_this_open: claimedThisOpen.current,
    });
    onClose();
  }, [onClose, status]);

  if (!open) return null;

  const totalToday = status
    ? status.todayReward.energy + status.todayReward.bonus
    : 0;

  return (
    <div className="fixed inset-0 z-[500] flex flex-col justify-end animate-[fadeIn_0.2s_ease]">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60" onClick={handleClose} />

      {/* Close button bar */}
      <div className="relative z-10 flex justify-end px-4 pb-2">
        <button
          onClick={handleClose}
          className="w-9 h-9 rounded-full bg-dreamy-checkin-close-bg-v2 flex items-center justify-center"
          aria-label="Close"
        >
          <CloseIcon />
        </button>
      </div>

      {/* Bottom sheet */}
      <div
        className="relative z-10 bg-dreamy-checkin-bg-v2 rounded-t-lg-v2 overflow-hidden animate-[slideUp_0.3s_ease]"
        onClick={e => e.stopPropagation()}
      >
        {/* Success toast */}
        {showSuccess && status && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 animate-[fadeIn_0.3s_ease]">
            <div className="flex items-center gap-2 px-4 py-2 rounded-full bg-Cr-Bg-surface-default-v2">
              <div className="w-4 h-4 rounded-full bg-Cr-Bg-success-bolder-v2 flex items-center justify-center">
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                  <path d="M2 5L4 7L8 3" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
              <span className="text-sm text-Cr-text-default-v2 whitespace-nowrap">
                Nice, you got +{totalToday} Energy
              </span>
            </div>
          </div>
        )}

        {modalState === 'loading' ? (
          <LoadingSkeleton />
        ) : modalState === 'error' ? (
          <ErrorView message={errorMsg} onRetry={loadStatus} />
        ) : status ? (
          <>
            {/* Gradient header */}
            <div className="relative px-4 pt-6 pb-4">
              {/* Subtle gold gradient overlay */}
              <div className="absolute inset-0 bg-linear-to-b from-dreamy-checkin-gold-v2/8 to-transparent pointer-events-none" />

              <div className="relative flex items-start gap-3">
                <LargeEnergyIcon />
                <div className="flex flex-col gap-1.5 pt-1">
                  <h2 className="text-xl font-semibold text-Cr-text-static-white-v2">
                    Daily Rewards
                  </h2>
                  <p className="text-sm text-Cr-text-static-white-v2/80 leading-5">
                    {getSubtitle(status)}
                  </p>
                </div>
              </div>
            </div>

            {/* Day grid */}
            <div className="px-4 py-1">
              {/* Row 1: Days 1-4 */}
              <div className="flex gap-2 mb-2 pt-4">
                {[1, 2, 3, 4].map(day => (
                  <DayCard
                    key={day}
                    day={day}
                    status={getDayStatus(day, status)}
                  />
                ))}
              </div>
              {/* Row 2: Days 5-7 (Day 7 is double-wide) */}
              <div className="flex gap-2 pt-4">
                {[5, 6].map(day => (
                  <DayCard
                    key={day}
                    day={day}
                    status={getDayStatus(day, status)}
                  />
                ))}
                <div className="flex-[2]">
                  <DayCard
                    day={7}
                    status={getDayStatus(7, status)}
                    isWide
                  />
                </div>
              </div>
            </div>

            {/* CTA Footer */}
            <div className="px-4 pt-3 pb-[calc(env(safe-area-inset-bottom,6px)+6px)]">
              {modalState === 'claimable' || modalState === 'day7_big' ? (
                <button
                  onClick={handleClaim}
                  disabled={claiming}
                  className="w-full h-12 rounded-md bg-dreamy-checkin-cta-v2 text-Cr-text-static-white-v2 text-base font-semibold flex items-center justify-center gap-2 active:opacity-80 disabled:opacity-60 transition-opacity"
                >
                  {claiming ? (
                    <span className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-[spin_0.6s_linear_infinite]" />
                  ) : (
                    <>
                      Claim Today&apos;s Reward
                      <span className="flex items-center gap-0.5 text-sm opacity-90">
                        +{totalToday}
                        <svg width="12" height="12" viewBox="0 0 20 20" fill="none" className="inline-block">
                          <path d="M11.5 2L5 11h4.5l-1 7L15 9h-4.5l1-7z" fill="currentColor" />
                        </svg>
                      </span>
                    </>
                  )}
                </button>
              ) : (
                <button
                  disabled
                  className="w-full h-12 rounded-md bg-dreamy-checkin-disabled-bg-v2 text-dreamy-checkin-disabled-text-v2 text-base font-semibold flex items-center justify-center gap-2"
                >
                  Checked In Today
                </button>
              )}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

// ── Sub-views ──

function LoadingSkeleton() {
  return (
    <div className="px-4 py-6 flex flex-col gap-4">
      <div className="flex items-start gap-3">
        <Skeleton width="68px" height="68px" borderRadius="12px" />
        <div className="flex-1 flex flex-col gap-2 pt-1">
          <Skeleton width="140px" height="24px" />
          <Skeleton width="220px" height="16px" />
        </div>
      </div>
      <div className="flex gap-2">
        {[1, 2, 3, 4].map(i => (
          <div key={i} className="flex-1">
            <Skeleton width="100%" height="94px" borderRadius="6px" />
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <div className="flex-1"><Skeleton width="100%" height="94px" borderRadius="6px" /></div>
        <div className="flex-1"><Skeleton width="100%" height="94px" borderRadius="6px" /></div>
        <div className="flex-[2]"><Skeleton width="100%" height="94px" borderRadius="6px" /></div>
      </div>
      <Skeleton width="100%" height="48px" borderRadius="6px" />
    </div>
  );
}

function ErrorView({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="px-4 py-10 flex flex-col items-center gap-4">
      <div className="w-12 h-12 rounded-full bg-dreamy-checkin-day7-future-v2 flex items-center justify-center">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <path d="M12 8v4m0 4h.01" stroke="#ff406a" strokeWidth="2" strokeLinecap="round" />
          <circle cx="12" cy="12" r="10" stroke="#ff406a" strokeWidth="2" />
        </svg>
      </div>
      <p className="text-sm text-Cr-text-subtle-v2 text-center">{message}</p>
      <button
        onClick={onRetry}
        className="px-6 h-10 rounded-md bg-dreamy-checkin-cta-v2 text-Cr-text-static-white-v2 text-sm font-semibold active:opacity-80"
      >
        Retry
      </button>
    </div>
  );
}
