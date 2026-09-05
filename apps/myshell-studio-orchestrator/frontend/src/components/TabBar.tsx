import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useHaptic } from "../hooks/useTelegram";

const tabs = [
  { path: "/", labelKey: "nav:characters", id: "characters" },
  { path: "/tag-generator", labelKey: "nav:create", id: "create" },
  { path: "/dreamy?workspace=canvaspro", labelKey: "nav:canvas", id: "canvas" },
  { path: "/library", labelKey: "nav:library", id: "library" },
  { path: "/settings", labelKey: "nav:settings", id: "settings" },
] as const;

const ICON_PATHS = {
  create: {
    line: "M12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2ZM4 12C4 7.58172 7.58172 4 12 4C16.4183 4 20 7.58172 20 12C20 16.4183 16.4183 20 12 20C7.58172 20 4 16.4183 4 12ZM13 7H11V11H7V13H11V17H13V13H17V11H13V7Z",
    solid: "M12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2ZM13 7H11V11H7V13H11V17H13V13H17V11H13V7Z",
  },
  characters: {
    line: "M20.2426 4.75736C22.5053 7.02472 22.583 10.637 20.4786 12.993L11.9999 21.485L3.52135 12.993C1.41702 10.637 1.49568 7.01901 3.75733 4.75736C6.02154 2.49315 9.64516 2.41687 12.001 4.52853C14.35 2.42 17.98 2.49 20.2426 4.75736ZM5.17154 6.17157C3.6818 7.66131 3.60701 10.0473 4.9799 11.6232L11.9999 18.6543L19.0201 11.6232C20.3935 10.0467 20.319 7.66525 18.827 6.1701C17.3397 4.67979 14.9458 4.60806 13.3743 5.98376L9.17154 10.1869L7.75733 8.77264L10.582 5.946L10.5002 5.87701C8.92542 4.61197 6.62319 4.71993 5.17154 6.17157Z",
    solid:
      "M20.2426 4.75736C22.5053 7.02472 22.583 10.637 20.4786 12.993L11.9999 21.485L3.52135 12.993C1.41702 10.637 1.49568 7.01901 3.75733 4.75736C5.51542 2.99926 8.09312 2.56029 10.2605 3.44044L6.34312 7.35843L7.75733 8.77264L12 4.53L11.9872 4.51617C11.9918 4.52028 11.9964 4.5244 12.001 4.52853C14.35 2.42 17.98 2.49 20.2426 4.75736Z",
  },
  library: {
    line: "M3.087 9H20.9134C21.4657 9 21.9134 9.44772 21.9134 10C21.9134 10.0277 21.9122 10.0554 21.9099 10.083L21.0766 20.083C21.0334 20.6013 20.6001 21 20.08 21H3.92033C3.40024 21 2.96698 20.6013 2.92379 20.083L2.09045 10.083C2.04459 9.53267 2.45358 9.04932 3.00395 9.00345C3.03158 9.00115 3.05928 9 3.087 9ZM4.84047 19H19.1599L19.8266 11H4.1738L4.84047 19ZM13.4144 5H20.0002C20.5525 5 21.0002 5.44772 21.0002 6V7H3.0002V4C3.0002 3.44772 3.44792 3 4.0002 3H11.4144L13.4144 5Z",
    solid:
      "M13.4144 5H20.0002C20.5525 5 21.0002 5.44772 21.0002 6V7H3.0002V4C3.0002 3.44772 3.44792 3 4.0002 3H11.4144L13.4144 5ZM3.087 9H20.9134C21.4657 9 21.9134 9.44772 21.9134 10C21.9134 10.0277 21.9122 10.0554 21.9099 10.083L21.0766 20.083C21.0334 20.6013 20.6001 21 20.08 21H3.92033C3.40024 21 2.96698 20.6013 2.92379 20.083L2.09045 10.083C2.04459 9.53267 2.45358 9.04932 3.00395 9.00345C3.03158 9.00115 3.05928 9 3.087 9Z",
  },
  canvas: {
    line: "M4 3H20C20.5523 3 21 3.44772 21 4V20C21 20.5523 20.5523 21 20 21H4C3.44772 21 3 20.5523 3 20V4C3 3.44772 3.44772 3 4 3ZM5 5V19H19V5H5ZM8 8H16V10H8V8ZM8 12H14V14H8V12ZM8 16H12V18H8V16Z",
    solid: "M4 3H20C20.5523 3 21 3.44772 21 4V20C21 20.5523 20.5523 21 20 21H4C3.44772 21 3 20.5523 3 20V4C3 3.44772 3.44772 3 4 3ZM8 8V10H16V8H8ZM8 12V14H14V12H8ZM8 16V18H12V16H8Z",
  },
  settings: {
    line: "M12 1L21.5 6.5V17.5L12 23L2.50003 17.5V6.5L12 1ZM12 3.311L4.50003 7.65311V16.3469L12 20.689L19.5 16.3469V7.65311L12 3.311ZM12 16C9.79089 16 8.00003 14.2091 8.00003 12C8.00003 9.79086 9.79089 8 12 8C14.2091 8 16 9.79086 16 12C16 14.2091 14.2091 16 12 16ZM12 14C13.1046 14 14 13.1046 14 12C14 10.8954 13.1046 10 12 10C10.8954 10 10 10.8954 10 12C10 13.1046 10.8954 14 12 14Z",
    solid:
      "M12 1L21.5 6.5V17.5L12 23L2.50003 17.5V6.5L12 1ZM12 15C13.6569 15 15 13.6569 15 12C15 10.3431 13.6569 9 12 9C10.3431 9 9.00003 10.3431 9.00003 12C9.00003 13.6569 10.3431 15 12 15Z",
  },
} as const;

function TabIcon({
  active,
  id,
}: {
  active: boolean;
  id: keyof typeof ICON_PATHS;
}) {
  const paths = ICON_PATHS[id];
  const d = active ? paths.solid : paths.line;
  const color = active ? "#FF195E" : "#96949C";

  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path d={d} fill={color} />
    </svg>
  );
}

export default function TabBar() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const haptic = useHaptic();
  const workspace = new URLSearchParams(location.search).get("workspace");

  return (
    <div className="fixed bottom-0 left-0 right-0 flex justify-center px-4 pt-2 pb-[calc(env(safe-area-inset-bottom,8px)+8px)] z-100 bg-transparent pointer-events-none">
      <div className="flex items-center gap-1.5 p-1.5 w-full bg-black/20 backdrop-blur-[40px] rounded-full pointer-events-auto">
        {tabs.map((tab) => {
          const active =
            tab.id === "canvas"
              ? location.pathname === "/dreamy" && workspace === "canvaspro"
              : tab.path === "/"
              ? location.pathname === "/"
              : location.pathname.startsWith(tab.path);
          return (
            <button
              key={tab.id}
              className={`min-w-0 flex-1 flex flex-col items-center gap-0.5 py-2 rounded-full transition-all duration-[0.25s] ease-[ease] relative ${active ? "bg-Cr-border-opaque-v2" : ""}`}
              onClick={() => {
                if (!active) {
                  haptic("selection");
                  navigate(tab.path);
                }
              }}
            >
              <span className="w-6 h-6 flex items-center justify-center">
                <TabIcon active={active} id={tab.id} />
              </span>
              <span
                className={`max-w-full truncate text-[9px] sm:text-[10px] font-medium leading-none transition-colors duration-[0.25s] ease-[ease] ${active ? "text-dreamy-brand-hot-v2" : "text-Cr-text-subtler-v2"}`}
              >
                {t(tab.labelKey)}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
