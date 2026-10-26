// Packages AwwO 本地版 for the Mac app (apps/macos, AwwO Local.app): the runtime, its services and their own Node.js,
// PostgreSQL and API, as the app carries them in Contents/Resources/payload (docs/awwo-local-edition.md). Run on a Mac
// with Apple silicon, from a checkout set up with npm run setup:local (which unpacks EDB's macOS PostgreSQL):
//
//   node scripts/awwo-local-package-macos.mjs --out <folder>           assembles the payload in <folder>/payload
//   node scripts/awwo-local-package-macos.mjs --out <folder> --smoke   also starts its runtime on a scratch data folder
//
// Then apps/macos/build.ts builds the app around it (AWWO_MAC_LOCAL_PAYLOAD=<folder>/payload). The payload is laid out
// as the Windows installer's (scripts/awwo-local-package.mjs, whose parts this reuses): app/ the code, build/ the
// programs, licenses/ the notices. It holds no secret and no data folder; the app makes the person's at its first start
// (~/Library/Application Support/store.clawhunt.awwo.local/state).
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { localLayout, repoRoot } from './awwo-local-lib.mjs';
import { holdBuild } from './awwo-local.mjs';
import {
  checkGoNotices, collectNpmLicences, copy, copyNotices, installWorkerPackages, missingImports, PACKAGED_WORKERS, privateFiles, pruneLeftOut,
  pruneOtherPlatforms, prunePackages, replaceableOut, revision, RUNTIME_FILES, SHARED_WORKER_FILES, smokePayload, workerFilter,
} from './awwo-local-package.mjs';
import { linksBelow, machOFiles, machOProblems, unsignedMachO, withoutCode } from './awwo-macho.mjs';
import { MACOS_ARM64 } from './awwo-npm-licences.mjs';
import { POSTGRES_MACOS_LIBRARIES, postgresMacosLibraryGaps, postgresVersionOf } from './awwo-postgres-licences.mjs';
import { provenanceDifferences, sha256 } from './awwo-licence-files.mjs';

/** The manifest a payload carries (written first, as {"assembling":true}); a folder without it is not one to replace.
 *  The same name as the Windows payload's, of its own format. */
export const MANIFEST = 'awwo-local-payload.json';
export const MAC_MANIFEST_FORMAT = 1;

/** The modules of PostgreSQL's lib/postgresql the server itself loads (the Windows payload's SERVER_MODULES, as macOS
 *  names them): PL/pgSQL, Snowball's stemmers, the replication modules and the encoding conversions. */
export const MAC_SERVER_MODULES = /^(plpgsql|dict_snowball|libpqwalreceiver|pgoutput|euc2004_sjis2004|[a-z0-9]+(_[a-z0-9]+)*_and_[a-z0-9]+(_[a-z0-9]+)*)\.dylib$/;

/** What of EDB's macOS PostgreSQL (bin, lib, share, as setup unpacks it) the payload carries, by its path in the pgsql
 *  folder (bin/x): every program but contrib's two (oid2name, vacuumlo); of lib, the libraries the list names
 *  (POSTGRES_MACOS_LIBRARIES, with their links, copied as links: the programs load some through them) and the server's
 *  own modules in lib/postgresql; of share, PostgreSQL's data files without the extensions (but PL/pgSQL's, which
 *  every database has) and the manual pages. Nothing else of lib: no extension (contrib's and EDB's, among them the
 *  Perl, Python and Tcl languages, which load from EDB's language pack), no libpq-oauth (it needs a libcurl the archive
 *  does not have), no library nothing kept loads (libintl, libxslt, libuuid, libgssrpc, ecpg's), no pgxs, .a or .pc. */
export function macPostgresKept(relative, list = POSTGRES_MACOS_LIBRARIES) {
  const parts = relative.replaceAll('\\', '/').split('/').filter(Boolean);
  const name = parts.at(-1) || '';
  if (parts[0] === 'bin') return parts.length === 2 && !['oid2name', 'vacuumlo'].includes(name);
  if (parts[0] === 'lib') {
    if (parts.length === 2) return list.libraries.some(library => name in library.dylibs || name in (library.links || {}));
    return parts.length === 3 && parts[1] === 'postgresql' && MAC_SERVER_MODULES.test(name);
  }
  if (parts[0] === 'share') {
    if (parts[1] !== 'postgresql') return false;
    if (parts[2] === 'extension') return parts.length === 4 && /^plpgsql(\.control|--[^/]*\.sql)$/.test(name);
    return true;
  }
  return false;
}

/** The modules PostgreSQL's catalog files in share name ($libdir/<module>, lib/postgresql on macOS) that the payload
 *  does not hold: each would fail where the server comes to load it. */
export function macLibdirGaps(pgsql) {
  const named = new Set();
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(sql|bki)$/i.test(entry.name)) for (const match of readFileSync(full, 'utf8').matchAll(/\$libdir\/([A-Za-z0-9_]+)/g)) named.add(match[1]);
    }
  };
  walk(path.join(pgsql, 'share'));
  return [...named].filter(module => !existsSync(path.join(pgsql, 'lib', 'postgresql', `${module}.dylib`))).sort();
}

/** Copies what of a PostgreSQL folder the payload carries (macPostgresKept), its links as links. */
export function copyMacPostgres(from, to, keep = macPostgresKept) {
  const walk = relative => {
    for (const entry of readdirSync(path.join(from, relative), { withFileTypes: true })) {
      const next = relative ? path.join(relative, entry.name) : entry.name;
      const source = path.join(from, next);
      const target = path.join(to, next);
      const info = lstatSync(source);
      if (info.isDirectory()) { walk(next); continue; }
      if (!keep(next)) continue;
      mkdirSync(path.dirname(target), { recursive: true });
      if (info.isSymbolicLink()) symlinkSync(readlinkSync(source), target);
      else cpSync(source, target, { errorOnExist: true, force: false, preserveTimestamps: true });
    }
  };
  walk('');
}

/** Removes the node_modules/.bin folders below a worker's packages: a package's commands for a shell, which npm makes
 *  as links on macOS (as files on Windows), and which nothing in the payload runs. Returns how many went. */
export function pruneCommandLinks(dir) {
  let removed = 0;
  const walk = folder => {
    if (!existsSync(folder)) return;
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name);
      if (entry.name === '.bin' && path.basename(folder) === 'node_modules') {
        rmSync(full, { recursive: true, force: true });
        removed += 1;
      } else if (entry.isDirectory()) {
        walk(full);
      }
    }
  };
  walk(dir);
  return removed;
}

/** Node.js for the payload: bin/node and its licence, not npm, corepack, the headers or the manual. */
export const macNodeKept = relative => {
  const parts = relative.replaceAll('\\', '/').split('/').filter(Boolean);
  return (parts.length === 2 && parts[0] === 'bin' && parts[1] === 'node') || (parts.length === 1 && ['LICENSE', 'README.md', 'CHANGELOG.md'].includes(parts[0]));
};

/** The links the payload may hold: PostgreSQL's that the list names, in its lib folder, and nothing else. */
export function unexpectedLinks(out, list = POSTGRES_MACOS_LIBRARIES) {
  const allowed = new Map(list.libraries.flatMap(library => Object.entries(library.links || {})));
  const lib = path.join(out, 'build', 'pgsql', 'lib');
  return linksBelow(out).filter(({ file, target }) => path.dirname(file) !== lib || allowed.get(path.basename(file)) !== target)
    .map(({ file, target }) => `${path.relative(out, file).replaceAll('\\', '/')} -> ${target}`);
}

/** What collectMacPostgresLicences checks of a PostgreSQL folder: its lib folder's top level (each dylib with its
 *  SHA-256, each link with where it leads), and the version its own postgres names. */
export function inspectMacPostgres(pgsql, { version = () => {
  const result = spawnSync(path.join(pgsql, 'bin', 'postgres'), ['-V'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LC_MESSAGES: 'C' } });
  return postgresVersionOf(result.stdout);
} } = {}) {
  const lib = readdirSync(path.join(pgsql, 'lib')).filter(name => !lstatSync(path.join(pgsql, 'lib', name)).isDirectory()).map(name => {
    const file = path.join(pgsql, 'lib', name);
    return lstatSync(file).isSymbolicLink() ? { name, kind: 'symlink', target: readlinkSync(file) } : { name, kind: 'file', sha256: sha256(readFileSync(file)) };
  });
  return { lib, version: version() };
}

/** The licences of the libraries PostgreSQL's programs load (POSTGRES_MACOS_LIBRARIES), into pgsql/licenses/<name>-<version>/
 *  from third_party/postgres-macos, the LGPL one's source (libiconv's release, which setup:local downloads) into
 *  pgsql/sources/, and LIBRARIES.md: which dylib is which library under which licence. A PostgreSQL other than the list
 *  was made for, a dylib it does not name or of other bytes, a link it does not name (postgresMacosLibraryGaps), stops
 *  the packaging. */
export function collectMacPostgresLicences(layout, pgsql, { root = repoRoot, list = POSTGRES_MACOS_LIBRARIES, found = inspectMacPostgres(pgsql) } = {}) {
  const gaps = postgresMacosLibraryGaps(found, list);
  if (gaps.length) throw new Error(`PostgreSQL's libraries are not the ones listed (POSTGRES_MACOS_LIBRARIES in scripts/awwo-postgres-licences.mjs):\n${gaps.join('\n')}`);
  const curated = path.join(root, 'third_party', 'postgres-macos');
  // The licence files are as fetched (their SHA-256s in its PROVENANCE.json), as the Windows installer's are.
  const changed = provenanceDifferences(curated);
  if (changed.length) throw new Error(`third_party/postgres-macos is not as fetched (node scripts/awwo-postgres-licences.mjs --macos --check):\n${changed.join('\n')}`);
  const archiveOf = library => path.join(layout.build, 'downloads', library.source.name);
  // Every source is there, with its bytes, before anything is copied.
  for (const library of list.libraries.filter(item => item.source)) {
    const archive = archiveOf(library);
    if (!existsSync(archive) || sha256(readFileSync(archive)) !== library.source.sha256) throw new Error(`Missing ${archive}, the source of ${Object.keys(library.dylibs).join(', ')}: run npm run setup:local first`);
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
      files.push(`sources/${library.source.name}`);
    }
    const where = [...Object.keys(library.dylibs).map(dylib => `lib/${dylib}`), ...Object.keys(library.links || {}).map(link => `lib/${link} (a link)`), ...(library.builtInto || [])];
    rows.push(`| ${where.join(', ')} | ${library.name} ${library.version} | ${library.licence} | ${files.join(', ')} |`);
  }
  writeFileSync(path.join(pgsql, 'LIBRARIES.md'), `# The libraries PostgreSQL's programs here load

PostgreSQL ${found.version}, EDB's macOS binaries (universal: Intel and Apple silicon), with the server's own parts alone: its programs in bin/ (without contrib's oid2name and vacuumlo); of lib/ the libraries they load (and the links they load some of them through) and, in lib/postgresql/, the modules the server loads itself (PL/pgSQL, Snowball's stemmers, the replication modules, the encoding conversions); its data files in share/postgresql/, without the extensions and the manual pages. PostgreSQL's own licence is licenses/postgresql-18.4/COPYRIGHT, with code of others in its source under their own notices: licenses/postgresql-source-18/copyright (as Debian's postgresql-18 package lists them) and licenses/postgresql-source-18/NOTICES.txt (as the headers of the 18.4 source's own files have them). EDB's macOS archive carries no licence file: each library's own licence files, from its release of the version here, are in licenses/.

libiconv.2.dylib is under the GNU Lesser General Public License, version 2.1 or later (licenses/libiconv-1.19/COPYING.LIB). Its source code is in sources/: GNU's release of the version this library is (libiconv 1.19). PostgreSQL's programs load it, through libxml2, from lib/ when they start, so a build of it put in its place there is the one they load (the app's signature then no longer holds: macOS asks again before it opens the app).

| Files | Library | Licence | Licence files and source |
| --- | --- | --- | --- |
${rows.join('\n')}
`);
  return rows.length;
}

/** Signs (ad hoc) the payload's Mach-O files that carry no signature, then has codesign check every one: macOS runs
 *  no unsigned arm64 code, and the app's own signature seals them as they are. EDB's PostgreSQL, Node.js and the API
 *  come signed; some packages' builds do not. */
export function signPayload(out, { codesign = '/usr/bin/codesign', run = spawnSync } = {}) {
  const signed = [];
  for (const relative of unsignedMachO(out)) {
    const result = run(codesign, ['--force', '--sign', '-', path.join(out, relative)], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`codesign could not sign ${relative}: ${String(result.stderr).trim()}`);
    signed.push(relative);
  }
  const left = unsignedMachO(out);
  if (left.length) throw new Error(`Still unsigned after signing: ${left.join(', ')}`);
  const invalid = machOFiles(out).filter(item => run(codesign, ['--verify', '--strict', item.file], { encoding: 'utf8' }).status !== 0)
    .map(item => path.relative(out, item.file).replaceAll('\\', '/'));
  if (invalid.length) throw new Error(`These programs' signatures do not hold (codesign --verify --strict):\n${invalid.join('\n')}`);
  return signed;
}

/** Counts the payload. */
function countPayload(out) {
  let files = 0;
  let bytes = 0;
  const walk = dir => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      const info = lstatSync(full);
      if (info.isDirectory()) walk(full);
      else if (info.isFile()) { files += 1; bytes += info.size; }
    }
  };
  walk(out);
  return { files, bytes };
}

/** Assembles the Mac app's payload from this checkout and its build into out. */
export function assembleMacPayload({ layout = localLayout(), out, root = repoRoot }) {
  const pgsql = path.dirname(layout.pgBin);
  for (const need of [layout.api, layout.node, path.join(layout.pgBin, 'postgres'), path.join(layout.web, 'saas.html'), layout.brokerCore]) {
    if (!existsSync(need)) throw new Error(`Missing ${need}: run npm run setup:local first`);
  }
  if (!replaceableOut(out)) throw new Error(`Refusing to replace ${out}: it holds something other than a payload`);
  rmSync(out, { recursive: true, force: true });
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
    pruneOtherPlatforms(path.join(app, 'apps', worker, 'node_modules'), MACOS_ARM64);
    pruneLeftOut(path.join(app, 'apps', worker, 'node_modules'));
    pruneCommandLinks(path.join(app, 'apps', worker, 'node_modules'));
  }
  copy(path.dirname(layout.brokerCore), path.join(app, 'apps', 'openmaus-worker', '.runtime', 'core', 'dist-server'));
  copy(path.join(root, 'deploy', 'saas', 'workspace'), path.join(app, 'deploy', 'saas', 'workspace'), item => !path.basename(item).startsWith('.'));
  // Node.js: bin/node and its licence (its folder is node/ with bin/ in it, as localLayout finds it).
  const nodeHome = path.dirname(path.dirname(layout.node));
  for (const relative of ['bin/node', 'LICENSE', 'README.md', 'CHANGELOG.md']) {
    if (existsSync(path.join(nodeHome, relative)) && macNodeKept(relative)) copy(path.join(nodeHome, relative), path.join(build, 'node', relative));
  }
  copyMacPostgres(pgsql, path.join(build, 'pgsql'));
  const unloadable = macLibdirGaps(path.join(build, 'pgsql'));
  if (unloadable.length) throw new Error(`PostgreSQL's catalog names modules the payload leaves out (MAC_SERVER_MODULES): ${unloadable.join(', ')}`);
  copy(layout.api, path.join(build, path.basename(layout.api)));
  // AwwO's licence and notices with the Go modules' (checked against the API carried here), the workers' npm packages'
  // (as installed for this Mac), and PostgreSQL's libraries' with libiconv's source. The app's own program is Swift on
  // Apple's frameworks alone: it links no one else's code.
  copyNotices(layout, root, path.join(out, 'licenses'));
  checkGoNotices(layout, root);
  collectNpmLicences(out, path.join(out, 'licenses', 'npm'), { root, machine: MACOS_ARM64 });
  collectMacPostgresLicences(layout, path.join(build, 'pgsql'), { root });
  const missing = missingImports(out);
  if (missing.length) throw new Error(`The payload lacks what its scripts import:\n${missing.join('\n')}`);
  const secret = privateFiles(out);
  if (secret.length) throw new Error(`The payload holds private configuration it must not carry:\n${secret.join('\n')}`);
  const links = unexpectedLinks(out);
  if (links.length) throw new Error(`The payload holds links other than PostgreSQL's listed ones:\n${links.join('\n')}`);
  const programs = [path.join(build, 'node', 'bin', 'node'), path.join(build, path.basename(layout.api)),
    ...['postgres', 'initdb', 'pg_ctl', 'psql', 'createdb', 'pg_dump', 'pg_restore'].map(name => path.join(build, 'pgsql', 'bin', name))];
  const foreign = withoutCode(programs, 'arm64');
  if (foreign.length) throw new Error(`These programs have no code for Apple silicon:\n${foreign.join('\n')}`);
  const unloaded = machOProblems(out, { machine: 'arm64' });
  if (unloaded.length) throw new Error(`The payload's programs would not load on a Mac:\n${unloaded.join('\n')}`);
  const signed = signPayload(out);
  return { ...countPayload(out), signed };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('The Mac app\'s payload is built on a Mac with Apple silicon.');
  const args = process.argv.slice(2);
  const at = args.indexOf('--out');
  if (at < 0 || !args[at + 1]) throw new Error('--out <folder> is needed: the payload goes in <folder>/payload');
  const out = path.join(path.resolve(args[at + 1]), 'payload');
  // The code's and the build's locks, shared, as a runtime holds them: no setup:local replaces them while they are copied.
  const release = await holdBuild(localLayout()).catch(error => {
    throw new Error(`The payload is not assembled: ${error.message.replace('start it again', 'package it again')}`);
  });
  let counted;
  try { counted = assembleMacPayload({ out }); } finally { await release(); }
  const source = revision(repoRoot);
  writeFileSync(path.join(out, MANIFEST), `${JSON.stringify({ format: MAC_MANIFEST_FORMAT, system: 'macos-arm64', revision: source.head, dirty: source.dirty, packagedAt: new Date().toISOString(), ...counted }, null, 2)}\n`);
  console.log(`AwwO 本地版 payload for the Mac app in ${out}: ${counted.files} files, ${(counted.bytes / 1048576).toFixed(0)} MB${source.dirty ? ' (from a checkout with changes)' : ''}; signed here: ${counted.signed.length}`);
  if (args.includes('--smoke')) console.log('smoke:', JSON.stringify(await smokePayload(out)));
}
