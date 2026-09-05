from __future__ import annotations

import json
import os
from typing import Any


DREAMY_API_PREFIX = "/v1/telegram/miniapp/dreamy"
DREAMYPORN_WEB_GENERATE_PREFIX = "/v1/homepage/porn"
DREAMYPORN_UPLOAD_PREFIX = "/v1/resource"


def env_int(name: str, default: int, *, minimum: int = 1, maximum: int = 100) -> int:
    try:
        value = int(os.environ.get(name) or default)
    except ValueError:
        return default
    return max(minimum, min(value, maximum))


def env_float(name: str, default: float, *, minimum: float = 0.0, maximum: float = 60.0) -> float:
    try:
        value = float(os.environ.get(name) or default)
    except ValueError:
        return default
    return max(minimum, min(value, maximum))


def json_object(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def dreamyporn_web_task_media(result: dict[str, Any], output_job_id: str) -> dict[str, str]:
    tasks = result.get("tasks") if isinstance(result.get("tasks"), list) else []
    task = next(
        (
            candidate
            for candidate in tasks
            if isinstance(candidate, dict)
            and str(candidate.get("jobId") or candidate.get("job_id") or candidate.get("taskId") or "") == output_job_id
        ),
        {},
    )
    parsed_result = json_object(task.get("result"))
    media_url = (
        parsed_result.get("outputImg")
        or parsed_result.get("output_img")
        or parsed_result.get("outputPreview")
        or parsed_result.get("output_preview")
        or ""
    )
    poster_url = parsed_result.get("outputPoster") or parsed_result.get("output_poster") or parsed_result.get("outputPreview") or media_url or ""
    task_status = str(task.get("status") or result.get("status") or "running")
    queue_position = str(task.get("queuePosition") or task.get("queue_position") or "")
    return {
        "status": task_status,
        "taskId": output_job_id,
        "mediaUrl": str(media_url or ""),
        "posterUrl": str(poster_url or ""),
        "queuePosition": queue_position,
    }


def dreamy_task_media(result: dict[str, Any], output_job_id: str = "") -> dict[str, str]:
    tasks = result.get("tasks") if isinstance(result.get("tasks"), list) else []
    task = tasks[0] if tasks and isinstance(tasks[0], dict) else {}
    parsed_result = json_object(task.get("result"))
    media_url = (
        parsed_result.get("outputImg")
        or parsed_result.get("output_img")
        or parsed_result.get("outputPreview")
        or parsed_result.get("output_preview")
        or parsed_result.get("mediaUrl")
        or parsed_result.get("media_url")
        or parsed_result.get("url")
        or ""
    )
    poster_url = (
        parsed_result.get("outputPoster")
        or parsed_result.get("output_poster")
        or parsed_result.get("outputPreview")
        or parsed_result.get("output_preview")
        or media_url
        or ""
    )
    return {
        "status": str(task.get("status") or result.get("status") or ""),
        "taskId": str(task.get("jobId") or task.get("taskId") or output_job_id or ""),
        "mediaUrl": str(media_url or ""),
        "posterUrl": str(poster_url or ""),
    }
