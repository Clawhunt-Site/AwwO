/**
 * SuperClaw environment resolution for the Paperclip Node server.
 *
 * Node port of the per-environment endpoint/key resolution from the SuperClaw kernel
 * `packages/superclaw/src/superclaw/environment.py`. This is the SINGLE source of
 * truth for staging/production service URLs and baked trust-root public keys on the
 * Node side — every other module resolves through the helpers here so an explicit
 * env override always wins and no host string is duplicated across files (dev-rules
 * URL centralization). These are PUBLIC endpoints/keys, never secrets.
 */

export const APP_ENV_NAME = "APP_ENV";
export const APP_ENV_CHOICES = ["staging", "production"] as const;
export const DEFAULT_APP_ENV = "staging";

const CLAWHUNT_BASE_URL_ENV = "CLAWHUNT_BASE_URL";

// Per-environment ClawHunt endpoints (single source of truth — mirror of the kernel).
const CLAWHUNT_BASE_URLS: Record<string, string> = {
  staging: "https://staging.clawhunt.store",
  production: "https://clawhunt.store",
};

// Product capability-signing PUBLIC key baked per environment (the "official" trust
// root super verifies signed capabilities against). staging/production carry SEPARATE
// keys (environment isolation); empty fails closed. Mirror of the kernel's
// OFFICIAL_ROOT_PUBLIC_KEYS.
const OFFICIAL_ROOT_PUBLIC_KEYS: Record<string, string> = {
  staging: "MmPYuR66nJZ+KvWeZD7Zs0nzcKY8iGSCrHj1+ZYXLK4=",
  production: "za6+eU91Bswm6PGqAxjeSYQu6UG6NIiNG6grhtcfwcY=",
};

/**
 * Read an environment variable as an OWN property only. `process.env[name]` walks the
 * prototype chain, so a polluted `Object.prototype[name]` would be read as a real env
 * value — Python `os.environ.get` never sees inherited values. Every env read here is
 * security-sensitive (it selects the environment, baked trust-root key, and service
 * endpoints), so they all go through this.
 */
function ownEnv(name: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(process.env, name) ? process.env[name] : undefined;
}

/** OWN-property lookup in a constant table — `table[key]` walks the prototype chain, so
 * a polluted `Object.prototype[key]` (e.g. `Object.prototype.staging = "production"`)
 * could remap a canonical env / key / URL. Python dict lookups never read inherited
 * attributes, so these must be own-only too. */
function ownLookup<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

// Every legacy/shorthand non-production spelling folds to staging; prod → production.
const APP_ENV_ALIASES: Record<string, string> = {
  development: "staging",
  dev: "staging",
  local: "staging",
  test: "staging",
  stage: "staging",
  prod: "production",
};

/**
 * Resolve the active APP_ENV ("staging" | "production"). Precedence: explicit
 * APP_ENV env var (with alias folding) > DEFAULT_APP_ENV (staging — never production
 * by default, so an unconfigured server stays fail-safe). Throws on an unknown value.
 *
 * NOTE: the kernel additionally reads a build-baked `build-profile.json`; on the Node
 * server the deployment sets APP_ENV directly. Baked-profile support is a follow-up;
 * defaulting to staging keeps it fail-safe in the meantime.
 */
export function appEnvironment(raw?: string | null): string {
  let value: string;
  if (raw !== undefined && raw !== null) {
    value = raw.trim().toLowerCase();
  } else {
    // Precedence (mirror of the kernel): explicit APP_ENV > compile-time baked
    // identity > default. A baked-production deployment with no APP_ENV must resolve
    // to production (endpoints + official key), not silently fall back to staging.
    value = (ownEnv(APP_ENV_NAME) ?? "").trim().toLowerCase();
    if (!value) value = (ownEnv("SUPERCLAW_BAKED_APP_ENV") ?? "").trim().toLowerCase();
  }
  if (!value) return DEFAULT_APP_ENV;
  const normalized = ownLookup(APP_ENV_ALIASES, value) ?? value;
  if (!(APP_ENV_CHOICES as readonly string[]).includes(normalized)) {
    throw new Error(`${APP_ENV_NAME} must be one of: ${APP_ENV_CHOICES.join(", ")}`);
  }
  return normalized;
}

/**
 * The COMPILE-TIME baked build identity (canonical APP_ENV), or "" when none/invalid.
 *
 * On the Node server the build sets `SUPERCLAW_BAKED_APP_ENV`; this is the LOWEST-
 * priority signal and is consulted only by the production-contamination guard so a
 * staging-baked deployment whose effective APP_ENV was flipped to production is still
 * caught (mirror of the kernel's `_baked_environment`). Invalid → "" (fail-soft),
 * never throws.
 */
export function bakedEnvironment(): string {
  const raw = (ownEnv("SUPERCLAW_BAKED_APP_ENV") ?? "").trim().toLowerCase();
  if (!raw) return "";
  const normalized = ownLookup(APP_ENV_ALIASES, raw) ?? raw;
  return (APP_ENV_CHOICES as readonly string[]).includes(normalized) ? normalized : "";
}

/**
 * The product capability-signing PUBLIC key baked for the active environment, or ""
 * when none is baked (fail-closed: no official capability is trusted).
 */
export function officialRootPublicKey(): string {
  return (ownLookup(OFFICIAL_ROOT_PUBLIC_KEYS, appEnvironment()) ?? "").trim();
}

function cleanEnvUrl(name: string): string | null {
  const value = (ownEnv(name) ?? "").trim();
  return value ? value.replace(/\/+$/, "") : null;
}

function stageDefaultUrl(name: string, defaults: Record<string, string>): string {
  const configured = cleanEnvUrl(name);
  if (configured) return configured;
  const env = appEnvironment();
  const fallback = ownLookup(defaults, env);
  if (fallback) return fallback;
  throw new Error(`${name} must be configured when ${APP_ENV_NAME}=${env}`);
}

/**
 * Canonicalize a URL host the way an HTTP client does (WHATWG URL applies IDNA/UTS-46),
 * so a homoglyph host (e.g. an ideographic full stop) that would *resolve* to the
 * production host cannot slip past a naive string compare. "" on parse failure.
 */
function canonicalHost(value: string): string {
  try {
    return new URL(value).hostname.toLowerCase().replace(/\.+$/, "");
  } catch {
    return "";
  }
}

/**
 * Fail closed if a non-production environment resolves ClawHunt to the production host
 * — the dev-rules invariant that staging must never touch production resources. Mirror
 * of the kernel's _guard_no_production_contamination (compared by host, not string, so
 * a trailing slash / extra path / homoglyph cannot bypass it).
 */
function guardNoProductionContamination(url: string): void {
  const productionHost = canonicalHost(ownLookup(CLAWHUNT_BASE_URLS, "production") ?? "");
  if (!productionHost || canonicalHost(url) !== productionHost) return;
  // Two independent hijack vectors, one invariant (mirror of the kernel guard): a
  // build NOT baked-as-production, and any environment resolving to staging, must
  // never reach the production endpoint.
  const baked = bakedEnvironment();
  if (baked && baked !== "production") {
    throw new Error(
      `cross-environment contamination: this build is baked as ${APP_ENV_NAME}=${baked} but resolved ` +
        `${CLAWHUNT_BASE_URL_ENV} to the production endpoint (${url}). A non-production build must never ` +
        `talk to production. Remove the stale ${APP_ENV_NAME} / ${CLAWHUNT_BASE_URL_ENV} override.`,
    );
  }
  if (appEnvironment() === "staging") {
    throw new Error(
      `cross-environment contamination: ${APP_ENV_NAME}=staging resolved ${CLAWHUNT_BASE_URL_ENV} ` +
        `to the production endpoint (${url}). Staging must never talk to production. Remove the ` +
        `stale ${CLAWHUNT_BASE_URL_ENV} override, or declare ${APP_ENV_NAME}=production to target it.`,
    );
  }
}

/** Resolve the ClawHunt base URL for the active environment (override > baked default). */
export function clawhuntBaseUrl(): string {
  const url = stageDefaultUrl(CLAWHUNT_BASE_URL_ENV, CLAWHUNT_BASE_URLS);
  guardNoProductionContamination(url);
  return url;
}

/**
 * The live capability-workshop feed URL. Lives under /v1/capabilities/* so the staging
 * Cloudflare Access allowlist serves it without a service token (the list is public).
 */
export function capabilityWorkshopCatalogUrl(): string {
  const override = (ownEnv("SUPERCLAW_CAPABILITY_WORKSHOP_CATALOG_URL") ?? "").trim();
  if (override) return override;
  return `${clawhuntBaseUrl()}/v1/capabilities/published`;
}

/** The plugin marketplace catalog URL (ClawHunt-hosted), env-overridable. */
export function pluginMarketplaceCatalogUrl(): string {
  const override = (ownEnv("SUPERCLAW_PLUGIN_MARKETPLACE_CATALOG_URL") ?? "").trim();
  if (override) return override;
  return `${clawhuntBaseUrl()}/api/plugins/marketplace-catalog`;
}
