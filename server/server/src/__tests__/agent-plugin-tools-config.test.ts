import { describe, expect, it } from "vitest";
import { assertPluginToolsConfigValid } from "../services/agents.ts";

// assertPluginToolsConfigValid is the single persistence-boundary guard wired
// into agentService.create + update, so EVERY write path (HTTP routes,
// plugin-managed-agent declarations, company-as-code import) enforces the typed
// pluginTools opt-in — a typo cannot silently land via a non-route path.
describe("assertPluginToolsConfigValid (agent persistence boundary)", () => {
  it("accepts a valid enabled flag", () => {
    expect(() => assertPluginToolsConfigValid({ pluginTools: { enabled: true } })).not.toThrow();
    expect(() => assertPluginToolsConfigValid({ pluginTools: { enabled: false } })).not.toThrow();
  });

  it("is a no-op when pluginTools is absent", () => {
    expect(() => assertPluginToolsConfigValid({ heartbeat: { enabled: true } })).not.toThrow();
    expect(() => assertPluginToolsConfigValid({})).not.toThrow();
    expect(() => assertPluginToolsConfigValid(undefined)).not.toThrow();
    expect(() => assertPluginToolsConfigValid(null)).not.toThrow();
  });

  it("rejects a non-boolean enabled (no truthy coercion through any write path)", () => {
    expect(() => assertPluginToolsConfigValid({ pluginTools: { enabled: "yes" } })).toThrow();
    expect(() => assertPluginToolsConfigValid({ pluginTools: { enabled: 1 } })).toThrow();
  });

  it("rejects a misspelled key inside pluginTools (cannot silently never enable)", () => {
    expect(() => assertPluginToolsConfigValid({ pluginTools: { enable: true } })).toThrow();
  });

  it("rejects a non-object pluginTools", () => {
    expect(() => assertPluginToolsConfigValid({ pluginTools: true })).toThrow();
  });
});
