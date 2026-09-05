import { useNavigate } from "react-router-dom";
import { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { NavigationBar } from "../components/NavigationBar";
import { Sidebar } from "../components/Sidebar";
import { useEnergy } from "../contexts/EnergyContext";
import { useInvite } from "../contexts/InviteContext";
import { useToast } from "../contexts/ToastContext";
import { trackEvent } from "../services/tracking";
import earnGift from "../assets/earn-gift.png";
import earnHow1 from "../assets/earn-how-1.png";
import earnHow2 from "../assets/earn-how-2.png";
import earnHow3 from "../assets/earn-how-3.png";
import earnHow4 from "../assets/earn-how-4.png";
import earnPeople from "../assets/earn-people.png";

/**
 * Page E — "Invite & Earn Energy" landing page.
 * Figma node 520:3249.
 */

// Decorative gift glow — 3 Figma ellipses (#FF39C0 magenta, #FF6987 pink, #FF8269 orange)
// kept as inline style; purely decorative and doesn't map to any token.
const GIFT_GLOW_STYLE: React.CSSProperties = {
  backgroundImage: [
    "radial-gradient(ellipse 127px 134px at 30% 50%, rgba(255, 57, 192, 0.15) 0%, transparent 70%)",
    "radial-gradient(ellipse 114px 71px at 80% 60%, rgba(255, 130, 105, 0.30) 0%, transparent 70%)",
    "radial-gradient(ellipse 200px 99px at 90% 20%, rgba(255, 105, 135, 0.10) 0%, transparent 70%)",
  ].join(","),
  filter: "blur(30px)",
};

export default function Earn() {
  const { t } = useTranslation("earn");
  const navigate = useNavigate();
  const { energy } = useEnergy();
  const {
    inviteCode,
    inviteLink,
    ensureEarn,
    friendsInvited,
    energyEarnedFromInvite,
  } = useInvite();
  const { showToast } = useToast();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    void ensureEarn(true);
    trackEvent('miniapp_earn_view', {});
  }, [ensureEarn]);

  const copyToClipboard = (text: string) => {
    try {
      void navigator.clipboard.writeText(text);
    } catch {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      } catch {
        /* give up silently */
      }
    }
  };

  const shareText = [
    t("earn:shareText1"),
    "",
    t("earn:shareText2"),
    "",
    t("earn:shareText3"),
    "",
    t("earn:shareTextCode", { code: inviteCode ?? "—" }),
    "",
    `${t("earn:shareTextStart")}\n${inviteLink ?? ""}`,
  ].join("\n");

  const copyCode = () => {
    if (inviteCode) {
      copyToClipboard(inviteCode);
      trackEvent('miniapp_invite_copy', { source: 'earn' });
      showToast(t("common:codeCopied"));
    }
  };

  const copyLink = () => {
    copyToClipboard(shareText);
    trackEvent('miniapp_invite_click', { source: 'onboarding' });
    trackEvent('miniapp_invite_copy', { source: 'earn' });
    showToast(t("common:linkCopied"));
  };

  const accentClass = "text-Cr-marketing-candlelight-500-v2 font-medium";
  const cardClass = "bg-Cr-Bg-surface-default-v2 rounded-lg";
  const cardTitleClass =
    "text-sm font-medium leading-5 text-Cr-text-subtler-v2";

  return (
    <div className="h-full overflow-y-auto pt-[60px] pb-8 [-webkit-overflow-scrolling:touch]">
      <NavigationBar
        onMenuClick={() => setSidebarOpen((prev) => !prev)}
        onEnergyClick={() => navigate("/energy")}
        energy={energy}
        sidebarOpen={sidebarOpen}
      />
      <Sidebar isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      <div className="flex flex-col gap-6 px-4">
        {/* Hero card */}
        <section className={`${cardClass} overflow-hidden`}>
          {/* Upper half */}
          <div className="relative pt-4 px-4 pb-3 min-h-[154px]">
            <div className="flex flex-col gap-2 relative z-[1]">
              <div className="inline-flex items-center w-fit py-1.5 px-2 rounded-md-v2 bg-Cr-marketing-candlelight-500-v2/15 text-Cr-marketing-candlelight-500-v2 text-xs font-medium leading-4">
                {t("earn:earnBadge")}
              </div>
              <h2 className="text-xl font-semibold leading-7 text-Cr-text-default-v2 m-0 mt-2 whitespace-nowrap">
                {t("earn:heroTitle")}
              </h2>
              <p className="text-sm font-normal leading-5 text-Cr-text-subtler-v2 m-0 max-w-[calc(100%-20px)]">
                <Trans
                  i18nKey="earn:heroDesc"
                  components={{ accent: <span className={accentClass} /> }}
                />
              </p>
            </div>
            {/* Gift glow (decorative) */}
            <div
              className="absolute right-[-40px] top-[-30px] w-[200px] h-[180px] pointer-events-none z-0"
              style={GIFT_GLOW_STYLE}
            />
            <img
              className="absolute right-[-4px] top-[-4px] w-[130px] h-auto object-contain pointer-events-none z-[1]"
              src={earnGift}
              alt=""
            />
          </div>

          {/* Lower half: code + CTA */}
          <div className="p-4 flex flex-col gap-3 border-t border-white/5">
            <div className="text-sm font-medium leading-5 text-Cr-text-subtler-v2">
              {t("earn:invitationCode")}
            </div>
            <div className="flex items-center bg-Cr-Bg-surface-subtle-v2 rounded-md-v2 pl-3 pr-1.5 h-10 gap-2">
              <span className="flex-1 text-base font-normal leading-6 text-Cr-text-default-v2 tracking-[0.5px]">
                {inviteCode ?? "—"}
              </span>
              <button
                type="button"
                className="inline-flex items-center gap-1.5 h-7 px-3 bg-CCr-button-tertiary-bg_default-v2/40 active:bg-CCr-button-tertiary-bg_default-v2/60 rounded-md-v2 text-Cr-text-default-v2 text-sm font-medium leading-5"
                onClick={copyCode}
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <rect
                    x="5"
                    y="5"
                    width="9"
                    height="9"
                    rx="1.5"
                    stroke="#F5F5F6"
                    strokeWidth="1.3"
                  />
                  <path
                    d="M11 5V3.5C11 2.67 10.33 2 9.5 2H3.5C2.67 2 2 2.67 2 3.5V9.5C2 10.33 2.67 11 3.5 11H5"
                    stroke="#F5F5F6"
                    strokeWidth="1.3"
                  />
                </svg>
                <span>{t("common:copy")}</span>
              </button>
            </div>
            <button
              type="button"
              className="flex items-center justify-center gap-2 w-full h-12 bg-Cr-Bg-brand-alt-v2 active:bg-dreamy-brand-button-active-v2 rounded-md-v2 text-CCr-button-brand-fg_default-v2 text-base font-semibold leading-6"
              onClick={copyLink}
            >
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                <path
                  d="M8.5 11.5 L11.5 8.5 M7.5 5.5 L9 4 C10.66 2.34 13.34 2.34 15 4 C16.66 5.66 16.66 8.34 15 10 L13.5 11.5 M12.5 14.5 L11 16 C9.34 17.66 6.66 17.66 5 16 C3.34 14.34 3.34 11.66 5 10 L6.5 8.5"
                  stroke="#F7F5FD"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span>{t("earn:copyInvitationLink")}</span>
            </button>
          </div>
        </section>

        {/* How It Works */}
        <section className={`${cardClass} py-3 px-4`}>
          <div className={`${cardTitleClass} mb-3`}>{t("earn:howItWorks")}</div>
          <ul className="list-none m-0 p-0 flex flex-col gap-3">
            {[
              { icon: earnHow1, key: "howStep1" },
              { icon: earnHow2, key: "howStep2" },
              { icon: earnHow3, key: "howStep3", withTrans: true },
              { icon: earnHow4, key: "howStep4" },
            ].map(({ icon, key, withTrans }) => (
              <li
                key={key}
                className="flex items-start gap-2 text-sm font-normal leading-5 text-Cr-text-default-v2"
              >
                <img
                  className="w-5 h-5 flex-shrink-0 object-contain"
                  src={icon}
                  alt=""
                />
                {withTrans ? (
                  <span>
                    <Trans
                      i18nKey={`earn:${key}`}
                      components={{ accent: <span className={accentClass} /> }}
                    />
                  </span>
                ) : (
                  <span>{t(`earn:${key}`)}</span>
                )}
              </li>
            ))}
          </ul>
        </section>

        {/* Purchase Bonus */}
        <section className={`${cardClass} p-4 flex gap-3 items-start`}>
          <div className="w-11 h-11 flex-shrink-0 flex items-center justify-center bg-Cr-Bg-surface-subtle-v2 rounded-[10px]">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
              <path
                d="M13 2L4.09 12.64a1 1 0 0 0 .78 1.64H11l-1 7.28a.5.5 0 0 0 .86.46L19.91 11.36a1 1 0 0 0-.78-1.64H13l1-7.28a.5.5 0 0 0-.86-.46Z"
                fill="#FDDF1A"
              />
            </svg>
          </div>
          <div className="flex flex-col gap-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="inline-flex items-center py-0.5 px-1.5 rounded bg-Cr-Bg-brand-alt-v2 text-Cr-text-static-white-v2 text-[10px] font-bold leading-[14px] tracking-[0.5px]">
                {t("earn:newBadge")}
              </span>
              <span className="text-sm font-medium leading-5 text-Cr-text-subtler-v2">
                {t("earn:purchaseBonus")}
              </span>
            </div>
            <div className="text-base font-semibold leading-[22px] text-Cr-text-default-v2">
              <Trans
                i18nKey="earn:purchaseBonusHeadline"
                components={{ accent: <span className={accentClass} /> }}
              />
            </div>
            <div className="text-sm font-normal leading-[18px] text-Cr-text-subtler-v2">
              {t("earn:purchaseBonusDesc")}
            </div>
          </div>
        </section>

        {/* Invitations stats */}
        <section className={`${cardClass} py-3 px-4`}>
          <div className={`${cardTitleClass} mb-3`}>
            {t("earn:invitations")}
          </div>
          <div className="flex items-center justify-between">
            <div className="flex gap-6">
              <div className="flex flex-col gap-1">
                <div className="text-2xl font-semibold leading-7 text-Cr-text-default-v2">
                  {energyEarnedFromInvite}
                </div>
                <div className="text-sm font-normal leading-[18px] text-Cr-text-subtler-v2">
                  {t("common:energy")}
                </div>
              </div>
              <div className="flex flex-col gap-1">
                <div className="text-2xl font-semibold leading-7 text-Cr-text-default-v2">
                  {friendsInvited}
                </div>
                <div className="text-sm font-normal leading-[18px] text-Cr-text-subtler-v2">
                  {t("earn:invitees")}
                </div>
              </div>
            </div>
            <img
              className="w-10 h-10 object-contain flex-shrink-0"
              src={earnPeople}
              alt=""
            />
          </div>
        </section>
      </div>
    </div>
  );
}
