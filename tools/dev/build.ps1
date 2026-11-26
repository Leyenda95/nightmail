# Builds the desktop app on Windows: debug build with the app's security policy, no installer.
#
#   powershell -ExecutionPolicy Bypass -File tools\dev\build.ps1 [-TargetDir <folder>] [-Jobs <n>]
#
# Requires Rust (MSVC) 1.90 or later, Node 24, Visual Studio Build Tools, WebView2, Strawberry Perl
# (the OpenSSL build for the encrypted database needs it), npm ci in this checkout, and
# vendor\base-styles (from tools/vendor-base-styles.sh, or copied from a Linux/WSL checkout).
# Always build with the app window closed: a running executable cannot be overwritten.
param(
    [string]$TargetDir = $(if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { '' }),
    [int]$Jobs = 6,
    [string]$PerlBin = 'C:\Strawberry\perl\bin'
)

$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (-not $TargetDir) { $TargetDir = Join-Path $Repo 'apps\desktop\src-tauri\target' }
if (-not (Test-Path (Join-Path $Repo 'vendor\base-styles'))) {
    Write-Host 'ERROR: vendor\base-styles is missing. Download it with tools/vendor-base-styles.sh or copy it from the Linux or WSL copy.'
    exit 1
}
if (Test-Path $PerlBin) { $env:PATH = "$PerlBin;$env:PATH" }
$env:CARGO_TARGET_DIR = $TargetDir
$env:CARGO_BUILD_JOBS = "$Jobs"

$State = Join-Path $Repo '.data\dev'
New-Item -ItemType Directory -Force $State | Out-Null
$log = Join-Path $State 'build.log'
Set-Location (Join-Path $Repo 'apps\desktop')
$t = Get-Date
cmd /c "npx tauri build --debug --no-bundle > `"$log`" 2>&1"
$code = $LASTEXITCODE
Write-Host "Exit $code in $([int]((Get-Date) - $t).TotalSeconds) s. Executable: $(Join-Path $TargetDir 'debug\nightmail-desktop.exe')"
Write-Host "Full log: $log"
Get-Content $log -Tail 5
exit $code
