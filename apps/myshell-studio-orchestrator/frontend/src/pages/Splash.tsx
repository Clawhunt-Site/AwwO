import { useEffect } from 'react';

export default function Splash({ onDone }: { onDone: () => void }) {
  // Fallback timer in case CSS animationEnd doesn't fire (TG WebView)
  useEffect(() => {
    const timer = setTimeout(onDone, 2400);
    return () => clearTimeout(timer);
  }, [onDone]);

  return (
    <div
      className="fixed inset-0 flex flex-col items-center justify-center bg-Cr-Bg-soft-v2 z-[999] animate-[fadeOut_0.4s_ease_1.8s_forwards]"
      onAnimationEnd={(e) => {
        if (e.animationName.includes('fadeOut')) onDone();
      }}
    >
      <div className="w-18 h-18 rounded-[18px] flex items-center justify-center mb-4 bg-linear-to-r from-dreamy-gradient-brand-from-v2 to-dreamy-gradient-brand-to-v2 animate-[pulse_1.5s_ease_infinite]">
        <svg width="36" height="36" viewBox="0 0 24 24" fill="white">
          <path d="M13 3L4 14h7l-2 7 9-11h-7l2-7z" />
        </svg>
      </div>
      <div className="text-[22px] font-medium">
        Fantasia <span className="text-dreamy-brand-hot-v2">AI</span>
      </div>
      <div className="mt-8 w-8 h-8 border-[3px] border-white/10 border-t-dreamy-brand-hot-v2 rounded-full animate-[spin_0.8s_linear_infinite]" />
    </div>
  );
}
