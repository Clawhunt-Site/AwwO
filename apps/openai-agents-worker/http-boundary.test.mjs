import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { request } from 'node:http';
import test from 'node:test';

test('malformed HTTP targets cannot terminate the service or bypass subsequent authentication', { timeout: 10_000 }, async (t) => {
  const token = 'http-boundary-test-token-at-least-32-characters';
  const source = `
    import { createOpenAIAgentsServer } from ${JSON.stringify(new URL('./server.mjs', import.meta.url).href)};
    import { loadConfig } from ${JSON.stringify(new URL('./config.mjs', import.meta.url).href)};
    const app = createOpenAIAgentsServer(loadConfig({ AWWO_OPENAI_AGENTS_TOKEN: ${JSON.stringify(token)} }));
    process.on('SIGTERM', () => { void app.close().then(() => process.exit(0)); });
    app.server.listen(0, '127.0.0.1', () => process.send({ port: app.server.address().port }));
  `;
  // An uncaught async HTTP-handler error must fail in a real process, as it
  // would in production, without terminating the test runner itself.
  const child = spawn(process.execPath, ['--input-type=module', '--eval', source], {
    env: {}, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const stopped = once(child, 'exit');
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 2_000);
    try { await stopped; } finally { clearTimeout(timer); }
  });
  const [ready] = await once(child, 'message');
  const send = (path, headers = {}) => new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: ready.port, path, headers, signal: AbortSignal.timeout(2_000) }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
      response.on('error', reject);
    });
    req.on('error', (error) => reject(new Error(`HTTP request failed: ${error.message}; child stderr: ${stderr}`)));
    req.end();
  });

  for (const target of ['//', 'http://[', 'http://']) {
    const response = await send(target);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'INVALID_REQUEST_TARGET');
  }
  const health = await send('/health?probe=after-malformed-request');
  assert.equal(health.status, 503);
  assert.equal(health.body.status, 'unconfigured');
  assert.equal((await send('/internal/runs')).status, 401);
  assert.equal((await send('/internal/runs', { authorization: `Bearer ${token}` })).status, 404);
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, null);
  assert.equal(stderr, '');
});
