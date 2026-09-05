import fs from "node:fs/promises";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  inferOpenAiCompatibleBiller,
  type AdapterExecutionContext,
  type AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import {
  adapterExecutionTargetIsRemote,
  readAdapterExecutionTarget,
} from "@paperclipai/adapter-utils/execution-target";
import {
  asString,
  asNumber,
  asStringArray,
  parseObject,
  buildPaperclipEnv,
  joinPromptSections,
  ensureAbsoluteDirectory,
  ensurePathInEnv,
  refreshPaperclipWorkspaceEnvForExecution,
  readPaperclipIssueWorkModeFromContext,
  renderTemplate,
  renderPaperclipWakePrompt,
  stringifyPaperclipWakePayload,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  buildInvocationEnvForLogs,
  runChildProcess,
  mirrorApiEnvAliases,
} from "@paperclipai/adapter-utils/server-utils";
import { parsePiJsonl, isPiUnknownSessionError } from "@paperclipai/adapter-pi-local/server";
import { prepareClawrelayProvider, CLAWWORK_AGENT_DIR_ENV, RELAY_API_KEY_ENV, RELAY_BASE_URL_ENV } from "./runtime-config.js";
import { translateRelayPackageModel } from "./models.js";
import {
  writePolicySnapshot,
  clawworkToolAllowlist,
  resolveGovernanceExtPath,
  normalizePermissionMode,
} from "./governance.js";
import { clawworkTerminalError, clawworkExtensionError } from "./clawwork-parse.js";
import {
  resolveClawworkExecutable,
  resolveAbsoluteCommand,
  verifyGovernanceBarrierSupported,
} from "./resolve-executable.js";
import { type as adapterType } from "../index.js";

// HOME-only session root (governance: a plaintext native session must never
// follow the working directory off-machine). Mirrors the Python
// clawwork_session.native_sessions_root anchoring on SUPERCLAW_HOME.
function clawworkSessionsRoot(): string {
  const home = (process.env.SUPERCLAW_HOME ?? "").trim() || path.join(os.homedir(), ".superclaw");
  return path.join(home, "clawwork", "paperclips");
}

function firstNonEmptyLine(text: string): string {
  return text.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
}

function buildSessionPath(agentId: string, runId: string): string {
  const safeAgent = agentId.replace(/[^A-Za-z0-9._-]/g, "-") || "agent";
  const safeRun = (runId.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 24)) || "run";
  // runId + high-entropy suffix: a same-millisecond same-agent collision (Codex)
  // can never mint two divergent files for one logical session.
  const rand = randomBytes(8).toString("hex");
  return path.join(clawworkSessionsRoot(), `${safeRun}-${safeAgent}-${rand}.jsonl`);
}

function realpathOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** True when ``candidate`` resolves to a path inside the sessions root (no
 * traversal / symlink escape to an attacker-controlled file outside it). */
function isWithinSessionsRoot(candidate: string): boolean {
  const root = realpathOrSelf(clawworkSessionsRoot());
  const resolved = realpathOrSelf(candidate);
  return resolved === root || resolved.startsWith(root + path.sep);
}

/** Post-hoc governance liveness check: the extension wrote ``readyFile`` with
 * handler_registered + this spawn's nonce iff it loaded and registered its
 * tool_call gate. A missing / malformed / nonce-mismatched file means the run was
 * (potentially) ungoverned. */
async function governanceProven(readyFile: string, nonce: string): Promise<boolean> {
  try {
    const payload = JSON.parse(await fs.readFile(readyFile, "utf8")) as Record<string, unknown>;
    return Boolean(payload) && payload.handler_registered === true && payload.nonce === nonce;
  } catch {
    return false;
  }
}

/**
 * Read a ClawWork session file's first-line header and return (cwd, id). The
 * header is the authoritative identity (a filename can collide); a resume is only
 * admitted when BOTH cwd and id match, so a stale/forged file never crosses
 * conversations.
 */
async function readSessionHeader(sessionPath: string): Promise<{ cwd: string | null; id: string | null }> {
  let raw: string;
  try {
    raw = await fs.readFile(sessionPath, "utf8");
  } catch {
    return { cwd: null, id: null };
  }
  const headerLine = firstNonEmptyLine(raw);
  if (!headerLine) return { cwd: null, id: null };
  try {
    const parsed = JSON.parse(headerLine) as Record<string, unknown>;
    if (parsed.type !== "session") return { cwd: null, id: null };
    const cwd = typeof parsed.cwd === "string" && parsed.cwd.trim() ? parsed.cwd.trim() : null;
    const id = typeof parsed.id === "string" && parsed.id.trim() ? parsed.id.trim() : null;
    return { cwd, id };
  } catch {
    return { cwd: null, id: null };
  }
}

// In-process serialization of concurrent turns of one ClawWork session. The
// Paperclip Node server is a single process, so an async mutex keyed by session
// path covers the deployment (mirrors the Python ClawWorkBackend's in-process
// _chat_native_lock scoping). Cross-process serialization of the same session
// across separate Node servers sharing one SUPERCLAW_HOME is out of scope for v1.
const sessionLocks = new Map<string, Promise<void>>();

async function withSessionLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = sessionLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Store the SAME promise reference we compare against on cleanup, so the map
  // entry is actually dropped when no one chained after us (the prior code stored
  // `prior.then(...)` but compared `=== gate`, so it never cleaned up — a leak).
  const tail = prior.then(() => gate);
  sessionLocks.set(key, tail);
  await prior.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (sessionLocks.get(key) === tail) sessionLocks.delete(key);
  }
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;

  // v1 is LOCAL-only: the credential-hygiene + governance wiring (ephemeral agent
  // dir, env-bound relay key, governance extension path) is established for the
  // Paperclip host. A remote execution target is refused fail-closed rather than
  // shipping a half-wired run; remote support is a follow-up.
  const executionTarget = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
  });
  if (adapterExecutionTargetIsRemote(executionTarget)) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage:
        "clawwork_local does not support remote execution targets yet (governance + relay key are wired for the local host only). Run on the SuperClaw host.",
      errorCode: "CLAWWORK_REMOTE_UNSUPPORTED",
      clearSession: false,
    };
  }

  // Resolve the executable, preferring the vendored PATCHED build so the governance
  // barrier is guaranteed present (A1b). A non-vendored binary is self-checked below.
  const { executable: command, vendored: commandIsVendored } = resolveClawworkExecutable(config);
  const model = asString(config.model, "").trim();
  const thinking = asString(config.thinking, "").trim();
  const permissionMode = asString(config.permissionMode, "").trim();
  const allowedTools = asStringArray(config.allowedTools);
  const promptTemplate = asString(config.promptTemplate, DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE);
  const modelSlug = translateRelayPackageModel(model);

  // Resolve cwd from the Paperclip workspace context (mirror pi-local).
  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceId = asString(workspaceContext.workspaceId, "");
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "");
  const workspaceRepoRef = asString(workspaceContext.repoRef, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const agentHome = asString(workspaceContext.agentHome, "");
  const workspaceHints = Array.isArray(context.paperclipWorkspaces)
    ? context.paperclipWorkspaces.filter(
        (v): v is Record<string, unknown> => typeof v === "object" && v !== null,
      )
    : [];
  const configuredCwd = asString(config.cwd, "");
  const cwd = workspaceCwd || configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
  await fs.mkdir(clawworkSessionsRoot(), { recursive: true });

  // --- Governance (soft): the pay/scan hard gate is the one hard control kept
  // under the soft posture, so the extension is MANDATORY — refuse fail-closed
  // when it cannot be resolved. ---
  const governanceExt = resolveGovernanceExtPath();
  if (!governanceExt) {
    return {
      exitCode: 126,
      signal: null,
      timedOut: false,
      errorMessage:
        "CLAWWORK_UNGOVERNED: superclaw-governance extension not found (set SUPERCLAW_CLAWWORK_GOVERNANCE_EXT or build the vendored harness); refusing to run without the pay/scan hard gate.",
      errorCode: "CLAWWORK_UNGOVERNED",
      clearSession: false,
    };
  }

  // A1b barrier attestation is deferred until after the real run env is built, so
  // the probe and the real spawn bind to the SAME absolute executable (below).
  void commandIsVendored;

  // --- Credential-hygiene: ephemeral clawrelay provider (real key never on disk). ---
  let prepared: Awaited<ReturnType<typeof prepareClawrelayProvider>>;
  try {
    prepared = await prepareClawrelayProvider({
      env: parseObject(config.env) as Record<string, string>,
      modelSlug,
    });
  } catch (err) {
    return {
      exitCode: 125,
      signal: null,
      timedOut: false,
      errorMessage: err instanceof Error ? err.message : String(err),
      errorCode: "CLAWWORK_RELAY_CONFIG_INVALID",
      clearSession: false,
    };
  }

  // --- Build the child env. ---
  const envConfig = parseObject(config.env);
  const env: Record<string, string> = { ...buildPaperclipEnv(agent) };
  env.SUPERCLAW_RUN_ID = env.PAPERCLIP_RUN_ID = runId;
  const issueWorkMode = readPaperclipIssueWorkModeFromContext(context);
  if (issueWorkMode) env.PAPERCLIP_ISSUE_WORK_MODE = issueWorkMode;
  const wakePayloadJson = stringifyPaperclipWakePayload(context.paperclipWake);
  if (wakePayloadJson) env.PAPERCLIP_WAKE_PAYLOAD_JSON = wakePayloadJson;
  refreshPaperclipWorkspaceEnvForExecution({
    env,
    envConfig,
    workspaceCwd,
    workspaceSource,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    workspaceHints,
    agentHome,
    executionTargetIsRemote: false,
    executionCwd: cwd,
  });
  if (authToken && !((typeof envConfig.PAPERCLIP_API_KEY === "string" && envConfig.PAPERCLIP_API_KEY.trim()) || (typeof envConfig.SUPERCLAW_API_KEY === "string" && envConfig.SUPERCLAW_API_KEY.trim()))) {
    env.SUPERCLAW_API_KEY = env.PAPERCLIP_API_KEY = authToken;
  }
  mirrorApiEnvAliases(env);
  // Relay base/key: pass the REAL key through to the child env so ClawWork can
  // interpolate the `$SUPERCLAW_RELAY_API_KEY` apiKey binding at request time. The
  // key only lives in this env map + the child process — never on disk.
  const relayBase = (envConfig[RELAY_BASE_URL_ENV] as string) || process.env[RELAY_BASE_URL_ENV] || "";
  const relayKey = (envConfig[RELAY_API_KEY_ENV] as string) || process.env[RELAY_API_KEY_ENV] || "";
  if (relayBase) env[RELAY_BASE_URL_ENV] = prepared.baseUrl; // validated/normalized form
  if (relayKey) env[RELAY_API_KEY_ENV] = relayKey;
  env[CLAWWORK_AGENT_DIR_ENV] = prepared.agentConfigDir;

  // Effective posture: default to bypassPermissions (soft posture — full tools,
  // ONLY pay/scan hard-gated by the extension). An autonomous agent left at the
  // raw "default" mode would have every mutating tool blocked by the extension's
  // in-process posture gate (write/edit/bash all denied = effectively read-only),
  // which contradicts the owner's "don't cage the runtime" posture. SuperClaw can
  // still pin a restrictive mode (plan) or an explicit allowlist.
  const effectiveMode = normalizePermissionMode(permissionMode) || "bypassPermissions";

  // --- Signed policy snapshot for the governance extension (pay_switch always off). ---
  const snapshot = writePolicySnapshot({
    directory: prepared.agentConfigDir,
    mode: effectiveMode,
    allowedTools,
    disallowedTools: asStringArray(config.disallowedTools),
    paySwitchEnabled: false,
    runId,
    issuedAt: Date.now() / 1000,
  });
  Object.assign(env, snapshot.env());

  // Governance liveness handshake (post-hoc, one-shot adaptation of the Python rpc
  // pre-prompt gate): the extension writes this file with handler_registered + our
  // per-spawn nonce when it loads. ClawWork's `-e` loader CONTINUES on a failed
  // load (handler never registers) — so without this check a silently-ungoverned
  // run could report success. One-shot `--mode json -p` cannot wait before the
  // prompt (the prompt is argv), so we verify the file AFTER the run and fail
  // CLAWWORK_UNGOVERNED if it never appeared / nonce mismatched. The pay/scan hard
  // gate is the one hard control kept under the soft posture, so proving the
  // extension was live (or failing the run) is mandatory.
  const governanceNonce = randomBytes(16).toString("hex");
  const readyFile = path.join(prepared.agentConfigDir, `clawwork-governance-ready-${governanceNonce}`);
  env.SUPERCLAW_GOVERNANCE_READY_FILE = readyFile;
  env.SUPERCLAW_GOVERNANCE_NONCE = governanceNonce;
  // Forge-proof core barrier (the primary governance guarantee): ClawWork refuses
  // to run any prompt/model/tool unless THIS exact governance extension loaded and
  // registered its tool_call gate in-process. The agent cannot forge an in-process
  // handler registration (the post-hoc ready-file check above is now only
  // belt-and-suspenders for accidental load/runtime failures).
  env.SUPERCLAW_REQUIRE_GOVERNANCE = governanceExt;

  const mergedEnv = ensurePathInEnv({ ...process.env, ...env });
  const runtimeEnv = Object.fromEntries(
    Object.entries(mergedEnv).filter((e): e is [string, string] => typeof e[1] === "string"),
  );
  // Redacted env for onMeta / invocation logs: NEVER expose the real relay key
  // or the policy HMAC key to the Paperclip meta/transcript layer. redactEnvForLogs
  // masks any key matching /(key|token|secret|...)/i, which covers
  // SUPERCLAW_RELAY_API_KEY and SUPERCLAW_POLICY_SNAPSHOT_KEY.
  const loggedEnv = buildInvocationEnvForLogs(env, {
    runtimeEnv,
    includeRuntimeKeys: ["HOME"],
  });

  // A1b: pin to ONE absolute executable for BOTH the barrier probe and the real
  // run. A bare command name could otherwise resolve to a patched binary at probe
  // time (process.env PATH) but an old one at run time (a config.env PATH shadow in
  // runtimeEnv). Resolve against the real run env, then probe THAT exact file.
  const absoluteCommand = resolveAbsoluteCommand(command, runtimeEnv);
  if (!absoluteCommand) {
    await prepared.cleanup();
    return {
      exitCode: 127,
      signal: null,
      timedOut: false,
      errorMessage: `ClawWork executable not found on PATH: ${command}`,
      errorCode: "CLAWWORK_EXECUTABLE_NOT_FOUND",
      clearSession: false,
    };
  }
  const barrierSupported = await verifyGovernanceBarrierSupported(
    runId,
    absoluteCommand,
    { ...process.env } as Record<string, string>,
    cwd,
  );
  if (!barrierSupported) {
    await prepared.cleanup();
    return {
      exitCode: 126,
      signal: null,
      timedOut: false,
      errorMessage:
        `CLAWWORK_UNGOVERNED: the resolved ClawWork executable (${absoluteCommand}) does not enforce the SuperClaw governance barrier; ` +
        "refusing to run with a forgeable governance check. Rebuild the vendored harness (scripts/build-clawwork.sh) or use a patched binary.",
      errorCode: "CLAWWORK_BARRIER_UNSUPPORTED",
      clearSession: false,
    };
  }

  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 20);
  const extraArgs = (() => {
    const fromExtra = asStringArray(config.extraArgs);
    return fromExtra.length > 0 ? fromExtra : asStringArray(config.args);
  })();

  // --- Session resume (header-verified: within sessions root + cwd realpath + id). ---
  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
  const expectedHeaderId = asString(runtimeSessionParams.headerId, "");
  let canResume = false;
  if (runtimeSessionId) {
    const header = await readSessionHeader(runtimeSessionId);
    const cwdMatches = header.cwd !== null && realpathOrSelf(header.cwd) === realpathOrSelf(cwd);
    // The prior session FILE must live inside our sessions root (no resume of an
    // arbitrary/forged path the caller may pass) AND match the recorded header id
    // when we have one (a same-path file whose content was swapped never resumes).
    const withinRoot = isWithinSessionsRoot(runtimeSessionId);
    const idMatches = !expectedHeaderId || (header.id !== null && header.id === expectedHeaderId);
    canResume = cwdMatches && withinRoot && idMatches;
    if (!canResume) {
      await onLog(
        "stdout",
        `[paperclip] ClawWork session "${runtimeSessionId}" will not be resumed ` +
          `(cwd/id/root mismatch); starting a fresh session.\n`,
      );
    }
  }
  const sessionPath = canResume ? runtimeSessionId : buildSessionPath(agent.id, runId);

  // --- Prompt construction (mirror pi-local). ---
  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };
  const renderedSystemPrompt = renderTemplate(promptTemplate, templateData);
  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, { resumedSession: canResume });
  const heartbeatPrompt = canResume && wakePrompt.length > 0 ? "" : renderTemplate(promptTemplate, templateData);
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const userPrompt = joinPromptSections([wakePrompt, sessionHandoffNote, heartbeatPrompt]);

  const toolAllowlist = clawworkToolAllowlist(effectiveMode, allowedTools);

  const buildArgs = (sessionFile: string): string[] => {
    const args: string[] = ["--mode", "json", "-p"];
    args.push("--append-system-prompt", renderedSystemPrompt);
    args.push("--provider", "clawrelay");
    if (modelSlug) args.push("--model", modelSlug);
    if (thinking) args.push("--thinking", thinking);
    if (toolAllowlist !== null) args.push("--tools", toolAllowlist.join(","));
    args.push("--session", sessionFile);
    args.push("-e", governanceExt);
    if (extraArgs.length > 0) args.push(...extraArgs);
    // ClawWork takes the prompt terminator-safe: pass it as the final argument.
    args.push(userPrompt);
    return args;
  };

  const runAttempt = async (sessionFile: string) => {
    const args = buildArgs(sessionFile);
    if (onMeta) {
      await onMeta({
        adapterType,
        command: absoluteCommand,
        cwd,
        commandArgs: args,
        env: loggedEnv,
        prompt: userPrompt,
        context,
      });
    }
    // Buffer stdout into whole JSONL lines for the transcript pipeline.
    let stdoutBuffer = "";
    const bufferedOnLog = async (stream: "stdout" | "stderr", chunk: string) => {
      if (stream === "stderr") {
        await onLog(stream, chunk);
        return;
      }
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() || "";
      for (const line of lines) {
        if (line) await onLog(stream, line + "\n");
      }
    };
    const proc = await runChildProcess(runId, absoluteCommand, args, {
      cwd,
      env: runtimeEnv,
      timeoutSec,
      graceSec,
      onSpawn,
      onLog: bufferedOnLog,
    });
    if (stdoutBuffer) await onLog("stdout", stdoutBuffer);
    return { proc, parsed: parsePiJsonl(proc.stdout) };
  };

  const finalize = async (
    attempt: Awaited<ReturnType<typeof runAttempt>>,
    usedSessionFile: string,
  ): Promise<AdapterExecutionResult> => {
    // Record the header id ClawWork wrote so the NEXT turn can verify the same
    // conversation (not just same cwd) before resuming.
    const headerId = (await readSessionHeader(usedSessionFile)).id ?? "";
    const sessionParams: Record<string, unknown> = {
      sessionId: usedSessionFile,
      cwd,
      ...(headerId ? { headerId } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
      ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
    };

    if (attempt.proc.timedOut) {
      return {
        exitCode: attempt.proc.exitCode,
        signal: attempt.proc.signal,
        timedOut: true,
        errorMessage: `Timed out after ${timeoutSec}s`,
        sessionId: usedSessionFile,
        sessionParams,
        sessionDisplayId: usedSessionFile,
        clearSession: false,
      };
    }

    // Governance liveness (post-hoc): the run is treated as governed ONLY when the
    // extension signalled ready (handler registered) AND it did not throw an
    // extension error mid-run. Either failure => CLAWWORK_UNGOVERNED, regardless of
    // what the process produced, so an ungoverned run is never reported as success
    // (the pay/scan hard gate is the one hard control kept under the soft posture).
    // NOTE (honest limitation): the ready-file/nonce ride the child env, which the
    // agent's bash tool can read under the soft posture (no fs sandbox), so a
    // DELIBERATELY-evading agent could forge the ready-file. This check therefore
    // reliably catches an ACCIDENTAL extension load/runtime failure (the realistic
    // case); a forge-proof guarantee needs the clawwork-core mandatory-extension
    // barrier (a follow-up core change), not a post-hoc file check.
    const governanceOk = await governanceProven(readyFile, governanceNonce);
    const extensionError = clawworkExtensionError(attempt.proc.stdout, attempt.proc.stderr);
    if (!governanceOk || extensionError) {
      return {
        exitCode: 126,
        signal: attempt.proc.signal,
        timedOut: false,
        errorMessage: extensionError
          ? `CLAWWORK_UNGOVERNED: governance extension error (${extensionError}); refusing to report an ungoverned run as success.`
          : "CLAWWORK_UNGOVERNED: governance extension did not signal ready (its -e load failed, or the ready file lacked this spawn's nonce); refusing to report an ungoverned run as success.",
        errorCode: "CLAWWORK_UNGOVERNED",
        sessionId: usedSessionFile,
        sessionParams,
        sessionDisplayId: usedSessionFile,
        resultJson: { stdout: attempt.proc.stdout, stderr: attempt.proc.stderr },
        clearSession: false,
      };
    }

    // Fake-success guard: a clean exit is NOT enough. Fail when pi-local's parser
    // surfaced an error frame OR a terminal assistant message has stopReason
    // error/aborted (pi-local's parser misses that — see clawwork-parse). An EMPTY
    // final message is NOT a failure by itself (a pure-tool final turn legitimately
    // has no text), mirroring the Python backend's "(no text output)" success.
    const parsedError = attempt.parsed.errors.find((e) => e.trim().length > 0) ?? "";
    const terminalError = clawworkTerminalError(attempt.proc.stdout);
    const rawExit = attempt.proc.exitCode;
    const failureReason = parsedError || terminalError || "";
    const effectiveExit = (rawExit ?? 0) === 0 && failureReason ? 1 : rawExit;
    const finalMessage = attempt.parsed.finalMessage ?? attempt.parsed.messages.join("\n\n").trim();
    const stderrLine = firstNonEmptyLine(attempt.proc.stderr);
    const errorMessage =
      (effectiveExit ?? 0) === 0 ? null : failureReason || stderrLine || `ClawWork exited with code ${rawExit ?? -1}`;

    return {
      exitCode: effectiveExit,
      signal: attempt.proc.signal,
      timedOut: false,
      errorMessage,
      usage: {
        inputTokens: attempt.parsed.usage.inputTokens,
        outputTokens: attempt.parsed.usage.outputTokens,
        cachedInputTokens: attempt.parsed.usage.cachedInputTokens,
      },
      sessionId: usedSessionFile,
      sessionParams,
      sessionDisplayId: usedSessionFile,
      provider: "clawrelay",
      biller: inferOpenAiCompatibleBiller(runtimeEnv, null) ?? "clawrelay",
      model: modelSlug,
      billingType: "unknown",
      costUsd: attempt.parsed.usage.costUsd,
      resultJson: { stdout: attempt.proc.stdout, stderr: attempt.proc.stderr },
      summary: finalMessage || "(clawwork produced no text output)",
      clearSession: false,
    };
  };

  try {
    return await withSessionLock(sessionPath, async () => {
      if (!canResume) {
        try {
          await fs.writeFile(sessionPath, "", { flag: "wx" });
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        }
      }
      const initial = await runAttempt(sessionPath);
      const initialFailed =
        !initial.proc.timedOut &&
        ((initial.proc.exitCode ?? 0) !== 0 ||
          initial.parsed.errors.length > 0 ||
          clawworkTerminalError(initial.proc.stdout) !== null);
      // Unknown-session retry: a believed resume whose session ClawWork no longer
      // recognizes restarts fresh. The fresh session id is returned (via finalize)
      // so the NEXT turn resumes IT — returning a new sessionId rebinds the
      // conversation; no clearSession needed.
      if (canResume && initialFailed && isPiUnknownSessionError(initial.proc.stdout, initial.proc.stderr)) {
        await onLog("stdout", `[paperclip] ClawWork session is unavailable; retrying with a fresh session.\n`);
        const fresh = buildSessionPath(agent.id, runId);
        try {
          await fs.writeFile(fresh, "", { flag: "wx" });
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        }
        const retry = await runAttempt(fresh);
        return await finalize(retry, fresh);
      }
      return await finalize(initial, sessionPath);
    });
  } finally {
    await prepared.cleanup();
  }
}
