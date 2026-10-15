# AwwO render worker

An internal service that turns a self-contained HTML animation page into an MP4 (plus, on request, a GIF, a
contact sheet and still frames). It opens the page in a fresh headless Chromium, freezes it at every frame time,
screenshots each frame and pipes the PNGs to ffmpeg. Only the AwwO API calls it (`backend/internal/app/renders.go`,
enabled by `AWWO_RENDER_URL` + `AWWO_RENDER_TOKEN`); the videos become artifacts of the canvas.

## Render contract for pages

Every frame must be a pure function of the time `t` in seconds. Frame `i` is shown at `t = i / fps` for
`i = 0 … N-1`, with `N = round(seconds × fps)`; the last frame is always earlier than `seconds`, so a loop renders
frames 0 … N-1 and repeats seamlessly.

- **`window.renderAt(t)`** (contract mode, recommended): called once per frame before the screenshot. It may return
  a promise; the frame waits for it. An exception is recorded as a page error and the render goes on.
- **CSS keyframes, transitions and Web Animations** are allowed: before every frame each animation is paused and
  placed at `t`, measured from the frame it first appeared in (animations present at load start at 0).
- **No `renderAt`** (virtual-time mode): the page runs on a virtual clock injected before any page script.
  `performance.now()`, `Date.now()`, `new Date()`, `requestAnimationFrame`, `setTimeout`/`setInterval` and
  `Math.random` (seeded, so the same every render) are replaced; time stands still between frames, so a frame shows
  exactly its `t` however long the screenshot takes. Timers fire at their own due times; at most 10,000 timer
  firings per frame (warning `timer_limit`). Web workers and cross-origin frames keep real time.
- **`window.__ready`**: a page that defines it is waited for (up to 10 s) until it is `true`, after `load` and
  `document.fonts.ready` (warnings `ready_timeout`, `fonts_timeout`).
- The page may load scripts, styles and fonts only from the CDN origins in `cdn-allowlist.json` (the same list as
  the web preview's `LIVE_CDNS`); everything else is blocked. It must not navigate away (that fails the render).

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
 "outputs": [{"kind": "mp4|gif|contact|still", "frame": 0, "contentType", "size", "sha256", "data"}]}
```

`data` is base64 of the file, `sha256` the hex digest of its bytes, `frame` only on stills (PNG). `pageErrors`
keeps the first three messages (≤ 200 characters each). Warnings: `static_page` (every frame identical),
`page_errors:<n>`, `network_blocked:<n>`, `gif_fps_reduced` (a GIF over 350 frames drops to `floor(350 / seconds)`
fps), `gif_too_large` (> 15 MiB, left out), `contact_too_large` (> 10 MiB), `gif_failed` / `contact_failed` (left
out; the MP4 stands), `still_too_large` (stills that would take the reply over 112 MiB of files),
`ready_timeout`, `fonts_timeout`, `timer_limit`, `probe_frames:<n>` (ffprobe counted other than N).

Failures:

| Status | Code | When |
|---|---|---|
| 400 | `INVALID_RENDER` (+ `field`) | Invalid request or JSON, wrong Content-Type |
| 401 | `UNAUTHORIZED` | Missing or wrong token |
| 413 | `TOO_LARGE` | Body over 8 MiB |
| 429 | `RENDER_BUSY` | A render is already running (one at a time, never queued) |
| 503 | `RENDER_UNAVAILABLE` (+ `detail`) | Not ready, or the browser / ffmpeg / temporary space failed (`browser_unavailable`, `ffmpeg_unavailable`, `tmp_unavailable`) |
| 422 | `RENDER_FAILED` + `detail` | `timeout`, `page_load_failed` (did not load in 30 s, crashed or navigated away), `output_too_large` (MP4 > 80 MiB), `ffmpeg_failed`, `aborted`, `render_failed` |

A caller that disconnects stops its render.

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
for identical bytes, blocked requests, a hung page stopped at the timeout, an abort) and check that the launch
flags alone refuse local hosts and IPs. `network.test.mjs` keeps `cdn-allowlist.json` equal to the web preview's
`LIVE_CDNS`; change both together.
