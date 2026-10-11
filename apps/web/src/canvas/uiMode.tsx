// How much of the canvas a person is shown.
//
//  * simple (普通用户模式): the conversation with the canvas assistant, each node's own chat and its model, and
//    what the canvas made. Everything that configures by hand (model rail, Bot roster, ports, inspector, view
//    styles, run records, knowledge map, layout tools) stays out of sight; the assistant does that work.
//  * developer (开发者模式): every control, exactly as before.
//
// Presentation only: a mode never changes the document, a run, a permission or what the server accepts, so a
// canvas built in one mode opens unchanged in the other. Hosts that do not choose (the desktop shell, tests) get
// the developer surface they always had.
import { createContext, useContext, type ReactNode } from 'react';

export type CanvasUiMode = 'simple' | 'developer';
export const UI_MODE_STORAGE_KEY = 'awwo.ui-mode.v1';

const UiModeContext = createContext<CanvasUiMode>('developer');

export function CanvasUiModeProvider({ mode, children }: { mode: CanvasUiMode; children: ReactNode }) {
  return <UiModeContext.Provider value={mode}>{children}</UiModeContext.Provider>;
}

export function useCanvasUiMode(): CanvasUiMode {
  return useContext(UiModeContext);
}

export function useSimpleCanvas(): boolean {
  return useContext(UiModeContext) === 'simple';
}

export function isUiMode(value: unknown): value is CanvasUiMode {
  return value === 'simple' || value === 'developer';
}

/** What someone who never chose sees. The hosted app ships `simple`; a test suite written against every control
 *  can ask for `developer` once, without writing to the storage each test clears. */
let defaultUiMode: CanvasUiMode = 'simple';
export function setDefaultUiMode(mode: CanvasUiMode): void { defaultUiMode = mode; }

/** The saved choice, or the default (simple): a person who never chose sees the chat-first surface. */
export function readUiMode(storage: Pick<Storage, 'getItem'> | null = typeof localStorage === 'undefined' ? null : localStorage): CanvasUiMode {
  try {
    const value = storage?.getItem(UI_MODE_STORAGE_KEY);
    if (isUiMode(value)) return value;
  } catch { /* Browser storage can be unavailable; the default still applies. */ }
  return defaultUiMode;
}

export function writeUiMode(mode: CanvasUiMode, storage: Pick<Storage, 'setItem'> | null = typeof localStorage === 'undefined' ? null : localStorage): void {
  try { storage?.setItem(UI_MODE_STORAGE_KEY, mode); } catch { /* The current page keeps the choice in memory. */ }
}
