import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, stateDir, loadLocalEnv, startDatabase, run, assertPortFree, waitForHttp, serviceEnvironments } from './awwo-saas-lib.mjs';

export async function runDevelopment({
  runtime = process, logger = console, spawnChild = spawn, runCommand = run,
  loadEnv = loadLocalEnv, startDb = startDatabase, assertFree = assertPortFree, waitHttp = waitForHttp,
} = {}) {
  const children = [];
  let database;
  let stopping = false;
  let exitCode = 0;
  let cleanup = Promise.resolve();
  function stop(code = 0) {
    stopping = true;
    if (code !== 0) exitCode = code;
    // Startup may still be awaiting an owned database when a signal arrives.
    // Serialize fresh cleanup passes so resources acquired later are also closed.
    cleanup = cleanup.then(async () => {
      for (const child of children.toReversed()) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise(resolve => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 8000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      })));
      if (database?.owned) {
        await runCommand('pg_ctl', ['-D', database.data, '-m', 'fast', '-w', 'stop']).catch(error => logger.error(error.message));
        database = undefined;
      }
      runtime.exitCode = exitCode;
    });
    return cleanup;
  }
  async function finishIfStopping() {
    if (!stopping) return false;
    await stop();
    return true;
  }
  runtime.on('SIGINT', () => void stop());
  runtime.on('SIGTERM', () => void stop());
  try {
    const { env, envFile, managedDatabase } = await loadEnv();
    if (await finishIfStopping()) return;
    await Promise.all([Number(env.AWWO_API_PORT), Number(env.AWWO_PI_PORT), Number(env.AWWO_OPENAI_AGENTS_PORT), Number(env.VITE_AWWO_WEB_PORT)].map(assertFree));
    if (await finishIfStopping()) return;
    if (managedDatabase) database = await startDb(env);
    if (await finishIfStopping()) return;
    if (runtime.argv.includes('--database-only')) {
      logger.log(`Local PostgreSQL ready on 127.0.0.1:${env.AWWO_LOCAL_DB_PORT}. Configuration: ${envFile}`);
    } else {
      const serviceEnv = serviceEnvironments(env);
      await runCommand('go', ['build', '-o', path.join(stateDir, 'bin', 'awwo-api'), './cmd/api'], { cwd: path.join(root, 'backend'), env: serviceEnv.build });
      if (await finishIfStopping()) return;
      function launch(command, args, label, childEnv) {
        if (stopping) throw new Error('Local startup was cancelled');
        const child = spawnChild(command, args, { cwd: root, env: childEnv, stdio: 'inherit' });
        children.push(child);
        child.on('error', error => { logger.error(`${label}: ${error.message}`); void stop(1); });
        child.on('exit', () => { if (!stopping) { logger.error(`${label} exited`); void stop(1); } });
        return child;
      }
      const pi = launch(runtime.execPath, ['apps/pi-worker/server.mjs'], 'Pi worker', serviceEnv.pi);
      await waitHttp(`${env.AWWO_PI_URL}/health`, pi, 30000, { allowUnconfiguredPi: true });
      if (await finishIfStopping()) return;
      const openAIAgents = launch(runtime.execPath, ['apps/openai-agents-worker/server.mjs'], 'OpenAI Agents worker', serviceEnv.openAIAgents);
      await waitHttp(`${env.AWWO_OPENAI_AGENTS_URL}/health`, openAIAgents, 30000, { allowUnconfiguredRuntime: 'openai-agents' });
      if (await finishIfStopping()) return;
      const api = launch(path.join(stateDir, 'bin', 'awwo-api'), [], 'Go API', serviceEnv.api);
      await waitHttp(`${env.AWWO_API_TARGET}/api/v1/health`, api);
      if (await finishIfStopping()) return;
      const web = launch(runtime.execPath, ['apps/web/node_modules/vite/bin/vite.js', '--config', 'apps/web/vite.saas.config.mjs', '--host', '127.0.0.1', '--port', env.VITE_AWWO_WEB_PORT, '--strictPort'], 'SaaS web', serviceEnv.web);
      await waitHttp(env.AWWO_PUBLIC_ORIGIN, web);
      if (await finishIfStopping()) return;
      logger.log(`AwwO SaaS ready: ${env.AWWO_PUBLIC_ORIGIN}\nAdmin: ${env.AWWO_BOOTSTRAP_ADMIN_EMAIL}; password is in ${envFile}\nSign in and connect your own API key in My engines. No Agent run is started automatically.`);
    }
  } catch (error) {
    if (!stopping) { logger.error(error.message); await stop(1); }
    else await stop();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runDevelopment();
