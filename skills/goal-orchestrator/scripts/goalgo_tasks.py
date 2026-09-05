#!/usr/bin/env python3
"""Manage a project's .goalgo/goalgo.md task queue."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import subprocess
from pathlib import Path
from typing import Any


TASK_START_RE = re.compile(
    r"^<!-- goalgo:task id=(?P<id>[A-Za-z0-9_.-]+) "
    r"status=(?P<status>[A-Za-z0-9_.-]+) "
    r"priority=(?P<priority>[A-Za-z0-9_.-]+) "
    r"created=(?P<created>\S+) updated=(?P<updated>\S+) -->$"
)
TASK_END = "<!-- /goalgo:task -->"
BARE_TODO_RE = re.compile(r"^(?P<indent>\s*)-\s+\[\s\]\s+(?P<title>.+?)\s*$")
CHECKED_STATUSES = {"done", "deleted"}
ACTIVE_STATUSES = {"todo", "normalized", "claimed", "dispatched", "active", "blocked"}
DEFAULT_SCAN_INTERVAL_SECONDS = 30
DEFAULT_IDLE_PAUSE_SECONDS = 300
ALLOWED_STATUSES = {
    "todo",
    "normalized",
    "claimed",
    "dispatched",
    "active",
    "done",
    "blocked",
    "deleted",
    "dead_letter",
}


# When True, mutating commands print intended changes and skip all file writes.
DRY_RUN = False


def _emit_dry_run(action: str) -> None:
    print(f"[dry-run] would {action}")


def _write_md(paths: dict[str, "Path"], content: str) -> None:
    if DRY_RUN:
        _emit_dry_run(f"rewrite {paths['md']}")
        return
    paths["md"].write_text(content, encoding="utf-8")


def _write_archive(base: "Path", content: bytes) -> "Path":
    """Write evidence to a FRESH archive file. `O_CREAT|O_EXCL` never clobbers an
    existing file and never follows a symlink (so a planted symlink target cannot
    redirect the write); if the name is taken, suffix with a timestamp (then a
    counter) so prior archived evidence is preserved, not overwritten."""
    stamp = utc_now().replace(":", "").replace("-", "")
    candidates = [base, base.with_name(f"{base.stem}.{stamp}{base.suffix}")]
    counter = 2
    while True:
        for cand in candidates:
            try:
                fd = os.open(str(cand), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            except FileExistsError:
                continue
            with os.fdopen(fd, "wb") as handle:
                handle.write(content)
            return cand
        candidates = [base.with_name(f"{base.stem}.{stamp}-{counter}{base.suffix}")]
        counter += 1


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def slugify(text: str, fallback: str = "task") -> str:
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", text.lower()).strip("-")
    slug = re.sub(r"-{2,}", "-", slug)
    return (slug or fallback)[:48].strip("-") or fallback


_SAFE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


def is_safe_task_id(task_id: Any) -> bool:
    """True if `task_id` is a string that cannot escape the .goalgo/* dirs."""
    return (
        isinstance(task_id, str)
        and ".." not in task_id
        and "/" not in task_id
        and "\\" not in task_id
        and bool(_SAFE_ID_RE.match(task_id))
    )


def safe_task_id(task_id: str) -> str:
    """Reject task ids that could escape the .goalgo/* directories (path traversal)."""
    if not is_safe_task_id(task_id):
        raise SystemExit(f"Unsafe task id (must match {_SAFE_ID_RE.pattern}, no path separators): {task_id!r}")
    return task_id


def run_git_root(start: Path) -> Path | None:
    # Resolve to the MAIN repo working root even when invoked from inside a linked
    # worktree. `git rev-parse --show-toplevel` returns the *worktree* root, but the
    # coordinator's `.goalgo/`/`.codex-orchestrator/` live at the single canonical
    # project root. For a linked worktree the `.git` entry is a FILE and
    # `--git-common-dir` points at the main `<root>/.git` (whose parent is the root).
    def _git(*a: str) -> str | None:
        try:
            return subprocess.check_output(
                ["git", *a], cwd=str(start), text=True, stderr=subprocess.DEVNULL
            ).strip()
        except (subprocess.CalledProcessError, FileNotFoundError):
            return None

    # `git worktree list --porcelain` lists the MAIN worktree first; that is git's
    # own canonical answer and is correct for linked worktrees and robust for bare
    # repos (where the `.git`-name heuristic fails).
    listing = _git("worktree", "list", "--porcelain")
    if listing:
        for line in listing.splitlines():
            if line.startswith("worktree "):
                return Path(line[len("worktree ") :]).resolve()
    toplevel = _git("rev-parse", "--show-toplevel")
    return Path(toplevel).resolve() if toplevel else None


def find_existing_goalgo(start: Path) -> Path | None:
    current = start.resolve()
    if current.is_file():
        current = current.parent
    for candidate in [current, *current.parents]:
        goalgo_md = candidate / ".goalgo" / "goalgo.md"
        if goalgo_md.exists():
            return candidate
    return None


def project_root(start: str | None, create: bool = False) -> Path:
    base = Path(start or os.getcwd()).expanduser().resolve()
    if base.is_file():
        base = base.parent
    # Prefer the git MAIN-worktree root so the canonical .goalgo is always used,
    # even when invoked from a linked worktree that has a stale private copy.
    git_root = run_git_root(base)
    if git_root:
        return git_root
    existing = find_existing_goalgo(base)
    if existing:
        return existing
    if create:
        return base
    raise SystemExit("Could not find .goalgo/goalgo.md or a Git project root. Run `init` first.")


def goalgo_paths(root: Path) -> dict[str, Path]:
    goalgo = root / ".goalgo"
    return {
        "root": goalgo,
        "md": goalgo / "goalgo.md",
        "tasks": goalgo / "tasks",
        "claims": goalgo / "claims",
        "dead": goalgo / "dead-letter",
        "deleted": goalgo / "deleted",
        "events": goalgo / "events.jsonl",
        "state": goalgo / "state.json",
    }


def initial_goalgo_md(project_name: str) -> str:
    return f"""# Goal Go Task Queue

Project: `{project_name}`

Add tasks with this helper (the `add` subcommand) or append unchecked Markdown
items below. The coordinator will normalize unchecked items into managed task
blocks before dispatch.

## Inbox

"""


def ensure_queue(root: Path) -> dict[str, Path]:
    paths = goalgo_paths(root)
    if DRY_RUN:
        # A dry run must touch nothing — return the path map without creating the
        # scaffold. Readers tolerate missing files (see read_state / parse_goalgo_md).
        return paths
    for key in ("root", "tasks", "claims", "dead", "deleted"):
        paths[key].mkdir(parents=True, exist_ok=True)
    if not paths["md"].exists():
        paths["md"].write_text(initial_goalgo_md(root.name), encoding="utf-8")
    if not paths["state"].exists():
        paths["state"].write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "status": "active",
                    "scanIntervalSeconds": DEFAULT_SCAN_INTERVAL_SECONDS,
                    "idlePauseAfterSeconds": DEFAULT_IDLE_PAUSE_SECONDS,
                    "idleSince": None,
                    "lastScanAt": None,
                    "updatedAt": utc_now(),
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
    if not paths["events"].exists():
        paths["events"].write_text("", encoding="utf-8")
    return paths


def append_event(root: Path, event: str, task_id: str | None = None, payload: dict[str, Any] | None = None) -> None:
    paths = ensure_queue(root)
    record = {
        "timestamp": utc_now(),
        "event": event,
        "taskId": task_id,
        "payload": payload or {},
    }
    if DRY_RUN:
        _emit_dry_run(f"append event {event} for {task_id}")
        return
    with paths["events"].open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, sort_keys=True) + "\n")


def read_state(root: Path) -> dict[str, Any]:
    paths = ensure_queue(root)
    try:
        data = json.loads(paths["state"].read_text(encoding="utf-8"))
    except (json.JSONDecodeError, FileNotFoundError):
        data = {}
    if not isinstance(data, dict):
        data = {}
    data.setdefault("schemaVersion", 1)
    data.setdefault("status", "active")
    data.setdefault("scanIntervalSeconds", DEFAULT_SCAN_INTERVAL_SECONDS)
    data.setdefault("idlePauseAfterSeconds", DEFAULT_IDLE_PAUSE_SECONDS)
    data.setdefault("idleSince", None)
    data.setdefault("lastScanAt", None)
    return data


def write_state(root: Path, data: dict[str, Any]) -> None:
    paths = ensure_queue(root)
    data["updatedAt"] = utc_now()
    if DRY_RUN:
        _emit_dry_run(f"write listener state {paths['state']}")
        return
    paths["state"].write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def task_file(root: Path, task_id: str) -> Path:
    return ensure_queue(root)["tasks"] / f"{safe_task_id(task_id)}.json"


def read_task_json(root: Path, task_id: str) -> dict[str, Any] | None:
    if not is_safe_task_id(task_id):
        return None  # never build a path from (or crash on) an unsafe id during reads
    path = task_file(root, task_id)
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None


def write_task_json(root: Path, task: dict[str, Any]) -> None:
    task["updatedAt"] = utc_now()
    if DRY_RUN:
        _emit_dry_run(f"write task json {task['taskId']} (status={task.get('status')})")
        return
    task_file(root, task["taskId"]).write_text(json.dumps(task, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def checkbox_for(status: str) -> str:
    return "x" if status in CHECKED_STATUSES else " "


def render_task(task: dict[str, Any]) -> list[str]:
    details = str(task.get("details") or "").splitlines()
    status = str(task.get("status") or "todo")
    priority = str(task.get("priority") or "normal")
    created = str(task.get("createdAt") or utc_now())
    updated = str(task.get("updatedAt") or created)
    title = str(task.get("title") or task["taskId"]).strip()
    lines = [
        f"<!-- goalgo:task id={task['taskId']} status={status} priority={priority} created={created} updated={updated} -->",
        f"- [{checkbox_for(status)}] {task['taskId']}: {title}",
        f"  - Status: {status}",
        f"  - Priority: {priority}",
        "  - Details:",
    ]
    if details:
        lines.extend(f"    {line}" if line else "    " for line in details)
    else:
        lines.append("    ")
    lines.append(TASK_END)
    return lines


def parse_task_block(lines: list[str], start: int, end: int) -> dict[str, Any]:
    marker = TASK_START_RE.match(lines[start])
    if not marker:
        raise ValueError("invalid task block marker")
    task_id = marker.group("id")
    title = task_id
    details: list[str] = []
    in_details = False
    for line in lines[start + 1 : end]:
        if line.startswith("- [") and f"{task_id}:" in line:
            title = line.split(f"{task_id}:", 1)[1].strip()
        elif line.strip() == "- Details:" or line.strip() == "Details:" or line.strip() == "- Details":
            in_details = True
        elif line.startswith("  - Details:"):
            in_details = True
        elif in_details:
            details.append(line[4:] if line.startswith("    ") else line)
    return {
        "schemaVersion": 1,
        "taskId": task_id,
        "title": title,
        "details": "\n".join(details).rstrip(),
        "status": marker.group("status"),
        "priority": marker.group("priority"),
        "createdAt": marker.group("created"),
        "updatedAt": marker.group("updated"),
        "source": ".goalgo/goalgo.md",
    }


def parse_goalgo_md(root: Path) -> tuple[list[str], list[dict[str, Any]], list[tuple[int, int, dict[str, Any]]]]:
    paths = ensure_queue(root)
    try:
        lines = paths["md"].read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        lines = []
    tasks: list[dict[str, Any]] = []
    ranges: list[tuple[int, int, dict[str, Any]]] = []
    index = 0
    while index < len(lines):
        if TASK_START_RE.match(lines[index]):
            end = index + 1
            while end < len(lines) and lines[end] != TASK_END:
                end += 1
            if end >= len(lines):
                raise SystemExit(f"Malformed goalgo.md task block starting at line {index + 1}")
            task = parse_task_block(lines, index, end)
            tasks.append(task)
            ranges.append((index, end, task))
            index = end + 1
            continue
        index += 1
    return lines, tasks, ranges


def generate_task_id(root: Path, title: str, reserved: set[str] | None = None) -> str:
    reserved = reserved if reserved is not None else set()
    base = f"task-{utc_now().replace(':', '').replace('-', '')}-{slugify(title)}"
    candidate = base
    counter = 2
    # Guard against BOTH on-disk collisions and ids already allocated earlier in the
    # same run but not yet written (e.g. several same-title bare todos in one scan).
    while task_file(root, candidate).exists() or candidate in reserved:
        candidate = f"{base}-{counter}"
        counter += 1
    return candidate


def normalize_bare_todos(root: Path) -> list[dict[str, Any]]:
    paths = ensure_queue(root)
    lines, existing_tasks, ranges = parse_goalgo_md(root)
    occupied: set[int] = set()
    for start, end, _task in ranges:
        occupied.update(range(start, end + 1))

    changed = False
    output: list[str] = []
    normalized: list[dict[str, Any]] = []
    reserved_ids: set[str] = set()
    for index, line in enumerate(lines):
        if index in occupied:
            output.append(line)
            continue
        match = BARE_TODO_RE.match(line)
        if not match:
            output.append(line)
            continue
        title = match.group("title").strip()
        if title.startswith("task-") and ":" in title:
            output.append(line)
            continue
        now = utc_now()
        new_id = generate_task_id(root, title, reserved_ids)
        reserved_ids.add(new_id)
        task = {
            "schemaVersion": 1,
            "taskId": new_id,
            "title": title,
            "details": "",
            "status": "todo",
            "priority": "normal",
            "createdAt": now,
            "updatedAt": now,
            "source": ".goalgo/goalgo.md",
        }
        output.extend(render_task(task))
        normalized.append(task)
        changed = True

    all_tasks = {task["taskId"]: task for task in existing_tasks}
    for task in normalized:
        all_tasks[task["taskId"]] = task
    wrote_any = changed
    for task in all_tasks.values():
        if not is_safe_task_id(task.get("taskId")):
            continue  # skip ids that could escape .goalgo/* (and would raise in task_file)
        if task_file(root, task["taskId"]).exists():
            existing_json = read_task_json(root, task["taskId"])
            if existing_json is None:
                # The file exists but is MALFORMED. Never overwrite it with synthesized
                # metadata — that would destroy the raw evidence before dead-letter can
                # archive it. Leave it untouched for `dead-letter` to preserve.
                continue
        else:
            existing_json = {}
        merged = {**task, **existing_json}
        merged.setdefault("status", task["status"])
        # Only write when content actually differs (ignoring the updatedAt stamp), so
        # read commands (list/show → load_tasks → here) do not rewrite every file and
        # the listener state on every invocation.
        old_cmp = {k: v for k, v in existing_json.items() if k != "updatedAt"}
        new_cmp = {k: v for k, v in merged.items() if k != "updatedAt"}
        if new_cmp != old_cmp:
            write_task_json(root, merged)
            wrote_any = True

    if wrote_any:
        state = read_state(root)
        state["lastScanAt"] = utc_now()
        write_state(root, state)

    if changed:
        _write_md(paths, "\n".join(output).rstrip() + "\n")
        for task in normalized:
            append_event(root, "task.normalized", task["taskId"], {"title": task["title"]})
    return list(all_tasks.values())


def replace_task_block(root: Path, task: dict[str, Any]) -> None:
    paths = ensure_queue(root)
    lines, _tasks, ranges = parse_goalgo_md(root)
    rendered = render_task(task)
    for start, end, existing in ranges:
        if existing["taskId"] == task["taskId"]:
            new_lines = lines[:start] + rendered + lines[end + 1 :]
            _write_md(paths, "\n".join(new_lines).rstrip() + "\n")
            write_task_json(root, task)
            return
    if DRY_RUN:
        _emit_dry_run(f"append task block {task['taskId']} to {paths['md']}")
    else:
        with paths["md"].open("a", encoding="utf-8") as handle:
            if lines and lines[-1].strip():
                handle.write("\n")
            handle.write("\n".join(rendered) + "\n")
    write_task_json(root, task)


def remove_task_block(root: Path, task_id: str) -> bool:
    paths = ensure_queue(root)
    lines, _tasks, ranges = parse_goalgo_md(root)
    for start, end, existing in ranges:
        if existing["taskId"] == task_id:
            new_lines = lines[:start] + lines[end + 1 :]
            _write_md(paths, "\n".join(new_lines).rstrip() + "\n")
            return True
    return False


def load_tasks(root: Path, include_deleted: bool = False) -> list[dict[str, Any]]:
    normalize_bare_todos(root)
    _lines, md_tasks, _ranges = parse_goalgo_md(root)
    # Only ingest ids that cannot escape .goalgo/* — an attacker-controlled
    # tasks/*.json could otherwise carry a traversal taskId that downstream
    # claim/delete/archive path construction would honor.
    merged: dict[str, dict[str, Any]] = {
        task["taskId"]: task for task in md_tasks if is_safe_task_id(task.get("taskId"))
    }
    paths = ensure_queue(root)
    for path in sorted(paths["tasks"].glob("*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        if not isinstance(data, dict) or not is_safe_task_id(data.get("taskId")):
            continue
        merged[data["taskId"]] = {**merged.get(data["taskId"], {}), **data}
    tasks = list(merged.values())
    if not include_deleted:
        tasks = [task for task in tasks if task.get("status") not in {"deleted", "dead_letter"}]
    return sorted(tasks, key=lambda item: (item.get("createdAt") or "", item.get("taskId") or ""))


def task_summary(task: dict[str, Any]) -> str:
    return f"{task['taskId']} [{task.get('status', 'todo')}] ({task.get('priority', 'normal')}) {task.get('title', '')}"


def print_result(data: Any, as_json: bool) -> None:
    if as_json:
        print(json.dumps(data, indent=2, sort_keys=True))
    elif isinstance(data, list):
        for item in data:
            print(task_summary(item) if isinstance(item, dict) and "taskId" in item else item)
    elif isinstance(data, dict) and "taskId" in data:
        print(task_summary(data))
        details = data.get("details")
        if details:
            print(details)
    else:
        print(data)


def cmd_init(args: argparse.Namespace) -> None:
    root = project_root(args.workspace, create=True)
    paths = ensure_queue(root)
    append_event(root, "queue.initialized", None, {"projectRoot": str(root)})
    print_result({"projectRoot": str(root), "goalgoMd": str(paths["md"])}, args.json)


def cmd_path(args: argparse.Namespace) -> None:
    root = project_root(args.workspace, create=args.create)
    if args.create:
        ensure_queue(root)
    print_result({"projectRoot": str(root), "goalgoMd": str(goalgo_paths(root)["md"])}, args.json)


def cmd_scan(args: argparse.Namespace) -> None:
    root = project_root(args.workspace, create=args.create)
    tasks = load_tasks(root, include_deleted=args.include_deleted)
    print_result(tasks, args.json)


def cmd_add(args: argparse.Namespace) -> None:
    root = project_root(args.workspace, create=True)
    ensure_queue(root)
    now = utc_now()
    task = {
        "schemaVersion": 1,
        "taskId": args.task_id or generate_task_id(root, args.title),
        "title": args.title.strip(),
        "details": args.details or "",
        "status": args.status,
        "priority": args.priority,
        "createdAt": now,
        "updatedAt": now,
        "source": ".goalgo/goalgo.md",
    }
    if task_file(root, task["taskId"]).exists():
        raise SystemExit(f"Task already exists: {task['taskId']}")
    replace_task_block(root, task)
    append_event(root, "task.added", task["taskId"], {"title": task["title"], "priority": task["priority"]})
    print_result(task, args.json)


def find_task(root: Path, task_id: str) -> dict[str, Any]:
    for task in load_tasks(root, include_deleted=True):
        if task.get("taskId") == task_id:
            return task
    raise SystemExit(f"Task not found: {task_id}")


def cmd_list(args: argparse.Namespace) -> None:
    root = project_root(args.workspace)
    tasks = load_tasks(root, include_deleted=args.include_deleted)
    if args.status:
        wanted = set(args.status)
        tasks = [task for task in tasks if task.get("status") in wanted]
    print_result(tasks, args.json)


def cmd_show(args: argparse.Namespace) -> None:
    root = project_root(args.workspace)
    print_result(find_task(root, args.task_id), args.json)


def cmd_update(args: argparse.Namespace) -> None:
    root = project_root(args.workspace)
    task = find_task(root, args.task_id)
    if args.title is not None:
        task["title"] = args.title
    if args.details is not None:
        task["details"] = args.details
    if args.priority is not None:
        task["priority"] = args.priority
    if args.status is not None:
        task["status"] = args.status
    replace_task_block(root, task)
    append_event(root, "task.updated", task["taskId"], {"status": task.get("status")})
    print_result(task, args.json)


def _archive_and_cleanup(root: Path, task: dict[str, Any], dest_key: str, *, hard: bool) -> None:
    """Archive a task's JSON to `dest_key` dir, drop its goalgo.md block and claim,
    keep/remove the live task JSON. Honors DRY_RUN. Shared by delete + dead-letter."""
    paths = ensure_queue(root)
    archive = paths[dest_key] / f"{task['taskId']}.json"
    if DRY_RUN:
        _emit_dry_run(f"archive {task['taskId']} -> {archive}")
    else:
        _write_archive(archive, (json.dumps(task, indent=2, sort_keys=True) + "\n").encode("utf-8"))
    remove_task_block(root, task["taskId"])
    task_path = task_file(root, task["taskId"])
    if hard:
        if DRY_RUN:
            _emit_dry_run(f"remove task json {task_path}")
        else:
            task_path.unlink(missing_ok=True)
    else:
        write_task_json(root, task)
    claim = paths["claims"] / f"{task['taskId']}.json"
    if DRY_RUN:
        _emit_dry_run(f"remove claim {claim}")
    else:
        claim.unlink(missing_ok=True)


def cmd_delete(args: argparse.Namespace) -> None:
    root = project_root(args.workspace)
    task = find_task(root, args.task_id)
    task["status"] = "deleted"
    task["deletedAt"] = utc_now()
    _archive_and_cleanup(root, task, "deleted", hard=args.hard)
    append_event(root, "task.deleted", task["taskId"], {"hard": args.hard})
    print_result(task, args.json)


def cmd_dead_letter(args: argparse.Namespace) -> None:
    root = project_root(args.workspace)
    task_id = safe_task_id(args.task_id)
    paths = ensure_queue(root)
    raw_path = paths["tasks"] / f"{task_id}.json"
    # ALWAYS preserve the exact raw on-disk bytes as evidence when the file exists,
    # even if goalgo.md has a valid block (a malformed tasks/<id>.json must not be
    # replaced by synthesized metadata). Parsed metadata is only a fallback for the
    # archive content when there is no raw file at all.
    # Read the raw file as BYTES for exact evidence preservation. Fail closed: if a
    # present raw file cannot be read, let the error propagate BEFORE anything is
    # unlinked — never destroy evidence we could not first archive.
    raw_bytes: bytes | None = raw_path.read_bytes() if raw_path.exists() else None
    archive = paths["dead"] / f"{task_id}.json"
    if raw_bytes is not None:
        # A raw file exists: archive its exact bytes. We do NOT call find_task here,
        # so corruption/not-found SystemExits are never swallowed.
        archive_content = raw_bytes
    else:
        # No raw file: we must parse metadata to know what to archive. Let find_task
        # raise (not-found / malformed goalgo.md) and HALT — fail closed, no swallow.
        parsed = find_task(root, task_id)
        record = {**parsed, "status": "dead_letter", "deadLetteredAt": utc_now()}
        if args.reason:
            record["deadLetterReason"] = args.reason
        archive_content = (json.dumps(record, indent=2, sort_keys=True) + "\n").encode("utf-8")
    if DRY_RUN:
        _emit_dry_run(f"archive {task_id} -> {archive} (raw evidence={'yes' if raw_bytes is not None else 'no'})")
        _emit_dry_run(f"remove raw task json + claim + goalgo.md block for {task_id}")
    else:
        _write_archive(archive, archive_content)
        raw_path.unlink(missing_ok=True)
        (paths["claims"] / f"{task_id}.json").unlink(missing_ok=True)
        try:
            remove_task_block(root, task_id)
        except SystemExit:
            pass  # malformed goalgo.md — leave the block for manual cleanup
    append_event(root, "task.dead_letter", task_id, {"reason": args.reason, "rawEvidence": raw_bytes is not None})
    print_result({"taskId": task_id, "status": "dead_letter", "rawEvidence": raw_bytes is not None}, args.json)


def claim_task(root: Path, task: dict[str, Any], owner: str) -> bool:
    paths = ensure_queue(root)
    claim_path = paths["claims"] / f"{task['taskId']}.json"
    claim = {
        "taskId": task["taskId"],
        "owner": owner,
        "claimedAt": utc_now(),
    }
    if DRY_RUN:
        if claim_path.exists():
            return False
        _emit_dry_run(f"create claim file {claim_path} (owner={owner})")
    else:
        try:
            fd = os.open(str(claim_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            return False
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(json.dumps(claim, indent=2, sort_keys=True) + "\n")
    task["status"] = "claimed"
    task["claimedBy"] = owner
    task["claimedAt"] = claim["claimedAt"]
    replace_task_block(root, task)
    append_event(root, "task.claimed", task["taskId"], {"owner": owner})
    return True


def cmd_claim(args: argparse.Namespace) -> None:
    root = project_root(args.workspace)
    task = find_task(root, args.task_id)
    if task.get("status") not in {"todo", "normalized", "blocked"}:
        raise SystemExit(f"Task is not claimable: {task['taskId']} status={task.get('status')}")
    if not claim_task(root, task, args.owner):
        raise SystemExit(f"Task is already claimed: {task['taskId']}")
    print_result(task, args.json)


def cmd_next(args: argparse.Namespace) -> None:
    root = project_root(args.workspace)
    for task in load_tasks(root):
        if task.get("status") not in {"todo", "normalized", "blocked"}:
            continue
        if claim_task(root, task, args.owner):
            print_result(task, args.json)
            return
    print_result({"task": None, "message": "No claimable tasks"}, args.json)


def cmd_release(args: argparse.Namespace) -> None:
    root = project_root(args.workspace)
    paths = ensure_queue(root)
    task = find_task(root, args.task_id)
    claim_path = paths["claims"] / f"{task['taskId']}.json"
    if claim_path.exists() and args.owner:
        claim = json.loads(claim_path.read_text(encoding="utf-8"))
        if claim.get("owner") != args.owner:
            raise SystemExit(f"Claim is owned by {claim.get('owner')}, not {args.owner}")
    if DRY_RUN:
        _emit_dry_run(f"remove claim {claim_path}")
    else:
        claim_path.unlink(missing_ok=True)
    task["status"] = args.status
    task.pop("claimedBy", None)
    task.pop("claimedAt", None)
    replace_task_block(root, task)
    append_event(root, "task.released", task["taskId"], {"status": args.status, "owner": args.owner})
    print_result(task, args.json)


def cmd_set_status(args: argparse.Namespace) -> None:
    root = project_root(args.workspace)
    task = find_task(root, args.task_id)
    task["status"] = args.status
    if args.note:
        task["statusNote"] = args.note
    replace_task_block(root, task)
    append_event(root, "task.status", task["taskId"], {"status": args.status, "note": args.note})
    print_result(task, args.json)


def cmd_state(args: argparse.Namespace) -> None:
    root = project_root(args.workspace, create=args.create)
    ensure_queue(root)
    state = read_state(root)
    changed = False
    if args.status:
        state["status"] = args.status
        changed = True
    if args.idle_since == "now":
        state["idleSince"] = utc_now()
        changed = True
    elif args.idle_since == "clear":
        state["idleSince"] = None
        changed = True
    if args.last_scan_now:
        state["lastScanAt"] = utc_now()
        changed = True
    if changed:
        write_state(root, state)
    print_result(state, args.json)


def add_common(parser: argparse.ArgumentParser, *, create_flag: bool = False) -> None:
    parser.add_argument("--workspace", default="", help="Project directory. Defaults to cwd.")
    parser.add_argument("--json", action="store_true", help="Print JSON.")
    parser.add_argument("--dry-run", action="store_true", help="Print intended mutations without writing any files.")
    if create_flag:
        parser.add_argument("--create", action="store_true", help="Create .goalgo if missing.")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    init = sub.add_parser("init", help="Initialize .goalgo in the current project.")
    add_common(init)
    init.set_defaults(func=cmd_init)

    path = sub.add_parser("path", help="Print the project goalgo.md path.")
    add_common(path, create_flag=True)
    path.set_defaults(func=cmd_path)

    scan = sub.add_parser("scan", help="Normalize bare todos and sync task JSON files.")
    add_common(scan, create_flag=True)
    scan.add_argument("--include-deleted", action="store_true")
    scan.set_defaults(func=cmd_scan)

    add = sub.add_parser("add", help="Add a task.")
    add_common(add)
    add.add_argument("title")
    add.add_argument("--details", default="")
    add.add_argument("--priority", default="normal")
    add.add_argument("--status", choices=sorted(ALLOWED_STATUSES), default="todo")
    add.add_argument("--task-id", default="")
    add.set_defaults(func=cmd_add)

    list_cmd = sub.add_parser("list", help="List tasks.")
    add_common(list_cmd)
    list_cmd.add_argument("--status", action="append", choices=sorted(ALLOWED_STATUSES))
    list_cmd.add_argument("--include-deleted", action="store_true")
    list_cmd.set_defaults(func=cmd_list)

    show = sub.add_parser("show", help="Show one task.")
    add_common(show)
    show.add_argument("task_id")
    show.set_defaults(func=cmd_show)

    update = sub.add_parser("update", help="Update a task.")
    add_common(update)
    update.add_argument("task_id")
    update.add_argument("--title")
    update.add_argument("--details")
    update.add_argument("--priority")
    update.add_argument("--status", choices=sorted(ALLOWED_STATUSES))
    update.set_defaults(func=cmd_update)

    delete = sub.add_parser("delete", help="Delete a task from goalgo.md and archive its JSON.")
    add_common(delete)
    delete.add_argument("task_id")
    delete.add_argument("--hard", action="store_true", help="Remove task JSON after archiving.")
    delete.set_defaults(func=cmd_delete)

    dead = sub.add_parser("dead-letter", help="Move an unparseable/abandoned task to .goalgo/dead-letter/ (preserves raw evidence).")
    add_common(dead)
    dead.add_argument("task_id")
    dead.add_argument("--reason", default="", help="Why the task was dead-lettered.")
    dead.set_defaults(func=cmd_dead_letter)

    claim = sub.add_parser("claim", help="Atomically claim a task.")
    add_common(claim)
    claim.add_argument("task_id")
    claim.add_argument("--owner", required=True)
    claim.set_defaults(func=cmd_claim)

    next_cmd = sub.add_parser("next", help="Claim the next available task.")
    add_common(next_cmd)
    next_cmd.add_argument("--owner", required=True)
    next_cmd.set_defaults(func=cmd_next)

    release = sub.add_parser("release", help="Release a claimed task.")
    add_common(release)
    release.add_argument("task_id")
    release.add_argument("--owner")
    release.add_argument("--status", choices=["todo", "blocked"], default="todo")
    release.set_defaults(func=cmd_release)

    set_status = sub.add_parser("set-status", help="Set task lifecycle status.")
    add_common(set_status)
    set_status.add_argument("task_id")
    set_status.add_argument("status", choices=sorted(ALLOWED_STATUSES))
    set_status.add_argument("--note", default="")
    set_status.set_defaults(func=cmd_set_status)

    state = sub.add_parser("state", help="Read or update queue listener state.")
    add_common(state, create_flag=True)
    state.add_argument("--status", choices=["active", "idle_waiting", "idle_paused", "blocked"], default="")
    state.add_argument("--idle-since", choices=["now", "clear"], default="")
    state.add_argument("--last-scan-now", action="store_true")
    state.set_defaults(func=cmd_state)
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    global DRY_RUN
    DRY_RUN = getattr(args, "dry_run", False)
    args.func(args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
