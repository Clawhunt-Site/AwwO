export type DesktopInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export type DesktopShellInfo = {
  productName: string;
  version: string;
  releaseChannel: string;
  updateMode: string;
  workspaceRoot?: string | null;
  webDevUrl: string;
  webDistPath?: string | null;
  cliExecutable: string;
  updateGuidePath?: string | null;
  workspaceUpdateCommand?: string | null;
};

export type DesktopRuntimeHandle = {
  base_url: string;
  control_token: string;
  state_path: string;
  owned: boolean;
  pid?: number | null;
};

export type DesktopRuntimeSession = {
  ok: boolean;
  handle?: DesktopRuntimeHandle | null;
  status?: Record<string, unknown> | null;
};

export type DesktopThemePreference = 'light' | 'dark' | 'system';

type TauriWindow = Window & {
  __TAURI_INTERNALS__?: {
    invoke?: DesktopInvoke;
  };
  __TAURI__?: {
    core?: {
      invoke?: DesktopInvoke;
    };
  };
};

export function detectDesktopInvoke(target: Window | undefined = typeof window === 'undefined' ? undefined : window) {
  if (!target) return null;
  const desktopWindow = target as TauriWindow;
  return desktopWindow.__TAURI__?.core?.invoke ?? desktopWindow.__TAURI_INTERNALS__?.invoke ?? null;
}

export async function startDesktopWindowDrag(target: Window | undefined = typeof window === 'undefined' ? undefined : window) {
  if (!target) return false;
  const desktopWindow = target as TauriWindow;
  const invoke = desktopWindow.__TAURI__?.core?.invoke ?? desktopWindow.__TAURI_INTERNALS__?.invoke;
  if (!invoke) return false;
  await invoke('desktop_start_window_drag');
  return true;
}

export async function toggleDesktopWindowMaximize(target: Window | undefined = typeof window === 'undefined' ? undefined : window) {
  if (!target) return false;
  const desktopWindow = target as TauriWindow;
  const invoke = desktopWindow.__TAURI__?.core?.invoke ?? desktopWindow.__TAURI_INTERNALS__?.invoke;
  if (!invoke) return false;
  await invoke('desktop_toggle_window_maximize');
  return true;
}

export async function readDesktopShellInfo(invoke: DesktopInvoke): Promise<DesktopShellInfo> {
  return (await invoke('desktop_shell_info')) as DesktopShellInfo;
}

export async function startDesktopRuntime(invoke: DesktopInvoke): Promise<DesktopRuntimeSession> {
  return (await invoke('desktop_runtime_start', { request: {} })) as DesktopRuntimeSession;
}

export async function stopDesktopRuntime(
  invoke: DesktopInvoke,
  handle: DesktopRuntimeHandle,
): Promise<{ ok: boolean; stopped: boolean; pid: number | null }> {
  return (await invoke('desktop_runtime_stop', {
    request: { pid: handle.pid ?? -1, owned: handle.owned, waitTimeoutSeconds: 1.5 },
  })) as { ok: boolean; stopped: boolean; pid: number | null };
}

export async function setDesktopWindowTheme(invoke: DesktopInvoke, theme: DesktopThemePreference): Promise<{ ok: boolean; theme: DesktopThemePreference }> {
  return (await invoke('desktop_set_window_theme', { request: { theme } })) as { ok: boolean; theme: DesktopThemePreference };
}

export async function openDesktopExternalUrl(invoke: DesktopInvoke, url: string): Promise<{ ok: boolean; url: string }> {
  return (await invoke('desktop_open_external_url', { request: { url } })) as { ok: boolean; url: string };
}

// Reveal a workspace folder OR a file in the OS file manager (Finder/Explorer).
// Desktop only — the web surface never offers this (no `desktopInvoke`). The Rust
// shell validates the path exists before revealing it.
export async function revealDesktopPath(invoke: DesktopInvoke, path: string): Promise<{ ok: boolean; path: string }> {
  return (await invoke('desktop_reveal_path', { request: { path } })) as { ok: boolean; path: string };
}

// Reveal an in-memory image in Finder/Explorer. Pasted/uploaded chat images live
// only as base64 data URLs with no source file on disk, so the Rust shell writes
// the (allowlist- + magic-byte-validated) bytes into the app's `saved-images/`
// folder and reveals that file. Desktop only.
export async function revealDesktopImage(
  invoke: DesktopInvoke,
  image: { mime: string; dataBase64: string; name?: string },
): Promise<{ ok: boolean; path: string }> {
  return (await invoke('desktop_reveal_image', { request: image })) as { ok: boolean; path: string };
}

// ── Native browser panel (desktop-only) ──────────────────────────────────────
// A real, interactive browser surface: an OS-native child webview the Rust shell
// overlays on the reference panel's content rectangle. The frontend reports the
// live rect (CSS/logical px relative to the window content area) and drives
// open / reposition / history; navigation + load state flow back as a DOM
// `superclaw:ref-browser` CustomEvent (Rust evals it into the main webview).

/** A panel rectangle in CSS/logical pixels relative to the main window content area. */
export type DesktopBrowserRect = { x: number; y: number; width: number; height: number };

/** Detail payload of the `superclaw:ref-browser` CustomEvent pushed from Rust. */
export type DesktopBrowserEvent =
  | { type: 'navigated'; url: string }
  | { type: 'load'; phase: 'started' | 'finished'; url: string };

export const DESKTOP_BROWSER_EVENT = 'superclaw:ref-browser';

// All browser commands mutate ONE shared native child webview (open/show/hide/
// navigate/close). They must apply in dispatch order, but `invoke` is async and
// Tauri may run commands concurrently — so a panel unmount's hide could land
// after the next panel's open and blank the surface. Serialize every browser
// command through one FIFO chain: each runs only after the previous settles, so
// the effective order equals the React-lifecycle call order. Failures don't
// wedge the chain (we swallow into the next link).
let browserOpChain: Promise<unknown> = Promise.resolve();
function enqueueBrowserOp<T>(op: () => Promise<T>): Promise<T> {
  const run = browserOpChain.then(op, op);
  // Keep the chain alive regardless of this op's outcome.
  browserOpChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run as Promise<T>;
}

export async function openDesktopBrowser(
  invoke: DesktopInvoke,
  url: string,
  rect: DesktopBrowserRect,
): Promise<{ ok: boolean; url: string; reused: boolean }> {
  return enqueueBrowserOp(
    () =>
      invoke('desktop_browser_open', { request: { url, rect } }) as Promise<{
        ok: boolean;
        url: string;
        reused: boolean;
      }>,
  );
}

export async function setDesktopBrowserBounds(
  invoke: DesktopInvoke,
  rect: DesktopBrowserRect,
  hidden: boolean,
): Promise<{ ok: boolean; open: boolean; hidden?: boolean }> {
  return enqueueBrowserOp(
    () =>
      invoke('desktop_browser_set_bounds', { request: { rect, hidden } }) as Promise<{
        ok: boolean;
        open: boolean;
        hidden?: boolean;
      }>,
  );
}

export async function navigateDesktopBrowser(
  invoke: DesktopInvoke,
  action: 'back' | 'forward' | 'reload',
): Promise<{ ok: boolean; open: boolean; action?: string }> {
  return enqueueBrowserOp(
    () =>
      invoke('desktop_browser_navigate', { request: { action } }) as Promise<{
        ok: boolean;
        open: boolean;
        action?: string;
      }>,
  );
}

export async function closeDesktopBrowser(invoke: DesktopInvoke): Promise<{ ok: boolean; closed: boolean }> {
  return enqueueBrowserOp(
    () => invoke('desktop_browser_close') as Promise<{ ok: boolean; closed: boolean }>,
  );
}

export function desktopApiBaseUrl(session: DesktopRuntimeSession | null) {
  const baseUrl = session?.handle?.base_url?.trim();
  return baseUrl ? baseUrl.replace(/\/+$/, '') : null;
}

export function desktopControlToken(session: DesktopRuntimeSession | null) {
  const value = session?.handle?.control_token?.trim();
  return value || null;
}

export function buildDesktopApiUrl(path: string, session: DesktopRuntimeSession | null) {
  const baseUrl = desktopApiBaseUrl(session);
  if (!baseUrl) return path;
  return path.startsWith('/') ? `${baseUrl}${path}` : `${baseUrl}/${path}`;
}

export function buildDesktopEventStreamUrl(path: string, token: string | null, session: DesktopRuntimeSession | null) {
  const url = new URL(buildDesktopApiUrl(path, session), 'http://127.0.0.1');
  if (token) url.searchParams.set('token', token);
  return desktopApiBaseUrl(session) ? url.toString() : `${url.pathname}${url.search}`;
}
