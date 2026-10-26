const profiles = {
  development: { productName: 'AwwO Local', identifier: 'store.clawhunt.awwo.local' },
  staging: { productName: 'AwwO Staging', identifier: 'store.clawhunt.awwo.staging' },
  production: { productName: 'AwwO', identifier: 'store.clawhunt.awwo' },
};

export function windowsProfile(environment) {
  if (!Object.hasOwn(profiles, environment)) {
    throw new Error('An explicit profile is required: development, staging or production');
  }
  const profile = profiles[environment];
  return { environment, ...profile,
    windowTitle: environment === 'production' ? profile.productName : `${profile.productName} — ${environment}`,
    releaseChannel: environment === 'production' ? 'stable' : 'beta',
  };
}
