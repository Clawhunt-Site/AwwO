import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  fetchCheckinStatus,
  claimCheckin,
  type CheckinStatus,
} from '../services/checkin';
import { hasTelegramInitData } from '../services/api';
import { trackEvent } from '../services/tracking';
import { useEnergy } from './EnergyContext';

// ── Types ──

interface CheckinContextValue {
  /** Latest fetched checkin status (null until first load). */
  status: CheckinStatus | null;
  loading: boolean;
  error: string | null;
  /** Re-fetch checkin status from server / mock. */
  refresh: () => Promise<void>;
  /** Claim today's reward. Returns true on success. */
  claim: () => Promise<boolean>;
  /** Open the CheckinModal from a specific source. */
  openModal: (source: 'auto' | 'sidebar' | 'lui') => void;
  /** Close the CheckinModal (also refreshes status for red-dot sync). */
  closeModal: () => void;
  isModalOpen: boolean;
  modalSource: 'auto' | 'sidebar' | 'lui';
  /** Whether the auto-open fired during this session/today. */
  autoOpenedToday: boolean;
}

const CheckinContext = createContext<CheckinContextValue | null>(null);

const AUTO_OPEN_KEY = 'dreamy_checkin_last_auto_open_date';

/**
 * Returns today's date in the user's local timezone (YYYY-MM-DD).
 * Using local date (not UTC) prevents early auto-open in UTC+N timezones
 * where the UTC date advances before the local day boundary.
 * Must match the client_tz sent to the backend for day boundary consistency.
 */
function getTodayLocal(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// ── Provider ──

export function CheckinProvider({ children }: { children: ReactNode }) {
  const { refresh: refreshEnergy } = useEnergy();

  const [status, setStatus] = useState<CheckinStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [modalSource, setModalSource] = useState<'auto' | 'sidebar' | 'lui'>('auto');
  const [autoOpenedToday, setAutoOpenedToday] = useState(false);

  const fetchedRef = useRef(false);

  const doFetch = useCallback(async (): Promise<CheckinStatus | null> => {
    if (!hasTelegramInitData()) {
      setStatus(null);
      setLoading(false);
      setError(null);
      return null;
    }
    setLoading(true);
    setError(null);
    try {
      const s = await fetchCheckinStatus();
      setStatus(s);
      return s;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch on mount + auto-open logic
  useEffect(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;

    doFetch().then(s => {
      if (!s) return;
      const lastDate = localStorage.getItem(AUTO_OPEN_KEY);
      const today = getTodayLocal();
      if (lastDate !== today && !s.todayClaimed) {
        setIsModalOpen(true);
        setModalSource('auto');
        setAutoOpenedToday(true);
        localStorage.setItem(AUTO_OPEN_KEY, today);
        // PRD §5.1: checkin_popup_shown with source=home_auto
        trackEvent('checkin_popup_shown', {
          source: 'home_auto',
          streak_day: s.currentStreak,
        });
      }
    });
  }, [doFetch]);

  const refresh = useCallback(async () => {
    await doFetch();
  }, [doFetch]);

  const claim = useCallback(async (): Promise<boolean> => {
    try {
      const result = await claimCheckin();
      // Backend is idempotent: alreadyClaimed=true when duplicate claim. Treat as success.
      const claimed = !result.alreadyClaimed || result.streakDay > 0;
      if (claimed) {
        setStatus(prev =>
          prev
            ? {
                ...prev,
                currentStreak: result.streakDay,
                cycleDay: result.cycleDay,
                todayClaimed: true,
                lastCycleCompleted: result.cycleCompleted,
              }
            : prev,
        );
        void refreshEnergy();
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }, [refreshEnergy]);

  const openModal = useCallback((source: 'auto' | 'sidebar' | 'lui') => {
    setModalSource(source);
    setIsModalOpen(true);
    if (source === 'sidebar') {
      // PRD §5.1: checkin_popup_shown with source=icon_click
      trackEvent('checkin_popup_shown', {
        source: 'icon_click',
        streak_day: status?.currentStreak ?? 0,
      });
    }
  }, []);

  const closeModal = useCallback(() => {
    setIsModalOpen(false);
    // Re-fetch status so the red dot syncs after a claim inside the modal
    void doFetch();
  }, [doFetch]);

  const value: CheckinContextValue = {
    status,
    loading,
    error,
    refresh,
    claim,
    openModal,
    closeModal,
    isModalOpen,
    modalSource,
    autoOpenedToday,
  };

  return (
    <CheckinContext.Provider value={value}>{children}</CheckinContext.Provider>
  );
}

export function useCheckin(): CheckinContextValue {
  const ctx = useContext(CheckinContext);
  if (!ctx) throw new Error('useCheckin must be used inside CheckinProvider');
  return ctx;
}
