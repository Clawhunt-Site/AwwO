import { useId } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { LogoIcon } from "./NavigationBar";

interface HomeNavBarProps {
  onEnergyClick: () => void;
  energy?: number | null;
}

export function HomeNavBar({ onEnergyClick, energy }: HomeNavBarProps) {
  const { t } = useTranslation();
  const gradId = useId();
  const hasEnergy = energy !== null && energy !== undefined && energy > 0;

  return (
    <nav className="flex items-center justify-between pt-3 px-4 sticky top-0 z-50 bg-Cr-Bg-soft-v2">
      <div className="flex items-center gap-1.5">
        <LogoIcon />
        {!hasEnergy && (
          <span className="text-xs font-semibold text-Cr-text-static-white-v2 border border-white/30 rounded-full py-0.5 px-2 tracking-[0.5px]">
            {t("common:free")}
          </span>
        )}
      </div>
      {hasEnergy ? (
        <button
          className="flex items-center justify-center bg-transparent border-none p-0 m-0 cursor-pointer appearance-none active:opacity-90"
          onClick={onEnergyClick}
        >
          <svg
            className="block"
            width="76"
            height="26"
            viewBox="0 0 76 26"
            fill="none"
          >
            <defs>
              <clipPath id={`${gradId}_clip0`}>
                <path
                  d="M16 2H70C73.3137 2 76 4.68629 76 8V18C76 21.3137 73.3137 24 70 24H16V2Z"
                  fill="white"
                />
              </clipPath>
              <clipPath id={`${gradId}_clip1`}>
                <rect
                  width="16"
                  height="16"
                  fill="white"
                  transform="translate(58 5)"
                />
              </clipPath>
              <clipPath id={`${gradId}_clip3`}>
                <rect
                  width="20"
                  height="20"
                  fill="white"
                  transform="translate(3 3)"
                />
              </clipPath>
              <filter
                id={`${gradId}_f`}
                x="3.70673"
                y="2.89154"
                width="16.9538"
                height="21.441"
                filterUnits="userSpaceOnUse"
                colorInterpolationFilters="sRGB"
              >
                <feFlood floodOpacity="0" result="BackgroundImageFix" />
                <feColorMatrix
                  in="SourceAlpha"
                  type="matrix"
                  values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
                  result="hardAlpha"
                />
                <feOffset dx="-0.453737" dy="1.43683" />
                <feGaussianBlur stdDeviation="0.945285" />
                <feComposite in2="hardAlpha" operator="out" />
                <feColorMatrix
                  type="matrix"
                  values="0 0 0 0 0.933304 0 0 0 0 0.664391 0 0 0 0 0.26102 0 0 0 0.37 0"
                />
                <feBlend
                  mode="normal"
                  in2="BackgroundImageFix"
                  result="effect1_dropShadow"
                />
                <feBlend
                  mode="normal"
                  in="SourceGraphic"
                  in2="effect1_dropShadow"
                  result="shape"
                />
                <feColorMatrix
                  in="SourceAlpha"
                  type="matrix"
                  values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
                  result="hardAlpha"
                />
                <feOffset dy="-1.43683" />
                <feGaussianBlur stdDeviation="1.02091" />
                <feComposite
                  in2="hardAlpha"
                  operator="arithmetic"
                  k2="-1"
                  k3="1"
                />
                <feColorMatrix
                  type="matrix"
                  values="0 0 0 0 0.674971 0 0 0 0 0.372803 0 0 0 0 0.202833 0 0 0 0.47 0"
                />
                <feBlend
                  mode="normal"
                  in2="shape"
                  result="effect2_innerShadow"
                />
                <feColorMatrix
                  in="SourceAlpha"
                  type="matrix"
                  values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
                  result="hardAlpha"
                />
                <feOffset dy="-0.529359" />
                <feGaussianBlur stdDeviation="0.189057" />
                <feComposite
                  in2="hardAlpha"
                  operator="arithmetic"
                  k2="-1"
                  k3="1"
                />
                <feColorMatrix
                  type="matrix"
                  values="0 0 0 0 1 0 0 0 0 0.957028 0 0 0 0 0.804673 0 0 0 0.6 0"
                />
                <feBlend
                  mode="normal"
                  in2="effect2_innerShadow"
                  result="effect3_innerShadow"
                />
              </filter>
              <linearGradient
                id={gradId}
                x1="10.0122"
                y1="6.18596"
                x2="14.8247"
                y2="19.1686"
                gradientUnits="userSpaceOnUse"
              >
                <stop offset="0.0001" stopColor="#FFED8C" />
                <stop offset="1" stopColor="#F4B335" />
              </linearGradient>
            </defs>
            {/* Trailing area (number bg + add button) */}
            <g clipPath={`url(#${gradId}_clip0)`}>
              <rect
                width="40"
                height="22"
                transform="translate(16 2)"
                fill="#141101"
              />
              {/* Add button */}
              <path
                d="M56 2H72C74.2091 2 76 3.79086 76 6V20C76 22.2091 74.2091 24 72 24H56V2Z"
                fill="#D9BA05"
              />
              <g clipPath={`url(#${gradId}_clip1)`}>
                <path
                  d="M61.3333 12.9999H70.6667M66 8.33325V17.6666"
                  stroke="#1D1C1F"
                  strokeWidth="1.25"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </g>
            </g>
            {/* Trailing stroke border */}
            <path
              d="M70 2.5C73.0376 2.5 75.5 4.96243 75.5 8V18C75.5 21.0376 73.0376 23.5 70 23.5H16.5V2.5H70Z"
              stroke="#5E4F05"
            />
            {/* Icon box opaque backing – occludes trailing area in overlap zone */}
            <path
              d="M9.59961 0.5H16.4004C18.0884 0.5 19.3245 0.50041 20.2998 0.580078C21.2694 0.659297 21.9376 0.814529 22.4971 1.09961C23.5318 1.62689 24.3731 2.46816 24.9004 3.50293C25.1855 4.06243 25.3407 4.7306 25.4199 5.7002C25.4996 6.67551 25.5 7.91156 25.5 9.59961V16.4004C25.5 18.0884 25.4996 19.3245 25.4199 20.2998C25.3407 21.2694 25.1855 21.9376 24.9004 22.4971C24.3731 23.5318 23.5318 24.3731 22.4971 24.9004C21.9376 25.1855 21.2694 25.3407 20.2998 25.4199C19.3245 25.4996 18.0884 25.5 16.4004 25.5H9.59961C7.91155 25.5 6.67551 25.4996 5.7002 25.4199C4.7306 25.3407 4.06243 25.1855 3.50293 24.9004C2.46816 24.3731 1.62689 23.5318 1.09961 22.4971C0.814529 21.9376 0.659297 21.2694 0.580078 20.2998C0.50041 19.3245 0.5 18.0884 0.5 16.4004V9.59961L0.500977 8.41504C0.504824 7.30967 0.520332 6.43162 0.580078 5.7002C0.659297 4.7306 0.814529 4.06243 1.09961 3.50293C1.62689 2.46816 2.46816 1.62689 3.50293 1.09961C4.06243 0.814529 4.7306 0.659297 5.7002 0.580078C6.67551 0.50041 7.91156 0.5 9.59961 0.5Z"
              fill="#0D0D0D"
            />
            {/* Icon box background */}
            <path
              d="M9.59961 0.5H16.4004C18.0884 0.5 19.3245 0.50041 20.2998 0.580078C21.2694 0.659297 21.9376 0.814529 22.4971 1.09961C23.5318 1.62689 24.3731 2.46816 24.9004 3.50293C25.1855 4.06243 25.3407 4.7306 25.4199 5.7002C25.4996 6.67551 25.5 7.91156 25.5 9.59961V16.4004C25.5 18.0884 25.4996 19.3245 25.4199 20.2998C25.3407 21.2694 25.1855 21.9376 24.9004 22.4971C24.3731 23.5318 23.5318 24.3731 22.4971 24.9004C21.9376 25.1855 21.2694 25.3407 20.2998 25.4199C19.3245 25.4996 18.0884 25.5 16.4004 25.5H9.59961C7.91155 25.5 6.67551 25.4996 5.7002 25.4199C4.7306 25.3407 4.06243 25.1855 3.50293 24.9004C2.46816 24.3731 1.62689 23.5318 1.09961 22.4971C0.814529 21.9376 0.659297 21.2694 0.580078 20.2998C0.50041 19.3245 0.5 18.0884 0.5 16.4004V9.59961L0.500977 8.41504C0.504824 7.30967 0.520332 6.43162 0.580078 5.7002C0.659297 4.7306 0.814529 4.06243 1.09961 3.50293C1.62689 2.46816 2.46816 1.62689 3.50293 1.09961C4.06243 0.814529 4.7306 0.659297 5.7002 0.580078C6.67551 0.50041 7.91156 0.5 9.59961 0.5Z"
              fill="rgba(253,223,26,0.08)"
              stroke="#5E4F05"
            />
            {/* Thunder bolt */}
            <g clipPath={`url(#${gradId}_clip3)`}>
              <g filter={`url(#${gradId}_f)`}>
                <path
                  d="M13.5317 5.19811C13.5141 4.32026 12.3676 3.99987 11.8975 4.74146L6.19015 13.7453C5.81622 14.3352 6.24004 15.1056 6.93848 15.1056H11.6426L11.7431 20.1354C11.7607 21.0132 12.9072 21.3336 13.3773 20.5921L19.0846 11.5882C19.4586 10.9983 19.0347 10.2279 18.3363 10.2279H13.6322L13.5317 5.19811Z"
                  fill={`url(#${gradId})`}
                />
              </g>
            </g>
            {/* Dynamic energy number */}
            <text
              x="41"
              y="13"
              textAnchor="middle"
              dy="0.35em"
              fill="#FFF2B6"
              fontSize="11"
              fontWeight="500"
              fontFamily="'SF Pro', system-ui, sans-serif"
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              {energy}
            </text>
          </svg>
        </button>
      ) : (
        <button
          className="flex items-center gap-1.5 bg-transparent border-[1.5px] border-dreamy-brand-hot-v2 rounded-md-v2 h-7 px-3 text-dreamy-brand-hot-v2 text-sm font-semibold active:opacity-90"
          onClick={onEnergyClick}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2l1.5 8.5L22 12l-8.5 1.5L12 22l-1.5-8.5L2 12l8.5-1.5L12 2z" />
          </svg>
          {t("common:getEnergy")}
        </button>
      )}
    </nav>
  );
}

export function BackNavBar({ title }: { title?: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <>
      <div className="flex items-center justify-between py-3 px-4">
        <button
          className="flex items-center gap-1 bg-Cr-border-hover-v2 rounded-full py-1.5 px-3 text-sm font-medium text-Cr-text-static-white-v2"
          onClick={() => navigate(-1)}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="15 18 9 12 15 6" />
          </svg>
          {t("common:back")}
        </button>
        <div className="flex items-center gap-2">
          <button className="w-9 h-9 rounded-full bg-Cr-border-hover-v2 flex items-center justify-center text-Cr-text-static-white-v2 text-lg">
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
          <button className="w-9 h-9 rounded-full bg-Cr-border-hover-v2 flex items-center justify-center text-Cr-text-static-white-v2 text-lg">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="12" cy="5" r="1.5" />
              <circle cx="12" cy="12" r="1.5" />
              <circle cx="12" cy="19" r="1.5" />
            </svg>
          </button>
        </div>
      </div>
      {title && (
        <h1 className="text-[28px] font-bold pt-1 px-4 pb-3">{title}</h1>
      )}
    </>
  );
}
