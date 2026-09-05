import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useTelegramBackButton, useHaptic, getTg } from "../hooks/useTelegram";
import { useEnergy } from "../contexts/EnergyContext";
import { fetchEnergyPacks, createInvoice } from "../services/api";
import { trackEvent } from "../services/tracking";
import energyBoltImg from "../assets/energy-bolt.png";
import energyBgSvg from "../assets/energy-bg.svg";
import energyStarSvg from "../assets/energy-star.svg";
import { X } from "lucide-react";

// Module-level ref so it survives React StrictMode's double-mount in dev.
const purchasedFlag = { current: false };

interface EnergyPack {
  stars: number;
  energy: number;
}

export default function GetEnergy() {
  const { t } = useTranslation("energy");
  const navigate = useNavigate();
  const haptic = useHaptic();
  const { refresh, energy } = useEnergy();
  const [searchParams] = useSearchParams();
  const isOos = searchParams.get("oos") === "1";
  const manualTrigger = searchParams.get("trigger");

  const goBack = useCallback(() => {
    if (isOos) navigate("/", { replace: true });
    else navigate(-1);
  }, [navigate, isOos]);
  useTelegramBackButton(goBack);
  const [packs, setPacks] = useState<EnergyPack[]>([]);
  const [selectedStars, setSelectedStars] = useState<number | null>(null);
  const [buying, setBuying] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    purchasedFlag.current = false;
    const trigger = manualTrigger
      ? manualTrigger
      : isOos
        ? 'generate_blocked'
        : 'manual';
    trackEvent('miniapp_energy_modal_shown', {
      context: isOos ? 'generate' : 'library',
      trigger,
      energy_balance: energy ?? 0,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const mountTsRef = useRef(Date.now());
  useEffect(() => {
    mountTsRef.current = Date.now();
    return () => {
      if (Date.now() - mountTsRef.current < 100) return;
      if (!purchasedFlag.current) {
        navigate("/share-invite", { replace: true });
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    fetchEnergyPacks()
      .then((p) => {
        setPacks(p);
        if (p.length > 0) setSelectedStars(p[p.length - 1].stars);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const handleBuy = async () => {
    if (buying || selectedStars === null) return;
    haptic("medium");
    trackEvent('miniapp_energy_click_buy', { package_id: String(selectedStars) });
    setBuying(true);
    try {
      const invoiceLink = await createInvoice(String(selectedStars));
      trackEvent('miniapp_invoice_created', { package_id: String(selectedStars), stars: selectedStars });
      const tg = getTg();
      if (tg) {
        tg.openInvoice(invoiceLink, (status) => {
          if (status === "paid") {
            haptic("heavy");
            purchasedFlag.current = true;
            refresh();
          }
          setBuying(false);
        });
      } else {
        setBuying(false);
      }
    } catch {
      setBuying(false);
    }
  };

  const selected = packs.find((p) => p.stars === selectedStars);
  const bestIdx = packs.length - 1;

  const perUnit = (pack: EnergyPack) => {
    if (pack.energy === 0) return "";
    const cost = pack.stars * 0.013;
    return t("energy:pricePerUnit", { price: (cost / pack.energy).toFixed(3) });
  };

  const savePercent = (pack: EnergyPack, idx: number) => {
    if (
      idx === 0 ||
      packs.length < 2 ||
      pack.energy === 0 ||
      packs[0].energy === 0
    )
      return "";
    const baseRate = packs[0].stars / packs[0].energy;
    const thisRate = pack.stars / pack.energy;
    const saved = Math.round((1 - thisRate / baseRate) * 100);
    return saved > 0 ? t("energy:savePercent", { percent: saved }) : "";
  };

  return (
    <div className="fixed inset-0 z-[300] flex flex-col animate-[fadeIn_0.3s_ease]">
      <div className="absolute inset-0 bg-black/50" onClick={goBack} />
      <div className="relative mt-auto bg-Cr-Bg-soft-v2 rounded-t-[20px] px-4 pb-[calc(env(safe-area-inset-bottom,16px)+16px)] animate-[slideUp_0.3s_ease] max-h-[90vh] overflow-y-auto overflow-x-hidden">
        {/* Gold gradient glow background */}
        <div className="absolute top-0 left-0 right-0 h-[260px] rounded-t-[20px] pointer-events-none overflow-hidden bg-gradient-to-b from-[#2A2000] via-dreamy-energy-card-bg-normal-v2 to-transparent">
          {/* Sparkle particles (native size 225x205, centered) */}
          <img
            src={energyBgSvg}
            alt=""
            className="absolute top-0 left-1/2 -translate-x-1/2 w-[225px] h-[205px] pointer-events-none"
          />
        </div>

        <button
          className="absolute top-4 right-4 w-9 h-9 rounded-full bg-white/10 flex items-center justify-center text-Cr-text-default-v2 z-[2]"
          onClick={goBack}
        >
          <X size={22} strokeWidth={2} />
        </button>

        <div className="relative z-[1] flex flex-col items-center pt-8 mb-6">
          <img
            src={energyBoltImg}
            alt=""
            className="w-[86px] h-[86px] mb-3 object-contain"
            style={{
              filter:
                "drop-shadow(0 0 24px rgba(253, 224, 26, 0.5)) drop-shadow(0 0 48px rgba(253, 224, 26, 0.2))",
            }}
          />
          <div className="text-2xl font-bold text-Cr-text-default-v2 mb-1.5">
            {t("energy:getEnergy")}
          </div>
          <div className="text-base text-Cr-text-subtler-v2">
            {t("energy:getMoreDesc")}
          </div>
        </div>

        {loading ? (
          <div className="p-8 text-center text-Cr-text-subtler-v2">
            {t("energy:loadingPacks")}
          </div>
        ) : packs.length === 0 ? (
          <div className="p-8 text-center text-Cr-text-subtler-v2">
            {t("energy:noPacks")}
          </div>
        ) : (
          <div className="relative z-[1] flex flex-col gap-2.5 mb-3">
            {packs.map((pack, idx) => {
              const sel = selectedStars === pack.stars;
              return (
                <div
                  key={pack.stars}
                  className={`flex items-center justify-between px-3 py-2 rounded-md-v2 cursor-pointer transition-all duration-200 ease-out relative border ${
                    sel
                      ? "border-Cr-marketing-candlelight-500-v2 bg-Cr-marketing-candlelight-500-v2/10"
                      : "border-Cr-beta-white-5-v2 bg-Cr-beta-white-3-v2"
                  }`}
                  onClick={() => {
                    haptic("selection");
                    setSelectedStars(pack.stars);
                  }}
                >
                  {idx === bestIdx && packs.length > 1 && (
                    <div className="absolute -top-2.5 right-3 bg-Cr-marketing-candlelight-500-v2 text-Cr-text-static-black-v2 text-xs font-bold py-[3px] px-2.5 rounded-md-v2">
                      {t("energy:bestValue")}
                    </div>
                  )}
                  <div className="flex flex-col gap-0.5 items-start justify-center">
                    <div className="text-base font-medium leading-6 text-Cr-text-default-v2">
                      {pack.energy.toLocaleString()}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium leading-4 text-Cr-text-subtler-v2">
                        {perUnit(pack)}
                      </span>
                      {savePercent(pack, idx) && (
                        <span className="text-xs font-semibold text-dreamy-discount-green-v2 bg-dreamy-discount-green-v2/10 py-0.5 px-2 rounded">
                          {savePercent(pack, idx)}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <img
                      src={energyStarSvg}
                      alt=""
                      className="w-5 h-5 shrink-0"
                    />
                    <span className="text-xl font-medium leading-7 text-Cr-text-default-v2">
                      {pack.stars.toLocaleString()}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <button
          className="relative z-[1] w-full p-4 rounded-[14px] bg-Cr-marketing-candlelight-500-v2 text-Cr-text-static-black-v2 text-base font-semibold text-center active:opacity-90 disabled:opacity-60"
          onClick={handleBuy}
          disabled={buying || !selected}
        >
          {buying
            ? t("energy:processing")
            : selected
              ? t("energy:buyEnergy", {
                  amount: selected.energy.toLocaleString(),
                })
              : t("energy:selectAPack")}
        </button>
      </div>
    </div>
  );
}
