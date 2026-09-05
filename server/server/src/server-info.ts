import { execFileSync } from "node:child_process";
import type { ServerGitInfo, ServerInfoSnapshot } from "@paperclipai/shared";

export type { ServerGitInfo, ServerInfoSnapshot };

type GitCommand = () => string;

const FULL_SHA_RE = /^[0-9a-f]{40}$/i;
const SHORT_SHA_RE = /^[0-9a-f]{7,40}$/i;

function defaultGitCommand() {
  return execFileSync(
    "git",
    ["show", "-s", "--format=%H%n%h%n%s%n%cI", "HEAD"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1500,
    },
  );
}

function parseGitInfo(output: string): ServerGitInfo {
  const [fullSha = "", shortSha = "", subject = "", committedAt = ""] = output
    .trimEnd()
    .split("\n");
  const committedAtTime = Date.parse(committedAt);

  if (!FULL_SHA_RE.test(fullSha) || !SHORT_SHA_RE.test(shortSha)) {
    return { available: false, unavailableReason: "invalid_git_metadata" };
  }

  return {
    available: true,
    fullSha,
    shortSha,
    subject: subject.trim() || "No commit subject",
    committedAt: Number.isNaN(committedAtTime) ? null : new Date(committedAtTime).toISOString(),
  };
}

export function createServerInfoSnapshot(
  opts: { now?: Date; gitCommand?: GitCommand } = {},
): ServerInfoSnapshot {
  let git: ServerGitInfo;
  try {
    git = parseGitInfo((opts.gitCommand ?? defaultGitCommand)());
  } catch {
    git = { available: false, unavailableReason: "git_unavailable" };
  }

  return {
    processStartedAt: (opts.now ?? new Date()).toISOString(),
    git,
  };
}

// Capture the start time eagerly (cheap, no subprocess) but DEFER the git snapshot to first use.
// Computing it at import time would `execFileSync("git")` during module load — before the
// server's boot-time env scrub runs — and that git child would inherit the un-scrubbed env. Lazy
// computation runs on the first request instead (after the scrub), and also honours the project's
// "no side effects at import" rule.
const processStartedAt = new Date();
let cachedSnapshot: ServerInfoSnapshot | null = null;

export function getServerInfoSnapshot(): ServerInfoSnapshot {
  if (cachedSnapshot === null) {
    cachedSnapshot = createServerInfoSnapshot({ now: processStartedAt });
  }
  return cachedSnapshot;
}
