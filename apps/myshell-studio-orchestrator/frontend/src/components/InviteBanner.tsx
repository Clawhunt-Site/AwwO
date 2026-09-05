import { useTranslation } from 'react-i18next';
import { useInvite } from '../contexts/InviteContext';
import { useEnergy } from '../contexts/EnergyContext';
import { trackEvent } from '../services/tracking';
import giftIcon from '../assets/invite-gift-icon.png';

/**
 * Page A — "Got an Invite Code?" floating banner at the bottom of Explore.
 * Figma node 520:8451 → inner `_Toasts` container (343×114).
 *
 * Design specs:
 *   - Card: 343×114, #1D1C1F, 8px radius, 12px padding, horizontal layout
 *   - Gift icon: 40×40 circle #FE2049 with white gift glyph
 *   - Title: "Got an Invite Code?" — 14px 500 #FFFFFF
 *   - Desc: "Redeem now for 10 free Energy to start creating." — 12px 400 #FFFFFF
 *   - Add Code btn: 129×28 #D5104B pink, 6px radius, 14px 500 #F7F5FD
 *   - Maybe Later btn: 129×28 #242426, 6px radius, 14px 500 #F5F5F6
 *   - Close X: 20×20 circle rgba(120,120,128) top-right corner
 */
export default function InviteBanner() {
  const { t } = useTranslation('earn');
  const { hasApplied, bannerDismissed, dismissBanner, openInviteModal } = useInvite();
  const { init } = useEnergy();

  // Don't render until init has loaded (prevents flash for returning users)
  if (!init) return null;
  if (hasApplied || bannerDismissed) return null;

  return (
    <div className="fixed bottom-[100px] left-4 right-4 z-[150] pointer-events-none">
      <div className="min-h-[114px] bg-Cr-Bg-surface-default-v2 border border-white/8 rounded-lg-v2 p-3 flex gap-3 relative pointer-events-auto backdrop-blur-[40px]">
        {/* Gift icon — Figma export with gradient + sparkle stars */}
        <img className="w-10 h-10 shrink-0 object-contain" src={giftIcon} alt="" />

        {/* Content: title + desc + action row */}
        <div className="flex-1 min-w-0 flex flex-col gap-2">
          <div className="flex flex-col gap-[2px]">
            <div className="text-sm font-medium leading-5 text-Cr-text-static-white-v2">{t('gotInviteCode')}</div>
            <div className="text-xs font-normal leading-4 text-white/60">
              {t('redeemDesc')}
            </div>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              className="flex-1 h-7 rounded-md-v2 text-sm font-medium leading-5 flex items-center justify-center bg-dreamy-brand-hot-v2 text-Cr-text-static-white-v2 active:bg-dreamy-brand-hot-v2"
              onClick={() => {
                trackEvent('miniapp_invite_click', { source: 'drawer' });
                openInviteModal();
              }}
            >
              {t('addCode')}
            </button>
            <button
              type="button"
              className="flex-1 h-7 rounded-md-v2 text-sm font-medium leading-5 flex items-center justify-center bg-Cr-Bg-surface-subtle-v2 text-Cr-text-default-v2 active:bg-Cr-border-hover-v2"
              onClick={dismissBanner}
            >
              {t('common:maybeLater')}
            </button>
          </div>
        </div>

      </div>
    </div>
  );
}
