from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlsplit

import httpx

from studio_app.infrastructure.storage import media


def format_exception_message(exc: Exception) -> str:
    message = str(exc).strip()
    return message or exc.__class__.__name__


def download_timeline_media(
    media_url: str,
    output_path: Path,
    *,
    exception_message: Callable[[Exception], str] = format_exception_message,
) -> None:
    headers = {
        "User-Agent": "MyShell-Studio-Timeline-Export/1.0",
        "Accept": "video/mp4,video/*,*/*",
    }
    try:
        with httpx.stream("GET", media_url, headers=headers, follow_redirects=True, timeout=90.0) as response:
            response.raise_for_status()
            with output_path.open("wb") as media_file:
                for chunk in response.iter_bytes():
                    if chunk:
                        media_file.write(chunk)
    except httpx.HTTPError as exc:
        raise RuntimeError(f"failed to download timeline media: {exception_message(exc)}") from exc
    if not output_path.exists() or output_path.stat().st_size <= 0:
        raise RuntimeError("downloaded timeline media was empty")


def prepare_timeline_video_input(media_url: str, target_dir: Path, index: int) -> Path:
    generated_path = media.resolve_generated_media_path(media_url)
    suffix = Path(urlsplit(media_url).path).suffix or ".mp4"
    output_path = target_dir / f"segment-{index:03d}{suffix}"
    if generated_path:
        shutil.copyfile(generated_path, output_path)
        return output_path
    if media_url.startswith("http://") or media_url.startswith("https://"):
        download_timeline_media(media_url, output_path)
        return output_path
    raise ValueError(f"Unsupported timeline media URL: {media_url}")


def even_video_dimension(value: int) -> int:
    return max(2, int(value) - (int(value) % 2))


def probe_video_dimensions(video_path: Path) -> tuple[int, int] | None:
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        return None
    command = [
        ffprobe,
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height",
        "-of",
        "json",
        str(video_path),
    ]
    result = subprocess.run(command, capture_output=True, text=True, timeout=30)
    if result.returncode != 0:
        return None
    try:
        streams = json.loads(result.stdout or "{}").get("streams") or []
    except json.JSONDecodeError:
        return None
    for stream in streams:
        width = int(stream.get("width") or 0)
        height = int(stream.get("height") or 0)
        if width > 0 and height > 0:
            return even_video_dimension(width), even_video_dimension(height)
    return None


def normalize_timeline_video_inputs(ffmpeg: str, input_paths: list[Path], target_dir: Path) -> list[Path]:
    target_width, target_height = probe_video_dimensions(input_paths[0]) or (1080, 1920)
    normalized_paths: list[Path] = []
    for index, input_path in enumerate(input_paths, start=1):
        output_path = target_dir / f"normalized-{index:03d}.mp4"
        normalize_command = [
            ffmpeg,
            "-y",
            "-i",
            str(input_path),
            "-vf",
            (
                f"scale={target_width}:{target_height}:force_original_aspect_ratio=decrease,"
                f"pad={target_width}:{target_height}:(ow-iw)/2:(oh-ih)/2:color=black,"
                "setsar=1"
            ),
            "-an",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-pix_fmt",
            "yuv420p",
            str(output_path),
        ]
        result = subprocess.run(normalize_command, capture_output=True, text=True, timeout=180)
        if result.returncode != 0:
            raise RuntimeError(f"FFmpeg normalize failed for segment {index}: {(result.stderr or '').strip()[-1200:]}")
        normalized_paths.append(output_path)
    return normalized_paths


def compose_timeline_video(export_id: str, video_segments: list[dict[str, Any]]) -> dict[str, Any]:
    if not video_segments:
        return {"status": "needs_media", "message": "No video segments are ready to compose."}
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return {"status": "manifest_ready", "message": "FFmpeg is not available; timeline manifest is ready."}

    output_root = media.generated_media_root() / "studio-exports"
    output_root.mkdir(parents=True, exist_ok=True)
    output_path = output_root / f"{export_id}.mp4"
    with tempfile.TemporaryDirectory(prefix=f"{export_id}-") as temp_name:
        temp_dir = Path(temp_name)
        input_paths: list[Path] = []
        for index, segment in enumerate(video_segments, start=1):
            input_paths.append(prepare_timeline_video_input(str(segment.get("mediaUrl") or ""), temp_dir, index))
        if len(input_paths) == 1:
            shutil.copyfile(input_paths[0], output_path)
            return {
                "status": "ready",
                "mediaUrl": f"/generated/studio-exports/{output_path.name}",
                "message": "Composed 1 video segment.",
            }
        concat_path = temp_dir / "concat.txt"
        normalized_paths = normalize_timeline_video_inputs(ffmpeg, input_paths, temp_dir)
        concat_path.write_text(
            "\n".join(f"file '{path.as_posix()}'" for path in normalized_paths) + "\n",
            encoding="utf-8",
        )
        copy_command = [ffmpeg, "-y", "-f", "concat", "-safe", "0", "-i", str(concat_path), "-c", "copy", str(output_path)]
        copy_result = subprocess.run(copy_command, capture_output=True, text=True, timeout=180)
        if copy_result.returncode != 0:
            encode_command = [
                ffmpeg,
                "-y",
                "-f",
                "concat",
                "-safe",
                "0",
                "-i",
                str(concat_path),
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-pix_fmt",
                "yuv420p",
                "-an",
                str(output_path),
            ]
            encode_result = subprocess.run(encode_command, capture_output=True, text=True, timeout=240)
            if encode_result.returncode != 0:
                raise RuntimeError((encode_result.stderr or copy_result.stderr or "FFmpeg compose failed").strip()[-1200:])

    return {
        "status": "ready",
        "mediaUrl": f"/generated/studio-exports/{output_path.name}",
        "message": f"Composed {len(video_segments)} video segment{'' if len(video_segments) == 1 else 's'} with aspect-safe padding.",
    }
