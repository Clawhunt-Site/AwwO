// Tests for the Mac app's payload (scripts/awwo-local-package-macos.mjs) and the Mach-O checks it makes
// (scripts/awwo-macho.mjs), on Mach-O files these tests write: they run on any system. What only a Mac can do (codesign,
// running the payload) is left to the packager there; its codesign calls are checked with a stand-in.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  collectMacPostgresLicences, copyMacPostgres, macLibdirGaps, macNodeKept, macPostgresKept, MAC_SERVER_MODULES, pruneCommandLinks, signPayload, unexpectedLinks,
} from './awwo-local-package-macos.mjs';
import { libraryCandidates, machO, machOProblems, unsignedMachO, withoutCode } from './awwo-macho.mjs';
import { POSTGRES_MACOS_LIBRARIES } from './awwo-postgres-licences.mjs';

const scratch = () => mkdtempSync(path.join(os.tmpdir(), 'awwo-local-macos-test-'));
const put = (file, bytes) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, bytes); };
/** Whether this system lets a test make a symlink (Windows only with Developer Mode or elevation). */
const canLink = (() => {
  const dir = scratch();
  try { symlinkSync('x', path.join(dir, 'probe')); return true; } catch { return false; }
})();

const CPU = { arm64: 0x0100000c, x86_64: 0x01000007 };
/** A thin 64-bit Mach-O of a machine: its load commands (dylib, weak, rpath), and a code signature or none. */
function thin({ cpu = 'arm64', libraries = [], weak = [], rpaths = [], signed = true, filetype = 2 }) {
  const commands = [];
  const named = (command, name) => {
    const text = Buffer.from(`${name}\0`);
    const size = Math.ceil((24 + text.length) / 8) * 8;
    const buffer = Buffer.alloc(size);
    buffer.writeUInt32LE(command, 0); buffer.writeUInt32LE(size, 4); buffer.writeUInt32LE(24, 8);
    text.copy(buffer, 24);
    return buffer;
  };
  for (const name of libraries) commands.push(named(0xc, name));
  for (const name of weak) commands.push(named(0x80000018, name));
  for (const name of rpaths) {
    const text = Buffer.from(`${name}\0`);
    const size = Math.ceil((12 + text.length) / 8) * 8;
    const buffer = Buffer.alloc(size);
    buffer.writeUInt32LE(0x8000001c, 0); buffer.writeUInt32LE(size, 4); buffer.writeUInt32LE(12, 8);
    text.copy(buffer, 12);
    commands.push(buffer);
  }
  if (signed) {
    const buffer = Buffer.alloc(16);
    buffer.writeUInt32LE(0x1d, 0); buffer.writeUInt32LE(16, 4); buffer.writeUInt32LE(4096, 8); buffer.writeUInt32LE(64, 12);
    commands.push(buffer);
  }
  const body = Buffer.concat(commands);
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0xfeedfacf, 0); header.writeUInt32LE(CPU[cpu], 4); header.writeUInt32LE(filetype, 12);
  header.writeUInt32LE(commands.length, 16); header.writeUInt32LE(body.length, 20);
  return Buffer.concat([header, body, Buffer.alloc(64)]);
}
/** A universal Mach-O of some thin ones. */
function universal(...slices) {
  const header = Buffer.alloc(8 + slices.length * 20);
  header.writeUInt32BE(0xcafebabe, 0); header.writeUInt32BE(slices.length, 4);
  let offset = Math.ceil(header.length / 4096) * 4096;
  const parts = [];
  slices.forEach((slice, index) => {
    const entry = 8 + index * 20;
    header.writeUInt32BE(slice.readUInt32LE(4), entry); header.writeUInt32BE(offset, entry + 8); header.writeUInt32BE(slice.length, entry + 12);
    parts.push({ offset, slice });
    offset += Math.ceil(slice.length / 4096) * 4096;
  });
  const out = Buffer.alloc(offset);
  header.copy(out, 0);
  for (const part of parts) part.slice.copy(out, part.offset);
  return out;
}

test('a Mach-O file is read for its machines, the libraries it loads, its run paths and its signature', () => {
  const [one] = machO(thin({ libraries: ['@loader_path/../lib/libpq.5.dylib', '/usr/lib/libSystem.B.dylib'], weak: ['/opt/x/libmaybe.dylib'], rpaths: ['@loader_path/../lib'] }));
  assert.equal(one.cpu, 'arm64');
  assert.deepEqual(one.libraries, ['@loader_path/../lib/libpq.5.dylib', '/usr/lib/libSystem.B.dylib']);
  assert.deepEqual(one.weak, ['/opt/x/libmaybe.dylib']);
  assert.deepEqual(one.rpaths, ['@loader_path/../lib']);
  assert.equal(one.signed, true);
  const both = machO(universal(thin({ cpu: 'x86_64', signed: false }), thin({ cpu: 'arm64' })));
  assert.deepEqual(both.map(slice => [slice.cpu, slice.signed]), [['x86_64', false], ['arm64', true]]);
  // A Java class file starts as a universal one does, then its version: it is no Mach-O.
  assert.equal(machO(Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x34, 0, 0, 0, 0])), null);
  assert.equal(machO(Buffer.from('#!/bin/sh\necho not a program\n')), null);
  assert.throws(() => machO(Buffer.concat([thin({ libraries: ['@loader_path/x.dylib'] }).subarray(0, 40)])), /does not fit|runs past/);
});

test('a library is looked for where its loader, its program or its run paths say, the system\'s being the system\'s', () => {
  assert.equal(libraryCandidates('/usr/lib/libc++.1.dylib', { loader: '/p/bin' }), 'system');
  assert.equal(libraryCandidates('/System/Library/Frameworks/LDAP.framework/Versions/A/LDAP', { loader: '/p/bin' }), 'system');
  assert.deepEqual(libraryCandidates('@loader_path/../lib/libz.1.dylib', { loader: path.join('/p', 'bin') }), [path.join('/p', 'lib', 'libz.1.dylib')]);
  assert.deepEqual(libraryCandidates('@executable_path/libx.dylib', { loader: '/p/lib', executable: '/p/bin' }), [path.join('/p', 'bin', 'libx.dylib')]);
  assert.deepEqual(libraryCandidates('@rpath/liby.dylib', { loader: '/p/bin', rpaths: ['@loader_path/../lib', '/abs'] }), [path.join('/p', 'lib', 'liby.dylib')]);
  assert.deepEqual(libraryCandidates('/Library/PostgreSQL/18/lib/libpq.5.dylib', { loader: '/p/bin' }), [], 'an absolute path elsewhere is outside the payload');
});

test('the payload is refused when a program it carries would not find a library it loads', () => {
  const root = scratch();
  put(path.join(root, 'build', 'pgsql', 'bin', 'postgres'), thin({ libraries: ['@loader_path/../lib/libicuuc.77.1.dylib', '/usr/lib/libSystem.B.dylib'], weak: ['@loader_path/../lib/gone.dylib'] }));
  put(path.join(root, 'build', 'pgsql', 'lib', 'libicuuc.77.1.dylib'), thin({ filetype: 6, libraries: ['@loader_path/../lib/libicudata.77.1.dylib'] }));
  put(path.join(root, 'build', 'pgsql', 'lib', 'libicudata.77.1.dylib'), thin({ filetype: 6 }));
  put(path.join(root, 'build', 'awwo-api'), thin({ libraries: ['/usr/lib/libresolv.9.dylib'] }));
  // A package's build for Intel Macs beside the Apple silicon one is never loaded here, and named by nothing.
  put(path.join(root, 'app', 'apps', 'pi-worker', 'node_modules', 'pkg', 'prebuilds', 'darwin-x64', 'a.node'), thin({ cpu: 'x86_64', signed: false, libraries: ['@loader_path/missing.dylib'] }));
  put(path.join(root, 'app', 'apps', 'web', 'dist-saas', 'App.class'), Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x34, 1, 2, 3, 4]));
  assert.deepEqual(machOProblems(root), []);
  assert.deepEqual(unsignedMachO(root), ['app/apps/pi-worker/node_modules/pkg/prebuilds/darwin-x64/a.node'], 'the Intel build is signed by the packager too');
  assert.deepEqual(withoutCode([path.join(root, 'build', 'awwo-api'), path.join(root, 'app', 'apps', 'pi-worker', 'node_modules', 'pkg', 'prebuilds', 'darwin-x64', 'a.node'), path.join(root, 'build', 'none')]),
    [path.join(root, 'app', 'apps', 'pi-worker', 'node_modules', 'pkg', 'prebuilds', 'darwin-x64', 'a.node'), path.join(root, 'build', 'none')]);
  put(path.join(root, 'build', 'pgsql', 'bin', 'psql'), thin({ libraries: ['@loader_path/../lib/libedit.0.dylib', '/Library/edb/languagepack/v6/Perl-5.42/lib/CORE/libperl.dylib'] }));
  assert.deepEqual(machOProblems(root), [
    'build/pgsql/bin/psql loads /Library/edb/languagepack/v6/Perl-5.42/lib/CORE/libperl.dylib, which is not in the payload',
    'build/pgsql/bin/psql loads @loader_path/../lib/libedit.0.dylib, which is not in the payload',
  ]);
});

test('a link of the payload must be one of PostgreSQL\'s the list names, beside what it leads to', { skip: !canLink && 'this system makes no symlinks for a test' }, () => {
  const root = scratch();
  const lib = path.join(root, 'build', 'pgsql', 'lib');
  put(path.join(lib, 'libz.1.3.2.dylib'), thin({ filetype: 6 }));
  symlinkSync('libz.1.3.2.dylib', path.join(lib, 'libz.1.dylib'));
  put(path.join(root, 'build', 'pgsql', 'bin', 'pg_dump'), thin({ libraries: ['@loader_path/../lib/libz.1.dylib'] }));
  assert.deepEqual(machOProblems(root), []);
  assert.deepEqual(unexpectedLinks(root), []);
  symlinkSync('../../../../etc/hosts', path.join(lib, 'libpq.dylib'));
  symlinkSync('nothing.dylib', path.join(lib, 'liblz4.1.dylib'));
  mkdirSync(path.join(root, 'app', 'node_modules', '.bin'), { recursive: true });
  symlinkSync('../pkg/cli.js', path.join(root, 'app', 'node_modules', '.bin', 'pkg'));
  assert.deepEqual(machOProblems(root), [
    'app/node_modules/.bin/pkg is a link out of its folder (to ../pkg/cli.js)',
    'build/pgsql/lib/liblz4.1.dylib is a link to nothing (nothing.dylib)',
    'build/pgsql/lib/libpq.dylib is a link out of its folder (to ../../../../etc/hosts)',
  ]);
  assert.deepEqual(unexpectedLinks(root).sort(), ['app/node_modules/.bin/pkg -> ../pkg/cli.js', 'build/pgsql/lib/liblz4.1.dylib -> nothing.dylib', 'build/pgsql/lib/libpq.dylib -> ../../../../etc/hosts']);
  assert.equal(pruneCommandLinks(path.join(root, 'app', 'node_modules')), 1, 'a package\'s commands for a shell go');
  assert.ok(!existsSync(path.join(root, 'app', 'node_modules', '.bin')));
});

test('of EDB\'s macOS PostgreSQL the payload carries the server\'s parts: its programs, the listed libraries and links, its modules, its data', () => {
  for (const kept of ['bin/postgres', 'bin/initdb', 'bin/pg_ctl', 'bin/psql', 'bin/pg_dump', 'lib/libpq.5.dylib', 'lib/libicudata.77.1.dylib', 'lib/libicui18n.dylib', 'lib/libz.1.dylib',
    'lib/libiconv.2.dylib', 'lib/postgresql/plpgsql.dylib', 'lib/postgresql/dict_snowball.dylib', 'lib/postgresql/utf8_and_gbk.dylib', 'lib/postgresql/libpqwalreceiver.dylib',
    'share/postgresql/postgres.bki', 'share/postgresql/timezone/Asia/Shanghai', 'share/postgresql/extension/plpgsql.control', 'share/postgresql/extension/plpgsql--1.0.sql']) {
    assert.ok(macPostgresKept(kept), kept);
  }
  for (const left of ['bin/oid2name', 'bin/vacuumlo', 'lib/libintl.8.dylib', 'lib/libxslt.1.dylib', 'lib/libuuid.1.1.dylib', 'lib/libpq-oauth-18.dylib', 'lib/libpq.dylib', 'lib/libpq.a',
    'lib/pkgconfig/libpq.pc', 'lib/postgresql/plperl.dylib', 'lib/postgresql/plpython3.dylib', 'lib/postgresql/pltcl.dylib', 'lib/postgresql/pgcrypto.dylib', 'lib/postgresql/pgxs/src/makefiles/pgxs.mk',
    'share/postgresql/extension/pgcrypto.control', 'share/man/man1/psql.1', 'doc/postgresql/html/index.html', 'pgAdmin 4.app/Contents/Info.plist', 'stackbuilder/stackbuilder.app']) {
    assert.ok(!macPostgresKept(left), left);
  }
  assert.ok(MAC_SERVER_MODULES.test('euc2004_sjis2004.dylib') && !MAC_SERVER_MODULES.test('plpgsql.so'));
  // Every library and link the list names is carried, and nothing of lib/ that it does not.
  for (const library of POSTGRES_MACOS_LIBRARIES.libraries) {
    for (const name of [...Object.keys(library.dylibs), ...Object.keys(library.links || {})]) assert.ok(macPostgresKept(`lib/${name}`), name);
  }
});

test('the modules PostgreSQL\'s catalog names must be in lib/postgresql', () => {
  const pgsql = scratch();
  put(path.join(pgsql, 'share', 'postgresql', 'snowball_create.sql'), "CREATE FUNCTION x() AS '$libdir/dict_snowball';");
  put(path.join(pgsql, 'share', 'postgresql', 'extension', 'plpgsql--1.0.sql'), "AS '$libdir/plpgsql'");
  put(path.join(pgsql, 'lib', 'postgresql', 'plpgsql.dylib'), 'x');
  assert.deepEqual(macLibdirGaps(pgsql), ['dict_snowball']);
  put(path.join(pgsql, 'lib', 'postgresql', 'dict_snowball.dylib'), 'x');
  assert.deepEqual(macLibdirGaps(pgsql), []);
});

test('PostgreSQL is copied as kept, and Node.js comes as its program and licence', () => {
  const from = scratch();
  const to = path.join(scratch(), 'pgsql');
  for (const file of ['bin/postgres', 'bin/oid2name', 'lib/libpq.5.dylib', 'lib/libintl.8.dylib', 'lib/postgresql/plpgsql.dylib', 'lib/postgresql/pgcrypto.dylib', 'share/postgresql/postgres.bki', 'share/man/man1/x.1']) put(path.join(from, file), 'x');
  copyMacPostgres(from, to);
  const listed = dir => readdirSync(dir, { recursive: true, withFileTypes: true }).filter(entry => !entry.isDirectory()).map(entry => path.relative(to, path.join(entry.parentPath, entry.name)).replaceAll('\\', '/')).sort();
  assert.deepEqual(listed(to), ['bin/postgres', 'lib/libpq.5.dylib', 'lib/postgresql/plpgsql.dylib', 'share/postgresql/postgres.bki']);
  assert.ok(macNodeKept('bin/node') && macNodeKept('LICENSE'));
  assert.ok(!macNodeKept('bin/npm') && !macNodeKept('lib/node_modules/npm/index.js') && !macNodeKept('include/node/node.h') && !macNodeKept('share/man/man1/node.1'));
});

test('PostgreSQL\'s libraries carry their licences, libiconv its source, and LIBRARIES.md says which is which', () => {
  const root = scratch();
  const pgsql = path.join(scratch(), 'pgsql');
  const build = scratch();
  const source = Buffer.from('libiconv source');
  const list = { postgres: '18.4', libraries: [
    { name: 'zlib', version: '1.3.2', licence: 'Zlib', dylibs: { 'libz.1.3.2.dylib': 'a'.repeat(64) }, links: { 'libz.1.dylib': 'libz.1.3.2.dylib' }, files: { LICENSE: 'https://example.org/LICENSE' } },
    { name: 'libiconv', version: '1.19', licence: 'LGPL-2.1-or-later', dylibs: { 'libiconv.2.dylib': 'b'.repeat(64) }, files: { 'COPYING.LIB': 'https://example.org/COPYING.LIB' },
      source: { name: 'libiconv-1.19.tar.gz', url: 'https://example.org/libiconv-1.19.tar.gz', sha256: createHash('sha256').update(source).digest('hex') } },
  ] };
  const curated = path.join(root, 'third_party', 'postgres-macos');
  put(path.join(curated, 'zlib-1.3.2', 'LICENSE'), 'zlib licence');
  put(path.join(curated, 'libiconv-1.19', 'COPYING.LIB'), 'LGPL');
  const fetched = text => ({ url: 'https://example.org/x', sha256: createHash('sha256').update(text).digest('hex') });
  const provenance = { 'zlib-1.3.2': { files: { LICENSE: fetched('zlib licence') } }, 'libiconv-1.19': { files: { 'COPYING.LIB': fetched('LGPL') } } };
  put(path.join(curated, 'PROVENANCE.json'), JSON.stringify(provenance));
  const found = { version: '18.4', lib: [
    { name: 'libz.1.3.2.dylib', kind: 'file', sha256: 'a'.repeat(64) }, { name: 'libz.1.dylib', kind: 'symlink', target: 'libz.1.3.2.dylib' },
    { name: 'libiconv.2.dylib', kind: 'file', sha256: 'b'.repeat(64) },
  ] };
  // A licence file of other bytes than fetched (cut short, edited) stops it before anything is copied.
  put(path.join(curated, 'libiconv-1.19', 'COPYING.LIB'), 'LGP');
  assert.throws(() => collectMacPostgresLicences({ build }, pgsql, { root, list, found }), /postgres-macos is not as fetched[\s\S]*libiconv-1\.19\/COPYING\.LIB: other bytes than fetched/);
  assert.ok(!existsSync(pgsql), 'nothing copied');
  put(path.join(curated, 'libiconv-1.19', 'COPYING.LIB'), 'LGPL');
  assert.throws(() => collectMacPostgresLicences({ build }, pgsql, { root, list, found }), /Missing .*libiconv-1\.19\.tar\.gz/);
  put(path.join(build, 'downloads', 'libiconv-1.19.tar.gz'), source);
  assert.equal(collectMacPostgresLicences({ build }, pgsql, { root, list, found }), 2);
  assert.equal(readFileSync(path.join(pgsql, 'licenses', 'zlib-1.3.2', 'LICENSE'), 'utf8'), 'zlib licence');
  assert.deepEqual(readFileSync(path.join(pgsql, 'sources', 'libiconv-1.19.tar.gz')), source);
  const table = readFileSync(path.join(pgsql, 'LIBRARIES.md'), 'utf8');
  assert.match(table, /\| lib\/libz\.1\.3\.2\.dylib, lib\/libz\.1\.dylib \(a link\) \| zlib 1\.3\.2 \| Zlib \| licenses\/zlib-1\.3\.2\/LICENSE \|/);
  assert.match(table, /\| lib\/libiconv\.2\.dylib \| libiconv 1\.19 \| LGPL-2\.1-or-later \| licenses\/libiconv-1\.19\/COPYING\.LIB, sources\/libiconv-1\.19\.tar\.gz \|/);
  assert.throws(() => collectMacPostgresLicences({ build }, pgsql, { root, list, found: { ...found, lib: [...found.lib, { name: 'libintl.8.dylib', kind: 'file', sha256: 'c'.repeat(64) }] } }), /libintl\.8\.dylib is not in the list/);
});

test('the payload\'s unsigned programs are signed ad hoc, and every program\'s signature is checked', () => {
  const root = scratch();
  put(path.join(root, 'build', 'awwo-api'), thin({}));
  put(path.join(root, 'app', 'x', 'a.node'), thin({ signed: false }));
  const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args.map(arg => arg.startsWith(root) ? path.relative(root, arg).replaceAll('\\', '/') : arg)]);
    // codesign --sign writes a signature: the stand-in writes the file as signed.
    if (args.includes('--sign')) writeFileSync(args.at(-1), thin({}));
    return { status: 0, stderr: '' };
  };
  assert.deepEqual(signPayload(root, { run }), ['app/x/a.node']);
  assert.deepEqual(calls, [
    ['/usr/bin/codesign', '--force', '--sign', '-', 'app/x/a.node'],
    ['/usr/bin/codesign', '--verify', '--strict', 'app/x/a.node'],
    ['/usr/bin/codesign', '--verify', '--strict', 'build/awwo-api'],
  ]);
  const refusing = (command, args) => ({ status: args.includes('--verify') && args.at(-1).endsWith('awwo-api') ? 1 : 0, stderr: '' });
  assert.throws(() => signPayload(root, { run: refusing }), /signatures do not hold[\s\S]*build\/awwo-api/);
});
