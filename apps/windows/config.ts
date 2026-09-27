function publicHttpsOrigin(value: string | undefined, variable: string): string {
  const error = `${variable} must be a public HTTPS origin.`;
  let url: URL;
  try {
    url = new URL(value ?? '');
  } catch {
    throw new Error(error);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || url.pathname !== '/' || url.port || !url.hostname.includes('.')
    || url.hostname.endsWith('.') || url.hostname.endsWith('.localhost') || /^\d+(\.\d+){3}$/.test(url.hostname)
    || url.hostname.startsWith('[')) throw new Error(error);
  return url.origin;
}

function identityProviderOrigins(value: string | undefined): string[] {
  const variable = 'AWWO_WINDOWS_IDP_ORIGINS';
  if (value === 'none') return [];
  if (!value?.trim()) throw new Error(`${variable} must list exact public HTTPS origins, or be 'none'.`);
  return value.split(',').map((origin) => publicHttpsOrigin(origin.trim(), variable));
}

export function cloudOrigins(env: NodeJS.ProcessEnv): { app: string; access: string; identityProviders: string[] } {
  if (env.APP_ENV !== 'production' || env.VITE_APP_ENV !== 'production') {
    throw new Error('Set APP_ENV=production and VITE_APP_ENV=production for a release.');
  }
  return {
    app: publicHttpsOrigin(env.AWWO_WINDOWS_CLOUD_URL, 'AWWO_WINDOWS_CLOUD_URL'),
    access: publicHttpsOrigin(env.AWWO_WINDOWS_ACCESS_ORIGIN, 'AWWO_WINDOWS_ACCESS_ORIGIN'),
    identityProviders: identityProviderOrigins(env.AWWO_WINDOWS_IDP_ORIGINS),
  };
}

export function cloudOrigin(env: NodeJS.ProcessEnv): string {
  return cloudOrigins(env).app;
}
