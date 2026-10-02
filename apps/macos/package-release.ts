import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, cp, mkdir, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readProductionConfiguration } from './production-config.ts';

const exec = promisify(execFile);
const source = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(source, '../..');
const version = '0.9.1';
const build = '8';
const appName = 'AwwO Local.app';

async function run(command: string, args: string[], env = process.env): Promise<string> {
  const result = await exec(command, args, { cwd: root, env, timeout: 120_000, maxBuffer: 2_000_000 });
  return result.stdout.trim();
}

async function hash(file: string): Promise<string> {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

async function json(file: string): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(await readFile(file, 'utf8'));
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `Invalid object: ${file}`);
  return value as Record<string, unknown>;
}

async function verify(app: string): Promise<void> {
  console.log(await run(process.execPath, [path.join(source, 'verify-bundle.ts')], { ...process.env, AWWO_MAC_APP: app }));
}

async function main(): Promise<void> {
  assert.equal(process.platform, 'darwin', 'Release packaging requires macOS.');
  const configuration = readProductionConfiguration(process.env);
  const latest = await json(path.join(root, '.local/macos-production/latest.json'));
  const revision = await run('/usr/bin/git', ['rev-parse', 'HEAD']);
  assert.match(revision, /^[a-f0-9]{40}$/);
  assert.equal(latest.revision, revision, 'Rebuild from the current HEAD before packaging.');
  assert.equal(latest.version, version);
  assert.equal(latest.build, build);
  assert.equal(typeof latest.app, 'string', 'latest.json must identify the built app.');
  const app = await realpath(latest.app as string);
  const buildRoot = await realpath(path.join(root, '.local/macos-production'));
  const relativeApp = path.relative(buildRoot, app);
  assert.ok(relativeApp && !relativeApp.startsWith('..') && !path.isAbsolute(relativeApp), 'App must belong to this worktree build directory.');
  assert.equal(path.basename(app), appName);
  const metadata = await json(path.join(app, 'Contents/Resources/metadata.json'));
  assert.equal(metadata.revision, revision, 'App metadata must match the current HEAD.');
  assert.deepEqual(metadata.modifiedFiles, [], 'Release packaging refuses a build with modified source inputs. Commit and rebuild first.');
  assert.equal(metadata.cloudURL, configuration.cloudURL);
  assert.equal(metadata.signing, 'ad-hoc-local-only');
  assert.equal(metadata.architecture, 'arm64');
  const dirtyInputs = await run('/usr/bin/git', ['status', '--porcelain', '--', 'apps/macos', 'assets/brand/awwo-fold', 'LICENSE']);
  assert.equal(dirtyInputs, '', 'Release source inputs must be committed and clean.');
  await verify(app);

  const output = path.join(root, '.local/releases', `macos-${version}-build${build}-${revision.slice(0, 7)}`);
  await mkdir(path.dirname(output), { recursive: true });
  // Deliberately omit recursive/overwrite: a release attempt never replaces an existing directory.
  await mkdir(output);
  const work = path.join(output, '.packaging');
  await mkdir(work);
  const volume = path.join(work, 'volume');
  const mount = path.join(work, 'mount');
  const stem = `AwwO-macOS-${version}-build${build}-arm64`;
  const dmg = path.join(output, `${stem}.dmg`);
  const archive = path.join(output, `${stem}.zip`);
  const brandArchive = path.join(output, `AwwO-Fold-brand-kit-${version}.zip`);
  const install = path.join(output, 'INSTALL.txt');
  let mountAttempted = false;
  let packagingError: unknown;
  try {
    const instructions = `AwwO for Mac ${version} (build ${build})\n\n` +
      `适用：Apple Silicon，macOS 14 或更高版本；需要联网。\n` +
      `安装：退出旧应用并保留备份，将 ${appName} 拖入 Applications（或原安装目录）。\n` +
      `默认连接：${configuration.cloudURL}\n` +
      `沿用线上账号、工作区与历史记录，不内置数据库、执行引擎或 API Key。\n` +
      `保留 bundle ID 与既有 WebKit 数据；请勿删除用户数据来更新图标。\n\n` +
      `签名：ad-hoc；未经过 Apple Developer ID 签名或公证。\n` +
      `macOS 首次打开可能阻止启动，请按设备安全策略处理。安装包不修改系统安全设置。\n\n` +
      `源码提交：${revision}\n` +
      `客户端与服务器独立发布；本安装包不会部署或迁移线上服务器。\n`;
    await writeFile(install, instructions);
    await mkdir(volume);
    await run('/usr/bin/ditto', [app, path.join(volume, appName)]);
    await symlink('/Applications', path.join(volume, 'Applications'));
    await copyFile(install, path.join(volume, '安装说明.txt'));
    await run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, archive]);
    await run('/usr/bin/hdiutil', ['create', '-volname', 'AwwO', '-srcfolder', volume, '-format', 'UDZO', '-fs', 'HFS+', dmg]);
    await run('/usr/bin/hdiutil', ['verify', dmg]);
    await mkdir(mount);
    mountAttempted = true;
    await run('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, dmg]);
    assert.equal(await readlink(path.join(mount, 'Applications')), '/Applications');
    await verify(path.join(mount, appName));

    const brandStage = path.join(work, 'AwwO-Fold-brand-kit');
    const brand = path.join(root, 'assets/brand/awwo-fold');
    await mkdir(brandStage);
    for (const item of ['svg', 'png', 'vector-source.json', 'README.md', 'brand-hero.png']) {
      await cp(path.join(brand, item), path.join(brandStage, item), { recursive: true, errorOnExist: true, force: false });
    }
    const brandReadme = await readFile(path.join(brandStage, 'README.md'), 'utf8');
    await writeFile(path.join(brandStage, 'README.md'), brandReadme.replaceAll('(../../../LICENSE)', '(LICENSE)'));
    const license = await readFile(path.join(root, 'LICENSE'), 'utf8');
    assert.ok(license.startsWith('MIT License'), 'The Fold brand kit requires the repository MIT license.');
    await writeFile(path.join(brandStage, 'LICENSE'), license);
    await copyFile(path.join(app, 'Contents/Resources/AwwOFold.icns'), path.join(brandStage, 'AwwOFold.icns'));
    await run('/usr/bin/ditto', ['-c', '-k', '--keepParent', brandStage, brandArchive]);

    // Detach before publishing completion evidence. The finally block retries
    // cleanup if packaging or a mounted-volume check throws.
    await run('/usr/bin/hdiutil', ['detach', mount]);
    mountAttempted = false;
    const assets = await Promise.all([dmg, archive, brandArchive, install].map(async file => ({ name: path.basename(file), sha256: await hash(file) })));
    await writeFile(path.join(output, 'SHA256SUMS'), assets.map(asset => `${asset.sha256}  ${asset.name}\n`).join(''));
    const result = { version, build, revision, cloudURL: configuration.cloudURL, signing: 'ad-hoc-local-only',
      notarized: false, dmgVerified: true, mountedBundleVerified: true, iconBrand: 'Fold', assets };
    await writeFile(path.join(output, 'release.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ output, ...result }, null, 2));
  } catch (error) {
    packagingError = error;
    throw error;
  } finally {
    if (mountAttempted) {
      try { await run('/usr/bin/hdiutil', ['detach', mount]); }
      catch (cleanupError) {
        // Even a failed/timed-out attach can have mounted the image. Never
        // recursively remove its mountpoint unless detachment was confirmed.
        const reason = packagingError instanceof Error ? packagingError.message : 'Release packaging did not finish.';
        throw new Error(`${reason}\nCould not confirm detachment of ${mount}; staging was preserved.`, { cause: cleanupError });
      }
    }
    await rm(work, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Release packaging failed.');
  process.exitCode = 1;
});
