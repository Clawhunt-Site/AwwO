import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { MAX_TIMER_FIRINGS, VIRTUAL_EPOCH_MS, VIRTUAL_TIME_SCRIPT } from './virtual-time.mjs';

// A fake window: the context's own global (so Date and Math are its builtins) with a real-looking clock, rAF and
// reportError. run() evaluates page code in it.
function load() {
  const errors = [];
  const realFrames = [];
  const context = vm.createContext({
    performance: { now: () => 98765 },
    requestAnimationFrame: (callback) => realFrames.push(callback),
    reportError: (error) => errors.push(error),
  });
  vm.runInContext('globalThis.window = globalThis;', context);
  vm.runInContext(VIRTUAL_TIME_SCRIPT, context);
  // json() copies a value out of the page realm, so arrays compare without the page's own Array.prototype.
  const json = (code) => JSON.parse(vm.runInContext(`JSON.stringify(${code})`, context));
  return { run: (code) => vm.runInContext(code, context), json, errors, realFrames };
}

test('the clock stands at 0 until advanced; Date.now, new Date() and performance.now are virtual', () => {
  const page = load();
  assert.equal(VIRTUAL_EPOCH_MS, Date.parse('2026-01-01T00:00:00Z'));
  assert.equal(page.run('performance.now()'), 0);
  assert.equal(page.run('Date.now()'), VIRTUAL_EPOCH_MS);
  assert.equal(page.run('new Date().getTime()'), VIRTUAL_EPOCH_MS);
  page.run('__awwoAdvanceTo(1500)');
  assert.equal(page.run('performance.now()'), 1500);
  assert.equal(page.run('Date.now()'), VIRTUAL_EPOCH_MS + 1500);
  assert.equal(page.run('new Date().toISOString()'), '2026-01-01T00:00:01.500Z');
  assert.equal(page.run('typeof Date()'), 'string');
});

test('Date with arguments and the rest of Date behave as usual', () => {
  const page = load();
  assert.equal(page.run('new Date(0).getTime()'), 0);
  assert.equal(page.run('new Date(2020, 0, 2).getFullYear()'), 2020);
  assert.equal(page.run('Date.UTC(2000, 0, 1)'), Date.UTC(2000, 0, 1));
  assert.equal(page.run("Date.parse('2001-02-03T00:00:00Z')"), Date.parse('2001-02-03T00:00:00Z'));
  assert.equal(page.run('new Date() instanceof Date'), true);
  assert.equal(page.run('new Date().constructor === Date'), true);
  assert.equal(page.run('class Stamp extends Date {}; new Stamp().getTime()'), VIRTUAL_EPOCH_MS);
  assert.equal(page.run('Date.length'), 7);
});

test('timers fire in due order, each at its own due time', () => {
  const page = load();
  page.run(`globalThis.log = [];
    setTimeout(() => log.push(['a', performance.now()]), 30);
    setTimeout(() => log.push(['b', performance.now()]), 10);
    setTimeout((x, y) => log.push(['c' + x + y, performance.now()]), 10, 1, 2);
    globalThis.late = setTimeout(() => log.push(['late', performance.now()]), 100);`);
  assert.equal(page.run('__awwoAdvanceTo(50)'), 3);
  assert.deepEqual(page.run('JSON.stringify(log)'), JSON.stringify([['b', 10], ['c12', 10], ['a', 30]]));
  assert.equal(page.run('performance.now()'), 50);
  page.run('__awwoAdvanceTo(100)');
  assert.deepEqual(page.json('log.at(-1)'), ['late', 100]);
  page.run("setTimeout(() => log.push(['never']), 10); clearTimeout(setTimeout(() => log.push(['cleared']), 5));");
  page.run('globalThis.n = log.length; __awwoAdvanceTo(105)');
  assert.equal(page.run('log.length - n'), 0);
});

test('intervals repeat from their due time without drift, and stop when cleared', () => {
  const page = load();
  page.run('globalThis.ticks = []; globalThis.id = setInterval(() => ticks.push(performance.now()), 100);');
  page.run('__awwoAdvanceTo(0)');
  assert.deepEqual(page.json('ticks'), []);
  page.run('__awwoAdvanceTo(250)');
  assert.deepEqual(page.json('ticks'), [100, 200]);
  page.run('__awwoAdvanceTo(500)');
  assert.deepEqual(page.json('ticks'), [100, 200, 300, 400, 500]);
  page.run('clearInterval(id); __awwoAdvanceTo(900)');
  assert.equal(page.run('ticks.length'), 5);
  page.run('globalThis.k = 0; globalThis.self = setInterval(() => { if (++k === 3) clearInterval(self); }, 10); __awwoAdvanceTo(2000)');
  assert.equal(page.run('k'), 3);
});

test('nested zero-delay timers clamp to 4 ms after five levels, as in a browser', () => {
  const page = load();
  page.run('globalThis.at = []; const again = () => { at.push(performance.now()); setTimeout(again, 0); }; setTimeout(again, 0);');
  page.run('__awwoAdvanceTo(20)');
  assert.deepEqual(page.json('at'), [0, 0, 0, 0, 0, 0, 4, 8, 12, 16, 20]);
});

test('at most 10,000 timer firings per advance; the rest fire on the next', () => {
  const page = load();
  page.run('globalThis.count = 0; for (let i = 0; i < 10050; i++) setTimeout(() => count++, 1);');
  assert.equal(page.run('__awwoAdvanceTo(5)'), MAX_TIMER_FIRINGS);
  assert.equal(page.run('count'), 10_000);
  assert.equal(page.run('performance.now()'), 5);
  assert.equal(page.run('__awwoAdvanceTo(6)'), 50);
  assert.equal(page.run('count'), 10_050);
});

test('animation frames run once per advance with that timestamp', () => {
  const page = load();
  page.run('globalThis.frames = []; const loop = (ts) => { frames.push([ts, performance.now()]); requestAnimationFrame(loop); }; requestAnimationFrame(loop);');
  for (const ms of [0, 1000 / 12, 2000 / 12]) page.run(`__awwoAdvanceTo(${ms})`);
  assert.deepEqual(page.run('JSON.stringify(frames)'), JSON.stringify([[0, 0], [1000 / 12, 1000 / 12], [2000 / 12, 2000 / 12]]));
  page.run("globalThis.order = []; setTimeout(() => requestAnimationFrame(() => order.push('timer-queued')), 10);");
  page.run('__awwoAdvanceTo(400)');
  assert.deepEqual(page.json('order'), ['timer-queued']);
});

test('cancelled animation frames do not run, even within the batch', () => {
  const page = load();
  page.run(`globalThis.ran = [];
    const gone = requestAnimationFrame(() => ran.push('gone'));
    cancelAnimationFrame(gone);
    requestAnimationFrame(() => { ran.push('first'); cancelAnimationFrame(globalThis.second); });
    globalThis.second = requestAnimationFrame(() => ran.push('second'));`);
  page.run('__awwoAdvanceTo(16)');
  assert.deepEqual(page.json('ran'), ['first']);
  assert.throws(() => page.run('requestAnimationFrame(5)'), { name: 'TypeError' });
});

test('an error in a page callback is reported and the clock goes on', () => {
  const page = load();
  page.run("globalThis.after = false; setTimeout(() => { throw new Error('timer boom'); }, 5); setTimeout(() => { after = true; }, 6);");
  page.run("requestAnimationFrame(() => { throw new Error('frame boom'); });");
  page.run('__awwoAdvanceTo(10)');
  assert.equal(page.run('after'), true);
  assert.deepEqual(page.errors.map((error) => error.message), ['timer boom', 'frame boom']);
});

test('a string handler is evaluated as global code', () => {
  const page = load();
  page.run("setTimeout('globalThis.flag = 41 + 1', 0); __awwoAdvanceTo(0)");
  assert.equal(page.run('flag'), 42);
});

test('Math.random is seeded mulberry32 and repeats from page to page', () => {
  const first = load().json('Array.from({ length: 5 }, () => Math.random())');
  const second = load().json('Array.from({ length: 5 }, () => Math.random())');
  assert.deepEqual(first, second);
  assert.equal(first[0], 0.6270739405881613); // the value headless Chrome gave the same script
  assert.ok(first.every((value) => value >= 0 && value < 1));
  assert.equal(new Set(first).size, 5);
});

test('the real requestAnimationFrame stays reachable, and a second install changes nothing', () => {
  const page = load();
  page.run('__awwoRealRaf(() => {})');
  assert.equal(page.realFrames.length, 1);
  page.run('__awwoAdvanceTo(300)');
  page.run(VIRTUAL_TIME_SCRIPT);
  assert.equal(page.run('performance.now()'), 300);
  assert.equal(page.run('Date.now()'), VIRTUAL_EPOCH_MS + 300);
});
