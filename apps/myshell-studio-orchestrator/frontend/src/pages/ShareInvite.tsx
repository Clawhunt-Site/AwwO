import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Trans, useTranslation } from 'react-i18next';
import { useInvite } from '../contexts/InviteContext';
import { useToast } from '../contexts/ToastContext';
import { trackEvent } from '../services/tracking';
import { useTelegramBackButton } from '../hooks/useTelegram';
import giftIcon from '../assets/invite-gift-icon.png';

/**
 * Page D — "Out of Energy?" standalone page.
 * Figma node 520:8217. Offers the user a way to earn energy by sharing
 * their referral code with friends. Accessible via deep link (startapp=earn).
 */
export default function ShareInvite() {
  const { t } = useTranslation('earn');
  const navigate = useNavigate();
  const { inviteCode, inviteLink, ensureEarn } = useInvite();
  const { showToast } = useToast();

  useTelegramBackButton(() => navigate(-1));

  useEffect(() => {
    void ensureEarn();
  }, [ensureEarn]);

  const code = inviteCode ?? '—';

  const copyToClipboard = (text: string) => {
    try {
      void navigator.clipboard.writeText(text);
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      } catch { /* ignore */ }
    }
  };

  const shareText = [
    t('earn:shareText1'),
    '',
    t('earn:shareText2'),
    '',
    t('earn:shareText3'),
    '',
    t('earn:shareTextCode', { code }),
    '',
    `${t('earn:shareTextStart')}\n${inviteLink ?? ''}`,
  ].join('\n');

  const copyCode = () => {
    copyToClipboard(code);
    trackEvent('miniapp_invite_copy', { source: 'modal' });
    showToast(t('common:codeCopied'));
  };

  const inviteFriends = () => {
    trackEvent('miniapp_invite_click', { source: 'result_page' });
    trackEvent('miniapp_invite_copy', { source: 'modal' });
    const tg = (window as unknown as { Telegram?: { WebApp?: { openTelegramLink?: (u: string) => void } } }).Telegram?.WebApp;
    if (tg?.openTelegramLink && inviteLink) {
      const tgShare = `https://t.me/share/url?url=${encodeURIComponent(inviteLink)}&text=${encodeURIComponent(shareText)}`;
      tg.openTelegramLink(tgShare);
      return;
    }
    // Fallback: copy the full share text
    copyToClipboard(shareText);
    showToast(t('common:linkCopied'));
  };

  return (
    <div className="min-h-screen bg-Cr-Bg-soft-v2 flex items-end justify-center">
      <div className="w-full max-w-[500px] bg-Cr-Bg-surface-default-v2 rounded-t-2xl-v2 px-4 pt-6 pb-[calc(env(safe-area-inset-bottom,12px)+16px)] flex flex-col gap-5">
        {/* Header block */}
        <div className="flex flex-col items-center gap-3 pt-2 text-center">
          <img className="w-16 h-16 object-contain" src={giftIcon} alt="" />
          <h2 className="text-xl font-medium leading-7 text-Cr-text-default-v2 m-0">{t('earn:outOfEnergy')}</h2>
          <p className="text-sm font-normal leading-5 text-Cr-text-subtler-v2 mt-[-6px] mb-0 [&_.accent]:text-Cr-marketing-candlelight-500-v2 [&_.accent]:font-medium">
            <Trans i18nKey="earn:inviteFriendDesc" components={{ accent: <span className="accent" /> }} />
          </p>
        </div>

        {/* Code row */}
        <div className="flex flex-col gap-1.5">
          <div className="text-sm font-medium leading-5 text-Cr-text-subtler-v2">{t('earn:invitationCode')}</div>
          <div className="flex items-center bg-Cr-Bg-surface-subtle-v2 rounded-md-v2 pl-3 pr-1.5 h-10 gap-2">
            <span className="flex-1 text-base font-normal leading-6 text-Cr-text-default-v2 tracking-[0.5px]">{code}</span>
            <button
              type="button"
              className="inline-flex items-center gap-1.5 h-7 px-3 bg-[rgba(120,120,128,0.36)] active:bg-[rgba(120,120,128,0.5)] rounded-md-v2 text-Cr-text-default-v2 text-sm font-medium leading-5"
              onClick={copyCode}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <rect x="5" y="5" width="9" height="9" rx="1.5" stroke="#F5F5F6" strokeWidth="1.3" />
                <path d="M11 5V3.5C11 2.67 10.33 2 9.5 2H3.5C2.67 2 2 2.67 2 3.5V9.5C2 10.33 2.67 11 3.5 11H5" stroke="#F5F5F6" strokeWidth="1.3" />
              </svg>
              <span>{t('common:copy')}</span>
            </button>
          </div>
        </div>

        {/* Actions */}
        <div className="flex flex-col gap-2">
          <button
            type="button"
            className="w-full h-12 rounded-md-v2 text-base font-semibold leading-6 flex items-center justify-center gap-2 bg-Cr-Bg-brand-alt-v2 active:bg-dreamy-brand-button-active-v2 text-CCr-button-brand-fg_default-v2"
            onClick={inviteFriends}
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <circle cx="6" cy="10" r="2" stroke="#F7F5FD" strokeWidth="1.5" />
              <circle cx="14" cy="5" r="2" stroke="#F7F5FD" strokeWidth="1.5" />
              <circle cx="14" cy="15" r="2" stroke="#F7F5FD" strokeWidth="1.5" />
              <path d="M7.8 9 L12.2 6 M7.8 11 L12.2 14" stroke="#F7F5FD" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            <span>{t('earn:inviteFriends')}</span>
          </button>
          <button
            type="button"
            className="w-full h-12 rounded-md-v2 text-base font-semibold leading-6 flex items-center justify-center gap-2 bg-Cr-Bg-surface-subtle-v2 active:bg-dreamy-neutral-button-active-v2 text-Cr-text-default-v2"
            onClick={() => navigate('/')}
          >
            {t('common:maybeLater')}
          </button>
        </div>
      </div>
    </div>
  );
}
