import assert from 'node:assert/strict';
import test from 'node:test';
import {
  childEnv, contactArgs, contactStep, encodeArgs, findExecutable, gifArgs, gifRate, parseProbe, probeArgs, runProcess, writeChunk,
} from './ffmpeg.mjs';

test('encode arguments', () => {
  assert.deepEqual(encodeArgs({ fps: 24, output: '/tmp/r/motion.mp4' }), [
    '-y', '-f', 'image2pipe', '-framerate', '24', '-c:v', 'png', '-i', '-',
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
    '-crf', '18', '-preset', 'medium', '-movflags', '+faststart', '-an', '/tmp/r/motion.mp4',
  ]);
});

test('contact sheet arguments: K = max(1, floor(N / 12))', () => {
  assert.deepEqual([contactStep(1), contactStep(11), contactStep(12), contactStep(25), contactStep(1800)], [1, 1, 1, 2, 150]);
  assert.deepEqual(contactArgs({ input: 'in.mp4', frames: 240, output: 'sheet.png' }), [
    '-y', '-i', 'in.mp4', '-vf', "select='not(mod(n\\,20))',scale=400:-1,tile=4x3", '-frames:v', '1', 'sheet.png',
  ]);
  assert.equal(contactArgs({ input: 'a', frames: 12, output: 'b' })[4], "select='not(mod(n\\,1))',scale=400:-1,tile=4x3");
});

test('GIF rate: the render rate up to 350 frames, then floor(350 / seconds)', () => {
  assert.deepEqual(gifRate({ frames: 350, fps: 35, seconds: 10 }), { fps: 35, reduced: false });
  assert.deepEqual(gifRate({ frames: 600, fps: 30, seconds: 20 }), { fps: 17, reduced: true });
  assert.deepEqual(gifRate({ frames: 1200, fps: 60, seconds: 20 }), { fps: 17, reduced: true });
  assert.deepEqual(gifRate({ frames: 351, fps: 60, seconds: 5.85 }), { fps: 59, reduced: true });
});

test('GIF arguments loop forever or play once', () => {
  const graph = "fps=12,scale='min(1200,iw)':-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle";
  assert.deepEqual(gifArgs({ input: 'in.mp4', fps: 12, loop: true, output: 'out.gif' }), ['-y', '-i', 'in.mp4', '-vf', graph, '-loop', '0', 'out.gif']);
  assert.deepEqual(gifArgs({ input: 'in.mp4', fps: 12, loop: false, output: 'out.gif' }), ['-y', '-i', 'in.mp4', '-vf', graph, '-loop', '-1', 'out.gif']);
});

test('probe arguments and parsing', () => {
  assert.deepEqual(probeArgs('m.mp4'), ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries',
    'stream=nb_read_frames,width,height', '-show_entries', 'format=duration', '-of', 'json', 'm.mp4']);
  const stdout = JSON.stringify({ streams: [{ width: 160, height: 90, nb_read_frames: '12' }], format: { duration: '1.000000' } });
  assert.deepEqual(parseProbe(Buffer.from(stdout)), { frames: 12, width: 160, height: 90, duration: 1 });
  assert.throws(() => parseProbe('{"streams":[]}'));
  assert.throws(() => parseProbe('not json'));
});

test('childEnv keeps only the allowlisted variables', () => {
  const env = childEnv({ PATH: '/bin', HOME: '/home/w', LANG: 'C.UTF-8', TEMP: '/t', TMP: '/t', SystemRoot: 'C:\\Windows', AWWO_RENDER_TOKEN: 'secret', AWS_SECRET_ACCESS_KEY: 'k', LD_PRELOAD: 'x', EMPTY: '' });
  assert.deepEqual(env, { PATH: '/bin', SystemRoot: 'C:\\Windows', TEMP: '/t', TMP: '/t', HOME: '/home/w', LANG: 'C.UTF-8' });
});

test('findExecutable: paths and PATH lookup', () => {
  assert.equal(findExecutable(process.execPath), true);
  assert.equal(findExecutable(`${process.execPath}.missing`), false);
  assert.equal(findExecutable(''), false);
  assert.equal(findExecutable('definitely-not-a-command-awwo'), false);
  assert.equal(findExecutable('node', { PATH: process.execPath.replace(/[\\/][^\\/]+$/, ''), PATHEXT: '.EXE' }), true);
});

test('runProcess: no shell, allowlisted env, stdout captured', async () => {
  process.env.AWWO_RENDER_TEST_SECRET = 'must-not-leak';
  try {
    const script = 'process.stdout.write(JSON.stringify({ keys: Object.keys(process.env), arg: process.argv[1] }))';
    const { stdout } = await runProcess(process.execPath, ['-e', script, '$(echo injected); & | "quoted"']);
    const seen = JSON.parse(stdout.toString());
    assert.equal(seen.arg, '$(echo injected); & | "quoted"');
    assert.equal(seen.keys.includes('AWWO_RENDER_TEST_SECRET'), false);
    const allowed = ['PATH', 'SYSTEMROOT', 'TEMP', 'TMP', 'HOME', 'LANG'];
    // On Windows libuv always copies its fixed list of required variables into a child's environment (no secrets).
    if (process.platform === 'win32') allowed.push('HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'SYSTEMDRIVE', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'WINDIR');
    assert.ok(seen.keys.every((key) => allowed.includes(key.toUpperCase())), seen.keys.join(','));
  } finally {
    delete process.env.AWWO_RENDER_TEST_SECRET;
  }
});

test('runProcess: stdin as a Buffer and as a pipe', async () => {
  const echo = 'process.stdin.pipe(process.stdout)';
  assert.equal((await runProcess(process.execPath, ['-e', echo], { stdin: Buffer.from('frames') })).stdout.toString(), 'frames');
  const piped = runProcess(process.execPath, ['-e', echo], { stdin: 'pipe' });
  await writeChunk(piped.stdin, Buffer.from('one '));
  await writeChunk(piped.stdin, Buffer.alloc(1 << 20, 0x61)); // larger than a pipe buffer: waits for drain
  piped.stdin.end();
  const { stdout } = await piped;
  assert.equal(stdout.length, 4 + (1 << 20));
});

test('runProcess: failures carry a code', async () => {
  await assert.rejects(runProcess(process.execPath, ['-e', 'process.stderr.write("bad"); process.exit(3)']),
    (error) => error.code === 'PROCESS_FAILED' && error.exitCode === 3 && error.stderr === 'bad');
  await assert.rejects(runProcess('definitely-not-a-command-awwo', []), (error) => error.code === 'PROCESS_SPAWN_FAILED');
});

test('runProcess: abort kills the child', async () => {
  const controller = new AbortController();
  const started = Date.now();
  const running = runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(running, (error) => error.code === 'ABORTED');
  assert.ok(Date.now() - started < 5000);
  assert.ok(running.child.killed);
});

test('writeChunk rejects once the child stopped reading', async () => {
  const piped = runProcess(process.execPath, ['-e', 'process.exit(0)'], { stdin: 'pipe' });
  await piped;
  await assert.rejects(async () => {
    for (let index = 0; index < 64; index += 1) await writeChunk(piped.stdin, Buffer.alloc(1 << 20));
  }, (error) => error.code === 'PROCESS_STDIN_CLOSED');
});
