import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { NavigationBar } from "../components/NavigationBar";
import { Sidebar } from "../components/Sidebar";
import Skeleton from "../components/Skeleton";
import InviteBanner from "../components/InviteBanner";
import { useEnergy } from "../contexts/EnergyContext";
import { getTg } from "../hooks/useTelegram";
import { fetchExplore } from "../services/api";
import { trackEvent } from "../services/tracking";
import { useCardImpression } from "../hooks/useCardImpression";
import { isHiddenBotLink } from "../constants/hiddenBots";
import type { FloorImage } from "../types";
import searchEmptyImg from "../assets/search-empty.png";

// Tab icon imports
import iconCelebritySex from "../assets/tabs/celebrity-sex.png";
import iconCelebritySexActive from "../assets/tabs/celebrity-sex-active.png";
import iconSexyOutfits from "../assets/tabs/sexy-outfits.png";
import iconSexyOutfitsActive from "../assets/tabs/sexy-outfits-active.png";
import iconClassicActs from "../assets/tabs/classic-acts.png";
import iconClassicActsActive from "../assets/tabs/classic-acts-active.png";
import iconWildEncounters from "../assets/tabs/wild-encounters.png";
import iconWildEncountersActive from "../assets/tabs/wild-encounters-active.png";
import iconLgbtSex from "../assets/tabs/lgbt-sex.png";
import iconLgbtSexActive from "../assets/tabs/lgbt-sex-active.png";

const CATEGORIES = [
  {
    id: "celeb-sex",
    label: "Celebrity\nSex",
    floorUrl: "celeb-sex",
    icon: iconCelebritySex,
    iconActive: iconCelebritySexActive,
  },
  {
    id: "sexy-outfits",
    label: "Sexy\nOutfits",
    floorUrl: "sexy-outfits",
    icon: iconSexyOutfits,
    iconActive: iconSexyOutfitsActive,
  },
  {
    id: "classic-acts",
    label: "Classic\nActs",
    floorUrl: "classic-acts",
    icon: iconClassicActs,
    iconActive: iconClassicActsActive,
  },
  {
    id: "wild-encounters",
    label: "Wild\nEncounters",
    floorUrl: "wild-encounters",
    icon: iconWildEncounters,
    iconActive: iconWildEncountersActive,
  },
  {
    id: "lgbt-sex",
    label: "LGBT\nSex",
    floorUrl: "lgbt-sex",
    icon: iconLgbtSex,
    iconActive: iconLgbtSexActive,
  },
] as const;

const categoryLabelKeys: Record<string, string> = {
  "celeb-sex": "explore:celebritySex",
  "sexy-outfits": "explore:sexyOutfits",
  "classic-acts": "explore:classicActs",
  "wild-encounters": "explore:wildEncounters",
  "lgbt-sex": "explore:lgbtSex",
};

interface BotCardProps {
  img: FloorImage;
  slug: string;
  position: number;
  listContext: string;
  onClick: () => void;
}

function BotCard({ img, slug, position, listContext, onClick }: BotCardProps) {
  const ref = useCardImpression({ slugId: slug, position, listContext });
  return (
    <div
      ref={ref}
      className="rounded-xl overflow-hidden relative bg-Cr-Bg-surface-default-v2 cursor-pointer transition-transform duration-150 ease-out active:scale-[0.97]"
      onClick={onClick}
    >
      <img
        className="w-full aspect-[3/4] object-cover block"
        src={img.imagePosterUrl || img.imageUrl}
        alt={img.title}
        loading="lazy"
      />
      <div className="absolute bottom-0 left-0 right-0 pt-6 px-2.5 pb-2.5 bg-gradient-to-b from-transparent to-black/70">
        <span className="text-xs font-semibold leading-4 text-Cr-text-static-white-v2 mb-0.5">
          {img.title}
        </span>
      </div>
    </div>
  );
}

export default function Explore() {
  const { t, i18n } = useTranslation("explore");
  const navigate = useNavigate();
  const { energy, init } = useEnergy();
  const [images, setImages] = useState<FloorImage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedCategory, setSelectedCategory] =
    useState<string>("classic-acts");
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Search state
  const [searchQuery, setSearchQuery] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const [allBots, setAllBots] = useState<FloorImage[]>([]);
  const [allBotsLoaded, setAllBotsLoaded] = useState(false);
  const allBotsLoadingRef = useRef(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Map hardcoded category IDs to backend floorUrl via init.floors
  const getFloorUrl = useCallback(
    (categoryId: string) => {
      const cat = CATEGORIES.find((c) => c.id === categoryId);
      if (!cat) return "";
      if (init?.floors) {
        const match = init.floors.find(
          (f) =>
            f.title.toLowerCase().replace(/\s+/g, "-") === cat.floorUrl ||
            f.title.toLowerCase().includes(cat.floorUrl.replace(/-/g, " ")),
        );
        if (match) return match.floorUrl;
      }
      return cat.floorUrl;
    },
    [init],
  );

  const loadCategory = useCallback(
    async (categoryId: string) => {
      if (!init) return;
      setLoading(true);
      setError(null);
      try {
        const floorUrl = getFloorUrl(categoryId);
        const res = await fetchExplore(floorUrl, 1, 100);
        const allImages = res.floors
          .flatMap((f) => f.images || [])
          .filter((img) => !isHiddenBotLink(img.gotoLink));
        setImages(allImages);
      } catch (err) {
        setError(String(err));
      } finally {
        setLoading(false);
      }
    },
    [init, getFloorUrl],
  );

  useEffect(() => {
    loadCategory(selectedCategory);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCategory, loadCategory, i18n.language]);

  useEffect(() => {
    setAllBots([]);
    setAllBotsLoaded(false);
  }, [i18n.language]);

  const loadAllBots = useCallback(async () => {
    if (!init || allBotsLoaded || allBotsLoadingRef.current) return;
    allBotsLoadingRef.current = true;
    try {
      const results = await Promise.all(
        CATEGORIES.map((cat) => fetchExplore(getFloorUrl(cat.id), 1, 100)),
      );
      const all = results
        .flatMap((r) => r.floors.flatMap((f) => f.images || []))
        .filter((img) => !isHiddenBotLink(img.gotoLink));
      const seen = new Set<string>();
      const unique = all.filter((img) => {
        if (seen.has(img.gotoLink)) return false;
        seen.add(img.gotoLink);
        return true;
      });
      setAllBots(unique);
      setAllBotsLoaded(true);
    } catch {
      /* search degrades gracefully */
    }
    allBotsLoadingRef.current = false;
  }, [allBotsLoaded, getFloorUrl]);

  const searchResults = searchQuery.trim()
    ? allBots.filter((img) =>
        img.title.toLowerCase().includes(searchQuery.trim().toLowerCase()),
      )
    : [];

  const showSearchOverlay = searchFocused || searchQuery.length > 0;

  const handleTabClick = (categoryId: string) => {
    if (categoryId !== selectedCategory) {
      setSelectedCategory(categoryId);
      trackEvent('miniapp_category_tab', { tab: categoryId });
    }
  };

  // ── miniapp_category_view ──
  // Fire once images finish loading for the selected category. slug_count_seen
  // reflects the card count actually rendered (post hidden-bot filter).
  useEffect(() => {
    if (loading || error) return;
    trackEvent('miniapp_category_view', {
      category: selectedCategory,
      slug_count_seen: images.length,
    });
  }, [selectedCategory, loading, error, images.length]);

  const getSlugFromLink = (gotoLink: string) => {
    if (!gotoLink) return "";
    const lastSlash = gotoLink.lastIndexOf("/");
    return lastSlash >= 0 ? gotoLink.substring(lastSlash + 1) : gotoLink;
  };

  const showGetEnergyButton = init
    ? init.energy.freeGenerationsLeft === 0 && init.energy.balance === 0
    : false;

  return (
    <div className="h-full overflow-y-auto pt-12 pb-[88px] [-webkit-overflow-scrolling:touch] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <NavigationBar
        onMenuClick={() => setSidebarOpen((prev) => !prev)}
        onEnergyClick={() => navigate("/energy")}
        energy={energy}
        showGetEnergyButton={showGetEnergyButton}
        sidebarOpen={sidebarOpen}
      />

      <Sidebar isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      {/* Search Bar */}
      <div className="pt-2 px-4 pb-0.5">
        <div className="flex items-center gap-2 h-9 py-1 px-3 bg-Cr-Bg-surface-subtle-v2 rounded-md-v2">
          <svg
            className="flex-shrink-0"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#89878e"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <circle cx="11" cy="11" r="7" />
            <line x1="16.5" y1="16.5" x2="21" y2="21" />
          </svg>
          <input
            ref={searchInputRef}
            className="flex-1 bg-transparent border-none outline-none text-Cr-text-default-v2 text-sm font-normal p-0 min-w-0 placeholder:text-Cr-text-subtlest-v2"
            type="text"
            placeholder={t("explore:searchPlaceholder")}
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              if (e.target.value && !allBotsLoaded) loadAllBots();
            }}
            onFocus={() => {
              setSearchFocused(true);
              if (!allBotsLoaded) loadAllBots();
            }}
            onBlur={() => setSearchFocused(false)}
          />
          {searchQuery && (
            <>
              <button
                className="bg-transparent border-none text-Cr-text-subtlest-v2 text-sm font-normal cursor-pointer p-0 flex-shrink-0"
                onMouseDown={(e) => {
                  e.preventDefault();
                  setSearchQuery("");
                  searchInputRef.current?.focus();
                }}
              >
                {t("explore:clear")}
              </button>
              <button
                className="bg-transparent border-none cursor-pointer p-0 flex items-center flex-shrink-0"
                onMouseDown={(e) => {
                  e.preventDefault();
                  setSearchQuery("");
                  setSearchFocused(false);
                  searchInputRef.current?.blur();
                }}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#f5f5f6"
                  strokeWidth="2"
                  strokeLinecap="round"
                >
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </>
          )}
        </div>
      </div>

      {/* Search Results Overlay */}
      {showSearchOverlay && (
        <div className="fixed top-[calc(48px+46px)] left-0 right-0 bottom-0 z-[90] bg-Cr-Bg-soft-v2/95 overflow-y-auto [-webkit-overflow-scrolling:touch]">
          {searchQuery.trim() === "" ? (
            <div className="py-6 px-4 text-sm text-Cr-text-subtlest-v2 text-center">
              {t("explore:searchHint")}
            </div>
          ) : searchResults.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 p-10">
              <img
                src={searchEmptyImg}
                alt=""
                className="w-[76px] h-[76px] object-contain"
              />
              <div className="text-sm leading-5 text-Cr-text-subtler-v2 text-center max-w-[378px]">
                {t("common:noResults")}
              </div>
            </div>
          ) : (
            <>
              <div className="py-2 px-4 text-sm font-normal text-Cr-text-subtlest-v2">
                {t("explore:resultCount", { count: searchResults.length })}
              </div>
              <div className="flex flex-col">
                {searchResults.map((img, idx) => {
                  const slug = getSlugFromLink(img.gotoLink);
                  return (
                    <button
                      key={`${slug}-${idx}`}
                      className="flex items-center gap-3 py-2 px-4 bg-transparent border-none cursor-pointer text-left w-full active:bg-white/5"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        setSearchQuery("");
                        setSearchFocused(false);
                        trackEvent('miniapp_bot_click', { slug_id: slug, category: selectedCategory });
                        navigate(`/bot?slug_id=${slug}`, {
                          state: { image: img },
                        });
                      }}
                    >
                      <img
                        src={img.imagePosterUrl || img.imageUrl}
                        alt=""
                        className="w-12 h-12 rounded-lg object-cover flex-shrink-0 bg-Cr-Bg-surface-subtle-v2"
                      />
                      <span className="text-base font-normal text-Cr-text-default-v2 overflow-hidden text-ellipsis whitespace-nowrap">
                        {img.title}
                      </span>
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 pt-3 px-4 pb-3">
        {error ? (
          <div className="col-[1/-1] p-8 text-Cr-text-critical-default-v2 text-sm text-center">
            <div className="mb-2 font-bold">{t("common:apiError")}</div>
            <div className="break-all opacity-80">{error}</div>
          </div>
        ) : loading ? (
          Array.from({ length: 8 }).map((_, index) => (
            <div
              key={`skeleton-${index}`}
              className="rounded-xl overflow-hidden relative bg-Cr-Bg-surface-default-v2 cursor-pointer transition-transform duration-150 ease-out active:scale-[0.97]"
            >
              <div className="aspect-[3/4]">
                <Skeleton height="100%" />
              </div>
            </div>
          ))
        ) : images.length === 0 ? (
          <div className="col-[1/-1] p-8 text-center text-Cr-text-subtler-v2 text-sm">
            {t("explore:noContent")}
          </div>
        ) : (
          images.map((img, idx) => {
            const slug = getSlugFromLink(img.gotoLink);
            return (
              <BotCard
                key={`${slug}-${idx}`}
                img={img}
                slug={slug}
                position={idx}
                listContext="characters_main"
                onClick={() => {
                  if (slug) {
                    trackEvent('miniapp_bot_click', { slug_id: slug, category: selectedCategory });
                    navigate(`/bot?slug_id=${slug}`, { state: { image: img } });
                  }
                }}
              />
            );
          })
        )}
      </div>

      <InviteBanner />

      {/* Bottom Tab Bar */}
      <div className="fixed bottom-0 left-0 right-0 h-[88px] bg-Cr-Bg-soft-v2 z-[100] flex items-start justify-center pt-1.5">
        <div className="flex items-center justify-around w-full max-w-[375px] px-4">
          {CATEGORIES.map((cat) => {
            const isActive = selectedCategory === cat.id;
            return (
              <button
                key={cat.id}
                className="flex flex-col items-center gap-1 bg-transparent border-none cursor-pointer py-1 w-[65px] [-webkit-tap-highlight-color:transparent]"
                onClick={() => handleTabClick(cat.id)}
              >
                <img
                  className="w-14 h-7 object-contain"
                  src={isActive ? cat.iconActive : cat.icon}
                  alt=""
                />
                <span
                  className={`text-[10px] font-medium leading-3 text-center whitespace-nowrap ${isActive ? "text-Cr-text-default-v2" : "text-Cr-text-subtlest-v2"}`}
                >
                  {t(categoryLabelKeys[cat.id])
                    .split("\n")
                    .map((line: string, i: number) => (
                      <span key={i}>
                        {line}
                        {i === 0 && <br />}
                      </span>
                    ))}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
