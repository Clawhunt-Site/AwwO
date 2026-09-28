/** Public navigation only. No credentials or return URLs are carried across sites. */
export function safeMainSiteURL(value: unknown, environment: 'development' | 'production' = 'production'): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const source = value.trim();
  const authority = /^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i.exec(source)?.[1];
  // URL normalisation hides empty userinfo and empty query/fragment markers.
  if (!authority || authority.includes('@') || /[?#]/.test(source)) return undefined;
  try {
    const url = new URL(source);
    if (url.username || url.password) return undefined;
    if (url.protocol !== 'https:' && !(
      environment === 'development' && url.protocol === 'http:' &&
      /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(authority)
    )) return undefined;
    return url.href;
  } catch { return undefined; }
}

export function mainSiteEnvironment(env: Record<string, unknown> | undefined = (import.meta as ImportMeta & { env?: Record<string, unknown> }).env): 'development' | 'production' {
  return env?.DEV === true && env.MODE === 'development' ? 'development' : 'production';
}

export const mainSiteURL = safeMainSiteURL(
  (import.meta as ImportMeta & { env?: Record<string, unknown> }).env?.VITE_CLAWHUNT_SITE_URL,
  mainSiteEnvironment(),
);
