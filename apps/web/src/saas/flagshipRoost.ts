import type { OfficialWorkflow, OfficialWorkflowNode } from './examples/officialWorkflows';
import { builderFor } from './flagshipRules';

/** Roost (owner request 2026-10-16, round 2): a home for a team of AI bots in one page. Its recorded session is real
 * teamwork during the run: four bot turns, each in its own sandbox computer, every action through a recorder, each
 * handing the shared project to the next as a file; the page replays the turns as one team session. */

// The open-source multi-agent app the reading room reads (its code MIT, LICENSE-CODE): its web front end only.
const ROOST_SOURCE = 'https://github.com/microsoft/autogen';
const ROOST_FRONT_END = 'python/packages/autogen-studio/frontend/src';

const ROOST_KERNEL = `Roost kernel contract (fixed; every module uses exactly these names):
- Modules, in page order: core, shell, vfs, chat, bots, computer, skills, replay, agent; then the recorded team turns, data scripts that call U.library.add(turn) as they run, before U.boot. core alone creates window.Roost = U as the page's first script; every other module is one IIFE that starts with const U = window.Roost (there is no window.U), attaches its part to U and registers its init with U.module(name, init). A module that draws brings its own styles: one <style> element it adds to document.head, its classes prefixed with its module's name, colours only from the shell's CSS custom properties. A module fills only the elements the kernel gives it (its region, or the element a render gets) and never redraws another module's.
- U.on(type, fn) returns a function that removes the listener; U.emit(type, detail) calls each listener with detail itself.
- U.commands.register({ id, label, group, shortcut, run(args), enabled() }) (shortcut and enabled optional; the first registration of an id wins, a later one is refused with a console warning), U.commands.run(id, args) (an unknown id does nothing), U.commands.list(), U.commands.get(id). Every user action is a command; buttons, shortcuts and the command palette (Ctrl+K) run commands by id; a command that depends on the mode says so in enabled(), by U.state.mode alone.
- Commands one module registers and others run, by owner, with exactly these ids: core team.open, team.next, team.previous, view.theme, help.selftest, help.shortcuts; shell view.palette, view.terminal, view.editor, view.files, view.browser, view.follow; chat chat.channel; bots bots.profile, bots.routines, bots.run-routine; skills skills.record, skills.stop, skills.library; replay replay.toggle, replay.takeover, replay.handback, team.library, team.share, team.import; agent agent.connect, agent.send, agent.stop, agent.connectors. The spec may add commands but renames none of these.
- U.state = { mode, teamId, playhead, playing, speed, channel, tab, openFile, follow, theme, connected, clock }: mode 'replay' | 'live' | 'manual'; teamId the open team session's id or null; playhead in ms from its start; playing a boolean; speed 1, 2, 4 or 8; channel 'team' or 'dm:<bot id>'; tab 'terminal' | 'editor' | 'files' | 'browser'; openFile a path or null; follow true when the computer shows the tab of each new event; theme 'dark' | 'light'; connected true once a model is connected; clock the page's own time in ms. U.set(patch) changes it and emits one event per changed key, named after the key, then 'view' with the list of changed keys. A fresh U.state (core's, and U.tests.scratch()'s): mode 'replay', teamId null, playhead 0, playing false, speed 2, channel 'team', tab 'terminal', openFile null, follow true, theme 'dark', connected false, clock Date.now() (core moves it on once a second).
- A team turn (format 1; the recorder that made the recorded ones writes exactly this): { v: 1, id, team, bot, part, title, task, recordedAt (ISO time), where, durationMs, outcome ('done' | 'stopped' | 'failed'), summary, events }: one bot's turn of a team session, part counting from 1. events in time order, each { t (ms from the turn's start), k, ...fields }, a field the recorder had no value for being absent:
  say { text, to }: a message in the team's chat (to: the bot or person it is for, or absent for everyone). plan { steps: [text] }: the turn's plan, every step pending. step { i (counted from 1), status 'active' | 'done' | 'failed' }.
  run { cmd, out, err, code, ms, cut }: a shell command and what it printed (cut: characters the recorder left out).
  file { path, bytes, sha256, text, image, w, h, cut, removed }: a file written or changed in the shared project, path relative to the turn's workspace (text for a text file, image a data: URL, removed true when deleted).
  shot { target, w, h, image, html, error }: a page as a browser showed it (image a data: URL from a real headless browser; html the page's own text when a live bot opens it in this page; or error).
  fetch { url, status, type, bytes, excerpt, cut, error }: a web request. ask { id, title, detail, answer ('allowed' | 'denied'), by }: an action a bot asked to do, and the answer. end { outcome, summary }.
- U.library (core's): add(turn) checks the format (v 1, an id, a team, a bot, a part, events in time order, known kinds) and keeps it, or throws why; turns(team) a team's turns by part; teams() [{ id, title, bots, parts, durationMs }] in the order first added, where a team session's timeline is its turns one after another: turn n starts at the sum of the earlier turns' durationMs plus 1,000 ms each; open(team, mode) loads it into U.replay and sets mode (mode 'replay' unless given), teamId, playhead 0 and playing false; current() the open team session or null; exportJSON(team) its turns' JSON text; importJSON(text) adds those turns (a taken id gets a new one) and returns the team id. The turns held at 'ready' are the recorded ones.
- U.vfs (the vfs module's), the shared computer: one file tree, home /home/roost (where a shell starts); paths absolute or relative to a cwd, with '.' and '..'. read(path) the text or null; write(path, text) makes missing parents and returns the bytes written; list(dir) [{ name, dir, bytes }] sorted by name; mkdir(path); remove(path, { recursive }); move(from, to); exists(path); stat(path) { dir, bytes } or null; snapshot() a deep copy and restore(snapshot); reset() an empty home. exec(line, { cwd }) returns { out, err, code, cwd }: built-ins pwd cd ls cat echo mkdir rm mv cp touch head tail wc grep sort uniq find tree clear true false js (js <file> runs the file's JavaScript in a function with a console whose lines become out; an uncaught error becomes err with code 1); words split on spaces with single and double quotes; |, > and >>, &&, || and ; work; an unknown command prints '<name>: command not found' to err with code 127; a failing built-in gives code 1 and a message. After each exec it emits 'vfs' with { kind: 'exec', line, code }, and after each write() called from outside exec { kind: 'write', path, text } (a redirection is part of its exec).
- U.bots (the bots module's): register({ id, name, role, color, soul, skills, routines }) (the first registration of an id wins), list(), get(id), update(id, patch); status(id) 'idle' | 'working' | 'waiting' (working while its turn plays or its live loop runs, waiting while it waits for an approval); avatar(id, size) an inline SVG of its initial on its colour; snapshot() a deep copy of what it holds and restore(snapshot). The recorded team's bots, registered in the bots module's init: wren (Wren, scout: finds and checks facts), bram (Bram, builder: makes pages and files), ivy (Ivy, editor: reviews and asks for changes); a turn's bot is its bot name lowercased.
- U.routines (the bots module's): add({ bot, task, every: 'hour' | 'day' | 'weekday' | 'week', at: 'HH:MM', day }) returns its id (day 0-6 for 'week'); list(); remove(id); next(id, from) the ms of its next run after from, in the page's local time; due(now) the routines whose next run after their last run is at or before now; ran(id, at) records a run in its history; snapshot() and restore(snapshot). In mode 'live' with a model, U.agent runs a routine's task as its bot when it falls due.
- U.skills (the skills module's): record() starts recording the person's commands and file writes on U.vfs in mode 'manual'; stop(name, description) saves and returns { id, name, description, steps: [{ kind: 'exec', line } or { kind: 'write', path, text }], params } (params: the {{name}} placeholders in its steps); list(); get(id); remove(id); run(id, params) replays its steps on U.vfs with the placeholders filled and returns [{ out, err, code }]; snapshot() and restore(snapshot). In live mode each skill is a tool the bots can call.
- U.replay (the replay module's): load(team) indexes it; append(event, bot) adds one event to the loaded live team session: to that bot's newest turn, or to a new turn (the next part, with the bot's name) when another bot or the person spoke since; it moves the playhead to it and emits 'replay' with at(playhead) (the live agent grows its session this way). at(ms) returns { messages: [{ from (a bot id or 'person'), to, text, t }], turns: [{ bot, part, title, start, end, outcome }], active (the bot whose turn plays at ms, or null), plan: [{ text, status }] (the active turn's), terminal: [{ bot, cmd, out, err, code, t }], files: [{ path, bytes, text, image, t }], browser, fetches: [{ bot, url, status, excerpt, t }], asks: [{ bot, id, title, detail, answer, t }], events, last } from the events at or before ms: events lists them in time order, each with its own fields and its bot, part and t (ms from the team session's start); the first turn's task is the person's first message at t 0; files keep each path's latest state, removed ones left out, sorted by path; browser is the latest shot ({ image or html, target, w, h, t }), or, when an .html file was written after it, { html, target: path, t }, or null; last is the last event at or before ms. It is a pure function of the team session and ms. seek(ms) clamps to 0..the team's durationMs, sets the playhead and emits 'replay' with at(ms); play() and pause() set playing; while playing, the playhead moves by elapsed real time × speed, a gap of more than 2 s between two events is crossed in 1 s, and play stops at the end; step(1) and step(-1) seek to the next or the previous event; takeOver() loads the text files at the playhead into U.vfs (U.vfs.reset(), then one write per file, under /home/roost) and sets mode 'manual' and playing false.
- U.agent (the agent module's): connect({ baseUrl, apiKey, model }) keeps them in memory only and sets connected. send(text, channel) posts the person's message in the channel of a live team session (it starts one, mode 'live', the first time) and runs the bots it names with @Name, or, with none named, the one bot a single model call picks from the bots' roles; each bot runs a loop of at most 20 model calls through U.agent.transport(request), which resolves to { status, json } (default: fetch POST <baseUrl>/chat/completions with the key as a Bearer token, OpenAI format, tools as JSON-schema functions; tests replace it, so they need no network), with the tools shell { command }, write_file { path, content }, read_file { path }, list_files { path }, open_page { path }, say { text, to }, finish { summary } and every skill; a bot's say to another bot runs that bot next, at most 6 bot turns a message. Every event goes into the session with U.replay.append(event, bot). Before a call that removes or overwrites a file or runs js, the bot waits for the person: pending() returns the approval waiting ({ id, bot, title, detail }) or null, it emits 'ask' with that approval when it asks and 'ask' with null once answered, and answer(id, 'allowed' | 'denied') settles it (an ask event records the answer). stop() ends the running bots. When the transport throws (AwwO's preview blocks the network), it says in the chat that this copy of the page cannot reach the network and works when the page is opened on its own, and stops. U.connectors (the agent module's): list() [{ id, name, detail, status }] for 'webhook' (POST a bot's message as JSON to an address the person gives) and 'feed' (read an RSS or Atom address for a bot), each 'blocked in this preview' while the page cannot reach the network.
- U.views (the computer module's, made as its script runs, before any init): register({ id, title, icon, order, render(element, view) }) (the first registration of an id wins), list() sorted by order, get(id); the computer module registers 'terminal', 'editor', 'files' and 'browser'. view: in mode 'replay' U.replay.at(playhead); in 'manual' and 'live' { live: true, vfs: U.vfs, ...U.replay.at(playhead) }. A view whose render throws shows the error in its place and reports it with console.error.
- U.ui (the shell's): region(name) returns the layout's elements 'top', 'sidebar', 'chat', 'computer', 'tabs', 'timeline', 'status'; show(tab) sets U.state.tab and draws that view into region 'computer'; toast(text); dialog({ title, body, actions }) returns a close function; icon(name) an inline SVG string (24 × 24, 1.5 px strokes, currentColor). The bots module renders into region 'sidebar', the chat module into 'chat', the replay module into 'timeline'; the shell draws the tabs and the shown view.
- U.tests.add(name, fn) (fn returns or resolves to true, or throws why), U.tests.plant(name, swap) (swap() installs a wrong variant and returns the function that restores it), U.tests.run() resolves to { tests: [{ name, ok, detail }], planted: [{ name, rejected, detail }] }; core sets window.awwoSelfTest = () => U.tests.run(). Every test and plant name starts with its module and a colon ('vfs: …'), and a test takes at most about half a second, never waiting for timers or frames (it calls functions directly: U.replay.at and seek, never play). U.tests.run() runs every test once, timing each; under each plant it replays the tests that passed, fastest first, and stops at the first that fails, which rejects the plant; every plant is restored even when a test throws. It saves U.state, the library's turns, U.vfs, the bots, the routines and the skills (each registry's snapshot()) before, runs each test from U.tests.scratch() (a fresh U.state, U.vfs.reset(), and the library, bots, routines and skills put back to what they held when U.tests.run() began), and restores everything after, so a self-test leaves the page as it was.
- U.module(name, init); U.boot(root) runs the inits in page order (one that throws is reported with a toast and the others still run), emits 'ready', then opens the first team session in the library and plays it at speed 2, so the first view moves; with no team session it shows the live view, empty.`;

const ROOST_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Roost — a team of bots on one computer</title>
<style>html,body{margin:0;height:100%;overflow:hidden;background:#0f1115;color:#e8eaf0;font:13px Inter,system-ui,sans-serif}#roost{position:fixed;inset:0}</style>
</head>
<body>
<div id="roost"></div>
<script>{{in:from_core}}</script>
<script>{{in:from_shell}}</script>
<script>{{in:from_vfs}}</script>
<script>{{in:from_chat}}</script>
<script>{{in:from_bots}}</script>
<script>{{in:from_computer}}</script>
<script>{{in:from_skills}}</script>
<script>{{in:from_replay}}</script>
<script>{{in:from_agent}}</script>
<script>{{in:from_wren}}</script>
<script>{{in:from_bram}}</script>
<script>{{in:from_ivy}}</script>
<script>{{in:from_bram2}}</script>
<script>window.Roost ? window.Roost.boot(document.getElementById('roost')) : document.body.append('Roost did not load.');</script>
</body>
</html>`;

// The recorder every bot turn works through: its file arrives byte for byte, so no model retypes it.
const REC_PY = String.raw`#!/usr/bin/env python3
"""Roost's session recorder. Every action of a bot goes through it: it does the action, prints what came back, and
writes the action down as it happened, for a replay in Roost. Its state lives in /tmp/rec, never in the workspace.
  python3 rec.py init "<title>" "<task>" --team <id> --bot <name> --part <n>   start this bot's turn (once, first)
  python3 rec.py say [--to <name>] "<text>"      a message in the team's chat (--to: the bot or person it is for)
  python3 rec.py plan "<step>" "<step>" ...      the plan; every step starts pending
  python3 rec.py step <n> active|done|failed     a plan step's status (n counts from 1)
  python3 rec.py unpack                          unpack the project the turn before handed on (/inputs/*project.tgz)
  python3 rec.py run '<shell command>'           run it in the workspace with bash; record what it printed
  python3 rec.py write <path> < content          write stdin to a file in the workspace and record it
  python3 rec.py shot <page.html> [WxH]          screenshot a page of the workspace in headless Chromium
  python3 rec.py fetch <url> [save-as]           GET a web address with curl, record what came back, keep the body
  python3 rec.py end done|stopped|failed "<summary>"   close the turn and write part.js into the workspace
Commands may run 110 s; a session holds at most 220,000 characters (screenshots and files count), and the recorder
cuts long output and files to keep within it, saying how much it cut."""
import base64
import glob
import hashlib
import io
import json
import os
import re
import shlex
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
SKIP_FILES = {"rec.py", "part.js", "project.tgz"}
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
    t = int((time.monotonic() - s["mono"]) * 1000)
    if s["events"] and t < s["events"][-1]["t"]:
        t = s["events"][-1]["t"]
    event = {"t": t, "k": k, **fields}
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


def run_cmd(s, cmd):
    """Run a shell command in the workspace, print what it printed and record it as a run event."""
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
    return code, ms


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
        flags = {}
        rest = []
        i = 0
        while i < len(args):
            if args[i] in ("--team", "--bot", "--part") and i + 1 < len(args):
                flags[args[i][2:]] = args[i + 1]
                i += 2
            else:
                rest.append(args[i])
                i += 1
        if not all(flags.get(k) for k in ("team", "bot", "part")):
            print("[rec] init needs --team <id> --bot <name> --part <n>")
            return 2
        title, task = (rest + ["", ""])[:2]
        save({"v": 1, "title": title.strip(), "task": task.strip(), "recordedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
              "team": flags["team"].strip(), "bot": flags["bot"].strip(), "part": int(flags["part"]),
              "mono": time.monotonic(), "events": [], "seen": {}})
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
        if len(args) >= 2 and args[0] == "--to":
            add(s, "say", text=" ".join(args[2:]).strip(), to=args[1].strip())
        else:
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
        code, ms = run_cmd(s, cmd)
        changes(load())
        print(f"\n[rec] exit {code} in {ms} ms")
        return 0
    elif verb == "unpack":
        # The project as the turn before handed it on. The team session already holds its files from the turns that
        # wrote them, so this records the command and takes the files as they are: only this turn's own changes
        # become file events.
        found = sorted(glob.glob("/inputs/*project.tgz"))
        if not found:
            print("[rec] there is no project.tgz in /inputs")
            return 1
        code, ms = run_cmd(s, f"tar xzf {shlex.quote(found[0])} && ls -R project")
        s = load()
        s["seen"] = {rel: [b, m] for rel, (b, m) in walk().items()}
        save(s)
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
        p = subprocess.run(["curl", "-sS", "-L", "--max-time", "60", "-A", "Roost recorder (an AwwO sandbox computer)",
                            "-o", body, "-w", "%{http_code} %{content_type}", url], capture_output=True)
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
        part = {"v": 1, "id": hashlib.sha256((s["team"] + s["bot"] + str(s["part"]) + s["recordedAt"]).encode()).hexdigest()[:12],
                "team": s["team"], "bot": s["bot"], "part": s["part"],
                "title": s["title"], "task": s["task"], "recordedAt": s["recordedAt"],
                "where": "an AwwO sandbox computer", "durationMs": events[-1]["t"] if events else 0,
                "outcome": outcome, "summary": summary, "events": events}
        text = json.dumps(part, ensure_ascii=False, separators=(",", ":"))
        text = text.replace("</", "<\\/").replace("<!--", "<\\!--").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
        with open(os.path.join(WS, "part.js"), "w", encoding="utf-8") as f:
            f.write("window.Roost&&window.Roost.library.add(" + text + ");\n")
        print(f"[rec] turn closed: {len(events)} events, {len(text):,} characters in part.js")
    else:
        print(__doc__)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
`;

const roostBuilder = builderFor({ app: 'Roost', global: 'Roost', noun: 'app', kernel: ROOST_KERNEL, column: 2, others: 'eight', modules: 'core, shell, vfs, chat, bots, computer, skills, replay, agent' });

const ROOST_BUILDERS: ReadonlyArray<OfficialWorkflowNode> = [
  roostBuilder('core', 'Kernel', 0, 'Your duties (core): window.Roost and every kernel name the other modules do not own — the event bus; the command registry; one keydown listener on window that runs the command whose shortcut matches, never while focus is in an input, a textarea or a contenteditable element, Escape and Ctrl+K excepted; U.state and U.set, moving U.state.clock on once a second (setInterval, never in a test); U.module and U.boot; U.library exactly as the kernel says, each refusal of add naming its reason, teams() and the timeline rule (turn n starts after the earlier turns plus 1,000 ms each); current() returns the open team session\'s entry as teams() gives it ({ id, title, bots, parts, durationMs }), never its turns, and open(team, mode) passes the team id to U.replay.load; U.tests with its save, scratch and restore of everything the kernel lists. Commands: team.open (args { id }), team.next and team.previous (through teams(), wrapping), view.theme (dark and light), help.selftest (runs U.tests.run() and shows in a dialog the tests passed of total, the plants caught of total, then each failure with its detail), help.shortcuts (a dialog of every command that has a shortcut). Tests (each under 0.1 s, in a fresh state): U.set emits one event per changed key and then view; a second registration of a command id is refused and the first still runs; U.library.add refuses events out of time order and a turn with no bot, each with its reason; two turns of one team give teams() one entry whose durationMs is their sum plus 2,000; exportJSON then importJSON gives equal turns under new ids; a test that adds a turn leaves teams() as it was after U.tests.scratch(); after open(id), current() is that team\'s teams() entry. Plants: a U.set that emits nothing for a changed key; a timeline that leaves out the 1,000 ms between turns.', 13000),
  roostBuilder('shell', 'Interface', 1, 'Your duties (shell): the frame and the whole look, created at your init (you boot second, right after core) as the spec\'s layout gives it, and U.ui exactly as the kernel says. Regions: top (the Roost mark and name, the open team session\'s title with where and when it was recorded under it ("Recorded 19 Oct 2026 in AwwO sandbox computers", the date from its first turn\'s recordedAt), the mode badge Replay, Live or Manual, and buttons that run team.library, team.share, replay.takeover, agent.connect and view.theme), sidebar on the left (240 px), chat in the middle (at least 360 px), computer on the right with tabs above it (one tab per view in U.views.list(), the computer module\'s registry, in order, the active one marked and the mark moved whenever U.state.tab changes, drawn on \'ready\' because the views register in that module\'s init, after yours; a click shows it) and the timeline under it, and status at the bottom (the playhead of the duration, the active bot, the commands run, the files, and a self-test badge that runs help.selftest); the lines between the columns drag to resize; below 1100 px wide the sidebar folds to its avatars, below 800 px the computer moves under the chat. Each region is an element inside a column element of yours that holds the column\'s size, so nothing a module does to its region or puts in it (a class, a style, a long line) changes the layout: the columns have min-width 0 and hide what overflows. On \'ready\', when U.state.tab or mode changes and on every \'replay\' event (at most once per animation frame) draw the shown view into region \'computer\' with the view the kernel describes; above the tabs an activity line says what the latest event is, with its bot ("Wren is reading api.weather.gov", "Bram is writing project/bulletin.html", "Ivy is looking at bulletin.html", "Bram is waiting for your approval", "Done"). U.ui.dialog draws a modal panel with its title, body element or text and action buttons, Escape and a click outside close it; U.ui.toast shows a line for 3 s; U.ui.icon returns inline SVG for at least: play, pause, back, forward, terminal, editor, files, browser, library, share, takeover, model, theme, check, cross, spinner, warning, search, routine, skill, plug, send. The command palette: Ctrl+K opens a dialog with a filter box over every command\'s label and group (the typed letters in order), listing labels that start with the typed text first, then labels with a word that starts with it, then the other matches, each group in registration order; arrow keys move, Enter runs. Look: the spec\'s colour tokens for dark and light as CSS custom properties on the root, Inter for the interface, JetBrains Mono for the computer, 8 px spacing, 6 px radii, quiet borders, each bot\'s colour on its avatar, messages and timeline lane. Commands: view.palette (Ctrl+K), view.terminal, view.editor, view.files, view.browser (Alt+1 to Alt+4), view.follow (toggles follow). Tests: after init every region the kernel names exists; show(\'browser\') sets U.state.tab and draws that view; a view whose render throws shows the error in its place and calls console.error; the palette filter for \'take\' lists replay.takeover first. Plants: a region() that returns the chat for \'sidebar\'; a palette that filters by the first letter only.', 20000),
  roostBuilder('vfs', 'Shared computer', 2, 'Your duties (vfs): U.vfs exactly as the kernel lists it — the tree as nested maps, text files only, write() making every missing parent directory first (as mkdir -p does: take over writes project/notes.md into an empty home), bytes counted as UTF-8, a path resolver for absolute and relative paths with . and .. (above / stays at /), and exec: a line parser (single quotes keep everything, double quotes keep spaces, a backslash escapes the next character), then pipelines split on ; && || with their exit-code rules, each pipeline on |, each command\'s > or >> redirection to a file (relative to the cwd), stdin passed down the pipe. Built-ins, with the usual options the spec lists: pwd; cd (no argument goes home); ls (-l with sizes, -a, -1; a directory lists its entries, sorted); cat (files and stdin); echo (-n); mkdir (-p); rm (-r, -f); mv; cp (-r); touch; head and tail (-n N, default 10); wc (-l -w -c); grep (-i -n -v -c, a regular expression, files or stdin); sort (-r -n -u); uniq (-c); find (a directory, -name with * and ?); tree; clear (out is the form feed \\f, which the terminal reads as clear); true; false; js (js <file> [args]: runs the file\'s JavaScript as the body of a function given console and args, console.log lines join out, console.error lines err; a thrown error is err "<name>: <message>" with code 1). Errors read like a shell\'s: "cat: notes.txt: No such file or directory" with code 1. Tests: write then read gives the text and stat its UTF-8 bytes (a 3-byte character counted as 3); write(\'/home/roost/a/b/c.txt\') into a home with no a/ makes a/b and the file; mkdir -p a/b/c then ls a/b lists c; echo hi > x.txt; echo there >> x.txt; cat x.txt prints two lines; grep -c th x.txt prints 1; echo \'b a\' | wc -w prints 2 and cat x.txt | sort -r prints there before hi; cd .. above / stays at /; an unknown command gives code 127 and the message; false && echo no prints nothing and true || echo no prints nothing; js runs a file that logs 2 + 2 and out is 4. Plants: >> that overwrites instead of appending; cd .. that does not move up; an unknown command that returns code 0.', 16000),
  roostBuilder('chat', 'Chat', 3, 'Your duties (chat): the team\'s conversation in region \'chat\', drawn inside an element of your own that you put in the region (never change the region element\'s own class, style or attributes: they are the shell\'s), from the view the kernel describes: a header with the channel (#team, or a direct channel with one bot: its avatar and name) and the active bot\'s status; then the messages in time order, each with its sender\'s avatar, name and colour (the person as You), its time (m:ss into the session) and, when it is for someone, "to Bram"; @Name in a text drawn as a mention chip in that bot\'s colour; between the messages one compact chip per run, file, shot and fetch event of the view\'s events, with its bot\'s initial ("Wren fetched api.weather.gov · 200", "Bram wrote project/bulletin.html · 2.4 KB", "Ivy looked at bulletin.html at 390 × 844", "Bram ran python3 check.py · exit 0"), a failed command\'s chip marked; a hand-over line where one bot\'s turn ends and another bot\'s begins, both with events ("Wren handed the project to Bram · 3 files"; never to or from the person); approval cards for ask events (the bot, title, detail, the answer and who gave it), and in mode \'live\' a card for U.agent.pending() with Allow and Deny buttons that call U.agent.answer(id, \'allowed\') or (id, \'denied\'), drawn when \'ask\' is emitted and removed when it is emitted with null; the end card of each turn with its outcome and summary. In a direct channel only the messages to or from that bot show. A click on a chip seeks the replay to that event\'s time, shows its tab and, for a file, opens it in the editor (U.set({ openFile })). Only what changed is redrawn when the playhead moves, and the list stays at the newest item unless the person has scrolled up (then a "Jump to latest" button shows). The composer at the bottom: in mode \'replay\' a line "A recorded team session, replayed. Take over to use its computer." with a Take over button (replay.takeover); in \'manual\' a line "You have the shared computer. Type in the terminal or edit files." with a Hand back button (replay.handback); in \'live\' a message box (Enter sends with agent.send in the channel, Shift+Enter a new line; typing @ offers the bots\' names), with Stop (agent.stop), and when no model is connected a Connect model button (agent.connect). Commands: chat.channel (args { channel }), chat.next-channel, chat.previous-channel. Tests: a view with three messages from two bots shows them in time order with their names; @Ivy in a text becomes a mention chip; a run chip for code 2 is marked failed; a click on a file chip seeks to its time and sets openFile; in a direct channel with wren only Wren\'s messages show; in mode replay the composer offers Take over. Plants: chips drawn in reverse time order; a direct channel that shows every message.', 18000),
  roostBuilder('bots', 'Bots and routines', 4, 'Your duties (bots): U.bots and U.routines exactly as the kernel says, and region \'sidebar\': the channels (#team, then a direct channel per bot) with an unread dot when a message arrives in a channel not shown; the team roster, each bot with its avatar, name, role and status (idle, working with a pulse, waiting); a click on a bot opens its profile dialog: name, role, colour, its instructions (soul) as text, its skills (from U.skills.list(), ticks to give one to the bot), its routines with their next run ("Every weekday at 07:00 · next Mon 20 Oct, 07:00") and their history, and in mode \'live\' edits saved with U.bots.update; a Routines panel listing every routine with its bot, task, schedule, next run and last run, with Add routine (bot, task, every, at) and Run now (in live mode it runs the task through U.agent.send as that bot\'s message; otherwise it says a model is needed). In your init register the recorded team\'s three bots (wren, bram, ivy) with the roles the kernel gives, the colours the spec gives and short souls in your own words, and one routine of the recorded team, Wren\'s "Gather the garden\'s weather and tasks for the bulletin", every week on Monday at 07:00 (day 1), whose history holds the recorded session\'s first turn. next() works in the page\'s local time and skips to the next matching day; due(now) compares with the last run or the routine\'s creation. Commands: bots.profile (args { id }), bots.routines, bots.add-routine, bots.run-routine (args { id }). Tests: register refuses a second wren; next() of a weekday routine at 07:00 from a Friday 08:00 lands on Monday 07:00; a weekly routine on day 1 from a Monday 06:59 lands on that day 07:00; due() lists a routine whose next run has passed and not one whose next run is ahead; status is working for the bot whose turn plays at the playhead. Plants: next() that ignores the day for a weekly routine; a roster that shows every bot as idle.', 16000),
  roostBuilder('computer', 'Computer', 5, 'Your duties (computer): You create U.views as your script runs, before any init: register(view) (the first registration of an id wins, a later one is refused with a console warning), list() sorted by order, get(id); then the four views, registered in your init with U.views.register in this order — terminal, editor, files, browser. Never draw the tab strip or register a view.* command: the shell does both; you only fill the element render is given. Terminal: the commands so far as a scrollback, each a prompt line (the bot\'s initial in its colour, the cwd, then the command) and its output in JetBrains Mono, err in the error colour, a chip with the exit code when it is not 0, and "… N characters left out" where the recorder cut; in mode \'manual\' or \'live\' an input line at the bottom that runs U.vfs.exec and appends the result (Up and Down walk its history; a form feed in out clears the scrollback). Editor: a two-column grid, the file tree on the left (220 px; folders and files as indented rows, folders open and close, the open file marked) and on the right the open file (U.state.openFile, else the latest file written: a header with its path, size and the bot that last wrote it, then rows of line number and code side by side, scrolling together) with light colouring for html, css, js, json, py, md and csv (keywords, strings, comments, numbers, tags); a picture shows as an image with its size; a file the recorder cut ends with the cut note; in mode \'manual\' the file is editable and Ctrl+S writes it to U.vfs with a toast. Files: a table with a header row and zebra rows of every file with its path, size (right-aligned), kind, the bot that last wrote it and the time it last changed (m:ss into the session); a click opens it in the editor. Browser: an address line with the target, then the latest screenshot as an image at its size (scaled down to fit) with "Rendered by headless Chromium in the bot\'s sandbox computer"; for an html file written after the last shot, a static render of it into a shadow root (no script runs), each stylesheet it links by a relative path inlined from the view\'s files, with a note that scripts do not run here; under it "Pages the bots read": each fetch with its bot, url, status and excerpt. When U.state.follow is on and the view\'s last event changes, show the tab of its kind (run: terminal; file: editor with that file; shot and fetch: browser). Tests: the terminal draws a command with its bot\'s initial, its output and a chip for exit code 1; the editor shows line numbers for a three-line file; the files table lists two files sorted by path with their bots; the browser shows the shot\'s image for a view whose browser is a shot; follow switches to the editor on a file event. Plants: a terminal that drops err; an editor that numbers lines from 0.', 22000),
  roostBuilder('skills', 'Skills', 6, 'Your duties (skills): U.skills exactly as the kernel says, and the skill flow a person uses: in mode \'manual\' a Teach a skill command (skills.record) starts recording, shown by a pill of your own appended to document.body at the top centre (a red dot, "Recording a skill: every command you run and every file you save is a step", and Stop), and skills.stop opens a dialog for its name and description and saves it; while recording, U.skills.record() takes its steps from the kernel\'s \'vfs\' events (each exec as an exec step, each write as a write step), so it needs nothing from the other modules; U.skills.recording() is true while it records; a Skills dialog (skills.library) lists each skill with its name, description, steps and parameters, Run (fills the parameters in a small form, runs them on U.vfs in mode \'manual\' and shows each step\'s output), Remove, and the bots that have it. A {{name}} written in a step is a parameter. Commands: skills.record, skills.stop, skills.library, skills.run (args { id, params }). Tests: a recorded skill with an exec step and a write step saves both in order; a step with {{city}} gives the parameter city; run() fills {{city}} with Portland and the written file holds Portland; remove() takes it out of list(); recording() is false after stop. Plants: run() that leaves the placeholders unfilled; a stop() that drops the write steps.', 14000),
  roostBuilder('replay', 'Replay', 7, 'Your duties (replay): U.replay exactly as the kernel says (one team session = its turns in part order, each event at its turn\'s start plus its t): load(team) takes a team id (its turns from U.library.turns), the turns themselves as an array, or an object with a turns array, and anything else loads an empty team session, whose at() returns empty lists and never throws; every bot in what at() returns (messages\' from, turns, active, terminal, fetches, asks, events) is a bot id, the turn\'s bot lowercased (Wren is wren); active is null between turns and after the last turn; append(event, bot) stamps event.t (ms since that turn began, by the page\'s clock) when the event has none; and the timeline in region \'timeline\': play and pause, step back and forward, the speed (1×, 2×, 4×, 8×), the time at the playhead and the duration (m:ss), and a track with one lane per bot (its avatar at the left, its colour), each event a tick on its bot\'s lane in its kind\'s colour, each turn a band on its lane from its start to its end, the played part shaded; a click or a drag on the track seeks; hovering a tick names its event and bot. The play loop runs on requestAnimationFrame and calls seek when the playhead crosses an event or 250 ms have passed, so the views redraw at most four times a second between events. Commands: replay.toggle (Space), replay.play, replay.pause, replay.step-forward (Right), replay.step-back (Left), replay.forward-10 (Shift+Right), replay.back-10 (Shift+Left), replay.speed (cycles 1, 2, 4, 8), replay.restart (Home), replay.end (End), replay.next-turn (N), replay.takeover (T), replay.handback (back to mode \'replay\' at the playhead, the shared computer kept); replay.takeover is enabled in mode \'replay\' and replay.handback in mode \'manual\', by the mode alone, with or without an open team session. You also own the team sessions\' dialogs: Library (team.library: each team session from U.library.teams() with its title, bots, turns, date and duration, recorded ones first; Open, and Remove for live and imported ones), Share (team.share: the open team session\'s JSON from U.library.exportJSON in a read-only text area with its size in KB and Select all, with the note that in AwwO\'s preview the page cannot copy or download, so select the text and copy it) and Import (team.import: a text area for a team session\'s JSON, which U.library.importJSON adds and opens, or the reason it was refused). Tests (the first three of the spec\'s acceptance tests are yours; each builds two small turns of one team in the test, with say, plan, step, run, file, shot and end events, and loads them): at(0) holds only the first turn\'s task; at a time inside the second turn active is its bot and files holds the first turn\'s file; at the end turns lists both with their outcomes and browser is the last shot; seek(-5) clamps to 0 and seek past the end to the team\'s durationMs; step(1) from 0 lands on the first event\'s time; at() called twice for one ms gives equal results; takeOver() at the end makes U.vfs.read(\'/home/roost/\' + a file\'s path) its text and sets mode manual; at() of a turn whose bot is Wren names it wren; load(42) gives an empty view; an event appended with no t gets one and is in at(1e12).events. Plants: an at() that leaves out the event exactly at ms; a timeline that starts the second turn at 0.', 18000),
  roostBuilder('agent', 'Live team', 8, 'Your duties (agent): U.agent and U.connectors exactly as the kernel says, and the Connect dialog (agent.connect): base URL (e.g. https://api.example.com/v1), API key (a password field), model, with the note "Kept in this page only and sent only to this address."; Connect saves them with U.agent.connect. Your module is the one exception to the rule below about the network: it alone calls fetch, only to the person\'s base URL or a connector\'s address the person gave, and only after they connect; everything else stays offline. send(text, channel) adds the live team session if there is none (its turns\' team id "live-" plus the time, recordedAt now, where "this page"; each bot\'s work goes in as the events of its own turn) and opens it with U.library.open(id, \'live\'); each bot\'s loop: the system message (the spec\'s, at most 1,000 characters: who the bot is from its soul and role, the team and the shared computer, plan first, say what you do, say --to another bot only to hand work on, finish with a summary), the chat so far and the tools as JSON-schema functions; each tool call runs on U.vfs and its result goes back as a tool message; a skill tool runs U.skills.run. Approvals as the kernel says, for a shell command that runs rm, mv onto an existing file or js, and a write_file onto an existing file; the card for js says it runs in this page, with access to what the page holds, the key included. Errors: an HTTP status other than 200 says the status and the body\'s first 300 characters in the chat and stops that bot with outcome failed; malformed tool arguments go back to the model as a tool error; a thrown transport says the kernel\'s network message once and stops; a bot that reaches 20 model calls stops with outcome stopped. Routines: once a minute in mode \'live\' with a model, run each U.routines.due(U.state.clock) task as its bot and record it with U.routines.ran. The Connectors dialog (agent.connectors): each connector with its status and a form for its address; Test sends one request. Commands: agent.connect, agent.send (args { text, channel }), agent.stop, agent.new (a fresh live team session), agent.connectors. Tests (each with a scripted transport that answers from a list, no network): a message "@Bram make a page" runs Bram only, and a model that calls write_file then finish records file and end events as Bram\'s; Bram\'s say to Ivy runs Ivy next; a write_file onto an existing file waits for an answer and a denied answer leaves the file as it was; the 20-call cap stops a bot that never finishes; a transport that throws ends with the network message. Plants: approvals that never ask; a router that runs every bot for a message that names one.', 18000),
];

/** A bot turn's task: one bot's real work on the team's shared project in its own sandbox computer, every action
 * through the recorder; the project arrives from the turn before as a file and leaves for the turn after as one. */
const turnTask = (bot: string, part: number, title: string, job: string, next: string | null) => `You are ${bot}, one bot of Roost's team (Wren finds and checks facts, Bram makes pages and files, Ivy reviews and asks for changes), taking turn ${part} of a real team session on your own computer (the sandbox). A recorder writes down everything you do, for a replay a person will watch in Roost. Your inputs give you the recorder as a file in /inputs (rec.py)${part > 1 ? ', and the team\'s project as the turn before you left it, as a file in /inputs (project.tgz)' : ''}.
1. Run cp /inputs/*rec.py rec.py, then python3 rec.py init "${title}" "<your task in one sentence>" --team garden-bulletin --bot ${bot} --part ${part} (once).${part > 1 ? ' Then unpack the project through the recorder: python3 rec.py unpack (it unpacks /inputs/*project.tgz and lists project/; the team session already holds those files from the turns that wrote them).' : ' Then make the project folder through the recorder: python3 rec.py run \'mkdir -p project\'.'}
2. Tell the team what you are about to do with python3 rec.py say "…" (add --to <name> when it is for one bot) and set a plan of three to six steps with python3 rec.py plan "…" "…"; mark each step active when you start it and done or failed when it ends: python3 rec.py step <n> active (and done or failed).
3. Do the work only through the recorder: python3 rec.py run '<command>' for every shell command (it prints what the command printed and records it; a command may run 110 s); python3 rec.py write <path> with the content on stdin (a heredoc) for every file you write; python3 rec.py fetch <url> [save-as] for every web request (your workspace has web access); python3 rec.py shot <page.html> [WxH] to look at a page in a real browser. Keep every file of the work in project/. Never write a file or run a command another way, and never touch /tmp/rec: the replay must be what happened.
4. Every two or three steps, say in one or two plain sentences what you found or changed, as a careful colleague would; when something goes wrong, say so and fix it.
5. ${next ? `Hand the project on: python3 rec.py say --to ${next} "<what you leave for ${next}, in one or two sentences>", then pack it: python3 rec.py run 'tar czf project.tgz project'.` : 'Pack the finished project: python3 rec.py run \'tar czf project.tgz project\'.'} Finish with python3 rec.py end done "<two sentences: what you did and what came of it>" (or stopped or failed, with why). Then publish both files: call workspace_publish with field "result" and path "part.js", and with field "file" and path "project.tgz"; end with exactly this reply and nothing else: {"result": "", "file": ""} (the host fills in the published files).
Keep it small and clear: 10 to 25 recorded actions, short outputs (cut with head or tail what you do not need), files under 6,000 characters each; the recorder cuts what is longer and keeps the turn within 220,000 characters. This run ends after 25 minutes and about 60 model calls.
Your task: ${job}`;

const TURNS: ReadonlyArray<OfficialWorkflowNode> = [
  { id: 'wren', title: 'Turn 1: Wren gathers the facts', role: 'general', column: 1, row: 1, sandbox: true, output: 'Turn 1 (Wren)', handoff: 'The project after turn 1',
    task: turnTask('Wren', 1, 'Wren gathers the facts', 'The Riverside Community Garden in Portland, Oregon wants this week’s bulletin for its notice board and its site. Gather the facts for it into project/notes.md, each with its source: the coming week’s forecast for the garden from the US National Weather Service’s public API (https://api.weather.gov/points/45.5152,-122.6784, then the forecast address it gives; US government data, in the public domain), day by day with highs, lows and rain; what to sow, plant and harvest in the Pacific Northwest in late October, in your own words; and the two volunteer slots, Saturday 10:00 to 12:00 and Wednesday 16:00 to 18:00. Flag any day when frost or heavy rain should change the garden’s plans.', 'Bram'),
    acceptance: ['part.js is the recorder’s file, unedited', 'Every fact in notes.md names its source'] },
  { id: 'bram', title: 'Turn 2: Bram builds the bulletin', role: 'frontend', column: 2, row: 9, sandbox: true, output: 'Turn 2 (Bram)', handoff: 'The project after turn 2',
    task: turnTask('Bram', 2, 'Bram builds the bulletin', 'Build the bulletin from Wren’s notes: project/bulletin.html with project/bulletin.css (no frameworks, no external fonts, scripts or images; draw any picture with CSS or inline SVG): a title with the week’s dates, the week’s weather as one card per day, the garden tasks for the week, the volunteer slots and a footer with the sources. Look at it in the browser at 1280x800 and at a phone’s 390x844 and fix what looks wrong before you hand it on.', 'Ivy'),
    acceptance: ['part.js is the recorder’s file, unedited', 'The page was looked at in the browser at both widths'] },
  { id: 'ivy', title: 'Turn 3: Ivy reviews it', role: 'review', column: 3, row: 1, sandbox: true, output: 'Turn 3 (Ivy)', handoff: 'The project after turn 3',
    task: turnTask('Ivy', 3, 'Ivy reviews the bulletin', 'Review Bram’s bulletin as an editor: check every fact on the page against project/notes.md and its sources (fetch the forecast again and compare the days, highs, lows and rain), look at the page at 1280x800 and 390x844, and write project/review.md with numbered issues (a fact, a word, the layout, contrast), each saying what to change and why. If the page is right, say so and list nothing to change.', 'Bram'),
    acceptance: ['part.js is the recorder’s file, unedited', 'Each issue in review.md says what to change'] },
  { id: 'bram2', title: 'Turn 4: Bram makes the changes', role: 'frontend', column: 4, row: 1, sandbox: true, output: 'Turn 4 (Bram)', handoff: 'The finished project',
    task: turnTask('Bram', 4, 'Bram makes the changes', 'Make every change in Ivy’s project/review.md to the bulletin, look at the page again at both widths, and write project/CHANGES.md listing, for each numbered issue, what you changed (or why you did not). Then tell the team it is ready.', null),
    acceptance: ['part.js is the recorder’s file, unedited', 'CHANGES.md answers every numbered issue'] },
];

export const ROOST: OfficialWorkflow = {
  id: 'roost-team',
  title: 'Roost bot team',
  fonts: true,
  brief: 'Build Roost, a home for a team of AI bots in one web page: named bots, each with its own role and instructions, share one computer and talk in a group chat with you and with each other, ask before they act, work on routines and learn skills you show them by doing. It ships a real team session recorded during this run: four turns by three bots, each in its own sandbox computer, every command, file, web request and screenshot through a recorder, each handing the shared project on to the next. In it, a community garden’s weekly bulletin is gathered from the US National Weather Service’s public forecast, built, reviewed and corrected, and it replays on a timeline with a lane for each bot. Take over the shared computer at any moment; connect your own model (any OpenAI-compatible address) and the bots work live, when the page is opened on its own. Its design is written in a clean room: an agent in the sandbox computer reads an open-source multi-agent app with REA (the structure only, never running it) and writes evidence, the spec is written from that evidence, and nine builders write the code from the spec alone. It tests itself in the page, with planted failures it must catch.',
  nodes: [
    { id: 'read', title: 'Read the app', role: 'general', column: 0, row: 0, sandbox: true, output: 'Evidence report',
      task: `You are the reading room of a clean-room rebuild, in the sandbox computer. Read how an open-source multi-agent app is organised (the web studio where a person builds a team of AI agents, gives it a task and watches the agents talk and work), so that a spec can be written from your evidence without anyone reading its code. This run ends after 25 minutes and about 60 model calls: combine commands into few steps (a command may run 120 s), keep what each command prints short, and publish before the budget runs out. Clone, analyse and read within your first ten steps, then write.\n1. Fetch only its web front end through the workspace's web access: git clone --depth 1 --filter=blob:none --sparse ${ROOST_SOURCE} /tmp/app, then git -C /tmp/app sparse-checkout set ${ROOST_FRONT_END} (its code is MIT licensed, LICENSE-CODE). If the path is not there, find the front end's source with git -C /tmp/app ls-tree -r --name-only HEAD | grep -i studio | head and use it. If the clone fails, report that plainly and stop. Keep the clone and REA's report out of the workspace's archive: write REA's report to /tmp first, and if /tmp is too small, to the workspace and delete it before you publish (the workspace is archived when you finish and may hold at most 2 MiB).\n2. Run REA on it: rea analyze-javascript-application /tmp/app/${ROOST_FRONT_END} --json > /tmp/rea.json (static: it never runs the app). If REA cannot read a kind of file, say which and go on with what it read. Read the report with short node scripts as your skills describe: the modules, what each exports and which imports which.\n3. With file listings and grep (never copying code), find: how a team and its agents are defined (names, roles, instructions, tools, models), how a team's conversation is shown (the messages of each agent, who speaks next, hand-offs, tool calls and their results), how a run is started, stopped and watched, how the person is asked to approve or answer, how runs are kept, replayed or shared, and how the layout is divided.\n4. Write the evidence report, in your own words and with no code at all: the team and agent definitions with their fields as the app treats them, the message and event kinds of a run, how the conversation shows each agent and each hand-off, the run's lifecycle and states, approvals and questions to the person, how runs are kept and replayed, and the layout (its regions and what each holds). Mark every statement [observed] when REA's report or the files show it, with where, and [inferred] when you concluded it; end with what a bot team in ONE offline web page needs that this app gets from its servers (a computer, a model, storage, schedules), marked as such. Name the REA command lines you ran and their exit codes.\nPublish the report into the result output (Markdown, at most 18,000 characters).`,
      acceptance: ['Every statement is marked observed (with where) or inferred, and no code is copied', 'The REA command lines and their exit codes are stated'] },
    { id: 'rec', title: 'Turn recorder', role: 'frontend', column: 0, row: 1, output: 'Recorder rec.py',
      task: 'Writes the recorder every bot turn works through, rec.py, from its template with no model: every command, file, screenshot and web request of a turn goes through it and is written down as it happened.',
      acceptance: ['rec.py, byte for byte as its template'],
      assemble: { template: REC_PY, fileOnly: true, fileName: 'rec.py' } },
    { id: 'spec', title: 'Clean-room spec', role: 'general', column: 1, row: 0, output: 'Product and module spec', sandbox: true,
      task: `Write the one spec that nine builders will implement in parallel, each writing one module of Roost and never seeing the others' code or the app the evidence describes. Work from the evidence report in your inputs (the app's behaviour, in your own words) and the product described in the brief; copy no code, text or design from any product, and name no other product. The kernel contract below is fixed; the spec fills in everything else the builders need.\n\n${ROOST_KERNEL}\n\nWrite these sections in this order, as compact tables and lists, at most 20,000 characters in all. Write tersely: tables and short lines, no paragraphs, nothing the brief or the kernel contract already says. Keep your private reasoning short and put the work into the spec: the whole answer must fit one model call.\n1. Scope: what version 1 does and what it leaves out.\n2. Events on screen: for each event kind, its chip in the chat (icon, label pattern, colour), what each view shows for it, and the activity line's words; the hand-over line between turns.\n3. Commands: every command (id, label, group, shortcut, effect), at least 40, each owned by one module, with the ids the duties name.\n4. Regions, views and dialogs: top, sidebar (channels, roster, routines), chat (messages, mentions, chips, approval cards, end cards, the composer in each mode), the four views in their empty, replay, manual and live states, the timeline with its lanes, the status bar, and the bot profile, Routines, Skills, Connect, Connectors, Library, Share, Import, Self-test, Shortcuts and palette dialogs.\n5. Layout and look: every region in px, the colour tokens for dark and light as hex, the three bots' colours, the eight event-kind colours, the type scale, states (hover, active, focus, disabled).\n6. The shared computer: each built-in's options and its error messages.\n7. The live team: the bot's system message (at most 1,000 characters, written out), the tools as JSON-schema functions, how the bot that answers is picked, the approval rule, the error messages, how a routine fires.\n8. Module duties: for each of core, shell, vfs, chat, bots, computer, skills, replay and agent, the kernel names it implements, what it registers, what it must not touch, and its size budget.\n9. Acceptance tests: 28 to 34 numbered checks, one line each as given / when / then with exact values, each owned by one module (at least three per module); the first three, owned by replay, build two small turns of one team in the test and check at(ms) at three times; one owned by core checks that the page ships one recorded team session of at least two turns, each with an end event.\n10. Planted failures: 9 to 12 wrong variants, one line each with its owner and the test numbers that must catch it.\n11. Unknowns: what is still open, each with the default to use.\nIn section 2, mark every statement [observed] when the evidence states it and [inferred] when you concluded it. You work in the sandbox computer, but your answer is a message, not a file: write nothing to the workspace and reply with the whole spec as your final message, at most 20,000 characters.`,
      acceptance: ['Fills every section within the fixed kernel contract, with exact numbers', 'Each acceptance test has an owner, and each planted failure names the tests that catch it'] },
    ...TURNS,
    ...ROOST_BUILDERS,
    { id: 'page', title: 'Assembly', role: 'frontend', column: 5, row: 0, output: 'Assembled Roost page',
      task: 'Puts the nine modules and the four recorded turns into one page, byte for byte and in order, with no model: core, shell, vfs, chat, bots, computer, skills, replay, agent, then the turns, each in its own script tag (a script that fails cannot stop the others), then boots the app.',
      acceptance: ['A complete HTML document that boots Roost with its recorded team session'],
      assemble: { template: ROOST_PAGE, fileOnly: true, fileName: 'roost.html' } },
    { id: 'test', title: 'Test and fix', role: 'frontend', column: 6, row: 0, sandbox: true, output: 'Roost', outputType: 'html', report: 'Test report',
      task: 'You are Roost\'s integration tester, working in the sandbox computer. Your inputs give you the assembled page as a file in /inputs (roost.html: the nine modules and the four recorded turns in their own script tags, in order) and the spec as text.\n1. Copy the page into the workspace (cp /inputs/*roost.html roost.html) and run: awwo-check-page roost.html --out check --timeout-ms 100000 --budget-ms 115000 (headless Chromium with every request blocked; it runs window.awwoSelfTest(), takes a screenshot and writes check/report.json; a command may run 120 s).\n2. Read check/report.json with one short python3 script: page errors with their messages, every failing test with its detail, the planted failures caught, the blank-page flag. Never print the page itself.\n3. Publish the page as checked at once (workspace_publish with field "result" and path "roost.html"). Then write report.md and publish it (field "report", path "report.md"): the check\'s numbers (tests passed of total, planted failures caught of total, page errors, blank or not), every failing test with its detail and the module that owns it, and whether the page opens as the kernel says: the recorded team session replaying at speed 2 with its three bots in the roster (from the tests and the screenshot).\n4. Only if a failure has an obvious cause you can find with grep -n in a few lines, fix at most five such failures with small edits to roost.html (python3 or sed), run the check once more, and if that check is better, publish the page and an updated report.md again, the fixes listed one per line (module: what was wrong, what you changed). Never edit a recorded turn\'s script, weaken, delete or skip a test or a planted failure, or change a test\'s expected value.\n5. End with {"result": "", "report": ""} (the host fills in the published files). The last page and report you publish are what you deliver. This takes about 15 model calls; state only what the checks showed.',
      acceptance: ['The page delivered is the one the last check ran on', 'The report gives the check\'s numbers exactly, every failing test and every fix made'] },
    { id: 'review', title: 'Review', role: 'review', column: 7, row: 0, output: 'Review record', sandbox: true,
      task: 'Read the evidence report, the spec and the test report: check that the spec follows the evidence and marks what it inferred; list the acceptance checks the test report shows passing and failing by number, which planted failures were caught, what the fixes changed, and which parts of the spec no check covers. This is a static review: say "not actually run" for anything the reports do not show, and claim nothing beyond them; at most 350 words.',
      acceptance: ['Static review and actual execution are kept strictly apart'] },
  ],
  edges: [
    { from: 'read', to: 'spec', label: 'Evidence report' },
    ...TURNS.map(node => ({ from: 'rec', to: node.id, label: 'The recorder', port: 'file' as const })),
    { from: 'wren', to: 'bram', label: 'The project after turn 1', port: 'file' as const },
    { from: 'bram', to: 'ivy', label: 'The project after turn 2', port: 'file' as const },
    { from: 'ivy', to: 'bram2', label: 'The project after turn 3', port: 'file' as const },
    ...ROOST_BUILDERS.map(node => ({ from: 'spec', to: node.id, label: 'Spec' })),
    ...ROOST_BUILDERS.map(node => ({ from: node.id, to: 'page', label: node.output })),
    ...TURNS.map(node => ({ from: node.id, to: 'page', label: node.output })),
    { from: 'page', to: 'test', label: 'Assembled page', port: 'file' as const },
    { from: 'spec', to: 'test', label: 'Spec' },
    { from: 'test', to: 'review', label: 'Test report', port: 'report' as const },
    { from: 'spec', to: 'review', label: 'Spec' },
    { from: 'read', to: 'review', label: 'Evidence report' },
  ],
};
