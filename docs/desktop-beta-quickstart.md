# Desktop Beta Quickstart

This is the current fresh-machine install path for the local SuperClaw desktop beta prototype.

## Prerequisites

- Python 3.11+ available as `python3`
- Node.js + npm available on `PATH`
- Rust/Cargo available on `PATH` for the Tauri shell
- Optional local agent CLIs as needed:
  - `codex`
  - `hermes`
  - `claude`
  - `openclaw`

## Bootstrap

macOS/Linux:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install -e ".[dev,tui]"
npm install --prefix apps/web
npm install --prefix apps/desktop
```

Windows PowerShell:

```powershell
py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -e ".[dev,tui]"
npm install --prefix apps/web
npm install --prefix apps/desktop
```

## Verify local runtime

macOS/Linux:

```bash
.venv/bin/superclaw doctor
.venv/bin/superclaw service --host 127.0.0.1 --port 8788
```

Windows PowerShell:

```powershell
.\.venv\Scripts\superclaw.exe doctor
.\.venv\Scripts\superclaw.exe service --host 127.0.0.1 --port 8788
```

In another terminal:

```bash
curl -H "X-SuperClaw-Token: <token-if-required>" http://127.0.0.1:8788/health
```

## Run the web workbench

```bash
npm run dev --prefix apps/web -- --host 127.0.0.1 --port 5174
```

Use the `Desktop onboarding` and `Runtime dependency doctor` cards to confirm:

- runtime service is reachable
- `Desktop source toolchain` is green when you plan to build the Tauri shell from this source workspace
- missing Codex/Hermes/Claude Code/OpenClaw executables have a remediation hint
- ClawHunt account login is completed through the ClawHunt website/Google flow and a SuperClaw agent key is created when task-market flows are needed
- plugin trust root is configured before registry installs

CLI and desktop use the same ClawHunt account backend and shared local auth file at `~/.superclaw/clawhunt-auth.json` by default.
Set `SUPERCLAW_CLAWHUNT_AUTH_PATH` to override that file and `CLAWHUNT_BASE_URL` to point both surfaces at a non-production ClawHunt backend.
The desktop flow opens the ClawHunt-hosted Google bridge with `source=superclaw`, receives the callback locally, and saves the returned ClawHunt account token into the shared auth file.
The matching CLI flow uses the ClawHunt backend handoff exchange and writes the same auth file:

```bash
superclaw clawhunt login-probe
superclaw clawhunt login-url --provider google --callback-url http://127.0.0.1:<port>/api/auth/clawhunt/browser/callback
superclaw clawhunt exchange-handoff-code --handoff-code <clawhunt-handoff-code>
superclaw clawhunt account-agents
superclaw clawhunt create-agent-key --agent-id <id> --name "SuperClaw Desktop"
superclaw clawhunt auth-status
```

## Run the Tauri shell

```bash
npm run tauri:dev --prefix apps/desktop
```

The Tauri shell should:

- start or attach to the local `superclaw` runtime
- show runtime health and agent readiness
- allow direct chat from the shared workbench
- allow a delivery dry-run and evidence inspection

## Source-build launch smoke

After a successful source build, run the desktop launch smoke to prove the packaged `.app` boots and exits cleanly:

```bash
npm run test:launch-smoke --prefix apps/desktop
```

To prove the packaged desktop shell can also supervise a local SuperClaw runtime sidecar end-to-end, run:

```bash
npm run test:runtime-smoke --prefix apps/desktop
```

To prove the packaged desktop shell can start the local runtime, run a direct Codex chat, execute a delivery dry-run, fetch evidence, and shut the sidecar down cleanly, run:

```bash
npm run test:workbench-smoke --prefix apps/desktop
```

To prove a copied manual-install app bundle also works outside the source build directory, run:

```bash
npm run test:installed-bundle-smoke --prefix apps/desktop
```

To run the full desktop beta acceptance chain in one command and emit a JSON report, run:

```bash
npm run test:beta-acceptance --prefix apps/desktop
```

By default the report is written to `.superclaw/desktop/desktop-beta-acceptance.json`. Optionally set
`SUPERCLAW_DESKTOP_ACCEPTANCE_REPORT=/absolute/path/report.json` to choose a different path.

Use the `Desktop beta acceptance` card in the shared workbench to confirm the latest report status, inspect the step list,
and download the current acceptance JSON without rerunning the suite.

## Update policy

- Auto-updater is disabled for the beta.
- Use the documented manual update path in `docs/desktop-manual-update.md`.

## Common remediation

- Missing `codex`: install Codex CLI or set `SUPERCLAW_CODEX_EXECUTABLE`
- Missing `hermes`: install Hermes CLI or set `SUPERCLAW_HERMES_EXECUTABLE`
- Missing `claude`: install Claude Code or set `SUPERCLAW_CLAUDE_EXECUTABLE`
- Missing `openclaw`: install OpenClaw or set `SUPERCLAW_OPENCLAW_EXECUTABLE`
- Missing ClawHunt auth: use the ClawHunt Google/website login button in the control surface, exchange a ClawHunt handoff code in the CLI, create a SuperClaw agent key for one of your ClawHunt agents, or paste an existing `cph_...` key as a fallback
