// Configuration from the environment and the one shape of a render request. Both are pure: loadConfig(env) and
// validateRenderRequest(body, limits) read nothing else, so tests pin every bound without a browser or ffmpeg.
import os from 'node:os';
import path from 'node:path';

export const LIMITS = Object.freeze({
  minSide: 64,
  maxWidth: 1920,
  maxHeight: 1920,
  maxFps: 60,
  minSeconds: 0.5,
  maxSecondsCeiling: 60,
  maxFrames: 1800,
  maxStills: 8,
  maxHtmlBytes: 6 * 1024 * 1024,
  maxBodyBytes: 8 * 1024 * 1024,
});

export const OUTPUT_KINDS = Object.freeze(['mp4', 'gif', 'contact']);
const RENDER_ID = /^[A-Za-z0-9_-]{8,80}$/;
const DECIMAL = /^\d+(\.\d+)?$/;

function setting(name, message) {
  return new Error(`${name} ${message}`);
}

function parseListen(value) {
  const match = /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+):(\d{1,5})$/.exec(value);
  const port = match ? Number(match[2]) : NaN;
  if (!match || !Number.isInteger(port) || port < 1 || port > 65535) throw setting('AWWO_RENDER_LISTEN', 'must be host:port');
  return { host: match[1].replace(/^\[|\]$/g, ''), port };
}

function decimalSetting(raw, fallback, minimum, maximum, name) {
  if (raw === undefined || raw === '') return fallback;
  if (!DECIMAL.test(raw)) throw setting(name, 'must be a number');
  const value = Number(raw);
  if (value < minimum || value > maximum) throw setting(name, `must be between ${minimum} and ${maximum}`);
  return value;
}

function integerSetting(raw, fallback, minimum, maximum, name) {
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) throw setting(name, 'must be an integer');
  return decimalSetting(raw, fallback, minimum, maximum, name);
}

function switchSetting(raw, fallback, name) {
  if (raw === undefined || raw === '') return fallback;
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  throw setting(name, 'must be 1 or 0');
}

/**
 * The worker's settings. A token shorter than 32 characters, or no browser, leaves the worker running but not
 * ready (health 503, renders refused); a malformed value is a startup error.
 */
export function loadConfig(env = process.env) {
  const token = env.AWWO_RENDER_TOKEN ?? '';
  const chrome = String(env.AWWO_RENDER_CHROME ?? '').trim();
  const config = {
    ...parseListen(env.AWWO_RENDER_LISTEN || '127.0.0.1:8111'),
    token,
    chrome,
    // Chromium's own sandbox stays on; 0 is for hosts that cannot provide it (documented in the README).
    chromeSandbox: switchSetting(env.AWWO_RENDER_CHROME_SANDBOX, true, 'AWWO_RENDER_CHROME_SANDBOX'),
    ffmpeg: String(env.AWWO_RENDER_FFMPEG ?? '').trim() || 'ffmpeg',
    ffprobe: String(env.AWWO_RENDER_FFPROBE ?? '').trim() || 'ffprobe',
    tmp: path.resolve(env.AWWO_RENDER_TMP || os.tmpdir()),
    maxSeconds: decimalSetting(env.AWWO_RENDER_MAX_SECONDS, 20, LIMITS.minSeconds, LIMITS.maxSecondsCeiling, 'AWWO_RENDER_MAX_SECONDS'),
    timeoutMs: integerSetting(env.AWWO_RENDER_TIMEOUT_MS, 360_000, 5_000, 1_800_000, 'AWWO_RENDER_TIMEOUT_MS'),
  };
  config.ready = token.length >= 32 && chrome !== '';
  return Object.freeze(config);
}

/** Frames in a render: round(seconds × fps), rounded as the API rounds (half away from zero). */
export function frameCount(seconds, fps) {
  return Math.round(seconds * fps);
}

/** The time of every frame: i / fps for i in 0..N-1. The last is always earlier than seconds. */
export function frameTimes(frames, fps) {
  return Array.from({ length: frames }, (_, index) => index / fps);
}

/** A complete HTML document: <html or <!doctype html in its first 4 KiB, matched as the API matches it. */
export function pageShape(html) {
  const head = Buffer.from(html.slice(0, 4096), 'utf8').subarray(0, 4096).toString('latin1').toLowerCase();
  return head.includes('<html') || head.includes('<!doctype html');
}

function invalid(field, message) {
  return Object.assign(new Error(message), { status: 400, code: 'INVALID_RENDER', field });
}

function side(value, field, maximum) {
  if (!Number.isInteger(value) || value < LIMITS.minSide || value > maximum) {
    throw invalid(field, `${field} must be an integer from ${LIMITS.minSide} to ${maximum}`);
  }
  return value - (value % 2);
}

function outputList(value) {
  if (value === undefined) return ['mp4'];
  if (!Array.isArray(value) || value.length > 8 || value.some((kind) => !OUTPUT_KINDS.includes(kind))) {
    throw invalid('outputs', 'outputs lists mp4, gif and contact only');
  }
  return OUTPUT_KINDS.filter((kind) => kind === 'mp4' || value.includes(kind));
}

function stillList(value, frames) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > LIMITS.maxStills || new Set(value).size !== value.length
    || value.some((frame) => !Number.isInteger(frame) || frame < 0 || frame >= frames)) {
    throw invalid('stills', `stills lists at most ${LIMITS.maxStills} distinct frame numbers of the render`);
  }
  return [...value].sort((a, b) => a - b);
}

/** The normalized request, or throws {status: 400, code: 'INVALID_RENDER', field}. */
export function validateRenderRequest(body, { maxSeconds = 20 } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('body', 'A JSON object is required');
  const { renderId, html, fps, seconds, loop } = body;
  if (typeof renderId !== 'string' || !RENDER_ID.test(renderId)) throw invalid('renderId', 'renderId is 8–80 letters, digits, - or _');
  if (typeof html !== 'string' || html.length === 0 || html.includes('\0') || Buffer.byteLength(html, 'utf8') > LIMITS.maxHtmlBytes || !pageShape(html)) {
    throw invalid('html', 'A complete HTML document of at most 6 MiB is required');
  }
  const width = side(body.width, 'width', LIMITS.maxWidth);
  const height = side(body.height, 'height', LIMITS.maxHeight);
  if (!Number.isInteger(fps) || fps < 1 || fps > LIMITS.maxFps) throw invalid('fps', `fps must be an integer from 1 to ${LIMITS.maxFps}`);
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < LIMITS.minSeconds || seconds > maxSeconds) {
    throw invalid('seconds', `seconds must be from ${LIMITS.minSeconds} to ${maxSeconds}`);
  }
  const frames = frameCount(seconds, fps);
  if (frames < 1 || frames > LIMITS.maxFrames) throw invalid('seconds', `A render has at most ${LIMITS.maxFrames} frames`);
  if (loop !== undefined && typeof loop !== 'boolean') throw invalid('loop', 'loop must be true or false');
  return {
    renderId, html, width, height, fps, seconds, frames, loop: loop === true,
    outputs: outputList(body.outputs),
    stills: stillList(body.stills, frames),
  };
}
