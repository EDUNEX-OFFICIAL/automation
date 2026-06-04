# Option B — run worker + automation on this PC (headed Chromium on your desktop).
$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Resolve-Path (Join-Path $ScriptDir "..")

& (Join-Path $ScriptDir "option-b-check.ps1")
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Set-Location $RepoRoot

Write-Host "`nStarting @gdms/worker and @gdms/automation-service (two windows)..." -ForegroundColor Cyan
Write-Host "First time only: pnpm --filter @gdms/automation-service run pw:install`n" -ForegroundColor Yellow

Start-Process powershell -ArgumentList @(
    "-NoExit",
    "-Command",
    "Set-Location '$RepoRoot'; pnpm --filter @gdms/worker dev"
)

Start-Sleep -Seconds 2

Start-Process powershell -ArgumentList @(
    "-NoExit",
    "-Command",
    "Set-Location '$RepoRoot'; pnpm --filter @gdms/automation-service dev"
)

Write-Host "Opened two PowerShell windows. Keep tunnel (ssh-tunnel-kvm.ps1) open." -ForegroundColor Green
Write-Host "Then use https://bot.edunexservices.in -> Dashboard -> START -> Live session." -ForegroundColor Green
