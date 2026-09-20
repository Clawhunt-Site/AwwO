import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readProductionConfiguration } from './production-config.ts';

const exec = promisify(execFile);
const source = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(source, '../..');
const local = path.join(root, '.local/macos-production');
const configuration = readProductionConfiguration(process.env);
const version = '0.6.0';
const build = '5';

async function run(command: string, args: string[]): Promise<string> {
  const result = await exec(command, args, { cwd: root, timeout: 120_000, maxBuffer: 2_000_000 });
  return result.stdout.trim();
}

async function hash(file: string): Promise<string> {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

async function main(): Promise<void> {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Apple Silicon macOS is required.');
  const revision = await run('/usr/bin/git', ['rev-parse', 'HEAD']);
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Invalid source revision.');
  const nativeSHA = await hash(path.join(source, 'AwwOLocal.swift'));
  const output = path.join(local, `${version}-${revision.slice(0, 7)}-${nativeSHA.slice(0, 10)}-${Date.now()}`);
  const app = path.join(output, 'AwwO Local.app');
  const contents = path.join(app, 'Contents');
  const resources = path.join(contents, 'Resources');
  const executable = path.join(contents, 'MacOS/AwwOLocal');
  await mkdir(path.dirname(executable), { recursive: true });
  await mkdir(resources);
  await copyFile(path.join(source, 'Info.plist'), path.join(contents, 'Info.plist'));
  const plist = path.join(contents, 'Info.plist');
  await run('/usr/bin/plutil', ['-replace', 'AwwOCloudURL', '-string', configuration.cloudURL, plist]);
  await run('/usr/bin/plutil', ['-replace', 'CFBundleShortVersionString', '-string', version, plist]);
  await run('/usr/bin/plutil', ['-replace', 'CFBundleVersion', '-string', build, plist]);
  await run('/usr/bin/plutil', ['-lint', plist]);
  console.log('Compiling production desktop shell...');
  await run('/usr/bin/xcrun', ['swiftc', '-O', '-target', 'arm64-apple-macos14.0', '-framework', 'AppKit', '-framework', 'WebKit', path.join(source, 'AwwOLocal.swift'), '-o', executable]);
  for (const check of ['policy', 'navigation', 'shutdown', 'window']) console.log(await run(executable, [`--self-test-${check}`]));
  const iconset = path.join(output, 'AwwO.iconset');
  const icon = path.join(output, 'AwwO.png');
  await mkdir(iconset);
  await run(executable, ['--write-icon', icon]);
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      await run('/usr/bin/sips', ['-z', String(size * scale), String(size * scale), icon, '--out', path.join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`)]);
    }
  }
  await run('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', path.join(resources, 'AwwOBlue.icns')]);
  await copyFile(path.join(root, 'LICENSE'), path.join(resources, 'LICENSE'));
  await writeFile(path.join(resources, 'metadata.json'), JSON.stringify({
    version, build, revision, builtAt: new Date().toISOString(), environment: configuration.environment,
    defaultMode: 'cloud', cloudURL: configuration.cloudURL, architecture: 'arm64', minimumMacOS: '14.0',
    nativeSourceSHA256: nativeSHA, signing: 'ad-hoc-local-only', modelCredentialsIncluded: false,
    localRuntimeIncluded: false, hostedReleaseManagedSeparately: true,
    modifiedFiles: (await run('/usr/bin/git', ['status', '--porcelain', '--', 'apps/macos'])).split('\n').filter(Boolean),
    iconSHA256: await hash(path.join(resources, 'AwwOBlue.icns')),
  }, null, 2) + '\n');
  await run('/usr/bin/codesign', ['--force', '--sign', '-', executable]);
  await run('/usr/bin/codesign', ['--force', '--sign', '-', app]);
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
  const archive = path.join(output, `AwwO-${version}-${revision.slice(0, 7)}-arm64.zip`);
  await run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, archive]);
  const result = { app, archive, archiveSHA256: await hash(archive), version, build, revision, nativeSHA, configuration };
  await writeFile(path.join(output, 'SHA256SUMS'), `${result.archiveSHA256}  ${path.basename(archive)}\n`);
  await writeFile(path.join(local, 'latest.json.partial'), JSON.stringify(result, null, 2) + '\n');
  await rename(path.join(local, 'latest.json.partial'), path.join(local, 'latest.json'));
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'Build failed.'); process.exitCode = 1; });
