import { useId } from "react";
import { useTranslation } from "react-i18next";
import starIcon from "../assets/star.svg";

interface NavigationBarProps {
  onMenuClick: () => void;
  onEnergyClick: () => void;
  energy?: number | null;
  showGetEnergyButton?: boolean;
  sidebarOpen?: boolean;
}

function HamburgerIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
      <path
        d="M3 12H21M3 6H21M3 18H21"
        stroke="#f5f5f6"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
      <path
        d="M18 6L6 18M6 6l12 12"
        stroke="#f5f5f6"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function LogoIcon() {
  return (
    <svg
      width="151"
      height="24"
      viewBox="0 0 151 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M18.6 2C21.03 2 23 3.97603 23 6.41358V17.4475C23 19.885 21.03 21.8611 18.6 21.8611H5.4C2.96995 21.8611 1 19.885 1 17.4475V6.41358C1 3.97603 2.96995 2 5.4 2H18.6Z"
        fill="url(#paint0_linear_343_9463)"
      />
      <mask
        id="mask0_343_9463"
        maskUnits="userSpaceOnUse"
        x="1"
        y="2"
        width="22"
        height="20"
      >
        <path
          d="M18.6 2C21.03 2 23 3.97603 23 6.41358V17.4475C23 19.885 21.03 21.8611 18.6 21.8611H5.4C2.96995 21.8611 1 19.885 1 17.4475V6.41358C1 3.97603 2.96995 2 5.4 2H18.6Z"
          fill="url(#paint1_linear_343_9463)"
        />
      </mask>
      <g mask="url(#mask0_343_9463)">
        <g filter="url(#filter0_f_343_9463)">
          <ellipse
            cx="11.9633"
            cy="-1.34804"
            rx="22.851"
            ry="6.0936"
            fill="#EAB627"
          />
        </g>
      </g>
      <g filter="url(#filter1_d_343_9463)">
        <path
          d="M11.3533 6.8542C11.596 6.26689 12.4042 6.26688 12.6469 6.8542L12.9948 7.69687C13.5887 9.13512 14.6977 10.2844 16.0909 10.9058L17.0768 11.3453C17.6413 11.5975 17.6415 12.4222 17.0768 12.6741L16.0316 13.1396C14.6736 13.7455 13.585 14.8532 12.9808 16.2441L12.6424 17.0241C12.3942 17.5951 11.606 17.5951 11.3578 17.0241L11.0194 16.2441C10.4152 14.8532 9.32666 13.7455 7.96865 13.1396L6.92337 12.6741C6.35881 12.4222 6.35894 11.5975 6.92337 11.3453L7.90957 10.9058C9.30265 10.2844 10.4103 9.1351 11.0042 7.69687L11.3533 6.8542Z"
          fill="url(#paint2_linear_343_9463)"
        />
      </g>
      <path
        d="M30 18.7719V6.17188H34.032C36.168 6.17188 37.824 6.69388 39 7.73788C40.188 8.78188 40.782 10.3599 40.782 12.4719C40.782 13.7559 40.536 14.8719 40.044 15.8199C39.552 16.7559 38.82 17.4819 37.848 17.9979C36.876 18.5139 35.694 18.7719 34.302 18.7719H30ZM34.122 17.1519C35.61 17.1519 36.762 16.7739 37.578 16.0179C38.394 15.2499 38.802 14.0679 38.802 12.4719C38.802 10.9479 38.412 9.78388 37.632 8.97988C36.852 8.17588 35.664 7.77388 34.068 7.77388H31.908V17.1519H34.122Z"
        fill="white"
      />
      <path
        d="M42.8784 18.7719V10.0599H44.6604V10.5459C44.6604 11.0019 44.6544 11.3379 44.6424 11.5539C44.8704 11.0259 45.2124 10.5999 45.6684 10.2759C46.1244 9.93988 46.6704 9.77188 47.3064 9.77188C47.4864 9.77188 47.6244 9.77788 47.7204 9.78988V11.5539C47.5884 11.5179 47.4084 11.4999 47.1804 11.4999C46.3764 11.4999 45.7524 11.7279 45.3084 12.1839C44.8764 12.6399 44.6604 13.3359 44.6604 14.2719V18.7719H42.8784Z"
        fill="white"
      />
      <path
        d="M52.8108 19.0599C51.4788 19.0599 50.4228 18.6519 49.6428 17.8359C48.8748 17.0199 48.4908 15.8679 48.4908 14.3799C48.4908 13.4919 48.6708 12.6999 49.0308 12.0039C49.4028 11.2959 49.9068 10.7499 50.5428 10.3659C51.1908 9.96988 51.9168 9.77188 52.7208 9.77188C54.0168 9.77188 55.0248 10.1919 55.7448 11.0319C56.4648 11.8599 56.8248 12.9879 56.8248 14.4159V14.7939H50.3088C50.3208 15.6699 50.5608 16.3659 51.0288 16.8819C51.4968 17.3979 52.0968 17.6559 52.8288 17.6559C53.3808 17.6559 53.8488 17.5239 54.2328 17.2599C54.6168 16.9959 54.8568 16.5819 54.9528 16.0179H56.7528C56.6568 16.8939 56.2668 17.6199 55.5828 18.1959C54.8988 18.7719 53.9748 19.0599 52.8108 19.0599ZM54.9348 13.5159C54.9348 12.7959 54.7368 12.2199 54.3408 11.7879C53.9448 11.3559 53.4048 11.1399 52.7208 11.1399C52.0608 11.1399 51.5088 11.3619 51.0648 11.8059C50.6328 12.2499 50.3868 12.8199 50.3268 13.5159H54.9348Z"
        fill="white"
      />
      <path
        d="M61.3238 19.0599C60.7838 19.0599 60.2798 18.9519 59.8118 18.7359C59.3558 18.5199 58.9898 18.2079 58.7138 17.7999C58.4498 17.3919 58.3178 16.9179 58.3178 16.3779C58.3178 14.8419 59.3438 13.9179 61.3958 13.6059L63.0338 13.3539C63.3698 13.3059 63.6038 13.2219 63.7358 13.1019C63.8798 12.9699 63.9518 12.7779 63.9518 12.5259C63.9518 12.1059 63.8018 11.7699 63.5018 11.5179C63.2018 11.2659 62.8058 11.1399 62.3138 11.1399C61.7258 11.1399 61.2578 11.2899 60.9098 11.5899C60.5738 11.8899 60.3938 12.2979 60.3698 12.8139H58.5518C58.5878 12.2499 58.7558 11.7399 59.0558 11.2839C59.3558 10.8159 59.7698 10.4499 60.2978 10.1859C60.8378 9.90988 61.4678 9.77188 62.1878 9.77188C63.3518 9.77188 64.2278 10.0779 64.8158 10.6899C65.4158 11.3019 65.7158 12.1659 65.7158 13.2819V18.7719H64.0238V18.3579C64.0238 18.2019 64.0358 17.9439 64.0598 17.5839C63.8318 18.0399 63.4838 18.3999 63.0158 18.6639C62.5478 18.9279 61.9838 19.0599 61.3238 19.0599ZM61.6838 17.6919C62.3438 17.6919 62.8898 17.4879 63.3218 17.0799C63.7538 16.6599 63.9698 16.1139 63.9698 15.4419V14.2899C63.8378 14.4339 63.5078 14.5599 62.9798 14.6679L61.9358 14.8659C60.7478 15.0939 60.1538 15.5859 60.1538 16.3419C60.1538 16.7619 60.2978 17.0919 60.5858 17.3319C60.8738 17.5719 61.2398 17.6919 61.6838 17.6919Z"
        fill="white"
      />
      <path
        d="M68.1206 18.7719V10.0599H69.9026V10.6359C69.9026 10.9119 69.8966 11.1219 69.8846 11.2659C70.1486 10.8219 70.4906 10.4619 70.9106 10.1859C71.3426 9.90988 71.8466 9.77188 72.4226 9.77188C72.9746 9.77188 73.4726 9.92188 73.9166 10.2219C74.3606 10.5219 74.6906 10.9299 74.9066 11.4459C75.2066 10.9539 75.6026 10.5519 76.0946 10.2399C76.5986 9.92788 77.1506 9.77188 77.7506 9.77188C78.6506 9.77188 79.3766 10.0779 79.9286 10.6899C80.4926 11.2899 80.7746 12.1479 80.7746 13.2639V18.7719H78.9926V13.5879C78.9926 11.9919 78.4286 11.1939 77.3006 11.1939C76.7126 11.1939 76.2386 11.4279 75.8786 11.8959C75.5186 12.3519 75.3386 12.9279 75.3386 13.6239V18.7719H73.5386V13.6059C73.5386 11.9979 72.9866 11.1939 71.8826 11.1939C71.2826 11.1939 70.8026 11.4279 70.4426 11.8959C70.0826 12.3639 69.9026 12.9579 69.9026 13.6779V18.7719H68.1206Z"
        fill="white"
      />
      <path
        d="M83.8909 22.5159L85.4209 18.5559L81.9649 10.0599H83.9449L85.9969 15.6399C86.1049 15.9279 86.2309 16.2819 86.3749 16.7019C86.4829 16.3059 86.5969 15.9519 86.7169 15.6399L88.5709 10.0599H90.4429L85.7989 22.5159H83.8909Z"
        fill="white"
      />
      <path
        d="M94.4429 18.7719V6.17188H99.5009C100.809 6.17188 101.871 6.45988 102.687 7.03588C103.515 7.61188 103.929 8.54188 103.929 9.82588C103.929 11.1099 103.521 12.0399 102.705 12.6159C101.889 13.1919 100.821 13.4799 99.5009 13.4799H96.3509V18.7719H94.4429ZM99.4829 11.8599C101.139 11.8599 101.967 11.1819 101.967 9.82588C101.967 8.45788 101.139 7.77388 99.4829 7.77388H96.3509V11.8599H99.4829Z"
        fill="#FF195E"
      />
      <path
        d="M109.046 19.0599C108.194 19.0599 107.438 18.8679 106.778 18.4839C106.118 18.0999 105.602 17.5599 105.23 16.8639C104.87 16.1559 104.69 15.3399 104.69 14.4159C104.69 13.5039 104.876 12.6999 105.248 12.0039C105.62 11.2959 106.136 10.7499 106.796 10.3659C107.456 9.96988 108.206 9.77188 109.046 9.77188C109.886 9.77188 110.636 9.96988 111.296 10.3659C111.956 10.7499 112.472 11.2959 112.844 12.0039C113.216 12.6999 113.402 13.5039 113.402 14.4159C113.402 15.3399 113.216 16.1559 112.844 16.8639C112.472 17.5599 111.956 18.0999 111.296 18.4839C110.636 18.8679 109.886 19.0599 109.046 19.0599ZM109.046 17.6559C109.814 17.6559 110.426 17.3679 110.882 16.7919C111.338 16.2039 111.566 15.4119 111.566 14.4159C111.566 13.4319 111.332 12.6519 110.864 12.0759C110.408 11.4879 109.802 11.1939 109.046 11.1939C108.29 11.1939 107.678 11.4879 107.21 12.0759C106.754 12.6519 106.526 13.4319 106.526 14.4159C106.526 15.4119 106.754 16.2039 107.21 16.7919C107.666 17.3679 108.278 17.6559 109.046 17.6559Z"
        fill="#FF195E"
      />
      <path
        d="M115.372 18.7719V10.0599H117.154V10.5459C117.154 11.0019 117.148 11.3379 117.136 11.5539C117.364 11.0259 117.706 10.5999 118.162 10.2759C118.618 9.93988 119.164 9.77188 119.8 9.77188C119.98 9.77188 120.118 9.77788 120.214 9.78988V11.5539C120.082 11.5179 119.902 11.4999 119.674 11.4999C118.87 11.4999 118.246 11.7279 117.802 12.1839C117.37 12.6399 117.154 13.3359 117.154 14.2719V18.7719H115.372Z"
        fill="#FF195E"
      />
      <path
        d="M121.718 18.7719V10.0599H123.5V10.5819C123.5 10.8699 123.494 11.0979 123.482 11.2659C123.722 10.8339 124.076 10.4799 124.544 10.2039C125.024 9.91588 125.558 9.77188 126.146 9.77188C127.142 9.77188 127.916 10.0839 128.468 10.7079C129.032 11.3199 129.314 12.1719 129.314 13.2639V18.7719H127.532V13.5159C127.532 11.9679 126.926 11.1939 125.714 11.1939C125.054 11.1939 124.52 11.4219 124.112 11.8779C123.704 12.3339 123.5 12.8979 123.5 13.5699V18.7719H121.718Z"
        fill="#FF195E"
      />
      <path
        d="M145.77 18.7719H143.646L142.26 15.1359H136.716L135.348 18.7719H133.314L138.408 6.17188H140.658L145.77 18.7719ZM137.328 13.5339H141.666L139.902 8.90788L139.506 7.77388C139.386 8.14588 139.242 8.52387 139.074 8.90788L137.328 13.5339Z"
        fill="white"
      />
      <path
        d="M147.324 6.17188H149.232V18.7719H147.324V6.17188Z"
        fill="white"
      />
      <defs>
        <filter
          id="filter0_f_343_9463"
          x="-30.3872"
          y="-26.9412"
          width="84.7011"
          height="51.1862"
          filterUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feBlend
            mode="normal"
            in="SourceGraphic"
            in2="BackgroundImageFix"
            result="shape"
          />
          <feGaussianBlur
            stdDeviation="9.74976"
            result="effect1_foregroundBlur_343_9463"
          />
        </filter>
        <filter
          id="filter1_d_343_9463"
          x="5.61826"
          y="5.97284"
          width="12.7637"
          height="12.8021"
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
          <feOffset dy="0.440868" />
          <feGaussianBlur stdDeviation="0.440868" />
          <feComposite in2="hardAlpha" operator="out" />
          <feColorMatrix
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.25 0"
          />
          <feBlend
            mode="normal"
            in2="BackgroundImageFix"
            result="effect1_dropShadow_343_9463"
          />
          <feBlend
            mode="normal"
            in="SourceGraphic"
            in2="effect1_dropShadow_343_9463"
            result="shape"
          />
        </filter>
        <linearGradient
          id="paint0_linear_343_9463"
          x1="12"
          y1="2"
          x2="12"
          y2="21.8611"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#EC2B65" />
          <stop offset="1" stopColor="#C31045" />
        </linearGradient>
        <linearGradient
          id="paint1_linear_343_9463"
          x1="12"
          y1="2"
          x2="12"
          y2="21.8611"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#EC2B65" />
          <stop offset="1" stopColor="#C31045" />
        </linearGradient>
        <linearGradient
          id="paint2_linear_343_9463"
          x1="12.308"
          y1="6.27779"
          x2="12.308"
          y2="17.5833"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="white" />
          <stop offset="1" stopColor="#FFA4BF" />
        </linearGradient>
      </defs>
    </svg>
  );
}

export function NavigationBar({
  onMenuClick,
  onEnergyClick,
  energy,
  showGetEnergyButton = false,
  sidebarOpen = false,
}: NavigationBarProps) {
  const { t } = useTranslation();
  const gradId = useId();
  const hasEnergy = energy !== null && energy !== undefined && energy > 0;

  return (
    <nav className="flex items-center justify-between h-12 px-4 bg-Cr-Bg-soft-v2 fixed top-0 left-0 right-0 z-[400]">
      <div className="flex items-center gap-3">
        <button
          className="flex items-center justify-center w-7 h-7 bg-Cr-Bg-surface-subtle-v2 rounded-md-v2 transition-colors duration-200 hover:bg-[#333335]"
          onClick={onMenuClick}
        >
          {sidebarOpen ? <CloseIcon /> : <HamburgerIcon />}
        </button>
        <LogoIcon />
      </div>

      <div className="flex items-center">
        {showGetEnergyButton ? (
          <button
            className="flex items-center justify-center gap-1.5 h-7 pl-2 pr-3 bg-Cr-marketing-candlelight-500-v2 rounded-md-v2 text-Cr-Bg-surface-default-v2 text-sm font-medium leading-5 cursor-pointer transition-transform duration-200 hover:scale-[1.02]"
            onClick={onEnergyClick}
          >
            <img src={starIcon} alt="" className="w-4 h-4 shrink-0" />
            {t("common:getEnergy")}
          </button>
        ) : hasEnergy ? (
          <button
            className="flex items-center justify-center bg-transparent p-0 m-0 cursor-pointer appearance-none active:opacity-90"
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
              {/* Icon box opaque backing */}
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
            className="flex items-center justify-center gap-1.5 h-7 pl-2 pr-3 bg-Cr-marketing-candlelight-500-v2 rounded-md-v2 text-Cr-Bg-surface-default-v2 text-sm font-medium leading-5 cursor-pointer transition-transform duration-200 hover:scale-[1.02]"
            onClick={onEnergyClick}
          >
            <img src={starIcon} alt="" className="w-4 h-4 shrink-0" />
            {t("common:getEnergy")}
          </button>
        )}
      </div>
    </nav>
  );
}
