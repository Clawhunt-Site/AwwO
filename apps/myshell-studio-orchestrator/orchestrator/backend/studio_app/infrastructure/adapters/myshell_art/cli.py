from __future__ import annotations

import asyncio
import json
import os
import shlex
import shutil
import sys
from pathlib import Path
from typing import Any


DEFAULT_REPO_PATH = Path("/Users/penguin/work_penguin/_bobo_extra_projects/myshell-art-cli")
CONFIG_DIR = Path.home() / ".myshell-art"
CONFIG_FILE = CONFIG_DIR / "config.json"
BROWSER_STATE_FILE = CONFIG_DIR / "browser_state.json"
SENSITIVE_KEY_PARTS = ("token", "cookie", "authorization", "init_data", "initdata", "secret")


def _repo_path() -> Path:
    configured = os.environ.get("MYSHELL_ART_CLI_PATH") or os.environ.get("MYSHELL_ART_CLI_REPO")
    return Path(configured).expanduser() if configured else DEFAULT_REPO_PATH


def _read_cli_config() -> dict[str, Any]:
    if not CONFIG_FILE.exists():
        return {}
    try:
        data = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def _project_python() -> str:
    configured = os.environ.get("MYSHELL_ART_CLI_PYTHON", "").strip()
    if configured:
        return configured
    project_python = Path(__file__).resolve().parents[6] / ".venv" / "bin" / "python"
    if project_python.exists():
        return str(project_python)
    return sys.executable


def _cli_command_prefix() -> tuple[list[str], dict[str, str], str]:
    configured_bin = os.environ.get("MYSHELL_ART_CLI_BIN", "").strip()
    env = dict(os.environ)
    if configured_bin:
        return shlex.split(configured_bin), env, ""

    discovered = shutil.which("myshell-art")
    if discovered:
        return [discovered], env, ""

    repo_path = _repo_path()
    module_entry = repo_path / "cli_anything" / "myshell_art" / "myshell_art_cli.py"
    if module_entry.exists():
        python_path = env.get("PYTHONPATH", "")
        env["PYTHONPATH"] = str(repo_path) if not python_path else f"{repo_path}{os.pathsep}{python_path}"
        return [_project_python(), "-m", "cli_anything.myshell_art.myshell_art_cli"], env, str(repo_path)

    return [], env, ""


def cli_status() -> dict[str, Any]:
    repo_path = _repo_path()
    prefix, _env, cwd = _cli_command_prefix()
    config = _read_cli_config()
    cookies = config.get("cookies") if isinstance(config.get("cookies"), dict) else {}
    has_token = bool(os.environ.get("MYSHELL_TOKEN") or config.get("token"))
    has_dreamy_init_data = bool(os.environ.get("DREAMY_TELEGRAM_INIT_DATA") or os.environ.get("MYSHELL_TELEGRAM_INIT_DATA"))
    browser_state_exists = BROWSER_STATE_FILE.exists()
    ready = bool(prefix)
    return {
        "status": "ready" if ready else "not_installed",
        "ready": ready,
        "provider": "myshell-art-cli",
        "repoPath": str(repo_path),
        "repoExists": repo_path.exists(),
        "binary": prefix[0] if prefix else "",
        "commandPrefix": _redact_args(prefix),
        "cwd": cwd,
        "message": "MyShell Art CLI is available." if ready else "MyShell Art CLI is not installed or configured.",
        "defaults": {
            "hasCanvasproSlug": bool(
                os.environ.get("CANVASPRO_MYSHELL_ART_SLUG")
                or os.environ.get("MYSHELL_ART_CLI_CANVASPRO_SLUG")
                or os.environ.get("MYSHELL_ART_DEFAULT_SLUG")
                or _config_value(config, "canvaspro.slug", "canvaspro.slugId", "defaults.slug", "defaultSlug")
            ),
            "hasCanvasproSlugId": bool(
                os.environ.get("CANVASPRO_MYSHELL_ART_SLUG_ID")
                or os.environ.get("MYSHELL_ART_CLI_CANVASPRO_SLUG_ID")
                or os.environ.get("MYSHELL_ART_DEFAULT_SLUG_ID")
                or _config_value(config, "canvaspro.slugId", "canvaspro.slug_id", "dreamy.slugId", "defaultSlugId")
            ),
            "hasCanvasproBotId": bool(
                os.environ.get("CANVASPRO_MYSHELL_ART_BOT_ID")
                or os.environ.get("MYSHELL_ART_CLI_CANVASPRO_BOT_ID")
                or os.environ.get("MYSHELL_ART_DEFAULT_BOT_ID")
                or _config_value(config, "canvaspro.botId", "canvaspro.bot_id", "dreamy.botId", "defaultBotId")
            ),
        },
        "auth": {
            "dreamy": {
                "status": "ready" if has_dreamy_init_data else "auth_missing",
                "ready": has_dreamy_init_data,
                "requires": ["DREAMY_TELEGRAM_INIT_DATA", "MYSHELL_TELEGRAM_INIT_DATA"],
            },
            "art": {
                "status": "ready" if has_token or cookies or browser_state_exists else "auth_missing",
                "ready": bool(has_token or cookies or browser_state_exists),
                "hasToken": has_token,
                "cookieCount": len(cookies),
                "browserStateExists": browser_state_exists,
                "browserStatePath": str(BROWSER_STATE_FILE),
            },
        },
    }


def _redact_text(text: str, secrets: list[str] | None = None) -> str:
    redacted = text
    for secret in secrets or []:
        if len(secret) >= 4:
            redacted = redacted.replace(secret, "<redacted>")
    return redacted


def _sanitize_json(value: Any) -> Any:
    if isinstance(value, dict):
        sanitized: dict[str, Any] = {}
        for key, item in value.items():
            lower_key = str(key).replace("-", "_").lower()
            if any(part in lower_key for part in SENSITIVE_KEY_PARTS):
                if isinstance(item, (bool, int, float)) or item is None:
                    sanitized[key] = item
                elif isinstance(item, list):
                    sanitized[key] = [f"<redacted:{len(item)}>"]
                elif isinstance(item, dict):
                    sanitized[key] = "<redacted>"
                else:
                    sanitized[key] = "<redacted>" if str(item) else ""
            else:
                sanitized[key] = _sanitize_json(item)
        return sanitized
    if isinstance(value, list):
        return [_sanitize_json(item) for item in value]
    return value


def _cli_auth_ready(raw: Any, status: dict[str, Any]) -> bool:
    if isinstance(raw, dict):
        authenticated = raw.get("authenticated")
        if isinstance(authenticated, bool):
            return authenticated
        if raw.get("has_token") or raw.get("hasToken"):
            return True
        try:
            if int(raw.get("cookie_count") or raw.get("cookieCount") or 0) > 0:
                return True
        except (TypeError, ValueError):
            pass
        if raw.get("browser_state_exists") or raw.get("browserStateExists"):
            return True
    auth = status.get("auth") if isinstance(status.get("auth"), dict) else {}
    art = auth.get("art") if isinstance(auth.get("art"), dict) else {}
    return bool(art.get("ready"))


async def _run_cli_json(args: list[str], *, timeout: int = 30, redaction_values: list[str] | None = None) -> dict[str, Any]:
    status = cli_status()
    prefix, env, cwd = _cli_command_prefix()
    command_preview = _command_preview(args)
    if not prefix:
        return {
            "status": "not_installed",
            "ready": False,
            "provider": "myshell-art-cli",
            "message": str(status.get("message") or "MyShell Art CLI is not available."),
            "cliStatus": status,
            "commandPreview": command_preview,
        }
    try:
        process = await asyncio.create_subprocess_exec(
            *prefix,
            *args,
            cwd=cwd or None,
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout_bytes, stderr_bytes = await asyncio.wait_for(process.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        return {
            "status": "timeout",
            "ready": False,
            "provider": "myshell-art-cli",
            "message": f"MyShell Art CLI command timed out after {timeout}s.",
            "cliStatus": status,
            "commandPreview": command_preview,
        }
    except OSError as exc:
        return {
            "status": "error",
            "ready": False,
            "provider": "myshell-art-cli",
            "message": str(exc),
            "cliStatus": status,
            "commandPreview": command_preview,
        }

    stdout = _redact_text(stdout_bytes.decode("utf-8", errors="replace"), redaction_values)
    stderr = _redact_text(stderr_bytes.decode("utf-8", errors="replace"), redaction_values)
    raw = _sanitize_json(_parse_json_stdout(stdout))
    if process.returncode != 0:
        return {
            "status": _error_status(stdout, stderr),
            "ready": False,
            "provider": "myshell-art-cli",
            "message": _error_message(raw, stdout, stderr),
            "cliStatus": status,
            "commandPreview": command_preview,
            "returnCode": process.returncode,
            "raw": raw,
        }
    ready = _cli_auth_ready(raw, status)
    return {
        "status": "ready" if ready else "auth_missing",
        "ready": ready,
        "provider": "myshell-art-cli",
        "message": "MyShell Art CLI credentials are ready." if ready else "MyShell Art CLI is installed, but not logged in.",
        "cliStatus": status,
        "commandPreview": command_preview,
        "returnCode": process.returncode,
        "raw": raw,
    }


async def auth_status() -> dict[str, Any]:
    return await _run_cli_json(["--json", "auth", "status"], timeout=30)


async def auth_doctor() -> dict[str, Any]:
    return await _run_cli_json(["--json", "auth", "doctor"], timeout=30)


async def login_with_token(token: str) -> dict[str, Any]:
    cleaned = token.strip()
    return await _run_cli_json(
        ["--json", "auth", "login", "--token", cleaned],
        timeout=60,
        redaction_values=[cleaned],
    )


async def login_with_cookie(cookie: str) -> dict[str, Any]:
    cleaned = cookie.strip()
    return await _run_cli_json(
        ["--json", "auth", "login", "--cookie", cleaned],
        timeout=60,
        redaction_values=[cleaned],
    )


def canvaspro_node_capabilities() -> dict[str, Any]:
    status = cli_status()
    return {
        "status": status["status"],
        "ready": status["ready"],
        "provider": {
            "id": "myshell-art-cli",
            "label": "MyShell Art CLI",
            "status": status,
        },
        "capabilities": [
            {
                "id": "myshell-art-cli.dreamy-generate",
                "provider": "myshell-art-cli",
                "atom": "dreamy-generate",
                "label": "Dreamy Generate",
                "description": "Run Dreamy miniapp generation through myshell-art --json dreamy generate.",
                "nodeKinds": ["image", "video", "ai-image", "ai-video"],
                "inputs": ["prompt", "slugId", "botId", "inputImg", "settings"],
                "outputs": ["outputJobId", "mediaUrl", "rawJson"],
                "auth": status["auth"]["dreamy"],
                "commandTemplate": "myshell-art --json dreamy generate --slug-id <slug> --prompt <prompt>",
            },
            {
                "id": "myshell-art-cli.generate-create",
                "provider": "myshell-art-cli",
                "atom": "generate-create",
                "label": "Art Generate",
                "description": "Submit a MyShell Art generation task through myshell-art --json generate create.",
                "nodeKinds": ["image", "video", "ai-image", "ai-video"],
                "inputs": ["slug", "botId", "inputImg", "articleId"],
                "outputs": ["taskId", "mediaUrl", "rawJson"],
                "auth": status["auth"]["art"],
                "commandTemplate": "myshell-art --json generate create --slug <slug> --input-img <file-or-url>",
            },
            {
                "id": "myshell-art-cli.upload-image",
                "provider": "myshell-art-cli",
                "atom": "upload-image",
                "label": "Upload Image",
                "description": "Upload a local reference image and return a MyShell-accessible URL.",
                "nodeKinds": ["image-reference", "ai-image", "ai-video"],
                "inputs": ["file"],
                "outputs": ["url", "rawJson"],
                "auth": status["auth"]["art"],
                "commandTemplate": "myshell-art --json upload image <file>",
            },
            {
                "id": "myshell-art-cli.energy-balance",
                "provider": "myshell-art-cli",
                "atom": "energy-balance",
                "label": "Energy Balance",
                "description": "Read current MyShell Art energy balance before executing expensive tasks.",
                "nodeKinds": ["diagnostic"],
                "inputs": [],
                "outputs": ["balance", "rawJson"],
                "auth": status["auth"]["art"],
                "commandTemplate": "myshell-art --json energy balance",
            },
        ],
    }


def _normalize_atom(value: Any) -> str:
    atom = str(value or "").strip().lower()
    atom = atom.removeprefix("myshell-art-cli.")
    if atom in {"generate", "generate-create", "art-generate", "create"}:
        return "generate-create"
    if atom in {"upload", "upload-image"}:
        return "upload-image"
    if atom in {"energy", "energy-balance"}:
        return "energy-balance"
    return "dreamy-generate"


def _string_value(*values: Any) -> str:
    for value in values:
        text = str(value or "").strip()
        if text:
            return text
    return ""


def _config_value(config: dict[str, Any], *paths: str) -> str:
    for path in paths:
        current: Any = config
        for part in path.split("."):
            if not isinstance(current, dict):
                current = None
                break
            current = current.get(part)
        text = str(current or "").strip()
        if text:
            return text
    return ""


def _bool_value(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def _redact_args(args: list[str]) -> list[str]:
    redacted: list[str] = []
    redact_next = False
    for arg in args:
        if redact_next:
            redacted.append("<redacted>")
            redact_next = False
            continue
        redacted.append(arg)
        if arg in {"--token", "--cookie", "--init-data"}:
            redact_next = True
    return redacted


def _command_preview(args: list[str]) -> str:
    preview = ["myshell-art", *args]
    return " ".join(shlex.quote(arg) for arg in _redact_args(preview))


def _settings_customization(kind: str, settings: dict[str, Any]) -> dict[str, Any]:
    customization = {
        "source": "canvaspro",
        "kind": "video" if kind == "video" else "image",
        "mode": settings.get("mode"),
        "model": settings.get("model"),
        "quality": settings.get("quality"),
        "aspectRatio": settings.get("aspectRatio"),
        "resolution": settings.get("resolution"),
        "outputCount": settings.get("outputCount"),
    }
    if kind == "video":
        customization["durationSeconds"] = settings.get("durationSeconds")
    return {key: value for key, value in customization.items() if value not in {"", None}}


def _auth_for_atom(atom: str, status: dict[str, Any]) -> dict[str, Any]:
    auth = status.get("auth") if isinstance(status.get("auth"), dict) else {}
    if atom == "dreamy-generate":
        return auth.get("dreamy") if isinstance(auth.get("dreamy"), dict) else {"status": "auth_missing", "ready": False}
    if atom in {"generate-create", "upload-image", "energy-balance"}:
        return auth.get("art") if isinstance(auth.get("art"), dict) else {"status": "auth_missing", "ready": False}
    return {"status": "ready", "ready": True}


def build_canvaspro_plan(
    *,
    kind: str,
    prompt: str,
    settings: dict[str, Any],
    executor: dict[str, Any] | None = None,
    input_values: list[str] | None = None,
) -> dict[str, Any]:
    executor = executor if isinstance(executor, dict) else {}
    atom = _normalize_atom(executor.get("atom") or executor.get("capabilityId") or executor.get("command"))
    status = cli_status()
    auth = _auth_for_atom(atom, status)
    config = _read_cli_config()
    inputs = [str(item).strip() for item in (input_values or []) if str(item).strip()]
    wait = _bool_value(executor.get("wait", False))
    timeout = int(executor.get("timeout") or 300)
    missing_inputs: list[str] = []
    args: list[str] = ["--json"]

    if atom == "generate-create":
        args.extend(["generate", "create"])
        slug = _string_value(
            executor.get("slug"),
            executor.get("slugId"),
            executor.get("slug_id"),
            os.environ.get("CANVASPRO_MYSHELL_ART_SLUG"),
            os.environ.get("MYSHELL_ART_CLI_CANVASPRO_SLUG"),
            os.environ.get("MYSHELL_ART_DEFAULT_SLUG"),
            _config_value(config, "canvaspro.slug", "canvaspro.slugId", "defaults.slug", "defaultSlug"),
        )
        bot_id = _string_value(
            executor.get("botId"),
            executor.get("bot_id"),
            os.environ.get("CANVASPRO_MYSHELL_ART_BOT_ID"),
            os.environ.get("MYSHELL_ART_CLI_CANVASPRO_BOT_ID"),
            os.environ.get("MYSHELL_ART_DEFAULT_BOT_ID"),
            _config_value(config, "canvaspro.botId", "canvaspro.bot_id", "defaults.botId", "defaultBotId"),
        )
        input_img = _string_value(executor.get("inputImg"), executor.get("input_img"), inputs[0] if inputs else "")
        article_id = _string_value(executor.get("articleId"), executor.get("article_id"))
        if slug:
            args.extend(["--slug", slug])
        elif bot_id:
            args.extend(["--bot-id", bot_id])
        else:
            missing_inputs.append("slug or botId")
        if input_img:
            args.extend(["--input-img", input_img])
        if article_id:
            args.extend(["--article-id", article_id])
        args.append("--wait" if wait else "--no-wait")
        args.extend(["--timeout", str(timeout)])
    elif atom == "upload-image":
        args.extend(["upload", "image"])
        file_path = _string_value(executor.get("file"), inputs[0] if inputs else "")
        if file_path:
            args.append(file_path)
        else:
            missing_inputs.append("file")
    elif atom == "energy-balance":
        args.extend(["energy", "balance"])
    else:
        atom = "dreamy-generate"
        args.extend(["dreamy", "generate"])
        slug_id = _string_value(
            executor.get("slugId"),
            executor.get("slug_id"),
            executor.get("slug"),
            os.environ.get("CANVASPRO_MYSHELL_ART_SLUG_ID"),
            os.environ.get("MYSHELL_ART_CLI_CANVASPRO_SLUG_ID"),
            os.environ.get("MYSHELL_ART_DEFAULT_SLUG_ID"),
            _config_value(config, "canvaspro.slugId", "canvaspro.slug_id", "dreamy.slugId", "defaultSlugId"),
        )
        bot_id = _string_value(
            executor.get("botId"),
            executor.get("bot_id"),
            os.environ.get("CANVASPRO_MYSHELL_ART_BOT_ID"),
            os.environ.get("MYSHELL_ART_CLI_CANVASPRO_BOT_ID"),
            os.environ.get("MYSHELL_ART_DEFAULT_BOT_ID"),
            _config_value(config, "canvaspro.botId", "canvaspro.bot_id", "dreamy.botId", "defaultBotId"),
        )
        if slug_id:
            args.extend(["--slug-id", slug_id])
        elif bot_id:
            args.extend(["--bot-id", bot_id])
        else:
            missing_inputs.append("slugId or botId")
        article_id = _string_value(executor.get("articleId"), executor.get("article_id"))
        button_id = _string_value(executor.get("buttonId"), executor.get("button_id"))
        if article_id:
            args.extend(["--article-id", article_id])
        if button_id:
            args.extend(["--button-id", button_id])
        for input_value in inputs:
            args.extend(["--input-img", input_value])
        if prompt:
            args.extend(["--prompt", prompt])
        customize_json = executor.get("customizeJson") or executor.get("customize_json")
        if isinstance(customize_json, dict):
            customization = customize_json
        elif isinstance(customize_json, str) and customize_json.strip():
            customization = customize_json.strip()
        else:
            customization = _settings_customization(kind, settings)
        if customization:
            args.extend(
                [
                    "--customize-json",
                    customization if isinstance(customization, str) else json.dumps(customization, ensure_ascii=False),
                ]
            )
        args.append("--wait" if wait else "--no-wait")
        args.extend(["--timeout", str(timeout)])
        poll_interval = int(executor.get("pollInterval") or executor.get("poll_interval") or 5)
        args.extend(["--poll-interval", str(poll_interval)])

    ready_for_execution = bool(status.get("ready")) and bool(auth.get("ready")) and not missing_inputs
    return {
        "provider": "myshell-art-cli",
        "capabilityId": f"myshell-art-cli.{atom}",
        "atom": atom,
        "mode": "dry-run",
        "cliStatus": status,
        "authStatus": auth,
        "readyForExecution": ready_for_execution,
        "missingInputs": missing_inputs,
        "commandPreview": _command_preview(args),
        "arguments": _redact_args(args),
    }


async def execute_canvaspro_task(
    *,
    kind: str,
    prompt: str,
    settings: dict[str, Any],
    executor: dict[str, Any] | None = None,
    input_values: list[str] | None = None,
) -> dict[str, Any]:
    plan = build_canvaspro_plan(
        kind=kind,
        prompt=prompt,
        settings=settings,
        executor=executor,
        input_values=input_values,
    )
    if not plan["cliStatus"].get("ready"):
        return {
            "status": "error",
            "message": str(plan["cliStatus"].get("message") or "MyShell Art CLI is not available."),
            "executor": plan,
        }
    if plan["missingInputs"]:
        return {
            "status": "ready",
            "message": f"MyShell Art CLI atom needs {', '.join(plan['missingInputs'])}.",
            "executor": plan,
        }
    if not plan["authStatus"].get("ready"):
        return {
            "status": "auth_missing",
            "message": "MyShell Art CLI credentials are not ready for this atom.",
            "executor": plan,
        }

    prefix, env, cwd = _cli_command_prefix()
    args = [*prefix, *plan["arguments"]]
    timeout = int((executor or {}).get("timeout") or 300)
    try:
        process = await asyncio.create_subprocess_exec(
            *args,
            cwd=cwd or None,
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout_bytes, stderr_bytes = await asyncio.wait_for(process.communicate(), timeout=timeout + 10)
    except asyncio.TimeoutError:
        return {"status": "timeout", "message": f"MyShell Art CLI timed out after {timeout}s.", "executor": plan}
    except OSError as exc:
        return {"status": "error", "message": str(exc), "executor": plan}

    stdout = stdout_bytes.decode("utf-8", errors="replace")
    stderr = stderr_bytes.decode("utf-8", errors="replace")
    raw = _parse_json_stdout(stdout)
    if process.returncode != 0:
        return {
            "status": _error_status(stdout, stderr),
            "message": _error_message(raw, stdout, stderr),
            "executor": {**plan, "mode": "execute", "returnCode": process.returncode},
            "raw": raw,
        }
    if isinstance(raw, dict) and raw.get("error"):
        return {
            "status": _error_status(str(raw.get("error")), stderr),
            "message": str(raw.get("error")),
            "executor": {**plan, "mode": "execute", "returnCode": process.returncode},
            "raw": raw,
        }

    media_url = _find_media_url(raw)
    task_id = _find_task_id(raw)
    status = "done" if media_url else "running" if task_id else "error"
    return {
        "status": status,
        "message": "MyShell Art CLI returned media." if media_url else "MyShell Art CLI task submitted." if task_id else "MyShell Art CLI did not return a task id or media URL.",
        "output_url": media_url,
        "task_id": task_id,
        "executor": {**plan, "mode": "execute", "returnCode": process.returncode},
        "raw": raw,
    }


async def fetch_canvaspro_task_result(
    *,
    task_id: str,
    kind: str = "image",
    executor: dict[str, Any] | None = None,
) -> dict[str, Any]:
    executor = executor if isinstance(executor, dict) else {}
    output_job_id = str(task_id or "").strip()
    atom = _normalize_atom(executor.get("atom") or executor.get("capabilityId") or executor.get("command"))
    status = cli_status()
    auth = _auth_for_atom(atom, status)
    if not output_job_id:
        return {
            "status": "ready",
            "message": "MyShell Art CLI result sync needs a task id.",
            "executor": {
                "provider": "myshell-art-cli",
                "capabilityId": f"myshell-art-cli.{atom}",
                "atom": atom,
                "mode": "result",
                "cliStatus": status,
                "authStatus": auth,
            },
        }
    if not status.get("ready"):
        return {
            "status": "error",
            "message": str(status.get("message") or "MyShell Art CLI is not available."),
            "task_id": output_job_id,
            "executor": {
                "provider": "myshell-art-cli",
                "capabilityId": f"myshell-art-cli.{atom}",
                "atom": atom,
                "mode": "result",
                "cliStatus": status,
                "authStatus": auth,
            },
        }
    if not auth.get("ready"):
        return {
            "status": "auth_missing",
            "message": "MyShell Art CLI credentials are not ready for result sync.",
            "task_id": output_job_id,
            "executor": {
                "provider": "myshell-art-cli",
                "capabilityId": f"myshell-art-cli.{atom}",
                "atom": atom,
                "mode": "result",
                "cliStatus": status,
                "authStatus": auth,
            },
        }

    prefix, env, cwd = _cli_command_prefix()
    result_args = ["--json"]
    if atom == "generate-create":
        result_args.extend(["generate", "result", output_job_id])
    else:
        atom = "dreamy-generate"
        result_args.extend(["dreamy", "result", output_job_id])
    timeout = int(executor.get("syncTimeout") or executor.get("timeout") or 60)
    try:
        process = await asyncio.create_subprocess_exec(
            *prefix,
            *result_args,
            cwd=cwd or None,
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout_bytes, stderr_bytes = await asyncio.wait_for(process.communicate(), timeout=timeout + 5)
    except asyncio.TimeoutError:
        return {
            "status": "timeout",
            "message": f"MyShell Art CLI result sync timed out after {timeout}s.",
            "task_id": output_job_id,
            "executor": {
                "provider": "myshell-art-cli",
                "capabilityId": f"myshell-art-cli.{atom}",
                "atom": atom,
                "mode": "result",
                "commandPreview": _command_preview(result_args),
            },
        }
    except OSError as exc:
        return {
            "status": "error",
            "message": str(exc),
            "task_id": output_job_id,
            "executor": {
                "provider": "myshell-art-cli",
                "capabilityId": f"myshell-art-cli.{atom}",
                "atom": atom,
                "mode": "result",
                "commandPreview": _command_preview(result_args),
            },
        }

    stdout = stdout_bytes.decode("utf-8", errors="replace")
    stderr = stderr_bytes.decode("utf-8", errors="replace")
    raw = _parse_json_stdout(stdout)
    executor_payload = {
        "provider": "myshell-art-cli",
        "capabilityId": f"myshell-art-cli.{atom}",
        "atom": atom,
        "mode": "result",
        "commandPreview": _command_preview(result_args),
        "returnCode": process.returncode,
    }
    if process.returncode != 0:
        return {
            "status": _error_status(stdout, stderr),
            "message": _error_message(raw, stdout, stderr),
            "task_id": output_job_id,
            "executor": executor_payload,
            "raw": raw,
        }

    media_url = _find_media_url(raw)
    result_status = _find_result_status(raw)
    if media_url:
        normalized_status = "done"
    elif result_status in {"done", "completed", "success"}:
        normalized_status = "done"
    elif result_status in {"failed", "error", "cancelled", "canceled"}:
        normalized_status = "error"
    else:
        normalized_status = "running"
    return {
        "status": normalized_status,
        "message": "MyShell Art CLI returned media." if media_url else "MyShell Art CLI result is still pending.",
        "output_url": media_url,
        "task_id": output_job_id,
        "executor": executor_payload,
        "raw": raw,
    }


def _parse_json_stdout(stdout: str) -> Any:
    text = stdout.strip()
    if not text:
        return {}
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    starts = [index for index in (text.find("{"), text.find("[")) if index >= 0]
    if not starts:
        return {}
    start = min(starts)
    for end in range(len(text), start, -1):
        try:
            return json.loads(text[start:end])
        except json.JSONDecodeError:
            continue
    return {}


def _error_status(stdout: str, stderr: str) -> str:
    text = f"{stdout}\n{stderr}".lower()
    if "init data" in text or "credential" in text or "auth" in text or "401" in text:
        return "auth_missing"
    if "timeout" in text:
        return "timeout"
    return "error"


def _error_message(raw: Any, stdout: str, stderr: str) -> str:
    if isinstance(raw, dict):
        message = raw.get("error") or raw.get("message") or raw.get("reason")
        if message:
            return str(message)
    return (stderr or stdout or "MyShell Art CLI command failed.").strip()[:500]


def _find_task_id(value: Any) -> str:
    if isinstance(value, dict):
        for key in ("outputJobId", "output_job_id", "taskId", "task_id", "jobId", "job_id", "id"):
            if value.get(key):
                return str(value[key])
        for item in value.values():
            found = _find_task_id(item)
            if found:
                return found
    elif isinstance(value, list):
        for item in value:
            found = _find_task_id(item)
            if found:
                return found
    return ""


def _find_result_status(value: Any) -> str:
    if isinstance(value, dict):
        for key in ("status", "state", "taskStatus", "task_status"):
            if value.get(key):
                return str(value[key]).strip().lower()
        for item in value.values():
            found = _find_result_status(item)
            if found:
                return found
    elif isinstance(value, list):
        for item in value:
            found = _find_result_status(item)
            if found:
                return found
    return ""


def _find_media_url(value: Any) -> str:
    keys = {
        "mediaUrl",
        "media_url",
        "resultUrls",
        "result_urls",
        "resultUrl",
        "result_url",
        "outputImg",
        "output_img",
        "outputVideo",
        "output_video",
        "outputPreview",
        "output_preview",
        "imageUrl",
        "image_url",
        "videoUrl",
        "video_url",
        "url",
    }
    if isinstance(value, str):
        text = value.strip()
        if text.startswith(("http://", "https://")):
            return text
        try:
            return _find_media_url(json.loads(text))
        except json.JSONDecodeError:
            return ""
    if isinstance(value, dict):
        for key in keys:
            found_value = value.get(key)
            if isinstance(found_value, list):
                for item in found_value:
                    found = _find_media_url(item)
                    if found:
                        return found
            elif found_value:
                found = _find_media_url(found_value)
                if found:
                    return found
        for item in value.values():
            found = _find_media_url(item)
            if found:
                return found
    elif isinstance(value, list):
        for item in value:
            found = _find_media_url(item)
            if found:
                return found
    return ""
