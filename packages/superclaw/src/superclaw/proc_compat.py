"""Cross-platform process liveness + termination.

POSIX probes a pid with ``os.kill(pid, 0)`` (no signal delivered) and stops a
process with ``SIGTERM`` / ``SIGKILL``. On Windows ``os.kill(pid, sig)`` calls
``TerminateProcess`` for ANY signal value — *including 0* — so the idiomatic
POSIX ``os.kill(pid, 0)`` liveness probe would KILL the very process it means to
check (silently corrupting lease-liveness and ``daemon status``). These helpers
branch per platform: ``ctypes`` ``OpenProcess`` / ``GetExitCodeProcess`` to probe
and ``taskkill`` to stop on Windows; the native ``os.kill`` path on POSIX.
"""

from __future__ import annotations

import os
import signal

__all__ = ["pid_is_alive", "terminate_pid"]


def pid_is_alive(pid: int | None) -> bool:
    """True if a process with ``pid`` currently exists.

    NEVER use ``os.kill(pid, 0)`` directly for this — see the module docstring:
    on Windows that terminates the process. This helper is the safe replacement.
    """
    if not pid or pid <= 0:
        return False
    if os.name == "nt":
        return _win_pid_is_alive(pid)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        # Exists but owned by another user / not signalable — still alive.
        return True
    except OSError:
        return False
    return True


def _win_pid_is_alive(pid: int) -> bool:
    import ctypes
    from ctypes import wintypes

    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    STILL_ACTIVE = 259
    ERROR_ACCESS_DENIED = 5

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid))
    if not handle:
        # Access-denied means the process exists but we lack rights → treat as
        # alive. Any other error (invalid parameter for a recycled/absent pid)
        # means it is gone.
        return ctypes.get_last_error() == ERROR_ACCESS_DENIED
    try:
        code = wintypes.DWORD()
        kernel32.GetExitCodeProcess.restype = wintypes.BOOL
        kernel32.GetExitCodeProcess.argtypes = (
            wintypes.HANDLE,
            ctypes.POINTER(wintypes.DWORD),
        )
        if kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
            return code.value == STILL_ACTIVE
        return True
    finally:
        kernel32.CloseHandle(handle)


def terminate_pid(pid: int, *, force: bool = False, tree: bool = False) -> None:
    """Best-effort stop a process.

    POSIX: ``SIGKILL`` when ``force`` else ``SIGTERM`` (raises ``OSError`` if the
    process is already gone, mirroring ``os.kill``). Windows: ``taskkill`` with
    ``/F`` when ``force`` and ``/T`` when ``tree``; a missing process is swallowed
    (taskkill returns non-zero, which we do not raise on).
    """
    if not pid or pid <= 0:
        return
    if os.name == "nt":
        import subprocess

        args = ["taskkill", "/PID", str(int(pid))]
        if tree:
            args.append("/T")
        if force:
            args.append("/F")
        subprocess.run(args, capture_output=True, check=False)
        return
    os.kill(pid, signal.SIGKILL if force else signal.SIGTERM)
