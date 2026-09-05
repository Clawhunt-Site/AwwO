import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { resolvePaperclipInstanceRootForAdapter } from "@paperclipai/adapter-utils/server-utils";

const SEEDED_SHARED_FILES = ["settings.json", "CLAUDE.md"] as const;

interface SeedFile {
  name: string;
  sourcePath: string;
  contents: Buffer;
}

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

async function pathExists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true).catch(() => false);
}

function isAlreadyExistsError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? error.code : null;
  return code === "EEXIST" || code === "ENOTEMPTY";
}

function sanitizeRemoteClaudeSettings(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return JSON.stringify({ permissions: { defaultMode: "default" } });
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return JSON.stringify({ permissions: { defaultMode: "default" } });
  }

  const settings = { ...(parsed as Record<string, unknown>) };
  settings.permissions = { defaultMode: "default" };
  delete settings.hooks;
  delete settings.mcpServers;
  delete settings.permissionMode;
  delete settings.skipDangerousModePermissionPrompt;
  return JSON.stringify(settings);
}

async function collectSeedFiles(sourceDir: string): Promise<SeedFile[]> {
  const files: SeedFile[] = [];
  for (const name of SEEDED_SHARED_FILES) {
    const sourcePath = path.join(sourceDir, name);
    if (!(await pathExists(sourcePath))) continue;
    const rawContents = await fs.readFile(sourcePath);
    const contents = name === "settings.json"
      ? Buffer.from(sanitizeRemoteClaudeSettings(rawContents.toString("utf8")), "utf8")
      : rawContents;
    files.push({ name, sourcePath, contents });
  }
  return files;
}

async function buildSeedSnapshotKey(files: SeedFile[]): Promise<string> {
  if (files.length === 0) return "empty";
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.name);
    hash.update("\0");
    hash.update(file.contents);
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

async function materializeSeedSnapshot(input: {
  rootDir: string;
  snapshotKey: string;
  files: SeedFile[];
}): Promise<string> {
  const targetDir = path.join(input.rootDir, input.snapshotKey);
  if (await pathExists(targetDir)) {
    return targetDir;
  }

  await fs.mkdir(input.rootDir, { recursive: true });
  const stagingDir = await fs.mkdtemp(path.join(input.rootDir, ".tmp-"));
  try {
    for (const file of input.files) {
      await fs.writeFile(path.join(stagingDir, file.name), file.contents);
    }
    try {
      await fs.rename(stagingDir, targetDir);
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }
      await fs.rm(stagingDir, { recursive: true, force: true });
    }
  } catch (error) {
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  return targetDir;
}

export function resolveSharedClaudeConfigDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromEnv = nonEmpty(env.CLAUDE_CONFIG_DIR);
  return fromEnv ? path.resolve(fromEnv) : path.join(os.homedir(), ".claude");
}

export function resolveManagedClaudeConfigSeedDir(
  env: NodeJS.ProcessEnv,
  companyId?: string,
): string {
  const instanceRoot = resolvePaperclipInstanceRootForAdapter({
    homeDir: nonEmpty(env.PAPERCLIP_HOME) ?? undefined,
    instanceId: nonEmpty(env.PAPERCLIP_INSTANCE_ID) ?? undefined,
    env,
  });
  return companyId
    ? path.resolve(instanceRoot, "companies", companyId, "claude-config-seed")
    : path.resolve(instanceRoot, "claude-config-seed");
}

// The SuperClaw agent persona, seeded as the isolated config dir's CLAUDE.md so the
// relay-routed CLI adopts the SAME identity as the online web/board chat
// (CHAT_AGENT_CHARTER) instead of the underlying model's default self-name (e.g. "Kiro").
// The user memory in CLAUDE_CONFIG_DIR/CLAUDE.md is loaded on every run, incl. `-p` mode.
const SUPERCLAW_AGENT_CHARTER = `# SuperClaw

You are **SuperClaw**, the AI assistant inside the ClawHunt desktop app. Always introduce
and refer to yourself as **SuperClaw** — never as Claude, Kiro, or the name of whatever
underlying model is powering you, regardless of which model that is.

Help the user directly and conversationally:
- Do what the user asks. You may use any available tools and read or write the authorized
  workspace to carry out real work — don't stop at merely describing a plan.
- The conversation so far is your memory of this session; rely on it for context.
- Keep replies focused and useful.
- This is a direct chat, not a managed work board — there's no issue tracker, company, or
  ticket workflow behind it. Just help the user here, in this conversation.
`;

// Seeded ONCE as <config>/memory.md — SuperClaw's durable, cross-session memory of the
// user. The charter embeds its current contents every run (so it's always loaded) and
// tells the agent to APPEND lasting facts/preferences to it. Never overwritten after
// seeding, so accumulated memories survive.
const SUPERCLAW_MEMORY_SEED = `# SuperClaw — long-term memory

Durable facts and preferences about this user, appended over time (one short bullet
each). Loaded into every session. Append new entries with your file tools; never erase
existing ones.
`;

// Build the CLAUDE.md the relay-isolated CLI loads: the SuperClaw persona plus a
// long-term-memory section that EMBEDS the current memory.md so past learnings are always
// in context, and tells the agent where + how to record new ones (CodePilot-style
// persistent memory, reimplemented for the relay-CLI path).
function buildRelayIsolatedClaudeMd(memoryFilePath: string, memoryBody: string): string {
  const entries = memoryBody.trim();
  return `${SUPERCLAW_AGENT_CHARTER}
## Long-term memory

The block below is your durable memory of THIS user, carried across sessions and loaded
every time — treat it as established context and don't re-ask what it already tells you.
When the user shares a LASTING preference, fact, or correction (how they like replies,
their stack, names they use, recurring goals), record it by APPENDING one short bullet to
your memory file with your file tools:
    ${memoryFilePath}
Append only; never rewrite or delete existing entries. Skip one-off / session-only detail.

<memory>
${entries || "(no long-term memories recorded yet)"}
</memory>
`;
}

// A claude.ai subscription login (`claudeAiOauth` in `<config-dir>/.credentials.json`)
// is preferred by the Claude CLI over an injected ANTHROPIC_API_KEY — it's sent as a
// Bearer token to whatever ANTHROPIC_BASE_URL is set. When claude_local is routed through
// the ClawHunt relay (x-api-key against the gate), that stored OAuth would shadow the relay
// key and hit the gate as an invalid Bearer (401). Give the CLI a dedicated, credential-FREE
// config dir (minimal settings, no `.credentials.json`) so the relay key is the only auth it
// sees. We also seed a CLAUDE.md so the agent identifies as SuperClaw (unified persona).
// Stable per-instance path so the CLI's own state (trusted projects, history) persists
// across runs. Local execution only — remote runs already get a seeded, OAuth-free config.
export async function ensureRelayIsolatedClaudeConfigDir(env: NodeJS.ProcessEnv): Promise<string> {
  const dir = path.resolve(resolveManagedClaudeConfigSeedDir(env), "relay-isolated");
  await fs.mkdir(dir, { recursive: true });
  const settingsPath = path.join(dir, "settings.json");
  if (!(await pathExists(settingsPath))) {
    await fs.writeFile(
      settingsPath,
      JSON.stringify({ permissions: { defaultMode: "default" } }),
      "utf8",
    );
  }
  // Seed the long-term memory file ONCE so accumulated entries persist across runs; then
  // embed its current contents into the CLAUDE.md we (re)write every call, so the agent
  // always loads past learnings and knows where to append new ones.
  const memoryPath = path.join(dir, "memory.md");
  if (!(await pathExists(memoryPath))) {
    await fs.writeFile(memoryPath, SUPERCLAW_MEMORY_SEED, "utf8");
  }
  let memoryBody = "";
  try {
    memoryBody = await fs.readFile(memoryPath, "utf8");
  } catch {
    memoryBody = "";
  }
  // Written every call so the persona + embedded memory stay current.
  await fs.writeFile(path.join(dir, "CLAUDE.md"), buildRelayIsolatedClaudeMd(memoryPath, memoryBody), "utf8");
  return dir;
}

export async function prepareClaudeConfigSeed(
  env: NodeJS.ProcessEnv,
  onLog: AdapterExecutionContext["onLog"],
  companyId?: string,
): Promise<string> {
  const sourceDir = resolveSharedClaudeConfigDir(env);
  const targetRootDir = resolveManagedClaudeConfigSeedDir(env, companyId);

  if (path.resolve(sourceDir) === path.resolve(targetRootDir)) {
    return targetRootDir;
  }

  const copiedFiles = await collectSeedFiles(sourceDir);
  const snapshotKey = await buildSeedSnapshotKey(copiedFiles);
  const targetDir = await materializeSeedSnapshot({
    rootDir: targetRootDir,
    snapshotKey,
    files: copiedFiles,
  });

  if (copiedFiles.length > 0) {
    await onLog(
      "stdout",
      `[paperclip] Prepared Claude config seed "${targetDir}" from "${sourceDir}" (${copiedFiles.map((file) => file.name).join(", ")}).\n`,
    );
  } else {
    await onLog(
      "stdout",
      `[paperclip] No local Claude config seed files were found in "${sourceDir}". Remote Claude auth may still require login.\n`,
    );
  }

  return targetDir;
}
