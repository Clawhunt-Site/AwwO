// The licence files of the Rust crates AwwO Local's window links that ship none in their packages, fetched from each
// crate's repository at the commit it was published from (its .cargo_vcs_info.json), into third_party/rust-crates/
// <name>-<version>/, with PROVENANCE.json naming every file's address and SHA-256; and the licence of the WebView2 SDK,
// whose loader webview2-com-sys links into the program, from Microsoft's NuGet package of the version it bundles.
// scripts/awwo-local-package.mjs (collectCrateLicences) takes these where a crate ships no licence of its own.
//
//   node scripts/awwo-crate-licences.mjs           fetch what is missing
//   node scripts/awwo-crate-licences.mjs --check   fail when a crate that ships no licence has none here, or a file here
//                                                  differs from its provenance or is not of its crate's licence
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { repoRoot } from './awwo-local-lib.mjs';
import { fetchBytes, licenceTextMatches, provenanceDifferences, sha256 } from './awwo-licence-files.mjs';

export const OUTPUT = path.join(repoRoot, 'third_party', 'rust-crates');
const SHELL = path.join(repoRoot, 'apps', 'windows-local');
/** A licence file's name, as crates ship them. */
export const LICENCE_FILE = /^(licen[cs]e|copying|notice|copyright|unlicense)([-._].*)?$/i;
/** The names a repository keeps its licences under, tried in turn at the crate's folder and then at the root. */
const CANDIDATES = ['LICENSE', 'LICENSE-MIT', 'LICENSE-APACHE', 'LICENSE.md', 'LICENSE.txt', 'LICENSE-MIT.md', 'LICENSE-APACHE.md', 'COPYING', 'NOTICE'];
/** The crate that links Microsoft's WebView2 loader into the program, and the SDK each of its versions bundles (its
 *  CHANGELOG, "update WebView2 SDK to …"): a version not here stops the packaging until its SDK is looked up. */
export const WEBVIEW2 = Object.freeze({ crate: 'webview2-com-sys', sdk: Object.freeze({ '0.38.2': '1.0.3650.58' }) });
const SDK_LICENCE = 'WebView2-SDK-LICENSE.txt';

/** The WebView2 SDK a version of webview2-com-sys bundles. */
export function webview2Sdk(version) {
  const sdk = WEBVIEW2.sdk[version];
  if (!sdk) throw new Error(`${WEBVIEW2.crate} ${version} bundles a WebView2 SDK this script does not know: add its version (the crate's CHANGELOG names it) to WEBVIEW2 in scripts/awwo-crate-licences.mjs`);
  return sdk;
}

export function shellMetadata(shell = SHELL) {
  const result = spawnSync('cargo', ['metadata', '--offline', '--format-version', '1', '--filter-platform', 'x86_64-pc-windows-msvc', '--manifest-path', path.join(shell, 'Cargo.toml')],
    { encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`cargo metadata failed (cargo fetch in ${shell} first):\n${String(result.stderr).slice(-1000)}`);
  return JSON.parse(result.stdout);
}

/** The crates a cargo metadata links into the program: the root's normal dependencies and theirs. */
export function linkedCrates(metadata) {
  const nodes = new Map(metadata.resolve.nodes.map(node => [node.id, node]));
  const linked = new Set();
  const visit = id => {
    for (const dep of nodes.get(id)?.deps || []) {
      if (linked.has(dep.pkg) || !dep.dep_kinds.some(kind => kind.kind === null)) continue;
      linked.add(dep.pkg);
      visit(dep.pkg);
    }
  };
  visit(metadata.resolve.root);
  return metadata.packages.filter(item => linked.has(item.id));
}

/** The licence files a crate's package ships (and its license_file). */
export function shippedLicences(crate) {
  const dir = path.dirname(crate.manifest_path);
  const files = readdirSync(dir).filter(name => LICENCE_FILE.test(name) && statSync(path.join(dir, name)).isFile()).map(name => path.join(dir, name));
  if (crate.license_file && existsSync(path.join(dir, crate.license_file)) && !files.some(file => path.basename(file) === path.basename(crate.license_file))) files.push(path.join(dir, crate.license_file));
  return files;
}

/** The licence files of a crate's repository at the commit it was published from: those of its folder, else of the
 *  root, as long as they are of the licence the crate names. A package published with changes not in a commit (dirty)
 *  has no such commit. */
function fetchCrateLicences(crate) {
  const vcs = path.join(path.dirname(crate.manifest_path), '.cargo_vcs_info.json');
  const repository = String(crate.repository || '').replace(/\/+$/, '').replace(/\.git$/, '');
  const github = /^https:\/\/github\.com\/([^/]+\/[^/]+)$/.exec(repository);
  if (!existsSync(vcs) || !github) return [];
  const info = JSON.parse(readFileSync(vcs, 'utf8'));
  const commit = info.git?.sha1;
  if (!/^[0-9a-f]{40}$/.test(commit || '') || info.git?.dirty) return [];
  for (const folder of [...new Set([info.path_in_vcs || '', ''])]) {
    const found = [];
    for (const name of CANDIDATES) {
      const url = `https://raw.githubusercontent.com/${github[1]}/${commit}/${folder ? `${folder}/` : ''}${name}`;
      const bytes = fetchBytes(url);
      if (bytes) found.push({ name, url, bytes });
    }
    if (found.length && licenceTextMatches(crate.license, found.map(file => file.bytes.toString('utf8')))) return found;
  }
  return [];
}

/** The WebView2 SDK's LICENSE.txt, from Microsoft's NuGet package of a version. */
function fetchWebView2Licence(sdk) {
  const url = `https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/${sdk}/microsoft.web.webview2.${sdk}.nupkg`;
  const bytes = fetchBytes(url);
  if (!bytes) throw new Error(`Could not fetch ${url}`);
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'webview2-sdk-'));
  try {
    writeFileSync(path.join(scratch, 'sdk.zip'), bytes);
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    const result = spawnSync(process.platform === 'win32' ? tar : 'unzip', process.platform === 'win32' ? ['-xf', 'sdk.zip', 'LICENSE.txt'] : ['sdk.zip', 'LICENSE.txt'], { cwd: scratch, windowsHide: true });
    if (result.status !== 0) throw new Error('LICENSE.txt is not in the WebView2 package');
    return { name: SDK_LICENCE, url: `${url} (LICENSE.txt)`, bytes: readFileSync(path.join(scratch, 'LICENSE.txt')), package: { sha256: sha256(bytes) } };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The crates this folder must hold licences for: linked crates that ship none, and webview2-com-sys's SDK. A crate
 *  under MPL-2.0 alone needs none here: the licence's text is the same for every work under it, and the packager
 *  takes it from an MPL crate that ships it (with where the crate's source is, as MPL asks); selectors' repository
 *  (servo/stylo) has no licence file, its sources carrying MPL's notice. */
export function needed(metadata) {
  return linkedCrates(metadata).filter(crate => crate.name === WEBVIEW2.crate || (!shippedLicences(crate).length && crate.license !== 'MPL-2.0'));
}

/** What a crate's folder here lacks: its licence's own files (where the package ships none), of the licence it names,
 *  and, for webview2-com-sys, the SDK's licence and its provenance of the SDK the crate's version bundles. */
export function crateFolderGaps(crate, folder, provenance = {}) {
  const key = `${crate.name}-${crate.version}`;
  const have = existsSync(folder) ? readdirSync(folder) : [];
  const own = have.filter(name => name !== SDK_LICENCE);
  const gaps = [];
  if (!shippedLicences(crate).length) {
    if (!own.length) gaps.push(`${key}: no licence file`);
    else if (!licenceTextMatches(crate.license, own.map(name => readFileSync(path.join(folder, name), 'utf8')))) gaps.push(`${key}: its files here are not of ${crate.license}`);
  }
  if (crate.name === WEBVIEW2.crate) {
    const sdk = webview2Sdk(crate.version);
    if (!have.includes(SDK_LICENCE)) gaps.push(`${key}: no WebView2 SDK licence`);
    else if (!String(provenance[key]?.files?.[SDK_LICENCE]?.url || '').includes(`/${sdk}/`)) gaps.push(`${key}: its WebView2 SDK licence is not of SDK ${sdk}`);
  }
  return gaps;
}

function main(args) {
  const check = args.includes('--check');
  const metadata = shellMetadata();
  const provenanceFile = path.join(OUTPUT, 'PROVENANCE.json');
  const provenance = existsSync(provenanceFile) ? JSON.parse(readFileSync(provenanceFile, 'utf8')) : {};
  const missing = check ? provenanceDifferences(OUTPUT) : [];
  for (const crate of needed(metadata)) {
    const key = `${crate.name}-${crate.version}`;
    const folder = path.join(OUTPUT, key);
    const gaps = crateFolderGaps(crate, folder, provenance);
    if (!gaps.length) continue;
    if (check) { missing.push(...gaps); continue; }
    const have = existsSync(folder) ? readdirSync(folder) : [];
    const files = shippedLicences(crate).length || have.some(name => name !== SDK_LICENCE) ? [] : fetchCrateLicences(crate);
    if (crate.name === WEBVIEW2.crate && gaps.some(gap => gap.includes('WebView2'))) files.push(fetchWebView2Licence(webview2Sdk(crate.version)));
    if (!files.length) { missing.push(`${key} (${crate.repository || 'no repository'})`); continue; }
    mkdirSync(folder, { recursive: true });
    provenance[key] = { ...(provenance[key] || {}), repository: crate.repository || null, license: crate.license || null, files: { ...(provenance[key]?.files || {}) } };
    for (const file of files) {
      writeFileSync(path.join(folder, file.name), file.bytes);
      provenance[key].files[file.name] = { url: file.url, sha256: sha256(file.bytes), ...(file.package ? { packageSha256: file.package.sha256 } : {}) };
    }
    console.log(`${key}: ${files.map(file => file.name).join(', ')}`);
  }
  if (!check) writeFileSync(provenanceFile, `${JSON.stringify(Object.fromEntries(Object.entries(provenance).sort(([a], [b]) => a.localeCompare(b))), null, 2)}\n`);
  if (missing.length) throw new Error(`No licence here for: ${missing.join(', ')}${check ? ' (node scripts/awwo-crate-licences.mjs fetches them)' : ''}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
