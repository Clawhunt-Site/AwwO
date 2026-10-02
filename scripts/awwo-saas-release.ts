import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { UPSTREAM_REVISION, PATCH_VERSION } from '../apps/openmaus-worker/setup.ts';

// This builder never copies the calling checkout's dependencies or private state.
// All input source comes from git archive; dependencies are installed into that
// isolated Linux tree from its committed lockfiles before assembling the release.
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePaths = ['LICENSE', 'backend', 'apps/web', 'apps/pi-worker', 'apps/openai-agents-worker', 'apps/openmaus-worker', 'apps/user-models.ts', 'apps/computer-model.ts', 'third_party/openmaus-core', 'deploy/saas/workspace'];
type DockerImage = { Id: string; Os: string; Architecture: string };
type BuildOptions = { output: string; dockerContext: string; publicClawHuntURL: string };

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
  const scratch = mkdtempSync(join(tmpdir(), 'awwo-saas-release-'));
  const source = join(scratch, 'source'), release = join(scratch, 'release'), home = join(scratch, 'build-home');
  const archiveName = `awwo-saas-${revision}-linux-amd64.tar.gz`, archive = join(options.output, archiveName);
  if (existsSync(archive) || existsSync(archive + '.sha256')) { rmSync(scratch, { recursive: true }); throw new Error('Release output exists; choose a new output directory.'); }
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, TMPDIR: scratch, LANG: 'C.UTF-8', CI: '1',
    npm_config_userconfig: '/dev/null', npm_config_globalconfig: '/dev/null', npm_config_cache: join(home, '.npm') };
  const run = (command: string, args: string[], cwd = source, extra: NodeJS.ProcessEnv = {}): void => {
    execFileSync(command, args, { cwd, env: { ...env, ...extra }, stdio: 'inherit', timeout: 1_800_000 });
  };
  const docker = (args: string[], capture = false): string => execFileSync('docker', ['--context', options.dockerContext, ...args],
    { cwd: source, env: { PATH: process.env.PATH, HOME: process.env.HOME }, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', timeout: 1_800_000 })?.trim() || '';
  try {
    for (const directory of [source, release, home]) mkdirSync(directory, { recursive: true });
    git(['archive', '--format=tar', `--output=${join(scratch, 'source.tar')}`, revision, '--', ...sourcePaths]);
    run('tar', ['-xf', join(scratch, 'source.tar'), '-C', source]);
    run('go', ['build', '-trimpath', '-ldflags', `-s -w -X awwo/backend/internal/app.buildRevision=${revision}`, '-o', join(release, 'awwo-api'), './cmd/api'], join(source, 'backend'), { CGO_ENABLED: '0', GOOS: 'linux', GOARCH: 'amd64' });
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
    for (const file of ['user-models.ts', 'computer-model.ts']) cpSync(join(source, 'apps', file), join(release, 'apps', file));
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
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) buildRelease(parseOptions(process.argv.slice(2)));
