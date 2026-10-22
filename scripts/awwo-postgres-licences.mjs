// The libraries PostgreSQL's Windows programs ship with (EDB's archive, POSTGRES_WINDOWS of awwo-local-setup.mjs), each
// with its licence files from its own release of the version its DLL says it is, fetched into
// third_party/postgres-windows/<name>-<version>/ with PROVENANCE.json; and, for the two under the LGPL (gettext's libintl
// and libiconv), their source releases, which setup:local downloads and the packager carries beside them, as LGPL-2.1
// asks of their object code. EDB's commandlinetools_3rd_party_licenses.txt names most of them, but not ICU, and some
// without their copyright lines. scripts/awwo-local-package.mjs (collectPostgresLicences) carries these and stops on a
// DLL of the archive this list does not name.
//
//   node scripts/awwo-postgres-licences.mjs           fetch what is missing
//   node scripts/awwo-postgres-licences.mjs --check   fail when one is missing, or differs from its provenance
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { repoRoot } from './awwo-local-lib.mjs';
import { fetchBytes, licenceTextMatches, provenanceDifferences, sha256 } from './awwo-licence-files.mjs';

export const OUTPUT = path.join(repoRoot, 'third_party', 'postgres-windows');

/** A .c file's leading comment, where libxml2 keeps the notices of the files its Copyright file excepts. */
const header = text => (/^\s*\/\*[\s\S]*?\*\//.exec(text) || [''])[0].trim();

/** PostgreSQL's own libraries in its bin folder (under its licence, server_license.txt). */
export const POSTGRES_OWN_LIBRARIES = Object.freeze(['libpq.dll', 'libecpg.dll', 'libecpg_compat.dll', 'libpgtypes.dll']);
/** Who PostgreSQL's own modules (its lib folder's extensions and conversions) say made them, in their version resource. */
export const POSTGRES_COMPANY = 'PostgreSQL Global Development Group';

/** The libraries of EDB's Windows archive of PostgreSQL 18.4 (18.4-1), each DLL with its SHA-256 there, as their
 *  version resources and build paths name them (libintl: gettext-0.19.8; libiconv-2.dll and libxslt.dll:
 *  libiconv-1.18 and libxslt-v1.1.45; libwinpthread-1.dll: mingw-w64's winpthreads, built by the MinGW-w64 GCC 6.2.0
 *  of its runtime 5); the programs and modules that have one built in (builtInto, found by the banner its code carries:
 *  zlib's "deflate 1.3.2 Copyright", MinGW-w64's "Mingw-w64 runtime failure"); the licence each is under, and where
 *  its licence files are. The sources' SHA-256s are of GNU's releases, whose signatures
 *  (gettext's by Daiki Ueno, libiconv's by Bruno Haible) were checked against the GNU keyring on 2026-10-22. */
export const POSTGRES_LIBRARIES = Object.freeze({
  postgres: '18.4',
  libraries: Object.freeze([
    { name: 'icu', version: '77.1', licence: 'Unicode-3.0',
      dlls: { 'icudt77.dll': '26c6b5923c814dab36caeabd19ea7b8006786c80215dae270c8444cb528ed3bf', 'icuin77.dll': 'e825807402d86307574c88e54ded5845d06b57e010b58b7975a2ab2d07ca7f6a',
        'icuio77.dll': '8892f4b00f75524d70e5fa91c122a584d14faef7631fac40afff52f3fcfa6cae', 'icutu77.dll': '08cfa69abde3af84eccc98040653092710026fdfd65f6f3cddb91bffa7a6e62c',
        'icuuc77.dll': '465ac249e54de36640d85e084e0039acc4f518eda7ee4a9bbee2826ab5c46829' },
      files: { LICENSE: 'https://raw.githubusercontent.com/unicode-org/icu/release-77-1/LICENSE' } },
    { name: 'libxml2', version: '2.15.3', licence: 'MIT', dlls: { 'libxml2.dll': 'fa13b5d8bdc8254a6a7f0bc9b26331fa6badf096334bb912e7dc6928206a74a0' },
      files: { Copyright: 'https://gitlab.gnome.org/GNOME/libxml2/-/raw/v2.15.3/Copyright',
        'dict.c-NOTICE.txt': { url: 'https://gitlab.gnome.org/GNOME/libxml2/-/raw/v2.15.3/dict.c', extract: 'header' },
        'list.c-NOTICE.txt': { url: 'https://gitlab.gnome.org/GNOME/libxml2/-/raw/v2.15.3/list.c', extract: 'header' } } },
    { name: 'libxslt', version: '1.1.45', licence: 'MIT', dlls: { 'libxslt.dll': '8226fad0fc6e9b79b14203d4f5263ddec5764c0108aa7c17622dd77f311669a6' },
      files: { Copyright: 'https://gitlab.gnome.org/GNOME/libxslt/-/raw/v1.1.45/Copyright' } },
    { name: 'zlib', version: '1.3.2', licence: 'Zlib', dlls: { 'zlib1.dll': '890afa7a17fb66308e0026631070409138b157ef2773c0a41d22a76943f7aedf' },
      builtInto: ['bin/postgres.exe', 'bin/pg_basebackup.exe', 'bin/pg_dump.exe', 'bin/pg_dumpall.exe', 'bin/pg_receivewal.exe', 'bin/pg_restore.exe', 'bin/pg_verifybackup.exe'],
      files: { LICENSE: 'https://raw.githubusercontent.com/madler/zlib/v1.3.2/LICENSE' } },
    { name: 'lz4', version: '1.10.0', licence: 'BSD-2-Clause', dlls: { 'liblz4.dll': '096af775241b3bd4b1c3d79c83b103bb8f02da54ec4cd76c5d49eef61a68ad01' },
      files: { LICENSE: 'https://raw.githubusercontent.com/lz4/lz4/v1.10.0/lib/LICENSE' } },
    { name: 'zstd', version: '1.5.7', licence: 'BSD-3-Clause', dlls: { 'libzstd.dll': '287e7e474961e8886a3d961e2c07da647a7ac8d60d97023545f3a3ecf604daba' },
      files: { LICENSE: 'https://raw.githubusercontent.com/facebook/zstd/v1.5.7/LICENSE' } },
    { name: 'openssl', version: '3.5.6', licence: 'Apache-2.0',
      dlls: { 'libcrypto-3-x64.dll': 'e96a6c23b04cea3c1dcb20f4633ae15355b0fa82c899fdf57bfec78df27b6786', 'libssl-3-x64.dll': '100caebb9a7e009480746e7b7b61c3f6bb586b5cb55560898c54744d23e1e34d' },
      files: { 'LICENSE.txt': 'https://raw.githubusercontent.com/openssl/openssl/openssl-3.5.6/LICENSE.txt' } },
    { name: 'winpthreads', version: '5.0.4', licence: 'MIT AND BSD-3-Clause', dlls: { 'libwinpthread-1.dll': 'ffe2d56375bb4e8bdee9037df6befc5016ddd8871d0d85027314dd5792f8fdc9' },
      files: { COPYING: 'https://raw.githubusercontent.com/mingw-w64/mingw-w64/v5.0.4/mingw-w64-libraries/winpthreads/COPYING' } },
    // Code of others in PostgreSQL's own source, built into its programs and modules: Henry Spencer's regex, pg_dump's
    // notice, Snowball's stemmers (dict_snowball), the Unicode tables, Ryu, md5, sha1 and sha2, the BSD and ISC files
    // of src/port…: as Debian's postgresql-18 package lists them, each notice in full (its debian/copyright at a
    // commit), and as the headers of 18.4's own files have them (NOTICES.txt, made from the source release whose
    // SHA-256 postgresql.org publishes beside it).
    { name: 'postgresql-source', version: '18', licence: 'LicenseRef-PostgreSQL-source-notices', dlls: {}, builtInto: ['PostgreSQL\'s own programs and modules (bin/, lib/)'],
      files: { copyright: 'https://salsa.debian.org/postgresql/postgresql/-/raw/cd08a4149882f9dd745fed86e4b1a1fc30600098/debian/copyright',
        'NOTICES.txt': { url: 'https://ftp.postgresql.org/pub/source/v18.4/postgresql-18.4.tar.bz2', extract: 'source-notices', name: 'postgresql-18.4',
          sha256: '81a81ec695fb0c7901407defaa1d2f7973617154cf27ba74e3a7ab8e64436094' } } },
    // MinGW-w64's runtime (its startup code, gdtoa's number formatting…), linked into what MinGW-w64's GCC built: libintl
    // and winpthreads by the GCC 6 of its runtime 5, libiconv by the GCC 12.2 of its runtime 10.
    { name: 'mingw-w64-runtime', version: '5.0.4', licence: 'LicenseRef-MinGW-w64-runtime', dlls: {}, builtInto: ['bin/libintl-9.dll', 'bin/libwinpthread-1.dll'],
      files: { 'COPYING.MinGW-w64-runtime.txt': 'https://raw.githubusercontent.com/mingw-w64/mingw-w64/v5.0.4/COPYING.MinGW-w64-runtime/COPYING.MinGW-w64-runtime.txt' } },
    { name: 'mingw-w64-runtime', version: '10.0.0', licence: 'LicenseRef-MinGW-w64-runtime', dlls: {}, builtInto: ['bin/libiconv-2.dll'],
      files: { 'COPYING.MinGW-w64-runtime.txt': 'https://raw.githubusercontent.com/mingw-w64/mingw-w64/v10.0.0/COPYING.MinGW-w64-runtime/COPYING.MinGW-w64-runtime.txt' } },
    { name: 'gettext', version: '0.19.8', licence: 'LGPL-2.1-or-later', dlls: { 'libintl-9.dll': '1125ac8dc0c4f5c3ed4712e0d8ad29474099fcb55bb0e563a352ce9d03ef1d78' }, files: {},
      source: { name: 'gettext-0.19.8.tar.xz', url: 'https://ftp.gnu.org/gnu/gettext/gettext-0.19.8.tar.xz', sha256: '9c1781328238caa1685d7bc7a2e1dcf1c6c134e86b42ed554066734b621bd12f' } },
    { name: 'libiconv', version: '1.18', licence: 'LGPL-2.1-or-later', dlls: { 'libiconv-2.dll': 'd611f0bef9d06c2892ad2529c094c7e2da5cbd6659ebfb1edd6bf22840cb44c5' }, files: {},
      source: { name: 'libiconv-1.18.tar.gz', url: 'https://ftp.gnu.org/gnu/libiconv/libiconv-1.18.tar.gz', sha256: '3b08f5f4f9b4eb82f151a7040bfd6fe6c6fb922efe4b1659c66ea933276965e8' } },
  ].map(library => Object.freeze(library))),
});

const VC_RUNTIME = /^(vcruntime|msvcp|msvcr|concrt|vccorlib|vcomp|vcamp|mfc)\d+(_\w+)?\.dll$/i;

/** The PostgreSQL version postgres.exe -V names ("postgres (PostgreSQL) 18.4"), or null. */
export const postgresVersionOf = output => /\(PostgreSQL\)\s+(\S+)/.exec(String(output || ''))?.[1] || null;

/** What stops a PostgreSQL's libraries from being carried with their licences: another PostgreSQL than the list was
 *  made for (as its postgres.exe says); in its bin folder ([{ name, sha256 }]) a DLL the list does not name
 *  (PostgreSQL's own and the VC++ runtime aside), or one of other bytes than it lists (another build, which its
 *  licences and sources might not be of), or one it names that is not there; in its lib folder ([{ name, company }])
 *  a module that does not say PostgreSQL made it (an extension of another project's, whose licence is not here). */
export function postgresLibraryGaps({ bin, lib = [], version }, list = POSTGRES_LIBRARIES) {
  const gaps = [];
  if (version !== list.postgres) gaps.push(`the libraries are listed for PostgreSQL ${list.postgres}, not ${version || 'an unknown version'}`);
  const listed = new Map(list.libraries.flatMap(library => Object.entries(library.dlls).map(([dll, sha256]) => [dll.toLowerCase(), sha256])));
  for (const file of bin.filter(entry => /\.dll$/i.test(entry.name))) {
    const lower = file.name.toLowerCase();
    if (listed.has(lower)) { if (listed.get(lower) !== file.sha256) gaps.push(`${file.name} is not the build listed (other bytes)`); }
    else if (!POSTGRES_OWN_LIBRARIES.includes(lower) && !VC_RUNTIME.test(lower)) gaps.push(`${file.name} is not in the list`);
  }
  const present = new Set(bin.map(entry => entry.name.toLowerCase()));
  for (const dll of listed.keys()) if (!present.has(dll)) gaps.push(`${dll} is listed but not there`);
  for (const module of lib.filter(entry => /\.dll$/i.test(entry.name))) {
    if (module.company !== POSTGRES_COMPANY) gaps.push(`lib/${module.name} is not PostgreSQL's own (made by ${module.company || 'no one it names'})`);
  }
  return gaps;
}

/** A licence file's address and how its text is taken from what is there. */
const fileSpec = spec => typeof spec === 'string' ? { url: spec, extract: null } : spec;

/** A copyright line of someone other than PostgreSQL's own (its group, and the university Postgres95 came from), or the
 *  words with which a licence grants its rights. */
const OTHERS = /copyright|\(c\)\s*\d{4}/i;
const OURS = /^\W*(portions\s+)?copyright\s*\(c\)\s*[\d, -]+\s*(PostgreSQL Global Development Group|(The\s+)?Regents of the University of California)\W*$/i;
const GRANT = /Redistribution and use in source and binary forms|Permission to use, copy, modify|Permission is hereby granted|Licensed under|License, Version|Boost Software License|may be used under the terms|Rights are granted to use this software/i;

/** The comment blocks of a source file that carry the notices of code of others: a C comment, or a run of lines a "#"
 *  begins (the mapping tables'), holding a copyright line not PostgreSQL's own or a licence's grant. */
export function othersNotices(text) {
  const blocks = [...String(text).matchAll(/\/\*[\s\S]*?\*\//g)].map(match => match[0]);
  const hashed = String(text).split('\n').reduce((runs, line) => {
    if (/^\s*#/.test(line)) runs.at(-1).push(line); else if (runs.at(-1).length) runs.push([]);
    return runs;
  }, [[]]).filter(run => run.length).map(run => run.join('\n'));
  return [...blocks, ...hashed].filter(block => GRANT.test(block)
    || block.split('\n').some(line => OTHERS.test(line) && !OURS.test(line.replace(/^[\s/*#]+/, '')))).map(block => block.trim());
}

/** What of PostgreSQL's source the Windows payload does not carry: the languages in Perl, Python and Tcl, the tests,
 *  the developers' tools and the tutorial. */
const NOT_CARRIED = /^src\/(pl\/(plperl|plpython|tcl)|test|tools|tutorial|interfaces\/ecpg\/test)(\/|$)|\/t\//;

/** NOTICES.txt of a PostgreSQL source tree: every file of its src/ that the payload's programs come from with notices
 *  of code of others, each with those blocks as its header has them. */
export function sourceNotices(tree, name) {
  const files = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const relative = path.relative(tree, full).replaceAll('\\', '/');
      if (NOT_CARRIED.test(relative) || NOT_CARRIED.test(`${relative}/`)) continue;
      if (entry.isDirectory()) walk(full);
      // A licence's own file (the regex engine's COPYRIGHT, say) is a notice whole.
      else if (/^(COPYRIGHT|COPYING|LICEN[CS]E)\b|\.LICEN[CS]E$/i.test(entry.name)) files.push([relative, [readFileSync(full, 'latin1').trim()]]);
      else if (/\.(c|h|y|l|txt|map)$/i.test(entry.name) || !path.extname(entry.name)) {
        const blocks = othersNotices(readFileSync(full, 'latin1'));
        if (blocks.length) files.push([relative, blocks]);
      }
    }
  };
  walk(path.join(tree, 'src'));
  files.sort(([a], [b]) => a.localeCompare(b));
  return `The notices of code of others in ${name}'s source, as each file of its src/ that AwwO Local's PostgreSQL programs come from has them in its header (the Perl, Python and Tcl languages, the tests and the developers' tools are not carried).\n\n${
    files.map(([file, blocks]) => `== ${file} ==\n\n${blocks.join('\n\n')}\n`).join('\n')}`;
}

/** NOTICES.txt from a source release's archive: downloaded to a scratch folder, checked against its SHA-256, unpacked
 *  there, read, and removed. */
function fetchSourceNotices({ url, sha256: expected, name }) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'awwo-pg-source-'));
  try {
    const archive = path.join(scratch, path.basename(new URL(url).pathname));
    const fetched = fetchBytes(url, 600);
    if (!fetched || sha256(fetched) !== expected) throw new Error(`${url} was not fetched with SHA-256 ${expected}`);
    writeFileSync(archive, fetched);
    const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    const unpacked = spawnSync(tar, ['-xf', archive, '-C', scratch, `${name}/src`], { windowsHide: true, stdio: 'ignore' });
    if (unpacked.status !== 0) throw new Error(`${archive} could not be unpacked (tar ${unpacked.status})`);
    return Buffer.from(sourceNotices(path.join(scratch, name), name));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function main(args) {
  const check = args.includes('--check');
  const provenanceFile = path.join(OUTPUT, 'PROVENANCE.json');
  const provenance = existsSync(provenanceFile) ? JSON.parse(readFileSync(provenanceFile, 'utf8')) : {};
  const missing = check ? provenanceDifferences(OUTPUT) : [];
  for (const library of POSTGRES_LIBRARIES.libraries) {
    const key = `${library.name}-${library.version}`;
    const folder = path.join(OUTPUT, key);
    const names = Object.keys(library.files);
    if (!names.length) continue;
    const have = existsSync(folder) ? readdirSync(folder) : [];
    if (names.every(name => have.includes(name))) {
      if (!licenceTextMatches(library.licence, names.map(name => readFileSync(path.join(folder, name), 'utf8')))) missing.push(`${key} (its files are not of ${library.licence})`);
      continue;
    }
    if (check) { missing.push(key); continue; }
    const fetched = [];
    for (const name of names) {
      const spec = fileSpec(library.files[name]);
      if (spec.extract === 'source-notices') {
        fetched.push({ name, url: spec.url, bytes: fetchSourceNotices(spec), source: spec.sha256, from: `the notices in the headers of its src/ (sourceNotices), the archive's SHA-256 ${spec.sha256}` });
        continue;
      }
      const bytes = fetchBytes(spec.url);
      if (!bytes) { missing.push(`${key} (${spec.url} could not be fetched)`); break; }
      fetched.push({ name, url: spec.url, bytes: spec.extract === 'header' ? Buffer.from(`${header(bytes.toString('utf8'))}\n`) : bytes, source: spec.extract ? sha256(bytes) : null, from: spec.extract ? 'the leading comment of the file' : null });
    }
    if (fetched.length !== names.length) continue;
    if (!licenceTextMatches(library.licence, fetched.map(file => file.bytes.toString('utf8')))) { missing.push(`${key} (what was fetched is not of ${library.licence})`); continue; }
    mkdirSync(folder, { recursive: true });
    provenance[key] = { licence: library.licence, dlls: Object.keys(library.dlls), files: {} };
    for (const file of fetched) {
      writeFileSync(path.join(folder, file.name), file.bytes);
      provenance[key].files[file.name] = { url: file.url, sha256: sha256(file.bytes), ...(file.from ? { from: file.from, fileSha256: file.source } : {}) };
    }
    console.log(`${key}: ${names.join(', ')}`);
  }
  if (!check) {
    mkdirSync(OUTPUT, { recursive: true });
    writeFileSync(provenanceFile, `${JSON.stringify(Object.fromEntries(Object.entries(provenance).sort(([a], [b]) => a.localeCompare(b))), null, 2)}\n`);
  }
  if (missing.length) throw new Error(`No licence here for: ${missing.join(', ')}${check ? ' (node scripts/awwo-postgres-licences.mjs fetches them)' : ''}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
