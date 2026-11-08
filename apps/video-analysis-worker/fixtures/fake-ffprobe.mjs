#!/usr/bin/env node
// Stands in for ffprobe in the worker's tests: prints probe.json beside the input when there is one, else a 12.5 s
// 480x854 video with sound.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const input = path.resolve(process.argv[process.argv.length - 1]);
const custom = path.join(path.dirname(input), 'probe.json');
process.stdout.write(existsSync(custom)
  ? readFileSync(custom, 'utf8')
  : JSON.stringify({ format: { duration: '12.500000' }, streams: [{ codec_type: 'video', width: 480, height: 854 }, { codec_type: 'audio' }] }));
