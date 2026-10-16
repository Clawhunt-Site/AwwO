import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, constants, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { UPSTREAM_REVISION, PATCH_VERSION } from '../apps/openmaus-worker/setup.ts';
import { OUTPUT as goLicences, assertNoLinks, bundleDifferences, bundleToolchain, checkLinkedModules, collectGoLicences, noticeFile } from './awwo-go-licences.ts';

// This builder never copies the calling checkout's dependencies or private state.
// All input source comes from git archive; dependencies are installed into that
// isolated Linux tree from its committed lockfiles before assembling the release.
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// THIRD_PARTY_NOTICES.md, AwwO's LICENSE, every license and notice file the notices name, and the licenses of the Go
// code compiled into the API. This archive (under licenses/) and the API image (deploy/saas/api.Dockerfile) carry
// them at these repository paths, also those of parts neither contains, so that every reference in the notices resolves.
// The preview fonts' licenses are one for each family: apps/web/src/canvas/fonts/<family>.LICENSE.txt.
const previewFontLicences = ['bebas-neue', 'cinzel', 'exo-2', 'instrument-serif', 'inter', 'jetbrains-mono', 'manrope', 'montserrat', 'orbitron', 'outfit',
  'oxanium', 'pixelify-sans', 'playfair-display', 'press-start-2p', 'rajdhani', 'space-grotesk', 'unbounded'].map(family => `apps/web/src/canvas/fonts/${family}.LICENSE.txt`);
export const noticePaths = ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'apps/web/licences', ...previewFontLicences, 'apps/web/src/saas/bundleLicences.txt', 'apps/web/src/saas/design/fonts/LICENSE-mona-sans.txt', 'apps/web/src/saas/skillLicences.txt',
  'examples/knowledge-workbench/data/unicode/LICENSE.txt', 'examples/knowledge-workbench/data/unicode/17.0.0/LICENSE.txt', 'server/LICENSE',
  'server/packages/adapters/hermes/LICENSE', 'third_party/adapted',
  'third_party/anatomy/LICENSE', 'third_party/clawwork/LICENSE', 'third_party/clawwork/NOTICE', goLicences, 'third_party/open-design/LICENSE',
  'third_party/openpencil/LICENSE', 'third_party/openpencil/packages/agent-native/LICENSE', 'third_party/osiris/LICENSE', 'third_party/wshobson-agents/LICENSE'];
const sourcePaths = ['backend', 'apps/web', 'apps/pi-worker', 'apps/openai-agents-worker', 'apps/openmaus-worker', 'apps/user-models.ts', 'apps/computer-model.ts', 'apps/bedrock-bridge.ts', 'apps/bedrock-catalog.ts', 'apps/bedrock-models.json', 'third_party/openmaus-core', 'deploy/saas/workspace', ...noticePaths];
type DockerImage = { Id: string; Os: string; Architecture: string };
type BuildOptions = { output: string; dockerContext: string; publicClawHuntURL: string };

export function buildEnvironment(scratch: string): NodeJS.ProcessEnv {
  const home = join(scratch, 'build-home'); mkdirSync(home, { recursive: true });
  // npm refuses loading the same file for two configuration scopes, even /dev/null.
  const userConfig = join(home, 'user.npmrc'), globalConfig = join(home, 'global.npmrc');
  for (const file of [userConfig, globalConfig]) writeFileSync(file, '', { flag: 'wx', mode: 0o600 });
  return { PATH: dirname(process.execPath) + ':' + (process.env.PATH || ''), HOME: home, TMPDIR: scratch, LANG: 'C.UTF-8', CI: '1',
    npm_config_userconfig: userConfig, npm_config_globalconfig: globalConfig, npm_config_cache: join(home, '.npm'), GOFLAGS: '-modcacherw' };
}

export function removeBuildTree(directory: string): void {
  // Go's module cache can contain 0555 directories. Only make directories within
  // our own mkdtemp tree writable; never follow a dependency symlink outside it.
  const writable = (path: string): void => {
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink()) return;
    chmodSync(path, info.mode | 0o700);
    for (const name of readdirSync(path)) writable(join(path, name));
  };
  if (!existsSync(directory)) return;
  if (lstatSync(directory).isSymbolicLink()) throw new Error('Refusing to clean a symlink as a build root.');
  writable(directory);
  rmSync(directory, { recursive: true, force: true });
}

export function withBuildCleanup<T>(directory: string, build: () => T, cleanup = removeBuildTree, report: (message: string) => void = console.error): T {
  let failed = false;
  try { return build(); }
  catch (error) { failed = true; throw error; }
  finally {
    try { cleanup(directory); }
    catch (error) {
      if (!failed) throw error;
      report(`Build cleanup failed; the original build error is preserved. Remove this private temporary directory after inspection: ${directory}`);
    }
  }
}

function fileHash(file: string): string {
  const hash = createHash('sha256'), fd = openSync(file, 'r'), buffer = Buffer.alloc(1024 * 1024);
  try { for (;;) { const size = readSync(fd, buffer, 0, buffer.length, null); if (!size) break; hash.update(buffer.subarray(0, size)); } }
  finally { closeSync(fd); }
  return hash.digest('hex');
}

export function validateTarget(platform: string, architecture: string, nodeMajor: number): void {
  if (platform !== 'linux' || architecture !== 'x64' || nodeMajor < 24) throw new Error('Build the native release on Linux amd64 with Node 24 or newer; host dependencies must never be cross-copied.');
}
export function runtimeSource(name: string): boolean {
  return !name.startsWith('.') && !name.includes('.test.') && !name.includes('fixture') && !name.startsWith('test-')
    && (name === 'package.json' || name === 'package-lock.json' || /\.(?:mjs|ts)$/.test(name));
}
export function parseImage(raw: string): DockerImage {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== 'object' || value === null || !('Id' in value) || !('Os' in value) || !('Architecture' in value)
    || typeof value.Id !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.Id) || value.Os !== 'linux' || value.Architecture !== 'amd64') throw new Error('The workspace image must be an inspected Linux amd64 image with an immutable image ID.');
  return { Id: value.Id, Os: value.Os, Architecture: value.Architecture };
}
export function verifyCore(root: string): void {
  const value: unknown = JSON.parse(readFileSync(join(root, 'awwo-build.json'), 'utf8'));
  if (typeof value !== 'object' || value === null || !('upstreamRevision' in value) || !('patchVersion' in value)
    || value.upstreamRevision !== UPSTREAM_REVISION || value.patchVersion !== PATCH_VERSION) throw new Error('OpenMaus build identity is not the pinned and patched core.');
  for (const file of ['index.js', 'LICENSE', 'NOTICE']) if (!statSync(join(root, file)).isFile()) throw new Error(`Missing core file: ${file}`);
  if (!statSync(join(root, 'third_party')).isDirectory() || existsSync(join(root, 'enterprise'))) throw new Error('Core licensing boundary is invalid.');
}
export function checksumLines(root: string): string[] {
  const absoluteRoot = realpathSync(root), lines: string[] = [];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const file = join(directory, name), path = relative(absoluteRoot, file).split(sep).join('/');
      if (/[\x00-\x1f\\]/.test(path)) throw new Error('Unsupported release filename');
      const info = lstatSync(file);
      if (info.isDirectory()) { visit(file); continue; }
      if (info.isSymbolicLink()) {
        const target = readlinkSync(file), resolved = realpathSync(file);
        if (isAbsolute(target) || !resolved.startsWith(absoluteRoot + sep) || !statSync(file).isFile()) throw new Error(`Unsafe release symlink: ${path}`);
      } else if (!info.isFile()) throw new Error(`Unsupported release entry: ${path}`);
      // Hashing the symlink's internal file also makes sha256sum -c usable on the host.
      lines.push(`${fileHash(file)}  ${path}`);
    }
  };
  visit(absoluteRoot);
  return lines;
}
const parentOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf('/')));
const licenceName = (path: string): boolean => noticeFile(basename(path)) || /licen[cs]e[^/]*\.(?:txt|md)$/i.test(basename(path));
type Name = { name: string; directory: boolean; cell: boolean };
/** What THIRD_PARTY_NOTICES.md names, in document order: its backticked spans, and the plain paths in its tables' cells. */
function namesInOrder(markdown: string): Name[][] {
  // A bare name means a file beside a path named before it in the same paragraph, list item, heading or table row.
  const contexts: Name[][] = [];
  let names: Name[] = [];
  const close = (): void => {
    if (names.length) contexts.push(names);
    names = [];
  };
  // "./a/LICENSE" is a/LICENSE.
  const name = (text: string, cell: boolean): void => {
    const path = posix.normalize(text);
    names.push({ name: path.replace(/\/+$/, ''), directory: path.endsWith('/'), cell });
  };
  // A link's target names a path of the repository unless it is on the web or in the page; "/a" is from its top, and
  // its ?query and #part are no part of the path.
  const link = (target: string): void => {
    if (/^(?:[a-z][\w+.-]*:|#)/i.test(target)) return;
    const raw = target.replace(/[?#].*$/, '').replace(/^\/+/, '');
    let path = raw;
    try {
      path = decodeURI(raw);
    } catch {
      // A % that starts no escape is the character itself.
    }
    if (path) name(path, false);
  };
  for (const line of markdown.split('\n')) {
    const row = line.trimStart().startsWith('|'), own = row || line.trimStart().startsWith('#');
    if (own || !line.trim() || /^\s*(?:[-*+]|\d+[.)])\s/.test(line)) close();
    // A reference definition, "[1]: a/LICENSE", is a link of its own.
    const definition = /^\s{0,3}\[[^\]\n]+\]:\s*(?:<([^>\n]+)>|(\S+))/.exec(line);
    if (definition) {
      close();
      link(definition[1] ?? definition[2] ?? '');
      close();
      continue;
    }
    const cells = row ? line.split('|') : [line];
    // A cell can list paths, plain or backticked ("a/LICENSE, `a/NOTICE`"); a word without a slash, such as a heading, is no path.
    const plain = (text: string): void => {
      if (cells.length > 1) for (const word of text.split(/[\s,;]+/)) if (word.includes('/')) name(word, true);
    };
    for (const cell of cells) {
      let end = 0;
      // Backticked spans and the targets of links (a <target>, and a title after it, allowed).
      for (const match of cell.matchAll(/`([^`\n]+)`|\]\(\s*(?:<([^>\n]+)>|([^)\s]+))(?:\s+(?:"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|\((?:[^)\\\n]|\\.)*\)))?\s*\)/g)) {
        plain(cell.slice(end, match.index));
        const target = match[2] ?? match[3];
        if (target === undefined) name((match[1] ?? '').trim(), false);
        else link(target);
        end = (match.index ?? 0) + match[0].length;
      }
      plain(cell.slice(end));
    }
    if (own) close();
  }
  close();
  return contexts;
}
/**
 * The license and notice files THIRD_PARTY_NOTICES.md names, given every file of the commit: each license file named
 * in backticks or a table cell, with the license and notice files beside it, and those directly inside each named
 * directory. A bare file name such as `NOTICE` means the file of that name beside the path named before it in its
 * paragraph, list item, heading or table row, where that directory has license or notice files, else the
 * repository's own; a bare directory such as `licenses/` is no file. A link's target is a name too. missing: what it
 * names that the commit does not have, among paths whose top directory the commit has (a module path or URL is none
 * of the repository's): a license file, a directory written with its slash, or a path in a table.
 */
export function requiredNotices(markdown: string, tracked: readonly string[]): { required: string[]; missing: string[] } {
  const files = new Set(tracked), directories = new Set<string>(), required = new Set<string>(), missing = new Set<string>();
  for (const file of tracked) for (let end = file.indexOf('/'); end > 0; end = file.indexOf('/', end + 1)) directories.add(file.slice(0, end));
  const tops = new Set(tracked.map(file => file.split('/')[0] ?? ''));
  const inside = (directory: string): string[] => tracked.filter(file => parentOf(file) === directory && noticeFile(basename(file)));
  const take = (path: string): void => { for (const file of [path, ...inside(parentOf(path))]) required.add(file); };
  for (const names of namesInOrder(markdown)) {
    let near = '';
    for (const { name, directory, cell } of names) {
      if (!name.includes('/') && !directory && licenceName(name)) {
        const beside = near ? `${near}/${name}` : name;
        if (files.has(beside)) take(beside);
        else if (near && inside(near).length) missing.add(beside);
        else if (files.has(name)) take(name);
        else missing.add(beside);
      } else if (files.has(name)) {
        if (licenceName(name)) take(name);
        near = parentOf(name);
      } else if (directories.has(name)) {
        for (const file of inside(name)) required.add(file);
        near = name;
      } else if (tops.has(name.split('/')[0] ?? '') && !/\s/.test(name) && (licenceName(name) || directory || cell)) missing.add(name);
    }
  }
  return { required: [...required].sort(), missing: [...missing].sort() };
}
/** What the release refuses to build with: named license files the notice paths do not carry, or the commit lacks. */
export function uncoveredNotices(markdown: string, tracked: readonly string[], carried: readonly string[] = noticePaths): string[] {
  const { required, missing } = requiredNotices(markdown, tracked);
  return [...required.filter(path => !carried.some(entry => path === entry || path.startsWith(`${entry}/`))), ...missing.map(path => `${path} (missing)`)];
}
/** Copies the notice paths from a source tree to the same relative paths under target. */
export function copyNotices(source: string, target: string): void {
  for (const path of noticePaths) {
    // Its directories must be the source tree's own; the entry itself is checked below.
    assertNoLinks(source, dirname(join(source, path)));
    const from = join(source, path), info = lstatSync(from);
    if (!info.isFile() && !info.isDirectory()) throw new Error(`Unsupported notice entry: ${path}`);
    mkdirSync(dirname(join(target, path)), { recursive: true });
    cpSync(from, join(target, path), { recursive: true, errorOnExist: true, force: false });
  }
}
export function parseOptions(args: string[]): BuildOptions {
  const options = { output: resolve(repository, '.local/saas-release'), dockerContext: 'default', publicClawHuntURL: process.env.VITE_CLAWHUNT_SITE_URL || '' };
  if (options.publicClawHuntURL) {
    const url = new URL(options.publicClawHuntURL);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('VITE_CLAWHUNT_SITE_URL must be a public HTTPS URL without credentials, query or fragment.');
    options.publicClawHuntURL = url.href;
  }
  for (let i = 0; i < args.length; i += 2) {
    const value = args[i + 1];
    if (!value || !['--output', '--docker-context'].includes(args[i]!)) throw new Error('Usage: node scripts/awwo-saas-release.ts [--output PATH] [--docker-context NAME]');
    if (args[i] === '--output') options.output = resolve(value);
    else { if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value)) throw new Error('Invalid Docker context'); options.dockerContext = value; }
  }
  return options;
}
export function buildRelease(options: BuildOptions): string {
  validateTarget(process.platform, process.arch, Number(process.versions.node.split('.')[0]));
  const git = (args: string[]): string => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
  if (git(['status', '--porcelain', '--untracked-files=no'])) throw new Error('Commit tracked changes before creating a release.');
  const revision = git(['rev-parse', 'HEAD']);
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Invalid source revision');
  const epoch = git(['show', '-s', '--format=%ct', revision]);
  if (!/^\d+$/.test(epoch)) throw new Error('Invalid source timestamp');
  const tracked = execFileSync('git', ['ls-tree', '-r', '-z', '--name-only', revision], { cwd: repository, encoding: 'utf8', maxBuffer: 256 << 20 }).split('\0').filter(Boolean);
  const uncovered = uncoveredNotices(git(['show', `${revision}:THIRD_PARTY_NOTICES.md`]), tracked);
  if (uncovered.length) throw new Error(`THIRD_PARTY_NOTICES.md names license files the release would not carry: ${uncovered.join(', ')}. Add each to noticePaths in scripts/awwo-saas-release.ts and to deploy/saas/api.Dockerfile, or restore a missing one.`);
  const scratch = mkdtempSync(join(tmpdir(), 'awwo-saas-release-'));
  const source = join(scratch, 'source'), release = join(scratch, 'release'), home = join(scratch, 'build-home');
  const archiveName = `awwo-saas-${revision}-linux-amd64.tar.gz`, archive = join(options.output, archiveName);
  if (existsSync(archive) || existsSync(archive + '.sha256')) { rmSync(scratch, { recursive: true }); throw new Error('Release output exists; choose a new output directory.'); }
  return withBuildCleanup(scratch, () => {
  const env = buildEnvironment(scratch);
  const run = (command: string, args: string[], cwd = source, extra: NodeJS.ProcessEnv = {}): void => {
    execFileSync(command, args, { cwd, env: { ...env, ...extra }, stdio: 'inherit', timeout: 1_800_000 });
  };
  const docker = (args: string[], capture = false): string => execFileSync('docker', ['--context', options.dockerContext, ...args],
    { cwd: source, env: { PATH: process.env.PATH, HOME: process.env.HOME }, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', timeout: 1_800_000 })?.trim() || '';
    for (const directory of [source, release, home]) mkdirSync(directory, { recursive: true });
    git(['archive', '--format=tar', `--output=${join(scratch, 'source.tar')}`, revision, '--', ...sourcePaths]);
    run('tar', ['-xf', join(scratch, 'source.tar'), '-C', source]);
    // Built, as the API image is, by the toolchain the Go licenses were read from; go fetches it when the host has another.
    const go = { ...env, GOTOOLCHAIN: bundleToolchain(join(source, goLicences, 'modules.txt')) };
    run('go', ['build', '-trimpath', '-ldflags', `-s -w -X awwo/backend/internal/app.buildRevision=${revision}`, '-o', join(release, 'awwo-api'), './cmd/api'], join(source, 'backend'), { ...go, CGO_ENABLED: '0', GOOS: 'linux', GOARCH: 'amd64' });
    // The archive carries the Go licenses, so they must be this build's: the files in its module cache, for exactly the modules the binary links.
    const stale = bundleDifferences(join(source, goLicences), collectGoLicences(join(source, 'backend'), go), source);
    if (stale.length) throw new Error(`${goLicences} does not match this build (${stale.slice(0, 5).join(', ')}); run node scripts/awwo-go-licences.ts and commit the result.`);
    checkLinkedModules(join(release, 'awwo-api'), join(source, goLicences, 'modules.txt'), go);
    run('npm', ['ci', '--prefix', 'apps/web']);
    run('npm', ['run', 'build:saas', '--prefix', 'apps/web'], source, { VITE_CLAWHUNT_SITE_URL: options.publicClawHuntURL });
    if (!statSync(join(source, 'apps/web/dist-saas/saas.html')).isFile()) throw new Error('Missing saas.html');
    cpSync(join(source, 'apps/web/dist-saas'), join(release, 'html'), { recursive: true });
    for (const worker of ['pi-worker', 'openai-agents-worker', 'openmaus-worker']) {
      const target = join(release, 'apps', worker); mkdirSync(target, { recursive: true });
      for (const name of readdirSync(join(source, 'apps', worker)).filter(runtimeSource)) {
        const file = join(source, 'apps', worker, name);
        if (!lstatSync(file).isFile()) throw new Error(`Unexpected worker source entry: ${name}`);
        cpSync(file, join(target, name));
      }
      if (worker !== 'openmaus-worker') run('npm', ['ci', '--omit=dev', '--ignore-scripts'], target);
    }
    for (const file of ['user-models.ts', 'computer-model.ts', 'bedrock-bridge.ts', 'bedrock-catalog.ts', 'bedrock-models.json']) cpSync(join(source, 'apps', file), join(release, 'apps', file));
    run(process.execPath, ['apps/openmaus-worker/setup.ts']);
    const core = join(source, 'apps/openmaus-worker/.runtime/core/dist-server'); verifyCore(core);
    cpSync(core, join(release, 'apps/openmaus-worker/.runtime/core/dist-server'), { recursive: true });
    // Import every runtime entry module from the assembled package, not the build tree.
    run(process.execPath, ['--input-type=module', '-e', "await import('./apps/pi-worker/server.mjs'); await import('./apps/openai-agents-worker/server.mjs'); await import('./apps/openmaus-worker/server.ts'); console.log('Native release runtime imports passed');"], release);
    const imageReference = `awwo-workspace:${revision}`;
    docker(['build', '--platform', 'linux/amd64', '-f', 'deploy/saas/workspace/Dockerfile', '-t', imageReference, 'deploy/saas/workspace']);
    const image = parseImage(docker(['image', 'inspect', '--format', '{{json .}}', imageReference], true));
    mkdirSync(join(release, 'images'));
    docker(['image', 'save', '--output', join(release, 'images/workspace.tar'), imageReference]);
    cpSync(join(source, 'LICENSE'), join(release, 'LICENSE'));
    copyNotices(source, join(release, 'licenses'));
    writeFileSync(join(release, 'SOURCE_SHA'), revision + '\n');
    writeFileSync(join(release, 'WORKSPACE_IMAGE_ID'), image.Id + '\n');
    writeFileSync(join(release, 'release.json'), JSON.stringify({ schemaVersion: 1, revision, platform: 'linux', architecture: 'amd64', nodeVersion: process.version,
      sourceDateEpoch: Number(epoch), publicClawHuntURL: options.publicClawHuntURL,
      openMaus: { upstreamRevision: UPSTREAM_REVISION, patchVersion: PATCH_VERSION }, workspaceImage: { reference: imageReference, id: image.Id, archive: 'images/workspace.tar' } }, null, 2) + '\n');
    writeFileSync(join(release, 'SHA256SUMS'), checksumLines(release).join('\n') + '\n');
    run('sha256sum', ['--quiet', '-c', 'SHA256SUMS'], release);
    run('tar', ['--sort=name', `--mtime=@${epoch}`, '--owner=0', '--group=0', '--numeric-owner', '-czf', join(scratch, archiveName), '-C', release, '.']);
    mkdirSync(options.output, { recursive: true });
    // COPYFILE_EXCL prevents a concurrent build from overwriting a published package.
    copyFileSync(join(scratch, archiveName), archive, constants.COPYFILE_EXCL);
    writeFileSync(archive + '.sha256', `${fileHash(archive)}  ${basename(archive)}\n`, { flag: 'wx' });
    cpSync(join(release, 'release.json'), join(options.output, `release-${revision}.json`), { errorOnExist: true, force: false });
    console.log(`Native release prepared: ${archive}`);
    return archive;
  });
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) buildRelease(parseOptions(process.argv.slice(2)));
