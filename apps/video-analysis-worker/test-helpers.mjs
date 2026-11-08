// Shared by the tests: a worker configuration whose rea-video and ffprobe are the fakes in fixtures/.
import { chmod, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FAKE_REA = path.join(HERE, 'fixtures', 'fake-rea-video.mjs');
export const FAKE_FFPROBE = path.join(HERE, 'fixtures', 'fake-ffprobe.mjs');
export const TOKEN = 't'.repeat(40);

export async function fakeConfig(extra = {}) {
  await chmod(FAKE_REA, 0o755);
  await chmod(FAKE_FFPROBE, 0o755);
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'awwo-analysis-test-'));
  const config = loadConfig({
    AWWO_ANALYSIS_TOKEN: TOKEN, AWWO_ANALYSIS_REA: FAKE_REA, AWWO_ANALYSIS_FFPROBE: FAKE_FFPROBE,
    AWWO_ANALYSIS_PATH: `${path.dirname(process.execPath)}${path.delimiter}/usr/bin${path.delimiter}/bin`,
    AWWO_ANALYSIS_TMP: tmp, AWWO_ANALYSIS_MODELS: path.join(tmp, 'models'), AWWO_ANALYSIS_THREADS: '2', ...extra,
  });
  config.modelsOk = true;
  return config;
}

/** The first bytes of an MP4 (an ftyp box) followed by filler, as a video the worker takes. */
export function fakeMp4(bytes = 4096) {
  const data = Buffer.alloc(bytes, 7);
  // size 24, 'ftyp', major brand 'isom', minor version 0x200, compatible brands 'isom' and 'mp41'
  Buffer.from('000000186674797069736f6d0000020069736f6d6d703431', 'hex').copy(data, 0);
  return data;
}
