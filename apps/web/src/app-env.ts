// Frontend environment identity, kept consistent with the kernel
// (superclaw.environment) and the desktop build (apps/desktop/scripts/app-env.mjs).
//
// The frontend MUST apply the same APP_ENV alias normalization as the backend:
// otherwise a build whose VITE_APP_ENV is an alias (e.g. "prod") would leave the
// frontend at a raw "prod" that isOnlineAppEnv does not recognize, splitting the
// bundle's identity from the backend. Unset still defaults to staging.

const APP_ENV_ALIASES: Record<string, string> = {
  development: 'development',
  dev: 'development',
  local: 'development',
  test: 'staging',
  stage: 'staging',
  prod: 'production',
};

export function normalizeAppEnv(raw: string | undefined | null): string {
  const value = (raw ?? '').trim().toLowerCase();
  if (!value) return 'staging';
  return APP_ENV_ALIASES[value] ?? value;
}

// Resolve a local-only service URL (ClawHunt dev override, Fusion previews). The
// localhost fallback applies ONLY on the Vite dev server (import.meta.env.DEV); a
// compiled bundle — staging OR production — resolves to undefined unless explicitly
// configured, so no localhost URL is ever USED in a shipped build (any localhost
// literal left in the bundle by the bundler is dead/unreachable). Pure + exported so
// the build-mode no-leak invariant is unit-testable.
export function pickServiceUrl(
  configured: string | undefined,
  localDefault: string,
  isDevServer: boolean,
): string | undefined {
  const trimmed = configured?.trim();
  if (trimmed) return trimmed;
  return isDevServer ? localDefault : undefined;
}
