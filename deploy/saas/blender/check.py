"""The Blender workstation image's own check (Dockerfile, last step; also `docker run ... python3 -I -S
/opt/awwo/blender/check.py`): starts Blender as the supervisor does, waits for the MCP add-on's bridge, then makes the
worker's two calls through mcp_call.py (the tool list, and one execute_blender_code that imports awwo_param and builds a
mesh) and prints one JSON line. Exit 0 only when every step answered as expected. Needs no GPU."""
import importlib.util
import json
import os
import signal
import socket
import subprocess
import sys
import time

spec = importlib.util.spec_from_file_location('supervisor', '/opt/awwo/blender/supervisor.py')
supervisor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(supervisor)
CODE = """
import bpy, awwo_param
mesh = bpy.data.meshes.new('check')
mesh.from_pydata([(0, 0, 0), (1, 0, 0), (0, 1, 0)], [], [(0, 1, 2)])
result = {'blender': bpy.app.version_string, 'awwo_param': awwo_param.__version__, 'faces': len(mesh.polygons)}
"""


def wait_for_bridge(deadline):
    while time.monotonic() < deadline:
        try:
            with socket.create_connection(('127.0.0.1', 9876), timeout=1):
                return True
        except OSError:
            time.sleep(0.25)
    return False


def mcp(request):
    done = subprocess.run(['python3', '-I', '-S', '/opt/awwo/blender/mcp_call.py'], input=json.dumps(request).encode(),
                          capture_output=True, timeout=120, check=False)
    return json.loads(done.stdout.decode() or '{}')


def main():
    facts = {}
    os.makedirs('/workspace', exist_ok=True)
    blender = subprocess.Popen(supervisor.COMMAND, cwd='/tmp', stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL, env=supervisor.environment(), start_new_session=True)
    try:
        with open('/tmp/awwo-blender.pid', 'w', encoding='ascii') as handle:
            handle.write(str(blender.pid))
        facts['bridge'] = wait_for_bridge(time.monotonic() + 90)
        listed = mcp({'op': 'list'})
        facts['server'] = listed.get('server', {}).get('name')
        facts['tools'] = len(listed.get('tools', []))
        facts['instructions'] = len(listed.get('instructions', ''))
        called = mcp({'op': 'call', 'name': 'execute_blender_code', 'arguments': {'code': CODE}, 'timeoutSeconds': 60})
        text = ''.join(part.get('text', '') for part in called.get('content', []))
        facts['call'] = json.loads(text) if text.startswith('{') else (text or called)
    finally:
        os.killpg(blender.pid, signal.SIGKILL)
        blender.wait()
    call = facts.get('call') if isinstance(facts.get('call'), dict) else {}
    ok = (facts.get('bridge') is True and facts.get('server') == 'blender-mcp' and facts.get('tools', 0) >= 20
          and facts.get('instructions', 0) > 500 and call.get('status') == 'ok' and call.get('result', {}).get('faces') == 1)
    print(json.dumps({'ok': ok, **facts}))
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
