import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkerServer } from './server.ts';
import { loadConfig } from './config.ts';
import { listenLocal } from './transport.ts';

test('missing core is an explicit unavailable health result; browser and unauthenticated callers cannot operate worker', async () => {
  const token = 'test-service-token-'.repeat(3);
  const worker = createWorkerServer(loadConfig({ AWWO_OPENMAUS_TOKEN: token, AWWO_OPENMAUS_CORE_PATH: '/does-not-exist/openmaus/index.js' }));
  const url = await listenLocal(worker.server), headers = { authorization: `Bearer ${token}` };
  try {
    const response = await fetch(url + '/health', { headers }); assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { service: 'awwo-openmaus-worker', ready: false, configured: false, status: 'unconfigured', reason: 'core_not_installed', capabilities: { workspace: true, approvals: true }, upstreamRevision: '104fd17b8f7767e71ba3cf40f27f9c6279b507bd' });
    assert.equal((await fetch(url + '/health')).status, 401);
    assert.equal((await fetch(url + '/health', { headers: { ...headers, origin: 'https://evil.invalid' } })).status, 403);
    assert.equal((await fetch(url + '/internal/runs', { method: 'POST', headers, body: '{}' })).status, 503);
    assert.equal((await fetch(url + '/internal/runs/unknown/respond', { method: 'POST', headers, body: '{}' })).status, 404);
  } finally { await worker.close(); }
});
