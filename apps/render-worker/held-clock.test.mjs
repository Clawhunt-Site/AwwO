// The held-clock watch without a browser: a stand-in DevTools session answers each reading as a test scripts it, on a
// clock of its own, so every rule of watchHeldClock is pinned in milliseconds of real time; and trackActivity and the
// quota reading against stand-ins for Playwright's context and page and for the files of a control group.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import vm from 'node:vm';
import {
  allowedCpus, ANIMATION_PROBE, childCpu, CLOCK_PROBE, cpuBetween, describeHost, HELD_CLOCK_MS, heldClockMessage, hostIdle, openWatch, ownThrottling, parseWaiting,
  quotaGroups, quotaLimit, quotaReading, statIdle, throttledMicros, throttleFiles, toldApart, trackActivity, waitingWords, watchHeldClock,
} from './held-clock.mjs';
import { VIRTUAL_TIME_SCRIPT } from './virtual-time.mjs';

/**
 * A page as the watch sees it (openWatch's answer, and the clock its readings are timed by). `page` is what each reading
 * finds (changed by `step(reading, state)` before it is taken): `waiting` (the probe's answer: setTimeout, setInterval
 * and frame callbacks, and waits on real time), `cpu` (the CPU seconds per second the page's renderer took since the
 * last reading), `answers` (false: the probe never answers), `broken` (the probe throws), `exception` (the probe's
 * expression threw), `noCpu` (the browser lists no CPU time), `gpuGone` (the GPU process is not listed), `more` (other
 * processes listed), `animations` (the document's animations running to an end, ANIMATION_PROBE's answer, which
 * `animationReadings` counts). Each reading is 0.25 s after the one before; it sends the probe first.
 */
function fakePage(page = {}, step = () => {}) {
  const state = { waiting: '1,0,0,0', cpu: 0, answers: true, broken: false, gpuGone: false, more: [], animations: '0', ...page };
  let at = 1000;
  let cpu = 7;
  const fake = { readings: 0, animationReadings: 0, state, clock: () => at };
  fake.watched = {
    activity: { events: 0, atWork: () => false },
    cdp: {
      async send(method, { expression } = {}) {
        assert.equal(method, 'Runtime.evaluate');
        if (expression === ANIMATION_PROBE) {
          fake.animationReadings += 1;
          return { result: { type: 'string', value: state.animations } };
        }
        assert.equal(expression, CLOCK_PROBE);
        fake.readings += 1;
        step(fake.readings, state);
        if (!state.answers) return new Promise(() => {});
        if (state.broken) throw new Error('Target closed');
        return state.exception ? { exceptionDetails: { text: 'x' } } : { result: { type: 'string', value: state.waiting } };
      },
    },
    processes: {
      async send(method) {
        assert.equal(method, 'SystemInfo.getProcessInfo');
        at += 0.25;
        cpu += state.cpu * 0.25;
        // The browser's own process takes CPU of its own, which is not the page's.
        const listed = [{ type: 'browser', id: 1, cpuTime: 50 + at }, { type: 'renderer', id: 2, cpuTime: cpu }, ...(state.gpuGone ? [] : [{ type: 'GPU', id: 3, cpuTime: 2 }]), ...state.more];
        return { processInfo: state.noCpu ? [] : listed };
      },
    },
  };
  return fake;
}
/**
 * A host with `spare` of its CPUs idle from now on, on a clock of its own: each reading is 250 ms after the one before.
 * `before` is the idle time it had already (milliseconds, as at boot an hour ago); `throttled(reading)` the microseconds
 * its quota held the process back so far; `place(reading)` where it was read (the CPUs and groups of the process).
 */
function fakeHost(spare, before = 0, throttled = () => 0, place = () => '0-3\n0::/render') {
  let at = 3_600_000;
  let idle = before;
  let reading = 0;
  return () => { at += 250; idle += spare * 250; reading += 1; return { idle, at, place: place(reading), throttled: throttled(reading) }; };
}
/** A watch that reads the page as fast as it can, holding it after 1 s of its stand-in time. */
const fast = (spare = 4) => ({ stallMs: 1000, sampleMs: 1, readingMs: 40, host: fakeHost(spare) });
/** The watch's answer, or 'not held' when it has none within ms of real time; the watch is stopped either way. */
async function heldWithin(fake, ms, options = fast(), activity = undefined) {
  const watch = watchHeldClock(activity ? { ...fake.watched, activity } : fake.watched, { clock: fake.clock, ...options });
  try {
    return await Promise.race([watch.held, delay(ms, 'not held')]);
  } finally {
    watch.stop();
  }
}

test('a page with callbacks on its clock and nothing else going on is held once that has lasted stallMs', async () => {
  const fake = fakePage({ waiting: '1,0,2,0' });
  assert.deepEqual(await heldWithin(fake, 2000), { setTimeout: 1, setInterval: 0, requestAnimationFrame: 2 });
  // The first reading only starts the count; four quarter-seconds after it make the stall's second.
  assert.equal(fake.readings, 5);
});

test('a page at work is never held, however long it waits: CPU at a quarter or more, or work beside it', async () => {
  assert.equal(await heldWithin(fakePage({ cpu: 0.25 }), 300), 'not held');
  assert.equal(await heldWithin(fakePage({ cpu: 1.2 }), 300), 'not held');
  assert.deepEqual(await heldWithin(fakePage({ cpu: 0.24 }), 2000), { setTimeout: 1, setInterval: 0, requestAnimationFrame: 0 });
  // A request, a worker, a sound or a video at work, or a frame of another origin (trackActivity).
  assert.equal(await heldWithin(fakePage(), 300, fast(), { events: 0, atWork: () => true }), 'not held');
  // Work that began and ended between two readings is work too.
  const busy = { events: 0, atWork: () => false };
  const fake = fakePage({}, () => { busy.events += 1; });
  assert.equal(await heldWithin(fake, 300, fast(), busy), 'not held');
  assert.ok(fake.readings > 10, `${fake.readings} readings`);
});

test('nothing waiting on the clock is never held: the page waits on something else, which the render\'s own limits bound', async () => {
  assert.equal(await heldWithin(fakePage({ waiting: '0,0,0,0' }), 300), 'not held');
});

test('the document\'s animations are asked only of a reading that finds the page quiet otherwise, and one running to an end is work', async () => {
  // Busy, or at work beside its CPU time: never asked, so a page at work never has its styles resolved for the watch.
  const busy = fakePage({ cpu: 2 });
  assert.equal(await heldWithin(busy, 300), 'not held');
  assert.equal(busy.animationReadings, 0);
  const working = fakePage();
  assert.equal(await heldWithin(working, 300, fast(), { events: 0, atWork: () => true }), 'not held');
  assert.equal(working.animationReadings, 0);
  // Quiet but for an animation running to its end, or an answer that is not a count: never held.
  const animated = fakePage({ animations: '1' });
  assert.equal(await heldWithin(animated, 300), 'not held');
  assert.ok(animated.animationReadings > 0);
  assert.equal(await heldWithin(fakePage({ animations: 'x' }), 300), 'not held');
  // The animation ends after reading 4: held a stall after.
  const ends = fakePage({}, (reading, state) => { state.animations = reading <= 4 ? '1' : '0'; });
  assert.ok(await heldWithin(ends, 2000));
  assert.equal(ends.readings, 8);
});

test('a change in the CPUs or the control group of the process starts the count again, and throttling that cannot be read keeps a page from being held', async () => {
  // The CPUs it may run on narrowed at reading 4; the process moved to another group at reading 4.
  const narrowed = fakePage();
  assert.ok(await heldWithin(narrowed, 2000, { ...fast(), host: fakeHost(4, 0, () => 0, (reading) => (reading >= 4 ? '0\n0::/render' : '0-1\n0::/render')) }));
  assert.equal(narrowed.readings, 8);
  const moved = fakePage();
  assert.ok(await heldWithin(moved, 2000, { ...fast(), host: fakeHost(4, 0, () => 0, (reading) => (reading >= 4 ? '0-1\n0::/slow' : '0-1\n0::/render')) }));
  assert.equal(moved.readings, 8);
  assert.equal(await heldWithin(fakePage(), 300, { ...fast(), host: fakeHost(4, 0, () => Number.NaN) }), 'not held');
});

test('work that begins while the document\'s animations are asked about keeps the page from being held', async () => {
  // A request starts and ends while the animation probe of reading 5, the last of the stall, is answered: reading 5 is
  // not quiet, nor reading 6, which sees the change since reading 5's count; the stall counts from reading 6.
  const busy = { events: 0, atWork: () => false };
  const fake = fakePage();
  const send = fake.watched.cdp.send;
  fake.watched.cdp.send = async (method, params) => {
    if (params?.expression === ANIMATION_PROBE && fake.readings === 5) busy.events += 1;
    return send(method, params);
  };
  assert.ok(await heldWithin(fake, 2000, fast(), busy));
  assert.equal(fake.readings, 10);
  // Work under way only while that probe is answered (a worker alive just then): reading 5 is not quiet either.
  let during = false;
  const transient = { events: 0, atWork: () => during };
  const brief = fakePage();
  const sendBrief = brief.watched.cdp.send;
  brief.watched.cdp.send = async (method, params) => {
    during = params?.expression === ANIMATION_PROBE && brief.readings === 5;
    return sendBrief(method, params);
  };
  assert.ok(await heldWithin(brief, 2000, fast(), transient));
  assert.equal(brief.readings, 9);
});

test('a page with a wait that keeps real time is at work, not held, until that wait is over', async () => {
  // An AbortSignal.timeout, a delayed scheduler.postTask or an animation running to its end (virtual-time.mjs, kind 3).
  assert.equal(await heldWithin(fakePage({ waiting: '1,1,1,1' }), 300), 'not held');
  // Seen in readings 1 to 4: the stall counts from reading 4, as after any work.
  const fake = fakePage({}, (reading, state) => { state.waiting = reading <= 4 ? '1,0,0,2' : '1,0,0,0'; });
  assert.deepEqual(await heldWithin(fake, 2000), { setTimeout: 1, setInterval: 0, requestAnimationFrame: 0 });
  assert.equal(fake.readings, 8);
});

test('the CPU time is each process\'s own: one that ends between two readings, or one that starts and works, starts the count again', async () => {
  // A process gone, which took an unknown share of the time before it ended (where a sum of all would go backwards).
  const gone = fakePage({}, (reading, state) => { state.gpuGone = reading >= 4; });
  assert.ok(await heldWithin(gone, 2000));
  assert.equal(gone.readings, 8);
  // A process that starts, having taken 3 s already; one that starts idle is no work.
  const started = fakePage({}, (reading, state) => { state.more = reading >= 4 ? [{ type: 'utility', id: 9, cpuTime: 3 }] : []; });
  assert.ok(await heldWithin(started, 2000));
  assert.equal(started.readings, 8);
  const idle = fakePage({}, (reading, state) => { state.more = reading >= 4 ? [{ type: 'utility', id: 9, cpuTime: 0 }] : []; });
  assert.ok(await heldWithin(idle, 2000));
  assert.equal(idle.readings, 5);
});

test('a page on a host without half a CPU to spare, or held back for its CPU quota, is never held: its renderer may only be waiting its turn', async () => {
  assert.equal(await heldWithin(fakePage(), 300, fast(0.49)), 'not held');
  assert.deepEqual(await heldWithin(fakePage(), 2000, fast(0.5)), { setTimeout: 1, setInterval: 0, requestAnimationFrame: 0 });
  // What counts is the time between readings, not the hours of idle time the host had before.
  assert.equal(await heldWithin(fakePage(), 300, { ...fast(), host: fakeHost(0, 4 * 3_600_000) }), 'not held');
  // A host whose CPUs cannot be read counts as having none to spare.
  assert.equal(await heldWithin(fakePage(), 300, { ...fast(), host: () => ({ idle: 0, at: performance.now(), throttled: 0 }) }), 'not held');
  // The control group held back for its quota between two readings, by more than this process's CPU time (a host that
  // does not tell its groups' CPU time apart, as here): the count starts again after it.
  const fake = fakePage();
  assert.ok(await heldWithin(fake, 2000, { ...fast(), host: fakeHost(4, 0, (reading) => (reading >= 4 ? 900 : 0)) }));
  assert.equal(fake.readings, 8);
  assert.equal(await heldWithin(fakePage(), 300, { ...fast(), host: fakeHost(4, 0, (reading) => reading * 10) }), 'not held');
});

/**
 * A host as hostIdle reads one in cgroup v2, each reading 250 ms after the one before, with half its CPUs idle: from
 * reading to reading, this process takes `own(reading)` microseconds of CPU time, the rest of its control group
 * `others(reading)` and the group's quota holds it back `throttled(reading)`; `groups` is how many groups the files show
 * (the process's own, then those above it, which `outer(reading)` microseconds of other CPU time each add to).
 * `usage(reading, group)` may replace a group's CPU time (NaN: cgroup v1). `late(reading)` is CPU time this process
 * takes while the files are read, after the groups' CPU time and before its own: the next reading's files count it.
 */
function quotaHost({ own = () => 3000, others = () => 2000, throttled = () => 0, groups = 1, outer = () => 0, usage = null, late = () => 0 } = {}) {
  let at = 3_600_000;
  let idle = 0;
  let reading = 0;
  let ownSoFar = 0;
  let pending = 0;
  const held = Array(groups).fill(0);
  const used = Array(groups).fill(0);
  return () => {
    reading += 1;
    at += 250;
    idle += 2 * 250;
    ownSoFar += pending + own(reading);
    const read = held.map((_, group) => {
      held[group] += throttled(reading, group);
      used[group] += pending + own(reading) + others(reading) + (group > 0 ? outer(reading) : 0);
      return { throttled: held[group], usage: usage ? usage(reading, group) : used[group], quota: 100_000, period: 100_000 };
    });
    pending = late(reading);
    return {
      idle, at, place: '0-3\n0::/render', throttled: held.reduce((sum, micros) => sum + micros, 0), groups: read, ownBefore: ownSoFar, ownAfter: ownSoFar + pending,
    };
  };
}

test('a reading held back for the quota by this process\'s own CPU time alone neither counts towards the stall nor starts it again', async () => {
  // A burst of this process's (its garbage collector on five threads: 100 ms of CPU time in a 250 ms reading) spends
  // the quota, while the rest of the group takes 2 ms: reading 4 tells nothing, so the stall is readings 2, 3, 5 and 6.
  const burst = { own: (reading) => (reading === 4 ? 100_000 : 3000), throttled: (reading) => (reading === 4 ? 81_000 : 0) };
  const fake = fakePage();
  assert.deepEqual(await heldWithin(fake, 2000, { ...fast(), host: quotaHost(burst) }), { setTimeout: 1, setInterval: 0, requestAnimationFrame: 0 });
  assert.equal(fake.readings, 6);
  // The kernel counts the throttling when it lets the group run again, which may be after the next reading: then the
  // reading after the burst is the one held back, with little CPU time of anyone's in it, and it tells nothing either.
  const late = fakePage();
  assert.ok(await heldWithin(late, 2000, { ...fast(), host: quotaHost({ ...burst, throttled: (reading) => (reading === 5 ? 81_000 : 0) }) }));
  assert.equal(late.readings, 6);
  // Such a reading is quiet only if all the rest is: the page's processes at work in it, an animation running to its end
  // (still asked of it) or a request that came and went start the count again.
  const busy = fakePage({}, (reading, state) => { state.cpu = reading === 4 ? 2 : 0; });
  assert.ok(await heldWithin(busy, 2000, { ...fast(), host: quotaHost(burst) }));
  assert.equal(busy.readings, 8);
  const animated = fakePage({}, (reading, state) => { state.animations = reading === 4 ? '1' : '0'; });
  assert.ok(await heldWithin(animated, 2000, { ...fast(), host: quotaHost(burst) }));
  assert.equal(animated.readings, 8);
  const working = { events: 0, atWork: () => false };
  const requested = fakePage({}, (reading) => { if (reading === 4) working.events += 1; });
  assert.ok(await heldWithin(requested, 2000, { ...fast(), host: quotaHost(burst) }, working));
  assert.equal(requested.readings, 8);
  // Held back at two readings in a row, or at two apart, after quiet time: each tells nothing, and none ends the stall.
  for (const held of [[4, 5], [3, 5]]) {
    const twice = { own: (reading) => (held.includes(reading) ? 100_000 : 3000), throttled: (reading) => (held.includes(reading) ? 40_000 : 0) };
    const fake = fakePage();
    assert.ok(await heldWithin(fake, 2000, { ...fast(), host: quotaHost(twice) }));
    assert.equal(fake.readings, 7, `held back at readings ${held}`);
  }
  // Held back at every reading, however little the rest of the group takes: never held, since no reading counts.
  const always = fakePage();
  assert.equal(await heldWithin(always, 600, { ...fast(), host: quotaHost({ own: () => 100_000, throttled: () => 50_000 }) }), 'not held');
  assert.ok(always.readings > 10, `${always.readings} readings`);
});

test('throttling the rest of the control group had a share in, or that cannot be told apart, starts the count again', async () => {
  const throttled = (reading) => (reading === 4 ? 81_000 : 0);
  // The rest of the group took 25 ms in that reading, a tenth of a CPU: the page may have been held back from work.
  for (const others of [25_000, 200_000]) {
    const fake = fakePage();
    assert.ok(await heldWithin(fake, 2000, { ...fast(), host: quotaHost({ throttled, others: (reading) => (reading === 4 ? others : 2000) }) }));
    assert.equal(fake.readings, 8, `others ${others}`);
  }
  // The rest of the group at work in the reading before (80 ms): the throttling counted a reading late may be its, so the
  // count starts again, as it does when the count comes in time.
  const late = fakePage();
  assert.ok(await heldWithin(late, 2000, { ...fast(), host: quotaHost({ others: (reading) => (reading === 4 ? 80_000 : 2000), throttled: (reading) => (reading === 5 ? 81_000 : 0) }) }));
  assert.equal(late.readings, 9);
  // A burst of this process's that comes while the files are read (80 ms, after the group's CPU time and before its own)
  // is not taken away from the group's, which does not hold it yet: the 80 ms the rest of the group took still count.
  const between = fakePage();
  const gc = { own: (reading) => (reading === 4 ? 20_000 : 3000), others: (reading) => (reading === 4 ? 80_000 : 2000), late: (reading) => (reading === 4 ? 80_000 : 0) };
  assert.ok(await heldWithin(between, 2000, { ...fast(), host: quotaHost({ ...gc, throttled }) }));
  assert.equal(between.readings, 8);
  // A group above the process's own held back too, whose other members took their share of it.
  const above = fakePage();
  assert.ok(await heldWithin(above, 2000, { ...fast(), host: quotaHost({ throttled, groups: 2, outer: (reading) => (reading === 4 ? 60_000 : 0) }) }));
  assert.equal(above.readings, 8);
  // But one above it that was not held back is not asked what the rest of it took.
  const unheld = fakePage();
  const ownOnly = quotaHost({ throttled: (reading, group) => (group === 0 ? throttled(reading) : 0), groups: 2, outer: () => 60_000 });
  assert.ok(await heldWithin(unheld, 2000, { ...fast(), host: ownOnly }));
  assert.equal(unheld.readings, 6);
  // cgroup v1, whose cpu.stat counts no CPU time: any throttling starts the count again.
  const v1 = fakePage();
  assert.ok(await heldWithin(v1, 2000, { ...fast(), host: quotaHost({ throttled, usage: () => Number.NaN }) }));
  assert.equal(v1.readings, 8);
});

test('ownThrottling: each group held back took less than a tenth of a CPU besides this process\'s CPU time, then and in the reading before', () => {
  // `own`: this process's CPU time just before the files were read and just after, or one number for both.
  // A group: [throttled, usage] with a quota of 2 CPUs (200 ms a period of 100 ms), or [throttled, usage, period, quota].
  const reading = (at, own, ...groups) => {
    const [ownBefore, ownAfter] = Array.isArray(own) ? own : [own, own];
    return { at, ownBefore, ownAfter, groups: groups.map(([throttled, usage, period = 100_000, quota = 200_000]) => ({ throttled, usage, quota, period })) };
  };
  // Readings 250 ms apart: this process took 3 ms and the rest of its group 2 ms, then this process 100 ms and the rest
  // 2 ms (24.999 ms: still less than a tenth of a CPU), while the group was held back for 81 ms.
  const earlier = reading(750, 47_000, [0, 395_000], [10, 8_995_000]);
  const before = reading(1000, 50_000, [0, 400_000], [10, 9_000_000]);
  const now = (own, ...groups) => reading(1250, own, ...groups);
  const held = [[81_000, 502_000], [10, 9_102_000]];
  assert.equal(ownThrottling(earlier, before, now(150_000, ...held)), true);
  assert.equal(ownThrottling(earlier, before, now(150_000, [81_000, 524_999], [10, 9_124_999])), true);
  assert.equal(ownThrottling(earlier, before, now(150_000, [81_000, 525_000], [10, 9_125_000])), false);
  // The kernel counts a throttling when it lets the group run again, which may be a reading late: the rest of the group
  // at work in the reading before (25 ms of its 250) may have been what spent the quota.
  assert.equal(ownThrottling(reading(750, 47_000, [0, 372_000], [10, 8_972_000]), before, now(150_000, ...held)), false);
  assert.equal(ownThrottling(reading(750, 47_000, [0, 372_001], [10, 8_972_001]), before, now(150_000, ...held)), true);
  // A group above it held back too counts by its own CPU time; one not held back is not asked.
  assert.equal(ownThrottling(earlier, before, now(150_000, [81_000, 502_000], [500, 9_102_000])), true);
  assert.equal(ownThrottling(earlier, before, now(150_000, [81_000, 502_000], [500, 9_200_000])), false);
  assert.equal(ownThrottling(earlier, before, now(150_000, [81_000, 502_000], [10, 20_000_000])), true);
  // The quota's period: the reading before covers a throttling's cause only while the period is no longer than a
  // reading (250 ms), so a group held back with a longer one, or one whose period cannot be read, is not told apart.
  assert.equal(ownThrottling(earlier, before, now(150_000, [81_000, 502_000, 250_000], [10, 9_102_000])), true);
  assert.equal(ownThrottling(earlier, before, now(150_000, [81_000, 502_000, 250_001], [10, 9_102_000])), false);
  // It is the readings' own spacing that counts: two readings 80 ms apart are closer than a 100 ms period.
  assert.equal(ownThrottling(earlier, before, reading(1080, 150_000, ...held)), false);
  assert.equal(ownThrottling(earlier, before, now(150_000, [81_000, 502_000, Number.NaN], [10, 9_102_000])), false);
  assert.equal(ownThrottling(earlier, before, now(150_000, [81_000, 502_000], [10, 9_102_000, Number.NaN])), true);
  // A small quota (10 ms a period: a tenth of a CPU) gives the rest of the group less: under a quarter of it, 2.5 ms, so
  // 20 ms of another's, which spent two of its periods, is not this process's; 2 ms is. No quota at all leaves 25 ms.
  assert.equal(ownThrottling(earlier, before, now(150_000, [81_000, 502_000, 100_000, 10_000], [10, 9_102_000])), true);
  assert.equal(ownThrottling(earlier, before, now(150_000, [81_000, 502_500, 100_000, 10_000], [10, 9_102_500])), false);
  assert.equal(ownThrottling(earlier, before, now(150_000, [81_000, 520_000, 100_000, 10_000], [10, 9_120_000])), false);
  assert.equal(ownThrottling(earlier, before, now(150_000, [81_000, 524_999, 100_000, Infinity], [10, 9_124_999])), true);
  assert.equal(ownThrottling(earlier, before, now(150_000, [81_000, 502_000, 100_000, Number.NaN], [10, 9_102_000])), false);
  // A reading that took longer (1 s) gives the rest of the group no more than one of 250 ms does: less than 25 ms.
  const slow = (others) => ownThrottling(earlier, before, reading(2000, 150_000, [81_000, 500_000 + others], [10, 9_100_000 + others]));
  assert.equal(slow(24_999), true);
  assert.equal(slow(25_000), false);
  assert.equal(slow(90_000), false);
  // What cannot be told: CPU time unread (cgroup v1) or gone backwards (a group made anew where it was), throttling
  // unread or gone backwards, this process's CPU time unread or gone backwards, a reading missing, groups that do not
  // compare, and readings not apart in time.
  assert.equal(ownThrottling(earlier, before, now(150_000, [81_000, Number.NaN], [10, 9_102_000])), false);
  assert.equal(ownThrottling(earlier, before, now(150_000, [81_000, 102_000], [10, 9_102_000])), false);
  assert.equal(ownThrottling(earlier, before, now(150_000, [Number.NaN, 502_000], [10, 9_102_000])), false);
  assert.equal(ownThrottling(earlier, reading(1000, 50_000, [90_000, 400_000], [10, 9_000_000]), now(150_000, ...held)), false);
  assert.equal(ownThrottling(earlier, before, now(Number.NaN, ...held)), false);
  assert.equal(ownThrottling(earlier, before, now(40_000, ...held)), false);
  assert.equal(ownThrottling(null, before, now(150_000, ...held)), false);
  assert.equal(ownThrottling(earlier, before, now(150_000, [81_000, 502_000])), false);
  assert.equal(ownThrottling({ ...earlier, groups: null }, before, now(150_000, ...held)), false);
  assert.equal(ownThrottling(earlier, { ...before, groups: null }, now(150_000, ...held)), false);
  assert.equal(ownThrottling(earlier, before, { ...now(150_000), groups: null }), false);
  assert.equal(ownThrottling(earlier, before, reading(1000, 150_000, [81_000, 499_000], [10, 9_099_000])), false);
  assert.equal(ownThrottling(reading(1000, 49_000, [0, 399_500], [10, 8_999_500]), before, now(150_000, ...held)), false);
  // The group's CPU time is read a moment before this process's, so the rest of it can come out a little below nothing.
  assert.equal(ownThrottling(earlier, before, now(150_000, [81_000, 499_000], [10, 9_099_000])), true);
  // Only this process's CPU time between two readings of the files is taken away: a burst while `now` read them (80 ms
  // after its groups' CPU time, which does not hold it yet) leaves the 80 ms the rest of the group took in the span.
  assert.equal(ownThrottling(earlier, before, now([70_000, 150_000], [81_000, 502_000], [10, 9_102_000])), false);
  assert.equal(ownThrottling(earlier, before, now([150_000, 150_000], [81_000, 502_000], [10, 9_102_000])), true);
  // One while `before` read them cannot be put on either side of its groups' reading, so it is taken from neither span
  // and the throttling is not told apart: the count starts again, as it did before this rule.
  assert.equal(ownThrottling(earlier, reading(1000, [50_000, 130_000], [0, 400_000], [10, 9_000_000]), now(150_000, ...held)), false);
  // Read as hostIdle reads them (quotaReading): another process's 100 ms between the CPU time and the throttling of one
  // reading of a cpu.stat, which spent the quota, is in the second reading's CPU time, so it is not this process's.
  const stat = (usage, throttled) => `usage_usec ${usage}\nthrottled_usec ${throttled}\n`;
  const taken = (at, cpu, ...stats) => ({ at, ...quotaReading(['/g/cpu.stat'], { read: (file) => (file === '/g/cpu.max' ? '100000 100000\n' : stats.shift()), cpu: () => cpu }) });
  const start = () => [taken(0, 0, stat(0, 0), stat(0, 0)), taken(250, 3000, stat(5000, 0), stat(5000, 0))];
  assert.equal(ownThrottling(...start(), taken(600, 6000, stat(10_000, 81_000), stat(115_000, 81_000))), false);
  assert.equal(ownThrottling(...start(), taken(600, 6000, stat(10_000, 81_000), stat(10_000, 81_000))), true);
});

test('the stall must last unbroken: a moment of work, or a reading that cannot be taken, starts the count again', async () => {
  // Quiet for three quarter-seconds, a busy one, then quiet: held only a full second after the busy reading.
  const fake = fakePage({}, (reading, state) => { state.cpu = reading === 4 ? 2 : 0; });
  assert.ok(await heldWithin(fake, 2000));
  assert.equal(fake.readings, 8);
  for (const broken of [{ broken: true }, { exception: true }, { waiting: 'nope' }, { noCpu: true }]) {
    const flaky = fakePage({}, (reading, state) => { Object.assign(state, reading === 3 ? broken : { broken: false, exception: false, waiting: '1,0,0,0', noCpu: false }); });
    assert.ok(await heldWithin(flaky, 2000), JSON.stringify(broken));
    assert.equal(flaky.readings, 8, JSON.stringify(broken));
  }
  // A page that never reads: never held.
  assert.equal(await heldWithin(fakePage({ broken: true }), 300), 'not held');
});

test('a page whose main thread does not answer is at work, and is asked once at a time', async () => {
  const fake = fakePage({ answers: false });
  assert.equal(await heldWithin(fake, 400), 'not held');
  assert.equal(fake.readings, 1, 'the unanswered reading is awaited again, not sent again');
});

test('a stopped watch reads no more and never holds', async () => {
  // Busy until the watch is stopped, then quiet: a watch still reading would hold the page within milliseconds.
  const fake = fakePage({ cpu: 2 });
  const watch = watchHeldClock(fake.watched, { clock: fake.clock, ...fast() });
  await delay(30);
  watch.stop();
  fake.state.cpu = 0;
  const readings = fake.readings;
  assert.equal(await Promise.race([watch.held, delay(200, 'not held')]), 'not held');
  assert.ok(fake.readings <= readings + 1, `${fake.readings} readings after ${readings}`);
});

test('the default watch holds a page after 5 s of it, and reads this host\'s idle CPU time', () => {
  assert.equal(HELD_CLOCK_MS, 5000);
  const [first, second] = [hostIdle(), hostIdle()];
  // Throttling is a number of microseconds, or NaN where it cannot be read (and no page is then refused).
  assert.ok(first.idle > 0 && second.idle >= first.idle && second.at >= first.at && typeof first.throttled === 'number' && typeof first.place === 'string', JSON.stringify([first, second]));
  // This process's CPU time so far, in microseconds, just before and just after the quota files were read, and what each
  // of them says (none off Linux).
  const own = [first.ownBefore, first.ownAfter, second.ownBefore, second.ownAfter];
  assert.ok(Number.isFinite(own[0]) && own[0] > 0 && own.every((micros, index) => index === 0 || micros >= own[index - 1]), JSON.stringify(own));
  // In microseconds, user and system time both: between what process.cpuUsage says just before and just after.
  const around = [process.cpuUsage()];
  const taken = hostIdle();
  around.push(process.cpuUsage());
  const [low, high] = around.map(({ user, system }) => user + system);
  assert.ok(low <= taken.ownBefore && taken.ownBefore <= taken.ownAfter && taken.ownAfter <= high, JSON.stringify([low, taken.ownBefore, taken.ownAfter, high]));
  assert.ok(first.groups === null || (Array.isArray(first.groups) && first.groups.every((group) => typeof group.throttled === 'number' && typeof group.usage === 'number')), JSON.stringify(first.groups));
  assert.match(describeHost(), /^held clock: (no page is refused for waiting on its own clock on this host, since .+|a page that waits on its own clock is refused after 5 s \(quota throttling read from \d+ cpu\.stat files?(, throttling of its own doing (not )?told apart)?\))$/);
});

test('the probe\'s answer is read only as four counts', () => {
  assert.deepEqual(parseWaiting('2,1,3,4'), { setTimeout: 2, setInterval: 1, requestAnimationFrame: 3, realTime: 4 });
  for (const answer of ['', '1,2', '1,2,3', '1,2,3,4,5', ' 1,2,3,4', '-1,0,0,0', 'a,b,c,d', '1,2,3,4\n', '1234567890,0,0,0', 3, null, undefined, { toString: () => '1,1,1,1' }]) {
    assert.equal(parseWaiting(answer), null, String(answer));
  }
});

test('the probe reads the virtual clock of the page, and answers nothing without one', () => {
  const context = vm.createContext({ performance: { now: () => 0 }, requestAnimationFrame: () => 0 });
  vm.runInContext('globalThis.window = globalThis;', context);
  assert.equal(vm.runInContext(CLOCK_PROBE, context), '');
  vm.runInContext(VIRTUAL_TIME_SCRIPT, context);
  vm.runInContext('setTimeout(() => {}, 10); setTimeout(() => {}, 0); setInterval(() => {}, 5); requestAnimationFrame(() => {});', context);
  assert.equal(vm.runInContext(CLOCK_PROBE, context), '2,1,1,0');
  assert.deepEqual(parseWaiting(vm.runInContext(CLOCK_PROBE, context)), { setTimeout: 2, setInterval: 1, requestAnimationFrame: 1, realTime: 0 });
});

test('the page\'s CPU time is its browser\'s processes but the browser\'s own, each by its id, and an answer without any is no reading', () => {
  assert.deepEqual(childCpu({ processInfo: [{ type: 'browser', id: 1, cpuTime: 9 }, { type: 'renderer', id: 7, cpuTime: 0.5 }, { type: 'GPU', id: 8, cpuTime: 0.25 }, { type: 'utility', id: 9, cpuTime: 0.25 }] }),
    new Map([[7, 0.5], [8, 0.25], [9, 0.25]]));
  for (const info of [null, {}, { processInfo: [] }, { processInfo: [{ type: 'browser', id: 1, cpuTime: 3 }] }, { processInfo: [{ type: 'renderer', id: 2, cpuTime: 0 }] },
    { processInfo: [{ type: 'renderer', id: 2, cpuTime: 'x' }] }, { processInfo: [{ type: 'renderer', id: 2, cpuTime: -1 }] }, { processInfo: [{ type: 'GPU', id: 3, cpuTime: Number.NaN }] }]) {
    assert.equal(childCpu(info), null, JSON.stringify(info));
  }
  // One process the browser cannot account for spoils the reading, however well the others read; so does one without an id.
  for (const bad of [{ cpuTime: -1 }, { cpuTime: 'x' }, { cpuTime: Number.NaN }, { cpuTime: null }, { id: undefined }, { id: 2.5 }, { id: '3' }]) {
    assert.equal(childCpu({ processInfo: [{ type: 'renderer', id: 2, cpuTime: 0.5 }, { type: 'GPU', id: 3, cpuTime: 0.25, ...bad }] }), null, JSON.stringify(bad));
  }
  // Between two readings: what each process took, a new one in full, and nothing known when one of the first is gone.
  const before = new Map([[2, 1], [3, 0.5]]);
  assert.equal(cpuBetween(before, new Map([[2, 1.25], [3, 0.5]])), 0.25);
  assert.equal(cpuBetween(before, new Map([[2, 1.25], [3, 0.5], [4, 2]])), 2.25);
  assert.equal(cpuBetween(before, new Map([[2, 0.75], [3, 0.5]])), 0, 'never less than nothing');
  assert.equal(cpuBetween(before, new Map([[2, 1.25], [4, 0]])), null);
});

test('openWatch opens the page\'s session and the browser\'s, and tracks the page\'s work', async () => {
  const sessions = [];
  const session = (kind) => Object.assign(new EventEmitter(), { kind, send: async () => ({}) });
  const page = Object.assign(new EventEmitter(), { workers: () => [], frames: () => [], url: () => 'about:blank' });
  const context = Object.assign(new EventEmitter(), {
    newCDPSession: async (target) => { assert.equal(target, page); sessions.push('page'); return session('page'); },
    browser: () => ({ newBrowserCDPSession: async () => { sessions.push('browser'); return session('browser'); } }),
  });
  const watched = await openWatch(context, page);
  assert.deepEqual([watched.cdp.kind, watched.processes.kind, watched.activity.known, sessions], ['page', 'browser', true, ['page', 'browser']]);
});

/** A browser context, page and DevTools session as trackActivity uses them, each event fired by hand. */
function fakeBrowser({ enable = async () => ({}) } = {}) {
  const context = new EventEmitter();
  const page = new EventEmitter();
  const cdp = new EventEmitter();
  const state = { workers: [], frames: ['about:blank'], url: 'about:blank', enabled: [] };
  page.workers = () => state.workers;
  page.frames = () => state.frames.map((url) => ({ url: () => url }));
  page.url = () => state.url;
  cdp.send = async (method) => { state.enabled.push(method); return enable(method); };
  return { context, page, cdp, state };
}

test('the page\'s work beside its CPU time: requests, workers, running Web Audio, playing media and frames of another origin', async () => {
  const { context, page, cdp, state } = fakeBrowser();
  const activity = await trackActivity(context, page, cdp);
  assert.deepEqual(state.enabled.sort(), ['Media.enable', 'WebAudio.enable']);
  assert.deepEqual([activity.known, activity.atWork(), activity.events], [true, false, 0]);
  const request = {};
  context.emit('request', request);
  assert.equal(activity.atWork(), true);
  context.emit('requestfinished', request);
  assert.deepEqual([activity.atWork(), activity.events], [false, 2]);
  context.emit('request', request);
  context.emit('requestfailed', request);
  assert.deepEqual([activity.atWork(), activity.events], [false, 4]);
  // A worker keeps real time: while one lives, the page may be waiting on it.
  const worker = new EventEmitter();
  state.workers = [worker];
  page.emit('worker', worker);
  assert.equal(activity.atWork(), true);
  state.workers = [];
  worker.emit('close');
  assert.deepEqual([activity.atWork(), activity.events], [false, 6]);
  // A running audio context, real-time or offline; a suspended or closed one is not work.
  for (const [contextState, working] of [['suspended', false], ['running', true], ['closed', false]]) {
    cdp.emit(contextState === 'suspended' ? 'WebAudio.contextCreated' : 'WebAudio.contextChanged', { context: { contextId: 'a1', contextType: 'realtime', contextState } });
    assert.equal(activity.atWork(), working, contextState);
  }
  cdp.emit('WebAudio.contextChanged', { context: { contextId: 'a2', contextType: 'offline', contextState: 'running' } });
  assert.equal(activity.atWork(), true);
  cdp.emit('WebAudio.contextWillBeDestroyed', { contextId: 'a2' });
  assert.equal(activity.atWork(), false);
  // Media: kPlay until kPause, kEnded or the player gone; other events and unreadable ones change nothing.
  const media = (...events) => cdp.emit('Media.playerEventsAdded', { playerId: 'p1', events: events.map((event) => ({ timestamp: 1, value: event ? JSON.stringify({ event }) : '{' })) });
  const before = activity.events;
  media('kMediaLogCreated', 'kLoad', null);
  assert.deepEqual([activity.atWork(), activity.events], [false, before]);
  for (const [event, working] of [['kPlay', true], ['kPause', false], ['kPlay', true], ['kEnded', false], ['kPlay', true], ['kWebMediaPlayerDestroyed', false]]) {
    media(event);
    assert.equal(activity.atWork(), working, event);
  }
  // A frame of another web origin runs in another process; about:, data: and blob: frames do not count.
  state.frames = ['about:blank', 'about:srcdoc', 'data:text/html,x', 'blob:null/1'];
  page.emit('frameattached');
  assert.equal(activity.atWork(), false);
  state.frames.push('https://cdn.jsdelivr.net/npm/x/index.html');
  assert.equal(activity.atWork(), true);
  // In the check, the page has an origin of its own: its own frames are not another's.
  state.url = 'https://awwo-check.invalid/page.html';
  state.frames = [state.url, 'https://awwo-check.invalid/frame.html'];
  assert.equal(activity.atWork(), false);
});

test('a page whose Web Audio or media DevTools will not report is never quiet', async () => {
  for (const missing of ['Media.enable', 'WebAudio.enable']) {
    const { context, page, cdp } = fakeBrowser({ enable: async (method) => { if (method === missing) throw new Error(`'${method}' wasn't found`); return {}; } });
    const activity = await trackActivity(context, page, cdp);
    assert.deepEqual([activity.known, activity.atWork()], [false, true], missing);
  }
});

test('CPU quota throttling is read from the process\'s control group and those above it, cgroup v2 and v1, where mountinfo puts them', () => {
  const files = new Map([
    ['/sys/fs/cgroup/system.slice/awwo-saas-render.service/cpu.stat', 'usage_usec 900\nnr_throttled 3\nthrottled_usec 1500\n'],
    ['/sys/fs/cgroup/system.slice/cpu.stat', 'usage_usec 9000\nthrottled_usec 20\n'],
    ['/sys/fs/cgroup/cpu.stat', 'usage_usec 90000\n'],
    ['/sys/fs/cgroup/cpu,cpuacct/cpu.stat', 'nr_periods 2\nnr_throttled 1\nthrottled_time 4000000\n'],
    ['/srv/cg cpu/batch/job/cpu.stat', 'throttled_time 7000000\n'],
    ['/srv/cg cpu/batch/cpu.stat', 'throttled_time 1000\n'],
    ['/srv/cg cpu/cpu.stat', 'throttled_time 0\n'],
    // The quotas beside them (the root has none of its own).
    ['/sys/fs/cgroup/system.slice/awwo-saas-render.service/cpu.max', '200000 100000\n'],
    ['/sys/fs/cgroup/system.slice/cpu.max', 'max 100000\n'],
    ['/sys/fs/cgroup/cpu,cpuacct/cpu.cfs_quota_us', '-1\n'],
    ['/sys/fs/cgroup/cpu,cpuacct/cpu.cfs_period_us', '100000\n'],
  ]);
  let proc = '';
  let mounts = '';
  const read = (file) => {
    if (file === '/proc/self/cgroup') return proc;
    if (file === '/proc/self/mountinfo') return mounts;
    if (files.has(file)) return files.get(file);
    throw Object.assign(new Error(`ENOENT: no such file or directory, open '${file}'`), { code: 'ENOENT' });
  };
  const exists = (file) => files.has(file);
  const unrelated = '22 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw\n24 22 0:22 / /proc rw,nosuid shared:13 - proc proc rw\n';
  // A systemd unit on a cgroup v2 host.
  proc = '0::/system.slice/awwo-saas-render.service\n';
  mounts = `${unrelated}29 23 0:26 / /sys/fs/cgroup rw,nosuid,nodev,noexec,relatime shared:4 - cgroup2 cgroup2 rw,nsdelegate,memory_recursiveprot\n`;
  const v2 = throttleFiles({ platform: 'linux', read, exists });
  assert.deepEqual(v2, ['/sys/fs/cgroup/system.slice/awwo-saas-render.service/cpu.stat', '/sys/fs/cgroup/system.slice/cpu.stat', '/sys/fs/cgroup/cpu.stat']);
  assert.equal(throttledMicros(v2, read), 1520);
  // Docker on cgroup v1: the host's path is not under the container's mount, whose root is the container's own group;
  // the cpuset and named hierarchies are not the cpu controller's.
  // A hybrid host's unified hierarchy is mounted too, but the cpu controller is cgroup v1's, so its group there is not read.
  proc = '19:cpu,cpuacct:/docker/66e8\n12:cpuset:/docker/66e8\n1:name=systemd:/docker/66e8\n0::/system.slice/docker.service\n';
  mounts = `${unrelated}1234 1230 0:40 /docker/66e8 /sys/fs/cgroup/cpu,cpuacct ro,nosuid,nodev,noexec,relatime master:17 - cgroup cgroup rw,cpu,cpuacct\n`
    + '1235 1230 0:41 /docker/66e8 /sys/fs/cgroup/cpuset ro,nosuid master:18 - cgroup cgroup rw,cpuset\n'
    + '1236 1230 0:42 / /sys/fs/cgroup/unified ro,nosuid master:19 - cgroup2 cgroup2 rw\n';
  const v1 = throttleFiles({ platform: 'linux', read, exists });
  assert.deepEqual(v1, ['/sys/fs/cgroup/cpu,cpuacct/cpu.stat']);
  assert.equal(throttledMicros(v1, read), 4000);
  // Each group's own reading, as ownThrottling compares them: its throttling and the CPU time it and the groups below it
  // took, which only cgroup v2's cpu.stat counts; a group with no quota of its own (the root) is never held back.
  assert.deepEqual(quotaGroups(v2, read), [{ throttled: 1500, usage: 900 }, { throttled: 20, usage: 9000 }, { throttled: 0, usage: 90_000 }]);
  assert.deepEqual(quotaGroups(v1, read), [{ throttled: 4000, usage: Number.NaN }]);
  assert.equal(quotaGroups(['/sys/fs/cgroup/cpu.stat', '/gone/cpu.stat'], read), null, 'a file it cannot read');
  assert.equal(quotaGroups(null, read), null);
  assert.deepEqual(quotaGroups([], read), []);
  // The files are read twice, between two readings of this process's CPU time: the throttling is the first reading's
  // and the CPU time the second's. One reading of a cpu.stat takes its CPU time before its throttling, so a burst of
  // another process's between the two (80 ms, then the throttling it caused) shows in the second reading's CPU time;
  // the second reading's throttling (5 ms more here) may again be ahead of its CPU time, and waits for the next reading.
  const order = [];
  let micros = 0;
  const reads = new Map();
  const later = (file) => {
    if (!file.endsWith('/cpu.stat')) {
      order.push('quota');
      return read(file);
    }
    const times = (reads.get(file) ?? 0) + 1;
    reads.set(file, times);
    order.push('stat');
    const stat = read(file);
    return times === 1 ? stat.replace(/^throttled_usec (\d+)$/m, (_, held) => `throttled_usec ${Number(held) + 81_000}`)
      : stat.replace(/^usage_usec (\d+)$/m, (_, used) => `usage_usec ${Number(used) + 80_000}`).replace(/^throttled_usec (\d+)$/m, (_, held) => `throttled_usec ${Number(held) + 86_000}`);
  };
  const bracketed = quotaReading(v2, { read: later, cpu: () => { order.push('cpu'); micros += 1000; return micros; } });
  // The quotas after the bracket: the service's and the slice's cpu.max, and the root's three tries that find none.
  assert.deepEqual(order, ['cpu', 'stat', 'stat', 'stat', 'stat', 'stat', 'stat', 'cpu', 'quota', 'quota', 'quota', 'quota', 'quota']);
  const limits = [{ quota: 200_000, period: 100_000 }, { quota: Infinity, period: 100_000 }, { quota: Infinity, period: Number.NaN }];
  assert.deepEqual(bracketed, {
    groups: [{ throttled: 82_500, usage: 80_900, ...limits[0] }, { throttled: 81_020, usage: 89_000, ...limits[1] }, { throttled: 0, usage: 170_000, ...limits[2] }],
    ownBefore: 1000, ownAfter: 2000,
  });
  assert.deepEqual(quotaReading(v2, { read, cpu: () => 7 }), { groups: quotaGroups(v2, read).map((group, index) => ({ ...group, ...limits[index] })), ownBefore: 7, ownAfter: 7 });
  // A quota: cgroup v2's cpu.max (max: none), v1's cpu.cfs_quota_us (-1: none) and cpu.cfs_period_us; NaN for what
  // cannot be read as one.
  assert.deepEqual(v2.map((file) => quotaLimit(file, read)), limits);
  assert.deepEqual(quotaLimit('/sys/fs/cgroup/cpu,cpuacct/cpu.stat', read), { quota: Infinity, period: 100_000 });
  const beside = (name, text) => (file) => (file === `/g/${name}` ? text : read(file));
  for (const text of ['max\n', '100000\n', 'max 1e5\n', '-1 100000\n', '']) assert.deepEqual(quotaLimit('/g/cpu.stat', beside('cpu.max', text)), { quota: Number.NaN, period: Number.NaN }, JSON.stringify(text));
  assert.deepEqual(quotaLimit('/g/cpu.stat', beside('cpu.max', '50000 250000\n')), { quota: 50_000, period: 250_000 });
  assert.deepEqual(quotaLimit('/g/cpu.stat', beside('cpu.cfs_quota_us', '20000\n')), { quota: 20_000, period: Number.NaN });
  // None of the files there (a cgroup v2 hierarchy's root): no quota. One there that cannot be read: nothing known.
  assert.deepEqual(quotaLimit('/g/cpu.stat', read), { quota: Infinity, period: Number.NaN });
  const unreadable = (file) => { if (file === '/g/cpu.max') throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); return read(file); };
  assert.deepEqual(quotaLimit('/g/cpu.stat', unreadable), { quota: Number.NaN, period: Number.NaN });
  // The start line's "told apart" (toldApart): CPU time read, and every group either without a quota or with one whose
  // period is no longer than the watch's readings are apart (250 ms).
  assert.equal(toldApart(quotaReading(v2, { read }).groups), true);
  assert.equal(toldApart(quotaReading(v1, { read }).groups), false, 'cgroup v1 counts no CPU time');
  const group = (quota, period, usage = 1000) => [{ usage, quota, period }];
  assert.equal(toldApart(group(100_000, 250_000)), true);
  assert.equal(toldApart(group(100_000, 250_001)), false);
  assert.equal(toldApart(group(100_000, 1_000_000)), false);
  assert.equal(toldApart(group(Number.NaN, 100_000)), false, 'a quota that cannot be read');
  assert.equal(toldApart(group(Infinity, Number.NaN)), true, 'no quota: never held back');
  assert.equal(toldApart(group(100_000, 100_000, Number.NaN)), false);
  assert.equal(toldApart(null), false);
  assert.equal(quotaReading(['/sys/fs/cgroup/cpu.stat', '/gone/cpu.stat'], { read }).groups, null);
  assert.equal(quotaReading(null, { read }).groups, null);
  assert.deepEqual(throttleFiles({ platform: 'linux', read, exists: () => true }), ['/sys/fs/cgroup/cpu,cpuacct/cpu.stat'], 'the paths it looks for, not only those found');
  // A mount point of another name, written with an escaped space: one that shows all of the hierarchy, and one that
  // shows it from /batch down, where the group /batch/job is the mount's job directory.
  proc = '4:cpuacct,cpu:/batch/job\n';
  mounts = `${unrelated}40 22 0:50 / /srv/cg\\040cpu rw,relatime - cgroup cgroup rw,cpuacct,cpu\n`;
  const named = throttleFiles({ platform: 'linux', read, exists });
  assert.deepEqual(named, ['/srv/cg cpu/batch/job/cpu.stat', '/srv/cg cpu/batch/cpu.stat', '/srv/cg cpu/cpu.stat']);
  assert.equal(throttledMicros(named, read), 7001);
  mounts = `${unrelated}40 22 0:50 /batch /srv/cg\\040cpu rw,relatime - cgroup cgroup rw,cpuacct,cpu\n`;
  assert.deepEqual(throttleFiles({ platform: 'linux', read, exists: () => true }), ['/srv/cg cpu/job/cpu.stat', '/srv/cg cpu/cpu.stat']);
  // What cannot be known is null, which hostIdle answers as throttling it cannot read: a group outside what its mount
  // shows, a group no mount shows (a cgroup namespace's mount from outside it, root /..), one of its own with no
  // cpu.stat, /proc unreadable. Off Linux there is none to read.
  proc = '0::/user.slice/other\n';
  mounts = `${unrelated}29 23 0:26 /system.slice /sys/fs/cgroup rw - cgroup2 cgroup2 rw\n`;
  assert.equal(throttleFiles({ platform: 'linux', read, exists: () => true }), null);
  proc = '0::/\n';
  mounts = `${unrelated}29 23 0:26 /.. /sys/fs/cgroup rw - cgroup2 cgroup2 rw\n`;
  assert.equal(throttleFiles({ platform: 'linux', read, exists: () => true }), null);
  mounts = unrelated;
  assert.equal(throttleFiles({ platform: 'linux', read, exists: () => true }), null);
  proc = '0::/system.slice/gone.service\n';
  mounts = `${unrelated}29 23 0:26 / /sys/fs/cgroup rw - cgroup2 cgroup2 rw\n`;
  assert.equal(throttleFiles({ platform: 'linux', read, exists }), null);
  assert.equal(throttleFiles({ platform: 'linux', read: () => { throw new Error('no proc'); }, exists }), null);
  assert.deepEqual(throttleFiles({ platform: 'win32', read, exists }), []);
  assert.ok(Number.isNaN(throttledMicros(['/gone/cpu.stat'], read)), 'a file it cannot read is throttling it cannot know');
  assert.ok(Number.isNaN(throttledMicros(null, read)), 'files that cannot be known read as throttling no reading equals');
});

test('idle CPU time is counted only on the CPUs the process may run on, which a cpuset or an affinity narrows', () => {
  assert.deepEqual(allowedCpus('Name:\tnode\nCpus_allowed:\tf\nCpus_allowed_list:\t0-3\nMems_allowed_list:\t0\n'), new Set([0, 1, 2, 3]));
  assert.deepEqual(allowedCpus('Cpus_allowed_list:\t0,2,5-6\n'), new Set([0, 2, 5, 6]));
  for (const status of ['', 'Cpus_allowed_list:\t\n', 'Cpus_allowed_list:\t3-1\n', 'Cpus_allowed_list:\t0-x\n', 'Cpus_allowed_list:\t0,,1\n', null]) {
    assert.equal(allowedCpus(status), null, JSON.stringify(status));
  }
  // /proc/stat: the summary line is not a CPU; idle is the fourth number, in ticks of 10 ms.
  const stat = 'cpu  30 0 20 700 5 0 0 0 0 0\ncpu0 10 0 10 100 1 0 0 0 0 0\ncpu1 10 0 5 250 2 0 0 0 0 0\ncpu2 10 0 5 350 2 0 0 0 0 0\nintr 12345\n';
  assert.equal(statIdle(stat, null), 7000);
  assert.equal(statIdle(stat, new Set([1])), 2500);
  assert.equal(statIdle(stat, new Set([0, 2, 9])), 4500);
  assert.equal(statIdle(stat, new Set([9])), 0, 'no CPU it may run on is listed: none to spare');
});

test('a watch that cannot be opened in time, or fails to open, is no watch: the page is never held', async () => {
  const page = Object.assign(new EventEmitter(), { workers: () => [], frames: () => [], url: () => 'about:blank' });
  const session = () => Object.assign(new EventEmitter(), { send: async () => ({}) });
  const hangs = { newCDPSession: () => new Promise(() => {}), browser: () => ({ newBrowserCDPSession: async () => session() }) };
  const started = Date.now();
  assert.equal(await openWatch(hangs, page, { timeoutMs: 50 }), null);
  assert.ok(Date.now() - started < 1000);
  const fails = { newCDPSession: async () => session(), browser: () => null };
  assert.equal(await openWatch(fails, page), null);
  const enableHangs = { newCDPSession: async () => Object.assign(new EventEmitter(), { send: () => new Promise(() => {}) }), browser: () => ({ newBrowserCDPSession: async () => session() }) };
  assert.equal(await openWatch(enableHangs, page, { timeoutMs: 50 }), null);
  // The sessions of a watch given up are detached, and so is one that opens after.
  const detached = [];
  const spy = (name) => Object.assign(new EventEmitter(), { send: async () => ({}), detach: async () => { detached.push(name); } });
  let openBrowser;
  const late = { newCDPSession: async () => spy('page'), browser: () => ({ newBrowserCDPSession: () => new Promise((resolve) => { openBrowser = () => resolve(spy('browser')); }) }) };
  assert.equal(await openWatch(late, page, { timeoutMs: 50 }), null);
  assert.deepEqual(detached, ['page']);
  openBrowser();
  await delay(20);
  assert.deepEqual(detached, ['page', 'browser']);
  const watch = watchHeldClock(null, fast());
  assert.equal(await Promise.race([watch.held, delay(100, 'not held')]), 'not held');
  watch.stop();
});

test('the reason names what waited on the clock and says it moves only when a frame is drawn', () => {
  assert.equal(waitingWords({ setTimeout: 1, setInterval: 0, requestAnimationFrame: 0 }), '1 setTimeout timer was');
  assert.equal(waitingWords({ setTimeout: 0, setInterval: 2, requestAnimationFrame: 1 }), '2 setInterval timers and 1 requestAnimationFrame callback were');
  assert.equal(waitingWords({ setTimeout: 3, setInterval: 1, requestAnimationFrame: 2 }), '3 setTimeout timers, 1 setInterval timer and 2 requestAnimationFrame callbacks were');
  assert.equal(heldClockMessage({ kind: 'renderAt', t: 1 / 3 }, { setTimeout: 0, setInterval: 0, requestAnimationFrame: 1 }), 'window.renderAt(0.333) had not settled after 5 s, '
    + 'in which the page did no work the renderer could see while 1 requestAnimationFrame callback was waiting on its clock. The renderer moves that clock only '
    + 'when it draws a frame, which it does once renderAt(t) has settled, so renderAt must draw from t alone, without waiting on a timer or an animation frame.');
  assert.equal(heldClockMessage({ kind: 'renderAudio' }, { setTimeout: 2, setInterval: 0, requestAnimationFrame: 0 }, 2500), 'window.renderAudio had not settled after 2.5 s, '
    + 'in which the page did no work the renderer could see while 2 setTimeout timers were waiting on its clock. The renderer moves that clock only when it draws '
    + 'a frame, and it draws none while a sound is made, so renderAudio must not wait on a timer or an animation frame.');
  // awwo-check-page's note on a page the renderer renders before it is ready.
  assert.equal(heldClockMessage({ kind: 'ready' }, { setTimeout: 1, setInterval: 0, requestAnimationFrame: 0 }), 'window.__ready was still not true after 5 s, '
    + 'in which the page did no work the renderer could see while 1 setTimeout timer was waiting on its clock. The renderer moves that clock only when it draws '
    + 'a frame, so the renderer, which waits up to 10 s for it, renders the page before it is ready: set window.__ready from load events and promises, never '
    + 'from a timer or an animation frame.');
  // An edit keeps 500 characters of a refusal: the longest reason, under the longest item id an edit takes, fits.
  const most = { setTimeout: 123_456, setInterval: 123_456, requestAnimationFrame: 123_456 };
  for (const wait of [{ kind: 'renderAt', t: 19.983 }, { kind: 'renderAudio' }]) {
    const prefix = wait.kind === 'renderAt' ? `Card ${'x'.repeat(40)} could not be rendered: ` : `The sound of ${'x'.repeat(40)} could not be made: `;
    assert.ok((prefix + heldClockMessage(wait, most)).length <= 500, wait.kind);
  }
});

test('awwo-check-page carries the same virtual clock and held-clock watch as the renderer', () => {
  for (const name of ['virtual-time.mjs', 'held-clock.mjs']) {
    const copy = new URL(`../../deploy/saas/workspace/tools/${name}`, import.meta.url);
    assert.equal(readFileSync(copy, 'utf8'), readFileSync(new URL(name, import.meta.url), 'utf8'), `deploy/saas/workspace/tools/${name} must equal apps/render-worker/${name}`);
  }
});
