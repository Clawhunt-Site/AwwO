import { mkdir } from 'node:fs/promises';
import { run, root, stateDir } from './awwo-saas-lib.mjs';
try {
  await mkdir(`${stateDir}/bin`, { recursive: true, mode: 0o700 });
  await Promise.all([
    run('npm', ['ci', '--prefix', 'apps/web']),
    run('npm', ['ci', '--ignore-scripts', '--prefix', 'apps/pi-worker']),
    run('go', ['mod', 'download'], { cwd: `${root}/backend` }),
  ]);
  await run('go', ['build', '-o', '../.local/awwo-saas/bin/awwo-api', './cmd/api'], { cwd: `${root}/backend` });
  await run('npm', ['run', 'build:saas', '--prefix', 'apps/web']);
  console.log('SaaS dependencies and build ready. Run npm run dev:saas.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
