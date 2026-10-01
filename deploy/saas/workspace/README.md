# Coding workspace sandbox

`apps/openai-agents-worker/workspace-sandbox.ts` is a trusted broker. Only the fixed Docker CLI runs on the host; generated code and shell commands execute inside the operator-built image. Build the Dockerfile from this directory and configure the worker with its immutable image digest. Runtime startup does not pull images. The image provides Node 22, Python 3 and Git; it does not contain provider credentials or a browser. It supports self-contained web/game projects, Python or JavaScript tools, JSON/glTF/OBJ assets and text reports. Network-dependent package installs, authenticated external tools and browser verification require a separate governed capability; they are not silently enabled here.

Every run gets a non-root container with no network, capabilities, host mounts or Docker socket, a read-only root filesystem, 1 CPU, 1 GiB memory, 128 PIDs, a 128 MiB workspace tmpfs and a 32 MiB temporary tmpfs. Inputs live in a separate root-owned mount and are read-only to generated programs. Container environment does not include worker/provider secrets. The host Docker service and the broker account must be restricted to trusted operators; Docker daemon access itself is privileged.

The workspace persists across tool calls. At completion the broker produces a verified ZIP snapshot for the server to store with the tenant/session; a later run may restore only that server-authorized snapshot. Restoration rejects traversal, symlinks, special files, duplicates, encryption, excessive entry counts and size expansion. Snapshots contain regular source files, omit dependency/cache directories (`node_modules`, `.git`, `.venv`, `__pycache__`, `.pytest_cache`, `.mypy_cache`), and are limited to 2 MiB compressed, 32 MiB uncompressed and 1,024 entries. Individual published files are limited to 2 MiB. This is explicit bounded workspace continuity, not an unbounded writable host volume.

Cancellation, command timeout, helper transport failure and completion cleanup remove the whole container. Normal command exit also kills lingering untrusted child processes. A non-zero shell exit returns its exit code and captured stdout/stderr for the agent to repair and retest. Captured terminal output is bounded to 64 KiB per command. Calls on one workspace are serialized. No host shell ever interpolates a model command or file path.

The worker must call `close()` from its `finally` path. Treat a failed cleanup as a worker error and quarantine that worker from new runs until the operator resolves the Docker daemon failure. The labelled containers (`awwo.workspace-sandbox=true`) allow an operator to audit remnants after a worker or host crash; do not indiscriminately delete active containers. The daemon may be stopped or the image absent, in which case sandbox startup fails rather than falling back to host execution.

Run the broker tests with the repository-supported Node runtime:

```sh
node --test apps/openai-agents-worker/workspace-sandbox.test.ts
```

The fixed Python filesystem helper has local temporary-directory security tests. Optional real Docker smoke tests require `AWWO_TEST_WORKSPACE_IMAGE` and an absolute `AWWO_TEST_DOCKER_EXECUTABLE`; they run only the supplied trusted image and never modify daemon settings.
