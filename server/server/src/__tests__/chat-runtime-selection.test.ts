import { describe, it, expect } from "vitest";
import {
  resolveChatRuntime,
  stickyChatRuntime,
  applyChatRuntime,
  chatRuntimeToMetadata,
  REQUEST_CLEAR,
} from "../services/chat-runtime-selection.js";

const sticky = (backend?: string, model?: string, effort?: string) => ({
  runtime: {
    ...(backend ? { backend } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  },
});

describe("resolveChatRuntime — request > sticky > default", () => {
  it("falls back to default backend with no model/effort when nothing sticky/requested", () => {
    const sel = resolveChatRuntime(null, { defaultBackend: "claude" });
    expect(sel.backend).toBe("claude");
    expect(sel.model).toBeNull();
    expect(sel.effort).toBeNull();
    expect(sel.backendSwitched).toBe(false);
    expect(sel.handoffNote).toBeNull();
  });

  it("applies the sticky runtime when nothing requested", () => {
    const sel = resolveChatRuntime(sticky("codex", "gpt-5.5", "high"));
    expect(sel.backend).toBe("codex");
    expect(sel.model).toBe("gpt-5.5");
    expect(sel.effort).toBe("high");
    expect(sel.backendSwitched).toBe(false);
  });

  it("an explicit per-turn request wins over sticky", () => {
    const sel = resolveChatRuntime(sticky("codex", "gpt-5.5", "high"), {
      requestedModel: "gpt-5.4",
      requestedEffort: "low",
    });
    expect(sel.backend).toBe("codex");
    expect(sel.model).toBe("gpt-5.4");
    expect(sel.effort).toBe("low");
  });
});

describe("backend switch drops model + effort (runtime-specific, not portable)", () => {
  it("drops sticky model AND effort on a switch when not explicitly re-requested", () => {
    const sel = resolveChatRuntime(sticky("codex", "gpt-5.5", "high"), {
      requestedBackend: "claude",
    });
    expect(sel.backend).toBe("claude");
    expect(sel.backendSwitched).toBe(true);
    expect(sel.model).toBeNull();
    expect(sel.effort).toBeNull();
    expect(sel.previousBackend).toBe("codex");
    expect(sel.previousModel).toBe("gpt-5.5");
    expect(sel.previousEffort).toBe("high");
  });

  it("keeps explicitly-requested model/effort across a switch", () => {
    const sel = resolveChatRuntime(sticky("codex", "gpt-5.5", "high"), {
      requestedBackend: "claude",
      requestedModel: "claude-opus-4-8",
      requestedEffort: "medium",
    });
    expect(sel.backend).toBe("claude");
    expect(sel.backendSwitched).toBe(true);
    expect(sel.model).toBe("claude-opus-4-8");
    expect(sel.effort).toBe("medium");
  });

  it("emits a handoffNote only on a switch", () => {
    const switched = resolveChatRuntime(sticky("codex", "gpt-5.5"), { requestedBackend: "claude" });
    expect(switched.handoffNote).toContain("codex → claude");
    expect(switched.handoffNote).toContain("fresh native session");

    const same = resolveChatRuntime(sticky("codex", "gpt-5.5"), { requestedBackend: "codex" });
    expect(same.backendSwitched).toBe(false);
    expect(same.handoffNote).toBeNull();
  });
});

describe("REQUEST_CLEAR ('') vs undefined (not requested)", () => {
  it("'' explicitly clears the sticky model/effort", () => {
    const sel = resolveChatRuntime(sticky("codex", "gpt-5.5", "high"), {
      requestedModel: REQUEST_CLEAR,
      requestedEffort: REQUEST_CLEAR,
    });
    expect(sel.backend).toBe("codex");
    expect(sel.model).toBeNull();
    expect(sel.effort).toBeNull();
    expect(sel.backendSwitched).toBe(false);
  });

  it("undefined preserves the sticky model/effort (nothing requested)", () => {
    const sel = resolveChatRuntime(sticky("codex", "gpt-5.5", "high"), {});
    expect(sel.model).toBe("gpt-5.5");
    expect(sel.effort).toBe("high");
  });
});

describe("stickyChatRuntime / metadata round-trip", () => {
  it("ignores blank/non-string sticky fields", () => {
    expect(stickyChatRuntime({ runtime: { backend: "  ", model: 5 } })).toEqual({
      backend: null,
      model: null,
      effort: null,
    });
  });

  it("chatRuntimeToMetadata omits null model/effort", () => {
    const sel = resolveChatRuntime(null, { requestedBackend: "claude" });
    expect(chatRuntimeToMetadata(sel)).toEqual({ backend: "claude" });
  });
});

describe("applyChatRuntime — sticky persistence into executionState", () => {
  it("writes runtime and reports changed", () => {
    const sel = resolveChatRuntime(null, { requestedBackend: "codex", requestedModel: "gpt-5.5" });
    const { executionState, changed } = applyChatRuntime({ other: 1 }, sel);
    expect(changed).toBe(true);
    expect(executionState).toEqual({ other: 1, runtime: { backend: "codex", model: "gpt-5.5" } });
  });

  it("is idempotent when the stored runtime already matches", () => {
    const sel = resolveChatRuntime(sticky("codex", "gpt-5.5"));
    const { changed } = applyChatRuntime({ runtime: { backend: "codex", model: "gpt-5.5" } }, sel);
    expect(changed).toBe(false);
  });
});
