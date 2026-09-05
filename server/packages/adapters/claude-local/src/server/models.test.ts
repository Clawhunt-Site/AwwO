import { describe, it, expect } from "vitest";
import { resolveConfiguredModel } from "./models.js";
import { models as DIRECT_MODELS } from "../index.js";

describe("resolveConfiguredModel — kernel default materialization", () => {
  it("returns an explicit model unchanged (never overrides a real choice)", () => {
    expect(resolveConfiguredModel("claude-opus-4-7")).toBe("claude-opus-4-7");
    // A modelProfile like "cheap" merges { model: "claude-sonnet-4-6" } — must survive.
    expect(resolveConfiguredModel("claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
  });

  it("materializes the contract baked default (models[0]) when the merged model is blank", () => {
    const baked = DIRECT_MODELS[0]?.id ?? "";
    // Guards the contract default the composer shows as default_model.
    expect(baked).toBe("claude-opus-4-8");
    // The exact bug: a blank final model previously omitted --model and let the
    // local claude CLI fall back to ~/.claude/settings.json (e.g. haiku).
    expect(resolveConfiguredModel("")).toBe(baked);
    expect(resolveConfiguredModel("   ")).toBe(baked);
  });

  it("trims surrounding whitespace on an explicit model", () => {
    expect(resolveConfiguredModel("  claude-opus-4-7  ")).toBe("claude-opus-4-7");
  });
});
