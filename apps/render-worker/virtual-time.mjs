// The virtual clock a page without window.renderAt(t) renders on. Injected before any page script (and into every
// frame), it replaces what an animation reads time and chance from: performance.now, Date.now and an argument-less
// new Date(), requestAnimationFrame, setTimeout/setInterval and Math.random. Time stands still at 0 until the
// renderer calls window.__awwoAdvanceTo(ms) for a frame, so frame i shows exactly t = i / fps however long the
// screenshot took, and the same page renders the same frames every time.
//
// __awwoAdvanceTo(ms): moves the clock to ms, firing every timer due by then in due order (a timer sees the clock at
// its own due time; intervals re-arm from their due time, so they never drift; at most 10,000 firings a call), then
// runs the animation-frame callbacks queued so far once with timestamp ms. Callbacks they queue wait for the next
// call, as in a browser, where callbacks a timer queues before a frame also run in that frame.
// The real requestAnimationFrame stays reachable as window.__awwoRealRaf for the renderer to wait for paint.

export const VIRTUAL_EPOCH_MS = Date.UTC(2026, 0, 1);
export const MAX_TIMER_FIRINGS = 10_000;

export const VIRTUAL_TIME_SCRIPT = `(() => {
  'use strict';
  const w = window;
  if (typeof w.__awwoAdvanceTo === 'function') return;
  const EPOCH = ${VIRTUAL_EPOCH_MS};
  const MAX_FIRINGS = ${MAX_TIMER_FIRINGS};
  const RealDate = w.Date;
  const realRaf = typeof w.requestAnimationFrame === 'function' ? w.requestAnimationFrame.bind(w) : null;
  const realSetTimeout = typeof w.setTimeout === 'function' ? w.setTimeout.bind(w) : null;
  const realReportError = typeof w.reportError === 'function' ? w.reportError.bind(w) : null;
  let clock = 0;
  let nextId = 1;
  let order = 0;
  let nesting = 0;
  const timers = new Map();
  let frameQueue = new Map();
  let runningBatch = null;

  // An error in a page callback is reported as uncaught, as a browser would, and never stops the clock.
  const report = (error) => {
    if (realReportError) { try { realReportError(error); return; } catch (ignored) {} }
    if (realSetTimeout) realSetTimeout(() => { throw error; }, 0);
  };

  // WebIDL long conversion and the HTML timer clamp: after five nested levels a delay is at least 4 ms.
  const addTimer = (handler, delay, args, repeat) => {
    let ms = Number(delay) | 0;
    if (ms < 0) ms = 0;
    if (nesting > 5 && ms < 4) ms = 4;
    const callback = typeof handler === 'function' ? handler : () => (0, eval)(String(handler));
    const id = nextId++;
    timers.set(id, { id, callback, args, delay: ms, repeat, due: clock + ms, order: order++, nesting: nesting + 1 });
    return id;
  };
  w.setTimeout = function setTimeout(handler, delay, ...args) { return addTimer(handler, delay, args, false); };
  w.setInterval = function setInterval(handler, delay, ...args) { return addTimer(handler, delay, args, true); };
  w.clearTimeout = function clearTimeout(id) { timers.delete(Number(id)); };
  w.clearInterval = function clearInterval(id) { timers.delete(Number(id)); };

  w.requestAnimationFrame = function requestAnimationFrame(callback) {
    if (typeof callback !== 'function') throw new TypeError('requestAnimationFrame needs a function');
    const id = nextId++;
    frameQueue.set(id, callback);
    return id;
  };
  w.cancelAnimationFrame = function cancelAnimationFrame(id) {
    const key = Number(id);
    frameQueue.delete(key);
    if (runningBatch) runningBatch.delete(key);
  };

  const nextDue = (limit) => {
    let best = null;
    for (const timer of timers.values()) {
      if (timer.due <= limit && (!best || timer.due < best.due || (timer.due === best.due && timer.order < best.order))) best = timer;
    }
    return best;
  };

  w.__awwoAdvanceTo = function advanceTo(ms) {
    const requested = Number(ms);
    if (!Number.isFinite(requested)) throw new TypeError('virtual time must be a finite number');
    const target = Math.max(clock, requested);
    let fired = 0;
    while (fired < MAX_FIRINGS) {
      const timer = nextDue(target);
      if (!timer) break;
      if (timer.due > clock) clock = timer.due;
      if (!timer.repeat) timers.delete(timer.id);
      fired += 1;
      nesting = timer.nesting;
      try { timer.callback.apply(w, timer.args); } catch (error) { report(error); }
      nesting = 0;
      if (timer.repeat && timers.get(timer.id) === timer) {
        let period = timer.delay;
        if (timer.nesting > 5 && period < 4) period = 4;
        timer.nesting += 1;
        timer.due += period;
        timer.order = order++;
      }
    }
    clock = target;
    runningBatch = frameQueue;
    frameQueue = new Map();
    for (const callback of runningBatch.values()) {
      try { callback.call(w, target); } catch (error) { report(error); }
    }
    runningBatch = null;
    return fired;
  };

  function Date(...args) {
    if (!new.target) return new RealDate(EPOCH + clock).toString();
    return Reflect.construct(RealDate, args.length === 0 ? [EPOCH + clock] : args, new.target);
  }
  Date.prototype = RealDate.prototype;
  Date.now = function now() { return EPOCH + clock; };
  Date.parse = RealDate.parse;
  Date.UTC = RealDate.UTC;
  try { Object.defineProperty(Date, 'length', { value: 7 }); } catch (ignored) {}
  try { Object.defineProperty(RealDate.prototype, 'constructor', { value: Date, writable: true, configurable: true }); } catch (ignored) {}
  w.Date = Date;

  if (w.performance) {
    try { w.performance.now = function now() { return clock; }; } catch (ignored) {}
  }

  // mulberry32, seeded with 1.
  let seed = 1;
  Math.random = function random() {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  w.__awwoRealRaf = realRaf;
})();`;
