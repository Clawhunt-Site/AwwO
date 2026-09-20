import assert from 'node:assert/strict';
import test from 'node:test';
import { readProductionConfiguration } from './production-config.ts';

const valid = { APP_ENV: 'production', VITE_APP_ENV: 'production', AWWO_MAC_CLOUD_URL: 'https://awwo.example.org/' };

test('production origin is explicit and normalized', () => {
  assert.deepEqual(readProductionConfiguration(valid), { environment: 'production', cloudURL: 'https://awwo.example.org' });
});

test('refuses missing or inconsistent production intent', () => {
  for (const env of [{}, { ...valid, APP_ENV: 'staging' }, { ...valid, VITE_APP_ENV: 'development' }, { ...valid, AWWO_MAC_CLOUD_URL: '' }]) {
    assert.throws(() => readProductionConfiguration(env));
  }
});

test('refuses credentials, local origins and URLs containing request state', () => {
  for (const url of ['http://awwo.example.org', 'https://name:secret@awwo.example.org', 'https://awwo.example.org/?token=secret',
    'https://awwo.example.org/#token', 'https://awwo.example.org/workspace', 'https://awwo.example.org:8443',
    'https://localhost', 'https://127.0.0.1', 'https://[::1]', 'not a URL']) {
    assert.throws(() => readProductionConfiguration({ ...valid, AWWO_MAC_CLOUD_URL: url }));
  }
});
