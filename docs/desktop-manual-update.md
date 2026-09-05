# Desktop Manual Update Path

This is the current manual update path for the SuperClaw desktop beta.

Auto-updater is intentionally disabled at this stage. Update the beta manually before broad distribution.

## Before you update

- Export an incident bundle from the desktop workbench if you need the current logs, evidence, or protocol export.
- Let any active run finish, or cancel it explicitly before replacing the desktop shell.
- Confirm you still have access to the local agent CLIs you rely on: `codex`, `hermes`, `claude`, `openclaw`.

## Path A: Source workspace / local development build

Use this path when your desktop shell runs from a local clone of the repository.

macOS/Linux:

```bash
git pull --ff-only
.venv/bin/python -m pip install -e ".[dev,tui]"
npm install --prefix apps/web
npm install --prefix apps/desktop
npm run build --prefix apps/web
npm run tauri:build --prefix apps/desktop
```

Windows PowerShell:

```powershell
git pull --ff-only
.\.venv\Scripts\python.exe -m pip install -e ".[dev,tui]"
npm install --prefix apps/web
npm install --prefix apps/desktop
npm run build --prefix apps/web
npm run tauri:build --prefix apps/desktop
```

After the build finishes:

1. Relaunch the Tauri shell.
2. Reconnect the local runtime if needed.
3. Re-run the `Desktop onboarding` and `Runtime dependency doctor` checks.
4. Run a direct chat or delivery dry-run to confirm the updated shell still reaches the runtime.

## Path B: Packaged beta app

Use this path when you received a built SuperClaw beta application bundle.

1. Quit SuperClaw.
2. Download the newer beta build from the same trusted distribution channel.
3. Replace the existing app bundle with the new one.
4. Reopen SuperClaw and reconnect the runtime.
5. Re-run the `Desktop onboarding` and `Runtime dependency doctor` checks.
6. If you are validating the packaged install path from source before shipping the next beta, run `npm run test:installed-bundle-smoke --prefix apps/desktop`.

## Rollback

- Source workspace: check out the last known-good commit, then rebuild the web and Tauri bundles.
- Packaged beta app: reinstall the previous signed beta bundle if you kept a copy.

## Verification after update

- `Desktop shell` card reports the expected app version and runtime connection.
- `Runtime dependency doctor` is green for the agents you rely on.
- `ClawHunt task browser` still loads tasks when auth is configured.
- `Evidence` and `Protocol export` still render for a fresh dry-run.
