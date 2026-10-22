// Tests for the Windows package of AwwO 本地版 (scripts/awwo-local-package.mjs): what the payload takes from a worker and
// from Node.js, and what it refuses to carry. Assembling, the smoke start and the installer are run by
// npm run package:local itself.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  MAX_RELATIVE_PATH, MAX_SOURCE_PATH, NODE_CONDITIONS, PE_X64, RUNTIME_FILES, SHARED_WORKER_FILES, SHELL_FILES, exportTargets, inspectPayload,
  missingImports, nodeFilter, nodeMayLoad, outsideSettingsRemoved, peImports, prepareBuild, privateFiles, privateName, prunePackages,
  pruneUnloadedBuilds, relativeImports, replaceableOut, unmetImports, unusedAtRunTime, vcRuntimeNeeded, workerFilter, chooseVcRuntime, postgresLeftOut,
  collectCrateLicences, forThisMachine, pruneOtherPlatforms, pruneLeftOut, goNoticeGaps, collectNpmLicences, collectPostgresLicences,
  MANIFEST_FORMAT, keptPayloadProblem, testInstallerName, libdirGaps, PACKAGED_WORKERS,
} from './awwo-local-package.mjs';
import { repoRoot } from './awwo-local-lib.mjs';
import { linkedCrates } from './awwo-crate-licences.mjs';
import { createHash } from 'node:crypto';

const scratch = () => mkdtempSync(path.join(os.tmpdir(), 'awwo-local-package-test-'));
const MIT_TEXT = 'Copyright (c) 2024 A\n\nPermission is hereby granted, free of charge, to any person obtaining a copy';
const put = (file, text) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};
/** Writes a folder of fetched licences' PROVENANCE.json for the files in it, as the fetching scripts do. */
const recordProvenance = folder => {
  const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');
  const entries = Object.fromEntries(readdirSync(folder, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => [entry.name, {
    files: Object.fromEntries(readdirSync(path.join(folder, entry.name)).map(name => [name, { url: `https://example.com/${name}`, sha256: sha(path.join(folder, entry.name, name)) }])),
  }]));
  writeFileSync(path.join(folder, 'PROVENANCE.json'), JSON.stringify(entries));
};

test('a worker brings its own files without its tests, and its packages only where its image installs them', () => {
  const source = path.join(os.tmpdir(), 'pi-worker');
  const at = (...parts) => path.join(source, ...parts);
  const withModules = workerFilter(source, { modules: true });
  for (const kept of [source, at('server.mjs'), at('runner.mjs'), at('README.md'), at('node_modules'), at('node_modules', 'pkg', 'index.js'), at('node_modules', 'pkg', 'x.test.js')]) {
    assert.equal(withModules(kept), true, kept);
  }
  for (const left of [at('server.test.mjs'), at('workspace-runtime.test.ts'), at('a.test.cjs'), at('.runtime'), at('.runtime', 'core', 'x.js'),
    at('.env'), at('.env.local'), at('.env.example'), at('.npmrc'), at('.gitignore'), at('src', '.cache', 'x.js')]) {
    assert.equal(withModules(left), false, left);
  }
  const withoutModules = workerFilter(source, { modules: false });
  assert.equal(withoutModules(at('node_modules')), false);
  assert.equal(withoutModules(at('node_modules', 'typescript', 'lib', 'tsc.js')), false);
  assert.equal(withoutModules(at('server.ts')), true);
});

test('Node.js comes without npm and corepack, which nothing of the runtime runs', () => {
  const source = path.join(os.tmpdir(), 'node');
  const keep = nodeFilter(source);
  for (const kept of ['node.exe', 'LICENSE', '.awwo-local-version', path.join('node_modules', 'other')]) assert.equal(keep(path.join(source, kept)), true, kept);
  for (const left of ['npm', 'npm.cmd', 'npx', 'npx.cmd', 'npx.ps1', 'corepack', 'corepack.cmd', path.join('node_modules', 'npm'), path.join('node_modules', 'npm', 'bin', 'npm-cli.js'), path.join('node_modules', 'corepack')]) {
    assert.equal(keep(path.join(source, left)), false, left);
  }
});

test('the payload is counted, and a path too long for Windows below a user folder is refused', () => {
  const out = scratch();
  mkdirSync(path.join(out, 'app', 'scripts'), { recursive: true });
  writeFileSync(path.join(out, 'app', 'scripts', 'awwo-local.mjs'), 'x'.repeat(10));
  writeFileSync(path.join(out, 'awwo-local-payload.json'), '{}');
  assert.deepEqual(inspectPayload(out), { files: 2, bytes: 12, longest: path.join('app', 'scripts', 'awwo-local.mjs').length });
  let deep = path.join(out, 'app');
  while (path.relative(out, deep).length <= MAX_RELATIVE_PATH) deep = path.join(deep, 'deeper-folder');
  mkdirSync(deep, { recursive: true });
  assert.throws(() => inspectPayload(out), /too long for the installer/);
});

test('a link in the payload is refused: an installer would carry it as a dangling path', t => {
  const out = scratch();
  writeFileSync(path.join(out, 'target.txt'), 'x');
  try { symlinkSync(path.join(out, 'target.txt'), path.join(out, 'link.txt')); } catch { t.skip('this account cannot make links'); return; }
  assert.throws(() => inspectPayload(out), /link would not survive/);
});

test('a folder is replaced only when it is empty or holds the manifest of a payload', () => {
  const empty = scratch();
  assert.equal(replaceableOut(empty), true);
  assert.equal(replaceableOut(path.join(empty, 'not-there')), true);
  const payload = scratch();
  writeFileSync(path.join(payload, 'awwo-local-payload.json'), '{}');
  assert.equal(replaceableOut(payload), true);
  const other = scratch();
  writeFileSync(path.join(other, 'thesis.docx'), 'x');
  assert.equal(replaceableOut(other), false, 'someone else\'s folder is never emptied');
});

test('a payload carries no private configuration of the checkout it was made from', () => {
  for (const name of ['.env', '.env.local', '.env.production', '.npmrc', 'server.pem', 'tls.key', 'id_rsa', 'id_ed25519.pub', 'store.pfx']) assert.equal(privateName(name), true, name);
  for (const name of ['env.ts', 'keys.js', 'key.ts', 'monkey.json', 'README.md', '.gitignore']) assert.equal(privateName(name), false, name);
  const out = scratch();
  for (const file of [['app', 'apps', 'pi-worker', '.env'], ['app', 'apps', 'pi-worker', 'server.mjs'], ['app', 'apps', 'pi-worker', 'node_modules', 'pkg', '.env']]) {
    mkdirSync(path.join(out, ...file.slice(0, -1)), { recursive: true });
    writeFileSync(path.join(out, ...file), 'x');
  }
  assert.deepEqual(privateFiles(out), [path.join('app', 'apps', 'pi-worker', '.env')]);
});

test('a build folder of its own gets the shell\'s sources and icons, and only one is used that is empty or an earlier build', () => {
  // Short names: the folders must stay shallow enough for the payload's paths below them.
  const repo = mkdtempSync(path.join(os.tmpdir(), 'awb-'));
  const shell = path.join(repo, 's');
  mkdirSync(path.join(repo, 'desktop', 'icons'), { recursive: true });
  writeFileSync(path.join(repo, 'desktop', 'icons', 'icon.ico'), 'ico');
  for (const name of SHELL_FILES) {
    const file = ['src', 'assets'].includes(name) ? path.join(shell, name, 'a.txt') : path.join(shell, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, name === 'tauri.conf.json' ? JSON.stringify({ productName: 'AwwO Local', bundle: { icon: ['../desktop/icons/icon.ico'], resources: { payload: 'payload' } } }) : name);
  }
  // In place, the shell itself: nothing is copied.
  assert.equal(prepareBuild(shell, shell), path.join(shell, 'payload'));
  const build = path.join(repo, 'build');
  assert.equal(prepareBuild(build, shell), path.join(build, 'payload'));
  assert.deepEqual(JSON.parse(readFileSync(path.join(build, 'tauri.conf.json'), 'utf8')).bundle, { icon: ['icons/icon.ico'], resources: { payload: 'payload' } });
  assert.equal(readFileSync(path.join(build, 'icons', 'icon.ico'), 'utf8'), 'ico');
  assert.equal(readFileSync(path.join(build, 'src', 'a.txt'), 'utf8'), 'src');
  // Again: a source the shell no longer has goes; the payload stays.
  writeFileSync(path.join(build, 'src', 'stale.rs'), 'x');
  mkdirSync(path.join(build, 'payload'));
  writeFileSync(path.join(build, 'payload', 'awwo-local-payload.json'), '{}');
  prepareBuild(build, shell);
  assert.equal(existsSync(path.join(build, 'src', 'stale.rs')), false);
  assert.equal(existsSync(path.join(build, 'payload', 'awwo-local-payload.json')), true);
  const other = scratch();
  writeFileSync(path.join(other, 'thesis.docx'), 'x');
  assert.throws(() => prepareBuild(other, shell), /something other than an AwwO Local build/);
  // makensis reads each file by its full path: a folder too deep for the payload's longest paths is refused.
  const deep = path.join(repo, 'd'.repeat(MAX_SOURCE_PATH - MAX_RELATIVE_PATH - repo.length));
  assert.throws(() => prepareBuild(deep, shell), /too deep for makensis/);
});

test('a worker\'s packages lose only what Node.js never loads: type declarations and source maps', () => {
  const dir = scratch();
  const at = (...parts) => path.join(dir, ...parts);
  for (const file of [['pkg', 'index.js'], ['pkg', 'index.d.ts'], ['pkg', 'index.d.mts'], ['pkg', 'index.js.map'], ['pkg', 'LICENSE'], ['pkg', 'dist-types', 'deep', 'a.d.ts'], ['pkg', 'lib', 'types.js']]) {
    mkdirSync(path.dirname(at(...file)), { recursive: true });
    writeFileSync(at(...file), 'x');
  }
  assert.equal(prunePackages(dir), 4);
  assert.deepEqual(readdirSync(at('pkg')).sort(), ['LICENSE', 'index.js', 'lib']);
  assert.deepEqual(readdirSync(at('pkg', 'lib')), ['types.js']);
  assert.equal(unusedAtRunTime('types', true), false);
  assert.equal(unusedAtRunTime('index.mjs', false), false);
});

// @smithy/core's exports, shortened: "node" comes before "import", so Node.js loads dist-cjs for import too.
const SMITHY = {
  name: '@smithy/core',
  main: './dist-cjs/index.js',
  module: './dist-es/index.js',
  exports: {
    '.': { types: './dist-types/index.d.ts', module: './dist-es/index.js', node: './dist-cjs/index.js', import: './dist-es/index.js', require: './dist-cjs/index.js' },
    './package.json': { module: './package.json', node: './package.json', import: './package.json', require: './package.json' },
    './serde': { browser: { import: './dist-es/serde.browser.js' }, module: './dist-es/serde.js', node: './dist-cjs/serde.js', import: './dist-es/serde.js' },
  },
};

test('exports resolve as Node.js resolves them: the first condition that matches, in the order the package wrote them', () => {
  const [forImport, forRequire] = NODE_CONDITIONS;
  assert.deepEqual(exportTargets(SMITHY.exports['.'], forImport), ['./dist-cjs/index.js']);
  assert.deepEqual(exportTargets(SMITHY.exports['.'], forRequire), ['./dist-cjs/index.js']);
  assert.deepEqual(exportTargets({ import: './esm.js', require: './cjs.js' }, forImport), ['./esm.js']);
  assert.deepEqual(exportTargets({ browser: './b.js' }, forImport), undefined);
  // A condition whose value matches nothing passes to the next key, as in Node.js.
  assert.deepEqual(exportTargets({ node: { browser: './b.js' }, default: './d.js' }, forRequire), ['./d.js']);
  assert.deepEqual(exportTargets({ node: null, default: './d.js' }, forRequire), []);
  assert.deepEqual(exportTargets(['./a.js', { require: './b.js' }], forRequire), ['./a.js', './b.js']);
  assert.equal(nodeMayLoad(SMITHY, 'dist-es'), false);
  assert.equal(nodeMayLoad(SMITHY, 'dist-cjs'), true);
  assert.equal(nodeMayLoad({ main: './dist-cjs/index.js', module: './dist-es/index.js' }, 'dist-es'), true, 'without exports, any file can be loaded by path');
  assert.equal(nodeMayLoad({ exports: { import: './dist-es/index.js', require: './dist-cjs/index.js' } }, 'dist-es'), true);
  assert.equal(nodeMayLoad({ exports: { './*': { node: './dist-es/*.js' } } }, 'dist-es'), true);
  assert.equal(nodeMayLoad({ exports: { '.': './dist-cjs/index.js' }, imports: { '#x': { import: './dist-es/x.js' } } }, 'dist-es'), true);
  assert.equal(nodeMayLoad({ exports: { '.': './dist-cjs/index.js' }, main: './dist-es/index.js' }, 'dist-es'), true);
  assert.equal(nodeMayLoad({ exports: { '.': './dist-cjs/index.js' }, bin: { tool: './dist-es/bin.js' } }, 'dist-es'), true);
  assert.equal(nodeMayLoad({ exports: { '.': './lib/../dist-es/index.js' } }, 'dist-es'), true);
  // A pattern whose first segment is the wildcard may stand for the folder; exports of null are none.
  assert.equal(nodeMayLoad({ exports: { './*': './*' } }, 'dist-es'), true);
  assert.equal(nodeMayLoad({ exports: null, main: './dist-cjs/index.js' }, 'dist-es'), true);
});

test('a too-long dist-es goes only where Node.js never loads it; any other long path stays to be refused', () => {
  const out = scratch();
  const make = (root, manifest, files) => {
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'package.json'), JSON.stringify(manifest));
    for (const [file, text] of files) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), text);
    }
  };
  const deep = ['dist-es', ...Array(12).fill('submodules'), 'NodeUseDualstackEndpointConfigOptions.js'].join(path.sep);
  const modules = path.join(out, 'app', 'apps', 'pi-worker', 'node_modules');
  const unused = path.join(modules, '@smithy', 'core');
  make(unused, SMITHY, [[deep, 'export {}'], [path.join('dist-cjs', 'index.js'), 'module.exports = {};']]);
  const named = path.join(modules, 'named');
  make(named, { name: 'named', exports: { '.': { node: './dist-cjs/index.js' } } }, [[deep, 'export {}'], [path.join('dist-cjs', 'index.js'), 'module.exports = require("../dist-es/x.js");']]);
  const loaded = path.join(modules, 'loaded');
  make(loaded, { name: 'loaded', exports: { import: './dist-es/index.js', require: './dist-cjs/index.js' } }, [[deep, 'export {}']]);
  const short = path.join(modules, 'short');
  make(short, SMITHY, [[path.join('dist-es', 'index.js'), 'export {}']]);
  assert.deepEqual(pruneUnloadedBuilds(out), [unused]);
  assert.equal(existsSync(path.join(unused, 'dist-es')), false);
  assert.equal(existsSync(path.join(unused, 'dist-cjs', 'index.js')), true);
  for (const kept of [named, loaded, short]) assert.equal(existsSync(path.join(kept, 'dist-es')), true, kept);
  assert.throws(() => inspectPayload(out), /too long for the installer/);
});

/** A minimal PE32+ file: one section holding an import table and a delay-load table naming the given DLLs. */
function fakePe(file, { machine = PE_X64, linker = [14, 44], imports = [], delayed = [] }) {
  const data = Buffer.alloc(0x400);
  data.write('MZ', 0, 'latin1');
  data.writeUInt32LE(0x40, 0x3c);
  data.write('PE\0\0', 0x40, 'latin1');
  data.writeUInt16LE(machine, 0x44);
  data.writeUInt16LE(1, 0x46);
  data.writeUInt16LE(240, 0x54);
  const optional = 0x58;
  data.writeUInt16LE(0x20b, optional);
  data.writeUInt8(linker[0], optional + 2);
  data.writeUInt8(linker[1], optional + 3);
  data.writeUInt32LE(16, optional + 108);
  data.writeUInt32LE(0x1000, optional + 112 + 8);
  data.writeUInt32LE(0x1080, optional + 112 + 13 * 8);
  const section = optional + 240;
  data.write('.idata', section, 'latin1');
  data.writeUInt32LE(0x200, section + 8);
  data.writeUInt32LE(0x1000, section + 12);
  data.writeUInt32LE(0x200, section + 16);
  data.writeUInt32LE(0x200, section + 20);
  let name = 0x1100;
  const named = text => { const at = name; data.write(`${text}\0`, 0x200 + (at - 0x1000), 'latin1'); name += text.length + 1; return at; };
  imports.forEach((dll, index) => data.writeUInt32LE(named(dll), 0x200 + index * 20 + 12));
  delayed.forEach((dll, index) => data.writeUInt32LE(named(dll), 0x200 + 0x80 + index * 32 + 4));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, data);
}

test('a program\'s imports are read from its headers, and the payload refuses one a fresh Windows could not load', () => {
  const out = scratch();
  const at = (...parts) => path.join(out, ...parts);
  const system = scratch();
  for (const name of ['kernel32.dll', 'vcruntime140.dll']) writeFileSync(path.join(system, name), 'x');
  fakePe(at('build', 'pgsql', 'bin', 'postgres.exe'), { imports: ['KERNEL32.dll', 'VCRUNTIME140.dll', 'libpq.dll', 'api-ms-win-crt-heap-l1-1-0.dll'], delayed: ['icuuc77.dll'] });
  assert.deepEqual(peImports(at('build', 'pgsql', 'bin', 'postgres.exe')), { machine: PE_X64, linker: [14, 44], imports: ['kernel32.dll', 'vcruntime140.dll', 'libpq.dll', 'api-ms-win-crt-heap-l1-1-0.dll', 'icuuc77.dll'] });
  fakePe(at('build', 'pgsql', 'lib', 'plpgsql.dll'), { imports: ['postgres.exe', 'msvcp140.dll'] });
  fakePe(at('app', 'apps', 'pi-worker', 'node_modules', 'clip', 'clip.win32-x64.node'), { imports: ['kernel32.dll', 'node.exe', 'zlib.dll'] });
  fakePe(at('app', 'apps', 'pi-worker', 'node_modules', 'clip', 'clip.win32-arm64.node'), { machine: 0xaa64, imports: ['vcruntime140.dll'] });
  writeFileSync(at('build', 'pgsql', 'bin', 'libpq.dll'), 'not a program');
  fakePe(at('build', 'node', 'node.exe'), { imports: ['kernel32.dll'] });
  writeFileSync(at('app', 'apps', 'pi-worker', 'node_modules', 'clip', 'zlib.dll'), 'x');
  assert.equal(peImports(at('build', 'pgsql', 'bin', 'libpq.dll')), null);
  // The VC++ runtime in System32 does not count (something installed it there); icuuc77 is missing; postgres.exe is
  // found for a library of PostgreSQL's beside its programs; an arm64 addon is never loaded here.
  assert.deepEqual(unmetImports(out, system).sort(), [
    `${path.join('build', 'pgsql', 'bin', 'postgres.exe')} imports icuuc77.dll`,
    `${path.join('build', 'pgsql', 'bin', 'postgres.exe')} imports vcruntime140.dll`,
    `${path.join('build', 'pgsql', 'lib', 'plpgsql.dll')} imports msvcp140.dll`,
  ]);
  for (const name of ['vcruntime140.dll', 'msvcp140.dll', 'icuuc77.dll']) writeFileSync(at('build', 'pgsql', 'bin', name), 'x');
  assert.deepEqual(unmetImports(out, system), []);
});

test('PostgreSQL comes with its server\'s own modules alone: no extension, no procedural language of another program', () => {
  // Every extension and procedural language other than PL/pgSQL: contrib's and EDB's modules, control and SQL files.
  for (const name of ['lib/plperl.dll', 'lib/plpython3.dll', 'lib/pltcl.dll', 'lib/hstore_plpython3.dll', 'lib/fuzzystrmatch.dll', 'lib/pgcrypto.dll', 'lib/uuid-ossp.dll',
    'lib/plugin_debugger.dll', 'lib/system_stats.dll', 'lib/pg_trgm.dll', 'lib/hstore.dll', 'share/extension/plperlu.control', 'share/extension/fuzzystrmatch--1.2.sql',
    'share/extension/pg_trgm.control', 'share/extension/uuid-ossp--1.1.sql', 'share/extension/pldbgapi.control']) {
    assert.equal(postgresLeftOut(name), true, name);
  }
  // Nor EDB's StackBuilder, the libraries only it loads, ICU's test plugin, contrib's programs, the translations, or
  // what extensions are built with.
  for (const name of ['bin/stackbuilder.exe', 'bin/wxbase3210u_vc_x64_custom.dll', 'bin/wxmsw3210u_core_vc_x64_custom.dll', 'bin/libcurl.dll', 'bin/testplug.dll',
    'bin/oid2name.exe', 'bin/vacuumlo.exe', 'share/locale/it/LC_MESSAGES/initdb-18.mo', 'share/locale', 'lib/postgres.lib', 'lib/libpq.a', 'lib/pgxs/src/Makefile.global', 'lib\\pgxs\\config\\install-sh']) {
    assert.equal(postgresLeftOut(name), true, name);
  }
  // The server's own: PL/pgSQL, Snowball's stemmers, the encoding conversions, replication's modules, the event log's
  // messages; the programs and their libraries; the data files.
  for (const name of ['lib/plpgsql.dll', 'lib/dict_snowball.dll', 'lib/utf8_and_iso8859_1.dll', 'lib/euc_jp_and_sjis.dll', 'lib/euc2004_sjis2004.dll', 'lib/latin2_and_win1250.dll', 'lib/libpqwalreceiver.dll',
    'lib/pgoutput.dll', 'lib/pgevent.dll', 'share/extension/plpgsql.control', 'share/extension/plpgsql--1.0.sql', 'share/tsearch_data/english.stop', 'share/snowball_create.sql',
    'bin/postgres.exe', 'bin/libpq.dll', 'bin/libssl-3-x64.dll', 'bin/icuuc77.dll', 'bin/zlib1.dll', 'lib', 'share/extension', 'server_license.txt']) {
    assert.equal(postgresLeftOut(name), false, name);
  }
  // Every module the catalog's files name must be there.
  const pgsql = scratch();
  put(path.join(pgsql, 'share', 'postgres.bki'), "insert ( 4402 euc2004_sjis2004 '$libdir/euc2004_sjis2004' )\n");
  put(path.join(pgsql, 'share', 'snowball_create.sql'), "CREATE FUNCTION dsnowball_init(INTERNAL) AS '$libdir/dict_snowball' LANGUAGE C;\n");
  put(path.join(pgsql, 'lib', 'dict_snowball.dll'), 'x');
  assert.deepEqual(libdirGaps(pgsql), ['euc2004_sjis2004']);
  put(path.join(pgsql, 'lib', 'euc2004_sjis2004.dll'), 'x');
  assert.deepEqual(libdirGaps(pgsql), []);
});

test('the VC++ runtime carried must be as new as the newest linker of what imports it', () => {
  const out = scratch();
  fakePe(path.join(out, 'build', 'pgsql', 'bin', 'postgres.exe'), { linker: [14, 44], imports: ['vcruntime140.dll'] });
  fakePe(path.join(out, 'build', 'pgsql', 'bin', 'icuuc77.dll'), { linker: [14, 38], imports: ['msvcp140.dll'] });
  fakePe(path.join(out, 'build', 'awwo-api.exe'), { linker: [14, 50], imports: ['kernel32.dll'] });
  fakePe(path.join(out, 'app', 'x.win32-arm64.node'), { machine: 0xaa64, linker: [14, 60], imports: ['vcruntime140.dll'] });
  // The Go API imports none of it, and an arm64 addon is never loaded here: 14.44 is what the runtime must match.
  assert.deepEqual(vcRuntimeNeeded(out), [14, 44]);
});

test('Visual Studio\'s redistributable is carried when it is new enough; System32\'s only by a build to test', () => {
  const vs42 = { folder: 'VS\\14.42', version: [14, 42, 34438, 0], visualStudio: true };
  const vs44 = { folder: 'VS\\14.44', version: [14, 44, 35211, 0], visualStudio: true };
  const system = { folder: 'System32', version: [14, 50, 35719, 0], visualStudio: false };
  assert.equal(chooseVcRuntime([system, vs44, vs42], [14, 44]), vs44);
  assert.equal(chooseVcRuntime([vs44, vs42], [14, 42]), vs44);
  assert.throws(() => chooseVcRuntime([system, vs42], [14, 44]), /a build to publish carries Visual Studio's.*--test-build/);
  assert.equal(chooseVcRuntime([system, vs42], [14, 44], { allowSystem: true }), system);
  assert.equal(chooseVcRuntime([system, vs44], [14, 44], { allowSystem: true }), vs44, 'Visual Studio\'s first, even for a test');
  assert.throws(() => chooseVcRuntime([vs42], [14, 44], { allowSystem: true }), /as new as the tools that built PostgreSQL \(14\.44/);
  assert.throws(() => chooseVcRuntime([], [14, 44]), /found none/);
});

test('the Go modules\' notices must be of the API\'s toolchain and name every module it links, of theirs any', () => {
  // As modules.txt has them: the toolchain's line, then a module with its version and sum a line.
  const listed = ['go go1.27.1', 'github.com/a/b v1.0.0 h1:x=', 'github.com/prometheus/procfs v0.17.0 h1:y='];
  assert.deepEqual(goNoticeGaps(['go go1.27.1', 'github.com/a/b v1.0.0 h1:x='], listed), [], 'one fewer, as the Windows build links');
  assert.deepEqual(goNoticeGaps(['go go1.27.2', 'github.com/a/b v1.0.0 h1:x='], listed), ['the API was built with go go1.27.2, the notices are for go go1.27.1 (build with GOTOOLCHAIN=go1.27.1)']);
  assert.deepEqual(goNoticeGaps(['go go1.27.1', 'github.com/a/b v1.1.0 h1:z='], listed), ['github.com/a/b v1.1.0 h1:z=: not in the notices']);
});

test('the window\'s program carries the licences of the crates it links, from their packages or their repositories', () => {
  const registry = scratch();
  const crate = (name, version, { license, files = [], repository } = {}) => {
    const dir = path.join(registry, `${name}-${version}`);
    mkdirSync(dir, { recursive: true });
    for (const [file, text] of files) writeFileSync(path.join(dir, file), text);
    writeFileSync(path.join(dir, 'Cargo.toml'), '');
    return { id: `${name} ${version}`, name, version, license, repository, license_file: null, manifest_path: path.join(dir, 'Cargo.toml') };
  };
  const packages = [
    crate('awwo_local', '0.1.0', {}),
    crate('shipped', '1.0.0', { license: 'MIT OR Apache-2.0', files: [['LICENSE-MIT', 'mit of shipped'], ['LICENSE-APACHE', 'apache of shipped'], ['README.md', 'x']] }),
    crate('fetched', '2.0.0', { license: 'MIT', repository: 'https://github.com/a/fetched' }),
    crate('mpl-shipped', '1.0.0', { license: 'MPL-2.0', files: [['LICENSE', 'Mozilla Public License Version 2.0\n==']] }),
    crate('mpl-bare', '3.0.0', { license: 'MPL-2.0', repository: 'https://example.com/mpl' }),
    crate('build-only', '1.0.0', { license: 'BSD-2-Clause' }),
  ];
  const id = name => packages.find(item => item.name === name).id;
  const normal = name => ({ pkg: id(name), dep_kinds: [{ kind: null, target: null }] });
  const metadata = {
    packages,
    resolve: {
      root: id('awwo_local'),
      nodes: [
        { id: id('awwo_local'), deps: [normal('shipped'), normal('fetched'), { pkg: id('build-only'), dep_kinds: [{ kind: 'build', target: null }] }] },
        { id: id('shipped'), deps: [normal('mpl-shipped'), normal('mpl-bare')] },
      ],
    },
  };
  assert.deepEqual(linkedCrates(metadata).map(item => item.name).sort(), ['fetched', 'mpl-bare', 'mpl-shipped', 'shipped']);
  // The repository's licence, fetched for a crate whose package ships none (third_party/rust-crates), and Rust's own.
  const root = scratch();
  mkdirSync(path.join(root, 'third_party', 'rust-crates', 'fetched-2.0.0'), { recursive: true });
  writeFileSync(path.join(root, 'third_party', 'rust-crates', 'fetched-2.0.0', 'LICENSE'), 'MIT License\n\nCopyright (c) 2021 A');
  recordProvenance(path.join(root, 'third_party', 'rust-crates'));
  const sysroot = scratch();
  mkdirSync(path.join(sysroot, 'share', 'doc', 'rust', 'licenses'), { recursive: true });
  writeFileSync(path.join(sysroot, 'share', 'doc', 'rust', 'COPYRIGHT-library.html'), 'std');
  writeFileSync(path.join(sysroot, 'share', 'doc', 'rust', 'licenses', 'MIT.txt'), 'mit');
  const target = scratch();
  assert.equal(collectCrateLicences('unused', target, { metadata, root, sysroot }), 4);
  const read = (...parts) => readFileSync(path.join(target, ...parts), 'utf8');
  assert.equal(read('crates', 'shipped-1.0.0', 'LICENSE-APACHE'), 'apache of shipped');
  assert.equal(existsSync(path.join(target, 'crates', 'shipped-1.0.0', 'README.md')), false);
  assert.match(read('crates', 'fetched-2.0.0', 'LICENSE'), /Copyright \(c\) 2021 A/);
  // Every MPL crate says where its source is; one without MPL's text gets another MPL crate's copy.
  assert.match(read('crates', 'mpl-shipped-1.0.0', 'SOURCE.txt'), /https:\/\/crates\.io\/crates\/mpl-shipped\/1\.0\.0/);
  assert.match(read('crates', 'mpl-bare-3.0.0', 'LICENSE'), /^Mozilla Public License Version 2\.0/);
  assert.match(read('crates', 'mpl-bare-3.0.0', 'SOURCE.txt'), /https:\/\/crates\.io\/crates\/mpl-bare\/3\.0\.0 \(https:\/\/example\.com\/mpl\)/);
  assert.equal(existsSync(path.join(target, 'crates', 'build-only-1.0.0')), false, 'a build script\'s crate is not in the program');
  assert.equal(read('rust', 'COPYRIGHT-library.html'), 'std');
  assert.equal(read('rust', 'licenses', 'MIT.txt'), 'mit');
  assert.match(read('CRATES.md'), /\| fetched \| 2\.0\.0 \| MIT \| LICENSE \|/);
  // No licence file anywhere: the packaging stops, and makes no text up.
  metadata.resolve.nodes[0].deps.push(normal('build-only'));
  assert.throws(() => collectCrateLicences('unused', scratch(), { metadata, root, sysroot }), /build-only-1\.0\.0 \(BSD-2-Clause\)/);
});


test('the workers\' npm packages carry their licences: their own, their repository\'s, or a README carrying it', () => {
  const out = scratch();
  const modules = path.join(out, 'app', 'apps', 'pi-worker', 'node_modules');
  const pkg = (where, manifest, files = []) => {
    put(path.join(modules, ...where, 'package.json'), JSON.stringify(manifest));
    for (const [file, text] of files) put(path.join(modules, ...where, file), text);
  };
  pkg(['own'], { name: 'own', version: '1.0.0', license: 'MIT' }, [['LICENSE', MIT_TEXT]]);
  pkg(['@aws-sdk', 'nested'], { name: '@aws-sdk/nested', version: '3.0.0', license: 'Apache-2.0' });
  pkg(['readme'], { name: 'readme', version: '4.0.1', license: 'MIT' }, [['README.md', `## License\n\n${MIT_TEXT}`]]);
  const root = scratch();
  put(path.join(root, 'third_party', 'npm-packages', '@aws-sdk+nested@3.0.0', 'LICENSE'), 'Apache License\nVersion 2.0, January 2004');
  recordProvenance(path.join(root, 'third_party', 'npm-packages'));
  const target = path.join(out, 'licenses', 'npm');
  assert.equal(collectNpmLicences(out, target, { root }), 3);
  const listing = readFileSync(path.join(target, 'NPM.md'), 'utf8');
  assert.match(listing, /\| own \| 1\.0\.0 \| MIT \| app\/apps\/pi-worker\/node_modules\/own\/LICENSE \|/);
  assert.match(listing, /\| @aws-sdk\/nested \| 3\.0\.0 \| Apache-2\.0 \| licenses\/npm\/@aws-sdk\+nested@3\.0\.0\/LICENSE \|/);
  assert.match(listing, /\| readme \| 4\.0\.1 \| MIT \| licenses\/npm\/readme@4\.0\.1\/README\.md \|/);
  assert.equal(existsSync(path.join(target, 'PROVENANCE.json')), true);
  // A package with no licence anywhere, or under one that is not permissive, stops the packaging.
  pkg(['bare'], { name: 'bare', version: '0.1.0', license: 'MIT' }, [['README.md', 'MIT']]);
  pkg(['copyleft'], { name: 'copyleft', version: '2.0.0', license: 'GPL-3.0' }, [['LICENSE', 'GNU GENERAL PUBLIC LICENSE']]);
  assert.throws(() => collectNpmLicences(out, path.join(out, 'licenses', 'npm2'), { root }), error => /bare@0\.1\.0: no licence file/.test(error.message) && /copyleft@2\.0\.0: under GPL-3\.0/.test(error.message));
  // A fetched file changed since it was fetched is not carried.
  put(path.join(root, 'third_party', 'npm-packages', '@aws-sdk+nested@3.0.0', 'LICENSE'), 'edited');
  assert.throws(() => collectNpmLicences(out, path.join(out, 'licenses', 'npm3'), { root }), /not as fetched[\s\S]*LICENSE: other bytes than fetched/);
});

test('the coding agent\'s clipboard, which no worker uses, is left out with its builds for each machine', () => {
  const modules = scratch();
  for (const [where, name] of [[['agent'], 'agent'], [['agent', 'node_modules', '@mariozechner', 'clipboard'], '@mariozechner/clipboard'],
    [['agent', 'node_modules', '@mariozechner', 'clipboard-win32-x64-msvc'], '@mariozechner/clipboard-win32-x64-msvc'], [['@mariozechner', 'other'], '@mariozechner/other']]) {
    put(path.join(modules, ...where, 'package.json'), JSON.stringify({ name }));
  }
  assert.deepEqual(pruneLeftOut(modules).map(item => item.replaceAll('\\', '/')).sort(), ['@mariozechner/clipboard', '@mariozechner/clipboard-win32-x64-msvc']);
  assert.equal(existsSync(path.join(modules, '@mariozechner', 'other')), true);
});

test('PostgreSQL\'s libraries carry their own licences and the LGPL ones their source, as listed', () => {
  const source = Buffer.from('gettext source');
  const sha = text => createHash('sha256').update(text).digest('hex');
  const list = {
    postgres: '18.4',
    libraries: [
      { name: 'zlib', version: '1.3.2', licence: 'Zlib', dlls: { 'zlib1.dll': sha('zlib') }, builtInto: ['lib/pgcrypto.dll'], files: { LICENSE: 'https://example.com/LICENSE' } },
      { name: 'gettext', version: '0.19.8', licence: 'LGPL-2.1-or-later', dlls: { 'libintl-9.dll': sha('intl') }, files: {},
        source: { name: 'gettext-0.19.8.tar.xz', url: 'https://example.com/g.tar.xz', sha256: sha(source) } },
    ],
  };
  const pgsql = path.join(scratch(), 'pgsql');
  const found = { version: '18.4', lib: [{ name: 'pgcrypto.dll', company: 'PostgreSQL Global Development Group' }],
    bin: [{ name: 'zlib1.dll', sha256: sha('zlib') }, { name: 'libintl-9.dll', sha256: sha('intl') }, { name: 'libpq.dll', sha256: 'x' }, { name: 'postgres.exe', sha256: null }] };
  const root = scratch();
  put(path.join(root, 'third_party', 'postgres-windows', 'zlib-1.3.2', 'LICENSE'), 'zlib licence');
  recordProvenance(path.join(root, 'third_party', 'postgres-windows'));
  const layout = { build: scratch() };
  assert.throws(() => collectPostgresLicences(layout, pgsql, { root, list, found }), /Missing .*gettext-0\.19\.8\.tar\.xz, the source of libintl-9\.dll: run npm run setup:local first/);
  put(path.join(layout.build, 'downloads', 'gettext-0.19.8.tar.xz'), 'other bytes');
  assert.throws(() => collectPostgresLicences(layout, pgsql, { root, list, found }), /Missing .*gettext-0\.19\.8\.tar\.xz/, 'a source of other bytes is no source');
  assert.equal(existsSync(path.join(pgsql, 'licenses')), false, 'nothing is copied before the sources are found');
  put(path.join(layout.build, 'downloads', 'gettext-0.19.8.tar.xz'), source);
  const system = { visualStudio: false, version: [14, 50, 35719, 0] };
  assert.equal(collectPostgresLicences(layout, pgsql, { root, list, found, vcRuntime: system }), 2);
  assert.equal(readFileSync(path.join(pgsql, 'licenses', 'zlib-1.3.2', 'LICENSE'), 'utf8'), 'zlib licence');
  assert.equal(readFileSync(path.join(pgsql, 'sources', 'gettext-0.19.8.tar.xz'), 'utf8'), 'gettext source');
  const listing = readFileSync(path.join(pgsql, 'LIBRARIES.md'), 'utf8');
  assert.match(listing, /\| bin\/libintl-9\.dll \| gettext 0\.19\.8 \| LGPL-2\.1-or-later \| commandlinetools_3rd_party_licenses\.txt \(the LGPL's text\), sources\/gettext-0\.19\.8\.tar\.xz \|/);
  assert.match(listing, /\| bin\/zlib1\.dll, built into lib\/pgcrypto\.dll \| zlib 1\.3\.2 \| Zlib \| licenses\/zlib-1\.3\.2\/LICENSE \|/);
  // Where its VC++ runtime came from, as it did: a build to test's from System32 says so.
  assert.match(listing, /14\.50\.35719\.0, was copied from this build machine's System32: this is a build to test, not to be published/);
  const published = path.join(scratch(), 'pgsql');
  collectPostgresLicences(layout, published, { root, list, found, vcRuntime: { visualStudio: true, version: [14, 44, 35211, 0] } });
  assert.match(readFileSync(path.join(published, 'LIBRARIES.md'), 'utf8'), /14\.44\.35211\.0, is Microsoft's redistributable, from Visual Studio's redistributable folder/);
  // A fetched licence changed since it was fetched stops it.
  put(path.join(root, 'third_party', 'postgres-windows', 'zlib-1.3.2', 'LICENSE'), 'edited');
  assert.throws(() => collectPostgresLicences(layout, path.join(scratch(), 'pgsql'), { root, list, found }), /third_party\/postgres-windows is not as fetched/);
  put(path.join(root, 'third_party', 'postgres-windows', 'zlib-1.3.2', 'LICENSE'), 'zlib licence');
  // Another build of a listed DLL stops it before anything is copied.
  assert.throws(() => collectPostgresLicences(layout, path.join(scratch(), 'pgsql'), { root, list, found: { ...found, bin: [...found.bin.slice(1), { name: 'zlib1.dll', sha256: sha('other zlib') }] } }), /zlib1\.dll is not the build listed/);
});

test('an earlier payload is built into an installer only when this packager made it, from this checkout as it is, for this kind of build', () => {
  const made = { format: MANIFEST_FORMAT, revision: 'abc', dirty: false, version: '0.1.0', testBuild: false };
  const here = { version: '0.1.0', testBuild: false, source: { head: 'abc', dirty: false } };
  assert.equal(keptPayloadProblem(made, here), null);
  assert.equal(keptPayloadProblem({ ...made, testBuild: true }, { ...here, testBuild: true }), null);
  assert.match(keptPayloadProblem({ ...made, testBuild: true }, here), /a build to test/);
  assert.match(keptPayloadProblem({ revision: 'abc', version: '0.1.0', vcRuntime: {} }, here), /an earlier packager/);
  assert.match(keptPayloadProblem({ ...made, format: 2 }, { ...here, testBuild: true }), /an earlier packager/);
  assert.match(keptPayloadProblem({ ...made, version: '0.0.9' }, here), /made for 0\.0\.9/);
  assert.match(keptPayloadProblem({ assembling: true }, here), /not complete/);
  // Another commit, or changes in the checkout then or now: the payload may carry less than this packager would.
  assert.match(keptPayloadProblem({ ...made, revision: 'old' }, here), /made from old, not this checkout as it is \(abc\)/);
  assert.match(keptPayloadProblem({ ...made, dirty: true }, here), /with changes/);
  assert.match(keptPayloadProblem(made, { ...here, source: { head: 'abc', dirty: true } }), /abc with changes/);
  // A build to test's installer is named apart from the one to publish.
  assert.equal(testInstallerName('D:\\t\\AwwO Local_0.1.0_x64-setup.exe'), 'D:\\t\\AwwO Local_0.1.0_x64-setup-TEST.exe');
});

test('a worker\'s packages built for another system or machine are left out, as npm leaves such an optional one out', () => {
  assert.equal(forThisMachine({}), true);
  assert.equal(forThisMachine({ os: ['win32'], cpu: ['x64'] }), true);
  assert.equal(forThisMachine({ os: ['darwin'] }), false);
  assert.equal(forThisMachine({ os: ['win32'], cpu: ['arm64'] }), false);
  assert.equal(forThisMachine({ os: ['!linux'] }), true);
  assert.equal(forThisMachine({ os: ['!win32'] }), false);
  const modules = scratch();
  const pkg = (where, manifest) => {
    mkdirSync(path.join(modules, ...where), { recursive: true });
    writeFileSync(path.join(modules, ...where, 'package.json'), JSON.stringify(manifest));
  };
  pkg(['esbuild'], { name: 'esbuild' });
  pkg(['@esbuild', 'win32-x64'], { name: '@esbuild/win32-x64', os: ['win32'], cpu: ['x64'] });
  pkg(['@esbuild', 'darwin-arm64'], { name: '@esbuild/darwin-arm64', os: ['darwin'], cpu: ['arm64'] });
  pkg(['agent'], { name: 'agent' });
  pkg(['agent', 'node_modules', 'clip-linux'], { name: 'clip-linux', os: ['linux'] });
  assert.deepEqual(pruneOtherPlatforms(modules).sort(), ['@esbuild/darwin-arm64', 'clip-linux']);
  assert.equal(existsSync(path.join(modules, '@esbuild', 'win32-x64')), true);
  assert.equal(existsSync(path.join(modules, 'agent', 'node_modules', 'clip-linux')), false);
});

test('the smoke runs the payload\'s runtime without the settings that would change it from outside', () => {
  assert.deepEqual(outsideSettingsRemoved({ PATH: 'p', NODE_OPTIONS: '--require x', node_path: 'n', npm_config_registry: 'r', AWWO_LOCAL_PG_BIN: 'b', TEMP: 't' }), { PATH: 'p', TEMP: 't' });
});

test('the payload names the runtime\'s files and what the workers import beside them', () => {
  assert.ok(RUNTIME_FILES.includes('scripts/awwo-local.mjs') && RUNTIME_FILES.includes('apps/web/scripts/staged-showcase.mjs'));
  assert.ok(SHARED_WORKER_FILES.includes('bedrock-models.json'));
});

test('the payload copies every file the packaged workers import from apps/ beside their folders', () => {
  // A new module there (context-estimate.ts did it) fails here, before an installer is packaged without it.
  const apps = path.join(repoRoot, 'apps');
  const imported = new Set();
  const read = file => {
    for (const specifier of relativeImports(readFileSync(file, 'utf8'))) {
      const target = path.resolve(path.dirname(file), specifier);
      if (path.dirname(target) !== apps || imported.has(path.basename(target))) continue;
      imported.add(path.basename(target));
      read(target);
    }
  };
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      if (entry.isDirectory()) walk(path.join(dir, entry.name));
      else if (/\.[cm]?[jt]s$/.test(entry.name) && !/\.test\.[cm]?[jt]s$/.test(entry.name)) read(path.join(dir, entry.name));
    }
  };
  for (const worker of [...PACKAGED_WORKERS, 'openmaus-worker']) walk(path.join(apps, worker));
  assert.ok(imported.has('context-estimate.ts') && imported.has('user-models.ts'), [...imported].join(', '));
  assert.deepEqual([...imported].filter(name => !SHARED_WORKER_FILES.includes(name)), []);
  for (const name of SHARED_WORKER_FILES) assert.ok(existsSync(path.join(apps, name)), name);
});

test('an assembled payload is checked for what its own scripts import and it does not hold', () => {
  assert.deepEqual(relativeImports([
    "import { a } from './a.mjs';", 'export * from "../b.ts";', "import './c.mjs';", "const d = await import('./d.mjs');",
    "import { e } from 'node:fs';", "import f from 'pkg/x.js';", "const g = require('./g.cjs');",
  ].join('\n')), ['./a.mjs', '../b.ts', './c.mjs', './d.mjs']);
  const out = scratch();
  const write = (file, text) => {
    mkdirSync(path.dirname(path.join(out, file)), { recursive: true });
    writeFileSync(path.join(out, file), text);
  };
  write('app/scripts/awwo-local-web.mjs', "import { s } from '../apps/web/scripts/staged-showcase.mjs';\nimport { l } from './awwo-local-lib.mjs';\n");
  write('app/scripts/awwo-local-lib.mjs', 'export const l = 1;\n');
  write('app/apps/pi-worker/server.mjs', "import { b } from '../bedrock-bridge.ts';\n");
  write('app/apps/pi-worker/node_modules/pkg/index.js', "import './not-checked.js';\n");
  write('app/apps/web/dist-saas/assets/a.js', "import('./not-checked.js');\n");
  assert.deepEqual(missingImports(out).sort(), [
    `${path.join('app', 'apps', 'pi-worker', 'server.mjs')} imports ../bedrock-bridge.ts`,
    `${path.join('app', 'scripts', 'awwo-local-web.mjs')} imports ../apps/web/scripts/staged-showcase.mjs`,
  ]);
});
