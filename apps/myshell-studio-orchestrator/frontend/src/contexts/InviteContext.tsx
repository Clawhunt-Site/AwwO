import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import {
  fetchEarn,
  applyInviteCode,
  type EarnData,
  type ApplyInviteResult,
} from '../services/invite';
import { useEnergy } from './EnergyContext';
import { ApiError, consumeDeepLinkInviteCode } from '../services/api';
import i18n from '../i18n';

interface InviteContextValue {
  // ── Derived from init.inviteInfo (via EnergyContext) ───────────────
  /** Whether the current user has already applied someone else's code. */
  hasApplied: boolean;
  /** The code the current user applied, if any — for Settings display. */
  appliedCode: string | null;

  // ── From /earn endpoint ───────────────────────────────────────────
  /** Number of friends this user has successfully invited. */
  friendsInvited: number;
  /** Total energy this user has earned from invites. */
  energyEarnedFromInvite: number;

  // ── Lazy-loaded from /earn (user's own code + share link) ─────────
  inviteCode: string | null;
  inviteLink: string | null;
  linkLoading: boolean;
  /** Fetches /earn once; pass force=true to refetch. */
  ensureEarn: (force?: boolean) => Promise<void>;

  // ── Actions ────────────────────────────────────────────────────────
  /** Redeem someone else's code. Returns the raw backend result; callers
   *  must check `result.success` and display `result.message` on failure. */
  apply: (code: string) => Promise<ApplyInviteResult>;

  // ── Home banner session state ──────────────────────────────────────
  bannerDismissed: boolean;
  dismissBanner: () => void;

  // ── Global modal visibility ────────────────────────────────────────
  inviteModalOpen: boolean;
  /** Pre-filled invite code from deep link, if any. */
  prefillCode: string | null;
  openInviteModal: () => void;
  closeInviteModal: () => void;
}

const InviteContext = createContext<InviteContextValue | null>(null);

/** Map backend error reason codes to user-friendly messages. */
function mapInviteError(reason: string, fallback: string): string {
  switch (reason) {
    case 'ERROR_REASON_AFFILIATE_CODE_NOT_FOUND':
      return i18n.t('earn:inviteErrorNotFound');
    case 'ERROR_REASON_AFFILIATE_SELF_INVITE':
      return i18n.t('earn:inviteErrorSelfInvite');
    case 'ERROR_REASON_AFFILIATE_ALREADY_APPLIED':
      return i18n.t('earn:inviteErrorAlreadyApplied');
    case 'ERROR_REASON_AFFILIATE_INVITER_DAILY_LIMIT':
      return i18n.t('earn:inviteErrorDailyLimit');
    default:
      return fallback || i18n.t('common:somethingWentWrongRetry');
  }
}

export function InviteProvider({ children }: { children: React.ReactNode }) {
  const { init, refresh: refreshEnergy } = useEnergy();

  // Earn data cache (invite code, link, stats)
  const [earnData, setEarnData] = useState<EarnData | null>(null);
  const [linkLoading, setLinkLoading] = useState(false);
  const earnFetchedRef = useRef(false);

  // Local override for hasApplied / appliedCode after a successful apply,
  // so the UI updates immediately without waiting for a re-fetch of init.
  const [localApplied, setLocalApplied] = useState<{ code: string } | null>(null);

  // Modal / banner state
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [inviteModalOpen, setInviteModalOpen] = useState(false);
  const [prefillCode, setPrefillCode] = useState<string | null>(null);

  // Derived from init.inviteInfo
  const initInvite = init?.inviteInfo;
  const hasApplied =
    localApplied != null || Boolean(initInvite?.appliedCode);
  const appliedCode =
    localApplied?.code ?? (initInvite?.appliedCode || null);

  // From earn data
  const friendsInvited = earnData?.friendsInvited ?? 0;
  const energyEarnedFromInvite = earnData?.energyEarnedFromInvite ?? 0;

  // Auto-open invite modal with pre-filled code when user arrives via invite link.
  // Wait for init to complete so we know if the user has already applied a code.
  useEffect(() => {
    if (!init || hasApplied) return;
    const code = consumeDeepLinkInviteCode();
    if (code) {
      setPrefillCode(code);
      setInviteModalOpen(true);
    }
  }, [init, hasApplied]);

  const ensureEarn = useCallback(async (force = false) => {
    if (earnFetchedRef.current && !force) return;
    earnFetchedRef.current = true;
    setLinkLoading(true);
    try {
      const data = await fetchEarn();
      setEarnData(data);
    } catch (e) {
      console.error('[InviteContext] fetchEarn failed', e);
      earnFetchedRef.current = false; // allow retry
    } finally {
      setLinkLoading(false);
    }
  }, []);

  // Dev-only: expose modal triggers on window for manual testing.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    (window as unknown as { __invite?: unknown }).__invite = {
      openInviteModal: () => setInviteModalOpen(true),
    };
  }, []);

  const apply = useCallback(async (code: string): Promise<ApplyInviteResult> => {
    const trimmed = code.trim().toUpperCase();
    try {
      const result = await applyInviteCode(trimmed);
      if (result.success) {
        setLocalApplied({ code: trimmed });
        // Re-fetch init so energy / server-side state syncs.
        void refreshEnergy();
      }
      return result;
    } catch (e) {
      // Backend returns HTTP 400 with ApiError for business errors.
      const message =
        e instanceof ApiError
          ? mapInviteError(e.reason, e.message)
          : i18n.t('common:networkError');
      return { success: false, message, energyRewarded: 0 };
    }
  }, [refreshEnergy]);

  const value: InviteContextValue = {
    hasApplied,
    appliedCode,
    friendsInvited,
    energyEarnedFromInvite,
    inviteCode: earnData?.inviteCode ?? null,
    inviteLink: earnData?.inviteLink ?? null,
    linkLoading,
    ensureEarn,
    apply,
    bannerDismissed,
    dismissBanner: () => setBannerDismissed(true),
    inviteModalOpen,
    prefillCode,
    openInviteModal: () => setInviteModalOpen(true),
    closeInviteModal: () => { setInviteModalOpen(false); setPrefillCode(null); },
  };

  return <InviteContext.Provider value={value}>{children}</InviteContext.Provider>;
}

export function useInvite(): InviteContextValue {
  const ctx = useContext(InviteContext);
  if (!ctx) throw new Error('useInvite must be used inside InviteProvider');
  return ctx;
}
