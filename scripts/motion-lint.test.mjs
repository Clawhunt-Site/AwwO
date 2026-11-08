// The motion language stays one: apps/motion-tokens.json is the source, and the apps' tokens, MOTION.md's code
// blocks and the free check (scripts/motion-lint.mjs) are held to it here. The last test is the check itself run
// over the web app the way the article's CI step runs it: drift that existed on 2026-11-08 is listed in
// scripts/motion-lint-baseline.json by rule and text, anything new fails.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  RULES, baselineOf, languageCurves, lintPaths, lintText, loadTokens, overBaseline, pruneBaseline, staleBaseline,
} from './motion-lint.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const tokens = loadTokens();
const vectors = JSON.parse(read('apps/motion-lint-vectors.json'));
const cli = (args, cwd = root) => spawnSync(process.execPath, [join(root, 'scripts/motion-lint.mjs'), ...args], { cwd, encoding: 'utf8' });

test('every shared vector gives the findings both motion checks agree on', () => {
  assert.ok(vectors.cases.length >= 50);
  for (const c of vectors.cases) {
    const got = lintText(c.text, { path: c.path, profile: c.profile, tokens, video: c.video }).map(f => [f.line, f.rule]);
    assert.deepEqual(got, c.expect, c.name);
    for (const [, rule] of c.expect) assert.ok(RULES.includes(rule), `${c.name}: unknown rule ${rule}`);
  }
});

test('the page profile only ever reports notes and the strict profile never reports a note', () => {
  for (const c of vectors.cases) {
    for (const f of lintText(c.text, { path: c.path, profile: c.profile, tokens, video: c.video })) {
      if (c.profile === 'page') assert.equal(f.severity, 'note', c.name);
      else assert.notEqual(f.severity, 'note', c.name);
    }
  }
});

test('both apps load the language\'s own tokens, and the hosted pages\' older names hold the same values', () => {
  const block = /```css\n([\s\S]*?)```/.exec(read('MOTION.md'))[1];
  assert.ok(read('apps/web/src/motion-tokens.css').includes(block), 'apps/web/src/motion-tokens.css holds MOTION.md\'s CSS block');
  assert.match(read('apps/web/src/main.tsx'), /import '\.\/motion-tokens\.css';\nimport '\.\/styles\.css';/);
  assert.match(read('apps/web/src/saas/main.tsx'), /import '\.\.\/motion-tokens\.css';\nimport '\.\.\/styles\.css';/);
  const css = read('apps/web/src/saas/design/tokens.css');
  const curve = name => {
    const m = new RegExp(`${name}:\\s*cubic-bezier\\(([^)]*)\\)`).exec(css);
    assert.ok(m, `${name} is declared`);
    return m[1].split(',').map(Number);
  };
  const ms = name => Number(new RegExp(`${name}:\\s*(\\d+)ms`).exec(css)?.[1]);
  assert.deepEqual(curve('--saas-ease'), tokens.ease.enter.curve);
  assert.deepEqual(curve('--saas-ease-in-out'), tokens.ease.move.curve);
  assert.deepEqual(curve('--saas-ease-exit'), tokens.ease.exit.curve);
  assert.deepEqual(curve('--saas-ease-spring'), tokens.ease.emphasis.curve);
  const d = tokens.ui.duration_ms;
  assert.deepEqual([ms('--saas-dur-1'), ms('--saas-dur-2'), ms('--saas-dur-3'), ms('--saas-dur-4')], [d.fast, d.base, d.slow, d.scene]);
});

test('MOTION.md prints the same numbers as apps/motion-tokens.json', () => {
  const doc = read('MOTION.md');
  for (const [name, entry] of Object.entries(tokens.ease)) {
    assert.ok(doc.includes(`| ${name} | (${entry.curve.join(', ')}) |`), `table row for ${name}`);
    if (name !== 'linear') assert.ok(doc.includes(`--ease-${name}: cubic-bezier(${entry.curve.join(', ')});`), `CSS token ${name}`);
  }
  for (const [name, ms] of Object.entries(tokens.ui.duration_ms)) {
    assert.ok(doc.includes(`| ${name} | ${ms} |`), `duration row ${name}`);
    assert.ok(doc.includes(`--dur-${name}: ${ms}ms;`), `CSS duration ${name}`);
  }
  for (const [name, s] of Object.entries(tokens.film.seconds)) {
    assert.ok(doc.includes(`| ${name} | ${Number.isInteger(s) ? s.toFixed(1) : s} | ${tokens.film.frames_at_30fps[name]} |`), `film row ${name}`);
  }
  for (const [name, s] of Object.entries(tokens.spring)) {
    assert.ok(doc.includes(`| ${name} | ${s.stiffness} / ${s.damping} | ${s.zeta} / ${s.settle} s |`), `spring row ${name}`);
    assert.ok(doc.includes(`${name}: { stiffness: ${s.stiffness}, damping: ${s.damping}, zeta: ${s.zeta}, settle: ${s.settle} }`), `JS spring ${name}`);
  }
  const js = /ease: \{ enter: \[([^\]]*)\], move: \[([^\]]*)\], exit: \[([^\]]*)\], emphasis: \[([^\]]*)\] \}/.exec(doc);
  assert.ok(js, 'the JS block lists the four curves');
  assert.deepEqual(js.slice(1).map(list => list.split(',').map(Number)), ['enter', 'move', 'exit', 'emphasis'].map(n => tokens.ease[n].curve));
  for (const rule of RULES) assert.ok(doc.includes(`\`${rule}\``), `MOTION.md lists the rule ${rule}`);
});

test('each named spring\'s two descriptions agree (mass 1, settle within 2 %)', () => {
  for (const [name, s] of Object.entries(tokens.spring)) {
    const w = Math.sqrt(s.stiffness);
    assert.ok(Math.abs(s.damping / (2 * w) - s.zeta) <= 0.01, `${name}: zeta from stiffness and damping`);
    const settle = s.zeta >= 1 ? 5.84 / w : (Math.log(50) - Math.log(Math.sqrt(1 - s.zeta * s.zeta))) / (s.zeta * w);
    assert.ok(Math.abs(settle - s.settle) <= 0.01, `${name}: settle ${settle.toFixed(3)} vs ${s.settle}`);
  }
});

test('the curve tokens are distinct and every character preset names a curve', () => {
  const easeCurves = Object.values(tokens.ease).map(e => e.curve.join(','));
  assert.equal(new Set(easeCurves).size, easeCurves.length, 'no two curve tokens are the same curve');
  for (const [name, preset] of Object.entries(tokens.character)) {
    if (name === 'about') continue;
    assert.equal(preset.enter.length, 4, name);
    assert.ok(preset.enter.every(Number.isFinite), name);
  }
  assert.ok(languageCurves(tokens).length >= easeCurves.length);
});

test('hostile inputs lint in linear time: twice the input takes about twice as long', () => {
  // The shapes two reviews found quadratic on 2026-11-08, each built to a size n.
  const shapes = {
    tokenRun: n => `<p>${'--dur-'.repeat(n / 6)}</p>`,
    dashRun: n => `<style>${'-'.repeat(n)}</style>`,
    mediaRun: n => `<style>${'@media '.repeat(n / 7)}{}</style>`,
    minified: n => `<style>:root{--ease-a:cubic-bezier(.2,0,0,1)}</style>\n<style>${'.a{transition:transform var(--d) cubic-bezier(.2,0,0,1)}'.repeat(n / 56)}</style>`,
    manyTokens: n => `<style>${Array.from({ length: n / 36 }, (_, i) => `--e${i}:cubic-bezier(${(i % 100) / 100},0,0,1);`).join('\n')}</style>`,
    digits: n => `<style>:root{--dur-a:1ms}.a{animation: ${'1'.repeat(n)}x}</style>`,
    spaces: n => `<style>.x{transition: transform 1s} .y{color:${' '.repeat(n)}x}</style>`,
    allowed: n => `<style>/* motion-lint-allow raw-curve: x */ :root{--ease-a:cubic-bezier(.2,0,0,1)} ${'.a{transition:transform 1s cubic-bezier(.3,0,0,1)}'.repeat(n / 52)}</style>`,
    tags: n => '<a'.repeat(n / 2),
    quotes: n => `<script>${"transition: '".repeat(n / 13)}</script>`,
    objects: n => `<script>${'MOTION = {'.repeat(n / 10)}</script>`,
    films: n => `<script>${'w.renderAt = ('.repeat(n / 14)}</script>`,
    aliases: n => `<script>${'w.renderAt=missing;'.repeat(n / 19)}</script>`,
    names: n => `<script>${Array.from({ length: n / 24 }, (_, i) => `w.renderAt=draw${i};`).join('')}</script>`,
    nested: (n) => {
      // Nested functions, each named by its own renderAt alias (round 3 of the delta review: 2.4 s at 310 KB).
      const k = Math.max(1, Math.floor(n / 64));
      const open = Array.from({ length: k }, (_, i) => `function f${i}(){`).join('');
      return `<script>${open}${'x++;'.repeat(k * 4)}${'}'.repeat(k)}${Array.from({ length: k }, (_, i) => `w.renderAt=f${i};`).join('')}</script>`;
    },
    calls: n => `<script>${'el.animate('.repeat(n / 11)}</script>`,
    springs: n => `const MOTION={};${'{ damping: 1 '.repeat(n / 14)}`,
    fallbacks: n => `<style>:root{--dur-a:1ms}${'.a{transition:transform var(--x, cubic-bezier(.1,.2,.3,.4))}'.repeat(n / 60)}</style>`,
  };
  // Best of three, and a ratio a busy machine cannot fake: a quadratic shape takes seconds at these sizes (the
  // first review measured 5.3 s at 240 KB), far past the ceiling, and 4x per doubling, not 2x.
  const time = (text, path, profile) => {
    let best = Infinity;
    for (let run = 0; run < 3; run++) {
      const started = process.hrtime.bigint();
      lintText(text, { path, profile, tokens });
      best = Math.min(best, Number(process.hrtime.bigint() - started) / 1e6);
    }
    return best;
  };
  for (const [name, make] of Object.entries(shapes)) {
    for (const [path, profile] of [['x.html', 'page'], ['x.tsx', 'strict']]) {
      const small = time(make(256 * 1024), path, profile);
      const large = time(make(512 * 1024), path, profile);
      assert.ok(large < 1500, `${name} (${profile}): 512 KiB took ${large.toFixed(0)} ms`);
      assert.ok(large < Math.max(60, small * 3.5), `${name} (${profile}): ${small.toFixed(0)} ms for 256 KiB, ${large.toFixed(0)} ms for 512 KiB (not linear)`);
    }
  }
});

test('the baseline knows findings by rule and text: a new one fails where it is added, moved code keeps its allowance', () => {
  const old = [
    '.a { transition: transform 0.14s ease; }',
    '.b { transition: opacity 120ms; }',
    '@media (prefers-reduced-motion: reduce) { .a { transition: none; } }',
  ].join('\n');
  const findings = file => text => lintText(text, { path: file, tokens }).map(f => ({ file, ...f }));
  const baseline = baselineOf(findings('a.css')(old));
  assert.ok(baseline.known.every(e => e.rule && e.text && e.count > 0 && e.where === 'a.css'));
  // A new declaration at the top of the file: only it fails, at its own line.
  const added = `.new { transition: transform 300ms ease; }\n${old}`;
  assert.deepEqual(overBaseline(findings('a.css')(added), baseline).map(f => [f.file, f.line]), [['a.css', 1], ['a.css', 1], ['a.css', 1]]);
  // The same code moved to another file: nothing new.
  assert.deepEqual(overBaseline(findings('b.css')(old), baseline), []);
  // Drift fixed: the baseline is stale above the code, and pruning lowers it without ever raising a count.
  const fixed = old.replace('0.14s ease', 'var(--dur-fast) var(--ease-enter)');
  const stale = staleBaseline(findings('a.css')(fixed), baseline);
  assert.ok(stale.length >= 1 && stale.every(e => e.now < e.count));
  const pruned = pruneBaseline(findings('a.css')(fixed), baseline);
  assert.ok(pruned.known.length < baseline.known.length);
  const before = new Map(baseline.known.map(e => [`${e.rule}|${e.text}`, e.count]));
  for (const e of pruneBaseline(findings('a.css')(added), baseline).known) assert.ok(e.count <= before.get(`${e.rule}|${e.text}`));
  // A missing reduced-motion path is known by the file's first moving line: fixing one file and adding another
  // unrelated one without the path fails; moving the file keeps its allowance.
  const moving = '.m { transition: transform var(--dur-base) var(--ease-enter); }';
  const known = baselineOf(findings('m.css')(moving));
  assert.deepEqual(known.known.map(e => e.rule), ['reduced-motion-missing']);
  assert.deepEqual(overBaseline(findings('moved/m.css')(moving), known), []);
  const unrelated = '.n { transition: translate var(--dur-slow) var(--ease-move); }';
  assert.deepEqual(overBaseline(findings('n.css')(unrelated), known).map(f => f.rule), ['reduced-motion-missing']);
});

test('the command line: exit codes, either slash in --ignore, another language, a video project', () => {
  const dir = mkdtempSync(join(tmpdir(), 'motion-lint-'));
  try {
    mkdirSync(join(dir, 'src', 'recorded'), { recursive: true });
    writeFileSync(join(dir, 'src', 'recorded', 'case.css'), '.a { transition: all 1s; }\n');
    writeFileSync(join(dir, 'src', 'ok.css'), '.b { transition: opacity var(--dur-base) var(--ease-enter); }\n');
    assert.equal(cli(['--nope', 'src'], dir).status, 2, 'an unknown option is a usage error');
    assert.equal(cli(['src/missing'], dir).status, 2, 'a missing path is a usage error');
    assert.equal(cli(['--profile'], dir).status, 2, 'an option without its value');
    assert.equal(cli(['src'], dir).status, 1, 'the recorded file has findings');
    assert.equal(cli(['--ignore', 'src\\recorded\\', 'src'], dir).status, 0, '--ignore with backslashes');
    assert.equal(cli(['--ignore', './src/recorded', 'src'], dir).status, 0, '--ignore with a leading ./');
    assert.equal(cli(['--report', 'src'], dir).status, 0, '--report never fails');
    // Another brand's language: its curve passes, AwwO's enter is off its language.
    const brand = structuredClone(tokens);
    brand.ease = { enter: { curve: [0.2, 0, 0, 1], use: 'arriving' }, linear: tokens.ease.linear };
    brand.character = {};
    writeFileSync(join(dir, 'brand.json'), JSON.stringify(brand));
    writeFileSync(join(dir, 'brand.ts'), 'export const a = { ease: [0.2, 0, 0, 1] };\nexport const b = { ease: [0.16, 1, 0.3, 1] };\n');
    const own = JSON.parse(cli(['--tokens', 'brand.json', '--json', '--report', 'brand.ts'], dir).stdout);
    assert.deepEqual(own.findings.filter(f => f.rule === 'off-language-curve').map(f => f.line), [2]);
    assert.equal(cli(['--tokens', 'no-such.json', 'brand.ts'], dir).status, 2, 'a missing language is a usage error');
    // A helper in a video project may not read the clock; outside --video it is not a film.
    writeFileSync(join(dir, 'noise.ts'), 'export const jitter = () => Math.random();\n');
    assert.equal(cli(['noise.ts'], dir).status, 0);
    assert.equal(cli(['--video', 'noise.ts'], dir).status, 1);
    // --write-baseline never replaces a baseline silently.
    assert.equal(cli(['--write-baseline', 'base.json', 'src'], dir).status, 0);
    assert.equal(cli(['--write-baseline', 'base.json', 'src'], dir).status, 2);
    assert.equal(cli(['--baseline', 'base.json', 'src'], dir).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AwwO\'s own web code adds no motion drift beyond the 2026-11-08 baseline', () => {
  const baseline = JSON.parse(read('scripts/motion-lint-baseline.json'));
  const { findings } = lintPaths(['apps/web/src'], {
    cwd: root,
    tokens,
    ignore: ['apps/web/src/saas/production-canvases/', 'apps/web/src/saas/production-runs/'],
  });
  const over = overBaseline(findings, baseline);
  assert.deepEqual(over.map(f => `${f.file}:${f.line} ${f.rule} ${f.excerpt}`), [],
    'Use a token from MOTION.md, or mark a deliberate exception with `motion-lint-allow <rule>: <reason>`; '
    + 'npm run check:motion prints the same list.');
});
