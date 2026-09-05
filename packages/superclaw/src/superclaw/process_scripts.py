from __future__ import annotations

import os
import shlex
import shutil
import sys
from pathlib import Path
from typing import Iterable


def command_for_script(path: Path, args: Iterable[str] = ()) -> list[str]:
    """Return a subprocess argv that can launch a package-local script.

    POSIX systems can execute shebang scripts directly. Windows cannot execute
    extensionless shell/Python scripts through CreateProcess, so we resolve the
    shebang interpreter explicitly while keeping the script path as an argument.
    """
    script = Path(path)
    tail = [str(arg) for arg in args]
    if os.name != "nt":
        return [str(script), *tail]
    interpreter = _windows_shebang_interpreter(script)
    if interpreter is None:
        return [str(script), *tail]
    return [*interpreter, str(script), *tail]


def script_is_runnable(path: Path) -> bool:
    if os.name != "nt":
        return (Path(path).stat().st_mode & 0o111) != 0
    return _windows_shebang_interpreter(Path(path)) is not None


def _windows_shebang_interpreter(path: Path) -> list[str] | None:
    try:
        first_line = path.read_text(encoding="utf-8", errors="replace").splitlines()[0]
    except (OSError, IndexError):
        return None
    if not first_line.startswith("#!"):
        return None
    try:
        parts = shlex.split(first_line[2:].strip())
    except ValueError:
        return None
    if not parts:
        return None
    executable = parts[0]
    interpreter_args = parts[1:]
    if Path(executable).name == "env" and interpreter_args:
        executable = interpreter_args[0]
        interpreter_args = interpreter_args[1:]
    name = Path(executable).name.lower()
    resolved: str | None
    if name in {"python", "python3", "python.exe", "python3.exe"}:
        resolved = sys.executable
    elif name in {"sh", "sh.exe", "bash", "bash.exe"}:
        resolved = shutil.which(name) or shutil.which("sh") or shutil.which("bash")
    else:
        resolved = shutil.which(name) or shutil.which(executable)
    if not resolved:
        return None
    return [resolved, *interpreter_args]
