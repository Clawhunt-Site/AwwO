#!/usr/bin/env node
// Source hygiene: carriage returns, control characters and invisible Unicode in source files.
//
// AwwO keeps its source LF-only and free of characters a reviewer cannot see (docs/laws/awwo-laws.md,
// AWWO-LAW-023 and AWWO-LAW-024). A stray CR changes the bytes that migration checksums and request goldens
// are computed from; zero-width, bidi and tag characters can make code or a prompt read differently from
// what actually runs. This script reports each such character as file:line:col with its code point and a
// category, and fails unless that exact file and category are listed in scripts/source-hygiene-allow.json
// with a reason.
//
// Usage: node scripts/check-source-hygiene.mjs [--root <dir>] [--json] [paths...]
//   no paths   scan the default roots under --root (default: the repository this script is in). In a git
//              checkout (--root holds its own .git) these are the files git lists there: tracked ones, and
//              untracked ones it does not ignore, so ignored output such as apps/openmaus-worker/.runtime/
//              is never read; when git cannot list them all (it fails or warns, or a root is behind a link),
//              the check stops with exit 2. Any other root, such as a `git archive` tree, is walked, skipping
//              SKIP_DIRECTORIES.
//   paths      scan only these files or directories, resolved from the current directory, by the same walk
// Lines and columns are 1-based; a column counts Unicode code points, not bytes or UTF-16 units.
// Exit codes: 0 clean or fully allowlisted, 1 findings not allowlisted, 2 usage, setup or read error.
//
// Dependency-free on purpose (a checkout's list of files comes from git itself), so it runs before `npm ci`
// and in any worktree. Every character it looks for is written as an escape here, so this file never needs an
// allowlist entry of its own.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_ROOTS = Object.freeze([
  'backend', 'apps/web/src', 'apps/web/tests', 'apps/pi-worker', 'apps/openai-agents-worker',
  'apps/openai-agents-python-worker', 'apps/render-worker', 'apps/openmaus-worker', 'scripts', 'docs',
]);
/** Directory names the walk never enters; a git listing leaves out what git ignores instead. */
export const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', 'build', 'coverage', '.git', '__pycache__']);
export const TEXT_EXTENSIONS = new Set([
  '.go', '.sql', '.ts', '.tsx', '.mjs', '.cjs', '.js', '.json', '.md', '.css', '.html', '.py', '.sh',
  '.yml', '.yaml', '.toml', '.txt', '.ps1',
]);
export const CATEGORIES = Object.freeze(['cr', 'control', 'zero-width', 'bidi', 'tag']);
export const ALLOWLIST_PATH = 'scripts/source-hygiene-allow.json';
/** Findings printed per file in text mode; --json always lists every finding. */
export const SHOWN_PER_FILE = 20;
// The variables that tie git to one repository, as `git rev-parse --local-env-vars` lists them (Git 2.43 to 2.50):
// git clears them itself before it works in another repository. A hook or alias may export them (`git -c` exports
// GIT_CONFIG_PARAMETERS), so they are left out of git's environment: git lists the checkout at --root, by its own
// settings. GIT_CONFIG_COUNT (with GIT_CONFIG_KEY_n and GIT_CONFIG_VALUE_n) stays: no git exports it, so it is a
// setting someone made on purpose, as a container's safe.directory.
export const GIT_REPOSITORY_VARIABLES = Object.freeze([
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_OBJECT_DIRECTORY', 'GIT_DIR',
  'GIT_WORK_TREE', 'GIT_IMPLICIT_WORK_TREE', 'GIT_GRAFT_FILE', 'GIT_INDEX_FILE', 'GIT_NO_REPLACE_OBJECTS',
  'GIT_REPLACE_REF_BASE', 'GIT_PREFIX', 'GIT_SHALLOW_FILE', 'GIT_COMMON_DIR',
]);
// The variables that change how git reads a pathspec (GIT_LITERAL_PATHSPECS=1 turns the listing's pathspec magic
// into a name nothing matches) or where its output goes (Git for Windows' GIT_REDIRECT_STDERR=off would hide the
// warnings the listing fails on); every GIT_TRACE* is left out too, as tracing writes to stderr.
export const GIT_LISTING_VARIABLES = Object.freeze([
  'GIT_LITERAL_PATHSPECS', 'GIT_GLOB_PATHSPECS', 'GIT_NOGLOB_PATHSPECS', 'GIT_ICASE_PATHSPECS',
  'GIT_REDIRECT_STDIN', 'GIT_REDIRECT_STDOUT', 'GIT_REDIRECT_STDERR',
]);
// What keeps git's stderr for warnings alone: no advice (GIT_ADVICE, where git knows it), and none of the three
// trace2 targets, which a configuration can turn on too (trace2.normalTarget and the like).
const GIT_QUIET = Object.freeze({ GIT_ADVICE: '0', GIT_TRACE2: '0', GIT_TRACE2_PERF: '0', GIT_TRACE2_EVENT: '0' });
/** The most output read from git: far more than the list of paths of any checkout. */
const GIT_OUTPUT_LIMIT = 256 * 1024 * 1024;

// The characters reported, as inclusive [first, last, category] code point ranges; tab (0x09) and LF (0x0a)
// are allowed. The classifier and the fast path are both built from this one table, and the ranges are
// numbers, so this source contains none of the characters it looks for.
export const FLAGGED_RANGES = Object.freeze([
  [0x0d, 0x0d, 'cr'],
  [0x00, 0x08, 'control'], [0x0b, 0x0c, 'control'], [0x0e, 0x1f, 'control'], [0x7f, 0x7f, 'control'],
  [0x200b, 0x200d, 'zero-width'], [0x2060, 0x2060, 'zero-width'], [0xfeff, 0xfeff, 'zero-width'],
  [0x200e, 0x200f, 'bidi'], [0x202a, 0x202e, 'bidi'], [0x2066, 0x2069, 'bidi'],
  [0xe0000, 0xe007f, 'tag'],
].map(range => Object.freeze(range)));

// A RegExp `\u{...}` escape, with the backslash made from its code point so no source escape is involved.
const asEscape = codePoint => `${String.fromCharCode(0x5c)}u{${codePoint.toString(16)}}`;
// One test of the whole text decides that a file is clean; only a suspect file is walked character by character.
const SUSPECT = new RegExp(`[${FLAGGED_RANGES.map(([first, last]) => (first === last
  ? asEscape(first) : `${asEscape(first)}-${asEscape(last)}`)).join('')}]`, 'u');

export class UsageError extends Error {}

/** The category of one code point, or null when the character is allowed. */
export function classifyCodePoint(codePoint) {
  for (const [first, last, category] of FLAGGED_RANGES) if (codePoint >= first && codePoint <= last) return category;
  return null;
}

/** "U+200B", "U+E0041": the notation reviewers search for. */
export function formatCodePoint(codePoint) {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
}

/** Every flagged character of a text as {line, column, codePoint, category}, in order. */
export function scanText(text) {
  if (!SUSPECT.test(text)) return [];
  const findings = [];
  let line = 1;
  let column = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    column += 1;
    if (codePoint === 0x0a) {
      line += 1;
      column = 0;
      continue;
    }
    const category = classifyCodePoint(codePoint);
    if (category) findings.push({ line, column, codePoint, category });
  }
  return findings;
}

/** Scans one file's bytes as UTF-8. Buffer decoding keeps a leading BOM, so U+FEFF at 1:1 is reported. */
export function scanFile(file) {
  return scanText(fs.readFileSync(file).toString('utf8'));
}

export function isTextFile(name) {
  return TEXT_EXTENSIONS.has(path.extname(name).toLowerCase());
}

export function toPosix(relative) {
  return relative.split(path.sep).join('/');
}

/** A path relative to root in POSIX form; a path outside root keeps its absolute form and never matches. */
export function repoRelative(root, file) {
  const relative = path.relative(root, file);
  const outside = !relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  return toPosix(outside ? path.resolve(file) : relative);
}

/**
 * Text files under a directory in a stable order. Skipped directories are never entered; symbolic links
 * and junctions are not followed, since they can leave the tree or loop.
 */
export function collectFiles(directory, files = []) {
  const entries = fs.readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRECTORIES.has(entry.name)) collectFiles(full, files);
    } else if (entry.isFile() && isTextFile(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function isLink(target) {
  try {
    return fs.lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Whether root is the top of a git checkout: its own .git is there (a directory, or a file in a worktree). */
export function isGitCheckout(root) {
  return fs.existsSync(path.join(root, '.git'));
}

/** An environment for git without GIT_REPOSITORY_VARIABLES, GIT_LISTING_VARIABLES and GIT_TRACE*. */
export function gitEnvironment(environment = process.env) {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => {
    // Windows reads variable names in any case.
    const upper = name.toUpperCase();
    return !GIT_REPOSITORY_VARIABLES.includes(upper) && !GIT_LISTING_VARIABLES.includes(upper)
      && !upper.startsWith('GIT_TRACE');
  }));
}

/** A text with each character this check reports written as its code point, so no message carries one. */
function visible(text) {
  return [...text].map(character => (classifyCodePoint(character.codePointAt(0))
    ? `<${formatCodePoint(character.codePointAt(0))}>` : character)).join('');
}

/**
 * git's raw output for args, run in root. A failure, or any warning (git warns and still exits 0 when it cannot
 * open a directory), is a setup error: the checkout's files could not all be listed. Advice and tracing are
 * turned off (GIT_QUIET), since they are no warnings, and the sparse index's hint by name as well, which Git 2.50
 * prints on stderr when a pathspec reaches past a sparse checkout.
 */
function runGit(root, args) {
  const result = spawnSync('git', ['-C', root, '-c', 'advice.sparseIndexExpanded=false', ...args], {
    env: { ...gitEnvironment(), ...GIT_QUIET }, maxBuffer: GIT_OUTPUT_LIMIT, stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const said = String(result.stderr ?? '').split(/\r?\n/).map(line => line.trim()).find(Boolean);
  const problem = result.error ? (result.error.code === 'ENOENT' ? 'git is not available' : result.error.message)
    : result.status !== 0 ? said || `exit ${result.status ?? result.signal}` : said;
  if (problem) throw new UsageError(`cannot list the files of the git checkout ${root}: ${visible(problem)}`);
  return result.stdout;
}

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * The text paths in git's NUL-separated output, each entry whole (ls-files -t's tag included). An entry is kept by
 * its extension before it is decoded, so a file this check never reads cannot stop it; a kept one that is not UTF-8
 * (possible on POSIX) cannot be named to the file system again, so it is a setup error, not a file left unread.
 */
function decodeTextPaths(output) {
  const paths = [];
  for (let start = 0; start < output.length;) {
    let end = output.indexOf(0, start);
    if (end === -1) end = output.length;
    const bytes = output.subarray(start, end);
    start = end + 1;
    // Every text extension is ASCII, and no byte of another character is.
    if (!isTextFile(bytes.toString('latin1'))) continue;
    try {
      paths.push(UTF8.decode(bytes));
    } catch {
      const shown = [...bytes].map(byte => (byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte)
        : `\\x${byte.toString(16).padStart(2, '0')}`)).join('');
      throw new UsageError(`git lists a path that is not UTF-8, which this check cannot read: ${shown}`);
    }
  }
  return paths;
}

/** Orders repo-relative POSIX paths as the walk visits them: name by name, a directory's files in its place. */
function compareSegments(a, b) {
  const left = a.split('/');
  const right = b.split('/');
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return left.length - right.length;
}

/** The first directory on a repo-relative directory path, itself included, that is a link or junction, or null. */
function firstLink(root, directory, links) {
  const segments = directory.split('/');
  for (let depth = 1; depth <= segments.length; depth += 1) {
    const prefix = segments.slice(0, depth).join('/');
    if (!links.has(prefix)) links.set(prefix, isLink(path.join(root, ...segments.slice(0, depth))));
    if (links.get(prefix)) return prefix;
  }
  return null;
}

/** How lstat finds a listed path: 'file', 'missing' (ENOENT, ENOTDIR), 'other' (a directory, a link) or 'unknown'. */
function lstatState(file) {
  try {
    return fs.lstatSync(file).isFile() ? 'file' : 'other';
  } catch (error) {
    return error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 'missing' : 'unknown';
  }
}

/**
 * The repo-relative text paths git lists under the named directories of the checkout at root: tracked files, and
 * untracked ones git does not ignore. A named directory reached through a link is a setup error, as git lists the
 * link, not the files behind it.
 */
function gitListing(root, names, pathspecs, links) {
  const [inside, prefix] = runGit(root, ['rev-parse', '--is-inside-work-tree', '--show-prefix'])
    .toString('utf8').split(/\r?\n/);
  if (inside !== 'true' || prefix) throw new UsageError(`git does not take ${root} for the top of its checkout`);
  for (const name of names) {
    const link = firstLink(root, name, links);
    if (link) {
      throw new UsageError(`default root ${name} goes through the link ${link}: git lists the link, not the files `
        + 'behind it (name the root as a path to walk it)');
    }
  }
  return new Set(decodeTextPaths(runGit(root, [
    'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...pathspecs,
  ])));
}

/**
 * The tracked paths git itself says are not in the working tree, and need not be: deleted from it (git's tag R)
 * or left out of a sparse checkout (S, skip-worktree, which `--deleted` alone does not list).
 */
function absentByGit(root, pathspecs) {
  const absent = new Set();
  const tagged = runGit(root, ['ls-files', '-z', '-t', '--cached', '--deleted', '--', ...pathspecs]);
  for (const entry of decodeTextPaths(tagged)) {
    if (entry.startsWith('R ') || entry.startsWith('S ')) absent.add(entry.slice(2));
  }
  return absent;
}

/**
 * The text files git lists under the named directories of the checkout at root, in the walk's order. Like the
 * walk, it reads nothing through a symbolic link or junction below the names, although Git for Windows lists
 * files through a junction. Only a tracked file git itself says is absent (absentByGit) is passed over when it
 * cannot be found: any other listed path that cannot be (a name the file system spells otherwise) is kept, so that
 * reading it fails the scan. Git for Windows spells a lone surrogate in a name as U+FFFD, so such a file fails it
 * unless something really spelled with U+FFFD sits beside it, which git, and so this check, reads in its place; git
 * cannot add that file either, so the repository can never hold it.
 */
export function listGitFiles(root, names) {
  // No pathspec would list the whole checkout.
  if (names.length === 0) return [];
  // Literal, and blind to case as Windows and macOS are when they find a root spelled otherwise in the index; on
  // a case-sensitive file system this can only add a sibling such as DOCS/.
  const pathspecs = names.map(name => `:(literal,icase)${name}`);
  const links = new Map();
  const groups = new Map([...names, ''].map(name => [name, []]));
  for (const relative of gitListing(root, names, pathspecs, links)) {
    // Matched as the pathspecs are, whatever the case; a path under no name at all is still scanned, after them.
    const lower = relative.toLowerCase();
    groups.get(names.find(name => lower.startsWith(`${name.toLowerCase()}/`)) ?? '').push(relative);
  }
  let absent = null;
  const files = [];
  for (const group of groups.values()) {
    for (const relative of group.sort(compareSegments)) {
      if (firstLink(root, path.posix.dirname(relative), links)) continue;
      const file = path.join(root, ...relative.split('/'));
      const state = lstatState(file);
      if (state === 'missing') {
        // Asked once, and only when a listed file is missing: a present file is read whatever git's tag says.
        absent ??= absentByGit(root, pathspecs);
        if (absent.has(relative)) continue;
      }
      if (state !== 'other') files.push(file);
    }
  }
  return files;
}

/**
 * The files to scan and how they were found (listing: git, walk or paths). Without paths: the default roots
 * under root (a missing root is listed, not an error), as git lists them in a git checkout and as the walk
 * finds them elsewhere. With paths: each named file (if it has a text extension) or directory, walked. A named
 * path that does not exist is a usage error, so a typo can never pass as a clean scan.
 */
export function resolveTargets(root, paths = [], cwd = process.cwd()) {
  const files = new Set();
  const missingRoots = [];
  const skipped = [];
  if (paths.length === 0) {
    const present = [];
    for (const name of DEFAULT_ROOTS) (isDirectory(path.join(root, name)) ? present : missingRoots).push(name);
    if (isGitCheckout(root)) return { files: listGitFiles(root, present), missingRoots, skipped, listing: 'git' };
    for (const name of present) for (const file of collectFiles(path.join(root, name))) files.add(file);
    return { files: [...files], missingRoots, skipped, listing: 'walk' };
  }
  for (const given of paths) {
    const full = path.resolve(cwd, given);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      throw new UsageError(`no such file or directory: ${given}`);
    }
    if (stat.isDirectory()) for (const file of collectFiles(full)) files.add(file);
    else if (stat.isFile() && isTextFile(full)) files.add(full);
    else skipped.push(given);
  }
  return { files: [...files], missingRoots, skipped, listing: 'paths' };
}

function isRepoRelativePosix(value) {
  return value.length > 0 && !value.includes('\\') && !value.startsWith('/') && !/^[A-Za-z]:/.test(value)
    && !/[*?]/.test(value) && value.split('/').every(segment => segment && segment !== '.' && segment !== '..');
}

function validateEntry(entry, at, seen) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new UsageError(`${at} must be an object`);
  const extra = Object.keys(entry).filter(key => !['path', 'categories', 'reason'].includes(key));
  if (extra.length) throw new UsageError(`${at} has unknown keys: ${extra.join(', ')}`);
  const { path: file, categories, reason } = entry;
  if (typeof file !== 'string' || !isRepoRelativePosix(file)) {
    throw new UsageError(`${at}: path must be an exact repo-relative POSIX path such as "docs/example.md"`);
  }
  if (seen.has(file)) throw new UsageError(`${at}: ${file} is listed twice; put all its categories in one entry`);
  if (!Array.isArray(categories) || categories.length === 0
    || categories.some(category => !CATEGORIES.includes(category)) || new Set(categories).size !== categories.length) {
    throw new UsageError(`${at}: categories must be a non-empty list drawn from ${CATEGORIES.join(', ')}`);
  }
  if (typeof reason !== 'string' || !reason.trim()) throw new UsageError(`${at}: reason must say why the characters are intended`);
  return { path: file, categories: [...categories], reason: reason.trim() };
}

/** Parses and validates the allowlist text; returns its entries. Any malformed entry is a usage error. */
export function parseAllowlist(text, source = ALLOWLIST_PATH) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new UsageError(`${source} is not valid JSON: ${error.message}`);
  }
  if (!Array.isArray(parsed)) throw new UsageError(`${source} must be a JSON array of {path, categories, reason}`);
  const seen = new Set();
  return parsed.map((entry, index) => {
    const valid = validateEntry(entry, `${source} entry ${index + 1}`, seen);
    seen.add(valid.path);
    return valid;
  });
}

/** The allowlist under root; a missing file means an empty allowlist. */
export function loadAllowlist(root) {
  const file = path.join(root, ALLOWLIST_PATH);
  if (!fs.existsSync(file)) return [];
  return parseAllowlist(fs.readFileSync(file, 'utf8'));
}

/** Marks each finding allowed or not, and lists allowlisted categories that matched nothing. */
export function applyAllowlist(findings, entries) {
  const allowed = new Map(entries.map(entry => [entry.path, new Set(entry.categories)]));
  const used = new Set();
  const marked = findings.map(finding => {
    const ok = allowed.get(finding.path)?.has(finding.category) === true;
    if (ok) used.add(`${finding.path}\n${finding.category}`);
    return { ...finding, allowed: ok };
  });
  const stale = [];
  for (const entry of entries) {
    const unused = entry.categories.filter(category => !used.has(`${entry.path}\n${category}`));
    if (unused.length) stale.push({ path: entry.path, categories: unused });
  }
  return { findings: marked, stale };
}

/** Scans files and returns findings with repo-relative paths, plus files that could not be read. */
export function scanFiles(root, files) {
  const findings = [];
  const errors = [];
  for (const file of files) {
    const relative = repoRelative(root, file);
    try {
      for (const finding of scanFile(file)) findings.push({ path: relative, ...finding });
    } catch (error) {
      errors.push({ path: relative, error: error.code || error.message });
    }
  }
  return { findings, errors };
}

/** Runs a whole check and returns the report the CLI prints. Throws UsageError for setup problems. */
export function checkHygiene({ root = REPO_ROOT, paths = [], cwd = process.cwd() } = {}) {
  if (!isDirectory(root)) throw new UsageError(`--root is not a directory: ${root}`);
  const entries = loadAllowlist(root);
  const targets = resolveTargets(root, paths, cwd);
  if (paths.length === 0 && targets.files.length === 0) {
    throw new UsageError(`no source files found under ${root}; is --root the repository?`);
  }
  const scanned = scanFiles(root, targets.files);
  const { findings, stale } = applyAllowlist(scanned.findings, entries);
  const notAllowed = findings.filter(finding => !finding.allowed);
  return {
    root,
    listing: targets.listing,
    filesScanned: targets.files.length,
    missingRoots: targets.missingRoots,
    skipped: targets.skipped,
    errors: scanned.errors,
    // A partial scan cannot tell whether an entry still matters, so staleness is reported only for full scans.
    staleAllowlist: paths.length === 0 ? stale : [],
    findings: findings.map(finding => ({ ...finding, codePoint: formatCodePoint(finding.codePoint) })),
    summary: {
      findings: findings.length,
      notAllowed: notAllowed.length,
      allowed: findings.length - notAllowed.length,
      filesWithFindings: new Set(notAllowed.map(finding => finding.path)).size,
    },
  };
}

/** Exit code of a report: read errors make the scan incomplete (2); otherwise any unallowed finding fails (1). */
export function exitCodeFor(report) {
  if (report.errors.length) return 2;
  return report.summary.notAllowed > 0 ? 1 : 0;
}

function groupByPath(findings) {
  const groups = new Map();
  for (const finding of findings) {
    if (!groups.has(finding.path)) groups.set(finding.path, []);
    groups.get(finding.path).push(finding);
  }
  return groups;
}

function countByCategory(findings) {
  const counts = new Map();
  for (const finding of findings) counts.set(finding.category, (counts.get(finding.category) || 0) + 1);
  return [...counts].map(([category, count]) => `${category} x${count}`).join(', ');
}

const LISTING_NOTES = Object.freeze({
  git: ' (as git lists them: tracked, or untracked and not ignored)',
  walk: ' (not a git checkout: a directory walk)',
});

/** The human-readable report: unallowed findings first, then what the allowlist covered, then the verdict. */
export function formatReport(report) {
  const lines = [];
  const absent = report.missingRoots.length ? ` (not present: ${report.missingRoots.join(', ')})` : '';
  lines.push(`source hygiene: ${report.filesScanned} files under ${report.root}${LISTING_NOTES[report.listing] ?? ''}${absent}`);
  if (report.skipped.length) lines.push(`skipped (not a text extension): ${report.skipped.join(', ')}`);
  for (const error of report.errors) lines.push(`ERROR ${error.path}: cannot read (${error.error})`);
  for (const [file, group] of groupByPath(report.findings.filter(finding => !finding.allowed))) {
    for (const finding of group.slice(0, SHOWN_PER_FILE)) {
      lines.push(`${file}:${finding.line}:${finding.column} ${finding.codePoint} ${finding.category}`);
    }
    if (group.length > SHOWN_PER_FILE) lines.push(`${file}: ... ${group.length - SHOWN_PER_FILE} more (use --json for all)`);
  }
  for (const [file, group] of groupByPath(report.findings.filter(finding => finding.allowed))) {
    lines.push(`allowlisted: ${file} (${countByCategory(group)})`);
  }
  for (const entry of report.staleAllowlist) {
    lines.push(`stale allowlist entry: ${entry.path} [${entry.categories.join(', ')}] matched nothing; remove it`);
  }
  const { notAllowed, filesWithFindings } = report.summary;
  if (report.errors.length) lines.push(`${report.errors.length} files could not be read; the scan is incomplete.`);
  if (notAllowed > 0) {
    lines.push(`FAIL: ${notAllowed} findings in ${filesWithFindings} files are not allowlisted.`);
    lines.push('Fix: convert CRLF to LF (.gitattributes asks for eol=lf); delete control, zero-width, bidi and tag');
    lines.push(`characters, or write them as escapes such as \\u200B. Intended ones go in ${ALLOWLIST_PATH} with a reason.`);
  } else if (!report.errors.length) {
    lines.push('OK: no findings outside the allowlist.');
  }
  return `${lines.join('\n')}\n`;
}

export const USAGE = `Usage: node scripts/check-source-hygiene.mjs [--root <dir>] [--json] [paths...]
Reports CR, control, zero-width, bidi and tag characters in source files.
Without paths, a git checkout's default roots are scanned as git lists them, so ignored files are not read.
Exit codes: 0 clean or fully allowlisted, 1 findings not allowlisted, 2 usage, setup or read error.
`;

export function parseArguments(argv) {
  const options = { root: null, json: false, help: false, paths: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') {
      options.paths.push(...argv.slice(index + 1));
      break;
    }
    if (argument === '--json') options.json = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--root' || argument.startsWith('--root=')) {
      const value = argument === '--root' ? argv[index += 1] : argument.slice('--root='.length);
      if (!value || value.startsWith('--')) throw new UsageError('--root needs a directory');
      options.root = value;
    } else if (argument.startsWith('-')) throw new UsageError(`unknown option ${argument}`);
    else options.paths.push(argument);
  }
  return options;
}

/** The CLI without process globals, so tests can drive it. Returns the exit code. */
export function main(argv, { cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const options = parseArguments(argv);
    if (options.help) {
      stdout.write(USAGE);
      return 0;
    }
    const root = options.root ? path.resolve(cwd, options.root) : REPO_ROOT;
    const report = checkHygiene({ root, paths: options.paths, cwd });
    stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report));
    return exitCodeFor(report);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    stderr.write(`check-source-hygiene: ${error.message}\n${USAGE}`);
    return 2;
  }
}

// Compared through realpath (and case-folded on Windows) so a differently spelled path to this file can
// never turn the check into a silent no-op that exits 0.
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    const self = fs.realpathSync(fileURLToPath(import.meta.url));
    const invoked = fs.realpathSync(path.resolve(process.argv[1]));
    return process.platform === 'win32' ? self.toLowerCase() === invoked.toLowerCase() : self === invoked;
  } catch {
    return false;
  }
}

if (invokedDirectly()) process.exitCode = main(process.argv.slice(2));
