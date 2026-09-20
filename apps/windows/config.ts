export function cloudOrigin(env: NodeJS.ProcessEnv): string {
  if (env.APP_ENV !== 'production' || env.VITE_APP_ENV !== 'production') {
    throw new Error('Set APP_ENV=production and VITE_APP_ENV=production for a release.');
  }
  const url = new URL(env.AWWO_WINDOWS_CLOUD_URL ?? '');
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || url.pathname !== '/' || url.port || !url.hostname.includes('.')
    || url.hostname.endsWith('.localhost') || /^\d+(\.\d+){3}$/.test(url.hostname)
    || url.hostname.startsWith('[')) throw new Error('AWWO_WINDOWS_CLOUD_URL must be a public HTTPS origin.');
  return url.origin;
}
