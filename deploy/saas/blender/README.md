# Blender workstation image

The image the Blender workstation runs in: the `blender` runtime, a sandbox computer with Blender in it
(`apps/openai-agents-worker/workspace-blender.ts`, `backend/internal/app/runtime_workers.go` `runtimeBlender`). An
Agent node on it gets everything a sandbox node has (its project files, a shell, its tests, publishing) and the tools of
the official Blender MCP server besides, which reach a live Blender 5.2.3 in the same container. It is built `FROM` the
workspace image (`deploy/saas/workspace`), so `awwo-check-page` and the rest are there too.

## What it adds to the workspace image

| Component | Version | From | License | Path |
| --- | --- | --- | --- | --- |
| Blender | 5.2.3 LTS (hash e13b728c6880) | `blender-5.2.3-linux-x64.tar.xz` from download.blender.org, sha256 `78486c01…a4` as blender.org publishes it | GPL-3.0-or-later (its bundled libraries under their own licenses, in the tarball's `license/`) | `/opt/blender` |
| Blender MCP server (`blmcp`) | 1.0.3 (tag `v1.0.3`, commit `2cea8d56`) | `blender-1.0.3.mcpb` from projects.blender.org/lab/blender_mcp releases, sha256 `d6fe04dd…7e` | GPL-3.0-or-later | `/opt/blmcp` (a venv) |
| Blender MCP add-on | 1.0.3 | `mcp-1.0.3.zip` from the same release, sha256 `a7a9da81…07` | GPL-3.0-or-later | `/opt/awwo/blender/user/extensions/user_default/mcp` |
| The server's Python packages | `requirements.lock` (mcp 1.30.0 and its 37 dependencies, each hash-pinned) | PyPI wheels | MIT, BSD, Apache-2.0 (each package's own) | `/opt/blmcp/lib/python3.11/site-packages` |
| awwo_param | this repository | `awwo_param/` | MIT (AwwO's) | Blender's own site-packages |
| X11 client libraries, GL loaders, Mesa | Debian 12 | apt | their own | |

None of the upstream files is kept in this repository. `fetch-sources.sh <dir>` downloads the three and checks their
hashes; the Dockerfile checks them again. Blender, the server and the add-on run unmodified as separate programs: AwwO
speaks MCP to the server over stdio and the server speaks to the add-on over its loopback socket.

## Build

```
deploy/saas/blender/fetch-sources.sh <sources dir>
docker build --build-context sources=<sources dir> --build-arg BASE=awwo-workspace:<tag> -t awwo-blender:<tag> deploy/saas/blender
```

The last build step runs `check.py`: Blender starts as the supervisor starts it, its bridge answers, the MCP server
lists its tools (26) through `mcp_call.py`, and one `execute_blender_code` imports awwo_param and builds a mesh. It needs
no GPU. On a GPU host, `docker run --gpus all … python3 -I -S /opt/awwo/blender/check.py` checks the same there.

## How a run uses it

- **PID 1** is `supervisor.py`: it keeps one Blender running as the add-on's background bridge (`blender --background
  --factory-startup --addons bl_ext.user_default.mcp /opt/awwo/blender/empty.blend --python startup.py --command
  blender_mcp --host 127.0.0.1 --port 9876`), starts it again when it exits (an agent's code can crash or hang it; the
  scene is lost, the files stay), and reaps every orphan. Blender's environment carries `AWWO_KEEP_ALIVE=blender-bridge`,
  so that the sandbox's command helper, which stops whatever a command leaves running, spares it, and its own HOME,
  `/tmp/blender-home`: Blender and its libraries write per-user state there from the start (PulseAudio's runtime link,
  the NVIDIA driver's cache, thumbnails), which would otherwise land in the workspace, the commands' HOME.
- **`startup.py`** sets Cycles to the container's GPU (OptiX, else CUDA, else the CPU) and writes what it found, and
  whether EEVEE has the GPU (the NVIDIA EGL vendor file) or Mesa's software renderer, to `/tmp/awwo-gpu.json`.
- **`mcp_call.py`** is the worker's one way in: `docker exec -i --user 1000:1000 <container> python3 -I -S
  /opt/awwo/blender/mcp_call.py`, a JSON request on stdin (`{"op": "list"}` or a tool call), the MCP server started on
  stdio for that one call, one JSON line out. A call that outlives its time (280 s by default, below the server's own
  300 s wait for Blender) is stopped and Blender is started again, so an endless loop in agent code cannot hold the
  bridge for good.
- **Tools offered** (the worker's allow-list, `BLENDER_TOOL_NAMES`): the ones that work without a window:
  `execute_blender_code`, `get_objects_summary`, `get_object_detail_summary`, the five `get_blendfile_summary_*`,
  `render_thumbnail_to_path`, `render_viewport_to_path`, `get_python_api_docs`, `search_api_docs`, `search_manual_docs`.
  The screenshot and jump tools need a window; the `*_for_cli` tools start a second Blender per call.
- **Snapshots** leave out `out/`, `.nv/`, `.blend` files, binaries, links, special files and every file over 256 KiB
  instead of failing: renders, exports and scenes are delivered by publishing, and the scene is rebuilt from its script
  (`scene.py`) on the node's next run.

## Container limits (the worker's, AWWO_OPENAI_AGENTS_WORKSPACE_*)

As a workspace (`--network=none`, read-only root, uid 1000, `--cap-drop=ALL`, `no-new-privileges`), with
`BLENDER=on`: `--gpus <GPUS>` and `NVIDIA_DRIVER_CAPABILITIES=compute,utility,graphics` when `GPUS` is set (`all` or
`device=<n>[,<n>…]`), `--cpus` 8 (`CPUS`, 1–32), 8 GiB of memory (`MEMORY_MB`, 2,048–32,768), 1 GiB tmpfs `/workspace`
and `/tmp`, 1,024 processes, 8,192 open files, commands up to 600 s (`COMMAND_TIMEOUT_MS`), each Blender call up to
`BLENDER_CALL_SECONDS` (10–290, default 280). No web: a workstation with `AWWO_WORKSPACE_EGRESS_*` set does not start.
The containers may run on another host's Docker daemon (`DOCKER_CONTEXT`), such as a GPU host's. With `VIEW=on`, a run
on a model that takes images (a Bedrock catalog Claude model) can look at its renders: `workspace_view` shows it a
picture of an image file, made by the image's own Pillow (`apps/openai-agents-worker/workspace-view.ts`).

## Security

The MCP server executes the Python a model writes, inside Blender, without guards (Blender Lab's own warning). That is
why it runs only here: in a per-run container with no network, no credentials, no host mounts and bounded resources,
removed when the run ends. Its HTTP transport (no authentication, CORS `*`) is never used; the worker uses stdio.
