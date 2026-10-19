// The exact ffmpeg and ffprobe argument lists of an edit (pure, tested as arrays). Picture: every piece encoded
// once at the film's settings, frame-exact, so the pieces join by stream copy. Sound: one stem per track, mixed in
// batches, the music and sfx ducked by an envelope computed from the dialogue's own times, then two-pass loudness.
// Every file is opened through inputOptions: its container pinned to the one its first bytes show (sniffFormat, a
// closed table), local files only, its own first stream of the kind used, at most two decoder threads; so no file's
// contents can make ffmpeg open another file or a URL (a playlist, a list, an external reference).

export const SAMPLE_RATE = 48000;
export const BATCH_INPUTS = 48;
const STILL_WIDTH = 960;
const FADE_SECONDS = 0.01;
const THREADS = '2';

/** Seconds as ffmpeg reads them: at most 6 decimals, no exponent, no trailing zeros. */
export function secs(value) {
  const text = (Math.round(value * 1e6) / 1e6).toFixed(6).replace(/\.?0+$/, '');
  return text === '-0' ? '0' : text;
}

/**
 * The containers an edit takes, by their first bytes; anything else is refused. ext names the file on the worker's
 * disk (a picture's decoder is chosen by it); still: one picture, held as long as the timeline says.
 */
export function sniffFormat(head) {
  const bytes = Buffer.from(head ?? []);
  const at = (offset, text) => bytes.subarray(offset, offset + text.length).toString('latin1') === text;
  if (bytes.length >= 12 && at(4, 'ftyp')) return { demuxer: 'mov', ext: 'mp4' };
  if (bytes.length >= 4 && bytes.readUInt32BE(0) === 0x1a45dfa3) return { demuxer: 'matroska', ext: 'webm' };
  if (at(0, 'RIFF') && at(8, 'WAVE')) return { demuxer: 'wav', ext: 'wav' };
  if (at(0, 'OggS')) return { demuxer: 'ogg', ext: 'ogg' };
  if (at(0, 'fLaC')) return { demuxer: 'flac', ext: 'flac' };
  if (at(0, 'ID3') || (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe6) === 0xe2)) return { demuxer: 'mp3', ext: 'mp3' };
  if (at(0, '\x89PNG\r\n\x1a\n')) return { demuxer: 'image2', ext: 'png', still: true };
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { demuxer: 'image2', ext: 'jpg', still: true };
  if (at(0, 'RIFF') && at(8, 'WEBP')) return { demuxer: 'image2', ext: 'webp', still: true };
  if (at(0, 'GIF87a') || at(0, 'GIF89a')) return { demuxer: 'gif', ext: 'gif', still: true };
  return null;
}

/** The files the worker makes itself: its card and piece MP4s, and its sound stems and mixes. */
export const MP4 = Object.freeze({ demuxer: 'mov' });
export const WAV = Object.freeze({ demuxer: 'wav' });

/**
 * The options before `-i` for one file of a known container: local files only, that demuxer and no other (an MP4
 * may not follow external references), two decoder threads. A still is decoded once; its piece holds the frame.
 */
export function inputOptions(format) {
  const options = ['-protocol_whitelist', 'file', '-f', format.demuxer];
  if (format.demuxer === 'mov') options.push('-enable_drefs', '0', '-use_absolute_path', '0');
  if (format.demuxer === 'image2') options.push('-pattern_type', 'none');
  options.push('-threads', THREADS);
  return options;
}

export function inputProbeArgs(file, format) {
  return ['-v', 'error', ...inputOptions(format), '-show_entries', 'stream=index,codec_type,width,height,avg_frame_rate,sample_rate,channels,color_space:stream_disposition=attached_pic',
    '-show_entries', 'format=duration', '-of', 'json', '-i', file];
}

/**
 * ffprobe's JSON → {duration, video: {index, width, height, fps, colorSpace} | null, audio: {index, sampleRate, channels} | null};
 * a still picture has no duration of its own (Infinity: it is shown as long as the timeline says). The indexes are the
 * streams the edit decodes later, so it shows and plays what was measured here (an earlier stream may be cover art).
 */
export function parseInputProbe(stdout, { still = false } = {}) {
  const parsed = JSON.parse(String(stdout));
  const streams = Array.isArray(parsed?.streams) ? parsed.streams : [];
  // A song's cover art is a video stream marked attached_pic: not a picture the edit shows.
  const picture = streams.find((stream) => stream.codec_type === 'video' && Number(stream.width) > 0 && Number(stream.disposition?.attached_pic) !== 1);
  const sound = streams.find((stream) => stream.codec_type === 'audio');
  const duration = still ? Number.POSITIVE_INFINITY : Number(parsed?.format?.duration);
  if (!(duration > 0) || (still && !picture)) throw new Error('ffprobe found no duration or picture');
  const rate = (text) => {
    const [num, den] = String(text ?? '').split('/').map(Number);
    return den > 0 && num > 0 ? num / den : null;
  };
  return {
    duration,
    still,
    video: picture ? {
      index: Number(picture.index), width: Number(picture.width), height: Number(picture.height), fps: rate(picture.avg_frame_rate),
      colorSpace: typeof picture.color_space === 'string' ? picture.color_space : null,
    } : null,
    audio: sound && !still ? { index: Number(sound.index), sampleRate: Number(sound.sample_rate) || null, channels: Number(sound.channels) || null } : null,
  };
}

// Every piece is in one colour description, so a film joined by stream copy has one (and a player shows each piece as
// it was made): BT.709, limited range, chroma sited left.
const FILM_COLOUR = 'setparams=range=tv:colorspace=bt709:color_primaries=bt709:color_trc=bt709';
const FILM_COLOUR_TAGS = Object.freeze(['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv', '-chroma_sample_location', 'left']);
const UNTAGGED = new Set(['unknown', 'unspecified', 'reserved', 'gbr']);

/**
 * The matrix a side's pixels are in, for scale's in_color_matrix: what the file says (auto), else what the worker knows
 * (a card it rendered, and a WebP: BT.601, as swscale and VP8 make them; a lossless WebP is RGB and has none), else what
 * a player assumes of an untagged stream (BT.709 when it is HD: 1280 wide or more, or taller than 576, as mpv decides;
 * BT.601 below), so the film shows a clip as the clip itself shows. PNG and GIF are RGB, and a JPEG says BT.601.
 */
export function sourceMatrix({ format, card = false, video = null }) {
  if (card || format.ext === 'webp') return 'bt601';
  if (format.still) return 'auto';
  if (video?.colorSpace && !UNTAGGED.has(video.colorSpace)) return 'auto';
  return (video?.width ?? 0) >= 1280 || (video?.height ?? 0) > 576 ? 'bt709' : 'bt601';
}

/**
 * Scale into the frame: cover fills and crops, contain fits inside black bars; then the film's rate, its pixels and its
 * colour (converted from `matrix`, the side's own: sourceMatrix). A still's one frame ends its stream a frame of its own
 * later (1/25 s for an image, its delay for a GIF), which the rate's rounding can make no frame at all (1/25 s at
 * 12 fps): the rate passes it on (eof_action=pass), for tpad to hold.
 */
export function pictureFilter({ width, height, fit, fps }, { still = false, matrix = 'auto' } = {}) {
  const scale = `flags=lanczos:in_color_matrix=${matrix}:out_color_matrix=bt709:out_range=tv`;
  const fitted = fit === 'contain'
    ? `scale=${width}:${height}:force_original_aspect_ratio=decrease:${scale},pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`
    : `scale=${width}:${height}:force_original_aspect_ratio=increase:${scale},crop=${width}:${height}`;
  return `fps=${fps}${still ? ':eof_action=pass' : ''},${fitted},setsar=1,format=yuv420p,${FILM_COLOUR}`;
}

/**
 * One encoder setting for every piece, so the concat demuxer can join them by stream copy; with maxKbps, a peak
 * rate that keeps the film under the size the API stores (a one-second buffer, which each piece may start with full:
 * filmRateCap counts it once for every piece).
 */
export function encodeOptions({ fps, crf, maxKbps }) {
  const cap = maxKbps ? ['-maxrate', `${maxKbps}k`, '-bufsize', `${maxKbps}k`] : [];
  return ['-c:v', 'libx264', '-profile:v', 'high', '-preset', 'medium', '-crf', String(crf), ...cap, '-g', String(fps * 2),
    '-sc_threshold', '0', '-video_track_timescale', String(fps * 1000), '-threads', THREADS, ...FILM_COLOUR_TAGS, '-an'];
}

/** Where one side of a piece reads from: a clip from its time (seeked), a still from its one picture. */
function sideInput(side) {
  if (side.format.still) return [...inputOptions(side.format), '-i', side.source];
  return [...inputOptions(side.format), '-ss', secs(side.start), '-i', side.source];
}

/** One side's picture: a still's first frame only (decoded once), scaled into the frame and held to `frames`. */
function sideFilter(side, output, frames) {
  const still = Boolean(side.format.still);
  return `${still ? 'trim=end_frame=1,' : ''}${pictureFilter(output, { still, matrix: side.matrix ?? 'auto' })},tpad=stop_mode=clone:stop=${frames}`;
}

/**
 * A run of frames of one item: from its source time, frame-exact (the last frame held if the source falls short);
 * `stream` is the stream the probe measured (an index), or v:0 for the worker's own card MP4s; `matrix` its pixels'.
 */
export function spanArgs({ source, format, stream = 'v:0', matrix = 'auto', start, frames, output, file }) {
  return ['-y', '-v', 'error', ...sideInput({ source, format, start }), '-map', `0:${stream}`, '-frames:v', String(frames),
    '-vf', sideFilter({ format, matrix }, output, frames), ...encodeOptions(output), file];
}

/** A transition piece: the last frames of A and the first of B mixed by xfade (fade, or fadeblack for a dip). */
export function transitionArgs({ a, b, frames, kind, output, file }) {
  const side = (input, from) => `[${input}:${from.stream ?? 'v:0'}]${sideFilter(from, output, frames)},trim=end_frame=${frames},setpts=PTS-STARTPTS`;
  const graph = `${side(0, a)}[a];${side(1, b)}[b];[a][b]xfade=transition=${kind}:duration=${secs(frames / output.fps)}:offset=0,`
    + `tpad=stop_mode=clone:stop=${frames},format=yuv420p[v]`;
  return ['-y', '-v', 'error', ...sideInput(a), ...sideInput(b),
    '-filter_complex', graph, '-map', '[v]', '-frames:v', String(frames), ...encodeOptions(output), file];
}

/** The concat demuxer's list: piece names only (they sit next to the list, so the demuxer's safe mode holds). */
export function concatList(names) {
  return `ffconcat version 1.0\n${names.map((name) => `file '${name}'`).join('\n')}\n`;
}

export function concatArgs({ list, file }) {
  return ['-y', '-v', 'error', '-protocol_whitelist', 'file', '-f', 'concat', '-safe', '1', '-i', list, '-map', '0:v:0', '-c', 'copy', '-an', '-movflags', '+faststart', file];
}

export function packetCountArgs(file) {
  return ['-v', 'error', ...inputOptions(MP4), '-select_streams', 'v:0', '-count_packets', '-show_entries', 'stream=nb_read_packets,width,height',
    '-show_entries', 'format=duration,size', '-of', 'json', '-i', file];
}

export function parsePacketCount(stdout) {
  const parsed = JSON.parse(String(stdout));
  const stream = parsed?.streams?.[0] ?? {};
  return { frames: Number(stream.nb_read_packets), width: Number(stream.width), height: Number(stream.height), duration: Number(parsed?.format?.duration), size: Number(parsed?.format?.size) };
}

const FX = Object.freeze({
  dry: '',
  room: 'aecho=0.8:0.6:30|47:0.25|0.18',
  hall: 'aecho=0.8:0.7:60|90|120:0.3|0.22|0.15',
  radio: 'highpass=f=300,lowpass=f=3400',
  echo: 'aecho=0.8:0.5:250|500:0.35|0.2',
});

/**
 * One sound's chain from its (already seeked and cut) input, ending at its place on the film (sample-exact delay);
 * entry.stream is the sound stream the probe measured.
 */
export function soundChain(entry, input, label) {
  const parts = [`[${input}:${entry.stream ?? 'a:0'}]aformat=sample_fmts=fltp:sample_rates=${SAMPLE_RATE}:channel_layouts=stereo`,
    `atrim=duration=${secs(entry.length)}`, 'asetpts=PTS-STARTPTS', `volume=${secs(entry.gainDb)}dB`];
  if (FX[entry.fx]) parts.push(FX[entry.fx]);
  if (entry.fadeIn > 0) parts.push(`afade=t=in:st=0:d=${secs(Math.min(entry.fadeIn, entry.length))}`);
  if (entry.fadeOut > 0) {
    const fade = Math.min(entry.fadeOut, entry.length);
    parts.push(`afade=t=out:st=${secs(entry.length - fade)}:d=${secs(fade)}`);
  }
  parts.push(`adelay=delays=${Math.round(entry.at * SAMPLE_RATE)}S:all=1`);
  return `${parts.join(',')}[${label}]`;
}

/** One sound's input: decoded only from its in, for its length (a loop repeats the whole file from there on). */
function soundInput(entry) {
  return [...inputOptions(entry.format), ...(entry.loop ? ['-stream_loop', '-1'] : []), '-ss', secs(entry.in), '-t', secs(entry.length), '-i', entry.file];
}

/**
 * One batch of a track's sounds (≤ 48) summed into the track's stem of the film's exact length; `previous` (the stem
 * of the batches before) is summed in too, so a track keeps one stem on disk however many sounds it has.
 */
export function batchArgs({ entries, previous, seconds, file }) {
  const inputs = [...entries.flatMap(soundInput), ...(previous ? [...inputOptions(WAV), '-i', previous] : [])];
  const chains = entries.map((entry, index) => soundChain(entry, index, `s${index}`));
  const labels = entries.map((_, index) => `[s${index}]`).join('') + (previous ? `[${entries.length}:a:0]` : '');
  const count = entries.length + (previous ? 1 : 0);
  const sum = count === 1 ? `${labels}anull` : `${labels}amix=inputs=${count}:normalize=0:duration=longest:dropout_transition=0`;
  const graph = `${chains.join(';')};${sum},apad=whole_dur=${secs(seconds)},atrim=end=${secs(seconds)}[out]`;
  return ['-y', '-v', 'error', ...inputs, '-filter_complex', graph, '-map', '[out]', '-c:a', 'pcm_f32le', file];
}

/** Silence of the film's length, for a film with no sound at all. */
export function silenceArgs({ seconds, file }) {
  return ['-y', '-v', 'error', '-f', 'lavfi', '-i', `anullsrc=r=${SAMPLE_RATE}:cl=stereo`, '-t', secs(seconds), '-c:a', 'pcm_f32le', file];
}

/** 0…1 while inside the windows (linear ramps of `before` and `after` seconds around each), as an ffmpeg expression. */
export function windowExpression(windows, before, after) {
  if (windows.length === 0) return '0';
  return windows.map(({ start, end }) => `clip((t-${secs(start - before)})/${secs(before)},0,1)*clip((${secs(end + after)}-t)/${secs(after)},0,1)`).join('+');
}

/** The gain of a ducked track: depthDb under the dialogue windows, 0 dB elsewhere. */
export function duckFilter(windows, depthDb, ducking) {
  if (!ducking || windows.length === 0 || depthDb === 0) return null;
  return `volume='pow(10,(${secs(depthDb)}*(${windowExpression(windows, ducking.attack, ducking.release)}))/20)':eval=frame`;
}

/** Muted inside the silence windows (10 ms ramps). */
export function silenceFilter(windows) {
  if (windows.length === 0) return null;
  return `volume='max(0,1-(${windowExpression(windows, FADE_SECONDS, FADE_SECONDS)}))':eval=frame`;
}

/** The stems (one per track) summed into the mix before loudness, music and sfx ducked and muted. */
export function combineArgs({ stems, windows, ducking, silence, seconds, file }) {
  const inputs = stems.flatMap((stem) => [...inputOptions(WAV), '-i', stem.file]);
  const chains = stems.map((stem, index) => {
    const filters = ['anull'];
    if (stem.track === 'music' || stem.track === 'sfx') {
      const duck = duckFilter(windows, ducking?.[stem.track] ?? 0, ducking);
      if (duck) filters.push(duck);
      const mute = silenceFilter(silence);
      if (mute) filters.push(mute);
    }
    return `[${index}:a:0]${filters.join(',')}[t${index}]`;
  });
  const labels = stems.map((_, index) => `[t${index}]`).join('');
  const sum = stems.length === 1 ? `${labels}anull` : `${labels}amix=inputs=${stems.length}:normalize=0:duration=longest:dropout_transition=0`;
  const graph = `${chains.join(';')};${sum},apad=whole_dur=${secs(seconds)},atrim=end=${secs(seconds)}[out]`;
  return ['-y', '-v', 'error', ...inputs, '-filter_complex', graph, '-map', '[out]', '-c:a', 'pcm_f32le', file];
}

/** A loudness measurement (loudnorm's first pass) of an input's sound stream (its first, or the measured one); JSON to stderr. */
export function loudnessArgs({ input, format = WAV, stream = 'a:0', targetLUFS = -16, truePeakDb = -1 }) {
  return ['-hide_banner', '-nostats', ...inputOptions(format), '-i', input, '-map', `0:${stream}`, '-af',
    `loudnorm=I=${secs(targetLUFS)}:TP=${secs(truePeakDb)}:LRA=11:print_format=json`, '-f', 'null', '-'];
}

/** The last JSON block loudnorm printed → numbers (input_i is -Infinity for silence). */
export function parseLoudness(stderr) {
  const text = String(stderr);
  const start = text.lastIndexOf('{');
  const end = text.indexOf('}', start);
  if (start < 0 || end < 0) throw new Error('loudnorm printed no measurement');
  const raw = JSON.parse(text.slice(start, end + 1));
  const value = (key) => {
    const parsed = Number.parseFloat(raw[key]);
    if (Number.isFinite(parsed)) return parsed;
    if (/-inf/i.test(String(raw[key]))) return Number.NEGATIVE_INFINITY;
    throw new Error(`loudnorm printed no ${key}`);
  };
  return { i: value('input_i'), tp: value('input_tp'), lra: value('input_lra'), thresh: value('input_thresh'), offset: value('target_offset') };
}

const within = (value, min, max) => Math.min(max, Math.max(min, value));

/**
 * The second pass: the mix brought to the target loudness and true peak with the first pass's measurement, each value
 * held inside the range loudnorm takes (a mix measured louder than 0 LUFS would otherwise stop the pass).
 */
export function normalizeArgs({ input, measured, targetLUFS, truePeakDb, seconds, file }) {
  const loudnorm = `loudnorm=I=${secs(targetLUFS)}:TP=${secs(truePeakDb)}:LRA=11:measured_I=${secs(within(measured.i, -99, 0))}:measured_TP=${secs(within(measured.tp, -99, 99))}`
    + `:measured_LRA=${secs(within(measured.lra, 0, 99))}:measured_thresh=${secs(within(measured.thresh, -99, 0))}:offset=${secs(within(measured.offset, -99, 99))}:linear=true:print_format=none`;
  return ['-y', '-v', 'error', ...inputOptions(WAV), '-i', input, '-map', '0:a:0',
    '-af', `${loudnorm},aresample=${SAMPLE_RATE},apad=whole_dur=${secs(seconds)},atrim=end=${secs(seconds)}`, '-c:a', 'pcm_f32le', file];
}

export function muxArgs({ video, audio, file }) {
  return ['-y', '-v', 'error', ...inputOptions(MP4), '-i', video, ...inputOptions(WAV), '-i', audio, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy',
    '-c:a', 'aac', '-b:a', '192k', '-ar', String(SAMPLE_RATE), '-ac', '2', '-movflags', '+faststart', file];
}

/**
 * A still every `every` seconds (at most `max`), 960 px wide JPEGs, for a vision check of the cut: from the film's
 * BT.709 limited range to a JPEG's BT.601 full range, which is how every viewer reads one.
 */
export function stillsArgs({ input, every, max, pattern }) {
  return ['-y', '-v', 'error', ...inputOptions(MP4), '-i', input, '-map', '0:v:0',
    '-vf', `fps=1/${secs(every)},scale=${STILL_WIDTH}:-2:in_color_matrix=bt709:in_range=tv:out_color_matrix=bt601:out_range=pc`,
    '-frames:v', String(max), '-q:v', '3', pattern];
}

function srtTime(seconds) {
  const ms = Math.round(seconds * 1000);
  const pad = (value, size = 2) => String(value).padStart(size, '0');
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
}

/** SubRip text of the placed subtitles (already sorted by start, their text already one to three non-empty lines). */
export function srt(subtitles) {
  return subtitles.map((entry, index) => `${index + 1}\n${srtTime(entry.start)} --> ${srtTime(entry.end)}\n${entry.text}\n`).join('\n');
}
