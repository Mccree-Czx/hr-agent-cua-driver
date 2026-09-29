# Install & self-check cua-driver (full-replacement W6: replaces the CDP/browser
# channel dependency previously provided by liepin-cli).
#
# Usage:  powershell -ExecutionPolicy Bypass -File install-cua-driver.ps1 [-SkipInstall]
# Notes:
#  - The official installer is fetched from https://cua.ai/driver/install.ps1
#    (single-process Bypass avoids machine execution-policy issues).
#  - After install, keep the daemon running with existing-profile grant so the
#    driver can attach to the already-logged-in account Chrome.
param([switch]$SkipInstall)
$ErrorActionPreference = 'Stop'

$BinDir = Join-Path $env:LOCALAPPDATA 'Programs\Cua\cua-driver\bin'
$Exe = Join-Path $BinDir 'cua-driver.exe'

if (-not $SkipInstall) {
    Write-Host '[1/4] installing cua-driver (official installer)'
    $script = Invoke-RestMethod https://cua.ai/driver/install.ps1
    Invoke-Expression $script
} else {
    Write-Host '[1/4] install skipped (-SkipInstall)'
}

if (-not (Test-Path $Exe)) {
    Write-Error "cua-driver.exe not found at $Exe - install failed"
    exit 1
}
Write-Host "      binary: $Exe"

Write-Host '[2/4] disabling telemetry'
& $Exe telemetry disable | Out-Null

Write-Host '[3/4] doctor self-check'
& $Exe doctor
if ($LASTEXITCODE -ne 0) {
    Write-Error 'doctor self-check failed'
    exit 1
}

Write-Host '[4/4] daemon hint (keep it running, existing-profile grant required):'
Write-Host "      `"$Exe`" serve --grant existing-profile"
Write-Host '[OK] cua-driver ready. Driver module: tools/cua-liepin-driver (npm run build).'
Write-Host '     Env for the backend/CLI:'
Write-Host "       CUA_DRIVER_BIN=$Exe"
Write-Host '       LIEPIN_USER_DATA_DIR=<account Chrome profile dir>'
