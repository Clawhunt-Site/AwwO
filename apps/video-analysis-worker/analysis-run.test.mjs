import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { AnalysisError, decomposeArgs, outputWanted, runAnalysis, sniffVideo, verifyModels } from './analysis-run.mjs';
import { fakeConfig, fakeMp4 } from './test-helpers.mjs';

const hex = (value) => Buffer.from(value, 'hex');

test('sniffVideo takes the containers AwwO uploads as video and nothing else', () => {
  assert.equal(sniffVideo(fakeMp4(64))?.ext, 'mp4');
  assert.equal(sniffVideo(hex('0000001466747970717420200000000071742020'))?.ext, 'mov');
  assert.equal(sniffVideo(hex('000000086d6f6f760000000000000000'))?.ext, 'mov');
  assert.equal(sniffVideo(hex('1a45dfa3a34286810142f7810142f281'))?.ext, 'mkv');
  assert.equal(sniffVideo(Buffer.from('RIFF\x10\x00\x00\x00AVI LIST', 'latin1'))?.ext, 'avi');
  assert.equal(sniffVideo(Buffer.from('FLV\x01\x05', 'latin1'))?.ext, 'flv');
  assert.equal(sniffVideo(hex('3026b2758e66cf11a6d900aa0062ce6c0000'))?.ext, 'wmv');
  for (const other of [hex('89504e470d0a1a0a0000000d'), Buffer.from('ID3\x04\x00', 'latin1'), Buffer.from('RIFF\x10\x00\x00\x00WAVEfmt ', 'latin1'), Buffer.alloc(0), Buffer.from('hello world!')]) {
    assert.equal(sniffVideo(other), null);
  }
});

test('decompose arguments follow the options', () => {
  const base = { lang: 'zh', ocr: true, ocrLang: 'zh', packaging: true };
  assert.deepEqual(decomposeArgs('/j/input.mp4', '/j/out', base), ['decompose', '/j/input.mp4', '-o', '/j/out', '--lang', 'zh']);
  assert.deepEqual(decomposeArgs('i', 'o', { ...base, lang: 'en', ocrLang: 'ja', packaging: false }), ['decompose', 'i', '-o', 'o', '--lang', 'en', '--ocr-lang', 'ja', '--no-packaging']);
  assert.deepEqual(decomposeArgs('i', 'o', { ...base, ocr: false, ocrLang: 'ja' }), ['decompose', 'i', '-o', 'o', '--lang', 'zh', '--no-ocr']);
});

test('only the report files, shot sheets, packaging files and asked-for stems are outputs', () => {
  const plain = { stems: false };
  for (const name of ['breakdown.json', 'report.html', 'report.md', 'storyboard.jpg', 'audio.png', 'summary.txt', 'review_tasks.json', 'shots/shot_001.jpg', 'packaging/subtitles.srt', 'packaging/overlays.ass', 'packaging/sticker_01.jpg']) {
    assert.equal(outputWanted(name, plain), true, name);
  }
  for (const name of ['stems/vocals.wav', 'debug.log', 'env.json', 'shots/notes.txt', 'other/a.jpg', '../breakdown.json', 'shots/../../x.jpg', '.hidden.json', 'shots/a/b.jpg']) {
    assert.equal(outputWanted(name, plain), false, name);
  }
  assert.equal(outputWanted('stems/vocals.wav', { stems: true }), true);
});

test('verifyModels needs every pinned model with its sha256', async () => {
  const config = await fakeConfig();
  await mkdir(config.models, { recursive: true });
  config.modelFiles = [{ name: 'm.onnx', sha256: '2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae' }];
  assert.equal(await verifyModels(config), false);
  await writeFile(path.join(config.models, 'm.onnx'), 'foo');
  assert.equal(await verifyModels(config), true);
  await writeFile(path.join(config.models, 'm.onnx'), 'bar');
  assert.equal(await verifyModels(config), false);
  assert.equal(await verifyModels({ ...config, models: '' }), false);
});

async function fakeJob(config, options = {}, files = {}) {
  const dir = await mkdtemp(path.join(config.tmp, 'awwo-analysis-'));
  const input = path.join(dir, 'input.mp4');
  await writeFile(input, fakeMp4());
  for (const [name, value] of Object.entries(files)) await writeFile(path.join(dir, name), JSON.stringify(value));
  const controller = new AbortController();
  const job = { dir, analysisId: 'job_12345', file: { path: input, name: 'ref.mp4' }, options: { lang: 'zh', ocr: true, ocrLang: 'zh', packaging: true, stems: false, review: true, ...options } };
  const logs = [];
  const state = { signal: controller.signal, deadline: Date.now() + 60_000, halted: () => controller.signal.aborted,
    stopped: () => new AnalysisError('aborted', 'The analysis was stopped.'), log: (line) => logs.push(line) };
  return { job, state, controller, logs };
}

test('an analysis returns the public report, the summary and scrubbed outputs', async () => {
  const config = await fakeConfig();
  const { job, state } = await fakeJob(config);
  const result = await runAnalysis(job, config, state);
  assert.equal(result.report.schema, 'rea_video.breakdown.v1');
  assert.equal(result.report.shots, 2);
  assert.equal(result.report.verdict, 'mixed: code 60% + AI video 40%');
  assert.deepEqual(result.report.video, { seconds: 12.5, width: 480, height: 854, fps: 24, aspect: '9:16', sound: true });
  assert.equal(result.report.vlm, 'off');
  assert.ok(result.summary.includes('files: stems/vocals.wav') && !result.summary.includes(job.dir));
  const names = result.outputs.map((output) => output.name);
  assert.deepEqual(names, ['audio.png', 'breakdown.json', 'packaging/subtitles.srt', 'packaging/timeline.json', 'report.html', 'report.md',
    'review_answers.json', 'review_tasks.json', 'shots/shot_001.jpg', 'shots/shot_001_first.jpg', 'storyboard.jpg', 'summary.txt']);
  for (const output of result.outputs) {
    assert.match(output.sha256, /^[0-9a-f]{64}$/);
    assert.ok(!(await readFile(output.path, 'utf8')).includes(job.dir), `${output.name} names the job directory`);
  }
  assert.equal(JSON.parse(await readFile(path.join(job.dir, 'out', 'breakdown.json'), 'utf8')).source.path, 'input.mp4');
  const env = JSON.parse(await readFile(path.join(job.dir, 'out', 'env.json'), 'utf8'));
  const allowed = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'PYTHONDONTWRITEBYTECODE', 'PYTHONUNBUFFERED', 'PYTHONNOUSERSITE', 'REA_VIDEO_HOME', 'REA_VIDEO_MODELS', 'OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS'];
  // macOS adds __CF_USER_TEXT_ENCODING to every process it starts; nothing else may appear.
  assert.deepEqual(Object.keys(env).filter((key) => !allowed.includes(key) && key !== '__CF_USER_TEXT_ENCODING'), []);
  assert.ok(env.REA_VIDEO_HOME.startsWith(job.dir) && env.HOME.startsWith(job.dir));
  assert.equal(env.REA_VIDEO_MODELS, config.models);
  assert.equal(env.OMP_NUM_THREADS, '2');
});

test('stems are outputs only when asked for, and review only runs when asked', async () => {
  const config = await fakeConfig();
  const { job, state } = await fakeJob(config, { stems: true, review: false });
  const names = (await runAnalysis(job, config, state)).outputs.map((output) => output.name);
  assert.ok(names.includes('stems/vocals.wav'));
  assert.ok(!names.includes('review_tasks.json'));
});

test('a video too long, too large or without a picture is refused before rea-video runs', async () => {
  const config = await fakeConfig({ AWWO_ANALYSIS_MAX_SECONDS: '60', AWWO_ANALYSIS_MAX_SIDE: '1920' });
  const cases = [
    [{ format: { duration: '61' }, streams: [{ codec_type: 'video', width: 480, height: 854 }] }, 'too_long'],
    [{ format: { duration: '10' }, streams: [{ codec_type: 'video', width: 3840, height: 2160 }] }, 'too_large'],
    [{ format: { duration: '10' }, streams: [{ codec_type: 'audio' }] }, 'no_video'],
  ];
  for (const [probe, detail] of cases) {
    const { job, state } = await fakeJob(config, {}, { 'probe.json': probe });
    await assert.rejects(runAnalysis(job, config, state), (error) => error instanceof AnalysisError && error.status === 400 && error.detail === detail, detail);
    await assert.rejects(readFile(path.join(job.dir, 'out', 'args.json')), 'rea-video ran');
  }
});

test('a failing rea-video is the worker\'s own error, its stderr only in the log', async () => {
  const config = await fakeConfig();
  const { job, state, logs } = await fakeJob(config, {}, { 'fake.json': { fail: true } });
  await assert.rejects(runAnalysis(job, config, state), (error) => error instanceof AnalysisError && error.detail === 'analysis_failed' && !error.message.includes(job.dir));
  assert.ok(logs.some((line) => line.includes('Traceback')));
  const missing = await fakeJob(config, {}, { 'fake.json': { noBreakdown: true } });
  await assert.rejects(runAnalysis(missing.job, config, missing.state), (error) => error.detail === 'analysis_failed');
});

test('stopping the job stops rea-video at once', async () => {
  const config = await fakeConfig();
  const { job, state, controller } = await fakeJob(config, {}, { 'fake.json': { sleepMs: 30_000 } });
  const started = Date.now();
  setTimeout(() => controller.abort(), 300);
  await assert.rejects(runAnalysis(job, config, state), (error) => error.detail === 'aborted');
  assert.ok(Date.now() - started < 10_000, 'the child was not stopped');
});
