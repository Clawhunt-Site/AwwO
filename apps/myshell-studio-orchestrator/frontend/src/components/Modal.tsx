import { ReactNode, useEffect } from 'react';

interface Props {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  /** Lock background scroll while the modal is open (default true). */
  lockScroll?: boolean;
}

/**
 * Generic centred modal dialog.
 * Figma: 327x290 card at #1D1C1F, 8px radius, 20px padding.
 */
export default function Modal({ open, onClose, children, lockScroll = true }: Props) {
  useEffect(() => {
    if (!open || !lockScroll) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open, lockScroll]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-[24px] z-[500] flex items-center justify-center px-6 animate-[fadeIn_0.2s_ease]"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-[327px] bg-Cr-Bg-surface-default-v2 rounded-lg-v2 p-5 flex flex-col gap-5 relative animate-[scaleIn_0.2s_ease]"
        onClick={e => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
