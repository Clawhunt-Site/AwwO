import { useState, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import i18n from "../i18n";
import { useTelegramBackButton } from "../hooks/useTelegram";
import { fetchEnergyHistory } from "../services/api";
import zapHigh from "../assets/zap-high.svg";

type Tab = "all" | "usage" | "purchases";

interface HistoryRecord {
  detail: string;
  date: string;
  energyChange: number;
  type: string;
  imageUrl: string;
  balanceAfter: number;
  price: string;
}

interface DateGroup {
  label: string;
  items: HistoryRecord[];
}

const MONTHS = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
];

function parseDate(dateStr: string): Date {
  return new Date(dateStr.replace(" ", "T").replace(/Z?$/, "Z"));
}

function getDateGroupLabel(d: Date): string {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(todayStart.getTime() - 86400000);
  const dateStart = new Date(d.getFullYear(), d.getMonth(), d.getDate());

  if (dateStart.getTime() === todayStart.getTime()) {
    return `${i18n.t("common:today")} ・ ${MONTHS[d.getMonth()]} ${d.getDate()}`;
  }
  if (dateStart.getTime() === yesterdayStart.getTime()) {
    return `${i18n.t("common:yesterday")} ・ ${MONTHS[d.getMonth()]} ${d.getDate()}`;
  }
  if (d.getFullYear() !== now.getFullYear()) {
    return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
  }
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

function getItemTime(d: Date): string {
  return d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function getDateKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function groupByDate(records: HistoryRecord[]): DateGroup[] {
  const groups: Map<string, { label: string; items: HistoryRecord[] }> =
    new Map();
  for (const r of records) {
    const d = parseDate(r.date);
    const key = getDateKey(d);
    if (!groups.has(key)) {
      groups.set(key, { label: getDateGroupLabel(d), items: [] });
    }
    groups.get(key)!.items.push(r);
  }
  return Array.from(groups.values());
}

function PurchaseIcon() {
  return (
    <div className="w-12 h-12 rounded-lg bg-Cr-marketing-candlelight-500-v2/15 flex items-center justify-center">
      <img src={zapHigh} alt="" className="w-7 h-7" />
    </div>
  );
}

function CheckinIcon() {
  return (
    <div className="w-12 h-12 rounded-lg bg-Cr-marketing-candlelight-500-v2/15 flex items-center justify-center">
      <img src={zapHigh} alt="" className="w-7 h-7" />
    </div>
  );
}

export default function EnergyHistory() {
  const { t } = useTranslation(["energy", "common"]);
  const navigate = useNavigate();
  const handleBack = useCallback(() => navigate(-1), [navigate]);
  useTelegramBackButton(handleBack);
  const [activeTab, setActiveTab] = useState<Tab>("all");

  const TABS: { key: Tab; label: string }[] = [
    { key: "all", label: t("energy:all") },
    { key: "usage", label: t("energy:usage") },
    { key: "purchases", label: t("energy:purchases") },
  ];
  const [groups, setGroups] = useState<DateGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const loadData = useCallback((filter: Tab, pg: number, append: boolean) => {
    if (pg === 1) setLoading(true);
    else setLoadingMore(true);
    fetchEnergyHistory(filter, pg, 20)
      .then((res) => {
        const newGroups = groupByDate(res.records || []);
        if (append) {
          setGroups((prev) => {
            const merged = [...prev];
            for (const ng of newGroups) {
              const existing = merged.find((g) => g.label === ng.label);
              if (existing) existing.items.push(...ng.items);
              else merged.push(ng);
            }
            return merged;
          });
        } else {
          setGroups(newGroups);
        }
        setHasMore((res.records || []).length >= 20);
        setLoading(false);
        setLoadingMore(false);
      })
      .catch(() => {
        setLoading(false);
        setLoadingMore(false);
      });
  }, []);

  useEffect(() => {
    setPage(1);
    loadData(activeTab, 1, false);
  }, [activeTab, loadData]);

  const handleLoadMore = () => {
    const next = page + 1;
    setPage(next);
    loadData(activeTab, next, true);
  };

  function renderItem(item: HistoryRecord, idx: number, total: number) {
    const d = parseDate(item.date);
    const isPurchase = item.type === "purchase";
    const isReferral = item.type === "invite_reward";
    const isCheckin = item.type === "daily_checkin" || item.detail?.toLowerCase().includes("check-in") || item.detail?.toLowerCase().includes("checkin");

    let title: string;
    let subtitle: string;
    if (isPurchase) {
      title = i18n.t("energy:purchased");
      subtitle = i18n.t("energy:energyAmount", {
        amount: item.energyChange > 0 ? item.energyChange.toLocaleString() : "",
      });
    } else if (isReferral) {
      title = i18n.t("settings:earnedViaReferral");
      subtitle = "";
    } else {
      title = i18n.t("energy:generatedWith");
      subtitle = item.detail || i18n.t("energy:unknown");
    }

    return (
      <div
        key={idx}
        className={`flex items-center gap-3 py-3 px-3 ${idx < total - 1 ? "border-b border-white/5" : ""}`}
      >
        <div className="flex-shrink-0">
          {isPurchase || isReferral ? (
            <PurchaseIcon />
          ) : isCheckin ? (
            <CheckinIcon />
          ) : item.imageUrl ? (
            <img
              src={item.imageUrl}
              alt=""
              className="w-12 h-12 rounded-lg object-cover block"
            />
          ) : (
            <div className="w-12 h-12 rounded-lg bg-white/5" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-Cr-text-default-v2">
            {title}{" "}
            <span className="text-sm text-Cr-text-subtle-v2 whitespace-nowrap overflow-hidden text-ellipsis">
              {subtitle}
            </span>
          </div>
          <div className="text-xs text-Cr-text-subtler-v2 mt-0.5">
            {getItemTime(d)}
          </div>
        </div>
        <div className="text-right flex-shrink-0">
          <div
            className={`text-sm font-semibold ${item.energyChange > 0 ? "text-Cr-marketing-candlelight-500-v2" : "text-Cr-text-default-v2"}`}
          >
            {item.energyChange > 0
              ? `+${item.energyChange.toLocaleString()}`
              : item.energyChange.toLocaleString()}
          </div>
          {isPurchase && item.price && (
            <div className="text-xs text-Cr-text-subtler-v2 mt-px flex items-center justify-end gap-0.5">
              {item.price}
            </div>
          )}
          <div className="text-xs text-Cr-text-subtler-v2 mt-px">
            {i18n.t("common:balance", {
              amount: item.balanceAfter.toLocaleString(),
            })}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto pb-24 [-webkit-overflow-scrolling:touch]">
      <h1 className="text-xl font-semibold pt-3 px-4">
        {t("energy:energyHistory")}
      </h1>

      {/* Tab bar */}
      <div className="flex bg-CCr-tabbar-bg_default-v2 rounded-md-v2 mt-2 mx-4 mb-4 p-0.5">
        {TABS.map((tab) => {
          const active = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              className={`flex-1 py-2 text-sm font-medium border-none rounded-md-v2 cursor-pointer text-center transition-[background,color] duration-150 ${
                active
                  ? "bg-CCr-tabbar-bg_select-v2 text-CCr-tabbar-fg_bolder-v2"
                  : "bg-transparent text-CCr-tabbar-fg_default-v2"
              }`}
              onClick={() => setActiveTab(tab.key)}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {loading ? (
        <div className="p-8 text-center text-Cr-text-subtler-v2">
          {t("common:loading")}
        </div>
      ) : groups.length === 0 ? (
        <div className="p-8 text-center text-Cr-text-subtler-v2">
          {t("energy:noHistoryYet")}
        </div>
      ) : (
        <>
          {groups.map((group) => (
            <div key={group.label} className="mb-2">
              <div className="text-xs font-semibold text-Cr-text-subtler-v2 uppercase tracking-[0.5px] pt-3 px-4 pb-2">
                {group.label}
              </div>
              <div className="bg-Cr-Bg-surface-default-v2 rounded-md-v2 mx-4 overflow-hidden">
                {group.items.map((item, idx) =>
                  renderItem(item, idx, group.items.length),
                )}
              </div>
            </div>
          ))}
          {hasMore && (
            <div className="p-4 text-center">
              <button
                onClick={handleLoadMore}
                disabled={loadingMore}
                className={`py-2.5 px-6 rounded-md-v2 bg-Cr-Bg-surface-default-v2 text-Cr-text-static-white-v2 text-sm border-none cursor-pointer ${loadingMore ? "opacity-60" : ""}`}
              >
                {loadingMore ? t("common:loading") : t("energy:loadMore")}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
