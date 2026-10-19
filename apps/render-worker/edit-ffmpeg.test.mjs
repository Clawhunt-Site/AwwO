import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MP4, WAV, batchArgs, combineArgs, concatArgs, concatList, duckFilter, encodeOptions, inputOptions, inputProbeArgs, loudnessArgs, muxArgs, normalizeArgs,
  parseInputProbe, parseLoudness, pictureFilter, secs, silenceFilter, sniffFormat, soundChain, sourceMatrix, spanArgs, srt, stillsArgs, transitionArgs,
  windowExpression,
} from './edit-ffmpeg.mjs';

const output = { width: 1920, height: 822, fit: 'cover', fps: 24, crf: 18 };
const bytes = (...parts) => Buffer.concat(parts.map((part) => (typeof part === 'string' ? Buffer.from(part, 'latin1') : Buffer.from(part))));

test('seconds are written with at most six decimals and no exponent', () => {
  assert.deepEqual([secs(0), secs(0.5), secs(1 / 3), secs(12.25), secs(1e-9), secs(-0.0000001), secs(1500)], ['0', '0.5', '0.333333', '12.25', '0', '0', '1500']);
});

test('a file is taken only as one of a closed set of containers, read from its own first bytes', () => {
  assert.deepEqual(sniffFormat(bytes([0, 0, 0, 0x18], 'ftypisom', [0, 0, 2, 0])), { demuxer: 'mov', ext: 'mp4' });
  assert.deepEqual(sniffFormat(bytes([0x1a, 0x45, 0xdf, 0xa3], 'webm')), { demuxer: 'matroska', ext: 'webm' });
  assert.deepEqual(sniffFormat(bytes('RIFF', [1, 2, 3, 4], 'WAVEfmt ')), { demuxer: 'wav', ext: 'wav' });
  assert.deepEqual(sniffFormat(bytes('ID3', [4, 0, 0])), { demuxer: 'mp3', ext: 'mp3' });
  assert.deepEqual(sniffFormat(bytes([0xff, 0xfb, 0x90, 0x64])), { demuxer: 'mp3', ext: 'mp3' });
  assert.deepEqual(sniffFormat(bytes('OggS', [0, 2])), { demuxer: 'ogg', ext: 'ogg' });
  assert.deepEqual(sniffFormat(bytes('fLaC', [0])), { demuxer: 'flac', ext: 'flac' });
  assert.deepEqual(sniffFormat(bytes([0x89], 'PNG\r\n\x1a\n', [0])), { demuxer: 'image2', ext: 'png', still: true });
  assert.deepEqual(sniffFormat(bytes([0xff, 0xd8, 0xff, 0xe0])), { demuxer: 'image2', ext: 'jpg', still: true });
  assert.deepEqual(sniffFormat(bytes('RIFF', [1, 2, 3, 4], 'WEBPVP8 ')), { demuxer: 'image2', ext: 'webp', still: true });
  assert.deepEqual(sniffFormat(bytes('GIF89a')), { demuxer: 'gif', ext: 'gif', still: true }, 'a GIF is a picture: its first frame, held');
  for (const other of ['#EXTM3U\n#EXTINF:1,\nfile:///etc/passwd\n', 'ffconcat version 1.0\nfile x\n', 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n', '<?xml version="1.0"?><MPD>', 'RIFF\x00\x00\x00\x00AVI LIST', '']) {
    assert.equal(sniffFormat(bytes(other)), null, JSON.stringify(other.slice(0, 20)));
  }
});

test('every input is opened as its container only, from local files, without external references, on two threads', () => {
  assert.deepEqual(inputOptions(MP4), ['-protocol_whitelist', 'file', '-f', 'mov', '-enable_drefs', '0', '-use_absolute_path', '0', '-threads', '2']);
  assert.deepEqual(inputOptions(WAV), ['-protocol_whitelist', 'file', '-f', 'wav', '-threads', '2']);
  assert.deepEqual(inputOptions({ demuxer: 'image2', ext: 'png', still: true }), ['-protocol_whitelist', 'file', '-f', 'image2', '-pattern_type', 'none', '-threads', '2'],
    'a still is read once, never looped');
  assert.deepEqual(inputProbeArgs('in-000.mp4', MP4), ['-v', 'error', ...inputOptions(MP4), '-show_entries', 'stream=index,codec_type,width,height,avg_frame_rate,sample_rate,channels,color_space:stream_disposition=attached_pic',
    '-show_entries', 'format=duration', '-of', 'json', '-i', 'in-000.mp4']);
  for (const args of [concatArgs({ list: 'l', file: 'f' }), muxArgs({ video: 'v', audio: 'a', file: 'f' }), stillsArgs({ input: 'i', every: 8, max: 2, pattern: 'p' }),
    loudnessArgs({ input: 'mix.wav' }), normalizeArgs({ input: 'p', measured: { i: -20, tp: -3, lra: 4, thresh: -30, offset: 0 }, targetLUFS: -16, truePeakDb: -1, seconds: 4, file: 'm' })]) {
    for (let at = args.indexOf('-i'); at >= 0; at = args.indexOf('-i', at + 1)) {
      const before = args.slice(0, at);
      assert.equal(before.lastIndexOf('-protocol_whitelist') >= 0 && before.lastIndexOf('-f') > before.lastIndexOf('-i'), true, `pinned input in ${args.join(' ')}`);
    }
  }
});

test('probing an input reads its streams (by index) and duration; a still has none of its own', () => {
  const clip = JSON.stringify({ streams: [{ index: 0, codec_type: 'video', width: 960, height: 960, avg_frame_rate: '24/1', color_space: 'bt709' }, { index: 1, codec_type: 'audio', sample_rate: '44100', channels: 2 }], format: { duration: '5.061950' } });
  assert.deepEqual(parseInputProbe(clip), { duration: 5.06195, still: false, video: { index: 0, width: 960, height: 960, fps: 24, colorSpace: 'bt709' }, audio: { index: 1, sampleRate: 44100, channels: 2 } });
  const picture = JSON.stringify({ streams: [{ index: 0, codec_type: 'video', width: 320, height: 180, avg_frame_rate: '25/1' }], format: { duration: '0.04' } });
  assert.deepEqual(parseInputProbe(picture, { still: true }), { duration: Number.POSITIVE_INFINITY, still: true, video: { index: 0, width: 320, height: 180, fps: 25, colorSpace: null }, audio: null });
  const song = JSON.stringify({ streams: [{ index: 0, codec_type: 'audio', sample_rate: '48000', channels: 1 }, { index: 1, codec_type: 'video', width: 0 }], format: { duration: '12' } });
  assert.deepEqual(parseInputProbe(song).video, null, 'cover art without a size is not a picture');
  // A file whose first video stream is cover art: the picture is the later stream, and that is the index decoded.
  const covered = JSON.stringify({ streams: [{ index: 0, codec_type: 'video', width: 600, height: 600, disposition: { attached_pic: 1 } },
    { index: 1, codec_type: 'video', width: 1280, height: 720, avg_frame_rate: '30/1' }, { index: 2, codec_type: 'audio', sample_rate: '48000', channels: 2 }], format: { duration: '8' } });
  assert.deepEqual([parseInputProbe(covered).video.index, parseInputProbe(covered).audio.index], [1, 2]);
  assert.throws(() => parseInputProbe(JSON.stringify({ streams: [], format: {} })));
  assert.throws(() => parseInputProbe(JSON.stringify({ streams: [], format: {} }), { still: true }));
});

test('pictures are fitted, set to the film rate, pixel format and colour, and encoded one way for every piece', () => {
  const colour = 'setparams=range=tv:colorspace=bt709:color_primaries=bt709:color_trc=bt709';
  assert.equal(pictureFilter(output), 'fps=24,scale=1920:822:force_original_aspect_ratio=increase:flags=lanczos:in_color_matrix=auto:out_color_matrix=bt709:out_range=tv,'
    + `crop=1920:822,setsar=1,format=yuv420p,${colour}`);
  assert.equal(pictureFilter({ ...output, fit: 'contain' }, { matrix: 'bt601' }),
    'fps=24,scale=1920:822:force_original_aspect_ratio=decrease:flags=lanczos:in_color_matrix=bt601:out_color_matrix=bt709:out_range=tv,'
    + `pad=1920:822:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p,${colour}`);
  assert.deepEqual(encodeOptions(output), ['-c:v', 'libx264', '-profile:v', 'high', '-preset', 'medium', '-crf', '18', '-g', '48',
    '-sc_threshold', '0', '-video_track_timescale', '24000', '-threads', '2', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
    '-color_range', 'tv', '-chroma_sample_location', 'left', '-an']);
  // The matrix each side is converted from: the file's own when it says, the worker's knowledge, a player's assumption.
  const png = { demuxer: 'image2', ext: 'png', still: true };
  assert.deepEqual([sourceMatrix({ format: png }), sourceMatrix({ format: { ...png, ext: 'webp' } }), sourceMatrix({ format: MP4, card: true }),
    sourceMatrix({ format: MP4, video: { colorSpace: 'bt470bg', height: 1080 } }), sourceMatrix({ format: MP4, video: { colorSpace: 'unknown', height: 1080 } }),
    sourceMatrix({ format: MP4, video: { colorSpace: null, width: 640, height: 480 } }), sourceMatrix({ format: MP4, video: { colorSpace: null, width: 1280, height: 536 } })],
  ['auto', 'bt601', 'bt601', 'auto', 'bt709', 'bt601', 'bt709']);
  assert.deepEqual(encodeOptions({ ...output, maxKbps: 1800 }).slice(8, 12), ['-maxrate', '1800k', '-bufsize', '1800k'], 'a size cap becomes a peak rate, a one-second buffer');
  const span = spanArgs({ source: 'in-000.mp4', format: MP4, stream: '1', matrix: 'bt709', start: 0.2, frames: 84, output, file: 'piece-0000.mp4' });
  assert.match(span[span.indexOf('-vf') + 1], /:in_color_matrix=bt709:out_color_matrix=bt709:out_range=tv,/, 'the side is converted from its own matrix');
  assert.deepEqual(span.slice(0, 19), ['-y', '-v', 'error', ...inputOptions(MP4), '-ss', '0.2', '-i', 'in-000.mp4', '-map', '0:1'], 'the measured stream is the one decoded');
  assert.match(span[span.indexOf('-vf') + 1], /^fps=24,.*,tpad=stop_mode=clone:stop=84$/);
  assert.equal(spanArgs({ source: 'card-000.mp4', format: MP4, start: 0, frames: 12, output, file: 'p.mp4' }).includes('0:v:0'), true, 'a card is the worker\'s own MP4');
  const held = spanArgs({ source: 'in-003.png', format: { demuxer: 'image2', ext: 'png', still: true }, stream: '0', start: 0, frames: 48, output, file: 'p.mp4' });
  assert.equal(held.includes('-ss') || held.includes('-loop'), false, 'a still is neither seeked nor looped');
  assert.match(held[held.indexOf('-vf') + 1], /^trim=end_frame=1,fps=24:eof_action=pass,.*,tpad=stop_mode=clone:stop=48$/,
    'its one frame is decoded once, passed on by the rate however short it lasts, and held');
  assert.equal(span.at(-1), 'piece-0000.mp4');
});

test('a transition piece mixes the two sides with xfade for exactly its frames, each side its own measured picture stream', () => {
  const png = { demuxer: 'image2', ext: 'png', still: true };
  const args = transitionArgs({ a: { source: 'in-000.mp4', format: MP4, stream: '0', start: 3.7 }, b: { source: 'in-001.png', format: png, stream: '0', start: 0 }, frames: 12, kind: 'fadeblack', output, file: 'piece-0001.mp4' });
  assert.deepEqual(args.slice(3, 17), [...inputOptions(MP4), '-ss', '3.7', '-i', 'in-000.mp4']);
  assert.deepEqual(args.slice(17, 27), [...inputOptions(png), '-i', 'in-001.png'], 'the picture side is read once, not seeked');
  const graph = args[args.indexOf('-filter_complex') + 1];
  assert.match(graph, /^\[0:0\]fps=24,.*trim=end_frame=12,setpts=PTS-STARTPTS\[a\];\[1:0\]trim=end_frame=1,fps=24:eof_action=pass,.*\[b\];\[a\]\[b\]xfade=transition=fadeblack:duration=0\.5:offset=0,tpad=stop_mode=clone:stop=12,format=yuv420p\[v\]$/);
  assert.equal(args[args.indexOf('-frames:v') + 1], '12');
});

test('the concat list names the pieces next to it, read in safe mode from local files', () => {
  assert.equal(concatList(['piece-0000.mp4', 'piece-0001.mp4']), "ffconcat version 1.0\nfile 'piece-0000.mp4'\nfile 'piece-0001.mp4'\n");
  assert.deepEqual(concatArgs({ list: 'pieces.ffconcat', file: 'picture.mp4' }), ['-y', '-v', 'error', '-protocol_whitelist', 'file', '-f', 'concat', '-safe', '1',
    '-i', 'pieces.ffconcat', '-map', '0:v:0', '-c', 'copy', '-an', '-movflags', '+faststart', 'picture.mp4']);
});

test('a sound is decoded only for its part, levelled, faded and delayed to the sample', () => {
  const entry = { in: 1.5, length: 1.6, gainDb: -3.5, fx: 'room', fadeIn: 0.2, fadeOut: 0.3, at: 3.9 };
  assert.equal(soundChain(entry, 2, 's2'), '[2:a:0]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,atrim=duration=1.6,asetpts=PTS-STARTPTS,'
    + 'volume=-3.5dB,aecho=0.8:0.6:30|47:0.25|0.18,afade=t=in:st=0:d=0.2,afade=t=out:st=1.3:d=0.3,adelay=delays=187200S:all=1[s2]');
  assert.doesNotMatch(soundChain({ ...entry, fx: 'dry', fadeIn: 0, fadeOut: 0 }, 0, 's0'), /aecho|afade/);
  assert.match(soundChain({ ...entry, stream: '2' }, 1, 's1'), /^\[1:2\]aformat=/, 'the measured sound stream is the one decoded');
});

test('a track keeps one stem: each batch of sounds is summed with the stem so far; a loop input repeats', () => {
  const mp3 = { demuxer: 'mp3', ext: 'mp3' };
  const entries = [{ file: 'a.mp3', format: mp3, in: 0.5, length: 2, gainDb: 0, fx: 'dry', fadeIn: 0, fadeOut: 0, at: 1, loop: false },
    { file: 'b.wav', format: WAV, in: 0, length: 9, gainDb: -6, fx: 'dry', fadeIn: 1, fadeOut: 0, at: 0, loop: true }];
  const args = batchArgs({ entries, previous: 'stem-sfx-0.wav', seconds: 10, file: 'stem-sfx-1.wav' });
  assert.deepEqual(args.slice(3, 15), [...inputOptions(mp3), '-ss', '0.5', '-t', '2', '-i', 'a.mp3']);
  assert.deepEqual(args.slice(15, 29), [...inputOptions(WAV), '-stream_loop', '-1', '-ss', '0', '-t', '9', '-i', 'b.wav']);
  assert.deepEqual(args.slice(29, 37), [...inputOptions(WAV), '-i', 'stem-sfx-0.wav']);
  assert.match(args[args.indexOf('-filter_complex') + 1], /\[s0\]\[s1\]\[2:a:0\]amix=inputs=3:normalize=0:duration=longest:dropout_transition=0,apad=whole_dur=10,atrim=end=10\[out\]$/);
  const single = batchArgs({ entries: entries.slice(0, 1), seconds: 4, file: 'x.wav' });
  assert.match(single[single.indexOf('-filter_complex') + 1], /\[s0\]anull,apad=whole_dur=4,atrim=end=4\[out\]$/);
});

test('ducking is a gain envelope over the dialogue windows; silence mutes; both only on music and sfx', () => {
  const ducking = { music: -9, sfx: -6, attack: 0.12, release: 0.5 };
  assert.equal(windowExpression([{ start: 3, end: 5 }], 0.12, 0.5), 'clip((t-2.88)/0.12,0,1)*clip((5.5-t)/0.5,0,1)');
  assert.equal(duckFilter([{ start: 3, end: 5 }], -9, ducking), "volume='pow(10,(-9*(clip((t-2.88)/0.12,0,1)*clip((5.5-t)/0.5,0,1)))/20)':eval=frame");
  assert.equal(duckFilter([], -9, ducking), null);
  assert.equal(duckFilter([{ start: 3, end: 5 }], -9, null), null);
  assert.equal(silenceFilter([{ start: 9.4, end: 10 }]), "volume='max(0,1-(clip((t-9.39)/0.01,0,1)*clip((10.01-t)/0.01,0,1)))':eval=frame");
  const args = combineArgs({ stems: [{ track: 'dialogue', file: 'd.wav' }, { track: 'music', file: 'm.wav' }], windows: [{ start: 3, end: 5 }], ducking, silence: [], seconds: 10, file: 'premix.wav' });
  const graph = args[args.indexOf('-filter_complex') + 1];
  assert.match(graph, /^\[0:a:0\]anull\[t0\];\[1:a:0\]anull,volume='pow\(10,\(-9\*/);
});

test('loudness: measured, read back, then applied in a second pass', () => {
  assert.deepEqual(loudnessArgs({ input: 'premix.wav', targetLUFS: -16, truePeakDb: -1 }),
    ['-hide_banner', '-nostats', ...inputOptions(WAV), '-i', 'premix.wav', '-map', '0:a:0', '-af', 'loudnorm=I=-16:TP=-1:LRA=11:print_format=json', '-f', 'null', '-']);
  const mp4 = loudnessArgs({ input: 'in-002.mp4', format: MP4, stream: '1' });
  assert.equal(mp4[mp4.indexOf('-map') + 1], '0:1', 'a file of its own is measured on its measured sound stream');
  const stderr = 'noise\n[Parsed_loudnorm_0 @ 0x1]\n{\n\t"input_i" : "-26.28",\n\t"input_tp" : "-19.91",\n\t"input_lra" : "5.10",\n\t"input_thresh" : "-36.28",\n\t"output_i" : "-16.18",\n\t"target_offset" : "0.18"\n}\n';
  const measured = parseLoudness(stderr);
  assert.deepEqual(measured, { i: -26.28, tp: -19.91, lra: 5.1, thresh: -36.28, offset: 0.18 });
  assert.equal(parseLoudness('{"input_i":"-inf","input_tp":"-inf","input_lra":"0.00","input_thresh":"-70.00","target_offset":"0.00"}').i, Number.NEGATIVE_INFINITY);
  assert.throws(() => parseLoudness('nothing'));
  const args = normalizeArgs({ input: 'premix.wav', measured, targetLUFS: -16, truePeakDb: -1, seconds: 10, file: 'mix.wav' });
  assert.match(args[args.indexOf('-af') + 1], /^loudnorm=I=-16:TP=-1:LRA=11:measured_I=-26\.28:measured_TP=-19\.91:measured_LRA=5\.1:measured_thresh=-36\.28:offset=0\.18:linear=true:print_format=none,aresample=48000,apad=whole_dur=10,atrim=end=10$/);
});

test('mux, stills and subtitles', () => {
  assert.deepEqual(muxArgs({ video: 'picture.mp4', audio: 'mix.wav', file: 'R1.mp4' }), ['-y', '-v', 'error', ...inputOptions(MP4), '-i', 'picture.mp4', ...inputOptions(WAV), '-i', 'mix.wav',
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', 'R1.mp4']);
  assert.deepEqual(stillsArgs({ input: 'R1.mp4', every: 8, max: 3, pattern: 'still-%03d.jpg' }), ['-y', '-v', 'error', ...inputOptions(MP4), '-i', 'R1.mp4', '-map', '0:v:0',
    '-vf', 'fps=1/8,scale=960:-2:in_color_matrix=bt709:in_range=tv:out_color_matrix=bt601:out_range=pc', '-frames:v', '3', '-q:v', '3', 'still-%03d.jpg']);
  assert.equal(srt([{ start: 3.9, end: 5.7, text: "It's louder today." }, { start: 3725.0005, end: 3726, text: 'Two\nlines' }]),
    "1\n00:00:03,900 --> 00:00:05,700\nIt's louder today.\n\n2\n01:02:05,001 --> 01:02:06,000\nTwo\nlines\n");
});

test("a song's cover art is no picture, and the second loudness pass takes only the values loudnorm accepts", () => {
  const song = JSON.stringify({ streams: [{ codec_type: 'audio', sample_rate: '44100', channels: 2 }, { codec_type: 'video', width: 600, height: 600, disposition: { attached_pic: 1 } }], format: { duration: '180' } });
  assert.equal(parseInputProbe(song).video, null);
  const loud = normalizeArgs({ input: 'p.wav', measured: { i: 3.2, tp: 120, lra: -1, thresh: 2, offset: -150 }, targetLUFS: -16, truePeakDb: -1, seconds: 2, file: 'm.wav' });
  assert.match(loud[loud.indexOf('-af') + 1], /measured_I=0:measured_TP=99:measured_LRA=0:measured_thresh=0:offset=-99:/);
});
