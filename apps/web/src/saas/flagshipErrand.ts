import type { OfficialWorkflow, OfficialWorkflowNode } from './examples/officialWorkflows';
import { builderFor } from './flagshipRules';

/** Errand (owner request 2026-10-16, round 2): an agent workspace in one page. Besides the clean room of the other
 * flagships, three agents do real work in their own sandbox computers during the same run, every action through a
 * recorder that writes down what the computer printed; the page replays those sessions. */

// The open-source agent workspace the reading room reads (MIT): its web front end only, for evidence.
const ERRAND_SOURCE = 'https://github.com/OpenHands/OpenHands';

const ERRAND_KERNEL = `Errand kernel contract (fixed; every module uses exactly these names):
- Modules, in page order: core, shell, vfs, thread, computer, replay, agent, library; then the recorded sessions, data scripts that call U.library.add(session) as they run, before U.boot. Listeners get detail itself: U.on(type, fn) returns a function that removes the listener; U.emit(type, detail) calls each listener with detail.
- U.commands.register({ id, label, group, shortcut, run(args), enabled() }) (shortcut and enabled optional; the first registration of an id wins, a later one is refused with a console warning), U.commands.run(id, args) (an unknown id does nothing), U.commands.list(), U.commands.get(id). Every user action is a command; buttons, shortcuts and the command palette (Ctrl+K) run commands by id.
- U.state = { mode, sessionId, playhead, playing, speed, tab, openFile, follow, theme, connected }: mode 'replay' | 'live' | 'manual'; sessionId the open session's id or null; playhead in ms from the session's start; playing a boolean; speed 1, 2, 4 or 8; tab 'terminal' | 'editor' | 'files' | 'browser'; openFile the path the editor shows or null; follow true when the computer shows the tab of each new event; theme 'dark' | 'light'; connected true once a model is connected. U.set(patch) changes it and emits one event per changed key, named after the key, then 'view' with the list of changed keys. A fresh U.state (core's, and U.tests.scratch()'s): mode 'replay', sessionId null, playhead 0, playing false, speed 2, tab 'terminal', openFile null, follow true, theme 'dark', connected false.
- A session (format 1; the recorder that made the recorded ones writes exactly this): { v: 1, id, title, task, recordedAt (ISO time), where, durationMs, outcome ('done' | 'stopped' | 'failed'), summary, events }; events in time order, each { t (ms from the start), k, ...fields }, a field the recorder had no value for being absent:
  say { text }: the agent's message to the person. plan { steps: [text] }: a new plan, every step pending. step { i (counted from 1), status 'active' | 'done' | 'failed' }.
  run { cmd, out, err, code, ms, cut }: a shell command and what it printed (cut: characters the recorder left out).
  file { path, bytes, sha256, text, image, w, h, cut, removed }: a file written or changed, path relative to the session's home (text for a text file, image a data: URL for a picture, removed true when it was deleted).
  shot { target, w, h, image, html, error }: a page of the computer as a browser showed it (image a data: URL from a real headless browser; html the page's own text when the live agent opens it in this page; or error).
  fetch { url, status, type, bytes, excerpt, cut, error }: a web request. ask { id, title, detail, answer ('allowed' | 'denied'), by }: an action the agent asked the person to approve, and the answer. end { outcome, summary }.
- U.library: add(session) checks the format (v 1, an id and a title, events in time order, known kinds) and keeps it, or throws why; list() in the order added; get(id); remove(id); open(id) loads it into U.replay and sets mode 'replay', sessionId, playhead 0 and playing false; current() the open session or null; exportJSON(id) its JSON text; importJSON(text) adds it (a taken id gets a new one) and returns its id.
- U.vfs, the in-page computer: one file tree, home /home/errand (where a shell starts); paths absolute or relative to a cwd, with '.' and '..'. read(path) the text or null; write(path, text) makes missing parents and returns the bytes written; list(dir) [{ name, dir, bytes }] sorted by name; mkdir(path); remove(path, { recursive }); move(from, to); exists(path); stat(path) { dir, bytes } or null; snapshot() a deep copy and restore(snapshot); reset() an empty home. exec(line, { cwd }) returns { out, err, code, cwd }: built-ins pwd cd ls cat echo mkdir rm mv cp touch head tail wc grep sort uniq find tree clear true false js (js <file> runs the file's JavaScript in a function with a console whose lines become out; an uncaught error becomes err with code 1); words split on spaces with single and double quotes; |, > and >>, &&, || and ; work; an unknown command prints '<name>: command not found' to err with code 127; a failing built-in gives code 1 and a message.
- U.replay: load(session) indexes it. at(ms) returns { messages: [{ role 'person' | 'agent', text, t }], plan: [{ text, status }], terminal: [{ cmd, out, err, code, t }], files: [{ path, bytes, text, image, t }], browser, fetches: [{ url, status, excerpt, t }], asks: [{ id, title, detail, answer, t }], last } from the events at or before ms: the task is the person's first message at t 0; files keep each path's latest state, removed ones left out, sorted by path; browser is the latest shot ({ image or html, target, w, h, t }), or, when an .html file was written after it, { html, target: path, t }, or null; last is the last event at or before ms. It is a pure function of the session and ms. seek(ms) clamps to 0..durationMs, sets the playhead and emits 'replay' with at(ms); play() and pause() set playing; while playing, the playhead moves by elapsed real time × speed, a gap of more than 2 s between two events is crossed in 1 s, and play stops at the end; step(1) and step(-1) seek to the next or the previous event; takeOver() loads the text files at the playhead into U.vfs (U.vfs.reset(), then one write per file, under /home/errand) and sets mode 'manual' and playing false.
- U.agent: connect({ baseUrl, apiKey, model }) keeps them in memory only and sets connected. run(task) starts a live session (mode 'live'): it sends POST <baseUrl>/chat/completions (OpenAI format: model, messages, tools as JSON-schema functions, tool_choice 'auto') through U.agent.transport(request), which resolves to { status, json } (default: fetch with the key as a Bearer token; tests replace it, so they need no network), at most 40 model calls; it runs every tool call on U.vfs — shell { command }, write_file { path, content }, read_file { path }, list_files { path }, open_page { path }, plan { steps }, set_step { i, status }, say { text }, finish { summary } — and records each event as it happens, in the session format, in a session it adds to U.library, so a live session replays and exports like a recorded one; before a call that removes or overwrites a file or runs js, it asks the person (an approval card in the thread, Allow or Deny), waits for answer(id, 'allowed' | 'denied') and records an ask event with the answer; stop() ends it with outcome 'stopped'. When the transport throws (AwwO's preview blocks the network), it says in the thread that this copy of the page cannot reach the network and works when the page is opened on its own, and stops.
- U.views.register({ id, title, icon, order, render(element, view) }) for the computer's tabs; the computer module registers 'terminal', 'editor', 'files' and 'browser', and no other module registers a view. view is what the panel shows: in mode 'replay' U.replay.at(playhead); in 'manual' and 'live' { live: true, vfs: U.vfs, ...the live session's at(its end) }. A view whose render throws shows the error in its place and reports it with console.error.
- U.ui (the shell's): region(name) returns the layout's elements 'top', 'thread', 'computer', 'tabs', 'timeline', 'status'; show(tab) shows a view; toast(text); dialog({ title, body, actions }) returns a close function; icon(name) an inline SVG string (24 × 24, 1.5 px strokes, currentColor). The thread module renders into region 'thread' and the replay module into 'timeline'; the shell draws the shown view into region 'computer' by calling its render.
- U.tests.add(name, fn) (fn returns or resolves to true, or throws why), U.tests.plant(name, swap) (swap() installs a wrong variant and returns the function that restores it), U.tests.run() resolves to { tests: [{ name, ok, detail }], planted: [{ name, rejected, detail }] }; core sets window.awwoSelfTest = () => U.tests.run(). Every test and plant name starts with its module and a colon ('vfs: …'), and a test takes at most about half a second, never waiting for timers or frames (it calls functions directly: U.replay.at and seek, never play). U.tests.run() runs every test once, timing each; under each plant it replays the tests that passed, fastest first, and stops at the first that fails, which rejects the plant; every plant is restored even when a test throws. It saves U.state, the library's sessions and U.vfs before, runs each test from U.tests.scratch() (a fresh U.state and U.vfs.reset(); the library keeps its sessions), and restores all three after, so a self-test leaves the page as it was.
- U.module(name, init); U.boot(root) runs the inits in page order (one that throws is reported with a toast and the others still run), emits 'ready', then opens the first session in the library and plays it at speed 2, so the first view moves; with no session it shows the live view, empty.`;

const ERRAND_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Errand — an agent at work on its own computer</title>
<style>html,body{margin:0;height:100%;overflow:hidden;background:#0c1016;color:#e6ebf2;font:13px Inter,system-ui,sans-serif}#errand{position:fixed;inset:0}</style>
</head>
<body>
<div id="errand"></div>
<script>{{in:from_core}}</script>
<script>{{in:from_shell}}</script>
<script>{{in:from_vfs}}</script>
<script>{{in:from_thread}}</script>
<script>{{in:from_computer}}</script>
<script>{{in:from_replay}}</script>
<script>{{in:from_agent}}</script>
<script>{{in:from_library}}</script>
<script>{{in:from_site}}</script>
<script>{{in:from_climate}}</script>
<script>{{in:from_quakes}}</script>
<script>window.Errand ? window.Errand.boot(document.getElementById('errand')) : document.body.append('Errand did not load.');</script>
</body>
</html>`;

// The recorder every session agent works through: its file arrives byte for byte, so no model retypes it.
const REC_PY = String.raw`#!/usr/bin/env python3
"""Errand's session recorder. Every action of the agent goes through it: it does the action, prints what came back,
and writes the action down as it happened, for a replay in Errand. Its state lives in /tmp/rec, never in the workspace.
  python3 rec.py init "<title>" "<task>"         start the session (once, first)
  python3 rec.py say "<text>"                    a message to the person watching
  python3 rec.py plan "<step>" "<step>" ...      the plan; every step starts pending
  python3 rec.py step <n> active|done|failed     a plan step's status (n counts from 1)
  python3 rec.py run '<shell command>'           run it in the workspace with bash; record what it printed
  python3 rec.py write <path> < content          write stdin to a file in the workspace and record it
  python3 rec.py shot <page.html> [WxH]          screenshot a page of the workspace in headless Chromium
  python3 rec.py fetch <url> [save-as]           GET a web address with curl, record what came back, keep the body
  python3 rec.py end done|stopped|failed "<summary>"   close the session and write session.js into the workspace
Commands may run 110 s; a session holds at most 220,000 characters (screenshots and files count), and the recorder
cuts long output and files to keep within it, saying how much it cut."""
import base64
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import time

STATE_DIR = "/tmp/rec"
STATE = os.path.join(STATE_DIR, "session.json")
WS = os.getcwd()
BUDGET = 220_000
OUT_KEEP = (1600, 700)
TEXT_KEEP = 6000
IMAGE_MAX = 60_000
SKIP_DIRS = {".git", "node_modules", "__pycache__", ".cache", ".venv"}
SKIP_FILES = {"rec.py", "session.js"}
TEXT_EXT = {".html", ".htm", ".css", ".js", ".mjs", ".json", ".md", ".txt", ".csv", ".tsv", ".py", ".sh", ".svg",
            ".xml", ".yml", ".yaml", ".toml", ".ini", ".geojson"}
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp"}
CHROME = "/usr/lib/chromium/chromium-headless-shell"


def load():
    with open(STATE, encoding="utf-8") as f:
        return json.load(f)


def save(s):
    tmp = STATE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(s, f, ensure_ascii=False)
    os.replace(tmp, STATE)


def size(s):
    return len(json.dumps(s, ensure_ascii=False))


def cut(text, keep):
    head, tail = keep
    if len(text) <= head + tail:
        return text, 0
    return text[:head] + f"\n… {len(text) - head - tail:,} characters left out …\n" + (text[-tail:] if tail else ""), len(text) - head - tail


def add(s, k, **fields):
    event = {"t": int((time.time() - s["started"]) * 1000), "k": k, **fields}
    if size(s) + len(json.dumps(event, ensure_ascii=False)) > BUDGET:
        for key in ("image", "text", "excerpt", "out", "err"):
            if key in event and event[key]:
                event["cut"] = event.get("cut", 0) + len(event[key])
                event[key] = "" if key != "image" else None
        print(f"[rec] the session is near its {BUDGET:,}-character budget: this event is kept without its content")
    s["events"].append(event)
    save(s)
    return event


def image_url(path, max_side=640):
    """A small JPEG data URL of a picture, or None when it does not fit."""
    try:
        from PIL import Image
        with Image.open(path) as im:
            im = im.convert("RGB")
            im.thumbnail((max_side, max_side))
            for quality in (70, 55, 40):
                buf = io.BytesIO()
                im.save(buf, "JPEG", quality=quality, optimize=True)
                url = "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()
                if len(url) <= IMAGE_MAX:
                    return url, im.size
    except Exception as error:  # noqa: BLE001
        print(f"[rec] could not read the picture {path}: {error}")
    return None, None


def walk():
    found = {}
    for root, dirs, files in os.walk(WS):
        dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS)
        for name in sorted(files):
            if name in SKIP_FILES and root == WS:
                continue
            p = os.path.join(root, name)
            try:
                st = os.stat(p)
            except OSError:
                continue
            found[os.path.relpath(p, WS)] = (st.st_size, st.st_mtime_ns)
    return found


def file_event(s, rel):
    p = os.path.join(WS, rel)
    with open(p, "rb") as f:
        data = f.read()
    ext = os.path.splitext(rel)[1].lower()
    fields = {"path": rel, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
    if ext in IMAGE_EXT:
        url, wh = image_url(p)
        if url:
            fields.update(image=url, w=wh[0], h=wh[1])
    elif ext in TEXT_EXT or b"\0" not in data[:2048]:
        try:
            text = data.decode("utf-8")
            kept, n = cut(text, (TEXT_KEEP, 0)) if len(text) > TEXT_KEEP else (text, 0)
            fields.update(text=kept, cut=n)
        except UnicodeDecodeError:
            pass
    add(s, "file", **fields)


def changes(s):
    now = walk()
    seen = s.get("seen", {})
    for rel, (bytes_, mtime) in now.items():
        if seen.get(rel) != [bytes_, mtime]:
            file_event(s, rel)
    for rel in seen:
        if rel not in now:
            add(s, "file", path=rel, bytes=0, removed=True)
    s = load()
    s["seen"] = {rel: [b, m] for rel, (b, m) in now.items()}
    save(s)


def main(argv):
    if not argv:
        print(__doc__)
        return 2
    verb, args = argv[0], argv[1:]
    os.makedirs(STATE_DIR, exist_ok=True)
    if verb == "init":
        if os.path.exists(STATE):
            print("[rec] a session is already started; go on with it")
            return 1
        title, task = (args + ["", ""])[:2]
        save({"v": 1, "title": title.strip(), "task": task.strip(), "recordedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
              "started": time.time(), "events": [], "seen": {}})
        s = load()
        s["seen"] = {rel: [b, m] for rel, (b, m) in walk().items()}
        save(s)
        print(f"[rec] recording “{title.strip()}” in {WS}")
        return 0
    s = load()
    if s.get("closed"):
        print("[rec] the session is closed")
        return 1
    if verb == "say":
        add(s, "say", text=" ".join(args).strip())
    elif verb == "plan":
        add(s, "plan", steps=[a.strip() for a in args if a.strip()])
    elif verb == "step":
        n, status = int(args[0]), args[1]
        if status not in ("active", "done", "failed"):
            print("[rec] status is active, done or failed")
            return 2
        add(s, "step", i=n, status=status)
    elif verb == "run":
        cmd = " ".join(args) if args else sys.stdin.read()
        t0 = time.time()
        try:
            p = subprocess.run(["bash", "-c", cmd], cwd=WS, capture_output=True, timeout=110)
            out, err, code = p.stdout.decode("utf-8", "replace"), p.stderr.decode("utf-8", "replace"), p.returncode
        except subprocess.TimeoutExpired as e:
            out = (e.stdout or b"").decode("utf-8", "replace")
            err = (e.stderr or b"").decode("utf-8", "replace") + "\n[rec] stopped after 110 s"
            code = 124
        ms = int((time.time() - t0) * 1000)
        sys.stdout.write(out)
        sys.stderr.write(err)
        o, n1 = cut(out, OUT_KEEP)
        e, n2 = cut(err, OUT_KEEP)
        add(s, "run", cmd=cmd.strip(), out=o, err=e, code=code, ms=ms, cut=n1 + n2)
        changes(load())
        print(f"\n[rec] exit {code} in {ms} ms")
        return 0
    elif verb == "write":
        rel = os.path.normpath(args[0])
        if rel.startswith("..") or os.path.isabs(rel):
            print("[rec] write files inside the workspace")
            return 2
        data = sys.stdin.buffer.read()
        os.makedirs(os.path.dirname(os.path.join(WS, rel)) or WS, exist_ok=True)
        with open(os.path.join(WS, rel), "wb") as f:
            f.write(data)
        changes(s)
        print(f"[rec] wrote {rel} ({len(data):,} bytes)")
    elif verb == "shot":
        rel = os.path.normpath(args[0])
        w, h = (int(x) for x in (args[1] if len(args) > 1 else "1280x800").split("x"))
        png = os.path.join(STATE_DIR, f"shot-{len(s['events'])}.png")
        url = "file://" + os.path.join(WS, rel)
        cmd = [CHROME, "--headless", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--force-color-profile=srgb",
               "--host-resolver-rules=MAP * ~NOTFOUND", "--virtual-time-budget=1500", f"--window-size={w},{h}", f"--screenshot={png}", url]
        browser = next((b for b in (CHROME, shutil.which("chromium-headless-shell"), shutil.which("chromium"))
                        if b and os.path.exists(b)), None)
        if browser:
            try:
                subprocess.run([browser, *cmd[1:]], capture_output=True, timeout=60)
            except (subprocess.TimeoutExpired, OSError):
                pass
        if not os.path.exists(png):
            add(s, "shot", target=rel, w=w, h=h, image=None, error="the browser made no screenshot")
            print("[rec] the browser made no screenshot")
            return 1
        image, wh = image_url(png, 720)
        add(s, "shot", target=rel, w=w, h=h, image=image)
        print(f"[rec] screenshot of {rel} at {w}x{h} recorded ({png})")
    elif verb == "fetch":
        url = args[0]
        body = os.path.join(STATE_DIR, f"fetch-{len(s['events'])}.bin")
        p = subprocess.run(["curl", "-sS", "-L", "--max-time", "60", "-o", body, "-w", "%{http_code} %{content_type}", url],
                           capture_output=True)
        status, _, ctype = p.stdout.decode().partition(" ")
        data = open(body, "rb").read() if os.path.exists(body) else b""
        text = data.decode("utf-8", "replace")
        if "html" in ctype:
            text = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", re.sub(r"(?is)<(script|style).*?</\1>", " ", text))).strip()
        excerpt, n = cut(text, (1500, 0)) if len(text) > 1500 else (text, 0)
        add(s, "fetch", url=url, status=int(status or 0), type=ctype.strip(), bytes=len(data), excerpt=excerpt, cut=n,
            error=p.stderr.decode().strip()[:300] or None)
        if len(args) > 1:
            rel = os.path.normpath(args[1])
            with open(os.path.join(WS, rel), "wb") as f:
                f.write(data)
            changes(load())
        print(f"[rec] {status} {ctype.strip()} {len(data):,} bytes; body in {body}")
        print(excerpt[:1500])
    elif verb == "end":
        outcome = args[0] if args and args[0] in ("done", "stopped", "failed") else "done"
        summary = " ".join(args[1:]).strip()
        add(s, "end", outcome=outcome, summary=summary)
        s = load()
        s["closed"] = True
        save(s)
        events = s["events"]
        session = {"v": 1, "id": hashlib.sha256((s["title"] + s["recordedAt"]).encode()).hexdigest()[:12],
                   "title": s["title"], "task": s["task"], "recordedAt": s["recordedAt"],
                   "where": "an AwwO sandbox computer", "durationMs": events[-1]["t"] if events else 0,
                   "outcome": outcome, "summary": summary, "events": events}
        text = json.dumps(session, ensure_ascii=False, separators=(",", ":"))
        text = text.replace("</", "<\\/").replace("<!--", "<\\!--").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
        with open(os.path.join(WS, "session.js"), "w", encoding="utf-8") as f:
            f.write("window.Errand&&window.Errand.library.add(" + text + ");\n")
        print(f"[rec] session closed: {len(events)} events, {len(text):,} characters in session.js")
    else:
        print(__doc__)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
`;

const errandBuilder = builderFor({ app: 'Errand', global: 'Errand', noun: 'workspace', kernel: ERRAND_KERNEL, column: 2, others: 'seven', modules: 'core, shell, vfs, thread, computer, replay, agent, library' });

const ERRAND_BUILDERS: ReadonlyArray<OfficialWorkflowNode> = [
  errandBuilder('core', 'Kernel', 0, 'Your duties (core): window.Errand and every kernel name the other modules do not own — the event bus; the command registry; one keydown listener on window that runs the command whose shortcut matches, never while focus is in an input, a textarea or a contenteditable element, Escape and Ctrl+K excepted; U.state and U.set; U.module and U.boot; U.library exactly as the contract says, each refusal of add naming its reason (the version, a missing id or title, events out of time order, an unknown kind); U.tests with its save and restore. Commands: session.open (args { id }), session.next and session.previous (through the library\'s order, wrapping), view.theme (toggles dark and light), help.selftest (runs U.tests.run() and shows in a dialog the tests passed of total and the plants caught of total, then each failure with its detail), help.shortcuts (a dialog listing every command that has a shortcut). Tests (each under 0.1 s, in a fresh state): U.set emits one event per changed key and then view with the changed keys; a second registration of a command id is refused and the first still runs; U.library.add refuses events out of time order and a session with v 2, each with its reason; exportJSON then importJSON gives an equal session under a new id; U.tests.scratch() leaves U.state at the fresh values the contract lists. Plants: a U.set that emits nothing for a changed key; a library that accepts events out of order.', 12000),
  errandBuilder('shell', 'Interface', 1, 'Your duties (shell): the frame and the whole look, created at your init (you boot second, right after core) as the spec\'s layout gives it, and U.ui exactly as the contract says. Regions: top (the Errand mark and name, the open session\'s title with where and when it was recorded under it ("Recorded 18 Oct 2026 in an AwwO sandbox computer"), the mode badge Replay, Live or Manual, and buttons that run library.open, library.share, replay.takeover, agent.connect and view.theme), thread on the left (38% of the width, at least 320 px), computer on the right with tabs above it (one tab per registered view in order, each with its icon and title, the active one marked; a click shows it) and the timeline under it, and status at the bottom (the session\'s events at the playhead of all, commands run, files, the time at the playhead of the duration, and a self-test badge that runs help.selftest); the line between thread and computer drags to resize; below 900 px wide the thread stacks above the computer. On \'ready\' and when U.state.tab changes, show the tab\'s view: call its render(element, view) with the view the contract describes, again on every \'replay\' event and on mode changes, at most once per animation frame; above the tabs an activity line says what the latest event is ("Running: npm test", "Writing site/index.html", "Looking at index.html", "Reading earthquake.usgs.gov", "Waiting for your approval", "Done"). U.ui.dialog draws a modal panel with its title, body element or text and action buttons, Escape and a click outside close it; U.ui.toast shows a line for 3 s; U.ui.icon returns inline SVG for at least: play, pause, back, forward, terminal, editor, files, browser, library, share, takeover, model, theme, check, cross, spinner, warning, search. The command palette: Ctrl+K opens a dialog with a filter box over every command\'s label and group (a match of the typed letters in order), arrow keys move, Enter runs. Look: the spec\'s colour tokens for dark and light as CSS custom properties on the root, Inter for the interface, JetBrains Mono for the computer, 8 px spacing, 6 px radii, quiet borders, the event-kind colours on chips and ticks. Commands: view.palette (Ctrl+K), view.terminal, view.editor, view.files, view.browser (Alt+1 to Alt+4), view.follow (toggles follow). Tests: after init every region the contract names exists; show(\'browser\') sets U.state.tab and draws that view; a view whose render throws shows the error in its place and calls console.error; the palette filter for \'take\' lists the replay.takeover command first. Plants: a region() that returns the computer for \'thread\'; a palette that filters by the first letter only.', 22000),
  errandBuilder('vfs', 'Virtual computer', 2, 'Your duties (vfs): U.vfs exactly as the contract lists it — the tree as nested maps, text files only, bytes counted as UTF-8, a path resolver for absolute and relative paths with . and .. (above / stays at /), and exec: a line parser (single quotes keep everything, double quotes keep spaces, a backslash escapes the next character), then pipelines split on ; && || with their exit-code rules, each pipeline on |, each command\'s > or >> redirection to a file (relative to the cwd), stdin passed down the pipe. Built-ins, with the usual options the spec lists: pwd; cd (no argument goes home); ls (-l with sizes, -a, -1; a directory lists its entries, sorted); cat (files and stdin); echo (-n); mkdir (-p); rm (-r, -f); mv; cp (-r); touch; head and tail (-n N, default 10); wc (-l -w -c); grep (-i -n -v -c, a regular expression, files or stdin); sort (-r -n -u); uniq (-c); find (a directory, -name with * and ?); tree; clear (out is the form feed \\f, which the terminal reads as clear); js (js <file> [args]: runs the file\'s JavaScript as the body of a function given console and args, console.log lines join out, console.error lines err; a thrown error is err "<name>: <message>" with code 1). Errors read like a shell\'s: "cat: notes.txt: No such file or directory" with code 1. Tests: write then read gives the text and stat its UTF-8 bytes (a 3-byte character counted as 3); mkdir -p a/b/c then ls a/b lists c; echo hi > x.txt; echo there >> x.txt; cat x.txt prints two lines; grep -c th x.txt prints 1; echo \'b a\' | wc -w prints 2 and cat x.txt | sort -r prints there before hi; cd .. above / stays at /; an unknown command gives code 127 and the message; false && echo no prints nothing and true || echo no prints nothing (implement true and false); js runs a file that logs 2 + 2 and out is 4. Plants: >> that overwrites instead of appending; cd .. that does not move up; an unknown command that returns code 0.', 18000),
  errandBuilder('thread', 'Thread', 3, 'Your duties (thread): the conversation in region \'thread\', drawn from the view the contract describes (the replay\'s at(playhead), or the live session\'s): the plan pinned at the top as a checklist (pending, active with a spinner, done with a check, failed with a cross; "3 of 5 done"); then the person\'s task as their message, the agent\'s messages (say) as plain text with paragraphs, and between them one compact chip per run, file, shot and fetch event in time order ("Ran python3 analyse.py · exit 0 · 1.2 s", "Wrote site/index.html · 2.1 KB", "Looked at index.html at 390 × 844", "Fetched earthquake.usgs.gov · 200"), each in its kind\'s colour, a failed command\'s chip marked; a click on a chip seeks the replay to that event\'s time, shows its tab and, for a file, opens it in the editor (U.set({ openFile })); approval cards for ask events (title, detail, the answer and who gave it; in mode \'live\' a pending card has Allow and Deny buttons that settle U.agent\'s pending approval); the end card with the outcome and the summary. Only the elements that changed are redrawn when the playhead moves, and the list stays scrolled to the newest item unless the person has scrolled up (then a "Jump to latest" button shows). The composer at the bottom: in mode \'replay\' a line "A recorded session, replayed. Take over to use its computer." with a Take over button (replay.takeover); in \'manual\' a line "You have the computer. Type in the terminal or edit files." with a Hand back button (replay.handback); in \'live\' a task box (Enter sends, Shift+Enter a new line) with Send (agent.run) and Stop (agent.stop), the box disabled while the agent works, and when no model is connected a Connect model button (agent.connect). Tests: a view with a plan of three steps, one done, shows "1 of 3 done"; a run chip for code 2 is marked failed; a click on a file chip seeks to its time and sets openFile to its path; an ask with answer denied shows its title and Denied; in mode replay the composer offers Take over. Plants: a plan counter that counts active steps as done; chips drawn in reverse time order.', 18000),
  errandBuilder('computer', 'Computer', 4, 'Your duties (computer): the four views, registered in your init with U.views.register in this order — terminal, editor, files, browser. Terminal: the commands so far as a scrollback, each a prompt line (the cwd in its colour, then the command) and its output in JetBrains Mono, err in the error colour, a chip with the exit code when it is not 0, and "… N characters left out" where the recorder cut; in mode \'manual\' or \'live\' an input line at the bottom that runs U.vfs.exec and appends the result (Up and Down walk its history; a form feed in out clears the scrollback). Editor: a file tree on the left (folders open and close, the open file marked) and the open file (U.state.openFile, else the latest file written) with line numbers and light colouring for html, css, js, json, py, md and csv (keywords, strings, comments, numbers, tags); a picture shows as an image with its size; a file the recorder cut ends with the cut note; in mode \'manual\' the file is editable and Ctrl+S writes it to U.vfs with a toast. Files: a table of every file with its path, size, kind and the time it last changed (mm:ss into the session); a click opens it in the editor. Browser: an address line with the target, then the latest screenshot as an image at its size (scaled down to fit) with "Rendered by headless Chromium in the agent\'s sandbox computer"; for an html file written after the last shot, a static render of it into a shadow root (no script runs) with a note that scripts do not run here; under it "Pages the agent read": each fetch with its url, status and excerpt. When U.state.follow is on and the view\'s last event changes, show the tab of its kind (run: terminal; file: editor with that file; shot and fetch: browser). Tests: the terminal draws a command, its output and a chip for exit code 1; the editor shows line numbers for a three-line file; the files table lists two files sorted by path; the browser shows the shot\'s image for a view whose browser is a shot; follow switches to the editor on a file event. Plants: a terminal that drops err; an editor that numbers lines from 0.', 24000),
  errandBuilder('replay', 'Replay', 5, 'Your duties (replay): U.replay exactly as the contract says, and the timeline in region \'timeline\': play and pause, step back and forward, the speed (1×, 2×, 4×, 8×), the time at the playhead and the duration (m:ss), and a track with one tick per event in its kind\'s colour (run, file, shot, fetch, say, plan and step, ask, end), the played part shaded; a click or a drag on the track seeks; hovering a tick names its event. The play loop runs on requestAnimationFrame and calls seek when the playhead crosses an event or 250 ms have passed, so the views redraw at most four times a second between events. Commands: replay.toggle (Space), replay.play, replay.pause, replay.step-forward (Right), replay.step-back (Left), replay.forward-10 (Shift+Right), replay.back-10 (Shift+Left), replay.speed (cycles 1, 2, 4, 8), replay.restart (Home), replay.end (End), replay.takeover (T), replay.handback (back to mode \'replay\' at the playhead, the in-page computer kept). Tests (the first three of the spec\'s acceptance tests are yours; each builds a small session in the test with say, plan, step, run, file, shot and end events and loads it): at(0) holds only the task; at the time of the file event files has its path with its text; at the end the plan\'s steps have their last status and browser is the shot; seek(-5) clamps to 0 and seek past the end to durationMs; step(1) from 0 lands on the first event\'s time; at() called twice for one ms gives equal results; takeOver() at the end makes U.vfs.read(\'/home/errand/\' + the file\'s path) its text and sets mode manual. Plants: an at() that leaves out the event exactly at ms; a seek that does not clamp.', 18000),
  errandBuilder('agent', 'Live agent', 6, 'Your duties (agent): U.agent exactly as the contract says, and the Connect dialog (agent.connect): base URL (e.g. https://api.example.com/v1), API key (a password field), model, with the note "Kept in this page only and sent only to this address."; Connect saves them with U.agent.connect. Your module is the one exception to the rule below about the network: it alone calls fetch, only to the person\'s base URL, and only after they connect; everything else stays offline. agent.run(task) builds the session (title from the task\'s first words, recordedAt now, where "this page"), adds it to U.library, opens it in mode \'live\' and loops: the system message (the spec\'s, at most 1,200 characters: who Errand is, the computer and its home, plan first with the plan tool, say what you do as you go, ask nothing you can find out, finish with a summary), the messages so far, and the nine tools as JSON-schema functions; each tool call runs on U.vfs and its result goes back as a tool message (shell gives out, err and code; write_file the bytes; read_file the text or an error; list_files the entries; open_page records a shot event with { html, target } of the file instead of an image; plan, set_step, say and finish record their events); every event is appended to the session as it happens and emitted as \'replay\' so the views follow. Approvals: a shell command that runs rm, mv onto an existing file, or js, and a write_file onto an existing file, wait for the person: emit \'ask\' with { id, title, detail } and resolve when U.agent.answer(id, \'allowed\' | \'denied\') is called (the thread\'s buttons call it); a denied call returns "The person did not allow this." to the model; the card for js says it runs in this page, with access to what the page holds, the key included. Errors: an HTTP status other than 200 says the status and the body\'s first 300 characters in the thread and stops with outcome failed; malformed tool arguments go back to the model as a tool error; a thrown transport says the network message from the contract and stops with outcome failed; after 40 model calls it stops with outcome stopped. Commands: agent.connect, agent.run (args { task }), agent.stop, agent.new (a fresh live session). Tests (each with a scripted transport that answers from a list, no network): a model that calls plan, then shell with echo hi, then finish records plan, run (out hi) and end events in that order; a write_file onto an existing file waits for an answer and a denied answer leaves the file as it was; the 40-call cap stops a model that never finishes; a transport that throws ends the session with the network message. Plants: approvals that never ask; a loop that drops the tool results.', 18000),
  errandBuilder('library', 'Library', 7, 'Your duties (library): what the library shows, through the kernel\'s U.library: the Library dialog (library.open): a card per session with its title, task, date (recordedAt), where it ran, its duration, the numbers of commands, files, screenshots and web requests, and its outcome; recorded sessions first, then live and imported ones; Open (U.library.open) and, for live and imported ones, Remove; a filter box over titles and tasks. The Share dialog (library.share): the open session\'s JSON (U.library.exportJSON) in a read-only text area with its size in KB and a Select all button, with the note that in AwwO\'s preview the page cannot copy or download, so select the text and copy it. The Import dialog (library.import): a text area for a session\'s JSON and Import, which adds it with U.library.importJSON and opens it, or shows the reason it was refused. Commands: library.open (Ctrl+O), library.share, library.import, library.next and library.previous (open the next or previous session). Tests: the page ships at least three recorded sessions, each with at least one run and one file event and an end event; the Library dialog shows a card per session; importing a session\'s exported JSON adds a second session with a new id and equal events; a malformed JSON is refused with its reason. Plants: an export that drops the events; an import that keeps a taken id.', 14000),
];

/** A session agent's task: a real job in its own sandbox computer, every action through the recorder. */
const sessionTask = (title: string, job: string) => `You are an agent doing a real task on your own computer (the sandbox) while a recorder writes down everything you do, for a replay a person will watch in Errand. Your inputs give you the recorder as a file in /inputs (rec.py).
1. Run cp /inputs/*rec.py rec.py, then python3 rec.py init "${title}" "<your task in one sentence>" (once).
2. Tell the person what you are about to do with python3 rec.py say "…" and set a plan of four to seven steps with python3 rec.py plan "…" "…"; mark each step active when you start it and done or failed when it ends: python3 rec.py step <n> active (and done or failed).
3. Do the work only through the recorder: python3 rec.py run '<command>' for every shell command (it prints what the command printed and records it; a command may run 110 s); python3 rec.py write <path> with the content on stdin (a heredoc) for every file you write; python3 rec.py fetch <url> [save-as] for every web request (your workspace has web access); python3 rec.py shot <page.html> [WxH] to look at a page you made in a real browser. Never write a file or run a command another way, and never touch /tmp/rec: the replay must be what happened.
4. Every two or three steps, say in one or two plain sentences what you found or changed, as a careful colleague would; when something goes wrong, say so and fix it.
5. Finish with python3 rec.py end done "<two sentences: what you did and what came of it>" (or stopped or failed, with why), then publish session.js into your result output: call workspace_publish with field "result" and path "session.js", and end with exactly this reply and nothing else: {"result": ""} (the host fills in the published file).
Keep it small and clear: 10 to 25 recorded actions, short outputs (cut with head or tail what you do not need), files under 6,000 characters each; the recorder cuts what is longer and keeps the session within 220,000 characters. This run ends after 25 minutes and about 60 model calls.
Your task: ${job}`;

const SESSIONS: ReadonlyArray<OfficialWorkflowNode> = [
  { id: 'site', title: 'Session: a bakery site', role: 'frontend', column: 1, row: 1, sandbox: true, output: 'Recorded session (a bakery site)',
    task: sessionTask('A bakery’s one-page site', 'Make a one-page website for Larkspur Bakehouse, an imaginary bakery by a river: a header with its name, today’s bakes as cards with prices, opening hours, an address and a contact line, in index.html with its CSS in style.css (no frameworks, no external fonts, scripts or images: draw any picture with CSS or inline SVG). Look at it in the browser at 1280x800 and at a phone’s 390x844, fix what looks wrong (overflow, contrast, spacing), and look again.'),
    acceptance: ['session.js is the recorder’s file, unedited', 'The site was looked at in the browser and fixed where it looked wrong'] },
  { id: 'climate', title: 'Session: CO2 at Mauna Loa', role: 'frontend', column: 1, row: 2, sandbox: true, output: 'Recorded session (CO2 at Mauna Loa)',
    task: sessionTask('CO2 at Mauna Loa', 'Download the monthly carbon-dioxide readings measured at Mauna Loa from https://raw.githubusercontent.com/datasets/co2-ppm/main/data/co2-mm-mlo.csv (the Open Data Commons public-domain-dedicated copy of NOAA’s record), save it as co2.csv, look at its header and first rows before you trust them, and with python3 (pandas and matplotlib are installed) find the first and the last complete year and their mean readings, the mean yearly rise in each decade and the decade that rose fastest, and the size of the seasonal swing. Chart the monthly readings with their 12-month mean as co2.png (960 × 540) and write report.md with the numbers, the chart and the source.'),
    acceptance: ['session.js is the recorder’s file, unedited', 'Every number in the report comes from a command the session shows'] },
  { id: 'quakes', title: 'Session: the year’s earthquakes', role: 'frontend', column: 1, row: 3, sandbox: true, output: 'Recorded session (the year’s earthquakes)',
    task: sessionTask('The year’s largest earthquakes', 'Find the ten largest earthquakes of 2025 worldwide in the US Geological Survey’s public catalogue (US government data, in the public domain), through its API: https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=2025-01-01&endtime=2026-01-01&minmagnitude=6.5&orderby=magnitude. Check the top three against each event’s own detail address in the catalogue, and write quakes.md: a table of the ten (date in UTC, magnitude, place, depth in km) and three plain sentences about where they cluster, with the catalogue addresses as its sources.'),
    acceptance: ['session.js is the recorder’s file, unedited', 'The table’s rows come from the catalogue as the session fetched it'] },
];

export const ERRAND: OfficialWorkflow = {
  id: 'errand-agent',
  title: 'Errand agent workspace',
  fonts: true,
  brief: 'Build Errand, an agent workspace in one web page: give an AI agent a task and watch it work on its own computer — its plan as a checklist and its messages, and beside them the computer itself: the terminal with every command and what it printed, the editor and the files it wrote, and the pages it looked at in a real browser. It ships three real sessions, recorded during this run by agents working in their own sandbox computers (a bakery’s website built and checked, a climate record analysed and charted, a public earthquake catalogue searched), replayed on a timeline you can scrub step by step, with a take-over button that hands you the computer at any moment. Connect your own model (any OpenAI-compatible address) and the agent works live on a computer inside the page, asking before it deletes, overwrites or runs code, when the page is opened on its own. Its design is written in a clean room: an agent in the sandbox computer reads an open-source agent workspace with REA (the structure only, never running it) and writes evidence, the spec is written from that evidence, and eight builders write the code from the spec alone. It tests itself in the page, with planted failures it must catch.',
  nodes: [
    { id: 'read', title: 'Read the workspace', role: 'general', column: 0, row: 0, sandbox: true, output: 'Evidence report',
      task: `You are the reading room of a clean-room rebuild, in the sandbox computer. Read how an open-source agent workspace is organised (the web app where a person gives an AI agent a task and watches it work on a computer), so that a spec can be written from your evidence without anyone reading its code. This run ends after 25 minutes and about 60 model calls: combine commands into few steps (a command may run 120 s), keep what each command prints short, and publish before the budget runs out. Clone, analyse and read within your first ten steps, then write.\n1. Fetch only its web front end through the workspace's web access: git clone --depth 1 --filter=blob:none --sparse ${ERRAND_SOURCE} /tmp/app, then git -C /tmp/app sparse-checkout set frontend/src (it is MIT licensed). If the clone fails, report that plainly and stop. Keep the clone and REA's report in /tmp, never in the workspace: the workspace is archived when you finish and may hold at most 2 MiB.\n2. Run REA on it: rea analyze-javascript-application /tmp/app/frontend/src --json > /tmp/rea.json (static: it never runs the app). If REA cannot read a kind of file, say which and go on with what it read. Read the report with short node scripts as your skills describe: the modules, what each exports and which imports which.\n3. With file listings and grep (never copying code), find: the kinds of events an agent session is made of (the actions the agent takes and what comes back), how the conversation shows them, the panels of the agent's computer (terminal, editor, browser, files and any others) and how each follows the events, how a session's state is kept and whether and how it is replayed or shared, how the person approves risky actions, and the agent's states (working, waiting, paused, finished, failed).\n4. Write the evidence report, in your own words and with no code at all: the event kinds with their fields as the app treats them, how each panel follows them, the conversation's elements (messages, plans or steps, action chips, approvals), the session's lifecycle and states, replay and sharing, and the layout (its regions and what each holds). Mark every statement [observed] when REA's report or the files show it, with where, and [inferred] when you concluded it; end with what an agent workspace in ONE offline web page needs that this app gets from its servers (a computer to run commands on, a model to call, storage), marked as such. Name the REA command lines you ran and their exit codes.\nPublish the report into the result output (Markdown, at most 18,000 characters).`,
      acceptance: ['Every statement is marked observed (with where) or inferred, and no code is copied', 'The REA command lines and their exit codes are stated'] },
    { id: 'rec', title: 'Session recorder', role: 'frontend', column: 0, row: 1, output: 'Recorder rec.py',
      task: 'Writes the recorder the session agents work through, rec.py, from its template with no model: every command, file, screenshot and web request of a session goes through it and is written down as it happened.',
      acceptance: ['rec.py, byte for byte as its template'],
      assemble: { template: REC_PY, fileOnly: true, fileName: 'rec.py' } },
    { id: 'spec', title: 'Clean-room spec', role: 'general', column: 1, row: 0, output: 'Product and module spec', sandbox: true,
      task: `Write the one spec that eight builders will implement in parallel, each writing one module of Errand and never seeing the others' code or the app the evidence describes. Work from the evidence report in your inputs (the workspace's behaviour, in your own words) and the product described in the brief; copy no code, text or design from any product, and name no other product. The kernel contract below is fixed; the spec fills in everything else the builders need.\n\n${ERRAND_KERNEL}\n\nWrite these sections in this order, as compact tables and lists, at most 20,000 characters in all. Write tersely: tables and short lines, no paragraphs, nothing the brief or the kernel contract already says. Keep your private reasoning short and put the work into the spec: the whole answer must fit one model call.\n1. Scope: what version 1 does and what it leaves out.\n2. Events on screen: for each event kind, its chip in the thread (icon, label pattern, colour), what each view shows for it, and the activity line's words.\n3. Commands: every command (id, label, group, shortcut, effect), at least 35, each owned by one module, with the ids the duties name.\n4. Regions, views and dialogs: top, thread (plan, messages, chips, approval cards, end card, the composer in each mode), the four views in their empty, replay, manual and live states, the timeline, the status bar, and the Library, Share, Import, Connect, Self-test, Shortcuts and palette dialogs.\n5. Layout and look: every region in px, the colour tokens for dark and light as hex, the eight event-kind colours, the type scale, states (hover, active, focus, disabled).\n6. The in-page computer: each built-in's options and its error messages.\n7. The live agent: the system message (at most 1,200 characters, written out), the nine tools as JSON-schema functions, the approval rule and the error messages.\n8. Module duties: for each of core, shell, vfs, thread, computer, replay, agent and library, the kernel names it implements, what it registers, what it must not touch, and its size budget.\n9. Acceptance tests: 26 to 32 numbered checks, one line each as given / when / then with exact values, each owned by one module (at least three per module); the first three, owned by replay, build a small session in the test (say, plan, step, run, file, shot and end events) and check at(ms) at three times; one owned by library checks that the page ships at least three recorded sessions, each with a run, a file and an end event.\n10. Planted failures: 9 to 11 wrong variants, one line each with its owner and the test numbers that must catch it.\n11. Unknowns: what is still open, each with the default to use.\nIn section 2, mark every statement [observed] when the evidence states it and [inferred] when you concluded it. You work in the sandbox computer, but your answer is a message, not a file: write nothing to the workspace and reply with the whole spec as your final message, at most 20,000 characters.`,
      acceptance: ['Fills every section within the fixed kernel contract, with exact numbers', 'Each acceptance test has an owner, and each planted failure names the tests that catch it'] },
    ...SESSIONS,
    ...ERRAND_BUILDERS,
    { id: 'page', title: 'Assembly', role: 'frontend', column: 3, row: 0, output: 'Assembled Errand page',
      task: 'Puts the eight modules and the three recorded sessions into one page, byte for byte and in order, with no model: core, shell, vfs, thread, computer, replay, agent, library, then the sessions, each in its own script tag (a script that fails cannot stop the others), then boots the workspace.',
      acceptance: ['A complete HTML document that boots Errand with its three recorded sessions'],
      assemble: { template: ERRAND_PAGE, fileOnly: true, fileName: 'errand.html' } },
    { id: 'test', title: 'Test and fix', role: 'frontend', column: 4, row: 0, sandbox: true, output: 'Errand', outputType: 'html', report: 'Test report',
      task: 'You are Errand\'s integration tester, working in the sandbox computer. Your inputs give you the assembled page as a file in /inputs (errand.html: the eight modules and the three recorded sessions in their own script tags, in order) and the spec as text.\n1. Copy the page into the workspace (cp /inputs/*errand.html errand.html) and run: awwo-check-page errand.html --out check --timeout-ms 100000 --budget-ms 115000 (headless Chromium with every request blocked; it runs window.awwoSelfTest(), takes a screenshot and writes check/report.json; a command may run 120 s).\n2. Read check/report.json with one short python3 script: page errors with their messages, every failing test with its detail, the planted failures caught, the blank-page flag. Never print the page itself.\n3. Publish the page as checked at once (workspace_publish with field "result" and path "errand.html"). Then write report.md and publish it (field "report", path "report.md"): the check\'s numbers (tests passed of total, planted failures caught of total, page errors, blank or not), every failing test with its detail and the module that owns it, and whether the page opens as the kernel says: the first recorded session replaying at speed 2, the library holding the three recorded sessions (from the library\'s and replay\'s tests and the screenshot).\n4. Only if a failure has an obvious cause you can find with grep -n in a few lines, fix at most five such failures with small edits to errand.html (python3 or sed), run the check once more, and if that check is better, publish the page and an updated report.md again, the fixes listed one per line (module: what was wrong, what you changed). Never edit a recorded session\'s script, weaken, delete or skip a test or a planted failure, or change a test\'s expected value.\n5. End with {"result": "", "report": ""} (the host fills in the published files). The last page and report you publish are what you deliver. This takes about 15 model calls; state only what the checks showed.',
      acceptance: ['The page delivered is the one the last check ran on', 'The report gives the check\'s numbers exactly, every failing test and every fix made'] },
    { id: 'review', title: 'Review', role: 'review', column: 5, row: 0, output: 'Review record', sandbox: true,
      task: 'Read the evidence report, the spec and the test report: check that the spec follows the evidence and marks what it inferred; list the acceptance checks the test report shows passing and failing by number, which planted failures were caught, what the fixes changed, and which parts of the spec no check covers. This is a static review: say "not actually run" for anything the reports do not show, and claim nothing beyond them; at most 350 words.',
      acceptance: ['Static review and actual execution are kept strictly apart'] },
  ],
  edges: [
    { from: 'read', to: 'spec', label: 'Evidence report' },
    ...SESSIONS.map(node => ({ from: 'rec', to: node.id, label: 'The recorder', port: 'file' as const })),
    ...ERRAND_BUILDERS.map(node => ({ from: 'spec', to: node.id, label: 'Spec' })),
    ...ERRAND_BUILDERS.map(node => ({ from: node.id, to: 'page', label: node.output })),
    ...SESSIONS.map(node => ({ from: node.id, to: 'page', label: node.output })),
    { from: 'page', to: 'test', label: 'Assembled page', port: 'file' as const },
    { from: 'spec', to: 'test', label: 'Spec' },
    { from: 'test', to: 'review', label: 'Test report', port: 'report' as const },
    { from: 'spec', to: 'review', label: 'Spec' },
    { from: 'read', to: 'review', label: 'Evidence report' },
  ],
};
