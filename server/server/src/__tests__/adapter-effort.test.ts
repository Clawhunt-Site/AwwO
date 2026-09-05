import { describe, it, expect } from "vitest";
import {
  adapterSupportsEffort,
  thinkingEffortOptionsFor,
  thinkingEffortKeyFor,
  applyEffortToAdapterConfig,
} from "../services/adapter-effort.js";

describe("adapterSupportsEffort — only adapters with a native effort axis", () => {
  it("true for codex/claude/opencode, false for grok/gemini/cursor/unknown", () => {
    expect(adapterSupportsEffort("codex_local")).toBe(true);
    expect(adapterSupportsEffort("claude_local")).toBe(true);
    expect(adapterSupportsEffort("opencode_local")).toBe(true);
    // grok is NOT effort-capable: no Grok model honors a reasoning-effort
    // selection (kernel GrokCliBackend.supports_effort = False).
    expect(adapterSupportsEffort("grok_local")).toBe(false);
    expect(adapterSupportsEffort("gemini_local")).toBe(false);
    expect(adapterSupportsEffort("cursor")).toBe(false);
    expect(adapterSupportsEffort(null)).toBe(false);
  });
});

describe("thinkingEffortKeyFor — runtime-specific config key", () => {
  it("maps each adapter to its real config key", () => {
    expect(thinkingEffortKeyFor("codex_local")).toBe("modelReasoningEffort");
    expect(thinkingEffortKeyFor("opencode_local")).toBe("variant");
    expect(thinkingEffortKeyFor("claude_local")).toBe("effort");
  });
});

describe("thinkingEffortOptionsFor — per-adapter levels, [] when unsupported", () => {
  it("codex has 6 levels incl. minimal+xhigh", () => {
    const opts = thinkingEffortOptionsFor("codex_local").map((o) => o.value);
    expect(opts).toEqual(["", "minimal", "low", "medium", "high", "xhigh"]);
  });
  it("claude has 6 levels incl. xhigh+max (mirrors the real `claude --effort` choices)", () => {
    expect(thinkingEffortOptionsFor("claude_local").map((o) => o.value)).toEqual([
      "",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });
  it("opencode adds max", () => {
    expect(thinkingEffortOptionsFor("opencode_local").map((o) => o.value)).toContain("max");
  });
  it("unsupported adapters get no options (don't offer a rejected control)", () => {
    expect(thinkingEffortOptionsFor("gemini_local")).toEqual([]);
    // grok has an --effort flag but no model honors it → no options offered.
    expect(thinkingEffortOptionsFor("grok_local")).toEqual([]);
  });
});

describe("applyEffortToAdapterConfig — projects per-turn effort onto the right key", () => {
  it("codex effort → modelReasoningEffort", () => {
    expect(applyEffortToAdapterConfig("codex_local", { model: "gpt-5.5" }, "xhigh")).toEqual({
      model: "gpt-5.5",
      modelReasoningEffort: "xhigh",
    });
  });
  it("claude effort → effort", () => {
    expect(applyEffortToAdapterConfig("claude_local", {}, "high")).toEqual({ effort: "high" });
  });
  it("claude accepts the real CLI's top levels (xhigh/max), not just low/medium/high", () => {
    expect(applyEffortToAdapterConfig("claude_local", {}, "xhigh")).toEqual({ effort: "xhigh" });
    expect(applyEffortToAdapterConfig("claude_local", {}, "max")).toEqual({ effort: "max" });
  });
  it("opencode effort → variant", () => {
    expect(applyEffortToAdapterConfig("opencode_local", {}, "max")).toEqual({ variant: "max" });
  });
  it("blank effort clears the key (fall back to runtime default)", () => {
    expect(applyEffortToAdapterConfig("codex_local", { modelReasoningEffort: "high", model: "x" }, "")).toEqual({
      model: "x",
    });
  });
  it("fail-closed: an out-of-range effort is dropped (not written), not passed to the CLI", () => {
    // codex has no "max" level (opencode does) — must NOT write a value the runtime rejects.
    expect(applyEffortToAdapterConfig("codex_local", { modelReasoningEffort: "high" }, "max")).toEqual({});
  });
  it("no-op for adapters without an effort axis (gemini, grok)", () => {
    expect(applyEffortToAdapterConfig("gemini_local", { model: "g" }, "high")).toEqual({ model: "g" });
    // grok is not effort-capable — any effort is ignored, the config is untouched.
    expect(applyEffortToAdapterConfig("grok_local", { model: "grok-4" }, "high")).toEqual({ model: "grok-4" });
  });
});
