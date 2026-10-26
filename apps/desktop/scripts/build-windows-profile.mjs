import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { windowsProfile } from './windows-profile.mjs';

// Backend and Node resources are prepared once with build-backend/build-node-server.
// Each invocation builds fresh frontend and Rust binaries for one explicit profile.
const profile = windowsProfile(process.argv[2]);
if (process.platform !== 'win32') throw new Error('Windows packaging requires a Windows host');
const desktop = fileURLToPath(new URL('..', import.meta.url));
const repo = path.resolve(desktop, '../..');
const stage = path.join(desktop, 'src-tauri/resources/backend/superclaw-backend');
for (const relative of ['superclaw-backend.exe', 'node-runtime/node.exe', 'node-runtime/server/dist/index.js']) {
  if (!fs.existsSync(path.join(stage, relative))) throw new Error(`Missing prepared resource: ${relative}`);
}
const config = JSON.parse(fs.readFileSync(path.join(desktop, 'src-tauri/tauri.conf.json'), 'utf8'));
config.productName = profile.productName;
config.identifier = profile.identifier;
config.app.windows[0].title = profile.windowTitle;
config.app.windows[0].hiddenTitle = false;
delete config.app.windows[0].titleBarStyle;
delete config.app.windows[0].trafficLightPosition;
config.bundle.targets = ['nsis'];
// Drop the source-only `resources/` prefix at installation time. This keeps the
// deepest dependency paths below classic Win32 limits in the per-user install.
config.bundle.resources = {
  'resources/backend/superclaw-backend/': 'backend/superclaw-backend/',
};
const generated = path.join(desktop, `src-tauri/tauri.${profile.environment}.local.json`);
fs.writeFileSync(generated, JSON.stringify(config, null, 2));
fs.writeFileSync(path.join(stage, 'build-profile.json'), JSON.stringify({ app_env: profile.environment }, null, 2));

const python = process.env.AWWO_BUILD_PYTHON || 'python';
const env = {
  ...process.env,
  APP_ENV: profile.environment,
  VITE_APP_ENV: profile.environment,
  AWWO_DESKTOP_ENV: profile.environment,
  AWWO_DESKTOP_PRODUCT_NAME: profile.productName,
  AWWO_DESKTOP_RELEASE_CHANNEL: profile.releaseChannel,
  PYTHONPATH: path.join(repo, 'packages/superclaw/src'),
  PYTHONUTF8: '1',
  CARGO_TARGET_DIR: path.resolve(desktop, process.env.CARGO_TARGET_DIR || 'src-tauri/target'),
};
// Read public endpoints from the existing canonical schema; do not copy credentials.
const endpoints = JSON.parse(execFileSync(python, ['-c',
  'import json; from superclaw.environment import CLAWHUNT_BASE_URLS, RELAY_BASE_URLS; import os; e=os.environ["APP_ENV"]; print(json.dumps({"clawhunt":CLAWHUNT_BASE_URLS[e],"relay":RELAY_BASE_URLS[e]}))',
], { cwd: repo, env, encoding: 'utf8' }));
env.CLAWHUNT_BASE_URL = endpoints.clawhunt;
env.VITE_CLAWHUNT_BASE_URL = endpoints.clawhunt;
env.SUPERCLAW_RELAY_BASE_URL = endpoints.relay;
const tauri = path.join(desktop, 'node_modules/@tauri-apps/cli/tauri.js');
execFileSync(process.execPath, [tauri, 'build', '--bundles', 'nsis', '--config', generated], {
  cwd: desktop, env, stdio: 'inherit',
});
const artifactDir = path.join(repo, 'release/windows', profile.environment);
fs.mkdirSync(artifactDir, { recursive: true });
const targetDir = env.CARGO_TARGET_DIR;
const installerDir = path.join(targetDir, 'release/bundle/nsis');
const installers = fs.readdirSync(installerDir).filter(name => name.startsWith(`${profile.productName}_`) && name.endsWith('-setup.exe'));
if (installers.length !== 1) throw new Error(`Expected exactly one installer for ${profile.productName}`);
fs.copyFileSync(path.join(installerDir, installers[0]), path.join(artifactDir, installers[0]));
fs.copyFileSync(path.join(targetDir, 'release/superclaw_desktop.exe'), path.join(artifactDir, 'superclaw_desktop.exe'));
fs.writeFileSync(path.join(artifactDir, 'build-profile.json'), JSON.stringify({ ...profile, endpoints }, null, 2));
console.log(`Built ${profile.environment}: ${artifactDir}`);
