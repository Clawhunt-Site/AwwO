import type { AdapterModel } from "@paperclipai/adapter-utils";

/**
 * SuperClaw relay package tiers -> relay group slug. The SINGLE source of truth
 * for these slugs is the Python kernel (relay_packages.py
 * SUPERCLAW_RELAY_GROUP_SLUGS); they are contract constants the relay routes on,
 * not arbitrary model names. Mirrored here (not derived) only because the adapter
 * is a separate Node process; keep in lockstep with the kernel.
 */
export const RELAY_GROUP_SLUGS: Record<string, string> = {
  core: "superclaw-core",
  plus: "superclaw-plus",
  max: "superclaw-max",
};

/** Default tier when an agent config carries no model (the base relay tier). */
export const DEFAULT_RELAY_TIER = "core";

export const CLAWWORK_MODELS: AdapterModel[] = [
  { id: "core", label: "ClawWork: core" },
  { id: "plus", label: "ClawWork: plus" },
  { id: "max", label: "ClawWork: max" },
];

export function listClawworkModels(): AdapterModel[] {
  return [...CLAWWORK_MODELS];
}

/**
 * Translate a selected relay package tier into the relay group slug to route on.
 * Mirrors the static portion of the Python ClawWorkBackend._translate_relay_package_model:
 *
 *  - empty -> the base tier's slug (the documented "use the relay default").
 *  - a known tier (core/plus/max) -> its group slug.
 *  - an already-resolved `superclaw-*` slug -> passed through verbatim.
 *  - anything else -> passed through verbatim (a raw override).
 *
 * The dynamic catalog lookup the Python kernel does for unknown package ids is a
 * follow-up; v1 stays network-free.
 */
export function translateRelayPackageModel(model: string | null | undefined): string {
  const value = (model ?? "").trim();
  if (!value) return RELAY_GROUP_SLUGS[DEFAULT_RELAY_TIER];
  const lower = value.toLowerCase();
  if (RELAY_GROUP_SLUGS[lower]) return RELAY_GROUP_SLUGS[lower];
  return value;
}
