// Gateway self-lifecycle — ALL in Node (no Python). The gateway binds a FIXED port, so a
// crash / kill -9 can leave a prior gateway holding it. Before binding, the gateway reaps a
// stale orphan it previously started, gated by the kernel (pid, start-time) signature — never
// by HTTP — so it can identify its own orphan even when the upstream is slow. A process whose
// identity cannot be established is left alone and its marker preserved (never a false
// "recycled" conclusion). Mirrors superclaw.node_runtime's identity gate, but Node-native.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function superHome(): string {
  const env = process.env.SUPERCLAW_HOME?.trim();
  return env || join(homedir(), ".superclaw");
}

export function gatewayMarkerPath(): string {
  return join(superHome(), "run", "gateway-marker.json");
}

export interface GatewayMarker {
  pid: number;
  startSignature: string | null;
  instanceId: string;
  port: number;
}

// The kernel-reported start time of `pid` — a stable identity (a recycled pid gets a different
// start time). Returns null on any failure (pid gone, unsupported OS, ps blip) — callers MUST
// treat null as "identity unknown", never a positive conclusion. Retries a transient blip.
export function processStartSignature(pid: number, attempts = 3): string | null {
  if (process.platform === "win32") return null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
      }).trim();
      if (out) return out;
    } catch {
      // pid gone or transient failure — fall through to retry/None
    }
  }
  return null;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM ⇒ alive but owned by another user; ESRCH ⇒ gone.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// A blocking sleep (teardown path only, rare) so SIGTERM gets a grace window before SIGKILL.
function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // SharedArrayBuffer unavailable — skip the grace wait.
  }
}

// Terminate the process GROUP led by `pid` (the gateway is spawned detached, so it leads its
// group and its tsx/node child is reaped too). SIGTERM first with a short grace window, then
// SIGKILL if it is still alive. Best-effort; never throws.
export function terminateProcessGroup(pid: number, graceMs = 1500): void {
  try {
    process.kill(-pid, "SIGTERM"); // negative pid = the process group
  } catch {
    return; // group already gone
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return;
    sleepSync(50);
  }
  if (isAlive(pid)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // gone between the check and the signal
    }
  }
}

export function readGatewayMarker(): GatewayMarker | null {
  try {
    const parsed = JSON.parse(readFileSync(gatewayMarkerPath(), "utf8")) as GatewayMarker;
    return typeof parsed?.pid === "number" ? parsed : null;
  } catch {
    return null;
  }
}

export function writeGatewayMarker(marker: GatewayMarker): void {
  try {
    const path = gatewayMarkerPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(marker), "utf8");
  } catch {
    // best-effort
  }
}

export function removeGatewayMarker(): void {
  try {
    rmSync(gatewayMarkerPath());
  } catch {
    // already gone
  }
}

export type PrecleanReason =
  | "no_marker"
  | "cleared_dead"
  | "reaped"
  | "cleared_recycled"
  | "identity_unknown";

// Injectable OS edges (defaulted to the real implementations) so the decision logic is
// deterministically unit-testable without spawning processes.
export interface PrecleanDeps {
  alive?: (pid: number) => boolean;
  signature?: (pid: number) => string | null;
  terminate?: (pid: number) => void;
}

// Reap a stale gateway WE started in a prior run before binding. Returns a structured reason
// so the caller refuses to proceed (and overwrite the marker) when identity is unknown.
export function precleanStaleGateway(deps: PrecleanDeps = {}): PrecleanReason {
  const alive = deps.alive ?? isAlive;
  const signature = deps.signature ?? processStartSignature;
  const terminate = deps.terminate ?? terminateProcessGroup;
  const marker = readGatewayMarker();
  if (!marker) return "no_marker";
  const { pid, startSignature: prevSig } = marker;
  if (typeof pid !== "number") {
    removeGatewayMarker();
    return "cleared_dead";
  }
  if (!alive(pid)) {
    removeGatewayMarker();
    return "cleared_dead";
  }
  const liveSig = signature(pid);
  // Conclude "recycled" ONLY when BOTH signatures are present and disagree. If either is
  // missing, identity is unknown → keep the marker (don't lose a real orphan's evidence).
  if (liveSig === null || typeof prevSig !== "string" || !prevSig) {
    return "identity_unknown";
  }
  if (liveSig === prevSig) {
    terminate(pid);
    removeGatewayMarker();
    return "reaped";
  }
  removeGatewayMarker();
  return "cleared_recycled";
}
