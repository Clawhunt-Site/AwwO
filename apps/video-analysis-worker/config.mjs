// Configuration from the environment and the one shape of an analysis request. Both are pure: loadConfig(env) and
// validateAnalysisRequest(body) read nothing else, so tests pin every bound without rea-video or ffmpeg.
import os from 'node:os';
import path from 'node:path';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

export const LIMITS = Object.freeze({
  maxManifestBytes: 64 * 1024,
  maxSummaryBytes: 64 * 1024,
  maxOutputs: 2000,
  maxOutputBytes: 2 * GIB,
});

/** The models rea-video loads, as its pinned commit checks them; the image bakes them into AWWO_ANALYSIS_MODELS. */
export const MODEL_FILES = Object.freeze([
  { name: 'UVR-MDX-NET-Inst_HQ_3.onnx', sha256: '317554b07fe1ea5279a77f2b1520a41ea4b93432560c4ffd08792c30fddf9adc' },
  { name: 'face_detection_yunet_2023mar.onnx', sha256: '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4' },
]);

export const LANGS = Object.freeze(['zh', 'en']);
export const OCR_LANGS = Object.freeze(['zh', 'ja']);
const ANALYSIS_ID = /^[A-Za-z0-9_-]{8,80}$/;
const SHA256 = /^[0-9a-f]{64}$/;
// A display name only: the worker stores the file under a name of its own and never uses this one as a path.
const DISPLAY_NAME = /^[^\u0000-\u001f\u007f/\\]{1,200}$/;
const DECIMAL = /^\d+$/;

function setting(name, message) {
  return new Error(`${name} ${message}`);
}

function parseListen(value) {
  const match = /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+):(\d{1,5})$/.exec(value);
  const port = match ? Number(match[2]) : NaN;
  if (!match || !Number.isInteger(port) || port < 1 || port > 65535) throw setting('AWWO_ANALYSIS_LISTEN', 'must be host:port');
  return { host: match[1].replace(/^\[|\]$/g, ''), port };
}

function integerSetting(raw, fallback, minimum, maximum, name) {
  if (raw === undefined || raw === '') return fallback;
  if (!DECIMAL.test(raw)) throw setting(name, 'must be an integer');
  const value = Number(raw);
  if (value < minimum || value > maximum) throw setting(name, `must be between ${minimum} and ${maximum}`);
  return value;
}

function absoluteOrEmpty(raw, name) {
  const value = String(raw ?? '').trim();
  if (value && !path.isAbsolute(value)) throw setting(name, 'must be an absolute path');
  return value;
}

/**
 * The worker's settings. A token shorter than 32 characters leaves the worker running but not ready (health 503,
 * analyses refused); so do a missing program or model, which /health names. A malformed value is a startup error.
 */
export function loadConfig(env = process.env) {
  const token = env.AWWO_ANALYSIS_TOKEN ?? '';
  const cpus = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  return {
    ...parseListen(env.AWWO_ANALYSIS_LISTEN || '127.0.0.1:8121'),
    token,
    ready: token.length >= 32,
    // rea-video and ffprobe: a path, or a name looked up on the children's PATH (which must also hold ffmpeg).
    rea: String(env.AWWO_ANALYSIS_REA ?? '').trim() || 'rea-video',
    ffprobe: String(env.AWWO_ANALYSIS_FFPROBE ?? '').trim() || 'ffprobe',
    path: String(env.AWWO_ANALYSIS_PATH ?? '').trim() || '/usr/local/bin:/usr/bin:/bin',
    // Read-only directory holding MODEL_FILES; rea-video never downloads (the worker has no network).
    models: absoluteOrEmpty(env.AWWO_ANALYSIS_MODELS, 'AWWO_ANALYSIS_MODELS'),
    modelFiles: MODEL_FILES,
    modelsOk: false,
    tmp: path.resolve(env.AWWO_ANALYSIS_TMP || os.tmpdir()),
    maxInputBytes: integerSetting(env.AWWO_ANALYSIS_MAX_INPUT_MB, 512, 1, 8192, 'AWWO_ANALYSIS_MAX_INPUT_MB') * MIB,
    maxSeconds: integerSetting(env.AWWO_ANALYSIS_MAX_SECONDS, 300, 1, 3600, 'AWWO_ANALYSIS_MAX_SECONDS'),
    maxSide: integerSetting(env.AWWO_ANALYSIS_MAX_SIDE, 4096, 64, 8192, 'AWWO_ANALYSIS_MAX_SIDE'),
    timeoutMs: integerSetting(env.AWWO_ANALYSIS_TIMEOUT_MS, 1_800_000, 60_000, 14_400_000, 'AWWO_ANALYSIS_TIMEOUT_MS'),
    idleMs: integerSetting(env.AWWO_ANALYSIS_IDLE_MS, 600_000, 1_000, 3_600_000, 'AWWO_ANALYSIS_IDLE_MS'),
    threads: integerSetting(env.AWWO_ANALYSIS_THREADS, Math.max(1, Math.min(8, cpus)), 1, 64, 'AWWO_ANALYSIS_THREADS'),
  };
}

function invalid(field, message) {
  return Object.assign(new Error(message), { status: 400, code: 'INVALID_ANALYSIS', field });
}

function flag(value, field, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw invalid(field, `${field} must be true or false`);
  return value;
}

function choice(value, field, allowed, fallback) {
  if (value === undefined) return fallback;
  if (!allowed.includes(value)) throw invalid(field, `${field} must be one of ${allowed.join(', ')}`);
  return value;
}

/** An analysis job's manifest: its id, the one video it takes (checked again as its bytes arrive) and its options. */
export function validateAnalysisRequest(body, { maxInputBytes }) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw invalid('body', 'The body must be a JSON object');
  if (typeof body.analysisId !== 'string' || !ANALYSIS_ID.test(body.analysisId)) throw invalid('analysisId', 'analysisId must match ^[A-Za-z0-9_-]{8,80}$');
  const file = body.file;
  if (file === null || typeof file !== 'object' || Array.isArray(file)) throw invalid('file', 'file must be an object');
  if (typeof file.name !== 'string' || !DISPLAY_NAME.test(file.name)) throw invalid('file.name', 'file.name is 1-200 characters, no slashes or control characters');
  if (!Number.isInteger(file.size) || file.size < 1 || file.size > maxInputBytes) throw invalid('file.size', `file.size must be an integer from 1 to ${maxInputBytes}`);
  if (typeof file.sha256 !== 'string' || !SHA256.test(file.sha256)) throw invalid('file.sha256', 'file.sha256 must be 64 lowercase hex digits');
  const raw = body.options ?? {};
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw invalid('options', 'options must be an object');
  const options = {
    lang: choice(raw.lang, 'options.lang', LANGS, 'zh'),
    ocr: flag(raw.ocr, 'options.ocr', true),
    ocrLang: choice(raw.ocrLang, 'options.ocrLang', OCR_LANGS, 'zh'),
    packaging: flag(raw.packaging, 'options.packaging', true),
    stems: flag(raw.stems, 'options.stems', false),
    review: flag(raw.review, 'options.review', true),
  };
  return { analysisId: body.analysisId, file: { name: file.name, size: file.size, sha256: file.sha256 }, options };
}
