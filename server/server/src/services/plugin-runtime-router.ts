import type { Db } from "@paperclipai/db";

import {
  getSuperPluginRuntime,
  listSuperPluginRuntimes,
  type SuperPluginRuntimeRecord,
} from "./super-plugin-runtime-store.js";
import type { NormalizedToolResult } from "./super-mcp-runner.js";
import { getWorkshopProvenance, listWorkshopProvenance } from "./workshop-provenance.js";

/**
 * Dual plugin runtime router + unified read catalog (P5).
 *
 * Two physically-separate plugin stores back one logical surface: Paperclip's
 * native `plugins` table (JS workers) and SuperClaw's `super_plugin_runtimes`
 * (sidecar/external_mcp). The UI/API read ONLY {@link listUnifiedPlugins}; tool
 * execution routes ONLY through {@link executeTool}. Neither store impersonates
 * the other (a super plugin is never a JS worker, and vice-versa).
 *
 * The OFFICIAL badge comes SOLELY from `workshop_provenance` (a cosign-verified
 * receipt, S2b) joined by native id — never from a self-reported store flag — and
 * for super plugins is additionally gated on the package digest still matching
 * (so a sideloaded reuse of a workshop native id can never inherit the badge).
 */

export type PluginRuntimeKind = "paperclip_js" | "super";

/** What the catalog needs from Paperclip's native plugin registry (injected). */
export interface PaperclipPluginSummary {
  readonly pluginKey: string;
  readonly name: string;
  readonly version: string;
  readonly tools: readonly { name: string }[];
  readonly status: string;
}

/**
 * Live filesystem disposition of a super plugin's install dir, probed at list time.
 * - "present"      → the install dir exists and is a directory (the bytes are on disk).
 * - "absent"       → the install dir is gone (ENOENT) — a deleted or never-finished install.
 * - "inaccessible" → it exists but cannot be confirmed a usable dir (EACCES, a file where a
 *                    dir should be, any other stat error). Deliberately NOT folded into
 *                    "absent": we must not claim the bytes vanished when we merely failed to
 *                    read them.
 */
export type InstallDirProbe = "present" | "absent" | "inaccessible";

export interface UnifiedPluginEntry {
  readonly pluginKey: string;
  readonly kind: PluginRuntimeKind;
  /** super only: mcp_sidecar | external_mcp. */
  readonly runtimeType?: string;
  readonly name: string;
  readonly version: string;
  readonly official: boolean;
  readonly tools: readonly { name: string }[];
  /**
   * The STORED runtime status (`super_plugin_runtimes.status` verbatim, or "conflict").
   * Unchanged by this catalog: existing readers that key off `status` keep their exact
   * prior behaviour.
   */
  readonly status: string;
  /**
   * The status RECONCILED against the live filesystem (drift-honest). Equals `status`
   * UNLESS a `probeInstallDir` was supplied AND the install dir disagrees with the DB —
   * a vanished dir surfaces as "missing" (was installed/ready) or "install_failed" (was
   * installing) instead of a lying "installed". ADD-ONLY: `status`/`official` are left
   * untouched, so no existing consumer is affected; new consumers may prefer this field.
   */
  readonly effectiveStatus: string;
}

export interface UnifiedCatalogDeps {
  /** List Paperclip-native (JS-worker) plugins (wraps plugin-registry). */
  readonly listPaperclipPlugins: () => Promise<PaperclipPluginSummary[]>;
  /**
   * OPTIONAL live probe of a super plugin's install dir, used ONLY to derive
   * `effectiveStatus`. When omitted, `effectiveStatus` falls back to the stored status
   * (the pre-existing behaviour), so callers/tests that don't pass it are unaffected.
   * MUST resolve, never reject: a stat failure is the "inaccessible" outcome, not a
   * catalog-wide failure — one unreadable dir must never 500 the whole list.
   */
  readonly probeInstallDir?: (installDir: string) => Promise<InstallDirProbe>;
}

/**
 * Reconcile a super plugin's STORED status against the live install-dir probe. Pure +
 * exhaustively unit-tested. `probe === null` means "no probe was run" → pass the stored
 * status through unchanged (legacy behaviour). A cross-store collision (`conflicted`)
 * always wins as "conflict", never reaching disk reconciliation.
 */
export function deriveEffectiveStatus(
  storedStatus: string,
  probe: InstallDirProbe | null,
  conflicted: boolean,
): string {
  if (conflicted) return "conflict";
  if (probe === null) return storedStatus; // not probed → unchanged

  // Only statuses that ASSERT the bytes should be on disk are reconciled against the
  // probe. `super_plugin_runtimes.status` is an open text column (setSuperPluginRuntimeStatus
  // takes any string), so any OTHER value — "error"/"disabled"/"paused"/a future state — is
  // passed through verbatim: a disk probe must never MASK the DB's own signal by overwriting
  // it with "missing"/"inaccessible".
  if (storedStatus === "installing") {
    // A claim row mid-install (dir present) vs. an orphaned sentinel whose bytes never
    // landed / were rolled back (dir absent).
    if (probe === "absent") return "install_failed";
    if (probe === "inaccessible") return "inaccessible";
    return "installing";
  }
  if (storedStatus === "installed" || storedStatus === "ready") {
    // The "DB says installed, disk is gone/unreadable" drift.
    if (probe === "absent") return "missing";
    if (probe === "inaccessible") return "inaccessible";
    return storedStatus;
  }
  return storedStatus; // unknown / non-asserting status → never masked by the probe
}

/**
 * Build the unified read catalog: Paperclip JS plugins + super plugins, each with
 * the OFFICIAL badge joined from `workshop_provenance`. A super entry is official
 * only if a provenance row exists, is official, AND its digest still matches the
 * runtime record (drift guard).
 */
export async function listUnifiedPlugins(db: Db, deps: UnifiedCatalogDeps): Promise<UnifiedPluginEntry[]> {
  const [paperclip, superRuntimes, provenance] = await Promise.all([
    deps.listPaperclipPlugins(),
    listSuperPluginRuntimes(db),
    listWorkshopProvenance(db, "plugin"),
  ]);

  // A key must live in exactly ONE store. If it collides across stores the state
  // is corrupt: mark BOTH entries conflicted + non-official so a colliding key can
  // never present as official (and executeTool fail-closes it).
  const paperclipKeys = new Set(paperclip.map((p) => p.pluginKey));
  const conflicts = new Set(superRuntimes.map((s) => s.pluginKey).filter((k) => paperclipKeys.has(k)));

  const entries: UnifiedPluginEntry[] = [];
  for (const p of paperclip) {
    const conflicted = conflicts.has(p.pluginKey);
    const prov = provenance.get(p.pluginKey);
    const status = conflicted ? "conflict" : p.status;
    entries.push({
      pluginKey: p.pluginKey,
      kind: "paperclip_js",
      name: p.name,
      version: p.version,
      official: !conflicted && prov?.official === true,
      tools: p.tools.map((t) => ({ name: t.name })),
      status,
      // Paperclip JS plugins have no SuperClaw-owned install dir to probe; their stored
      // status is authoritative as-is.
      effectiveStatus: status,
    });
  }
  // Super entries: probe each install dir CONCURRENTLY so the catalog reflects disk
  // reality. The probe is contracted never to reject; we still defensively coerce any
  // unexpected rejection to "inaccessible" so a single bad dir can never fail the list.
  const superEntries = await Promise.all(
    superRuntimes.map(async (s): Promise<UnifiedPluginEntry> => {
      const conflicted = conflicts.has(s.pluginKey);
      const prov = provenance.get(s.pluginKey);
      const official = !conflicted && prov?.official === true && prov.packageDigest === s.packageDigest;
      const status = conflicted ? "conflict" : s.status;
      const probe: InstallDirProbe | null = deps.probeInstallDir
        ? await deps.probeInstallDir(s.installDir).catch((): InstallDirProbe => "inaccessible")
        : null;
      return {
        pluginKey: s.pluginKey,
        kind: "super",
        runtimeType: s.runtimeType,
        name: s.pluginKey, // super runtime store keys by id; display name lives in the manifest tools/registry projection
        version: s.version,
        official,
        tools: s.tools.map((t) => ({ name: t.name })),
        status,
        effectiveStatus: deriveEffectiveStatus(s.status, probe, conflicted),
      };
    }),
  );
  // Array-literal spread (iterator-based) — not a call-stack spread — so an arbitrarily
  // large catalog can never RangeError on the merge.
  return [...entries, ...superEntries];
}

export class PluginRuntimeRouterError extends Error {}

export interface PluginRouterDeps {
  /** Run a tool on a super plugin (P4 MCP runner). */
  readonly callSuperTool: (record: SuperPluginRuntimeRecord, toolName: string, input: unknown) => Promise<NormalizedToolResult>;
  /** Dispatch a tool on a Paperclip JS plugin (wraps the native tool dispatcher). */
  readonly dispatchPaperclipTool: (pluginKey: string, toolName: string, input: unknown) => Promise<unknown>;
  /** Whether a key is a Paperclip-native plugin (wraps plugin-registry lookup). */
  readonly isPaperclipPlugin: (pluginKey: string) => Promise<boolean>;
}

export interface ToolExecutionResult {
  readonly kind: PluginRuntimeKind;
  readonly result: NormalizedToolResult | unknown;
}

/**
 * Execute a tool by routing to the owning runtime. A super plugin is fail-closed
 * unless a matching, digest-consistent provenance row exists (an installed super
 * runtime without intact provenance is a corrupt/sideloaded state and must not
 * execute). Paperclip JS plugins dispatch to the native runtime (their execution
 * governance is Paperclip's own).
 */
/** Super runtime statuses a tool may be executed against. */
const EXECUTABLE_SUPER_STATUSES = new Set(["installed", "ready"]);

export async function executeTool(
  db: Db,
  pluginKey: string,
  toolName: string,
  input: unknown,
  deps: PluginRouterDeps,
): Promise<ToolExecutionResult> {
  const superRecord = await getSuperPluginRuntime(db, pluginKey);
  const isPaperclip = await deps.isPaperclipPlugin(pluginKey);

  // A key in BOTH stores is an ambiguous/corrupt state — never let one store's
  // row hijack (or DoS) the other.
  if (superRecord && isPaperclip) {
    throw new PluginRuntimeRouterError(`plugin key ${pluginKey} exists in both stores — refusing (ambiguous)`);
  }

  if (superRecord) {
    const prov = await getWorkshopProvenance(db, "plugin", pluginKey);
    if (!prov) {
      throw new PluginRuntimeRouterError(`super plugin ${pluginKey} has no provenance — refusing to execute`);
    }
    if (prov.packageDigest !== superRecord.packageDigest) {
      throw new PluginRuntimeRouterError(`super plugin ${pluginKey} digest drift vs provenance — refusing to execute`);
    }
    if (!EXECUTABLE_SUPER_STATUSES.has(superRecord.status)) {
      throw new PluginRuntimeRouterError(`super plugin ${pluginKey} is not executable (status ${superRecord.status})`);
    }
    // Only a tool the manifest actually declares may be invoked (mirrors the
    // Paperclip JS path's registered-tool check; P4 would otherwise send any name).
    if (!superRecord.tools.some((tool) => tool.name === toolName)) {
      throw new PluginRuntimeRouterError(`super plugin ${pluginKey} does not declare tool: ${toolName}`);
    }
    return { kind: "super", result: await deps.callSuperTool(superRecord, toolName, input) };
  }

  if (isPaperclip) {
    return { kind: "paperclip_js", result: await deps.dispatchPaperclipTool(pluginKey, toolName, input) };
  }

  throw new PluginRuntimeRouterError(`no installed plugin for key: ${pluginKey}`);
}
