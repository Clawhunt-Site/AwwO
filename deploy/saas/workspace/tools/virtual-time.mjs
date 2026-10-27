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
//
// __awwoClockWaiting(kind): how many callbacks wait on this clock and on the clocks of the frame's same-origin frames
// (kind 0: setTimeout timers, 1: setInterval timers, 2: animation-frame callbacks), and how many waits they have that
// keep real time, so the renderer can tell a page that waits on its own clock from one that is still at work
// (held-clock.mjs): kind 3, AbortSignal.timeout signals not yet aborted and scheduler.postTask tasks with a delay
// neither run nor aborted, counted as they come; kind 4, the animations running towards an end, the document's own
// (CSS ones too, which resolves its styles) and those the page started from script (animate(), play(), reverse() or a
// start time; on an element of the document or not), which take reading each, so the renderer asks for them only when
// nothing else is under way; for both, one more for each frame whose waits cannot be read (past the first 32 or 4 deep,
// of another origin, or without this clock).
// It changes nothing, and the page can neither replace it nor hide its frames from it (the frame count is read through
// the getter as it was before any page script). To count those waits, AbortSignal.timeout, Scheduler.prototype.postTask,
// Element.prototype.animate and Animation.prototype's play, reverse and startTime are wrapped: the browser's own
// functions do the work, and the page gets what they give (but for a scheduler.postTask that is counted, whose promise
// the page gets is one that follows the browser's, so that a refusal ends its count).

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

  const apply = Reflect.apply;
  const describe = Object.getOwnPropertyDescriptor;
  const frameCount = (describe(w, 'length') || {}).get;

  // Waits that keep real time (kinds 3 and 4), so that a page waiting on one is at work rather than held on this clock.
  // What they are counted with is kept as it was before any page script, which could replace it.
  let realWaits = 0;
  const EventTargetProto = w.EventTarget ? w.EventTarget.prototype : null;
  const listen = EventTargetProto ? EventTargetProto.addEventListener : null;
  const unlisten = EventTargetProto ? EventTargetProto.removeEventListener : null;
  const onAbort = (target, settle) => {
    if (typeof listen !== 'function') return false;
    try { apply(listen, target, ['abort', settle, { once: true }]); return true; } catch (ignored) { return false; }
  };
  const offAbort = (target, settle) => {
    if (typeof unlisten === 'function') { try { apply(unlisten, target, ['abort', settle]); } catch (ignored) {} }
  };
  const wrap = (owner, name, make) => {
    const own = owner ? describe(owner, name) : null;
    if (!own || typeof own.value !== 'function') return;
    try { Object.defineProperty(owner, name, { ...own, value: make(own.value) }); } catch (ignored) { /* left as it was */ }
  };
  const Signal = w.AbortSignal;
  const abortedOf = Signal ? (describe(Signal.prototype, 'aborted') || {}).get : null;
  // Each wrapper keeps its function's name and length (the arguments it requires) and passes on what it is given.
  wrap(Signal, 'timeout', (real) => ({ timeout(milliseconds) {
    const signal = apply(real, this, arguments);
    realWaits += 1;
    if (!onAbort(signal, () => { realWaits -= 1; })) realWaits -= 1;
    return signal;
  } }).timeout);
  // A task's options are given to the browser through getters that read the page's own as the browser asks for them, so
  // it reads, converts and refuses them as before (a getter that throws is a rejected promise, its conversions keep their
  // order). Then the task is counted if what it read is a delay it will wait out: a positive one, unless what was read
  // shows the browser refused the task (a priority or signal of the wrong kind; a receiver that is not a scheduler is
  // refused before anything is read); a delay or priority the browser converts by running the page's code is taken
  // for a valid one.
  const define = Object.defineProperty;
  const then = Promise.prototype.then;
  const toNumber = Number;
  const toText = String;
  const owns = Object.prototype.isPrototypeOf;
  const SchedulerProto = w.Scheduler ? w.Scheduler.prototype : null;
  const MEMBERS = ['delay', 'priority', 'signal'];
  const PRIORITIES = ['user-blocking', 'user-visible', 'background'];
  const LONGEST = Number.MAX_SAFE_INTEGER;
  const plain = (value) => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
  const waitsOut = (delay) => {
    if (typeof delay === 'function') return true;
    if (typeof delay === 'object') return delay !== null;
    if (!plain(delay)) return false;
    const ms = toNumber(delay);
    return ms > 0 && ms <= LONGEST;
  };
  const takes = (priority) => {
    if (priority === undefined || typeof priority === 'function') return true;
    if (typeof priority === 'object') return priority !== null;
    if (!plain(priority)) return false;
    const name = toText(priority);
    return name === PRIORITIES[0] || name === PRIORITIES[1] || name === PRIORITIES[2];
  };
  const instance = (proto, value) => { try { return proto !== null && apply(owns, proto, [value]); } catch (ignored) { return false; } };
  wrap(SchedulerProto, 'postTask', (real) => ({ postTask(callback) {
    const given = arguments[1];
    if (typeof callback !== 'function' || given === null || given === undefined || (typeof given !== 'object' && typeof given !== 'function')) return apply(real, this, arguments);
    const read = { __proto__: null, threw: false, delay: undefined, priority: undefined, signal: undefined };
    const options = {};
    for (let index = 0; index < 3; index += 1) {
      const name = MEMBERS[index];
      define(options, name, { __proto__: null, enumerable: true, get() {
        try { const value = given[name]; read[name] = value; return value; } catch (error) { read.threw = true; throw error; }
      } });
    }
    let counted = false;
    let pending = true;
    const settle = () => {
      if (!pending) return;
      pending = false;
      if (!counted) return;
      realWaits -= 1;
      if (read.signal !== undefined) offAbort(read.signal, settle);
    };
    const promise = apply(real, this, [function task() { settle(); return apply(callback, this, arguments); }, options]);
    const { delay, priority, signal } = read;
    if (pending && !read.threw && waitsOut(delay) && takes(priority)
      && (signal === undefined || (signal !== null && typeof signal === 'object'))) {
      counted = true;
      realWaits += 1;
      if (signal !== undefined) {
        // The browser's own getter checks what it is given, a signal of another frame's too.
        let aborted = false;
        try { aborted = typeof abortedOf === 'function' && apply(abortedOf, signal, []) === true; } catch (ignored) {}
        if (aborted || !onAbort(signal, settle)) settle();
      }
      // A task the browser refused all the same (an option it refused only as it converted it) ends its count when its
      // promise is rejected: the page gets the promise that follows it, so the rejection reaches the page as before.
      if (pending) {
        try { return apply(then, promise, [undefined, (error) => { settle(); throw error; }]); } catch (ignored) { /* not a promise */ }
      }
    }
    return promise;
  } }).postTask);

  const Anim = w.Animation ? w.Animation.prototype : null;
  const playStateOf = Anim ? (describe(Anim, 'playState') || {}).get : null;
  const effectOf = Anim ? (describe(Anim, 'effect') || {}).get : null;
  const timingOf = w.AnimationEffect ? (describe(w.AnimationEffect.prototype, 'getComputedTiming') || {}).value : null;
  const rateOf = Anim ? (describe(Anim, 'playbackRate') || {}).get : null;
  const currentOf = Anim ? (describe(Anim, 'currentTime') || {}).get : null;
  const canRead = typeof playStateOf === 'function' && typeof effectOf === 'function' && typeof timingOf === 'function';
  // Whether an animation runs towards an end (a CSS animation's state resolves the document's styles first): forwards
  // to an end it has, or backwards to its start from a time past it; one at a rate of 0 never gets there.
  const toAnEnd = (animation) => {
    try {
      if (apply(playStateOf, animation, []) !== 'running' || !apply(effectOf, animation, [])) return false;
      const rate = typeof rateOf === 'function' ? apply(rateOf, animation, []) : 1;
      if (rate > 0) return apply(timingOf, apply(effectOf, animation, []), []).endTime !== Infinity;
      const current = rate < 0 && typeof currentOf === 'function' ? apply(currentOf, animation, []) : null;
      return typeof current === 'number' && current > 0;
    } catch (ignored) { return false; }
  };
  // The animations the page starts from script, CSS animations and transitions apart (getAnimations, below, lists those
  // with the document's). Each is kept as long as the page can reach it, weakly, whatever its state:
  // a page may yet retime or extend one that does not run to an end now, through nothing that is wrapped. Those the
  // page has let go are swept out whenever the list has doubled since it was last swept, so keeping them costs little.
  const setAdd = Set.prototype.add;
  const setDelete = Set.prototype.delete;
  const setValues = Set.prototype.values;
  const sizeOf = describe(Set.prototype, 'size').get;
  const nextOf = Object.getPrototypeOf(new Set().values()).next;
  const Weak = typeof w.WeakRef === 'function' ? w.WeakRef : null;
  const derefOf = Weak ? Weak.prototype.deref : null;
  const mapHas = WeakMap.prototype.has;
  const mapSet = WeakMap.prototype.set;
  const construct = Reflect.construct;
  const styled = [w.CSSAnimation, w.CSSTransition].filter((type) => typeof type === 'function').map((type) => type.prototype);
  const started = new Set();
  const noted = new WeakMap();
  let sweepAt = 256;
  // Visits each animation still kept (deleting those let go); visit answers whether to count it.
  const keptAnimations = (visit) => {
    let count = 0;
    const iterator = apply(setValues, started, []);
    for (let step = apply(nextOf, iterator, []); !step.done; step = apply(nextOf, iterator, [])) {
      const animation = Weak ? apply(derefOf, step.value, []) : step.value;
      if (animation === undefined) apply(setDelete, started, [step.value]);
      else if (visit(animation)) count += 1;
    }
    return count;
  };
  const scriptAnimations = () => (canRead ? keptAnimations(toAnEnd) : 0);
  const note = (animation) => {
    for (let index = 0; index < styled.length; index += 1) if (instance(styled[index], animation)) return;
    try {
      if (apply(mapHas, noted, [animation])) return;
      apply(mapSet, noted, [animation, true]);
      if (apply(sizeOf, started, []) >= sweepAt) {
        keptAnimations(() => false);
        const size = apply(sizeOf, started, []);
        sweepAt = size * 2 > 256 ? size * 2 : 256;
      }
      apply(setAdd, started, [Weak ? construct(Weak, [animation]) : animation]);
    } catch (ignored) {}
  };
  wrap(w.Element ? w.Element.prototype : null, 'animate', (real) => ({ animate(keyframes) {
    const animation = apply(real, this, arguments);
    note(animation);
    return animation;
  } }).animate);
  wrap(Anim, 'play', (real) => ({ play() { const result = apply(real, this, arguments); note(this); return result; } }).play);
  wrap(Anim, 'reverse', (real) => ({ reverse() { const result = apply(real, this, arguments); note(this); return result; } }).reverse);
  const startOf = Anim ? describe(Anim, 'startTime') : null;
  if (startOf && typeof startOf.set === 'function') {
    const realSet = startOf.set;
    const set = describe({ set startTime(value) { apply(realSet, this, [value]); note(this); } }, 'startTime').set;
    try { Object.defineProperty(Anim, 'startTime', { ...startOf, set }); } catch (ignored) { /* left as it was */ }
  }
  const getAnimations = w.Document ? (describe(w.Document.prototype, 'getAnimations') || {}).value : null;
  const documentAnimations = () => {
    let count = 0;
    if (!canRead || typeof getAnimations !== 'function') return count;
    let list = [];
    try { list = apply(getAnimations, w.document, []); } catch (ignored) { return count; }
    for (let index = 0; index < list.length; index += 1) if (toAnEnd(list[index])) count += 1;
    return count;
  };

  const waiting = (kind, depth) => {
    let count = 0;
    if (kind === 4) count = documentAnimations() + scriptAnimations();
    else if (kind === 3) count = realWaits > 0 ? realWaits : 0;
    else if (kind === 2) count = frameQueue.size;
    else for (const timer of timers.values()) if (timer.repeat === (kind === 1)) count += 1;
    let frames = 0;
    if (typeof frameCount === 'function') { try { frames = apply(frameCount, w, []); } catch (ignored) {} }
    const read = depth < 4 ? (frames < 32 ? frames : 32) : 0;
    // A frame whose waits on real time cannot be read (past the first 32 or 4 deep, of another origin, or without this
    // clock) may have some: it counts as one.
    const unread = kind >= 3 ? 1 : 0;
    if (frames > read) count += unread;
    for (let index = 0; index < read; index += 1) {
      try {
        const own = describe(w[index], '__awwoClockWaiting');
        const more = own && typeof own.value === 'function' ? own.value(kind, depth + 1) : unread;
        if (typeof more === 'number' && more > 0) count += more;
      } catch (ignored) { count += unread; }
    }
    return count;
  };
  Object.defineProperty(w, '__awwoClockWaiting', {
    value: (kind, depth) => waiting(kind === 1 || kind === 2 || kind === 3 || kind === 4 ? kind : 0, typeof depth === 'number' && depth >= 1 && depth <= 4 ? depth | 0 : 0),
    writable: false, configurable: false, enumerable: false,
  });

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
