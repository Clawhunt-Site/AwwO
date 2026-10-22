// AwwO 本地版's runtime: starts the hosted product's services on this computer and keeps them running until it is
// stopped (Ctrl-C, a signal, the end of its parent process, or its stdin closing with --stop-on-stdin-close).
//
//   npm run local                                   from a checkout, after npm run setup:local
//   npm run local -- --reset-password               the same, with a new sign-in password (admin-credentials.txt)
//   node scripts/awwo-local.mjs --events ...        for a desktop window: one JSON object per line on stdout
//   node scripts/awwo-local.mjs <resources> <state> <parent pid>
//                                                   the contract apps/macos/AwwOLocal.swift already speaks
//
// What this computer cannot run is left out, and the app shows it as not ready, as the hosted site would: the
// managed execution (直接执行) without Docker, renders without Chrome and ffmpeg.
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { port as validPort } from './awwo-saas-lib.mjs';
import {
  allocatePorts, apiEnvironment, browserCandidates, dockerEnvironment, findOnPath, instanceContainerQuery, loadLocalProfile,
  localLayout, localOrigin, localState, osLock, portIsFree, postgresPort, postgresSettings, protectStateDirectory,
  PASSWORD_RESET_PENDING, passwordResetApplied, resetId, resetOwnerPassword, resolvePostgresBin, serviceEnvironments, systemEnvironment,
  windowsTool, withPostgresInclude, writeFileAtomic, writeOwnerCredentials,
} from './awwo-local-lib.mjs';
import { createLocalWebServer } from './awwo-local-web.mjs';

const REAPER = fileURLToPath(new URL('./awwo-local-reaper.mjs', import.meta.url));
/** How long a service is given to finish after it is asked to stop. The API's own stop waits up to 30 s for a media
 *  submission in flight to record its task id (deploy/saas/compose.yml gives it 45 s); the others need less. */
const STOP_GRACE_MS = 20_000;
const API_STOP_GRACE_MS = 45_000;
/** How long a service may take to come up. A warm start takes seconds; a first one on a slow or busy disk, or one an
 *  antivirus scans file by file, can take minutes (measured: the Pi worker 41 s on this computer under load). Past this
 *  the start fails and names the service. The API also runs its migrations first. */
const WORKER_START_MS = 180_000;
const API_START_MS = 300_000;
const PUBLIC_SITE = 'https://awwo.clawhunt.store';
/** Services without which the app does not work: one that stops ends the runtime. */
const REQUIRED = new Set(['pi', 'agents', 'api']);

export function parseArguments(argv) {
  const options = { state: '', resources: '', build: '', events: false, parentPid: 0, docker: true, stopOnStdinClose: false, verbose: false, resetPassword: false };
  if (argv.length && !argv[0].startsWith('--')) {
    // The Mac shell's contract: <resources> <state> <parent pid>, events on stdout.
    const [resources, state, parent] = argv;
    if (!resources || !state || !parent || argv.length > 3) throw new Error('usage: awwo-local.mjs <resources> <state> <parent pid>');
    return { ...options, resources: path.resolve(resources), state: path.resolve(state), parentPid: positive(parent, 'parent pid'), events: true };
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index += 1];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === '--state') options.state = path.resolve(value());
    else if (arg === '--resources') options.resources = path.resolve(value());
    else if (arg === '--build') options.build = path.resolve(value());
    else if (arg === '--parent-pid') options.parentPid = positive(value(), '--parent-pid');
    else if (arg === '--events') options.events = true;
    else if (arg === '--no-docker') options.docker = false;
    else if (arg === '--stop-on-stdin-close') options.stopOnStdinClose = true;
    else if (arg === '--verbose') options.verbose = true;
    else if (arg === '--reset-password') options.resetPassword = true;
    else throw new Error(`Unknown option ${arg}`);
  }
  return options;
}
function positive(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${name} must be a process id`);
  return number;
}

function reporter(events) {
  const text = events ? process.stderr : process.stdout;
  return {
    event(object) { if (events) process.stdout.write(`${JSON.stringify(object)}\n`); },
    info(message) { text.write(`${message}\n`); },
    error(message) { process.stderr.write(`${message}\n`); },
  };
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** One runtime per data folder: two would share one database directory, and the second would take the first's
 *  PostgreSQL for one an ended runtime left, and restart it. The lock is the operating system's (osLock), so it goes
 *  with this process however it ends: there is never a stale one to take over. */
export async function acquireLock(file, { lock = osLock } = {}) {
  const held = await lock(file, { exclusive: true });
  if (!held) throw new Error(`AwwO 本地版 is already running for this data folder (${path.dirname(file)})`);
  return held.release;
}

/** What a runtime runs is its code's (the resources) and its build's, shared by every runtime of them whatever its
 *  data folder. setup:local, which replaces both, takes their locks exclusively (scripts/awwo-local-setup.mjs); each
 *  runtime holds those it has, shared, for as long as it runs (localLayout: code or a build no setup serves, a packaged
 *  app's, has none, and nothing is written into it). A lock it cannot take stops the start. */
export async function holdBuild(layout, { lock = osLock } = {}) {
  if (!existsSync(layout.build)) throw new Error('AwwO 本地版 is not set up: run npm run setup:local.');
  const releases = [];
  const releaseAll = async () => { for (const release of [...releases].reverse()) await release(); };
  try {
    for (const file of [layout.codeLock, layout.buildLock].filter(Boolean)) {
      await mkdir(path.dirname(file), { recursive: true });
      const held = await lock(file, { exclusive: false });
      if (!held) throw new Error('npm run setup:local is updating AwwO 本地版: start it again once setup has finished.');
      releases.push(held.release);
    }
  } catch (error) {
    await releaseAll();
    throw error;
  }
  return releaseAll;
}

const tool = (bin, name) => path.join(bin, process.platform === 'win32' ? `${name}.exe` : name);

function runTool(command, args, { env, input, timeout = 120_000, quiet = false } = {}) {
  // pg_ctl start leaves the server holding whatever pipes it was given, so a call that starts one gets none.
  const result = spawnSync(command, args, { env, input, encoding: 'utf8', timeout, windowsHide: true, stdio: quiet ? 'ignore' : 'pipe' });
  if (result.error) throw result.error;
  return result;
}
const lastLines = result => String(result.stderr || result.stdout || '').trim().split(/\r?\n/).slice(-6).join('\n');

async function startPostgres({ bin, state, port, password, env, report }) {
  const data = state.postgres;
  const pgEnv = { ...env, PGHOST: '127.0.0.1', PGPORT: String(port), PGUSER: 'awwo', PGPASSWORD: password, PGCONNECT_TIMEOUT: '10' };
  const log = path.join(state.logs, 'postgres.log');
  // initdb reads the password from a file, removed once it has run, or here, after a start that ended meanwhile.
  const passwordFile = path.join(state.dir, '.initdb-password');
  await rm(passwordFile, { force: true });
  if (!existsSync(path.join(data, 'PG_VERSION'))) {
    report.info('Creating the local database (first start)...');
    await writeFileAtomic(passwordFile, `${password}\n`);
    try {
      const init = runTool(tool(bin, 'initdb'), ['-D', data, '-U', 'awwo', '--auth-host=scram-sha-256', '--auth-local=scram-sha-256', '--encoding=UTF8', '--locale=C', '--pwfile', passwordFile], { env, timeout: 300_000 });
      if (init.status !== 0) throw new Error(`initdb failed:\n${lastLines(init)}`);
    } finally {
      await rm(passwordFile, { force: true });
    }
  }
  const conf = path.join(data, 'postgresql.conf');
  const included = withPostgresInclude(readFileSync(conf, 'utf8'));
  if (included !== null) await writeFileAtomic(conf, included);
  await writeFile(path.join(data, 'awwo-local.conf'), postgresSettings(port));
  const stop = (mode = 'fast') => {
    const stopped = runTool(tool(bin, 'pg_ctl'), ['-D', data, '-m', mode, '-w', '-t', '120', 'stop'], { env, timeout: 180_000 });
    // Not running at all is stopped too; anything else is checked against the server's own status.
    if (stopped.status === 0 || runTool(tool(bin, 'pg_ctl'), ['-D', data, 'status'], { env }).status === 3) return;
    throw new Error(`PostgreSQL did not stop (${data}):\n${lastLines(stopped)}`);
  };
  // A server left by a runtime that ended without stopping it is restarted on this start's settings, once what of
  // that run still uses it (an API finishing its own stop) has let go of it, or after a minute.
  if (runTool(tool(bin, 'pg_ctl'), ['-D', data, 'status'], { env }).status === 0) {
    let leftover = 0;
    try { leftover = postgresPort(readFileSync(path.join(data, 'postmaster.pid'), 'utf8')); } catch { /* gone meanwhile */ }
    const clients = "SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'client backend' AND pid <> pg_backend_pid()";
    for (let second = 0; leftover && second < 60; second += 1) {
      let count = 0;
      try {
        const asked = runTool(tool(bin, 'psql'), ['-d', 'postgres', '-Atc', clients], { env: { ...pgEnv, PGPORT: String(leftover) }, timeout: 15_000 });
        if (asked.status === 0) count = Number(asked.stdout.trim()) || 0;
      } catch { /* no answer: nothing to wait for */ }
      if (!count) break;
      if (!second) report.info(`The last run's services still use the database (${count} connection${count === 1 ? '' : 's'}); waiting for them to finish...`);
      await sleep(1000);
    }
    stop();
  }
  const start = runTool(tool(bin, 'pg_ctl'), ['-D', data, '-l', log, '-w', '-t', '120', 'start'], { env, timeout: 180_000, quiet: true });
  if (start.status !== 0) throw new Error(`PostgreSQL did not start; see ${log}`);
  const found = runTool(tool(bin, 'psql'), ['-d', 'postgres', '-Atc', "SELECT 1 FROM pg_database WHERE datname = 'awwo'"], { env: pgEnv });
  if (found.status !== 0) { stop(); throw new Error(`Cannot read the local database:\n${lastLines(found)}`); }
  if (found.stdout.trim() !== '1') {
    const created = runTool(tool(bin, 'createdb'), ['awwo'], { env: pgEnv });
    if (created.status !== 0) { stop(); throw new Error(`Cannot create the local database:\n${lastLines(created)}`); }
  }
  return { stop };
}

/** What this computer can run of the optional services. */
function detectCapabilities({ layout, options, env, report }) {
  const caps = { python: '', docker: '', image: '', brokerCore: false, render: null };
  // A venv counts only once setup has finished installing into it (its stamp), so a cut install falls back.
  if (existsSync(layout.python) && existsSync(layout.pythonInstalled)) caps.python = layout.python;
  else report.info('Python worker not installed: the JavaScript worker runs OpenAI Agents (npm run setup:local installs it).');
  if (options.docker) {
    const docker = env.AWWO_LOCAL_DOCKER || findOnPath('docker', { env });
    const ask = args => {
      try { return runTool(docker, args, { env: dockerEnvironment(env), timeout: 20_000 }); } catch { return { status: 1, stdout: '' }; }
    };
    const server = docker ? ask(['version', '--format', '{{.Server.Version}}']) : null;
    const tag = existsSync(layout.workspaceTag) ? readFileSync(layout.workspaceTag, 'utf8').trim() : '';
    const core = existsSync(layout.brokerCore) && existsSync(path.join(path.dirname(layout.brokerCore), 'awwo-build.json'));
    if (!docker) report.info('Docker not found: 直接执行 stays off.');
    else if (server.status !== 0 || !server.stdout.trim()) report.info('Docker is not running: 直接执行 stays off.');
    else if (!tag || ask(['image', 'inspect', '--format', '{{.Id}}', tag]).status !== 0) report.info('The workspace image is not built: 直接执行 stays off (npm run setup:local builds it).');
    else if (!core) report.info('The managed execution core is not built: 直接执行 stays off (npm run setup:local builds it).');
    else Object.assign(caps, { docker, image: tag, brokerCore: true });
  }
  const chrome = env.AWWO_LOCAL_CHROME || browserCandidates(process.platform, env).find(file => existsSync(file)) || '';
  const ffmpeg = env.AWWO_LOCAL_FFMPEG || findOnPath('ffmpeg', { env });
  const ffprobe = env.AWWO_LOCAL_FFPROBE || findOnPath('ffprobe', { env });
  if (chrome && ffmpeg && ffprobe && existsSync(path.join(path.dirname(layout.render), 'node_modules'))) caps.render = { chrome, ffmpeg, ffprobe };
  else report.info('Renders stay off: they need Chrome or Edge, ffmpeg and ffprobe, and npm run setup:local.');
  return caps;
}

/** Removes this instance's workspace containers: a broker that was ended (Windows ends it at once) cannot remove its
 *  own, and they would run on under Docker for up to a day. Only containers labelled with this instance are touched.
 *  Returns how many it removed. A Docker that will not list or remove them is an error: they may still run. */
export function removeInstanceContainers(docker, instance, { run = spawnSync, env = process.env } = {}) {
  const options = { encoding: 'utf8', windowsHide: true, timeout: 30_000, env: dockerEnvironment(env) };
  const listed = run(docker, instanceContainerQuery(instance), options);
  if (listed.status !== 0) {
    // Whether a Docker that will not list them runs them still cannot be told (a socket this account may not use, an
    // engine that keeps its containers running while it restarts): it is reported, never taken for none.
    throw new Error(`Cannot check this instance's workspace containers (docker ps: ${lastLines(listed) || listed.error?.message || `exit ${listed.status}`}). If Docker Desktop was quit, they stopped with it; otherwise remove those labelled awwo.workspace-instance=${instance} once Docker answers.`);
  }
  const ids = String(listed.stdout || '').split(/\s+/).filter(id => /^[0-9a-f]{12,64}$/.test(id));
  if (!ids.length) return 0;
  const removed = run(docker, ['rm', '--force', ...ids], options);
  if (removed.status !== 0) {
    throw new Error(`Could not remove ${ids.length} workspace container${ids.length === 1 ? '' : 's'} of this instance (${ids.join(' ')}): ${lastLines(removed) || removed.error?.message || `docker exit ${removed.status}`}`);
  }
  return ids.length;
}

/** Ends a wrapper and its service now: on Windows its whole tree, elsewhere with SIGTERM, which the wrapper takes as
 *  "now" and passes on to its service's process group as SIGKILL. */
function endWrapper(child) {
  if (child.exitCode !== null || !child.pid) return;
  if (process.platform === 'win32') spawnSync(windowsTool('taskkill'), ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else child.kill('SIGTERM');
}

function startService({ name, command, args, env, state, cwd, echo, grace = STOP_GRACE_MS, polite = false }) {
  const log = createWriteStream(path.join(state.logs, `${name}.log`), { flags: 'a' });
  log.on('error', () => {});
  log.write(`\n=== ${new Date().toISOString()} start\n`);
  const child = spawn(process.execPath, [REAPER, ...(polite ? ['--stdin-stop'] : []), String(grace), command, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const forward = chunk => {
    if (!log.writableEnded) log.write(chunk);
    if (echo) for (const line of String(chunk).split(/\r?\n/)) if (line) process.stderr.write(`[${name}] ${line}\n`);
  };
  child.stdout.on('data', forward);
  child.stderr.on('data', forward);
  // The runtime ending closes this pipe, and the wrapper then ends the service.
  child.stdin.on('error', () => {});
  let code = null;
  child.once('exit', (status, signal) => { code = status ?? signal; });
  // 'close' comes after the last output: the log ends only then.
  const exited = new Promise(resolve => child.once('close', () => {
    log.end(`=== ${new Date().toISOString()} exit ${code}\n`);
    resolve(code);
  }));
  // A stop is asked for in words: a pipe that closes without them tells the wrapper the runtime is gone.
  return { name, child, exited, grace, retired: false, stop() { if (!child.stdin.destroyed) child.stdin.end('stop\n'); } };
}

/** Polls a health URL until `accept(status, body)` or the service exits or the time is up. */
async function waitHealthy(service, url, { timeout = 60_000, token = '', accept = status => status === 200 } = {}) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (service.child.exitCode !== null) throw new Error(`${service.name} exited while starting; see its log`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000), headers: token ? { authorization: `Bearer ${token}` } : {} });
      const body = await response.json().catch(() => ({}));
      if (accept(response.status, body)) return body;
    } catch { /* not listening yet */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`${service.name} did not become ready within ${Math.round(timeout / 1000)} s; see its log`);
}
// A worker in personal-key mode has no default model of its own until a person's run brings one: that is ready here.
const unconfiguredOk = runtime => (status, body) => status === 200
  || (status === 503 && body?.status === 'unconfigured' && body?.configured === false && (runtime === 'pi' ? typeof body.piVersion === 'string' : body.runtime === runtime));

/** Listens on the web port at `host`. For ::1 an address this computer does not have is no failure (there is then no
 *  IPv6 loopback to answer for); any other error is: browsers try *.localhost on ::1 first, so whatever else holds
 *  that port there would receive the app's requests and sign-ins. */
function listenWeb(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', error => {
      if (host === '::1' && ['EADDRNOTAVAIL', 'EAFNOSUPPORT'].includes(error?.code)) resolve(false);
      else reject(new Error(`Port ${port} on ${host} is in use (${error?.code}); close what holds it, or set AWWO_LOCAL_WEB_PORT in local.env`));
    });
    server.listen(port, host, () => resolve(true));
  });
}

export async function runLocal(options, { onStopped = () => {} } = {}) {
  const report = reporter(options.events);
  const layout = localLayout({ ...(options.resources ? { resources: options.resources } : {}), ...(options.build ? { build: options.build } : {}) });
  const state = localState(options.state || path.join(layout.resources, '.local', 'awwo-local', 'state'));
  const services = [];
  const webServers = [];
  let database, profile, capabilities, releaseLock = async () => {}, releaseBuild = async () => {}, stopping, stopBegan = 0, forced = false;
  const stopped = code => {
    report.event({ event: 'stopped', code });
    report.info(code ? `AwwO 本地版 has stopped (${code}).` : 'AwwO 本地版 has stopped.');
    onStopped(code);
  };

  const shutdown = code => stopping ??= (async () => {
    stopBegan = Date.now();
    let failed = false;
    for (const server of webServers) { server.close(); server.closeAllConnections(); }
    // The API first, while the workers it calls and the database it records into still run; then the others.
    for (const group of [services.filter(service => service.name === 'api'), services.filter(service => service.name !== 'api')]) {
      for (const service of group) service.stop();
      const longest = Math.max(0, ...group.map(service => service.grace));
      await Promise.race([Promise.all(group.map(service => service.exited)), sleep(longest + 10_000)]);
    }
    for (const service of services) endWrapper(service.child);
    if (capabilities?.docker && profile) {
      try { removeInstanceContainers(capabilities.docker, profile.AWWO_LOCAL_INSTANCE); } catch (error) { failed = true; report.error(error.message); }
    }
    try { database?.stop(); } catch (error) { failed = true; report.error(error.message); }
    await releaseBuild();
    await releaseLock();
    process.exitCode = failed && !code ? 1 : code;
    stopped(process.exitCode);
  })();
  const onSignal = () => {
    // A signal while the stop runs does not wait for the services: their wrappers end them now. One within a second of
    // the stop's start is the same request: npm run passes the terminal's Ctrl-C on to the runtime, which has it from
    // the terminal too. A database start or stop already under way runs to its end first (it holds the runtime until
    // it returns).
    if (stopping && !forced) {
      if (Date.now() - stopBegan < 1000) return;
      forced = true;
      report.error('Stopping now.');
      for (const service of services) endWrapper(service.child);
      try { database?.stop('immediate'); } catch (error) { report.error(error.message); }
      void Promise.allSettled([releaseBuild(), releaseLock()]).then(() => stopped(130));
      return;
    }
    void shutdown(0);
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, onSignal);
  if (options.parentPid) setInterval(() => { if (!alive(options.parentPid)) void shutdown(0); }, 2000).unref();
  if (options.stopOnStdinClose) { process.stdin.on('end', () => void shutdown(0)); process.stdin.resume(); }

  const fail = message => {
    if (stopping) return;
    report.event({ event: 'error', message });
    report.error(message);
    void shutdown(1);
  };

  try {
    await mkdir(state.dir, { recursive: true, mode: 0o700 });
    // Before any secret is written: the folder is this account's alone.
    protectStateDirectory(state.dir);
    for (const dir of [state.logs, state.media, state.broker, state.renderTmp]) await mkdir(dir, { recursive: true });
    releaseLock = await acquireLock(state.lock);
    releaseBuild = await holdBuild(layout);
    // Under the folder's lock: no other runtime is using these settings as they change.
    if (options.resetPassword && await resetOwnerPassword(state)) report.info(`The owner's sign-in password was reset; the new one is in ${state.credentials}.`);
    profile = await loadLocalProfile(state);
    // Asked now, or asked before by a start that ended before its API did: the API sets it as it starts (once per
    // reset id), and the sign-in file names it first (a reset cut short between its two files left the old one there).
    const reset = resetId(profile[PASSWORD_RESET_PENDING]);
    if (reset) await writeOwnerCredentials(state, profile);
    const node = existsSync(layout.node) ? layout.node : Number(process.versions.node.split('.')[0]) >= 24 ? process.execPath : '';
    if (!node) throw new Error('AwwO 本地版 needs Node.js 24 for its services: run npm run setup:local.');
    if (!existsSync(layout.api)) throw new Error('The AwwO API is not built: run npm run setup:local.');
    const pgBin = resolvePostgresBin(layout);
    if (!pgBin) throw new Error('PostgreSQL is not installed: run npm run setup:local (or set AWWO_LOCAL_PG_BIN).');
    capabilities = detectCapabilities({ layout, options, env: process.env, report });
    const webPort = validPort(profile.AWWO_LOCAL_WEB_PORT, 'AWWO_LOCAL_WEB_PORT');
    const ports = await allocatePorts(webPort, { isFree: async port => await portIsFree(port) && (port !== webPort || await portIsFree(port, '::1')) });
    const system = systemEnvironment();
    report.event({ event: 'status', step: 'database' });
    database = await startPostgres({ bin: pgBin, state, port: ports.database, password: profile.AWWO_LOCAL_DB_PASSWORD, env: system, report });
    const launch = (name, command, args, env, extra = {}) => {
      // Nothing starts once the runtime is stopping: a service started then would be missed by the stop.
      if (stopping) throw new Error('AwwO 本地版 is stopping');
      const service = startService({ name, command, args, env, state, cwd: layout.resources, echo: options.verbose && !options.events, ...extra });
      services.push(service);
      // Watched from its start: a required service that stops at any point ends the runtime, during startup too.
      service.exited.then(code => {
        if (stopping || service.retired) return;
        if (REQUIRED.has(name)) fail(`${name} stopped (${code}); see its log in ${state.logs}`);
        else report.info(`${name} stopped (${code}); see its log in ${state.logs}`);
      });
      return service;
    };
    const envs = serviceEnvironments({ profile, ports, state, capabilities, system, resetPassword: reset });
    report.event({ event: 'status', step: 'workers' });
    await waitHealthy(launch('pi', node, [layout.pi], envs.pi), `http://127.0.0.1:${ports.pi}/health`, { timeout: WORKER_START_MS, accept: unconfiguredOk('pi') });
    let agents = null;
    if (capabilities.python) {
      const python = launch('agents', capabilities.python, [layout.agentsPython], envs.agentsPython);
      python.retired = true; // until it is healthy, its exit falls back instead of ending the runtime
      try {
        await waitHealthy(python, `http://127.0.0.1:${ports.agents}/health`, { timeout: WORKER_START_MS });
        python.retired = false;
        agents = python;
      } catch (error) {
        report.info(`The Python worker did not start (${error.message}); the JavaScript worker runs OpenAI Agents instead.`);
        python.stop();
        await python.exited;
      }
    }
    if (!agents) {
      agents = launch('agents', node, [layout.agentsJs], envs.agentsJs);
      await waitHealthy(agents, `http://127.0.0.1:${ports.agents}/health`, { timeout: WORKER_START_MS, accept: unconfiguredOk('openai-agents') });
    }
    // The optional services: one that does not come up is stopped and left out, and the API is told only of those
    // that did (apiEnvironment).
    if (envs.broker) {
      try { removeInstanceContainers(capabilities.docker, profile.AWWO_LOCAL_INSTANCE); } catch (error) { report.info(error.message); }
    }
    const optional = [
      // Only a ready broker: one that answers "unconfigured" has no core or no workspace image it can use.
      envs.broker && { key: 'broker', start: () => launch('broker', node, [layout.broker], envs.broker), url: `http://127.0.0.1:${ports.broker}/health`, token: profile.AWWO_OPENMAUS_TOKEN },
      envs.render && { key: 'render', start: () => launch('render', node, [layout.render], envs.render), url: `http://127.0.0.1:${ports.render}/health` },
    ].filter(Boolean);
    const up = new Set();
    await Promise.all(optional.map(async item => {
      const service = item.start();
      try {
        await waitHealthy(service, item.url, { timeout: WORKER_START_MS, token: item.token });
        up.add(item.key);
      } catch (error) {
        service.retired = true;
        service.stop();
        report.info(`${item.key} is off: ${error.message}`);
      }
    }));
    report.event({ event: 'status', step: 'api' });
    // The API stops in order when its stdin closes (AWWO_STOP_ON_STDIN_CLOSE): Windows has no polite signal for it.
    const api = launch('api', layout.api, [], apiEnvironment(envs, up), { polite: true, grace: API_STOP_GRACE_MS });
    await waitHealthy(api, `http://127.0.0.1:${ports.api}/api/v1/health`, { timeout: API_START_MS });
    // It set the new password before it answered (BootstrapAdmin runs first): the reset is done. A mark that cannot be
    // cleared now does nothing at the next start (the API has applied its id), so it does not stop this one.
    if (reset) await passwordResetApplied(state).catch(error => report.info(`The password reset is done, but local.env still marks it pending: ${error.message}`));
    const workspace = await ensureOwnerWorkspace({
      apiPort: ports.api, email: profile.AWWO_BOOTSTRAP_ADMIN_EMAIL, password: profile.AWWO_BOOTSTRAP_ADMIN_PASSWORD, marker: state.ownerWorkspace,
    }).catch(error => `skipped: ${error.message}`);
    if (workspace !== 'done before') report.info(`Owner's workspace: ${workspace}`);
    if (stopping) return { shutdown };
    const host = profile.AWWO_LOCAL_HOSTNAME;
    const origin = localOrigin(ports.web, host);
    const webOptions = { root: layout.web, stagedDir: layout.staged, apiPort: ports.api, port: ports.web, host, stagedFallback: stagedFallback(profile, report) };
    for (const address of ['127.0.0.1', '::1']) {
      const web = createLocalWebServer(webOptions);
      webServers.push(web);
      if (!(await listenWeb(web, ports.web, address))) webServers.pop();
    }
    if (stopping) return { shutdown };
    const dead = services.filter(service => !service.retired && REQUIRED.has(service.name) && service.child.exitCode !== null);
    if (dead.length) throw new Error(`${dead.map(service => service.name).join(', ')} stopped while AwwO was starting`);
    const running = Object.fromEntries(services.filter(service => !service.retired && service.child.exitCode === null).map(service => [service.name, true]));
    report.event({ event: 'ready', url: origin, stateDir: state.dir, services: running });
    report.info(`\nAwwO 本地版 is ready: ${localOrigin(ports.web)} (it opens as ${origin}, this data folder's own address)\nSign in as ${profile.AWWO_BOOTSTRAP_ADMIN_EMAIL}; the password is in ${state.credentials}\nServices: ${['database', ...Object.keys(running), 'web'].join(', ')}. Logs: ${state.logs}\nPress Ctrl-C to stop.`);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  return { shutdown };
}

/**
 * The owner's first workspace, made once through the API's own routes. The API makes its bootstrap administrator
 * without one, and the person should not have to create an ordinary account (held to the hosted service's daily
 * allowance) to start. Done once: owner-workspace.json records it, and a person who later changes the password or
 * removes the workspace keeps that choice.
 */
export async function ensureOwnerWorkspace({ apiPort, email, password, marker, name = '我的工作区', fetchImpl = fetch }) {
  if (existsSync(marker)) return 'done before';
  const base = `http://127.0.0.1:${apiPort}/api/v1`;
  const login = await fetchImpl(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  if (!login.ok) return `skipped: the owner's sign-in was refused (${login.status})`;
  const cookie = /awwo_session=([^;]+)/.exec(login.headers.get('set-cookie') || '')?.[1];
  if (!cookie) return 'skipped: no session was returned';
  const session = { cookie: `awwo_session=${cookie}` };
  try {
    const identity = await login.json();
    let tenant = identity.tenants?.[0]?.id;
    if (!tenant) {
      const created = await fetchImpl(`${base}/tenants`, { method: 'POST', headers: { ...session, 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
      if (!created.ok) return `skipped: the workspace was refused (${created.status})`;
      tenant = (await created.json()).id || 'created';
    }
    await writeFileAtomic(marker, `${JSON.stringify({ tenant, at: new Date().toISOString() })}\n`);
    return identity.tenants?.length ? 'already had one' : 'created';
  } finally {
    await fetchImpl(`${base}/auth/logout`, { method: 'POST', headers: session }).catch(() => {});
  }
}

/** Where a staged video that is not on this computer plays from: the hosted site's public copy unless local.env
 *  says AWWO_LOCAL_STAGED_FALLBACK=none (a 404) or names another https origin. */
function stagedFallback(profile, report) {
  const value = profile.AWWO_LOCAL_STAGED_FALLBACK;
  if (value === 'none') return '';
  if (!value) return PUBLIC_SITE;
  if (/^https:\/\/[a-z0-9.-]+(?::\d{1,5})?$/i.test(value)) return value;
  report.info(`AWWO_LOCAL_STAGED_FALLBACK must be none or an https origin; using ${PUBLIC_SITE}`);
  return PUBLIC_SITE;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
  // Once everything has stopped, nothing may keep the process alive (stdin is read with --stop-on-stdin-close).
  await runLocal(options, { onStopped: code => process.exit(code) });
}
