// AwwO 本地版 (the local edition): the hosted product's own services on one computer, for one person, with their own
// keys. This module holds its decisions as plain functions — where things live, which settings each service gets and
// which ports it takes — so they can be tested without starting anything. scripts/awwo-local.mjs runs them;
// scripts/awwo-local-setup.mjs installs and builds what they need. docs/awwo-local-edition.md describes the whole.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, constants, existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from './awwo-saas-lib.mjs';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The ports tried first. They are apart from dev:saas's (5189, 8087, 8097-8099, 55483), so both can run on one
 *  machine, and below WSL's ephemeral range and Windows' dynamic range (49152 and up), where a private service is
 *  often refused its port. */
export const DEFAULT_PORTS = Object.freeze({
  web: 5199, api: 18087, database: 15483, pi: 18097, agents: 18099, broker: 18109, render: 18111,
});

/** The name the person opens. Browsers send a cookie of 127.0.0.1 or localhost to every port of that host, so another
 *  local web server (or a dev:saas on 127.0.0.1) would receive this instance's session, or replace it; a *.localhost
 *  name is loopback to every current browser, a secure context, and its cookies are its own. Cookies do not tell ports
 *  apart either, so each data folder answers under a name of its own, awwo-<instance>.localhost (AWWO_LOCAL_HOSTNAME,
 *  made once), and this one sends the browser there: two instances on one computer, of one checkout or two, never
 *  share a session cookie. */
export const LOCAL_HOST = 'awwo.localhost';
const validHostname = value => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.localhost$/.test(value);
export const localOrigin = (port, host = LOCAL_HOST) => `http://${host}:${port}`;

/** The address the person signs in with. It is a platform administrator of their own instance, so the workspaces
 *  it owns are not held to the hosted service's daily allowance and are offered the media services. */
export const OWNER_EMAIL = 'owner@awwo.local';

/** The workspace image the managed execution runs in, named after the source it was built from
 *  (deploy/saas/workspace), so a changed Dockerfile can never be mistaken for the image already on the machine. */
export const workspaceImageTag = tree => `awwo-workspace:local-${String(tree).slice(0, 12)}`;

/** Where the code and what setup:local builds are. From a checkout that is the repository, with the built pieces
 *  under .local/awwo-local/build; a packaged app passes its own resources directory and build directory. */
export function localLayout({ resources = repoRoot, build = path.join(resources, '.local', 'awwo-local', 'build'), platform = process.platform } = {}) {
  const windows = platform === 'win32';
  const exe = name => windows ? `${name}.exe` : name;
  const app = (...parts) => path.join(resources, 'apps', ...parts);
  // setup:local replaces what it serves: the code of a checkout that carries it (its packages, the web build, the
  // managed execution's core) and that checkout's own build (<checkout>/.local/awwo-local/build). Each has its lock,
  // held by every runtime of it whatever its other half; code or a build no setup serves (a packaged app's) has none,
  // and nothing is written there.
  const servedBySetup = dir => existsSync(path.join(dir, 'scripts', 'awwo-local-setup.mjs'));
  // A checkout's own build is <checkout>/.local/awwo-local/build, as named or as it really is: a build reached through a
  // junction, a link, a subst drive or a short name, and a checkout's build folder moved elsewhere and linked back, are
  // both still that checkout's. Names are read without regard to case, as Windows and macOS give them.
  const servedAt = dir => {
    const [own, parent, root] = [dir, path.dirname(dir), path.dirname(path.dirname(dir))].map(name => path.basename(name).toLowerCase());
    return own === 'build' && parent === 'awwo-local' && root === '.local' && servedBySetup(path.dirname(path.dirname(path.dirname(dir))));
  };
  let realBuild = path.resolve(build);
  try { realBuild = realpathSync.native(build); } catch { /* not there yet */ }
  const servedBuild = servedAt(path.resolve(build)) || servedAt(realBuild);
  return Object.freeze({
    resources, build,
    api: path.join(build, exe('awwo-api')),
    node: windows ? path.join(build, 'node', 'node.exe') : path.join(build, 'node', 'bin', 'node'),
    nodeVersion: path.join(build, 'node', '.awwo-local-version'),
    pgBin: path.join(build, 'pgsql', 'bin'),
    python: windows ? path.join(build, 'python', 'Scripts', 'python.exe') : path.join(build, 'python', 'bin', 'python'),
    pythonInstalled: path.join(build, 'python', '.awwo-local-installed'),
    staged: path.join(build, 'staged-showcase'),
    workspaceTag: path.join(build, 'workspace-image.txt'),
    codeLock: servedBySetup(resources) ? path.join(resources, '.local', 'awwo-local', 'code.lock') : null,
    buildLock: servedBuild ? path.join(realBuild, 'build.lock') : null,
    web: app('web', 'dist-saas'),
    pi: app('pi-worker', 'server.mjs'),
    agentsJs: app('openai-agents-worker', 'server.mjs'),
    agentsPython: app('openai-agents-python-worker', 'server.py'),
    broker: app('openmaus-worker', 'server.ts'),
    brokerCore: app('openmaus-worker', '.runtime', 'core', 'dist-server', 'index.js'),
    render: app('render-worker', 'server.mjs'),
    workspace: path.join(resources, 'deploy', 'saas', 'workspace'),
  });
}

/** One person's data and settings. Everything here belongs to them and survives an update of the code. */
export function localState(dir) {
  const at = (...parts) => path.join(dir, ...parts);
  return Object.freeze({
    dir, env: at('local.env'), providers: at('providers.env'), credentials: at('admin-credentials.txt'),
    lock: at('runtime.lock'), logs: at('logs'), postgres: at('postgres'), media: at('media'),
    broker: at('openmaus'), renderTmp: at('render-tmp'), ownerWorkspace: at('owner-workspace.json'),
  });
}

/** Secrets the runtime makes once and keeps: the database's password, one token per service, the egress secret and
 *  the owner's first password. AWWO_CREDENTIAL_ENCRYPTION_KEY encrypts every saved API key; it is never replaced. */
export const GENERATED_SECRETS = Object.freeze([
  'AWWO_LOCAL_DB_PASSWORD', 'AWWO_PI_TOKEN', 'AWWO_OPENAI_AGENTS_TOKEN', 'AWWO_SANDBOX_AGENTS_TOKEN',
  'AWWO_OPENMAUS_TOKEN', 'AWWO_RENDER_TOKEN', 'AWWO_WORKSPACE_EGRESS_SECRET', 'AWWO_BOOTSTRAP_ADMIN_PASSWORD',
]);
/** What an existing database cannot do without: made anew, the vault key would no longer decrypt the saved API keys
 *  and the password would no longer open the database. */
const DATA_BOUND = ['AWWO_CREDENTIAL_ENCRYPTION_KEY', 'AWWO_LOCAL_DB_PASSWORD'];

/** What a person may put in providers.env: the keys of the picture, video, 3D and voice services, a local proxy for
 *  downloading what they make, and one for 从网址读取 and the skill registry. Model keys are not here: they are saved,
 *  encrypted, from 我的引擎 in the app. */
export const PROVIDER_SETTINGS = Object.freeze(['AWWO_RUNNINGHUB_API_KEY', 'AWWO_TRIPO_API_KEY', 'AWWO_XTASY_API_KEY', 'AWWO_MEDIA_DEV_PROXY', 'AWWO_WEB_READER_PROXY']);

const PROVIDERS_TEMPLATE = `# AwwO 本地版 — 媒体服务密钥（可选）/ media service keys (optional)
# 填写后重启 AwwO 本地版，图片、视频、3D、配音节点即可使用；留空则该服务保持关闭。
# Fill a key in and restart AwwO to use picture, video, 3D and voice nodes; an empty line keeps that service off.
# 模型的 API Key 不写在这里，请在应用的「我的引擎」中添加。Model keys go in 我的引擎 (My engines) in the app.
# 本文件只保存在这台电脑上。This file stays on this computer.
AWWO_RUNNINGHUB_API_KEY=
AWWO_TRIPO_API_KEY=
AWWO_XTASY_API_KEY=
# 媒体下载走本机代理时填写，例如 http://127.0.0.1:7897 / a local proxy for downloads, e.g. http://127.0.0.1:7897
AWWO_MEDIA_DEV_PROXY=
# 「从网址读取」和技能库经本机代理访问网站时填写，例如 http://127.0.0.1:7897（代理需支持 CONNECT；AwwO 先在本机解析
# 网址，只让代理连到查过的公网地址）。/ a local proxy for reading web pages and the skill registry, e.g.
# http://127.0.0.1:7897 (it must support CONNECT; AwwO resolves each name here and tunnels only to a public address).
AWWO_WEB_READER_PROXY=
`;

/** Writes a file whole or not at all: a file cut short by a crash would lose a key that encrypts saved data. A copy
 *  left by a failed rename is removed, since it holds the same secrets. */
export async function writeFileAtomic(file, text, mode = 0o600) {
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(temporary, text, { mode });
  try {
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function readSettingsFile(file, label) {
  if (!existsSync(file)) return {};
  try {
    return parseEnv(readFileSync(file, 'utf8'));
  } catch (error) {
    // Never rewrite an unreadable settings file: it may still hold the only copy of the vault key.
    throw new Error(`${label} (${file}) cannot be read: ${error instanceof Error ? error.message : error}. Fix or restore it; AwwO does not replace it.`);
  }
}

/** The instance's settings, made on the first start and kept after: new secrets are added, existing ones never
 *  change, and the two an existing database depends on are never made again. Also writes providers.env (empty keys)
 *  and admin-credentials.txt (the owner's sign-in) when missing. */
export async function loadLocalProfile(state, { random = randomBytes } = {}) {
  await mkdir(state.dir, { recursive: true, mode: 0o700 });
  const saved = readSettingsFile(state.env, 'local.env');
  const lost = DATA_BOUND.filter(name => !saved[name]);
  if (lost.length && existsSync(path.join(state.postgres, 'PG_VERSION'))) {
    throw new Error(`local.env has lost ${lost.join(' and ')} while the database in ${state.postgres} exists; restore local.env from a backup. AwwO does not make new ones: saved keys would no longer decrypt.`);
  }
  const fresh = {};
  for (const name of GENERATED_SECRETS) if (!saved[name]) fresh[name] = random(32).toString('base64url');
  if (!saved.AWWO_CREDENTIAL_ENCRYPTION_KEY) fresh.AWWO_CREDENTIAL_ENCRYPTION_KEY = random(32).toString('base64');
  if (!saved.AWWO_BOOTSTRAP_ADMIN_EMAIL) fresh.AWWO_BOOTSTRAP_ADMIN_EMAIL = OWNER_EMAIL;
  if (!saved.AWWO_LOCAL_WEB_PORT) fresh.AWWO_LOCAL_WEB_PORT = String(DEFAULT_PORTS.web);
  // Names this instance's workspace containers, so it removes what a stopped broker left and nothing of another's.
  if (!saved.AWWO_LOCAL_INSTANCE) fresh.AWWO_LOCAL_INSTANCE = `local-${random(6).toString('hex')}`;
  // The name it answers under, after the instance. LOCAL_HOST is the name a person types, which sends them on to it: a
  // profile that kept it as its own (written before every folder had a name of its own) gets its own now.
  if (!saved.AWWO_LOCAL_HOSTNAME || saved.AWWO_LOCAL_HOSTNAME === LOCAL_HOST) {
    fresh.AWWO_LOCAL_HOSTNAME = `awwo-${(saved.AWWO_LOCAL_INSTANCE || fresh.AWWO_LOCAL_INSTANCE).replace(/^local-/, '')}.localhost`;
  }
  const profile = { ...saved, ...fresh };
  if (!validHostname(profile.AWWO_LOCAL_HOSTNAME)) {
    throw new Error('AWWO_LOCAL_HOSTNAME in local.env must be one name under .localhost, such as awwo-<instance>.localhost');
  }
  if (Object.keys(fresh).length) await writeProfile(state, profile);
  if (!existsSync(state.providers)) await writeFileAtomic(state.providers, PROVIDERS_TEMPLATE);
  if (!existsSync(state.credentials)) await writeFileAtomic(state.credentials, credentialsText(profile));
  return Object.freeze({ ...profile, providers: Object.freeze(loadProviders(state)) });
}

const writeProfile = (state, profile) => writeFileAtomic(state.env,
  `# AwwO 本地版. Made by the runtime; keep it with the database (it holds the key that encrypts saved API keys).\n${Object.entries(profile).map(([key, value]) => `${key}=${value}`).join('\n')}\n`);
const credentialsText = profile => `AwwO 本地版 — sign-in for this computer\nEmail: ${profile.AWWO_BOOTSTRAP_ADMIN_EMAIL}\nPassword: ${profile.AWWO_BOOTSTRAP_ADMIN_PASSWORD}\n`;

/** In local.env while a new password may not have reached the account yet: the reset's id, which every start passes on
 *  until one has started with it. The API applies each id once (edition.go resetBootstrapPassword). */
export const PASSWORD_RESET_PENDING = 'AWWO_LOCAL_PASSWORD_RESET';
/** A reset id as the API takes it (AWWO_BOOTSTRAP_ADMIN_RESET). */
export const resetId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(value) ? value : '';

/**
 * A new sign-in password for the owner (the runtime's --reset-password), the way back in for a person who forgot
 * theirs: the local edition sends no mail. It is written to local.env and admin-credentials.txt with a new reset id,
 * and the API sets it on the account as it starts (AWWO_BOOTSTRAP_ADMIN_RESET=<id>), which also ends the account's
 * sessions. The id stays until an API has started with it (passwordResetApplied), so a start that fails before then
 * leaves the next one to finish the reset; the API applies an id only once, so one left behind never undoes a password
 * changed since. Every other setting stays as it is. A folder with no settings yet has no password to reset: its first
 * start makes one.
 */
export async function resetOwnerPassword(state, { random = randomBytes } = {}) {
  if (!existsSync(state.env)) return false;
  const saved = readSettingsFile(state.env, 'local.env');
  if (!saved.AWWO_BOOTSTRAP_ADMIN_EMAIL) throw new Error('local.env names no owner account whose password could be reset');
  const profile = { ...saved, AWWO_BOOTSTRAP_ADMIN_PASSWORD: random(32).toString('base64url'), [PASSWORD_RESET_PENDING]: random(18).toString('base64url') };
  await writeProfile(state, profile);
  await writeFileAtomic(state.credentials, credentialsText(profile));
  return true;
}

/** Before a start sets a pending password: admin-credentials.txt names it, even where the reset stopped between its
 *  two files. */
export const writeOwnerCredentials = (state, profile) => writeFileAtomic(state.credentials, credentialsText(profile));

/** The API has started with the pending password: the account has it, and later starts leave it alone. */
export async function passwordResetApplied(state) {
  const saved = readSettingsFile(state.env, 'local.env');
  if (!(PASSWORD_RESET_PENDING in saved)) return;
  delete saved[PASSWORD_RESET_PENDING];
  await writeProfile(state, saved);
}

/** A proxy setting is exactly http://127.0.0.1:<port>, as the API checks it (media_config.go loopbackOrigin): said here,
 *  with the file's name, rather than as the API's refusal to start. */
const PROXY_SETTINGS = new Set(['AWWO_MEDIA_DEV_PROXY', 'AWWO_WEB_READER_PROXY']);
const loopbackProxy = value => {
  const port = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(value)?.[1];
  return Boolean(port) && Number(port) <= 65535;
};

/** providers.env's keys that are set. A name AwwO does not know is refused: a typo would otherwise keep a service
 *  off without a word, and the file is not a way to change the instance's other settings. */
export function loadProviders(state) {
  const values = readSettingsFile(state.providers, 'providers.env');
  const unknown = Object.keys(values).filter(key => !PROVIDER_SETTINGS.includes(key));
  if (unknown.length) throw new Error(`providers.env: unknown setting ${unknown.join(', ')}; allowed: ${PROVIDER_SETTINGS.join(', ')}`);
  const set = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value.trim()]).filter(([, value]) => value !== ''));
  for (const [key, value] of Object.entries(set)) {
    if (PROXY_SETTINGS.has(key) && !loopbackProxy(value)) throw new Error(`providers.env: ${key} must be http://127.0.0.1:<port> (a proxy on this computer), not ${value}`);
  }
  return set;
}

/** A program of Windows itself, by its full path: Git for Windows puts its own whoami (and others) earlier on PATH,
 *  which take other arguments. */
export const windowsTool = (name, env = process.env) => path.win32.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32', `${name}.exe`);

/** One path's access list as readAcl prints it: `owner|protected|entry;entry…`, each entry
 *  `type,inherited,inheritance flags,propagation flags,rights,SID`. Every SID is written in full: SDDL would write some
 *  as aliases (this computer's own Administrator account as LA), and account names are translated. */
export function parseAcl(line) {
  const [owner = '', isProtected = '', entries = ''] = String(line || '').trim().split('|');
  const rules = entries ? entries.split(';').map(entry => {
    const [type, inherited, inheritance, propagation, rights, sid] = entry.split(',');
    return { allow: type === 'Allow', inherited: inherited === 'True', inheritance: Number(inheritance), propagation: Number(propagation), rights: Number(rights), sid };
  }) : [];
  return { owner, protected: isProtected === 'True', rules };
}
const SYSTEM = 'S-1-5-18';
const ADMINISTRATORS = 'S-1-5-32-544';
const FULL_CONTROL = 0x1f01ff;
const TO_FOLDERS_AND_FILES = 3; // ContainerInherit | ObjectInherit
/** Owners that keep a folder this account's: itself, SYSTEM, or Administrators (who own what an elevated process
 *  makes). Any other owner could give itself access again at any time. */
const trustedOwner = (owner, sid) => owner === sid || owner === SYSTEM || owner === ADMINISTRATORS;

/** The data folder is private: a trusted owner, inheritance off, and exactly two entries of its own, both full control
 *  passed to its folders and files: one for SYSTEM and one for this account's SID. */
export function privateFolder(line, sid) {
  const { owner, protected: isProtected, rules } = parseAcl(line);
  if (!sid || !trustedOwner(owner, sid) || !isProtected || rules.length !== 2) return false;
  const full = rule => rule.allow && !rule.inherited && rule.inheritance === TO_FOLDERS_AND_FILES && rule.propagation === 0 && rule.rights === FULL_CONTROL;
  return rules.every(full) && rules.some(rule => rule.sid === SYSTEM) && rules.some(rule => rule.sid === sid);
}
/** A file in it lets nobody else in: a trusted owner, and every allow entry SYSTEM's or this account's. */
export function privateFile(line, sid) {
  const { owner, rules } = parseAcl(line);
  return Boolean(sid) && trustedOwner(owner, sid) && rules.length > 0 && rules.every(rule => !rule.allow || rule.sid === SYSTEM || rule.sid === sid);
}

/** What the runtime keeps in the data folder; only these take the folder's list when it is first protected. */
const OWN_ENTRIES = new Set(['local.env', 'providers.env', 'admin-credentials.txt', 'runtime.lock', 'owner-workspace.json', 'logs', 'postgres', 'media', 'openmaus', 'render-tmp']);
const SECRET_FILES = ['local.env', 'providers.env', 'admin-credentials.txt'];

function currentSid(run, env) {
  const who = run(windowsTool('whoami', env), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
  const sid = /"(S-1-[0-9-]+)"\s*$/.exec(String(who.stdout || '').trim())?.[1];
  if (who.status !== 0 || !sid) throw new Error('Cannot read this account\'s SID to protect the data folder');
  return sid;
}
/** Each path's access list in parseAcl's form ('MISSING' for one that is not there), from one Windows PowerShell
 *  call. The paths reach it in an environment variable, so none is quoted into a command, and it is given nothing else
 *  of this process's environment (Windows adds the system variables it needs). */
const ACL_SCRIPT = "$ErrorActionPreference='Stop'; $sid=[System.Security.Principal.SecurityIdentifier]; "
  + "foreach ($p in $env:AWWO_ACL_PATHS.Split('|')) { if (Test-Path -LiteralPath $p) { $acl = Get-Acl -LiteralPath $p; "
  + "$rules = @($acl.GetAccessRules($true, $true, $sid) | ForEach-Object { '{0},{1},{2},{3},{4},{5}' -f $_.AccessControlType, $_.IsInherited, [int]$_.InheritanceFlags, [int]$_.PropagationFlags, [int]$_.FileSystemRights, $_.IdentityReference.Value }); "
  + "'{0}|{1}|{2}' -f $acl.GetOwner($sid).Value, $acl.AreAccessRulesProtected, ($rules -join ';') } else { 'MISSING' } }";
function readAcl(paths, run, env) {
  const result = run(windowsTool('WindowsPowerShell\\v1.0\\powershell', env), ['-NoProfile', '-NonInteractive', '-Command', ACL_SCRIPT],
    { encoding: 'utf8', windowsHide: true, timeout: 60_000, env: { SystemRoot: env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', AWWO_ACL_PATHS: paths.join('|') } });
  const lines = String(result.stdout || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (result.status !== 0 || lines.length !== paths.length) {
    const said = String(result.stderr || '').trim().split(/\r?\n/)[0] || `exit ${result.status ?? result.error?.code}`;
    throw new Error(`Cannot read the data folder's permissions through Windows PowerShell (${said}). Where PowerShell is held to Constrained Language Mode (WDAC or AppLocker), they cannot be checked, and AwwO 本地版 does not start.`);
  }
  return lines;
}

/**
 * The folder holding the instance's secrets is readable by this account (and the system) alone. A file's mode means
 * nothing on Windows, where a folder under another drive's root inherits "Authenticated Users: modify": there the
 * folder gets its own access list (inheritance off; full control for this account's SID and SYSTEM), the runtime's own
 * entries in it take that list, and the result is read back by SID (readAcl). Elsewhere it gets mode 700. On every
 * system a folder another account owns, or one with other content and no local.env (a mistaken --state), is refused
 * rather than changed. A failure is an error: secrets are not written into a folder other accounts can read. Done once;
 * later starts only read the lists.
 */
export function protectStateDirectory(dir, { platform = process.platform, run = spawnSync, env = process.env, uid = process.getuid?.() } = {}) {
  const refuseForeign = () => {
    const entries = readdirSync(dir);
    if (entries.length && !entries.includes('local.env')) {
      throw new Error(`${dir} is not empty and has no local.env, so it is not an AwwO 本地版 data folder; choose an empty or new folder`);
    }
    return entries;
  };
  if (platform !== 'win32') {
    const info = statSync(dir);
    if (uid !== undefined && info.uid !== uid) throw new Error(`${dir} belongs to another account; choose a data folder of your own`);
    if ((info.mode & 0o777) === 0o700) return 'already private';
    refuseForeign();
    chmodSync(dir, 0o700);
    return 'mode 700';
  }
  const sid = currentSid(run, env);
  const secrets = SECRET_FILES.map(name => path.join(dir, name)).filter(file => existsSync(file));
  const check = () => {
    const [folder, ...files] = readAcl([dir, ...secrets], run, env);
    return { folder, ok: privateFolder(folder, sid) && files.every(file => privateFile(file, sid)) };
  };
  const before = check();
  if (before.ok) return 'already private';
  if (!trustedOwner(parseAcl(before.folder).owner, sid)) throw new Error(`${dir} belongs to another account; choose a data folder of your own`);
  const entries = refuseForeign();
  const icacls = args => run(windowsTool('icacls', env), args, { encoding: 'utf8', windowsHide: true });
  const set = icacls([dir, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '/grant:r', '*S-1-5-18:(OI)(CI)F', '/Q']);
  if (set.status !== 0) throw new Error(`Cannot restrict the data folder ${dir} to this account (icacls ${set.status})`);
  // What an earlier start wrote before the folder was protected takes the folder's list now.
  for (const name of entries.filter(entry => OWN_ENTRIES.has(entry))) {
    const reset = icacls([path.join(dir, name), '/reset', '/T', '/C', '/Q']);
    if (reset.status !== 0) throw new Error(`Cannot give ${path.join(dir, name)} the data folder's permissions (icacls ${reset.status})`);
  }
  if (!check().ok) throw new Error(`The data folder ${dir} could not be made private to this account`);
  return 'protected';
}

/** libuv's UV_FS_O_EXLOCK: on Windows a file opened with it is shared with no other handle, this process's included. */
const WINDOWS_EXLOCK = 0x10000000;
/** open(2)'s own flock on macOS and the BSDs. */
const BSD_SHLOCK = 0x10;
const BSD_EXLOCK = 0x20;
const BSD_PLATFORMS = new Set(['darwin', 'freebsd', 'openbsd']);

/**
 * A lock of the operating system's on `file`, held while this process runs and given up when it ends, however it ends
 * (a crash, Task Manager, kill -9): none is ever left behind to be taken over. `exclusive`: one holder; otherwise any
 * number of shared holders while there is no exclusive one. On Windows the file is opened with no sharing, or plainly
 * (which such a file refuses, and which refuses it); on macOS and the BSDs with open(2)'s flock; on Linux, which has
 * neither for Node.js, it is an abstract Unix socket named after the file, which goes with its process, and
 * /proc/net/unix shows the others. Returns { release } or null when others hold it. A file another program has open
 * for a moment (an antivirus scan) is tried again for about three seconds, at uneven intervals (on Linux two takers
 * that see each other both step back, and must not keep meeting).
 */
export async function osLock(file, { exclusive = true, platform = process.platform, attempts = 10 } = {}) {
  // Elsewhere open(2) would take the BSD flags without a word and lock nothing.
  if (platform !== 'win32' && platform !== 'linux' && !BSD_PLATFORMS.has(platform)) throw new Error(`AwwO 本地版 has no lock it can rely on on ${platform}`);
  for (let attempt = 1; ; attempt += 1) {
    const lock = platform === 'linux' ? await socketLock(file, exclusive) : await fileLock(file, exclusive, platform);
    if (lock || attempt >= attempts) return lock;
    await new Promise(resolve => setTimeout(resolve, 150 + Math.random() * 200));
  }
}
async function fileLock(file, exclusive, platform) {
  const flags = platform === 'win32'
    ? (exclusive ? constants.O_RDWR | WINDOWS_EXLOCK : constants.O_RDONLY) | constants.O_CREAT
    : (exclusive ? constants.O_RDWR | BSD_EXLOCK : constants.O_RDONLY | BSD_SHLOCK) | constants.O_CREAT | constants.O_NONBLOCK;
  try {
    const handle = await open(file, flags, 0o600);
    return { release: () => handle.close() };
  } catch (error) {
    if (['EBUSY', 'EAGAIN', 'EWOULDBLOCK'].includes(error?.code)) return null;
    throw error;
  }
}
async function socketLock(file, exclusive) {
  const base = `awwo-local-${createHash('sha256').update(path.join(realpathSync(path.dirname(file)), path.basename(file))).digest('hex').slice(0, 32)}`;
  const name = `${base}-${exclusive ? 'x' : `s-${process.pid}-${randomBytes(4).toString('hex')}`}`;
  // It serves no one: a process that connects is let go at once, so none can hold up the lock's release.
  const server = net.createServer(socket => socket.destroy());
  const bound = await new Promise((resolve, reject) => {
    server.once('error', error => (error?.code === 'EADDRINUSE' ? resolve(false) : reject(error)));
    server.listen(`\0${name}`, () => resolve(true));
  });
  if (!bound) return null;
  server.unref();
  const release = () => new Promise(resolve => server.close(() => resolve()));
  const sockets = readFileSync('/proc/net/unix', 'utf8');
  // A Node.js that binds no abstract name (Node 18 binds an empty one) would give every lock the same.
  if (!sockets.split('\n').some(line => line.trimEnd().endsWith(` @${name}`))) {
    await release();
    throw new Error('This Node.js cannot hold AwwO 本地版\'s locks (abstract Unix sockets): run it with Node.js 22 or newer');
  }
  // Each kind is in place before it looks for the other, so of two that come at once one always sees the other.
  if (sockets.includes(exclusive ? `@${base}-s-` : `@${base}-x`)) {
    await release();
    return null;
  }
  return { release };
}

/** Whether a port can be listened on at `host` now. An address this computer does not have (no IPv6 loopback) is no
 *  conflict; any other error is. */
export function portIsFree(port, host = '127.0.0.1') {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', error => resolve(['EADDRNOTAVAIL', 'EAFNOSUPPORT'].includes(error?.code)));
    server.listen(port, host, () => server.close(() => resolve(true)));
  });
}

/** The web port is the address the person opens and the origin their browser keeps unsent drafts under, so it never
 *  moves by itself: a busy one is an error. The other ports are known only to this runtime; a busy one is replaced by
 *  the next free one above it. */
export async function allocatePorts(webPort, { isFree = portIsFree, wanted = DEFAULT_PORTS, attempts = 40 } = {}) {
  const taken = new Set();
  const ports = {};
  if (!(await isFree(webPort))) {
    throw new Error(`Port ${webPort} is in use. Close what holds it, or set AWWO_LOCAL_WEB_PORT in local.env (unsent drafts stay with the old address).`);
  }
  ports.web = webPort;
  taken.add(webPort);
  for (const [name, first] of Object.entries(wanted)) {
    if (name === 'web') continue;
    let candidate = first;
    while (taken.has(candidate) || !(await isFree(candidate))) {
      candidate += 1;
      if (candidate >= first + attempts) throw new Error(`No free port for ${name} from ${first} to ${first + attempts - 1}`);
    }
    ports[name] = candidate;
    taken.add(candidate);
  }
  return Object.freeze(ports);
}

/** The few system variables a service needs to run and reach the network (proxies included). Nothing else from the
 *  person's environment reaches a service: a stray AWWO_ setting or model key in their shell cannot change it. */
const SYSTEM_VARIABLES = new Set([
  'PATH', 'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'HOME',
  'LOCALAPPDATA', 'APPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'COMMONPROGRAMFILES',
  'COMSPEC', 'PATHEXT', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'XDG_RUNTIME_DIR',
]);
export function systemEnvironment(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key, value]) => SYSTEM_VARIABLES.has(key.toUpperCase()) && value !== undefined));
}

/** A node's work and a direct task share the hosted site's limits: answers of up to 16,384 tokens in a 131,072-token
 *  window, and deadlines that end before the API's own (AWWO_RUN_TIMEOUT, 30 minutes). */
const MODEL_LIMITS = Object.freeze({ contextWindow: '131072', maxTokens: '16384' });

/**
 * Each service's environment. `capabilities` says which optional services run: python (the OpenAI Agents runtime in
 * Python, as the hosted site runs it; else the JavaScript worker takes its place), docker + image + brokerCore (the
 * managed execution), render (Chrome and ffmpeg). Model credentials never reach the API: in this edition every model
 * call uses the key its person saved in 我的引擎, which the API hands to a worker for that call alone.
 *
 * The sandbox runtime does not run here: the API refuses it with personal model connections (runtime_workers.go
 * probeRuntime), which this edition uses. No media switch opens the media services to every workspace either: the
 * owner's own workspaces (a platform administrator owns them) are offered them (media_setup.go mediaEntitled), and an
 * account someone else registers on this computer cannot spend the owner's media keys.
 */
export function serviceEnvironments({ profile, ports, state, capabilities, system = systemEnvironment(), resetPassword = '' }) {
  const loopback = port => `http://127.0.0.1:${port}`;
  const common = { ...system, APP_ENV: 'development', AWWO_CREDENTIAL_MODE: 'user', AWWO_LLMGATE_ONLY: 'false' };
  const pi = {
    ...common, AWWO_PI_HOST: '127.0.0.1', AWWO_PI_PORT: String(ports.pi), AWWO_PI_TOKEN: profile.AWWO_PI_TOKEN,
    AWWO_PI_CONTEXT_WINDOW: MODEL_LIMITS.contextWindow, AWWO_PI_MAX_TOKENS: MODEL_LIMITS.maxTokens,
    AWWO_PI_TIMEOUT_MS: '600000', AWWO_PI_MAX_CONCURRENCY: '4',
  };
  const agentsBase = {
    ...common, AWWO_OPENAI_AGENTS_HOST: '127.0.0.1', AWWO_OPENAI_AGENTS_CONTEXT_WINDOW: MODEL_LIMITS.contextWindow,
    AWWO_OPENAI_AGENTS_MAX_TOKENS: MODEL_LIMITS.maxTokens, AWWO_OPENAI_AGENTS_MAX_CONCURRENCY: '4',
    // The SDKs otherwise send every run's trace to OpenAI.
    OPENAI_AGENTS_DISABLE_TRACING: '1',
    AWWO_OPENAI_AGENTS_PORT: String(ports.agents), AWWO_OPENAI_AGENTS_TOKEN: profile.AWWO_OPENAI_AGENTS_TOKEN,
  };
  const agentsPython = { ...agentsBase, AWWO_OPENAI_AGENTS_TIMEOUT_MS: '1500000', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' };
  const agentsJs = { ...agentsBase, AWWO_OPENAI_AGENTS_TIMEOUT_MS: '300000' };
  const broker = capabilities.docker && capabilities.image && capabilities.brokerCore ? {
    ...system, AWWO_OPENMAUS_HOST: '127.0.0.1', AWWO_OPENMAUS_PORT: String(ports.broker), AWWO_OPENMAUS_TOKEN: profile.AWWO_OPENMAUS_TOKEN,
    AWWO_OPENMAUS_MODEL_PROXY_ORIGINS: loopback(ports.api), AWWO_OPENMAUS_WORKSPACE_IMAGE: capabilities.image,
    AWWO_OPENMAUS_DOCKER: capabilities.docker, AWWO_OPENMAUS_MAX_CONCURRENT: '2', AWWO_OPENMAUS_DATA_DIR: state.broker,
    AWWO_OPENMAUS_WORKSPACE_TOOLS: 'rea,check-page', AWWO_WORKSPACE_INSTANCE: profile.AWWO_LOCAL_INSTANCE,
  } : null;
  const render = capabilities.render ? {
    ...system, AWWO_RENDER_LISTEN: `127.0.0.1:${ports.render}`, AWWO_RENDER_TOKEN: profile.AWWO_RENDER_TOKEN,
    AWWO_RENDER_CHROME: capabilities.render.chrome, AWWO_RENDER_FFMPEG: capabilities.render.ffmpeg,
    AWWO_RENDER_FFPROBE: capabilities.render.ffprobe, AWWO_RENDER_TMP: state.renderTmp,
  } : null;
  const api = {
    ...common,
    AWWO_LISTEN_ADDR: `127.0.0.1:${ports.api}`, AWWO_PUBLIC_ORIGIN: localOrigin(ports.web, profile.AWWO_LOCAL_HOSTNAME),
    AWWO_DATABASE_URL: `postgres://awwo:${encodeURIComponent(profile.AWWO_LOCAL_DB_PASSWORD)}@127.0.0.1:${ports.database}/awwo?sslmode=disable`,
    AWWO_CREDENTIAL_ENCRYPTION_KEY: profile.AWWO_CREDENTIAL_ENCRYPTION_KEY,
    AWWO_BOOTSTRAP_ADMIN_EMAIL: profile.AWWO_BOOTSTRAP_ADMIN_EMAIL, AWWO_BOOTSTRAP_ADMIN_PASSWORD: profile.AWWO_BOOTSTRAP_ADMIN_PASSWORD,
    AWWO_PI_URL: loopback(ports.pi), AWWO_PI_TOKEN: profile.AWWO_PI_TOKEN, AWWO_PI_SESSION_WAIT: '5s',
    AWWO_OPENAI_AGENTS_URL: loopback(ports.agents), AWWO_OPENAI_AGENTS_TOKEN: profile.AWWO_OPENAI_AGENTS_TOKEN,
    // The hosted site's own values: a run may take 30 minutes and a failed node is tried twice more.
    AWWO_RUN_TIMEOUT: '1800s', AWWO_GRAPH_NODE_RETRIES: '2',
    // One person, no paid plans: no model is held back for a plan.
    AWWO_PLAN_ONLY_MODELS: 'none',
    // Canvas uploads, renders and media files are kept here; the API takes the folder alone (media_config.go).
    AWWO_MEDIA_DIR: state.media, AWWO_WEB_READER: 'on', AWWO_SKILL_REGISTRY: 'on', AWWO_AUTH_REQUESTS_PER_MINUTE: '60',
    // Its wrapper stops it by closing its stdin (awwo-local-reaper.mjs --stdin-stop), in order, as SIGTERM would:
    // Windows has no polite signal for it.
    AWWO_STOP_ON_STDIN_CLOSE: 'true',
    // The local edition (edition.go): the web leaves out the hosted site's plans and pages and shows this computer's
    // settings; no one else signs up here; the data folder is named in those settings.
    AWWO_EDITION: 'local', AWWO_REGISTRATION: 'closed', AWWO_LOCAL_STATE_DIR: path.resolve(state.dir),
    // While a reset --reset-password wrote is pending: the API sets its password on the owner's account, once per id
    // (edition.go).
    ...(resetId(resetPassword) ? { AWWO_BOOTSTRAP_ADMIN_RESET: resetPassword } : {}),
    ...profile.providers,
  };
  // What the API is told of each optional service, added only once that service has come up (apiEnvironment).
  const wiring = {
    broker: broker ? { AWWO_OPENMAUS_URL: loopback(ports.broker), AWWO_OPENMAUS_TOKEN: profile.AWWO_OPENMAUS_TOKEN, AWWO_COMPUTER_MODEL_PROXY_URL: `${loopback(ports.api)}/api/internal/computer-model/v1` } : null,
    render: render ? { AWWO_RENDER_URL: loopback(ports.render), AWWO_RENDER_TOKEN: profile.AWWO_RENDER_TOKEN } : null,
  };
  return Object.freeze({ api, pi, agentsPython, agentsJs, broker, render, wiring });
}

/** The API's environment once the optional services are known: it is told only of those in `up`, so the app shows
 *  the others as not ready instead of sending work to a service that is not there. */
export function apiEnvironment(envs, up) {
  const added = ['broker', 'render'].filter(key => up.has(key) && envs.wiring[key]).map(key => envs.wiring[key]);
  return Object.freeze(Object.assign({}, envs.api, ...added));
}

/** Docker exactly as the workers call it (workspace-sandbox.ts dockerRunner, openmaus-worker/server.ts): their fixed
 *  PATH and LANG, HOME when set, none of the person's DOCKER_* variables; on Windows libuv adds the same system
 *  variables (USERPROFILE, SYSTEMROOT, …) to both. The runtime's check of Docker then sees what the managed execution
 *  will see. */
export function dockerEnvironment(env = process.env) {
  return { PATH: '/usr/bin:/bin:/usr/local/bin', LANG: 'C.UTF-8', ...(env.HOME ? { HOME: env.HOME } : {}) };
}

/** The docker arguments that list, then remove, this instance's workspace containers (WORKSPACE_INSTANCE_LABEL). */
export const instanceContainerQuery = instance => ['ps', '--all', '--quiet', '--filter', `label=awwo.workspace-instance=${instance}`];

/** PostgreSQL's settings, rewritten at every start into awwo-local.conf, which postgresql.conf includes. Keeping them
 *  out of the command line means no quoting through cmd.exe on Windows (pg_ctl starts the server through it). TCP on
 *  127.0.0.1 only; no Unix-domain socket. */
export function postgresSettings(port) {
  return [
    '# Written by AwwO 本地版 at every start; a change here is lost at the next one.',
    "listen_addresses = '127.0.0.1'",
    `port = ${Number(port)}`,
    "unix_socket_directories = ''",
    '',
  ].join('\n');
}
export const POSTGRES_INCLUDE = "include_if_exists = 'awwo-local.conf'";
/** The port a running server listens on, from its postmaster.pid (the fourth line); 0 when it cannot be read. */
export function postgresPort(pidFile) {
  const port = Number(String(pidFile).split(/\r?\n/)[3]);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : 0;
}
/** postgresql.conf with the include line once, checked at every start: a first start cut between initdb and this
 *  line would otherwise leave PostgreSQL on its default port and sockets for good. null when it is there already. */
export function withPostgresInclude(text) {
  const conf = String(text);
  return conf.split(/\r?\n/).some(line => line.trim() === POSTGRES_INCLUDE) ? null : `${conf.trimEnd()}\n\n# AwwO 本地版\n${POSTGRES_INCLUDE}\n`;
}

/** The staged showcase files the web names: the Academy's videos (academyCatalog.ts) and a film case's film and its
 *  download (production-runs/*.media.json). Each is named after the first 16 hex digits of its SHA-256, which a
 *  download is checked against in full. */
export function stagedShowcaseFiles(webSource = path.join(repoRoot, 'apps', 'web', 'src')) {
  const files = new Map();
  const add = (src, bytes, sha256) => {
    const match = /^\/showcase\/staged\/([a-z0-9-]+)\/([0-9a-f]{16})\.mp4$/.exec(src);
    if (!match || match[2] !== String(sha256).slice(0, 16) || !/^[0-9a-f]{64}$/.test(sha256) || !Number.isSafeInteger(bytes) || bytes <= 0) {
      throw new Error(`A staged showcase file is named inconsistently: ${src}`);
    }
    files.set(src, Object.freeze({ src, caseName: match[1], name: `${match[2]}.mp4`, bytes, sha256 }));
  };
  const academy = readFileSync(path.join(webSource, 'saas', 'academyCatalog.ts'), 'utf8');
  for (const match of academy.matchAll(/src: '([^']+)', bytes: (\d+), sha256: '([0-9a-f]{64})'/g)) add(match[1], Number(match[2]), match[3]);
  const runs = path.join(webSource, 'saas', 'production-runs');
  for (const name of readdirSync(runs).filter(file => file.endsWith('.media.json'))) {
    const manifest = JSON.parse(readFileSync(path.join(runs, name), 'utf8'));
    for (const entry of Object.values(manifest)) {
      if (!entry || entry.staged !== true) continue;
      add(entry.src, entry.bytes, entry.sha256);
      if (entry.original) add(entry.original.src, entry.original.bytes, entry.original.sha256);
    }
  }
  return [...files.values()].sort((a, b) => a.src.localeCompare(b.src));
}

/** Finds a program on PATH the way the shell would, PATHEXT included on Windows. */
export function findOnPath(name, { env = process.env, platform = process.platform, exists = existsSync } = {}) {
  const pathValue = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] || '';
  const extensions = platform === 'win32'
    ? (Object.entries(env).find(([key]) => key.toUpperCase() === 'PATHEXT')?.[1] || '.EXE;.CMD;.BAT').split(';').filter(Boolean)
    : [''];
  for (const dir of pathValue.split(platform === 'win32' ? ';' : ':').filter(Boolean)) {
    for (const extension of platform === 'win32' && path.extname(name) ? [''] : extensions) {
      const candidate = path.join(dir, `${name}${extension.toLowerCase()}`);
      if (exists(candidate)) return candidate;
    }
  }
  return '';
}

const POSTGRES_TOOLS = ['initdb', 'pg_ctl', 'postgres', 'psql', 'createdb'];

/** PostgreSQL's programs: AWWO_LOCAL_PG_BIN, then the copy setup:local downloads, then PATH. A directory counts only
 *  when it has all five the runtime uses. */
export function resolvePostgresBin(layout, { env = process.env, platform = process.platform, exists = existsSync } = {}) {
  const onPath = findOnPath('pg_ctl', { env, platform, exists });
  for (const dir of [env.AWWO_LOCAL_PG_BIN, layout.pgBin, onPath && path.dirname(onPath)].filter(Boolean)) {
    if (POSTGRES_TOOLS.every(name => exists(path.join(dir, platform === 'win32' ? `${name}.exe` : name)))) return dir;
  }
  return '';
}

/** The browsers the render worker can drive, in order of preference: Chrome, then Edge, which every Windows has. */
export function browserCandidates(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    const roots = [env.ProgramFiles || 'C:\\Program Files', env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', env.LOCALAPPDATA].filter(Boolean);
    return [
      ...roots.map(root => path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe')),
      ...roots.map(root => path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe')),
    ];
  }
  if (platform === 'darwin') return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'];
  return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
}
