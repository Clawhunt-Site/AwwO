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
//   no paths   walk the default roots under --root (default: the repository this script is in)
//   paths      scan only these files or directories, resolved from the current directory
// Lines and columns are 1-based; a column counts Unicode code points, not bytes or UTF-16 units.
// Exit codes: 0 clean or fully allowlisted, 1 findings not allowlisted, 2 usage, setup or read error.
//
// Dependency-free on purpose, so it runs before `npm ci` and in any worktree. Every character it looks for
// is written as an escape here, so this file never needs an allowlist entry of its own.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_ROOTS = Object.freeze([
  'backend', 'apps/web/src', 'apps/web/tests', 'apps/pi-worker', 'apps/openai-agents-worker',
  'apps/openai-agents-python-worker', 'apps/render-worker', 'apps/openmaus-worker', 'scripts', 'docs',
]);
export const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', 'build', 'coverage', '.git', '__pycache__']);
export const TEXT_EXTENSIONS = new Set([
  '.go', '.sql', '.ts', '.tsx', '.mjs', '.cjs', '.js', '.json', '.md', '.css', '.html', '.py', '.sh',
  '.yml', '.yaml', '.toml', '.txt', '.ps1',
]);
export const CATEGORIES = Object.freeze(['cr', 'control', 'zero-width', 'bidi', 'tag']);
export const ALLOWLIST_PATH = 'scripts/source-hygiene-allow.json';
/** Findings printed per file in text mode; --json always lists every finding. */
export const SHOWN_PER_FILE = 20;

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

/**
 * The files to scan. Without paths: the default roots under root (a missing root is listed, not an error).
 * With paths: each named file (if it has a text extension) or directory. A named path that does not exist
 * is a usage error, so a typo can never pass as a clean scan.
 */
export function resolveTargets(root, paths = [], cwd = process.cwd()) {
  const files = new Set();
  const missingRoots = [];
  const skipped = [];
  if (paths.length === 0) {
    for (const name of DEFAULT_ROOTS) {
      const full = path.join(root, name);
      if (isDirectory(full)) for (const file of collectFiles(full)) files.add(file);
      else missingRoots.push(name);
    }
    return { files: [...files], missingRoots, skipped };
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
  return { files: [...files], missingRoots, skipped };
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

/** The human-readable report: unallowed findings first, then what the allowlist covered, then the verdict. */
export function formatReport(report) {
  const lines = [];
  const absent = report.missingRoots.length ? ` (not present: ${report.missingRoots.join(', ')})` : '';
  lines.push(`source hygiene: ${report.filesScanned} files under ${report.root}${absent}`);
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
