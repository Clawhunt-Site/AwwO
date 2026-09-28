import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readProductionConfiguration } from './production-config.ts';

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
assert.equal(plist.CFBundleShortVersionString, '0.8.1');
assert.equal(plist.CFBundleVersion, '6');
assert.equal(plist.CFBundleIconFile, 'AwwOFold');
assert.equal(plist.AwwOEnvironment, expected.environment);
assert.equal(plist.AwwOCloudURL, expected.cloudURL);
assert.equal(metadata.version, plist.CFBundleShortVersionString);
assert.equal(metadata.build, plist.CFBundleVersion);
assert.equal(metadata.environment, expected.environment);
assert.equal(metadata.cloudURL, expected.cloudURL);
assert.equal(metadata.defaultMode, 'cloud');
assert.equal(metadata.modelCredentialsIncluded, false);
assert.equal(metadata.localRuntimeIncluded, false);
assert.deepEqual((await readdir(resources)).sort(), ['AwwOFold.icns', 'AwwOFoldMark.png', 'LICENSE', 'metadata.json']);
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
await exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
console.log(JSON.stringify({ app, version: metadata.version, build: metadata.build, environment: metadata.environment,
  cloudURL: metadata.cloudURL, nativeSourceMatches: true, iconBrand: metadata.iconBrand, iconHashesVerified: true,
  signatureVerified: true, localServicesAbsent: true }, null, 2));
