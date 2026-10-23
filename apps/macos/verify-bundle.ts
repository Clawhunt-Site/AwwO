import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readPayload } from './local-payload.ts';
import { readProductionConfiguration } from './production-config.ts';
import { build, version } from './release.ts';

const exec = promisify(execFile);
const app = process.env.AWWO_MAC_APP;
if (!app || !path.isAbsolute(app)) throw new Error('AWWO_MAC_APP must be the absolute installed app path.');
const expected = readProductionConfiguration(process.env);
const contents = path.join(app, 'Contents');
const resources = path.join(contents, 'Resources');
const plistOutput = await exec('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(contents, 'Info.plist')]);
const plist = JSON.parse(plistOutput.stdout) as Record<string, unknown>;
const metadata = JSON.parse(await readFile(path.join(resources, 'metadata.json'), 'utf8')) as Record<string, unknown>;
assert.equal(plist.CFBundleIdentifier, 'store.clawhunt.awwo.local');
assert.equal(plist.CFBundleDisplayName, 'AwwO');
assert.equal(plist.CFBundleShortVersionString, version);
assert.equal(plist.CFBundleVersion, build);
assert.equal(plist.CFBundleIconFile, 'AwwOFold');
assert.equal(plist.AwwOEnvironment, expected.environment);
assert.equal(plist.AwwOCloudURL, expected.cloudURL);
assert.equal(metadata.version, plist.CFBundleShortVersionString);
assert.equal(metadata.build, plist.CFBundleVersion);
assert.equal(metadata.environment, expected.environment);
assert.equal(metadata.cloudURL, expected.cloudURL);
assert.equal(metadata.modelCredentialsIncluded, false);
// A build either carries the local edition's payload (its workspace chooser first) or is the hosted service's client
// alone, with nothing local in it.
const local = metadata.localRuntimeIncluded === true;
assert.equal(metadata.defaultMode, local ? 'choose' : 'cloud');
const entries = ['AwwOFold.icns', 'AwwOFoldMark.png', 'LICENSE', 'metadata.json', ...(local ? ['payload'] : [])];
assert.deepEqual((await readdir(resources)).sort(), entries.sort());
if (local) {
  const payload = readPayload(path.join(resources, 'payload'), { revision: String(metadata.revision), allowDirty: metadata.testBuild === true });
  assert.deepEqual(metadata.payload, { revision: payload.revision, dirty: payload.dirty, packagedAt: payload.packagedAt, files: payload.files, bytes: payload.bytes });
}
const source = path.dirname(fileURLToPath(import.meta.url));
const brand = path.resolve(source, '../../assets/brand/awwo-fold');
async function hash(file: string): Promise<string> {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}
assert.equal(metadata.nativeSourceSHA256, await hash(path.join(source, 'AwwOLocal.swift')));
assert.equal(metadata.iconBrand, 'Fold');
assert.equal(metadata.canonicalVectorSHA256, await hash(path.join(brand, 'vector-source.json')));
assert.equal(metadata.canonicalMarkSHA256, await hash(path.join(brand, 'png/mark-blue-1024.png')));
assert.equal(metadata.canonicalMarkSHA256, await hash(path.join(resources, 'AwwOFoldMark.png')));
assert.equal(metadata.iconSHA256, await hash(path.join(resources, 'AwwOFold.icns')));
assert.equal(await hash(path.join(resources, 'LICENSE')), await hash(path.resolve(source, '../../LICENSE')));
await exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { timeout: 900_000, maxBuffer: 2_000_000 });
console.log(JSON.stringify({ app, version: metadata.version, build: metadata.build, environment: metadata.environment,
  cloudURL: metadata.cloudURL, nativeSourceMatches: true, iconBrand: metadata.iconBrand, iconHashesVerified: true,
  signatureVerified: true, localRuntimeIncluded: local, ...(local ? { payloadRevision: (metadata.payload as Record<string, unknown>).revision } : {}) }, null, 2));
