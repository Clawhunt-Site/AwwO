import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig, validateAnalysisRequest } from './config.mjs';

const SHA = 'a'.repeat(64);

test('defaults: not ready without a token, bounded limits', () => {
  const config = loadConfig({});
  assert.equal(config.ready, false);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 8121);
  assert.equal(config.rea, 'rea-video');
  assert.equal(config.maxInputBytes, 512 * 1024 * 1024);
  assert.equal(config.maxSeconds, 300);
  assert.equal(config.timeoutMs, 1_800_000);
  assert.equal(config.modelsOk, false);
  assert.ok(config.threads >= 1 && config.threads <= 8);
  assert.equal(loadConfig({ AWWO_ANALYSIS_TOKEN: 'x'.repeat(31) }).ready, false);
  assert.equal(loadConfig({ AWWO_ANALYSIS_TOKEN: 'x'.repeat(32) }).ready, true);
});

test('malformed settings stop the worker at startup', () => {
  for (const env of [
    { AWWO_ANALYSIS_LISTEN: 'nope' }, { AWWO_ANALYSIS_LISTEN: '127.0.0.1:70000' },
    { AWWO_ANALYSIS_MAX_SECONDS: '0' }, { AWWO_ANALYSIS_MAX_SECONDS: '1.5' }, { AWWO_ANALYSIS_MAX_INPUT_MB: '9000' },
    { AWWO_ANALYSIS_TIMEOUT_MS: '10' }, { AWWO_ANALYSIS_THREADS: '0' }, { AWWO_ANALYSIS_MODELS: 'relative/models' },
  ]) assert.throws(() => loadConfig(env), Error, JSON.stringify(env));
  assert.deepEqual(loadConfig({ AWWO_ANALYSIS_LISTEN: '[::1]:9000' }).host, '::1');
});

test('a manifest: one video by size and sha256, options with defaults', () => {
  const limits = { maxInputBytes: 1000 };
  const ok = validateAnalysisRequest({ analysisId: 'job_12345', file: { name: '参考 video.mp4', size: 10, sha256: SHA } }, limits);
  assert.deepEqual(ok.options, { lang: 'zh', ocr: true, ocrLang: 'zh', packaging: true, stems: false, review: true });
  const custom = validateAnalysisRequest({ analysisId: 'job_12345', file: { name: 'a.mp4', size: 10, sha256: SHA },
    options: { lang: 'en', ocr: false, ocrLang: 'ja', packaging: false, stems: true, review: false } }, limits);
  assert.equal(custom.options.lang, 'en');
  assert.equal(custom.options.stems, true);
  const bad = [
    [null, 'body'], [[], 'body'], [{ analysisId: 'short', file: {} }, 'analysisId'],
    [{ analysisId: 'job_12345' }, 'file'], [{ analysisId: 'job_12345', file: { name: 'a/b.mp4', size: 1, sha256: SHA } }, 'file.name'],
    [{ analysisId: 'job_12345', file: { name: 'a\u0000', size: 1, sha256: SHA } }, 'file.name'],
    [{ analysisId: 'job_12345', file: { name: 'a.mp4', size: 0, sha256: SHA } }, 'file.size'],
    [{ analysisId: 'job_12345', file: { name: 'a.mp4', size: 1001, sha256: SHA } }, 'file.size'],
    [{ analysisId: 'job_12345', file: { name: 'a.mp4', size: 1, sha256: 'A'.repeat(64) } }, 'file.sha256'],
    [{ analysisId: 'job_12345', file: { name: 'a.mp4', size: 1, sha256: SHA }, options: { lang: 'fr' } }, 'options.lang'],
    [{ analysisId: 'job_12345', file: { name: 'a.mp4', size: 1, sha256: SHA }, options: { stems: 'yes' } }, 'options.stems'],
    [{ analysisId: 'job_12345', file: { name: 'a.mp4', size: 1, sha256: SHA }, options: [] }, 'options'],
  ];
  for (const [body, field] of bad) {
    assert.throws(() => validateAnalysisRequest(body, limits), (error) => error.code === 'INVALID_ANALYSIS' && error.field === field, field);
  }
});
