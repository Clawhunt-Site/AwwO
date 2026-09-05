// Embedding-aware base. Standalone server/ui keeps the same-origin "/api". When the
// board is compiled into another app (apps/web), that build replaces the bare
// __PAPERCLIP_API_BASE__ identifier (vite `define`) with "/paperclip-api" so every
// board API/WS/SSE call targets the Paperclip control plane through a same-origin
// proxy. The `typeof` guard makes the read safe when the define is absent (standalone).
declare const __PAPERCLIP_API_BASE__: string | undefined;
const EMBED_BASE =
  (typeof __PAPERCLIP_API_BASE__ === "string" && __PAPERCLIP_API_BASE__.trim()) || "/api";

// Desktop (D1): the host app keeps its window on tauri://localhost and points the
// board at the Python front door's loopback ORIGIN at runtime (the desktop runtime
// picks a random port, so it cannot be a build-time define). When
// `globalThis.__SUPERCLAW_PY_ORIGIN__` is set (e.g. "http://127.0.0.1:54321") it is
// prepended to the embedding base so every board API/WS/SSE/asset URL targets the
// front door cross-origin. Empty in the browser / standalone (same-origin relative).
function pyOrigin(): string {
  const value = (globalThis as { __SUPERCLAW_PY_ORIGIN__?: unknown }).__SUPERCLAW_PY_ORIGIN__;
  return typeof value === "string" ? value.replace(/\/+$/, "") : "";
}
function computeApiBase(): string {
  // If the embedding base is already absolute (e.g. a build set it to a full URL),
  // never double-prefix the loopback origin onto it.
  if (/^https?:\/\//i.test(EMBED_BASE)) return EMBED_BASE;
  return pyOrigin() + EMBED_BASE;
}

// The front door ORIGIN (no /api suffix) for ROOT-level URLs the board does not
// route through apiBase — notably the Node-served plugin UI bytes at
// `/_plugins/:id/ui/*`. Empty in the browser / standalone (same-origin relative).
export function frontDoorOrigin(): string {
  return pyOrigin();
}

// Exported so the board's other same-origin callers (auth, health, adapters,
// board-chat, file downloads, websockets, plugin SSE) target the same embedding-aware
// base instead of re-hardcoding "/api". A `let` so the host can refresh it once the
// loopback origin is known — ESM live bindings propagate the new value to every
// importer without changing a single call site.
export let apiBase = computeApiBase();

// Recompute apiBase after the host sets __SUPERCLAW_PY_ORIGIN__. Also registered on
// globalThis so apps/web can trigger it without importing across the board boundary.
export function refreshApiBase(): string {
  apiBase = computeApiBase();
  return apiBase;
}
(globalThis as { __SUPERCLAW_REFRESH_API_BASE__?: () => string }).__SUPERCLAW_REFRESH_API_BASE__ =
  refreshApiBase;

/**
 * Resolve a SERVER-EMITTED content URL (asset/attachment/artifact/company-logo/
 * invite-logo) for the current embedding. The server hands back absolute
 * "/api/..." paths the board renders directly (img src, href, fetch, video src).
 * Standalone that's correct (same-origin /api). EMBEDDED, the host app's "/api"
 * proxy points at ITS OWN backend (e.g. apps/web's Python), not the Paperclip
 * control plane — so a raw "/api/assets/.../content" hits the wrong server / 404s.
 * Rewrite a leading "/api" to the embedding base so the request goes through the
 * SAME same-origin proxy as every other board call. No-op standalone (BASE ===
 * "/api"); absolute (http/https), blob:, data: and any non-"/api" URL pass through.
 */
export function resolveContentUrl<T extends string | null | undefined>(url: T): T {
  if (typeof url !== "string" || apiBase === "/api" || !url.startsWith("/api/")) return url;
  return `${apiBase}${url.slice("/api".length)}` as T;
}

export class ApiError extends Error {
  status: number;
  body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers ?? undefined);
  const body = init?.body;
  if (!(body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const res = await fetch(`${apiBase}${path}`, {
    headers,
    credentials: "include",
    ...init,
  });
  if (!res.ok) {
    const errorBody = await res.json().catch(() => null);
    throw new ApiError(
      (errorBody as { error?: string } | null)?.error ?? `Request failed: ${res.status}`,
      res.status,
      errorBody,
    );
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "POST", body: JSON.stringify(body) }),
  postForm: <T>(path: string, body: FormData) =>
    request<T>(path, { method: "POST", body }),
  put: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "PUT", body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "PATCH", body: JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};
