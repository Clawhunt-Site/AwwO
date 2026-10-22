// The licences of the npm packages AwwO Local's payload carries: the workers' packages as the packager installs them
// (npm ci --omit=dev), for Windows on x64, without LEFT_OUT_PACKAGES. A package that ships neither a licence file nor a
// README carrying its licence's text gets its repository's licence files, fetched at the commit it was published from
// (gitHead in the registry), else at its version's tag, else (a registry entry naming neither) at the default branch's
// commit of the day, recorded as such; they must be of the licence the package names. They go into
// third_party/npm-packages/<name>@<version>/ (a scope's slash as "+"), with PROVENANCE.json naming every file's address
// and SHA-256. scripts/awwo-local-package.mjs (collectNpmLicences) carries them, and stops on a package with no licence
// anywhere, or under one not in PERMISSIVE_LICENCES.
//
//   node scripts/awwo-npm-licences.mjs           fetch what is missing (after npm run setup:local installed the workers)
//   node scripts/awwo-npm-licences.mjs --check   fail when one is missing, or differs from its provenance
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { repoRoot } from './awwo-local-lib.mjs';
import { fetchBytes, licenceExpressionHolds, licenceTextMatches, provenanceDifferences, sha256 } from './awwo-licence-files.mjs';

export const OUTPUT = path.join(repoRoot, 'third_party', 'npm-packages');
/** The workers whose packages the payload carries (PACKAGED_WORKERS of the packager). */
const WORKERS = ['pi-worker', 'openai-agents-worker', 'render-worker'];
/** A licence file's name, as packages ship them. */
export const LICENCE_FILE = /^((mit|apache|bsd)[-._])?(licen[cs]e|copying|notice|copyright|unlicense)([-._].*)?$/i;
const CANDIDATES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'LICENSE-MIT', 'LICENSE-APACHE', 'COPYING', 'NOTICE', 'NOTICE.md'];
/** The licences a package carried may be under: permissive ones, none asking for the source of what is shipped. */
export const PERMISSIVE_LICENCES = Object.freeze(['MIT', 'ISC', '0BSD', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', 'Unlicense', 'BlueOak-1.0.0', 'CC0-1.0', 'Zlib']);
/** Packages the payload leaves out, with their builds for each machine: the coding agent's clipboard (a native addon),
 *  which no worker uses (they run no terminal) and which the agent loads only if it is there (in a try, taking its
 *  absence as no clipboard), as on the hosted workers, where Linux without a display never loads it. */
export const LEFT_OUT_PACKAGES = Object.freeze(['@mariozechner/clipboard']);
export const leftOutPackage = name => LEFT_OUT_PACKAGES.some(left => name === left || name.startsWith(`${left}-`));

/** Whether a package.json's os and cpu fields (npm's own) allow Windows on x64: a package built for another system or
 *  machine is never loaded here (as npm does not install such an optional one; some packages bundle them all). */
export const forThisMachine = manifest => {
  const allows = (list, value) => !Array.isArray(list) || !list.length
    || (list.some(item => !String(item).startsWith('!')) ? list.includes(value) : !list.includes(`!${value}`));
  return allows(manifest.os, 'win32') && allows(manifest.cpu, 'x64');
};

/** Whether an SPDX expression leaves a permissive choice: each licence it needs (all of an AND, one of an OR) is one
 *  (a WITH's exception only adds permissions to its licence). */
export const permissiveLicence = expression => licenceExpressionHolds(expression, id => PERMISSIVE_LICENCES.includes(id));

/** The folder of a package's fetched licences. */
export const folderOf = (name, version) => `${name.replace('/', '+')}@${version}`;

const licenceOf = manifest => typeof manifest.license === 'string' ? manifest.license
  : manifest.license?.type || (Array.isArray(manifest.licenses) ? manifest.licenses.map(item => item.type).join(' OR ') : '');

/** A package's own licence files; where it ships none, its README when that carries the text of its licence. */
export function shippedNpmLicences(dir, licence) {
  const files = readdirSync(dir).filter(name => LICENCE_FILE.test(name) && statSync(path.join(dir, name)).isFile());
  if (files.length) return { files: files.map(name => path.join(dir, name)), readme: null };
  const readme = readdirSync(dir).find(name => /^readme(\.(md|markdown|txt))?$/i.test(name));
  const carries = readme && licenceTextMatches(licence, [readFileSync(path.join(dir, readme), 'utf8')]);
  return { files: [], readme: carries ? path.join(dir, readme) : null };
}

/** The packages installed below some node_modules folders, once each by name and version, as the payload carries them
 *  (for Windows on x64, without those it leaves out), each with where it is, its licence and what of it is its licence. */
export function installedPackages(roots) {
  const found = new Map();
  const walk = modules => {
    if (!existsSync(modules)) return;
    for (const name of readdirSync(modules)) {
      const entries = name.startsWith('@') ? readdirSync(path.join(modules, name)).map(inner => path.join(name, inner)) : [name];
      for (const entry of entries) {
        const dir = path.join(modules, entry);
        const manifestFile = path.join(dir, 'package.json');
        if (!existsSync(manifestFile)) continue;
        const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
        if (!forThisMachine(manifest) || leftOutPackage(manifest.name)) continue;
        const key = `${manifest.name}@${manifest.version}`;
        const licence = licenceOf(manifest);
        if (!found.has(key)) found.set(key, { name: manifest.name, version: manifest.version, licence, dir, ...shippedNpmLicences(dir, licence) });
        walk(path.join(dir, 'node_modules'));
      }
    }
  };
  for (const root of roots) walk(root);
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

/** A repository's owner/name on GitHub, from a package.json's repository. */
export function githubRepository(repository) {
  const url = typeof repository === 'string' ? repository : repository?.url || '';
  const shorthand = /^(?:github:)?([\w.-]+\/[\w.-]+)$/.exec(url);
  if (shorthand) return shorthand[1].replace(/\.git$/, '');
  const match = /github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?(?:[/#?]|$)/.exec(url);
  return match ? match[1] : null;
}

/** The package's folder in its repository (its repository's directory, else the folder its homepage shows) and each
 *  folder above it, to the root: a monorepo keeps the licence of a package's part above the package, or at its root. */
export function repositoryFolders(registry) {
  const directory = typeof registry.repository === 'object' && registry.repository?.directory
    || /github\.com\/[\w.-]+\/[\w.-]+\/tree\/[^/]+\/([^#?]+?)\/?(?:[#?]|$)/.exec(String(registry.homepage || ''))?.[1] || '';
  const parts = directory.split('/').filter(part => part && part !== '.');
  return parts.map((_, index) => parts.slice(0, parts.length - index).join('/')).concat('');
}

/** The default branch's commit of a GitHub repository, now. */
function defaultBranchCommit(repository) {
  const result = spawnSync('git', ['ls-remote', `https://github.com/${repository}.git`, 'HEAD'], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  const commit = /^([0-9a-f]{40})\s+HEAD$/m.exec(String(result.stdout))?.[1];
  return result.status === 0 && commit ? commit : null;
}

/** A package's licence files from its repository: those nearest its folder (repositoryFolders); at the commit it was
 *  published from, else its version's tag, else the default branch's commit now. They must be of the licence it names. */
function fetchPackageLicences(item) {
  const meta = fetchBytes(`https://registry.npmjs.org/${item.name.replace('/', '%2F')}/${item.version}`);
  if (!meta) return { files: [], why: 'its registry entry could not be fetched' };
  const registry = JSON.parse(meta.toString('utf8'));
  const repository = githubRepository(registry.repository);
  if (!repository) return { files: [], why: `its repository (${JSON.stringify(registry.repository || null)}) is not on GitHub` };
  const refs = [
    ...(registry.gitHead ? [{ ref: registry.gitHead, how: 'published' }] : []),
    ...[`v${item.version}`, item.version, `${item.name}@${item.version}`].map(ref => ({ ref, how: 'tag' })),
  ];
  let mismatched = false;
  for (const attempt of [...refs, null]) {
    const at = attempt || (registry.gitHead ? null : { ref: defaultBranchCommit(repository), how: 'default branch' });
    if (!at?.ref) break;
    for (const folder of repositoryFolders(registry)) {
      const files = [];
      for (const name of CANDIDATES) {
        const url = `https://raw.githubusercontent.com/${repository}/${encodeURIComponent(at.ref).replaceAll('%2F', '/')}/${folder ? `${folder}/` : ''}${name}`;
        const bytes = fetchBytes(url);
        if (bytes) files.push({ name, url, bytes });
      }
      if (!files.length) continue;
      if (licenceTextMatches(item.licence, files.map(file => file.bytes.toString('utf8')))) return { files, repository: `https://github.com/${repository}`, ref: at.ref, how: at.how };
      mismatched = true;
    }
    if (!attempt) break;
  }
  return { files: [], why: mismatched ? `its repository's licence files are not of ${item.licence}` : `no licence file in https://github.com/${repository}` };
}

function main(args) {
  const check = args.includes('--check');
  const roots = WORKERS.map(worker => path.join(repoRoot, 'apps', worker, 'node_modules'));
  const provenanceFile = path.join(OUTPUT, 'PROVENANCE.json');
  const provenance = existsSync(provenanceFile) ? JSON.parse(readFileSync(provenanceFile, 'utf8')) : {};
  const missing = check ? provenanceDifferences(OUTPUT) : [];
  const installed = installedPackages(roots);
  for (const item of installed.filter(entry => !entry.files.length && !entry.readme)) {
    const key = folderOf(item.name, item.version);
    const folder = path.join(OUTPUT, key);
    const have = existsSync(folder) ? readdirSync(folder) : [];
    if (have.length && licenceTextMatches(item.licence, have.map(name => readFileSync(path.join(folder, name), 'utf8')))) continue;
    if (check) { missing.push(have.length ? `${key} (its files here are not of ${item.licence})` : key); continue; }
    const fetched = fetchPackageLicences(item);
    if (!fetched.files.length) { missing.push(`${key} (${fetched.why})`); continue; }
    mkdirSync(folder, { recursive: true });
    provenance[key] = { repository: fetched.repository, ref: fetched.ref, from: fetched.how, license: item.licence || null, files: {} };
    for (const file of fetched.files) {
      writeFileSync(path.join(folder, file.name), file.bytes);
      provenance[key].files[file.name] = { url: file.url, sha256: sha256(file.bytes) };
    }
    console.log(`${key}: ${fetched.files.map(file => file.name).join(', ')} (${fetched.how === 'published' ? 'at the published commit' : `at the ${fetched.how} ${fetched.ref}`})`);
  }
  // A folder here for a package no worker carries any more is one to remove.
  const carried = new Set(installed.map(item => folderOf(item.name, item.version)));
  if (check) for (const key of Object.keys(provenance)) if (!carried.has(key)) missing.push(`${key} (no worker carries it: remove it)`);
  if (!check) {
    mkdirSync(OUTPUT, { recursive: true });
    writeFileSync(provenanceFile, `${JSON.stringify(Object.fromEntries(Object.entries(provenance).sort(([a], [b]) => a.localeCompare(b))), null, 2)}\n`);
  }
  if (missing.length) throw new Error(`No licence here for: ${missing.join(', ')}${check ? ' (node scripts/awwo-npm-licences.mjs fetches them)' : ''}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
