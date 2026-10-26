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
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        try {
          total += fs.statSync(full).size;
        } catch {
          // symlink or vanishing file — skip
        }
      }
    }
  }
  return total;
}

// Convert a `*foo-*` glob into a RegExp (only the simple `*` wildcard is used).
// Like `find -name`, match the directory's basename, never its ancestors.
function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*")}$`);
}

function findMatches(root, maxDepth) {
  const patterns = VENDORED_AGENT_CLI_GLOBS.map(globToRegExp);
  const matches = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      if (patterns.some((re) => re.test(entry.name))) {
        matches.push(full);
      } else {
        walk(full, depth + 1);
      }
    }
  };
  walk(root, 1);
  return matches;
}

/**
 * Prune vendored agent-CLI platform binaries from `root`.
 * Returns `{ removed: string[], freedBytes: number }`.
 */
export function pruneVendoredAgentCliBinaries(root, { log = console.log } = {}) {
  const matches = findMatches(root, 8);

  if (matches.length === 0) {
    log("no vendored agent-CLI platform trees found — nothing to remove");
    return { removed: [], freedBytes: 0 };
  }

  let freedBytes = 0;
  const removed = [];
  for (const dir of matches) {
    const size = dirSizeBytes(dir);
    fs.rmSync(dir, { recursive: true, force: true });
    freedBytes += size;
    removed.push(path.relative(root, dir));
    log(`pruned ${dir} (${(size / 1024 / 1024).toFixed(1)} MB)`);
  }

  return { removed: removed.sort(), freedBytes };
}
