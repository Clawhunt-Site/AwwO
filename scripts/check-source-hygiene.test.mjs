import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  ALLOWLIST_PATH, CATEGORIES, DEFAULT_ROOTS, FLAGGED_RANGES, GIT_LISTING_VARIABLES, GIT_REPOSITORY_VARIABLES,
  SHOWN_PER_FILE, UsageError, applyAllowlist, checkHygiene, classifyCodePoint, collectFiles, exitCodeFor,
  formatCodePoint, formatReport, gitEnvironment, isTextFile, main, parseAllowlist, parseArguments, repoRelative,
  resolveTargets, scanFile, scanFiles, scanText,
} from './check-source-hygiene.mjs';

// Every character under test is built from its code point, so this file contains none of them.
const ch = codePoint => String.fromCodePoint(codePoint);
const CR = ch(0x0d);
const ZWSP = ch(0x200b);
const SCRIPT = fileURLToPath(new URL('./check-source-hygiene.mjs', import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const execFileAsync = promisify(execFile);

// Every git these tests run, the scanner's too, reads no global or system configuration and no ignore file of the
// machine's (git falls back to ~/.config/git/ignore when core.excludesFile is unset), so a machine's own rules or
// settings cannot change what a test sees.
const configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'awwo-hygiene-config-'));
after(() => fs.rmSync(configDirectory, { recursive: true, force: true }));
fs.writeFileSync(path.join(configDirectory, 'ignore'), '');
const excludesFile = path.join(configDirectory, 'ignore').split(path.sep).join('/');
fs.writeFileSync(path.join(configDirectory, 'config'), `[core]\n\texcludesFile = "${excludesFile}"\n`);
process.env.GIT_CONFIG_GLOBAL = path.join(configDirectory, 'config');
process.env.GIT_CONFIG_NOSYSTEM = '1';

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

// Line endings are kept as written, whatever the machine's git converts by default, and a GIT_DIR or
// GIT_INDEX_FILE a hook running these tests exports can never point a fixture's git at that hook's repository.
function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-C', cwd, ...args], {
    env: gitEnvironment(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  }).toString('utf8');
}

let gitPresent;
function hasGit() {
  if (gitPresent === undefined) {
    try {
      git(os.tmpdir(), '--version');
      gitPresent = true;
    } catch {
      gitPresent = false;
    }
  }
  return gitPresent;
}

/** A fixture that is a git checkout: tracked files are added to its index (forced), untracked ones only written. */
function checkout(t, { tracked = {}, untracked = {} }) {
  const root = fixture(t, { ...tracked, ...untracked });
  git(root, 'init', '-q');
  if (Object.keys(tracked).length) git(root, 'add', '-f', '--', ...Object.keys(tracked));
  return root;
}

/** Runs fn with environment variables set (undefined removes one), then restores them. */
function withEnvironment(changes, fn) {
  const saved = Object.fromEntries(Object.keys(changes).map(name => [name, process.env[name]]));
  const apply = values => {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  apply(changes);
  try {
    return fn();
  } finally {
    apply(saved);
  }
}

function linkDirectory(target, link) {
  try {
    // A junction needs no privilege on Windows; elsewhere this is an ordinary directory symlink.
    fs.symlinkSync(target, link, 'junction');
    return true;
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
    return false;
  }
}

/** Makes a directory unlistable (a deny entry for Everyone on Windows, mode 000 elsewhere); returns its undo, or null. */
function denyListing(directory) {
  if (process.platform === 'win32') {
    const icacls = args => execFileSync('icacls', [directory, ...args], { stdio: 'ignore', windowsHide: true });
    try {
      icacls(['/deny', '*S-1-1-0:(RD)']);
    } catch {
      return null;
    }
    return () => icacls(['/remove:d', '*S-1-1-0']);
  }
  // Root lists any directory.
  if (process.getuid?.() === 0) return null;
  fs.chmodSync(directory, 0);
  return () => fs.chmodSync(directory, 0o755);
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
  const linked = linkDirectory(outside, path.join(root, 'docs', 'linked'));
  const names = collectFiles(path.join(root, 'docs')).map(file => repoRelative(root, file));
  assert.deepEqual(names, ['docs/bad.md', 'docs/ok.md']);
  const report = checkHygiene({ root });
  assert.deepEqual(report.findings.map(finding => finding.path), ['docs/bad.md']);
  t.diagnostic(linked ? 'directory link created and not followed' : 'links not permitted here; link case not exercised');
});

test('in a git checkout the default scan skips ignored files but reports tracked and new untracked ones', t => {
  if (!hasGit()) return t.skip('git is not available');
  const crlf = `one${CR}\ntwo${CR}\n`;
  const root = checkout(t, {
    tracked: {
      '.gitignore': '.local/\nbuild/\n',
      'apps/openmaus-worker/.gitignore': '.runtime/\n.runs/\n',
      'apps/openmaus-worker/src/a.ts': crlf,
      // Held by the repository although the walk skips every build/ directory.
      'docs/build/kept.md': crlf,
    },
    untracked: {
      'apps/openmaus-worker/.runtime/core/.claude/skills/verify-omb/SKILL.md': crlf,
      'apps/openmaus-worker/.runs/run-1/result.json': crlf,
      'docs/.local/notes.md': crlf,
      'docs/build/out.md': crlf,
      'scripts/new.mjs': crlf,
    },
  });
  const report = checkHygiene({ root });
  assert.equal(report.listing, 'git');
  assert.deepEqual([...new Set(report.findings.map(finding => finding.path))],
    ['apps/openmaus-worker/src/a.ts', 'scripts/new.mjs', 'docs/build/kept.md']);
  assert.equal(exitCodeFor(report), 1);
  assert.match(formatReport(report), /^source hygiene: 3 files under .+ \(as git lists them: tracked, or untracked and not ignored\)/);
  // Named paths are walked as before, whatever git ignores.
  const named = checkHygiene({ root, paths: ['apps/openmaus-worker'], cwd: root });
  assert.equal(named.listing, 'paths');
  assert.deepEqual([...new Set(named.findings.map(finding => finding.path))], [
    'apps/openmaus-worker/.runs/run-1/result.json',
    'apps/openmaus-worker/.runtime/core/.claude/skills/verify-omb/SKILL.md', 'apps/openmaus-worker/src/a.ts',
  ]);
});

test('a git listing scans what the walk would, in its order, when nothing is ignored', t => {
  if (!hasGit()) return t.skip('git is not available');
  const tracked = ['docs/a/x.md', 'docs/B.md', 'backend/main.go', 'docs/a/y/deep.md'];
  const untracked = ['docs/a-b.md', 'scripts/z.mjs', 'docs/a/w.md', 'docs/image.png'];
  const files = names => Object.fromEntries(names.map(name => [name, 'clean\n']));
  const root = checkout(t, { tracked: files(tracked), untracked: files(untracked) });
  const listed = resolveTargets(root);
  assert.equal(listed.listing, 'git');
  assert.deepEqual(listed.files.map(file => repoRelative(root, file)), [
    'backend/main.go', 'scripts/z.mjs', 'docs/B.md', 'docs/a/w.md', 'docs/a/x.md', 'docs/a/y/deep.md', 'docs/a-b.md',
  ]);
  assert.deepEqual(listed.files, resolveTargets(root, ['backend', 'scripts', 'docs'], root).files);
});

test('a git listing leaves out files a deletion or a sparse checkout took away, nested repositories and links', t => {
  if (!hasGit()) return t.skip('git is not available');
  const dirty = `bad ${ZWSP}\n`;
  const root = checkout(t, {
    tracked: {
      'docs/gone.md': dirty, 'docs/kept.md': dirty, 'docs/was-a-directory/a.md': dirty,
      'docs/sparse/left-out.md': dirty, 'docs/sparse/local-edit.md': 'clean\n',
    },
    untracked: { 'docs/nested/inner.md': dirty },
  });
  git(path.join(root, 'docs', 'nested'), 'init', '-q');
  fs.unlinkSync(path.join(root, 'docs', 'gone.md'));
  fs.unlinkSync(path.join(root, 'docs', 'was-a-directory', 'a.md'));
  fs.rmdirSync(path.join(root, 'docs', 'was-a-directory'));
  write(root, 'docs/was-a-directory', 'now a file\n');
  // What a sparse checkout does to a file outside its cone: skip-worktree, and not in the working tree. A file
  // marked so but still there (the way to keep a local edit out of git status) is read all the same.
  git(root, 'update-index', '--skip-worktree', '--', 'docs/sparse/left-out.md', 'docs/sparse/local-edit.md');
  fs.unlinkSync(path.join(root, 'docs', 'sparse', 'left-out.md'));
  write(root, 'docs/sparse/local-edit.md', dirty);
  const outside = tempDir(t, 'awwo-hygiene-outside-');
  write(outside, 'linked.md', dirty);
  // Git for Windows lists the files under a junction; the scan must not read them.
  const linked = linkDirectory(outside, path.join(root, 'docs', 'linked'));
  const report = checkHygiene({ root });
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.findings.map(finding => finding.path), ['docs/kept.md', 'docs/sparse/local-edit.md']);
  t.diagnostic(linked ? 'directory link created and not followed' : 'links not permitted here; link case not exercised');
});

test('a sparse checkout passes: the files it leaves out are not read, and its index\'s hint is no warning', t => {
  if (!hasGit()) return t.skip('git is not available');
  const root = checkout(t, {
    tracked: { 'docs/keep/a.md': `x ${ZWSP}\n`, 'docs/big/b.md': 'clean\n', 'scripts/s.mjs': 'clean\n' },
  });
  try {
    git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--no-verify', '-m', 'fixture');
    git(root, 'sparse-checkout', 'set', '--cone', '--sparse-index', 'docs/keep', 'scripts');
  } catch (error) {
    return t.skip(`this git makes no sparse index (${String(error.stderr).trim().split('\n')[0]})`);
  }
  assert.equal(fs.existsSync(path.join(root, 'docs', 'big')), false);
  const report = checkHygiene({ root });
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.findings.map(finding => finding.path), ['docs/keep/a.md']);
});

test('in a git checkout a default root reached through a link is a setup error (exit 2); named, it is walked', t => {
  if (!hasGit()) return t.skip('git is not available');
  const root = checkout(t, { tracked: { 'scripts/ok.mjs': 'clean\n' } });
  const outside = tempDir(t, 'awwo-hygiene-outside-');
  write(outside, 'a.md', `x ${ZWSP}\n`);
  // Nothing under the link is tracked, so git lists the link alone.
  if (!linkDirectory(outside, path.join(root, 'docs'))) return t.skip('links not permitted here');
  const result = run(['--root', root], root);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /default root docs goes through the link docs: git lists the link/);
  assert.deepEqual(checkHygiene({ root, paths: ['docs'], cwd: root }).findings.map(finding => finding.path), ['docs/a.md']);
});

test('a default root git spells in another case is listed, in its place, where the file system ignores case', t => {
  if (!hasGit()) return t.skip('git is not available');
  const root = checkout(t, {
    tracked: { 'Docs/a.md': `x ${ZWSP}\n`, 'Scripts/b.mjs': `y ${ZWSP}\n` }, untracked: { 'Docs/new.md': `z ${ZWSP}\n` },
  });
  if (!fs.existsSync(path.join(root, 'docs'))) return t.skip('this file system tells docs from Docs');
  // scripts comes before docs among the default roots.
  assert.deepEqual(checkHygiene({ root }).findings.map(finding => finding.path),
    ['Scripts/b.mjs', 'Docs/a.md', 'Docs/new.md']);
});

test('a listed path the file system cannot find again fails the scan (exit 2), never a file left unread', t => {
  if (!hasGit()) return t.skip('git is not available');
  const root = checkout(t, { tracked: { 'docs/ok.md': 'clean\n' } });
  // r, U+D800 in WTF-8, .md: on Windows a name with a lone surrogate, which git lists as U+FFFD; elsewhere raw
  // bytes that are not UTF-8.
  const name = Buffer.concat([Buffer.from(path.join(root, 'docs', 'r')), Buffer.from([0xed, 0xa0, 0x80]), Buffer.from('.md')]);
  try {
    fs.writeFileSync(name, `x ${ZWSP}\n`);
  } catch (error) {
    return t.skip(`this file system refuses the name (${error.code})`);
  }
  let result = run(['--root', root], root);
  assert.equal(result.code, 2);
  if (process.platform === 'win32') {
    assert.match(result.stdout, new RegExp(`ERROR docs/r${ch(0xfffd)}\\.md: cannot read \\(ENOENT\\)`));
  } else {
    assert.match(result.stderr, /git lists a path that is not UTF-8, which this check cannot read: docs\/r\\xed\\xa0\\x80\.md/);
  }
  if (process.platform !== 'win32') return;
  // Beside a twin really spelled with U+FFFD, Git for Windows lists and reads the twin in its place, and adding
  // stages only the twin's bytes, so the repository can never hold the hidden file the scan then passes over.
  const twin = `docs/r${ch(0xfffd)}.md`;
  write(root, twin, 'clean\n');
  result = run(['--root', root], root);
  assert.equal(result.code, 0);
  git(root, 'add', '--', twin);
  assert.equal(git(root, 'show', `:${twin}`), 'clean\n');
});

test('a name git cannot spell, on a file this check never reads, does not stop it', t => {
  if (!hasGit()) return t.skip('git is not available');
  const root = checkout(t, { tracked: { 'docs/ok.md': 'clean\n' } });
  const name = Buffer.concat([Buffer.from(path.join(root, 'docs', 'r')), Buffer.from([0xed, 0xa0, 0x80]), Buffer.from('.png')]);
  try {
    fs.writeFileSync(name, 'x');
  } catch (error) {
    return t.skip(`this file system refuses the name (${error.code})`);
  }
  const result = run(['--root', root], root);
  assert.equal(result.code, 0, result.stderr);
});

test('git\'s trace2 output, which a configuration can turn on, is no warning', t => {
  if (!hasGit()) return t.skip('git is not available');
  const root = checkout(t, { tracked: { 'docs/a.md': `x ${ZWSP}\n` } });
  const tracing = write(tempDir(t, 'awwo-hygiene-trace-'), 'config', fs.readFileSync(process.env.GIT_CONFIG_GLOBAL, 'utf8')
    + '[trace2]\n\tnormalTarget = 1\n\tperfTarget = 1\n\teventTarget = 1\n');
  const report = withEnvironment({ GIT_CONFIG_GLOBAL: tracing }, () => checkHygiene({ root }));
  assert.deepEqual(report.findings.map(finding => finding.path), ['docs/a.md']);
});

test('a warning from git, such as for a directory it cannot open, fails the scan (exit 2) and is shown visibly', t => {
  if (!hasGit()) return t.skip('git is not available');
  const root = checkout(t, { tracked: { 'docs/ok.md': 'clean\n' }, untracked: { [`docs/locked${ZWSP}/new.md`]: `x ${ZWSP}\n` } });
  const allow = denyListing(path.join(root, 'docs', `locked${ZWSP}`));
  if (!allow) return t.skip('a directory cannot be made unlistable here');
  let result;
  try {
    // Git for Windows would discard its warnings with this exported.
    result = withEnvironment({ GIT_REDIRECT_STDERR: 'off' }, () => run(['--root', root], root));
  } finally {
    allow();
  }
  assert.equal(result.code, 2);
  assert.match(result.stderr, /cannot list the files of the git checkout .+: warning: could not open directory 'docs\/locked<U\+200B>\/'/);
  assert.deepEqual(scanText(result.stderr), []);
});

test('gitEnvironment leaves out the variables that steer git elsewhere, in any case, and keeps the rest', () => {
  const steering = Object.fromEntries([...GIT_REPOSITORY_VARIABLES, ...GIT_LISTING_VARIABLES].map(name => [name, 'x']));
  assert.deepEqual(gitEnvironment({
    ...steering, Git_Work_Tree: 'y', GIT_TRACE: '1', git_trace2_perf: '1', GIT_AUTHOR_NAME: 'g', PATH: 'h',
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: '*',
  }), {
    GIT_AUTHOR_NAME: 'g', PATH: 'h', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: '*',
  });
});

test('every variable git clears before it works in another repository is left out, but GIT_CONFIG_COUNT', t => {
  if (!hasGit()) return t.skip('git is not available');
  const cleared = git(os.tmpdir(), 'rev-parse', '--local-env-vars').split(/\r?\n/).filter(Boolean);
  assert.ok(cleared.includes('GIT_DIR'), cleared.join(' '));
  assert.deepEqual(cleared.filter(name => !GIT_REPOSITORY_VARIABLES.includes(name)), ['GIT_CONFIG_COUNT']);
});

test('git variables a hook or alias exports change neither which checkout is listed nor how', t => {
  if (!hasGit()) return t.skip('git is not available');
  const root = checkout(t, { tracked: { 'docs/a.md': `x ${ZWSP}\n` }, untracked: { 'docs/new.md': `y ${ZWSP}\n` } });
  const other = checkout(t, { tracked: { 'docs/b.md': 'clean\n' } });
  const everything = write(tempDir(t, 'awwo-hygiene-excludes-'), 'excludes', '*\n');
  const report = withEnvironment({
    GIT_DIR: path.join(other, '.git'), GIT_WORK_TREE: other, GIT_INDEX_FILE: path.join(other, '.git', 'index'),
    // What `git -c core.excludesFile=... <command>` exports to the hook or alias it runs.
    GIT_CONFIG_PARAMETERS: `'core.excludesfile'='${everything}'`,
    // Pathspec magic off, and trace lines on stderr.
    GIT_LITERAL_PATHSPECS: '1', GIT_TRACE: '1',
  }, () => checkHygiene({ root }));
  assert.deepEqual(report.findings.map(finding => finding.path), ['docs/a.md', 'docs/new.md']);
});

test('a checkout git cannot list is a setup error (exit 2), never a walk', t => {
  if (!hasGit()) return t.skip('git is not available');
  const broken = fixture(t, { '.git': 'gitdir: no-such-git-directory\n', 'docs/a.md': `x ${ZWSP}\n` });
  let result = run(['--root', broken], broken);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /cannot list the files of the git checkout .+: fatal: /);
  // A .git that is no repository, inside a checkout: git answers for the outer one.
  const outer = checkout(t, { tracked: { 'inner/docs/a.md': `x ${ZWSP}\n` } });
  fs.mkdirSync(path.join(outer, 'inner', '.git'));
  result = run(['--root', path.join(outer, 'inner')], outer);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /git does not take .+ for the top of its checkout/);
  const root = checkout(t, { tracked: { 'docs/a.md': `x ${ZWSP}\n` } });
  const emptyPath = tempDir(t, 'awwo-hygiene-no-git-');
  result = withEnvironment({ PATH: emptyPath }, () => run(['--root', root], root));
  assert.equal(result.code, 2);
  assert.match(result.stderr, /git is not available/);
});

test('missing default roots are listed rather than failing, and an empty default scan is a usage error', t => {
  const root = fixture(t, { 'scripts/a.mjs': 'export {};\n' });
  const report = checkHygiene({ root });
  assert.equal(report.listing, 'walk');
  assert.equal(report.filesScanned, 1);
  assert.deepEqual(report.missingRoots, DEFAULT_ROOTS.filter(name => name !== 'scripts'));
  assert.equal(exitCodeFor(report), 0);
  const empty = tempDir(t);
  const result = run(['--root', empty], empty);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /no source files found/);
  if (!hasGit()) return;
  // A checkout with no default root lists nothing: git without a pathspec would list the whole checkout.
  const elsewhere = checkout(t, { tracked: { 'other/x.md': `x ${ZWSP}\n` } });
  assert.throws(() => checkHygiene({ root: elsewhere }), /no source files found/);
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
  assert.equal(checkHygiene({ root, paths: ['docs'], cwd: root }).listing, 'paths');
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
  if (!hasGit()) return;
  const ignoredOnly = checkout(t, {
    tracked: { 'docs/.gitignore': 'out/\n', 'docs/a.md': 'clean\n' }, untracked: { 'docs/out/b.md': `y ${CR}\n` },
  });
  const gitRun = await spawnScan(['--root', ignoredOnly]);
  assert.equal(gitRun.code, 0);
  assert.match(gitRun.stdout, /^source hygiene: 1 files under .+ \(as git lists them/);
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
