# Opens the native Windows desktop app (debug build) against the local stack.
#
#   powershell -ExecutionPolicy Bypass -File tools\dev\window.ps1 [name] [-TargetDir <folder>]
#              [-ProfilesDir <folder>] [-WslRepo <path>] [-RunEnv <file>] [-Distro <name>] [-Bin <exe>]
#              [-Docker] [-ContractsFile <file>]
#
# By default the devnet, payer, mail server and proof server run in WSL (tools/dev/up.sh). Their ports
# answer on 127.0.0.1 from Windows with networkingMode=mirrored in .wslconfig. With -Docker they run in
# Docker (infra/backend, started by demo.ps1, which copies contracts.json and run.env into
# .data\dev\docker) and WSL is not used. Build first with build.ps1.
# Without a name the app uses one folder, .data\dev\perfiles in this checkout, which holds all your profiles
# (the app adds and switches between them). A name uses its own folder, .data\dev\profiles\<name>, meant
# for tests with two windows at once. Never open two windows on the same folder at once.
param(
    [string]$Perfil = '',
    [string]$TargetDir = $(if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { '' }),
    [string]$ProfilesDir = '',
    [string]$WslRepo = '',
    [string]$RunEnv = '',
    [string]$Distro = '',
    [string]$Bin = '',
    [switch]$Docker,
    [string]$ContractsFile = ''
)

$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (-not $TargetDir) { $TargetDir = Join-Path $Repo 'apps\desktop\src-tauri\target' }
if (-not $Bin) { $Bin = Join-Path $TargetDir 'debug\nightmail-desktop.exe' }
if (-not $ProfilesDir) { $ProfilesDir = Join-Path $Repo '.data\dev\profiles' }
# Without -Distro, the WSL default distribution.
$distroArgs = if ($Distro) { @('-d', $Distro) } else { @() }
$DockerState = Join-Path $Repo '.data\dev\docker'
if (-not $Docker -and -not $WslRepo) {
    $info = (& wsl.exe @distroArgs -e sh -c 'echo $WSL_DISTRO_NAME:$HOME' | Out-String).Trim()
    if ($info -notmatch '^([^:]+):(/.*)$') {
        Write-Host 'ERROR: could not reach the WSL distribution (pass -Distro <name> or -WslRepo <path>).'
        exit 1
    }
    $unc = if (Test-Path "\\wsl.localhost\$($Matches[1])\") { "\\wsl.localhost\$($Matches[1])" } else { "\\wsl$\$($Matches[1])" }
    $WslRepo = $unc + ("$($Matches[2])/nightmail" -replace '/', '\')
}
if (-not $RunEnv) { $RunEnv = if ($Docker) { Join-Path $DockerState 'run.env' } else { Join-Path $WslRepo '.data\dev\run.env' } }
if (-not $ContractsFile) {
    $ContractsFile = if ($Docker) { Join-Path $DockerState 'contracts.json' } else { Join-Path $WslRepo '.data\operator\undeployed\contracts.json' }
}
$StartHint = if ($Docker) { 'Start it with: npm run demo:windows' } else { 'Start the stack in WSL with tools/dev/up.sh.' }

$State = Join-Path $Repo '.data\dev'
$ProfileDir = if ($Perfil) { Join-Path $ProfilesDir $Perfil } else { Join-Path $State 'perfiles' }
$LogSuffix = if ($Perfil) { "-$Perfil" } else { '' }
if (-not $Perfil -and $ProfilesDir -ne (Join-Path $Repo '.data\dev\profiles')) {
    Write-Host 'WARNING: -ProfilesDir only applies to named folders. The default folder .data\dev\perfiles is used.'
}

if (-not (Test-Path $Bin)) {
    Write-Host "ERROR: $Bin does not exist. Build first with tools\dev\build.ps1."
    exit 1
}
if (-not (Test-Path $ProfileDir)) {
    Write-Host "WARNING: the profile folder $ProfileDir does not exist yet. The app will create it empty."
}

# Never two windows on the same folder: an open window holds an OS lock on instance.lock in the profile
# (first profile) or in accounts\<id> (the other profiles). If one is held, leave that window as it is.
$locks = @(Join-Path $ProfileDir 'instance.lock') + @(Get-ChildItem (Join-Path $ProfileDir 'accounts') -Directory -ErrorAction SilentlyContinue | ForEach-Object { Join-Path $_.FullName 'instance.lock' })
foreach ($l in $locks | Where-Object { Test-Path $_ }) {
    try {
        $fs = [System.IO.File]::Open($l, 'Open', 'Read', [System.IO.FileShare]'ReadWrite, Delete')
        try { $fs.Lock(0, 1); $fs.Unlock(0, 1) } finally { $fs.Close() }
    } catch {
        Write-Host "The window on the profile folder $ProfileDir is already open."
        exit 0
    }
}

# Never run two instances at once: bail out if the WSL window is open.
if (-not $Docker) {
    $wslWin = wsl.exe @distroArgs -- pgrep -f 'target/debug/nightmail-desktop'
    if ($wslWin) {
        Write-Host "ERROR: the WSL window (nightmail-desktop) is open (pid $wslWin). Close it first."
        exit 1
    }
}

# Receipt key fingerprint (tools/dev/up.sh in WSL, or demo.ps1 from the Docker backend). Not printed.
$keyLine = Get-Content $RunEnv -ErrorAction SilentlyContinue | Where-Object { $_ -like 'NIGHTMAIL_ISSUER_RECEIPT_KEY=*' } | Select-Object -First 1
if (-not $keyLine) {
    Write-Host "ERROR: could not read the receipt key fingerprint from $RunEnv. $StartHint"
    exit 1
}
$env:NIGHTMAIL_ISSUER_RECEIPT_KEY = $keyLine.Substring('NIGHTMAIL_ISSUER_RECEIPT_KEY='.Length).Trim()
$env:NIGHTMAIL_NETWORK = 'undeployed'
$env:NIGHTMAIL_PROFILE_DIR = $ProfileDir
# Devnet contracts: read straight from the WSL checkout, or the copy demo.ps1 took from the Docker backend.
$env:NIGHTMAIL_CONTRACTS_FILE = $ContractsFile
$env:NIGHTMAIL_SIDECAR_DIR = Join-Path $Repo 'apps\midnight-sidecar'
if (-not (Test-Path $env:NIGHTMAIL_CONTRACTS_FILE)) {
    Write-Host "ERROR: $($env:NIGHTMAIL_CONTRACTS_FILE) not found (devnet contracts). $StartHint"
    exit 1
}
$node = Get-Command node.exe -ErrorAction SilentlyContinue
if ($null -eq $node) {
    Write-Host 'ERROR: node.exe not found in PATH (Node 24 is required).'
    exit 1
}
$env:NIGHTMAIL_NODE = $node.Source

# Backend services as seen from Windows. Without the payer and server the app opens but cannot create addresses or request plans.
# String keys on purpose: with numeric keys, $puertos[$p] would index by position instead of by port.
$puertos = [ordered]@{ '9944' = 'devnet node'; '8088' = 'indexer'; '6300' = 'proof server'; '8787' = 'mail API'; '8788' = 'issuer'; '8789' = 'relayer' }
$falta = @()
foreach ($p in $puertos.Keys) {
    $c = New-Object System.Net.Sockets.TcpClient
    try {
        $iar = $c.BeginConnect('127.0.0.1', [int]$p, $null, $null)
        if (-not ($iar.AsyncWaitHandle.WaitOne(1500) -and $c.Connected)) { $falta += "$($puertos[$p]) ($p)" }
    } catch {
        $falta += "$($puertos[$p]) ($p)"
    } finally {
        $c.Close()
    }
}
if ($Docker) {
    $payer = (& docker.exe inspect --format '{{.State.Health.Status}}' nightmail-backend-payer 2>$null | Out-String).Trim() -eq 'healthy'
} else {
    $payer = wsl.exe @distroArgs -- pgrep -f '^node .*src/bin/operator-wallet[.]ts'
}
if (-not $payer) { $falta += 'the payer' }
if ($falta.Count -gt 0) {
    Write-Host ('WARNING: not responding: ' + ($falta -join ', ') + ". $StartHint")
}

New-Item -ItemType Directory -Force $State | Out-Null
$log = Join-Path $State "window$LogSuffix.log"
$err = Join-Path $State "window$LogSuffix.err.log"
$proc = Start-Process -FilePath $Bin -WorkingDirectory (Join-Path $Repo 'apps\desktop') -RedirectStandardOutput $log -RedirectStandardError $err -WindowStyle Hidden -PassThru
Write-Host "Window open (pid $($proc.Id)), profile $ProfileDir"
Write-Host "Logs: $log and $err"
