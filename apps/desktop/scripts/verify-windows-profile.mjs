import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { windowsProfile } from './windows-profile.mjs';

const profile = windowsProfile(process.argv[2]);
const root = fileURLToPath(new URL('../../../', import.meta.url));
const artifactDir = path.join(root, 'release/windows', profile.environment);
const acceptanceRoot = process.env.AWWO_ACCEPTANCE_ROOT;
if (!acceptanceRoot || !path.isAbsolute(acceptanceRoot)) throw new Error('Set an absolute AWWO_ACCEPTANCE_ROOT for a new acceptance installation');
const installDir = path.join(acceptanceRoot, 'installed', profile.environment);
const evidenceDir = path.join(acceptanceRoot, 'evidence', profile.environment);
fs.mkdirSync(evidenceDir, { recursive: true });
const installerName = fs.readdirSync(artifactDir).find(name => name.endsWith('-setup.exe'));
assert.ok(installerName, 'Missing installer');
const installer = path.join(artifactDir, installerName);
function run(exe, args, env, timeout = 180000) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { env, windowsHide: true, stdio: 'ignore', cwd: acceptanceRoot });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Timed out: ${path.basename(exe)}`)); }, timeout);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
}
function runJson(exe, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], cwd: acceptanceRoot });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Backend command timed out')); }, 180000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => {
      clearTimeout(timer);
      // Lifecycle responses contain control tokens; never include stdout in errors.
      if (code !== 0) return reject(new Error(`Backend command failed (${code})`));
      try { resolve(JSON.parse(output)); } catch { reject(new Error('Backend response was not JSON')); }
    });
  });
}
const installed = await run(installer, ['/S', `/D=${installDir}`], process.env, 600000);
assert.equal(installed.code, 0, 'Silent installation failed');
const executable = path.join(installDir, 'superclaw_desktop.exe');
assert.ok(fs.existsSync(executable), 'Installed desktop executable missing');
const backend = path.join(installDir, 'backend/superclaw-backend');
const resourceFiles = fs.readdirSync(backend, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile());
assert.ok(resourceFiles.length > 0, 'Installed resources are empty');
const defaultInstallMaxPath = Math.max(...resourceFiles.map(entry =>
  path.join(process.env.LOCALAPPDATA, profile.productName, 'backend/superclaw-backend',
    path.relative(backend, path.join(entry.parentPath, entry.name))).length));
assert.ok(defaultInstallMaxPath < 260, 'Default installation exceeds classic Win32 file path limit');
assert.equal(JSON.parse(fs.readFileSync(path.join(backend, 'build-profile.json'), 'utf8')).app_env, profile.environment);
for (const file of ['superclaw-backend.exe', 'node-runtime/node.exe', 'node-runtime/server/dist/index.js']) {
  assert.ok(fs.existsSync(path.join(backend, file)), `Missing installed resource: ${file}`);
}
// Deliberately launch with conflicting inherited identities to exercise isolation.
const env = { ...process.env };
for (const name of Object.keys(env)) {
  if (name.startsWith('SUPERCLAW_') || name.startsWith('CLAWHUNT_') || name.startsWith('AWWO_')) delete env[name];
}
Object.assign(env, {
  APP_ENV: profile.environment === 'production' ? 'staging' : 'production',
  AWWO_DESKTOP_DATA_ROOT: path.join(acceptanceRoot, 'data'),
  SUPERCLAW_HOME: path.join(acceptanceRoot, 'must-not-use'),
  SUPERCLAW_STATE_PATH: path.join(acceptanceRoot, 'must-not-use/state.db'),
  SUPERCLAW_ARTIFACT_DIR: path.join(acceptanceRoot, 'must-not-use/artifacts'),
  SUPERCLAW_DESKTOP_WORKDIR: path.join(acceptanceRoot, 'must-not-use'),
  SUPERCLAW_TELEMETRY_ENABLED: '0',
  SUPERCLAW_TELEMETRY_KILL: '1',
});
const launchFile = path.join(evidenceDir, 'launch.json');
assert.equal((await run(executable, [], { ...env, SUPERCLAW_DESKTOP_SMOKE_FILE: launchFile })).code, 0);
const launch = JSON.parse(fs.readFileSync(launchFile, 'utf8'));
assert.equal(launch.productName, profile.productName);
assert.equal(launch.releaseChannel, profile.releaseChannel);
assert.equal(launch.appEnvironment, profile.environment);
assert.equal(path.resolve(launch.dataRoot), path.join(acceptanceRoot, 'data', profile.environment));
assert.equal(path.resolve(launch.statePath), path.join(acceptanceRoot, 'data', profile.environment, 'state/state.db'));
assert.equal(path.resolve(launch.artifactDir), path.join(acceptanceRoot, 'data', profile.environment, 'state/artifacts'));
assert.equal(path.resolve(launch.cliExecutable), path.join(backend, 'superclaw-backend.exe'));
const runtimeFile = path.join(evidenceDir, 'runtime.json');
const runtimeExit = await run(executable, [], { ...env,
  SUPERCLAW_DESKTOP_RUNTIME_SMOKE_FILE: runtimeFile,
  SUPERCLAW_DESKTOP_RUNTIME_SMOKE_STATE_PATH: path.join(acceptanceRoot, 'data', profile.environment, 'acceptance.db'),
}, 360000);
const runtime = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
assert.equal(runtime.success, true, runtime.error || 'Runtime smoke failed');
assert.equal(runtimeExit.code, 0);
assert.equal(runtime.probe.ok, true);
assert.equal(runtime.stop.stopped, true);
assert.equal(runtime.probeAfterStop.ok, false);
// The shell smoke intentionally stops as soon as Python is live. Node starts
// asynchronously and can still be loading then; keep a separate owned lifecycle
// alive until the database and gateway are genuinely ready before stopping it.
const statePath = path.join(acceptanceRoot, 'data', profile.environment, `subservices-${crypto.randomUUID()}`, 'state.db');
const runDir = path.join(path.dirname(statePath), 'run');
const serviceEnv = { ...env, APP_ENV: profile.environment,
  SUPERCLAW_HOME: path.dirname(statePath), SUPERCLAW_STATE_PATH: statePath,
  SUPERCLAW_DESKTOP_WORKDIR: path.dirname(statePath),
  SUPERCLAW_ARTIFACT_DIR: path.join(path.dirname(statePath), 'artifacts'),
  SUPERCLAW_NODE_HOME: path.join(path.dirname(statePath), 'node-runtime'),
  SUPERCLAW_SHELL_CONFIG_PATH: path.join(path.dirname(statePath), 'config.json'),
};
// Windows marker-only teardown deliberately refuses unsigned process identities.
// Model the actual desktop lifetime with an owned child whose exit drives the
// backend's self-cleaning watchdog; never signal a PID recovered from a marker.
const watcher = spawn(process.execPath, ['-e',
  `setInterval(() => { try { process.kill(${process.pid}, 0); } catch { process.exit(0); } }, 250);`,
], { windowsHide: true, stdio: 'ignore' });
await new Promise((resolve, reject) => { watcher.once('spawn', resolve); watcher.once('error', reject); });
let subservices;
let servicePid;
try {
  const started = await runJson(launch.cliExecutable,
    ['desktop', 'start', '--state-path', statePath, '--boot-timeout', '60', '--watch-ui-pid', String(watcher.pid)], serviceEnv);
  assert.equal(started.ok, true);
  assert.equal(started.handle?.owned, true, 'Acceptance must own its service');
  assert.ok(Number.isInteger(started.handle.pid) && started.handle.pid > 0);
  servicePid = started.handle.pid;
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline && !subservices) {
    try {
      const node = JSON.parse(fs.readFileSync(path.join(runDir, 'node-service.json'), 'utf8'));
      const gateway = JSON.parse(fs.readFileSync(path.join(runDir, 'gateway-marker.json'), 'utf8'));
      assert.match(node.base_url, /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.ok(Number.isInteger(gateway.port) && gateway.port > 0 && gateway.port < 65536);
      const nodeHealth = await (await fetch(`${node.base_url}/api/health`, { signal: AbortSignal.timeout(2500) })).json();
      const gatewayHealth = await (await fetch(`http://127.0.0.1:${gateway.port}/health`, { signal: AbortSignal.timeout(2500) })).json();
      if (nodeHealth.status === 'ok' && gatewayHealth.instanceId === gateway.instanceId && gatewayHealth.upstream?.reachable === true) {
        subservices = { nodePid: node.pid, gatewayPid: gateway.pid, gatewayPort: gateway.port,
          nodeDatabaseHealth: 'passed', gatewayUpstreamHealth: 'passed' };
      }
    } catch { /* Markers and services become ready asynchronously. */ }
    if (!subservices) await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(subservices, 'Node database and gateway upstream did not become healthy');
} finally {
  watcher.kill();
}
for (const pid of [servicePid, subservices.nodePid, subservices.gatewayPid]) {
  let alive = true;
  for (let attempt = 0; attempt < 80 && alive; attempt++) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; else throw error; }
    if (alive) await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.equal(alive, false, `Owned subservice ${pid} survived desktop stop`);
}
const report = { environment: profile.environment, installer, installDir, version: launch.version,
  installedResourceFiles: resourceFiles.length,
  defaultInstallMaxPath,
  sha256: crypto.createHash('sha256').update(fs.readFileSync(installer)).digest('hex'),
  backendSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(backend, 'superclaw-backend.exe'))).digest('hex'),
  launch: 'passed', runtimeStartProbeStop: 'passed',
  subservices: { ...subservices, stopped: true },
  validatedAt: new Date().toISOString(), externalModelExecution: 'not exercised',
};
fs.writeFileSync(path.join(artifactDir, 'acceptance.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
