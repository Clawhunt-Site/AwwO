import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
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

test('__awwoClockWaiting counts the callbacks waiting on the clock by kind, as they are set, run and cleared', () => {
  const page = load();
  const counts = () => [0, 1, 2].map((kind) => page.run(`__awwoClockWaiting(${kind})`));
  assert.deepEqual(counts(), [0, 0, 0]);
  page.run(`globalThis.a = setTimeout(() => {}, 10); setTimeout(() => {}, 0); globalThis.i = setInterval(() => {}, 5);
    requestAnimationFrame(() => requestAnimationFrame(() => {})); requestAnimationFrame(() => {});`);
  assert.deepEqual(counts(), [2, 1, 2]);
  assert.equal(page.run('__awwoClockWaiting(3)'), 0, 'without the browser\'s real-time waits there are none');
  page.run('clearTimeout(a)');
  assert.deepEqual(counts(), [1, 1, 2]);
  // The timer due at 0 fires, the interval stays, and of the frames only the one queued during the batch is left.
  page.run('__awwoAdvanceTo(20)');
  assert.deepEqual(counts(), [0, 1, 1]);
  page.run('clearInterval(i); __awwoAdvanceTo(40)');
  assert.deepEqual(counts(), [0, 0, 0]);
  assert.equal(page.run('__awwoClockWaiting()'), 0, 'any other kind counts timeouts');
});

test('__awwoClockWaiting cannot be replaced or removed, and changes nothing', () => {
  const page = load();
  page.run('setTimeout(() => {}, 10);');
  page.run('window.__awwoClockWaiting = () => 99; delete window.__awwoClockWaiting;');
  assert.throws(() => page.run("Object.defineProperty(window, '__awwoClockWaiting', { value: () => 99 })"), { name: 'TypeError' });
  assert.equal(page.run('__awwoClockWaiting(0)'), 1);
  assert.equal(page.run('performance.now()'), 0);
  assert.equal(page.run('__awwoAdvanceTo(10)'), 1);
});

test('__awwoClockWaiting adds the clocks of same-origin frames, which the page cannot hide by replacing window.length', () => {
  const child = load();
  child.run('setTimeout(() => {}, 1); requestAnimationFrame(() => {}); requestAnimationFrame(() => {});');
  const childWindow = child.run('globalThis');
  // A frame whose own properties cannot be read, as a cross-origin one's.
  const foreign = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('SecurityError'); } });
  const frames = [childWindow, foreign];
  const context = vm.createContext({ performance: { now: () => 0 }, requestAnimationFrame: () => 0 });
  Object.defineProperty(context, 'length', { get: () => frames.length, configurable: true });
  frames.forEach((frame, index) => { context[index] = frame; });
  vm.runInContext('globalThis.window = globalThis;', context);
  vm.runInContext(VIRTUAL_TIME_SCRIPT, context);
  vm.runInContext('setInterval(() => {}, 5);', context);
  const counts = () => [0, 1, 2, 3, 4].map((kind) => vm.runInContext(`__awwoClockWaiting(${kind})`, context));
  // The frame of another origin may wait on real time: it counts as one such wait, and as nothing on the clock.
  assert.deepEqual(counts(), [1, 1, 2, 1, 1]);
  // A page script's `var length = 0` replaces the property; the count still comes through the browser's own getter.
  vm.runInContext("Object.defineProperty(window, 'length', { value: 0, writable: true, configurable: true });", context);
  assert.deepEqual(counts(), [1, 1, 2, 1, 1]);
  child.run('__awwoAdvanceTo(5)');
  assert.deepEqual(counts(), [0, 1, 0, 1, 1]);
});

/** A window with this clock whose frames are `frames` (a list it reads live, as the browser's window.length getter). */
function windowWith(frames) {
  const context = vm.createContext({ performance: { now: () => 0 }, requestAnimationFrame: () => 0 });
  Object.defineProperty(context, 'length', { get: () => frames.length, configurable: true });
  for (let index = 0; index < 40; index += 1) Object.defineProperty(context, index, { get: () => frames[index], configurable: true });
  vm.runInContext('globalThis.window = globalThis;', context);
  vm.runInContext(VIRTUAL_TIME_SCRIPT, context);
  return context;
}

test('__awwoClockWaiting counts a frame whose waits on real time it does not read as one that has some, and only for those', () => {
  const kinds = (context) => [0, 1, 2, 3, 4].map((kind) => vm.runInContext(`__awwoClockWaiting(${kind})`, context));
  // 33 frames with this clock and nothing waiting: the 33rd is past the 32 read.
  const frames = Array.from({ length: 33 }, () => windowWith([]));
  const top = windowWith(frames);
  assert.deepEqual(kinds(top), [0, 0, 0, 1, 1]);
  frames.pop();
  assert.deepEqual(kinds(top), [0, 0, 0, 0, 0]);
  // A frame of this origin without this clock (its timers would keep real time).
  frames[5] = vm.createContext({});
  assert.deepEqual(kinds(top), [0, 0, 0, 1, 1]);
  // Five deep: the frame below the fourth is not read.
  let nested = windowWith([]);
  for (let depth = 0; depth < 4; depth += 1) nested = windowWith([nested]);
  assert.deepEqual(kinds(nested), [0, 0, 0, 0, 0]);
  assert.deepEqual(kinds(windowWith([nested])), [0, 0, 0, 1, 1]);
});

/**
 * A fake window with stand-ins for what keeps real time in a browser: an EventTarget that counts each target's listeners,
 * an AbortSignal class of its own (so wrapping its timeout changes nothing outside the page) whose timeout aborts on a
 * real timer, a Scheduler whose postTask runs on one and records the callback and options it is given, and animations:
 * Element.prototype.animate, Animation's play, reverse and startTime, a CSS animation, and the ones the document lists.
 */
function loadRealTime() {
  const listeners = new Map();
  class Target extends EventTarget {
    addEventListener(type, listener, options) { listeners.set(this, (listeners.get(this) ?? 0) + 1); return super.addEventListener(type, listener, options); }
    removeEventListener(type, listener, options) { listeners.set(this, (listeners.get(this) ?? 0) - 1); return super.removeEventListener(type, listener, options); }
  }
  class Signal extends Target {
    #aborted = false;
    get aborted() { return this.#aborted; }
    abort() { if (!this.#aborted) { this.#aborted = true; this.dispatchEvent(new Event('abort')); } }
    static timeout(ms) {
      if (typeof ms !== 'number' || ms < 0) throw new TypeError('the browser refuses that time');
      const signal = new Signal();
      setTimeout(() => signal.abort(), ms);
      return signal;
    }
  }
  const given = [];
  class Scheduler {
    postTask(callback, options = {}) {
      given.push({ callback, options });
      // As WebIDL converts the arguments: the dictionary member by member, each read and then converted before the next
      // is read; anything wrong is the rejected promise the operation returns, never an exception.
      let delay = 0;
      let signal;
      try {
        if (!(this instanceof Scheduler)) throw new TypeError('Illegal invocation');
        const rawDelay = options.delay;
        if (rawDelay !== undefined) delay = Number(rawDelay);
        if (!Number.isFinite(delay) || delay < 0) throw new TypeError('bad delay');
        const rawPriority = options.priority;
        if (rawPriority !== undefined && !['user-blocking', 'user-visible', 'background'].includes(String(rawPriority))) throw new TypeError('bad priority');
        signal = options.signal;
        if (signal !== undefined && !(signal instanceof Signal)) throw new TypeError('bad signal');
      } catch (error) {
        return Promise.reject(error);
      }
      return new Promise((resolve, reject) => {
        if (signal?.aborted) { reject(new Error('aborted before it was posted')); return; }
        const timer = setTimeout(() => { try { resolve(callback()); } catch (error) { reject(error); } }, delay);
        signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); });
      });
    }
  }
  const listed = [];
  class AnimationEffect {
    constructor(endTime) { this.endTime = endTime; }
    getComputedTiming() { return { endTime: this.endTime }; }
  }
  let stateReads = 0;
  class Animation {
    constructor(effect = null) { this.timing = effect; this.state = 'idle'; this.start = null; this.rate = 1; this.current = 0; }
    get playState() { stateReads += 1; return this.state; }
    get playbackRate() { return this.rate; }
    get currentTime() { return this.current; }
    get effect() { return this.timing; }
    play() { this.state = 'running'; }
    // From its start, played backwards it first goes to its end, as a browser's does.
    reverse() { this.state = 'running'; this.rate = -this.rate; if (this.rate < 0 && this.current <= 0 && this.timing) this.current = this.timing.endTime; }
    pause() { this.state = 'paused'; }
    finish() { this.state = 'finished'; }
    get startTime() { return this.start; }
    set startTime(value) { this.start = value; this.state = value === null ? 'paused' : 'running'; }
  }
  class CSSAnimation extends Animation {}
  class Element {
    animate(keyframes, duration) { return Object.assign(new Animation(new AnimationEffect(duration)), { state: 'running' }); }
  }
  class Document { getAnimations() { return [...listed]; } }
  const context = vm.createContext({
    performance: { now: () => 0 }, requestAnimationFrame: () => 0, EventTarget: Target, AbortSignal: Signal, Scheduler, scheduler: new Scheduler(),
    Document, document: new Document(), Animation, AnimationEffect, CSSAnimation, Element,
  });
  vm.runInContext('globalThis.window = globalThis;', context);
  vm.runInContext(VIRTUAL_TIME_SCRIPT, context);
  const run = (code) => vm.runInContext(code, context);
  // An animation running to `end` (or endlessly, or without an effect), made outside the page, so not one it started.
  const runningTo = (end) => Object.assign(new Animation(end === undefined ? null : new AnimationEffect(end)), { state: 'running' });
  return {
    run, real: () => run('__awwoClockWaiting(3)'), json: (code) => JSON.parse(run(`JSON.stringify(${code})`)), given, listed, listeners, runningTo,
    stateReads: () => stateReads,
  };
}

test('__awwoClockWaiting(3) counts AbortSignal.timeout signals until they abort, and the browser\'s own signal comes back', async () => {
  const page = loadRealTime();
  assert.equal(page.real(), 0);
  page.run('globalThis.kept = [AbortSignal.timeout(40), AbortSignal.timeout(120)]; globalThis.fired = 0; kept[0].addEventListener("abort", () => { fired += 1; });');
  assert.equal(page.real(), 2);
  assert.ok(page.run('kept[0] instanceof AbortSignal && !kept[0].aborted'));
  await delay(80);
  assert.deepEqual([page.real(), page.run('fired')], [1, 1]);
  await delay(100);
  assert.equal(page.real(), 0);
  // What the browser refuses it refuses as before, and nothing is counted; the wrapper keeps the function's name and length.
  assert.throws(() => page.run('AbortSignal.timeout(-1)'), { name: 'TypeError', message: 'the browser refuses that time' });
  assert.equal(page.real(), 0);
  assert.deepEqual(page.json('[AbortSignal.timeout.name, AbortSignal.timeout.length]'), ['timeout', 1]);
  assert.deepEqual([0, 1, 2].map((kind) => page.run(`__awwoClockWaiting(${kind})`)), [0, 0, 0], 'real-time waits are not the clock\'s');
});

test('__awwoClockWaiting(3) counts a scheduler.postTask with a delay until it runs or is aborted; one without a delay is the browser\'s own', async () => {
  const page = loadRealTime();
  page.run(`globalThis.out = [];
    globalThis.late = () => 41 + 1;
    scheduler.postTask(late, { delay: 40 }).then((value) => out.push('ran:' + value));
    globalThis.own = () => out.push('now');
    scheduler.postTask(own);
    scheduler.postTask(own, { delay: 0 });`);
  assert.equal(page.real(), 1);
  assert.notEqual(page.given[0].callback, page.run('late'), 'a task with options is posted wrapped, to be counted if it waits');
  assert.equal(page.given[1].callback, page.run('own'), 'a task without options is posted as the page gave it');
  await delay(80);
  assert.equal(page.real(), 0);
  assert.deepEqual(page.json('out'), ['now', 'now', 'ran:42']);
  // Aborted after it was posted, or before: counted until the abort, or not at all; the browser's refusal comes back.
  page.run(`globalThis.later = new AbortSignal(); scheduler.postTask(() => {}, { delay: 5000, signal: later }).catch((error) => out.push(error.message));
    globalThis.before = new AbortSignal(); before.abort(); scheduler.postTask(() => {}, { delay: 5000, signal: before }).catch((error) => out.push(error.message));`);
  assert.equal(page.real(), 1);
  page.run('later.abort()');
  await delay(10);
  assert.equal(page.real(), 0);
  assert.deepEqual(page.json('out.slice(3).sort()'), ['aborted', 'aborted before it was posted']);
  assert.deepEqual(page.json('[Scheduler.prototype.postTask.name, Scheduler.prototype.postTask.length]'), ['postTask', 1]);
});

test('a scheduler.postTask\'s options are read by the browser alone, as it reads them, whatever kind of object holds them', async () => {
  const page = loadRealTime();
  // Each member's getter runs once, and each member is converted before the next is read: the delay's conversion here
  // changes the priority the page gives next.
  page.run(`globalThis.reads = []; globalThis.signal = new AbortSignal(); globalThis.urgent = false;
    globalThis.options = {
      get delay() { reads.push('delay'); return { valueOf() { reads.push('delay converted'); urgent = true; return 40; } }; },
      get priority() { reads.push('priority'); return urgent ? 'user-blocking' : 'background'; },
      get signal() { reads.push('signal'); return signal; } };
    scheduler.postTask(() => {}, options);`);
  assert.deepEqual(page.json('reads'), ['delay', 'delay converted', 'priority', 'signal']);
  assert.equal(page.real(), 1);
  // A function holds options as well as an object does.
  page.run('globalThis.callable = () => {}; callable.delay = 40; scheduler.postTask(() => {}, callable);');
  assert.equal(page.real(), 2);
  await delay(80);
  assert.equal(page.real(), 0);
  // A task that ran no longer listens to its signal: one listener is left, the browser's own.
  assert.equal(page.listeners.get(page.run('signal')), 1);
});

test('a scheduler.postTask the browser refuses is refused as before, with a rejected promise, and never counted', async () => {
  const page = loadRealTime();
  page.run(`globalThis.refused = [];
    const kept = (promise) => { promise.catch((error) => refused.push(error.message)); };
    kept(scheduler.postTask(() => {}, { get delay() { throw new Error('a getter that throws'); } }));
    kept(scheduler.postTask(() => {}, { delay: 40, get priority() { throw new Error('a later getter that throws'); } }));
    kept(scheduler.postTask(() => {}, { delay: 40, priority: 'urgent' }));
    kept(scheduler.postTask(() => {}, { delay: Symbol('x') }));
    kept(scheduler.postTask(() => {}, { delay: Infinity }));
    kept(scheduler.postTask(() => {}, { delay: 40, signal: null }));
    kept(Scheduler.prototype.postTask.call({}, () => {}, { delay: 40 }));
    kept(scheduler.postTask(() => {}, { delay: null }));`);
  assert.equal(page.real(), 0, 'nothing refused is counted, nor a delay the browser reads as none');
  await delay(10);
  assert.deepEqual(page.json('refused').sort(), ['Cannot convert a Symbol value to a number', 'Illegal invocation', 'a getter that throws',
    'a later getter that throws', 'bad delay', 'bad priority', 'bad signal']);
  // Options the page converts itself, and a signal of the wrong kind, are taken for a delay the browser waits out until
  // it refuses the task: the count ends with the rejection, which reaches the page as before.
  page.run(`globalThis.later = [];
    const keptLater = (promise) => { promise.catch((error) => later.push(error.message)); };
    keptLater(scheduler.postTask(() => {}, { delay: { valueOf() { throw new Error('a delay that does not convert'); } } }));
    keptLater(scheduler.postTask(() => {}, { delay: 40, priority: { toString: () => 'urgent' } }));
    keptLater(scheduler.postTask(() => {}, { delay: 40, signal: new EventTarget() }));`);
  await delay(10);
  assert.equal(page.real(), 0);
  assert.deepEqual(page.json('later').sort(), ['a delay that does not convert', 'bad priority', 'bad signal']);
});

test('__awwoClockWaiting(4) counts the animations the page started from script while they run to an end, in the document or not', () => {
  const page = loadRealTime();
  const animations = () => page.run('__awwoClockWaiting(4)');
  page.run(`globalThis.detached = new Element().animate([], 6500);
    globalThis.free = new Animation(new AnimationEffect(6500)); free.play();
    globalThis.back = new Animation(new AnimationEffect(6500)); back.reverse();
    globalThis.timed = new Animation(new AnimationEffect(6500)); timed.startTime = 0;
    globalThis.endless = new Element().animate([], Infinity);
    globalThis.never = new Animation(new AnimationEffect(6500));`);
  assert.equal(animations(), 4, 'the four running to an end, which the document does not list; not the endless one, nor the one never started');
  assert.equal(page.real(), 0, 'they are not counted with the waits read at every reading');
  page.run('detached.pause(); free.finish(); timed.startTime = null;');
  assert.equal(animations(), 1);
  page.run('free.play()');
  assert.equal(animations(), 2, 'played again, it counts again');
  assert.deepEqual(page.json(`[Element.prototype.animate.name, Element.prototype.animate.length, Animation.prototype.play.name, Animation.prototype.play.length,
    Animation.prototype.reverse.name, Object.getOwnPropertyDescriptor(Animation.prototype, 'startTime').set.name]`), ['animate', 1, 'play', 0, 'reverse', 'set startTime']);
});

test('an animation played backwards runs to an end from a time past its start, even an endless one; one at a rate of 0 does not', () => {
  const page = loadRealTime();
  const animations = () => page.run('__awwoClockWaiting(4)');
  page.run('globalThis.intro = new Element().animate([], Infinity); intro.current = 6500; intro.reverse();');
  assert.equal(animations(), 1, 'an endless one going back to its start from 6.5 s in');
  page.run('intro.current = 0;');
  assert.equal(animations(), 0, 'back at its start, it has finished');
  page.run('globalThis.stopped = new Element().animate([], 6500); stopped.rate = 0;');
  assert.equal(animations(), 0, 'at a rate of 0 it never reaches its end');
});

test('keeping the animations a page starts reads none of them, and one it retimes to an end counts, once however often played', () => {
  const page = loadRealTime();
  page.run('globalThis.kept = []; for (let i = 0; i < 1000; i += 1) kept.push(new Element().animate([], Infinity));');
  assert.equal(page.stateReads(), 0, 'no animation is read while animations are kept');
  assert.equal(page.real(), 0, 'nor while the waits read at every reading are counted');
  assert.equal(page.stateReads(), 0);
  assert.equal(page.run('__awwoClockWaiting(4)'), 0);
  // Endless ones retimed to an end, which nothing wrapped sees.
  page.run('kept[7].effect.endTime = 6500; kept[8].effect.endTime = 6500; kept[8].play(); kept[8].play();');
  assert.equal(page.run('__awwoClockWaiting(4)'), 2);
});

test('__awwoClockWaiting(4) counts the document\'s animations running towards an end too, CSS ones among them once', () => {
  const page = loadRealTime();
  page.run('globalThis.css = new CSSAnimation(new AnimationEffect(6500)); css.play();');
  assert.equal(page.run('__awwoClockWaiting(4)'), 0, 'a CSS animation played from script is the document\'s to list, not kept');
  page.listed.push(page.runningTo(6000), page.runningTo(Infinity), Object.assign(page.runningTo(6000), { state: 'paused' }),
    Object.assign(page.runningTo(6000), { state: 'finished' }), page.runningTo(undefined), page.runningTo(300), page.run('css'));
  assert.equal(page.run('__awwoClockWaiting(4)'), 3);
  assert.equal(page.real(), 0);
  page.listed.splice(0);
  assert.equal(page.run('__awwoClockWaiting(4)'), 0);
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
