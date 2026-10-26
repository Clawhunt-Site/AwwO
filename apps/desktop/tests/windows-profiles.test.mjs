import assert from 'node:assert/strict';
import { test } from 'node:test';
import { windowsProfile } from '../scripts/windows-profile.mjs';

test('three profiles have distinct application and data identities', () => {
  const profiles = ['development', 'staging', 'production'].map(windowsProfile);
  assert.equal(new Set(profiles.map(p => p.identifier)).size, 3);
  assert.equal(new Set(profiles.map(p => p.productName)).size, 3);
  assert.deepEqual(profiles.map(p => p.environment), ['development', 'staging', 'production']);
});

test('packaging requires an explicit canonical profile', () => {
  for (const value of [undefined, '', 'local', 'prod', 'invalid']) {
    assert.throws(() => windowsProfile(value), /explicit profile/);
  }
});

test('production exposes only the official title and stable channel', () => {
  assert.equal(windowsProfile('production').windowTitle, 'AwwO');
  assert.equal(windowsProfile('production').releaseChannel, 'stable');
  assert.equal(windowsProfile('staging').releaseChannel, 'beta');
  assert.match(windowsProfile('staging').windowTitle, /staging/);
});
