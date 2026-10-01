import { mkdir } from 'node:fs/promises';
import { run, root, stateDir, serviceEnvironments } from './awwo-saas-lib.mjs';
try {
  await mkdir(`${stateDir}/bin`, { recursive: true, mode: 0o700 });
  await Promise.all([
    run('npm', ['ci', '--prefix', 'apps/web']),
    run('npm', ['ci', '--ignore-scripts', '--prefix', 'apps/pi-worker']),
    run('npm', ['ci', '--ignore-scripts', '--prefix', 'apps/openai-agents-worker']),
    run('npm', ['ci', '--ignore-scripts', '--prefix', 'apps/openmaus-worker']),
    run(process.execPath, ['apps/openmaus-worker/setup.ts'], { env: { ...serviceEnvironments(process.env).build, ...(process.env.AWWO_OPENMAUS_SOURCE ? { AWWO_OPENMAUS_SOURCE: process.env.AWWO_OPENMAUS_SOURCE } : {}) } }),
    run('go', ['mod', 'download'], { cwd: `${root}/backend` }),
  ]);
  await run('go', ['build', '-o', '../.local/awwo-saas/bin/awwo-api', './cmd/api'], { cwd: `${root}/backend` });
  await run('npm', ['run', 'build:saas', '--prefix', 'apps/web']);
  try {
    await run('docker', ['build', '-t', 'awwo-workspace:20261001', 'deploy/saas/workspace']);
  } catch {
    console.warn('The execution workspace image is not ready. Start Docker and rerun npm run setup:saas; other AwwO features remain available.');
  }
  console.log('SaaS dependencies and build ready. Run npm run dev:saas.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
