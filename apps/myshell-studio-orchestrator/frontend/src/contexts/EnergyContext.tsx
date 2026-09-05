import { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import type { ReactNode } from 'react';
import { fetchInit, hasTelegramInitData, invalidateEnergyCache } from '../services/api';
import type { InitResponse } from '../types';
import i18n from '../i18n';
import { trackEvent } from '../services/tracking';

interface EnergyContextValue {
  energy: number | null;
  init: InitResponse | null;
  // TG-world VIP = user has purchased an energy pack at least once (init.is_vip).
  // null while init is loading so consumers can distinguish loading from false.
  isVip: boolean | null;
  refresh: () => Promise<void>;
}

const EnergyContext = createContext<EnergyContextValue>({
  energy: null,
  init: null,
  isVip: null,
  refresh: async () => {},
});

let initTracked = false;

function detectInitSource(): string {
  try {
    const params = new URLSearchParams(window.location.search);
    const src = params.get('src');
    if (src === 'invite_push') return 'push';
    const startParam = (
      window.Telegram?.WebApp?.initDataUnsafe as { start_param?: string } | undefined
    )?.start_param
      ?? params.get('startapp')
      ?? params.get('tgWebAppStartParam');
    if (startParam) return 'deeplink';
  } catch { /* ignore */ }
  return 'direct';
}

export function EnergyProvider({ children }: { children: ReactNode }) {
  const [energy, setEnergy] = useState<number | null>(null);
  const [init, setInit] = useState<InitResponse | null>(null);

  const load = useCallback(async () => {
    if (!hasTelegramInitData()) {
      setInit(null);
      setEnergy(null);
      return;
    }
    try {
      const data = await fetchInit();
      setInit(data);
      setEnergy(data.energy.balance);
      // Sync i18n language from server, but only if user hasn't manually set one
      if (data.language && !localStorage.getItem('dreamy_lang')) {
        i18n.changeLanguage(data.language);
      }
      // Fire miniapp_init once per session
      if (!initTracked) {
        initTracked = true;
        trackEvent('miniapp_init', { source: detectInitSource() });
      }
    } catch {
      // API fails silently outside Telegram (no initData)
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const refresh = useCallback(async () => {
    invalidateEnergyCache();
    await load();
  }, [load]);

  const value = useMemo(
    () => ({ energy, init, isVip: init ? Boolean(init.isVip) : null, refresh }),
    [energy, init, refresh],
  );

  return (
    <EnergyContext.Provider value={value}>
      {children}
    </EnergyContext.Provider>
  );
}

export function useEnergy() {
  return useContext(EnergyContext);
}
