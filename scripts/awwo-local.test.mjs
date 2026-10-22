// Tests for AwwO 本地版's runtime decisions (scripts/awwo-local-lib.mjs), its process wrapper (awwo-local-reaper.mjs),
// its locks and its setup helpers; the web server's are in awwo-local-web.test.mjs. Nothing here starts the real
// services; the one contract test runs the built API binary only far enough to see it accept its settings.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  DEFAULT_PORTS, GENERATED_SECRETS, LOCAL_HOST, OWNER_EMAIL, POSTGRES_INCLUDE, allocatePorts, apiEnvironment, dockerEnvironment,
  findOnPath, instanceContainerQuery, loadLocalProfile, localLayout, localOrigin, localState, osLock, parseAcl, portIsFree,
  PASSWORD_RESET_PENDING, passwordResetApplied, postgresPath, postgresPathNote, postgresPort, postgresSettings, postgresShellUnsafe, privateFile, privateFolder, protectStateDirectory, resetId, resetOwnerPassword,
  resolvePostgresBin, serviceEnvironments, writeOwnerCredentials,
  stagedShowcaseFiles, systemEnvironment, windowsShortPath, withPostgresInclude, workspaceImageTag,
} from './awwo-local-lib.mjs';
import { acquireLock, holdBuild, parseArguments, removeInstanceContainers } from './awwo-local.mjs';
import { INSTALL_FLAGS, NODE_RELEASE, POSTGRES_WINDOWS, holdBuildExclusively, workspaceSourceHash } from './awwo-local-setup.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const reaper = path.join(here, 'awwo-local-reaper.mjs');
const scratch = () => mkdtempSync(path.join(os.tmpdir(), 'awwo-local-test-'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const fixedRandom = () => {
  let counter = 0;
  return size => Buffer.alloc(size, ++counter);
};

test('the layout keeps built pieces under .local/awwo-local/build and names Windows programs with .exe', () => {
  const windows = localLayout({ resources: 'C:\\awwo', build: 'C:\\awwo\\build', platform: 'win32' });
  assert.equal(windows.api, path.join('C:\\awwo\\build', 'awwo-api.exe'));
  assert.equal(windows.node, path.join('C:\\awwo\\build', 'node', 'node.exe'));
  assert.equal(windows.python, path.join('C:\\awwo\\build', 'python', 'Scripts', 'python.exe'));
  const linux = localLayout({ resources: '/srv/awwo', build: '/srv/awwo/build', platform: 'linux' });
  assert.equal(linux.api, path.join('/srv/awwo/build', 'awwo-api'));
  assert.equal(linux.node, path.join('/srv/awwo/build', 'node', 'bin', 'node'));
  assert.equal(linux.web, path.join('/srv/awwo', 'apps', 'web', 'dist-saas'));
  assert.equal(localLayout({ resources: '/r' }).build, path.join('/r', '.local', 'awwo-local', 'build'));
  assert.deepEqual([linux.codeLock, linux.buildLock], [null, null], 'code and a build no setup serves (a packaged app\'s) have no lock');
});

/** A checkout as setup:local serves it: it carries the setup script; its own build is .local/awwo-local/build. */
function checkoutTree() {
  const root = scratch();
  mkdirSync(path.join(root, 'scripts'));
  writeFileSync(path.join(root, 'scripts', 'awwo-local-setup.mjs'), '');
  const build = path.join(root, '.local', 'awwo-local', 'build');
  mkdirSync(build, { recursive: true });
  return { root, build };
}

test('the code and the build have a lock where setup serves them, each whatever its other half', async () => {
  const a = checkoutTree();
  const b = checkoutTree();
  // The build's lock is named after its real path (a temporary folder may be reached through a short name, ADMINI~1).
  const lockOf = build => path.join(realpathSync.native(build), 'build.lock');
  const own = localLayout({ resources: a.root, build: a.build });
  assert.equal(own.codeLock, path.join(a.root, '.local', 'awwo-local', 'code.lock'));
  assert.equal(own.buildLock, lockOf(a.build));
  const mixed = localLayout({ resources: a.root, build: b.build });
  assert.deepEqual([mixed.codeLock, mixed.buildLock], [own.codeLock, lockOf(b.build)], 'this code with another checkout\'s build');
  const packaged = localLayout({ resources: scratch(), build: b.build });
  assert.deepEqual([packaged.codeLock, packaged.buildLock], [null, lockOf(b.build)], 'a packaged app\'s code with a checkout\'s build');
  assert.equal(localLayout({ resources: a.root, build: scratch() }).buildLock, null, 'a build of its own, which no setup writes');
  // A checkout's build named through a junction (a symbolic link elsewhere) is still that checkout's.
  const link = (target, at) => symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir');
  const alias = path.join(scratch(), 'build-alias');
  link(b.build, alias);
  assert.equal(localLayout({ resources: scratch(), build: alias }).buildLock, lockOf(b.build));
  // So is one whose .local was moved to another folder (another drive) and linked back; setup still serves it.
  const elsewhere = path.join(scratch(), 'awwo-cache');
  mkdirSync(path.join(elsewhere, 'awwo-local', 'build'), { recursive: true });
  const linked = path.join(scratch(), 'checkout');
  mkdirSync(path.join(linked, 'scripts'), { recursive: true });
  writeFileSync(path.join(linked, 'scripts', 'awwo-local-setup.mjs'), '');
  link(elsewhere, path.join(linked, '.local'));
  const layoutLinked = localLayout({ resources: linked });
  assert.equal(layoutLinked.buildLock, lockOf(path.join(elsewhere, 'awwo-local', 'build')));
  await (await holdBuildExclusively(layoutLinked, { lock: (target, options) => osLock(target, { ...options, attempts: 1 }) }))();
});

test('the first start makes every secret once, and later starts keep them exactly', async () => {
  const state = localState(scratch());
  const first = await loadLocalProfile(state, { random: fixedRandom() });
  for (const name of [...GENERATED_SECRETS, 'AWWO_CREDENTIAL_ENCRYPTION_KEY']) assert.ok(first[name]?.length >= 32, name);
  assert.equal(Buffer.from(first.AWWO_CREDENTIAL_ENCRYPTION_KEY, 'base64').length, 32);
  assert.equal(first.AWWO_BOOTSTRAP_ADMIN_EMAIL, OWNER_EMAIL);
  assert.equal(first.AWWO_LOCAL_WEB_PORT, String(DEFAULT_PORTS.web));
  assert.match(first.AWWO_LOCAL_INSTANCE, /^local-[0-9a-f]{12}$/);
  assert.equal(new Set(GENERATED_SECRETS.map(name => first[name])).size, GENERATED_SECRETS.length, 'each secret is its own');
  const saved = readFileSync(state.env, 'utf8');
  const second = await loadLocalProfile(state, { random: () => Buffer.alloc(32, 0xee) });
  assert.equal(readFileSync(state.env, 'utf8'), saved, 'nothing is rewritten when nothing is new');
  for (const name of [...GENERATED_SECRETS, 'AWWO_CREDENTIAL_ENCRYPTION_KEY', 'AWWO_LOCAL_INSTANCE', 'AWWO_LOCAL_HOSTNAME']) assert.equal(second[name], first[name]);
  assert.match(readFileSync(state.credentials, 'utf8'), new RegExp(`Password: ${first.AWWO_BOOTSTRAP_ADMIN_PASSWORD}`));
  assert.match(readFileSync(state.providers, 'utf8'), /^AWWO_RUNNINGHUB_API_KEY=$/m);
});

test('every data folder answers under a name of its own, made once, after its instance', async () => {
  const state = localState(scratch());
  const one = await loadLocalProfile(state, { random: fixedRandom() });
  assert.match(one.AWWO_LOCAL_HOSTNAME, /^awwo-[0-9a-f]{12}\.localhost$/);
  assert.equal(one.AWWO_LOCAL_HOSTNAME, `awwo-${one.AWWO_LOCAL_INSTANCE.slice('local-'.length)}.localhost`, 'named after its instance');
  assert.equal((await loadLocalProfile(state)).AWWO_LOCAL_HOSTNAME, one.AWWO_LOCAL_HOSTNAME, 'a saved name is kept');
  const two = await loadLocalProfile(localState(scratch()));
  assert.notEqual(two.AWWO_LOCAL_HOSTNAME, one.AWWO_LOCAL_HOSTNAME, 'two data folders, of one checkout or two, never share a name');
  // A profile that kept awwo.localhost, the name a person types, as its own gets its own; nothing else changes.
  writeFileSync(state.env, readFileSync(state.env, 'utf8').replace(/^AWWO_LOCAL_HOSTNAME=.*$/m, `AWWO_LOCAL_HOSTNAME=${LOCAL_HOST}`));
  const kept = await loadLocalProfile(state, { random: () => Buffer.alloc(32, 0xee) });
  assert.equal(kept.AWWO_LOCAL_HOSTNAME, one.AWWO_LOCAL_HOSTNAME);
  for (const name of [...GENERATED_SECRETS, 'AWWO_CREDENTIAL_ENCRYPTION_KEY', 'AWWO_LOCAL_INSTANCE']) assert.equal(kept[name], one[name], name);
  for (const bad of ['evil.example', 'awwo.localhost.evil.example', 'AWWO.localhost', '-awwo.localhost', 'a b.localhost']) {
    const named = localState(scratch());
    await loadLocalProfile(named, { random: fixedRandom() });
    writeFileSync(named.env, readFileSync(named.env, 'utf8').replace(/^AWWO_LOCAL_HOSTNAME=.*$/m, `AWWO_LOCAL_HOSTNAME=${bad}`));
    await assert.rejects(loadLocalProfile(named), /AWWO_LOCAL_HOSTNAME .* under \.localhost/, bad);
  }
});

test('a missing secret is added without touching the vault key or the others', async () => {
  const state = localState(scratch());
  const first = await loadLocalProfile(state, { random: fixedRandom() });
  const without = readFileSync(state.env, 'utf8').split('\n').filter(line => !line.startsWith('AWWO_RENDER_TOKEN=')).join('\n');
  writeFileSync(state.env, without);
  const second = await loadLocalProfile(state, { random: () => Buffer.alloc(32, 0x42) });
  assert.equal(second.AWWO_RENDER_TOKEN, Buffer.alloc(32, 0x42).toString('base64url'));
  assert.equal(second.AWWO_CREDENTIAL_ENCRYPTION_KEY, first.AWWO_CREDENTIAL_ENCRYPTION_KEY);
  assert.equal(second.AWWO_LOCAL_DB_PASSWORD, first.AWWO_LOCAL_DB_PASSWORD);
});

test('a local.env that lost the vault key or the database password is refused while the database exists', async () => {
  for (const lost of ['AWWO_CREDENTIAL_ENCRYPTION_KEY', 'AWWO_LOCAL_DB_PASSWORD']) {
    const state = localState(scratch());
    await loadLocalProfile(state, { random: fixedRandom() });
    mkdirSync(state.postgres, { recursive: true });
    writeFileSync(path.join(state.postgres, 'PG_VERSION'), '18\n');
    const kept = readFileSync(state.env, 'utf8').split('\n').filter(line => !line.startsWith(`${lost}=`)).join('\n');
    writeFileSync(state.env, kept);
    await assert.rejects(loadLocalProfile(state), new RegExp(`lost ${lost}`));
    assert.equal(readFileSync(state.env, 'utf8'), kept, 'local.env is left as it is');
  }
});

test('an unreadable local.env is refused and left as it is, never replaced', async () => {
  const state = localState(scratch());
  writeFileSync(state.env, 'AWWO_CREDENTIAL_ENCRYPTION_KEY=keep\nthis is not a setting\n');
  await assert.rejects(loadLocalProfile(state), /local\.env .* cannot be read/);
  assert.equal(readFileSync(state.env, 'utf8'), 'AWWO_CREDENTIAL_ENCRYPTION_KEY=keep\nthis is not a setting\n');
});

test('providers.env passes set media keys and refuses names it does not know', async () => {
  const state = localState(scratch());
  mkdirSync(state.dir, { recursive: true });
  writeFileSync(state.providers, 'AWWO_RUNNINGHUB_API_KEY=rh-key\nAWWO_TRIPO_API_KEY=\n');
  const profile = await loadLocalProfile(state, { random: fixedRandom() });
  assert.deepEqual(profile.providers, { AWWO_RUNNINGHUB_API_KEY: 'rh-key' });
  writeFileSync(state.providers, 'AWWO_RUNNINGHUB_API_KEY=rh-key\nAWWO_CREDENTIAL_MODE=operator\n');
  await assert.rejects(loadLocalProfile(state), /unknown setting AWWO_CREDENTIAL_MODE/);
});

test('providers.env takes a proxy only as http://127.0.0.1:<port>, and says so itself', async () => {
  const state = localState(scratch());
  mkdirSync(state.dir, { recursive: true });
  writeFileSync(state.providers, 'AWWO_WEB_READER_PROXY=http://127.0.0.1:7897\nAWWO_MEDIA_DEV_PROXY=http://127.0.0.1:65535\n');
  assert.deepEqual((await loadLocalProfile(state, { random: fixedRandom() })).providers,
    { AWWO_WEB_READER_PROXY: 'http://127.0.0.1:7897', AWWO_MEDIA_DEV_PROXY: 'http://127.0.0.1:65535' });
  for (const bad of ['http://localhost:7897', 'https://127.0.0.1:7897', 'http://127.0.0.1', 'http://127.0.0.1:0', 'http://127.0.0.1:07897',
    'http://127.0.0.1:65536', 'http://127.0.0.1:7897/', 'http://10.0.0.2:3128', 'socks5://127.0.0.1:7897']) {
    writeFileSync(state.providers, `AWWO_WEB_READER_PROXY=${bad}\n`);
    await assert.rejects(loadLocalProfile(state), /providers\.env: AWWO_WEB_READER_PROXY must be http:\/\/127\.0\.0\.1:<port>/, bad);
  }
});

test('a password reset gives the owner a new password in both files and keeps every other setting', async () => {
  const state = localState(scratch());
  assert.equal(await resetOwnerPassword(state), false, 'a folder with no settings yet has nothing to reset');
  const first = await loadLocalProfile(state, { random: fixedRandom() });
  assert.equal(await resetOwnerPassword(state, { random: size => Buffer.alloc(size, size === 32 ? 0x5a : 0x5b) }), true);
  const after = await loadLocalProfile(state, { random: () => Buffer.alloc(32, 0xee) });
  const fresh = Buffer.alloc(32, 0x5a).toString('base64url');
  const id = Buffer.alloc(18, 0x5b).toString('base64url');
  assert.equal(after.AWWO_BOOTSTRAP_ADMIN_PASSWORD, fresh);
  assert.notEqual(fresh, first.AWWO_BOOTSTRAP_ADMIN_PASSWORD);
  assert.match(readFileSync(state.credentials, 'utf8'), new RegExp(`Password: ${fresh}\\n`));
  for (const name of [...GENERATED_SECRETS.filter(name => name !== 'AWWO_BOOTSTRAP_ADMIN_PASSWORD'), 'AWWO_CREDENTIAL_ENCRYPTION_KEY', 'AWWO_LOCAL_INSTANCE', 'AWWO_LOCAL_HOSTNAME', 'AWWO_BOOTSTRAP_ADMIN_EMAIL']) {
    assert.equal(after[name], first[name], name);
  }
  // Pending, by its id, until an API has started with it: a start that fails first leaves the next one to finish it.
  assert.equal(after[PASSWORD_RESET_PENDING], id);
  assert.equal(resetId(id), id);
  // A reset cut short between its two files left the old password in the sign-in file: a start rewrites it first.
  writeFileSync(state.credentials, readFileSync(state.credentials, 'utf8').replace(fresh, first.AWWO_BOOTSTRAP_ADMIN_PASSWORD));
  await writeOwnerCredentials(state, after);
  assert.match(readFileSync(state.credentials, 'utf8'), new RegExp(`Password: ${fresh}\\n`));
  assert.equal((await loadLocalProfile(state))[PASSWORD_RESET_PENDING], id, 'still pending at the next start');
  await passwordResetApplied(state);
  const done = await loadLocalProfile(state);
  assert.equal(done[PASSWORD_RESET_PENDING], undefined);
  assert.equal(done.AWWO_BOOTSTRAP_ADMIN_PASSWORD, fresh, 'the new password stays');
  assert.equal(done.AWWO_CREDENTIAL_ENCRYPTION_KEY, first.AWWO_CREDENTIAL_ENCRYPTION_KEY);
  await passwordResetApplied(state);
  // The API is given the pending reset's id (it applies each once), and nothing without one or for a value that is not one.
  const environment = resetPassword => serviceEnvironments({ profile: profileFor(), ports: testPorts, state: testState, capabilities: {}, system: {}, resetPassword }).api.AWWO_BOOTSTRAP_ADMIN_RESET;
  assert.equal(environment(id), id);
  assert.equal(environment(''), undefined);
  for (const bad of ['pending', 'true', 'short', 'a b c d e f g h i j']) assert.equal(environment(resetId(bad)), undefined, bad);
});

// Access lists as the runtime reads them (lib readAcl): owner|protected|entries, every SID in full. Full control is
// 2032127; 3 passes an entry to folders and files. S-1-5-18 is SYSTEM, S-1-5-32-544 Administrators, S-1-5-11
// Authenticated Users, S-1-5-32-545 Users.
const SID = 'S-1-5-21-1-2-3-1001';
const entry = (sid, { allow = true, inherited = false, inheritance = 3, rights = 2032127 } = {}) => `${allow ? 'Allow' : 'Deny'},${inherited ? 'True' : 'False'},${inheritance},0,${rights},${sid}`;
const acl = (owner, isProtected, ...entries) => `${owner}|${isProtected ? 'True' : 'False'}|${entries.join(';')}`;
const inheritedHere = { inherited: true, inheritance: 0 };
const PRIVATE_FOLDER = acl(SID, true, entry('S-1-5-18'), entry(SID));
const PRIVATE_FILE = acl(SID, false, entry('S-1-5-18', inheritedHere), entry(SID, inheritedHere));
const OPEN_FOLDER = acl(SID, false, ...['S-1-5-18', 'S-1-5-32-544'].map(sid => entry(sid, { inherited: true })), entry('S-1-5-11', { inherited: true, rights: 1245631 }), entry('S-1-5-32-545', { inherited: true, rights: 1179817 }));
const OPEN_FILE = acl(SID, false, ...['S-1-5-18', 'S-1-5-32-544'].map(sid => entry(sid, inheritedHere)), entry('S-1-5-11', { ...inheritedHere, rights: 1245631 }), entry('S-1-5-32-545', { ...inheritedHere, rights: 1179817 }));

test('a folder is private only with this account\'s SID and SYSTEM as its two entries, inheritance off, and a trusted owner', () => {
  assert.ok(privateFolder(PRIVATE_FOLDER, SID));
  assert.ok(!privateFolder(acl(SID, true, entry('S-1-5-18'), entry('S-1-5-32-545')), SID), 'Users in this account\'s place');
  assert.ok(!privateFolder(acl(SID, true, entry('S-1-5-18'), entry('S-1-5-21-1-2-3-1002')), SID), 'another account');
  assert.ok(!privateFolder(`${PRIVATE_FOLDER};${entry('S-1-5-32-545', { rights: 1179817 })}`, SID), 'a third entry');
  assert.ok(!privateFolder(OPEN_FOLDER, SID), 'inherited entries');
  assert.ok(!privateFolder(acl(SID, false, entry('S-1-5-18'), entry(SID)), SID), 'inheritance on');
  assert.ok(!privateFolder(acl(SID, true, entry('S-1-5-18', { inheritance: 1 }), entry(SID, { inheritance: 1 })), SID), 'not passed to its files');
  assert.ok(!privateFolder(acl(SID, true, entry('S-1-5-18'), entry(SID, { rights: 1245631 })), SID), 'modify, not full control');
  assert.ok(!privateFolder(acl('S-1-5-21-9-9-9-1002', true, entry('S-1-5-18'), entry(SID)), SID), 'another account\'s folder');
  assert.ok(privateFolder(acl('S-1-5-32-544', true, entry('S-1-5-18'), entry(SID)), SID), 'Administrators own what an elevated process makes');
  const administrator = 'S-1-5-21-1-2-3-500';
  assert.ok(privateFolder(acl(administrator, true, entry('S-1-5-18'), entry(administrator)), administrator), 'the built-in Administrator account, which SDDL would write as LA');
  assert.ok(!privateFolder(PRIVATE_FOLDER, ''), 'without this account\'s SID nothing is private');
  assert.ok(!privateFolder('MISSING', SID));
  assert.ok(privateFile(PRIVATE_FILE, SID));
  assert.ok(!privateFile(OPEN_FILE, SID));
  assert.ok(privateFile(`${PRIVATE_FILE};${entry('S-1-1-0', { allow: false, inherited: false, inheritance: 0 })}`, SID), 'a deny entry lets nobody in');
  assert.ok(!privateFile('MISSING', SID));
  assert.deepEqual(parseAcl(PRIVATE_FOLDER).rules.map(rule => rule.sid), ['S-1-5-18', SID]);
});

/** Windows as protectStateDirectory sees it: whoami, icacls and Get-Acl through PowerShell, over a folder and its
 *  files that icacls changes. */
function fakeWindows({ owner = SID, setStatus = 0, applies = true, whoami = 0, powershell = 0 } = {}) {
  const at = line => `${owner}${line.slice(SID.length)}`;
  const windows = { folder: at(OPEN_FOLDER), file: OPEN_FILE, calls: [] };
  windows.run = (command, args, options = {}) => {
    const name = path.win32.basename(command, '.exe').toLowerCase();
    assert.ok(path.win32.isAbsolute(command), 'Windows programs are called by their full path');
    windows.calls.push([name, ...args]);
    if (name === 'whoami') return { status: whoami, stdout: whoami ? '' : `"pc\\owner","${SID}"\r\n` };
    if (name === 'powershell') {
      if (powershell) return { status: powershell, stdout: '' };
      const paths = options.env.AWWO_ACL_PATHS.split('|');
      return { status: 0, stdout: `${paths.map((_, index) => index === 0 ? windows.folder : windows.file).join('\r\n')}\r\n` };
    }
    if (name === 'icacls' && args.includes('/inheritance:r')) {
      if (!setStatus && applies) windows.folder = at(PRIVATE_FOLDER);
      return { status: setStatus, stdout: '' };
    }
    if (name === 'icacls' && args.includes('/reset')) {
      if (applies) windows.file = PRIVATE_FILE;
      return { status: 0, stdout: '' };
    }
    throw new Error(`unexpected call: ${name} ${args.join(' ')}`);
  };
  return windows;
}
const windowsEnv = { SystemRoot: 'C:\\Windows' };

test('protecting the data folder on Windows grants this account\'s SID and SYSTEM, resets the runtime\'s own entries, and reads it back', () => {
  const dir = scratch();
  writeFileSync(path.join(dir, 'local.env'), 'x');
  writeFileSync(path.join(dir, 'notes.txt'), 'the person\'s own');
  const windows = fakeWindows();
  assert.equal(protectStateDirectory(dir, { platform: 'win32', run: windows.run, env: windowsEnv }), 'protected');
  const set = windows.calls.find(call => call.includes('/inheritance:r'));
  assert.deepEqual(set.slice(1), [dir, '/inheritance:r', '/grant:r', `*${SID}:(OI)(CI)F`, '/grant:r', '*S-1-5-18:(OI)(CI)F', '/Q']);
  const resets = windows.calls.filter(call => call.includes('/reset')).map(call => path.basename(call[1]));
  assert.deepEqual(resets, ['local.env'], 'only what the runtime keeps there takes the folder\'s list');
  windows.calls.length = 0;
  assert.equal(protectStateDirectory(dir, { platform: 'win32', run: windows.run, env: windowsEnv }), 'already private');
  assert.deepEqual(windows.calls.map(call => call[0]), ['whoami', 'powershell'], 'a protected folder is only read');
});

test('a data folder of another account, one that is not AwwO\'s, or one that cannot be made private is refused', () => {
  const protect = (dir, options) => protectStateDirectory(dir, { platform: 'win32', run: fakeWindows(options).run, env: windowsEnv });
  assert.throws(() => protect(scratch(), { owner: 'S-1-5-21-9-9-9-1002' }), /belongs to another account/);
  const foreign = scratch();
  writeFileSync(path.join(foreign, 'thesis.docx'), 'x');
  const untouched = fakeWindows();
  assert.throws(() => protectStateDirectory(foreign, { platform: 'win32', run: untouched.run, env: windowsEnv }), /not an AwwO 本地版 data folder/);
  assert.ok(!untouched.calls.some(call => call[0] === 'icacls'), 'a folder that is not AwwO\'s is never changed');
  assert.throws(() => protect(scratch(), { setStatus: 5 }), /Cannot restrict/);
  assert.throws(() => protect(scratch(), { applies: false }), /could not be made private/);
  assert.throws(() => protect(scratch(), { whoami: 1 }), /SID/);
  assert.throws(() => protect(scratch(), { powershell: 1 }), /permissions/);
  assert.equal(protect(scratch(), { owner: 'S-1-5-32-544' }), 'protected', 'a folder an elevated process made (Administrators own it)');
});

test('elsewhere the data folder gets mode 700, and another account\'s folder or one that is not AwwO\'s is refused', () => {
  const posix = (dir, uid = statSync(dir).uid) => protectStateDirectory(dir, { platform: 'linux', uid });
  const fresh = scratch();
  chmodSync(fresh, 0o755);
  assert.equal(posix(fresh), 'mode 700');
  const foreign = scratch();
  writeFileSync(path.join(foreign, 'thesis.docx'), 'x');
  chmodSync(foreign, 0o755);
  assert.throws(() => posix(foreign), /not an AwwO 本地版 data folder/);
  assert.throws(() => posix(scratch(), statSync(fresh).uid + 1), /belongs to another account/);
  if (process.platform !== 'win32') {
    assert.equal(statSync(fresh).mode & 0o777, 0o700);
    assert.equal(statSync(foreign).mode & 0o777, 0o755, 'a refused folder is left as it was');
    assert.equal(posix(fresh), 'already private');
  }
});

test('ports: a busy web port is an error, a busy service port moves to the next free one', async () => {
  const busy = new Set([DEFAULT_PORTS.api, DEFAULT_PORTS.api + 1, DEFAULT_PORTS.database]);
  const ports = await allocatePorts(5199, { isFree: async port => !busy.has(port) });
  assert.equal(ports.web, 5199);
  assert.equal(ports.api, DEFAULT_PORTS.api + 2);
  assert.equal(ports.database, DEFAULT_PORTS.database + 1);
  assert.equal(new Set(Object.values(ports)).size, Object.keys(ports).length, 'no port is given twice');
  await assert.rejects(allocatePorts(5199, { isFree: async port => port !== 5199 }), /Port 5199 is in use/);
  await assert.rejects(allocatePorts(5199, { isFree: async port => port === 5199, attempts: 3 }), /No free port for api/);
});

test('ports: two services that want the same port get two', async () => {
  const ports = await allocatePorts(6000, { isFree: async () => true, wanted: { web: 6000, api: 7000, pi: 7000, database: 6000 } });
  assert.deepEqual(new Set(Object.values(ports)).size, 4);
});

test('a port held on [::1] is busy there, where browsers try *.localhost first', async t => {
  const holder = net.createServer();
  const listening = await new Promise(resolve => {
    holder.once('error', () => resolve(false));
    holder.listen(0, '::1', () => resolve(true));
  });
  if (!listening) return t.skip('this computer has no IPv6 loopback');
  try {
    assert.equal(await portIsFree(holder.address().port, '::1'), false);
  } finally {
    await new Promise(resolve => holder.close(resolve));
  }
});

test('a service gets the system variables it needs and nothing else from the shell', () => {
  const system = systemEnvironment({
    Path: 'C:\\bin', SystemRoot: 'C:\\Windows', HTTPS_PROXY: 'http://127.0.0.1:7897', OPENAI_API_KEY: 'sk-leak',
    AWS_SECRET_ACCESS_KEY: 'leak', AWWO_CREDENTIAL_MODE: 'operator', NODE_OPTIONS: '--require evil.js', ANTHROPIC_API_KEY: 'leak',
    DOCKER_HOST: 'tcp://elsewhere',
  });
  assert.deepEqual(Object.keys(system).sort(), ['HTTPS_PROXY', 'Path', 'SystemRoot']);
});

test('docker is checked as the workers call it: their PATH and HOME, none of the person\'s DOCKER_ settings', () => {
  const env = dockerEnvironment({ Path: 'C:\\other', SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\o', HOME: '/home/o', DOCKER_HOST: 'tcp://x', DOCKER_CONTEXT: 'y' });
  assert.deepEqual(env, { PATH: '/usr/bin:/bin:/usr/local/bin', LANG: 'C.UTF-8', HOME: '/home/o' });
  assert.deepEqual(dockerEnvironment({ Path: 'C:\\other' }), { PATH: '/usr/bin:/bin:/usr/local/bin', LANG: 'C.UTF-8' });
  // The workers' own: the workspace sandbox's runner and the broker's readiness check.
  const sandbox = readFileSync(path.join(here, '..', 'apps', 'openai-agents-worker', 'workspace-sandbox.ts'), 'utf8');
  assert.match(sandbox, /const env: NodeJS\.ProcessEnv = \{ PATH: '\/usr\/bin:\/bin:\/usr\/local\/bin', LANG: 'C\.UTF-8' \};\s+if \(process\.env\.HOME\) env\.HOME = process\.env\.HOME;/);
  const broker = readFileSync(path.join(here, '..', 'apps', 'openmaus-worker', 'server.ts'), 'utf8');
  assert.match(broker, /env: \{ PATH: '\/usr\/bin:\/bin:\/usr\/local\/bin', \.\.\.\(process\.env\.HOME \? \{ HOME: process\.env\.HOME \} : \{\}\) \}/);
});

function profileFor(providers = {}) {
  const profile = Object.fromEntries(GENERATED_SECRETS.map(name => [name, `${name.toLowerCase()}-value-0123456789abcdef`]));
  // The vault key in the shape the API takes: 32 bytes, base64.
  return { ...profile, AWWO_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), AWWO_LOCAL_DB_PASSWORD: 'p@ss/word', AWWO_BOOTSTRAP_ADMIN_EMAIL: OWNER_EMAIL, AWWO_LOCAL_INSTANCE: 'local-0123456789ab', AWWO_LOCAL_HOSTNAME: 'awwo-0123456789ab.localhost', providers };
}
const testPorts = { web: 5199, api: 18087, database: 15483, pi: 18097, agents: 18099, broker: 18109, render: 18111 };
const testState = localState(path.join(os.tmpdir(), 'awwo-state'));
const allCapabilities = { python: '/py', docker: '/usr/bin/docker', image: 'awwo-workspace:local-abc', brokerCore: true, render: { chrome: '/chrome', ffmpeg: '/ffmpeg', ffprobe: '/ffprobe' } };

test('the API listens on loopback, accepts only the instance\'s origin, runs on personal keys, and stops when its stdin closes', () => {
  const envs = serviceEnvironments({ profile: profileFor(), ports: testPorts, state: testState, capabilities: { python: '' }, system: { PATH: '/bin' } });
  const api = envs.api;
  assert.equal(api.AWWO_LISTEN_ADDR, '127.0.0.1:18087');
  assert.equal(api.AWWO_PUBLIC_ORIGIN, 'http://awwo-0123456789ab.localhost:5199', 'the instance\'s own name');
  assert.equal(localOrigin(5199), 'http://awwo.localhost:5199');
  assert.equal(api.AWWO_CREDENTIAL_MODE, 'user');
  assert.equal(api.AWWO_LLMGATE_ONLY, 'false');
  assert.equal(api.APP_ENV, 'development');
  assert.equal(api.AWWO_DATABASE_URL, 'postgres://awwo:p%40ss%2Fword@127.0.0.1:15483/awwo?sslmode=disable');
  assert.equal(api.AWWO_PLAN_ONLY_MODELS, 'none');
  assert.equal(api.AWWO_RUN_TIMEOUT, '1800s');
  assert.equal(api.AWWO_MEDIA_DIR, testState.media);
  assert.equal(api.AWWO_STOP_ON_STDIN_CLOSE, 'true');
  assert.deepEqual([api.AWWO_EDITION, api.AWWO_REGISTRATION, api.AWWO_LOCAL_STATE_DIR], ['local', 'closed', path.resolve(testState.dir)]);
  assert.equal(api.PATH, '/bin');
  for (const key of ['AWWO_SANDBOX_AGENTS_URL', 'AWWO_WORKSPACE_CALLBACK_URL', 'AWWO_OPENMAUS_URL', 'AWWO_RENDER_URL', 'AWWO_RUNNINGHUB_API_KEY']) assert.equal(api[key], undefined, key);
  assert.equal(envs.broker, null);
  assert.equal(envs.render, null);
});

test('no switch opens the media services to every workspace: the owner\'s own are offered them (media_setup.go)', () => {
  const keyed = serviceEnvironments({ profile: profileFor({ AWWO_RUNNINGHUB_API_KEY: 'r'.repeat(32), AWWO_TRIPO_API_KEY: 't'.repeat(32), AWWO_XTASY_API_KEY: 'x'.repeat(32) }), ports: testPorts, state: testState, capabilities: {}, system: {} }).api;
  for (const key of ['AWWO_MEDIA_UNRESTRICTED_WORKSPACES', 'AWWO_TRIPO_ALL_WORKSPACES', 'AWWO_XTASY_ALL_WORKSPACES', 'AWWO_JIMENG_ALL_WORKSPACES', 'AWWO_MAX_OWNED_WORKSPACES']) assert.equal(keyed[key], undefined, key);
  assert.equal(keyed.AWWO_RUNNINGHUB_API_KEY, 'r'.repeat(32));
});

test('each worker gets its own token and limits, and no other service\'s secrets', () => {
  const profile = profileFor({ AWWO_RUNNINGHUB_API_KEY: 'rh-key' });
  const envs = serviceEnvironments({ profile, ports: testPorts, state: testState, capabilities: allCapabilities, system: {} });
  assert.equal(envs.pi.AWWO_PI_TOKEN, profile.AWWO_PI_TOKEN);
  assert.equal(envs.pi.AWWO_PI_PORT, '18097');
  for (const agents of [envs.agentsPython, envs.agentsJs]) {
    assert.equal(agents.AWWO_OPENAI_AGENTS_TOKEN, profile.AWWO_OPENAI_AGENTS_TOKEN);
    assert.equal(agents.AWWO_OPENAI_AGENTS_PORT, '18099');
    assert.equal(agents.OPENAI_AGENTS_DISABLE_TRACING, '1');
  }
  assert.equal(envs.agentsPython.PYTHONUTF8, '1');
  assert.equal(envs.agentsPython.AWWO_OPENAI_AGENTS_TIMEOUT_MS, '1500000');
  assert.equal(envs.agentsJs.AWWO_OPENAI_AGENTS_TIMEOUT_MS, '300000', 'the JavaScript worker keeps the hosted 5-minute deadline');
  assert.equal(envs.agentsJs.PYTHONUTF8, undefined);
  const secrets = [...GENERATED_SECRETS, 'AWWO_CREDENTIAL_ENCRYPTION_KEY'].map(name => profile[name]);
  const own = {
    pi: [profile.AWWO_PI_TOKEN], agentsPython: [profile.AWWO_OPENAI_AGENTS_TOKEN], agentsJs: [profile.AWWO_OPENAI_AGENTS_TOKEN],
    broker: [profile.AWWO_OPENMAUS_TOKEN], render: [profile.AWWO_RENDER_TOKEN],
  };
  for (const [name, allowed] of Object.entries(own)) {
    const values = Object.values(envs[name]);
    for (const secret of secrets) if (!allowed.includes(secret)) assert.ok(!values.includes(secret), `${name} must not see another service's secret`);
    assert.ok(!values.includes('rh-key'), `${name} must not see the media key`);
    assert.equal(envs[name].AWWO_STOP_ON_STDIN_CLOSE, undefined, `${name} stops on its own signals`);
  }
  assert.equal(envs.api.AWWO_RUNNINGHUB_API_KEY, 'rh-key');
});

test('the managed execution uses the built image, labels its containers with this instance, and is wired only once up', () => {
  const envs = serviceEnvironments({ profile: profileFor(), ports: testPorts, state: testState, capabilities: allCapabilities, system: {} });
  assert.equal(envs.broker.AWWO_OPENMAUS_WORKSPACE_IMAGE, 'awwo-workspace:local-abc');
  assert.equal(envs.broker.AWWO_OPENMAUS_MODEL_PROXY_ORIGINS, 'http://127.0.0.1:18087');
  assert.equal(envs.broker.AWWO_OPENMAUS_DATA_DIR, testState.broker);
  assert.equal(envs.broker.AWWO_WORKSPACE_INSTANCE, 'local-0123456789ab');
  assert.equal(envs.render.AWWO_RENDER_LISTEN, '127.0.0.1:18111');
  assert.equal(apiEnvironment(envs, new Set()).AWWO_OPENMAUS_URL, undefined);
  const some = apiEnvironment(envs, new Set(['render']));
  assert.equal(some.AWWO_RENDER_URL, 'http://127.0.0.1:18111');
  assert.equal(some.AWWO_OPENMAUS_URL, undefined, 'a broker that did not come up is not named');
  const all = apiEnvironment(envs, new Set(['broker', 'render']));
  assert.equal(all.AWWO_COMPUTER_MODEL_PROXY_URL, 'http://127.0.0.1:18087/api/internal/computer-model/v1');
  const noCore = serviceEnvironments({ profile: profileFor(), ports: testPorts, state: testState, capabilities: { ...allCapabilities, brokerCore: false }, system: {} });
  assert.equal(noCore.broker, null);
});

test('only this instance\'s workspace containers are removed, through the workers\' docker environment', () => {
  const calls = [];
  const run = (command, args, options) => {
    calls.push(args);
    assert.deepEqual(options.env, dockerEnvironment({ HOME: '/home/o' }));
    return args[0] === 'ps' ? { status: 0, stdout: '0123456789ab\n89abcdef0123\nnot-an-id\n' } : { status: 0, stdout: '' };
  };
  assert.equal(removeInstanceContainers('/usr/bin/docker', 'local-1', { run, env: { HOME: '/home/o', DOCKER_HOST: 'tcp://x' } }), 2);
  assert.deepEqual(calls[0], instanceContainerQuery('local-1'));
  assert.deepEqual(calls[0], ['ps', '--all', '--quiet', '--filter', 'label=awwo.workspace-instance=local-1']);
  assert.deepEqual(calls[1], ['rm', '--force', '0123456789ab', '89abcdef0123']);
  calls.length = 0;
  assert.equal(removeInstanceContainers('/usr/bin/docker', 'local-1', { run: (command, args) => { calls.push(args); return { status: 0, stdout: '' }; }, env: {} }), 0);
  assert.equal(calls.length, 1, 'nothing to remove, no rm');
  assert.throws(() => removeInstanceContainers('/usr/bin/docker', 'local-1', { run: () => ({ status: 1, stdout: '', stderr: 'permission denied while trying to connect to the Docker daemon socket' }), env: {} }),
    /Cannot check this instance's workspace containers \(docker ps: permission denied/, 'a Docker that will not list them may run them still: never taken for none');
  const stuck = (command, args) => args[0] === 'ps' ? { status: 0, stdout: '0123456789ab\n' } : { status: 1, stdout: '', stderr: 'Error response from daemon: removal in progress' };
  assert.throws(() => removeInstanceContainers('/usr/bin/docker', 'local-1', { run: stuck, env: {} }), /Could not remove 1 workspace container of this instance \(0123456789ab\): Error response from daemon/);
});

test('PostgreSQL listens on 127.0.0.1 only, without a Unix socket, from an included file', () => {
  const text = postgresSettings(15483);
  assert.match(text, /^listen_addresses = '127\.0\.0\.1'$/m);
  assert.match(text, /^port = 15483$/m);
  assert.match(text, /^unix_socket_directories = ''$/m);
  assert.equal(POSTGRES_INCLUDE, "include_if_exists = 'awwo-local.conf'");
});

test('the include line is added once, also to a postgresql.conf a cut first start left without it', () => {
  const fresh = '# made by initdb\nport = 5432\n';
  const added = withPostgresInclude(fresh);
  assert.ok(added.startsWith(fresh.trimEnd()), 'the rest is kept as it was');
  assert.match(added, /^include_if_exists = 'awwo-local\.conf'$/m);
  assert.equal(withPostgresInclude(added), null, 'there already');
  assert.equal(withPostgresInclude(added.replaceAll('\n', '\r\n')), null, 'with Windows line ends too');
  assert.notEqual(withPostgresInclude(`#${POSTGRES_INCLUDE}\n`), null, 'a commented-out line does not count');
});

test('a running server\'s port is read from its postmaster.pid', () => {
  assert.equal(postgresPort('4242\r\nE:/state/postgres\r\n1792512345\r\n15484\r\n\r\n127.0.0.1\r\n'), 15484);
  assert.equal(postgresPort('4242\nE:/state/postgres\n1792512345\n'), 0);
  assert.equal(postgresPort('4242\n/d\n1\nnot-a-port\n'), 0);
});

test('PostgreSQL is given a path that is not ASCII in its short form, a file under its folder\'s', () => {
  const asked = [];
  const shortPath = folder => { asked.push(folder); return { 'C:\\Users\\한글\\AwwO Local\\pgsql\\bin': 'C:\\Users\\D55C~1\\AWWOLO~1\\pgsql\\bin', 'C:\\Users\\한글\\state': 'C:\\Users\\D55C~1\\state' }[folder] || null; };
  const isFolder = file => !/\.(exe|log)$|postgres$/.test(file);
  const given = file => postgresPath(file, { platform: 'win32', shortPath, isFolder });
  assert.equal(given('C:\\Users\\Ann\\AwwO Local\\pgsql\\bin'), 'C:\\Users\\Ann\\AwwO Local\\pgsql\\bin', 'ASCII as it is');
  assert.equal(postgresPath('/home/한글/pgsql/bin', { platform: 'linux', shortPath, isFolder }), '/home/한글/pgsql/bin', 'elsewhere as it is');
  assert.deepEqual(asked, [], 'without asking cmd');
  assert.equal(given('C:\\Users\\한글\\AwwO Local\\pgsql\\bin'), 'C:\\Users\\D55C~1\\AWWOLO~1\\pgsql\\bin');
  // The database's folder before initdb has made it, and a log not yet written, go under their folder's short form.
  assert.equal(given('C:\\Users\\한글\\state\\postgres'), 'C:\\Users\\D55C~1\\state\\postgres');
  assert.equal(given('C:\\Users\\한글\\state\\logs\\postgres.log'), 'C:\\Users\\한글\\state\\logs\\postgres.log', 'no short form: as it is');
  assert.equal(given('C:\\Users\\测试\\nowhere'), 'C:\\Users\\测试\\nowhere');
});

test('a path PostgreSQL\'s shell would read (cmd\'s % and !, sh\'s $ ` " \\) is named; others are not', () => {
  assert.equal(postgresShellUnsafe('C:\\Users\\Ann\\AppData\\Local\\%TEMP%\\AwwO Local\\payload\\build\\pgsql\\bin', 'win32'), '%');
  assert.equal(postgresShellUnsafe('C:\\Users\\Ann\\A!B!%P~1\\state\\postgres', 'win32'), '! %');
  assert.equal(postgresShellUnsafe('C:\\Users\\测试安~1\\AwwO Local (1) & co ^ 2\\bin', 'win32'), '', 'cmd takes these as they are inside quotes');
  assert.equal(postgresShellUnsafe('/Users/ann/$HOME/`x`/"q"/a\\b', 'darwin'), '$ ` " \\');
  assert.equal(postgresShellUnsafe('/Users/ann/100%!/AwwO', 'linux'), '');
});

test('a PostgreSQL that did not start from paths that are not ASCII, on Windows, tells the person what to do', () => {
  const note = postgresPathNote(['C:\\Users\\D55C~1\\bin', 'C:\\Users\\한글\\state\\postgres'], ['C:\\Users\\한글\\AwwO Local\\bin', 'C:\\Users\\한글\\state\\postgres'], 'win32');
  assert.match(note, /^\nIts folders' paths have characters other than English letters and digits \(C:\\Users\\한글\\AwwO Local\\bin, C:\\Users\\한글\\state\\postgres\)/);
  assert.match(note, /English letters, digits and spaces only\.$/);
  assert.equal(postgresPathNote(['C:\\Users\\Ann\\bin', 'C:\\Users\\Ann\\state\\postgres'], ['a', 'b'], 'win32'), '', 'ASCII: no note');
  assert.equal(postgresPathNote(['/home/한글/bin'], ['/home/한글/bin'], 'linux'), '', 'elsewhere: no note');
});

test('a folder\'s short path is cmd\'s, in UTF-16, only when it leads back to the folder', () => {
  const calls = [];
  const answer = (stdout, status = 0) => (command, args, options) => { calls.push({ command, args, options }); return { status, stdout: Buffer.from(stdout, 'utf16le') }; };
  const real = file => ({ 'C:\\Users\\D55C~1\\AWWOLO~1': 'C:\\Users\\한글\\AwwO Local', 'C:\\Users\\한글\\AwwO Local': 'C:\\Users\\한글\\AwwO Local', 'C:\\Windows': 'C:\\Windows' }[file] ?? (() => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); })());
  const env = { SystemRoot: 'C:\\Windows' };
  assert.equal(windowsShortPath('C:\\Users\\한글\\AwwO Local', { run: answer('C:\\Users\\D55C~1\\AWWOLO~1\r\n'), env, real }), 'C:\\Users\\D55C~1\\AWWOLO~1');
  assert.equal(calls[0].command, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(calls[0].args, ['/d', '/e:on', '/v:off', '/u', '/s', '/c', '"for %I in (.) do @echo %~sI"']);
  assert.equal(calls[0].options.cwd, 'C:\\Users\\한글\\AwwO Local');
  assert.equal(calls[0].options.windowsVerbatimArguments, true);
  // cmd starts in C:\Windows when it cannot start in a UNC folder: what does not lead back is no short path of it.
  assert.equal(windowsShortPath('C:\\Users\\한글\\AwwO Local', { run: answer('C:\\Windows\r\n'), env, real }), null);
  assert.equal(windowsShortPath('C:\\Users\\한글\\AwwO Local', { run: answer('', 1), env, real }), null);
  assert.equal(windowsShortPath('C:\\Users\\한글\\AwwO Local', { run: answer('nothing\r\n'), env, real }), null);
  assert.equal(windowsShortPath('C:\\Users\\한글\\AwwO Local', { run: answer('C:\\gone\r\n'), env, real }), null);
});

test('on Windows, a folder named in characters the code page has not gets a short path that leads back to it', { skip: process.platform !== 'win32' && 'Windows only' }, () => {
  // With what cmd would expand or take as an operator on a command line: the folder reaches it as its working folder.
  const folder = path.join(scratch(), '한글 😀 a!b!%PATH%&c^d');
  mkdirSync(folder);
  const short = windowsShortPath(folder);
  // The volume may keep no short names (cmd then gives the folder's own path), never another folder.
  if (short !== null) assert.equal(realpathSync.native(short).toLowerCase(), realpathSync.native(folder).toLowerCase());
  const given = postgresPath(folder);
  assert.equal(realpathSync.native(given).toLowerCase(), realpathSync.native(folder).toLowerCase(), given);
  if (given !== folder && /^[\x00-\x7f]*$/.test(path.dirname(folder))) assert.match(given, /^[\x00-\x7f]*$/, 'a short name of what the code page has not is ASCII');
});

test('PostgreSQL is found only where all five of its programs are', () => {
  const layout = localLayout({ resources: '/r', build: '/r/build', platform: 'linux' });
  const complete = new Set(['initdb', 'pg_ctl', 'postgres', 'psql', 'createdb'].map(name => path.join('/opt/pg/bin', name)));
  assert.equal(resolvePostgresBin(layout, { env: { AWWO_LOCAL_PG_BIN: '/opt/pg/bin' }, platform: 'linux', exists: file => complete.has(file) }), '/opt/pg/bin');
  const partial = new Set(['initdb', 'pg_ctl', 'postgres'].map(name => path.join('/opt/pg/bin', name)));
  assert.equal(resolvePostgresBin(layout, { env: { AWWO_LOCAL_PG_BIN: '/opt/pg/bin' }, platform: 'linux', exists: file => partial.has(file) }), '');
});

test('findOnPath follows PATHEXT on Windows and PATH elsewhere', () => {
  const files = new Set([path.join('C:\\tools', 'ffmpeg.exe'), path.join('/usr/bin', 'ffmpeg')]);
  const exists = file => files.has(file);
  assert.equal(findOnPath('ffmpeg', { env: { Path: 'C:\\nothing;C:\\tools', PATHEXT: '.COM;.EXE' }, platform: 'win32', exists }), path.join('C:\\tools', 'ffmpeg.exe'));
  assert.equal(findOnPath('ffmpeg', { env: { PATH: '/bin:/usr/bin' }, platform: 'linux', exists }), path.join('/usr/bin', 'ffmpeg'));
  assert.equal(findOnPath('missing', { env: { PATH: '/bin' }, platform: 'linux', exists }), '');
});

test('the staged showcase manifest lists every staged video the web names, each named after its SHA-256', () => {
  const files = stagedShowcaseFiles();
  assert.ok(files.length >= 29, `found ${files.length}`);
  assert.equal(new Set(files.map(file => file.src)).size, files.length);
  for (const file of files) {
    assert.equal(file.name, `${file.sha256.slice(0, 16)}.mp4`);
    assert.ok(file.bytes > 0);
  }
  assert.ok(files.some(file => file.caseName === 'academy'));
  assert.ok(files.some(file => file.caseName === 'the-long-chord'));
  const source = path.join(here, '..', 'apps', 'web', 'src');
  const web = readFileSync(path.join(source, 'saas', 'academyCatalog.ts'), 'utf8');
  for (const match of web.matchAll(/'(\/showcase\/staged\/[^']+)'/g)) assert.ok(files.some(file => file.src === match[1]), match[1]);
});

test('a staged video named against its hash is refused', () => {
  const root = scratch();
  mkdirSync(path.join(root, 'saas', 'production-runs'), { recursive: true });
  writeFileSync(path.join(root, 'saas', 'academyCatalog.ts'), "{ src: '/showcase/staged/academy/0000000000000000.mp4', bytes: 10, sha256: '1111111111111111111111111111111111111111111111111111111111111111' }");
  assert.throws(() => stagedShowcaseFiles(root), /named inconsistently/);
});

test('the workspace image tag follows its source', () => {
  const root = scratch();
  writeFileSync(path.join(root, 'Dockerfile'), 'FROM scratch\n');
  const first = workspaceSourceHash(root);
  assert.equal(workspaceSourceHash(root), first);
  writeFileSync(path.join(root, 'Dockerfile'), 'FROM scratch\nRUN true\n');
  assert.notEqual(workspaceSourceHash(root), first);
  assert.match(workspaceImageTag(first), /^awwo-workspace:local-[0-9a-f]{12}$/);
});

test('the pinned downloads name their exact files and SHA-256 values; workers install as their hosted images do', () => {
  for (const release of Object.values(NODE_RELEASE.files)) {
    assert.match(release.name, new RegExp(`^node-v${NODE_RELEASE.version.replaceAll('.', '\\.')}-`));
    assert.match(release.sha256, /^[0-9a-f]{64}$/);
  }
  assert.match(POSTGRES_WINDOWS.sha256, /^[0-9a-f]{64}$/);
  assert.ok(POSTGRES_WINDOWS.url.endsWith(POSTGRES_WINDOWS.name));
  for (const worker of ['pi-worker', 'openai-agents-worker', 'render-worker']) assert.deepEqual(INSTALL_FLAGS[worker], ['--omit=dev', '--ignore-scripts']);
  assert.deepEqual(INSTALL_FLAGS.web, [], 'the web build needs its build tools');
});

test('arguments: flags, and the Mac shell\'s positional contract', () => {
  assert.deepEqual(parseArguments(['--state', 'x', '--events', '--parent-pid', '42', '--no-docker']), {
    state: path.resolve('x'), resources: '', build: '', events: true, parentPid: 42, docker: false, stopOnStdinClose: false, verbose: false, resetPassword: false,
  });
  assert.equal(parseArguments(['--reset-password']).resetPassword, true);
  const mac = parseArguments(['/app/Resources', '/state', '77']);
  assert.equal(mac.resources, path.resolve('/app/Resources'));
  assert.equal(mac.state, path.resolve('/state'));
  assert.equal(mac.parentPid, 77);
  assert.equal(mac.events, true);
  assert.throws(() => parseArguments(['--parent-pid', 'zero']), /process id/);
  assert.throws(() => parseArguments(['--state']), /needs a value/);
  assert.throws(() => parseArguments(['--bogus']), /Unknown option/);
  assert.throws(() => parseArguments(['/a', '/b']), /usage/);
});

test('arguments: a Windows folder written with the verbatim prefix is taken without it, as PostgreSQL needs', { skip: process.platform !== 'win32' && 'Windows paths' }, () => {
  // Tauri canonicalizes the window's own path: its resource folder comes as \\?\C:\Users\…\AwwO Local.
  const parsed = parseArguments(['--resources', '\\\\?\\C:\\Users\\a b\\AwwO Local\\payload\\app', '--build', '\\\\?\\D:\\x\\build', '--state', 'C:\\data\\state']);
  assert.equal(parsed.resources, 'C:\\Users\\a b\\AwwO Local\\payload\\app');
  assert.equal(parsed.build, 'D:\\x\\build');
  assert.equal(parsed.state, 'C:\\data\\state');
  // A verbatim UNC path (\\?\UNC\server\share) is not a drive path and is left as given.
  assert.equal(parseArguments(['--state', '\\\\?\\UNC\\server\\share\\state']).state, '\\\\?\\UNC\\server\\share\\state');
  assert.equal(parseArguments(['\\\\?\\C:\\app', '\\\\?\\C:\\state', '9']).resources, 'C:\\app');
});

test('the operating system\'s lock: one exclusive holder, or any number of shared ones, never both', async () => {
  const file = path.join(scratch(), 'test.lock');
  const once = { attempts: 1 };
  const exclusive = await osLock(file, once);
  assert.ok(exclusive);
  assert.equal(await osLock(file, once), null, 'a second exclusive holder');
  assert.equal(await osLock(file, { ...once, exclusive: false }), null, 'a shared holder beside an exclusive one');
  await exclusive.release();
  const shared = [await osLock(file, { ...once, exclusive: false }), await osLock(file, { ...once, exclusive: false })];
  assert.ok(shared.every(Boolean), 'shared holders together');
  assert.equal(await osLock(file, once), null, 'an exclusive holder beside shared ones');
  await shared[0].release();
  assert.equal(await osLock(file, once), null, 'beside the one shared holder left');
  await shared[1].release();
  const again = await osLock(file, once);
  assert.ok(again, 'free again once all have let go');
  await again.release();
  await assert.rejects(osLock(file, { platform: 'sunos' }), /no lock it can rely on on sunos/, 'never a lock that locks nothing');
});

// A process that takes the lock on `file` and holds it until it is killed.
const lockHolder = (file, exclusive) => new Promise((resolve, reject) => {
  const source = `import { osLock } from ${JSON.stringify(pathToFileURL(path.join(here, 'awwo-local-lib.mjs')).href)}; const lock = await osLock(${JSON.stringify(file)}, { exclusive: ${exclusive}, attempts: 1 }); console.log(lock ? 'held' : 'refused'); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'inherit'] });
  child.stdout.once('data', chunk => resolve({ child, said: String(chunk).trim() }));
  child.once('error', reject);
});
const killed = child => new Promise(resolve => { child.once('exit', resolve); child.kill('SIGKILL'); });

test('a lock goes with its process however it ends: there is never a stale one to take over', async () => {
  const file = path.join(scratch(), 'runtime.lock');
  const holder = await lockHolder(file, true);
  assert.equal(holder.said, 'held');
  await assert.rejects(acquireLock(file, { lock: (target, options) => osLock(target, { ...options, attempts: 1 }) }), /already running for this data folder/);
  await killed(holder.child);
  const release = await acquireLock(file);
  const next = await lockHolder(file, true);
  assert.equal(next.said, 'refused', 'held again, by the runtime that took it');
  await killed(next.child);
  await release();
});

test('setup holds the code and the build exclusively, and a runtime of either holds them shared', async () => {
  const tree = checkoutTree();
  const layout = localLayout({ resources: tree.root, build: tree.build });
  mkdirSync(path.dirname(layout.codeLock), { recursive: true });
  const quick = (target, options) => osLock(target, { ...options, attempts: 1 });
  // A runtime of this code with another build, and one of another code with this build.
  for (const file of [layout.codeLock, layout.buildLock]) {
    const runtime = await lockHolder(file, false);
    assert.equal(runtime.said, 'held');
    await assert.rejects(holdBuildExclusively(layout, { lock: quick }), /running from this code or build, or another setup is/, path.basename(file));
    await killed(runtime.child);
  }
  const release = await holdBuildExclusively(layout, { lock: quick });
  await assert.rejects(holdBuild(layout, { lock: quick }), /setup:local is updating AwwO 本地版/, 'no runtime starts while setup works');
  await assert.rejects(holdBuildExclusively(layout, { lock: quick }), /another setup/, 'nor a second setup');
  await release();
  const runtimes = [await holdBuild(layout, { lock: quick }), await holdBuild(layout, { lock: quick })];
  await assert.rejects(holdBuildExclusively(layout, { lock: quick }), /running from this code or build/);
  for (const done of runtimes) await done();
  // A lock this account cannot take is an error, never a start without it.
  const refused = async () => { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); };
  await assert.rejects(holdBuild(layout, { lock: refused }), /permission denied/);
  // A packaged app, whose code and build no setup serves, takes no lock and writes none into its bundle.
  const app = scratch();
  const packaged = localLayout({ resources: app, build: path.join(app, 'build') });
  mkdirSync(packaged.build);
  const asked = [];
  await (await holdBuild(packaged, { lock: async target => { asked.push(target); return null; } }))();
  assert.deepEqual(asked, []);
  assert.ok(!existsSync(path.join(app, '.local')), 'nothing is made in its resources');
  // With a checkout's build it holds that build's lock, so the checkout's setup does not replace it under it.
  const borrowed = localLayout({ resources: app, build: tree.build });
  const runtime = await holdBuild(borrowed, { lock: quick });
  await assert.rejects(holdBuildExclusively(layout, { lock: quick }), /running from this code or build/);
  await runtime();
  await assert.rejects(holdBuildExclusively(packaged), /runs from a checkout of AwwO, on its own build/, 'setup serves no packaged app');
});

function waitFor(check, timeout = 15_000) {
  return new Promise((resolve, reject) => {
    const until = Date.now() + timeout;
    const tick = () => {
      if (check()) return resolve();
      if (Date.now() > until) return reject(new Error('timed out'));
      setTimeout(tick, 100);
    };
    tick();
  });
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
const wrap = (args, service) => spawn(process.execPath, [reaper, ...args, process.execPath, '-e', service], { stdio: ['pipe', 'ignore', 'ignore'] });
const exitOf = child => new Promise(resolve => child.once('exit', (code, signal) => resolve(code ?? signal)));

test('the wrapper ends its service, and what that service started, when the runtime asks', async () => {
  const dir = scratch();
  const pidFile = path.join(dir, 'grandchild.pid');
  // The service starts a process of its own, as the managed execution starts docker.
  const wrapper = wrap(['1000'], `const { spawn } = require('node:child_process'); const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); setInterval(() => {}, 1000);`);
  await waitFor(() => existsSync(pidFile));
  const grandchild = Number(readFileSync(pidFile, 'utf8'));
  assert.ok(alive(grandchild));
  const exited = exitOf(wrapper);
  wrapper.stdin.end('stop\n');
  await exited;
  await waitFor(() => !alive(grandchild));
});

test('the wrapper exits with its service\'s own code', async () => {
  assert.equal(await exitOf(wrap(['1000'], 'process.exit(7)')), 7);
});

// A service that stops in order when its stdin closes, as the API does with AWWO_STOP_ON_STDIN_CLOSE, after 300 ms.
const orderly = (ready, stopped) => `const fs = require('node:fs'); process.stdin.on('end', () => setTimeout(() => { fs.writeFileSync(${JSON.stringify(stopped)}, 'in order'); process.exit(0); }, 300)); process.stdin.resume(); fs.writeFileSync(${JSON.stringify(ready)}, '1');`;

test('with --stdin-stop the wrapper asks its service to stop by closing the service\'s stdin, and waits for it', async () => {
  const dir = scratch();
  const [ready, stopped] = [path.join(dir, 'ready'), path.join(dir, 'stopped')];
  const wrapper = wrap(['--stdin-stop', '10000'], orderly(ready, stopped));
  await waitFor(() => existsSync(ready));
  const exited = exitOf(wrapper);
  wrapper.stdin.end('stop\n');
  assert.equal(await exited, 0);
  assert.equal(readFileSync(stopped, 'utf8'), 'in order');
});

test('a pipe that closes without a stop means the runtime has gone: the service is ended at once', async () => {
  const dir = scratch();
  const [ready, stopped] = [path.join(dir, 'ready'), path.join(dir, 'stopped')];
  const wrapper = wrap(['--stdin-stop', '10000'], orderly(ready, stopped));
  await waitFor(() => existsSync(ready));
  const exited = exitOf(wrapper);
  wrapper.stdin.end();
  assert.notEqual(await exited, 0);
  await sleep(500);
  assert.ok(!existsSync(stopped), 'not left to work on after its runtime');
});

test('a service that does not stop when asked is ended once its grace period is over', async () => {
  const dir = scratch();
  const ready = path.join(dir, 'ready');
  const wrapper = wrap(['--stdin-stop', '500'], `process.stdin.resume(); require('node:fs').writeFileSync(${JSON.stringify(ready)}, '1'); setInterval(() => {}, 1000);`);
  await waitFor(() => existsSync(ready));
  const began = Date.now();
  const exited = exitOf(wrapper);
  wrapper.stdin.end('stop\n');
  assert.notEqual(await exited, 0);
  assert.ok(Date.now() - began < 8000, `ended after ${Date.now() - began} ms`);
});

test('on Windows, what a service started and left running when it exited is ended too, and nothing else', { skip: process.platform !== 'win32' && 'Windows only: elsewhere the process group is ended' }, async () => {
  const dir = scratch();
  const pidFile = path.join(dir, 'orphan.pid');
  // Detached, so that Node.js's own job object does not end it with its parent: as a program other than Node.js leaves it.
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true });
  try {
    const wrapper = wrap(['1000'], `const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true }); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); setTimeout(() => process.exit(3), 2000);`);
    const exited = exitOf(wrapper);
    await waitFor(() => existsSync(pidFile));
    const orphan = Number(readFileSync(pidFile, 'utf8'));
    assert.ok(Number.isSafeInteger(orphan) && alive(orphan), 'the service\'s own process runs');
    assert.equal(await exited, 3);
    await waitFor(() => !alive(orphan), 5000);
    assert.ok(alive(unrelated.pid), 'a process the service did not start is left alone');
  } finally {
    unrelated.kill();
  }
});

test('a terminal\'s Ctrl-C is left to the runtime\'s stop, and SIGTERM ends the service at once', { skip: process.platform === 'win32' && 'POSIX signals' }, async () => {
  const dir = scratch();
  const ready = path.join(dir, 'ready');
  // The service would outlast a polite stop: it ignores SIGTERM, and its grace period is a minute.
  const wrapper = wrap(['60000'], `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(ready)}, '1'); setInterval(() => {}, 1000);`);
  await waitFor(() => existsSync(ready));
  const exited = exitOf(wrapper);
  wrapper.kill('SIGINT');
  await sleep(500);
  assert.equal(wrapper.exitCode, null, 'SIGINT stopped nothing: the runtime, which has it too, stops the services in order');
  const began = Date.now();
  wrapper.kill('SIGTERM');
  await exited;
  assert.ok(Date.now() - began < 5000, 'not after the grace period');
});

// The contract with the API itself: the settings this runtime gives it must pass the API's own checks
// (backend/internal/app/config.go ConfigFromEnv), in each shape a computer can bring. The built binary runs with a
// database address nothing listens on: past its settings it stops at "cannot connect", which is the pass.
const builtApi = localLayout().api;
test('the API accepts the settings of every optional-service and media-key combination', { skip: !existsSync(builtApi) && 'the API is not built (npm run setup:local)' }, async () => {
  const closed = await new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); }); });
  const media = scratch();
  const cases = {
    'no renderer, no media key': { providers: {}, up: [] },
    'the renderer up': { providers: {}, up: ['render'] },
    'the managed execution up': { providers: {}, up: ['broker'] },
    'a RunningHub key': { providers: { AWWO_RUNNINGHUB_API_KEY: 'r'.repeat(32) }, up: [] },
    'a Tripo key': { providers: { AWWO_TRIPO_API_KEY: 't'.repeat(32) }, up: [] },
    'an X-tasy key': { providers: { AWWO_XTASY_API_KEY: 'x'.repeat(32) }, up: [] },
    'every key and service': { providers: { AWWO_RUNNINGHUB_API_KEY: 'r'.repeat(32), AWWO_TRIPO_API_KEY: 't'.repeat(32), AWWO_XTASY_API_KEY: 'x'.repeat(32), AWWO_MEDIA_DEV_PROXY: 'http://127.0.0.1:7897', AWWO_WEB_READER_PROXY: 'http://127.0.0.1:7897' }, up: ['render', 'broker'] },
    'a password reset': { providers: {}, up: [], resetPassword: 'W1tbW1tbW1tbW1tbW1tbW1tbW1tb' },
  };
  const state = { ...localState(scratch()), media };
  for (const [name, { providers, up, resetPassword = '' }] of Object.entries(cases)) {
    const envs = serviceEnvironments({ profile: { ...profileFor(providers), AWWO_LOCAL_DB_PASSWORD: 'pw', AWWO_LOCAL_HOSTNAME: 'awwo-0123456789ab.localhost' }, ports: { ...testPorts, database: closed }, state, capabilities: allCapabilities, system: systemEnvironment(), resetPassword });
    const child = spawn(builtApi, [], { env: apiEnvironment(envs, new Set(up)), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const code = await new Promise(resolve => child.once('exit', resolve));
    assert.equal(code, 1, name);
    assert.match(output, /cannot connect to AWWO_DATABASE_URL/, `${name}: the API refused its settings: ${output.slice(-400)}`);
  }
});
