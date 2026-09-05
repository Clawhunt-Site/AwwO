import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// BYO prune: drop the vendored Claude Code / Codex CLI platform binaries from a
// staged server tree.
//
// super's default execution path (`claude_local` / `codex_local` adapters) spawns
// the user's OWN PATH-resolved `claude` / `codex` — node_runtime.build_env()
// augments PATH (desktop_toolchain_env) so even a Finder-launched .app finds the
// locally-installed CLIs. The ~370MB of platform binaries that `acpx-local`
// vendors are therefore dead weight in the BYO bundle.
//
// We match ONLY the per-platform binary packages (…-{darwin,linux,win32}-*). The
// JS packages (`@zed-industries/codex-acp`, `@anthropic-ai/claude-agent-sdk`) have
// no platform suffix and are deliberately preserved, so importing them never
// breaks — only a runtime launcher's lazy resolve of an absent binary is affected,
// and those launchers exit cleanly when the binary is missing (e.g.
// bin/codex-acp.js: import.meta.resolve + existsSync). Removing the binaries thus
// leaves server boot and the default adapters untouched; only an explicit acpx run
// would (cleanly) report the missing binary.
export const VENDORED_AGENT_CLI_GLOBS = [
  "*claude-agent-sdk-darwin-*",
  "*claude-agent-sdk-linux-*",
  "*claude-agent-sdk-win32-*",
  "*codex-acp-darwin-*",
  "*codex-acp-linux-*",
  "*codex-acp-win32-*",
];

/**
 * Whether to KEEP the vendored agent CLIs (ship an out-of-the-box bundle that
 * needs no locally-installed claude/codex) instead of pruning for BYO.
 */
export function shouldKeepVendoredAgentClis(env = process.env) {
  return ["1", "true", "yes"].includes(
    (env.SUPERCLAW_BUNDLE_VENDORED_AGENT_CLIS || "").trim().toLowerCase(),
  );
}

function dirSizeBytes(dir) {
  // `du -sk` is the cheapest portable size; callers run this macOS/Linux-only.
  const out = execFileSync("du", ["-sk", dir], { encoding: "utf8" });
  return Number(out.split("\t")[0]) * 1024;
}

/**
 * Remove the vendored agent CLI platform binaries under `root`. Returns
 * `{ removed: string[], freedBytes: number }` (paths relative to root). A tree
 * with nothing to prune is a legitimate no-op, not an error.
 */
export function pruneVendoredAgentCliBinaries(root, { log = console.log } = {}) {
  const args = [root, "-maxdepth", "8", "("];
  VENDORED_AGENT_CLI_GLOBS.forEach((glob, i) => {
    if (i > 0) args.push("-o");
    args.push("-name", glob);
  });
  args.push(")");
  const matches = execFileSync("find", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\n")
    .filter(Boolean);
  // Drop nested matches (a hit inside an already-listed parent) so each top-level
  // package is sized and removed exactly once.
  const top = matches.filter(
    (m) => !matches.some((p) => p !== m && m.startsWith(p + path.sep)),
  );
  let freedBytes = 0;
  const removed = [];
  for (const target of top) {
    if (!fs.existsSync(target)) continue; // already gone under a removed parent
    freedBytes += dirSizeBytes(target);
    fs.rmSync(target, { recursive: true, force: true });
    removed.push(path.relative(root, target));
  }
  removed.sort();
  const freedMb = Number((freedBytes / (1024 * 1024)).toFixed(0));
  if (removed.length === 0) {
    // Not an error: a stripped lockfile, a non-darwin host, or an already-pruned
    // tree all legitimately leave nothing to remove. Make the no-op auditable.
    log("BYO prune: no vendored agent CLI binaries found (nothing to remove)");
  } else {
    log(`BYO prune: removed ${removed.length} vendored agent CLI binary package(s), freed ~${freedMb}MB`);
    for (const rel of removed) log(`  - ${rel}`);
  }
  return { removed, freedBytes };
}
