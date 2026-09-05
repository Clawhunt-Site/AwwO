import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

/**
 * Custom MCP stdio transport for super plugins (P4).
 *
 * The SDK's own StdioClientTransport is unsafe for our threat model: it merges
 * `getDefaultEnvironment()` (leaking the host LOGNAME/SHELL/TERM/USER/HOME into
 * an un-sandboxed child) and SIGTERM/SIGKILLs only the launcher pid (orphaning an
 * `npx -> node` server after the launcher exits). This transport spawns the
 * validated process directly with the EXACT P3-narrowed env (no host inheritance),
 * in its OWN process group (`detached`), drains stderr so a chatty server can't
 * backpressure stdout, and tears the whole tree down with `killpg` — mirroring
 * SuperClaw's Python sidecar exec (start_new_session + os.killpg).
 *
 * It implements the SDK `Transport` interface (newline-delimited JSON-RPC framing)
 * so the SDK `Client` drives the MCP protocol over it.
 */

export interface SuperStdioParams {
  readonly command: string;
  readonly args: readonly string[];
  /** EXACT child env — this is the whole env (no host inheritance). */
  readonly env: Record<string, string>;
  readonly cwd: string;
  /** Grace before escalating SIGTERM -> SIGKILL on close. */
  readonly killGraceMs?: number;
}

export interface SuperStdioDeps {
  readonly spawn?: typeof nodeSpawn;
  /** Signal a process/group (negative pid = group); injectable for tests. */
  readonly kill?: (pid: number, signal: NodeJS.Signals) => void;
  /**
   * Liveness probe: `kill(targetPid, 0)` — throws ESRCH when the target (a negative
   * pid = the whole group) has NO live member. Injectable for tests; defaults to
   * `process.kill(p, 0)`.
   */
  readonly killProbe?: (targetPid: number) => void;
  readonly setTimeoutFn?: typeof setTimeout;
}

export class SuperStdioTransport implements Transport {
  private child?: ChildProcess;
  /**
   * The launcher pid == the process GROUP id (spawned detached). Kept INDEPENDENTLY of
   * `child` so close() can still killpg + reap the group even if the launcher already
   * exited naturally (the `close` handler clears `child`, but a non-pipe-holding
   * descendant can outlive it). Cleared only once the group is confirmed empty.
   */
  private groupPid?: number;
  private buffer = "";
  private closed = false;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(
    private readonly params: SuperStdioParams,
    private readonly deps: SuperStdioDeps = {},
  ) {}

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  async start(): Promise<void> {
    if (this.child) throw new Error("SuperStdioTransport already started");
    const spawn = this.deps.spawn ?? nodeSpawn;
    const child = spawn(this.params.command, [...this.params.args], {
      cwd: this.params.cwd,
      env: this.params.env, // EXACT env — never merged with the host env
      stdio: ["pipe", "pipe", "pipe"],
      detached: true, // own process group so close() can killpg the whole tree
    });
    this.child = child;
    this.groupPid = child.pid ?? undefined; // == pgid; survives a natural launcher exit

    child.on("error", (err) => this.onerror?.(err));
    child.on("close", () => {
      this.child = undefined;
      if (!this.closed) {
        this.closed = true;
        this.onclose?.();
      }
    });
    // Drain stderr so a chatty server never backpressures and stalls stdout replies.
    child.stderr?.on("data", () => {});
    child.stderr?.on("error", () => {});
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.onStdout(chunk));
    child.stdout?.on("error", (err: Error) => this.onerror?.(err));

    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", (err) => reject(err));
    });
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    // Newline-delimited JSON-RPC (the MCP stdio framing).
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let message: JSONRPCMessage;
      try {
        message = JSON.parse(line) as JSONRPCMessage;
      } catch {
        this.onerror?.(new Error("malformed JSON-RPC line from plugin stdout"));
        continue;
      }
      this.onmessage?.(message);
    }
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const stdin = this.child?.stdin;
    if (!stdin) throw new Error("SuperStdioTransport is not connected");
    await new Promise<void>((resolve, reject) => {
      stdin.write(`${JSON.stringify(message)}\n`, (err) => (err ? reject(err) : resolve()));
    });
  }

  async close(): Promise<void> {
    // Use the GROUP pid (not `child`): the launcher may already have exited naturally
    // (clearing `child`) while a non-pipe-holding descendant lingers — close() must
    // still killpg + reap the group.
    const groupPid = this.groupPid;
    this.child = undefined;
    const wasClosed = this.closed;
    this.closed = true;
    if (groupPid == null) {
      if (!wasClosed) this.onclose?.();
      return;
    }
    const kill = this.deps.kill ?? ((pid, signal) => process.kill(pid, signal));
    const probe = this.deps.killProbe ?? ((targetPid) => process.kill(targetPid, 0));
    const setTimeoutFn = this.deps.setTimeoutFn ?? setTimeout;
    // Negative pid signals the whole process GROUP — reaps npx -> node -> ... descendants.
    killGroup(kill, groupPid, "SIGTERM");
    await new Promise<void>((resolve) => setTimeoutFn(() => resolve(), this.params.killGraceMs ?? 500));
    // ALWAYS SIGKILL the group (idempotent if already dead) — never conditional on the
    // launcher having exited: a SIGTERM-resistant DESCENDANT must still be killed even
    // when the launcher itself exited cooperatively on SIGTERM. The group survives as
    // long as any member lives, so this reaches the holdouts.
    killGroup(kill, groupPid, "SIGKILL");
    // POLL the group until it is EMPTY (kill(-pid, 0) → ESRCH), so close() returning is
    // a real "the whole tree is reaped" guarantee — not just "signals were sent", and
    // not limited to pipe-holding descendants. On a pathological holdout the poll bound
    // elapses and this THROWS (surfaced via onerror) so a residue is never mistaken for
    // a clean teardown; groupPid is kept so a retry can re-attempt.
    try {
      await waitGroupEmpty(probe, groupPid, setTimeoutFn);
    } catch (err) {
      this.onerror?.(err as Error);
      throw err;
    }
    this.groupPid = undefined; // confirmed empty
    if (!wasClosed) this.onclose?.();
  }
}

/** Whether the process GROUP (addressed by `-pid`) still has any live member. */
function groupHasMembers(probe: (targetPid: number) => void, pid: number): boolean {
  try {
    probe(-pid);
    return true; // a member exists (or EPERM — not ours to reap; treat as alive)
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH"; // ESRCH = empty group
  }
}

/**
 * Poll until the group is empty. THROWS if the bound elapses with the group still
 * populated — close() must not silently report a clean teardown over a live holdout.
 */
async function waitGroupEmpty(
  probe: (targetPid: number) => void,
  pid: number,
  setTimeoutFn: typeof setTimeout,
  attempts = 250,
  intervalMs = 20,
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (!groupHasMembers(probe, pid)) return;
    await new Promise<void>((resolve) => setTimeoutFn(() => resolve(), intervalMs));
  }
  throw new Error(`process group ${pid} not reaped within ${attempts * intervalMs}ms`);
}

function killGroup(kill: (pid: number, signal: NodeJS.Signals) => void, pid: number, signal: NodeJS.Signals): void {
  // ONLY ever signal the GROUP (negative pid). There is deliberately NO positive-pid
  // fallback: the child was spawned detached, so it is always a group leader and the
  // group exists while any member lives. A positive-pid fallback would be unsafe here —
  // `groupPid` is persisted across the launcher's natural exit, and once the group is
  // empty that pid can be REUSED by an unrelated process, which the fallback would then
  // wrongly signal. An ESRCH on the group means "no member to signal" — nothing to do.
  try {
    kill(-pid, signal);
  } catch {
    /* empty group / already gone — never escalate to the bare pid */
  }
}
