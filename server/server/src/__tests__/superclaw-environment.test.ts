import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appEnvironment,
  capabilityWorkshopCatalogUrl,
  clawhuntBaseUrl,
  officialRootPublicKey,
  pluginMarketplaceCatalogUrl,
} from "../superclaw-environment.js";

const SAVED = { ...process.env };

beforeEach(() => {
  delete process.env.APP_ENV;
  delete process.env.SUPERCLAW_BAKED_APP_ENV;
  delete process.env.CLAWHUNT_BASE_URL;
  delete process.env.SUPERCLAW_CAPABILITY_WORKSHOP_CATALOG_URL;
  delete process.env.SUPERCLAW_PLUGIN_MARKETPLACE_CATALOG_URL;
});

afterEach(() => {
  process.env = { ...SAVED };
});

describe("appEnvironment", () => {
  it("defaults to staging (never production by default)", () => {
    expect(appEnvironment("")).toBe("staging");
    expect(appEnvironment(null)).toBe("staging");
  });

  it("folds legacy/shorthand aliases to staging, prod → production", () => {
    for (const dev of ["development", "dev", "local", "test", "stage", "DEV"]) {
      expect(appEnvironment(dev)).toBe("staging");
    }
    expect(appEnvironment("prod")).toBe("production");
    expect(appEnvironment("PRODUCTION")).toBe("production");
  });

  it("throws on an unknown value", () => {
    expect(() => appEnvironment("bogus")).toThrow();
  });

  it("resists Object.prototype pollution of APP_ENV / baked env (own-read, not inherited)", () => {
    delete process.env.APP_ENV; // genuinely absent
    delete process.env.SUPERCLAW_BAKED_APP_ENV;
    const proto = Object.prototype as unknown as Record<string, unknown>;
    try {
      proto.APP_ENV = "production";
      proto.SUPERCLAW_BAKED_APP_ENV = "production";
      // Must NOT read the inherited values → resolves to the staging default.
      expect(appEnvironment()).toBe("staging");
    } finally {
      delete proto.APP_ENV;
      delete proto.SUPERCLAW_BAKED_APP_ENV;
    }
  });

  it("resists constant-table (alias/key/url) prototype pollution — no env remap", () => {
    const proto = Object.prototype as unknown as Record<string, unknown>;
    try {
      proto.staging = "production"; // would remap the canonical alias lookup
      proto.production = "staging";
      expect(appEnvironment("staging")).toBe("staging");
      expect(appEnvironment("production")).toBe("production");
      process.env.APP_ENV = "staging";
      // officialRootPublicKey / clawhuntBaseUrl must still resolve to the STAGING values.
      expect(clawhuntBaseUrl()).toBe("https://staging.clawhunt.store");
      const stagingKey = officialRootPublicKey();
      process.env.APP_ENV = "production";
      expect(officialRootPublicKey()).not.toBe(stagingKey); // not collapsed/remapped
    } finally {
      delete proto.staging;
      delete proto.production;
    }
  });

  it("resolves APP_ENV > baked > default when no explicit arg is given", () => {
    expect(appEnvironment()).toBe("staging"); // neither set → default
    process.env.SUPERCLAW_BAKED_APP_ENV = "production";
    expect(appEnvironment()).toBe("production"); // baked fallback (no APP_ENV)
    process.env.APP_ENV = "staging";
    expect(appEnvironment()).toBe("staging"); // explicit APP_ENV wins over baked
  });
});

describe("officialRootPublicKey", () => {
  it("returns a distinct baked key per environment (isolation)", () => {
    process.env.APP_ENV = "staging";
    const staging = officialRootPublicKey();
    process.env.APP_ENV = "production";
    const production = officialRootPublicKey();
    expect(staging).toBeTruthy();
    expect(production).toBeTruthy();
    expect(staging).not.toBe(production);
  });
});

describe("clawhuntBaseUrl + production-contamination guard", () => {
  it("resolves the per-environment default", () => {
    process.env.APP_ENV = "staging";
    expect(clawhuntBaseUrl()).toBe("https://staging.clawhunt.store");
    process.env.APP_ENV = "production";
    expect(clawhuntBaseUrl()).toBe("https://clawhunt.store");
  });

  it("honours an explicit override (trailing slash stripped)", () => {
    process.env.APP_ENV = "staging";
    process.env.CLAWHUNT_BASE_URL = "http://127.0.0.1:8787/";
    expect(clawhuntBaseUrl()).toBe("http://127.0.0.1:8787");
  });

  it("refuses staging → production host (even via trailing slash / extra path)", () => {
    process.env.APP_ENV = "staging";
    for (const poisoned of ["https://clawhunt.store", "https://clawhunt.store/", "https://clawhunt.store/api"]) {
      process.env.CLAWHUNT_BASE_URL = poisoned;
      expect(() => clawhuntBaseUrl(), poisoned).toThrow(/contamination/);
    }
  });

  it("allows the production host when APP_ENV=production (no staging-baked identity)", () => {
    process.env.APP_ENV = "production";
    process.env.CLAWHUNT_BASE_URL = "https://clawhunt.store/";
    expect(clawhuntBaseUrl()).toBe("https://clawhunt.store");
  });

  it("refuses a staging-BAKED build flipped to production via APP_ENV (build-identity vector)", () => {
    process.env.SUPERCLAW_BAKED_APP_ENV = "staging";
    process.env.APP_ENV = "production"; // stale override flipping a staging build
    process.env.CLAWHUNT_BASE_URL = "https://clawhunt.store";
    expect(() => clawhuntBaseUrl()).toThrow(/contamination/);
  });

  it("allows production for a production-baked build", () => {
    process.env.SUPERCLAW_BAKED_APP_ENV = "production";
    process.env.APP_ENV = "production";
    expect(clawhuntBaseUrl()).toBe("https://clawhunt.store");
  });
});

describe("catalog URLs", () => {
  it("derive from the ClawHunt base URL by default", () => {
    process.env.APP_ENV = "staging";
    expect(capabilityWorkshopCatalogUrl()).toBe("https://staging.clawhunt.store/v1/capabilities/published");
    expect(pluginMarketplaceCatalogUrl()).toBe("https://staging.clawhunt.store/api/plugins/marketplace-catalog");
  });

  it("honour explicit overrides", () => {
    process.env.SUPERCLAW_CAPABILITY_WORKSHOP_CATALOG_URL = "http://test/feed";
    process.env.SUPERCLAW_PLUGIN_MARKETPLACE_CATALOG_URL = "http://test/mkt";
    expect(capabilityWorkshopCatalogUrl()).toBe("http://test/feed");
    expect(pluginMarketplaceCatalogUrl()).toBe("http://test/mkt");
  });
});
