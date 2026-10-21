// Runs one service of the local edition and ends it when the runtime goes away. Windows has no process group that
// ends with its parent: if the runtime were killed (Task Manager, a desktop window that crashed), its services would
// keep running and hold their ports. The runtime holds this wrapper's stdin.
//
// The runtime asks for a stop by writing "stop" there, in the order it chooses (the API before the workers it calls).
// The wrapper then stops the service: with --stdin-stop by closing the service's own stdin (the API stops in order,
// AWWO_STOP_ON_STDIN_CLOSE), otherwise with SIGTERM to its process group, and on Windows, which has no polite signal
// for a console program, by ending its tree at once; what still runs after the grace period is ended by force. A pipe
// that closes without a stop means the runtime has gone (killed, crashed): the service and what it started are ended
// at once, so nothing of an instance works on once its runtime has gone, when the next one may already be starting on
// the same data folder. A terminal's Ctrl-C or hang-up reaches the runtime as well, so SIGINT and SIGHUP are left to
// its stop here; SIGTERM, which the runtime sends when it will wait no longer, ends everything at once too.
//
// When the service has exited, what it started is ended too: elsewhere its process group; on Windows the processes it
// started that still run (Node.js ends its own children with it there; other programs leave theirs). The wrapper then
// exits with the service's own code.
//
//   node awwo-local-reaper.mjs [--stdin-stop] <grace ms> <program> [args...]
import { spawn, spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const polite = argv[0] === '--stdin-stop';
const [graceArg, command, ...args] = polite ? argv.slice(1) : argv;
const grace = Number(graceArg);
if (!command || !Number.isSafeInteger(grace) || grace < 0) {
  console.error('usage: awwo-local-reaper.mjs [--stdin-stop] <grace ms> <program> [args...]');
  process.exit(2);
}
const windows = process.platform === 'win32';
const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows';
// Windows' own programs, by their full path: nothing earlier on PATH can stand in for them.
const system32 = name => `${systemRoot}\\System32\\${name}`;
const started = Date.now();
// Elsewhere the service leads its own process group, so one signal reaches every process it started.
const child = spawn(command, args, { stdio: [polite ? 'pipe' : 'ignore', 'inherit', 'inherit'], detached: !windows, windowsHide: true });
child.stdin?.on('error', () => {});
let stopping = false;
let treeEnded = false;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function groupAlive() {
  if (windows || !child.pid) return false;
  try { process.kill(-child.pid, 0); return true; } catch { return false; }
}
function signalGroup(signal) {
  try { process.kill(-child.pid, signal); } catch { /* already gone */ }
}

/** Ends the service and what it started, now. */
function force() {
  stopping = true;
  if (!child.pid) return;
  if (!windows) return signalGroup('SIGKILL');
  if (child.exitCode !== null || child.signalCode !== null) return;
  const killed = spawnSync(system32('taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  // Its whole tree, ended while it ran: nothing it started is left to look for afterwards.
  if (killed.status === 0) treeEnded = true;
}

function stop() {
  if (stopping) return;
  stopping = true;
  if (polite) child.stdin.end();
  else if (windows) return force();
  else signalGroup('SIGTERM');
  setTimeout(force, grace);
}

/** On Windows, the processes the service started that still run once it has exited, ended with what they started:
 *  each has its id as their parent's and began during its life, so none belongs to a program that took the id since.
 *  PowerShell gets nothing of this wrapper's environment, which is the service's (the API's holds its secrets). */
function endOrphans(exitedAt) {
  const script = "$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process -Filter ('ParentProcessId=' + [int]$env:AWWO_REAPER_SERVICE) | ForEach-Object { '{0} {1}' -f $_.ProcessId, ([DateTimeOffset]($_.CreationDate)).ToUnixTimeMilliseconds() }";
  const listed = spawnSync(system32('WindowsPowerShell\\v1.0\\powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true, timeout: 20_000, env: { SystemRoot: systemRoot, AWWO_REAPER_SERVICE: String(child.pid) } });
  const orphans = String(listed.stdout || '').split(/\r?\n/).map(line => line.trim().split(' ').map(Number))
    .filter(([pid, at]) => Number.isSafeInteger(pid) && pid > 0 && at >= started - 1000 && at <= exitedAt + 1000)
    .map(([pid]) => pid);
  if (orphans.length) spawnSync(system32('taskkill.exe'), [...orphans.flatMap(pid => ['/PID', String(pid)]), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
}

child.on('error', error => {
  console.error(`${command}: ${error.message}`);
  process.exit(127);
});
child.on('exit', async (code, signal) => {
  const exitedAt = Date.now();
  if (windows) {
    if (!treeEnded) endOrphans(exitedAt);
  } else if (groupAlive()) {
    // The service is gone, but not necessarily what it started (its process group): that is ended too, politely
    // first, before this wrapper exits.
    signalGroup('SIGTERM');
    const until = Date.now() + (stopping ? grace : 2000);
    while (groupAlive() && Date.now() < until) await sleep(100);
    if (groupAlive()) signalGroup('SIGKILL');
  }
  process.exit(code ?? (signal ? 128 : 1));
});
let said = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  said = `${said}${chunk}`.slice(-16);
  if (said.includes('stop')) stop();
});
const gone = () => { if (!stopping) force(); };
process.stdin.on('end', gone);
process.stdin.on('close', gone);
process.stdin.on('error', gone);
for (const name of ['SIGINT', 'SIGHUP']) process.on(name, () => {});
process.on('SIGTERM', force);
