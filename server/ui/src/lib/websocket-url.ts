type BrowserLocationLike = Pick<Location, "host" | "hostname" | "port" | "protocol">;

function isWildcardHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return normalized === "0.0.0.0" || normalized === "::" || normalized === "[::]";
}

export function browserReachableHost(location: BrowserLocationLike = window.location): string {
  if (!isWildcardHost(location.hostname)) return location.host;
  return location.port ? `localhost:${location.port}` : "localhost";
}

export function buildSameOriginWebSocketUrl(
  path: string,
  location: BrowserLocationLike = window.location,
): string {
  // Desktop D1: the board's apiBase can be an ABSOLUTE front-door origin
  // (http://127.0.0.1:<port>/paperclip-api), so `path` arrives already absolute.
  // Target that origin directly (http->ws, https->wss) instead of the page origin —
  // the webview stays on tauri://localhost and reaches the loopback front door.
  if (/^https?:\/\//i.test(path)) {
    return path.replace(/^http/i, "ws");
  }
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${protocol}://${browserReachableHost(location)}${normalizedPath}`;
}
