// Tests for what decides the licences AwwO 本地版's Windows installer carries: the shared checks
// (scripts/awwo-licence-files.mjs), the Rust crates' (awwo-crate-licences.mjs), the npm packages'
// (awwo-npm-licences.mjs) and PostgreSQL's libraries' (awwo-postgres-licences.mjs). Their fetching runs against the
// network when they are run; the files they fetched are checked by their --check.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { licenceTextMatches, parseLicenceExpression, provenanceDifferences } from './awwo-licence-files.mjs';
import { crateFolderGaps, needed, WEBVIEW2, webview2Sdk } from './awwo-crate-licences.mjs';
import { folderOf, githubRepository, installedPackages, leftOutPackage, permissiveLicence, repositoryFolders } from './awwo-npm-licences.mjs';
import { POSTGRES_COMPANY, POSTGRES_LIBRARIES, POSTGRES_MACOS_LIBRARIES, POSTGRES_OWN_LIBRARIES, othersNotices, postgresLibraryGaps, postgresMacosLibraryGaps, postgresVersionOf, sourceNotices } from './awwo-postgres-licences.mjs';

const scratch = () => mkdtempSync(path.join(os.tmpdir(), 'awwo-local-licences-test-'));
const write = (file, text) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const MIT = 'MIT License\n\nCopyright (c) 2024 A\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software';
const APACHE = '                                 Apache License\n                           Version 2.0, January 2004\n\n   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION';
const BSD2 = 'Copyright (c) B\n\nRedistribution and use in source and binary forms, with or without\nmodification, are permitted provided that the following conditions are met:';
const BSD = `${BSD2}\n * Neither the name of the copyright holder nor the names of its contributors may be used\n   to endorse or promote products derived from this software`;

test('a text is of the licence an SPDX expression names: one alternative, all of whose parts some text has', () => {
  assert.equal(licenceTextMatches('MIT', [MIT]), true);
  assert.equal(licenceTextMatches('MIT', [APACHE]), false, 'an Apache licence is not the MIT licence a package names');
  assert.equal(licenceTextMatches('MIT OR Apache-2.0', [APACHE]), true);
  assert.equal(licenceTextMatches('(MIT OR Apache-2.0)', [BSD]), false);
  assert.equal(licenceTextMatches('MIT/Apache-2.0', [MIT]), true, 'crates\' older form');
  assert.equal(licenceTextMatches('MIT AND BSD-3-Clause', [`${MIT}\n${BSD}`]), true);
  assert.equal(licenceTextMatches('MIT AND BSD-3-Clause', [MIT]), false);
  assert.equal(licenceTextMatches('Apache-2.0 WITH LLVM-exception', [APACHE]), false, 'an exception whose words are not known here is not found');
  assert.equal(licenceTextMatches('MIT WITH OR', [MIT]), false, 'an operator is no exception');
  assert.equal(licenceTextMatches('LicenseRef-proprietary', [MIT]), false, 'a licence whose words are not known is never found');
  assert.equal(licenceTextMatches('', [MIT]), false);
  // Grouping and precedence: an AND needs every part, whatever an OR inside it allows.
  assert.equal(licenceTextMatches('(MIT OR Apache-2.0) AND Unicode-3.0', [MIT]), false);
  assert.equal(licenceTextMatches('(MIT OR Apache-2.0) AND Unicode-3.0', [APACHE, 'UNICODE LICENSE V3\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of data files']), true);
  assert.equal(licenceTextMatches('MIT OR Apache-2.0 AND BSD-3-Clause', [APACHE]), false, 'AND binds tighter than OR');
  assert.equal(licenceTextMatches('MIT OR Apache-2.0 AND BSD-3-Clause', [MIT]), true);
  for (const malformed of ['(MIT', 'MIT)', 'MIT OR', 'AND MIT', 'MIT WITH', '()']) assert.equal(licenceTextMatches(malformed, [MIT]), false, malformed);
  // A line naming a licence is not its text, and BSD-2's text is not BSD-3's.
  assert.equal(licenceTextMatches('Apache-2.0', ['Licensed under the Apache License, Version 2.0 (the "License")']), false);
  assert.equal(licenceTextMatches('MPL-2.0', ['This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.']), false);
  assert.equal(licenceTextMatches('BSD-3-Clause', [BSD2]), false);
  assert.equal(licenceTextMatches('BSD-2-Clause', [BSD2]), true);
  // A licence kept in a source file's comment, each line behind " * ".
  assert.equal(licenceTextMatches('BSD-3-Clause', [BSD.split('\n').map(line => ` * ${line}`).join('\n')]), true);
});

test('an SPDX expression parses with AND before OR, parentheses grouping, and an exception kept beside its licence', () => {
  assert.deepEqual(parseLicenceExpression('MIT'), { id: 'MIT' });
  assert.deepEqual(parseLicenceExpression('(MIT OR Apache-2.0) AND GPL-3.0'), { and: [{ or: [{ id: 'MIT' }, { id: 'Apache-2.0' }] }, { id: 'GPL-3.0' }] });
  assert.deepEqual(parseLicenceExpression('MIT OR Apache-2.0 AND ISC'), { or: [{ id: 'MIT' }, { and: [{ id: 'Apache-2.0' }, { id: 'ISC' }] }] });
  assert.deepEqual(parseLicenceExpression('MIT/Apache-2.0'), { or: [{ id: 'MIT' }, { id: 'Apache-2.0' }] });
  assert.deepEqual(parseLicenceExpression('Apache-2.0 WITH LLVM-exception'), { id: 'Apache-2.0', exception: 'LLVM-exception' });
  assert.equal(parseLicenceExpression('MIT Apache-2.0'), null);
  for (const malformed of ['MIT WITH OR', 'MIT WITH AND', 'MIT WITH WITH', 'MIT WITH (']) assert.equal(parseLicenceExpression(malformed), null, malformed);
  assert.equal(permissiveLicence('Apache-2.0 WITH LLVM-exception'), true, 'an exception only adds permissions');
});

test('fetched files are checked against the provenance they were fetched with', () => {
  const output = scratch();
  const sha = text => createHash('sha256').update(text).digest('hex');
  write(path.join(output, 'a-1.0.0', 'LICENSE'), 'mit of a');
  writeFileSync(path.join(output, 'PROVENANCE.json'), JSON.stringify({ 'a-1.0.0': { files: { LICENSE: { url: 'https://example.com/LICENSE', sha256: sha('mit of a') } } }, 'gone-1.0.0': { files: {} } }));
  assert.deepEqual(provenanceDifferences(output), ['gone-1.0.0: missing']);
  write(path.join(output, 'a-1.0.0', 'LICENSE'), 'mit of a, truncated');
  write(path.join(output, 'a-1.0.0', 'EXTRA'), 'x');
  mkdirSync(path.join(output, 'b-2.0.0'));
  assert.deepEqual(provenanceDifferences(output).sort(), ['a-1.0.0/EXTRA: not in the provenance', 'a-1.0.0/LICENSE: other bytes than fetched', 'b-2.0.0: no provenance', 'gone-1.0.0: missing']);
});

/** A cargo metadata of a program linking the given crates (each a folder with the given files). */
function metadataOf(crates) {
  const registry = scratch();
  const packages = [{ name: 'awwo_local', version: '0.1.0' }, ...crates].map(({ name, version, license = null, files = [] }) => {
    const dir = path.join(registry, `${name}-${version}`);
    for (const [file, text] of files) write(path.join(dir, file), text);
    write(path.join(dir, 'Cargo.toml'), '');
    return { id: `${name} ${version}`, name, version, license, license_file: null, manifest_path: path.join(dir, 'Cargo.toml') };
  });
  const nodes = [{ id: packages[0].id, deps: packages.slice(1).map(item => ({ pkg: item.id, dep_kinds: [{ kind: null, target: null }] })) }];
  return { packages, resolve: { root: packages[0].id, nodes } };
}

test('the crates whose licences are fetched: those shipping none, but not one under MPL alone, and webview2-com-sys', () => {
  const metadata = metadataOf([
    { name: 'ships', version: '1.0.0', license: 'MIT', files: [['LICENSE', MIT]] },
    { name: 'bare', version: '1.0.0', license: 'MIT' },
    { name: 'mpl-bare', version: '1.0.0', license: 'MPL-2.0' },
    { name: WEBVIEW2.crate, version: '0.38.2', license: 'MIT', files: [['LICENSE-MIT', MIT]] },
  ]);
  assert.deepEqual(needed(metadata).map(crate => crate.name).sort(), ['bare', WEBVIEW2.crate]);
});

test('a crate\'s fetched licences must be of its licence, and webview2-com-sys\'s SDK licence of the SDK it bundles', () => {
  const [, bare, webview] = metadataOf([
    { name: 'bare', version: '1.0.0', license: 'MIT' },
    { name: WEBVIEW2.crate, version: '0.38.2', license: 'MIT', files: [['LICENSE-MIT', MIT]] },
  ]).packages;
  const folder = scratch();
  assert.deepEqual(crateFolderGaps(bare, path.join(folder, 'bare-1.0.0')), ['bare-1.0.0: no licence file']);
  write(path.join(folder, 'bare-1.0.0', 'LICENSE'), APACHE);
  assert.deepEqual(crateFolderGaps(bare, path.join(folder, 'bare-1.0.0')), ['bare-1.0.0: its files here are not of MIT']);
  write(path.join(folder, 'bare-1.0.0', 'LICENSE'), MIT);
  assert.deepEqual(crateFolderGaps(bare, path.join(folder, 'bare-1.0.0')), []);
  const key = `${WEBVIEW2.crate}-0.38.2`;
  assert.deepEqual(crateFolderGaps(webview, path.join(folder, key)), [`${key}: no WebView2 SDK licence`]);
  write(path.join(folder, key, 'WebView2-SDK-LICENSE.txt'), 'Copyright (C) Microsoft Corporation.');
  const of = sdk => ({ [key]: { files: { 'WebView2-SDK-LICENSE.txt': { url: `https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/${sdk}/x.nupkg (LICENSE.txt)` } } } });
  assert.deepEqual(crateFolderGaps(webview, path.join(folder, key), of('1.0.9999.0')), [`${key}: its WebView2 SDK licence is not of SDK 1.0.3650.58`]);
  assert.deepEqual(crateFolderGaps(webview, path.join(folder, key), of('1.0.3650.58')), []);
  assert.equal(webview2Sdk('0.38.2'), '1.0.3650.58');
  assert.throws(() => webview2Sdk('0.39.0'), /bundles a WebView2 SDK this script does not know/);
});

test('npm packages are read once a version, as the payload carries them, with their licence files or a README carrying it', () => {
  const modules = scratch();
  const pkg = (where, manifest, files = []) => {
    write(path.join(modules, ...where, 'package.json'), JSON.stringify(manifest));
    for (const [file, text] of files) write(path.join(modules, ...where, file), text);
  };
  pkg(['own'], { name: 'own', version: '1.0.0', license: 'MIT' }, [['LICENSE.md', MIT], ['README.md', 'x']]);
  pkg(['readme'], { name: 'readme', version: '4.0.1', license: 'MIT' }, [['README.md', `# readme\n\n## License\n\n${MIT}`]]);
  pkg(['bare'], { name: 'bare', version: '0.1.0', license: 'MIT' }, [['README.md', '## License\n\nMIT']]);
  pkg(['own', 'node_modules', 'own'], { name: 'own', version: '1.0.0', license: 'MIT' }, [['LICENSE', MIT]]);
  pkg(['@scope', 'old'], { name: '@scope/old', version: '2.0.0', license: { type: 'ISC' } }, [['MIT-LICENSE.txt', MIT]]);
  pkg(['@esbuild', 'darwin-arm64'], { name: '@esbuild/darwin-arm64', version: '0.28.1', os: ['darwin'] });
  pkg(['agent', 'node_modules', '@mariozechner', 'clipboard'], { name: '@mariozechner/clipboard', version: '0.3.9', license: 'MIT' });
  pkg(['agent', 'node_modules', '@mariozechner', 'clipboard-win32-x64-msvc'], { name: '@mariozechner/clipboard-win32-x64-msvc', version: '0.3.9', license: 'MIT', os: ['win32'] });
  pkg(['agent'], { name: 'agent', version: '1.0.0', license: 'Apache-2.0' }, [['LICENSE', APACHE]]);
  const found = installedPackages([modules]);
  assert.deepEqual(found.map(item => `${item.name}@${item.version}`), ['@scope/old@2.0.0', 'agent@1.0.0', 'bare@0.1.0', 'own@1.0.0', 'readme@4.0.1']);
  const by = name => found.find(item => item.name === name);
  assert.deepEqual(by('own').files.map(file => path.basename(file)), ['LICENSE.md']);
  assert.equal(by('@scope/old').licence, 'ISC');
  assert.equal(path.basename(by('readme').readme), 'README.md');
  assert.deepEqual([by('bare').files, by('bare').readme], [[], null], 'a README naming MIT without its text is not its licence');
  assert.equal(leftOutPackage('@mariozechner/clipboard-darwin-arm64'), true);
  assert.equal(leftOutPackage('@mariozechner/clipboarder'), false);
  assert.equal(folderOf('@aws-sdk/nested-clients', '3.997.44'), '@aws-sdk+nested-clients@3.997.44');
});

test('an npm package must be under a permissive licence, and its repository is found where package.json names it', () => {
  for (const licence of ['MIT', 'Apache-2.0', '(MIT OR Apache-2.0)', 'BlueOak-1.0.0', 'MIT AND ISC', 'GPL-2.0 OR MIT']) assert.equal(permissiveLicence(licence), true, licence);
  for (const licence of ['GPL-3.0', 'LGPL-2.1-or-later', 'MIT AND GPL-2.0', '(MIT OR Apache-2.0) AND GPL-3.0', 'GPL-2.0 WITH Classpath-exception-2.0', 'SEE LICENSE IN LICENSE', 'UNLICENSED', '']) {
    assert.equal(permissiveLicence(licence), false, licence);
  }
  assert.equal(githubRepository({ url: 'git+https://github.com/aws/aws-sdk-js-v3.git' }), 'aws/aws-sdk-js-v3');
  assert.equal(githubRepository('git://github.com/TooTallNate/node-data-uri-to-buffer.git'), 'TooTallNate/node-data-uri-to-buffer');
  assert.equal(githubRepository({ url: 'https://github.com/socketio/socket.io.git' }), 'socketio/socket.io');
  assert.equal(githubRepository('github:user/repo'), 'user/repo');
  assert.equal(githubRepository('user/repo'), 'user/repo');
  assert.equal(githubRepository({ url: 'https://gitlab.com/a/b.git' }), null);
  assert.deepEqual(repositoryFolders({ repository: { directory: 'packages-internal/credential-provider-http' } }), ['packages-internal/credential-provider-http', 'packages-internal', '']);
  assert.deepEqual(repositoryFolders({ repository: {}, homepage: 'https://github.com/standard-webhooks/standard-webhooks/tree/main/libraries/javascript' }), ['libraries/javascript', 'libraries', '']);
  assert.deepEqual(repositoryFolders({ repository: 'x/y', homepage: 'https://example.com' }), ['']);
});

test('the notices of code of others are read from PostgreSQL\'s source as its files\' headers have them', () => {
  const ours = '/*\n * Portions Copyright (c) 1996-2025, PostgreSQL Global Development Group\n * Portions Copyright (c) 1994, Regents of the University of California\n */\n';
  const bsd = '/*\n * Copyright (c) 1988, 1993\n *\tThe Regents of the University of California.  All rights reserved.\n *\n * Redistribution and use in source and binary forms, with or without\n * modification, are permitted\n */';
  const isc = '/*\n * Copyright (c) 1996,1999 by Internet Software Consortium.\n */';
  assert.deepEqual(othersNotices(`${ours}int x;\n`), [], 'PostgreSQL\'s own notice is its licence\'s');
  assert.deepEqual(othersNotices(`${bsd}\n${ours}int x; /* a comment */\n`), [bsd]);
  assert.deepEqual(othersNotices(`${isc}\nint y;\n`), [isc], 'a copyright line of someone else alone');
  assert.deepEqual(othersNotices('# Copyright (C) 2001 earthian@tama.or.jp, All Rights Reserved.\n# You can use, modify, distribute this table freely.\n0x00 0x00\n'),
    ['# Copyright (C) 2001 earthian@tama.or.jp, All Rights Reserved.\n# You can use, modify, distribute this table freely.'], 'a mapping table\'s "#" header');
  const tree = scratch();
  write(path.join(tree, 'src', 'port', 'snprintf.c'), `${bsd}\nint z;\n`);
  write(path.join(tree, 'src', 'backend', 'regex', 'COPYRIGHT'), 'This software is copyrighted by Henry Spencer.\n');
  write(path.join(tree, 'src', 'backend', 'utils', 'own.c'), `${ours}int w;\n`);
  for (const skipped of [['src', 'pl', 'plperl', 'SPI.c'], ['src', 'test', 'regress', 'x.c'], ['src', 'bin', 'psql', 't', 'x.pl'], ['src', 'tools', 'x.c']]) write(path.join(tree, ...skipped), `${bsd}\n`);
  const notices = sourceNotices(tree, 'postgresql-18.4');
  assert.deepEqual([...notices.matchAll(/^== (.+) ==$/gm)].map(match => match[1]), ['src/backend/regex/COPYRIGHT', 'src/port/snprintf.c']);
  assert.match(notices, /This software is copyrighted by Henry Spencer\./);
});

test('PostgreSQL\'s libraries are carried only as listed: its version, the bytes of each DLL, PostgreSQL\'s own modules', () => {
  const listed = POSTGRES_LIBRARIES.libraries.flatMap(library => Object.entries(library.dlls).map(([name, sha256]) => ({ name, sha256 })));
  const bin = [...listed, ...[...POSTGRES_OWN_LIBRARIES, 'vcruntime140.dll', 'msvcp140_atomic_wait.dll'].map(name => ({ name, sha256: 'x' })),
    { name: 'postgres.exe', sha256: null }, { name: 'initdb.exe', sha256: null }];
  const lib = [{ name: 'plpgsql.dll', company: POSTGRES_COMPANY }, { name: 'pgcrypto.dll', company: POSTGRES_COMPANY }, { name: 'plpgsql.control', company: '' }];
  const version = POSTGRES_LIBRARIES.postgres;
  assert.deepEqual(postgresLibraryGaps({ bin, lib, version }), []);
  assert.deepEqual(postgresLibraryGaps({ bin: [...bin, { name: 'libnew-1.dll', sha256: 'y' }], lib, version }), ['libnew-1.dll is not in the list']);
  assert.deepEqual(postgresLibraryGaps({ bin: bin.map(file => file.name === 'libiconv-2.dll' ? { ...file, sha256: 'another build' } : file), lib, version }), ['libiconv-2.dll is not the build listed (other bytes)']);
  assert.deepEqual(postgresLibraryGaps({ bin: bin.filter(file => file.name !== 'libintl-9.dll'), lib, version }), ['libintl-9.dll is listed but not there']);
  assert.deepEqual(postgresLibraryGaps({ bin, lib: [...lib, { name: 'plugin_debugger.dll', company: '' }], version }), ['lib/plugin_debugger.dll is not PostgreSQL\'s own (made by no one it names)']);
  assert.deepEqual(postgresLibraryGaps({ bin, lib, version: '19.0' }), [`the libraries are listed for PostgreSQL ${version}, not 19.0`]);
  assert.deepEqual(postgresLibraryGaps({ bin, lib, version: null }), [`the libraries are listed for PostgreSQL ${version}, not an unknown version`]);
  assert.equal(postgresVersionOf('postgres (PostgreSQL) 18.4\n'), '18.4');
  assert.equal(postgresVersionOf(''), null);
  // Each LGPL library has its source; every other its licence files.
  for (const library of POSTGRES_LIBRARIES.libraries) {
    if (/LGPL/.test(library.licence)) assert.match(library.source?.sha256 || '', /^[0-9a-f]{64}$/, library.name);
    else assert.ok(Object.keys(library.files).length, library.name);
    for (const sha256 of Object.values(library.dlls)) assert.match(sha256, /^[0-9a-f]{64}$/, library.name);
  }
});

test('the macOS archive\'s libraries are carried only as listed: its version, each dylib\'s bytes, the links its programs load through', () => {
  const lib = [
    ...POSTGRES_MACOS_LIBRARIES.libraries.flatMap(library => Object.entries(library.dylibs).map(([name, sha256]) => ({ name, kind: 'file', sha256 }))),
    ...POSTGRES_MACOS_LIBRARIES.libraries.flatMap(library => Object.entries(library.links || {}).map(([name, target]) => ({ name, kind: 'symlink', target }))),
  ];
  const version = POSTGRES_MACOS_LIBRARIES.postgres;
  assert.deepEqual(postgresMacosLibraryGaps({ lib, version }), []);
  assert.deepEqual(postgresMacosLibraryGaps({ lib: [...lib, { name: 'libintl.8.dylib', kind: 'file', sha256: 'y' }], version }), ['libintl.8.dylib is not in the list']);
  assert.deepEqual(postgresMacosLibraryGaps({ lib: lib.map(file => file.name === 'libiconv.2.dylib' ? { ...file, sha256: 'another build' } : file), version }), ['libiconv.2.dylib is not the build listed (other bytes)']);
  assert.deepEqual(postgresMacosLibraryGaps({ lib: lib.filter(file => file.name !== 'libedit.0.dylib'), version }), ['libedit.0.dylib is listed but not there']);
  assert.deepEqual(postgresMacosLibraryGaps({ lib: [...lib, { name: 'libpq.dylib', kind: 'symlink', target: 'libpq.5.dylib' }], version }), ['libpq.dylib is a link the list does not name (to libpq.5.dylib)']);
  assert.deepEqual(postgresMacosLibraryGaps({ lib: lib.map(file => file.name === 'libz.1.dylib' ? { ...file, target: '../../elsewhere/libz.dylib' } : file), version }), ['libz.1.dylib leads to ../../elsewhere/libz.dylib, not libz.1.3.2.dylib']);
  assert.deepEqual(postgresMacosLibraryGaps({ lib: lib.filter(file => file.name !== 'libicui18n.dylib'), version }), ['libicui18n.dylib is listed as a link but not there as one']);
  assert.deepEqual(postgresMacosLibraryGaps({ lib, version: '18.5' }), [`the libraries are listed for PostgreSQL ${version}, not 18.5`]);
  // Every dylib's link leads beside it; the LGPL library has its source; every library its licence files, each of which
  // is in third_party/postgres-macos as fetched, and of the licence its library is under.
  const folder = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'third_party', 'postgres-macos');
  assert.deepEqual(provenanceDifferences(folder), []);
  for (const library of POSTGRES_MACOS_LIBRARIES.libraries) {
    for (const [link, target] of Object.entries(library.links || {})) assert.ok(target in library.dylibs && !link.includes('/'), link);
    if (/LGPL/.test(library.licence)) assert.match(library.source?.sha256 || '', /^[0-9a-f]{64}$/, library.name);
    for (const sha256 of Object.values(library.dylibs)) assert.match(sha256, /^[0-9a-f]{64}$/, library.name);
    const names = Object.keys(library.files);
    assert.ok(names.length, library.name);
    const texts = names.map(name => readFileSync(path.join(folder, `${library.name}-${library.version}`, name), 'utf8'));
    assert.ok(licenceTextMatches(library.licence, texts), `${library.name}'s files are of ${library.licence}`);
  }
});
