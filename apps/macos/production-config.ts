export type ProductionConfiguration = {
  environment: 'production';
  cloudURL: string;
};

export function readProductionConfiguration(env: NodeJS.ProcessEnv): ProductionConfiguration {
  if (env.APP_ENV !== 'production' || env.VITE_APP_ENV !== 'production') {
    throw new Error('Set APP_ENV=production and VITE_APP_ENV=production for this release build.');
  }
  const value = env.AWWO_MAC_CLOUD_URL;
  if (!value) throw new Error('AWWO_MAC_CLOUD_URL must identify the approved production origin.');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('AWWO_MAC_CLOUD_URL is not a valid URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
      || url.pathname !== '/' || url.port || url.hostname === 'localhost'
      || /^\d+(\.\d+){3}$/.test(url.hostname) || url.hostname.startsWith('[')) {
    throw new Error('AWWO_MAC_CLOUD_URL must be a public HTTPS origin with no credentials, port, path, query or fragment.');
  }
  return { environment: 'production', cloudURL: url.origin };
}
