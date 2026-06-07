# Option B — forward production Postgres + Redis to localhost (keep this window open).
$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$HostFile = Join-Path $ScriptDir "kvm.host"

if (-not (Test-Path $HostFile)) {
    Write-Host "Missing $HostFile — copy kvm.host.example to kvm.host and set user@IP." -ForegroundColor Red
    exit 1
}

$SshTarget = (Get-Content $HostFile -Raw).Trim()
if ([string]::IsNullOrWhiteSpace($SshTarget) -or $SshTarget -match "YOUR_KVM") {
    Write-Host "Edit kvm.host with your KVM SSH target (e.g. ubuntu@203.0.113.10)." -ForegroundColor Red
    exit 1
}

Write-Host "Tunnel: localhost:6380 -> KVM Redis, localhost:32459 -> KVM Postgres" -ForegroundColor Cyan
Write-Host "Target: $SshTarget (Ctrl+C to close)" -ForegroundColor Cyan
Write-Host "Do not run pnpm docker:up on this PC while the tunnel is open (port clash)." -ForegroundColor Yellow

ssh -N -o ServerAliveInterval=60 `
    -L 6380:127.0.0.1:6380 `
    -L 32459:127.0.0.1:32459 `
    $SshTarget
