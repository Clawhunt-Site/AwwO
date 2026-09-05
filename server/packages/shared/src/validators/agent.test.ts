import { describe, expect, it } from "vitest";
import { agentRuntimeConfigSchema } from "./agent.js";

describe("agentRuntimeConfigSchema — pluginTools opt-in", () => {
  it("accepts the persistent plugin-bridge opt-in flag", () => {
    const parsed = agentRuntimeConfigSchema.parse({ pluginTools: { enabled: true } });
    expect(parsed.pluginTools).toEqual({ enabled: true });
  });

  it("accepts an absent pluginTools block", () => {
    expect(agentRuntimeConfigSchema.parse({})).toEqual({});
  });

  it("rejects a non-boolean enabled (no silent truthy coercion)", () => {
    expect(() => agentRuntimeConfigSchema.parse({ pluginTools: { enabled: "yes" } })).toThrow();
  });

  it("rejects an unknown key inside pluginTools (typo cannot silently no-op)", () => {
    expect(() => agentRuntimeConfigSchema.parse({ pluginTools: { enable: true } })).toThrow();
  });

  it("still allows unrelated runtimeConfig keys via the catchall", () => {
    const parsed = agentRuntimeConfigSchema.parse({
      pluginTools: { enabled: false },
      heartbeat: { enabled: true },
    });
    expect(parsed.pluginTools).toEqual({ enabled: false });
    expect((parsed as Record<string, unknown>).heartbeat).toEqual({ enabled: true });
  });
});
