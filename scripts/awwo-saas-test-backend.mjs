import path from 'node:path';
import { root, loadLocalEnv, startDatabase, run } from './awwo-saas-lib.mjs';
let database;
try {
  const { env, managedDatabase } = await loadLocalEnv();
  if (managedDatabase) database = await startDatabase(env);
  const options = { cwd:path.join(root,'backend'), env:{...env,AWWO_TEST_DATABASE_URL:env.AWWO_DATABASE_URL} };
  await run('go',['test','-race','-count=1','-v','./...'], options);
  await run('go',['vet','./...'], options);
} catch (error) { console.error(error.message); process.exitCode=1; }
finally { if (database?.owned) await run('pg_ctl',['-D',database.data,'-m','fast','-w','stop']).catch(error=>{console.error(error.message);process.exitCode=1;}); }
