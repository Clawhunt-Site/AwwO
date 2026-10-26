import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readPayload, type PayloadManifest } from './local-payload.ts';
import { readProductionConfiguration } from './production-config.ts';
import { build, version } from './release.ts';

const exec = promisify(execFile);
const source = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(source, '../..');
const local = path.join(root, '.local/macos-production');
const configuration = readProductionConfiguration(process.env);
const brand = path.join(root, 'assets/brand/awwo-fold');
/** The local edition's payload to carry (scripts/awwo-local-package-macos.mjs --out <folder>: <folder>/payload); without
 *  it the app is the hosted service's client alone. AWWO_MAC_TEST_BUILD=1 lets a payload of a checkout with changes in,
 *  for a build to test, not to publish. */
const payloadFolder = process.env.AWWO_MAC_LOCAL_PAYLOAD || '';
const testBuild = process.env.AWWO_MAC_TEST_BUILD === '1';

async function run(command: string, args: string[], timeout = 120_000): Promise<string> {
  const result = await exec(command, args, { cwd: root, timeout, maxBuffer: 2_000_000 });
  return result.stdout.trim();
}

async function hash(file: string): Promise<string> {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

async function main(): Promise<void> {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Apple Silicon macOS is required.');
  const revision = await run('/usr/bin/git', ['rev-parse', 'HEAD']);
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Invalid source revision.');
  const payload: PayloadManifest | null = payloadFolder ? readPayload(payloadFolder, { revision, allowDirty: testBuild }) : null;
  const nativeSHA = await hash(path.join(source, 'AwwOLocal.swift'));
  const output = path.join(local, `${version}-${revision.slice(0, 7)}-${nativeSHA.slice(0, 10)}-${Date.now()}`);
  const app = path.join(output, 'AwwO Local.app');
  const contents = path.join(app, 'Contents');
  const resources = path.join(contents, 'Resources');
  const executable = path.join(contents, 'MacOS/AwwOLocal');
  await mkdir(path.dirname(executable), { recursive: true });
  await mkdir(resources);
  // Use the approved raster directly: the native shell never redraws or
  // approximates the canonical Fold paths, transform or blue palette.
  await copyFile(path.join(brand, 'png/mark-blue-1024.png'), path.join(resources, 'AwwOFoldMark.png'));
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
  await run('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', path.join(resources, 'AwwOFold.icns')]);
  await copyFile(path.join(root, 'LICENSE'), path.join(resources, 'LICENSE'));
  if (payload) {
    // ditto keeps the payload's links (PostgreSQL loads some libraries through them) and its programs' modes. Its
    // programs are signed already (the packager signs those that came unsigned); the app's own signature seals them.
    console.log('Copying the local edition\'s payload...');
    await run('/usr/bin/ditto', [payloadFolder, path.join(resources, 'payload')], 900_000);
  }
  await writeFile(path.join(resources, 'metadata.json'), JSON.stringify({
    version, build, revision, builtAt: new Date().toISOString(), environment: configuration.environment,
    defaultMode: payload ? 'choose' : 'cloud', cloudURL: configuration.cloudURL, architecture: 'arm64', minimumMacOS: '14.0',
    nativeSourceSHA256: nativeSHA, signing: 'ad-hoc-local-only', modelCredentialsIncluded: false,
    localRuntimeIncluded: Boolean(payload), hostedReleaseManagedSeparately: true, testBuild: testBuild && Boolean(payload?.dirty),
    ...(payload ? { payload: { revision: payload.revision, dirty: payload.dirty, packagedAt: payload.packagedAt, files: payload.files, bytes: payload.bytes } } : {}),
    modifiedFiles: (await run('/usr/bin/git', ['status', '--porcelain', '--', 'apps/macos', 'assets/brand/awwo-fold', 'LICENSE'])).split('\n').filter(Boolean),
    iconBrand: 'Fold',
    canonicalMarkSHA256: await hash(path.join(brand, 'png/mark-blue-1024.png')),
    canonicalVectorSHA256: await hash(path.join(brand, 'vector-source.json')),
    iconSHA256: await hash(path.join(resources, 'AwwOFold.icns')),
  }, null, 2) + '\n');
  await run('/usr/bin/codesign', ['--force', '--sign', '-', executable]);
  await run('/usr/bin/codesign', ['--force', '--sign', '-', app], 900_000);
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], 900_000);
  const archive = path.join(output, `AwwO-${version}-${revision.slice(0, 7)}-arm64.zip`);
  await run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, archive], 900_000);
  const result = { app, archive, archiveSHA256: await hash(archive), version, build, revision, nativeSHA, configuration, localRuntimeIncluded: Boolean(payload) };
  await writeFile(path.join(output, 'SHA256SUMS'), `${result.archiveSHA256}  ${path.basename(archive)}\n`);
  await writeFile(path.join(local, 'latest.json.partial'), JSON.stringify(result, null, 2) + '\n');
  await rename(path.join(local, 'latest.json.partial'), path.join(local, 'latest.json'));
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'Build failed.'); process.exitCode = 1; });
