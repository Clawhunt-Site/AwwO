/** Public navigation only. No credentials or return URLs are carried across sites. */
export function safeMainSiteURL(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return undefined;
    return url.href;
  } catch { return undefined; }
}

export const mainSiteURL = safeMainSiteURL(
  (import.meta as ImportMeta & { env?: Record<string, unknown> }).env?.VITE_CLAWHUNT_SITE_URL,
);
