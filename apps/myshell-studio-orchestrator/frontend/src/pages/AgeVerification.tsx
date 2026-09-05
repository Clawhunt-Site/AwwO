import { Trans, useTranslation } from "react-i18next";
import ageIcon from "../assets/age-icon.svg";

interface Props {
  onVerified: () => void;
}

export default function AgeVerification({ onVerified }: Props) {
  const { t } = useTranslation("splash");
  const handleYes = () => {
    localStorage.setItem("age_verified", "true");
    onVerified();
  };

  const handleNo = () => {
    window.Telegram?.WebApp?.close();
  };

  return (
    <div className="fixed inset-0 z-[9999] bg-black/70 backdrop-blur-md flex items-center justify-center px-8 animate-[fadeIn_0.3s_ease]">
      <div className="bg-Cr-Bg-surface-default-v2 rounded-lg-v2 p-5 w-full max-w-[311px] flex flex-col items-stretch gap-5 shadow-[2px_6px_18px_0_rgba(0,0,0,0.12)]">
        <div className="flex flex-col items-start gap-3">
          <h1 className="text-4xl leading-10 font-medium text-Cr-text-default-v2">
            🔞
          </h1>
          <div className="flex flex-col gap-1.5 w-full">
            <h2 className="text-xl leading-7 font-medium text-Cr-text-default-v2">
              {t("splash:ageVerification")}
            </h2>
            <p className="text-sm leading-5 text-Cr-text-subtler-v2 [&_strong]:text-Cr-text-default-v2 [&_strong]:font-medium">
              <Trans
                i18nKey="splash:ageDesc"
                components={{ strong: <strong /> }}
              />
            </p>
          </div>
        </div>
        <div className="flex flex-col gap-2 w-full">
          <button
            className="w-full h-11 px-4 rounded-md-v2 bg-CCr-button-primary-bg_default-v2 text-CCr-button-primary-fg_default-v2 text-base leading-6 font-medium text-center active:opacity-90"
            onClick={handleYes}
          >
            {t("splash:iAmOver18")}
          </button>
          <button
            className="w-full h-11 px-4 rounded-md-v2 bg-CCr-button-tertiary-bg_default-v2 text-CCr-button-tertiary-fg_default-v2 text-base leading-6 font-medium text-center active:opacity-90"
            onClick={handleNo}
          >
            {t("splash:iAmUnder18")}
          </button>
        </div>
      </div>
    </div>
  );
}
