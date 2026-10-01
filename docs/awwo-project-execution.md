# Canvas project execution

A canvas node can use a project execution runtime to inspect supplied files, write source, execute commands, repair failures and publish actual file bytes. A persona describes the node's responsibility; it does not replace or restrict those tools. The model catalog distinguishes project execution, text generation and an unavailable project sandbox.

## User flow

1. Select a model labelled **Project execution** and choose a persona.
2. Open the node's deliverables and add a website, game, 3D model, report, Agent project or source project requirement. Existing fields and connections are retained.
3. Fill the task input and execute the node task. The process panel shows recorded operation starts and individual model calls. An operation start is not a successful test or a human acceptance decision.
4. Inspect the deliverable and its actual test evidence. HTML is static initially; explicitly choose **Run interaction** to operate it, and Stop or Reset to control the preview.
5. Connect a file output to another node's file input. Only persisted artifacts from the connected source are materialized in the receiving workspace's read-only inputs directory. A typed path or URL is not an uploaded file.

## Implemented capabilities

| Capability | Behavior |
| --- | --- |
| Project files | List, read and write relative files in a per-run isolated workspace. |
| Commands | Node.js, Python and Git in a bounded Linux container; command exit codes and actual output return to the agent for correction. |
| Model loop | Defaults to 32 model calls; operators may configure 2–64, with a hard cap of 64 per run. Existing runs retain their frozen limit, including 16. Every call is admitted and settled independently; permission, personal connection and quota changes can stop the next call. The overall run deadline still applies. |
| Context | Completed tool interactions may become explicit context checkpoints. Completed model reasoning may be explicitly omitted with its completed tool group or completed text turn; retained tool groups keep their associated provider reasoning. Large reads and command logs become clearly marked previews with instructions for bounded re-reading. Actual files remain in the workspace and the SDK retains the unabridged history during the current run; persisted operation records contain start events only. The original user task is retained. Context that still exceeds the hard budget fails rather than silently truncating the task. |
| Delivery | File fields are populated from broker-verified bytes, not model-supplied paths. A final format correction uses only remaining calls in the same frozen per-run budget. |
| Continuation | A completed, validated run saves a private source ZIP. The next turn in that same session restores it. Failed or cancelled runs do not replace the last successful snapshot. |
| Preview | Static HTML by default; explicit interactive HTML in an opaque-origin sandbox. Raster image previews and file downloads are supported. |
| History | Per-call usage, operation starts, delivery format and artifacts remain distinct evidence. Stored files and their transcript references are published atomically. Historical transport bytes are projected into verified references or explicitly unavailable metadata rather than copied into the next model request. Completion does not mean human acceptance. |

Websites and games use self-contained HTML/CSS/JavaScript. 3D deliverables are actual glTF, GLB or OBJ files, optionally accompanied by a self-contained viewer. Reports use Markdown and an optional genuinely generated PDF. Agent/source projects contain actual source, README, configuration examples without credentials, and runnable checks in a real archive.

## Boundaries

This execution path is not a claim of complete Codex tool parity. The current sandbox has no internet, browser automation, vision input, image-generation service, MCP connection or arbitrary package installation. PDF and general 3D files are downloadable; there is no embedded general-purpose PDF or 3D viewer. Existing node-team orchestration continues to use its existing text runtime. Manual conversation preserves project state; declared structured deliverables are produced through **Execute node task**.

Each file and compressed source snapshot is limited to 2 MiB; connected files total at most 8 MiB. Source ZIP restoration is limited to 32 MiB expanded and 1,024 entries. Dependency caches, `.git`, and read-only inputs are excluded. Commands, process count, CPU, memory and output are bounded. A container cleanup failure removes project availability until the worker is recovered.

For deployment, configure both the API callback and the JavaScript Agents worker's immutable local container image. Availability is advertised only after a real container probe. The ordinary compose deployment does not automatically grant Docker access or enable this capability. See [workspace deployment](../deploy/saas/workspace/README.md) and [backend configuration](../backend/README.md).
