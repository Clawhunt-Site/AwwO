import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  fetchMarketplaceCatalog,
  fetchWorkshopCatalog,
  mapCapabilityEntryToMarketplace,
} from "../services/workshop-catalog.js";

const golden = JSON.parse(
  readFileSync(new URL("./fixtures/trust-golden-vectors.json", import.meta.url), "utf-8"),
) as { cosign: Array<{ name: string; entry: Record<string, unknown> }> };

const cosignEntry = golden.cosign.find((v) => v.name === "valid_required_only")!.entry;

// Both catalog fetchers read response.text() (workshop parses strictly via
// parseTrustJson; marketplace JSON.parses the text), so stub text().
function okResponse(body: unknown) {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) } as unknown as Response;
}

function rawResponse(text: string) {
  return { ok: true, status: 200, text: async () => text } as unknown as Response;
}

const SAVED = { ...process.env };

beforeEach(() => {
  process.env.APP_ENV = "staging";
  process.env.SUPERCLAW_CAPABILITY_WORKSHOP_CATALOG_URL = "http://test/feed";
  process.env.SUPERCLAW_PLUGIN_MARKETPLACE_CATALOG_URL = "http://test/mkt";
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.env = { ...SAVED };
});

describe("mapCapabilityEntryToMarketplace", () => {
  it("lights the official badge ONLY when officialVerified is true", () => {
    expect(mapCapabilityEntryToMarketplace({ kind: "plugin", capability_id: "a" }, true).trust).toBe("official");
    expect(mapCapabilityEntryToMarketplace({ kind: "plugin", capability_id: "a" }, false).trust).toBeNull();
    // Default fail-closed: no flag → no badge, regardless of self-reported feed fields.
    expect(
      mapCapabilityEntryToMarketplace({ kind: "plugin", capability_id: "a", trust: "official", verified: true }).trust,
    ).toBeNull();
  });

  it("defaults kind to plugin and builds the localized + derived shape", () => {
    const out = mapCapabilityEntryToMarketplace({ capability_id: "dev.x", name: "Tool", summary: "S" });
    expect(out.kind).toBe("plugin");
    expect(out.name).toEqual({ en: "Tool", zh: "Tool" });
    expect(out.summary).toEqual({ en: "S", zh: "S" });
    expect(out.category_label).toEqual({ en: "Plugin", zh: "插件" });
    expect(out.icon).toBe("runtime");
    expect(out.instantiable).toBe(true);
    expect(out.skill_origin).toBe(false);
  });

  it("marks companies non-instantiable and skills skill_origin", () => {
    expect(mapCapabilityEntryToMarketplace({ kind: "company", capability_id: "c" }).instantiable).toBe(false);
    expect(mapCapabilityEntryToMarketplace({ kind: "skill", capability_id: "s" }).skill_origin).toBe(true);
  });

  it("degrades gracefully (never throws) on non-string identity fields in a malformed feed", () => {
    const out = mapCapabilityEntryToMarketplace({ kind: [], capability_id: {}, plugin_id: 7 });
    expect(out.kind).toBe("plugin"); // non-string kind → fallback (not String([]) === "")
    expect(out.plugin_id).toBe(""); // non-string capability_id/plugin_id → ""
    expect(out.category_label).toEqual({ en: "Plugin", zh: "插件" });
    expect(out.skill_origin).toBe(false);
  });

  it("uses Python truthiness for feed booleans/or (empty [] / {} are falsy, unlike JS)", () => {
    const out = mapCapabilityEntryToMarketplace({
      kind: "plugin",
      capability_id: "a",
      verified: [],
      signature_verified: {},
      entitlement_required: [],
      runtime: [],
      pricing_model: {},
    });
    expect(out.verified).toBe(false); // Boolean([]) would be true in JS
    expect(out.signature_verified).toBe(false);
    expect(out.entitlement_required).toBe(false);
    expect(out.runtime).toBe("plugin"); // empty array → falls back to kind
    expect(out.pricing_model).toBe("free");
  });

  it("reads OWN properties only — inherited feed fields are not projected", () => {
    const inherited = Object.create({ kind: "skill", capability_id: "inherited" }) as Record<string, unknown>;
    const out = mapCapabilityEntryToMarketplace(inherited);
    expect(out.kind).toBe("plugin"); // not "skill" from the prototype
    expect(out.plugin_id).toBe("");
  });
});

describe("fetchWorkshopCatalog", () => {
  it("projects the feed entries and fails the official badge closed against the baked key", async () => {
    // cosignEntry is signed by a TEST key, not the baked staging key → trust must be null.
    vi.stubGlobal("fetch", vi.fn(async () => okResponse({ entries: [cosignEntry] })));
    const result = await fetchWorkshopCatalog();
    expect(result.source).toBe("clawhunt_workshop");
    expect(result.catalog_url).toBe("http://test/feed");
    expect(result.total).toBe(1);
    const first = result.plugins[0] as Record<string, unknown>;
    expect(first.plugin_id).toBe(cosignEntry.capability_id);
    expect(first.trust).toBeNull();
    expect(result.error).toBeNull();
  });

  it("passes ?kind through to the feed request", async () => {
    const fetchMock = vi.fn(async () => okResponse({ entries: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await fetchWorkshopCatalog("skill");
    expect(fetchMock).toHaveBeenCalledWith("http://test/feed?kind=skill", expect.anything());
  });

  it("appends ?kind to an override URL that already carries a query", async () => {
    process.env.SUPERCLAW_CAPABILITY_WORKSHOP_CATALOG_URL = "http://test/feed?x=1";
    const fetchMock = vi.fn(async () => okResponse({ entries: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await fetchWorkshopCatalog("skill");
    expect(fetchMock).toHaveBeenCalledWith("http://test/feed?x=1&kind=skill", expect.anything());
  });

  it("returns unavailable (not a 500) when the override URL is malformed and a kind is given", async () => {
    process.env.SUPERCLAW_CAPABILITY_WORKSHOP_CATALOG_URL = "not a url";
    vi.stubGlobal("fetch", vi.fn(async () => okResponse({ entries: [] })));
    const result = await fetchWorkshopCatalog("skill");
    expect(result.source).toBe("unavailable");
  });

  it("returns unavailable (never throws) on a feed failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503 }) as unknown as Response));
    const result = await fetchWorkshopCatalog();
    expect(result.source).toBe("unavailable");
    expect(result.total).toBe(0);
    expect(result.plugins).toEqual([]);
    expect(result.error).toContain("503");
  });

  it("ignores non-object entries in the feed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okResponse({ entries: [null, 7, "x", { kind: "plugin", capability_id: "ok" }] })));
    const result = await fetchWorkshopCatalog();
    expect(result.total).toBe(1);
    expect((result.plugins[0] as Record<string, unknown>).plugin_id).toBe("ok");
  });

  it("fails the feed CLOSED on a float number literal (parity: kernel rejects float length)", async () => {
    // Raw text with a float `length` — JSON.parse would collapse 4096.0 → 4096 and
    // mint a spurious official badge; parseTrustJson must reject the feed instead.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => rawResponse('{"entries":[{"kind":"plugin","capability_id":"x","length":4096.0}]}')),
    );
    const result = await fetchWorkshopCatalog();
    expect(result.source).toBe("unavailable");
    expect(result.plugins).toEqual([]);
  });
});

describe("fetchMarketplaceCatalog", () => {
  it("passes plugins through and echoes the feed source", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okResponse({ source: "clawhunt_server", plugins: [{ plugin_id: "p1" }] })));
    const result = await fetchMarketplaceCatalog();
    expect(result.source).toBe("clawhunt_server");
    expect(result.catalog_url).toBe("http://test/mkt");
    expect(result.total).toBe(1);
    expect((result.plugins[0] as Record<string, unknown>).plugin_id).toBe("p1");
  });

  it("passes non-object marketplace entries through verbatim (no filtering)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okResponse({ plugins: [null, 7, { plugin_id: "p1" }] })));
    const result = await fetchMarketplaceCatalog();
    expect(result.total).toBe(3);
    expect(result.plugins[0]).toBeNull();
    expect(result.plugins[1]).toBe(7);
  });

  it("consults items[] ONLY when the plugins key is absent", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okResponse({ items: [{ plugin_id: "i1" }, { plugin_id: "i2" }] })));
    const result = await fetchMarketplaceCatalog();
    expect(result.total).toBe(2);
    expect(result.source).toBe("clawhunt_server");
  });

  it("returns [] when plugins is present but not a list (does NOT fall through to items)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okResponse({ plugins: {}, items: [{ plugin_id: "i1" }] })));
    const result = await fetchMarketplaceCatalog();
    expect(result.total).toBe(0);
    expect(result.plugins).toEqual([]);
  });

  it("returns unavailable on a network error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }));
    const result = await fetchMarketplaceCatalog();
    expect(result.source).toBe("unavailable");
    expect(result.error).toContain("ECONNREFUSED");
  });
});
