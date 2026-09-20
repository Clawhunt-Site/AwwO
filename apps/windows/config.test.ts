import assert from 'node:assert/strict';
import test from 'node:test';
import { cloudOrigin } from './config.ts';
const env = { APP_ENV: 'production', VITE_APP_ENV: 'production' };
test('production wrapper accepts an explicit HTTPS origin without credentials', () => {
  assert.equal(cloudOrigin({ ...env, AWWO_WINDOWS_CLOUD_URL: 'https://app.example.test/' }), 'https://app.example.test');
  for (const value of ['http://app.example.test', 'https://localhost', 'https://127.0.0.1', 'https://[::1]', 'https://app.example.test/path', 'https://user:secret@app.example.test', 'https://app.example.test?key=secret', 'https://app.example.test:8080']) {
    assert.throws(() => cloudOrigin({ ...env, AWWO_WINDOWS_CLOUD_URL: value }));
  }
  assert.throws(() => cloudOrigin({ ...env, APP_ENV: 'staging', AWWO_WINDOWS_CLOUD_URL: 'https://app.example.test' }));
  assert.throws(() => cloudOrigin(env));
});
