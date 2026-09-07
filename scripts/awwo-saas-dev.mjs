import { spawn } from 'node:child_process';
import path from 'node:path';
import { root, stateDir, loadLocalEnv, startDatabase, run, assertPortFree, waitForHttp } from './awwo-saas-lib.mjs';
const children = [];
let database;
let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children.toReversed()) if (child.exitCode === null) child.kill('SIGTERM');
  await Promise.all(children.map(child => child.exitCode !== null ? Promise.resolve() : new Promise(resolve => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 8000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  })));
  if (database?.owned) await run('pg_ctl', ['-D', database.data, '-m', 'fast', '-w', 'stop']).catch(error => console.error(error.message));
  process.exitCode = code;
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
try {
  const { env, envFile, managedDatabase } = await loadLocalEnv();
  await Promise.all([Number(env.AWWO_API_PORT), Number(env.AWWO_PI_PORT), Number(env.VITE_AWWO_WEB_PORT)].map(assertPortFree));
  if (managedDatabase) database = await startDatabase(env);
  if (process.argv.includes('--database-only')) {
    console.log(`Local PostgreSQL ready on 127.0.0.1:${env.AWWO_LOCAL_DB_PORT}. Configuration: ${envFile}`);
  } else {
    await run('go', ['build', '-o', path.join(stateDir, 'bin', 'awwo-api'), './cmd/api'], { cwd: path.join(root, 'backend'), env });
    function launch(command, args, label) {
      const child = spawn(command, args, { cwd: root, env, stdio: 'inherit' });
      children.push(child);
      child.on('error', error => { console.error(`${label}: ${error.message}`); void stop(1); });
      child.on('exit', () => { if (!stopping) { console.error(`${label} exited`); void stop(1); } });
      return child;
    }
    const pi = launch(process.execPath, ['apps/pi-worker/server.mjs'], 'Pi worker');
    await waitForHttp(`${env.AWWO_PI_URL}/health`, pi, 30000, { allowUnconfiguredPi: true });
    const api = launch(path.join(stateDir, 'bin', 'awwo-api'), [], 'Go API');
    await waitForHttp(`${env.AWWO_API_TARGET}/api/v1/health`, api);
    const web = launch(process.execPath, ['apps/web/node_modules/vite/bin/vite.js', '--config', 'apps/web/vite.saas.config.mjs', '--host', '127.0.0.1', '--port', env.VITE_AWWO_WEB_PORT, '--strictPort'], 'SaaS web');
    await waitForHttp(env.AWWO_PUBLIC_ORIGIN, web);
    console.log(`AwwO SaaS ready: ${env.AWWO_PUBLIC_ORIGIN}\nAdmin: ${env.AWWO_BOOTSTRAP_ADMIN_EMAIL}; password is in ${envFile}\nPi provider credentials are configured in the same local file. No Agent run is started automatically.`);
  }
} catch (error) { console.error(error.message); await stop(1); }
