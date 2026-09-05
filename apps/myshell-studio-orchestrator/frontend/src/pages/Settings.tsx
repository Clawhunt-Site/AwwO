import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import i18n from "../i18n";
import { NavigationBar } from "../components/NavigationBar";
import { Sidebar } from "../components/Sidebar";
import { useEnergy } from "../contexts/EnergyContext";
import { useInvite } from "../contexts/InviteContext";
import { fetchEnergyHistory } from "../services/api";
import { trackEvent } from "../services/tracking";
import energySparkles from "../assets/energy-sparkles.png";
import energyBolt from "../assets/energy-bolt.png";
import zapHigh from "../assets/zap-high.svg";
import zapLow from "../assets/zap-low.svg";

function getTgUser() {
  return window.Telegram?.WebApp?.initDataUnsafe?.user as
    | {
        id?: number;
        first_name?: string;
        last_name?: string;
        username?: string;
        photo_url?: string;
      }
    | undefined;
}

interface RecentItem {
  id: number;
  desc: string;
  time: string;
  cost: number;
  balance: number;
  thumb: string;
  type: string;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function formatActivityTime(dateStr: string): string {
  if (!dateStr) return "";
  const d = new Date(dateStr.replace(" ", "T").replace(/Z?$/, "Z"));
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffH = diffMs / 3600000;
  const hhmm = d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  if (diffH < 24) return i18n.t("settings:todayTime", { time: hhmm });
  if (diffH < 48) return i18n.t("settings:yesterdayTime", { time: hhmm });
  if (diffH < 144)
    return i18n.t("settings:daysAgoTime", {
      count: Math.floor(diffH / 24),
      time: hhmm,
    });
  if (d.getFullYear() !== now.getFullYear())
    return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} · ${hhmm}`;
  return `${MONTHS[d.getMonth()]} ${d.getDate()} · ${hhmm}`;
}

export default function Settings() {
  const { t } = useTranslation("settings");
  const navigate = useNavigate();
  const { energy } = useEnergy();
  const { hasApplied, appliedCode, openInviteModal } = useInvite();
  const [copied, setCopied] = useState(false);
  const [recentActivity, setRecentActivity] = useState<RecentItem[]>([]);
  const [activityLoading, setActivityLoading] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    fetchEnergyHistory("all", 1, 3)
      .then((res) => {
        setRecentActivity(
          (res.records || []).map((r, i) => ({
            id: i,
            desc: r.detail || t("settings:energyActivity"),
            time: formatActivityTime(r.date || ""),
            cost: r.energyChange,
            balance: r.balanceAfter,
            thumb: r.imageUrl || "",
            type: r.type || "usage",
          })),
        );
        setActivityLoading(false);
      })
      .catch(() => setActivityLoading(false));
  }, []);

  const user = getTgUser();
  const displayName = user
    ? [user.first_name, user.last_name].filter(Boolean).join(" ") ||
      t("settings:user")
    : t("settings:guestUser");
  const userId = user?.id ?? "\u2014";
  const initial = displayName.charAt(0).toUpperCase();
  const isLowEnergy = energy !== null && energy <= 10;

  const videosLeft = energy !== null ? Math.floor(energy / 15) : 0;
  const energySubtext = isLowEnergy
    ? energy === 0
      ? t("settings:noEnergyLeft")
      : t("settings:lowEnergy")
    : t("settings:videosLeft", { count: videosLeft });

  const handleCopyId = () => {
    navigator.clipboard.writeText(String(userId)).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const handleViewAllHistory = () => {
    navigate("/energy-history");
  };

  return (
    <div className="h-full overflow-y-auto pt-[60px] px-4 pb-[100px] [-webkit-overflow-scrolling:touch]">
      <NavigationBar
        onMenuClick={() => setSidebarOpen((prev) => !prev)}
        onEnergyClick={() => navigate("/energy")}
        energy={energy}
        sidebarOpen={sidebarOpen}
      />
      <Sidebar isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      {/* Profile */}
      <div className="flex items-center gap-3 mb-4">
        {user?.photo_url ? (
          <img
            src={user.photo_url}
            className="w-12 h-12 rounded-full shrink-0 object-cover"
            alt=""
          />
        ) : (
          <div className="w-12 h-12 rounded-full bg-linear-to-r from-dreamy-gradient-05-stop-1-v2 via-dreamy-gradient-05-stop-2-v2 to-dreamy-gradient-05-stop-3-v2 flex items-center justify-center text-[22px] font-bold shrink-0">
            {initial}
          </div>
        )}
        <div className="flex-1">
          <div className="text-lg font-bold text-Cr-text-static-white-v2 mb-[2px]">
            {displayName}
          </div>
          <div className="text-sm text-Cr-text-subtler-v2 flex items-center gap-[6px]">
            {t("settings:userId", { id: userId })}
            <button
              className="bg-transparent border-none p-[2px] cursor-pointer text-Cr-text-subtler-v2 leading-none inline-flex items-center justify-center align-middle"
              onClick={handleCopyId}
              aria-label="Copy user ID"
            >
              {copied ? (
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Energy Balance Card */}
      <div
        className={`rounded-lg-v2 p-5 relative overflow-hidden mb-4 border ${isLowEnergy ? "bg-[linear-gradient(135deg,#1A0F00_0%,#0E0E0F_60%)] border-[rgba(255,119,42,0.2)]" : "bg-[linear-gradient(135deg,#1A1500_0%,#0E0E0F_60%)] border-[rgba(253,224,26,0.15)]"}`}
      >
        <div
          className={`absolute -top-10 -left-10 w-[180px] h-[180px] rounded-full pointer-events-none ${isLowEnergy ? "bg-[radial-gradient(circle,rgba(255,119,42,0.08)_0%,transparent_70%)]" : "bg-[radial-gradient(circle,rgba(253,224,26,0.08)_0%,transparent_70%)]"}`}
        />
        <div className="relative z-[1]">
          <div className="mb-1">
            <span
              className={`text-sm font-medium ${isLowEnergy ? "text-[#CC7744]" : "text-[#C4A82A]"}`}
            >
              {t("settings:energyBalance")}
            </span>
          </div>
          <div className="flex items-center gap-2 mb-1">
            <img
              src={isLowEnergy ? zapLow : zapHigh}
              alt=""
              className="w-7 h-7 shrink-0"
            />
            <span
              className={`text-4xl font-bold leading-none ${isLowEnergy ? "text-Cr-marketing-crusta-500-v2" : "text-Cr-marketing-candlelight-500-v2"}`}
            >
              {energy !== null ? energy : "..."}
            </span>
          </div>
          <div
            className={`text-sm mb-4 ${isLowEnergy ? "text-[#CC7744]" : "text-[#C4A82A]"}`}
          >
            {energySubtext}
          </div>
        </div>
        <div
          className={`absolute -top-[10px] -right-5 w-[188px] h-[135px] pointer-events-none z-0`}
        >
          <img
            src={energySparkles}
            className={`absolute inset-0 w-full h-full object-contain ${isLowEnergy ? "[filter:hue-rotate(330deg)_saturate(1.5)]" : ""}`}
            alt=""
          />
          <img
            src={energyBolt}
            className={`absolute w-[86px] h-[86px] top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 object-contain ${isLowEnergy ? "[filter:hue-rotate(330deg)_saturate(1.5)]" : ""}`}
            alt=""
          />
        </div>

        {/* Stats row */}
        <div className="flex items-center relative z-[1] py-3 border-t border-white/[0.06]">
          <div className="flex-1 text-center">
            <div className="text-xs text-Cr-text-subtler-v2 mb-1">
              {t("settings:usedToday")}
            </div>
            <div className="text-xl font-bold text-Cr-text-static-white-v2">
              0
            </div>
          </div>
          <div className="w-px h-9 bg-white/10 shrink-0" />
          <div className="flex-1 text-center">
            <div className="text-xs text-Cr-text-subtler-v2 mb-1">
              {t("settings:creationsMade")}
            </div>
            <div className="text-xl font-bold text-Cr-text-static-white-v2">
              0
            </div>
          </div>
        </div>

        {/* Get More Energy button */}
        <button
          className={`relative z-[1] w-full py-[14px] rounded-xl-v2 text-base font-semibold text-center active:opacity-90 ${isLowEnergy ? "bg-Cr-marketing-crusta-500-v2 text-Cr-text-static-white-v2" : "bg-Cr-marketing-candlelight-500-v2 text-Cr-text-static-black-v2"}`}
          onClick={() => navigate("/energy")}
        >
          {isLowEnergy ? t("common:getEnergy") : t("settings:getMoreEnergy")}
        </button>
      </div>

      {/* Recent Activity */}
      <div className="mb-4">
        <div className="text-sm font-medium text-Cr-text-default-v2 mb-3">
          {t("settings:recentActivity")}
        </div>
        <div className="bg-Cr-Bg-surface-default-v2 rounded-md-v2 overflow-hidden">
          {activityLoading ? (
            <div className="p-4 text-center text-Cr-text-subtlest-v2 text-sm">
              {t("common:loading")}
            </div>
          ) : recentActivity.length === 0 ? (
            <div className="p-4 text-center text-Cr-text-subtlest-v2 text-sm">
              {t("settings:noActivityYet")}
            </div>
          ) : (
            recentActivity.map((item) => {
              const isPurchase = item.type === "purchase";
              const isReferral = item.type === "invite_reward";
              const isCheckin = item.type === "daily_checkin" || item.desc?.toLowerCase().includes("check-in") || item.desc?.toLowerCase().includes("checkin");
              const showBoltIcon = isPurchase || isReferral;
              const desc = isReferral
                ? t("settings:earnedViaReferral")
                : item.desc;
              const costStr =
                item.cost > 0 ? `+${item.cost}` : String(item.cost);

              return (
                <div
                  key={item.id}
                  className="flex items-center gap-3 px-4 py-[14px] border-b border-white/8"
                >
                  <div className="shrink-0">
                    {showBoltIcon ? (
                      <div className="w-11 h-11 rounded-lg-v2 bg-[rgba(244,179,53,0.15)] flex items-center justify-center">
                        <img src={zapHigh} alt="" className="w-7 h-7" />
                      </div>
                    ) : isCheckin ? (
                      <div className="w-11 h-11 rounded-lg-v2 bg-[rgba(244,179,53,0.15)] flex items-center justify-center">
                        <img src={zapHigh} alt="" className="w-7 h-7" />
                      </div>
                    ) : item.thumb ? (
                      <img
                        src={item.thumb}
                        alt=""
                        className="w-11 h-11 rounded-lg-v2 object-cover"
                      />
                    ) : (
                      <div className="w-11 h-11 rounded-lg-v2 bg-white/[0.06]" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-Cr-text-static-white-v2 whitespace-nowrap overflow-hidden text-ellipsis">
                      {desc}
                    </div>
                    <div className="text-xs text-Cr-text-subtler-v2 mt-[2px]">
                      {item.time}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-sm font-semibold text-Cr-text-static-white-v2">
                      {costStr}
                    </div>
                    <div className="text-xs text-Cr-text-subtler-v2 mt-[2px]">
                      {t("common:balance", { amount: item.balance })}
                    </div>
                  </div>
                </div>
              );
            })
          )}
          <button
            className="w-full py-[14px] text-center text-sm font-medium text-Cr-text-subtle-v2 bg-transparent border-0 border-t border-solid border-white/8 cursor-pointer flex items-center justify-center gap-[6px] active:opacity-70"
            onClick={handleViewAllHistory}
          >
            {t("settings:viewAllHistory")}
          </button>
        </div>
      </div>

      {/* Invitation code — Figma pages 03 (bound) and 10 (not bound) */}
      <div className="mb-4">
        <div className="text-base font-semibold leading-6 text-Cr-text-default-v2 mb-2">
          {t("settings:invitationCode")}
        </div>
        <div className="bg-Cr-Bg-surface-default-v2 rounded-lg-v2 p-4">
          <div className="flex items-center justify-between gap-4 min-h-[46px]">
            <div className="flex flex-col gap-[2px] min-w-0">
              <div className="text-base font-medium leading-6 text-Cr-text-default-v2">
                {hasApplied
                  ? (appliedCode ?? t("settings:applied"))
                  : t("settings:notSet")}
              </div>
              <div className="text-sm font-normal leading-5 text-Cr-text-subtler-v2">
                {t("settings:referralCode")}
              </div>
            </div>
            {!hasApplied && (
              <button
                type="button"
                className="bg-transparent text-Cr-text-default-v2 text-sm font-medium leading-5 py-[2px] px-1 active:opacity-60"
                onClick={() => {
                  trackEvent('miniapp_invite_click', { source: 'profile' });
                  openInviteModal();
                }}
              >
                {t("common:add")}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
