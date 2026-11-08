// The real thing, through the real server: rea-video, ffmpeg and ffprobe on one video. Skipped unless
// AWWO_ANALYSIS_TEST_REA (rea-video's executable), AWWO_ANALYSIS_TEST_MODELS (a directory holding MODEL_FILES) and
// AWWO_ANALYSIS_TEST_VIDEO (a short video) are set; AWWO_ANALYSIS_TEST_PATH is the children's PATH, which must hold
// ffmpeg and ffprobe (default: this process's PATH). A 19 s 480x854 clip takes about a minute and 2.5 GB of memory.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from './config.mjs';
import { verifyModels } from './analysis-run.mjs';
import { createAnalysisServer } from './server.mjs';

const rea = process.env.AWWO_ANALYSIS_TEST_REA;
const models = process.env.AWWO_ANALYSIS_TEST_MODELS;
const video = process.env.AWWO_ANALYSIS_TEST_VIDEO;

test('rea-video analyses a real video through the worker', { skip: !(rea && models && video) && 'set AWWO_ANALYSIS_TEST_REA, _MODELS and _VIDEO', timeout: 900_000 }, async () => {
  const token = 'i'.repeat(40);
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'awwo-analysis-int-'));
  const config = loadConfig({ AWWO_ANALYSIS_TOKEN: token, AWWO_ANALYSIS_REA: rea, AWWO_ANALYSIS_MODELS: models, AWWO_ANALYSIS_TMP: tmp,
    AWWO_ANALYSIS_PATH: process.env.AWWO_ANALYSIS_TEST_PATH || process.env.PATH, AWWO_ANALYSIS_TIMEOUT_MS: '840000' });
  config.modelsOk = await verifyModels(config);
  assert.equal(config.modelsOk, true, 'the models directory does not hold the pinned models');
  const app = createAnalysisServer(config);
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = (method, route, body, type) => fetch(base + route, { method, body, headers: { Authorization: `Bearer ${token}`, ...(type ? { 'Content-Type': type } : {}) } });
  try {
    const health = await (await fetch(`${base}/health`)).json();
    assert.equal(health.ready, true, JSON.stringify(health));
    const data = await readFile(video);
    const sha256 = createHash('sha256').update(data).digest('hex');
    assert.equal((await call('POST', '/internal/analyses', JSON.stringify({ analysisId: 'int_123456', file: { name: path.basename(video), size: data.length, sha256 } }), 'application/json')).status, 201);
    assert.equal((await call('PUT', '/internal/analyses/int_123456/file', data, 'application/octet-stream')).status, 204);
    const response = await call('POST', '/internal/analyses/int_123456/run');
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.match(result.report.schema, /^rea_video\.breakdown\./);
    assert.ok(result.report.shots > 0 && result.report.verdict);
    assert.ok(result.summary && !result.summary.includes(tmp));
    const names = result.outputs.map((output) => output.name);
    for (const name of ['breakdown.json', 'report.html', 'report.md', 'storyboard.jpg', 'summary.txt', 'review_tasks.json']) assert.ok(names.includes(name), name);
    for (const output of result.outputs.filter((entry) => /\.(json|md|html|srt|ass|txt)$/.test(entry.name))) {
      const text = await (await call('GET', `/internal/analyses/int_123456/outputs/${output.name}`)).text();
      assert.ok(!text.includes(tmp), `${output.name} names the worker's disk`);
      assert.equal(createHash('sha256').update(text).digest('hex'), output.sha256, output.name);
    }
    assert.equal((await call('DELETE', '/internal/analyses/int_123456')).status, 204);
  } finally {
    await app.close();
  }
});
