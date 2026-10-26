import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { stageWindowsBackend } from '../scripts/stage-windows-backend.mjs';

test('stages the executable and its onedir support files together', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awwo-stage-'));
  try {
    const source = path.join(root, 'dist');
    const target = path.join(root, 'resources');
    fs.mkdirSync(path.join(source, '_internal'), { recursive: true });
    fs.writeFileSync(path.join(source, 'superclaw-backend.exe'), 'executable');
    fs.writeFileSync(path.join(source, '_internal', 'python.dll'), 'runtime');
    stageWindowsBackend(source, target, 'development');
    assert.equal(fs.readFileSync(path.join(target, '_internal', 'python.dll'), 'utf8'), 'runtime');
    assert.equal(JSON.parse(fs.readFileSync(path.join(target, 'build-profile.json'))).app_env, 'development');
    assert.throws(() => stageWindowsBackend(path.join(root, 'missing'), target, 'development'));
    assert.equal(fs.readFileSync(path.join(target, 'superclaw-backend.exe'), 'utf8'), 'executable');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
