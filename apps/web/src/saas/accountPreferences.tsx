// The account's own settings, saved on the server (GET/PUT /auth/preferences, backend preferences.go) so they follow
// the account to every browser: task notifications, the personal instructions the canvas planner reads, and the
// canvas assistant's default model. Language, mode and appearance style stay per browser (preferences.tsx).
// Saves are compare-and-swap on the version: a save from a stale tab answers version_conflict and reloads.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, SaaSApiError } from './api';

export type AccountPreferences = {
  notifications: { browser: boolean; sound: boolean };
  personalization: { enabled: boolean; aboutMe: string; instructions: string };
  defaultModel: { runtime: string; model: string } | null;
};
export const ABOUT_ME_LIMIT = 1000;
export const INSTRUCTIONS_LIMIT = 2000;
export const emptyAccountPreferences = (): AccountPreferences => ({
  notifications: { browser: false, sound: false },
  personalization: { enabled: false, aboutMe: '', instructions: '' },
  defaultModel: null,
});

/** What the server answered, with every missing or malformed part at its default. */
export function readAccountPreferences(value: unknown): AccountPreferences {
  const out = emptyAccountPreferences();
  const raw = value && typeof value === 'object' ? value as Record<string, any> : {};
  const notifications = raw.notifications && typeof raw.notifications === 'object' ? raw.notifications : {};
  out.notifications = { browser: notifications.browser === true, sound: notifications.sound === true };
  const personal = raw.personalization && typeof raw.personalization === 'object' ? raw.personalization : {};
  out.personalization = {
    enabled: personal.enabled === true,
    aboutMe: typeof personal.aboutMe === 'string' ? personal.aboutMe : '',
    instructions: typeof personal.instructions === 'string' ? personal.instructions : '',
  };
  const model = raw.defaultModel;
  out.defaultModel = model && typeof model === 'object' && typeof model.runtime === 'string' && model.runtime && typeof model.model === 'string' && model.model
    ? { runtime: model.runtime, model: model.model } : null;
  return out;
}

type Snapshot = { preferences: AccountPreferences; version: number };
export function fetchAccountPreferences(signal?: AbortSignal): Promise<Snapshot> {
  return api<{ preferences: unknown; version: number }>('/auth/preferences', { signal })
    .then(value => ({ preferences: readAccountPreferences(value.preferences), version: Number(value.version) || 0 }));
}
export function saveAccountPreferences(preferences: AccountPreferences, version: number): Promise<Snapshot> {
  return api<{ preferences: unknown; version: number }>('/auth/preferences', { method: 'PUT', body: JSON.stringify({ preferences, version }) })
    .then(value => ({ preferences: readAccountPreferences(value.preferences), version: Number(value.version) || 0 }));
}

export type AccountPreferencesState = {
  /** null until the first read answers. */
  preferences: AccountPreferences | null;
  loadError: unknown;
  reload: () => void;
  /** Saves a whole new value; rejects with the server's error (a conflict reloads the stored value first). */
  save: (next: AccountPreferences) => Promise<void>;
};
const Context = createContext<AccountPreferencesState | null>(null);

// The value outside React, for the code that reacts to a task ending (taskNotifications.ts).
let current: AccountPreferences | null = null;
export const currentAccountPreferences = () => current;

export function AccountPreferencesProvider({ userId, children }: { userId: string; children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [revision, setRevision] = useState(0);
  const versionRef = useRef(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoadError(null);
    fetchAccountPreferences(controller.signal).then(value => {
      if (controller.signal.aborted) return;
      versionRef.current = value.version; setSnapshot(value);
    }, cause => { if (!controller.signal.aborted) setLoadError(cause); });
    return () => controller.abort();
  }, [userId, revision]);
  useEffect(() => { current = snapshot?.preferences ?? null; }, [snapshot]);
  useEffect(() => () => { current = null; }, []);
  const save = useCallback(async (next: AccountPreferences) => {
    try {
      const saved = await saveAccountPreferences(next, versionRef.current);
      versionRef.current = saved.version; setSnapshot(saved);
    } catch (cause) {
      if (cause instanceof SaaSApiError && cause.status === 409) {
        // Another tab saved first: show what is stored now, and let the reader decide again.
        const latest = await fetchAccountPreferences().catch(() => null);
        if (latest) { versionRef.current = latest.version; setSnapshot(latest); }
      }
      throw cause;
    }
  }, []);
  const value = useMemo<AccountPreferencesState>(() => ({
    preferences: snapshot?.preferences ?? null, loadError, reload: () => setRevision(value => value + 1), save,
  }), [snapshot, loadError, save]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** The account's settings, or null outside a signed-in page (tests, the local app). */
export function useAccountPreferences(): AccountPreferencesState | null {
  return useContext(Context);
}
