import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repositoryRoot, runCommand } from './awwo-dev.mjs';

export function assertNodeVersion(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  if (!((major === 22 && minor >= 13) || major >= 24)) {
    throw new Error('Node.js 22.13+ (22.x) or 24+ is required; Node.js 24 is recommended.');
  }
}

export async function setup({ root = repositoryRoot, env = process.env, execute = runCommand } = {}) {
  assertNodeVersion();
  const options = { cwd: root, env, packageManager: true };
  const version = await execute('pnpm', ['-C', 'server', '--version'], { ...options, capture: true });
  if (version.trim() !== '9.15.4') throw new Error('The server workspace requires pnpm 9.15.4. Activate the packageManager version through Corepack or your local toolchain.');
  for (const [command, args] of [
    ['pnpm', ['-C', 'server', 'install', '--frozen-lockfile']],
    ['pnpm', ['-C', 'server', 'run', 'preflight:workspace-links']],
    ['pnpm', ['-C', 'server', '--filter', '@paperclipai/plugin-sdk', 'ensure-build-deps']],
    ['npm', ['ci', '--prefix', 'apps/web']],
    ['npm', ['ci', '--prefix', 'apps/gateway']],
    ['npm', ['run', 'build', '--prefix', 'apps/gateway']],
  ]) await execute(command, args, options);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--help')) {
    console.log('Usage: node scripts/awwo-setup.mjs\nInstalls locked server/web/gateway dependencies and builds the gateway.\nRequires Node.js 22.13+ (22.x) or 24+, and pnpm 9.15.4. Does not start services or Agents.');
  } else {
    setup().then(() => console.log('AwwO setup complete. Run npm run dev.')).catch((error) => {
      console.error(`[AwwO] Setup failed: ${error.message}`);
      process.exitCode = 1;
    });
  }
}
