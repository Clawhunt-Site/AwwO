// Build-time environment identity resolution for the desktop bundle.
//
// Mirrors superclaw.environment's APP_ENV aliases so the baked profile is always a
// canonical value (never an alias like "prod"), and fails closed if the backend
// (APP_ENV) and frontend (VITE_APP_ENV) selectors disagree — a desktop bundle must
// ship ONE environment identity, not a backend-staging / frontend-production hybrid
// (adversarial review). Kept as a separate, side-effect-free module so it is unit
// testable (prepare-macos-bundle.mjs runs codesign/ditto at import time).

// Only two environments — staging (the test server) and production. Every legacy /
// shorthand non-production spelling folds to staging so an old build command keeps
// working; "prod" folds to production. (Mirrors superclaw.environment._APP_ENV_ALIASES.)
const APP_ENV_ALIASES = {
  development: "staging",
  dev: "staging",
  local: "staging",
  test: "staging",
  stage: "staging",
  prod: "production",
};
const APP_ENV_CHOICES = new Set(["staging", "production"]);

export function normalizeAppEnv(raw) {
  if (!raw) return "";
  const value = String(raw).trim().toLowerCase();
  const normalized = APP_ENV_ALIASES[value] || value;
  if (!APP_ENV_CHOICES.has(normalized)) {
    throw new Error(`APP_ENV must be one of staging/production (got "${raw}")`);
  }
  return normalized;
}

// Resolve the single environment identity for a build from the backend (APP_ENV) and
// frontend (VITE_APP_ENV) selectors. Throws on an unknown value or on a mismatch
// between the two; defaults to "staging" when neither is set.
export function resolveBuildAppEnv(appEnvRaw, viteEnvRaw) {
  const normalizedApp = normalizeAppEnv(appEnvRaw);
  const normalizedVite = normalizeAppEnv(viteEnvRaw);
  if (normalizedApp && normalizedVite && normalizedApp !== normalizedVite) {
    throw new Error(
      `environment mismatch: APP_ENV=${appEnvRaw} (backend) vs VITE_APP_ENV=${viteEnvRaw} ` +
        `(frontend) resolve to different environments; a desktop bundle must have one ` +
        `identity. Set both to the same value or use 'npm run tauri:build:staging' / ` +
        `':production'.`,
    );
  }
  return normalizedApp || normalizedVite || "staging";
}
