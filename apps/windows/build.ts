import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cloudOrigin } from './config.ts';

if (process.platform !== 'win32') throw new Error('Build the Windows release on Windows.');
const origin = cloudOrigin(process.env);
const root = fileURLToPath(new URL('.', import.meta.url));
const cli = fileURLToPath(new URL('../desktop/node_modules/@tauri-apps/cli/tauri.js', import.meta.url));
const result = spawnSync(process.execPath, [cli, 'build', '--bundles', 'nsis'], {
  cwd: root, stdio: 'inherit', env: { ...process.env, AWWO_WINDOWS_CLOUD_URL: origin },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
