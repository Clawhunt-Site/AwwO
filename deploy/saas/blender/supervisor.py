"""PID 1 of a Blender workstation container (README.md): keeps one Blender running as the Blender Lab MCP add-on's
background bridge (`blender --background ... --command blender_mcp`, listening on 127.0.0.1:9876 inside the container,
which has no network), starts it again when it exits (an agent's code can crash or hang Blender: the scene is lost, the
workspace's files stay), and reaps every process that ends up in its care.

Blender's environment carries AWWO_KEEP_ALIVE=blender-bridge: the sandbox's command helper stops every process a command
leaves behind, except those (apps/openai-agents-worker/workspace-sandbox.ts COMMAND_HELPER, keepAlive). Its pid is in
/tmp/awwo-blender.pid, its output in /tmp/blender.log (cut when it grows past 4 MiB). Run as python3 -I -S."""
import os
import signal
import subprocess
import sys
import time

BLENDER = '/opt/blender/blender'
COMMAND = [BLENDER, '--background', '--factory-startup', '--online-mode', '--addons', 'bl_ext.user_default.mcp',
           '/opt/awwo/blender/empty.blend', '--python', '/opt/awwo/blender/startup.py',
           '--command', 'blender_mcp', '--host', '127.0.0.1', '--port', '9876']
PID_FILE = '/tmp/awwo-blender.pid'
LOG_FILE = '/tmp/blender.log'
LOG_LIMIT = 4 << 20
# A Blender that keeps failing at once is not started again forever: after this many starts within a minute the
# supervisor waits a minute before the next one.
BURST = 5
# Blender and the libraries it loads write per-user state into HOME as soon as it starts: PulseAudio's runtime link
# under .config/pulse, the NVIDIA driver's compute cache under .nv, thumbnails under .cache. That state goes in /tmp,
# not the workspace (the commands' HOME): it would clutter the workspace's file list, and its snapshot refuses links.
BLENDER_HOME = '/tmp/blender-home'


def environment():
    keep = ('PATH', 'LANG', 'BLENDER_USER_RESOURCES', 'NVIDIA_DRIVER_CAPABILITIES', 'NVIDIA_VISIBLE_DEVICES')
    env = {key: os.environ[key] for key in keep if key in os.environ}
    env.setdefault('PATH', '/usr/local/bin:/usr/bin:/bin')
    env.setdefault('LANG', 'C.UTF-8')
    os.makedirs(BLENDER_HOME, mode=0o700, exist_ok=True)
    env['HOME'] = BLENDER_HOME
    env['AWWO_KEEP_ALIVE'] = 'blender-bridge'
    return env


def start():
    log = open(LOG_FILE, 'ab', buffering=0)
    try:
        child = subprocess.Popen(COMMAND, cwd='/workspace', stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                                 env=environment(), start_new_session=True)
    finally:
        log.close()
    with open(PID_FILE + '.tmp', 'w') as handle:
        handle.write(str(child.pid))
    os.replace(PID_FILE + '.tmp', PID_FILE)
    return child.pid


def trim_log():
    try:
        if os.path.getsize(LOG_FILE) > LOG_LIMIT:
            with open(LOG_FILE, 'r+b') as handle:
                handle.seek(-LOG_LIMIT // 2, os.SEEK_END)
                tail = handle.read()
                handle.seek(0)
                handle.write(b'[... earlier output cut ...]\n' + tail)
                handle.truncate()
    except OSError:
        pass


def reap(blender):
    """Reaps every child that has exited; returns Blender's pid while it runs, else None."""
    while True:
        try:
            pid, _status = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return None
        if pid == 0:
            return blender
        if pid == blender:
            blender = None


def main():
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    starts = []
    blender = None
    while True:
        blender = reap(blender)
        if blender is None:
            now = time.monotonic()
            starts = [moment for moment in starts if now - moment < 60]
            if len(starts) < BURST:
                blender = start()
                starts.append(now)
        trim_log()
        time.sleep(0.5)


if __name__ == '__main__':
    main()
