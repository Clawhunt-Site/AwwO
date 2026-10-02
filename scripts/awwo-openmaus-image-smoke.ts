import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { parseImage } from './awwo-saas-release.ts';

export async function smokeImage(image: string): Promise<void> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/@:-]{0,254}$/.test(image)) throw new Error('Pass one trusted local image reference.');
  const docker = (args: string[]): string => execFileSync('docker', ['--context', 'default', ...args], { encoding: 'utf8', timeout: 45_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  parseImage(docker(['image', 'inspect', '--format', '{{json .}}', image]));
  const name = `awwo-image-check-${randomUUID()}`;
  // Synthetic internal token only. The image receives no host socket or provider credentials.
  const token = 'synthetic-ci-openmaus-image-token-32-chars';
  let created = false;
  try {
    docker(['run', '-d', '--name', name, '--network', 'none', '--read-only', '--tmpfs', '/tmp:size=512m,mode=1777', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--pids-limit', '256', '--memory', '2g', '-e', `AWWO_OPENMAUS_TOKEN=${token}`, '-e', 'AWWO_OPENMAUS_HOST=127.0.0.1', image]);
    created = true;
    const probe = `import assert from 'node:assert/strict'; import {existsSync,readFileSync} from 'node:fs';
      assert.equal(process.getuid(),1000); assert.ok(Number(process.versions.node.split('.')[0])>=24);
      const core='/app/apps/openmaus-worker/.runtime/core/dist-server/';
      for(const file of ['index.js','LICENSE','NOTICE','third_party','awwo-build.json']) assert.ok(existsSync(core+file));
      assert.equal(existsSync(core+'enterprise'),false);
      const response=await fetch('http://127.0.0.1:8099/health',{headers:{authorization:'Bearer '+process.env.AWWO_OPENMAUS_TOKEN},signal:AbortSignal.timeout(6000)});
      const health=await response.json(); assert.equal(response.status,503); assert.equal(health.reason,'workspace_unavailable'); assert.equal(health.ready,false); assert.equal(health.service,'awwo-openmaus-worker');
      const manifest=JSON.parse(readFileSync(core+'awwo-build.json','utf8')); assert.equal(health.upstreamRevision,manifest.upstreamRevision);
      console.log(JSON.stringify({node:process.version,uid:process.getuid(),health,manifest}));`;
    let result = '';
    for (let attempt = 0; attempt < 30; attempt++) {
      try { result = docker(['exec', name, 'node', '--input-type=module', '-e', probe]); break; }
      catch (error) { if (attempt === 29) throw error; await delay(1000); }
    }
    assert.ok(result); console.log(result);
    docker(['stop', '--time', '30', name]);
    assert.equal(docker(['inspect', '--format', '{{.State.ExitCode}}', name]), '0');
  } finally {
    try { docker(['rm', '--force', name]); }
    catch (error) { if (created) throw error; /* A failed start may not have created this uniquely named container. */ }
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/awwo-openmaus-image-smoke.ts IMAGE');
  await smokeImage(process.argv[2]!);
}
