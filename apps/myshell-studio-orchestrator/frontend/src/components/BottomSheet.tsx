import { ReactNode } from 'react';

interface Props {
  onClose: () => void;
  children: ReactNode;
}

export default function BottomSheet({ onClose, children }: Props) {
  return (
    <>
      <div className="fixed inset-0 bg-black/60 z-[200] animate-[fadeIn_0.2s_ease]" onClick={onClose} />
      <div className="fixed bottom-0 left-0 right-0 bg-Cr-Bg-surface-default-v2 rounded-t-2xl-v2 z-[201] animate-[slideUp_0.3s_ease] pt-3 px-4 pb-[calc(env(safe-area-inset-bottom,16px)+16px)]">
        <div className="w-9 h-1 bg-[#48484A] rounded-sm-v2 mx-auto mb-4" />
        {children}
      </div>
    </>
  );
}
