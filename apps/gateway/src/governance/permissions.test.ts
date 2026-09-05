import { describe, expect, it } from "vitest";
import {
  checkPresetMap,
  makePresets,
  mutatingTools,
  PRESET_LABELS,
  PRESET_TO_MODE,
  PresetMapError,
  permissionModeContract,
  presetRealization,
  postureDeniesTool,
  postureForMode,
  REQUIRED_PRESETS,
  serializePresetMap,
  type PresetMap,
  type PresetRealization,
} from "./permissions.js";
import { COMPANY_TOOL_NAMES, MARKETPLACE_WRITE_TOOL_NAMES } from "./command-vocabulary.js";

const realization = (over: Partial<PresetRealization> = {}): PresetRealization =>
  presetRealization({ native: "bypassPermissions", interactive: false, note_key: "perm.note.max", ...over });

describe("two-preset doctrine", () => {
  it("exposes exactly ask and allow", () => {
    expect([...REQUIRED_PRESETS].sort()).toEqual(["allow", "ask"]);
  });

  it("maps BOTH presets to bypassPermissions (runtime max)", () => {
    expect(PRESET_TO_MODE.ask).toBe("bypassPermissions");
    expect(PRESET_TO_MODE.allow).toBe("bypassPermissions");
  });

  it("keeps the ask label honest — it must not claim to prompt/restrict", () => {
    expect(PRESET_LABELS.ask.title.toLowerCase()).not.toMatch(/prompt|ask before|confirm|restrict/);
    expect(PRESET_TO_MODE.ask).toBe(PRESET_TO_MODE.allow);
  });

  it("exports a stable contract block", () => {
    const contract = permissionModeContract();
    expect(contract.presets.sort()).toEqual(["allow", "ask"]);
    expect(contract.preset_to_mode).toEqual({ ask: "bypassPermissions", allow: "bypassPermissions" });
  });
});

describe("presetRealization factory", () => {
  it("defaults preset_driven to true (dataclass parity)", () => {
    expect(presetRealization({ native: "x", interactive: false, note_key: "k" }).preset_driven).toBe(true);
  });
});

describe("checkPresetMap", () => {
  it("accepts a well-formed two-preset map", () => {
    const presets = makePresets({ ask: realization(), allow: realization() });
    expect(() => checkPresetMap("local", presets)).not.toThrow();
  });

  it("rejects a missing preset", () => {
    const presets = { ask: realization() } as unknown as PresetMap;
    expect(() => checkPresetMap("local", presets)).toThrow(PresetMapError);
  });

  it("rejects a third preset (no decision-engine tier may sneak in)", () => {
    const presets = {
      ask: realization(),
      allow: realization(),
      escalate: realization(),
    } as unknown as PresetMap;
    expect(() => checkPresetMap("local", presets)).toThrow(/exactly/);
  });

  it("rejects empty native or note_key", () => {
    expect(() =>
      checkPresetMap("local", makePresets({ ask: realization({ native: "  " }), allow: realization() })),
    ).toThrow(/empty 'native'/);
    expect(() =>
      checkPresetMap("local", makePresets({ ask: realization(), allow: realization({ note_key: "" }) })),
    ).toThrow(/empty 'note_key'/);
  });

  it("rejects a missing/garbage interactive or preset_driven flag", () => {
    const badInteractive = {
      ask: { native: "x", note_key: "k", preset_driven: true },
      allow: realization(),
    } as unknown as PresetMap;
    expect(() => checkPresetMap("local", badInteractive)).toThrow(/'interactive' must be a boolean/);
    const badDriven = {
      ask: { native: "x", interactive: false, note_key: "k" },
      allow: realization(),
    } as unknown as PresetMap;
    expect(() => checkPresetMap("local", badDriven)).toThrow(/'preset_driven' must be a boolean/);
  });
});

describe("serializePresetMap", () => {
  it("returns copies (never aliases the inputs)", () => {
    const ask = realization();
    const out = serializePresetMap(makePresets({ ask, allow: realization() }));
    expect(out.ask).toEqual(ask);
    expect(out.ask).not.toBe(ask);
  });

  it("preserves the input map's keys (mirrors the Python dict comprehension)", () => {
    const presets = { ask: realization(), allow: realization(), extra: realization() } as unknown as PresetMap;
    expect(Object.keys(serializePresetMap(presets)).sort()).toEqual(["allow", "ask", "extra"]);
  });
});

describe("postureForMode", () => {
  it("only plan tightens to readonly", () => {
    expect(postureForMode("plan")).toBe("readonly");
  });
  it("max modes map to full", () => {
    expect(postureForMode("bypassPermissions")).toBe("full");
    expect(postureForMode("dontAsk")).toBe("full");
  });
  it("everything else preserves workspace behavior", () => {
    for (const mode of ["acceptEdits", "auto", "default", "weird", null, undefined]) {
      expect(postureForMode(mode)).toBe("workspace");
    }
  });
});

describe("postureDeniesTool", () => {
  it("denies base + company + marketplace-write mutations under readonly by default", () => {
    for (const tool of ["run_shell", "write_file", "delegate", "company_create", "agent_hire", "issue_delegate", "marketplace_submit", "marketplace_accept_bid"]) {
      expect(postureDeniesTool("readonly", tool)).toBe(true);
      expect(postureDeniesTool("workspace", tool)).toBe(false);
      expect(postureDeniesTool("full", tool)).toBe(false);
    }
  });

  it("does NOT deny marketplace reads or file reads", () => {
    expect(postureDeniesTool("readonly", "marketplace_browse")).toBe(false);
    expect(postureDeniesTool("readonly", "marketplace_inspect")).toBe(false);
    expect(postureDeniesTool("readonly", "read_file")).toBe(false);
  });

  it("folds in forward-compat caller-supplied mutating names", () => {
    expect(postureDeniesTool("readonly", "future_tool", ["future_tool"])).toBe(true);
  });

  it("exposes the full mutating set including the kernel vocabularies", () => {
    const set = mutatingTools();
    for (const name of [...COMPANY_TOOL_NAMES, ...MARKETPLACE_WRITE_TOOL_NAMES]) {
      expect(set.has(name)).toBe(true);
    }
  });
});
