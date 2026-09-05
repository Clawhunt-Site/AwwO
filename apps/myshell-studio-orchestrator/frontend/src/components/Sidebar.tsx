import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import Modal from './Modal';
import { useHaptic } from '../hooks/useTelegram';
import { useEnergy } from '../contexts/EnergyContext';
import { useCheckin } from '../contexts/CheckinContext';
import { setUserLanguage } from '../services/api';
import { trackEvent } from '../services/tracking';

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
}

const menuItems = [
  {
    path: '/',
    labelKey: 'nav:explore',
    icon: (active: boolean) => (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
        <path d="M12 2C10.0222 2 8.08879 2.58649 6.4443 3.6853C4.79981 4.78412 3.51809 6.3459 2.76121 8.17317C2.00433 10.0004 1.8063 12.0111 2.19215 13.9509C2.578 15.8907 3.53041 17.6725 4.92894 19.0711C6.32746 20.4696 8.10929 21.422 10.0491 21.8079C11.9889 22.1937 13.9996 21.9957 15.8268 21.2388C17.6541 20.4819 19.2159 19.2002 20.3147 17.5557C21.4135 15.9112 22 13.9778 22 12C22 9.34784 20.9464 6.8043 19.0711 4.92893C17.1957 3.05357 14.6522 2 12 2Z" stroke={active ? '#f01b5c' : '#ffffff'} strokeWidth="1.8"/>
        <path d="M16.24 7.76L14.12 14.12L7.76 16.24L9.88 9.88L16.24 7.76Z" stroke={active ? '#f01b5c' : '#ffffff'} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    )
  },
  {
    path: '/ai-picks',
    labelKey: 'nav:aiPicks',
    icon: (active: boolean) => (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
        <path d="M12 2L14.09 8.26L20.84 8.63L15.54 12.97L17.29 19.37L12 15.77L6.71 19.37L8.46 12.97L3.16 8.63L9.91 8.26L12 2Z"
          stroke={active ? '#fddf1a' : '#ffffff'}
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill={active ? '#fddf1a' : 'none'}
        />
      </svg>
    )
  },
  {
    path: '/dreamy?workspace=canvaspro',
    labelKey: 'nav:canvas',
    icon: (active: boolean) => (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
        <rect x="3" y="3" width="18" height="18" rx="2" stroke={active ? '#f01b5c' : '#ffffff'} strokeWidth="1.8" />
        <path d="M7 8H17" stroke={active ? '#f01b5c' : '#ffffff'} strokeWidth="1.8" strokeLinecap="round" />
        <path d="M7 12H15" stroke={active ? '#f01b5c' : '#ffffff'} strokeWidth="1.8" strokeLinecap="round" />
        <path d="M7 16H12" stroke={active ? '#f01b5c' : '#ffffff'} strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    )
  },
  {
    path: '/earn',
    labelKey: 'nav:earn',
    icon: (active: boolean) => (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
        <path
          d="M20 12V22H4V12 M2 7H22V12H2V7Z M12 22V7 M12 7H7.5C6.83696 7 6.20107 6.73661 5.73223 6.26777C5.26339 5.79893 5 5.16304 5 4.5C5 3.83696 5.26339 3.20107 5.73223 2.73223C6.20107 2.26339 6.83696 2 7.5 2C11 2 12 7 12 7Z M12 7H16.5C17.163 7 17.7989 6.73661 18.2678 6.26777C18.7366 5.79893 19 5.16304 19 4.5C19 3.83696 18.7366 3.20107 18.2678 2.73223C17.7989 2.26339 17.163 2 16.5 2C13 2 12 7 12 7Z"
          stroke={active ? '#f01b5c' : '#ffffff'}
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    )
  },
  {
    path: '/library',
    labelKey: 'nav:library',
    icon: (active: boolean) => (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
        <rect x="2" y="4" width="20" height="16" rx="2" stroke={active ? '#f01b5c' : '#ffffff'} strokeWidth="1.8"/>
        <path d="M2 9H22" stroke={active ? '#f01b5c' : '#ffffff'} strokeWidth="1.8"/>
        <path d="M9 4V9" stroke={active ? '#f01b5c' : '#ffffff'} strokeWidth="1.8"/>
      </svg>
    )
  },
  {
    path: '/settings',
    labelKey: 'nav:profile',
    icon: (active: boolean) => (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
        <path d="M20 21V19C20 17.9391 19.5786 16.9217 18.8284 16.1716C18.0783 15.4214 17.0609 15 16 15H8C6.93913 15 5.92172 15.4214 5.17157 16.1716C4.42143 16.9217 4 17.9391 4 19V21" stroke={active ? '#f01b5c' : '#ffffff'} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
        <circle cx="12" cy="7" r="4" stroke={active ? '#f01b5c' : '#ffffff'} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    )
  },
  {
    path: '/upload?slug_id=ai-porn-generator&mode=tag-generator',
    labelKey: 'nav:create',
    icon: (active: boolean) => (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
        <rect x="3" y="7" width="18" height="13" rx="2" stroke={active ? '#f01b5c' : '#ffffff'} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
        <path d="M3 11H21M8 7L7 11M13 7L12 11M18 7L17 11" stroke={active ? '#f01b5c' : '#ffffff'} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    )
  }
];

const FALLBACK_LANGUAGES: Record<string, string> = {
  en: 'English',
  zh: '中文',
  es: 'Español',
  ja: '日本語',
  ko: '한국어',
  ru: 'Русский',
  ar: 'العربية',
  de: 'Deutsch',
  fr: 'Français',
  it: 'Italiano',
  nl: 'Nederlands',
  pt: 'Português',
};

export function Sidebar({ isOpen, onClose }: SidebarProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const haptic = useHaptic();
  const { init } = useEnergy();
  const { status: checkinStatus, openModal: openCheckinModal } = useCheckin();
  const [langOpen, setLangOpen] = useState(false);
  const [pendingLang, setPendingLang] = useState<string | null>(null);

  const showCheckinDot = checkinStatus ? !checkinStatus.todayClaimed : false;
  const isMenuItemActive = (path: string) => {
    if (path === '/') return location.pathname === '/';
    if (path === '/dreamy?workspace=canvaspro') {
      return location.pathname === '/dreamy' && new URLSearchParams(location.search).get('workspace') === 'canvaspro';
    }
    return location.pathname.startsWith(path);
  };

  const handleItemClick = (path: string) => {
    const isActive = isMenuItemActive(path);

    if (!isActive) {
      haptic('selection');
      if (path === '/earn') {
        trackEvent('miniapp_invite_click', { source: 'drawer' });
      }
      navigate(path);
    }
    onClose();
  };

  const handleCheckinClick = () => {
    haptic('selection');
    openCheckinModal('sidebar');
    onClose();
  };

  return (
    <>
      {/* Overlay */}
      <div
        className={`fixed top-12 left-0 right-0 bottom-0 bg-black/50 backdrop-blur-[24px] z-[200] transition-[opacity,visibility] duration-300 ease-in-out ${isOpen ? 'opacity-100 visible' : 'opacity-0 invisible'}`}
        onClick={onClose}
      />

      {/* Sidebar */}
      <div className={`fixed top-12 left-0 w-[246px] h-[calc(100vh-48px)] bg-Cr-Bg-soft-v2 z-[300] transition-transform duration-300 ease-in-out flex flex-col ${isOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="p-4 flex flex-col gap-1">
          {menuItems.map((item, idx) => {
            const isActive = isMenuItemActive(item.path);

            return (
              <div key={item.path}>
                <button
                  className={`flex items-center gap-4 py-[10px] px-4 rounded-xl-v2 text-base font-normal leading-6 text-left w-full transition-[background-color,color] duration-200 ${
                    isActive
                      ? 'bg-[rgba(240,27,92,0.15)] text-Cr-text-brand-default-v2 hover:bg-[rgba(240,27,92,0.2)]'
                      : 'bg-transparent text-Cr-text-static-white-v2 hover:bg-white/8'
                  }`}
                  style={{ fontFamily: "'SF Pro', system-ui, sans-serif" }}
                  onClick={() => handleItemClick(item.path)}
                >
                  <span className="flex items-center justify-center w-6 h-6 shrink-0">
                    {item.icon(isActive)}
                  </span>
                  <span className="flex-1">{t(item.labelKey)}</span>
                </button>

                {/* Check-in entry — after Earn (index 3) */}
                {idx === 3 && (
                  <button
                    className="flex items-center gap-4 py-[10px] px-4 rounded-xl-v2 text-base font-normal leading-6 text-left w-full transition-[background-color,color] duration-200 bg-transparent text-Cr-text-static-white-v2 hover:bg-white/8"
                    style={{ fontFamily: "'SF Pro', system-ui, sans-serif" }}
                    onClick={handleCheckinClick}
                  >
                    <span className="relative flex items-center justify-center w-6 h-6 shrink-0">
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                        <rect x="3" y="4" width="18" height="18" rx="2" stroke="#ffffff" strokeWidth="1.8" />
                        <path d="M16 2V6" stroke="#ffffff" strokeWidth="1.8" strokeLinecap="round" />
                        <path d="M8 2V6" stroke="#ffffff" strokeWidth="1.8" strokeLinecap="round" />
                        <path d="M3 10H21" stroke="#ffffff" strokeWidth="1.8" />
                        <path d="M9 16L11 18L15 14" stroke="#ffffff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      {showCheckinDot && (
                        <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-dreamy-brand-hot-v2" />
                      )}
                    </span>
                    <span className="flex-1">Check-in</span>
                  </button>
                )}
              </div>
            );
          })}
        </div>

        <div className="mt-auto p-4 border-t border-white/8">
          <button className="bg-transparent text-Cr-text-subtler-v2 text-sm py-2 w-full text-left flex items-center gap-2" onClick={() => setLangOpen(true)}>
            <svg className="shrink-0" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <path d="M2 12h20" />
              <path d="M12 2a15.3 15.3 0 0 1 0 20a15.3 15.3 0 0 1 0-20z" />
            </svg>
            {(init?.supported_languages ?? FALLBACK_LANGUAGES)[i18n.language] ?? 'English'}
          </button>
        </div>
      </div>

      {langOpen && (
        <Modal open={langOpen} onClose={() => pendingLang || setLangOpen(false)}>
          <div className="max-h-[60vh] overflow-y-auto overflow-x-hidden flex flex-col gap-0.5 -mx-2" style={{ WebkitOverflowScrolling: 'touch' }}>
            <div className="text-base font-semibold text-Cr-text-default-v2 mb-2 px-2 text-center">{t('settings:language')}</div>
            {Object.entries(init?.supported_languages ?? FALLBACK_LANGUAGES).map(([code, label]) => {
              const isActive = i18n.language === code;
              const isPending = pendingLang === code;
              return (
                <button
                  key={code}
                  className={`flex items-center justify-between w-full px-3 py-3 text-base leading-5 text-Cr-text-default-v2 rounded-lg-v2 transition-[background-color,color] duration-150 ease-in-out active:bg-white/[0.06] ${
                    isActive ? 'font-semibold bg-white/[0.06]' : 'font-normal bg-transparent'
                  } ${isPending ? '' : ''} disabled:cursor-default ${pendingLang !== null && !isPending ? 'opacity-40' : ''}`}
                  style={{ fontFamily: "-apple-system, 'SF Pro Text', system-ui, sans-serif" }}
                  disabled={pendingLang !== null}
                  onClick={async () => {
                    if (pendingLang) return;
                    if (isActive) { setLangOpen(false); return; }
                    setPendingLang(code);
                    try {
                      await setUserLanguage(code);
                    } catch {
                      // degraded mode — still switch locally
                    }
                    i18n.changeLanguage(code);
                    localStorage.setItem('dreamy_lang', code);
                    setPendingLang(null);
                    setLangOpen(false);
                  }}
                >
                  <span className="overflow-hidden text-ellipsis whitespace-nowrap">{label}</span>
                  <span className="w-[18px] h-[18px] shrink-0 inline-flex items-center justify-center">
                    {isPending ? (
                      <svg className="animate-[langSpin_0.8s_linear_infinite] origin-center" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#F5F5F6" strokeWidth="2.5" strokeLinecap="round">
                        <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                      </svg>
                    ) : isActive ? (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#F5F5F6" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                    ) : null}
                  </span>
                </button>
              );
            })}
          </div>
        </Modal>
      )}
    </>
  );
}
