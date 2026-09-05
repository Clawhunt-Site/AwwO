/**
 * Capability Workshop — live catalog projection (slice 4).
 *
 * Node port of the SuperClaw kernel's catalog read endpoints
 * (apps/api/main.py `capability_workshop_catalog` / `plugin_marketplace_catalog`
 * + `_map_capability_entry_to_marketplace`). Thin surface proxies: they fetch the
 * ClawHunt-hosted catalog and re-shape it for the web surface. NO governance decision
 * happens here — ClawHunt review decides what is published. The one trust verdict is
 * the OFFICIAL badge, which comes SOLELY from local re-verification of each entry's
 * co-signature against the baked official key (verifyOfficialCosignature), never from
 * a self-reported feed flag.
 */

import {
  capabilityWorkshopCatalogUrl,
  officialRootPublicKey,
  pluginMarketplaceCatalogUrl,
} from "../superclaw-environment.js";
import { verifyOfficialCosignature } from "../trust/cosign.js";
import { parseTrustJson } from "../trust/jcs.js";

const FETCH_TIMEOUT_MS = 8000;

const CAPABILITY_KIND_ICON: Record<string, string> = {
  plugin: "runtime",
  skill: "developer",
  company: "productivity",
};

const CAPABILITY_KIND_LABEL: Record<string, { en: string; zh: string }> = {
  plugin: { en: "Plugin", zh: "插件" },
  skill: { en: "Skill", zh: "技能" },
  company: { en: "Company", zh: "公司" },
};

/** Read an OWN property only (mirrors Python dict.get — never the prototype chain). */
function own(obj: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

/** Wrap a single-language string into the surface's {en, zh} shape. */
function localizedText(value: unknown): { en: string; zh: string } {
  const text = typeof value === "string" ? value.trim() : "";
  return { en: text, zh: text };
}

/** Keep a real string, drop anything else to null (fail-closed for untrusted feed). */
function optStr(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** A non-empty string value, else the fallback. Used for identity fields the kernel
 * resolves with `entry.get(x) or default`: for a valid string feed this is identical,
 * and a non-string value (malformed untrusted feed) falls back instead of being
 * String()-coerced into a bogus key / crashing the catalog on a .title()/dict-key. */
function nonEmptyStringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value ? value : fallback;
}

/**
 * Python `bool(...)` truthiness — differs from JS `Boolean(...)` on the empty
 * container cases that matter for an untrusted feed: `bool([])`/`bool({})` are
 * FALSE in Python but `Boolean([])`/`Boolean({})` are true in JS. Using this for
 * every feed-derived boolean/`or` keeps a malformed entry from lighting up a
 * legacy verified / entitlement state Node-only.
 */
function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === "") return false;
  if (typeof value === "number") return value !== 0 && !Number.isNaN(value);
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length > 0;
  return true;
}

const pyBool = (value: unknown): boolean => pyTruthy(value);

/** Python `a or b`: the first operand if Python-truthy, else the second. */
function pyOr<T>(value: unknown, fallback: T): unknown {
  return pyTruthy(value) ? value : fallback;
}

function titleCase(value: string): string {
  return value.replace(/\b\w/g, (c) => c.toUpperCase());
}

export interface MarketplaceCatalogResult {
  // Workshop emits "clawhunt_workshop"/"unavailable"; marketplace forwards the feed's
  // own `source` verbatim (the kernel does not type-check it), hence unknown.
  source: unknown;
  catalog_url: string;
  total: number;
  // Workshop entries are mapped objects; marketplace entries are passed through
  // verbatim (the kernel forwards the feed list as-is, so non-object elements survive).
  plugins: unknown[];
  error: string | null;
}

/**
 * Project a ClawHunt published-capability entry into the marketplace catalog shape
 * the web surface consumes. `officialVerified` MUST already be the result of
 * verifyOfficialCosignature against the baked key — it is the ONLY source of the
 * `trust: "official"` verdict (never a self-reported feed flag). Defaults false
 * (fail-closed: unverified → no badge).
 */
export function mapCapabilityEntryToMarketplace(
  entry: Record<string, unknown>,
  officialVerified = false,
): Record<string, unknown> {
  const kind = nonEmptyStringOr(own(entry, "kind"), "plugin");
  const capabilityId = nonEmptyStringOr(
    own(entry, "capability_id"),
    nonEmptyStringOr(own(entry, "plugin_id"), ""),
  );
  const status = nonEmptyStringOr(
    own(entry, "status"),
    nonEmptyStringOr(own(entry, "review_status"), ""),
  ).toLowerCase();
  return {
    plugin_id: capabilityId,
    version: pyOr(own(entry, "version"), ""),
    kind,
    name: localizedText(pyOr(own(entry, "name"), capabilityId)),
    summary: localizedText(own(entry, "summary")),
    category: kind,
    category_label: CAPABILITY_KIND_LABEL[kind] ?? localizedText(titleCase(kind)),
    icon: CAPABILITY_KIND_ICON[kind] ?? "runtime",
    runtime: pyOr(own(entry, "runtime"), kind),
    pricing_model: pyOr(own(entry, "pricing_model"), "free"),
    // verified/signature_verified are self-reported upstream booleans passed through
    // for legacy UI only — they carry NO local cryptographic weight (the OFFICIAL
    // badge comes solely from `trust === 'official'` below).
    verified: pyBool(own(entry, "verified")),
    signature_verified: pyBool(own(entry, "signature_verified")),
    signer_keyid: optStr(own(entry, "signer_keyid")),
    // Opaque, UNVERIFIED co-signature evidence carried for other consumers that may
    // re-verify; the verdict is computed locally, not echoed from the feed.
    official_signature: optStr(own(entry, "official_signature")),
    official_signer_keyid: optStr(own(entry, "official_signer_keyid")),
    // Locally-verified OFFICIAL endorsement → the kernel `trust` state the web badge
    // keys off; set ONLY when the co-signature verified against the baked key.
    trust: officialVerified ? "official" : null,
    capability_status: status || "published",
    entitlement_required: pyBool(own(entry, "entitlement_required")),
    featured: false,
    skill_origin: kind === "skill",
    // Company capabilities are organization templates, not installable packages.
    instantiable: kind !== "company",
    package_digest: own(entry, "package_digest") ?? null,
    artifact_blob_digest: own(entry, "blob_digest") ?? null,
    source: "clawhunt_workshop",
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.text();
}

/** Lenient JSON for the pass-through marketplace feed (may legitimately carry floats,
 * e.g. prices; it never feeds cosign). */
async function fetchJsonLenient(url: string): Promise<unknown> {
  return JSON.parse(await fetchText(url));
}

/** Strict JSON for the WORKSHOP feed: it carries trust-relevant identity that feeds
 * cosign, so it is parsed with `parseTrustJson` which rejects float number literals.
 * This closes the JS/Python parity gap where `"length": 4096.0` would collapse to an
 * int in Node (minting a spurious official badge) while the kernel rejects the float.
 * A legitimate ClawHunt capability feed is float-free by contract; a float literal
 * anywhere fails the feed CLOSED (catalog "unavailable") rather than risk a
 * cross-runtime trust divergence. */
async function fetchTrustJson(url: string): Promise<unknown> {
  return parseTrustJson(await fetchText(url));
}

/**
 * GET /api/plugins/workshop-catalog — live capability-workshop catalog projected from
 * ClawHunt's public `/v1/capabilities/published` feed, with a locally-verified
 * OFFICIAL badge per entry.
 */
export async function fetchWorkshopCatalog(kind?: string | null): Promise<MarketplaceCatalogResult> {
  const catalogUrl = capabilityWorkshopCatalogUrl();
  try {
    let requestUrl = catalogUrl;
    if (kind) {
      // Append the param safely (the override URL may already carry a query) — mirrors
      // the kernel's httpx params= rather than naive string concatenation. Built INSIDE
      // try so a malformed override URL surfaces as {source:"unavailable"}, not a 500.
      const u = new URL(catalogUrl);
      u.searchParams.set("kind", kind);
      requestUrl = u.toString();
    }
    const payload = await fetchTrustJson(requestUrl);
    const entriesRaw =
      payload && typeof payload === "object" && Array.isArray((payload as Record<string, unknown>).entries)
        ? ((payload as Record<string, unknown>).entries as unknown[])
        : [];
    const officialKey = officialRootPublicKey() || null;
    const plugins = entriesRaw
      .filter((e): e is Record<string, unknown> => e !== null && typeof e === "object" && !Array.isArray(e))
      .map((entry) => mapCapabilityEntryToMarketplace(entry, verifyOfficialCosignature(entry, officialKey)));
    return { source: "clawhunt_workshop", catalog_url: catalogUrl, total: plugins.length, plugins, error: null };
  } catch (err) {
    return { source: "unavailable", catalog_url: catalogUrl, total: 0, plugins: [], error: errorMessage(err) };
  }
}

/**
 * GET /api/plugins/marketplace-catalog — pass-through proxy of ClawHunt's marketplace
 * catalog (no local re-shaping; plugins are forwarded as the feed returns them).
 */
export async function fetchMarketplaceCatalog(): Promise<MarketplaceCatalogResult> {
  const catalogUrl = pluginMarketplaceCatalogUrl();
  try {
    const payload = await fetchJsonLenient(catalogUrl);
    let plugins: unknown[] = [];
    let source: unknown = "clawhunt_server";
    if (payload && typeof payload === "object") {
      const record = payload as Record<string, unknown>;
      // Mirror the kernel's `payload.get("plugins", payload.get("items", []))`: select
      // by KEY PRESENCE (not array-ness) — `items` is consulted ONLY when `plugins` is
      // absent — then coerce a non-list to []. Pass elements through verbatim.
      let raw: unknown = [];
      if (Object.prototype.hasOwnProperty.call(record, "plugins")) raw = record.plugins;
      else if (Object.prototype.hasOwnProperty.call(record, "items")) raw = record.items;
      plugins = Array.isArray(raw) ? raw : [];
      // Forward the feed's own source verbatim (kernel does not type-check it).
      if (Object.prototype.hasOwnProperty.call(record, "source")) source = record.source;
    }
    return { source, catalog_url: catalogUrl, total: plugins.length, plugins, error: null };
  } catch (err) {
    return { source: "unavailable", catalog_url: catalogUrl, total: 0, plugins: [], error: errorMessage(err) };
  }
}
