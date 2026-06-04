# Option B — preflight before starting local worker + automation against KVM Redis/Postgres.
$ErrorActionPreference = "Continue"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Resolve-Path (Join-Path $ScriptDir "..")

function Test-EnvFile {
    param([string]$Path, [string[]]$Required)
    if (-not (Test-Path $Path)) {
        Write-Host "MISSING: $Path" -ForegroundColor Red
        return $false
    }
    $text = Get-Content $Path -Raw
    $ok = $true
    foreach ($key in $Required) {
        if ($text -notmatch "(?m)^$key=.+") {
            Write-Host "MISSING in ${Path}: $key" -ForegroundColor Red
            $ok = $false
        }
    }
    return $ok
}

$allOk = $true

Write-Host "`n=== Option B preflight ===" -ForegroundColor Cyan

foreach ($port in @(6380, 54322)) {
    $t = Test-NetConnection -ComputerName localhost -Port $port -WarningAction SilentlyContinue
    if ($t.TcpTestSucceeded) {
        Write-Host "OK  localhost:$port (tunnel or local Redis/Postgres)" -ForegroundColor Green
    } else {
        Write-Host "FAIL localhost:$port — start scripts/ssh-tunnel-kvm.ps1 first" -ForegroundColor Red
        $allOk = $false
    }
}

$t4101 = Test-NetConnection -ComputerName localhost -Port 4101 -WarningAction SilentlyContinue
if ($t4101.TcpTestSucceeded) {
    Write-Host "WARN localhost:4101 already in use (stop old automation-service?)" -ForegroundColor Yellow
} else {
    Write-Host "OK  localhost:4101 free for automation-service" -ForegroundColor Green
}

$workerEnv = Join-Path $RepoRoot "apps\worker\.env"
$autoEnv = Join-Path $RepoRoot "apps\automation-service\.env"
$required = @("CREDENTIALS_MASTER_KEY", "AUTOMATION_INTERNAL_SECRET", "DATABASE_URL", "REDIS_URL")

if (-not (Test-EnvFile $workerEnv $required)) { $allOk = $false }
if (-not (Test-EnvFile $autoEnv @("AUTOMATION_INTERNAL_SECRET", "DATABASE_URL", "REDIS_URL", "GDMS_BASE_URL"))) { $allOk = $false }

if (Test-Path $workerEnv) {
    $w = Get-Content $workerEnv -Raw
    if ($w -match "AUTOMATION_SERVICE_URL=(?!http://127\.0\.0\.1:4101|http://localhost:4101)") {
        Write-Host "WARN worker .env AUTOMATION_SERVICE_URL should be http://127.0.0.1:4101 for Option B" -ForegroundColor Yellow
    }
}

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    Write-Host "FAIL pnpm not in PATH" -ForegroundColor Red
    $allOk = $false
}

if ($allOk) {
    Write-Host "`nReady for scripts/option-b-start.ps1" -ForegroundColor Green
    exit 0
}

Write-Host "`nFix issues above, then re-run option-b-check.ps1" -ForegroundColor Red
exit 1
