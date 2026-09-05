import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from './Modal';
import { useInvite } from '../contexts/InviteContext';
import { useCheckin } from '../contexts/CheckinContext';
import { useToast } from '../contexts/ToastContext';
import { trackEvent } from '../services/tracking';

/**
 * Page B — "Unlock Free Energy" invite-code entry modal.
 * Figma nodes 299:5706 (empty) and 299:6063 (error).
 *
 * Design specs (from Figma):
 *   - Card: 327×auto, #1D1C1F, 8px radius, 20px padding, 20px row gap
 *   - Gift icon: 40×40 circle #242426, 1.5px stroke #F5F5F6 gift glyph
 *   - Title: "Unlock Free Energy" — 20px 500 #F5F5F6 (ABC Diatype → fallback SF Pro)
 *   - Desc: 14px 400 #96949C, 6px below title
 *   - Input: 287×40 #242426, 6px radius, 12px horizontal padding
 *   - Apply: 287×44 #D5104B (brand pink), 6px radius, 16px 510 #F7F5FD label
 *   - Not now: 287×44 dark gray, 6px radius, 16px 510 #F5F5F6 label
 *   - Close X: 28×28 top-right corner, 6px radius, 18px glyph
 */
export default function InviteCodeModal() {
  const { t } = useTranslation('earn');
  const { inviteModalOpen, closeInviteModal, apply, prefillCode } = useInvite();
  const { isModalOpen: checkinModalOpen } = useCheckin();
  const { showToast } = useToast();

  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Reset state whenever the modal opens; pre-fill if arriving via invite link.
  useEffect(() => {
    if (inviteModalOpen) {
      setCode(prefillCode ?? '');
      setError(null);
      setSubmitting(false);
    }
  }, [inviteModalOpen, prefillCode]);

  const handleApply = async () => {
    if (submitting) return;
    if (!code.trim()) {
      setError(t('enterInviteCode'));
      return;
    }
    trackEvent('miniapp_invite_click', { source: 'onboarding' });
    setError(null);
    setSubmitting(true);
    const result = await apply(code);
    if (!result.success) {
      setError(result.message || t('invalidCode'));
      setSubmitting(false);
      return;
    }
    closeInviteModal();
    // Figma wording: "Code applied- enjoy your free Energy now!" (no space before hyphen)
    showToast(t('codeApplied'), { duration: 3000 });
  };

  return (
    <Modal open={inviteModalOpen && !checkinModalOpen} onClose={closeInviteModal}>
      {/* Close X (top-right) */}
      <button
        type="button"
        className="absolute top-[14px] right-[14px] w-7 h-7 rounded-md-v2 flex items-center justify-center bg-transparent p-0 active:bg-white/[0.06]"
        onClick={closeInviteModal}
        aria-label="Close"
      >
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
          <path
            d="M4.5 4.5 L13.5 13.5 M13.5 4.5 L4.5 13.5"
            stroke="#F5F5F6"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      </button>

      {/* Header: gift icon + title + description */}
      <div className="flex flex-col gap-3">
        <div className="w-10 h-10 rounded-full bg-Cr-Bg-surface-subtle-v2 flex items-center justify-center shrink-0">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
            <path
              d="M20 12V22H4V12 M2 7H22V12H2V7Z M12 22V7 M12 7H7.5C6.83696 7 6.20107 6.73661 5.73223 6.26777C5.26339 5.79893 5 5.16304 5 4.5C5 3.83696 5.26339 3.20107 5.73223 2.73223C6.20107 2.26339 6.83696 2 7.5 2C11 2 12 7 12 7Z M12 7H16.5C17.163 7 17.7989 6.73661 18.2678 6.26777C18.7366 5.79893 19 5.16304 19 4.5C19 3.83696 18.7366 3.20107 18.2678 2.73223C17.7989 2.26339 17.163 2 16.5 2C13 2 12 7 12 7Z"
              stroke="#F5F5F6"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
        <h2
          className="text-xl font-medium leading-7 text-Cr-text-default-v2 tracking-[-0.2px]"
          style={{ fontFamily: "-apple-system, 'SF Pro Display', system-ui, sans-serif" }}
        >
          {t('unlockFreeEnergy')}
        </h2>
        <p
          className="text-sm font-normal leading-5 text-Cr-text-subtler-v2 -mt-1.5"
          style={{ fontFamily: "-apple-system, 'SF Pro Text', system-ui, sans-serif" }}
        >
          {t('inviteCodeDesc')}
        </p>
      </div>

      {/* Input */}
      <div className="flex flex-col gap-1.5">
        <input
          type="text"
          value={code}
          onChange={e => {
            setCode(e.target.value);
            if (error) setError(null);
          }}
          placeholder={t('pasteInviteCode')}
          className={`w-full h-10 bg-Cr-Bg-surface-subtle-v2 border rounded-md-v2 px-3 text-base font-normal text-Cr-text-default-v2 outline-none transition-[border-color] duration-150 ease-in-out placeholder:text-Cr-text-subtlest-v2 focus:border-[#414345] ${
            error ? 'border-dreamy-gradient-05-stop-3-v2' : 'border-transparent'
          }`}
          style={{ fontFamily: "-apple-system, 'SF Pro Text', system-ui, sans-serif" }}
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          maxLength={24}
          disabled={submitting}
        />
        {error && (
          <div
            className="text-sm font-normal leading-[18px] text-dreamy-gradient-05-stop-3-v2"
            style={{ fontFamily: "-apple-system, 'SF Pro Text', system-ui, sans-serif" }}
          >
            {error}
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex flex-col gap-2">
        <button
          type="button"
          className="w-full h-11 rounded-md-v2 text-base font-[590] leading-6 flex items-center justify-center bg-dreamy-brand-hot-v2 text-Cr-text-static-white-v2 active:bg-Cr-Bg-brand-active-v2 disabled:opacity-60"
          style={{ fontFamily: "-apple-system, 'SF Pro Text', system-ui, sans-serif" }}
          onClick={handleApply}
          disabled={submitting}
        >
          {submitting ? t('common:applying') : t('common:apply')}
        </button>
      </div>
    </Modal>
  );
}
