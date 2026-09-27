import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cloudOrigins } from './config.ts';

if (process.platform !== 'win32') throw new Error('Build the Windows release on Windows.');
const origins = cloudOrigins(process.env);
const root = fileURLToPath(new URL('.', import.meta.url));
const cli = fileURLToPath(new URL('../desktop/node_modules/@tauri-apps/cli/tauri.js', import.meta.url));
const result = spawnSync(process.execPath, [cli, 'build', '--bundles', 'nsis'], {
  cwd: root, stdio: 'inherit', env: {
    ...process.env,
    AWWO_WINDOWS_CLOUD_URL: origins.app,
    AWWO_WINDOWS_ACCESS_ORIGIN: origins.access,
    AWWO_WINDOWS_IDP_ORIGINS: origins.identityProviders.join(',') || 'none',
  },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
