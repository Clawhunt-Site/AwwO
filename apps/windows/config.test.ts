import assert from 'node:assert/strict';
import test from 'node:test';
import { cloudOrigin, cloudOrigins } from './config.ts';
const env = { APP_ENV: 'production', VITE_APP_ENV: 'production' };
test('production wrapper requires exact public app and Access origins', () => {
  const releaseEnv = { ...env, AWWO_WINDOWS_CLOUD_URL: 'https://app.example.test/', AWWO_WINDOWS_ACCESS_ORIGIN: 'https://team.cloudflareaccess.example.test', AWWO_WINDOWS_IDP_ORIGINS: 'https://accounts.example.test,https://login.example.test' };
  assert.equal(cloudOrigin(releaseEnv), 'https://app.example.test');
  assert.deepEqual(cloudOrigins(releaseEnv), { app: 'https://app.example.test', access: 'https://team.cloudflareaccess.example.test', identityProviders: ['https://accounts.example.test', 'https://login.example.test'] });
  for (const value of ['http://app.example.test', 'https://localhost', 'https://localhost.', 'https://api.localhost.', 'https://127.0.0.1', 'https://[::1]', 'https://app.example.test/path', 'https://user:secret@app.example.test', 'https://app.example.test?key=secret', 'https://app.example.test:8080']) {
    assert.throws(() => cloudOrigin({ ...releaseEnv, AWWO_WINDOWS_CLOUD_URL: value }));
  }
  for (const value of ['http://team.cloudflareaccess.example.test', 'https://localhost', 'https://team.cloudflareaccess.example.test/path', 'https://name:secret@team.cloudflareaccess.example.test', 'https://team.cloudflareaccess.example.test?state=secret', 'https://team.cloudflareaccess.example.test:8443']) {
    assert.throws(() => cloudOrigin({ ...releaseEnv, AWWO_WINDOWS_ACCESS_ORIGIN: value }));
  }
  assert.throws(() => cloudOrigin({ ...releaseEnv, AWWO_WINDOWS_ACCESS_ORIGIN: undefined }), /AWWO_WINDOWS_ACCESS_ORIGIN/);
  assert.deepEqual(cloudOrigins({ ...releaseEnv, AWWO_WINDOWS_IDP_ORIGINS: 'none' }).identityProviders, []);
  for (const value of [undefined, '', 'https://accounts.example.test/path', 'https://name:secret@accounts.example.test', 'http://accounts.example.test', 'https://accounts.example.test,https://accounts.example.test:8443', 'none,https://accounts.example.test']) {
    assert.throws(() => cloudOrigins({ ...releaseEnv, AWWO_WINDOWS_IDP_ORIGINS: value }), /AWWO_WINDOWS_IDP_ORIGINS/);
  }
  assert.throws(() => cloudOrigin({ ...releaseEnv, APP_ENV: 'staging' }));
  assert.throws(() => cloudOrigin(env));
});
