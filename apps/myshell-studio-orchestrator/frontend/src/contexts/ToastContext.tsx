import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import Toast, { ToastItem } from '../components/Toast';

interface ToastContextValue {
  showToast: (message: string, opts?: { variant?: 'success' | 'info'; duration?: number }) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const showToast = useCallback(
    (message: string, opts?: { variant?: 'success' | 'info'; duration?: number }) => {
      const id = nextId.current++;
      setToasts(prev => [...prev, { id, message, variant: opts?.variant, duration: opts?.duration }]);
    },
    [],
  );

  const dismissToast = useCallback((id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div
        className="fixed top-[calc(env(safe-area-inset-top,0px)+56px)] left-0 right-0 z-[600] flex flex-col items-center gap-2 pointer-events-none [&>*]:pointer-events-auto animate-[slideDown_0.25s_ease]"
        aria-live="polite"
        aria-atomic="true"
      >
        {toasts.map(t => (
          <Toast key={t.id} toast={t} onClose={dismissToast} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside ToastProvider');
  return ctx;
}
