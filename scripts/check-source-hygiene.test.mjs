import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  ALLOWLIST_PATH, CATEGORIES, DEFAULT_ROOTS, FLAGGED_RANGES, SHOWN_PER_FILE, UsageError, applyAllowlist,
  checkHygiene, classifyCodePoint, collectFiles, exitCodeFor, formatCodePoint, formatReport, isTextFile, main,
  parseAllowlist, parseArguments, repoRelative, scanFile, scanFiles, scanText,
} from './check-source-hygiene.mjs';

// Every character under test is built from its code point, so this file contains none of them.
const ch = codePoint => String.fromCodePoint(codePoint);
const CR = ch(0x0d);
const ZWSP = ch(0x200b);
const SCRIPT = fileURLToPath(new URL('./check-source-hygiene.mjs', import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const execFileAsync = promisify(execFile);

function tempDir(t, prefix = 'awwo-hygiene-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(root, name, content) {
  const full = path.join(root, ...name.split('/'));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

function fixture(t, files) {
  const root = tempDir(t);
  for (const [name, content] of Object.entries(files)) write(root, name, content);
  return root;
}

function allow(root, entries) {
  write(root, ALLOWLIST_PATH, JSON.stringify(entries));
}

function run(argv, cwd) {
  let stdout = '';
  let stderr = '';
  const code = main(argv, {
    cwd,
    stdout: { write: chunk => { stdout += chunk; return true; } },
    stderr: { write: chunk => { stderr += chunk; return true; } },
  });
  return { code, stdout, stderr };
}

async function spawnScan(args) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [SCRIPT, ...args], { windowsHide: true });
    return { code: 0, stdout };
  } catch (error) {
    if (typeof error.code !== 'number') throw error;
    return { code: error.code, stdout: error.stdout };
  }
}

test('every category boundary is classified exactly as specified', () => {
  const expected = [
    [0x00, 'control'], [0x08, 'control'], [0x09, null], [0x0a, null], [0x0b, 'control'], [0x0c, 'control'],
    [0x0d, 'cr'], [0x0e, 'control'], [0x1f, 'control'], [0x20, null], [0x7e, null], [0x7f, 'control'], [0x80, null],
    [0x200a, null], [0x200b, 'zero-width'], [0x200c, 'zero-width'], [0x200d, 'zero-width'], [0x200e, 'bidi'],
    [0x200f, 'bidi'], [0x2010, null], [0x2028, null], [0x2029, null], [0x202a, 'bidi'], [0x202e, 'bidi'],
    [0x202f, null], [0x205f, null], [0x2060, 'zero-width'], [0x2061, null], [0x2065, null], [0x2066, 'bidi'],
    [0x2069, 'bidi'], [0x206a, null], [0xfefe, null], [0xfeff, 'zero-width'], [0xff00, null], [0xdffff, null],
    [0xe0000, 'tag'], [0xe0041, 'tag'], [0xe007f, 'tag'], [0xe0080, null], [0x1f600, null],
  ];
  for (const [codePoint, category] of expected) assert.equal(classifyCodePoint(codePoint), category, formatCodePoint(codePoint));
});

test('the range table and the category list agree, and the ranges never overlap', () => {
  assert.deepEqual([...new Set(FLAGGED_RANGES.map(range => range[2]))].sort(), [...CATEGORIES].sort());
  const sorted = [...FLAGGED_RANGES].sort((a, b) => a[0] - b[0]);
  for (let index = 1; index < sorted.length; index += 1) assert.ok(sorted[index][0] > sorted[index - 1][1], 'ranges overlap');
  for (const [first, last] of FLAGGED_RANGES) assert.ok(first <= last);
});

test('a clean text has no findings: tab, LF and ordinary Unicode are allowed', () => {
  assert.deepEqual(scanText(`a\tb\nc ${ch(0x4e2d)}${ch(0x6587)} ${ch(0x1f600)} ${ch(0x2028)}\n`), []);
  assert.deepEqual(scanText(''), []);
});

test('positions are 1-based lines and code-point columns', () => {
  const text = `x${ch(0x1f600)}${ZWSP}\nab${CR}\n${ch(0xe0041)}`;
  assert.deepEqual(scanText(text), [
    { line: 1, column: 3, codePoint: 0x200b, category: 'zero-width' },
    { line: 2, column: 3, codePoint: 0x0d, category: 'cr' },
    { line: 3, column: 1, codePoint: 0xe0041, category: 'tag' },
  ]);
});

test('each category is found in text', () => {
  const samples = {
    cr: [0x0d], control: [0x00, 0x07, 0x1b, 0x7f], 'zero-width': [0x200c, 0x2060, 0xfeff],
    bidi: [0x200e, 0x202e, 0x2066, 0x2069], tag: [0xe0000, 0xe007f],
  };
  for (const [category, codePoints] of Object.entries(samples)) {
    for (const codePoint of codePoints) {
      assert.deepEqual(scanText(`ok ${ch(codePoint)} ok`), [{ line: 1, column: 4, codePoint, category }], formatCodePoint(codePoint));
    }
  }
});

test('a UTF-8 BOM at the start of a file is reported at 1:1, and a NUL byte as control', t => {
  const root = tempDir(t);
  const bom = write(root, 'bom.md', Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x0a]));
  const nul = write(root, 'nul.json', Buffer.from([0x7b, 0x00, 0x7d]));
  assert.deepEqual(scanFile(bom), [{ line: 1, column: 1, codePoint: 0xfeff, category: 'zero-width' }]);
  assert.deepEqual(scanFile(nul), [{ line: 1, column: 2, codePoint: 0x00, category: 'control' }]);
});

test('code points print as U+ with at least four hex digits', () => {
  assert.equal(formatCodePoint(0x0d), 'U+000D');
  assert.equal(formatCodePoint(0x200b), 'U+200B');
  assert.equal(formatCodePoint(0xe0041), 'U+E0041');
});

test('the extension allowlist decides which files are read, case-insensitively', () => {
  for (const name of ['a.go', 'b.SQL', 'c.tsx', 'd.mjs', 'e.Md', 'f.py', 'g.ps1', 'h.yaml', 'i.toml', 'j.txt']) assert.ok(isTextFile(name), name);
  for (const name of ['a.png', 'b.woff2', 'c.svg', 'Dockerfile', '.env.example', 'd.tap', 'e']) assert.equal(isTextFile(name), false, name);
});

test('the walk skips generated, dependency and VCS directories, binary files and links', t => {
  const dirty = `bad ${ZWSP}\n`;
  const files = { 'docs/ok.md': 'clean\n', 'docs/bad.md': dirty, 'docs/picture.png': dirty, 'docs/Dockerfile': dirty };
  for (const skip of ['node_modules', 'dist', 'build', 'coverage', '.git', '__pycache__']) files[`docs/${skip}/x.js`] = dirty;
  files['docs/deep/node_modules/y.js'] = dirty;
  const root = fixture(t, files);
  const outside = tempDir(t, 'awwo-hygiene-outside-');
  write(outside, 'linked.md', dirty);
  let linked = true;
  try {
    // A junction needs no privilege on Windows; elsewhere this is an ordinary directory symlink.
    fs.symlinkSync(outside, path.join(root, 'docs', 'linked'), 'junction');
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
    linked = false;
  }
  const names = collectFiles(path.join(root, 'docs')).map(file => repoRelative(root, file));
  assert.deepEqual(names, ['docs/bad.md', 'docs/ok.md']);
  const report = checkHygiene({ root });
  assert.deepEqual(report.findings.map(finding => finding.path), ['docs/bad.md']);
  t.diagnostic(linked ? 'directory link created and not followed' : 'links not permitted here; link case not exercised');
});

test('missing default roots are listed rather than failing, and an empty default scan is a usage error', t => {
  const root = fixture(t, { 'scripts/a.mjs': 'export {};\n' });
  const report = checkHygiene({ root });
  assert.equal(report.filesScanned, 1);
  assert.deepEqual(report.missingRoots, DEFAULT_ROOTS.filter(name => name !== 'scripts'));
  assert.equal(exitCodeFor(report), 0);
  const empty = tempDir(t);
  const result = run(['--root', empty], empty);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /no source files found/);
});

test('an allowlist entry covers only its exact path and listed categories', t => {
  const root = fixture(t, { 'docs/a.md': `one${CR}\ntwo ${ZWSP}\n`, 'docs/sub/a.md': `three${CR}\n` });
  allow(root, [{ path: 'docs/a.md', categories: ['cr'], reason: 'fixture keeps CRLF' }]);
  let report = checkHygiene({ root });
  assert.deepEqual(report.findings.map(f => [f.path, f.category, f.allowed]), [
    ['docs/a.md', 'cr', true], ['docs/a.md', 'zero-width', false], ['docs/sub/a.md', 'cr', false],
  ]);
  assert.equal(exitCodeFor(report), 1);
  allow(root, [
    { path: 'docs/a.md', categories: ['cr', 'zero-width'], reason: 'fixture keeps both' },
    { path: 'docs/sub/a.md', categories: ['cr'], reason: 'fixture keeps CRLF' },
  ]);
  report = checkHygiene({ root });
  assert.equal(report.summary.notAllowed, 0);
  assert.equal(exitCodeFor(report), 0);
  // A directory or a path prefix is not a match: entries name files exactly.
  allow(root, [{ path: 'docs', categories: ['cr', 'zero-width'], reason: 'too broad' }]);
  assert.equal(checkHygiene({ root }).summary.notAllowed, 3);
});

test('malformed allowlists are usage errors', t => {
  const valid = { path: 'docs/a.md', categories: ['cr'], reason: 'kept on purpose' };
  const invalid = [
    'not json', '{}', JSON.stringify([valid, valid]), JSON.stringify(['docs/a.md']),
    JSON.stringify([{ ...valid, extra: true }]), JSON.stringify([{ ...valid, reason: '   ' }]),
    JSON.stringify([{ ...valid, categories: [] }]), JSON.stringify([{ ...valid, categories: ['crlf'] }]),
    JSON.stringify([{ ...valid, categories: ['cr', 'cr'] }]),
  ];
  for (const bad of ['docs\\a.md', '/docs/a.md', 'C:/docs/a.md', '../a.md', 'docs/../a.md', './docs/a.md', 'docs/*.md', 'docs/', '']) {
    invalid.push(JSON.stringify([{ ...valid, path: bad }]));
  }
  for (const text of invalid) assert.throws(() => parseAllowlist(text), UsageError, text);
  assert.deepEqual(parseAllowlist(JSON.stringify([valid])), [valid]);
  const root = fixture(t, { 'docs/a.md': 'clean\n' });
  write(root, ALLOWLIST_PATH, JSON.stringify([{ ...valid, categories: ['crlf'] }]));
  const result = run(['--root', root], root);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /categories must be/);
});

test('stale allowlist entries are reported on full scans only and do not change the exit code', t => {
  const root = fixture(t, { 'docs/a.md': 'clean\n', 'docs/b.md': `kept${CR}\n` });
  allow(root, [
    { path: 'docs/a.md', categories: ['cr'], reason: 'was CRLF once' },
    { path: 'docs/b.md', categories: ['cr', 'bidi'], reason: 'kept on purpose' },
  ]);
  const full = checkHygiene({ root });
  assert.deepEqual(full.staleAllowlist, [{ path: 'docs/a.md', categories: ['cr'] }, { path: 'docs/b.md', categories: ['bidi'] }]);
  assert.equal(exitCodeFor(full), 0);
  assert.match(formatReport(full), /stale allowlist entry: docs\/a\.md \[cr\]/);
  assert.deepEqual(checkHygiene({ root, paths: ['docs/a.md'], cwd: root }).staleAllowlist, []);
});

test('explicit paths scan files and directories, skip non-text files and refuse missing paths', t => {
  const root = fixture(t, { 'docs/a.md': `x ${ZWSP}\n`, 'docs/b.md': 'clean\n', 'docs/c.png': `x ${ZWSP}\n`, 'other/d.md': `y ${ZWSP}\n` });
  let result = run(['--root', root, 'docs/b.md'], root);
  assert.equal(result.code, 0);
  result = run(['--root', root, 'docs/c.png'], root);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /skipped \(not a text extension\): docs\/c\.png/);
  result = run(['--root', root, '--json', 'docs', 'docs/a.md'], root);
  assert.equal(result.code, 1);
  assert.deepEqual(JSON.parse(result.stdout).findings.map(finding => finding.path), ['docs/a.md']);
  result = run(['--root', root, 'docs/missing.md'], root);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /no such file or directory: docs\/missing\.md/);
  // A file outside --root keeps an absolute path, so no allowlist entry can cover it.
  const elsewhere = tempDir(t, 'awwo-hygiene-elsewhere-');
  const outsideFile = write(elsewhere, 'e.md', `z ${ZWSP}\n`);
  const report = checkHygiene({ root, paths: [outsideFile], cwd: root });
  assert.equal(path.isAbsolute(report.findings[0].path), true);
});

test('--json lists every finding with U+ code points and an allowed flag', t => {
  const root = fixture(t, { 'docs/a.md': `one${CR}\n${ch(0x202e)}\n` });
  allow(root, [{ path: 'docs/a.md', categories: ['cr'], reason: 'fixture keeps CRLF' }]);
  const result = run(['--root', root, '--json'], root);
  assert.equal(result.code, 1);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.findings, [
    { path: 'docs/a.md', line: 1, column: 4, codePoint: 'U+000D', category: 'cr', allowed: true },
    { path: 'docs/a.md', line: 2, column: 1, codePoint: 'U+202E', category: 'bidi', allowed: false },
  ]);
  assert.deepEqual(report.summary, { findings: 2, notAllowed: 1, allowed: 1, filesWithFindings: 1 });
});

test('text mode caps findings shown per file, and no report ever prints the characters it found', t => {
  const lines = Array.from({ length: SHOWN_PER_FILE + 5 }, (_, index) => `line ${index}${CR}`).join('\n');
  const root = fixture(t, { 'docs/crlf.md': `${lines}\n`, 'docs/hidden.md': `a${ZWSP}${ch(0x202e)}${ch(0xe0041)}${ch(0x1b)}\n` });
  const text = run(['--root', root], root);
  assert.equal(text.code, 1);
  assert.match(text.stdout, /docs\/crlf\.md: \.\.\. 5 more \(use --json for all\)/);
  assert.match(text.stdout, /docs\/hidden\.md:1:2 U\+200B zero-width/);
  // 25 CRs in crlf.md and 4 hidden characters in hidden.md.
  assert.match(text.stdout, /FAIL: 29 findings in 2 files are not allowlisted\./);
  assert.deepEqual(scanText(text.stdout), []);
  assert.deepEqual(scanText(run(['--root', root, '--json'], root).stdout), []);
});

test('a file that cannot be read makes the scan incomplete (exit 2)', t => {
  const root = fixture(t, { 'docs/a.md': 'clean\n' });
  const scanned = scanFiles(root, [path.join(root, 'docs')]);
  assert.equal(scanned.errors.length, 1);
  assert.equal(scanned.errors[0].path, 'docs');
  assert.equal(exitCodeFor({ errors: scanned.errors, summary: { notAllowed: 0 } }), 2);
});

test('arguments: --root needs a value, unknown options are refused and -- ends the options', () => {
  assert.deepEqual(parseArguments(['--json', '--root', 'x', 'a.md']), { root: 'x', json: true, help: false, paths: ['a.md'] });
  assert.equal(parseArguments(['--root=y']).root, 'y');
  assert.deepEqual(parseArguments(['--', '--json']).paths, ['--json']);
  for (const argv of [['--root'], ['--root', '--json'], ['--root='], ['--verbose'], ['-x']]) {
    assert.throws(() => parseArguments(argv), UsageError, argv.join(' '));
  }
  const help = run(['--help'], process.cwd());
  assert.equal(help.code, 0);
  assert.match(help.stdout, /^Usage: node scripts\/check-source-hygiene\.mjs/);
});

test('the real process exits 1 on a finding, 0 when clean and 2 on a usage error', async t => {
  const dirty = fixture(t, { 'docs/a.md': `x ${ZWSP}\n` });
  const clean = fixture(t, { 'docs/a.md': 'clean\n' });
  const dirtyRun = await spawnScan(['--root', dirty]);
  assert.equal(dirtyRun.code, 1);
  assert.match(dirtyRun.stdout, /docs\/a\.md:1:3 U\+200B zero-width/);
  assert.equal((await spawnScan(['--root', clean])).code, 0);
  assert.equal((await spawnScan(['--root', clean, '--bogus'])).code, 2);
});

test('the scanner and these tests contain none of the characters they look for', () => {
  assert.deepEqual(scanFile(SCRIPT), []);
  assert.deepEqual(scanFile(SELF), []);
});

test('applyAllowlist keeps findings in order and marks only exact matches', () => {
  const findings = [
    { path: 'a.md', line: 1, column: 1, codePoint: 0x0d, category: 'cr' },
    { path: 'b.md', line: 1, column: 1, codePoint: 0x0d, category: 'cr' },
  ];
  const { findings: marked, stale } = applyAllowlist(findings, [{ path: 'b.md', categories: ['cr'], reason: 'r' }]);
  assert.deepEqual(marked.map(finding => finding.allowed), [false, true]);
  assert.deepEqual(stale, []);
});
