"""Run by Blender (`--python`) in a Blender workstation container before the MCP bridge starts (supervisor.py): Cycles
renders on the container's GPU when it has one (OptiX, else CUDA, else the CPU), as preferences every scene of the run
uses, and /tmp/awwo-gpu.json says which, and whether EEVEE has the GPU too (the agent's instructions say both).
Nothing here touches the network."""
import json
import os

import bpy


def choose_device():
    preferences = bpy.context.preferences.addons['cycles'].preferences
    for kind in ('OPTIX', 'CUDA'):
        try:
            preferences.compute_device_type = kind
        except TypeError:
            continue
        preferences.refresh_devices()
        devices = [device for device in preferences.devices if device.type == kind]
        if devices:
            for device in preferences.devices:
                device.use = device.type == kind
            return {'device': 'GPU', 'backend': kind, 'names': [device.name for device in devices]}
    preferences.compute_device_type = 'NONE'
    return {'device': 'CPU', 'backend': 'NONE', 'names': []}


def main():
    try:
        chosen = choose_device()
    except Exception as error:  # noqa: BLE001 - a CPU render is still a render
        chosen = {'device': 'CPU', 'backend': 'NONE', 'names': [], 'error': str(error)[:200]}
    # EEVEE draws with OpenGL through EGL: on the NVIDIA driver's EGL where the container has it (NVIDIA's container
    # toolkit with the graphics capability), else on Mesa's software renderer, which is many times slower.
    chosen['eevee'] = 'gpu' if os.path.exists('/usr/share/glvnd/egl_vendor.d/10_nvidia.json') else 'software'
    scene = bpy.context.scene
    if scene is not None:
        scene.cycles.device = chosen['device']
    with open('/tmp/awwo-gpu.json', 'w', encoding='utf-8') as handle:
        json.dump(chosen, handle)


main()
