# AI CanvasPro Studio Integration

MyShell Studio embeds AI CanvasPro inside the `/dreamy` shell through
`frontend/src/features/studio/pages/CanvasPro.tsx` and the Dreamy workspace switch. CanvasPro
view-models, bridge message types, quick-create commands, generation task formatting, and menu
helpers live in `frontend/src/features/studio/model/canvasProWorkspace.ts`. Studio-owned Canvas
orchestration UI lives in `frontend/src/features/studio/components/canvasWorkspace.tsx`, with
drawer/modal panels in `frontend/src/features/studio/components/canvasSidePanels.tsx`. The third-party
CanvasPro source is intentionally kept outside git; `scripts/prepare-canvaspro-static.sh` creates
the ignored local mount at `frontend/public/ai-canvaspro/` from an external checkout or writes a
local placeholder when CanvasPro is not installed.

## Runtime Shape

CanvasPro still owns the canvas runtime. Studio adds a thin bridge layer:

- `CanvasPro.tsx` loads `/ai-canvaspro/index.html` in an iframe inside `/dreamy?workspace=canvaspro`.
- On iframe load, Studio injects the tracked bridge at `frontend/public/studio/canvaspro/studio-bridge.js`.
- The generated local mount exposes that bridge as `/ai-canvaspro/studio-bridge.js`.
- `studio-bridge.js` reads CanvasPro state through `window.CanvasTabManager` and `graphStore` when the real CanvasPro app is present.
- The React page talks to the bridge with same-origin `window.postMessage`.
- The bridge does not modify renderer, interaction, minimap, node, or edge internals.
- Embedded API calls go to `/ai-canvaspro-api/*`, which is proxied through the Studio backend.

## Studio UI Policy

Studio keeps the upstream CanvasPro files external and applies product-facing UI policy in
`studio-bridge.js` at runtime:

- Upstream tutorial, GitHub, feedback, and personal homepage links are hidden or neutralized inside
  the embedded CanvasPro menu.
- The CanvasPro `About` entry is relabeled as `第三方组件 / 授权声明`.
- The About dialog keeps a third-party component disclosure and license boundary instead of sending
  users to upstream support or author channels.
- This is not a white-label authorization. It only prevents user navigation out of Studio while
  preserving the requirement to review and obtain upstream commercial or white-label rights before
  commercial deployment.

## Backend Compatibility

The original AI CanvasPro Python service is optional in Studio development:

- `npm run dev` uses the Studio backend as the default CanvasPro API proxy target.
- If `AI_CANVASPRO_SERVER_DIR=/path/to/AI-CanvasPro` points to a folder containing `server.py`,
  `scripts/dev.sh` attempts to start that native service in the same dev session.
- If the native service is unavailable, the Studio backend serves compatibility responses for
  runtime info, redacted API config, user settings, prompt presets, projects, and file-migration
  fallback.
- Compatibility data is stored under `orchestrator/backend/.studio/canvaspro/` unless
  `AI_CANVASPRO_COMPAT_DIR` is set.
- Known missing endpoints can fall back on `404`; native `502/503/504` responses are preserved by
  default and only fall back when `AI_CANVASPRO_COMPAT_ON_UPSTREAM_STATUS=1` is explicitly set.
- API config compatibility never persists keys whose names look like API keys, access tokens,
  refresh tokens, authorization headers, or secrets. Store provider credentials in the native
  CanvasPro backend or another reviewed secret manager.

Generation, media processing, Dreamina login, and provider-specific tasks still require the native
CanvasPro backend or a future Studio-native implementation of those endpoints.

## SuperClaw Orchestration

Studio can hand CanvasPro context to a separately running SuperClaw service through the Studio
backend. The checked-out `SuperClaw/` directory is reference-only; do not patch it for this
integration.

For local development, put SuperClaw connection settings in the repository root `.env.local`, which
is loaded by `npm run dev` and `bash scripts/dev.sh`:

```bash
STUDIO_SUPERCLAW_API_BASE=http://127.0.0.1:8788
STUDIO_SUPERCLAW_GATEWAY_BASE=http://127.0.0.1:8796
STUDIO_SUPERCLAW_CONTROL_TOKEN=
STUDIO_SUPERCLAW_GATEWAY_TOKEN=
```

The tokens are backend-only settings. Do not prefix them with `VITE_`, because they must not be
embedded into frontend bundles. For deployed environments, set the same variables on the backend
runtime or through the deployment secret manager.

## External Source Setup

```bash
AI_CANVASPRO_REF=<commit-or-tag> AI_CANVASPRO_REPO_URL=<source-repo-url> bash scripts/setup-canvaspro.sh
npm run dev
```

`setup-canvaspro.sh` clones or reuses `.external/AI-CanvasPro`, optionally checks out
`AI_CANVASPRO_REF`, installs CanvasPro Python dependencies only when `server.py` is present, and
prepares the ignored static mount from a directory containing `index.html`. Studio's own backend can
continue to use the repository root `.venv`; the two Python environments should stay separate.

The public AI-CanvasPro repository may contain release metadata/docs rather than the runnable app.
When that happens, provide either `AI_CANVASPRO_STATIC_DIR=/path/to/static-app` for a reviewed
static build, `AI_CANVASPRO_SERVER_DIR=/path/to/source-checkout` for a local source checkout, or
`AI_CANVASPRO_REPO_URL=<source-repo-url>` for an authorized source repository.

## Bridge Messages

Studio sends:

```ts
{
  type: 'aicanvas-studio:request',
  id: string,
  action:
    | 'getStatus'
    | 'saveSnapshot'
    | 'exportPackage'
    | 'importPackage'
    | 'getSelectedContext'
    | 'openShortcuts',
  payload?: Record<string, unknown>
}
```

CanvasPro responds:

```ts
{
  type: 'aicanvas-studio:response',
  id: string,
  ok: boolean,
  payload?: unknown,
  error?: string
}
```

CanvasPro also emits:

- `aicanvas-studio:ready`
- `aicanvas-studio:autosave`

## Offline Snapshot

The bridge stores browser-side recovery snapshots in IndexedDB:

- database: `myshell-studio-ai-canvaspro`
- store: `projects`
- key: `window.currentProjectId || "default_v2_project"`

Autosave is debounced and triggered by graph changes, dirty-state events, boot, and `pagehide`.
This is a Studio fallback only. The original CanvasPro server save flow is preserved.

## Project Package

Studio package export creates an uncompressed ZIP with:

- `manifest.json`: package metadata, project name, bridge version, node/edge counts
- `projects.json`: CanvasPro multi-canvas data
- `assets-manifest.json`: asset JSON paths, collected files, skipped local-only references
- `assets/*`: fetchable `data:`, `blob:`, same-origin, or CORS-accessible remote assets
- `README.txt`: package note

Absolute local filesystem paths are not read by the browser. They remain listed in
`assets-manifest.json` as skipped references so the project JSON stays honest.

## Import

The bridge imports:

- `.canvaspro.zip` / `.zip`: reads `projects.json`
- `.json`: imports CanvasPro-compatible project data

When `window.CanvasTabManager.init()` is available, import reinitializes the multi-canvas
workspace. If not, the bridge falls back to `graphStore.hydrateTrustedSnapshot()` or
`graphStore.loadState()` for the active canvas.

## Selected Context

`getSelectedContext` returns the selected nodes from the active canvas plus internal edges between
those selected nodes. The Studio shell currently copies this JSON to the clipboard; the same action
can later be wired to an orchestrator/chat endpoint without changing CanvasPro internals.

## License Boundary

This repository does not commit AI-CanvasPro third-party source or assets. It only contains
Studio-owned bridge, compatibility, startup, and documentation files. The local upstream
AI-CanvasPro license files describe it as Source Available/non-OSI and require separate written
authorization for commercial use, SaaS/cloud service use, paid delivery, or packaged redistribution.
Confirm those upstream terms and any bundled asset/model-provider terms before commercial
deployment.

`basketikun/infinite-canvas` was used as a product and architecture reference only. Do not copy code
from that AGPL-3.0 project into this Studio integration unless the resulting license obligations are
reviewed.
