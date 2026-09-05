/**
 * Permission mode framework — faithful Node port of
 * packages/superclaw/src/superclaw/permissions.py.
 *
 * Design rule (unchanged from Python):
 * - SuperClaw exposes exactly TWO presets to users: `ask` and `allow`.
 * - SuperClaw makes NO per-action decisions of its own — it is a pass-through
 *   that translates a preset into whatever the underlying runtime supports.
 * - Both presets map to the runtime's MAXIMUM ("bypassPermissions"). `ask` must
 *   NOT claim to prompt/restrict — that would be surface fraud (permissions.py:41).
 * - No decision engine, no action taxonomy, no third preset. Those were
 *   considered and rejected as over-engineering (permission-broker-plan.md).
 *
 * This module deliberately stays tiny and behavior-preserving.
 */

import { COMPANY_TOOL_NAMES, MARKETPLACE_WRITE_TOOL_NAMES } from "./command-vocabulary.js";

/** The two user-facing states. The ONLY permission concept surfaces see. */
export type PermissionPreset = "ask" | "allow";

// Frozen, mirroring the Python `frozenset` (permissions.py:38) so the required
// set cannot be mutated at runtime to weaken the conformance check.
export const REQUIRED_PRESETS: readonly PermissionPreset[] = Object.freeze(["ask", "allow"]) as readonly PermissionPreset[];

/**
 * Titles are HONEST about current behavior: under the max-permission doctrine
 * both presets run at max, so "ask" must NOT claim to prompt/restrict.
 */
export const PRESET_LABELS: Record<PermissionPreset, { label_key: string; title: string }> = {
  ask: { label_key: "perm.preset.ask", title: "Standard (max today)" },
  allow: { label_key: "perm.preset.allow", title: "Allow all actions" },
};

/**
 * Each preset selects one canonical mode. Owner doctrine (2026-06-22): the
 * underlying runtime is a pure EXECUTION ENGINE always handed its MAXIMUM
 * permission. So BOTH presets map to `bypassPermissions` (permissions.py:81).
 */
export const PRESET_TO_MODE: Record<PermissionPreset, string> = {
  ask: "bypassPermissions",
  allow: "bypassPermissions",
};

export class PresetMapError extends Error {}

/** How a single backend realizes one preset (permissions.py:90). */
export interface PresetRealization {
  /** Human-readable description of the backend-native setting this maps to. */
  readonly native: string;
  /** Does a HUMAN actually get prompted per-action under this preset? Today
   *  this is false everywhere — no human ever sees a prompt. */
  readonly interactive: boolean;
  /** i18n key for an honest, surface-rendered explanation. */
  readonly note_key: string;
  /** Does switching the preset actually change this runtime's behavior? */
  readonly preset_driven: boolean;
}

export type PresetMap = Record<PermissionPreset, PresetRealization>;

/**
 * Construct a PresetRealization with the Python dataclass defaults
 * (preset_driven defaults to true, permissions.py:112). Using this factory keeps
 * the field set complete and uniform — TS interfaces alone do not enforce it.
 */
export function presetRealization(args: {
  native: string;
  interactive: boolean;
  note_key: string;
  preset_driven?: boolean;
}): PresetRealization {
  return {
    native: args.native,
    interactive: args.interactive,
    note_key: args.note_key,
    preset_driven: args.preset_driven ?? true,
  };
}

/** Build a PresetMap so the two-state shape is uniform (permissions.py:122). */
export function makePresets(args: { ask: PresetRealization; allow: PresetRealization }): PresetMap {
  return { ask: args.ask, allow: args.allow };
}

/**
 * Validate a backend's declaration. Throws PresetMapError on any gap — this is
 * the enforcement that makes declaring the mapping a hard requirement for every
 * new backend, and that keeps the preset set at exactly two (no third tier).
 */
export function checkPresetMap(backendName: string, presets: PresetMap): void {
  const keys = new Set(Object.keys(presets));
  const required = new Set<string>(REQUIRED_PRESETS);
  const missing = [...required].filter((k) => !keys.has(k));
  const extra = [...keys].filter((k) => !required.has(k));
  if (missing.length > 0 || extra.length > 0) {
    throw new PresetMapError(
      `backend ${JSON.stringify(backendName)} permission presets must declare exactly ` +
        `${[...REQUIRED_PRESETS].sort().join(", ")}; missing=${missing.sort().join(",")} extra=${extra.sort().join(",")}`,
    );
  }
  for (const preset of REQUIRED_PRESETS) {
    const realization = presets[preset];
    if (realization === null || typeof realization !== "object") {
      throw new PresetMapError(`backend ${JSON.stringify(backendName)} preset ${JSON.stringify(preset)} is not a PresetRealization`);
    }
    if (!(realization.native ?? "").trim()) {
      throw new PresetMapError(`backend ${JSON.stringify(backendName)} preset ${JSON.stringify(preset)} has empty 'native'`);
    }
    if (!(realization.note_key ?? "").trim()) {
      throw new PresetMapError(`backend ${JSON.stringify(backendName)} preset ${JSON.stringify(preset)} has empty 'note_key'`);
    }
    // The Python dataclass guarantees these fields exist and are typed; TS
    // interfaces do not, so validate them to keep parity (a missing/garbage
    // flag must not pass and then serialize as undefined).
    if (typeof realization.interactive !== "boolean") {
      throw new PresetMapError(`backend ${JSON.stringify(backendName)} preset ${JSON.stringify(preset)} 'interactive' must be a boolean`);
    }
    if (typeof realization.preset_driven !== "boolean") {
      throw new PresetMapError(`backend ${JSON.stringify(backendName)} preset ${JSON.stringify(preset)} 'preset_driven' must be a boolean`);
    }
  }
}

/**
 * Serialize a PresetMap for surfaces (permissions.py:151). Mirrors the Python
 * dict comprehension: iterate the INPUT map's entries and return a new object
 * of plain copies — preserving the input's keys, never aliasing the inputs.
 */
export function serializePresetMap(presets: PresetMap): Record<string, PresetRealization> {
  const out: Record<string, PresetRealization> = {};
  for (const [preset, realization] of Object.entries(presets)) {
    out[preset] = { ...realization };
  }
  return out;
}

// ---------------------------------------------------------------------------
// B-class (in-process self-owned) posture helper.
// Only `plan` tightens behavior; every other mode preserves today's behavior.
// ---------------------------------------------------------------------------
export type Posture = "readonly" | "workspace" | "full";

export function postureForMode(mode: string | null | undefined): Posture {
  if (mode === "plan") return "readonly";
  if (mode === "bypassPermissions" || mode === "dontAsk") return "full";
  // default / acceptEdits / auto / unknown -> current workspace behavior
  return "workspace";
}

// Base in-process tools, plus the company-management and marketplace WRITE tool
// names — mirroring permissions.py:191, where _MUTATING_TOOLS folds the kernel-
// state mutation vocabularies in by default so the read-only fence covers them
// by construction. The names come from the single command-vocabulary source
// (command-vocabulary.ts), cross-checked against Python to prevent drift.
export const BASE_MUTATING_TOOLS: readonly string[] = ["run_shell", "write_file", "delegate"] as const;
export const READONLY_TOOLS: readonly string[] = ["read_file", "list_files"] as const;

// Module-private and never aliased out: TS `ReadonlySet` is erased at runtime,
// so handing this object to callers would let them `.delete("company_create")`
// and silently weaken the gate. Python uses an immutable `frozenset`
// (permissions.py:191); we approximate it by keeping the set private and only
// ever returning fresh copies.
const MUTATING_TOOLS: Set<string> = new Set<string>([
  ...BASE_MUTATING_TOOLS,
  ...COMPANY_TOOL_NAMES,
  ...MARKETPLACE_WRITE_TOOL_NAMES,
]);

/** A fresh copy of the full mutating tool set denied under a read-only posture.
 *  Returns a copy so the gate's own set can never be mutated by a caller. */
export function mutatingTools(): ReadonlySet<string> {
  return new Set(MUTATING_TOOLS);
}

/**
 * True when the posture forbids this in-process tool (permissions.py:203).
 * Company/marketplace kernel mutations are covered by default. `extraMutatingTools`
 * is a forward-compat seam for tools registered by not-yet-ported domains.
 */
export function postureDeniesTool(
  posture: Posture,
  toolName: string,
  extraMutatingTools: Iterable<string> = [],
): boolean {
  if (posture !== "readonly") return false;
  if (MUTATING_TOOLS.has(toolName)) return true;
  for (const t of extraMutatingTools) if (t === toolName) return true;
  return false;
}

/** Top-level contract block exported to all surfaces (permissions.py:208). */
export function permissionModeContract(): {
  presets: PermissionPreset[];
  labels: typeof PRESET_LABELS;
  preset_to_mode: Record<PermissionPreset, string>;
} {
  return {
    presets: [...REQUIRED_PRESETS],
    labels: PRESET_LABELS,
    preset_to_mode: { ...PRESET_TO_MODE },
  };
}
