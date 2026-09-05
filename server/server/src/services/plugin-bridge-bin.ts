/**
 * Resolve the absolute path of the SuperClaw plugin-bridge stdio bin
 * (`@paperclipai/mcp-server` → `dist/plugin-bridge-stdio.js`), HOST-SIDE.
 *
 * The host (heartbeat) resolves and existence-checks the bin once, then hands
 * the verified path to the local adapter via the server-derived
 * `pluginToolRunContext`. Adapters therefore never resolve the package
 * themselves — sidestepping the brittle deep-`require.resolve` / workspace
 * `.bin` problems flagged in design §4.2 (the adapter packages don't even
 * depend on `mcp-server`).
 *
 * Resolution order (fail-closed — a miss yields `null`, i.e. NO bridge):
 *   1. Explicit override env `SUPERCLAW_PLUGIN_BRIDGE_BIN` (the desktop / BYO
 *      packaging path injects the baked-in dist location here).
 *   2. The package's `./plugin-bridge-stdio` subpath export, resolved from this
 *      module. Requires `mcp-server` to be built (`dist/`); a source-only tree
 *      yields `null`.
 * Both candidates are verified with `fs.access` before being returned; an
 * override pointing at a missing file fails closed (no silent fallback that
 * could mask a packaging mistake), with a warning so it is diagnosable.
 */

import { access, constants } from "node:fs/promises";
import { createRequire } from "node:module";
import { logger } from "../middleware/logger.js";

const require = createRequire(import.meta.url);

async function fileReadable(candidate: string): Promise<boolean> {
  try {
    await access(candidate, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

let cached: { value: string | null } | null = null;

export async function resolvePluginBridgeBin(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const override = env.SUPERCLAW_PLUGIN_BRIDGE_BIN?.trim();
  if (override) {
    if (await fileReadable(override)) return override;
    logger.warn(
      { override },
      "plugin-bridge: SUPERCLAW_PLUGIN_BRIDGE_BIN points at a missing file; bridge disabled",
    );
    return null;
  }

  if (cached) return cached.value;

  let resolved: string | null = null;
  try {
    resolved = require.resolve("@paperclipai/mcp-server/plugin-bridge-stdio");
  } catch {
    resolved = null;
  }
  if (resolved && !(await fileReadable(resolved))) resolved = null;
  cached = { value: resolved };
  if (!resolved) {
    logger.warn(
      {},
      "plugin-bridge: @paperclipai/mcp-server/plugin-bridge-stdio not resolvable (built?); bridge disabled",
    );
  }
  return resolved;
}

/** Test-only: clear the resolution cache. */
export function __resetPluginBridgeBinCacheForTests(): void {
  cached = null;
}
