#!/usr/bin/env node
// Stands in for rea-video in the worker's tests: decompose writes the files rea-video writes (naming the job's
// directory where rea-video does, so the tests see it scrubbed), summary prints a summary, review writes the review
// files. fake.json beside the input (or beside the output directory) changes what it does: {"fail": true},
// {"sleepMs": 5000}, {"noBreakdown": true}. It also records the environment it got in out/env.json.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [command, ...args] = process.argv.slice(2);
const behaviour = (dir) => {
  const file = path.join(dir, 'fake.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (command === 'decompose') {
  const input = path.resolve(args[0]);
  const out = path.resolve(args[args.indexOf('-o') + 1]);
  const how = behaviour(path.dirname(input));
  if (how.sleepMs) await sleep(how.sleepMs);
  if (how.fail) {
    process.stderr.write(`Traceback: failed on ${input}\n`);
    process.exit(3);
  }
  for (const dir of ['shots', 'packaging', 'stems']) mkdirSync(path.join(out, dir), { recursive: true });
  writeFileSync(path.join(out, 'env.json'), JSON.stringify(process.env));
  writeFileSync(path.join(out, 'args.json'), JSON.stringify(args));
  if (!how.noBreakdown) {
    writeFileSync(path.join(out, 'breakdown.json'), JSON.stringify({
      schema: 'rea_video.breakdown.v1', tool: { name: 'rea-video', version: '0.1.0' },
      source: { path: input, filename: path.basename(input), duration: 12.5, width: 480, height: 854, fps: 24, aspect_ratio: '9:16', has_audio: true },
      summary: { duration: 12.5, shots: 2, verdict: 'mixed: code 60% + AI video 40%', confidence: 0.61, avg_shot_s: 6.25, production: '1 unit, 1 call' },
      shots: [{ id: 'shot_001' }, { id: 'shot_002' }],
    }));
  }
  writeFileSync(path.join(out, 'report.md'), `# Report\n\nOutputs in ${out}/shots\n`);
  writeFileSync(path.join(out, 'report.html'), `<!doctype html><title>r</title><img src="${out}/storyboard.jpg">`);
  writeFileSync(path.join(out, 'storyboard.jpg'), 'JPEG');
  writeFileSync(path.join(out, 'audio.png'), 'PNG');
  writeFileSync(path.join(out, 'debug.log'), 'not an output');
  writeFileSync(path.join(out, 'shots', 'shot_001.jpg'), 'JPEG1');
  writeFileSync(path.join(out, 'shots', 'shot_001_first.jpg'), 'JPEG1F');
  writeFileSync(path.join(out, 'shots', 'notes.txt'), 'not an output');
  writeFileSync(path.join(out, 'packaging', 'subtitles.srt'), '1\n00:00:00,000 --> 00:00:01,000\nhi\n');
  writeFileSync(path.join(out, 'packaging', 'timeline.json'), '{"text":[]}');
  writeFileSync(path.join(out, 'stems', 'vocals.wav'), 'RIFF');
  process.stderr.write('17:00:00 INFO done\n');
  process.exit(0);
}

if (command === 'summary') {
  const breakdown = path.resolve(args[0]);
  const how = behaviour(path.dirname(path.dirname(breakdown)));
  if (how.summaryFail) process.exit(2);
  process.stdout.write(`clip | 12.5s\nverdict: mixed\nfiles: ${path.dirname(breakdown)}/stems/vocals.wav\n`);
  process.exit(0);
}

if (command === 'review') {
  const out = path.resolve(args[0]);
  writeFileSync(path.join(out, 'review_tasks.json'), JSON.stringify({ video: path.join(path.dirname(out), 'input.mp4'), shots: [] }));
  writeFileSync(path.join(out, 'review_answers.json'), JSON.stringify({ shots: {} }));
  process.exit(0);
}

process.stderr.write(`unknown command ${command}\n`);
process.exit(64);
