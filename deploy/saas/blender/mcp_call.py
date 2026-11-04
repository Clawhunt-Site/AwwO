"""One call to the official Blender MCP server inside a Blender workstation container (README.md), made by the worker
with `docker exec -i --user 1000:1000 <container> python3 -I -S /opt/awwo/blender/mcp_call.py`.

stdin: one JSON object, {"op": "list"} or {"op": "call", "name": <tool>, "arguments": {...}, "timeoutSeconds": n}.
It starts the MCP server (blmcp, stdio), speaks MCP to it (initialize, notifications/initialized, then tools/list or
tools/call), stops it, and prints one JSON line: {"ok": true, "instructions", "tools", "gpu"} for a list, {"ok": true,
"content", "isError"} for a call, or {"ok": false, "error"} when the server or Blender failed; each with "before" and
"after", the Blender running when the request came and when it was answered, and "restarted". A call that outlives its
time is stopped and Blender is started again by the supervisor (an endless loop in agent code would otherwise hold the
bridge for good); "restarted": true says the scene is gone."""
import json
import os
import selectors
import signal
import socket
import subprocess
import sys
import time

SERVER = ['/opt/blmcp/bin/python', '-I', '-m', 'blmcp']
ENV = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': '/workspace', 'LANG': 'C.UTF-8', 'BLENDER_MCP_HOST': '127.0.0.1',
       'BLENDER_MCP_PORT': '9876', 'BLENDER_PATH': '/opt/blender/blender'}
LINE_LIMIT = 8 << 20
# What one answer prints at most: the worker reads 4 MiB of it (BLENDER_MCP_OUTPUT_BYTES), and ensure_ascii writes a
# character as up to six bytes.
TEXT_LIMIT = 256 << 10
PROTOCOL = '2025-06-18'
# The supervisor's record of the Blender it runs, and where its process is described.
PID_FILE = '/tmp/awwo-blender.pid'
PROC = '/proc'


def gpu():
    """What startup.py found of the GPU (Cycles' device, EEVEE's), or None before Blender wrote it."""
    try:
        with open('/tmp/awwo-gpu.json', encoding='utf-8') as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return None


def bounded(content):
    """An answer's text parts, cut to TEXT_LIMIT characters in all; any other part is named, not kept."""
    out, used = [], 0
    for part in content if isinstance(content, list) else []:
        if isinstance(part, dict) and part.get('type') == 'text' and isinstance(part.get('text'), str):
            text = part['text'][:max(0, TEXT_LIMIT - used)]
            if len(text) < len(part['text']):
                text += '\n[... cut: the answer was longer than %d characters; return less from your code.]' % TEXT_LIMIT
            used += len(text)
            out.append({'type': 'text', 'text': text})
        else:
            out.append({'type': str(part.get('type', 'other')) if isinstance(part, dict) else 'other'})
    return out


def wait_for_bridge(deadline):
    """Blender's bridge accepting connections again, after a start (the supervisor starts a stopped Blender within a
    second, and Blender opens its bridge a second later): up to the deadline."""
    while time.monotonic() < deadline:
        try:
            socket.create_connection(('127.0.0.1', 9876), timeout=1).close()
            return True
        except OSError:
            time.sleep(0.25)
    return False


def bridge():
    """The Blender the supervisor runs now (its pid file), as "<pid>:<start time>" (/proc/<pid>/stat), or None when
    none runs or it has exited (a zombie the supervisor has yet to reap), so that a Blender started again, even under
    a reused pid, is never taken for the one before it."""
    try:
        with open(PID_FILE, encoding='ascii') as handle:
            pid = int(handle.read().strip())
        with open('%s/%d/stat' % (PROC, pid), encoding='ascii', errors='replace') as handle:
            # After the command name: the state (the stat's third field), ..., the start time (its 22nd).
            fields = handle.read().rsplit(')', 1)[1].split()
    except (OSError, ValueError, IndexError):
        return None
    if len(fields) < 20 or fields[0] in ('Z', 'X'):
        return None
    return '%d:%s' % (pid, fields[19])


def restart_blender():
    """Stops Blender's whole process group; the supervisor starts a new one with an empty scene."""
    try:
        with open(PID_FILE, encoding='ascii') as handle:
            os.killpg(int(handle.read().strip()), signal.SIGKILL)
        return True
    except (OSError, ValueError):
        return False


class Server:
    def __init__(self, deadline):
        self.deadline = deadline
        self.process = subprocess.Popen(SERVER, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                        cwd='/workspace', env=ENV, start_new_session=True)
        self.buffer = b''
        self.selector = selectors.DefaultSelector()
        self.selector.register(self.process.stdout, selectors.EVENT_READ)

    def send(self, message):
        self.process.stdin.write((json.dumps(message) + '\n').encode())
        self.process.stdin.flush()

    def answer(self, request_id):
        """The response to request_id; notifications and other messages from the server are skipped."""
        while True:
            while b'\n' in self.buffer:
                line, self.buffer = self.buffer.split(b'\n', 1)
                if line.strip():
                    message = json.loads(line)
                    if message.get('id') == request_id and ('result' in message or 'error' in message):
                        return message
            remaining = self.deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError()
            if not self.selector.select(min(remaining, 1.0)):
                continue
            chunk = os.read(self.process.stdout.fileno(), 65536)
            if not chunk:
                raise EOFError()
            self.buffer += chunk
            if len(self.buffer) > LINE_LIMIT:
                raise ValueError('answer too large')

    def request(self, request_id, method, params=None):
        self.send({'jsonrpc': '2.0', 'id': request_id, 'method': method, **({'params': params} if params is not None else {})})
        message = self.answer(request_id)
        if 'error' in message:
            raise RuntimeError(str(message['error'].get('message', 'error'))[:500])
        return message['result']

    def close(self):
        try:
            self.process.stdin.close()
        except OSError:
            pass
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(self.process.pid, signal.SIGKILL)
            self.process.wait()


def main():
    request = json.load(sys.stdin)
    # Below the server's own 300 s wait for Blender (blmcp connection.py), so that a call stuck in Blender ends here, where
    # Blender is started again, rather than there, where it would stay stuck for the next call.
    seconds = request.get('timeoutSeconds', 280)
    if not isinstance(seconds, (int, float)) or not 1 <= seconds <= 290:
        seconds = 280
    deadline = time.monotonic() + seconds
    # A call right after Blender was started again (a crash, or the last call's time) waits for its bridge rather than
    # failing on a refused connection.
    if request.get('op') == 'call':
        wait_for_bridge(min(deadline, time.monotonic() + 30))
    # The Blender that took the call, and the one running once it is answered: when they differ (the agent's code stopped
    # or crashed it), the answer says the scene is gone, which the server's own error does not. The worker compares
    # "before" with the last answer's "after", for a Blender that stopped in between.
    before = bridge()
    stopped = False
    server = Server(deadline)
    try:
        init = server.request(1, 'initialize', {'protocolVersion': PROTOCOL, 'capabilities': {},
                                                'clientInfo': {'name': 'awwo-blender-workstation', 'version': '1'}})
        server.send({'jsonrpc': '2.0', 'method': 'notifications/initialized'})
        if request.get('op') == 'list':
            tools = server.request(2, 'tools/list')['tools']
            out = {'ok': True, 'instructions': init.get('instructions', ''), 'server': init.get('serverInfo', {}), 'tools': tools, 'gpu': gpu()}
        elif request.get('op') == 'call' and isinstance(request.get('name'), str) and isinstance(request.get('arguments'), dict):
            result = server.request(2, 'tools/call', {'name': request['name'], 'arguments': request['arguments']})
            out = {'ok': True, 'content': bounded(result.get('content', [])), 'isError': bool(result.get('isError'))}
        else:
            out = {'ok': False, 'error': 'invalid request'}
    except TimeoutError:
        stopped = restart_blender()
        out = {'ok': False, 'error': 'timeout'}
    except (EOFError, ValueError, RuntimeError, OSError) as error:
        out = {'ok': False, 'error': type(error).__name__ + ': ' + str(error)[:500]}
    finally:
        server.close()
    after = bridge()
    out.update(before=before, after=after, restarted=stopped or (before is not None and after != before))
    print(json.dumps(out, ensure_ascii=True, separators=(',', ':')))


if __name__ == '__main__':
    main()
