import { useEffect, useState } from 'react';
import { trackEvent } from '../services/tracking';
import { shouldBypassAgeGateForDev } from './ageGate';

const AGE_GATE_STORAGE_KEY = 'dp_age_gate_passed';

function readPassed(): boolean {
  if (typeof window !== 'undefined' && shouldBypassAgeGateForDev(window.location.search)) {
    return true;
  }
  try {
    return localStorage.getItem(AGE_GATE_STORAGE_KEY) === '1';
  } catch {
    return true; // fail-open: if storage blocked, don't block the user
  }
}

/**
 * Minimal 18+ age gate. Renders once per device (persisted in localStorage).
 * Emits shown/passed/blocked tracking events. Users who select "Under 18"
 * are closed out of the webview via Telegram.WebApp.close().
 */
export default function AgeGateModal() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!readPassed()) {
      setOpen(true);
      try {
        trackEvent('miniapp_age_gate_shown', {});
      } catch { /* noop */ }
    }
  }, []);

  if (!open) return null;

  const handlePass = () => {
    try {
      localStorage.setItem(AGE_GATE_STORAGE_KEY, '1');
    } catch { /* ignore */ }
    try {
      trackEvent('miniapp_age_gate_passed', { user_age_claimed: '18+' });
    } catch { /* noop */ }
    setOpen(false);
  };

  const handleBlock = () => {
    try {
      trackEvent('miniapp_age_gate_blocked', { reason: 'under_age' });
    } catch { /* noop */ }
    try {
      window.Telegram?.WebApp?.close?.();
    } catch { /* fallback: leave modal up so they can't proceed */ }
  };

  return (
    <div
      className="fixed inset-0 z-[1000] bg-black/80 backdrop-blur-[20px] flex items-center justify-center px-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="age-gate-title"
    >
      <div className="w-full max-w-[327px] bg-Cr-Bg-surface-default-v2 rounded-lg-v2 p-5 flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <h2
            id="age-gate-title"
            className="text-xl font-semibold leading-7 text-Cr-text-default-v2 m-0"
          >
            Adults only (18+)
          </h2>
          <p className="text-sm font-normal leading-5 text-Cr-text-subtler-v2 m-0">
            This app contains AI-generated content intended for adults. Please
            confirm you are at least 18 years old to continue.
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <button
            type="button"
            className="w-full h-11 rounded-md-v2 text-base font-semibold leading-6 flex items-center justify-center bg-dreamy-brand-hot-v2 text-Cr-text-static-white-v2 active:bg-dreamy-brand-button-active-v2"
            onClick={handlePass}
          >
            I am 18 or older
          </button>
          <button
            type="button"
            className="w-full h-11 rounded-md-v2 text-base font-medium leading-6 flex items-center justify-center bg-Cr-Bg-surface-subtle-v2 text-Cr-text-subtler-v2 active:bg-dreamy-neutral-button-active-v2"
            onClick={handleBlock}
          >
            I am under 18
          </button>
        </div>
      </div>
    </div>
  );
}
