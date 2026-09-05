# PowerShell local gate — the Windows equivalent of scripts/run-ci-tests.sh.
#
# Runs the same checks ci.yml runs, in an order Windows developers can use without
# WSL/Git-Bash: lint -> pytest -> CLI doctor smoke -> API /health smoke -> web build.
# POSIX-only tests (mode bits, symlinks, signals, #!/bin/sh fixtures) auto-skip on
# Windows via tests/conftest.py (pytest_collection_modifyitems) + the curated
# tests/_windows_posix_skips.py set, so a green run means "Windows is healthy", not
# "POSIX assumptions happened to pass". Run pytest BEFORE the web build: the build
# materializes apps/web/dist, whose SPA catch-all route otherwise shadows a couple
# of request-id tests (an OS-independent built-dist artifact, not a Windows issue).
#
# Usage (from the repo root):
#   pwsh -File scripts/run-ci-tests.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/run-ci-tests.ps1

$ErrorActionPreference = "Stop"
$root = (Resolve-Path "$PSScriptRoot/..").Path
Set-Location $root

# Project interpreter only — never a bare system Python (it would lack the editable
# install + pytest-xdist and make the gate lie). Fail closed with guidance.
$py = Join-Path $root ".venv\Scripts\python.exe"
if (-not (Test-Path $py)) {
    Write-Error "no project interpreter at $py. Create it: uv venv; uv pip install -e `".[dev]`""
    exit 2
}

Write-Host "== ruff ==" -ForegroundColor Cyan
& $py -m ruff check packages apps

Write-Host "== pytest (POSIX-only tests deselected on Windows) ==" -ForegroundColor Cyan
& $py -m pytest -q
if ($LASTEXITCODE -ne 0) { Write-Error "pytest failed"; exit $LASTEXITCODE }

Write-Host "== superclaw doctor (import + startup self-check) ==" -ForegroundColor Cyan
& $py -m superclaw.cli doctor

Write-Host "== API /health smoke ==" -ForegroundColor Cyan
$server = Start-Process -FilePath $py -ArgumentList @("-m","uvicorn","apps.api.main:app","--host","127.0.0.1","--port","8765") -PassThru -NoNewWindow
try {
    $ok = $false
    for ($i = 0; $i -lt 30; $i++) {
        try {
            Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:8765/health" -TimeoutSec 2 | Out-Null
            $ok = $true; break
        } catch { Start-Sleep -Seconds 1 }
    }
    if (-not $ok) { Write-Error "API /health did not come up"; exit 1 }
    Write-Host "  /health OK"
} finally {
    if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }
}

Write-Host "== web build ==" -ForegroundColor Cyan
# The web build statically fuses server/ui (the board), so its npm deps must be
# installed first (pnpm workspace). Install is idempotent.
if (Get-Command pnpm -ErrorAction SilentlyContinue) {
    & pnpm -C server install --frozen-lockfile
} else {
    Write-Warning "pnpm not found; the web build may fail to resolve server/ui (board fusion)."
}
& npm ci --prefix apps/web
& npm run build --prefix apps/web

Write-Host "All Windows gate checks passed." -ForegroundColor Green
