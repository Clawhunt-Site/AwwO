// Packages AwwO 本地版 for Windows: the runtime, its services and their own Node.js, PostgreSQL and API, as the
// installer of apps/windows-local carries them (docs/awwo-local-edition.md).
//
//   npm run setup:local                  first: builds and installs what is packaged
//   npm run package:local                assembles the payload in apps/windows-local/payload and builds the NSIS installer
//   npm run package:local -- --smoke     also starts the payload's runtime on a scratch data folder and stops it
//   npm run package:local -- --out D:\awwo-local   builds in a folder of its own: a copy of the shell, the payload in
//                                        its payload folder, the installer under its target folder (for a checkout
//                                        too deep for makensis, or a faster disk)
//   npm run package:local -- --no-installer        only the payload
//   npm run package:local -- --keep-payload        the installer from the payload an earlier run assembled there
//   npm run package:local -- --test-build          one to test, not to publish: it may carry the VC++ runtime of
//                                        System32 where no Visual Studio here has one new enough (chooseVcRuntime)
//
// The payload holds what the hosted images run (deploy/saas/*.Dockerfile), laid out as in a checkout so the runtime's
// layout (localLayout) finds it: app/ the code, build/ the programs. Its workers' packages are installed as their
// images install them (npm ci --omit=dev --ignore-scripts, from npm's cache). It holds no secret and no data folder; a
// data folder of the installing account's own is made at the first start (%LOCALAPPDATA%\store.clawhunt.awwo.local\state).
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { localLayout, repoRoot } from './awwo-local-lib.mjs';
import { holdBuild } from './awwo-local.mjs';
import { POSTGRES_LICENCES } from './awwo-local-setup.mjs';
import { linkedCrates, shellMetadata, shippedLicences } from './awwo-crate-licences.mjs';
import { provenanceDifferences, sha256 } from './awwo-licence-files.mjs';
import { folderOf, forThisMachine, installedPackages, LEFT_OUT_PACKAGES, leftOutPackage, permissiveLicence, WINDOWS_X64 } from './awwo-npm-licences.mjs';
import { POSTGRES_LIBRARIES, postgresLibraryGaps, postgresVersionOf } from './awwo-postgres-licences.mjs';

const SHELL = path.join(repoRoot, 'apps', 'windows-local');
/** What of the shell the installer is built from; a build folder of its own holds a copy (prepareBuild). */
export const SHELL_FILES = Object.freeze(['Cargo.toml', 'Cargo.lock', 'build.rs', 'tauri.conf.json', 'installer-hooks.nsh', 'src', 'assets']);
const BUILD_MARKER = 'awwo-local-build.json';
/** makensis opens each file it packs by its full path, and fails past Windows' MAX_PATH (260 with its NUL). */
export const MAX_SOURCE_PATH = 259;
/** The runtime's own files, relative to the checkout: scripts/awwo-local.mjs, what it imports and the wrapper it starts
 *  each service in. missingImports checks the assembled payload holds everything they import. */
export const RUNTIME_FILES = Object.freeze([
  'scripts/awwo-local.mjs', 'scripts/awwo-local-lib.mjs', 'scripts/awwo-local-reaper.mjs', 'scripts/awwo-local-web.mjs', 'scripts/awwo-saas-lib.mjs',
  'scripts/awwo-local-module-guard.cjs',
  'apps/web/scripts/staged-showcase.mjs',
]);
/** What the workers import beside their folders, in apps/ (the package test reads their imports to keep this whole). */
export const SHARED_WORKER_FILES = Object.freeze([
  'user-models.ts', 'computer-model.ts', 'bedrock-bridge.ts', 'bedrock-catalog.ts', 'bedrock-models.json', 'context-estimate.ts',
  'context-overflow.ts',
]);
/** A path longer than this under the payload would pass Windows' 260 characters below a long user profile folder
 *  (C:\Users\<name>\AppData\Local\AwwO Local\payload\ is about 60 to 80). */
export const MAX_RELATIVE_PATH = 170;

/** A worker's own files, without its tests and its dotfiles (a .env holds a developer's keys; .runtime is the managed
 *  execution's build, of which the payload takes dist-server alone); node_modules only where its image installs them. */
export const workerFilter = (source, { modules }) => item => {
  const relative = path.relative(source, item);
  if (!relative) return true;
  const parts = relative.split(path.sep);
  if (parts[0] === 'node_modules') return modules;
  if (parts.some(part => part.startsWith('.'))) return false;
  return !/\.test\.[cm]?[jt]s$/.test(parts.at(-1));
};

/** A name of private configuration: dotenv files, npm credentials, keys and certificates. */
export const privateName = name => /^\.env(\..*)?$|^\.npmrc$|\.(pem|key|p12|pfx)$|^id_(rsa|dsa|ecdsa|ed25519)/i.test(name);

/** The payload's files with a private name, outside the packages npm installed in it (those are as published). */
export function privateFiles(out) {
  const found = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') walk(full);
      } else if (privateName(entry.name)) {
        found.push(path.relative(out, full));
      }
    }
  };
  walk(out);
  return found;
}

/** Node.js without npm and corepack: nothing of the runtime runs them. */
export const nodeFilter = source => item => {
  const parts = path.relative(source, item).split(path.sep);
  if (parts[0] === 'node_modules' && (parts[1] === 'npm' || parts[1] === 'corepack')) return false;
  return !(parts.length === 1 && /^(npm|npx|corepack)(\.cmd|\.ps1)?$/i.test(parts[0]));
};

export function copy(from, to, filter) {
  if (!existsSync(from)) throw new Error(`Missing ${from}: run npm run setup:local first`);
  cpSync(from, to, { recursive: true, filter, errorOnExist: true, force: false });
}

/** The manifest a payload carries (written first, as {"assembling":true}); a folder without it is not one to replace. */
const MANIFEST = 'awwo-local-payload.json';
/** The form of a complete payload's manifest, raised when what a payload must carry changes (3: the licences of npm,
 *  PostgreSQL and the module guard, and testBuild). */
export const MANIFEST_FORMAT = 3;

/** Why an earlier payload's manifest cannot be built into an installer as it is, or null. Only a payload assembled from
 *  this very commit, with no change in the checkout then or now, is kept: anything else may carry less than this
 *  packager would (the checks are made as it is assembled). */
export function keptPayloadProblem(manifest, { version, testBuild, source }) {
  if (!manifest.revision || manifest.assembling) return 'it is not complete';
  if (manifest.format !== MANIFEST_FORMAT || typeof manifest.testBuild !== 'boolean') return 'an earlier packager assembled it, without what a payload now carries';
  if (manifest.version !== version) return `it was made for ${manifest.version}, not ${version}`;
  if (manifest.revision !== source.head || manifest.dirty || source.dirty) return `it was made from ${manifest.revision}${manifest.dirty ? ' with changes' : ''}, not this checkout as it is (${source.head}${source.dirty ? ' with changes' : ''})`;
  if (manifest.testBuild && !testBuild) return 'it was assembled as a build to test (keep it with --test-build)';
  return null;
}
export function replaceableOut(out) {
  if (!existsSync(out)) return true;
  const entries = readdirSync(out);
  return entries.length === 0 || entries.includes(MANIFEST);
}

/** Readies a build folder and returns its payload folder. The shell builds in place; a folder of its own (empty, or one
 *  an earlier run made) gets a copy of the shell's sources and of the icons its config names beside it. */
export function prepareBuild(build, shell = SHELL) {
  const payload = path.join(build, 'payload');
  const reach = payload.length + 1 + MAX_RELATIVE_PATH;
  if (reach > MAX_SOURCE_PATH) {
    throw new Error(`${build} is too deep for makensis (the payload's paths would reach ${reach} characters, past ${MAX_SOURCE_PATH}): build in a shorter folder, as --out D:\\awwo-local`);
  }
  if (path.resolve(build) === path.resolve(shell)) return payload;
  if (existsSync(build) && readdirSync(build).length > 0 && !existsSync(path.join(build, BUILD_MARKER))) {
    throw new Error(`Refusing to build in ${build}: it holds something other than an AwwO Local build`);
  }
  mkdirSync(build, { recursive: true });
  writeFileSync(path.join(build, BUILD_MARKER), `${JSON.stringify({ shell })}\n`);
  for (const name of [...SHELL_FILES, 'icons']) rmSync(path.join(build, name), { recursive: true, force: true });
  for (const name of SHELL_FILES) copy(path.join(shell, name), path.join(build, name));
  const config = JSON.parse(readFileSync(path.join(shell, 'tauri.conf.json'), 'utf8'));
  config.bundle.icon = config.bundle.icon.map(icon => {
    copy(path.resolve(shell, icon), path.join(build, 'icons', path.basename(icon)));
    return `icons/${path.basename(icon)}`;
  });
  writeFileSync(path.join(build, 'tauri.conf.json'), `${JSON.stringify(config, null, 2)}\n`);
  return payload;
}

/** The workers whose packages the payload installs, as their images do (INSTALL_FLAGS in awwo-local-setup.mjs). */
export const PACKAGED_WORKERS = Object.freeze(['pi-worker', 'openai-agents-worker', 'render-worker']);

/** What Node.js never loads from a package: type declarations (and the folders of them), and source maps. Licences and
 *  notices stay. Without them the deepest paths shrink below the installer's limit (MAX_RELATIVE_PATH). */
export const unusedAtRunTime = (name, isDirectory) => isDirectory ? name === 'dist-types' : /\.d\.[cm]?ts$|\.map$/.test(name);

/** Removes what Node.js never loads from a worker's installed packages; returns how many entries went. */
export function prunePackages(dir) {
  let removed = 0;
  const walk = folder => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name);
      if (unusedAtRunTime(entry.name, entry.isDirectory())) {
        rmSync(full, { recursive: true, force: true });
        removed += 1;
      } else if (entry.isDirectory()) {
        walk(full);
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  return removed;
}

/** The conditions the payload's Node.js 24 resolves a package's exports with, for import and for require; the workers
 *  start as plain `node server.mjs`, with no others. */
export const NODE_CONDITIONS = Object.freeze([
  Object.freeze(['node', 'import', 'module-sync', 'node-addons', 'default']),
  Object.freeze(['node', 'require', 'module-sync', 'node-addons', 'default']),
]);

/** The targets Node.js resolves an exports (or imports) value to under these conditions, as its resolver does: a
 *  condition object takes the first key it has whose value resolves, an array is taken whole (Node.js takes its first
 *  valid entry), null is a match that loads nothing. undefined when nothing matches. */
export function exportTargets(value, conditions) {
  if (typeof value === 'string') return [value];
  if (value === null) return [];
  if (Array.isArray(value)) {
    const found = value.map(item => exportTargets(item, conditions)).filter(item => item !== undefined);
    return found.length ? found.flat() : undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  for (const [key, target] of Object.entries(value)) {
    if (!conditions.includes(key)) continue;
    const found = exportTargets(target, conditions);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Whether Node.js may load anything in a package's top-level folder (as "dist-es"), by what its package.json names:
 *  exports, imports, main and bin. Without exports any of its files can be loaded by path, so then it may. */
export function nodeMayLoad(manifest, folder) {
  // Without exports (null counts as none) any of its files can be loaded by path.
  if (manifest.exports === undefined || manifest.exports === null) return true;
  // A pattern's first segment (./*) may stand for the folder.
  const inside = target => {
    const first = path.posix.normalize(target.replaceAll('\\', '/')).replace(/^\.\//, '').split('/')[0];
    return first === folder || first.includes('*');
  };
  const subpaths = value => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).some(key => key.startsWith('.') || key.startsWith('#'))
    ? Object.values(value) : [value];
  const entries = [...subpaths(manifest.exports), ...(manifest.imports ? subpaths(manifest.imports) : [])];
  for (const entry of entries) {
    for (const conditions of NODE_CONDITIONS) {
      if ((exportTargets(entry, conditions) || []).some(inside)) return true;
    }
  }
  const named = [manifest.main, ...(typeof manifest.bin === 'object' && manifest.bin ? Object.values(manifest.bin) : [manifest.bin])];
  return named.some(target => typeof target === 'string' && inside(target));
}

/** Whether one of a package's own scripts outside a folder names it (it would load from it by a relative path). */
function scriptsName(root, folder) {
  const walk = dir => readdirSync(dir, { withFileTypes: true }).some(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name !== 'node_modules' && full !== path.join(root, folder) && walk(full);
    return /\.[cm]?js$/.test(entry.name) && readFileSync(full, 'utf8').includes(folder);
  });
  return walk(root);
}

/** Every file of the payload, with its path relative to the payload. */
function payloadFiles(out) {
  const files = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(path.relative(out, full));
    }
  };
  walk(out);
  return files;
}

/** Removes an ES-module build (dist-es) Node.js never loads from each package holding a path too long for the installer:
 *  its exports send Node.js to its CommonJS build, and none of its own scripts names the folder. Only those packages
 *  are touched; a long path anywhere else stays, for inspectPayload to refuse. Returns the packages' folders. */
export function pruneUnloadedBuilds(out) {
  const removed = [];
  for (const relative of payloadFiles(out)) {
    if (relative.length <= MAX_RELATIVE_PATH) continue;
    const parts = relative.split(path.sep);
    const at = parts.lastIndexOf('dist-es');
    if (at < 1) continue;
    const root = path.join(out, ...parts.slice(0, at));
    const manifestFile = path.join(root, 'package.json');
    if (removed.includes(root) || !existsSync(path.join(root, 'dist-es')) || !existsSync(manifestFile)) continue;
    if (nodeMayLoad(JSON.parse(readFileSync(manifestFile, 'utf8')), 'dist-es') || scriptsName(root, 'dist-es')) continue;
    rmSync(path.join(root, 'dist-es'), { recursive: true, force: true });
    removed.push(root);
  }
  return removed;
}

/** Loads each package a build was removed from, by its name and every exported subpath, through import and require,
 *  with the payload's Node.js from the folder its dependents find it from: proof the removed build is not needed. */
export function checkLoads(node, roots) {
  for (const root of roots) {
    const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    const keys = typeof manifest.exports === 'object' && !Array.isArray(manifest.exports) && Object.keys(manifest.exports).some(key => key.startsWith('.'))
      ? Object.keys(manifest.exports).filter(key => key !== './package.json' && !key.includes('*')) : ['.'];
    const specifiers = keys.map(key => key === '.' ? manifest.name : `${manifest.name}/${key.slice(2)}`);
    const from = path.dirname(path.resolve(root, ...manifest.name.split('/').map(() => '..')));
    const script = `import { createRequire } from 'node:module';\nconst require = createRequire(${JSON.stringify(path.join(from, 'loads.js'))});\n`
      + `for (const specifier of ${JSON.stringify(specifiers)}) { require(specifier); await import(specifier); }\n`;
    const result = spawnSync(node, ['--input-type=module', '--eval', script], { cwd: from, encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) throw new Error(`${manifest.name} does not load without its dist-es (from ${from}):\n${result.stderr.slice(-2000)}`);
  }
}

export { forThisMachine };

/** Removes the installed packages whose package.json drop() is true for (with what they hold) from a worker's
 *  packages; returns them. */
function prunePackageFolders(dir, drop) {
  const removed = [];
  const walk = modules => {
    if (!existsSync(modules)) return;
    for (const name of readdirSync(modules)) {
      const entries = name.startsWith('@') ? readdirSync(path.join(modules, name)).map(inner => path.join(name, inner)) : [name];
      for (const entry of entries) {
        const root = path.join(modules, entry);
        const manifest = path.join(root, 'package.json');
        if (!existsSync(manifest)) continue;
        if (drop(JSON.parse(readFileSync(manifest, 'utf8')))) {
          rmSync(root, { recursive: true, force: true });
          removed.push(entry.replaceAll(path.sep, '/'));
          continue;
        }
        walk(path.join(root, 'node_modules'));
      }
    }
  };
  walk(dir);
  return removed;
}

/** Removes the installed packages built for another system or machine than the payload's (forThisMachine; Windows on
 *  x64 unless named) from a worker's packages. */
export const pruneOtherPlatforms = (dir, machine = WINDOWS_X64) => prunePackageFolders(dir, manifest => !forThisMachine(manifest, machine));

/** Removes the packages the payload leaves out (LEFT_OUT_PACKAGES of awwo-npm-licences.mjs) from a worker's packages. */
export const pruneLeftOut = dir => prunePackageFolders(dir, manifest => leftOutPackage(manifest.name));

/** npm of the Node.js the payload carries, run on it: beside node.exe on Windows, in lib/ beside bin/node elsewhere. */
export function installWorkerPackages(layout, dir) {
  const cli = [path.join(path.dirname(layout.node), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(path.dirname(layout.node), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')].find(file => existsSync(file));
  if (!cli) throw new Error(`npm is missing beside ${layout.node}: run npm run setup:local first`);
  const result = spawnSync(layout.node, [cli, 'ci', '--no-audit', '--no-fund', '--omit=dev', '--ignore-scripts', '--prefer-offline'],
    { cwd: dir, stdio: 'inherit', windowsHide: true, env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' } });
  if (result.status !== 0) throw new Error(`npm ci in ${dir} failed (${result.status})`);
}

/** x64, the machine of a PE file the payload's programs can load. */
export const PE_X64 = 0x8664;

/** A Windows program or library's machine, linker version and the DLLs it imports (its import and delay-load tables,
 *  lowercased); null for a file that is not one. */
export function peImports(file) {
  const data = readFileSync(file);
  if (data.length < 0x40 || data.readUInt16LE(0) !== 0x5a4d) return null;
  const pe = data.readUInt32LE(0x3c);
  if (pe + 24 > data.length || data.readUInt32LE(pe) !== 0x4550) return null;
  const machine = data.readUInt16LE(pe + 4);
  const sections = data.readUInt16LE(pe + 6);
  const optional = pe + 24;
  const plus = data.readUInt16LE(optional) === 0x20b;
  const count = data.readUInt32LE(optional + (plus ? 108 : 92));
  const directories = optional + (plus ? 112 : 96);
  const table = optional + data.readUInt16LE(pe + 20);
  const offset = rva => {
    for (let index = 0; index < sections; index += 1) {
      const header = table + index * 40;
      const start = data.readUInt32LE(header + 12);
      if (rva >= start && rva < start + Math.max(data.readUInt32LE(header + 8), data.readUInt32LE(header + 16))) return rva - start + data.readUInt32LE(header + 20);
    }
    return -1;
  };
  const text = rva => {
    const at = offset(rva);
    return at < 0 ? '' : data.toString('latin1', at, data.indexOf(0, at));
  };
  const names = [];
  // Import descriptors are 20 bytes with the name at 12; delay-load ones 32 bytes with the name at 4; an empty one ends each.
  for (const [index, size, nameAt] of [[1, 20, 12], [13, 32, 4]]) {
    const rva = index < count ? data.readUInt32LE(directories + index * 8) : 0;
    for (let at = rva ? offset(rva) : -1; at >= 0 && at + size <= data.length && data.readUInt32LE(at + nameAt); at += size) names.push(text(data.readUInt32LE(at + nameAt)));
  }
  // The linker that made it (its major and minor version: 14.44 for Visual Studio 2022 17.14).
  const linker = [data[optional + 2], data[optional + 3]];
  return { machine, linker, imports: [...new Set(names.filter(Boolean).map(name => name.toLowerCase()))] };
}

/** The modules of PostgreSQL's lib folder the server itself loads: PL/pgSQL (every database has it), Snowball's
 *  stemmers (initdb makes the text search dictionaries with them), the encoding conversions (<from>_and_<to>, and
 *  euc2004_sjis2004), the replication modules and the event log's messages. libdirGaps checks that every module the
 *  catalog's files name is kept. */
export const SERVER_MODULES = /^(plpgsql|dict_snowball|libpqwalreceiver|pgoutput|pgevent|euc2004_sjis2004|[a-z0-9]+(_[a-z0-9]+)*_and_[a-z0-9]+(_[a-z0-9]+)*)\.dll$/i;

/** What of PostgreSQL's archive the payload leaves out, nothing here running it (a path within it, as bin/x.exe):
 *  every extension (contrib's and EDB's: modules and their control and SQL files; AwwO's migrations create none, and
 *  several carry another project's code under terms of its own, as uuid-ossp's OSSP uuid, fuzzystrmatch's Perl-licensed
 *  dmetaphone and pgcrypto's parts do) and contrib's programs (oid2name, vacuumlo), the procedural languages in Perl,
 *  Python and Tcl, the message translations (the runtime runs PostgreSQL in English, and each translation has its
 *  translators' notice), the libraries and kit that extensions are built with (.lib, .a, pgxs), EDB's StackBuilder (an
 *  add-on downloader) with the wxWidgets and curl libraries only it loads, and ICU's test plugin. unmetImports shows
 *  nothing kept needs them. */
export function postgresLeftOut(relative) {
  const parts = relative.replaceAll('\\', '/').split('/').filter(Boolean);
  const name = parts.at(-1) || '';
  if (/\.(lib|a)$/i.test(name) || /^(stackbuilder.*|wx(base|msw)\d+.*\.dll|libcurl\.dll|testplug\.dll|oid2name\.exe|vacuumlo\.exe)$/i.test(name)) return true;
  if (parts[0] === 'lib') return parts[1] === 'pgxs' || (parts.length === 2 && /\.dll$/i.test(name) && !SERVER_MODULES.test(name));
  if (parts[0] === 'share' && parts[1] === 'locale') return true;
  if (parts[0] === 'share' && parts[1] === 'extension') return parts.length === 3 && !/^plpgsql(\.control|--[^/]*\.sql)$/i.test(name);
  return false;
}

/** The modules PostgreSQL's catalog files in share (what initdb loads, and the extension files kept) name
 *  ($libdir/<module>) that the lib folder does not hold: each would fail where the server comes to load it. */
export function libdirGaps(pgsql) {
  const named = new Set();
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(sql|bki)$/i.test(entry.name)) for (const match of readFileSync(full, 'utf8').matchAll(/\$libdir\/([A-Za-z0-9_]+)/g)) named.add(match[1]);
    }
  };
  walk(path.join(pgsql, 'share'));
  return [...named].filter(module => !existsSync(path.join(pgsql, 'lib', `${module}.dll`))).sort();
}

/** The Visual C++ runtime, which Windows does not ship (its redistributable installs it): who imports it needs a copy. */
const VC_RUNTIME = /^(vcruntime|msvcp|msvcr|concrt|vccorlib|vcomp|vcamp|mfc)\d+(_\w+)?\.dll$/i;

/** What the payload's x64 programs, libraries and Node.js addons import and no folder Windows would look in has: beside
 *  the program loading it (PostgreSQL's libraries are loaded by its programs in pgsql/bin, addons by node), beside the
 *  library itself (Node.js loads an addon with its own folder searched), then System32, where the VC++ runtime does not
 *  count: it is there only where something installed it. A package's builds for other machines (an arm64 addon beside
 *  the x64 one) are never loaded here. */
export function unmetImports(out, system = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')) {
  const missing = [];
  const pgBin = path.join(out, 'build', 'pgsql', 'bin');
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(file); continue; }
      if (!/\.(exe|dll|node)$/i.test(entry.name)) continue;
      const folders = [path.dirname(file)];
      if (file.startsWith(path.join(out, 'build', 'pgsql') + path.sep)) folders.push(pgBin);
      if (/\.node$/i.test(entry.name)) folders.push(path.join(out, 'build', 'node'));
      const pe = peImports(file);
      if (!pe || pe.machine !== PE_X64) continue;
      for (const name of pe.imports) {
        if (/^(api|ext)-ms-win-/.test(name) || folders.some(folder => existsSync(path.join(folder, name)))) continue;
        if (!VC_RUNTIME.test(name) && existsSync(path.join(system, name))) continue;
        missing.push(`${path.relative(out, file)} imports ${name}`);
      }
    }
  };
  walk(out);
  return missing;
}

/** The VC++ runtime's files the payload carries (of a Microsoft.VC14x.CRT folder; vccorlib is C++/CX's alone). */
export const VC_RUNTIME_FILES = Object.freeze(['vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll', 'msvcp140_1.dll', 'msvcp140_2.dll',
  'msvcp140_atomic_wait.dll', 'msvcp140_codecvt_ids.dll', 'concrt140.dll']);

const compareVersions = (a, b) => a.reduce((order, part, index) => order || part - (b[index] || 0), 0);

/** Files' versions from their version resources ([major, minor, build, revision]; [] for none). */
function fileVersions(files) {
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const list = files.map(file => `'${file.replaceAll("'", "''")}'`).join(',');
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command',
    `@(${list}) | ForEach-Object { $v = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($_); '{0}.{1}.{2}.{3}' -f $v.FileMajorPart, $v.FileMinorPart, $v.FileBuildPart, $v.FilePrivatePart }`],
  { encoding: 'utf8', windowsHide: true });
  const lines = String(result.stdout).trim().split(/\r?\n/);
  const versions = files.map((_, index) => (lines[index] || '').trim().split('.').map(Number));
  // Four numbers each, or nothing is decided by it: an unread version never passes for an old or a new one.
  const unread = files.filter((_, index) => versions[index].length !== 4 || versions[index].some(part => !Number.isInteger(part)) || versions[index][0] === 0);
  if (result.status !== 0 || unread.length) throw new Error(`The versions of ${unread.join(', ') || files.join(', ')} could not be read: ${String(result.stderr).slice(-500)}`);
  return versions;
}

/** Who files' version resources say made them (their CompanyName; '' for none). */
function fileCompanies(files) {
  if (!files.length) return [];
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const list = files.map(file => `'${file.replaceAll("'", "''")}'`).join(',');
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command',
    `ConvertTo-Json -Compress -InputObject @(@(${list}) | ForEach-Object { [string][System.Diagnostics.FileVersionInfo]::GetVersionInfo($_).CompanyName })`],
  { encoding: 'utf8', windowsHide: true, maxBuffer: 16 << 20 });
  let companies = null;
  try { companies = result.status === 0 ? JSON.parse(String(result.stdout).trim()) : null; } catch { /* reported below */ }
  if (!Array.isArray(companies) || companies.length !== files.length) throw new Error(`Who made ${files.length} files could not be read: ${String(result.stderr).slice(-500)}`);
  return companies.map(company => String(company || '').trim());
}

/** What collectPostgresLicences checks of a PostgreSQL folder: its bin folder's files (a DLL with its SHA-256), its lib
 *  folder's modules with who they say made them, and the version its own postgres.exe names. */
export function inspectPostgres(pgsql) {
  const bin = readdirSync(path.join(pgsql, 'bin')).map(name => ({ name, sha256: /\.dll$/i.test(name) ? sha256(readFileSync(path.join(pgsql, 'bin', name))) : null }));
  const modules = readdirSync(path.join(pgsql, 'lib')).filter(name => /\.dll$/i.test(name));
  const companies = fileCompanies(modules.map(name => path.join(pgsql, 'lib', name)));
  const result = spawnSync(path.join(pgsql, 'bin', 'postgres.exe'), ['-V'], { encoding: 'utf8', windowsHide: true, env: { ...outsideSettingsRemoved(), LC_MESSAGES: 'C' } });
  return { bin, lib: modules.map((name, index) => ({ name, company: companies[index] })), version: postgresVersionOf(result.stdout) };
}

/** The x64 VC++ runtimes here, newest first: the Visual Studio installations' redistributables
 *  (VC\Redist\MSVC\<version>\x64\Microsoft.VC14x.CRT, whose files Microsoft lets an app carry beside it), then the one
 *  Microsoft's redistributable installed in System32, each with msvcp140.dll's version. */
export function vcRuntimes() {
  const vswhere = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  const found = existsSync(vswhere) ? spawnSync(vswhere, ['-all', '-products', '*', '-format', 'value', '-property', 'installationPath'], { encoding: 'utf8', windowsHide: true }).stdout : '';
  const folders = [];
  for (const install of String(found).split(/\r?\n/).filter(Boolean)) {
    const msvc = path.join(install, 'VC', 'Redist', 'MSVC');
    if (!existsSync(msvc)) continue;
    for (const version of readdirSync(msvc).filter(name => /^\d+(\.\d+)+$/.test(name))) {
      const x64 = path.join(msvc, version, 'x64');
      const crt = existsSync(x64) ? readdirSync(x64).find(name => /^Microsoft\.VC\d+\.CRT$/.test(name)) : undefined;
      if (crt) folders.push(path.join(x64, crt));
    }
  }
  const system = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  folders.push(system);
  const complete = folders.filter(folder => ['vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll'].every(name => existsSync(path.join(folder, name))));
  if (!complete.length) return [];
  const versions = fileVersions(complete.map(folder => path.join(folder, 'msvcp140.dll')));
  return complete.map((folder, index) => ({ folder, version: versions[index], visualStudio: folder !== system }))
    .sort((a, b) => compareVersions(b.version, a.version));
}

/** The VC++ runtime the payload carries: Visual Studio's newest redistributable that is at least as new as what built
 *  PostgreSQL (needed), Visual Studio's licence letting an app carry the files of its own redistributable folder. The
 *  one in System32 (that some other product's installer put there) only for a build to test (allowSystem), which is
 *  not to be published. */
export function chooseVcRuntime(runtimes, needed, { allowSystem = false } = {}) {
  const fresh = runtimes.filter(runtime => compareVersions(runtime.version, needed) >= 0);
  const chosen = fresh.find(runtime => runtime.visualStudio) || (allowSystem ? fresh[0] : undefined);
  if (chosen) return chosen;
  const found = runtimes.map(runtime => `${runtime.version.join('.')} in ${runtime.folder}`).join(', ') || 'none';
  if (fresh.length) {
    throw new Error(`No Visual Studio redistributable here is as new as the tools that built PostgreSQL (${needed.join('.')}; found ${found}): a build to publish carries Visual Studio's, so update the Visual Studio C++ build tools (17.14 or newer), or build one to test with --test-build`);
  }
  throw new Error(`No Visual C++ runtime here is as new as the tools that built PostgreSQL (${needed.join('.')}; found ${found}): update the Visual Studio C++ build tools`);
}

/** The newest linker among the payload's x64 programs and libraries that import the VC++ runtime ([major, minor]): the
 *  runtime they run on must be at least as new as the tools that built them. */
export function vcRuntimeNeeded(out) {
  let needed = [0, 0];
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(file); continue; }
      if (!/\.(exe|dll|node)$/i.test(entry.name)) continue;
      const pe = peImports(file);
      if (pe && pe.machine === PE_X64 && pe.imports.some(name => VC_RUNTIME.test(name)) && compareVersions(pe.linker, needed) > 0) needed = pe.linker;
    }
  };
  walk(out);
  return needed;
}

/** The notices of the hosted release (copyNotices of scripts/awwo-saas-release.ts), copied by the Node.js 24 the payload
 *  carries, which runs TypeScript as it is. */
export function copyNotices(layout, root, target) {
  const release = pathToFileURL(path.join(root, 'scripts', 'awwo-saas-release.ts')).href;
  const script = `import { copyNotices } from ${JSON.stringify(release)};\ncopyNotices(${JSON.stringify(root)}, ${JSON.stringify(target)});\n`;
  const result = spawnSync(layout.node, ['--input-type=module', '--eval', script], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`The notices were not copied:\n${String(result.stderr).slice(-2000)}`);
}

/** The licences of the Rust crates the shell's program is built from, into target/<name>-<version>/: the files each
 *  package ships, and those third_party/rust-crates holds for it (a crate's repository's own, fetched with their
 *  provenance by scripts/awwo-crate-licences.mjs where the package ships none, and the WebView2 SDK's licence beside
 *  webview2-com-sys, which links Microsoft's loader into the program). A crate under MPL also gets SOURCE.txt, where its
 *  Source Code Form is, as MPL asks of every executable; one with no file of MPL's text gets the text another MPL crate
 *  ships (it is the same for every work). A crate with no licence file anywhere stops the packaging: no text is made
 *  up for it. CRATES.md lists every crate with its licence. Rust's standard library, linked into every Rust program
 *  and in no crate's metadata, comes from the toolchain's own documentation (rust/). */
export function collectCrateLicences(shell, target, { root = repoRoot, metadata = shellMetadata(shell), sysroot = rustSysroot() } = {}) {
  const curated = path.join(root, 'third_party', 'rust-crates');
  const changed = provenanceDifferences(curated);
  if (changed.length) throw new Error(`third_party/rust-crates is not as fetched (node scripts/awwo-crate-licences.mjs --check):\n${changed.join('\n')}`);
  const crates = linkedCrates(metadata).sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  const isMpl = crate => /\bMPL-2\.0\b/.test(crate.license || '');
  const mplText = file => /Mozilla Public License Version 2\.0/.test(readFileSync(file, 'utf8'));
  const mplSource = crates.filter(isMpl).map(shippedLicences).flat().find(mplText);
  const rows = [];
  const unknown = [];
  for (const crate of crates) {
    const key = `${crate.name}-${crate.version}`;
    const folder = path.join(target, 'crates', key);
    mkdirSync(folder, { recursive: true });
    const files = [...shippedLicences(crate)];
    const kept = path.join(curated, key);
    if (existsSync(kept)) for (const name of readdirSync(kept)) if (!files.some(file => path.basename(file) === name)) files.push(path.join(kept, name));
    const notes = [];
    if (isMpl(crate)) {
      if (!files.some(mplText) && mplSource) { files.push(mplSource); notes.push('MPL-2.0\'s text, as another MPL crate ships it'); }
      writeFileSync(path.join(folder, 'SOURCE.txt'), `${crate.name} ${crate.version} is used unmodified, under ${crate.license}. Its Source Code Form: https://crates.io/crates/${crate.name}/${crate.version}${crate.repository ? ` (${crate.repository})` : ''}.\n`);
    }
    if (!files.length) { unknown.push(`${key} (${crate.license || 'no licence named'})`); continue; }
    // webview2-com-sys links Microsoft's WebView2 loader into the program: the SDK's licence is needed beside the crate's.
    if (crate.name === 'webview2-com-sys' && !files.some(source => path.basename(source) === 'WebView2-SDK-LICENSE.txt')) {
      unknown.push(`${key} (the WebView2 SDK's licence, for the loader it links)`);
      continue;
    }
    for (const source of files) copy(source, path.join(folder, path.basename(source)));
    const written = [...files.map(source => path.basename(source)), ...(isMpl(crate) ? ['SOURCE.txt'] : [])];
    rows.push(`| ${crate.name} | ${crate.version} | ${crate.license || ''} | ${written.join(', ')}${notes.length ? ` (${notes.join('; ')})` : ''} |`);
  }
  if (unknown.length) throw new Error(`These crates of the window's program have no licence file in their package or in third_party/rust-crates (node scripts/awwo-crate-licences.mjs fetches them from their repositories):\n${unknown.join('\n')}`);
  // Where the files third_party/rust-crates holds were fetched.
  if (existsSync(path.join(curated, 'PROVENANCE.json'))) copy(path.join(curated, 'PROVENANCE.json'), path.join(target, 'crates', 'PROVENANCE.json'));
  // Rust's standard library: its copyright notices and the licence texts they name.
  const rustDocs = path.join(sysroot, 'share', 'doc', 'rust');
  for (const name of ['COPYRIGHT-library.html', 'licenses']) copy(path.join(rustDocs, name), path.join(target, 'rust', name));
  writeFileSync(path.join(target, 'CRATES.md'), `# The Rust code of AwwO Local's program (apps/windows-local)\n\nRust's standard library: rust/COPYRIGHT-library.html, with the licence texts it names in rust/licenses/. Each crate's licence and notice files are in crates/<name>-<version>/; where those not in a crate's package were fetched from is in crates/PROVENANCE.json.\n\n| Crate | Version | Licence | Files |\n| --- | --- | --- | --- |\n${rows.join('\n')}\n`);
  return rows.length;
}

/** The sysroot of the Rust toolchain that builds the shell. */
function rustSysroot() {
  const result = spawnSync('rustc', ['--print', 'sysroot'], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error('rustc is needed (it builds the window\'s program)');
  return result.stdout.trim();
}

/** What the Go modules' notices (third_party/go-modules/modules.txt: the toolchain's line, then a line a module) do not
 *  cover of what the API links (the same, as linkedModules of scripts/awwo-go-licences.ts reads go version -m): another
 *  toolchain (its standard library's notices are of the one they were made with), or a module they do not name. They
 *  were made for the hosted API's Linux build, which links one more (procfs is Linux's): the hosted release's check of
 *  equality would refuse this Windows build, so any of their modules may be missing. */
export function goNoticeGaps(linked, listed) {
  const [toolchain, ...modules] = linked;
  const [listedToolchain, ...listedModules] = listed;
  if (toolchain !== listedToolchain) return [`the API was built with ${toolchain}, the notices are for ${listedToolchain} (build with GOTOOLCHAIN=${String(listedToolchain).slice(3)})`];
  return modules.filter(line => !listedModules.includes(line)).map(line => `${line}: not in the notices`);
}

/** Stops the packaging when the Go modules' notices do not cover the API carried here (goNoticeGaps). */
export function checkGoNotices(layout, root) {
  const licences = pathToFileURL(path.join(root, 'scripts', 'awwo-go-licences.ts')).href;
  // linkedModules is TypeScript, which the payload's Node.js 24 runs as it is.
  const script = `import { linkedModules } from ${JSON.stringify(licences)};
import { execFileSync } from 'node:child_process';
process.stdout.write(linkedModules(execFileSync('go', ['version', '-m', ${JSON.stringify(layout.api)}], { encoding: 'utf8', maxBuffer: 16 << 20 })));
`;
  const result = spawnSync(layout.node, ['--input-type=module', '--eval', script], { encoding: 'utf8', windowsHide: true, maxBuffer: 16 << 20 });
  if (result.status !== 0) throw new Error(`What the API carried here links could not be read:\n${String(result.stderr).slice(-2000)}`);
  const lines = text => text.split(/\r?\n/).filter(Boolean);
  const gaps = goNoticeGaps(lines(result.stdout), lines(readFileSync(path.join(root, 'third_party', 'go-modules', 'modules.txt'), 'utf8')));
  if (gaps.length) throw new Error(`The Go modules' notices do not cover what the API carried here links (run node scripts/awwo-go-licences.ts):\n${gaps.join('\n')}`);
}

/** The licences of the npm packages the payload's workers carry, into target (licenses/npm): NPM.md lists each package
 *  (once a version) with its licence and its licence files, where it ships them in its package; for one that ships
 *  none, the files third_party/npm-packages holds for it (its repository's, fetched by scripts/awwo-npm-licences.mjs,
 *  with PROVENANCE.json), else its README where that carries its licence, copied into target/<name>@<version>/. A
 *  package with no licence anywhere, or under one that is not permissive, stops the packaging. */
export function collectNpmLicences(out, target, { root = repoRoot, machine = WINDOWS_X64 } = {}) {
  const curated = path.join(root, 'third_party', 'npm-packages');
  const changed = provenanceDifferences(curated);
  if (changed.length) throw new Error(`third_party/npm-packages is not as fetched (node scripts/awwo-npm-licences.mjs --check):\n${changed.join('\n')}`);
  const roots = PACKAGED_WORKERS.map(worker => path.join(out, 'app', 'apps', worker, 'node_modules'));
  const inPayload = file => path.relative(out, file).replaceAll(path.sep, '/');
  const rows = [];
  const problems = [];
  for (const item of installedPackages(roots, machine)) {
    const key = folderOf(item.name, item.version);
    if (!permissiveLicence(item.licence)) problems.push(`${key}: under ${item.licence || 'no licence it names'}, not one of the permissive licences`);
    let files = item.files.map(inPayload);
    if (!files.length) {
      const kept = path.join(curated, key);
      const sources = existsSync(kept) && readdirSync(kept).length ? readdirSync(kept).map(name => path.join(kept, name)) : item.readme ? [item.readme] : [];
      for (const source of sources) copy(source, path.join(target, key, path.basename(source)));
      files = sources.map(source => inPayload(path.join(target, key, path.basename(source))));
    }
    if (!files.length) problems.push(`${key}: no licence file, in its package or in third_party/npm-packages`);
    rows.push(`| ${item.name} | ${item.version} | ${item.licence} | ${files.join(', ')} |`);
  }
  if (problems.length) throw new Error(`The workers' npm packages cannot be carried as they are (node scripts/awwo-npm-licences.mjs fetches a missing licence):\n${problems.join('\n')}`);
  mkdirSync(target, { recursive: true });
  if (existsSync(path.join(curated, 'PROVENANCE.json'))) copy(path.join(curated, 'PROVENANCE.json'), path.join(target, 'PROVENANCE.json'));
  writeFileSync(path.join(target, 'NPM.md'), `# The npm packages of AwwO Local's workers\n\nThe packages in app/apps/<worker>/node_modules, once a version, with their licences. A package's licence files are in it; for one that ships none, its repository's (fetched where PROVENANCE.json says), or its README where that carries its licence, are in <name>@<version>/ here. Left out of the payload: ${LEFT_OUT_PACKAGES.join(', ')} and its builds for each machine, which no worker uses.\n\n| Package | Version | Licence | Files |\n| --- | --- | --- | --- |\n${rows.join('\n')}\n`);
  return rows.length;
}

/** The licences of the libraries PostgreSQL's programs load, and the sources of those under the LGPL (POSTGRES_LIBRARIES
 *  of scripts/awwo-postgres-licences.mjs): each library's licence files, from its own release, into
 *  pgsql/licenses/<name>-<version>/; the GNU releases libintl and libiconv were built from into pgsql/sources/
 *  (setup:local downloads them); and LIBRARIES.md, which DLL is which library under which licence. Another PostgreSQL
 *  than the list was made for, a DLL it does not name or of other bytes, or a module of another project's in lib
 *  (postgresLibraryGaps, on what inspectPostgres finds), stops the packaging. */
export function collectPostgresLicences(layout, pgsql, { root = repoRoot, list = POSTGRES_LIBRARIES, found = inspectPostgres(pgsql), vcRuntime = null } = {}) {
  const gaps = postgresLibraryGaps(found, list);
  if (gaps.length) throw new Error(`PostgreSQL's libraries are not the ones listed (POSTGRES_LIBRARIES in scripts/awwo-postgres-licences.mjs):\n${gaps.join('\n')}`);
  const curated = path.join(root, 'third_party', 'postgres-windows');
  const changed = provenanceDifferences(curated);
  if (changed.length) throw new Error(`third_party/postgres-windows is not as fetched (node scripts/awwo-postgres-licences.mjs --check):\n${changed.join('\n')}`);
  const archiveOf = library => path.join(layout.build, 'downloads', library.source.name);
  for (const library of list.libraries.filter(item => item.source)) {
    const archive = archiveOf(library);
    if (!existsSync(archive) || sha256(readFileSync(archive)) !== library.source.sha256) throw new Error(`Missing ${archive}, the source of ${Object.keys(library.dlls).join(', ')}: run npm run setup:local first`);
  }
  const rows = [];
  for (const library of list.libraries) {
    const key = `${library.name}-${library.version}`;
    const files = Object.keys(library.files).map(name => {
      copy(path.join(curated, key, name), path.join(pgsql, 'licenses', key, name));
      return `licenses/${key}/${name}`;
    });
    if (library.source) {
      copy(archiveOf(library), path.join(pgsql, 'sources', library.source.name));
      files.unshift('commandlinetools_3rd_party_licenses.txt (the LGPL\'s text)');
      files.push(`sources/${library.source.name}`);
    }
    const where = [...Object.keys(library.dlls).map(dll => `bin/${dll}`), ...(library.builtInto || []).map(file => `built into ${file}`)];
    rows.push(`| ${where.join(', ')} | ${library.name} ${library.version} | ${library.licence} | ${files.join(', ')} |`);
  }
  // Where the VC++ runtime carried came from: Visual Studio's redistributable, or (a build to test only) System32's.
  const runtime = !vcRuntime ? ''
    : vcRuntime.visualStudio ? `\nThe Visual C++ runtime beside them (vcruntime140*.dll, msvcp140*.dll, concrt140.dll), ${vcRuntime.version.join('.')}, is Microsoft's redistributable, from Visual Studio's redistributable folder, which Visual Studio's licence lets an application carry.\n`
      : `\nThe Visual C++ runtime beside them (vcruntime140*.dll, msvcp140*.dll, concrt140.dll), ${vcRuntime.version.join('.')}, was copied from this build machine's System32: this is a build to test, not to be published.\n`;
  writeFileSync(path.join(pgsql, 'LIBRARIES.md'), `# The libraries PostgreSQL's programs here load

PostgreSQL ${found.version}, EDB's Windows binaries, with the server's own parts alone: its programs, and libpq, libecpg, libecpg_compat and libpgtypes in bin/; of lib/ the modules the server loads itself (PL/pgSQL, Snowball's stemmers, the encoding conversions, the replication modules, the event log's messages); its data files, without the message translations. These are under PostgreSQL's licence, server_license.txt, with code of others in its source under their own notices: licenses/postgresql-source-18/copyright (as Debian's postgresql-18 package lists them) and licenses/postgresql-source-18/NOTICES.txt (as the headers of the 18.4 source's own files have them). commandlinetools_3rd_party_licenses.txt is EDB's list of the libraries below; each library's own licence files, from its release of the version here, are in licenses/. Left out of EDB's archive: every extension (contrib's and EDB's) and contrib's programs, the Perl, Python and Tcl languages, what extensions are built with, StackBuilder and what only it loads, and ICU's test plugin.

libintl-9.dll (gettext's) and libiconv-2.dll are under the GNU Lesser General Public License, version 2.1 or later. Their source code is in sources/: the GNU releases of the versions these DLLs are, as their own build paths name them (gettext-0.19.8, libiconv-1.18). PostgreSQL's programs load each from bin/ when they start, so a build of them put in its place there is the one they load. They, and libwinpthread-1.dll, were built by MinGW-w64's GCC, which linked its runtime into them: its notices are in licenses/mingw-w64-runtime-*/.
${runtime}

| Files | Library | Licence | Licence files and source |
| --- | --- | --- | --- |
${rows.join('\n')}
`);
  return rows.length;
}

/** The relative specifiers a script imports: static imports, re-exports and dynamic imports of a string. */
export const relativeImports = text => [...text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.\.?\/[^'"\n]+)\1/g)].map(match => match[2]);

/** What the payload's own scripts import by relative path and the payload does not hold. Its packages (node_modules),
 *  the built web app and the managed execution's built core are complete as they were built, so they are not read. */
export function missingImports(out) {
  const app = path.join(out, 'app');
  const skipped = new Set([path.join(app, 'apps', 'web', 'dist-saas')]);
  const missing = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== '.runtime' && !skipped.has(full)) walk(full);
      } else if (/\.[cm]?[jt]s$/.test(entry.name)) {
        for (const specifier of relativeImports(readFileSync(full, 'utf8'))) {
          if (!existsSync(path.resolve(path.dirname(full), specifier))) missing.push(`${path.relative(out, full)} imports ${specifier}`);
        }
      }
    }
  };
  walk(app);
  return missing;
}

/** Assembles the payload from this checkout and its build into out (a build folder's payload); testBuild lets it carry
 *  System32's VC++ runtime (chooseVcRuntime), for a build not to be published. */
export function assemblePayload({ layout = localLayout(), out, root = repoRoot, testBuild = false }) {
  for (const need of [layout.api, layout.node, path.join(layout.pgBin, 'postgres.exe'), path.join(layout.web, 'saas.html'), layout.brokerCore]) {
    if (!existsSync(need)) throw new Error(`Missing ${need}: run npm run setup:local first (with Docker running for the managed execution's core)`);
  }
  if (!replaceableOut(out)) throw new Error(`Refusing to replace ${out}: it holds something other than a payload`);
  rmSync(out, { recursive: true, force: true });
  // The folder is marked as a payload before anything is copied, so one left by a failed assembly is replaced next time.
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, MANIFEST), `${JSON.stringify({ assembling: true })}\n`);
  const app = path.join(out, 'app');
  const build = path.join(out, 'build');
  mkdirSync(path.join(app, 'scripts'), { recursive: true });
  for (const file of RUNTIME_FILES) copy(path.join(root, file), path.join(app, file));
  copy(path.join(root, 'package.json'), path.join(app, 'package.json'));
  for (const name of SHARED_WORKER_FILES) copy(path.join(root, 'apps', name), path.join(app, 'apps', name));
  copy(layout.web, path.join(app, 'apps', 'web', 'dist-saas'));
  for (const worker of [...PACKAGED_WORKERS, 'openmaus-worker']) {
    const source = path.join(root, 'apps', worker);
    copy(source, path.join(app, 'apps', worker), workerFilter(source, { modules: false }));
  }
  for (const worker of PACKAGED_WORKERS) {
    installWorkerPackages(layout, path.join(app, 'apps', worker));
    prunePackages(path.join(app, 'apps', worker, 'node_modules'));
    pruneOtherPlatforms(path.join(app, 'apps', worker, 'node_modules'));
    pruneLeftOut(path.join(app, 'apps', worker, 'node_modules'));
  }
  copy(path.dirname(layout.brokerCore), path.join(app, 'apps', 'openmaus-worker', '.runtime', 'core', 'dist-server'));
  copy(path.join(root, 'deploy', 'saas', 'workspace'), path.join(app, 'deploy', 'saas', 'workspace'), item => !path.basename(item).startsWith('.'));
  copy(layout.node, path.join(build, 'node', path.basename(layout.node)));
  for (const entry of readdirSync(path.dirname(layout.node))) {
    const from = path.join(path.dirname(layout.node), entry);
    if (entry !== path.basename(layout.node) && nodeFilter(path.dirname(layout.node))(from)) copy(from, path.join(build, 'node', entry), nodeFilter(path.dirname(layout.node)));
  }
  const pgsql = path.dirname(layout.pgBin);
  for (const part of ['bin', 'lib', 'share']) copy(path.join(pgsql, part), path.join(build, 'pgsql', part), item => !postgresLeftOut(path.relative(pgsql, item)));
  const unloadable = libdirGaps(path.join(build, 'pgsql'));
  if (unloadable.length) throw new Error(`PostgreSQL's catalog names modules the payload leaves out (SERVER_MODULES): ${unloadable.join(', ')}`);
  // PostgreSQL's licences beside it, as its archive has them (its libraries' own and the LGPL sources follow, once the
  // VC++ runtime is beside its programs); Node.js's LICENSE came with its folder.
  for (const name of POSTGRES_LICENCES) copy(path.join(path.dirname(layout.pgBin), name), path.join(build, 'pgsql', name));
  // AwwO's licence and its notices, with every licence file they name, at their repository paths (as the hosted
  // release's archive carries them, scripts/awwo-saas-release.ts noticePaths), the Go modules' among them, checked
  // against the API carried here; the licences of the workers' npm packages; and those of the crates the window's
  // program is built from.
  copyNotices(layout, root, path.join(out, 'licenses'));
  checkGoNotices(layout, root);
  collectNpmLicences(out, path.join(out, 'licenses', 'npm'), { root });
  collectCrateLicences(SHELL, path.join(out, 'licenses', 'apps', 'windows-local'), { root });
  // PostgreSQL's programs (and the ICU they load) need the VC++ runtime, which a fresh Windows does not have. A copy
  // beside a program is loaded before System32's, so it must be at least as new as the tools that built them.
  const vcRuntime = chooseVcRuntime(vcRuntimes(), vcRuntimeNeeded(out), { allowSystem: testBuild });
  if (!vcRuntime.visualStudio) console.warn(`A build to test, not to publish: the Visual C++ runtime carried is ${vcRuntime.version.join('.')} from ${vcRuntime.folder}, no Visual Studio redistributable here being new enough.`);
  for (const name of VC_RUNTIME_FILES) {
    if (existsSync(path.join(vcRuntime.folder, name)) && !existsSync(path.join(build, 'pgsql', 'bin', name))) copy(path.join(vcRuntime.folder, name), path.join(build, 'pgsql', 'bin', name));
  }
  // PostgreSQL's libraries' licences and the LGPL ones' sources, checked against what is there (its postgres.exe now
  // starts with the runtime beside it).
  collectPostgresLicences(layout, path.join(build, 'pgsql'), { root, vcRuntime });
  copy(layout.api, path.join(build, path.basename(layout.api)));
  const unmet = unmetImports(out);
  if (unmet.length) throw new Error(`The payload's programs import what a fresh Windows would not have:\n${unmet.join('\n')}`);
  const missing = missingImports(out);
  if (missing.length) throw new Error(`The payload lacks what its scripts import:\n${missing.join('\n')}`);
  const secret = privateFiles(out);
  if (secret.length) throw new Error(`The payload holds private configuration it must not carry:\n${secret.join('\n')}`);
  const unloaded = pruneUnloadedBuilds(out);
  checkLoads(layout.node, unloaded);
  return { ...inspectPayload(out), unloadedBuilds: unloaded.map(root => path.relative(out, root).replaceAll(path.sep, '/')),
    vcRuntime: { version: vcRuntime.version.join('.'), from: vcRuntime.folder }, testBuild };
}

/** Counts the payload and checks what an installer could not place: links, and paths too long for Windows. */
export function inspectPayload(out) {
  let files = 0;
  let bytes = 0;
  let longest = '';
  const walk = dir => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) throw new Error(`A link would not survive the installer: ${full}`);
      const relative = path.relative(out, full);
      if (relative.length > longest.length) longest = relative;
      if (stat.isDirectory()) walk(full);
      else { files += 1; bytes += stat.size; }
    }
  };
  walk(out);
  if (longest.length > MAX_RELATIVE_PATH) throw new Error(`A path is too long for the installer (${longest.length} > ${MAX_RELATIVE_PATH}): ${longest}`);
  return { files, bytes, longest: longest.length };
}

export function revision(root) {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
  const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).stdout.trim() !== '';
  return { head, dirty };
}

/** This environment without what would change the runtime from outside: Node.js's own settings (NODE_OPTIONS can load
 *  code), npm's, and AwwO's (AWWO_LOCAL_PG_BIN would run another PostgreSQL). */
export const outsideSettingsRemoved = (env = process.env) => Object.fromEntries(Object.entries(env).filter(([key]) => !/^(NODE_|npm_|AWWO_)/i.test(key)));

/** Starts the payload's own runtime on a scratch data folder, reads its page, and stops it by closing its stdin. Its
 *  programs are where its runtime finds them on this system (localLayout): the Windows installer's and the Mac app's. */
export async function smokePayload(out) {
  const state = mkdtempSync(path.join(os.tmpdir(), 'awwo-local-smoke-'));
  const layout = localLayout({ resources: path.join(out, 'app'), build: path.join(out, 'build') });
  const node = layout.node;
  const child = spawn(node, [path.join(out, 'app', 'scripts', 'awwo-local.mjs'), '--events', '--stop-on-stdin-close', '--no-docker',
    '--resources', path.join(out, 'app'), '--build', path.join(out, 'build'), '--state', state],
  { cwd: path.join(out, 'app'), stdio: ['pipe', 'pipe', 'pipe'], env: outsideSettingsRemoved() });
  // Its end is watched from the start, so an end at any moment (before ready, during the page) is seen.
  const exited = new Promise(resolve => {
    child.once('exit', code => resolve(code));
    child.once('error', error => resolve(error.code || 'spawn failed'));
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const started = Date.now();
  let stopWaited = false;
  try {
    const ready = await new Promise((resolve, reject) => {
      let buffer = '';
      child.stdout.on('data', chunk => {
        buffer += chunk;
        for (let index; (index = buffer.indexOf('\n')) >= 0; buffer = buffer.slice(index + 1)) {
          const event = JSON.parse(buffer.slice(0, index));
          if (event.event === 'ready') resolve(event);
          if (event.event === 'error') reject(new Error(event.message));
        }
      });
      exited.then(code => reject(new Error(`the payload's runtime exited (${code}):\n${stderr.slice(-3000)}`)));
      // Its own start deadlines are five minutes for the API: past ten, it hangs.
      setTimeout(() => reject(new Error(`the payload's runtime was not ready after 600 s:\n${stderr.slice(-3000)}`)), 600_000).unref();
    });
    const url = new URL(ready.url);
    const status = await new Promise(resolve => {
      const req = http.request({ host: '127.0.0.1', port: Number(url.port), path: '/', headers: { host: url.host }, agent: false, timeout: 30_000 },
        res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', error => resolve(error.code));
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.end();
    });
    child.stdin.end();
    // Its orderly stop takes about three minutes at most: one that takes longer fails the smoke (and is ended below).
    const code = await Promise.race([exited, new Promise(resolve => setTimeout(() => resolve('a stop past 240 s'), 240_000).unref())]);
    if (code === 'a stop past 240 s') stopWaited = true;
    if (status !== 200 || code !== 0) throw new Error(`smoke: page ${status}, stop ${code}`);
    return { seconds: Math.round((Date.now() - started) / 1000), services: Object.keys(ready.services), page: status, stop: code };
  } finally {
    // A smoke that failed half-way still stops its runtime (in order: its stdin closes, unless its stop already ran out
    // of time; ended, if it must be, with its services, which end as it goes) and removes its data folder.
    if (child.exitCode === null && child.signalCode === null) {
      if (!stopWaited) {
        child.stdin.end();
        await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 240_000).unref())]);
      }
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 10_000).unref())]);
      }
    }
    // A runtime that was ended leaves its PostgreSQL running (pg_ctl starts it outside the runtime's processes): it is
    // stopped before its folder goes.
    const pgCtl = path.join(layout.pgBin, process.platform === 'win32' ? 'pg_ctl.exe' : 'pg_ctl');
    if (existsSync(path.join(state, 'postgres', 'postmaster.pid')) && existsSync(pgCtl)) {
      spawnSync(pgCtl, ['-D', path.join(state, 'postgres'), '-m', 'immediate', '-w', '-t', '60', 'stop'], { env: { ...outsideSettingsRemoved(), LC_MESSAGES: 'C' }, stdio: 'ignore', windowsHide: true, timeout: 90_000 });
    }
    // A database an ended runtime left still holds its files: then the folder stays in the temporary folder.
    try { rmSync(state, { recursive: true, force: true }); } catch { console.warn(`smoke: ${state} could not be removed`); }
  }
}

/** The installer's resources, given to Tauri at the build (tauri.conf.json names none, so the shell's own tests run
 *  without a payload): the payload folder beside the config, as payload beside the program. A folder keeps its layout,
 *  where a glob's files would land in one folder; and it is named relatively, as Tauri drops a drive letter. */
export const INSTALLER_RESOURCES = Object.freeze({ bundle: { resources: { payload: 'payload' } } });

/** The name a build to test's installer is given beside the one Tauri writes, so a file of that name, the one to
 *  publish, is never a build to test. */
export const testInstallerName = file => file.replace(/\.exe$/i, '-TEST.exe');

/** Builds the NSIS installer in a build folder and returns it, with its size and SHA-256; a build to test's under its
 *  own name (testInstallerName). */
function buildInstaller(build, { testBuild = false } = {}) {
  const cli = path.join(repoRoot, 'apps', 'desktop', 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
  if (!existsSync(cli)) throw new Error('The Tauri CLI is missing: npm ci --prefix apps/desktop');
  const config = JSON.parse(readFileSync(path.join(build, 'tauri.conf.json'), 'utf8'));
  // Cargo takes a relative target folder from where it builds: it is resolved there once, for Cargo and for this.
  const target = path.resolve(build, process.env.CARGO_TARGET_DIR || 'target');
  const file = path.join(target, 'release', 'bundle', 'nsis', `${config.productName}_${config.version}_x64-setup.exe`);
  const started = Date.now();
  const result = spawnSync(process.execPath, [cli, 'build', '--bundles', 'nsis', '--config', JSON.stringify(INSTALLER_RESOURCES)],
    { cwd: build, stdio: 'inherit', env: { ...process.env, CARGO_TARGET_DIR: target } });
  if (result.status !== 0) throw new Error(`the installer build failed (${result.status})`);
  if (!existsSync(file) || statSync(file).mtimeMs < started - 2000) throw new Error(`The installer build made no new ${file}`);
  const made = testBuild ? testInstallerName(file) : file;
  if (testBuild) renameSync(file, made);
  return { file: made, bytes: statSync(made).size, sha256: sha256(readFileSync(made)) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.platform !== 'win32') throw new Error('The Windows package is built on Windows.');
  const args = process.argv.slice(2);
  const at = args.indexOf('--out');
  if (at >= 0 && !args[at + 1]) throw new Error('--out needs a folder');
  const build = at >= 0 ? path.resolve(args[at + 1]) : SHELL;
  const out = prepareBuild(build);
  const version = JSON.parse(readFileSync(path.join(SHELL, 'tauri.conf.json'), 'utf8')).version;
  if (args.includes('--keep-payload')) {
    // The payload an earlier run assembled there, complete (its manifest is written once it is).
    const manifest = existsSync(path.join(out, MANIFEST)) ? JSON.parse(readFileSync(path.join(out, MANIFEST), 'utf8')) : {};
    const problem = keptPayloadProblem(manifest, { version, testBuild: args.includes('--test-build'), source: revision(repoRoot) });
    if (problem) throw new Error(`The payload in ${out} cannot be kept: ${problem}. Run without --keep-payload`);
    console.log(`AwwO 本地版 payload in ${out}, kept: made from ${manifest.revision}${manifest.dirty ? ' with changes' : ''} at ${manifest.packagedAt}${manifest.testBuild ? ' (a build to test)' : ''}`);
  } else {
    // The code's and the build's locks, shared, as a runtime holds them: no setup:local replaces them while they are copied.
    const release = await holdBuild(localLayout()).catch(error => {
      throw new Error(`The payload is not assembled: ${error.message.replace('start it again', 'package it again')}`);
    });
    let counted;
    try { counted = assemblePayload({ out, testBuild: args.includes('--test-build') }); } finally { await release(); }
    const source = revision(repoRoot);
    writeFileSync(path.join(out, MANIFEST), `${JSON.stringify({ format: MANIFEST_FORMAT, version, revision: source.head, dirty: source.dirty, packagedAt: new Date().toISOString(), ...counted }, null, 2)}\n`);
    console.log(`AwwO 本地版 payload in ${out}: ${counted.files} files, ${(counted.bytes / 1048576).toFixed(0)} MB, longest path ${counted.longest} characters${source.dirty ? ' (from a checkout with changes)' : ''}`);
    for (const root of counted.unloadedBuilds) console.log(`  without the dist-es Node.js never loads (its paths were too long): ${root}`);
  }
  if (args.includes('--smoke')) console.log('smoke:', JSON.stringify(await smokePayload(out)));
  if (!args.includes('--no-installer')) {
    const testBuild = JSON.parse(readFileSync(path.join(out, MANIFEST), 'utf8')).testBuild === true;
    const installer = buildInstaller(build, { testBuild });
    console.log(`installer: ${installer.file} (${(installer.bytes / 1048576).toFixed(0)} MB)\nsha256: ${installer.sha256}`);
    if (testBuild) console.log('A build to test (--test-build): not to be published.');
  }
}
