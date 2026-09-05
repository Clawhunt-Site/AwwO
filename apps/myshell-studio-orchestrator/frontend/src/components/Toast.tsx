import { useEffect } from 'react';

export interface ToastItem {
  id: number;
  message: string;
  /** "success" = green check icon (Figma default for Code applied / Link copied). */
  variant?: 'success' | 'info';
  /** Auto-dismiss timeout in ms. Default 2500. */
  duration?: number;
}

interface Props {
  toast: ToastItem;
  onClose: (id: number) => void;
}

export default function Toast({ toast, onClose }: Props) {
  const { id, message, variant = 'success', duration = 2500 } = toast;

  useEffect(() => {
    const t = setTimeout(() => onClose(id), duration);
    return () => clearTimeout(t);
  }, [id, duration, onClose]);

  return (
    <div className="inline-flex items-center gap-2 py-[10px] pl-[10px] pr-[14px] bg-Cr-Bg-surface-subtle-v2 rounded-full text-Cr-text-default-v2 text-sm font-medium leading-[18px] shadow-[0_6px_24px_rgba(0,0,0,0.45)] max-w-[calc(100vw-16px)]">
      {variant === 'success' && (
        <span className="inline-flex items-center justify-center shrink-0">
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <circle cx="9" cy="9" r="9" fill="#34C759" />
            <path d="M5 9.2 L7.6 11.8 L13 6.4" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          </svg>
        </span>
      )}
      <span className="whitespace-nowrap overflow-hidden text-ellipsis">{message}</span>
    </div>
  );
}
