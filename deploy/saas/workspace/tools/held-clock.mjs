// Whether a page the renderer waits on waits on nothing but its own clock. The virtual clock (virtual-time.mjs) moves
// only when the renderer draws a frame, and it draws one only once window.renderAt(t) has settled, so a page whose
// renderAt waits on its own timers or animation frames, or whose window.renderAudio does (no frame is drawn while a sound
// is made), never finishes: the renderer waits on the page, and the page on a clock that waits on the renderer.
// While it waits, the renderer reads the page every HELD_SAMPLE_MS: the callbacks waiting on its clock and the waits it
// has that keep real time (__awwoClockWaiting), the CPU time of each of the browser's processes (DevTools
// SystemInfo.getProcessInfo, read by the browser itself: the renderer's own ProcessTime reads 0 under Chromium's sandbox
// on Linux) and the work DevTools and Playwright report beside it (trackActivity: requests, workers, Web Audio, media,
// frames of another origin). A page with callbacks waiting on its clock, no wait that keeps real time and no such work,
// no change in that work since the reading before, the browser's processes but its own under a quarter of a CPU between
// them while the CPUs it may run on had at least half a CPU idle and its control group was not held back for a CPU quota
// (so a page with work to do could have run), and then, asked last, no animation running towards an end, in every
// reading for HELD_CLOCK_MS, is held: refused at once, naming what waits, rather than left to a timeout. A reading
// quiet but for its group held back by this process's own CPU time alone (ownThrottling: its garbage collector, whose
// threads can spend a 1-CPU quota's period in a few tens of milliseconds) tells nothing of the time it spans: it
// neither counts towards HELD_CLOCK_MS nor starts the count again.
// A page at work is never held, however long it takes, nor is a page on a host too busy to tell or whose quota cannot be
// read, one whose clock has nothing waiting on it, or one the watch could not be opened on.
// awwo-check-page (deploy/saas/workspace/tools) carries a copy of this file and of virtual-time.mjs, kept equal by a test.
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const HELD_CLOCK_MS = 5000;
export const HELD_SAMPLE_MS = 250;
/** A page whose processes take less CPU time than this share of the time that passed is idle... */
const IDLE_CPU = 0.25;
/** ...when the CPUs it may run on were idle for at least this many CPUs' worth of that time: else it may only be waiting to run. */
const SPARE_CPU = 0.5;
/** A control group held back for its quota took less than this share of a CPU besides this process: the holding back was its own... */
const OTHERS_CPU = 0.1;
/** ...when that is also less than this share of what its quota lets it take in a period, so the rest could not have spent it. */
const OTHERS_QUOTA = 0.25;
/** How long one reading may take: a page whose main thread does not answer that soon is at work. */
const READING_MS = 1000;
/** How long opening a watch may take: past that, or when it fails, the page is waited on unwatched (never held). */
const OPEN_MS = 5000;

/** What the renderer evaluates in the page: "timeouts,intervals,frames,real-time waits", or '' without the virtual clock. */
export const CLOCK_PROBE = "typeof window.__awwoClockWaiting === 'function' ? window.__awwoClockWaiting(0) + ',' + window.__awwoClockWaiting(1) + ',' + window.__awwoClockWaiting(2) + ',' + window.__awwoClockWaiting(3) : ''";
/**
 * And the animations running towards an end, the document's and those the page started from script, which resolves its
 * styles and reads each of them: asked only of a reading that finds the page quiet otherwise, so a page at work never is.
 */
export const ANIMATION_PROBE = "typeof window.__awwoClockWaiting === 'function' ? '' + window.__awwoClockWaiting(4) : ''";

/** The counts CLOCK_PROBE answered ({ setTimeout, setInterval, requestAnimationFrame, realTime }), or null. */
export function parseWaiting(text) {
  const match = typeof text === 'string' ? /^(\d{1,9}),(\d{1,9}),(\d{1,9}),(\d{1,9})$/.exec(text) : null;
  if (!match) return null;
  return { setTimeout: Number(match[1]), setInterval: Number(match[2]), requestAnimationFrame: Number(match[3]), realTime: Number(match[4]) };
}

/** The origin of an http(s) URL, or null for any other (about:, data:, blob:, a page set by setContent). */
function webOrigin(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.origin : null;
  } catch {
    return null;
  }
}

/**
 * The page's work that its renderer's CPU time does not show, as DevTools and Playwright report it: requests of its
 * context in flight, its dedicated workers (which keep real time and may be waiting on their own timers), Web Audio
 * contexts running (a sound played or recorded in real time, or rendered offline), media playing, and frames of another
 * web origin (another process). `events` counts every change in them, so work that came and went between two readings
 * counts too. `known` is false when DevTools would not report Web Audio or media: nothing is then quiet.
 */
export async function trackActivity(context, page, cdp) {
  const requests = new Set();
  const audio = new Map();
  const playing = new Set();
  const activity = {
    events: 0,
    known: true,
    atWork() {
      if (!activity.known || requests.size > 0 || playing.size > 0 || page.workers().length > 0) return true;
      for (const state of audio.values()) if (state === 'running') return true;
      const own = webOrigin(page.url());
      return page.frames().some((frame) => { const origin = webOrigin(frame.url()); return origin !== null && origin !== own; });
    },
  };
  const changed = () => { activity.events += 1; };
  context.on('request', (request) => { requests.add(request); changed(); });
  for (const name of ['requestfinished', 'requestfailed']) context.on(name, (request) => { requests.delete(request); changed(); });
  page.on('worker', (worker) => { changed(); worker.on('close', changed); });
  for (const name of ['frameattached', 'framedetached', 'framenavigated']) page.on(name, changed);
  const audioState = ({ context: audioContext }) => { audio.set(audioContext.contextId, audioContext.contextState); changed(); };
  cdp.on('WebAudio.contextCreated', audioState);
  cdp.on('WebAudio.contextChanged', audioState);
  cdp.on('WebAudio.contextWillBeDestroyed', ({ contextId }) => { audio.delete(contextId); changed(); });
  // Media reports its players' events as JSON a second or so late: kPlay, then kPause or kEnded, or the player gone.
  cdp.on('Media.playerEventsAdded', ({ playerId, events }) => {
    for (const { value } of events ?? []) {
      let event;
      try { event = JSON.parse(value).event; } catch { continue; }
      if (event === 'kPlay') playing.add(playerId);
      else if (event === 'kPause' || event === 'kEnded' || event === 'kWebMediaPlayerDestroyed') playing.delete(playerId);
      else continue;
      changed();
    }
  });
  try {
    await Promise.all(['WebAudio.enable', 'Media.enable'].map((method) => cdp.send(method)));
  } catch {
    activity.known = false;
  }
  return activity;
}

/** A field of /proc/self/mountinfo as it was meant (a space is written \040). */
const unescaped = (field) => field.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(Number.parseInt(octal, 8)));

/**
 * The cpu.stat files that count how long the kernel held this process back for a CPU quota: its control group's and
 * those above it, in the cgroup v1 hierarchy with the cpu controller, or else in the cgroup v2 one, wherever
 * /proc/self/mountinfo says they are mounted (a container's own group is its mount's root). None off Linux; null when
 * they cannot be known (/proc unreadable, a group no mount shows, a group of its own with no cpu.stat), which
 * hostIdle answers as throttling it cannot read: the page is then never quiet.
 */
export function throttleFiles({ platform = process.platform, read = (file) => readFileSync(file, 'utf8'), exists = existsSync } = {}) {
  if (platform !== 'linux') return [];
  let groups;
  let mounts;
  try {
    groups = read('/proc/self/cgroup').split('\n');
    mounts = read('/proc/self/mountinfo').split('\n');
  } catch {
    return null;
  }
  // A mountinfo line: id parent major:minor root mount-point options [optional fields] - type source super-options.
  const places = [];
  for (const line of mounts) {
    const [mount, filesystem = ''] = line.split(' - ');
    const fields = mount.split(' ');
    const [type, , options = ''] = filesystem.split(' ');
    if (fields.length < 5) continue;
    if (type === 'cgroup2' || (type === 'cgroup' && options.split(',').includes('cpu'))) {
      places.push({ v2: type === 'cgroup2', root: unescaped(fields[3]), point: unescaped(fields[4]) });
    }
  }
  // The process's groups the cpu controller may be in: its cgroup v1 ones that have it, or else its cgroup v2 one.
  const entries = [];
  for (const line of groups) {
    const match = /^\d+:([^:]*):(\/.*)$/.exec(line.trim());
    if (match) entries.push({ v2: match[1] === '', controllers: match[1].split(','), group: match[2] });
  }
  const v1 = entries.filter((entry) => !entry.v2 && entry.controllers.includes('cpu'));
  const files = [];
  for (const { v2, group } of v1.length ? v1 : entries.filter((entry) => entry.v2)) {
    let own = false;
    for (const place of places) {
      if (place.v2 !== v2) continue;
      // The group's directory under a mount that shows its hierarchy from `root` down.
      const { root, point } = place;
      const inner = root === '/' ? group : group === root ? '/' : group.startsWith(`${root}/`) ? group.slice(root.length) : null;
      if (inner === null) continue;
      for (let dir = inner; ; dir = path.posix.dirname(dir)) {
        const file = path.posix.join(point, dir, 'cpu.stat');
        if (exists(file)) {
          if (!files.includes(file)) files.push(file);
          if (dir === inner) own = true;
        }
        if (dir === '/') break;
      }
    }
    if (!own) return null;
  }
  return files;
}

/**
 * What those files say of their control groups so far, one entry a file in their order: the microseconds the kernel held
 * the group back for a CPU quota (v2 throttled_usec, v1 throttled_time) and the CPU time the group and those below it
 * took (v2 usage_usec, in microseconds; NaN in cgroup v1, whose cpu.stat has none); null for files that cannot be known
 * (throttleFiles' null) or a file that cannot be read.
 */
export function quotaGroups(files, read = (file) => readFileSync(file, 'utf8')) {
  if (files === null) return null;
  const groups = [];
  for (const file of files) {
    let stat;
    try { stat = read(file); } catch { return null; }
    const v2 = /^throttled_usec (\d+)$/m.exec(stat);
    const v1 = v2 ? null : /^throttled_time (\d+)$/m.exec(stat);
    const usage = /^usage_usec (\d+)$/m.exec(stat);
    groups.push({ throttled: v2 ? Number(v2[1]) : v1 ? Number(v1[1]) / 1000 : 0, usage: usage ? Number(usage[1]) : Number.NaN });
  }
  return groups;
}

/** quotaGroups' throttling summed: NaN when it is null, which no reading equals, so the page is never quiet. */
const throttledSum = (groups) => (groups ? groups.reduce((micros, group) => micros + group.throttled, 0) : Number.NaN);

/**
 * The microseconds those files say the kernel held this process back so far (v2 throttled_usec, v1 throttled_time);
 * NaN for files that cannot be known (throttleFiles' null) or read, which no reading equals, so the page is never quiet.
 */
export function throttledMicros(files, read = (file) => readFileSync(file, 'utf8')) {
  return throttledSum(quotaGroups(files, read));
}

/** The CPU numbers a process may run on, from its /proc/<pid>/status (Cpus_allowed_list, which a cpuset narrows too), or null: any. */
export function allowedCpus(status) {
  const match = /^Cpus_allowed_list:\s*(\S+)\s*$/m.exec(status ?? '');
  if (!match) return null;
  const cpus = new Set();
  for (const part of match[1].split(',')) {
    const range = /^(\d+)(?:-(\d+))?$/.exec(part);
    const from = range ? Number(range[1]) : NaN;
    const to = range ? Number(range[2] ?? range[1]) : NaN;
    if (!(to >= from) || to - from > 65536) return null;
    for (let cpu = from; cpu <= to; cpu += 1) cpus.add(cpu);
  }
  return cpus;
}

/** The idle milliseconds so far of the CPUs in `allowed` (all of them when null), from /proc/stat, which counts 10 ms ticks. */
export function statIdle(stat, allowed) {
  let idle = 0;
  for (const [, cpu, ticks] of String(stat).matchAll(/^cpu(\d+)\s+\d+\s+\d+\s+\d+\s+(\d+)/gm)) {
    if (!allowed || allowed.has(Number(cpu))) idle += Number(ticks) * 10;
  }
  return idle;
}

/** This process's CPU time so far, in microseconds, all its threads. */
const cpuTime = () => {
  const { user, system } = process.cpuUsage();
  return user + system;
};

/**
 * quotaGroups of those files read twice (`groups`): the throttling of the first reading and the CPU time of the second,
 * since one reading of a cpu.stat takes its CPU time before its throttling, so a throttling counted then may come of
 * CPU time it does not show; the second shows all the CPU time taken before the first's throttling. With this
 * process's CPU time (`cpu`) read just before them and just after (`ownBefore`, `ownAfter`), so that ownThrottling
 * takes away only what it surely took between two readings of them.
 */
export function quotaReading(files, { read = (file) => readFileSync(file, 'utf8'), cpu = cpuTime } = {}) {
  const ownBefore = cpu();
  const held = quotaGroups(files, read);
  const used = quotaGroups(files, read);
  const ownAfter = cpu();
  const groups = held && used ? held.map(({ throttled }, index) => ({ throttled, usage: used[index].usage, ...quotaLimit(files[index], read) })) : null;
  return { groups, ownBefore, ownAfter };
}

/**
 * The CPU quota of the control group whose cpu.stat is `file`, from the files beside it (cgroup v2 cpu.max, v1
 * cpu.cfs_quota_us and cpu.cfs_period_us): the microseconds the group may take in a period (`quota`, Infinity for no
 * quota, as where none of those files is there: a cgroup v2 hierarchy's root) and the period's (`period`), each NaN
 * when it cannot be read.
 */
export function quotaLimit(file, read = (path) => readFileSync(path, 'utf8')) {
  // A file's text: null when it is not there, '' when it cannot be read.
  const text = (name) => {
    try { return read(path.posix.join(path.posix.dirname(file), name)); } catch (error) { return error?.code === 'ENOENT' ? null : ''; }
  };
  const max = text('cpu.max');
  const v2 = /^(max|\d+) (\d+)\s*$/.exec(max ?? '');
  if (v2) return { quota: v2[1] === 'max' ? Infinity : Number(v2[1]), period: Number(v2[2]) };
  const [quotaText, periodText] = [text('cpu.cfs_quota_us'), text('cpu.cfs_period_us')];
  if (max === null && quotaText === null && periodText === null) return { quota: Infinity, period: Number.NaN };
  const quota = /^(-1|\d+)\s*$/.exec(quotaText ?? '');
  const period = /^(\d+)\s*$/.exec(periodText ?? '');
  return { quota: !quota ? Number.NaN : quota[1] === '-1' ? Infinity : Number(quota[1]), period: period ? Number(period[1]) : Number.NaN };
}

/**
 * Whether quota throttling of this process's own doing can be told apart (ownThrottling) in the groups a hostIdle
 * reading found: never in cgroup v1, whose cpu.stat counts no CPU time, nor in a group whose quota cannot be read or
 * whose period is longer than the watch's readings are apart.
 */
export function toldApart(groups) {
  return Boolean(groups) && groups.every(({ usage, quota, period }) => Number.isFinite(usage)
    && (quota === Infinity || (Number.isFinite(quota) && period <= HELD_SAMPLE_MS * 1000)));
}

// The quota files, and the /proc/self/cgroup and /proc/self/mountinfo they were found from.
let quotaFiles = [];
let quotaFrom = null;
/**
 * The idle CPU time so far (milliseconds, summed over the CPUs this process may run on: on Linux from /proc/stat,
 * elsewhere from os.cpus(), all of them), when it was read, where (`place`: the CPUs it may run on and its control
 * groups as the kernel lists them, read again each time, so that a move between two readings shows; '' elsewhere),
 * the quota throttling (throttledMicros of the files found for those groups, found again when they or the mounts
 * change; NaN when they cannot be known or read), what each of those files says (`groups`) and the CPU time this
 * process had taken just before they were read and just after (`ownBefore`, `ownAfter`), as quotaReading reads them,
 * which ownThrottling compares.
 */
export function hostIdle() {
  let idle = null;
  let place = '';
  if (process.platform === 'linux') {
    let status = '';
    try {
      status = readFileSync('/proc/self/status', 'utf8');
      const groups = readFileSync('/proc/self/cgroup', 'utf8');
      const mounts = readFileSync('/proc/self/mountinfo', 'utf8');
      if (`${groups}\0${mounts}` !== quotaFrom) {
        quotaFrom = `${groups}\0${mounts}`;
        quotaFiles = throttleFiles({ read: (file) => (file === '/proc/self/cgroup' ? groups : file === '/proc/self/mountinfo' ? mounts : readFileSync(file, 'utf8')) });
      }
      place = `${/^Cpus_allowed_list:\s*(\S*)/m.exec(status)?.[1] ?? ''}\n${groups}`;
    } catch {
      quotaFiles = null;
      quotaFrom = null;
    }
    try { idle = statIdle(readFileSync('/proc/stat', 'utf8'), allowedCpus(status)); } catch { idle = null; }
  }
  if (idle === null) {
    idle = 0;
    for (const cpu of os.cpus()) idle += cpu.times.idle;
  }
  const { groups, ownBefore, ownAfter } = quotaReading(quotaFiles);
  return { idle, at: performance.now(), place, throttled: throttledSum(groups), groups, ownBefore, ownAfter };
}

/**
 * Whether the quota throttling between two hostIdle readings, `before` and `now`, came of this process's own CPU time (a
 * burst of it: its garbage collector's threads can spend a 1-CPU quota's period in a few tens of milliseconds). The
 * kernel counts a throttling only when it lets the group run again, at the next period of its quota, which may be after
 * the next reading, so it may have begun after `earlier`, the reading before `before`: each control group held back took
 * less than OTHERS_CPU of a CPU besides this process's CPU time, and less than OTHERS_QUOTA of what its quota lets it
 * take in a period, from `earlier` to `before` and from `before` to `now`, so little that the rest of the group, a page's
 * processes among them, was not what spent its quota. That holds while each span is at least as long as the quota's
 * period (the watch reads every HELD_SAMPLE_MS and more; both users' periods are 100 ms), so a group whose period is
 * longer, or whose quota cannot be read, is not told apart; and a reading that takes longer than HELD_SAMPLE_MS gives
 * the rest of the group no more, since the quota is spent period by period. Of this process's CPU time only what it
 * surely took between two readings of a group's files is taken away (from just after the first to just before the
 * second), never a burst that came while they were read. False when that cannot be told: a group whose CPU time cannot
 * be read (cgroup v1) or went backwards (a group made anew where it was, which shows no other way), or readings missing
 * or that do not compare.
 */
export function ownThrottling(earlier, before, now) {
  if (![earlier, before, now].every((reading) => reading?.groups && reading.groups.length === now.groups?.length)) return false;
  const spans = [[earlier, before], [before, now]];
  return now.groups.every(({ throttled, quota, period }, index) => throttled === before.groups[index].throttled
    || (throttled > before.groups[index].throttled && spans.every(([from, to]) => {
      const usage = to.groups[index].usage - from.groups[index].usage;
      const allowed = Math.min(OTHERS_CPU * Math.min(to.at - from.at, HELD_SAMPLE_MS) * 1000, OTHERS_QUOTA * quota);
      return period <= (to.at - from.at) * 1000 && usage >= 0 && usage - (to.ownBefore - from.ownAfter) < allowed;
    })));
}

/** A line for the worker's log at start: whether a page that waits on its own clock can be refused on this host. */
export function describeHost() {
  const reading = hostIdle();
  const never = 'held clock: no page is refused for waiting on its own clock on this host, since';
  if (Number.isNaN(reading.throttled)) return `${never} the CPU quota throttling of its control group cannot be read`;
  if (!(reading.idle > 0)) return `${never} its idle CPU time cannot be read`;
  return `held clock: a page that waits on its own clock is refused after ${HELD_CLOCK_MS / 1000} s (quota throttling read from ${quotaFiles.length} cpu.stat file${quotaFiles.length === 1 ? '' : 's'}`
    + `${!quotaFiles.length ? '' : `, throttling of its own doing ${toldApart(reading.groups) ? '' : 'not '}told apart`})`;
}

/**
 * The CPU seconds each of the browser's processes but its own (renderers, GPU, utilities such as audio and network) has
 * taken so far, by process id, from SystemInfo.getProcessInfo's answer; null when it lists none, gives a value that is
 * not one, or none of them has taken any time (not readable).
 */
export function childCpu(info) {
  const processes = info?.processInfo;
  if (!Array.isArray(processes)) return null;
  const taken = new Map();
  let total = 0;
  for (const entry of processes) {
    if (entry?.type === 'browser') continue;
    const { id, cpuTime } = entry ?? {};
    if (!Number.isInteger(id) || typeof cpuTime !== 'number' || !Number.isFinite(cpuTime) || cpuTime < 0) return null;
    taken.set(id, (taken.get(id) ?? 0) + cpuTime);
    total += cpuTime;
  }
  return total > 0 ? taken : null;
}

/** The CPU seconds the processes took between two childCpu answers, or null when one of the first is gone (it took an unknown share). */
export function cpuBetween(before, now) {
  let seconds = 0;
  for (const id of before.keys()) if (!now.has(id)) return null;
  for (const [id, taken] of now) seconds += Math.max(0, taken - (before.get(id) ?? 0));
  return seconds;
}

/** One reading of the page (`at`: clock(), in seconds), or null when it could not be read. */
async function readPage({ cdp, processes }, clock) {
  try {
    const [probe, info] = await Promise.all([
      cdp.send('Runtime.evaluate', { expression: CLOCK_PROBE, returnByValue: true }),
      processes.send('SystemInfo.getProcessInfo'),
    ]);
    const waiting = probe.exceptionDetails ? null : parseWaiting(probe.result?.value);
    const cpu = childCpu(info);
    return waiting && cpu !== null ? { waiting, cpu, at: clock() } : null;
  } catch {
    return null;
  }
}

/** The animations running towards an end (ANIMATION_PROBE), or null when the page did not say. */
async function readAnimations({ cdp }) {
  try {
    const probe = await cdp.send('Runtime.evaluate', { expression: ANIMATION_PROBE, returnByValue: true });
    const value = probe.exceptionDetails ? null : probe.result?.value;
    return typeof value === 'string' && /^\d{1,9}$/.test(value) ? Number(value) : null;
  } catch {
    return null;
  }
}

const detach = (session) => {
  try { Promise.resolve(session.detach()).catch(() => {}); } catch { /* gone already */ }
};

/**
 * What the watch reads of a page, opened before its content is set: its DevTools session (`cdp`, for the clock's count),
 * the browser's (`processes`, for the CPU time of its processes) and trackActivity's account of its work; or null when
 * they could not be opened within timeoutMs, which watchHeldClock takes for a page it never holds. Sessions of a watch
 * given up are detached, those that open later too.
 */
export async function openWatch(context, page, { timeoutMs = OPEN_MS } = {}) {
  const sessions = [];
  let abandoned = false;
  const kept = (session) => {
    if (abandoned) detach(session);
    else sessions.push(session);
    return session;
  };
  const opening = (async () => {
    const cdp = kept(await context.newCDPSession(page));
    const processes = kept(await context.browser().newBrowserCDPSession());
    return { cdp, processes, activity: await trackActivity(context, page, cdp) };
  })();
  opening.catch(() => {});
  const timer = new AbortController();
  let watched = null;
  try {
    watched = await Promise.race([opening, delay(timeoutMs, null, { signal: timer.signal, ref: false }).catch(() => null)]);
  } catch {
    watched = null;
  } finally {
    timer.abort();
  }
  if (!watched) {
    abandoned = true;
    for (const session of sessions) detach(session);
  }
  return watched;
}

/**
 * Reads the page `watched` (openWatch's answer) every sampleMs until stop(). `held` resolves with what waits on its clock
 * ({ setTimeout, setInterval, requestAnimationFrame }) once the page has been held for stallMs (see above), and never
 * otherwise: not once stopped, nor when a reading fails or the watch was not opened (a failure of the watch never
 * refuses a page). `host` reads the idle CPU time, where it was counted, the quota throttling and what tells whose doing
 * it was (hostIdle), `clock` the seconds the readings are timed by.
 */
export function watchHeldClock(watched, {
  stallMs = HELD_CLOCK_MS, sampleMs = HELD_SAMPLE_MS, readingMs = READING_MS, host = hostIdle, clock = () => performance.now() / 1000,
} = {}) {
  if (!watched) return { held: new Promise(() => {}), stop: () => {} };
  const { activity } = watched;
  const stopping = new AbortController();
  // Unreferenced: a watch keeps no process alive, and stop() ends its pause at once.
  const pause = (ms) => delay(ms, undefined, { signal: stopping.signal, ref: false });
  const held = (async () => {
    // The seconds the quiet readings since the last reading that was not quiet spanned, but those held back by this
    // process's own CPU time.
    let stalled = 0;
    let last = null;
    // The host reading taken at the reading before, answered or not.
    let previous = null;
    let pending = null;
    for (;;) {
      await pause(sampleMs);
      const reading = pending ?? readPage(watched, clock);
      const answer = await Promise.race([reading, pause(readingMs)]);
      // Not answered yet: the page is at work. The same reading is awaited again rather than another one sent.
      pending = answer === undefined ? reading : null;
      const events = activity.events;
      const idle = host();
      const waiting = answer?.waiting;
      const used = answer && last ? cpuBetween(last.cpu, answer.cpu) : null;
      // Held back for a CPU quota since the reading before, and whether by this process's own CPU time alone.
      const heldBack = used !== null && idle.throttled !== last.idle.throttled;
      const ownOnly = heldBack && ownThrottling(last.before, last.idle, idle);
      let quiet = Boolean(used !== null && waiting.setTimeout + waiting.setInterval + waiting.requestAnimationFrame > 0
        && waiting.realTime === 0 && !activity.atWork() && events === last.events && used < IDLE_CPU * (answer.at - last.at)
        && idle.idle - last.idle.idle >= SPARE_CPU * (idle.at - last.idle.at) && idle.place === last.idle.place
        && (!heldBack || ownOnly));
      // Quiet so far: then the animations too, which only now are worth resolving styles and reading each for, and the
      // work beside it once more, which may have begun meanwhile.
      if (quiet) {
        quiet = (await Promise.race([readAnimations(watched), pause(readingMs)])) === 0 && !activity.atWork() && activity.events === events;
      }
      // A reading held back by this process alone is quiet, but the page may not have had its time to run in: it neither
      // counts towards the stall nor ends it.
      if (!quiet) stalled = 0;
      else if (!heldBack) stalled += answer.at - last.at;
      last = answer ? { ...answer, events, idle, before: previous } : null;
      previous = idle;
      if (quiet && stalled >= stallMs / 1000) {
        return { setTimeout: waiting.setTimeout, setInterval: waiting.setInterval, requestAnimationFrame: waiting.requestAnimationFrame };
      }
    }
  })().catch(() => new Promise(() => {}));
  return { held, stop: () => stopping.abort() };
}

const KINDS = [['setTimeout', 'setTimeout timer'], ['setInterval', 'setInterval timer'], ['requestAnimationFrame', 'requestAnimationFrame callback']];

/** "1 setTimeout timer and 2 requestAnimationFrame callbacks were": what waited on the clock, in words. */
export function waitingWords(waiting) {
  const parts = KINDS.filter(([key]) => waiting[key] > 0).map(([key, noun]) => `${waiting[key]} ${noun}${waiting[key] === 1 ? '' : 's'}`);
  const total = KINDS.reduce((sum, [key]) => sum + waiting[key], 0);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0];
  return `${list} ${total === 1 ? 'was' : 'were'}`;
}

/**
 * Why a held page is refused, for the wait it was held in: { kind: 'renderAt', t } or { kind: 'renderAudio' }; or, for
 * awwo-check-page's note on a page the renderer renders before it is ready, { kind: 'ready' }. Fixed words and numbers
 * only, so it may go back to the caller as it is.
 */
export function heldClockMessage(wait, waiting, stallMs = HELD_CLOCK_MS) {
  const seconds = `${Math.round(stallMs / 100) / 10} s`;
  const what = {
    ready: `window.__ready was still not true after ${seconds}`,
    renderAt: `window.renderAt(${Number(Number(wait.t).toFixed(3))}) had not settled after ${seconds}`,
    renderAudio: `window.renderAudio had not settled after ${seconds}`,
  }[wait.kind];
  const why = {
    ready: 'so the renderer, which waits up to 10 s for it, renders the page before it is ready: set window.__ready from load events and promises, never from a timer or an animation frame',
    renderAt: 'which it does once renderAt(t) has settled, so renderAt must draw from t alone, without waiting on a timer or an animation frame',
    renderAudio: 'and it draws none while a sound is made, so renderAudio must not wait on a timer or an animation frame',
  }[wait.kind];
  return `${what}, in which the page did no work the renderer could see while ${waitingWords(waiting)} waiting on its clock. `
    + `The renderer moves that clock only when it draws a frame, ${why}.`;
}
