# AwwO render worker

An internal service that turns a self-contained HTML animation page into an MP4 (plus, on request, a GIF, a
contact sheet and still frames). It opens the page in a fresh headless Chromium, freezes it at every frame time,
screenshots each frame and pipes the PNGs to ffmpeg; a page that defines `window.renderAudio` gets its own sound in
the MP4. Only the AwwO API calls it (`backend/internal/app/renders.go`, enabled by `AWWO_RENDER_URL` +
`AWWO_RENDER_TOKEN`); the videos become artifacts of the canvas.

## Render contract for pages

Every frame must be a pure function of the time `t` in seconds. Frame `i` is shown at `t = i / fps` for
`i = 0 … N-1`, with `N = round(seconds × fps)`; the last frame is always earlier than `seconds`, so a loop renders
frames 0 … N-1 and repeats seamlessly.

- **`window.renderAt(t)`** (contract mode, recommended): called once per frame before the screenshot. It may return
  a promise; the frame waits for it, so it must not wait on the page's own timers or animation frames (see below). An
  exception is recorded as a page error and the render goes on.
- **CSS keyframes, transitions and Web Animations** are allowed: before every frame each animation is paused and
  placed at `t`, measured from the frame it first appeared in (animations present at load start at 0).
- **No `renderAt`** (virtual-time mode): the page runs on a virtual clock injected before any page script.
  `performance.now()`, `Date.now()`, `new Date()`, `requestAnimationFrame`, `setTimeout`/`setInterval` and
  `Math.random` (seeded, so the same every render) are replaced; time stands still between frames, so a frame shows
  exactly its `t` however long the screenshot takes. Timers fire at their own due times; at most 10,000 timer
  firings per frame (warning `timer_limit`). Web workers and cross-origin frames keep real time.
- **`window.renderAudio`** (optional, and defined by every film made with AwwO's film kit): the video carries the
  page's own sound. Once the frames, the GIF and the contact sheet are made, the page is opened once more in a fresh
  browser of its own, exactly as an edit's page sound is (see "Sounds a page makes" below: the same walls, virtual
  clock and held-clock watch), and `renderAudio({seconds, sampleRate})` is called once for the picture's own length
  (`N / fps` seconds, asked at 48 kHz), with 120 s to make it. The sound is levelled to the edit node's -16 LUFS and
  -1 dBTP in the same two `loudnorm` passes, faded out over its last 60 ms when the page made more than the render keeps
  (more than 50 ms past it, as a film longer than the render does), and muxed as AAC (192 kbps, 48 kHz, stereo,
  `-aac_pns 0`) beside the picture's own frames, which are copied: the picture is the one the same page without
  `renderAudio` gives, packet for packet. The MP4 is read back (one AAC stream, the picture's length) and its sound
  measured again (the reply's `sound`). A page whose sound cannot be made through its own doing (`renderAudio` throws,
  gives something else or too little, waits on its own clock or takes longer than its 120 s; the page does not load,
  crashes or navigates), or whose sound is not made by the time the render reaches its limit (`AWWO_RENDER_TIMEOUT_MS`
  ends only the sound once the picture is made), keeps its silent video, with the warning `sound_failed` and the
  reply's `soundReason` saying why; a sound that is silence (every sample 0, or under -70 LUFS) adds none
  (`sound_silent`). What the worker itself cannot do (start the browser, store the sound: 503; ffmpeg failing on its
  own files) fails the render as before. A page without `renderAudio` renders silent, as it always has.
- **`window.__ready`**: a page that defines it is waited for (up to 10 s) until it is `true`, after `load` and
  `document.fonts.ready` (warnings `ready_timeout`, `fonts_timeout`). Its timers and animation frames do not run in
  that wait, so a page that sets `__ready` from one waits all 10 s and is rendered before it is ready.
- **A `renderAt` or `renderAudio` that waits on the page's own clock is refused within seconds.** The page's timers
  and animation frames run only when the renderer draws a frame, and a frame is drawn only once `renderAt(t)` has
  settled (none is drawn while a sound is made, below), so a `renderAt` or `renderAudio` that waits on them would wait
  for ever. While the renderer waits on one (not on `__ready`, nor on the paint after a frame), it reads the page every
  250 ms (`held-clock.mjs`):
  - the `setTimeout`, `setInterval` and `requestAnimationFrame` callbacks waiting on its clock and on its same-origin
    frames' (`__awwoClockWaiting`, which the page cannot replace);
  - the waits the page has that keep real time, which it counts itself: `AbortSignal.timeout` signals not yet aborted
    and `scheduler.postTask` tasks with a delay the browser took and has not yet run; and, asked only once all the rest
    is quiet, since it costs a style recalculation and a look at each, the animations running towards an end (forwards
    to their end, or backwards to their start), the document's own (CSS ones too) and those the page started from
    script (on an element of the document or not, each kept as long as the page can reach it); a frame whose waits it
    cannot read (of another origin, past the first 32 or four deep, or without the clock) counts as one such wait. The
    wrappers this takes call the browser's own functions, which read and refuse what the page gives as before;
  - the CPU time of each of the browser's processes but its own (DevTools `SystemInfo.getProcessInfo`, which the browser
    reads itself: the renderer's own figure reads 0 under Chromium's sandbox on Linux);
  - its other work: requests in flight, dedicated workers (they keep real time), Web Audio running (a sound played,
    recorded or rendered), media playing and frames of another origin.

  Callbacks waiting on the clock, and for 5 s none of the rest: no wait on real time and none of that work, nothing of
  it begun or ended, no process gone, the processes under a quarter of a CPU while the CPUs the worker may run on (its
  cpuset or affinity) had at least half a CPU idle and its control group was not held back for a CPU quota (cgroup v1
  or v2, found through `/proc/self/mountinfo`; the CPUs and groups are read at every reading, and a change in them
  starts the 5 s again), so that a page with work to do could have run: refused, 400 `INVALID_RENDER` on `html`,
  `detail` `page_waits_on_timers`, with a message naming what waited and saying the clock moves only when a frame is
  drawn. A reading in which the group was held back by the worker's own CPU time alone (the rest of it, the page's
  processes among them, took less than a tenth of a CPU besides the worker (less than 25 ms however long a reading
  took, and less than a quarter of what the quota lets the group take in a period) in that reading and in the one
  before, since the kernel counts a holding back only when it lets the group run again, at the quota's next period,
  which must be no longer than the time between two readings; cgroup v2's `usage_usec` and `cpu.max` tell it, and in
  cgroup v1 any holding back counts) neither counts towards the 5 s nor starts them again: a garbage collection of the
  worker's, whose threads can spend a 1-CPU quota's period in a few tens of milliseconds, no longer erases the quiet
  time before it, and a page is still refused only after 5 s of readings quiet in every respect, holding back included.
  A page at work is waited for as before, however long, and so is one on a host too busy to tell, one whose control
  group's throttling cannot be read (a cgroup layout `/proc` does not show), one with nothing waiting on its clock, and
  one the watch could not be opened on in 5 s; the render's own limits stay as they are. So a page that keeps a
  dedicated worker, a running `AudioContext`, a playing media element, a frame of another origin or of no readable
  clock, or a long `AbortSignal.timeout` (a fetch's safety net of minutes, say) for as long as it waits is never
  refused: its hang ends at the render's limit, as before. The other way round, a `renderAt` or `renderAudio` that
  waits more than 5 s on something none of these shows (a speech utterance, an `Atomics.waitAsync`) while callbacks of
  its own wait on the clock would be refused. The worker says at start, in a `held clock:` line of its log, whether its
  host lets it refuse such a page, and whether it tells throttling of its own doing apart there ("throttling of its own
  doing told apart").
- The page may load scripts, styles and fonts only from the CDN origins in `cdn-allowlist.json` (the same list as
  the web preview's `LIVE_CDNS`), and the kits AwwO supplies by their exact URLs (`kits.mjs`: the film kit,
  `https://awwo.clawhunt.store/kits/film/1/film.js`, answered from the pinned copy in `kits/`, which a release ships);
  everything else is blocked. It must not navigate away (that fails the render).
- **Brand fonts come from the worker, not the network.** The 27 faces of AwwO's 18 brand fonts are answered at exactly
  the jsDelivr URLs the film kit names for them (the Fontsource 5.3.0 files, e.g.
  `https://cdn.jsdelivr.net/npm/@fontsource-variable/inter@5.3.0/files/inter-latin-wght-normal.woff2`) from the copies
  in `fonts/` (`fonts.mjs`; each family's SIL Open Font License beside its files), which a release ships as it ships
  `kits/`: the worker refuses to start when a copy differs from its pinned size and sha256 or has no license beside
  it. So a film whose roles name brand families, as its guide says, draws its type with no network, as its preview
  does. 23 of the copies are the file at their URL byte for byte, Noto Sans SC's among them (Google Fonts' simplified
  Chinese subset of its bold cut, 1.17 MB: the face a film's Chinese words have); Orbitron, Playfair Display and Press
  Start 2P reserve their names, which no subset may keep, so their four URLs are answered with the full fonts AwwO carries,
  which draw the subsets' Latin range pixel for pixel (Playfair Display's ⁒ aside) and, as a preview's do, the
  characters a subset lacks too. Any other font URL (another family, or a brand family's other subsets or versions) is
  fetched or blocked as before.
- **A film keeps the type its first frame has, and says what it lacks.** The film kit uses no face of its own that
  loads after the renderer's first frame, so its own type never changes mid-film. What of its own fonts a role lacks
  it says as a page error, once per role, with the first frame drawn after it is known (a font still loading at the
  first frame, with that frame): `Film: fonts not loaded: text "Roboto"`, or the cuts and character ranges a family
  lacks beside the ones it has (`text "Inter" italic`, `display "Rajdhani" 600 and 700`, `text "Inter" latin-ext`);
  `fonts still loading at the first frame, not used in this film: …`; `fonts loaded only after the first frame, not
  used in this film: …` (a film that calls `Film.run` late). What draws such text instead is the browser's choice (a
  cut it makes from those that loaded, a local font of that name, the fallback). A family the page supplies itself, as
  a running preview supplies the brand fonts, draws the role and is not named: the kit asks the browser for the page's
  faces of it only where it did before, once its own faces are not all used and no frame is drawn yet, since asking
  starts loading them (a face in flight while the page loads holds up the load event a render waits for). A page's own
  `@font-face` of a role's family, which the film guide does not ask for, stays the page's: the kit cannot refuse one,
  so one that arrives late can still change the film's type.
- **A film's listed words are checked in the faces that draw them, Chinese too.** The words a film lists for each role
  (`type.check.strings`, as its guide asks) are measured in the role's family after two blank fonts the kit makes,
  0.1 and 0.7 em wide, so a character the family lacks is told whatever fonts the host has (the system's generic
  families could not tell a missing Chinese one: every font that has a Han character draws it an em wide). Emoji are
  left out: the system's emoji font draws them whatever the family. It is a page error with the first frame:
  `Film: display "Instrument Serif" has no glyphs for: 雨停了`.

## API

All routes except `/health` need `Authorization: Bearer <AWWO_RENDER_TOKEN>`. Errors are
`{"error": {"code", "message", …}}`.

| Route | Answer |
|---|---|
| `GET /health` | 200 when ready, else 503: `{ready, service:"awwo-render", version:1, chrome, ffmpeg, sandbox, limits:{maxSeconds, maxFps, maxWidth, maxHeight, maxFrames, maxHtmlBytes}, busy}`. `ffmpeg` is true only when ffmpeg and ffprobe are both found. |
| `POST /internal/renders` | Renders and answers when done (see below). |
| `DELETE /internal/renders/{renderId}` | Stops the render in progress: 204, or 404 `RENDER_NOT_FOUND`. |

Request (`Content-Type: application/json`, body at most 8 MiB):

```json
{"renderId": "…", "html": "<!doctype html>…", "width": 1280, "height": 720, "fps": 30, "seconds": 6,
 "loop": true, "outputs": ["mp4", "gif", "contact"], "stills": [0, 90]}
```

- `renderId` `^[A-Za-z0-9_-]{8,80}$`; `html` a complete document (`<html` or `<!doctype html` in its first 4 KiB),
  at most 6 MiB as UTF-8, no NUL; `width`/`height` integers 64–1920, rounded down to even; `fps` integer 1–60;
  `seconds` 0.5–`AWWO_RENDER_MAX_SECONDS`; `N` must be 1–1800; `loop` boolean (GIF loops forever or plays once);
  `outputs` ⊆ {mp4, gif, contact} — an MP4 is always made; `stills` at most 8 distinct frame numbers in 0 … N-1.

Reply 200:

```json
{"renderId", "mode": "contract|virtual-time", "frames", "fps", "width", "height", "seconds", "distinctFrames",
 "elapsedMs", "probe": {"frames", "width", "height", "duration"}, "warnings": [], "pageErrors": [],
 "sound": null | {"codec": "aac", "sampleRate": 48000, "channels": 2, "seconds",
   "loudness": {"integratedLUFS", "truePeakDb", "rangeLU"}, "pageSampleRate", "peak", "faded"},
 "soundReason": "…",
 "outputs": [{"kind": "mp4|gif|contact|still", "frame": 0, "contentType", "size", "sha256", "data"}]}
```

`data` is base64 of the file, `sha256` the hex digest of its bytes, `frame` only on stills (PNG). `pageErrors`
keeps the first three messages (≤ 200 characters each). `probe` reads the picture before any sound is added. `sound`
is null for a silent video; for one that carries its page's sound it gives the sound's stream, its loudness as
measured from the video, the rate the page made it at, the page's own peak (before levelling) and whether its end was
faded. `soundReason`, only with `sound_failed`, is why the page's sound was left out: the renderer's words, or what the
page threw. Warnings: `static_page` (every frame identical), `page_errors:<n>`, `network_blocked:<n>`,
`gif_fps_reduced` (a GIF over 350 frames drops to `floor(350 / seconds)` fps), `gif_too_large` (> 15 MiB, left
out), `contact_too_large` (> 10 MiB), `gif_failed` / `contact_failed` (left out; the MP4 stands), `still_too_large`
(stills that would take the reply over 112 MiB of files), `ready_timeout`, `fonts_timeout`, `timer_limit`,
`probe_frames:<n>` (ffprobe counted other than N); of the page's sound: `sound_failed` (left out, the video is
silent), `sound_silent` (it was silence: none added), `sound_clipped:<frames>` and `sound_not_finite:<frames>` (as an
edit's page sound), `sound_page_errors:<n>` and `sound_network_blocked:<n>` (the page's while its sound was made).

Failures:

| Status | Code | When |
|---|---|---|
| 400 | `INVALID_RENDER` (+ `field`) | Invalid request or JSON, wrong Content-Type; or a page whose `renderAt` waits on its own clock (`field` `html`, `detail` `page_waits_on_timers`, see the render contract) |
| 401 | `UNAUTHORIZED` | Missing or wrong token |
| 413 | `TOO_LARGE` | Body over 8 MiB |
| 429 | `RENDER_BUSY` | A render is already running (one at a time, never queued) |
| 503 | `RENDER_UNAVAILABLE` (+ `detail`) | Not ready, or the browser / ffmpeg / temporary space failed (`browser_unavailable`, `ffmpeg_unavailable`, `tmp_unavailable`) |
| 422 | `RENDER_FAILED` + `detail` | `timeout`, `page_load_failed` (did not load in 30 s, crashed or navigated away), `output_too_large` (MP4 > 80 MiB), `ffmpeg_failed`, `aborted`, `render_failed` |

A caller that disconnects stops its render.

## Edits (the canvas's edit node)

An edit joins clips, sounds and pictures into one film by an `awwo.timeline/1` document (`edit-timeline.mjs` is its
one definition: every field, default and limit). Only the API calls it, for a canvas run's edit node
(`backend/internal/app/edits.go`); it sends the job's files to the worker, because the worker cannot read the API's
media directory. A job holds the worker like a render does, so a render waits while an edit runs, and the other way.

| Route | Answer |
|---|---|
| `POST /internal/edits` | JSON `{editId, timeline, files: [{name, size, sha256}]}` (at most 4 MiB): the timeline is checked against the file names before any byte arrives → 201 `{editId, files, expiresInSeconds}`; 400 `INVALID_EDIT` + `field`; 429 `WORKER_BUSY` |
| `PUT /internal/edits/{id}/files/{index}` | `application/octet-stream`, the file's bytes, streamed to disk → 204; 400 `EDIT_FILE_MISMATCH` (size or sha256; the file may be sent again), 409 when already received or the job was stopped |
| `POST /internal/edits/{id}/render` | probes every file, places the timeline on whole frames, renders → 200 `{editId, report, outputs: [{name, kind, contentType, size, sha256}]}`; 409 `EDIT_FILES_MISSING` + `missing`; 400 `INVALID_EDIT` (a duration the timeline gets wrong, named with the value expected); 422 `EDIT_FAILED` + `detail`; a caller that disconnects stops it |
| `GET /internal/edits/{id}/outputs/{name}` | one output file |
| `DELETE /internal/edits/{id}` | stops and removes the job (204); a job left without a request for `AWWO_EDIT_IDLE_MS` is removed too |

How it renders (`edit-run.mjs`, argument lists in `edit-ffmpeg.mjs`): cards through the page renderer at the film's
size, as pictures alone (a card's own `renderAudio` is never made: the film's sound is the timeline's, a page sound
item included; a card whose `renderAt` waits on its own clock is refused as the timeline's fault, 400 `INVALID_EDIT` on
`tracks.video[<i>].card` with the renderer's reason; a card that fails otherwise is 422 `card_failed`); every picture
piece (an item's own frames, and each transition as its own piece through `xfade`) encoded once
from its source at the film's settings (a clip's picture stream as the probe measured it; a picture, PNG, JPEG, WebP or
a GIF's first frame, decoded once and held) and checked for its frame count, then joined by stream copy; sounds trimmed,
levelled (per file, with `mix.levels`), faded, delayed to the sample and mixed per track in batches of 48; music and
sfx ducked under the dialogue's own windows and muted inside silences; two-pass `loudnorm` to the film's loudness and
true peak; the MP4 checked for its frame count and its size (with the manifest's `limits.maxFilmBytes`, the largest
film the API stores, the picture's peak rate is capped to fit, counting a one-second buffer for every piece, and a film
over it all the same fails `film_too_large`); stills every `stillsEverySeconds`, the `.srt`, and `report.json`.
Children run at a lower CPU priority than the worker. Outputs: `<name>.mp4`, `<name>.srt`, `still-NNN.jpg`, `report.json`.

**Sounds a page makes.** An item of `dialogue`, `music` or `sfx` may name a page instead of a wired file:
`{"page": "<!doctype html>…", "seconds": 30, "at": 0, …}` (a complete HTML document of at most 256 KiB, as a card;
`seconds` 0.5–300, how long its sound is; at most 8 such items, though the API takes a timeline of at most 2 MiB in
all). Before the timeline is placed, each page is opened in the same fresh, walled browser as a render (CDN allowlist,
virtual clock; a page that crashes or navigates fails) and, once it has loaded, `window.renderAudio({seconds,
sampleRate})` is called once and has 120 s; it resolves to an `AudioBuffer` (what `OfflineAudioContext.startRendering()`
gives) or `{sampleRate, channels: [Float32Array, …]}` (one or two channels, 8000–48000 samples a second). The worker keeps
exactly `round(seconds × the page's rate)` frames of it as a 16-bit stereo WAV at that rate (padded with silence when up
to 50 ms short; anything past `seconds` is never read). It is read out through two functions installed before any script
of the page, which take one number and answer one string (never an object, which would meet the page's prototypes on
its way), and the worker checks every answer's numbers and every part's exact length itself, so a page cannot change
how much is read, held or written. From then on the item is a sound like any other: `in`/`out`,
`loop`, `gainDb`, fades, levels, ducking and loudness apply. A page's sound that cannot be made is refused as the
timeline's fault, 400 `INVALID_EDIT` naming `tracks.<track>.page`, with the reason (no `renderAudio`, what it threw, a
sound shorter than `seconds`, a page that did not load, crashed or navigated, a `renderAudio` that waited on its own
clock, or a sound that took longer than its 120 s); a worker that could not
make it, or could not open the page in a render's time, answers 503 or 422 `EDIT_FAILED` (`sound_render_failed`). Time stands still while it runs, so `renderAudio`
must not wait for a timer or an animation frame: one that does, with nothing else to wait for, is refused after 5 s
rather than at its 120 s (see the render contract). The report lists them under `pageSounds` (`item`, `seconds`, `peak`),
its warnings name them by item (`sound_clipped:<frames>:<item>`, `sound_not_finite:<frames>:<item>`,
`sound_silent:<item>`, `sound_page_errors:<count>:<item>`, …), and so do its messages (`score (tracks.music[0])`). This is
how a film written as code (cards on the picture's track) gets a score and effects written to the same frame clock.

## Configuration

| Variable | Default | |
|---|---|---|
| `AWWO_RENDER_LISTEN` | `127.0.0.1:8111` | `host:port` (`[::1]:port` for IPv6) |
| `AWWO_RENDER_TOKEN` | — | Shared bearer token; shorter than 32 characters = not ready |
| `AWWO_RENDER_CHROME` | — | Chrome/Chromium executable (required for ready) |
| `AWWO_RENDER_FFMPEG` | `ffmpeg` | Path, or a name looked up on `PATH` |
| `AWWO_RENDER_FFPROBE` | `ffprobe` | Path, or a name looked up on `PATH` |
| `AWWO_RENDER_TMP` | `os.tmpdir()` | Root for each render's own temporary directory |
| `AWWO_RENDER_MAX_SECONDS` | `20` | Longest render, 0.5–60 (the API allows 20) |
| `AWWO_RENDER_TIMEOUT_MS` | `360000` | Whole-render limit, 5,000–1,800,000 (the API waits 8 minutes) |
| `AWWO_RENDER_CHROME_SANDBOX` | `1` | `0` turns Chromium's own sandbox off, only for hosts that cannot provide it |
| `AWWO_EDIT_MAX_SECONDS` | `1200` | Longest film an edit makes, 1–3600 |
| `AWWO_EDIT_MAX_INPUT_BYTES` | 6 GiB | The files one edit may bring, 1 MiB–64 GiB |
| `AWWO_EDIT_TIMEOUT_MS` | `3600000` | Whole-edit limit, 60,000–14,400,000 (the API's render step waits `AWWO_EDIT_TIMEOUT`, 75 minutes) |
| `AWWO_EDIT_IDLE_MS` | `600000` | How long a job may sit without a request before it is removed, 1,000–3,600,000 |

A malformed value stops the worker at startup. Limits: 1920×1920, 60 fps, 1,800 frames, 6 MiB of HTML.

## Security model

- **Fresh browser per render**: a new Chromium process, one context, no cookies, storage or cache carried over;
  service workers and downloads blocked, extra windows closed, closed in `finally` however the render ends.
  Chromium's sandbox stays on (Playwright turns it off by default; this worker does not).
- **CDN-only network, two walls**: (1) every request goes through a router that allows `data:`, `blob:`, `about:`
  and https to an allowlisted origin exactly (default port, no credentials) and aborts the rest; WebSockets are
  refused; WebRTC is removed from every frame. (2) The router never sees a redirect's next hop, so Chromium also
  runs with `--host-resolver-rules` that make every host but the CDNs (IP literals included) unresolvable,
  `--no-proxy-server` (it connects directly, never through a host or environment proxy) and no raw-UDP WebRTC.
  A CDN that redirects elsewhere, a preconnect or a direct IP therefore fails too.
- **No secrets in the page**: the page gets nothing but its own HTML; no token, cookie or header of the API.
- **Allowlisted child environment**: ffmpeg, ffprobe and Chromium are started without a shell and with only
  `PATH`, `SystemRoot`, `SYSTEMROOT`, `TEMP`, `TMP`, `HOME`, `LANG` (on Windows libuv also copies its fixed set of
  required variables such as `USERPROFILE`; none are secrets). The worker's token never reaches a child.
- **One render at a time**, bounded by `AWWO_RENDER_TIMEOUT_MS`; each render's temporary directory (and only it)
  is removed when it ends; the ffmpeg child is killed on abort.
- Worker-side messages (ffmpeg stderr, launch errors) go to stderr; the API shows its own stable codes instead.

## Run locally

```bash
npm ci   # playwright-core only; never downloads a browser (PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 when adding it)
AWWO_RENDER_TOKEN=<32+ characters> \
AWWO_RENDER_CHROME="C:/Program Files/Google/Chrome/Application/chrome.exe" \
AWWO_RENDER_FFMPEG=C:/tools/ffmpeg/bin/ffmpeg.exe AWWO_RENDER_FFPROBE=C:/tools/ffmpeg/bin/ffprobe.exe \
npm start
```

On Linux point `AWWO_RENDER_CHROME` at the system Chromium (e.g. `/usr/bin/chromium`) and install ffmpeg.

## Tests

```bash
npm test     # unit + HTTP tests; no browser or ffmpeg needed (integration tests are skipped)
npm run check
AWWO_RENDER_TEST_CHROME="C:/Program Files/Google/Chrome/Application/chrome.exe" \
AWWO_RENDER_FFMPEG=C:/tools/ffmpeg/bin/ffmpeg.exe AWWO_RENDER_FFPROBE=C:/tools/ffmpeg/bin/ffprobe.exe npm test
```

The integration tests render real pages (CSS keyframes, a `renderAt` canvas, a `requestAnimationFrame` page twice
for identical bytes, blocked requests, a hung page stopped at the timeout, a `renderAt` that leaves its drawing to a
microtask, a `renderAt` and a `renderAudio` that wait on their own clock, refused in seconds, and pages that are ready
at once, set `__ready` from a timer, or wait longer with timers of their own pending, made as before: a busy main
thread, a worker on its own timer, an `AbortSignal.timeout`, a delayed `scheduler.postTask`, animations of an element
that is not drawn, of one not in the document and of none, an `OfflineAudioContext`, real-time audio, an audio element;
an abort; a page with a `renderAudio`, whose MP4 carries its sound at -16 LUFS beside the very picture the same page
without one gives, read back with ffprobe and ffmpeg's own meter, and the sound left out of a video, said why, when it
throws, is short, waits on its own clock, is silence or meets the render's limit, faded when the render cuts it, and
stopped with the render) and check that the launch
flags alone refuse local hosts and IPs. With `AWWO_RENDER_CHROME_SANDBOX=1` (the default) on Linux they run as
production does, Chromium's own sandbox on. `network.test.mjs` keeps `cdn-allowlist.json` equal to the web preview's
`LIVE_CDNS`; change both together. `awwo-check-page`, the sandbox's page check (`deploy/saas/workspace`), loads a page
that defines `renderAt` or `renderAudio` again on this clock and fails one this worker would refuse; it carries copies
of `virtual-time.mjs` and `held-clock.mjs`, which `held-clock.test.mjs` keeps equal to these, so change both together
(and rebuild the workspace image).
