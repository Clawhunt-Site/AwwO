// What a page being rendered may reach: the same public CDNs the web preview's Content-Security-Policy names
// (apps/web/src/canvas/studio/liveDocument.ts LIVE_CDNS; a test keeps the two lists equal), plus in-page data:,
// blob: and about: URLs. Everything else is aborted before it leaves the browser, so a page can never reach the
// host's own services, a private address or an arbitrary site.
import { readFileSync } from 'node:fs';

export const CDN_ORIGINS = Object.freeze(JSON.parse(readFileSync(new URL('./cdn-allowlist.json', import.meta.url), 'utf8')));
const ALLOWED = new Set(CDN_ORIGINS);
const IN_PAGE = new Set(['data:', 'blob:', 'about:']);

/** True when the page may make this request: an in-page URL, or https to an allowlisted CDN origin exactly. */
export function allowedRequest(urlString) {
  let url;
  try {
    url = new URL(String(urlString));
  } catch {
    return false;
  }
  if (IN_PAGE.has(url.protocol)) return true;
  if (url.protocol !== 'https:') return false;
  // The URL parser drops a default port (:443) from url.port; any other port, or credentials, is refused.
  if (url.username !== '' || url.password !== '' || url.port !== '') return false;
  return ALLOWED.has(url.origin);
}

/**
 * Chromium --host-resolver-rules that make every hostname but the CDNs' unresolvable. A second wall behind the
 * request router: it also covers what the router never sees (a redirect's next hop, preconnects, WebRTC by name).
 */
export function hostResolverRules(origins = CDN_ORIGINS) {
  const hosts = [...new Set(origins.map((origin) => new URL(origin).hostname))];
  return ['MAP * ~NOTFOUND', ...hosts.map((host) => `EXCLUDE ${host}`)].join(', ');
}

// Runs in every frame before the page: WebRTC can reach a host over UDP/TCP without an HTTP request the router
// would see, and an animation never needs it.
export const NETWORK_GUARD_SCRIPT = `(() => {
  for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCIceCandidate', 'RTCSessionDescription']) {
    try { delete window[name]; } catch (error) {}
    try { if (name in window) Object.defineProperty(window, name, { value: undefined, configurable: false, writable: false }); } catch (error) {}
  }
})();`;
