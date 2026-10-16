import assert from 'node:assert/strict';
import { chmodSync, existsSync, linkSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildEnvironment, checksumLines, copyNotices, noticePaths, parseImage, parseOptions, removeBuildTree, requiredNotices, runtimeSource, uncoveredNotices, validateTarget, verifyCore, withBuildCleanup } from './awwo-saas-release.ts';
import { OUTPUT as goLicences, TARGET, bundleDifferences, bundleToolchain, checkLinkedModules, collectGoLicences, commentFamily, docFile, goLicenceBundle, goSums, licenceIds, linkedModules, moduleHash, noticeFile, sourceNotice, writeBundle } from './awwo-go-licences.ts';
import type { GoPackage } from './awwo-go-licences.ts';
import { UPSTREAM_REVISION, PATCH_VERSION } from '../apps/openmaus-worker/setup.ts';

const repository = fileURLToPath(new URL('..', import.meta.url));
const trackedFiles = (): string[] => execFileSync('git', ['ls-files', '-z'], { cwd: repository, encoding: 'utf8', maxBuffer: 256 << 20 }).split('\0').filter(Boolean);
const carried = (file: string): boolean => noticePaths.some(path => file === path || file.startsWith(`${path}/`));
const parentOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf('/')));

test('release requires Linux amd64 and Node 24; Docker identity must match that target', () => {
  validateTarget('linux', 'x64', 24);
  for (const values of [['darwin', 'arm64', 24], ['linux', 'arm64', 26], ['linux', 'x64', 22]] as const) assert.throws(() => validateTarget(values[0], values[1], values[2]));
  const image = { Id: 'sha256:' + 'a'.repeat(64), Os: 'linux', Architecture: 'amd64' };
  assert.deepEqual(parseImage(JSON.stringify(image)), image);
  for (const value of [null, {}, { ...image, Architecture: 'arm64' }, { ...image, Id: 'latest' }]) assert.throws(() => parseImage(JSON.stringify(value)));
  assert.equal(parseOptions(['--docker-context', 'default']).dockerContext, 'default');
  assert.throws(() => parseOptions(['--docker-context', '../foreign']));
});
test('runtime allowlist excludes credentials, private state and tests', () => {
  for (const name of ['server.mjs', 'workspace-sandbox.ts', 'package.json', 'package-lock.json']) assert.equal(runtimeSource(name), true);
  for (const name of ['.env', '.env.example', 'node_modules', '.runtime', 'test-support.mjs', 'config.test.mjs', 'terminal-exit-fixture.mjs', 'README.md']) assert.equal(runtimeSource(name), false);
});
test('checksums cover relative npm bin links but reject escaped links and special filenames', t => {
  const root = mkdtempSync(join(tmpdir(), 'awwo-release-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const release = join(root, 'release'); mkdirSync(release);
  writeFileSync(join(release, 'entry.js'), 'verified'); symlinkSync('entry.js', join(release, 'entry-bin'));
  const lines = checksumLines(release); assert.equal(lines.length, 2); assert.equal(lines[0]!.split('  ')[0], lines[1]!.split('  ')[0]);
  writeFileSync(join(root, 'private-key'), 'must not be read'); symlinkSync('../private-key', join(release, 'escape'));
  assert.throws(() => checksumLines(release), /Unsafe release symlink/);
  rmSync(join(release, 'escape')); writeFileSync(join(release, 'unsafe\nname'), 'value');
  assert.throws(() => checksumLines(release), /Unsupported release filename/);
});
test('core manifest and attribution must be present and enterprise must be absent', t => {
  const root = mkdtempSync(join(tmpdir(), 'awwo-core-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'awwo-build.json'), JSON.stringify({ upstreamRevision: UPSTREAM_REVISION, patchVersion: PATCH_VERSION }));
  for (const name of ['index.js', 'LICENSE', 'NOTICE']) writeFileSync(join(root, name), 'fixture');
  mkdirSync(join(root, 'third_party')); verifyCore(root);
  mkdirSync(join(root, 'enterprise')); assert.throws(() => verifyCore(root), /licensing boundary/);
});

test('isolated npm configuration actually loads both empty scopes and Go accepts writable module cache flags', t => {
  const root = mkdtempSync(join(tmpdir(), 'awwo-release-environment-'));
  t.after(() => removeBuildTree(root));
  const env = buildEnvironment(root);
  const options = { cwd: root, env, encoding: 'utf8' as const, timeout: 30_000 };
  // Reproduce the original npm error with distinct new files collapsed to one path.
  assert.throws(() => execFileSync('npm', ['config', 'list', '--json'], { ...options, env: { ...env, npm_config_globalconfig: env.npm_config_userconfig }, stdio: ['ignore', 'pipe', 'pipe'] }));
  assert.match(execFileSync('npm', ['--version'], options).trim(), /^\d+\.\d+\.\d+/);
  const configuration = JSON.parse(execFileSync('npm', ['config', 'list', '--json'], options));
  assert.equal(configuration.userconfig, env.npm_config_userconfig);
  assert.equal(configuration.globalconfig, env.npm_config_globalconfig);
  assert.equal(readFileSync(configuration.userconfig, 'utf8'), '');
  assert.equal(readFileSync(configuration.globalconfig, 'utf8'), '');
  assert.equal(execFileSync('go', ['env', 'GOFLAGS'], options).trim(), '-modcacherw');
});

test('cleanup removes nested read-only module directories without following external symlinks', t => {
  const parent = mkdtempSync(join(tmpdir(), 'awwo-release-cleanup-'));
  t.after(() => removeBuildTree(parent));
  const build = join(parent, 'build'), nested = join(build, 'go/pkg/mod/example/module@v1/nested'), outside = join(parent, 'outside');
  mkdirSync(nested, { recursive: true }); mkdirSync(outside);
  writeFileSync(join(nested, 'module.go'), 'package module'); writeFileSync(join(outside, 'keep'), 'outside retained');
  symlinkSync(outside, join(build, 'outside-link'));
  chmodSync(outside, 0o500); chmodSync(nested, 0o500); chmodSync(join(build, 'go/pkg/mod/example/module@v1'), 0o555);
  // Linux reports EACCES; Node on macOS can report the non-empty parent instead.
  if (process.getuid?.() !== 0) assert.throws(() => rmSync(build, { recursive: true, force: true }), error => ['EACCES', 'EPERM', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code || ''));
  if (!existsSync(join(build, 'outside-link'))) symlinkSync(outside, join(build, 'outside-link'));
  const original = new Error('npm install failed first');
  assert.throws(() => withBuildCleanup(build, () => { throw original; }), error => error === original);
  assert.equal(existsSync(build), false);
  assert.equal(readFileSync(join(outside, 'keep'), 'utf8'), 'outside retained');
  assert.equal(statSync(outside).mode & 0o777, 0o500);
});

test('a cleanup failure cannot replace the original build failure', () => {
  const original = new Error('original build failure'), cleanup = new Error('cleanup failure'), reports: string[] = [];
  assert.throws(() => withBuildCleanup('/synthetic-owned-build', () => { throw original; }, () => { throw cleanup; }, message => reports.push(message)), error => error === original);
  assert.equal(reports.length, 1);
  assert.throws(() => withBuildCleanup('/synthetic-owned-build', () => 'complete', () => { throw cleanup; }), error => error === cleanup);
});

const APACHE = readFileSync(join(repository, 'third_party/adapted/berd/LICENSE'), 'utf8');
const MIT = readFileSync(join(repository, 'third_party/wshobson-agents/LICENSE'), 'utf8');
const BSD3 = readFileSync(join(repository, goLicences, 'go/LICENSE'), 'utf8');
const ISC = `Copyright (c) 2026 Example\n\nPermission to use, copy, modify, and/or distribute this software for any\npurpose with or without fee is hereby granted, provided that the above\ncopyright notice and this permission notice appear in all copies.\n\nTHE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES.\n`;

test('license files are told apart from code, and the hint for an unreviewed text names what it grants or nothing', () => {
  for (const name of ['LICENSE', 'LICENSE.txt', 'LICENSE.libyaml', 'LICENSE-APACHE', 'LICENSE_1_0.txt', 'LICENSES.md', 'licence.md', 'NOTICE', 'NOTICE.txt', 'NOTICES',
    'ThirdPartyNotices.txt', 'OFL.txt', 'PATENTS', 'COPYING', 'UNLICENSE']) assert.equal(noticeFile(name), true, name);
  for (const name of ['notice_response.go', 'license.go', 'licenses.go', 'README.md', 'build-skill-licences.mjs']) assert.equal(noticeFile(name), false, name);
  for (const name of ['README', 'README.md', 'readme.txt', 'CREDITS']) assert.equal(docFile(name), true, name);
  for (const name of ['readme.go', 'LICENSE', 'notes.md']) assert.equal(docFile(name), false, name);
  for (const [name, family] of [['print.go', 'c'], ['memmove_amd64.s', 'c'], ['lib.min.js', 'c'], ['site.css', 'c'], ['data.json', 'c'], ['config.yaml', 'hash'],
    ['build.sh', 'hash'], ['gen.py', 'hash'], ['page.html', 'markup'], ['icon.svg', 'markup'], ['notes.txt', 'plain'], ['README.md', 'plain'], ['blob.bin', 'plain']]) {
    assert.equal(commentFamily(name), family, name);
  }
  const bsd2 = BSD3.replace(/ {3}\* Neither the name[^]*?permission\.\n/, '');
  assert.notEqual(bsd2, BSD3);
  assert.deepEqual(licenceIds(APACHE), ['Apache-2.0']);
  assert.deepEqual(licenceIds(MIT), ['MIT']);
  assert.deepEqual(licenceIds(BSD3), ['BSD-3-Clause']);
  assert.deepEqual(licenceIds(bsd2), ['BSD-2-Clause']);
  assert.deepEqual(licenceIds(ISC), ['ISC']);
  // OpenTelemetry's LICENSE: Apache-2.0, then the BSD-3-Clause of code taken from Go.
  assert.deepEqual(licenceIds(`${APACHE}\n${'-'.repeat(80)}\n\n${BSD3}`), ['Apache-2.0', 'BSD-3-Clause']);
  // A license copied from a source header keeps its comment markers.
  assert.deepEqual(licenceIds(BSD3.split('\n').map(line => ` * ${line}`).join('\n')), ['BSD-3-Clause']);
  assert.deepEqual(licenceIds(BSD3.split('\n').map(line => `# ${line}`).join('\n')), ['BSD-3-Clause']);
  // Naming a license is not granting it, and some terms always need a person.
  assert.deepEqual(licenceIds('Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License.\n'), []);
  assert.deepEqual(licenceIds(BSD3.replace(' * Neither', ' * All advertising materials mentioning features or use of this software must display an acknowledgement.\n   * Neither')), []);
  assert.deepEqual(licenceIds(`${MIT}\nParts of it are also under the GNU Lesser General Public License.\n`), []);
  assert.deepEqual(licenceIds(`${APACHE}\n"Commons Clause" License Condition v1.0\nThe Software is provided to you by the Licensor under the License, subject to the following condition.\n`), []);
  assert.deepEqual(licenceIds('Copyright 2026 Example. All rights reserved.\n'), []);
});

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

test('a source file gives the comment blocks that grant a license of its own, exactly as written', () => {
  const block = ['// Derived from example.org/memmove.', '//', '// Copyright 1999 Example Ltd.', '//', '// Permission is hereby granted, free of charge, to any person obtaining a copy.'].join('\n');
  const c = '/*\nCopyright 2011 Example Foundation.\n\nRedistribution and use in source and binary forms, with or without\nmodification, are permitted.\n*/';
  assert.equal(sourceNotice(`// Copyright 2009 The Go Authors.\n\npackage x\n\n${block}\nfunc f() {}\n`, new Set()), `${block}\n`);
  assert.equal(sourceNotice(`${c}\npackage y\n\n${block}\n`, new Set()), `${c}\n\n${block}\n`);
  // Two grants in one block give it once.
  assert.equal(sourceNotice(`${block}\n// Permission to use, copy, modify, and distribute this software is freely granted.\npackage z\n`, new Set()), `${block}\n// Permission to use, copy, modify, and distribute this software is freely granted.\n`);
  // A header naming one of the module's own licenses grants nothing of its own; one naming another does.
  assert.equal(sourceNotice('// Licensed under the Apache License, Version 2.0 (the "License");\npackage p\n', new Set(['Apache-2.0'])), '');
  assert.equal(sourceNotice('// Copyright The Example Authors\n// SPDX-License-Identifier: Apache-2.0\npackage p\n', new Set(['Apache-2.0'])), '');
  assert.equal(sourceNotice('// Copyright The Example Authors\n// SPDX-License-Identifier: MPL-2.0\npackage p\n', new Set(['Apache-2.0'])), '// Copyright The Example Authors\n// SPDX-License-Identifier: MPL-2.0\n');
  assert.equal(sourceNotice('// Use of this source code is governed by a BSD-style license that can be found in the LICENSE file.\npackage p\n', new Set(['BSD-3-Clause'])), '');
  // The module's own license in other words, in the variant it grants.
  for (const [header, own] of [['// Licensed under the 3-clause BSD license.', 'BSD-3-Clause'], ['// Licensed under the Apache License 2.0; see LICENSE.', 'Apache-2.0'],
    ['// Licensed under MIT (see LICENSE).', 'MIT'], ['// Licensed under the terms of the MIT license.', 'MIT'], ['// The MIT License (MIT)', 'MIT'],
    ['// Use of this source code is governed by the new BSD license.', 'BSD-3-Clause'], ['// The parser is MIT licensed.', 'MIT'], ['// Licensed under BSD.', 'BSD-3-Clause'],
    ['// License: BSD-3-Clause', 'BSD-3-Clause'], ['// See the License for the specific language governing permissions and\n// limitations under the License.', 'Apache-2.0'],
    ['// This License applies to the code below.', 'MIT']] as const) {
    assert.equal(sourceNotice(`${header}\npackage p\n`, new Set([own])), '', header);
  }
  // An SPDX expression, a license the module does not grant (also another variant of its own), a public-domain
  // dedication, a copyleft, content or font license, or a grant goes to a person.
  for (const header of ['// SPDX-License-Identifier: BSD-3-Clause AND GPL-3.0-only', '// SPDX-License-Identifier: (MIT OR Apache-2.0)', '// SPDX-License-Identifier: Apache-2.0 WITH LLVM-exception', '// Parts are under the MIT license.',
    '// The README says the software is in public\n// domain.', '// Dual licensed with the GNU Lesser General Public License.', '// Licensed under the PostgreSQL License.',
    '// Licensed under the very permissive public license.', '// This file follows the Python Software Foundation License.', '// Copyright 1998 The OpenSSL Project; see the OpenSSL\n// License.',
    '// Licensed under the BSD 4-Clause License.', '// Licensed under the Apache License, Version 1.1.', '// Parts are under a 2-clause BSD license.', '// Licensed under the Apache Software License.',
    '// Parts are under the simplified BSD license.', '// The parser is ISC licensed.',
    '// Use of this source code is governed by an MIT-style license.', '// Licensed under MIT (https://example.org/LICENSE)', '// The icons are licensed under CC BY-SA 4.0.',
    '// (Icons: CC BY 4.0, Fonts: SIL OFL 1.1, Code: MIT License)', '// PSF hereby grants Licensee a nonexclusive, royalty-free, world-wide license.',
    '// Parts are under the BSD 2-Clause "Simplified" License.', '// Parts are under the PostgreSQL license.', '// Parts are under a BSD-like license.',
    '// Parts are under the BSD-2-Clause-Patent license.', '// License: MIT', '/* lib v1 | Example | Licence: ISC */']) {
    assert.equal(sourceNotice(`${header}\npackage p\n`, new Set(['BSD-3-Clause', 'Apache-2.0'])), `${header}\n`, header);
  }
  // A variant the module does not grant, wherever it is written: in the name, after it, or on the next comment line.
  for (const [header, own] of [['// Licensed under the MIT/X11 license.', 'MIT'], ['// Parts are under the old BSD license.', 'BSD-3-Clause'], ['// Parts are under the BSD license (4-clause).', 'BSD-3-Clause'],
    ['// Licensed under the Apache License,\n// Version 1.1.', 'Apache-2.0'], ['// Code from the FreeBSD license.', 'BSD-3-Clause'], ['// Parts are under the mit/x11 license.', 'MIT'],
    ['// Under a two-clause BSD license.', 'BSD-3-Clause']] as const) {
    assert.equal(sourceNotice(`${header}\npackage p\n`, new Set([own])), `${header}\n`, header);
  }
  assert.equal(sourceNotice('// Under a two-clause BSD license.\npackage p\n', new Set(['BSD-2-Clause'])), '');
  // The same clause count or version given twice is still that variant; two that disagree are another license.
  assert.equal(sourceNotice('// Licensed under the BSD 2-Clause "Simplified" License.\npackage p\n', new Set(['BSD-2-Clause'])), '');
  assert.equal(sourceNotice('// Licensed under the Apache-2.0 License, Version 2.0.\npackage p\n', new Set(['Apache-2.0'])), '');
  for (const header of ['// Licensed under the Simplified BSD-3-Clause Simplified License.', '// Licensed under the 2.0 Apache-1.1 License.']) {
    assert.equal(sourceNotice(`${header}\npackage p\n`, new Set(['BSD-2-Clause', 'Apache-2.0'])), `${header}\n`, header);
  }
  // A name's words stay on one line, so the module's own SPDX header does not hide the license after it; being a
  // copyright notice right above it, that header comes with it.
  const postgres = '// PostgreSQL License\n//\n// Portions Copyright (c) 1996-2024, The PostgreSQL Global Development Group\n';
  const header = '// Copyright 2024 The Example Authors\n// SPDX-License-Identifier: BSD-3-Clause\n\n';
  assert.equal(sourceNotice(`${header}${postgres}package p\n`, new Set(['BSD-3-Clause'])), `${header}${postgres}`);
  assert.equal(sourceNotice(`// SPDX-License-Identifier: BSD-3-Clause\n\n${postgres}package p\n`, new Set(['BSD-3-Clause'])), postgres);
  // Wording that wraps across comment lines still counts.
  assert.equal(sourceNotice('// Copyright 2015 Example\n//\n// Permission is\n// hereby granted, free of charge.\npackage p\n', new Set()), '// Copyright 2015 Example\n//\n// Permission is\n// hereby granted, free of charge.\n');
  // A "/*" inside a string does not open a comment, and a grant inside a literal gives the literal's lines.
  assert.equal(sourceNotice('var glob = "/*"\n\n// Permission is hereby granted, free of charge.\nfunc f() {}\n', new Set()), '// Permission is hereby granted, free of charge.\n');
  const raw = 'const licence = `Copyright 2020 Example\n\nPermission is hereby granted, free of charge.`';
  assert.equal(sourceNotice(`package p\n\n${raw}\n\nfunc f() {}\n`, new Set()), `${raw}\n`);
  // An escaped delimiter does not end a literal, so none of its terms are left out.
  const template = 'const notice = `Copyright 2020 Example\nPermission is hereby granted, \\`provided\\` that\nTHE SOFTWARE IS PROVIDED "AS IS".`;\n';
  assert.equal(sourceNotice(`${template}var x = 1;\n`, new Set()), template);
  const quoted = '"""Example.\n\nPermission is hereby granted, \\"""free\\""" of charge.\nTHE SOFTWARE IS PROVIDED "AS IS".\n"""\n';
  assert.equal(sourceNotice(`${quoted}import os\n`, new Set(), 'hash'), quoted);
  // A notice keeps the copyright line in the comment above it, past blank lines.
  const preamble = '// Copyright (c) 2012 Foo\n\n// Permission is hereby granted, free of charge.\n';
  assert.equal(sourceNotice(`package p\n\n${preamble}func f() {}\n`, new Set()), preamble);
  const above = '// Copyright 2020 Example\n/* Permission to use, copy, modify, and distribute this software is freely granted. */\n';
  assert.equal(sourceNotice(`package p\n\n${above}func f() {}\n`, new Set()), above);
  // So does a comment block that ends just above; a literal there is code, not a notice.
  const blockAbove = '/* Copyright 2020 Example */\n\n// Permission is hereby granted, free of charge.\n';
  assert.equal(sourceNotice(`package p\n\n${blockAbove}func f() {}\n`, new Set()), blockAbove);
  const pageAbove = '<!-- Copyright 2020 Example -->\n<!-- Permission is hereby granted, free of charge. -->\n';
  assert.equal(sourceNotice(`<html>\n${pageAbove}<body></body>\n`, new Set(), 'markup'), pageAbove);
  assert.equal(sourceNotice('var s = "Copyright 2020 Example"\n// Permission is hereby granted, free of charge.\nfunc f() {}\n', new Set()), '// Permission is hereby granted, free of charge.\n');
  // Nor is a block that shares its line with code, or one without a copyright notice; a block of several lines, or two
  // blocks on one line, come whole.
  assert.equal(sourceNotice('/* Copyright 2020 Example */ const unrelated = 1;\n// Permission is hereby granted, free of charge.\nfunc f() {}\n', new Set()), '// Permission is hereby granted, free of charge.\n');
  assert.equal(sourceNotice('var x = 1 /* (c) Example */\n// Permission is hereby granted, free of charge.\nfunc f() {}\n', new Set()), '// Permission is hereby granted, free of charge.\n');
  assert.equal(sourceNotice('/* Just a note. */\n\n// Permission is hereby granted, free of charge.\nfunc f() {}\n', new Set()), '// Permission is hereby granted, free of charge.\n');
  const blockHeader = '/*\n * Copyright 2020 Example\n */\n\n// Permission is hereby granted, free of charge.\n';
  assert.equal(sourceNotice(`package p\n\n${blockHeader}func f() {}\n`, new Set()), blockHeader);
  const pair = '/* note */ /* Copyright 2020 Example */\n// Permission is hereby granted, free of charge.\n';
  assert.equal(sourceNotice(`package p\n\n${pair}func f() {}\n`, new Set()), pair);
  // "(c)" in a formula is no copyright notice.
  assert.equal(sourceNotice('// t(c) is the time at c.\n// Permission is hereby granted, free of charge.\nfunc f() {}\n', new Set()), '// t(c) is the time at c.\n// Permission is hereby granted, free of charge.\n');
  assert.equal(sourceNotice('/* computes t(c) */\n// Permission is hereby granted, free of charge.\nfunc f() {}\n', new Set()), '// Permission is hereby granted, free of charge.\n');
  // A grant whose words go on past a blank line keeps both comments.
  const split = '// Permission is\n\n// hereby granted, free of charge.\n';
  assert.equal(sourceNotice(`package p\n\n${split}func f() {}\n`, new Set()), split);
  // Two notices on touching lines are one excerpt, with no line added between them.
  const touching = '/* Permission is hereby granted, free of charge. */\n// SPDX-License-Identifier: MPL-2.0\n';
  assert.equal(sourceNotice(`${touching}package p\n`, new Set()), touching);
  // A comment after code goes on in the comment lines right below it.
  const trailing = 'var x = 1 // Licensed under the PostgreSQL License,\n// Portions Copyright (c) 1996-2024, The PostgreSQL Global Development Group\n';
  assert.equal(sourceNotice(`${trailing}var y = 2\n`, new Set()), trailing);
  // A comment after code is its line alone; a name that goes on below it brings the lines it takes, with nothing added.
  assert.equal(sourceNotice('package p\n\n// Package p.\nvar x = 1 // Licensed under the PostgreSQL License.\nvar y = 2\n', new Set()), 'var x = 1 // Licensed under the PostgreSQL License.\n');
  assert.equal(sourceNotice('var x = 1 // Licensed under the\n// PostgreSQL License.\nvar y = 2\n', new Set()), 'var x = 1 // Licensed under the\n// PostgreSQL License.\n');
  assert.equal(sourceNotice('var x = 1 // Licensed under a BSD 4-Clause\n// license.\nvar y = 2\n', new Set(['BSD-3-Clause'])), 'var x = 1 // Licensed under a BSD 4-Clause\n// license.\n');
  // Each file by its family: a bundled script's /*! … */ banner, a page's <!-- … --> notice (an apostrophe in its text
  // opens nothing), a # comment run (its quotes and its /* are words in it), a Python docstring; plain text, or a
  // license outside any comment, gives the whole file.
  assert.equal(sourceNotice('/*! lib v1 | (c) Example | @license MIT */\nvar lib = 1;\n', new Set()), '/*! lib v1 | (c) Example | @license MIT */\n');
  const page = '<!--\n  Copyright 2020 Example\n  Permission is hereby granted, free of charge.\n-->';
  assert.equal(sourceNotice(`<html>\n<p>Don't</p>\n${page}\n<body></body>\n`, new Set(), 'markup'), `${page}\n`);
  assert.equal(sourceNotice('key: value\n# Copyright 2020 Example\n# Permission is hereby granted,\n# free of charge.\nother: 1\n', new Set(), 'hash'), '# Copyright 2020 Example\n# Permission is hereby granted,\n# free of charge.\n');
  const run = '# Copyright 2020 Example\n# Licensed under the "PostgreSQL License"; it\'s below.\n# Clean with rm -f out/*.o\n';
  assert.equal(sourceNotice(`set -u\n${run}set -e\nmake all\n`, new Set(), 'hash'), run);
  const doc = '"""Example module.\n\nCopyright 2020 Example\n\nPermission is hereby granted, free of charge, to any person.\n"""';
  assert.equal(sourceNotice(`${doc}\nimport os\n`, new Set(), 'hash'), `${doc}\n`);
  const text = 'Example data\n\nCopyright 2020 Example\n\nIt\'s free: permission is hereby granted, free of charge.\n\nTHE SOFTWARE IS PROVIDED "AS IS".\n';
  assert.equal(sourceNotice(text, new Set(), 'plain'), text);
  // A file that ends without a newline keeps that end.
  assert.equal(sourceNotice(text.trimEnd(), new Set(), 'plain'), text.trimEnd());
  assert.equal(sourceNotice('package p\n// Licensed under the PostgreSQL License.', new Set()), '// Licensed under the PostgreSQL License.');
  const html = '<p>Released under the MIT license.</p>\n<p>Copyright 2020 Example</p>\n';
  assert.equal(sourceNotice(html, new Set(['MIT']), 'markup'), html);
  const latin1 = Buffer.concat([Buffer.from('// Copyright '), Buffer.from([0xa9]), Buffer.from(' 1999 Example\n// Permission is hereby granted.\npackage p\n')]);
  assert.ok(Buffer.from(sourceNotice(latin1.toString('latin1'), new Set()), 'latin1').equals(latin1.subarray(0, latin1.indexOf('package'))));
});

test('the Go license bundle walks from each linked package up to its module root, after checking the module against go.sum', t => {
  const root = mkdtempSync(join(tmpdir(), 'awwo-go-licences-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path: string, data: string | Buffer): void => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), data); };
  const PATENTS = 'Additional IP Rights Grant (Patents)\n', NOTICE = 'Example notice\n';
  write('goroot/LICENSE', BSD3); write('goroot/PATENTS', PATENTS); write('goroot/src/fmt/print.go', 'package fmt\n');
  // A README a reviewer left out (it names the license of an image the binary does not contain), and the license of
  // an object file, which the binary never links without cgo.
  const GOPHER = '# Go\n\nGopher image by Renee French, licensed under the Creative Commons 4.0 Attribution license.\n';
  write('goroot/README.md', GOPHER);
  const BORING = 'The Go code here is under the usual Go license.\nAll advertising materials mentioning features or use of this software must display it.\n';
  write('goroot/src/crypto/internal/boring/LICENSE', BORING);
  write('goroot/src/crypto/internal/boring/notboring.go', 'package boring\n');
  // A compiled file that grants a license of its own gives its comment block, byte for byte (0xA9 is no UTF-8); a
  // header naming one of the module's own does not.
  const borrowed = Buffer.from(['// Copied from example.org/floats, © 2020.', '//', ...MIT.trimEnd().split('\n').map(line => (line ? `// ${line}` : '//')), ''].join('\n'), 'latin1');
  write('mod/LICENSE', MIT); write('mod/NOTICE', NOTICE); write('mod/client.go', '// Licensed under the MIT License.\n\npackage mod\n');
  write('mod/internal/third/LICENSE', BSD3); write('mod/internal/third/pkg/pkg.go', Buffer.concat([Buffer.from('package pkg\n\n'), borrowed, Buffer.from('func Equal() {}\n')]));
  // A README beside a linked package counts when its text grants a license (Go's nistec/fiat/README); one that only
  // names the module's own license does not.
  const readmeLicence = `The code here was generated by example-gen.\n\n${ISC}`;
  write('mod/internal/third/pkg/README', readmeLicence); write('mod/README.md', '# mod\n\nA module for tests.\n'); write('mod/proto/README.md', 'The proto package, MIT licensed.\n');
  write('mod/unlinked/LICENSE', ISC); write('mod/unlinked/unlinked.go', 'package unlinked\n'); write('mod/proto/notice_response.go', 'package proto\n');
  // A file the package embeds from below its directory brings that directory's license, and its own notice, by its
  // kind: a script's banner, all of a text file; a binary one is data.
  const script = '/*! lib v1 | Copyright 2020 Lib Authors | Permission is hereby granted, free of charge. */';
  const DATA = 'Bundled data\n\nCopyright 2020 Data Authors\n\nThe data\'s terms: permission is hereby granted, free of charge.\n';
  write('mod/proto/assets/vendor/lib.js', `${script}\nvar lib = 1;\n`); write('mod/proto/assets/vendor/LICENSE', ISC); write('mod/proto/assets/other/LICENSE', APACHE);
  write('mod/proto/assets/vendor/data.txt', DATA);
  mkdirSync(join(root, 'mod/proto/assets/vendor'), { recursive: true });
  writeFileSync(join(root, 'mod/proto/assets/vendor/blob.bin'), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from('Permission is hereby granted')]));
  const module = { path: 'example.com/mod', version: 'v1.2.3', dir: join(root, 'mod'), main: false, replaced: false };
  const packages: GoPackage[] = [
    { importPath: 'fmt', dir: join(root, 'goroot/src/fmt'), standard: true },
    { importPath: 'crypto/internal/boring', dir: join(root, 'goroot/src/crypto/internal/boring'), standard: true },
    { importPath: 'example.com/mod', dir: join(root, 'mod'), standard: false, module, compiled: ['client.go'] },
    { importPath: 'example.com/mod/internal/third/pkg', dir: join(root, 'mod/internal/third/pkg'), standard: false, module, compiled: ['pkg.go'] },
    { importPath: 'example.com/mod/proto', dir: join(root, 'mod/proto'), standard: false, module, embeds: ['assets/vendor/lib.js', 'assets/vendor/data.txt', 'assets/vendor/blob.bin'] },
    { importPath: 'awwo/backend/cmd/api', dir: join(root, 'main'), standard: false, module: { path: 'awwo/backend', version: '', dir: join(root, 'main'), main: true, replaced: false } },
  ];
  const sum = moduleHash(join(root, 'mod'), 'example.com/mod@v1.2.3');
  // What a reviewer recorded for each text; unrecorded texts and stale records both stop the bundle.
  const reviewed = new Map([[sha256(BSD3), 'BSD-3-Clause'], [sha256(PATENTS), 'PATENTS'], [sha256(MIT), 'MIT'], [sha256(NOTICE), 'NOTICE'], [sha256(ISC), 'ISC'],
    [sha256(borrowed), 'MIT'], [sha256(`${script}\n`), 'MIT'], [sha256(DATA), 'MIT'], [sha256(readmeLicence), 'ISC']]);
  const leftOut = new Map([[sha256(GOPHER), 'its license is the Gopher image\'s'], [sha256(BORING), 'it covers an object the binary does not link']]);
  const input = { packages, goroot: join(root, 'goroot'), sums: goSums(`example.com/mod v1.2.3 ${sum}\nexample.com/mod v1.2.3/go.mod h1:unused=\n`), goVersion: 'go1.27.1', reviewed, leftOut };
  const bundle = goLicenceBundle(input);
  assert.deepEqual([...bundle.keys()].sort(), ['README.md', 'example.com/mod@v1.2.3/LICENSE', 'example.com/mod@v1.2.3/NOTICE', 'example.com/mod@v1.2.3/internal/third/LICENSE',
    'example.com/mod@v1.2.3/internal/third/pkg/README', 'example.com/mod@v1.2.3/internal/third/pkg/pkg.go.notice', 'example.com/mod@v1.2.3/proto/assets/vendor/LICENSE',
    'example.com/mod@v1.2.3/proto/assets/vendor/data.txt.notice', 'example.com/mod@v1.2.3/proto/assets/vendor/lib.js.notice', 'go/LICENSE', 'go/PATENTS', 'modules.txt']);
  assert.equal(bundle.get('example.com/mod@v1.2.3/proto/assets/vendor/lib.js.notice')?.toString(), `${script}\n`);
  assert.equal(bundle.get('example.com/mod@v1.2.3/proto/assets/vendor/data.txt.notice')?.toString(), DATA);
  assert.ok(bundle.get('example.com/mod@v1.2.3/internal/third/pkg/pkg.go.notice')?.equals(borrowed));
  assert.equal(bundle.get('modules.txt')?.toString(), `go go1.27.1\nexample.com/mod v1.2.3 ${sum}\n`);
  for (const [path, file] of [['go/LICENSE', 'goroot/LICENSE'], ['example.com/mod@v1.2.3/NOTICE', 'mod/NOTICE']] as const) assert.ok(bundle.get(path)?.equals(readFileSync(join(root, file))), path);
  const readme = bundle.get('README.md')?.toString() ?? '';
  assert.match(readme, /^\| Go standard library and runtime \| go1\.27\.1 \| BSD-3-Clause \| \[LICENSE\]\(go\/LICENSE\), \[PATENTS\]\(go\/PATENTS\) \|$/m);
  assert.match(readme, /^\| example\.com\/mod \| v1\.2\.3 \| BSD-3-Clause, ISC, MIT \| \[LICENSE\]\(example\.com\/mod@v1\.2\.3\/LICENSE\), \[NOTICE\]/m);
  assert.match(readme, /\[internal\/third\/pkg\/README\]\(example\.com\/mod@v1\.2\.3\/internal\/third\/pkg\/README\)/);
  assert.match(readme, /^- `go\/README\.md` is left out: its license is the Gopher image's\.\n- `go\/src\/crypto\/internal\/boring\/LICENSE` is left out: it covers an object the binary does not link\.$/m);
  assert.match(readme, /and the\n1 modules below/);
  assert.match(readme, /^\| example\.com\/mod \| \[internal\/third\/pkg\/pkg\.go\]\(example\.com\/mod@v1\.2\.3\/internal\/third\/pkg\/pkg\.go\.notice\) \| MIT \|$/m);
  assert.throws(() => goLicenceBundle({ ...input, packages: [{ ...packages[2]!, syso: ['blob_amd64.syso'] }] }), /links blob_amd64\.syso: an object file/);
  // A text nobody has recorded, or left out, is named with its hash and a hint, every one of them at once.
  const withoutIsc = new Map([...reviewed].filter(([, grants]) => grants !== 'ISC'));
  assert.throws(() => goLicenceBundle({ ...input, reviewed: withoutIsc }), new RegExp(`proto/assets/vendor/LICENSE \\(${sha256(ISC)}\\): it reads like ISC`));
  assert.throws(() => goLicenceBundle({ ...input, leftOut: new Map() }), /go\/README\.md \([0-9a-f]{64}\): it mentions "Creative Commons"/);
  // A file left out is left out only with the bytes a person read: another BoringSSL license text is read again.
  assert.throws(() => goLicenceBundle({ ...input, leftOut: new Map([...leftOut].filter(([hash]) => hash !== sha256(BORING))) }),
    /go\/src\/crypto\/internal\/boring\/LICENSE \([0-9a-f]{64}\): it mentions "advertising materials mentioning"/);
  assert.throws(() => goLicenceBundle({ ...input, reviewed: new Map([...reviewed, [sha256('a license no file has'), 'MIT']]) }), new RegExp(`no longer links; remove them: ${sha256('a license no file has')}`));
  assert.throws(() => goLicenceBundle({ ...input, leftOut: new Map([...leftOut, [sha256('a file no module has'), 'gone']]) }), new RegExp(`no longer links; remove them: ${sha256('a file no module has')}`));
  assert.throws(() => goLicenceBundle({ ...input, sums: new Map() }), /no hash for example\.com\/mod@v1\.2\.3/);
  assert.throws(() => goLicenceBundle({ ...input, packages: [{ ...packages[2]!, module: { ...module, replaced: true } }] }), /replaced in backend\/go\.mod/);
  assert.throws(() => goLicenceBundle({ ...input, packages: [{ ...packages[2]!, dir: join(root, 'goroot/src/fmt') }] }), /is not inside/);
  assert.throws(() => goLicenceBundle({ ...input, packages: [{ ...packages[2]!, module: { ...module, path: 'example.com/../escape' } }] }), /Unexpected module/);
  // The module's files as they are now, after an edit below.
  const resummed = (): Map<string, string> => goSums(`example.com/mod v1.2.3 ${moduleHash(join(root, 'mod'), 'example.com/mod@v1.2.3')}\n`);
  // A README that names a license the module's license files do not grant goes to a person too.
  write('mod/proto/assets/vendor/CREDITS', 'lib.js is from example.org, under the Mozilla Public License 2.0.\n');
  assert.throws(() => goLicenceBundle({ ...input, sums: resummed() }), /proto\/assets\/vendor\/CREDITS \([0-9a-f]{64}\): it mentions "Mozilla Public License"/);
  unlinkSync(join(root, 'mod/proto/assets/vendor/CREDITS'));
  // A license covers its own directory and those below it: internal/third's BSD-3-Clause makes no name in a sibling
  // directory, or above it, the module's own.
  write('mod/proto/CREDITS', 'The proto parser is BSD licensed.\n');
  assert.throws(() => goLicenceBundle({ ...input, sums: resummed() }), /proto\/CREDITS \([0-9a-f]{64}\)/);
  unlinkSync(join(root, 'mod/proto/CREDITS'));
  write('mod/client.go', '// Use of this source code is governed by a BSD-style license.\n\npackage mod\n');
  assert.throws(() => goLicenceBundle({ ...input, sums: resummed() }), /mod@v1\.2\.3\/client\.go\.notice \([0-9a-f]{64}\)/);
  write('mod/client.go', '// Licensed under the MIT License.\n\npackage mod\n');
  // A README that holds a license covers the files beside it: the ISC its README holds is pkg's own.
  write('mod/internal/third/pkg/isc.go', '// Licensed under the ISC license.\n\npackage pkg\n');
  const withIsc = [...packages.slice(0, 3), { ...packages[3]!, compiled: ['pkg.go', 'isc.go'] }, ...packages.slice(4)];
  assert.ok(goLicenceBundle({ ...input, packages: withIsc, sums: resummed() }).has('example.com/mod@v1.2.3/internal/third/pkg/README'));
  unlinkSync(join(root, 'mod/internal/third/pkg/isc.go'));
  write('mod/LICENSE', 'Copyright 2026 Example. All rights reserved.\n');
  assert.throws(() => goLicenceBundle({ ...input, sums: resummed() }), /mod@v1\.2\.3\/LICENSE \([0-9a-f]{64}\): it is no license this script recognises/);
  unlinkSync(join(root, 'mod/LICENSE'));
  assert.throws(() => goLicenceBundle({ ...input, packages: [packages[2]!], sums: resummed() }), /example\.com\/mod@v1\.2\.3 has no license file/);
  // A file changed in the module cache no longer matches go.sum.
  write('mod/LICENSE', MIT); write('mod/client.go', 'package mod // edited\n');
  assert.throws(() => goLicenceBundle(input), /does not match its hash in backend\/go\.sum/);
});

test('writing the Go license bundle makes the directory exact, and the check names every difference', t => {
  const root = mkdtempSync(join(tmpdir(), 'awwo-go-licences-write-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = join(root, 'go-modules'), bundle = new Map([['a.example/m@v1.0.0/LICENSE', Buffer.from(MIT)], ['modules.txt', Buffer.from('a.example/m v1.0.0 h1:x=\n')]]);
  writeBundle(output, bundle);
  assert.deepEqual(bundleDifferences(output, bundle), []);
  writeFileSync(join(output, 'a.example/m@v1.0.0/LICENSE'), 'edited'); unlinkSync(join(output, 'modules.txt'));
  mkdirSync(join(output, 'a.example/m@v0.9.0')); writeFileSync(join(output, 'a.example/m@v0.9.0/LICENSE'), MIT); writeFileSync(join(output, 'stray.txt'), 'stray');
  assert.deepEqual(bundleDifferences(output, bundle), ['changed a.example/m@v1.0.0/LICENSE', 'missing modules.txt', 'unexpected a.example/m@v0.9.0/LICENSE', 'unexpected stray.txt']);
  writeBundle(output, bundle);
  assert.deepEqual(bundleDifferences(output, bundle), []);
  assert.equal(existsSync(join(output, 'a.example/m@v0.9.0')), false);
  // A file hard-linked from elsewhere is replaced, never written through.
  const shared = join(root, 'shared-licence');
  writeFileSync(shared, 'bytes of a file outside the bundle');
  unlinkSync(join(output, 'a.example/m@v1.0.0/LICENSE')); linkSync(shared, join(output, 'a.example/m@v1.0.0/LICENSE'));
  writeBundle(output, bundle);
  assert.equal(readFileSync(shared, 'utf8'), 'bytes of a file outside the bundle');
  assert.deepEqual(bundleDifferences(output, bundle), []);
  // A linked output directory (a symlink, or a junction on Windows) is refused before anything is read, removed or written.
  const outside = join(root, 'outside'), linked = join(root, 'linked');
  mkdirSync(outside); writeFileSync(join(outside, 'keep.txt'), 'kept'); symlinkSync(outside, linked, 'junction');
  assert.throws(() => writeBundle(linked, bundle), /is not a directory/);
  assert.throws(() => bundleDifferences(linked, bundle), /is not a directory/);
  assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'kept');
  assert.equal(existsSync(join(outside, 'modules.txt')), false);
  // So is a real output directory below a linked one, anywhere under the anchor.
  mkdirSync(join(outside, 'go-modules')); writeFileSync(join(outside, 'go-modules/stray.txt'), 'kept');
  assert.throws(() => writeBundle(join(linked, 'go-modules'), bundle, root), /linked is not a directory/);
  assert.throws(() => bundleDifferences(join(linked, 'go-modules'), bundle, root), /linked is not a directory/);
  assert.equal(readFileSync(join(outside, 'go-modules/stray.txt'), 'utf8'), 'kept');
});

test('the release copies no notice through a linked directory of its source', t => {
  const root = mkdtempSync(join(tmpdir(), 'awwo-release-linked-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source'), outside = join(root, 'outside');
  for (const path of noticePaths.slice(0, noticePaths.indexOf('third_party/adapted'))) {
    mkdirSync(dirname(join(source, path)), { recursive: true }); writeFileSync(join(source, path), 'notice');
  }
  mkdirSync(join(outside, 'adapted'), { recursive: true }); writeFileSync(join(outside, 'adapted/LICENSE'), 'from outside the source');
  symlinkSync(outside, join(source, 'third_party'), 'junction');
  assert.throws(() => copyNotices(source, join(root, 'target')), /third_party is not a directory/);
  assert.equal(existsSync(join(root, 'target/third_party')), false);
});

test('a binary\'s modules are read from go version -m', () => {
  const output = '/awwo-api: go1.27.1\n\tpath\tawwo/backend/cmd/api\n\tmod\tawwo/backend\t(devel)\t\n\tdep\tgithub.com/a/b\tv1.0.0\th1:abc=\n\tdep\tgolang.org/x/c\tv0.1.0\th1:def=\n\tbuild\t-buildmode=exe\n\tbuild\tGOOS=linux\n';
  const modules = 'go go1.27.1\ngithub.com/a/b v1.0.0 h1:abc=\ngolang.org/x/c v0.1.0 h1:def=\n';
  assert.equal(linkedModules(output), modules);
  // The binary's path can hold spaces and ": ", and an experiment follows the version.
  assert.equal(linkedModules(output.replace('/awwo-api: go1.27.1', 'E:\\Bobo\'s Coding cache\\a: b\\awwo-api: go1.27.1 X:boringcrypto')), modules);
  assert.throws(() => linkedModules('awwo-api\n'), /printed no Go version/);
  assert.throws(() => linkedModules(`${output}\t=>\t../local\t(devel)\t\n`), /replaced module/);
});

test('the committed Go licenses are the module cache\'s, and the API binary links exactly the modules in modules.txt', t => {
  const backend = join(repository, 'backend'), scratch = mkdtempSync(join(tmpdir(), 'awwo-go-licences-build-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  // A go.work that leaves the backend out: the collector and the build must both ignore it.
  mkdirSync(join(scratch, 'other')); writeFileSync(join(scratch, 'other/go.mod'), 'module example.com/other\n\ngo 1.27.1\n');
  writeFileSync(join(scratch, 'go.work'), 'go 1.27.1\n\nuse ./other\n');
  // So must build tags, experiments or another amd64 level the caller's environment sets, which choose other files.
  const env = { ...process.env, GOWORK: join(scratch, 'go.work') }, bundle = collectGoLicences(backend, { ...env, GOFLAGS: '-tags=purego', GOEXPERIMENT: 'boringcrypto', GOAMD64: 'v3' });
  assert.deepEqual(bundleDifferences(join(repository, goLicences), bundle), []);
  // git keeps every file of it: a generic ignore rule (runtime/, build/, …) would leave one out of the commit the release archives.
  const ignored = spawnSync('git', ['check-ignore', '--no-index', '--stdin'], { cwd: repository, input: [...bundle.keys()].map(file => `${goLicences}/${file}`).join('\n'), encoding: 'utf8' });
  assert.equal(ignored.status, 1, `git ignores ${ignored.stdout}`);
  // Built as the API image and the release build it.
  execFileSync('go', ['build', '-trimpath', '-buildvcs=false', '-ldflags', '-s -w', '-o', join(scratch, 'awwo-api'), './cmd/api'], { cwd: backend, env: { ...env, ...TARGET, GOWORK: 'off' }, stdio: ['ignore', 'ignore', 'inherit'], timeout: 900_000 });
  checkLinkedModules(join(scratch, 'awwo-api'), join(repository, goLicences, 'modules.txt'));
  // Another toolchain is named as such, with the one to build with; another set of modules as such.
  const listed = readFileSync(join(repository, goLicences, 'modules.txt'), 'utf8');
  writeFileSync(join(scratch, 'modules.txt'), listed.replace(/^go \S+\n/, 'go go0.0.0\n'));
  assert.throws(() => checkLinkedModules(join(scratch, 'awwo-api'), join(scratch, 'modules.txt')), /was built with go\S+, but .* is for go0\.0\.0, the toolchain the API image builds with; build with that one \(GOTOOLCHAIN=go0\.0\.0\)/);
  writeFileSync(join(scratch, 'modules.txt'), listed.split('\n').filter(line => !line.startsWith('github.com/beorn7/perks ')).join('\n'));
  assert.throws(() => checkLinkedModules(join(scratch, 'awwo-api'), join(scratch, 'modules.txt')), /links other Go modules/);
  // The release builds with the toolchain modules.txt names, the one this build used.
  assert.equal(bundleToolchain(join(repository, goLicences, 'modules.txt')), listed.slice(3, listed.indexOf('\n')));
  writeFileSync(join(scratch, 'modules.txt'), listed.split('\n').slice(1).join('\n'));
  assert.throws(() => bundleToolchain(join(scratch, 'modules.txt')), /names no Go toolchain on its first line/);
});

test('the notices name license files by path, beside a named license file or directly inside a named directory', () => {
  const files = ['LICENSE', 'a/LICENSE', 'a/NOTICE', 'a/src/LICENSE', 'b/COPYING', 'b/main.go', 'c/README.md', 'd/x/LICENSE', 'e/data-licence.txt', 'e/build-licences.mjs', 'f/notice_response.go', 'g/LICENSE', 'h/main.go'];
  const markdown = 'See `LICENSE`, `a/LICENSE` and `NOTICE`.\n\n| Name | Path |\n| --- | --- |\n| B | b/ |\n| D | d/ |\n\nAlso `c/README.md`, `e/data-licence.txt`, `e/build-licences.mjs --check`, `f`, and `/usr/LICENSE`.\n';
  assert.deepEqual(requiredNotices(markdown, files), { required: ['LICENSE', 'a/LICENSE', 'a/NOTICE', 'b/COPYING', 'e/data-licence.txt'], missing: [] });
  assert.deepEqual(uncoveredNotices(markdown, files, ['LICENSE', 'a', 'b/COPYING']), ['e/data-licence.txt']);
  // A license named alone still brings the notice beside it, as Apache-2.0 asks.
  assert.deepEqual(requiredNotices('Keep `i/LICENSE`.\n', [...files, 'i/LICENSE', 'i/NOTICE', 'i/notes.md']), { required: ['i/LICENSE', 'i/NOTICE'], missing: [] });
  // Names count in document order, table cells included: a plain path in a cell gives a bare name after it its place,
  // a plain license path the commit lacks is missing, and a heading such as License is no name.
  const table = '| Source | License | Path | Notice |\n| --- | --- | --- | --- |\n| A | MIT | a/ | `NOTICE` |\n| G | MIT | g/LICENSE | |\n| H | MIT | h/LICENSE | |\n';
  assert.deepEqual(requiredNotices(table, files), { required: ['a/LICENSE', 'a/NOTICE', 'g/LICENSE'], missing: ['h/LICENSE'] });
  // A cell can list several paths, plain and backticked; a directory the commit lacks is missing when written with its slash or in a table;
  // a path whose top directory the commit lacks (a URL's, a module's) is not the repository's, nor is prose with
  // spaces, and a bare directory such as the archive's licenses/ is no license file beside the path before it.
  const more = '| X | `a/LICENSE` |\n| Y | g/LICENSE, a/NOTICE |\n| Z | d/removed |\n| W | owner/LICENSE |\n| V | `a/LICENSE` and d/x/LICENSE |\n| U | d/x/NOTICE, `a/LICENSE` |\n\n'
    + 'See `d/gone/`, `d/notes` and `github.com/x/y/blob/main/LICENSE`; `a/LICENSE` ships in `licenses/`; `d/x/LICENSE or NOTICE.txt` is prose.\n';
  assert.deepEqual(requiredNotices(more, files), { required: ['a/LICENSE', 'a/NOTICE', 'd/x/LICENSE', 'g/LICENSE'], missing: ['d/gone', 'd/removed', 'd/x/NOTICE'] });
  // A named license file the commit lacks is missing, also a bare name meant for the path before it; a bare name with
  // no file of its own beside that path is the repository's.
  const deleted = 'Preserve `g/` and its `NOTICE`, and `a/LICENSE` and `NOTICE`, and `h/LICENSE`; `c/README.md` points to `LICENSE`.\n';
  assert.deepEqual(requiredNotices(deleted, files.filter(file => file !== 'a/NOTICE')), { required: ['LICENSE', 'a/LICENSE', 'g/LICENSE'], missing: ['a/NOTICE', 'g/NOTICE', 'h/LICENSE'] });
  assert.deepEqual(uncoveredNotices(deleted, files.filter(file => file !== 'a/NOTICE'), ['LICENSE', 'a', 'g']), ['a/NOTICE (missing)', 'g/NOTICE (missing)', 'h/LICENSE (missing)']);
  // Where the directory before it has license files of its own, a bare name missing there is missing, never the root's;
  // one that neither that directory nor the root has is missing too; a path in prose without backticks is no name.
  assert.deepEqual(requiredNotices('Keep `x/NOTICE` and `LICENSE`.\n', ['LICENSE', 'x/NOTICE', 'x/main.go']), { required: ['x/NOTICE'], missing: ['x/LICENSE'] });
  // A path is read as normalized ("./a/LICENSE" is a/LICENSE), and a bare name looks for its place only in its own
  // paragraph, heading or table row.
  assert.deepEqual(requiredNotices('Keep `./a/LICENSE`.\n', files), { required: ['a/LICENSE', 'a/NOTICE'], missing: [] });
  assert.deepEqual(requiredNotices('Keep `a/LICENSE`.\n\n## Ours\n\nAwwO keeps its own `LICENSE`.\n', files), { required: ['LICENSE', 'a/LICENSE', 'a/NOTICE'], missing: [] });
  assert.deepEqual(requiredNotices('# `a/LICENSE`\n`LICENSE` is the root one.\n', files), { required: ['LICENSE', 'a/LICENSE', 'a/NOTICE'], missing: [] });
  assert.deepEqual(requiredNotices('| A | `a/LICENSE` |\n| B | `NOTICE` |\n', files), { required: ['a/LICENSE', 'a/NOTICE'], missing: ['NOTICE'] });
  assert.deepEqual(requiredNotices('- `a/LICENSE` is kept.\n- AwwO keeps its `LICENSE`.\n', files), { required: ['LICENSE', 'a/LICENSE', 'a/NOTICE'], missing: [] });
  // A link's target is a name, unless it is on the web or in the page.
  assert.deepEqual(requiredNotices('See [its license](a/LICENSE), [the lost one](d/x/NOTICE), [the site](https://example.org/LICENSE) and [below](#LICENSE).\n', files),
    { required: ['a/LICENSE', 'a/NOTICE'], missing: ['d/x/NOTICE'] });
  // Its #part, a title (escaped quotes and all) or angle brackets do not hide it.
  assert.deepEqual(requiredNotices('See [terms](g/LICENSE#conditions), [notice](<d/x/LICENSE> "Notice") and [lost](d/x/NOTICE \'Gone\').\n', files),
    { required: ['d/x/LICENSE', 'g/LICENSE'], missing: ['d/x/NOTICE'] });
  assert.deepEqual(requiredNotices('See [its license](a/LICENSE "A \\"quoted\\" title").\n', files), { required: ['a/LICENSE', 'a/NOTICE'], missing: [] });
  assert.deepEqual(requiredNotices('See [terms](g/LICENSE?plain=1) and [notice](d/x/LICENSE (The notice)).\n', files), { required: ['d/x/LICENSE', 'g/LICENSE'], missing: [] });
  // A link from the top of the repository, a reference definition, and a % that starts no escape.
  assert.deepEqual(requiredNotices('See [its license](/g/LICENSE) and [the notice][1].\n\n[1]: <d/x/NOTICE> "Gone"\n', files), { required: ['g/LICENSE'], missing: ['d/x/NOTICE'] });
  assert.deepEqual(requiredNotices('See [terms](<d/100% LICENSE>).\n', files), { required: [], missing: [] });
  assert.deepEqual(requiredNotices('See `c/README.md` and its `NOTICE`.\n', files), { required: [], missing: ['c/NOTICE'] });
  assert.deepEqual(requiredNotices('Prose can say d/removed/LICENSE without backticks.\n', files), { required: [], missing: [] });
});

test('THIRD_PARTY_NOTICES.md names no license or notice file the artifacts leave out', () => {
  const files = trackedFiles(), markdown = readFileSync(join(repository, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  assert.deepEqual(uncoveredNotices(markdown, files), []);
  const { required } = requiredNotices(markdown, files);
  for (const path of ['LICENSE', 'apps/web/src/saas/skillLicences.txt', 'server/packages/adapters/hermes/LICENSE', 'third_party/adapted/aihot/NOTICE', 'third_party/clawwork/NOTICE', 'third_party/osiris/LICENSE']) assert.ok(required.includes(path), path);
  for (const path of noticePaths) assert.ok(files.includes(path) || files.some(file => file.startsWith(`${path}/`)), `${path} is not in the repository`);
});

test('the release copies the notices to their repository paths, the same way every time', t => {
  const root = mkdtempSync(join(tmpdir(), 'awwo-release-notices-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  copyNotices(repository, join(root, 'one')); copyNotices(repository, join(root, 'two'));
  const lines = checksumLines(join(root, 'one')), expected = trackedFiles().filter(carried).sort();
  assert.deepEqual(checksumLines(join(root, 'two')), lines);
  assert.deepEqual(lines.map(line => line.slice(66)).sort(), expected);
  for (const file of expected) assert.ok(readFileSync(join(root, 'one', file)).equals(readFileSync(join(repository, file))), file);
  assert.ok(expected.includes('THIRD_PARTY_NOTICES.md') && expected.includes(`${goLicences}/modules.txt`) && expected.includes(`${goLicences}/go/LICENSE`));
  assert.throws(() => copyNotices(repository, join(root, 'one')));
});

// .dockerignore as Docker reads it (moby/patternmatcher): the last pattern that matches a path or one of its parents decides.
function dockerignoreRegExp(pattern: string): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    if (pattern.startsWith('**', i)) {
      i += pattern[i + 2] === '/' ? 2 : 1;
      source += i + 1 >= pattern.length ? '.*' : '(.*/)?';
    } else if (pattern[i] === '*') source += '[^/]*';
    else if (pattern[i] === '?') source += '[^/]';
    else source += pattern[i]!.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}
function dockerContextIncludes(lines: readonly string[], file: string): boolean {
  const patterns = lines.map(line => line.trim()).filter(line => line && !line.startsWith('#'))
    .map(line => ({ exception: line.startsWith('!'), pattern: dockerignoreRegExp(posix.normalize(line.replace(/^!/, '')).replace(/\/$/, '')) }));
  const parents = file.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'));
  let excluded = false;
  for (const { exception, pattern } of patterns) {
    if (exception !== excluded) continue;
    if (pattern.test(file) || parents.some(parent => pattern.test(parent))) excluded = !exception;
  }
  return !excluded;
}

test('the API image copies the same notices into its documentation, from a context of backend/ and those files', () => {
  const dockerfile = readFileSync(join(repository, 'deploy/saas/api.Dockerfile'), 'utf8');
  const stage = dockerfile.split(/^FROM /m).find(part => part.startsWith('scratch AS notices\n')) ?? '', copied: string[] = [];
  for (const line of stage.split('\n').filter(text => text.startsWith('COPY '))) {
    const sources = line.trim().split(/\s+/).slice(1), target = sources.pop() ?? '';
    for (const source of sources) {
      const path = source.replace(/\/$/, '');
      copied.push(path);
      // Each keeps its repository path, so the references in THIRD_PARTY_NOTICES.md resolve in the image too.
      assert.equal(target, source.endsWith('/') ? `/${source}` : `/${parentOf(path) ? `${parentOf(path)}/` : ''}`, line);
    }
  }
  assert.deepEqual(copied.sort(), [...noticePaths].sort());
  assert.match(dockerfile, /^COPY --from=notices \/ \/usr\/share\/doc\/awwo-api\/$/m);
  assert.match(dockerfile, /^COPY --from=notices \/third_party\/go-modules\/ \/go-modules\/\nRUN test "\$\(go env GOOS\)\/\$\(go env GOARCH\)" = linux\/amd64 \\\n && go version -m \/awwo-api \| awk 'NR == 1 \{ print "go", \$2 \} \$1 == "dep" \{ print \$2, \$3, \$4 \}' \| diff - \/go-modules\/modules\.txt \\\n && cmp "\$\(go env GOROOT\)\/LICENSE" \/go-modules\/go\/LICENSE && cmp "\$\(go env GOROOT\)\/PATENTS" \/go-modules\/go\/PATENTS\n/m);
  assert.match(dockerfile, /^RUN CGO_ENABLED=0 go build /m);
  assert.ok(dockerfile.indexOf('go version -m /awwo-api') > dockerfile.indexOf('-o /awwo-api ./cmd/api'), 'the module check runs on the built binary');
  const ignore = readFileSync(join(repository, 'deploy/saas/api.Dockerfile.dockerignore'), 'utf8').split('\n');
  for (const file of trackedFiles()) if (!file.startsWith('backend/')) assert.equal(dockerContextIncludes(ignore, file), carried(file), file);
  assert.equal(dockerContextIncludes(ignore, 'backend/cmd/api/main.go'), true);
  for (const file of ['backend/.env', 'backend/internal/app/.env.local', 'backend/node_modules/x/index.js']) assert.equal(dockerContextIncludes(ignore, file), false, file);
});
