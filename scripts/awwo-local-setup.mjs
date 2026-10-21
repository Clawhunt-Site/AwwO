// Prepares AwwO 本地版 on this computer: the runtimes it needs where they are missing (Node.js 24, and PostgreSQL on
// Windows), every service's dependencies, the API and the web app built from this checkout, and, when Docker is
// running, the workspace image and the managed execution's core. Run it again after an update: what is current stays.
//
//   npm run setup:local                         everything this computer can run
//   npm run setup:local -- --staged-videos      also the Academy's videos and the film case's film (about 1.5 GB)
//   npm run setup:local -- --no-docker          without the workspace image and the managed execution's core
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveCommand } from './awwo-saas-lib.mjs';
import { findOnPath, localLayout, osLock, resolvePostgresBin, stagedShowcaseFiles, workspaceImageTag } from './awwo-local-lib.mjs';

const PUBLIC_SITE = 'https://awwo.clawhunt.store';
/** Node.js for the services, from nodejs.org, checked against SHASUMS256.txt of the release. */
export const NODE_RELEASE = Object.freeze({
  version: '24.22.1',
  files: Object.freeze({
    'win32-x64': { name: 'node-v24.22.1-win-x64.zip', sha256: 'd2046d28c2c3dcd211ac5145c0bf30e2047ef9dfb306693c8c6e2eccd8b95fa5' },
    'linux-x64': { name: 'node-v24.22.1-linux-x64.tar.xz', sha256: '6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6' },
    'linux-arm64': { name: 'node-v24.22.1-linux-arm64.tar.xz', sha256: 'dbabf7a1cbf947e6059ffad2c27b80041db97dea1e553b62afdee7f13fca336e' },
    'darwin-arm64': { name: 'node-v24.22.1-darwin-arm64.tar.gz', sha256: '89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7' },
    'darwin-x64': { name: 'node-v24.22.1-darwin-x64.tar.gz', sha256: 'd132557e7ee2b85af08b0c8c34338e65c6430f2238d01f727728ef42dc83b035' },
  }),
});
/** PostgreSQL for Windows: the EDB binaries of the version CI tests against (18.4). EDB publishes no checksum for
 *  them; this one is of the archive fetched from get.enterprisedb.com over HTTPS on 2026-10-21 (337,444,127 bytes,
 *  Last-Modified 2026-08-25). Elsewhere PostgreSQL comes from PATH. */
export const POSTGRES_WINDOWS = Object.freeze({
  version: '18.4-1', name: 'postgresql-18.4-1-windows-x64-binaries.zip',
  sha256: '7effe34c0bf89027b3f171447d351cbc460f4566c8d0f643daec67f140787858',
  url: 'https://get.enterprisedb.com/postgresql/postgresql-18.4-1-windows-x64-binaries.zip',
});

function run(command, args, { cwd, env = process.env, allowFailure = false } = {}) {
  const resolved = resolveCommand(command, args);
  const result = spawnSync(resolved.command, resolved.args, { cwd, env, stdio: 'inherit', windowsHide: true });
  if (result.error) throw new Error(`${command}: ${result.error.message}`);
  if (result.status !== 0 && !allowFailure) throw new Error(`${command} ${args.slice(0, 3).join(' ')} failed (${result.status})`);
  return result.status === 0;
}
function output(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, ...options });
  return result.status === 0 ? result.stdout.trim() : '';
}

export async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** Downloads `url` to `file` through curl (which takes the person's proxy settings and resumes a cut download), and
 *  keeps it only when its SHA-256 is `sha256`. */
async function download(url, file, sha256) {
  if (existsSync(file) && await sha256File(file) === sha256) return file;
  await mkdir(path.dirname(file), { recursive: true });
  const partial = `${file}.part`;
  run('curl', ['--fail', '--location', '--retry', '3', '--retry-delay', '2', '--silent', '--show-error', '--continue-at', '-', '--output', partial, url]);
  const actual = await sha256File(partial);
  if (actual !== sha256) {
    await rm(partial, { force: true });
    throw new Error(`${path.basename(file)}: SHA-256 ${actual} is not the expected ${sha256}; the download was discarded`);
  }
  await rename(partial, file);
  return file;
}

/** Windows' own tar (bsdtar) reads zip files; Git for Windows puts a GNU tar earlier on PATH that does not. */
const tarCommand = () => process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';

async function ensureNode(layout, report) {
  // The copy here is replaced when the pinned version changes; its stamp names the version it is.
  if (existsSync(layout.node) && current(layout.nodeVersion, NODE_RELEASE.version)) return report('Node.js 24', `present (${NODE_RELEASE.version})`);
  const release = NODE_RELEASE.files[`${process.platform}-${process.arch}`];
  if (!release) throw new Error(`No Node.js ${NODE_RELEASE.version} build is pinned for ${process.platform}-${process.arch}; install Node.js 24 and run setup from it`);
  const archive = await download(`https://nodejs.org/dist/v${NODE_RELEASE.version}/${release.name}`, path.join(layout.build, 'downloads', release.name), release.sha256);
  const unpack = path.join(layout.build, 'node-unpack');
  await rm(unpack, { recursive: true, force: true });
  await mkdir(unpack, { recursive: true });
  run(tarCommand(), ['-xf', archive, '-C', unpack]);
  await rm(path.join(layout.build, 'node'), { recursive: true, force: true });
  await rename(path.join(unpack, release.name.replace(/\.(zip|tar\.xz|tar\.gz)$/, '')), path.join(layout.build, 'node'));
  await rm(unpack, { recursive: true, force: true });
  await writeFile(layout.nodeVersion, `${NODE_RELEASE.version}\n`);
  report('Node.js 24', `installed ${NODE_RELEASE.version}`);
}

async function ensurePostgres(layout, report) {
  if (resolvePostgresBin(layout)) return report('PostgreSQL', 'present');
  if (process.platform !== 'win32') throw new Error('PostgreSQL 16 or newer is needed: put initdb, pg_ctl, postgres, psql and createdb on PATH, or set AWWO_LOCAL_PG_BIN');
  const archive = await download(POSTGRES_WINDOWS.url, path.join(layout.build, 'downloads', POSTGRES_WINDOWS.name), POSTGRES_WINDOWS.sha256);
  const unpack = path.join(layout.build, 'pgsql-unpack');
  await rm(unpack, { recursive: true, force: true });
  await mkdir(unpack, { recursive: true });
  // Only the server, its libraries and its data files: not pgAdmin, the documentation or the headers.
  run(tarCommand(), ['-xf', archive, '-C', unpack, 'pgsql/bin', 'pgsql/lib', 'pgsql/share']);
  await rm(path.join(layout.build, 'pgsql'), { recursive: true, force: true });
  await rename(path.join(unpack, 'pgsql'), path.join(layout.build, 'pgsql'));
  await rm(unpack, { recursive: true, force: true });
  report('PostgreSQL', `installed ${POSTGRES_WINDOWS.version}`);
}

/** npm of the Node.js the services run on. */
function npmFor(layout) {
  if (!existsSync(layout.node)) return { command: 'npm', prefix: [] };
  const cli = process.platform === 'win32'
    ? path.join(path.dirname(layout.node), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    : path.join(path.dirname(layout.node), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  return { command: layout.node, prefix: [cli] };
}
// A tool's PATH starts with the services' Node.js, so npm's install scripts run on it too.
function withNodePath(layout, env = process.env) {
  if (!existsSync(layout.node)) return env;
  const key = Object.keys(env).find(name => name.toUpperCase() === 'PATH') || 'PATH';
  return { ...env, [key]: `${path.dirname(layout.node)}${path.delimiter}${env[key] || ''}` };
}

const stampOf = text => createHash('sha256').update(text).digest('hex');
function current(stampFile, stamp) {
  return existsSync(stampFile) && readFileSync(stampFile, 'utf8').trim() === stamp;
}

/** How each app is installed: a worker as its hosted image installs it (no dev packages, no install scripts); the
 *  web app with its build tools, as its image does too (deploy/saas/*.Dockerfile). */
export const INSTALL_FLAGS = Object.freeze({
  web: [], 'pi-worker': ['--omit=dev', '--ignore-scripts'], 'openai-agents-worker': ['--omit=dev', '--ignore-scripts'],
  'render-worker': ['--omit=dev', '--ignore-scripts'],
});

async function installPackages(layout, app, report) {
  const dir = path.join(layout.resources, 'apps', app);
  const lock = path.join(dir, 'package-lock.json');
  const flags = INSTALL_FLAGS[app];
  const stamp = stampOf(`${NODE_RELEASE.version}\n${flags.join(' ')}\n${readFileSync(lock)}`);
  const stampFile = path.join(dir, 'node_modules', '.awwo-local-installed');
  if (current(stampFile, stamp)) return report(`${app} packages`, 'current');
  const npm = npmFor(layout);
  run(npm.command, [...npm.prefix, 'ci', '--no-audit', '--no-fund', ...flags], { cwd: dir, env: { ...withNodePath(layout), PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' } });
  await writeFile(stampFile, `${stamp}\n`);
  report(`${app} packages`, 'installed');
}

async function ensurePython(layout, report) {
  const project = path.join(layout.resources, 'apps', 'openai-agents-python-worker', 'pyproject.toml');
  const stamp = stampOf(readFileSync(project));
  // Written only once the install has finished: the runtime takes the Python worker only with it (awwo-local.mjs).
  const stampFile = layout.pythonInstalled;
  if (existsSync(layout.python) && current(stampFile, stamp)) return report('Python worker', 'current');
  await rm(stampFile, { force: true });
  const uv = findOnPath('uv');
  const venv = path.join(layout.build, 'python');
  if (uv) {
    if (!existsSync(layout.python)) run(uv, ['venv', '--python', '3.12', venv]);
    run(uv, ['pip', 'install', '--python', layout.python, '-r', project]);
  } else {
    const python = findOnPath('python3') || findOnPath('python');
    if (!python) throw new Error('Python 3.12 (or uv) is needed for the Python worker');
    if (!existsSync(layout.python)) run(python, ['-m', 'venv', venv]);
    run(layout.python, ['-m', 'pip', 'install', path.dirname(project)]);
  }
  await writeFile(stampFile, `${stamp}\n`);
  report('Python worker', 'installed');
}

function buildApi(layout, report) {
  // -buildvcs=false: a build inside a worktree would stamp the enclosing checkout's commit as its revision.
  run('go', ['build', '-buildvcs=false', '-trimpath', '-o', layout.api, './cmd/api'], { cwd: path.join(layout.resources, 'backend') });
  report('API', 'built');
}

/** The web app is rebuilt unless the tree it was last built from is the same and has no local changes. */
async function buildWeb(layout, report) {
  const web = path.join(layout.resources, 'apps', 'web');
  const tree = output('git', ['rev-parse', 'HEAD:apps/web'], { cwd: layout.resources });
  const clean = tree && output('git', ['status', '--porcelain', '--', 'apps/web'], { cwd: layout.resources }) === '';
  const stampFile = path.join(layout.build, 'web-built-from.txt');
  if (clean && existsSync(path.join(layout.web, 'saas.html')) && current(stampFile, tree)) return report('web app', 'current');
  const node = existsSync(layout.node) ? layout.node : process.execPath;
  run(node, [path.join(web, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--configLoader', 'runner', '--config', 'vite.saas.config.mjs'], { cwd: web, env: withNodePath(layout) });
  await writeFile(stampFile, `${clean ? tree : 'changed'}\n`);
  report('web app', 'built');
}

function brokerCoreCurrent(layout) {
  const setup = readFileSync(path.join(layout.resources, 'apps', 'openmaus-worker', 'setup.ts'), 'utf8');
  const revision = /UPSTREAM_REVISION = '([0-9a-f]{40})'/.exec(setup)?.[1];
  const patch = Number(/PATCH_VERSION = (\d+)/.exec(setup)?.[1]);
  try {
    const build = JSON.parse(readFileSync(path.join(path.dirname(layout.brokerCore), 'awwo-build.json'), 'utf8'));
    return build.upstreamRevision === revision && build.patchVersion === patch && existsSync(layout.brokerCore);
  } catch {
    return false;
  }
}

function buildBrokerCore(layout, report) {
  if (brokerCoreCurrent(layout)) return report('managed execution core', 'current');
  const node = existsSync(layout.node) ? layout.node : process.execPath;
  run(node, [path.join(layout.resources, 'apps', 'openmaus-worker', 'setup.ts')], { cwd: path.join(layout.resources, 'apps', 'openmaus-worker'), env: withNodePath(layout) });
  report('managed execution core', 'built');
}

/** A hash of every file the workspace image is built from, so its tag changes whenever its source does. */
export function workspaceSourceHash(dir) {
  const hash = createHash('sha256');
  const walk = relative => {
    for (const entry of readdirSync(path.join(dir, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(next);
      else if (entry.isFile()) hash.update(`${next}\0`).update(readFileSync(path.join(dir, next))).update('\0');
    }
  };
  walk('');
  return hash.digest('hex');
}

async function buildWorkspaceImage(layout, docker, report) {
  const tag = workspaceImageTag(workspaceSourceHash(layout.workspace));
  if (spawnSync(docker, ['image', 'inspect', tag], { stdio: 'ignore', windowsHide: true }).status !== 0) {
    run(docker, ['build', '-t', tag, layout.workspace]);
  }
  await writeFile(layout.workspaceTag, `${tag}\n`);
  report('workspace image', tag);
}

async function downloadStagedVideos(layout, report) {
  const files = stagedShowcaseFiles(path.join(layout.resources, 'apps', 'web', 'src'));
  let fetched = 0;
  for (const [index, file] of files.entries()) {
    const target = path.join(layout.staged, file.caseName, file.name);
    // A file already here is kept only when its bytes are the named ones: one of the right size can still be damaged.
    if (existsSync(target) && statSync(target).size === file.bytes && await sha256File(target) === file.sha256) continue;
    process.stdout.write(`  ${index + 1}/${files.length} ${file.src} (${Math.round(file.bytes / 1048576)} MB)\n`);
    await rm(target, { force: true });
    await download(`${PUBLIC_SITE}${file.src}`, target, file.sha256);
    fetched += 1;
  }
  report('staged videos', `${files.length} on this computer (${fetched} downloaded)`);
}

/** Setup replaces programs the runtimes run (Windows refuses to overwrite a running .exe) and packages they have
 *  loaded, in the code and in the build, and two setups would share their downloads and unpacking folders. So it
 *  holds the code's and the build's locks exclusively while it works: every runtime of either holds them shared for
 *  as long as it runs, whatever data folder it serves (awwo-local.mjs holdBuild), and they are the operating system's,
 *  given up with their process. */
export async function holdBuildExclusively(layout, { lock = osLock } = {}) {
  if (!layout.codeLock || !layout.buildLock) throw new Error('setup:local runs from a checkout of AwwO, on its own build');
  const releases = [];
  const releaseAll = async () => { for (const release of [...releases].reverse()) await release(); };
  try {
    for (const file of [layout.codeLock, layout.buildLock]) {
      await mkdir(path.dirname(file), { recursive: true });
      const held = await lock(file, { exclusive: true });
      if (!held) throw new Error('AwwO 本地版 is running from this code or build, or another setup is: stop it, then run setup again');
      releases.push(held.release);
    }
  } catch (error) {
    await releaseAll();
    throw error;
  }
  return releaseAll;
}

export async function setupLocal(argv = process.argv.slice(2)) {
  const options = { stagedVideos: argv.includes('--staged-videos'), docker: !argv.includes('--no-docker') };
  const unknown = argv.filter(arg => !['--staged-videos', '--no-docker'].includes(arg));
  if (unknown.length) throw new Error(`Unknown option ${unknown.join(', ')}`);
  const layout = localLayout();
  const release = await holdBuildExclusively(layout);
  try {
    return await setupWith(layout, options);
  } finally {
    await release();
  }
}

async function setupWith(layout, options) {
  const results = [];
  const report = (step, result) => { results.push([step, result]); console.log(`AwwO 本地版 setup: ${step} — ${result}`); };
  const optional = async (step, action) => {
    try { await action(); } catch (error) { report(step, `skipped: ${error instanceof Error ? error.message : error}`); }
  };
  await ensureNode(layout, report);
  await ensurePostgres(layout, report);
  for (const app of ['web', 'pi-worker', 'openai-agents-worker']) await installPackages(layout, app, report);
  // The managed execution's broker has no packages of its own to run (only its type checker).
  await optional('render-worker packages', () => installPackages(layout, 'render-worker', report));
  await optional('Python worker', () => ensurePython(layout, report));
  buildApi(layout, report);
  await buildWeb(layout, report);
  const docker = options.docker && (process.env.AWWO_LOCAL_DOCKER || findOnPath('docker'));
  const dockerUp = docker && output(docker, ['version', '--format', '{{.Server.Version}}']) !== '';
  if (!options.docker) report('Docker parts', 'skipped (--no-docker)');
  else {
    // The core needs no Docker to build (git and npm only), so it is ready when Docker is started later.
    await optional('managed execution core', () => buildBrokerCore(layout, report));
    if (dockerUp) await optional('workspace image', () => buildWorkspaceImage(layout, docker, report));
    else report('workspace image', 'skipped: Docker is not running (start it and run setup again for 直接执行)');
  }
  if (options.stagedVideos) await optional('staged videos', () => downloadStagedVideos(layout, report));
  console.log(`\nAwwO 本地版 is set up. Start it with: npm run local`);
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await setupLocal();
  } catch (error) {
    console.error(`AwwO 本地版 setup failed: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
